/**
 * B3a: real stop orders, the executor (team-lead 0052 · 2040 · 2045b; DD 1935 §2-2, 2044, 2046-b). A sell stop hit in
 * real mode becomes one row of invest_real_orders here. This file decides when it goes out, sends it
 * (`TossClient.sellStop`; nothing else calls it), and follows it to its end. B3a has no way to turn real mode on, and
 * no way to confirm a rule for real selling: tests write both into the database.
 *
 * G8 in this file:
 * - The only Toss write is `sellStop`, a market sell with no side argument: no buy, and no take-profit sale (a target
 *   can never carry `sell`; rules.ts).
 * - The gates, in order: the server switch (`PICKLE_INVEST_ORDERS=on`), the rule confirmed at its current rev with a
 *   quantity, the order window, the Toss login, the Toss pause, the sellable quantity, and the day's cap.
 * - The order window is the regular session from its open until 2 minutes before its close, never on an early-close
 *   day. Outside it: the next session's first check (open + 15 min), or skipped on an early-close day or an unknown
 *   calendar.
 * - Quantity is min(sellable quantity, the quantity confirmed). Zero: no order. US fractions only until an hour before
 *   the close; KR whole shares only.
 * - One `clientOrderId` per hit: `m` + 32 base64url characters of sha256(user, rule, rev, hit), so no user id goes
 *   out. One real order per rule and market day (a partial unique index); a person's orders on one market day never
 *   outnumber the symbols they hold.
 * - Resends: a 401 gets a new token inside sellStop. No answer, or 409 request-in-progress, is sent once more with the
 *   same id at the next beat (Toss replays the first result for 10 minutes). A 403 is never resent (the allowed IP,
 *   paused an hour), nor a 5xx (the order list is searched instead), nor a 429 (`failed`). After the second send only
 *   a success or a rejection is taken as Toss's answer; anything else is searched for.
 * - "Sold" is said only once Toss reports FILLED. A 429-paused hit waits for the pause inside the session; a
 *   403-paused hit is skipped at once.
 *
 * Every step rewrites the order's card and its `[투자 기록]` line in place. Banners, pushes and calls follow DD 2044
 * §2–3: one call per outcome, none for what the person did themselves.
 */
import { createHash } from "node:crypto";
import type { InvestCall, InvestStopCard } from "@pickle/protocol";
import type { Core } from "../core.ts";
import { publishMessage } from "../core.ts";
import { errInfo } from "../log.ts";
import { newId } from "../util.ts";
import { FIRST_CHECK_AFTER_OPEN_MS, marketDate, marketDay, marketOf, nextSession, type DayOverride, type Market, type Session, type Slot } from "./calendar.ts";
import { realStopBanner, realStopCallLine, realStopCard, realStopRecord, type Holding, type Observation } from "./cards.ts";
import * as idb from "./db.ts";
import type { TossClient, TossErrorCode, TossOrder } from "./toss.ts";

/** no market order in the session's last two minutes: the check at the close is the close itself */
export const ORDER_CLOSE_MARGIN_MS = 2 * 60_000;
/** US fractional sells are taken until an hour before the close (openapi 1.2.28) */
export const FRACTION_CUTOFF_MS = 60 * 60_000;
/** the hub's beat */
export const BEAT_MS = 30_000;
/** fill checks: every beat for the first five minutes after sending, then every five minutes */
export const CHECK_FAST_FOR_MS = 5 * 60_000;
export const CHECK_SLOW_MS = 5 * 60_000;
/** the last fill check: the close of the order's session + 15 minutes (a DAY order's rest is cancelled at the close) */
export const CHECK_AFTER_CLOSE_MS = 15 * 60_000;
/** an order with no answer is looked for in the person's order list for five minutes after it was sent */
export const SEARCH_FOR_MS = 5 * 60_000;
/** Toss's order time against our send: a minute of clock difference allowed */
const SEARCH_SKEW_MS = 60_000;

/** Toss statuses that end an order without a full fill */
const ENDED = new Set(["CANCELED", "REJECTED", "REPLACED"]);

