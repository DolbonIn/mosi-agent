// services/meet 단위 테스트(브라우저 없음): bun test services/meet/test
import { describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserContext } from "playwright";
import { closeBounded, findChromePid, gotoFailure, killTree, type BrowserOps } from "../browser";
import { base64ToInt16, encodeWav, int16ToBase64, parseWav, rmsDb } from "../audio";
import { config } from "../config";
import { classifySignals, looksInCall, type Probe } from "../flow";
import { buildInitScript, resamplerSource } from "../inject";
import { Listener, type TranscriptEvent } from "../listen";
import { AckCache, SayQueue, trimSilence, type Clip, type MicSink } from "../say";
import { exactLabelRe, SELECTORS } from "../selectors";
import { SonioxStream, type SonioxUtterance } from "../soniox";
import { warmStt } from "../stt";
import { createApp, type SessionLike } from "../server";
import { Session, type SessionEvent } from "../session";
import { SSE_PING, sseEvent } from "../sse";
import { canTransition, endReasonFor, isTerminal, StateMachine, type MeetState } from "../state";
import { maskCode, MEET_URL_RE, parseMeetUrl } from "../url";
import { EnergyVad } from "../vad";

// ---------------------------------------------------------------- 합성 PCM
const SR = 16000;
function tone(ms: number, db = -20, hz = 220, sr = SR): Int16Array {
  const n = Math.round((sr * ms) / 1000);
  const amp = Math.pow(10, db / 20) * Math.SQRT2 * 32767;
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.round(amp * Math.sin((2 * Math.PI * hz * i) / sr));
  return out;
}
/** 말처럼: 음절(220 ms 소리) 사이에 짧은 틈(60 ms, -35 dB 낮게) */
function speech(ms: number, db = -20): Int16Array {
  const parts: Int16Array[] = [];
  let t = 0;
  let k = 0;
  while (t < ms) {
    const on = Math.min(220, ms - t);
    parts.push(tone(on, db, 180 + (k++ % 5) * 30));
    t += on;
    if (t >= ms) break;
    const off = Math.min(60, ms - t);
    parts.push(tone(off, db - 35, 200));
    t += off;
  }
  return cat(...parts);
}
function silence(ms: number, noiseDb = -70, sr = SR): Int16Array {
  const n = Math.round((sr * ms) / 1000);
  const amp = Math.pow(10, noiseDb / 20) * 32767 * Math.sqrt(3);
  const out = new Int16Array(n);
  let seed = 12345;
  for (let i = 0; i < n; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    out[i] = Math.round(((seed / 0x7fffffff) * 2 - 1) * amp);
  }
  return out;
}
function cat(...parts: Int16Array[]): Int16Array {
  const n = parts.reduce((a, p) => a + p.length, 0);
  const out = new Int16Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
/** 200 ms 묶음으로 나눠 넣는다(페이지가 보내는 크기) */
function runVad(pcm: Int16Array, vad = new EnergyVad()) {
  const segs = [];
  for (let i = 0; i < pcm.length; i += 3200) segs.push(...vad.push(pcm.subarray(i, i + 3200)));
  segs.push(...vad.flush());
  return segs;
}
const ms = (samples: number) => (samples * 1000) / SR;

// ---------------------------------------------------------------- URL
describe("url", () => {
  test("accepts canonical Meet links and normalizes", () => {
    expect(parseMeetUrl("https://meet.google.com/abc-defg-hij")).toEqual({ code: "abc-defg-hij", url: "https://meet.google.com/abc-defg-hij" });
    expect(parseMeetUrl("  https://meet.google.com/abc-defg-hij/  ")?.url).toBe("https://meet.google.com/abc-defg-hij");
    expect(parseMeetUrl("https://meet.google.com/abc-defg-hij?authuser=0&hs=122")?.url).toBe("https://meet.google.com/abc-defg-hij");
    expect(parseMeetUrl("https://meet.google.com/ABC-DEFG-HIJ")?.code).toBe("abc-defg-hij");
    expect(parseMeetUrl("meet.google.com/rak-ughm-kud")?.code).toBe("rak-ughm-kud");
  });
  test("rejects everything else", () => {
    for (const bad of [
      "http://meet.google.com/abc-defg-hij",
      "https://meet.google.com/abc-defg-hi",
      "https://meet.google.com/abcd-efg-hij",
      "https://meet.google.com/abc-defg-hij/extra",
      "https://meet.google.com.evil.com/abc-defg-hij",
      "https://evil.com/meet.google.com/abc-defg-hij",
      "https://meet.google.com/lookup/abcdef",
      "https://meet.google.com/",
      "https://meet.google.com/abc-d3fg-hij",
      "javascript:alert(1)//meet.google.com/abc-defg-hij",
      "https://user@meet.google.com/abc-defg-hij",
      "",
    ]) {
      expect(parseMeetUrl(bad)).toBeNull();
    }
    expect(parseMeetUrl(42)).toBeNull();
    expect(parseMeetUrl(null)).toBeNull();
    expect(MEET_URL_RE.test("https://meet.google.com/abc-defg-hij\nhttps://x")).toBe(false);
  });
  test("masks codes for logs", () => {
    expect(maskCode("rak-ughm-kud")).toBe("rak-****-kud");
    expect(maskCode("nonsense")).toBe("***");
  });
});

// ---------------------------------------------------------------- SSE
describe("sse", () => {
  test("one event per block, single data line, JSON body", () => {
    const s = sseEvent("transcript", { seq: 1, text: "첫 줄\n둘째 줄", startMs: 1, endMs: 2, speaker: null });
    expect(s.startsWith("event: transcript\ndata: ")).toBe(true);
    expect(s.endsWith("\n\n")).toBe(true);
    const lines = s.trimEnd().split("\n");
    expect(lines.length).toBe(2);
    expect(JSON.parse(lines[1]!.slice("data: ".length))).toEqual({ seq: 1, text: "첫 줄\n둘째 줄", startMs: 1, endMs: 2, speaker: null });
    expect(SSE_PING.startsWith(":")).toBe(true);
  });
});

// ---------------------------------------------------------------- 상태 기계
describe("state machine", () => {
  test("happy path emits every change in order", () => {
    const sm = new StateMachine();
    const seen: string[] = [];
    sm.onChange((c) => seen.push(`${c.from}>${c.state}${c.reason ? `:${c.reason}` : ""}`));
    expect(sm.transition("prejoin")).toBe(true);
    expect(sm.transition("waiting_admission")).toBe(true);
    expect(sm.transition("in_call")).toBe(true);
    expect(sm.transition("ended", "left")).toBe(true);
    expect(seen).toEqual(["launching>prejoin", "prejoin>waiting_admission", "waiting_admission>in_call", "in_call>ended:left"]);
    expect(sm.terminal).toBe(true);
  });
  test("rejects illegal and post-terminal transitions", () => {
    const sm = new StateMachine();
    expect(sm.transition("in_call")).toBe(false); // launching → in_call 불가
    expect(sm.transition("launching")).toBe(false); // 같은 상태
    sm.transition("prejoin");
    sm.transition("denied", "host_denied");
    for (const s of ["launching", "prejoin", "waiting_admission", "in_call", "ended", "failed"] as MeetState[]) expect(sm.transition(s)).toBe(false);
    expect(sm.state).toBe("denied");
    expect(sm.reason).toBe("host_denied");
  });
  test("transition table", () => {
    expect(canTransition("prejoin", "in_call")).toBe(true); // 지금 참여
    expect(canTransition("in_call", "denied")).toBe(false);
    expect(canTransition("waiting_admission", "denied")).toBe(true);
    expect(canTransition("in_call", "ended")).toBe(true);
    expect(isTerminal("blocked")).toBe(true);
    expect(isTerminal("in_call")).toBe(false);
  });
  test("ended reasons", () => {
    expect(endReasonFor("ended", "left")).toBe("left");
    expect(endReasonFor("ended", "alone")).toBe("alone");
    expect(endReasonFor("ended", "weird")).toBe("error");
    expect(endReasonFor("denied", "host_denied")).toBe("error");
    expect(endReasonFor("failed")).toBe("error");
  });
  test("Meet signals map to states", () => {
    expect(classifySignals(["cant_join"], "prejoin")).toEqual({ state: "blocked", reason: "cant_join" });
    expect(classifySignals(["denied"], "waiting")).toEqual({ state: "denied", reason: "host_denied" });
    expect(classifySignals(["denied"], "prejoin")).toBeNull();
    expect(classifySignals(["no_response"], "waiting")).toEqual({ state: "denied", reason: "no_response" });
    expect(classifySignals(["invalid"], "prejoin")).toEqual({ state: "invalid", reason: "meeting_not_found" });
    expect(classifySignals(["removed"], "in_call")).toEqual({ state: "ended", reason: "kicked" });
    expect(classifySignals(["meeting_ended"], "in_call")).toEqual({ state: "ended", reason: "meeting_ended" });
    expect(classifySignals(["waiting"], "waiting")).toBeNull();
  });
  test("in-call detection: leave button, or tiles without pre-join/waiting UI", () => {
    const base: Probe = { ready: "complete", nameInput: false, join: null, leave: false, waitingCopy: false, mic: "on", cam: "off", signals: [], participants: null };
    expect(looksInCall({ ...base, leave: true })).toBe(true);
    expect(looksInCall(base)).toBe(false);
    expect(looksInCall({ ...base, participants: 2 })).toBe(true);
    expect(looksInCall({ ...base, participants: 2, waitingCopy: true })).toBe(false);
    expect(looksInCall({ ...base, participants: 1, nameInput: true })).toBe(false);
    expect(looksInCall({ ...base, participants: 1, join: { kind: "ask", disabled: false } })).toBe(false);
  });
  test("signal regexes match Korean and English Meet copy", () => {
    const re = (k: string) => new RegExp(SELECTORS.signals[k]!, "i");
    expect(re("cant_join").test("이 화상 통화에 참여할 수 없습니다")).toBe(true);
    expect(re("cant_join").test("You can't join this video call")).toBe(true);
    expect(re("denied").test("Someone in the call denied your request to join")).toBe(true);
    expect(re("removed").test("You've been removed from the meeting")).toBe(true);
    expect(re("meeting_ended").test("The meeting has ended")).toBe(true);
    expect(re("invalid").test("Check your meeting code")).toBe(true);
    // 참여 전 화면 문구에는 실패 신호가 없어야 한다
    const prejoinCopy = "이름이 무엇인가요?\n참여 요청\n다른 참석 방법\n가입하면 서비스 약관 및 개인정보처리방침에 동의하게 됩니다. 봇이 아닌 실제 사용자인지 확인하기 위해 시스템 정보가 전송됩니다.\nGoogle 계정으로 로그인\n참여될 때까지 대기하지 말고 호스트가 초대한 Google 계정으로 로그인하세요.";
    for (const k of Object.keys(SELECTORS.signals)) expect(re(k).test(prejoinCopy)).toBe(false);
    expect(exactLabelRe(["참여 요청", "Ask to join"]).test(" 참여 요청 ")).toBe(true);
    expect(exactLabelRe(["참여 요청"]).test("다른 참석 방법")).toBe(false);
  });
});

// ---------------------------------------------------------------- VAD
describe("vad", () => {
  test("silence yields nothing", () => {
    expect(runVad(silence(5000))).toEqual([]);
  });
  test("one utterance → one segment with pre/post roll", () => {
    const segs = runVad(cat(silence(1000), tone(1200), silence(2000)));
    expect(segs.length).toBe(1);
    const s = segs[0]!;
    expect(ms(s.startSample)).toBeGreaterThanOrEqual(1000 - 260);
    expect(ms(s.startSample)).toBeLessThanOrEqual(1000);
    expect(ms(s.endSample)).toBeGreaterThanOrEqual(2200);
    expect(ms(s.endSample)).toBeLessThanOrEqual(2200 + 320);
    expect(s.speechMs).toBeGreaterThan(1100);
    expect(s.pcm.length).toBe(s.endSample - s.startSample);
    expect(s.cut).toBe(false);
  });
  test("pause shorter than 700 ms hangover stays in one segment", () => {
    const segs = runVad(cat(silence(500), tone(800), silence(500), tone(800), silence(1500)));
    expect(segs.length).toBe(1);
    expect(segs[0]!.speechMs).toBeGreaterThan(2000);
  });
  test("pause longer than hangover splits", () => {
    const segs = runVad(cat(silence(500), tone(800), silence(1000), tone(800), silence(1500)));
    expect(segs.length).toBe(2);
  });
  test("blips under 0.4 s are dropped", () => {
    expect(runVad(cat(silence(500), tone(250), silence(1500)))).toEqual([]);
    expect(runVad(cat(silence(500), tone(500), silence(1500))).length).toBe(1);
  });
  test("long speech is cut at 15 s and continues", () => {
    const segs = runVad(cat(silence(300), speech(20000), silence(1500)));
    expect(segs.length).toBe(2);
    expect(segs[0]!.cut).toBe(true);
    expect(ms(segs[0]!.pcm.length)).toBeCloseTo(15000, -2);
    expect(segs[1]!.cut).toBe(false);
    expect(segs[1]!.speechMs).toBeGreaterThan(4400);
    expect(segs[1]!.startSample).toBe(segs[0]!.endSample);
  });
  test("adapts to a steady noise floor", () => {
    // -38 dBFS 고른 잡음(고정 문턱 -45보다 큼): 처음 4초 창이 찰 때까지만 잡히고, 바닥이 올라가면 끝난다. 그 위의 말은 잡힌다.
    const vad = new EnergyVad();
    const first = runVad(silence(20000, -38), vad);
    expect(first.length).toBeLessThanOrEqual(1);
    expect(vad.thresholdDb).toBeGreaterThan(-38);
    expect(vad.speaking).toBe(false);
    const after = runVad(cat(silence(3000, -38), speech(1200, -15), silence(1500, -38)), vad);
    expect(after.length).toBe(1);
    expect(after[0]!.speechMs).toBeGreaterThan(1000);
  });
  test("chunking does not change the result", () => {
    const pcm = cat(silence(700), tone(900), silence(900), tone(600), silence(1200));
    const a = runVad(pcm);
    const vad = new EnergyVad();
    const b = [];
    for (let i = 0; i < pcm.length; i += 777) b.push(...vad.push(pcm.subarray(i, i + 777)));
    b.push(...vad.flush());
    expect(b.map((s) => [s.startSample, s.endSample])).toEqual(a.map((s) => [s.startSample, s.endSample]));
  });
});

// ---------------------------------------------------------------- 리샘플러(페이지에 들어가는 그 텍스트)
describe("resampler", () => {
  const create = new Function(`${resamplerSource()}; return createStreamResampler;`)() as (
    inRate: number,
    outRate: number,
  ) => { process(x: Float32Array): Float32Array; ratio: number; half: number };
  const sine = (hz: number, sr: number, n: number, amp = 0.5) => Float32Array.from({ length: n }, (_, i) => amp * Math.sin((2 * Math.PI * hz * i) / sr));
  const rms = (x: Float32Array, from = 0) => {
    let s = 0;
    for (let i = from; i < x.length; i++) s += x[i]! * x[i]!;
    return Math.sqrt(s / Math.max(1, x.length - from));
  };
  /** 출력 신호가 hz 사인과 얼마나 맞는지(상관 진폭) */
  const amplitudeAt = (x: Float32Array, hz: number, sr: number, from: number) => {
    let c = 0;
    let s = 0;
    for (let i = from; i < x.length; i++) {
      c += x[i]! * Math.cos((2 * Math.PI * hz * i) / sr);
      s += x[i]! * Math.sin((2 * Math.PI * hz * i) / sr);
    }
    const n = x.length - from;
    return (2 * Math.sqrt(c * c + s * s)) / n;
  };

  test("48 kHz → 16 kHz length, passband gain and stopband attenuation", () => {
    const r = create(48000, 16000);
    expect(r.ratio).toBe(3);
    const out = r.process(sine(1000, 48000, 48000));
    expect(Math.abs(out.length - 16000)).toBeLessThanOrEqual(r.half);
    expect(amplitudeAt(out, 1000, 16000, 200)).toBeCloseTo(0.5, 2);
    const hi = create(48000, 16000).process(sine(12000, 48000, 48000));
    expect(rms(hi, 200)).toBeLessThan(0.5 * 0.02); // 12 kHz(출력 나이퀴스트 8 kHz 위)는 −34 dB 아래
    const edge = create(48000, 16000).process(sine(9500, 48000, 48000));
    expect(rms(edge, 200)).toBeLessThan(0.5 * 0.1);
  });
  test("44.1 kHz → 16 kHz keeps a 440 Hz tone", () => {
    const r = create(44100, 16000);
    const out = r.process(sine(440, 44100, 44100));
    expect(Math.abs(out.length - 16000)).toBeLessThanOrEqual(r.half + 1);
    expect(amplitudeAt(out, 440, 16000, 200)).toBeCloseTo(0.5, 2);
  });
  test("DC is preserved", () => {
    const out = create(48000, 16000).process(new Float32Array(9600).fill(0.25));
    for (let i = 100; i < out.length; i++) expect(out[i]!).toBeCloseTo(0.25, 4);
  });
  test("streaming in 128-sample quanta equals one shot", () => {
    const x = sine(700, 48000, 24000);
    const one = create(48000, 16000).process(x);
    const r = create(48000, 16000);
    const parts: number[] = [];
    for (let i = 0; i < x.length; i += 128) parts.push(...r.process(x.subarray(i, i + 128)));
    expect(parts.length).toBe(one.length);
    let maxDiff = 0;
    for (let i = 0; i < one.length; i++) maxDiff = Math.max(maxDiff, Math.abs(parts[i]! - one[i]!));
    expect(maxDiff).toBeLessThan(1e-6);
  });
});

// ---------------------------------------------------------------- PCM 도우미
describe("audio helpers", () => {
  test("base64 round trip and wav round trip", () => {
    const pcm = tone(50, -6);
    expect([...base64ToInt16(int16ToBase64(pcm))]).toEqual([...pcm]);
    const sub = pcm.subarray(10, 30);
    expect([...base64ToInt16(int16ToBase64(sub))]).toEqual([...sub]);
    const w = parseWav(encodeWav(pcm, 44100));
    expect(w.sampleRate).toBe(44100);
    expect([...w.pcm]).toEqual([...pcm]);
    expect(rmsDb(tone(100, -20))).toBeCloseTo(-20, 0);
    expect(rmsDb(new Int16Array(100))).toBe(-100);
  });
  test("init script compiles and carries config", () => {
    const s = buildInitScript({ selfName: "모시" });
    expect(() => new Function(s)).not.toThrow();
    expect(s).toContain("createStreamResampler");
    expect(s).toContain('"selfName":"모시"');
  });
});

// ---------------------------------------------------------------- Listener (가짜 STT)
describe("listener", () => {
  test("segments → STT → transcript events with seq and epoch times", async () => {
    const got: TranscriptEvent[] = [];
    const calls: number[] = [];
    const order: string[] = [];
    let n = 0;
    const l = new Listener({
      sttUrl: "http://unused",
      onTranscript: (e) => (got.push(e), order.push(`transcript:${e.seq}`)),
      onEndpoint: (seq) => order.push(`endpoint:${seq}`),
      stt: async (pcm) => {
        calls.push(pcm.length);
        n++;
        await Bun.sleep(20); // STT가 끝나기 전에 endpoint가 먼저 나가는지
        return n === 2 ? { text: "", ms: 5, noSpeech: true } : { text: `발화 ${n}`, ms: 5, noSpeech: false };
      },
    });
    const pcm = cat(silence(500), tone(800), silence(1000), tone(800), silence(1000), tone(800), silence(1500));
    const t0 = 1_700_000_000_000;
    for (let i = 0; i < pcm.length; i += 3200) {
      const chunk = pcm.subarray(i, i + 3200);
      l.onPcm(int16ToBase64(chunk), t0 + ((i + chunk.length) * 1000) / SR);
    }
    await l.flush();
    expect(calls.length).toBe(3);
    // local endpoint는 VAD 구간이 닫힐 때(STT 전) seq를 정한다: 무음 판정(noSpeech)된 2번은 endpoint만 있고 transcript가 없다
    expect(got.map((g) => g.seq)).toEqual([1, 3]);
    expect(order).toEqual(["endpoint:1", "endpoint:2", "endpoint:3", "transcript:1", "transcript:3"]);
    expect(got.map((g) => g.text)).toEqual(["발화 1", "발화 3"]);
    expect(got[0]!.startMs).toBeGreaterThanOrEqual(t0 + 500 - 260);
    expect(got[0]!.startMs).toBeLessThanOrEqual(t0 + 500);
    expect(got[0]!.endMs).toBeGreaterThan(got[0]!.startMs + 700);
    expect(got[0]!.speaker).toBeNull();
  });
  test("speaker probe tallies the most frequent name", async () => {
    const got: TranscriptEvent[] = [];
    const eps: [number, string | null][] = [];
    const l = new Listener({
      sttUrl: "x",
      onTranscript: (e) => got.push(e),
      onEndpoint: (seq, speaker) => eps.push([seq, speaker]),
      stt: async () => ({ text: "네", ms: 1, noSpeech: false }),
      speakerProbe: async () => "참석자A",
    });
    const pcm = cat(silence(300), tone(1500), silence(1200));
    const t0 = Date.now();
    for (let i = 0; i < pcm.length; i += 3200) {
      l.onPcm(int16ToBase64(pcm.subarray(i, i + 3200)), t0 + i / 16);
      await Bun.sleep(5);
    }
    await l.flush();
    expect(got.length).toBe(1);
    expect(got[0]!.speaker).toBe("참석자A");
    expect(eps).toEqual([[1, "참석자A"]]); // endpoint에도 같은 사람
  });
  test("nextLoud reports when sound first crosses the threshold", async () => {
    const l = new Listener({ sttUrl: "x", onTranscript: () => {}, stt: async () => ({ text: "", ms: 0, noSpeech: true }) });
    const t0 = 1_000_000;
    const p = l.nextLoud(1000);
    const pcm = cat(silence(400), tone(400));
    for (let i = 0; i < pcm.length; i += 3200) l.onPcm(int16ToBase64(pcm.subarray(i, i + 3200)), t0 + (i + 3200) / 16);
    const at = await p;
    expect(at).not.toBeNull();
    expect(Math.abs(at! - (t0 + 400))).toBeLessThanOrEqual(15);
  });
});

// ---------------------------------------------------------------- SayQueue (가짜 TTS 서버 + 가짜 마이크)
describe("say queue", () => {
  function fakeTts(opts: { queue: number; streamFails?: boolean; slowMs?: number }) {
    const hits: string[] = [];
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        const u = new URL(req.url);
        hits.push(`${req.method} ${u.pathname}`);
        if (u.pathname === "/health") return Response.json({ ok: true, ready: true, queue: opts.queue, busyMs: 0 });
        if (u.pathname === "/tts/stream") {
          if (opts.streamFails) return Response.json({ error: "synthesis_failed" }, { status: 500 });
          const chunk = new Uint8Array(tone(320, -12, 300, 44100).buffer);
          let i = 0;
          const stream = new ReadableStream({
            async pull(c) {
              if (i++ >= 4) return c.close();
              await Bun.sleep(opts.slowMs ?? 5);
              c.enqueue(chunk);
            },
          });
          return new Response(stream, { headers: { "Content-Type": "audio/L16", "X-Sample-Rate": "44100" } });
        }
        if (u.pathname === "/tts") return new Response(encodeWav(tone(500, -12, 300, 24000), 24000), { headers: { "Content-Type": "audio/wav" } });
        return new Response("nope", { status: 404 });
      },
    });
    return { url: `http://127.0.0.1:${server.port}`, hits, stop: () => server.stop(true) };
  }
  function fakeSink() {
    const log: string[] = [];
    let samples = 0;
    const sink: MicSink = {
      push: async (b64, rate) => {
        samples += base64ToInt16(b64).length;
        log.push(`push@${rate}`);
      },
      stop: async () => {
        log.push("stop");
      },
      drain: async () => {
        log.push("drain");
        await Bun.sleep(5);
      },
    };
    return { sink, log, samples: () => samples };
  }

  test("streams in order, speaking on/off around each line", async () => {
    const tts = fakeTts({ queue: 0 });
    const s = fakeSink();
    const ev: string[] = [];
    const q = new SayQueue({ ttsUrl: tts.url, sink: s.sink, emit: (_e, d) => ev.push(`${d.on ? "on" : "off"}:${d.sayId}`) });
    const a = q.enqueue("하나");
    const b = q.enqueue("둘");
    while (q.busy) await Bun.sleep(10);
    expect(ev).toEqual([`on:${a}`, `off:${a}`, `on:${b}`, `off:${b}`]);
    expect(s.samples()).toBe(2 * 4 * Math.round(44100 * 0.32));
    expect(s.log.filter((l) => l === "drain").length).toBe(2);
    expect(tts.hits.filter((h) => h === "POST /tts").length).toBe(0);
    expect(q.stats.firstAudioMs.length).toBe(2);
    tts.stop();
  });
  test("busy TTS (queue ≥ 2) falls back to one wav", async () => {
    const tts = fakeTts({ queue: 2 });
    const s = fakeSink();
    const ev: string[] = [];
    const q = new SayQueue({ ttsUrl: tts.url, sink: s.sink, emit: (_e, d) => ev.push(d.on ? "on" : "off") });
    q.enqueue("바쁠 때");
    while (q.busy) await Bun.sleep(10);
    expect(tts.hits).toContain("POST /tts");
    expect(tts.hits).not.toContain("POST /tts/stream");
    expect(s.log[0]).toBe("push@24000");
    expect(ev).toEqual(["on", "off"]);
    tts.stop();
  });
  test("stream failure falls back to wav", async () => {
    const tts = fakeTts({ queue: 0, streamFails: true });
    const s = fakeSink();
    const q = new SayQueue({ ttsUrl: tts.url, sink: s.sink, emit: () => {} });
    q.enqueue("실패하면");
    while (q.busy) await Bun.sleep(10);
    expect(tts.hits).toContain("POST /tts/stream");
    expect(tts.hits).toContain("POST /tts");
    expect(q.stats.fallbacks).toBe(1);
    tts.stop();
  });
  test("TTS down → no speaking event, failure counted", async () => {
    const s = fakeSink();
    const ev: string[] = [];
    const q = new SayQueue({ ttsUrl: "http://127.0.0.1:9", sink: s.sink, emit: (_e, d) => ev.push(String(d.on)) });
    q.enqueue("꺼져 있음");
    while (q.busy) await Bun.sleep(10);
    expect(ev).toEqual([]);
    expect(q.stats.failed).toBe(1);
  });
  test("stop aborts the current line and drops the queue", async () => {
    const tts = fakeTts({ queue: 0, slowMs: 200 });
    const s = fakeSink();
    const ev: string[] = [];
    const q = new SayQueue({ ttsUrl: tts.url, sink: s.sink, emit: (_e, d) => ev.push(`${d.on ? "on" : "off"}:${d.sayId}`) });
    const a = q.enqueue("길게 말하는 중");
    q.enqueue("다음 줄");
    while (!ev.length) await Bun.sleep(5);
    const dropped = await q.stop();
    while (q.busy) await Bun.sleep(10);
    expect(dropped).toBe(2);
    expect(ev).toEqual([`on:${a}`, `off:${a}`]);
    expect(s.log).toContain("stop");
    expect(s.samples()).toBeLessThan(4 * Math.round(44100 * 0.32));
    tts.stop();
  });
});

