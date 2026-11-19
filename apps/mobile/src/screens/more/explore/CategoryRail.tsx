import type { TemplateCategory } from "@pickle/protocol";
import { motion } from "framer-motion";
import { useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { haptic } from "../../../motion/haptics";
import { useTwoEdge, type Edges } from "../../../motion/useTwoEdge";

/**
 * Category rail (MOTION-SPEC §6.4 + §3, draft B): categories are choices, so they are words (추천 · 전체 · 혜택 …), no
 * plates and no hues. The selection is a neutral vibrant droplet behind the word that travels by two edges (lead/trail:
 * it stretches toward the new word, then gathers to that word's width). Horizontal scroll with an edge fade when it
 * overflows; arrow keys / Home / End move the selection (roving tabindex). The label weight changes as it lands (CSS).
 * Each word is a 44 px target; the droplet draws 40 px inside it. 전체 is the client's own entry (every template).
 */
export function CategoryRail({ categories, value, onChange }: { categories: TemplateCategory[]; value: string; onChange: (id: string) => void }) {
  const scroller = useRef<HTMLDivElement>(null);
  const items = useRef<(HTMLButtonElement | null)[]>([]);
  const [cells, setCells] = useState<Edges[]>([]);
  const [fade, setFade] = useState<{ l: boolean; r: boolean }>({ l: false, r: true });
  const index = Math.max(0, categories.findIndex((c) => c.id === value));
  const edges = useTwoEdge(cells[index] ?? null);

  useLayoutEffect(() => {
    const measure = () => {
      setCells(items.current.slice(0, categories.length).map((el) => (el ? { left: el.offsetLeft, right: el.offsetLeft + el.offsetWidth } : { left: 0, right: 0 })));
      const sc = scroller.current;
      if (sc) setFade({ l: sc.scrollLeft > 4, r: sc.scrollLeft + sc.clientWidth < sc.scrollWidth - 4 });
    };
    measure();
    const ro = new ResizeObserver(measure);
    if (scroller.current) ro.observe(scroller.current);
    for (const el of items.current) if (el) ro.observe(el);
    return () => ro.disconnect();
  }, [categories]);

  // keep the selection in view (no smooth scroll under reduced motion: the browser honours the media query)
  useLayoutEffect(() => {
    const el = items.current[index];
    const sc = scroller.current;
    if (!el || !sc) return;
    const l = el.offsetLeft - 16;
    const r = el.offsetLeft + el.offsetWidth + 16;
    if (l < sc.scrollLeft) sc.scrollTo({ left: l, behavior: "smooth" });
    else if (r > sc.scrollLeft + sc.clientWidth) sc.scrollTo({ left: r - sc.clientWidth, behavior: "smooth" });
  }, [index]);

  const onScroll = () => {
    const sc = scroller.current;
    if (!sc) return;
    const l = sc.scrollLeft > 4;
    const r = sc.scrollLeft + sc.clientWidth < sc.scrollWidth - 4;
    if (l !== fade.l || r !== fade.r) setFade({ l, r });
  };

  const select = (i: number) => {
    const c = categories[Math.max(0, Math.min(categories.length - 1, i))];
    if (!c || c.id === value) return;
    haptic("selection");
    onChange(c.id);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const keys: Record<string, number> = { ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: categories.length - 1 };
    if (!(e.key in keys)) return;
    e.preventDefault();
    const next = Math.max(0, Math.min(categories.length - 1, keys[e.key]!));
    select(next);
    items.current[next]?.focus();
  };

  return (
    <div className="cat-rail" data-fade-l={fade.l || undefined} data-fade-r={fade.r || undefined}>
      <div ref={scroller} className="cat-scroll" role="tablist" aria-label="카테고리" onKeyDown={onKeyDown} onScroll={onScroll}>
        <div className="cat-track">
          {cells.length > 0 && <motion.span className="cat-droplet" aria-hidden="true" style={{ x: edges.left, width: edges.width }} />}
          {categories.map((c, i) => {
            const on = i === index;
            return (
              <button
                key={c.id}
                ref={(el) => {
                  items.current[i] = el;
                }}
                type="button"
                role="tab"
                aria-selected={on}
                tabIndex={on ? 0 : -1}
                className="cat-item"
                data-cat={c.id}
                data-on={on || undefined}
                onClick={() => select(i)}
              >
                {/* the bold twin (::after, hidden) holds the width, so the weight change never nudges the row */}
                <span className="cat-label" data-text={c.title}>
                  {c.title}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
