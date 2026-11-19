import { animate, motion, useMotionValue, useTransform } from "framer-motion";
import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { createVelocityTracker, rubberBand } from "../motion/rubberBand";
import { EXIT, SPRING, springTo } from "../motion/springs";
import { getTier } from "../motion/tier";
import { Glass } from "../ui/Glass";
import { R } from "../ui/geometry";
import { Icon } from "../ui/Icon";
import { copy } from "../ui/Text";
import { island, useIsland, type IslandBanner } from "./island";
import "./BannerHost.css";

/**
 * Banner (MOTION-SPEC §5, §8.13): the island drops DOWN into a glass banner that rests just below the top bar — the
 * island's pill travels down (morph spring) while it grows into the banner by a clip-path, and a black ink layer fades,
 * so the material turns from island-black into glass; content enters 60 ms later, and only once the box has nearly
 * cleared the top bar (never text over the bar). It holds 1.5 s + 60 ms × characters
 * (2–4 s; paused while a mouse or pen rests on it, while it is dragged or focused — 8 s at most in all,
 * island.BANNER_CAP_MS; a resting finger never pauses it), then contracts back into the island. Reduced motion: a fade
 * in place. One at a time, queued (island.ts).
 * Error banners (tone "error", role=alert) contract into a red DOT at the island instead, which then fades.
 * An `action` is a neutral button on the right. The 5 s 실행 취소 of island.undo is not a banner: it is an UndoToast at
 * the bottom, above the composer and tab bar, so it never covers the top bar's menu and title.
 * Swipe up dismisses (1:1, rubber band downward); tap runs onPress; a tap anywhere else dismisses it and still lands
 * (it never takes a tap meant for something else). It rests BELOW the top bar, never over it: 뒤로 / 메뉴 and the
 * title stay visible and usable while it shows (the lead's rule, 2026-11-12 — a banner dropped over the bar took the
 * taps meant for 뒤로). The only transient third backdrop-filter.
 *   island.banner({ icon: "bell", title: "결제 승인이 필요해요", body: "쿠팡 · 32,400원", onPress })
 */
const SIDE = 10;
// the body's narrowest line in em (320 px, text size 130 %): 212 px = 10.9 em, beside 실행 취소 100 px = 5.1 em. copy()
// ties nothing wider, so the 2-line clamp shows two lines (it counts a tie that wraps inside as one)
const BODY_EM = 10;
const BODY_EM_ACTION = 5;
const ISLAND = { top: 11, w: 126, h: 37 };
const DOT = { top: ISLAND.top + ISLAND.h / 2 - 5, w: 10, h: 10 };

export function BannerHost() {
  const banner = useIsland((s) => s.banner);
  const [shown, setShown] = useState<IslandBanner | null>(banner);
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    if (banner && (!shown || banner.id === shown.id)) {
      setShown(banner);
      setLeaving(false);
    } else if (banner && shown && banner.id !== shown.id) {
      setShown(banner);
      setLeaving(false);
    } else if (!banner && shown) {
      setLeaving(true);
    }
  }, [banner]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!shown) return null;
  // a leave that finishes after the next banner took over (undo → 예약을 취소했어요, or a banner → the queued undo) must
  // not clear that next one: only the banner that left is cleared
  const id = shown.id;
  const gone = () => setShown((s) => (s?.id === id ? null : s));
  if (shown.kind === "undo") return <UndoToast key={id} banner={shown} leaving={leaving} onGone={gone} />;
  return <Banner key={id} banner={shown} leaving={leaving} onGone={gone} />;
}

