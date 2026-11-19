import { motion, useMotionValue, useTransform } from "framer-motion";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useAgent } from "../api/store";
import { ContentSwap } from "../motion/ContentSwap";
import { haptic } from "../motion/haptics";
import { SPRING, springTo } from "../motion/springs";
import { useTierValue } from "../motion/tier";
import { josa } from "../screens/chat/util";
import { Avatar, DEFAULT_AVATAR } from "../ui/Avatar";
import { Icon } from "../ui/Icon";
import { getDeviceEl } from "./device";
import { island, isBusy, useIsland, type AgentKind, type IslandCall } from "./island";
import "./DynamicIsland.css";

/**
 * The Dynamic Island (MOTION-SPEC §5 + §8.3) — the only pure-black element; renders the shared agent state.
 *   idle 126×37 and STILL (nothing animates, no dot, no waveform) · listening / thinking / tool:<name> / streaming /
 *   awaiting_approval / done / error / offline: wide pill (lead icon · status text [+ "12초" after 2 s] · five level
 *   dots only for real values: mic level while listening, token rate while streaming, voice amplitude in a call; at
 *   rest they are round 4 px dots) · stalled (15 s without events): "오래 걸리고 있어요 · 멈추기" (tap = stop) ·
 *   call: the pill (avatar · timer · dots); a tap opens the call card, a long-press (500 ms) grows the island in place
 *   into name · status · timer, 음소거 and 통화 종료, on the same morph spring; a tap outside or 4 s untouched folds it.
 * The black shape is ONE max-size box clipped by an animated rounded inset (morph spring) — no layout per frame;
 * the width follows the text (measured once per text change, not per second). On a real phone the idle pill is
 * hidden (the hardware island is there) and the shape grows out of it. Announcements live in <AgentLive/>.
 */
const IDLE = { w: 126, h: 37 };
const MIN_WIDE = 196;
const LEAD = 37;
const EXPANDED_H = 84;
/** a press this long on the call pill opens its controls in place (shorter: a tap, which opens the call card) */
const HOLD_MS = 500;
/** the expanded call island folds back after this long without a touch */
const EXPANDED_IDLE_MS = 4000;

let measureCtx: CanvasRenderingContext2D | null = null;
function textWidth(text: string) {
  if (typeof document === "undefined") return text.length * 13;
  measureCtx ??= document.createElement("canvas").getContext("2d");
  if (!measureCtx) return text.length * 13;
  measureCtx.font = `600 13px ${getComputedStyle(document.body).fontFamily || "system-ui"}`;
  return measureCtx.measureText(text).width;
}

/** does this state show level dots (from a real value) in the trailing slot? */
const hasLevel = (k: AgentKind) => k === "listening" || k === "streaming" || k === "call";

function geometry(kind: AgentKind, text: string, stalled: boolean, call: IslandCall | null, maxW: number) {
  if (kind === "call" && call?.expanded) return { w: maxW, h: EXPANDED_H };
  if (kind === "idle") return IDLE;
  if (kind === "call") return { w: 236, h: IDLE.h };
  const label = stalled ? "오래 걸리고 있어요 · 멈추기" : text || "생각하는 중";
  // reserve room for "00초" while busy so the width does not step every second
  const extra = isBusy(kind) && !stalled ? 34 : 0;
  const trail = hasLevel(kind) ? 44 : 16;
  const w = LEAD + 6 + textWidth(label) + extra + trail;
  return { w: Math.round(Math.min(maxW, Math.max(MIN_WIDE, w))), h: IDLE.h };
}

