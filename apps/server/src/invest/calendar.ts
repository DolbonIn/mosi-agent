/**
 * Market calendars for the invest watch (agent-runtime 2006 §1, 2052 §A-5). Pure: every answer is a function of its
 * arguments, no clock and no network.
 *
 * US (NYSE regular session 09:30–16:00 ET): the holidays come from the exchange's rules (a Saturday holiday is kept on
 * the Friday before, a Sunday one on the Monday after; New Year's Day on a Saturday is not moved back into December),
 * and the 13:00 ET early closes are the trading day before Independence Day (3 July, Monday–Thursday only), the day after
 * Thanksgiving and Christmas Eve (Monday–Thursday only). Daylight time follows @pickle/quant's easternOffset. One-off
 * closures go in US_CLOSED.
 *
 * KR (KRX 09:00–15:30 KST): a table per year. A day in a year the table does not cover is "unknown": nothing is judged
 * or traded on it (2006 §1 "표가 덮지 않는 날은 확인 불가").
 *
 * A person with Toss sees the days Toss's market calendar has answered for them (`DayOverride`, team-lead 2253: their
 * key serves their own watch only); everyone else, and every other day, follows the rules and the table.
 *
 * The watch's slots follow the source's G2 run window: from 15 minutes after the open, every 5 minutes up to the close,
 * then one close check 5 minutes after it (the official close is read there).
 */
import { civilDate, dayNumber, easternOffset, weekday } from "@pickle/quant";

export type Market = "US" | "KR";

/** US: letters first, then letters, digits, "." or "-" (BRK.B); KR: six digits */
export function normalizeSymbol(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim().toUpperCase();
  return /^\d{6}$/.test(s) || /^[A-Z][A-Z0-9.-]{0,9}$/.test(s) ? s : null;
}

export function marketOf(symbol: string): Market {
  return /^\d{6}$/.test(symbol) ? "KR" : "US";
}

export interface Session {
  market: Market;
  /** the trading day, YYYY-MM-DD in the market's own time zone */
  day: string;
  open: number;
  close: number;
  early: boolean;
}

export type DayInfo =
  | { kind: "open"; session: Session }
  | { kind: "closed"; reason: "weekend" | "holiday"; name?: string }
  | { kind: "unknown" };

/** A person's own answer for a day (their Toss market calendar), or null: the rules and the table decide. */
export type DayOverride = (market: Market, day: string) => DayInfo | null;

const MIN = 60_000;
const HOUR = 3_600_000;
export const SLOT_MS = 5 * MIN;
/** the first check comes this long after the open (G2: 개장 15분 후) */
export const FIRST_CHECK_AFTER_OPEN_MS = 15 * MIN;

const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;

/** the day number of the n-th weekday `wd` (0 Sunday) of a month; n = -1 for the last one */
function nthWeekday(y: number, m: number, wd: number, n: number): number {
  if (n < 0) {
    const nextFirst = dayNumber(m === 12 ? ymd(y + 1, 1, 1) : ymd(y, m + 1, 1));
    const last = nextFirst - 1;
    return last - ((weekday(last) - wd + 7) % 7);
  }
  const first = dayNumber(ymd(y, m, 1));
  return first + ((wd - weekday(first) + 7) % 7) + (n - 1) * 7;
}

/** Easter Sunday (Gregorian, anonymous computus) as a day number */
function easter(y: number): number {
  const a = y % 19;
  const b = Math.floor(y / 100);
  const c = y % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return dayNumber(ymd(y, month, day));
}

/** a fixed-date holiday moved off the weekend: Saturday → Friday, Sunday → Monday */
function observed(z: number): number {
  const wd = weekday(z);
  return wd === 6 ? z - 1 : wd === 0 ? z + 1 : z;
}

/** One-off NYSE closures that no rule produces (national days of mourning). */
export const US_CLOSED: Readonly<Record<string, string>> = {
  "2025-01-09": "National Day of Mourning",
};

