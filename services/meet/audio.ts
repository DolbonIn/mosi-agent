// PCM 도우미: s16le ↔ base64, RMS, WAV 파싱.

export function int16ToBase64(pcm: Int16Array): string {
  return Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString("base64");
}

export function base64ToInt16(b64: string): Int16Array {
  const buf = Buffer.from(b64, "base64");
  const out = new Int16Array(buf.byteLength >> 1);
  for (let i = 0; i < out.length; i++) out[i] = buf.readInt16LE(i * 2);
  return out;
}

/** 바이트 배열(s16le) → Int16Array. 홀수 바이트는 버린다. */
export function bytesToInt16(bytes: Uint8Array): Int16Array {
  const n = bytes.byteLength >> 1;
  const out = new Int16Array(n);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, n * 2);
  for (let i = 0; i < n; i++) out[i] = dv.getInt16(i * 2, true);
  return out;
}

export function int16ToBytes(pcm: Int16Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(pcm.length * 2);
  const dv = new DataView(out.buffer);
  for (let i = 0; i < pcm.length; i++) dv.setInt16(i * 2, pcm[i]!, true);
  return out;
}

/** 전체 RMS를 dBFS로. 무음은 -100. */
export function rmsDb(pcm: Int16Array, start = 0, end = pcm.length): number {
  const n = end - start;
  if (n <= 0) return -100;
  let sum = 0;
  for (let i = start; i < end; i++) {
    const v = pcm[i]! / 32768;
    sum += v * v;
  }
  const rms = Math.sqrt(sum / n);
  return rms <= 1e-5 ? -100 : 20 * Math.log10(rms);
}

export function concatInt16(parts: Int16Array[]): Int16Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Int16Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export interface Wav {
  sampleRate: number;
  channels: number;
  /** 모노로 섞은 s16 */
  pcm: Int16Array;
}

/** PCM 16비트·32비트 float WAV를 읽어 모노 s16으로 돌려준다. */
export function parseWav(bytes: Uint8Array): Wav {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (o: number) => String.fromCharCode(bytes[o]!, bytes[o + 1]!, bytes[o + 2]!, bytes[o + 3]!);
  if (bytes.byteLength < 12 || tag(0) !== "RIFF" || tag(8) !== "WAVE") throw new Error("not_wav");
  let off = 12;
  let fmt: { format: number; channels: number; sampleRate: number; bits: number } | null = null;
  while (off + 8 <= bytes.byteLength) {
    const id = tag(off);
    let size = dv.getUint32(off + 4, true);
    const body = off + 8;
    if (id === "fmt ") {
      let format = dv.getUint16(body, true);
      const channels = dv.getUint16(body + 2, true);
      const sampleRate = dv.getUint32(body + 4, true);
      const bits = dv.getUint16(body + 14, true);
      if (format === 0xfffe && size >= 26) format = dv.getUint16(body + 24, true); // WAVE_FORMAT_EXTENSIBLE
      fmt = { format, channels, sampleRate, bits };
    } else if (id === "data") {
      if (!fmt) throw new Error("wav_no_fmt");
      if (size === 0xffffffff || body + size > bytes.byteLength) size = bytes.byteLength - body; // 스트리밍 WAV
      const { format, channels, bits, sampleRate } = fmt;
      const bps = bits / 8;
      const frames = Math.floor(size / (bps * channels));
      const pcm = new Int16Array(frames);
      if (format === 1 && bits === 16) {
        for (let i = 0; i < frames; i++) {
          let acc = 0;
          for (let c = 0; c < channels; c++) acc += dv.getInt16(body + (i * channels + c) * 2, true);
          pcm[i] = Math.round(acc / channels);
        }
        return { sampleRate, channels, pcm };
      }
      for (let i = 0; i < frames; i++) {
        let acc = 0;
        for (let c = 0; c < channels; c++) {
          const p = body + (i * channels + c) * bps;
          if (format === 3 && bits === 32) acc += dv.getFloat32(p, true);
          else if (format === 1 && bits === 24) acc += ((dv.getUint8(p) | (dv.getUint8(p + 1) << 8) | (dv.getInt8(p + 2) << 16)) / 8388608);
          else if (format === 1 && bits === 32) acc += dv.getInt32(p, true) / 2147483648;
          else throw new Error(`wav_unsupported_${format}_${bits}`);
        }
        const v = Math.max(-1, Math.min(1, acc / channels));
        pcm[i] = Math.round(v < 0 ? v * 32768 : v * 32767);
      }
      return { sampleRate, channels, pcm };
    }
    off = body + size + (size & 1);
  }
  throw new Error("wav_no_data");
}

/** 테스트·디버그용 모노 s16 WAV */
export function encodeWav(pcm: Int16Array, sampleRate: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(44 + pcm.length * 2);
  const dv = new DataView(out.buffer);
  const w = (o: number, s: string) => { for (let i = 0; i < 4; i++) out[o + i] = s.charCodeAt(i); };
  w(0, "RIFF"); dv.setUint32(4, 36 + pcm.length * 2, true); w(8, "WAVE");
  w(12, "fmt "); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, sampleRate, true); dv.setUint32(28, sampleRate * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  w(36, "data"); dv.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) dv.setInt16(44 + i * 2, pcm[i]!, true);
  return out;
}
