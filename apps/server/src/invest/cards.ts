/**
 * Invest alert and mock stop cards, their banners and call lines (DD 1935 §2-1·2-2, 2010 §2·3·5, 2042-b §1·4, 2100
 * C1). Pure. Every figure is @pickle/quant format.ts; no card says "팔았어요" or "매도 완료" (G8-7), an alert never
 * talks about an order beyond "주문은 내지 않았어요" (A17).
 */
import type { InvestAlertCard, InvestAlertKind, InvestCall, InvestStopCard } from "@pickle/protocol";
import { atText, footLine, kst, kstWithEastern, num, pct, shares } from "@pickle/quant";
import { ieyo } from "../util.ts";
import type { Market } from "./calendar.ts";
import { SOURCE_TABLE, type SourceKey } from "./sources.ts";
import { actionText, dayWords, eulReul, iGa, INTRADAY_ONLY, kindWord, money, moneyNum, noPriorLine, ruleLeft, zoneText, type PriorReason, type RuleSpec } from "./rules.ts";

export interface Holding {
  qty: number;
  avgPrice: number | null;
}

export interface Observation {
  price: number;
  prevClose: number | null;
  at: number;
  source: SourceKey;
}

export interface AlertInput {
  alertId: string;
  ruleId: string;
  rule: RuleSpec;
  market: Market;
  mode: "mock" | "real";
  obs: Observation;
  now: number;
  holding: Holding | null;
  noPrior: PriorReason | null;
  /** the rule alerted once and stopped */
  paused: boolean;
  /** target: the next level's price, when that rule exists */
  nextTarget: { level: number; price: number } | null;
  /** the symbol's stop line, for the call's "so what" (G7 ③) */
  stopPrice: number | null;
  /** real mode, a stop judged on intraday prices because no ATR was known (team-lead 2052: never a silent change) */
  intradayOnly?: boolean;
  call?: InvestCall;
}

export function alertKind(r: Pick<RuleSpec, "kind">): InvestAlertKind {
  switch (r.kind) {
    case "stop":
      return "stop_alert";
    case "target":
      return "target";
    case "buy_zone":
      return "buy_zone_met";
    case "resistance":
      return "breakout";
    case "invalidate":
      return "invalidated";
    default:
      return "custom";
  }
}

function levelLabel(r: RuleSpec): string {
  switch (r.kind) {
    case "stop":
      return "손절선";
    case "target":
      return r.level ? `${r.level}차 익절가` : "익절가";
    case "resistance":
      return "저항";
    case "invalidate":
      return "무효화 가격";
    default:
      return "알림 가격";
  }
}

/** the observation's foot: 관측 11월 27일 00:45(미 동부 10:45) · 토스증권 · A (KR: KST only) */
export function obsFoot(market: Market, o: Pick<Observation, "at" | "source">): string {
  const s = SOURCE_TABLE[o.source];
  return footLine(market === "US" ? kstWithEastern(o.at) : kst(o.at), s.name, s.grade);
}

function changeText(o: Observation): string | null {
  if (o.prevClose == null || !(o.prevClose > 0)) return null;
  return `전일 대비 ${pct((o.price / o.prevClose - 1) * 100)}`;
}

/** "손절선보다 $0.18 아래" / "매수 검토 구간 안" */
function distanceText(market: Market, r: RuleSpec, price: number): string {
  if (r.kind === "buy_zone") return "매수 검토 구간 안";
  const level = r.price!;
  const diff = Math.round((price - level) * (market === "US" ? 100 : 1)) / (market === "US" ? 100 : 1);
  if (diff === 0) return `${levelLabel(r)} 가격`;
  return `${levelLabel(r)}보다 ${money(market, Math.abs(diff))} ${diff < 0 ? "아래" : "위"}`;
}

function holdingRow(market: Market, h: Holding, price: number): string {
  const qty = shares(h.qty);
  if (h.avgPrice == null || !(h.avgPrice > 0)) return qty;
  return `${qty} · 평단 ${money(market, h.avgPrice)} 대비 ${pct((price / h.avgPrice - 1) * 100)}`;
}