/** the NYSE full-day holidays of a year, day number → name */
export function usHolidays(y: number): Map<number, string> {
  const out = new Map<number, string>();
  const jan1 = dayNumber(ymd(y, 1, 1));
  if (weekday(jan1) !== 6) out.set(observed(jan1), "New Year's Day"); // Saturday: not moved back to 31 December
  out.set(nthWeekday(y, 1, 1, 3), "Martin Luther King Jr. Day");
  out.set(nthWeekday(y, 2, 1, 3), "Washington's Birthday");
  out.set(easter(y) - 2, "Good Friday");
  out.set(nthWeekday(y, 5, 1, -1), "Memorial Day");
  if (y >= 2022) out.set(observed(dayNumber(ymd(y, 6, 19))), "Juneteenth");
  out.set(observed(dayNumber(ymd(y, 7, 4))), "Independence Day");
  out.set(nthWeekday(y, 9, 1, 1), "Labor Day");
  out.set(nthWeekday(y, 11, 4, 4), "Thanksgiving Day");
  out.set(observed(dayNumber(ymd(y, 12, 25))), "Christmas Day");
  return out;
}

/** the NYSE 13:00 ET early closes of a year (day numbers) */
export function usEarlyCloses(y: number): Set<number> {
  const out = new Set<number>();
  const jul3 = dayNumber(ymd(y, 7, 3));
  if (weekday(jul3) >= 1 && weekday(jul3) <= 4) out.add(jul3);
  out.add(nthWeekday(y, 11, 4, 4) + 1);
  const dec24 = dayNumber(ymd(y, 12, 24));
  if (weekday(dec24) >= 1 && weekday(dec24) <= 4) out.add(dec24);
  return out;
}

/** epoch ms of a US Eastern wall-clock time on a day (market hours are far from the 02:00 daylight switch) */
export function etToEpoch(day: string, hour: number, minute: number): number {
  const base = dayNumber(day) * 86_400_000 + hour * HOUR + minute * MIN;
  const guess = base + 5 * HOUR;
  const off = easternOffset(guess);
  const at = base - off * HOUR;
  return easternOffset(at) === off ? at : base - easternOffset(at) * HOUR;
}

export function kstToEpochDay(day: string, hour: number, minute: number): number {
  return dayNumber(day) * 86_400_000 + (hour - 9) * HOUR + minute * MIN;
}

/** the US Eastern calendar date at an instant */
export function etDate(ms: number): string {
  return civilDate(Math.floor((ms + easternOffset(ms) * HOUR) / 86_400_000));
}

export function kstDay(ms: number): string {
  return civilDate(Math.floor((ms + 9 * HOUR) / 86_400_000));
}

export function marketDate(market: Market, ms: number): string {
  return market === "US" ? etDate(ms) : kstDay(ms);
}

export function usDay(day: string): DayInfo {
  const z = dayNumber(day);
  const wd = weekday(z);
  if (wd === 0 || wd === 6) return { kind: "closed", reason: "weekend" };
  const y = Number(day.slice(0, 4));
  const name = US_CLOSED[day] ?? usHolidays(y).get(z);
  if (name) return { kind: "closed", reason: "holiday", name };
  const early = usEarlyCloses(y).has(z);
  return { kind: "open", session: { market: "US", day, open: etToEpoch(day, 9, 30), close: etToEpoch(day, early ? 13 : 16, 0), early } };
}

/**
 * KRX closed days and changed hours by year. Years not here are "unknown". 2026: the public holidays and substitute
 * days, the 1 May closure and the 31 December year-end closure; the first trading day and the college entrance exam
 * day open at 10:00 (the exam day also closes an hour late). Source: 법정 공휴일 + 연말 휴장 규정 · 미대조 (team-lead 2215:
 * no KRX document that lists the dates was found, so none was fetched).
 * 2027 (team-lead 0312): the same rules and source line — the public holidays and substitute days (노동절 on a Saturday
 * gives Monday 3 May), no national election, 31 December on a Friday; the first trading day (4 January) opens at 10:00
 * and the 2028 수능 day (18 November) at 10:00–16:30 as in 2026. 미대조: no KRX list for 2027 was found yet.
 */
