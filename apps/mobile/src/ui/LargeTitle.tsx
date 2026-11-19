import { motion } from "framer-motion";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { setCompactTitle } from "../app/topBarStore";
import { ContentSwap } from "../motion/ContentSwap";
import { SPRING } from "../motion/springs";
import { useScroller } from "../app/Screen";
import { useRouteActiveSource } from "../app/routeActive";
import { copy } from "./Text";
import "./LargeTitle.css";

/**
 * Large title (HIG toolbars / organic-motion §6): at the top the page shows its large title in the content; as it
 * scrolls under the floating top bar, the same words appear compact in the bar's centre capsule (content swap), and
 * hand back at the top. One IntersectionObserver, no scroll listener. `layoutId` lets a pushed screen's title morph
 * from the row label that opened it (shared element). Only the visible route claims the bar: a title on a hidden tab
 * or under a pushed screen releases it and re-claims from the sentinel's last state when it is shown again.
 *   <Screen><LargeTitle title="둘러보기" subtitle="요즘 많이 맡긴 일" /> …</Screen>
 * `swap`: the words change in place (a segment title, e.g. 저장된 로그인: 로그인 정보 ↔ 접근 기록) — they swap with ContentSwap (§3) inside
 * the same heading, no remount. Once the words differ from the ones it opened with, the heading lets go of `layoutId`
 * for good: a layout-tracked heading whose width changes would stretch its glyphs, and there is no row label left to
 * morph back into. The compact title in the bar follows the words (its own swap, §8.17).
 *   <LargeTitle swap title={TITLE[seg]} layoutId={route.titleLayoutId} />
 */
export function LargeTitle({
  title,
  subtitle,
  layoutId,
  accessory,
  className,
  swap,
}: {
  title: string;
  subtitle?: ReactNode;
  layoutId?: string;
  accessory?: ReactNode;
  className?: string;
  swap?: boolean;
}) {
  const owner = useId();
  const sentinel = useRef<HTMLDivElement>(null);
  const scroller = useScroller();
  const src = useRouteActiveSource(); // stable: a tab switch does not re-render this title
  const under = useRef(false); // the sentinel has scrolled under the bar
  const [opened] = useState(title);
  const [released, setReleased] = useState(false);
  if (swap && !released && title !== opened) setReleased(true); // during render: the same commit drops layoutId

  useEffect(() => {
    const s = sentinel.current;
    const root = scroller?.current ?? null;
    if (!s) return;
    const topClear = root ? parseFloat(getComputedStyle(root).paddingTop) || 112 : 112;
    const io = new IntersectionObserver(
      ([e]) => {
        under.current = !e!.isIntersecting;
        if (src.get()) setCompactTitle(owner, under.current ? title : null);
      },
      { root, threshold: 0, rootMargin: `-${Math.round(topClear - 14)}px 0px 0px 0px` },
    );
    io.observe(s);
    return () => {
      io.disconnect();
      setCompactTitle(owner, null);
    };
  }, [owner, title, scroller, src]);

  // shown again → re-claim from the last state; hidden → release
  useEffect(() => {
    const apply = () => setCompactTitle(owner, src.get() && under.current ? title : null);
    apply();
    return src.subscribe(apply);
  }, [src, owner, title]);

  return (
    <header className={`large-title${className ? ` ${className}` : ""}`}>
      <div className="large-title-row">
        <motion.h1 className="large-title-text" layoutId={released ? undefined : layoutId} transition={SPRING.morph}>
          {swap ? <ContentSwap swapKey={title}>{title}</ContentSwap> : title}
        </motion.h1>
        {accessory}
      </div>
      {subtitle && <p className="large-title-sub t-copy">{copy(subtitle)}</p>}
      <div ref={sentinel} className="large-title-sentinel" aria-hidden="true" />
    </header>
  );
}
