/**
 * D2, the regime-conditional backtest on daily closes with overlapping samples. Every day the condition holds counts as
 * an entry, so neighbouring entries share most of their path. The result therefore also gives how many entries are left
 * when no two windows overlap. The master prompt counts the effective sample as about 1/5, and calls the result "a
 * conditional tendency, not a strategy's expected value". Only days with every horizon ahead of them are used, so all
 * the columns share one n.
 *
 * Returns are in %: the h-day return is close[i + h] / close[i] − 1. The win rate is the share above 0. An entry's
 * 20-day MDD is by default the deepest fall from a running peak over the entry day and the next 20 closes (peak to
 * trough). With `mdd: "entry"` it is the lowest close against the entry close instead. Neither is above 0. The master
 * prompt does not define it. Peak to trough is the default by the lead's call (11-26), and it is not settled: the
 * prompt's own table settles it once its price history is reproduced (미확정 · 데이터 재현 뒤 확정).
 */
import type { Num, Point } from "./types";

export interface HorizonStats {
  winRate: number | null;
  median: number | null;
  worst: number | null;
}

export interface BacktestResult {
  /** entries with every horizon ahead */
  n: number;
  /** the entry dates (when dates were given) */
  dates: string[];
  byHorizon: Record<number, HorizonStats>;
  /** median of the entries' MDD over `mddDays` */
  medianMdd: number | null;
  /** entries left when no two windows of each horizon overlap (greedy from the first) */
  nonOverlapping: Record<number, number>;
}

export function median(xs: readonly number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

export function regimeBacktest(
  close: readonly number[],
  condition: readonly boolean[],
  opts: { horizons?: readonly number[]; mddDays?: number; mdd?: "peak" | "entry"; dates?: readonly string[] } = {},
): BacktestResult {
  const horizons = opts.horizons ?? [5, 20];
  const mddDays = opts.mddDays ?? Math.max(...horizons);
  const reach = Math.max(mddDays, ...horizons);
  const entries: number[] = [];
  for (let i = 0; i + reach < close.length; i++) if (condition[i]) entries.push(i);
  const byHorizon: Record<number, HorizonStats> = {};
  const nonOverlapping: Record<number, number> = {};
  for (const h of horizons) {
    const rets = entries.map((i) => (close[i + h]! / close[i]! - 1) * 100);
    byHorizon[h] = {
      winRate: rets.length ? (rets.filter((r) => r > 0).length / rets.length) * 100 : null,
      median: median(rets),
      worst: rets.length ? Math.min(...rets) : null,
    };
    let last = -Infinity;
    let k = 0;
    for (const i of entries)
      if (i >= last + h) {
        k++;
        last = i;
      }
    nonOverlapping[h] = k;
  }
  const mdds = entries.map((i) => {
    let lo = 0;
    let peak = close[i]!;
    for (let j = 1; j <= mddDays; j++) {
      const x = close[i + j]!;
      if (opts.mdd !== "entry") peak = Math.max(peak, x);
      lo = Math.min(lo, (x / peak - 1) * 100);
    }
    return lo;
  });
  return { n: entries.length, dates: opts.dates ? entries.map((i) => opts.dates![i]!) : [], byHorizon, medianMdd: median(mdds), nonOverlapping };
}

/**
 * Another series' value on each date: the last observation on or before it, or strictly before it with `strict`. Use
 * strict for a Korean asset against a US series: the US close of the same date comes after the Korean close.
 */
export function alignAsOf(points: readonly Point[], dates: readonly string[], opts: { strict?: boolean } = {}): Num[] {
  const xs = points.filter((p) => p.v != null);
  const out: Num[] = [];
  let j = -1;
  for (const d of dates) {
    while (j + 1 < xs.length && (opts.strict ? xs[j + 1]!.t < d : xs[j + 1]!.t <= d)) j++;
    out.push(j >= 0 ? xs[j]!.v : null);
  }
  return out;
}

/** a condition per day from values: lo ≤ v < hi (either end open with null) */
export function inRange(values: readonly Num[], lo: number | null, hi: number | null): boolean[] {
  return values.map((v) => v != null && (lo == null || v >= lo) && (hi == null || v < hi));
}

/** a condition per day: v ≤ x (for "200일선 −20%↓": deviation ≤ −20) */
export function atMost(values: readonly Num[], x: number): boolean[] {
  return values.map((v) => v != null && v <= x);
}

/** a condition per day: v < x (for "RSI<35") */
export function below(values: readonly Num[], x: number): boolean[] {
  return values.map((v) => v != null && v < x);
}

/** all conditions on the same day */
export function and(...conds: readonly (readonly boolean[])[]): boolean[] {
  return conds[0]!.map((_, i) => conds.every((c) => c[i]));
}
