/**
 * Public audio for Twilio <Play>: the listener refuses a port another server holds (Bun's development:false turns
 * SO_REUSEPORT on), the quick tunnel says why it failed (cloudflared's own words), retries with backoff for as long
 * as the server runs, and comes up once cloudflared does. A fake cloudflared stands in for the real one.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AudioTokens,
  createVoiceIo,
  publicAudioReachable,
  startAudioServer,
  startPublicAudio,
  tunnelFailure,
  tunnelRetryMs,
  type TunnelFailure,
} from "../src/audio.ts";
import type { Logger, LogFields } from "../src/log.ts";
import type { Tts } from "../src/tts.ts";

const dirs: string[] = [];
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), "pickle-audio-tunnel-"));
  dirs.push(d);
  return d;
}

/** what cloudflared 2026.7.3 printed on this Mac when api.trycloudflare.com throttled it (then exit 1) */
const RATE_LIMITED = [
  "2026-11-11T18:20:01Z INF Requesting new quick Tunnel on trycloudflare.com...",
  '2026-11-11T18:20:02Z ERR Error unmarshaling QuickTunnel response: error code: 1015 error="invalid character \'e\' looking for beginning of value" status_code="429 Too Many Requests"',
  "failed to unmarshal quick Tunnel: invalid character 'e' looking for beginning of value",
].join("\n");
const API_TIMEOUT = [
  "2026-11-11T18:21:01Z INF Requesting new quick Tunnel on trycloudflare.com...",
  'failed to request quick Tunnel: Post "https://api.trycloudflare.com/tunnel": context deadline exceeded (Client.Timeout exceeded while awaiting headers)',
].join("\n");

/**
 * A fake cloudflared: run n prints the scripted failure and exits 1 for the first `failures` runs, then prints a
 * quick-tunnel URL + "Registered tunnel connection" and stays up. Records its argv per run.
 */
function fakeCloudflared(failures: number, failText: string): { bin: string; runs: () => string[] } {
  const d = scratch();
  const bin = join(d, "cloudflared");
  const fail = join(d, "fail.txt");
  writeFileSync(fail, failText + "\n");
  writeFileSync(
    bin,
    `#!/bin/sh
n=$(cat "${d}/n" 2>/dev/null || echo 0)
echo $((n+1)) > "${d}/n"
echo "$*" >> "${d}/argv"
if [ "$n" -lt ${failures} ]; then cat "${fail}" >&2; exit 1; fi
echo "INF |  https://fake-quick-words-${failures}.trycloudflare.com   |" >&2
echo "INF Registered tunnel connection connIndex=0 location=icn06 protocol=quic" >&2
exec sleep 60
`,
  );
  chmodSync(bin, 0o755);
  return { bin, runs: () => readFileSync(join(d, "argv"), "utf8").trim().split("\n").filter(Boolean) };
}

function recordingLog(): Logger & { lines: { level: string; event: string; fields?: LogFields }[] } {
  const lines: { level: string; event: string; fields?: LogFields }[] = [];
  return {
    lines,
    info: (event, fields) => void lines.push({ level: "info", event, fields }),
    warn: (event, fields) => void lines.push({ level: "warn", event, fields }),
    error: (event, fields) => void lines.push({ level: "error", event, fields }),
  } as Logger & { lines: typeof lines };
}

const fakeTts = {} as Tts;

async function until(cond: () => boolean, ms = 5_000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await Bun.sleep(20);
  }
}

describe("cloudflared failure reasons", () => {
  test("rate limit (429 / 1015), API timeout, other errors", () => {
    expect(tunnelFailure(RATE_LIMITED, "exited")).toMatchObject({ reason: "rate_limited" });
    expect(tunnelFailure(RATE_LIMITED, "exited").detail).toContain("429 Too Many Requests");
    expect(tunnelFailure(RATE_LIMITED, "exited").detail).not.toMatch(/^2026-/); // timestamps dropped
    expect(tunnelFailure(API_TIMEOUT, "exited")).toMatchObject({ reason: "api_timeout" });
    expect(tunnelFailure(API_TIMEOUT, "exited").detail).toContain("Client.Timeout");
    expect(tunnelFailure("ERR failed to request quick Tunnel: 500 Internal Server Error", "exited").reason).toBe("api_error");
    expect(tunnelFailure("INF Starting tunnel\nERR Connection terminated", "exited")).toEqual({ reason: "exited", detail: "ERR Connection terminated" });
    expect(tunnelFailure("", "timeout")).toEqual({ reason: "timeout", detail: "" });
    expect(tunnelFailure("x".repeat(500) + " ERR " + "y".repeat(500), "exited").detail.length).toBeLessThanOrEqual(160);
  });

  test("backoff doubles, waits longer when rate limited, is jittered and capped at 10 minutes", () => {
    const mid = () => 0.5; // no jitter
    expect([1, 2, 3, 4].map((n) => tunnelRetryMs(n, "exited", mid))).toEqual([15_000, 30_000, 60_000, 120_000]);
    expect([1, 2, 3].map((n) => tunnelRetryMs(n, "rate_limited", mid))).toEqual([60_000, 120_000, 240_000]);
    expect(tunnelRetryMs(50, "rate_limited", mid)).toBe(600_000);
    expect(tunnelRetryMs(1, "exited", () => 0)).toBe(12_000);
    expect(tunnelRetryMs(1, "exited", () => 1)).toBe(18_000);
  });
});