// ---------------------------------------------------------------- 맞장구 캐시 + 이어 말하기
/** 페이지 가상 마이크 흉내: 줄마다 예약 구간을 이어 붙이고, drain(sayId)은 그 줄이 끝날 때 풀린다 */
class FakeMic implements MicSink {
  nextEnd = 0;
  ends = new Map<string, number>();
  starts = new Map<string, number>();
  log: string[] = [];
  clipsLoaded = new Set<string>();
  private place(sayId: string, ms: number) {
    const now = performance.now();
    const start = Math.max(now + 5, this.nextEnd);
    if (!this.starts.has(sayId)) this.starts.set(sayId, start);
    this.nextEnd = start + ms;
    this.ends.set(sayId, this.nextEnd);
    return { startInMs: start - now };
  }
  async push(b64: string, rate: number, _first: boolean, sayId: string) {
    this.log.push(`push:${sayId}`);
    return this.place(sayId, (base64ToInt16(b64).length * 1000) / rate);
  }
  async playClip(clip: Clip, sayId: string) {
    this.log.push(`clip:${sayId}`);
    this.clipsLoaded.add(clip.key);
    return this.place(sayId, clip.ms);
  }
  async stop() {
    this.log.push("stop");
    const now = performance.now();
    this.nextEnd = now;
    for (const [k, v] of this.ends) if (v > now) this.ends.set(k, now);
  }
  async drain(sayId?: string) {
    for (;;) {
      const end = sayId ? (this.ends.get(sayId) ?? 0) : this.nextEnd;
      const left = end - performance.now();
      if (left <= 0) return;
      await Bun.sleep(Math.min(left, 20));
    }
  }
}

