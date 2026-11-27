import { APP_THEME, FULL_VIEW, krw, levelChart, num, sma, UNKNOWN_TEXT, usd, type Bar, type ChartLayout, type ChartLevel, type ChartTheme, type LevelChart } from "@pickle/quant";

/**
 * InvestChart's arithmetic, kept out of the component so it can be tested without a DOM (DD 2145 "앱 차트 부품",
 * DD 0914 D3 / D5): the level chart drawn by @pickle/quant at the width the part measured (never scaled by a viewBox:
 * a 326 chart squeezed to 288 would draw 13 px type at 11.5), the type at 13 × the person's text size, the days shown
 * fitted to the plot, and the crosshair's reading for a bar. The quant package itself is not changed here.
 */

/** DD 0914 D5: a bar keeps 3 px (a 2 px body and a 1 px gap); the days shown are floor(plot ÷ 3), 30 to 60 */
export const BAR_PX = 3;
export const DAYS_MIN = 30;
export const DAYS_MAX = 60;
export const daysFor = (plotWidth: number, most: number = DAYS_MAX) => Math.max(DAYS_MIN, Math.min(most, DAYS_MAX, Math.floor(plotWidth / BAR_PX)));

/** the type of the chart's ticks and labels at 100 % (DD 1935 §4) */
export const CHART_TYPE_PX = 13;

/** the app theme at the person's text size (DD 2145: 13 × textScale, never under 13 px: DD 1935's floor), everything else as quant has it */
export function themeAt(scale: number): ChartTheme {
  const size = Math.max(CHART_TYPE_PX, Math.round(CHART_TYPE_PX * scale * 10) / 10);
  return { ...APP_THEME, tick: { ...APP_THEME.tick, size }, label: { ...APP_THEME.label, size } };
}

export interface ChartInput {
  /** the symbol as the screen shows it (SOXL, 005930): the picture's name starts with it */
  symbol: string;
  /** oldest first; every bar the server sent (the 200-day average needs 259 of them for a 60-day window) */
  bars: readonly Bar[];
  levels: readonly ChartLevel[];
  /** the server's sentence after the chart's name (DD 1442 §1): `11월 26일 종가 32.57달러. 손절 25.80 … RSI 48.` */
  summary: string;
  currency?: "USD" | "KRW";
}

/**
 * The picture's name for a screen reader (DD 1442 §1): `{symbol} 일봉 {N}일. ` and then the server's sentence, N the days
 * drawn. Only the part knows N (it fits the days to the width), so the server sends the rest and the part adds the head;
 * the legend, which says the days too, stays hidden from screen readers, so the days are heard once.
 */
export const chartName = (symbol: string, days: number, summary: string) => [`${symbol} 일봉 ${days}일.`, summary.trim()].filter(Boolean).join(" ");

/** a price's digits on labels and ticks: cents for dollars, whole won */
export const digitsOf = (currency: ChartInput["currency"]) => (currency === "KRW" ? 0 : 2);

/** the chart's height for a layout (the main panel, RSI, and MACD when the layout has it): the part keeps it before it can draw */
export const chartHeight = (l: ChartLayout) => l.mainH + l.gap + l.rsiH + (l.macdH ? l.gap + l.macdH : 0);

/**
 * The chart at `width` and text size `scale`: the layout's other sizes as given, labels kept at least a line apart, and
 * the days fitted to the plot. The label column follows the visible range, so the fit is checked again after a redraw
 * (three draws at most). Throws as levelChart does (fewer than two bars, a price that is not a number).
 */
export function drawChart(input: ChartInput, width: number, scale: number, base: ChartLayout = FULL_VIEW): { chart: LevelChart; days: number; layout: ChartLayout } {
  const theme = themeAt(scale);
  const minGap = Math.max(base.minGap, Math.ceil(theme.label.size + 5));
  const at = (days: number): ChartLayout => ({ ...base, width: Math.floor(width), days, minGap });
  const draw = (l: ChartLayout) => levelChart({ bars: input.bars, levels: input.levels, summary: chartName(input.symbol, Math.min(l.days, input.bars.length), input.summary), digits: digitsOf(input.currency), currency: input.currency }, theme, l);
  let layout = at(Math.min(base.days, DAYS_MAX));
  let chart = draw(layout);
  for (let i = 0; i < 2; i++) {
    const days = daysFor(chart.plot.x1 - chart.plot.x0, base.days);
    if (days === layout.days) break;
    layout = at(days);
    chart = draw(layout);
  }
  return { chart, days: Math.min(layout.days, input.bars.length), layout };
}

/** the drawn bar nearest to x (the plot's own px; the SVG is drawn 1:1) */
export function nearestBar(chart: Pick<LevelChart, "bars">, x: number): number {
  let best = 0;
  for (let i = 1; i < chart.bars.length; i++) if (Math.abs(chart.bars[i]!.x - x) < Math.abs(chart.bars[best]!.x - x)) best = i;
  return best;
}

/** "2026-11-26" → 11월 26일 */
export function dayWords(t: string): string {
  const [, m, d] = t.split("-").map(Number);
  return `${m}월 ${d}일`;
}

export interface Reading {
  x: number;
  /** 11월 26일 · 종가 $32.57 */
  head: string;
  /** 20일 31.90 · 50일 30.12 (확인 불가 where an average has too few days) */
  averages: string;
}

/**
 * The crosshair's reading for each drawn bar (DD 0914 D3): the day and its close, then the 20- and 50-day averages,
 * each computed over every bar sent (as the chart draws them), formatted by quant's own formatter.
 */
export function readings(input: ChartInput, chart: Pick<LevelChart, "bars">): Reading[] {
  const close = input.bars.map((b) => b.c);
  const ma20 = sma(close, 20);
  const ma50 = sma(close, 50);
  const start = input.bars.length - chart.bars.length;
  const digits = digitsOf(input.currency);
  const price = (x: number) => (input.currency === "KRW" ? krw(x) : usd(x));
  const avg = (v: number | null | undefined) => (v == null ? UNKNOWN_TEXT : num(v, digits));
  return chart.bars.map((b, i) => {
    const bar = input.bars[start + i]!;
    return { x: b.x, head: `${dayWords(bar.t)} · 종가 ${price(bar.c)}`, averages: `20일 ${avg(ma20[start + i])} · 50일 ${avg(ma50[start + i])}` };
  });
}
