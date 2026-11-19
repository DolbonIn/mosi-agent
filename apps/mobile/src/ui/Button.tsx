import { animate, motion, useMotionValue } from "framer-motion";
import { useCallback, useEffect, useId, useRef, useState, type CSSProperties, type MouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type Ref } from "react";
import { ContentSwap } from "../motion/ContentSwap";
import { haptic } from "../motion/haptics";
import { SPRING, springTo, t } from "../motion/springs";
import { useTierValue } from "../motion/tier";
import { usePress } from "../motion/usePress";
import { Glass } from "./Glass";
import { Icon, type AppIconName } from "./Icon";
import "./Button.css";

/**
 * Button (MOTION-SPEC §3 Press + Loader → check).
 *   variant: "capsule" (standalone, r = h/2) | "circle" (icon-only) | "plain" (text on paper)
 *   tone:    "primary" (accent fill — the ONE primary action per screen, MOTION-SPEC §8.1) | "glass" (floating chrome) |
 *            "secondary" (fill; success turns accent) | "neutral" (fill + label in every state — invite, call, FAB,
 *            list actions: never accent, never a coloured glow) | "destructive"
 *   elevated: marks a FAB; draws nothing extra (Flat Paper: no shadow — it keeps its tone's fill).
 *   stop:    the send button while a turn runs (§8.4): the glyph morphs into a rounded square; label "멈추기".
 *   confirm: high-risk actions (§8.6): hold 1.2 s to confirm (a linear fill; release rewinds on `snap`) AND the
 *            equivalent two-step tap in the same place (first tap swaps the label to `confirm.label`, a second tap
 *            within 3 s confirms) — both always work; keyboard / screen readers use the two-step path.
 * State machine: idle → loading (capsule contracts into a circle, spinning ring ONLY while in flight) →
 * success (the ring completes, the circle fills accent, a check draws itself — ONLY after the server confirms) →
 * idle (label returns after ~0.9 s) | error (back to the capsule with "다시 시도하기", inputs kept).
 * Pass `action` (a promise) for the automatic machine, or drive `state` yourself.
 * Busy keeps focus: aria-busy + aria-disabled (never `disabled` mid-wait); a click guard blocks double submits.
 */
export type ButtonState = "idle" | "loading" | "success" | "error";
export type ButtonTone = "primary" | "glass" | "secondary" | "neutral" | "destructive";
export type ButtonVariant = "capsule" | "circle" | "plain";
export type ButtonSize = "lg" | "md" | "sm";

const HEIGHT: Record<ButtonSize, number> = { lg: 52, md: 44, sm: 36 };

export interface ButtonProps {
  children?: ReactNode;
  variant?: ButtonVariant;
  tone?: ButtonTone;
  size?: ButtonSize;
  icon?: AppIconName;
  /** controlled state (omit to let `action` drive it) */
  state?: ButtonState;
  /** async work: idle → loading → success | error. Resolve = the server confirmed. */
  action?: () => Promise<unknown>;
  onClick?: (e: MouseEvent<HTMLButtonElement>) => void;
  /** fired after the success check has been shown (e.g. navigate) */
  onSuccess?: () => void;
  onError?: (err: unknown) => void;
  errorLabel?: string;
  /** announced while loading (screen readers) */
  busyLabel?: string;
  successLabel?: string;
  /** keep the success check instead of returning to the label */
  holdSuccess?: boolean;
  disabled?: boolean;
  fullWidth?: boolean;
  type?: "button" | "submit";
  ariaLabel?: string;
  className?: string;
  style?: CSSProperties;
  /** glass tone only: share the bar group's blur */
  blur?: "own" | "group";
  ref?: Ref<HTMLButtonElement>;
  form?: string;
  id?: string;
  /** marks a FAB; no shadow (Flat Paper), it keeps its tone's fill */
  elevated?: boolean;
  /** send → Stop morph while a turn runs */
  stop?: boolean;
  /** hold-to-confirm 1.2 s + two-step tap (high-risk approvals) */
  confirm?: { label: string; holdMs?: number; hint?: string };
}

const CONFIRM_WINDOW = 3000;
const TAP_MAX = 260;