function fakeTtsServer(opts: { queue?: number; firstChunkDelayMs?: number; audioMs?: number } = {}) {
  const hits: { path: string; at: number; text?: string }[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const u = new URL(req.url);
      if (u.pathname === "/health") return Response.json({ ok: true, ready: true, queue: opts.queue ?? 0 });
      const body = (await req.json().catch(() => ({}))) as { text?: string };
      hits.push({ path: u.pathname, at: performance.now(), text: body.text });
      if (u.pathname === "/tts/stream") {
        // 앞 80 ms 무음 + 소리 + 뒤 200 ms 무음 (자르기 시험용)
        const pcm = cat(silence(80, -90, 44100), tone(opts.audioMs ?? 300, -12, 300, 44100), silence(200, -90, 44100));
        const bytes = new Uint8Array(pcm.buffer);
        let sent = false;
        const stream = new ReadableStream({
          async pull(c) {
            if (sent) return c.close();
            await Bun.sleep(opts.firstChunkDelayMs ?? 5);
            c.enqueue(bytes);
            sent = true;
          },
        });
        return new Response(stream, { headers: { "Content-Type": "audio/L16", "X-Sample-Rate": "44100" } });
      }
      return new Response("nf", { status: 404 });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, hits, stop: () => server.stop(true) };
}

