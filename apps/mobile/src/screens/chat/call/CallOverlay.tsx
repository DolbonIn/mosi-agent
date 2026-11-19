import { AnimatePresence, motion, useAnimate, usePresence } from "framer-motion";
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { useAgent } from "../../../api/store";
import { getDeviceRect, getOverlayEl, setOverlay } from "../../../app/device";
import { haptic } from "../../../motion/haptics";
import { CONTENT_DELAY, EXIT, SPRING, t } from "../../../motion/springs";
import { useTierValue } from "../../../motion/tier";
import { AgentBlobLazy } from "../../../ui/AgentBlobLazy";
import { DEFAULT_AVATAR } from "../../../ui/Avatar";
import { R } from "../../../ui/geometry";
import { Icon } from "../../../ui/Icon";
import { josa } from "../util";
import { endCall, PHASE_TEXT, say, setCallOpen, takeCallSource, toggleMute, toggleSpeaker, useCall } from "./callStore";
import "./call.css";

/**
 * The call card: the Dynamic Island grown to the full device (MOTION-SPEC §5/§6.10). Started from the composer's call
 * circle, the circle first stretches into the island's capsule (`snap`), then the island opens to the whole device
 * (`camera`, clip-path inset → full); reopened from the island it grows straight out of it. Black like the island it
 * grows from. Closing (minimise or end) folds it toward the island on `snap` while the surface fades out in 160 ms, so
 * nothing blank stays on screen, and taps pass through from the first frame of the exit. The character is the face
 * of the call: it reads the REAL level (the mic while listening, the voice's output while it speaks; no other meter on
 * the card), and the name and what it is doing sit right under it, so "생각하는 중" changes where the eye already is.
 * The top keeps only the minimise chevron (the island above it runs the timer). The transcript is start-aligned in a
 * full-width column, every line the same size and weight, the current one in the label colour and earlier ones dim,
 * so streamed text grows in place and nothing slides sideways. Controls are 64 px: 음소거 and 스피커 keep their names
 * and show their state by fill (88 % label) and aria-pressed; end is the only red (--call-end, both themes).
 * Without STT (or with the mic denied) a text field lets the person type and still talk in voice mode.
 */

/** the closing fade: decelerating, so the surface is nearly gone well before it ends (≤ 0.05 by ~120 ms of 160) */
const FADE_OUT: [number, number, number, number] = [0, 0, 0.2, 1];

function islandInset(): string {
  const d = getDeviceRect();
  const el = document.querySelector<HTMLElement>(".island");
  const r = el?.getBoundingClientRect();
  const top = r ? r.top - d.top : 11;
  const w = 236;
  const h = 37;
  const side = Math.max(0, (d.width - w) / 2);
  return `inset(${top.toFixed(1)}px ${side.toFixed(1)}px ${(d.height - top - h).toFixed(1)}px ${side.toFixed(1)}px round 18.5px)`;
}

/** a rect (viewport coords) as a clip-path inset of the device, fully rounded */
function rectInset(r: DOMRect): string {
  const d = getDeviceRect();
  const top = r.top - d.top;
  const left = r.left - d.left;
  return `inset(${top.toFixed(1)}px ${(d.width - left - r.width).toFixed(1)}px ${(d.height - top - r.height).toFixed(1)}px ${left.toFixed(1)}px round ${(Math.min(r.width, r.height) / 2).toFixed(1)}px)`;
}

export function CallOverlay() {
  const open = useCall((s) => s.active && s.open);
  const target = getOverlayEl();
  useEffect(() => {
    setOverlay("sheet:call", open);
    return () => setOverlay("sheet:call", false);
  }, [open]);
  if (!target) return null;
  return createPortal(<AnimatePresence>{open && <CallCard key="call" />}</AnimatePresence>, target);
}