/** the order key Toss gets (≤ 36 of [A-Za-z0-9_-]): one per hit, so overlapping runs and resends name one order */
export function clientOrderIdOf(userId: string, ruleId: string, rev: number, hitSeq: number): string {
  return `m${createHash("sha256").update(`${userId}:${ruleId}:${rev}:${hitSeq}`).digest("base64url").slice(0, 32)}`;
}

/** the quantity as Toss takes it: a decimal string, no exponent, at most 6 decimals */
export function qtyText(q: number): string {
  return q.toFixed(6).replace(/\.?0+$/, "");
}

/** when an order can go out: now, at the next session's first check, or not at all */
export type Window = { kind: "now"; session: Session } | { kind: "next"; session: Session; due: number } | { kind: "early_close" } | { kind: "unknown" };

export function orderWindow(market: Market, now: number, ov?: DayOverride): Window {
  const today = marketDay(market, marketDate(market, now), ov);
  if (today.kind === "unknown") return { kind: "unknown" };
  if (today.kind === "open" && now >= today.session.open && now < today.session.close - ORDER_CLOSE_MARGIN_MS) {
    return today.session.early ? { kind: "early_close" } : { kind: "now", session: today.session };
  }
  const next = today.kind === "open" && now < today.session.open ? today.session : nextSession(market, now, ov);
  if (!next) return { kind: "unknown" };
  if (next.early) return { kind: "early_close" };
  return { kind: "next", session: next, due: next.open + FIRST_CHECK_AFTER_OPEN_MS };
}

export interface DeskHost {
  core: Core;
  toss: TossClient;
  /** Toss can be asked for this person now (the server has a base; no pause) */
  tossUsable(userId: string, now: number): boolean;
  recordToss(userId: string, error: TossErrorCode | null, now: number): void;
  /** the card's row in the invest thread; `banner` null: no banner, no push */
  post(userId: string, card: InvestStopCard, record: string, banner: { title: string; body: string } | null, ruleId: string): { threadId: string; messageId: string };
  /** the in-app banner and the lock-screen push for an existing row (its thread marked unread) */
  notify(userId: string, banner: { title: string; body: string }, threadId: string, messageId: string, ruleId: string): void;
  callLater(userId: string, messageId: string, ref: string, line: string, onCall?: (c: InvestCall) => void): void;
  stopResultCalls(userId: string): boolean;
  /** symbols held at the last holdings read (null: not read) */
  heldCount(userId: string): number | null;
  holding(userId: string, symbol: string): Holding | null;
  dayOverride(userId: string): DayOverride;
  stageCall(userId: string, now: number): string | undefined;
  agentName(userId: string): string;
  publish(userId: string): Promise<void>;
}

type Row = idb.RealOrderRow;
type Gate =
  | { kind: "send"; session: Session; qty: number; sellable: number; fraction: number | null }
  | { kind: "schedule"; session: Session; due: number; qty: number; sellable: number | null }
  | { kind: "wait"; session: Session; until: number }
  | { kind: "skip"; code: string; sellable?: number }
  | { kind: "cancel"; code: string };

export class OrderDesk {
  private running: Promise<void> | null = null;
  /** order id → its alert row, until the card is first posted */
  private alertOf = new Map<string, string>();

  constructor(private h: DeskHost) {}

