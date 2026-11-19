import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { halfRateS16le } from "../src/audio.ts";
import { makeHarness, type Harness } from "./helpers.ts";

// ───────────────────────────── fake services/tts with POST /tts/stream ─────────────────────────────

interface FakeStream {
  url: string;
  queue: number;
  /** status for /tts/stream (200 streams `chunks`) */
  status: number;
  chunks: Uint8Array[];
  delayMs: number;
  requests: number;
  finished: boolean;
  cancelled: boolean;
  stop(): void;
}

/** n samples of a deterministic s16le waveform */
function pcm(n: number, seed = 1): Uint8Array {
  const out = new Uint8Array(n * 2);
  const v = new DataView(out.buffer);
  for (let i = 0; i < n; i++) v.setInt16(i * 2, Math.round(Math.sin((i + seed) / 7) * 12_000 + ((i * 7919) % 2001) - 1000), true);
  return out;
}

function startFake(): FakeStream {
  const st: FakeStream = { url: "", queue: 0, status: 200, chunks: [], delayMs: 150, requests: 0, finished: false, cancelled: false, stop: () => {} };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 30,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/health") return Response.json({ ok: true, ready: true, voices: ["pickle"], sampleRate: 44100, queue: st.queue, busyMs: 0 });
      if (path !== "/tts/stream") return Response.json({ error: "not_found" }, { status: 404 });
      st.requests++;
      await req.json();
      if (st.status !== 200) return Response.json({ error: st.status === 503 ? "loading" : "synthesis_failed" }, { status: st.status });
      req.signal.addEventListener("abort", () => (st.cancelled = true));
      let i = 0;
      const body = new ReadableStream<Uint8Array>({
        async pull(ctrl) {
          if (i > 0) await Bun.sleep(st.delayMs);
          if (st.cancelled) return ctrl.close();
          if (i >= st.chunks.length) {
            st.finished = true;
            return ctrl.close();
          }
          ctrl.enqueue(st.chunks[i++]!);
        },
        cancel() {
          st.cancelled = true;
        },
      });
      return new Response(body, { headers: { "Content-Type": "audio/L16", "X-Sample-Rate": "44100", "Cache-Control": "no-store" } });
    },
  });
  st.url = `http://127.0.0.1:${server.port}`;
  st.stop = () => server.stop(true);
  return st;
}

let fake: FakeStream;
beforeAll(() => {
  fake = startFake();
});
afterAll(() => fake.stop());
afterEach(() => {
  Object.assign(fake, { queue: 0, status: 200, chunks: [], delayMs: 150, requests: 0, finished: false, cancelled: false });
});

// ───────────────────────────── downsampler ─────────────────────────────

describe("halfRateS16le", () => {
  test("[1,2,1]/4 low-pass + decimation, identical for any chunking (odd bytes, odd samples)", () => {
    const input = pcm(1001);
    const iv = new DataView(input.buffer);
    const expected: number[] = [];
    let prev = 0;
    for (let i = 0; i + 1 < 1001; i += 2) {
      const a = iv.getInt16(i * 2, true);
      const b = iv.getInt16(i * 2 + 2, true);
      expected.push((prev + 2 * a + b + 2) >> 2);
      prev = b;
    }
    const samples = (b: Uint8Array) => Array.from({ length: b.byteLength / 2 }, (_, i) => new DataView(b.buffer, b.byteOffset).getInt16(i * 2, true));
    for (const sizes of [[input.byteLength], [1, 3, 5, 7, 11, 13], [2], [4], [999, 1, 1002]]) {
      const conv = halfRateS16le();
      const parts: Uint8Array[] = [];
      let off = 0;
      let k = 0;
      while (off < input.byteLength) {
        const n = sizes[k++ % sizes.length]!;
        parts.push(conv(input.subarray(off, off + n)));
        off += n;
      }
      const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
      let o = 0;
      for (const p of parts) {
        out.set(p, o);
        o += p.byteLength;
      }
      expect(samples(out)).toEqual(expected);
    }
    // full scale never overflows
    const loud = new Uint8Array(8);
    new DataView(loud.buffer).setInt16(0, 32767, true);
    new DataView(loud.buffer).setInt16(2, 32767, true);
    new DataView(loud.buffer).setInt16(4, -32768, true);
    new DataView(loud.buffer).setInt16(6, -32768, true);
    const r = halfRateS16le()(loud);
    expect(Math.abs(new DataView(r.buffer).getInt16(2, true))).toBeLessThanOrEqual(32768);
  });
});

// ───────────────────────────── POST /api/tts/stream ─────────────────────────────

