/** D2 backtest, D3 band fit, D4 volume profile, D8 flows and the series helpers, on hand-worked fixtures. */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { alignAsOf, and, atMost, below, inRange, median, regimeBacktest } from "../src/backtest";
import { bandFit } from "../src/band";
import { holdingRecovery, retracement, shortCoverVsTrend } from "../src/flows";
import { volumeProfile } from "../src/profile";
import { allOf, anyOf, inARow, monthsBefore, r9 } from "../src/series";
import type { Bar } from "../src/types";
import { barsFrom, daily, series } from "./fixtures";

describe("series helpers", () => {
  test("months back by date, the day clamped to the month", () => {
    expect(monthsBefore("2026-11-24", 6)).toBe("2026-05-24");
    expect(monthsBefore("2026-03-31", 1)).toBe("2026-02-28");
    expect(monthsBefore("2024-03-31", 1)).toBe("2024-02-29");
    expect(monthsBefore("2026-01-15", 2)).toBe("2025-11-15");
  });
  test("float noise removed before a threshold test", () => {
    expect(4.02 - 3.52).toBeLessThan(0.5);
    expect(r9(4.02 - 3.52)).toBe(0.5);
  });
  test("any / all with unknowns, and N in a row", () => {
    expect([anyOf("met", "unknown"), anyOf("unmet", "unknown"), anyOf("unmet", "unmet")]).toEqual(["met", "unknown", "unmet"]);
    expect([allOf("unmet", "unknown"), allOf("met", "unknown"), allOf("met", "met")]).toEqual(["unmet", "unknown", "met"]);
    expect([inARow([26, 27], 2, (v) => v >= 25), inARow([24, 27], 2, (v) => v >= 25), inARow([27], 2, (v) => v >= 25)]).toEqual(["met", "unmet", "unknown"]);
  });
});

describe("D2 regime backtest", () => {
  // closes 100 110 99 120 130 125 140, condition on days 0 1 2 (and 5, too close to the end), horizons 1 and 2
  const close = [100, 110, 99, 120, 130, 125, 140];
  const r = regimeBacktest(close, [true, true, true, false, false, true, false], { horizons: [1, 2], dates: close.map((_, i) => `d${i}`) });
  test("entries need every horizon ahead: day 5 is left out", () => {
    expect(r.n).toBe(3);
    expect(r.dates).toEqual(["d0", "d1", "d2"]);
  });
  test("1-day returns +10, −10, +21.21: win 66.7 %, median +10, worst −10", () => {
    expect(r.byHorizon[1]!.winRate!).toBeCloseTo(66.6667, 4);
    expect(r.byHorizon[1]!.median!).toBeCloseTo(10, 9);
    expect(r.byHorizon[1]!.worst!).toBeCloseTo(-10, 9);
  });
  test("2-day returns −1, +9.09, +31.31: median +9.09, worst −1", () => {
    expect(r.byHorizon[2]!.median!).toBeCloseTo(9.0909, 4);
    expect(r.byHorizon[2]!.worst!).toBeCloseTo(-1, 9);
  });
  test("MDD over 2 days, peak to trough: 100 110 99 → −10, 110 99 120 → −10, 99 120 130 → 0: median −10", () => {
    expect(r.medianMdd!).toBeCloseTo(-10, 9);
    expect(r.nonOverlapping).toEqual({ 1: 3, 2: 2 });
  });
  test("MDD against the entry close instead: −1, −10, 0 → median −1", () => {
    expect(regimeBacktest(close, [true, true, true, false, false, true, false], { horizons: [1, 2], mdd: "entry" }).medianMdd!).toBeCloseTo(-1, 9);
  });
  test("median of an even count is the middle pair's mean; none for no entries", () => {
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(regimeBacktest(close, close.map(() => false)).byHorizon[5]).toEqual({ winRate: null, median: null, worst: null });
  });
  test("aligning a US series to Korean dates: strict takes the day before", () => {
    const vix = series(["2026-11-20", 20], ["2026-11-23", 26], ["2026-11-24", 31]);
    expect(alignAsOf(vix, ["2026-11-19", "2026-11-23", "2026-11-24"])).toEqual([null, 26, 31]);
    expect(alignAsOf(vix, ["2026-11-19", "2026-11-23", "2026-11-24"], { strict: true })).toEqual([null, 20, 26]);
  });
  test("condition helpers: VIX 25~30 is [25, 30), deviation ≤ −20, RSI < 35, combined", () => {
    expect(inRange([24.9, 25, 29.99, 30, null], 25, 30)).toEqual([false, true, true, false, false]);
    expect(atMost([-20, -19.9], -20)).toEqual([true, false]);
    expect(below([35, 34.9], 35)).toEqual([false, true]);
    expect(and([true, true, false], [true, false, false])).toEqual([true, false, false]);
  });
});

describe("D3 band fit", () => {
  // closes 1..250 with high = low = close and equal volume: VWAP = the mean close of the window
  const bars = barsFrom("2026-01-01", Array.from({ length: 250 }, (_, i) => i + 1));
  test("125.5 against closes 1..250: percentile 50 %, Z 0, %B and VWAP gaps from the last 20 and 60", () => {
    const f = bandFit(bars, 125.5);
    expect(f.pct250).toBe(50);
    expect(f.z250!).toBeCloseTo(0, 12);
    // last 20 closes 231..250: mean 240.5, population σ √33.25
    const sd = Math.sqrt(33.25);
    expect(f.pctB!).toBeCloseTo((125.5 - (240.5 - 2 * sd)) / (4 * sd), 9);
    expect(f.vsVwap20!).toBeCloseTo((125.5 / 240.5 - 1) * 100, 9);
    expect(f.vsVwap60!).toBeCloseTo((125.5 / 220.5 - 1) * 100, 9);
    expect(f.asOf).toBe(bars.at(-1)!.t);
  });
  test("fewer than 250 bars: no percentile or Z", () => {
    const f = bandFit(bars.slice(0, 100), 50);
    expect([f.pct250, f.z250]).toEqual([null, null]);
    expect(f.pctB).not.toBeNull();
  });
});

