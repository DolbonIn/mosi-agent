/**
 * Voice I/O around the TTS client (tts.ts):
 *  - `POST /api/tts` for the app's call screen (auth + per-user rate limit, audio/mpeg).
 *  - Public audio for Twilio `<Play>`: a SEPARATE minimal listener on 127.0.0.1:${PICKLE_AUDIO_PORT:-8789}
 *    that serves ONLY `GET /a/<32 hex>.mp3` for tokens registered in memory for 15 minutes; everything
 *    else is 404 (no listing, no API). It is reached from the internet through `PICKLE_PUBLIC_AUDIO_URL`
 *    or, when Twilio and TTS are configured, a Cloudflare quick tunnel (cloudflared). With a state dir (the server's
 *    PICKLE_DATA_DIR) the tunnel is KEPT across restarts: started detached, recorded in `audio-tunnel.json`, and reused
 *    by the next start (same URL, no new quick-tunnel request, which api.trycloudflare.com rate-limits per IP).
 * Never logs TTS text or phone numbers.
 */
import { closeSync, existsSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Core } from "./core.ts";
import { RateLimiter } from "./auth.ts";
import { bad, HttpError, readJson, type Ctx } from "./http.ts";
import type { Logger } from "./log.ts";
import { errInfo } from "./log.ts";
import { TTS_MAX_CHARS, TtsError, type Tts, type TtsStream } from "./tts.ts";

export const AUDIO_TOKEN_TTL_MS = 15 * 60_000;
export const DEFAULT_AUDIO_PORT = 8789;
const TOKEN_PATH = /^\/a\/([0-9a-f]{32})\.mp3$/;

/** token (32 random hex chars) → cached mp3 path, for 15 minutes */
export class AudioTokens {
  private map = new Map<string, { file: string; expires: number }>();
  constructor(
    private now: () => number = Date.now,
    private ttlMs = AUDIO_TOKEN_TTL_MS,
  ) {}

  register(file: string): string {
    this.sweep();
    const token = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("hex");
    this.map.set(token, { file, expires: this.now() + this.ttlMs });
    return token;
  }

  resolve(token: string): string | null {
    const e = this.map.get(token);
    if (!e) return null;
    if (e.expires <= this.now()) {
      this.map.delete(token);
      return null;
    }
    return e.file;
  }

  get size(): number {
    return this.map.size;
  }

  private sweep() {
    const now = this.now();
    for (const [k, v] of this.map) if (v.expires <= now) this.map.delete(k);
  }
}

/** The TTS client, the token registry and the current public base URL (null = Twilio can't fetch audio). */
export interface VoiceIo {
  tts: Tts | null;
  tokens: AudioTokens;
  publicBase(): string | null;
  setPublicBase(url: string | null): void;
}

export function createVoiceIo(tts: Tts | null, now: () => number = Date.now): VoiceIo {
  let base: string | null = null;
  return {
    tts,
    tokens: new AudioTokens(now),
    publicBase: () => base,
    setPublicBase(url) {
      base = url ? url.replace(/\/+$/, "") : null;
    },
  };
}

// ───────────────────────────── public audio listener ─────────────────────────────

