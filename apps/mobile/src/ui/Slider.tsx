import { motion, useMotionValue, useTransform } from "framer-motion";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import { springTo } from "../motion/springs";
import { createVelocityTracker, rubberClamp } from "../motion/rubberBand";
import { getTier } from "../motion/tier";
import { haptic } from "../motion/haptics";
import { Icon } from "./Icon";
import "./Slider.css";

/**
 * Slider (MOTION-SPEC §3): direct manipulation. Grabbed, the track thickens 6 → 12 px (clip-path, caps stay round) and
 * the knob turns into a clear glass lens (×1.15) so the fill shows through. The value follows the finger 1:1 from where
 * it went down (dragging the knob never jumps; a tap on the track jumps there). Past a limit the fill end rubber-bands
 * (offset = limit + (1 − 1/(x·.55/d + 1))·d, d = 60) and the knob follows with less give — the leading edge first.
 * On release both spring back from where they are AND at the release velocity (fill `lead`, knob `trail`).
 * Keyboard: ←/→/↑/↓ step, PageUp/PageDown ×10, Home/End — the knob moves at once.
 * Reduced motion: the follow stays 1:1 (it is the person's own movement), no grow, the release lands at once.
 *
 *   <Slider label="글자 크기" value={scale} min={0.9} max={1.3} step={0.05} onChange={setScale} minIcon="minus" maxIcon="plus" />
 */
type IconName = ComponentProps<typeof Icon>["name"];

export interface SliderProps {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  label: string;
  /** value → accessible/visible text (aria-valuetext) */
  format?: (value: number) => string;
  minIcon?: IconName;
  maxIcon?: IconName;
  disabled?: boolean;
  className?: string;
  /** fired once on release / key step with the final value */
  onCommit?: (value: number) => void;
  /** render the formatted value at the trailing end */
  showValue?: boolean;
}

const KNOB = 28;
const R = KNOB / 2;
const BAND = 60;
const KNOB_BAND = 18;

