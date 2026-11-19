import { apiInflight, onApiInflight } from "../api/client";
import { getTier } from "../motion/tier";
import { unloadedScreens } from "./nav";

/**
 * Background work waits for the first screen (perf budget: first-load JS, LCP, TBT — FOUNDATION.md "Performance").
 *   afterStartup()          window load → no JSON request in flight for 400 ms (the first screen's reads are in) →
 *                           an idle period. Capped at 8 s after load so a chatty screen cannot hold it forever.
 *   prefetchLazyScreens()   then every lazyScreen() chunk at once (small files, parallel; skipped under Save-Data:
 *                           on demand)
 *   afterStartupEffects()   then optional effects — the three/R3F chunk (AgentBlobLazy) and the liquid-glass lens
 *                           are decoration, the screens are navigation, so they come last and never compete with the
 *                           first screen. (The wallpaper is static CSS in the first-load chunk; it waits for nothing.)
 * All resolve once and stay resolved: anything mounted later starts at once (after one idle period).
 */
type IdleWindow = Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number };
const QUIET_MS = 400;
const CAP_MS = 8000;

export function idle(timeout = 1000): Promise<void> {
  return new Promise((resolve) => {
    const w = window as IdleWindow;
    if (w.requestIdleCallback) w.requestIdleCallback(() => resolve(), { timeout });
    else setTimeout(resolve, 50);
  });
}

let startup: Promise<void> | null = null;
export function afterStartup(): Promise<void> {
  return (startup ??= new Promise<void>((resolve) => {
    const begin = () => {
      let quiet: ReturnType<typeof setTimeout> | undefined;
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        off();
        clearTimeout(quiet);
        clearTimeout(cap);
        void idle().then(resolve);
      };
      const check = () => {
        clearTimeout(quiet);
        if (apiInflight() === 0) quiet = setTimeout(finish, QUIET_MS);
      };
      const cap = setTimeout(finish, CAP_MS);
      const off = onApiInflight(check);
      check();
    };
    if (document.readyState === "complete") begin();
    else window.addEventListener("load", begin, { once: true });
  }));
}

let prefetched: Promise<void> | null = null;
export function prefetchLazyScreens(): Promise<void> {
  return (prefetched ??= afterStartup().then(async () => {
    if (getTier().saveData) return;
    await Promise.all(unloadedScreens().map((s) => s.preload().catch(() => {})));
  }));
}

let effects: Promise<void> | null = null;
export function afterStartupEffects(): Promise<void> {
  return (effects ??= prefetchLazyScreens().then(() => idle(1500)));
}
