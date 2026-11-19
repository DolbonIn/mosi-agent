import { motion, useMotionValue, useTransform, type MotionValue } from "framer-motion";
import { useCallback, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import type { TabId } from "@pickle/protocol";
import { useUi } from "../api/store";
import { haptic } from "../motion/haptics";
import { createVelocityTracker, project, rubberClamp } from "../motion/rubberBand";
import { springTo } from "../motion/springs";
import { useTierValue } from "../motion/tier";
import { useTwoEdge, type Edges } from "../motion/useTwoEdge";
import { BlurGroup, Glass } from "../ui/Glass";
import { Icon } from "../ui/Icon";
import { nav, TAB_ORDER, useNav } from "./nav";
import { useDropletLens } from "./useDropletLens";
import "./TabBar.css";

/**
 * Bottom chrome: ONE BlurGroup ("bottom") holding the screen-owned slot (the chat composer portals into
 * `.chrome-slot` via <ChromePortal>) and the glass tab bar. Tab bar (HIG tab bars + MOTION-SPEC §1, §3):
 *   - glass capsule r34, 68px; the selection is a droplet r28 (34 − 6 inset, concentric), a vibrant fill, not glass;
 *   - tapping a tab: the droplet travels by its two edges (lead .28 / trail .42), the content swaps by direction;
 *   - press-and-drag: the droplet follows the finger 1:1 (rubber band past the ends), icons near it swell, the
 *     liquid-glass-js lens magnifies what is under it; release → nearest tab, projected 180 ms along the velocity;
 *   - tapping the active tab pops its stack to the root; arrow keys move between tabs (automatic activation).
 *   - it never changes size or position: the bar is always full width under the slot. Minimise (MOTION-SPEC §8.8)
 *     was removed — on the user's device the morph got caught half-collapsed under the composer; the user rejected it.
 */
const INSET = 6;
const BAR_R = 34;
const DROP_R = BAR_R - INSET;

/** the slot (composer) above the full-width tab bar; static: no minimise, no morph, nothing measured */
export function BottomChrome() {
  return (
    <BlurGroup name="bottom" className="bottom-chrome">
      <div className="chrome-slot" />
      <TabBar />
    </BlurGroup>
  );
}

export function TabBar() {
  const ui = useUi();
  const tabs = ui.tabs.length ? ui.tabs : TAB_ORDER.map((id) => ({ id, title: id, icon: "chat" as const }));
  const tab = useNav((s) => s.tab);
  const theme = useTierValue("theme");
  const row = useRef<HTMLDivElement>(null);
  const drop = useRef<HTMLSpanElement>(null);
  const [cells, setCells] = useState<Edges[]>([]);
  const index = Math.max(0, tabs.findIndex((t) => t.id === tab));
  const edges = useTwoEdge(cells[index] ?? null);
  const active = useMotionValue(0); // 0 rest … 1 pressed/dragging
  const dropScale = useTransform(active, [0, 1], [1, 1.06]);
  const vt = useRef(createVelocityTracker());
  const session = useRef<{ pid: number; startX: number; baseL: number; w: number; onDrop: boolean; moved: boolean } | null>(null);
  const suppressClick = useRef(false);
  const lensOn = useRef<(on: boolean) => void>(() => {});

  useLayoutEffect(() => {
    const el = row.current;
    if (!el) return;
    const measure = () => {
      const w = el.clientWidth - INSET * 2;
      const cw = w / tabs.length;
      setCells(tabs.map((_, i) => ({ left: INSET + i * cw, right: INSET + (i + 1) * cw })));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [tabs.length]); // eslint-disable-line react-hooks/exhaustive-deps

  lensOn.current = useDropletLens(row, drop, edges.left, edges.right, DROP_R, `${theme}:${tabs.length}:${cells.length > 0}`);

  const choose = useCallback(
    (id: TabId) => {
      if (id !== tab) haptic("selection");
      nav.setTab(id);
    },
    [tab],
  );

  const nearest = (center: number) => {
    let best = 0;
    let bestD = Infinity;
    cells.forEach((c, i) => {
      const d = Math.abs((c.left + c.right) / 2 - center);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    return best;
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!cells.length || !e.isPrimary || (e.pointerType === "mouse" && e.button !== 0)) return;
    const rect = row.current!.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const l = edges.left.get();
    const r = edges.right.get();
    const onDrop = x >= l && x <= r;
    session.current = { pid: e.pointerId, startX: e.clientX, baseL: l, w: cells[0]!.right - cells[0]!.left, onDrop, moved: false };
    vt.current.reset();
    vt.current.push(l, e.timeStamp);
    if (onDrop) springTo(active, 1, "press");
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const s = session.current;
    if (!s || e.pointerId !== s.pid) return;
    const dx = e.clientX - s.startX;
    if (!s.moved) {
      if (Math.abs(dx) < 6) return;
      s.moved = true;
      e.currentTarget.setPointerCapture(e.pointerId);
      springTo(active, 1, "press");
      lensOn.current(true);
    }
    const rect = row.current!.getBoundingClientRect();
    const min = cells[0]!.left;
    const max = cells[cells.length - 1]!.left;
    if (s.onDrop) {
      // direct manipulation: the droplet is under the finger, 1:1
      const l = rubberClamp(s.baseL + dx, min, max, 30);
      edges.hold({ left: l, right: l + s.w });
      vt.current.push(l, e.timeStamp);
    } else {
      // grabbed elsewhere: the droplet chases the finger on its springs (keeps velocity on every retarget)
      const l = rubberClamp(e.clientX - rect.left - s.w / 2, min, max, 30);
      edges.settle({ left: l, right: l + s.w });
      vt.current.push(l, e.timeStamp);
    }
  };

  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const s = session.current;
    if (!s || e.pointerId !== s.pid) return;
    session.current = null;
    springTo(active, 0, "snap");
    if (!s.moved) return;
    lensOn.current(false);
    suppressClick.current = true;
    setTimeout(() => (suppressClick.current = false), 0);
    const v = e.type === "pointercancel" ? 0 : vt.current.velocity(e.timeStamp);
    const i = nearest(project(edges.left.get(), v) + s.w / 2);
    const cell = cells[i]!;
    edges.settle(cell, v);
    const id = tabs[i]!.id;
    if (id !== tab) {
      haptic("selection");
      nav.setTab(id);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const keys: Record<string, number> = { ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: tabs.length - 1 };
    if (!(e.key in keys)) return;
    e.preventDefault();
    const next = Math.max(0, Math.min(tabs.length - 1, keys[e.key]!));
    choose(tabs[next]!.id);
    row.current?.querySelectorAll<HTMLButtonElement>("[role=tab]")[next]?.focus();
  };

  return (
    <Glass
      as="nav"
      blur="group"
      radius={BAR_R}
      lens={0.9}
      className="tabbar"
      aria-label="탭"
    >
      {cells.length > 0 && (
        <motion.span
          ref={drop}
          className="tab-droplet"
          aria-hidden="true"
          style={{ x: edges.left, width: edges.width, scale: dropScale, borderRadius: DROP_R }}
        />
      )}
      <div
        ref={row}
        className="tab-row"
        role="tablist"
        aria-orientation="horizontal"
        onKeyDown={onKeyDown}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        {tabs.map((t, i) => (
          <TabButton
            key={t.id}
            id={t.id}
            title={t.title}
            icon={t.icon}
            selected={i === index}
            cell={cells[i]}
            center={edges.center}
            active={active}
            onSelect={() => {
              if (suppressClick.current) return;
              choose(t.id);
            }}
          />
        ))}
      </div>
    </Glass>
  );
}

function TabButton({
  id,
  title,
  icon,
  selected,
  cell,
  center,
  active,
  onSelect,
}: {
  id: TabId;
  title: string;
  icon: string;
  selected: boolean;
  cell: Edges | undefined;
  center: MotionValue<number>;
  active: MotionValue<number>;
  onSelect: () => void;
}) {
  const mid = cell ? (cell.left + cell.right) / 2 : 0;
  const half = cell ? (cell.right - cell.left) * 0.9 : 1;
  const prox = useTransform<number, number>([center, active], ([c, a]) => Math.max(0, 1 - Math.abs(c - mid) / half) * a);
  const scale = useTransform(prox, (p) => 1 + 0.2 * p);
  const y = useTransform(prox, (p) => -2 * p);
  return (
    <button
      type="button"
      role="tab"
      id={`tab-${id}`}
      aria-selected={selected}
      tabIndex={selected ? 0 : -1}
      className="tab-item"
      data-on={selected || undefined}
      onClick={onSelect}
    >
      <motion.span className="tab-icon" style={{ scale, y }}>
        <Icon name={icon} size={24} weight={selected ? "semibold" : "regular"} />
      </motion.span>
      <span className="tab-label">{title}</span>
    </button>
  );
}
