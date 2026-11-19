// 말하기: services/tts /tts/stream(44.1 kHz s16le)을 받는 대로 페이지 가상 마이크로 흘려 넣는다. 순서대로 한 줄씩.
// TTS가 바쁘면(queue ≥ 2) 또는 스트림이 실패하면 /tts wav를 한 번에 받아 재생한다. 그것도 안 되면 로그만 남긴다.
// 줄 사이는 끊김 없이 이어진다: 앞 줄의 소리를 다 예약하면 그 줄이 재생되는 동안 다음 줄의 TTS를 바로 시작한다.
// 맞장구(ack) 소리는 세션 시작 때 한 번 만들어 메모리에 두고, `cached` 줄은 TTS를 부르지 않고 바로 재생한다.
import { bytesToInt16, int16ToBase64, parseWav, rmsDb } from "./audio";
import { log } from "./log";
import { serviceHealth } from "./stt";

export interface PushResult {
  /** 이 묶음이 지금부터 몇 ms 뒤에 소리 나기 시작하는지 */
  startInMs?: number;
}

export interface MicSink {
  /** base64 s16le 한 묶음을 이어서 예약. first = 이 줄의 첫 묶음 */
  push(b64: string, sampleRate: number, first: boolean, sayId: string): Promise<PushResult | void>;
  /** 메모리에 둔 짧은 소리를 바로 예약. 페이지에 아직 없으면 올리고 재생한다. 못 했으면 던진다 */
  playClip?(clip: Clip, sayId: string): Promise<PushResult | void>;
  /** 예약된 소리를 즉시 끊는다 */
  stop(): Promise<void>;
  /** 그 줄의 소리가 다 나갈 때까지 */
  drain(sayId?: string): Promise<void>;
}

export interface SayOptions {
  ttsUrl: string;
  voice?: string;
  sink: MicSink;
  emit: (event: "speaking", data: { on: boolean; sayId: string }) => void;
  /** 말하기 직전(예: 회의 마이크가 꺼져 있으면 켠다). 캐시된 소리는 기다리지 않고 함께 돌린다 */
  beforeSpeak?: () => Promise<void>;
  /** 첫 소리가 날 예정 시각(요청부터 ms) */
  onFirstAudio?: (sayId: string, msSinceRequest: number, path: "stream" | "wav" | "cached") => void;
}

export interface Clip {
  key: string;
  pcm: Int16Array;
  rate: number;
  ms: number;
}

interface Item {
  id: string;
  text: string;
  requestedAt: number;
  clip?: Clip;
}

interface Active {
  seq: number;
  item: Item;
  ac: AbortController;
  /** speaking on을 보냈는가 */
  on: boolean;
  onTimer: ReturnType<typeof setTimeout> | null;
  done: boolean;
}

const MIN_PUSH_SAMPLES = 2205; // 50 ms @ 44.1 kHz — 첫 소리를 빨리 내고, 너무 잘게 쪼개지 않는다

/**
 * TTS 데우기: 공용 Mac이 메모리가 모자라면 쉬고 있던 TTS 가중치가 스왑으로 밀려나 다음 첫 요청이 10~70초 걸린다(2026-11-12 측정).
 * 회의 창을 띄우는 동안 아주 짧은 줄 하나를 요청해 첫 묶음만 받고 끊는다. TTS가 바쁘면(queue > 0) 하지 않는다.
 */
export async function warmTts(ttsUrl: string, voice?: string, timeoutMs = 90_000): Promise<{ ms: number } | null> {
  const h = await serviceHealth(ttsUrl, 800);
  if (!h?.ready || (h.queue ?? 0) > 0) return null;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const t0 = Date.now();
  try {
    const res = await fetch(`${ttsUrl}/tts/stream`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "네.", ...(voice ? { voice } : {}) }), signal: ac.signal });
    if (!res.ok || !res.body) return null;
    const reader = res.body.getReader();
    await reader.read();
    const ms = Date.now() - t0;
    await reader.cancel().catch(() => {});
    return { ms };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    ac.abort();
  }
}

// ------------------------------------------------------------------ 맞장구 소리 캐시(프로세스 전체에서 하나)

export function clipKey(text: string): string {
  return text.normalize("NFC").trim();
}

