import { memo, useLayoutEffect, useMemo, useRef, useState } from "react";
import { BlockFrame, keepsSpaces, parseBlocks, renderRuns, runsText, sliceRuns, type Block, type Run } from "./markdown";

/**
 * Streaming assistant text, by LINE (MOTION-SPEC §6.2, research §3-1 / §5-3): no per-character typewriter.
 *  - Text is committed only up to the last word boundary (어절), so a word never appears half-written.
 *  - Inside the live (last) block, every visual line is its own block-level span. When the tail line wraps, the
 *    engine finds the browser's own wrap offset (Range rects) and splits there: the finished part freezes and the
 *    new line mounts with a 2 px rise + fade (CSS, transform/opacity only). Words added to the current line just
 *    appear in place. Splitting happens in a layout effect, so the 2-line tail is never painted.
 *  - The frozen lines wrap exactly like the final paragraph, so when `done` swaps in the static markdown nothing moves.
 * Reduced motion: the rise is off (CSS), lines simply appear.
 */
export function commitPoint(text: string, done?: boolean): string {
  if (done) return text;
  const lastWs = Math.max(text.lastIndexOf(" "), text.lastIndexOf("\n"), text.lastIndexOf("\t"));
  let s = text.length - (lastWs + 1) <= 24 ? text.slice(0, lastWs + 1) : text;
  // hold back a trailing line that is only a markdown marker ("- ", "1.", "##") so it never flashes as text
  const nl = s.lastIndexOf("\n");
  const tail = s.slice(nl + 1);
  if (tail && /^\s*(#{1,3}|[-*•>]|\d{1,3}[.)]|`{1,3})?\s*$/.test(tail)) s = s.slice(0, nl + 1);
  return s;
}

export function StreamText({ text }: { text: string }) {
  const committed = commitPoint(text);
  const blocks = useMemo(() => parseBlocks(committed, true), [committed]);
  if (!blocks.length) return null;
  return (
    <div className="md md-stream">
      {blocks.map((b, k) => (
        <StreamBlock key={k} block={b} live={k === blocks.length - 1} />
      ))}
    </div>
  );
}

interface Line {
  key: number;
  start: number;
}

/*
 * A block or a line is drawn again only when what it shows changed. Every commit parses the draft anew, so the props
 * are new objects each time: they are compared by value (blocks and runs are plain data: strings, numbers, booleans,
 * arrays of runs; no functions, no cycles). Drawing every line again on every commit cost 0.4–0.6 s more script per
 * long answer once text was glued (Chrome, an 8.9k-character answer) and grew with the answer.
 */
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const x = a as Record<string, unknown>;
  const y = b as Record<string, unknown>;
  const kx = Object.keys(x);
  if (kx.length !== Object.keys(y).length) return false;
  for (const k of kx) if (!same(x[k], y[k])) return false;
  return true;
}
/** a line keeps its nodes while its runs read the same, in a block that keeps spaces as before (a bold-only line turns
 * into a head once its ** closes: its runs are glued apart from then on) */
export const sameLine = (a: { runs: Run[]; spaces?: boolean }, b: { runs: Run[]; spaces?: boolean }) => !!a.spaces === !!b.spaces && same(a.runs, b.runs);
/** the live block always redraws (it grows and splits its lines); one that stopped being live, only when it changed */
export const sameBlock = (a: { block: Block; live: boolean }, b: { block: Block; live: boolean }) => !a.live && !b.live && same(a.block, b.block);

const StreamLine = memo(function StreamLine({ runs, spaces }: { runs: Run[]; spaces: boolean }) {
  return <>{renderRuns(runs, spaces)}</>;
}, sameLine);

const StreamBlock = memo(function StreamBlock({ block, live }: { block: Block; live: boolean }) {
  return <StreamBlockInner block={block} live={live} />;
}, sameBlock);

function StreamBlockInner({ block, live }: { block: Block; live: boolean }) {
  const runs = "runs" in block ? block.runs : null;
  const text = runs ? runsText(runs) : "";
  const [lines, setLines] = useState<Line[]>([{ key: 0, start: 0 }]);
  const tail = useRef<HTMLSpanElement>(null);

  useLayoutEffect(() => {
    if (!live || !runs) return;
    const el = tail.current;
    if (!el) return;
    const lh = parseFloat(getComputedStyle(el).lineHeight) || 26;
    if (el.getBoundingClientRect().height < lh * 1.5) return;
    const off = wrapOffset(el, lh);
    if (off <= 0) return;
    setLines((ls) => {
      const start = ls[ls.length - 1]!.start + off;
      return start >= text.length ? ls : [...ls, { key: ls[ls.length - 1]!.key + 1, start }];
    });
  });

  if (!runs) return <BlockFrame block={block} />;
  const valid = lines.filter((l, k) => k === 0 || l.start < text.length);
  return (
    <BlockFrame block={block}>
      {valid.map((l, k) => {
        const end = valid[k + 1]?.start ?? text.length;
        return (
          <span key={l.key} ref={k === valid.length - 1 ? tail : undefined} className="sl">
            <StreamLine runs={sliceRuns(runs, l.start, end)} spaces={keepsSpaces(block)} />
          </span>
        );
      })}
    </BlockFrame>
  );
}

/** Offset (within `el`'s text) of the first character the browser placed on the second line, or −1. */
function wrapOffset(el: HTMLElement, lh: number): number {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  const starts: number[] = [];
  let total = 0;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    starts.push(total);
    nodes.push(n as Text);
    total += (n as Text).length;
  }
  if (total < 2) return -1;
  const text = nodes.map((n) => n.data).join("");
  const range = document.createRange();
  const top = (k: number) => {
    let i = nodes.length - 1;
    while (i > 0 && starts[i]! > k) i--;
    const node = nodes[i]!;
    const o = k - starts[i]!;
    range.setStart(node, o);
    range.setEnd(node, Math.min(node.length, o + 1));
    const rects = range.getClientRects();
    const r = rects.length ? rects[rects.length - 1]! : range.getBoundingClientRect();
    return r.top;
  };
  const top0 = top(0);
  let lo = 1;
  let hi = total - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    let k = mid;
    while (k < total && /\s/.test(text[k]!)) k++;
    if (k >= total) {
      hi = mid - 1;
      continue;
    }
    if (top(k) > top0 + lh / 2) {
      ans = k;
      hi = mid - 1;
    } else lo = mid + 1;
  }
  return ans;
}
