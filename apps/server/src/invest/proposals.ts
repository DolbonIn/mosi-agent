/**
 * The model's rule proposals (B2b-1; A12 · G8-5, DD 1935 §2-3, screens-chat 0119 → agent-runtime 0221). The model only
 * proposes: invest_watch_propose stores a proposal and shows an `invest_rule_change` card, and nothing changes until
 * the person taps 바꾸기 (POST /api/invest/proposals/:id {decision: "apply" | "keep"}).
 *
 * A proposal moves where rules are and nothing else: an existing rule's price, its zone (매수 검토) or a price alert's
 * direction, a new rule that only notifies (resistance and invalidation rules are made this way), or taking an existing
 * rule away (DD 0405 G: its row reads `$30.50 → 없음`). It never sets an
 * action (sell, call), the buffer, the deadline or "once": those stay the person's, in the edit sheet. It is stale when
 * any rule it names moved since (its rev), the symbol left the watch, the order mode changed, or — a real sell stop —
 * the sellable quantity its result sentence promised changed. It expires after PROPOSAL_TTL_MS.
 *
 * The card's foot (as-of, source, grade) is code's (DD 0521 §1): the model names what the reason rests on — a ledger id
 * (its newest row the person can read; grade C is refused), "technicals" (this turn's invest_technicals answer for the
 * symbol) or "request" (the person named the prices: REQUEST_FOOT, no grade) — and never writes the foot's words.
 */
import type { Card, InvestRuleChangeCard, InvestRuleKind } from "@pickle/protocol";
import { basisNote } from "@pickle/quant";
import { publishMessage, publishThread, type Core } from "../core.ts";
import { bad, HttpError, json, notFound, readJson, type Ctx } from "../http.ts";
import { newId, safeJson } from "../util.ts";
import { marketDate, marketOf, normalizeSymbol } from "./calendar.ts";
import * as idb from "./db.ts";
import { invalidOf, LEDGER_ID_RE, lineOf, oneOf, readLedger } from "./ledger.ts";
import { INVEST_ERRORS, MAX_RULES, priceOf, specWithChanges } from "./routes.ts";
import {
  bufferPct,
  bufferPrice,
  eulReul,
  eunNeun,
  euroRo,
  iGa,
  kindWord,
  money,
  resultSentence,
  SEEN_EDITED,
  SEEN_RESUMED,
  stopWarning,
  zoneText,
  type RuleSpec,
} from "./rules.ts";

export const PROPOSAL_TTL_MS = 24 * 60 * 60_000;
export const MAX_PROPOSAL_ITEMS = 6;
const REASON_MAX = 120;
/** the foot of a proposal made from the person's own prices (DD 0521 §1): no source, no grade */
export const REQUEST_FOOT = "요청으로 만든 제안이에요.";

export const PROPOSAL_ERRORS = {
  proposal_not_found: "이미 없어진 제안이에요.",
  proposal_stale: "그사이 규칙이 바뀌어서 적용하지 않았어요.",
  proposal_expired: "시간이 지나서 그대로 뒀어요.",
  proposal_decided: "이미 정한 제안이에요.",
} as const;

const invalid = invalidOf("invalid_proposal");
const KINDS: readonly InvestRuleKind[] = ["stop", "target", "buy_zone", "alert", "resistance", "invalidate"];

/**
 * one change: an existing rule (ruleId, the rev it was proposed against, its spec then) or a new rule (before null);
 * `remove`: the existing rule goes (after is its spec then, as before)
 */
export interface ProposalItem {
  ruleId: string | null;
  rev: number | null;
  before: RuleSpec | null;
  after: RuleSpec;
  remove?: true;
}

export interface ProposalRow {
  id: string;
  user_id: string;
  thread_id: string | null;
  symbol: string;
  items_json: string;
  mode: "mock" | "real";
  qty: number | null;
  card_json: string;
  status: InvestRuleChangeCard["status"];
  expires_at: number;
  decided_at: number | null;
  created_at: number;
}

/** what invest_watch_propose sends; basis is a ledger id, "technicals" or "request" */
export interface ProposalArgs {
  symbol?: unknown;
  changes?: unknown;
  reason?: unknown;
  basis?: unknown;
}

