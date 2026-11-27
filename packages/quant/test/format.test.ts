/** The shared formatter (DD 1935 §0-5) and the signal marks (§0-4). */
import { describe, expect, test } from "bun:test";
import { MINUS, UNKNOWN_TEXT, atText, basisNote, delay, easternOffset, estimate, footLine, krw, kst, kstDayTime, kstWithEastern, num, pct, pp, rate, shares, usd, wonTicks } from "../src/format";
import { SIGNAL_SHAPES, SIGNAL_WORD, TRI_WORD, signalMarkSvg, signalSummary } from "../src/signal";

describe("numbers", () => {
  test("the minus sign is U+2212; zero and what rounds to it have no sign", () => {
    expect(MINUS.codePointAt(0)).toBe(0x2212);
    expect(num(-1.5, 1)).toBe("−1.5");
    expect([num(0, 2, { sign: true }), num(-0.004, 2, { sign: true }), num(0.004, 2, { sign: true }), num(-0, 0)]).toEqual(["0.00", "0.00", "0.00", "0"]);
  });
  test("thousands grouped, decimals fixed, half away from zero on the decimal value", () => {
    expect([num(1234567.5, 2), num(999.995, 2), num(1.005, 2), num(-1.005, 2), num(12, 0)]).toEqual(["1,234,567.50", "1,000.00", "1.01", "−1.01", "12"]);
  });
  test("float leftovers, tiny and huge values never come out as NaN (DD 2045); what is not finite is 확인 불가", () => {
    expect(pct((0.1 + 0.2 - 0.3) * 100)).toBe("0.00%");
    expect(num(1e-7, 2)).toBe("0.00");
    expect(usd(-1e-9)).toBe("$0.00");
    expect(usd(1e21)).toBe("$1,000,000,000,000,000,000,000.00");
    expect([num(NaN, 2), num(Infinity, 2), num(-Infinity, 0)]).toEqual(["확인 불가", "확인 불가", "확인 불가"]);
    expect([usd(NaN), krw(NaN), pct(NaN), rate(Infinity), pp(NaN), shares(NaN)]).toEqual(Array(6).fill("확인 불가"));
    expect(pct(25.62 - 25.8 + 0.18)).toBe("0.00%");
    expect([num(0.005, 2), num(0.00499, 2), num(-0.005, 2), num(5e-7, 6), num(1.23e-5, 6)]).toEqual(["0.01", "0.00", "−0.01", "0.000001", "0.000012"]);
    expect([krw(1_203_740_000_000_000), num(123456789012345.67, 2)]).toEqual(["1,203,740,000,000,000원", "123,456,789,012,345.67"]);
  });
  test("a sweep over magnitudes 1e−12 … 1e22, both signs, 0–4 digits: always grouped digits, within half a unit", () => {
    let seed = 11;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const shape = /^[−+]?\d{1,3}(,\d{3})*(\.\d+)?$/;
    for (let i = 0; i < 20_000; i++) {
      const x = (rnd() < 0.5 ? -1 : 1) * 10 ** (rnd() * 34 - 12) * (1 + rnd());
      const d = Math.floor(rnd() * 5);
      const s = num(x, d, { sign: rnd() < 0.5 });
      if (!shape.test(s)) throw new Error(`${x} ${d} → ${s}`);
      const back = Number(s.replace(/,/g, "").replace("−", "-"));
      if (Math.abs(x) < 1e13 && Math.abs(back - x) > 0.5 * 10 ** -d * (1 + 1e-9) + Math.abs(x) * 1e-15) throw new Error(`${x} ${d} → ${s}`);
    }
  });
  test("the table's forms", () => {
    expect([usd(32.57), usd(1234.5), usd(-1.2)]).toEqual(["$32.57", "$1,234.50", "−$1.20"]);
    expect(krw(189_400)).toBe("189,400원");
    expect([num(9214.36, 2), num(24.1, 2)]).toEqual(["9,214.36", "24.10"]);
    expect([pct(2.31), pct(-1.04), pct(0)]).toEqual(["+2.31%", "−1.04%", "0.00%"]);
    expect([rate(4.12), pp(0.24), pp(-0.1)]).toEqual(["4.12%", "+0.24%p", "−0.10%p"]);
    expect(shares(47)).toBe("47주");
    expect(estimate(usd(1204))).toBe("약 $1,204.00(추정)");
    expect([delay(1, "일"), delay(15, "분")]).toEqual(["1일 지연", "15분 지연"]);
    expect(UNKNOWN_TEXT).toBe("확인 불가");
  });
});

describe("won ticks in 만 (DD 2228-b)", () => {
  test("every tick 10,000 or more and a multiple of 1,000: 만, whole or one decimal, per tick", () => {
    expect(wonTicks([150_000, 200_000, 250_000])).toEqual(["15만", "20만", "25만"]);
    expect(wonTicks([185_000, 186_000, 187_000])).toEqual(["18.5만", "18.6만", "18.7만"]);
    expect(wonTicks([180_000, 185_000, 190_000])).toEqual(["18만", "18.5만", "19만"]);
    expect(wonTicks([1_250_000])).toEqual(["125만"]);
    expect(wonTicks([12_500_000, 13_000_000])).toEqual(["1,250만", "1,300만"]);
  });
  test("a step that is not a multiple of 1,000, or a tick under 10,000: all in full", () => {
    expect(wonTicks([187_500, 190_000])).toEqual(["187,500", "190,000"]);
    expect(wonTicks([9_500, 10_000, 10_500])).toEqual(["9,500", "10,000", "10,500"]);
    expect(wonTicks([9_000, 10_000, 11_000])).toEqual(["9,000", "10,000", "11,000"]);
    expect(wonTicks([])).toEqual([]);
  });
});

