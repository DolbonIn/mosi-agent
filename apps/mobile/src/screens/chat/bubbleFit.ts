/**
 * Bubble widths (my bubbles and a friend's; never the assistant's plain text). A bubble whose last line holds two
 * characters or fewer ("요.") is narrowed a word at a time (the last word of the line above moves down) until its
 * last line holds three or more; then it is cut to its longest line. Every other bubble of two lines or more is cut
 * to its longest line too, its breaks kept, so no empty band opens on its right (430: "월요일까지 견적서 다시 보내
 * 달라고" left ~60 px). A try that adds a line or moves a break is dropped, so a bubble keeps its height and the list
 * never moves. (`text-wrap: pretty` stays off for bubbles: WebKit re-breaks most two-line bubbles with it and keeps
 * the box at full width.)
 * Emoji: a stretch between spaces that holds two emoji or more side by side ("🍜🍜", "봤어🔥🔥!") is one box
 * (`.bubble-hold`), so no line ends inside it (Chrome broke "줘 🍜 / 🍜"; a box around the emoji alone let WebKit end a
 * line before them, "봤어 / 🔥🔥!"), and a last line holding nothing but emoji is not an orphan.
 *
 * Cost: opening a thread fits only what its first paint shows (the view and a little past it), before paint; the
 * rest of the first page when it comes within a screen of view (IntersectionObserver), with everything not yet
 * fitted within two screens, after a paint, off screen. A page or message that mounts into an open thread (an older
 * page above, a new message) is fitted with its mount, before paint. A bubble is read once: its height (one line:
 * done), its line boxes (a whole-node read per text node; they give the longest line, less the space a line broke
 * at, which pre-wrap keeps hanging past it), and for a last line narrow enough to hold two characters, its last three
 * characters on a hidden ruler (a last line that wide holds them). Only orphans are worked out on the ruler, a copy
 * of the paragraph in a box of its own, so trying widths lays out the ruler and never the thread; each bubble gets
 * one width at the end, checked against its own line boxes. (A single character's box costs WebKit ~60 µs: reading
 * per character put 17–22 ms on each page of 50.) Scrolling over fitted bubbles costs nothing. A thread width or text
 * size change drops every cap and places the bubbles again like an open: in view now, before paint (a text size as
 * tierStore tells it, a width from a ResizeObserver), the rest as they come near. The observer hears of a jump only
 * after the paint that shows it, so the app's own jumps to the end ("새 메시지", sending from far up) fit where they
 * land and glide first (fitAhead); another jump of more than two screens (no reader scrolls so) can show bubbles not
 * yet fitted for a frame.
 */

import { tierStore } from "../../motion/tier";

/** a last line with fewer visible characters than this is an orphan (qa/lib/lines.mjs "orphan": two or fewer) */
const MIN_LAST = 3;
/** words moved down at most, before the bubble is left as built */
const MAX_STEPS = 6;
/** characters that take no place on a line (qa/lib/lines.mjs SPACE) */
const HIDDEN = /[\s​-‍⁠﻿]/g;
/** two characters never take more than this (em): a wider last line holds three or more */
const TWO_CHARS_EM = 3;

/** a line as the ruler reads it: its right edge (layout px from the paragraph's left, spaces left out), its visible
 *  characters, and whether it holds nothing but emoji */
export interface Line {
  right: number;
  chars: number;
  emoji?: boolean;
}

/** a last line of two characters or fewer, unless it is emoji only ("…연락 줘 / 🍜🍜" is how people write) */
export const isOrphan = (lines: Line[]): boolean => {
  const last = lines[lines.length - 1];
  return lines.length > 1 && !last!.emoji && last!.chars < MIN_LAST;
};

// ── emoji ──

/** what rides on an emoji: VS16, skin tones, tag characters (subdivision flags) */
const MOD = "[\\uFE0F\\u{1F3FB}-\\u{1F3FF}\\u{E0020}-\\u{E007F}]*";
/** one emoji as people see it: a pictograph with its modifiers and ZWJ partners, a flag (two regional indicators), a
 *  keycap */
