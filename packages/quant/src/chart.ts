/**
 * The level chart (D10, DD 1935 §4 as fixed by DD 1949) as an SVG string, the same function for the app's card and full
 * view and for the deck. A level's meaning (kind) comes from the data and its colour and line from the theme: the app
 * passes `var(--…)` strings, so the inline SVG follows the theme without being drawn again, and the deck passes hex.
 *
 * Panels:
 * - The main panel holds the candles, MA 20/50/200, the 60-day VWAP, the levels and the buy-review band. The full view
 *   and the deck also draw the top three volume-profile nodes under the candles.
 * - RSI (14) sits below it. The full view and the deck add a MACD histogram panel.
 * - The phone card leaves out the volume profile and MACD (DD 1949 §2).
 *
 * The vertical range takes in the candles and the levels. A level that would squeeze the candles' range under half the
 * plot is drawn as its word and an arrow at the top or bottom of the label column instead of a line (`level_offscale`).
 * No level line is ever drawn outside the plot box.
 *
 * Labels sit in the right column, one line each (`<word> <price>`), at least `minGap` apart. A label moves up or down
 * only as far as it must, and a short leader joins it to its line when it moved. When they do not all fit, the lowest
 * priority goes first (`label_dropped`): 손절 > 현재가 > 1차 익절 > 매수 검토 > 저항 > 지지 > 2·3차 익절. A card lists
 * every dropped or off-scale level in its reason rows.
 */
import { macd, rsi, sma, vwap } from "./indicators";
import { num, wonTicks } from "./format";
import { volumeProfile } from "./profile";
import type { Bar, Num } from "./types";

/** alert: a price the person set (내가 정한 가격); invalidate: the price that undoes the strategy (DD 0914 D4) */
export type LevelKind = "stop" | "target1" | "target2" | "target3" | "resistance" | "support" | "buyZone" | "alert" | "invalidate";

/** a level from the data: a price line, or (buyZone) the band from `price` up to `hi` */
export interface ChartLevel {
  kind: LevelKind;
  price: number;
  hi?: number;
}

export const LEVEL_WORD: Readonly<Record<LevelKind, string>> = {
  stop: "손절",
  target1: "1차 익절",
  target2: "2차 익절",
  target3: "3차 익절",
  resistance: "저항",
  support: "지지",
  buyZone: "매수 검토",
  alert: "알림",
  invalidate: "무효화",
};

/** label priority, first kept and last dropped (DD 1935 §4) */
export const LABEL_PRIORITY: readonly (LevelKind | "current")[] = ["stop", "current", "invalidate", "target1", "alert", "buyZone", "resistance", "support", "target2", "target3"];

export interface Stroke {
  color: string;
  width: number;
  dash?: string;
  round?: boolean;
}

export interface ChartTheme {
  font: string;
  tick: { size: number; color: string };
  /** level labels: the word's weight; the price is regular */
  label: { size: number; weight: number };
  grid: Stroke;
  up: { fill: string; stroke: string; width: number; wick: string };
  down: { fill: string; stroke: string; width: number; wick: string };
  ma20: Stroke;
  ma50: Stroke;
  ma200: Stroke;
  vwap: Stroke;
  stop: Stroke;
  target: Stroke;
  resistance: Stroke;
  support: Stroke;
  /** DD 0914 D4: the person's own price, a thin solid line; invalidation, dotted in the stop's colour (the stop is dashed) */
  alert: Stroke;
  invalidate: Stroke;
  zone: { fill: string; label: string };
  current: { line: Stroke; color: string };
  profile: { fill: string; max: number };
  rsi: Stroke;
  rsiBand: Stroke;
  macd: { up: string; down: string; zero: Stroke };
  leader: Stroke;
}