function alertTitle(i: AlertInput): { title: string; lines: string[] } {
  const r = i.rule;
  const sym = r.symbol;
  const m = i.market;
  const lines: string[] = [];
  let title: string;
  switch (alertKind(r)) {
    case "stop_alert":
      title = `${iGa(sym)} 손절 관찰가에 닿았어요`;
      break;
    case "target":
      title = `${iGa(sym)} ${kindWord("target", r.level)} 관찰가에 닿았어요`;
      break;
    case "buy_zone_met":
      title = `${iGa(sym)} 매수 검토 구간에 들어왔어요`;
      break;
    case "breakout":
      title = i.noPrior ? `${iGa(sym)} 저항 ${money(m, r.price!)} 위에 있어요` : `${iGa(sym)} 저항 ${eulReul(money(m, r.price!))} 넘었어요`;
      break;
    case "invalidated":
      title = `${sym} 전략이 더는 맞지 않아요`;
      lines.push(`${money(m, i.obs.price)}${r.direction === "above" ? "까지 올라왔어요." : "까지 내려왔어요."}`, "전략을 다시 봐야 해요");
      break;
    default:
      title = r.direction === "above" ? `${iGa(sym)} ${money(m, r.price!)} 위로 올라갔어요` : `${iGa(sym)} ${money(m, r.price!)} 아래로 내려갔어요`;
  }
  if (i.noPrior) lines.unshift(noPriorLine(i.noPrior, r));
  return { title, lines };
}

/** DD 1935 §2-1 tone: danger for stop alerts, invalidation and a custom price below; none otherwise */
function alertTone(r: RuleSpec): "danger" | "caution" | undefined {
  if (r.kind === "stop" || r.kind === "invalidate") return "danger";
  if (r.kind === "alert" && r.direction === "below") return "danger";
  return undefined;
}

export function alertCard(i: AlertInput): InvestAlertCard {
  const r = i.rule;
  const m = i.market;
  const { title, lines } = alertTitle(i);
  const sub = [changeText(i.obs), distanceText(m, r, i.obs.price)].filter(Boolean).join(" · ");
  const rows: { label: string; value: string }[] = [{ label: "규칙", value: `${ruleLeft(m, r)} · ${actionText(r.action, i.mode)}` }];
  if (i.holding) rows.push({ label: "보유", value: holdingRow(m, i.holding, i.obs.price) });
  rows.push({ label: "시장", value: "확인 불가" });
  if (r.kind === "target" && i.nextTarget)
    rows.push({ label: "다음", value: `${i.nextTarget.level}차 익절 ${money(m, i.nextTarget.price)}까지 ${pct((i.nextTarget.price / i.obs.price - 1) * 100)}` });
  const notes: string[] = [];
  if (r.kind === "stop") {
    if (!i.holding) notes.push("보유 중일 때 해당하는 알림이에요.");
    notes.push("주문은 내지 않았어요.");
    if (i.intradayOnly) notes.push(INTRADAY_ONLY);
  }
  if (i.paused) notes.push("이 규칙은 한 번 알리고 멈췄어요.");
  const tone = alertTone(r);
  return {
    type: "invest_alert",
    alertId: i.alertId,
    ruleId: i.ruleId,
    symbol: r.symbol,
    kind: alertKind(r),
    ...(r.kind === "target" && r.level ? { level: r.level as 1 | 2 | 3 } : {}),
    ...(i.noPrior ? { noPrior: true as const } : {}),
    ...(tone ? { tone } : {}),
    title,
    ...(lines.length ? { titleLines: lines } : {}),
    at: i.obs.at,
    atText: atText(i.obs.at, i.now),
    price: moneyNum(m, i.obs.price),
    sub,
    rows,
    ...(i.call ? { call: i.call } : {}),
    notes,
    foot: obsFoot(m, i.obs),
    disclaimer: true,
  };
}

/** the expiry alert (DD 2010 §2): no price, no sub, no glyph */
export function expiredCard(i: { alertId: string; ruleId: string; rule: RuleSpec; market: Market; mode: "mock" | "real"; createdAt: number; at: number; now: number; call?: InvestCall }): InvestAlertCard {
  const r = i.rule;
  const until = r.until_day!;
  const start = new Date(i.createdAt + 9 * 3_600_000);
  return {
    type: "invest_alert",
    alertId: i.alertId,
    ruleId: i.ruleId,
    symbol: r.symbol,
    kind: "expired",
    title: `${r.symbol} 감시 기간이 끝났어요`,
    titleLines: [`${dayWords(until)}까지였던 ${kindWord(r.kind, r.level)} 알림을 더 보지 않아요.`],
    at: i.at,
    atText: atText(i.at, i.now),
    rows: [
      { label: "규칙", value: `${ruleLeft(i.market, r)} · ${actionText(r.action, i.mode)}` },
      { label: "기간", value: `${start.getUTCMonth() + 1}월 ${start.getUTCDate()}일–${dayWords(until)}` },
      { label: "시장", value: "확인 불가" },
    ],
    ...(i.call ? { call: i.call } : {}),
    notes: [],
    foot: `확인 ${i.market === "US" ? kstWithEastern(i.at) : kst(i.at)}`,
    disclaimer: true,
  };
}

