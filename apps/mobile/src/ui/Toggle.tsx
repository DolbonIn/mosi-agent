import { motion, useMotionValue, useTransform } from "framer-motion";
import { useCallback, useRef, type KeyboardEvent, type MouseEvent, type PointerEvent } from "react";
import { springTo } from "../motion/springs";
import { useTwoEdge } from "../motion/useTwoEdge";
import { createVelocityTracker, project, rubberClamp } from "../motion/rubberBand";
import { getTier } from "../motion/tier";
import { haptic } from "../motion/haptics";
import "./Toggle.css";

/**
 * Toggle — the Focus-style switch (MOTION-SPEC §3). 51×31 track in a ≥44 px hit area; a 27 px knob inset 2 px
 * (concentric: 15.5 − 2 = 13.5). Hold → the knob becomes a clear, enlarged glass lens (×1.35, tint .06) showing the
 * track through it and follows the finger 1:1 (rubber band at the ends). Flip → the lens stretches in the direction of
 * travel (two edges: lead/trail) and gathers; the accent fill follows the knob's progress. Committed on release: a tap
 * toggles, a drag decides by its position projected along the release velocity.
 * A real <button role="switch" aria-checked>; Space/Enter toggle. Reduced motion: knob and fill jump, no lens grow.
 *
 *   <Toggle label="브리핑 알림" checked={on} onChange={setOn} />
 *
 * `onRequest` asks before a flip lands: return false and the knob springs back where it was (a tap barely moves, a
 * drag returns from the finger with its velocity) and onChange is not called — the caller confirms elsewhere, e.g.
 * 정보 공개 범위's in-place "끄기" (§8.6).
 */
export interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  disabled?: boolean;
  className?: string;
  id?: string;
  /** return false to keep the current value (the knob springs back, onChange is not called) */
  onRequest?: (next: boolean) => boolean;
}

const TRACK_W = 51;
const KNOB = 27;
const INSET = 2;
const OFF_L = INSET;
const ON_L = TRACK_W - INSET - KNOB;
const HALF = KNOB / 2;
const OFF_C = OFF_L + HALF;
const ON_C = ON_L + HALF;

export function Toggle({ checked, onChange, label, disabled, className, id, onRequest }: ToggleProps) {
  const target = checked ? { left: ON_L, right: ON_L + KNOB } : { left: OFF_L, right: OFF_L + KNOB };
  const edge = useTwoEdge(target, KNOB);
  const hold = useMotionValue(1);

  // knob drawn as one 27 px circle: translate to the edges' centre, stretch to their width, keep round caps by
  // countering the stretch in the horizontal border radius (rx = 13.5 / stretch, ry = 13.5)
  const x = useTransform(edge.center, (c) => c - HALF);
  const stretch = useTransform(edge.width, (w) => Math.max(0.5, w / KNOB));
  const scaleX = useTransform<number, number>([stretch, hold], ([s, h]) => s * h);
  const radius = useTransform(stretch, (s) => `${(HALF / s).toFixed(3)}px / ${HALF}px`);
  const progress = useTransform(edge.center, (c) => Math.min(1, Math.max(0, (c - OFF_C) / (ON_C - OFF_C))));

  const drag = useRef<{ id: number; startX: number; startC: number; moved: boolean } | null>(null);
  const suppressClick = useRef(false);
  const tracker = useRef(createVelocityTracker());
  const btnRef = useRef<HTMLButtonElement>(null);

  const setHeld = useCallback(
    (on: boolean) => {
      const el = btnRef.current;
      if (el) {
        if (on) el.dataset.held = "true";
        else delete el.dataset.held;
      }
      if (getTier().reduceMotion) return;
      springTo(hold, on ? 1.35 : 1, "snap");
    },
    [hold],
  );

  const commit = (next: boolean, velocity?: number) => {
    if (next !== checked && onRequest && !onRequest(next)) next = checked;
    const t = next ? { left: ON_L, right: ON_L + KNOB } : { left: OFF_L, right: OFF_L + KNOB };
    edge.settle(t, velocity);
    if (next !== checked) {
      haptic("toggle");
      onChange(next);
    }
  };

  const onPointerDown = (e: PointerEvent<HTMLButtonElement>) => {
    if (disabled || (e.pointerType === "mouse" && e.button !== 0)) return;
    suppressClick.current = false;
    drag.current = { id: e.pointerId, startX: e.clientX, startC: edge.center.get(), moved: false };
    tracker.current.reset();
    tracker.current.push(edge.center.get(), e.timeStamp);
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    setHeld(true);
  };

  const onPointerMove = (e: PointerEvent<HTMLButtonElement>) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.id) return;
    const dx = e.clientX - d.startX;
    if (!d.moved && Math.abs(dx) < 3) return;
    d.moved = true;
    const c = rubberClamp(d.startC + dx, OFF_C, ON_C, 12);
    edge.hold({ left: c - HALF, right: c + HALF });
    tracker.current.push(c, e.timeStamp);
  };

  const onPointerEnd = (e: PointerEvent<HTMLButtonElement>) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.id) return;
    drag.current = null;
    setHeld(false);
    if (!d.moved) return; // a tap: the click handler toggles
    suppressClick.current = true;
    if (e.type === "pointercancel") {
      commit(checked);
      return;
    }
    const v = tracker.current.velocity(e.timeStamp);
    const c = edge.center.get();
    const next = project(c, v) > (OFF_C + ON_C) / 2;
    commit(next, v);
  };

  const onClick = (e: MouseEvent<HTMLButtonElement>) => {
    if (suppressClick.current) {
      suppressClick.current = false;
      e.preventDefault();
      return;
    }
    if (disabled) return;
    commit(!checked);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    // buttons already turn Space/Enter into click; prevent page scroll on Space
    if (e.key === " ") e.preventDefault();
  };

  return (
    <button
      ref={btnRef}
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={`toggle${className ? ` ${className}` : ""}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
      onClick={onClick}
      onKeyDown={onKeyDown}
    >
      <span className="toggle-track" aria-hidden="true">
        <motion.span className="toggle-fill" style={{ opacity: progress }} />
        <motion.span className="toggle-knob" style={{ x, scaleX, scaleY: hold, borderRadius: radius }} />
      </span>
    </button>
  );
}
