/**
 * The indicator ledger (B2's nine fields; team-lead 0052 B2a): one write path for the server's code, the model (B2b
 * tools) and the person (POST /api/invest/ledger), with the same checks for all, and reads that see the person's own
 * rows and the shared ones (user ''), never anyone else's.
 *
 * - L2 "정의 불명 수치는 판정 제외": a row without a definition is refused, so every stored figure has one.
 * - B1 T4: a field source stays grade C until a T1 or T2 source confirms it, so a T4 row graded above C is refused.
 * - numbers by code (PLAN §2): the code's own series (quote.*, atr14.*) and any row code wrote are code's alone.
 * - shared rows are code's alone; the model and the person always write under their own id.
 *
 * The field checks here are shared with the forecast ledger and the event calendar.
 */
import type { InvestAuthor, InvestGrade, InvestLeadClass, InvestLedgerEntry, InvestLedgerUnit, InvestTier } from "@pickle/protocol";
import { civilDate, dayNumber, krw, MINUS, num, pp, rate, shares, usd } from "@pickle/quant";
import type { Db } from "../db/index.ts";
import { bad, HttpError } from "../http.ts";
import { josa } from "../util.ts";
import { kstDay } from "./calendar.ts";

export const LEDGER_UNITS = ["usd", "krw", "index", "pct", "pctp", "qty", "bp", "count", "T", "GW", "$B", "text"] as const satisfies readonly InvestLedgerUnit[];
export const TIERS = ["T1", "T2", "T3", "T4"] as const satisfies readonly InvestTier[];
export const GRADES = ["A", "B+", "B", "C"] as const satisfies readonly InvestGrade[];
export const LEAD_CLASSES = ["L1", "L2", "G", "T"] as const satisfies readonly InvestLeadClass[];
/** the series code computes; nobody else writes under these ids */
export const CODE_SERIES = ["quote.", "atr14."] as const;
/** a person's own rows written by the model or by them */
export const MAX_LEDGER_ROWS = 5000;
export const LEDGER_READ_MAX = 200;
/** a ledger or forecast id: letters (any script), digits, ".", "_" or "-", 64 at most, a letter or digit first */
export const LEDGER_ID_RE = /^[\p{L}\p{N}][\p{L}\p{N}._-]{0,63}$/u;

export interface LedgerRow {
  user_id: string;
  id: string;
  as_of: string;
  published_at: string | null;
  value: number | null;
  value_text: string | null;
  unit: string;
  definition: string;
  source_tier: string;
  source: string | null;
  url: string | null;
  revision: string | null;
  confidence: string;
  lead_class: string | null;
  author: string;
  created_at: number;
}

// ───────────── field checks (400 with the field's own sentence) ─────────────

const eul = (w: string) => josa(w, "을", "를");
const eun = (w: string) => josa(w, "은", "는");

export function invalidOf(code: string) {
  return (message: string) => bad(message, code);
}

/** one line of text: runs of white space become one space; control characters are refused */
export function lineOf(v: unknown, label: string, max: number, fail: (m: string) => HttpError, optional = false): string | null {
  if (v === undefined || v === null || (typeof v === "string" && !v.trim())) {
    if (optional) return null;
    throw fail(`${eul(label)} 넣어 주세요.`);
  }
  if (typeof v !== "string") throw fail(`${eun(label)} 글로 넣어 주세요.`);
  const t = v.replace(/\s+/g, " ").trim();
  if (/\p{Cc}/u.test(t)) throw fail(`${label}에 쓸 수 없는 글자가 있어요.`);
  if ([...t].length > max) throw fail(`${eun(label)} ${max}자까지예요.`);
  return t;
}

export function oneOf<T extends string>(v: unknown, list: readonly T[], label: string, fail: (m: string) => HttpError): T {
  if (typeof v !== "string" || !(list as readonly string[]).includes(v)) throw fail(`${eun(label)} ${list.join(", ")} 가운데 하나예요.`);
  return v as T;
}

/** YYYY-MM-DD that names a real day */
export function isDay(v: unknown): v is string {
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && civilDate(dayNumber(v)) === v;
}

/** an ISO time with its zone: 2026-11-27T01:20Z, 2026-11-27T10:20:00+09:00 */
function isInstant(v: string): boolean {
  const m = /^(\d{4}-\d{2}-\d{2})T([01]\d|2[0-3]):[0-5]\d(:[0-5]\d(\.\d{1,3})?)?(Z|[+-]([01]\d|2[0-3]):[0-5]\d)$/.exec(v);
  return !!m && isDay(m[1]) && Number.isFinite(Date.parse(v));
}