describe("ack clips", () => {
  test("trimSilence keeps 10 ms before and 60 ms after the sound", () => {
    const pcm = cat(silence(300, -90, 44100), tone(200, -12, 300, 44100), silence(400, -90, 44100));
    const r = trimSilence(pcm, 44100);
    const ms = (r.pcm.length * 1000) / 44100;
    expect(ms).toBeGreaterThan(200 + 50);
    expect(ms).toBeLessThan(200 + 10 + 60 + 15);
    expect(r.leadMs).toBeGreaterThan(280);
    expect(trimSilence(silence(300, -90, 44100), 44100).pcm.length).toBe(0);
  });
  test("AckCache renders each text once (trimmed) and skips when TTS is busy", async () => {
    const tts = fakeTtsServer();
    const cache = new AckCache();
    await cache.ensure(tts.url, undefined, ["네,", " 네, 잠시만요. ", "네,"]);
    expect(cache.keys().sort()).toEqual(["네,", "네, 잠시만요."]);
    expect(tts.hits.filter((h) => h.path === "/tts/stream").length).toBe(2);
    const clip = cache.get("네, 잠시만요.")!;
    expect(clip.ms).toBeGreaterThan(300);
    expect(clip.ms).toBeLessThan(300 + 10 + 60 + 15); // 앞 80 ms·뒤 200 ms 무음이 잘렸다
    await cache.ensure(tts.url, undefined, ["네,", "네, 잠시만요."]);
    expect(tts.hits.length).toBe(2); // 이미 있으면 TTS를 부르지 않는다
    tts.stop();
    const busy = fakeTtsServer({ queue: 1 });
    const c2 = new AckCache();
    await c2.ensure(busy.url, undefined, ["음,"], { waitMs: 300 });
    expect(c2.keys()).toEqual([]);
    expect(busy.hits.length).toBe(0);
    busy.stop();
  });
  test("cached line plays with zero TTS calls; the next line's TTS starts while the ack still plays", async () => {
    const tts = fakeTtsServer({ firstChunkDelayMs: 100, audioMs: 300 });
    const mic = new FakeMic();
    const ev: { e: string; at: number }[] = [];
    const q = new SayQueue({ ttsUrl: tts.url, sink: mic, emit: (_e, d) => ev.push({ e: `${d.on ? "on" : "off"}:${d.sayId}`, at: performance.now() }) });
    const clip: Clip = { key: "네, 잠시만요.", pcm: tone(600, -12, 300, 44100), rate: 44100, ms: 600 };
    const t0 = performance.now();
    const ack = q.enqueue(clip.key, clip);
    const ans = q.enqueue("대답 문장");
    while (q.busy) await Bun.sleep(5);
    expect(mic.log[0]).toBe(`clip:${ack}`);
    expect(tts.hits.filter((h) => h.path === "/tts/stream").map((h) => h.text)).toEqual(["대답 문장"]); // 맞장구는 TTS를 부르지 않음
    // 대답 TTS 요청은 맞장구가 끝나기(600 ms) 전에 이미 나갔다
    expect(tts.hits[0]!.at - t0).toBeLessThan(100);
    // 대답은 맞장구 끝에 바로 붙는다(틈 0)
    expect(Math.abs(mic.starts.get(ans)! - mic.ends.get(ack)!)).toBeLessThan(1);
    expect(ev.map((x) => x.e)).toEqual([`on:${ack}`, `off:${ack}`, `on:${ans}`, `off:${ans}`]);
    // on(대답)은 맞장구가 끝나는 시각에 온다
    const onAns = ev.find((x) => x.e === `on:${ans}`)!.at;
    expect(Math.abs(onAns - mic.ends.get(ack)!)).toBeLessThan(40);
    expect(q.stats.cached).toBe(1);
    expect(q.stats.said).toBe(2);
    tts.stop();
  });
  test("stop during a chained pair drops both and the queued line never turns on", async () => {
    const tts = fakeTtsServer({ firstChunkDelayMs: 10, audioMs: 300 });
    const mic = new FakeMic();
    const ev: string[] = [];
    const q = new SayQueue({ ttsUrl: tts.url, sink: mic, emit: (_e, d) => ev.push(`${d.on ? "on" : "off"}:${d.sayId}`) });
    const clip: Clip = { key: "음,", pcm: tone(800, -12, 300, 44100), rate: 44100, ms: 800 };
    const ack = q.enqueue(clip.key, clip);
    const ans = q.enqueue("대답");
    while (!mic.log.some((l) => l === `push:${ans}`)) await Bun.sleep(5);
    await q.stop();
    while (q.busy) await Bun.sleep(5);
    expect(ev).toEqual([`on:${ack}`, `off:${ack}`]);
    tts.stop();
  });
});

describe("vad hangover setting", () => {
  test("500 ms splits a 600 ms pause that 700 ms keeps together", () => {
    const pcm = cat(silence(500), tone(800), silence(600), tone(800), silence(1500));
    expect(runVad(pcm, new EnergyVad({ hangoverMs: 700 })).length).toBe(1);
    expect(runVad(pcm, new EnergyVad({ hangoverMs: 500 })).length).toBe(2);
  });
});

