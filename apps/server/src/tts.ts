/**
 * Client for the local Drama-3 TTS service (services/tts, http://127.0.0.1:8790 by default).
 * Synthesized lines are cached on disk as `${dataDir}/tts/<sha256(voice|direction|text)>.mp3`
 * (pruned oldest-first) and concurrent requests for the same line share one synthesis.
 * Never logs the text: only lengths, sizes and timings.
 */
import { mkdirSync, readdirSync, renameSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Logger } from "./log.ts";
import { errInfo } from "./log.ts";
import { sha256Hex } from "./util.ts";

export const TTS_MAX_CHARS = 600;
export const DEFAULT_TTS_URL = "http://127.0.0.1:8790";
const DEFAULT_VOICE = "pickle";

export interface TtsResult {
  /** cache key (sha256 hex) */
  id: string;
  /** absolute path of the cached mp3 */
  file: string;
  bytes: number;
  durationS: number;
}

export interface TtsOptions {
  voice?: string;
  /** acting cue, e.g. "밝고 차분하게" */
  direction?: string;
  /** stop waiting (the shared synthesis still finishes and is cached) */
  signal?: AbortSignal;
  /** how long this caller waits, overriding the length-scaled default (phone calls: 45 s) */
  waitMs?: number;
}

export interface TtsStreamOptions {
  voice?: string;
  direction?: string;
  signal?: AbortSignal;
  /** give up if the service hasn't answered (headers) by then; default 20 s */
  headersTimeoutMs?: number;
}

export interface TtsStream {
  sampleRate: number;
  body: ReadableStream<Uint8Array>;
  abort(): void;
}

/** GET /health of the service; `queue` = lines waiting or running (null if the service doesn't report it) */
export interface TtsHealth {
  ready: boolean;
  queue: number | null;
  busyMs: number | null;
}

export interface Tts {
  /** GET /health → ok && ready (2 s timeout); also refreshes `status()` */
  available(): Promise<boolean>;
  /** GET /health with queue depth (null when unreachable); also refreshes `status()` */
  health(timeoutMs?: number): Promise<TtsHealth | null>;
  /** the cached line, if this exact text/voice/direction was made before (no service call) */
  cachedLine(text: string, opts?: Pick<TtsOptions, "voice" | "direction">): TtsResult | null;
  synthesize(text: string, opts?: TtsOptions): Promise<TtsResult>;
  /**
   * POST /tts/stream: raw PCM (s16le mono at `sampleRate`) as the model decodes it. Not cached.
   * Resolves when the service answers; `signal` (or `abort()`) cancels the upstream request.
   */
  stream(text: string, opts?: TtsStreamOptions): Promise<TtsStream>;
  /** last known reachability: null = never probed */
  status(): boolean | null;
  /** ms timestamp of the last probe or synthesis outcome (0 = never) */
  checkedAt(): number;
}

/**
 * `code`: empty_text | too_long (bad input) · unavailable (off, down, loading) · timeout · failed.
 * Messages carry no text.
 */
export class TtsError extends Error {
  override name = "TtsError";
  constructor(
    readonly code: "empty_text" | "too_long" | "unavailable" | "timeout" | "failed",
    readonly status?: number,
  ) {
    super(`tts ${code}${status ? ` (${status})` : ""}`);
  }
}

/** `PICKLE_TTS_URL` → base URL, or null when "off"/invalid. Unset → the local default. */
export function ttsUrlFromEnv(raw: string | undefined): string | null {
  const v = raw?.trim();
  if (!v) return DEFAULT_TTS_URL;
  if (/^(off|0|false|none|disabled?)$/i.test(v)) return null;
  try {
    const u = new URL(v);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return v.replace(/\/+$/, "");
  } catch {
    return null;
  }
}

const TTS_HARD_TIMEOUT_MS = 180_000;

/** One caller's wait: ~20 s + 1.5 s per 10 chars, max 150 s (the service runs about real time, one line at a time). */
export function ttsTimeoutMs(chars: number): number {
  return Math.min(150_000, 20_000 + Math.ceil(chars / 10) * 1_500);
}

