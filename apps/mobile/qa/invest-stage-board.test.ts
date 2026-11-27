// ① 시장 단계's board as one shared part (DD 0141, DD 0059 §1-3, DD 0426 §1, DD 0428): IvStageHead, IvGaugeRows /
// IvGaugeRow and IvStages in ui/Invest. Every word is the server's (B2b-2 InvestStages); the cells and the sentence they
// are read as are @pickle/quant's (gaugeSvg / gaugeText with APP_BOARD). Whether the cells go under the word is decided
// on measured widths in a browser (the gallery probe); here: what is drawn, in which order, and what is read.
//   bun test ./qa/invest-stage-board.test.ts
import { describe, expect, test } from "bun:test";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { APP_BOARD, gaugeSvg, gaugeText, SIGNAL_SHAPES } from "@pickle/quant";
import type { InvestStageGauge, InvestStageHead, InvestStages } from "@pickle/protocol";
import { escapeStage, recoveryStage, ESCAPE_A_RULES, ESCAPE_D_RULES, RECOVERY_RULES, type Condition, type Core11Result, type Signal } from "@pickle/quant";
import { IvGaugeRow, IvGaugeRows, IvStageHead, IvStages, nextParts, STAGE_UNKNOWN } from "../src/ui/Invest";
import { STAGE_STATES, type StageReading } from "../src/dev/stageStates";
// the server's own words for a day (DD 1719 2): the gallery's states are checked against them
import { escapeHead, gaugesOf, nextLines, recoveryHead, type Assessed, type InputKey } from "../../server/src/invest/stages.ts";

const html = (el: ReactElement) => renderToStaticMarkup(el);
// the fixture is a day the rules allow: A 3 met (1 unknown) and D 1 make 탈출 3단계; R 2 with D 1, 회복 1단계 (nextLines' words)
// a nbsp from the app's ties reads as a space, a word joiner as nothing
const NBSP = String.fromCharCode(0xa0);
const WJ = String.fromCharCode(0x2060);
const text = (markup: string) => markup.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").split(NBSP).join(" ").split(WJ).join("");
/** the text of each element with that class, in order */
const texts = (markup: string, cls: string) => [...markup.matchAll(new RegExp(`<(p|span|div) class="${cls}[" ][^>]*>([\\s\\S]*?)</\\1>`, "g"))].map((m) => text(m[2]!));
const count = (markup: string, needle: string) => markup.split(needle).length - 1;
/** each gauge row's count part, nested spans and all */
const tails = (markup: string) => markup.split('class="ivgauge-tail" aria-hidden="true">').slice(1).map((x) => text(x.slice(0, x.indexOf("</div>"))));

function gauge(key: InvestStageGauge["key"], label: string, met: number, unknown: number, of: number): InvestStageGauge {
  const cells = Array.from({ length: of }, (_, i) => ({ id: `${key}${i}`, state: i < met ? ("met" as const) : i < met + unknown ? ("unknown" as const) : ("unmet" as const) }));
  return { key, label, met, of, unknown, cells, aria: `${label} ${of}개 중 ${met}개 충족${unknown ? `, 확인 불가 ${unknown}개` : ""}` };
}
const GAUGES = [gauge("worse", "악화 신호", 3, 1, 8), gauge("severe", "심각 신호", 1, 0, 5), gauge("recover", "회복 신호", 2, 0, 6)];
const judged = (o: Partial<Extract<InvestStages, { kind: "judged" }>> = {}): InvestStages => ({
  kind: "judged",
  escape: { stage: 3, name: "방어 준비", text: "탈출 3단계" },
  recovery: { stage: 1, name: "바닥 탐색", text: "회복 1단계" },
  gauges: GAUGES,
  next: ["탈출 4단계까지: 심각 신호 1개 더", "회복 2단계까지: 회복 신호 2개 더, 심각 신호 1개 덜"],
  judgedAt: Date.UTC(2026, 10, 26, 23, 0),
  judgedText: "11월 27일 08:00 판정 · 어제와 같아요",
  ...o,
});
const CAUTION_MARK = SIGNAL_SHAPES.caution;