// ---------------------------------------------------------------- Soniox 실시간 STT (가짜 WS 서버)
type FakeConn = { auth: string | null; config: any; audioBytes: number; controls: { text: string; audioBytes: number }[]; ws: any };
function fakeSoniox(onMessage?: (c: FakeConn, msg: string | Buffer) => void) {
  const conns: FakeConn[] = [];
  const server = Bun.serve<{ auth: string | null }, never>({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req, srv) {
      if (srv.upgrade(req, { data: { auth: req.headers.get("authorization") } })) return undefined;
      return new Response("no", { status: 400 });
    },
    websocket: {
      open(ws) {
        conns.push({ auth: ws.data.auth, config: null, audioBytes: 0, controls: [], ws });
      },
      message(ws, msg) {
        const c = conns.find((x) => x.ws === ws)!;
        if (typeof msg === "string") {
          if (!c.config) c.config = JSON.parse(msg);
          else c.controls.push({ text: msg, audioBytes: c.audioBytes });
        } else c.audioBytes += msg.byteLength;
        onMessage?.(c, msg);
      },
    },
  });
  const send = (c: FakeConn, tokens: [string, boolean, number?, number?][]) =>
    c.ws.send(JSON.stringify({ tokens: tokens.map(([text, is_final, start_ms, end_ms]) => ({ text, is_final, ...(start_ms !== undefined ? { start_ms, end_ms } : {}) })) }));
  return { url: `ws://127.0.0.1:${server.port}`, conns, send, stop: () => server.stop(true) };
}
const until = async (pred: () => boolean, ms = 3000) => {
  for (const t = Date.now(); !pred() && Date.now() - t < ms; ) await Bun.sleep(5);
  return pred();
};

describe("stt warm-up", () => {
  test("warmStt sends 1 s of voiced, pitch-moving sound (passes the STT silence gate) with the prompt", async () => {
    let got: { bytes: number; prompt: string | null; rmsDb: number } | null = null;
    const srv = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        const u = new URL(req.url);
        if (u.pathname === "/health") return Response.json({ ok: true, ready: true, queue: 0 });
        const pcm = new Int16Array(await req.arrayBuffer());
        got = { bytes: pcm.byteLength, prompt: u.searchParams.get("prompt"), rmsDb: rmsDb(pcm, 0, pcm.length) };
        return Response.json({ text: "", ms: 42, durationMs: 1000, noSpeech: true });
      },
    });
    const w = await warmStt(`http://127.0.0.1:${srv.port}`, "깽이야, 정리해 줄래?");
    expect(w?.serverMs).toBe(42);
    expect(got!.bytes).toBe(32000);
    expect(got!.prompt).toBe("깽이야, 정리해 줄래?");
    expect(got!.rmsDb).toBeGreaterThan(-30);
    srv.stop(true);
  });
});