/** 앞뒤 무음 자르기: 앞은 10 ms, 뒤는 60 ms만 남긴다(-45 dBFS, 5 ms 창) */
export function trimSilence(pcm: Int16Array, rate: number, thresholdDb = -45): { pcm: Int16Array; leadMs: number } {
  const win = Math.max(1, Math.round(rate / 200));
  let first = -1;
  let last = -1;
  for (let i = 0; i + win <= pcm.length; i += win) {
    if (rmsDb(pcm, i, i + win) >= thresholdDb) {
      if (first < 0) first = i;
      last = i + win;
    }
  }
  if (first < 0) return { pcm: new Int16Array(0), leadMs: 0 };
  const from = Math.max(0, first - Math.round(rate * 0.01));
  const to = Math.min(pcm.length, last + Math.round(rate * 0.06));
  return { pcm: pcm.slice(from, to), leadMs: Math.round((from * 1000) / rate) };
}

export class AckCache {
  private clips = new Map<string, Clip>();
  private rendering: Promise<void> | null = null;
  readonly stats = { rendered: 0, failed: 0, renderMs: [] as number[] };

  get(text: string): Clip | undefined {
    return this.clips.get(clipKey(text));
  }

  keys(): string[] {
    return [...this.clips.keys()];
  }

  set(clip: Clip): void {
    this.clips.set(clip.key, clip);
  }

  /** 없는 것만 TTS로 한 번씩 만든다. TTS가 바쁘면(queue > 0) 최대 waitMs 기다리고, 그래도 바쁘면 다음 기회로 미룬다. */
  ensure(ttsUrl: string, voice: string | undefined, texts: string[], opts: { waitMs?: number; cancelled?: () => boolean } = {}): Promise<void> {
    if (this.rendering) return this.rendering;
    const todo = [...new Set(texts.map(clipKey))].filter((k) => k && !this.clips.has(k));
    if (!todo.length) return Promise.resolve();
    this.rendering = (async () => {
      for (const key of todo) {
        if (opts.cancelled?.()) break;
        const until = Date.now() + (opts.waitMs ?? 20_000);
        let h = await serviceHealth(ttsUrl, 800);
        while (h?.ready && (h.queue ?? 0) > 0 && Date.now() < until && !opts.cancelled?.()) {
          await Bun.sleep(500);
          h = await serviceHealth(ttsUrl, 800);
        }
        if (!h?.ready || (h.queue ?? 0) > 0) {
          log(`ack render skipped (tts ${h ? `busy queue=${h.queue}` : "down"})`);
          break;
        }
        const t0 = Date.now();
        try {
          const clip = await renderClip(ttsUrl, voice, key);
          this.clips.set(key, clip);
          this.stats.rendered++;
          this.stats.renderMs.push(Date.now() - t0);
          log(`ack rendered chars=${key.length} audio=${clip.ms}ms in ${Date.now() - t0}ms`);
        } catch (e) {
          this.stats.failed++;
          log(`ack render failed chars=${key.length} err=${(e as Error).message}`);
        }
      }
    })().finally(() => {
      this.rendering = null;
    });
    return this.rendering;
  }
}

