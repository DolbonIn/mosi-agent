// 구글 없이 끝까지: 로컬 페이지의 RTCPeerConnection 두 개(A → B)를 잇고,
//  A 마이크 = 주입한 getUserMedia(가상 마이크), B 원격 트랙 = 주입한 캡처 훅.
//  POST /say → TTS → A → WebRTC(Opus) → B 캡처 → VAD → STT → SSE transcript 가 원문과 같은지 본다.
//
//   bun services/meet/test/loopback.e2e.ts [--script-processor] [--fixed-wav]
//
// 환경: MEET_STT_URL(기본 http://127.0.0.1:8782), MEET_TTS_URL(기본 http://127.0.0.1:8790), Chrome(channel "chrome").
//       MEET_VAD_HANGOVER_MS·MEET_STT(soniox|local)·SONIOX_API_KEY·MEET_FINALIZE_SILENCE_MS는 서비스와 같다
//       (Soniox로 돌리려면 `bun --env-file=~/.config/pickle-clone/secrets.env ...`).
//       MEET_E2E_TEXT(받아 적기 기준 문장)·MEET_E2E_ACK_REF(가짜 맞장구 = wav 첫 마디의 글자): 다른 wav(MEET_E2E_DIR/fixed-say.wav)를 쓸 때. MEET_E2E_PAUSES(기본 "450,600"): 쉼 시험에 넣을 쉼 길이(ms).
// TTS가 바쁘면(queue ≥ 2) 또는 --fixed-wav면 미리 만들어 둔 wav를 흘려 주는 가짜 TTS를 쓴다
//  (맞장구 문장은 그 wav의 첫 마디 "안녕하세요,"를, 쉼 시험 문장은 마디 사이 쉼을 MEET_E2E_PAUSES로 바꾼 소리를 준다).
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bytesToInt16, concatInt16, encodeWav, int16ToBytes, parseWav, rmsDb } from "../audio";
import { config } from "../config";
import { createApp } from "../server";
import { Session } from "../session";
import { serviceHealth } from "../stt";

const args = new Set(process.argv.slice(2));
const SCRIPT_PROCESSOR = args.has("--script-processor");
const SCRATCH = process.env.MEET_E2E_DIR ?? join(tmpdir(), "mosi-meet-e2e");
mkdirSync(SCRATCH, { recursive: true });
const PROFILE = join(SCRATCH, `profile-${process.pid}`);
const WAV_CACHE = join(SCRATCH, "fixed-say.wav");

const TEXT = process.env.MEET_E2E_TEXT ?? "안녕하세요, 모시예요. 오늘 회의 내용을 받아 적고 있어요.";
const STOP_TEXT = "끼어들기 시험이에요. 이 문장은 중간에 끊겨야 해요. 끝까지 들리면 안 됩니다.";
const ACK_TEXTS = ["네,", "네, 잠시만요."];
const ACK_REF = process.env.MEET_E2E_ACK_REF ?? "안녕하세요,";
const ACK_REPS = 5;
// 가짜 TTS에서 쉼 시험용으로 알아보는 문장(받아 적기 기준은 TEXT)
const PAUSE_TEXT = "안녕하세요. 모시예요. 오늘 회의 내용을 받아 적고 있어요.";
const PAUSES = (process.env.MEET_E2E_PAUSES ?? "450,600").split(",").map(Number).filter((n) => n > 0);
const ttsStreamRequests: { at: number; chars: number }[] = [];

/** 소리 구간들(10 ms 창, -45 dBFS, 80 ms 넘는 쉼에서 나눔) */
function speechRegions(pcm: Int16Array, rate: number): { start: number; end: number }[] {
  const step = Math.round(rate / 100);
  const out: { start: number; end: number }[] = [];
  let cur: { start: number; end: number } | null = null;
  for (let i = 0; i + step <= pcm.length; i += step) {
    if (rmsDb(pcm, i, i + step) < -45) continue;
    if (cur && i - cur.end <= rate * 0.08) cur.end = i + step;
    else {
      if (cur) out.push(cur);
      cur = { start: i, end: i + step };
    }
  }
  if (cur) out.push(cur);
  return out;
}

