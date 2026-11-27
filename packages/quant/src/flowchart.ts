/**
 * The flow chart (FA5 #5, DD 1935 §5-2 flows): foreigners', institutions' and individuals' daily net buying as stacked
 * bars, buying above the zero line and selling below it, and the program non-arbitrage net buying as a line on its own
 * axis on the right. Both axes put zero on the same line, so the line's sign reads against the bars'. Units are 억원 as
 * the source gives them; the numbers are the code's (§0-5 formatter), the words around them the caller's.
 *
 * A missing figure (null) is left out of its day's stack and named in `issues`; a figure that is not a number at all
 * (NaN, Infinity) refuses the chart, as levelChart does.
 *
 * DD 0126 §3: the individuals' fill is pale on either paper, so their cell (and legend swatch) takes a 1px inside edge
 * in the institutions' colour, and the cells of a stack stand 1px apart on the paper's colour (the line's halo).
 */
import { niceTicks } from "./chart";
import { esc, f1, strokeAttr, textAt, textW, type BoardIssue, type BoardTheme } from "./board";
import { num } from "./format";
import type { Num } from "./types";

export interface FlowDay {
  /** YYYY-MM-DD */
  t: string;
  foreign: Num;
  institution: Num;
  individual: Num;
  /** program non-arbitrage net buying (undefined: the chart has no line) */
  nonArb?: Num;
}

export interface FlowChartInput {
  days: readonly FlowDay[];
  /** the screen reader's sentence, written by the server */
  summary: string;
  /** the caption (deck; FA4 #8): unit · as of · source */
  unit?: string;
  asOf?: string;
  source?: string;
}

export interface FlowLayout {
  width: number;
  height: number;
  /** trading days drawn (the newest) */
  days: number;
  /** the left tick column at least (it widens to its widest number + 8) */
  left: number;
  /** the right tick column at least (the line's axis) */
  right: number;
  /** a caption row above the legend (deck) */
  caption: boolean;
}

/** the deck's flows slide: the left 8 columns of the 12 (8 × 74 + 7 × 24 = 760) over the body (y 240–656) */
export const DECK_FLOWS: FlowLayout = { width: 760, height: 416, days: 20, left: 56, right: 56, caption: true };
/** a phone card: 326 wide (the card's inner width at 390), 20 days */
export const PHONE_FLOWS: FlowLayout = { width: 326, height: 220, days: 20, left: 40, right: 40, caption: false };

export const FLOW_WHO = [
  ["foreign", "외국인"],
  ["institution", "기관"],
  ["individual", "개인"],
] as const;
export const NONARB_WORD = "비차익";
/** the paper between two cells of a stack (DD 0126 §3) */
export const STACK_GAP = 1;

export interface FlowChart {
  svg: string;
  width: number;
  height: number;
  issues: BoardIssue[];
  plot: { x0: number; x1: number; y0: number; y1: number };
  /** the zero line's y, shared by both axes */
  zeroY: number;
}

/**
 * The share of the plot above zero that fits both sets (bars: their stacks; line: its values), the one of their own
 * shares that leaves the less-used set best used. Each set is (above, below) ≥ 0.
 */
function zeroShare(sets: readonly { up: number; down: number }[]): number {
  const live = sets.filter((s) => s.up + s.down > 0);
  if (!live.length) return 0.5;
  const use = (a: number) =>
    Math.min(
      ...live.map((s) => {
        const span = Math.max(a > 0 ? s.up / a : s.up > 0 ? Infinity : 0, a < 1 ? s.down / (1 - a) : s.down > 0 ? Infinity : 0);
        return span > 0 && Number.isFinite(span) ? (s.up + s.down) / span : 0;
      }),
    );
  const options = live.map((s) => s.up / (s.up + s.down));
  return options.reduce((best, a) => (use(a) > use(best) ? a : best), options[0]!);
}

