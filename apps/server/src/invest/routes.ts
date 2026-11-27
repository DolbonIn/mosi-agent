/**
 * /api/invest/* (protocol ROUTES.invest*; agent-runtime 2052 §D, DD 2100 error copy). The person's own changes only:
 * the watch never writes a rule's price, direction or action (G8), and neither does anything here except the person's
 * request. Resistance and invalidation rules come from strategy proposals (B2), so POST refuses them.
 */
import type { InvestNum, InvestRuleChanges, InvestRuleDraft, InvestRulePreview, InvestSettingsPatch } from "@pickle/protocol";
import { shares } from "@pickle/quant";
import type { Core } from "../core.ts";
import { bad, HttpError, json, notFound, readJson, type Ctx } from "../http.ts";
import { newId } from "../util.ts";
import { marketDate, marketOf, normalizeSymbol } from "./calendar.ts";
import * as idb from "./db.ts";
import { reportView } from "./report.ts";
import { stagesDetail } from "./stages.ts";
import { createEvent, deleteEvent, listEvents, setEventRemind } from "./events.ts";
import { createForecast, ERROR_CAUSES, ERROR_CAUSE_WORD, forecastRows, forecastScore, judgeForecast, listForecasts, OUTCOMES, OUTCOME_WORD } from "./forecasts.ts";
import { LEDGER_ID_RE, readLedger, writeLedger } from "./ledger.ts";
import {
  bufferFoot,
  bufferPct,
  bufferPrice,
  BUFFER_MAX,
  BUFFER_MIN,
  callNote,
  changeSentence,
  MAX_PRICE,
  moneyNum,
  resultSentence,
  SEEN_EDITED,
  SEEN_RESUMED,
  stopWarning,
  type RuleSpec,
} from "./rules.ts";

export const MAX_WATCH = 30;
export const MAX_RULES = 60;
export const PREVIEW_TTL_MS = 10 * 60_000;
const UNTIL_MAX_DAYS = 366;

export const INVEST_ERRORS = {
  unknown_symbol: "찾을 수 없는 종목이에요. 기호를 다시 확인해 주세요.",
  kind_not_allowed: "저항과 무효화 규칙은 전략 제안으로만 만들 수 있어요.",
  sell_not_allowed: "매도는 손절 규칙에만 걸 수 있어요.",
  not_held: "보유한 종목에만 매도를 걸 수 있어요.",
  not_watched: "감시 종목에 먼저 추가해 주세요.",
  rule_not_found: "이미 지워진 규칙이에요.",
  rule_changed: "그사이 규칙이 바뀌었어요. 바뀐 내용을 확인하고 다시 저장해 주세요.",
  preview_stale: "확인한 뒤에 수량이나 규칙이 바뀌었어요. 바뀐 내용을 다시 확인해 주세요.",
  toss_check_too_soon: "조금 뒤에 다시 확인해 주세요.",
  too_many_watch: `감시 종목은 ${MAX_WATCH}개까지 둘 수 있어요.`,
  too_many_rules: `규칙은 ${MAX_RULES}개까지 둘 수 있어요.`,
  report_not_found: "볼 수 없는 보고서예요.",
} as const;

/** ?limit=N, a whole number; anything else is the route's default */
function limitOf(c: Ctx): number | undefined {
  const v = c.url.searchParams.get("limit");
  return v !== null && /^\d{1,4}$/.test(v) ? Number(v) : undefined;
}

const hasRules = (n: number) => `이 종목에 규칙이 ${n}개 있어요. 규칙과 함께 뺄지 다시 골라 주세요.`;
const invalid = (message: string) => bad(message, "invalid_rule");

export function priceOf(v: unknown, label: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) throw invalid(`${label}을 숫자로 넣어 주세요.`);
  if (!(v > 0)) throw invalid(`${label}은 0보다 커야 해요.`);
  if (v > MAX_PRICE) throw invalid(`${label}이 너무 커요.`);
  return v;
}

function untilOf(v: unknown, market: "US" | "KR", now: number): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v) || !Number.isFinite(Date.parse(`${v}T00:00:00Z`))) throw invalid("기한은 날짜로 정해 주세요.");
  const today = marketDate(market, now);
  if (v < today) throw invalid("기한이 이미 지났어요.");
  const max = new Date(Date.parse(`${today}T00:00:00Z`) + UNTIL_MAX_DAYS * 86_400_000).toISOString().slice(0, 10);
  if (v > max) throw invalid("기한은 1년 안으로 정해 주세요.");
  return v;
}

