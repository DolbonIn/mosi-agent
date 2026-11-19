/**
 * Haptics (MOTION-SPEC §4): Android `navigator.vibrate` only. iOS web has none — never rely on it; the visual and the
 * words must be complete without it.
 */
export type HapticKind = "selection" | "toggle" | "impact" | "success" | "error";

const PATTERNS: Record<HapticKind, number | number[]> = {
  selection: 8,
  toggle: 8,
  impact: 12,
  success: [8, 60, 8],
  error: [8, 40, 8],
};

export function haptic(kind: HapticKind = "selection") {
  try {
    if (typeof navigator === "undefined" || typeof navigator.vibrate !== "function") return;
    // only in response to the person: Chrome logs an error for vibrate() before any user activation
    const ua = (navigator as Navigator & { userActivation?: { isActive: boolean; hasBeenActive: boolean } }).userActivation;
    if (ua && !ua.hasBeenActive) return;
    navigator.vibrate(PATTERNS[kind]);
  } catch {
    /* some webviews throw without a user gesture */
  }
}