/** a day or an ISO time, not later than two days from now */
export function stampOf(v: unknown, label: string, now: number, fail: (m: string) => HttpError, optional = false): string | null {
  if (v === undefined || v === null || v === "") {
    if (optional) return null;
    throw fail(`${eul(label)} 넣어 주세요.`);
  }
  if (typeof v !== "string" || !(isDay(v) || isInstant(v))) throw fail(`${eun(label)} 날짜(YYYY-MM-DD)나 ISO 시각으로 넣어 주세요.`);
  const at = isDay(v) ? dayNumber(v) * 86_400_000 : Date.parse(v);
  if (at > now + 2 * 86_400_000) throw fail(`${josa(label, "이", "가")} 아직 오지 않은 날이에요.`);
  return v;
}

export function urlOf(v: unknown, fail: (m: string) => HttpError): string | null {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "string" || v.length > 500 || /\s|\p{Cc}/u.test(v)) throw fail("링크가 올바르지 않아요.");
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    throw fail("링크가 올바르지 않아요.");
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw fail("링크는 http나 https 주소만 넣을 수 있어요.");
  if (u.username || u.password) throw fail("링크에 계정 정보를 넣을 수 없어요.");
  return u.toString();
}

/** source name, tier, grade and link together: a T4 source is grade C (B1) */
export function sourceOf(b: Record<string, unknown>, fail: (m: string) => HttpError): { source: string; sourceTier: InvestTier; confidence: InvestGrade; url: string | null } {
  const source = lineOf(b.source, "출처", 80, fail)!;
  const sourceTier = oneOf(b.sourceTier, TIERS, "출처 층위", fail);
  const confidence = oneOf(b.confidence, GRADES, "등급", fail);
  if (sourceTier === "T4" && confidence !== "C") throw fail("T4 출처는 T1·T2 출처로 확인하기 전까지 C 등급이에요.");
  return { source, sourceTier, confidence, url: urlOf(b.url, fail) };
}

// ───────────── numbers in text (format.ts) ─────────────

/** a value's text in its unit; the forecast ledger uses it for intervals too */
export function unitText(unit: InvestLedgerUnit, v: number): string {
  switch (unit) {
    case "usd":
      return usd(v);
    case "krw":
      return krw(v);
    case "pct":
      return rate(v, 2);
    case "pctp":
      return pp(v, 2);
    case "qty":
      return shares(v);
    case "bp":
      return `${num(v, 0)}bp`;
    case "count":
      return num(v, 0);
    case "T":
      return `${num(v, 1)}조 토큰`;
    case "GW":
      return `${num(v, 1)}GW`;
    case "$B":
      return v < 0 ? `${MINUS}$${num(-v, 1)}B` : `$${num(v, 1)}B`;
    default:
      return num(v, 2);
  }
}

// ───────────── the ledger ─────────────

export interface LedgerFields {
  id: string;
  asOf: string;
  publishedAt: string | null;
  value: number | null;
  valueText: string | null;
  unit: InvestLedgerUnit;
  definition: string;
  source: string;
  sourceTier: InvestTier;
  url: string | null;
  revision: string | null;
  confidence: InvestGrade;
  leadClass: InvestLeadClass | null;
}

const invalidLedger = invalidOf("invalid_ledger");

/** the nine fields, checked; throws 400 invalid_ledger with the field's sentence */
export function checkLedger(body: unknown, now: number): LedgerFields {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw invalidLedger("원장 줄이 올바르지 않아요.");
  const b = body as Record<string, unknown>;
  if (typeof b.id !== "string" || !LEDGER_ID_RE.test(b.id)) throw invalidLedger("id는 글자, 숫자, '.', '_', '-'로 64자까지예요.");
  const asOf = stampOf(b.asOf, "기준일", now, invalidLedger)!;
  const publishedAt = stampOf(b.publishedAt, "발표일", now, invalidLedger, true);
  const unit = oneOf(b.unit, LEDGER_UNITS, "단위", invalidLedger);
  let value: number | null = null;
  let valueText: string | null = null;
  if (unit === "text") {
    if (b.value !== undefined && b.value !== null) throw invalidLedger("글로 된 값에는 숫자를 넣지 않아요.");
    valueText = lineOf(b.valueText, "값", 200, invalidLedger);
  } else {
    if (typeof b.value !== "number" || !Number.isFinite(b.value)) throw invalidLedger("값을 숫자로 넣어 주세요.");
    if (b.valueText !== undefined && b.valueText !== null) throw invalidLedger("숫자 값에는 글 값을 넣지 않아요. 단위를 text로 해 주세요.");
    value = b.value;
  }
  const definition = lineOf(b.definition, "정의", 300, invalidLedger)!;
  const src = sourceOf(b, invalidLedger);
  const revision = lineOf(b.revision, "고친 기록", 200, invalidLedger, true);
  const leadClass = b.leadClass === undefined || b.leadClass === null ? null : oneOf(b.leadClass, LEAD_CLASSES, "선행성", invalidLedger);
  return { id: b.id, asOf, publishedAt, value, valueText, unit, definition, ...src, revision, leadClass };
}

