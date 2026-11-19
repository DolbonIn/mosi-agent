import type { AvatarSpec, ID, Thread, ThreadWaiting } from "@pickle/protocol";
import { AnimatePresence, LayoutGroup, motion } from "framer-motion";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import * as ep from "../../api/endpoints";
import { loadThreads, upsertThread, useSession, useThreads, useUi } from "../../api/store";
import { island } from "../../app/island";
import { nav, navStore, useNav } from "../../app/nav";
import { haptic } from "../../motion/haptics";
import { EXIT, t } from "../../motion/springs";
import { Avatar } from "../../ui/Avatar";
import { Icon, type AppIconName } from "../../ui/Icon";
import { Spotlight } from "../../ui/Spotlight";
import { useCall } from "./call/callState";
import { agoKo, KIND_ICON } from "./util";
import "./drawer.css";

/**
 * Drawer content (MOTION-SPEC §8.10, REA runtime-02; draft "drawer" B, picked 2026-11-12): the drawer is the record.
 *   - search first (the agent's face and name are already in the top bar): a plain field on the paper; Spotlight
 *     over every thread with 초성, its hits as the same rows, the title regular and the matched letters bold; an empty
 *     query lists the recent conversations.
 *   - "지금 하는 일": threads the server says are waiting (an approval, a call in progress, a live meeting) are pinned
 *     on top — from a cold start too — with the state as their subtitle and no badge. None → no section.
 *   - 기본 채팅 · 친구, then "맡긴 일" (or "보관한 대화"): each row's subtitle is the agent's last sentence in that thread,
 *     two lines, masked by the server (numbers, emails and codes never reach the client).
 *   - rows: a 20 px glyph (no plate; a friend's thread shows their agent's face), the time on the title line only.
 *   - the tab destinations as ONE compact row at the bottom.
 * Motion kept: §8.10 drawer, §3 Spotlight, §3 list (layout="position", 4 px rise, archive folds out — and the same
 * layout move when a row goes up to or down from "지금 하는 일"), §3 press tint, §8.2 no re-entrance on return.
 */
export function openThread(threadId: ID) {
  const cur = nav.current();
  if (navStore.get().tab === "chat" && cur?.screen === "thread" && cur.params?.threadId === threadId) {
    nav.closeDrawer();
    return;
  }
  nav.setTab("chat");
  if (nav.canGoBack()) nav.popToRoot();
  nav.push("thread", { threadId });
}

/** a friend's face: the same one beside their bubbles (Messages.tsx) */
function peerFace(userId: string | undefined): AvatarSpec {
  let h = 0;
  const id = userId ?? "p";
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return { hue: h % 360, shape: "round", eyes: "dot" };
}

function glyphOf(th: Thread): AppIconName {
  if (th.kind === "task") return "doc"; // a task is a document of work, not magic (DESIGN AI-tell)
  return (th.icon as AppIconName) || KIND_ICON[th.kind];
}