  /**
   * A sell stop hit in real mode (hub.fire, after the alert row and the rule's new state were written; `rule` is the
   * row as judged). The row and its card are made now; an order that can go out is sent before this returns.
   */
  async hit(i: { userId: string; rule: idb.RuleRow; hitSeq: number; obs: Observation; slot: Slot; now: number; alertId: string; intradayOnly: boolean }): Promise<{ title: string }> {
    const db = this.h.core.db;
    const r = i.rule;
    const clientOrderId = clientOrderIdOf(i.userId, r.id, r.rev, i.hitSeq);
    // the same hit twice (an overlapping run): the first one has it
    if (idb.realOrderByClientId(db, clientOrderId)) return { title: "" };
    const confirm = idb.realConfirm(db, i.userId, r.id);
    let row: Row = {
      id: newId("io"),
      user_id: i.userId,
      rule_id: r.id,
      rule_rev: r.rev,
      symbol: r.symbol,
      client_order_id: clientOrderId,
      toss_order_id: null,
      state: "skipped",
      reason: null,
      reason_text: null,
      basis: i.slot.close ? "close" : "intraday",
      intraday_only: i.intradayOnly ? 1 : 0,
      observed_price: i.obs.price,
      observed_at: i.obs.at,
      source: i.obs.source,
      stop_price: r.price!,
      avg_cost: this.h.holding(i.userId, r.symbol)?.avgPrice ?? null,
      confirmed_qty: confirm && confirm.rev === r.rev ? confirm.qty : null,
      sellable: null,
      qty: null,
      fraction_left: null,
      filled_qty: null,
      avg_price: null,
      market_day: null,
      due_at: null,
      sent_at: null,
      sends: 0,
      check_at: null,
      check_until: null,
      filled_at: null,
      stopped_at: null,
      message_id: null,
      created_at: i.now,
      updated_at: i.now,
    };
    let g = await this.gate(r, row, i.now, false);
    // the person changed or deleted the rule while Toss was asked: this hit is no longer theirs to act on
    const cur = idb.rule(db, i.userId, r.id);
    if (!cur || cur.rev !== r.rev) g = { kind: "cancel", code: cur ? "rule_changed" : "rule_deleted" };
    else if (g.kind === "send" && this.capped(i.userId, g.session.day)) g = { kind: "skip", code: "daily_limit", sellable: g.sellable };
    row = { ...row, ...fromGate(g) };
    if (g.kind === "schedule" && !i.slot.close) row.basis = "late";
    if (!idb.insertRealOrder(db, row)) {
      // the rule already has an order that market day (team-lead 2040): this hit is a skip, with no market day; the
      // quantity Toss gave stays for the call (DD 2314 §4)
      row = { ...row, state: "skipped", reason: "rule_day", qty: null, fraction_left: null, market_day: null, due_at: null, check_at: null, check_until: null };
      if (!idb.insertRealOrder(db, row)) return { title: "" };
    }
    this.alertOf.set(row.id, i.alertId);
    try {
      // an order that can go out is sent first: its card says what Toss answered, never "sent" ahead of the POST
      // a wait or the person's own drop has no banner and no call (realStopBanner, callFor)
      if (row.state === "sending") await this.send(row, i.now);
      else this.show(row, { notify: true });
    } finally {
      this.alertOf.delete(row.id);
    }
    const fin = idb.realOrder(db, row.id);
    return { title: (fin && realStopBanner(fin)?.title) ?? "" };
  }

  /** one beat: due orders go out, are sent again, checked or looked for; one run at a time */
  beat(now: number): Promise<void> {
    if (this.running) return this.running;
    this.running = this.runDue(now).finally(() => (this.running = null));
    return this.running;
  }

  /**
   * A rule was saved or deleted: its planned orders (scheduled, waiting) are not sent (DD 2044 1-2). Sent orders are
   * not touched: nothing here cancels at Toss.
   */
  ruleChanged(userId: string, ruleId: string, deleted: boolean): void {
    const now = this.h.core.now();
    for (const row of idb.plannedRealOrders(this.h.core.db, userId, ruleId)) this.finish(row, "canceled", deleted ? "rule_deleted" : "rule_changed", now);
  }

  /** real mode turned off (B3b): planned orders are not sent; returns how many */
  dropPlanned(userId: string, code: "disabled" | "key_removed", now: number): number {
    const rows = idb.plannedRealOrders(this.h.core.db, userId);
    for (const row of rows) this.finish(row, "canceled", code, now);
    return rows.length;
  }

  /** the Toss login was removed: planned orders are not sent; sent ones can no longer be checked, and their cards say so */
  keyRemoved(userId: string, now: number): void {
    this.dropPlanned(userId, "key_removed", now);
    for (const row of idb.sentRealOrders(this.h.core.db, userId)) this.show(this.save(row, { stopped_at: now, check_at: null }, now), {});
  }

  // ───────────────────────────── the gates ─────────────────────────────

