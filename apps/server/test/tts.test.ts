import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext } from "@pickle/agent";
import { createTts, TtsError, ttsTimeoutMs, ttsUrlFromEnv } from "../src/tts.ts";
import { AudioTokens, AUDIO_TOKEN_TTL_MS, parseTunnelUrl, startAudioServer } from "../src/audio.ts";
import { PHONE_TTS_WAIT_MS, phoneTool, phoneTwiml } from "../src/phone.ts";
import { sha256Hex } from "../src/util.ts";
import { makeHarness, type Harness } from "./helpers.ts";

// ───────────────────────────── fake TTS service (services/tts contract) ─────────────────────────────

interface FakeTts {
  url: string;
  calls: { text: string; voice?: string; direction?: string }[];
  mode: "ok" | "loading" | "fail" | "slow";
  delayMs: number;
  /** reported by /health (lines waiting or running) */
  queue: number;
  stop(): void;
}

function startFakeTts(): FakeTts {
  const state: FakeTts = { url: "", calls: [], mode: "ok", delayMs: 30, queue: 0, stop: () => {} };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      if (req.method === "GET" && path === "/health") {
        return Response.json({ ok: true, ready: state.mode !== "loading", model: "fake", voices: ["pickle"], sampleRate: 44100, queue: state.queue, busyMs: 0 });
      }
      if (req.method === "POST" && path === "/tts") {
        const body = (await req.json()) as { text: string; voice?: string; direction?: string };
        state.calls.push(body);
        if (state.mode === "loading") return Response.json({ error: "loading" }, { status: 503 });
        if (state.mode === "fail") return Response.json({ error: "synthesis_failed" }, { status: 500 });
        await Bun.sleep(state.mode === "slow" ? 2_000 : state.delayMs);
        const audio = new TextEncoder().encode(`ID3fake-mp3:${body.voice ?? "pickle"}:${body.direction ?? ""}:${body.text.length}`);
        return new Response(audio, { headers: { "Content-Type": "audio/mpeg", "X-Audio-Duration": "1.25", "X-Gen-Ms": "30" } });
      }
      return Response.json({ error: "not_found" }, { status: 404 });
    },
  });
  state.url = `http://127.0.0.1:${server.port}`;
  state.stop = () => server.stop(true);
  return state;
}

/** a port nobody listens on */
function deadUrl(): string {
  const s = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
  const url = `http://127.0.0.1:${s.port}`;
  s.stop(true);
  return url;
}