const PICTO = `\\p{Extended_Pictographic}${MOD}`;
const CLUSTER = `(?:${PICTO}(?:\\u200D${PICTO})*|[\\u{1F1E6}-\\u{1F1FF}]{2}|[0-9#*]\\uFE0F?\\u20E3)`;
const RUN = new RegExp(`((?:${CLUSTER})+)`, "u");
const ONLY = new RegExp(`^(?:${CLUSTER})+$`, "u");
/** two emoji side by side (one emoji never splits anyway) */
const PAIR = new RegExp(`(?:${CLUSTER}){2}`, "u");
/** the class of a held stretch (chat.css), in the bubble and on the ruler alike */
export const HOLD = "bubble-hold";
/** the text cut into emoji runs and the rest: the runs sit at the odd indices */
export const emojiPieces = (text: string): string[] => text.split(RUN);
/** a stretch between spaces holding two emoji side by side is held whole, the word and marks it touches with it
 *  ("봤어🔥🔥!": the writer's word); with a space before them only the emoji are ("됐어요 👍🏽👍🏽") */
const held = (stretch: string) => PAIR.test(stretch);
/** the text cut into plain pieces and held stretches: the stretches sit at the odd indices */
export function heldPieces(text: string): string[] {
  const out = [""];
  for (const part of text.split(/(\s+)/)) {
    if (part && held(part)) out.push(part, "");
    else out[out.length - 1] += part;
  }
  return out;
}

/**
 * The next cap: a pixel short of the end of the line above the orphan, so the last piece the browser may break off
 * that line (a word) moves down, and nothing else has to. A cap at the start of that word instead re-broke the
 * longer lines above it: a three-line bubble went to four. null: that line has nothing to give.
 */
export function nextCap(lines: Line[]): number | null {
  if (lines.length < 2) return null;
  const above = lines[lines.length - 2]!;
  return above.chars > 1 ? above.right - 1 : null;
}

/**
 * A cap at a line's end `v` (px from the paragraph's left): a quarter pixel on (the bubble's own glyphs sit up to that
 * far from the ruler's), up to the next layout unit (1/64 px in both engines); whole pixels left a 1.08 px band. And
 * less than half a pixel short of the next whole pixel: WebKit gives a part of a line (a character, a word) as a box
 * rounded out to whole pixels from the line's start, so a closer cut read up to 0.7 px past the box (lines.mjs overflow
 * at 320 and 360) while the glyphs ended inside it.
 */
export function edge(v: number): number {
  return Math.max(Math.ceil((v + 0.25) * 64) / 64, Math.ceil(v + 1 / 64) - 31 / 64);
}

/** the cap that holds the longest line */
export function tightCap(lines: Line[]): number {
  return edge(Math.max(0, ...lines.map((l) => l.right)));
}

const shape = (lines: Line[]) => lines.map((l) => l.chars).join("/");
const visible = (s: string) => [...s.replace(HIDDEN, "")].length;

// ── the ruler: one hidden paragraph, in a box that is its own layout root ──

/** what decides line breaks, copied from the bubble's paragraph */
const TEXT_PROPS = [
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "font-stretch",
  "font-variant",
  "font-feature-settings",
  "font-variation-settings",
  "font-kerning",
  "font-synthesis",
  "line-height",
  "letter-spacing",
  "word-spacing",
  "word-break",
  "overflow-wrap",
  "white-space",
  "line-break",
  "hyphens",
  "text-transform",
  "text-rendering",
  "tab-size",
  "text-indent",
  "direction",
  "text-wrap-mode",
  "text-wrap-style",
];

let rulerHost: HTMLDivElement | null = null;
let ruler: HTMLParagraphElement | null = null;
let rulerStyle = "";
let rulerText: string | null = null;
let rulerWords: { node: Text; chars: number; emoji: boolean }[] = [];
const range = typeof document === "undefined" ? null : document.createRange();

function rulerFor(el: HTMLElement, cs: CSSStyleDeclaration): HTMLParagraphElement {
  if (!rulerHost || !ruler || !rulerHost.isConnected) {
    rulerHost = document.createElement("div");
    rulerHost.setAttribute("aria-hidden", "true");
    rulerHost.style.cssText =
      "position:fixed;left:0;top:0;width:0;height:0;overflow:hidden;" +
      "visibility:hidden;contain:strict;pointer-events:none";
    ruler = document.createElement("p");
    ruler.style.cssText = "position:absolute;left:0;top:0;margin:0;padding:0;border:0";
    rulerHost.append(ruler);
    document.body.append(rulerHost);
    rulerStyle = "";
    rulerText = null;
  }
  const lang = el.closest("[lang]")?.getAttribute("lang") ?? "";
  const style = TEXT_PROPS.map((k) => cs.getPropertyValue(k)).join("|") + lang;
  if (style !== rulerStyle) {
    for (const k of TEXT_PROPS) ruler.style.setProperty(k, cs.getPropertyValue(k));
    ruler.lang = lang;
    rulerStyle = style;
  }
  return ruler;
}

