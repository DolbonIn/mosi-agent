import { motion, useMotionValue, useTransform } from "framer-motion";
import { useEffect, useRef, useState } from "react";
import { springTo } from "../motion/springs";
import { useTier } from "../motion/tier";
import { getDeviceEl } from "../app/device";
import "./AdaptivePointer.css";

/**
 * Adaptive pointer (iPadOS-style, fine pointers only): a 22px translucent circle that follows the mouse inside the
 * device; over a control it morphs INTO the control's rounded rect (snap spring) and becomes its hover highlight;
 * over text inputs it becomes an I-beam; pressing shrinks it 10 % (the control itself lifts). The system cursor is
 * hidden inside the device only. Off for coarse pointers and reduced motion (the system cursor returns).
 * Controls opt in automatically (button, a, [role=tab|switch|slider|radio|option], [data-pointer]);
 * [data-pointer="none"] opts out (e.g. large cards that have their own hover).
 * Nothing renders (and the system cursor stays) until a REAL mouse has moved: a stream of ≥ 4 mouse moves, each within
 * 100 ms of the last, covering ≥ 6 px, with no press in between. So no dot at first paint, on touch, or from automated
 * clicks (one synthetic move per click, then a press). It hides after 4 s without movement.
 */
const SIZE = 22;
const ARM_MOVES = 4;
const ARM_GAP_MS = 100;
const ARM_DIST = 6;
const IDLE_HIDE_MS = 4000;
const TARGETS = 'button, a[href], [role="tab"], [role="switch"], [role="radio"], [role="option"], [role="slider"], [data-pointer]';

export function AdaptivePointer() {
  const tier = useTier();
  const enabled = tier.finePointer && !tier.reduceMotion;
  const x = useMotionValue(-100);
  const y = useMotionValue(-100);
  const w = useMotionValue(SIZE);
  const h = useMotionValue(SIZE);
  const r = useMotionValue(SIZE / 2);
  const press = useMotionValue(1);
  const [mode, setMode] = useState<"dot" | "snap" | "beam" | "hidden">("hidden");
  const [live, setLive] = useState(false); // a real mouse has moved inside the device
  const target = useRef<Element | null>(null);
  const tx = useTransform<number, number>([x, w], ([vx, vw]) => vx - vw / 2);
  const ty = useTransform<number, number>([y, h], ([vy, vh]) => vy - vh / 2);

  useEffect(() => {
    const device = getDeviceEl();
    if (!enabled || !device) return;
    let first = true;
    let armed = false;
    let moves = 0;
    let dist = 0;
    let lx = 0;
    let ly = 0;
    let lt = -Infinity;
    let idle: ReturnType<typeof setTimeout> | undefined;
    const resetStreak = () => {
      moves = 0;
      dist = 0;
      lt = -Infinity;
    };
    const onMove = (e: PointerEvent) => {
      if (e.pointerType !== "mouse") return;
      if (!armed) {
        if (e.timeStamp - lt > ARM_GAP_MS) {
          moves = 0;
          dist = 0;
        } else {
          dist += Math.hypot(e.clientX - lx, e.clientY - ly);
        }
        moves++;
        lx = e.clientX;
        ly = e.clientY;
        lt = e.timeStamp;
        if (moves < ARM_MOVES || dist < ARM_DIST) return;
        armed = true;
        device.dataset.pointer = "adaptive"; // hide the system cursor only now that the dot exists
        setLive(true);
      }
      clearTimeout(idle);
      idle = setTimeout(() => {
        setMode("hidden");
        first = true; // reappear at the pointer, not with a spring from the old spot
      }, IDLE_HIDE_MS);
      const box = device.getBoundingClientRect();
      const px = e.clientX - box.left;
      const py = e.clientY - box.top;
      const el = (e.target as Element | null)?.closest?.(TARGETS) ?? null;
      const input = (e.target as Element | null)?.closest?.('input:not([type="checkbox"]):not([type="range"]), textarea, [contenteditable="true"]');
      if (input) {
        target.current = null;
        setMode("beam");
        springTo(w, 2, "snap");
        springTo(h, 22, "snap");
        springTo(r, 1, "snap");
        x.set(px);
        y.set(py);
        return;
      }
      if (el && el.getAttribute("data-pointer") !== "none" && device.contains(el) && !(el as HTMLButtonElement).disabled) {
        const b = el.getBoundingClientRect();
        if (b.width <= 160 && b.height <= 96) {
          target.current = el;
          setMode("snap");
          const radius = parseFloat(getComputedStyle(el).borderTopLeftRadius) || 12;
          // follow the pointer a little (parallax) while snapped
          const cx = b.left - box.left + b.width / 2 + (px - (b.left - box.left + b.width / 2)) * 0.08;
          const cy = b.top - box.top + b.height / 2 + (py - (b.top - box.top + b.height / 2)) * 0.08;
          springTo(x, cx, "snap");
          springTo(y, cy, "snap");
          springTo(w, b.width, "snap");
          springTo(h, b.height, "snap");
          springTo(r, Math.min(radius, b.height / 2), "snap");
          return;
        }
      }
      target.current = null;
      setMode("dot");
      if (first) {
        first = false;
        x.set(px);
        y.set(py);
      } else {
        x.stop();
        y.stop();
        x.set(px);
        y.set(py);
      }
      springTo(w, SIZE, "snap");
      springTo(h, SIZE, "snap");
      springTo(r, SIZE / 2, "snap");
    };
    const onLeave = () => setMode("hidden");
    const onDown = () => {
      if (!armed) return resetStreak();
      springTo(press, 0.9, "press");
    };
    const onUp = () => {
      if (armed) springTo(press, 1, "press");
    };
    device.addEventListener("pointermove", onMove);
    device.addEventListener("pointerleave", onLeave);
    device.addEventListener("pointerdown", onDown);
    window.addEventListener("pointerup", onUp);
    return () => {
      clearTimeout(idle);
      delete device.dataset.pointer;
      device.removeEventListener("pointermove", onMove);
      device.removeEventListener("pointerleave", onLeave);
      device.removeEventListener("pointerdown", onDown);
      window.removeEventListener("pointerup", onUp);
    };
  }, [enabled, x, y, w, h, r, press]);

  if (!enabled || !live) return null;
  return <motion.div className="adaptive-pointer" data-mode={mode} aria-hidden="true" style={{ x: tx, y: ty, width: w, height: h, borderRadius: r, scale: press }} />;
}
