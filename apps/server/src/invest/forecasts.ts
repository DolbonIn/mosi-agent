/**
 * The forecast ledger (B6; team-lead 0052 B2a; DD 0109 §2). A forecast states a claim, a probability, an optional
 * interval, a due day and how it will be judged; once made, none of that changes and it is never deleted (a missed
 * forecast taken out would flatter the score). The person judges it (A12's principle: the model only proposes, B2b);
 * the score is code's (quant scoring.ts): direction hit rate over 3 and 12 months and the 12-month Brier score, by due
 * day, partial hits left out of both and counted beside them.
 */
import type {
  InvestAuthor,
  InvestErrorCause,
  InvestForecast,
  InvestForecastScore,
  InvestForecastStatus,
  InvestLedgerUnit,
  InvestOutcome,
} from "@pickle/protocol";
import { brier, civilDate, dayNumber, hitRate, intervalError, MINUS, num, pp, rate, TARGETS } from "@pickle/quant";
import type { Db } from "../db/index.ts";
import { bad, HttpError } from "../http.ts";
import { newId } from "../util.ts";
import { kstDay } from "./calendar.ts";
import { invalidOf, isDay, LEDGER_ID_RE, LEDGER_UNITS, lineOf, oneOf, unitText } from "./ledger.ts";

export const MAX_FORECASTS = 500;
/** a due day up to three years ahead */
export const FORECAST_MAX_DAYS = 3 * 366;
export const FORECAST_READ_MAX = 500;
export const OUTCOMES = ["hit", "miss", "partial"] as const satisfies readonly InvestOutcome[];
export const ERROR_CAUSES = ["data", "interpretation", "model", "timing", "narrative"] as const satisfies readonly InvestErrorCause[];

/** DD 0109 §2: the judgement words */
export const OUTCOME_WORD: Readonly<Record<InvestOutcome, string>> = { hit: "적중", miss: "빗나감", partial: "부분 적중" };
export const STATUS_WORD: Readonly<Record<InvestForecastStatus, string>> = { open: "기한 전", waiting: "판정 기다림", ...OUTCOME_WORD };
/** DD 0109 §2: the short word for tables and counts, and the sentence for the list the person picks from */
export const ERROR_CAUSE_WORD: Readonly<Record<InvestErrorCause, { word: string; sentence: string }>> = {
  data: { word: "데이터", sentence: "데이터가 틀렸거나 늦게 나왔어요" },
  interpretation: { word: "해석", sentence: "데이터를 잘못 읽었어요" },
  model: { word: "모델", sentence: "계산 방법이 맞지 않았어요" },
  timing: { word: "시기", sentence: "방향은 맞았는데 시기가 달랐어요" },
  narrative: { word: "이야기", sentence: "그럴듯한 이야기에 기댔어요" },
};
export const SCORE_EMPTY = "아직 판정한 예측이 없어요.";
export const BRIER_FOOT = "0에 가까울수록 잘 맞힌 거예요.";

export interface ForecastRow {
  id: string;
  user_id: string;
  made_on: string;
  claim: string;
  p: number;
  lo: number | null;
  hi: number | null;
  unit: string | null;
  due_on: string;
  criterion: string;
  outcome: string | null;
  actual: number | null;
  error_cause: string | null;
  resolved_at: number | null;
  author: string;
  ledger_ids: string;
  proposal_json: string | null;
  rev: number;
  created_at: number;
  updated_at: number;
}

const invalid = invalidOf("invalid_forecast");
const NUMERIC_UNITS = LEDGER_UNITS.filter((u) => u !== "text");

const pad = (n: number) => String(n).padStart(2, "0");
const md = (day: string) => `${Number(day.slice(5, 7))}월 ${Number(day.slice(8, 10))}일`;

/** the same day `months` calendar months earlier, the day clamped to the month's last (05-31 − 3 → 02-28) */
export function monthsBack(day: string, months: number): string {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const idx = y * 12 + (m - 1) - months;
  const yy = Math.floor(idx / 12);
  const mm = idx - yy * 12 + 1;
  const first = dayNumber(`${yy}-${pad(mm)}-01`);
  const daysIn = dayNumber(mm === 12 ? `${yy + 1}-01-01` : `${yy}-${pad(mm + 1)}-01`) - first;
  return civilDate(first + Math.min(d, daysIn) - 1);
}

// ───────────── make ─────────────

