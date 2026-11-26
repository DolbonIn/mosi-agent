/** A5 and A6: escape stage from 4 down with unknowns kept open, recovery stage from the top with its hold. */
import { describe, expect, test } from "bun:test";
import {
  ESCAPE_STAGES,
  RECOVERY_HOLD,
  RECOVERY_RULES,
  RECOVERY_STAGES,
  assessStages,
  escapeLabel,
  recoveryOutcome,
  type StageInput,
} from "../src/stages";
import { daily, series } from "./fixtures";

/** high yield: a point before the 6-month window (the series reaches back), the 6-month low on 06-01, then 20 daily
 * values ending on 11-10 */
const hyWith = (low: number, recent: readonly number[]) => [{ t: "2026-05-01", v: 3.0 }, { t: "2026-06-01", v: low }, ...daily("2026-10-22", recent)];

/** 207 closes at 100, then three at `last`: the 200-day average stays near 100 */
const spx = (last: number) => daily("2026-04-01", [...Array(207).fill(100), last, last, last]);

/** every input known and benign: eleven 🟢, A 0/8, D 0/5, R 6/6 */
function calm(): StageInput {
  return {
    dgs10: daily("2026-10-30", Array(12).fill(4.2)),
    dgs2: daily("2026-11-10", [3.5]),
    fedUpper: series(["2026-09-18", 3.75]),
    hy: hyWith(2.8, [...Array(19).fill(3.0), 2.9]),
    usdjpy: series(["2026-10-10", 150], ["2026-11-10", 150]),
    unrate: series(["2026-09-01", 4.2], ["2026-10-01", 4.2]),
    eps3m: { samsung: { t: "2026-11-07", v: 1 }, hynix: { t: "2026-11-07", v: 1 } },
    breadth200: daily("2026-11-10", [65]),
    m7: { t: "2026-11-07", down: { AAPL: false, MSFT: false, GOOGL: false, AMZN: false, META: false, NVDA: false, TSLA: false } },
    foreignKospi: daily("2026-10-20", Array(20).fill(10)),
    foreignSelling: { t: "2026-11-10", sustained: false, basis: "20일 연속 순매수" },
    coreCpiMoM: series(["2026-10-01", 0.1]),
    capex: { MSFT: { t: "2026-10-30", v: 30 }, GOOGL: { t: "2026-10-30", v: 30 }, META: { t: "2026-10-30", v: 30 }, AMZN: { t: "2026-10-30", v: 30 } },
    vix: daily("2026-11-01", Array(10).fill(15)),
    spx: spx(110),
    sahm: series(["2026-10-01", 0.1]),
    claims4w: series(["2026-11-07", 220_000]),
    kospi: spx(110),
    usdkrw: series(["2026-10-10", 1400], ["2026-11-10", 1410]),
    nfci: series(["2026-11-07", -0.5]),
  };
}

/** ten VIX closes, the last two at 26 and 27 */
const VIX_UP = daily("2026-11-01", [...Array(8).fill(15), 26, 27]);

/** three core risks (10-year, breadth, CPI) and A2 + A4 met: stage 3 */
function stressed(): StageInput {
  return { ...calm(), dgs10: daily("2026-10-30", [...Array(11).fill(4.2), 5.2]), breadth200: daily("2026-11-10", [55]), coreCpiMoM: series(["2026-10-01", 0.3]), vix: VIX_UP };
}