export function DrawerContent({ close }: { close: () => void }) {
  const threads = useThreads();
  const session = useSession();
  const ui = useUi();
  const tab = useNav((s) => s.tab);
  const atChatRoot = useNav((s) => s.tab === "chat" && s.stacks.chat.length === 0);
  const openId = useNav((s) => {
    const st = s.stacks[s.tab];
    const top = st[st.length - 1];
    return top?.screen === "thread" ? (top.params?.threadId as string | undefined) : undefined;
  });
  const drawerOpen = useNav((s) => s.drawer);
  const [archived, setArchivedView] = useState(false);
  const [searching, setSearching] = useState(false);
  // this device's own voice call is known before the server's state arrives
  const callThread = useCall((s) => (s.active ? s.threadId : null));

  useEffect(() => {
    if (drawerOpen && session.status === "ready") void loadThreads();
    if (!drawerOpen) setSearching(false);
  }, [drawerOpen, session.status]);

  const mainId = session.session?.mainThreadId;
  const items = threads.items;
  const waitingOf = (th: Thread): ThreadWaiting | null => th.waiting ?? (callThread === th.id ? { kind: "call", text: "통화 중 · 듣고 있어요." } : null);
  const isMain = (th: Thread) => th.id === mainId || th.kind === "main";

  const live = useMemo(() => {
    const rank = { approval: 0, call: 1, meeting: 2 } as const;
    return items
      .filter((th) => !th.archived && waitingOf(th))
      .sort((a, b) => rank[waitingOf(a)!.kind] - rank[waitingOf(b)!.kind] || b.updatedAt - a.updatedAt);
  }, [items, callThread]);
  const extra = useMemo(
    () => items.filter((th) => !isMain(th) && th.archived === archived && (archived || !waitingOf(th))).sort((a, b) => b.updatedAt - a.updatedAt),
    [items, mainId, archived, callThread],
  );
  const all = useMemo(() => items.filter((th) => !isMain(th)), [items, mainId]);
  const recent = useMemo(() => all.filter((th) => !th.archived).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 5), [all]);

  const pick = (id: ID) => {
    haptic("selection");
    openThread(id);
    close();
  };
  const goMain = () => {
    nav.setTab("chat");
    if (nav.canGoBack()) nav.popToRoot();
    close();
  };

  const destinations = ui.tabs.filter((x) => x.id !== "chat");
  const row = (th: Thread, opts: { inLive?: boolean } = {}) => {
    const w = opts.inLive ? waitingOf(th) : null;
    return (
      <motion.li key={th.id} layoutId={`dw-${th.id}`} layout="position" initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, transition: EXIT }} transition={t("snap")}>
        <button
          type="button"
          className="dw-row"
          data-on={(isMain(th) ? atChatRoot : openId === th.id) || undefined}
          aria-current={(isMain(th) ? atChatRoot : openId === th.id) ? "page" : undefined}
          onClick={() => (isMain(th) ? goMain() : pick(th.id))}
        >
          <ThreadRowBody thread={th} title={isMain(th) ? "기본 채팅" : th.title} sub={w ? w.text : th.preview || th.subtitle} time />
        </button>
      </motion.li>
    );
  };

  return (
    <div className="dw">
      <div className="dw-search-wrap">
        {searching ? (
          <div className="dw-spot">
            <Spotlight<Thread>
              appearance="inline"
              items={all}
              recent={recent}
              recentLabel="최근 대화"
              getKey={(th) => th.id}
              getLabel={(th) => th.title}
              getSubtitle={(th) => th.preview || th.subtitle}
              getKeywords={(th) => [th.peer?.displayName ?? "", th.kind === "call" ? "통화 전화" : th.kind === "friend" ? "친구" : th.kind === "schedule" ? "예약" : "일"]}
              renderRow={(th, { label, selected, recent: isRecent }) => (
                <span className="dw-row" data-hit={isRecent ? undefined : ""}>
                  <ThreadRowBody thread={th} title={label} sub={th.preview || th.subtitle} time={isRecent} chevron={!isRecent && selected} />
                </span>
              )}
              onSelect={(th) => pick(th.id)}
              placeholder="대화 검색"
              label="대화 검색"
              emptyText="찾는 대화가 없어요"
              emptyHint="다른 글자나 초성으로 찾아보세요"
              autoFocus
              limit={8}
            />
            <button type="button" className="dw-cancel" onClick={() => setSearching(false)}>
              취소
            </button>
          </div>
        ) : (
          <button type="button" className="dw-search" onClick={() => setSearching(true)} aria-label="대화 검색">
            <Icon name="magnifier" size={18} weight="medium" />
            <span>대화 검색</span>
          </button>
        )}
      </div>

      {!searching && (
        <LayoutGroup id="dw-rows">
          {live.length > 0 && (
            <section className="dw-sec" aria-labelledby="dw-live-h">
              <div className="dw-sec-head">
                <h2 id="dw-live-h" className="dw-h">
                  지금 하는 일
                </h2>
              </div>
              <ul className="dw-list">
                <AnimatePresence initial={false}>{live.map((th) => row(th, { inLive: true }))}</AnimatePresence>
              </ul>
            </section>
          )}

          <nav className="dw-main" aria-label="대화">
            <button type="button" className="dw-item" data-on={atChatRoot || undefined} aria-current={atChatRoot ? "page" : undefined} onClick={goMain}>
              <Icon name="chat" size={20} weight={atChatRoot ? "semibold" : "regular"} />
              <span className="dw-item-title">기본 채팅</span>
            </button>
            <button type="button" className="dw-item" onClick={() => nav.push("friends", undefined, { title: "친구" })}>
              <Icon name="people" size={20} />
              <span className="dw-item-title">친구</span>
            </button>
          </nav>

          <section className="dw-sec dw-threads" aria-labelledby="dw-threads-h">
            <div className="dw-sec-head">
              <h2 id="dw-threads-h" className="dw-h">
                {archived ? "보관한 대화" : "맡긴 일"}
              </h2>
              <button type="button" className="dw-textbtn" aria-pressed={archived} onClick={() => setArchivedView((v) => !v)}>
                {archived ? "맡긴 일" : "보관한 대화"}
              </button>
            </div>
            {threads.error && !threads.items.length && (
              <p className="dw-empty" role="alert">
                {threads.error}
              </p>
            )}
            {!threads.error && threads.loaded && !extra.length && <p className="dw-empty">{archived ? "보관한 대화가 없어요" : "일을 맡기면 여기에 대화가 생겨요"}</p>}
            <ul className="dw-list">
              <AnimatePresence initial={false}>{extra.map((th) => row(th))}</AnimatePresence>
            </ul>
          </section>

          <nav className="dw-tabs" aria-label="다른 화면">
            {destinations.map((d) => (
              <button
                key={d.id}
                type="button"
                className="dw-tab"
                data-on={tab === d.id || undefined}
                aria-current={tab === d.id ? "page" : undefined}
                aria-label={d.title}
                onClick={() => {
                  nav.setTab(d.id);
                  close();
                }}
              >
                <Icon name={d.icon} size={22} weight={tab === d.id ? "semibold" : "regular"} />
                <span className="dw-tab-label">{d.title}</span>
              </button>
            ))}
          </nav>
        </LayoutGroup>
      )}
    </div>
  );
}