const NOT_FOUND = () => new Response("not found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });

/** Serves only registered, unexpired tokens; anything else (paths, methods, query tricks) is 404. */
export function audioHandler(tokens: AudioTokens): (req: Request) => Promise<Response> {
  return async (req) => {
    if (req.method !== "GET" && req.method !== "HEAD") return NOT_FOUND();
    let path: string;
    try {
      path = new URL(req.url).pathname;
    } catch {
      return NOT_FOUND();
    }
    const m = TOKEN_PATH.exec(path);
    const file = m ? tokens.resolve(m[1]!) : null;
    if (!file) return NOT_FOUND();
    const f = Bun.file(file);
    if (!(await f.exists())) return NOT_FOUND();
    const headers = {
      "Content-Type": "audio/mpeg",
      "Content-Length": String(f.size),
      "Cache-Control": "private, max-age=900",
      "X-Content-Type-Options": "nosniff",
    };
    return new Response(req.method === "HEAD" ? null : f, { headers });
  };
}

export function startAudioServer(o: { tokens: AudioTokens; port: number; hostname?: string }) {
  return Bun.serve({
    hostname: o.hostname ?? "127.0.0.1",
    port: o.port,
    // Bun turns SO_REUSEPORT on with development:false: a second server on the same port then binds silently and
    // the kernel hands Twilio's fetch to whichever process it likes (its tokens aren't there → 404). Fail instead.
    reusePort: false,
    development: false,
    idleTimeout: 30,
    maxRequestBodySize: 1024,
    fetch: audioHandler(o.tokens),
    error: () => NOT_FOUND(),
  });
}

// ───────────────────────────── cloudflared quick tunnel ─────────────────────────────

/** `https://<words>.trycloudflare.com` from cloudflared's log output (never the api. host). */
export function parseTunnelUrl(text: string): string | null {
  const m = /https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com\b/i.exec(text);
  return m ? m[0].toLowerCase() : null;
}

export interface Tunnel {
  url: string;
  exited: Promise<number>;
  stop(): void;
  /** a kept tunnel (survives the server): its pid, whether this start reused it, and how to stop watching it */
  kept?: { pid: number; reused: boolean; release(): void };
}

export type TunnelFailure = "rate_limited" | "api_timeout" | "api_error" | "no_url" | "timeout" | "exited" | "spawn_failed";

/** A quick tunnel that did not come up, with the reason cloudflared gave (its output holds no secrets). */
export class TunnelError extends Error {
  constructor(
    readonly reason: TunnelFailure,
    readonly detail: string,
  ) {
    super(`cloudflared: ${reason}${detail ? ` (${detail})` : ""}`);
  }
}

/**
 * Why cloudflared gave up, from its output. Seen on a busy Mac: api.trycloudflare.com answers
 * `429 Too Many Requests` / `error code: 1015` (quick tunnels are rate limited per IP), or doesn't answer within
 * cloudflared's 15 s client timeout; both end in exit 1.
 */
export function tunnelFailure(output: string, fallback: TunnelFailure): { reason: TunnelFailure; detail: string } {
  const lines = output
    .split("\n")
    .map((l) => l.replace(/^\S*\d{4}-\d\d-\d\dT\S+\s+/, "").trim())
    .filter(Boolean);
  const last = (re: RegExp) => [...lines].reverse().find((l) => re.test(l)) ?? "";
  const clip = (l: string) => l.replace(/\s+/g, " ").slice(0, 160);
  if (/429 Too Many Requests|error code: 1015/i.test(output)) return { reason: "rate_limited", detail: clip(last(/429|1015/)) };
  if (/failed to request quick Tunnel/i.test(output) && /deadline exceeded|Client\.Timeout|timeout/i.test(output))
    return { reason: "api_timeout", detail: clip(last(/failed to request quick Tunnel/i)) };
  if (/quick Tunnel/i.test(last(/failed|ERR/i))) return { reason: "api_error", detail: clip(last(/failed|ERR/i)) };
  return { reason: fallback, detail: clip(last(/\bERR\b|failed|error/i)) };
}

/**
 * Spawns `cloudflared tunnel --no-autoupdate --url http://127.0.0.1:<port>` and resolves once the
 * quick-tunnel URL is known and a connection is registered (or 15 s after the URL, whichever first).
 * Its output is drained but never logged.
 */
export function startQuickTunnel(o: { port: number; bin: string; timeoutMs?: number }): Promise<Tunnel> {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([o.bin, "tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${o.port}`], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (err) {
    return Promise.reject(new TunnelError("spawn_failed", errInfo(err).slice(0, 160)));
  }
  const kill = () => {
    try {
      proc.kill();
    } catch {
      /* already gone */
    }
  };
  process.once("exit", kill);
  const exited = proc.exited.then((code) => {
    process.off("exit", kill);
    return code;
  });

  return new Promise<Tunnel>((resolve, reject) => {
    let url: string | null = null;
    let settled = false;
    let grace: ReturnType<typeof setTimeout> | null = null;
    /** both streams, last 8 KB: where the URL and, on failure, the reason come from */
    let output = "";
    const done = (fail: TunnelFailure | null, code?: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (grace) clearTimeout(grace);
      if (fail || !url) {
        kill();
        const f = tunnelFailure(output, fail ?? "no_url");
        reject(new TunnelError(f.reason, [code === undefined ? "" : `exit ${code}`, f.detail].filter(Boolean).join(": ")));
      } else resolve({ url, exited, stop: kill });
    };
    const deadline = setTimeout(() => done("timeout"), o.timeoutMs ?? 45_000);
    const watch = async (stream: ReadableStream<Uint8Array>) => {
      const dec = new TextDecoder();
      const reader = stream.getReader();
      try {
        for (;;) {
          const { done: eof, value: chunk } = await reader.read();
          if (eof) break;
          if (settled) continue; // keep draining so cloudflared never blocks on a full pipe
          output = (output + dec.decode(chunk, { stream: true })).slice(-8192);
          if (!url) {
            url = parseTunnelUrl(output);
            if (url) grace = setTimeout(() => done(null), 15_000);
          }
          if (url && /Registered tunnel connection/i.test(output)) done(null);
        }
      } catch {
        /* stream closed */
      }
    };
    const streams = [watch(proc.stdout as ReadableStream<Uint8Array>), watch(proc.stderr as ReadableStream<Uint8Array>)];
    // read what it printed before it exited, so the reason is in `output`
    void exited.then(async (code) => {
      await Promise.race([Promise.all(streams), Bun.sleep(500)]);
      done("exited", code);
    });
  });
}

// ── kept tunnel: survives server restarts (Option A) ──

export const TUNNEL_RECORD = "audio-tunnel.json";
export const TUNNEL_LOG = "audio-tunnel.log";

/** `<stateDir>/audio-tunnel.json`: the cloudflared a server of this data dir started and left running */
export interface TunnelRecord {
  pid: number;
  /** the audio listener port it points at */
  port: number;
  /** its metrics server (127.0.0.1), which answers GET /quicktunnel {"hostname"} and GET /ready */
  metrics: number;
  bin: string;
  args: string[];
  url: string | null;
  startedAt: number;
}

export function keptTunnelArgs(port: number, metrics: number): string[] {
  return ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${port}`, "--metrics", `127.0.0.1:${metrics}`];
}

export function readTunnelRecord(path: string): TunnelRecord | null {
  try {
    const r = JSON.parse(readFileSync(path, "utf8")) as Partial<TunnelRecord>;
    const int = (n: unknown) => typeof n === "number" && Number.isInteger(n) && n > 0;
    if (!int(r.pid) || !int(r.port) || !int(r.metrics) || typeof r.bin !== "string" || !Array.isArray(r.args) || !r.args.every((a) => typeof a === "string")) return null;
    return { pid: r.pid!, port: r.port!, metrics: r.metrics!, bin: r.bin, args: r.args, url: typeof r.url === "string" ? r.url : null, startedAt: Number(r.startedAt) || 0 };
  } catch {
    return null;
  }
}

function writeTunnelRecord(path: string, rec: TunnelRecord): void {
  writeFileSync(`${path}.tmp`, JSON.stringify(rec), { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}

/** removes the record only if it still describes `pid` (a newer start may have replaced it) */
function dropTunnelRecord(path: string, pid: number): void {
  if (readTunnelRecord(path)?.pid === pid) rmSync(path, { force: true });
}

/** true while `pid` exists (EPERM: it exists but isn't ours to signal) */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** `ps -o command=`: the process's command line, or null when it's gone */
export function processCommand(pid: number): string | null {
  const r = Bun.spawnSync(["ps", "-o", "command=", "-p", String(pid)], { stdout: "pipe", stderr: "ignore" });
  const cmd = r.stdout.toString().trim();
  return r.exitCode === 0 && cmd ? cmd : null;
}

/**
 * The process is still the cloudflared the record describes: the same binary with exactly the recorded arguments,
 * so on our port with our metrics address. A pid that was reused by anything else fails this and is never signalled.
 */
export function isRecordedTunnel(rec: TunnelRecord, cmd: string | null): boolean {
  if (!cmd || !rec.args.length) return false;
  const args = rec.args.join(" ");
  return cmd === `${rec.bin} ${args}` || (cmd.includes(rec.bin) && cmd.endsWith(` ${args}`));
}

async function metricsGet(metrics: number, path: string): Promise<{ status: number; body: unknown } | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${metrics}${path}`, { signal: AbortSignal.timeout(2_000) });
    return { status: res.status, body: await res.json().catch(() => null) };
  } catch {
    return null;
  }
}