/** the ruler's lines for `text` at `width`: a text node per word (and per emoji run; held stretches in the bubble's
 *  box), so every read is a whole node (cheap in both engines); a word broken across lines is read per character */
function rule(r: HTMLParagraphElement, text: string, width: number, lh: number): Line[] {
  if (text !== rulerText) {
    rulerWords = [];
    const nodes: Node[] = [];
    for (const piece of text.split(/(\s+)/)) {
      if (!piece) continue;
      if (!visible(piece)) {
        nodes.push(document.createTextNode(piece));
        continue;
      }
      if (held(piece)) {
        const node = document.createTextNode(piece);
        const box = document.createElement("span");
        box.className = HOLD;
        box.append(node);
        nodes.push(box);
        rulerWords.push({ node, chars: visible(piece), emoji: ONLY.test(piece) });
        continue;
      }
      // emoji apart from the rest, so a line of emoji only is known as one
      emojiPieces(piece).forEach((part, i) => {
        if (!part) return;
        const node = document.createTextNode(part);
        nodes.push(node);
        const chars = visible(part);
        if (chars) rulerWords.push({ node, chars, emoji: i % 2 === 1 });
      });
    }
    r.replaceChildren(...nodes);
    rulerText = text;
  }
  r.style.width = `${width}px`;
  const box = r.getBoundingClientRect();
  const lines: { top: number; right: number; chars: number; emoji: boolean }[] = [];
  const add = (top: number, right: number, chars: number, emoji: boolean) => {
    const line = lines.find((l) => Math.abs(l.top - top) < lh / 2);
    if (line) {
      line.right = Math.max(line.right, right - box.left);
      line.chars += chars;
      line.emoji &&= emoji;
    } else lines.push({ top, right: right - box.left, chars, emoji });
  };
  for (const w of rulerWords) {
    range!.selectNodeContents(w.node);
    const rects = range!.getClientRects();
    if (rects.length === 1) {
      add(rects[0]!.top, rects[0]!.right, w.chars, w.emoji);
      continue;
    }
    const t = w.node.data;
    for (let i = 0; i < t.length; ) {
      const n = (t.codePointAt(i) ?? 0) > 0xffff ? 2 : 1;
      const ch = t.slice(i, i + n);
      range!.setStart(w.node, i);
      range!.setEnd(w.node, i + n);
      i += n;
      if (!visible(ch)) continue;
      const g = range!.getBoundingClientRect();
      if (g.width) add(g.top, g.right, 1, w.emoji);
    }
  }
  return lines.sort((a, b) => a.top - b.top).map(({ right, chars, emoji }) => ({ right, chars, emoji }));
}

/** the bubble's own line boxes (a whole-node read per text node: one, or a few around held stretches; a held box's
 *  own rect would be the line's whole width when it wraps inside): each line's right edge from the paragraph's left
 *  (a line that broke at a space ends past it: pre-wrap keeps that space, hanging) and how wide the last line is
 *  (layout px: rects come scaled while a screen moves in, `s` takes that out) */
interface Own {
  rights: number[];
  lastWidth: number;
}
function ownLines(el: HTMLElement, lh: number, s: number): Own {
  const left = el.getBoundingClientRect().left;
  const tops: { top: number; left: number; right: number }[] = [];
  for (const child of el.childNodes) {
    const node = child.nodeType === Node.TEXT_NODE ? child : child.firstChild;
    if (!node) continue;
    range!.selectNodeContents(node);
    for (const q of range!.getClientRects()) {
      if (!q.width && !q.height) continue;
      const line = tops.find((l) => Math.abs(l.top - q.top) < (lh * s) / 2);
      if (line) {
        line.left = Math.min(line.left, q.left);
        line.right = Math.max(line.right, q.right);
      } else tops.push({ top: q.top, left: q.left, right: q.right });
    }
  }
  tops.sort((a, b) => a.top - b.top);
  const last = tops[tops.length - 1];
  return { rights: tops.map((l) => (l.right - left) / s), lastWidth: last ? (last.right - last.left) / s : 0 };
}

