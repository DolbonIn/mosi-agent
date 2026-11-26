/**
 * B3.5–B4, the research flow's arithmetic: an indicator's signal against its thresholds (the prompt's G/Y/R are normal /
 * caution / risk here, the package's one signal vocabulary), the composite score
 * (demand 40 · supply 30 · credit 30, indicators correlated 0.7 or more counted once), the two-axis rule for changing a
 * scenario, and the probability update by evidence strength (the probabilities keep summing to 100, every change with
 * a one-line reason).
 */

import type { Signal } from "./types";

/** the prompt's G / Y / R */
export type Level = Exclude<Signal, "unknown">;

/** thresholds of one indicator: by default a higher value is worse (normal at or below `normal`, caution up to `risk`,
 * risk above it, as in "DC ABS single-A: G ≤250 / Y 250–350 / R >350"); `higherIsWorse: false` mirrors it */
export interface Thresholds {
  normal: number;
  risk: number;
  higherIsWorse?: boolean;
}

export function signal3(value: number, t: Thresholds): Level {
  if (t.higherIsWorse === false) return value >= t.normal ? "normal" : value < t.risk ? "risk" : "caution";
  return value <= t.normal ? "normal" : value > t.risk ? "risk" : "caution";
}

/** B3.5's R (risk) needs the threshold broken and two or more indicators confirming at once */
export function riskConfirmed(levels: readonly Level[]): boolean {
  return levels.filter((l) => l === "risk").length >= 2;
}

/** B3.5's Y: a turn that has lasted three weeks or more. Operational reading: the latest week-over-week changes share
 * one sign for `weeks` weeks or longer, and the last non-flat change before that run had the other sign (weekly
 * values, oldest first) */
export function sustainedTurn(weekly: readonly number[], weeks = 3): boolean {
  const d = weekly.slice(1).map((v, i) => Math.sign(v - weekly[i]!));
  const dir = d[d.length - 1];
  if (!dir) return false;
  let i = d.length - 1;
  while (i >= 0 && d[i] === dir) i--;
  if (d.length - 1 - i < weeks) return false;
  while (i >= 0 && d[i] === 0) i--;
  return i >= 0 && d[i] === -dir;
}

/** Pearson correlation over the indexes where both have a value; null with fewer than three such pairs or no spread */
export function correlation(a: readonly (number | null)[], b: readonly (number | null)[]): number | null {
  const xs: number[] = [];
  const ys: number[] = [];
  a.forEach((x, i) => {
    const y = b[i];
    if (x != null && y != null) {
      xs.push(x);
      ys.push(y);
    }
  });
  if (xs.length < 3) return null;
  const mx = xs.reduce((s, x) => s + x, 0) / xs.length;
  const my = ys.reduce((s, y) => s + y, 0) / ys.length;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  xs.forEach((x, i) => {
    sxy += (x - mx) * (ys[i]! - my);
    sxx += (x - mx) ** 2;
    syy += (ys[i]! - my) ** 2;
  });
  return sxx === 0 || syy === 0 ? null : sxy / Math.sqrt(sxx * syy);
}

/** groups of indicators correlated `threshold` (0.7) or more, joined transitively; each group counts once */
export function correlationGroups(series: readonly { id: string; values: readonly (number | null)[] }[], threshold = 0.7): string[][] {
  const parent = series.map((_, i) => i);
  const root = (i: number): number => (parent[i] === i ? i : (parent[i] = root(parent[i]!)));
  for (let i = 0; i < series.length; i++)
    for (let j = i + 1; j < series.length; j++) {
      const r = correlation(series[i]!.values, series[j]!.values);
      if (r != null && r >= threshold) parent[root(j)] = root(i);
    }
  const groups = new Map<number, string[]>();
  series.forEach((s, i) => groups.set(root(i), [...(groups.get(root(i)) ?? []), s.id]));
  return [...groups.values()];
}

export type Axis = "demand" | "supply" | "credit";
export const AXIS_WEIGHTS: Readonly<Record<Axis, number>> = { demand: 40, supply: 30, credit: 30 };

export interface ScoredIndicator {
  id: string;
  axis: Axis;
  /** +1 supports the scenario, −1 against it, 0 neutral */
  signal: -1 | 0 | 1;
}

export interface Composite {
  /** Σ weight × the axis's mean signal: −100 to 100 */
  score: number;
  /** each axis's mean signal over its groups (−1 to 1), null with no indicator */
  byAxis: Record<Axis, number | null>;
  /** whether a scenario may change on this: two or more axes signal the same way (B3.6: never one indicator alone) */
  scenarioChange: { allowed: boolean; direction: -1 | 0 | 1 };
}

