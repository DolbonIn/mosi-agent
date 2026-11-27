/** The board renderers (PLAN §3-A: gauges, flows, grid11, timeline): geometry read back from the SVG strings. Synthetic data only. */
import { describe, expect, test } from "bun:test";
import { APP_BOARD, DECK_BOARD, textW, wrapText } from "../src/board";
import { CORE11 } from "../src/risk11";
import { readFileSync } from "node:fs";
import { DECK_FLOWS, PHONE_FLOWS, STACK_GAP, flowChart, type FlowDay } from "../src/flowchart";
import { gaugeSvg, gaugeText } from "../src/gauge";
import { DECK_GRID11, grid11Svg, type Grid11Item } from "../src/grid11";
import { BOX_REACH, DECK_TIMELINE, STEM_BEND, STEM_CLEAR, timelineSvg, type TimelineEvent } from "../src/timeline";

// DD 0126's numbers, written here rather than read from the code they check
test("the timeline's clearances are DD 0126's", () => {
  expect([STEM_BEND, STEM_CLEAR, BOX_REACH > STEM_BEND]).toEqual([20, 16, true]);
});
import { addDays } from "./fixtures";

const all = (svg: string, re: RegExp) => [...svg.matchAll(re)].map((m) => m[0]);
const at = (el: string, a: string) => Number(el.match(new RegExp(` ${a}="([-0-9.]+)"`))![1]);
const role = (svg: string, r: string) => all(svg, new RegExp(`<(?:rect|text|line|path|circle)\\b[^>]*data-role="${r}"[^>]*?(?:/>|>.*?</text>)`, "g"));
const textOf = (el: string) => el.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const sizes = (svg: string) => all(svg, /font-size="([0-9.]+)"/g).map((s) => Number(s.match(/[0-9.]+/)![0]));

describe("wrapText", () => {
  test("breaks at spaces, a word wider than the line between characters, and says when it cut", () => {
    expect(wrapText("근원 0.3% 이상", 1000, 15, 2)).toEqual({ lines: ["근원 0.3% 이상"], cut: false });
    const two = wrapText("실업률 4.4% 이상, 삼의 법칙 0.5 근접", 180, 15, 2);
    expect(two.cut).toBe(false);
    expect(two.lines.length).toBe(2);
    for (const l of two.lines) expect(textW(l, 15)).toBeLessThanOrEqual(180);
    const long = wrapText("가나다라마바사아자차카타파하", 60, 15, 4);
    expect(long.lines.join("")).toBe("가나다라마바사아자차카타파하");
    expect(long.lines.length).toBe(4);
    for (const l of long.lines) expect(textW(l, 15)).toBeLessThanOrEqual(60);
    const cut = wrapText("가나다 라마바 사아자 차카타 파하", 50, 15, 2);
    expect(cut.cut).toBe(true);
    expect(cut.lines.length).toBe(2);
    expect(cut.lines[1]!.endsWith("…")).toBe(true);
    expect(textW(cut.lines[1]!, 15)).toBeLessThanOrEqual(50);
  });
});

