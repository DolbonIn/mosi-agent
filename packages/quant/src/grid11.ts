/**
 * The 11-indicator grid (FA6 9–10 "3×4 신호등 그리드", DD 1935 §5-2 grid11): eleven cells and a summary cell, four across
 * and three down. A cell: the signal (mark + word, never colour alone; §0-4), the indicator's name, its value, the
 * threshold it is judged against, and the as of. The texts come formatted from the server (§0-5 formatter); the grid
 * measures them and reports any it had to cut. The summary counts every signal, zeros included, and 확인 불가 apart.
 */
import { esc, f1, textAt, textW, wrapText, type BoardIssue, type BoardTheme } from "./board";
import { SIGNAL_SHAPES, SIGNAL_VIEWBOX, SIGNAL_WORD, signalSummary } from "./signal";
import type { Signal } from "./types";

export interface Grid11Item {
  /** 1–11 (CORE11) */
  no: number;
  name: string;
  signal: Signal;
  /** the value as the card writes it ("4.53%", "확인 불가") */
  value: string;
  /** what it is judged against ("> 5%이면 위험") */
  basis: string;
  /** "11/26 기준" */
  asOf: string;
}

export interface Grid11Layout {
  width: number;
  height: number;
  gap: number;
  pad: number;
}

/** the deck's grid11 slide: all 12 columns (1152) over the body (y 240–656) */
export const DECK_GRID11: Grid11Layout = { width: 1152, height: 416, gap: 12, pad: 12 };

export interface Grid11 {
  svg: string;
  width: number;
  height: number;
  issues: BoardIssue[];
  counts: Record<Signal, number>;
}

const ORDER: readonly Signal[] = ["risk", "caution", "normal", "unknown"];

/** a mark (+ word) at (x, y-middle); the chip theme draws a tinted chip around both */
function mark(signal: Signal, x: number, y: number, size: number, color: string): string {
  return `<svg x="${f1(x)}" y="${f1(y - size / 2)}" width="${size}" height="${size}" viewBox="${SIGNAL_VIEWBOX}" color="${color}" aria-hidden="true">${SIGNAL_SHAPES[signal]}</svg>`;
}

