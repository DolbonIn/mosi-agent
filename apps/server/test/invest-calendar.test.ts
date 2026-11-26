// invest calendar (agent-runtime 2006 §1, 2052 §A-5): NYSE holidays and early closes by rule, daylight time, the KRX
// table, and the watch slots (G2: from 15 minutes after the open every 5 minutes, then one close check).
import { describe, expect, test } from "bun:test";
import { civilDate } from "@pickle/quant";
import {
  closeCheckAt,
  currentSlot,
  dailyUntil,
  dayFromToss,
  finishedBars,
  kstToEpochDay,
  marketDay,
  type DayOverride,
  etDate,
  etToEpoch,
  krDay,
  marketDaysAfter,
  nextMarketDayStart,
  nextSession,
  prevSlot,
  sessionSlots,
  usDay,
  usEarlyCloses,
  usHolidays,
  type Session,
} from "../src/invest/calendar.ts";
import { readCandles, readMarketDay } from "../src/invest/toss.ts";

const days = (m: Map<number, string> | Set<number>) => [...m.keys()].map(civilDate).sort();
const open = (day: string): Session => {
  const d = usDay(day);
  if (d.kind !== "open") throw new Error(`${day} is not open`);
  return d.session;
};
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 16);

describe("NYSE rules", () => {
  test("2026 and 2027 holidays", () => {
    expect(days(usHolidays(2026))).toEqual([
      "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25", "2026-06-19", "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25",
    ]);
    // Juneteenth on a Saturday → Friday 18 June; 4 July on a Sunday → Monday 5 July; Christmas on a Saturday → Friday 24 December
    expect(days(usHolidays(2027))).toEqual([
      "2027-01-01", "2027-01-18", "2027-02-15", "2027-03-26", "2027-05-31", "2027-06-18", "2027-07-05", "2027-09-06", "2027-11-25", "2027-12-24",
    ]);
  });

  test("New Year's Day on a Saturday is not moved back into December", () => {
    expect(days(usHolidays(2022))).not.toContain("2021-12-31");
    expect(usDay("2021-12-31").kind).toBe("open");
    expect(usHolidays(2022).size).toBe(9);
  });

  test("early closes: 3 July only Monday–Thursday, the day after Thanksgiving, Christmas Eve only Monday–Thursday", () => {
    expect(days(usEarlyCloses(2026))).toEqual(["2026-11-27", "2026-12-24"]); // 3 July 2026 is the observed holiday
    expect(days(usEarlyCloses(2027))).toEqual(["2027-11-26"]); // 3 July a Saturday, 24 December the holiday
    expect(days(usEarlyCloses(2025))).toEqual(["2025-07-03", "2025-11-28", "2025-12-24"]);
  });

  test("the source's G2 days: 11-26 closed (Thanksgiving), 11-27 closes 13:00 ET = 11-28 03:00 KST", () => {
    expect(usDay("2026-11-26")).toEqual({ kind: "closed", reason: "holiday", name: "Thanksgiving Day" });
    const s = open("2026-11-27");
    expect(s.early).toBe(true);
    expect(iso(s.open)).toBe("2026-11-27T14:30"); // EST: 09:30 ET = 14:30Z
    expect(iso(s.close)).toBe("2026-11-27T18:00"); // 13:00 ET = 18:00Z = 03:00 KST on 11-28
    expect(usDay("2026-11-28")).toEqual({ kind: "closed", reason: "weekend" });
    expect(usDay("2025-01-09")).toEqual({ kind: "closed", reason: "holiday", name: "National Day of Mourning" });
  });

  test("daylight time: 2026 starts 8 March, ends 1 November", () => {
    expect(iso(open("2026-03-06").open)).toBe("2026-03-06T14:30");
    expect(iso(open("2026-03-09").open)).toBe("2026-03-09T13:30");
    expect(iso(open("2026-10-30").close)).toBe("2026-10-30T20:00");
    expect(iso(open("2026-11-02").close)).toBe("2026-11-02T21:00");
    expect(etToEpoch("2026-07-01", 16, 0)).toBe(Date.parse("2026-07-01T20:00:00Z"));
    expect(etDate(Date.parse("2026-11-27T04:59:00Z"))).toBe("2026-11-26");
    expect(etDate(Date.parse("2026-11-27T05:00:00Z"))).toBe("2026-11-27");
  });
});

