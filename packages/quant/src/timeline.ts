/**
 * The event timeline (FA5 #6, DD 1935 §5-2 timeline): up to eight events on a horizontal time axis. Each event's dot
 * sits at its time and carries a stem; its text (date KST, event, consensus, Bull and Bear triggers, expected move)
 * starts beside the stem, above and below the axis in turn. A text is placed as near its dot as the ones beside it on
 * its side allow (the least-squares `stack` the level labels use); when it had to move, the stem bends to it.
 *
 * DD 0126 §1: a bent stem leaves the axis only at its own dot, bends 20px off the axis (a dot's radius 5 plus 15
 * clear, so the bend never reads as a second axis), and its upright stands more than 16px from every other dot, so a
 * moved text never reads as the text of the dot under it. A box that cannot stand clear between its neighbours is
 * reported (`stem_near_dot`). The date is written here from `at` (KST, weekday; DD 0126 §2), never taken as text.
 * No consensus is written 미확보, never left out (A1). The texts are the server's, formatted; a box whose text does not
 * fit is reported, not drawn cut.
 */
import { stack } from "./chart";
import { esc, f1, strokeAttr, textAt, wrapText, type BoardIssue, type BoardTheme } from "./board";
import { kstDayTime } from "./format";

export interface TimelineEvent {
  /** ISO 8601 with its offset: the position, and the date written (KST) */
  at: string;
  title: string;
  /** "0.3%" or null when not secured (written 미확보) */
  consensus: string | null;
  bull: string | null;
  bear: string | null;
  /** "±2.1%(추정)" or null */
  amplitude: string | null;
}

export interface TimelineInput {
  events: readonly TimelineEvent[];
  summary: string;
  asOf: string;
  source: string;
}

export interface TimelineLayout {
  width: number;
  height: number;
  /** the widest a box may be */
  boxMax: number;
  boxGap: number;
}

/** the deck's timeline slide: all 12 columns over the body */
export const DECK_TIMELINE: TimelineLayout = { width: 1152, height: 416, boxMax: 280, boxGap: 16 };

export const TIMELINE_MAX = 8;
export const NO_CONSENSUS = "미확보";
/** how far a bend runs from the axis (DD 0126 §1: ≥ 20) and a box from the axis beyond it */
export const STEM_BEND = 20;
export const BOX_REACH = 30;
/** a moved stem's upright stands more than this from every other dot's centre (lead 0127) */
export const STEM_CLEAR = 16;

export interface Timeline {
  svg: string;
  width: number;
  height: number;
  issues: BoardIssue[];
  axisY: number;
  /** each event's dot x and box (in time order) */
  boxes: { x: number; y: number; w: number; h: number; dot: number; above: boolean }[];
}

