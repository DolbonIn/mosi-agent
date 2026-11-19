/**
 * runTurn: the agent loop. Concept ported from gajae-code `agent-loop.ts` (MIT): an inner loop that
 * calls the model, runs the requested tools, polls steering messages and repeats while there are tool
 * calls or queued messages; it stops when the model answers without tools and nothing is queued.
 */
import type { AgentEvent, Card, ToolActivity } from "@pickle/protocol";
import { CONNECTION_SERVICE_RE, connectionErrorCode, connectionReason, knownSecrets, redactResult, redactor, type Redactor } from "./connections";
import { CARD_STATUS, DEEP_MAX_TOKENS, EXPLORE_RULE, ExploreTracker, TOOL_MARKUP_NOTE, ToolMarkupFilter, VOICE_SEARCH_PREFACE, cardToolOf, exploreIntent, exploreKind, exploreOpen, exploreStatus, type DeepSearchOptions } from "./explore";
import type { LlmClient, Usage } from "./llm";
import { scrubSecrets } from "./secrets";
import type {
  ApprovalSpec,
  ConnectionHandle,
  ConnectionNeed,
  CredentialAccess,
  CredentialNeed,
  LlmMessage,
  LlmToolCall,
  RunTurn,
  ToolContext,
  ToolDef,
  ToolResult,
  TurnInput,
  TurnOutcome,
} from "./types";

export interface RunTurnOptions {
  /** max UTF-8 bytes of one tool result sent back to the model. Default 6 KB. */
  maxToolResultBytes?: number;
  /** a single tool call is aborted after this long, unless the tool sets ToolDef.timeoutMs. Default 25 s. */
  toolTimeoutMs?: number;
  /** max_tokens per model call. Default 2048. */
  maxTokens?: number;
  temperature?: number;
  /**
   * Deep search for "find every place / contact / seller" requests when the turn has an `explore: "search"` tool
   * (explore.ts): true for the defaults (12 calls, 60 s, 3 queries, 2 tools; "전부" in text: 40 calls, 180 s, 4 queries),
   * or the limits. Off by default; the server's chat runner turns it on (meeting turns don't).
   */
  deepSearch?: boolean | DeepSearchOptions;
}

export const DEFAULT_MAX_STEPS = 8;
/**
 * A tool call's deadline. It stays well below the server's turn idle watchdog (60 s without an event), so a hung call
 * ends as an error the model answers. When both were 60 s, four msg_read calls stuck on a Slack 429 (2026-11-12) let the
 * watchdog kill the whole turn ("응답이 너무 늦어지고 있어요") before the model could say what it couldn't read.
 */
export const DEFAULT_TOOL_TIMEOUT_MS = 25_000;
/** the longest ToolDef.timeoutMs honoured */
const MAX_TOOL_TIMEOUT_MS = 5 * 60_000;
/** chip lines for a call that threw or ran out of time: fixed Korean, never the raw error (the model gets that, scrubbed) */
export const TOOL_TIMEOUT_SUMMARY = "시간이 너무 오래 걸렸어요";
export const TOOL_ERROR_SUMMARY = "실행 중에 문제가 생겼어요";
export const TOOL_STOPPED_SUMMARY = "중단했어요";
const TOOL_TIMEOUT_NOTE = "응답이 오지 않아 중단했어요. 이번 답변에서는 같은 호출을 다시 하지 말고, 무엇을 확인하지 못했는지 사용자에게 짧게 알려 주세요.";
const THINKING_STATUS = "생각하는 중";
const VOICE_RULE =
  "\n\n[음성 모드] 지금은 음성 통화 중이에요. 한두 문장의 짧은 구어체로만 답하세요. 목록, 마크다운, 이모지, URL, 표는 쓰지 마세요.";
const FINAL_ANSWER_NOTE =
  "[시스템 안내] 도구 사용 횟수 한도에 도달했어요. 더 이상 도구를 호출하지 말고, 지금까지 얻은 정보만으로 사용자에게 바로 답하세요. 확인하지 못한 부분은 솔직하게 말하세요.";
const EMPTY_REPLY = "앗, 답을 정리하지 못했어요. 한 번만 다시 말씀해 주시겠어요?";
/** deep search steps that may call tools: words held back until they read as the answer (a paragraph on, or this long) */
const PLAN_HOLD_CHARS = 200;
const PARAGRAPH_ON = /\n\s*\n\s*\S/;
const MAX_FORCED_ROUNDS = 3;
/**
 * A plain turn that got a design guide (a tool result with `data.guide`, sys_create_artifact's content "") and reached
 * the step limit before that tool made its card: one last step with only that tool. Lazy mode spends a step on the
 * guide, and '노트북 5종을 사양 7개로 비교해줘' ran out of steps searching after it (a markdown table, no card).
 */
const GUIDE_CARD_NOTE =
  "[시스템 안내] 도구를 쓸 수 있는 마지막 단계예요. 더 찾지 말고, 위의 디자인 가이드대로 지금까지 얻은 정보로 카드를 한 번에 만드세요. 확인하지 못한 값은 카드에 '확인 안 됨'으로 적어요.";
/** a design guide came back (sys_create_artifact kind "html", content ""): `data.guide`, not a card */
const isGuide = (r: ToolResult): boolean => !!r.data && typeof r.data === "object" && typeof (r.data as { guide?: unknown }).guide === "string";
/** in-turn wait for the owner to connect a k-skill login (TurnInput.connectionWaitMs, opt-in; the server passes ~90 s) */
const MAX_CONNECTION_WAIT_MS = 4 * 60_000;
/** status heartbeat while waiting (keeps the server's idle timer fed) */
const CONNECTION_HEARTBEAT_MS = 15_000;
const STEER_POLL_MS = 1_000;
/** a service is waited for at most this many times per turn */
const MAX_CONNECTION_WAITS = 2;

const partials = new WeakMap<object, TurnOutcome>();

/**
 * When runTurn rejects (abort, upstream error) after it already produced messages — e.g. an approved
 * tool ran and then the follow-up model call failed — the partial outcome is attached to the error.
 * Persist `partial.messages` so the model knows the action happened.
 */
export function partialOutcome(err: unknown): TurnOutcome | null {
  return err && typeof err === "object" ? (partials.get(err) ?? null) : null;
}

function withPartial(err: unknown, partial: TurnOutcome): unknown {
  const e = err && typeof err === "object" ? err : new Error(String(err));
  if (partial.messages.length || partial.tools.length) partials.set(e, partial);
  return e;
}

/** Trim `s` so its UTF-8 encoding is at most `maxBytes`, without splitting a character. */
export function truncateUtf8(s: string, maxBytes: number, marker = "…[truncated]"): string {
  const enc = new TextEncoder();
  if (enc.encode(s).length <= maxBytes) return s;
  const budget = Math.max(0, maxBytes - enc.encode(marker).length);
  let bytes = 0;
  let end = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    const n = cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
    if (bytes + n > budget) break;
    bytes += n;
    end += ch.length;
  }
  return s.slice(0, end) + marker;
}

/**
 * Make stored history valid for an OpenAI-compatible request: every assistant tool call gets exactly one
 * tool result (a synthetic "interrupted" one when missing), orphan tool messages are dropped, and a
 * duplicated tool-call block (same call ids persisted twice) is skipped.
 */
