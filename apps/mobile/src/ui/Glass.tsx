import { motion, type HTMLMotionProps, type MotionValue } from "framer-motion";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  type CSSProperties,
  type ReactNode,
  type Ref,
  type RefObject,
} from "react";
import { usePress } from "../motion/usePress";
import { useTierValue } from "../motion/tier";
import { veilFor } from "../three/palette";
import { getDeviceRect } from "../app/device";
import { R, roundedRectPath } from "./geometry";
import "../styles/glass.css";

/**
 * Liquid Glass (MOTION-SPEC §1).
 *   <Glass radius={24} text interactive>…</Glass>
 * - variant "regular" (default; anything with text) | "clear" (only over rich media).
 * - `text`: the surface carries labels → tint ≥ .55. `sheet`: near-opaque, no backdrop (dialogs).
 * - `rim`: specular angle (string "135deg" or a MotionValue<string>, e.g. from useTwoEdge().rim) — follows motion.
 * - `interactive`: lift & swell on press (true = 1.06, or a scale up to 1.12). Never shrinks.
 * - `lens`: accepted for compatibility; no effect (the wallpaper is CSS now, so there is no WebGL lens to draw).
 * - `blur="group"`: inside a <BlurGroup>, share ONE backdrop-filter with the other members (≤ 3 on screen).
 * - `adaptive`: legibility veil from the wallpaper luminance under the rect.
 * Reduced transparency: opaque surface + hairline. Increased contrast: tint .92, no rim. Dark: flips material.
 */
type GlassTag = "div" | "button" | "nav" | "header" | "section" | "span" | "a" | "footer";

export interface GlassProps extends Omit<HTMLMotionProps<"div">, "ref" | "children"> {
  as?: GlassTag;
  variant?: "regular" | "clear";
  text?: boolean;
  sheet?: boolean;
  radius?: number;
  tint?: number;
  rim?: MotionValue<string> | string;
  rimBoost?: MotionValue<number> | number;
  interactive?: boolean | number;
  lens?: boolean | number;
  blur?: "own" | "group" | "none";
  adaptive?: boolean;
  shadow?: boolean;
  children?: ReactNode;
  ref?: Ref<HTMLElement>;
  /** extra: forwarded to <button>/<a> */
  type?: "button" | "submit";
  href?: string;
  disabled?: boolean;
}

export function Glass({
  as = "div",
  variant = "regular",
  text,
  sheet,
  radius = R.control,
  tint,
  rim,
  rimBoost,
  interactive,
  lens,
  blur = "own",
  adaptive,
  shadow = true,
  className,
  style,
  children,
  ref,
  onPointerDown,
  ...rest
}: GlassProps) {
  const local = useRef<HTMLElement | null>(null);
  const setRef = useCallback(
    (el: HTMLElement | null) => {
      local.current = el;
      if (typeof ref === "function") ref(el);
      else if (ref && typeof ref === "object") (ref as { current: HTMLElement | null }).current = el;
    },
    [ref],
  );
  const group = useContext(BlurGroupContext);
  const grouped = blur === "group" && !!group;
  const press = usePress({
    scale: typeof interactive === "number" ? interactive : 1.06,
    disabled: !interactive,
    onPressStart: grouped ? () => group?.trackFor(600) : undefined,
    onPressEnd: grouped ? () => group?.trackFor(600) : undefined,
  });
  useBlurMember(local, radius, grouped);
  useAdaptiveVeil(local, !!adaptive);

  const Tag = (motion as unknown as Record<string, typeof motion.div>)[as] ?? motion.div;
  const styleVars: Record<string, unknown> = { ...(style as object), "--r": `${radius}px` };
  if (tint !== undefined) styleVars["--tint"] = tint;
  if (rim !== undefined) styleVars["--rim"] = rim;
  if (interactive) {
    styleVars.scale = press.scale;
    styleVars["--rim-boost"] = rimBoost ?? press.rimBoost;
  } else if (rimBoost !== undefined) styleVars["--rim-boost"] = rimBoost;

  return (
    <Tag
      ref={setRef as never}
      className={`glass${variant === "clear" ? " glass--clear" : ""}${className ? ` ${className}` : ""}`}
      data-text={text ? "" : undefined}
      data-sheet={sheet ? "" : undefined}
      data-blur={grouped ? "group" : blur === "none" ? "none" : undefined}
      data-shadow={shadow ? undefined : "false"}
      style={styleVars as CSSProperties}
      onPointerDown={(e: React.PointerEvent<HTMLDivElement>) => {
        if (interactive) press.bind.onPointerDown(e as never);
        onPointerDown?.(e);
      }}
      {...rest}
    >
      {children}
    </Tag>
  );
}