export const KR_TABLE: Readonly<Record<number, { closed: Readonly<Record<string, string>>; hours?: Readonly<Record<string, { open: string; close: string }>> }>> = {
  2026: {
    closed: {
      "2026-01-01": "신정",
      "2026-02-16": "설날 연휴",
      "2026-02-17": "설날",
      "2026-02-18": "설날 연휴",
      "2026-03-02": "삼일절 대체공휴일",
      "2026-05-01": "근로자의 날",
      "2026-05-05": "어린이날",
      "2026-05-25": "부처님오신날 대체공휴일",
      "2026-06-03": "전국동시지방선거",
      "2026-07-17": "제헌절",
      "2026-08-17": "광복절 대체공휴일",
      "2026-09-24": "추석 연휴",
      "2026-09-25": "추석",
      "2026-10-05": "개천절 대체공휴일",
      "2026-10-09": "한글날",
      "2026-12-25": "성탄절",
      "2026-12-31": "연말 휴장",
    },
    hours: {
      "2026-01-02": { open: "10:00", close: "15:30" },
      "2026-11-19": { open: "10:00", close: "16:30" },
    },
  },
  2027: {
    closed: {
      "2027-01-01": "신정",
      "2027-02-08": "설날 연휴",
      "2027-02-09": "설날 대체공휴일",
      "2027-03-01": "삼일절",
      "2027-05-03": "노동절 대체공휴일",
      "2027-05-05": "어린이날",
      "2027-05-13": "부처님오신날",
      "2027-07-19": "제헌절 대체공휴일",
      "2027-08-16": "광복절 대체공휴일",
      "2027-09-14": "추석 연휴",
      "2027-09-15": "추석",
      "2027-09-16": "추석 연휴",
      "2027-10-04": "개천절 대체공휴일",
      "2027-10-11": "한글날 대체공휴일",
      "2027-12-27": "성탄절 대체공휴일",
      "2027-12-31": "연말 휴장",
    },
    hours: {
      "2027-01-04": { open: "10:00", close: "15:30" },
      "2027-11-18": { open: "10:00", close: "16:30" },
    },
  },
};

/**
 * The year the KRX table lacks at `now` (KST): this year's, or from 1 December next year's; else null. The daily
 * discovery run warns with it once a day, so a missing year is seen a month before its first day (team-lead 0312).
 */
export function krTableGap(now: number, table: Readonly<Record<number, unknown>> = KR_TABLE): number | null {
  const day = marketDate("KR", now);
  const y = Number(day.slice(0, 4));
  if (!table[y]) return y;
  return day.slice(5) >= "12-01" && !table[y + 1] ? y + 1 : null;
}

export function krDay(day: string): DayInfo {
  const z = dayNumber(day);
  const wd = weekday(z);
  if (wd === 0 || wd === 6) return { kind: "closed", reason: "weekend" };
  const table = KR_TABLE[Number(day.slice(0, 4))];
  if (!table) return { kind: "unknown" };
  const name = table.closed[day];
  if (name) return { kind: "closed", reason: "holiday", name };
  return { kind: "open", session: krSession(day) };
}

/** a KRX session on `day`: the table's changed hours, else 09:00–15:30 */
function krSession(day: string): Session {
  const h = KR_TABLE[Number(day.slice(0, 4))]?.hours?.[day] ?? { open: "09:00", close: "15:30" };
  const [oh, om] = h.open.split(":").map(Number) as [number, number];
  const [ch, cm] = h.close.split(":").map(Number) as [number, number];
  return { market: "KR", day, open: kstToEpochDay(day, oh, om), close: kstToEpochDay(day, ch, cm), early: false };
}

export function marketDay(market: Market, day: string, ov?: DayOverride): DayInfo {
  return ov?.(market, day) ?? (market === "US" ? usDay(day) : krDay(day));
}

/**
 * A day as Toss's market calendar told it (toss.ts readMarketDay; null session = closed). US takes the regular
 * session's own hours, early closes included. KR takes only whether KRX trades: Toss's KR hours are the KRX+NXT union,
 * so the hours stay the table's (or 09:00–15:30).
 */
export function dayFromToss(market: Market, day: string, session: { open: number; close: number } | null): DayInfo {
  if (!session) return { kind: "closed", reason: "holiday", name: "토스증권 장 운영 정보" };
  if (market === "KR") return { kind: "open", session: krSession(day) };
  return { kind: "open", session: { market: "US", day, open: session.open, close: session.close, early: session.close < etToEpoch(day, 16, 0) } };
}

