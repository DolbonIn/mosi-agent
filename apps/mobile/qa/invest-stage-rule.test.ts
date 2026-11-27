// ① 시장 단계's rule for screens that set the board in their own frame (DD 0055 §1, team-lead 0112): ui/Invest's
// drawable(stages) and stageEmptyLine(stages), the one rule IvStages itself draws by (no second copy).
//   bun test ./qa/invest-stage-rule.test.ts
import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { InvestStageGauge, InvestStageHead, InvestStages } from "@pickle/protocol";
import { drawable, IvStages, stageEmptyLine, STAGE_UNKNOWN } from "../src/ui/Invest";
import { STAGE_STATES } from "../src/dev/stageStates";

// a nbsp from the app's ties reads as a space, a word joiner as nothing
const NBSP = String.fromCharCode(0xa0);
const WJ = String.fromCharCode(0x2060);
const text = (markup: string) => markup.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").split(NBSP).join(" ").split(WJ).join("");

function gauge(key: InvestStageGauge["key"], label: string, met: number, of: number): InvestStageGauge {
  const cells = Array.from({ length: of }, (_, i) => ({ id: `${key}${i}`, state: i < met ? ("met" as const) : ("unmet" as const) }));
  return { key, label, met, of, unknown: 0, cells, aria: `${label} ${of}개 중 ${met}개 충족` };
}
const judged = (o: Partial<Extract<InvestStages, { kind: "judged" }>> = {}): InvestStages => ({
  kind: "judged",
  escape: { stage: 2, name: "경계", text: "탈출 2단계" },
  recovery: { stage: 0, name: "회복 전", text: "회복 0단계" },
  gauges: [gauge("worse", "악화 신호", 2, 8), gauge("severe", "심각 신호", 0, 5), gauge("recover", "회복 신호", 0, 6)],
  next: ["탈출 3단계까지: 악화 신호 1개 더"],
  judgedAt: Date.UTC(2026, 10, 26, 23, 0),
  judgedText: "11월 27일 08:00 판정 · 어제와 같아요",
  ...o,
});
const OFF = "지금은 지표를 받지 않아서 단계를 판정하지 않아요.";
const NONE = "첫 판정은 곧 나와요.";
const off = { kind: "off", off: OFF } as InvestStages;
const none = { kind: "none", none: NONE } as InvestStages;
// boards this app cannot draw: a kind it does not know, nothing, an older server's judged board, a judged board short of a part
const UNDRAWABLE: [string, InvestStages | null | undefined][] = [
  ["unknown kind", { kind: "later" } as unknown as InvestStages],
  ["unknown kind with a full board's parts", { ...judged(), kind: "later" } as unknown as InvestStages],
  ["null", null],
  ["undefined", undefined],
  ["older judged", { kind: "judged", line: "탈출 2단계 · 회복 1단계", sub: "11월 27일 08:00 판정" } as unknown as InvestStages],
  ["no gauges", judged({ gauges: undefined as unknown as InvestStageGauge[] })],
  ["no next", judged({ next: undefined as unknown as string[] })],
  ["no escape", judged({ escape: undefined as unknown as InvestStageHead })],
  ["escape without words", judged({ escape: { stage: 2, name: "경계", text: "" } })],
  ["no recovery", judged({ recovery: undefined as unknown as InvestStageHead })],
  ["recovery without words", judged({ recovery: { stage: 0, name: "회복 전", text: "" } })],
];

describe("drawable(stages)", () => {
  test("a judged board with both heads, gauges and next lines (next may be empty)", () => {
    expect(drawable(judged())).toBe(true);
    expect(drawable(judged({ next: [] }))).toBe(true);
  });
  test("off, none, a kind this app does not know, nothing, an older or broken judged board: not drawable", () => {
    expect([drawable(off), drawable(none)]).toEqual([false, false]);
    for (const [name, s] of UNDRAWABLE) expect([name, drawable(s)]).toEqual([name, false]);
  });
});

describe("stageEmptyLine(stages)", () => {
  test("off and none: the server's own words", () => {
    expect(stageEmptyLine(off)).toBe(OFF);
    expect(stageEmptyLine(none)).toBe(NONE);
  });
  test("an unknown kind or any board this app cannot draw: STAGE_UNKNOWN", () => {
    for (const [name, s] of UNDRAWABLE) expect([name, stageEmptyLine(s)]).toEqual([name, STAGE_UNKNOWN]);
  });
  test("off or none with no words: STAGE_UNKNOWN, never an empty line", () => {
    expect(stageEmptyLine({ kind: "off", off: "" } as InvestStages)).toBe(STAGE_UNKNOWN);
    expect(stageEmptyLine({ kind: "none", none: "" } as InvestStages)).toBe(STAGE_UNKNOWN);
  });
  test("a drawable board: null (the board is drawn, no line)", () => {
    expect(stageEmptyLine(judged())).toBeNull();
    expect(stageEmptyLine(judged({ next: [] }))).toBeNull();
  });
});

describe("IvStages draws by the same rule", () => {
  const ALL: [string, InvestStages | null | undefined][] = [
    ["judged", judged()],
    ["off", off],
    ["none", none],
    ["off blank", { kind: "off", off: "" } as InvestStages],
    ...UNDRAWABLE,
    ...STAGE_STATES.map((x) => [`gallery ${x.name}`, x.stages] as [string, InvestStages]),
  ];
  test("a board exactly when drawable; otherwise one line, the text stageEmptyLine gives", () => {
    for (const [name, s] of ALL) {
      const m = renderToStaticMarkup(createElement(IvStages, { stages: s }));
      const line = stageEmptyLine(s);
      const empty = [...m.matchAll(/<p class="ivstage-empty t-copy">([\s\S]*?)<\/p>/g)].map((x) => text(x[1]!));
      if (drawable(s)) {
        expect([name, line, empty, m.startsWith('<div class="ivstages">')]).toEqual([name, null, [], true]);
      } else {
        expect([name, empty, m.includes("ivgauge")]).toEqual([name, [line], false]);
      }
    }
  });
  test("one rule in ui/Invest: the kind words and the judged checks appear once, in drawable and its line", () => {
    const src = readFileSync(join(import.meta.dir, "../src/ui/Invest.tsx"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const count = (needle: string) => src.split(needle).length - 1;
    expect([count('kind === "off"'), count('kind === "none"'), count('kind === "judged"'), count("Array.isArray(s.gauges)")]).toEqual([1, 1, 1, 1]);
    expect(count("export const drawable = ")).toBe(1);
    expect(count("if (!drawable(stages)) return")).toBe(1);
    expect(count("STAGE_UNKNOWN")).toBe(2); // the constant and the one fallback
  });
});