/** B3.6: indicators in one correlation group are averaged into one before the axis's mean */
export function composite(indicators: readonly ScoredIndicator[], groups: readonly string[][] = [], weights = AXIS_WEIGHTS): Composite {
  const groupOf = new Map<string, number>();
  groups.forEach((g, i) => g.forEach((id) => groupOf.set(id, i)));
  const byAxis = {} as Record<Axis, number | null>;
  let score = 0;
  for (const axis of ["demand", "supply", "credit"] as Axis[]) {
    const units = new Map<string, number[]>();
    for (const ind of indicators.filter((x) => x.axis === axis)) {
      const key = groupOf.has(ind.id) ? `g${groupOf.get(ind.id)}` : `i${ind.id}`;
      units.set(key, [...(units.get(key) ?? []), ind.signal]);
    }
    const means = [...units.values()].map((s) => s.reduce((a, b) => a + b, 0) / s.length);
    byAxis[axis] = means.length ? means.reduce((a, b) => a + b, 0) / means.length : null;
    score += weights[axis] * (byAxis[axis] ?? 0);
  }
  const up = (Object.values(byAxis) as (number | null)[]).filter((v) => v != null && v > 0).length;
  const down = (Object.values(byAxis) as (number | null)[]).filter((v) => v != null && v < 0).length;
  const direction = up >= 2 ? 1 : down >= 2 ? -1 : 0;
  return { score, byAxis, scenarioChange: { allowed: direction !== 0, direction } };
}

export type Evidence = "strong" | "medium" | "weak";

/** B4: strong = two or more L1 indicators, lasting three weeks or more, past a threshold; medium = one L1 or two L2;
 * weak = a T4 source or a one-off news item (recorded, no change) */
export function evidenceStrength(e: { l1: number; l2: number; weeks: number; breached: boolean }): Evidence {
  if (e.l1 >= 2 && e.weeks >= 3 && e.breached) return "strong";
  if (e.l1 >= 1 || e.l2 >= 2) return "medium";
  return "weak";
}

/** the step B4 allows per strength, in percentage points: strong 10–15, medium 5, weak 0 */
export const EVIDENCE_STEP: Readonly<Record<Evidence, readonly [number, number]>> = { strong: [10, 15], medium: [5, 5], weak: [0, 0] };

export interface ProbabilityChange {
  target: string;
  direction: 1 | -1;
  evidence: Evidence;
  /** within the strength's range (strong: 10–15); its lower end by default */
  step?: number;
  /** what was newly confirmed (B4: one line, never a change of mood) */
  reason: string;
}

/**
 * B4's update: the target moves by the strength's step, the other scenarios absorb the difference in proportion to
 * their probabilities, and whole percentages keep the sum at 100 (largest remainders). Throws on a missing reason, a
 * step outside the strength's range, an unknown target or probabilities that do not sum to 100.
 */
export function updateProbabilities(probs: Readonly<Record<string, number>>, change: ProbabilityChange): Record<string, number> {
  const ids = Object.keys(probs);
  const sum = ids.reduce((s, id) => s + probs[id]!, 0);
  if (Math.abs(sum - 100) > 0.5) throw new Error(`probabilities sum to ${sum}, not 100`);
  if (!(change.target in probs)) throw new Error(`no scenario ${change.target}`);
  if (!change.reason.trim()) throw new Error("a probability change needs its reason");
  const [lo, hi] = EVIDENCE_STEP[change.evidence];
  const step = change.step ?? lo;
  if (step < lo || step > hi) throw new Error(`a ${change.evidence} change moves ${lo}–${hi} %p, not ${step}`);
  const before = probs[change.target]!;
  const after = Math.min(100, Math.max(0, before + change.direction * step));
  const others = ids.filter((id) => id !== change.target);
  const rest = others.reduce((s, id) => s + probs[id]!, 0);
  const raw: Record<string, number> = { [change.target]: after };
  for (const id of others) raw[id] = rest > 0 ? (probs[id]! / rest) * (100 - after) : (100 - after) / others.length;
  // whole percentages, the remainder to the largest fractions
  const out: Record<string, number> = {};
  let left = 100;
  for (const id of ids) left -= out[id] = Math.floor(raw[id]! + 1e-9);
  [...ids].sort((a, b) => raw[b]! - Math.floor(raw[b]! + 1e-9) - (raw[a]! - Math.floor(raw[a]! + 1e-9))).slice(0, left).forEach((id) => out[id]!++);
  return out;
}