const results: Record<string, unknown> = { mode: SCRIPT_PROCESSOR ? "script-processor" : "worklet" };
let failed = false;
function check(name: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail !== undefined ? `  ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (!ok) failed = true;
}

const norm = (s: string) => s.normalize("NFC").replace(/[\s.,!?·…'"“”‘’~\-]/g, "");
function cer(ref: string, hyp: string): number {
  const a = [...norm(ref)];
  const b = [...norm(hyp)];
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length]![b.length]! / Math.max(1, a.length);
}

// ---------------------------------------------------------------- 루프백 페이지
const PAGE = `<!doctype html><html lang="ko"><meta charset="utf-8"><title>mosi loopback</title><body><p>loopback</p><script>
(async () => {
  const diag = (window.__diag = { webdriver: navigator.webdriver, steps: [] });
  try {
    const a = new RTCPeerConnection(), b = new RTCPeerConnection();
    a.onicecandidate = (e) => e.candidate && b.addIceCandidate(e.candidate);
    b.onicecandidate = (e) => e.candidate && a.addIceCandidate(e.candidate);
    // Meet처럼 deviceId·처리 옵션을 붙여 요청한다(무시되고 가상 마이크가 와야 한다)
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: "default" }, echoCancellation: true, noiseSuppression: true }, video: { width: 640 } });
    const at = stream.getAudioTracks()[0], vt = stream.getVideoTracks()[0];
    diag.micLabel = at.label; diag.micDeviceId = at.getSettings().deviceId; diag.hasVideo = !!vt; diag.videoLabel = vt && vt.label;
    await at.applyConstraints({ echoCancellation: false });
    diag.applied = at.getConstraints().echoCancellation === false;
    const devs = await navigator.mediaDevices.enumerateDevices();
    diag.devices = devs.map((d) => d.kind + ":" + d.label);
    diag.devicesJson = JSON.stringify(devs.filter((d) => d.kind === "audioinput")[0]);
    diag.gumNative = Function.prototype.toString.call(navigator.mediaDevices.getUserMedia).includes("[native code]");
    diag.pcNative = Function.prototype.toString.call(RTCPeerConnection).includes("[native code]");
    diag.pcInstance = a instanceof RTCPeerConnection;
    a.addTrack(at, stream);
    let bTracks = 0; b.ontrack = () => { bTracks++; diag.bTracks = bTracks; };
    const offer = await a.createOffer(); await a.setLocalDescription(offer); await b.setRemoteDescription(offer);
    const answer = await b.createAnswer(); await b.setLocalDescription(answer); await a.setRemoteDescription(answer);
    const t0 = performance.now();
    while (a.connectionState !== "connected" && performance.now() - t0 < 10000) await new Promise((r) => setTimeout(r, 50));
    diag.connectMs = Math.round(performance.now() - t0); diag.connection = a.connectionState;
    window.__loopbackReady = a.connectionState === "connected";
    // 받는 쪽 지터 버퍼(NetEq) 지연을 0.5초마다 기록: 상대 쪽에서 소리가 늦게 들리면 어디서 늦는지 가린다
    diag.rtp = []; let prev = null;
    setInterval(async () => {
      const st = await b.getStats(); let r = null;
      st.forEach((x) => { if (x.type === "inbound-rtp" && x.kind === "audio") r = x; });
      if (!r) return;
      if (prev && r.jitterBufferEmittedCount > prev.jitterBufferEmittedCount) {
        const n = r.jitterBufferEmittedCount - prev.jitterBufferEmittedCount;
        diag.rtp.push({ t: Date.now(), jbMs: Math.round(((r.jitterBufferDelay - prev.jitterBufferDelay) / n) * 1000), targetMs: Math.round((((r.jitterBufferTargetDelay ?? 0) - (prev.jitterBufferTargetDelay ?? 0)) / n) * 1000), conceal: r.concealedSamples - prev.concealedSamples, accel: (r.removedSamplesForAcceleration ?? 0) - (prev.removedSamplesForAcceleration ?? 0) });
        if (diag.rtp.length > 600) diag.rtp.shift();
      }
      prev = r;
    }, 500);
  } catch (e) { diag.error = String(e); }
})();
</script></body></html>`;

const pageServer = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: (req) => (new URL(req.url).pathname === "/loopback.html" ? new Response(PAGE, { headers: { "Content-Type": "text/html; charset=utf-8" } }) : new Response("nf", { status: 404 })),
});

// ---------------------------------------------------------------- TTS: 진짜 또는 고정 wav
const realTts = config.ttsUrl;
const sttUrl = config.sttUrl;
const sttH = await serviceHealth(sttUrl, 2000);
if (!sttH?.ready) {
  console.error(`STT not ready at ${sttUrl} (set MEET_STT_URL)`);
  process.exit(2);
}
// STT 앞에 얇은 중계: 요청마다 STT 큐 길이와 왕복 시간을 기록하고, MEET_E2E_DUMP=1이면 구간을 wav로 남긴다(시험 디렉터리에만)
const sttLog: { queueBefore: number | null; audioMs: number; rtMs: number; serverMs: number }[] = [];
const sttProxy = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    const u = new URL(req.url);
    if (u.pathname !== "/stt") return fetch(`${sttUrl}${u.pathname}${u.search}`);
    const body = new Uint8Array(await req.arrayBuffer());
    if (process.env.MEET_E2E_DUMP === "1") writeFileSync(join(SCRATCH, `seg-${sttLog.length}.wav`), encodeWav(bytesToInt16(body), 16000));
    const q = await serviceHealth(sttUrl, 1000);
    const t0 = Date.now();
    const res = await fetch(`${sttUrl}/stt${u.search}`, { method: "POST", headers: { "Content-Type": req.headers.get("content-type") ?? "audio/L16; rate=16000" }, body });
    const text = await res.text();
    let serverMs = -1;
    try {
      serverMs = JSON.parse(text).ms;
    } catch {}
    sttLog.push({ queueBefore: q?.queue ?? null, audioMs: Math.round(body.byteLength / 32), rtMs: Date.now() - t0, serverMs });
    return new Response(text, { status: res.status, headers: { "Content-Type": "application/json" } });
  },
});
const ttsH = await serviceHealth(realTts, 2000);
let ttsUrl = realTts;
let fakeTts: ReturnType<typeof Bun.serve> | null = null;
const useFixed = args.has("--fixed-wav") || !ttsH?.ready || (ttsH.queue ?? 0) >= 2;
if (useFixed) {
  if (!existsSync(WAV_CACHE)) {
    if (!ttsH?.ready) {
      console.error("TTS down and no cached wav");
      process.exit(2);
    }
    const r = await fetch(`${realTts}/tts`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: TEXT, format: "wav" }) });
    writeFileSync(WAV_CACHE, new Uint8Array(await r.arrayBuffer()));
  }
  const wav = parseWav(new Uint8Array(readFileSync(WAV_CACHE)));
  const fullBytes = int16ToBytes(wav.pcm);
  // 마디: 120 ms 넘는 쉼에서 나눈 소리 구간들
  const regions = speechRegions(wav.pcm, wav.sampleRate);
  const phrases: { start: number; end: number }[] = [];
  for (const r of regions) {
    const last = phrases[phrases.length - 1];
    if (last && r.start - last.end < wav.sampleRate * 0.12) last.end = r.end;
    else phrases.push({ ...r });
  }
  const tail = Math.round(wav.sampleRate * 0.06);
  const ackBytes = int16ToBytes(wav.pcm.slice(phrases[0]!.start, phrases[0]!.end + tail));
  const parts: Int16Array[] = [];
  phrases.forEach((ph, i) => {
    if (i) parts.push(new Int16Array(Math.round((wav.sampleRate * PAUSES[(i - 1) % PAUSES.length]!) / 1000)));
    parts.push(wav.pcm.slice(ph.start, ph.end));
  });
  parts.push(new Int16Array(tail));
  const pausedBytes = int16ToBytes(concatInt16(parts));
  results.fakeTts = { phrases: phrases.map((p) => Math.round(((p.end - p.start) * 1000) / wav.sampleRate)), ackMs: Math.round(((ackBytes.length / 2) * 1000) / wav.sampleRate), pausesMs: PAUSES };
  fakeTts = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const p = new URL(req.url).pathname;
      if (p === "/health") return Response.json({ ok: true, ready: true, queue: 0 });
      if (p === "/tts/stream") {
        const text = String(((await req.json().catch(() => ({}))) as { text?: string }).text ?? "");
        ttsStreamRequests.push({ at: Date.now(), chars: text.length });
        const bytes = ACK_TEXTS.includes(text) ? ackBytes : text === PAUSE_TEXT ? pausedBytes : fullBytes;
        const step = Math.round(wav.sampleRate * 0.32) * 2;
        let o = 0;
        const s = new ReadableStream({
          async pull(c) {
            if (o >= bytes.length) return c.close();
            await Bun.sleep(o === 0 ? 250 : 200); // 실제 TTS처럼 첫 소리 ~0.25 s, 이후 실시간보다 약간 빠르게
            c.enqueue(bytes.slice(o, o + step));
            o += step;
          },
        });
        return new Response(s, { headers: { "Content-Type": "audio/L16", "X-Sample-Rate": String(wav.sampleRate) } });
      }
      return new Response("nf", { status: 404 });
    },
  });
  ttsUrl = `http://127.0.0.1:${fakeTts.port}`;
}
results.tts = useFixed ? "fixed-wav" : "real";
// 진짜 TTS 앞에도 얇은 중계: 첫 묶음 시각·묶음 간격을 기록하고, MEET_E2E_DUMP=1이면 TTS가 낸 소리 원본을 wav로 남긴다
const ttsLog: { firstChunkMs: number | null; chunks: number; audioMs: number; maxGapMs: number; totalMs: number }[] = [];
let ttsProxy: ReturnType<typeof Bun.serve> | null = null;
if (!useFixed) {
  const upstream = ttsUrl;
  ttsProxy = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    async fetch(req) {
      const u = new URL(req.url);
      if (u.pathname !== "/tts/stream") return fetch(`${upstream}${u.pathname}`, { method: req.method, headers: req.headers, body: req.method === "GET" ? undefined : await req.arrayBuffer() });
      const t0 = Date.now();
      ttsStreamRequests.push({ at: t0, chars: 0 });
      const res = await fetch(`${upstream}/tts/stream`, { method: "POST", headers: { "Content-Type": "application/json" }, body: await req.text(), signal: req.signal });
      const rate = Number(res.headers.get("x-sample-rate")) || 44100;
      const rec = { firstChunkMs: null as number | null, chunks: 0, audioMs: 0, maxGapMs: 0, totalMs: 0 };
      ttsLog.push(rec);
      const parts: Uint8Array[] = [];
      let last = t0;
      const reader = res.body!.getReader();
      const out = new ReadableStream<Uint8Array>({
        async pull(c) {
          const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined }));
          if (done || !value) {
            rec.totalMs = Date.now() - t0;
            if (process.env.MEET_E2E_DUMP === "1") {
              const all = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
              let o = 0;
              for (const p of parts) (all.set(p, o), (o += p.length));
              writeFileSync(join(SCRATCH, `tts-${ttsLog.length - 1}.wav`), encodeWav(bytesToInt16(all), rate));
            }
            return c.close();
          }
          const now = Date.now();
          if (rec.firstChunkMs === null) rec.firstChunkMs = now - t0;
          else rec.maxGapMs = Math.max(rec.maxGapMs, now - last);
          last = now;
          rec.chunks++;
          rec.audioMs += Math.round((value.byteLength / 2 / rate) * 1000);
          parts.push(value);
          c.enqueue(value);
        },
        cancel() {
          reader.cancel().catch(() => {});
        },
      });
      return new Response(out, { headers: { "Content-Type": "audio/L16", "X-Sample-Rate": String(rate) } });
    },
  });
  ttsUrl = `http://127.0.0.1:${ttsProxy.port}`;
}

