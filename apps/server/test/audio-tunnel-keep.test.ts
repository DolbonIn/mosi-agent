/**
 * The kept audio tunnel (Option A): with a state dir, cloudflared is started detached and recorded in
 * audio-tunnel.json, stop() leaves it running, and the next start reuses it (same URL, no new quick-tunnel request).
 * Only a process that is exactly the recorded cloudflared on our port is reused or signalled; a record whose pid now
 * belongs to something else is dropped and that process is left alone. A fake cloudflared (a bun script with the
 * real metrics endpoints, /quicktunnel and /ready) stands in for the real one.
 *
 * Readiness (11-23, live): Cloudflare dropped the kept quick tunnel (DNS gone, /ready 503) while its cloudflared
 * stayed up, and restarts kept reusing it on its old log line. A recorded tunnel is reused only on /ready 200, and a
 * running one whose /ready fails sends calls to the basic voice at once and is replaced when it stays down. A tunnel that
 * is this server's child (a fallback port) gets a metrics address too and is watched the same way.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AudioTokens, createVoiceIo, isRecordedTunnel, pidAlive, processCommand, readTunnelRecord, startAudioServer, startPublicAudio, TUNNEL_LOG, TUNNEL_RECORD, type TunnelFailure, type TunnelRecord } from "../src/audio.ts";
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
  // a test that failed half way may not have noted a later fake: stop whatever a state dir still records, if it is exactly that fake
  for (const d of dirs) {
    const rec = readTunnelRecord(join(d, TUNNEL_RECORD));
    if (rec && isRecordedTunnel(rec, processCommand(rec.pid))) {
      try {
        process.kill(rec.pid, "SIGKILL");
      } catch {
        /* gone */
      }
    }
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), "pickle-audio-keep-"));
  dirs.push(d);
  return d;
}

/**
 * a fake cloudflared: serves /quicktunnel and /ready on --metrics, prints the URL; run n gets the name fake-kept-<n>
 * and writes its pid to <dir>/pid-<n>. /ready answers the status in <dir>/ready-<n> (default 200); SIGUSR1 stops its
 * metrics server (the process lives on).
 */
function fakeCloudflared(): { bin: string; runs: () => string[]; setReady(run: number, status: number): void; quiet(): void; pid(run: number): number } {
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
fs.writeFileSync("${d}/pid-" + n, String(process.pid));
const name = "fake-kept-" + n;
const m = args.indexOf("--metrics");
if (m >= 0) {
  const [host, port] = args[m + 1].split(":");
  const readyFile = "${d}/ready-" + n;
  const server = Bun.serve({ hostname: host, port: Number(port), reusePort: false, fetch(req) {
    const p = new URL(req.url).pathname;
    if (p === "/quicktunnel") return Response.json({ hostname: name + ".trycloudflare.com" });
    if (p === "/ready") {
      const st = fs.existsSync(readyFile) ? Number(fs.readFileSync(readyFile, "utf8")) : 200;
      return Response.json({ status: st, readyConnections: st === 200 ? 1 : 0 }, { status: st });
    }
    return new Response("", { status: 404 });
  } });
  process.on("SIGUSR1", () => server.stop(true));
}
console.error("INF |  https://" + name + ".trycloudflare.com  |");
if (!fs.existsSync("${d}/quiet")) console.error("INF Registered tunnel connection connIndex=0 location=icn06 protocol=quic");
setTimeout(() => process.exit(0), 60000);
`,
  );
  chmodSync(bin, 0o755);
  return {
    bin,
    runs: () => (existsSync(join(d, "argv")) ? readFileSync(join(d, "argv"), "utf8").trim().split("\n").filter(Boolean) : []),
    setReady: (run, status) => writeFileSync(join(d, `ready-${run}`), String(status)),
    quiet: () => writeFileSync(join(d, "quiet"), ""),
    pid: (run) => Number(readFileSync(join(d, `pid-${run}`), "utf8")),
  };
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
function start(o: {
  stateDir: string;
  port: number;
  bin: string;
  pollMs?: number;
  reuseWaitMs?: number;
  urlGraceMs?: number;
  readyPollMs?: number;
  deadAfterMs?: number;
  retryMs?: (failures: number, reason: TunnelFailure) => number;
}) {
  const log = recordingLog();
  const voice = createVoiceIo(fakeTts);
  const pa = startPublicAudio(voice, {
    env: { PICKLE_AUDIO_PORT: String(o.port), CLOUDFLARED_BIN: o.bin },
    twilio: true,
    log,
    reachable: null,
    retryMs: o.retryMs ?? (() => 200),
    stateDir: o.stateDir,
    keepPollMs: o.pollMs ?? 100,
    reuseWaitMs: o.reuseWaitMs ?? 2_000,
    urlGraceMs: o.urlGraceMs,
    readyPollMs: o.readyPollMs ?? 50,
    deadAfterMs: o.deadAfterMs ?? 60_000,
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
    expect(cf.runs()[0]).toMatch(new RegExp(`^tunnel --no-autoupdate --url http://127\\.0\\.0\\.1:${a.pa.port} --metrics 127\\.0\\.0\\.1:\\d+$`));
    expect(a.log.lines.find((l) => l.event === "public audio ready")?.fields?.kept).toBeUndefined();
  });
});

