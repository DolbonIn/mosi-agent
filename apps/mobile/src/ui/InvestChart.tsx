import { motion } from "framer-motion";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import { APP_THEME, FULL_VIEW, type ChartLayout, type Stroke } from "@pickle/quant";
import { SPRING } from "../motion/springs";
import { useTierValue } from "../motion/tier";
import { chartHeight, drawChart, nearestBar, readings, type ChartInput } from "./investChartFit";
import "./InvestChart.css";

/**
 * The level chart in the app (DD 2145 "앱 차트 부품", DD 1935 §2-5 / §4, DD 0914 D3 / D5; team-lead 0931): @pickle/quant's
 * levelChart drawn as inline SVG at the width this part measures (never scaled), its type at 13 × the person's text
 * size, the days shown fitted to the plot (3 px a bar, 30–60). The SVG's colours are the theme's CSS variables, so a
 * theme change needs no redraw. The legend (short line samples and words) sits above the SVG, outside it, with the
 * days actually shown at its end (일봉 40일: the words say what the picture shows; DD 0914 D5). A card whose header
 * says the days passes `days={false}` and reads them from `onDays`.
 *
 * `crosshair` (the full view, the symbol screen): a finger that first moves sideways brings a crosshair that snaps to
 * the nearest day (touch-action: pan-y, so a vertical move still scrolls the screen); its reading sits at the top of the
 * plot, anchored to that day's bar: the day and close, then the 20- and 50-day averages. Let go, it fades in 200 ms (at
 * once with reduced motion). A mouse brings it on press.
 *
 * A screen reader hears the picture's name (the SVG's role="img" + aria-label): the symbol and the days drawn, then the
 * server's sentence (DD 1442 §1); the legend is hidden from it. The crosshair is a pointer-only aid on top of it. Input the chart cannot draw (fewer than two bars, a price that is not a number) draws
 * nothing, legend and height included, once the width is known: the screen shows the server's chartNote instead.
 */
export function InvestChart({
  input,
  layout = FULL_VIEW,
  crosshair = false,
  days: showDays = true,
  onDays,
  className,
}: {
  input: ChartInput;
  /** the layout's sizes; its width is replaced by the measured one */
  layout?: ChartLayout;
  crosshair?: boolean;
  /** the days shown at the legend's end (default); false when a header says them */
  days?: boolean;
  /** the days actually shown, for a header that says them (DD 0914 D5: 일봉 40일) */
  onDays?: (days: number) => void;
  className?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const scale = useTierValue("textScale");
  const reduce = useTierValue("reduceMotion");

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => setWidth(Math.floor(el.clientWidth));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const drawn = useMemo(() => {
    if (width <= 0) return null;
    try {
      return drawChart(input, width, scale, layout);
    } catch {
      return null;
    }
  }, [input, width, scale, layout]);
  const reads = useMemo(() => (drawn && crosshair ? readings(input, drawn.chart) : []), [drawn, crosshair, input]);
  const days = drawn?.days ?? null;
  useEffect(() => {
    if (days !== null) onDays?.(days);
  }, [days, onDays]);

  const hair = useHair(crosshair && !!drawn, reduce, (clientX) => {
    const el = box.current;
    if (!el || !drawn) return null;
    return nearestBar(drawn.chart, clientX - el.getBoundingClientRect().left);
  });

  const failed = width > 0 && !drawn;
  const height = failed ? 0 : chartHeight(layout);
  const r = hair.i !== null ? reads[hair.i] : undefined;
  return (
    <figure className={`ivc${className ? ` ${className}` : ""}`}>
      {!failed && <Legend days={showDays ? days : null} />}
      <div
        ref={box}
        className={`ivc-plot${crosshair ? " has-crosshair" : ""}`}
        style={{ height }}
        onPointerDown={hair.down}
        onPointerMove={hair.move}
        onPointerUp={hair.up}
        onPointerCancel={hair.up}
      >
        {drawn && <div className="ivc-svg" dangerouslySetInnerHTML={{ __html: drawn.chart.svg }} />}
        {drawn && r && <Hair x={r.x} top={drawn.chart.plot.y0} height={height} width={drawn.chart.width} head={r.head} averages={r.averages} on={hair.on} reduce={reduce} />}
      </div>
    </figure>
  );
}

/** the four lines' samples and words (DD 1935 §2-5: 20일 · 50일 · 200일 · VWAP), drawn with the chart's own strokes */
const KEYS: { word: string; stroke: Stroke }[] = [
  { word: "20일", stroke: APP_THEME.ma20 },
  { word: "50일", stroke: APP_THEME.ma50 },
  { word: "200일", stroke: APP_THEME.ma200 },
  { word: "VWAP", stroke: APP_THEME.vwap },
];

function Legend({ days }: { days: number | null }) {
  return (
    <div className="ivc-legend" aria-hidden="true">
      {KEYS.map((k) => (
        <span key={k.word} className="ivc-key">
          <svg className="ivc-sample" width="16" height="6" viewBox="0 0 16 6">
            <line x1="1" x2="15" y1="3" y2="3" stroke={k.stroke.color} strokeWidth={k.stroke.width} strokeDasharray={k.stroke.dash} strokeLinecap={k.stroke.round ? "round" : undefined} />
          </svg>
          {k.word}
        </span>
      ))}
      {days !== null && <span className="ivc-days tnum">일봉 {days}일</span>}
    </div>
  );
}

/** the crosshair's line through the panels and its reading at the top, kept inside the chart's width */
function Hair({ x, top, height, width, head, averages, on, reduce }: { x: number; top: number; height: number; width: number; head: string; averages: string; on: boolean; reduce: boolean }) {
  const card = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    if (card.current) setW(card.current.offsetWidth);
  }, [head, averages]);
  const left = Math.max(0, Math.min(width - w, x - w / 2));
  const move = reduce ? { duration: 0 } : SPRING.snap;
  return (
    <div className={`ivc-hair${on ? " is-on" : ""}`} aria-hidden="true">
      <motion.span className="ivc-hair-line" style={{ top, height: height - top }} initial={false} animate={{ x }} transition={move} />
      <motion.div ref={card} className="ivc-read tnum" initial={false} animate={{ x: left }} transition={move}>
        <span className="ivc-read-head">{head}</span>
        <span className="ivc-read-avg">{averages}</span>
      </motion.div>
    </div>
  );
}

