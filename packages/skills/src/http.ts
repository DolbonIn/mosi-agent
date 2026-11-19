/**
 * HTTP layer for the hosted k-skill proxy.
 *
 * - shared token-bucket limiter (≤ 50 req/min across every tool; the proxy allows 60/min per client)
 * - in-memory TTL cache keyed by URL (5 min, successful responses only) + in-flight de-duplication
 * - per-request AbortSignal = caller signal (tool deadline / user cancel)
 * - one retry on transient 5xx and on the proxy's own short 429
 * - a per-route circuit breaker for deterministic upstream failures (quota exhausted, key rejected)
 *
 * Only the tool's own query parameters ever leave this module: no user id, thread id or name.
 */

export const DEFAULT_PROXY = "https://k-skill-proxy.nomadamas.org";
export const KSKILL_PROXY: string = (readEnv("KSKILL_PROXY_BASE_URL") || DEFAULT_PROXY).replace(/\/+$/, "");
export const USER_AGENT = "pickle-clone/0.2 (+k-skill client)";

export const TIMEOUT_MS = 12_000;
let timeoutMs = TIMEOUT_MS;
/** Override the per-tool deadline (tests). `null` restores 12 s. */
export function setTimeoutMs(ms: number | null): void {
  timeoutMs = ms ?? TIMEOUT_MS;
}
export const CACHE_TTL_MS = 5 * 60_000;
const CACHE_MAX_ENTRIES = 400;
const BREAKER_OPEN_MS = 10 * 60_000;
/** key rejected / service not approved / partner ban: these don't fix themselves within minutes */
const AUTH_BREAKER_MS = 60 * 60_000;
/** upstream quota or burst limit */
const QUOTA_BREAKER_MS = 2 * 60_000;

function readEnv(name: string): string | undefined {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  const v = env?.[name];
  return v && v.trim() ? v.trim() : undefined;
}

// ───────────────────────────── fetch injection ─────────────────────────────

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;
let fetchImpl: FetchLike | null = null;

/** Inject a fetch implementation (tests). `null` restores the global fetch. */
export function setFetch(fn: FetchLike | null): void {
  fetchImpl = fn;
}

/** The fetch every outbound call goes through (setFetch() swaps it in tests). */
export function doFetch(url: string, init: RequestInit): Promise<Response> {
  return fetchImpl ? fetchImpl(url, init) : fetch(url, init);
}

// ───────────────────────────── limiter ─────────────────────────────

/**
 * Token bucket: holds at most `burst` tokens, refilled continuously at `refillPerWindow` per `windowMs`.
 * Any window of `windowMs` therefore admits at most burst + refillPerWindow requests.
 */
export class TokenBucket {
  private tokens: number;
  private last: number;
  constructor(
    readonly burst: number,
    readonly refillPerWindow: number,
    readonly windowMs: number,
    private readonly clock: () => number = Date.now,
  ) {
    this.tokens = burst;
    this.last = clock();
  }

  private refill(): void {
    const now = this.clock();
    const elapsed = Math.max(0, now - this.last);
    this.last = now;
    this.tokens = Math.min(this.burst, this.tokens + (elapsed * this.refillPerWindow) / this.windowMs);
  }

  /** Take a token now if available. */
  tryTake(): boolean {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }

  /** Milliseconds until the next token is available (0 if one is available now). */
  waitMs(): number {
    this.refill();
    if (this.tokens >= 1) return 0;
    return Math.ceil(((1 - this.tokens) * this.windowMs) / this.refillPerWindow);
  }

  /** Wait (abortably) until a token can be taken. */
  async take(signal?: AbortSignal): Promise<void> {
    for (;;) {
      if (signal?.aborted) throw abortReason(signal);
      if (this.tryTake()) return;
      await sleep(Math.max(5, this.waitMs()), signal);
    }
  }

  available(): number {
    this.refill();
    return this.tokens;
  }
}