  /**
   * What happens to a hit, or to a planned order at its time (`planned`, with the rule as it is now): the switch, the
   * confirmation, the window, Toss, the quantity, the day's cap. Toss is asked (sellable) only when the order could go.
   */
  private async gate(r: idb.RuleRow | null, row: Row, now: number, planned: boolean): Promise<Gate> {
    const { core, toss } = this.h;
    const db = core.db;
    const userId = row.user_id;
    const market = marketOf(row.symbol);
    if (planned) {
      if (!r) return { kind: "cancel", code: "rule_deleted" };
      if (r.rev !== row.rule_rev) return { kind: "cancel", code: "rule_changed" };
      if (idb.getSettings(db, userId)?.mode !== "real") return { kind: "cancel", code: "disabled" };
    }
    if (!core.cfg.invest.orders) return { kind: "skip", code: "server_off" };
    const c = r ? idb.realConfirm(db, userId, r.id) : null;
    if (!r || !c || c.rev !== r.rev || !(c.qty > 0)) return planned ? { kind: "cancel", code: "disabled" } : { kind: "skip", code: "not_confirmed" };
    const w = orderWindow(market, now, this.h.dayOverride(userId));
    if (w.kind === "unknown") return { kind: "skip", code: "calendar_unknown" };
    if (w.kind === "early_close") return { kind: "skip", code: "early_close" };
    if (w.kind === "next" && planned) return { kind: "skip", code: row.state === "waiting" ? "rate_paused" : "off_hours" };
    if (!toss.base() || !(await toss.connected(userId))) return { kind: "skip", code: "toss_not_connected" };
    const paused = !this.h.tossUsable(userId, now);
    if (paused && idb.getSettings(db, userId)?.toss_error === "ip_not_allowed") return { kind: "skip", code: "ip_paused" };
    if (w.kind === "next") {
      // for the next session: the quantity it would take now, for the card (asked only when Toss can be asked)
      let sellable: number | null = null;
      if (!paused) {
        const q = await toss.sellable(userId, row.symbol);
        this.h.recordToss(userId, q.ok ? null : q.error, now);
        if (!q.ok && q.error === "ip_not_allowed") return { kind: "skip", code: "ip_paused" };
        if (q.ok) sellable = q.value;
      }
      if (sellable === 0) return { kind: "skip", code: "zero_sellable" };
      return { kind: "schedule", session: w.session, due: w.due, qty: sellable != null ? Math.min(sellable, c.qty) : c.qty, sellable };
    }
    const session = w.session;
    const lastCall = session.close - ORDER_CLOSE_MARGIN_MS;
    // a 429 pause (5 minutes): this hit was never sent, so it waits for the pause inside the session (team-lead 2045b)
    const waitOr = (): Gate => {
      const until = idb.getSettings(db, userId)?.toss_paused_until ?? now;
      return until < lastCall ? { kind: "wait", session, until } : { kind: "skip", code: "rate_paused" };
    };
    if (paused) return waitOr();
    const q = await toss.sellable(userId, row.symbol);
    this.h.recordToss(userId, q.ok ? null : q.error, now);
    if (!q.ok) {
      if (q.error === "ip_not_allowed") return { kind: "skip", code: "ip_paused" };
      if (q.error === "rate_limited") return waitOr();
      return { kind: "skip", code: q.error === "not_connected" || q.error === "off" ? "toss_not_connected" : "sellable_unknown" };
    }
    if (q.value == null) return { kind: "skip", code: "sellable_unknown" };
    const sellable = q.value;
    let qty = Math.min(sellable, c.qty);
    let fraction: number | null = null;
    if (market === "KR") qty = Math.floor(qty);
    else if (!Number.isInteger(qty) && now >= session.close - FRACTION_CUTOFF_MS) {
      const whole = Math.floor(qty);
      fraction = Number((qty - whole).toFixed(6));
      qty = whole;
    }
    if (!(qty > 0)) {
      if (sellable > 0 && fraction) return { kind: "skip", code: "fraction_hours", sellable };
      // a planned order the person no longer holds: dropped like their own change, with no call (DD 2044 1-2)
      return planned ? { kind: "cancel", code: "zero_sellable" } : { kind: "skip", code: "zero_sellable" };
    }
    // the person's day cap is read by the caller with no wait before the row is written (capped)
    return { kind: "send", session, qty, sellable, fraction };
  }

