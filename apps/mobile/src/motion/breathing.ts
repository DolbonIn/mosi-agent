import { useEffect, useState, type RefObject } from "react";
import { createStore, useStore } from "../lib/createStore";
import { useTierValue } from "./tier";

/**
 * Character breathing (MOTION-SPEC §8.11): period 3.2 s, scale amplitude 2 % (1 → 1.02, never more), and it only
 * runs while the character is on screen, the page is visible and there was input in the last 10 s — so an idle
 * screen has no running animation (§8.16). Reduced motion: the still pose. Page load counts as "no input yet".
 *   const live = useBreathing(ref, enabled)   // → toggle a CSS class / an R3F frameloop
 *   breathScale(t)                             // 1 … 1.02 at time t (seconds)
 */
export const BREATH_PERIOD_S = 3.2;
export const BREATH_AMPLITUDE = 0.02;
const IDLE_AFTER_MS = 10000;

export const breathScale = (t: number) => 1 + BREATH_AMPLITUDE * 0.5 * (1 - Math.cos((2 * Math.PI * t) / BREATH_PERIOD_S));

const recentInput = createStore(false);
let timer: ReturnType<typeof setTimeout> | undefined;
/** count something as user input (e.g. live voice) — keeps characters breathing for another 10 s */
export function noteInput() {
  if (!recentInput.get()) recentInput.set(true);
  clearTimeout(timer);
  timer = setTimeout(() => recentInput.set(false), IDLE_AFTER_MS);
}
if (typeof window !== "undefined") {
  for (const type of ["pointerdown", "keydown", "wheel", "touchstart"] as const) {
    window.addEventListener(type, noteInput, { capture: true, passive: true });
  }
}
export const useRecentInput = () => useStore(recentInput, (s) => s, Object.is);

/** on screen (IntersectionObserver) and the document visible */
export function useOnScreen(ref: RefObject<Element | null>, margin = "0px") {
  const [onScreen, setOnScreen] = useState(false);
  const [visible, setVisible] = useState(() => typeof document === "undefined" || !document.hidden);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setOnScreen(!!e?.isIntersecting), { rootMargin: margin });
    io.observe(el);
    const onVis = () => setVisible(!document.hidden);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      io.disconnect();
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [ref, margin]);
  return onScreen && visible;
}

export function useBreathing(ref: RefObject<Element | null>, enabled = true): boolean {
  const reduce = useTierValue("reduceMotion");
  const recent = useRecentInput();
  const shown = useOnScreen(ref);
  return enabled && !reduce && recent && shown;
}