export function repairHistory(msgs: LlmMessage[]): LlmMessage[] {
  const out: LlmMessage[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i]!;
    if (m.role === "tool") continue; // orphan (its assistant message was handled below)
    if (m.role !== "assistant" || !m.tool_calls?.length) {
      out.push(m.role === "assistant" ? { role: "assistant", content: m.content ?? "" } : m);
      continue;
    }
    const calls = m.tool_calls.filter((c) => !seen.has(c.id));
    let j = i + 1;
    const results = new Map<string, LlmMessage>();
    while (j < msgs.length && msgs[j]!.role === "tool") {
      const t = msgs[j] as Extract<LlmMessage, { role: "tool" }>;
      if (calls.some((c) => c.id === t.tool_call_id) && !results.has(t.tool_call_id)) results.set(t.tool_call_id, t);
      j++;
    }
    i = j - 1;
    if (!calls.length) {
      if (m.content) out.push({ role: "assistant", content: m.content });
      continue;
    }
    for (const c of calls) seen.add(c.id);
    out.push({ role: "assistant", content: m.content ?? null, tool_calls: calls });
    for (const c of calls) {
      out.push(results.get(c.id) ?? { role: "tool", tool_call_id: c.id, content: JSON.stringify({ ok: false, error: "interrupted: no result was recorded" }) });
    }
  }
  return out;
}

/** Streaming filter that drops `<think>…</think>` segments some models put in `content`. */
class ThinkFilter {
  #inThink = false;
  #buf = "";
  push(s: string): string {
    this.#buf += s;
    let out = "";
    for (;;) {
      const tag = this.#inThink ? "</think>" : "<think>";
      const idx = this.#buf.indexOf(tag);
      if (idx >= 0) {
        if (!this.#inThink) out += this.#buf.slice(0, idx);
        this.#buf = this.#buf.slice(idx + tag.length);
        this.#inThink = !this.#inThink;
        continue;
      }
      let keep = 0;
      for (let k = Math.min(tag.length - 1, this.#buf.length); k > 0; k--) {
        if (tag.startsWith(this.#buf.slice(-k))) {
          keep = k;
          break;
        }
      }
      if (!this.#inThink) out += this.#buf.slice(0, this.#buf.length - keep);
      this.#buf = this.#buf.slice(this.#buf.length - keep);
      return out;
    }
  }
  flush(): string {
    const rest = this.#inThink ? "" : this.#buf;
    this.#buf = "";
    return rest;
  }
}

type ParsedCall =
  | { call: LlmToolCall; ok: true; def: ToolDef; args: Record<string, unknown>; title: string }
  | { call: LlmToolCall; ok: false; def: ToolDef | undefined; error: string; title: string };

/** Lenient JSON-object parse for model-produced tool arguments. */
export function parseToolArgs(raw: string): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  let s = (raw ?? "").trim();
  if (!s) return { ok: true, value: {} };
  s = s.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const attempts = [s, s.replace(/,\s*([}\]])/g, "$1")];
  for (const a of attempts) {
    try {
      const v: unknown = JSON.parse(a);
      if (v && typeof v === "object" && !Array.isArray(v)) return { ok: true, value: v as Record<string, unknown> };
      if (typeof v === "string") {
        const inner: unknown = JSON.parse(v); // double-encoded
        if (inner && typeof inner === "object" && !Array.isArray(inner)) return { ok: true, value: inner as Record<string, unknown> };
      }
      return { ok: false, error: "arguments must be a JSON object" };
    } catch {
      /* try next */
    }
  }
  return { ok: false, error: `invalid JSON arguments: ${s.slice(0, 120)}` };
}

function checkArgs(def: ToolDef, args: Record<string, unknown>): string | null {
  const missing = (def.parameters.required ?? []).filter((k) => args[k] === undefined || args[k] === null || args[k] === "");
  if (missing.length) return `missing required argument(s): ${missing.join(", ")}`;
  for (const [k, spec] of Object.entries(def.parameters.properties)) {
    const v = args[k];
    if (v === undefined || v === null) continue;
    const t = spec.type;
    const bad =
      (t === "string" && typeof v !== "string") ||
      ((t === "number" || t === "integer") && typeof v !== "number") ||
      (t === "boolean" && typeof v !== "boolean") ||
      (t === "array" && !Array.isArray(v));
    if (bad) {
      // coerce the harmless cases instead of failing the call
      if (t === "string" && (typeof v === "number" || typeof v === "boolean")) args[k] = String(v);
      else if ((t === "number" || t === "integer") && typeof v === "string" && v.trim() && Number.isFinite(Number(v))) args[k] = Number(v);
      else if (t === "boolean" && (v === "true" || v === "false")) args[k] = v === "true";
      else return `argument "${k}" must be ${t}`;
    }
    if (t === "string" && spec.enum && !spec.enum.includes(args[k] as string)) return `argument "${k}" must be one of: ${spec.enum.join(", ")}`;
  }
  return null;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  return String(err);
}

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
}

/** a call that outlived its deadline (ToolDef.timeoutMs or the runner's toolTimeoutMs) */
class ToolTimeoutError extends Error {
  readonly ms: number;
  constructor(ms: number) {
    super(`tool timed out after ${ms} ms`);
    this.name = "ToolTimeoutError";
    this.ms = ms;
  }
}

const isTimeoutReason = (r: unknown): boolean => !!r && typeof r === "object" && (r as { name?: unknown }).name === "TimeoutError";

/** an error whose message is a fixed Korean, user-facing sentence by contract (@pickle/messengers MessengerError) */
function userFacingError(err: unknown): { code: string; message: string } | null {
  if (!(err instanceof Error) || err.name !== "MessengerError") return null;
  const code = (err as { code?: unknown }).code;
  const message = err.message.trim();
  return typeof code === "string" && code && message ? { code, message } : null;
}

function addUsage(a: Usage, b: Usage): Usage {
  const sum: Usage = { promptTokens: a.promptTokens + b.promptTokens, completionTokens: a.completionTokens + b.completionTokens, totalTokens: a.totalTokens + b.totalTokens };
  const cached = (a.cachedTokens ?? 0) + (b.cachedTokens ?? 0);
  if (cached > 0) sum.cachedTokens = cached;
  return sum;
}

function lastAssistantWith(msgs: LlmMessage[], callId: string): number {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]!;
    if (m.role === "assistant" && m.tool_calls?.some((c) => c.id === callId)) return i;
  }
  return -1;
}

/** Remove a copy of `prior` that the server may already have appended to `history`. */
function alignResumeHistory(history: LlmMessage[], prior: LlmMessage[], callId: string): LlmMessage[] {
  const h = lastAssistantWith(history, callId);
  if (h < 0) return history;
  const p = Math.max(0, lastAssistantWith(prior, callId));
  return history.slice(0, Math.max(0, h - p));
}

/** `obj` whose methods (and nested objects', e.g. store.kv) get their arguments redacted before they run */
function redactingCalls<T extends object>(obj: T, R: () => Redactor, depth = 0): T {
  if (!obj || typeof obj !== "object") return obj;
  const wrap = (v: unknown): unknown => {
    if (typeof v === "function") return (...args: unknown[]) => (v as (...a: unknown[]) => unknown).apply(obj, R().deep(args));
    if (v && typeof v === "object" && depth < 2) return redactingCalls(v as object, R, depth + 1);
    return v;
  };
  // an empty stand-in target: no Proxy invariant ties the answers to `obj` (which may be frozen or sealed)
  return new Proxy(Object.create(null) as T, {
    get: (_t, prop) => wrap(Reflect.get(obj, prop, obj)),
    has: (_t, prop) => Reflect.has(obj, prop),
    ownKeys: () => Reflect.ownKeys(obj),
    getOwnPropertyDescriptor(_t, prop) {
      const d = Reflect.getOwnPropertyDescriptor(obj, prop);
      return d ? { value: wrap(Reflect.get(obj, prop, obj)), writable: false, enumerable: d.enumerable ?? false, configurable: true } : undefined;
    },
    getPrototypeOf: () => Object.getPrototypeOf(obj),
  });
}