/** what code saw in this turn that a proposal may rest on */
export interface ProposalSeen {
  /** the symbol's invest_technicals answer in this turn: its last bar's day, the source's name and grade */
  technicals?(symbol: string): { asOf: string; source: string; grade: string } | null;
}

/** the card's foot from what the model named; throws the 400 when code cannot find it */
function footOf(core: Core, userId: string, symbol: string, basis: unknown, saw: ProposalSeen): string {
  if (basis === "request") return REQUEST_FOOT;
  if (basis === "technicals") {
    const t = saw.technicals?.(symbol) ?? null;
    if (!t) throw invalid(`이번 턴에 ${symbol} 지표를 받지 못했어요. invest_technicals가 답한 뒤에 넣거나, 사람이 말한 가격이면 "request"로 넣어 주세요.`);
    return basisNote(t.asOf, t.source, t.grade);
  }
  if (typeof basis !== "string" || !LEDGER_ID_RE.test(basis)) throw invalid('근거는 원장 id, "technicals", "request" 가운데 하나로 넣어 주세요.');
  const row = readLedger(core.db, userId, { id: basis, limit: 1 })[0];
  if (!row) throw invalid("원장에 그 id가 없어요. 원장에 있는 id를 넣어 주세요.");
  if (row.confidence === "C") throw invalid("등급 C 값은 근거로 쓰지 않아요.");
  return basisNote(row.asOf.slice(0, 10), row.source, row.confidence);
}

// ───────────────────────────── checks ─────────────────────────────

const isSell = (s: RuleSpec) => s.kind === "stop" && s.action === "sell";
/** an item whose result is a sell stop in place (taking one away sells nothing) */
const sellsAfter = (i: ProposalItem) => !i.remove && isSell(i.after);

/** a new rule the model proposes: it only notifies; the person picks call or sell later in the sheet */
function newSpec(symbol: string, c: Record<string, unknown>): RuleSpec {
  const kind = oneOf(c.kind, KINDS, "규칙 종류", invalid);
  let level: number | null = null;
  if (kind === "target") {
    if (c.level !== undefined && c.level !== 1 && c.level !== 2 && c.level !== 3) throw invalid("익절 차수는 1–3차예요.");
    level = (c.level as number | undefined) ?? 1;
  } else if (c.level !== undefined) throw invalid("차수는 익절에만 정할 수 있어요.");
  const spec: RuleSpec = { symbol, kind, level, price: null, lo: null, hi: null, direction: "inside", action: "notify", once: 0, buffer_pct: null, until_day: null };
  if (kind === "buy_zone") {
    spec.lo = priceOf(c.lo, "구간 아래 가격");
    spec.hi = priceOf(c.hi, "구간 위 가격");
    if (!(spec.lo < spec.hi)) throw invalid("구간 아래 가격이 위 가격보다 낮아야 해요.");
    return spec;
  }
  spec.price = priceOf(c.price, "가격");
  if (kind === "alert" || kind === "invalidate") {
    if (c.direction !== "below" && c.direction !== "above") throw invalid("위로 갈지 아래로 갈지 정해 주세요.");
    spec.direction = c.direction;
  } else spec.direction = kind === "stop" ? "below" : "above";
  return spec;
}

const MOVES = ["price", "lo", "hi", "direction"] as const;

