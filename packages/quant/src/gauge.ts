/**
 * The stage gauges (A5 악화 n/8, 심각 n/5; A6 회복 n/6) as a row of cells (DD 1935 §3-2, §5-2 signal-board and gauges):
 * met cells first in the gauge's colour, then the unknown ones with a dotted edge, then the unmet ones. An unknown is
 * never drawn as met or unmet (A1). The count beside it ("3/8") is the caller's text; the gauge carries the same words
 * for assistive tech. Input is EscapeStage.gauges.a / .d or RecoveryStage.gauge as they come.
 */
import { f1, type BoardTheme } from "./board";
import { TRI_WORD } from "./signal";

export type GaugeKind = "escape" | "severe" | "recovery";

/** the gauges' names (A15 §4·§5 wording on the card: 악화 신호 / 심각 신호 / 회복 신호) */
export const GAUGE_NAME: Readonly<Record<GaugeKind, string>> = { escape: "악화 신호", severe: "심각 신호", recovery: "회복 신호" };

export interface GaugeCount {
  met: number;
  unknown: number;
  of: number;
}

/** the gauge's sentence: 악화 신호 8개 중 3개 충족, 확인 불가 1개 */
export function gaugeText(kind: GaugeKind, g: GaugeCount): string {
  const base = `${GAUGE_NAME[kind]} ${g.of}개 중 ${g.met}개 ${TRI_WORD.met}`;
  return g.unknown ? `${base}, ${TRI_WORD.unknown} ${g.unknown}개` : base;
}

export function gaugeSvg(kind: GaugeKind, g: GaugeCount, theme: BoardTheme): { svg: string; width: number; height: number } {
  const ok = [g.met, g.unknown, g.of].every((n) => Number.isInteger(n) && n >= 0) && g.of > 0 && g.met + g.unknown <= g.of;
  if (!ok) throw new Error(`gaugeSvg: counts that do not add up (${g.met} met, ${g.unknown} unknown of ${g.of})`);
  const { w, h, gap } = theme.gauge.cell;
  const width = g.of * w + (g.of - 1) * gap;
  const r = h / 2;
  const cells: string[] = [];
  for (let i = 0; i < g.of; i++) {
    const x = i * (w + gap);
    const state = i < g.met ? "met" : i < g.met + g.unknown ? "unknown" : "unmet";
    if (state === "unknown") {
      // the dotted edge sits inside the cell, so an unknown cell is no wider than the others
      cells.push(
        `<rect x="${f1(x + 0.5)}" y="0.5" width="${f1(w - 1)}" height="${f1(h - 1)}" rx="${f1(r - 0.5)}" fill="none" stroke="${theme.gauge.unknown}" stroke-width="1" stroke-dasharray="2 2" data-cell="unknown"/>`,
      );
    } else {
      cells.push(`<rect x="${f1(x)}" y="0" width="${w}" height="${h}" rx="${f1(r)}" fill="${state === "met" ? theme.gauge[kind] : theme.gauge.unmet}" data-cell="${state}"/>`);
    }
  }
  const label = gaugeText(kind, g);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${h}" width="${width}" height="${h}" role="img" aria-label="${label}" data-gauge="${kind}">${cells.join("")}</svg>`;
  return { svg, width, height: h };
}
