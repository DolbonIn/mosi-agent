/**
 * D4, the 120-day volume profile in 24 equal price bins between the window's lowest low and highest high, and its three
 * largest nodes (a node's price is its bin's middle). How a day's volume is spread is a choice the master prompt leaves
 * open. "range" (the default) spreads it evenly over the day's low–high range. "typical" puts it all in the bin of
 * (H + L + C) / 3, and "close" in the close's bin. "range" is an unsettled default (미확정 기본값, lead 2058) until the
 * prompt's D4 table is reproduced from its price history.
 */
import type { Bar } from "./types";

export interface ProfileBin {
  lo: number;
  hi: number;
  mid: number;
  volume: number;
  /** % of the window's volume */
  share: number;
}

export interface VolumeProfile {
  lo: number;
  hi: number;
  width: number;
  bins: ProfileBin[];
  /** the three largest bins, largest first */
  top: ProfileBin[];
  asOf: string | null;
}

export function volumeProfile(bars: readonly Bar[], opts: { days?: number; bins?: number; mode?: "range" | "typical" | "close" } = {}): VolumeProfile | null {
  const days = opts.days ?? 120;
  const nb = opts.bins ?? 24;
  const mode = opts.mode ?? "range";
  const w = bars.slice(-days);
  if (w.length < days) return null;
  const lo = Math.min(...w.map((b) => b.l));
  const hi = Math.max(...w.map((b) => b.h));
  if (!(hi > lo)) return null;
  const width = (hi - lo) / nb;
  const vol = new Array<number>(nb).fill(0);
  const binOf = (p: number) => Math.min(nb - 1, Math.max(0, Math.floor((p - lo) / width)));
  for (const b of w) {
    if (mode === "close") vol[binOf(b.c)]! += b.v;
    else if (mode === "typical" || b.h === b.l) vol[binOf(mode === "typical" ? (b.h + b.l + b.c) / 3 : b.c)]! += b.v;
    else
      for (let i = binOf(b.l); i <= binOf(b.h); i++) {
        const overlap = Math.min(b.h, lo + (i + 1) * width) - Math.max(b.l, lo + i * width);
        if (overlap > 0) vol[i]! += (b.v * overlap) / (b.h - b.l);
      }
  }
  const total = vol.reduce((s, v) => s + v, 0);
  const bins = vol.map((v, i) => ({ lo: lo + i * width, hi: lo + (i + 1) * width, mid: lo + (i + 0.5) * width, volume: v, share: total ? (v / total) * 100 : 0 }));
  const top = [...bins].sort((a, b) => b.volume - a.volume).slice(0, 3);
  return { lo, hi, width, bins, top, asOf: w.at(-1)?.t ?? null };
}