export function Slider({
  value,
  onChange,
  min = 0,
  max = 1,
  step,
  label,
  format,
  minIcon,
  maxIcon,
  disabled,
  className,
  onCommit,
  showValue,
}: SliderProps) {
  const labelId = useId();
  const areaRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const range = Math.max(1e-9, max - min);
  const fmt = format ?? ((v: number) => (min === 0 && max === 1 ? `${Math.round(v * 100)}%` : String(Math.round(v * 100) / 100)));

  // geometry: knob centre travels [R, W − R]; the fill runs from 0 to the fill end
  const usable = Math.max(1, width - KNOB);
  const toPx = useCallback((v: number) => R + ((Math.min(max, Math.max(min, v)) - min) / range) * usable, [min, max, range, usable]);
  const toValue = useCallback(
    (px: number) => {
      let v = min + ((px - R) / usable) * range;
      v = Math.min(max, Math.max(min, v));
      if (step) v = Math.round((v - min) / step) * step + min;
      return Math.min(max, Math.max(min, Number(v.toFixed(6))));
    },
    [min, max, range, usable, step],
  );

  const fillEnd = useMotionValue(0);
  const knob = useMotionValue(0);
  const thick = useMotionValue(0); // 0 = 6 px track, 1 = 12 px
  const grow = useMotionValue(1);
  const knobX = useTransform(knob, (c) => c - R);
  const trackClip = useTransform(thick, (k) => {
    const inset = 3 * (1 - Math.min(1, Math.max(0, k)));
    return `inset(${inset.toFixed(2)}px 0 round ${(6 - inset).toFixed(2)}px)`;
  });
  const widthRef = useRef(0);
  widthRef.current = width;
  const fillClip = useTransform(fillEnd, (e) => {
    const right = Math.max(0, widthRef.current - Math.max(0, e));
    return `inset(0 ${right.toFixed(2)}px 0 0)`;
  });

  const [grabbed, setGrabbed] = useState(false);
  const drag = useRef<{ id: number; startX: number; startPx: number; moved: boolean; limit: -1 | 0 | 1 } | null>(null);
  const tracker = useRef(createVelocityTracker());
  const targetPx = useRef<number | null>(null);
  const lastValue = useRef(value);
  lastValue.current = value;

  useLayoutEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    const measure = () => setWidth(el.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // follow the controlled value when nobody is holding the knob (keyboard / external): at once
  useLayoutEffect(() => {
    if (!width || drag.current) return;
    const px = toPx(value);
    if (targetPx.current !== null && Math.abs(px - targetPx.current) < 0.5) return;
    targetPx.current = px;
    fillEnd.stop();
    knob.stop();
    fillEnd.set(px);
    knob.set(px);
  }, [value, width, toPx, fillEnd, knob]);

  const emit = useCallback(
    (v: number) => {
      if (v === lastValue.current) return;
      if (step) haptic("selection");
      lastValue.current = v;
      onChange(v);
    },
    [onChange, step],
  );

  const setGrab = (on: boolean) => {
    setGrabbed(on);
    if (getTier().reduceMotion) return;
    springTo(thick, on ? 1 : 0, "snap");
    springTo(grow, on ? 1.15 : 1, "snap");
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (disabled || drag.current || (e.pointerType === "mouse" && e.button !== 0)) return;
    const el = e.currentTarget;
    const rect = el.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const onKnob = Math.abs(x - knob.get()) <= Math.max(22, R + 6);
    let startPx = knob.get();
    if (!onKnob) {
      // a tap on the track jumps there (fill leads, knob snaps after); a drag then continues 1:1 from the finger
      const v = toValue(x);
      const px = toPx(v);
      targetPx.current = px;
      springTo(fillEnd, px, "lead");
      springTo(knob, px, "snap");
      emit(v);
      startPx = Math.min(width - R, Math.max(R, x));
    }
    drag.current = { id: e.pointerId, startX: e.clientX, startPx, moved: false, limit: 0 };
    tracker.current.reset();
    tracker.current.push(startPx, e.timeStamp);
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    setGrab(true);
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.id) return;
    const dx = e.clientX - d.startX;
    if (!d.moved && Math.abs(dx) < 3) return;
    d.moved = true;
    const raw = d.startPx + dx;
    const lo = R;
    const hi = width - R;
    // leading edge first: the fill end gives d = 60 past a limit, the knob only 18
    const fe = rubberClamp(raw, lo, hi, BAND);
    const kn = rubberClamp(raw, lo, hi, KNOB_BAND);
    fillEnd.stop();
    knob.stop();
    fillEnd.set(fe);
    knob.set(kn);
    tracker.current.push(raw, e.timeStamp);
    const limit: -1 | 0 | 1 = raw < lo ? -1 : raw > hi ? 1 : 0;
    if (limit !== 0 && d.limit !== limit) haptic("selection");
    d.limit = limit;
    const v = toValue(Math.min(hi, Math.max(lo, raw)));
    targetPx.current = toPx(v);
    emit(v);
  };

  const end = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.id) return;
    drag.current = null;
    setGrab(false);
    const v = lastValue.current;
    const px = toPx(v);
    targetPx.current = px;
    const velocity = d.moved ? tracker.current.velocity(e.timeStamp) : 0;
    springTo(fillEnd, px, "lead", { velocity });
    springTo(knob, px, "trail", { velocity });
    onCommit?.(v);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    const s = step ?? range / 100;
    let next: number | null = null;
    switch (e.key) {
      case "ArrowRight":
      case "ArrowUp":
        next = value + s;
        break;
      case "ArrowLeft":
      case "ArrowDown":
        next = value - s;
        break;
      case "PageUp":
        next = value + s * 10;
        break;
      case "PageDown":
        next = value - s * 10;
        break;
      case "Home":
        next = min;
        break;
      case "End":
        next = max;
        break;
      default:
        return;
    }
    e.preventDefault();
    const v = toValue(toPx(next));
    if (v === value) {
      haptic("selection");
      return;
    }
    emit(v);
    onCommit?.(v);
  };

  useEffect(
    () => () => {
      fillEnd.stop();
      knob.stop();
    },
    [fillEnd, knob],
  );

  return (
    <div className={`slider${disabled ? " is-disabled" : ""}${className ? ` ${className}` : ""}`}>
      <span id={labelId} className="sr-only">
        {label}
      </span>
      {minIcon && (
        <span className="slider-icon" aria-hidden="true">
          <Icon name={minIcon} size={18} />
        </span>
      )}
      <div
        ref={areaRef}
        className="slider-area"
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-labelledby={labelId}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
        aria-valuetext={fmt(value)}
        aria-orientation="horizontal"
        aria-disabled={disabled || undefined}
        data-grabbed={grabbed || undefined}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={end}
        onPointerCancel={end}
        onKeyDown={onKeyDown}
      >
        <motion.div className="slider-track" style={{ clipPath: trackClip, WebkitClipPath: trackClip }}>
          <motion.div className="slider-fill" style={{ clipPath: fillClip, WebkitClipPath: fillClip }} />
        </motion.div>
        <motion.div className="slider-knob" style={{ x: knobX, scale: grow }} />
      </div>
      {maxIcon && (
        <span className="slider-icon" aria-hidden="true">
          <Icon name={maxIcon} size={22} />
        </span>
      )}
      {showValue && (
        <span className="slider-value tnum" aria-hidden="true">
          {fmt(value)}
        </span>
      )}
    </div>
  );
}
