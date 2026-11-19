import { animate, motion, useMotionValue, useTransform, useVelocity } from "framer-motion";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { createStore, useStore } from "../lib/createStore";
import { createVelocityTracker, project, rubberBand } from "../motion/rubberBand";
import { EXIT, SPRING, springTo } from "../motion/springs";
import { getTier } from "../motion/tier";
import { getOverlayEl, setOverlay } from "../app/device";
import { Glass } from "./Glass";
import { Icon, type AppIconName } from "./Icon";
import { R } from "./geometry";
import "./Sheet.css";

/**
 * Sheet (MOTION-SPEC §3): morphs OUT of its source element — clip-path inset from the source rect/radius to the
 * r38 sheet (morph spring), content enters 60 ms later; the clip then opens past the box so the shadow blooms last.
 * Grabber 38×5; drag down to dismiss (1:1, rubber band upward, release projected 180 ms along the velocity, a
 * dismiss throw keeps its speed); Esc / backdrop / close button; focus trap + return focus; the shell is `inert`
 * (scroll lock); ONE sheet at a time; refuses to close while `busy` (a request in flight).
 * Close = the shape folds toward its source on `snap` (or slides down without one) while the whole sheet (panel +
 * scrim) dissolves in 160 ms ease-out; the sheet is gone (unmounted, shell interactive) as soon as it is invisible —
 * the fold's settle is never shown. The
 * source is hidden only while the sheet is open (the sheet IS its continuation) and is visible again on the first
 * frame of the close — at once, whatever transition the source has for its own states (showSource). The user rejected the old close, where the folded, emptied shape (title + ×) sat on top of the
 * source row for ~½ s while the spring settled ("창이 닫힌 채로 유지").
 * Reduced motion: appears / disappears; still follows the finger.
 *
 *   const [open, setOpen] = useState(false); const btn = useRef<HTMLButtonElement>(null);
 *   <Button ref={btn} onClick={() => setOpen(true)}>열기</Button>
 *   <Sheet open={open} onClose={() => setOpen(false)} source={btn} title="티켓 사용">…</Sheet>
 * or imperatively: presentSheet({ source: el, title, render: (s) => <Form onDone={s.close} /> })
 */
export type SheetSource = RefObject<HTMLElement | null> | HTMLElement | DOMRect | null | undefined;

export interface SheetProps {
  open: boolean;
  onClose: () => void;
  source?: SheetSource;
  title?: ReactNode;
  /** a request is in flight: Esc / backdrop / drag / close are refused */
  busy?: boolean;
  children: ReactNode;
  /** pinned under the scroll area (e.g. the primary capsule) */
  footer?: ReactNode;
  /** hide the source while the sheet is its continuation (default true) */
  hideSource?: boolean;
  /** "start": the title reads from the leading edge at title3, like a page heading (default: centred) */
  titleAlign?: "center" | "start";
  ariaLabel?: string;
  closeLabel?: string;
  /** after the exit animation */
  onClosed?: () => void;
  className?: string;
  /** the head's leading slot: a round back button built like the close plate (e.g. "이전 단계") */
  leading?: { label: string; onClick: () => void; icon?: AppIconName };
  /** dim what is behind (default true). false = an undimmed modal (iOS medium detent): the scrim still catches taps
   *  and the shell is still inert, it just draws nothing */
  dim?: boolean;
}

const REACH = 40;
/**
 * every close (×, scrim, Esc, programmatic, drag-dismiss): panel + scrim dissolve in 160 ms ease-out (most of it in the
 * first frames) and the sheet unmounts the moment it is invisible — no frame later than ~200 ms after the close shows
 * any of it (QA: foundation.spec "sheet close"). The fold / slide underneath is only the direction of the exit.
 */
const CLOSE_FADE = { duration: 0.16, ease: [0, 0, 0.2, 1] } as const;
const PANEL_R = R.sheet;

// one sheet at a time
let active: { id: string; close: () => void } | null = null;

function resolveSource(src: SheetSource): { rect: DOMRect; el: HTMLElement | null; radius: number } | null {
  if (!src) return null;
  let el: HTMLElement | null = null;
  let rect: DOMRect | null = null;
  if (src instanceof DOMRect) rect = src;
  else if (src instanceof HTMLElement) el = src;
  else if ("current" in src) el = src.current;
  if (el) {
    if (!el.isConnected) return null;
    rect = el.getBoundingClientRect();
  }
  if (!rect || rect.width < 1 || rect.height < 1) return null;
  if (rect.bottom < 0 || rect.top > innerHeight) return null;
  const radius = el ? parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0 : 12;
  return { rect, el, radius: Math.min(radius, rect.width / 2, rect.height / 2) };
}