export function createForecast(db: Db, userId: string, body: unknown, author: InvestAuthor, now: number): InvestForecast {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw invalid("예측이 올바르지 않아요.");
  const b = body as Record<string, unknown>;
  const today = kstDay(now);
  const claim = lineOf(b.claim, "예측", 200, invalid)!;
  if (typeof b.p !== "number" || !Number.isFinite(b.p) || !(b.p > 0 && b.p < 1)) throw invalid("확률은 0과 1 사이의 수로 넣어 주세요(두 끝은 빼요).");
  let lo: number | null = null;
  let hi: number | null = null;
  let unit: InvestLedgerUnit | null = null;
  if (b.interval !== undefined && b.interval !== null) {
    const iv = b.interval as Record<string, unknown>;
    if (typeof iv !== "object" || typeof iv.lo !== "number" || typeof iv.hi !== "number" || !Number.isFinite(iv.lo) || !Number.isFinite(iv.hi)) throw invalid("구간의 두 끝을 숫자로 넣어 주세요.");
    if (iv.lo > iv.hi) throw invalid("구간의 아래 끝이 위 끝보다 커요.");
    unit = oneOf(iv.unit, NUMERIC_UNITS, "구간 단위", invalid);
    lo = iv.lo;
    hi = iv.hi;
  }
  if (!isDay(b.dueOn)) throw invalid("기한은 날짜(YYYY-MM-DD)로 넣어 주세요.");
  if (b.dueOn < today) throw invalid("기한이 이미 지났어요.");
  if (dayNumber(b.dueOn) - dayNumber(today) > FORECAST_MAX_DAYS) throw invalid("기한은 3년 안으로 정해 주세요.");
  const criterion = lineOf(b.criterion, "판정 기준", 300, invalid)!;
  let ledgerIds: string[] = [];
  if (b.ledgerIds !== undefined && b.ledgerIds !== null) {
    if (!Array.isArray(b.ledgerIds) || b.ledgerIds.length > 10 || !b.ledgerIds.every((x) => typeof x === "string" && LEDGER_ID_RE.test(x))) throw invalid("근거 원장 id는 10개까지, 원장 id 꼴로 넣어 주세요.");
    ledgerIds = [...new Set(b.ledgerIds as string[])];
  }
  return db.tx(() => {
    const n = (db.sql.query("SELECT COUNT(*) AS n FROM invest_forecasts WHERE user_id = $u").get({ u: userId }) as { n: number }).n;
    if (n >= MAX_FORECASTS) throw bad(`예측은 ${MAX_FORECASTS}개까지 남길 수 있어요.`, "too_many_forecasts");
    const row: ForecastRow = {
      id: newId("if"),
      user_id: userId,
      made_on: today,
      claim,
      p: b.p as number,
      lo,
      hi,
      unit,
      due_on: b.dueOn as string,
      criterion,
      outcome: null,
      actual: null,
      error_cause: null,
      resolved_at: null,
      author,
      ledger_ids: JSON.stringify(ledgerIds),
      proposal_json: null,
      rev: 1,
      created_at: now,
      updated_at: now,
    };
    const cols = Object.keys(row);
    db.sql.query(`INSERT INTO invest_forecasts (${cols.join(", ")}) VALUES (${cols.map((c) => `$${c}`).join(", ")})`).run(row as unknown as Record<string, string | number | null>);
    return forecastView(row, now);
  });
}

// ───────────── judge (the person) ─────────────

export function judgeForecast(db: Db, userId: string, id: string | undefined, body: unknown, now: number): InvestForecast {
  const row = id ? forecastRow(db, userId, id) : null;
  if (!row) throw new HttpError(404, "forecast_not_found", "찾을 수 없는 예측이에요.");
  if (!body || typeof body !== "object" || Array.isArray(body)) throw invalid("판정이 올바르지 않아요.");
  const b = body as Record<string, unknown>;
  if (b.outcome === undefined) throw invalid("판정을 골라 주세요.");
  const outcome = b.outcome === null ? null : oneOf(b.outcome, OUTCOMES, "판정", invalid);
  let cause: InvestErrorCause | null = null;
  if (b.errorCause !== undefined && b.errorCause !== null) {
    cause = oneOf(b.errorCause, ERROR_CAUSES, "오차 원인", invalid);
    if (outcome !== "miss" && outcome !== "partial") throw invalid("오차 원인은 빗나감이나 부분 적중일 때만 골라요.");
  }
  let actual = row.actual;
  if (b.actual !== undefined) {
    if (b.actual !== null && (typeof b.actual !== "number" || !Number.isFinite(b.actual))) throw invalid("실제 값을 숫자로 넣어 주세요.");
    actual = b.actual as number | null;
  }
  if (b.rev !== undefined && b.rev !== row.rev) throw new HttpError(409, "forecast_changed", "그사이 판정이 바뀌었어요. 바뀐 내용을 확인해 주세요.", undefined, { forecast: forecastView(row, now) });
  const next: ForecastRow = { ...row, outcome, error_cause: cause, actual, resolved_at: outcome ? now : null, rev: row.rev + 1, updated_at: now };
  db.sql
    .query("UPDATE invest_forecasts SET outcome = $o, error_cause = $c, actual = $a, resolved_at = $r, rev = rev + 1, updated_at = $n WHERE id = $id AND user_id = $u AND rev = $rev")
    .run({ o: outcome, c: cause, a: actual, r: next.resolved_at, n: now, id: row.id, u: userId, rev: row.rev });
  return forecastView(next, now);
}

// ───────────── read ─────────────

