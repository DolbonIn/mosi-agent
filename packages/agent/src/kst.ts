/** Korea Standard Time helpers (UTC+9, no DST). */
export const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
export const WEEKDAYS_KO = ["일", "월", "화", "수", "목", "금", "토"] as const;

export interface KstParts {
  year: number;
  month: number; // 1–12
  day: number;
  hour: number;
  minute: number;
  /** 0 = Sunday … 6 = Saturday */
  weekday: number;
  weekdayKo: (typeof WEEKDAYS_KO)[number];
}

export function kstParts(d: Date): KstParts {
  const k = new Date(d.getTime() + KST_OFFSET_MS);
  const weekday = k.getUTCDay();
  return {
    year: k.getUTCFullYear(),
    month: k.getUTCMonth() + 1,
    day: k.getUTCDate(),
    hour: k.getUTCHours(),
    minute: k.getUTCMinutes(),
    weekday,
    weekdayKo: WEEKDAYS_KO[weekday]!,
  };
}

const pad = (n: number) => String(n).padStart(2, "0");

/** "2026-11-11" (KST calendar date) */
export function kstDateKey(d: Date): string {
  const p = kstParts(d);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** "18:05" */
export function kstClock(d: Date): string {
  const p = kstParts(d);
  return `${pad(p.hour)}:${pad(p.minute)}`;
}

/** "오후 6:05" */
export function koreanClock(hour: number, minute: number): string {
  const ampm = hour < 12 ? "오전" : "오후";
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${ampm} ${h12}:${pad(minute)}`;
}

/** "2026년 11월 11일 (수) 오후 6:05" */
export function formatKst(d: Date): string {
  const p = kstParts(d);
  return `${p.year}년 ${p.month}월 ${p.day}일 (${p.weekdayKo}) ${koreanClock(p.hour, p.minute)}`;
}

/** ISO-8601 with +09:00 offset, e.g. "2026-11-11T18:05:00+09:00" */
export function kstIso(d: Date): string {
  const k = new Date(d.getTime() + KST_OFFSET_MS);
  return `${k.toISOString().slice(0, 19)}+09:00`;
}