/**
 * The cut to the longest line for a bubble with no orphan to pull up, from its own line boxes: each line that broke
 * at a space less that space (it hangs past the line; the last line has none unless the text ends in one), to its
 * edge(). The breaks stay: every line still fits, and every word that went down still does not. `loose` keeps the
 * spaces in, for a line that did not break at a space (the writer's own line break, a long word broken inside): its
 * line box is its text.
 */
export function bandCap(rights: number[], space: number, endsInSpace: boolean): { cap: number; loose: number } {
  const n = rights.length;
  const ink = rights.map((r, i) => r - (i < n - 1 || endsInSpace ? space : 0));
  return { cap: edge(Math.max(0, ...ink)), loose: edge(Math.max(0, ...rights)) };
}

let spaceKey = "";
let spaceW = 0;
/** a space's advance in the bubble's font: one read on the ruler per font */
function spaceWidth(el: HTMLElement, cs: CSSStyleDeclaration): number {
  const key = `${cs.fontFamily}|${cs.fontSize}|${cs.fontWeight}|${cs.letterSpacing}|${cs.wordSpacing}`;
  if (key === spaceKey) return spaceW;
  const r = rulerFor(el, cs);
  const gap = document.createTextNode(" ");
  r.replaceChildren(document.createTextNode("가"), gap, document.createTextNode("가"));
  rulerText = null;
  r.style.width = "max-content";
  range!.selectNodeContents(gap);
  spaceW = range!.getBoundingClientRect().width;
  spaceKey = key;
  return spaceW;
}

interface Plan {
  /** the bubble's line count, which the caps keep */
  lines: number;
  /** cut to the longest line, and how wide the bubble's own last line should be then (checked after writing) */
  cap: number;
  lastWidth: number;
  /** the width that first pulled the orphan up, for a bubble whose own glyphs do not fit the cut */
  loose: number;
  looseLast: number;
}

/** how wide the text's last three visible characters (and the spaces between them) are on their own line */
function tailWidth(r: HTMLParagraphElement, text: string): number {
  let i = text.length;
  for (let seen = 0; i > 0 && seen < MIN_LAST; ) {
    const lo = text.charCodeAt(i - 1);
    const n = lo >= 0xdc00 && lo <= 0xdfff && i > 1 ? 2 : 1;
    i -= n;
    if (visible(text.slice(i, i + n))) seen++;
  }
  const node = document.createTextNode(text.slice(i).trimEnd());
  r.replaceChildren(node);
  rulerText = null;
  r.style.width = "max-content";
  range!.selectNodeContents(node);
  return range!.getBoundingClientRect().width;
}

/**
 * The cap for one bubble, worked out on the ruler: null when it has no orphan or none can be pulled up without a
 * line more. `lastWidth`: the bubble's own last line, in layout px.
 */
function plan(el: HTMLElement, cs: CSSStyleDeclaration, width: number, lh: number, lastWidth: number): Plan | null {
  const text = el.textContent ?? "";
  // the writer's own line break right before a short last line: nothing to pull up
  const tail = text.slice(text.lastIndexOf("\n") + 1);
  if (text.includes("\n") && visible(tail) < MIN_LAST) return null;
  const r = rulerFor(el, cs);
  // a last line as wide as the last three characters on their own holds them (one small read before the whole text)
  if (lastWidth >= tailWidth(r, text) - 0.5) return null;
  let lines = rule(r, text, width, lh);
  const n = lines.length;
  if (!isOrphan(lines)) return null;
  let loose = width;
  for (let step = 0; isOrphan(lines); step++) {
    const next = step < MAX_STEPS ? nextCap(lines) : null;
    if (next === null) return null;
    loose = next;
    lines = rule(r, text, loose, lh);
    if (lines.length > n) return null;
  }
  const looseLast = lines[lines.length - 1]!.right;
  // cut to the longest line when that keeps every break (lines break greedily, so it should)
  const tight = tightCap(lines);
  const cut = tight < loose ? rule(r, text, tight, lh) : null;
  if (cut && shape(cut) === shape(lines)) {
    return { lines: n, cap: tight, lastWidth: cut[cut.length - 1]!.right, loose, looseLast };
  }
  return { lines: n, cap: loose, lastWidth: looseLast, loose, looseLast };
}