describe("soniox", () => {
  test("auth header + config (no api_key), partial → utterance order, <end> stripped, token times → samples", async () => {
    const f = fakeSoniox();
    const out: string[] = [];
    const utts: SonioxUtterance[] = [];
    const st = new SonioxStream({
      apiKey: "test-key",
      url: f.url,
      terms: ["모시", "모시야"],
      contextText: "모시야, 회의 정리해 줄래?",
      partialIntervalMs: 0,
      onUtterance: (u) => (utts.push(u), out.push(`final:${u.text}`)),
      onPartial: (t) => out.push(`partial:${t}`),
      onFatal: (r) => out.push(`fatal:${r}`),
    });
    st.push(new Int16Array(1600), 16000); // 연결 전 소리는 모아 뒀다 보낸다(기준 = 샘플 16000)
    st.start();
    expect(await until(() => f.conns[0]?.config !== null && f.conns[0]?.audioBytes === 3200)).toBe(true);
    const c = f.conns[0]!;
    expect(c.auth).toBe("Bearer test-key");
    expect(c.config).toMatchObject({ model: "stt-rt-v6", audio_format: "pcm_s16le", sample_rate: 16000, num_channels: 1, language_hints: ["ko"], enable_endpoint_detection: true, max_endpoint_delay_ms: 500 });
    expect(c.config.context.terms).toEqual(["모시", "모시야"]);
    expect(c.config.context.text).toBe("모시야, 회의 정리해 줄래?");
    expect(c.config.api_key).toBeUndefined();
    f.send(c, [["모", false, 100, 200]]);
    f.send(c, [["모시", true, 100, 300], ["야", false, 300, 400]]);
    f.send(c, [["야,", true, 300, 450], [" 오늘", true, 500, 700], ["<end>", true], [" 다", false, 900, 1000]]);
    expect(await until(() => out.length >= 4)).toBe(true);
    await Bun.sleep(30);
    expect(out).toEqual(["partial:모", "partial:모시야", "final:모시야, 오늘", "partial:다"]);
    expect(utts[0]!.reason).toBe("end");
    expect(utts[0]!.startSample).toBe(16000 + 1600); // 100 ms
    expect(utts[0]!.endSample).toBe(16000 + 11200); // 700 ms
    expect(st.hasPending).toBe(true); // " 다"(미확정)
    await st.close(300);
    f.stop();
  });

  test("finalize → <fin> closes the utterance with latency; close() ends with an empty text frame", async () => {
    const f = fakeSoniox((c, msg) => {
      if (msg === '{"type":"finalize"}') setTimeout(() => f.send(c, [["회의", true, 0, 300], ["<fin>", true]]), 30);
      if (msg === "") setTimeout(() => (f.send(c, [["끝", true, 400, 500]]), c.ws.send(JSON.stringify({ finished: true }))), 10);
    });
    const utts: SonioxUtterance[] = [];
    const st = new SonioxStream({ apiKey: "k", url: f.url, onUtterance: (u) => utts.push(u), onFatal: () => {} });
    st.start();
    expect(await until(() => st.live)).toBe(true);
    expect(st.finalize()).toBe(false); // 닫을 글자가 없으면 보내지 않는다
    st.push(new Int16Array(1600), 0);
    f.send(f.conns[0]!, [["회", false, 0, 200]]);
    expect(await until(() => st.hasPending)).toBe(true);
    expect(st.finalize()).toBe(true);
    expect(st.finalize()).toBe(false); // <fin> 전에는 다시 보내지 않는다
    expect(await until(() => utts.length === 1)).toBe(true);
    expect(utts[0]).toMatchObject({ text: "회의", reason: "fin" });
    expect(utts[0]!.finLatencyMs!).toBeGreaterThanOrEqual(25);
    expect(st.hasPending).toBe(false);
    f.send(f.conns[0]!, [["끝", false, 400, 500]]);
    await until(() => st.hasPending);
    await st.close(1000);
    expect(f.conns[0]!.controls.map((x) => x.text)).toEqual(['{"type":"finalize"}', ""]);
    expect(utts.map((u) => `${u.text}/${u.reason}`)).toEqual(["회의/fin", "끝/close"]);
    f.stop();
  });

  test("partials are throttled and a pending partial never follows its utterance", async () => {
    const f = fakeSoniox();
    const out: string[] = [];
    const st = new SonioxStream({ apiKey: "k", url: f.url, partialIntervalMs: 200, onUtterance: (u) => out.push(`final:${u.text}`), onPartial: (t) => out.push(`partial:${t}`), onFatal: () => {} });
    st.start();
    expect(await until(() => st.live)).toBe(true);
    const c = f.conns[0]!;
    for (let i = 1; i <= 8; i++) {
      f.send(c, [["가".repeat(i), false, 0, 100 * i]]);
      await Bun.sleep(10);
    }
    await Bun.sleep(260);
    expect(out).toEqual(["partial:가", "partial:가가가가가가가가"]); // 첫 것은 바로, 나머지는 200 ms 뒤 최신 것 하나
    await Bun.sleep(200);
    f.send(c, [["나", false, 0, 100]]);
    await Bun.sleep(20);
    f.send(c, [["나다", false, 0, 200]]); // 200 ms 안: 예약만 됨
    await Bun.sleep(20);
    f.send(c, [["나다", true, 0, 200], ["<end>", true]]); // 발화가 닫히면 예약된 partial은 버린다
    await Bun.sleep(300);
    expect(out.slice(2)).toEqual(["partial:나", "final:나다"]);
    await st.close(200);
    f.stop();
  });

  test("503 → reconnect with backoff, audio keeps flowing; 401 → fatal; no handshake → connect_timeout", async () => {
    let first = true;
    const f = fakeSoniox((c, msg) => {
      if (first && typeof msg !== "string") {
        first = false;
        c.ws.send(JSON.stringify({ error_code: 503, error_type: "unavailable", error_message: "x" }));
        c.ws.close();
      }
    });
    const st = new SonioxStream({ apiKey: "k", url: f.url, backoffMs: [50, 50], onUtterance: () => {}, onFatal: () => {} });
    st.start();
    expect(await until(() => st.live)).toBe(true);
    st.push(new Int16Array(1600), 0);
    expect(await until(() => f.conns.length === 2 && st.live)).toBe(true);
    st.push(new Int16Array(1600), 1600);
    expect(await until(() => f.conns[1]!.audioBytes === 3200)).toBe(true);
    expect(st.stats.reconnects).toBe(1);
    expect(st.stats.errors).toEqual(["503"]);
    await st.close(200);
    f.stop();

    const g = fakeSoniox((c, msg) => {
      if (typeof msg === "string") c.ws.send(JSON.stringify({ error_code: 401, error_type: "unauthenticated", error_message: "bad key" }));
    });
    let fatal = "";
    const st2 = new SonioxStream({ apiKey: "bad", url: g.url, onUtterance: () => {}, onFatal: (r) => (fatal = r) });
    st2.start();
    expect(await until(() => fatal !== "")).toBe(true);
    expect(fatal).toBe("soniox_401");
    expect(st2.failed).toBe(true);
    g.stop();

    const tcp = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } }); // 받기만 하고 핸드셰이크에 답하지 않음
    let fatal3 = "";
    const t0 = Date.now();
    const st3 = new SonioxStream({ apiKey: "k", url: `ws://127.0.0.1:${tcp.port}`, connectTimeoutMs: 300, onUtterance: () => {}, onFatal: (r) => (fatal3 = r) });
    st3.start();
    expect(await until(() => fatal3 !== "", 2000)).toBe(true);
    expect(fatal3).toBe("connect_timeout");
    expect(Date.now() - t0).toBeLessThan(1000);
    tcp.stop(true);
  });

  test("auto endpoint off by option; continuous loud audio still finalizes at maxSegmentMs", async () => {
    const f = fakeSoniox((c, msg) => {
      if (typeof msg !== "string" && c.audioBytes === 3200) f.send(c, [["계속", false, 0, 100]]);
    });
    const eps: number[] = [];
    const l = new Listener({ sttUrl: "http://127.0.0.1:9", onTranscript: () => {}, onEndpoint: (q) => eps.push(q), soniox: { apiKey: "k", url: f.url, endpointDetection: false }, vad: { maxSegmentMs: 1000 } });
    l.start();
    for (let i = 0; i < 16; i++) {
      l.onPcm(int16ToBase64(tone(100, -12, 300)), Date.now());
      await Bun.sleep(15);
    }
    const c = f.conns[0]!;
    expect(c.config.enable_endpoint_detection).toBe(false);
    expect(c.config.max_endpoint_delay_ms).toBeUndefined();
    const fin = c.controls.find((x) => x.text === '{"type":"finalize"}');
    expect(fin).toBeDefined(); // 침묵이 없어도 1초(maxSegmentMs)에서 닫으려 했다
    expect(eps).toEqual([1]);
    expect(fin!.audioBytes).toBeLessThanOrEqual(13 * 3200);
    l.close();
    f.stop();
  });

  test("endpoint {seq} at finalize, before its transcript; no partial in between; empty <fin> leaves a gap; unfinalized close → endpoint then transcript", async () => {
    let round = 0;
    const f = fakeSoniox((c, msg) => {
      if (typeof msg !== "string" && c.audioBytes === 3 * 3200) f.send(c, [[round === 0 ? "모시야" : "음", false, 0, 300]]);
      if (msg === '{"type":"finalize"}') {
        if (round++ === 0) {
          f.send(c, [["모시야 정리", false, 0, 400]]); // finalize 뒤의 미확정 갱신: partial로 내보내지 않는다
          setTimeout(() => f.send(c, [["모시야", true, 0, 500], ["<fin>", true]]), 40);
        } else setTimeout(() => f.send(c, [["<fin>", true]]), 20); // 글자 없이 닫힘
      }
    });
    const out: string[] = [];
    let who: string | null = "하은";
    const l = new Listener({
      sttUrl: "http://127.0.0.1:9",
      onTranscript: (e) => out.push(`transcript:${e.seq}:${e.text}:${e.speaker}`),
      onPartial: (t) => out.push(`partial:${t}`),
      onEndpoint: (seq, speaker) => out.push(`endpoint:${seq}:${speaker}`),
      soniox: { apiKey: "k", url: f.url, partialIntervalMs: 0 },
      finalizeSilenceMs: 300,
      speakerProbe: async () => who,
    });
    l.start();
    const feed = async (loudChunks: number, quietChunks: number) => {
      for (let i = 0; i < loudChunks + quietChunks; i++) {
        l.onPcm(int16ToBase64(i < loudChunks ? tone(100, -12, 300) : silence(100, -90)), Date.now());
        await Bun.sleep(15);
      }
    };
    await feed(4, 6);
    expect(await until(() => out.some((x) => x.startsWith("transcript:1")))).toBe(true);
    // endpoint와 transcript가 같은 speaker(finalize 때 정한 값)
    expect(out).toEqual(["partial:모시야", "endpoint:1:하은", "transcript:1:모시야:하은"]);
    // 두 번째 발화: finalize했지만 <fin>에 글자가 없다 → endpoint 2 뒤에 transcript 없음
    // finalize 뒤 VAD hangover 동안의 조사가 다음 발화로 넘어가지 않는다: 2번은 지호만
    out.length = 0;
    who = "지호";
    f.conns[0]!.audioBytes = 0;
    await feed(4, 6);
    await Bun.sleep(150);
    expect(out).toEqual(["partial:음", "endpoint:2:지호"]);
    // 세 번째: finalize 전에 스트림을 닫으면 endpoint 3을 먼저, 그다음 transcript 3
    out.length = 0;
    f.send(f.conns[0]!, [["끝", true, 0, 100]]);
    await Bun.sleep(30);
    await l.flush();
    // 소리 없이 닫힌 발화는 말한 사람을 모른다(null), endpoint와 transcript 모두
    expect(out).toEqual(["partial:끝", "endpoint:3:null", "transcript:3:끝:null"]);
    l.close();
    f.stop();
  });

  test("keepalive when no audio flows", async () => {
    const f = fakeSoniox();
    const st = new SonioxStream({ apiKey: "k", url: f.url, keepaliveMs: 100, onUtterance: () => {}, onFatal: () => {} });
    st.start();
    expect(await until(() => f.conns[0]?.controls.some((x) => x.text === '{"type":"keepalive"}') ?? false, 2500)).toBe(true);
    await st.close(200);
    f.stop();
  });

  test("listener: streams PCM, finalizes after 300 ms of silence, transcript with epoch times; 401 → falls back to local STT", async () => {
    const f = fakeSoniox((c, msg) => {
      if (typeof msg !== "string" && c.audioBytes >= 6400 && c.audioBytes <= 6400 * 2) f.send(c, [["모시야", false, 0, 400]]);
      if (msg === '{"type":"finalize"}') f.send(c, [["모시야", true, 0, 500], ["<fin>", true]]);
    });
    const ev: TranscriptEvent[] = [];
    const partials: string[] = [];
    const l = new Listener({
      sttUrl: "http://127.0.0.1:9",
      onTranscript: (e) => ev.push(e),
      onPartial: (t) => partials.push(t),
      soniox: { apiKey: "k", url: f.url },
      finalizeSilenceMs: 300,
    });
    l.start();
    const t0 = Date.now();
    const chunk = (loud: boolean, _i: number) => int16ToBase64(loud ? tone(100, -12, 300) : silence(100, -90));
    for (let i = 0; i < 6; i++) {
      l.onPcm(chunk(true, i), t0 + (i + 1) * 100);
      await Bun.sleep(15);
    }
    for (let i = 6; i < 14; i++) {
      l.onPcm(chunk(false, i), t0 + (i + 1) * 100);
      await Bun.sleep(15);
    }
    expect(await until(() => ev.length === 1)).toBe(true);
    const c = f.conns[0]!;
    const fin = c.controls.find((x) => x.text === '{"type":"finalize"}')!;
    expect(fin.audioBytes).toBe(9 * 3200); // 소리 0.6초 + 침묵 0.3초 뒤에 보냈다(0.2초 묶음이 아니라 정확히)
    expect(partials).toEqual(["모시야"]);
    expect(ev[0]).toMatchObject({ seq: 1, text: "모시야" });
    expect(ev[0]!.startMs).toBe(t0);
    expect(ev[0]!.endMs).toBe(t0 + 500);
    expect(l.sttEngine).toBe("soniox");
    await l.flush();
    l.close();
    f.stop();

    // 401 → 로컬 STT로 넘어간다
    const g = fakeSoniox((c, msg) => typeof msg === "string" && c.ws.send(JSON.stringify({ error_code: 401 })));
    const ev2: TranscriptEvent[] = [];
    let fb = "";
    const l2 = new Listener({
      sttUrl: "http://127.0.0.1:9",
      onTranscript: (e) => ev2.push(e),
      soniox: { apiKey: "bad", url: g.url },
      onFallback: (r) => (fb = r),
      stt: async () => ({ text: "로컬", ms: 1, noSpeech: false }),
    });
    l2.start();
    expect(await until(() => fb !== "")).toBe(true);
    expect(fb).toBe("soniox_401");
    expect(l2.sttEngine).toBe("local");
    l2.onPcm(int16ToBase64(cat(tone(800), silence(1200))), Date.now());
    await l2.flush();
    expect(ev2.map((e) => e.text)).toEqual(["로컬"]);
    l2.close();
    g.stop();
  });
});