/** the app (DD 1935 §4, left column): CSS variables, so a theme change needs no redraw */
export const APP_THEME: ChartTheme = {
  font: "var(--font-text)",
  tick: { size: 13, color: "var(--label-2)" },
  label: { size: 13, weight: 600 },
  grid: { color: "var(--separator)", width: 0.5 },
  up: { fill: "var(--surface)", stroke: "var(--label)", width: 1, wick: "var(--label)" },
  down: { fill: "var(--label)", stroke: "none", width: 0, wick: "var(--label)" },
  ma20: { color: "var(--label)", width: 1.5 },
  ma50: { color: "var(--label-2)", width: 1.5 },
  ma200: { color: "var(--label-2)", width: 1.5, dash: "6 4" },
  vwap: { color: "var(--label)", width: 1.25, dash: "1.5 3", round: true },
  stop: { color: "var(--danger)", width: 1.5, dash: "6 4" },
  target: { color: "var(--label)", width: 1, dash: "2 3" },
  resistance: { color: "var(--label-2)", width: 1 },
  support: { color: "var(--label-2)", width: 1 },
  alert: { color: "var(--label-2)", width: 1 },
  invalidate: { color: "var(--danger)", width: 1.5, dash: "1.5 3", round: true },
  zone: { fill: "var(--fill)", label: "var(--label-2)" },
  current: { line: { color: "var(--label-3)", width: 0.5 }, color: "var(--label)" },
  profile: { fill: "var(--fill-2)", max: 48 },
  rsi: { color: "var(--label)", width: 1 },
  rsiBand: { color: "var(--separator)", width: 1, dash: "3 3" },
  macd: { up: "var(--fill-3)", down: "var(--fill-3)", zero: { color: "var(--separator)", width: 0.5 } },
  leader: { color: "var(--separator)", width: 1 },
};

/** the deck (DD 1935 §4, right column; D10 colours, FA3 palette) */
export const DECK_THEME: ChartTheme = {
  font: "'Noto Sans KR VF', 'Noto Sans KR', sans-serif",
  tick: { size: 15, color: "#7B8089" },
  label: { size: 15, weight: 700 },
  grid: { color: "#E4DED0", width: 1 },
  up: { fill: "#1B48D6", stroke: "#1B48D6", width: 1, wick: "#1B48D6" },
  down: { fill: "#A62B21", stroke: "#A62B21", width: 1, wick: "#A62B21" },
  ma20: { color: "#12233F", width: 2 },
  ma50: { color: "#5A616C", width: 2 },
  ma200: { color: "#A8A79E", width: 2, dash: "8 5" },
  vwap: { color: "#8A6512", width: 2, dash: "2 4", round: true },
  stop: { color: "#A62B21", width: 2, dash: "8 5" },
  target: { color: "#8A6512", width: 2, dash: "8 5" },
  resistance: { color: "#A62B21", width: 1.5 },
  support: { color: "#0B6042", width: 1.5 },
  alert: { color: "#5A616C", width: 1.5 },
  invalidate: { color: "#A62B21", width: 2, dash: "2 4", round: true },
  zone: { fill: "#F4F7FF", label: "#1B48D6" },
  current: { line: { color: "#A8A79E", width: 1 }, color: "#12233F" },
  profile: { fill: "#E7E3D7", max: 96 },
  rsi: { color: "#12233F", width: 1.5 },
  rsiBand: { color: "#D9D3C4", width: 1, dash: "4 4" },
  macd: { up: "#1B48D6", down: "#A62B21", zero: { color: "#D9D3C4", width: 1 } },
  leader: { color: "#D9D3C4", width: 1 },
};