  // ───────────────────────────── sending and following ─────────────────────────────

  private async runDue(now: number): Promise<void> {
    const db = this.h.core.db;
    for (const row of idb.dueRealOrders(db, now)) {
      try {
        if (row.state === "scheduled" || row.state === "waiting") await this.release(row, now);
        else if (row.state === "sending") await this.send(row, now);
        else if (row.state === "submitted" || row.state === "partial") await this.check(row, now);
        else if (row.state === "searching") await this.search(row, now);
        else this.save(row, { check_at: null }, now);
      } catch (err) {
        this.h.core.log.error("invest order step failed", { user: row.user_id, order: row.id, state: row.state, err: errInfo(err) });
      }
    }
  }

  /** a planned order at its time: the gates again, with the rule as it is now */
  private async release(row: Row, now: number): Promise<void> {
    const db = this.h.core.db;
    const g = await this.gate(idb.rule(db, row.user_id, row.rule_id), row, now, true);
    // dropped meanwhile (a rule save, real mode off, the login removed): that stands
    if (!this.same(row)) return;
    if (g.kind === "skip" || g.kind === "cancel") {
      this.finish(row, g.kind === "skip" ? "skipped" : "canceled", g.code, now);
      return;
    }
    if (g.kind === "wait") {
      const next = this.save(row, { state: "waiting", due_at: row.due_at ?? g.until, check_at: g.until, market_day: g.session.day }, now);
      if (row.state !== "waiting") this.show(next, {});
      return;
    }
    if (g.kind === "schedule") return; // not reached: a planned order outside the window is skipped above
    if (this.capped(row.user_id, g.session.day)) {
      this.finish({ ...row, sellable: g.sellable }, "skipped", "daily_limit", now);
      return;
    }
    // the row has held its market day (the rule's one order that day) since it was planned
    const next = this.save(row, { state: "sending", qty: g.qty, sellable: g.sellable, fraction_left: g.fraction, market_day: g.session.day, check_until: g.session.close + CHECK_AFTER_CLOSE_MS, check_at: null }, now);
    await this.send(next, now);
  }

  /** POST the order: the first time, or once more with the same id after no answer or 409 in-progress */
  private async send(sending: Row, now: number): Promise<void> {
    if (sending.sends === 0) {
      const stop = this.lastCheck(sending);
      if (stop === "gone") return;
      if (stop) {
        this.finish(sending, stop.state, stop.code, now);
        return;
      }
    } else {
      // a resend (the first got no answer): the switch and real mode as they are now (team-lead 2310); off → looked for,
      // since the first may be in, and never sent again
      if (!this.h.core.cfg.invest.orders || idb.getSettings(this.h.core.db, sending.user_id)?.mode !== "real") {
        this.lookFor(sending, "no_answer", {}, now);
        return;
      }
    }
    const res = await this.h.toss.sellStop(sending.user_id, { symbol: sending.symbol, quantity: qtyText(sending.qty!), clientOrderId: sending.client_order_id });
    // what happened meanwhile (checks stopped by a removed login) stays; the answer is added to it
    const row = idb.realOrder(this.h.core.db, sending.id) ?? sending;
    // a send counts only when the orders POST was made: one that failed before it (login, account, token) is no send
    const sent: Partial<Row> = res.ok || res.posted ? { sends: row.sends + 1, sent_at: row.sent_at ?? now } : {};
    const next = row.stopped_at != null ? null : now + BEAT_MS;
    if (res.ok) {
      this.h.recordToss(row.user_id, null, now);
      this.show(this.save(row, { ...sent, state: "submitted", toss_order_id: res.orderId, reason: null, check_at: next }, now), { notify: true });
      return;
    }
    if (res.error === "rejected") {
      this.finish({ ...row, ...sent, reason_text: res.message ?? null }, "failed", "rejected", now);
      return;
    }
    if (row.sends >= 1) {
      // the first send may have gone in: only a success or a rejection is Toss's word on it now
      if (res.error === "ip_not_allowed" || res.error === "rate_limited" || res.error === "auth") this.h.recordToss(row.user_id, res.error, now);
      this.lookFor(row, res.error === "server" ? "server_error" : "no_answer", sent, now);
      return;
    }
    switch (res.error) {
      case "lost":
      case "in_progress":
        this.show(this.save(row, { ...sent, state: "sending", check_at: next }, now), {});
        return;
      case "server":
        this.lookFor(row, "server_error", sent, now);
        return;
      case "ip_not_allowed":
      case "rate_limited":
      case "auth":
        this.h.recordToss(row.user_id, res.error, now);
        this.finish({ ...row, ...sent }, "failed", res.error, now);
        return;
      case "off":
      case "not_connected":
        this.finish({ ...row, ...sent }, "skipped", "toss_not_connected", now);
        return;
      default:
        // the token or the account could not be had: the order path was never reached
        this.h.recordToss(row.user_id, res.error, now);
        this.finish({ ...row, ...sent }, "failed", "toss_down", now);
    }
  }

