/**
 * ① 시장 단계's five states for the gallery (DD 0059 §1-6, DD 0141, DD 1719 2): each judged one is a day quant's rules
 * can read — its 11-indicator count, A1–A8, D1–D5 and R1–R6, and why an input is missing — and every word on it is what
 * the server says for that day (escapeHead, recoveryHead, gaugesOf, nextLines). invest-stage-board.test.ts reads each
 * day again with quant and the server's own functions and asserts the state word for word. All synthetic.
 */
import { ESCAPE_A_RULES, ESCAPE_D_RULES, RECOVERY_RULES, type Tri } from "@pickle/quant";
import type { InvestStageGauge, InvestStages } from "@pickle/protocol";

/** a day as quant reads it: how many of the 11 are 🔴, which have no value, A / D / R (unmet when not named), and why an input is missing */
export interface StageReading {
  risk: number;
  unknownCore?: number[];
  a?: Readonly<Record<string, Tri>>;
  d?: Readonly<Record<string, Tri>>;
  r?: Readonly<Record<string, Tri>>;
  missing?: Readonly<Record<string, "none" | "today">>;
}

/** a gauge as the server sends it: every condition's cell in rule order */
function stageGauge(key: InvestStageGauge["key"], label: string, rules: Readonly<Record<string, string>>, st: Readonly<Record<string, Tri>> = {}): InvestStageGauge {
  const cells = Object.keys(rules).map((id) => ({ id, state: st[id] ?? ("unmet" as const) }));
  const met = cells.filter((c) => c.state === "met").length;
  const unknown = cells.filter((c) => c.state === "unknown").length;
  return { key, label, met, of: cells.length, unknown, cells, aria: `${label} ${cells.length}개 중 ${met}개 충족${unknown ? `, 확인 불가 ${unknown}개` : ""}` };
}
const gaugesOf = (x: StageReading): InvestStageGauge[] => [stageGauge("worse", "악화 신호", ESCAPE_A_RULES, x.a), stageGauge("severe", "심각 신호", ESCAPE_D_RULES, x.d), stageGauge("recover", "회복 신호", RECOVERY_RULES, x.r)];

const JUDGED_AT = Date.UTC(2026, 10, 26, 23, 0);

const NORMAL: StageReading = { risk: 3, a: { A1: "met" }, d: { D1: "met" }, r: { R1: "met", R2: "met" } };
// A6 and R4 have no value (capex, breadth: nowhere to get them yet), so both stages are floors, each said quietly
const OPEN: StageReading = { risk: 3, unknownCore: [7, 11], a: { A1: "met", A6: "unknown" }, r: { R2: "met", R4: "unknown", R5: "met", R6: "met" }, missing: { capex: "none", breadth200: "none" } };
const HELD: StageReading = { risk: 3, a: { A1: "met", A4: "met", A5: "met", A6: "met", A7: "met" }, d: { D5: "met" }, r: { R1: "met", R2: "met", R4: "met", R6: "met" } };
const STALE: StageReading = { risk: 3, r: { R1: "met", R2: "met", R4: "met", R5: "met" } };

export const STAGE_STATES: { name: string; reading?: StageReading; stages: InvestStages }[] = [
  {
    name: "보통",
    reading: NORMAL,
    stages: {
      kind: "judged",
      escape: { stage: 2, name: "경계", text: "탈출 2단계" },
      recovery: { stage: 1, name: "바닥 탐색", text: "회복 1단계" },
      gauges: gaugesOf(NORMAL),
      next: ["탈출 3단계까지: 악화 신호 1개 더", "회복 2단계까지: 회복 신호 2개 더, 심각 신호 1개 덜"],
      judgedAt: JUDGED_AT,
      judgedText: "11월 27일 08:00 판정 · 회복 0 → 1단계",
    },
  },
  {
    name: "미확정",
    reading: OPEN,
    stages: {
      kind: "judged",
      escape: { stage: 2, floor: true, text: "탈출 최소 2단계", pending: "지표 1개 값이 없어서 3단계 여부는 아직 몰라요.", pendingTone: "quiet" },
      recovery: { stage: 1, floor: true, text: "회복 최소 1단계", pending: "지표 2개 값이 없어서 회복 단계는 아직 몰라요.", pendingTone: "quiet" },
      gauges: gaugesOf(OPEN),
      next: ["탈출 3단계까지: 악화 신호 1개 더", "회복 2단계까지: 회복 신호 1개 더"],
      judgedAt: JUDGED_AT,
      judgedText: "11월 27일 08:00 판정 · 탈출 1단계 → 탈출 최소 2단계",
    },
  },
  {
    name: "보류",
    reading: HELD,
    stages: {
      kind: "judged",
      escape: { stage: 3, name: "방어 준비", text: "탈출 3단계" },
      recovery: { stage: null, text: "회복 판정 보류", pending: "회복 신호는 4개지만 심각 신호가 있어서 맞는 단계가 없어요.", pendingTone: "caution" },
      gauges: gaugesOf(HELD),
      next: ["탈출 4단계까지: 심각 신호 1개 더", "회복 2단계까지: 심각 신호 1개 덜"],
      judgedAt: JUDGED_AT,
      judgedText: "11월 27일 08:00 판정 · 회복 1단계 → 회복 판정 보류",
    },
  },
  {
    name: "stale",
    reading: STALE,
    stages: {
      kind: "judged",
      escape: { stage: 2, name: "경계", text: "탈출 2단계" },
      recovery: { stage: 2, name: "분할 재진입 검토", text: "회복 2단계" },
      gauges: gaugesOf(STALE),
      next: ["탈출 3단계까지: 악화 신호 2개 더", "회복 3단계까지: 회복 신호 1개 더(R3 포함)"],
      judgedAt: JUDGED_AT - 86_400_000,
      judgedText: "11월 26일 08:00 판정 · 어제와 같아요",
      stale: "오늘 08:00 판정을 하지 못했어요. 11월 26일 판정이에요.",
    },
  },
  { name: "none", stages: { kind: "none", none: "첫 판정은 오늘 오전 8시에 나와요." } },
];