// ---------------------------------------------------------------- HTTP API (가짜 세션)
describe("http api", () => {
  class FakeSession implements SessionLike {
    state: MeetState = "launching";
    endReason?: string;
    said: string[] = [];
    private subs = new Set<(e: SessionEvent) => void>();
    constructor(readonly id: string) {}
    get active() {
      return !isTerminal(this.state);
    }
    snapshot() {
      return { id: this.id, state: this.state };
    }
    subscribe(fn: (e: SessionEvent) => void) {
      this.subs.add(fn);
      return () => this.subs.delete(fn);
    }
    start() {}
    set(state: MeetState, reason?: string) {
      this.state = state;
      for (const f of this.subs) f({ event: "state", data: { state, ...(reason ? { reason } : {}) } });
      if (isTerminal(state)) {
        this.endReason = endReasonFor(state, reason);
        for (const f of this.subs) f({ event: "ended", data: { reason: endReasonFor(state, reason) } });
      }
    }
    sayText(text: string) {
      this.said.push(text);
      return `say_${this.said.length}`;
    }
    sayCached(text: string) {
      return text === "네," ? `say_c${this.said.push(`cached:${text}`)}` : null;
    }
    async stopSaying() {
      return 0;
    }
    async leave() {
      this.set("ended", "left");
      return this.state;
    }
    async done() {}
    transcriptsSince(since: number) {
      return [1, 2, 3].filter((n) => n > since).map((seq) => ({ seq, text: `t${seq}`, startMs: seq, endMs: seq + 1, speaker: null }));
    }
  }
  const made: FakeSession[] = [];
  const inits: { sttPrompt?: string }[] = [];
  const app = createApp({ ...config, stt: "local" }, {
    makeSession: (init) => {
      const s = new FakeSession(init.id);
      made.push(s);
      inits.push(init);
      return s;
    },
    health: async () => ({ chrome: "ready", stt: "down", tts: "ready" }),
  });
  const call = (method: string, path: string, body?: unknown) =>
    app.fetch(new Request(`http://127.0.0.1${path}`, { method, ...(body !== undefined ? { body: typeof body === "string" ? body : JSON.stringify(body), headers: { "Content-Type": "application/json" } } : {}) }));

  test("health, validation, busy, say rules, SSE, delete", async () => {
    let r = await call("GET", "/health");
    expect(await r.json()).toEqual({ ok: true, chrome: "ready", stt: "down", tts: "ready", sttEngine: "local", session: null });

    r = await call("POST", "/sessions", { url: "https://zoom.us/j/123" });
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ error: "invalid_url" });
    r = await call("POST", "/sessions", "{not json");
    expect(r.status).toBe(400);
    r = await call("POST", "/sessions", { url: "http://127.0.0.1:1234/loopback.html", test: "loopback" }); // 테스트 모드가 꺼져 있으면 거절
    expect(r.status).toBe(400);

    r = await call("POST", "/sessions", { url: "https://meet.google.com/abc-defg-hij", name: "모시", sttPrompt: "깽이야, 지금 회의 내용 좀 정리해 줄래?" });
    expect(r.status).toBe(201);
    expect(inits[0]!.sttPrompt).toBe("깽이야, 지금 회의 내용 좀 정리해 줄래?");
    const { id, state } = (await r.json()) as { id: string; state: string };
    expect(state).toBe("launching");
    expect(id).toMatch(/^m_[0-9a-f]{12}$/);
    const s = made[0]!;

    r = await call("POST", "/sessions", { url: "https://meet.google.com/xyz-abcd-efg" });
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ error: "busy" });
    expect(((await (await call("GET", "/health")).json()) as { session: string }).session).toBe(id);

    r = await call("POST", `/sessions/${id}/say`, { text: "안녕하세요" });
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ error: "not_in_call" });

    // SSE: 연결하면 현재 상태부터
    const es = await call("GET", `/sessions/${id}/events`);
    expect(es.headers.get("content-type")).toContain("text/event-stream");
    const reader = es.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    const readUntil = async (needle: string) => {
      while (!buf.includes(needle)) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value);
      }
    };
    await readUntil("\n\n");
    expect(buf).toBe(`event: state\ndata: {"state":"launching"}\n\n`);

    // 다시 붙을 때 ?since=1 이면 seq 2, 3을 상태 다음에 다시 보낸다
    const re = await call("GET", `/sessions/${id}/events?since=1`);
    const rr = re.body!.getReader();
    let rb = "";
    while ((rb.match(/\n\n/g) ?? []).length < 3) rb += dec.decode((await rr.read()).value);
    await rr.cancel();
    expect(rb).toBe(`event: state\ndata: {"state":"launching"}\n\nevent: transcript\ndata: {"seq":2,"text":"t2","startMs":2,"endMs":3,"speaker":null}\n\nevent: transcript\ndata: {"seq":3,"text":"t3","startMs":3,"endMs":4,"speaker":null}\n\n`);

    s.set("prejoin");
    s.set("in_call");
    r = await call("POST", `/sessions/${id}/say`, { text: "" });
    expect(await r.json()).toEqual({ error: "empty_text" });
    r = await call("POST", `/sessions/${id}/say`, { text: "가".repeat(601) });
    expect(await r.json()).toEqual({ error: "too_long" });
    r = await call("POST", `/sessions/${id}/say`, { text: "회의에서 5분 늦는다고 전해 주세요" });
    expect(r.status).toBe(202);
    expect(await r.json()).toEqual({ sayId: "say_1" });
    r = await call("POST", `/sessions/${id}/say`, { text: "네,", cached: true });
    expect(r.status).toBe(202);
    expect(await r.json()).toEqual({ sayId: "say_c2", cached: true });
    r = await call("POST", `/sessions/${id}/say`, { text: "음,", cached: true }); // 캐시에 없으면 일반 TTS로
    expect(r.status).toBe(202);
    expect(await r.json()).toEqual({ sayId: "say_3", cached: false });
    expect(s.said.at(-1)).toBe("음,");
    r = await call("POST", `/sessions/${id}/say/stop`);
    expect(r.status).toBe(200);

    expect(await (await call("GET", `/sessions/${id}`)).json()).toEqual({ id, state: "in_call" });
    r = await call("DELETE", `/sessions/${id}`);
    expect(await r.json()).toEqual({ state: "ended" });

    await readUntil("event: ended");
    const { done } = await reader.read();
    expect(done).toBe(true);
    expect(buf).toContain(`event: state\ndata: {"state":"in_call"}\n\n`);
    expect(buf).toContain(`event: ended\ndata: {"reason":"left"}\n\n`);

    // 끝난 세션에 늦게 붙으면 상태와 ended만 받고 닫힌다
    const late = await (await call("GET", `/sessions/${id}/events`)).text();
    expect(late).toBe(`event: state\ndata: {"state":"ended"}\n\nevent: ended\ndata: {"reason":"left"}\n\n`);

    expect((await call("GET", "/sessions/m_000000000000")).status).toBe(404);
    // 끝났으니 새 회의 가능
    r = await call("POST", "/sessions", { url: "https://meet.google.com/xyz-abcd-efg" });
    expect(r.status).toBe(201);
  });
});