describe("KRX table", () => {
  test("2026 holidays and hours; a year without a table is unknown", () => {
    expect(krDay("2026-09-25")).toMatchObject({ kind: "closed", reason: "holiday" });
    expect(krDay("2026-12-31")).toMatchObject({ kind: "closed", name: "연말 휴장" });
    const d = krDay("2026-11-27");
    expect(d.kind).toBe("open");
    if (d.kind === "open") {
      expect(iso(d.session.open)).toBe("2026-11-27T00:00"); // 09:00 KST
      expect(iso(d.session.close)).toBe("2026-11-27T06:30"); // 15:30 KST
    }
    const exam = krDay("2026-11-19");
    if (exam.kind === "open") expect([iso(exam.session.open), iso(exam.session.close)]).toEqual(["2026-11-19T01:00", "2026-11-19T07:30"]);
    else throw new Error("exam day should be open");
    expect(krDay("2027-01-04")).toEqual({ kind: "unknown" });
    expect(krDay("2027-01-02")).toEqual({ kind: "closed", reason: "weekend" });
  });
});

describe("watch slots", () => {
  test("a regular day: 09:45 … 16:00 every 5 minutes, then the 16:05 close check (77)", () => {
    const slots = sessionSlots(open("2026-11-25"));
    expect(slots.length).toBe(77);
    expect(slots[0]!.key).toBe("US:2026-11-25:09:45");
    expect(slots.at(-2)!.key).toBe("US:2026-11-25:16:00");
    expect(slots.at(-1)).toMatchObject({ key: "US:2026-11-25:16:05", close: true });
    expect(slots.filter((s) => s.close).length).toBe(1);
  });

  test("an early close: 09:45 … 13:00, then 13:05 (41)", () => {
    const slots = sessionSlots(open("2026-11-27"));
    expect(slots.length).toBe(41);
    expect(slots.at(-1)!.key).toBe("US:2026-11-27:13:05");
  });

  test("currentSlot: inside a slot's 5 minutes only, never on a closed day or outside the run window", () => {
    const at = (s: string) => Date.parse(s);
    expect(currentSlot("US", at("2026-11-27T14:44:59Z"))).toBeNull(); // 09:44:59 ET
    expect(currentSlot("US", at("2026-11-27T14:45:00Z"))?.key).toBe("US:2026-11-27:09:45");
    expect(currentSlot("US", at("2026-11-27T14:49:59Z"))?.key).toBe("US:2026-11-27:09:45");
    expect(currentSlot("US", at("2026-11-27T14:50:00Z"))?.key).toBe("US:2026-11-27:09:50");
    expect(currentSlot("US", at("2026-11-27T18:05:00Z"))).toMatchObject({ key: "US:2026-11-27:13:05", close: true });
    expect(currentSlot("US", at("2026-11-27T18:10:00Z"))).toBeNull();
    expect(currentSlot("US", at("2026-11-26T16:00:00Z"))).toBeNull(); // Thanksgiving
    expect(currentSlot("KR", at("2026-11-27T00:15:00Z"))?.key).toBe("KR:2026-11-27:09:15");
    expect(currentSlot("KR", at("2027-01-04T01:00:00Z"))).toBeNull(); // unknown year
  });

  test("prevSlot: 5 minutes back, or the last trading day's close check (over a holiday); null across an unknown day", () => {
    const first = sessionSlots(open("2026-11-27"))[0]!;
    expect(prevSlot(first)?.key).toBe("US:2026-11-25:16:05");
    const second = sessionSlots(open("2026-11-27"))[1]!;
    expect(prevSlot(second)?.key).toBe("US:2026-11-27:09:45");
    const monday = sessionSlots(open("2026-11-30"))[0]!;
    expect(prevSlot(monday)?.key).toBe("US:2026-11-27:13:05");
    const kd = krDay("2026-01-02");
    if (kd.kind !== "open") throw new Error("2026-01-02 should be open");
    expect(prevSlot(sessionSlots(kd.session)[0]!)).toBeNull(); // 2025 has no KRX table
  });

  test("nextSession and the next market day's start", () => {
    expect(nextSession("US", Date.parse("2026-11-25T21:05:00Z"))?.day).toBe("2026-11-27");
    expect(iso(nextMarketDayStart("US", Date.parse("2026-11-25T21:05:00Z")))).toBe("2026-11-26T05:00");
    expect(iso(nextMarketDayStart("KR", Date.parse("2026-11-25T10:00:00Z")))).toBe("2026-11-25T15:00");
  });

  test("slot keys are Eastern clock times in daylight time too (EDT, UTC−4)", () => {
    const day = "2026-07-15"; // a Wednesday in daylight time
    const first = currentSlot("US", etToEpoch(day, 9, 45))!;
    expect(first.key).toBe("US:2026-07-15:09:45");
    expect(iso(first.at)).toBe("2026-07-15T13:45"); // 09:45 EDT
    expect(currentSlot("US", etToEpoch(day, 16, 5))!.key).toBe("US:2026-07-15:16:05");
    expect(sessionSlots(open(day)).map((s) => s.key.slice(-5))).toEqual(sessionSlots(open("2026-11-30")).map((s) => s.key.slice(-5)));
  });

  test("market days after a day: closed days skipped, an unknown day counted", () => {
    expect(marketDaysAfter("US", "2026-11-27", "2026-11-27")).toBe(0);
    expect(marketDaysAfter("US", "2026-11-27", "2026-11-29")).toBe(0); // the weekend
    expect(marketDaysAfter("US", "2026-11-27", "2026-12-01")).toBe(2);
    expect(marketDaysAfter("US", "2026-11-27", "2026-12-04")).toBe(5);
    expect(marketDaysAfter("US", "2026-11-27", "2026-12-07")).toBe(6);
    expect(marketDaysAfter("US", "2026-11-25", "2026-11-27")).toBe(1); // Thanksgiving closed, the early close counts
    expect(marketDaysAfter("US", "2026-12-23", "2026-12-28")).toBe(2); // 12-24 (early close) and 12-28; 12-25 closed
    // 12-31 closed (2026 table); 2027 has no table: its weekdays 01-01, 01-04, 01-05 count, the weekend does not
    expect(marketDaysAfter("KR", "2026-12-30", "2027-01-05")).toBe(3);
  });
});


