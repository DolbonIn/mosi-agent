import type { ApiError as WireError } from "@pickle/protocol";

/**
 * HTTP client: bearer token, JSON in/out (FormData/Blob pass through), Korean user-facing errors, identical in-flight
 * GETs shared, a 15 s timeout (until the body is read for JSON; until headers for raw/streaming responses).
 * The token lives here (auth.ts re-exports the accessors) so this module imports nothing from the app.
 *
 * SERVER-CONTRACT: every error body is `{error, message}`; `message` is user-facing Korean and is shown AS-IS
 * (ApiError.message). The table below is only a fallback for bodies without one (network, proxies, timeouts).
 */

// ───────────────────────────── token ─────────────────────────────

const TOKEN_KEY = "pickle.token";
let memToken: string | null | undefined;

export function getToken(): string | null {
  if (memToken !== undefined) return memToken;
  try {
    memToken = typeof localStorage !== "undefined" ? localStorage.getItem(TOKEN_KEY) : null;
  } catch {
    memToken = null; // private mode: in-memory only
  }
  return memToken;
}

export function setToken(token: string): void {
  memToken = token;
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    /* private mode */
  }
}

export function clearToken(): void {
  memToken = null;
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* private mode */
  }
}

// ───────────────────────────── errors ─────────────────────────────

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  /** the parsed error body, when the server sent one (e.g. 400 bad_code → { attemptsLeft }) */
  readonly data?: Record<string, unknown>;
  constructor(status: number, code: string, message: string, data?: Record<string, unknown>) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    if (data) this.data = data;
  }
}

const CODE_MESSAGES: Record<string, string> = {
  network: "서버에 연결하지 못했어요. 네트워크를 확인해 주세요.",
  timeout: "응답이 늦어지고 있어요. 다시 시도해 주세요.",
  aborted: "요청을 멈췄어요.",
  unauthorized: "다시 로그인해 주세요.",
  forbidden: "이 작업을 할 수 있는 권한이 없어요.",
  not_found: "찾는 항목이 없어요.",
  conflict: "이미 처리 중인 요청이 있어요. 잠시 후 다시 시도해 주세요.",
  busy: "모시가 다른 일을 하고 있어요. 끝나면 다시 보내 주세요.",
  too_large: "보내려는 내용이 너무 커요. 줄여서 다시 보내 주세요.",
  message_too_long: "메시지는 4,000자까지 보낼 수 있어요.",
  payload_too_large: "보내려는 내용이 너무 커요. 줄여서 다시 보내 주세요.",
  file_too_large: "10MB보다 큰 파일은 올릴 수 없어요.",
  unsupported_type: "이 형식의 파일은 올릴 수 없어요.",
  invalid_envelope: "이 계정용으로 암호화된 정보가 아니에요.",
  approval_expired: "승인 시간이 지났어요.",
  already_decided: "이미 처리한 승인이에요.",
  rate_limited: "요청이 많아요. 잠시 후 다시 시도해 주세요.",
  quota_exceeded: "오늘 사용량을 모두 썼어요. 새벽 4시에 다시 채워져요.",
  invalid_credentials: "아이디나 비밀번호가 맞지 않아요.",
  handle_taken: "이미 쓰고 있는 아이디예요.",
  llm_missing: "AI 연결이 아직 설정되지 않았어요.",
  llm_not_configured: "AI 연결이 아직 설정되지 않았어요.",
  server: "서버에 문제가 생겼어요. 잠시 후 다시 시도해 주세요.",
  bad_response: "응답을 읽지 못했어요. 다시 시도해 주세요.",
};

const STATUS_CODES: Record<number, string> = {
  0: "network",
  401: "unauthorized",
  403: "forbidden",
  404: "not_found",
  408: "timeout",
  409: "conflict",
  413: "too_large",
  429: "rate_limited",
};

