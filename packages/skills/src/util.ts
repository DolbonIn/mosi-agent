import { needsConnection, type ApprovalSpec, type ConnectionHandle, type JsonSchema, type ToolContext, type ToolDef, type ToolResult } from "@pickle/agent";
import type { IconName } from "@pickle/protocol";
import { deadline, TIMEOUT_MS, type ProxyError } from "./http";

// ───────────────────────────── args ─────────────────────────────

export type Args = Record<string, unknown>;

export function str(v: unknown, max = 100): string {
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v !== "string") return "";
  return v.replace(/[\u0000-\u001f]/g, " ").trim().slice(0, max);
}

export function int(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : Number.NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

export function optInt(v: unknown, min: number, max: number): number | undefined {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : Number.NaN;
  if (!Number.isFinite(n)) return undefined;
  return Math.min(max, Math.max(min, Math.round(n)));
}

// ───────────────────────────── text ─────────────────────────────

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  middot: "·",
  hellip: "…",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  ndash: "–",
  mdash: "—",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, g: string) => {
    if (g[0] === "#") {
      const code = g[1] === "x" || g[1] === "X" ? Number.parseInt(g.slice(2), 16) : Number.parseInt(g.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[g.toLowerCase()] ?? m;
  });
}

/** Strip HTML tags, decode entities, collapse whitespace. */
export function cleanText(s: unknown, max = 400): string {
  if (typeof s !== "string") return "";
  const out = decodeEntities(s.replace(/<br\s*\/?>/gi, " ").replace(/<[^>]*>/g, ""))
    .replace(/\s+/g, " ")
    .trim();
  return out.length > max ? out.slice(0, max - 1) + "…" : out;
}

// ───────────────────────────── numbers ─────────────────────────────

export function num(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string" || !v.trim()) return null;
  const n = Number(v.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

/** ₩12,340 */
export function won(n: number): string {
  return `₩${Math.round(n).toLocaleString("en-US")}`;
}

/** 12,340원 */
export function wonKo(n: number): string {
  return `${Math.round(n).toLocaleString("en-US")}원`;
}

/** 만원 단위 → "16억 1,500만원" / "8,500만원" */
export function manwon(value: number): string {
  const v = Math.round(value);
  const eok = Math.floor(v / 10000);
  const rest = v % 10000;
  if (eok > 0 && rest > 0) return `${eok}억 ${rest.toLocaleString("en-US")}만원`;
  if (eok > 0) return `${eok}억원`;
  return `${rest.toLocaleString("en-US")}만원`;
}

export function meters(m: number): string {
  if (m < 1000) return `${Math.round(m)}m`;
  return `${(m / 1000).toFixed(m >= 100_000 ? 0 : 1).replace(/\.0$/, "")}km`;
}

export function minutes(sec: number): string {
  const m = Math.round(sec / 60);
  if (m < 60) return `${m}분`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h}시간 ${m % 60}분` : `${h}시간`;
}

// ───────────────────────────── KST dates ─────────────────────────────

const KST_OFFSET = 9 * 3600_000;
const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];

export interface Kst {
  y: number;
  m: number; // 1-12
  d: number;
  hh: number;
  mi: number;
  ymd: string; // YYYYMMDD
  dow: number;
}

export function kst(date: Date): Kst {
  const t = new Date(date.getTime() + KST_OFFSET);
  const y = t.getUTCFullYear();
  const m = t.getUTCMonth() + 1;
  const d = t.getUTCDate();
  return { y, m, d, hh: t.getUTCHours(), mi: t.getUTCMinutes(), ymd: `${y}${pad(m)}${pad(d)}`, dow: t.getUTCDay() };
}

export function pad(n: number, w = 2): string {
  return String(n).padStart(w, "0");
}

/** "20261111" + n days → "20261112" */
export function addDays(ymd: string, n: number): string {
  const t = Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8)) + n * 86400_000;
  const d = new Date(t);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
}

export function dayDiff(fromYmd: string, toYmd: string): number {
  const a = Date.UTC(+fromYmd.slice(0, 4), +fromYmd.slice(4, 6) - 1, +fromYmd.slice(6, 8));
  const b = Date.UTC(+toYmd.slice(0, 4), +toYmd.slice(4, 6) - 1, +toYmd.slice(6, 8));
  return Math.round((b - a) / 86400_000);
}

export function weekday(ymd: string): string {
  const d = new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8)));
  return WEEKDAYS[d.getUTCDay()] ?? "";
}

/** "20261111" → "11/11 (수)" */
export function mdDow(ymd: string): string {
  return `${+ymd.slice(4, 6)}/${+ymd.slice(6, 8)} (${weekday(ymd)})`;
}

/** Normalise "2026-11-25", "2026.11.25", "20261125" → "20261125" (or "" when not a date). */
export function toYmd(s: unknown): string {
  if (typeof s !== "string") return "";
  const digits = s.replace(/[^0-9]/g, "");
  if (digits.length < 8) return "";
  const ymd = digits.slice(0, 8);
  const y = +ymd.slice(0, 4);
  const m = +ymd.slice(4, 6);
  const d = +ymd.slice(6, 8);
  const probe = new Date(Date.UTC(y, m - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d ? ymd : "";
}

/** Parse a user date ("2026-11-10", "20261110", "오늘", "내일", "어제") relative to `today` (YYYYMMDD). */
export function parseUserDate(v: unknown, today: string): string | null {
  const s = str(v, 20);
  if (!s || s === "오늘" || s === "today") return today;
  if (s === "내일" || s === "tomorrow") return addDays(today, 1);
  if (s === "모레") return addDays(today, 2);
  if (s === "어제" || s === "yesterday") return addDays(today, -1);
  const ymd = toYmd(s);
  return ymd || null;
}

// ───────────────────────────── XML (minimal, regex based) ─────────────────────────────

/** All `<tag>…</tag>` blocks (non-nested). */
export function xmlBlocks(xml: string, tag: string): string[] {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "g");
  const out: string[] = [];
  for (let m = re.exec(xml); m; m = re.exec(xml)) out.push(m[1] ?? "");
  return out;
}

/** Text of the first `<tag>` in `xml` (CDATA unwrapped, entities decoded). */
export function xmlText(xml: string, tag: string): string {
  const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`).exec(xml);
  if (!m) return "";
  const inner = (m[1] ?? "").replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, "$1");
  return decodeEntities(inner).trim();
}