export function createRunTurn(llm: LlmClient, opts: RunTurnOptions = {}): RunTurn {
  const maxResultBytes = opts.maxToolResultBytes ?? 6 * 1024;
  const toolTimeoutMs = opts.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
  const deadlineOf = (def: ToolDef): number => {
    const own = def.timeoutMs;
    return typeof own === "number" && Number.isFinite(own) && own > 0 ? Math.max(1, Math.min(Math.floor(own), MAX_TOOL_TIMEOUT_MS)) : toolTimeoutMs;
  };
  const maxTokens = opts.maxTokens ?? 2048;

  return async function runTurn(input: TurnInput, emit: (e: AgentEvent) => void): Promise<TurnOutcome> {
    const { ctx, tools } = input;
    const signal = ctx.signal;
    const byName = new Map(tools.map((t) => [t.name, t] as const));
    // a page reader (explore "read", e.g. web_read) supersedes sys_web_fetch: the model sees only the reader (a
    // resumed sys_web_fetch call still runs)
    const offered = tools.some((t) => exploreKind(t) === "read") ? tools.filter((t) => t.name !== "sys_web_fetch") : tools;
    // deep search: the search rule whenever a search tool is offered; the tracker only for a "find them all" request
    const exploring = !!opts.deepSearch && tools.some((t) => exploreKind(t) === "search");
    const deep =
      exploring && !input.resume && exploreIntent(input.userText)
        ? new ExploreTracker(typeof opts.deepSearch === "object" ? opts.deepSearch : undefined, Date.now(), input.mode === "voice" ? "voice" : "text", {
            text: input.userText,
            card: cardToolOf(offered),
            open: exploreOpen(input.userText),
          })
        : null;
    // a late html card comes as rows (card_rows, a page per step) and is drawn from them; never offered while searching.
    // '전부': it reads the lists begun on to their end with the page reader before it draws
    const rowsTool = deep?.rowsTool(deep.card ? byName.get(deep.card.name) : undefined, offered.find((t) => exploreKind(t) === "read")) ?? null;
    if (rowsTool) byName.set(rowsTool.name, rowsTool);
    const maxSteps = Math.max(1, Math.min(32, Math.floor(input.maxSteps ?? DEFAULT_MAX_STEPS)), deep ? deep.maxSteps : 0);
    const system = input.system + (exploring ? EXPLORE_RULE : "") + (input.mode === "voice" ? VOICE_RULE : "");
    const statusOf = (p: Extract<ParsedCall, { ok: true }>) => exploreStatus(p.def, p.args, p.title);

    const produced: LlmMessage[] = []; // new messages this invocation (+ resumed prior ones)
    const cards: Card[] = [];
    const activities = new Map<string, ToolActivity>();
    let usage: Usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    let text = "";

    /**
     * plain turns: the tool that gave this turn's design guide, the tools that returned ok otherwise (a card made), the
     * guide results in the step being run, and whether the guide's free step and its last card step were used
     */
    let guideFrom: string | null = null;
    const madeBy = new Set<string>();
    let stepGuides = 0;
    let guideStepFree = true;
    let guideCardStep = true;
    /** a step that only wrote a tool call as text gets one retry (drive) with TOOL_MARKUP_NOTE */
    let markupRetry: "unused" | "now" | "pending" | "used" = "unused";
    let lastEmitAt = Date.now();
    let lastStatus = THINKING_STATUS;
    const safeEmit = (e: AgentEvent) => {
      lastEmitAt = Date.now();
      if (e.type === "status") lastStatus = e.text;
      try {
        emit(e);
      } catch (err) {
        console.warn(`[pickle/agent] emit listener threw: ${errorMessage(err)}`);
      }
    };
    const emitText = (delta: string) => {
      if (!delta) return;
      text += delta;
      safeEmit({ type: "text", delta });
    };
    const setActivity = (a: ToolActivity) => {
      activities.set(a.id, a);
      safeEmit({ type: "tool", tool: { ...a } });
    };
    const addCard = (card: Card) => {
      cards.push(card);
      safeEmit({ type: "card", card });
    };

    // ── k-skill connections (docs/architecture/KSKILL-CONNECTIONS.md) ──
    const connectionWaitMs = input.mode === "voice" ? 0 : Math.max(0, Math.min(MAX_CONNECTION_WAIT_MS, Math.floor(input.connectionWaitMs ?? 0))) || 0;
    const connectionWaits = new Map<string, Promise<boolean>>();
    const connectionWaitCount = new Map<string, number>();
    /** call id → the credential the upstream just refused (the wait then needs a different one) */
    const refusedWith = new Map<string, string>();
    const serviceNameOf = (service: string): string => {
      try {
        const n = ctx.connections?.serviceName(service);
        return typeof n === "string" && n.trim() ? n.trim() : service;
      } catch {
        return service;
      }
    };

    // ── conversation ──
    let history = input.history;
    if (input.resume) history = alignResumeHistory(history, input.resume.priorMessages, input.resume.call.id);
    const convo: LlmMessage[] = [{ role: "system", content: system }, ...repairHistory(history)];
    const push = (m: LlmMessage) => {
      convo.push(m);
      produced.push(m);
    };

    const outcome = (extra: Partial<TurnOutcome> = {}): TurnOutcome => ({
      text,
      cards,
      tools: [...activities.values()].map((a) => ({ ...a })),
      messages: produced,
      usage,
      ...extra,
    });

    const injectSteering = (): boolean => {
      let queued: string[] = [];
      try {
        queued = input.steer?.() ?? [];
      } catch (err) {
        console.warn(`[pickle/agent] steer() threw: ${errorMessage(err)}`);
      }
      const msgs = queued.map((s) => (typeof s === "string" ? s.trim() : "")).filter(Boolean);
      for (const content of msgs) push({ role: "user", content });
      if (msgs.length) safeEmit({ type: "status", text: "추가 요청 반영하는 중" });
      return msgs.length > 0;
    };

    const resultCap = (n: number | undefined) => (typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.max(1024, Math.min(24 * 1024, Math.floor(n))) : maxResultBytes);
    const toolResultContent = (r: ToolResult, cap = maxResultBytes): string => {
      const payload: Record<string, unknown> = { ok: r.ok };
      if (r.summary) payload.summary = r.summary;
      if (!r.ok) payload.error = r.summary || "tool failed";
      if (r.data !== undefined) payload.data = r.data;
      let s: string;
      try {
        s = JSON.stringify(payload);
      } catch {
        s = JSON.stringify({ ok: r.ok, summary: r.summary, error: "result was not serialisable" });
      }
      return truncateUtf8(s, cap);
    };
    const errorContent = (error: string, extra: Record<string, unknown> = {}) => truncateUtf8(JSON.stringify({ ok: false, error, ...extra }), maxResultBytes);

    const titleOf = (def: ToolDef | undefined, args: Record<string, unknown>, fallback: string): string => {
      if (!def) return fallback;
      try {
        const t = def.title(args);
        return typeof t === "string" && t.trim() ? t.trim().slice(0, 60) : def.name;
      } catch {
        return def.name;
      }
    };

    const parseCall = (call: LlmToolCall): ParsedCall => {
      const def = byName.get(call.function.name);
      if (!def) {
        const names = [...byName.keys()].slice(0, 40).join(", ");
        return { call, ok: false, def, title: call.function.name, error: `unknown tool "${call.function.name}". Available tools: ${names || "(none)"}` };
      }
      const parsed = parseToolArgs(call.function.arguments);
      if (!parsed.ok) return { call, ok: false, def, title: def.name, error: parsed.error };
      const bad = checkArgs(def, parsed.value);
      if (bad) return { call, ok: false, def, title: titleOf(def, parsed.value, def.name), error: bad };
      return { call, ok: true, def, args: parsed.value, title: titleOf(def, parsed.value, def.name) };
    };

    /** plain tools can't reach a catalog service's logins through the legacy credential access */
    const owns = (service: string): boolean => {
      try {
        return !!ctx.connections?.owns?.(service);
      } catch {
        return true;
      }
    };
    const scopedCredentials = (base: CredentialAccess): CredentialAccess => ({
      find: async (service) => (owns(service) ? null : base.find(service)),
      use: async (id, purpose, fn) => {
        let catalog = false;
        try {
          catalog = !!(await ctx.connections?.ownsCredential?.(id));
        } catch {
          catalog = true;
        }
        if (catalog) throw new Error("this login belongs to a k-skill connection");
        return base.use(id, purpose, fn);
      },
    });
    const NO_CREDENTIALS: CredentialAccess = {
      find: async () => null,
      use: async () => {
        throw new Error("a connection tool gets its login as ctx.connection only");
      },
    };

    /**
     * Same context with a per-call signal; methods stay bound to the server's object (class-safe). Tools never get the
     * resolver. A `connection` tool's run() sees its own unsealed login as `ctx.connection`, and its side channels
     * (status lines, store writes) are redacted like its result; it gets no legacy credential access.
     */
    const toolCtx = (perCall: AbortSignal, conn?: ConnectionHandle): ToolContext => {
      const overrides = new Map<PropertyKey, unknown>([["signal", perCall]]);
      const hidden = new Set<PropertyKey>(["connections"]);
      if (conn) {
        const R = () => redactor(knownSecrets(conn));
        overrides.set("connection", conn);
        overrides.set("status", (t: string) => ctx.status(R().text(String(t ?? ""))));
        overrides.set("store", redactingCalls(ctx.store, R));
        overrides.set("credentials", NO_CREDENTIALS);
      } else {
        hidden.add("connection");
        if (ctx.credentials) overrides.set("credentials", scopedCredentials(ctx.credentials));
      }
      const read = (prop: PropertyKey): unknown => {
        if (overrides.has(prop)) return overrides.get(prop);
        const v: unknown = Reflect.get(ctx, prop, ctx);
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(ctx) : v;
      };
      // an empty stand-in target: answers never trip Proxy invariants, whatever the server's ctx is (sealed, frozen,
      // a class). `connection` is not enumerable, so JSON.stringify(ctx) / {...ctx} never carry the login.
      return new Proxy(Object.create(null) as ToolContext, {
        get: (_t, prop) => (hidden.has(prop) ? undefined : read(prop)),
        has: (_t, prop) => !hidden.has(prop) && (overrides.has(prop) || Reflect.has(ctx, prop)),
        ownKeys: () => [...new Set<string | symbol>([...Reflect.ownKeys(ctx), ...overrides.keys()].filter((k): k is string | symbol => typeof k !== "number" && !hidden.has(k)))],
        getOwnPropertyDescriptor(_t, prop) {
          if (hidden.has(prop)) return undefined;
          const own = Reflect.getOwnPropertyDescriptor(ctx, prop);
          if (!own && !overrides.has(prop)) return undefined;
          const enumerable = prop === "connection" ? false : (own?.enumerable ?? true);
          return { value: read(prop), writable: false, enumerable, configurable: true };
        },
        getPrototypeOf: () => Object.getPrototypeOf(ctx),
      });
    };

    /** Run `fn` with a per-call signal that fires on turn abort or after `ms` (ToolTimeoutError); rejects on either. */
    const guarded = async <T>(fn: (sig: AbortSignal) => Promise<T> | T, ms = toolTimeoutMs): Promise<T> => {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(new ToolTimeoutError(ms)), ms);
      const onTurnAbort = () => ctl.abort(abortError(signal));
      if (signal.aborted) onTurnAbort();
      else signal.addEventListener("abort", onTurnAbort, { once: true });
      try {
        return await Promise.race([
          Promise.resolve().then(() => fn(ctl.signal)),
          new Promise<never>((_, reject) => {
            if (ctl.signal.aborted) reject(ctl.signal.reason);
            else ctl.signal.addEventListener("abort", () => reject(ctl.signal.reason), { once: true });
          }),
        ]);
      } finally {
        clearTimeout(timer);
        signal.removeEventListener("abort", onTurnAbort);
      }
    };

    const isResult = (r: unknown): r is ToolResult => !!r && typeof r === "object" && typeof (r as ToolResult).ok === "boolean";
    const INVALID_RESULT: ToolResult = { ok: false, summary: "도구가 올바른 결과를 주지 않았어요" };

    /**
     * A call that threw or ran out of time. The chip line (`summary`) is fixed Korean: the timeout line, a MessengerError's
     * own sentence, or a generic line. The raw error text goes to the model only, in `data.detail`, scrubbed; `cut` false
     * leaves it whole for a caller that redacts first and truncates after.
     */
    const thrownResult = (err: unknown, cut = true): ToolResult => {
      const clip = (s: string) => (cut ? scrubSecrets(s).slice(0, 160) : scrubSecrets(s));
      if (signal.aborted) return { ok: false, summary: isTimeoutReason(signal.reason) ? TOOL_TIMEOUT_SUMMARY : TOOL_STOPPED_SUMMARY };
      if (err instanceof ToolTimeoutError) {
        return { ok: false, summary: TOOL_TIMEOUT_SUMMARY, data: { error: "timeout", seconds: Math.round(err.ms / 1000), detail: err.message, message: TOOL_TIMEOUT_NOTE } };
      }
      const known = userFacingError(err);
      if (known) return { ok: false, summary: clip(known.message), data: { error: known.code, message: clip(known.message) } };
      return { ok: false, summary: TOOL_ERROR_SUMMARY, data: { error: "tool_error", detail: clip(errorMessage(err)) } };
    };

    /**
     * run() for one call. A `connection` tool runs inside the resolver's `use` (vault-audited, wiped afterwards) with
     * `ctx.connection`; its result — thrown error text included — is redacted against the secret values before it
     * leaves the callback. No login / an expired one → a `needsConnection` result.
     */
    const runTool = async (p: Extract<ParsedCall, { ok: true }>, sig: AbortSignal): Promise<ToolResult> => {
      const service = p.def.connection;
      if (!service) return p.def.run(p.args, toolCtx(sig));
      const name = serviceNameOf(service);
      const resolver = ctx.connections;
      if (!resolver) return { ok: false, summary: `${name} 연결을 지금은 쓸 수 없어요` };
      try {
        return await resolver.use(service, { action: p.def.write ? "use" : "view", purpose: p.title }, async (conn) => {
          let r: ToolResult;
          let threw = false;
          try {
            const out = await p.def.run(p.args, toolCtx(sig, conn));
            r = isResult(out) ? out : INVALID_RESULT;
          } catch (err) {
            r = thrownResult(err, false); // whole: redacted below, then cut
            threw = true;
          }
          if (r.needsConnection) refusedWith.set(p.call.id, conn.credentialId);
          else refusedWith.delete(p.call.id);
          // redact first, truncate after: a cut must never leave a partial secret that no longer matches
          const red = redactResult(r, knownSecrets(conn));
          if (typeof red.summary === "string" && red.summary.length > 300) red.summary = red.summary.slice(0, 300);
          const d = threw ? (red.data as { detail?: unknown; message?: unknown } | undefined) : undefined;
          if (d && typeof d === "object") {
            if (typeof d.detail === "string" && d.detail.length > 160) d.detail = d.detail.slice(0, 160);
            if (typeof d.message === "string" && d.message.length > 300) d.message = d.message.slice(0, 300);
          }
          return red;
        });
      } catch (err) {
        const code = connectionErrorCode(err);
        if (!code) throw err;
        const reason = code === "expired" ? `${name} 연결 기간이 끝났어요. 다시 연결해 주세요.` : reasonFor(p, name);
        return { ok: false, summary: `${name} 연결 필요`, needsConnection: { service, serviceName: name, reason } };
      }
    };

    const attempt = async (p: Extract<ParsedCall, { ok: true }>): Promise<ToolResult> => {
      try {
        const r = await guarded((sig) => runTool(p, sig), deadlineOf(p.def));
        return isResult(r) ? r : INVALID_RESULT;
      } catch (err) {
        return thrownResult(err);
      }
    };

    /** the card's reason: the tool's own line (ToolDef.connectionReason) or one built from its title */
    const reasonFor = (p: ParsedCall, name: string): string => {
      const own = p.def?.connectionReason;
      return typeof own === "string" && own.trim() ? scrubSecrets(own.trim()).slice(0, 160) : connectionReason(p.title, name);
    };

    /** a tool's refusal, pinned to the tool's own service (a tool can't point the card or the wait elsewhere) */
    const needOf = (p: Extract<ParsedCall, { ok: true }>, n: ConnectionNeed): ConnectionNeed => {
      const service = p.def.connection!;
      const serviceName = serviceNameOf(service);
      const reason = typeof n.reason === "string" && n.reason.trim() ? scrubSecrets(n.reason.trim()).slice(0, 160) : reasonFor(p, serviceName);
      return { service, serviceName, reason };
    };

    /** tool chip → needs_credential, plus one pending `connection_request` card per service */
    const announceConnection = (p: ParsedCall, need: ConnectionNeed) => {
      const startedAt = activities.get(p.call.id)?.startedAt ?? Date.now();
      setActivity({ id: p.call.id, name: p.def?.name ?? p.call.function.name, title: p.title, state: "needs_credential", summary: `${need.serviceName} 연결 필요`, startedAt });
      if (cards.some((c) => c.type === "connection_request" && c.service === need.service && c.status === "pending")) return;
      addCard({
        type: "connection_request",
        service: need.service,
        serviceName: need.serviceName,
        title: `${need.serviceName} 연결이 필요해요`,
        reason: need.reason,
        status: "pending",
        action: { label: "연결하기", open: "connections" },
      });
    };

    /**
     * Wait (shared per service) for the owner to connect from the card: true once connected. Ends early on a steered
     * message; at most MAX_CONNECTION_WAITS per service per turn; never waits in voice mode or with wait 0. Throws on
     * turn abort.
     */
    const waitForConnection = async (need: ConnectionNeed, exclude?: string): Promise<boolean> => {
      const resolver = ctx.connections;
      if (!resolver || connectionWaitMs <= 0) return false;
      const key = exclude ? `${need.service}\u0000${exclude}` : need.service;
      let w = connectionWaits.get(key);
      if (!w) {
        const count = connectionWaitCount.get(need.service) ?? 0;
        if (count >= MAX_CONNECTION_WAITS) return false;
        connectionWaitCount.set(need.service, count + 1);
        w = (async () => {
          const ctl = new AbortController();
          const onTurnAbort = () => ctl.abort();
          if (signal.aborted) ctl.abort();
          else signal.addEventListener("abort", onTurnAbort, { once: true });
          const status = `${need.serviceName} 연결 기다리는 중`;
          safeEmit({ type: "status", text: status });
          const beat = setInterval(() => safeEmit({ type: "status", text: status }), CONNECTION_HEARTBEAT_MS);
          const steerPending = input.steerPending;
          const poll = steerPending
            ? setInterval(() => {
                try {
                  if (steerPending()) ctl.abort();
                } catch {
                  /* ignore */
                }
              }, STEER_POLL_MS)
            : null;
          // our own deadline too: a resolver that hangs (or ignores abort) must not hold the turn
          const deadline = setTimeout(() => ctl.abort(), connectionWaitMs + 2_000);
          const stopped = new Promise<boolean>((resolve) => ctl.signal.addEventListener("abort", () => resolve(false), { once: true }));
          try {
            return await Promise.race([resolver.waitFor(need.service, { timeoutMs: connectionWaitMs, signal: ctl.signal, ...(exclude ? { exclude } : {}) }), stopped]);
          } catch {
            return false;
          } finally {
            clearTimeout(deadline);
            clearInterval(beat);
            if (poll) clearInterval(poll);
            signal.removeEventListener("abort", onTurnAbort);
          }
        })();
        connectionWaits.set(key, w);
      }
      const ok = await w;
      if (signal.aborted) throw abortError(signal);
      if (ok) {
        // a later refusal in this turn may wait again (bounded by MAX_CONNECTION_WAITS)
        if (connectionWaits.get(key) === w) connectionWaits.delete(key);
        const i = cards.findIndex((c) => c.type === "connection_request" && c.service === need.service && c.status === "pending");
        const card = i >= 0 ? cards[i] : undefined;
        if (card && card.type === "connection_request") cards[i] = { ...card, status: "connected" };
      }
      return ok;
    };

    /** the model's view of a call that could not run for want of a login: never ask for secrets in chat */
    const needsConnectionContent = (p: ParsedCall, need: ConnectionNeed): string => {
      const now = Date.now();
      setActivity({
        id: p.call.id,
        name: p.def?.name ?? p.call.function.name,
        title: p.title,
        state: "needs_credential",
        summary: `${need.serviceName} 연결 필요`,
        startedAt: activities.get(p.call.id)?.startedAt ?? now,
        endedAt: now,
      });
      return errorContent("needs_connection", {
        service: need.service,
        serviceName: need.serviceName,
        message: `${need.serviceName} 계정이 연결되지 않아 실행하지 않았어요. 사용자에게 '연결하기' 카드를 보여줬어요. 비밀번호·키·인증번호를 채팅으로 묻지 말고, 카드에서 연결해 주시면 이어서 하겠다고 한 문장으로 답하세요.`,
      });
    };

    /** Run one approved/ungated call; never throws (but rethrows a turn abort while waiting for a connection). Emits running → done/error (+ card, memory). */
    const execute = async (p: Extract<ParsedCall, { ok: true }>, announce = true, noWait = false): Promise<string> => {
      const startedAt = activities.get(p.call.id)?.startedAt ?? Date.now();
      if (announce) {
        setActivity({ id: p.call.id, name: p.def.name, title: p.title, state: "running", startedAt });
        safeEmit({ type: "status", text: statusOf(p) });
      }
      if (deep) p = { ...p, args: deep.shape(p.def, p.args) }; // a deep-search card goes out cleaned and counted
      const held = deep?.hold(p.def, p.args) ?? null;
      let result = held ?? (await attempt(p));
      if (result.needsConnection && !p.def.connection) {
        // only a `connection` tool can ask for a login; anything else is a plain failure
        const { needsConnection: _drop, ...rest } = result;
        result = rest;
      }
      if (result.needsConnection) {
        // missing / refused / expired login: show the card, wait for the owner, retry once — never for a write tool,
        // which may have partly run, and whose approval named the old login: the owner asks again after reconnecting
        let need = needOf(p, result.needsConnection);
        announceConnection(p, need);
        const refused = refusedWith.get(p.call.id);
        refusedWith.delete(p.call.id);
        if (!p.def.write && !noWait && (await waitForConnection(need, refused))) {
          setActivity({ id: p.call.id, name: p.def.name, title: p.title, state: "running", startedAt });
          safeEmit({ type: "status", text: statusOf(p) });
          result = await attempt(p);
          refusedWith.delete(p.call.id);
          if (result.needsConnection) {
            need = needOf(p, result.needsConnection);
            announceConnection(p, need);
          }
        }
        if (result.needsConnection) return needsConnectionContent(p, need);
      }
      if (deep) result = deep.result(p.def, result);
      else if (result.ok && isGuide(result)) {
        guideFrom ??= p.def.name;
        stepGuides++;
      } else if (result.ok) madeBy.add(p.def.name);
      if (result.card) addCard(result.card);
      for (const c of result.moreCards ?? []) addCard(c);
      if (result.ok && result.memory) safeEmit({ type: "memory", text: result.memory });
      setActivity({ id: p.call.id, name: p.def.name, title: p.title, state: result.ok ? "done" : "error", summary: result.summary, startedAt, endedAt: Date.now() });
      return toolResultContent(result, resultCap(p.def.maxResultBytes));
    };

    /**
     * The chip line of a credential()/approval()/login check that threw: its deadline, a MessengerError's own sentence
     * (msg_send resolves the chat name in credential(), so a Slack rate_limited lands here), else the generic line.
     */
    const preconditionLine = (err: unknown): string => {
      if (err instanceof ToolTimeoutError) return TOOL_TIMEOUT_SUMMARY;
      const known = userFacingError(err);
      return known ? scrubSecrets(known.message).slice(0, 160) : "도구 호출 오류";
    };

    const failCall = (p: ParsedCall, error: string, summary: string): string => {
      const now = Date.now();
      setActivity({ id: p.call.id, name: p.def?.name ?? p.call.function.name, title: p.title, state: "error", summary, startedAt: activities.get(p.call.id)?.startedAt ?? now, endedAt: now });
      return errorContent(error);
    };

    /**
     * Process tool calls whose assistant message is already in the conversation. Returns a paused
     * outcome, or null when every call got a result (results are pushed in call order).
     */
    /** approval spec of a call; a `write` tool always asks (a default card when approval() gives none) */
    const approvalOf = (p: Extract<ParsedCall, { ok: true }>): ApprovalSpec | null => {
      const spec = p.def.approval ? p.def.approval(p.args, toolCtx(signal)) : null;
      if (spec) return spec;
      if (!p.def.write) return null;
      const where = p.def.connection ? `${serviceNameOf(p.def.connection)} 계정으로 실제로 실행돼요.` : "확인하면 바로 실행돼요.";
      return { title: `${p.title} — 진행할까요?`, detail: where };
    };

    const runCalls = async (calls: LlmToolCall[]): Promise<TurnOutcome | null> => {
      const parsed = calls.map(parseCall);
      if (deep) for (const p of parsed) deep.call(p.def, p.call.function.name, p.ok ? p.args : undefined);
      type Gate =
        | { kind: "none" }
        | { kind: "credential"; need: CredentialNeed }
        | { kind: "connection"; need: ConnectionNeed }
        | { kind: "approval"; spec: ApprovalSpec }
        | { kind: "error"; error: string; summary?: string };
      const gates: Gate[] = [];
      for (const p of parsed) {
        if (!p.ok) {
          gates.push({ kind: "error", error: p.error });
          continue;
        }
        try {
          const def = p.def;
          const need = def.credential ? await guarded((sig) => def.credential!(p.args, toolCtx(sig))) : null;
          if (need) {
            gates.push({ kind: "credential", need });
            continue;
          }
          if (def.connection !== undefined) {
            const service = def.connection;
            const resolver = ctx.connections;
            if (typeof service !== "string" || !CONNECTION_SERVICE_RE.test(service)) {
              gates.push({ kind: "error", error: `tool "${def.name}" declares an invalid connection id` });
              continue;
            }
            if (!resolver) {
              gates.push({ kind: "error", error: `${serviceNameOf(service)} connections are not available on this server` });
              continue;
            }
            const found = await guarded(() => resolver.find(service));
            if (!found) {
              const name = serviceNameOf(service);
              gates.push({ kind: "connection", need: { service, serviceName: name, reason: reasonFor(p, name) } });
              continue;
            }
          }
          const spec = approvalOf(p);
          gates.push(spec ? { kind: "approval", spec } : { kind: "none" });
        } catch (err) {
          if (signal.aborted) throw abortError(signal);
          gates.push({ kind: "error", error: scrubSecrets(`precondition check failed: ${errorMessage(err)}`), summary: preconditionLine(err) });
        }
      }
      if (signal.aborted) throw abortError(signal);

      const results = new Map<string, string>();
      const credIdx = gates.findIndex((g) => g.kind === "credential");

      // announce ungated runnable calls first (stable order), then run them in parallel
      const runnable: Extract<ParsedCall, { ok: true }>[] = [];
      parsed.forEach((p, i) => {
        const g = gates[i]!;
        if (g.kind === "error") results.set(p.call.id, failCall(p, g.error, g.summary ?? "도구 호출 오류"));
        else if (g.kind === "none" && p.ok) runnable.push(p);
      });
      for (const p of runnable) {
        setActivity({ id: p.call.id, name: p.def.name, title: p.title, state: "running", startedAt: Date.now() });
        safeEmit({ type: "status", text: statusOf(p) });
      }
      // calls without a login: card now, wait for the owner beside the running calls (a legacy login pause ends
      // this turn anyway, so then they just stay unexecuted)
      const waiting = credIdx >= 0 ? [] : parsed.flatMap((p, i) => (gates[i]!.kind === "connection" && p.ok ? [i] : []));
      for (const i of waiting) announceConnection(parsed[i]!, (gates[i] as Extract<Gate, { kind: "connection" }>).need);
      // an approval card in this batch is shown right away: its siblings don't wait for a login behind it
      const noWait = gates.some((g) => g.kind === "approval");
      await Promise.all([
        ...runnable.map(async (p) => void results.set(p.call.id, await execute(p, false, noWait))),
        ...waiting.map(async (i) => {
          const p = parsed[i] as Extract<ParsedCall, { ok: true }>;
          const need = (gates[i] as Extract<Gate, { kind: "connection" }>).need;
          if (noWait || !(await waitForConnection(need))) return void results.set(p.call.id, needsConnectionContent(p, need));
          // connected: gate again (a write still asks first), else run it now in this turn
          let spec: ApprovalSpec | null;
          try {
            spec = approvalOf(p);
          } catch (err) {
            return void results.set(p.call.id, failCall(p, scrubSecrets(`precondition check failed: ${errorMessage(err)}`), preconditionLine(err)));
          }
          if (spec) gates[i] = { kind: "approval", spec };
          else results.set(p.call.id, await execute(p));
        }),
      ]);
      if (signal.aborted) throw abortError(signal);
      const approvalIdx = credIdx >= 0 ? -1 : gates.findIndex((g) => g.kind === "approval");

      if (credIdx >= 0) {
        const p = parsed[credIdx]!;
        const need = (gates[credIdx] as Extract<Gate, { kind: "credential" }>).need;
        const now = Date.now();
        setActivity({ id: p.call.id, name: p.def?.name ?? p.call.function.name, title: p.title, state: "needs_credential", summary: `${need.serviceName} 로그인 필요`, startedAt: now });
        addCard({ type: "credential_request", service: need.service, serviceName: need.serviceName, reason: need.reason, fields: need.fields, status: "pending" });
        results.set(
          p.call.id,
          errorContent("credential_required", {
            service: need.service,
            message: `${need.serviceName} 로그인 정보가 저장되어 있지 않아 실행하지 않았어요. 사용자에게 저장 카드를 보여줬어요. 저장했다고 하면 다시 시도하세요. 답은 왜 로그인이 필요한지 한 문장만 써요(예: "카카오톡을 읽으려면 로그인이 한 번 필요해요."). 암호화나 "저도 볼 수 없어요" 같은 보안 안내는 카드에 이미 있으니 되풀이하지 않아요.`,
          }),
        );
        parsed.forEach((q, i) => {
          if (!results.has(q.call.id)) {
            const g = gates[i]!;
            results.set(q.call.id, failCall(q, g.kind === "credential" ? "credential_required" : "not_executed: waiting for a login first", "실행 보류"));
          }
        });
        for (const q of parsed) push({ role: "tool", tool_call_id: q.call.id, content: results.get(q.call.id)! });
        const closing = `${need.serviceName} 로그인 정보가 필요해요. 아래 카드에서 안전하게 저장해 주시면 바로 이어서 할게요.`;
        emitText(text && !text.endsWith("\n") ? `\n\n${closing}` : closing);
        push({ role: "assistant", content: closing });
        return outcome({ pendingCredential: need });
      }

      if (approvalIdx >= 0) {
        // answer everything that already ran; leave the approval call (and later gated calls) open
        for (const q of parsed) if (results.has(q.call.id)) push({ role: "tool", tool_call_id: q.call.id, content: results.get(q.call.id)! });
        const p = parsed[approvalIdx] as Extract<ParsedCall, { ok: true }>;
        const spec = (gates[approvalIdx] as Extract<Gate, { kind: "approval" }>).spec;
        setActivity({ id: p.call.id, name: p.def.name, title: p.title, state: "needs_approval", summary: "확인 필요", startedAt: Date.now() });
        addCard({
          type: "approval",
          approvalId: p.call.id,
          title: spec.title,
          detail: spec.detail,
          ...(typeof spec.amount === "number" ? { amount: spec.amount } : {}),
          ...(spec.call ? { call: spec.call } : {}),
          ...(spec.meet ? { meet: spec.meet } : {}),
          status: "pending",
        });
        safeEmit({ type: "status", text: "확인 기다리는 중" });
        if (!text.trim()) emitText("진행하기 전에 확인 부탁드려요.");
        const pending = [...produced];
        return { ...outcome({ pendingApproval: { call: p.call, spec, messages: pending } }), messages: [] };
      }

      for (const q of parsed) push({ role: "tool", tool_call_id: q.call.id, content: results.get(q.call.id)! });
      return null;
    };

    /**
     * One model call (streaming). Pushes the assistant message and returns its tool calls. `note` rides on this request
     * only (never stored); `preface` is said first, as part of this step's text (deep search in a call: 찾아볼게요).
     */
    /** `bare`: no tools in the request at all (the retry after a tool call written as text) */
    type StepPlan = { tools: boolean; choice?: "auto" | "required"; note?: string; preface?: string; only?: string; bare?: boolean; status?: string };
    let lastFinish = "";
    const step = async (plan: StepPlan): Promise<LlmToolCall[]> => {
      const withTools = plan.tools;
      lastFinish = "";
      // `only`: the one tool this step may call (deep search's card); a late card stays out of the search steps; a
      // '전부' turn offers what its search needs (deep.offer)
      const listed = plan.only
        ? [...offered, ...(rowsTool ? [rowsTool] : [])].filter((t) => t.name === plan.only)
        : deep?.cardLate
          ? offered.filter((t) => t.name !== deep.card?.name)
          : offered;
      const stepTools = deep ? deep.offer(listed) : listed;
      if (signal.aborted) throw abortError(signal);
      safeEmit({ type: "status", text: plan.status ?? THINKING_STATUS });
      const filter = new ThinkFilter();
      const markup = new ToolMarkupFilter();
      /** all the model said this step (kept in the conversation); `shown`: how much of it is on screen */
      let stepText = "";
      let shown = 0;
      // a deep search step that may call tools: words before a call are its plan (what it will read next), not the
      // answer, and the answer would open with work that is never reported; they wait, and go once the step ends
      // without a call or they read as the answer (a paragraph on, or long)
      let holding = !!deep && withTools;
      const show = () => {
        const d = stepText.slice(shown);
        if (!d) return;
        if (!shown && text && !text.endsWith("\n")) emitText("\n\n");
        shown = stepText.length;
        emitText(d);
      };
      const out = (raw: string, end = false) => {
        let d = markup.push(filter.push(raw));
        if (end) d += markup.flush();
        if (!stepText) d = d.replace(/^\s+/, "");
        if (!d) return;
        stepText += d;
        if (holding && (PARAGRAPH_ON.test(stepText.slice(shown)) || stepText.length - shown >= PLAN_HOLD_CHARS)) holding = false;
        if (!holding) show();
      };
      let calls: LlmToolCall[] = [];
      // transient (never persisted); a user-role note works with chat templates that only allow a leading system message
      const note = plan.note ?? (withTools ? null : FINAL_ANSWER_NOTE);
      const reqMessages = note ? [...convo, { role: "user" as const, content: note }] : convo;
      if (plan.preface) {
        out(plan.preface);
        show(); // said first, whatever comes after
      }
      for await (const chunk of llm.stream({
        messages: reqMessages,
        tools: stepTools.length && !plan.bare ? stepTools : undefined,
        toolChoice: withTools ? (plan.choice ?? "auto") : "none",
        maxTokens: deep ? Math.max(maxTokens, DEEP_MAX_TOKENS) : maxTokens,
        temperature: opts.temperature,
        signal,
      })) {
        if (chunk.type === "text") out(chunk.delta);
        else if (chunk.type === "tool_calls") calls = chunk.calls;
        else if (chunk.type === "tool_progress") safeEmit({ type: "status", text: titleOf(byName.get(chunk.name), chunk.args, "준비하는 중") });
        else if (chunk.type === "usage") usage = addUsage(usage, chunk.usage);
        else if (chunk.type === "finish") lastFinish = chunk.reason;
      }
      out(filter.flush(), true);
      if (!withTools) calls = [];
      if (!calls.length) show(); // no call: what it held back is the answer
      // de-duplicate ids within one response
      const ids = new Set<string>();
      calls = calls.map((c, i) => (ids.has(c.id) ? { ...c, id: `${c.id}_${i}` } : (ids.add(c.id), c)));
      if (calls.length) push({ role: "assistant", content: stepText || null, tool_calls: calls });
      else {
        if (!stepText.trim() && markup.leaked && markupRetry === "unused") {
          markupRetry = "now"; // nothing said, only a call in markup: drive() asks once more, in words
          return [];
        }
        if (!stepText.trim()) {
          const empty = deep?.emptyReply() ?? EMPTY_REPLY;
          if (text && !text.endsWith("\n")) emitText("\n\n");
          emitText(empty);
          stepText = empty;
        }
        push({ role: "assistant", content: stepText });
      }
      return calls;
    };

    /** deep turns: if a step sends nothing for 15 s (a long tool call being written), repeat the last status */
    const stepFed = async (plan: StepPlan): Promise<LlmToolCall[]> => {
      if (!deep) return step(plan);
      const quiet = deep.quietMs;
      const beat = setInterval(() => {
        if (Date.now() - lastEmitAt >= quiet) safeEmit({ type: "status", text: lastStatus });
      }, Math.max(10, Math.floor(quiet / 3)));
      try {
        return await step(plan);
      } finally {
        clearInterval(beat);
      }
    };

    const drive = async (): Promise<TurnOutcome> => {
      // ── start / resume ──
      if (input.resume) {
        const { call, decision, priorMessages } = input.resume;
        for (const m of priorMessages) push(m);
        let ai = lastAssistantWith(produced, call.id);
        if (ai < 0) {
          push({ role: "assistant", content: null, tool_calls: [call] });
          ai = produced.length - 1;
        }
        const owner = produced[ai] as Extract<LlmMessage, { role: "assistant" }>;
        const answered = new Set(produced.slice(ai + 1).flatMap((m) => (m.role === "tool" ? [m.tool_call_id] : [])));
        if (!answered.has(call.id)) {
          const p = parseCall(call);
          if (decision === "approve" && p.ok) {
            push({ role: "tool", tool_call_id: call.id, content: await execute(p) });
          } else if (decision === "approve") {
            push({ role: "tool", tool_call_id: call.id, content: failCall(p, p.ok ? "unexpected" : p.error, "도구 호출 오류") });
          } else {
            const now = Date.now();
            setActivity({ id: call.id, name: p.def?.name ?? call.function.name, title: p.title, state: "error", summary: "거절됨 — 실행하지 않았어요", startedAt: now, endedAt: now });
            push({
              role: "tool",
              tool_call_id: call.id,
              content: JSON.stringify({ ok: false, approved: false, error: "rejected_by_user", message: "사용자가 이 작업을 거절했어요. 다시 시도하지 말고, 알겠다고 짧게 답하세요." }),
            });
          }
          answered.add(call.id);
        }
        const rest = (owner.tool_calls ?? []).filter((c) => !answered.has(c.id));
        if (rest.length) {
          const paused = await runCalls(rest);
          if (paused) return paused;
        }
      } else if (input.userText != null && input.userText.trim()) {
        convo.push({ role: "user", content: input.userText });
      }
      injectSteering();

      // ── loop ──
      let steps = 0;
      let forcedRounds = 0;
      /** deep search's late card: 1 = the step after the answer, 2 = once more after a card that failed */
      let lateCard = 0;
      for (;;) {
        const now = Date.now();
        const forced = steps >= maxSteps || (!!deep && deep.spent(now));
        // '전부': a round-up seen and never opened has its first page read before the answer, outside the steps
        const lead = !lateCard && deep ? deep.leadStep(now, forced) : null;
        if (lateCard || lead) {
          /* not a search step: the answer is out, or a lead is read first */
        } else if (forced) forcedRounds++;
        else steps++;
        // deep search: tools are required until the minimum effort, then optional, then off once the budget is spent
        // (spent: one last step may still make the card, with only that tool)
        // a plain turn's last card step: the guide came, its tool made nothing yet, and it is still offered
        const guideCard =
          !deep && forced && guideCardStep && guideFrom !== null && !madeBy.has(guideFrom) && offered.some((t) => t.name === guideFrom);
        if (guideCard) guideCardStep = false;
        let plan: StepPlan = !deep
          ? guideCard
            ? { tools: true, only: guideFrom!, choice: "required", note: GUIDE_CARD_NOTE, status: CARD_STATUS }
            : { tools: !forced }
          : lateCard
            ? { tools: true, only: deep.cardStepTool(), choice: "required", note: deep.note(now, "card"), status: deep.cardStatus() }
            : lead
            ? { tools: true, only: lead.only, choice: "required", note: lead.note }
            : forced
            ? deep.takeCardStep()
              ? { tools: true, only: deep.cardStepTool(), ...(deep.cardRequired() ? { choice: "required" as const } : {}), note: deep.note(now, "final", true), status: CARD_STATUS }
              : { tools: false, note: deep.note(now, "final") }
            : {
                tools: true,
                // '전부' over a noun that is no place: the model may know the list; a search it begins is then required
                choice: deep.gateMet() || deep.openNow() ? "auto" : "required",
                note: deep.note(now, steps === 1 ? "start" : "progress"),
                ...(steps === 1 && input.mode === "voice" && !deep.openNow() ? { preface: `${VOICE_SEARCH_PREFACE} ` } : {}),
              };
        if (markupRetry === "pending") plan = { ...plan, ...(plan.tools ? {} : { bare: true }), note: [plan.note ?? (plan.tools ? "" : FINAL_ANSWER_NOTE), TOOL_MARKUP_NOTE].filter(Boolean).join("\n") };
        let calls: LlmToolCall[];
        try {
          calls = await stepFed(plan);
        } catch (err) {
          if (signal.aborted) throw err;
          if (lateCard) break; // the late card failed (the model, the network): the answer stands as it is
          if (guideCard) continue; // the plain turn's last card step failed: answer in words
          if (lead) continue; // the lead step failed (the model, the network): no card dropped, the line after the answer names the site
          if (deep && forced && plan.only && deep.dropCard()) continue; // the card before the answer failed: answer in words
          throw err;
        }
        if (markupRetry === "now") {
          // the step was only a tool call written as text (DeepSeek's DSML under tool_choice none): once more, in words
          markupRetry = "pending";
          if (lateCard) break; // the answer is out; a card that came as text is no card
          if (lead) {
            /* not counted */
          } else if (forced) forcedRounds--;
          else steps--;
          continue;
        }
        if (markupRetry === "pending") markupRetry = "used";
        if (!calls.length && lateCard) break; // no card came: the answer stands
        if (!calls.length && deep?.takeLateCard(text)) {
          lateCard = 1; // answered: now the whole list as a card
          continue;
        }
        if (!calls.length) {
          // a message steered in while the model was answering gets its own round (bounded when forced)
          if (forcedRounds < MAX_FORCED_ROUNDS && injectSteering()) continue;
          break;
        }
        stepGuides = 0;
        const paused = await runCalls(calls);
        if (paused) return paused;
        // a step that only fetched the design guide is not a search step: once per turn, it gives its step back
        if (!deep && !forced && guideStepFree && stepGuides === calls.length) {
          guideStepFree = false;
          steps--;
        }
        if (!lateCard && forced && plan.only && lastFinish === "length") deep?.cardWasCut(); // a card page cut short: again, smaller
        // the card step got the html design guide (the first in this turn): the same card step again, its chance kept
        if (deep?.tookGuide() && lateCard) continue;
        if (lateCard) {
          if (lastFinish === "length") deep?.cardWasCut();
          if (deep?.rowsPending()) continue; // more rows to come: the next page
          if (!deep?.cardOk() && lateCard < 2) {
            lateCard = 2; // the card failed (too big, no markup…): the model sees why, once more
            continue;
          }
          lateCard = 0;
          if (forcedRounds < MAX_FORCED_ROUNDS && injectSteering()) continue;
          break;
        }
        injectSteering();
      }
      // the run's record: a list's menu rows the card left out, by site (counts only)
      const menu = deep?.drawn()?.menu;
      if (menu) console.info(`[pickle/agent] card menu rows left out ${Object.entries(menu).map(([site, n]) => `${site}=${n}`).join(" ")}`);
      // a rows card after the answer: its count as the code counted it (the answer gives none), once
      const line = deep?.cardLine();
      if (line) {
        emitText(`${text && !text.endsWith("\n") ? "\n\n" : ""}${line}`);
        push({ role: "assistant", content: line });
      }
      return outcome();
    };

    try {
      return await drive();
    } catch (err) {
      throw withPartial(err, outcome());
    }
  };
}