/** the model's arguments → the symbol, its items and the reason line; throws the 400s */
export function checkProposal(core: Core, userId: string, a: ProposalArgs, now: number, saw: ProposalSeen = {}): { symbol: string; items: ProposalItem[]; reason: string | null; reasonFoot: string } {
  const symbol = normalizeSymbol(a.symbol);
  if (!symbol) throw bad(INVEST_ERRORS.unknown_symbol, "unknown_symbol");
  if (!idb.watchRow(core.db, userId, symbol)) throw bad(INVEST_ERRORS.not_watched, "not_watched");
  if (!Array.isArray(a.changes) || !a.changes.length) throw invalid("바꿀 규칙을 하나 넣어 주세요.");
  if (a.changes.length > MAX_PROPOSAL_ITEMS) throw invalid(`한 번에 ${MAX_PROPOSAL_ITEMS}개까지 제안할 수 있어요.`);
  const items: ProposalItem[] = [];
  const seen = new Set<string>();
  for (const raw of a.changes) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw invalid("바꿀 규칙이 올바르지 않아요.");
    const c = raw as Record<string, unknown>;
    if (c.ruleId === undefined || c.ruleId === null) {
      for (const k of Object.keys(c)) if (k !== "ruleId" && k !== "kind" && k !== "level" && !(MOVES as readonly string[]).includes(k)) throw invalid("제안은 가격, 구간, 방향만 정할 수 있어요.");
      items.push({ ruleId: null, rev: null, before: null, after: newSpec(symbol, c) });
      continue;
    }
    const r = typeof c.ruleId === "string" ? idb.rule(core.db, userId, c.ruleId) : null;
    if (!r || r.symbol !== symbol) throw notFound(INVEST_ERRORS.rule_not_found, "rule_not_found");
    if (seen.has(r.id)) throw invalid("같은 규칙을 두 번 넣었어요.");
    seen.add(r.id);
    if (c.kind !== undefined && c.kind !== r.kind) throw invalid("규칙 종류는 바꿀 수 없어요.");
    if (c.level !== undefined && c.level !== r.level) throw invalid("익절 차수는 바꿀 수 없어요.");
    if (c.remove !== undefined) {
      if (c.remove !== true || Object.keys(c).some((k) => k !== "ruleId" && k !== "kind" && k !== "level" && k !== "remove")) throw invalid("지울 때는 ruleId와 remove: true만 넣어 주세요.");
      items.push({ ruleId: r.id, rev: r.rev, before: specOnly(r), after: specOnly(r), remove: true });
      continue;
    }
    for (const k of Object.keys(c)) if (k !== "ruleId" && k !== "kind" && k !== "level" && !(MOVES as readonly string[]).includes(k)) throw invalid("제안은 가격, 구간, 방향만 바꿀 수 있어요.");
    if (r.state === "expired" || (r.until_day && r.until_day < marketDate(marketOf(symbol), now))) throw invalid("기한이 지난 규칙이에요. 새 규칙으로 제안해 주세요.");
    const ch: Record<string, unknown> = {};
    for (const k of MOVES) if (c[k] !== undefined) ch[k] = c[k];
    const after = specWithChanges(r, ch, now);
    if (MOVES.every((k) => (after[k] ?? null) === (r[k] ?? null))) throw invalid("바뀌는 것이 없어요.");
    items.push({ ruleId: r.id, rev: r.rev, before: specOnly(r), after: specOnly(after) });
  }
  const added = items.filter((i) => !i.ruleId).length;
  if (added && idb.rules(core.db, userId).length + added - items.filter((i) => i.remove).length > MAX_RULES) throw bad(INVEST_ERRORS.too_many_rules, "too_many_rules");
  // DD 0717: a request may come with no reason (the person gave none in this turn); any other basis needs one
  const reason = lineOf(a.reason, "이유", REASON_MAX, invalid, a.basis === "request");
  return { symbol, items, reason, reasonFoot: footOf(core, userId, symbol, a.basis, saw) };
}

const SPEC_KEYS = ["symbol", "kind", "level", "price", "lo", "hi", "direction", "action", "once", "buffer_pct", "until_day"] as const;
function specOnly(r: RuleSpec): RuleSpec {
  const o = {} as Record<string, unknown>;
  for (const k of SPEC_KEYS) o[k] = r[k] ?? null;
  return o as unknown as RuleSpec;
}

// ───────────────────────────── the card ─────────────────────────────

const DIR = { below: "이하", above: "이상", inside: "" } as const;

/** a rule's value on the card's change row: $30.50 / $30.00–31.50 / $35.00 이상 (a new alert or invalidation) */
function valueText(s: RuleSpec, withDirection: boolean): string {
  const m = marketOf(s.symbol);
  if (s.kind === "buy_zone") return zoneText(m, s.lo!, s.hi!);
  const p = money(m, s.price!);
  return withDirection && (s.kind === "alert" || s.kind === "invalidate") ? `${p} ${DIR[s.direction]}` : p;
}