// ---------------------------------------------------------------- 서비스(같은 프로세스, 진짜 HTTP)
const cfg = { ...config, ackTexts: ACK_TEXTS, testLoopback: true, profileDir: PROFILE, ttsUrl, sttUrl: `http://127.0.0.1:${sttProxy.port}`, forceScriptProcessor: SCRIPT_PROCESSOR, headless: process.env.MEET_HEADLESS === "1" };
let session: Session | null = null;
const app = createApp(cfg, {
  makeSession: (init) => (session = new Session(init, cfg)),
});
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, fetch: app.fetch });
const base = `http://127.0.0.1:${server.port}`;

type Ev = { event: string; data: any; at: number };
const events: Ev[] = [];
/** SSE 이벤트를 받는 즉시 부른다(대답 쪽 흉내: transcript를 받자마자 맞장구) */
let onEvent: ((e: Ev) => void) | null = null;
async function readSse(id: string) {
  const res = await fetch(`${base}/sessions/${id}/events`);
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const ev = /^event: (.+)$/m.exec(block)?.[1];
      const data = /^data: (.+)$/m.exec(block)?.[1];
      if (ev && data) {
        const e = { event: ev, data: JSON.parse(data), at: Date.now() };
        events.push(e);
        onEvent?.(e);
      }
    }
  }
}
/** 새 transcript가 stableMs 동안 없을 때까지 기다린다 */
async function transcriptsSettle(stableMs: number): Promise<void> {
  for (let n = -1, since = Date.now(); Date.now() - since < stableMs; await Bun.sleep(100)) {
    const k = events.filter((e) => e.event === "transcript").length;
    if (k !== n) [n, since] = [k, Date.now()];
  }
}
/** after 이후에 온 transcript가 하나 생길 때까지(최대 timeoutMs) 기다린 뒤 stableMs 동안 조용해지기를 기다린다 */
async function transcriptAfter(after: number, timeoutMs: number, stableMs: number): Promise<void> {
  await waitFor((e) => e.event === "transcript" && e.at >= after, timeoutMs);
  await transcriptsSettle(stableMs);
}
const median = (xs: number[]) => {
  const v = xs.filter(Number.isFinite).sort((a, b) => a - b);
  return v.length ? v[Math.floor((v.length - 1) / 2)]! : NaN;
};
async function waitFor(pred: (e: Ev) => boolean, timeoutMs: number): Promise<Ev | null> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const e = events.find(pred);
    if (e) return e;
    await Bun.sleep(25);
  }
  return null;
}

