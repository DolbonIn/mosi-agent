/** Small dated series for the tests. */
import type { Bar, Point } from "../src/types";

/** the date `days` after t (YYYY-MM-DD) */
export function addDays(t: string, days: number): string {
  const d = new Date(`${t}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** one point a calendar day from `start` */
export function daily(start: string, values: readonly (number | null)[]): Point[] {
  return values.map((v, i) => ({ t: addDays(start, i), v }));
}

/** points from [date, value] pairs */
export function series(...pairs: [string, number | null][]): Point[] {
  return pairs.map(([t, v]) => ({ t, v }));
}

/** bars from closes, a day apart, high and low a fixed spread around the close */
export function barsFrom(start: string, closes: readonly number[], spread = 0, volume = 100): Bar[] {
  return closes.map((c, i) => ({ t: addDays(start, i), o: c, h: c + spread, l: c - spread, c, v: volume }));
}
