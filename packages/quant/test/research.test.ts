/** B3.5–B4 and B6: signals, composite score, probability update and grading, on hand-worked numbers. */
import { describe, expect, test } from "bun:test";
import {
  composite,
  correlation,
  correlationGroups,
  evidenceStrength,
  riskConfirmed,
  signal3,
  sustainedTurn,
  updateProbabilities,
} from "../src/research";
import { TARGETS, brier, hitRate, intervalError, sourceWeight } from "../src/scoring";

describe("B3.5 signals", () => {
  test("DC ABS single-A, G ≤250 / Y 250~350 / R >350: 250 G, 251 Y, 350 Y, 351 R", () => {
    const t = { normal: 250, risk: 350 };
    expect([250, 251, 350, 351].map((v) => signal3(v, t))).toEqual(["normal", "caution", "caution", "risk"]);
  });
  test("a lower-is-worse indicator mirrors it: ≥ normal G, < risk R", () => {
    const t = { normal: 60, risk: 40, higherIsWorse: false };
    expect([60, 59, 40, 39].map((v) => signal3(v, t))).toEqual(["normal", "caution", "caution", "risk"]);
  });
  test("R counts only with two or more indicators at R", () => {
    expect(riskConfirmed(["risk", "caution", "normal"])).toBe(false);
    expect(riskConfirmed(["risk", "risk", "normal"])).toBe(true);
  });
  test("Y: three or more weekly moves the same way after a move the other way (a flat week between is skipped)", () => {
    expect(sustainedTurn([1, 2, 3, 2, 1, 0])).toBe(true);
    expect(sustainedTurn([3, 4, 3, 2, 1, 0])).toBe(true);
    expect(sustainedTurn([1, 2, 3, 2, 1])).toBe(false);
    expect(sustainedTurn([3, 2, 1, 0, -1, -2])).toBe(false);
    expect(sustainedTurn([1, 2, 2, 1, 0, -1])).toBe(true);
    expect(sustainedTurn([1, 2, 3, 3])).toBe(false);
  });
});

describe("B3.6 composite", () => {
  test("Pearson correlation: ±1 on lines, null with fewer than three pairs or no spread", () => {
    expect(correlation([1, 2, 3, 4], [2, 4, 6, 8])).toBeCloseTo(1, 12);
    expect(correlation([1, 2, 3, 4], [8, 6, 4, 2])).toBeCloseTo(-1, 12);
    expect(correlation([1, 2, null, 4], [1, null, 3, 4])).toBeNull();
    expect(correlation([1, 1, 1], [1, 2, 3])).toBeNull();
  });
  test("indicators correlated 0.7 or more join one group, transitively", () => {
    const groups = correlationGroups([
      { id: "rpo", values: [1, 2, 3, 4, 5] },
      { id: "capex", values: [2, 4, 6, 8, 11] },
      { id: "orders", values: [5, 3, 4, 1, 2] },
      { id: "guide", values: [1.1, 2.2, 2.9, 4.2, 5.1] },
    ]);
    expect(groups).toEqual([["rpo", "capex", "guide"], ["orders"]]);
  });
  test("B3.6 \"0.7 이상\": two indicators correlated 0.75 count once; 0.65 apart (lead mutant Q6: 0.7 → 0.8)", () => {
    // y = x + b·z with z orthogonal to x (both centred): r = |x| / √(|x|² + b²|z|²); |x|² = 10, |z|² = 14
    const x = [1, 2, 3, 4, 5];
    const z = [2, -1, -2, -1, 2];
    const withR = (r: number) => {
      const b = Math.sqrt((10 / r ** 2 - 10) / 14);
      return x.map((v, i) => v + b * z[i]!);
    };
    expect(correlation(x, withR(0.75))).toBeCloseTo(0.75, 9);
    expect(correlation(x, withR(0.65))).toBeCloseTo(0.65, 9);
    expect(correlationGroups([{ id: "a", values: x }, { id: "b", values: withR(0.75) }])).toEqual([["a", "b"]]);
    expect(correlationGroups([{ id: "a", values: x }, { id: "b", values: withR(0.65) }])).toEqual([["a"], ["b"]]);
  });
  test("demand 40 · supply 30 · credit 30; a group counts once; two axes the same way allow a change", () => {
    const inds = [
      { id: "rpo", axis: "demand" as const, signal: 1 as const },
      { id: "capex", axis: "demand" as const, signal: 1 as const },
      { id: "orders", axis: "demand" as const, signal: -1 as const },
      { id: "hbm", axis: "supply" as const, signal: 1 as const },
      { id: "abs", axis: "credit" as const, signal: 1 as const },
      { id: "hy", axis: "credit" as const, signal: 0 as const },
    ];
    // grouped: demand (+1 for the rpo/capex group, −1) / 2 = 0, supply 1, credit 0.5 → 0 + 30 + 15
    const c = composite(inds, [["rpo", "capex"]]);
    expect(c.byAxis).toEqual({ demand: 0, supply: 1, credit: 0.5 });
    expect(c.score).toBeCloseTo(45, 12);
    expect(c.scenarioChange).toEqual({ allowed: true, direction: 1 });
    // ungrouped the pair counts twice: demand 1/3 → 13.33 + 30 + 15
    expect(composite(inds).score).toBeCloseTo(58.3333, 4);
  });
  test("one axis alone never changes a scenario", () => {
    const c = composite([{ id: "x", axis: "demand", signal: -1 }]);
    expect(c.scenarioChange).toEqual({ allowed: false, direction: 0 });
    expect(c.byAxis).toEqual({ demand: -1, supply: null, credit: null });
  });
});

