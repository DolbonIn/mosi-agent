/**
 * B2b-2: the A2 → A5 → A6 reading (the 11 core indicators, A1–A8, D1–D5, R1–R6 and the two stages) over the macro
 * series B2e-0 reads, the person's own ledger figures for 6, 7, 8 and 11 (stage-ledger.ts) and the KOSPI foreign
 * flows of the person's own Toss read for 9 and R6 (B2e), by @pickle/quant's assessStages. The server only gathers the inputs and says where each came from; every comparison and stage rule is
 * quant's. A series that could not be read is left out, so whatever rests on it is unknown (확인 불가), never unmet.
 */
import { assessStages, civilDate, dayNumber, momFromIndex, NO_DATA, num, pct, pp, rate, type Point, type StageInput } from "@pickle/quant";
import type { Core } from "../core.ts";
import { marketDaysAfter, type DayOverride } from "./calendar.ts";
import { dayWords } from "./forecasts.ts";
import { fredSeries, indexBars, type FredId } from "./macro.ts";
import { SOURCE_TABLE } from "./sources.ts";
import { BREADTH_STALE_US_DAYS, LEDGER_KEYS, ledgerFeed, QUARTERLY_STALE_DAYS } from "./stage-ledger.ts";

/** which FRED series feeds which input (CPILFESL feeds coreCpiMoM through momFromIndex) */
export const FRED_FEEDS = {
  dgs10: "DGS10",
  dgs2: "DGS2",
  fedUpper: "DFEDTARU",
  hy: "BAMLH0A0HYM2",
  usdjpy: "DEXJPUS",
  unrate: "UNRATE",
  coreCpiMoM: "CPILFESL",
  vix: "VIXCLS",
  spx: "SP500",
  sahm: "SAHMREALTIME",
  claims4w: "IC4WSA",
  usdkrw: "DEXKOUS",
  nfci: "NFCI",
} as const satisfies Partial<Record<keyof StageInput, FredId>>;

export type FedInput = keyof typeof FRED_FEEDS | "kospi";

/** where one input came from: its last day with a value, the source's name and grade */
export interface InputBasis {
  asOf: string;
  source: string;
  grade: string;
}

export interface StageRead {
  input: StageInput;
  /** per input, or null when it could not be read */
  basis: Record<FedInput, InputBasis | null>;
}

/** read every series the stages need (one read per series; the source gate keeps one request at a time per host) */
export async function readStageInput(core: Core): Promise<StageRead> {
  const input: StageInput = {};
  const basis = {} as Record<FedInput, InputBasis | null>;
  const keys = Object.keys(FRED_FEEDS) as (keyof typeof FRED_FEEDS)[];
  const [series, kospi] = await Promise.all([Promise.all(keys.map((k) => fredSeries(core, FRED_FEEDS[k]))), indexBars(core, "^KS11")]);
  keys.forEach((k, i) => {
    const s = series[i];
    if (!s) {
      basis[k] = null;
      return;
    }
    const points: Point[] = k === "coreCpiMoM" ? momFromIndex(s.points) : s.points;
    (input as Record<string, readonly Point[]>)[k] = points;
    basis[k] = { asOf: s.asOf, source: s.source.name, grade: s.source.grade };
  });
  if (kospi) {
    input.kospi = kospi.bars.map((b) => ({ t: b.t, v: b.c }));
    basis.kospi = { asOf: kospi.asOf, source: kospi.source.name, grade: kospi.source.grade };
  } else basis.kospi = null;
  return { input, basis };
}

/** the reading now, from whatever could be read */
export async function readStages(core: Core) {
  const read = await readStageInput(core);
  return { ...read, ...assessStages(read.input) };
}

// ───────────────────────────── the board's words (DD 0059 §1-2, 0426 §1, 0428) ─────────────────────────────

export type Assessed = ReturnType<typeof assessStages>;
export type InputKey = keyof StageInput;

/** the inputs each indicator (#n) and condition rests on — to say how many of them are missing, and why */
export const NEEDS: Readonly<Record<string, readonly InputKey[]>> = {
  "#1": ["dgs10"],
  "#2": ["dgs2", "fedUpper"],
  "#3": ["hy"],
  "#4": ["usdjpy"],
  "#5": ["unrate"],
  "#6": ["eps3m"],
  "#7": ["breadth200"],
  "#8": ["m7"],
  "#9": ["foreignKospi"],
  "#10": ["coreCpiMoM"],
  "#11": ["capex"],
  A1: ["hy"],
  A2: ["vix"],
  A3: ["spx"],
  A4: ["coreCpiMoM"],
  A5: ["dgs10"],
  A6: ["capex"],
  A7: ["sahm", "claims4w"],
  A8: ["kospi", "usdkrw"],
  D1: ["hy"],
  D2: ["vix"],
  D3: ["spx"],
  D4: ["sahm"],
  D5: ["nfci"],
  R1: ["vix"],
  R2: ["hy"],
  R3: ["spx"],
  R4: ["breadth200"],
  R5: ["dgs2", "fedUpper", "coreCpiMoM"],
  R6: ["foreignKospi", "kospi"],
};