function Banner({ banner, leaving, onGone }: { banner: IslandBanner; leaving: boolean; onGone: () => void }) {
  const box = useRef<HTMLElement | null>(null);
  const anchor = useRef<HTMLDivElement | null>(null);
  /** the banner's resting box; `top` in the overlay's frame, the same frame as the island's rect */
  const [size, setSize] = useState<{ w: number; h: number; top: number } | null>(null);
  // reduced motion: in place from the first frame (never one frame of the pill up at the island)
  const [still] = useState(() => getTier().reduceMotion);
  const p = useMotionValue(still ? 1 : 0);
  const content = useMotionValue(still ? 1 : 0);
  const dragY = useMotionValue(0);
  // reduced motion: a fade in place (no travel, no growth)
  const fade = useMotionValue(still ? 0 : 1);
  const error = banner.tone === "error";
  /** the shape it contracts into: the island pill, or a dot for errors (set at leave time) */
  const target = useRef(ISLAND);
  const vt = useRef(createVelocityTracker());
  const drag = useRef<{ pid: number; y0: number; moved: boolean } | null>(null);

  useLayoutEffect(() => {
    const el = box.current;
    if (el && anchor.current) setSize({ w: el.offsetWidth, h: el.offsetHeight, top: anchor.current.offsetTop });
  }, []);

  // a tap anywhere else dismisses it without taking the tap (capture: before the target's own handlers run)
  useEffect(() => {
    if (leaving) return;
    const outside = (e: PointerEvent) => {
      if (!e.isPrimary || (e.target instanceof Node && box.current?.contains(e.target))) return;
      island.dismissBanner(banner.id);
    };
    window.addEventListener("pointerdown", outside, { capture: true, passive: true });
    return () => window.removeEventListener("pointerdown", outside, { capture: true });
  }, [leaving, banner.id]);

  useEffect(() => {
    if (!size) return;
    if (still) {
      animate(fade, 1, SPRING.fade);
      return;
    }
    springTo(p, 1, "morph");
    animate(content, 1, { ...SPRING.fade, delay: 0.06 });
  }, [size, p, content, fade, still]);

  useEffect(() => {
    if (!leaving) return;
    if (still) {
      animate(fade, 0, { ...EXIT, onComplete: onGone });
      return;
    }
    animate(content, 0, EXIT);
    if (error) target.current = DOT;
    const t = setTimeout(() => {
      springTo(dragY, 0, "morph");
      springTo(p, 0, "morph", {
        onComplete: error ? () => void animate(fade, 0, { ...EXIT, onComplete: onGone }) : onGone,
      });
    }, 80);
    return () => clearTimeout(t);
  }, [leaving]); // eslint-disable-line react-hooks/exhaustive-deps

  // p 0 → 1: the island's pill (at the box's top centre) grows into the box while the box travels from the island's
  // height down to its resting place below the top bar; leaving plays it back (into a dot for errors)
  const clipPath = useTransform(p, (v) => {
    if (!size) return "inset(0 round 36px)";
    const k = Math.max(0, Math.min(1.03, v));
    const to = target.current;
    const fromL = (size.w - to.w) / 2;
    const ins = [0, fromL, size.h - to.h, fromL].map((s) => Math.max(0, s * (1 - k)));
    const r = to.h / 2 + (Math.min(36, size.h / 2) - to.h / 2) * Math.min(1, k);
    return `inset(${ins.map((n) => `${n.toFixed(2)}px`).join(" ")} round ${r.toFixed(2)}px)`;
  });
  const y = useTransform([p, dragY], ([v, d]) => {
    const travel = size ? (1 - Math.max(0, Math.min(1.03, v as number))) * (target.current.top - size.top) : 0;
    return travel + (d as number);
  });
  const ink = useTransform(p, [0, 0.55], [1, 0]);
  const contentY = useTransform(content, (c) => (1 - c) * -6);
  // the text shows only once the box has (nearly) cleared the top bar: none while it is 16 px or more above its place
  // (its first line, 14 px padding + 8 px gap − 6 px entrance lift, would still be inside the bar's band), all of it
  // within 4 px, so the banner's text never crosses the bar on the way down (or up)
  const contentOpacity = useTransform([content, p], ([c, v]) => {
    const d = size ? (1 - Math.max(0, Math.min(1, v as number))) * Math.abs(size.top - target.current.top) : 0;
    return (c as number) * Math.max(0, Math.min(1, (16 - d) / 12));
  });

  const onPointerDown = (e: ReactPointerEvent<HTMLElement>) => {
    if (!e.isPrimary) return;
    drag.current = { pid: e.pointerId, y0: e.clientY, moved: false };
    vt.current.reset();
    // a mouse or pen pressing pauses the hold; a resting finger never does (only a finger that is dragging it)
    if (e.pointerType !== "touch") island.holdBanner(true);
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d || d.pid !== e.pointerId) return;
    const dy = e.clientY - d.y0;
    if (!d.moved && Math.abs(dy) < 4) return;
    if (!d.moved) {
      d.moved = true;
      e.currentTarget.setPointerCapture(e.pointerId);
      island.holdBanner(true);
    }
    const y = dy <= 0 ? dy : rubberBand(dy, 40);
    dragY.set(y);
    vt.current.push(y, e.timeStamp);
  };
  const onPointerUp = (e: ReactPointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d || d.pid !== e.pointerId) return;
    drag.current = null;
    if (!d.moved) {
      island.holdBanner(false);
      if (e.type === "pointerup" && banner.onPress) {
        banner.onPress();
        island.dismissBanner(banner.id, "action");
      }
      return;
    }
    const v = vt.current.velocity(e.timeStamp);
    if (dragY.get() < -28 || v < -350) {
      island.dismissBanner(banner.id);
    } else {
      island.holdBanner(false);
      springTo(dragY, 0, "snap", { velocity: v });
    }
  };

  return (
    <motion.div ref={anchor} className="banner-anchor" style={{ left: SIDE, right: SIDE, opacity: fade }}>
      <Glass
        ref={box}
        text
        radius={R.banner}
        className="banner"
        data-tone={banner.tone ?? "default"}
        role={error ? "alert" : "status"}
        style={{ clipPath, y, visibility: size ? "visible" : "hidden" }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerEnter={(e) => e.pointerType !== "touch" && island.holdBanner(true)}
        onPointerLeave={(e) => e.pointerType !== "touch" && !drag.current && island.holdBanner(false)}
        onFocus={() => island.holdBanner(true)}
        onBlur={() => island.holdBanner(false)}
      >
        <motion.span className="banner-ink" style={{ opacity: ink }} aria-hidden="true" />
        <motion.div className="banner-content" data-action={banner.action ? "" : undefined} style={{ opacity: contentOpacity, y: contentY }}>
          <span className="banner-icon">
            <Icon name={banner.icon} size={20} weight="medium" />
          </span>
          <span className="banner-text">
            <span className="banner-title-row">
              <span className="banner-title">{banner.title}</span>
              {!banner.action && <span className="banner-meta">{banner.meta ?? "지금"}</span>}
            </span>
            {banner.body && <span className="banner-body t-copy">{copy(banner.body, { clamp: banner.action ? BODY_EM_ACTION : BODY_EM })}</span>}
          </span>
          {banner.action && (
            <button
              type="button"
              className="banner-action"
              onPointerDown={(e) => e.stopPropagation()}
              onPointerUp={(e) => e.stopPropagation()}
              onClick={() => {
                const act = banner.action!;
                const r = act.run ? act.run() : act.onPress?.();
                if (r && typeof (r as Promise<void>).catch === "function") {
                  (r as Promise<void>).catch((err: unknown) => island.errorBanner(err instanceof Error ? err.message : "되돌리지 못했어요"));
                }
                island.dismissBanner(banner.id, "action");
              }}
            >
              {banner.action.label}
            </button>
          )}
        </motion.div>
      </Glass>
    </motion.div>
  );
}

