/** HTTP plumbing: JSON responses, typed errors, capped body reading, a tiny router, security headers. */
import { createHash } from "node:crypto";
import { HTML_FRAME_SCRIPT } from "@pickle/protocol";

export const JSON_LIMIT = 64 * 1024;

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly headers?: Record<string, string>,
  ) {
    super(message);
  }
}

export const bad = (message: string, code = "bad_request") => new HttpError(400, code, message);
export const notFound = (message = "찾을 수 없어요", code = "not_found") => new HttpError(404, code, message);
export const forbidden = (message = "권한이 없어요", code = "forbidden") => new HttpError(403, code, message);
export const unauthorized = () => new HttpError(401, "unauthorized", "다시 로그인해 주세요");

export function json(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers },
  });
}

export function errorResponse(err: HttpError): Response {
  return json({ error: err.code, message: err.message }, err.status, err.headers);
}

/** Reads the body with a hard byte cap (works with and without Content-Length). */
export async function readBodyCapped(req: Request, limit: number): Promise<Uint8Array> {
  const len = Number(req.headers.get("content-length") ?? "NaN");
  if (Number.isFinite(len) && len > limit) throw new HttpError(413, "payload_too_large", "요청이 너무 커요");
  if (!req.body) return new Uint8Array();
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      throw new HttpError(413, "payload_too_large", "요청이 너무 커요");
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

export async function readJson<T = Record<string, unknown>>(req: Request, limit = JSON_LIMIT): Promise<T> {
  const bytes = await readBodyCapped(req, limit);
  if (!bytes.byteLength) return {} as T;
  try {
    const v = JSON.parse(new TextDecoder().decode(bytes));
    if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error("not an object");
    return v as T;
  } catch {
    throw bad("JSON 형식이 올바르지 않아요", "invalid_json");
  }
}

// ───────────────────────────── router ─────────────────────────────

export interface ServerLike {
  requestIP?(req: Request): { address: string } | null;
  timeout?(req: Request, seconds: number): void;
}

export interface Ctx {
  req: Request;
  url: URL;
  params: Record<string, string>;
  ip: string;
  server: ServerLike | undefined;
}

export type Handler = (c: Ctx) => Promise<Response> | Response;

interface Route {
  method: string;
  re: RegExp;
  keys: string[];
  handler: Handler;
}

export class Router {
  private routes: Route[] = [];

  on(method: string, pattern: string, handler: Handler): this {
    const keys: string[] = [];
    const re = new RegExp(
      "^" +
        pattern.replace(/\/:([a-zA-Z]+)/g, (_m, k: string) => {
          keys.push(k);
          return "/([^/]+)";
        }) +
        "/?$",
    );
    this.routes.push({ method, re, keys, handler });
    return this;
  }

  /** 'none' = no route, 'method' = path exists but not with this method */
  match(method: string, path: string): { handler: Handler; params: Record<string, string> } | "none" | "method" {
    let pathMatched = false;
    for (const r of this.routes) {
      const m = r.re.exec(path);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== method && !(method === "HEAD" && r.method === "GET")) continue;
      const params: Record<string, string> = {};
      r.keys.forEach((k, i) => {
        try {
          params[k] = decodeURIComponent(m[i + 1]!);
        } catch {
          params[k] = m[i + 1]!;
        }
      });
      return { handler: r.handler, params };
    }
    return pathMatched ? "method" : "none";
  }
}

// ───────────────────────────── headers ─────────────────────────────

/**
 * An html artifact's frame (iframe srcdoc) inherits this policy, so its one inline script (HTML_FRAME_SCRIPT: height,
 * link taps) is allowed by hash, computed here from the string the app inlines. Nothing else inline runs.
 */
export const HTML_FRAME_SCRIPT_HASH = `'sha256-${createHash("sha256").update(HTML_FRAME_SCRIPT, "utf8").digest("base64")}'`;

export const CSP =
  `default-src 'self'; connect-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' ${HTML_FRAME_SCRIPT_HASH}; media-src 'self' blob:; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'`;

export const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Frame-Options": "DENY",
  "Permissions-Policy": "camera=(), geolocation=(self), microphone=(self)",
  "Content-Security-Policy": CSP,
  "Cross-Origin-Opener-Policy": "same-origin",
};

export const DEV_ORIGINS = new Set(["http://localhost:5173", "http://127.0.0.1:5173"]);

export function withHeaders(res: Response, extra: Record<string, string>): Response {
  let out = res;
  try {
    for (const [k, v] of Object.entries(extra)) if (!out.headers.has(k)) out.headers.set(k, v);
  } catch {
    // immutable headers (e.g. a proxied Response) → copy
    out = new Response(res.body, { status: res.status, statusText: res.statusText, headers: new Headers(res.headers) });
    for (const [k, v] of Object.entries(extra)) if (!out.headers.has(k)) out.headers.set(k, v);
  }
  return out;
}

export function corsHeaders(origin: string): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Max-Age": "600",
    // dev (Vite on :5173 is cross-origin): let the app read the audio/limit headers
    "Access-Control-Expose-Headers": "X-Sample-Rate, X-Sample-Format, X-Audio-Duration, Retry-After",
    Vary: "Origin",
  };
}

// ───────────────────────────── validation helpers ─────────────────────────────

export function str(v: unknown, field: string, opts: { min?: number; max: number; trim?: boolean }): string {
  if (typeof v !== "string") throw bad(`${field} 값이 필요해요`, "invalid_field");
  const s = opts.trim === false ? v : v.trim();
  if (s.length < (opts.min ?? 1)) throw bad(`${field} 값이 너무 짧아요`, "invalid_field");
  if (s.length > opts.max) throw bad(`${field} 값이 너무 길어요`, "invalid_field");
  return s;
}

export function optStr(v: unknown, field: string, max: number): string | undefined {
  if (v === undefined || v === null) return undefined;
  return str(v, field, { min: 0, max });
}