/**
 * why an input is missing: "none" — nowhere to get it yet (DD 0426: the quiet form); "connect" — it comes once the
 * person connects 토스증권 (B2e, DD 1857-b 2: quiet too); "today" — its source is there but it did not come (failed,
 * paused, or too old: the caution form); null — it is here
 */
export type Missing = "none" | "connect" | "today" | null;

const ESCAPE_NAMES = { 1: "관찰", 2: "경계", 3: "방어 준비", 4: "회피" } as const;
const RECOVERY_NAMES = { 0: "하락 진행", 1: "바닥 탐색", 2: "분할 재진입 검토", 3: "추세 회복" } as const;

/** 지표 3개 값이 없어서 / 오늘 지표 1개를 받지 못해서 / 지표 3개 값이 없고 오늘 1개를 받지 못해서 (DD 0426 §1: counts, never numbers) */
function becauseOf(open: readonly string[], missing: (k: InputKey) => Missing): { why: string; tone: "quiet" | "caution" } | null {
  const none = new Set<InputKey>();
  const today = new Set<InputKey>();
  let unexplained = 0;
  for (const id of open) {
    const keys = (NEEDS[id] ?? []).filter((k) => missing(k));
    if (!keys.length) unexplained++;
    for (const k of keys) (missing(k) === "today" ? today : none).add(k);
  }
  const t = today.size + unexplained;
  if (!none.size && !t) return null;
  if (!t) return { why: `지표 ${none.size}개 값이 없어서`, tone: "quiet" };
  if (!none.size) return { why: `오늘 지표 ${t}개를 받지 못해서`, tone: "caution" };
  return { why: `지표 ${none.size}개 값이 없고 오늘 ${t}개를 받지 못해서`, tone: "caution" };
}

export interface StageHead {
  stage: number | null;
  name?: string;
  text: string;
  floor?: boolean;
  pending?: string;
  pendingTone?: "quiet" | "caution";
}

export function escapeHead(s: Assessed, missing: (k: InputKey) => Missing): StageHead {
  const e = s.escape;
  if (e.confirmed) return { stage: e.floor, name: ESCAPE_NAMES[e.floor], text: `탈출 ${e.floor}단계` };
  const up = e.ceiling === e.floor + 1 ? `${e.ceiling}단계` : `${e.floor + 1}~${e.ceiling}단계`;
  const b = becauseOf(e.open, missing);
  return { stage: e.floor, floor: true, text: `탈출 최소 ${e.floor}단계`, ...(b ? { pending: `${b.why} ${up} 여부는 아직 몰라요.`, pendingTone: b.tone } : {}) };
}

export const RECOVERY_HOLD = "회복 판정 보류";

export function recoveryHead(s: Assessed, missing: (k: InputKey) => Missing): StageHead {
  const r = s.recovery;
  if (r.stage === "hold") return { stage: null, text: RECOVERY_HOLD, pending: `회복 신호는 ${r.gauge.met}개지만 심각 신호가 있어서 맞는 단계가 없어요.`, pendingTone: "caution" };
  if (r.stage !== null) return { stage: r.stage, name: RECOVERY_NAMES[r.stage], text: `회복 ${r.stage}단계` };
  const b = becauseOf(r.open, missing);
  const pending = b ? { pending: `${b.why} 회복 단계는 아직 몰라요.`, pendingTone: b.tone } : {};
  // DD 0428 §1: every outcome a numbered stage → the lowest, as a floor; "hold" among them → 미확정
  const nums = r.possible.filter((o): o is 0 | 1 | 2 | 3 => o !== "hold");
  if (nums.length === r.possible.length) return { stage: Math.min(...nums), floor: true, text: `회복 최소 ${Math.min(...nums)}단계`, ...pending };
  return { stage: null, text: "회복 단계 미확정", ...pending };
}

export interface StageGauge {
  key: "worse" | "severe" | "recover";
  label: string;
  met: number;
  of: number;
  unknown: number;
  cells: { id: string; state: "met" | "unmet" | "unknown" }[];
  aria: string;
}

function gauge(key: StageGauge["key"], label: string, cs: readonly { id: string; status: "met" | "unmet" | "unknown" }[]): StageGauge {
  const met = cs.filter((c) => c.status === "met").length;
  const unknown = cs.filter((c) => c.status === "unknown").length;
  return {
    key,
    label,
    met,
    of: cs.length,
    unknown,
    cells: cs.map((c) => ({ id: c.id, state: c.status })),
    aria: `${label} ${cs.length}개 중 ${met}개 충족${unknown ? `, 확인 불가 ${unknown}개` : ""}`,
  };
}

export const gaugesOf = (s: Assessed): StageGauge[] => [gauge("worse", "악화 신호", s.a), gauge("severe", "심각 신호", s.d), gauge("recover", "회복 신호", s.r)];

/**
 * what the next stage up needs, from the stage that surely holds (DD 0059 §1-2 next). DD 1719 · 1720: a clause whose
 * count is 0 is left out; severe signals are how many fewer; `(R3 포함)` only while R3 is not on (unknown is not on),
 * `R3 켜짐` when R3 is all that is missing; `탈출 2단계 이하` only while the escape may be 3 or more; no clause, no line.
 * The escape lines' counts are never 0 at their floor (the floor would be higher).
 */
