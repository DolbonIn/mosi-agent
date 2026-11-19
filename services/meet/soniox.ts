// 실시간 STT: Soniox WebSocket (docs.soniox.com/api-reference/stt/websocket-api).
// 세션당 연결 하나. 회의 소리(16 kHz s16le mono)를 계속 흘려 보내고, 확정(final) 토큰으로 발화를 만든다.
// 발화는 <end>(Soniox 자동 끝점) 또는 <fin>(우리가 보낸 finalize의 끝)에서 닫는다. 아직 확정 안 된 글자는 partial로 알린다.
// 키는 Bun 프로세스 안에서만 쓴다: 헤더 Authorization으로만 보내고, 로그·페이지·브라우저에는 절대 닿지 않는다.
import { log } from "./log";

export const SONIOX_URL = "wss://stt-rt.soniox.com/transcribe-websocket";
const RATE = 16000;

export interface SonioxToken {
  text: string;
  start_ms?: number;
  end_ms?: number;
  confidence?: number;
  is_final?: boolean;
  speaker?: string;
}

export interface SonioxUtterance {
  text: string;
  /** 리스너 샘플 위치(16 kHz, 스트림 시작부터) */
  startSample: number;
  endSample: number;
  tokens: number;
  reason: "end" | "fin" | "close";
  /** finalize를 보낸 뒤 <fin>까지(ms). finalize로 닫힌 경우만 */
  finLatencyMs?: number;
}

export interface SonioxOptions {
  apiKey: string;
  url?: string;
  model?: string;
  /** 알아듣게 할 낱말(에이전트 이름, "이름+야" 등) */
  terms?: string[];
  /** 자유 문장 맥락(예: sttPrompt) */
  contextText?: string;
  /** Soniox 자동 끝점(<end>). 끄면 우리 finalize(침묵 판정)로만 발화를 닫는다. 기본 켬 */
  endpointDetection?: boolean;
  connectTimeoutMs?: number;
  /** 소리를 이만큼 못 보냈으면 keepalive(서버 한도 40초보다 넉넉히 짧게) */
  keepaliveMs?: number;
  /** 다시 붙기 시도 간격(ms). 다 쓰면 치명 실패 */
  backoffMs?: number[];
  /** 연결이 안 된 동안 모아 두는 소리(ms). 넘으면 오래된 것부터 버린다 */
  bufferMs?: number;
  /** partial 최소 간격(ms) */
  partialIntervalMs?: number;
  onUtterance: (u: SonioxUtterance) => void;
  /** 지금 발화의 확정+미확정 전체 글자 */
  onPartial?: (text: string) => void;
  /** 발화가 닫힘(글자가 없어 onUtterance를 부르지 않은 경우 포함). onUtterance 다음에 온다 */
  onClosed?: (reason: "end" | "fin" | "close", emitted: boolean) => void;
  /** 더 쓸 수 없음(인증·결제·설정 오류, 첫 연결 실패, 다시 붙기 실패). 이유 코드만 */
  onFatal: (reason: string) => void;
}

/** 이 세 가지는 다시 붙어도 소용없다 */
const FATAL_CODES = new Set([400, 401, 402, 403]);

export class SonioxStream {
  private ws: WebSocket | null = null;
  private state: "idle" | "connecting" | "live" | "reconnecting" | "closing" | "closed" | "failed" = "idle";
  private everLive = false;
  private attempt = 0;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private keepTimer: ReturnType<typeof setInterval> | null = null;
  private lastSendAt = 0;
  /** 연결 전·다시 붙는 중에 모아 둔 소리 */
  private pending: { pcm: Int16Array; sample: number }[] = [];
  private pendingSamples = 0;
  /** 지금 연결로 보낸 첫 샘플의 리스너 위치(토큰 시각 → 리스너 시각) */
  private connBase: number | null = null;
  private nextSample: number | null = null;
  private finals: SonioxToken[] = [];
  private nonFinal: SonioxToken[] = [];
  private finalizeAt: number | null = null;
  private lastPartial = "";
  private lastPartialAt = 0;
  private partialTimer: ReturnType<typeof setTimeout> | null = null;
  private finished: (() => void) | null = null;
  private connStartedAt = 0;
  readonly stats = {
    connects: 0,
    connectMs: [] as number[],
    reconnects: 0,
    errors: [] as string[],
    utterances: 0,
    endpoints: 0,
    finalizes: 0,
    finLatencyMs: [] as number[],
    partials: 0,
    audioMsSent: 0,
    dropped: 0,
  };

