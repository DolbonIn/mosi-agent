import type { ID, Message } from "@pickle/protocol";
import { AnimatePresence, motion } from "framer-motion";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { cancelTurn, loadMessages, markThreadRead, messagesStore, retryMessage, sendMessage, useAgent, useMessages, useThread, useUi, type SendResult } from "../../api/store";
import { ChromePortal } from "../../app/ChromePortal";
import { island } from "../../app/island";
import { Screen, useScroller } from "../../app/Screen";
import { EXIT, t } from "../../motion/springs";
import { getTier } from "../../motion/tier";
import { DEFAULT_AVATAR } from "../../ui/Avatar";
import { Icon } from "../../ui/Icon";
import { fitAhead } from "./bubbleFit";
import { prewarmAudio } from "./call/audioUnlock";
import { launchCall } from "./call/launch";
import { Composer } from "./Composer";
import { dropStoppedSteers, dropUnansweredSteers, markReceipt, turnStarted, useReceipts } from "./composerStore";
import { EmptyThread } from "./EmptyThread";
import { DateSeparator, DraftRow, draftHasContent, FollowUpRow, markSchedulesSeen, MessageRow, offerScheduleUndo, peerFace, type RowContext } from "./Messages";
import { arrivedBelow, type NewsMark } from "./newsBelow";
import { scrollHeld } from "./scrollHold";
import { needsSeparator } from "./util";
import "./chat.css";

/**
 * One conversation: the chat tab root (기본 채팅) and every pushed "thread" (task / call / schedule / friend).
 * Bottom-anchored list with load-older (scroll position kept), pin-to-latest within 80 px, a "새 메시지" capsule
 * only when something arrived below while reading above (opaque paper, chat B), the live turn (first-token timeline → streaming lines → tool chips → cards),
 * and the composer portalled into the bottom chrome while this screen is the visible one.
 */
export interface ThreadViewProps {
  threadId: ID | null;
  routeKey: string;
  active: boolean;
  header?: ReactNode;
  /** after the last message (e.g. a live meeting's controls) */
  footer?: ReactNode;
}

export function ThreadView({ threadId, routeKey, active, header, footer }: ThreadViewProps) {
  return (
    <Screen routeKey={routeKey} composer className="thread-screen">
      {threadId ? <ThreadBody threadId={threadId} active={active} header={header} footer={footer} /> : <ThreadSkeleton />}
    </Screen>
  );
}

function ThreadSkeleton() {
  return (
    <div className="thread-skel" aria-busy="true" aria-label="대화를 불러오는 중">
      <span className="skel-bubble" />
      <span className="skel-bubble me" />
      <span className="skel-bubble wide" />
    </div>
  );
}

