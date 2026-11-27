import { describe, expect, test } from "bun:test";
import { FULL_VIEW, PHONE_CARD, type Bar, type ChartLevel } from "@pickle/quant";
import { chartHeight, chartName, DAYS_MAX, DAYS_MIN, dayWords, daysFor, drawChart, nearestBar, readings, themeAt, type ChartInput } from "../src/ui/investChartFit";

// synthetic weekday bars from 2025-12-01, a slow wave around 30 (no market data)
function barsOf(n: number, base = 30, amp = 3): Bar[] {
  const out: Bar[] = [];
  const d = new Date(Date.UTC(2025, 11, 1));
  for (let i = 0; out.length < n; i++) {
    const day = new Date(d.getTime() + i * 86_400_000);
    if (day.getUTCDay() === 0 || day.getUTCDay() === 6) continue;
    const k = out.length;
    const c = base + amp * Math.sin(k / 9) + 0.01 * k;
    out.push({ t: day.toISOString().slice(0, 10), o: c - 0.2, h: c + 0.5, l: c - 0.6, c, v: 1_000_000 + 1000 * k });
  }
  return out;
}
const LEVELS: ChartLevel[] = [
  { kind: "stop", price: 25.8 },
  { kind: "target1", price: 36.5 },
  { kind: "buyZone", price: 30, hi: 31.5 },
];
const SENTENCE = "11월 26일 종가 32.57달러. 합성 데이터.";
const input = (bars = barsOf(260), currency?: "USD" | "KRW"): ChartInput => ({ symbol: "SOXL", bars, levels: LEVELS, summary: SENTENCE, currency });
const ariaOf = (svg: string) => /aria-label="([^"]*)"/.exec(svg)?.[1] ?? null;

describe("InvestChart's arithmetic (DD 2145, DD 0914 D3 / D5)", () => {
  test("days: floor(plot ÷ 3), at least 30, at most 60 (or the layout's own)", () => {
    expect([226, 180, 120, 93, 60, 0].map((w) => daysFor(w))).toEqual([60, 60, 40, 31, 30, 30]);
    expect(daysFor(226, 40)).toBe(40);
    // a layout asking for more than 60 still gets 60 (DD 0914 D5's most)
    expect(daysFor(400, 90)).toBe(60);
    expect([DAYS_MIN, DAYS_MAX]).toEqual([30, 60]);
  });
  test("type at 13 × the text size, never under 13 px; the full view is 420 high, the card 264", () => {
    expect([themeAt(1).tick.size, themeAt(1).label.size, themeAt(1.3).tick.size, themeAt(1.15).label.size, themeAt(0.9).label.size, themeAt(0.9).tick.size]).toEqual([13, 13, 16.9, 15, 13, 13]);
    expect([chartHeight(FULL_VIEW), chartHeight(PHONE_CARD)]).toEqual([420, 264]);
  });
  test("drawn at the measured width, 1:1 (no viewBox scaling), its type at the text size", () => {
    const a = drawChart(input(), 358, 1);
    expect(a.days).toBe(60);
    expect(a.chart.width).toBe(358);
    expect(a.chart.svg).toContain('viewBox="0 0 358 420" width="358" height="420"');
    expect(a.chart.bars.length).toBe(60);
    const b = drawChart(input(), 288, 1.3);
    expect(b.chart.svg).toContain('viewBox="0 0 288 420" width="288"');
    expect(b.chart.svg).toContain('font-size="16.9"');
    expect(b.chart.svg).not.toContain('font-size="13"');
    // the days fit the plot that was drawn with them: a fixed point of daysFor
    expect(b.days).toBe(daysFor(b.chart.plot.x1 - b.chart.plot.x0));
    expect(b.days).toBeLessThan(60);
    expect(b.chart.bars.length).toBe(b.days);
    // labels keep a line apart at the larger type
    expect(b.layout.minGap).toBeGreaterThanOrEqual(22);
    // a width with a fraction (any caller; the part's own clientWidth is whole) is drawn at its whole px: no half-px SVG
    const f = drawChart(input(), 358.6, 1);
    expect(f.chart.width).toBe(358);
    expect(f.chart.svg).toContain('viewBox="0 0 358 420" width="358" height="420"');
  });
  test("fewer bars than days: the days shown are the bars there are", () => {
    const c = drawChart(input(barsOf(40)), 358, 1);
    expect(c.days).toBe(40);
    expect(c.chart.bars.length).toBe(40);
  });
  test("the crosshair's reading: the day and close, then the 20- and 50-day averages (quant's formatter)", () => {
    const inp = input();
    const { chart } = drawChart(inp, 358, 1);
    const rs = readings(inp, chart);
    expect(rs.length).toBe(60);
    const last = inp.bars.at(-1)!;
    expect(rs.at(-1)!.head).toBe(`${dayWords(last.t)} · 종가 $${last.c.toFixed(2)}`);
    expect(rs.at(-1)!.averages).toMatch(/^20일 \d+\.\d{2} · 50일 \d+\.\d{2}$/);
    expect(rs.every((r, i) => r.x === chart.bars[i]!.x)).toBe(true);
    // won: whole numbers and 원; too few days for an average: 확인 불가
    const won = input(barsOf(40, 189_000, 3_000), "KRW");
    const w = drawChart(won, 358, 1);
    const wr = readings(won, w.chart);
    expect(wr[0]!.head).toMatch(/^\d+월 \d+일 · 종가 [\d,]+원$/);
    expect(wr[0]!.averages).toBe("20일 확인 불가 · 50일 확인 불가");
    expect(wr.at(-1)!.averages).toMatch(/^20일 [\d,]+ · 50일 확인 불가$/);
  });
  test("the picture's name: the symbol and the days drawn, then the server's sentence (DD 1442 §1)", () => {
    expect(chartName("SOXL", 40, SENTENCE)).toBe("SOXL 일봉 40일. 11월 26일 종가 32.57달러. 합성 데이터.");
    expect(chartName("005930", 60, "  ")).toBe("005930 일봉 60일.");
    const wide = drawChart(input(), 358, 1);
    expect(ariaOf(wide.chart.svg)).toBe(`SOXL 일봉 60일. ${SENTENCE}`);
    // fitted days: the name says the days the legend says and the bars drawn
    const narrow = drawChart(input(), 288, 1.3);
    expect(narrow.days).toBeLessThan(60);
    expect([ariaOf(narrow.chart.svg), narrow.chart.bars.length]).toEqual([`SOXL 일봉 ${narrow.days}일. ${SENTENCE}`, narrow.days]);
    // fewer bars than days: the bars there are
    const few = drawChart(input(barsOf(40)), 358, 1);
    expect([ariaOf(few.chart.svg), few.chart.bars.length]).toEqual([`SOXL 일봉 40일. ${SENTENCE}`, 40]);
  });
  test("the nearest drawn bar to a point", () => {
    const { chart } = drawChart(input(), 358, 1);
    expect(nearestBar(chart, chart.bars[10]!.x + 0.4)).toBe(10);
    expect(nearestBar(chart, -50)).toBe(0);
    expect(nearestBar(chart, 9999)).toBe(chart.bars.length - 1);
    expect(dayWords("2026-11-26")).toBe("11월 26일");
  });
});