export function nextLines(s: Assessed): { escape: string | null; recovery: string | null } {
  const e = s.escape;
  const aMet = s.a.filter((c) => c.status === "met").length;
  const dMet = s.d.filter((c) => c.status === "met").length;
  const rMet = s.r.filter((c) => c.status === "met").length;
  let escape: string | null = null;
  if (e.floor === 1) escape = `탈출 2단계까지: 핵심 위험 지표 ${Math.max(0, 3 - s.core.counts.risk)}개 더, 또는 하이일드 스프레드 위험`;
  else if (e.floor === 2) escape = `탈출 3단계까지: 악화 신호 ${Math.max(0, 2 - aMet)}개 더`;
  else if (e.floor === 3) escape = `탈출 4단계까지: 심각 신호 ${Math.max(0, 2 - dMet)}개 더`;
  const r = s.recovery;
  const at = typeof r.stage === "number" ? r.stage : r.stage === null ? Math.min(...r.possible.filter((o): o is 0 | 1 | 2 | 3 => o !== "hold"), 3) : null;
  const line = (head: string, clauses: readonly (string | null)[]): string | null => {
    const kept = clauses.filter((c): c is string => c !== null);
    return kept.length ? `${head}: ${kept.join(", ")}` : null;
  };
  const more = (n: number, tail = ""): string | null => (n > 0 ? `회복 신호 ${n}개 더${tail}` : null);
  let recovery: string | null = null;
  if (at === 0) recovery = line("회복 1단계까지", [more(2 - rMet)]);
  else if (at === 1 || (r.stage === "hold" && dMet > 0)) recovery = line("회복 2단계까지", [more(4 - rMet), dMet > 0 ? `심각 신호 ${dMet}개 덜` : null]);
  else if (at === 2) {
    const r3On = s.r.some((c) => c.id === "R3" && c.status === "met");
    const n = 5 - rMet;
    recovery = line("회복 3단계까지", [r3On ? more(n) : n > 0 ? more(n, "(R3 포함)") : "R3 켜짐", e.ceiling >= 3 ? "탈출 2단계 이하" : null]);
  }
  return { escape, recovery };
}

// ───────────────────────────── the day's judgment (v12) ─────────────────────────────

export const JUDGE_HOUR_KST = 8;
const HOUR = 3_600_000;
const DAY_MS = 86_400_000;

/** what a judgment row keeps: quant's reading and, per input, where it came from or why it is missing */
export interface Judged extends Assessed {
  basis: Record<string, InputBasis | null>;
  missing: Partial<Record<InputKey, Missing>>;
  /** a ledger figure or a KR daily series left out for its age: its as-of (DD 0426 §1, DD 2027) */
  old?: Partial<Record<InputKey, string>>;
}

export interface JudgmentRow {
  user_id: string;
  day: string;
  at: number;
  json: string;
}

/** why each fetched input is missing in this reading */
export function missingOf(read: StageRead): Partial<Record<InputKey, Missing>> {
  const out: Partial<Record<InputKey, Missing>> = {};
  for (const [k, b] of Object.entries(read.basis)) out[k as InputKey] = b ? null : "today";
  return out;
}

/**
 * B2e (team-lead 1854, DD 1857-b): foreigners' daily net KOSPI buying in 억원, settled days of this person's own Toss
 * read, or why it is not here: "none" — the server has no Toss; "connect" — the person has no Toss login; "today" —
 * paused, refused, failed or empty today
 */
export type FlowRead = { ok: true; points: readonly Point[] } | { ok: false; why: "none" | "connect" | "today" };
const NO_FLOW: FlowRead = { ok: false, why: "none" };

function flowFeed(f: FlowRead): { input: StageInput; basis: Record<string, InputBasis | null>; missing: Partial<Record<InputKey, Missing>> } {
  if (f.ok && f.points.length) {
    const toss = SOURCE_TABLE.toss;
    return { input: { foreignKospi: f.points }, basis: { foreignKospi: { asOf: f.points.at(-1)!.t, source: toss.name, grade: toss.grade } }, missing: { foreignKospi: null } };
  }
  return { input: {}, basis: { foreignKospi: null }, missing: { foreignKospi: f.ok ? "today" : f.why } };
}

/** DD 2027: KR market days ended after a KR daily series' last day, before the judgment day, that make it too old */
export const KR_STALE_DAYS = 2;
/** the KR daily series the age rule reads (KOSPI's bars from Yahoo, the person's foreign flows from Toss) */
const KR_DAILY = ["kospi", "foreignKospi"] as const;

/**
 * DD 2027 (team-lead 2025, 0312): is a KR daily series whose last day is `last` too old at the judgment day? The 08:00
 * reading expects the market day before; one more is Yahoo's delay; KR_STALE_DAYS ended after it is a source that
 * stopped. The judgment day itself is never counted (so a weekend or holiday D reads the same), and the days are the
 * person's cached Toss calendar first, then the table.
 */
export function krStale(last: string, now: number, ov?: DayOverride): boolean {
  return marketDaysAfter("KR", last, civilDate(dayNumber(kstDayOf(now)) - 1), ov) >= KR_STALE_DAYS;
}

