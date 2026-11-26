/**
 * Price rules: checks, the watch's judgement and state steps, and every sentence a rule shows (agent-runtime 2006 §4,
 * 2052 §A; DD 1935 §3-2·3-3, 2008 §5, 2010 §4, 2042-b §1–3, 2100). Pure: no clock, no database, no network. Figures
 * come from @pickle/quant format.ts only.
 */
import type { InvestAction, InvestNum, InvestRuleKind, InvestRuleState, InvestStopBasis } from "@pickle/protocol";
import { krw, num, pct, usd } from "@pickle/quant";
import type { Market } from "./calendar.ts";

export const DEFAULT_BUFFER_PCT = 5;
export const BUFFER_MIN = 1;
export const BUFFER_MAX = 20;
export const MAX_PRICE = 10_000_000;
export const INVEST_CALLS_PER_DAY = 10;

/** why a rule's earlier state is not known: never seen, edited, resumed from 멈춤, or quotes stopped in between */
export type PriorReason = "first" | "edited" | "resumed" | "gap";
/** seen_slot markers left by the person's saves (a real slot key starts with the market) */
export const SEEN_EDITED = "@edited";
export const SEEN_RESUMED = "@resumed";

export type Judge = "in" | "out" | "wait";

/** the rule columns the pure functions read */
export interface RuleSpec {
  symbol: string;
  kind: InvestRuleKind;
  level: number | null;
  price: number | null;
  lo: number | null;
  hi: number | null;
  direction: "below" | "above" | "inside";
  action: InvestAction;
  once: number;
  buffer_pct: number | null;
  until_day: string | null;
}

export interface RuleWatchState {
  state: InvestRuleState;
  hit_at: number | null;
  hit_seq: number;
  cleared_at: number | null;
  paused_at: number | null;
  seen_slot: string | null;
}

// ───────────────────────────── figures ─────────────────────────────

export function money(market: Market, x: number): string {
  return market === "US" ? usd(x) : krw(x);
}

export function moneyNum(market: Market, x: number | null): InvestNum {
  if (x == null || !Number.isFinite(x)) return { v: null, text: "확인 불가", unit: market === "US" ? "usd" : "krw" };
  return { v: x, text: money(market, x), unit: market === "US" ? "usd" : "krw" };
}

export function pctNum(x: number | null): InvestNum {
  if (x == null || !Number.isFinite(x)) return { v: null, text: "확인 불가", unit: "pct" };
  return { v: x, text: pct(x), unit: "pct" };
}

/** a price on the market's tick: cents in the US, whole won in Korea (the judged value is the shown value) */
export function tick(market: Market, x: number): number {
  return market === "US" ? Math.round(x * 100) / 100 : Math.round(x);
}

/** a zone: $30.00–31.50 / 189,000–195,000원 */
export function zoneText(market: Market, lo: number, hi: number): string {
  return market === "US" ? `${usd(lo)}–${num(hi, 2)}` : `${num(lo)}–${krw(hi)}`;
}

// ───────────────────────────── particles ─────────────────────────────

function finalSound(word: string): "none" | "rieul" | "other" {
  const t = word.trim();
  const code = t.charCodeAt(t.length - 1);
  if (code >= 0xac00 && code <= 0xd7a3) {
    const b = (code - 0xac00) % 28;
    return b === 0 ? "none" : b === 8 ? "rieul" : "other";
  }
  const ch = t.slice(-1).toLowerCase();
  if ("036".includes(ch)) return "other"; // 영 삼 육
  if ("178".includes(ch)) return "rieul"; // 일 칠 팔
  if ("mn".includes(ch)) return "other";
  if ("lr".includes(ch)) return "rieul";
  return "none";
}

export const iGa = (w: string) => w + (finalSound(w) === "none" ? "가" : "이");
export const eulReul = (w: string) => w + (finalSound(w) === "none" ? "를" : "을");
export const euroRo = (w: string) => w + (finalSound(w) === "other" ? "으로" : "로");
export const eunNeun = (w: string) => w + (finalSound(w) === "none" ? "는" : "은");

// ───────────────────────────── names ─────────────────────────────

export function kindWord(kind: InvestRuleKind, level: number | null): string {
  switch (kind) {
    case "stop":
      return "손절";
    case "target":
      return level ? `${level}차 익절` : "익절";
    case "buy_zone":
      return "매수 검토";
    case "alert":
      return "가격 알림";
    case "resistance":
      return "저항";
    case "invalidate":
      return "전략 무효화";
  }
}