// ───────────────────────── adaptive veil ─────────────────────────

function useAdaptiveVeil(ref: RefObject<HTMLElement | null>, enabled: boolean) {
  const theme = useTierValue("theme");
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !enabled) return;
    const measure = () => {
      const d = getDeviceRect();
      const b = el.getBoundingClientRect();
      const v = veilFor({ left: b.left - d.left, top: b.top - d.top, width: b.width, height: b.height }, d, theme === "dark");
      el.style.setProperty("--veil", v.toFixed(3));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    window.addEventListener("resize", measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [ref, enabled, theme]);
}

// ───────────────────────── BlurGroup: one backdrop-filter per bar group ─────────────────────────

interface Member {
  el: HTMLElement;
  radius: number;
}

export interface BlurGroupApi {
  add(m: Member): () => void;
  invalidate(): void;
  /** keep following member rects every frame for `ms` (during a morph or a press) */
  trackFor(ms: number): void;
}

export const BlurGroupContext = createContext<BlurGroupApi | null>(null);

/** Named groups ("top", "bottom") so screen-owned glass (the chat composer) can join the shell's bar blur. */
const named = new Map<string, { api: BlurGroupApi; host: HTMLElement }>();
const namedListeners = new Set<() => void>();
export function getNamedBlurGroup(name: string) {
  return named.get(name) ?? null;
}
export function onNamedBlurGroups(fn: () => void) {
  namedListeners.add(fn);
  return () => namedListeners.delete(fn);
}

/** Members animating their own shape call `useBlurGroup()?.trackFor(ms)` so the shared blur follows. */
export const useBlurGroup = () => useContext(BlurGroupContext);

function useBlurMember(ref: RefObject<HTMLElement | null>, radius: number, enabled: boolean) {
  const group = useContext(BlurGroupContext);
  useEffect(() => {
    const el = ref.current;
    if (!el || !group || !enabled) return;
    return group.add({ el, radius });
  }, [ref, group, radius, enabled]);
}

/**
 * <BlurGroup className="topbar"> holds several glass faces (`<Glass blur="group">`) and paints ONE backdrop-filter
 * layer clipped (clip-path: path()) to the union of their rounded rects, sized to their bounding box. Faces draw tint,
 * rim, lens band and shadow; the group draws the blur. The host must be positioned.
 */