export function grid11Svg(items: readonly Grid11Item[], theme: BoardTheme, layout: Grid11Layout = DECK_GRID11): Grid11 {
  const nos = items.map((it) => it.no).sort((a, b) => a - b);
  if (items.length !== 11 || nos.some((n, i) => n !== i + 1)) throw new Error("grid11Svg: eleven indicators, numbered 1 to 11");
  const issues: BoardIssue[] = [];
  const counts: Record<Signal, number> = { risk: 0, caution: 0, normal: 0, unknown: 0 };
  for (const it of items) counts[it.signal]++;
  const { width: W, height: H, gap, pad } = layout;
  const cw = (W - 3 * gap) / 4;
  const ch = (H - 2 * gap) / 3;
  const inner = cw - 2 * pad;
  const sz = theme.size;
  const s: string[] = [];
  const summary = signalSummary(counts);
  s.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(`11지표: ${summary}`)}" style="font-family:${theme.font};font-variant-numeric:tabular-nums">`);
  const cell = (i: number) => ({ x: (i % 4) * (cw + gap), y: Math.floor(i / 4) * (ch + gap) });
  const card = (x: number, y: number) =>
    theme.card.fill !== "none" || theme.card.stroke !== "none"
      ? `<rect x="${f1(x + 0.5)}" y="${f1(y + 0.5)}" width="${f1(cw - 1)}" height="${f1(ch - 1)}" rx="${theme.card.radius}" fill="${theme.card.fill}" stroke="${theme.card.stroke}" stroke-width="1" data-role="cell"/>`
      : "";
  const fit = (str: string, size: number, where: string, room = inner) => {
    if (textW(str, size) <= room) return str;
    const { lines } = wrapText(str, room, size, 1);
    issues.push({ code: "text_overflow", where, text: str });
    return lines[0]!;
  };
  // rows: signal 22 · name · value (with the basis at its right) · as of
  const chipH = Math.round(sz.text * 1.5);
  const nameH = Math.round(sz.name * 1.26);
  const valueH = Math.round(sz.value * 1.2);
  const smallH = Math.round(sz.small * 1.3);

  [...items]
    .sort((a, b) => a.no - b.no)
    .forEach((it, i) => {
      const { x, y } = cell(i);
      s.push(`<g data-no="${it.no}" data-signal="${it.signal}">`);
      s.push(card(x, y));
      let cy = y + pad;
      // the signal: mark + word, in a chip on the deck
      const word = SIGNAL_WORD[it.signal];
      const ms = Math.round(sz.text * 1.05);
      const ww = textW(word, sz.text);
      if (theme.chip) {
        const c = theme.chip[it.signal];
        const chipW = 8 + ms + 5 + ww + 10;
        s.push(`<rect x="${f1(x + pad)}" y="${f1(cy)}" width="${f1(chipW)}" height="${chipH}" rx="${f1(chipH / 2)}" fill="${c.fill}" data-role="chip"/>`);
        s.push(mark(it.signal, x + pad + 8, cy + chipH / 2, ms, c.color));
        s.push(textAt(x + pad + 8 + ms + 5, cy + chipH / 2, word, c.color, sz.text, ` font-weight="${theme.weight.strong}" data-role="signal-word"`));
      } else {
        s.push(mark(it.signal, x + pad, cy + chipH / 2, ms, theme.signal[it.signal]));
        s.push(textAt(x + pad + ms + 5, cy + chipH / 2, word, theme.ink2, sz.text, ` font-weight="${theme.weight.strong}" data-role="signal-word"`));
      }
      cy += chipH + 6;
      s.push(textAt(x + pad, cy + nameH / 2, fit(it.name, sz.name, `${it.no} name`), theme.ink, sz.name, ` font-weight="${theme.weight.name}" data-role="name"`));
      cy += nameH + 2;
      // the value at the left; the basis at the right of the value's row, or of the as-of row when the value is too wide
      // for both (the as of keeps its place at the left)
      const vw = textW(it.value, sz.value);
      const value = fit(it.value, sz.value, `${it.no} value`);
      s.push(textAt(x + pad, cy + valueH / 2, value, theme.ink, sz.value, ` font-weight="${theme.weight.value}" data-role="value"`));
      const bw = textW(it.basis, sz.text);
      const besideValue = Math.min(vw, inner) + 12 + bw <= inner;
      const aw = textW(it.asOf, sz.small);
      if (besideValue) s.push(textAt(x + cw - pad, cy + valueH / 2 + (sz.value - sz.text) * 0.3, it.basis, theme.ink2, sz.text, ' text-anchor="end" data-role="basis"'));
      cy += valueH + 2;
      s.push(textAt(x + pad, cy + smallH / 2, fit(it.asOf, sz.small, `${it.no} asOf`), theme.mute, sz.small, ' data-role="as-of"'));
      if (!besideValue) s.push(textAt(x + cw - pad, cy + smallH / 2, fit(it.basis, sz.text, `${it.no} basis`, inner - Math.min(aw, inner) - 12), theme.ink2, sz.text, ' text-anchor="end" data-role="basis"'));
      s.push("</g>");
    });

  // the summary cell: a kicker, then two rows of two (mark, word, count)
  const { x, y } = cell(11);
  s.push(`<g data-role="summary">`);
  s.push(card(x, y));
  const kick = "11지표 집계";
  s.push(textAt(x + pad, y + pad + chipH / 2, kick, theme.mute, sz.text, ` font-weight="${theme.weight.strong}"`));
  const rowY0 = y + pad + chipH + 6;
  const rowH = (ch - pad * 2 - chipH - 6) / 2;
  const colW = inner / 2;
  ORDER.forEach((sig, k) => {
    const cx = x + pad + (k % 2) * colW;
    const cy = rowY0 + Math.floor(k / 2) * rowH + rowH / 2;
    const ms = Math.round(sz.text * 1.05);
    const color = theme.chip ? theme.chip[sig].color : theme.signal[sig];
    s.push(mark(sig, cx, cy, ms, color));
    const word = SIGNAL_WORD[sig];
    s.push(textAt(cx + ms + 5, cy, word, theme.ink2, sz.text, ` font-weight="${theme.weight.strong}"`));
    const count = String(counts[sig]);
    const end = cx + ms + 5 + textW(word, sz.text) + 6;
    if (end + textW(count, sz.value) > cx + colW) issues.push({ code: "text_overflow", where: `summary ${sig}`, text: `${word} ${count}` });
    s.push(textAt(end, cy, count, theme.ink, sz.value, ` font-weight="${theme.weight.value}" data-role="count" data-signal="${sig}"`));
  });
  s.push("</g></svg>");
  return { svg: s.join(""), width: W, height: H, issues, counts };
}
