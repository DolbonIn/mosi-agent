import { ApiError, apiRaw } from "../../../api/client";
import { speak as webSpeak, speechSupport, stopSpeaking as webStop } from "./speech";
import { audioContext, audioGraph, closeAudio } from "./audioUnlock";
import type { VoiceKind } from "./callState";
import { packSegments, speechChunks } from "./speechText";
import { heardText, type HeardSpan } from "./heard";

export type { VoiceKind } from "./callState";

/**
 * The agent's voice in a call (Fish Audio Drama-3 on the server), spoken WHILE the reply streams: openReply() takes
 * the pieces the call cuts from the growing draft (speechText.ts speechCutter: whole sentences, the first maybe a
 * clause) and says them in order, each once, best path first:
 *   1. stream     POST /api/tts/stream {text} → raw PCM s16le mono (rate in X-Sample-Rate), read with
 *                 response.body.getReader() and scheduled gap-free as AudioBufferSourceNodes on one AudioContext after a
 *                 ~150 ms jitter cushion. The first piece goes as soon as it is cut; each later request carries every
 *                 piece cut meanwhile (≤ 600 characters) and is sent once the previous request's audio has all arrived
 *                 (one request in flight per reply: a queued line can't be cancelled after a barge-in).
 *   2. sentences  POST /api/tts per sentence → audio/mpeg: sentence #1 plays as soon as it arrives, #2 is generated
 *                 while it plays, … (one request in flight).
 *   3. Web Speech ko-KR.
 * A path that fails BEFORE its first audio hands the rest of the reply to the next one: 503 / no route, a network
 * error, nothing within 6 s (stream) or 12 s (a sentence). A stream that breaks later continues with the sentence
 * pipeline from the first request that didn't arrive. tts_unavailable (503) from /api/tts, or two soft failures, is
 * remembered for 2 minutes (later replies go straight to Web Speech; 503 also means "busy" — the service runs one
 * generation at a time for everyone — so it is tried again after that); a server without the routes is remembered
 * for the session. A 503 from the stream alone only moves that reply to step 2.
 *   (the AudioContext itself — unlocked inside the tap, prewarmed — lives in audioUnlock.ts, loaded with the app)
 *   heard()         (on a reply) what of it was heard so far, in whole words (heard.ts): read it before stopVoice()
 *   stopVoice()     barge-in: silence at once, abort the fetch (AbortController), flush every scheduled source;
 *                   stopVoice(fadeMs): the same after a short fade (the reply diverged from what was said)
 *   closeVoice()    end of the call
 * The level reported while server audio plays is the REAL output level (AnalyserNode after the sources, RMS ~30 Hz,
 * 0.1 s smoothing); Web Speech exposes no audio, so its level is 0. The meter runs only while audio plays.
 */
export type SpeakOutcome = "done" | "stopped";

const CHUNK_TIMEOUT_MS = 12_000;
const STREAM_FIRST_MS = 6_000;
const STREAM_STALL_MS = 8_000;
/** audio buffered before the stream starts playing, and again after an underrun */
const JITTER_S = 0.15;
/** PCM is scheduled in pieces of at least this much (fewer nodes) */
const PIECE_S = 0.08;

/** the server voice is off for this page session (tts_unavailable, no route, or failing repeatedly) */
let serverOffUntil = 0;
/** the stream route is missing or keeps failing: go straight to the sentence pipeline */
let streamOffUntil = 0;
/** "unavailable" also means "busy" (one generation at a time for everyone): remembered for a while, then tried again */
const OFF_FOR_MS = 120_000;
const serverOff = () => Date.now() < serverOffUntil;
const streamOff = () => Date.now() < streamOffUntil;
let softFailures = 0;
let streamFailures = 0;
let run = 0;
let ctrl: AbortController | null = null;
const sources = new Set<AudioBufferSourceNode>();
let meter: ReturnType<typeof setInterval> | null = null;
let levelSink: ((v: number) => void) | null = null;

/** something can speak a reply: the server voice (still on, context made) or Web Speech */
export const canSpeak = () => (!serverOff() && !!audioContext()) || speechSupport().tts;

