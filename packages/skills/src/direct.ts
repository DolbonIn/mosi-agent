/**
 * Direct HTTPS calls to an upstream with the owner's own login (toss, naver searchad, popbill, coupang partners,
 * RISS). Unlike proxyGet there is NO shared cache: responses are private to one owner. Each call is pinned to the
 * service's fixed origins, never follows redirects (a redirect could carry signed headers elsewhere), honours the
 * tool's deadline signal and a per-key local limiter, and never logs.
 */
import { createHash, createHmac } from "node:crypto";
import type { ConnectionVerifyResult } from "@pickle/agent";
import { doFetch, TokenBucket, USER_AGENT } from "./http";

export interface DirectResponse {
  status: number;
  headers: Headers;
  text: string;
}

export type DirectFailure = { kind: "timeout" | "aborted" | "network" | "rate_limited" | "bad_origin"; message: string };
export type DirectResult = { ok: true; res: DirectResponse } | { ok: false; error: DirectFailure };

export interface DirectLimit {
  /** one bucket per key, e.g. `coupang:${credentialId}` */
  key: string;
  burst: number;
  refill: number;
  windowMs: number;
}

const buckets = new Map<string, TokenBucket>();
let clock: () => number = Date.now;

/** tests: drop every bucket (and optionally fake the clock) */
export function resetDirectState(o: { clock?: () => number } = {}): void {
  buckets.clear();
  clock = o.clock ?? Date.now;
}

function bucketFor(l: DirectLimit): TokenBucket {
  let b = buckets.get(l.key);
  if (!b) {
    if (buckets.size > 2000) buckets.clear();
    b = new TokenBucket(l.burst, l.refill, l.windowMs, clock);
    buckets.set(l.key, b);
  }
  return b;
}

/** how long the local limiter would make this key wait (0: a call may go now) */
export function limiterWaitMs(l: DirectLimit): number {
  return bucketFor(l).waitMs();
}

export async function directRequest(o: {
  url: string;
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
  /** exact origins this service may call ("https://openapi.tossinvest.com") */
  origins: readonly string[];
  limit?: DirectLimit;
  signal: AbortSignal;
}): Promise<DirectResult> {
  let origin: string;
  try {
    origin = new URL(o.url).origin;
  } catch {
    return { ok: false, error: { kind: "bad_origin", message: "invalid url" } };
  }
  if (!o.origins.includes(origin)) return { ok: false, error: { kind: "bad_origin", message: `origin not allowed: ${origin}` } };
  if (o.limit) {
    const b = bucketFor(o.limit);
    // never park a turn for long: a dry bucket means "try again later"
    if (b.waitMs() > 3000) return { ok: false, error: { kind: "rate_limited", message: "local limit" } };
    try {
      await b.take(o.signal);
    } catch (e) {
      return { ok: false, error: classify(e) };
    }
  }
  try {
    const res = await doFetch(o.url, {
      method: o.method ?? "GET",
      headers: { "User-Agent": USER_AGENT, ...o.headers },
      body: o.body,
      redirect: "error",
      signal: o.signal,
    });
    const text = await res.text();
    return { ok: true, res: { status: res.status, headers: res.headers, text } };
  } catch (e) {
    return { ok: false, error: classify(e) };
  }
}

function classify(e: unknown): DirectFailure {
  const name = e instanceof Error ? e.name : "";
  if (name === "TimeoutError") return { kind: "timeout", message: "request timed out" };
  if (name === "AbortError") return { kind: "aborted", message: "request aborted" };
  // a fetch error message may echo the URL (and its query): keep only the error class
  return { kind: "network", message: name || "network error" };
}

export function parseJson(text: string): unknown {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return undefined;
  }
}

/** sleep that ends early on abort (a 429 Retry-After) */
export function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

// ───────────────────────────── signing helpers ─────────────────────────────

export const hmacSha256 = (key: string | Buffer, msg: string, enc: "base64" | "hex") => createHmac("sha256", key).update(msg, "utf8").digest(enc);
export const sha256Base64 = (msg: string) => createHash("sha256").update(msg, "utf8").digest("base64");
export const shortHash = (msg: string, len = 8) => createHash("sha256").update(msg, "utf8").digest("hex").slice(0, len);

// ───────────────────────────── upstream errors ─────────────────────────────

/**
 * What a connected service call can end in. `auth` means the login itself was refused (wrong key, revoked, not
 * approved): the tool clears the session and returns needsConnection. `message` is Korean, shown to the model, and
 * must never contain a secret value.
 */
export type UpstreamFailure = { kind: "auth" | "rate" | "input" | "upstream" | "timeout" | "network"; message: string; status?: number; code?: string };

/**
 * A connect-time check's result. A transient failure (timeout, 5xx, 429, network) says `retryable`, so the server keeps
 * the just-saved login and checks again later. A refused login or a bad value never does.
 */
export type VerifyResult = ConnectionVerifyResult | { ok: false; message: string; retryable: true };

export function verifyFailure(e: UpstreamFailure, refused: string): VerifyResult {
  if (e.kind === "auth") return { ok: false, message: refused };
  if (e.kind === "input") return { ok: false, message: e.message };
  return { ok: false, message: e.message, retryable: true };
}

/** limiter key for a connect-time check (no credential id yet): one bucket per key, never shared between people */
export const verifyKey = (value: string): string => `verify-${shortHash(value.trim(), 16)}`;

export function fromDirect(e: DirectFailure, label: string): UpstreamFailure {
  switch (e.kind) {
    case "timeout":
      return { kind: "timeout", message: `${label} 응답이 너무 늦어요` };
    case "aborted":
      return { kind: "timeout", message: `${label} 요청이 취소됐어요` };
    case "rate_limited":
      return { kind: "rate", message: `${label} 요청이 많아 잠시 후에 다시 할 수 있어요` };
    case "bad_origin":
      return { kind: "upstream", message: `${label} 주소가 허용 목록에 없어요` };
    default:
      return { kind: "network", message: `${label} 서버에 연결하지 못했어요` };
  }
}

/** a 10-digit business number shown as 123-45-67890 */
export function bizNo(v: string): string {
  const d = v.replace(/\D/g, "");
  return d.length === 10 ? `${d.slice(0, 3)}-${d.slice(3, 5)}-${d.slice(5)}` : v;
}

/** account-ish numbers in labels: only the last 4 */
export function last4(v: string): string {
  const d = String(v ?? "").replace(/\s/g, "");
  return d.length > 4 ? `•••• ${d.slice(-4)}` : "••••";
}
