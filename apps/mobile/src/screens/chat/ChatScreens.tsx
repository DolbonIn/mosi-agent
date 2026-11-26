import type { ID } from "@pickle/protocol";
import { useEffect, useRef, useState } from "react";
import * as ep from "../../api/endpoints";
import { loadThreads, useAgent, useQuota, useSession } from "../../api/store";
import { island } from "../../app/island";
import { lazyScreen, nav, useNav, type ScreenProps } from "../../app/nav";
import { setCompactTitle, useTopBarCenter, useTopBarRight } from "../../app/topBarStore";
import { AgentBlobLazy } from "../../ui/AgentBlobLazy";
import { DEFAULT_AVATAR } from "../../ui/Avatar";
import { Button } from "../../ui/Button";
import { presentSheet } from "../../ui/Sheet";
import { useCall } from "./call/callState";
import { useKeptThread } from "./catchUp";
import { setArchived } from "./DrawerContent";
import { isMeetThread, MeetLive } from "./MeetLive";
import { clearInvite, pendingInvite } from "./onboarding/state";
import { ThreadView } from "./ThreadView";
import { dayClockKo, josa } from "./util";

/** the chat tab root: 기본 채팅 (the main thread), the call card host, invite acceptance */
export function ChatTab({ route }: ScreenProps) {
  const session = useSession();
  const main = session.session?.mainThreadId ?? null;
  const active = useNav((s) => s.tab === "chat" && s.stacks.chat.length === 0 && !s.drawer);

  // no trailing capsule (chat B: glass is the menu circle, the composer and the tab bar); 친구 초대 lives in the agent
  // sheet below, the drawer and 친구 — all three open the one invite sheet
  useTopBarCenter(active ? (el) => openAgentSheet(el) : null);

  useEffect(() => {
    if (session.status === "ready") void loadThreads();
  }, [session.status]);
  useInviteAcceptance(session.status === "ready");

  return (
    <>
      <ThreadView threadId={main} routeKey={route.key} active={active} />
      <CallHost />
    </>
  );
}

/** a pushed conversation: task / call / schedule / friend */
export function ThreadScreen({ route }: ScreenProps) {
  const threadId = (route.params?.threadId as ID | undefined) ?? null;
  const thread = useKeptThread(threadId);
  const agent = useAgent();
  const active = useNav((s) => {
    const st = s.stacks[s.tab];
    return st[st.length - 1]?.key === route.key && !s.drawer;
  });

  useEffect(() => {
    if (threadId && !thread) void loadThreads();
  }, [threadId, thread]);
  useEffect(() => {
    if (!active || !thread) return;
    setCompactTitle(route.key, thread.title);
    return () => setCompactTitle(route.key, null);
  }, [active, thread, route.key]);
  useTopBarRight(
    active && thread && thread.kind !== "main"
      ? { icon: "archive", ariaLabel: thread.archived ? "보관 해제" : "보관하기", onPress: () => void setArchived(thread, !thread.archived).then((n) => n.archived && nav.pop()).catch(() => {}) }
      : null,
  );

  const header = thread ? (
    <header className="thread-intro" data-kind={thread.kind}>
      <h1 className="thread-intro-title">{thread.title}</h1>
      <p className="thread-intro-sub">{thread.kind === "friend" && thread.peer ? `${thread.peer.displayName} 님 · ${josa(thread.peer.agentName, "과", "와")} 함께하는 대화` : thread.subtitle}</p>
      <p className="thread-intro-meta tnum">{dayClockKo(thread.createdAt)}에 시작</p>
    </header>
  ) : null;

  const footer = thread && isMeetThread(thread) ? <MeetLive threadId={thread.id} agentName={agent?.name ?? "모시"} /> : null;

  return <ThreadView threadId={threadId} routeKey={route.key} active={active} header={header} footer={footer} />;
}

/** the call card (a lazy chunk with the rest of the call code): mounted from the first call on, then kept for its exits */
const CallOverlayLazy = lazyScreen<object>(() => import("./call/CallOverlay").then((m) => m.CallOverlay));
function CallHost() {
  const wanted = useCall((s) => s.active);
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    if (wanted) setMounted(true);
  }, [wanted]);
  return mounted ? <CallOverlayLazy /> : null;
}

/** "call": open a thread and start a voice call in it */
export function CallScreen(props: ScreenProps) {
  const threadId = props.route.params?.threadId as ID | undefined;
  const started = useRef(false);
  useEffect(() => {
    if (!threadId || started.current) return;
    started.current = true;
    void import("./call/callStore").then((m) => m.startCall(threadId));
  }, [threadId]);
  return <ThreadScreen {...props} />;
}

// ── invites ──

function useInviteAcceptance(ready: boolean) {
  useEffect(() => {
    if (!ready) return;
    const token = pendingInvite();
    if (!token) return;
    clearInvite();
    void ep
      .acceptInvite(token)
      .then(async (friend) => {
        island.banner({ icon: "people", title: `${friend.displayName} 님과 친구가 됐어요`, body: "함께 쓰는 모시 대화를 열었어요" });
        await loadThreads();
        if (friend.threadId) {
          nav.setTab("chat");
          nav.push("thread", { threadId: friend.threadId });
        }
      })
      .catch((e: Error) => island.errorBanner(e.message, "초대를 받지 못했어요"));
  }, [ready]);
}

// ── the agent profile sheet (top-bar centre) ──

function openAgentSheet(source: HTMLElement) {
  presentSheet({ source, title: "나의 모시", render: (s) => <AgentBody onDone={s.close} /> });
}

function AgentBody({ onDone }: { onDone: () => void }) {
  const agent = useAgent();
  const quota = useQuota();
  if (!agent) return null;
  return (
    <div className="agent-sheet">
      <div className="agent-sheet-hero" aria-hidden="true">
        <AgentBlobLazy size={120} spec={agent.avatar ?? DEFAULT_AVATAR} />
      </div>
      <p className="agent-sheet-name">{agent.name}</p>
      {agent.persona && <p className="agent-sheet-persona">{agent.persona}</p>}
      <dl className="agent-sheet-facts">
        <div>
          <dt>오늘 사용량</dt>
          <dd className="tnum">{quota ? `${quota.usedPct}%` : "-"}</dd>
        </div>
        <div>
          <dt>쓸 수 있는 기능</dt>
          <dd className="tnum">{agent.enabledSkills.length}개</dd>
        </div>
      </dl>
      <div className="agent-sheet-actions">
        <Button
          tone="secondary"
          size="md"
          fullWidth
          onClick={(e) => {
            // the one invite sheet (more/friends) grows out of this button (opening it closes this sheet); loaded on
            // demand, so friends.css stays out of the chat chunk
            const from = e.currentTarget.getBoundingClientRect();
            void import("../more/friends/InviteSheet").then((m) => m.presentInvite(from));
          }}
        >
          친구 초대
        </Button>
        <Button
          tone="secondary"
          size="md"
          fullWidth
          onClick={() => {
            onDone();
            nav.setTab("profile");
          }}
        >
          나의 모시에서 바꾸기
        </Button>
      </div>
    </div>
  );
}
