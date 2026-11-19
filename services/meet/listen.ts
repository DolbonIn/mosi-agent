// 듣기: 페이지에서 받은 16 kHz PCM → transcript 이벤트. 두 가지 길:
//  - soniox: 소리를 Soniox 실시간 STT로 계속 흘려 보내고, 확정 토큰으로 발화를 만든다. 에너지 VAD로 말이 멈춘 지
//    MEET_FINALIZE_SILENCE_MS(기본 300 ms)가 되면 finalize를 보내 발화를 빨리 닫는다. 미확정 글자는 partial로 알린다.
//  - local: 에너지 VAD로 자른 구간을 services/stt(:8782)에 보낸다. Soniox가 치명적으로 실패하면 자동으로 이 길로 넘어간다.
import { base64ToInt16, rmsDb } from "./audio";
import { log } from "./log";
import { SonioxStream, type SonioxOptions, type SonioxUtterance } from "./soniox";
import { transcribe } from "./stt";
import { EnergyVad, type VadOptions, type VadSegment } from "./vad";

const RATE = 16000;

export interface TranscriptEvent {
  seq: number;
  text: string;
  startMs: number;
  endMs: number;
  speaker: string | null;
}

export interface ListenerOptions {
  sttUrl: string;
  onTranscript: (ev: TranscriptEvent) => void;
  /** 말하는 중일 때 주기적으로 불러 화면에 표시된 말하는 사람 이름을 모은다(없으면 null) */
  speakerProbe?: () => Promise<string | null>;
  /** 원격에서 말소리가 감지될 때마다(혼자 남음 판정 초기화용) */
  onSpeech?: () => void;
  vad?: Partial<VadOptions>;
  /** STT 함수 바꿔 끼우기(테스트) */
  stt?: (pcm: Int16Array) => Promise<{ text: string; ms: number; noSpeech: boolean }>;
  /** services/stt initial prompt(`?prompt=`). undefined면 붙이지 않는다. 로그에 남기지 않는다 */
  sttPrompt?: string;
  /** 있으면 Soniox 실시간 STT를 쓴다(start()에서 연결) */
  soniox?: Omit<SonioxOptions, "onUtterance" | "onPartial" | "onFatal">;
  /** 말이 이만큼 멈추면 Soniox에 finalize */
  finalizeSilenceMs?: number;
  /** 지금 발화의 확정+미확정 전체 글자(Soniox만) */
  onPartial?: (text: string) => void;
  /** 발화 끝을 정한 순간: Soniox는 finalize를 보낼 때, local은 VAD 구간이 닫힐 때(STT 전). seq·speaker = 뒤따를 transcript의 seq·speaker */
  onEndpoint?: (seq: number, speaker: string | null) => void;
  /** Soniox → 로컬로 넘어갔을 때(이유 코드만) */
  onFallback?: (reason: string) => void;
}

export class Listener {
  readonly vad: EnergyVad;
  private baseEpoch: number | null = null;
  private samples = 0;
  private seq = 0;
  private chain: Promise<void> = Promise.resolve();
  private tally = new Map<string, number>();
  private lastProbe = 0;
  /** takeSpeaker 때마다 늘어난다: 그 전에 시작해 늦게 끝난 조사는 다음 발화 몫으로 세지 않는다 */
  private tallyGen = 0;
  private loudWaiters: ((epochMs: number) => void)[] = [];
  private closed = false;
  /** 마지막으로 문턱을 넘은 소리의 시각(epoch ms). 측정용 */
  lastLoudEpoch: number | null = null;
  private lastLoudSample = -1;
  /** Soniox 발화에 글자가 처음 생긴 샘플 위치(너무 길면 강제로 닫는다) */
  private openSince: number | null = null;
  /** finalize 때 미리 정한 다음 transcript의 seq */
  private reservedSeq: number | null = null;
  /** finalize 때 정한 그 발화의 말한 사람(endpoint와 transcript가 같은 값을 쓴다) */
  private reservedSpeaker: string | null = null;
  private soniox: SonioxStream | null = null;
  private engine: "soniox" | "local";
  readonly stats = { chunks: 0, segments: 0, sttCalls: 0, sttMs: [] as number[], sttRoundTripMs: [] as number[], dropped: 0, empty: 0, fallback: null as string | null };

  constructor(private opts: ListenerOptions) {
    this.vad = new EnergyVad(opts.vad);
    this.engine = opts.soniox ? "soniox" : "local";
  }

  /** 지금 받아 적는 길 */
  get sttEngine(): "soniox" | "local" {
    return this.engine;
  }

  get sonioxStats(): SonioxStream["stats"] | null {
    return this.soniox?.stats ?? null;
  }