// ───────────────────────────── data size ─────────────────────────────

/** Max UTF-8 bytes of a tool's `data` (Hangul is 3 bytes per character). */
export const DATA_MAX = 4096;
const encoder = new TextEncoder();

export function byteLength(s: string): number {
  return encoder.encode(s).length;
}

/** Trim the longest arrays until the JSON fits in `max` UTF-8 bytes (data goes to the model). */
export function fit<T>(data: T, max = DATA_MAX): T {
  if (data === undefined) return data;
  let json = JSON.stringify(data);
  if (json === undefined || byteLength(json) <= max) return data;
  const clone = JSON.parse(json) as T;
  for (let guard = 0; guard < 400 && byteLength(json) > max; guard++) {
    const arr = longestArray(clone);
    if (!arr || arr.length === 0) break;
    arr.pop();
    json = JSON.stringify(clone);
  }
  if (byteLength(json) > max) return { truncated: true, preview: json.slice(0, Math.floor(max / 3) - 40) } as unknown as T;
  return clone;
}

function longestArray(v: unknown, depth = 0): unknown[] | null {
  if (depth > 4 || v === null || typeof v !== "object") return null;
  let best: unknown[] | null = null;
  let bestLen = 0;
  const consider = (a: unknown[] | null) => {
    if (!a || a.length === 0) return;
    const len = JSON.stringify(a).length;
    if (len > bestLen) {
      best = a;
      bestLen = len;
    }
  };
  if (Array.isArray(v)) {
    consider(v);
    for (const x of v) consider(longestArray(x, depth + 1));
  } else {
    for (const x of Object.values(v as Record<string, unknown>)) consider(longestArray(x, depth + 1));
  }
  return best;
}

// ───────────────────────────── errors → Korean ─────────────────────────────

export function errorSummary(err: ProxyError, label: string): string {
  switch (err.kind) {
    case "timeout":
      return `${label}: 응답이 너무 늦어 중단했어요 (${TIMEOUT_MS / 1000}초 초과)`;
    case "aborted":
      return `${label}: 요청이 취소됐어요`;
    case "network":
      return `${label}: k-skill 프록시에 연결하지 못했어요`;
    case "rate_limited":
      return `${label}: 요청이 몰려 잠시 후 다시 시도해야 해요`;
    case "bad_request":
      return `${label}: 요청 값을 확인해 주세요`;
    case "not_found":
      return `${label}: 결과를 찾지 못했어요`;
    case "parse":
      return `${label}: 응답 형식을 해석하지 못했어요`;
    case "upstream":
    default:
      return `${label}: 지금은 원본 서비스 응답이 원활하지 않아요`;
  }
}

export function fail(err: ProxyError, label: string, summary?: string, extra?: Record<string, unknown>): ToolResult {
  return {
    ok: false,
    summary: summary ?? errorSummary(err, label),
    data: { error: err.kind, code: err.code, status: err.status || undefined, message: err.message.slice(0, 200), ...extra },
  };
}

export function failText(summary: string, error = "invalid_args", extra?: Record<string, unknown>): ToolResult {
  return { ok: false, summary, data: { error, ...extra } };
}

// ───────────────────────────── tool definition ─────────────────────────────

/** What a skill implementation gets: no user identity, only cancellation, clock and progress. */
export interface RunCtx {
  signal: AbortSignal;
  now: Date;
  status(text: string): void;
  /**
   * The owner's unsealed login, only for tools with `connection` (set by runTurn for the duration of run()). Read
   * `conn.secret` here and nowhere else; never copy secret values into summary, data, card or errors.
   */
  conn: ConnectionHandle | null;
}

