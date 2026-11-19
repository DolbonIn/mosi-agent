import { describe, expect, test } from "bun:test";
import { BODY_SCALE, EYE_SCALE, eyeOffset, eyeRig, surfaceLift, type EyeRig } from "../src/three/blobSurface";

/**
 * The 3D character's eyes never sink into its moving surface (AgentBlob, blobSurface.ts). The eyes are flattened
 * spheres set INTO the body: at rest (the shape the character always had, eyes at their rest centre) the body covers
 * their outer ring and about the inner 65 % of the radius shows. Over two minutes of drift, at rest and with the voice
 * wobble, no point of that visible part may lose more than 0.003 of its clearance (≈ 0.3 px at 208 px), and the
 * visible area may not shrink. Seen along the view axis (camera 4.4 away at 30° fov, near-orthographic; the pointer
 * tilt and the breathing scale move eyes and body together). The control: eyes left at their rest centre (the old
 * fixed meshes) would be covered — so the check can fail.
 */

const S = BODY_SCALE;

/** the body's front z at group-space (X, Y): solve for the unit direction whose lifted, scaled point lands there */
function surfaceZ(X: number, Y: number, time: number, amp: number): number {
  let lift = 0;
  let d: [number, number, number] = [0, 0, 1];
  for (let i = 0; i < 6; i++) {
    const dx = X / (S[0] * (1 + lift));
    const dy = Y / (S[1] * (1 + lift));
    d = [dx, dy, Math.sqrt(Math.max(0, 1 - dx * dx - dy * dy))];
    lift = surfaceLift(d[0], d[1], d[2], time, amp);
  }
  return S[2] * d[2] * (1 + lift);
}

/** the eye's disc as a grid of (u, v) in units of its radius */
const DISC: [number, number][] = [];
for (let i = -8; i <= 8; i++) for (let j = -8; j <= 8; j++) if ((i / 8) ** 2 + (j / 8) ** 2 < 1) DISC.push([i / 8, j / 8]);

/** clearance (eye front − body front) at each disc point; negative = covered there */
function clearances(rig: EyeRig, eyes: "dot" | "oval", c: readonly number[], time: number, amp: number): number[] {
  const [rx, ry, rz] = EYE_SCALE[eyes];
  return DISC.map(([u, v]) => c[2]! + rz * Math.sqrt(1 - u * u - v * v) - surfaceZ(c[0]! + u * rx, c[1]! + v * ry, time, amp));
}

/** over 2 min at 30 fps: the largest clearance lost on the rest-visible part, and the smallest visible share of it */
function worst(follow: boolean, amps: number[]) {
  let lost = 0;
  let share = 1;
  for (const eyes of ["dot", "oval"] as const) {
    for (const side of [-1, 1] as const) {
      const rig = eyeRig(side, eyes);
      const rest = clearances(rig, eyes, rig.base, 0, 0);
      const seen = rest.map((c) => c > 0);
      const n = seen.filter(Boolean).length;
      for (let f = 0; f <= 120 * 30; f++) {
        for (const a of amps) {
          const now = clearances(rig, eyes, follow ? eyeOffset(rig, f / 30, a) : rig.base, f / 30, a);
          let vis = 0;
          now.forEach((c, k) => {
            if (!seen[k]) return;
            lost = Math.max(lost, rest[k]! - c);
            if (c > 0) vis++;
          });
          share = Math.min(share, vis / n);
        }
      }
    }
  }
  return { lost, share };
}

describe("the eyes ride the surface", () => {
  test("idle drift (2 min): the eyes stay as visible as at rest", () => {
    const w = worst(true, [0]);
    expect(w.lost).toBeLessThan(0.003);
    expect(w.share).toBeGreaterThan(0.97);
  });

  test("voice wobble (amplitude 0.5 and 1): the eyes stay as visible as at rest", () => {
    const w = worst(true, [0.5, 1]);
    expect(w.lost).toBeLessThan(0.003);
    expect(w.share).toBeGreaterThan(0.97);
  });

  test("control: eyes fixed at their rest centre would be covered", () => {
    const w = worst(false, [0, 1]);
    expect(w.lost).toBeGreaterThan(0.02);
    expect(w.share).toBeLessThan(0.6);
  });
});