/** one person's judgment: the shared read plus their ledger figures and their own flows (each person's own) */
export function judgeFor(core: Core, userId: string, read: StageRead, now: number, flow: FlowRead = NO_FLOW): Judged {
  const feed = ledgerFeed(core, userId, now);
  const fl = flowFeed(flow);
  const input: StageInput = { ...read.input, ...fl.input, ...feed.input };
  const basis: Record<string, InputBasis | null> = { ...read.basis, ...fl.basis, ...feed.basis };
  const missing: Partial<Record<InputKey, Missing>> = { ...missingOf(read), ...fl.missing, ...feed.missing };
  const old: Partial<Record<InputKey, string>> = { ...feed.old };
  // DD 2027: a KR daily series too old is left out as one that did not come today, its day kept for the words
  const ov = core.invest.dayOverride(userId);
  for (const k of KR_DAILY) {
    const last = input[k]?.at(-1)?.t;
    if (!last || !krStale(last, now, ov)) continue;
    delete input[k];
    basis[k] = null;
    missing[k] = "today";
    old[k] = last;
  }
  return { ...assessStages(input), basis, missing, ...(Object.keys(old).length ? { old } : {}) };
}

const kstHour = (now: number) => Math.floor(((((now + 9 * HOUR) % DAY_MS) + DAY_MS) % DAY_MS) / HOUR);
const kstDayOf = (now: number) => new Date(now + 9 * HOUR).toISOString().slice(0, 10);

export function latestJudgment(core: Core, userId: string): JudgmentRow | null {
  return core.db.sql.query("SELECT * FROM invest_judgments WHERE user_id = $u ORDER BY day DESC LIMIT 1").get({ u: userId }) as JudgmentRow | null;
}
export function judgmentBefore(core: Core, userId: string, day: string): JudgmentRow | null {
  return core.db.sql.query("SELECT * FROM invest_judgments WHERE user_id = $u AND day < $d ORDER BY day DESC LIMIT 1").get({ u: userId, d: day }) as JudgmentRow | null;
}

/** the people the board is for: anyone with invest settings or a watched symbol */
function investUsers(core: Core): string[] {
  return (core.db.sql.query("SELECT user_id FROM invest_settings UNION SELECT user_id FROM invest_watchlist").all() as { user_id: string }[]).map((r) => r.user_id);
}

/**
 * from 08:00 KST: each invest user without today's row gets one (the series are read once for all, the ledger and the
 * flows per person: `flowsOf` asks with that person's own token). Sources off: none. Returns the number of rows written.
 */
export async function judgeDay(core: Core, now: number, flowsOf?: (userId: string) => Promise<FlowRead>): Promise<number> {
  if (!core.cfg.invest.sources || kstHour(now) < JUDGE_HOUR_KST) return 0;
  const day = kstDayOf(now);
  const due = investUsers(core).filter((u) => !core.db.sql.query("SELECT 1 FROM invest_judgments WHERE user_id = $u AND day = $d").get({ u, d: day }));
  if (!due.length) return 0;
  const read = await readStageInput(core);
  let n = 0;
  for (const u of due) {
    // a flows read that throws is the caution form for that person; the judgment is still made
    const flow = flowsOf
      ? await flowsOf(u).catch((): FlowRead => {
          core.log.warn("invest flows failed", { user: u });
          return { ok: false, why: "today" };
        })
      : NO_FLOW;
    const j = JSON.stringify(judgeFor(core, u, read, now, flow));
    n += core.db.sql.query("INSERT OR IGNORE INTO invest_judgments (user_id, day, at, json) VALUES ($u, $d, $at, $j)").run({ u, d: day, at: now, j }).changes;
  }
  return n;
}

const hm = (ms: number) => new Date(ms + 9 * HOUR).toISOString().slice(11, 16);

/** · 탈출 2 → 3단계 / · 회복 판정 보류 → 회복 2단계 */
function moved(kind: "탈출" | "회복", prev: StageHead, now: StageHead): string | null {
  if (prev.text === now.text) return null;
  if (prev.stage != null && now.stage != null && prev.stage !== now.stage && !!prev.floor === !!now.floor) return `${kind}${now.floor ? " 최소" : ""} ${prev.stage} → ${now.stage}단계`;
  return `${prev.text} → ${now.text}`;
}

/** what moved since the reading before, one phrase per kind: the 투자 screen's judged line and the deck's moved line (DD 2236) */
export function stageChanges(prev: { escape: StageHead; recovery: StageHead }, now: { escape: StageHead; recovery: StageHead }): string[] {
  return [moved("탈출", prev.escape, now.escape), moved("회복", prev.recovery, now.recovery)].filter((x): x is string => !!x);
}

export type StagesView =
  | { kind: "off"; off: string }
  | { kind: "none"; none: string }
  | {
      kind: "judged";
      escape: StageHead;
      recovery: StageHead;
      gauges: StageGauge[];
      next: string[];
      judgedAt: number;
      judgedText: string;
      stale?: string;
    };