function changeRows(items: readonly ProposalItem[]): InvestRuleChangeCard["changes"] {
  const out: InvestRuleChangeCard["changes"] = [];
  for (const { before, after, remove } of items) {
    const label = kindWord(after.kind, after.level);
    if (!before) {
      out.push({ label, from: "없음", to: valueText(after, true) });
      continue;
    }
    if (remove) {
      out.push({ label, from: valueText(before, true), to: "없음" });
      continue;
    }
    if (before.price !== after.price || before.lo !== after.lo || before.hi !== after.hi) out.push({ label, from: valueText(before, false), to: valueText(after, false) });
    if (before.direction !== after.direction) out.push({ label: `${label} 방향`, from: DIR[before.direction], to: DIR[after.direction] });
  }
  return out;
}

/** the rule's word in the title and in the sentence of taking it away: 손절선, 알림 가격, 저항 가격, 매수 검토 구간 */
function ruleWord(s: RuleSpec): string {
  const k = kindWord(s.kind, s.level);
  return s.kind === "stop" ? "손절선" : s.kind === "buy_zone" ? `${k} 구간` : s.kind === "alert" ? "알림 가격" : `${k} 가격`;
}

/**
 * DD 1935 §2-3 1, DD 0405 G and DD 0452: SOXL 손절선을 $30.50으로 올릴까요? (올릴까요/내릴까요 only beside a value
 * before) / SOXL 손절선을 $30.50으로 둘까요? (a new rule) / SOXL 손절선을 지울까요? / SOXL 알림을 $35.00 이상으로
 * 바꿀까요? (the direction alone) / several: SOXL 새 전략 가격 4개를 적용할까요?, with one taken away SOXL 규칙 N개를
 * 바꿀까요?, all taken away SOXL 규칙 N개를 지울까요?
 */
function titleOf(symbol: string, items: readonly ProposalItem[]): string {
  if (items.length > 1) {
    const gone = items.filter((i) => i.remove).length;
    if (!gone) return `${symbol} 새 전략 가격 ${items.length}개를 적용할까요?`;
    return `${symbol} 규칙 ${items.length}개를 ${gone === items.length ? "지울까요?" : "바꿀까요?"}`;
  }
  const { before, after, remove } = items[0]!;
  const k = kindWord(after.kind, after.level);
  const what = ruleWord(after);
  if (!before) return `${symbol} ${eulReul(what)} ${euroRo(valueText(after, true))} 둘까요?`;
  if (remove) return `${symbol} ${eulReul(what)} 지울까요?`;
  if (after.kind !== "buy_zone" && before.price !== after.price) {
    const up = after.price! > before.price!;
    return `${symbol} ${eulReul(what)} ${euroRo(valueText(after, false))} ${up ? "올릴까요?" : "내릴까요?"}`;
  }
  if (after.kind === "buy_zone") return `${symbol} ${eulReul(what)} ${euroRo(valueText(after, false))} 바꿀까요?`;
  return `${symbol} ${eulReul(after.kind === "alert" ? "알림" : k)} ${euroRo(valueText(after, true))} 바꿀까요?`;
}

async function sellable(core: Core, userId: string, symbol: string): Promise<number | null> {
  const h = core.invest;
  if (!h.toss.base() || !(await h.toss.connected(userId))) return null;
  const r = await h.toss.sellable(userId, symbol);
  return r.ok ? r.value : null;
}

/**
 * what stops when a rule goes, in the sheet's words (DD 0452 §2; rules.ts deleteNote): 지우면 SOXL이 손절선에 닿아도
 * 팔지 않아요. / 지우면 SOXL이 매수 검토 구간에 들어와도 알리지 않아요.
 */
function removedSentence(r: RuleSpec, mode: "mock" | "real"): string {
  const reach = r.kind === "buy_zone" ? "들어와도" : "닿아도";
  const what = isSell(r) ? (mode === "real" ? "팔지 않아요." : "기록하지 않아요.") : r.action === "call" ? "전화하지 않아요." : "알리지 않아요.";
  return `지우면 ${iGa(r.symbol)} ${ruleWord(r)}에 ${reach} ${what}`;
}

/**
 * the result sentences (DD 1935 §2-3 4, DD 0452 §4): each item's on its own line; with several, a line that puts or
 * changes a price names its kind first (a line taking one away already names it)
 */