describe("the head (DD 0059 §1-3)", () => {
  test("two rows, each its stage and its name beside it; under them the judgment line", () => {
    const m = html(createElement(IvStages, { stages: judged() }));
    expect(texts(m, "ivstage-line")).toEqual(["탈출 3단계 방어 준비", "회복 1단계 바닥 탐색"]);
    expect(texts(m, "ivstage-name")).toEqual(["방어 준비", "바닥 탐색"]);
    expect(texts(m, "ivstage-judged")).toEqual(["11월 27일 08:00 판정 · 어제와 같아요"]);
    // a settled board says nothing unsettled: no half-circle anywhere
    expect(count(m, CAUTION_MARK)).toBe(0);
    expect(m).not.toContain("ivstage-quiet");
  });
  test("the judgment line breaks only after a \" · \": each part one box, the dot ending the part before", () => {
    const m = html(createElement(IvStageHead, { heads: [], judged: "11월 27일 08:00 판정 · 탈출 2단계 → 탈출 최소 3단계 · 회복 0 → 1단계" }));
    expect([...m.matchAll(/<span class="ivstage-part">(.*?)<\/span>/g)].map((x) => x[1])).toEqual(["11월 27일 08:00 판정 ·", "탈출 2단계 → 탈출 최소 3단계 ·", "회복 0 → 1단계"]);
    expect(text(m)).toBe("11월 27일 08:00 판정 · 탈출 2단계 → 탈출 최소 3단계 · 회복 0 → 1단계");
    expect(html(createElement(IvStageHead, { heads: [], judged: "11월 27일 08:00 판정" }))).toBe('<div class="ivstage-heads"><p class="ivstage-judged"><span class="ivstage-part">11월 27일 08:00 판정</span></p></div>');
  });
  test("an unsettled stage has no name, even if one came; a hold (stage null) neither", () => {
    const heads: InvestStageHead[] = [
      { stage: 3, floor: true, name: "방어 준비", text: "탈출 최소 3단계", pending: "오늘 지표 1개를 받지 못해서 4단계 여부는 아직 몰라요.", pendingTone: "caution" },
      { stage: null, name: "바닥 탐색", text: "회복 판정 보류", pending: "회복 신호는 4개지만 심각 신호가 있어서 맞는 단계가 없어요.", pendingTone: "caution" },
    ];
    const m = html(createElement(IvStageHead, { heads, judged: "11월 27일 08:00 판정 · 어제와 같아요" }));
    expect(texts(m, "ivstage-line")).toEqual(["탈출 최소 3단계", "회복 판정 보류"]);
    expect(m).not.toContain("ivstage-name");
  });
  test("caution: the half-circle and the sentence right under its own row, once (DD 0059 §1-3)", () => {
    const m = html(
      createElement(IvStages, {
        stages: judged({ escape: { stage: 3, floor: true, text: "탈출 최소 3단계", pending: "오늘 지표 1개를 받지 못해서 4단계 여부는 아직 몰라요.", pendingTone: "caution" } }),
      }),
    );
    expect(count(m, CAUTION_MARK)).toBe(1);
    expect(texts(m, "ivstage-caution")).toEqual(["오늘 지표 1개를 받지 못해서 4단계 여부는 아직 몰라요."]);
    expect(count(m, "4단계 여부는")).toBe(1);
    // in the escape row's block, after its line and before the recovery row
    const esc = m.indexOf("탈출 최소 3단계");
    const pend = m.indexOf("ivstage-caution");
    const rec = m.indexOf("회복 1단계");
    expect(esc < pend && pend < rec).toBe(true);
    expect(m.slice(m.lastIndexOf('<div class="ivstage-head">', pend), pend)).toContain("탈출 최소 3단계");
  });
  test("quiet: no mark, a footnote line in its own class (DD 0426 §1); no tone from an older server is caution", () => {
    const quiet = html(
      createElement(IvStages, { stages: judged({ recovery: { stage: 1, floor: true, text: "회복 최소 1단계", pending: "지표 1개 값이 없어서 회복 단계는 아직 몰라요.", pendingTone: "quiet" } }) }),
    );
    expect(count(quiet, CAUTION_MARK)).toBe(0);
    expect(texts(quiet, "ivstage-quiet t-copy")).toEqual(["지표 1개 값이 없어서 회복 단계는 아직 몰라요."]);
    // the quiet line sits under its row and above the judgment line
    expect(quiet.indexOf("회복 최소 1단계") < quiet.indexOf("ivstage-quiet")).toBe(true);
    expect(quiet.indexOf("ivstage-quiet") < quiet.indexOf("ivstage-judged")).toBe(true);
    const old = html(createElement(IvStageHead, { heads: [{ stage: 1, floor: true, text: "탈출 최소 1단계", pending: "지표 3개 값이 없어서 2단계 여부는 아직 몰라요." }] }));
    expect(count(old, CAUTION_MARK)).toBe(1);
    expect(old).not.toContain("ivstage-quiet");
  });
  test("both tones on one board: one mark for the caution row, none for the quiet row", () => {
    const m = html(
      createElement(IvStages, {
        stages: judged({
          escape: { stage: 3, floor: true, text: "탈출 최소 3단계", pending: "오늘 지표 1개를 받지 못해서 4단계 여부는 아직 몰라요.", pendingTone: "caution" },
          recovery: { stage: 1, floor: true, text: "회복 최소 1단계", pending: "지표 1개 값이 없어서 회복 단계는 아직 몰라요.", pendingTone: "quiet" },
        }),
      }),
    );
    expect(count(m, CAUTION_MARK)).toBe(1);
    expect(texts(m, "ivstage-caution")).toEqual(["오늘 지표 1개를 받지 못해서 4단계 여부는 아직 몰라요."]);
    expect(texts(m, "ivstage-quiet t-copy")).toEqual(["지표 1개 값이 없어서 회복 단계는 아직 몰라요."]);
  });
  test("stale: the half-circle and the server's sentence in the judgment line's place; the numbers stay", () => {
    const stale = "오늘 08:00 판정을 하지 못했어요. 11월 26일 판정이에요.";
    const m = html(createElement(IvStages, { stages: judged({ stale, judgedText: "11월 26일 08:00 판정 · 어제와 같아요" }) }));
    expect(texts(m, "ivstage-caution")).toEqual([stale]);
    expect(m).not.toContain("ivstage-judged");
    expect(m).not.toContain("11월 26일 08:00 판정");
    expect(count(m, CAUTION_MARK)).toBe(1);
    // after both heads, before the gauges
    expect(m.indexOf("회복 1단계") < m.indexOf("ivstage-caution")).toBe(true);
    expect(m.indexOf("ivstage-caution") < m.indexOf('class="ivgauges')).toBe(true);
    expect(texts(m, "ivgauge-n tnum")).toEqual(["3/8", "1/5", "2/6"]);
  });
});