/**
 * Hide or show a sheet's source at once. Its own CSS may transition opacity for its states (the top bar's agent dims
 * while pressed, `transition: opacity` 353 ms), and a plain inline change would then fade it out under the growing
 * sheet and back in after the close: a return that re-enters (MOTION-SPEC §1, user-rejected). The change lands with
 * its transitions off and its style flushed, then they are put back.
 */
function showSource(el: HTMLElement, shown: boolean) {
  const prev = el.style.transition;
  el.style.transition = "none";
  el.style.opacity = shown ? "" : "0";
  void getComputedStyle(el).opacity; // flush, so putting the transition back starts nothing
  el.style.transition = prev;
}

export function Sheet(props: SheetProps) {
  const [mounted, setMounted] = useState(props.open);
  // re-opened while the close animation was still playing → start a fresh instance when it finishes
  const [instance, setInstance] = useState(0);
  const openRef = useRef(props.open);
  openRef.current = props.open;
  useEffect(() => {
    if (props.open) setMounted(true);
  }, [props.open]);
  const target = getOverlayEl();
  if (!mounted || !target) return null;
  return createPortal(
    <SheetImpl
      key={instance}
      {...props}
      onExited={() => {
        if (openRef.current) setInstance((n) => n + 1);
        else setMounted(false);
        props.onClosed?.();
      }}
    />,
    target,
  );
}

interface Geo {
  inset: [number, number, number, number];
  radius: number;
  dy: number;
  height: number;
}

