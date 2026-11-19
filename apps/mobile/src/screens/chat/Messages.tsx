import type { AttachmentRef, AvatarSpec, Card as ProtoCard, ID, Message, Thread, ToolActivity } from "@pickle/protocol";
import { motion } from "framer-motion";
import { memo, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { tokenUrl } from "../../api/client";
import * as ep from "../../api/endpoints";
import type { StreamingDraft } from "../../api/store";
import { island, useIsland } from "../../app/island";
import { ContentSwap } from "../../motion/ContentSwap";
import { t } from "../../motion/springs";
import { Avatar } from "../../ui/Avatar";
import { Icon } from "../../ui/Icon";
import { fitBubble, heldPieces, HOLD } from "./bubbleFit";
import { CardView, foldable } from "./cards/CardView";
import { markScheduleUndone } from "./cards/InfoCards";
import { turnStarted, useAwaitingFollowUp, useReceipt } from "./composerStore";
import { Markdown } from "./markdown";
import { commitPoint, StreamText } from "./StreamText";
import { TurnFold } from "./ToolChips";
import { clockKo, dayClockKo, josa } from "./util";

/**
 * Message rows. User bubbles are neutral fill (no accent). The assistant speaks in plain text on the canvas and only
 * its records (cards) are paper (chat B, DESIGN "plain text for conversation, paper for records"); each of its turns
 * opens with its face (TurnHead). Friend threads tell the four authors apart by avatar + name + alignment (never
 * colour alone, research 9-1).
 */
export interface RowContext {
  threadId: ID;
  thread: Thread | undefined;
  agentName: string;
  agentSpec: AvatarSpec;
  onSend: (text: string) => void;
  onRetry: (id: ID) => void;
  /** which turns' lines are open (message id → open), for as long as the thread is on screen (TurnFold) */
  folds?: Map<ID, boolean>;
}

function hueOf(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h % 360;
}
/** a friend's face: the same one beside their bubbles and on their empty thread */
export const peerFace = (userId: string | undefined): AvatarSpec => ({ hue: hueOf(userId ?? "p"), shape: "round", eyes: "dot" });

export function DateSeparator({ at }: { at: number }) {
  return (
    <div className="msg-sep" role="separator">
      <span className="tnum">{dayClockKo(at)}</span>
    </div>
  );
}

export const MessageRow = memo(function MessageRow({
  m,
  ctx,
  failed,
  error,
  fresh,
  live = false,
  streaming = false,
}: {
  m: Message;
  ctx: RowContext;
  failed: boolean;
  error?: string;
  fresh: boolean;
  /** the running answer (ThreadView builds `m` from the live draft) */
  live?: boolean;
  streaming?: boolean;
}) {
  const author = m.author?.kind;
  const friend = ctx.thread?.kind === "friend";
  const enter = fresh ? { initial: { opacity: 0, y: 6 }, animate: { opacity: 1, y: 0 }, transition: t("snap") } : {};

  // The running answer, keyed by the message id the final message keeps: the same element tree as the answer row at the
  // end of this function, so when the reply finishes React keeps every node. Its cards are not built again (an html
  // card rebuilt from its placeholder jumped: 591 → 1,557 → 591 px in Chrome, two frames at 0 px in reduced motion,
  // and the shrink moved the reader's place in WebKit).
  if (live) {
    return (
      <motion.div className="msg-row msg-asst msg-live" aria-busy={streaming || undefined}>
        <AssistantBody id={m.id} text={m.text} tools={m.tools} cards={m.cards} live ctx={ctx} face={friend ? null : ctx.agentSpec} />
      </motion.div>
    );
  }

  if (m.role === "event") {
    return (
      <motion.div className="msg-event" {...enter}>
        <span>{m.text}</span>
      </motion.div>
    );
  }

  const mine = m.role === "user" && (!friend || author === "me" || !author);
  if (mine) {
    return (
      <motion.div className="msg-row msg-me" data-failed={failed || undefined} {...enter}>
        <div className="bubble bubble-me">
          {m.attachments.length > 0 && <Attachments items={m.attachments} />}
          {m.text && <BubbleText text={m.text} fit={!m.attachments.length} />}
        </div>
        {failed ? (
          <div className="msg-failed" role="alert">
            <span className="msg-failed-text">
              <Icon name="exclamation" size={14} weight="semibold" />
              {error ?? "보내지 못했어요"}
            </span>
            <button type="button" className="msg-retry" onClick={() => ctx.onRetry(m.id)}>
              <Icon name="refresh" size={14} weight="medium" />
              다시 보내기
            </button>
          </div>
        ) : (
          <ReceiptLine id={m.id} at={m.createdAt} />
        )}
      </motion.div>
    );
  }

  // friend thread: peer (human) bubble on the left
  if (friend && author === "peer") {
    return (
      <motion.div className="msg-row msg-other" data-author="peer" {...enter}>
        <Avatar spec={peerFace(ctx.thread?.peer?.userId)} size={30} breathing={false} />
        <div className="msg-col">
          <span className="msg-author">{m.author?.name ?? `${ctx.thread?.peer?.displayName ?? "친구"} 님`}</span>
          <div className="bubble bubble-peer">
            {m.attachments.length > 0 && <Attachments items={m.attachments} />}
            {m.text && <BubbleText text={m.text} fit={!m.attachments.length} />}
          </div>
        </div>
      </motion.div>
    );
  }

  const peerAgent = friend && author === "peer-agent";
  // friend threads already put each author's face beside the row; the main/task thread's turn head carries it
  const body = <AssistantBody id={m.id} text={m.text} tools={m.tools} cards={m.cards} live={false} ctx={ctx} interactive={!peerAgent} face={friend ? null : ctx.agentSpec} />;
  if (friend) {
    const spec: AvatarSpec = peerAgent ? { hue: hueOf(`${ctx.thread?.peer?.userId ?? "p"}:agent`), shape: "drop", eyes: "oval" } : ctx.agentSpec;
    return (
      <motion.div className="msg-row msg-other" data-author={author ?? "my-agent"} {...enter}>
        <Avatar spec={spec} size={30} breathing={false} />
        <div className="msg-col">
          <span className="msg-author">{m.author?.name ?? ctx.agentName}</span>
          {body}
        </div>
      </motion.div>
    );
  }
  return (
    <motion.div className="msg-row msg-asst" {...enter}>
      {body}
    </motion.div>
  );
});

/** a bubble's words; a last line of one or two characters is pulled up by narrowing the bubble (bubbleFit.ts). Not
 * under photos or files: they set the bubble's width there. A stretch between spaces with two emoji side by side
 * ("봤어🔥🔥!") is one box, so no line ends inside it. */
function BubbleText({ text, fit }: { text: string; fit: boolean }) {
  const ref = useRef<HTMLParagraphElement>(null);
  useLayoutEffect(() => (fit && ref.current ? fitBubble(ref.current) : undefined), [text, fit]);
  const pieces = heldPieces(text);
  return (
    <p ref={ref} className="bubble-text" data-lines="prose">
      {pieces.length === 1
        ? text
        : pieces.map((part, i) =>
            i % 2 === 1 ? (
              <span key={i} className={HOLD}>
                {part}
              </span>
            ) : (
              part
            ),
          )}
    </p>
  );
}

function ReceiptLine({ id, at }: { id: ID; at: number }) {
  const r = useReceipt(id);
  if (!r) return null;
  return <span className="msg-receipt">{r === "steered" ? "하던 일에 이어서 전했어요" : `전달됨 · ${clockKo(at)}`}</span>;
}

/**
 * The head of an assistant turn (chat B): the agent's face, 22 px, breathing only while it works (§8.11), then one
 * line — the wait status while nothing has arrived, nothing while it answers. A turn with tool calls or records shows
 * the same head as its one line instead (TurnFold: the status, then "자료 3개 보기" / "2단계 · 1분 33초"), so the
 * face never moves between the two.
 */
export function TurnHead({ spec, busy = false, children }: { spec: AvatarSpec; busy?: boolean; children?: ReactNode }) {
  return (
    <div className="turn-head">
      <Avatar spec={spec} size={22} breathing={busy} />
      {children}
    </div>
  );
}

export function AssistantBody({
  id,
  text,
  tools,
  cards,
  live,
  ctx,
  interactive = true,
  face = null,
}: {
  id: ID;
  text: string;
  tools: ToolActivity[];
  cards: ProtoCard[];
  live: boolean;
  ctx: RowContext;
  interactive?: boolean;
  /** the turn head's face; null in friend threads, whose rows carry the author's avatar and name already */
  face?: AvatarSpec | null;
}) {
  const shown = live ? commitPoint(text) : text;
  // the turn's line (tool status → the folded records and steps) comes first and the answer right after it; only
  // the cards that ask something of the person stay open, under the answer
  const line = tools.length > 0 || cards.some(foldable);
  return (
    <div className="asst">
      {face && !line && <TurnHead spec={face} busy={live} />}
      {line && <TurnFold id={id} tools={tools} live={live} cards={cards} face={face} folds={ctx.folds} threadId={ctx.threadId} onSend={ctx.onSend} interactive={interactive} />}
      {/* data-lines="prose": flowing talk, so the QA line checker (qa/lib/lines.mjs) skips its sentence-split rule here;
          the cards and the tool line beside it are UI copy and stay fully checked */}
      {shown.trim() && (
        <div className="asst-text" data-lines="prose">
          {live ? <StreamText text={text} /> : <Markdown text={text} />}
        </div>
      )}
      {cards.map((c, i) =>
        foldable(c) ? null : <CardView key={cardKey(c, i)} card={c} index={i} messageId={id} threadId={ctx.threadId} tools={tools} onSend={ctx.onSend} interactive={interactive} />,
      )}
    </div>
  );
}

function cardKey(c: ProtoCard, i: number) {
  if (c.type === "approval") return `ap:${c.approvalId}`;
  if (c.type === "artifact") return `ar:${c.artifactId}`;
  if (c.type === "schedule") return `sc:${c.scheduleId}`;
  if (c.type === "credential_request") return `cr:${c.service}:${i}`;
  return `${c.type}:${i}`;
}

function Attachments({ items }: { items: AttachmentRef[] }) {
  return (
    <div className="bubble-files">
      {items.map((a) =>
        a.mime.startsWith("image/") ? (
          <a key={a.id} href={tokenUrl(a.url)} target="_blank" rel="noopener noreferrer" className="bubble-img-link">
            <img className="bubble-img" src={tokenUrl(a.url)} alt={a.filename} loading="lazy" />
          </a>
        ) : (
          <a key={a.id} href={tokenUrl(a.url)} target="_blank" rel="noopener noreferrer" className="bubble-file">
            <Icon name="doc" size={18} />
            <span>{a.filename}</span>
          </a>
        ),
      )}
    </div>
  );
}

// ── the live turn ──

const seenSchedules = new Set<ID>();

/** Low-risk actions are done at once and offered back with a 5 s undo (MOTION-SPEC §8.6). */
export function offerScheduleUndo(cards: ProtoCard[]) {
  for (const c of cards) {
    if (c.type !== "schedule" || seenSchedules.has(c.scheduleId)) continue;
    seenSchedules.add(c.scheduleId);
    island.undo({
      title: `${josa(c.title, "을", "를")} 예약했어요`,
      body: c.when,
      icon: "clock",
      onUndo: () => {
        void ep
          .deleteSchedule(c.scheduleId)
          .then(() => {
            markScheduleUndone(c.scheduleId);
            island.banner({ icon: "clock", title: "예약을 취소했어요", body: c.title });
          })
          .catch((e: Error) => island.errorBanner(e.message, "예약을 취소하지 못했어요"));
      },
    });
  }
}
export const markSchedulesSeen = (cards: ProtoCard[]) => {
  for (const c of cards) if (c.type === "schedule") seenSchedules.add(c.scheduleId);
};

/** the live draft has something to show (a committed line, a tool, a card): from then on it is a row of the list */
export const draftHasContent = (draft: StreamingDraft | null): boolean =>
  !!draft && (!!commitPoint(draft.text).trim() || draft.tools.length > 0 || draft.cards.length > 0);

/**
 * The running turn (MOTION-SPEC §8.4 first-token timeline): 0–150 ms nothing → the turn head with a still one-line
 * placeholder → at 1 s the status text → from 2 s the elapsed seconds → after 15 s without events "오래 걸리고
 * 있어요 · 멈추기". The head is the one the answer keeps: the face stays put and the first line lands under it.
 */
export function DraftRow({ draft, streaming, ctx, onStop }: { draft: StreamingDraft | null; streaming: boolean; ctx: RowContext; onStop: () => void }) {
  const [now, setNow] = useState(() => performance.now());
  const started = turnStarted.get(ctx.threadId) ?? now;
  const stalled = useIsland((s) => s.stalled && s.threadId === ctx.threadId);
  const hasContent = draftHasContent(draft);
  const elapsed = now - started;

  useEffect(() => {
    if (!streaming || hasContent) return;
    // tick at the timeline's marks, then every second for the elapsed count
    const marks = [120, 1000, 2000].map((m) => m - (performance.now() - started)).filter((d) => d > 0);
    const timers = marks.map((d) => setTimeout(() => setNow(performance.now()), d + 4));
    const id = setInterval(() => setNow(performance.now()), 1000);
    return () => {
      timers.forEach(clearTimeout);
      clearInterval(id);
    };
  }, [streaming, hasContent, started]);

  useEffect(() => {
    if (draft?.cards.length) offerScheduleUndo(draft.cards);
  }, [draft?.cards]);

  // with content the answer is a row of the list (ThreadView → MessageRow live), so the final message takes it over
  if ((!streaming && !draft) || hasContent) return null;
  if (!streaming || elapsed < 120) return null;
  const status = draft?.status || "생각하는 중";
  const secs = Math.floor(elapsed / 1000);
  return (
    <div className="msg-row msg-asst msg-live" data-placeholder="" aria-busy="true">
      <div className="asst asst-wait">
        <WaitHead spec={ctx.thread?.kind === "friend" ? null : ctx.agentSpec}>
          {elapsed < 1000 ? (
            <span className="wait-line" aria-hidden="true" />
          ) : (
            <span className="wait-status">
              <ContentSwap swapKey={status}>{status}</ContentSwap>
              {secs >= 2 && <span className="wait-secs tnum"> · {secs}초</span>}
            </span>
          )}
        </WaitHead>
        {stalled && (
          <span className="wait-stall">
            오래 걸리고 있어요 ·{" "}
            <button type="button" className="wait-stop" onClick={onStop}>
              멈추기
            </button>
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * A steered message the running turn finished before reading: the server answers it in a follow-up turn (the agent
 * is busy, the island says so) whose result only arrives as a `message` event. `tail` = the last few "id:role" pairs. Without this row the thread would sit silent (only the island would say
 * anything) — so while that follow-up runs, the thread shows the same quiet status line a fresh turn shows.
 */
export function FollowUpRow({ tail, streaming, spec }: { tail: string; streaming: boolean; spec: AvatarSpec | null }) {
  const steered = useAwaitingFollowUp(tail);
  const busy = useIsland((s) => s.remote && (s.kind === "thinking" || s.kind === "tool" || s.kind === "streaming"));
  const secs = useIsland((s) => s.elapsed);
  const tool = useIsland((s) => (s.kind === "tool" ? s.text : ""));
  if (streaming || !steered || !busy) return null;
  const status = tool || "이어서 하는 중";
  return (
    <motion.div className="msg-row msg-asst msg-follow" data-follow="" aria-busy="true" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={t("fade")}>
      <div className="asst asst-wait">
        <WaitHead spec={spec}>
          <span className="wait-status">
            <ContentSwap swapKey={status}>{status}</ContentSwap>
            {secs >= 2 && <span className="wait-secs tnum"> · {secs}초</span>}
          </span>
        </WaitHead>
      </div>
    </motion.div>
  );
}

/** the wait line in the turn head (friend threads have no face there: the line stands alone) */
function WaitHead({ spec, children }: { spec: AvatarSpec | null; children: ReactNode }) {
  return spec ? (
    <TurnHead spec={spec} busy>
      {children}
    </TurnHead>
  ) : (
    <div className="turn-head">{children}</div>
  );
}
