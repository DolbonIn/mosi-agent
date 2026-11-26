/**
 * The invest hub (agent-runtime 2006 §4–§6, 2052): the overview and its `invest` event, the 5-minute watch, alerts,
 * mock stop records, invest calls and the Toss status. One per app (`core.invest`). No model call anywhere here.
 */
import type { InvestCall, InvestOverview, InvestRuleRow, InvestSettingsView, InvestSymbolDetail, InvestSymbolRow, InvestTossStatus, InvestWatch } from "@pickle/protocol";
import { atr, atText, num, pct, shares, type Bar } from "@pickle/quant";
import { publishMessage, publishThread, type Core } from "../core.ts";
import { errInfo } from "../log.ts";
import { dial, myPhoneView, PHONE_TOOL_TIMEOUT_MS, readMyPhone } from "../phone.ts";
import { kstDate, kstParts, kstToEpoch } from "../kst.ts";
import { newId } from "../util.ts";
import { currentSlot, marketDate, marketDaysAfter, nextMarketDayStart, prevSlot, type Market, type Slot } from "./calendar.ts";
import {
  alertBanner,
  alertCallLine,
  alertCard,
  BLIND_BANNER,
  BLIND_PUSH_TITLE,
  callText,
  expiredBanner,
  expiredCallLine,
  expiredCard,
  mockStopCard,
  stopBanner,
  stopCallLine,
  type Holding,
  type Observation,
} from "./cards.ts";
import * as idb from "./db.ts";
import {
  actionText,
  bufferFoot,
  bufferPct,
  bufferPrice,
  dedupeKey,
  DEFAULT_BUFFER_PCT,
  expiresAt,
  INVEST_CALLS_PER_DAY,
  judge,
  money,
  moneyNum,
  pctNum,
  ruleLeft,
  stateFoot,
  stateText,
  step,
  stopBasis,
} from "./rules.ts";
import { cachedGet, parseYahooDaily, parseYahooQuote, SourceGate, SOURCE_TABLE, yahooUrl, type Quote, type SourceKey } from "./sources.ts";
import { TossClient, type TossErrorCode, type TossHolding } from "./toss.ts";

export const DEFAULT_CALLS = { stopResult: true, stage: false, expiry: false } as const;
/** quotes missing this long during the session = blind (2006 §3) */
export const BLIND_AFTER_MS = 15 * 60_000;
/** the last computed ATR14 serves this many market days after its bars (team-lead 2052 answer) */
export const ATR_KEEP_DAYS = 5;
export const QUOTE_CACHE_MS = 4 * 60_000;
export const TOSS_CHECK_FLOOR_MS = 60_000;
const PERIOD = "가격 규칙은 개장 15분 뒤부터 마감까지 5분마다 확인해요.";

export const TOSS_ERROR_TEXT: Readonly<Record<Exclude<TossErrorCode, "not_connected">, string>> = {
  auth: "토스증권 연결이 끊겼어요",
  ip_not_allowed: "토스증권이 접속을 막았어요(허용 IP)",
  rate_limited: "토스증권이 잠시 요청을 막았어요",
  down: "토스증권에 연결하지 못했어요",
  off: "이 서버는 토스증권에 연결하지 않아요",
};

export function marketOf(symbol: string): Market {
  return /^\d{6}$/.test(symbol) ? "KR" : "US";
}

function kstDayStart(now: number): number {
  const p = kstParts(now);
  return kstToEpoch(p.year, p.month, p.day, 0, 0);
}

const kstDayKey = (now: number): string => kstDate(now);

