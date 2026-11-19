/**
 * The kept audio tunnel (Option A): with a state dir, cloudflared is started detached and recorded in
 * audio-tunnel.json, stop() leaves it running, and the next start reuses it (same URL, no new quick-tunnel request).
 * Only a process that is exactly the recorded cloudflared on our port is reused or signalled; a record whose pid now
 * belongs to something else is dropped and that process is left alone. A fake cloudflared (a bun script with the
 * real metrics endpoints, /quicktunnel and /ready) stands in for the real one.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AudioTokens, createVoiceIo, pidAlive, readTunnelRecord, startAudioServer, startPublicAudio, TUNNEL_RECORD, type TunnelRecord } from "../src/audio.ts";
import type { Logger, LogFields } from "../src/log.ts";
import type { Tts } from "../src/tts.ts";

const dirs: string[] = [];
const pids = new Set<number>(); // processes this file started: the only ones it kills
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* gone */
    }
  }
  pids.clear();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), "pickle-audio-keep-"));
  dirs.push(d);
  return d;
}

/** a fake cloudflared: serves /quicktunnel and /ready on --metrics, prints the URL; run n gets the name fake-kept-<n> */
function fakeCloudflared(): { bin: string; runs: () => string[] } {
  const d = scratch();
  const bin = join(d, "cloudflared");
  writeFileSync(
    bin,
    `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
const n = fs.existsSync("${d}/n") ? Number(fs.readFileSync("${d}/n", "utf8")) : 0;
fs.writeFileSync("${d}/n", String(n + 1));
fs.appendFileSync("${d}/argv", args.join(" ") + "\\n");
const name = "fake-kept-" + n;
const m = args.indexOf("--metrics");
if (m >= 0) {
  const [host, port] = args[m + 1].split(":");
  Bun.serve({ hostname: host, port: Number(port), reusePort: false, fetch(req) {
    const p = new URL(req.url).pathname;
    if (p === "/quicktunnel") return Response.json({ hostname: name + ".trycloudflare.com" });
    if (p === "/ready") return Response.json({ status: 200, readyConnections: 1 });
    return new Response("", { status: 404 });
  } });
}
console.error("INF |  https://" + name + ".trycloudflare.com  |");
console.error("INF Registered tunnel connection connIndex=0 location=icn06 protocol=quic");
setTimeout(() => process.exit(0), 60000);
`,
  );
  chmodSync(bin, 0o755);
  return { bin, runs: () => (existsSync(join(d, "argv")) ? readFileSync(join(d, "argv"), "utf8").trim().split("\n").filter(Boolean) : []) };
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

async function until(cond: () => boolean, ms = 8_000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await Bun.sleep(20);
  }
}

function freePort(): number {
  const s = startAudioServer({ tokens: new AudioTokens(), port: 0 });
  const port = s.port!;
  s.stop(true);
  return port;
}

/** one server start: our own audio port, the fake cloudflared, a state dir */
function start(o: { stateDir: string; port: number; bin: string; pollMs?: number }) {
  const log = recordingLog();
  const voice = createVoiceIo(fakeTts);
  const pa = startPublicAudio(voice, {
    env: { PICKLE_AUDIO_PORT: String(o.port), CLOUDFLARED_BIN: o.bin },
    twilio: true,
    log,
    reachable: null,
    retryMs: () => 200,
    stateDir: o.stateDir,
    keepPollMs: o.pollMs ?? 100,
  });
  cleanups.push(() => pa.stop());
  return { log, voice, pa };
}

const record = (stateDir: string) => readTunnelRecord(join(stateDir, TUNNEL_RECORD));