/** ≤ 50 requests in any 60 s window: burst 10 + 40/min refill (the proxy allows 60/min per client). */
export const LIMIT = { burst: 10, refillPerMinute: 40 };
let limiter = new TokenBucket(LIMIT.burst, LIMIT.refillPerMinute, 60_000);

// ───────────────────────────── cache ─────────────────────────────

export class TtlCache<V> {
  private map = new Map<string, { expires: number; value: V }>();
  constructor(
    readonly ttlMs: number,
    readonly maxEntries: number,
    private readonly clock: () => number = Date.now,
  ) {}

  get(key: string): V | undefined {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (hit.expires <= this.clock()) {
      this.map.delete(key);
      return undefined;
    }
    return hit.value;
  }

  set(key: string, value: V, ttlMs = this.ttlMs): void {
    this.map.delete(key);
    this.map.set(key, { expires: this.clock() + ttlMs, value });
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  get size(): number {
    return this.map.size;
  }

  clear(): void {
    this.map.clear();
  }
}

interface RawResponse {
  status: number;
  contentType: string;
  text: string;
}

let cache = new TtlCache<RawResponse>(CACHE_TTL_MS, CACHE_MAX_ENTRIES);
interface Flight {
  promise: Promise<RawResponse>;
  ctrl: AbortController;
  waiters: number;
}
const inflight = new Map<string, Flight>();
const breaker = new Map<string, { until: number; error: ProxyError }>();
let stats = { network: 0, cacheHits: 0 };
let clock: () => number = Date.now;

/** Reset limiter / cache / breaker (tests). */
export function resetHttpState(opts: { burst?: number; refillPerMinute?: number; clock?: () => number } = {}): void {
  limiter = new TokenBucket(opts.burst ?? LIMIT.burst, opts.refillPerMinute ?? LIMIT.refillPerMinute, 60_000, opts.clock ?? Date.now);
  cache = new TtlCache<RawResponse>(CACHE_TTL_MS, CACHE_MAX_ENTRIES, opts.clock ?? Date.now);
  inflight.clear();
  breaker.clear();
  clock = opts.clock ?? Date.now;
  stats = { network: 0, cacheHits: 0 };
}

export function httpStats(): { network: number; cacheHits: number; cached: number; tokens: number } {
  return { ...stats, cached: cache.size, tokens: limiter.available() };
}

// ───────────────────────────── errors ─────────────────────────────

export type ProxyErrorKind =
  | "timeout"
  | "aborted"
  | "network"
  | "rate_limited"
  | "bad_request"
  | "not_found"
  | "upstream"
  | "parse";

export interface ProxyError {
  kind: ProxyErrorKind;
  status: number;
  /** proxy error code, e.g. "upstream_error", "ambiguous_location" */
  code?: string;
  message: string;
  /** parsed JSON error body (never contains secrets: the proxy redacts upstream keys) */
  body?: Record<string, unknown>;
}

export type ProxyResult<T> =
  | { ok: true; status: number; body: T; cached: boolean }
  | { ok: false; error: ProxyError };

class TimeoutError extends Error {
  constructor() {
    super("timeout");
    this.name = "TimeoutError";
  }
}

function abortReason(signal: AbortSignal): Error {
  const r: unknown = signal.reason;
  if (r instanceof Error) return r;
  return new DOMException("aborted", "AbortError");
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortReason(signal));
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(abortReason(signal as AbortSignal));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * A deadline signal: aborts with a TimeoutError after `ms`, or when `parent` aborts.
 * `dispose()` clears the timer.
 */
export function deadline(parent: AbortSignal | undefined, ms = timeoutMs): { signal: AbortSignal; dispose(): void } {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(new TimeoutError()), ms);
  const onAbort = () => ctrl.abort(parent?.reason ?? new DOMException("aborted", "AbortError"));
  if (parent) {
    if (parent.aborted) onAbort();
    else parent.addEventListener("abort", onAbort, { once: true });
  }
  return {
    signal: ctrl.signal,
    dispose() {
      clearTimeout(t);
      parent?.removeEventListener("abort", onAbort);
    },
  };
}