export interface StopInput {
  orderId: string;
  ruleId: string;
  rule: RuleSpec;
  market: Market;
  obs: Observation;
  now: number;
  /** sellable quantity at the moment (null: not known) */
  qty: number | null;
  avgPrice: number | null;
  /** as AlertInput.intradayOnly */
  intradayOnly?: boolean;
  call?: InvestCall;
}

/** the mock stop record (DD 1935 §2-2): recorded with a quantity, recorded without one, or skipped at zero sellable */
export function mockStopCard(i: StopInput): InvestStopCard {
  const m = i.market;
  const stop = i.rule.price!;
  const rows: { label: string; value: string }[] = [{ label: "손절선", value: money(m, stop) }];
  const notes: string[] = [];
  let title: string;
  let state: InvestStopCard["state"] = "recorded";
  let reason: InvestStopCard["reason"];
  if (i.qty === 0) {
    state = "skipped";
    title = "팔 수 있는 수량이 0주라서 주문을 내지 않았어요";
    reason = { code: "zero_sellable", text: title };
  } else if (i.qty == null) {
    title = "손절선 아래로 내려간 시점을 기록했어요";
    notes.push("보유 수량을 몰라서 수량 없이 기록했어요.");
  } else {
    title = `실제 주문이었다면 ${shares(i.qty)}를 팔았을 거예요`;
    rows.push({ label: "수량", value: shares(i.qty) });
    rows.push({ label: "예상 금액", value: `약 ${money(m, i.qty * i.obs.price)}(추정, 관측가 기준)` });
    if (i.avgPrice != null && i.avgPrice > 0) rows.push({ label: "평단 대비", value: pct((i.obs.price / i.avgPrice - 1) * 100) });
    notes.push("주문은 내지 않았어요.");
  }
  if (i.intradayOnly) notes.push(INTRADAY_ONLY);
  return {
    type: "invest_stop",
    orderId: i.orderId,
    ruleId: i.ruleId,
    symbol: i.rule.symbol,
    mode: "mock",
    state,
    title,
    hero: moneyNum(m, i.obs.price),
    rows,
    ...(reason ? { reason } : {}),
    notes,
    ...(i.call ? { call: i.call } : {}),
    foot: obsFoot(m, i.obs),
    disclaimer: true,
  };
}

// ───────────────────────────── banners ─────────────────────────────

/** the in-app banner (DD 1935 §2-1, 2010 §2·3): amounts are fine here — the lock-screen push (B1c) is title only */
export function alertBanner(i: AlertInput): { title: string; body: string } {
  const r = i.rule;
  const m = i.market;
  const p = money(m, i.obs.price);
  const level = r.kind === "buy_zone" ? zoneText(m, r.lo!, r.hi!) : money(m, r.price!);
  switch (alertKind(r)) {
    case "stop_alert":
      return { title: `${r.symbol} 손절 관찰가 도달`, body: `${p} · 손절선 ${level} · 주문은 내지 않았어요` };
    case "target":
      return { title: `${r.symbol} ${kindWord("target", r.level)} 관찰가 도달`, body: `${p} · ${levelLabel(r)} ${level}` };
    case "buy_zone_met":
      return { title: `${r.symbol} 매수 검토 구간 진입`, body: `${p} · 매수 검토 ${level}` };
    case "breakout":
      return i.noPrior
        ? { title: `${r.symbol} 저항 위`, body: `${p} · 저항 ${level} · 감시 시작 때부터 위` }
        : { title: `${r.symbol} 저항 돌파`, body: `${p} · 저항 ${level}` };
    case "invalidated":
      return { title: `${r.symbol} 전략 다시 보기`, body: `${p} · 무효화 가격 ${level}` };
    default:
      return { title: `${r.symbol} 내가 정한 가격 도달`, body: `${p} · 알림 가격 ${level}` };
  }
}

export function expiredBanner(r: RuleSpec, market: Market): { title: string; body: string } {
  return { title: `${r.symbol} 감시 기간 끝`, body: `${ruleLeft(market, r)} 알림을 더 보지 않아요` };
}

export function stopBanner(r: RuleSpec, market: Market, card: InvestStopCard): { title: string; body: string } {
  const p = card.hero.text;
  if (card.state === "skipped") return { title: `${r.symbol} 손절 주문 건너뜀`, body: `${p} · 팔 수 있는 수량 0주` };
  return { title: `${r.symbol} 모의 손절 기록`, body: `${p} · 손절선 ${money(market, r.price!)} · 주문은 내지 않았어요` };
}

/** the lock-screen title of the blind banner (DD 2042-b §4); the other push titles are their banners' titles */
export const BLIND_PUSH_TITLE = "시세 확인 멈춤";