function ThreadBody({ threadId, active, header, footer }: { threadId: ID; active: boolean; header?: ReactNode; footer?: ReactNode }) {
  const scroller = useScroller();
  const data = useMessages(threadId);
  const thread = useThread(threadId);
  const agent = useAgent();
  const ui = useUi();
  const content = useRef<HTMLDivElement>(null);
  const topSentinel = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const lastHeight = useRef(0);
  const firstId = useRef<ID | null>(null);
  const positioned = useRef(false);
  const mountedAt = useRef(Date.now());
  // messages that were on screen as the live draft (the server keeps the stream's id for the final message): their
  // final row takes the draft's place, so it must not enter again — the draft already did, and a second entrance
  // blinks the whole turn from opacity 0 when the reply finishes
  const drafted = useRef(new Set<ID>());
  // where our own last write put the scroll position (its scroll event comes a frame later, when more of the answer
  // may already be in: that event is not the person scrolling away)
  const wrote = useRef(-1);
  // the newest answer (its message id) and whether the person has released it (scrolled past its head, tapped
  // "새 메시지", sent): until then following the end stops where its head rests under the top bar
  const head = useRef<{ key: ID | null; spent: boolean }>({ key: null, spent: false });
  const [newBelow, setNewBelow] = useState(false);
  const [composerH, setComposerH] = useState(56);
  const [sr, setSr] = useState("");


  const agentName = agent?.name ?? "깽이";
  const friend = thread?.kind === "friend";

  // ── load + read ──
  // the call button is here: get the browser's audio stack ready in a quiet moment (see prewarmAudio)
  useEffect(() => {
    if (thread && !friend) prewarmAudio();
  }, [thread, friend]);
  useEffect(() => {
    if (!data.loaded && !data.loading) void loadMessages(threadId);
  }, [threadId, data.loaded, data.loading]);
  useEffect(() => {
    if (active && data.loaded && thread?.unread) markThreadRead(threadId);
  }, [active, data.loaded, thread?.unread, threadId]);

  // ── scrolling ──
  // a smooth scroll to the end is in flight: its intermediate scroll events must not un-pin the list, and content that
  // grows meanwhile (an image decoding, the failed row, the answer arriving) re-targets it instead of being left below
  const seeking = useRef(false);
  const seekTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const scrollToEnd = useCallback(
    (smooth: boolean, of: ID | null = head.current.key) => {
      const el = scroller?.current;
      if (!el) return;
      // the person asked for the latest: the answer they were held at no longer holds the list (a newer one,
      // started meanwhile, still does)
      if (head.current.key === of) head.current.spent = true;
      pinned.current = true;
      setNewBelow(false);
      if (!smooth || getTier().reduceMotion) {
        seeking.current = false;
        // bubbles not fitted yet where it lands are fitted first (bubbleFit hears of a jump only after it is drawn)
        if (content.current) fitAhead(content.current, el.scrollHeight);
        put(el, el.scrollHeight, wrote);
        return;
      }
      seeking.current = true;
      clearTimeout(seekTimer.current);
      seekTimer.current = setTimeout(() => (seeking.current = false), 1500);
      glide(el, content.current, el.scrollHeight);
    },
    [scroller],
  );

  useEffect(() => {
    const el = scroller?.current;
    if (!el) return;
    const onScroll = () => {
      const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
      lastHeight.current = el.scrollHeight;
      if (seeking.current) {
        if (dist < 2) seeking.current = false;
        pinned.current = true;
        return;
      }
      const ours = wrote.current >= 0 && Math.abs(el.scrollTop - wrote.current) < 1;
      wrote.current = -1;
      if (ours) return;
      pinned.current = dist < 80;
      if (!pinned.current) return;
      setNewBelow(false);
      // back at the end below the answer's head: they have it, the end is theirs to follow
      const stop = headStop(el, content.current, head.current);
      if (stop !== null && stop < el.scrollTop - 1) head.current.spent = true;
    };
    // the person takes over: stop chasing the end
    const cancelSeek = () => (seeking.current = false);
    el.addEventListener("scroll", onScroll, { passive: true });
    el.addEventListener("wheel", cancelSeek, { passive: true });
    el.addEventListener("touchstart", cancelSeek, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      el.removeEventListener("wheel", cancelSeek);
      el.removeEventListener("touchstart", cancelSeek);
      clearTimeout(seekTimer.current);
    };
  }, [scroller]);

  // content grows (streamed lines, cards, images) → stay at the latest when pinned
  useEffect(() => {
    const el = scroller?.current;
    const c = content.current;
    if (!el || !c) return;
    const ro = new ResizeObserver(() => {
      // a card that grew under the finger already placed the scroll (scrollHold.ts): keep it, and re-read pinned
      if (scrollHeld(el)) {
        pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        lastHeight.current = el.scrollHeight;
        return;
      }
      if (pinned.current) {
        const stop = headStop(el, content.current, head.current);
        if (stop !== null && stop >= el.scrollTop - 1) {
          // the answer's head has reached the top bar: stay here (the same place with or without motion) and hand the
          // rest to "새 메시지". A head already above (the person scrolled past it) does not hold the list.
          pinned.current = false;
          if (seeking.current) {
            seeking.current = false;
            el.scrollTo({ top: stop, behavior: "smooth" });
          } else put(el, stop, wrote);
          // the live answer's rest is news; a reopened one's is not (the card cut off at the bottom says it goes on)
          if (head.current.key && drafted.current.has(head.current.key)) setNewBelow(true);
        } else if (seeking.current) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
        else put(el, el.scrollHeight, wrote);
      }
      lastHeight.current = el.scrollHeight;
    });
    ro.observe(c);
    return () => ro.disconnect();
  }, [scroller]);

  // something new arrived (a message, streamed text, a card) while reading above → offer "새 메시지"
  // (a card the person expanded also grows the list, but that is not news; nor is a row going away: arrivedBelow)
  const lastId = data.items[data.items.length - 1]?.id ?? null;
  const draftNews = `${data.draft?.text.length ?? 0}:${data.draft?.cards.length ?? 0}:${data.draft?.tools.length ?? 0}`;
  const lastNews = useRef<NewsMark>({ lastId, draft: draftNews, items: data.items });
  useEffect(() => {
    const was = lastNews.current;
    lastNews.current = { lastId, draft: draftNews, items: data.items };
    if (arrivedBelow(was, lastNews.current) && positioned.current && !pinned.current) setNewBelow(true);
  }, [lastId, draftNews, data.items]);

  // the newest answer: the live draft (its id stays the final message's), or the last message when it is an answer
  const lastItem = data.items[data.items.length - 1];
  const headKey = data.draft?.messageId ?? (lastItem?.role === "assistant" ? lastItem.id : null);
  useLayoutEffect(() => {
    if (head.current.key !== headKey) head.current = { key: headKey, spent: false };
  }, [headKey]);

  // first page → start at the end (a newest answer taller than the screen: at its head); older page prepended → keep
  // what was on screen where it was
  useLayoutEffect(() => {
    const el = scroller?.current;
    if (!el || !data.loaded) return;
    const first = data.items[0]?.id ?? null;
    if (!positioned.current) {
      positioned.current = true;
      // a newest answer taller than the screen opens at its head (its first line under the top bar), not at its end;
      // no "새 메시지": nothing new arrived (the card cut off at the bottom says the answer goes on)
      const stop = headStop(el, content.current, head.current);
      put(el, stop ?? el.scrollHeight, wrote);
      pinned.current = stop === null;
      setNewBelow(false);
      lastNews.current = { lastId, draft: draftNews, items: data.items }; // what the first page brings is not news
    } else if (firstId.current && first !== firstId.current && data.items.some((m) => m.id === firstId.current)) {
      el.scrollTop += el.scrollHeight - lastHeight.current;
    }
    firstId.current = first;
    lastHeight.current = el.scrollHeight;
  }, [scroller, data.loaded, data.items]);

  // load older when the top comes near
  const dataRef = useRef(data);
  dataRef.current = data;
  useEffect(() => {
    const el = scroller?.current;
    const s = topSentinel.current;
    if (!el || !s) return;
    const io = new IntersectionObserver(
      ([e]) => {
        if (e?.isIntersecting && positioned.current) {
          const cur = dataRef.current;
          if (cur.hasMore && cur.loaded && !cur.loading) {
            lastHeight.current = el.scrollHeight;
            void loadMessages(threadId, { older: true });
          }
        }
      },
      { root: el, rootMargin: "480px 0px 0px 0px" },
    );
    io.observe(s);
    return () => io.disconnect();
  }, [scroller, threadId, data.loaded, data.items.length]);

  // ── sending ──
  // a turn sent from here came back stopped: the lines steered into it lose "하던 일에 이어서 전했어요" (dropStoppedSteers)
  const ended = useCallback((r: SendResult) => dropStoppedSteers(r, messagesStore.get()[threadId]?.items ?? []), [threadId]);
  const send = useCallback(
    async (text: string, attachmentIds: ID[] = []): Promise<boolean> => {
      if (!data.streaming) turnStarted.set(threadId, performance.now());
      const under = head.current.key;
      requestAnimationFrame(() => scrollToEnd(true, under));
      const r = await sendMessage(threadId, text, { attachmentIds });
      ended(r);
      // 202 steered → the bubble stays and the running turn keeps streaming; 201 delivered → friend thread, no turn.
      // busy (409) / rejected: the store already showed the server's Korean message; keep the composer text.
      if (r.steered && r.message) markReceipt(r.message.id, "steered");
      if (r.delivered && r.message) markReceipt(r.message.id, "delivered");
      return r.keepText;
    },
    [threadId, data.streaming, scrollToEnd, ended],
  );

  const quickSend = useCallback((text: string) => void send(text), [send]);
  const stop = useCallback(() => cancelTurn(threadId), [threadId]);
  const retry = useCallback(
    (id: ID) => {
      turnStarted.set(threadId, performance.now());
      void retryMessage(threadId, id).then(ended);
    },
    [threadId, ended],
  );

  // the island: tapping it while waiting for approval scrolls to the card; stalled → stop
  useEffect(() => {
    if (!active) return;
    island.setHandlers({
      stop: () => cancelTurn(threadId),
      open: (tid) => {
        if (tid && tid !== threadId) return;
        // the newest pending approval (the one the island is waiting on), to the middle of the screen
        const all = content.current?.querySelectorAll<HTMLElement>("[data-approval-pending]");
        const card = all?.length ? all[all.length - 1] : null;
        const el = scroller?.current;
        if (!card || !el) {
          scrollToEnd(true);
          return;
        }
        const r = card.getBoundingClientRect();
        const to = el.scrollTop + r.top - el.getBoundingClientRect().top - el.clientTop - (el.clientHeight - r.height) / 2;
        if (!getTier().reduceMotion) glide(el, content.current, to);
        else {
          if (content.current) fitAhead(content.current, to);
          el.scrollTop = to;
        }
      },
    });
  }, [active, threadId, scrollToEnd, scroller]);

  // low-risk actions finished in this session get their undo banner; history never does
  useEffect(() => {
    for (const m of data.items) {
      if (m.role !== "assistant") continue;
      if (m.createdAt >= mountedAt.current - 2_000) offerScheduleUndo(m.cards);
      else markSchedulesSeen(m.cards);
    }
  }, [data.items]);

  // screen reader: finished sentences of the streaming answer, politely
  const said = useRef(0);
  useEffect(() => {
    const text = data.draft?.text ?? "";
    if (!text) {
      said.current = 0;
      return;
    }
    const upto = Math.max(text.lastIndexOf(". "), text.lastIndexOf("요."), text.lastIndexOf("다."), text.lastIndexOf("\n"), text.lastIndexOf("? "));
    if (upto > said.current + 4) {
      setSr(text.slice(said.current, upto + 2).trim());
      said.current = upto + 2;
    }
  }, [data.draft?.text]);

  // open turn lines, per message, for as long as this thread is on screen: a reload or opening it again starts folded
  const folds = useRef(new Map<ID, boolean>()).current;
  const ctx: RowContext = useMemo(
    () => ({ threadId, thread, agentName, agentSpec: agent?.avatar ?? DEFAULT_AVATAR, onSend: quickSend, onRetry: retry, folds }),
    [threadId, thread, agentName, agent?.avatar, quickSend, retry, folds],
  );

  const items = data.items;
  if (data.draft) drafted.current.add(data.draft.messageId); // idempotent, so a repeated render is harmless
  // the running answer is the list's last row, keyed by the id its final message keeps: when the reply finishes the
  // final message takes over that row in place (MessageRow live)
  const draft = data.draft;
  const live: Message | null =
    draft && draftHasContent(draft) && !items.some((m) => m.id === draft.messageId)
      ? { id: draft.messageId, threadId, role: "assistant", text: draft.text, tools: draft.tools, cards: draft.cards, attachments: [], createdAt: items[items.length - 1]?.createdAt ?? Date.now() }
      : null;
  const failed = new Set(data.failed);
  const lastFailed = data.failed[data.failed.length - 1];
  // the turn failed with nothing of theirs left unsent (the error row below): the lines steered into it go unanswered,
  // so their "하던 일에 이어서 전했어요" goes (before paint, and for good: it stays gone after the next send)
  const turnFailed = !!data.error && !lastFailed && !data.streaming;
  const receipts = useReceipts();
  useLayoutEffect(() => {
    if (turnFailed) dropUnansweredSteers(items.map((m) => [m.id, m.role] as const));
  }, [turnFailed, items, receipts]);
  const empty = data.loaded && !items.length && !data.draft && !data.streaming;
  const placeholder = friend ? `${thread?.peer?.displayName ?? "친구"} 님에게 메시지` : ui.composer.placeholder || "메시지 보내기";
  // the composer sits in the slot above the (static) tab bar
  const bottomPad = `calc(var(--tabbar-bottom) + var(--tabbar-h) + 10px + ${composerH}px + 18px + var(--kb))`;

  useLayoutEffect(() => {
    const el = scroller?.current;
    if (!el) return;
    el.style.paddingBottom = bottomPad;
    el.style.setProperty("--edge-bottom", `calc(var(--tabbar-bottom) + var(--tabbar-h) + 10px + ${composerH}px)`);
    if (pinned.current) put(el, el.scrollHeight, wrote);
  }, [scroller, bottomPad, composerH]);

  return (
    <>
      <div ref={topSentinel} className="thread-top" aria-hidden="true" />
      <div ref={content} className="thread-content" data-thread-kind={thread?.kind}>
        {data.loading && data.loaded && data.hasMore && (
          <div className="thread-older" aria-label="이전 메시지를 불러오는 중">
            <span className="older-ring" data-loop="busy" />
          </div>
        )}
        {!data.hasMore && header}
        {!data.loaded && !items.length && <ThreadSkeleton />}
        {empty && <EmptyThread threadId={threadId} kind={thread?.kind ?? "task"} agentName={agentName} face={friend ? peerFace(thread?.peer?.userId) : (agent?.avatar ?? DEFAULT_AVATAR)} />}
        {[
          ...items.map((m, i) => (
            <Row key={m.id} m={m} prev={items[i - 1]} ctx={ctx} failed={failed.has(m.id)} error={m.id === lastFailed ? data.error : undefined} fresh={m.createdAt > mountedAt.current && !drafted.current.has(m.id)} />
          )),
          live && <Row key={live.id} m={live} prev={items[items.length - 1]} ctx={ctx} failed={false} fresh={false} live streaming={data.streaming} />,
        ]}
        <DraftRow draft={data.draft} streaming={data.streaming} ctx={ctx} onStop={stop} />
        <FollowUpRow tail={items.slice(-4).map((m) => `${m.id}:${m.role}`).join(",")} streaming={data.streaming} spec={friend ? null : ctx.agentSpec} />
        {footer}
        {turnFailed && (
          <div className="thread-error" role="alert">
            <Icon name="exclamation" size={15} weight="medium" />
            {data.error}
          </div>
        )}
      </div>
      <div className="sr-only" aria-live="polite">
        {sr}
      </div>
      {active && (
        <ChromePortal group="bottom">
          <AnimatePresence>
            {newBelow && (
              <motion.div key="jump" className="jump-wrap" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 8, transition: EXIT }} transition={t("morph")}>
                <button type="button" className="jump-latest" onClick={() => scrollToEnd(true)} aria-label="새 메시지로 이동">
                  <Icon name="arrow-up" size={16} weight="semibold" style={{ transform: "rotate(180deg)" }} />
                  새 메시지
                </button>
              </motion.div>
            )}
          </AnimatePresence>
          <MeasuredComposer onHeight={setComposerH}>
            <Composer
              threadId={threadId}
              placeholder={placeholder}
              streaming={data.streaming}
              onSubmit={send}
              onStop={stop}
              onCall={friend ? undefined : (el) => launchCall(threadId, el)}
              mention={friend ? agentName : undefined}
            />
          </MeasuredComposer>
        </ChromePortal>
      )}
    </>
  );
}

