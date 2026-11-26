/**
 * D1 indicators, computed directly from close, high, low and volume (no outside library). Every function returns one
 * value per input index, null until its window fills. Units follow the master prompt: deviation, percentile rank,
 * ATR %, realized volatility, drawdown and the VWAP gap are in percent (−7.4 means −7.4 %); %B and band width are
 * ratios, RSI, stochastic and ADX run 0–100.
 *
 * Choices where the master prompt names an indicator but not its convention:
 * - EMA starts from the simple average of its first n values.
 * - RSI, ATR and ADX use Wilder's smoothing (the first value a simple average, then (prev × (n − 1) + x) / n).
 * - Stochastic (14, 3): %K over 14 bars, %D the 3-bar simple average of %K.
 * - Z-score and Bollinger bands use the population standard deviation.
 * - VWAP weights the typical price (high + low + close) / 3 by volume.
 * - The MACD histogram's 5-day slope is the least-squares slope of its last five values, per day.
 * - Realized volatility: the sample standard deviation of daily log returns × √252.
 * - Drawdown from the 250-day high: the close against the highest close of the last 250 (the current one included).
 */
import type { Bar, Num } from "./types";

const nulls = (n: number): Num[] => new Array<Num>(n).fill(null);

/** simple moving average of the last n values */
export function sma(xs: readonly number[], n: number): Num[] {
  const out = nulls(xs.length);
  let sum = 0;
  for (let i = 0; i < xs.length; i++) {
    sum += xs[i]!;
    if (i >= n) sum -= xs[i - n]!;
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}

/** exponential moving average, α = 2 / (n + 1), started from the simple average of the first n values */
export function ema(xs: readonly number[], n: number): Num[] {
  const out = nulls(xs.length);
  if (xs.length < n) return out;
  const a = 2 / (n + 1);
  let e = 0;
  for (let i = 0; i < n; i++) e += xs[i]!;
  e /= n;
  out[n - 1] = e;
  for (let i = n; i < xs.length; i++) out[i] = e = a * xs[i]! + (1 - a) * e;
  return out;
}

/** Wilder's smoothing of xs from index `from` on: the first value at from + n − 1 is the simple average */
function wilder(xs: readonly Num[], n: number, from: number): Num[] {
  const out = nulls(xs.length);
  if (xs.length - from < n) return out;
  let r = 0;
  for (let i = from; i < from + n; i++) r += xs[i]!;
  r /= n;
  out[from + n - 1] = r;
  for (let i = from + n; i < xs.length; i++) out[i] = r = (r * (n - 1) + xs[i]!) / n;
  return out;
}

/** 이격도: (close / moving average − 1) × 100 */
export function deviation(close: readonly number[], ma: readonly Num[]): Num[] {
  return close.map((c, i) => {
    const m = ma[i];
    return m == null || m === 0 ? null : (c / m - 1) * 100;
  });
}

/** least-squares slope of ys (equally spaced, one step a day) */
function slope(ys: readonly number[]): number {
  const n = ys.length;
  const mx = (n - 1) / 2;
  const my = ys.reduce((s, y) => s + y, 0) / n;
  let num = 0;
  let den = 0;
  ys.forEach((y, x) => {
    num += (x - mx) * (y - my);
    den += (x - mx) ** 2;
  });
  return num / den;
}

/** MACD (12, 26, 9): the line, its signal, the histogram and the histogram's 5-day slope */
export function macd(close: readonly number[], fast = 12, slow = 26, signal = 9) {
  const f = ema(close, fast);
  const s = ema(close, slow);
  const line: Num[] = close.map((_, i) => (f[i] == null || s[i] == null ? null : f[i]! - s[i]!));
  const start = line.findIndex((x) => x != null);
  const sig = nulls(close.length);
  if (start >= 0) {
    const e = ema(line.slice(start) as number[], signal);
    e.forEach((x, i) => (sig[start + i] = x));
  }
  const hist: Num[] = line.map((x, i) => (x == null || sig[i] == null ? null : x - sig[i]!));
  const histSlope5: Num[] = hist.map((_, i) => {
    if (i < 4) return null;
    const w = hist.slice(i - 4, i + 1);
    return w.every((x) => x != null) ? slope(w as number[]) : null;
  });
  return { macd: line, signal: sig, hist, histSlope5 };
}

/** RSI (14), Wilder: 100 − 100 / (1 + average gain / average loss); 100 with no loss, 50 with neither */
export function rsi(close: readonly number[], n = 14): Num[] {
  const gain: Num[] = close.map((c, i) => (i === 0 ? null : Math.max(c - close[i - 1]!, 0)));
  const loss: Num[] = close.map((c, i) => (i === 0 ? null : Math.max(close[i - 1]! - c, 0)));
  const g = wilder(gain, n, 1);
  const l = wilder(loss, n, 1);
  return close.map((_, i) => {
    const ag = g[i];
    const al = l[i];
    if (ag == null || al == null) return null;
    if (al === 0) return ag === 0 ? 50 : 100;
    return 100 - 100 / (1 + ag / al);
  });
}

/** true range from the second bar: the largest of high − low and the gaps to the previous close */
function trueRange(bars: readonly Bar[]): Num[] {
  return bars.map((b, i) => {
    if (i === 0) return null;
    const pc = bars[i - 1]!.c;
    return Math.max(b.h - b.l, Math.abs(b.h - pc), Math.abs(b.l - pc));
  });
}

/** ATR (14), Wilder */
export function atr(bars: readonly Bar[], n = 14): Num[] {
  return wilder(trueRange(bars), n, 1);
}

/** ATR as a percent of the close */
export function atrPct(bars: readonly Bar[], n = 14): Num[] {
  const a = atr(bars, n);
  return bars.map((b, i) => (a[i] == null || b.c === 0 ? null : (a[i]! / b.c) * 100));
}

/** ADX (14) with +DI and −DI, Wilder: DX = 100 × |+DI − −DI| / (+DI + −DI), ADX the smoothed DX */
export function adx(bars: readonly Bar[], n = 14) {
  const plusDm: Num[] = bars.map((b, i) => {
    if (i === 0) return null;
    const up = b.h - bars[i - 1]!.h;
    const down = bars[i - 1]!.l - b.l;
    return up > down && up > 0 ? up : 0;
  });
  const minusDm: Num[] = bars.map((b, i) => {
    if (i === 0) return null;
    const up = b.h - bars[i - 1]!.h;
    const down = bars[i - 1]!.l - b.l;
    return down > up && down > 0 ? down : 0;
  });
  const tr = wilder(trueRange(bars), n, 1);
  const pdm = wilder(plusDm, n, 1);
  const mdm = wilder(minusDm, n, 1);
  const plusDI: Num[] = bars.map((_, i) => (tr[i] == null ? null : tr[i] === 0 ? 0 : (100 * pdm[i]!) / tr[i]!));
  const minusDI: Num[] = bars.map((_, i) => (tr[i] == null ? null : tr[i] === 0 ? 0 : (100 * mdm[i]!) / tr[i]!));
  const dx: Num[] = bars.map((_, i) => {
    const p = plusDI[i];
    const m = minusDI[i];
    if (p == null || m == null) return null;
    return p + m === 0 ? 0 : (100 * Math.abs(p - m)) / (p + m);
  });
  return { adx: wilder(dx, n, n), plusDI, minusDI };
}

/** Stochastic (14, 3): %K = (close − lowest low) / (highest high − lowest low) × 100, %D its 3-bar average; a flat
 * range leaves %K undefined (null) */
export function stochastic(bars: readonly Bar[], k = 14, d = 3) {
  const pk: Num[] = bars.map((b, i) => {
    if (i < k - 1) return null;
    let hh = -Infinity;
    let ll = Infinity;
    for (let j = i - k + 1; j <= i; j++) {
      hh = Math.max(hh, bars[j]!.h);
      ll = Math.min(ll, bars[j]!.l);
    }
    return hh === ll ? null : ((b.c - ll) / (hh - ll)) * 100;
  });
  const pd: Num[] = pk.map((_, i) => {
    if (i < d - 1) return null;
    const w = pk.slice(i - d + 1, i + 1);
    return w.every((x) => x != null) ? (w as number[]).reduce((s, x) => s + x, 0) / d : null;
  });
  return { k: pk, d: pd };
}

/** mean and population standard deviation of the n values ending at i */
function meanSd(xs: readonly number[], i: number, n: number) {
  let m = 0;
  for (let j = i - n + 1; j <= i; j++) m += xs[j]!;
  m /= n;
  let v = 0;
  for (let j = i - n + 1; j <= i; j++) v += (xs[j]! - m) ** 2;
  return { m, sd: Math.sqrt(v / n) };
}

/** Z-score (n) = (close − n-day mean) / n-day standard deviation; null when the window is flat */
export function zscore(close: readonly number[], n: number): Num[] {
  return close.map((c, i) => {
    if (i < n - 1) return null;
    const { m, sd } = meanSd(close, i, n);
    return sd === 0 ? null : (c - m) / sd;
  });
}

/** percentile rank (n): the share of the last n closes (the current one included) at or below the current, in % */
export function percentileRank(close: readonly number[], n: number): Num[] {
  return close.map((c, i) => {
    if (i < n - 1) return null;
    let at = 0;
    for (let j = i - n + 1; j <= i; j++) if (close[j]! <= c) at++;
    return (at / n) * 100;
  });
}

/** Bollinger (20, 2σ): the bands, %B = (close − lower) / (upper − lower) and width = (upper − lower) / middle */
export function bollinger(close: readonly number[], n = 20, k = 2) {
  const mid = nulls(close.length);
  const upper = nulls(close.length);
  const lower = nulls(close.length);
  const pctB = nulls(close.length);
  const width = nulls(close.length);
  close.forEach((c, i) => {
    if (i < n - 1) return;
    const { m, sd } = meanSd(close, i, n);
    mid[i] = m;
    upper[i] = m + k * sd;
    lower[i] = m - k * sd;
    pctB[i] = sd === 0 ? null : (c - lower[i]!) / (upper[i]! - lower[i]!);
    width[i] = m === 0 ? null : (upper[i]! - lower[i]!) / m;
  });
  return { mid, upper, lower, pctB, width };
}

/** realized volatility (n): the sample standard deviation of the last n daily log returns × √252, in % */
export function realizedVol(close: readonly number[], n = 20): Num[] {
  const r = close.map((c, i) => (i === 0 ? 0 : Math.log(c / close[i - 1]!)));
  return close.map((_, i) => {
    if (i < n) return null;
    let m = 0;
    for (let j = i - n + 1; j <= i; j++) m += r[j]!;
    m /= n;
    let v = 0;
    for (let j = i - n + 1; j <= i; j++) v += (r[j]! - m) ** 2;
    return Math.sqrt(v / (n - 1)) * Math.sqrt(252) * 100;
  });
}

/** n-day VWAP: the volume-weighted typical price (high + low + close) / 3 of the last n bars; null with no volume */
export function vwap(bars: readonly Bar[], n: number): Num[] {
  return bars.map((_, i) => {
    if (i < n - 1) return null;
    let pv = 0;
    let vol = 0;
    for (let j = i - n + 1; j <= i; j++) {
      const b = bars[j]!;
      pv += ((b.h + b.l + b.c) / 3) * b.v;
      vol += b.v;
    }
    return vol === 0 ? null : pv / vol;
  });
}

/** drawdown from the n-day high: close / the highest of the last n closes − 1, in % (0 at a new high) */
export function drawdownFromHigh(close: readonly number[], n = 250): Num[] {
  return close.map((c, i) => {
    if (i < n - 1) return null;
    let hi = -Infinity;
    for (let j = i - n + 1; j <= i; j++) hi = Math.max(hi, close[j]!);
    return (c / hi - 1) * 100;
  });
}