/** Korean, user-facing message for a status / machine code. */
export function koreanMessage(status: number, code?: string): string {
  if (code && CODE_MESSAGES[code]) return CODE_MESSAGES[code];
  const byStatus = STATUS_CODES[status];
  if (byStatus) return CODE_MESSAGES[byStatus];
  if (status >= 500) return status === 503 ? CODE_MESSAGES.llm_missing : CODE_MESSAGES.server;
  if (status >= 400) return "요청을 처리하지 못했어요. 입력을 확인해 주세요.";
  return CODE_MESSAGES.network;
}

export function toApiError(e: unknown): ApiError {
  if (e instanceof ApiError) return e;
  if (isAbortError(e)) return new ApiError(0, "aborted", CODE_MESSAGES.aborted);
  return new ApiError(0, "network", CODE_MESSAGES.network);
}

const isAbortError = (e: unknown) => typeof e === "object" && e !== null && (e as { name?: string }).name === "AbortError";

/** True when the caller cancelled (not a failure to show). */
export const isAborted = (e: unknown) => (e instanceof ApiError ? e.code === "aborted" : isAbortError(e));

async function errorFromResponse(res: Response): Promise<ApiError> {
  let wire: Partial<WireError> | null = null;
  try {
    wire = (await res.json()) as Partial<WireError>;
  } catch {
    wire = null;
  }
  const code = typeof wire?.error === "string" ? wire.error : STATUS_CODES[res.status] ?? (res.status >= 500 ? "server" : "request");
  // server messages are already Korean and user-facing; fall back to ours
  const message = typeof wire?.message === "string" && wire.message.trim() ? wire.message : koreanMessage(res.status, code);
  const data = wire && typeof wire === "object" && !Array.isArray(wire) ? (wire as Record<string, unknown>) : undefined;
  return new ApiError(res.status, code, message, data);
}

let unauthorizedHandler: (() => void) | null = null;
/** auth/store registers this: a 401 on an authed request clears the session. */
export function setUnauthorizedHandler(fn: (() => void) | null): void {
  unauthorizedHandler = fn;
}

// ───────────────────────────── requests ─────────────────────────────

export const API_BASE: string = ((import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env?.VITE_API_BASE ?? "").replace(/\/$/, "");

export type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

export interface ApiOptions {
  signal?: AbortSignal;
  /** ms; 0 disables. JSON: covers the body read. raw: covers until headers. */
  timeoutMs?: number;
  /** return the Response itself (still throws ApiError on non-OK) */
  raw?: boolean;
  headers?: Record<string, string>;
  /** send the bearer token (default true) */
  auth?: boolean;
}

interface Prepared {
  res: Response;
  done: () => void;
  timedOut: () => boolean;
}

async function send(method: Method, path: string, body: unknown, opts: ApiOptions): Promise<Prepared> {
  const ctrl = new AbortController();
  const outer = opts.signal;
  let timedOut = false;
  const onAbort = () => ctrl.abort();
  if (outer) {
    if (outer.aborted) ctrl.abort();
    else outer.addEventListener("abort", onAbort, { once: true });
  }
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const timer =
    timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          ctrl.abort();
        }, timeoutMs)
      : undefined;
  const done = () => {
    if (timer) clearTimeout(timer);
    outer?.removeEventListener("abort", onAbort);
  };

  const headers: Record<string, string> = { Accept: "application/json", ...opts.headers };
  const token = opts.auth === false ? null : getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload: BodyInit | undefined;
  if (body !== undefined && body !== null) {
    if (typeof FormData !== "undefined" && body instanceof FormData) payload = body;
    else if (typeof Blob !== "undefined" && body instanceof Blob) payload = body;
    else if (typeof body === "string") payload = body;
    else {
      payload = JSON.stringify(body);
      headers["Content-Type"] = "application/json";
    }
  }

  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, { method, headers, body: payload, signal: ctrl.signal, credentials: "same-origin" });
  } catch (e) {
    done();
    if (timedOut) throw new ApiError(408, "timeout", CODE_MESSAGES.timeout);
    throw toApiError(e);
  }
  if (!res.ok) {
    done();
    const err = await errorFromResponse(res);
    if (res.status === 401 && token) unauthorizedHandler?.();
    throw err;
  }
  return { res, done, timedOut: () => timedOut };
}