export function BlurGroup({ children, className, style, ref, name }: { children: ReactNode; className?: string; style?: CSSProperties; ref?: Ref<HTMLDivElement>; name?: string }) {
  const host = useRef<HTMLDivElement | null>(null);
  const layer = useRef<HTMLDivElement | null>(null);
  const members = useRef(new Set<Member>());
  const raf = useRef(0);
  const until = useRef(0);
  const lastPath = useRef("");

  const update = useCallback(() => {
    const h = host.current;
    const l = layer.current;
    if (!h || !l) return;
    const hb = h.getBoundingClientRect();
    const hs = h.offsetWidth ? hb.width / h.offsetWidth : 1;
    const rects: { x: number; y: number; w: number; h: number; r: number }[] = [];
    for (const m of members.current) {
      if (!m.el.isConnected) continue;
      const b = m.el.getBoundingClientRect();
      if (b.width < 1 || b.height < 1) continue;
      const ms = m.el.offsetHeight ? b.height / m.el.offsetHeight : 1;
      rects.push({ x: (b.left - hb.left) / hs, y: (b.top - hb.top) / hs, w: b.width / hs, h: b.height / hs, r: (m.radius * ms) / hs });
    }
    if (!rects.length) {
      l.style.display = "none";
      return;
    }
    const minX = Math.floor(Math.min(...rects.map((r) => r.x)));
    const minY = Math.floor(Math.min(...rects.map((r) => r.y)));
    const maxX = Math.ceil(Math.max(...rects.map((r) => r.x + r.w)));
    const maxY = Math.ceil(Math.max(...rects.map((r) => r.y + r.h)));
    const path = rects.map((r) => roundedRectPath(r.x - minX, r.y - minY, r.w, r.h, r.r)).join("");
    const key = `${minX},${minY},${maxX},${maxY}|${path}`;
    if (key === lastPath.current) return;
    lastPath.current = key;
    l.style.display = "";
    l.style.transform = `translate(${minX}px, ${minY}px)`;
    l.style.width = `${maxX - minX}px`;
    l.style.height = `${maxY - minY}px`;
    l.style.clipPath = `path("${path}")`;
    (l.style as CSSStyleDeclaration & { webkitClipPath?: string }).webkitClipPath = `path("${path}")`;
  }, []);

  const loop = useCallback(() => {
    update();
    if (performance.now() < until.current) raf.current = requestAnimationFrame(loop);
    else raf.current = 0;
  }, [update]);

  const api = useMemo<BlurGroupApi>(() => {
    let ro: ResizeObserver | null = null;
    return {
      add(m) {
        members.current.add(m);
        // placed inside the observer's callback (after layout, before paint): the frame that resized a member already
        // draws the layer at its new rect, instead of one frame at the old one
        ro ??= new ResizeObserver(() => update());
        ro.observe(m.el);
        api.invalidate();
        return () => {
          members.current.delete(m);
          ro?.unobserve(m.el);
          api.invalidate();
        };
      },
      invalidate() {
        if (raf.current) return;
        raf.current = requestAnimationFrame(loop);
      },
      trackFor(ms) {
        until.current = Math.max(until.current, performance.now() + ms);
        if (!raf.current) raf.current = requestAnimationFrame(loop);
      },
    };
  }, [loop, update]);

  // The layer is placed from the host's top-left. The host can grow around members that keep their size: the
  // "새 메시지" capsule joins the bottom bar above the composer, the bar grows 54 px upward, and every member's
  // offset from the host's top changes while no member resizes. So the host is observed too.
  useEffect(() => {
    const h = host.current;
    if (!h) return;
    const ro = new ResizeObserver(() => update());
    ro.observe(h);
    return () => ro.disconnect();
  }, [update]);

  useEffect(() => {
    if (!name || !host.current) return;
    named.set(name, { api, host: host.current });
    namedListeners.forEach((l) => l());
    return () => {
      if (named.get(name)?.api === api) named.delete(name);
      namedListeners.forEach((l) => l());
    };
  }, [name, api]);

  useEffect(() => {
    const onResize = () => api.invalidate();
    window.addEventListener("resize", onResize);
    // first layout + fonts settle
    api.trackFor(400);
    return () => {
      window.removeEventListener("resize", onResize);
      cancelAnimationFrame(raf.current);
    };
  }, [api]);

  const setHost = useCallback(
    (el: HTMLDivElement | null) => {
      host.current = el;
      if (typeof ref === "function") ref(el);
      else if (ref && typeof ref === "object") (ref as { current: HTMLDivElement | null }).current = el;
    },
    [ref],
  );

  return (
    <BlurGroupContext.Provider value={api}>
      <div ref={setHost} className={`blur-group${className ? ` ${className}` : ""}`} style={style}>
        <div ref={layer} className="blur-layer" aria-hidden="true" />
        {children}
      </div>
    </BlurGroupContext.Provider>
  );
}
