/**
 * The deck generator's two inputs (PLAN §3-C, DD 1935 §5, DD 0059 §6). The model writes only the slide JSON (`DeckSpec`):
 * words, and in place of every number a figure id in braces (`{vix}`). The server holds the figures and every chart's
 * data (`DeckData`), computed by code, each figure with its as of and source. The generator checks the JSON, fills the
 * ids with the §0-5 formatter and renders the F-A pages; the model never writes a number (A1, FA4 #9).
 */
import type { FlowChartInput, Grid11Item, LevelChartInput, Signal, TimelineEvent, Tri } from "@pickle/quant";

export const DECK_KINDS = [
  "hero",
  "numbers3",
  "signal-board",
  "issue+capture",
  "table",
  "grid11",
  "gauges",
  "roe-pbr",
  "flows",
  "level-chart",
  "scenarios",
  "timeline",
  "risks",
  "if-then",
  "appendix",
  "sources",
  "disclaimer",
] as const;
export type DeckKind = (typeof DECK_KINDS)[number];

export type Grade = "A" | "B+" | "B" | "C";
export const GRADES: readonly Grade[] = ["A", "B+", "B", "C"];

// ---- the model's JSON ----

interface SlideBase {
  /** one of the deck's `sections` (the tab it lights); hero and disclaimer have none */
  section?: string;
  /** ≤16 characters */
  kicker: string;
  /** ≤30 characters, two lines at most */
  headline: string;
}

export interface HeroSlide extends SlideBase {
  kind: "hero";
  /** ≤80 characters */
  lead: string;
  /** a part of the headline or the lead, highlighted (형광 #FFE066) */
  highlight?: string;
  /** the hand-drawn red circle around the highlight */
  mark?: boolean;
}
export interface Numbers3Slide extends SlideBase {
  kind: "numbers3";
  /** exactly three: a figure id, a label ≤10, a note ≤30 */
  items: { ref: string; label: string; note: string }[];
}
export interface SignalBoardSlide extends SlideBase {
  kind: "signal-board";
  /** ≤40 */
  note: string;
}
export interface CaptureSlide extends SlideBase {
  kind: "issue+capture";
  /** one or two captures from the capture store, each with the model's caption ≤40 */
  captures: { assetId: string; caption: string }[];
  /** two or three cards: a label ≤8 (사실, 반박, 판정), a text ≤50, the grade of what it says */
  points: { label: string; text: string; grade: Grade }[];
}
export interface TableColumn {
  key: string;
  /** ≤10 */
  label: string;
  /** in the header, never in the cells (FA7) */
  unit?: string;
  align?: "left" | "right";
}
export interface TableSlide extends SlideBase {
  kind: "table" | "appendix";
  columns: TableColumn[];
  /** a cell is a figure id in braces or the model's words; table ≤6 rows, appendix ≤10 */
  rows: Record<string, string>[];
  /** the row index drawn in bold on #FFFDF6 */
  highlightRow?: number;
}
export interface Grid11Slide extends SlideBase {
  kind: "grid11";
}
export interface GaugesSlide extends SlideBase {
  kind: "gauges";
  /** whose conditions the list shows: the escape (A1–A8, D1–D5) or the recovery (R1–R6) conditions */
  focus: "escape" | "recovery";
  /** ≤40 */
  note: string;
}
export interface RoePbrSlide extends SlideBase {
  kind: "roe-pbr";
  /** a key of DeckData.valuation */
  company: string;
  /** two notes ≤40 */
  notes: string[];
}
export interface FlowsSlide extends SlideBase {
  kind: "flows";
  /** a key of DeckData.flows */
  symbol: string;
  /** up to two notes ≤40 */
  notes: string[];
}
export interface LevelChartSlide extends SlideBase {
  kind: "level-chart";
  /** a key of DeckData.charts */
  symbol: string;
  /** ≤40: the chart's annotation, in its caption row */
  note: string;
}
export interface ScenariosSlide extends SlideBase {
  kind: "scenarios";
  /** exactly three: a name ≤12, a probability only when a model or backtest gives one (E4-3), up to three triggers ≤30,
   * the expected move (an estimate) */
  cols: { name: string; probRef?: string; triggers: string[]; amplitudeRef?: string }[];
}
export interface TimelineSlide extends SlideBase {
  kind: "timeline";
}
export interface RisksSlide extends SlideBase {
  kind: "risks";
  /** three to five (B-2: at least three ways to be wrong): the condition ≤40, the figure now and its threshold */
  items: { text: string; ref: string; thresholdRef: string }[];
}
export interface IfThenSlide extends SlideBase {
  kind: "if-then";
  /** ≤6 rows: if ≤30, then ≤30 (관찰 and 검토, never a recommendation), basis ≤30 */
  rows: { if: string; then: string; basis: string }[];
}
export interface SourcesSlide extends SlideBase {
  kind: "sources";
}
export interface DisclaimerSlide extends SlideBase {
  kind: "disclaimer";
  /** a playbook-type deck adds FA9's second sentence */
  playbook: boolean;
}

