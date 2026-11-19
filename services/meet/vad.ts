// 에너지 기반 VAD. 16 kHz mono s16을 20 ms 프레임으로 보고 말 구간을 자른다.
// 계약 §2: 말 끝 침묵 700 ms, 최소 0.4초, 최대 15초.
import { concatInt16 } from "./audio";

export interface VadOptions {
  sampleRate: number;
  frameMs: number;
  /** 이만큼 조용하면 말이 끝났다고 본다 */
  hangoverMs: number;
  /** 첫 큰 프레임부터 마지막 큰 프레임까지 이보다 짧으면 버린다 */
  minSpeechMs: number;
  /** 한 구간 최대 길이. 넘으면 끊어서 내보내고 이어서 잰다 */
  maxSegmentMs: number;
  /** 말 시작 앞에 붙이는 여유 */
  preRollMs: number;
  /** 마지막 큰 프레임 뒤에 남기는 여유 */
  postRollMs: number;
  /** 고정 문턱(dBFS). 실제 문턱은 max(이 값, 잡음 바닥 + floorMarginDb) */
  thresholdDb: number;
  floorMarginDb: number;
  /** 말 시작으로 보려면 연속으로 큰 프레임이 이만큼 */
  startFrames: number;
  /** 잡음 바닥 = 최근 이 시간 동안 가장 조용한 프레임(말 사이 틈이 잡혀 바닥이 낮게 유지된다) */
  floorWindowMs: number;
}

export const DEFAULT_VAD: VadOptions = {
  sampleRate: 16000,
  frameMs: 20,
  hangoverMs: 700,
  minSpeechMs: 400,
  maxSegmentMs: 15000,
  preRollMs: 200,
  postRollMs: 300,
  thresholdDb: -45,
  floorMarginDb: 10,
  startFrames: 2,
  floorWindowMs: 4000,
};

export interface VadSegment {
  pcm: Int16Array;
  /** 스트림 시작부터의 샘플 위치 */
  startSample: number;
  endSample: number;
  /** 첫 큰 프레임 ~ 마지막 큰 프레임 길이 */
  speechMs: number;
  /** maxSegmentMs로 잘린 구간이면 true */
  cut: boolean;
}

export class EnergyVad {
  readonly opt: VadOptions;
  private frameLen: number;
  private pending: Int16Array = new Int16Array(0);
  private sample = 0; // 다음 프레임의 시작 샘플 위치
  private recent: Float32Array;
  private recentIdx = 0;
  private recentFill = 0;
  private floorDb = -100;
  private loudRun = 0;
  private preRoll: { pcm: Int16Array; start: number }[] = [];
  private inSpeech = false;
  private seg: Int16Array[] = [];
  private segStart = 0;
  private firstLoud = 0; // 샘플 위치
  private lastLoudEnd = 0;
  private silenceMs = 0;

  constructor(opt: Partial<VadOptions> = {}) {
    this.opt = { ...DEFAULT_VAD, ...opt };
    this.frameLen = Math.round((this.opt.sampleRate * this.opt.frameMs) / 1000);
    this.recent = new Float32Array(Math.max(1, Math.round(this.opt.floorWindowMs / this.opt.frameMs)));
  }

  get speaking(): boolean {
    return this.inSpeech;
  }

  /** 현재 문턱(dBFS) */
  get thresholdDb(): number {
    return Math.max(this.opt.thresholdDb, this.floorDb + this.opt.floorMarginDb);
  }

  push(pcm: Int16Array): VadSegment[] {
    const out: VadSegment[] = [];
    let buf = this.pending.length ? concatInt16([this.pending, pcm]) : pcm;
    let off = 0;
    while (buf.length - off >= this.frameLen) {
      const frame = buf.slice(off, off + this.frameLen);
      off += this.frameLen;
      const s = this.frame(frame);
      if (s) out.push(s);
    }
    this.pending = buf.slice(off);
    buf = new Int16Array(0);
    return out;
  }

  /** 스트림 끝: 진행 중인 구간을 닫는다. */
  flush(): VadSegment[] {
    if (!this.inSpeech) return [];
    const s = this.close(false);
    return s ? [s] : [];
  }

  private frameDb(f: Int16Array): number {
    let sum = 0;
    for (let i = 0; i < f.length; i++) {
      const v = f[i]! / 32768;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / f.length);
    return rms <= 1e-5 ? -100 : 20 * Math.log10(rms);
  }

  private frame(f: Int16Array): VadSegment | null {
    const { frameMs, hangoverMs, maxSegmentMs, sampleRate, preRollMs } = this.opt;
    const start = this.sample;
    this.sample += f.length;
    const db = this.frameDb(f);
    const loud = db >= this.thresholdDb;
    this.trackFloor(db);

    if (!this.inSpeech) {
      this.preRoll.push({ pcm: f, start });
      const keep = Math.max(1, Math.ceil(preRollMs / frameMs)) + this.opt.startFrames;
      while (this.preRoll.length > keep) this.preRoll.shift();
      if (loud) {
        this.loudRun++;
        if (this.loudRun >= this.opt.startFrames) {
          this.inSpeech = true;
          this.seg = this.preRoll.map((p) => p.pcm);
          this.segStart = this.preRoll[0]!.start;
          this.firstLoud = start - (this.loudRun - 1) * f.length;
          this.lastLoudEnd = start + f.length;
          this.silenceMs = 0;
          this.preRoll = [];
          this.loudRun = 0;
        }
      } else {
        this.loudRun = 0;
      }
      return null;
    }

    this.seg.push(f);
    if (loud) {
      this.silenceMs = 0;
      this.lastLoudEnd = start + f.length;
    } else {
      this.silenceMs += frameMs;
    }
    const segMs = ((this.sample - this.segStart) * 1000) / sampleRate;
    if (this.silenceMs >= hangoverMs) return this.close(false);
    if (segMs >= maxSegmentMs) return this.close(true);
    return null;
  }

  /** 최근 floorWindowMs 동안의 최솟값. 창이 다 차기 전에는 고정 문턱만 쓴다(-100). */
  private trackFloor(db: number): void {
    this.recent[this.recentIdx] = db;
    this.recentIdx = (this.recentIdx + 1) % this.recent.length;
    if (this.recentFill < this.recent.length) {
      this.recentFill++;
      if (this.recentFill < this.recent.length) return;
    }
    let min = 0;
    for (let i = 0; i < this.recent.length; i++) if (this.recent[i]! < min) min = this.recent[i]!;
    this.floorDb = min;
  }

  private close(cut: boolean): VadSegment | null {
    const { sampleRate, postRollMs, minSpeechMs } = this.opt;
    const all = concatInt16(this.seg);
    const segEndAll = this.segStart + all.length;
    const endSample = cut ? segEndAll : Math.min(segEndAll, this.lastLoudEnd + Math.round((postRollMs * sampleRate) / 1000));
    const pcm = all.slice(0, endSample - this.segStart);
    const speechMs = ((this.lastLoudEnd - this.firstLoud) * 1000) / sampleRate;
    const startSample = this.segStart;
    this.seg = [];
    if (cut) {
      // 계속 말하는 중: 다음 구간을 바로 이어서 연다(앞 여유 없음).
      this.segStart = segEndAll;
      this.firstLoud = segEndAll;
      this.lastLoudEnd = segEndAll;
      this.silenceMs = 0;
    } else {
      this.inSpeech = false;
      this.silenceMs = 0;
      this.loudRun = 0;
    }
    if (speechMs < minSpeechMs) return null;
    return { pcm, startSample, endSample, speechMs, cut };
  }
}