/** the quick-tunnel URL from cloudflared's metrics server (`GET /quicktunnel` → {"hostname": "….trycloudflare.com"}) */
export async function quickTunnelUrl(metrics: number): Promise<string | null> {
  const h = ((await metricsGet(metrics, "/quicktunnel"))?.body as { hostname?: unknown } | null)?.hostname;
  return typeof h === "string" && /^[a-z0-9-]+\.trycloudflare\.com$/i.test(h) ? `https://${h.toLowerCase()}` : null;
}

function logTail(path: string): string {
  try {
    const size = statSync(path).size;
    const text = readFileSync(path, "utf8");
    return size > 8192 ? text.slice(-8192) : text;
  } catch {
    return "";
  }
}

/** a free 127.0.0.1 port for cloudflared's metrics server */
function freePort(): number {
  const l = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = l.port;
  l.stop(true);
  return port;
}

/** waits for the kept tunnel's URL (metrics, else its log) and a registered connection (or 15 s after the URL) */
async function awaitKeptTunnel(o: { metrics: number; logPath: string; alive: () => boolean; timeoutMs: number; stopped: () => boolean }): Promise<{ url: string } | { fail: TunnelFailure }> {
  const end = Date.now() + o.timeoutMs;
  let urlAt = 0;
  while (Date.now() < end) {
    if (o.stopped()) return { fail: "timeout" };
    if (!o.alive()) return { fail: "exited" };
    const log = logTail(o.logPath);
    const url = (await quickTunnelUrl(o.metrics)) ?? parseTunnelUrl(log);
    if (url) {
      urlAt ||= Date.now();
      if ((await metricsGet(o.metrics, "/ready"))?.status === 200 || /Registered tunnel connection/i.test(log) || Date.now() - urlAt > 15_000) return { url };
    }
    await Bun.sleep(250);
  }
  return { fail: "timeout" };
}

