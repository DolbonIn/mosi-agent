import { useMotionValue, useTransform, useVelocity, type MotionValue } from "framer-motion";
import { useCallback, useLayoutEffect, useRef } from "react";
import { springTo } from "./springs";

/**
 * Two-edge indicator (MOTION-SPEC §3): the left and right edges are separate motion values. The edge on the side of
 * travel rides `lead` (.28/.86), the other `trail` (.42/.86) → the shape reaches ahead, then gathers. Retargets keep
 * velocity. The first placement is simply there (a selection never grows out of nothing).
 * Render with `x: left, width` (or translateX(L) scaleX((R−L)/base) for text-free shapes).
 */
export interface Edges {
  left: number;
  right: number;
}

export interface TwoEdge {
  left: MotionValue<number>;
  right: MotionValue<number>;
  width: MotionValue<number>;
  center: MotionValue<number>;
  /** specular rim angle that leans with the indicator's velocity ("135deg" ± 30) */
  rim: MotionValue<string>;
  /** stretch factor (current width / resting width) */
  stretch: MotionValue<number>;
  /** direct manipulation: place both edges now (stops springs) */
  hold(edges: Edges): void;
  /** spring both edges to a target (lead/trail by direction); optional release velocity in px/s */
  settle(edges: Edges, velocity?: number): void;
}

export function useTwoEdge(target: Edges | null, restWidth?: number): TwoEdge {
  const left = useMotionValue(target?.left ?? 0);
  const right = useMotionValue(target?.right ?? 0);
  const width = useTransform<number, number>([left, right], ([l, r]) => Math.max(0, r - l));
  const center = useTransform<number, number>([left, right], ([l, r]) => (l + r) / 2);
  const v = useVelocity(center);
  const rim = useTransform(v, (vel) => `${135 + Math.max(-30, Math.min(30, -vel / 40))}deg`);
  const base = useRef(restWidth ?? (target ? target.right - target.left : 1));
  if (restWidth) base.current = restWidth;
  const stretch = useTransform(width, (w) => (base.current > 0 ? w / base.current : 1));
  const placed = useRef(false);

  const hold = useCallback(
    (e: Edges) => {
      left.stop();
      right.stop();
      left.set(e.left);
      right.set(e.right);
    },
    [left, right],
  );

  const settle = useCallback(
    (e: Edges, velocity?: number) => {
      const forward = (e.left + e.right) / 2 >= (left.get() + right.get()) / 2;
      springTo(left, e.left, forward ? "trail" : "lead", velocity !== undefined ? { velocity } : {});
      springTo(right, e.right, forward ? "lead" : "trail", velocity !== undefined ? { velocity } : {});
    },
    [left, right],
  );

  const l = target?.left;
  const r = target?.right;
  useLayoutEffect(() => {
    if (l === undefined || r === undefined) return;
    if (!placed.current) {
      placed.current = true;
      left.set(l);
      right.set(r);
      if (!restWidth) base.current = r - l;
      return;
    }
    if (left.get() === l && right.get() === r) return;
    settle({ left: l, right: r });
  }, [l, r, left, right, settle, restWidth]);

  return { left, right, width, center, rim, stretch, hold, settle };
}