describe("browser: goto retry, failure reason, bounded teardown", () => {
  // 오류 메시지에는 회의 URL이 들어 있다: 로그에는 이름·망 오류 코드만 남아야 한다
  const URL_IN_MSG = "https://meet.google.com/abc-defg-hij";
  const timeoutErr = () => Object.assign(new Error(`page.goto: Timeout 8000ms exceeded.\nCall log:\n  - navigating to "${URL_IN_MSG}"`), { name: "TimeoutError" });
  const netErr = () => new Error(`page.goto: net::ERR_CONNECTION_TIMED_OUT at ${URL_IN_MSG}`);
  const closedErr = () => new Error("page.goto: Target page, context or browser has been closed");

  type Step = "ok" | Error;
  function fakeBrowser(plan: { goto: Step[]; hangClose?: number[]; hangCookies?: boolean }) {
    const rec = { launches: 0, gotos: [] as { waitUntil?: string; timeout?: number }[], closes: [] as number[], killed: [] as number[], killedAt: 0 };
    const ops: BrowserOps = {
      launch: async () => {
        const i = rec.launches++;
        const page = {
          goto: async (_url: string, opts: { waitUntil?: string; timeout?: number }) => {
            rec.gotos.push(opts);
            const step = plan.goto[i] ?? "ok";
            if (step !== "ok") throw step;
            return null;
          },
          waitForLoadState: async () => {},
          waitForFunction: () => new Promise(() => {}), // loopback 준비 신호는 오지 않는다 → prejoin에 머문다
          on: () => {},
          isClosed: () => false,
          evaluate: async () => null,
          close: async () => {},
        };
        const ctx = {
          pages: () => [page],
          newPage: async () => page,
          on: () => {},
          exposeBinding: async () => {},
          addInitScript: async () => {},
          cookies: () => (plan.hangCookies ? new Promise(() => {}) : Promise.resolve([{ name: "SID", value: "secret-cookie-value" }])),
          close: () => {
            rec.closes.push(i);
            return plan.hangClose?.includes(i) ? new Promise<void>(() => {}) : Promise.resolve();
          },
        };
        return ctx as unknown as BrowserContext;
      },
      findPid: async () => 70000 + rec.launches - 1,
      kill: async (pid) => {
        rec.killed.push(pid);
        rec.killedAt = Date.now();
        return true;
      },
    };
    return { ops, rec };
  }
  const profileDir = mkdtempSync(join(tmpdir(), "meet-unit-profile-"));
  const cfg = { ...config, stt: "local" as const, ackTexts: [], testLoopback: true, profileDir };
  function makeSession(ops: BrowserOps, id: string) {
    const s = new Session({ id, url: "http://127.0.0.1:9/loopback.html", code: "tst-loop-bck", name: "모시", loopback: true }, cfg, ops);
    const events: (SessionEvent & { at: number })[] = [];
    s.subscribe((e) => events.push({ ...e, at: Date.now() }));
    return { s, events };
  }
  function captureLog() {
    const lines: string[] = [];
    const spy = spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);
    return { lines, restore: () => spy.mockRestore() };
  }

  test("goto throws once → Chrome closed, relaunched, second attempt succeeds; log has name/stage/attempt, no URL", async () => {
    const { ops, rec } = fakeBrowser({ goto: [timeoutErr(), "ok"] });
    const cap = captureLog();
    try {
      const { s, events } = makeSession(ops, "s_retry");
      s.start();
      expect(await until(() => events.some((e) => e.event === "state" && e.data.state === "prejoin"))).toBe(true);
      expect(rec.launches).toBe(2);
      expect(rec.closes).toEqual([0]); // 첫 Chrome은 닫고 다시 띄웠다
      expect(rec.killed).toEqual([]);
      // 시도마다: 서버 응답(commit) 8초, 전체 20초
      expect(rec.gotos.map((g) => [g.waitUntil, g.timeout])).toEqual([
        ["commit", 8000],
        ["commit", 8000],
      ]);
      expect(events.some((e) => e.event === "state" && e.data.state === "failed")).toBe(false);
      await s.leave();
      expect(rec.closes).toEqual([0, 1]);
    } finally {
      cap.restore();
    }
    const log = cap.lines.join("");
    // 띄우기 시간과 쿠키 저장소(Keychain) 응답 여부도 같이, 쿠키 내용은 없이
    expect(log).toMatch(/goto_failed name=TimeoutError stage=commit attempt=1\/2 ms=\d+ launchMs=\d+ cookies=ok\/\d+ms/);
    expect(log).not.toContain("abc-defg-hij");
    expect(log).not.toContain("meet.google.com");
    expect(log).not.toContain("secret-cookie-value");
    expect(log).not.toContain("SID");
  });

  test("goto failure log says cookies=timeout when ctx.cookies() does not answer (Keychain stall clue)", async () => {
    const { ops } = fakeBrowser({ goto: [netErr(), "ok"], hangCookies: true });
    const cap = captureLog();
    try {
      const s = new Session({ id: "s_kc", url: "http://127.0.0.1:9/loopback.html", code: "tst-loop-bck", name: "모시", loopback: true }, { ...cfg, cookieProbeMs: 150 }, ops);
      const events: SessionEvent[] = [];
      s.subscribe((e) => events.push(e));
      s.start();
      expect(await until(() => events.some((e) => e.event === "state" && e.data.state === "prejoin"))).toBe(true);
      await s.leave();
    } finally {
      cap.restore();
    }
    expect(cap.lines.join("")).toMatch(/goto_failed name=Error net=ERR_CONNECTION_TIMED_OUT stage=commit attempt=1\/2 ms=\d+ launchMs=\d+ cookies=timeout/);
    expect(config.cookieProbeMs).toBe(2000);
  });

  test("goto throws twice → failed with network_unavailable (net errors / timeouts) or goto_failed (anything else)", async () => {
    const cap = captureLog();
    try {
      const a = fakeBrowser({ goto: [netErr(), timeoutErr()] });
      const one = makeSession(a.ops, "s_net");
      one.s.start();
      await one.s.done();
      expect(one.events.filter((e) => e.event === "state").map((e) => e.data)).toEqual([{ state: "failed", reason: "network_unavailable" }]);
      expect(one.events.find((e) => e.event === "ended")?.data).toEqual({ reason: "error", state: "failed" });
      expect(a.rec.launches).toBe(2);
      expect(a.rec.closes).toEqual([0, 1]);

      const b = fakeBrowser({ goto: [closedErr(), closedErr()] });
      const two = makeSession(b.ops, "s_other");
      two.s.start();
      await two.s.done();
      expect(two.events.filter((e) => e.event === "state").map((e) => e.data)).toEqual([{ state: "failed", reason: "goto_failed" }]);
    } finally {
      cap.restore();
    }
    const log = cap.lines.join("");
    expect(log).toContain("goto_failed name=Error net=ERR_CONNECTION_TIMED_OUT stage=commit attempt=1/2");
    expect(log).toContain("goto_failed name=TimeoutError stage=commit attempt=2/2");
    expect(log).toContain("error reason=network_unavailable");
    expect(log).not.toContain("abc-defg-hij");
  });

  test("ctx.close() hangs → Chrome process killed at 5 s, session finishes; next launch waits for it", async () => {
    expect(config.closeTimeoutMs).toBe(5000);
    const { ops, rec } = fakeBrowser({ goto: [netErr(), netErr()], hangClose: [1] });
    const cap = captureLog();
    let failedAt = 0;
    let endedAt = 0;
    try {
      const { s, events } = makeSession(ops, "s_hang");
      s.subscribe((e) => {
        if (e.event === "state" && e.data.state === "failed") failedAt = Date.now();
        if (e.event === "ended") endedAt = Date.now();
      });
      s.start();
      await s.done();
      expect(events.find((e) => e.event === "ended")).toBeTruthy();
    } finally {
      cap.restore();
    }
    expect(rec.killed).toEqual([70001]); // 멈춘 두 번째 Chrome(그 pid)만
    expect(rec.killedAt - failedAt).toBeGreaterThanOrEqual(4900);
    expect(rec.killedAt - failedAt).toBeLessThan(5600);
    expect(endedAt - failedAt).toBeLessThan(5700);
    expect(cap.lines.join("")).toMatch(/teardown forced \(failed\) chrome killed after 5\d\d\dms/);
  }, 15_000);

  test("closeBounded: closes normally, or kills the pid after the timeout (pid looked up only when needed)", async () => {
    let lookups = 0;
    const killed: number[] = [];
    const ops = { kill: async (p: number) => (killed.push(p), true) };
    const ok = { close: async () => {} } as unknown as BrowserContext;
    expect(await closeBounded(ok, async () => (lookups++, 1), ops, 200)).toBe("closed");
    expect(lookups).toBe(0);
    const stuck = { close: () => new Promise<void>(() => {}) } as unknown as BrowserContext;
    const t = Date.now();
    expect(await closeBounded(stuck, async () => (lookups++, 4321), ops, 200)).toBe("forced");
    expect(Date.now() - t).toBeLessThan(400);
    expect(killed).toEqual([4321]);
    expect(await closeBounded(stuck, async () => null, ops, 50)).toBe("forced_no_pid");
  });

  test("gotoFailure keeps only the error name and the net::ERR code", () => {
    expect(gotoFailure(netErr(), "commit", 16000)).toEqual({ name: "Error", net: "ERR_CONNECTION_TIMED_OUT", stage: "commit", network: true, ms: 16000 });
    expect(gotoFailure(timeoutErr(), "load", 20000)).toEqual({ name: "TimeoutError", net: null, stage: "load", network: true, ms: 20000 });
    expect(gotoFailure(new Error("page.goto: net::ERR_ABORTED at x"), "commit", 1).network).toBe(false);
    expect(gotoFailure(new Error("net::ERR_NAME_NOT_RESOLVED"), "commit", 1).network).toBe(true);
    expect(gotoFailure(Object.assign(new Error("x"), { name: "Weird name: https://x" }), "commit", 1).name).toBe("Error");
  });

  test("findChromePid finds our child by --user-data-dir (not --type= helpers, not other profiles); killTree kills it", async () => {
    const dir = join(profileDir, "chrome-like");
    const spawnLike = (...extra: string[]) => Bun.spawn(["/bin/sh", "-c", "sleep 30; :", "chrome-like", ...extra], { stdout: "ignore", stderr: "ignore" });
    const helper = spawnLike(`--user-data-dir=${dir}`, "--type=renderer");
    const other = spawnLike(`--user-data-dir=${dir}-other`);
    const main = spawnLike(`--user-data-dir=${dir}`);
    try {
      await Bun.sleep(100);
      expect(await findChromePid(dir)).toBe(main.pid);
      expect(await killTree(main.pid, 2000)).toBe(true);
      expect(await findChromePid(dir)).toBe(null);
    } finally {
      for (const p of [helper, other, main]) p.kill(9);
    }
  });
});