/** polls a process that isn't our child (a reused tunnel): resolves -1 once it's gone */
function watchPid(pid: number, everyMs: number): { exited: Promise<number>; cancel(): void } {
  let timer: ReturnType<typeof setInterval> | null = null;
  const exited = new Promise<number>((resolve) => {
    timer = setInterval(() => {
      if (pidAlive(pid)) return;
      if (timer) clearInterval(timer);
      resolve(-1);
    }, everyMs);
  });
  return { exited, cancel: () => timer && clearInterval(timer) };
}

const signal = (pid: number) => {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    /* already gone */
  }
};

/**
 * The kept tunnel for `port`: reuses the recorded cloudflared when it is alive, is exactly the command we recorded and
 * points at this port; otherwise starts a new one detached (its own session, output to `audio-tunnel.log`, so it
 * outlives this server) and records it. Signals only a process it can prove it started: a record whose pid is now
 * something else is dropped and that process left alone.
 */
export async function keptQuickTunnel(o: { stateDir: string; port: number; bin: string; log: Logger; timeoutMs?: number; pollMs?: number; stopped?: () => boolean }): Promise<Tunnel> {
  const recordPath = join(o.stateDir, TUNNEL_RECORD);
  const logPath = join(o.stateDir, TUNNEL_LOG);
  const timeoutMs = o.timeoutMs ?? 45_000;
  const stopped = o.stopped ?? (() => false);
  const rec = readTunnelRecord(recordPath);
  if (rec) {
    const alive = pidAlive(rec.pid);
    const ours = alive && rec.bin === o.bin && isRecordedTunnel(rec, processCommand(rec.pid));
    if (!alive) {
      rmSync(recordPath, { force: true });
      o.log.info("kept audio tunnel is gone; starting a new one", { pid: rec.pid });
    } else if (!ours) {
      rmSync(recordPath, { force: true });
      o.log.warn("audio tunnel record points at another process; left it alone", { pid: rec.pid });
    } else if (rec.port !== o.port) {
      signal(rec.pid);
      rmSync(recordPath, { force: true });
      o.log.info("stopped our kept audio tunnel for an old port", { pid: rec.pid, port: rec.port });
    } else {
      const r = await awaitKeptTunnel({ metrics: rec.metrics, logPath, alive: () => pidAlive(rec.pid), timeoutMs, stopped });
      if ("url" in r) {
        const w = watchPid(rec.pid, o.pollMs ?? 15_000);
        if (rec.url !== r.url) writeTunnelRecord(recordPath, { ...rec, url: r.url });
        o.log.info("audio tunnel reused", { pid: rec.pid, url: r.url, ageS: rec.startedAt ? Math.round((Date.now() - rec.startedAt) / 1000) : null });
        return {
          url: r.url,
          exited: w.exited,
          stop: () => (w.cancel(), signal(rec.pid)),
          kept: { pid: rec.pid, reused: true, release: w.cancel },
        };
      }
      if (stopped()) throw new TunnelError("timeout", "server stopping"); // leave the kept tunnel for the next start
      if (pidAlive(rec.pid)) signal(rec.pid);
      dropTunnelRecord(recordPath, rec.pid);
      o.log.warn("kept audio tunnel did not answer; starting a new one", { pid: rec.pid, reason: r.fail });
    }
  }

  const metrics = freePort();
  const args = keptTunnelArgs(o.port, metrics);
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    const fd = openSync(logPath, "w", 0o600);
    try {
      proc = Bun.spawn([o.bin, ...args], { stdin: "ignore", stdout: fd, stderr: fd, detached: true });
    } finally {
      closeSync(fd);
    }
  } catch (err) {
    throw new TunnelError("spawn_failed", errInfo(err).slice(0, 160));
  }
  proc.unref(); // never holds this server open; it is meant to outlive it
  let code: number | null = null;
  const exited = proc.exited.then((c) => (code = c));
  const pid = proc.pid;
  writeTunnelRecord(recordPath, { pid, port: o.port, metrics, bin: o.bin, args, url: null, startedAt: Date.now() });
  const r = await awaitKeptTunnel({ metrics, logPath, alive: () => code === null, timeoutMs, stopped });
  if ("fail" in r) {
    if (code === null) signal(pid);
    await Promise.race([exited, Bun.sleep(500)]);
    dropTunnelRecord(recordPath, pid);
    const f = tunnelFailure(logTail(logPath), r.fail);
    throw new TunnelError(f.reason, [code === null ? "" : `exit ${code}`, f.detail].filter(Boolean).join(": "));
  }
  writeTunnelRecord(recordPath, { pid, port: o.port, metrics, bin: o.bin, args, url: r.url, startedAt: Date.now() });
  return { url: r.url, exited, stop: () => signal(pid), kept: { pid, reused: false, release: () => {} } };
}

