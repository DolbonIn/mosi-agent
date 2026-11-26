/**
 * Dated-series helpers the verdicts share. Windows are by date, not by count: "6 months" is every observation after the
 * same day six months before the latest one, and it counts only when the series reaches back to that day (a shorter
 * history gives no 6-month low). "1 month ago" is the observation on the same day a month before or the last one before
 * it, at most a week older. "N trading days in a row" counts the series' own observations (a null is skipped, not a
 * break).
 */
import type { Point, Tri } from "./types";

/** a value with float noise removed, for threshold tests on differences and ratios (4.02 − 3.52 is 0.49999999999999956) */
export const r9 = (x: number) => Math.round(x * 1e9) / 1e9;

export interface Obs {
  t: string;
  v: number;
}

/** the observations that have a value, oldest first */
export function present(points: readonly Point[] | null | undefined): Obs[] {
  return (points ?? []).filter((p): p is Obs => p.v != null && Number.isFinite(p.v));
}

/** the latest observation with a value */
export function latest(points: readonly Point[] | null | undefined): Obs | null {
  const xs = present(points);
  return xs.length ? xs[xs.length - 1]! : null;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** the date m months before t (YYYY-MM-DD), the day clamped to the month's length (03-31 − 1 month = 02-28 or 02-29) */
export function monthsBefore(t: string, m: number): string {
  const [y, mo, d] = t.split("-").map(Number) as [number, number, number];
  const idx = y * 12 + (mo - 1) - m;
  const ny = Math.floor(idx / 12);
  const nm = (idx % 12) + 1;
  const days = [31, ny % 4 === 0 && (ny % 100 !== 0 || ny % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][nm - 1]!;
  return `${ny}-${pad(nm)}-${pad(Math.min(d, days))}`;
}

/** the last observation on or before t */
export function atOrBefore(points: readonly Point[] | null | undefined, t: string): Obs | null {
  const xs = present(points).filter((p) => p.t <= t);
  return xs.length ? xs[xs.length - 1]! : null;
}

/** days from 1970-01-01 to a YYYY-MM-DD date (proleptic Gregorian, no clock involved) */
export function dayNumber(t: string): number {
  let [y, m, d] = t.split("-").map(Number) as [number, number, number];
  y -= m <= 2 ? 1 : 0;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  return era * 146097 + yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy - 719468;
}

/** the YYYY-MM-DD date of a day number (the inverse of dayNumber) */
export function civilDate(z: number): string {
  z += 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp + (mp < 10 ? 3 : -9);
  const y = yoe + era * 400 + (m <= 2 ? 1 : 0);
  return `${y}-${pad(m)}-${pad(d)}`;
}

/** the weekday of a day number, 0 Sunday to 6 Saturday */
export const weekday = (z: number) => (((z + 4) % 7) + 7) % 7;

/** whether the series reaches back to the day m months before its latest observation (has one on or before it) */
export function covers(points: readonly Point[] | null | undefined, m: number): boolean {
  const xs = present(points);
  return xs.length > 0 && xs[0]!.t <= monthsBefore(xs[xs.length - 1]!.t, m);
}

/** the observations after the day m months before the latest one, the latest included */
export function lastMonths(points: readonly Point[] | null | undefined, m: number): Obs[] {
  const end = latest(points);
  if (!end) return [];
  const from = monthsBefore(end.t, m);
  return present(points).filter((p) => p.t > from);
}

/** how many of the latest observations in a row satisfy `ok` */
export function streak(xs: readonly number[], ok: (v: number) => boolean): number {
  let n = 0;
  for (let i = xs.length - 1; i >= 0 && ok(xs[i]!); i--) n++;
  return n;
}

/** the last value minus the one n observations before it */
export function changeOver(points: readonly Point[] | null | undefined, n: number): number | null {
  const xs = present(points);
  return xs.length > n ? r9(xs[xs.length - 1]!.v - xs[xs.length - 1 - n]!.v) : null;
}

/** how much older than its target day "a month ago" may be (weekends, holidays) */
export const MONTH_AGO_SLACK_DAYS = 7;

/** the change in % from the observation a month before the latest one: (now / then − 1) × 100; none when the series has
 * nothing within a week before that day */
export function monthChangePct(points: readonly Point[] | null | undefined): { now: Obs; then: Obs; pct: number } | null {
  const now = latest(points);
  if (!now) return null;
  const target = monthsBefore(now.t, 1);
  const then = atOrBefore(points, target);
  if (!then || then.t === now.t || then.v === 0 || dayNumber(target) - dayNumber(then.t) > MONTH_AGO_SLACK_DAYS) return null;
  return { now, then, pct: r9((now.v / then.v - 1) * 100) };
}

/** a condition that needs n observations in a row: met when the last n all pass, unmet when one of the last n fails,
 * unknown when every observation passes but there are fewer than n */
export function inARow(xs: readonly number[], n: number, ok: (v: number) => boolean): Tri {
  const run = streak(xs, ok);
  return run >= n ? "met" : run < xs.length ? "unmet" : "unknown";
}

/** any of: met if one is met, unmet only if all are unmet */
export function anyOf(...ts: Tri[]): Tri {
  return ts.includes("met") ? "met" : ts.every((t) => t === "unmet") ? "unmet" : "unknown";
}

/** all of: unmet if one is unmet, met only if all are met */
export function allOf(...ts: Tri[]): Tri {
  return ts.includes("unmet") ? "unmet" : ts.every((t) => t === "met") ? "met" : "unknown";
}

/** a test on a value that may be missing */
export function holds(v: number | null | undefined, ok: (v: number) => boolean): Tri {
  return v == null || !Number.isFinite(v) ? "unknown" : ok(v) ? "met" : "unmet";
}

/** the earliest of some dates (the oldest input behind a combined figure); null with none */
export function oldest(...ts: (string | null | undefined)[]): string | null {
  const xs = ts.filter((t): t is string => !!t).sort();
  return xs[0] ?? null;
}

/** the latest of some dates; null with none */
export function newest(...ts: (string | null | undefined)[]): string | null {
  const xs = ts.filter((t): t is string => !!t).sort();
  return xs.length ? xs[xs.length - 1]! : null;
}