async function resultOf(core: Core, userId: string, items: readonly ProposalItem[], mode: "mock" | "real", qty: number | null): Promise<{ result: string; warning?: string }> {
  const symbol = items[0]!.after.symbol;
  const ctx = await core.invest.previewContext(userId, symbol);
  const market = ctx.market;
  const lines: string[] = [];
  let warning: string | undefined;
  for (const { after, remove } of items) {
    if (remove) {
      lines.push(removedSentence(after, mode));
      continue;
    }
    let basis: "intraday" | "close_and_intraday" = "intraday";
    let buffer: number | null = null;
    if (after.kind === "stop") {
      const c = await core.invest.stopContext(userId, symbol, after.price!, bufferPct(after));
      basis = c.basis;
      buffer = c.basis === "close_and_intraday" ? c.buffer : bufferPrice(market, after.price!, bufferPct(after));
    }
    const s = resultSentence(after, { market, mode, basis, buffer: basis === "close_and_intraday" ? buffer : null, qty: isSell(after) ? qty : null });
    lines.push(items.length > 1 ? `${eunNeun(kindWord(after.kind, after.level))} ${s}` : s);
    warning ??= stopWarning(market, after, ctx.price, true) ?? undefined;
  }
  return { result: lines.join("\n"), warning };
}

// ───────────────────────────── rows ─────────────────────────────

export function proposalRow(core: Core, userId: string, id: string): ProposalRow | null {
  return core.db.sql.query("SELECT * FROM invest_proposals WHERE id = $id AND user_id = $u").get({ id, u: userId }) as ProposalRow | null;
}

const cardOf = (r: ProposalRow) => JSON.parse(r.card_json) as InvestRuleChangeCard;

/** a decision or an expiry: the row's status and its card's, in one statement; decided already → the card as it is */
function settle(core: Core, r: ProposalRow, status: Exclude<InvestRuleChangeCard["status"], "pending">, now: number): InvestRuleChangeCard {
  const card: InvestRuleChangeCard = { ...cardOf(r), status, decidedAt: now };
  const res = core.db.sql
    .query("UPDATE invest_proposals SET status = $s, decided_at = $now, card_json = $card WHERE id = $id AND status = 'pending'")
    .run({ s: status, now, card: JSON.stringify(card), id: r.id });
  return res.changes === 1 ? card : cardOf(proposalRow(core, r.user_id, r.id)!);
}

/**
 * Store a proposal and return its card (the tool's result carries it into the turn's message). The order mode, the
 * sellable quantity a real sell stop's sentence promises, and every named rule's rev are kept for the stale check.
 */
export async function createProposal(core: Core, userId: string, threadId: string | null, a: ProposalArgs, saw: ProposalSeen = {}): Promise<{ id: string; card: InvestRuleChangeCard }> {
  const now = core.now();
  const { symbol, items, reason, reasonFoot } = checkProposal(core, userId, a, now, saw);
  const mode = idb.ensureSettings(core.db, userId, now).mode;
  const sells = items.some(sellsAfter);
  const qty = sells && mode === "real" ? await sellable(core, userId, symbol) : null;
  const { result, warning } = await resultOf(core, userId, items, mode, qty);
  const id = newId("ipr");
  const card: InvestRuleChangeCard = {
    type: "invest_rule_change",
    proposalId: id,
    symbol,
    title: titleOf(symbol, items),
    changes: changeRows(items),
    ...(reason ? { reason } : {}),
    reasonFoot,
    result,
    ...(warning ? { warning } : {}),
    confirm: sells && mode === "real" ? "hold" : "tap",
    status: "pending",
    expiresAt: now + PROPOSAL_TTL_MS,
    disclaimer: true,
  };
  core.db.sql
    .query(
      `INSERT INTO invest_proposals (id, user_id, thread_id, symbol, items_json, mode, qty, card_json, status, expires_at, decided_at, created_at)
       VALUES ($id, $u, $t, $symbol, $items, $mode, $qty, $card, 'pending', $exp, NULL, $now)`,
    )
    .run({ id, u: userId, t: threadId, symbol, items: JSON.stringify(items), mode, qty, card: JSON.stringify(card), exp: card.expiresAt, now });
  return { id, card };
}