export const STAGES_OFF = "지금은 지표를 받지 않아서 단계를 판정하지 않아요.";
/**
 * the off tool result's second sentence, the agent's alone (DD 1526-b 가): the condition the code judges again on, no
 * day and no promise. The board and the tool chip keep STAGES_OFF alone (0426: nowhere to get it, so quiet)
 */
export const STAGES_OFF_AGAIN = "지표를 다시 받으면 단계도 다시 판정해요.";

/**
 * An invest alert's `시장` row (DD 0847 0, A16's 탈출·회복 단계): the board's heads without the stage names —
 * 탈출 3단계 · 회복 1단계, 탈출 최소 2단계 · 회복 판정 보류; 확인 불가 while the board is off, has no row yet, or is stale.
 */
/** the board's heads while its reading is the current one (judged, not stale: yesterday's stands until 08:00; DD 0924 0) */
export function currentHeads(core: Core, userId: string, now: number): { escape: StageHead; recovery: StageHead } | null {
  const v = stagesView(core, userId, now);
  return v.kind === "judged" && !v.stale ? { escape: v.escape, recovery: v.recovery } : null;
}

export function stageRowText(core: Core, userId: string, now: number): string {
  const h = currentHeads(core, userId, now);
  if (!h) return "확인 불가";
  const word = (kind: "탈출" | "회복", x: StageHead) => (x.stage == null ? x.text : `${kind} ${x.floor ? "최소 " : ""}${x.stage}단계`);
  return `${word("탈출", h.escape)} · ${word("회복", h.recovery)}`;
}

/** the call's market sentence from the current heads (DD 0924 1); null → the call says it could not check */
export function stageCallOf(h: { escape: StageHead; recovery: StageHead } | null): string | null {
  if (!h || h.escape.stage == null) return null;
  if (h.recovery.stage != null) return `시장 단계는 ${h.escape.text}, ${h.recovery.text}예요.`;
  if (h.recovery.text === RECOVERY_HOLD) return `시장 단계는 ${h.escape.text}이고, 회복은 판정 보류예요.`;
  return `시장 단계는 ${h.escape.text}이고, 회복 단계는 아직 몰라요.`;
}

export const stageCallText = (core: Core, userId: string, now: number): string | null => stageCallOf(currentHeads(core, userId, now));

export const headsOf = (j: Judged) => {
  const miss = (k: InputKey) => j.missing[k] ?? null;
  return { escape: escapeHead(j, miss), recovery: recoveryHead(j, miss) };
};

/** the board (DD 0059 §1-2 with 0426 and 0428) from the person's latest row */
export function stagesView(core: Core, userId: string, now: number): StagesView {
  if (!core.cfg.invest.sources) return { kind: "off", off: STAGES_OFF };
  const row = latestJudgment(core, userId);
  if (!row) return { kind: "none", none: kstHour(now) < JUDGE_HOUR_KST ? "첫 판정은 오늘 오전 8시에 나와요." : "첫 판정은 곧 나와요." };
  const j = JSON.parse(row.json) as Judged;
  const { escape, recovery } = headsOf(j);
  const prevRow = judgmentBefore(core, userId, row.day);
  const today = kstDayOf(now);
  // DD 0710 2: 어제 only when the judged day is today and the row before it is the day before; another year names it
  let judgedText = `${dayWords(row.day, now)} ${hm(row.at)} 판정`;
  if (prevRow) {
    const p = headsOf(JSON.parse(prevRow.json) as Judged);
    const changes = stageChanges(p, { escape, recovery });
    const yesterday = row.day === today && prevRow.day === kstDayOf(Date.parse(`${row.day}T12:00:00Z`) - DAY_MS - 9 * HOUR);
    const same = yesterday ? "어제와 같아요" : `${dayWords(prevRow.day, now)} 판정과 같아요`;
    judgedText += changes.length ? ` · ${changes.join(" · ")}` : ` · ${same}`;
  }
  const nx = nextLines(j);
  return {
    kind: "judged",
    escape,
    recovery,
    gauges: gaugesOf(j),
    next: [nx.escape, nx.recovery].filter((s): s is string => !!s),
    judgedAt: row.at,
    judgedText,
    ...(row.day < today && kstHour(now) >= JUDGE_HOUR_KST ? { stale: `오늘 08:00 판정을 하지 못했어요. ${dayWords(row.day, now)} 판정이에요.` } : {}),
  };
}

// ───────────────────────────── `11지표와 단계 조건` (DD 0059 §1-4, 0426 §4) ─────────────────────────────