// ── fitting, in batches: every read, then every write, then one check (and a second width for the few that fail) ──

interface Fitting {
  el: HTMLElement;
  lh: number;
  s: number;
  /** widths to write, tightest first; none left: the bubble stays as built */
  caps: number[];
  /** the bubble at caps[k], as its own line boxes read: does it hold */
  holds: (own: Own, k: number) => boolean;
}

interface Thread {
  /** width and text size the thread was last fitted at */
  key: string;
  bubbles: Set<HTMLElement>;
  io: IntersectionObserver | null;
  /** placed once (the open): bubbles that mount from then on are fitted with their mount */
  open: boolean;
}
const threads = new Map<HTMLElement, Thread>();
const home = new WeakMap<HTMLElement, HTMLElement>();
const fittedAt = new WeakMap<HTMLElement, string>();

const keyOf = (content: HTMLElement) => `${content.clientWidth}:${getComputedStyle(document.documentElement).fontSize}`;

function fit(els: HTMLElement[]): void {
  if (!els.length) return;
  // a cap from another width would decide the breaks being read
  for (const el of els) if (el.style.maxWidth) el.style.maxWidth = "";
  const keys = new Map<HTMLElement, string>();
  const plans: Fitting[] = [];
  for (const el of els) {
    const content = home.get(el);
    const t = content && threads.get(content);
    if (!content || !t || !el.isConnected) continue;
    let key = keys.get(content);
    if (key === undefined) keys.set(content, (key = keyOf(content)));
    if (!t.key) t.key = key;
    // not laid out (a hidden screen): its first size change fits it
    if (key.startsWith("0:")) continue;
    fittedAt.set(el, key);
    const cs = getComputedStyle(el);
    const lh = parseFloat(cs.lineHeight) || 24;
    if (el.offsetHeight < lh * 1.5) continue; // one line
    const width = parseFloat(cs.width);
    const s = width ? el.getBoundingClientRect().width / width : 0;
    if (!s) continue;
    const own = ownLines(el, lh, s);
    const n = own.rights.length;
    if (n < 2) continue;
    // an orphan: pulled up on the ruler; then as many lines as before, and the last one as the ruler measured it
    const narrowLast = own.lastWidth <= TWO_CHARS_EM * (parseFloat(cs.fontSize) || 17);
    const p = narrowLast ? plan(el, cs, width, lh, own.lastWidth) : null;
    if (p) {
      const lasts = [p.lastWidth, p.looseLast];
      const caps = p.loose === p.cap ? [p.cap] : [p.cap, p.loose];
      const holds = (o: Own, k: number) => o.rights.length === p.lines && Math.abs(o.lastWidth - lasts[k]!) <= 1;
      plans.push({ el, lh, s, caps, holds });
      continue;
    }
    // no orphan: cut to the longest line, every line where it was. A line that broke at a space may read up to that
    // space narrower at the cut (its hanging box clipped); a word moved down takes a word and a space off its line
    const space = spaceWidth(el, cs);
    const band = bandCap(own.rights, space, /[ \t]$/.test(el.textContent ?? ""));
    if (band.cap >= width - 0.5) continue;
    const caps = band.loose >= width - 0.5 || band.loose === band.cap ? [band.cap] : [band.cap, band.loose];
    const kept = (r: number, i: number) => r <= own.rights[i]! + 1 && r >= own.rights[i]! - space - 1;
    const holds = (o: Own) =>
      o.rights.length === n && Math.abs(o.lastWidth - own.lastWidth) <= 1 && o.rights.every(kept);
    plans.push({ el, lh, s, caps, holds });
  }
  ruler?.replaceChildren();
  rulerText = null;
  // one layout per round for all: the tightest width, then the looser one for a bubble that did not hold, else none
  let todo = plans;
  for (let k = 0; todo.length; k++) {
    for (const p of todo) p.el.style.maxWidth = k < p.caps.length ? `${p.caps[k]}px` : "";
    todo = todo.filter((p) => k < p.caps.length && !p.holds(ownLines(p.el, p.lh, p.s), k));
  }
}