describe("gauge rows (DD 0141: quant's cells with APP_BOARD, quant's sentence)", () => {
  test("each row: the word, quant's own svg, the count; read as quant's sentence, the drawn parts hidden", () => {
    const m = html(createElement(IvGaugeRows, { gauges: GAUGES }));
    const kinds = { worse: "escape", severe: "severe", recover: "recovery" } as const;
    const rows = m.split('<div class="ivgauge"').slice(1);
    expect(rows.length).toBe(3);
    GAUGES.forEach((g, i) => {
      const k = kinds[g.key];
      const c = { met: g.met, unknown: g.unknown, of: g.of };
      const r = rows[i]!;
      expect(r).toContain(gaugeSvg(k, c, APP_BOARD).svg);
      expect(r).toContain(`data-w="${gaugeSvg(k, c, APP_BOARD).width}"`);
      expect(r).toMatch(new RegExp(`^ role="img" aria-label="${gaugeText(k, c)}" data-gauge="${g.key}">`));
      expect(gaugeText(k, c)).toBe(g.aria);
      expect(count(r, 'aria-hidden="true"')).toBe(3);
    });
    expect(texts(m, "ivgauge-word")).toEqual(["악화 신호", "심각 신호", "회복 신호"]);
    expect(texts(m, "ivgauge-n tnum")).toEqual(["3/8", "1/5", "2/6"]);
    // the cells in the gauges' colours: escape --caution, severe --danger, recovery --label (1935's table)
    expect(rows[0]).toContain('fill="var(--caution)" data-cell="met"');
    expect(rows[1]).toContain('fill="var(--danger)" data-cell="met"');
    expect(rows[2]).toContain('fill="var(--label)" data-cell="met"');
  });
  test("`· 확인 불가 n` beside the count only where a cell is not known", () => {
    const m = html(createElement(IvGaugeRows, { gauges: GAUGES }));
    expect(texts(m, "ivgauge-unknown")).toEqual([" · 확인 불가 1"]);
    expect(tails(m)).toEqual(["3/8 · 확인 불가 1", "1/5", "2/6"]);
    const two = html(createElement(IvGaugeRow, { gauge: gauge("severe", "심각 신호", 0, 3, 5) }));
    expect(tails(two)).toEqual(["0/5 · 확인 불가 3"]);
  });
  test("one row alone is the same row, measured on its own", () => {
    const one = html(createElement(IvGaugeRow, { gauge: GAUGES[2]! }));
    expect(one).toBe(html(createElement(IvGaugeRows, { gauges: [GAUGES[2]!] })));
    expect(one.startsWith('<div class="ivgauges">')).toBe(true);
  });
  test("counts that do not add up draw no cells (never a wrong bar), the words and the count stay", () => {
    const bad = { ...GAUGES[0]!, met: 7, unknown: 3 };
    const m = html(createElement(IvGaugeRow, { gauge: bad }));
    expect(m).not.toContain("<svg");
    expect(m).not.toContain("ivgauge-bar");
    expect(texts(m, "ivgauge-word")).toEqual(["악화 신호"]);
    expect(texts(m, "ivgauge-n tnum")).toEqual(["7/8"]);
  });
});

