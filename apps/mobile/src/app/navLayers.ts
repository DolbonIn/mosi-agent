import { animate, motionValue, type MotionValue } from "framer-motion";
import type { TabId } from "@pickle/protocol";
import { haptic } from "../motion/haptics";
import { springTo } from "../motion/springs";
import { nav, navStore } from "./nav";

/**
 * The nav layers' motion values (one x / opacity pair per tab root and pushed screen) and the back-swipe controller
 * the Shell's edge gesture drives. Kept out of NavStack.tsx so that file exports components only (Fast Refresh).
 */
export interface LayerMV {
  x: MotionValue<number>;
  o: MotionValue<number>;
}
export const layers = new Map<string, LayerMV>();
export function mv(key: string, init?: { x: number; o: number }): LayerMV {
  let l = layers.get(key);
  if (!l) {
    l = { x: motionValue(init?.x ?? 0), o: motionValue(init?.o ?? 1) };
    layers.set(key, l);
  }
  return l;
}
export const rootKey = (tab: TabId) => `root:${tab}`;

// ── back swipe controller (driven by the Shell's edge gesture) ──
let swipeW = 390;
let swipe: { top: LayerMV; under: LayerMV } | null = null;
export const backSwipe = {
  begin(width: number): boolean {
    const s = navStore.get();
    const stack = s.stacks[s.tab];
    if (!stack.length) return false;
    const top = layers.get(stack[stack.length - 1]!.key);
    const underKey = stack.length > 1 ? stack[stack.length - 2]!.key : rootKey(s.tab);
    const under = layers.get(underKey);
    if (!top || !under) return false;
    swipeW = width;
    swipe = { top, under };
    top.x.stop();
    top.o.stop();
    under.x.stop();
    under.o.stop();
    return true;
  },
  move(dx: number) {
    if (!swipe) return;
    const x = Math.max(0, dx);
    const k = Math.min(1, x / swipeW);
    swipe.top.x.set(x);
    swipe.top.o.set(1 - k * 0.85);
    swipe.under.x.set(-24 * (1 - k));
    swipe.under.o.set(k);
  },
  end(dx: number, velocity: number) {
    if (!swipe) return;
    const { top, under } = swipe;
    swipe = null;
    const projected = dx + velocity * 0.18;
    if (projected > swipeW * 0.4 || velocity > 700) {
      haptic("selection");
      const remaining = Math.max(0, swipeW - top.x.get());
      const dur = Math.min(0.32, Math.max(0.14, remaining / Math.max(velocity, 900)));
      animate(top.x, swipeW, { duration: dur, ease: [0.2, 0.7, 0.3, 1] });
      animate(top.o, 0, { duration: dur, ease: "linear" });
      springTo(under.x, 0, "camera", { velocity: velocity * (24 / swipeW) });
      // committed: the page underneath is complete from this frame (no fade-in after the finger lifts)
      under.o.stop();
      under.o.jump(1);
      window.setTimeout(() => nav.pop({ instant: true }), dur * 1000);
    } else {
      springTo(top.x, 0, "camera", { velocity: -velocity });
      springTo(top.o, 1, "fade");
      springTo(under.x, -24, "camera");
      springTo(under.o, 0, "fade");
    }
  },
};
