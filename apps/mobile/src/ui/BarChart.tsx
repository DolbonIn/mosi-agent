import { AnimatePresence, motion, useMotionValue, useMotionValueEvent, useTransform } from "framer-motion";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { EXIT, SPRING, springTo, t } from "../motion/springs";
import { useTierValue } from "../motion/tier";
import { haptic } from "../motion/haptics";
import { Glass } from "./Glass";
import { R } from "./geometry";
import "./BarChart.css";

/**
 * BarChart (MOTION-SPEC §3 Chart): opaque bars on paper. The first time the chart becomes visible in a session the bars
 * rise left→right (30 ms stagger, `morph`, scaleY from the baseline); afterwards it renders at rest. Press, hover or drag
 * across the plot (the whole plot is the target) → a glass tooltip anchored above the active bar slides between bars
 * (`snap`, interruptible) and counts its value in tabular figures. Accent marks ONLY the selected bar.
 * Keyboard: ←/→/Home/End step through bars, Esc hides. A visually hidden table carries the data.
 * Reduced motion: the final drawing; the tooltip jumps.
 *
 *   <BarChart id="usage7d" data={usage.map(u => ({ label: u.day, value: u.tokens }))} unit="토큰" ariaLabel="최근 7일 사용량" />
 */
export interface BarDatum {
  label: string;
  value: number;
}

export interface BarChartProps {
  data: BarDatum[];
  /** session key: "pickle.chart.<id>" — the rise plays once per session */
  id: string;
  height?: number;
  format?: (n: number) => string;
  unit?: string;
  className?: string;
  ariaLabel: string;
  /** index highlighted at rest (default: the last bar, e.g. today) */
  selected?: number;
}

const defaultFormat = (n: number) => Math.round(n).toLocaleString("ko-KR");
const GAP = 8;
const STAGGER = 0.03;
const TIP_GAP = 10;

function seenThisSession(id: string): boolean {
  try {
    return sessionStorage.getItem(`pickle.chart.${id}`) === "1";
  } catch {
    return true;
  }
}
function markSeen(id: string) {
  try {
    sessionStorage.setItem(`pickle.chart.${id}`, "1");
  } catch {
    /* ignore */
  }
}