export function forecastRow(db: Db, userId: string, id: string): ForecastRow | null {
  return db.sql.query("SELECT * FROM invest_forecasts WHERE id = $id AND user_id = $u").get({ id, u: userId }) as ForecastRow | null;
}

export function forecastRows(db: Db, userId: string): ForecastRow[] {
  return db.sql.query("SELECT * FROM invest_forecasts WHERE user_id = $u").all({ u: userId }) as ForecastRow[];
}

function statusOf(r: ForecastRow, today: string): InvestForecastStatus {
  return (r.outcome as InvestOutcome | null) ?? (today > r.due_on ? "waiting" : "open");
}

/** waiting first, then open (both by due day), then judged (latest judged first) */
export function listForecasts(db: Db, userId: string, now: number, limit = 100): InvestForecast[] {
  const today = kstDay(now);
  const rank = { waiting: 0, open: 1 } as Record<string, number>;
  const rows = forecastRows(db, userId).sort((a, b) => {
    const ra = rank[statusOf(a, today)] ?? 2;
    const rb = rank[statusOf(b, today)] ?? 2;
    if (ra !== rb) return ra - rb;
    if (ra < 2) return a.due_on.localeCompare(b.due_on) || a.created_at - b.created_at;
    return (b.resolved_at ?? 0) - (a.resolved_at ?? 0);
  });
  return rows.slice(0, Math.min(Math.max(1, Math.floor(limit)), FORECAST_READ_MAX)).map((r) => forecastView(r, now));
}

export function forecastView(r: ForecastRow, now: number): InvestForecast {
  const today = kstDay(now);
  const status = statusOf(r, today);
  const unit = r.unit as InvestLedgerUnit | null;
  const interval = r.lo != null && r.hi != null && unit ? { lo: r.lo, hi: r.hi, unit, text: `${unitText(unit, r.lo)} ~ ${unitText(unit, r.hi)}` } : null;
  let err: InvestForecast["intervalError"] = null;
  if (interval && r.actual != null) {
    const e = intervalError(r.actual, interval.lo, interval.hi);
    const text = e === 0 ? "구간 안" : unit === "pct" || unit === "pctp" ? pp(e, 2) : `${e > 0 ? "+" : MINUS}${unitText(unit!, Math.abs(e))}`;
    err = { v: e, text };
  }
  const cause = r.error_cause as InvestErrorCause | null;
  return {
    id: r.id,
    madeOn: r.made_on,
    claim: r.claim,
    probability: { v: r.p, text: rate(r.p * 100, 0) },
    interval,
    dueOn: r.due_on,
    dueText: `${md(r.due_on)}까지`,
    criterion: r.criterion,
    status,
    statusText: STATUS_WORD[status],
    actual: r.actual != null ? { v: r.actual, text: unit ? unitText(unit, r.actual) : num(r.actual, 2) } : null,
    intervalError: err,
    errorCause: cause,
    errorCauseText: cause ? ERROR_CAUSE_WORD[cause].word : null,
    proposal: null,
    ledgerIds: JSON.parse(r.ledger_ids) as string[],
    author: r.author as InvestAuthor,
    resolvedAt: r.resolved_at,
    rev: r.rev,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// ───────────── score (code) ─────────────

export function forecastScore(rows: readonly ForecastRow[], now: number): InvestForecastScore {
  const today = kstDay(now);
  const judged = rows.filter((r) => r.outcome);
  const in12 = judged.filter((r) => r.due_on >= monthsBack(today, 12));
  const in3 = judged.filter((r) => r.due_on >= monthsBack(today, 3));
  const h3 = hitRate(in3.map((r) => r.outcome as InvestOutcome));
  const h12 = hitRate(in12.map((r) => r.outcome as InvestOutcome));
  const b = brier(in12.filter((r) => r.outcome !== "partial").map((r) => ({ p: r.p, outcome: r.outcome === "hit" ? (1 as const) : (0 as const) })));
  const target = rate(TARGETS.hitRate12m * 100, 0);
  const rows_: InvestForecastScore["rows"] = [];
  if (h3.rate != null) rows_.push({ key: "hit3m", text: `방향 적중률 3개월 ${rate(h3.rate * 100, 0)} · 목표 ${target}` });
  if (h12.rate != null) rows_.push({ key: "hit12m", text: `방향 적중률 12개월 ${rate(h12.rate * 100, 0)} · 목표 ${target}` });
  if (b != null) rows_.push({ key: "brier", text: `Brier 점수 ${num(b, 2)} · 목표 ${num(TARGETS.brier, 2)} 이하`, foot: BRIER_FOOT });
  return {
    rows: rows_,
    ...(h12.partial ? { partialFoot: `부분 적중 ${h12.partial}건은 두 점수에 넣지 않았어요.` } : {}),
    ...(judged.length ? {} : { empty: SCORE_EMPTY }),
    hitRate3m: h3.rate,
    hitRate12m: h12.rate,
    brier: b,
    judged: h12.hits + h12.misses,
    partial: h12.partial,
  };
}