const DIR_WORD = { below: "이하", above: "이상", inside: "" } as const;

/** the rule's left text: 손절 $25.80 이하 / 1차 익절 $36.50 이상 / 매수 검토 $30.00–31.50 / 저항 $34.10 */
export function ruleLeft(market: Market, r: RuleSpec): string {
  const k = kindWord(r.kind, r.level);
  if (r.kind === "buy_zone") return `${k} ${zoneText(market, r.lo ?? 0, r.hi ?? 0)}`;
  const p = money(market, r.price ?? 0);
  if (r.kind === "resistance") return `${k} ${p}`;
  return `${k} ${p} ${DIR_WORD[r.direction]}`.trim();
}

export function actionText(action: InvestAction, mode: "mock" | "real"): string {
  if (action === "sell") return mode === "real" ? "매도(실제)" : "기록(모의)";
  return action === "call" ? "전화" : "알림";
}

/** 11-27 00:45 in KST */
export function shortKst(ms: number): string {
  const d = new Date(ms + 9 * 3_600_000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

/** 11월 27일 00:45 in KST */
export function longKst(ms: number): string {
  const d = new Date(ms + 9 * 3_600_000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCMonth() + 1}월 ${d.getUTCDate()}일 ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

/** 12월 1일 from YYYY-MM-DD */
export function dayWords(day: string): string {
  const [, m, d] = day.split("-").map(Number) as [number, number, number];
  return `${m}월 ${d}일`;
}

export function stateText(w: RuleWatchState, until: string | null): string {
  switch (w.state) {
    case "hit":
      return w.hit_at ? `닿음 · ${shortKst(w.hit_at)}` : "닿음";
    case "paused":
      return w.paused_at ? `멈춤 · ${shortKst(w.paused_at)}` : "멈춤";
    case "expired":
      return "만료";
    default:
      return until ? `${until.slice(5)}까지` : "대기";
  }
}

/** the sheet's footnote under the result sentence (DD 2008 §5, DD 2042-b §1) */
export function stateFoot(w: RuleWatchState): string | undefined {
  if (w.state === "hit" && w.hit_at) return `${longKst(w.hit_at)}에 닿았어요. 가격이 조건 밖으로 나갔다가 다시 닿으면 그때 또 알려요.`;
  if (w.state === "paused" && w.paused_at) return `${longKst(w.paused_at)}에 닿아서 멈췄어요.`;
  return undefined;
}

// ───────────────────────────── stop basis (D5-2) ─────────────────────────────

/** close basis when ATR14 is wider than the stop's distance (from the average price, else the last close); the
 * intraday price alone otherwise, and whenever either is unknown (agent-runtime 2052 §B-2) */
export function stopBasis(atr14: number | null, stop: number, ref: number | null): InvestStopBasis {
  if (atr14 == null || ref == null || !(ref > stop)) return "intraday";
  return atr14 > ref - stop ? "close_and_intraday" : "intraday";
}

export function bufferPct(r: Pick<RuleSpec, "buffer_pct">): number {
  return r.buffer_pct ?? DEFAULT_BUFFER_PCT;
}

export function bufferPrice(market: Market, stop: number, pctBelow: number): number {
  return tick(market, stop * (1 - pctBelow / 100));
}

/** DD 2042-b §2: the stop is judged on intraday prices alone (no ATR: no daily bars within 5 market days) */
export const INTRADAY_ONLY = "지금은 장중 가격만으로 판단해요.";

/** the buffer row's footnote (DD 2042-b §2) */
export function bufferFoot(basis: InvestStopBasis, isDefault: boolean): string {
  const head = basis === "intraday" ? `${INTRADAY_ONLY} ` : "";
  const tail = isDefault ? "원문에 숫자가 없어서 정한 운영 기본값(5%)이에요." : "기본값은 5%예요.";
  return `${head}종가로 판단할 때, 장중 가격이 손절선보다 이만큼 더 내려가면 마감을 기다리지 않아요. ${tail}`;
}

// ───────────────────────────── judgement and steps ─────────────────────────────

/**
 * One check of one rule. `close`: the check after the close (the price is the official close). A close-basis stop is
 * "in" at the close check below the stop, or at any check at or below the buffer; between the buffer and the stop
 * during the session it waits for the close (neither in nor out). Resistance needs a price above the level.
 */
export function judge(r: RuleSpec, price: number, close: boolean, basis: InvestStopBasis, buffer: number | null): Judge {
  switch (r.kind) {
    case "stop": {
      const stop = r.price!;
      if (basis === "intraday" || buffer == null) return price <= stop ? "in" : "out";
      if (price <= buffer) return "in";
      if (close) return price <= stop ? "in" : "out";
      return price > stop ? "out" : "wait";
    }
    case "target":
      return price >= r.price! ? "in" : "out";
    case "resistance":
      return price > r.price! ? "in" : "out";
    case "buy_zone":
      return price >= r.lo! && price <= r.hi! ? "in" : "out";
    case "alert":
    case "invalidate":
      return (r.direction === "above" ? price >= r.price! : price <= r.price!) ? "in" : "out";
  }
}

/** why the earlier state is unknown at this check, or null when the rule was seen at the check right before */
export function priorReason(seen: string | null, prevKey: string | null): PriorReason | null {
  if (seen && prevKey && seen === prevKey) return null;
  if (seen === null) return "first";
  if (seen === SEEN_EDITED) return "edited";
  if (seen === SEEN_RESUMED) return "resumed";
  return "gap";
}

export interface Step {
  next: RuleWatchState;
  /** send an alert (or a stop record) for this check */
  alert: boolean;
  noPrior: PriorReason | null;
}

/**
 * The state step (A14, team-lead 2045 §12-8): inside while armed → one alert and hit (paused when the rule alerts once,
 * and for every sell stop); inside while hit → nothing; one check outside clears a hit (a later touch is a new alert,
 * the same day too); waiting changes nothing. The check's slot is remembered either way.
 */
export function step(r: RuleSpec, w: RuleWatchState, j: Judge, slotKey: string, prevKey: string | null, at: number): Step {
  const base = { ...w, seen_slot: slotKey };
  if (w.state === "paused" || w.state === "expired") return { next: w, alert: false, noPrior: null };
  if (j === "in" && w.state === "armed") {
    const stops = r.once === 1 || r.action === "sell";
    return {
      next: { ...base, state: stops ? "paused" : "hit", hit_at: at, hit_seq: w.hit_seq + 1, paused_at: stops ? at : w.paused_at },
      alert: true,
      noPrior: priorReason(w.seen_slot, prevKey),
    };
  }
  if (j === "out" && w.state === "hit") return { next: { ...base, state: "armed", cleared_at: at }, alert: false, noPrior: null };
  return { next: base, alert: false, noPrior: null };
}

/** a rule whose deadline day's checks are over */
export function expiresAt(r: Pick<RuleSpec, "until_day">, slotDay: string, closeCheck: boolean): boolean {
  return !!r.until_day && (slotDay > r.until_day || (closeCheck && slotDay === r.until_day));
}

export function dedupeKey(ruleId: string, rev: number, hitSeq: number): string {
  return `${ruleId}:${rev}:${hitSeq}`;
}

// ───────────────────────────── sentences ─────────────────────────────

/** "SOXL 손절을 $25.80에서 $27.00으로 바꿔요." / "SOXL에 손절 $27.00 이하 규칙을 더해요." */
export function changeSentence(market: Market, before: RuleSpec | null, after: RuleSpec): string {
  const k = kindWord(after.kind, after.level);
  if (!before) return `${after.symbol}에 ${ruleLeft(market, after)} 규칙을 더해요.`;
  const parts: string[] = [];
  if (after.kind === "buy_zone") {
    if (before.lo !== after.lo || before.hi !== after.hi)
      parts.push(`${after.symbol} ${eulReul(k)} ${zoneText(market, before.lo ?? 0, before.hi ?? 0)}에서 ${euroRo(zoneText(market, after.lo ?? 0, after.hi ?? 0))} 바꿔요.`);
  } else if (before.price !== after.price) {
    parts.push(`${after.symbol} ${eulReul(k)} ${money(market, before.price ?? 0)}에서 ${euroRo(money(market, after.price ?? 0))} 바꿔요.`);
  }
  if (before.direction !== after.direction) parts.push(`방향을 ${euroRo(DIR_WORD[after.direction])} 바꿔요.`);
  if (before.action !== after.action) parts.push(`행동을 ${actionWord(before.action)}에서 ${euroRo(actionWord(after.action))} 바꿔요.`);
  if (before.until_day !== after.until_day) parts.push(after.until_day ? `기한을 ${dayWords(after.until_day)}까지로 바꿔요.` : "기한을 없애요.");
  if ((before.buffer_pct ?? null) !== (after.buffer_pct ?? null)) parts.push(`장중 버퍼를 ${euroRo(`${num(bufferPct(after))}%`)} 바꿔요.`);
  if (before.once !== after.once) parts.push(after.once ? "한 번 알리고 멈추게 바꿔요." : "닿을 때마다 알리게 바꿔요.");
  return parts.join(" ");
}

function actionWord(a: InvestAction): string {
  return a === "sell" ? "매도" : a === "call" ? "전화" : "알림";
}

export interface ResultCtx {
  market: Market;
  mode: "mock" | "real";
  basis: InvestStopBasis;
  buffer: number | null;
  /** sellable quantity for a sell stop (null: not known) */
  qty: number | null;
}

/** the stop's condition in the DD 2042-b §3 form */
function stopCondition(c: ResultCtx, stop: number): string {
  const s = money(c.market, stop);
  if (c.basis === "close_and_intraday" && c.buffer != null) return `종가가 ${s} 이하로 마감하거나 장중에 ${money(c.market, c.buffer)} 이하로 내려가면`;
  return `장중에 ${s} 이하로 내려가면`;
}

/** what saving does (DD 2042-b §3, DD 1935 §2-3 4) */
export function resultSentence(r: RuleSpec, c: ResultCtx): string {
  const how = r.action === "call" ? "전화로 알려요." : "알려요.";
  if (r.kind === "stop") {
    const stop = r.price!;
    if (r.action === "sell") {
      if (c.mode === "real") {
        const qty = c.qty != null ? `${num(c.qty)}주를` : "보유 수량을";
        const s = money(c.market, stop);
        if (c.basis === "close_and_intraday" && c.buffer != null)
          return `실제 주문이 켜져 있어서, 종가가 ${s} 이하로 마감하면 다음 거래일 개장 15분 뒤에, 장중에 ${money(c.market, c.buffer)} 이하로 내려가면 그때 바로 ${qty} 시장가로 팔아요.`;
        return `실제 주문이 켜져 있어서, 장중에 ${s} 이하로 내려가면 바로 ${qty} 시장가로 팔아요.`;
      }
      return `${stopCondition(c, stop)} 손절 조건이에요. 모의 주문이라 팔지 않고, 위 조건에 닿은 시점과 가격만 기록해요.`;
    }
    return `${stopCondition(c, stop)} ${how}`;
  }
  const m = c.market;
  switch (r.kind) {
    case "buy_zone":
      return `${zoneText(m, r.lo!, r.hi!)} 구간에 들어오면 ${how}`;
    case "resistance":
      return `${eulReul(money(m, r.price!))} 넘으면 ${how}`;
    default:
      return r.direction === "above" ? `${euroRo(`${money(m, r.price!)} 이상`)} 올라가면 ${how}` : `${euroRo(`${money(m, r.price!)} 이하`)} 내려가면 ${how}`;
  }
}

/** a stop above the current price (DD 1935 §2-3 4) */
export function stopWarning(market: Market, r: RuleSpec, price: number | null, editing: boolean): string | null {
  if (r.kind !== "stop" || price == null || !(r.price! > price)) return null;
  return `지금 가격 ${money(market, price)}보다 높아서, ${editing ? "바꾸면" : "저장하면"} 바로 손절 조건이 돼요.`;
}

/** the footnote under the action row when it is a call (DD 2010 §4); footnote sentences end in a period (DD 2341) */
export function callNote(block: "not_verified" | "not_configured" | null): string {
  if (block === "not_verified") return "번호를 인증하지 않아 전화를 걸 수 없어요.";
  if (block === "not_configured") return "지금은 전화를 걸 수 없어요.";
  return `앱에서 인증한 번호로 걸어요. 하루 ${INVEST_CALLS_PER_DAY}통까지예요.`;
}

/** where the price was, for a noPrior title line (DD 2100 C1) */
export function sideWord(r: Pick<RuleSpec, "direction" | "kind">): string {
  if (r.kind === "buy_zone" || r.direction === "inside") return "구간 안에";
  return r.direction === "above" ? "위에" : "아래에";
}

export function noPriorLine(reason: PriorReason, r: Pick<RuleSpec, "direction" | "kind">): string {
  if (reason === "gap") return "시세를 받지 못한 사이에 닿았어요. 닿은 시각은 몰라요.";
  const when = reason === "edited" ? "규칙을 고칠 때" : reason === "resumed" ? "다시 감시할 때" : "감시를 시작할 때";
  return `${when} 이미 ${sideWord(r)} 있었어요.`;
}