describe("stage gauges (DD 1935 §3-2)", () => {
  const cells = (svg: string) => all(svg, /<rect [^>]*data-cell="(\w+)"[^>]*\/>/g).map((r) => ({ state: r.match(/data-cell="(\w+)"/)![1], fill: r.match(/fill="([^"]+)"/)![1], x: at(r, "x") }));
  test("met first in the gauge's colour, then unknown with a dotted edge, then unmet; app cells 10×6, gap 3", () => {
    const g = gaugeSvg("escape", { met: 3, unknown: 1, of: 8 }, APP_BOARD);
    expect(g.width).toBe(8 * 10 + 7 * 3);
    expect(g.height).toBe(6);
    const c = cells(g.svg);
    expect(c.map((x) => x.state)).toEqual(["met", "met", "met", "unknown", "unmet", "unmet", "unmet", "unmet"]);
    expect(c.filter((x) => x.state === "met").every((x) => x.fill === "var(--caution)")).toBe(true);
    expect(c.find((x) => x.state === "unknown")!.fill).toBe("none");
    expect(g.svg).toContain('stroke-dasharray="2 2"');
    expect(c.filter((x) => x.state === "unmet").every((x) => x.fill === "var(--fill-2)")).toBe(true);
    expect(g.svg).toContain('aria-label="악화 신호 8개 중 3개 충족, 확인 불가 1개"');
  });
  test("severe in --danger, recovery in --label; the deck's cells 28×14 in FA3 colours", () => {
    expect(cells(gaugeSvg("severe", { met: 1, unknown: 0, of: 5 }, APP_BOARD).svg)[0]!.fill).toBe("var(--danger)");
    expect(cells(gaugeSvg("recovery", { met: 2, unknown: 0, of: 6 }, APP_BOARD).svg)[1]!.fill).toBe("var(--label)");
    const d = gaugeSvg("severe", { met: 2, unknown: 0, of: 5 }, DECK_BOARD);
    expect([d.width, d.height]).toEqual([5 * 28 + 4 * 6, 14]);
    expect(cells(d.svg).map((x) => x.fill)).toEqual(["#A62B21", "#A62B21", "#E4DED0", "#E4DED0", "#E4DED0"]);
    expect(gaugeText("recovery", { met: 0, unknown: 0, of: 6 })).toBe("회복 신호 6개 중 0개 충족");
  });
  test("counts that do not add up are refused", () => {
    for (const g of [{ met: 5, unknown: 4, of: 8 }, { met: 1.5, unknown: 0, of: 8 }, { met: 0, unknown: 0, of: 0 }, { met: -1, unknown: 0, of: 5 }])
      expect(() => gaugeSvg("escape", g, APP_BOARD)).toThrow();
  });
});

describe("flow chart (FA5 #5, DD 1935 §5-2 flows)", () => {
  const days = (n: number, f: (i: number) => Partial<FlowDay> = () => ({})): FlowDay[] =>
    Array.from({ length: n }, (_, i) => ({ t: addDays("2026-10-01", i), foreign: 1000, institution: -400, individual: -600, nonArb: 200, ...f(i) }));
  const deckIn = (d: FlowDay[]) => ({ days: d, summary: "x", unit: "단위 억원", asOf: "11월 26일 기준", source: "토스증권" });
  const bars = (svg: string) => all(svg, /<rect [^>]*data-role="flow-bar"[^>]*\/>/g).map((r) => ({ who: r.match(/data-who="(\w+)"/)![1], t: r.match(/data-t="([-0-9]+)"/)![1], y: at(r, "y"), h: at(r, "height") }));
  test("buying stacks up from zero, selling down from zero, in foreign · institution · individual order", () => {
    const c = flowChart(deckIn(days(20)), DECK_BOARD, DECK_FLOWS);
    const day0 = bars(c.svg).filter((b) => b.t === "2026-10-01");
    const [f, inst, ind] = ["foreign", "institution", "individual"].map((w) => day0.find((b) => b.who === w)!);
    expect(f!.y + f!.h).toBeCloseTo(c.zeroY, 0);
    expect(inst!.y).toBeCloseTo(c.zeroY, 0);
    expect(f!.h / inst!.h).toBeCloseTo(1000 / 400, 1);
    // the individuals' cell is drawn inset half a pixel with a 1px edge: its painted box is 1px larger each way
    expect((ind!.h + 1 + STACK_GAP) / inst!.h).toBeCloseTo(600 / 400, 1);
  });
  test("DD 0126 §3: the individuals' cell has a 1px edge in the institutions' colour, cells of a stack stand ≥ 1px apart", () => {
    const rect = (svg: string) => all(svg, /<rect [^>]*data-role="flow-bar"[^>]*\/>/g);
    for (const [theme, layout] of [[DECK_BOARD, DECK_FLOWS], [APP_BOARD, PHONE_FLOWS]] as const) {
      // three days: all selling but foreigners; all buying; individuals alone
      const c = flowChart(deckIn(days(3, (i) => [{}, { foreign: 900, institution: 500, individual: 700 }, { foreign: 0, institution: 0, individual: -900 }][i]!)), theme, layout);
      const cells = rect(c.svg).map((r) => ({ r, who: r.match(/data-who="(\w+)"/)![1]!, t: r.match(/data-t="([-0-9]+)"/)![1]!, stroke: (r.match(/ stroke="([^"]+)"/) ?? [])[1], sw: (r.match(/ stroke-width="([^"]+)"/) ?? [])[1], y: at(r, "y"), h: at(r, "height") }));
      const ind = cells.filter((x) => x.who === "individual");
      expect(ind.length).toBe(3);
      for (const x of ind) expect([x.stroke, x.sw]).toEqual([theme.flows.institution, "1"]);
      for (const x of cells.filter((x) => x.who !== "individual")) expect(x.stroke).toBeUndefined();
      // painted extents (an edged cell paints half a pixel past its rect) never touch within a day's stack
      for (const t of new Set(cells.map((x) => x.t))) {
        const painted = cells.filter((x) => x.t === t).map((x) => (x.stroke ? { top: x.y - 0.5, bottom: x.y + x.h + 0.5 } : { top: x.y, bottom: x.y + x.h })).sort((a, b) => a.top - b.top);
        for (let k = 1; k < painted.length; k++) {
          const gap = painted[k]!.top - painted[k - 1]!.bottom;
          // a buying stack and a selling stack meet at the zero line (coordinates are written to 0.1px), not a gap
          if (Math.abs(painted[k - 1]!.bottom - c.zeroY) > 0.06 || Math.abs(painted[k]!.top - c.zeroY) > 0.06) expect(gap).toBeGreaterThanOrEqual(1 - 0.001);
        }
      }
      // the legend swatch says the same
      const sw = all(c.svg, /<rect [^>]*data-role="legend-swatch"[^>]*\/>/g);
      expect(sw[2]).toContain(` stroke="${theme.flows.institution}" stroke-width="1"`);
      expect(sw[0]).not.toContain("stroke=");
    }
  });
  test("DD 0126 §3: the individuals' edge stands out from the paper (≥ 3:1) in the app's light and dark and in the deck", () => {
    const lum = (hex: string) => {
      const [r, g, b] = [1, 3, 5].map((k) => parseInt(hex.slice(k, k + 2), 16) / 255).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)) as [number, number, number];
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const ratio = (a: string, b: string) => {
      const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p) as [number, number];
      return (x + 0.05) / (y + 0.05);
    };
    // the app's tokens as tokens.css writes them (light :root, then the dark block), read from the file itself
    const css = readFileSync(new URL("../../../apps/mobile/src/styles/tokens.css", import.meta.url), "utf8");
    const token = (name: string) => [...css.matchAll(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`, "g"))].map((m) => m[1]!);
    const [label2Light, label2Dark] = token("--label-2");
    const [surfaceLight, surfaceDark] = token("--surface");
    expect(APP_BOARD.flows.institution).toBe("var(--label-2)");
    expect(APP_BOARD.flows.halo).toBe("var(--surface)");
    expect(ratio(label2Light!, surfaceLight!)).toBeGreaterThanOrEqual(3);
    expect(ratio(label2Dark!, surfaceDark!)).toBeGreaterThanOrEqual(3);
    expect(ratio(DECK_BOARD.flows.institution, DECK_BOARD.flows.halo)).toBeGreaterThanOrEqual(3);
  });
  test("both axes share the zero line: a non-arbitrage 0 sits on it", () => {
    const c = flowChart(deckIn(days(20, (i) => ({ nonArb: i === 4 ? 0 : i % 2 ? 900 : -300, foreign: i % 3 ? 5000 : -8000 }))), DECK_BOARD, DECK_FLOWS);
    const dots = all(c.svg, /<circle [^>]*data-role="nonarb-dot"[^>]*\/>/g);
    expect(at(dots[4]!, "cy")).toBeCloseTo(c.zeroY, 0);
    expect(role(c.svg, "zero").length).toBe(1);
    expect(at(role(c.svg, "zero")[0]!, "y1")).toBeCloseTo(c.zeroY, 0);
  });
  test("the newest `days` only; dates 10/6 … with the last always written", () => {
    const c = flowChart(deckIn(days(25)), DECK_BOARD, DECK_FLOWS);
    const ts = new Set(bars(c.svg).map((b) => b.t));
    expect(ts.size).toBe(20);
    expect(ts.has(addDays("2026-10-01", 4))).toBe(false);
    const dates = role(c.svg, "date").map(textOf);
    expect(dates[0]).toBe("10/6");
    expect(dates.at(-1)).toBe("10/25");
  });
  test("a missing figure is named and left out; a missing line day breaks the line; no line without nonArb", () => {
    const c = flowChart(deckIn(days(20, (i) => (i === 3 ? { institution: null } : i === 7 ? { nonArb: null } : {}))), DECK_BOARD, DECK_FLOWS);
    expect(c.issues).toEqual([
      { code: "flow_missing", t: addDays("2026-10-01", 3), who: "기관" },
      { code: "nonarb_missing", t: addDays("2026-10-01", 7) },
    ]);
    expect(bars(c.svg).filter((b) => b.t === addDays("2026-10-01", 3)).map((b) => b.who)).toEqual(["foreign", "individual"]);
    expect(role(c.svg, "nonarb")[0]!.match(/M/g)!.length).toBe(2);
    const none = flowChart({ days: days(20).map(({ nonArb: _, ...d }) => d), summary: "x" }, APP_BOARD, PHONE_FLOWS);
    expect(role(none.svg, "nonarb")).toEqual([]);
    expect(role(none.svg, "tick-right")).toEqual([]);
    expect(none.svg).not.toContain("비차익");
  });
  test("ticks in the §0-5 formatter (grouping, U+2212); the deck's caption; every legend word inside the width", () => {
    const c = flowChart(deckIn(days(20, (i) => ({ individual: i === 9 ? -21350 : -600 }))), DECK_BOARD, DECK_FLOWS);
    const ticks = role(c.svg, "tick").map(textOf);
    expect(ticks.some((t) => /^−20,000$/.test(t))).toBe(true);
    expect(ticks.every((t) => !t.includes("-"))).toBe(true);
    expect(textOf(role(c.svg, "caption")[0]!)).toBe("단위 억원 · 11월 26일 기준 · 토스증권");
    for (const [theme, layout] of [[APP_BOARD, PHONE_FLOWS], [DECK_BOARD, DECK_FLOWS]] as const) {
      const g = flowChart(deckIn(days(20)), theme, layout);
      for (const t of role(g.svg, "legend")) expect(at(t, "x") + textW(textOf(t), theme.size.tick)).toBeLessThanOrEqual(layout.width);
      expect(Math.min(...sizes(g.svg))).toBeGreaterThanOrEqual(theme === APP_BOARD ? 13 : 15);
    }
    // a narrower chart: the legend takes two rows (비차익 goes under), each word still inside, the plot lower
    const one = flowChart(deckIn(days(20)), APP_BOARD, PHONE_FLOWS);
    const narrow = flowChart(deckIn(days(20)), APP_BOARD, { ...PHONE_FLOWS, width: 260 });
    expect(new Set(role(one.svg, "legend").map((t) => at(t, "y"))).size).toBe(1);
    expect(new Set(role(narrow.svg, "legend").map((t) => at(t, "y"))).size).toBe(2);
    for (const t of role(narrow.svg, "legend")) expect(at(t, "x") + textW(textOf(t), 13)).toBeLessThanOrEqual(260);
    expect(narrow.plot.y0).toBeGreaterThan(one.plot.y0);
  });
  test("refused: a figure that is not a number, the deck without its caption, fewer than two days", () => {
    expect(() => flowChart(deckIn(days(20, (i) => (i === 2 ? { foreign: NaN } : {}))), DECK_BOARD, DECK_FLOWS)).toThrow();
    expect(() => flowChart(deckIn(days(20, (i) => (i === 2 ? { nonArb: Infinity } : {}))), DECK_BOARD, DECK_FLOWS)).toThrow();
    expect(() => flowChart({ days: days(20), summary: "x" }, DECK_BOARD, DECK_FLOWS)).toThrow();
    expect(() => flowChart(deckIn(days(1)), DECK_BOARD, DECK_FLOWS)).toThrow();
  });
});

describe("11-indicator grid (DD 1935 §5-2 grid11)", () => {
  const VALUES = ["4.53%", "+0.12%p", "+0.41%p", "1.20%", "4.30%", "확인 불가", "52.4%", "하향 0/7", "−2.1조", "0.1%", "2/4 < 20%"];
  const BASIS = ["> 5%이면 위험", "> 0이면 위험", "6개월 최저 대비", "1개월 ≥ 5% 위험", "4.1% + 0.3%p", "−5% 초과 위험", "< 60%이면 위험", "전체 하향 시 위험", "순매도 지속", "MoM ≥ 0.3% 위험", "개별 < 20% 위험"];
  const SIG = ["normal", "risk", "caution", "normal", "caution", "unknown", "risk", "normal", "caution", "normal", "risk"] as const;
  const items = (): Grid11Item[] => CORE11.map((r, i) => ({ no: r.no, name: r.name, signal: SIG[i]!, value: VALUES[i]!, basis: BASIS[i]!, asOf: "11/25 기준" }));
  test("eleven cells and the summary: every CORE11 name, value and basis fits the deck's cell, nothing cut", () => {
    const g = grid11Svg(items(), DECK_BOARD);
    expect([g.width, g.height]).toEqual([DECK_GRID11.width, DECK_GRID11.height]);
    expect(g.issues).toEqual([]);
    expect(g.counts).toEqual({ risk: 3, caution: 3, normal: 4, unknown: 1 });
    expect(g.svg).toContain('aria-label="11지표: 위험 3 · 경계 3 · 정상 4 · 확인 불가 1"');
    expect(role(g.svg, "name").map(textOf)).toEqual(CORE11.map((r) => r.name));
    expect(role(g.svg, "cell").length).toBe(12);
  });
  test("a signal is a mark and its word, in the deck's chip pair; the summary counts 확인 불가 apart", () => {
    const g = grid11Svg(items(), DECK_BOARD);
    const words = role(g.svg, "signal-word").map(textOf);
    expect(words).toEqual(SIG.map((s) => ({ risk: "위험", caution: "경계", normal: "정상", unknown: "확인 불가" })[s]));
    const chips = role(g.svg, "chip").map((c) => c.match(/fill="([^"]+)"/)![1]);
    expect(chips[1]).toBe("#F6D9D3");
    expect(chips[5]).toBe("#E7E3D7");
    const counts = role(g.svg, "count").map((c) => [c.match(/data-signal="(\w+)"/)![1], textOf(c)]);
    expect(counts).toEqual([["risk", "3"], ["caution", "3"], ["normal", "4"], ["unknown", "1"]]);
  });
  test("deck sizes: name 19, value 26, basis 15, as of 14; nothing smaller", () => {
    const g = grid11Svg(items(), DECK_BOARD);
    expect(at(role(g.svg, "name")[0]!, "font-size")).toBe(19);
    expect(at(role(g.svg, "value")[0]!, "font-size")).toBe(26);
    expect(at(role(g.svg, "basis")[0]!, "font-size")).toBe(15);
    expect(at(role(g.svg, "as-of")[0]!, "font-size")).toBe(14);
    expect(Math.min(...sizes(g.svg))).toBe(14);
  });
  test("a basis too wide beside its value moves to the as-of row; a name that cannot fit is cut and reported", () => {
    const it = items();
    it[0] = { ...it[0]!, value: "1,234,567.89%", basis: "MoM ≥ 0.3%이면 위험" };
    it[1] = { ...it[1]!, name: "아주 긴 이름의 지표가 칸을 넘는 경우를 시험해요" };
    const g = grid11Svg(it, DECK_BOARD);
    // rows compared by their middles (the baseline sits 0.35em below the middle)
    const mid = (el: string) => at(el, "y") - 0.35 * at(el, "font-size");
    const basis = role(g.svg, "basis");
    const asOf = role(g.svg, "as-of");
    expect(mid(basis[0]!)).toBeCloseTo(mid(asOf[0]!), 0);
    expect(mid(basis[1]!)).toBeLessThan(mid(asOf[1]!) - 10);
    expect(g.issues).toEqual([{ code: "text_overflow", where: "2 name", text: it[1]!.name }]);
    expect(textOf(role(g.svg, "name")[1]!).endsWith("…")).toBe(true);
  });
  test("refused unless eleven numbered 1–11; text is escaped", () => {
    expect(() => grid11Svg(items().slice(0, 10), DECK_BOARD)).toThrow();
    const dup = items();
    dup[10] = { ...dup[10]!, no: 10 };
    expect(() => grid11Svg(dup, DECK_BOARD)).toThrow();
    const g = grid11Svg(items(), DECK_BOARD);
    expect(g.svg).toContain("&lt; 60%이면 위험");
    expect(g.svg).not.toContain("< 60%");
  });
});

describe("event timeline (FA5 #6, DD 1935 §5-2 timeline)", () => {
  const ev = (day: number, over: Partial<TimelineEvent> = {}): TimelineEvent => ({
    at: `2026-12-${String(day).padStart(2, "0")}T22:30:00+09:00`,
    title: `이벤트 ${day}`,
    consensus: "0.3%",
    bull: "근원 0.2% 이하",
    bear: "근원 0.4% 이상",
    amplitude: "±2.0%(추정)",
    ...over,
  });
  const input = (events: TimelineEvent[]) => ({ events, summary: "x", asOf: "11월 26일 08:00 기준", source: "각 기관 일정" });
  test("time order whatever the input order; above and below in turn; dots at their times", () => {
    const t = timelineSvg(input([ev(9), ev(1), ev(5), ev(3)]), DECK_BOARD);
    const titles = all(t.svg, /data-role="title">[^<]*/g).map((s) => s.split(">")[1]);
    expect(titles).toEqual(["이벤트 1", "이벤트 3", "이벤트 5", "이벤트 9"]);
    expect(t.boxes.map((b) => b.above)).toEqual([true, false, true, false]);
    const d = t.boxes.map((b) => b.dot);
    expect((d[1]! - d[0]!) / (d[3]! - d[0]!)).toBeCloseTo(2 / 8, 3);
    expect(t.issues).toEqual([]);
  });
  test("eight events: boxes on a side never overlap and stay inside; a moved box's stem bends to it", () => {
    const t = timelineSvg(input([1, 2, 3, 4, 10, 11, 17, 19].map((d) => ev(d))), DECK_BOARD);
    for (const above of [true, false]) {
      const side = t.boxes.filter((b) => b.above === above);
      side.forEach((b, i) => {
        expect(b.x).toBeGreaterThanOrEqual(0);
        expect(b.x + b.w).toBeLessThanOrEqual(DECK_TIMELINE.width + 0.01);
        if (i) expect(b.x - (side[i - 1]!.x + side[i - 1]!.w)).toBeGreaterThanOrEqual(DECK_TIMELINE.boxGap - 0.01);
      });
    }
    const stems = role(t.svg, "stem").map((p) => p.match(/d="([^"]+)"/)![1]!);
    t.boxes.forEach((b, i) => expect(stems[i]!.includes("H")).toBe(Math.abs(b.x - b.dot) >= 0.5));
    expect(t.issues).toEqual([]);
  });
  test("the date is written from `at`: KST, with the 2026 weekday", () => {
    const t = timelineSvg(input([ev(1), ev(3), ev(5), { ...ev(11), at: "2026-12-10T10:00:00-05:00" }]), DECK_BOARD);
    expect(role(t.svg, "date").map(textOf)).toEqual(["12/1(화) 22:30", "12/3(목) 22:30", "12/5(토) 22:30", "12/11(금) 00:00"]);
  });
  /** a stem's path: its first point, the bend (if any) and its upright x */
  const stemOf = (p: string) => {
    const d = p.match(/d="([^"]+)"/)![1]!;
    const m = d.match(/^M([-0-9.]+),([-0-9.]+)V([-0-9.]+)(?:H([-0-9.]+)V([-0-9.]+))?$/)!;
    return { x: Number(m[1]), y: Number(m[2]), bend: m[4] != null ? Number(m[3]) : null, upright: m[4] != null ? Number(m[4]) : Number(m[1]), d };
  };
  test("DD 0126 §1: each stem leaves the axis at its own dot only; a bend is ≥ 20px off the axis; a moved upright > 16px from every other dot", () => {
    // DD 0126's sample: the eight events of the deck's timeline page
    const times = ["2026-11-27T22:30", "2026-12-01T09:00", "2026-12-03T00:00", "2026-12-05T22:30", "2026-12-10T22:30", "2026-12-11T04:00", "2026-12-17T06:00", "2026-12-19T15:30"];
    for (const order of [times, [...times].reverse()]) {
      const t = timelineSvg(input(order.map((at, i) => ({ ...ev(i + 1), at: `${at}:00+09:00` }))), DECK_BOARD);
      expect(t.issues).toEqual([]);
      const stems = role(t.svg, "stem").map(stemOf);
      const dots = all(t.svg, /<circle [^>]*data-role="event-dot"[^>]*\/>/g).map((c) => at(c, "cx"));
      let moved = 0;
      stems.forEach((s, i) => {
        expect(s.x).toBeCloseTo(dots[i]!, 1);
        expect(s.y).toBeCloseTo(t.axisY, 1);
        // the path's other points stay off the axis
        expect(Math.abs((s.bend ?? Number(s.d.match(/V([-0-9.]+)$/)![1])) - t.axisY)).toBeGreaterThanOrEqual(20 - 0.05);
        if (s.bend == null) return;
        moved++;
        // DD 0126: 20px off the axis; lead 0127: more than 16px from every other dot's centre
        expect(Math.abs(s.bend - t.axisY)).toBeGreaterThanOrEqual(20 - 0.05);
        for (const [j, d] of dots.entries()) if (j !== i) expect(Math.abs(s.upright - d)).toBeGreaterThan(16);
      });
      expect(moved).toBeGreaterThan(0);
      // boxes keep BOX_REACH from the axis, so the bend never runs along a box
      for (const b of t.boxes) expect(b.above ? t.axisY - (b.y + b.h) : b.y - t.axisY).toBeGreaterThanOrEqual(BOX_REACH - 0.05);
    }
  });
  test("a moved box goes the least way clear: just past the other dot, not to the farthest clear place", () => {
    // four events over 1000 minutes: the third's box is pushed 2px right of its dot by the first's, onto the second's
    // dot (12px away); clear places run from just past that dot to the right edge, and it takes the nearest
    const t0 = Date.parse("2026-12-01T00:00:00+09:00");
    const t = timelineSvg(input([0, 337, 349, 1000].map((m, i) => ({ ...ev(i + 1), at: new Date(t0 + m * 60_000).toISOString(), consensus: null, bull: null, bear: null, amplitude: null }))), DECK_BOARD);
    expect(t.issues).toEqual([]);
    const [, second, third] = t.boxes;
    expect(third!.x).toBeCloseTo(second!.dot + 17, 2);
  });
  test("a moved box that cannot stand clear of another dot between its neighbours is reported, not left silent", () => {
    // six events within five minutes, one at 65 h 36 min, one at 100 h: the third boxes on each side are pinned at 566
    // between their neighbours, and the 65 h dot stands at 575
    const t0 = Date.parse("2026-12-01T00:00:00+09:00");
    const mins = [0, 1, 2, 3, 4, 5, 65 * 60 + 36, 100 * 60];
    const t = timelineSvg(input(mins.map((m, i) => ({ ...ev(i + 1), at: new Date(t0 + m * 60_000).toISOString(), consensus: null, bull: null, bear: null, amplitude: null }))), DECK_BOARD);
    expect(t.issues).toEqual([
      { code: "stem_near_dot", where: "5", text: "이벤트 5" },
      { code: "stem_near_dot", where: "6", text: "이벤트 6" },
    ]);
  });
  test("no consensus is written 미확보; Bull and Bear are words in their colours, left out when absent", () => {
    const t = timelineSvg(input([ev(1, { consensus: null, bull: null }), ev(2)]), DECK_BOARD);
    expect(textOf(role(t.svg, "consensus")[0]!)).toBe("컨센서스 미확보");
    const bulls = all(t.svg, /<tspan [^>]*data-role="bull-word"[^>]*>Bull<\/tspan>/g);
    expect(bulls.length).toBe(1);
    expect(bulls[0]).toContain('fill="#1B48D6"');
    expect(all(t.svg, /data-role="bear-word"/g).length).toBe(2);
    expect(all(t.svg, /<tspan [^>]*data-role="bear-word"[^>]*>/g)[0]).toContain('fill="#A62B21"');
  });
  test("a long trigger wraps to two lines; one past two lines is cut and reported", () => {
    const t = timelineSvg(input([ev(1, { bear: "실업률 4.4% 이상, 삼의 법칙 0.5 근접" }), ev(2)]), DECK_BOARD);
    expect(t.issues).toEqual([]);
    expect(role(t.svg, "bear").length).toBe(3);
    const long = "아주 긴 하락 조건이 세 줄을 넘어가도록 길게 쓴 문장이에요 아주 긴 하락 조건이 세 줄을 넘어가도록 길게 쓴 문장이에요";
    const cut = timelineSvg(input([ev(1, { bear: long }), ev(2)]), DECK_BOARD);
    expect(cut.issues).toEqual([{ code: "text_overflow", where: "1 bear", text: long }]);
  });
  test("refused: no events, more than eight (they go to the appendix), a time that is not a date", () => {
    expect(() => timelineSvg(input([]), DECK_BOARD)).toThrow();
    expect(() => timelineSvg(input(Array.from({ length: 9 }, (_, i) => ev(i + 1))), DECK_BOARD)).toThrow();
    expect(() => timelineSvg(input([ev(1, { at: "12월 1일" })]), DECK_BOARD)).toThrow();
  });
  test("the caption carries as of and source; nothing under 14px", () => {
    const t = timelineSvg(input([ev(1), ev(2)]), DECK_BOARD);
    expect(textOf(role(t.svg, "caption")[0]!)).toBe("11월 26일 08:00 기준 · 각 기관 일정");
    expect(Math.min(...sizes(t.svg))).toBeGreaterThanOrEqual(14);
  });
});