describe("B4 probability update", () => {
  test("evidence strength: strong needs 2 L1 + 3 weeks + a threshold break; medium 1 L1 or 2 L2; else weak", () => {
    expect(evidenceStrength({ l1: 2, l2: 0, weeks: 3, breached: true })).toBe("strong");
    expect(evidenceStrength({ l1: 2, l2: 0, weeks: 2, breached: true })).toBe("medium");
    expect(evidenceStrength({ l1: 0, l2: 2, weeks: 0, breached: false })).toBe("medium");
    expect(evidenceStrength({ l1: 0, l2: 1, weeks: 5, breached: true })).toBe("weak");
  });
  test("strong +10 on 50/30/20: the rest share 40 in proportion → 60/24/16", () => {
    expect(updateProbabilities({ s1: 50, s2: 30, s3: 20 }, { target: "s1", direction: 1, evidence: "strong", reason: "L1 2개 3주 임계 돌파" })).toEqual({ s1: 60, s2: 24, s3: 16 });
  });
  test("medium −5: 85 split 50 : 30 = 53.125 / 31.875, whole numbers by largest remainder → 53/32/15", () => {
    expect(updateProbabilities({ s1: 50, s2: 30, s3: 20 }, { target: "s3", direction: -1, evidence: "medium", reason: "L1 1개" })).toEqual({ s1: 53, s2: 32, s3: 15 });
  });
  test("weak changes nothing; a reason, a step in range, a known target and a sum of 100 are required", () => {
    const p = { a: 40, b: 60 };
    expect(updateProbabilities(p, { target: "a", direction: 1, evidence: "weak", reason: "T4 기사" })).toEqual(p);
    expect(() => updateProbabilities(p, { target: "a", direction: 1, evidence: "strong", reason: " " })).toThrow();
    expect(() => updateProbabilities(p, { target: "a", direction: 1, evidence: "strong", step: 7, reason: "x" })).toThrow();
    expect(() => updateProbabilities(p, { target: "c", direction: 1, evidence: "medium", reason: "x" })).toThrow();
    expect(() => updateProbabilities({ a: 40, b: 50 }, { target: "a", direction: 1, evidence: "medium", reason: "x" })).toThrow();
    expect(updateProbabilities(p, { target: "a", direction: 1, evidence: "strong", step: 15, reason: "x" })).toEqual({ a: 55, b: 45 });
  });
});

describe("B6 grading", () => {
  test("Brier: (0.3² + 0.2² + 0.9²) / 3", () => {
    expect(brier([{ p: 0.7, outcome: 1 }, { p: 0.2, outcome: 0 }, { p: 0.9, outcome: 0 }])!).toBeCloseTo(0.313333, 6);
    expect(brier([])).toBeNull();
  });
  test("hit rate leaves partial hits out and counts them", () => {
    expect(hitRate(["hit", "hit", "miss", "partial"])).toEqual({ rate: 2 / 3, hits: 2, misses: 1, partial: 1 });
    expect(hitRate(["partial"]).rate).toBeNull();
  });
  test("interval error: 0 inside, signed outside", () => {
    expect([intervalError(5, 1, 3), intervalError(0, 1, 3), intervalError(2, 1, 3)]).toEqual([2, -1, 0]);
  });
  test("source weights and targets", () => {
    expect([sourceWeight("T1", 0.1), sourceWeight("T2"), sourceWeight("T3", 0.59), sourceWeight("T2", 0.6), sourceWeight("T4", 0.9)]).toEqual([1, 1, 0.7, 1, 0]);
    expect(TARGETS).toEqual({ hitRate12m: 0.65, brier: 0.25 });
  });
});
