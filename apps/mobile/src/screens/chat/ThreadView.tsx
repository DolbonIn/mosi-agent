import type { AttachmentRef, ID, Message } from "@pickle/protocol";
import { AnimatePresence, motion } from "framer-motion";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { cancelTurn, loadMessages, markThreadRead, messagesStore, refreshRecent, retryMessage, sendMessage, useAgent, useMessages, useUi, type SendResult } from "../../api/store";
import { ChromePortal } from "../../app/ChromePortal";
import { island } from "../../app/island";
import { Screen, useScroller } from "../../app/Screen";
import { EXIT, t } from "../../motion/springs";
import { getTier, tierStore } from "../../motion/tier";
import { DEFAULT_AVATAR } from "../../ui/Avatar";
import { Icon } from "../../ui/Icon";
import { fitAhead } from "./bubbleFit";
import { prewarmAudio } from "./call/audioUnlock";
import { useKeptThread, useShownThread } from "./catchUp";
import { launchCall } from "./call/launch";
import { Composer } from "./Composer";
import { dropStoppedSteers, errorAnchorOf, errorRowAfter, markReceipt, turnStarted, useErrorWait, useReceipts } from "./composerStore";
import { EmptyThread } from "./EmptyThread";
import { DateSeparator, DraftRow, draftHasContent, FollowUpRow, markSchedulesSeen, MessageRow, offerScheduleUndo, peerFace, type RowContext } from "./Messages";
import { arrivedBelow, type NewsMark } from "./newsBelow";
import { keptScrollTop, olderAnchor, type OlderAnchor } from "./olderPage";
import { rowKeys } from "./rowKeys";
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
  const thread = useKeptThread(threadId);
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
  // an optimistic line and the server row that replaces it are one element (rowKeys)
  const keys = useRef<ReturnType<typeof rowKeys> | null>(null);
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
  // a reconnect may have missed changes (catchUp): on screen, the first page is read again and swapped in
  useShownThread(threadId, active);
  useEffect(() => {
    if (active && data.loaded && data.stale) void refreshRecent(threadId);
  }, [active, data.loaded, data.stale, threadId]);

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

  // the text size changes: the list keeps what was being read (followTextScale). At the end it stays at the end — a
  // newest answer that grows past the screen does not pull the list up to its head — and the next older page keeps its
  // place from the height after the change (load-older), not the one before it
  useEffect(
    () =>
      followTextScale(
        () => {
          const el = scroller?.current;
          const c = content.current;
          if (!el || !c || !positioned.current) return null;
          if (pinned.current) head.current.spent = true;
          return { el, c, atEnd: pinned.current };
        },
        (el, top) => {
          put(el, top, wrote);
          lastHeight.current = el.scrollHeight;
        },
      ),
    [scroller],
  );

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

  // an older page about to go in above: the row at the top of the view, read when the store takes the page (React
  // has not drawn it yet); the prepend below puts it back at its y (olderPage.ts)
  const older = useRef<OlderAnchor | null>(null);
  useEffect(() => {
    const el = scroller?.current;
    if (!el) return;
    return messagesStore.subscribe(() => {
      const items = messagesStore.get()[threadId]?.items;
      const was = firstId.current;
      if (!items?.length || !was || items[0]!.id === was || !items.some((m) => m.id === was) || !content.current) return;
      older.current = olderAnchor(el, content.current);
    });
  }, [scroller, threadId]);

  // first page → start at the end (a newest answer taller than the screen: at its head); older page prepended → keep
  // what was on screen where it was
  const epoch = useRef(data.epoch);
  useLayoutEffect(() => {
    const el = scroller?.current;
    if (!el || !data.loaded) return;
    const first = data.items[0]?.id ?? null;
    if (epoch.current !== data.epoch) {
      // a re-read replaced the pages held (over a page missed): start over at the end, as on opening (its rows don't
      // enter: `since` below)
      epoch.current = data.epoch;
      positioned.current = false;
      firstId.current = null;
    }
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
      const kept = older.current ? keptScrollTop(el.scrollTop, older.current) : null;
      if (kept !== null) el.scrollTop = kept;
      else el.scrollTop += el.scrollHeight - lastHeight.current; // no row to keep (none showed, or it went away)
    }
    older.current = null;
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
    async (text: string, attachments: AttachmentRef[] = []): Promise<boolean> => {
      if (!data.streaming) turnStarted.set(threadId, performance.now());
      const under = head.current.key;
      requestAnimationFrame(() => scrollToEnd(true, under));
      // the files ride on the bubble: a failed send shows them and 다시 보내기 sends the same ids (DD 0121)
      const r = await sendMessage(threadId, text, { attachmentIds: attachments.map((a) => a.id), attachments });
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
  const rows = (keys.current ??= rowKeys())(items);
  // rows newer than the view enter; after a re-read that replaced the pages held, only rows newer than it
  const since = Math.max(mountedAt.current, data.epoch ?? 0);
  // the running answer is the list's last row, keyed by the id its final message keeps: when the reply finishes the
  // final message takes over that row in place (MessageRow live)
  const draft = data.draft;
  const live: Message | null =
    draft && draftHasContent(draft) && !items.some((m) => m.id === draft.messageId)
      ? { id: draft.messageId, threadId, role: "assistant", text: draft.text, tools: draft.tools, cards: draft.cards, attachments: [], createdAt: items[items.length - 1]?.createdAt ?? Date.now() }
      : null;
  const failed = new Set(data.failed);
  const lastFailed = data.failed[data.failed.length - 1];
  // the turn failed with nothing of theirs left unsent (the error row below). The lines it had read lose "하던 일에
  // 이어서 전했어요" when the server names them (`steers_dropped`, composerStore, for any turn that failed); a line it
  // left queued keeps the receipt, a follow-up turn answers it. With such lines just above its place the row waits a
  // moment for that notice (useErrorWait), so no frame draws it above a receipt that is about to go; the wait row stays
  // meanwhile and gives way to it in the same commit (DraftRow held)
  const errorWaits = useErrorWait(threadId);
  const turnFailed = !!data.error && !lastFailed && !data.streaming && !errorWaits;
  const receipts = useReceipts();
  // that row stays with the turn that failed: right after its rows (errorAnchorOf, above the lines it handed to a
  // follow-up turn: errorRowAfter). What comes later (the follow-up's answer, a line from another device, its wait row)
  // goes below it. null: last
  const errorAt = turnFailed ? errorRowAfter(items, errorAnchorOf(threadId), (id) => receipts[id] === "steered") : null;
  const errorRow = turnFailed && (
    <div key="thread-error" className="thread-error" role="alert">
      <Icon name="exclamation" size={15} weight="medium" />
      {data.error}
    </div>
  );
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
          errorAt === -1 && errorRow,
          ...items.flatMap((m, i) => {
            const fresh = rows.freshOf(m, () => m.createdAt > since && !drafted.current.has(m.id));
            const row = <Row key={rows.keyOf(m)} m={m} prev={items[i - 1]} ctx={ctx} failed={failed.has(m.id)} error={m.id === lastFailed ? data.error : undefined} fresh={fresh} />;
            return i === errorAt ? [row, errorRow] : [row];
          }),
          live && <Row key={live.id} m={live} prev={items[items.length - 1]} ctx={ctx} failed={false} fresh={false} live streaming={data.streaming} />,
        ]}
        {/* while the error row waits (errorWaits) the turn's rows stay as they were: its wait row, no follow-up row yet */}
        <DraftRow draft={data.draft} streaming={data.streaming} held={errorWaits} ctx={ctx} onStop={stop} />
        <FollowUpRow tail={items.slice(-4).map((m) => `${m.id}:${m.role}`).join(",")} streaming={data.streaming || errorWaits} spec={friend ? null : ctx.agentSpec} />
        {footer}
        {errorAt === null && errorRow}
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
 * The text size changes (화면 및 디자인 on this device, or another device's settings): the list keeps what was being read.
 * At the end (`atEnd`) it stays at the end; otherwise what is at the top of the view stays at the same y (readPlace: a
 * short row's top, or, inside a long one, the character at the top line). tierStore tells its listeners before tier.ts
 * writes --text-scale, so that place is read at the old size; it is put back once the new size is in (a microtask,
 * still the same task: no frame is drawn in between), then while late layout still moves the list: on each frame, up
 * to 12, until two in a row leave its height alone or the person touches the list, and from a ResizeObserver made at
 * the change (late layout in that same frame, a bubble re-fit above among it, is put back before the frame is drawn).
 * scrollTop is whole pixels and engines floor a fraction (WebKit left a row 0.96 px off), so the target is rounded.
 * The next change (the slider's next step) keeps the same place at the same y while nothing but this has moved the list
 * since, rather than re-reading what was just put back: rounding at every step added up to a pixel over 1.0 → 1.3.
 * Returns the unsubscribe.
 */
export function followTextScale(at: () => { el: HTMLElement; c: HTMLElement; atEnd: boolean } | null, put: (el: HTMLElement, top: number) => void): () => void {
  let scale = tierStore.get().textScale;
  let frame = 0;
  // the place being kept, and where this left the list (`top`): any other scroll since makes the next change read anew
  let held: { el: HTMLElement; atEnd: boolean; mark: Place | null; top: number } | null = null;
  let release = () => {};
  const stopFollowing = () => {
    cancelAnimationFrame(frame);
    release();
    release = () => {};
  };
  const touched = () => {
    stopFollowing();
    held = null;
  };
  const unsub = tierStore.subscribe(() => {
    const next = tierStore.get().textScale;
    if (next === scale) return;
    scale = next;
    stopFollowing();
    const where = at();
    if (!where) return void (held = null);
    const { el, c, atEnd } = where;
    const same = held && held.el === el && held.atEnd === atEnd && held.top === el.scrollTop && (!held.mark || placeMoved(el, held.mark) !== null);
    const place = same && held ? held : { el, atEnd, mark: atEnd ? null : readPlace(el, c), top: el.scrollTop };
    held = place;
    const { mark } = place;
    const keep = () => {
      if (held !== place) return;
      if (atEnd) put(el, el.scrollHeight);
      else if (mark) {
        const dy = placeMoved(el, mark);
        if (dy !== null) put(el, Math.round(el.scrollTop + dy));
      }
      place.top = el.scrollTop;
    };
    queueMicrotask(keep);
    let height = -1;
    let still = 0;
    let n = 0;
    const again = () => {
      keep();
      still = el.scrollHeight === height ? still + 1 : 0;
      height = el.scrollHeight;
      if (++n < 12 && still < 2) frame = requestAnimationFrame(again);
      else stopFollowing();
    };
    frame = requestAnimationFrame(again);
    const ro = typeof ResizeObserver === "function" ? new ResizeObserver(keep) : null;
    ro?.observe(c);
    el.addEventListener("wheel", touched, { passive: true });
    el.addEventListener("touchstart", touched, { passive: true });
    release = () => {
      ro?.disconnect();
      el.removeEventListener("wheel", touched);
      el.removeEventListener("touchstart", touched);
    };
  });
  return () => {
    unsub();
    touched();
  };
}

/** what is kept at its y: a row's top · a character (inside a long row) · a point inside an element (no text there) */
type Place = { row: Element; y: number } | { text: Text; offset: number; y: number } | { part: Element; ratio: number };

/** where the view starts: the scroller's top padding, under the top bar where a thread's first row rests (what is above
 * it fades out under the bar) */
const viewTop = (el: HTMLElement, box: DOMRect) => box.top + (parseFloat(getComputedStyle(el).paddingTop) || 0);
/** how far below the top line the text being read is looked for: the text line most of which shows */
const READ_DEPTH = 8;

/**
 * What is at the top of the view: the first row reaching below the top line. A row starting there: its top. A row the
 * line runs through: the character just below the line (caretRangeFromPoint where the engine has it, else the first
 * character there in reading order), so the text being read stays where it was; keeping the row's top instead pushed
 * that text down by all that grew above it (DD 0007: +688 px at 30 % into a 40-paragraph answer, +67 px at 40 % into
 * a 390 px one). A short row (it fits in the view) cut in its first or last text line, or with no text at the line,
 * is read as a whole: its top while more of it shows than hides above the line, else the next row's top. A long row
 * with no text at the line (a card, an image): the point the line crosses in the innermost element there, as a share
 * of its height.
 */
function readPlace(el: HTMLElement, c: HTMLElement): Place | null {
  const box = el.getBoundingClientRect();
  const line = viewTop(el, box);
  let cut: Element | null = null;
  for (const row of c.children) {
    const r = row.getBoundingClientRect();
    if (!r.height || r.bottom <= line) continue;
    if (r.top >= line - 0.5) return { row, y: r.top - box.top };
    const short = r.height <= box.bottom - line;
    const y = Math.min(line + READ_DEPTH, r.bottom - 1);
    const text = charAt(row, r, y);
    if (short && (!text || onEdgeLine(row, text))) {
      if (line - r.top < r.height / 2) return { row, y: r.top - box.top };
      cut ??= row;
      continue;
    }
    if (text) return { text: text.text, offset: text.offset, y: text.top - box.top };
    let part = (document.elementFromPoint?.((r.left + r.right) / 2, y) as Element | null) ?? null;
    if (!part || !row.contains(part)) part = row;
    const pr = part.getBoundingClientRect();
    return pr.height ? { part, ratio: (line - pr.top) / pr.height } : { part: row, ratio: (line - r.top) / r.height };
  }
  return cut ? { row: cut, y: cut.getBoundingClientRect().top - box.top } : null;
}

/** how far a place has moved since it was read (px, + = down); null when it is gone */
function placeMoved(el: HTMLElement, p: Place): number | null {
  const box = el.getBoundingClientRect();
  if ("row" in p) return p.row.isConnected ? p.row.getBoundingClientRect().top - box.top - p.y : null;
  if ("text" in p) {
    const g = p.text.isConnected ? glyph(p.text, p.offset) : null;
    return g ? g.top - box.top - p.y : null;
  }
  if (!p.part.isConnected) return null;
  const r = p.part.getBoundingClientRect();
  return r.top + p.ratio * r.height - viewTop(el, box);
}

/** one character's box (null for one that draws nothing: a collapsed space, a line break) */
function glyph(text: Text, offset: number): DOMRect | null {
  if (offset < 0 || offset >= text.length) return null;
  const range = document.createRange();
  range.setStart(text, offset);
  range.setEnd(text, offset + 1);
  const r = range.getBoundingClientRect();
  return r.height ? r : null;
}

/** the first character from `offset` on that draws (a few tried: a long run of collapsed spaces gives up) */
function drawnFrom(text: Text, offset: number): Drawn | null {
  for (let i = Math.max(0, offset); i < Math.min(text.length, offset + 8); i++) {
    const g = glyph(text, i);
    if (g) return { text, offset: i, top: g.top, bottom: g.bottom };
  }
  return null;
}

type Drawn = { text: Text; offset: number; top: number; bottom: number };

/** whether a character is on its row's first or last text line (the row's first / last character that draws) */
function onEdgeLine(row: Element, at: Drawn): boolean {
  const walk = document.createTreeWalker(row, 4 /* NodeFilter.SHOW_TEXT */);
  let first: Drawn | null = null;
  let last: Drawn | null = null;
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    const t = n as Text;
    first ??= drawnFrom(t, 0);
    for (let i = t.length - 1; i >= Math.max(0, t.length - 8); i--) {
      const g = glyph(t, i);
      if (g) {
        last = { text: t, offset: i, top: g.top, bottom: g.bottom };
        break;
      }
    }
  }
  const same = (e: Drawn | null) => !!e && Math.abs(e.top - at.top) < Math.min(e.bottom - e.top, at.bottom - at.top) / 2;
  return same(first) || same(last);
}

/** the character at height `y` in a row: where the engine puts the caret (the row's left side), else the first one there */
function charAt(row: Element, r: DOMRect, y: number): Drawn | null {
  const doc = document as Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null; caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null };
  for (const dx of [24, 40, 60, 90, 130]) {
    const x = r.left + dx;
    let node: Node | null = null;
    let offset = 0;
    if (doc.caretRangeFromPoint) {
      const hit = doc.caretRangeFromPoint(x, y);
      if (hit) [node, offset] = [hit.startContainer, hit.startOffset];
    } else if (doc.caretPositionFromPoint) {
      const hit = doc.caretPositionFromPoint(x, y);
      if (hit) [node, offset] = [hit.offsetNode, hit.offset];
    }
    if (node?.nodeType === 3 && row.contains(node)) {
      const t = node as Text;
      const at = drawnFrom(t, Math.min(offset, t.length - 1));
      if (at && at.top < r.bottom) return at;
    }
  }
  // reading order: the first character whose box reaches below y (boxes never go up along a text node)
  const walk = document.createTreeWalker(row, 4 /* NodeFilter.SHOW_TEXT */);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    const t = n as Text;
    const all = document.createRange();
    all.selectNodeContents(t);
    const b = all.getBoundingClientRect();
    if (!b.height || b.bottom <= y) continue;
    let lo = 0;
    let hi = t.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const g = drawnFrom(t, mid);
      if (g && g.bottom > y) hi = mid;
      else lo = mid + 1;
    }
    const at = drawnFrom(t, lo);
    if (at) return at;
  }
  return null;
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

