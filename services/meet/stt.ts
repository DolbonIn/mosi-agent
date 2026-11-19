// services/stt 클라이언트(계약 §1). 본문 raw s16le 16 kHz mono.
import { int16ToBytes } from "./audio";

export interface SttResult {
  text: string;
  ms: number;
  noSpeech: boolean;
}

export async function transcribe(sttUrl: string, pcm: Int16Array, opts: { lang?: string; timeoutMs?: number; retries?: number; prompt?: string } = {}): Promise<SttResult> {
  const body = int16ToBytes(pcm);
  const retries = opts.retries ?? 1;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      // prompt: 에이전트 이름을 알아듣게 하는 initial prompt. 빈 문자열이면 `?prompt=`로 STT 기본 문장을 끈다
      const q = `lang=${encodeURIComponent(opts.lang ?? "ko")}${opts.prompt !== undefined ? `&prompt=${encodeURIComponent(opts.prompt)}` : ""}`;
      const res = await fetch(`${sttUrl}/stt?${q}`, {
        method: "POST",
        headers: { "Content-Type": "audio/L16; rate=16000" },
        body,
        signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
      });
      if (res.status === 503 && attempt < retries) {
        await Bun.sleep(500);
        continue;
      }
      if (!res.ok) throw new Error(`stt_http_${res.status}`);
      const j = (await res.json()) as Partial<SttResult>;
      return { text: typeof j.text === "string" ? j.text.trim() : "", ms: Number(j.ms) || 0, noSpeech: !!j.noSpeech };
    } catch (e) {
      lastErr = e;
      if (attempt < retries) await Bun.sleep(300);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("stt_failed");
}

export async function serviceHealth(url: string, timeoutMs = 800): Promise<{ ready: boolean; queue?: number } | null> {
  try {
    const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const j = (await res.json()) as { ready?: unknown; queue?: unknown };
    return { ready: j.ready === true, queue: typeof j.queue === "number" ? j.queue : undefined };
  } catch {
    return null;
  }
}

/**
 * STT 데우기: 스왑 때문에 쉬던 whisper가 식으면 첫 구간이 10초 넘게 걸린다(2026-11-12, 5초 구간 10.3초).
 * services/stt는 무음·잡음을 모델 없이 거르므로, 높이가 오르내리는 배음 소리 1초(말소리처럼 유성음으로 보이게)를 보내 모델을 한 번 돌린다.
 * 결과 글자는 버린다.
 */
export async function warmStt(sttUrl: string, prompt?: string, timeoutMs = 60_000): Promise<{ ms: number; serverMs: number } | null> {
  const h = await serviceHealth(sttUrl, 800);
  if (!h?.ready) return null;
  const rate = 16000;
  const pcm = new Int16Array(rate);
  let phase = 0;
  for (let i = 0; i < pcm.length; i++) {
    const t = i / rate;
    const f0 = 140 + 60 * Math.sin(2 * Math.PI * 3 * t) + 40 * t; // 억양처럼 오르내림
    phase += (2 * Math.PI * f0) / rate;
    const env = Math.min(1, t / 0.05, (1 - t) / 0.05);
    let v = 0;
    for (let k = 1; k <= 6; k++) v += Math.sin(k * phase) / k;
    pcm[i] = Math.round(env * 0.12 * v * 32767);
  }
  const t0 = Date.now();
  try {
    const r = await transcribe(sttUrl, pcm, { timeoutMs, retries: 0, ...(prompt !== undefined ? { prompt } : {}) });
    return { ms: Date.now() - t0, serverMs: r.ms };
  } catch {
    return null;
  }
}