/** each condition in a short sentence (the master prompt's rule, without its marks) */
export const CONDITION_TEXT: Readonly<Record<string, string>> = {
  A1: "하이일드 스프레드 3.5%p 이상, 또는 6개월 최저보다 1.0%p 이상 넓어짐",
  A2: "VIX 종가 25 이상 2거래일 연속",
  A3: "S&P500 종가가 200일선 아래 3거래일 연속",
  A4: "근원 CPI 전월 대비 0.3% 이상",
  A5: "미 10년물 금리 5% 초과 10거래일 연속",
  A6: "빅테크 2곳 이상 내년 설비투자 증가율 20% 미만",
  A7: "삼의 법칙 0.3 이상, 또는 실업수당 4주 평균 25만 건 이상",
  A8: "코스피가 200일선 아래이고 원/달러 1개월 5% 이상 상승",
  D1: "하이일드 스프레드 4.0%p 이상, 또는 6개월 최저보다 1.5%p 이상 넓어짐",
  D2: "VIX 종가 30 이상 3거래일 연속",
  D3: "S&P500 50일선이 200일선 아래, 또는 종가가 200일선보다 5% 이상 낮음",
  D4: "삼의 법칙 0.5 이상",
  D5: "NFCI 0 이상",
  R1: "VIX 종가 25 미만 5거래일 연속",
  R2: "하이일드 스프레드가 20거래일 최고보다 0.5%p 이상 좁아짐, 또는 6개월 최저보다 넓어진 폭이 0.5%p 미만",
  R3: "S&P500 종가가 200일선 위 3거래일 연속",
  R4: "S&P500 종목 가운데 200일선 위가 60% 이상",
  R5: "2년물 금리가 기준금리 상단 이하, 또는 근원 CPI 전월 대비 0.2% 이하",
  R6: "외국인 코스피 5거래일 연속 순매수, 또는 코스피가 200일선 위",
};

/** the operational definitions the master prompt leaves open, said once at the screen's end (DD 0426 §4) */
export const METHOD_LINES: readonly string[] = [
  "연속 거래일과 20거래일 최고는 값이 있는 날만 세요.",
  "6개월 최저는 기준일에서 달력으로 6개월이에요.",
  "200일선과 50일선은 값이 있는 마지막 200일, 50일의 종가 평균이에요.",
  "엔화 절상률과 원/달러 1개월 변화의 1개월 전은 달력으로 한 달 전 그날이나 그 앞의 마지막 값이에요.",
  "근원 CPI 전월 대비는 소수 한 자리로 반올림해서 판정해요.",
  "삼성전자·SK하이닉스 이익 전망은 앞으로 12개월의 가운데가 든 회계연도 값을, 같은 회계연도의 3개월 전(앞뒤 15일 안) 값과 비교해요.",
  "빅테크 내년 설비투자 증가율은 회사가 쓰는 회계연도 이름으로 내년 값과 올해 값을 비교해요.",
  "M7 이익 전망은 회사마다 최근 3개월 변화가 0 미만이면 하향으로 봐요.",
  `코스피 일봉과 외국인 수급은 마지막 값 뒤에 끝난 한국 거래일이 ${KR_STALE_DAYS}일 이상이면 확인 불가예요.`, // DD 0317 3: the rule's own number
  `원장 값은 등급 C를 쓰지 않아요. 이익 전망, M7, 설비투자 값은 기준일이 ${QUARTERLY_STALE_DAYS}일, 시장 폭은 ${BREADTH_STALE_US_DAYS}거래일을 넘으면 확인 불가예요.`, // DD 0710 D13: the rule's own numbers
];

const STATE_WORD = { met: "충족", unmet: "미충족", unknown: "확인 불가" } as const;
const GROUPS = [
  { key: "worse", title: "악화 신호 A1–A8", pick: (j: Judged) => j.a },
  { key: "severe", title: "심각 신호 D1–D5", pick: (j: Judged) => j.d },
  { key: "recover", title: "회복 신호 R1–R6", pick: (j: Judged) => j.r },
] as const;

type Fig = Record<string, number | string | boolean | null>;
const n2 = (x: unknown) => (typeof x === "number" ? num(x, 2) : null);
const r2 = (x: unknown) => (typeof x === "number" ? rate(x, 2) : null);
const p2 = (x: unknown) => (typeof x === "number" ? pp(x, 2) : null);
/** a spread's level (the high-yield spread): an unsigned %p, as the report's §2 and the A1 rule (DD 1520) */
const hyp = (x: unknown) => (typeof x === "number" ? `${num(x, 2)}%p` : null);
const join = (...xs: (string | null)[]) => xs.filter((x): x is string => !!x).join(" · ");