export interface ChartLayout {
  width: number;
  /** the main panel's height, its date row included */
  mainH: number;
  gap: number;
  rsiH: number;
  /** 0: no MACD panel */
  macdH: number;
  /** the price-tick column on the left; the label column on the right is at least `right`, and widens to the widest label
   * the chart draws + 10, up to `rightMax` (DD 2145): two-digit dollar charts keep `right`, three-digit and won charts
   * get the room their prices need, and past `rightMax` a price gives way to its word (label_price_dropped) */
  left: number;
  /** the left column widens the same way to the widest price tick + 8, up to `leftMax`; past it the tick numbers are left
   * out (the grid lines stay), so a tick is never drawn clipped ("250,000" cut to "0,000") */
  leftMax: number;
  right: number;
  rightMax: number;
  /** trading days drawn */
  days: number;
  profile: boolean;
  minGap: number;
  /** date ticks at month starts: "month" → 11월 (app), "md" → 11/3 (deck) */
  dates: "month" | "md";
  /** the deck's caption row (unit · as of · source, FA4 #8); the renderer refuses to draw without them */
  caption: boolean;
}

/** the phone card: 326 wide at 390 (the card's inner width), 200 + 8 + 56 = 264 high, 60 days, plot 194 (166 at the
 * widest label column) */
export const PHONE_CARD: ChartLayout = { width: 326, mainH: 200, gap: 8, rsiH: 56, macdH: 0, left: 32, leftMax: 72, right: 100, rightMax: 128, days: 60, profile: false, minGap: 18, dates: "month", caption: false };
/** the full-view sheet: 358 × 420 with all six elements */
export const FULL_VIEW: ChartLayout = { width: 358, mainH: 292, gap: 8, rsiH: 56, macdH: 56, left: 32, leftMax: 72, right: 100, rightMax: 128, days: 60, profile: true, minGap: 18, dates: "month", caption: false };
/** the deck's level-chart slide: 1152 × 400 */
export const DECK_CHART: ChartLayout = { width: 1152, mainH: 248, gap: 12, rsiH: 64, macdH: 64, left: 48, leftMax: 96, right: 120, rightMax: 160, days: 60, profile: true, minGap: 24, dates: "md", caption: true };

export interface LevelChartInput {
  /** oldest first; MA200 needs `days` + 199 bars to cover the window */
  bars: readonly Bar[];
  levels: readonly ChartLevel[];
  /** the current price (default: the last close) */
  current?: number;
  /** the screen reader's sentence, written by the server (DD 1935 §2-5) */
  summary: string;
  /** the caption row (deck): unit, basis and source */
  unit?: string;
  asOf?: string;
  source?: string;
  /** price digits on labels and ticks (default 2; 0 for won) */
  digits?: number;
  /** KRW: the price ticks go in 만 when they can (format.ts wonTicks, DD 2228-b); labels stay exact */
  currency?: "USD" | "KRW";
}

/** level_invalid: a level whose price is not a finite number is left out (its row says 확인 불가), never drawn at NaN */
export type ChartIssue = { code: "label_dropped" | "level_offscale" | "label_price_dropped" | "level_invalid"; kind: LevelKind | "current"; price: number };

export interface LevelChart {
  svg: string;
  width: number;
  height: number;
  issues: ChartIssue[];
  /** the plot box of the main panel */
  plot: { x0: number; x1: number; y0: number; y1: number };
  /** for a crosshair (full view): each drawn bar's centre x and day, and the price range the plot box spans */
  bars: { x: number; t: string }[];
  range: { lo: number; hi: number };
}

const f1 = (x: number) => (Math.round(x * 10) / 10).toString();
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const stroke = (s: Stroke) =>
  `stroke="${s.color}" stroke-width="${s.width}"${s.dash ? ` stroke-dasharray="${s.dash}"` : ""}${s.round ? ' stroke-linecap="round"' : ""}`;

/**
 * Per-character widths in em for the fonts the app's --font-text lands on, rounded up. The Apple row is measured
 * (getComputedTextLength in Chrome and WebKit on macOS, 13 px at 400/600 and 15 px at 400/700, the widest of them). The
 * other row is Android's Roboto + Noto Sans CJK KR (and Windows' Segoe UI + Malgun Gothic), from their font metrics,
 * not measured on a device: full-width Hangul and arrows, narrower digits. The two fonts are wide in different places
 * (Apple's digits, Noto's Hangul), so a label is checked against each font's own sum, never the sum of the worst cases.
 */