/** why applying now would not do what the card said, or null */
async function staleNow(core: Core, userId: string, r: ProposalRow, items: readonly ProposalItem[], now: number): Promise<boolean> {
  if (!idb.watchRow(core.db, userId, r.symbol)) return true;
  const mode = idb.ensureSettings(core.db, userId, now).mode;
  if (mode !== r.mode) return true;
  for (const i of items) {
    if (!i.ruleId) continue;
    const cur = idb.rule(core.db, userId, i.ruleId);
    if (!cur || cur.rev !== i.rev) return true;
    // a rule past its deadline is still fine to take away
    if (!i.remove && cur.until_day && cur.until_day < marketDate(marketOf(r.symbol), now)) return true;
  }
  if (mode === "real" && items.some(sellsAfter) && (await sellable(core, userId, r.symbol)) !== r.qty) return true;
  return false;
}

const decidedAs = { apply: "applied", keep: "kept" } as const;

/**
 * The person's decision. Applying writes every item in one transaction (a moved rule is watched afresh: its earlier
 * state is not known); keeping changes nothing. The same decision again answers the card as it is; anything else on a
 * decided proposal is 409 proposal_decided (stale 409 proposal_stale, expired 410 proposal_expired), the card in the
 * body. The messages showing the card get its new state.
 */
export async function decideProposal(core: Core, userId: string, id: string | undefined, decision: unknown): Promise<InvestRuleChangeCard> {
  if (decision !== "apply" && decision !== "keep") throw invalid("바꿀지 그대로 둘지 골라 주세요.");
  const r = id ? proposalRow(core, userId, id) : null;
  if (!r) throw notFound(PROPOSAL_ERRORS.proposal_not_found, "proposal_not_found");
  const now = core.now();
  const fail = (card: InvestRuleChangeCard): never => {
    if (card.status === "expired") throw new HttpError(410, "proposal_expired", PROPOSAL_ERRORS.proposal_expired, undefined, { card });
    if (card.status === "stale") throw new HttpError(409, "proposal_stale", PROPOSAL_ERRORS.proposal_stale, undefined, { card });
    throw new HttpError(409, "proposal_decided", PROPOSAL_ERRORS.proposal_decided, undefined, { card });
  };
  if (r.status !== "pending") {
    const card = cardOf(r);
    if (card.status === decidedAs[decision]) return card;
    return fail(card);
  }
  if (now >= r.expires_at) {
    const card = settle(core, r, "expired", now);
    syncCards(core, userId, card);
    return fail(card);
  }
  if (decision === "keep") {
    const card = settle(core, r, "kept", now);
    syncCards(core, userId, card);
    return card;
  }
  const items = JSON.parse(r.items_json) as ProposalItem[];
  if (await staleNow(core, userId, r, items, now)) {
    const card = settle(core, r, "stale", now);
    syncCards(core, userId, card);
    return fail(card);
  }
  const added = items.filter((i) => !i.ruleId).length;
  if (added && idb.rules(core.db, userId).length + added - items.filter((i) => i.remove).length > MAX_RULES) throw bad(INVEST_ERRORS.too_many_rules, "too_many_rules");
  const outcome = core.db.tx((): InvestRuleChangeCard | "stale" | "decided" => {
    const cur = proposalRow(core, userId, r.id);
    if (!cur || cur.status !== "pending") return "decided";
    for (const i of items) {
      if (!i.ruleId) continue;
      const rule = idb.rule(core.db, userId, i.ruleId);
      if (!rule || rule.rev !== i.rev) return "stale";
    }
    for (const i of items) {
      if (i.remove) idb.deleteRule(core.db, userId, i.ruleId!);
      else if (i.ruleId) {
        const rule = idb.rule(core.db, userId, i.ruleId)!;
        const resumed = rule.state === "paused" || rule.state === "expired";
        // only where the line is changes; the action, buffer, deadline and "once" stay the person's
        idb.updateRuleDefinition(
          core.db,
          { ...rule, price: i.after.price, lo: i.after.lo, hi: i.after.hi, direction: i.after.direction, state: "armed", paused_at: null, seen_slot: resumed ? SEEN_RESUMED : SEEN_EDITED },
          now,
        );
        // B3b: the long press on 바꾸기 confirms a sell stop with the quantity the card printed (only a card drawn in real
        // mode has one; the stale check compared it with Toss's sellable), while real mode is still on
        const moved = idb.rule(core.db, userId, i.ruleId)!;
        if (idb.getSettings(core.db, userId)?.mode === "real" && isSell(moved) && cur.qty != null && cur.qty > 0) idb.confirmReal(core.db, userId, moved.id, moved.rev, cur.qty, now);
        else idb.deleteConfirm(core.db, userId, moved.id);
      } else {
        idb.insertRule(core.db, {
          id: newId("ir"),
          user_id: userId,
          ...i.after,
          action: "notify",
          conditions_json: null,
          state: "armed",
          hit_at: null,
          hit_seq: 0,
          cleared_at: null,
          paused_at: null,
          seen_slot: null,
          real_confirmed_at: null,
          rev: 1,
          created_by: "proposal",
          created_at: now,
          updated_at: now,
        });
      }
    }
    return settle(core, cur, "applied", now);
  });
  if (outcome === "decided") return fail(cardOf(proposalRow(core, userId, r.id)!));
  if (outcome === "stale") {
    const card = settle(core, r, "stale", now);
    syncCards(core, userId, card);
    return fail(card);
  }
  syncCards(core, userId, outcome);
  for (const i of items) if (i.ruleId) core.invest.ruleChanged(userId, i.ruleId, !!i.remove);
  await core.invest.publish(userId);
  return outcome;
}

