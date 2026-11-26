/**
 * B2b-2 (team-lead 0437 1a, 0511): the core indicators no source gives — 6 (Samsung Electronics' and SK hynix's
 * earnings estimates), 7 (S&P 500 breadth), 8 (the M7's estimate revisions) and 11 (big-tech capex) — from the person's
 * own indicator ledger. People and the model write the figures with source, grade and as-of; code picks the rows, works
 * out the change and leaves every row as it was. Grade C is never used; a figure of 6, 8 or 11 older than 120 days, or
 * breadth older than 5 US trading days, is unknown (the caution form: its place is there, today's value is not).
 */
import { CAPEX_COMPANIES, civilDate, dayNumber, M7, type Point, type StageInput } from "@pickle/quant";
import type { Core } from "../core.ts";
import { kstDay, marketDate, marketDaysAfter } from "./calendar.ts";
import { monthsBack } from "./forecasts.ts";

export const EPS_COMPANIES = ["samsung", "hynix"] as const;

/** the ledger ids the stages read; `fy` is the company's own fiscal-year name */
export const STAGE_IDS = {
  eps: (co: (typeof EPS_COMPANIES)[number], fy: number) => `stage.eps.${co}.${fy}`,
  breadth: "stage.breadth200",
  /** the recent 3-month change of the company's 12M forward earnings estimate, % (team-lead 0511: below 0 is down) */
  m7: (sym: (typeof M7)[number]) => `stage.m7.${sym}`,
  capex: (co: (typeof CAPEX_COMPANIES)[number], fy: number) => `stage.capex.${co}.${fy}`,
} as const;

export const QUARTERLY_STALE_DAYS = 120;
export const BREADTH_STALE_US_DAYS = 5;
/** the 3-month-earlier figure: the one nearest the same day 3 months back, within this many days of it */
export const EPS_BASE_WINDOW_DAYS = 15;

export type LedgerKey = "eps3m" | "breadth200" | "m7" | "capex";
export const LEDGER_KEYS: readonly LedgerKey[] = ["eps3m", "breadth200", "m7", "capex"];

/** where a ledger-fed input came from: the oldest as-of it rests on, its sources, the weakest grade */
export interface LedgerBasis {
  asOf: string;
  source: string;
  grade: string;
}

export interface LedgerFeed {
  input: Pick<StageInput, LedgerKey>;
  basis: Record<LedgerKey, LedgerBasis | null>;
  /** "none": no usable figure; "today": the figure is there but too old */
  missing: Record<LedgerKey, "none" | "today" | null>;
  /** per key, the as-of of a figure left out for its age (the newest such) */
  old: Partial<Record<LedgerKey, string>>;
}

interface Row {
  id: string;
  day: string;
  value: number;
  unit: string;
  source: string;
  grade: string;
}

const GRADE_ORDER = ["A", "B+", "B"];
const weakest = (gs: string[]) => gs.reduce((w, g) => (GRADE_ORDER.indexOf(g) > GRADE_ORDER.indexOf(w) ? g : w));
const daysBetween = (a: string, b: string) => dayNumber(b) - dayNumber(a);

/** (a − b) ÷ |b| × 100, the float residue cut at 4 decimals; null when b is 0 */
export function pctChange(a: number, b: number): number | null {
  if (b === 0) return null;
  return Math.round((((a - b) * 100) / Math.abs(b)) * 1e4) / 1e4;
}

/** the person's (and the shared) usable stage rows by id, oldest first, one per day (the person's over a shared one) */
function stageRows(core: Core, userId: string): Map<string, Row[]> {
  const raw = core.db.sql
    .query(
      `SELECT user_id, id, as_of, value, unit, source, source_tier, confidence FROM invest_ledger
       WHERE user_id IN ($u, '') AND substr(id, 1, 6) = 'stage.' AND value IS NOT NULL AND unit != 'text' AND confidence != 'C'
       ORDER BY id, as_of, user_id = $u, created_at`,
    )
    .all({ u: userId }) as { user_id: string; id: string; as_of: string; value: number; unit: string; source: string | null; source_tier: string; confidence: string }[];
  const out = new Map<string, Row[]>();
  for (const r of raw) {
    const rows = out.get(r.id) ?? [];
    const row: Row = { id: r.id, day: r.as_of.slice(0, 10), value: r.value, unit: r.unit, source: r.source ?? r.source_tier, grade: r.confidence };
    if (rows.at(-1)?.day === row.day) rows[rows.length - 1] = row; // later in the order wins: the person's, then the newer
    else rows.push(row);
    out.set(r.id, rows);
  }
  return out;
}

type One = { point: Point; used: Row[] } | { miss: "none" } | { miss: "today"; old: string };

const basisOf = (used: Row[]): LedgerBasis => ({
  asOf: used.map((r) => r.day).sort()[0]!,
  source: [...new Set(used.map((r) => r.source))].join(", "),
  grade: weakest(used.map((r) => r.grade)),
});

/** the companies' results folded into one input's basis and missing word */
function fold(results: One[]): { basis: LedgerBasis | null; missing: "none" | "today" | null; old?: string } {
  const used = results.flatMap((r) => ("used" in r ? r.used : []));
  const olds = results.flatMap((r) => ("old" in r ? [r.old] : [])).sort();
  const missing = olds.length ? "today" : results.some((r) => "miss" in r) ? "none" : null;
  return { basis: used.length ? basisOf(used) : null, missing, ...(olds.length ? { old: olds.at(-1)! } : {}) };
}