describe("D4 volume profile", () => {
  // two bars over 0–4 in 4 bins: 0–4 (close 0.5, 100) and 2–4 (close 3, 50)
  const bars: Bar[] = [
    { t: "2026-11-23", o: 1, h: 4, l: 0, c: 0.5, v: 100 },
    { t: "2026-11-24", o: 3, h: 4, l: 2, c: 3, v: 50 },
  ];
  test("range: each day's volume spread over its low–high → 25 25 50 50", () => {
    const p = volumeProfile(bars, { days: 2, bins: 4 })!;
    expect([p.lo, p.hi, p.width]).toEqual([0, 4, 1]);
    expect(p.bins.map((b) => b.volume)).toEqual([25, 25, 50, 50]);
    expect(p.bins.map((b) => b.mid)).toEqual([0.5, 1.5, 2.5, 3.5]);
    expect(p.bins[2]!.share).toBeCloseTo(33.3333, 4);
    expect(p.top.map((b) => b.mid)).toEqual([2.5, 3.5, 0.5]);
  });
  test("typical price (1.5 and 3) and close (0.5 and 3) put a day in one bin", () => {
    expect(volumeProfile(bars, { days: 2, bins: 4, mode: "typical" })!.bins.map((b) => b.volume)).toEqual([0, 100, 0, 50]);
    expect(volumeProfile(bars, { days: 2, bins: 4, mode: "close" })!.bins.map((b) => b.volume)).toEqual([100, 0, 0, 50]);
  });
  test("120 days by default; fewer bars, none", () => {
    expect(volumeProfile(bars)).toBeNull();
  });
});

describe("D8 short cover or trend turn", () => {
  test("retracement: the latest buying run ÷ the 20 days of selling before it", () => {
    expect(retracement(daily("2026-10-01", [...Array(20).fill(-10), 60]))).toEqual({ bought: 60, sold: 200, pct: 30 });
    expect(retracement(daily("2026-10-01", [...Array(21).fill(-10), 60, 50]))!.pct).toBe(55);
    expect(retracement(daily("2026-10-01", [...Array(20).fill(-10), -5]))).toBeNull();
  });
  test("a holding ratio moving against the same window's net trading is set aside", () => {
    const hold = daily("2026-10-01", [48.66, ...Array(19).fill(49), 49.33]);
    const r = holdingRecovery(hold, daily("2026-10-02", Array(20).fill(-2)))!;
    expect([r.change, r.netSum, r.conflict]).toEqual([0.67, -40, true]);
  });
  test("all five met, and the trend turn needs ①, ② and ⑤", () => {
    const buy = daily("2026-10-01", [...Array(20).fill(-10), 80, 70, 60]);
    const r = shortCoverVsTrend({
      samsungForeign: buy,
      samsungHolding: daily("2026-10-03", [46.19, ...Array(19).fill(46.0), 46.2]),
      programNonArb: daily("2026-11-18", [1, 2, 3]),
      hynixForeign: daily("2026-10-21", [-1, -1, 5]),
    });
    expect(r.criteria.map((c) => c.status)).toEqual(["met", "met", "met", "met", "met"]);
    expect(r.trendTurn).toBe("met");
  });
  test("the 11-24 shape: one buying day, Hynix selling → not a trend turn; no data → unknown", () => {
    const r = shortCoverVsTrend({
      samsungForeign: daily("2026-10-01", [...Array(20).fill(-60), 235]),
      samsungHolding: daily("2026-10-01", [46.19, ...Array(19).fill(46.0), 45.89]),
      programNonArb: daily("2026-11-22", [-5, 3360]),
      hynixForeign: daily("2026-10-20", [-10, -11.9]),
    });
    expect(r.criteria.map((c) => c.status)).toEqual(["unmet", "unmet", "unmet", "unmet", "unmet"]);
    expect(r.criteria[2]!.value).toBeCloseTo(19.5833, 4);
    expect(r.trendTurn).toBe("unmet");
    const none = shortCoverVsTrend({});
    expect([none.unknown, none.trendTurn]).toEqual([5, "unknown"]);
  });
  test("short data is unknown, not unmet: two buying days of two, a run without its 20 days before, Hynix on another day", () => {
    const r = shortCoverVsTrend({
      samsungForeign: daily("2026-10-01", [...Array(18).fill(-10), 50, 50, 50]),
      programNonArb: daily("2026-10-20", [100, 200]),
      hynixForeign: daily("2026-10-10", [5]),
    });
    expect(r.criteria.map((c) => c.status)).toEqual(["met", "unknown", "unknown", "unknown", "unknown"]);
    expect(r.criteria[4]!.note).toBe("날짜 불일치: 하닉 2026-10-10, 삼전 2026-10-21");
    // a selling day inside the last three is unmet whatever the length
    expect(shortCoverVsTrend({ programNonArb: daily("2026-10-20", [-1, 200]) }).criteria[3]!.status).toBe("unmet");
  });
});

describe("purity", () => {
  test("src reads no network, clock, randomness, file or process", () => {
    const dir = join(import.meta.dir, "../src");
    for (const f of readdirSync(dir)) {
      const s = readFileSync(join(dir, f), "utf8");
      for (const bad of ["fetch(", "Date.now", "new Date", "Math.random", 'from "node:', "process.", "Bun.", "require("]) expect(`${f}: ${s.includes(bad) ? bad : ""}`).toBe(`${f}: `);
    }
  });
});
