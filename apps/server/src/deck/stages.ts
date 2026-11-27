/**
 * The deck's stage cell from the day's reading (DD 1704 2): the heads, the gauges and the next lines are the 투자
 * screen's own — escapeHead, recoveryHead, gaugesOf and nextLines over quant's assessStages — so the deck and the app
 * never say different things. Nothing here writes a stage, a count or a next word of its own.
 */
import { escapeHead, gaugesOf, nextLines, recoveryHead, stageChanges, type Assessed, type InputKey, type Missing, type StageGauge, type StageHead } from "../invest/stages";
import type { DeckCondition, DeckData, DeckStageHead } from "./types";

export type DeckStages = NonNullable<DeckData["stages"]>;

export interface DeckStagesOptions {
  /**
   * each condition's figures as the server formats them ("VIX 27.40 · 2일째"). An unknown condition shows only the part
   * that is known ("2년물 > 상단 · 근원 CPI 확인 불가"), else nothing: its status cell already says 확인 불가 (DD 2236)
   */
  values: Readonly<Record<string, string>>;
  scenario: string;
  /** the reading before this one (the last report's day): the moved line is stageChanges between the two, the app's words */
  before?: Assessed;
  sources: string[];
  /** why an input is missing, for a head's pending line (the app's own reasons); none given: nothing is missing */
  missing?: (k: InputKey) => Missing;
}

/** a value that only says there is no value: the status cell says it already (DD 2236: one word, said once) */
const NO_VALUE = /^\s*(확인 불가|자료 없음)\s*$/;

const head = (h: StageHead): DeckStageHead => ({ text: h.text, ...(h.name ? { name: h.name } : {}), ...(h.pending ? { pending: h.pending } : {}) });

/** the rule as the master prompt writes it, without its markdown */
const plain = (s: string) => s.replace(/\*\*|`/g, "");

/**
 * The ids a note may name beside a next line: what each of its clauses still needs (nextLines, 4a7b7ba). "<신호> n개
 * 더" needs that gauge's unmet conditions to come on; "심각 신호 n개 덜" needs its met ones to go off; "R3 켜짐" needs
 * R3. 핵심 위험 지표, 하이일드 스프레드 위험 and 탈출 2단계 이하 name no condition, and an unknown one is never named.
 */
export function noteIdsFor(line: string | null, gauges: readonly StageGauge[]): string[] {
  if (!line) return [];
  const out = new Set<string>();
  for (const clause of line.slice(line.indexOf(":") + 1).split(",")) {
    const g = gauges.find((x) => clause.includes(x.label));
    const want = !g ? null : clause.includes("개 더") ? "unmet" : clause.includes("개 덜") ? "met" : null;
    if (g && want) for (const c of g.cells) if (c.state === want) out.add(c.id);
    if (clause.includes("R3 켜짐") && gauges.some((x) => x.cells.some((c) => c.id === "R3" && c.state === "unmet"))) out.add("R3");
  }
  return [...out];
}

export function deckStages(s: Assessed, o: DeckStagesOptions): DeckStages {
  const missing = o.missing ?? (() => null);
  const gauges = gaugesOf(s);
  const g = (key: StageGauge["key"]) => {
    const x = gauges.find((y) => y.key === key)!;
    return { met: x.met, unknown: x.unknown };
  };
  const next = nextLines(s);
  const conds = (cs: Assessed["a"]): DeckCondition[] =>
    cs.map((c) => {
      const v = o.values[c.id] ?? "";
      return { id: c.id, rule: plain(c.rule), status: c.status, value: c.status === "unknown" && NO_VALUE.test(v) ? "" : v };
    });
  const quiet = () => null;
  // moved() reads a head's text, stage and floor, none of which depends on why an input is missing
  const moved = o.before ? stageChanges({ escape: escapeHead(o.before, quiet), recovery: recoveryHead(o.before, quiet) }, { escape: escapeHead(s, quiet), recovery: recoveryHead(s, quiet) }) : [];
  return {
    escape: { head: head(escapeHead(s, missing)), gauges: { a: { ...g("worse"), of: 8 }, d: { ...g("severe"), of: 5 } } },
    recovery: { head: head(recoveryHead(s, missing)), gauge: { ...g("recover"), of: 6 } },
    scenario: o.scenario,
    ...(moved.length ? { moved: moved.join(" · ") } : {}),
    conditions: { escape: conds(s.a), severe: conds(s.d), recovery: conds(s.r) },
    next,
    noteIds: { escape: noteIdsFor(next.escape, gauges), recovery: noteIdsFor(next.recovery, gauges) },
    sources: o.sources,
  };
}

/** a head as one phrase, for the words the model may name ({escape_label} → 탈출 2단계 경계) */
export const headPhrase = (h: DeckStageHead): string => (h.name ? `${h.text} ${h.name}` : h.text);
