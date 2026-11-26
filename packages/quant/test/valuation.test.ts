/** PART C against the master prompt's own tables (C1 inputs typed by hand; every cell below is the table's text). */
import { describe, expect, test } from "bun:test";
import { num } from "../src/format";
import { annualized, conventionalChange, gordonImpliedRoe, normalPe, shareOfCurrent } from "../src/valuation";

// C1 (2026-11-24): market cap and B0 in 조원, TTM ROE in %, price and EPS in 원
const SAMSUNG = { mcap: 1203.74, b0: 614.11, ttmRoe: 41.58, price: 189_400, eps27: 77_900, roe27: 42.9 };
const HYNIX = { mcap: 823.47, b0: 309.09, ttmRoe: 92.54, price: 1_158_000, eps27: 537_730, roe27: 44.8 };
const G = 2.5;

describe("C2 · Gordon: ROE = g + P/B × (COE − g)", () => {
  // COE → [implied ROE, share of now, discount] as printed
  const table: Record<string, [number, [string, string, string], [string, string, string]]> = {
    "9": [9, ["15.2", "37", "63"], ["19.8", "21", "79"]],
    "10": [10, ["17.2", "41", "59"], ["22.5", "24", "76"]],
    "11": [11, ["19.2", "46", "54"], ["25.1", "27", "73"]],
    "12": [12, ["21.1", "51", "49"], ["27.8", "30", "70"]],
    "13": [13, ["23.1", "56", "44"], ["30.5", "33", "67"]],
    "15": [15, ["27.0", "65", "35"], ["35.8", "39", "61"]],
  };
  const row = (c: typeof SAMSUNG, coe: number) => {
    const roe = gordonImpliedRoe(c.mcap / c.b0, coe, G);
    const s = shareOfCurrent(roe, c.ttmRoe)!;
    return [num(roe, 1), num(s.share, 0), num(s.discount, 0)];
  };
  test("every cell, both companies, with P/B = market cap / B0 (1.96, 2.66)", () => {
    for (const [coe, sam, hyn] of Object.values(table)) {
      expect(row(SAMSUNG, coe)).toEqual(sam);
      expect(row(HYNIX, coe)).toEqual(hyn);
    }
  });
  test("C1's printed 1.97x / 2.70x do not reproduce it (Samsung 9 %: 15.3, the table 15.2; Hynix 11 %: 25.5, the table 25.1)", () => {
    expect(num(gordonImpliedRoe(1.97, 9, G), 1)).toBe("15.3");
    expect(num(gordonImpliedRoe(2.7, 11, G), 1)).toBe("25.5");
  });
  test("no current ROE, no share", () => {
    expect(shareOfCurrent(19, 0)).toBeNull();
  });
});

describe("C4 · normal PE: EPS = price / PE, against EPS27, as ROE on the BPS behind 2027E ROE", () => {
  const rows = (c: typeof SAMSUNG) =>
    [5, 6, 8, 10, 12].map((pe) => {
      const r = normalPe(c.price, pe, c.eps27, c.eps27 / (c.roe27 / 100))!;
      return [num(r.eps, 0), num(r.vsForward, 0), num(r.roe, 1)];
    });
  test("Hynix: every cell", () => {
    expect(rows(HYNIX)).toEqual([
      ["231,600", "43", "19.3"],
      ["193,000", "36", "16.1"],
      ["144,750", "27", "12.1"],
      ["115,800", "22", "9.6"],
      ["96,500", "18", "8.0"],
    ]);
  });
  test("Samsung: every cell but one (8x: 13.0 %, the table 13.1 %)", () => {
    expect(rows(SAMSUNG)).toEqual([
      ["37,880", "49", "20.9"],
      ["31,567", "41", "17.4"],
      ["23,675", "30", "13.0"],
      ["18,940", "24", "10.4"],
      ["15,783", "20", "8.7"],
    ]);
  });
  test("nothing to divide by, nothing out", () => {
    expect(normalPe(100, 0, 10, 10)).toBeNull();
    expect(normalPe(100, 5, 10, 0)).toBeNull();
  });
});

describe("C7 · HBM vs conventional: blended = share × HBM + (1 − share) × conventional, 2 years", () => {
  const cell = (blended: number, share: number, hbm: number) => {
    const r = conventionalChange(blended, share, hbm)!;
    return [num(r.total, 1), num(r.annual, 0)];
  };
  test("Samsung (−49.2 %): every row but the first (−58.9 %, the table −59.0 %: the blend before rounding was −49.25 %)", () => {
    expect(cell(-49.2, 0.25, -20)).toEqual(["−58.9", "−36"]);
    expect(cell(-49.25, 0.25, -20)[0]).toBe("−59.0");
    expect(cell(-49.2, 0.25, 0)).toEqual(["−65.6", "−41"]);
    expect(cell(-49.2, 0.35, -10)).toEqual(["−70.3", "−46"]);
    expect(cell(-49.2, 0.35, 0)).toEqual(["−75.7", "−51"]);
    expect(cell(-49.2, 0.45, 0)).toEqual(["−89.5", "−68"]);
  });
  test("Hynix (−50.7 %): every row; the printed \"50 % / 0 %\" is impossible (−101.4 %) and its −92.2 % is the 45 % row", () => {
    expect(cell(-50.7, 0.35, -10)).toEqual(["−72.6", "−48"]);
    expect(cell(-50.7, 0.45, -10)).toEqual(["−84.0", "−60"]);
    expect(conventionalChange(-50.7, 0.5, 0)).toBeNull();
    expect(cell(-50.7, 0.45, 0)).toEqual(["−92.2", "−72"]);
    expect(cell(-50.7, 0.55, -20)).toEqual(["−88.2", "−66"]);
  });
  test("annualized: −59 % over two years is −36 %; −100 % or worse and a share of 1 give nothing", () => {
    expect(num(annualized(-59, 2)!, 0)).toBe("−36");
    expect(annualized(-100, 2)).toBeNull();
    expect(conventionalChange(-50, 1, 0)).toBeNull();
  });
});