// ───────────────────────────── undo toast ─────────────────────────────

const TOAST_GAP = 8;
/** no composer or tab bar on screen: the home-indicator band plus the gap */
const TOAST_FALLBACK = 28;

/** px from the overlay's bottom edge up to just above the composer / tab bar (whichever sits higher), plus the gap */
function toastBottom(anchor: HTMLElement | null): number {
  const host = anchor?.parentElement;
  const shell = document.getElementById("app-shell");
  if (!host || !shell) return TOAST_FALLBACK;
  let top = Infinity;
  for (const el of shell.querySelectorAll<HTMLElement>(".composer-wrap, .tabbar")) {
    const r = el.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) continue;
    // where it rests, not where its entrance (y 6 → 0) has it this frame
    const t = getComputedStyle(el).transform;
    top = Math.min(top, r.top - (t && t !== "none" ? new DOMMatrixReadOnly(t).m42 : 0));
  }
  if (top === Infinity) return TOAST_FALLBACK;
  return Math.max(TOAST_FALLBACK, Math.round(host.getBoundingClientRect().bottom - top + TOAST_GAP));
}

/**
 * Undo (MOTION-SPEC §8.13): a low-risk action that is already done (예약했어요, 보관했어요) offers 실행 취소 for 5 s.
 * The toast sits at the bottom, just above the composer and tab bar, in the thumb's reach and never over the top
 * bar's menu or title. It is glass, the transient third surface like a banner. It rises 16 → 0 px on `snap` while it
 * fades in on `fade`, and leaves with the exit fade (y +8). Swipe down dismisses it (1:1, rubber band upward). A finger,
 * the pointer or focus on it pauses the hold until all of them let go. It follows the composer on `snap` when that grows
 * or leaves; an open sheet covers it (z below the sheets), and so does the call card (z 35): under it the toast is
 * inert, its 5 s keep running (no hold, no extension), and one still in its time shows again as the card folds away.
 * Reduced motion: no rise and no travel.
 */