  /** looked for in the order list for SEARCH_FOR_MS from the first send: it may be in */
  private lookFor(row: Row, reason: "no_answer" | "server_error", sent: Partial<Row>, now: number): void {
    const first = sent.sent_at ?? row.sent_at ?? now;
    this.show(this.save(row, { ...sent, state: "searching", reason, check_at: row.stopped_at != null ? null : now + BEAT_MS, check_until: first + SEARCH_FOR_MS }, now), {});
  }

  /**
   * Following a sent order waits out the allowed-IP pause alone: Toss refuses every call then. A 429 pause does not stop
   * it: the order reads are Toss's ORDER_HISTORY group, one read a beat at most, and the person needs the answer.
   */
  private ipPaused(userId: string, now: number): boolean {
    const s = idb.getSettings(this.h.core.db, userId);
    return !this.h.core.cfg.invest.tossBase || (s?.toss_error === "ip_not_allowed" && s.toss_paused_until != null && s.toss_paused_until > now);
  }

  /** the fill check: Toss's word for the order, or the next check */
  private async check(row: Row, now: number): Promise<void> {
    if (this.ipPaused(row.user_id, now)) return this.later(row, now);
    const r = await this.h.toss.order(row.user_id, row.toss_order_id!);
    if (!this.same(row)) return;
    if (!r.ok) {
      if (r.error === "not_connected" || r.error === "off") return this.show(this.save(row, { stopped_at: now, check_at: null }, now), {});
      this.h.recordToss(row.user_id, r.error, now);
      return this.later(row, now);
    }
    this.h.recordToss(row.user_id, null, now);
    if (!r.value) return this.later(row, now);
    this.apply(row, r.value, now);
  }

  /** what an order's Toss status means for the row */
  private apply(row: Row, o: TossOrder, now: number): void {
    const filled = o.filledQty;
    if (o.status === "FILLED") {
      this.finish({ ...row, filled_qty: filled > 0 ? filled : row.qty, avg_price: o.avgPrice, filled_at: o.filledAt ?? now }, "filled", null, now);
      return;
    }
    if (ENDED.has(o.status)) {
      if (filled > 0) this.finish({ ...row, filled_qty: filled, avg_price: o.avgPrice, filled_at: o.filledAt ?? now }, "partial_closed", null, now);
      else this.finish(row, "failed", o.status === "REJECTED" ? "rejected" : "canceled", now);
      return;
    }
    if (o.status === "PARTIAL_FILLED" && filled > 0 && filled !== row.filled_qty) {
      const next = this.save(row, { state: "partial", filled_qty: filled, avg_price: o.avgPrice }, now);
      this.show(next, {});
      this.later(next, now);
      return;
    }
    // PENDING, PENDING_CANCEL, PENDING_REPLACE, a partial with nothing new, or a status not known yet
    this.later(row, now);
  }