describe("times", () => {
  test("KST first, US Eastern in brackets: DD's own example", () => {
    // 2026-11-26 15:45 UTC = 11월 27일 00:45 KST = 10:45 EST
    expect(kstWithEastern(Date.UTC(2026, 10, 26, 15, 45))).toBe("11월 27일 00:45(미 동부 10:45)");
    expect(kst(Date.UTC(2026, 10, 23, 23, 0))).toBe("11월 24일 08:00");
  });
  test("daylight time from 2:00 on the second Sunday of March to 2:00 on the first Sunday of November", () => {
    // 2026: March 8 and November 1
    expect(easternOffset(Date.UTC(2026, 2, 8, 6, 59))).toBe(-5);
    expect(easternOffset(Date.UTC(2026, 2, 8, 7, 0))).toBe(-4);
    expect(easternOffset(Date.UTC(2026, 10, 1, 5, 59))).toBe(-4);
    expect(easternOffset(Date.UTC(2026, 10, 1, 6, 0))).toBe(-5);
    // 2027: March 14 and November 7
    expect(easternOffset(Date.UTC(2027, 2, 14, 7, 0))).toBe(-4);
    expect(easternOffset(Date.UTC(2027, 10, 7, 6, 0))).toBe(-5);
    expect(kstWithEastern(Date.UTC(2026, 6, 1, 13, 30))).toBe("7월 1일 22:30(미 동부 09:30)");
  });
  test("a time in a sentence: alone on today's KST date, with its date otherwise", () => {
    const now = Date.UTC(2026, 10, 26, 15, 50); // 11월 27일 00:50 KST
    expect(atText(Date.UTC(2026, 10, 26, 15, 45), now)).toBe("00:45");
    expect(atText(Date.UTC(2026, 10, 26, 14, 59), now)).toBe("11월 26일 23:59");
    expect(atText(Date.UTC(2026, 10, 25, 21, 0), Date.UTC(2026, 10, 26, 14, 59))).toBe("06:00"); // both 11월 26일 KST
    expect(atText(Date.UTC(2026, 10, 25, 21, 0), Date.UTC(2026, 10, 26, 15, 0))).toBe("11월 26일 06:00");
  });
  test("an event's date: KST, M/D(weekday) HH:MM, the weekday of its own year (DD 0126 §2)", () => {
    expect(kstDayTime(Date.parse("2026-12-01T09:00:00+09:00"))).toBe("12/1(화) 09:00");
    expect(kstDayTime(Date.parse("2026-11-27T22:30:00+09:00"))).toBe("11/27(금) 22:30");
    expect(kstDayTime(Date.parse("2026-11-29T12:00:00+09:00"))).toBe("11/29(일) 12:00");
    expect(kstDayTime(Date.parse("2025-12-01T09:00:00+09:00"))).toBe("12/1(월) 09:00");
    // a US release at 10:00 Eastern is the next KST day's 00:00, and that date is written (EST in December, EDT in July)
    expect(kstDayTime(Date.parse("2026-12-03T10:00:00-05:00"))).toBe("12/4(금) 00:00");
    expect(kstDayTime(Date.parse("2026-07-01T10:00:00-04:00"))).toBe("7/1(수) 23:00");
    // KST midnight from the UTC side: 15:00 UTC is the next KST day
    expect(kstDayTime(Date.UTC(2026, 11, 31, 15, 0))).toBe("1/1(금) 00:00");
    expect(kstDayTime(NaN)).toBe(UNKNOWN_TEXT);
  });
  test("basis and foot lines", () => {
    expect(basisNote("2026-11-25", "FRED", "A")).toBe("11-25 기준, FRED · A");
    expect(footLine(kstWithEastern(Date.UTC(2026, 10, 26, 15, 45)), "토스증권", "A")).toBe("관측 11월 27일 00:45(미 동부 10:45) · 토스증권 · A");
  });
});

describe("signal marks", () => {
  test("four words, the condition words, the summary with zeros", () => {
    expect(SIGNAL_WORD).toEqual({ risk: "위험", caution: "경계", normal: "정상", unknown: "확인 불가" });
    expect(TRI_WORD).toEqual({ met: "충족", unmet: "미충족", unknown: "확인 불가" });
    expect(signalSummary({ risk: 3, caution: 2, normal: 5, unknown: 1 })).toBe("위험 3 · 경계 2 · 정상 5 · 확인 불가 1");
    expect(signalSummary({ risk: 0, caution: 0, normal: 11, unknown: 0 })).toBe("위험 0 · 경계 0 · 정상 11 · 확인 불가 0");
  });
  test("the shapes: filled, half, ring, dashed ring; currentColor only; no emoji", () => {
    expect(SIGNAL_SHAPES.risk).toContain('fill="currentColor"');
    expect(SIGNAL_SHAPES.caution).toContain('d="M8 2.75a5.25 5.25 0 0 1 0 10.5z"');
    expect(SIGNAL_SHAPES.normal).not.toContain("dasharray");
    expect(SIGNAL_SHAPES.unknown).toContain('stroke-dasharray="2.1 2.1"');
    for (const s of Object.values(SIGNAL_SHAPES)) {
      expect(s.match(/#[0-9a-f]{3,6}|rgb/gi)).toBeNull();
      expect(/\p{Extended_Pictographic}/u.test(s)).toBe(false);
    }
    expect(signalMarkSvg("risk", { size: "15px", color: "#8C2318" })).toBe(
      '<svg viewBox="0 0 16 16" width="15px" height="15px" aria-hidden="true" style="color:#8C2318"><circle cx="8" cy="8" r="6" fill="currentColor"/></svg>',
    );
  });
});