/** the figure line under a condition: 22.40 / 3.60%p · 6개월 최저보다 +0.60%p / 6,120.00 · 200일선 5,850.00 */
function figureText(id: string, f: Fig): string {
  const vsMa = () => join(n2(f.close) ?? n2(f.kospi), f.ma200 != null ? `200일선 ${n2(f.ma200)}` : null);
  switch (id) {
    case "A1":
    case "D1":
      return join(hyp(f.hy), f.fromLow != null ? `6개월 최저보다 ${p2(f.fromLow)}` : null);
    case "R2":
      return join(hyp(f.hy), f.offHigh20 != null ? `20거래일 최고보다 ${num(f.offHigh20 as number, 2)}%p 좁음` : null, f.fromLow != null ? `6개월 최저보다 ${p2(f.fromLow)}` : null);
    case "A2":
    case "D2":
    case "R1":
      return join(n2(f.vix));
    case "A3":
    case "R3":
      return vsMa();
    case "D3":
      return join(f.ma50 != null ? `50일선 ${n2(f.ma50)}` : null, f.ma200 != null ? `200일선 ${n2(f.ma200)}` : null, f.dev200 != null ? `200일선보다 ${pct(f.dev200 as number, 2)}` : null);
    case "A4":
      return join(typeof f.mom === "number" ? `전월 대비 ${rate(f.mom, 1)}` : null);
    case "A5":
      return join(r2(f.dgs10));
    case "A6":
      return join(typeof f.below20 === "number" ? `20% 미만 ${f.below20}곳` : null);
    case "A7":
      return join(f.sahm != null ? `삼의 법칙 ${n2(f.sahm)}` : null, typeof f.claims4w === "number" ? `실업수당 4주 평균 ${num(f.claims4w)}건` : null);
    case "A8":
      return join(vsMa(), typeof f.usdkrw1m === "number" ? `원/달러 1개월 ${pct(f.usdkrw1m, 1)}` : null);
    case "D4":
      return join(f.sahm != null ? `삼의 법칙 ${n2(f.sahm)}` : null);
    case "D5":
      return join(f.nfci != null ? `NFCI ${n2(f.nfci)}` : null);
    case "R4":
      return join(typeof f.breadth === "number" ? rate(f.breadth, 1) : null);
    case "R5":
      return join(f.dgs2 != null && f.fedUpper != null ? `2년물 ${r2(f.dgs2)} · 상단 ${r2(f.fedUpper)}` : null, typeof f.mom === "number" ? `전월 대비 ${rate(f.mom, 1)}` : null);
    case "R6":
      // DD 2012 1: the rule's order, foreigners first; KOSPI named, with or without the foreign side
      return join(foreignRun(f), f.kospi != null ? `코스피 ${n2(f.kospi)}` : null, f.ma200 != null ? `200일선 ${n2(f.ma200)}` : null);
    default:
      return "";
  }
}

/** 외국인 6거래일 연속 순매수 / 외국인 2거래일 연속 순매도; a last day of exactly 0, or no flows: none */
function foreignRun(f: Fig): string | null {
  if (typeof f.foreignBuyRun === "number" && f.foreignBuyRun > 0) return `외국인 ${f.foreignBuyRun}거래일 연속 순매수`;
  if (typeof f.foreignSellRun === "number" && f.foreignSellRun > 0) return `외국인 ${f.foreignSellRun}거래일 연속 순매도`;
  return null;
}

const fromLedger = (k: InputKey) => (LEDGER_KEYS as readonly string[]).includes(k);

/** why an input is not here, in the basis words (DD 0426 §1, DD 1857-b 2) */
const MISSING_WORDS = { today: "오늘 받지 못했어요", connect: "토스증권을 연결하면 받아요", none: "받을 곳이 아직 없어요" } as const;

/** the side's name in a two-input row's tail, with its particle (DD 0317 2) */
const TAIL_NAMES: Partial<Record<InputKey, string>> = { kospi: "코스피는", usdkrw: "원/달러는", foreignKospi: "외국인 수급은" };
/** the rows that say why their missing side is missing (R6: DD 2012 2, 2027 3; A8: DD 0317 2) */
const TAILED: Readonly<Record<string, readonly [InputKey, InputKey]>> = { R6: ["foreignKospi", "kospi"], A8: ["kospi", "usdkrw"] };

/**
 * R6 and A8 with one side here and the other not: the missing side's reason after the sources, on a met day too — too
 * old first (`코스피는 11월 24일 값이라 오래됐어요`, DD 0317 1), else its own why (KOSPI and 원/달러 can only be 오늘 받지 못했어요:
 * no stage reading at all without sources; the foreign side may be 연결하면 or 받을 곳). Both missing or both here: none.
 */
function pairTail(j: Judged, id: string, now: number): string | null {
  const pair = TAILED[id];
  if (!pair) return null;
  const [a, b] = pair;
  if (!!j.basis[a] === !!j.basis[b]) return null;
  const k = j.basis[a] ? b : a;
  const old = j.old?.[k];
  if (old) return `${TAIL_NAMES[k]} ${dayWords(old, now)} 값이라 오래됐어요`;
  const m = j.missing[k];
  return `${TAIL_NAMES[k]} ${MISSING_WORDS[m === "today" || m === "connect" ? m : "none"]}`;
}

/**
 * 11월 26일 · FRED · A / 11월 26일 · FRED · A, Yahoo(지연 시세) · B+ / 받을 곳이 아직 없어요 / 오늘 받지 못했어요 /
 * 토스증권을 연결하면 받아요 (B2e); a ledger input: 값이 없어요 / 8월 1일 값이라 오래됐어요 (DD 0426 §1)
 */
function basisText(j: Judged, keys: readonly InputKey[], asOf: string | null, now: number): string {
  const present = keys.filter((k) => j.basis[k]).map((k) => j.basis[k]!);
  if (!present.length || !asOf) {
    const old = keys.map((k) => j.old?.[k]).filter((d): d is string => !!d).sort().at(-1);
    if (old) return `${dayWords(old, now)} 값이라 오래됐어요`;
    if (keys.some((k) => j.missing[k] === "today")) return MISSING_WORDS.today;
    if (keys.some((k) => j.missing[k] === "connect")) return MISSING_WORDS.connect; // DD 1857-b 2
    return keys.some(fromLedger) ? "값이 없어요" : MISSING_WORDS.none;
  }
  return `${dayWords(asOf, now)} · ${[...new Set(present.map((b) => `${b.source} · ${b.grade}`))].join(", ")}`;
}