describe("the board (IvStages)", () => {
  test("in order: the heads, the rows worse · severe · recover, then the two next lines", () => {
    const m = html(createElement(IvStages, { stages: judged() }));
    const at = (s: string) => m.indexOf(s);
    expect(at("ivstage-heads") < at('data-gauge="worse"')).toBe(true);
    expect(at('data-gauge="worse"') < at('data-gauge="severe"') && at('data-gauge="severe"') < at('data-gauge="recover"')).toBe(true);
    expect(at('data-gauge="recover"') < at("ivstage-next")).toBe(true);
    expect([...m.slice(at("ivstage-next")).matchAll(/<p class="t-copy">([\s\S]*?)<\/p>/g)].map((x) => text(x[1]!))).toEqual([
      "탈출 4단계까지: 심각 신호 1개 더",
      "회복 2단계까지: 회복 신호 2개 더, 심각 신호 1개 덜",
    ]);
  });
  test("a next line breaks only after \": \" and \", \": its stage and each clause one box, a clause keeping its comma (DD 1719 1)", () => {
    const m = html(createElement(IvStages, { stages: judged({ next: ["회복 3단계까지: 회복 신호 1개 더(R3 포함), 탈출 2단계 이하", "탈출 4단계까지: 심각 신호 1개 더"] }) }));
    const next = m.slice(m.indexOf("ivstage-next"));
    expect([...next.matchAll(/<p class="t-copy">([\s\S]*?)<\/p>/g)].map((x) => [...x[1]!.matchAll(/<span class="ivstage-part">(.*?)<\/span>/g)].map((y) => y[1]))).toEqual([
      ["회복 3단계까지:", "회복 신호 1개 더(R3 포함),", "탈출 2단계 이하"],
      ["탈출 4단계까지:", "심각 신호 1개 더"],
    ]);
    // the boxes read as the line, word for word
    expect(nextParts("회복 2단계까지: 회복 신호 2개 더, 심각 신호 1개 덜").join(" ")).toBe("회복 2단계까지: 회복 신호 2개 더, 심각 신호 1개 덜");
    expect(nextParts("회복 3단계까지: R3 켜짐")).toEqual(["회복 3단계까지:", "R3 켜짐"]);
  });
  test("no next lines: no empty block", () => {
    expect(html(createElement(IvStages, { stages: judged({ next: [] }) }))).not.toContain("ivstage-next");
  });
  test("off and none: one line in the server's words, no gauges, no next, no head", () => {
    for (const [stages, line] of [
      [{ kind: "none", none: "첫 판정은 오늘 08:00에 나와요." }, "첫 판정은 오늘 08:00에 나와요."],
      [{ kind: "off", off: "지금은 지표를 받지 않아서 단계를 판정하지 않아요." }, "지금은 지표를 받지 않아서 단계를 판정하지 않아요."],
    ] as [InvestStages, string][]) {
      const m = html(createElement(IvStages, { stages }));
      expect(texts(m, "ivstage-empty t-copy")).toEqual([line]);
      for (const no of ["ivgauge", "ivstage-next", "ivstage-head", "<svg"]) expect(m).not.toContain(no);
    }
  });
  test("a kind this app does not know, nothing, or an older server's judged board: drawn as none (DD 0426 §3)", () => {
    const older = { kind: "judged", line: "탈출 2단계 · 회복 1단계", sub: "11월 27일 08:00 판정" } as unknown as InvestStages;
    // a judged board whose stage line has no words (lead 1719, K6): none, not a board with an empty head
    const noWords = [
      judged({ recovery: { stage: 1, name: "바닥 탐색", text: "" } }),
      judged({ recovery: undefined as unknown as InvestStageHead }),
      judged({ escape: { stage: 3, name: "방어 준비", text: "" } }),
      judged({ escape: undefined as unknown as InvestStageHead }),
      judged({ next: undefined as unknown as string[] }),
    ];
    for (const stages of [{ kind: "later" } as unknown as InvestStages, null, undefined, older, judged({ gauges: undefined as unknown as InvestStageGauge[] }), ...noWords]) {
      const m = html(createElement(IvStages, { stages }));
      expect(texts(m, "ivstage-empty t-copy")).toEqual([STAGE_UNKNOWN]);
      expect(m).not.toContain("ivgauge");
    }
  });
});

