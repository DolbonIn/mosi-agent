/** The level chart (D10, DD 1935 §4 + DD 1949): geometry read back from the SVG string. Synthetic bars only. */
import { describe, expect, test } from "bun:test";
import { APP_THEME, DECK_CHART, DECK_THEME, FULL_VIEW, LABEL_PRIORITY, PHONE_CARD, labelEm, levelChart, niceTicks, stack, type ChartLevel } from "../src/chart";
import type { Bar } from "../src/types";
import { addDays } from "./fixtures";

/** 260 trading-ish days from 2025-11-03: a slow drift, a dip, a rebound (deterministic) */
function bars(n = 260): Bar[] {
  const out: Bar[] = [];
  let c = 30;
  for (let i = 0; i < n; i++) {
    const wave = Math.sin(i / 9) * 0.6 + (i > 200 && i < 230 ? -0.25 : i >= 230 ? 0.3 : 0.02);
    const o = c;
    c = Math.max(5, c + wave * 0.5);
    out.push({ t: addDays("2025-11-03", Math.floor(i * 1.4)), o, h: Math.max(o, c) + 0.4, l: Math.min(o, c) - 0.4, c, v: 100 + (i % 7) * 10 });
  }
  return out;
}
const B = bars();
const last = B.at(-1)!.c;
const LV: ChartLevel[] = [
  { kind: "stop", price: Math.round((last - 3) * 100) / 100 },
  { kind: "target1", price: Math.round((last + 2) * 100) / 100 },
  { kind: "support", price: Math.round((last - 1.5) * 100) / 100 },
  { kind: "buyZone", price: Math.round((last - 1) * 100) / 100, hi: Math.round((last - 0.5) * 100) / 100 },
];
const attrs = (svg: string, sel: RegExp) => [...svg.matchAll(sel)].map((m) => m[0]);
const num = (el: string, a: string) => Number(el.match(new RegExp(` ${a}="([-0-9.]+)"`))![1]);
const lines = (svg: string) => attrs(svg, /<line [^>]*data-level="[a-z0-9]+"[^>]*\/>/g).map((l) => ({ kind: l.match(/data-level="(\w+)"/)![1]!, y: num(l, "y1") }));
const labels = (svg: string) => attrs(svg, /<text [^>]*data-label="\w+"[^>]*>.*?<\/text>/g).map((t) => ({ kind: t.match(/data-label="(\w+)"/)![1]!, y: num(t, "y"), text: t.replace(/<[^>]+>/g, "") }));

describe("helpers", () => {
  test("stack: labels stay on their lines when they fit, and part evenly around a crowd when they do not", () => {
    expect(stack([10, 40, 70], 18, 0, 100)).toEqual([10, 40, 70]);
    expect(stack([50, 50], 18, 0, 100)).toEqual([41, 59]);
    expect(stack([0, 5], 18, 4, 100)).toEqual([4, 22]);
    expect(stack([95, 99], 18, 0, 100)).toEqual([82, 100]);
    const s = stack([10, 12, 14, 60], 18, 0, 200);
    expect(s.every((v, i) => i === 0 || v - s[i - 1]! >= 18 - 1e-9)).toBe(true);
  });
  test("niceTicks: at most four lines on 1 / 2 / 2.5 / 5 steps", () => {
    expect(niceTicks(23.4, 38.9)).toEqual([25, 30, 35]);
    expect(niceTicks(181_000, 204_000)).toEqual([185_000, 190_000, 195_000, 200_000]);
    for (const [a, b] of [[0.3, 0.9], [9, 41], [1200, 1290]] as const) expect(niceTicks(a, b).length).toBeLessThanOrEqual(4);
  });
  test("labelEm × size is at least the width measured in Chrome and WebKit on macOS (word at the label weight, price 400)", () => {
    // getComputedTextLength, 11-26, app font (tokens.css --font-text); both engines gave the same widths to 0.1 px
    const measured: [string, number, number][] = [
      ["1차 익절 39.87", 13, 85.4], ["1차 익절 136.50", 13, 93.5], ["손절 189,400", 13, 78.5], ["1차 익절 1,234.50", 13, 105.4],
      ["매수 검토", 13, 48.4], ["2차 익절 ↑", 13, 59.3], ["1차 익절 39.87", 15, 97.5], ["1차 익절 1,234.50", 15, 120.1], ["2차 익절 ↑", 15, 67.9],
      // the current price, all at the label weight
      ["189,400", 13, 55.1], ["1,234,567.89", 13, 88.9], ["1,234,567.89", 15, 103.5],
    ];
    for (const [text, size, px] of measured) expect(labelEm(text) * size).toBeGreaterThanOrEqual(px);
    // and not so loose that a two-digit target loses its price on the phone card (room 90 px)
    expect(labelEm("1차 익절 39.87") * 13).toBeLessThanOrEqual(90);
    expect(labelEm("1차 익절 136.50") * 13).toBeGreaterThan(90);
  });
  test("priority: 손절 > 현재가 > 1차 익절 > 매수 검토 > 저항 > 지지 > 2·3차 익절", () => {
    expect(LABEL_PRIORITY).toEqual(["stop", "current", "target1", "buyZone", "resistance", "support", "target2", "target3"]);
  });
});