const COMPANY: Readonly<Record<string, string>> = { samsung: "삼성전자", hynix: "SK하이닉스" };

/**
 * indicator 9's value, foreigners' 20-day net KOSPI buying in 억원 (DD 1857-b 3): 1조 (1만 억) and up in 조 with one
 * decimal, else 억 with commas; signed, U+2212: 20일 −1.2조원 / 20일 +3,400억원 / 20일 0억원
 */
export function flowSumText(eok: number): string {
  return Math.abs(eok) >= 9_999.5 ? `20일 ${num(eok / 10_000, 1, { sign: true })}조원` : `20일 ${num(eok, 0, { sign: true })}억원`;
}

/** rows whose value is shown while their signal is unknown: 6 and 11 per company, 9 its 20-day sum (DD 1857-b 3) */
const VALUE_WHEN_UNKNOWN: readonly number[] = [6, 9, 11];

/** the row's value in its unit; null → the app's 확인 불가 */
function core11Value(no: number, v: number | null, extras: Fig): string | null {
  if (v == null && !VALUE_WHEN_UNKNOWN.includes(no)) return null;
  switch (no) {
    case 1:
    case 7:
      return rate(v!, no === 7 ? 1 : 2);
    case 2:
      return pp(v!, 2);
    case 3:
      return hyp(extras.now);
    case 4:
      return pct(v!, 1);
    case 5:
    case 10:
      return rate(v!, 1);
    case 6:
    case 11: {
      const ids = no === 6 ? ["samsung", "hynix"] : ["MSFT", "GOOGL", "META", "AMZN"];
      const parts = ids.filter((id) => typeof extras[id] === "number").map((id) => `${COMPANY[id] ?? id} ${pct(extras[id] as number, 1)}`);
      return parts.length ? parts.join(" · ") : null;
    }
    case 8:
      return `하향 ${v}곳`;
    case 9:
      return typeof extras.sum20 === "number" ? flowSumText(extras.sum20) : null;
    default:
      return null;
  }
}

export interface StagesDetail {
  stages: StagesView;
  core11: { no: number; name: string; signal: "normal" | "caution" | "risk" | "unknown"; value: string | null; basis: string; reason: string }[];
  groups: { key: "worse" | "severe" | "recover"; title: string; rows: { id: string; text: string; state: "met" | "unmet" | "unknown"; stateText: string; detail: string }[]; next: string }[];
  method: string[];
  disclaimer: true;
}

/** GET /api/invest/stages */
export function stagesDetail(core: Core, userId: string, now: number): StagesDetail {
  const stages = stagesView(core, userId, now);
  const row = stages.kind === "judged" ? latestJudgment(core, userId) : null;
  if (!row) return { stages, core11: [], groups: [], method: [...METHOD_LINES], disclaimer: true };
  const j = JSON.parse(row.json) as Judged;
  const nx = nextLines(j);
  const met = (cs: readonly { status: string }[]) => cs.filter((c) => c.status === "met").length;
  /** the section's foot: what its signals decide, and where they stand */
  const groupNext = (key: string): string => {
    if (key === "worse") return `2단계 조건에 악화 신호가 2개 이상이면 탈출 3단계예요. 지금 ${met(j.a)}개예요.`;
    if (key === "severe") return `심각 신호가 2개 이상이면 탈출 4단계예요. 지금 ${met(j.d)}개예요.`;
    return nx.recovery ?? `회복 신호는 지금 ${met(j.r)}개예요.`;
  };
  return {
    stages,
    core11: j.core.items.map((it) => ({
      no: it.no,
      name: it.name,
      signal: it.signal,
      value: it.signal === "unknown" && !VALUE_WHEN_UNKNOWN.includes(it.no) ? null : core11Value(it.no, it.value, it.extras),
      basis: basisText(j, NEEDS[`#${it.no}`] ?? [], it.asOf, now), // DD 0731 E5: the year by the reading time, as judgedText
      // DD 0058: no figure at all says nothing the basis does not say better (값이 없어요, 받을 곳이 아직 없어요, …)
      reason: it.reason === NO_DATA ? "" : it.no === 6 ? it.reason.replace(/samsung|hynix/g, (id) => COMPANY[id]!) : it.reason,
    })),
    groups: GROUPS.map((g) => ({
      key: g.key,
      title: g.title,
      rows: g.pick(j).map((c) => ({
        id: c.id,
        text: CONDITION_TEXT[c.id] ?? c.id,
        state: c.status,
        stateText: STATE_WORD[c.status],
        // no input of it here: the basis alone (a figure of nothing would read as a value)
        detail: join(
          (NEEDS[c.id] ?? []).some((k) => j.basis[k]) ? figureText(c.id, c.figures) || null : null,
          basisText(j, NEEDS[c.id] ?? [], c.asOf, now),
          pairTail(j, c.id, now),
        ),
      })),
      next: groupNext(g.key),
    })),
    method: [...METHOD_LINES],
    disclaimer: true,
  };
}
