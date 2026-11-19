import { motion } from "framer-motion";
import { useCallback, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { ContentSwap } from "../motion/ContentSwap";
import { haptic } from "../motion/haptics";
import { createVelocityTracker, project, rubberClamp } from "../motion/rubberBand";
import { springTo } from "../motion/springs";
import { useTwoEdge, type Edges } from "../motion/useTwoEdge";
import { useMotionValue } from "framer-motion";
import { Icon, type AppIconName } from "./Icon";
import "./SegmentedControl.css";

/**
 * Segmented control (MOTION-SPEC §3 two-edge indicator; HIG ≤ 5 segments on iPhone, equal widths, nouns).
 * 44px track (r22) on --fill, raised 38px thumb (r19) — a vibrant solid, never a second glass. The thumb travels by
 * two edges (lead/trail); dragging it scrubs 1:1 with a rubber band at the ends and settles to the nearest segment
 * (projected by velocity). Labels change weight as the thumb lands. Arrow keys / Home / End move the selection.
 * role "tablist" (switching panels — pair with <SegmentedPanels>) or "radiogroup" (a setting).
 */
export interface SegmentOption<T extends string> {
  value: T;
  label: string;
  icon?: AppIconName;
}

export interface SegmentedControlProps<T extends string> {
  options: SegmentOption<T>[];
  value: T;
  onChange: (value: T) => void;
  label: string;
  role?: "tablist" | "radiogroup";
  size?: "md" | "sm";
  className?: string;
  /** id prefix used to link tabs ↔ panels (aria-controls) */
  idBase?: string;
}

const PAD = 3; // track 44 − thumb 38 = 6 → 3 each side (r22 − 3 = r19, concentric)

export function SegmentedControl<T extends string>({ options, value, onChange, label, role = "tablist", size = "md", className, idBase }: SegmentedControlProps<T>) {
  const track = useRef<HTMLDivElement>(null);
  const [cells, setCells] = useState<Edges[]>([]);
  const index = Math.max(0, options.findIndex((o) => o.value === value));
  const target = cells[index] ?? null;
  const edges = useTwoEdge(target);
  const lift = useMotionValue(1);
  const vt = useRef(createVelocityTracker());
  const dragging = useRef<{ pid: number; startX: number; baseL: number; w: number; moved: boolean } | null>(null);

  useLayoutEffect(() => {
    const el = track.current;
    if (!el) return;
    const measure = () => {
      const w = el.clientWidth - PAD * 2;
      const n = options.length;
      const cw = w / n;
      setCells(options.map((_, i) => ({ left: PAD + i * cw, right: PAD + (i + 1) * cw })));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [options]);

  const select = useCallback(
    (i: number) => {
      const o = options[Math.max(0, Math.min(options.length - 1, i))];
      if (!o) return;
      if (o.value !== value) {
        haptic("selection");
        onChange(o.value);
      }
    },
    [options, value, onChange],
  );

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const keys: Record<string, number> = { ArrowRight: index + 1, ArrowDown: index + 1, ArrowLeft: index - 1, ArrowUp: index - 1, Home: 0, End: options.length - 1 };
    if (!(e.key in keys)) return;
    e.preventDefault();
    const next = Math.max(0, Math.min(options.length - 1, keys[e.key]!));
    select(next);
    track.current?.querySelectorAll<HTMLButtonElement>("[data-seg]")[next]?.focus();
  };

  // scrub the thumb: grab on the selected segment, drag 1:1, release to the nearest (projected) cell
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!target || (e.pointerType === "mouse" && e.button !== 0)) return;
    const rect = track.current!.getBoundingClientRect();
    const x = e.clientX - rect.left;
    if (x < target.left || x > target.right) return;
    dragging.current = { pid: e.pointerId, startX: e.clientX, baseL: edges.left.get(), w: target.right - target.left, moved: false };
    vt.current.reset();
    springTo(lift, 1.04, "press");
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = dragging.current;
    if (!d || e.pointerId !== d.pid || !cells.length) return;
    const dx = e.clientX - d.startX;
    if (!d.moved && Math.abs(dx) < 3) return;
    if (!d.moved) {
      d.moved = true;
      e.currentTarget.setPointerCapture(e.pointerId);
    }
    const min = cells[0]!.left;
    const max = cells[cells.length - 1]!.left;
    const l = rubberClamp(d.baseL + dx, min, max, 24);
    edges.hold({ left: l, right: l + d.w });
    vt.current.push(l, e.timeStamp);
  };
  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = dragging.current;
    springTo(lift, 1, "press");
    if (!d || e.pointerId !== d.pid) return;
    dragging.current = null;
    if (!d.moved) return;
    const v = vt.current.velocity(e.timeStamp);
    const center = project(edges.left.get(), v) + d.w / 2;
    let best = 0;
    let bestD = Infinity;
    cells.forEach((c, i) => {
      const dist = Math.abs((c.left + c.right) / 2 - center);
      if (dist < bestD) {
        bestD = dist;
        best = i;
      }
    });
    const cell = cells[best]!;
    edges.settle(cell, v);
    select(best);
  };

  const h = size === "sm" ? 36 : 44;
  return (
    <div
      ref={track}
      className={`seg${className ? ` ${className}` : ""}`}
      data-size={size}
      role={role}
      aria-label={label}
      style={{ height: h, borderRadius: h / 2 }}
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      {target && <motion.span className="seg-thumb" aria-hidden="true" style={{ x: edges.left, width: edges.width, scale: lift, borderRadius: h / 2 - PAD }} />}
      {options.map((o, i) => {
        const on = i === index;
        const tabProps =
          role === "tablist"
            ? { role: "tab", "aria-selected": on, "aria-controls": idBase ? `${idBase}-panel-${o.value}` : undefined, id: idBase ? `${idBase}-tab-${o.value}` : undefined }
            : { role: "radio", "aria-checked": on };
        return (
          <button key={o.value} type="button" data-seg className="seg-item" data-on={on || undefined} tabIndex={on ? 0 : -1} onClick={() => select(i)} {...tabProps}>
            {o.icon && <Icon name={o.icon} size={17} weight={on ? "semibold" : "regular"} />}
            <span>{o.label}</span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * Panels under a segmented control: the content changes by a 16px directional travel (exit 120 → enter +60),
 * never a crossfade of two readable copies.
 *   <SegmentedPanels value={seg} order={["artifacts", "media"]} idBase="archive">{seg === "artifacts" ? … : …}</SegmentedPanels>
 */
export function SegmentedPanels<T extends string>({ value, order, children, idBase, className }: { value: T; order: T[]; children: ReactNode; idBase?: string; className?: string }) {
  const prev = useRef(value);
  const dir = useRef<-1 | 1>(1);
  if (prev.current !== value) {
    dir.current = order.indexOf(value) >= order.indexOf(prev.current) ? 1 : -1;
    prev.current = value;
  }
  return (
    <ContentSwap swapKey={value} display="block" as="div" direction={dir.current} className={className}>
      <div role="tabpanel" id={idBase ? `${idBase}-panel-${value}` : undefined} aria-labelledby={idBase ? `${idBase}-tab-${value}` : undefined}>
        {children}
      </div>
    </ContentSwap>
  );
}