let fake: FakeTts;
const dirs: string[] = [];
const scratch = () => {
  const d = mkdtempSync(join(tmpdir(), "pickle-tts-test-"));
  dirs.push(d);
  return d;
};
beforeAll(() => {
  fake = startFakeTts();
});
afterAll(() => {
  fake.stop();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
afterEach(() => {
  fake.calls = [];
  fake.mode = "ok";
  fake.delayMs = 30;
  fake.queue = 0;
});

// ───────────────────────────── tts client ─────────────────────────────

describe("tts client", () => {
  test("env URL and length-scaled timeout", () => {
    expect(ttsUrlFromEnv(undefined)).toBe("http://127.0.0.1:8790");
    expect(ttsUrlFromEnv("off")).toBeNull();
    expect(ttsUrlFromEnv("http://10.0.0.2:9000/")).toBe("http://10.0.0.2:9000");
    expect(ttsUrlFromEnv("ftp://x")).toBeNull();
    expect(ttsTimeoutMs(0)).toBe(20_000);
    expect(ttsTimeoutMs(100)).toBe(35_000);
    expect(ttsTimeoutMs(600)).toBe(110_000);
    expect(ttsTimeoutMs(5000)).toBe(150_000);
    expect(createTts({ tts: null, dataDir: "/nonexistent" })).toBeNull();
  });

  test("caches on disk by sha256(voice|direction|text); a repeat never hits the service", async () => {
    const dataDir = scratch();
    const tts = createTts({ tts: { url: fake.url }, dataDir })!;
    const a = await tts.synthesize("  안녕하세요, 모시예요.  ");
    expect(a.id).toBe(sha256Hex("pickle||안녕하세요, 모시예요."));
    expect(a.file).toBe(join(dataDir, "tts", `${a.id}.mp3`));
    expect(existsSync(a.file)).toBe(true);
    expect(a.durationS).toBe(1.25);
    expect(a.bytes).toBeGreaterThan(0);
    const b = await tts.synthesize("안녕하세요, 모시예요.");
    expect(b).toEqual(a);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]).toEqual({ text: "안녕하세요, 모시예요.", voice: "pickle", format: "mp3" } as never);
    // a different acting cue is a different line
    const c = await tts.synthesize("안녕하세요, 모시예요.", { direction: "밝게" });
    expect(c.id).toBe(sha256Hex("pickle|밝게|안녕하세요, 모시예요."));
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[1]!.direction).toBe("밝게");
    // a fresh client over the same dir (restart) still hits the disk cache
    const again = await createTts({ tts: { url: fake.url }, dataDir })!.synthesize("안녕하세요, 모시예요.");
    expect(again.file).toBe(a.file);
    expect(fake.calls).toHaveLength(2);
  });

  test("concurrent requests for the same line share one synthesis", async () => {
    fake.delayMs = 150;
    const tts = createTts({ tts: { url: fake.url }, dataDir: scratch() })!;
    const rs = await Promise.all([tts.synthesize("같은 문장"), tts.synthesize("같은 문장"), tts.synthesize(" 같은 문장 "), tts.synthesize("다른 문장")]);
    expect(fake.calls.map((c) => c.text).sort()).toEqual(["다른 문장", "같은 문장"].sort());
    expect(rs[0]!.file).toBe(rs[1]!.file);
    expect(rs[0]!.file).toBe(rs[2]!.file);
    expect(rs[3]!.file).not.toBe(rs[0]!.file);
  });

  test("a caller that stops waiting doesn't cancel the shared synthesis", async () => {
    fake.delayMs = 150;
    const tts = createTts({ tts: { url: fake.url }, dataDir: scratch() })!;
    const ac = new AbortController();
    const first = tts.synthesize("끊긴 요청", { signal: ac.signal });
    const second = tts.synthesize("끊긴 요청");
    ac.abort();
    await expect(first).rejects.toThrow();
    const r = await second;
    expect(existsSync(r.file)).toBe(true);
    expect(fake.calls).toHaveLength(1);
  });

  test("a caller's timeout stops only its wait; a retry joins the same synthesis", async () => {
    fake.mode = "slow"; // 2 s per line
    let wait = 300;
    const tts = createTts({ tts: { url: fake.url }, dataDir: scratch() }, { timeoutMs: () => wait })!;
    const t0 = performance.now();
    await expect(tts.synthesize("느린 문장")).rejects.toMatchObject({ code: "timeout" });
    expect(performance.now() - t0).toBeLessThan(1_500);
    wait = 5_000;
    const r = await tts.synthesize("느린 문장");
    expect(existsSync(r.file)).toBe(true);
    expect(fake.calls).toHaveLength(1);
  });

  test("health() reports queue depth; cachedLine() peeks the disk cache without calling the service", async () => {
    const tts = createTts({ tts: { url: fake.url }, dataDir: scratch() })!;
    fake.queue = 3;
    expect(await tts.health()).toEqual({ ready: true, queue: 3, busyMs: 0 });
    expect(tts.cachedLine("미리 보기")).toBeNull();
    const r = await tts.synthesize("미리 보기");
    expect(tts.cachedLine(" 미리 보기 ")).toEqual(r);
    expect(tts.cachedLine("미리 보기", { direction: "밝게" })).toBeNull();
    expect(fake.calls).toHaveLength(1);
    expect(await createTts({ tts: { url: deadUrl() }, dataDir: scratch() })!.health()).toBeNull();
  });

  test("prunes oldest-first past the file cap", async () => {
    const dataDir = scratch();
    const tts = createTts({ tts: { url: fake.url }, dataDir }, { maxFiles: 2 })!;
    const one = await tts.synthesize("하나");
    utimesSync(one.file, new Date(1_000_000), new Date(1_000_000));
    const two = await tts.synthesize("둘");
    utimesSync(two.file, new Date(2_000_000), new Date(2_000_000));
    const three = await tts.synthesize("셋");
    const left = readdirSync(join(dataDir, "tts")).sort();
    expect(left).toEqual([`${two.id}.mp3`, `${three.id}.mp3`].sort());
  });

  test("prunes past the byte cap but never the line just made", async () => {
    const dataDir = scratch();
    const tts = createTts({ tts: { url: fake.url }, dataDir }, { maxBytes: 10 })!;
    await tts.synthesize("첫째");
    const b = await tts.synthesize("둘째");
    expect(readdirSync(join(dataDir, "tts"))).toEqual([`${b.id}.mp3`]);
  });

  test("errors: bad input, loading (503), failure, unreachable; available() follows /health", async () => {
    const tts = createTts({ tts: { url: fake.url }, dataDir: scratch() })!;
    expect(tts.status()).toBeNull();
    expect(await tts.available()).toBe(true);
    expect(tts.status()).toBe(true);
    await expect(tts.synthesize("   ")).rejects.toMatchObject({ code: "empty_text" });
    await expect(tts.synthesize("가".repeat(601))).rejects.toMatchObject({ code: "too_long" });
    fake.mode = "loading";
    expect(await tts.available()).toBe(false);
    await expect(tts.synthesize("로딩 중")).rejects.toMatchObject({ code: "unavailable", status: 503 });
    fake.mode = "fail";
    await expect(tts.synthesize("실패")).rejects.toBeInstanceOf(TtsError);
    expect(fake.calls).toHaveLength(2); // bad input never reached the service
    const dead = createTts({ tts: { url: deadUrl() }, dataDir: scratch() })!;
    expect(await dead.available()).toBe(false);
    await expect(dead.synthesize("안녕")).rejects.toMatchObject({ code: "unavailable" });
  });
});