function raceSignal<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return p;
  if (signal.aborted) return Promise.reject(signal.reason ?? new DOMException("aborted", "AbortError"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new DOMException("aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

export interface CreateTtsOptions {
  log?: Logger;
  /** cache caps (oldest-first pruning) */
  maxFiles?: number;
  maxBytes?: number;
  now?: () => number;
  /** how long one caller waits (default ttsTimeoutMs) */
  timeoutMs?: (chars: number) => number;
}

export function createTts(cfg: { tts: { url: string } | null; dataDir: string }, opts: CreateTtsOptions = {}): Tts | null {
  if (!cfg.tts) return null;
  const base = cfg.tts.url.replace(/\/+$/, "");
  const dir = join(cfg.dataDir, "tts");
  const maxFiles = opts.maxFiles ?? 300;
  const maxBytes = opts.maxBytes ?? 150 * 1024 * 1024;
  const now = opts.now ?? Date.now;
  const log = opts.log;
  const waitMs = opts.timeoutMs ?? ttsTimeoutMs;
  const inflight = new Map<string, Promise<TtsResult>>();
  /** durations from X-Audio-Duration (cache hits after a restart fall back to the 64 kbps estimate) */
  const durations = new Map<string, number>();
  let reachable: boolean | null = null;
  let checked = 0;
  const mark = (ok: boolean) => {
    reachable = ok;
    checked = now();
  };

  const ensureDir = () => mkdirSync(dir, { recursive: true, mode: 0o700 });

  function prune(keep: string) {
    try {
      const files = readdirSync(dir)
        .filter((f) => f.endsWith(".mp3"))
        .map((f) => {
          const p = join(dir, f);
          try {
            const s = statSync(p);
            return { p, size: s.size, mtime: s.mtimeMs };
          } catch {
            return null;
          }
        })
        .filter((x): x is { p: string; size: number; mtime: number } => x !== null)
        .sort((a, b) => a.mtime - b.mtime);
      let total = files.reduce((n, f) => n + f.size, 0);
      let count = files.length;
      for (const f of files) {
        if (count <= maxFiles && total <= maxBytes) break;
        if (f.p === keep) continue;
        try {
          unlinkSync(f.p);
          total -= f.size;
          count--;
        } catch {
          /* raced with another prune */
        }
      }
    } catch (err) {
      log?.warn("tts cache prune failed", { err: errInfo(err) });
    }
  }

  async function health(timeoutMs = 1_500): Promise<TtsHealth | null> {
    try {
      const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(timeoutMs) });
      const h = (await res.json().catch(() => ({}))) as { ok?: boolean; ready?: boolean; queue?: unknown; busyMs?: unknown };
      const ready = res.ok && h.ok === true && h.ready === true;
      mark(ready);
      const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
      return { ready, queue: num(h.queue), busyMs: num(h.busyMs) };
    } catch {
      mark(false);
      return null;
    }
  }

  function keyOf(text: string, o: Pick<TtsOptions, "voice" | "direction">) {
    const voice = o.voice?.trim() || DEFAULT_VOICE;
    const direction = o.direction?.trim() || undefined;
    const key = sha256Hex(`${voice}|${direction ?? ""}|${text}`);
    return { key, file: join(dir, `${key}.mp3`), voice, direction };
  }

  function cached(key: string, file: string): TtsResult | null {
    try {
      const s = statSync(file);
      if (!s.isFile() || s.size === 0) return null;
      const t = new Date(now());
      try {
        utimesSync(file, t, t); // recently used lines are pruned last
      } catch {
        /* read-only is fine */
      }
      return { id: key, file, bytes: s.size, durationS: durations.get(key) ?? Math.round((s.size / 8000) * 100) / 100 };
    } catch {
      return null;
    }
  }

  /** a non-2xx answer from the service → TtsError (and reachability) */
  async function failure(res: Response): Promise<TtsError> {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    if (res.status === 503) {
      mark(false);
      return new TtsError("unavailable", 503);
    }
    mark(true);
    if (res.status === 413) return new TtsError("too_long", 413);
    if (res.status === 400 && body.error === "empty_text") return new TtsError("empty_text", 400);
    return new TtsError("failed", res.status);
  }

  async function generate(key: string, file: string, text: string, voice: string, direction: string | undefined): Promise<TtsResult> {
    const started = performance.now();
    let res: Response;
    try {
      // the service can't cancel a line once queued, so the shared request outlives a caller's timeout:
      // the line still lands in the cache and a retry joins it instead of queueing a second copy
      res = await fetch(`${base}/tts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, voice, format: "mp3", ...(direction ? { direction } : {}) }),
        signal: AbortSignal.timeout(TTS_HARD_TIMEOUT_MS),
      });
    } catch (err) {
      const timeout = err instanceof DOMException && err.name === "TimeoutError";
      if (!timeout) mark(false);
      throw new TtsError(timeout ? "timeout" : "unavailable");
    }
    if (!res.ok) throw await failure(res);
    let buf: Uint8Array;
    try {
      buf = new Uint8Array(await res.arrayBuffer());
    } catch {
      throw new TtsError("failed");
    }
    if (!buf.byteLength) throw new TtsError("failed");
    mark(true);
    ensureDir();
    const tmp = `${file}.tmp-${crypto.randomUUID().slice(0, 8)}`;
    writeFileSync(tmp, buf, { mode: 0o600 });
    renameSync(tmp, file);
    const dur = Number(res.headers.get("x-audio-duration"));
    const durationS = Number.isFinite(dur) && dur > 0 ? dur : Math.round((buf.byteLength / 8000) * 100) / 100;
    durations.set(key, durationS);
    if (durations.size > 2 * maxFiles) durations.delete(durations.keys().next().value!);
    prune(file);
    log?.info("tts synthesized", {
      chars: text.length,
      bytes: buf.byteLength,
      audioS: durationS,
      ms: Math.round(performance.now() - started),
      genMs: Number(res.headers.get("x-gen-ms")) || undefined,
    });
    return { id: key, file, bytes: buf.byteLength, durationS };
  }

  return {
    async available() {
      return (await health(2_000))?.ready === true;
    },

    health,

    cachedLine(raw, o = {}) {
      const text = String(raw ?? "").trim();
      if (!text || text.length > TTS_MAX_CHARS) return null;
      const k = keyOf(text, o);
      return cached(k.key, k.file);
    },

    status: () => reachable,
    checkedAt: () => checked,

    async stream(raw, o = {}) {
      const text = String(raw ?? "").trim();
      if (!text) throw new TtsError("empty_text");
      if (text.length > TTS_MAX_CHARS) throw new TtsError("too_long");
      const { voice, direction } = keyOf(text, o);
      const ac = new AbortController();
      const onAbort = () => ac.abort(o.signal?.reason);
      if (o.signal?.aborted) throw o.signal.reason ?? new DOMException("aborted", "AbortError");
      o.signal?.addEventListener("abort", onAbort, { once: true });
      const done = () => o.signal?.removeEventListener("abort", onAbort);
      const headersTimer = setTimeout(() => ac.abort(new DOMException("tts stream timeout", "TimeoutError")), o.headersTimeoutMs ?? 20_000);
      let res: Response;
      try {
        res = await fetch(`${base}/tts/stream`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text, voice, ...(direction ? { direction } : {}) }),
          signal: ac.signal,
        });
      } catch (err) {
        done();
        if (o.signal?.aborted) throw err;
        const timeout = ac.signal.reason instanceof DOMException && ac.signal.reason.name === "TimeoutError";
        if (!timeout) mark(false);
        throw new TtsError(timeout ? "timeout" : "unavailable");
      } finally {
        clearTimeout(headersTimer);
      }
      if (!res.ok || !res.body) {
        done();
        throw res.ok ? new TtsError("failed") : await failure(res);
      }
      mark(true);
      const rate = Number(res.headers.get("x-sample-rate"));
      return {
        sampleRate: Number.isInteger(rate) && rate >= 8000 && rate <= 192_000 ? rate : 44_100,
        body: res.body,
        abort: () => {
          done();
          ac.abort(new DOMException("aborted", "AbortError"));
        },
      };
    },

    async synthesize(raw, o = {}) {
      const text = String(raw ?? "").trim();
      if (!text) throw new TtsError("empty_text");
      if (text.length > TTS_MAX_CHARS) throw new TtsError("too_long");
      const { key, file, voice, direction } = keyOf(text, o);
      const hit = cached(key, file);
      if (hit) return hit;
      let p = inflight.get(key);
      if (!p) {
        p = generate(key, file, text, voice, direction).finally(() => inflight.delete(key));
        p.catch(() => {}); // every caller may have stopped waiting; never an unhandled rejection
        inflight.set(key, p);
      }
      const timeout = AbortSignal.timeout(o.waitMs ?? waitMs(text.length));
      try {
        return await raceSignal(p, o.signal ? AbortSignal.any([o.signal, timeout]) : timeout);
      } catch (err) {
        if (timeout.aborted && !o.signal?.aborted && !(err instanceof TtsError)) throw new TtsError("timeout");
        throw err;
      }
    },
  };
}