/** Next quick-tunnel attempt: 15 s doubling (60 s when rate limited), ±20 % so servers on one IP don't sync, ≤ 10 min. */
export function tunnelRetryMs(failures: number, reason: TunnelFailure, rand: () => number = Math.random): number {
  const base = reason === "rate_limited" ? 60_000 : 15_000;
  const ms = Math.min(600_000, base * 2 ** Math.max(0, Math.min(failures - 1, 10)));
  return Math.round(ms * (0.8 + 0.4 * rand()));
}

/**
 * A GET for a token that doesn't exist answered by OUR listener (404 "not found") = the public URL reaches it.
 * Cloudflare answers 502/530 while the tunnel isn't routed yet; DNS for a fresh name can take a few seconds.
 */
export async function publicAudioReachable(base: string, o: { tries?: number; gapMs?: number; fetch?: typeof fetch } = {}): Promise<{ ok: boolean; tries: number; last: string }> {
  const f = o.fetch ?? fetch;
  const tries = o.tries ?? 8;
  let last = "";
  for (let i = 1; i <= tries; i++) {
    try {
      const res = await f(`${base}/a/${"0".repeat(32)}.mp3`, { signal: AbortSignal.timeout(10_000), redirect: "manual" });
      const body = res.status === 404 ? await res.text() : (await res.body?.cancel(), "");
      if (res.status === 404 && body === "not found") return { ok: true, tries: i, last: "404 from the audio listener" };
      last = `HTTP ${res.status}`;
    } catch (err) {
      last = errInfo(err).slice(0, 120);
    }
    if (i < tries) await Bun.sleep(o.gapMs ?? 4_000);
  }
  return { ok: false, tries, last };
}

export interface PublicAudioOptions {
  env: Record<string, string | undefined>;
  twilio: boolean;
  log: Logger;
  /** tests: the wait before the next tunnel attempt */
  retryMs?: (failures: number, reason: TunnelFailure) => number;
  /** tests: skip or replace the reachability check */
  reachable?: ((base: string) => Promise<{ ok: boolean; tries: number; last: string }>) | null;
  /** the server's data dir: keep the tunnel across restarts (audio-tunnel.json / .log there). Without it the tunnel is
   *  this server's child and dies with it. */
  stateDir?: string;
  /** how often a reused tunnel (not our child) is checked for life; default 15 s */
  keepPollMs?: number;
}

