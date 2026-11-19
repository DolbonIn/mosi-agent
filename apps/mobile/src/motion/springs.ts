import { animate, type AnimationPlaybackControls, type MotionValue, type Transition } from "framer-motion";
import { getTier } from "./tier";

/**
 * The one spring table (MOTION-SPEC §2). Apple parameters (response, dampingFraction) → closed form:
 *   ω = 2π/response, ζ = damping, x(t) = 1 − e^(−ζωt)(cos ω_d t + (ζω/ω_d) sin ω_d t), ω_d = ω√(1−ζ²)
 * framer-motion: stiffness = ω², damping = 2ζω, mass = 1. Every role overshoots ≤ 3 %. No bouncy/elastic easing.
 */
export type SpringRole = "morph" | "press" | "snap" | "camera" | "lead" | "trail" | "fade";

export const ROLES: Readonly<Record<SpringRole, { response: number; damping: number }>> = Object.freeze({
  morph: { response: 0.45, damping: 0.86 }, // containers changing size/radius/material, sheets, island
  press: { response: 0.25, damping: 0.75 }, // press lift-and-swell (2.8 % overshoot)
  snap: { response: 0.3, damping: 0.9 }, // pointer/selection snap, toggles, chips, check draws, digit rolls
  camera: { response: 0.6, damping: 1.0 }, // screen-level moves, scroll-to, drawer, wallpaper re-tint
  lead: { response: 0.28, damping: 0.86 }, // leading edge of a moving indicator
  trail: { response: 0.42, damping: 0.86 }, // trailing edge
  fade: { response: 0.24, damping: 1.0 }, // opacity-only twins
});

const TAU = Math.PI * 2;

/** framer-motion spring transition for a role. */
export function springTransition(role: SpringRole, extra?: Partial<Transition>): Transition {
  const { response, damping } = ROLES[role];
  const w = TAU / response;
  return { type: "spring", stiffness: w * w, damping: 2 * damping * w, mass: 1, ...extra } as Transition;
}

export const SPRING: Readonly<Record<SpringRole, Transition>> = Object.freeze({
  morph: springTransition("morph"),
  press: springTransition("press"),
  snap: springTransition("snap"),
  camera: springTransition("camera"),
  lead: springTransition("lead"),
  trail: springTransition("trail"),
  fade: springTransition("fade"),
});

/** Content swap (MOTION-SPEC §3): exit 120 ms (blur 6, scale .96, fade, ease-in) → enter 60 ms after exit ends. */
export const SWAP = Object.freeze({ exitMs: 120, gapMs: 60, blurPx: 6, scale: 0.96 });
export const SWAP_ENTER_DELAY = (SWAP.exitMs + SWAP.gapMs) / 1000;
export const EXIT_EASE: [number, number, number, number] = [0.4, 0, 1, 1];
export const EXIT: Transition = { duration: SWAP.exitMs / 1000, ease: EXIT_EASE };
/** Content arriving inside a shape that is already morphing (sheet, island, card): +60 ms. */
export const CONTENT_DELAY = 0.06;

function params(role: SpringRole) {
  const { response, damping } = ROLES[role];
  const w = TAU / response;
  return { w, z: damping, wd: damping < 1 ? w * Math.sqrt(1 - damping * damping) : 0 };
}

/** Step response 0 → 1. */
export function step(t: number, role: SpringRole): number {
  if (!(t > 0)) return 0;
  const { w, z, wd } = params(role);
  if (!wd) return 1 - Math.exp(-w * t) * (1 + w * t);
  return 1 - Math.exp(-z * w * t) * (Math.cos(wd * t) + ((z * w) / wd) * Math.sin(wd * t));
}

/** Impulse response (x′(0) = 1/s): scaled by a release velocity it is the throw. */
export function impulse(t: number, role: SpringRole): number {
  if (!(t > 0)) return 0;
  const { w, z, wd } = params(role);
  return wd ? (Math.exp(-z * w * t) * Math.sin(wd * t)) / wd : t * Math.exp(-w * t);
}

const settleCache = new Map<string, number>();
/** Seconds until the step response stays within eps of 1. */
export function settleTime(role: SpringRole, eps = 1e-3): number {
  const key = role + eps;
  const hit = settleCache.get(key);
  if (hit) return hit;
  const { response } = ROLES[role];
  const dt = response / 2048;
  let last = 0;
  for (let t = 0; t < response * 8; t += dt) if (Math.abs(1 - step(t, role)) > eps) last = t;
  settleCache.set(key, last + dt);
  return last + dt;
}

/** Largest speed toward the target (units/s) whose release over `travel` overshoots ≤ max. */
export function releaseLimit(role: SpringRole, travel: number, max = 0.03): number {
  const { w } = params(role);
  const reach = Math.max(Math.abs(travel), 1);
  const span = settleTime(role) * 4;
  const peak = (u: number) => {
    let top = 1;
    for (let i = 1; i <= 200; i++) {
      const t = (span * i) / 200;
      top = Math.max(top, step(t, role) + u * w * impulse(t, role));
    }
    return top;
  };
  if (peak(0) > 1 + max) return 0;
  let lo = 0;
  let hi = 1;
  while (peak(hi) <= 1 + max && hi < 64) {
    lo = hi;
    hi *= 2;
  }
  for (let i = 0; i < 28; i++) {
    const mid = (lo + hi) / 2;
    if (peak(mid) <= 1 + max) lo = mid;
    else hi = mid;
  }
  return lo * w * reach;
}

/** CSS custom-property names of a role (tokens.css). */
export const cssEase = (role: SpringRole) => `var(--ease-${role})`;
export const cssDur = (role: SpringRole) => `var(--dur-${role})`;
export const cssTransition = (prop: string, role: SpringRole) => `${prop} ${cssDur(role)} ${cssEase(role)}`;

export interface SpringToOptions {
  /** initial velocity (units/s). Omit to keep the value's current velocity (interruptible retarget). */
  velocity?: number;
  /** cap the velocity toward the target so the landing overshoots ≤ 3 % (releases). Default true when velocity given. */
  capOvershoot?: boolean;
  onComplete?: () => void;
  onUpdate?: (v: number) => void;
}

/**
 * Drive a MotionValue to `to` on a role. Retargeting mid-flight keeps position AND velocity (framer reads the value's
 * velocity). Reduced motion: lands in one frame.
 */
export function springTo(mv: MotionValue<number>, to: number, role: SpringRole, opts: SpringToOptions = {}): AnimationPlaybackControls {
  if (getTier().reduceMotion) {
    mv.stop();
    mv.set(to);
    opts.onUpdate?.(to);
    opts.onComplete?.();
    return animate(mv, to, { duration: 0 });
  }
  let velocity = opts.velocity;
  if (velocity !== undefined && opts.capOvershoot !== false) {
    const travel = to - mv.get();
    if (velocity && Math.sign(velocity) === Math.sign(travel)) {
      velocity = Math.sign(velocity) * Math.min(Math.abs(velocity), releaseLimit(role, travel));
    }
  }
  return animate(mv, to, {
    ...(SPRING[role] as object),
    ...(velocity !== undefined ? { velocity } : {}),
    restDelta: Math.abs(to - mv.get()) < 4 ? 0.0005 : 0.01,
    onComplete: opts.onComplete,
    onUpdate: opts.onUpdate,
  } as Transition);
}

/** Reduced-motion aware framer transition: under reduced motion every spring becomes a 1 ms jump. */
export function t(role: SpringRole, extra?: Partial<Transition>): Transition {
  if (getTier().reduceMotion) return { duration: 0, ...extra, type: "tween" } as Transition;
  return springTransition(role, extra);
}