describe("styles", () => {
  const css = readFileSync(join(import.meta.dir, "../src/ui/Invest.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const rule = (sel: string) => {
    const i = css.indexOf(`\n${sel} {`);
    return i < 0 ? "" : css.slice(i, css.indexOf("}", i));
  };
  test("a mark in a sentence stays on its words' line: inline-block over base.css's block svg (screens-chat 0129)", () => {
    expect(rule(".sigmark")).toContain("display: inline-block;");
  });
  test("a judgment line's part and a stage's name are boxes: whole on a line while they fit one", () => {
    expect(rule(".ivstage-part")).toContain("display: inline-block;");
    expect(rule(".ivstage-name")).toContain("display: inline-block;");
    expect(rule(".ivstage-line")).toContain("word-break: keep-all;");
  });
  test("the cells go under the word for every row at once; the word and the count keep their own widths", () => {
    expect(rule(".ivgauges.is-stacked > .ivgauge")).toContain('"word tail"');
    expect(rule(".ivgauges.is-stacked > .ivgauge")).toContain('"bar bar"');
    expect(rule(".ivgauge")).toContain('"word bar tail"');
    for (const sel of [".ivgauge-word", ".ivgauge-tail"]) expect(rule(sel)).toContain("white-space: nowrap;");
    expect(rule(".ivgauge-word")).toContain("justify-self: start;");
    expect(rule(".ivgauge-tail")).toContain("justify-self: end;");
  });
  test("sizes (DD 0059 §1-3): stage title3/600, name body --label-2, caution subhead --label, quiet/judged/next footnote --label-2", () => {
    expect(rule(".ivstage-line")).toContain("font-size: var(--t-title3);");
    expect(rule(".ivstage-line")).toContain("font-weight: 600;");
    expect(rule(".ivstage-name")).toContain("font-size: var(--t-body);");
    expect(rule(".ivstage-name")).toContain("color: var(--label-2);");
    expect(rule(".ivstage-caution")).toContain("font-size: var(--t-subhead);");
    expect(rule(".ivstage-caution")).toContain("color: var(--label);");
    expect(rule(".ivstage-quiet,\n.ivstage-judged")).toContain("font-size: var(--t-footnote);");
    expect(rule(".ivstage-quiet,\n.ivstage-judged")).toContain("color: var(--label-2);");
    expect(rule(".ivstage-next > p,\n.ivstage-empty")).toContain("color: var(--label-2);");
  });
});

describe("the gallery's five states are days the rules allow, in the server's words (DD 1719 2)", () => {
  /** quant's reading of a state's day, as the judgment row keeps it */
  const read = (x: StageReading): Assessed => {
    const items = Array.from({ length: 11 }, (_, i) => {
      const no = i + 1;
      const signal: Signal = x.unknownCore?.includes(no) ? "unknown" : [1, 2, 4, 5, 6].slice(0, x.risk).includes(no) ? "risk" : "caution";
      return { no, name: `#${no}`, signal, value: null, asOf: null, reason: "", extras: {}, mayBeRisk: signal === "unknown" };
    });
    const counts: Record<Signal, number> = { normal: 0, caution: 0, risk: 0, unknown: 0 };
    for (const it of items) counts[it.signal]++;
    const core = { items, counts, riskPossible: counts.unknown, hyRisk: "unmet" } as unknown as Core11Result;
    const conds = (rules: Readonly<Record<string, string>>, st: Readonly<Record<string, string>> = {}) =>
      Object.entries(rules).map(([id, rule]) => ({ id, rule, status: st[id] ?? "unmet", figures: {}, asOf: "2026-11-26" }) as Condition);
    const [a, d, r] = [conds(ESCAPE_A_RULES, x.a), conds(ESCAPE_D_RULES, x.d), conds(RECOVERY_RULES, x.r)];
    return { core, a, d, r, escape: escapeStage(core, a, d), recovery: recoveryStage(r, core, a, d) } as unknown as Assessed;
  };
  const judgedStates = STAGE_STATES.filter((x) => x.stages.kind === "judged");
  test("four judged states and none; each judged one carries its day", () => {
    expect(STAGE_STATES.map((x) => x.name)).toEqual(["보통", "미확정", "보류", "stale", "none"]);
    expect(judgedStates.map((x) => x.name)).toEqual(["보통", "미확정", "보류", "stale"]);
    for (const x of judgedStates) expect([x.name, !!x.reading]).toEqual([x.name, true]);
  });
  test("heads, gauges and next lines are escapeHead, recoveryHead, gaugesOf and nextLines of that day, word for word", () => {
    for (const x of judgedStates) {
      const s = read(x.reading!);
      const miss = (k: InputKey) => x.reading!.missing?.[k] ?? null;
      const b = x.stages as Extract<InvestStages, { kind: "judged" }>;
      expect([x.name, b.escape]).toEqual([x.name, escapeHead(s, miss)]);
      expect([x.name, b.recovery]).toEqual([x.name, recoveryHead(s, miss)]);
      expect([x.name, b.gauges]).toEqual([x.name, gaugesOf(s)]);
      const n = nextLines(s);
      expect([x.name, b.next]).toEqual([x.name, [n.escape, n.recovery].filter((l): l is string => l !== null)]);
    }
  });
  test("the floors and ceilings quant reads: 보통 2 and 1 settled, 미확정 two floors, 보류 3 and hold, stale 2 and 2", () => {
    const got = judgedStates.map((x) => {
      const s = read(x.reading!);
      return [x.name, s.escape.floor, s.escape.ceiling, s.recovery.stage, s.recovery.possible];
    });
    expect(got).toEqual([
      ["보통", 2, 2, 1, [1]],
      ["미확정", 2, 3, null, [1, 2]],
      ["보류", 3, 3, "hold", ["hold"]],
      ["stale", 2, 2, 2, [2]],
    ]);
  });
});