function bufferOf(v: unknown): number | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "number" || !Number.isFinite(v) || v < BUFFER_MIN || v > BUFFER_MAX) throw invalid(`장중 버퍼는 ${BUFFER_MIN}–${BUFFER_MAX}% 사이로 정해 주세요.`);
  return Math.round(v * 10) / 10;
}

const ACTIONS = new Set(["notify", "call", "sell"]);

/** a new rule from the person's draft (POST); throws the 400s */
export function specFromDraft(d: Partial<InvestRuleDraft>, now: number): RuleSpec {
  const symbol = normalizeSymbol(d.symbol);
  if (!symbol) throw bad(INVEST_ERRORS.unknown_symbol, "unknown_symbol");
  const market = marketOf(symbol);
  if (d.kind === "resistance" || d.kind === "invalidate") throw bad(INVEST_ERRORS.kind_not_allowed, "kind_not_allowed");
  if (d.kind !== "stop" && d.kind !== "target" && d.kind !== "buy_zone" && d.kind !== "alert") throw invalid("규칙 종류가 올바르지 않아요.");
  if (typeof d.action !== "string" || !ACTIONS.has(d.action)) throw invalid("행동이 올바르지 않아요.");
  if (d.action === "sell" && d.kind !== "stop") throw bad(INVEST_ERRORS.sell_not_allowed, "sell_not_allowed");
  if (d.once !== undefined && typeof d.once !== "boolean") throw invalid("한 번만 알릴지 다시 골라 주세요.");
  if (d.bufferPct !== undefined && d.bufferPct !== null && d.kind !== "stop") throw invalid("장중 버퍼는 손절에만 정할 수 있어요.");
  let level: number | null = null;
  if (d.kind === "target") {
    if (d.level !== undefined && d.level !== 1 && d.level !== 2 && d.level !== 3) throw invalid("익절 차수는 1–3차예요.");
    level = d.level ?? 1;
  } else if (d.level !== undefined) throw invalid("차수는 익절에만 정할 수 있어요.");
  let price: number | null = null;
  let lo: number | null = null;
  let hi: number | null = null;
  let direction: RuleSpec["direction"];
  if (d.kind === "buy_zone") {
    lo = priceOf(d.lo, "구간 아래 가격");
    hi = priceOf(d.hi, "구간 위 가격");
    if (!(lo < hi)) throw invalid("구간 아래 가격이 위 가격보다 낮아야 해요.");
    direction = "inside";
  } else {
    price = priceOf(d.price, "가격");
    if (d.kind === "alert") {
      if (d.direction !== "below" && d.direction !== "above") throw invalid("가격 알림은 위로 갈지 아래로 갈지 정해 주세요.");
      direction = d.direction;
    } else direction = d.kind === "stop" ? "below" : "above";
  }
  return {
    symbol,
    kind: d.kind,
    level,
    price,
    lo,
    hi,
    direction,
    action: d.action as RuleSpec["action"],
    once: d.once ? 1 : 0,
    buffer_pct: d.kind === "stop" ? bufferOf(d.bufferPct) : null,
    until_day: untilOf(d.until, market, now),
  };
}

