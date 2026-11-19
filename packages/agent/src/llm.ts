/**
 * OpenGateway (OpenAI-compatible) client: streaming SSE + non-streaming completions with tools.
 *
 * Security: this is the ONLY place that reads the API key. The key lives in a private field,
 * is never serialised, and is redacted from every error message.
 */
import type { JsonSchema, LlmMessage, LlmToolCall, ToolDef } from "./types";

export interface LlmConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
}

export const DEFAULT_MODEL = "deepseek/deepseek-v4.1-flash-ultrafast";
export const DEFAULT_BASE_URL = "https://apis.opengateway.ai/v1";

/** Reads OPENGATEWAY_* from env. Throws when the key is missing (never prints it). */
export function loadLlmConfig(env: Record<string, string | undefined> = process.env): LlmConfig {
  const apiKey = env.OPENGATEWAY_API_KEY?.trim();
  if (!apiKey) throw new Error("OPENGATEWAY_API_KEY is not set. Provide it via env only.");
  return {
    apiKey,
    baseUrl: (env.OPENGATEWAY_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, ""),
    model: env.OPENGATEWAY_MODEL?.trim() || DEFAULT_MODEL,
  };
}

/** "title" and "kind" of a tool call's arguments that are still streaming (complete strings only) */
export function progressArgs(partial: string): { title?: string; kind?: string } {
  const out: { title?: string; kind?: string } = {};
  for (const key of ["title", "kind"] as const) {
    const m = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(partial);
    if (!m) continue;
    try {
      out[key] = JSON.parse(`"${m[1]}"`) as string;
    } catch {}
  }
  return out;
}

export class UpstreamError extends Error {
  constructor(
    readonly status: number,
    detail: string,
  ) {
    super(`OpenGateway ${status}: ${detail}`);
    this.name = "UpstreamError";
  }
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** prompt tokens served from the provider's prefix cache (DeepSeek bills these at ~1/10) */
  cachedTokens?: number;
}

/** Cached prompt tokens cost about a tenth of fresh ones; the daily quota charges what the turn really costs. */
export function billableTokens(u: Partial<Usage> | null | undefined): number {
  if (!u) return 0;
  const total = Number(u.totalTokens) || 0;
  const cached = Math.min(Number(u.cachedTokens) || 0, Number(u.promptTokens) || 0);
  return Math.max(0, Math.round(total - cached * 0.9));
}

export interface LlmRequest {
  messages: LlmMessage[];
  tools?: ToolDef[];
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
  jsonMode?: boolean;
  /**
   * "none" keeps tools visible to the model but forbids calling them; "required" makes it call at least one (deep
   * search before its minimum effort). Default "auto" when tools are given.
   */
  toolChoice?: "auto" | "none" | "required";
  /** false → ask the provider to skip hidden reasoning (cheap/fast side calls). Default: provider default. */
  thinking?: boolean;
}

export type LlmChunk =
  | { type: "text"; delta: string }
  | { type: "reasoning"; delta: string }
  | { type: "tool_calls"; calls: LlmToolCall[] }
  /**
   * a tool call's arguments are still streaming (> 1 s so far; an html artifact's fragment): at most one a second.
   * `args` = its "title"/"kind" strings once they have arrived, for a status line.
   */
  | { type: "tool_progress"; name: string; chars: number; args: { title?: string; kind?: string } }
  | { type: "usage"; usage: Usage }
  | { type: "finish"; reason: string };

export interface LlmCompletion {
  content: string;
  toolCalls: LlmToolCall[];
  usage: Usage;
}

export interface LlmClientOptions {
  /** base delay before the single retry on 429/5xx (jitter is added). Default 600 ms. */
  retryDelayMs?: number;
  /** abort a stream when no bytes arrive for this long. Default 90 s. */
  idleTimeoutMs?: number;
  /** overall cap for one non-streaming request. Default 120 s. */
  requestTimeoutMs?: number;
}