/** the call's context, running — or null when it can't run (never unlocked, closed, autoplay still blocked) */
async function runningContext(): Promise<AudioContext | null> {
  const c = audioContext();
  if (!c) return null;
  if (c.state === "running") return c;
  await Promise.race([c.resume().catch(() => {}), new Promise((r) => setTimeout(r, 300))]);
  return (c.state as string) === "running" ? c : null;
}

const statusOf = (e: unknown) => (e instanceof ApiError ? e.status : 0);

function noteFailure(e: unknown) {
  const status = statusOf(e);
  // the voice is off, or this server has no TTS route: don't ask again this session
  // no TTS route on this server: for the session; off or busy (503), or failing twice: for a while
  if (status === 404 || status === 501) serverOffUntil = Infinity;
  else if (status === 503) serverOffUntil = Date.now() + OFF_FOR_MS;
  else if (status !== 400 && status !== 401 && status !== 413 && ++softFailures >= 2) {
    serverOffUntil = Date.now() + OFF_FOR_MS;
    softFailures = 0;
  }
}

function noteStreamFailure(e: unknown) {
  const status = statusOf(e);
  if (status === 404 || status === 501 || status === 405) streamOffUntil = Infinity;
  else if (status !== 503 && status !== 400 && status !== 401 && status !== 413 && ++streamFailures >= 2) {
    streamOffUntil = Date.now() + OFF_FOR_MS;
    streamFailures = 0;
  }
}

// ── output: scheduling, level ──

function startMeter() {
  const g = audioGraph();
  if (meter || !g) return;
  const a = g.analyser;
  const buf = new Float32Array(a.fftSize);
  let smooth = 0;
  meter = setInterval(() => {
    a.getFloatTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i]! * buf[i]!;
    const v = Math.max(0, Math.min(1, (Math.sqrt(sum / buf.length) - 0.01) * 5));
    smooth += (v - smooth) * 0.28;
    levelSink?.(smooth < 0.02 ? 0 : smooth);
  }, 33);
}

function stopMeter() {
  if (meter) clearInterval(meter);
  meter = null;
  levelSink?.(0);
}

function stopSource(s: AudioBufferSourceNode) {
  try {
    s.onended = null;
    s.stop();
    s.disconnect();
  } catch {
    /* already stopped */
  }
}

function stopSources() {
  for (const s of sources) stopSource(s);
  sources.clear();
}

/**
 * back-to-back playback on the context clock; `last` settles when the latest scheduled piece ends; `onStart` runs when
 * a piece starts the timeline from silence (the reply's first audio, or audio again after it ran out)
 */
interface Timeline {
  cur: AudioContext;
  endAt: number;
  last: Promise<void>;
  onStart?: () => void;
  /** the request whose audio is being scheduled (heard()) */
  span?: HeardSpan;
}

function schedule(t: Timeline, buf: AudioBuffer, cushion: number) {
  const src = t.cur.createBufferSource();
  src.buffer = buf;
  const g = audioGraph();
  if (!g) return;
  src.connect(g.out);
  const now = t.cur.currentTime;
  const idle = t.endAt <= now + 0.005;
  const at = idle ? now + cushion : t.endAt;
  src.start(at);
  t.endAt = at + buf.duration;
  t.span?.pieces.push({ at, dur: buf.duration });
  sources.add(src);
  t.last = new Promise<void>((r) => {
    src.onended = () => {
      sources.delete(src);
      r();
    };
  });
  startMeter();
  if (idle) t.onStart?.();
}

/** wait for what was scheduled to play out (or be cut off); a clock that stalls (no output device) can't hold the call */
async function playOut(t: Timeline, stopped: Promise<void>) {
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  const stall = new Promise<void>((r) => (watchdog = setTimeout(r, Math.max(0, t.endAt - t.cur.currentTime) * 1000 + 1500)));
  await Promise.race([t.last, stopped, stall]);
  clearTimeout(watchdog);
}

const linked = (outer: AbortSignal) => {
  const c = new AbortController();
  const onAbort = () => c.abort();
  if (outer.aborted) c.abort();
  else outer.addEventListener("abort", onAbort, { once: true });
  return { c, unlink: () => outer.removeEventListener("abort", onAbort) };
};

// ── 1. the stream ──