const K0 = "https://fake-kept-0.trycloudflare.com";
const K1 = "https://fake-kept-1.trycloudflare.com";
const logged = (log: ReturnType<typeof recordingLog>, event: string) => log.lines.find((l) => l.event === event)?.fields;

describe("kept audio tunnel readiness (11-23)", () => {
  test("a restart replaces a kept tunnel whose /ready is not 200, though its log still has the registered line", async () => {
    const cf = fakeCloudflared();
    const stateDir = scratch();
    const port = freePort();
    const a = start({ stateDir, port, bin: cf.bin });
    await until(() => a.voice.publicBase() === K0);
    const old = record(stateDir)!.pid;
    pids.add(old);
    await a.pa.stop();
    cf.setReady(0, 503); // Cloudflare dropped it; cloudflared keeps running
    expect(readFileSync(join(stateDir, TUNNEL_LOG), "utf8")).toContain("Registered tunnel connection"); // what a restart used to trust

    // the wait outlasts the grace a tunnel this start spawned would get after its URL (live: 20 s vs 15 s), so a
    // reuse that took that grace too would pass here
    const b = start({ stateDir, port, bin: cf.bin, reuseWaitMs: 900, urlGraceMs: 100 });
    const shown = new Set<string | null>();
    await until(() => (shown.add(b.voice.publicBase()), b.voice.publicBase() === K1));
    pids.add(record(stateDir)!.pid);
    expect(shown.has(K0)).toBe(false);
    expect(logged(b.log, "audio tunnel reused")).toBeUndefined();
    expect(logged(b.log, "kept audio tunnel is not ready; starting a new one")).toEqual({ pid: old, status: 503 });
    await until(() => !pidAlive(old));
    expect(cf.runs()).toHaveLength(2);
    expect(record(stateDir)).toMatchObject({ url: K1 });
  });

  test("a restart does not reuse a kept tunnel whose metrics server is silent (the URL in its old log is not enough)", async () => {
    const cf = fakeCloudflared();
    const stateDir = scratch();
    const port = freePort();
    const a = start({ stateDir, port, bin: cf.bin });
    await until(() => a.voice.publicBase() === K0);
    const old = record(stateDir)!.pid;
    pids.add(old);
    await a.pa.stop();
    process.kill(old, "SIGUSR1");
    await Bun.sleep(100);

    const b = start({ stateDir, port, bin: cf.bin, reuseWaitMs: 400 });
    await until(() => b.voice.publicBase() === K1);
    pids.add(record(stateDir)!.pid);
    expect(logged(b.log, "audio tunnel reused")).toBeUndefined();
    expect(logged(b.log, "kept audio tunnel did not answer; starting a new one")).toEqual({ pid: old, reason: "timeout" });
    await until(() => !pidAlive(old));
  });

  test("a running tunnel whose /ready fails: the basic voice at once, back on 200, replaced once it stays down", async () => {
    const cf = fakeCloudflared();
    const stateDir = scratch();
    const port = freePort();
    const waits: [number, TunnelFailure][] = [];
    const a = start({ stateDir, port, bin: cf.bin, readyPollMs: 40, deadAfterMs: 800, retryMs: (n, r) => (waits.push([n, r]), 200) });
    await until(() => a.voice.publicBase() === K0);
    const first = record(stateDir)!.pid;
    pids.add(first);

    // a short drop: calls go to the basic voice, and come back with no new tunnel
    cf.setReady(0, 503);
    await until(() => a.voice.publicBase() === null);
    expect(logged(a.log, "audio tunnel not ready; calls use the basic voice until it is")).toEqual({ url: K0, status: 503 });
    cf.setReady(0, 200);
    await until(() => a.voice.publicBase() === K0);
    expect(logged(a.log, "audio tunnel ready again")).toEqual({ url: K0 });
    expect(pidAlive(first)).toBe(true);
    expect(cf.runs()).toHaveLength(1);
    expect(logged(a.log, "audio tunnel stayed not ready; replacing it, calls use the basic voice until the new one is up")).toBeUndefined();

    // its metrics go silent and stay so (the process lives on): replaced with the usual backoff
    process.kill(first, "SIGUSR1");
    await until(() => a.voice.publicBase() === null);
    await until(() => a.voice.publicBase() === K1);
    const gone = logged(a.log, "audio tunnel stayed not ready; replacing it, calls use the basic voice until the new one is up")!;
    expect(gone).toMatchObject({ url: K0, status: null, pid: first, retryInS: 0 });
    expect(Number(gone.downForS)).toBeLessThan(5);
    expect(waits).toEqual([[1, "not_ready"]]); // the usual backoff, as after an exit
    await until(() => !pidAlive(first));
    const second = record(stateDir)!;
    pids.add(second.pid);
    expect(second.pid).not.toBe(first);
    expect(cf.runs()).toHaveLength(2);
  });

  test("a reused tunnel is watched the same way and replaced when Cloudflare drops it", async () => {
    const cf = fakeCloudflared();
    const stateDir = scratch();
    const port = freePort();
    const a = start({ stateDir, port, bin: cf.bin });
    await until(() => a.voice.publicBase() === K0);
    const first = record(stateDir)!.pid;
    pids.add(first);
    await a.pa.stop();

    const b = start({ stateDir, port, bin: cf.bin, readyPollMs: 40, deadAfterMs: 500 });
    await until(() => logged(b.log, "audio tunnel reused") !== undefined && b.voice.publicBase() === K0);
    cf.setReady(0, 503);
    await until(() => b.voice.publicBase() === K1);
    expect(logged(b.log, "audio tunnel stayed not ready; replacing it, calls use the basic voice until the new one is up")).toMatchObject({ url: K0, status: 503, pid: first });
    await until(() => !pidAlive(first));
    pids.add(record(stateDir)!.pid);
    expect(cf.runs()).toHaveLength(2);
  });

  test("stop() ends the watch: the tunnel left for the next start is neither marked down nor replaced", async () => {
    const cf = fakeCloudflared();
    const stateDir = scratch();
    const port = freePort();
    const a = start({ stateDir, port, bin: cf.bin, readyPollMs: 40, deadAfterMs: 300 });
    await until(() => a.voice.publicBase() === K0);
    const pid = record(stateDir)!.pid;
    pids.add(pid);
    await a.pa.stop();
    cf.setReady(0, 503);
    await Bun.sleep(700);
    expect(pidAlive(pid)).toBe(true);
    expect(record(stateDir)?.pid).toBe(pid);
    expect(cf.runs()).toHaveLength(1);
    expect(a.log.lines.filter((l) => /not ready/.test(l.event))).toEqual([]);
  });

  test("the grace after the URL still holds for a tunnel this start spawned (no registered line, /ready not 200 yet)", async () => {
    const cf = fakeCloudflared();
    cf.setReady(0, 503);
    cf.quiet(); // no "Registered tunnel connection" line
    const stateDir = scratch();
    const port = freePort();
    const a = start({ stateDir, port, bin: cf.bin, urlGraceMs: 300, readyPollMs: 60_000 });
    await until(() => logged(a.log, "public audio ready") !== undefined);
    pids.add(record(stateDir)!.pid);
    expect(logged(a.log, "public audio ready")).toMatchObject({ url: K0, kept: true, reused: false });
    expect(a.log.lines.some((l) => l.event.startsWith("audio tunnel failed"))).toBe(false);
  });
});

