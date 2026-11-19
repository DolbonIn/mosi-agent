/**
 * The character's surface, shared by the vertex shader (AgentBlob `vert`) and the CPU (the eyes ride it). The body is
 * a unit sphere scaled by BODY_SCALE; every vertex moves along its normal (= its unit position) by `surfaceLift`:
 *  - drift: a slow, low-frequency swell (≈ 18 s cycles), always on while the character is animating;
 *  - wobble: a quicker ripple scaled by the voice amplitude (0..1, calls).
 * The eyes are flattened spheres set into the body (at rest it covers their outer ring). Each frame they move forward
 * by the most the body's front has risen anywhere under them since rest (17 footprint samples), so the part of each
 * eye that shows at rest keeps showing; when the surface sinks they sink with it, never floating off it.
 * Keep `surfaceLift` and the GLSL in AgentBlob in step (qa/blob-eyes.test.ts checks the eyes stay clear).
 */

export const DRIFT = 0.055;
export const WOBBLE = 0.05;
export const BODY_SCALE: readonly [number, number, number] = [1.06, 0.94, 0.96];
/** eye centres in the character's group space (x is ±EYE_X) and their mesh scale per eye style */
export const EYE_X = 0.27;
export const EYE_Y = 0.1;
export const EYE_Z = 0.9;
export const EYE_SCALE = {
  dot: [0.085, 0.085, 0.05],
  oval: [0.075, 0.12, 0.05],
} as const;

/** lift along the normal at unit-sphere direction (x, y, z), at shader time `time` (s) and voice amplitude `amp` */
export function surfaceLift(x: number, y: number, z: number, time: number, amp: number): number {
  const t = time * 0.35;
  const n = Math.sin(x * 1.7 + t) * Math.sin(y * 1.3 + t * 0.8) * Math.sin(z * 1.5 + t * 1.1);
  const wob = Math.sin(y * 7.0 + time * 11.0) * Math.sin(x * 5.0 + time * 7.0);
  return n * DRIFT + wob * WOBBLE * amp;
}

type V3 = [number, number, number];

/**
 * The body's front z at group-space (X, Y): the unit direction whose lifted, scaled point lands on (X, Y), found by a
 * few fixed-point steps (the lift is small, so it settles fast).
 */
export function surfaceZ(X: number, Y: number, time: number, amp: number): number {
  let lift = 0;
  let dz = 1;
  for (let i = 0; i < 3; i++) {
    const dx = X / (BODY_SCALE[0] * (1 + lift));
    const dy = Y / (BODY_SCALE[1] * (1 + lift));
    dz = Math.sqrt(Math.max(0, 1 - dx * dx - dy * dy));
    lift = surfaceLift(dx, dy, dz, time, amp);
  }
  return BODY_SCALE[2] * dz * (1 + lift);
}

export interface EyeRig {
  /** the eye's rest centre (group space) */
  base: V3;
  /** footprint samples: group-space (x, y) and the body's front z there at rest (time 0, still) */
  samples: [number, number, number][];
}

/** footprint: the centre and two rings (45 % and 80 % of the eye's radius) */
export function eyeRig(side: -1 | 1, eyes: "dot" | "oval" | "smile"): EyeRig {
  const [rx, ry] = eyes === "dot" ? EYE_SCALE.dot : EYE_SCALE.oval;
  const base: V3 = [side * EYE_X, EYE_Y, EYE_Z];
  const pts: [number, number][] = [[base[0], base[1]]];
  for (const k of [0.45, 0.8]) {
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      pts.push([base[0] + Math.cos(a) * rx * k, base[1] + Math.sin(a) * ry * k]);
    }
  }
  return { base, samples: pts.map(([x, y]) => [x, y, surfaceZ(x, y, 0, 0)]) };
}

/**
 * Where the eye sits now: its rest centre moved forward (z only) by the most the body's front has risen anywhere under
 * it since rest, so the part of the eye that shows at rest keeps showing.
 */
export function eyeOffset(rig: EyeRig, time: number, amp: number, out: V3 = [0, 0, 0]): V3 {
  let rise = -Infinity;
  for (const [x, y, z0] of rig.samples) rise = Math.max(rise, surfaceZ(x, y, time, amp) - z0);
  out[0] = rig.base[0];
  out[1] = rig.base[1];
  // the voice ripple is finer than the footprint samples: a hair more clearance while it plays (≤ 0.006, < 1 px)
  out[2] = rig.base[2] + rise + 0.006 * amp;
  return out;
}