/** an existing rule with the person's changes (PATCH); the kind, level and symbol never change */
export function specWithChanges(r: RuleSpec, ch: Partial<InvestRuleChanges>, now: number): RuleSpec {
  if (!ch || typeof ch !== "object") throw invalid("바꿀 내용을 보내 주세요.");
  const market = marketOf(r.symbol);
  const next: RuleSpec = { ...r };
  if (ch.price !== undefined) {
    if (r.kind === "buy_zone") throw invalid("매수 검토는 구간 가격으로 바꿔 주세요.");
    next.price = priceOf(ch.price, "가격");
  }
  if (ch.lo !== undefined || ch.hi !== undefined) {
    if (r.kind !== "buy_zone") throw invalid("구간 가격은 매수 검토에만 있어요.");
    next.lo = ch.lo !== undefined ? priceOf(ch.lo, "구간 아래 가격") : r.lo;
    next.hi = ch.hi !== undefined ? priceOf(ch.hi, "구간 위 가격") : r.hi;
    if (!(next.lo! < next.hi!)) throw invalid("구간 아래 가격이 위 가격보다 낮아야 해요.");
  }
  // the same direction sent back (a sheet that sends every field) changes nothing
  if (ch.direction !== undefined && ch.direction !== r.direction) {
    if (r.kind !== "alert") throw invalid("이 규칙은 방향을 바꿀 수 없어요.");
    if (ch.direction !== "below" && ch.direction !== "above") throw invalid("가격 알림은 위로 갈지 아래로 갈지 정해 주세요.");
    next.direction = ch.direction;
  }
  if (ch.action !== undefined) {
    if (typeof ch.action !== "string" || !ACTIONS.has(ch.action)) throw invalid("행동이 올바르지 않아요.");
    if (ch.action === "sell" && r.kind !== "stop") throw bad(INVEST_ERRORS.sell_not_allowed, "sell_not_allowed");
    next.action = ch.action;
  }
  if (ch.until !== undefined) next.until_day = untilOf(ch.until, market, now);
  if (ch.once !== undefined) {
    if (typeof ch.once !== "boolean") throw invalid("한 번만 알릴지 다시 골라 주세요.");
    next.once = ch.once ? 1 : 0;
  }
  if (ch.bufferPct !== undefined) {
    if (r.kind !== "stop") throw invalid("장중 버퍼는 손절에만 정할 수 있어요.");
    next.buffer_pct = bufferOf(ch.bufferPct);
  }
  return next;
}

const SPEC_KEYS = ["symbol", "kind", "level", "price", "lo", "hi", "direction", "action", "once", "buffer_pct", "until_day"] as const;
function specOf(r: RuleSpec): RuleSpec {
  const o = {} as Record<string, unknown>;
  for (const k of SPEC_KEYS) o[k] = r[k];
  return o as unknown as RuleSpec;
}
function sameSpec(a: RuleSpec, b: RuleSpec): boolean {
  return SPEC_KEYS.every((k) => (a[k] ?? null) === (b[k] ?? null));
}
/** a change to where the rule's line is: the earlier state is not known afterwards */
function lineMoved(a: RuleSpec, b: RuleSpec): boolean {
  return a.price !== b.price || a.lo !== b.lo || a.hi !== b.hi || a.direction !== b.direction || (a.buffer_pct ?? null) !== (b.buffer_pct ?? null);
}

interface PreviewSaved {
  ruleId: string | null;
  ruleRev: number | null;
  spec: RuleSpec;
  qty: number | null;
}

