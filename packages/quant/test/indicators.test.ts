/** D1 indicators against small fixtures worked by hand (short periods: the same code path as 14, 20 or 250). */
import { describe, expect, test } from "bun:test";
import {
  adx,
  atr,
  atrPct,
  bollinger,
  deviation,
  drawdownFromHigh,
  ema,
  macd,
  percentileRank,
  realizedVol,
  rsi,
  sma,
  stochastic,
  vwap,
  zscore,
} from "../src/indicators";
import type { Bar, Num } from "../src/types";

const bar = (h: number, l: number, c: number, v = 100, t = ""): Bar => ({ t, o: c, h, l, c, v });
/** compare a series to the expected values, nulls exactly, numbers to `digits` decimals */
function close(got: readonly Num[], want: readonly Num[], digits = 6) {
  expect(got.length).toBe(want.length);
  want.forEach((w, i) => {
    if (w == null) expect(got[i]).toBeNull();
    else expect(got[i]!).toBeCloseTo(w, digits);
  });
}
// (h, l, c): a gap up on the last bar
const BARS = [bar(10, 8, 9), bar(11, 9, 10), bar(12, 10, 11), bar(11, 9, 9.5), bar(14, 12, 13)];

describe("moving averages", () => {
  test("SMA (3): null until three values", () => {
    close(sma([1, 2, 3, 4, 5], 3), [null, null, 2, 3, 4]);
  });
  test("EMA (3): α 0.5, started from the first three values' average 2", () => {
    // 0.5 × 4 + 0.5 × 2 = 3, then 4, 5
    close(ema([1, 2, 3, 4, 5, 6], 3), [null, null, 2, 3, 4, 5]);
  });
  test("이격도: (close / MA − 1) × 100", () => {
    close(deviation([110, 90, 5], [100, 100, null]), [10, -10, null]);
  });
});

describe("MACD (2, 3, 2) on 1 3 2 5 4 6 8 7", () => {
  // EMA2 (α 2/3) from (1 + 3) / 2 = 2: 2, 4, 4, 5.3333, 7.1111, 7.0370; EMA3 (α 1/2) from 2: 3.5, 3.75, 4.875,
  // 6.4375, 6.71875; line 0, 0.5, 0.25, 0.45833, 0.67361, 0.31829; signal EMA2 of the line from (0 + 0.5) / 2:
  // 0.25, 0.25, 0.38889, 0.57870, 0.40509
  const m = macd([1, 3, 2, 5, 4, 6, 8, 7], 2, 3, 2);
  test("line, signal and histogram", () => {
    close(m.macd, [null, null, 0, 0.5, 0.25, 0.458333, 0.673611, 0.318287], 5);
    close(m.signal, [null, null, null, 0.25, 0.25, 0.388889, 0.578704, 0.405093], 5);
    close(m.hist, [null, null, null, 0.25, 0, 0.069444, 0.094907, -0.086806], 5);
  });
  test("the histogram's 5-day least-squares slope: Σ(x − 2)(y − ȳ) / 10 over its five values", () => {
    close(m.histSlope5, [null, null, null, null, null, null, null, -0.05787], 5);
  });
});