export function timelineSvg(input: TimelineInput, theme: BoardTheme, layout: TimelineLayout = DECK_TIMELINE): Timeline {
  const n = input.events.length;
  if (!n || n > TIMELINE_MAX) throw new Error(`timelineSvg: one to ${TIMELINE_MAX} events (more go to the appendix)`);
  const evs = input.events.map((e) => ({ e, ms: Date.parse(e.at) }));
  const bad = evs.find((x) => !Number.isFinite(x.ms));
  if (bad) throw new Error(`timelineSvg: a time that is not a date (${bad.e.at})`);
  evs.sort((a, b) => a.ms - b.ms);
  const issues: BoardIssue[] = [];
  const { width: W, height: H, boxGap } = layout;
  const sz = theme.size;
  const capH = Math.round(sz.small * 1.6);
  const top = capH;
  const axisY = top + (H - top) / 2;

  // boxes: alternate sides, as wide as the busier side allows less a margin at each end: the first and last dots stand
  // that far in, so a box pushed against an edge still stands clear of them
  const perSide = Math.ceil(n / 2);
  const edge = STEM_CLEAR + 2;
  const bw = Math.min(layout.boxMax, (W - (perSide - 1) * boxGap - 2 * edge) / perSide);
  const innerW = bw - 10;
  const t0 = evs[0]!.ms;
  const t1 = evs.at(-1)!.ms;
  // dots at their times, the last one far enough from the right edge for its box to start at it
  const x0 = edge;
  const x1 = W - bw - edge;
  const dotX = evs.map((x) => (t1 > t0 ? x0 + ((x.ms - t0) / (t1 - t0)) * (x1 - x0) : W / 2));
  const lineH = (size: number) => Math.round(size * 1.28);
  const lines = evs.map(({ e }, i) => {
    const out: { text: string; size: number; color: string; weight?: number; role: string; lead?: { word: string; color: string } }[] = [];
    // a lead word (Bull, Bear) is a tspan in the same <text>, so the engine spaces it; the first line's room leaves it out
    const add = (text: string, size: number, color: string, max: number, role: string, weight?: number, lead?: { word: string; color: string }) => {
      const full = lead ? `${lead.word} ${text}` : text;
      const w = wrapText(full, innerW, size, max);
      if (w.cut) issues.push({ code: "text_overflow", where: `${i + 1} ${role}`, text });
      w.lines.forEach((l, k) => {
        const own = k === 0 && lead && l.startsWith(`${lead.word} `) ? l.slice(lead.word.length + 1) : l;
        out.push({ text: own, size, color, weight, role, lead: k === 0 ? lead : undefined });
      });
    };
    add(kstDayTime(evs[i]!.ms), sz.text, theme.ink, 1, "date", theme.weight.strong);
    add(e.title, sz.name, theme.ink, 2, "title", theme.weight.name);
    add(`컨센서스 ${e.consensus ?? NO_CONSENSUS}`, sz.text, theme.ink2, 1, "consensus");
    if (e.bull) add(e.bull, sz.text, theme.ink2, 2, "bull", undefined, { word: "Bull", color: theme.timeline.bull });
    if (e.bear) add(e.bear, sz.text, theme.ink2, 2, "bear", undefined, { word: "Bear", color: theme.timeline.bear });
    if (e.amplitude) add(`진폭 ${e.amplitude}`, sz.text, theme.ink2, 1, "amplitude");
    return out;
  });
  const boxH = lines.map((ls) => ls.reduce((h, l) => h + lineH(l.size), 0));
  const reach = BOX_REACH;
  const room = (H - top) / 2 - reach;
  boxH.forEach((h, i) => {
    if (h > room) issues.push({ code: "text_overflow", where: `${i + 1} box`, text: evs[i]!.e.title });
  });

  // each box's left edge (its stem) per side, as near its dot as the others allow
  const boxX: number[] = new Array(n);
  for (const side of [0, 1]) {
    const idx = evs.map((_, i) => i).filter((i) => i % 2 === side);
    const placed = stack(
      idx.map((i) => dotX[i]!),
      bw + boxGap,
      0,
      W - bw,
    );
    idx.forEach((i, k) => (boxX[i] = placed[k]!));
    // a moved box whose upright would stand within STEM_CLEAR of another dot goes the least way clear of it, between its
    // neighbours on the side; when no place is clear, it stays and is reported
    const near = (x: number, i: number) => dotX.some((d, j) => j !== i && Math.abs(d - x) <= STEM_CLEAR);
    idx.forEach((i, k) => {
      const x = boxX[i]!;
      if (Math.abs(x - dotX[i]!) < 0.5 || !near(x, i)) return;
      const lo = k > 0 ? boxX[idx[k - 1]!]! + bw + boxGap : 0;
      const hi = k < idx.length - 1 ? boxX[idx[k + 1]!]! - bw - boxGap : W - bw;
      const options = [dotX[i]!, ...dotX.flatMap((d, j) => (j === i ? [] : [d - STEM_CLEAR - 1, d + STEM_CLEAR + 1]))].filter(
        (c) => c >= lo - 1e-6 && c <= hi + 1e-6 && (Math.abs(c - dotX[i]!) < 0.5 || !near(c, i)),
      );
      if (!options.length) return void issues.push({ code: "stem_near_dot", where: `${i + 1}`, text: evs[i]!.e.title });
      boxX[i] = options.reduce((b, c) => (Math.abs(c - x) < Math.abs(b - x) ? c : b));
    });
  }

  const s: string[] = [];
  s.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(input.summary)}" style="font-family:${theme.font};font-variant-numeric:tabular-nums">`);
  s.push(textAt(0, capH / 2, `${input.asOf} · ${input.source}`, theme.mute, sz.small, ' data-role="caption"'));
  s.push(`<line x1="0" x2="${W}" y1="${f1(axisY)}" y2="${f1(axisY)}" ${strokeAttr(theme.timeline.axis)} data-role="axis"/>`);
  const boxes: Timeline["boxes"] = [];
  evs.forEach((_, i) => {
    const above = i % 2 === 0;
    const h = Math.min(boxH[i]!, room);
    const bx = boxX[i]!;
    const by = above ? axisY - reach - h : axisY + reach;
    boxes.push({ x: bx, y: by, w: bw, h, dot: dotX[i]!, above });
    // the stem: up (or down) from the dot, bending over to the box's left edge when the box had to move, then along the
    // box's whole height
    const sgn = above ? -1 : 1;
    const bend = axisY + sgn * STEM_BEND;
    const far = above ? by : by + h;
    const stem = Math.abs(bx - dotX[i]!) < 0.5 ? `M${f1(bx)},${f1(axisY)}V${f1(far)}` : `M${f1(dotX[i]!)},${f1(axisY)}V${f1(bend)}H${f1(bx)}V${f1(far)}`;
    s.push(`<path d="${stem}" fill="none" ${strokeAttr(theme.timeline.leader)} data-role="stem"/>`);
    s.push(`<circle cx="${f1(dotX[i]!)}" cy="${f1(axisY)}" r="5" fill="${theme.timeline.dot}" data-role="event-dot"/>`);
    let y = by;
    s.push(`<g data-event="${i + 1}">`);
    for (const l of lines[i]!) {
      const lh = lineH(l.size);
      if (y + lh > by + h + 0.5) break;
      const mid = y + lh / 2;
      const x = bx + 10;
      const wt = l.weight ? ` font-weight="${l.weight}"` : "";
      if (l.lead)
        s.push(
          `<text x="${f1(x)}" y="${f1(mid + l.size * 0.35)}" font-size="${l.size}" fill="${l.color}"${wt} data-role="${l.role}"><tspan font-weight="${theme.weight.strong}" fill="${l.lead.color}" data-role="${l.role}-word">${l.lead.word}</tspan> ${esc(l.text)}</text>`,
        );
      else s.push(textAt(x, mid, l.text, l.color, l.size, `${wt} data-role="${l.role}"`));
      y += lh;
    }
    s.push("</g>");
  });
  s.push("</svg>");
  return { svg: s.join(""), width: W, height: H, issues, axisY, boxes };
}
