import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { getDeviceRect, getOverlayEl } from "../app/device";
import { SPRING } from "../motion/springs";
import { useTierValue } from "../motion/tier";
import { Button } from "../ui/Button";
import type { FrameLink } from "./HtmlFrame";

/**
 * A link tapped inside an HTML artifact never navigates anything by itself. This bar says where it goes:
 * "외부 사이트 열기 · <host>", the host as the URL parser gives it (an internationalised domain stays in its xn--
 * punycode form, so look-alike letters cannot pass for another site), then the whole URL. It opens only on 열기, as an
 * ordinary `target=_blank rel=noopener noreferrer` link, the way every other external link in the app opens. For a card
 * in the chat it floats just above the composer at the card's width, in the app's overlay layer: a card taller than
 * the screen has its bottom off screen or under the composer, and the question must be seen where the tap was. In the
 * full-screen sheet it is pinned to the sheet's bottom. Esc or 취소 dismisses it. Focus moves to the bar (read out as
 * the 링크 열기 dialog with its address; Tab reaches 취소 and 열기) and comes back where it was.
 */
export function LinkConfirm({ link, onDone, placement, anchor }: { link: FrameLink; onDone: () => void; placement: "card" | "sheet"; anchor?: HTMLElement | null }) {
  const reduce = useTierValue("reduceMotion");
  const bar = useRef<HTMLDivElement>(null);
  // URL.host is ASCII: a Unicode domain comes out as xn--…, never as the letters it imitates
  const url = new URL(link.href);
  // the parent re-renders while the bar is up (a height report, a theme change): keep the focus where it is
  const done = useRef(onDone);
  done.current = onDone;

  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        done.current();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      if (prev && prev !== document.body) prev.focus?.({ preventScroll: true });
    };
  }, []);
  // the card's bar: placed before it paints, again when the window changes size
  const [place, setPlace] = useState<CSSProperties | null>(null);
  useLayoutEffect(() => {
    if (placement !== "card" || !anchor) return;
    const update = () => setPlace(overCard(anchor));
    update();
    addEventListener("resize", update);
    return () => removeEventListener("resize", update);
  }, [placement, anchor]);
  // focus the bar when it comes up, and again when another link is tapped while it is up (the tap focused the frame)
  useEffect(() => {
    bar.current?.focus({ preventScroll: true });
  }, [link, place]);

  const floating = placement === "card" && !!anchor;
  if (floating && !place) return null;
  const node = (
    <AnimatePresence>
      <motion.div
        ref={bar}
        tabIndex={-1}
        className="hlink"
        data-placement={placement}
        style={floating ? place! : undefined}
        role="dialog"
        aria-modal="false"
        aria-label="링크 열기"
        initial={reduce ? false : { opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={reduce ? { duration: 0 } : SPRING.snap}
      >
        <p className="hlink-host">
          외부 사이트 열기 · <span className="hlink-domain">{url.host}</span>
        </p>
        <p className="hlink-url">{url.href}</p>
        <div className="hlink-actions">
          <Button tone="secondary" size="md" onClick={onDone}>
            취소
          </Button>
          <a
            className="btn hlink-open"
            data-tone="primary"
            data-variant="capsule"
            data-size="md"
            data-state="idle"
            href={link.href}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => window.setTimeout(onDone, 0)}
          >
            <span className="btn-label">열기</span>
          </a>
        </div>
      </motion.div>
    </AnimatePresence>
  );
  const layer = floating ? getOverlayEl() : null;
  return layer ? createPortal(node, layer) : node;
}

/** the card's width and left edge, its bottom just above where the chat's content rests (the composer's top, from the
 *  scroller's bottom padding), in the overlay layer's (the device's) coordinates */
function overCard(card: HTMLElement): CSSProperties {
  const c = card.getBoundingClientRect();
  const d = getDeviceRect();
  const sc = card.closest<HTMLElement>(".screen-scroll");
  let bottom = 16;
  if (sc) {
    const s = sc.getBoundingClientRect();
    const pad = parseFloat(getComputedStyle(sc).paddingBottom) || 0;
    bottom = d.bottom - s.bottom + Math.max(8, pad - 8);
  }
  return { left: c.left - d.left, width: c.width, bottom, top: "auto", right: "auto" };
}
