/**
 * The call's AudioContext — tiny and loaded with the app, because it must be created/resumed synchronously inside the
 * tap that starts a call (autoplay rules, iOS Safari), before the lazy call chunk has even been asked for.
 *   unlockAudio()   create/resume it inside the gesture (+ one silent sample: iOS unlocks output only for a sound
 *                   started there); the mic's analyser shares it (an iOS context made outside a gesture stays suspended)
 *   prewarmAudio()  take Chrome's one-time audio start-up off the page's thread, and the first output start out of that tap
 *   audioGraph()    { ctx, out, analyser }: sources → out (gain) → destination, and out → analyser for the real level
 *   closeAudio()    end of the call
 */
type Ctor = typeof AudioContext;
const audioCtor = (): Ctor | null =>
  typeof window === "undefined" ? null : (window.AudioContext ?? (window as unknown as { webkitAudioContext?: Ctor }).webkitAudioContext ?? null);

let ctx: AudioContext | null = null;
let out: GainNode | null = null;
let analyser: AnalyserNode | null = null;
/**
 * Chrome's first AudioContext of a page blocks its thread for ~130–160 ms (150–550 ms in earlier measurements): the
 * page waits while the browser starts its audio output side. Later contexts cost ~1 ms, even after that one is closed.
 * The warm-up keeps that off the page's thread and out of the call tap, in two steps (measured 2026-11-18, installed
 * Chrome and Playwright WebKit):
 *   1. the device list (enumerateDevices), in an idle moment after the thread with the call button mounts: ~0.2 ms
 *      here, the start-up happens in the browser, and a context made from ~0.5 s later costs ~2 ms (still after
 *      5 minutes). It needs no gesture, asks for no permission (labels stay hidden) and holds no device.
 *   2. once the list is back and the page has had its first gesture, in the next idle moment: a throwaway context,
 *      closed at once. It costs ~2 ms now and pays the first output start, which otherwise lands in the call tap
 *      (Chrome's audio clock starts ~12 ms later there; WebKit's tap frame is ~13 ms longer).
 * Before a gesture neither engine would start a context (Chrome also warns). A call tapped before step 2 makes the
 * real context itself, and step 2 is skipped. Without mediaDevices (an insecure origin) nothing is warmed, and the
 * call tap pays the cost.
 * This replaces a throwaway context made 1.5 s after the last input with no step 1, which put a 130–160 ms long task
 * in the first reply's stream.
 */
let warm: "cold" | "listing" | "listed" | "done" = "cold";
export function prewarmAudio(): void {
  const C = audioCtor();
  const md = typeof navigator === "undefined" ? undefined : navigator.mediaDevices;
  if (warm !== "cold" || !C || typeof md?.enumerateDevices !== "function") return;
  warm = "listing";
  const idle = (f: () => void, timeout: number) => (window.requestIdleCallback ? window.requestIdleCallback(f, { timeout }) : setTimeout(f, 0));
  const gestures = ["click", "keydown", "touchend", "pointerup"] as const;
  const step2 = () =>
    idle(() => {
      if (warm !== "listed") return;
      const active = (navigator as Navigator & { userActivation?: { hasBeenActive: boolean } }).userActivation?.hasBeenActive ?? true;
      if (!active) return; // the next gesture asks again
      warm = "done";
      for (const e of gestures) window.removeEventListener(e, step2, true);
      if (ctx) return;
      try {
        void new C().close().catch(() => {});
      } catch {
        /* no audio here */
      }
    }, 3000);
  idle(() => {
    void md
      .enumerateDevices()
      .catch(() => {})
      .then(() =>
        setTimeout(() => {
          warm = "listed";
          for (const e of gestures) window.addEventListener(e, step2, { capture: true, passive: true });
          step2();
        }, 500),
      );
  }, 1000);
}

/** Call synchronously inside the user gesture (the call button, the speaker toggle). */
export function unlockAudio(): AudioContext | null {
  const C = audioCtor();
  if (!C) return null;
  if (!ctx || ctx.state === "closed") {
    try {
      ctx = new C();
    } catch {
      ctx = null;
      return null;
    }
    out = ctx.createGain();
    analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    out.connect(ctx.destination);
    out.connect(analyser);
  }
  if (ctx.state !== "running") void ctx.resume().catch(() => {});
  // iOS unlocks output only for a sound started inside the gesture: one silent sample
  try {
    const s = ctx.createBufferSource();
    s.buffer = ctx.createBuffer(1, 1, 22_050);
    s.connect(ctx.destination);
    s.start(0);
  } catch {
    /* ignore */
  }
  return ctx;
}

export const audioContext = () => (ctx && ctx.state !== "closed" ? ctx : null);

/** the live graph, or null before unlockAudio() / after closeAudio() */
export function audioGraph(): { ctx: AudioContext; out: GainNode; analyser: AnalyserNode } | null {
  return ctx && ctx.state !== "closed" && out && analyser ? { ctx, out, analyser } : null;
}

export function closeAudio() {
  const c = ctx;
  ctx = null;
  out = null;
  analyser = null;
  if (c && c.state !== "closed") void c.close().catch(() => {});
}