/** one conversation row: glyph (or the friend's agent face) · title (+ unread) · time on the title line · the
 *  subtitle under both, two lines */
function ThreadRowBody({ thread, title, sub, time, chevron }: { thread: Thread; title: ReactNode; sub: string; time?: boolean; chevron?: boolean }) {
  return (
    <>
      <span className="dw-row-glyph" aria-hidden="true">
        {thread.kind === "friend" ? <Avatar spec={peerFace(thread.peer?.userId)} size={24} breathing={false} /> : <Icon name={glyphOf(thread)} size={20} />}
      </span>
      <span className="dw-row-title">
        <span className="dw-row-title-text">{title}</span>
        {thread.unread && <span className="dw-unread" aria-label="읽지 않음" />}
      </span>
      {time && <span className="dw-row-time tnum">{agoKo(thread.updatedAt)}</span>}
      {chevron && (
        <span className="dw-row-chev" aria-hidden="true">
          <Icon name="chevron-right" size={16} />
        </span>
      )}
      {sub ? <span className="dw-row-sub">{sub}</span> : null}
    </>
  );
}

/** archive / unarchive with an undo banner (used by the thread screen's top-bar action) */
export async function setArchived(thread: Thread, archived: boolean) {
  try {
    const next = await ep.patchThread(thread.id, { archived });
    upsertThread(next);
    island.undo({
      title: archived ? "대화를 보관했어요" : "대화를 꺼냈어요",
      body: thread.title,
      icon: "archive",
      onUndo: () => {
        void ep
          .patchThread(thread.id, { archived: !archived })
          .then(upsertThread)
          .catch((e: Error) => island.errorBanner(e.message));
      },
    });
    return next;
  } catch (e) {
    island.errorBanner((e as Error).message, archived ? "보관하지 못했어요" : "꺼내지 못했어요");
    throw e;
  }
}
