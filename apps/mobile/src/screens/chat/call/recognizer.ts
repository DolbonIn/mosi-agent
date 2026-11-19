/**
 * Speech recognition and the support probe — small, and loaded with the app (the composer's dictation uses it; the
 * call's heavier audio code is a lazy chunk). No dependencies, every API feature-detected.
 *   speechSupport()        { stt, tts, mic }
 *   createRecognizer()     Web Speech API (SpeechRecognition / webkitSpeechRecognition), ko-KR, interim results
 */

interface SpeechRecognitionResultLike {
  isFinal: boolean;
  0: { transcript: string };
}
interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: ArrayLike<SpeechRecognitionResultLike>;
}
interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((e: SpeechRecognitionEventLike) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
type RecognitionCtor = new () => SpeechRecognitionLike;

function recognitionCtor(): RecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function speechSupport() {
  return {
    stt: !!recognitionCtor(),
    tts: typeof window !== "undefined" && "speechSynthesis" in window && typeof SpeechSynthesisUtterance !== "undefined",
    mic: typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia,
  };
}

export interface RecognizerHandlers {
  onInterim?(text: string): void;
  onFinal(text: string): void;
  onEnd?(): void;
  onError?(code: string): void;
}

export interface Recognizer {
  start(h: RecognizerHandlers): void;
  stop(): void;
  abort(): void;
}

export function createRecognizer(): Recognizer | null {
  const Ctor = recognitionCtor();
  if (!Ctor) return null;
  let r: SpeechRecognitionLike | null = null;
  return {
    start(h) {
      // a recogniser replaced by a new start must not report its own end/error (that would restart listening again)
      const prev = r;
      if (prev) {
        prev.onresult = null;
        prev.onerror = null;
        prev.onend = null;
        try {
          prev.abort();
        } catch {
          /* ignore */
        }
      }
      const rec = new Ctor();
      r = rec;
      rec.lang = "ko-KR";
      rec.continuous = false;
      rec.interimResults = true;
      rec.maxAlternatives = 1;
      let finalSent = false;
      rec.onresult = (e) => {
        let interim = "";
        let final = "";
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const res = e.results[i]!;
          if (res.isFinal) final += res[0].transcript;
          else interim += res[0].transcript;
        }
        if (final.trim() && !finalSent) {
          finalSent = true;
          h.onFinal(final.trim());
        } else if (interim.trim()) h.onInterim?.(interim.trim());
      };
      rec.onerror = (e) => h.onError?.(e.error);
      rec.onend = () => {
        if (r === rec) r = null;
        if (!finalSent) h.onEnd?.();
      };
      try {
        rec.start();
      } catch {
        h.onError?.("start-failed");
      }
    },
    stop() {
      try {
        r?.stop();
      } catch {
        /* ignore */
      }
    },
    abort() {
      const cur = r;
      r = null;
      try {
        cur?.abort();
      } catch {
        /* ignore */
      }
    },
  };
}
