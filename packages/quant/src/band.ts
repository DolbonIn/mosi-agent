/**
 * D3, where a price stands: the 250-day percentile, Z250, %B and the gaps to the 20- and 60-day VWAP, for any price
 * (a band's edge, a take-profit) against the windows that end on a given bar. The master prompt warns that a daily-reset
 * leveraged ETF's price percentile is biased by decay. Read it only next to Z, %B, the VWAP gaps and the volume profile.
 */
import { vwap } from "./indicators";
import type { Bar } from "./types";

export interface BandFit {
  price: number;
  /** the share of the last 250 closes at or below the price, % */
  pct250: number | null;
  z250: number | null;
  pctB: number | null;
  /** (price / VWAP20 − 1) × 100 */
  vsVwap20: number | null;
  vsVwap60: number | null;
  asOf: string | null;
}

function meanSd(xs: readonly number[]) {
  const m = xs.reduce((s, x) => s + x, 0) / xs.length;
  return { m, sd: Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / xs.length) };
}

export function bandFit(bars: readonly Bar[], price: number, at = bars.length - 1): BandFit {
  const upto = bars.slice(0, at + 1);
  const c = upto.map((b) => b.c);
  const w250 = c.length >= 250 ? c.slice(-250) : null;
  const z = w250 ? meanSd(w250) : null;
  const b20 = c.length >= 20 ? meanSd(c.slice(-20)) : null;
  const v20 = vwap(upto.slice(-20), 20).at(-1) ?? null;
  const v60 = vwap(upto.slice(-60), 60).at(-1) ?? null;
  return {
    price,
    pct250: w250 ? (w250.filter((x) => x <= price).length / 250) * 100 : null,
    z250: z && z.sd > 0 ? (price - z.m) / z.sd : null,
    pctB: b20 && b20.sd > 0 ? (price - (b20.m - 2 * b20.sd)) / (4 * b20.sd) : null,
    vsVwap20: v20 ? (price / v20 - 1) * 100 : null,
    vsVwap60: v60 ? (price / v60 - 1) * 100 : null,
    asOf: upto.at(-1)?.t ?? null,
  };
}
