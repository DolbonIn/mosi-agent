/**
 * iOS rubber band past a limit (MOTION-SPEC §3 Slider, organic-motion §10):
 *   offset = limit + (1 − 1/(x·c/d + 1))·d     x = distance past the limit, d = 60 px, c = 0.55
 * 1:1 inside the limits; approaches limit ± d asymptotically; slope c at the limit.
 */
export const RUBBER_D = 60;
export const RUBBER_C = 0.55;

/** Signed resistance for a distance past a limit. */
export function rubberBand(distance: number, d = RUBBER_D, c = RUBBER_C): number {
  if (!distance || !(d > 0)) return 0;
  return Math.sign(distance) * (1 - 1 / ((Math.abs(distance) * c) / d + 1)) * d;
}

/** A raw (finger) value mapped through the band outside [min, max]. */
export function rubberClamp(value: number, min: number, max: number, d = RUBBER_D, c = RUBBER_C): number {
  if (value < min) return min + rubberBand(value - min, d, c);
  if (value > max) return max + rubberBand(value - max, d, c);
  return value;
}

/** Least-squares slope of the last ~80 ms of samples → units/s (release velocity). */
export interface Sample {
  t: number; // seconds
  v: number;
}
export function velocityOf(samples: Sample[], now: number, window = 0.08): number {
  const recent = samples.filter((s) => s.t <= now && now - s.t <= window);
  if (recent.length < 2) return 0;
  const mt = recent.reduce((a, s) => a + s.t, 0) / recent.length;
  const mv = recent.reduce((a, s) => a + s.v, 0) / recent.length;
  let tt = 0;
  let tv = 0;
  for (const s of recent) {
    tt += (s.t - mt) ** 2;
    tv += (s.t - mt) * (s.v - mv);
  }
  return tt < 1e-12 ? 0 : tv / tt;
}

/** Tracks pointer samples for a drag; `velocity()` at release. Ignores the fling if the finger rested > 80 ms. */
export function createVelocityTracker() {
  let samples: Sample[] = [];
  return {
    reset() {
      samples = [];
    },
    push(v: number, timeStampMs: number) {
      samples.push({ t: timeStampMs / 1000, v });
      if (samples.length > 16) samples.shift();
    },
    velocity(nowMs = performance.now()) {
      return velocityOf(samples, nowMs / 1000);
    },
  };
}

/** Where a release is heading: position projected 180 ms along the velocity. */
export const PROJECTION_S = 0.18;
export const project = (value: number, velocity: number) => value + velocity * PROJECTION_S;