export function Button({
  children,
  variant = "capsule",
  tone = "primary",
  size = "lg",
  icon,
  state: controlled,
  action,
  onClick,
  onSuccess,
  onError,
  errorLabel = "다시 시도하기",
  busyLabel = "처리하는 중",
  successLabel = "완료했어요",
  holdSuccess,
  disabled,
  fullWidth,
  type = "button",
  ariaLabel,
  className,
  style,
  blur = "own",
  ref,
  form,
  id,
  elevated,
  stop,
  confirm,
}: ButtonProps) {
  const [auto, setAuto] = useState<ButtonState>("idle");
  const state = controlled ?? auto;
  const [confirming, setConfirming] = useState(false);
  const hold = useMotionValue(0);
  const holdRef = useRef<{ t0: number; anim: { stop(): void } | null; done: boolean } | null>(null);
  const suppress = useRef(false);
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const hintId = useId();
  const reduce = useTierValue("reduceMotion");
  const h = HEIGHT[size];
  const busy = state === "loading";
  const compact = state === "loading" || state === "success";
  const mounted = useRef(true);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // set true on (re)mount: StrictMode runs mount → cleanup → mount, and the cleanup alone would leave it false forever
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      clearTimeout(timer.current);
      clearTimeout(confirmTimer.current);
    };
  }, []);

  // success → hand back to the label after the check has been seen (unless held). Haptics only on a change, not on mount.
  const prevState = useRef(state);
  useEffect(() => {
    const changed = prevState.current !== state;
    prevState.current = state;
    if (changed && state === "error") haptic("error");
    if (changed && state === "success") haptic("success");
  }, [state]);
  useEffect(() => {
    if (state !== "success") return;
    const done = setTimeout(() => {
      onSuccess?.();
      if (!holdSuccess && controlled === undefined && mounted.current) setAuto("idle");
    }, 900);
    return () => clearTimeout(done);
  }, [state, holdSuccess, controlled, onSuccess]);

  const run = useCallback(
    async (e: MouseEvent<HTMLButtonElement> | null) => {
      if (e) onClick?.(e);
      if (!action || e?.defaultPrevented) return;
      e?.preventDefault();
      setAuto("loading");
      try {
        await action();
        if (mounted.current) setAuto("success");
      } catch (err) {
        if (mounted.current) setAuto("error");
        onError?.(err);
      }
    },
    [onClick, action, onError],
  );

  const resetConfirm = useCallback(() => {
    clearTimeout(confirmTimer.current);
    setConfirming(false);
  }, []);

  const handleClick = useCallback(
    (e: MouseEvent<HTMLButtonElement>) => {
      if (disabled || busy || state === "success") {
        e.preventDefault();
        return;
      }
      if (suppress.current) {
        // the pointer was held (confirmed or rewound): not a tap
        suppress.current = false;
        e.preventDefault();
        return;
      }
      if (confirm && !confirming) {
        // step one of the two-step tap: the label becomes the question, in the same place
        e.preventDefault();
        haptic("selection");
        setConfirming(true);
        clearTimeout(confirmTimer.current);
        confirmTimer.current = setTimeout(() => mounted.current && setConfirming(false), CONFIRM_WINDOW);
        return;
      }
      if (confirm) {
        resetConfirm();
        haptic("impact");
      }
      void run(e);
    },
    [disabled, busy, state, confirm, confirming, run, resetConfirm],
  );

  // hold-to-confirm: a linear fill for holdMs; completing confirms, releasing early rewinds on `snap`
  const holdMs = confirm?.holdMs ?? 1200;
  const onHoldStart = (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (!confirm || disabled || busy || state === "success" || !e.isPrimary || (e.pointerType === "mouse" && e.button !== 0)) return;
    suppress.current = false;
    const h0 = { t0: performance.now(), anim: null as { stop(): void } | null, done: false };
    holdRef.current = h0;
    h0.anim = animate(hold, 1, {
      duration: (holdMs / 1000) * (1 - hold.get()),
      ease: "linear",
      onComplete: () => {
        if (holdRef.current !== h0) return;
        h0.done = true;
        suppress.current = true;
        haptic("impact");
        resetConfirm();
        hold.jump(0);
        void run(null);
      },
    });
  };
  const onHoldEnd = () => {
    const h0 = holdRef.current;
    if (!h0) return;
    holdRef.current = null;
    if (h0.done) return;
    h0.anim?.stop();
    if (performance.now() - h0.t0 > TAP_MAX) suppress.current = true;
    springTo(hold, 0, "snap");
  };

  const press = usePress({ kind: tone === "glass" ? "glass" : "opaque", scale: variant === "circle" && h <= 36 ? 1.12 : undefined, disabled: disabled || busy });
  const isCircle = variant === "circle";
  const width = isCircle || compact ? h : fullWidth ? "100%" : "auto";

  const label: ReactNode =
    state === "loading" ? (
      <Ring key="ring" tone={tone} complete={false} reduce={reduce} />
    ) : state === "success" ? (
      <Ring key="done" tone={tone} complete reduce={reduce} />
    ) : state === "error" ? (
      <span className="btn-label">
        <Icon name="refresh" size={size === "sm" ? 16 : 18} weight="medium" />
        {!isCircle && <span>{errorLabel}</span>}
      </span>
    ) : stop ? (
      <span className="btn-label" key="stop">
        <motion.span
          className="btn-stop"
          initial={reduce ? false : { scale: 0.5, borderRadius: 6 }}
          animate={{ scale: 1, borderRadius: 3.5 }}
          transition={SPRING.snap}
          aria-hidden="true"
        />
        {!isCircle && <span>멈추기</span>}
      </span>
    ) : confirming && confirm ? (
      <span className="btn-label" key="confirm">
        <span>{confirm.label}</span>
      </span>
    ) : (
      <span className="btn-label">
        {icon && <Icon name={icon} size={isCircle ? (h >= 44 ? 22 : 18) : size === "sm" ? 16 : 19} weight={tone === "primary" ? "medium" : "regular"} />}
        {!isCircle && children !== undefined && <span>{children}</span>}
      </span>
    );

  const common = {
    id,
    form,
    type,
    "aria-label": stop ? "멈추기" : confirming && confirm ? confirm.label : ariaLabel ?? (isCircle && typeof children === "string" ? children : undefined),
    "aria-busy": busy || undefined,
    "aria-disabled": disabled || busy || undefined,
    "aria-describedby": confirm ? hintId : undefined,
    "data-state": state,
    "data-tone": tone,
    "data-variant": variant,
    "data-size": size,
    "data-elevated": elevated || undefined,
    "data-stop": stop || undefined,
    "data-confirming": confirming || undefined,
    onClick: handleClick,
    onPointerUp: confirm ? onHoldEnd : undefined,
    onPointerCancel: confirm ? onHoldEnd : undefined,
    onPointerLeave: confirm ? onHoldEnd : undefined,
    onBlur: confirm ? resetConfirm : undefined,
  };

  const liveText = state === "loading" ? busyLabel : state === "success" ? successLabel : "";

  const swapKey = state === "idle" ? (stop ? "stop" : confirming ? "confirm" : "idle") : state;
  const inner = (
    <>
      {confirm && <motion.span className="btn-hold" style={{ scaleX: hold }} aria-hidden="true" />}
      <ContentSwap swapKey={swapKey} className="btn-swap">
        {label}
      </ContentSwap>
      <span className="sr-only" aria-live="polite">
        {liveText || (confirming && confirm ? confirm.label : "")}
      </span>
      {confirm && (
        <span id={hintId} className="sr-only">
          {confirm.hint ?? "두 번 눌러 확인하거나 길게 누르세요"}
        </span>
      )}
    </>
  );

  const sizeStyle: CSSProperties = { height: h, minWidth: h, borderRadius: h / 2, ...style };

  if (tone === "glass" && variant !== "plain") {
    return (
      <Glass
        as="button"
        ref={ref as Ref<HTMLElement>}
        text
        radius={h / 2}
        interactive={disabled || busy ? false : isCircle && h <= 36 ? 1.12 : 1.06}
        blur={blur}
        className={`btn${fullWidth ? " btn-full" : ""}${className ? ` ${className}` : ""}`}
        style={sizeStyle}
        animate={{ width }}
        transition={t("morph")}
        {...(common as object)}
        onPointerDown={confirm ? (onHoldStart as never) : undefined}
      >
        {inner}
      </Glass>
    );
  }

  return (
    <motion.button
      ref={ref}
      className={`btn${fullWidth ? " btn-full" : ""}${className ? ` ${className}` : ""}`}
      style={{ ...sizeStyle, scale: press.scale }}
      onPointerDown={(e: ReactPointerEvent<HTMLButtonElement>) => {
        press.bind.onPointerDown(e as never);
        onHoldStart(e);
      }}
      animate={{ width }}
      transition={t("morph")}
      disabled={disabled && !busy ? true : undefined}
      {...(common as object)}
    >
      {inner}
    </motion.button>
  );
}

