/**
 * Invest alert and mock stop cards, their banners and call lines (DD 1935 §2-1·2-2, 2010 §2·3·5, 2042-b §1·4, 2100
 * C1). Pure. Every figure is @pickle/quant format.ts; no card says "팔았어요" or "매도 완료" (G8-7), an alert never
 * talks about an order beyond "주문은 내지 않았어요" (A17).
 */
import type { InvestAlertCard, InvestAlertKind, InvestCall, InvestStopCard, InvestStopReason } from "@pickle/protocol";
import { atText, footLine, kst, kstWithEastern, num, pct, rate, shares } from "@pickle/quant";
import { ieyo } from "../util.ts";
import { marketDate, marketOf, type Market } from "./calendar.ts";
import type { RealOrderRow } from "./db.ts";
import type { Gap, Run, Split } from "./intraday.ts";
import { SOURCE_TABLE, type SourceKey } from "./sources.ts";
import { actionText, dayWords, eulReul, eunNeun, iGa, INTRADAY_ONLY, kindWord, money, moneyNum, noPriorLine, ruleLeft, zoneText, type PriorReason, type RuleSpec } from "./rules.ts";

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
  /** the `시장` row (stages.ts stageRowText); 확인 불가 when absent */
  stageRow?: string;
  /** the call's market sentence (stages.ts stageCallText); the could-not-check line when absent */
  stageCall?: string;
  /** the buy zone's `다음` row: the person's 1st target on this symbol, if any (with stopPrice) */
  firstTarget?: number | null;
}