describe("public audio listener port", () => {
  test("a second listener on the same port fails instead of sharing it", () => {
    const a = startAudioServer({ tokens: new AudioTokens(), port: 0 });
    cleanups.push(() => void a.stop(true));
    expect(() => startAudioServer({ tokens: new AudioTokens(), port: a.port! })).toThrow();
  });

  test("with the tunnel, a busy port falls back to a free one and the tunnel points there", async () => {
    const holder = startAudioServer({ tokens: new AudioTokens(), port: 0 });
    cleanups.push(() => void holder.stop(true));
    const cf = fakeCloudflared(0, "");
    const log = recordingLog();
    const voice = createVoiceIo(fakeTts);
    const pa = startPublicAudio(voice, { env: { PICKLE_AUDIO_PORT: String(holder.port), CLOUDFLARED_BIN: cf.bin }, twilio: true, log, reachable: null });
    cleanups.push(() => pa.stop());
    expect(pa.port).not.toBe(holder.port);
    expect(log.lines.find((l) => l.event.startsWith("audio port in use"))?.fields).toEqual({ port: holder.port!, actual: pa.port });
    await until(() => voice.publicBase() !== null);
    expect(voice.publicBase()).toBe("https://fake-quick-words-0.trycloudflare.com");
    expect(cf.runs()[0]).toBe(`tunnel --no-autoupdate --url http://127.0.0.1:${pa.port}`);
  });

  test("with PICKLE_PUBLIC_AUDIO_URL the port must be ours: a busy port is an error, not a fallback", () => {
    const holder = startAudioServer({ tokens: new AudioTokens(), port: 0 });
    cleanups.push(() => void holder.stop(true));
    const log = recordingLog();
    const voice = createVoiceIo(fakeTts);
    const pa = startPublicAudio(voice, { env: { PICKLE_AUDIO_PORT: String(holder.port), PICKLE_PUBLIC_AUDIO_URL: "https://audio.example.test" }, twilio: true, log, reachable: null });
    expect(pa.port).toBeNull();
    expect(voice.publicBase()).toBeNull();
    expect(log.lines.some((l) => l.level === "warn" && l.event.startsWith("audio listener failed"))).toBe(true);
  });
});