/** 6: the fiscal year holding the middle of the next 12 months; its newest figure against the one 3 months before it */
function eps(rows: Map<string, Row[]>, today: string, co: (typeof EPS_COMPANIES)[number]): One {
  const fy = Number(monthsBack(today, -6).slice(0, 4));
  const list = rows.get(STAGE_IDS.eps(co, fy)) ?? [];
  const last = list.at(-1);
  if (!last) return { miss: "none" };
  if (daysBetween(last.day, today) > QUARTERLY_STALE_DAYS) return { miss: "today", old: last.day };
  const target = dayNumber(monthsBack(last.day, 3));
  let base: Row | null = null;
  for (const r of list) {
    const off = Math.abs(dayNumber(r.day) - target);
    if (r === last || r.unit !== last.unit || off > EPS_BASE_WINDOW_DAYS) continue;
    if (!base || off < Math.abs(dayNumber(base.day) - target)) base = r; // oldest first: a tie keeps the earlier
  }
  const v = base ? pctChange(last.value, base.value) : null;
  if (!base || v == null) return { miss: "none" };
  return { point: { t: last.day, v }, used: [last, base] };
}

/** 11: next year's figure against this year's (KST years, the company's fiscal-year names) */
function capex(rows: Map<string, Row[]>, today: string, co: (typeof CAPEX_COMPANIES)[number]): One {
  const y = Number(today.slice(0, 4));
  const next = (rows.get(STAGE_IDS.capex(co, y + 1)) ?? []).at(-1);
  const cur = (rows.get(STAGE_IDS.capex(co, y)) ?? []).at(-1);
  const old = [next, cur].filter((r): r is Row => !!r && daysBetween(r.day, today) > QUARTERLY_STALE_DAYS).map((r) => r.day).sort().at(-1);
  if (old) return { miss: "today", old };
  if (!next || !cur || next.unit !== cur.unit || cur.value <= 0) return { miss: "none" };
  const v = pctChange(next.value, cur.value);
  if (v == null) return { miss: "none" };
  return { point: { t: [next.day, cur.day].sort()[0]!, v }, used: [next, cur] };
}

/** 8: one company's newest change in pct, below 0 turned down */
function m7One(rows: Map<string, Row[]>, today: string, sym: (typeof M7)[number]): One {
  const last = rows.get(STAGE_IDS.m7(sym))?.filter((r) => r.unit === "pct").at(-1);
  if (!last) return { miss: "none" };
  if (daysBetween(last.day, today) > QUARTERLY_STALE_DAYS) return { miss: "today", old: last.day };
  return { point: { t: last.day, v: last.value }, used: [last] };
}

/** the four ledger-fed inputs for one person at `now` */
export function ledgerFeed(core: Core, userId: string, now: number): LedgerFeed {
  const rows = stageRows(core, userId);
  const today = kstDay(now);
  const input: LedgerFeed["input"] = {};
  const basis = {} as LedgerFeed["basis"];
  const missing = {} as LedgerFeed["missing"];
  const old: LedgerFeed["old"] = {};
  const put = (k: LedgerKey, f: ReturnType<typeof fold>) => {
    basis[k] = f.basis;
    missing[k] = f.missing;
    if (f.old) old[k] = f.old;
  };

  const e = EPS_COMPANIES.map((co) => eps(rows, today, co));
  if (e.some((r) => "point" in r)) input.eps3m = Object.fromEntries(EPS_COMPANIES.map((co, i) => [co, "point" in e[i]! ? (e[i] as { point: Point }).point : null]));
  put("eps3m", fold(e));

  const b = rows.get(STAGE_IDS.breadth)?.filter((r) => r.unit === "pct") ?? [];
  const last = b.at(-1);
  if (!last) put("breadth200", { basis: null, missing: "none" });
  else if (marketDaysAfter("US", last.day, marketDate("US", now)) > BREADTH_STALE_US_DAYS) put("breadth200", { basis: null, missing: "today", old: last.day });
  else {
    input.breadth200 = b.map((r) => ({ t: r.day, v: r.value }));
    put("breadth200", { basis: basisOf([last]), missing: null });
  }

  const m = M7.map((sym) => m7One(rows, today, sym));
  const seen = m.flatMap((r) => ("point" in r ? [r.point] : []));
  if (seen.length)
    input.m7 = {
      t: seen.map((p) => p.t).sort()[0]!,
      down: Object.fromEntries(M7.map((sym, i) => [sym, "point" in m[i]! ? ((m[i] as { point: Point }).point.v ?? 0) < 0 : null])),
    };
  put("m7", fold(m));

  const c = CAPEX_COMPANIES.map((co) => capex(rows, today, co));
  if (c.some((r) => "point" in r)) input.capex = Object.fromEntries(CAPEX_COMPANIES.map((co, i) => [co, "point" in c[i]! ? (c[i] as { point: Point }).point : null]));
  put("capex", fold(c));

  return { input, basis, missing, old };
}

/** for tests and the tool text: the fiscal years the ledger ids want today */
export function stageYears(now: number): { eps: number; capex: number; capexBase: number } {
  const today = kstDay(now);
  const y = Number(today.slice(0, 4));
  return { eps: Number(monthsBack(today, -6).slice(0, 4)), capex: y + 1, capexBase: y };
}

export { civilDate };