describe("a tunnel that is this server's child (fallback port) is watched too", () => {
  test("a failed /ready sends calls to the basic voice at once, 200 brings it back, and one that stays down is killed and replaced", async () => {
    const cf = fakeCloudflared();
    const stateDir = scratch();
    const holder = startAudioServer({ tokens: new AudioTokens(), port: 0 });
    cleanups.push(() => void holder.stop(true));
    const waits: [number, TunnelFailure][] = [];
    const a = start({ stateDir, port: holder.port!, bin: cf.bin, readyPollMs: 40, deadAfterMs: 800, retryMs: (n, r) => (waits.push([n, r]), 200) });
    expect(a.pa.port).not.toBe(holder.port);
    await until(() => a.voice.publicBase() === K0);
    const first = cf.pid(0);
    pids.add(first);
    expect(cf.runs()[0]).toMatch(/ --metrics 127\.0\.0\.1:\d+$/);

    // a short drop: calls go to the basic voice, and come back with no new tunnel
    cf.setReady(0, 503);
    await until(() => a.voice.publicBase() === null);
    expect(logged(a.log, "audio tunnel not ready; calls use the basic voice until it is")).toEqual({ url: K0, status: 503 });
    cf.setReady(0, 200);
    await until(() => a.voice.publicBase() === K0);
    expect(logged(a.log, "audio tunnel ready again")).toEqual({ url: K0 });
    expect(cf.runs()).toHaveLength(1);

    // it stays down: our child is stopped and a new one started with the usual backoff
    cf.setReady(0, 503);
    await until(() => a.voice.publicBase() === K1);
    const gone = logged(a.log, "audio tunnel stayed not ready; replacing it, calls use the basic voice until the new one is up")!;
    expect(gone).toMatchObject({ url: K0, status: 503, retryInS: 0 });
    expect(gone.pid).toBeUndefined(); // no kept pid to name
    expect(waits).toEqual([[1, "not_ready"]]);
    await until(() => !pidAlive(first));
    pids.add(cf.pid(1));
    expect(cf.runs()).toHaveLength(2);
    expect(existsSync(join(stateDir, TUNNEL_RECORD))).toBe(false); // still nothing kept
  });
});
