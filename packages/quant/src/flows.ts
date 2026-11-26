/**
 * D8, "short cover or trend turn": five criteria on foreign and program flows. A trend turn is confirmed only when
 * criteria ①, ② and ⑤ are all met: Samsung foreigners net buying 3 days in a row, their holding back to the level of 20
 * days before, and Hynix foreigners turning to net buying. When the holding ratio moves against the net trading of the
 * same window (it rises while foreigners net sell, or the other way round), the ratio is set aside as a conflicting
 * figure and criterion ② becomes unknown. The original did this for Hynix on 11-24. A streak shorter than 3 with
 * every day at hand a buying day is unknown (the data is short), not unmet. Hynix's "동반" day must be Samsung's day.
 */
import { netFlowFigures } from "./risk11";
import { allOf, inARow, present, r9 } from "./series";
import type { Point, Tri } from "./types";

/** the master prompt's criteria, word for word */
export const SHORT_COVER_RULES = [
  { id: "foreign3d", rule: "3일 연속 외국인 순매수", need: "3일" },
  { id: "holding", rule: "외국인 보유율 회복(20일 전 수준)", need: "20일 전 수준" },
  { id: "retrace", rule: "20일 누적 매도의 50% 이상 되돌림", need: "≥50%" },
  { id: "program", rule: "프로그램 비차익 순매수 지속", need: "3일+" },
  { id: "hynix", rule: "하닉 외국인 동반 순매수", need: "+" },
] as const;

export interface ShortCoverInput {
  /** Samsung foreigners' daily net buying (shares) */
  samsungForeign?: readonly Point[];
  /** Samsung foreign holding ratio, % (daily) */
  samsungHolding?: readonly Point[];
  /** program non-arbitrage daily net buying (억원) */
  programNonArb?: readonly Point[];
  /** Hynix foreigners' daily net buying (shares) */
  hynixForeign?: readonly Point[];
}

export interface FlowCriterion {
  id: (typeof SHORT_COVER_RULES)[number]["id"];
  rule: string;
  status: Tri;
  value: number | null;
  note: string | null;
  asOf: string | null;
}

/**
 * The share of earlier selling bought back: the net buying of the latest run of buying days ÷ the net selling of the 20
 * days before that run, in %. Null when the latest day is not a buying day or the 20 days before were not net selling.
 * The master prompt's "18%" for Samsung on 11-24 is not reproducible from its own figures (235만 ÷ 1,192만 = 19.7%), so
 * this definition is ours.
 */
export function retracement(daily: readonly Point[] | null | undefined): { bought: number; sold: number; pct: number } | null {
  const v = present(daily).map((p) => p.v);
  let run = 0;
  while (run < v.length && v[v.length - 1 - run]! > 0) run++;
  if (!run || v.length < run + 20) return null;
  const bought = v.slice(v.length - run).reduce((s, x) => s + x, 0);
  const prior = v.slice(v.length - run - 20, v.length - run).reduce((s, x) => s + x, 0);
  if (prior >= 0) return null;
  return { bought, sold: -prior, pct: r9((bought / -prior) * 100) };
}

/** the holding ratio now against 20 trading days before, with the net trading of those 20 days to check it against */
export function holdingRecovery(holding: readonly Point[] | null | undefined, netDaily: readonly Point[] | null | undefined) {
  const h = present(holding);
  if (h.length < 21) return null;
  const now = h[h.length - 1]!;
  const then = h[h.length - 21]!;
  const net = present(netDaily).filter((p) => p.t > then.t && p.t <= now.t);
  const netSum = net.length ? net.reduce((s, p) => s + p.v, 0) : null;
  const change = r9(now.v - then.v);
  const conflict = netSum != null && ((change > 0 && netSum < 0) || (change < 0 && netSum > 0));
  return { now, then, change, netSum, conflict };
}

export function shortCoverVsTrend(input: ShortCoverInput): { criteria: FlowCriterion[]; met: number; unknown: number; trendTurn: Tri } {
  const R = SHORT_COVER_RULES;
  const ss = netFlowFigures(input.samsungForeign);
  const hold = holdingRecovery(input.samsungHolding, input.samsungForeign);
  const re = retracement(input.samsungForeign);
  const prog = netFlowFigures(input.programNonArb);
  const hx = netFlowFigures(input.hynixForeign);
  const c = (i: number, status: Tri, value: number | null, note: string | null, asOf: string | null): FlowCriterion => ({
    id: R[i]!.id,
    rule: R[i]!.rule,
    status,
    value,
    note,
    asOf,
  });
  const sv = present(input.samsungForeign).map((p) => p.v);
  const pv = present(input.programNonArb).map((p) => p.v);
  const bought = (x: number) => x > 0;
  // ③ needs the buying run and the 20 days before it
  const shortForRetrace = !ss || (ss.buyStreak > 0 && sv.length < ss.buyStreak + 20);
  const criteria: FlowCriterion[] = [
    ss ? c(0, inARow(sv, 3, bought), ss.buyStreak, `연속 순매수 ${ss.buyStreak}일`, ss.asOf) : c(0, "unknown", null, null, null),
    !hold
      ? c(1, "unknown", null, null, null)
      : hold.conflict
        ? c(1, "unknown", hold.now.v, `보유율 ${hold.then.v}% → ${hold.now.v}%와 같은 기간 순매수 ${hold.netSum}가 상충`, hold.now.t)
        : c(1, hold.now.v >= hold.then.v ? "met" : "unmet", hold.now.v, `20일 전 ${hold.then.v}%`, hold.now.t),
    // no buying day today or no selling to buy back: nothing retraced (unmet), unless the data is short
    re
      ? c(2, re.pct >= 50 ? "met" : "unmet", re.pct, `${re.bought} ÷ ${re.sold}`, ss?.asOf ?? null)
      : shortForRetrace
        ? c(2, "unknown", null, ss ? "20일 이력 부족" : null, ss?.asOf ?? null)
        : c(2, "unmet", null, ss!.buyStreak ? "직전 20일 순매도 없음" : "당일 순매수 없음", ss!.asOf),
    prog ? c(3, inARow(pv, 3, bought), prog.buyStreak, `연속 순매수 ${prog.buyStreak}일`, prog.asOf) : c(3, "unknown", null, null, null),
    !hx
      ? c(4, "unknown", null, null, null)
      : ss && ss.asOf !== hx.asOf
        ? c(4, "unknown", hx.day, `날짜 불일치: 하닉 ${hx.asOf}, 삼전 ${ss.asOf}`, hx.asOf)
        : c(4, hx.day > 0 ? "met" : "unmet", hx.day, null, hx.asOf),
  ];
  return {
    criteria,
    met: criteria.filter((x) => x.status === "met").length,
    unknown: criteria.filter((x) => x.status === "unknown").length,
    trendTurn: allOf(criteria[0]!.status, criteria[1]!.status, criteria[4]!.status),
  };
}