/** HH:MM in the market's own clock */
export function marketClock(market: Market, ms: number): string {
  const local = ms + (market === "US" ? easternOffset(ms) : 9) * HOUR;
  const min = Math.floor((((local % 86_400_000) + 86_400_000) % 86_400_000) / MIN);
  return `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;
}

/** One watch check: `close` is the check after the close that reads the official close. */
export interface Slot {
  market: Market;
  day: string;
  at: number;
  close: boolean;
  /** "US:2026-11-27:09:45" style key (market time) — stored as a rule's last observed slot */
  key: string;
}

function slotKey(market: Market, day: string, at: number): string {
  const offH = market === "US" ? easternOffset(at) : 9;
  const local = at + offH * HOUR;
  const min = Math.floor((local % 86_400_000) / MIN);
  return `${market}:${day}:${pad(Math.floor(min / 60))}:${pad(min % 60)}`;
}

/** every check of a session, oldest first */
export function sessionSlots(s: Session): Slot[] {
  const out: Slot[] = [];
  for (let at = s.open + FIRST_CHECK_AFTER_OPEN_MS; at <= s.close; at += SLOT_MS) out.push({ market: s.market, day: s.day, at, close: false, key: slotKey(s.market, s.day, at) });
  const after = s.close + SLOT_MS;
  out.push({ market: s.market, day: s.day, at: after, close: true, key: slotKey(s.market, s.day, after) });
  return out;
}

/** The check due at `now`: the latest slot at or before now, if now is still inside its 5 minutes. Null outside the
 * run window, on closed days and on unknown days. */
export function currentSlot(market: Market, now: number, ov?: DayOverride): Slot | null {
  const info = marketDay(market, marketDate(market, now), ov);
  if (info.kind !== "open") return null;
  let due: Slot | null = null;
  for (const s of sessionSlots(info.session)) if (s.at <= now) due = s;
  return due && now < due.at + SLOT_MS ? due : null;
}

/** The check that comes before `slot`: the one 5 minutes earlier, or the close check of the last trading day before.
 * Null when an unknown day lies in between or nothing is found within 15 days. */
export function prevSlot(slot: Slot, ov?: DayOverride): Slot | null {
  const info = marketDay(slot.market, slot.day, ov);
  if (info.kind === "open") {
    const all = sessionSlots(info.session);
    const i = all.findIndex((s) => s.at === slot.at);
    if (i > 0) return all[i - 1]!;
  }
  let z = dayNumber(slot.day);
  for (let n = 0; n < 15; n++) {
    z -= 1;
    const d = marketDay(slot.market, civilDate(z), ov);
    if (d.kind === "unknown") return null;
    if (d.kind === "open") return sessionSlots(d.session).at(-1)!;
  }
  return null;
}

/** The next session's open after `ms` (for "다음 거래일 개장 15분 뒤", B4). Null when an unknown day comes first. */
export function nextSession(market: Market, ms: number, ov?: DayOverride): Session | null {
  let z = dayNumber(marketDate(market, ms));
  for (let n = 0; n < 15; n++) {
    const d = marketDay(market, civilDate(z), ov);
    if (d.kind === "unknown") return null;
    if (d.kind === "open" && d.session.open > ms) return d.session;
    z += 1;
  }
  return null;
}

/**
 * Market days after `from` up to and including `to` (YYYY-MM-DD): how old a daily figure is in sessions. An unknown day
 * (no KRX table for that year) counts as a market day, so an old figure ages out rather than lasting.
 */
export function marketDaysAfter(market: Market, from: string, to: string, ov?: DayOverride): number {
  let n = 0;
  const end = dayNumber(to);
  for (let z = dayNumber(from) + 1; z <= end && n < 400; z++) if (marketDay(market, civilDate(z), ov).kind !== "closed") n++;
  return n;
}

/** when a day's bar is final: that session's close check (close + 5 minutes); null when the day has no session */
export function closeCheckAt(market: Market, day: string, ov?: DayOverride): number | null {
  const d = marketDay(market, day, ov);
  return d.kind === "open" ? d.session.close + SLOT_MS : null;
}

/**
 * The daily bars that are over at `now` (team-lead 2253): nothing after today, and today's bar only from its close
 * check on. A bar read during the session is still moving: its close is the price of that moment.
 */
export function finishedBars<T extends { t: string }>(bars: T[], market: Market, now: number, ov?: DayOverride): T[] {
  const today = marketDate(market, now);
  const at = closeCheckAt(market, today, ov);
  const todayDone = at != null && now >= at;
  return bars.filter((b) => b.t < today || (b.t === today && todayDone));
}

/** how long a daily read stays good: up to today's close check when read before it (then today's bar is final), else
 * to the next market day */
export function dailyUntil(market: Market, t: number, ov?: DayOverride): number {
  const at = closeCheckAt(market, marketDate(market, t), ov);
  return at != null && t < at ? at : nextMarketDayStart(market, t);
}

/** The start of the next market day (00:00 local) after `ms`: a paused source tries again from there. */
export function nextMarketDayStart(market: Market, ms: number): number {
  const z = dayNumber(marketDate(market, ms)) + 1;
  const day = civilDate(z);
  return market === "US" ? etToEpoch(day, 0, 0) : kstToEpochDay(day, 0, 0);
}