describe("POST /api/tts/stream", () => {
  let h: Harness;
  let server: ReturnType<typeof Bun.serve> | null = null;
  afterEach(async () => {
    server?.stop(true);
    server = null;
    await h.close();
  });

  /** the app on a real socket, so streaming and disconnects behave like production */
  function listen(): string {
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (req, srv) => h.app.fetch(req, srv) });
    return `http://127.0.0.1:${server.port}`;
  }
  const post = (base: string, token: string, text: string, signal?: AbortSignal) =>
    fetch(`${base}/api/tts/stream`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ text }), signal });

  test("first chunk reaches the client while the upstream is still producing; 22.05 kHz s16le headers", async () => {
    h = await makeHarness({ config: { tts: { url: fake.url } } });
    const { token } = await h.signup("haneul");
    const base = listen();
    fake.chunks = [pcm(882, 1), pcm(882, 2), pcm(882, 3), pcm(882, 4), pcm(882, 5)];
    fake.delayMs = 250; // upstream needs ≥ 1 s in total
    const t0 = performance.now();
    const res = await post(base, token, "안녕하세요, 모시예요. 오늘 날씨 알려 드릴게요.");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("audio/L16; rate=22050; channels=1");
    expect(res.headers.get("x-sample-rate")).toBe("22050");
    expect(res.headers.get("x-sample-format")).toBe("s16le");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-length")).toBeNull();
    const reader = res.body!.getReader();
    const first = await reader.read();
    const firstMs = performance.now() - t0;
    expect(first.done).toBe(false);
    expect(first.value!.byteLength).toBe(882); // 882 samples → 441 samples × 2 bytes
    expect(fake.finished).toBe(false);
    expect(firstMs).toBeLessThan(600);
    let total = first.value!.byteLength;
    for (;;) {
      const r = await reader.read();
      if (r.done) break;
      total += r.value.byteLength;
    }
    expect(total).toBe((5 * 882 * 2) / 2);
    expect(fake.finished).toBe(true);
    expect(performance.now() - t0).toBeGreaterThan(900);
  });

  test("client abort cancels the upstream request", async () => {
    h = await makeHarness({ config: { tts: { url: fake.url } } });
    const { token } = await h.signup("haneul");
    const base = listen();
    fake.chunks = Array.from({ length: 40 }, (_, i) => pcm(882, i));
    fake.delayMs = 100;
    const logs: string[] = [];
    h.app.core.log = { info: (e, f) => logs.push(`${e} ${JSON.stringify(f)}`), warn: (e, f) => logs.push(`${e} ${JSON.stringify(f)}`), error: () => {} };
    const ac = new AbortController();
    const res = await post(base, token, "길게 말하는 문장", ac.signal);
    const reader = res.body!.getReader();
    expect((await reader.read()).done).toBe(false);
    ac.abort();
    for (let i = 0; i < 40 && !fake.cancelled; i++) await Bun.sleep(25);
    expect(fake.cancelled).toBe(true);
    expect(fake.finished).toBe(false);
    const line = logs.find((l) => l.startsWith("tts stream {"))!;
    expect(line).toContain('"outcome":"client_gone"');
    expect(line).not.toContain("길게");
  });

  test("auth, validation, 503 when off / busy (queue ≥ 2) / loading / failing", async () => {
    h = await makeHarness();
    expect((await h.req("POST", "/api/tts/stream", { body: { text: "안녕" } })).status).toBe(401);
    const a = await h.signup("haneul");
    const off = await h.req("POST", "/api/tts/stream", { token: a.token, body: { text: "안녕" } });
    expect(off.status).toBe(503);
    expect(await off.json()).toMatchObject({ error: "tts_unavailable" });
    await h.close();

    h = await makeHarness({ config: { tts: { url: fake.url } } });
    const { token } = await h.signup("haneul");
    expect((await h.req("POST", "/api/tts/stream", { token, body: { text: "  " } })).status).toBe(400);
    const long = await h.req("POST", "/api/tts/stream", { token, body: { text: "가".repeat(601) } });
    expect(long.status).toBe(400);
    expect(((await long.json()) as { error: string }).error).toBe("text_too_long");

    fake.queue = 2;
    const busy = await h.req("POST", "/api/tts/stream", { token, body: { text: "바빠요" } });
    expect(busy.status).toBe(503);
    expect(await busy.json()).toMatchObject({ error: "tts_unavailable" });
    expect(fake.requests).toBe(0); // never queued a line
    fake.queue = 1;
    fake.chunks = [pcm(10)];
    const one = await h.req("POST", "/api/tts/stream", { token, body: { text: "한 줄 대기 중" } });
    expect(one.status).toBe(200);
    expect((await one.arrayBuffer()).byteLength).toBe(10);
    fake.queue = 0;

    for (const status of [503, 500]) {
      fake.status = status;
      const r = await h.req("POST", "/api/tts/stream", { token, body: { text: "실패" } });
      expect(r.status).toBe(503);
      expect(await r.json()).toMatchObject({ error: "tts_unavailable" });
    }
  });

  test("shares /api/tts's per-user rate limit", async () => {
    h = await makeHarness({ config: { tts: { url: fake.url } } });
    const { token } = await h.signup("haneul");
    for (let i = 0; i < 15; i++) await h.req("POST", "/api/tts", { token, body: { text: "" } });
    for (let i = 0; i < 15; i++) await h.req("POST", "/api/tts/stream", { token, body: { text: "" } });
    expect((await h.req("POST", "/api/tts/stream", { token, body: { text: "" } })).status).toBe(429);
  });
});