  /** 회의에 들어간 순간: Soniox면 연결을 연다(그 전에 들어온 소리는 모아 뒀다 보낸다) */
  start(): void {
    if (this.engine !== "soniox" || this.soniox || this.closed) return;
    this.soniox = new SonioxStream({
      ...this.opts.soniox!,
      onUtterance: (u) => this.onUtterance(u),
      ...(this.opts.onPartial ? { onPartial: (t: string) => !this.closed && this.opts.onPartial!(t) } : {}),
      // 글자 없이 닫힌 발화: 정해 둔 seq는 버린다(그 endpoint 뒤에는 transcript가 없다)
      onClosed: () => {
        this.reservedSeq = null;
        this.reservedSpeaker = null;
      },
      onFatal: (reason) => this.fallback(reason),
    });
    this.soniox.start();
  }

  private fallback(reason: string): void {
    if (this.engine !== "soniox") return;
    this.engine = "local";
    this.stats.fallback = reason;
    log(`stt fallback to local (${reason})`);
    this.opts.onFallback?.(reason);
  }

  private onUtterance(u: SonioxUtterance): void {
    if (this.closed && u.reason !== "close") return;
    this.stats.segments++;
    // finalize로 닫혔으면 endpoint 때 정한 seq. 아니면(연결 끊김, 자동 끝점) 지금 endpoint를 먼저 보낸다
    let seq = this.reservedSeq;
    let speaker = this.reservedSpeaker;
    this.reservedSeq = null;
    this.reservedSpeaker = null;
    if (seq === null) {
      seq = ++this.seq;
      speaker = this.takeSpeaker();
      if (!this.closed) this.opts.onEndpoint?.(seq, speaker);
    }
    const ev: TranscriptEvent = { seq, text: u.text, startMs: this.epochAt(u.startSample), endMs: this.epochAt(u.endSample), speaker };
    log(`transcript seq=${ev.seq} audio=${Math.round(ev.endMs - ev.startMs)}ms via soniox ${u.reason}${u.finLatencyMs !== undefined ? ` fin=${u.finLatencyMs}ms` : ""} tokens=${u.tokens} chars=${u.text.length}`);
    this.opts.onTranscript(ev);
  }

