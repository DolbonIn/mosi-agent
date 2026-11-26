/**
 * B6, grading the forecast ledger: direction hit rate (3 and 12 months), the Brier score, interval error, and the
 * source weights. The targets are a 12-month hit rate of 65 % or more and a Brier score of 0.25 or less. A partial hit
 * stays out of the hit rate and is counted on its own.
 */

/** the targets B6 sets */
export const TARGETS = { hitRate12m: 0.65, brier: 0.25 } as const;

/** mean of (p − outcome)² over resolved binary forecasts; p is 0–1 */
export function brier(forecasts: readonly { p: number; outcome: 0 | 1 }[]): number | null {
  if (!forecasts.length) return null;
  return forecasts.reduce((s, f) => s + (f.p - f.outcome) ** 2, 0) / forecasts.length;
}

export type Outcome = "hit" | "miss" | "partial";

export function hitRate(results: readonly Outcome[]): { rate: number | null; hits: number; misses: number; partial: number } {
  const hits = results.filter((r) => r === "hit").length;
  const misses = results.filter((r) => r === "miss").length;
  return { rate: hits + misses ? hits / (hits + misses) : null, hits, misses, partial: results.length - hits - misses };
}

/** how far the outcome fell outside the forecast interval, in the interval's unit (%p): 0 inside, signed outside */
export function intervalError(actual: number, lo: number, hi: number): number {
  return actual > hi ? actual - hi : actual < lo ? actual - lo : 0;
}

export type SourceTier = "T1" | "T2" | "T3" | "T4";

/** a source's weight: T1 1.0; T2/T3 1.0, or 0.7 when its past hit rate is below 60 %; T4 0 (hypotheses only) */
export function sourceWeight(tier: SourceTier, pastHitRate: number | null = null): number {
  if (tier === "T4") return 0;
  if (tier === "T1") return 1;
  return pastHitRate != null && pastHitRate < 0.6 ? 0.7 : 1;
}
