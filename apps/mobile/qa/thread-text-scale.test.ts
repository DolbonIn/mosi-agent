// The text size changes under an open thread (ThreadView followTextScale, DD 2251 / 0007): reading in the middle, the
// row at the top of the view stays at the same y, and inside a long answer filling the view, the character at the top
// line does; at the end, the list stays at the end. The size changes the way both paths apply it (화면 및 디자인 on this
// device, another device's settings): motion/tier.ts setDisplayPrefs, which tells tierStore's listeners before it
// writes --text-scale. A fake scroller lays its rows out (and a long answer its text lines) from the --text-scale
// tier.ts last wrote, and floors scrollTop as WebKit does.
//   bun test ./qa/thread-text-scale.test.ts
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { setDisplayPrefs, tierStore } from "../src/motion/tier";
import { followTextScale } from "../src/screens/chat/ThreadView";

let drawn = 1; // the --text-scale the fake layout uses: the one tier.ts last wrote
const g = globalThis as Record<string, unknown>;
const saved = { document: g.document, raf: g.requestAnimationFrame, caf: g.cancelAnimationFrame, style: g.getComputedStyle, ro: g.ResizeObserver };
/** ResizeObservers made since the last reset: a delivery calls every connected one, in the order they were made */
let observers: { cb: () => void; on: boolean }[] = [];
const deliver = () => {
  for (const o of observers) if (o.on) o.cb();
};
const frames = new Map<number, (t: number) => void>();
let frameId = 0;
const nextFrame = () => {
  const due = [...frames.values()];
  frames.clear();
  for (const f of due) f(0);
};
const micro = () => new Promise<void>((ok) => setTimeout(ok, 0));

beforeAll(() => {
  g.document = {
    documentElement: {
      dataset: {},
      style: {
        setProperty(k: string, v: string) {
          if (k === "--text-scale") drawn = Number(v);
        },
      },
    },
    querySelector: () => null,
    // the long answer's text and card (thread({ long })): caret, character boxes, walking its text, the card under a point
    caretRangeFromPoint: (x: number, y: number) => world?.caret(x, y) ?? null,
    createRange: () => world!.range(),
    createTreeWalker: (root: unknown) => world!.walker(root),
    elementFromPoint: (x: number, y: number) => world?.under(x, y) ?? null,
  };
  g.requestAnimationFrame = (f: (t: number) => void) => {
    frames.set(++frameId, f);
    return frameId;
  };
  g.cancelAnimationFrame = (id: number) => void frames.delete(id);
  g.getComputedStyle = () => ({ paddingTop: `${PAD_TOP}px` }); // the view starts under the top bar
  g.ResizeObserver = class {
    o: { cb: () => void; on: boolean };
    constructor(cb: () => void) {
      this.o = { cb, on: false };
      observers.push(this.o);
    }
    observe() {
      this.o.on = true;
    }
    disconnect() {
      this.o.on = false;
    }
  };
  setDisplayPrefs({ textScale: 1 });
});
afterAll(() => {
  setDisplayPrefs({ textScale: 1 });
  for (const [k, v] of [["document", saved.document], ["requestAnimationFrame", saved.raf], ["cancelAnimationFrame", saved.caf], ["getComputedStyle", saved.style], ["ResizeObserver", saved.ro]] as const) {
    if (v === undefined) delete g[k];
    else g[k] = v;
  }
});

const VIEW_TOP = 40; // the scroller's top in the viewport
const PAD_TOP = 96;
const PAD_BOTTOM = 180;
const CLIENT = 700;
const WIDTH = 390;
/** a long answer's text: lines LINE px tall at 1.0 (they grow with the size), CH characters each, PAD above and below */
const LINE = 24;
const CH = 20;
const PAD = 10;
/** where ThreadView and DD's probe look for the character being read: this far below the top line, at the row's left + 24 */
const READ = 8;
let world: ReturnType<typeof thread> | null = null;

