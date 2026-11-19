/**
 * Browser audio for the call (lazy chunk with the call) — no dependencies, every API feature-detected.
 *   createMic(onLevel, ctx?)  getUserMedia + AnalyserNode → RMS level 0..1 at ~30 Hz with 0.1 s smoothing (real values
 *                          only); pass the call's AudioContext (made inside the gesture) so iOS doesn't leave it suspended
 *   speak(text)            speechSynthesis with a ko-KR voice; resolves when finished (or at once if unavailable)
 * Recognition lives in recognizer.ts (re-exported here).
 */
import { speechSupport } from "./recognizer";

export { createRecognizer, speechSupport, type Recognizer, type RecognizerHandlers } from "./recognizer";

export interface Mic {
  setMuted(on: boolean): void;
  stop(): void;
}

export async function createMic(onLevel: (v: number) => void, shared?: AudioContext | null): Promise<Mic> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  const Ctx = (window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext)!;
  const own = !shared || shared.state === "closed";
  const ctx = own ? new Ctx() : shared;
  const src = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  src.connect(analyser);
  const buf = new Float32Array(analyser.fftSize);
  let smooth = 0;
  let muted = false;
  // 30 Hz is plenty for a level meter; an interval (not rAF) so nothing runs per frame
  const timer = setInterval(() => {
    if (muted) {
      if (smooth !== 0) onLevel((smooth = 0));
      return;
    }
    analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i]! * buf[i]!;
    const rms = Math.sqrt(sum / buf.length);
    // speech sits around 0.02–0.2 RMS; map to 0..1 with a soft knee and a noise floor
    const v = Math.max(0, Math.min(1, (rms - 0.008) * 7));
    smooth = smooth + (v - smooth) * 0.28; // ≈ 0.1 s time constant at 30 Hz
    onLevel(smooth < 0.02 ? 0 : smooth);
  }, 33);
  return {
    setMuted(on) {
      muted = on;
      for (const t of stream.getAudioTracks()) t.enabled = !on;
    },
    stop() {
      clearInterval(timer);
      onLevel(0);
      for (const t of stream.getTracks()) t.stop();
      src.disconnect();
      if (own) void ctx.close().catch(() => {});
    },
  };
}

let koVoice: SpeechSynthesisVoice | null | undefined;
function pickVoice(): SpeechSynthesisVoice | null {
  if (koVoice !== undefined && koVoice !== null) return koVoice;
  const voices = window.speechSynthesis.getVoices();
  koVoice = voices.find((v) => v.lang === "ko-KR" && /yuna|sora|heami|google/i.test(v.name)) ?? voices.find((v) => v.lang?.startsWith("ko")) ?? null;
  return koVoice;
}

/** Speak Korean text; resolves when done, cancelled, or immediately when TTS is unavailable. */
export function speak(text: string): Promise<void> {
  if (!speechSupport().tts || !text.trim()) return Promise.resolve();
  return new Promise((resolve) => {
    const u = new SpeechSynthesisUtterance(text.slice(0, 600));
    u.lang = "ko-KR";
    const v = pickVoice();
    if (v) u.voice = v;
    u.rate = 1.04;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(guard);
      resolve();
    };
    u.onend = finish;
    u.onerror = finish;
    // some engines never fire onend: cap at a generous reading time
    const guard = setTimeout(finish, Math.min(60_000, 2_000 + text.length * 140));
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(u);
  });
}

export function stopSpeaking() {
  if (speechSupport().tts) window.speechSynthesis.cancel();
}