/**
 * Starts the public audio listener and, if needed, a supervised quick tunnel (retried with backoff for as long as
 * the server runs, and restarted the same way if it dies). Non-blocking: the tunnel comes up in the background and
 * sets `voice.publicBase()`; until then calls use `<Say>`.
 * With the tunnel, a busy audio port (another server on this Mac) falls back to a free port: the tunnel points at
 * whatever port we got. With PICKLE_PUBLIC_AUDIO_URL the port is what the outside proxy expects, so it must be ours.
 * With `stateDir` and our configured port, the tunnel is kept (see keptQuickTunnel): stop() leaves it running for the
 * next start. On a fallback port it is this server's child as before, and the record is left untouched.
 */
export function startPublicAudio(voice: VoiceIo, o: PublicAudioOptions): { port: number | null; stop(): Promise<void> } {
  const { env, log } = o;
  if (!voice.tts) return { port: null, stop: async () => {} };
  const rawPort = Number(env.PICKLE_AUDIO_PORT ?? DEFAULT_AUDIO_PORT);
  const port = Number.isInteger(rawPort) && rawPort >= 0 && rawPort < 65536 ? rawPort : DEFAULT_AUDIO_PORT;
  const fixed = env.PICKLE_PUBLIC_AUDIO_URL?.trim();
  const wantTunnel = !fixed && o.twilio && env.PICKLE_AUDIO_TUNNEL !== "0" && env.NODE_ENV !== "test";
  let server: ReturnType<typeof startAudioServer>;
  try {
    server = startAudioServer({ tokens: voice.tokens, port });
  } catch (err) {
    if (!wantTunnel || port === 0) {
      log.warn("audio listener failed; calls use the basic voice", { port, err: errInfo(err) });
      return { port: null, stop: async () => {} };
    }
    try {
      server = startAudioServer({ tokens: voice.tokens, port: 0 });
    } catch (err2) {
      log.warn("audio listener failed; calls use the basic voice", { port, err: errInfo(err2) });
      return { port: null, stop: async () => {} };
    }
    log.warn("audio port in use (another server?); using a free port, the tunnel points there", { port, actual: server.port ?? null });
    const rec = o.stateDir ? readTunnelRecord(join(o.stateDir, TUNNEL_RECORD)) : null;
    if (rec && rec.port === port && pidAlive(rec.pid))
      log.warn("the kept audio tunnel points at that port, which another process holds now", { pid: rec.pid, port });
  }
  log.info("audio listener", { url: `http://127.0.0.1:${server.port}` });

  if (fixed) {
    if (/^https?:\/\/[^\s]+$/i.test(fixed)) {
      voice.setPublicBase(fixed);
      log.info("public audio ready", { url: fixed.replace(/\/+$/, ""), via: "env" });
    } else log.warn("PICKLE_PUBLIC_AUDIO_URL is not an http(s) URL; ignored");
  }
  let stopped = false;
  let tunnel: Tunnel | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  const bin = env.CLOUDFLARED_BIN?.trim() || (existsSync("/opt/homebrew/bin/cloudflared") ? "/opt/homebrew/bin/cloudflared" : "cloudflared");
  const retryMs = o.retryMs ?? tunnelRetryMs;
  const reachable = o.reachable === undefined ? publicAudioReachable : o.reachable;
  const keep = !!o.stateDir && port !== 0 && server.port === port;

  /** `failures` in a row so far (0 = first try) */
  const launch = async (failures: number) => {
    retry = null;
    if (stopped) return;
    const t0 = performance.now();
    try {
      const t = keep
        ? await keptQuickTunnel({ stateDir: o.stateDir!, port: server.port!, bin, log, pollMs: o.keepPollMs, stopped: () => stopped })
        : await startQuickTunnel({ port: server.port!, bin });
      if (stopped) return t.kept ? t.kept.release() : t.stop();
      tunnel = t;
      voice.setPublicBase(t.url);
      log.info("public audio ready", {
        url: t.url,
        via: "cloudflared",
        attempt: failures + 1,
        ms: Math.round(performance.now() - t0),
        ...(t.kept ? { kept: true, reused: t.kept.reused, pid: t.kept.pid } : {}),
      });
      if (reachable)
        void reachable(t.url).then((r) => {
          if (stopped || tunnel !== t) return;
          if (r.ok) log.info("public audio reachable", { url: t.url, tries: r.tries });
          else log.warn("public audio not reachable from here yet", { url: t.url, tries: r.tries, last: r.last });
        });
      void t.exited.then((code) => {
        if (stopped || tunnel !== t) return;
        tunnel = null;
        voice.setPublicBase(null);
        if (t.kept) dropTunnelRecord(join(o.stateDir!, TUNNEL_RECORD), t.kept.pid);
        const wait = retryMs(1, "exited");
        log.warn("audio tunnel exited; calls use the basic voice until it is back", { code, retryInS: Math.round(wait / 1000) });
        retry = setTimeout(() => void launch(1), wait);
      });
    } catch (err) {
      if (stopped) return;
      const reason: TunnelFailure = err instanceof TunnelError ? err.reason : "exited";
      const detail = err instanceof TunnelError ? err.detail : errInfo(err).slice(0, 160);
      const wait = retryMs(failures + 1, reason);
      log.warn("audio tunnel failed; calls use the basic voice until it is up", { attempt: failures + 1, reason, detail, retryInS: Math.round(wait / 1000) });
      retry = setTimeout(() => void launch(failures + 1), wait);
    }
  };
  if (wantTunnel) void launch(0);

  return {
    port: server.port ?? null,
    async stop() {
      stopped = true;
      if (retry) clearTimeout(retry);
      if (tunnel?.kept) {
        tunnel.kept.release();
        log.info("audio tunnel left running for the next start", { pid: tunnel.kept.pid, url: tunnel.url });
      } else tunnel?.stop();
      tunnel = null;
      voice.setPublicBase(null);
      server.stop(true);
    },
  };
}