/**
 * The crosshair's pointer: a touch or pen becomes a crosshair only once it has moved sideways more than it has moved
 * down (a vertical move is the screen's scroll, which pan-y leaves to the browser); a mouse on press. `pick` maps a
 * clientX to a bar. Let go: `on` drops at once (the CSS fades it, 200 ms) and the bar is cleared after the fade.
 */
function useHair(enabled: boolean, reduce: boolean, pick: (clientX: number) => number | null) {
  const [i, setI] = useState<number | null>(null);
  const [on, setOn] = useState(false);
  const start = useRef<{ id: number; x: number; y: number; live: boolean } | null>(null);
  const clear = useRef<number | null>(null);
  useEffect(() => () => void (clear.current !== null && window.clearTimeout(clear.current)), []);
  const show = (clientX: number) => {
    const at = pick(clientX);
    if (at === null) return;
    if (clear.current !== null) window.clearTimeout(clear.current);
    clear.current = null;
    setI(at);
    setOn(true);
  };
  const down = (e: PointerEvent<HTMLDivElement>) => {
    if (!enabled) return;
    start.current = { id: e.pointerId, x: e.clientX, y: e.clientY, live: e.pointerType === "mouse" };
    if (e.pointerType === "mouse") {
      e.currentTarget.setPointerCapture(e.pointerId);
      show(e.clientX);
    }
  };
  const move = (e: PointerEvent<HTMLDivElement>) => {
    const s = start.current;
    if (!enabled || !s || s.id !== e.pointerId) return;
    if (!s.live) {
      const dx = Math.abs(e.clientX - s.x);
      const dy = Math.abs(e.clientY - s.y);
      if (dy > 8 && dy >= dx) {
        start.current = null;
        return;
      }
      if (dx <= 6 || dx <= dy) return;
      s.live = true;
      e.currentTarget.setPointerCapture(e.pointerId);
    }
    show(e.clientX);
  };
  const up = (e: PointerEvent<HTMLDivElement>) => {
    const s = start.current;
    if (!s || s.id !== e.pointerId) return;
    start.current = null;
    if (!s.live) return;
    setOn(false);
    clear.current = window.setTimeout(() => setI(null), reduce ? 0 : 200);
  };
  return { i, on, down, move, up };
}
