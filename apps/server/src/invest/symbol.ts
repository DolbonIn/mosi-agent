/**
 * The symbol screen's server words (screens-more 0913 A1–A3, DD 0914 D2 · A3, team-lead 0931): the chart's levels in
 * @pickle/quant levelChart's shape, its screen-reader sentence, its foot, the note when there is no chart, and each recent
 * alert's line. Pure: no clock, no database, no network.
 */
import type { InvestChartLevel } from "@pickle/protocol";
import { LEVEL_WORD, num, rsi, type Bar } from "@pickle/quant";
import type { Market } from "./calendar.ts";
import { dayWords, kindWord, ruleLeft, SEEN_SPLIT, type RuleSpec } from "./rules.ts";

/** fewer finished daily bars than this → no chart (DD 0914 D5: the screen shows 30 days at the least) */
export const CHART_MIN_BARS = 30;

export const CHART_NOTE = {
  off: "시세를 받지 않아서 차트를 그리지 않아요.",
  short: "일봉이 아직 모자라서 차트를 그리지 않아요.",
  missed: "오늘 일봉을 받지 못해서 차트를 그리지 않아요.",
} as const;

/** the order levels are listed and read in (DD 1935 §2-5's example: 손절, 1차 익절, 매수 검토 구간) */
const LEVEL_ORDER: readonly InvestChartLevel["kind"][] = ["stop", "target1", "target2", "target3", "buyZone", "resistance", "support"];

/**
 * The person's levels on the chart: stops, targets 1–3, resistance and the buy zone as one band, in LEVEL_ORDER. Left
 * out: expired rules (no longer watched), rules a split or a merge stopped (their prices are from before it, the bars are
 * adjusted; DD 1442 2), and alert and invalidate until @pickle/quant has their LevelKind (team-lead 0931).
 */
export function chartLevels(market: Market, rules: readonly (RuleSpec & { state: string; seen_slot?: string | null })[]): InvestChartLevel[] {
  const out: InvestChartLevel[] = [];
  for (const r of rules) {
    if (r.state === "expired" || (r.state === "paused" && r.seen_slot === SEEN_SPLIT)) continue;
    const label = ruleLeft(market, r);
    if (r.kind === "buy_zone" && r.lo != null && r.hi != null) out.push({ kind: "buyZone", price: r.lo, hi: r.hi, label });
    else if (r.price == null) continue;
    else if (r.kind === "stop") out.push({ kind: "stop", price: r.price, label });
    else if (r.kind === "target" && (r.level === 1 || r.level === 2 || r.level === 3)) out.push({ kind: `target${r.level}`, price: r.price, label });
    else if (r.kind === "resistance") out.push({ kind: "resistance", price: r.price, label });
  }
  return out.sort((a, b) => LEVEL_ORDER.indexOf(a.kind) - LEVEL_ORDER.indexOf(b.kind));
}

const plain = (market: Market, x: number) => (market === "US" ? num(x, 2) : num(x));
const spoken = (market: Market, x: number) => (market === "US" ? `${num(x, 2)}달러` : `${num(x)}원`);

/**
 * The chart's screen-reader sentence (DD 1935 §2-5) after the chart's name: the app puts "SOXL 일봉 40일. " in front, the
 * days it drew (DD 1442 1, DD 0914 D5). `11월 26일 종가 32.57달러. 손절 25.80, 1차 익절 36.50, 매수 검토 구간 30.00에서
 * 31.50. RSI 48.`
 */
export function chartAria(market: Market, bars: readonly Bar[], levels: readonly InvestChartLevel[]): string {
  const last = bars.at(-1)!;
  const parts = [`${dayWords(last.t)} 종가 ${spoken(market, last.c)}.`];
  const words = levels.map((l) => (l.kind === "buyZone" ? `${LEVEL_WORD.buyZone} 구간 ${plain(market, l.price)}에서 ${plain(market, l.hi!)}` : `${LEVEL_WORD[l.kind]} ${plain(market, l.price)}`));
  if (words.length) parts.push(`${words.join(", ")}.`);
  const r = rsi(bars.map((b) => b.c)).at(-1);
  if (r != null && Number.isFinite(r)) parts.push(`RSI ${Math.round(r)}.`);
  return parts.join(" ");
}

/** the chart's foot: its basis, where the bars came from and that source's grade (DD 0914 A3, DD 1442 3) */
export const chartFoot = (asOf: string, source: { name: string; grade: string }) => `기준 ${dayWords(asOf)} 종가 · ${source.name} · ${source.grade}`;

/** why there is no chart, and its tone (DD 0426: nowhere to get it → quiet, not received → caution) */
export function chartNote(o: { source: boolean; bars: number | null }): { chartNote: string; chartNoteTone: "quiet" | "caution" } | null {
  if (!o.source) return { chartNote: CHART_NOTE.off, chartNoteTone: "quiet" };
  if (o.bars == null) return { chartNote: CHART_NOTE.missed, chartNoteTone: "caution" };
  if (o.bars < CHART_MIN_BARS) return { chartNote: CHART_NOTE.short, chartNoteTone: "quiet" };
  return null;
}

/**
 * A recent alert's line on the symbol screen: its banner's title without the symbol (DD 0914 D2). The stored title is
 * the card's (a stop record's is its banner's), so the two kinds whose banner varies read it.
 */
export function alertLine(a: { kind: string; title: string; symbol: string }, level: number | null): string {
  switch (a.kind) {
    case "stop":
      return "손절 관찰가 도달";
    case "target": {
      const n = level ?? (Number(/([123])차 익절/.exec(a.title)?.[1]) || null);
      return `${kindWord("target", n)} 관찰가 도달`;
    }
    case "buy_zone":
      return "매수 검토 구간 진입";
    case "resistance":
      return a.title.endsWith("위에 있어요") ? "저항 위" : "저항 돌파";
    case "invalidate":
      return "전략 다시 보기";
    case "alert":
      return "내가 정한 가격 도달";
    case "expired":
      return "감시 기간 끝";
    case "gap":
      return a.title.includes("높게 시작") ? "갭 상승 출발" : "갭 하락 출발";
    case "chase":
      return "매수 검토 구간 크게 벗어남";
    case "split":
      return "가격 규칙 멈춤";
    default:
      return a.title.startsWith(`${a.symbol} `) ? a.title.slice(a.symbol.length + 1) : a.title;
  }
}
