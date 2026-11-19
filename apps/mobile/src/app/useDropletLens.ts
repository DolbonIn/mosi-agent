import { useCallback, useEffect, useRef, type RefObject } from "react";
import type { MotionValue } from "framer-motion";
import { useTier } from "../motion/tier";
import { afterStartupEffects } from "./startup";

/**
 * liquid-glass-js (npm 0.1.0, eamonliu) as the tab droplet's magnifying lens (MOTION-SPEC §1): convexity +1 over a
 * clone of the icon row, so what passes under the droplet magnifies. It appears only while the droplet moves (a drag
 * or a travel) and fades when it lands, so resting icons stay crisp. Loaded lazily (own chunk, once startup is over — app/startup.ts) and only
 * when effects are live and neither motion nor transparency is reduced. The lens is position:fixed in screen px
 * (appended to <body> by the library), follows the droplet's edges and re-clones when the springs settle. Hidden
 * while a modal overlay is open (html[data-overlay], TabBar.css).
 * Returns `setDragging(on)` so a drag can keep it visible while the edges are held still under the finger.
 */
export function useDropletLens(
  rowRef: RefObject<HTMLElement | null>,
  dropRef: RefObject<HTMLElement | null>,
  left: MotionValue<number>,
  right: MotionValue<number>,
  radius: number,
  version: string,
): (on: boolean) => void {
  const tier = useTier();
  const allowed = tier.effects === "live" && !tier.reduceTransparency && !tier.reduceMotion;
  const dragging = useRef(false);
  const show = useRef<(on: boolean) => void>(() => {});

  useEffect(() => {
    const row = rowRef.current;
    const drop = dropRef.current;
    if (!row || !drop || !allowed) return;
    let cancelled = false;
    let lens: import("liquid-glass-js").LiquidGlass | null = null;
    const offs: (() => void)[] = [];
    let els: HTMLElement[] = [];
    let hideTimer = 0;
    void afterStartupEffects().then(() => {
      if (cancelled) return;
      void import("liquid-glass-js").then(({ LiquidGlass }) => {
        if (cancelled || !row.isConnected || !drop.isConnected) return;
        const b = drop.getBoundingClientRect();
        const lw = Math.round(drop.offsetWidth || b.width);
        const lh = Math.round(drop.offsetHeight || b.height);
        if (lw < 4 || lh < 4) return;
        lens = new LiquidGlass({
          background: row,
          width: lw,
          height: lh,
          radius,
          scale: 10,
          depth: 10,
          curvature: 4,
          convexity: 1,
          chroma: 0.08,
          blur: 0,
          glow: 0,
          edge: 0.5,
          specAngle: 135,
          tint: 0,
          tintColor: "#ffffff",
          draggable: false,
          zIndex: 30,
          x: b.left,
          y: b.top,
        });
        // the clone duplicates the tab buttons: keep it out of the accessibility tree and the tab order
        const inst = lens as unknown as Record<string, HTMLElement | undefined>;
        els = [inst.lensEl, inst.glassEl].filter((el): el is HTMLElement => !!el);
        for (const el of els) {
          el.classList.add("lqg-tab");
          el.setAttribute("aria-hidden", "true");
          el.inert = true;
        }
        // …and drop the cloned ids (duplicate #tab-* ids break getElementById / locators); again after every re-clone
        const stripIds = () => {
          for (const el of els) el.querySelectorAll("[id]").forEach((n) => n.removeAttribute("id"));
        };
        stripIds();
        const idWatch = new MutationObserver(stripIds);
        for (const el of els) idWatch.observe(el, { childList: true, subtree: true, attributeFilter: ["id"] });
        // position from the edge motion values (a "change" event fires before framer writes the transform, so the
        // droplet's DOM rect would lag one frame behind); the droplet is centred vertically in the row
        const place = () => {
          const rb = row.getBoundingClientRect();
          const cx = rb.left + (left.get() + right.get()) / 2;
          const cy = rb.top + rb.height / 2;
          lens?.moveTo(cx - lw / 2, cy - lh / 2);
        };
        const setActive = (on: boolean) => {
          window.clearTimeout(hideTimer);
          if (on) {
            place();
            for (const el of els) el.dataset.active = "";
          } else {
            hideTimer = window.setTimeout(() => {
              for (const el of els) delete el.dataset.active;
              // re-clone once hidden so the next pass shows the current selection
              window.setTimeout(() => {
                if (!dragging.current) {
                  lens?.refresh();
                  place();
                }
              }, 260);
            }, 60);
          }
        };
        show.current = setActive;
        const onChange = () => {
          if (dragging.current || left.isAnimating() || right.isAnimating()) {
            if (!els[0]?.hasAttribute("data-active")) setActive(true);
            else place();
          }
        };
        // animationComplete is notified before the value clears its animation, so check on the next frame (and keep
        // checking while a spring is still running on the other edge)
        let doneRaf = 0;
        const onDone = () => {
          cancelAnimationFrame(doneRaf);
          doneRaf = requestAnimationFrame(function check() {
            if (dragging.current) return;
            if (left.isAnimating() || right.isAnimating()) {
              doneRaf = requestAnimationFrame(check);
              return;
            }
            setActive(false);
          });
        };
        offs.push(() => cancelAnimationFrame(doneRaf), () => idWatch.disconnect());
        offs.push(left.on("change", onChange), right.on("change", onChange), left.on("animationComplete", onDone), right.on("animationComplete", onDone));
        const onResize = () => {
          lens?.refresh();
          place();
        };
        window.addEventListener("resize", onResize);
        offs.push(() => window.removeEventListener("resize", onResize));
        lens.refresh();
        place();
      });
    });
    return () => {
      cancelled = true;
      window.clearTimeout(hideTimer);
      offs.forEach((off) => off());
      show.current = () => {};
      lens?.destroy();
      lens = null;
    };
  }, [rowRef, dropRef, left, right, radius, allowed, version]);

  return useCallback((on: boolean) => {
    dragging.current = on;
    // on release the settle spring that follows hides the lens when it lands (animationComplete)
    if (on) show.current(true);
  }, []);
}