const FONT_EM = [
  { hangul: 0.87, digit: 0.66, latin: 0.8, dot: 0.34, space: 0.28, paren: 0.42, arrow: 0.81, pct: 1.03, other: 1 },
  { hangul: 1, digit: 0.6, latin: 0.8, dot: 0.3, space: 0.26, paren: 0.36, arrow: 1, pct: 0.9, other: 1 },
] as const;

/** a character's class in FONT_EM */
function charClass(ch: string): keyof (typeof FONT_EM)[number] {
  if (/[ㄱ-ㆎ가-힣]/.test(ch)) return "hangul";
  if (/[0-9$+\u2212-]/.test(ch)) return "digit";
  if (/[A-Za-z]/.test(ch)) return "latin";
  if (/[.,:·]/.test(ch)) return "dot";
  if (ch === " ") return "space";
  if (/[()]/.test(ch)) return "paren";
  if (/[←-⇿]/.test(ch)) return "arrow";
  if (ch === "%") return "pct";
  return "other";
}

/** an upper bound of a label's width in em: the widest of the fonts' sums (FONT_EM) */
export function labelEm(text: string): number {
  return Math.max(...FONT_EM.map((f) => [...text].reduce((w, ch) => w + f[charClass(ch)], 0)));
}

/** grid steps: 1, 2, 2.5, 5 × 10^k, the smallest giving at most `most` lines inside [lo, hi] */
export function niceTicks(lo: number, hi: number, most = 4): number[] {
  const span = hi - lo;
  if (!(span > 0)) return [];
  const base = 10 ** Math.floor(Math.log10(span / most));
  for (const m of [1, 2, 2.5, 5, 10, 20]) {
    const step = base * m;
    const first = Math.ceil(lo / step - 1e-9) * step;
    const ticks: number[] = [];
    for (let t = first; t <= hi + 1e-9; t += step) ticks.push(Math.round(t / step) * step);
    if (ticks.length <= most) return ticks;
  }
  return [];
}

/**
 * Places labels on a line, each as near its wanted y as it can be, at least `gap` apart, inside [top, bottom]: the
 * least-squares answer (pool-adjacent-violators on y − i·gap, then clamped). `wanted` must be sorted ascending.
 */
export function stack(wanted: readonly number[], gap: number, top: number, bottom: number): number[] {
  const n = wanted.length;
  if (!n) return [];
  const z = wanted.map((y, i) => y - i * gap);
  const blocks: { sum: number; n: number }[] = [];
  for (const v of z) {
    blocks.push({ sum: v, n: 1 });
    while (blocks.length > 1 && blocks.at(-2)!.sum / blocks.at(-2)!.n > blocks.at(-1)!.sum / blocks.at(-1)!.n) {
      const b = blocks.pop()!;
      blocks.at(-1)!.sum += b.sum;
      blocks.at(-1)!.n += b.n;
    }
  }
  const lo = top;
  const hi = bottom - (n - 1) * gap;
  const out: number[] = [];
  for (const b of blocks) for (let k = 0; k < b.n; k++) out.push(Math.min(hi, Math.max(lo, b.sum / b.n)));
  return out.map((v, i) => v + i * gap);
}

/** a polyline through the present values, a new segment after each gap */
function path(xs: readonly number[], ys: readonly Num[], y: (p: number) => number): string {
  let d = "";
  let pen = false;
  ys.forEach((v, i) => {
    if (v == null) return void (pen = false);
    d += `${pen ? "L" : "M"}${f1(xs[i]!)},${f1(y(v))}`;
    pen = true;
  });
  return d;
}

