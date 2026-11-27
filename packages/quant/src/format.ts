/**
 * The one number and time formatter the server, the app's cards and the deck share (DD 1935 §0-5). Negative numbers
 * take U+2212 (−). A value that rounds to zero has no sign. Thousands are grouped with commas. Changes always carry a
 * sign, and a percentage-point change is written %p. Times are KST first; a US market time follows in brackets as US
 * Eastern, with daylight saving worked out here (no clock, no time-zone database). Rounding is half away from zero on the
 * decimal value (1.005 → 1.01, which toFixed gets wrong). A value that is not finite comes out as 확인 불가, never "NaN".
 */
import { civilDate, dayNumber, weekday } from "./series";

/** U+2212, the minus sign every negative number takes */
export const MINUS = "−";
/** what stands where a number is missing (with the 확인 불가 mark beside it) */
export const UNKNOWN_TEXT = "확인 불가";

/** a decimal digit string plus one, carrying: "0999" → "1000", "99" → "100" */
function increment(ds: string): string {
  const a = ds.split("");
  let i = a.length - 1;
  for (; i >= 0 && a[i] === "9"; i--) a[i] = "0";
  if (i < 0) return `1${a.join("")}`;
  a[i] = String(Number(a[i]) + 1);
  return a.join("");
}

/**
 * |x| (finite, ≥ 0) rounded to `digits` decimals, half away from zero on the number's shortest decimal form (the digits
 * toExponential() gives, which read back as the same double): 1.005 → 1.01, which toFixed gets wrong. The rounding is
 * done on the digit string, so float leftovers (5.55e−15), tiny values and values past 1e15 or 1e21 never meet
 * e-notation or lose digits (DD 2045).
 */
function fixed(abs: number, digits: number): string {
  if (abs === 0) return (0).toFixed(digits);
  const [m, e] = abs.toExponential().split("e") as [string, string];
  let ds = m.replace(".", "");
  let point = Number(e) + 1;
  if (point <= 0) {
    ds = "0".repeat(1 - point) + ds;
    point = 1;
  }
  const keep = point + digits;
  if (ds.length < keep) ds += "0".repeat(keep - ds.length);
  let kept = ds.slice(0, keep);
  if (Number(ds[keep] ?? "0") >= 5) kept = increment(kept);
  if (kept.length > keep) point += 1;
  return digits ? `${kept.slice(0, point)}.${kept.slice(point)}` : kept;
}

/** whether a value can be written at all (NaN and ±Infinity are 확인 불가) */
const finite = (x: number) => Number.isFinite(x);

/** grouped digits: 1234567.5 → "1,234,567.50" (digits 2); −0.004 → "0.00"; with sign, "+" before a positive */
export function num(x: number, digits = 0, opts: { sign?: boolean } = {}): string {
  if (!finite(x)) return UNKNOWN_TEXT;
  const s = fixed(Math.abs(x), digits);
  const zero = Number(s) === 0;
  const [int, frac] = s.split(".") as [string, string | undefined];
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (frac != null ? `.${frac}` : "");
  if (zero) return grouped;
  return (x < 0 ? MINUS : opts.sign ? "+" : "") + grouped;
}

/** a US price: $32.57, $1,234.50; a negative amount −$1.20 */
export function usd(x: number): string {
  if (!finite(x)) return UNKNOWN_TEXT;
  const s = num(x, 2);
  return s.startsWith(MINUS) ? `${MINUS}$${s.slice(1)}` : `$${s}`;
}

/** a Korean price in whole won: 189,400원 */
export function krw(x: number): string {
  return finite(x) ? `${num(x, 0)}원` : UNKNOWN_TEXT;
}

/**
 * a won price axis's tick numbers (DD 2228-b): when every tick is 10,000 or more and a multiple of 1,000 (so the step
 * is too), in 만: "15만", "18.7만", "125만", "1,250만"; otherwise all in full: "187,500", "9,500". Only ticks: labels and
 * the current price stay exact.
 */
export function wonTicks(ticks: readonly number[]): string[] {
  const man = ticks.length > 0 && ticks.every((t) => finite(t) && t >= 10_000 && Number.isInteger(t / 1000));
  return ticks.map((t) => (man ? `${num(t / 10_000, Number.isInteger(t / 10_000) ? 0 : 1)}만` : num(t, 0)));
}

/** a change in %, always signed: +2.31%, −1.04%, 0.00% */
export function pct(x: number, digits = 2): string {
  return finite(x) ? `${num(x, digits, { sign: true })}%` : UNKNOWN_TEXT;
}