function CallCard() {
  const s = useCall();
  const agent = useAgent();
  const reduce = useTierValue("reduceMotion");
  const [from] = useState(islandInset);
  const [source] = useState(takeCallSource);
  const [radius] = useState(() => (getDeviceRect().width >= 400 ? R.device : 0)); // the framed device's corners; none full-bleed
  const [card, animate] = useAnimate<HTMLDivElement>();
  const [isPresent, safeToRemove] = usePresence();
  const closes = useRef(0); // closes started on this node
  const closing = useRef(0); // the close running now (0: none)
  const name = agent?.name ?? "깽이";

  useLayoutEffect(() => {
    card.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setCallOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const full = `inset(0px 0px 0px 0px round ${radius}px)`;
  const start = source ? rectInset(source) : from;

  // circle → island capsule → whole device (two springs, one element)
  useLayoutEffect(() => {
    const el = card.current;
    if (!el || reduce) return;
    let alive = true;
    void (async () => {
      // explicit [from, to] pairs: the browser hands back a normalised inset() (3 lengths when left = right), which
      // would not interpolate against our 4-length strings
      if (source) await animate(el, { clipPath: [start, from] }, SPRING.snap);
      // not if it was closed while still a capsule (the close owns the clip-path from then on)
      if (alive && closes.current === 0) await animate(el, { clipPath: [from, full] }, SPRING.camera);
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // closing (minimise or end): taps pass through from the first frame, the surface folds toward the island on `snap`
  // while it fades out in 160 ms (120 ms reduced), and the card unmounts the moment it reaches 0 — not when the fold
  // settles — so no blank card lingers. Driven here rather than by `exit`, which would wait for the spring as well.
  useEffect(() => {
    const el = card.current;
    if (isPresent) {
      if (!closing.current || !el) return; // mounting: the open sequence above runs
      // reopened mid-close (AnimatePresence kept the node): grow straight back
      closing.current = 0;
      el.style.pointerEvents = "";
      void animate(el, { opacity: 1 }, { duration: 0.16, ease: FADE_OUT });
      if (!reduce) void animate(el, { clipPath: full }, SPRING.camera);
      return;
    }
    if (!el) {
      safeToRemove?.();
      return;
    }
    const id = (closing.current = ++closes.current);
    el.style.pointerEvents = "none";
    if (!reduce) void animate(el, { clipPath: islandInset() }, SPRING.snap);
    void animate(el, { opacity: 0 }, { duration: reduce ? 0.12 : 0.16, ease: FADE_OUT }).then(() => {
      if (closing.current === id) safeToRemove?.();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPresent]);

  const visible = s.lines.filter((l) => l.text).slice(-5);
  const lastSpoken = [...visible].reverse().find((l) => l.who !== "note");

  return (
    <motion.div
      ref={card}
      className="call-card"
      data-phase={s.phase}
      data-voice={s.voice ?? undefined}
      role="dialog"
      aria-modal="true"
      aria-label={`${josa(name, "과", "와")} 통화`}
      initial={reduce ? { opacity: 0 } : { clipPath: start }}
      animate={reduce ? { opacity: 1 } : undefined}
      transition={reduce ? { duration: 0.12 } : SPRING.camera}
    >
      <motion.div
        className="call-inner"
        initial={{ opacity: 0, y: reduce ? 0 : 8 }}
        animate={{ opacity: 1, y: 0, transition: { ...t("morph"), delay: reduce ? 0 : CONTENT_DELAY + 0.1 } }}
        exit={{ opacity: 0, transition: EXIT }}
      >
        {/* only the chevron: the island at the top of the card runs the call timer (the card is the island grown) */}
        <header className="call-head">
          <button type="button" className="call-min" aria-label="통화 화면 접기" data-autofocus onClick={() => setCallOpen(false)}>
            <Icon name="chevron-down" size={22} weight="medium" />
          </button>
        </header>

        <div className="call-stage">
          {/* decorative here: the name is the caption right under it */}
          <AgentBlobLazy size={208} spec={agent?.avatar ?? DEFAULT_AVATAR} amplitude={s.level} />
          <div className="call-who">
            <span className="call-name">{name}</span>
            <span className="call-phase" aria-live="polite">
              {s.phase === "connecting" && <span className="call-ring" data-loop="busy" aria-hidden="true" />}
              {PHASE_TEXT[s.phase]}
            </span>
          </div>
        </div>

        <ol className="call-transcript" aria-label="자막" aria-live="polite">
          <AnimatePresence initial={false}>
            {visible.map((l) => (
              <motion.li
                key={l.id}
                className="call-line"
                data-line={l.id}
                data-who={l.who}
                data-current={l === lastSpoken || undefined}
                // lines only ever move up (a new one joins at the bottom of the column): x never changes — the column
                // is full-width and start-aligned — so this animates y alone; reduced motion: no movement at all
                layout={reduce ? false : "position"}
                initial={{ opacity: 0, y: reduce ? 0 : 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, transition: EXIT }}
                transition={t("fade")}
              >
                {l.who === "me" && <span className="sr-only">나: </span>}
                {l.who === "agent" && <span className="sr-only">{name}: </span>}
                {l.text}
              </motion.li>
            ))}
          </AnimatePresence>
        </ol>

        {s.error && (
          <p className="call-error" role="alert">
            <Icon name="exclamation" size={16} weight="medium" /> {s.error}
          </p>
        )}
        {(!s.support.stt || s.error) && s.phase !== "connecting" && <TypeToTalk disabled={s.phase === "thinking"} />}

        <div className="call-controls">
          <CallButton
            label="음소거"
            icon={s.muted ? "mic-off" : "mic"}
            on={s.muted}
            disabled={s.phase === "connecting"}
            onPress={() => {
              haptic("toggle");
              toggleMute();
            }}
          />
          <CallButton
            label="스피커"
            icon={s.speaker ? "speaker" : "speaker-off"}
            on={s.speaker}
            disabled={!s.support.tts}
            onPress={() => {
              haptic("toggle");
              toggleSpeaker();
            }}
          />
          <CallButton
            label="통화 종료"
            icon="phone"
            end
            onPress={() => {
              haptic("impact");
              endCall();
            }}
          />
        </div>
      </motion.div>
    </motion.div>
  );
}

function CallButton({ label, icon, on, end, disabled, onPress }: { label: string; icon: string; on?: boolean; end?: boolean; disabled?: boolean; onPress: () => void }) {
  return (
    <div className="call-btn-wrap">
      <button type="button" className="call-btn" data-on={on || undefined} data-end={end || undefined} aria-pressed={end ? undefined : !!on} aria-label={label} disabled={disabled} onClick={onPress}>
        <Icon name={icon} size={26} weight="medium" />
      </button>
      <span className="call-btn-label" aria-hidden="true">
        {label}
      </span>
    </div>
  );
}

function TypeToTalk({ disabled }: { disabled: boolean }) {
  const [text, setText] = useState("");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim() || disabled) return;
    void say(text);
    setText("");
  };
  return (
    <form className="call-type" onSubmit={submit}>
      <label className="sr-only" htmlFor="call-type-input">
        글자로 말하기
      </label>
      <input id="call-type-input" className="call-type-input" value={text} onChange={(e) => setText(e.target.value)} placeholder="글자로 말하기" enterKeyHint="send" autoComplete="off" />
      <button type="submit" className="call-type-send" aria-label="보내기" disabled={!text.trim() || disabled}>
        <Icon name="arrow-up" size={20} weight="semibold" />
      </button>
    </form>
  );
}
