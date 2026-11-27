/**
 * The invest hub (agent-runtime 2006 §4–§6, 2052): the overview and its `invest` event, the 5-minute watch, alerts,
 * mock stop records, invest calls and the Toss status. One per app (`core.invest`). The one model call is the daily
 * report's words (report.ts, B2c-1), at most two per person and day.
 */
import type { InvestCall, InvestOverview, InvestRuleRow, InvestSettingsView, InvestSymbolDetail, InvestSymbolRow, InvestTossStatus, InvestWatch } from "@pickle/protocol";
import { atr, atText, num, pct, shares, type Bar } from "@pickle/quant";
import { publishMessage, publishThread, settingsOf, type Core } from "../core.ts";
import { errInfo } from "../log.ts";
import { dial, myPhoneView, PHONE_TOOL_TIMEOUT_MS, readMyPhone } from "../phone.ts";
import { kstDate, kstParts, kstToEpoch } from "../kst.ts";
import { newId } from "../util.ts";
import {
  currentSlot,
  dailyUntil,
  dayFromToss,
  finishedBars,
  marketClock,
  marketDate,
  marketDay,
  marketDaysAfter,
  marketOf,
  prevSlot,
  type DayInfo,
  type DayOverride,
  type Market,
  type Slot,
} from "./calendar.ts";
import { claimReminder, dueReminders, eventCard, eventRecord, noteReminderMessage } from "./events.ts";
import { writeLedger } from "./ledger.ts";
import { expireProposals } from "./proposals.ts";
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
  gapBanner,
  gapCard,
  mockStopCard,
  runBanner,
  runCard,
  splitBanner,
  splitCard,
  stopBanner,
  stopCallLine,
  type Holding,
  type Observation,
} from "./cards.ts";
import * as idb from "./db.ts";
import { gapOf, runAbove, splitOf, type Gap, type Run, type Split } from "./intraday.ts";
import {
  actionText,
  bufferFoot,
  bufferPct,
  bufferPrice,
  callNote,
  dedupeKey,
  DEFAULT_BUFFER_PCT,
  expiresAt,
  INVEST_CALLS_PER_DAY,
  judge,
  money,
  moneyNum,
  pctNum,
  priorReason,
  ruleLeft,
  SEEN_SPLIT,
  stateFoot,
  stateText,
  step,
  stopBasis,
} from "./rules.ts";
import {
  assemble,
  buildReport,
  claimReport,
  dueReports,
  eventLines,
  eventRowsAhead,
  judgmentOf,
  lastSent,
  markSent,
  readMarket,
  recentReports,
  reportHoldsReminders,
  reportRecord,
  retakeReport,
  staleMaking,
  takeCall,
  writeWords,
  type EtfInput,
  type MarketRead,
  type Stored,
} from "./report.ts";
import { judgeDay, stageCallText, stageRowText, stagesView, type JudgmentRow } from "./stages.ts";
import { cachedGet, parseYahooDaily, parseYahooQuote, SourceGate, SOURCE_TABLE, yahooUrl, type Quote, type SourceKey } from "./sources.ts";
import { TossClient, type TossErrorCode, type TossHolding } from "./toss.ts";

export const DEFAULT_CALLS = { stopResult: true, stage: false, expiry: false } as const;
/** quotes missing this long during the session = blind (2006 §3) */
export const BLIND_AFTER_MS = 15 * 60_000;
/** a person's Toss calendar or daily read that failed is asked again after this long (one a market day when it works) */
export const TOSS_DAILY_RETRY_MS = 60 * 60_000;
/** how long "is Toss connected" is remembered between 30-second ticks (a vault read otherwise) */
const CONNECTED_MEMO_MS = 5 * 60_000;
/** a person's Toss calendar answer is kept this long (prevSlot looks back up to 15 days; the gap check needs 10) */
const CALENDAR_KEEP_MS = 10 * 86_400_000;