/** OpenAI `tools` payload for a list of ToolDefs. */
export function toOpenAiTools(tools: ToolDef[]): { type: "function"; function: { name: string; description: string; parameters: JsonSchema } }[] {
  return tools.map((t) => ({
    type: "function" as const,
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

/** Approximate token count when the provider omits usage (≈ 2 chars per token for mixed Korean/English). */
export function estimateTokens(text: string): number {
  return Math.max(0, Math.ceil(text.length / 2));
}

type WireMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: LlmToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

/** Keep only fields the API accepts (drops e.g. reasoning_content that a caller may have attached). */
function toWire(messages: LlmMessage[]): WireMessage[] {
  return messages.map((m): WireMessage => {
    switch (m.role) {
      case "system":
      case "user":
        return { role: m.role, content: m.content };
      case "tool":
        return { role: "tool", tool_call_id: m.tool_call_id, content: m.content };
      case "assistant": {
        const calls = m.tool_calls?.length
          ? m.tool_calls.map((c) => ({ id: c.id, type: "function" as const, function: { name: c.function.name, arguments: c.function.arguments || "{}" } }))
          : undefined;
        return calls ? { role: "assistant", content: m.content ?? null, tool_calls: calls } : { role: "assistant", content: m.content ?? "" };
      }
    }
  });
}

function messageChars(messages: LlmMessage[]): number {
  let n = 0;
  for (const m of messages) {
    n += (m.content ?? "").length;
    if (m.role === "assistant" && m.tool_calls) for (const c of m.tool_calls) n += c.function.name.length + c.function.arguments.length;
  }
  return n;
}

const isRetryable = (status: number) => status === 429 || status >= 500;

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError(signal));
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(abortError(signal!));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

let callSeq = 0;
const genCallId = () => `call_${Date.now().toString(36)}${(++callSeq).toString(36)}${Math.random().toString(36).slice(2, 8)}`;

interface PartialCall {
  id: string;
  name: string;
  args: string;
}

interface DeltaToolCall {
  index?: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

interface WireUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number } | null;
  prompt_cache_hit_tokens?: number;
}

interface StreamPayload {
  choices?: { delta?: { content?: unknown; reasoning_content?: unknown; reasoning?: unknown; tool_calls?: DeltaToolCall[] }; finish_reason?: string | null; message?: CompletionMessage }[];
  usage?: WireUsage | null;
  error?: { message?: string; code?: unknown } | string;
}

interface CompletionMessage {
  content?: unknown;
  reasoning_content?: unknown;
  tool_calls?: { id?: string; type?: string; function?: { name?: string; arguments?: unknown } }[];
}

function toUsage(u: WireUsage | null | undefined): Usage | null {
  if (!u || typeof u.prompt_tokens !== "number") return null;
  const promptTokens = u.prompt_tokens;
  const completionTokens = typeof u.completion_tokens === "number" ? u.completion_tokens : 0;
  const cachedRaw = u.prompt_tokens_details?.cached_tokens ?? u.prompt_cache_hit_tokens;
  const usage: Usage = { promptTokens, completionTokens, totalTokens: typeof u.total_tokens === "number" ? u.total_tokens : promptTokens + completionTokens };
  if (typeof cachedRaw === "number" && cachedRaw > 0) usage.cachedTokens = Math.min(cachedRaw, promptTokens);
  return usage;
}

export class LlmClient {
  readonly model: string;
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #opts: Required<LlmClientOptions>;

  constructor(cfg: LlmConfig, opts: LlmClientOptions = {}) {
    if (!cfg.apiKey) throw new Error("LlmClient: apiKey is required");
    this.#apiKey = cfg.apiKey;
    this.#baseUrl = cfg.baseUrl.replace(/\/+$/, "");
    this.model = cfg.model;
    this.#opts = {
      retryDelayMs: opts.retryDelayMs ?? 600,
      idleTimeoutMs: opts.idleTimeoutMs ?? 90_000,
      requestTimeoutMs: opts.requestTimeoutMs ?? 120_000,
    };
  }

  /** Never expose the key through JSON or util.inspect. */
  toJSON(): { model: string; baseUrl: string } {
    return { model: this.model, baseUrl: this.#baseUrl };
  }
  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return `LlmClient { model: ${JSON.stringify(this.model)} }`;
  }

  /** Remove the key (and any bearer token echo) from text that may leave the process. */
  redact(text: string): string {
    let out = text.split(this.#apiKey).join("[redacted]");
    out = out.replace(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/g, "Bearer [redacted]");
    return out;
  }

  #body(req: LlmRequest, stream: boolean): string {
    const body: Record<string, unknown> = { model: this.model, messages: toWire(req.messages), stream };
    if (req.tools?.length) {
      body.tools = toOpenAiTools(req.tools);
      body.tool_choice = req.toolChoice ?? "auto";
    }
    if (req.maxTokens) body.max_tokens = req.maxTokens;
    if (typeof req.temperature === "number") body.temperature = req.temperature;
    if (req.jsonMode) body.response_format = { type: "json_object" };
    if (req.thinking === false) body.thinking = { type: "disabled" };
    if (stream) body.stream_options = { include_usage: true };
    return JSON.stringify(body);
  }

  /** POST with one retry on 429/5xx/network failure. Returns an ok Response or throws UpstreamError. */
  async #post(body: string, signal: AbortSignal): Promise<Response> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0) {
        const retryAfter = lastErr instanceof RetryableStatus ? lastErr.retryAfterMs : 0;
        const delay = Math.min(5_000, Math.max(retryAfter, this.#opts.retryDelayMs + Math.random() * this.#opts.retryDelayMs));
        await sleep(delay, signal);
      }
      let res: Response;
      try {
        res = await fetch(`${this.#baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "text/event-stream, application/json",
            Authorization: `Bearer ${this.#apiKey}`,
          },
          body,
          signal,
        });
      } catch (err) {
        if (signal.aborted) throw abortError(signal);
        lastErr = new UpstreamError(0, `network error: ${this.redact(err instanceof Error ? err.message : String(err)).slice(0, 200)}`);
        continue;
      }
      if (res.ok) return res;
      const raw = await res.text().catch(() => "");
      const detail = this.redact(raw).replace(/\s+/g, " ").slice(0, 300) || res.statusText || "request failed";
      if (isRetryable(res.status) && attempt === 0) {
        const ra = Number(res.headers.get("retry-after"));
        lastErr = new RetryableStatus(res.status, detail, Number.isFinite(ra) && ra > 0 ? ra * 1000 : 0);
        continue;
      }
      throw new UpstreamError(res.status, detail);
    }
    if (lastErr instanceof RetryableStatus) throw new UpstreamError(lastErr.status, lastErr.detail);
    throw lastErr instanceof UpstreamError ? lastErr : new UpstreamError(0, "request failed");
  }

  /** OpenAI-compatible SSE stream (handles `data:` with/without space, reasoning_content, tool_calls deltas, usage). */
  async *stream(req: LlmRequest): AsyncGenerator<LlmChunk, void, undefined> {
    const local = new AbortController();
    const signal = req.signal ? AbortSignal.any([req.signal, local.signal]) : local.signal;
    let idle: ReturnType<typeof setTimeout> | undefined;
    const armIdle = () => {
      if (idle) clearTimeout(idle);
      idle = setTimeout(() => local.abort(new UpstreamError(504, "stream idle timeout")), this.#opts.idleTimeoutMs);
    };
    const promptChars = messageChars(req.messages);
    let completionChars = 0;
    let usage: Usage | null = null;
    let finish = "stop";
    const calls = new Map<number, PartialCall>();
    const order: number[] = [];
    let progressAt = Date.now();

    const takeCalls = (): LlmToolCall[] =>
      order
        .map((i) => calls.get(i)!)
        .filter((c) => c.name)
        .map((c) => ({ id: c.id || genCallId(), type: "function" as const, function: { name: c.name, arguments: c.args } }));

    try {
      armIdle();
      const res = await this.#post(this.#body(req, true), signal);
      const ctype = res.headers.get("content-type") ?? "";
      if (!res.body || ctype.includes("application/json")) {
        // Some proxies ignore stream:true and answer with one JSON body.
        const json = (await res.json().catch(() => null)) as StreamPayload | null;
        const done = this.#parseCompletion(json, req.messages);
        if (done.reasoning) yield { type: "reasoning", delta: done.reasoning };
        if (done.content) yield { type: "text", delta: done.content };
        if (done.toolCalls.length) yield { type: "tool_calls", calls: done.toolCalls };
        yield { type: "usage", usage: done.usage };
        yield { type: "finish", reason: done.finish };
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let finished = false;
      while (!finished) {
        let chunk: Awaited<ReturnType<typeof reader.read>>;
        try {
          chunk = await reader.read();
        } catch (err) {
          if (signal.aborted) throw signal.reason instanceof UpstreamError ? signal.reason : abortError(signal);
          throw new UpstreamError(502, `stream broken: ${this.redact(err instanceof Error ? err.message : String(err)).slice(0, 200)}`);
        }
        if (chunk.done) break;
        armIdle();
        buf += decoder.decode(chunk.value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).replace(/\r$/, "");
          buf = buf.slice(nl + 1);
          if (!line.startsWith("data:")) continue; // comments (":"), event:, id:, blank lines
          const data = line.slice(5).replace(/^ /, "").trim();
          if (!data) continue;
          if (data === "[DONE]") {
            finished = true;
            break;
          }
          let payload: StreamPayload;
          try {
            payload = JSON.parse(data) as StreamPayload;
          } catch {
            continue; // tolerate keep-alive garbage
          }
          if (payload.error) {
            const msg = typeof payload.error === "string" ? payload.error : (payload.error.message ?? "upstream error");
            throw new UpstreamError(502, this.redact(msg).slice(0, 300));
          }
          const u = toUsage(payload.usage);
          if (u) usage = u;
          for (const choice of payload.choices ?? []) {
            const d = choice.delta;
            if (d) {
              const reasoning = typeof d.reasoning_content === "string" ? d.reasoning_content : typeof d.reasoning === "string" ? d.reasoning : "";
              if (reasoning) {
                completionChars += reasoning.length;
                yield { type: "reasoning", delta: reasoning };
              }
              if (typeof d.content === "string" && d.content) {
                completionChars += d.content.length;
                yield { type: "text", delta: d.content };
              }
              for (const tc of d.tool_calls ?? []) {
                let idx: number;
                if (typeof tc.index === "number") idx = tc.index;
                else {
                  // no index: a new id (or a new name after complete args) starts a new call
                  const lastIdx = order.length ? order[order.length - 1]! : -1;
                  const last = lastIdx >= 0 ? calls.get(lastIdx) : undefined;
                  const startsNew = !last || (tc.id && last.id && tc.id !== last.id) || (!tc.id && tc.function?.name && last.name && last.args);
                  idx = startsNew ? Math.max(-1, ...order) + 1 : lastIdx;
                }
                let cur = calls.get(idx);
                if (!cur) {
                  cur = { id: "", name: "", args: "" };
                  calls.set(idx, cur);
                  order.push(idx);
                  progressAt = Date.now();
                }
                if (tc.id) cur.id = tc.id;
                if (tc.function?.name) cur.name += tc.function.name;
                if (typeof tc.function?.arguments === "string") {
                  cur.args += tc.function.arguments;
                  completionChars += tc.function.arguments.length;
                }
                // long arguments send nothing else for a while: say so, so the caller can show it (and its idle
                // watchdog sees the stream is alive)
                if (cur.name && tc.function?.arguments && Date.now() - progressAt >= 1000) {
                  progressAt = Date.now();
                  yield { type: "tool_progress", name: cur.name, chars: cur.args.length, args: progressArgs(cur.args) };
                }
              }
            }
            if (choice.finish_reason) finish = choice.finish_reason;
          }
        }
      }
      reader.cancel().catch(() => {});
      const toolCalls = takeCalls();
      if (toolCalls.length) yield { type: "tool_calls", calls: toolCalls };
      yield {
        type: "usage",
        usage: usage ?? {
          promptTokens: Math.ceil(promptChars / 2),
          completionTokens: Math.ceil(completionChars / 2),
          totalTokens: Math.ceil(promptChars / 2) + Math.ceil(completionChars / 2),
        },
      };
      yield { type: "finish", reason: toolCalls.length && finish === "stop" ? "tool_calls" : finish };
    } catch (err) {
      if (signal.aborted && signal.reason instanceof UpstreamError) throw signal.reason;
      throw err;
    } finally {
      if (idle) clearTimeout(idle);
      local.abort();
    }
  }

  #parseCompletion(json: StreamPayload | null, messages: LlmMessage[]): LlmCompletion & { reasoning: string; finish: string } {
    if (!json) throw new UpstreamError(502, "invalid JSON response");
    if (json.error) {
      const msg = typeof json.error === "string" ? json.error : (json.error.message ?? "upstream error");
      throw new UpstreamError(502, this.redact(msg).slice(0, 300));
    }
    const choice = json.choices?.[0];
    const msg = choice?.message;
    const content = typeof msg?.content === "string" ? msg.content : "";
    const reasoning = typeof msg?.reasoning_content === "string" ? msg.reasoning_content : "";
    const toolCalls: LlmToolCall[] = (msg?.tool_calls ?? [])
      .filter((c) => typeof c.function?.name === "string" && c.function.name)
      .map((c) => ({
        id: c.id || genCallId(),
        type: "function" as const,
        function: {
          name: c.function!.name!,
          arguments: typeof c.function!.arguments === "string" ? c.function!.arguments : JSON.stringify(c.function!.arguments ?? {}),
        },
      }));
    const prompt = Math.ceil(messageChars(messages) / 2);
    const completion = Math.ceil((content.length + reasoning.length + toolCalls.reduce((n, c) => n + c.function.arguments.length, 0)) / 2);
    const usage = toUsage(json.usage) ?? { promptTokens: prompt, completionTokens: completion, totalTokens: prompt + completion };
    return { content, reasoning, toolCalls, usage, finish: choice?.finish_reason ?? "stop" };
  }

  /** Non-streaming completion (memory extraction, titles). */
  async complete(req: LlmRequest): Promise<LlmCompletion> {
    const timeout = AbortSignal.timeout(this.#opts.requestTimeoutMs);
    const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout;
    try {
      const res = await this.#post(this.#body(req, false), signal);
      const json = (await res.json().catch(() => null)) as StreamPayload | null;
      const { content, toolCalls, usage } = this.#parseCompletion(json, req.messages);
      return { content, toolCalls, usage };
    } catch (err) {
      if (timeout.aborted && !req.signal?.aborted) throw new UpstreamError(504, "request timed out");
      throw err;
    }
  }
}

class RetryableStatus {
  constructor(
    readonly status: number,
    readonly detail: string,
    readonly retryAfterMs: number,
  ) {}
}