function classifyThrown(e: unknown): ProxyError {
  if (e instanceof TimeoutError || (e instanceof Error && e.name === "TimeoutError")) {
    return { kind: "timeout", status: 0, message: "request timed out" };
  }
  if (e instanceof Error && e.name === "AbortError") {
    return { kind: "aborted", status: 0, message: "request aborted" };
  }
  return { kind: "network", status: 0, message: e instanceof Error ? e.message.slice(0, 200) : "network error" };
}

function tryJson(text: string): unknown {
  const t = text.trimStart();
  if (!t.startsWith("{") && !t.startsWith("[")) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function errorFromResponse(raw: RawResponse): ProxyError {
  const parsed = tryJson(raw.text);
  const body = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
  const code = typeof body?.error === "string" ? body.error : undefined;
  const message =
    (typeof body?.message === "string" && body.message) || raw.text.replace(/\s+/g, " ").trim().slice(0, 200) || `HTTP ${raw.status}`;
  const s = raw.status;
  const kind: ProxyErrorKind =
    s === 429 ? "rate_limited" : s === 400 ? "bad_request" : s === 404 ? "not_found" : s >= 500 ? "upstream" : "upstream";
  return { kind, status: s, code, message: message.slice(0, 300), body };
}

/** Deterministic upstream failures (quota exhausted, key rejected, partner ban): retrying won't help. */
export function isDeterministicUpstreamFailure(err: ProxyError): boolean {
  if (err.kind !== "upstream") return false;
  if (err.code === "upstream_forbidden" || err.code === "upstream_not_configured") return true;
  const upstream = err.body?.upstream as { status_code?: unknown } | undefined;
  const us = typeof upstream?.status_code === "number" ? upstream.status_code : null;
  if (us === 401 || us === 403 || us === 429) return true;
  return /\b(401|403)\b|Unauthorized|LIMITED_NUMBER|SERVICE_KEY|quota/i.test(err.message);
}

function shouldRetry(raw: RawResponse): boolean {
  if (raw.status < 500) return false;
  return !isDeterministicUpstreamFailure(errorFromResponse(raw));
}

// ───────────────────────────── request ─────────────────────────────

export type QueryValue = string | number | boolean | null | undefined;

export function buildUrl(path: string, params: Record<string, QueryValue> = {}): string {
  const url = new URL(KSKILL_PROXY + path);
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    url.searchParams.set(k, String(v));
  }
  return url.toString();
}

function routeKey(path: string): string {
  return path.split("?")[0] ?? path;
}

async function fetchOnce(url: string, signal: AbortSignal): Promise<RawResponse> {
  await limiter.take(signal);
  stats.network += 1;
  const res = await doFetch(url, {
    method: "GET",
    headers: { "user-agent": USER_AGENT, accept: "application/json, application/xml;q=0.9, */*;q=0.5" },
    signal,
  });
  const text = await res.text();
  return { status: res.status, contentType: res.headers.get("content-type") ?? "", text };
}

async function fetchWithRetry(url: string, signal: AbortSignal): Promise<RawResponse> {
  const first = await fetchOnce(url, signal);
  if (shouldRetry(first)) {
    await sleep(300, signal);
    return fetchOnce(url, signal);
  }
  if (first.status === 429) {
    const body = tryJson(first.text) as { retry_after_ms?: unknown } | undefined;
    const wait = typeof body?.retry_after_ms === "number" ? body.retry_after_ms : 1500;
    if (wait <= 2500) {
      await sleep(wait, signal);
      return fetchOnce(url, signal);
    }
  }
  return first;
}

/**
 * Join (or start) the shared request for `url`. The network request runs on its own AbortController that is
 * aborted only when every waiter has gone; each caller races the shared result against its own signal, so one
 * caller's cancel/deadline never fails another caller's identical request.
 */