/** Activity ring → completes → check draws (snap). The ring spins only while a request is in flight. */
function Ring({ tone, complete, reduce }: { tone: ButtonTone; complete: boolean; reduce: boolean }) {
  const onAccent = tone === "primary" || complete;
  const stroke = onAccent ? "var(--on-accent)" : "var(--accent)";
  const C = 2 * Math.PI * 9;
  return (
    <span className={`btn-ring${complete ? " done" : ""}`} data-loop={complete ? undefined : "busy"} aria-hidden="true">
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
        <motion.circle
          cx="12"
          cy="12"
          r="9"
          stroke={stroke}
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeDasharray={C}
          initial={false}
          animate={{ strokeDashoffset: complete ? 0 : C * 0.72, opacity: complete ? 0 : 1 }}
          transition={reduce ? { duration: 0 } : { strokeDashoffset: SPRING.snap, opacity: { ...SPRING.fade, delay: complete ? 0.18 : 0 } }}
        />
        {complete && (
          <motion.path
            d="M7.2 12.4l3.2 3.2 6.4-7"
            stroke="var(--on-accent)"
            strokeWidth="2.4"
            strokeLinecap="round"
            strokeLinejoin="round"
            initial={reduce ? false : { pathLength: 0 }}
            animate={{ pathLength: 1 }}
            transition={reduce ? { duration: 0 } : { ...SPRING.snap, delay: 0.16 }}
          />
        )}
      </svg>
    </span>
  );
}