/** the messages showing the card get its new state; the disclaimer stays where the message had it */
export function syncCards(core: Core, userId: string, card: InvestRuleChangeCard): number {
  const threads = new Set<string>();
  let n = 0;
  for (const row of core.db.messagesWithCard(userId, "invest_rule_change")) {
    const cards = safeJson<Card[]>(row.cards_json, []);
    let changed = false;
    const next = cards.map((c): Card => {
      if (c.type !== "invest_rule_change" || c.proposalId !== card.proposalId) return c;
      changed = true;
      const { disclaimer: _drop, ...rest } = card;
      return c.disclaimer ? { ...rest, disclaimer: true } : rest;
    });
    if (!changed) continue;
    core.db.updateMessageCards(row.id, next);
    publishMessage(core, row.id);
    threads.add(row.thread_id);
    n++;
  }
  for (const t of threads) publishThread(core, t);
  return n;
}

/**
 * A turn's cards as stored (turns.ts, at the insert): each proposal card as its row has it now (the person may have
 * decided while the turn was still running), and the A17 line on the message's last invest card only (DD 1935 §2).
 */
export function settleInvestCards(core: Core, userId: string, cards: Card[]): Card[] {
  const out = cards.map((c): Card => {
    if (c.type !== "invest_rule_change") return c;
    const r = proposalRow(core, userId, c.proposalId);
    return r ? cardOf(r) : c;
  });
  let last = -1;
  out.forEach((c, i) => {
    if (c.type.startsWith("invest_")) last = i;
  });
  return out.map((c, i): Card => {
    if (!c.type.startsWith("invest_")) return c;
    const { disclaimer: _drop, ...rest } = c as Card & { disclaimer?: true };
    return (i === last ? { ...rest, disclaimer: true } : rest) as Card;
  });
}

/** the 30-second beat: pending proposals past their time become "expired" on their cards */
export function expireProposals(core: Core, now: number): number {
  const due = core.db.sql.query("SELECT * FROM invest_proposals WHERE status = 'pending' AND expires_at <= $now LIMIT 50").all({ now }) as ProposalRow[];
  for (const r of due) syncCards(core, r.user_id, settle(core, r, "expired", now));
  return due.length;
}

/** POST /api/invest/proposals/:id {decision: "apply" | "keep"} → {card} (screens-chat 0119 → agent-runtime 0221) */
export function proposalRoutes(core: Core) {
  return {
    decide: async (c: Ctx, userId: string) => {
      const body = await readJson<{ decision?: unknown }>(c.req);
      return json({ card: await decideProposal(core, userId, c.params.id, body.decision) });
    },
  };
}