// ───────────────────────────── POST /api/tts + health ─────────────────────────────

describe("POST /api/tts", () => {
  let h: Harness;
  afterEach(async () => {
    await h.close();
  });

  test("needs auth; 503 tts_unavailable when off; 400 on empty or too-long text; health says missing", async () => {
    h = await makeHarness();
    expect((await h.req("POST", "/api/tts", { body: { text: "안녕" } })).status).toBe(401);
    const { token } = await h.signup("haneul");
    const off = await h.req("POST", "/api/tts", { token, body: { text: "안녕" } });
    expect(off.status).toBe(503);
    expect(await off.json()).toMatchObject({ error: "tts_unavailable" });
    for (const body of [{ text: "" }, { text: "   " }, {}, { text: 42 }]) {
      const r = await h.req("POST", "/api/tts", { token, body });
      expect(r.status).toBe(400);
      expect(((await r.json()) as { error: string }).error).toBe("empty_text");
    }
    const long = await h.req("POST", "/api/tts", { token, body: { text: "가".repeat(601) } });
    expect(long.status).toBe(400);
    expect(((await long.json()) as { error: string }).error).toBe("text_too_long");
    const health = (await (await h.req("GET", "/api/health")).json()) as Record<string, unknown>;
    expect(health).toMatchObject({ tts: "missing", publicAudio: "missing" });
  });

  test("returns cached audio/mpeg from the local TTS", async () => {
    h = await makeHarness({ config: { tts: { url: fake.url } } });
    const { token } = await h.signup("haneul");
    const r = await h.req("POST", "/api/tts", { token, body: { text: "오늘 날씨 맑아요." } });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("audio/mpeg");
    expect(r.headers.get("cache-control")).toBe("private, max-age=86400");
    expect(r.headers.get("x-audio-duration")).toBe("1.25");
    const bytes = new Uint8Array(await r.arrayBuffer());
    expect(new TextDecoder().decode(bytes.slice(0, 3))).toBe("ID3");
    const again = await h.req("POST", "/api/tts", { token, body: { text: "오늘 날씨 맑아요." } });
    expect(again.status).toBe(200);
    expect(fake.calls).toHaveLength(1);
    expect(existsSync(join(h.dir, "tts"))).toBe(true);
    await h.app.core.voice.tts!.available();
    const health = (await (await h.req("GET", "/api/health")).json()) as Record<string, unknown>;
    expect(health.tts).toBe("configured");
  });

  test("TTS down or failing → 503 tts_unavailable (client falls back to Web Speech)", async () => {
    h = await makeHarness({ config: { tts: { url: deadUrl() } } });
    const { token } = await h.signup("haneul");
    const r = await h.req("POST", "/api/tts", { token, body: { text: "안녕" } });
    expect(r.status).toBe(503);
    expect(await r.json()).toMatchObject({ error: "tts_unavailable" });
  });

  test("per-user rate limit", async () => {
    h = await makeHarness({ config: { tts: { url: fake.url } } });
    const { token } = await h.signup("haneul");
    let last = 0;
    for (let i = 0; i < 31; i++) last = (await h.req("POST", "/api/tts", { token, body: { text: "" } })).status;
    expect(last).toBe(429);
  });
});