/**
 * Glide the list to `top` (a scrollTop). A long way (over three screens) jumps first to a screen and a half short of
 * it and glides the rest (a 7,000 px glide reads as lag). The bubbles where it lands and on the way are fitted first:
 * bubbleFit hears of a jump only after it is drawn, and a fit during a glide stopped the glide in WebKit.
 */
function glide(el: HTMLElement, c: HTMLElement | null, top: number) {
  const to = Math.max(0, Math.min(top, el.scrollHeight - el.clientHeight));
  const far = Math.abs(to - el.scrollTop) > el.clientHeight * 3;
  const land = far ? to - Math.sign(to - el.scrollTop) * el.clientHeight * 1.5 : el.scrollTop;
  if (c) fitAhead(c, land, to);
  if (land !== el.scrollTop) el.scrollTop = land;
  el.scrollTo({ top: to, behavior: "smooth" });
}

/** set the scroll position and note where it landed (a write that moves nothing fires no scroll event) */
function put(el: HTMLElement, top: number, wrote: { current: number }) {
  const before = el.scrollTop;
  el.scrollTop = top;
  if (el.scrollTop !== before) wrote.current = el.scrollTop;
}

/**
 * Where the list stands when the newest answer's head (its turn line or first line) rests under the top bar, at the
 * scroller's top padding like the first row of a thread: null when there is no newest answer, the person released it,
 * or the rest of the thread from its head down fits on the screen (following the end keeps the head in view).
 */