  constructor(private opts: SonioxOptions) {}

  get live(): boolean {
    return this.state === "live";
  }

  get failed(): boolean {
    return this.state === "failed";
  }

  /** 닫히지 않은 발화에 글자가 있다(확정이든 아니든) */
  get hasPending(): boolean {
    return this.finals.length > 0 || this.nonFinal.length > 0;
  }

  /** finalize를 보냈고 아직 <fin>이 안 왔다 */
  get finalizing(): boolean {
    return this.finalizeAt !== null;
  }

  start(): void {
    if (this.state !== "idle") return;
    this.connect();
    this.keepTimer = setInterval(() => {
      if (this.state === "live" && Date.now() - this.lastSendAt >= (this.opts.keepaliveMs ?? 15_000)) this.sendJson({ type: "keepalive" });
    }, 1000);
  }

  /** 소리 한 묶음(리스너 샘플 위치 sample부터). 연결 전이면 모아 둔다 */
  push(pcm: Int16Array, sample: number): void {
    if (!pcm.length || this.state === "failed" || this.state === "closed" || this.state === "closing") return;
    if (this.state === "live" && this.ws) {
      this.sendAudio(pcm, sample);
      return;
    }
    this.pending.push({ pcm, sample });
    this.pendingSamples += pcm.length;
    const max = Math.round(((this.opts.bufferMs ?? 10_000) * RATE) / 1000);
    while (this.pendingSamples > max && this.pending.length > 1) {
      const drop = this.pending.shift()!;
      this.pendingSamples -= drop.pcm.length;
      this.stats.dropped += drop.pcm.length;
    }
  }

  /** 지금까지 들어온 소리를 확정해 달라고 한다(<fin>에서 발화가 닫힌다). 보냈으면 true */
  finalize(): boolean {
    if (this.state !== "live" || this.finalizeAt !== null || !this.hasPending) return false;
    if (!this.sendJson({ type: "finalize" })) return false;
    this.finalizeAt = Date.now();
    this.stats.finalizes++;
    // 발화 끝을 정했으니 이 발화의 partial은 더 보내지 않는다(예약된 것도 버린다)
    if (this.partialTimer) clearTimeout(this.partialTimer);
    this.partialTimer = null;
    return true;
  }

  /** 스트림을 끝낸다: 빈 텍스트 프레임 → {finished:true}(최대 waitMs) → 남은 확정 글자를 발화로 내보낸다 */
  async close(waitMs = 2000): Promise<void> {
    if (this.state === "closed" || this.state === "failed") return;
    const wasLive = this.state === "live";
    this.state = "closing";
    this.clearTimers();
    if (wasLive && this.ws) {
      const done = new Promise<void>((r) => (this.finished = r));
      try {
        this.ws.send("");
        await Promise.race([done, Bun.sleep(waitMs)]);
      } catch {
        /* 이미 닫힘 */
      }
    }
    this.closeUtterance("close");
    this.state = "closed";
    try {
      this.ws?.close();
    } catch {}
    this.ws = null;
  }

  // ------------------------------------------------------------------ 연결

