/** D7 margin-call threshold, A11 reward-to-risk and the fixed disclaimer, against the master prompt's own tables. */
import { describe, expect, test } from "bun:test";
import { DISCLAIMER, DISCLAIMER_PLAYBOOK } from "../src/disclaimer";
import { MARGIN_RATIO, impliedEquityShare, inTypicalCreditRange, marginCallMove, marginCallPrice } from "../src/margin";
import { PREFERRED_RATIO, riskReward } from "../src/pricing";

describe("D7: P / P0 = 1.40 × (1 − e)", () => {
  test("the table's 50 / 40 / 30 % rows: −30 %, −16 %, −2 %", () => {
    expect(MARGIN_RATIO).toBe(1.4);
    expect(marginCallMove(0.5)).toBeCloseTo(-30, 9);
    expect(marginCallMove(0.4)).toBeCloseTo(-16, 9);
    expect(marginCallMove(0.3)).toBeCloseTo(-2, 9);
  });
  test("the 34 % row's −7.4 % is the inverse of Samsung's gap: 189,400 against the 20-day VWAP 204,519", () => {
    // −7.39 % → e = 1 − 0.92608 / 1.40 = 33.85 %, shown as 34 %; the forward formula at exactly 34 % gives −7.6 %
    const gap = (189_400 / 204_519 - 1) * 100;
    expect(gap.toFixed(1)).toBe("-7.4");
    const e = impliedEquityShare(189_400, 204_519);
    expect(e).toBeCloseTo(0.33852, 5);
    expect(Math.round(e * 100)).toBe(34);
    expect(marginCallMove(e)).toBeCloseTo(gap, 9);
    expect(marginCallMove(0.34)).toBeCloseTo(-7.6, 9);
    expect(inTypicalCreditRange(e)).toBe(true);
  });
  test("170,000원 아래(−17%): 170,000 against 204,519 is −16.9 %, the 40 % row's neighbourhood (e = 40.6 %)", () => {
    expect(((170_000 / 204_519 - 1) * 100).toFixed(0)).toBe("-17");
    expect(impliedEquityShare(170_000, 204_519)).toBeCloseTo(0.40627, 5);
  });
  test("the price form: bought at 10,000 with half equity, the ratio is reached at 7,000", () => {
    expect(marginCallPrice(10_000, 0.5)).toBeCloseTo(7_000, 9);
    expect(inTypicalCreditRange(0.29)).toBe(false);
    expect(inTypicalCreditRange(0.51)).toBe(false);
  });
});

describe("A11 on A9's reference prices", () => {
  // entry, take-profit 1 and 2, stop: KORU 6.10 / 6.53 / 6.85 / 5.80, SOXL 41.50 / 44.85 / 49.00 / 39.50,
  // SOXS 50.50 / 56.30 / 63.14 / 47.50
  const rows: [string, number, number, number, number, number, number][] = [
    ["KORU 1차", 6.1, 6.53, 5.8, 7.0492, 4.918, 1.4333],
    ["KORU 2차", 6.1, 6.85, 5.8, 12.2951, 4.918, 2.5],
    ["SOXL 1차", 41.5, 44.85, 39.5, 8.0723, 4.8193, 1.675],
    ["SOXL 2차", 41.5, 49, 39.5, 18.0723, 4.8193, 3.75],
    ["SOXS 1차", 50.5, 56.3, 47.5, 11.4851, 5.9406, 1.9333],
    ["SOXS 2차", 50.5, 63.14, 47.5, 25.0297, 5.9406, 4.2133],
  ];
  for (const [name, entry, tp, sl, gain, loss, ratio] of rows)
    test(`${name}: +${gain}% / −${loss}% / ${ratio}`, () => {
      const r = riskReward(entry, tp, sl);
      expect(r.gainPct).toBeCloseTo(gain, 4);
      expect(r.lossPct).toBeCloseTo(loss, 4);
      expect(r.ratio!).toBeCloseTo(ratio, 4);
    });
  test("no ratio when the stop is not below the entry; 2 : 1 is the preferred floor", () => {
    expect(riskReward(10, 12, 10).ratio).toBeNull();
    expect(riskReward(10, 12, 11).ratio).toBeNull();
    expect(PREFERRED_RATIO).toBe(2);
  });
});

describe("the fixed disclaimer (A17, FA9)", () => {
  test("word for word", () => {
    expect(DISCLAIMER).toBe(
      "지표 모니터링이며 매매 권유가 아닙니다. 시장 위험 판정 규칙에는 오경보 및 신호 지연 가능성이 있으며, 레버리지 ETF는 상당한 원금 손실 위험을 수반합니다.",
    );
    expect(DISCLAIMER_PLAYBOOK).toBe(
      "이 문서는 투자 자문이 아니라 정보 정리와 시나리오 정리입니다. 모든 수치는 기준시각에 조회한 값이며 장중 값은 이후 변합니다. 확률·진폭은 과거 데이터와 가정에 기반한 추정입니다.",
    );
  });
});
