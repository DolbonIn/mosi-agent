/** A2, the eleven core indicators: the table kept word for word, and each threshold at its exact boundary. */
import { describe, expect, test } from "bun:test";
import { CORE11, CORE11_LIMITS, capexBelowTwo, judgeCore11, momFromIndex, netFlowFigures, type Core11Input } from "../src/risk11";
import type { Point } from "../src/types";
import { daily, series } from "./fixtures";

const one = (input: Core11Input, no: number) => judgeCore11(input).items[no - 1]!;

describe("the table", () => {
  test("eleven rows, names and rules word for word (the master prompt's A2)", () => {
    expect(CORE11.map((r) => [r.name, r.rule])).toEqual([
      ["미국 10년물 금리", "`>5%` 🔴 / `≤5%` 🟢"],
      ["2년물 − 기준금리 상단", "`>0` 🔴 / `≤0` 🟢"],
      ["하이일드 스프레드", "6개월 최저 대비 `+0.5%p↑` 🔴 / `+0.3~0.5%p` 🟡 / `<+0.3%p` 🟢"],
      ["엔화 절상률(엔캐리)", "1개월 절상 `≥5%` 🔴 / `3~5%` 🟡 / `<3%` 🟢"],
      ["미국 실업률", "직전 발표 대비 상승 🟡 / 2026년 8월 기준 **4.1%** 대비 `+0.3%p↑` 🔴 / 그 외 🟢"],
      ["삼전·하닉 이익 컨센서스", "최근 3개월 12M fwd 이익 전망 `−5% 초과` 🔴(둘 중 하나라도) / 그 외 🟢"],
      ["S&P500 시장 폭", "200일선 상회 종목 `<60%` 🔴 / `≥60%` 🟢"],
      ["M7 이익 전망", "**M7 전체** 이익 전망 하향 전환 🔴 / 미확인 🟢"],
      ["외국인 코스피 순매매", "대규모 순매도 지속 🟡"],
      ["미국 근원 CPI", "MoM `≥0.3%` 🔴 / `0.2~0.3%` 🟡 / `<0.2%` 🟢"],
      ["빅테크 AI CAPEX", "내년 설비투자 증가율 `<20%` 🔴(개별)"],
    ]);
    expect(CORE11.map((r) => r.no)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });
  test("the numbers match the rules, 4.1 % fixed", () => {
    expect(CORE11_LIMITS.unrate).toEqual({ base: 4.1, risk: 0.3 });
    expect(CORE11_LIMITS.hy).toEqual({ risk: 0.5, caution: 0.3 });
    expect(CORE11_LIMITS.yen).toEqual({ risk: 5, caution: 3 });
    expect(CORE11_LIMITS.cpi).toEqual({ risk: 0.3, caution: 0.2 });
    expect([CORE11_LIMITS.dgs10, CORE11_LIMITS.policyGap, CORE11_LIMITS.eps, CORE11_LIMITS.breadth, CORE11_LIMITS.capex]).toEqual([5, 0, -5, 60, 20]);
  });
});

describe("each indicator at its boundary", () => {
  test("1 · 10-year: 5.00 is 🟢 (≤5), 5.01 🔴; days above 5 counted from the latest", () => {
    expect(one({ dgs10: daily("2026-11-01", [4.9, 5.0]) }, 1).signal).toBe("normal");
    const r = one({ dgs10: daily("2026-11-01", [5.1, 4.9, 5.1, 5.01]) }, 1);
    expect(r.signal).toBe("risk");
    expect(r.extras.daysAbove5).toBe(2);
    expect(r.asOf).toBe("2026-11-04");
  });
  test("2 · 2-year minus the upper bound on or before that day: +0.05 🔴, 0 🟢", () => {
    const upper = [{ t: "2026-10-01", v: 3.75 }];
    expect(one({ dgs2: daily("2026-11-01", [3.8]), fedUpper: upper }, 2).signal).toBe("risk");
    const g = one({ dgs2: daily("2026-11-01", [3.75]), fedUpper: upper }, 2);
    expect([g.signal, g.value]).toEqual(["normal", 0]);
    expect(one({ dgs2: daily("2026-11-01", [3.8]), fedUpper: [{ t: "2026-11-02", v: 3.5 }] }, 2).signal).toBe("unknown");
  });
  test("3 · high yield against its 6-month low: +0.50 🔴 (4.02 − 3.52 in floats is 0.4999…), +0.30 🟡, +0.29 🟢", () => {
    // a lower 3.00 seven months back is outside the window; the low inside is 3.52
    const base = [{ t: "2026-04-20", v: 3.0 }, { t: "2026-06-01", v: 3.52 }, { t: "2026-09-01", v: 3.7 }];
    const at = (v: number) => one({ hy: [...base, { t: "2026-11-24", v }] }, 3);
    expect(at(4.02).signal).toBe("risk");
    expect(at(4.02).value).toBe(0.5);
    expect(at(3.82).signal).toBe("caution");
    expect(at(3.81).signal).toBe("normal");
    expect(at(4.02).extras.low6m).toBe(3.52);
    expect(judgeCore11({ hy: [...base, { t: "2026-11-24", v: 4.02 }] }).hyRisk).toBe("met");
    // 2.8 − 2.5 in floats is 0.2999…
    expect(one({ hy: series(["2026-05-01", 2.6], ["2026-10-01", 2.5], ["2026-11-24", 2.8]) }, 3).signal).toBe("caution");
  });
  test("3 · the 6-month window starts after the same day six months before", () => {
    // 2026-05-24 is exactly six months before 11-24: outside (but it shows the series reaches back); 05-25 inside
    expect(one({ hy: [{ t: "2026-05-24", v: 2.0 }, { t: "2026-11-24", v: 2.4 }] }, 3).extras.low6m).toBe(2.4);
    expect(one({ hy: [{ t: "2026-04-01", v: 3.0 }, { t: "2026-05-25", v: 2.0 }, { t: "2026-11-24", v: 2.4 }] }, 3).extras.low6m).toBe(2.0);
  });
  test("3 · a history short of six months gives no 6-month low: ⚪, never 🟢 from the part at hand", () => {
    const r = one({ hy: [{ t: "2026-05-25", v: 4.4 }, { t: "2026-11-24", v: 4.4 }] }, 3);
    expect([r.signal, r.asOf, r.mayBeRisk]).toEqual(["unknown", "2026-11-24", true]);
    expect(judgeCore11({ hy: [{ t: "2026-11-24", v: 4.4 }] }).hyRisk).toBe("unknown");
  });
  test("4 · a month ago more than a week older than its day is stale: ⚪", () => {
    expect(one({ usdjpy: [{ t: "2026-05-01", v: 160 }, { t: "2026-11-24", v: 150 }] }, 4).signal).toBe("unknown");
    expect(one({ usdjpy: [{ t: "2026-10-17", v: 160 }, { t: "2026-11-24", v: 150 }] }, 4).signal).toBe("risk");
    expect(one({ usdjpy: [{ t: "2026-10-16", v: 160 }, { t: "2026-11-24", v: 150 }] }, 4).signal).toBe("unknown");
  });
  test("4 · yen: (a month ago ÷ now − 1) × 100, 5 🔴, 3 🟡, 2.99 🟢; a month ago is the last value on or before that day", () => {
    const yen = (now: number) => one({ usdjpy: [{ t: "2026-10-23", v: 150 }, { t: "2026-11-02", v: 149 }, { t: "2026-11-24", v: now }] }, 4);
    expect(yen(150 / 1.05).signal).toBe("risk");
    expect(yen(150 / 1.05).value).toBe(5);
    expect(yen(150 / 1.03).signal).toBe("caution");
    expect(yen(150 / 1.0299).signal).toBe("normal");
    expect(yen(150).extras.monthAgoAsOf).toBe("2026-10-23");
    expect(one({ usdjpy: [{ t: "2026-11-24", v: 150 }] }, 4).signal).toBe("unknown");
  });
  test("5 · unemployment: 4.4 is 4.1 + 0.3 🔴; a rise below that 🟡; flat 🟢; no prior release and not risk ⚪", () => {
    expect(one({ unrate: series(["2026-09-01", 4.3], ["2026-10-01", 4.4]) }, 5).signal).toBe("risk");
    expect(one({ unrate: series(["2026-10-01", 4.4]) }, 5).signal).toBe("risk");
    expect(one({ unrate: series(["2026-09-01", 4.5], ["2026-10-01", 4.3]) }, 5).signal).toBe("normal");
    expect(one({ unrate: series(["2026-09-01", 4.2], ["2026-10-01", 4.3]) }, 5).signal).toBe("caution");
    // no prior release: 🔴 already ruled out, so this unknown cannot add a risk
    const u = one({ unrate: series(["2026-10-01", 4.3]) }, 5);
    expect([u.signal, u.mayBeRisk]).toEqual(["unknown", false]);
    expect(one({}, 5).mayBeRisk).toBe(true);
  });
  test("6 · Samsung/Hynix 3-month revision: −5.0 is not beyond −5 (🟢), −5.1 🔴 for either; one missing and no risk ⚪", () => {
    const p = (v: number | null): Point => ({ t: "2026-11-20", v });
    expect(one({ eps3m: { samsung: p(-5), hynix: p(2) } }, 6).signal).toBe("normal");
    const r = one({ eps3m: { samsung: p(1), hynix: p(-5.1) } }, 6);
    expect([r.signal, r.value, r.extras.riskCount]).toEqual(["risk", -5.1, 1]);
    expect(one({ eps3m: { samsung: p(1), hynix: p(null) } }, 6).signal).toBe("unknown");
    expect(one({ eps3m: { samsung: p(-6), hynix: null } }, 6).signal).toBe("risk");
    expect(one({}, 6).signal).toBe("unknown");
  });
  test("7 · breadth: 59.9 🔴, 60 🟢", () => {
    expect(one({ breadth200: daily("2026-11-24", [59.9]) }, 7).signal).toBe("risk");
    expect(one({ breadth200: daily("2026-11-24", [60]) }, 7).signal).toBe("normal");
  });
  test("8 · M7: all seven down 🔴; one not down 🟢; some down and the rest unconfirmed ⚪ (never read as all seven)", () => {
    const all = { AAPL: true, MSFT: true, GOOGL: true, AMZN: true, META: true, NVDA: true, TSLA: true };
    const r = one({ m7: { t: "2026-11-20", down: all } }, 8);
    expect([r.signal, r.value, r.asOf]).toEqual(["risk", 7, "2026-11-20"]);
    const g = one({ m7: { t: "2026-11-20", down: { ...all, AAPL: false } } }, 8);
    expect([g.signal, g.reason]).toEqual(["normal", "하향 아님: AAPL"]);
    // one not down settles 🟢 even with others unconfirmed
    expect(one({ m7: { t: "2026-11-20", down: { NVDA: true, MSFT: false } } }, 8).signal).toBe("normal");
    const u = one({ m7: { t: "2026-11-20", down: { ...all, TSLA: null, META: undefined } } }, 8);
    expect([u.signal, u.reason, u.mayBeRisk, u.asOf]).toEqual(["unknown", "하향 5/7, 미확인: META·TSLA", true, "2026-11-20"]);
    expect(one({}, 8).signal).toBe("unknown");
  });
  test("9 · foreign KOSPI: 🟡 only from the judgment with its basis, never 🔴; the figures from the flows", () => {
    const flows = daily("2026-10-01", [...Array(18).fill(-100), 50, -300]);
    const y = one({ foreignKospi: flows, foreignSelling: { t: "2026-10-20", sustained: true, basis: "20일 누적 −2조" } }, 9);
    expect(y.signal).toBe("caution");
    expect([y.extras.day, y.extras.sum5, y.extras.sum20, y.extras.sellStreak, y.extras.buyStreak]).toEqual([-300, -550, -2050, 1, 0]);
    expect(one({ foreignKospi: flows, foreignSelling: { t: "2026-10-20", sustained: false, basis: "5일 순매수" } }, 9).signal).toBe("normal");
    const u = one({ foreignKospi: flows }, 9);
    expect([u.signal, u.mayBeRisk, u.asOf]).toEqual(["unknown", false, "2026-10-20"]);
  });
  test("10 · core CPI MoM as published: 0.3 🔴, 0.29 and 0.2 🟡, 0.1 🟢", () => {
    const at = (v: number) => one({ coreCpiMoM: series(["2026-10-01", v]) }, 10).signal;
    expect([at(0.3), at(0.29), at(0.2), at(0.19), at(0.1)]).toEqual(["risk", "caution", "caution", "normal", "normal"]);
  });
  test("reason numbers go through format.ts (DD 2045): a negative month is U+2212, a zero gap has no sign", () => {
    expect(one({ coreCpiMoM: series(["2026-10-01", -0.1]) }, 10).reason).toBe("MoM −0.1% < 0.2%");
    const g = one({ dgs2: daily("2026-11-01", [3.749]), fedUpper: [{ t: "2026-10-01", v: 3.75 }] }, 2);
    expect(g.reason).toBe("3.75% − 3.75% = 0.00%p ≤ 0");
  });
  test("10 · MoM from the index: a missing month gives no value for the month after it (no two-month change)", () => {
    expect(momFromIndex(series(["2025-09-01", 330], ["2025-10-01", null], ["2025-11-01", 331.32], ["2025-12-01", 331.65]))).toEqual([{ t: "2025-12-01", v: 0.1 }]);
    expect(momFromIndex(series(["2025-12-01", 100], ["2026-01-01", 100.2]))).toEqual([{ t: "2026-01-01", v: 0.2 }]);
  });
  test("10 · MoM from the index, rounded to one decimal as BLS rounds it", () => {
    // 100 → 100.34 is 0.34 % → 0.3; 100.34 → 100.5 is 0.159 % → 0.2
    expect(momFromIndex(series(["2026-09-01", 100], ["2026-10-01", 100.34], ["2026-11-01", 100.5]))).toEqual([
      { t: "2026-10-01", v: 0.3 },
      { t: "2026-11-01", v: 0.2 },
    ]);
  });
  test("11 · capex: one company below 20 🔴 (per company), all at or above 🟢, one missing ⚪; two below → A5's A6", () => {
    const p = (v: number | null): Point => ({ t: "2026-10-30", v });
    const r = one({ capex: { MSFT: p(19.9), GOOGL: p(25), META: p(30), AMZN: p(20) } }, 11);
    expect([r.signal, r.extras.riskCount]).toEqual(["risk", 1]);
    expect(one({ capex: { MSFT: p(20), GOOGL: p(25), META: p(30), AMZN: p(20) } }, 11).signal).toBe("normal");
    expect(one({ capex: { MSFT: p(20), GOOGL: p(25), META: p(30) } }, 11).signal).toBe("unknown");
    expect(capexBelowTwo({ capex: { MSFT: p(19), GOOGL: p(18), META: p(30), AMZN: p(25) } }).status).toBe("met");
    expect(capexBelowTwo({ capex: { MSFT: p(19), GOOGL: p(25), META: p(30) } }).status).toBe("unknown");
    expect(capexBelowTwo({ capex: { MSFT: p(19), GOOGL: p(25), META: p(30), AMZN: p(25) } }).status).toBe("unmet");
  });
});

describe("the result", () => {
  test("no input: eleven ⚪, none read as 🟢", () => {
    const r = judgeCore11({});
    expect(r.counts).toEqual({ normal: 0, caution: 0, risk: 0, unknown: 11 });
    // all but indicator 9 (no 🔴 exists for it) could still be risk
    expect(r.riskPossible).toBe(10);
    expect(r.hyRisk).toBe("unknown");
  });
  test("counts by signal", () => {
    const r = judgeCore11({ dgs10: daily("2026-11-24", [5.2]), breadth200: daily("2026-11-24", [55]), coreCpiMoM: series(["2026-10-01", 0.2]) });
    expect(r.counts).toEqual({ normal: 0, caution: 1, risk: 2, unknown: 8 });
  });
  test("net flow figures: no sums before enough days", () => {
    expect(netFlowFigures(daily("2026-11-20", [10, 20, -5]))).toEqual({ asOf: "2026-11-22", day: -5, sum5: null, sum20: null, buyStreak: 0, sellStreak: 1 });
    expect(netFlowFigures([])).toBeNull();
  });
});