export const BLIND_BANNER = (since: number) => ({
  title: "시세를 받지 못하고 있어요",
  body: `${kstClock(since)}부터 가격 확인이 멈췄어요. 손절선 확인도 멈춰 있어요.`,
});

function kstClock(ms: number): string {
  const d = new Date(ms + 9 * 3_600_000);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

// ───────────────── calls (G7: what, at what price, so what, the market — 30 seconds; never advice or the disclaimer) ─────────────────

function spoken(market: Market, x: number): string {
  return market === "US" ? `${num(x, 2)}달러` : `${num(x)}원`;
}

/** G7 ③: where the price stands against the stop, and the holding against its average price (spoken: no signs) */
function spokenPosition(market: Market, price: number, stop: number | null, holding: Holding | null): string[] {
  const out: string[] = [];
  if (stop != null) {
    const d = Math.round((price - stop) * 100) / 100;
    out.push(d === 0 ? `손절선 ${spoken(market, stop)}과 같은 가격이에요.` : `손절선 ${spoken(market, stop)}보다 ${spoken(market, Math.abs(d))} ${d > 0 ? "위" : "아래"}예요.`);
  }
  if (holding && holding.avgPrice != null && holding.avgPrice > 0) {
    const v = (price / holding.avgPrice - 1) * 100;
    out.push(`보유한 ${num(holding.qty)}주는 평단보다 ${num(Math.abs(v), 2)}% ${v >= 0 ? "높아요" : "낮아요"}.`);
  }
  return out;
}

/** G7 ④: B1 reads no market state, and says so */
const MARKET_UNKNOWN = "시장 상태는 이번에는 확인하지 못했어요.";

export function alertCallLine(agentName: string, i: AlertInput): string {
  const r = i.rule;
  const m = i.market;
  let what: string;
  switch (alertKind(r)) {
    case "stop_alert":
      what = `${iGa(r.symbol)} 손절 관찰가 ${spoken(m, r.price!)}에 닿았어요.`;
      break;
    case "target":
      what = `${iGa(r.symbol)} ${kindWord("target", r.level)} 관찰가 ${spoken(m, r.price!)}에 닿았어요.`;
      break;
    case "buy_zone_met":
      what = `${iGa(r.symbol)} 매수 검토 구간 ${spoken(m, r.lo!)}에서 ${spoken(m, r.hi!)} 사이에 들어왔어요.`;
      break;
    default:
      what = `${iGa(r.symbol)} ${levelLabel(r)} ${spoken(m, r.price!)}에 닿았어요.`;
  }
  const parts = [`${ieyo(agentName)}. 투자 알림이에요.`, what, `지금 가격은 ${spoken(m, i.obs.price)}예요.`];
  parts.push(...spokenPosition(m, i.obs.price, r.kind === "stop" ? null : i.stopPrice, i.holding));
  if (r.kind === "stop") parts.push("주문은 내지 않았어요.");
  parts.push(MARKET_UNKNOWN);
  return parts.join(" ");
}

export function stopCallLine(agentName: string, r: RuleSpec, market: Market, card: InvestStopCard, price: number, holding: Holding | null): string {
  if (card.state === "skipped") return `${ieyo(agentName)}. ${iGa(r.symbol)} 손절선 ${spoken(market, r.price!)}에 닿았는데, 팔 수 있는 수량이 0주라서 주문을 내지 않았어요. ${MARKET_UNKNOWN}`;
  return [
    `${ieyo(agentName)}. 모의 손절을 기록했어요.`,
    `${iGa(r.symbol)} 손절선 ${spoken(market, r.price!)} 아래인 ${spoken(market, price)}에 닿았어요.`,
    ...spokenPosition(market, price, null, holding),
    "모의 주문이라 실제 주문은 내지 않았어요.",
    MARKET_UNKNOWN,
  ].join(" ");
}

export function expiredCallLine(agentName: string, r: RuleSpec): string {
  return `${ieyo(agentName)}. ${r.symbol}의 ${kindWord(r.kind, r.level)} 알림 기간이 끝나서 더 보지 않아요.`;
}

/** the card's call line (DD 2010 §5) */
export function callText(c: { ok: true; at: number } | { ok: false; at: number; reason: "not_verified" | "not_configured" | "daily_limit" | "failed" }): InvestCall {
  const clock = kstClock(c.at);
  if (c.ok) return { at: c.at, ok: true, text: `전화로 알렸어요 · ${clock}` };
  const why = { not_verified: "번호를 인증하지 않았어요", not_configured: "지금은 전화를 걸 수 없어요", daily_limit: "오늘 투자 전화 10통을 다 썼어요", failed: clock }[c.reason];
  return { at: c.at, ok: false, reason: c.reason, text: `전화를 걸지 못했어요 · ${why}` };
}