  /** the next fill check, or the end of checking at the session's close + 15 minutes */
  private later(row: Row, now: number): void {
    if (row.check_until != null && now >= row.check_until) {
      this.finish(row, "unknown", "no_result", now);
      return;
    }
    const fast = row.sent_at != null && now - row.sent_at < CHECK_FAST_FOR_MS;
    this.save(row, { check_at: now + (fast ? BEAT_MS : CHECK_SLOW_MS) }, now);
  }

  /** an order with no answer: the person's orders of that symbol since the send's KST day; the one it must be */
  private async search(row: Row, now: number): Promise<void> {
    const db = this.h.core.db;
    if (!this.ipPaused(row.user_id, now)) {
      const r = await this.h.toss.ordersSince(row.user_id, row.symbol, marketDate("KR", row.sent_at ?? now));
      if (!this.same(row)) return;
      this.h.recordToss(row.user_id, r.ok ? null : r.error, now);
      const since = (row.sent_at ?? now) - SEARCH_SKEW_MS;
      const found = r.ok
        ? r.value.find((o) => o.side === "SELL" && o.orderType === "MARKET" && o.qty != null && Math.abs(o.qty - row.qty!) < 1e-9 && o.orderedAt != null && o.orderedAt >= since && !idb.realOrderByTossId(db, row.user_id, o.orderId))
        : undefined;
      if (found) {
        const next = this.save(row, { state: "submitted", toss_order_id: found.orderId, reason: null, check_until: this.closeCheckEnd(row) }, now);
        // an order still open gets the "sent" banner; one already ended gets its end's
        if (found.status !== "FILLED" && !ENDED.has(found.status)) this.show(next, { notify: true });
        this.apply(next, found, now);
        return;
      }
    }
    if (row.check_until != null && now >= row.check_until) {
      this.finish(row, "unknown", row.reason ?? "no_answer", now);
      return;
    }
    this.save(row, { check_at: now + BEAT_MS }, now);
  }

  private closeCheckEnd(row: Row): number | null {
    if (!row.market_day) return null;
    const d = marketDay(marketOf(row.symbol), row.market_day, this.h.dayOverride(row.user_id));
    return d.kind === "open" ? d.session.close + CHECK_AFTER_CLOSE_MS : null;
  }

  // ───────────────────────────── rows, cards, banners, calls ─────────────────────────────

  /**
   * A person's orders on one market day stay within the symbols they hold (team-lead 2040). Read right before a row
   * becomes a send, with no wait between the read and the write: a send of another rule in flight counts.
   */
  private capped(userId: string, day: string): boolean {
    const cap = Math.max(1, this.h.heldCount(userId) ?? 1);
    return idb.realOrdersSentOn(this.h.core.db, userId, day) >= cap;
  }

  /** the row is still as this step read it (nothing else wrote it while Toss was asked) */
  private same(row: Row): boolean {
    return JSON.stringify(idb.realOrder(this.h.core.db, row.id)) === JSON.stringify(row);
  }

  /**
   * Right before a first POST, with no wait after it: the row still sending, the rule at its rev and confirmed there,
   * real mode on, the switch on. "gone": another step has the row.
   */
  private lastCheck(row: Row): "gone" | { state: "canceled" | "skipped"; code: string } | null {
    const { core } = this.h;
    const db = core.db;
    const cur = idb.realOrder(db, row.id);
    if (!cur || cur.state !== "sending" || cur.sends !== 0) return "gone";
    const r = idb.rule(db, row.user_id, row.rule_id);
    if (!r) return { state: "canceled", code: "rule_deleted" };
    if (r.rev !== row.rule_rev) return { state: "canceled", code: "rule_changed" };
    if (idb.getSettings(db, row.user_id)?.mode !== "real") return { state: "canceled", code: "disabled" };
    if (!core.cfg.invest.orders) return { state: "skipped", code: "server_off" };
    const c = idb.realConfirm(db, row.user_id, row.rule_id);
    if (!c || c.rev !== r.rev || !(c.qty > 0) || row.qty == null || row.qty > c.qty) return { state: "canceled", code: "disabled" };
    return null;
  }

  private save(row: Row, patch: Partial<Row>, now: number): Row {
    const next = { ...row, ...patch, updated_at: now };
    idb.updateRealOrder(this.h.core.db, next);
    return next;
  }