const cleanup = async () => {
  try {
    await app.shutdown();
  } catch {}
  server.stop(true);
  pageServer.stop(true);
  fakeTts?.stop(true);
  sttProxy.stop(true);
  ttsProxy?.stop(true);
  rmSync(PROFILE, { recursive: true, force: true });
};

const tStart = Date.now();
const phaseAtMs: Record<string, number> = {};
results.phaseAtMs = phaseAtMs;
const phase = (name: string) => (phaseAtMs[name] = Date.now() - tStart);
try {
  let r = await fetch(`${base}/sessions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: `http://127.0.0.1:${pageServer.port}/loopback.html`, test: "loopback" }) });
  check("POST /sessions → 201", r.status === 201);
  const { id } = (await r.json()) as { id: string };
  void readSse(id);
  const inCall = await waitFor((e) => e.event === "state" && e.data.state === "in_call", 40_000);
  check("state → in_call", !!inCall, events.filter((e) => e.event === "state").map((e) => e.data.state).join(" > "));
  if (!inCall) throw new Error("no in_call");

  const dbg0 = (await (await fetch(`${base}/sessions/${id}/debug`)).json()) as any;
  const diag = dbg0.page?.diag ?? {};
  results.diag = diag;
  check("navigator.webdriver is false", diag.webdriver === false);
  check("getUserMedia returns virtual mic (deviceId constraint ignored)", diag.micLabel === "모시 마이크" && diag.micDeviceId === "mosi-virtual-mic", { label: diag.micLabel, id: diag.micDeviceId });
  check("video request gets synthetic camera (never the real one)", diag.hasVideo === true && diag.videoLabel === "모시 카메라");
  check("applyConstraints accepted", diag.applied === true);
  check("enumerateDevices shows only virtual inputs and neutral outputs", Array.isArray(diag.devices) && diag.devices.filter((d: string) => /^audioinput|^videoinput/.test(d)).every((d: string) => d.includes("모시")) && !diag.devices.some((d: string) => /fake/i.test(d)), diag.devices);
  check("patched functions still print as native", diag.gumNative === true && diag.pcNative === true && diag.pcInstance === true);
  await Bun.sleep(1500); // 캡처 그래프가 돌기 시작하게
  const dbg1 = (await (await fetch(`${base}/sessions/${id}/debug`)).json()) as any;
  const cap = dbg1.page?.capture;
  results.capture = cap;
  check(`capture running (${cap?.mode}) with --mute-audio`, cap?.state === "running" && cap?.tracks >= 1 && cap?.chunks > 3, cap);
  check("capture mode as requested", cap?.mode === (SCRIPT_PROCESSOR ? "script" : "worklet"));

  // ---- /say → 캡처 → STT
  phase("main");
  const s = session as unknown as Session;
  const loud = s.nextCapturedLoud(130_000);
  const t0 = Date.now();
  r = await fetch(`${base}/sessions/${id}/say`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: TEXT }) });
  const tPost = Date.now();
  check("POST /say → 202", r.status === 202);
  const { sayId } = (await r.json()) as { sayId: string };
  const on = await waitFor((e) => e.event === "speaking" && e.data.on && e.data.sayId === sayId, 120_000); // 공용 GPU가 바쁘면 TTS 첫 소리가 수십 초 걸린 적이 있다
  const loudAt = await loud;
  const off = await waitFor((e) => e.event === "speaking" && !e.data.on && e.data.sayId === sayId, 60_000);
  check("speaking on/off for the line", !!on && !!off);
  const tr = await waitFor((e) => e.event === "transcript", 20_000);
  // 문장 사이 쉼이 길면 구간이 둘 이상일 수 있다: 1.2 s 동안 새 transcript가 없을 때까지 기다린다
  for (let n = -1, stableSince = Date.now(); Date.now() - stableSince < 1200; await Bun.sleep(100)) {
    const k = events.filter((e) => e.event === "transcript").length;
    if (k !== n) [n, stableSince] = [k, Date.now()];
  }
  const allTr = events.filter((e) => e.event === "transcript");
  const mainLastLoud = s.lastCapturedLoud();
  const mainEp = allTr.length ? events.find((e) => e.event === "endpoint" && e.data.seq === allTr[allTr.length - 1]!.data.seq) : undefined;
  results.main = {
    hangoverMs: cfg.vadHangoverMs,
    segments: allTr.length,
    lastLoudToEndpointMs: mainEp && mainLastLoud ? mainEp.at - mainLastLoud : null,
    lastLoudToTranscriptMs: allTr.length && mainLastLoud ? allTr[allTr.length - 1]!.at - mainLastLoud : null,
  };
  const heard = allTr.map((e) => e.data.text).join(" ");
  const c = cer(TEXT, heard);
  results.sayToSpeakingOnMs = on ? on.at - t0 : null;
  results.sayToFirstCapturedAudioMs = loudAt ? loudAt - t0 : null;
  results.sayPostMs = tPost - t0;
  results.speakingOffToTranscriptMs = tr && off ? tr.at - off.at : null;
  results.transcript = { original: TEXT, heard, segments: allTr.length, cer: Number(c.toFixed(3)), exactAfterNormalize: norm(TEXT) === norm(heard) };
  results.transcriptEvents = allTr.map((e) => ({ seq: e.data.seq, durMs: e.data.endMs - e.data.startMs, speaker: e.data.speaker }));
  check("first captured audio after /say", loudAt !== null && Number.isFinite(loudAt), `${results.sayToFirstCapturedAudioMs} ms`);
  check("transcript matches spoken text (CER ≤ 0.1)", c <= 0.1, { heard, cer: c });

  // ---- 실시간 STT(Soniox): 호출어가 partial에 보이는 시각, 말 끝 → endpoint → transcript, 말 끝 → 맞장구 첫 소리
  const engine = s.debugStats().sttEngine;
  results.sttEngine = engine;
  if (engine === "soniox") {
    phase("realtime");
    await transcriptsSettle(1500);
    const t = Date.now();
    const loud = s.nextCapturedLoud(10_000);
    let rid = "";
    let epEv: Ev | null = null;
    let voiceEnd: number | null = null;
    let ackPostAt = 0;
    let ackLoud: Promise<number | null> = Promise.resolve(null);
    let wakeSeen = false;
    onEvent = (e) => {
      if (e.at < t || epEv) return;
      if (e.event === "partial" && /모시/.test(e.data.text)) wakeSeen = true;
      if (e.event !== "endpoint" || !wakeSeen) return;
      // 대답 쪽(voice) 흉내: 호출어가 partial에 보인 발화의 endpoint에서 캐시된 "네,".
      // 루프백에서는 말소리와 맞장구가 같은 마이크 대기열이라, 말이 다 나간 뒤(speaking off)의 endpoint만 쓴다
      if (!events.some((x) => x.event === "speaking" && !x.data.on && x.data.sayId === rid)) return;
      epEv = e;
      voiceEnd = s.lastCapturedLoud();
      ackLoud = s.nextCapturedLoud(5000);
      ackPostAt = Date.now();
      void fetch(`${base}/sessions/${id}/say`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: ACK_TEXTS[0], cached: true }) });
    };
    const rr = await fetch(`${base}/sessions/${id}/say`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: TEXT }) });
    rid = ((await rr.json()) as { sayId: string }).sayId;
    const onset = await loud;
    await waitFor((e) => e.event === "speaking" && !e.data.on && e.data.sayId === rid, 60_000);
    await waitFor(() => epEv !== null, 8000);
    onEvent = null;
    const ep = epEv as Ev | null;
    const tr = ep ? await waitFor((e) => e.event === "transcript" && e.data.seq === ep.data.seq, 5000) : null;
    const ackAt = await ackLoud;
    const wake = events.find((e) => (e.event === "partial" || e.event === "transcript") && e.at >= t && /모시/.test(e.data.text));
    const utts = events.filter((e) => e.event === "transcript" && e.at >= t && (!tr || e.at <= tr.at));
    const eps = events.filter((e) => e.event === "endpoint" && e.at >= t && (!tr || e.at <= tr.at));
    const parts = events.filter((e) => e.event === "partial" && e.at >= t && (!tr || e.at <= tr.at));
    const partsAfterEp = ep && tr ? events.filter((e) => e.event === "partial" && e.at > ep.at && e.at < tr.at) : [];
    // 발화마다 endpoint(seq) 다음에 같은 seq의 transcript
    const paired = utts.every((u) => {
      const p = events.find((x) => x.event === "endpoint" && x.data.seq === u.data.seq);
      return !!p && p.at <= u.at;
    });
    let maxRate = 0;
    for (const p of parts) maxRate = Math.max(maxRate, parts.filter((q) => q.at >= p.at && q.at < p.at + 1000).length);
    const c = tr ? cer(TEXT, utts.map((e) => e.data.text).join(" ")) : 1;
    results.realtime = {
      transcripts: utts.map((e) => e.data.text),
      endpoints: eps.map((e) => e.data.seq),
      wakeSeenIn: wake?.event ?? null,
      cer: Number(c.toFixed(3)),
      voiceMs: onset && voiceEnd ? voiceEnd - onset : null,
      wakeInPartialAfterOnsetMs: wake && onset ? wake.at - onset : null,
      wakeInPartialBeforeVoiceEndMs: wake && voiceEnd ? voiceEnd - wake.at : null,
      endpointAfterVoiceEndMs: ep && voiceEnd ? ep.at - voiceEnd : null,
      transcriptAfterEndpointMs: ep && tr ? tr.at - ep.at : null,
      finAfterVoiceEndMs: tr && voiceEnd ? tr.at - voiceEnd : null,
      ackFirstAudioAfterVoiceEndMs: ackAt && voiceEnd ? ackAt - voiceEnd : null,
      ackFirstAudioAfterEndpointMs: ackAt ? ackAt - ackPostAt : null,
      partials: parts.length,
      partialsPerSecMax: maxRate,
      partialsBetweenEndpointAndTranscript: partsAfterEp.length,
      soniox: s.debugStats().soniox,
    };
    check("realtime: utterance transcribed (CER ≤ 0.15)", c <= 0.15, results.realtime);
    check("realtime: wake word visible (partial or transcript) before the voice ends", !!wake && !!voiceEnd && wake.at < voiceEnd, wake?.event);
    check("realtime: every transcript follows an endpoint with the same seq; no partial in between", paired && partsAfterEp.length === 0 && !!tr, { paired, between: partsAfterEp.length });
    check("realtime: partial ≤ 5/s", maxRate <= 5, maxRate);
    check("realtime: voice end → endpoint ≤ 0.5 s, → transcript ≤ 1.0 s", !!ep && !!tr && voiceEnd !== null && ep.at - voiceEnd <= 500 && tr.at - voiceEnd <= 1000, `endpoint ${(results.realtime as any).endpointAfterVoiceEndMs} ms, transcript ${(results.realtime as any).finAfterVoiceEndMs} ms`);
    await Bun.sleep(1500);
  }

  // ---- 맞장구(cached): 세션 시작 때 만들어 둔 소리를 TTS 없이 바로
  phase("ack");
  const say = (body: Record<string, unknown>) => fetch(`${base}/sessions/${id}/say`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  {
    let ready = false;
    for (const t = Date.now(); Date.now() - t < 30_000; await Bun.sleep(100)) if ((ready = s.debugStats().acks.clips.length >= ACK_TEXTS.length)) break;
    results.acks = s.debugStats().acks;
    check("ack clips rendered once at session start", ready, results.acks);
    const snap = (await (await fetch(`${base}/sessions/${id}`)).json()) as { acks?: string[] };
    check("GET /sessions/:id lists the cached acks", ACK_TEXTS.every((t) => snap.acks?.includes(t)), snap.acks);
    const ttsBefore = ttsStreamRequests.length;
    const first: number[] = [];
    const post: number[] = [];
    const onMs: number[] = [];
    for (let i = 0; i < ACK_REPS; i++) {
      await Bun.sleep(900);
      const loud = s.nextCapturedLoud(5000);
      const t = Date.now();
      const ra = await say({ text: ACK_TEXTS[i % 2], cached: true });
      post.push(Date.now() - t);
      const ja = (await ra.json()) as { sayId: string; cached?: boolean };
      if (ra.status !== 202 || !ja.cached) {
        check("cached say → 202 {cached:true}", false, { status: ra.status, ja });
        break;
      }
      const la = await loud;
      first.push(la !== null ? la - t : NaN);
      const onA = await waitFor((e) => e.event === "speaking" && e.data.on && e.data.sayId === ja.sayId, 3000);
      onMs.push(onA ? onA.at - t : NaN);
      const offA = await waitFor((e) => e.event === "speaking" && !e.data.on && e.data.sayId === ja.sayId, 5000);
      if (offA) await transcriptAfter(offA.at, 6000, 300);
    }
    results.ack = { farSideFirstAudioMs: first, medianMs: median(first), maxMs: Math.max(...first), postMs: post, speakingOnMs: onMs, ttsCallsDuring: ttsStreamRequests.length - ttsBefore };
    check("cached ack: zero TTS calls", ttsStreamRequests.length === ttsBefore, `${ttsStreamRequests.length - ttsBefore} calls`);
    check("cached ack: far-side first audio ≤ 150 ms (median)", median(first) <= 150, `median ${median(first)} ms, all ${first.join("/")} ms`);
    // 캐시에 없는 문장은 일반 TTS로 말한다(계약 §2)
    const ttsBefore2 = ttsStreamRequests.length;
    const rNo = await say({ text: "캐시에 없는 말", cached: true });
    const jNo = (await rNo.json()) as { sayId: string; cached?: boolean };
    const offNo = await waitFor((e) => e.event === "speaking" && !e.data.on && e.data.sayId === jNo.sayId, 60_000);
    check("uncached text with cached:true → 202 {cached:false}, spoken via TTS", rNo.status === 202 && jNo.cached === false && ttsStreamRequests.length === ttsBefore2 + 1 && !!offNo);
    if (offNo) await transcriptAfter(offNo.at, 8000, 300);
  }

  // ---- 맞장구 + 진짜 대답: 대답의 TTS는 맞장구가 나가는 동안 시작하고, 소리는 맞장구 끝에 바로 붙는다
  {
    await transcriptsSettle(1500);
    phase("chain");
    const trBefore = events.filter((e) => e.event === "transcript").length;
    const ttsBefore = ttsStreamRequests.length;
    const loud = s.nextCapturedLoud(5000);
    const t = Date.now();
    const ra = await say({ text: ACK_TEXTS[1], cached: true });
    const rb = await say({ text: TEXT });
    const { sayId: ackId } = (await ra.json()) as { sayId: string };
    const { sayId: ansId } = (await rb.json()) as { sayId: string };
    const la = await loud;
    const offAns = await waitFor((e) => e.event === "speaking" && !e.data.on && e.data.sayId === ansId, 120_000);
    if (offAns) await transcriptAfter(offAns.at, 10_000, 1500);
    const dbgC = (await (await fetch(`${base}/sessions/${id}/debug`)).json()) as any;
    const sched = (dbgC.page?.mic?.sched ?? []) as { sayId: string; startMs: number; endMs: number }[];
    const sa = sched.find((x) => x.sayId === ackId);
    const sb = sched.find((x) => x.sayId === ansId);
    const gap = sa && sb ? sb.startMs - sa.endMs : null;
    const order = events.filter((e) => e.event === "speaking" && (e.data.sayId === ackId || e.data.sayId === ansId)).map((e) => `${e.data.on ? "on" : "off"}:${e.data.sayId === ackId ? "ack" : "ans"}`);
    const heard = events.filter((e) => e.event === "transcript").slice(trBefore).map((e) => e.data.text).join(" ");
    const ref = `${useFixed ? ACK_REF : ACK_TEXTS[1]} ${TEXT}`;
    const c = cer(ref, heard);
    const ansTts = ttsStreamRequests[ttsBefore];
    results.chain = {
      farSideFirstAudioMs: la !== null ? la - t : null,
      ackMs: sa ? sa.endMs - sa.startMs : null,
      answerTtsRequestedAtMs: ansTts ? ansTts.at - t : null,
      gapMs: gap,
      order,
      heard,
      cer: Number(c.toFixed(3)),
    };
    check("answer TTS starts while the ack is still playing", !!ansTts && !!sa && ansTts.at - t < sa.endMs - sa.startMs, results.chain);
    if (useFixed) check("answer audio starts exactly where the ack ends (gap ≤ 5 ms)", gap !== null && Math.abs(gap) <= 5, `${gap} ms`);
    check("speaking events: on/off ack, then on/off answer", !!offAns && order.join(",") === "on:ack,off:ack,on:ans,off:ans", order.join(","));
    check("ack + answer heard on the far side (CER ≤ 0.15)", c <= 0.15, { heard, cer: c });
  }

  // ---- 말 끝 판정: 마디 사이 쉼(MEET_E2E_PAUSES)에서 구간이 몇 개로 나뉘고, 낱말이 잘리는지
  if (useFixed) {
    await transcriptsSettle(1500);
    phase("pauses");
    const trBefore = events.filter((e) => e.event === "transcript").length;
    const segBefore = s.debugStats().listener.segments;
    const rp = await say({ text: PAUSE_TEXT });
    const { sayId: pid } = (await rp.json()) as { sayId: string };
    const offP = await waitFor((e) => e.event === "speaking" && !e.data.on && e.data.sayId === pid, 60_000);
    if (offP) await transcriptAfter(offP.at, 10_000, 2000);
    const lastLoud = s.lastCapturedLoud();
    const trs = events.filter((e) => e.event === "transcript").slice(trBefore);
    const heard = trs.map((e) => e.data.text).join(" ");
    const c = cer(TEXT, heard);
    const lastTr = trs[trs.length - 1];
    results.pauses = {
      hangoverMs: cfg.vadHangoverMs,
      pausesMs: PAUSES,
      segments: s.debugStats().listener.segments - segBefore,
      transcripts: trs.map((e) => ({ text: e.data.text, durMs: e.data.endMs - e.data.startMs })),
      cer: Number(c.toFixed(3)),
      lastLoudToTranscriptMs: lastTr && lastLoud ? lastTr.at - lastLoud : null,
      speakingOffToTranscriptMs: lastTr && offP ? lastTr.at - offP.at : null,
    };
    check(`paused speech (pauses ${PAUSES.join("/")} ms, hangover ${cfg.vadHangoverMs} ms): no clipped words (CER ≤ 0.1)`, c <= 0.1, results.pauses);
  }

  // ---- 끼어들기: 말하는 중 /say/stop
  phase("stop");
  {
    const r2 = await fetch(`${base}/sessions/${id}/say`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: useFixed ? TEXT : STOP_TEXT }) });
    const { sayId: id2 } = (await r2.json()) as { sayId: string };
    const on2 = await waitFor((e) => e.event === "speaking" && e.data.on && e.data.sayId === id2, 120_000);
    await Bun.sleep(700);
    const ts = Date.now();
    const rs = await fetch(`${base}/sessions/${id}/say/stop`, { method: "POST" });
    const applied = Date.now(); // /say/stop은 페이지가 멈춘 뒤에 답한다
    results.stopAppliedMs = applied - ts;
    const off2 = await waitFor((e) => e.event === "speaking" && !e.data.on && e.data.sayId === id2, 5000);
    // 끊은 뒤 2초 기다린 다음, 마지막 큰 소리가 끊은 시각 + 0.4초 안이어야 한다(WebRTC 지연·페이드 꼬리만 허용)
    await Bun.sleep(2000);
    const lastLoud = s.lastCapturedLoud();
    results.lastLoudAfterStopMs = lastLoud !== null ? lastLoud - ts : null;
    results.lastLoudAfterStopAppliedMs = lastLoud !== null ? lastLoud - applied : null;
    const dbgStop = (await (await fetch(`${base}/sessions/${id}/debug`)).json()) as any;
    results.micAfterStop = dbgStop.page?.mic;
    results.stopToSpeakingOffMs = off2 ? off2.at - ts : null;
    check("say/stop → 200 and speaking off", rs.status === 200 && !!on2 && !!off2, `${results.stopToSpeakingOffMs} ms`);
    check("no audio reaches the far side once stop is applied (+0.4 s tail)", lastLoud !== null && lastLoud - applied <= 400, `request→applied ${results.stopAppliedMs} ms, last loud ${results.lastLoudAfterStopAppliedMs} ms after applied`);
  }

  // 모든 transcript 앞에 같은 seq의 endpoint(soniox·local 모두)
  {
    const trs = events.filter((e) => e.event === "transcript");
    const unpaired = trs.filter((tr) => !events.some((e) => e.event === "endpoint" && e.data.seq === tr.data.seq && e.at <= tr.at));
    check("every transcript is preceded by endpoint {seq} with the same seq", trs.length > 0 && unpaired.length === 0, { transcripts: trs.length, endpoints: events.filter((e) => e.event === "endpoint").length, unpaired: unpaired.length });
  }
  const dbgEnd = (await (await fetch(`${base}/sessions/${id}/debug`).catch(() => null))?.json().catch(() => null)) as any;
  const rtp = (dbgEnd?.page?.diag?.rtp ?? []) as { t: number; jbMs: number; targetMs: number; conceal: number; accel: number }[];
  results.jitterBuffer = { maxMs: Math.max(0, ...rtp.map((x) => x.jbMs)), medianMs: median(rtp.map((x) => x.jbMs)), over300: rtp.filter((x) => x.jbMs > 300).map((x) => ({ atMs: x.t - tStart, jbMs: x.jbMs, targetMs: x.targetMs })) };
  results.clockLagMs = { mic: dbgEnd?.page?.mic?.clockLagMs ?? null, capture: dbgEnd?.page?.capture?.clockLagMs ?? null };
  r = await fetch(`${base}/sessions/${id}`, { method: "DELETE" });
  check("DELETE → ended", ((await r.json()) as any).state === "ended");
  const ended = await waitFor((e) => e.event === "ended", 10_000);
  check("ended event {reason:left}", ended?.data.reason === "left");
  const dbg = (session as unknown as Session).debugStats();
  results.stt = { calls: dbg.listener.sttCalls, sttMs: dbg.listener.sttMs, roundTripMs: dbg.listener.sttRoundTripMs, empty: dbg.listener.empty };
  results.sayFirstAudioScheduledMs = dbg.sayFirstAudioMs;
  results.ttsFirstChunkMs = dbg.say.ttsFirstChunkMs;
  results.sttRequests = sttLog;
  results.ttsStreams = ttsLog;
  results.pipelineOverheadMs = results.sayToSpeakingOnMs !== null && dbg.say.ttsFirstChunkMs[0] !== undefined ? (results.sayToFirstCapturedAudioMs as number) - dbg.say.ttsFirstChunkMs[0] : null;
} catch (e) {
  check("run", false, String(e));
} finally {
  await cleanup();
}
console.log(JSON.stringify(results, null, 2));
process.exit(failed ? 1 : 0);
