import { createContext, useContext, useLayoutEffect, useRef, type CSSProperties, type ReactNode, type RefObject } from "react";
import { readScroll, saveScroll } from "./nav";
import "./Screen.css";

/**
 * The scroll container every screen renders into. It clears the floating chrome (top bar above, tab bar — and the
 * composer slot when `composer` — below), applies the scroll edge effect, remembers its scroll per route, and flags
 * `data-scrolled` once content is under the top bar (LargeTitle hands its words to the bar then).
 * Scroll edge effect, top: content thins out as it passes under the bar (a mask on the scroller) AND, once the list
 * has scrolled 24 px, a masked blur strip fades in over it — a sibling of the scroller, so it sits above the content
 * and below the shell's top bar. Nothing under the capsules reads at full contrast. Bottom: the mask alone.
 * Reduced transparency / increased contrast: no mask, opaque `--bg` bands with a hairline instead: the edge under the
 * top bar, and the floor from the screen's bottom to 6 px above the composer (or the tab bar), so nothing shows in
 * the gap between composer and tab bar, beside them or below the tab bar.
 *   <Screen routeKey={route.key}><LargeTitle title="둘러보기" /> …</Screen>
 */
const ScrollerContext = createContext<RefObject<HTMLDivElement | null> | null>(null);
export const useScroller = () => useContext(ScrollerContext);

export function Screen({
  children,
  routeKey,
  composer,
  className,
  style,
  gutter = true,
}: {
  children: ReactNode;
  routeKey?: string;
  /** leave room for a composer above the tab bar */
  composer?: boolean;
  className?: string;
  style?: CSSProperties;
  gutter?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const sentinel = useRef<HTMLDivElement>(null);
  const edgeSentinel = useRef<HTMLDivElement>(null);
  const edge = useRef<HTMLDivElement>(null);
  const floor = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !routeKey) return;
    el.scrollTop = readScroll(routeKey);
    return () => {
      saveScroll(routeKey, el.scrollTop);
    };
  }, [routeKey]);

  useLayoutEffect(() => {
    const el = ref.current;
    const s = sentinel.current;
    const es = edgeSentinel.current;
    const strip = edge.current;
    if (!el || !s || !es || !strip) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.target === s) el.toggleAttribute("data-scrolled", !e.isIntersecting);
          else strip.toggleAttribute("data-on", !e.isIntersecting);
        }
      },
      { root: el, threshold: 0 },
    );
    io.observe(s);
    io.observe(es);
    return () => io.disconnect();
  }, []);

  // The floor's height is the scroller's --edge-bottom. A chat screen sets that on the scroller as its composer grows,
  // and a sibling does not inherit it, so it is copied over. Mutation records are delivered before the frame is drawn.
  useLayoutEffect(() => {
    const el = ref.current;
    const f = floor.current;
    if (!el || !f) return;
    const copy = () => {
      const v = el.style.getPropertyValue("--edge-bottom");
      if (v) f.style.setProperty("--edge-bottom", v);
      else f.style.removeProperty("--edge-bottom");
    };
    copy();
    const mo = new MutationObserver(copy);
    mo.observe(el, { attributes: true, attributeFilter: ["style"] });
    return () => mo.disconnect();
  }, []);

  return (
    <ScrollerContext.Provider value={ref}>
      <div ref={ref} className={`screen-scroll${composer ? " has-composer" : ""}${gutter ? " gutter" : ""}${className ? ` ${className}` : ""}`} style={style}>
        <div ref={sentinel} className="screen-sentinel" aria-hidden="true" />
        <div ref={edgeSentinel} className="screen-sentinel screen-sentinel-edge" aria-hidden="true" />
        {children}
      </div>
      <div ref={edge} className="screen-edge" aria-hidden="true" />
      <div ref={floor} className={`screen-floor${composer ? " has-composer" : ""}`} aria-hidden="true" />
    </ScrollerContext.Provider>
  );
}