function SheetImpl({
  open,
  onClose,
  source,
  title,
  busy,
  children,
  footer,
  hideSource = true,
  titleAlign,
  ariaLabel,
  closeLabel = "닫기",
  className,
  leading,
  dim = true,
  onExited,
}: SheetProps & { onExited: () => void }) {
  const id = useId();
  const titleId = `${id}-title`;
  const panel = useRef<HTMLElement | null>(null);
  const root = useRef<HTMLDivElement | null>(null);
  const body = useRef<HTMLDivElement | null>(null);
  const geo = useRef<Geo | null>(null);
  const prevFocus = useRef<HTMLElement | null>(null);
  const srcEl = useRef<HTMLElement | null>(null);
  const dismissed = useRef(false);
  const closing = useRef(false);
  const viaSource = useRef(false);
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const [ready, setReady] = useState(false);
  const [interactive, setInteractive] = useState(false);

  const p = useMotionValue(-1); // morph progress (−1 = not measured yet)
  const drag = useMotionValue(0);
  const content = useMotionValue(0);
  const fade = useMotionValue(1); // whole-sheet opacity: dissolves on a source close
  const contentY = useTransform(content, (c) => (1 - c) * 8);
  const dragV = useVelocity(drag);
  const rim = useTransform(dragV, (v) => `${135 + Math.max(-25, Math.min(25, -v / 60))}deg`);

  const clipPath = useTransform(p, (raw) => {
    const g = geo.current;
    const v = Math.max(0, raw);
    if (!g) return "none";
    const k = Math.min(1, v / 0.92);
    const openPast = Math.max(0, Math.min(1, (v - 0.92) / 0.08));
    const ins = g.inset.map((s) => s * (1 - k) - REACH * openPast);
    const r = g.radius + (PANEL_R - g.radius) * k + REACH * openPast;
    return `inset(${ins.map((n) => `${n.toFixed(2)}px`).join(" ")} round ${r.toFixed(2)}px)`;
  });
  const y = useTransform<number, number>([p, drag], ([raw, d]) => {
    const g = geo.current;
    const v = Math.max(0, Math.min(1, raw));
    return (g ? g.dy * (1 - v) : 0) + d;
  });
  const scrim = useTransform<number, number>([p, drag, fade], ([raw, d, f]) => {
    const h = geo.current?.height || 600;
    return Math.max(0, Math.min(1, raw)) * (1 - Math.max(0, Math.min(1, d / h))) * f;
  });

  const requestClose = useCallback(() => {
    if (busyRef.current || closing.current) return;
    onCloseRef.current();
  }, []);

  // ── open: measure, register, focus ──
  useLayoutEffect(() => {
    const el = panel.current;
    if (!el) return;
    prevFocus.current = document.activeElement as HTMLElement | null;
    const box = el.getBoundingClientRect();
    const src = resolveSource(source);
    if (src && !getTier().reduceMotion) {
      // slide the box so the source lies inside it, then clip the box down to the source
      const r = src.rect;
      const dy = r.top < box.top ? r.top - box.top : r.bottom > box.bottom ? r.bottom - box.bottom : 0;
      const dx = r.left < box.left ? r.left - box.left : r.right > box.right ? r.right - box.right : 0;
      geo.current = {
        inset: [r.top - box.top - dy, box.right + dx - r.right, box.bottom + dy - r.bottom, r.left - box.left - dx].map((s) => Math.max(0, s)) as Geo["inset"],
        radius: src.radius,
        dy,
        height: box.height,
      };
      srcEl.current = src.el;
      viaSource.current = true;
    } else {
      geo.current = { inset: [0, 0, 0, 0], radius: PANEL_R, dy: getTier().reduceMotion ? 0 : box.height + 24, height: box.height };
      srcEl.current = src?.el ?? null;
    }
    p.set(0);
    setReady(true);
  }, []);

  useEffect(() => {
    if (!ready) return;
    const reduce = getTier().reduceMotion;
    if (hideSource && srcEl.current && viaSource.current) showSource(srcEl.current, false);
    setOverlay(`sheet:${id}`, true);
    if (active && active.id !== id) active.close();
    active = { id, close: () => onCloseRef.current() };
    if (reduce) {
      p.set(1);
      content.set(1);
    } else {
      springTo(p, 1, viaSource.current ? "morph" : "camera");
      animate(content, 1, { ...SPRING.fade, delay: 0.06 });
    }
    const t = setTimeout(() => setInteractive(true), reduce ? 0 : 220);
    // focus a field only when it asks for it ([autofocus] / [data-autofocus]); otherwise the dialog itself
    const first = panel.current?.querySelector<HTMLElement>("[autofocus], [data-autofocus]") ?? panel.current;
    first?.focus({ preventScroll: true });
    return () => clearTimeout(t);
  }, [ready]);

  const finish = useCallback(() => {
    if (srcEl.current) showSource(srcEl.current, true);
    setOverlay(`sheet:${id}`, false);
    if (active?.id === id) active = null;
    const back = prevFocus.current;
    if (back && back.isConnected) back.focus({ preventScroll: true });
    onExited();
  }, [id, onExited]);

  // ── close: content leaves; the shape folds toward its source while the sheet dissolves ──
  useEffect(() => {
    if (open || !ready || closing.current) return;
    closing.current = true;
    if (srcEl.current) showSource(srcEl.current, true);
    // the content underneath is live from the first close frame: taps go through, the shell is no longer inert
    if (root.current) root.current.style.pointerEvents = "none";
    setOverlay(`sheet:${id}`, false);
    if (getTier().reduceMotion) {
      finish();
      return;
    }
    if (dismissed.current) {
      // the drag already flung it down (that fling keeps going): dissolve and go
      animate(fade, 0, { ...CLOSE_FADE, onComplete: finish });
      return;
    }
    animate(content, 0, EXIT);
    const el = panel.current;
    const src = resolveSource(srcEl.current ?? source);
    if (el && src && geo.current) {
      const box = el.getBoundingClientRect();
      const cur = geo.current;
      const r = src.rect;
      const baseTop = box.top - cur.dy * (1 - Math.max(0, Math.min(1, p.get()))) - drag.get();
      const baseBottom = baseTop + box.height;
      const dy = r.top < baseTop ? r.top - baseTop : r.bottom > baseBottom ? r.bottom - baseBottom : 0;
      geo.current = {
        inset: [r.top - baseTop - dy, box.right - r.right, baseBottom + dy - r.bottom, r.left - box.left].map((s) => Math.max(0, s)) as Geo["inset"],
        radius: src.radius,
        dy: dy - drag.get(),
        height: box.height,
      };
      // fold toward the source (fast: snap, not the morph tail) and dissolve together; done when invisible
      springTo(p, 0, "snap");
    } else {
      const h = geo.current?.height ?? 600;
      animate(drag, h + 40, SPRING.camera);
    }
    animate(fade, 0, { ...CLOSE_FADE, onComplete: finish });
  }, [open, ready]);

  useEffect(
    () => () => {
      if (srcEl.current) showSource(srcEl.current, true);
      setOverlay(`sheet:${id}`, false);
      if (active?.id === id) active = null;
    },
    [id],
  );

  // ── scroll edges (Screen's top edge, Sheet.css): rows thin out over the 12 px under the head once the body has
  // scrolled, and over the 12 px at its end (above the footer) while more is below, so a cut row never sits as a hard
  // line against the head or the footer. Each ramps over the 12 px of scroll next to its end (it follows the finger, so
  // reduced motion keeps it): the first row at the top and the last row at the end are never thinned ──
  useEffect(() => {
    const b = body.current;
    const pnl = panel.current;
    if (!b || !pnl) return;
    let lastTop = -1;
    let lastEnd = -1;
    const from = (k: number) => `rgb(0 0 0 / ${Math.round((1 - k) * 1000) / 1000})`;
    const update = () => {
      const top = Math.min(1, Math.max(0, b.scrollTop) / 12);
      const rest = b.scrollHeight - b.clientHeight - b.scrollTop;
      const end = rest <= 1 ? 0 : Math.min(1, rest / 12);
      if (top !== lastTop) {
        lastTop = top;
        pnl.toggleAttribute("data-scrolled", top > 0);
        b.style.setProperty("--edge-from", from(top));
      }
      if (end !== lastEnd) {
        lastEnd = end;
        pnl.toggleAttribute("data-more", end > 0);
        b.style.setProperty("--edge-to", from(end));
      }
    };
    update();
    b.addEventListener("scroll", update, { passive: true });
    // what is below changes with sizes too: rows arriving, a field or an error line growing, the sheet resizing
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    const watch = () => {
      if (!ro) return;
      ro.disconnect();
      ro.observe(b);
      for (const c of b.children) ro.observe(c);
    };
    watch();
    const mo = typeof MutationObserver === "undefined" ? null : new MutationObserver(() => (watch(), update()));
    mo?.observe(b, { childList: true });
    return () => {
      b.removeEventListener("scroll", update);
      ro?.disconnect();
      mo?.disconnect();
    };
  }, []);

  // ── drag to dismiss (grabber + header always; the body when it does not scroll) ──
  const session = useRef<{ pid: number; start: number; base: number; moved: boolean; vt: ReturnType<typeof createVelocityTracker> } | null>(null);
  const onPointerDown = (e: ReactPointerEvent<HTMLElement>) => {
    if (!e.isPrimary || (e.pointerType === "mouse" && e.button !== 0)) return;
    const target = e.target as HTMLElement;
    if (target.closest("button, a, input, textarea, select, [role=slider], [role=switch], [data-no-drag]") && !target.closest(".sheet-grabber")) return;
    const b = body.current;
    const inBody = b?.contains(target);
    if (inBody && b && (b.scrollHeight > b.clientHeight + 1 || b.scrollTop > 0)) return;
    drag.stop();
    session.current = { pid: e.pointerId, start: e.clientY, base: drag.get(), moved: false, vt: createVelocityTracker() };
    session.current.vt.push(drag.get(), e.timeStamp);
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLElement>) => {
    const s = session.current;
    if (!s || e.pointerId !== s.pid) return;
    const delta = e.clientY - s.start;
    if (!s.moved && Math.abs(delta) < 3) return;
    if (!s.moved) {
      s.moved = true;
      try {
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    }
    const raw = s.base + delta;
    const value = raw >= 0 ? raw : rubberBand(raw, 60);
    drag.set(value);
    s.vt.push(value, e.timeStamp);
  };
  const onPointerUp = (e: ReactPointerEvent<HTMLElement>) => {
    const s = session.current;
    if (!s || e.pointerId !== s.pid) return;
    session.current = null;
    if (!s.moved) return;
    const v = s.vt.velocity(e.timeStamp);
    const h = geo.current?.height ?? 600;
    const value = drag.get();
    const go = e.type !== "pointercancel" && !busyRef.current && (project(value, v) > h * 0.45 || v > 900);
    if (go) {
      dismissed.current = true;
      if (getTier().reduceMotion) {
        drag.set(h + 40);
        onCloseRef.current();
        return;
      }
      // fling on; the close (dissolve + unmount) starts now, not when the fling settles
      animate(drag, h + 40, { ...SPRING.camera, velocity: Math.max(v, 400) } as never);
      onCloseRef.current();
    } else {
      springTo(drag, 0, "camera", { velocity: v });
    }
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLElement>) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      requestClose();
      return;
    }
    if (e.key !== "Tab" || !panel.current) return;
    const focusables = [...panel.current.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter(
      (el) => !el.hasAttribute("disabled") && el.offsetParent !== null,
    );
    if (!focusables.length) return;
    const first = focusables[0]!;
    const last = focusables[focusables.length - 1]!;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    <div ref={root} className="sheet-root" data-busy={busy || undefined}>
      <motion.div className="sheet-scrim" data-dim={dim ? undefined : "none"} style={{ opacity: scrim }} onClick={requestClose} aria-hidden="true" />
      <Glass
        ref={panel}
        sheet
        radius={PANEL_R}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        aria-label={title ? undefined : ariaLabel}
        aria-busy={busy || undefined}
        tabIndex={-1}
        data-title={titleAlign === "start" ? "start" : undefined}
        className={`sheet-panel${className ? ` ${className}` : ""}`}
        rim={rim}
        style={{ y, clipPath, opacity: fade, visibility: ready ? "visible" : "hidden" }}
        onKeyDown={onKeyDown}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <div className="sheet-head">
          <div className="sheet-grabber" aria-hidden="true" />
          {leading && (
            <button type="button" className="sheet-close sheet-leading" aria-label={leading.label} aria-disabled={busy || undefined} onClick={() => !busyRef.current && leading.onClick()}>
              <span className="sheet-close-plate">
                <Icon name={leading.icon ?? "chevron-left"} size={16} weight="semibold" />
              </span>
            </button>
          )}
          {title !== undefined && (
            <h2 id={titleId} className="sheet-title">
              {title}
            </h2>
          )}
          <button type="button" className="sheet-close" aria-label={closeLabel} aria-disabled={busy || undefined} onClick={requestClose}>
            <span className="sheet-close-plate">
              <Icon name="close" size={16} weight="semibold" />
            </span>
          </button>
        </div>
        <motion.div
          ref={body}
          className="sheet-body"
          style={{ opacity: content, y: contentY, pointerEvents: interactive ? undefined : "none" }}
        >
          {children}
        </motion.div>
        {footer && (
          <motion.div className="sheet-footer" style={{ opacity: content, pointerEvents: interactive ? undefined : "none" }}>
            {footer}
          </motion.div>
        )}
      </Glass>
    </div>
  );
}

