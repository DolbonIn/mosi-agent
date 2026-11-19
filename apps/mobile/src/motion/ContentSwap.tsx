import { AnimatePresence, motion, useIsPresent } from "framer-motion";
import { useLayoutEffect, useRef, type CSSProperties, type ReactNode, type Ref } from "react";
import { EXIT, SPRING, SWAP, SWAP_ENTER_DELAY } from "./springs";
import { useTierValue } from "./tier";

/**
 * Content swap inside a morphing container (MOTION-SPEC §3): the old copy leaves in 120 ms (blur 6px, scale .96,
 * fade, ease-in); the new one starts 60 ms after the exit ends on its own `morph` spring (blur 6→0, scale .96→1,
 * opacity). Exit and enter never overlap; the leaving copy is aria-hidden + inert. After enter, `filter: none`.
 * Scoped to the container (popLayout), never to a whole route. Reduced motion: the new content, at once.
 * §8.2: the blur only runs when the container is ≤ 25 % of the viewport (measured after each render); larger
 * containers and every `direction` (panel) swap use opacity + transform only — no page-sized `filter` animation.
 */
export interface ContentSwapProps {
  /** a new key = a new copy */
  swapKey: string | number;
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  /** "inline" (default) for labels; "block" for panels */
  display?: "inline" | "block";
  /** page-sized content: never scales — recedes 8px against travel and arrives from 16px (direction ±1) */
  direction?: -1 | 0 | 1;
  /** the container is already morphing: content enters at +60ms instead of after the exit */
  enterDelay?: number;
  as?: "span" | "div";
}

export function ContentSwap({ swapKey, children, className, style, display = "inline", direction, enterDelay, as = "span" }: ContentSwapProps) {
  const reduce = useTierValue("reduceMotion");
  const Host = as === "div" ? motion.div : motion.span;
  const host = useRef<HTMLElement | null>(null);
  const small = useRef(direction === undefined);
  useLayoutEffect(() => {
    const el = host.current;
    if (!el || direction !== undefined) {
      small.current = false;
      return;
    }
    small.current = el.offsetWidth * el.offsetHeight <= 0.25 * window.innerWidth * window.innerHeight;
  });
  return (
    <Host ref={host as never} className={`swap-host ${display === "block" ? "block" : ""} ${className ?? ""}`} style={style}>
      <AnimatePresence initial={false} mode="popLayout">
        <SwapItem key={swapKey} reduce={reduce} direction={direction} enterDelay={enterDelay} as={as} blur={small.current}>
          {children}
        </SwapItem>
      </AnimatePresence>
    </Host>
  );
}

function SwapItem({
  children,
  reduce,
  direction,
  enterDelay,
  as,
  blur: allowBlur,
  ref,
}: {
  children: ReactNode;
  reduce: boolean;
  direction?: -1 | 0 | 1;
  enterDelay?: number;
  as: "span" | "div";
  blur: boolean;
  ref?: Ref<HTMLElement>;
}) {
  const present = useIsPresent();
  const page = direction !== undefined;
  const delay = enterDelay ?? SWAP_ENTER_DELAY;
  const El = as === "div" ? motion.div : motion.span;
  if (reduce) {
    return (
      <El ref={ref as never} aria-hidden={!present || undefined} inert={!present || undefined} initial={false} exit={{ opacity: 0, transition: { duration: 0 } }}>
        {children}
      </El>
    );
  }
  const blur = `blur(${SWAP.blurPx}px)`;
  const useBlur = allowBlur && !page;
  const initial = page
    ? { opacity: 0, x: 16 * (direction || 0), y: direction ? 0 : 6 }
    : useBlur
      ? { opacity: 0, scale: SWAP.scale, filter: blur }
      : { opacity: 0, scale: SWAP.scale };
  const animate = page
    ? {
        opacity: 1,
        x: 0,
        y: 0,
        transition: { x: { ...SPRING.camera, delay }, y: { ...SPRING.camera, delay }, opacity: { ...SPRING.fade, delay } },
      }
    : useBlur
      ? {
          opacity: 1,
          scale: 1,
          filter: "blur(0px)",
          // filter on the critically damped fade spring: the morph spring overshoots below 0 → "blur(-0.03px)" warnings
          transition: { ...SPRING.morph, delay, opacity: { ...SPRING.fade, delay }, filter: { ...SPRING.fade, delay } },
          transitionEnd: { filter: "none" },
        }
      : { opacity: 1, scale: 1, transition: { ...SPRING.morph, delay, opacity: { ...SPRING.fade, delay } } };
  const exit = page
    ? { opacity: 0, x: -8 * (direction || 0), transition: EXIT }
    : useBlur
      ? { opacity: 0, scale: SWAP.scale, filter: blur, transition: EXIT }
      : { opacity: 0, scale: SWAP.scale, transition: EXIT };
  return (
    <El
      ref={ref as never}
      aria-hidden={!present || undefined}
      inert={!present || undefined}
      initial={initial}
      animate={animate}
      exit={exit}
      style={{ display: as === "span" ? "inline-block" : undefined, pointerEvents: present ? undefined : "none" }}
    >
      {children}
    </El>
  );
}

/** `<SwapText text="확인하는 중" />` — words change by the 120/60 ms swap, never by a crossfade. */
export function SwapText({ text, className }: { text: string | number; className?: string }) {
  return (
    <ContentSwap swapKey={String(text)} className={className}>
      {text}
    </ContentSwap>
  );
}