function sampleRate(res: Response): number {
  const n = Number(res.headers.get("X-Sample-Rate") ?? /rate=(\d+)/i.exec(res.headers.get("Content-Type") ?? "")?.[1]);
  return Number.isFinite(n) && n >= 8000 && n <= 192_000 ? n : 0;
}

/** s16le bytes → float samples; an odd trailing byte is carried into the next read */
function pcmDecoder() {
  let carry: number | null = null;
  return (chunk: Uint8Array): Float32Array => {
    let bytes = chunk;
    if (carry !== null) {
      bytes = new Uint8Array(chunk.length + 1);
      bytes[0] = carry;
      bytes.set(chunk, 1);
      carry = null;
    }
    const n = bytes.length >> 1;
    if (bytes.length & 1) carry = bytes[bytes.length - 1]!;
    const view = new DataView(bytes.buffer, bytes.byteOffset, n * 2);
    const f = new Float32Array(n);
    for (let i = 0; i < n; i++) f[i] = view.getInt16(i * 2, true) / 32768;
    return f;
  };
}

/** gathers samples into pieces: the first one waits for the jitter cushion, an underrun waits for it again */
function pcmQueue(t: Timeline) {
  let parts: Float32Array[] = [];
  let len = 0;
  let rate = 0;
  const flush = () => {
    if (!len) return;
    const buf = t.cur.createBuffer(1, len, rate);
    const ch = buf.getChannelData(0);
    let o = 0;
    for (const p of parts) {
      ch.set(p, o);
      o += p.length;
    }
    parts = [];
    len = 0;
    schedule(t, buf, 0.02);
  };
  return {
    push(samples: Float32Array, r: number) {
      if (rate && r !== rate) flush();
      rate = r;
      parts.push(samples);
      len += samples.length;
      const playing = t.endAt > t.cur.currentTime + 0.005;
      if (len >= (playing ? PIECE_S : JITTER_S) * rate) flush();
    },
    flush,
  };
}

/** one stream request; resolves with the bytes received (0 = failed before any audio) and the error, if any */
async function streamOne(text: string, outer: AbortSignal, q: ReturnType<typeof pcmQueue>): Promise<{ bytes: number; error?: unknown }> {
  const { c, unlink } = linked(outer);
  let bytes = 0;
  let timedOut = false;
  let timer = setTimeout(() => {
    timedOut = true;
    c.abort();
  }, STREAM_FIRST_MS);
  try {
    const res = await apiRaw("POST", "/api/tts/stream", { text }, { signal: c.signal, timeoutMs: 0, headers: { Accept: "audio/L16" } });
    const rate = sampleRate(res);
    if (!rate || !res.body) throw new ApiError(0, "bad_response", "");
    const reader = res.body.getReader();
    const decodePcm = pcmDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.length) continue;
      bytes += value.length;
      // from the first audio on, only a stall (no data for 8 s) ends the stream early
      clearTimeout(timer);
      timer = setTimeout(() => c.abort(), STREAM_STALL_MS);
      q.push(decodePcm(value), rate);
    }
    return { bytes };
  } catch (e) {
    return { bytes, error: timedOut ? new ApiError(408, "timeout", "") : e };
  } finally {
    clearTimeout(timer);
    unlink();
  }
}

// ── 2. the sentence pipeline ──

function decode(c: AudioContext, data: ArrayBuffer): Promise<AudioBuffer> {
  return new Promise((resolve, reject) => {
    // older Safari: callbacks only; newer engines: both (the first settle wins)
    const p = c.decodeAudioData(data, resolve, reject) as Promise<AudioBuffer> | undefined;
    p?.then(resolve, reject);
  });
}

async function fetchChunk(text: string, outer: AbortSignal): Promise<AudioBuffer> {
  const { c, unlink } = linked(outer);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    c.abort();
  }, CHUNK_TIMEOUT_MS);
  try {
    const res = await apiRaw("POST", "/api/tts", { text }, { signal: c.signal, timeoutMs: 0, headers: { Accept: "audio/mpeg" } });
    const data = await res.arrayBuffer();
    const cur = audioContext();
    if (!cur) throw new ApiError(0, "aborted", "");
    return await decode(cur, data);
  } catch (e) {
    if (timedOut) throw new ApiError(408, "timeout", "");
    throw e;
  } finally {
    clearTimeout(timer);
    unlink();
  }
}

