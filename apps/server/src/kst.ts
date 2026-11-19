/**
 * Korea Standard Time helpers (UTC+9, no DST). All "wall clock" math is done on a Date shifted by
 * +9h and read with UTC getters, so results never depend on the host time zone.
 */
import { KST_OFFSET_MS, QUOTA_RESET_HOUR } from "@pickle/protocol";

export const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

export interface KstParts {
  year: number;
  month: number; // 1–12
  day: number;
  hour: number;
  minute: number;
  /** 1 = Monday … 7 = Sunday */
  weekday: number;
}

export function kstParts(ms: number): KstParts {
  const d = new Date(ms + KST_OFFSET_MS);
  const wd = d.getUTCDay();
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    weekday: wd === 0 ? 7 : wd,
  };
}

/** Epoch ms of a KST wall-clock time. Month 1–12; overflowing day/hour values roll over. */
export function kstToEpoch(year: number, month: number, day: number, hour = 0, minute = 0): number {
  return Date.UTC(year, month - 1, day, hour, minute) - KST_OFFSET_MS;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Calendar day in KST, "YYYY-MM-DD". */
export function kstDate(ms: number): string {
  const p = kstParts(ms);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** Quota day key: the day boundary is 04:00 KST ("YYYY-MM-DD"). */
export function quotaDay(ms: number): string {
  return kstDate(ms - QUOTA_RESET_HOUR * HOUR_MS);
}

/** Next 04:00 KST strictly after `ms`. */
export function nextQuotaReset(ms: number): number {
  const shifted = ms + KST_OFFSET_MS - QUOTA_RESET_HOUR * HOUR_MS;
  const start = Math.floor(shifted / DAY_MS) * DAY_MS;
  return start + DAY_MS - KST_OFFSET_MS + QUOTA_RESET_HOUR * HOUR_MS;
}

/** Last `n` quota days, oldest → newest. */
export function lastQuotaDays(ms: number, n: number): string[] {
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) out.push(quotaDay(ms - i * DAY_MS));
  return out;
}

/** "오전 7:30" / "오후 3:05" / "오전 12:00" (midnight) / "오후 12:00" (noon). */
export function koreanTime(hour: number, minute: number): string {
  const ampm = hour < 12 ? "오전" : "오후";
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${ampm} ${h12}:${pad(minute)}`;
}
