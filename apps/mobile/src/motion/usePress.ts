import { useMotionValue, type MotionValue } from "framer-motion";
import { useCallback, useEffect, useRef, type PointerEvent as ReactPointerEvent } from "react";
import { springTo } from "./springs";
import { getTier } from "./tier";

/**
 * Press = lift and swell (MOTION-SPEC §3). Glass: scale 1.06 (small controls up to 1.12), rim brightens +.15.
 * Opaque controls: lift 1.03 + fill darkens 6 % (CSS: [data-pressed="true"]). It NEVER shrinks.
 * Pointer only: keyboard activation shows the focus ring and no swell. Reduced motion: tint/rim only, no swell.
 * Releases on pointerup anywhere (no stuck press) and keeps velocity on retarget (press spring).
 */
export interface PressOptions {
  /** swell target. Glass default 1.06, opaque default 1.03. Clamped to [1, 1.12]. */
  scale?: number;
  kind?: "glass" | "opaque";
  disabled?: boolean;
  onPressStart?: () => void;
  onPressEnd?: () => void;
}

export interface Press {
  scale: MotionValue<number>;
  rimBoost: MotionValue<number>;
  bind: { onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void };
  isPressed: () => boolean;
}

export function usePress(opts: PressOptions = {}): Press {
  const scale = useMotionValue(1);
  const rimBoost = useMotionValue(0);
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const pressed = useRef<HTMLElement | null>(null);
  const cleanup = useRef<(() => void) | null>(null);

  const release = useCallback(() => {
    const el = pressed.current;
    if (!el) return;
    pressed.current = null;
    delete el.dataset.pressed;
    cleanup.current?.();
    cleanup.current = null;
    springTo(scale, 1, "press");
    springTo(rimBoost, 0, "fade");
    optsRef.current.onPressEnd?.();
  }, [scale, rimBoost]);

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLElement>) => {
      const o = optsRef.current;
      if (o.disabled || (e.pointerType === "mouse" && e.button !== 0)) return;
      const el = e.currentTarget;
      if (el.getAttribute("aria-disabled") === "true" || (el as HTMLButtonElement).disabled) return;
      pressed.current = el;
      el.dataset.pressed = "true";
      const kind = o.kind ?? "glass";
      const target = Math.min(1.12, Math.max(1, o.scale ?? (kind === "glass" ? 1.06 : 1.03)));
      if (!getTier().reduceMotion) springTo(scale, target, "press");
      springTo(rimBoost, kind === "glass" ? 0.15 : 0, "fade");
      o.onPressStart?.();
      const up = () => release();
      window.addEventListener("pointerup", up, { once: true });
      window.addEventListener("pointercancel", up, { once: true });
      cleanup.current = () => {
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", up);
      };
    },
    [scale, rimBoost, release],
  );

  useEffect(() => () => cleanup.current?.(), []);

  return { scale, rimBoost, bind: { onPointerDown }, isPressed: () => !!pressed.current };
}