/** 40 rows: a fixed part (padding, avatar, gaps) plus text that grows with the drawn size; `extra` = late layout. With
 * `long`, row `long.at` is an answer of `long.lines` text lines (or, `card`, a card of that height with no text) */
function thread(long?: { at: number; lines: number; card?: boolean }) {
  const rows = Array.from({ length: 40 }, (_, i) => ({ fixed: 18 + (i % 3) * 7, text: 41.3 + (i % 5) * 17.7, extra: 0 }));
  if (long) rows[long.at] = { fixed: 2 * PAD, text: long.lines * LINE, extra: 0 };
  const h = (r: (typeof rows)[number]) => r.fixed + r.text * drawn + r.extra;
  let st = 0;
  const on = new Map<string, Set<() => void>>();
  const el = {
    get scrollHeight() {
      return Math.round(PAD_TOP + rows.reduce((a, r) => a + h(r), 0) + PAD_BOTTOM);
    },
    clientHeight: CLIENT,
    get scrollTop() {
      return st;
    },
    set scrollTop(v: number) {
      st = Math.max(0, Math.min(Math.floor(v), el.scrollHeight - CLIENT));
    },
    getBoundingClientRect: () => ({ top: VIEW_TOP, bottom: VIEW_TOP + CLIENT, height: CLIENT }),
    addEventListener(t: string, f: () => void) {
      if (!on.has(t)) on.set(t, new Set());
      on.get(t)!.add(f);
    },
    removeEventListener(t: string, f: () => void) {
      on.get(t)?.delete(f);
    },
    fire(t: string) {
      for (const f of [...(on.get(t) ?? [])]) f();
    },
    listeners: () => [...on.values()].reduce((a, s) => a + s.size, 0),
  };
  const rowTop = (i: number) => {
    let top = VIEW_TOP + PAD_TOP - st;
    for (let k = 0; k < i; k++) top += h(rows[k]!);
    return top;
  };
  const text = long && !long.card ? { nodeType: 3, length: long.lines * CH, isConnected: true } : null;
  const card = long?.card ? { nodeType: 1, isConnected: true, getBoundingClientRect: () => ({ top: rowTop(long.at) + PAD, height: long.lines * LINE * drawn }) } : null;
  const children = rows.map((r, i) => ({
    isConnected: true,
    getBoundingClientRect() {
      const top = rowTop(i);
      return { top, bottom: top + h(r), height: h(r), left: 0, right: WIDTH };
    },
    contains: (n: unknown) => i === long?.at && (n === text || n === card),
  }));
  const c = { children };
  /** character k's box: its text line's top + 3 px, 18 px tall (both grow with the size) */
  const charBox = (k: number) => {
    const top = rowTop(long!.at) + PAD + Math.floor(k / CH) * LINE * drawn + 3 * drawn;
    return { top, bottom: top + 18 * drawn, height: 18 * drawn };
  };
  /** the text line at height y in the long answer (clamped to its first and last), or null outside its text */
  const lineAt = (y: number) => {
    if (!text) return null;
    const top = rowTop(long!.at) + PAD;
    if (y < top - PAD || y >= top + long!.lines * LINE * drawn + PAD) return null;
    return Math.max(0, Math.min(long!.lines - 1, Math.floor((y - top) / (LINE * drawn))));
  };
  const caret = (x: number, y: number) => {
    const n = lineAt(y);
    return n === null ? null : { startContainer: text, startOffset: n * CH + Math.min(CH - 1, Math.floor(x / 12)) };
  };
  const range = () => {
    let at = 0;
    let all = false;
    return {
      setStart: (_n: unknown, o: number) => void (at = o),
      setEnd: () => {},
      selectNodeContents: () => void (all = true),
      getBoundingClientRect() {
        if (!all) return charBox(at);
        const top = rowTop(long!.at) + PAD;
        return { top, bottom: top + long!.lines * LINE * drawn, height: long!.lines * LINE * drawn };
      },
    };
  };
  const walker = (root: unknown) => {
    let done = !text || root !== children[long!.at];
    return { nextNode: () => (done ? null : ((done = true), text)) };
  };
  const under = (_x: number, y: number) => {
    if (!card) return null;
    const b = card.getBoundingClientRect();
    return y >= b.top && y < b.top + b.height ? card : null;
  };
  const gap = () => el.scrollHeight - CLIENT - el.scrollTop;
  /** the first row starting in view (under the top padding), read here independently of ThreadView */
  const topOne = () => children.find((r) => r.getBoundingClientRect().top >= VIEW_TOP + PAD_TOP)!;
  /** put row i's top `dy` px below the view's top line (negative: above it, cut by the line) */
  const place = (i: number, dy: number) => {
    st = 0;
    el.scrollTop = children[i]!.getBoundingClientRect().top - VIEW_TOP - PAD_TOP - dy;
  };
  const y = (r: (typeof children)[number]) => r.getBoundingClientRect().top - VIEW_TOP;
  /** the character being read in the long answer, the way DD's probe picks it: READ px below the top line, x = left + 24 */
  const reading = () => caret(24, VIEW_TOP + PAD_TOP + READ)!.startOffset;
  const charY = (k: number) => charBox(k).top - VIEW_TOP;
  const t = { rows, el, c, gap, topOne, y, place, caret, range, walker, under, reading, charY, card };
  world = t;
  return t;
}

