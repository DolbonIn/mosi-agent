import type { UserSettings } from "@pickle/protocol";
import { createStore, useStore } from "../lib/createStore";

/**
 * What this device and this person can take (MOTION-SPEC §7, organic-motion §11). Decided before anything optional
 * loads. OS signals (reduced motion / transparency / contrast, Save-Data, deviceMemory, battery) are merged with the
 * user's own UserSettings.display overrides ("system" | "on" | "off"), then written to <html> as data attributes so CSS
 * and JS read one answer:
 *   data-theme="light|dark"  data-motion="full|reduce"  data-transparency="normal|reduce"  data-contrast="normal|more"
 *   data-pointer="fine|coarse"  --text-scale
 */
export type DisplayPrefs = UserSettings["display"];

export interface Tier {
  theme: "light" | "dark";
  reduceMotion: boolean;
  reduceTransparency: boolean;
  highContrast: boolean;
  saveData: boolean;
  lowMemory: boolean;
  lowPower: boolean;
  finePointer: boolean;
  textScale: number;
  /** optional effects (liquid-glass-js lens, 3D idle blob, ambient loops); the wallpaper is static CSS either way */
  effects: "live" | "static";
  prefs: DisplayPrefs;
}

const PREFS_KEY = "pickle.display";
export const DEFAULT_DISPLAY: DisplayPrefs = { theme: "system", reduceMotion: "system", reduceTransparency: "system", textScale: 1 };

const mq = (q: string) => (typeof matchMedia === "function" ? matchMedia(q) : null);
const queries = {
  dark: mq("(prefers-color-scheme: dark)"),
  motion: mq("(prefers-reduced-motion: reduce)"),
  transparency: mq("(prefers-reduced-transparency: reduce)"),
  contrast: mq("(prefers-contrast: more)"),
  fine: mq("(hover: hover) and (pointer: fine)"),
};

function loadPrefs(): DisplayPrefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (raw) return { ...DEFAULT_DISPLAY, ...(JSON.parse(raw) as Partial<DisplayPrefs>) };
  } catch {
    /* private mode */
  }
  return DEFAULT_DISPLAY;
}

type Nav = Navigator & { connection?: { saveData?: boolean }; deviceMemory?: number; getBattery?: () => Promise<{ level: number; charging: boolean; addEventListener(t: string, f: () => void): void }> };
let batteryLow = false;

function resolve(prefs: DisplayPrefs): Tier {
  const nav = (typeof navigator !== "undefined" ? navigator : {}) as Nav;
  const pick = (v: "system" | "on" | "off", sys: boolean) => (v === "on" ? true : v === "off" ? false : sys);
  const reduceMotion = pick(prefs.reduceMotion, !!queries.motion?.matches);
  const reduceTransparency = pick(prefs.reduceTransparency, !!queries.transparency?.matches);
  const highContrast = !!queries.contrast?.matches;
  const saveData = !!nav.connection?.saveData;
  const lowMemory = typeof nav.deviceMemory === "number" && nav.deviceMemory < 2;
  const lowPower = batteryLow || (typeof nav.hardwareConcurrency === "number" && nav.hardwareConcurrency <= 2);
  const theme = prefs.theme === "system" ? (queries.dark?.matches ? "dark" : "light") : prefs.theme;
  const textScale = Math.min(1.3, Math.max(0.9, prefs.textScale || 1));
  const effects = reduceMotion || saveData || lowMemory || lowPower ? "static" : "live";
  return {
    theme,
    reduceMotion,
    reduceTransparency,
    highContrast,
    saveData,
    lowMemory,
    lowPower,
    finePointer: !!queries.fine?.matches,
    textScale,
    effects,
    prefs,
  };
}

export const tierStore = createStore<Tier>(resolve(loadPrefs()));
export const getTier = () => tierStore.get();
export const useTier = () => useStore(tierStore);
export function useTierValue<K extends keyof Tier>(key: K): Tier[K] {
  return useStore(tierStore, (t) => t[key], Object.is);
}

function apply(t: Tier) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.dataset.theme = t.theme;
  root.dataset.motion = t.reduceMotion ? "reduce" : "full";
  root.dataset.transparency = t.reduceTransparency ? "reduce" : "normal";
  root.dataset.contrast = t.highContrast ? "more" : "normal";
  root.dataset.pointer = t.finePointer ? "fine" : "coarse";
  root.dataset.effects = t.effects;
  root.style.setProperty("--text-scale", String(t.textScale));
  const meta = document.querySelector('meta[name="theme-color"]');
  meta?.setAttribute("content", t.theme === "dark" ? "#0a0a0c" : "#f5f5f7");
}

function recompute(prefs = tierStore.get().prefs) {
  const next = resolve(prefs);
  tierStore.set(next);
  apply(next);
}

let started = false;
/** Call once before the first render (main.tsx). Applies root attributes synchronously and follows OS changes. */
export function initTier() {
  if (started) return;
  started = true;
  apply(tierStore.get());
  for (const q of Object.values(queries)) q?.addEventListener?.("change", () => recompute());
  const nav = navigator as Nav;
  nav.getBattery?.()
    .then((b) => {
      const check = () => {
        const low = !b.charging && b.level <= 0.2;
        if (low !== batteryLow) {
          batteryLow = low;
          recompute();
        }
      };
      check();
      b.addEventListener("levelchange", check);
      b.addEventListener("chargingchange", check);
    })
    .catch(() => {});
}

/**
 * Change the user's display overrides (local first; the settings store also PATCHes the server).
 * A theme change is the ONE allowed crossfade (MOTION-SPEC §6.12): a 200 ms View Transition root fade.
 */
export function setDisplayPrefs(patch: Partial<DisplayPrefs>) {
  const prefs = { ...tierStore.get().prefs, ...patch };
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* ignore */
  }
  const before = tierStore.get().theme;
  const after = resolve(prefs).theme;
  const doc = document as Document & { startViewTransition?: (cb: () => void) => unknown };
  if (before !== after && doc.startViewTransition && !tierStore.get().reduceMotion) {
    document.documentElement.dataset.themeSwap = "true";
    const vt = doc.startViewTransition(() => recompute(prefs)) as { finished?: Promise<void>; ready?: Promise<void> } | undefined;
    // a second change before this one lands (arrow keys through the theme list) skips it: `ready` rejects, not an error
    vt?.ready?.catch(() => {});
    vt?.finished?.finally(() => delete document.documentElement.dataset.themeSwap);
  } else {
    recompute(prefs);
  }
}