// ── the reply ──

export interface VoiceHooks {
  onLevel(v: number): void;
  /** which voice took the reply: its first request went out (stream, sentences) or Web Speech began */
  onVoice?(v: VoiceKind): void;
  /** true: audio started (the reply's first, or again after it ran out); false: it ran out while more may come */
  onPlaying?(playing: boolean): void;
}

/** a reply being spoken while it streams */
export interface ReplyVoice {
  /** a piece to say after everything pushed before it (pieces are whole sentences, or the first one a clause) */
  push(piece: string): void;
  /** nothing more is coming: `outcome` settles once everything pushed was said */
  end(): void;
  /**
   * "done" when everything pushed was said, "stopped" when stopVoice() (barge-in, mute, end) or a newer reply cut it
   * off — the caller then must not resume listening on its own
   */
  readonly outcome: Promise<SpeakOutcome>;
  /** what of it was heard so far (speakable text, whole words): read it before stopVoice() cuts it off */
  heard(): string;
}

/** Start speaking a reply (any reply still speaking is cut off). Pieces arrive with push(); end() closes it. */
export function openReply(h: VoiceHooks): ReplyVoice {
  stopVoice();
  const my = ++run;
  const alive = () => my === run;
  const c = new AbortController();
  ctrl = c;
  const signal = c.signal;
  const stopped = new Promise<void>((r) => signal.addEventListener("abort", () => r(), { once: true }));
  const queue: string[] = [];
  let ended = false;
  let wake: (() => void) | null = null;
  const poke = () => {
    const w = wake;
    wake = null;
    w?.();
  };
  let timeline: Timeline | null = null;
  /** what was said so far and how (heard()) */
  const spans: HeardSpan[] = [];
  const span = (text: string, more: Partial<HeardSpan> = {}): HeardSpan => {
    const s: HeardSpan = { text, pieces: [], complete: false, ...more };
    spans.push(s);
    return s;
  };
  let playing = false;
  const setPlaying = (on: boolean) => {
    if (on === playing || !alive()) return;
    playing = on;
    h.onPlaying?.(on);
  };

  /** every piece pushed so far (waiting for one if none): null once the reply is over (ended and said, or stopped) */
  async function take(): Promise<string[] | null> {
    if (!queue.length && !ended && alive()) {
      // waiting for text: say so once the audio scheduled so far has played out (the turn is running a tool)
      const t = timeline;
      const idle = setTimeout(() => setPlaying(false), t ? Math.max(0, t.endAt - t.cur.currentTime) * 1000 + 120 : 0);
      while (!queue.length && !ended && alive()) await Promise.race([new Promise<void>((r) => (wake = r)), stopped]);
      clearTimeout(idle);
    }
    if (!alive() || !queue.length) return null;
    return queue.splice(0);
  }

  /** 1. the stream → "done" | "stopped", or the pieces from the first request that didn't arrive */
  async function streamPath(t: Timeline): Promise<SpeakOutcome | string[]> {
    const q = pcmQueue(t);
    for (;;) {
      const batch = await take();
      if (!alive()) return "stopped";
      if (!batch) break;
      const segments = packSegments(batch);
      for (let k = 0; k < segments.length; k++) {
        const sp = (t.span = span(segments[k]!));
        const r = await streamOne(segments[k]!, signal, q);
        if (!alive()) return "stopped";
        if (r.bytes === 0) {
          noteStreamFailure(r.error);
          q.flush();
          spans.splice(spans.indexOf(sp), 1);
          t.span = undefined;
          return segments.slice(k);
        }
        streamFailures = 0;
        // the request's tail plays now: the next one takes at least a time-to-first-audio
        q.flush();
        sp.complete = !r.error;
      }
    }
    q.flush();
    await playOut(t, stopped);
    return alive() ? "done" : "stopped";
  }

  /** 2. the sentence pipeline → "done" | "stopped", or the sentences from the first one that didn't arrive */
  async function sentencePath(t: Timeline, first: string[]): Promise<SpeakOutcome | string[]> {
    const pending = first.flatMap(speechChunks);
    let next: { text: string; audio: Promise<AudioBuffer> } | null = null;
    const request = (text: string) => {
      const audio = fetchChunk(text, signal);
      audio.catch(() => {});
      next = { text, audio };
    };
    /** the next sentence's request (waiting for text if none is cut yet): false once the reply is over */
    const ask = async (): Promise<boolean> => {
      if (!pending.length) {
        const more = await take();
        if (!more) return false;
        pending.push(...more.flatMap(speechChunks));
        if (!pending.length) return ask();
      }
      request(pending.shift()!);
      return true;
    };
    if (await ask())
      for (;;) {
        const cur: { text: string; audio: Promise<AudioBuffer> } = next!;
        next = null;
        let buf: AudioBuffer;
        try {
          buf = await cur.audio;
        } catch (e) {
          if (!alive()) return "stopped";
          noteFailure(e);
          return [cur.text, ...pending];
        }
        if (!alive()) return "stopped";
        softFailures = 0;
        // the next sentence is generated while this one plays
        if (pending.length) request(pending.shift()!);
        if (t.cur.state !== "running") await t.cur.resume().catch(() => {});
        t.span = span(cur.text, { complete: true });
        schedule(t, buf, 0.02);
        if (!next && !(await ask())) break;
      }
    await playOut(t, stopped);
    return alive() ? "done" : "stopped";
  }

  async function speak(): Promise<SpeakOutcome> {
    const cur = serverOff() ? null : await runningContext();
    if (!alive()) return "stopped";
    let rest: string[] = [];
    if (cur && audioGraph()) {
      levelSink = h.onLevel;
      const t: Timeline = { cur, endAt: 0, last: Promise.resolve(), onStart: () => setPlaying(true) };
      timeline = t;
      if (!streamOff()) {
        h.onVoice?.("stream");
        const r = await streamPath(t);
        if (typeof r === "string") return finish(r);
        rest = r;
      }
      if (!serverOff()) {
        h.onVoice?.("sentences");
        const r = await sentencePath(t, rest);
        if (typeof r === "string") return finish(r);
        rest = r;
      }
      stopMeter();
      timeline = null;
    }
    // Web Speech for whatever is left (no audio graph, so no level)
    if (!speechSupport().tts) {
      while (await take());
      return alive() ? "done" : "stopped";
    }
    h.onVoice?.("webspeech");
    h.onLevel(0);
    for (let batch: string[] | null = rest; batch; batch = await take()) {
      for (const chunk of batch.flatMap(speechChunks)) {
        if (!alive()) return "stopped";
        setPlaying(true);
        const sp = span(chunk, { web: true });
        await webSpeak(chunk);
        if (alive()) sp.said = true;
      }
    }
    return alive() ? "done" : "stopped";
  }

  function finish(r: SpeakOutcome): SpeakOutcome {
    if (r === "done") stopMeter();
    return r;
  }

  return {
    push(piece) {
      const p = piece.trim();
      if (!p || ended || !alive()) return;
      queue.push(p);
      poke();
    },
    end() {
      ended = true;
      poke();
    },
    outcome: speak(),
    heard: () => heardText(spans, audioContext()?.currentTime ?? 0),
  };
}

/** barge-in: silence now (or after a `fadeMs` fade: the reply diverged from what was said), drop what was coming */
export function stopVoice(fadeMs = 0) {
  run++;
  ctrl?.abort();
  ctrl = null;
  webStop();
  const g = audioGraph();
  if (fadeMs > 0 && g && sources.size) {
    const fading = [...sources];
    sources.clear();
    const gain = g.out.gain;
    const now = g.ctx.currentTime;
    gain.cancelScheduledValues(now);
    gain.setValueAtTime(gain.value, now);
    gain.linearRampToValueAtTime(0, now + fadeMs / 1000);
    setTimeout(() => {
      for (const s of fading) stopSource(s);
      const at = g.ctx.currentTime;
      gain.cancelScheduledValues(at);
      gain.setValueAtTime(1, at);
    }, fadeMs + 20);
  } else stopSources();
  stopMeter();
  levelSink = null;
}

export function closeVoice() {
  stopVoice();
  closeAudio();
}