describe("quick tunnel supervision", () => {
  test("rate limited twice: each failure logs why and when it retries, then the tunnel comes up", async () => {
    const cf = fakeCloudflared(2, RATE_LIMITED);
    const log = recordingLog();
    const voice = createVoiceIo(fakeTts);
    const waits: [number, TunnelFailure][] = [];
    const pa = startPublicAudio(voice, {
      env: { PICKLE_AUDIO_PORT: "0", CLOUDFLARED_BIN: cf.bin },
      twilio: true,
      log,
      retryMs: (n, reason) => (waits.push([n, reason]), 30),
      reachable: async () => ({ ok: true, tries: 1, last: "404 from the audio listener" }),
    });
    cleanups.push(() => pa.stop());
    await until(() => log.lines.some((l) => l.event === "public audio reachable"));
    expect(voice.publicBase()).toBe("https://fake-quick-words-2.trycloudflare.com");
    const failed = log.lines.filter((l) => l.event.startsWith("audio tunnel failed"));
    expect(failed.map((l) => l.fields?.attempt)).toEqual([1, 2]);
    for (const l of failed) {
      expect(l.level).toBe("warn");
      expect(l.fields).toMatchObject({ reason: "rate_limited", retryInS: 0 });
      expect(String(l.fields?.detail)).toContain("exit 1");
      expect(String(l.fields?.detail)).toContain("429 Too Many Requests");
    }
    expect(waits).toEqual([
      [1, "rate_limited"],
      [2, "rate_limited"],
    ]);
    expect(log.lines.find((l) => l.event === "public audio ready")?.fields).toMatchObject({ via: "cloudflared", attempt: 3 });
    expect(cf.runs()).toHaveLength(3);
  });

  test("keeps trying past the old 8-attempt limit", async () => {
    const cf = fakeCloudflared(10, API_TIMEOUT);
    const log = recordingLog();
    const voice = createVoiceIo(fakeTts);
    const pa = startPublicAudio(voice, { env: { PICKLE_AUDIO_PORT: "0", CLOUDFLARED_BIN: cf.bin }, twilio: true, log, retryMs: () => 10, reachable: null });
    cleanups.push(() => pa.stop());
    await until(() => voice.publicBase() !== null, 10_000);
    expect(log.lines.filter((l) => l.event.startsWith("audio tunnel failed")).every((l) => l.fields?.reason === "api_timeout")).toBe(true);
    expect(cf.runs()).toHaveLength(11);
  });

  test("a tunnel that dies is restarted; stop() ends retries and kills it", async () => {
    const cf = fakeCloudflared(0, "");
    const log = recordingLog();
    const voice = createVoiceIo(fakeTts);
    const waits: TunnelFailure[] = [];
    const pa = startPublicAudio(voice, { env: { PICKLE_AUDIO_PORT: "0", CLOUDFLARED_BIN: cf.bin }, twilio: true, log, retryMs: (_, r) => (waits.push(r), 400), reachable: null });
    await until(() => voice.publicBase() !== null);
    // kill the fake (its `sleep`) from outside: the supervisor sees the exit and starts a new one
    const pids = Bun.spawnSync(["pgrep", "-f", `^sleep 60$`]).stdout.toString().trim().split("\n").filter(Boolean);
    const mine = pids.filter((p) => Bun.spawnSync(["ps", "-o", "ppid=", "-p", p]).stdout.toString().trim() === String(process.pid));
    expect(mine.length).toBe(1);
    process.kill(Number(mine[0]), "SIGKILL");
    await until(() => log.lines.some((l) => l.event.startsWith("audio tunnel exited")));
    expect(voice.publicBase()).toBeNull();
    expect(waits).toEqual(["exited"]);
    await until(() => cf.runs().length === 2 && voice.publicBase() !== null);
    await pa.stop();
    expect(voice.publicBase()).toBeNull();
    await Bun.sleep(100);
    expect(cf.runs()).toHaveLength(2);
  });

  test("no tunnel without Twilio, with PICKLE_AUDIO_TUNNEL=0, or under NODE_ENV=test", async () => {
    const cf = fakeCloudflared(0, "");
    for (const env of [{}, { PICKLE_AUDIO_TUNNEL: "0" }, { NODE_ENV: "test" }] as Record<string, string>[]) {
      const voice = createVoiceIo(fakeTts);
      const twilio = Object.keys(env).length > 0;
      const pa = startPublicAudio(voice, { env: { PICKLE_AUDIO_PORT: "0", CLOUDFLARED_BIN: cf.bin, ...env }, twilio, log: recordingLog(), reachable: null });
      await Bun.sleep(150);
      await pa.stop();
    }
    expect(() => cf.runs()).toThrow(); // never ran: no argv file
  });
});

describe("reachability check", () => {
  test("only our listener's 404 counts; Cloudflare's 530 and network errors are retried", async () => {
    const tokens = new AudioTokens();
    const server = startAudioServer({ tokens, port: 0 });
    cleanups.push(() => void server.stop(true));
    const ok = await publicAudioReachable(`http://127.0.0.1:${server.port}`, { tries: 1 });
    expect(ok).toEqual({ ok: true, tries: 1, last: "404 from the audio listener" });

    let n = 0;
    const flaky = (async () => {
      n++;
      if (n === 1) throw new Error("getaddrinfo ENOTFOUND");
      if (n === 2) return new Response("error code: 1033", { status: 530 });
      if (n === 3) return new Response("Not Found", { status: 404 }); // someone else's 404
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;
    expect(await publicAudioReachable("https://x.trycloudflare.com", { tries: 5, gapMs: 1, fetch: flaky })).toEqual({ ok: true, tries: 4, last: "404 from the audio listener" });
    const never = (async () => new Response("bad gateway", { status: 502 })) as unknown as typeof fetch;
    expect(await publicAudioReachable("https://x.trycloudflare.com", { tries: 2, gapMs: 1, fetch: never })).toEqual({ ok: false, tries: 2, last: "HTTP 502" });
  });
});