// ───────────────────────────── public audio listener ─────────────────────────────

describe("public audio listener", () => {
  test("serves only registered tokens, expires them after 15 minutes, 404s everything else", async () => {
    const clock = { t: 1_000_000 };
    const tokens = new AudioTokens(() => clock.t);
    const dir = scratch();
    const file = join(dir, "line.mp3");
    writeFileSync(file, "ID3-audio-bytes");
    const server = startAudioServer({ tokens, port: 0 });
    const base = `http://127.0.0.1:${server.port}`;
    try {
      const token = tokens.register(file);
      expect(token).toMatch(/^[0-9a-f]{32}$/);
      const ok = await fetch(`${base}/a/${token}.mp3`);
      expect(ok.status).toBe(200);
      expect(ok.headers.get("content-type")).toBe("audio/mpeg");
      expect(await ok.text()).toBe("ID3-audio-bytes");
      const head = await fetch(`${base}/a/${token}.mp3`, { method: "HEAD" });
      expect(head.status).toBe(200);

      const other = "0".repeat(32);
      for (const p of [
        `/a/${other}.mp3`,
        `/a/${token}`,
        `/a/${token}.wav`,
        `/a/${token.toUpperCase()}.mp3`,
        `/a/`,
        `/a`,
        `/`,
        `/api/health`,
        `/api/tts`,
        `/a/..%2F..%2Fetc%2Fpasswd`,
        `/a/${token}.mp3/`,
        `/x/a/${token}.mp3`,
      ]) {
        const r = await fetch(base + p);
        expect(r.status).toBe(404);
        expect(await r.text()).toBe("not found");
      }
      expect((await fetch(`${base}/a/${token}.mp3`, { method: "POST", body: "x" })).status).toBe(404);
      expect((await fetch(`${base}/a/${token}.mp3`, { method: "DELETE" })).status).toBe(404);

      // a registered token whose file vanished (pruned) → 404
      const gone = tokens.register(join(dir, "missing.mp3"));
      expect((await fetch(`${base}/a/${gone}.mp3`)).status).toBe(404);

      clock.t += AUDIO_TOKEN_TTL_MS - 1;
      expect((await fetch(`${base}/a/${token}.mp3`)).status).toBe(200);
      clock.t += 1;
      expect((await fetch(`${base}/a/${token}.mp3`)).status).toBe(404);
      expect(tokens.resolve(token)).toBeNull();
    } finally {
      server.stop(true);
    }
  });

  test("tunnel URL parsing ignores the api host", () => {
    const log = `2026-11-11T12:00:00Z INF Requesting new quick Tunnel on trycloudflare.com...
2026-11-11T12:00:01Z INF +--------------------------------------------------------------------------------------------+
2026-11-11T12:00:01Z INF |  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |
2026-11-11T12:00:01Z INF |  https://brave-otter-sample-words.trycloudflare.com                                        |`;
    expect(parseTunnelUrl(log)).toBe("https://brave-otter-sample-words.trycloudflare.com");
    expect(parseTunnelUrl('failed to request quick Tunnel: Post "https://api.trycloudflare.com/tunnel"')).toBeNull();
    expect(parseTunnelUrl("nothing here")).toBeNull();
  });
});