describe("B1b: a person's Toss calendar, finished bars (team-lead 2253)", () => {
  const ET = (day: string, h: number, m: number) => etToEpoch(day, h, m);

  test("readMarketDay: US regular session or null; KR closed when integrated, its regular session or the KRX closing auction is null", () => {
    const us = (today: unknown) => readMarketDay("US", { result: { today, previousBusinessDay: { date: "x" }, nextBusinessDay: { date: "x" } } });
    expect(us({ date: "2026-11-27", regularMarket: { startTime: "2026-11-27T23:30:00+09:00", endTime: "2026-11-28T03:00:00+09:00" } })).toEqual({
      date: "2026-11-27",
      session: { open: ET("2026-11-27", 9, 30), close: ET("2026-11-27", 13, 0) },
    });
    expect(us({ date: "2026-11-26", dayMarket: null, preMarket: null, regularMarket: null, afterMarket: null })).toEqual({ date: "2026-11-26", session: null });
    expect(us({ date: "2026-11-26" })).toBeNull(); // no field: not read as closed
    expect(us({ date: "26-11-26", regularMarket: null })).toBeNull();
    const kr = (today: unknown) => readMarketDay("KR", { result: { today } });
    const krx = { startTime: "2026-07-17T09:00:00+09:00", singlePriceAuctionStartTime: "2026-07-17T15:20:00+09:00", endTime: "2026-07-17T15:30:00+09:00" };
    expect(kr({ date: "2026-07-17", integrated: { preMarket: null, regularMarket: krx, afterMarket: null } })).toEqual({
      date: "2026-07-17",
      session: { open: kstToEpochDay("2026-07-17", 9, 0), close: kstToEpochDay("2026-07-17", 15, 30) },
    });
    expect(kr({ date: "2026-07-17", integrated: null })).toEqual({ date: "2026-07-17", session: null });
    expect(kr({ date: "2026-07-17", integrated: { regularMarket: null } })).toEqual({ date: "2026-07-17", session: null });
    expect(kr({ date: "2026-07-17", integrated: { regularMarket: { ...krx, singlePriceAuctionStartTime: null } } })).toEqual({ date: "2026-07-17", session: null }); // NXT only
    expect(kr({ date: "2026-07-17" })).toBeNull();
    expect(readMarketDay("US", { error: { code: "x" } })).toBeNull();
  });

  test("readCandles: newest first in, oldest first out; decimal strings; one bar a day; the timestamp's own date", () => {
    const c = (t: string, close: string) => ({ timestamp: t, openPrice: "10", highPrice: "12.5", lowPrice: "9.5", closePrice: close, volume: "1000", currency: "USD" });
    const bars = readCandles({ result: { candles: [c("2026-11-27T00:00:00-05:00", "11"), c("2026-11-27T00:00:00-05:00", "99"), c("2026-11-25T00:00:00-05:00", "10.5"), c("2026-11-24T00:00:00-05:00", "x")], nextBefore: null } });
    expect(bars).toEqual([
      { t: "2026-11-25", o: 10, h: 12.5, l: 9.5, c: 10.5, v: 1000 },
      { t: "2026-11-27", o: 10, h: 12.5, l: 9.5, c: 11, v: 1000 },
    ]);
    expect(readCandles({ data: [] })).toEqual([]);
  });

  test("a day override decides that day only; the rules and the table decide the rest", () => {
    const ov: DayOverride = (m, d) => (m === "US" && d === "2026-11-26" ? dayFromToss("US", d, { open: ET(d, 9, 30), close: ET(d, 16, 0) }) : null);
    expect(marketDay("US", "2026-11-26").kind).toBe("closed");
    expect(marketDay("US", "2026-11-26", ov)).toMatchObject({ kind: "open", session: { early: false } });
    expect(currentSlot("US", ET("2026-11-26", 9, 45))).toBeNull();
    expect(currentSlot("US", ET("2026-11-26", 9, 45), ov)?.key).toBe("US:2026-11-26:09:45");
    expect(marketDay("US", "2026-11-27", ov)).toEqual(marketDay("US", "2026-11-27"));
    // the slot before Friday's first one is Thursday's close check for this person
    const fri = currentSlot("US", ET("2026-11-27", 9, 45), ov)!;
    expect(prevSlot(fri, ov)?.key).toBe("US:2026-11-26:16:05");
    expect(prevSlot(fri)?.key).toBe("US:2026-11-25:16:05");
    expect(marketDaysAfter("US", "2026-11-25", "2026-11-27", ov)).toBe(2);
    expect(marketDaysAfter("US", "2026-11-25", "2026-11-27")).toBe(1);
    // Toss's early close: the close check moves with it
    const early = dayFromToss("US", "2026-12-01", { open: ET("2026-12-01", 9, 30), close: ET("2026-12-01", 13, 0) });
    expect(early).toMatchObject({ kind: "open", session: { early: true } });
    // KR: open or closed only, the hours stay KRX's
    expect(dayFromToss("KR", "2026-07-17", { open: kstToEpochDay("2026-07-17", 8, 0), close: kstToEpochDay("2026-07-17", 20, 0) })).toEqual({
      kind: "open",
      session: { market: "KR", day: "2026-07-17", open: kstToEpochDay("2026-07-17", 9, 0), close: kstToEpochDay("2026-07-17", 15, 30), early: false },
    });
    expect(dayFromToss("KR", "2026-11-19", { open: 0, close: 1 })).toMatchObject({ session: { open: kstToEpochDay("2026-11-19", 10, 0), close: kstToEpochDay("2026-11-19", 16, 30) } });
    expect(dayFromToss("US", "2026-11-30", null)).toEqual({ kind: "closed", reason: "holiday", name: "토스증권 장 운영 정보" });
  });

  test("finished bars: none after today; today's from its close check on (13:05 on an early close); a daily read lasts to that check", () => {
    const bars = [{ t: "2026-11-25" }, { t: "2026-11-27" }, { t: "2026-11-30" }, { t: "2026-12-01" }];
    expect(finishedBars(bars, "US", ET("2026-11-30", 10, 0)).map((b) => b.t)).toEqual(["2026-11-25", "2026-11-27"]);
    expect(finishedBars(bars, "US", ET("2026-11-30", 16, 4)).map((b) => b.t)).toEqual(["2026-11-25", "2026-11-27"]);
    expect(finishedBars(bars, "US", ET("2026-11-30", 16, 5)).map((b) => b.t)).toEqual(["2026-11-25", "2026-11-27", "2026-11-30"]);
    expect(finishedBars(bars, "US", ET("2026-11-27", 13, 5)).map((b) => b.t)).toEqual(["2026-11-25", "2026-11-27"]); // early close
    expect(finishedBars(bars, "US", ET("2026-11-28", 12, 0)).map((b) => b.t)).toEqual(["2026-11-25", "2026-11-27"]); // Saturday
    expect(closeCheckAt("US", "2026-11-27")).toBe(ET("2026-11-27", 13, 5));
    expect(closeCheckAt("US", "2026-11-26")).toBeNull();
    expect(dailyUntil("US", ET("2026-11-30", 10, 0))).toBe(ET("2026-11-30", 16, 5));
    expect(dailyUntil("US", ET("2026-11-30", 8, 0))).toBe(ET("2026-11-30", 16, 5));
    expect(dailyUntil("US", ET("2026-11-30", 16, 5))).toBe(nextMarketDayStart("US", ET("2026-11-30", 16, 5)));
    expect(dailyUntil("US", ET("2026-11-28", 12, 0))).toBe(nextMarketDayStart("US", ET("2026-11-28", 12, 0)));
  });
});