export async function renderClip(ttsUrl: string, voice: string | undefined, key: string, timeoutMs = 60_000): Promise<Clip> {
  const res = await fetch(`${ttsUrl}/tts/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: key, ...(voice ? { voice } : {}) }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok || !res.body) throw new Error(`tts_stream_http_${res.status}`);
  const rate = Number(res.headers.get("x-sample-rate")) || 44100;
  const bytes = new Uint8Array(await res.arrayBuffer());
  const { pcm } = trimSilence(bytesToInt16(bytes), rate);
  if (pcm.length < rate * 0.05) throw new Error("clip_empty");
  if (pcm.length > rate * 4) throw new Error("clip_too_long");
  return { key, pcm, rate, ms: Math.round((pcm.length * 1000) / rate) };
}

/** 서비스 전체에서 같이 쓰는 캐시(세션이 바뀌어도 다시 만들지 않는다) */
export const ackCache = new AckCache();

// ------------------------------------------------------------------ 말하기 대기열

export class SayQueue {
  private items: Item[] = [];
  private active = new Set<Active>();
  private streaming: Active | null = null;
  private running = false;
  private n = 0;
  private seq = 0;
  private closed = false;
  readonly stats = { said: 0, failed: 0, firstAudioMs: [] as number[], ttsFirstChunkMs: [] as number[], fallbacks: 0, cached: 0 };

  constructor(private opts: SayOptions) {}

  /** 말하는 중이거나 대기 중인 줄이 있다 */
  get busy(): boolean {
    return this.running || this.items.length > 0 || this.active.size > 0;
  }

  enqueue(text: string, clip?: Clip): string {
    const id = `say_${Date.now().toString(36)}_${(++this.n).toString(36)}`;
    this.items.push({ id, text, requestedAt: Date.now(), ...(clip ? { clip } : {}) });
    void this.kick();
    return id;
  }

  /** 지금 말하는 것과 대기열을 끊는다. */
  async stop(): Promise<number> {
    // 끊는 동안 새로 들어온 줄은 건드리지 않는다(끊은 직후의 /say는 살아야 한다)
    const victims = [...this.active];
    const dropped = this.items.length + victims.length;
    this.items = [];
    for (const a of victims) a.ac.abort();
    await this.opts.sink.stop().catch(() => {});
    for (const a of victims) this.finish(a, false);
    return dropped;
  }

  /** 끊고, 진행 중이던 줄이 speaking off까지 내보낼 때까지 잠깐(최대 2초) 기다린다. */
  async close(): Promise<void> {
    this.closed = true;
    await this.stop();
    for (let t = Date.now(); (this.running || this.active.size) && Date.now() - t < 2000; ) await Bun.sleep(20);
  }

  private async kick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.items.length && !this.closed) {
        const item = this.items.shift()!;
        await this.produce(item);
      }
    } finally {
      this.running = false;
    }
  }

  /** speaking on은 그 줄의 소리가 실제로 나기 시작할 때(앞 줄 뒤에 붙었으면 앞 줄이 끝날 때) 보낸다. */
  private markStart(a: Active, path: "stream" | "wav" | "cached", startInMs: number | undefined): void {
    if (a.on || a.onTimer || a.done) return;
    const delay = Math.max(0, Math.round(startInMs ?? 0));
    const ms = Date.now() - a.item.requestedAt + delay;
    this.stats.firstAudioMs.push(ms);
    this.opts.onFirstAudio?.(a.item.id, ms, path);
    const fire = () => {
      a.onTimer = null;
      if (a.done || a.on) return;
      // 이 줄이 시작하는 시각이면 앞 줄들은 예약상 이미 끝났다: off를 먼저 보내 순서를 지킨다
      for (const b of [...this.active]) if (b.seq < a.seq && b !== this.streaming) this.finish(b, true);
      a.on = true;
      this.opts.emit("speaking", { on: true, sayId: a.item.id });
    };
    if (delay <= 15) fire();
    else a.onTimer = setTimeout(fire, delay);
  }

  /** 그 줄을 마친다: 소리가 났으면 speaking off */
  private finish(a: Active, completed: boolean): void {
    if (a.done) return;
    a.done = true;
    if (completed) this.stats.said++;
    if (a.onTimer) {
      clearTimeout(a.onTimer);
      a.onTimer = null;
    }
    this.active.delete(a);
    if (a.on) this.opts.emit("speaking", { on: false, sayId: a.item.id });
  }

  /** 앞 줄이 다 나갈 때까지 기다리지 않는다: 소리를 다 예약하면 끝나기를 따로 기다리고, 바로 다음 줄로 넘어간다. */
  private async produce(item: Item): Promise<void> {
    const a: Active = { seq: ++this.seq, item, ac: new AbortController(), on: false, onTimer: null, done: false };
    this.active.add(a);
    this.streaming = a;
    let pushed = false;
    try {
      if (item.clip) {
        // 맞장구는 기다리지 않는다: 마이크 확인(beforeSpeak)·TTS 상태 확인 없이 바로 예약
        void this.opts.beforeSpeak?.().catch(() => {});
        try {
          const r = this.opts.sink.playClip
            ? await this.opts.sink.playClip(item.clip, item.id)
            : await this.opts.sink.push(int16ToBase64(item.clip.pcm), item.clip.rate, true, item.id);
          pushed = !a.ac.signal.aborted;
          this.stats.cached++;
          if (pushed) this.markStart(a, "cached", r ? r.startInMs : undefined);
        } catch (e) {
          this.stats.failed++;
          log(`say ${item.id} cached clip failed err=${(e as Error).message}`);
        }
      } else {
        pushed = await this.speakTts(a);
      }
    } finally {
      if (this.streaming === a) this.streaming = null;
      if (!pushed || a.ac.signal.aborted) this.finish(a, false);
      else
        void this.opts.sink
          .drain(item.id)
          .catch(() => {})
          .then(() => this.finish(a, !a.ac.signal.aborted));
    }
  }

  private async speakTts(a: Active): Promise<boolean> {
    const { item, ac } = a;
    await this.opts.beforeSpeak?.().catch(() => {});
    const health = await serviceHealth(this.opts.ttsUrl, 800);
    let pushed = false;
    if (health?.ready && (health.queue ?? 0) < 2) {
      try {
        pushed = await this.stream(item, ac.signal, (r) => this.markStart(a, "stream", r?.startInMs));
      } catch (e) {
        if (ac.signal.aborted) return false;
        if (a.on || a.onTimer) {
          log(`say ${item.id} stream broke mid-way err=${(e as Error).message}`);
          return true; // 이미 나간 소리는 되돌릴 수 없으니 남은 것만 재생하고 끝낸다
        }
        log(`say ${item.id} stream failed err=${(e as Error).message}; trying wav`);
      }
    } else {
      log(`say ${item.id} tts ${health ? `busy queue=${health.queue}` : "down"}; trying wav`);
    }
    if (!pushed && !ac.signal.aborted) {
      this.stats.fallbacks++;
      try {
        pushed = await this.wav(item, ac.signal, (r) => this.markStart(a, "wav", r?.startInMs));
      } catch (e) {
        if (ac.signal.aborted) return false;
        this.stats.failed++;
        log(`say ${item.id} failed (stream and wav) err=${(e as Error).message}`);
        return false;
      }
    }
    return pushed && !ac.signal.aborted;
  }

  private body(item: Item, format?: "wav"): string {
    return JSON.stringify({ text: item.text, ...(this.opts.voice ? { voice: this.opts.voice } : {}), ...(format ? { format } : {}) });
  }

  private async stream(item: Item, signal: AbortSignal, onFirst: (r: PushResult | void) => void): Promise<boolean> {
    const t0 = Date.now();
    const res = await fetch(`${this.opts.ttsUrl}/tts/stream`, { method: "POST", headers: { "Content-Type": "application/json" }, body: this.body(item), signal });
    if (!res.ok || !res.body) throw new Error(`tts_stream_http_${res.status}`);
    const rate = Number(res.headers.get("x-sample-rate")) || 44100;
    const reader = res.body.getReader();
    let carry = new Uint8Array(0);
    let pushedAny = false;
    const pushBytes = async (bytes: Uint8Array) => {
      const pcm = bytesToInt16(bytes);
      if (!pcm.length || signal.aborted) return;
      const r = await this.opts.sink.push(int16ToBase64(pcm), rate, !pushedAny, item.id);
      if (!pushedAny) {
        pushedAny = true;
        onFirst(r);
      }
    };
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (signal.aborted) return pushedAny;
        if (value && value.byteLength) {
          if (!pushedAny && !carry.byteLength) this.stats.ttsFirstChunkMs.push(Date.now() - t0);
          const merged = new Uint8Array(carry.byteLength + value.byteLength);
          merged.set(carry, 0);
          merged.set(value, carry.byteLength);
          carry = merged;
        }
        const minBytes = MIN_PUSH_SAMPLES * 2;
        if (carry.byteLength >= minBytes || (done && carry.byteLength >= 2)) {
          const even = carry.byteLength & ~1;
          const chunk = carry.slice(0, even);
          carry = carry.slice(even);
          await pushBytes(chunk);
        }
        if (done) break;
      }
    } finally {
      reader.releaseLock();
    }
    return pushedAny;
  }

  private async wav(item: Item, signal: AbortSignal, onFirst: (r: PushResult | void) => void): Promise<boolean> {
    const res = await fetch(`${this.opts.ttsUrl}/tts`, { method: "POST", headers: { "Content-Type": "application/json" }, body: this.body(item, "wav"), signal: AbortSignal.any([signal, AbortSignal.timeout(150_000)]) });
    if (!res.ok) throw new Error(`tts_http_${res.status}`);
    const wav = parseWav(new Uint8Array(await res.arrayBuffer()));
    if (signal.aborted) return false;
    const step = Math.max(1, Math.round(wav.sampleRate * 0.5));
    let first = true;
    for (let i = 0; i < wav.pcm.length; i += step) {
      if (signal.aborted) return !first;
      const r = await this.opts.sink.push(int16ToBase64(wav.pcm.subarray(i, i + step)), wav.sampleRate, first, item.id);
      if (first) {
        first = false;
        onFirst(r);
      }
    }
    return !first;
  }
}
