import type { KeepFor } from "@pickle/protocol";
import { useEffect, useState } from "react";

/**
 * Korean formatters for the explore / archive / profile screens. Times are shown in KST (the server's clock and the
 * "새벽 4시" reset), numbers in ko-KR with tabular figures applied by the caller (.tnum).
 */

const TZ = "Asia/Seoul";
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export const num = (n: number) => Math.round(n).toLocaleString("ko-KR");

/** 17166 → "17,166명이 맡겼어요" */
export const delegatedCount = (n: number) => `${num(n)}명이 맡겼어요`;

const parts = (ms: number) => {
  const p = new Intl.DateTimeFormat("ko-KR", { timeZone: TZ, year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit", hour12: false, weekday: "short" }).formatToParts(new Date(ms));
  const get = (t: string) => p.find((x) => x.type === t)?.value ?? "";
  return { y: Number(get("year")), m: Number(get("month")), d: Number(get("day")), h: Number(get("hour")) % 24, min: Number(get("minute")), wd: get("weekday") };
};

/** "오전 7:30" / "오후 6:05" (KST) */
export function clock(ms: number): string {
  const { h, min } = parts(ms);
  const ampm = h < 12 ? "오전" : "오후";
  const hh = h % 12 === 0 ? 12 : h % 12;
  return `${ampm} ${hh}:${String(min).padStart(2, "0")}`;
}

function dayIndex(ms: number) {
  const { y, m, d } = parts(ms);
  return Date.UTC(y, m - 1, d) / DAY;
}

/** "11월 12일" (+ year when not this year) */
export function dateKo(ms: number, now = Date.now()): string {
  const a = parts(ms);
  const b = parts(now);
  return a.y === b.y ? `${a.m}월 ${a.d}일` : `${a.y}년 ${a.m}월 ${a.d}일`;
}

/** "오늘 오전 7:30" / "내일 오후 6:00" / "11월 14일 (금) 오전 9:00" */
export function whenKo(ms: number, now = Date.now()): string {
  const diff = dayIndex(ms) - dayIndex(now);
  const t = clock(ms);
  if (diff === 0) return `오늘 ${t}`;
  if (diff === 1) return `내일 ${t}`;
  if (diff === -1) return `어제 ${t}`;
  const p = parts(ms);
  return `${dateKo(ms, now)} (${p.wd}) ${t}`;
}

/** "오늘" / "내일" / "11월 14일 (금)": the day alone, for a time whose clock is already shown (a schedule's rule) */
export function dayKo(ms: number, now = Date.now()): string {
  const diff = dayIndex(ms) - dayIndex(now);
  if (diff === 0) return "오늘";
  if (diff === 1) return "내일";
  if (diff === -1) return "어제";
  return `${dateKo(ms, now)} (${parts(ms).wd})`;
}

/** "방금" / "5분 전" / "3시간 전" / "어제" / "11월 3일" */
export function ago(ms: number, now = Date.now()): string {
  const d = now - ms;
  if (d < MIN) return "방금";
  if (d < HOUR) return `${Math.floor(d / MIN)}분 전`;
  const days = dayIndex(now) - dayIndex(ms);
  if (days === 0) return `${Math.floor(d / HOUR)}시간 전`;
  if (days === 1) return "어제";
  if (days < 7) return `${days}일 전`;
  return dateKo(ms, now);
}

/** remaining time, coarse: "6일 남음" / "3시간 남음" / "12분 남음" / "곧 끝나요" */
export function remainingKo(ms: number, now = Date.now()): string {
  const d = ms - now;
  if (d <= 0) return "만료됐어요";
  if (d >= DAY) return `${Math.floor(d / DAY)}일 남음`;
  if (d >= HOUR) return `${Math.floor(d / HOUR)}시간 남음`;
  if (d >= MIN) return `${Math.floor(d / MIN)}분 남음`;
  return "곧 만료돼요";
}

/** "3시간 12분 뒤" / "12분 뒤" / "곧" */
export function untilKo(ms: number, now = Date.now()): string {
  const d = ms - now;
  if (d < MIN) return "곧";
  const h = Math.floor(d / HOUR);
  const m = Math.floor((d % HOUR) / MIN);
  if (h >= 24) return `${Math.floor(h / 24)}일 뒤`;
  if (h > 0) return m ? `${h}시간 ${m}분 뒤` : `${h}시간 뒤`;
  return `${m}분 뒤`;
}

/** 1536 → "1.5KB" */
export function bytesKo(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

export const KEEP_FOR: { value: KeepFor; label: string }[] = [
  { value: "1h", label: "1시간" },
  { value: "1d", label: "1일" },
  { value: "7d", label: "7일" },
  { value: "30d", label: "30일" },
  { value: "forever", label: "계속" },
];
export const keepForLabel = (k: KeepFor) => KEEP_FOR.find((x) => x.value === k)?.label ?? k;

/** 받침 → 은/는, 이/가, 을/를, 와/과, 으로/로 */
export function josa(word: string, pair: "은는" | "이가" | "을를" | "와과" | "으로"): string {
  const ch = word.trim().slice(-1);
  const code = ch.charCodeAt(0) - 0xac00;
  const has = code >= 0 && code <= 11171 ? code % 28 !== 0 : false;
  const jong = code >= 0 && code <= 11171 ? code % 28 : 0;
  switch (pair) {
    case "은는":
      return word + (has ? "은" : "는");
    case "이가":
      return word + (has ? "이" : "가");
    case "을를":
      return word + (has ? "을" : "를");
    case "와과":
      return word + (has ? "과" : "와");
    case "으로":
      return word + (has && jong !== 8 ? "으로" : "로");
  }
}

/**
 * A clock that re-renders only when the coarse text could change: every minute while `target` is under an hour away,
 * every hour below a day, never otherwise (research §4-8 8-6: no per-second loops). Pass null to stop.
 */
export function useCoarseNow(target: number | null | undefined): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!target) return;
    const d = target - Date.now();
    if (d <= 0) return;
    const step = d < HOUR ? MIN : d < DAY ? HOUR : 0;
    if (!step) return;
    // wake at the next boundary of the remaining time (so "12분 남음" flips exactly when it should)
    const wait = (d % step) + 50;
    const id = setTimeout(() => setNow(Date.now()), Math.min(wait, step + 50));
    return () => clearTimeout(id);
  }, [target, now]);
  return now;
}

/** A 1 Hz clock that runs only while `on` (passcode countdowns: the person is watching it). */
export function useSecondTicker(on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [on]);
  return now;
}