// ───────────────────────────── sys_phone_call with 모시's voice ─────────────────────────────

describe("sys_phone_call voice", () => {
  let h: Harness;
  const realFetch = globalThis.fetch;
  const TWILIO = { accountSid: "AC123", authToken: "tok", from: "+15550000000" };
  afterEach(async () => {
    globalThis.fetch = realFetch;
    await h.close();
  });

  function ctxFor(userId: string, statuses: string[] = []): ToolContext {
    return {
      userId,
      threadId: "t_x",
      agentName: "깽이",
      displayName: "하늘",
      workspaceDir: "/tmp",
      signal: new AbortController().signal,
      credentials: { find: async () => null, use: async () => Promise.reject(new Error("no")) },
      store: {} as ToolContext["store"],
      status: (s) => statuses.push(s),
      now: () => new Date(),
    };
  }

  /** capture Twilio requests; everything else (the fake TTS) goes through */
  function interceptTwilio(reply: (p: URLSearchParams) => Response) {
    const bodies: URLSearchParams[] = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).startsWith("https://api.twilio.com/")) {
        const p = new URLSearchParams(String(init?.body));
        bodies.push(p);
        return reply(p);
      }
      return realFetch(url as string, init);
    }) as typeof fetch;
    return bodies;
  }
  const queued = () => new Response(JSON.stringify({ sid: "CA1", status: "queued" }), { status: 201 });
  const PLAY = /<Play>https:\/\/audio\.example\.test\/a\/([0-9a-f]{32})\.mp3<\/Play>/;

  test("TTS + public URL → synthesized before dialling and played with <Play>", async () => {
    h = await makeHarness({ config: { twilio: TWILIO, tts: { url: fake.url } } });
    h.app.core.voice.setPublicBase("https://audio.example.test/");
    const { session } = await h.signup("haneul");
    const bodies = interceptTwilio(() => {
      expect(fake.calls).toHaveLength(1); // synthesis finished before the call was placed
      return queued();
    });
    const statuses: string[] = [];
    const r = await phoneTool(h.app.core).run({ to: "010-1234-5678", message: "안녕 <친구>" }, ctxFor(session.user.id, statuses));
    expect(r.ok).toBe(true);
    expect(statuses).toContain("목소리를 만드는 중");
    expect(fake.calls[0]!.text).toBe("안녕 <친구>");
    const twiml = bodies[0]!.get("Twiml")!;
    expect(twiml).toMatch(new RegExp(`^<Response>${PLAY.source}</Response>$`));
    expect(twiml).not.toContain("<Say");
    const token = PLAY.exec(twiml)![1]!;
    expect(h.app.core.voice.tokens.resolve(token)).toBe(join(h.dir, "tts", `${sha256Hex("pickle||안녕 <친구>")}.mp3`));
  });

  test("digits flow keeps Pause 4 / Play digits / Pause 5 / Play / Pause 1 / Play", async () => {
    h = await makeHarness({ config: { twilio: TWILIO, tts: { url: fake.url } } });
    h.app.core.voice.setPublicBase("https://audio.example.test");
    const { session } = await h.signup("haneul");
    const bodies = interceptTwilio(queued);
    const args = { to: "+1 636-373-8953", message: "테스트 전화예요", name: "relay daily 회의", digits: "463 394 124#" };
    expect((await phoneTool(h.app.core).run(args, ctxFor(session.user.id))).ok).toBe(true);
    const twiml = bodies[0]!.get("Twiml")!;
    const url = PLAY.exec(twiml)![0]!;
    expect(twiml).toBe(`<Response><Pause length="4"/><Play digits="463394124#"/><Pause length="5"/>${url}<Pause length="1"/>${url}</Response>`);
  });

  test("trial: the Echo twimlet fallback carries the <Play> TwiML", async () => {
    h = await makeHarness({ config: { twilio: TWILIO, tts: { url: fake.url } } });
    h.app.core.voice.setPublicBase("https://audio.example.test");
    const { session } = await h.signup("haneul");
    const bodies = interceptTwilio((p) =>
      p.has("Twiml") ? new Response(JSON.stringify({ code: 0, message: "limited parameter access" }), { status: 400 }) : queued(),
    );
    expect((await phoneTool(h.app.core).run({ to: "01012345678", message: "안녕" }, ctxFor(session.user.id))).ok).toBe(true);
    expect(bodies).toHaveLength(2);
    const twiml = bodies[0]!.get("Twiml")!;
    expect(twiml).toMatch(PLAY);
    expect(bodies[1]!.get("Url")).toBe("https://twimlets.com/echo?Twiml=" + encodeURIComponent(twiml));
  });

  test("busy service (queue ≥ 2) → <Say> at once without queueing a line; queue 1 still plays; a cached line plays even when busy", async () => {
    h = await makeHarness({ config: { twilio: TWILIO, tts: { url: fake.url } } });
    h.app.core.voice.setPublicBase("https://audio.example.test");
    const { session } = await h.signup("haneul");
    const bodies = interceptTwilio(queued);
    fake.queue = 2;
    expect((await phoneTool(h.app.core).run({ to: "01012345678", message: "바쁠 때" }, ctxFor(session.user.id))).ok).toBe(true);
    expect(fake.calls).toHaveLength(0);
    expect(bodies[0]!.get("Twiml")).toBe(phoneTwiml("바쁠 때"));
    fake.queue = 1;
    expect((await phoneTool(h.app.core).run({ to: "01012345678", message: "한 줄 대기" }, ctxFor(session.user.id))).ok).toBe(true);
    expect(fake.calls).toHaveLength(1);
    expect(bodies[1]!.get("Twiml")).toMatch(PLAY);
    fake.queue = 5;
    expect((await phoneTool(h.app.core).run({ to: "01012345678", message: "한 줄 대기" }, ctxFor(session.user.id))).ok).toBe(true);
    expect(fake.calls).toHaveLength(1); // served from the disk cache
    expect(bodies[2]!.get("Twiml")).toMatch(PLAY);
    expect(PHONE_TTS_WAIT_MS).toBe(45_000);
  });

  test("TTS failure → falls back to <Say language=\"ko-KR\">", async () => {
    h = await makeHarness({ config: { twilio: TWILIO, tts: { url: fake.url } } });
    h.app.core.voice.setPublicBase("https://audio.example.test");
    const { session } = await h.signup("haneul");
    fake.mode = "fail";
    const bodies = interceptTwilio(queued);
    expect((await phoneTool(h.app.core).run({ to: "01012345678", message: "안녕" }, ctxFor(session.user.id))).ok).toBe(true);
    expect(fake.calls).toHaveLength(1);
    expect(bodies[0]!.get("Twiml")).toBe(phoneTwiml("안녕"));
    expect(h.app.core.voice.tokens.size).toBe(0);
  });

  test("TTS unreachable or no public audio URL → <Say>, and no synthesis without a public URL", async () => {
    h = await makeHarness({ config: { twilio: TWILIO, tts: { url: fake.url } } });
    const { session } = await h.signup("haneul");
    const bodies = interceptTwilio(queued);
    expect((await phoneTool(h.app.core).run({ to: "01012345678", message: "안녕" }, ctxFor(session.user.id))).ok).toBe(true);
    expect(fake.calls).toHaveLength(0);
    expect(bodies[0]!.get("Twiml")).toBe('<Response><Say language="ko-KR">안녕</Say></Response>');
    await h.close();

    h = await makeHarness({ config: { twilio: TWILIO, tts: { url: deadUrl() } } });
    h.app.core.voice.setPublicBase("https://audio.example.test");
    const s2 = await h.signup("haneul");
    const bodies2 = interceptTwilio(queued);
    expect((await phoneTool(h.app.core).run({ to: "01012345678", message: "안녕" }, ctxFor(s2.session.user.id))).ok).toBe(true);
    expect(bodies2[0]!.get("Twiml")).toBe('<Response><Say language="ko-KR">안녕</Say></Response>');
  });
});