/** a level in % (a rate, a spread, a share): 4.12% */
export function rate(x: number, digits = 2): string {
  return finite(x) ? `${num(x, digits)}%` : UNKNOWN_TEXT;
}

/** a change in percentage points, always signed: +0.24%p */
export function pp(x: number, digits = 2): string {
  return finite(x) ? `${num(x, digits, { sign: true })}%p` : UNKNOWN_TEXT;
}

/** a quantity of shares: 47주 */
export function shares(n: number): string {
  return finite(n) ? `${num(n, 0)}주` : UNKNOWN_TEXT;
}

/** an estimated figure: 약 $1,204(추정) */
export function estimate(formatted: string): string {
  return `약 ${formatted}(추정)`;
}

/** a delay note: 1일 지연, 15분 지연 */
export function delay(n: number, unit: "분" | "시간" | "일" | "거래일"): string {
  return `${n}${unit} 지연`;
}

const HOUR = 3_600_000;
const DAY = 86_400_000;
const pad = (n: number) => String(n).padStart(2, "0");

/** the day number of the n-th weekday `wd` (0 Sunday) of a month */
function nthWeekday(y: number, m: number, wd: number, n: number): number {
  const first = dayNumber(`${y}-${pad(m)}-01`);
  return first + ((wd - weekday(first) + 7) % 7) + (n - 1) * 7;
}

/** US Eastern's offset from UTC in hours at an instant: −4 in daylight time (from 2:00 on the second Sunday of March
 * to 2:00 on the first Sunday of November, local), −5 otherwise */
export function easternOffset(ms: number): -4 | -5 {
  const y = Number(civilDate(Math.floor(ms / DAY)).slice(0, 4));
  const start = nthWeekday(y, 3, 0, 2) * DAY + 7 * HOUR; // 02:00 EST = 07:00 UTC
  const end = nthWeekday(y, 11, 0, 1) * DAY + 6 * HOUR; // 02:00 EDT = 06:00 UTC
  return ms >= start && ms < end ? -4 : -5;
}

/** the wall-clock date and time at a UTC offset */
function wall(ms: number, offsetHours: number) {
  const local = ms + offsetHours * HOUR;
  const day = Math.floor(local / DAY);
  const min = Math.floor((local - day * DAY) / 60_000);
  const [, m, d] = civilDate(day).split("-").map(Number) as [number, number, number];
  return { day, m, d, hm: `${pad(Math.floor(min / 60))}:${pad(min % 60)}` };
}

/** KST: 11월 27일 00:45 */
export function kst(ms: number): string {
  const w = wall(ms, 9);
  return `${w.m}월 ${w.d}일 ${w.hm}`;
}

const WEEKDAY = "일월화수목금토";

/** an event's date and time, KST, with its weekday (DD 0126 §2): 12/1(화) 09:00. A US event at 10:00 Eastern falls on
 * the next KST day at 00:00, and that is the date written. */
export function kstDayTime(ms: number): string {
  if (!finite(ms)) return UNKNOWN_TEXT;
  const w = wall(ms, 9);
  return `${w.m}/${w.d}(${WEEKDAY[weekday(w.day)]}) ${w.hm}`;
}

/** a time in a sentence or foot (DD 2010 §1): the time alone when it falls on today's KST date, else with its date —
 * 00:45 / 11월 26일 06:00. `now` comes from the caller (no clock here). */
export function atText(ms: number, now: number): string {
  const w = wall(ms, 9);
  const n = wall(now, 9);
  return w.day === n.day ? w.hm : `${w.m}월 ${w.d}일 ${w.hm}`;
}

/** KST with the US Eastern time in brackets, for US market times: 11월 27일 00:45(미 동부 10:45) */
export function kstWithEastern(ms: number): string {
  return `${kst(ms)}(미 동부 ${wall(ms, easternOffset(ms)).hm})`;
}

/** a figure's own basis when it differs from the card's: 11-25 기준, FRED · A */
export function basisNote(asOf: string, source: string, grade: string): string {
  return `${asOf.slice(5)} 기준, ${source} · ${grade}`;
}

/** the card's foot line when its figures share time and source: 관측 11월 27일 00:45(미 동부 10:45) · 토스증권 · A */
export function footLine(observed: string, source: string, grade: string): string {
  return `관측 ${observed} · ${source} · ${grade}`;
}