export function alertKind(r: Pick<RuleSpec, "kind">): InvestAlertKind {
  switch (r.kind) {
    case "stop":
      return "stop_alert";
    case "target":
      return "target";
    case "buy_zone":
      // price alone (team-lead 0747 8a: the market half is not checked) → the entry waits; buy_zone_met is for later
      return "buy_zone_wait";
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

/** 과 after a final consonant, 와 after a vowel (a label's last syllable) */
function gwaWa(word: string): string {
  const c = word.charCodeAt(word.length - 1) - 0xac00;
  return `${word}${c >= 0 && c <= 11171 && c % 28 === 0 ? "와" : "과"}`;
}

/** "손절선보다 $0.18 아래" / "손절선과 같은 가격" / "1차 익절가와 같은 가격" / "매수 검토 구간 안" (DD 2237 §1) */
function distanceText(market: Market, r: RuleSpec, price: number): string {
  if (r.kind === "buy_zone") return "매수 검토 구간 안";
  const level = r.price!;
  const diff = Math.round((price - level) * (market === "US" ? 100 : 1)) / (market === "US" ? 100 : 1);
  if (diff === 0) return `${gwaWa(levelLabel(r))} 같은 가격`;
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
    case "buy_zone_wait":
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

/** DD 1935 §2-1 tone: danger for stop alerts, invalidation and a custom price below; caution for the buy zone (DD 0847
 * 1, A16's middle frame); none otherwise */
function alertTone(r: RuleSpec): "danger" | "caution" | undefined {
  if (r.kind === "stop" || r.kind === "invalidate") return "danger";
  if (r.kind === "buy_zone") return "caution";
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
  if (r.kind === "buy_zone") {
    // A16's middle frame (DD 0847 1): the entry waits on what is not checked here; then the person's own next prices
    rows.push({ label: "진입 조건", value: "확인 대기 · 가격 구간 도달" });
    const next = [i.stopPrice != null ? `손절 ${money(m, i.stopPrice)}` : null, i.firstTarget != null ? `1차 익절 ${money(m, i.firstTarget)}` : null].filter((s): s is string => !!s);
    if (next.length) rows.push({ label: "다음", value: next.join(" · ") });
  }
  rows.push({ label: "시장", value: i.stageRow ?? "확인 불가" });
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
export function expiredCard(i: { alertId: string; ruleId: string; rule: RuleSpec; market: Market; mode: "mock" | "real"; createdAt: number; at: number; now: number; call?: InvestCall; stageRow?: string }): InvestAlertCard {
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
      { label: "시장", value: i.stageRow ?? "확인 불가" },
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
    case "buy_zone_wait":
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

// ───────────────────────────── B2c-2: gap, a run above the buy zone, split (DD 0847 2–4) ─────────────────────────────

/** `ATR 1.3배` (DD 0847: the screen says the multiple; the 14 days are the contract's) */
const atrWord = (atrs: number) => `ATR ${num(atrs, 1)}배`;

export interface GapInput {
  alertId: string;
  symbol: string;
  market: Market;
  gap: Gap;
  open: number;
  prevClose: number;
  /** the previous close's market day */
  prevDay: string;
  obs: Pick<Observation, "at" | "source">;
  now: number;
  stageRow: string;
}

/** a big gap at the open (A14 급격한 갭; caution both ways: A17's big gap is a risk either way) */
export function gapCard(i: GapInput): InvestAlertCard {
  const m = i.market;
  const p = rate(i.gap.pct, 1);
  return {
    type: "invest_alert",
    alertId: i.alertId,
    symbol: i.symbol,
    kind: "gap",
    tone: "caution",
    title: `${iGa(i.symbol)} 전일 종가보다 ${p} ${i.gap.up ? "높게" : "낮게"} 시작했어요`,
    at: i.obs.at,
    atText: atText(i.obs.at, i.now),
    price: moneyNum(m, i.open),
    rows: [
      { label: "시가", value: money(m, i.open) },
      { label: "전일 종가", value: `${money(m, i.prevClose)} · ${dayWords(i.prevDay)}` },
      { label: "갭", value: `${p} · ${atrWord(i.gap.atrs)}` },
      { label: "시장", value: i.stageRow },
    ],
    notes: [],
    foot: obsFoot(m, i.obs),
    disclaimer: true,
  };
}

export function gapBanner(i: GapInput): { title: string; body: string } {
  return { title: `${i.symbol} 갭 ${i.gap.up ? "상승" : "하락"} 출발`, body: `시가 ${money(i.market, i.open)} · 전일 종가 대비 ${rate(i.gap.pct, 1)}` };
}

export interface RunInput {
  alertId: string;
  ruleId: string;
  rule: RuleSpec;
  market: Market;
  mode: "mock" | "real";
  run: Run;
  obs: Observation;
  now: number;
  stageRow: string;
}

/** A14 추격 금지: no buy signal, the strategy to look at again; the word 추격 is never on the screen (DD 0847 2) */
export function runCard(i: RunInput): InvestAlertCard {
  const r = i.rule;
  const m = i.market;
  return {
    type: "invest_alert",
    alertId: i.alertId,
    ruleId: i.ruleId,
    symbol: r.symbol,
    kind: "chase",
    tone: "caution",
    title: `${iGa(r.symbol)} 매수 검토 구간 위로 크게 벗어났어요`,
    titleLines: [`${money(m, i.obs.price)}까지 올라왔어요.`, "전략을 다시 봐야 해요."],
    at: i.obs.at,
    atText: atText(i.obs.at, i.now),
    price: moneyNum(m, i.obs.price),
    rows: [
      { label: "규칙", value: `${ruleLeft(m, r)} · ${actionText(r.action, i.mode)}` },
      { label: "벗어난 폭", value: `구간 위 ${money(m, i.run.over)} · ${rate(i.run.pct, 1)} · ${atrWord(i.run.atrs)}` },
      { label: "시장", value: i.stageRow },
    ],
    notes: [],
    foot: obsFoot(m, i.obs),
    disclaimer: true,
  };
}

export function runBanner(i: RunInput): { title: string; body: string } {
  return { title: `${i.rule.symbol} 매수 검토 구간 크게 벗어남`, body: `${money(i.market, i.obs.price)} · 매수 검토 ${zoneText(i.market, i.rule.lo!, i.rule.hi!)}` };
}

export interface SplitInput {
  alertId: string;
  symbol: string;
  market: Market;
  split: Split;
  /** the last price this server saw on the previous market day */
  seen: { price: number; day: string };
  prevClose: number;
  obs: Pick<Observation, "at" | "source">;
  /** the rules the server stopped */
  held: number;
  now: number;
}

/** a split or a merge read from the prices (DD 0847 4): what the server did comes first; no price is changed */
export function splitCard(i: SplitInput): InvestAlertCard {
  const m = i.market;
  const s = SOURCE_TABLE[i.obs.source as SourceKey];
  return {
    type: "invest_alert",
    alertId: i.alertId,
    symbol: i.symbol,
    kind: "split",
    tone: "danger",
    title: `${i.symbol} 가격 규칙을 멈췄어요`,
    // a ratio worked out from prices: 보여요; never 1:10 or 2:1 (which way they read is unclear)
    titleLines: [i.split.kind === "merge" ? `${i.split.ratio}주가 1주로 합쳐진 것으로 보여요.` : `1주가 ${i.split.ratio}주로 나뉜 것으로 보여요.`, "규칙을 열어 저장하면 다시 봐요."],
    at: i.obs.at,
    atText: atText(i.obs.at, i.now),
    rows: [
      { label: "지난 거래일에 본 가격", value: `${money(m, i.seen.price)} · ${dayWords(i.seen.day)}` },
      { label: "전일 종가", value: `${money(m, i.prevClose)} · ${s?.name ?? i.obs.source} · ${s?.grade ?? ""}`.replace(/ · $/, "") },
      { label: "멈춘 규칙", value: `${i.held}개` },
    ],
    notes: ["규칙 가격은 바꾸지 않았어요."],
    foot: obsFoot(m, i.obs),
    disclaimer: true,
  };
}

export function splitBanner(i: SplitInput): { title: string; body: string } {
  return { title: `${i.symbol} 가격 규칙 멈춤`, body: `분할이나 병합으로 보여요 · 규칙 ${i.held}개` };
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

/** a price said aloud: dollars without trailing zeros (30달러, 30.5달러: DD 2237 §2), won as they are; screens keep
 * two decimals */
function spoken(market: Market, x: number): string {
  return market === "US" ? `${num(x, 2).replace(/\.(\d*?)0+$/, (_m, keep: string) => (keep ? `.${keep}` : ""))}달러` : `${num(x)}원`;
}

/** G7 ③: where the price stands against the stop, and the holding against its average price (spoken: no signs) */
function spokenPosition(market: Market, price: number, stop: number | null, holding: Holding | null): string[] {
  const out: string[] = [];
  if (stop != null) {
    const d = Math.round((price - stop) * 100) / 100;
    out.push(d === 0 ? `손절선 ${gwaWa(spoken(market, stop))} 같은 가격이에요.` : `손절선 ${spoken(market, stop)}보다 ${spoken(market, Math.abs(d))} ${d > 0 ? "위" : "아래"}예요.`);
  }
  if (holding && holding.avgPrice != null && holding.avgPrice > 0) {
    const v = (price / holding.avgPrice - 1) * 100;
    out.push(`보유한 ${num(holding.qty)}주는 평단보다 ${num(Math.abs(v), 2)}% ${v >= 0 ? "높아요" : "낮아요"}.`);
  }
  return out;
}

/** G7 ④: no current stage reading (off, none, stale) → the call says so */
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
    case "buy_zone_wait":
      what = `${iGa(r.symbol)} 매수 검토 구간 ${spoken(m, r.lo!)}에서 ${spoken(m, r.hi!)} 사이에 들어왔어요.`;
      break;
    default:
      what = `${iGa(r.symbol)} ${levelLabel(r)} ${spoken(m, r.price!)}에 닿았어요.`;
  }
  const parts = [`${ieyo(agentName)}. 투자 알림이에요.`, what, `지금 가격은 ${spoken(m, i.obs.price)}예요.`];
  parts.push(...spokenPosition(m, i.obs.price, r.kind === "stop" ? null : i.stopPrice, i.holding));
  if (r.kind === "stop") parts.push("주문은 내지 않았어요.");
  parts.push(i.stageCall ?? MARKET_UNKNOWN);
  return parts.join(" ");
}

export function stopCallLine(agentName: string, r: RuleSpec, market: Market, card: InvestStopCard, price: number, holding: Holding | null, stageCall?: string): string {
  const marketLine = stageCall ?? MARKET_UNKNOWN;
  if (card.state === "skipped") return `${ieyo(agentName)}. ${iGa(r.symbol)} 손절선 ${spoken(market, r.price!)}에 닿았는데, 팔 수 있는 수량이 0주라서 주문을 내지 않았어요. ${marketLine}`;
  return [
    `${ieyo(agentName)}. 모의 손절을 기록했어요.`,
    `${iGa(r.symbol)} 손절선 ${spoken(market, r.price!)} 아래인 ${spoken(market, price)}에 닿았어요.`,
    ...spokenPosition(market, price, null, holding),
    "모의 주문이라 실제 주문은 내지 않았어요.",
    marketLine,
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
// ───────────────────────────── B3a: real stop orders (DD 1935 §2-2, 2044, 2046-b) ─────────────────────────────

/** 47주, 0.35주: an order's quantity, fractions as Toss takes them (up to 6 decimals) */
export function qtyWords(q: number): string {
  if (Number.isInteger(q)) return shares(q);
  const d = Math.min(6, (String(Number(q.toFixed(6))).split(".")[1] ?? "").length);
  return `${num(q, d)}주`;
}

/** a skip's title, which is its reason (DD 1935 §2-2, 2044 1-5, 2314 §1) */
const SKIP_TITLE: Readonly<Record<string, string>> = {
  not_confirmed: "실제 매도로 확인하지 않은 손절이라 주문을 내지 않았어요",
  ip_paused: "토스증권이 이 서버의 접속을 막고 있어서 주문을 내지 않았어요(허용 IP)",
  rate_paused: "토스증권이 잠시 요청을 막고 있어서 주문을 내지 않았어요",
  toss_not_connected: "토스증권 연결이 없어서 주문을 내지 않았어요",
  server_off: "실제 주문이 잠시 멈춰 있어서 주문을 내지 않았어요",
  early_close: "조기 폐장일이라 시장가 주문을 내지 않았어요",
  off_hours: "정규장 시간이 아니라서 주문을 내지 않았어요",
  zero_sellable: "팔 수 있는 수량이 0주라서 주문을 내지 않았어요",
  calendar_unknown: "장 운영 정보를 확인하지 못해서 주문을 내지 않았어요",
  // the person's day cap (held symbols) and the rule's one order a market day
  daily_limit: "실제 주문은 하루에 보유 종목 수까지라 주문을 내지 않았어요",
  rule_day: "손절 주문은 규칙마다 하루 한 번이라 주문을 내지 않았어요",
  fraction_hours: "마감 1시간 전부터는 소수 주를 시장가로 팔 수 없어서 주문을 내지 않았어요",
  sellable_unknown: "토스증권에서 팔 수 있는 수량을 받지 못해서 주문을 내지 않았어요",
  // the person's change landed while Toss was being asked, before the first send: no banner, no call
  rule_changed: "손절 규칙이 바뀌어서 주문을 내지 않았어요",
  rule_deleted: "손절 규칙을 지워서 주문을 내지 않았어요",
  disabled: "실제 주문을 꺼서 주문을 내지 않았어요",
  confirm_changed: "실제 매도 확인이 바뀌어서 주문을 내지 않았어요",
  key_removed: "토스증권 연결을 지워서 주문을 내지 않았어요",
};

/** a planned order (scheduled, or waiting out a 429 pause) that does not go out (DD 2044 1-2, 2046-b) */
const PLANNED_TITLE: Readonly<Record<string, string>> = {
  disabled: "실제 주문을 꺼서 예정된 주문을 내지 않았어요",
  confirm_changed: "실제 매도 확인이 바뀌어서 예정된 주문을 내지 않았어요",
  rule_changed: "손절 규칙이 바뀌어서 예정된 주문을 내지 않았어요",
  rule_deleted: "손절 규칙을 지워서 예정된 주문을 내지 않았어요",
  key_removed: "토스증권 연결을 지워서 예정된 주문을 내지 않았어요",
  zero_sellable: "팔 수 있는 수량이 0주라서 예정된 주문을 내지 않았어요",
  early_close: "조기 폐장일이라 예정된 주문을 내지 않았어요",
  server_off: "실제 주문이 잠시 멈춰 있어서 예정된 주문을 내지 않았어요",
};

/** a failed order's reason line (DD 1935 §2-2, 2044 1-4, 2314 §1: the settings' Toss words, never "키") */
const FAIL_TEXT: Readonly<Record<string, string>> = {
  ip_not_allowed: "토스증권이 이 서버의 접속을 막았어요(허용 IP).",
  rate_limited: "토스증권이 잠시 요청을 막아서 주문이 들어가지 않았어요.",
  rejected: "토스증권이 주문을 거절했어요",
  auth: "토스증권 연결이 끊겨서 주문이 들어가지 않았어요.",
  toss_down: "토스증권에 연결하지 못해서 주문이 들어가지 않았어요.",
  canceled: "토스증권에서 주문이 취소돼서 체결되지 않았어요.",
};

const IP_FIX = "토스증권 설정에서 이 IP를 다시 허용해 주세요.";
const AUTH_FIX = "투자 설정에서 토스증권 연결을 확인해 주세요.";
const NOT_AGAIN = "주문을 다시 내지 않았어요.";
const UNKNOWN_TITLE = "손절 주문 결과를 확인하지 못했어요";
/** why the result is not known (DD 2044 1-3); `no_result` (DD 2314 §1): no end by the close + 15 minutes */
const UNKNOWN_WHY: Readonly<Record<string, string>> = {
  no_answer: "토스증권이 답하지 않아서, 주문이 들어갔는지 알 수 없어요.",
  server_error: "토스증권이 오류로 답해서, 주문이 들어갔는지 알 수 없어요.",
  no_result: "마감 뒤에도 토스증권에서 주문이 끝났다는 답을 받지 못했어요.",
};
const STOPPED = "토스증권 연결을 지워서 체결 확인을 멈췄어요. 토스증권 앱에서 확인해 주세요.";

/** the title a skipped or dropped order shows */
function skipTitle(o: RealOrderRow): string {
  const code = o.reason ?? "";
  return (o.due_at != null ? PLANNED_TITLE[code] : undefined) ?? SKIP_TITLE[code] ?? "손절 주문을 내지 않았어요";
}

const signedMoney = (m: Market, d: number) => (d > 0 ? `+${money(m, d)}` : money(m, d));

/** the real stop card for an order row, in whatever state it is (DD 1935 §2-2, 2044 §1, 2046-b) */
export function realStopCard(o: RealOrderRow, x: { ip: string | null; call?: InvestCall }): InvestStopCard {
  const card = realStopCardOf(o, x);
  // real mode with no ATR: the stop was judged on intraday prices alone, and every state of the card says so
  if (o.intraday_only) card.notes.push(INTRADAY_ONLY);
  return card;
}

function realStopCardOf(o: RealOrderRow, x: { ip: string | null; call?: InvestCall }): InvestStopCard {
  const m = marketOf(o.symbol);
  const qty = o.qty ?? o.confirmed_qty;
  const filled = o.filled_qty ?? 0;
  const left = qty != null ? Math.max(0, Number((qty - filled).toFixed(6))) : null;
  const stopRow = { label: "손절선", value: money(m, o.stop_price) };
  const orderRow = qty != null ? [{ label: "주문", value: `${qtyWords(qty)} · 시장가` }] : [];
  const sentOrder = qty != null ? [{ label: "주문", value: `${qtyWords(qty)} · 시장가 · 정규장` }] : [];
  const idRow = o.toss_order_id ? [{ label: "주문 번호", value: `…${o.toss_order_id.slice(-4)}` }] : [];
  const sentRow = o.sent_at != null ? [{ label: "낸 시각", value: kst(o.sent_at) }] : [];
  const extra = o.sellable != null && o.confirmed_qty != null && o.sellable > o.confirmed_qty ? Number((o.sellable - o.confirmed_qty).toFixed(6)) : 0;
  const base = {
    type: "invest_stop" as const,
    orderId: o.id,
    ruleId: o.rule_id,
    symbol: o.symbol,
    mode: "real" as const,
    hero: moneyNum(m, o.observed_price),
    ...(x.call ? { call: x.call } : {}),
    foot: obsFoot(m, { at: o.observed_at, source: o.source as SourceKey }),
    disclaimer: true as const,
  };
  const keepNotes = (done: boolean) => [
    ...(extra > 0 && o.confirmed_qty != null ? [done ? `확인한 ${qtyWords(o.confirmed_qty)}만 팔았어요. 늘어난 ${qtyWords(extra)}는 그대로 있어요.` : `확인한 ${qtyWords(o.confirmed_qty)}만 팔아요. 그 뒤 늘어난 ${qtyWords(extra)}는 팔지 않아요.`] : []),
    ...(o.fraction_left ? [`${qtyWords(o.fraction_left)}는 마감 1시간 전부터 시장가로 팔 수 없어서 ${done ? "남겼어요." : "남겨요."}`] : []),
  ];
  const stopped = o.stopped_at != null ? { status: STOPPED, glyph: "caution" as const } : null;
  switch (o.state) {
    case "waiting":
      return { ...base, state: "waiting", title: "손절 주문을 잠시 뒤에 내요", rows: [stopRow, ...orderRow], status: "토스증권이 잠시 요청을 막고 있어서, 풀리면 바로 내요 · 실제 주문을 끄면 내지 않아요", glyph: "loader", notes: [] };
    case "scheduled":
      return {
        ...base,
        state: "scheduled",
        title: "다음 거래일에 손절 주문을 내요",
        sub: o.basis === "close" ? `${dayWords(marketDate(m, o.observed_at))} 종가` : `관측가 · ${kstClock(o.observed_at)}`,
        rows: [stopRow, ...orderRow, ...(o.due_at != null ? [{ label: "낼 시각", value: kst(o.due_at) }] : [])],
        why: o.basis === "close" ? "종가가 손절선 아래로 마감해서, 다음 거래일 개장 15분 뒤에 팔아요." : "마감 직전에 장중 기준 가격에 닿아서, 다음 거래일 개장 15분 뒤에 팔아요.",
        status: "주문 예정 · 실제 주문을 끄면 내지 않아요",
        notes: [],
      };
    case "sending":
      // * provisional status: sent, no answer yet; the same order goes once more at the next beat
      return { ...base, state: "submitted", title: "손절 주문을 냈어요", rows: [...sentOrder, ...sentRow], status: "주문 접수 확인 중", glyph: "loader", notes: keepNotes(false), ...(stopped ?? {}) };
    case "submitted":
      return { ...base, state: "submitted", title: "손절 주문을 냈어요", rows: [...sentOrder, ...idRow, ...sentRow], status: "체결 확인 중", glyph: "loader", notes: keepNotes(false), ...(stopped ?? {}) };
    case "partial":
    case "partial_closed": {
      const done = o.state === "partial_closed";
      return {
        ...base,
        state: "partial",
        title: `${qtyWords(qty ?? filled)} 중 ${qtyWords(filled)}가 체결됐어요`,
        hero: moneyNum(m, o.avg_price),
        sub: "체결가(평균)",
        rows: [{ label: "체결", value: qtyWords(filled) }, ...(left != null ? [{ label: "남은 수량", value: qtyWords(left) }] : []), ...idRow],
        status: done ? `남은 ${qtyWords(left ?? 0)}는 마감에 취소됐어요. 토스증권 앱에서 확인해 주세요.` : `남은 ${qtyWords(left ?? 0)}는 체결을 계속 확인해요`,
        glyph: done ? "caution" : "loader",
        notes: keepNotes(done),
        ...(!done && stopped ? stopped : {}),
      };
    }
    case "filled": {
      const avg = o.avg_price;
      const rows = [{ label: "수량", value: qtyWords(filled) }];
      if (avg != null) {
        rows.push({ label: "금액", value: money(m, filled * avg) });
        rows.push({ label: "손절선 대비", value: signedMoney(m, Math.round((avg - o.stop_price) * 100) / 100) });
        if (o.avg_cost != null && o.avg_cost > 0) rows.push({ label: "평단 대비", value: pct((avg / o.avg_cost - 1) * 100) });
      }
      if (o.filled_at != null) rows.push({ label: "체결 시각", value: kst(o.filled_at) });
      return { ...base, state: "filled", title: "손절 매도가 체결됐어요", hero: moneyNum(m, avg), sub: "체결가(평균)", rows, glyph: "check", notes: keepNotes(true) };
    }
    case "failed": {
      const code = o.reason ?? "rejected";
      const notes = [...(code === "rejected" && o.reason_text ? [o.reason_text] : []), ...(code === "ip_not_allowed" ? [IP_FIX] : []), ...(code === "auth" ? [AUTH_FIX] : []), NOT_AGAIN];
      return {
        ...base,
        state: "failed",
        title: "손절 주문이 되지 않았어요",
        rows: [stopRow, ...orderRow],
        reason: { code: code as InvestStopReason, text: FAIL_TEXT[code] ?? FAIL_TEXT.rejected!, ...(code === "ip_not_allowed" && x.ip ? { ip: x.ip } : {}) },
        glyph: "fail",
        notes,
      };
    }
    case "searching":
      return { ...base, state: "unknown", title: UNKNOWN_TITLE, rows: [...sentOrder, ...sentRow], status: "주문 내역에서 찾는 중", glyph: "loader", notes: [], ...(stopped ?? {}) };
    case "unknown":
      return {
        ...base,
        state: "unknown",
        title: UNKNOWN_TITLE,
        rows: [...sentOrder, ...idRow, ...sentRow, ...(filled > 0 ? [{ label: "체결", value: qtyWords(filled) }] : [])],
        why: UNKNOWN_WHY[o.reason ?? "no_answer"] ?? UNKNOWN_WHY.no_answer!,
        glyph: "caution",
        notes: ["토스증권 앱의 주문 내역에서 확인해 주세요.", "같은 주문을 다시 내지 않았어요."],
      };
    default: {
      // skipped, canceled: the reason is the title
      const code = o.reason ?? "";
      const title = skipTitle(o);
      const notes = [...(code === "not_confirmed" ? ["규칙 시트에서 길게 눌러 확인하면, 다음에 닿을 때부터 팔아요."] : []), ...(code === "ip_paused" ? [IP_FIX] : [])];
      return {
        ...base,
        state: "skipped",
        title,
        rows: [stopRow],
        reason: { code: code as InvestStopReason, text: title, ...(code === "ip_paused" && x.ip ? { ip: x.ip } : {}) },
        glyph: "caution",
        notes,
      };
    }
  }
}

/**
 * the banner and push title of a real order's state (DD 2042-b §4, 2044 §2: `실제 · ` first); null: none — a wait, a
 * resend, a search, a partial still going, the person's own cancel, checks stopped by a removed login
 */
export function realStopBanner(o: RealOrderRow): { title: string; body: string } | null {
  const m = marketOf(o.symbol);
  const s = o.symbol;
  const qty = o.qty ?? o.confirmed_qty;
  const q = qty != null ? qtyWords(qty) : "수량 확인 불가";
  const filled = o.filled_qty ?? 0;
  switch (o.state) {
    case "scheduled":
      return { title: `실제 · ${s} 손절 주문 예정`, body: `${q} · 낼 시각 ${o.due_at != null ? kst(o.due_at) : "확인 불가"}` };
    case "submitted":
      return { title: `실제 · ${s} 손절 주문 냄`, body: `${q} · 시장가 · 체결 확인 중` };
    case "filled":
      return { title: `실제 · ${s} 손절 체결`, body: `${qtyWords(filled)} · 평균 ${o.avg_price != null ? money(m, o.avg_price) : "확인 불가"} · 손절선 ${money(m, o.stop_price)}` };
    case "partial_closed":
      return { title: `실제 · ${s} 손절 일부 체결`, body: `${q} 중 ${qtyWords(filled)} 체결 · 남은 수량은 마감에 취소` };
    case "failed":
      return { title: `실제 · ${s} 손절 주문 안 됨`, body: (FAIL_TEXT[o.reason ?? "rejected"] ?? FAIL_TEXT.rejected!).replace(/\.$/, "") };
    case "skipped":
      return { title: `실제 · ${s} 손절 주문 건너뜀`, body: skipTitle(o) };
    case "unknown":
      return { title: `실제 · ${s} 손절 주문 확인 필요`, body: "토스증권 앱의 주문 내역에서 확인해 주세요" };
    default:
      return null;
  }
}

/** the row's `[투자 기록]` line (DD 2044 §5): no account, no full order number, no token, no key, no Toss words */
export function realStopRecord(o: RealOrderRow, card: InvestStopCard): string {
  const m = marketOf(o.symbol);
  const fill = (o.state === "filled" || o.state === "partial" || o.state === "partial_closed") && o.filled_qty ? ` · 체결 ${qtyWords(o.filled_qty)}${o.avg_price != null ? ` · 평균 ${money(m, o.avg_price)}` : ""}` : "";
  return `[투자 기록] ${o.symbol} 실제 손절 · ${card.title}${fill} · 관측 ${money(m, o.observed_price)} · 손절선 ${money(m, o.stop_price)}`;
}

/** what a skip's or a failure's call says in one breath (DD 2044 §3), the card's reason in short */
const SKIP_SAID: Readonly<Record<string, string>> = {
  not_confirmed: "실제 매도로 확인하지 않은 손절이에요",
  early_close: "조기 폐장일이에요",
  ip_paused: "토스증권이 접속을 막고 있어요",
  server_off: "실제 주문이 잠시 멈춰 있어요",
  rate_paused: "토스증권이 잠시 요청을 막고 있어요",
  toss_not_connected: "토스증권 연결이 없어요",
  zero_sellable: "팔 수 있는 수량이 0주예요",
  off_hours: "정규장 시간이 아니에요",
  calendar_unknown: "장 운영 정보를 확인하지 못했어요",
  daily_limit: "실제 주문은 하루에 보유 종목 수까지예요",
  rule_day: "손절 주문은 규칙마다 하루 한 번이에요",
  fraction_hours: "마감 1시간 전부터는 소수 주를 시장가로 팔 수 없어요",
  sellable_unknown: "토스증권에서 팔 수 있는 수량을 받지 못했어요",
};
const FAIL_SAID: Readonly<Record<string, string>> = {
  ip_not_allowed: "토스증권이 접속을 막았어요. 앱에서 허용 IP를 확인해 주세요",
  rate_limited: "토스증권이 잠시 요청을 막았어요",
  rejected: "토스증권이 주문을 거절했어요",
  auth: "토스증권 연결이 끊겼어요. 앱의 투자 설정에서 확인해 주세요",
  toss_down: "토스증권에 연결하지 못했어요",
  canceled: "토스증권에서 주문이 취소됐어요",
};

/**
 * the real order's call (G7: what, how much, so what, the market; DD 2044 §3): `실제` said first. `held`: the
 * quantity at the last holdings read, for "N주를 그대로 갖고 있어요" when Toss's sellable quantity was not asked
 */
export function realStopCallLine(agentName: string, o: RealOrderRow, stageCall?: string, held?: number): string {
  const m = marketOf(o.symbol);
  const s = o.symbol;
  const marketLine = stageCall ?? MARKET_UNKNOWN;
  const qty = o.qty ?? o.confirmed_qty;
  const keep = o.sellable ?? held ?? qty;
  const kept = keep != null && keep > 0 ? `${eulReul(qtyWords(keep))} 그대로 갖고 있어요. ` : "";
  const hit = `${iGa(s)} 손절선 ${spoken(m, o.stop_price)} 아래 ${spoken(m, o.observed_price)}에 닿`;
  switch (o.state) {
    case "filled": {
      const filled = o.filled_qty ?? qty ?? 0;
      const avg = o.avg_price;
      const out = [`${ieyo(agentName)}. 실제 주문으로 ${s} 손절 매도가 체결됐어요.`];
      if (avg != null) {
        out.push(`${eulReul(qtyWords(filled))} 평균 ${spoken(m, avg)}에 팔았어요.`);
        const d = Math.round((avg - o.stop_price) * 100) / 100;
        const vsStop = d === 0 ? `손절선 ${gwaWa(spoken(m, o.stop_price))} 같은 값이고` : `손절선 ${spoken(m, o.stop_price)}보다 ${spoken(m, Math.abs(d))} ${d < 0 ? "낮고" : "높고"}`;
        if (o.avg_cost != null && o.avg_cost > 0) {
          const v = (avg / o.avg_cost - 1) * 100;
          // two decimals, as the card and the alert call say it (DD 2314 §4)
          out.push(`${vsStop}, 평단 대비 ${num(Math.abs(v), 2)}% ${v < 0 ? "손실" : "이익"}이에요.`);
        } else out.push(`${vsStop.replace(/(같은 값이고|낮고|높고)$/, (w) => ({ "같은 값이고": "같은 값이에요.", 낮고: "낮아요.", 높고: "높아요." })[w]!)}`);
      } else out.push(`${eulReul(qtyWords(filled))} 팔았어요.`);
      out.push(marketLine);
      return out.join(" ");
    }
    case "failed":
      return `${ieyo(agentName)}. ${hit}아서 실제 손절 주문을 냈지만 되지 않았어요. ${FAIL_SAID[o.reason ?? "rejected"] ?? FAIL_SAID.rejected}. ${NOT_AGAIN} ${kept}${marketLine}`;
    case "skipped":
    case "canceled":
      return `${ieyo(agentName)}. ${hit}았지만 실제 주문을 내지 않았어요. ${SKIP_SAID[o.reason ?? ""] ?? "주문을 내지 않았어요"}. ${o.reason === "zero_sellable" ? "" : kept}${marketLine}`;
    case "scheduled": {
      // 실제 in the first sentence, as every other state (DD 2314 §3)
      const why = o.basis === "close" ? `손절선 ${spoken(m, o.stop_price)} 아래 ${spoken(m, o.observed_price)}로 마감해서` : `마감 직전에 장중 기준 가격 아래 ${spoken(m, o.observed_price)}에 닿아서`;
      return `${ieyo(agentName)}. ${s} 실제 손절 주문 예정이에요. ${why}, 다음 거래일 개장 15분 뒤에 ${qty != null ? `${eulReul(qtyWords(qty))} ` : ""}시장가로 팔아요. 실제 주문을 끄면 팔지 않아요. ${marketLine}`;
    }
    case "partial_closed": {
      const filled = o.filled_qty ?? 0;
      const left = qty != null ? Math.max(0, Number((qty - filled).toFixed(6))) : 0;
      return `${ieyo(agentName)}. ${s} 실제 손절 주문 ${qty != null ? `${qtyWords(qty)} 중 ` : ""}${iGa(qtyWords(filled))} ${o.avg_price != null ? `평균 ${spoken(m, o.avg_price)}에 ` : ""}체결됐고, 남은 ${eunNeun(qtyWords(left))} 마감에 취소됐어요. ${eulReul(qtyWords(left))} 그대로 갖고 있어요. ${marketLine}`;
    }
    default:
      // unknown
      return `${ieyo(agentName)}. ${s} 실제 손절 주문을 냈지만 결과를 확인하지 못했어요. 토스증권 앱의 주문 내역에서 확인해 주세요. 같은 주문을 다시 내지 않았어요. ${eunNeun(s)} ${spoken(m, o.observed_price)}, 손절선은 ${spoken(m, o.stop_price)}예요. ${marketLine}`;
  }
}