export function levelChart(input: LevelChartInput, theme: ChartTheme, layout: ChartLayout = PHONE_CARD): LevelChart {
  const { bars } = input;
  const issues: ChartIssue[] = [];
  const bad = bars.find((b) => ![b.o, b.h, b.l, b.c, b.v].every(Number.isFinite));
  if (bad) throw new Error(`levelChart: a bar with a price or volume that is not a number (${bad.t})`);
  const levels = input.levels.filter((lv) => {
    const ok = Number.isFinite(lv.price) && (lv.hi == null || Number.isFinite(lv.hi));
    if (!ok) issues.push({ code: "level_invalid", kind: lv.kind, price: lv.price });
    return ok;
  });
  const digits = input.digits ?? 2;
  if (layout.caption && !(input.unit && input.asOf && input.source)) throw new Error("levelChart: the deck chart needs unit, asOf and source");
  const show = bars.slice(-layout.days);
  if (show.length < 2) throw new Error("levelChart: at least two bars");
  const start = bars.length - show.length;
  const current = input.current ?? show.at(-1)!.c;
  if (!Number.isFinite(current)) throw new Error("levelChart: the current price is not a number");
  const W = layout.width;
  const H = layout.mainH + layout.gap + layout.rsiH + (layout.macdH ? layout.gap + layout.macdH : 0);
  const capH = layout.caption ? theme.tick.size + 10 : 0;
  const dateH = theme.tick.size + 6;
  // the plot's right edge waits for the label column's width (below); the vertical scale does not depend on it
  const plot = { x0: layout.left, x1: W - layout.right, y0: 8 + capH, y1: layout.mainH - dateH };
  const plotH = plot.y1 - plot.y0;

  // ── vertical range: the candles, then each level nearest-first while the candles keep ≥ 50 % of the plot ──
  const cl = Math.min(...show.map((b) => b.l), current);
  const ch = Math.max(...show.map((b) => b.h), current);
  let lo = cl;
  let hi = ch;
  const off = new Set<ChartLevel>();
  const outside = levels
    .map((lv) => ({ lv, top: Math.max(lv.price, lv.hi ?? lv.price), bot: Math.min(lv.price, lv.hi ?? lv.price) }))
    .map((e) => ({ ...e, need: Math.max(e.top - ch, cl - e.bot, 0) }))
    .sort((a, b) => a.need - b.need);
  const blocked = { up: false, down: false };
  for (const e of outside) {
    const up = e.top > ch;
    const side = up ? "up" : "down";
    const nlo = Math.min(lo, e.bot);
    const nhi = Math.max(hi, e.top);
    if (blocked[side] || (ch - cl) / (nhi - nlo) < 0.5) {
      if (e.need > 0) {
        off.add(e.lv);
        blocked[side] = true;
        continue;
      }
    }
    lo = nlo;
    hi = nhi;
  }
  const margin = (hi - lo) * 0.05 || Math.abs(hi) * 0.01 || 1;
  lo -= margin;
  hi += margin;
  const y = (p: number) => plot.y0 + (1 - (p - lo) / (hi - lo)) * plotH;

  // labels in the right column: which are drawn (priority, slots) does not depend on the column's width, so they are
  // chosen first, the column is sized to the widest of them, and only then does a price that still does not fit give way
  const look = (k: LevelKind): Stroke =>
    k === "stop" ? theme.stop : k === "resistance" ? theme.resistance : k === "support" ? theme.support : k === "alert" ? theme.alert : k === "invalidate" ? theme.invalidate : theme.target;
  const size = theme.label.size;
  const colour = (k: LevelKind | "current") => (k === "current" ? theme.current.color : k === "buyZone" ? theme.zone.label : look(k).color);
  const rank = (k: LevelKind | "current") => LABEL_PRIORITY.indexOf(k);
  type Lab = { kind: LevelKind | "current"; price: number; want: number; word: string; withPrice: boolean; arrow?: "↑" | "↓" };
  const labs: Lab[] = [];
  labs.push({ kind: "current", price: current, want: y(current), word: "", withPrice: true });
  for (const lv of levels) {
    const word = LEVEL_WORD[lv.kind];
    if (off.has(lv)) {
      const up = Math.max(lv.price, lv.hi ?? lv.price) > ch;
      issues.push({ code: "level_offscale", kind: lv.kind, price: lv.price });
      labs.push({ kind: lv.kind, price: lv.price, want: up ? -Infinity : Infinity, word, withPrice: false, arrow: up ? "↑" : "↓" });
      continue;
    }
    const mid = lv.kind === "buyZone" ? (lv.price + (lv.hi ?? lv.price)) / 2 : lv.price;
    labs.push({ kind: lv.kind, price: lv.price, want: y(mid), word, withPrice: lv.kind !== "buyZone" });
  }
  const top = plot.y0 + size / 2;
  const bottom = plot.y1 - size / 2;
  const slots = Math.floor((bottom - top) / layout.minGap) + 1;
  const kept = [...labs].sort((a, b) => rank(a.kind) - rank(b.kind) || a.want - b.want);
  for (const d of kept.splice(slots)) issues.push({ code: "label_dropped", kind: d.kind, price: d.price });
  kept.sort((a, b) => a.want - b.want);
  const full = (l: Lab) => (l.arrow ? `${l.word} ${l.arrow}` : l.kind === "current" ? num(l.price, digits) : l.withPrice ? `${l.word} ${num(l.price, digits)}` : l.word);
  const widest = Math.max(0, ...kept.map((l) => labelEm(full(l)) * size));
  const right = Math.min(layout.rightMax, Math.max(layout.right, Math.ceil(widest + 10)));
  const room = right - 10;
  for (const l of kept) {
    if (!l.withPrice || l.kind === "current" || labelEm(full(l)) * size <= room) continue;
    l.withPrice = false;
    issues.push({ code: "label_price_dropped", kind: l.kind, price: l.price });
  }
  plot.x1 = W - right;

  // the price ticks: the left column fits their widest number, or they go
  const steps = niceTicks(lo, hi, 4);
  const words = input.currency === "KRW" ? wonTicks(steps) : steps.map((t) => num(t, Number.isInteger(t) ? 0 : 1));
  const ticks = steps.map((t, i) => ({ t, label: words[i]! }));
  const widestTick = Math.max(0, ...ticks.map((k) => labelEm(k.label) * theme.tick.size));
  const left = Math.min(layout.leftMax, Math.max(layout.left, Math.ceil(widestTick + 8)));
  const tickNumbers = widestTick + 8 <= left;
  plot.x0 = left;

  const slot = (plot.x1 - plot.x0) / show.length;
  const xs = show.map((_, i) => plot.x0 + slot * (i + 0.5));
  const body = Math.max(2, Math.floor(slot * 0.6));

  const s: string[] = [];
  s.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(input.summary)}" style="font-family:${theme.font};font-variant-numeric:tabular-nums">`);
  const text = (x: number, yy: number, str: string, color: string, size: number, extra = "") =>
    `<text x="${f1(x)}" y="${f1(yy + size * 0.35)}" font-size="${size}" fill="${color}"${extra}>${esc(str)}</text>`;

  // caption (deck): unit · basis · source, top left of the plot
  if (layout.caption) s.push(text(plot.x0, 8 + theme.tick.size / 2, `${input.unit} · ${input.asOf} · ${input.source}`, theme.tick.color, theme.tick.size, ' data-role="caption"'));

  // grid and price ticks
  for (const { t, label } of ticks) {
    const ty = y(t);
    s.push(`<line x1="${plot.x0}" x2="${plot.x1}" y1="${f1(ty)}" y2="${f1(ty)}" ${stroke(theme.grid)} data-role="grid"/>`);
    if (tickNumbers) s.push(text(plot.x0 - 6, ty, label, theme.tick.color, theme.tick.size, ' text-anchor="end" data-role="tick"'));
  }

  // date ticks at month starts
  show.forEach((b, i) => {
    if (i === 0 || b.t.slice(0, 7) === show[i - 1]!.t.slice(0, 7)) return;
    const [, m, d] = b.t.split("-").map(Number) as [number, number, number];
    s.push(text(xs[i]!, layout.mainH - dateH / 2, layout.dates === "month" ? `${m}월` : `${m}/${d}`, theme.tick.color, theme.tick.size, ' text-anchor="middle" data-role="date"'));
  });

  // buy-review band (under everything else)
  const zone = levels.find((l) => l.kind === "buyZone" && !off.has(l));
  if (zone) {
    const a = y(Math.max(zone.price, zone.hi ?? zone.price));
    const b = y(Math.min(zone.price, zone.hi ?? zone.price));
    s.push(`<rect x="${plot.x0}" y="${f1(a)}" width="${f1(plot.x1 - plot.x0)}" height="${f1(Math.max(1, b - a))}" fill="${theme.zone.fill}" data-level="buyZone"/>`);
  }

  // volume profile: the three largest nodes, from the plot's right edge leftwards, under the candles
  if (layout.profile) {
    const vp = volumeProfile(bars, { days: Math.min(120, bars.length) });
    if (vp) {
      const max = vp.top[0]?.volume || 1;
      for (const bin of vp.top) {
        const a = Math.max(plot.y0, y(bin.hi));
        const b = Math.min(plot.y1, y(bin.lo));
        if (b - a < 0.5) continue;
        const w = (bin.volume / max) * theme.profile.max;
        s.push(`<rect x="${f1(plot.x1 - w)}" y="${f1(a)}" width="${f1(w)}" height="${f1(b - a)}" fill="${theme.profile.fill}" data-role="profile"/>`);
      }
    }
  }

  // moving averages and VWAP
  const close = bars.map((b) => b.c);
  const cut = (xs: Num[]) => xs.slice(start);
  for (const [k, ys] of [
    ["ma200", cut(sma(close, 200))],
    ["ma50", cut(sma(close, 50))],
    ["ma20", cut(sma(close, 20))],
    ["vwap", cut(vwap(bars, 60))],
  ] as const) {
    const d = path(xs, ys, y);
    if (d) s.push(`<path d="${d}" fill="none" ${stroke(theme[k])} data-role="${k}"/>`);
  }

  // candles
  show.forEach((b, i) => {
    const up = b.c >= b.o;
    const st = up ? theme.up : theme.down;
    const x = xs[i]!;
    s.push(`<line x1="${f1(x)}" x2="${f1(x)}" y1="${f1(y(b.h))}" y2="${f1(y(b.l))}" stroke="${st.wick}" stroke-width="1"/>`);
    const top = y(Math.max(b.o, b.c));
    const h = Math.max(1, y(Math.min(b.o, b.c)) - top);
    s.push(`<rect x="${f1(x - body / 2)}" y="${f1(top)}" width="${body}" height="${f1(h)}" fill="${st.fill}"${st.width ? ` stroke="${st.stroke}" stroke-width="${st.width}"` : ""} data-role="candle"/>`);
  });

  // current price line
  s.push(`<line x1="${plot.x0}" x2="${plot.x1}" y1="${f1(y(current))}" y2="${f1(y(current))}" ${stroke(theme.current.line)} data-role="current"/>`);

  // level lines (never outside the plot box: off-scale levels have none)
  for (const lv of levels) {
    if (lv.kind === "buyZone" || off.has(lv)) continue;
    const ly = y(lv.price);
    s.push(`<line x1="${plot.x0}" x2="${plot.x1}" y1="${f1(ly)}" y2="${f1(ly)}" ${stroke(look(lv.kind))} data-level="${lv.kind}"/>`);
  }

  // the labels, stacked and drawn
  const placed = stack(
    kept.map((l) => (l.want === -Infinity ? top : l.want === Infinity ? bottom : l.want)),
    layout.minGap,
    top,
    bottom,
  );
  const lx = plot.x1 + 10;
  kept.forEach((l, i) => {
    const py = placed[i]!;
    const extra = ` data-label="${l.kind}"`;
    if (l.arrow) return void s.push(text(lx, py, `${l.word} ${l.arrow}`, colour(l.kind), size, ` font-weight="${theme.label.weight}"${extra}`));
    if (Math.abs(py - l.want) > 1.5)
      s.push(`<path d="M${plot.x1},${f1(l.want)} L${plot.x1 + 4},${f1(l.want)} L${plot.x1 + 8},${f1(py)}" fill="none" ${stroke(theme.leader)} data-role="leader"/>`);
    if (l.kind === "current") return void s.push(text(lx, py, num(l.price, digits), colour(l.kind), size, ` font-weight="${theme.label.weight}"${extra}`));
    const price = l.withPrice ? ` ${num(l.price, digits)}` : "";
    s.push(
      `<text x="${f1(lx)}" y="${f1(py + size * 0.35)}" font-size="${size}" fill="${colour(l.kind)}"${extra}><tspan font-weight="${theme.label.weight}">${esc(l.word)}</tspan>${esc(price)}</text>`,
    );
  });

  // RSI panel
  const r = rsi(close);
  const ry0 = layout.mainH + layout.gap;
  const ry = (v: number) => ry0 + 4 + (1 - v / 100) * (layout.rsiH - 8);
  for (const g of [30, 70]) {
    s.push(`<line x1="${plot.x0}" x2="${plot.x1}" y1="${f1(ry(g))}" y2="${f1(ry(g))}" ${stroke(theme.rsiBand)} data-role="rsi-band"/>`);
    s.push(text(plot.x0 - 6, ry(g), String(g), theme.tick.color, theme.tick.size, ' text-anchor="end"'));
  }
  const rs = cut(r);
  const rd = path(xs, rs, ry);
  if (rd) s.push(`<path d="${rd}" fill="none" ${stroke(theme.rsi)} data-role="rsi"/>`);
  const rLast = rs.at(-1);
  s.push(text(plot.x1 + 8, ry(rLast ?? 50), rLast == null ? "RSI" : `RSI ${Math.round(rLast)}`, theme.tick.color, theme.tick.size, ' data-role="rsi-label"'));

  // MACD histogram panel (full view, deck): the sign shows by position around the zero line
  if (layout.macdH) {
    const hist = cut(macd(close).hist);
    const my0 = ry0 + layout.rsiH + layout.gap;
    const vals = hist.filter((v): v is number => v != null);
    const amp = Math.max(...vals.map(Math.abs), 1e-9);
    const zero = my0 + layout.macdH / 2;
    const scale = (layout.macdH / 2 - 4) / amp;
    s.push(`<line x1="${plot.x0}" x2="${plot.x1}" y1="${f1(zero)}" y2="${f1(zero)}" ${stroke(theme.macd.zero)} data-role="macd-zero"/>`);
    hist.forEach((v, i) => {
      if (v == null || v === 0) return;
      const hgt = Math.abs(v) * scale;
      s.push(`<rect x="${f1(xs[i]! - body / 2)}" y="${f1(v > 0 ? zero - hgt : zero)}" width="${body}" height="${f1(Math.max(0.5, hgt))}" fill="${v > 0 ? theme.macd.up : theme.macd.down}" data-role="macd"/>`);
    });
    s.push(text(plot.x1 + 8, zero, "MACD", theme.tick.color, theme.tick.size, ' data-role="macd-label"'));
  }

  s.push("</svg>");
  return { svg: s.join(""), width: W, height: H, issues, plot, bars: show.map((b, i) => ({ x: xs[i]!, t: b.t })), range: { lo, hi } };
}