/** past the view, still fitted before paint: a scroll set after the fit (the end pinned again to a new composer
 *  height) still opens on fitted bubbles */
const NEAR_PX = 120;

/** the scroller's view and `reach` past it on both sides (client y) */
function around(scroller: HTMLElement | null, reach: (height: number) => number): [number, number] {
  const view = scroller?.getBoundingClientRect() ?? { top: 0, bottom: innerHeight, height: innerHeight };
  return [view.top - reach(view.height), view.bottom + reach(view.height)];
}

/** the bubbles of `els` (in page order) between client y `top` and `bottom`: [first, past the last) */
function band(els: HTMLElement[], top: number, bottom: number): [number, number] {
  // the first bubble that reaches the band, by halves; then on to the first past it
  let a = 0;
  let b = els.length;
  while (a < b) {
    const mid = (a + b) >> 1;
    if (els[mid]!.getBoundingClientRect().bottom < top) a = mid + 1;
    else b = mid;
  }
  let z = a;
  while (z < els.length && els[z]!.getBoundingClientRect().top <= bottom) z++;
  return [a, z];
}

const bubblesOf = (content: HTMLElement, t: Thread) =>
  [...content.querySelectorAll<HTMLElement>(".bubble-text")].filter((el) => t.bubbles.has(el));

/** fit, in one batch, the thread's bubbles between client y `top` and `bottom` that are not fitted yet */
function fitBetween(content: HTMLElement, t: Thread, top: number, bottom: number): void {
  const all = bubblesOf(content, t);
  const [from, to] = band(all, top, bottom);
  const batch = all.slice(from, to).filter((el) => fittedAt.get(el) !== t.key);
  if (t.io) for (const el of batch) t.io.unobserve(el);
  fit(batch);
}

/**
 * Fit `els` (in page order). Into an open thread: all now. Opening (or after a width change): now only what a first
 * paint shows (the view and NEAR_PX past it); the rest waits for the thread's IntersectionObserver. When one comes
 * within a screen of view, everything not yet fitted within two screens is fitted with it, after a paint, off screen:
 * one batch (one layout) per screen or so of scrolling, not one per bubble (a batch of two a frame came to ~1 ms each
 * in WebKit, 220 ms over 500 bubbles). Older pages go with their mount: by batches they came to ~70% more in all
 * (a layout each), and the mount lays them out anyway.
 */
function place(content: HTMLElement, t: Thread, els: HTMLElement[], opening: boolean): void {
  if (!els.length) return;
  const key = keyOf(content);
  if (!t.key) t.key = key;
  // not laid out (a hidden screen): its first size change places it
  if (key.startsWith("0:")) return;
  if (!opening && t.open) {
    fit(els);
    return;
  }
  t.open = true;
  const scroller = content.closest<HTMLElement>(".screen-scroll");
  const [a, z] = band(els, ...around(scroller, () => NEAR_PX));
  const near = els.slice(a, z);
  fit(near);
  // after a width change some of these may still be watched from before
  if (t.io) for (const el of near) t.io.unobserve(el);
  const rest = [...els.slice(0, a), ...els.slice(z)];
  if (!rest.length) return;
  t.io ??= new IntersectionObserver(
    (entries) => {
      if (!t.io || !entries.some((e) => e.isIntersecting)) return;
      fitBetween(content, t, ...around(scroller, (h) => 2 * h));
    },
    { root: scroller, rootMargin: "100% 0px" },
  );
  for (const el of rest) t.io.observe(el);
}

/**
 * The scroller is about to be set to `top` (a scrollTop) and may then glide to `through`, above or below: fit, now,
 * what is not fitted yet within two screens of either view and between them, as the observer would on the way. The
 * observer hears of a jump only after the paint that shows it (a frame of bubbles at full width), and in WebKit its
 * fit while a smooth scroll ran stopped the scroll ("새 메시지" from far up stayed 1.5 screens short of the end).
 * Nothing waiting (no observer): every bubble was fitted with its opening or its mount.
 */
export function fitAhead(content: HTMLElement, top: number, through = top): void {
  const t = threads.get(content);
  const scroller = content.closest<HTMLElement>(".screen-scroll");
  if (!t?.io || !scroller) return;
  const max = scroller.scrollHeight - scroller.clientHeight;
  const by = (y: number) => Math.max(0, Math.min(y, max)) - scroller.scrollTop;
  const [from, to] = around(scroller, (h) => 2 * h);
  fitBetween(content, t, from + by(Math.min(top, through)), to + by(Math.max(top, through)));
}