/** POST/GET returning the raw Response (non-OK still throws). The timeout stops when headers arrive. */
export async function apiRaw(method: Method, path: string, body?: unknown, opts: ApiOptions = {}): Promise<Response> {
  const { res, done } = await send(method, path, body, opts);
  done();
  return res;
}

const inflightGets = new Map<string, Promise<unknown>>();

// JSON requests in flight (streams and raw responses excluded): app/startup.ts holds optional background work (lazy
// screen prefetch, the three chunk) until the first screen's reads are in, so they never compete for the link
let inflight = 0;
const inflightSubs = new Set<() => void>();
const bumpInflight = (d: number) => {
  inflight += d;
  for (const fn of inflightSubs) fn();
};
export const apiInflight = () => inflight;
export function onApiInflight(fn: () => void): () => void {
  inflightSubs.add(fn);
  return () => inflightSubs.delete(fn);
}

/**
 * JSON request. Identical in-flight GETs (same path, no signal) share one promise.
 * 204 / empty body → undefined.
 */
export function api<T>(method: Method, path: string, body?: unknown, opts: ApiOptions = {}): Promise<T> {
  if (opts.raw) return apiRaw(method, path, body, opts) as unknown as Promise<T>;
  const shareable = method === "GET" && !opts.signal;
  const key = `${getToken() ?? ""}|${path}`;
  if (shareable) {
    const hit = inflightGets.get(key);
    if (hit) return hit as Promise<T>;
  }
  bumpInflight(1);
  const run = (async () => {
    const prepared = await send(method, path, body, opts);
    try {
      if (prepared.res.status === 204) return undefined as T;
      const text = await prepared.res.text();
      if (!text) return undefined as T;
      try {
        return JSON.parse(text) as T;
      } catch {
        throw new ApiError(prepared.res.status, "bad_response", CODE_MESSAGES.bad_response);
      }
    } catch (e) {
      if (prepared.timedOut()) throw new ApiError(408, "timeout", CODE_MESSAGES.timeout);
      throw toApiError(e);
    } finally {
      prepared.done();
    }
  })();
  run.then(
    () => bumpInflight(-1),
    () => bumpInflight(-1),
  );
  if (shareable) {
    inflightGets.set(key, run);
    run.then(
      () => inflightGets.delete(key),
      () => inflightGets.delete(key),
    );
  }
  return run;
}

export const apiGet = <T>(path: string, opts?: ApiOptions) => api<T>("GET", path, undefined, opts);
export const apiPost = <T>(path: string, body?: unknown, opts?: ApiOptions) => api<T>("POST", path, body, opts);
export const apiPatch = <T>(path: string, body?: unknown, opts?: ApiOptions) => api<T>("PATCH", path, body, opts);
export const apiDelete = <T = { ok: true }>(path: string, opts?: ApiOptions) => api<T>("DELETE", path, undefined, opts);

/**
 * URL for places that can't send headers (`<img src>`, PDFs, EventSource): the session token goes in `?token=`.
 * The server accepts it on /api/events, /api/blobs/:id and /api/attachments/:id/raw only.
 */
export function tokenUrl(path: string): string {
  const token = getToken();
  if (!token) return `${API_BASE}${path}`;
  return `${API_BASE}${path}${path.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`;
}

/** `?a=1&b=2` from defined values only. */
export function query(params: Record<string, string | number | boolean | undefined | null>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") sp.set(k, String(v));
  const s = sp.toString();
  return s ? `?${s}` : "";
}