/** A k-skill login a tool runs with (KSKILL-CONNECTIONS.md): the vault service id, its name and why it's needed. */
export interface SkillConnection {
  id: string;
  name: string;
  /** one Korean line for the connection card ("보유 주식을 보려면 토스증권 연결이 필요해요") */
  reason: string;
}

export interface SkillMeta {
  /** k-skill folder name(s) this tool is built on */
  source: string;
  title: string; // Korean short title, e.g. "날씨"
  description: string; // Korean one-liner for the skills screen
  category: string;
  /** Korean example request for the system prompt / templates */
  example: string;
}

export interface SkillSpec {
  name: string;
  description: string;
  parameters: JsonSchema;
  icon: IconName;
  title(args: Args): string;
  run(args: Args, rc: RunCtx): Promise<ToolResult>;
  meta: SkillMeta;
  /** runs with the owner's own login (resolved by runTurn before run(); none → connection card) */
  connection?: SkillConnection;
  /** acting tool (issues/sends upstream): needs `approval`, never offered in meeting voice turns */
  write?: boolean;
  approval?(args: Args): ApprovalSpec | null;
  /**
   * true: results are the owner's private account data (holdings, invoices, ad spend), said only to the owner.
   * false: public data even though it runs with a login (a quote, a product or paper search): a meeting may say it.
   * Omitted on a `connection` tool, meetings treat it as private. Every connection tool here says it explicitly.
   */
  private?: boolean;
  /** max UTF-8 bytes of `data` (default DATA_MAX, 4 KB); the runtime caps a whole tool result at 6 KB unless `maxResultBytes` */
  dataMax?: number;
  /** this tool's result cap for the model (ToolDef.maxResultBytes, 1–24 KB; the runtime's default is 6 KB) */
  maxResultBytes?: number;
  /** deep search role (ToolDef.explore): "search" (args.query, data.results) or "read" (args.url, data.url/contacts) */
  explore?: "search" | "read";
  /** this skill's own deadline instead of the 12 s default (keep it under the runtime's 25 s tool timeout) */
  deadlineMs?: number;
}

export interface SkillTool extends ToolDef {
  meta: SkillMeta;
  /** the login this tool needs, with its display name (ToolDef.connection carries the id) */
  connectionInfo?: SkillConnection;
  /** true = the owner's private account data; false = public data despite the login (see SkillSpec.private) */
  private?: boolean;
  /** see SkillSpec.explore (the runtime's ToolDef carries the same field) */
  explore?: "search" | "read";
  /** see SkillSpec.maxResultBytes */
  maxResultBytes?: number;
}

/** Wrap a skill: per-call 12 s deadline combined with ctx.signal, never throws, data ≤ 4 KB (or `dataMax`). */
export function defineSkill(spec: SkillSpec): SkillTool {
  if (spec.write && !spec.approval) throw new Error(`${spec.name}: a write tool must define approval()`);
  const tool: SkillTool = {
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters,
    icon: spec.icon,
    meta: spec.meta,
    title: (args) => {
      try {
        return spec.title(args ?? {});
      } catch {
        return spec.meta.title;
      }
    },
    async run(args: Args, ctx: ToolContext): Promise<ToolResult> {
      const conn = spec.connection ? (ctx?.connection ?? null) : null;
      // the runtime resolves the login before run(); without it (old runtime, direct call) ask for the connection
      if (spec.connection && !conn) return needsConnection(spec.connection.id, spec.connection.name, spec.connection.reason);
      const dl = deadline(ctx?.signal, spec.deadlineMs);
      try {
        const rc: RunCtx = {
          conn,
          signal: dl.signal,
          now: typeof ctx?.now === "function" ? ctx.now() : new Date(),
          status: (t) => {
            try {
              ctx?.status?.(t);
            } catch {
              /* ignore UI errors */
            }
          },
        };
        const res = await spec.run(args ?? {}, rc);
        if (res.data !== undefined) res.data = fit(res.data, spec.dataMax ?? DATA_MAX);
        return res;
      } catch (e) {
        // a connection tool's error text could carry upstream echoes of the login: keep only a generic line
        const msg = spec.connection ? "unexpected error" : e instanceof Error ? e.message : String(e);
        return { ok: false, summary: `${spec.meta.title}: 처리 중 오류가 났어요`, data: { error: "internal", message: msg.slice(0, 200) } };
      } finally {
        dl.dispose();
      }
    },
  };
  if (spec.connection) {
    tool.connection = spec.connection.id;
    tool.connectionReason = spec.connection.reason; // the connect card's line (runtime falls back to the title)
    tool.connectionInfo = spec.connection;
  }
  if (spec.write) tool.write = true;
  if (spec.private !== undefined) tool.private = spec.private;
  if (spec.explore) tool.explore = spec.explore;
  if (spec.maxResultBytes) tool.maxResultBytes = spec.maxResultBytes;
  if (spec.approval) {
    const approval = spec.approval;
    tool.approval = (args) => approval(args ?? {});
  }
  return tool;
}

/** Convenience: object JSON schema with additionalProperties false. */
export function schema(properties: JsonSchema["properties"], required: string[] = []): JsonSchema {
  return { type: "object", properties, required, additionalProperties: false };
}