export class InvestHub {
  readonly gate: SourceGate;
  readonly toss: TossClient;
  private sent = new Map<string, string>();
  private holdingsByUser = new Map<string, { at: number; list: TossHolding[] }>();
  private ranSlots = new Set<string>();
  private ticking: Promise<{ slots: number; alerts: number }> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private core: Core) {
    const f = core.deps.investFetch ?? fetch;
    this.gate = new SourceGate(core, f);
    this.toss = new TossClient(core, f);
  }

  /** the 30-second clock; a check runs once per slot (calendar.ts) */
  start(): void {
    this.timer ??= setInterval(() => void this.tick().catch((err) => this.core.log.error("invest tick failed", { err: errInfo(err) })), 30_000);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.ticking?.catch(() => undefined);
  }

  // ───────────────────────────── settings and views ─────────────────────────────

  calls(s: idb.InvestSettingsRow): InvestSettingsView["calls"] {
    let v: Record<string, unknown> = {};
    try {
      v = JSON.parse(s.calls_json) as Record<string, unknown>;
    } catch {
      v = {};
    }
    const b = (k: keyof typeof DEFAULT_CALLS) => (typeof v[k] === "boolean" ? (v[k] as boolean) : DEFAULT_CALLS[k]);
    return { stopResult: b("stopResult"), stage: b("stage"), expiry: b("expiry") };
  }

  callBlock(userId: string): InvestSettingsView["callBlock"] {
    if (!this.core.cfg.twilio) return "not_configured";
    const phone = readMyPhone(this.core, userId);
    return phone?.verifiedAt ? null : "not_verified";
  }

  async tossStatus(userId: string, s: idb.InvestSettingsRow): Promise<InvestTossStatus> {
    const base = this.toss.base();
    const connected = base ? await this.toss.connected(userId) : false;
    let error: InvestTossStatus["error"] = null;
    if (!base) error = { code: "off", at: s.updated_at, text: TOSS_ERROR_TEXT.off };
    else if (connected && s.toss_error && s.toss_error in TOSS_ERROR_TEXT)
      error = { code: s.toss_error as Exclude<TossErrorCode, "not_connected" | "off">, at: s.toss_error_at ?? s.updated_at, text: TOSS_ERROR_TEXT[s.toss_error as keyof typeof TOSS_ERROR_TEXT] };
    return { connected, okAt: connected ? s.toss_ok_at : null, checkedAt: s.toss_checked_at, outboundIp: this.core.cfg.invest.outboundIp, error };
  }

  async settingsView(userId: string): Promise<InvestSettingsView> {
    const s = idb.ensureSettings(this.core.db, userId, this.core.now());
    const toss = await this.tossStatus(userId, s);
    const blockers: InvestSettingsView["realBlockers"] = [];
    if (!this.toss.base()) blockers.push("toss_off");
    else if (!toss.connected) blockers.push("toss_not_connected");
    else {
      if (!toss.okAt) blockers.push("toss_never_ok");
      if (toss.error?.code === "ip_not_allowed") blockers.push("toss_ip_blocked");
    }
    return {
      mode: s.mode,
      ...(s.mode === "real" && s.real_since ? { realSince: s.real_since } : {}),
      toss,
      calls: this.calls(s),
      callBlock: this.callBlock(userId),
      phone: myPhoneView(readMyPhone(this.core, userId)),
      openOrders: idb.openOrders(this.core.db, userId),
      realBlockers: blockers,
    };
  }

  holding(userId: string, symbol: string): Holding | null {
    const h = this.holdingsByUser.get(userId)?.list.find((x) => x.symbol === symbol);
    return h && h.qty > 0 ? { qty: h.qty, avgPrice: h.avgPrice } : null;
  }

  ruleRow(r: idb.RuleRow, mode: "mock" | "real"): InvestRuleRow {
    const m = marketOf(r.symbol);
    const row: InvestRuleRow = {
      id: r.id,
      symbol: r.symbol,
      rev: r.rev,
      kind: r.kind,
      ...(r.level ? { level: r.level as 1 | 2 | 3 } : {}),
      ...(r.price != null ? { price: moneyNum(m, r.price) } : {}),
      ...(r.lo != null ? { lo: moneyNum(m, r.lo) } : {}),
      ...(r.hi != null ? { hi: moneyNum(m, r.hi) } : {}),
      direction: r.direction,
      action: r.action,
      until: r.until_day,
      ...(r.once ? { once: true as const } : {}),
      state: r.state,
      ...(r.state === "hit" && r.hit_at ? { hitAt: r.hit_at } : {}),
      ...(r.state === "paused" && r.paused_at ? { pausedAt: r.paused_at } : {}),
      left: ruleLeft(m, r),
      actionText: actionText(r.action, mode),
      stateText: stateText(r, r.until_day),
    };
    if (r.kind === "stop" && r.price != null) {
      const p = bufferPct(r);
      row.buffer = moneyNum(m, bufferPrice(m, r.price, p));
      row.bufferPct = { v: p, text: `${num(p)}%`, unit: "pct" };
      row.bufferDefault = r.buffer_pct == null;
    }
    const foot = stateFoot(r);
    if (foot) row.stateFoot = foot;
    return row;
  }

  symbolRow(userId: string, w: idb.WatchRow, q: idb.QuoteRow | undefined, stale: boolean): InvestSymbolRow {
    const m = w.market;
    const h = this.holding(userId, w.symbol);
    const price = q ? moneyNum(m, q.price) : null;
    const change = q && q.prev_close && q.prev_close > 0 ? pctNum((q.price / q.prev_close - 1) * 100) : null;
    let holding: InvestSymbolRow["holding"] = null;
    if (h && q && h.avgPrice && h.avgPrice > 0) {
      const vs = (q.price / h.avgPrice - 1) * 100;
      holding = { qty: { v: h.qty, text: shares(h.qty), unit: "qty" }, vsAvg: pctNum(vs), line: `보유 ${shares(h.qty)} · 평단 대비 ${pct(vs)}` };
    } else if (h) {
      holding = { qty: { v: h.qty, text: shares(h.qty), unit: "qty" }, vsAvg: pctNum(null), line: `보유 ${shares(h.qty)}` };
    }
    return { symbol: w.symbol, name: w.name, market: m, price, change, holding, ...(stale && q ? { stale: true as const } : {}) };
  }

  /** a quote source this person has: public sources on, or Toss on with their key saved */
  async hasSource(userId: string): Promise<boolean> {
    return this.gate.enabled() || (!!this.toss.base() && (await this.toss.connected(userId)));
  }

  watchState(s: idb.InvestSettingsRow, now: number, liveRules: idb.RuleRow[], anySource: boolean): InvestWatch {
    if (!anySource) return { state: "off", text: "지금은 시세를 받지 않아요" };
    if (s.blind_since && now - s.blind_since >= BLIND_AFTER_MS) {
      const realSell = s.mode === "real" && liveRules.some((r) => r.kind === "stop" && r.action === "sell");
      const clock = atText(s.blind_since, now);
      return {
        state: "blind",
        since: s.blind_since,
        tone: realSell ? "danger" : "caution",
        text: `시세를 받지 못하고 있어요 · ${clock}부터`,
        foot: `시세 ${clock} 기준 · 마지막으로 받은 값이에요. 시세가 돌아오면 다시 확인해요. 그동안 손절선 확인도 멈춰 있어요.`,
      };
    }
    const open = currentSlot("US", now) || currentSlot("KR", now);
    return open ? { state: "ok", text: "" } : { state: "closed", text: "" };
  }

  async overview(userId: string): Promise<InvestOverview> {
    const { core } = this;
    const now = core.now();
    const s = idb.ensureSettings(core.db, userId, now);
    const wl = idb.watchlist(core.db, userId);
    const qs = new Map(idb.quotes(core.db, userId).map((q) => [q.symbol, q]));
    const rs = idb.rules(core.db, userId);
    const live = rs.filter((r) => r.state === "armed" || r.state === "hit");
    const watch = this.watchState(s, now, live, await this.hasSource(userId));
    const blind = watch.state === "blind";
    const shown = wl.map((w) => qs.get(w.symbol)).filter((q): q is idb.QuoteRow => !!q);
    let quotesFoot: string;
    if (blind) quotesFoot = watch.foot!;
    else if (shown.length) {
      const latest = Math.max(...shown.map((q) => q.as_of));
      const names = [...new Set(shown.map((q) => SOURCE_TABLE[q.source as SourceKey]?.name ?? q.source))].join(" · ");
      quotesFoot = `시세 ${atText(latest, now)} 기준 · ${names}. ${PERIOD}`;
    } else quotesFoot = PERIOD;
    return {
      rev: s.rev,
      mode: s.mode,
      stages: null,
      watchlist: wl.map((w) => this.symbolRow(userId, w, qs.get(w.symbol), blind)),
      rules: rs.map((r) => this.ruleRow(r, s.mode)),
      reports: [],
      decks: [],
      settings: await this.settingsView(userId),
      quotesFoot,
      watch,
    };
  }

  /** Send `invest` to the person's devices when the overview changed since the last one sent (a new rev). */
  async publish(userId: string): Promise<void> {
    const { core } = this;
    const ov = await this.overview(userId);
    const body = JSON.stringify({ ...ov, rev: 0 });
    if (this.sent.get(userId) === body) return;
    // like settings and agent revs: raised to max(previous + 1, server clock), so never lowered by a restore
    const rev = Math.max(ov.rev + 1, core.now());
    idb.updateSettings(core.db, userId, { rev }, core.now());
    this.sent.set(userId, body);
    core.events.publish(userId, { type: "invest", rev, overview: { ...ov, rev } });
  }

  investRev(userId: string): number | undefined {
    return idb.getSettings(this.core.db, userId)?.rev;
  }

  async symbolDetail(userId: string, symbol: string): Promise<InvestSymbolDetail | null> {
    const { core } = this;
    const w = idb.watchRow(core.db, userId, symbol);
    if (!w) return null;
    const s = idb.ensureSettings(core.db, userId, core.now());
    const q = idb.quotes(core.db, userId).find((x) => x.symbol === symbol);
    const rs = idb.rules(core.db, userId, symbol);
    const blind = this.watchState(s, core.now(), rs, await this.hasSource(userId)).state === "blind";
    const bars = await this.dailyBars(symbol, w.market);
    const levels = rs.flatMap((r) =>
      r.kind === "buy_zone"
        ? [
            { kind: "buy_zone_lo", label: "매수 검토 아래", price: r.lo! },
            { kind: "buy_zone_hi", label: "매수 검토 위", price: r.hi! },
          ]
        : r.price != null
          ? [{ kind: r.kind, label: ruleLeft(w.market, r), price: r.price }]
          : [],
    );
    return {
      row: this.symbolRow(userId, w, q, blind),
      rules: rs.map((r) => this.ruleRow(r, s.mode)),
      alerts: idb.recentAlerts(core.db, userId, symbol).map((a) => ({ id: a.id, kind: a.kind, title: a.title, at: a.created_at, threadId: a.thread_id, messageId: a.message_id })),
      chart: bars ? { bars: bars.bars.slice(-260), levels, asOf: bars.bars.at(-1)!.t, source: { name: SOURCE_TABLE[bars.source].name, grade: SOURCE_TABLE[bars.source].grade, asOf: bars.bars.at(-1)!.t } } : null,
    };
  }

  // ───────────────────────────── market data ─────────────────────────────

  /**
   * daily bars (ATR for the stop basis, the symbol chart): Yahoo, tried once a day per symbol and shared by everyone; a
   * 429 or 403 rests Yahoo for the day. Toss's daily candles come in when its openapi.json is checked (agent-runtime
   * 2050-b). None → null: the stop is judged on intraday prices only (team-lead 2045 correction).
   */
  async dailyBars(symbol: string, market: Market): Promise<{ bars: Bar[]; source: SourceKey } | null> {
    const until = (now: number) => nextMarketDayStart(market, now);
    const y = await cachedGet(this.gate, this.core, "yahoo", yahooUrl(symbol, market, "1y"), until);
    if (!y.ok) return null;
    const bars = parseYahooDaily(y.text, (ms) => marketDate(market, ms));
    if (bars === null) this.gate.pauseForJunk("yahoo");
    return bars && bars.length ? { bars, source: "yahoo" } : null;
  }

  /** a Yahoo intraday quote (best effort; 4-minute shared cache) */
  async yahooQuote(symbol: string, market: Market): Promise<Quote | "not_found" | null> {
    const r = await cachedGet(this.gate, this.core, "yahoo", yahooUrl(symbol, market, "1d"), (now) => now + QUOTE_CACHE_MS);
    if (!r.ok) return null;
    const q = parseYahooQuote(r.text, symbol);
    if (q === null) this.gate.pauseForJunk("yahoo");
    return q;
  }

  /**
   * D5-2 basis and buffer for a stop at this moment. ATR14 from today's daily bars; without them the last one computed
   * (kept per symbol with its as_of, the last bar's day) for up to ATR_KEEP_DAYS market days; then none → intraday
   * (team-lead 2052 answer, 21:2x correction).
   */
  async stopContext(userId: string, symbol: string, stop: number, bufPct: number) {
    const { db } = this.core;
    const now = this.core.now();
    const market = marketOf(symbol);
    const key = `atr:${market}:${symbol}`;
    const bars = await this.dailyBars(symbol, market);
    let atr14: number | null = null;
    let close: number | null = null;
    let atrAsOf: string | null = null;
    if (bars) {
      const last = bars.bars[bars.bars.length - 1]!;
      const a = atr(bars.bars);
      close = last.c;
      atr14 = a.length ? (a[a.length - 1] ?? null) : null;
      if (atr14 != null) {
        atrAsOf = last.t;
        idb.cachePut(db, key, JSON.stringify({ atr: atr14, close, asOf: last.t }), now, now + 30 * 86_400_000);
      }
    } else {
      const kept = idb.cacheGet(db, key, now);
      const k = kept ? (JSON.parse(kept) as { atr: number; close: number; asOf: string }) : null;
      if (k && marketDaysAfter(market, k.asOf, marketDate(market, now)) <= ATR_KEEP_DAYS) {
        atr14 = k.atr;
        close = k.close;
        atrAsOf = k.asOf;
      }
    }
    const h = this.holding(userId, symbol);
    const ref = h?.avgPrice ?? close;
    const basis = stopBasis(atr14, stop, ref);
    return { basis, buffer: bufferPrice(market, stop, bufPct), atr14, atrAsOf };
  }

  // ───────────────────────────── Toss ─────────────────────────────

  private recordToss(userId: string, error: TossErrorCode | null, now: number): void {
    const { db } = this.core;
    if (!error) {
      idb.updateSettings(db, userId, { toss_ok_at: now, toss_error: null, toss_error_at: null, toss_paused_until: null }, now);
      return;
    }
    if (error === "not_connected" || error === "off") return;
    const pause = error === "ip_not_allowed" ? now + 3_600_000 : error === "rate_limited" ? now + 5 * 60_000 : null;
    idb.updateSettings(db, userId, { toss_error: error, toss_error_at: now, toss_paused_until: pause }, now);
    this.core.log.warn("invest toss error", { user: userId, code: error });
  }

  private tossUsable(s: idb.InvestSettingsRow, now: number): boolean {
    return !!this.toss.base() && !(s.toss_paused_until && s.toss_paused_until > now);
  }

  /** POST /api/invest/toss/check and after a key is saved: one holdings read. `floor`: refuse within a minute. */
  async checkToss(userId: string, opts: { floor: boolean }): Promise<"too_soon" | "done"> {
    const { core } = this;
    const now = core.now();
    const s = idb.ensureSettings(core.db, userId, now);
    if (opts.floor && s.toss_checked_at && now - s.toss_checked_at < TOSS_CHECK_FLOOR_MS) return "too_soon";
    idb.updateSettings(core.db, userId, { toss_checked_at: now, toss_paused_until: null }, now);
    if (this.toss.base()) {
      const r = await this.toss.holdings(userId);
      if (r.ok) this.holdingsByUser.set(userId, { at: now, list: r.value });
      this.recordToss(userId, r.ok ? null : r.error, now);
    }
    await this.publish(userId);
    return "done";
  }

  async onTossSaved(userId: string): Promise<void> {
    this.toss.forget(userId);
    await this.checkToss(userId, { floor: false });
  }

  /** the key was deleted: real orders back to mock at once, holdings forgotten */
  async onTossRemoved(userId: string): Promise<void> {
    const { core } = this;
    this.toss.forget(userId);
    this.holdingsByUser.delete(userId);
    const s = idb.getSettings(core.db, userId);
    if (s) idb.updateSettings(core.db, userId, { mode: "mock", real_since: null, toss_ok_at: null, toss_error: null, toss_error_at: null, toss_paused_until: null }, core.now());
    await this.publish(userId);
  }

  // ───────────────────────────── the watch ─────────────────────────────

  /** Run the check that is due now (US and KR), once per slot. Resolves when its alerts are stored. */
  tick(now = this.core.now()): Promise<{ slots: number; alerts: number }> {
    if (this.ticking) return this.ticking;
    this.ticking = this.runDue(now).finally(() => (this.ticking = null));
    return this.ticking;
  }

  private async runDue(now: number): Promise<{ slots: number; alerts: number }> {
    let slots = 0;
    let alerts = 0;
    for (const market of ["US", "KR"] as const) {
      const slot = currentSlot(market, now);
      if (!slot || this.ranSlots.has(slot.key)) continue;
      const marker = `watch:slot:${market}`;
      if (idb.cacheGet(this.core.db, marker, now) === slot.key) {
        this.ranSlots.add(slot.key);
        continue;
      }
      this.ranSlots.add(slot.key);
      idb.cachePut(this.core.db, marker, slot.key, now, now + 7 * 86_400_000);
      slots++;
      alerts += await this.runSlot(slot, now);
    }
    if (this.ranSlots.size > 500) this.ranSlots = new Set([...this.ranSlots].slice(-50));
    return { slots, alerts };
  }

  private async runSlot(slot: Slot, now: number): Promise<number> {
    let n = 0;
    const shared = new Map<string, Promise<Quote | "not_found" | null>>();
    for (const userId of idb.investUsers(this.core.db)) {
      try {
        n += await this.watchUser(userId, slot, now, shared);
      } catch (err) {
        this.core.log.error("invest watch failed", { user: userId, err: errInfo(err) });
      }
    }
    return n;
  }

  private async watchUser(userId: string, slot: Slot, now: number, shared: Map<string, Promise<Quote | "not_found" | null>>): Promise<number> {
    const { core } = this;
    const { db } = core;
    const wl = idb.watchlist(db, userId).filter((w) => w.market === slot.market);
    if (!wl.length) return 0;
    let s = idb.ensureSettings(db, userId, now);
    const all = idb.rules(db, userId).filter((r) => wl.some((w) => w.symbol === r.symbol));
    const live = all.filter((r) => r.state === "armed" || r.state === "hit");
    const got = new Map<string, Observation>();

    // Toss first (the person's key, every watched symbol in one call), then Yahoo for symbols with live rules
    if (this.tossUsable(s, now) && (await this.toss.connected(userId))) {
      const p = await this.toss.prices(userId, wl.map((w) => w.symbol));
      if (p.ok) for (const q of p.value) got.set(q.symbol, { price: q.price, prevClose: q.prevClose, at: q.at, source: "toss" });
      let err: TossErrorCode | null = p.ok ? null : p.error;
      if (p.ok && live.some((r) => r.kind === "stop")) {
        const h = await this.toss.holdings(userId);
        if (h.ok) this.holdingsByUser.set(userId, { at: now, list: h.value });
        else err = h.error;
      }
      this.recordToss(userId, err, now);
    }
    for (const sym of new Set(live.map((r) => r.symbol))) {
      if (got.has(sym)) continue;
      let pending = shared.get(sym);
      if (!pending) shared.set(sym, (pending = this.yahooQuote(sym, slot.market)));
      const q = await pending;
      if (q && q !== "not_found") got.set(sym, { price: q.price, prevClose: q.prevClose, at: q.at, source: "yahoo" });
    }
    for (const [symbol, o] of got) idb.putQuote(db, { user_id: userId, symbol, price: o.price, prev_close: o.prevClose, source: o.source, as_of: o.at, fetched_at: now });

    // blind: live rules and no quote for any of their symbols, for 15 minutes of the session (2006 §3, DD 2010 §7)
    const anySource = await this.hasSource(userId);
    const ruleSymbols = new Set(live.map((r) => r.symbol));
    const seenAny = [...ruleSymbols].some((x) => got.has(x));
    if (anySource && ruleSymbols.size && !seenAny) {
      if (!s.blind_since) idb.updateSettings(db, userId, { blind_since: slot.at }, now);
    } else if (s.blind_since) idb.updateSettings(db, userId, { blind_since: null }, now);
    s = idb.getSettings(db, userId)!;
    if (s.blind_since && now - s.blind_since >= BLIND_AFTER_MS && s.blind_banner_day !== kstDayKey(now)) {
      idb.updateSettings(db, userId, { blind_banner_day: kstDayKey(now) }, now);
      core.events.publish(userId, { type: "notification", ...BLIND_BANNER(s.blind_since), icon: "chart" });
      core.track(core.push.send(userId, { title: BLIND_PUSH_TITLE, tag: "invest:blind" }));
    }

    const prev = prevSlot(slot);
    let alerts = 0;
    for (const r0 of live) {
      const r = idb.rule(db, userId, r0.id);
      if (!r || (r.state !== "armed" && r.state !== "hit")) continue;
      const o = got.get(r.symbol);
      if (o) {
        let basis: "close_and_intraday" | "intraday" = "intraday";
        let buffer: number | null = null;
        let atrSeen: { value: number; asOf: string } | null = null;
        if (r.kind === "stop") {
          const c = await this.stopContext(userId, r.symbol, r.price!, bufferPct(r));
          basis = c.basis;
          buffer = c.buffer;
          atrSeen = c.atr14 != null && c.atrAsOf ? { value: c.atr14, asOf: c.atrAsOf } : null;
        }
        const j = judge(r, o.price, slot.close, basis, buffer);
        const st = step(r, r, j, slot.key, prev?.key ?? null, now);
        if (st.alert) {
          if (await this.fire(userId, r, st, o, slot, now, { kind: r.kind, atr: atrSeen })) alerts++;
        } else idb.updateRuleWatch(db, r.id, r.rev, st.next, now);
      }
      const after = idb.rule(db, userId, r.id);
      if (after && (after.state === "armed" || after.state === "hit") && expiresAt(after, slot.day, slot.close)) {
        if (await this.expire(userId, after, slot, now)) alerts++;
      }
    }
    await this.publish(userId);
    return alerts;
  }

  // ───────────────────────────── alerts ─────────────────────────────

  private ensureThread(userId: string): string {
    const { core } = this;
    const s = idb.ensureSettings(core.db, userId, core.now());
    const existing = s.thread_id ? core.db.threadFor(s.thread_id, userId) : null;
    if (existing) return existing.id;
    const user = core.db.userById(userId)!;
    const id = newId("t");
    core.db.createThread({ id, ownerId: userId, kind: "schedule", title: "투자", subtitle: `${user.agent_name}의 투자 알림`, icon: "chart", now: core.now() }, [userId]);
    idb.updateSettings(core.db, userId, { thread_id: id }, core.now());
    return id;
  }

  /** store the card row in the invest thread, push it and its banner; returns the row id */
  private post(userId: string, card: Parameters<Core["db"]["insertMessage"]>[0]["cards"] extends (infer C)[] | undefined ? C : never, record: string, banner: { title: string; body: string }, ruleId: string): { threadId: string; messageId: string } {
    const { core } = this;
    const threadId = this.ensureThread(userId);
    const messageId = newId("m");
    const now = core.now();
    core.db.insertMessage({ id: messageId, threadId, role: "assistant", text: "", cards: [card], llm: [{ role: "assistant", content: record }], createdAt: now });
    core.db.setUnread(threadId, userId, true);
    core.db.touchThread(threadId, now, banner.title);
    publishMessage(core, messageId);
    publishThread(core, threadId);
    core.events.publish(userId, { type: "notification", title: banner.title, body: banner.body, threadId, messageId, icon: "chart" });
    // the lock screen gets the banner's title alone (DD 2042-b §4: symbol and event, no amount); one tag per rule
    core.track(core.push.send(userId, { title: banner.title, tag: `invest:${ruleId}`, threadId, messageId }));
    return { threadId, messageId };
  }

  /** one invest call: blocked (not configured / not verified), over the day's 10, or dialled */
  private async call(userId: string, ref: string, line: string): Promise<InvestCall> {
    const { core } = this;
    const now = core.now();
    const block = this.callBlock(userId);
    if (block) return callText({ ok: false, at: now, reason: block });
    if (idb.callsSince(core.db, userId, kstDayStart(now)) >= INVEST_CALLS_PER_DAY) return callText({ ok: false, at: now, reason: "daily_limit" });
    const phone = readMyPhone(core, userId)!;
    idb.insertCall(core.db, { id: newId("ic"), user_id: userId, ref, state: "dialing", at: now });
    const out = await dial(core, { to: phone.e164, message: line, signal: AbortSignal.timeout(PHONE_TOOL_TIMEOUT_MS) });
    return out.ok ? callText({ ok: true, at: core.now() }) : callText({ ok: false, at: core.now(), reason: out.error === "phone_not_configured" ? "not_configured" : "failed" });
  }

  /** after the row is stored: the call (in the background), then the card with its call line */
  private callLater(userId: string, messageId: string, ref: string, line: string, onCall?: (c: InvestCall) => void): void {
    const { core } = this;
    core.track(
      (async () => {
        const c = await this.call(userId, ref, line);
        onCall?.(c);
        const row = core.db.getMessage(messageId);
        if (!row) return;
        const cards = JSON.parse(row.cards_json) as { type: string }[];
        core.db.updateMessageCards(messageId, cards.map((x) => (x.type === "invest_alert" || x.type === "invest_stop" ? { ...x, call: c } : x)) as never);
        publishMessage(core, messageId);
      })(),
    );
  }

  private async fire(userId: string, r: idb.RuleRow, st: ReturnType<typeof step>, o: Observation, slot: Slot, now: number, stopAtr?: { kind: string; atr: { value: number; asOf: string } | null }): Promise<boolean> {
    const { core } = this;
    const { db } = core;
    const s = idb.ensureSettings(db, userId, now);
    const market = marketOf(r.symbol);
    // real mode and no ATR: the stop was judged on intraday prices alone, and the card says so (no silent change)
    const intradayOnly = s.mode === "real" && stopAtr?.kind === "stop" && !stopAtr.atr;
    const key = dedupeKey(r.id, r.rev, st.next.hit_seq);
    const alertId = newId("ia");
    const sellStop = r.kind === "stop" && r.action === "sell";
    const user = db.userById(userId);
    const agentName = user?.agent_name ?? "모시";
    // the alert row and the rule's new state together: a second run that overlaps finds the key used and sends nothing
    const fresh = db.tx(() => {
      // the person changed the rule meanwhile (a PATCH between the read and now): this check's result is not theirs
      const cur = idb.rule(db, userId, r.id);
      if (!cur || cur.rev !== r.rev || cur.hit_seq !== r.hit_seq || (cur.state !== "armed" && cur.state !== "hit")) return false;
      const ok = idb.insertAlert(db, {
        id: alertId,
        user_id: userId,
        rule_id: r.id,
        symbol: r.symbol,
        kind: sellStop ? "stop_record" : r.kind,
        dedupe_key: key,
        price: o.price,
        observed_at: o.at,
        source: o.source,
        title: "",
        thread_id: null,
        message_id: null,
        call_state: null,
        called_at: null,
        created_at: now,
      });
      if (ok) idb.updateRuleWatch(db, r.id, r.rev, st.next, now);
      return ok;
    });
    if (!fresh) return false;
    idb.ledgerPut(db, {
      userId,
      id: `quote.${r.symbol}`,
      asOf: new Date(o.at).toISOString(),
      value: o.price,
      unit: market === "US" ? "usd" : "krw",
      definition: slot.close ? "마감 뒤 확인 가격" : "5분 감시 가격",
      source: SOURCE_TABLE[o.source].name,
      url: null,
      confidence: SOURCE_TABLE[o.source].grade,
      now,
    });
    // the ATR behind a stop's basis, with the day of its last bar (a kept one is up to ATR_KEEP_DAYS market days old)
    if (stopAtr?.atr)
      idb.ledgerPut(db, {
        userId,
        id: `atr14.${r.symbol}`,
        asOf: stopAtr.atr.asOf,
        value: stopAtr.atr.value,
        unit: market === "US" ? "usd" : "krw",
        definition: "ATR14 (일봉 14일 평균 실제 범위)",
        source: SOURCE_TABLE.yahoo.name,
        url: null,
        confidence: SOURCE_TABLE.yahoo.grade,
        now,
      });
    if (sellStop) {
      let qty: number | null = null;
      if (this.tossUsable(s, now) && (await this.toss.connected(userId))) {
        const q = await this.toss.sellable(userId, r.symbol);
        qty = q.ok ? q.value : null;
        if (!q.ok) this.recordToss(userId, q.error, now);
      }
      const orderId = newId("io");
      const h = this.holding(userId, r.symbol);
      const card = mockStopCard({ orderId, ruleId: r.id, rule: r, market, obs: o, now, qty, avgPrice: h?.avgPrice ?? null, intradayOnly });
      idb.insertOrder(db, {
        id: orderId,
        user_id: userId,
        rule_id: r.id,
        symbol: r.symbol,
        mode: "mock",
        client_order_id: key,
        toss_order_id: null,
        state: card.state,
        qty,
        filled_qty: null,
        avg_price: null,
        observed_price: o.price,
        stop_price: r.price!,
        reason: card.reason?.code ?? null,
        message_id: null,
        created_at: now,
        updated_at: now,
      });
      const banner = stopBanner(r, market, card);
      const record = `[투자 기록] ${r.symbol} 모의 손절 · ${card.title} · 관측 ${money(market, o.price)} · 손절선 ${money(market, r.price!)} · ${card.foot}`;
      const { threadId, messageId } = this.post(userId, card, record, banner, r.id);
      idb.setAlertMessage(db, alertId, threadId, messageId);
      db.sql.query("UPDATE invest_alerts SET title = $t WHERE id = $id").run({ id: alertId, t: banner.title });
      idb.setOrderMessage(db, orderId, messageId, now);
      if (this.calls(s).stopResult) this.callLater(userId, messageId, orderId, stopCallLine(agentName, r, market, card, o.price, h), (c) => idb.setAlertCall(db, alertId, c.ok ? "ok" : c.reason, c.at));
      return true;
    }
    const next = r.kind === "target" && r.level ? idb.rules(db, userId, r.symbol).find((x) => x.kind === "target" && x.level === r.level! + 1 && x.price != null) : undefined;
    const input = {
      alertId,
      ruleId: r.id,
      rule: r,
      market,
      mode: s.mode,
      obs: o,
      now,
      holding: this.holding(userId, r.symbol),
      noPrior: st.noPrior,
      paused: st.next.state === "paused",
      nextTarget: next ? { level: next.level!, price: next.price! } : null,
      stopPrice: idb.rules(db, userId, r.symbol).find((x) => x.kind === "stop" && x.price != null)?.price ?? null,
      intradayOnly,
    };
    const card = alertCard(input);
    const banner = alertBanner(input);
    const record = `[투자 알림] ${card.title}${card.titleLines?.length ? ` (${card.titleLines.join(" ")})` : ""} · ${card.price?.text ?? ""} · ${card.sub ?? ""} · ${card.foot}`;
    const { threadId, messageId } = this.post(userId, card, record, banner, r.id);
    idb.setAlertMessage(db, alertId, threadId, messageId);
    db.sql.query("UPDATE invest_alerts SET title = $t WHERE id = $id").run({ id: alertId, t: card.title });
    if (r.action === "call") this.callLater(userId, messageId, alertId, alertCallLine(agentName, input), (c) => idb.setAlertCall(db, alertId, c.ok ? "ok" : c.reason, c.at));
    return true;
  }

  private async expire(userId: string, r: idb.RuleRow, slot: Slot, now: number): Promise<boolean> {
    const { core } = this;
    const { db } = core;
    const s = idb.ensureSettings(db, userId, now);
    const market = marketOf(r.symbol);
    const alertId = newId("ia");
    const fresh = db.tx(() => {
      const cur = idb.rule(db, userId, r.id);
      if (!cur || cur.rev !== r.rev || (cur.state !== "armed" && cur.state !== "hit")) return false;
      const ok = idb.insertAlert(db, {
        id: alertId,
        user_id: userId,
        rule_id: r.id,
        symbol: r.symbol,
        kind: "expired",
        dedupe_key: `${r.id}:${r.rev}:expired`,
        price: null,
        observed_at: now,
        source: "calendar",
        title: "",
        thread_id: null,
        message_id: null,
        call_state: null,
        called_at: null,
        created_at: now,
      });
      if (ok) idb.updateRuleWatch(db, r.id, r.rev, { state: "expired", hit_at: r.hit_at, hit_seq: r.hit_seq, cleared_at: r.cleared_at, paused_at: r.paused_at, seen_slot: slot.key }, now);
      return ok;
    });
    if (!fresh) return false;
    const card = expiredCard({ alertId, ruleId: r.id, rule: r, market, mode: s.mode, createdAt: r.created_at, at: now, now });
    const banner = expiredBanner(r, market);
    const { threadId, messageId } = this.post(userId, card, `[투자 알림] ${card.title} · ${card.titleLines![0]}`, banner, r.id);
    idb.setAlertMessage(db, alertId, threadId, messageId);
    db.sql.query("UPDATE invest_alerts SET title = $t WHERE id = $id").run({ id: alertId, t: card.title });
    if (this.calls(s).expiry) this.callLater(userId, messageId, alertId, expiredCallLine(core.db.userById(userId)?.agent_name ?? "모시", r), (c) => idb.setAlertCall(db, alertId, c.ok ? "ok" : c.reason, c.at));
    return true;
  }

  /** the rule preview's figures (routes.ts builds the sentence) */
  async previewContext(userId: string, symbol: string) {
    const market = marketOf(symbol);
    const q = idb.quotes(this.core.db, userId).find((x) => x.symbol === symbol);
    const s = idb.ensureSettings(this.core.db, userId, this.core.now());
    return { market, price: q?.price ?? null, mode: s.mode, holding: this.holding(userId, symbol), callBlock: this.callBlock(userId) };
  }

  /** for the B1 tests and the buffer foot */
  static bufferFoot = bufferFoot;
  static DEFAULT_BUFFER_PCT = DEFAULT_BUFFER_PCT;
}

