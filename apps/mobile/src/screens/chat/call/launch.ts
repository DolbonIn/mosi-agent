import type { ID } from "@pickle/protocol";
import { unlockAudio } from "./audioUnlock";

/**
 * Start a voice call from a tap. The audio unlock must happen right here, synchronously inside the gesture (iOS
 * Safari); the call code itself is a lazy chunk (prefetched after startup) that follows a moment later.
 */
export function launchCall(threadId: ID, source?: HTMLElement | null) {
  unlockAudio();
  const rect = source?.getBoundingClientRect() ?? null;
  void import("./callStore").then((m) => m.startCall(threadId, rect));
}
