import type { AvatarSpec, Card, ID, ToolActivity } from "@pickle/protocol";
import { AnimatePresence, motion } from "framer-motion";
import { memo, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { stepsSummary, toolLabel, toolSource } from "../../app/agentVocab";
import { useScroller } from "../../app/Screen";
import { ContentSwap } from "../../motion/ContentSwap";
import { CONTENT_DELAY, EXIT, SPRING, t } from "../../motion/springs";
import { useTierValue } from "../../motion/tier";
import { Avatar } from "../../ui/Avatar";
import { Icon } from "../../ui/Icon";
import { CardView, foldable, foldSource } from "./cards/CardView";
import { holdScroll } from "./scrollHold";
import { durationKo } from "./util";

/**
 * The turn's one line (MOTION-SPEC §8.5, user request 2026-11-15 "가능한 더보기 눌러서 펼쳤을때 보이도록"): one
 * 44 pt row right under where the turn starts, and the same element from the first tool call to the end —
 *   running   the agent's face + a ring + the status ("뉴스 찾는 중", "외 2개" when several run at once);
 *   done      the face + "자료 3개 보기 · 외교부, 네이버 뉴스" when read-only records came back, else "2단계 · 1분 33초".
 * The words change by content swap (the old copy leaves, then the new one arrives; never both at once) while the
 * row, the face and the chevron stay. It is a disclosure: tapping it opens, in place under it, the folded records
 * (results, weather, a messenger room that was read) and then the steps (title, result, source, time) on `morph`
 * (height + clip; reduced motion: at once). The answer comes after the line, so it never waits below a stack of
 * records, also while it streams. Cards that ask something of the person (approval, credential, briefing choices,
 * schedule switch, artifact) are never folded: they stay under the answer as before.
 *
 * Open or closed is kept per message for as long as the thread is on screen (`folds`, from ThreadView); a reload or
 * opening the thread again starts folded. Without a face (friend threads) the line starts with the check instead.
 */
export const TurnFold = memo(function TurnFold({
  id,
  tools,
  live,
  cards,
  face,
  folds,
  threadId,
  onSend,
  interactive,
}: {
  id: ID;
  tools: ToolActivity[];
  live: boolean;
  /** all of the turn's cards; only the read-only records (CardView `foldable`) are folded here */
  cards: Card[];
  face: AvatarSpec | null;
  folds?: Map<ID, boolean>;
  threadId: ID;
  onSend: (text: string) => void;
  interactive: boolean;
}) {
  const folded = useMemo(() => cards.filter(foldable), [cards]);
  const [open, setOpenState] = useState(() => folds?.get(id) ?? false);
  const [moving, setMoving] = useState(false);
  const panelId = useId();
  const reduce = useTierValue("reduceMotion");
  const scroller = useScroller();
  const line = useRef<HTMLButtonElement>(null);
  const anchor = useRef<number | null>(null);
  const anchoring = useRef<string | null>(null);

  // the line stays under the finger: the records open below it, and the thread must not follow its end meanwhile
  const pin = () => {
    const el = scroller?.current;
    const btn = line.current;
    const before = anchor.current;
    if (!el || !btn || before === null) return;
    holdScroll(el, 250);
    const d = btn.getBoundingClientRect().top - before;
    if (Math.abs(d) > 0.5) el.scrollTop += d;
  };
  const settle = () => {
    pin();
    setMoving(false);
    anchor.current = null;
    const el = scroller?.current;
    if (el && anchoring.current !== null) el.style.overflowAnchor = anchoring.current;
    anchoring.current = null;
  };
  const toggle = () => {
    const el = scroller?.current;
    anchor.current = line.current?.getBoundingClientRect().top ?? null;
    if (el && anchoring.current === null) {
      anchoring.current = el.style.overflowAnchor;
      el.style.overflowAnchor = "none"; // ours is the only anchoring: the browser's would correct the same move twice
    }
    const next = !open;
    folds?.set(id, next);
    setMoving(true);
    setOpenState(next);
  };
  useLayoutEffect(() => {
    if (anchor.current === null) return;
    pin();
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(
    () => () => {
      // unmounted mid-move (the draft became the final message): give the scroller its own anchoring back
      const el = scroller?.current;
      if (el && anchoring.current !== null) el.style.overflowAnchor = anchoring.current;
    },
    [], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const errors = tools.filter((x) => x.state === "error").length;
  const waiting = [...tools].reverse().find((x) => x.state === "needs_approval" || x.state === "needs_credential");
  const running = tools.filter((x) => x.state === "running");
  const current = live ? (waiting ?? running[running.length - 1]) : undefined;

  let state: string;
  let copy: ReactNode;
  let key: string;
  let glyph: ReactNode = null;
  let glyphKey = "none";
  if (current) {
    state = current.state;
    const label = current.state === "needs_approval" ? "승인이 필요해요" : current.state === "needs_credential" ? "로그인 정보가 필요해요" : statusOf(current);
    const more = current.state === "running" ? running.length - 1 : 0;
    key = `${state}:${label}:${more}`;
    copy = (
      <span className="tools-line-copy">
        <span className="tools-line-main">{label}</span>
        {more > 0 && <span className="tools-line-more tnum">{`\u00a0외 ${more}개`}</span>}
      </span>
    );
    glyphKey = current.state;
    glyph = current.state === "running" ? <Ring /> : <Icon name={current.state === "needs_approval" ? "lock" : "key"} size={15} weight="medium" />;
  } else {
    state = "done";
    const sources = [...new Set(folded.map(foldSource).filter((s): s is string => !!s))];
    const main = folded.length ? `자료 ${folded.length}개 보기` : stepsLabel(tools);
    key = `done:${main}:${sources.join(",")}`;
    copy = (
      <span className="tools-line-copy">
        <span className={`tools-line-main tnum${folded.length > 0 && sources.length > 0 ? " is-fixed" : ""}`}>{main}</span>
        {/* no-break space: a flex item drops a leading plain one */}
        {folded.length > 0 && sources.length > 0 && <span className="tools-line-src">{`\u00a0· ${sources.join(", ")}`}</span>}
      </span>
    );
    if (!face) {
      glyphKey = errors ? "err" : "check";
      glyph = <Icon name={errors ? "exclamation" : "check-circle"} size={16} weight="medium" />;
    }
  }

  return (
    <div className="tools-fold" data-open={open || undefined}>
      <button
        ref={line}
        type="button"
        className="tools-line turn-head"
        data-state={state}
        data-errors={errors || undefined}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={toggle}
      >
        {face && <Avatar spec={face} size={22} breathing={live} />}
        {/* the ring (or the friend-thread check) has its own slot; empty, it gives back the row's gap too */}
        <motion.span className="tools-line-glyph" aria-hidden="true" initial={false} animate={{ width: glyph ? 18 : 0, marginRight: glyph ? 0 : -8 }} transition={t("morph")}>
          <ContentSwap swapKey={glyphKey}>{glyph ?? <span />}</ContentSwap>
        </motion.span>
        <ContentSwap swapKey={key} className="tools-line-text">
          {copy}
        </ContentSwap>
        {errors > 0 && !current && <span className="tools-line-err tnum">오류 {errors}</span>}
        <motion.span className="tools-line-chev" layout="position" animate={{ rotate: open ? 180 : 0 }} transition={t("snap")} aria-hidden="true">
          <Icon name="chevron-down" size={14} weight="medium" />
        </motion.span>
      </button>
      <AnimatePresence initial={false} onExitComplete={settle}>
        {open && (
          <motion.div
            key="panel"
            id={panelId}
            className="tools-panel"
            data-moving={moving || undefined}
            role="region"
            aria-label={folded.length ? `자료 ${folded.length}개` : "진행한 단계"}
            initial={{ height: 0 }}
            animate={{ height: "auto" }}
            exit={{ height: 0 }}
            transition={t("morph")}
            onUpdate={pin}
            onAnimationComplete={(def) => {
              if (typeof def === "object" && !Array.isArray(def) && (def as { height?: unknown }).height === "auto") settle();
            }}
          >
            <motion.div
              className="tools-panel-in"
              initial={{ opacity: 0, y: -6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, transition: reduce ? { duration: 0 } : EXIT }}
              transition={reduce ? { duration: 0 } : { ...SPRING.morph, delay: CONTENT_DELAY }}
            >
              {folded.map((c) => (
                <CardView key={foldKey(c, cards)} card={c} messageId={id} threadId={threadId} tools={tools} onSend={onSend} interactive={interactive} />
              ))}
              {tools.length > 0 && <Steps tools={tools} cards={folded} caption={folded.length ? stepsLabel(tools) : null} />}
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
});

/** a folded card's key: its type and place among the turn's cards (records carry no id of their own) */
const foldKey = (c: Card, cards: Card[]) => `${c.type}:${cards.indexOf(c)}`;

/** "2단계 · 1분 33초" from the first start to the last end */
function stepsLabel(tools: ToolActivity[]): string {
  if (!tools.length) return "";
  const start = Math.min(...tools.map((x) => x.startedAt));
  const end = Math.max(...tools.map((x) => x.endedAt ?? x.startedAt));
  return stepsSummary(tools.length, end - start);
}

/** a running tool in the agent-state vocabulary ("뉴스 찾는 중"); a tool it has no word for says its own title */
function statusOf(tool: ToolActivity): string {
  const said = toolLabel(tool.name, tool.title);
  return said === "작업하는 중" && tool.title ? tool.title : said;
}

function Steps({ tools, cards, caption }: { tools: ToolActivity[]; cards: Card[]; caption: string | null }) {
  return (
    <div className="tools-steps-wrap">
      {caption && <p className="tools-steps-cap tnum">{caption}</p>}
      <ol className="tools-steps">
        {tools.map((tool) => (
          <li key={tool.id} className="tools-step" data-state={tool.state}>
            <span className="tools-step-icon" aria-hidden="true">
              <Icon name={tool.state === "error" ? "exclamation" : tool.state === "done" ? "checkmark" : "clock"} size={14} weight="semibold" />
            </span>
            <span className="tools-step-body">
              <span className="tools-step-title">{tool.title || toolLabel(tool.name, tool.title)}</span>
              {tool.summary && <span className="tools-step-sum">{tool.summary}</span>}
              <span className="tools-step-meta tnum">
                {[sourceFor(tool, cards), tool.endedAt ? durationKo(tool.endedAt - tool.startedAt) : null].filter(Boolean).join(" · ")}
              </span>
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function sourceFor(tool: ToolActivity, cards?: Card[]): string | undefined {
  if (tool.name === "k_weather") {
    const w = cards?.find((c) => c.type === "weather");
    if (w && w.type === "weather" && w.source) return w.source;
  }
  return toolSource(tool.name, tool.title);
}

/** One SVG ring rotating only while in flight (the busy loop is allowed under reduced motion). */
function Ring() {
  return (
    <svg className="tool-ring" data-loop="busy" width="16" height="16" viewBox="0 0 16 16" fill="none">
      <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeOpacity="0.22" strokeWidth="1.8" />
      <path d="M8 1.5a6.5 6.5 0 0 1 6.5 6.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}