function joinFlight(url: string, signal: AbortSignal): Promise<RawResponse> {
  let flight = inflight.get(url);
  if (!flight) {
    const ctrl = new AbortController();
    const created: Flight = { promise: fetchWithRetry(url, ctrl.signal), ctrl, waiters: 0 };
    const done = () => {
      if (inflight.get(url) === created) inflight.delete(url);
    };
    created.promise.then(done, done);
    inflight.set(url, created);
    flight = created;
  }
  const f = flight;
  f.waiters += 1;
  return new Promise<RawResponse>((resolve, reject) => {
    let settled = false;
    const leave = () => {
      if (settled) return false;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      f.waiters -= 1;
      return true;
    };
    const onAbort = () => {
      if (!leave()) return;
      if (f.waiters <= 0) {
        f.ctrl.abort(signal.reason);
        if (inflight.get(url) === f) inflight.delete(url);
      }
      reject(abortReason(signal));
    };
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    f.promise.then(
      (v) => {
        if (leave()) resolve(v);
      },
      (e: unknown) => {
        if (leave()) reject(e);
      },
    );
  });
}

export interface GetOptions {
  /** cache lifetime for this route (default 5 min); real-time feeds use less */
  ttlMs?: number;
  /**
   * narrows the circuit breaker below the route, for routes whose upstream fails per slice (e.g. KRX trade-info:
   * KOSPI rejected while KOSDAQ/KONEX answer) — a failure then closes only `route|scope`
   */
  breakerScope?: string;
}

/** How long a route stays closed after a deterministic upstream failure. */
export function breakerMs(err: ProxyError): number {
  const upstream = err.body?.upstream as { status_code?: unknown } | undefined;
  const us = upstream?.status_code;
  if (us === 429 || /LIMITED_NUMBER/i.test(err.message)) return QUOTA_BREAKER_MS;
  if (
    us === 401 ||
    us === 403 ||
    err.code === "upstream_forbidden" ||
    err.code === "upstream_not_configured" ||
    /\b(401|403)\b|Unauthorized|Forbidden|SERVICE_KEY/i.test(err.message)
  ) {
    return AUTH_BREAKER_MS;
  }
  return BREAKER_OPEN_MS;
}

/** GET a proxy route; returns the raw text on success. Never throws. */
export async function proxyGetText(
  path: string,
  params: Record<string, QueryValue>,
  signal: AbortSignal,
  opts: GetOptions = {},
): Promise<ProxyResult<string> & { contentType?: string }> {
  const url = buildUrl(path, params);
  const route = opts.breakerScope ? `${routeKey(path)}|${opts.breakerScope}` : routeKey(path);

  const hit = cache.get(url);
  if (hit) {
    stats.cacheHits += 1;
    return { ok: true, status: hit.status, body: hit.text, cached: true, contentType: hit.contentType };
  }

  const open = breaker.get(route);
  if (open && open.until > clock()) return { ok: false, error: open.error };

  let raw: RawResponse;
  try {
    raw = await joinFlight(url, signal);
  } catch (e) {
    return { ok: false, error: classifyThrown(e) };
  }

  if (raw.status >= 200 && raw.status < 300) {
    cache.set(url, raw, opts.ttlMs ?? CACHE_TTL_MS);
    return { ok: true, status: raw.status, body: raw.text, cached: false, contentType: raw.contentType };
  }
  const error = errorFromResponse(raw);
  if (isDeterministicUpstreamFailure(error)) breaker.set(route, { until: clock() + breakerMs(error), error });
  return { ok: false, error };
}

/** GET a JSON proxy route. Never throws. */
export async function proxyGet<T = unknown>(
  path: string,
  params: Record<string, QueryValue>,
  signal: AbortSignal,
  opts: GetOptions = {},
): Promise<ProxyResult<T>> {
  const r = await proxyGetText(path, params, signal, opts);
  if (!r.ok) return r;
  const parsed = tryJson(r.body);
  if (parsed === undefined) {
    return { ok: false, error: { kind: "parse", status: r.status, message: "proxy returned non-JSON" } };
  }
  return { ok: true, status: r.status, body: parsed as T, cached: r.cached };
}