function headStop(el: HTMLElement, c: HTMLElement | null, h: { key: ID | null; spent: boolean }): number | null {
  if (!c || !h.key || h.spent) return null;
  const rows = c.querySelectorAll<HTMLElement>(":scope > .msg-row:not(.msg-follow)");
  const row = rows[rows.length - 1];
  if (!row?.classList.contains("msg-asst")) return null;
  const y = row.offsetParent === el ? row.offsetTop : row.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop;
  const stop = Math.max(0, Math.round(y - (parseFloat(getComputedStyle(el).paddingTop) || 0)));
  return stop < el.scrollHeight - el.clientHeight - 1 ? stop : null;
}

function MeasuredComposer({ onHeight, children }: { onHeight: (h: number) => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => onHeight(Math.round(el.offsetHeight)));
    ro.observe(el);
    onHeight(Math.round(el.offsetHeight));
    return () => ro.disconnect();
  }, [onHeight]);
  return (
    <div ref={ref} className="composer-measure">
      {children}
    </div>
  );
}

function Row({ m, prev, ctx, failed, error, fresh, live, streaming }: { m: Message; prev?: Message; ctx: RowContext; failed: boolean; error?: string; fresh: boolean; live?: boolean; streaming?: boolean }) {
  return (
    <>
      {needsSeparator(prev, m) && <DateSeparator at={m.createdAt} />}
      <MessageRow m={m} ctx={ctx} failed={failed} error={error} fresh={fresh} live={live} streaming={streaming} />
    </>
  );
}