describe("kept audio tunnel", () => {
  test("a restart reuses the running cloudflared: same URL and pid, no new tunnel request, the reuse is logged", async () => {
    const cf = fakeCloudflared();
    const stateDir = scratch();
    const port = freePort();

    const a = start({ stateDir, port, bin: cf.bin });
    await until(() => a.voice.publicBase() !== null);
    const rec = record(stateDir)!;
    pids.add(rec.pid);
    expect(a.voice.publicBase()).toBe("https://fake-kept-0.trycloudflare.com");
    expect(rec).toMatchObject({ port, bin: cf.bin, url: "https://fake-kept-0.trycloudflare.com" });
    expect(cf.runs()).toEqual([`tunnel --no-autoupdate --url http://127.0.0.1:${port} --metrics 127.0.0.1:${rec.metrics}`]);
    expect(a.log.lines.find((l) => l.event === "public audio ready")?.fields).toMatchObject({ kept: true, reused: false, pid: rec.pid });

    await a.pa.stop();
    expect(a.voice.publicBase()).toBeNull();
    expect(a.log.lines.find((l) => l.event === "audio tunnel left running for the next start")?.fields).toMatchObject({ pid: rec.pid });
    await Bun.sleep(150);
    expect(pidAlive(rec.pid)).toBe(true);

    const b = start({ stateDir, port, bin: cf.bin });
    await until(() => b.voice.publicBase() !== null);
    expect(b.voice.publicBase()).toBe("https://fake-kept-0.trycloudflare.com");
    expect(b.log.lines.find((l) => l.event === "audio tunnel reused")?.fields).toMatchObject({ pid: rec.pid, url: "https://fake-kept-0.trycloudflare.com" });
    expect(b.log.lines.find((l) => l.event === "public audio ready")?.fields).toMatchObject({ kept: true, reused: true, pid: rec.pid });
    expect(cf.runs()).toHaveLength(1);
    expect(record(stateDir)?.pid).toBe(rec.pid);
  });

  test("a reused tunnel that dies is noticed and replaced; the record follows the new one", async () => {
    const cf = fakeCloudflared();
    const stateDir = scratch();
    const port = freePort();
    const a = start({ stateDir, port, bin: cf.bin });
    await until(() => a.voice.publicBase() !== null);
    const first = record(stateDir)!.pid;
    pids.add(first);
    await a.pa.stop();

    const b = start({ stateDir, port, bin: cf.bin, pollMs: 50 });
    await until(() => b.log.lines.some((l) => l.event === "audio tunnel reused"));
    process.kill(first, "SIGKILL");
    await until(() => b.log.lines.some((l) => l.event.startsWith("audio tunnel exited")));
    await until(() => b.voice.publicBase() === "https://fake-kept-1.trycloudflare.com");
    const second = record(stateDir)!;
    pids.add(second.pid);
    expect(second.pid).not.toBe(first);
    expect(cf.runs()).toHaveLength(2);
  });

  test("a record whose pid is now another process is dropped and that process is never signalled", async () => {
    const cf = fakeCloudflared();
    const stateDir = scratch();
    const port = freePort();
    const other = Bun.spawn(["sleep", "30"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    pids.add(other.pid);
    const fake: TunnelRecord = { pid: other.pid, port, metrics: 1, bin: cf.bin, args: ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${port}`, "--metrics", "127.0.0.1:1"], url: null, startedAt: 1 };
    writeFileSync(join(stateDir, TUNNEL_RECORD), JSON.stringify(fake));

    const a = start({ stateDir, port, bin: cf.bin });
    await until(() => a.voice.publicBase() !== null);
    pids.add(record(stateDir)!.pid);
    expect(a.log.lines.find((l) => l.event === "audio tunnel record points at another process; left it alone")?.fields).toEqual({ pid: other.pid });
    expect(pidAlive(other.pid)).toBe(true);
    expect(other.killed).toBe(false);
    expect(record(stateDir)!.pid).not.toBe(other.pid);
    expect(cf.runs()).toHaveLength(1);
  });

  test("a record for a dead pid is dropped; our kept tunnel for an old port is stopped and replaced", async () => {
    const cf = fakeCloudflared();
    const stateDir = scratch();
    const gone = Bun.spawn(["true"]);
    await gone.exited;
    const port1 = freePort();
    writeFileSync(join(stateDir, TUNNEL_RECORD), JSON.stringify({ pid: gone.pid, port: port1, metrics: 1, bin: cf.bin, args: ["tunnel"], url: null, startedAt: 1 }));

    const a = start({ stateDir, port: port1, bin: cf.bin });
    await until(() => a.voice.publicBase() !== null);
    expect(a.log.lines.some((l) => l.event === "kept audio tunnel is gone; starting a new one")).toBe(true);
    const old = record(stateDir)!.pid;
    pids.add(old);
    await a.pa.stop();

    const port2 = freePort();
    const b = start({ stateDir, port: port2, bin: cf.bin });
    await until(() => b.voice.publicBase() !== null);
    pids.add(record(stateDir)!.pid);
    expect(b.log.lines.find((l) => l.event === "stopped our kept audio tunnel for an old port")?.fields).toEqual({ pid: old, port: port1 });
    await until(() => !pidAlive(old));
    expect(record(stateDir)).toMatchObject({ port: port2 });
    expect(b.voice.publicBase()).toBe("https://fake-kept-1.trycloudflare.com");
  });

  test("on a fallback port (ours is busy) nothing is kept or reused, and the record is left as it was", async () => {
    const cf = fakeCloudflared();
    const stateDir = scratch();
    const holder = startAudioServer({ tokens: new AudioTokens(), port: 0 });
    cleanups.push(() => void holder.stop(true));
    const a = start({ stateDir, port: holder.port!, bin: cf.bin });
    expect(a.pa.port).not.toBe(holder.port);
    await until(() => a.voice.publicBase() !== null);
    expect(existsSync(join(stateDir, TUNNEL_RECORD))).toBe(false);
    expect(cf.runs()[0]).toBe(`tunnel --no-autoupdate --url http://127.0.0.1:${a.pa.port}`);
    expect(a.log.lines.find((l) => l.event === "public audio ready")?.fields?.kept).toBeUndefined();
  });
});