export function flowChart(input: FlowChartInput, theme: BoardTheme, layout: FlowLayout = PHONE_FLOWS): FlowChart {
  const bad = input.days.find((d) => [d.foreign, d.institution, d.individual, d.nonArb].some((v) => v != null && !Number.isFinite(v)));
  if (bad) throw new Error(`flowChart: a figure that is not a number (${bad.t})`);
  if (layout.caption && !(input.unit && input.asOf && input.source)) throw new Error("flowChart: the deck chart needs unit, asOf and source");
  const days = input.days.slice(-layout.days);
  if (days.length < 2) throw new Error("flowChart: at least two days");
  const issues: BoardIssue[] = [];
  const hasLine = days.some((d) => d.nonArb !== undefined);
  for (const d of days) {
    for (const [k, word] of FLOW_WHO) if (d[k] == null) issues.push({ code: "flow_missing", t: d.t, who: word });
    if (hasLine && d.nonArb == null) issues.push({ code: "nonarb_missing", t: d.t });
  }

  // the stacks: buying from zero upward, selling from zero downward, in FLOW_WHO order
  const stacks = days.map((d) => {
    let up = 0;
    let down = 0;
    return FLOW_WHO.map(([k]) => {
      const v = d[k];
      if (v == null || v === 0) return null;
      const from = v > 0 ? up : down;
      if (v > 0) up += v;
      else down += v;
      return { k, from, to: from + v };
    }).filter((s): s is { k: (typeof FLOW_WHO)[number][0]; from: number; to: number } => s != null);
  });
  const barUp = Math.max(0, ...stacks.map((s) => Math.max(0, ...s.map((x) => x.to))));
  const barDown = Math.max(0, ...stacks.map((s) => Math.max(0, ...s.map((x) => -x.to))));
  const line = days.map((d) => (d.nonArb == null ? null : d.nonArb));
  const lineVals = line.filter((v): v is number => v != null);
  const lineUp = Math.max(0, ...lineVals);
  const lineDown = Math.max(0, ...lineVals.map((v) => -v));
  const a = zeroShare([{ up: barUp, down: barDown }, ...(lineVals.length ? [{ up: lineUp, down: lineDown }] : [])]);
  // each set's range around the shared zero, with a little headroom; an empty set gets a unit range
  const range = (up: number, down: number) => {
    const span = Math.max(a > 0 ? up / a : 0, a < 1 ? down / (1 - a) : 0) * 1.08 || 1;
    return { lo: -span * (1 - a), hi: span * a };
  };
  const bars = range(barUp, barDown);
  const lineR = range(lineUp, lineDown);

  const W = layout.width;
  const H = layout.height;
  const T = theme.size.tick;
  const rowH = Math.round(T * 1.6);
  // the legend: a swatch and a word per series, the line's word saying which axis is its; a series that does not fit on
  // the row starts the next one
  const sw = Math.round(T * 0.8);
  const legendItems = [
    ...FLOW_WHO.map(([k, word]) => ({ word, swatch: "box" as const, k, w: sw + 6 + textW(word, T) })),
    ...(lineVals.length ? [{ word: `${NONARB_WORD}(오른쪽 축)`, swatch: "line" as const, k: "line" as const, w: 24 + textW(`${NONARB_WORD}(오른쪽 축)`, T) }] : []),
  ];
  const legendRows: (typeof legendItems)[] = [[]];
  let rowW = 0;
  for (const it of legendItems) {
    if (rowW > 0 && rowW + it.w > W) {
      legendRows.push([]);
      rowW = 0;
    }
    legendRows.at(-1)!.push(it);
    rowW += it.w + 16;
  }
  const top = (layout.caption ? rowH : 0) + legendRows.length * rowH + 6; // caption row, legend rows
  const bottom = H - rowH; // the date row

  // tick columns fit their widest number (as levelChart's)
  const leftTicks = niceTicks(bars.lo, bars.hi, 5).map((t) => ({ t, label: num(t, 0) }));
  const rightTicks = lineVals.length ? niceTicks(lineR.lo, lineR.hi, 5).map((t) => ({ t, label: num(t, 0) })) : [];
  const left = Math.max(layout.left, Math.ceil(Math.max(0, ...leftTicks.map((k) => textW(k.label, T))) + 8));
  const right = lineVals.length ? Math.max(layout.right, Math.ceil(Math.max(0, ...rightTicks.map((k) => textW(k.label, T))) + 8)) : 8;
  const plot = { x0: left, x1: W - right, y0: top, y1: bottom - 4 };
  const yOf = (r: { lo: number; hi: number }) => (v: number) => plot.y1 - ((v - r.lo) / (r.hi - r.lo)) * (plot.y1 - plot.y0);
  const yb = yOf(bars);
  const yl = yOf(lineR);
  const zeroY = yb(0);

  const n = days.length;
  const slot = (plot.x1 - plot.x0) / n;
  const xs = days.map((_, i) => plot.x0 + slot * (i + 0.5));
  const bw = Math.max(2, Math.floor(slot * 0.6));

  // the individuals' edge: 1px inside the cell (the rect inset by half a pixel, stroked 1)
  const edge = `stroke="${theme.flows.institution}" stroke-width="1"`;
  const s: string[] = [];
  s.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(input.summary)}" style="font-family:${theme.font};font-variant-numeric:tabular-nums">`);
  let y = 0;
  if (layout.caption) {
    s.push(textAt(0, rowH / 2, `${input.unit} · ${input.asOf} · ${input.source}`, theme.mute, T, ' data-role="caption"'));
    y = rowH;
  }
  for (const row of legendRows) {
    let lx = 0;
    const my = y + rowH / 2;
    for (const it of row) {
      if (it.swatch === "box") {
        const k = it.k as (typeof FLOW_WHO)[number][0];
        s.push(
          k === "individual"
            ? `<rect x="${f1(lx + 0.5)}" y="${f1(my - sw / 2 + 0.5)}" width="${sw - 1}" height="${sw - 1}" rx="1.5" fill="${theme.flows[k]}" ${edge} data-role="legend-swatch"/>`
            : `<rect x="${f1(lx)}" y="${f1(my - sw / 2)}" width="${sw}" height="${sw}" rx="2" fill="${theme.flows[k]}" data-role="legend-swatch"/>`,
        );
        s.push(textAt(lx + sw + 6, my, it.word, theme.ink2, T, ' data-role="legend"'));
      } else {
        s.push(`<line x1="${f1(lx)}" x2="${f1(lx + 18)}" y1="${f1(my)}" y2="${f1(my)}" ${strokeAttr(theme.flows.line)} data-role="legend-swatch"/>`);
        s.push(textAt(lx + 24, my, it.word, theme.ink2, T, ' data-role="legend"'));
      }
      lx += it.w + 16;
    }
    y += rowH;
  }

  // grid and ticks: the bars' axis on the left; the line's numbers on the right, without lines of their own
  for (const k of leftTicks) {
    const ty = yb(k.t);
    if (k.t !== 0) s.push(`<line x1="${plot.x0}" x2="${plot.x1}" y1="${f1(ty)}" y2="${f1(ty)}" ${strokeAttr(theme.grid)} data-role="grid"/>`);
    s.push(textAt(plot.x0 - 6, ty, k.label, theme.mute, T, ' text-anchor="end" data-role="tick"'));
  }
  for (const k of rightTicks) s.push(textAt(plot.x1 + 6, yl(k.t), k.label, theme.mute, T, ' data-role="tick-right"'));

  // the bars: a cell that sits on another starts STACK_GAP further from zero, so the paper shows between them; a cell
  // thinner than that keeps a half-pixel sliver at its far end
  days.forEach((d, i) => {
    for (const seg of stacks[i]!) {
      // on the 0.1px grid the SVG is written in, so the gap survives the rounding
      const far = Math.round(yb(seg.to) * 10) / 10;
      let near = Math.round(yb(seg.from) * 10) / 10;
      const dir = Math.sign(far - near); // the screen direction away from zero
      if (seg.from !== 0) near += dir * STACK_GAP;
      const len = Math.max(0.5, (far - near) * dir);
      const top = dir > 0 ? far - len : far;
      const x = xs[i]! - bw / 2;
      const who = `data-role="flow-bar" data-who="${seg.k}" data-t="${d.t}"`;
      const fill = `fill="${theme.flows[seg.k]}"`;
      if (seg.k !== "individual") s.push(`<rect x="${f1(x)}" y="${f1(top)}" width="${bw}" height="${f1(len)}" ${fill} ${who}/>`);
      else if (len >= 2 && bw >= 2) s.push(`<rect x="${f1(x + 0.5)}" y="${f1(top + 0.5)}" width="${f1(bw - 1)}" height="${f1(len - 1)}" ${fill} ${edge} ${who}/>`);
      else s.push(`<rect x="${f1(x)}" y="${f1(top)}" width="${bw}" height="${f1(len)}" ${fill} ${edge} ${who}/>`);
    }
  });
  s.push(`<line x1="${plot.x0}" x2="${plot.x1}" y1="${f1(zeroY)}" y2="${f1(zeroY)}" ${strokeAttr(theme.flows.zero)} data-role="zero"/>`);

  // the line, a new segment after each missing day, with a dot per day
  if (lineVals.length) {
    let d = "";
    let pen = false;
    line.forEach((v, i) => {
      if (v == null) return void (pen = false);
      d += `${pen ? "L" : "M"}${f1(xs[i]!)},${f1(yl(v))}`;
      pen = true;
    });
    const halo = theme.flows.line.width + 3;
    s.push(`<path d="${d}" fill="none" stroke="${theme.flows.halo}" stroke-width="${halo}" stroke-linecap="round" stroke-linejoin="round" data-role="nonarb-halo"/>`);
    line.forEach((v, i) => {
      if (v != null) s.push(`<circle cx="${f1(xs[i]!)}" cy="${f1(yl(v))}" r="${theme.flows.dot + 1.5}" fill="${theme.flows.halo}"/>`);
    });
    s.push(`<path d="${d}" fill="none" ${strokeAttr({ ...theme.flows.line, round: true })} stroke-linejoin="round" data-role="nonarb"/>`);
    line.forEach((v, i) => {
      if (v != null) s.push(`<circle cx="${f1(xs[i]!)}" cy="${f1(yl(v))}" r="${theme.flows.dot}" fill="${theme.flows.line.color}" data-role="nonarb-dot"/>`);
    });
  }

  // dates: the first, the last, and every fifth between, far enough apart (11/24)
  const md = (t: string) => `${Number(t.slice(5, 7))}/${Number(t.slice(8, 10))}`;
  const wantDates = new Set([0, n - 1]);
  for (let i = 5; i < n - 1; i += 5) wantDates.add(i);
  const placed = [...wantDates]
    .sort((p, q) => p - q)
    .map((i) => {
      const label = md(days[i]!.t);
      const w = textW(label, T);
      return { label, w, x: Math.min(W - w / 2, Math.max(w / 2, xs[i]!)) };
    });
  // the first and the last always; a date between gives way when it comes within 8px of a kept one
  const first = placed[0]!;
  const last = placed.at(-1)!;
  const kept = [first];
  for (const p of placed.slice(1, -1)) {
    const prev = kept.at(-1)!;
    if (p.x - p.w / 2 >= prev.x + prev.w / 2 + 8 && p.x + p.w / 2 <= last.x - last.w / 2 - 8) kept.push(p);
  }
  kept.push(last);
  for (const p of kept) s.push(textAt(p.x, bottom + rowH / 2, p.label, theme.mute, T, ' text-anchor="middle" data-role="date"'));
  s.push("</svg>");
  return { svg: s.join(""), width: W, height: H, issues, plot, zeroY };
}