// ───────────────────────── imperative host ─────────────────────────

export interface SheetApi {
  close(): void;
  setBusy(busy: boolean): void;
}

export interface PresentOptions {
  source?: SheetSource;
  title?: ReactNode;
  render: (api: SheetApi) => ReactNode;
  footer?: (api: SheetApi) => ReactNode;
  titleAlign?: "center" | "start";
  ariaLabel?: string;
  onClose?: () => void;
}

interface Presented {
  key: number;
  open: boolean;
  busy: boolean;
  opts: PresentOptions;
}

const hostStore = createStore<Presented[]>([]);
let seq = 0;

/** Present a sheet from anywhere (one at a time: a second call closes the first). Returns its api. */
export function presentSheet(opts: PresentOptions): SheetApi {
  const key = ++seq;
  const api: SheetApi = {
    close: () => {
      hostStore.set((list) => list.map((s) => (s.key === key ? { ...s, open: false } : s)));
      opts.onClose?.();
    },
    setBusy: (busy) => hostStore.set((list) => list.map((s) => (s.key === key ? { ...s, busy } : s))),
  };
  hostStore.set((list) => [...list.map((s) => ({ ...s, open: false })), { key, open: true, busy: false, opts }]);
  apis.set(key, api);
  return api;
}
const apis = new Map<number, SheetApi>();

/** Mount once inside the Shell. Renders sheets opened with presentSheet(). */
export function SheetHost() {
  const list = useStore(hostStore);
  return (
    <>
      {list.map((s) => {
        const api = apis.get(s.key)!;
        return (
          <Sheet
            key={s.key}
            open={s.open}
            busy={s.busy}
            source={s.opts.source}
            title={s.opts.title}
            ariaLabel={s.opts.ariaLabel}
            onClose={api.close}
            footer={s.opts.footer?.(api)}
            titleAlign={s.opts.titleAlign}
            onClosed={() => {
              hostStore.set((l) => l.filter((x) => x.key !== s.key));
              apis.delete(s.key);
            }}
          >
            {s.opts.render(api)}
          </Sheet>
        );
      })}
    </>
  );
}