function UndoToast({ banner, leaving, onGone }: { banner: IslandBanner; leaving: boolean; onGone: () => void }) {
  const anchor = useRef<HTMLDivElement | null>(null);
  const bottom = useMotionValue(TOAST_FALLBACK);
  const [placed, setPlaced] = useState(false);
  const reduce = getTier().reduceMotion;
  const rise = useMotionValue(reduce ? 0 : 16);
  const dragY = useMotionValue(0);
  const opacity = useMotionValue(0);
  const y = useTransform([rise, dragY], ([a, b]) => (a as number) + (b as number));
  const vt = useRef(createVelocityTracker());
  const drag = useRef<{ pid: number; y0: number; moved: boolean } | null>(null);
  /** why the hold is paused (a finger, the mouse over it, focus): resumes only when none is left */
  const holds = useRef(new Set<string>());
  const fired = useRef(false);
  const hold = (why: string, on: boolean) => {
    const was = holds.current.size > 0;
    if (on) holds.current.add(why);
    else holds.current.delete(why);
    if (was !== holds.current.size > 0) island.holdBanner(!was);
  };

  // above the composer / tab bar, and it follows them: the composer grows a line or an attachment, or leaves on a pop
  useLayoutEffect(() => {
    let first = true;
    let raf = 0;
    const measure = () => {
      const b = toastBottom(anchor.current);
      if (first) {
        first = false;
        bottom.set(b);
        setPlaced(true);
      } else if (b !== bottom.get()) {
        if (reduce) bottom.set(b);
        else springTo(bottom, b, "snap");
      }
    };
    const soon = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(measure);
    };
    measure();
    const chrome = document.querySelector<HTMLElement>("#app-shell .bottom-chrome");
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(soon) : null;
    const watch = () => {
      if (!ro || !chrome) return;
      ro.disconnect();
      ro.observe(chrome);
      for (const el of chrome.querySelectorAll(".composer-wrap, .tabbar")) ro.observe(el);
    };
    watch();
    const mo =
      chrome && typeof MutationObserver !== "undefined"
        ? new MutationObserver(() => {
            watch();
            soon();
          })
        : null;
    if (mo && chrome) mo.observe(chrome, { childList: true, subtree: true });
    window.addEventListener("resize", soon);
    window.visualViewport?.addEventListener("resize", soon);
    return () => {
      cancelAnimationFrame(raf);
      ro?.disconnect();
      mo?.disconnect();
      window.removeEventListener("resize", soon);
      window.visualViewport?.removeEventListener("resize", soon);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // the full-screen call card covers it (call.css: z 35 over this anchor's 30). While a .call-card is in the overlay
  // layer (growing, open or folding away) the hidden toast is also inert: Tab never lands on its 실행 취소 under the
  // card (where Enter would undo unseen), and nothing it was holding keeps holding it there
  const [covered, setCovered] = useState(false);
  useLayoutEffect(() => {
    const layer = anchor.current?.parentElement;
    if (!layer || typeof MutationObserver === "undefined") return;
    const check = () => setCovered(!!layer.querySelector(":scope > .call-card"));
    check();
    const mo = new MutationObserver(check);
    mo.observe(layer, { childList: true });
    return () => mo.disconnect();
  }, []);
  // under the card its 5 s keep running: a resting mouse, a press or focus it had let go (WebKit sends no pointerleave
  // when the card appears under a still mouse, so the hover hold would last the whole call), and a toast still within
  // its time shows again as the card folds away above it
  useEffect(() => {
    if (!covered) return;
    if (drag.current) {
      drag.current = null;
      dragY.set(0);
    }
    if (holds.current.size) {
      holds.current.clear();
      island.holdBanner(false);
    }
  }, [covered]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!placed) return;
    if (reduce) {
      opacity.set(1);
      return;
    }
    springTo(rise, 0, "snap");
    animate(opacity, 1, SPRING.fade);
  }, [placed]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!leaving) return;
    // reduced motion keeps the fade (no travel): the toast stays under the finger for the exit, so a double tap's second
    // tap meets the spent 실행 취소 instead of the card's switch underneath
    const a = reduce ? null : animate(rise, 8, EXIT);
    const b = animate(opacity, 0, { ...EXIT, onComplete: onGone });
    return () => {
      a?.stop();
      b.stop();
    };
  }, [leaving]); // eslint-disable-line react-hooks/exhaustive-deps

  const onPointerDown = (e: ReactPointerEvent<HTMLElement>) => {
    if (!e.isPrimary) return;
    drag.current = { pid: e.pointerId, y0: e.clientY, moved: false };
    vt.current.reset();
    // captured from the start: a press that slides off the edge still ends here and releases its hold
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* the pointer is already gone */
    }
    hold("press", true);
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d || d.pid !== e.pointerId) return;
    const dy = e.clientY - d.y0;
    if (!d.moved && Math.abs(dy) < 4) return;
    d.moved = true;
    const v = dy >= 0 ? dy : rubberBand(dy, 40);
    dragY.set(v);
    vt.current.push(v, e.timeStamp);
  };
  const onPointerUp = (e: ReactPointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d || d.pid !== e.pointerId) return;
    drag.current = null;
    if (!d.moved) {
      hold("press", false);
      return;
    }
    const v = vt.current.velocity(e.timeStamp);
    if (dragY.get() > 28 || v > 350) {
      island.dismissBanner(banner.id);
    } else {
      hold("press", false);
      springTo(dragY, 0, "snap", { velocity: v });
    }
  };

  return (
    <motion.div
      ref={anchor}
      className="toast-anchor"
      data-covered={covered || undefined}
      inert={covered || undefined}
      style={{ left: SIDE, right: SIDE, bottom, visibility: placed ? "visible" : "hidden", pointerEvents: "none" }}
    >
      {/* the fade lives on the glass itself: a parent at opacity < 1 would become the backdrop root, and the blur would
          see nothing behind the toast while it fades */}
      <Glass
        text
        radius={R.banner}
        className="toast"
        role="status"
        aria-live="polite"
        style={{ opacity, y }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerEnter={(e) => e.pointerType === "mouse" && hold("hover", true)}
        onPointerLeave={(e) => e.pointerType === "mouse" && hold("hover", false)}
        onFocus={() => hold("focus", true)}
        onBlur={() => hold("focus", false)}
      >
        <div className="banner-content" data-action={banner.action ? "" : undefined}>
          <span className="banner-icon">
            <Icon name={banner.icon} size={20} weight="medium" />
          </span>
          <span className="banner-text">
            <span className="banner-title-row">
              <span className="banner-title">{banner.title}</span>
            </span>
            {banner.body && <span className="banner-body t-copy">{copy(banner.body, { clamp: banner.action ? BODY_EM_ACTION : BODY_EM })}</span>}
          </span>
          {banner.action && (
            <button
              type="button"
              className="banner-action"
              // a press on 실행 취소 pauses the hold too, so a tap that straddles the 5 s still undoes
              onPointerDown={(e) => {
                e.stopPropagation();
                hold("button", true);
              }}
              onPointerUp={() => hold("button", false)}
              onPointerCancel={() => hold("button", false)}
              onPointerLeave={() => hold("button", false)}
              onClick={() => {
                // once: a quick second tap during the leave must not undo twice (a second DELETE → 404 → an error banner)
                if (fired.current || leaving) return;
                fired.current = true;
                const act = banner.action!;
                const r = act.run ? act.run() : act.onPress?.();
                if (r && typeof (r as Promise<void>).catch === "function") {
                  (r as Promise<void>).catch((err: unknown) => island.errorBanner(err instanceof Error ? err.message : "되돌리지 못했어요"));
                }
                island.dismissBanner(banner.id, "action");
              }}
            >
              {banner.action.label}
            </button>
          )}
        </div>
      </Glass>
    </motion.div>
  );
}
