/**
 * The shared ground of the board renderers (PLAN §3-A "SVG 차트 렌더러": n/8 gauges, the flow chart, the 11-indicator grid,
 * the event timeline): their theme, and text measured before it is drawn. Like levelChart they return SVG strings, take
 * a theme (the app passes CSS variables, the deck FA3 hex; DD 1935 §4), and never draw a text that does not fit: a text
 * that is cut is reported as an issue, so the deck's checks refuse the slide instead of printing it clipped.
 */
import { labelEm, type Stroke } from "./chart";
import type { Signal } from "./types";

export interface BoardTheme {
  font: string;
  /** headline numbers and names */
  ink: string;
  /** body text */
  ink2: string;
  /** ticks, captions, as of */
  mute: string;
  /** the fill behind a grid cell (none: no card) */
  card: { fill: string; stroke: string; radius: number };
  grid: Stroke;
  size: { tick: number; text: number; name: number; value: number; small: number };
  weight: { name: number; value: number; strong: number };
  /** a signal's mark colour; `chip` adds the deck's chip (FA3: tinted ground, dark word) */
  signal: Readonly<Record<Signal, string>>;
  chip: Readonly<Record<Signal, { fill: string; color: string }>> | null;
  /** the stage gauges (DD 1935 §3-2): a met cell's colour per gauge, unmet, and the dotted edge of an unknown */
  gauge: { escape: string; severe: string; recovery: string; unmet: string; unknown: string; cell: { w: number; h: number; gap: number } };
  /** the line runs over the bars on a halo of the ground's colour, so it stays visible across a bar of its own tone */
  flows: { foreign: string; institution: string; individual: string; line: Stroke; dot: number; zero: Stroke; halo: string };
  timeline: { axis: Stroke; dot: string; bull: string; bear: string; leader: Stroke };
}

/** the app: CSS variables, so a theme change needs no redraw; no colour for up or down (DD 1935 §0-3) */
export const APP_BOARD: BoardTheme = {
  font: "var(--font-text)",
  ink: "var(--label)",
  ink2: "var(--label-2)",
  mute: "var(--label-2)",
  card: { fill: "none", stroke: "var(--separator)", radius: 12 },
  grid: { color: "var(--separator)", width: 0.5 },
  size: { tick: 13, text: 15, name: 15, value: 20, small: 13 },
  weight: { name: 600, value: 700, strong: 600 },
  signal: { risk: "var(--danger)", caution: "var(--caution)", normal: "var(--label)", unknown: "var(--label-2)" },
  chip: null,
  gauge: { escape: "var(--caution)", severe: "var(--danger)", recovery: "var(--label)", unmet: "var(--fill-2)", unknown: "var(--label-3)", cell: { w: 10, h: 6, gap: 3 } },
  flows: { foreign: "var(--label)", institution: "var(--label-2)", individual: "var(--fill-3)", line: { color: "var(--label)", width: 1.5, dash: "4 3" }, dot: 2, zero: { color: "var(--label-3)", width: 1 }, halo: "var(--surface)" },
  timeline: { axis: { color: "var(--separator)", width: 1 }, dot: "var(--label)", bull: "var(--label)", bear: "var(--label)", leader: { color: "var(--separator)", width: 1 } },
};

/** the deck (F-A: FA2 sizes, FA3 palette, the signal chips' pairs; DD 1935 §5-2) */
export const DECK_BOARD: BoardTheme = {
  font: "'Noto Sans KR VF', 'Noto Sans KR', sans-serif",
  ink: "#12233F",
  ink2: "#3C4451",
  mute: "#7B8089",
  card: { fill: "#FFFDF6", stroke: "#E4DED0", radius: 10 },
  grid: { color: "#E4DED0", width: 1 },
  size: { tick: 15, text: 15, name: 19, value: 26, small: 14 },
  weight: { name: 700, value: 800, strong: 700 },
  signal: { risk: "#8C2318", caution: "#7C4A00", normal: "#0B6042", unknown: "#5A616C" },
  chip: {
    risk: { fill: "#F6D9D3", color: "#8C2318" },
    caution: { fill: "#F8E6C8", color: "#7C4A00" },
    normal: { fill: "#D8EDDF", color: "#0B6042" },
    unknown: { fill: "#E7E3D7", color: "#5A616C" },
  },
  gauge: { escape: "#7C4A00", severe: "#A62B21", recovery: "#12233F", unmet: "#E4DED0", unknown: "#8C9099", cell: { w: 28, h: 14, gap: 6 } },
  flows: { foreign: "#12233F", institution: "#8C9099", individual: "#D9D3C4", line: { color: "#8A6512", width: 2 }, dot: 3, zero: { color: "#A8A79E", width: 1 }, halo: "#FAF8F3" },
  timeline: { axis: { color: "#D9D3C4", width: 1.5 }, dot: "#12233F", bull: "#1B48D6", bear: "#A62B21", leader: { color: "#A8A79E", width: 1.5 } },
};

/** a text the renderer had to cut: where, and the whole text (the deck refuses the slide; the app's rows carry it) */
export type BoardIssue = { code: "text_overflow"; where: string; text: string } | { code: "stem_near_dot"; where: string; text: string } | { code: "flow_missing"; t: string; who: string } | { code: "nonarb_missing"; t: string };

export const f1 = (x: number) => (Math.round(x * 10) / 10).toString();
export const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
export const strokeAttr = (s: Stroke) =>
  `stroke="${s.color}" stroke-width="${s.width}"${s.dash ? ` stroke-dasharray="${s.dash}"` : ""}${s.round ? ' stroke-linecap="round"' : ""}`;

/** a text's width at a size: the upper bound of labelEm (the widest of the measured fonts) */
export const textW = (text: string, size: number) => labelEm(text) * size;

/**
 * Greedy wrapping at spaces into at most `maxLines` lines no wider than `width`; a word wider than a line is broken
 * between characters. `cut` says the text did not fit: its last line then ends in "…" and the caller reports it.
 */
export function wrapText(text: string, width: number, size: number, maxLines: number): { lines: string[]; cut: boolean } {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  const push = (w: string) => {
    if (!line) return void (line = w);
    if (textW(`${line} ${w}`, size) <= width) return void (line = `${line} ${w}`);
    lines.push(line);
    line = w;
  };
  for (const w of words) {
    if (textW(w, size) <= width) {
      push(w);
      continue;
    }
    // a word wider than the line: break it between characters
    for (const ch of [...w]) {
      if (line && textW(line + ch, size) > width) {
        lines.push(line);
        line = ch;
      } else line += ch;
    }
  }
  if (line) lines.push(line);
  if (lines.length <= maxLines) return { lines, cut: false };
  const kept = lines.slice(0, maxLines);
  let last = kept[maxLines - 1]!;
  while (last && textW(`${last}…`, size) > width) last = [...last].slice(0, -1).join("");
  kept[maxLines - 1] = `${last}…`;
  return { lines: kept, cut: true };
}

/** one <text>; `y` is the middle of its line box (the baseline sits 0.35em below it, as in levelChart) */
export function textAt(x: number, y: number, str: string, color: string, size: number, extra = ""): string {
  return `<text x="${f1(x)}" y="${f1(y + size * 0.35)}" font-size="${size}" fill="${color}"${extra}>${esc(str)}</text>`;
}