export type Slide =
  | HeroSlide
  | Numbers3Slide
  | SignalBoardSlide
  | CaptureSlide
  | TableSlide
  | Grid11Slide
  | GaugesSlide
  | RoePbrSlide
  | FlowsSlide
  | LevelChartSlide
  | ScenariosSlide
  | TimelineSlide
  | RisksSlide
  | IfThenSlide
  | SourcesSlide
  | DisclaimerSlide;

export interface DeckSpec {
  /** four to eight tab names, ≤8 characters each */
  sections: string[];
  /** the chat card's three to five lines (FA8-6), one sentence each, ≤60 */
  summary: string[];
  slides: Slide[];
}

// ---- the server's data ----

export interface DeckSource {
  /** the short name the footers use: FRED, CBOE, 토스증권 */
  name: string;
  title: string;
  publisher: string;
  /** YYYY-MM-DD */
  date: string;
  /** domain/path as shown (no scheme) */
  url: string;
  grade: Grade;
}

/** a figure the server computed; null is 확인 불가 (A1), never 0 */
export interface DeckFigure {
  value: number | null;
  /** pm: an expected move, ±2.0% */
  format: "usd" | "krw" | "index" | "rate" | "pct" | "pp" | "count" | "multiple" | "pm";
  digits?: number;
  /** count: the unit written after the number (조, 억원, 명) */
  unit?: string;
  /** written 약 …(추정) */
  estimate?: boolean;
  /** YYYY-MM-DD or an ISO time: shown beside the figure when its day differs from the deck's as of */
  asOf: string;
  /** a key of DeckData.sources */
  source: string;
  /** another source's value for the same thing (the data layer marked a conflict): written beside it (B-2) */
  conflict?: { value: number; source: string };
}

export interface DeckCondition {
  id: string;
  rule: string;
  status: Tri;
  /** the figures behind it, formatted by the server: "VIX 24.10", "확인 불가" */
  value: string;
}

export interface DeckCapture {
  /** data:image/png;base64,… or data:image/jpeg;base64,… from the capture store */
  src: string;
  width: number;
  height: number;
  /** 매체 */
  outlet: string;
  /** the account or programme, when there is one */
  account?: string;
  url: string;
  /** epoch ms */
  capturedAt: number;
  grade: Grade;
}

export interface DeckData {
  /** the server names the deck: 11월 27일 일일 심층판 · SOXL 심층판 · 11월 27일 */
  title: string;
  /** the data's as of and the generation time, epoch ms */
  asOf: number;
  generatedAt: number;
  figures: Record<string, DeckFigure>;
  /** the server's phrases the model may name like a figure ({escape_label} → 2단계 경계); a stage or a count is never
   * the model's to write */
  words?: Record<string, string>;
  sources: Record<string, DeckSource>;
  captures: Record<string, DeckCapture>;
  core11?: { items: Grid11Item[]; sources: string[] };
  stages?: {
    escape: { label: string; gauges: { a: { met: number; unknown: number; of: 8 }; d: { met: number; unknown: number; of: 5 } } };
    recovery: { label: string; gauge: { met: number; unknown: number; of: 6 } };
    /** the scenario word: A 연착륙 · B 둔화 · C 침체 */
    scenario: string;
    /** a stage that moved since the last report: "탈출 2단계 → 3단계" (drawn as the slide's highlighted line) */
    moved?: string;
    conditions: { escape: DeckCondition[]; severe: DeckCondition[]; recovery: DeckCondition[] };
    /** the server's sentence: what the next stage still needs */
    next: { escape: string; recovery: string };
    sources: string[];
  };
  flows?: Record<
    string,
    {
      chart: FlowChartInput;
      /** D7: the short-cover threshold, the server's words and figure */
      threshold: { title: string; formula: string; value: string };
      /** D8: the five criteria */
      criteria: { rule: string; status: Tri; value: string }[];
      sources: string[];
    }
  >;
  charts?: Record<string, { input: LevelChartInput; sources: string[] }>;
  valuation?: Record<
    string,
    {
      /** the methods' figure on one scale: the implied ASP decline per method */
      methods: { name: string; value: number }[];
      unit: string;
      digits: number;
      asOf: string;
      source: string;
      /** the hero figure (a key of figures) and its label */
      heroRef: string;
      heroLabel: string;
      sources: string[];
    }
  >;
  events?: { list: TimelineEvent[]; asOf: string; source: string; sources: string[] };
}

/** a broken rule: where, which rule (FA4-n, B2-…, schema, limit), and what, in words the model can act on */
export interface DeckFail {
  n?: number;
  kind?: string;
  rule: string;
  what: string;
}

export type { Signal };