test("no reason, label or figure string carries an emoji or markdown (DD 2045; the verbatim rule text is exempt)", () => {
  const strings: string[] = [];
  const walk = (v: unknown, key = ""): void => {
    if (key === "rule") return;
    if (typeof v === "string") strings.push(v);
    else if (Array.isArray(v)) v.forEach((x) => walk(x));
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, k);
  };
  const p = (v: number) => ({ t: "2026-10-30", v });
  const mixes: StageInput[] = [
    calm(),
    stressed(),
    {},
    { ...calm(), eps3m: { samsung: p(-6), hynix: p(2) }, capex: { MSFT: p(19), GOOGL: p(30), META: p(30), AMZN: p(30) } },
    { ...stressed(), eps3m: { samsung: p(-6), hynix: null }, m7: { t: "2026-11-20", down: { AAPL: true } } },
  ];
  for (const m of mixes) walk(assessStages(m));
  expect(strings.length).toBeGreaterThan(100);
  const bad = strings.filter((s) => /\p{Extended_Pictographic}|`|\*\*/u.test(s));
  expect(bad).toEqual([]);
  expect(strings.some((s) => s.includes("위험 기준: samsung"))).toBe(true);
});

test("signal values are normal / caution / risk / unknown (lead 2058), every one of them reached", () => {
  const p = (v: number) => ({ t: "2026-10-30", v });
  const seen = new Set<string>();
  const mixes: StageInput[] = [calm(), stressed(), {}, { ...calm(), eps3m: { samsung: p(-6), hynix: p(2) }, coreCpiMoM: series(["2026-10-01", 0.25]) }];
  for (const m of mixes) {
    const core = assessStages(m).core;
    expect(Object.keys(core.counts).sort()).toEqual(["caution", "normal", "risk", "unknown"]);
    for (const j of core.items) seen.add(j.signal);
  }
  expect([...seen].sort()).toEqual(["caution", "normal", "risk", "unknown"]);
});

describe("the tables", () => {
  test("stage names and conditions word for word", () => {
    expect(Object.values(ESCAPE_STAGES).map((s) => s.name)).toEqual(["관찰", "경계", "방어 준비", "회피"]);
    expect(ESCAPE_STAGES[2].rule).toBe("핵심 🔴 ≥3 **OR** 하이일드 🔴");
    expect(ESCAPE_STAGES[4].rule).toBe("D1~D5 중 **2개 이상**");
    expect(Object.values(RECOVERY_STAGES).map((s) => s.name)).toEqual(["하락 진행", "바닥 탐색", "분할 재진입 검토", "추세 회복"]);
    expect(RECOVERY_STAGES[3].rule).toBe("신호 ≥5 **AND R3 필수** **AND** 탈출 ≤2단계");
    expect(RECOVERY_RULES.R2).toBe("하이일드가 최근 고점 대비 `−0.5%p 이상` 축소 **또는** 6개월 최저 대비 확대 폭 `<+0.5%p`");
    expect(RECOVERY_HOLD).toBe("회복 신호 확인, 단계 판정 보류");
  });
  test("labels: the master prompt's own example, a wider open range, a settled stage", () => {
    expect(escapeLabel(3, 4)).toBe("최소 3단계, 4단계 여부 미확정");
    expect(escapeLabel(1, 4)).toBe("최소 1단계, 2~4단계 여부 미확정");
    expect(escapeLabel(2, 2)).toBe("2단계 경계");
  });
});

describe("escape stage (A5)", () => {
  test("calm: every condition known, stage 1 settled", () => {
    const s = assessStages(calm());
    expect(s.core.counts).toEqual({ normal: 11, caution: 0, risk: 0, unknown: 0 });
    expect(s.a.map((c) => c.status)).toEqual(Array(8).fill("unmet"));
    expect(s.d.map((c) => c.status)).toEqual(Array(5).fill("unmet"));
    expect(s.escape).toMatchObject({ floor: 1, ceiling: 1, confirmed: true, label: "1단계 관찰" });
  });
  test("no data: never settled low, open up to 4", () => {
    const s = assessStages({});
    expect(s.escape).toMatchObject({ floor: 1, ceiling: 4, confirmed: false, label: "최소 1단계, 2~4단계 여부 미확정" });
    expect(s.escape.gauges).toEqual({ a: { met: 0, unknown: 8, of: 8 }, d: { met: 0, unknown: 5, of: 5 } });
  });
  test("high yield risk alone is stage 2", () => {
    const s = assessStages({ ...calm(), hy: hyWith(2.8, [...Array(19).fill(3.0), 3.3]) });
    expect(s.core.counts.risk).toBe(1);
    expect(s.escape.label).toBe("2단계 경계");
  });
  test("three core risks and two of A1–A8: stage 3", () => {
    const s = assessStages(stressed());
    expect(s.a.filter((c) => c.status === "met").map((c) => c.id)).toEqual(["A2", "A4"]);
    expect(s.escape.label).toBe("3단계 방어 준비");
  });
  test("one D met and one unknown: 최소 3단계, 4단계 여부 미확정, the unknown named", () => {
    const { nfci: _, ...rest } = stressed();
    const s = assessStages({ ...rest, sahm: series(["2026-10-01", 0.5]) });
    expect(s.d.map((c) => c.status)).toEqual(["unmet", "unmet", "unmet", "met", "unknown"]);
    expect(s.escape.label).toBe("최소 3단계, 4단계 여부 미확정");
    expect(s.escape.open).toEqual(["D5"]);
  });
  test("two D met is stage 4 whatever else holds", () => {
    const s = assessStages({ ...calm(), sahm: series(["2026-10-01", 0.5]), nfci: series(["2026-11-07", 0]) });
    expect(s.escape.label).toBe("4단계 회피");
  });
  test("two risks and one unknown core indicator: stage 2 may hold", () => {
    const { dgs2: _, ...rest } = { ...calm(), dgs10: daily("2026-10-30", [...Array(11).fill(4.2), 5.2]), breadth200: daily("2026-11-10", [55]) };
    const s = assessStages(rest);
    expect(s.escape.label).toBe("최소 1단계, 2단계 여부 미확정");
    expect(s.escape.open).toEqual(["#2"]);
  });
  test("the 200-day rules: three closes under the average (A3), 50 under 200 and 5 % below (D3)", () => {
    const s = assessStages({ ...calm(), spx: spx(90) });
    expect(s.a.find((c) => c.id === "A3")!.status).toBe("met");
    expect(s.d.find((c) => c.id === "D3")!.status).toBe("met");
    expect(s.r.find((c) => c.id === "R3")!.status).toBe("unmet");
    // fewer than 202 closes: unknown, never unmet
    const short = assessStages({ ...calm(), spx: daily("2026-04-01", Array(150).fill(100)) });
    expect(short.a.find((c) => c.id === "A3")!.status).toBe("unknown");
  });
});

describe("each A and D condition on its own", () => {
  const status = (input: StageInput, id: string) => {
    const s = assessStages(input);
    return [...s.a, ...s.d].find((c) => c.id === id)!.status;
  };
  const cases: [string, Partial<StageInput>, "met" | "unmet"][] = [
    ["A1", { hy: hyWith(2.8, [...Array(19).fill(3.0), 3.5]) }, "met"],
    ["A1", { hy: hyWith(2.0, [...Array(19).fill(2.5), 3.0]) }, "met"],
    ["A1", { hy: hyWith(2.0, [...Array(19).fill(2.5), 2.99]) }, "unmet"],
    ["A2", { vix: VIX_UP }, "met"],
    ["A2", { vix: daily("2026-11-01", [...Array(8).fill(15), 26, 24]) }, "unmet"],
    ["A3", { spx: spx(90) }, "met"],
    ["A4", { coreCpiMoM: series(["2026-10-01", 0.3]) }, "met"],
    ["A5", { dgs10: daily("2026-10-30", [4.9, ...Array(10).fill(5.01)]) }, "met"],
    ["A5", { dgs10: daily("2026-10-30", [4.9, 4.9, ...Array(9).fill(5.01)]) }, "unmet"],
    ["A6", { capex: { MSFT: { t: "2026-10-30", v: 19 }, GOOGL: { t: "2026-10-30", v: 18 }, META: { t: "2026-10-30", v: 30 }, AMZN: { t: "2026-10-30", v: 30 } } }, "met"],
    ["A7", { sahm: series(["2026-10-01", 0.3]) }, "met"],
    ["A7", { claims4w: series(["2026-11-07", 250_000]) }, "met"],
    ["A7", { claims4w: series(["2026-11-07", 249_999]) }, "unmet"],
    ["A8", { kospi: spx(90), usdkrw: series(["2026-10-10", 1400], ["2026-11-10", 1470]) }, "met"],
    ["A8", { kospi: spx(90), usdkrw: series(["2026-10-10", 1400], ["2026-11-10", 1468]) }, "unmet"],
    ["A8", { usdkrw: series(["2026-10-10", 1400], ["2026-11-10", 1470]) }, "unmet"],
    ["D1", { hy: hyWith(2.8, [...Array(19).fill(3.0), 4.0]) }, "met"],
    ["D1", { hy: hyWith(2.0, [...Array(19).fill(2.5), 3.5]) }, "met"],
    ["D1", { hy: hyWith(2.0, [...Array(19).fill(2.5), 3.49]) }, "unmet"],
    ["D2", { vix: daily("2026-11-01", [...Array(7).fill(15), 30, 31, 30]) }, "met"],
    ["D2", { vix: daily("2026-11-01", [...Array(7).fill(15), 29, 31, 30]) }, "unmet"],
    // 50-day under 200-day while the close is only 4.1 % under it
    ["D3", { spx: daily("2026-04-01", [...Array(150).fill(110), ...Array(50).fill(104)]) }, "met"],
    // the close 11.5 % under the 200-day while the 50-day is above it
    ["D3", { spx: daily("2026-04-01", [...Array(160).fill(100), ...Array(49).fill(130), 95]) }, "met"],
    ["D4", { sahm: series(["2026-10-01", 0.5]) }, "met"],
    ["D4", { sahm: series(["2026-10-01", 0.49]) }, "unmet"],
    ["D5", { nfci: series(["2026-11-07", 0]) }, "met"],
  ];
  for (const [id, patch, want] of cases)
    test(`${id} ${want}: ${JSON.stringify(Object.keys(patch))}`, () => {
      expect(status({ ...calm(), ...patch }, id)).toBe(want);
    });
  test("the D3 fixtures meet one branch each", () => {
    const one = assessStages({ ...calm(), spx: daily("2026-04-01", [...Array(150).fill(110), ...Array(50).fill(104)]) }).d[2]!.figures;
    expect((one.ma50 as number) < (one.ma200 as number) && (one.dev200 as number) > -5).toBe(true);
    const two = assessStages({ ...calm(), spx: daily("2026-04-01", [...Array(160).fill(100), ...Array(49).fill(130), 95]) }).d[2]!.figures;
    expect((two.ma50 as number) >= (two.ma200 as number) && (two.dev200 as number) <= -5).toBe(true);
  });
  test("an unknown that cannot be risk (indicator 9 with no judgment) leaves stage 1 settled", () => {
    const { foreignSelling: _, ...rest } = { ...calm(), dgs10: daily("2026-10-30", [...Array(11).fill(4.2), 5.2]), breadth200: daily("2026-11-10", [55]) };
    const s = assessStages(rest);
    expect([s.core.counts.risk, s.core.counts.unknown, s.core.riskPossible]).toEqual([2, 1, 0]);
    expect(s.escape.label).toBe("1단계 관찰");
  });
});

describe("recovery stage (A6)", () => {
  test("the table read from the top", () => {
    expect(recoveryOutcome(5, true, true, true)).toBe(3);
    expect(recoveryOutcome(5, false, true, true)).toBe(2);
    expect(recoveryOutcome(6, true, true, false)).toBe(2);
    expect(recoveryOutcome(6, true, false, false)).toBe("hold");
    expect(recoveryOutcome(4, true, false, true)).toBe("hold");
    expect(recoveryOutcome(3, false, false, false)).toBe(1);
    expect(recoveryOutcome(2, false, false, false)).toBe(1);
    expect(recoveryOutcome(1, true, true, true)).toBe(0);
  });
  test("calm: six signals with R3 and escape 1 → 3단계 추세 회복", () => {
    const s = assessStages(calm());
    expect(s.recovery).toMatchObject({ stage: 3, label: "3단계 추세 회복", gauge: { met: 6, unknown: 0, of: 6 } });
  });
  test("four signals with one D signal: no stage fits → 판정 보류", () => {
    const s = assessStages({ ...calm(), vix: VIX_UP, breadth200: daily("2026-11-10", [55]), sahm: series(["2026-10-01", 0.5]) });
    expect(s.r.filter((c) => c.status === "met").map((c) => c.id)).toEqual(["R2", "R3", "R5", "R6"]);
    expect(s.escape.label).toBe("1단계 관찰");
    expect(s.recovery).toMatchObject({ stage: "hold", label: RECOVERY_HOLD });
  });
  test("unknown signals that leave several outcomes: none chosen", () => {
    const { vix: _v, breadth200: _b, ...rest } = calm();
    const s = assessStages(rest);
    expect(s.escape.label).toBe("1단계 관찰");
    expect(s.recovery.stage).toBeNull();
    expect(s.recovery.possible).toEqual([2, 3, "hold"]);
    expect(s.recovery.open).toEqual(["R1", "R4", "D2"]);
    expect(s.recovery.label).toBe("회복 단계 미확정(가능: 2단계·3단계·판정 보류, 미확인: R1·R4·D2)");
  });
  test("no signal and one signal: 0단계 하락 진행", () => {
    const s = assessStages({
      ...stressed(),
      hy: hyWith(2.8, [...Array(18).fill(3.0), 3.4, 3.35]),
      spx: spx(90),
      kospi: spx(90),
      foreignKospi: daily("2026-10-20", Array(20).fill(-10)),
      dgs2: daily("2026-11-10", [3.9]),
    });
    expect(s.r.filter((c) => c.status === "met").map((c) => c.id)).toEqual([]);
    expect(s.recovery.label).toBe("0단계 하락 진행");
    // with the 2-year back under the upper bound: one signal (R5), still 0단계
    const one = assessStages({ ...stressed(), hy: hyWith(2.8, [...Array(18).fill(3.0), 3.4, 3.35]), spx: spx(90), kospi: spx(90), foreignKospi: daily("2026-10-20", Array(20).fill(-10)) });
    expect(one.r.filter((c) => c.status === "met").map((c) => c.id)).toEqual(["R5"]);
    expect(one.recovery.label).toBe("0단계 하락 진행");
  });
});
