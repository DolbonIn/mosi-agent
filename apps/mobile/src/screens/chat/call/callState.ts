import type { ID } from "@pickle/protocol";
import { createStore, useStore } from "../../../lib/createStore";

/**
 * The call's state — tiny and loaded with the app, so the drawer ("통화 중") and the overlay host can read it. Everything
 * that runs a call (callStore.ts, voice.ts, speech.ts, CallOverlay.tsx) is a lazy chunk, loaded on the first call.
 */
export type VoiceKind = "stream" | "sentences" | "webspeech";

export type CallPhase = "connecting" | "listening" | "thinking" | "speaking" | "paused" | "ended";

/** what the call is doing, in words: under the character on the card, and on the long-pressed island */
export const PHASE_TEXT: Record<CallPhase, string> = {
  connecting: "연결 중",
  listening: "듣고 있어요",
  thinking: "생각하는 중",
  speaking: "말하는 중",
  paused: "음소거 중",
  ended: "통화 종료",
};

export interface CallLine {
  id: string;
  who: "me" | "agent" | "note";
  text: string;
  final: boolean;
}

export interface CallState {
  active: boolean;
  open: boolean;
  threadId: ID | null;
  phase: CallPhase;
  startedAt: number | null;
  muted: boolean;
  speaker: boolean;
  level: number;
  lines: CallLine[];
  /** Korean, user-facing (mic denied, network) */
  error: string | null;
  /** which voice is speaking right now */
  voice: VoiceKind | null;
  support: { stt: boolean; tts: boolean; mic: boolean };
}

export const IDLE_CALL: CallState = {
  active: false,
  open: false,
  threadId: null,
  phase: "ended",
  startedAt: null,
  muted: false,
  speaker: true,
  level: 0,
  lines: [],
  error: null,
  voice: null,
  support: { stt: false, tts: false, mic: false },
};

export const callStore = createStore<CallState>(IDLE_CALL);
export const useCall = <S = CallState>(sel?: (s: CallState) => S) => useStore(callStore, sel ?? ((s: CallState) => s as unknown as S));