describe("phone card", () => {
  const c = levelChart({ bars: B, levels: LV, summary: "합성 & 예시 <차트>" }, APP_THEME, PHONE_CARD);
  test("326 × 264, plot 194 wide (left 32, right 100), role img with the server's sentence escaped", () => {
    expect([c.width, c.height]).toEqual([326, 264]);
    expect(c.plot.x1 - c.plot.x0).toBe(194);
    expect(c.svg).toContain('role="img" aria-label="합성 &amp; 예시 &lt;차트&gt;"');
  });
  test("60 candles, body max(2, floor(slot × 0.6)); no volume profile, no MACD", () => {
    const candles = attrs(c.svg, /<rect [^>]*data-role="candle"[^>]*\/>/g);
    expect(candles.length).toBe(60);
    expect(new Set(candles.map((r) => num(r, "width")))).toEqual(new Set([Math.max(2, Math.floor((194 / 60) * 0.6))]));
    expect(c.svg).not.toContain('data-role="profile"');
    expect(c.svg).not.toContain('data-role="macd"');
    expect(["ma20", "ma50", "ma200", "vwap", "rsi"].every((k) => c.svg.includes(`data-role="${k}"`))).toBe(true);
  });
  test("every level line inside the plot box; the band too", () => {
    for (const l of lines(c.svg)) {
      expect(l.y).toBeGreaterThanOrEqual(c.plot.y0);
      expect(l.y).toBeLessThanOrEqual(c.plot.y1);
    }
    expect(lines(c.svg).map((l) => l.kind).sort()).toEqual(["stop", "support", "target1"]);
    const band = attrs(c.svg, /<rect [^>]*data-level="buyZone"[^>]*\/>/g);
    expect(band.length).toBe(1);
    expect(num(band[0]!, "y")).toBeGreaterThanOrEqual(c.plot.y0);
    expect(num(band[0]!, "y") + num(band[0]!, "height")).toBeLessThanOrEqual(c.plot.y1);
  });
  test("labels: one line each, ≥ 18 apart, inside the main panel; the band's word alone; the current price a bare number", () => {
    const ls = labels(c.svg).sort((a, b) => a.y - b.y);
    expect(ls.every((l, i) => i === 0 || l.y - ls[i - 1]!.y >= 18 - 0.11)).toBe(true);
    expect(ls.every((l) => l.y >= c.plot.y0 && l.y <= c.plot.y1 + 13)).toBe(true);
    const by = Object.fromEntries(ls.map((l) => [l.kind, l.text]));
    expect(by.stop).toBe(`손절 ${LV[0]!.price.toFixed(2)}`);
    expect(by.buyZone).toBe("매수 검토");
    expect(by.current).toBe(last.toFixed(2));
    expect(c.issues).toEqual([]);
  });
  test("app colours are CSS variables only (no hex), month ticks in Korean", () => {
    expect(c.svg.match(/#[0-9a-fA-F]{3,6}\b/g)).toBeNull();
    expect(c.svg).toMatch(/data-role="date">\d{1,2}월</);
  });
});

describe("off-scale levels and crowded labels", () => {
  test("a level that would squeeze the candles under half the plot: no line, its word + arrow, level_offscale", () => {
    const far = levelChart({ bars: B, levels: [...LV, { kind: "target2", price: last * 3 }], summary: "x" }, APP_THEME, PHONE_CARD);
    expect(lines(far.svg).some((l) => l.kind === "target2")).toBe(false);
    expect(labels(far.svg).find((l) => l.kind === "target2")?.text).toBe("2차 익절 ↑");
    expect(far.issues).toContainEqual({ code: "level_offscale", kind: "target2", price: last * 3 });
    const low = levelChart({ bars: B, levels: [...LV, { kind: "support", price: 0.01 }], summary: "x" }, APP_THEME, PHONE_CARD);
    expect(labels(low.svg).some((l) => l.text === "지지 ↓")).toBe(true);
    for (const l of lines(low.svg)) expect(l.y).toBeLessThanOrEqual(low.plot.y1);
  });
  test("a level just outside the candles is taken into the range and drawn", () => {
    const hi = Math.max(...B.slice(-60).map((b) => b.h));
    const near = levelChart({ bars: B, levels: [{ kind: "resistance", price: hi + 0.2 }], summary: "x" }, APP_THEME, PHONE_CARD);
    expect(lines(near.svg).map((l) => l.kind)).toEqual(["resistance"]);
    expect(near.issues).toEqual([]);
  });
  test("too many labels for the column: the lowest priority goes first, never 손절 or the current price", () => {
    const tiny = { ...PHONE_CARD, mainH: 90 };
    const all: ChartLevel[] = [
      ...LV,
      { kind: "resistance", price: last + 1 },
      { kind: "target2", price: last + 2.5 },
      { kind: "target3", price: last + 2.8 },
    ];
    const c = levelChart({ bars: B, levels: all, summary: "x" }, APP_THEME, tiny);
    const dropped = c.issues.filter((i) => i.code === "label_dropped").map((i) => i.kind);
    expect(dropped.length).toBeGreaterThan(0);
    const kept = labels(c.svg).map((l) => l.kind);
    expect(kept).toContain("stop");
    expect(kept).toContain("current");
    const rank = (k: string) => LABEL_PRIORITY.indexOf(k as never);
    expect(Math.min(...dropped.map(rank))).toBeGreaterThan(Math.max(...kept.map(rank)));
  });
});

describe("label column width (DD 2145): clamp(widest drawn label + 10, right, rightMax)", () => {
  const scaled = (k: number) => B.map((b) => ({ ...b, o: b.o * k, h: b.h * k, l: b.l * k, c: b.c * k }));
  const rightOf = (c: { width: number; plot: { x1: number } }) => c.width - c.plot.x1;
  const at = (price: number, digits = 2) => {
    const k = price / (last + 2);
    return levelChart({ bars: scaled(k), levels: [{ kind: "target1", price }], summary: "x", digits }, APP_THEME, PHONE_CARD);
  };
  test("two-digit dollars keep 100 (plot 194)", () => {
    const c = levelChart({ bars: B, levels: LV, summary: "x" }, APP_THEME, PHONE_CARD);
    expect(rightOf(c)).toBe(100);
    expect(c.plot.x1 - c.plot.x0).toBe(194);
  });
  test("1차 익절 136.50 (93.5 px measured): the column widens to about 107 and the price stays", () => {
    const c = at(136.5);
    expect(rightOf(c)).toBe(Math.ceil(labelEm("1차 익절 136.50") * 13 + 10));
    expect(rightOf(c)).toBeGreaterThan(100);
    expect(rightOf(c)).toBeLessThan(112);
    expect(labels(c.svg).find((l) => l.kind === "target1")?.text).toBe("1차 익절 136.50");
    expect(c.issues).toEqual([]);
  });
  test("won 189,400: about 116, the price stays", () => {
    const c = at(189_400, 0);
    expect(rightOf(c)).toBeGreaterThan(108);
    expect(rightOf(c)).toBeLessThanOrEqual(120);
    expect(labels(c.svg).find((l) => l.kind === "target1")?.text).toBe("1차 익절 189,400");
  });
  test("past the cap: 128, the price gives way to its word, label_price_dropped", () => {
    const c = at(12_345_678, 0);
    expect(rightOf(c)).toBe(128);
    expect(labels(c.svg).find((l) => l.kind === "target1")?.text).toBe("1차 익절");
    expect(c.issues).toContainEqual({ code: "label_price_dropped", kind: "target1", price: 12_345_678 });
  });
  test("the deck: 120 at least, 160 at most; 1차 익절 1,234.50 (120.1 px) fits", () => {
    const k = 1234.5 / (last + 2);
    const d = levelChart({ bars: scaled(k), levels: [{ kind: "target1", price: 1234.5 }], summary: "x", unit: "USD", asOf: "11월 26일 종가 기준", source: "Yahoo" }, DECK_THEME, DECK_CHART);
    expect(rightOf(d)).toBeGreaterThan(120);
    expect(rightOf(d)).toBeLessThanOrEqual(160);
    expect(labels(d.svg).find((l) => l.kind === "target1")?.text).toBe("1차 익절 1,234.50");
  });
  test("a dropped label (crowding) does not widen the column; the same input gives the same chart", () => {
    const c1 = at(136.5);
    expect(at(136.5).svg).toBe(c1.svg);
    const tiny = { ...PHONE_CARD, mainH: 60 };
    const k = 136.5 / (last + 2);
    const c = levelChart({ bars: scaled(k), levels: [{ kind: "stop", price: Math.round((last - 3) * k * 100) / 100 }, { kind: "target3", price: 136.5 }], summary: "x" }, APP_THEME, tiny);
    // two slots: the current price and 손절 stay, 3차 익절 (the widest) is dropped and does not size the column
    expect(c.issues).toContainEqual({ code: "label_dropped", kind: "target3", price: 136.5 });
    expect(labels(c.svg).map((l) => l.kind).sort()).toEqual(["current", "stop"]);
    expect(rightOf(c)).toBe(100);
  });
});

describe("price ticks on the left: never clipped", () => {
  const scaled = (k: number) => B.map((b) => ({ ...b, o: b.o * k, h: b.h * k, l: b.l * k, c: b.c * k, v: b.v }));
  const ticks = (svg: string) => attrs(svg, /<text [^>]*data-role="tick"[^>]*>[^<]*<\/text>/g).map((t) => ({ x: num(t, "x"), text: t.replace(/<[^>]+>/g, "") }));
  test("two-digit dollars: left 32", () => {
    const c = levelChart({ bars: B, levels: LV, summary: "x" }, APP_THEME, PHONE_CARD);
    expect(c.plot.x0).toBe(32);
    expect(ticks(c.svg).length).toBeGreaterThan(1);
  });
  test("won (150,000–250,000): the column widens and every tick number starts inside the chart", () => {
    for (const layout of [PHONE_CARD, FULL_VIEW]) {
      const c = levelChart({ bars: scaled(6000), levels: [], summary: "x", digits: 0 }, APP_THEME, layout);
      const ts = ticks(c.svg);
      expect(ts.length).toBeGreaterThan(1);
      expect(c.plot.x0).toBeGreaterThan(32);
      expect(c.plot.x0).toBeLessThanOrEqual(72);
      for (const t of ts) expect(t.x - labelEm(t.text) * APP_THEME.tick.size).toBeGreaterThanOrEqual(0);
    }
  });
  test("KRW ticks in 만 (DD 2228-b): 15만 · 20만 · 25만, the column back to 32–40, labels and the price exact", () => {
    const lv: ChartLevel[] = [{ kind: "target1", price: 211_700 }];
    const cap = { unit: "원", asOf: "11월 26일 종가 기준", source: "KRX" };
    for (const layout of [PHONE_CARD, FULL_VIEW, DECK_CHART]) {
      const theme = layout === DECK_CHART ? DECK_THEME : APP_THEME;
      const won = levelChart({ bars: scaled(6000), levels: lv, summary: "x", digits: 0, currency: "KRW", ...cap }, theme, layout);
      const full = levelChart({ bars: scaled(6000), levels: lv, summary: "x", digits: 0, ...cap }, theme, layout);
      const ts = ticks(won.svg).map((t) => t.text);
      expect(ts.length).toBeGreaterThan(1);
      for (const t of ts) expect(t).toMatch(/^\d+(\.\d)?만$/);
      expect(ticks(full.svg).every((t) => /^\d{2,3},\d{3}$/.test(t.text))).toBe(true);
      expect(won.plot.x0).toBeLessThan(full.plot.x0);
      expect(won.plot.x0).toBeLessThanOrEqual(layout === DECK_CHART ? 48 : 40);
      expect(won.svg.replace(/<[^>]+>/g, "").includes("1차 익절 211,700")).toBe(true);
    }
  });
  test("past leftMax the tick numbers go and the grid lines stay", () => {
    const c = levelChart({ bars: scaled(1e6), levels: [], summary: "x", digits: 0 }, APP_THEME, PHONE_CARD);
    expect(c.plot.x0).toBe(72);
    expect(ticks(c.svg)).toEqual([]);
    expect(attrs(c.svg, /data-role="grid"/g).length).toBeGreaterThan(1);
  });
});

describe("label rules (DD 1949, DD 2145)", () => {
  const charts = [
    ["phone", levelChart({ bars: B, levels: LV, summary: "x" }, APP_THEME, PHONE_CARD)],
    ["full", levelChart({ bars: B, levels: LV, summary: "x" }, APP_THEME, FULL_VIEW)],
    ["deck", levelChart({ bars: B, levels: LV, summary: "x", unit: "USD", asOf: "11월 26일 종가 기준", source: "Yahoo" }, DECK_THEME, DECK_CHART)],
  ] as const;
  test("매수 검토 is the band's word alone, with no number, in every layout", () => {
    for (const [, c] of charts) expect(labels(c.svg).find((l) => l.kind === "buyZone")?.text).toBe("매수 검토");
  });
  test("every label starts at or right of the leader's end (plot.x1 + 8)", () => {
    for (const [, c] of charts) {
      const xs = attrs(c.svg, /<text [^>]*data-label="\w+"[^>]*>/g).map((t) => num(t, "x"));
      expect(xs.length).toBeGreaterThan(3);
      for (const x of xs) expect(x).toBeGreaterThanOrEqual(c.plot.x1 + 8);
    }
  });
  test("a label moved off its line (> 1.5 px) has one leader from its line; a label on its line has none", () => {
    const near: ChartLevel[] = [
      { kind: "stop", price: Math.round((last - 3) * 100) / 100 },
      { kind: "support", price: Math.round((last - 0.1) * 100) / 100 },
      { kind: "resistance", price: Math.round((last + 0.1) * 100) / 100 },
    ];
    const c = levelChart({ bars: B, levels: near, summary: "x" }, APP_THEME, PHONE_CARD);
    const size = APP_THEME.label.size;
    const yOf = (p: number) => c.plot.y0 + (1 - (p - c.range.lo) / (c.range.hi - c.range.lo)) * (c.plot.y1 - c.plot.y0);
    const priceOf: Record<string, number> = { current: last, ...Object.fromEntries(near.map((l) => [l.kind, l.price])) };
    const ls = labels(c.svg).map((l) => ({ ...l, py: l.y - size * 0.35, want: yOf(priceOf[l.kind]!) }));
    const moved = ls.filter((l) => Math.abs(l.py - l.want) > 1.5 + 0.1);
    const still = ls.filter((l) => Math.abs(l.py - l.want) <= 1.5 - 0.1);
    expect(moved.length).toBeGreaterThan(0);
    expect(still.length).toBeGreaterThan(0);
    const leaders = attrs(c.svg, /<path [^>]*data-role="leader"[^>]*\/>/g).map((p) => p.match(/d="M([-0-9.]+),([-0-9.]+) L[-0-9.]+,[-0-9.]+ L[-0-9.]+,([-0-9.]+)"/)!.slice(1).map(Number));
    expect(leaders.length).toBe(moved.length);
    for (const l of moved) expect(leaders.some(([x0, from, to]) => x0 === c.plot.x1 && Math.abs(from! - l.want) < 0.11 && Math.abs(to! - l.py) < 0.11)).toBe(true);
  });
});

describe("full view and deck", () => {
  test("full view: 358 × 420 with the volume profile and the MACD histogram", () => {
    const f = levelChart({ bars: B, levels: LV, summary: "x" }, APP_THEME, FULL_VIEW);
    expect([f.width, f.height]).toEqual([358, 420]);
    expect(f.svg).toContain('data-role="profile"');
    expect(f.svg).toContain('data-role="macd"');
    const prof = attrs(f.svg, /<rect [^>]*data-role="profile"[^>]*\/>/g);
    expect(prof.length).toBeLessThanOrEqual(3);
    expect(prof.every((r) => num(r, "width") <= 48 + 0.05 && num(r, "y") >= f.plot.y0 - 0.05)).toBe(true);
  });
  test("deck: 1152 × 400, deck colours only from its theme, caption with unit · basis · source, M/D dates", () => {
    const d = levelChart({ bars: B, levels: LV, summary: "x", unit: "USD", asOf: "11월 26일 종가 기준", source: "Yahoo" }, DECK_THEME, DECK_CHART);
    expect([d.width, d.height]).toEqual([1152, 400]);
    const palette = new Set(JSON.stringify(DECK_THEME).match(/#[0-9A-F]{6}/gi)!.map((h) => h.toUpperCase()));
    expect([...d.svg.matchAll(/#[0-9a-fA-F]{6}\b/g)].every((m) => palette.has(m[0].toUpperCase()))).toBe(true);
    expect(d.svg).toContain('data-role="caption">USD · 11월 26일 종가 기준 · Yahoo</text>');
    expect(d.svg).toMatch(/data-role="date">\d{1,2}\/\d{1,2}</);
    expect(labels(d.svg).every((l, i, a) => i === 0 || Math.abs(l.y - a[i - 1]!.y) >= 0)).toBe(true);
  });
  test("never NaN in the drawing: a broken bar or current price refuses, a broken level is left out (level_invalid)", () => {
    const broken = B.map((b, i) => (i === B.length - 3 ? { ...b, c: NaN } : b));
    expect(() => levelChart({ bars: broken, levels: LV, summary: "x" }, APP_THEME, PHONE_CARD)).toThrow();
    expect(() => levelChart({ bars: B.map((b, i) => (i === 5 ? { ...b, v: Infinity } : b)), levels: LV, summary: "x" }, APP_THEME, PHONE_CARD)).toThrow();
    expect(() => levelChart({ bars: B, levels: LV, summary: "x", current: NaN }, APP_THEME, PHONE_CARD)).toThrow();
    const c = levelChart({ bars: B, levels: [...LV, { kind: "target2", price: NaN }, { kind: "buyZone", price: 30, hi: Infinity }], summary: "x" }, APP_THEME, FULL_VIEW);
    expect(c.svg).not.toContain("NaN");
    expect(c.svg).not.toContain("확인 불가");
    expect(c.issues.filter((i) => i.code === "level_invalid").map((i) => i.kind)).toEqual(["target2", "buyZone"]);
  });
  test("deck refuses to draw without unit, basis and source (FA4 #8)", () => {
    expect(() => levelChart({ bars: B, levels: LV, summary: "x" }, DECK_THEME, DECK_CHART)).toThrow();
  });
});