export function BarChart({ data, id, height = 160, format = defaultFormat, unit, className, ariaLabel, selected }: BarChartProps) {
  const reduce = useTierValue("reduceMotion");
  const uid = useId();
  const tableId = `${uid}-table`;
  const plotRef = useRef<HTMLDivElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const valueRef = useRef<HTMLSpanElement>(null);
  const rectRef = useRef<DOMRect | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const placed = useRef(false);

  const [rise] = useState(() => !reduce && !seenThisSession(id));
  const [shown, setShown] = useState(!rise);
  const [active, setActive] = useState<number | null>(null);
  const [width, setWidth] = useState(0);
  const [announce, setAnnounce] = useState("");

  const n = data.length;
  const max = Math.max(1, ...data.map((d) => d.value));
  const highlight = active ?? selected ?? n - 1;
  const slot = n ? (width + GAP) / n : 0;
  const barW = Math.max(0, slot - GAP);
  const centerOf = (i: number) => i * slot + barW / 2;
  const topOf = (i: number) => height - (Math.max(0, data[i]?.value ?? 0) / max) * height;

  // tooltip motion: anchor centre x, bar top y, counted value
  const cx = useMotionValue(0);
  const ty = useMotionValue(height);
  const num = useMotionValue(0);
  const tipHalf = useRef(40);
  const widthRef = useRef(0);
  widthRef.current = width;
  const clampTip = (c: number) => Math.min(Math.max(c, tipHalf.current), Math.max(tipHalf.current, widthRef.current - tipHalf.current));
  const tipX = useTransform(cx, (c) => clampTip(c));
  const caretX = useTransform(cx, (c) => c - clampTip(c));

  useMotionValueEvent(num, "change", (v) => {
    const el = valueRef.current;
    if (el) el.textContent = `${format(v)}${unit ? ` ${unit}` : ""}`;
  });

  // measure the plot
  useLayoutEffect(() => {
    const el = plotRef.current;
    if (!el) return;
    const measure = () => setWidth(el.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // first sight this session → rise
  useEffect(() => {
    if (!rise || shown) return;
    const el = plotRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([e]) => {
        if (e?.isIntersecting) {
          setShown(true);
          markSeen(id);
          io.disconnect();
        }
      },
      { threshold: 0.35 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [rise, shown, id]);

  // move the tooltip to the active bar
  useLayoutEffect(() => {
    if (active === null || !data[active]) return;
    const c = centerOf(active);
    const y = topOf(active);
    const v = data[active].value;
    const el = valueRef.current;
    if (!placed.current && el) el.textContent = `${format(v)}${unit ? ` ${unit}` : ""}`;
    const tip = tipRef.current;
    if (tip) tipHalf.current = tip.offsetWidth / 2;
    if (!placed.current) {
      placed.current = true;
      cx.set(c);
      ty.set(y);
      num.set(v);
      return;
    }
    springTo(cx, c, "snap");
    springTo(ty, y, "snap");
    springTo(num, v, "snap");
  }, [active, width, height, data]);

  const indexAt = useCallback(
    (clientX: number) => {
      const r = rectRef.current;
      if (!r || !n) return null;
      const x = clientX - r.left;
      return Math.min(n - 1, Math.max(0, Math.floor((x + GAP / 2) / Math.max(1, (r.width + GAP) / n))));
    },
    [n],
  );

  const activeRef = useRef<number | null>(null);
  activeRef.current = active;
  const pick = useCallback((i: number | null) => {
    const prev = activeRef.current;
    if (i === prev) return;
    if (i !== null && prev !== null) haptic("selection");
    activeRef.current = i;
    setActive(i);
  }, []);

  const hide = useCallback(() => {
    clearTimeout(hideTimer.current);
    placed.current = false;
    setActive(null);
  }, []);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    clearTimeout(hideTimer.current);
    rectRef.current = e.currentTarget.getBoundingClientRect();
    pick(indexAt(e.clientX));
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === "mouse") {
      rectRef.current ??= e.currentTarget.getBoundingClientRect();
      pick(indexAt(e.clientX));
      return;
    }
    if (e.buttons === 0 && e.pointerType !== "touch") return;
    if (rectRef.current) pick(indexAt(e.clientX));
  };
  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === "mouse") return;
    clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(hide, 1800);
  };
  const onPointerLeave = (e: PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === "mouse") {
      rectRef.current = null;
      hide();
    }
  };
  const onPointerCancel = () => hide();

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!n) return;
    const cur = active ?? highlight;
    let next: number | null = null;
    if (e.key === "ArrowRight") next = Math.min(n - 1, cur + (active === null ? 0 : 1));
    else if (e.key === "ArrowLeft") next = Math.max(0, cur - (active === null ? 0 : 1));
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = n - 1;
    else if (e.key === "Escape") {
      hide();
      return;
    } else return;
    e.preventDefault();
    pick(next);
    const d = data[next];
    if (d) setAnnounce(`${d.label} ${format(d.value)}${unit ? ` ${unit}` : ""}`);
  };

  useEffect(() => () => clearTimeout(hideTimer.current), []);

  return (
    <div className={`barchart${className ? ` ${className}` : ""}`}>
      <div
        ref={plotRef}
        className="barchart-plot"
        style={{ height }}
        role="group"
        tabIndex={0}
        aria-label={ariaLabel}
        aria-describedby={tableId}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerLeave}
        onPointerCancel={onPointerCancel}
        onKeyDown={onKeyDown}
        onBlur={() => hide()}
      >
        <div className="barchart-bars" style={{ gap: GAP }} aria-hidden="true">
          {data.map((d, i) => (
            <div key={`${d.label}-${i}`} className="barchart-slot">
              <motion.div
                className="barchart-bar"
                data-selected={i === highlight || undefined}
                style={{ height: `${(Math.max(0, d.value) / max) * 100}%` }}
                initial={rise ? { scaleY: 0 } : false}
                animate={{ scaleY: shown ? 1 : 0 }}
                transition={rise ? { ...SPRING.morph, delay: i * STAGGER } : t("morph")}
              />
            </div>
          ))}
        </div>

        <motion.div className="barchart-anchor" style={{ x: tipX, y: ty }} aria-hidden="true">
          <AnimatePresence>
            {active !== null && data[active] && (
              <Glass
                key="tip"
                ref={tipRef}
                text
                radius={R.field}
                className="barchart-tip"
                style={{ x: "-50%", bottom: TIP_GAP }}
                initial={reduce ? false : { opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0, transition: t("fade") }}
                exit={reduce ? { opacity: 0, transition: { duration: 0 } } : { opacity: 0, transition: EXIT }}
              >
                <span className="barchart-tip-label">{data[active].label}</span>
                <span ref={valueRef} className="barchart-tip-value tnum" />
                <motion.span className="barchart-tip-caret" style={{ x: caretX }} />
              </Glass>
            )}
          </AnimatePresence>
        </motion.div>
      </div>

      <div className="barchart-axis" aria-hidden="true" style={{ gap: GAP }}>
        {data.map((d, i) => (
          <span key={`${d.label}-${i}`} className="barchart-tick tnum" data-selected={i === highlight || undefined}>
            {d.label}
          </span>
        ))}
      </div>

      <table id={tableId} className="sr-only">
        <caption>{ariaLabel}</caption>
        <tbody>
          {data.map((d, i) => (
            <tr key={`${d.label}-${i}`}>
              <th scope="row">{d.label}</th>
              <td>
                {format(d.value)}
                {unit ? ` ${unit}` : ""}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <span className="sr-only" aria-live="polite">
        {announce}
      </span>
    </div>
  );
}