  private connect(): void {
    this.state = this.everLive ? "reconnecting" : "connecting";
    this.connStartedAt = Date.now();
    this.connBase = null;
    let ws: WebSocket;
    try {
      // Bun: 생성자 두 번째 인자로 헤더를 줄 수 있다(키는 여기서만 쓰인다)
      ws = new WebSocket(this.opts.url ?? SONIOX_URL, { headers: { Authorization: `Bearer ${this.opts.apiKey}` } } as unknown as string[]);
    } catch {
      this.lost("ws_create_failed");
      return;
    }
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    this.connectTimer = setTimeout(() => {
      if (this.ws !== ws || this.state === "live") return;
      try {
        ws.close();
      } catch {}
      this.lost("connect_timeout");
    }, this.opts.connectTimeoutMs ?? 5000);
    ws.onopen = () => {
      if (this.ws !== ws) return;
      if (this.connectTimer) clearTimeout(this.connectTimer);
      this.connectTimer = null;
      const config = {
        model: this.opts.model ?? "stt-rt-v6",
        audio_format: "pcm_s16le",
        sample_rate: RATE,
        num_channels: 1,
        language_hints: ["ko"],
        language_hints_strict: true,
        context: {
          general: [{ key: "domain", value: "회의" }],
          ...(this.opts.contextText ? { text: this.opts.contextText } : {}),
          ...(this.opts.terms?.length ? { terms: this.opts.terms } : {}),
        },
        ...(this.opts.endpointDetection === false
          ? { enable_endpoint_detection: false }
          : { enable_endpoint_detection: true, endpoint_latency_adjustment_level: 2, endpoint_sensitivity: 0.3, max_endpoint_delay_ms: 500 }),
      };
      ws.send(JSON.stringify(config));
      const ms = Date.now() - this.connStartedAt;
      this.stats.connects++;
      this.stats.connectMs.push(ms);
      if (this.everLive) this.stats.reconnects++;
      this.everLive = true;
      this.attempt = 0;
      this.state = "live";
      log(`soniox connected in ${ms}ms${this.stats.connects > 1 ? ` (reconnect ${this.stats.connects - 1})` : ""}`);
      const buf = this.pending;
      this.pending = [];
      this.pendingSamples = 0;
      for (const b of buf) this.sendAudio(b.pcm, b.sample);
    };
    ws.onmessage = (ev) => {
      if (this.ws !== ws || typeof ev.data !== "string") return;
      let msg: { tokens?: SonioxToken[]; finished?: boolean; error_code?: number; error_message?: string };
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.error_code !== undefined) {
        this.onError(Number(msg.error_code));
        return;
      }
      if (Array.isArray(msg.tokens)) this.onTokens(msg.tokens);
      if (msg.finished) {
        this.closeUtterance("close");
        this.finished?.();
        this.finished = null;
      }
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.state === "closing" || this.state === "closed" || this.state === "failed") {
        this.finished?.();
        this.finished = null;
        return;
      }
      this.lost("closed");
    };
    ws.onerror = () => {
      /* onclose가 뒤따른다 */
    };
  }

  private onError(code: number): void {
    this.stats.errors.push(String(code));
    log(`soniox error code=${code}`);
    if (FATAL_CODES.has(code)) {
      this.fail(`soniox_${code}`);
      return;
    }
    // 408·413(스트림 300분 한도)·429·500·503 등: 서버가 닫는다 → 다시 붙는다
    const ws = this.ws;
    this.ws = null;
    try {
      ws?.close();
    } catch {}
    this.lost(`soniox_${code}`, code === 413 ? 0 : undefined);
  }

  /** 연결을 잃음: 열려 있던 발화의 확정 글자를 내보내고, 다시 붙거나(백오프) 치명 실패로 */
  private lost(reason: string, delayMs?: number): void {
    if (this.state === "failed" || this.state === "closed" || this.state === "closing") return;
    if (this.connectTimer) clearTimeout(this.connectTimer);
    this.connectTimer = null;
    this.closeUtterance("close");
    this.finalizeAt = null;
    if (!this.everLive) {
      this.fail(reason === "closed" ? "connect_failed" : reason);
      return;
    }
    const backoff = this.opts.backoffMs ?? [500, 1000, 2000, 4000, 8000];
    if (this.attempt >= backoff.length) {
      this.fail("reconnect_failed");
      return;
    }
    const wait = delayMs ?? backoff[this.attempt]!;
    this.attempt++;
    this.state = "reconnecting";
    log(`soniox lost (${reason}); reconnect ${this.attempt}/${backoff.length} in ${wait}ms`);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.state === "reconnecting") this.connect();
    }, wait);
  }

  private fail(reason: string): void {
    if (this.state === "failed") return;
    this.state = "failed";
    this.clearTimers();
    this.closeUtterance("close");
    this.pending = [];
    this.pendingSamples = 0;
    const ws = this.ws;
    this.ws = null;
    try {
      ws?.close();
    } catch {}
    log(`soniox fatal (${reason})`);
    this.opts.onFatal(reason);
  }

  private clearTimers(): void {
    for (const t of [this.connectTimer, this.retryTimer, this.partialTimer]) if (t) clearTimeout(t);
    if (this.keepTimer) clearInterval(this.keepTimer);
    this.connectTimer = this.retryTimer = this.partialTimer = null;
    this.keepTimer = null;
  }

  private sendJson(obj: unknown): boolean {
    if (!this.ws || this.state !== "live") return false;
    try {
      this.ws.send(JSON.stringify(obj));
      this.lastSendAt = Date.now();
      return true;
    } catch {
      return false;
    }
  }

  private sendAudio(pcm: Int16Array, sample: number): void {
    if (!this.ws) return;
    // 이어지지 않은 소리(앞에서 버렸거나 캡처가 끊김)는 토큰 시각이 어긋나지 않게 무음으로 메운다(최대 2초)
    if (this.connBase === null) this.connBase = sample;
    else if (this.nextSample !== null && sample > this.nextSample) {
      const gap = sample - this.nextSample;
      if (gap <= RATE * 2) this.sendRaw(new Int16Array(gap));
      else this.connBase += gap; // 너무 길면 기준만 옮긴다
    }
    this.sendRaw(pcm);
    this.nextSample = sample + pcm.length;
  }

  private sendRaw(pcm: Int16Array): void {
    try {
      this.ws!.send(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength));
      this.lastSendAt = Date.now();
      this.stats.audioMsSent += Math.round((pcm.length * 1000) / RATE);
    } catch {
      /* onclose가 처리 */
    }
  }

  // ------------------------------------------------------------------ 토큰 → 발화

  private onTokens(tokens: SonioxToken[]): void {
    const nonFinal: SonioxToken[] = [];
    for (const t of tokens) {
      if (typeof t.text !== "string") continue;
      if (t.is_final) {
        if (t.text === "<end>" || t.text === "<fin>") {
          this.nonFinal = [];
          nonFinal.length = 0;
          this.closeUtterance(t.text === "<end>" ? "end" : "fin");
          continue;
        }
        this.finals.push(t);
      } else if (t.text !== "<end>" && t.text !== "<fin>") nonFinal.push(t);
    }
    this.nonFinal = nonFinal;
    this.updatePartial();
  }

  private currentText(): string {
    let s = "";
    for (const t of this.finals) s += t.text;
    for (const t of this.nonFinal) s += t.text;
    return s.trim();
  }

  private updatePartial(): void {
    const on = this.opts.onPartial;
    if (!on || this.finalizeAt !== null) return; // finalize 뒤 <fin>까지는 끝난 발화
    const text = this.currentText();
    if (!text || text === this.lastPartial) return;
    const gap = this.opts.partialIntervalMs ?? 200;
    const now = Date.now();
    if (now - this.lastPartialAt >= gap && !this.partialTimer) {
      this.emitPartial(text);
      return;
    }
    if (this.partialTimer) return; // 예약된 것이 그때의 최신 글자를 보낸다
    this.partialTimer = setTimeout(() => {
      this.partialTimer = null;
      const latest = this.currentText();
      if (latest && latest !== this.lastPartial) this.emitPartial(latest);
    }, Math.max(0, gap - (now - this.lastPartialAt)));
  }

  private emitPartial(text: string): void {
    this.lastPartial = text;
    this.lastPartialAt = Date.now();
    this.stats.partials++;
    this.opts.onPartial?.(text);
  }

  private closeUtterance(reason: "end" | "fin" | "close"): void {
    // 이 발화의 partial이 더 나가지 않게: 예약된 partial은 버린다(발화 partial → 그 발화 transcript 순서)
    if (this.partialTimer) clearTimeout(this.partialTimer);
    this.partialTimer = null;
    this.lastPartial = "";
    const finals = this.finals;
    this.finals = [];
    this.nonFinal = []; // 닫힌 발화의 미확정 글자는 다음 발화로 넘기지 않는다(새 연결은 다시 보내 주지 않는다)
    let finLatencyMs: number | undefined;
    if (reason === "fin" && this.finalizeAt !== null) {
      finLatencyMs = Date.now() - this.finalizeAt;
      this.stats.finLatencyMs.push(finLatencyMs);
    }
    if (reason === "fin") this.finalizeAt = null;
    if (reason === "end") this.stats.endpoints++;
    let text = "";
    for (const t of finals) text += t.text;
    text = text.trim();
    if (!text) {
      this.opts.onClosed?.(reason, false);
      return;
    }
    const base = this.connBase ?? 0;
    const first = finals.find((t) => typeof t.start_ms === "number");
    const last = [...finals].reverse().find((t) => typeof t.end_ms === "number");
    const startSample = base + Math.round(((first?.start_ms ?? 0) * RATE) / 1000);
    const endSample = base + Math.round(((last?.end_ms ?? first?.start_ms ?? 0) * RATE) / 1000);
    this.stats.utterances++;
    this.opts.onUtterance({ text, startSample, endSample, tokens: finals.length, reason, ...(finLatencyMs !== undefined ? { finLatencyMs } : {}) });
    this.opts.onClosed?.(reason, true);
  }
}