// ───────────────────────────── POST /api/tts, /api/tts/stream ─────────────────────────────

export const TTS_RATE_PER_MINUTE = 30;
/** /api/tts/stream refuses (→ client uses /api/tts or Web Speech) when this many lines are already queued */
export const STREAM_MAX_QUEUE = 2;
const STREAM_FIRST_CHUNK_MS = 30_000;
const STREAM_IDLE_MS = 15_000;

/**
 * s16le mono at half the rate: a [1, 2, 1] / 4 low-pass then every second sample (44.1 kHz → 22.05 kHz).
 * Keeps the odd byte / odd sample and the previous sample across chunks, so any chunking gives the same output.
 */
export function halfRateS16le(): (chunk: Uint8Array) => Uint8Array {
  let carry = new Uint8Array(0);
  let prev = 0;
  return (chunk) => {
    let buf = chunk;
    if (carry.byteLength) {
      buf = new Uint8Array(carry.byteLength + chunk.byteLength);
      buf.set(carry);
      buf.set(chunk, carry.byteLength);
    }
    const pairs = buf.byteLength >> 2;
    const out = new Uint8Array(pairs * 2);
    const iv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const ov = new DataView(out.buffer);
    for (let i = 0; i < pairs; i++) {
      const a = iv.getInt16(i * 4, true);
      const b = iv.getInt16(i * 4 + 2, true);
      ov.setInt16(i * 2, (prev + 2 * a + b + 2) >> 2, true);
      prev = b;
    }
    carry = buf.slice(pairs * 4);
    return out;
  };
}