describe("Wilder's RSI, ATR and ADX", () => {
  test("RSI (3) on 10 11 10 12 13 12: gains 1 0 2 | 1 | 0, losses 0 1 0 | 0 | 1", () => {
    // first averages 1 and 1/3: RS 3, 75; then (1 × 2 + 1) / 3 = 1 and (1/3 × 2) / 3 = 2/9: RS 4.5, 81.82; then 2/3 and
    // 13/27: RS 18/13, 58.06
    close(rsi([10, 11, 10, 12, 13, 12], 3), [null, null, null, 75, 81.818182, 58.064516]);
  });
  test("RSI: 100 when nothing fell, 50 when nothing moved", () => {
    expect(rsi([1, 2, 3, 4, 5], 3).at(-1)).toBe(100);
    expect(rsi([3, 3, 3, 3, 3], 3).at(-1)).toBe(50);
  });
  test("ATR (3): true ranges 2 2 2 4.5 (the gap from 9.5 to the high 14), Wilder", () => {
    // first (2 + 2 + 2) / 3 = 2, then (2 × 2 + 4.5) / 3 = 2.8333
    close(atr(BARS, 3), [null, null, null, 2, 2.833333]);
    close(atrPct(BARS, 3), [null, null, null, (2 / 9.5) * 100, (2.833333 / 13) * 100], 4);
  });
  test("ADX (2) with ±DI", () => {
    // +DM 2 1 0 0, −DM 0 0 1 2, TR 3 2 2 3; Wilder (2): TR 2.5 2.25 2.625, +DM 1.5 0.75 0.375, −DM 0 0.5 1.25
    // +DI 60 33.33 14.29, −DI 0 22.22 47.62, DX 100 20 53.85, ADX (100 + 20) / 2 = 60, then (60 + 53.85) / 2
    const b = [bar(10, 8, 9), bar(12, 9, 11), bar(13, 11, 12), bar(12, 10, 10), bar(11, 8, 9)];
    const a = adx(b, 2);
    close(a.plusDI, [null, null, 60, 33.333333, 14.285714]);
    close(a.minusDI, [null, null, 0, 22.222222, 47.619048]);
    close(a.adx, [null, null, null, 60, 56.923077]);
  });
});

describe("stochastic, Z-score, percentile rank and Bollinger", () => {
  test("stochastic (3, 2): %K 75 16.67 80 over the windows 8–12, 9–12, 9–14; %D their 2-bar average", () => {
    const s = stochastic(BARS, 3, 2);
    close(s.k, [null, null, 75, 16.666667, 80]);
    close(s.d, [null, null, null, 45.833333, 48.333333]);
  });
  test("stochastic: a flat range leaves %K undefined", () => {
    expect(stochastic([bar(5, 5, 5), bar(5, 5, 5)], 2, 1).k).toEqual([null, null]);
  });
  test("Z (4) of 1 2 3 4: (4 − 2.5) / √1.25 (population σ); a flat window has none", () => {
    close(zscore([1, 2, 3, 4], 4), [null, null, null, 1.341641]);
    expect(zscore([2, 2, 2], 3).at(-1)).toBeNull();
  });
  test("percentile rank (4): two of 3 1 4 2 at or below 2", () => {
    close(percentileRank([3, 1, 4, 2], 4), [null, null, null, 50]);
  });
  test("Bollinger (4, 2σ) of 1 2 3 4: bands 2.5 ± 2√1.25, %B 0.8354, width 1.7889", () => {
    const b = bollinger([1, 2, 3, 4], 4, 2);
    close(b.mid, [null, null, null, 2.5]);
    close(b.upper, [null, null, null, 4.736068]);
    close(b.lower, [null, null, null, 0.263932]);
    close(b.pctB, [null, null, null, 0.83541]);
    close(b.width, [null, null, null, 1.788854]);
  });
});

describe("volatility, VWAP and drawdown", () => {
  test("realized volatility (2) of 100 110 99: log returns ln 1.1 and ln 0.9, sample σ × √252 = 225.25 %", () => {
    close(realizedVol([100, 110, 99], 2), [null, null, 225.252297], 4);
  });
  test("VWAP (2): typical prices 11 and 13 weighted 100 and 300 = 12.5; no volume, none", () => {
    close(vwap([bar(12, 10, 11, 100), bar(14, 12, 13, 300)], 2), [null, 12.5]);
    expect(vwap([bar(12, 10, 11, 0), bar(14, 12, 13, 0)], 2).at(-1)).toBeNull();
  });
  test("drawdown from the 3-day high: 9 against 12 = −25 %", () => {
    close(drawdownFromHigh([10, 12, 9], 3), [null, null, -25]);
  });
});