  /** 다음 번 큰 소리(문턱 이상)가 들어온 시각(epoch ms)을 알려 준다. 측정용. */
  nextLoud(timeoutMs: number): Promise<number | null> {
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        const i = this.loudWaiters.indexOf(fn);
        if (i >= 0) this.loudWaiters.splice(i, 1);
        resolve(null);
      }, timeoutMs);
      const fn = (ms: number) => {
        clearTimeout(t);
        resolve(ms);
      };
      this.loudWaiters.push(fn);
    });
  }

  /** exposeBinding으로 들어온 묶음 하나 */
  onPcm(b64: string, pageEpochMs: number): void {
    if (this.closed) return;
    const pcm = base64ToInt16(b64);
    if (!pcm.length) return;
    this.stats.chunks++;
    const chunkMs = (pcm.length * 1000) / RATE;
    const endEpoch = Number.isFinite(pageEpochMs) ? pageEpochMs : Date.now();
    if (this.baseEpoch === null) this.baseEpoch = endEpoch - chunkMs;
    const expectedEnd = this.baseEpoch + ((this.samples + pcm.length) * 1000) / RATE;
    if (Math.abs(expectedEnd - endEpoch) > 1000) this.baseEpoch = endEpoch - ((this.samples + pcm.length) * 1000) / RATE; // 캡처가 멈췄다 이어진 경우 시계 다시 맞춤
    const chunkStartSample = this.samples;
    this.samples += pcm.length;

    // 측정용: 이 묶음에서 문턱을 넘은 첫·마지막 10 ms 위치
    const thr = this.vad.thresholdDb;
    const step = RATE / 100;
    let firstLoud = -1;
    let lastLoud = -1;
    for (let i = 0; i + step <= pcm.length; i += step) {
      if (rmsDb(pcm, i, i + step) >= thr) {
        if (firstLoud < 0) firstLoud = i;
        lastLoud = i + step;
      }
    }
    if (lastLoud >= 0) {
      this.lastLoudEpoch = this.epochAt(chunkStartSample + lastLoud);
      this.lastLoudSample = chunkStartSample + lastLoud;
    }
    if (firstLoud >= 0 && this.loudWaiters.length) {
      const at = this.epochAt(chunkStartSample + firstLoud);
      const ws = this.loudWaiters;
      this.loudWaiters = [];
      for (const w of ws) w(at);
    }

    const segs = this.vad.push(pcm);
    const silentMs = this.lastLoudSample < 0 ? Infinity : ((this.samples - this.lastLoudSample) * 1000) / RATE;
    const sonioxOn = this.engine === "soniox" && this.soniox !== null;
    if (this.vad.speaking) {
      this.opts.onSpeech?.();
      // soniox는 finalize로 발화를 닫은 뒤에도 VAD hangover(700ms) 동안 speaking이다: 그때 물으면 앞 사람이 다음 발화 몫으로 세어지므로
      // 실제 소리가 난 동안(finalize 문턱 전)만 묻는다
      if (!sonioxOn || silentMs < (this.opts.finalizeSilenceMs ?? 300)) this.maybeProbeSpeaker();
    }
    if (sonioxOn && this.soniox) {
      this.soniox.push(pcm, chunkStartSample);
      // 말이 멈춘 지 finalizeSilenceMs: 미확정 글자가 남아 있으면 지금 확정해 달라고 한다(<end>를 기다리면 1.5초 넘게 걸린다)
      if (!this.soniox.hasPending) this.openSince = null;
      else this.openSince ??= this.samples;
      // 잡음이 계속돼 침묵이 안 잡혀도 한 발화는 최대 maxSegmentMs(15초)에서 닫는다
      const tooLong = this.openSince !== null && ((this.samples - this.openSince) * 1000) / RATE >= this.vad.opt.maxSegmentMs;
      if ((silentMs >= (this.opts.finalizeSilenceMs ?? 300) || tooLong) && this.soniox.hasPending && !this.soniox.finalizing && this.soniox.finalize()) {
        this.openSince = null;
        this.reservedSeq = ++this.seq;
        this.reservedSpeaker = this.takeSpeaker();
        this.opts.onEndpoint?.(this.reservedSeq, this.reservedSpeaker);
      }
      for (const _ of segs) this.opts.onSpeech?.();
      return;
    }
    for (const s of segs) this.enqueue(s);
  }

  private epochAt(sample: number): number {
    return Math.round((this.baseEpoch ?? Date.now()) + (sample * 1000) / RATE);
  }

  private maybeProbeSpeaker(): void {
    const probe = this.opts.speakerProbe;
    if (!probe) return;
    const now = Date.now();
    if (now - this.lastProbe < 400) return;
    this.lastProbe = now;
    const gen = this.tallyGen;
    probe()
      .then((name) => {
        if (name && gen === this.tallyGen) this.tally.set(name, (this.tally.get(name) ?? 0) + 1);
      })
      .catch(() => {});
  }

  private takeSpeaker(): string | null {
    let best: string | null = null;
    let n = 0;
    for (const [k, v] of this.tally) if (v > n) [best, n] = [k, v];
    this.tally.clear();
    this.tallyGen++;
    this.lastProbe = 0; // 다음 발화는 시작하자마자 한 번 묻는다(400ms 간격 제한이 앞 발화에서 이어지지 않게)
    return best;
  }

  private enqueue(seg: VadSegment): void {
    this.stats.segments++;
    this.opts.onSpeech?.();
    const startMs = this.epochAt(seg.startSample);
    const endMs = this.epochAt(seg.endSample);
    const speaker = this.takeSpeaker();
    const closedAt = Date.now();
    // local 길의 endpoint: 구간이 닫힌 지금(STT 전) seq를 정한다. STT가 빈 글자면 이 seq의 transcript는 없다
    const seq = ++this.seq;
    if (!this.closed) this.opts.onEndpoint?.(seq, speaker);
    this.chain = this.chain.then(async () => {
      if (this.closed) return;
      const stt = this.opts.stt ?? ((pcm: Int16Array) => transcribe(this.opts.sttUrl, pcm, this.opts.sttPrompt !== undefined ? { prompt: this.opts.sttPrompt } : {}));
      const t0 = Date.now();
      try {
        this.stats.sttCalls++;
        const r = await stt(seg.pcm);
        const rt = Date.now() - t0;
        this.stats.sttMs.push(r.ms || rt);
        this.stats.sttRoundTripMs.push(rt);
        if (this.closed) return;
        if (r.noSpeech || !r.text) {
          this.stats.empty++;
          return;
        }
        const ev: TranscriptEvent = { seq, text: r.text, startMs, endMs, speaker };
        log(`transcript seq=${ev.seq} audio=${Math.round(endMs - startMs)}ms stt=${rt}ms wait=${t0 - closedAt}ms chars=${r.text.length}`);
        this.opts.onTranscript(ev);
      } catch (e) {
        this.stats.dropped++;
        log(`stt failed audio=${Math.round(endMs - startMs)}ms err=${(e as Error).message ?? "error"}`);
      }
    });
  }

  /** 남은 구간을 닫고 STT까지 끝나기를 기다린다. Soniox면 스트림을 끝내고 남은 확정 글자를 받는다. */
  async flush(): Promise<void> {
    if (this.engine === "soniox" && this.soniox) {
      this.vad.flush();
      await this.soniox.close();
      return;
    }
    for (const s of this.vad.flush()) this.enqueue(s);
    await this.chain;
  }

  close(): void {
    this.closed = true;
    void this.soniox?.close(500);
    for (const w of this.loudWaiters) w(Number.NaN);
    this.loudWaiters = [];
  }
}