/** the person's own Toss reads (team-lead 2253): the key carries the person, so nobody else's watch reads them */
const calKey = (userId: string, market: Market, day: string) => `cal:toss:${userId}:${market}:${day}`;
const tossBarsKey = (userId: string, market: Market, symbol: string) => `bars:toss:${userId}:${market}:${symbol}`;
const tossAtrKey = (userId: string, market: Market, symbol: string) => `atr:toss:${userId}:${market}:${symbol}`;
/** what the log says of a day: "09:30-16:00" (market clock), "closed" or "unknown" */
const daySays = (market: Market, d: DayInfo) => (d.kind === "open" ? `${marketClock(market, d.session.open)}-${marketClock(market, d.session.close)}` : d.kind);

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
  off: "지금은 토스증권에 연결할 수 없어요",
};

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
  /** per person and key: when a Toss calendar or daily read was last asked and failed */
  private tossTried = new Map<string, number>();
  private connectedMemo = new Map<string, { at: number; v: boolean }>();
  private ticking: Promise<{ slots: number; alerts: number }> | null = null;
  private reminding: Promise<number> | null = null;
  private judging: Promise<number> | null = null;
  private reporting: Promise<number> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private core: Core) {
    const f = core.deps.investFetch ?? fetch;
    this.gate = new SourceGate(core, f);
    this.toss = new TossClient(core, f);
  }

  /** the 30-second clock; a check runs once per slot (calendar.ts) */
  start(): void {
    this.timer ??= setInterval(() => void this.beat(), 30_000);
  }

  /** one beat of the clock: the watch's slot when one is due, the D-1 reminders, and proposals past their time */
  async beat(now = this.core.now()): Promise<void> {
    try {
      expireProposals(this.core, now);
    } catch (err) {
      this.core.log.error("invest proposal expiry failed", { err: errInfo(err) });
    }
    await Promise.all([
      this.tick(now).catch((err) => this.core.log.error("invest tick failed", { err: errInfo(err) })),
      this.remindEvents(now).catch((err) => this.core.log.error("invest D-1 failed", { err: errInfo(err) })),
      this.judgeStages(now)
        .catch((err) => this.core.log.error("invest stages failed", { err: errInfo(err) }))
        .then(() => this.sendReports(now))
        .catch((err) => this.core.log.error("invest report failed", { err: errInfo(err) })),
    ]);
  }

  /** after the day's readings: each person's 08:00 report whose row is not taken yet (report.ts; one run at a time) */
  sendReports(now = this.core.now()): Promise<number> {
    if (this.reporting) return this.reporting;
    this.reporting = this.makeReports(now).finally(() => (this.reporting = null));
    return this.reporting;
  }

  private async makeReports(now: number): Promise<number> {
    const { core } = this;
    if (!core.cfg.invest.sources) return 0;
    const stale = staleMaking(core, now);
    const due = dueReports(core, now);
    if (!stale.length && !due.length) return 0;
    const read = await readMarket(core);
    let n = 0;
    const one = async (id: string, row: JudgmentRow) => {
      try {
        if (await this.makeReport(id, row, read, now)) n++;
      } catch (err) {
        core.log.error("invest report failed", { user: row.user_id, err: errInfo(err) });
      }
    };
    for (const r of stale) {
      const row = judgmentOf(core, r.user_id, r.day);
      if (row && retakeReport(core, r, now)) await one(r.id, row);
    }
    for (const row of due) {
      const id = newId("ir");
      // the row first: a second run or a restart finds it taken and calls no model for it
      if (claimReport(core, id, row, now)) await one(id, row);
    }
    return n;
  }

  /** one person's report: code's sections, the model's words (calls counted on the row), then the card in one transaction */
  private async makeReport(id: string, row: JudgmentRow, read: MarketRead, now: number): Promise<boolean> {
    const { core } = this;
    const { db } = core;
    const userId = row.user_id;
    const user = db.userById(userId);
    if (!user) return false;
    const knowsHoldings = this.holdingsByUser.has(userId);
    const etf: EtfInput[] = [];
    for (const w of idb.watchlist(db, userId)) {
      const rules = idb.rules(db, userId, w.symbol);
      if (!rules.length) continue;
      etf.push({ symbol: w.symbol, market: w.market, rules, bars: await this.dailyBars(w.symbol, w.market, userId), held: knowsHoldings ? !!this.holding(userId, w.symbol) : null });
    }
    const prev = lastSent(core, userId, row.day);
    const prevSeen = prev?.json ? (JSON.parse(prev.json) as Stored).seen : {};
    const built = buildReport({ core, userId, row, read, etf, events: eventRowsAhead(core, userId, now), prevSeen, since: prev?.sent_at ?? row.at - 86_400_000, reportId: id, now });
    if (!built) return false;
    const words = await writeWords(core, built.input, () => takeCall(core, id));
    // DD 0733 2: off keeps the report in the thread; only its push and banner stay home
    const push = settingsOf(user).notifications.investReport;
    const sent = db.tx(() => {
      const claimed = (dueReminders(db, now).get(userId) ?? []).filter((r) => claimReminder(db, r, "daily", now));
      const stored = assemble(built, words, eventLines(claimed, now), row.day, row.at);
      const { threadId, messageId } = this.post(userId, stored.card, reportRecord(stored), { title: built.pushTitle, body: "" }, `report:${row.day}`, push);
      noteReminderMessage(db, claimed, messageId);
      if (!markSent(core, id, stored, threadId, messageId, core.now())) throw new Error("report already sent");
      return true;
    });
    await this.publish(userId).catch((err) => core.log.error("invest publish failed", { err: errInfo(err) }));
    return sent;
  }

  /** from 08:00 KST, today's stage reading for each invest user who has none (one run at a time) */
  judgeStages(now = this.core.now()): Promise<number> {
    if (this.judging) return this.judging;
    this.judging = judgeDay(this.core, now).finally(() => (this.judging = null));
    return this.judging;
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.ticking?.catch(() => undefined);
    await this.reminding?.catch(() => undefined);
    await this.judging?.catch(() => undefined);
    await this.reporting?.catch(() => undefined);
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
    const callBlock = this.callBlock(userId);
    return {
      mode: s.mode,
      ...(s.mode === "real" && s.real_since ? { realSince: s.real_since } : {}),
      toss,
      calls: this.calls(s),
      callBlock,
      callNote: callNote(callBlock),
      bufferPctDefault: { v: DEFAULT_BUFFER_PCT, text: `${num(DEFAULT_BUFFER_PCT)}%`, unit: "pct" },
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
    if (!anySource) {
      // DD 2237 §4: a person with live rules believes they run; say they do not, and how they would on a Toss server
      const foot = liveRules.length ? `그래서 규칙을 확인하지 않아요.${this.toss.base() ? " 토스증권을 연결하면 확인해요." : ""}` : null;
      return { state: "off", text: "지금은 시세를 받지 않아요", ...(foot ? { foot } : {}) };
    }
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
    const ov = this.dayOverride(s.user_id);
    const open = currentSlot("US", now, ov) || currentSlot("KR", now, ov);
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
    // off: no period sentence (nothing is checked; DD 0454-b), the app shows watch.foot or nothing
    let quotesFoot: string | null;
    if (watch.state === "off") quotesFoot = null;
    else if (blind) quotesFoot = watch.foot!;
    else if (shown.length) {
      const latest = Math.max(...shown.map((q) => q.as_of));
      const names = [...new Set(shown.map((q) => SOURCE_TABLE[q.source as SourceKey]?.name ?? q.source))].join(" · ");
      quotesFoot = `시세 ${atText(latest, now)} 기준 · ${names}. ${PERIOD}`;
    } else quotesFoot = PERIOD;
    return {
      rev: s.rev,
      mode: s.mode,
      stages: stagesView(this.core, userId, now),
      watchlist: wl.map((w) => this.symbolRow(userId, w, qs.get(w.symbol), blind)),
      rules: rs.map((r) => this.ruleRow(r, s.mode)),
      reports: recentReports(this.core, userId, now),
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
    const bars = await this.dailyBars(symbol, w.market, userId);
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
   * daily bars (ATR for the stop basis, the symbol chart), team-lead 2045 order: the person's own Toss candles (their
   * token and cache, team-lead 2253), else Yahoo, shared by everyone; a 429 or 403 rests Yahoo for the day. A read lasts
   * to today's close check when made before it (so the day's bar is read again once final), else to the next market
   * day. None → null: the stop is judged on intraday prices only (team-lead 2045 correction).
   */
  async dailyBars(symbol: string, market: Market, userId?: string): Promise<{ bars: Bar[]; source: SourceKey } | null> {
    if (userId) {
      const t = await this.tossDaily(userId, symbol, market);
      if (t) return { bars: t, source: "toss" };
    }
    const until = (now: number) => dailyUntil(market, now);
    const y = await cachedGet(this.gate, this.core, "yahoo", yahooUrl(symbol, market, "1y"), until);
    if (!y.ok) return null;
    const bars = parseYahooDaily(y.text, (ms) => marketDate(market, ms));
    if (bars === null) this.gate.pauseForJunk("yahoo");
    return bars && bars.length ? { bars, source: "yahoo" } : null;
  }

  /** this person's Toss daily candles: read with their token for their own watch, kept under their key */
  private async tossDaily(userId: string, symbol: string, market: Market): Promise<Bar[] | null> {
    const { db } = this.core;
    const now = this.core.now();
    const key = tossBarsKey(userId, market, symbol);
    const hit = idb.cacheGet(db, key, now);
    if (hit) return JSON.parse(hit) as Bar[];
    const s = idb.getSettings(db, userId);
    if (!s || !this.tossUsable(s, now) || !(await this.tossConnected(userId, now))) return null;
    const tried = this.tossTried.get(key);
    if (tried != null && now - tried < TOSS_DAILY_RETRY_MS) return null;
    const r = await this.toss.candles(userId, symbol);
    if (!r.ok || !r.value.length) {
      this.tossTried.set(key, now);
      return null;
    }
    this.tossTried.delete(key);
    idb.cachePut(db, key, JSON.stringify(r.value), now, dailyUntil(market, now, this.dayOverride(userId)));
    return r.value;
  }

  /** "is Toss connected" for the 30-second ticks, remembered a few minutes */
  private async tossConnected(userId: string, now: number): Promise<boolean> {
    const m = this.connectedMemo.get(userId);
    if (m && now - m.at < CONNECTED_MEMO_MS && now >= m.at) return m.v;
    const v = await this.toss.connected(userId);
    this.connectedMemo.set(userId, { at: now, v });
    return v;
  }

  /** the days this person's Toss calendar has answered (their cache), as their watch sees them; other days: null */
  dayOverride(userId: string): DayOverride {
    const { db } = this.core;
    const now = this.core.now();
    return (market, day) => {
      const v = idb.cacheGet(db, calKey(userId, market, day), now);
      return v == null ? null : dayFromToss(market, day, JSON.parse(v) as { open: number; close: number } | null);
    };
  }

  /**
   * Once a market day per market for a person with Toss: their market calendar for today, with their token, for their
   * own watch (team-lead 2253). Weekends are not asked. A reply that differs from the rules and the table is logged
   * with the market, the day and the two answers only.
   */
  private async checkCalendar(userId: string, market: Market, day: string, now: number): Promise<void> {
    const { db } = this.core;
    const key = calKey(userId, market, day);
    const table = marketDay(market, day);
    if (table.kind === "closed" && table.reason === "weekend") return;
    if (idb.cacheGet(db, key, now) != null) return;
    const s = idb.getSettings(db, userId);
    if (!s || !this.tossUsable(s, now) || !(await this.tossConnected(userId, now))) return;
    const tried = this.tossTried.get(key);
    if (tried != null && now - tried < TOSS_DAILY_RETRY_MS) return;
    this.tossTried.set(key, now);
    const r = await this.toss.marketDay(userId, market, day);
    if (!r.ok || !r.value || r.value.date !== day) return;
    const ss = r.value.session;
    if (ss && !(ss.open < ss.close && ss.close - ss.open <= 12 * 3_600_000 && marketDate(market, ss.open) === day)) return;
    this.tossTried.delete(key);
    idb.cachePut(db, key, JSON.stringify(ss), now, now + CALENDAR_KEEP_MS);
    const said = daySays(market, dayFromToss(market, day, ss));
    if (daySays(market, table) !== said) this.core.log.warn("market calendar differs from the table", { market, day, table: daySays(market, table), toss: said });
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
    const market = marketOf(symbol);
    const { atr14, close, atrAsOf, atrSource } = await this.atrOf(userId, symbol);
    const h = this.holding(userId, symbol);
    const ref = h?.avgPrice ?? close;
    const basis = stopBasis(atr14, stop, ref);
    return { basis, buffer: bufferPrice(market, stop, bufPct), atr14, atrAsOf, atrSource };
  }

  /** ATR14 and the last close from finished daily bars, else the kept figure (D5-2; B2c-2's gap and run read the same) */
  async atrOf(userId: string, symbol: string): Promise<{ atr14: number | null; close: number | null; atrAsOf: string | null; atrSource: SourceKey }> {
    const { db } = this.core;
    const now = this.core.now();
    const market = marketOf(symbol);
    const ov = this.dayOverride(userId);
    const got = await this.dailyBars(symbol, market, userId);
    // finished bars only (team-lead 2253): a bar read during today's session is still moving
    const bars = got ? finishedBars(got.bars, market, now, ov) : [];
    const keyOf = (src: SourceKey) => (src === "toss" ? tossAtrKey(userId, market, symbol) : `atr:${market}:${symbol}`);
    let atr14: number | null = null;
    let close: number | null = null;
    let atrAsOf: string | null = null;
    let atrSource: SourceKey = got?.source ?? "yahoo";
    if (got && bars.length) {
      const last = bars[bars.length - 1]!;
      const a = atr(bars);
      close = last.c;
      atr14 = a.length ? (a[a.length - 1] ?? null) : null;
      if (atr14 != null) {
        atrAsOf = last.t;
        idb.cachePut(db, keyOf(got.source), JSON.stringify({ atr: atr14, close, asOf: last.t }), now, now + 30 * 86_400_000);
      }
    } else {
      // the person's own Toss figure first, then the shared Yahoo one
      for (const src of ["toss", "yahoo"] as const) {
        const kept = idb.cacheGet(db, keyOf(src), now);
        const k = kept ? (JSON.parse(kept) as { atr: number; close: number; asOf: string }) : null;
        if (k && marketDaysAfter(market, k.asOf, marketDate(market, now), ov) <= ATR_KEEP_DAYS) {
          atr14 = k.atr;
          close = k.close;
          atrAsOf = k.asOf;
          atrSource = src;
          break;
        }
      }
    }
    return { atr14, close, atrAsOf, atrSource };
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

  /** a Toss login connected (k-skill connect, or a vault save): one holdings read, with the token its check just got */
  async onTossSaved(userId: string): Promise<void> {
    this.connectedMemo.delete(userId);
    await this.checkToss(userId, { floor: false });
  }

  /** the login was deleted or disconnected: real orders back to mock at once, holdings and its session forgotten */
  async onTossRemoved(userId: string): Promise<void> {
    const { core } = this;
    this.toss.forget(userId);
    this.connectedMemo.delete(userId);
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
    const { db } = this.core;
    for (const market of ["US", "KR"] as const) {
      const day = marketDate(market, now);
      // the slot each person is due: the table's, or their own Toss calendar's (team-lead 2253)
      const due = new Map<string, { slot: Slot; users: string[] }>();
      for (const userId of idb.investUsers(db)) {
        if (!idb.watchlist(db, userId).some((w) => w.market === market)) continue;
        await this.checkCalendar(userId, market, day, now);
        const slot = currentSlot(market, now, this.dayOverride(userId));
        if (!slot) continue;
        const k = `${slot.key}${slot.close ? ":close" : ""}`;
        const g = due.get(k);
        if (g) g.users.push(userId);
        else due.set(k, { slot, users: [userId] });
      }
      for (const [k, g] of due) {
        if (this.ranSlots.has(k)) continue;
        this.ranSlots.add(k);
        const marker = `watch:ran:${k}`;
        if (idb.cacheGet(db, marker, now) != null) continue;
        idb.cachePut(db, marker, "1", now, now + 2 * 86_400_000);
        slots++;
        alerts += await this.runSlot(g.slot, now, g.users);
      }
    }
    if (this.ranSlots.size > 500) this.ranSlots = new Set([...this.ranSlots].slice(-50));
    return { slots, alerts };
  }

  private async runSlot(slot: Slot, now: number, users: string[]): Promise<number> {
    let n = 0;
    const shared = new Map<string, Promise<Quote | "not_found" | null>>();
    for (const userId of users) {
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
    // B2c-2: the session's first check reads the open (gap, from Yahoo's day chart for everyone: a public delayed
    // quote, no one's token) and yesterday's last price (split); every check reads the price the check before stored
    const prev = prevSlot(slot, this.dayOverride(userId));
    const first = !slot.close && (!prev || prev.day !== slot.day);
    const before = new Map(idb.quotes(db, userId).map((q) => [q.symbol, q] as const));
    // Yahoo's day chart per symbol with live rules, first check only: the open, and the previous close (Toss's prices
    // carry none)
    const yq = new Map<string, Quote>();
    if (first) {
      for (const sym of new Set(live.map((r) => r.symbol))) {
        let pending = shared.get(sym);
        if (!pending) shared.set(sym, (pending = this.yahooQuote(sym, slot.market)));
        const q = await pending;
        if (q && q !== "not_found") yq.set(sym, q);
      }
    }
    const opens = new Map([...yq].filter(([, q]) => q.open && q.prevClose != null && marketDate(slot.market, q.open.at) === slot.day));
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

    let alerts = 0;
    // a split or a merge (first check, yesterday's price known): that symbol's rules stop before anything is judged
    const held = new Set<string>();
    if (first && prev) {
      for (const sym of new Set(live.map((r) => r.symbol))) {
        const b = before.get(sym);
        if (!b || marketDate(slot.market, b.as_of) !== prev.day) continue;
        // the previous close as the source of today's price gives it, else Yahoo's
        const o = got.get(sym);
        const y = yq.get(sym);
        const pc = o?.prevClose != null ? { prevClose: o.prevClose, at: o.at, source: o.source } : y?.prevClose != null ? { prevClose: y.prevClose, at: y.at, source: "yahoo" as const } : null;
        const sp = pc ? splitOf(b.price, pc.prevClose) : null;
        if (!pc || !sp) continue;
        held.add(sym);
        if (await this.holdForSplit(userId, sym, sp, { price: b.price, day: prev.day }, pc, now)) alerts++;
      }
    }
    const ran = new Set<string>();
    for (const r0 of live) {
      const r = idb.rule(db, userId, r0.id);
      if (!r || (r.state !== "armed" && r.state !== "hit")) continue;
      const o = got.get(r.symbol);
      // A14 추격 금지: in or under the buy zone at the check before (seen there), far above it now
      const was = before.get(r.symbol)?.price ?? null;
      if (o && r.kind === "buy_zone" && prev && priorReason(r.seen_slot, prev.key) === null && was != null && was <= r.hi! && o.price > r.hi!) {
        const run = runAbove(was, o.price, r.hi!, (await this.atrOf(userId, r.symbol)).atr14);
        if (run) {
          ran.add(r.symbol);
          if (await this.runAlert(userId, r, run, o, now)) alerts++;
        }
      }
      if (o) {
        let basis: "close_and_intraday" | "intraday" = "intraday";
        let buffer: number | null = null;
        let atrSeen: { value: number; asOf: string; source: SourceKey } | null = null;
        if (r.kind === "stop") {
          const c = await this.stopContext(userId, r.symbol, r.price!, bufferPct(r));
          basis = c.basis;
          buffer = c.buffer;
          atrSeen = c.atr14 != null && c.atrAsOf ? { value: c.atr14, asOf: c.atrAsOf, source: c.atrSource } : null;
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
    // a big gap at the open: one card per symbol and day, none where a split stopped the rules or the run card went
    if (prev) {
      for (const [sym, q] of opens) {
        if (held.has(sym) || ran.has(sym)) continue;
        const atr = await this.atrOf(userId, sym);
        const g = gapOf(q.open!.price, q.prevClose!, atr.atr14);
        if (g && (await this.gapAlert(userId, sym, g, q, prev.day, slot.day, atr, now))) alerts++;
      }
    }
    await this.publish(userId);
    return alerts;
  }

  // ───────────────────────────── B2c-2: gap, a run above the buy zone, split (team-lead 0856, DD 0847) ─────────────────────────────

  /** a code row in the person's ledger (T2, the quote source's grade); a refused one is logged, never in the card's way */
  private codeLedger(userId: string, market: Market, row: { id: string; asOf: string; value: number; definition: string; source: SourceKey }): void {
    try {
      writeLedger(this.core.db, userId, { id: row.id, asOf: row.asOf, value: row.value, unit: market === "US" ? "usd" : "krw", definition: row.definition, source: SOURCE_TABLE[row.source].name, sourceTier: "T2", confidence: SOURCE_TABLE[row.source].grade }, "code", this.core.now());
    } catch (err) {
      this.core.log.error("invest ledger write failed", { user: userId, id: row.id, err: errInfo(err) });
    }
  }

  /** one symbol-level alert row (no rule): false when its key was used */
  private claimAlert(userId: string, row: { id: string; ruleId: string | null; symbol: string; kind: string; key: string; price: number | null; at: number; source: string }, alsoInTx?: () => void): boolean {
    const { db } = this.core;
    return db.tx(() => {
      const ok = idb.insertAlert(db, {
        id: row.id,
        user_id: userId,
        rule_id: row.ruleId,
        symbol: row.symbol,
        kind: row.kind,
        dedupe_key: row.key,
        price: row.price,
        observed_at: row.at,
        source: row.source,
        title: "",
        thread_id: null,
        message_id: null,
        call_state: null,
        called_at: null,
        created_at: this.core.now(),
      });
      if (ok) alsoInTx?.();
      return ok;
    });
  }

  private sendAlert(userId: string, alertId: string, card: ReturnType<typeof gapCard>, banner: { title: string; body: string }, tag: string): void {
    const { db } = this.core;
    const record = `[투자 알림] ${card.title}${card.titleLines?.length ? ` (${card.titleLines.join(" ")})` : ""} · ${card.rows.map((r) => `${r.label} ${r.value}`).join(" · ")} · ${card.foot}`;
    const { threadId, messageId } = this.post(userId, card, record, banner, tag);
    idb.setAlertMessage(db, alertId, threadId, messageId);
    db.sql.query("UPDATE invest_alerts SET title = $t WHERE id = $id").run({ id: alertId, t: card.title });
  }

  /** A14 분할·병합: the symbol's live rules stop (paused, marked) in the alert's transaction; prices are never changed */
  private async holdForSplit(userId: string, symbol: string, split: Split, seen: { price: number; day: string }, o: { prevClose: number; at: number; source: SourceKey }, now: number): Promise<boolean> {
    const { db } = this.core;
    const market = marketOf(symbol);
    const alertId = newId("ia");
    let n = 0;
    const ok = this.claimAlert(userId, { id: alertId, ruleId: null, symbol, kind: "split", key: `split:${symbol}:${marketDate(market, o.at)}`, price: o.prevClose, at: o.at, source: o.source }, () => {
      for (const r of idb.rules(db, userId, symbol)) {
        if (r.state !== "armed" && r.state !== "hit") continue;
        idb.updateRuleWatch(db, r.id, r.rev, { state: "paused", hit_at: r.hit_at, hit_seq: r.hit_seq, cleared_at: r.cleared_at, paused_at: now, seen_slot: SEEN_SPLIT }, now);
        n++;
      }
    });
    if (!ok) return false;
    const input = { alertId, symbol, market, split, seen, prevClose: o.prevClose, obs: o, held: n, now };
    this.sendAlert(userId, alertId, splitCard(input), splitBanner(input), `split:${symbol}`);
    return true;
  }

  /** the run card, once per buy-zone entry (the rule's hit_seq moves only when the price comes back into the zone) */
  private async runAlert(userId: string, r: idb.RuleRow, run: Run, o: Observation, now: number): Promise<boolean> {
    const market = marketOf(r.symbol);
    const alertId = newId("ia");
    if (!this.claimAlert(userId, { id: alertId, ruleId: r.id, symbol: r.symbol, kind: "chase", key: `chase:${r.id}:${r.rev}:${r.hit_seq}`, price: o.price, at: o.at, source: o.source })) return false;
    const atr = await this.atrOf(userId, r.symbol);
    this.codeLedger(userId, market, { id: `quote.${r.symbol}`, asOf: new Date(o.at).toISOString(), value: o.price, definition: "5분 감시 가격", source: o.source });
    if (atr.atr14 != null && atr.atrAsOf) this.codeLedger(userId, market, { id: `atr14.${r.symbol}`, asOf: atr.atrAsOf, value: atr.atr14, definition: "ATR14 (일봉 14일 평균 실제 범위)", source: atr.atrSource });
    const input = { alertId, ruleId: r.id, rule: r, market, mode: idb.ensureSettings(this.core.db, userId, now).mode, run, obs: o, now, stageRow: stageRowText(this.core, userId, now) };
    this.sendAlert(userId, alertId, runCard(input), runBanner(input), `chase:${r.id}`);
    return true;
  }

  /** the gap card, once per symbol and market day */
  private async gapAlert(userId: string, symbol: string, gap: Gap, q: Quote, prevDay: string, day: string, atr: { atr14: number | null; atrAsOf: string | null; atrSource: SourceKey }, now: number): Promise<boolean> {
    const market = marketOf(symbol);
    const alertId = newId("ia");
    const open = q.open!;
    if (!this.claimAlert(userId, { id: alertId, ruleId: null, symbol, kind: "gap", key: `gap:${symbol}:${day}`, price: open.price, at: open.at, source: "yahoo" })) return false;
    this.codeLedger(userId, market, { id: `quote.${symbol}`, asOf: new Date(open.at).toISOString(), value: open.price, definition: "그날 첫 5분 봉 시가", source: "yahoo" });
    if (atr.atr14 != null && atr.atrAsOf) this.codeLedger(userId, market, { id: `atr14.${symbol}`, asOf: atr.atrAsOf, value: atr.atr14, definition: "ATR14 (일봉 14일 평균 실제 범위)", source: atr.atrSource });
    const input = { alertId, symbol, market, gap, open: open.price, prevClose: q.prevClose!, prevDay, obs: { at: q.at, source: "yahoo" as const }, now, stageRow: stageRowText(this.core, userId, now) };
    this.sendAlert(userId, alertId, gapCard(input), gapBanner(input), `gap:${symbol}`);
    return true;
  }

  // ───────────────────────────── D-1 (team-lead 0056, DD 0109 §1) ─────────────────────────────

  /**
   * The D-1 reminders due now (events.ts): per person one card with every event of theirs due, each event's reminder
   * claimed in the same transaction that stores the card, so a second tick, a restart or a later path sends nothing.
   * B2c-1: for a person whose 08:00 report goes out today the card waits (up to an hour past 08:00) and the report
   * carries the lines instead (the same claim, via "daily"); what the report did not take goes as a card after it.
   */
  remindEvents(now = this.core.now()): Promise<number> {
    if (this.reminding) return this.reminding;
    this.reminding = Promise.resolve()
      .then(() => this.sendReminders(now))
      .finally(() => (this.reminding = null));
    return this.reminding;
  }

  private sendReminders(now: number): number {
    const { core } = this;
    let sent = 0;
    for (const [userId, due] of dueReminders(core.db, now)) {
      if (reportHoldsReminders(core, userId, now)) continue;
      try {
        sent += core.db.tx(() => {
          const rows = due.filter((r) => claimReminder(core.db, r, "card", now));
          if (!rows.length) return 0;
          const card = eventCard(rows, now);
          const { messageId } = this.post(userId, card, eventRecord(card), { title: card.title, body: "" }, `event:${rows[0]!.day}`);
          noteReminderMessage(core.db, rows, messageId);
          return rows.length;
        });
      } catch (err) {
        core.log.error("invest D-1 failed", { user: userId, err: errInfo(err) });
      }
    }
    return sent;
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
  private post(userId: string, card: Parameters<Core["db"]["insertMessage"]>[0]["cards"] extends (infer C)[] | undefined ? C : never, record: string, banner: { title: string; body: string }, ruleId: string, notify = true): { threadId: string; messageId: string } {
    const { core } = this;
    const threadId = this.ensureThread(userId);
    const messageId = newId("m");
    const now = core.now();
    core.db.insertMessage({ id: messageId, threadId, role: "assistant", text: "", cards: [card], llm: [{ role: "assistant", content: record }], createdAt: now });
    core.db.setUnread(threadId, userId, true);
    core.db.touchThread(threadId, now, banner.title);
    publishMessage(core, messageId);
    publishThread(core, threadId);
    if (!notify) return { threadId, messageId };
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

  private async fire(userId: string, r: idb.RuleRow, st: ReturnType<typeof step>, o: Observation, slot: Slot, now: number, stopAtr?: { kind: string; atr: { value: number; asOf: string; source: SourceKey } | null }): Promise<boolean> {
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
    // both quote sources measure (T2); the ledger checks code's rows like anyone's, and a refused one is logged, never
    // in the alert's way
    const ledger = (row: { id: string; asOf: string; value: number; definition: string; source: SourceKey }) => {
      try {
        writeLedger(db, userId, { id: row.id, asOf: row.asOf, value: row.value, unit: market === "US" ? "usd" : "krw", definition: row.definition, source: SOURCE_TABLE[row.source].name, sourceTier: "T2", confidence: SOURCE_TABLE[row.source].grade }, "code", now);
      } catch (err) {
        core.log.error("invest ledger write failed", { user: userId, id: row.id, err: errInfo(err) });
      }
    };
    ledger({ id: `quote.${r.symbol}`, asOf: new Date(o.at).toISOString(), value: o.price, definition: slot.close ? "마감 뒤 확인 가격" : "5분 감시 가격", source: o.source });
    // the ATR behind a stop's basis, with the day of its last bar (a kept one is up to ATR_KEEP_DAYS market days old)
    if (stopAtr?.atr) ledger({ id: `atr14.${r.symbol}`, asOf: stopAtr.atr.asOf, value: stopAtr.atr.value, definition: "ATR14 (일봉 14일 평균 실제 범위)", source: stopAtr.atr.source });
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
      if (this.calls(s).stopResult) this.callLater(userId, messageId, orderId, stopCallLine(agentName, r, market, card, o.price, h, stageCallText(core, userId, now) ?? undefined), (c) => idb.setAlertCall(db, alertId, c.ok ? "ok" : c.reason, c.at));
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
      // the person's stop that is still watched (DD 1441 1: an expired one is in neither the card nor the call)
      stopPrice: idb.rules(db, userId, r.symbol).find((x) => x.kind === "stop" && x.price != null && x.state !== "expired")?.price ?? null,
      intradayOnly,
      stageRow: stageRowText(core, userId, now),
      stageCall: stageCallText(core, userId, now) ?? undefined,
      // the buy zone's 다음 row (DD 0847 1): the person's rules on this symbol that are not over
      firstTarget: r.kind === "buy_zone" ? (idb.rules(db, userId, r.symbol).find((x) => x.kind === "target" && x.level === 1 && x.price != null && x.state !== "expired")?.price ?? null) : null,
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
    const card = expiredCard({ alertId, ruleId: r.id, rule: r, market, mode: s.mode, createdAt: r.created_at, at: now, now, stageRow: stageRowText(core, userId, now) });
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