let stops: (() => void)[] = [];
function follow(t: ReturnType<typeof thread>, where: { atEnd: boolean; placed?: boolean }) {
  const puts: number[] = [];
  const stop = followTextScale(
    () => (where.placed === false ? null : ({ el: t.el, c: t.c, atEnd: where.atEnd } as never)),
    (el, top) => {
      puts.push(top);
      el.scrollTop = top;
    },
  );
  stops.push(stop);
  return { puts, stop };
}
afterEach(() => {
  for (const s of stops) s();
  stops = [];
  world = null;
  frames.clear();
  observers = [];
  setDisplayPrefs({ textScale: 1 });
});

describe("text size changes under an open thread", () => {
  test("reading in the middle: the row at the top stays at its first y (≤ 0.5 px) through 1.3, 0.9, 1", async () => {
    const t = thread();
    follow(t, { atEnd: false });
    t.el.scrollTop = 2100;
    const row = t.topOne();
    const y0 = t.y(row);
    for (const v of [1.3, 0.9, 1]) {
      setDisplayPrefs({ textScale: v });
      expect(tierStore.get().textScale).toBe(v);
      // the new size is in and nothing has put the row back yet: it moved (the fake follows --text-scale)
      expect(Math.abs(t.y(row) - y0)).toBeGreaterThan(20);
      await micro();
      expect(Math.abs(t.y(row) - y0)).toBeLessThanOrEqual(0.5);
      for (let i = 0; i < 4; i++) nextFrame();
      expect(Math.abs(t.y(row) - y0)).toBeLessThanOrEqual(0.5);
    }
  });

  test("at the end: the list stays at the end through 1.3, 0.9, 1", async () => {
    const t = thread();
    follow(t, { atEnd: true });
    t.el.scrollTop = 1e9;
    expect(t.gap()).toBe(0);
    for (const v of [1.3, 0.9, 1]) {
      setDisplayPrefs({ textScale: v });
      await micro();
      expect(t.gap()).toBe(0);
    }
  });

  test("late layout over the next frames (bubble fitting) is followed, then the frames stop", async () => {
    const t = thread();
    follow(t, { atEnd: false });
    t.el.scrollTop = 2100;
    const row = t.topOne();
    const y0 = t.y(row);
    setDisplayPrefs({ textScale: 1.3 });
    await micro();
    t.rows[2]!.extra = 37; // a row above grows a frame later
    nextFrame();
    expect(Math.abs(t.y(row) - y0)).toBeLessThanOrEqual(0.5);
    let n = 0;
    while (frames.size && n < 50) {
      nextFrame();
      n++;
    }
    expect(frames.size).toBe(0);
    expect(n).toBeLessThan(12);
    expect(t.el.listeners()).toBe(0);
  });

  test("late layout in the same frame (bubble fitting in an earlier ResizeObserver) is followed before it is drawn", async () => {
    const t = thread();
    follow(t, { atEnd: false });
    t.el.scrollTop = 2100;
    const row = t.topOne();
    const y0 = t.y(row);
    setDisplayPrefs({ textScale: 1.3 });
    await micro();
    expect(observers.filter((o) => o.on).length).toBe(1);
    t.rows[2]!.extra = 37; // bubbleFit's observer (made before) re-fits a bubble above, then this one runs
    deliver();
    expect(Math.abs(t.y(row) - y0)).toBeLessThanOrEqual(0.5);
    while (frames.size) nextFrame();
    expect(observers.filter((o) => o.on).length).toBe(0);
  });

  test("the person's touch stops the following: the list is theirs again", async () => {
    const t = thread();
    follow(t, { atEnd: false });
    t.el.scrollTop = 2100;
    const row = t.topOne();
    const y0 = t.y(row);
    setDisplayPrefs({ textScale: 1.3 });
    await micro();
    expect(Math.abs(t.y(row) - y0)).toBeLessThanOrEqual(0.5);
    t.el.fire("touchstart");
    t.rows[2]!.extra = 37;
    deliver();
    nextFrame();
    expect(frames.size).toBe(0);
    expect(observers.filter((o) => o.on).length).toBe(0);
    expect(t.y(row) - y0).toBeGreaterThan(36);
    expect(t.el.listeners()).toBe(0);
  });

  test("a theme change, the same size again, or a list not placed yet moves nothing", async () => {
    const t = thread();
    const a = follow(t, { atEnd: false });
    t.el.scrollTop = 2100;
    setDisplayPrefs({ theme: "dark" });
    setDisplayPrefs({ textScale: 1 });
    await micro();
    nextFrame();
    setDisplayPrefs({ theme: "system" });
    expect(a.puts).toEqual([]);
    a.stop();
    const b = follow(t, { atEnd: false, placed: false });
    setDisplayPrefs({ textScale: 1.3 });
    await micro();
    nextFrame();
    expect(b.puts).toEqual([]);
    expect(frames.size).toBe(0);
  });

  test("two changes in one task: the row read before the first stays put", async () => {
    const t = thread();
    follow(t, { atEnd: false });
    t.el.scrollTop = 2100;
    const row = t.topOne();
    const y0 = t.y(row);
    setDisplayPrefs({ textScale: 1.3 });
    setDisplayPrefs({ textScale: 0.9 });
    await micro();
    expect(Math.abs(t.y(row) - y0)).toBeLessThanOrEqual(0.5);
  });

  test("slider key steps a frame apart (1 → 1.3 by 0.05): the same row ends within 0.5 px", async () => {
    const t = thread();
    follow(t, { atEnd: false });
    t.el.scrollTop = 2100;
    const row = t.topOne();
    const y0 = t.y(row);
    for (let v = 1.05; v < 1.31; v += 0.05) {
      setDisplayPrefs({ textScale: Math.round(v * 100) / 100 });
      await micro();
      nextFrame();
      expect(Math.abs(t.y(row) - y0)).toBeLessThanOrEqual(0.5);
    }
    expect(tierStore.get().textScale).toBe(1.3);
  });

  test("slider steps after the frames have stopped (keys pressed slowly): still the same row within 0.5 px", async () => {
    const t = thread();
    follow(t, { atEnd: false });
    t.el.scrollTop = 2100;
    const row = t.topOne();
    const y0 = t.y(row);
    for (const v of [0.95, 0.9, 0.95, 1, 1.05, 1.1, 1.15, 1.2, 1.25, 1.3]) {
      setDisplayPrefs({ textScale: v });
      await micro();
      while (frames.size) nextFrame();
      expect(Math.abs(t.y(row) - y0)).toBeLessThanOrEqual(0.5);
    }
  });

  test("once the person has scrolled, the next change keeps the row then at the top", async () => {
    const t = thread();
    follow(t, { atEnd: false });
    t.el.scrollTop = 2100;
    setDisplayPrefs({ textScale: 1.3 });
    await micro();
    while (frames.size) nextFrame();
    t.el.scrollTop = 900; // scrolled up (a scroll that is not this one's)
    const row = t.topOne();
    const y0 = t.y(row);
    setDisplayPrefs({ textScale: 1 });
    await micro();
    expect(Math.abs(t.y(row) - y0)).toBeLessThanOrEqual(0.5);
  });

  test("a row the top line cuts with most of it showing is the one kept; one mostly hidden is not", async () => {
    // row 20 is 73.3 px tall at 1.0: 12 px above the line (61 show) / 50 px above (23 show: row 21, below, is kept)
    for (const [dy, kept] of [[-12, 20], [-50, 21]] as const) {
      const t = thread();
      const a = follow(t, { atEnd: false });
      t.place(20, dy);
      const row = t.c.children[kept]!;
      const other = t.c.children[kept === 20 ? 21 : 20]!;
      const y0 = t.y(row);
      const o0 = t.y(other);
      setDisplayPrefs({ textScale: 1.3 });
      await micro();
      expect(Math.abs(t.y(row) - y0)).toBeLessThanOrEqual(0.5);
      expect(Math.abs(t.y(other) - o0)).toBeGreaterThan(5);
      a.stop();
      setDisplayPrefs({ textScale: 1 });
    }
  });

  test("inside a long answer filling the view (30 %, 60 %): the character at the top line stays, not the answer's top", async () => {
    for (const f of [0.3, 0.6]) {
      const t = thread({ at: 12, lines: 90 }); // 2180 px at 1.0: taller than the view at every size
      const a = follow(t, { atEnd: false });
      const long = t.c.children[12]!;
      t.place(12, -f * long.getBoundingClientRect().height);
      expect(long.getBoundingClientRect().bottom).toBeGreaterThan(VIEW_TOP + CLIENT);
      const k = t.reading();
      const y0 = t.charY(k);
      const top0 = t.y(long);
      for (const v of [1.3, 0.9, 1]) {
        setDisplayPrefs({ textScale: v });
        expect(Math.abs(t.charY(k) - y0)).toBeGreaterThan(20); // the new size moved it, nothing has put it back yet
        await micro();
        expect(Math.abs(t.charY(k) - y0)).toBeLessThanOrEqual(0.5);
        for (let n = 0; n < 4; n++) nextFrame();
        expect(Math.abs(t.charY(k) - y0)).toBeLessThanOrEqual(0.5);
        // keeping the answer's top instead pushes this text by what grew above it (DD 0007: +688 px at 30 %)
        if (v === 1.3) expect(Math.abs(t.y(long) - top0)).toBeGreaterThan(100);
      }
      a.stop();
      setDisplayPrefs({ textScale: 1 });
    }
  });

  test("a long answer whose end is in view (85 %): the character at the top line stays, the rows after it move", async () => {
    const t = thread({ at: 12, lines: 90 });
    follow(t, { atEnd: false });
    const long = t.c.children[12]!;
    t.place(12, -0.85 * long.getBoundingClientRect().height);
    expect(long.getBoundingClientRect().bottom).toBeLessThan(VIEW_TOP + CLIENT - 100);
    const next = t.c.children[13]!;
    const k = t.reading();
    const y0 = t.charY(k);
    const n0 = t.y(next);
    for (const v of [1.3, 0.9]) {
      setDisplayPrefs({ textScale: v });
      await micro();
      while (frames.size) nextFrame();
      expect(Math.abs(t.charY(k) - y0)).toBeLessThanOrEqual(0.5);
      expect(Math.abs(t.y(next) - n0)).toBeGreaterThan(10);
    }
  });

  test("slider steps inside a long answer, quick and slow: the same character ends within 0.5 px", async () => {
    const t = thread({ at: 12, lines: 90 });
    follow(t, { atEnd: false });
    t.place(12, -0.45 * t.c.children[12]!.getBoundingClientRect().height);
    const k = t.reading();
    const y0 = t.charY(k);
    for (const v of [1.05, 1.1, 1.15, 1.2, 1.25, 1.3]) {
      setDisplayPrefs({ textScale: v });
      await micro();
      nextFrame();
      expect(Math.abs(t.charY(k) - y0)).toBeLessThanOrEqual(0.5);
    }
    for (const v of [1.2, 1.1, 1, 0.95, 0.9]) {
      setDisplayPrefs({ textScale: v });
      await micro();
      while (frames.size) nextFrame();
      expect(Math.abs(t.charY(k) - y0)).toBeLessThanOrEqual(0.5);
    }
  });

  test("a shorter answer (it fits in the view) cut through its middle lines: the character at the top line stays", async () => {
    // 12 lines, 308 px at 1.0 (394 at 1.3): keeping its top moved the text at the line by what grew above it (a 390 px
    // answer cut at 40 %: +67 px in both engines)
    const t = thread({ at: 12, lines: 12 });
    follow(t, { atEnd: false });
    const row = t.c.children[12]!;
    t.place(12, -0.4 * row.getBoundingClientRect().height);
    expect(row.getBoundingClientRect().height).toBeLessThan(CLIENT - PAD_TOP);
    const k = t.reading();
    expect(Math.floor(k / CH)).toBe(5); // a middle line of the twelve
    const y0 = t.charY(k);
    for (const v of [1.3, 0.9]) {
      setDisplayPrefs({ textScale: v });
      await micro();
      while (frames.size) nextFrame();
      expect(Math.abs(t.charY(k) - y0)).toBeLessThanOrEqual(0.5);
    }
  });

  test("a shorter answer cut in its first or last text line is read as a whole: its top, or (mostly gone) the next row's", async () => {
    // line 12 px into the row (its first text line, 10–34 px): most of it shows, its top stays. Line 280 px into it (its
    // last line, 274–298 px): almost all of it is gone, the next row's top stays
    for (const [into, kept] of [[12, 12], [280, 13]] as const) {
      const t = thread({ at: 12, lines: 12 });
      const a = follow(t, { atEnd: false });
      t.place(12, -into);
      const row = t.c.children[kept]!;
      const y0 = t.y(row);
      for (const v of [1.3, 0.9]) {
        setDisplayPrefs({ textScale: v });
        await micro();
        expect(Math.abs(t.y(row) - y0)).toBeLessThanOrEqual(0.5);
      }
      a.stop();
      setDisplayPrefs({ textScale: 1 });
    }
  });

  test("no text at the top line (a card in a long answer): the point the line crosses in the card stays at the line", async () => {
    const t = thread({ at: 12, lines: 90, card: true });
    follow(t, { atEnd: false });
    t.place(12, -0.4 * t.c.children[12]!.getBoundingClientRect().height);
    const line = VIEW_TOP + PAD_TOP;
    const b0 = t.card!.getBoundingClientRect();
    const share = (line - b0.top) / b0.height;
    for (const v of [1.3, 0.9]) {
      setDisplayPrefs({ textScale: v });
      await micro();
      const b = t.card!.getBoundingClientRect();
      expect(Math.abs(b.top + share * b.height - line)).toBeLessThanOrEqual(0.5);
      expect(Math.abs(b.top - b0.top)).toBeGreaterThan(20);
    }
  });

  test("after unsubscribing nothing follows", async () => {
    const t = thread();
    const a = follow(t, { atEnd: false });
    a.stop();
    t.el.scrollTop = 2100;
    setDisplayPrefs({ textScale: 1.3 });
    await micro();
    nextFrame();
    expect(a.puts).toEqual([]);
  });
});