export function DynamicIsland() {
  const { kind, text, elapsed, stalled, remote, level, call } = useIsland();
  const agent = useAgent();
  const spec = agent?.avatar ?? DEFAULT_AVATAR;
  const reduce = useTierValue("reduceMotion");
  const [deviceW, setDeviceW] = useState(402);

  useLayoutEffect(() => {
    const el = getDeviceEl();
    if (!el) return;
    const ro = new ResizeObserver(() => setDeviceW(el.clientWidth));
    ro.observe(el);
    setDeviceW(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const maxW = Math.min(deviceW - 24, 380);
  const g = useMemo(() => geometry(kind, text, stalled, call, maxW), [kind, text, stalled, call, maxW]);
  const w = useMotionValue(g.w);
  const h = useMotionValue(g.h);
  useEffect(() => {
    springTo(w, g.w, "morph");
    springTo(h, g.h, "morph");
  }, [g.w, g.h, w, h]);

  const clipPath = useTransform<number, string>([w, h], ([cw, ch]) => {
    const side = Math.max(0, (maxW - cw) / 2);
    const r = Math.min(ch / 2, 43);
    return `inset(0px ${side.toFixed(2)}px ${(EXPANDED_H - ch).toFixed(2)}px ${side.toFixed(2)}px round ${r.toFixed(2)}px)`;
  });

  const expanded = kind === "call" && !!call?.expanded;
  const box = useRef<HTMLDivElement>(null);
  // long-press on the call pill: the controls in place. The release that follows is not a tap.
  const hold = useRef<{ timer?: ReturnType<typeof setTimeout>; fired: boolean; x: number; y: number }>({ fired: false, x: 0, y: 0 });
  const cancelHold = () => {
    clearTimeout(hold.current.timer);
    hold.current.timer = undefined;
  };
  useEffect(() => cancelHold, []);
  // expanded: a press outside folds it (nothing dims, the press still lands), so does Escape or 4 s untouched
  useEffect(() => {
    if (!expanded) return;
    const fold = () => island.updateCall({ expanded: false, held: false });
    let timer = setTimeout(fold, EXPANDED_IDLE_MS);
    const touched = () => {
      clearTimeout(timer);
      timer = setTimeout(fold, EXPANDED_IDLE_MS);
    };
    const onDown = (e: PointerEvent) => {
      if (box.current?.querySelector(".island-call")?.contains(e.target as Node)) touched();
      else fold();
    };
    const onKey = (e: KeyboardEvent) => (e.key === "Escape" ? fold() : touched());
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [expanded]);
  const actionable = kind === "call" || (stalled && !remote) || kind === "error" || isBusy(kind) || kind === "awaiting_approval";
  const name = agent?.name ?? "에이전트";
  const label =
    kind === "idle"
      ? undefined
      : kind === "call" && call
        ? `${josa(call.name, "과", "와")} 통화 중`
        : stalled
          ? `${name}: 오래 걸리고 있어요. 눌러서 멈추기`
          : `${name}: ${text || "생각하는 중"}${elapsed ? ` ${elapsed}초` : ""}`;
  const swapKey = stalled ? "stalled" : `${kind}:${text}`;

  return (
    <div className="island-anchor" data-kind={kind}>
      <motion.div
        ref={box}
        className="island"
        data-kind={kind}
        data-expanded={expanded || undefined}
        data-actionable={actionable || undefined}
        style={{ width: maxW, clipPath }}
        role={actionable ? "button" : kind === "idle" ? undefined : "img"}
        tabIndex={actionable && !expanded ? 0 : undefined}
        aria-label={label}
        onPointerDown={(e) => {
          hold.current.fired = false;
          if (kind !== "call" || expanded || (e.pointerType === "mouse" && e.button !== 0)) return;
          cancelHold();
          hold.current.x = e.clientX;
          hold.current.y = e.clientY;
          hold.current.timer = setTimeout(() => {
            hold.current.timer = undefined;
            hold.current.fired = true;
            haptic("impact");
            island.holdCall();
          }, HOLD_MS);
        }}
        onPointerMove={(e) => {
          if (hold.current.timer && Math.hypot(e.clientX - hold.current.x, e.clientY - hold.current.y) > 10) cancelHold();
        }}
        onPointerUp={cancelHold}
        onPointerCancel={cancelHold}
        onContextMenu={(e) => {
          if (kind === "call") e.preventDefault();
        }}
        onClick={() => {
          if (hold.current.fired) {
            hold.current.fired = false;
            return;
          }
          if (!actionable) return;
          haptic("impact");
          island.press();
        }}
        onKeyDown={(e) => {
          if (actionable && (e.key === "Enter" || e.key === " ")) {
            e.preventDefault();
            island.press();
          }
        }}
      >
        <div className="island-compact" style={{ width: g.w, opacity: expanded ? 0 : 1 }} aria-hidden="true">
          {kind !== "idle" && !expanded && (
            <>
              <span className="island-lead">
                <ContentSwap swapKey={leadKey(kind)}>
                  <Lead kind={kind} spec={spec} reduce={reduce} />
                </ContentSwap>
              </span>
              <span className="island-text">
                <ContentSwap swapKey={kind === "call" ? "call" : swapKey}>
                  {kind === "call" && call ? (
                    <CallTimer startedAt={call.startedAt} />
                  ) : stalled ? (
                    <span className="island-line">
                      <span className="island-ellipsis">오래 걸리고 있어요</span>
                      {!remote && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span className="island-stop">멈추기</span>
                        </>
                      )}
                    </span>
                  ) : (
                    <span className="island-line">
                      <span className="island-ellipsis">{text}</span>
                    </span>
                  )}
                </ContentSwap>
                {!stalled && elapsed > 0 && kind !== "call" && <span className="island-elapsed tnum">{elapsed}초</span>}
              </span>
              <span className="island-trail">{hasLevel(kind) && <LevelDots level={kind === "call" ? call?.amplitude ?? 0 : level} />}</span>
            </>
          )}
        </div>
        {expanded && call && <CallControls call={call} spec={spec} />}
      </motion.div>
    </div>
  );
}

function leadKey(kind: AgentKind) {
  if (kind === "done" || kind === "error" || kind === "offline" || kind === "awaiting_approval") return kind;
  return "avatar";
}

function Lead({ kind, spec, reduce }: { kind: AgentKind; spec: typeof DEFAULT_AVATAR; reduce: boolean }) {
  switch (kind) {
    case "done":
      return <DrawnCheck reduce={reduce} />;
    case "error":
      return <span className="island-dot" />;
    case "offline":
      return (
        <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
          <circle cx="9" cy="9" r="7.2" stroke="currentColor" strokeWidth="1.8" strokeDasharray="2.6 2.6" opacity="0.8" />
        </svg>
      );
    case "awaiting_approval":
      return <Icon name="lock" size={18} weight="semibold" />;
    default:
      return <Avatar spec={spec} size={24} breathing={false} />;
  }
}

function DrawnCheck({ reduce }: { reduce: boolean }) {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="11" fill="var(--accent)" />
      <motion.path
        d="M7.4 12.3l3 3 6.2-6.6"
        stroke="#fff"
        strokeWidth="2.3"
        strokeLinecap="round"
        strokeLinejoin="round"
        initial={reduce ? false : { pathLength: 0 }}
        animate={{ pathLength: 1 }}
        transition={reduce ? { duration: 0 } : { ...SPRING.snap, delay: 0.12 }}
      />
    </svg>
  );
}

/**
 * Five dots whose height IS the level: round 4 px dots at rest (a quiet line, never "-----"), stretched up to 16 px
 * by a real value. No loop: they only move when the value changes (a 100 ms transition smooths ~10 Hz updates).
 */
function LevelDots({ level }: { level: number }) {
  const lvl = Math.max(0, Math.min(1, level));
  return (
    <span className="island-dots" style={{ "--lvl": lvl.toFixed(3) } as CSSProperties} aria-hidden="true">
      {[0.55, 0.9, 1, 0.75, 0.45].map((k, i) => (
        <i key={i} style={{ "--k": k } as CSSProperties} />
      ))}
    </span>
  );
}

function CallTimer({ startedAt }: { startedAt: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const s = Math.max(0, Math.floor((now - startedAt) / 1000));
  const mm = String(Math.floor(s / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return (
    <span className="island-timer tnum" aria-hidden="true">
      {mm}:{ss}
    </span>
  );
}

function CallControls({ call, spec }: { call: IslandCall; spec: typeof DEFAULT_AVATAR }) {
  return (
    <motion.div
      className="island-call"
      role="group"
      aria-label={`${josa(call.name, "과", "와")} 통화 중`}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ ...SPRING.fade, delay: 0.18 }}
      onClick={(e) => e.stopPropagation()}
    >
      <Avatar spec={spec} size={44} breathing={false} />
      <div className="island-call-who">
        <span className="island-call-name">{call.name}</span>
        <span className="island-call-status">
          {call.status && (
            <>
              {call.status}
              <span aria-hidden="true"> · </span>
            </>
          )}
          <CallTimer startedAt={call.startedAt} />
        </span>
      </div>
      <div className="island-call-actions">
        <button
          type="button"
          className="island-btn"
          aria-pressed={call.muted}
          aria-label="음소거"
          data-on={call.muted || undefined}
          onClick={() => {
            haptic("toggle");
            island.updateCall({ muted: !call.muted });
          }}
        >
          <Icon name={call.muted ? "mic-off" : "mic"} size={22} weight="medium" />
        </button>
        <button
          type="button"
          className="island-btn end"
          aria-label="통화 종료"
          onClick={() => {
            haptic("impact");
            island.endCall();
          }}
        >
          <Icon name="phone" size={22} weight="medium" />
        </button>
      </div>
    </motion.div>
  );
}