export function ttsRoutes(core: Core) {
  const limiter = new RateLimiter(TTS_RATE_PER_MINUTE, 60_000, core.now);
  const unavailable = () => new HttpError(503, "tts_unavailable", "지금은 모시 목소리를 만들 수 없어요");
  const tooLong = () => bad(`한 번에 ${TTS_MAX_CHARS}자까지 읽어 줄 수 있어요`, "text_too_long");

  /** shared by both endpoints: per-user rate limit (one budget), body validation, TTS on */
  const accept = async (c: Ctx, userId: string): Promise<{ text: string; tts: Tts }> => {
    if (!limiter.hit(userId)) {
      throw new HttpError(429, "rate_limited", "요청이 너무 많아요. 잠시 후 다시 시도해 주세요.", { "Retry-After": String(limiter.retryAfter(userId)) });
    }
    const body = await readJson(c.req);
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!text) throw bad("읽어 줄 문장이 비어 있어요", "empty_text");
    if (text.length > TTS_MAX_CHARS) throw tooLong();
    const tts = core.voice.tts;
    if (!tts) throw unavailable();
    try {
      c.server?.timeout?.(c.req, 180); // long lines take about real time (main idleTimeout is 120 s)
    } catch {
      /* older Bun */
    }
    return { text, tts };
  };
  const mapError = (c: Ctx, err: unknown, what: string): HttpError => {
    if (err instanceof TtsError && err.code === "empty_text") return bad("읽을 수 있는 글자가 없어요", "empty_text");
    if (err instanceof TtsError && err.code === "too_long") return tooLong();
    if (!c.req.signal.aborted) core.log.warn(what, { err: errInfo(err) });
    return unavailable();
  };

  return {
    speak: async (c: Ctx, userId: string): Promise<Response> => {
      const { text, tts } = await accept(c, userId);
      try {
        const r = await tts.synthesize(text, { signal: c.req.signal });
        const bytes = await Bun.file(r.file).bytes();
        return new Response(bytes, {
          headers: {
            "Content-Type": "audio/mpeg",
            "Content-Length": String(bytes.byteLength),
            "Cache-Control": "private, max-age=86400",
            "X-Audio-Duration": String(r.durationS),
          },
        });
      } catch (err) {
        throw mapError(c, err, "tts request failed");
      }
    },

    /**
     * Real-time voice: proxies the service's PCM as it decodes (pull-driven, nothing buffered), halved to
     * 22.05 kHz. The upstream request is cancelled when the client goes away.
     */
    stream: async (c: Ctx, userId: string): Promise<Response> => {
      const { text, tts } = await accept(c, userId);
      const h = await tts.health();
      if (!h?.ready || (h.queue ?? 0) >= STREAM_MAX_QUEUE) throw unavailable();
      const started = performance.now();
      let up: TtsStream;
      try {
        up = await tts.stream(text, { signal: c.req.signal });
      } catch (err) {
        throw mapError(c, err, "tts stream failed");
      }
      const half = up.sampleRate >= 32_000 && up.sampleRate % 2 === 0;
      const rate = half ? up.sampleRate / 2 : up.sampleRate;
      const convert = half ? halfRateS16le() : (b: Uint8Array) => b;
      const reader = up.body.getReader();
      let firstMs: number | null = null;
      let bytes = 0;
      let finished = false;
      const finish = (outcome: string) => {
        if (finished) return;
        finished = true;
        up.abort();
        reader.cancel().catch(() => {});
        core.log.info("tts stream", { chars: text.length, outcome, rate, firstMs, bytes, ms: Math.round(performance.now() - started) });
      };
      // the client hanging up aborts c.req.signal (and cancels the body); either way stop the upstream
      c.req.signal.addEventListener("abort", () => finish("client_gone"), { once: true });
      const body = new ReadableStream<Uint8Array>(
        {
          async pull(ctrl) {
            try {
              for (;;) {
                let timer: ReturnType<typeof setTimeout> | undefined;
                const stall = new Promise<"stall">((res) => (timer = setTimeout(() => res("stall"), firstMs === null ? STREAM_FIRST_CHUNK_MS : STREAM_IDLE_MS)));
                const r = await Promise.race([reader.read(), stall]).finally(() => clearTimeout(timer));
                if (r === "stall") {
                  finish("stalled");
                  ctrl.close();
                  return;
                }
                if (r.done) {
                  finish("done");
                  ctrl.close();
                  return;
                }
                const out = convert(r.value);
                if (!out.byteLength) continue;
                if (firstMs === null) firstMs = Math.round(performance.now() - started);
                bytes += out.byteLength;
                ctrl.enqueue(out);
                return;
              }
            } catch (err) {
              const gone = c.req.signal.aborted || finished;
              finish(gone ? "client_gone" : "upstream_error");
              if (!gone) core.log.warn("tts stream broke", { err: errInfo(err) });
              try {
                ctrl.close();
              } catch {
                /* already closed */
              }
            }
          },
          cancel() {
            finish("client_gone");
          },
        },
        { highWaterMark: 0 },
      );
      return new Response(body, {
        headers: {
          "Content-Type": `audio/L16; rate=${rate}; channels=1`,
          "X-Sample-Rate": String(rate),
          "X-Sample-Format": "s16le",
          "Cache-Control": "no-store",
        },
      });
    },
  };
}