/** width or text size changed: drop every cap and place the thread's bubbles again */
function refit(content: HTMLElement, t: Thread): void {
  const all = bubblesOf(content, t);
  for (const el of all) {
    fittedAt.delete(el);
    if (el.style.maxWidth) el.style.maxWidth = "";
  }
  place(content, t, all, true);
}

/** the thread's width or text size is not what it was placed at: place it again */
function rekey(content: HTMLElement, t: Thread): void {
  const key = keyOf(content);
  if (key === t.key) return;
  const had = t.key;
  t.key = key;
  if (had) refit(content, t);
}

let ro: ResizeObserver | null = null;
function onResize(entries: ResizeObserverEntry[]): void {
  for (const e of entries) {
    const content = e.target as HTMLElement;
    const t = threads.get(content);
    if (t) rekey(content, t);
  }
}

let fontsHeard = false;
function hearFonts(): void {
  if (fontsHeard || typeof document.fonts?.addEventListener !== "function") return;
  fontsHeard = true;
  document.fonts.addEventListener("loadingdone", () => {
    for (const [content, t] of threads) refit(content, t);
  });
}

const pending = new Set<HTMLElement>();
let queued = false;
function flush(): void {
  queued = false;
  const by = new Map<HTMLElement, HTMLElement[]>();
  for (const el of pending) {
    const content = home.get(el);
    if (!content || !el.isConnected) continue;
    const list = by.get(content);
    if (list) list.push(el);
    else by.set(content, [el]);
  }
  pending.clear();
  for (const [content, els] of by) {
    const t = threads.get(content);
    // mounted together: page order (an older page above, a new message below)
    const order = (x: HTMLElement, y: HTMLElement) =>
      x.compareDocumentPosition(y) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
    if (t) place(content, t, els.sort(order), false);
  }
}

/**
 * A text size change is placed before any observer hears of it. tierStore tells its listeners before tier.ts writes
 * --text-scale (recompute: set, then apply), so a microtask from here runs once the new size is on <html>, still in the
 * same task: the caps are in before layout is read for the next frame, and the key they were placed at is the one the
 * observer then brings (nothing to do). Placed from the observer instead, the caps changed the thread's height after
 * the observers had read it, and ThreadView's (same box, same depth) was left undelivered: WebKit reported
 * "ResizeObserver loop completed with undelivered notifications" on 1.3 → 1. Heard from module load, so before any
 * screen's own tierStore listener: one that reads the rows in a microtask of its own reads them with these caps in.
 */
let scale = tierStore.get().textScale;
let scaleQueued = false;
tierStore.subscribe(() => {
  const next = tierStore.get().textScale;
  if (next === scale) return;
  scale = next;
  if (scaleQueued) return;
  scaleQueued = true;
  queueMicrotask(() => {
    scaleQueued = false;
    for (const [content, t] of threads) rekey(content, t);
  });
});

/**
 * Fit a bubble's text (`.bubble-text` inside `.thread-content`) now and whenever its thread's width changes. Call
 * from a layout effect: the first fit runs after the commit, before paint. Returns the cleanup.
 */
export function fitBubble(el: HTMLElement): () => void {
  const content = el.closest<HTMLElement>(".thread-content");
  if (!content) return () => {};
  let t = threads.get(content);
  if (!t) {
    t = { key: "", bubbles: new Set(), io: null, open: false };
    threads.set(content, t);
    (ro ??= new ResizeObserver(onResize)).observe(content);
    hearFonts();
  }
  const thread = t;
  thread.bubbles.add(el);
  home.set(el, content);
  pending.add(el);
  if (!queued) {
    queued = true;
    queueMicrotask(flush);
  }
  return () => {
    pending.delete(el);
    fittedAt.delete(el);
    thread.io?.unobserve(el);
    el.style.maxWidth = "";
    thread.bubbles.delete(el);
    if (!thread.bubbles.size && threads.get(content) === thread) {
      threads.delete(content);
      ro?.unobserve(content);
      thread.io?.disconnect();
    }
  };
}