export function investRoutes(core: Core) {
  const hub = () => core.invest;

  async function sellableQty(userId: string, spec: RuleSpec): Promise<number | null> {
    if (spec.kind !== "stop" || spec.action !== "sell") return null;
    const h = hub();
    if (!h.toss.base() || !(await h.toss.connected(userId))) return null;
    const r = await h.toss.sellable(userId, spec.symbol);
    return r.ok ? r.value : null;
  }

  async function buildPreview(userId: string, before: idb.RuleRow | null, spec: RuleSpec): Promise<InvestRulePreview> {
    const now = core.now();
    const ctx = await hub().previewContext(userId, spec.symbol);
    const market = ctx.market;
    const qty = await sellableQty(userId, spec);
    let basis: InvestRulePreview["basis"] = null;
    let buffer: number | null = null;
    if (spec.kind === "stop") {
      const c = await hub().stopContext(userId, spec.symbol, spec.price!, bufferPct(spec));
      basis = c.basis;
      buffer = c.basis === "close_and_intraday" ? c.buffer : bufferPrice(market, spec.price!, bufferPct(spec));
    }
    const result = resultSentence(spec, { market, mode: ctx.mode, basis: basis ?? "intraday", buffer: basis === "close_and_intraday" ? buffer : null, qty });
    const change = changeSentence(market, before, spec);
    const changed = !before || !sameSpec(before, spec);
    const sentence = changed ? (change ? `${change} ${result}` : result) : `지금 규칙이에요. ${result}`;
    const previewId = newId("ip");
    const saved: PreviewSaved = { ruleId: before?.id ?? null, ruleRev: before?.rev ?? null, spec: specOf(spec), qty };
    idb.putPreview(core.db, { id: previewId, user_id: userId, kind: before ? "patch" : "create", spec_json: JSON.stringify(saved), expires_at: now + PREVIEW_TTL_MS });
    const isSell = spec.kind === "stop" && spec.action === "sell";
    const qtyNum: InvestNum | null = isSell ? (qty != null ? { v: qty, text: shares(qty), unit: "qty" } : { v: null, text: "확인 불가", unit: "qty" }) : null;
    const p = bufferPct(spec);
    return {
      previewId,
      expiresAt: now + PREVIEW_TTL_MS,
      sentence,
      changed,
      warning: stopWarning(market, spec, ctx.price, !!before),
      basis,
      buffer: spec.kind === "stop" ? moneyNum(market, bufferPrice(market, spec.price!, p)) : null,
      bufferPct: spec.kind === "stop" ? { v: p, text: `${p}%`, unit: "pct" } : null,
      bufferDefault: spec.kind === "stop" && spec.buffer_pct == null,
      bufferFoot: spec.kind === "stop" && basis ? bufferFoot(basis, spec.buffer_pct == null) : null,
      sellable: qtyNum,
      price: ctx.price != null ? moneyNum(market, ctx.price) : null,
      confirm: isSell && ctx.mode === "real" ? "hold" : "tap",
      callNote: spec.action === "call" ? callNote(ctx.callBlock) : null,
    };
  }

  /** a previewId sent with a save: still unused, unexpired, for this rule at this rev, the same spec and quantity */
  async function checkPreview(userId: string, previewId: unknown, before: idb.RuleRow | null, spec: RuleSpec): Promise<void> {
    if (previewId === undefined || previewId === null) return;
    const stale = async () => {
      throw new HttpError(409, "preview_stale", INVEST_ERRORS.preview_stale, undefined, { preview: await buildPreview(userId, before, spec) });
    };
    if (typeof previewId !== "string") return stale();
    const row = idb.getPreview(core.db, userId, previewId, core.now());
    if (!row) return stale();
    let saved: PreviewSaved;
    try {
      saved = JSON.parse(row.spec_json) as PreviewSaved;
    } catch {
      return stale();
    }
    if (saved.ruleId !== (before?.id ?? null) || saved.ruleRev !== (before?.rev ?? null) || !sameSpec(saved.spec, spec)) return stale();
    if ((await sellableQty(userId, spec)) !== saved.qty) return stale();
    idb.usePreview(core.db, previewId, core.now());
  }

  function requireWatched(userId: string, symbol: string): idb.WatchRow {
    const w = idb.watchRow(core.db, userId, symbol);
    if (!w) throw bad(INVEST_ERRORS.not_watched, "not_watched");
    return w;
  }

  function mineRule(userId: string, id: string | undefined): idb.RuleRow {
    const r = id ? idb.rule(core.db, userId, id) : null;
    if (!r) throw notFound(INVEST_ERRORS.rule_not_found, "rule_not_found");
    return r;
  }

  const view = (userId: string, r: idb.RuleRow) => hub().ruleRow(r, idb.ensureSettings(core.db, userId, core.now()).mode);

  return {
    overview: async (_c: Ctx, userId: string) => json(await hub().overview(userId)),
    stages: async (_c: Ctx, userId: string) => json(stagesDetail(core, userId, core.now())),
    /** B2c-1: one sent daily report of the person's own (anyone else's reads as missing) */
    report: async (c: Ctx, userId: string) => {
      const r = c.params.id ? reportView(core, userId, c.params.id, core.now()) : null;
      if (!r) throw notFound(INVEST_ERRORS.report_not_found, "report_not_found");
      return json(r);
    },

    symbol: async (c: Ctx, userId: string) => {
      const symbol = normalizeSymbol(c.params.symbol);
      const d = symbol ? await hub().symbolDetail(userId, symbol) : null;
      if (!d) throw notFound(INVEST_ERRORS.not_watched, "not_watched");
      return json(d);
    },

    addWatch: async (c: Ctx, userId: string) => {
      const body = await readJson(c.req);
      const symbol = normalizeSymbol(body.symbol);
      if (!symbol) throw notFound(INVEST_ERRORS.unknown_symbol, "unknown_symbol");
      const now = core.now();
      const market = marketOf(symbol);
      const have = idb.watchRow(core.db, userId, symbol);
      if (!have) {
        if (idb.watchlist(core.db, userId).length >= MAX_WATCH) throw bad(INVEST_ERRORS.too_many_watch, "too_many_watch");
        let name = symbol;
        if (hub().gate.enabled()) {
          const q = await hub().yahooQuote(symbol, market);
          if (q === "not_found") throw notFound(INVEST_ERRORS.unknown_symbol, "unknown_symbol");
          if (q) {
            if (q.name) name = q.name;
            idb.putQuote(core.db, { user_id: userId, symbol, price: q.price, prev_close: q.prevClose, source: "yahoo", as_of: q.at, fetched_at: now });
          }
        }
        idb.ensureSettings(core.db, userId, now);
        idb.addWatch(core.db, { user_id: userId, symbol, market, name, added_at: now });
        await hub().publish(userId);
      }
      const ov = await hub().overview(userId);
      return json(ov.watchlist.find((w) => w.symbol === symbol)!, have ? 200 : 201);
    },

    removeWatch: async (c: Ctx, userId: string) => {
      const symbol = normalizeSymbol(c.params.symbol);
      if (!symbol || !idb.watchRow(core.db, userId, symbol)) throw notFound(INVEST_ERRORS.not_watched, "not_watched");
      const n = idb.rules(core.db, userId, symbol).length;
      if (n && c.url.searchParams.get("withRules") !== "1") throw new HttpError(409, "has_rules", hasRules(n), undefined, { count: n });
      core.db.tx(() => {
        idb.deleteSymbolRules(core.db, userId, symbol);
        idb.deleteQuote(core.db, userId, symbol);
        idb.removeWatch(core.db, userId, symbol);
      });
      await hub().publish(userId);
      return json({ ok: true });
    },

    preview: async (c: Ctx, userId: string) => {
      const body = await readJson<Partial<InvestRuleDraft> & { ruleId?: unknown; changes?: Partial<InvestRuleChanges> }>(c.req);
      const now = core.now();
      if (body.ruleId !== undefined) {
        const r = mineRule(userId, typeof body.ruleId === "string" ? body.ruleId : undefined);
        return json(await buildPreview(userId, r, specWithChanges(r, body.changes ?? {}, now)));
      }
      const spec = specFromDraft(body, now);
      requireWatched(userId, spec.symbol);
      return json(await buildPreview(userId, null, spec));
    },

    create: async (c: Ctx, userId: string) => {
      const body = await readJson<{ draft?: Partial<InvestRuleDraft>; previewId?: unknown }>(c.req);
      const now = core.now();
      const spec = specFromDraft(body.draft ?? {}, now);
      requireWatched(userId, spec.symbol);
      if (idb.rules(core.db, userId).length >= MAX_RULES) throw bad(INVEST_ERRORS.too_many_rules, "too_many_rules");
      const s = idb.ensureSettings(core.db, userId, now);
      if (spec.action === "sell" && s.mode === "real" && (await sellableQty(userId, spec)) === 0) throw bad(INVEST_ERRORS.not_held, "not_held");
      await checkPreview(userId, body.previewId, null, spec);
      const row: idb.RuleRow = {
        id: newId("ir"),
        user_id: userId,
        ...spec,
        conditions_json: null,
        state: "armed",
        hit_at: null,
        hit_seq: 0,
        cleared_at: null,
        paused_at: null,
        seen_slot: null,
        real_confirmed_at: null,
        rev: 1,
        created_by: "person",
        created_at: now,
        updated_at: now,
      };
      idb.insertRule(core.db, row);
      await hub().publish(userId);
      return json(view(userId, idb.rule(core.db, userId, row.id)!), 201);
    },

    patch: async (c: Ctx, userId: string) => {
      const body = await readJson<{ changes?: Partial<InvestRuleChanges>; ifRev?: unknown; previewId?: unknown }>(c.req);
      const now = core.now();
      const r = mineRule(userId, c.params.id);
      if (typeof body.ifRev !== "number" || !Number.isInteger(body.ifRev)) throw invalid("규칙을 다시 불러온 뒤 저장해 주세요.");
      if (body.ifRev !== r.rev) throw new HttpError(409, "rule_changed", INVEST_ERRORS.rule_changed, undefined, { rule: view(userId, r) });
      const spec = specWithChanges(r, body.changes ?? {}, now);
      const s = idb.ensureSettings(core.db, userId, now);
      if (spec.action === "sell" && r.action !== "sell" && s.mode === "real" && (await sellableQty(userId, spec)) === 0) throw bad(INVEST_ERRORS.not_held, "not_held");
      await checkPreview(userId, body.previewId, r, spec);
      // any save of a stopped or expired rule watches it again; a moved line forgets the earlier state (team-lead 2045-8)
      let state = r.state;
      let paused_at = r.paused_at;
      let seen_slot = r.seen_slot;
      if (r.state === "paused" || r.state === "expired") {
        state = "armed";
        paused_at = null;
        seen_slot = SEEN_RESUMED;
      } else if (lineMoved(r, spec)) {
        state = "armed";
        seen_slot = SEEN_EDITED;
      }
      if (state === "armed" && spec.until_day && spec.until_day < marketDate(marketOf(r.symbol), now)) throw invalid("기한이 이미 지났어요.");
      core.db.tx(() => {
        const cur = idb.rule(core.db, userId, r.id);
        if (!cur || cur.rev !== r.rev) throw new HttpError(409, "rule_changed", INVEST_ERRORS.rule_changed, undefined, { rule: cur ? view(userId, cur) : null });
        idb.updateRuleDefinition(core.db, { id: r.id, user_id: userId, ...spec, state, paused_at, seen_slot }, now);
      });
      await hub().publish(userId);
      return json(view(userId, idb.rule(core.db, userId, r.id)!));
    },

    removeRule: async (c: Ctx, userId: string) => {
      const r = mineRule(userId, c.params.id);
      idb.deleteRule(core.db, userId, r.id);
      await hub().publish(userId);
      return json({ ok: true });
    },

    toss: async (_c: Ctx, userId: string) => json(await hub().tossStatus(userId, idb.ensureSettings(core.db, userId, core.now()))),

    tossCheck: async (_c: Ctx, userId: string) => {
      if ((await hub().checkToss(userId, { floor: true })) === "too_soon") throw new HttpError(429, "toss_check_too_soon", INVEST_ERRORS.toss_check_too_soon);
      return json(await hub().tossStatus(userId, idb.ensureSettings(core.db, userId, core.now())));
    },

    settings: async (c: Ctx, userId: string) => {
      const body = await readJson<InvestSettingsPatch>(c.req);
      const now = core.now();
      const s = idb.ensureSettings(core.db, userId, now);
      if (body.calls !== undefined) {
        if (!body.calls || typeof body.calls !== "object") throw bad("전화 설정이 올바르지 않아요.");
        const cur = hub().calls(s);
        for (const k of ["stopResult", "stage", "expiry"] as const) {
          const v = (body.calls as Record<string, unknown>)[k];
          if (v === undefined) continue;
          if (typeof v !== "boolean") throw bad("전화 설정은 켜기와 끄기로 정해 주세요.");
          cur[k] = v;
        }
        idb.updateSettings(core.db, userId, { calls_json: JSON.stringify(cur) }, now);
      }
      await hub().publish(userId);
      return json(await hub().settingsView(userId));
    },

    // ── B2a: the ledger, the forecast ledger, the event calendar (each person's own; the model writes through B2b) ──

    ledger: async (c: Ctx, userId: string) => {
      const id = c.url.searchParams.get("id");
      if (id !== null && !LEDGER_ID_RE.test(id)) throw bad("id가 올바르지 않아요.", "invalid_ledger");
      return json({ items: readLedger(core.db, userId, { id: id ?? undefined, limit: limitOf(c) }) });
    },

    addLedger: async (c: Ctx, userId: string) => json(writeLedger(core.db, userId, await readJson(c.req), "person", core.now()), 201),

    forecasts: async (c: Ctx, userId: string) => {
      const now = core.now();
      return json({
        items: listForecasts(core.db, userId, now, limitOf(c) ?? 100),
        score: forecastScore(forecastRows(core.db, userId), now),
        outcomes: OUTCOMES.map((value) => ({ value, word: OUTCOME_WORD[value] })),
        causes: ERROR_CAUSES.map((value) => ({ value, ...ERROR_CAUSE_WORD[value] })),
      });
    },

    addForecast: async (c: Ctx, userId: string) => json(createForecast(core.db, userId, await readJson(c.req), "person", core.now()), 201),

    judgeForecast: async (c: Ctx, userId: string) => json(judgeForecast(core.db, userId, c.params.id, await readJson(c.req), core.now())),

    events: async (c: Ctx, userId: string) => json({ items: listEvents(core.db, userId, { from: c.url.searchParams.get("from"), to: c.url.searchParams.get("to") }, core.now()) }),

    addEvent: async (c: Ctx, userId: string) => json(createEvent(core.db, userId, await readJson(c.req), "person", core.now()), 201),

    patchEvent: async (c: Ctx, userId: string) => json(setEventRemind(core.db, userId, c.params.id, await readJson(c.req), core.now())),

    removeEvent: async (c: Ctx, userId: string) => {
      deleteEvent(core.db, userId, c.params.id, core.now());
      return json({ ok: true });
    },
  };
}