/**
 * Write one row: checked, under the person (or '' for a shared row, code only). The same (id, as_of) again replaces
 * the row; a person's or the model's rewrite without a revision note gets "{KST day} 고침".
 */
export function writeLedger(db: Db, userId: string, body: unknown, author: InvestAuthor, now: number): InvestLedgerEntry {
  if (userId === "" && author !== "code") throw new Error("only code writes shared ledger rows");
  const f = checkLedger(body, now);
  if (author !== "code" && CODE_SERIES.some((p) => f.id.startsWith(p))) throw bad("코드가 계산하는 줄이에요. 다른 id를 써 주세요.", "ledger_reserved");
  return db.tx(() => {
    const prev = db.sql.query("SELECT author FROM invest_ledger WHERE user_id = $u AND id = $id AND as_of = $a").get({ u: userId, id: f.id, a: f.asOf }) as { author: string } | null;
    if (prev?.author === "code" && author !== "code") throw new HttpError(409, "ledger_locked", "코드가 쓴 줄은 바꿀 수 없어요.");
    if (!prev && author !== "code") {
      const n = (db.sql.query("SELECT COUNT(*) AS n FROM invest_ledger WHERE user_id = $u AND author != 'code'").get({ u: userId }) as { n: number }).n;
      if (n >= MAX_LEDGER_ROWS) throw bad(`원장 줄은 ${num(MAX_LEDGER_ROWS)}개까지 쓸 수 있어요.`, "too_many_ledger_rows");
    }
    const revision = f.revision ?? (prev && author !== "code" ? `${kstDay(now)} 고침` : null);
    const row: LedgerRow = {
      user_id: userId,
      id: f.id,
      as_of: f.asOf,
      published_at: f.publishedAt,
      value: f.value,
      value_text: f.valueText,
      unit: f.unit,
      definition: f.definition,
      source_tier: f.sourceTier,
      source: f.source,
      url: f.url,
      revision,
      confidence: f.confidence,
      lead_class: f.leadClass,
      author,
      created_at: now,
    };
    const cols = Object.keys(row);
    db.sql.query(`INSERT OR REPLACE INTO invest_ledger (${cols.join(", ")}) VALUES (${cols.map((c) => `$${c}`).join(", ")})`).run(row as unknown as Record<string, string | number | null>);
    return ledgerView(row);
  });
}

/** the person's rows and the shared ones: one id's by as_of (newest first), or the latest written */
export function readLedger(db: Db, userId: string, q: { id?: string; limit?: number }): InvestLedgerEntry[] {
  const limit = Math.min(Math.max(1, Math.floor(q.limit ?? 50)), LEDGER_READ_MAX);
  const rows = q.id
    ? db.sql.query("SELECT * FROM invest_ledger WHERE user_id IN ($u, '') AND id = $id ORDER BY as_of DESC, created_at DESC LIMIT $l").all({ u: userId, id: q.id, l: limit })
    : db.sql.query("SELECT * FROM invest_ledger WHERE user_id IN ($u, '') ORDER BY created_at DESC, id LIMIT $l").all({ u: userId, l: limit });
  return (rows as LedgerRow[]).map(ledgerView);
}

export function ledgerView(r: LedgerRow): InvestLedgerEntry {
  const unit = r.unit as InvestLedgerUnit;
  return {
    id: r.id,
    asOf: r.as_of,
    publishedAt: r.published_at,
    value: r.value != null ? { v: r.value, text: unitText(unit, r.value) } : null,
    valueText: r.value_text,
    unit,
    definition: r.definition,
    source: r.source ?? r.source_tier,
    sourceTier: r.source_tier as InvestTier,
    url: r.url,
    revision: r.revision,
    confidence: r.confidence as InvestGrade,
    leadClass: r.lead_class as InvestLeadClass | null,
    author: r.author as InvestAuthor,
    shared: r.user_id === "",
    createdAt: r.created_at,
  };
}