  /** an end (a skip and a cancel too): the row, its card, and the banner and call its outcome gets */
  private finish(row: Row, state: Row["state"], reason: string | null, now: number): void {
    // an order whose POST was never made frees its market day: neither the rule's day nor the person's cap is used
    const unsent = row.sends === 0;
    const next = this.save(row, { state, reason: reason ?? row.reason, check_at: null, ...(unsent ? { market_day: null } : {}) }, now);
    this.show(next, { notify: true });
  }

  /**
   * The order's card, posted the first time and rewritten after. `notify`: the banner and push this state gets (DD
   * 2044 §2), and its call (§3) when the person takes stop-result calls.
   */
  private show(row: Row, o: { notify?: boolean }): void {
    const { core } = this.h;
    const db = core.db;
    const ip = core.cfg.invest.outboundIp;
    const banner = o.notify ? realStopBanner(row) : null;
    let messageId: string;
    if (!row.message_id) {
      const card = realStopCard(row, { ip });
      const posted = this.h.post(row.user_id, card, realStopRecord(row, card), banner, row.rule_id);
      messageId = posted.messageId;
      idb.setRealOrderMessage(db, row.id, messageId, core.now());
      row.message_id = messageId;
      const alertId = this.alertOf.get(row.id);
      if (alertId) idb.setAlertMessage(db, alertId, posted.threadId, messageId);
    } else {
      messageId = row.message_id;
      const msg = db.getMessage(messageId);
      if (!msg) return;
      const before = (JSON.parse(msg.cards_json) as { type: string; call?: InvestCall }[]).find((c) => c.type === "invest_stop");
      const card = realStopCard(row, { ip, ...(before?.call ? { call: before.call } : {}) });
      db.updateMessageCards(messageId, [card] as never);
      db.setMessageLlm(messageId, [{ role: "assistant", content: realStopRecord(row, card) }]);
      publishMessage(core, messageId);
      if (banner) this.h.notify(row.user_id, banner, msg.thread_id, messageId, row.rule_id);
    }
    if (banner) idb.setAlertTitleByMessage(db, row.user_id, messageId, banner.title);
    if (o.notify && callFor(row) && this.h.stopResultCalls(row.user_id)) {
      const line = realStopCallLine(this.h.agentName(row.user_id), row, this.h.stageCall(row.user_id, core.now()), this.h.holding(row.user_id, row.symbol)?.qty);
      this.h.callLater(row.user_id, messageId, row.id, line, (c) => idb.setAlertCallByMessage(db, row.user_id, messageId, c.ok ? "ok" : c.reason ?? "failed", c.at));
    }
    void this.h.publish(row.user_id).catch(() => undefined);
  }
}

function fromGate(g: Gate): Partial<idb.RealOrderRow> {
  switch (g.kind) {
    case "send":
      return { state: "sending", qty: g.qty, sellable: g.sellable, fraction_left: g.fraction, market_day: g.session.day, check_until: g.session.close + CHECK_AFTER_CLOSE_MS };
    case "schedule":
      return { state: "scheduled", qty: g.qty, sellable: g.sellable, market_day: g.session.day, due_at: g.due, check_at: g.due };
    case "wait":
      return { state: "waiting", market_day: g.session.day, due_at: g.until, check_at: g.until };
    case "skip":
      // a skip after the sellable read keeps it: the call's "n주를 그대로 갖고 있어요" is Toss's number then (DD 2314 §4)
      return { state: "skipped", reason: g.code, ...(g.sellable != null ? { sellable: g.sellable } : {}) };
    case "cancel":
      return { state: "canceled", reason: g.code };
  }
}

/** the outcomes a call goes out for (DD 2044 §1–3, 2046-b): one per outcome; none for a wait, a step, or the person's own change */
function callFor(row: idb.RealOrderRow): boolean {
  switch (row.state) {
    case "scheduled":
    case "filled":
    case "failed":
    case "partial_closed":
    case "unknown":
    case "skipped":
      return true;
    default:
      return false;
  }
}
