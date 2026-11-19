import type { Friend } from "@pickle/protocol";
import { useEffect, useRef, useState } from "react";
import { toApiError } from "../../../api/client";
import { nav, type ScreenProps } from "../../../app/nav";
import { Screen } from "../../../app/Screen";
import { Avatar } from "../../../ui/Avatar";
import { Button } from "../../../ui/Button";
import { ConfirmButton } from "../../../ui/ConfirmButton";
import { EmptyState } from "../../../ui/EmptyState";
import { Icon } from "../../../ui/Icon";
import { LargeTitle } from "../../../ui/LargeTitle";
import { List } from "../../../ui/List";
import { presentSheet, type SheetApi } from "../../../ui/Sheet";
import { TextField } from "../../../ui/TextField";
import { acceptInvite, blockFriend, friendsRes, removeFriend, useResource } from "../data";
import { ago, josa } from "../format";
import { InlineError, Note, Placeholder, Stack, useRouteVisible } from "../parts";
import { presentInvite } from "./InviteSheet";
import "./friends.css";

/**
 * 친구 (MOTION-SPEC §6.9, research §4-9): friends with their Pickle, pending requests, blocked people; add by pasting a
 * link; a friend row opens the shared thread (screens-chat's "thread") and ends in the list chevron, "…" being its one
 * other control. Inviting is the friend group's last row ("친구 초대하기", like a contacts "add" row): the one invite
 * sheet grows out of it. No top-bar capsule here (glass: back + tab bar). The how-to captions the list it is about.
 * Block / remove live in a per-friend sheet with the consequence spelled out and a two-step confirm.
 * params: { invite?: string } — opened from `/?invite=<token>`: offers to accept that invite.
 */
export function FriendsScreen({ route }: ScreenProps) {
  const visible = useRouteVisible(route.key);
  const res = useResource(friendsRes, visible);
  const inviteParam = typeof route.params?.invite === "string" ? (route.params.invite as string) : null;

  const accepted = res.data.filter((f) => f.status === "accepted");
  const pendingIn = res.data.filter((f) => f.status === "pending_in");
  const pendingOut = res.data.filter((f) => f.status === "pending_out");
  const blocked = res.data.filter((f) => f.status === "blocked");
  // the invite row and the how-to close the friends group; with no friends yet, the group of sent requests, then received
  const home = accepted.length ? "accepted" : pendingOut.length ? "pending_out" : "pending_in";

  return (
    <Screen routeKey={route.key}>
      <LargeTitle title={route.title ?? "친구"} layoutId={route.titleLayoutId} />
      <Stack>
        {inviteParam && <InviteAccept token={inviteParam} />}

        {!res.loaded && res.loading ? (
          <Placeholder rows={2} height={68} />
        ) : res.error && !res.loaded ? (
          <InlineError>{res.error}</InlineError>
        ) : accepted.length === 0 && pendingIn.length === 0 && pendingOut.length === 0 ? (
          <FriendsEmpty primary={!inviteParam} />
        ) : (
          <>
            {pendingIn.length > 0 && <FriendGroup title="받은 요청" items={pendingIn} invite={home === "pending_in"} />}
            {accepted.length > 0 && <FriendGroup title={`친구 ${accepted.length}명`} items={accepted} invite={home === "accepted"} />}
            {pendingOut.length > 0 && <FriendGroup title="보낸 요청" items={pendingOut} invite={home === "pending_out"} />}
          </>
        )}

        <AddByLink />

        {blocked.length > 0 && <FriendGroup title="차단한 사람" items={blocked} />}
      </Stack>
    </Screen>
  );
}

function FriendsEmpty({ primary }: { primary: boolean }) {
  const btn = useRef<HTMLButtonElement>(null);
  return (
    <EmptyState
      icon="people"
      title="아직 모시 친구가 없어요"
      body="친구를 초대하면 서로의 모시에게 말을 전하고, 함께 쓰는 대화방이 생겨요."
      action={
        <Button ref={btn} tone={primary ? "primary" : "secondary"} size="md" icon="link" onClick={() => presentInvite(btn.current)}>
          친구 초대하기
        </Button>
      }
    />
  );
}

// the privacy line is said once, in the invite sheet where sharing is decided (CP-5); the page keeps the how-to
const HOW_TO = "메시지에서 모시 이름을 부르거나 @로 시작하면 내 모시가 대신 답해요.";

function FriendGroup({ title, items, invite = false }: { title: string; items: Friend[]; invite?: boolean }) {
  return (
    <List header={<h2 className="list-section-title">{title}</h2>} footer={invite ? HOW_TO : undefined}>
      {items.map((f) => (
        <FriendRow key={f.userId} f={f} />
      ))}
      {invite && <InviteRow />}
    </List>
  );
}

/** the group's last row: link glyph + "친구 초대하기" in the accent text colour; the invite sheet grows out of it */
function InviteRow() {
  const row = useRef<HTMLButtonElement>(null);
  return (
    <button ref={row} type="button" className="friend-invite-row" onClick={() => presentInvite(row.current)}>
      <span className="friend-invite-row__icon" aria-hidden="true">
        <Icon name="link" size={22} weight="medium" />
      </span>
      <span className="friend-invite-row__label">친구 초대하기</span>
    </button>
  );
}

const STATUS: Record<Friend["status"], string> = {
  accepted: "친구",
  pending_in: "나에게 친구 요청을 보냈어요",
  pending_out: "수락을 기다리는 중",
  blocked: "차단함",
};

function FriendRow({ f }: { f: Friend }) {
  const more = useRef<HTMLButtonElement>(null);
  const canOpen = f.status === "accepted" && !!f.threadId;
  const sub = f.status === "accepted" ? `${josa(f.agentName, "와과")} 함께 · ${ago(f.since)}부터` : `@${f.handle} · ${STATUS[f.status]}`;
  const open = () => {
    if (canOpen) nav.push("thread", { threadId: f.threadId }, { title: `${f.displayName} 님` });
  };
  return (
    <div className="friend-row" data-friend={f.handle}>
      <button type="button" className="friend-main" onClick={open} disabled={!canOpen} aria-label={`${f.displayName} 님, ${sub}${canOpen ? ", 함께 쓰는 대화 열기" : ""}`}>
        <Avatar spec={f.avatar} size={40} label={undefined} />
        <span className="friend-text">
          <span className="friend-name">{f.displayName} 님</span>
          <span className="friend-sub">{sub}</span>
        </span>
        {canOpen && (
          <span className="friend-chev" aria-hidden="true">
            <Icon name="chevron-right" size={16} weight="semibold" />
          </span>
        )}
      </button>
      <button ref={more} type="button" className="friend-more" aria-label={`${f.displayName} 님 관리`} onClick={() => presentFriend(f, more.current)}>
        <Icon name="ellipsis" size={20} weight="medium" />
      </button>
    </div>
  );
}

function presentFriend(f: Friend, source: HTMLElement | null) {
  presentSheet({ source, title: `${f.displayName} 님`, render: (api) => <FriendSheet f={f} api={api} /> });
}

function FriendSheet({ f, api }: { f: Friend; api: SheetApi }) {
  const [error, setError] = useState<string | null>(null);
  const run = (fn: () => Promise<unknown>) => async () => {
    setError(null);
    api.setBusy(true);
    try {
      await fn();
    } catch (e) {
      setError(toApiError(e).message);
      throw e;
    } finally {
      api.setBusy(false);
    }
  };
  return (
    <div className="more-sheet">
      <div className="friend-sheet-head">
        <Avatar spec={f.avatar} size={56} />
        <span className="friend-text">
          <span className="friend-name">{f.displayName} 님</span>
          <span className="friend-sub">
            @{f.handle} · 모시 {f.agentName}
          </span>
        </span>
      </div>
      {f.status === "accepted" && f.threadId && (
        <Button
          tone="secondary"
          size="md"
          icon="chat"
          fullWidth
          onClick={() => {
            api.close();
            nav.push("thread", { threadId: f.threadId }, { title: `${f.displayName} 님` });
          }}
        >
          함께 쓰는 대화 열기
        </Button>
      )}
      {f.status === "blocked" ? (
        <div className="more-sheet-group">
          <Note icon="info">차단을 풀면 다시 초대 링크로 친구가 될 수 있어요. 지난 대화는 숨겨진 채로 남아요.</Note>
          <ConfirmButton label="차단 풀기" confirmLabel="한 번 더 누르면 차단을 풀어요" tone="neutral" onConfirm={run(() => removeFriend(f.userId))} onSuccess={() => api.close()} />
        </div>
      ) : (
        <>
          <div className="more-sheet-group">
            <Note icon="info">차단하면 함께 쓰던 대화방이 숨겨지고, 서로의 모시에게 말을 전할 수 없어요. 상대에게 알리지 않아요.</Note>
            <ConfirmButton label="차단하기" confirmLabel="한 번 더 누르면 차단해요" tone="destructive" onConfirm={run(() => blockFriend(f.userId))} onSuccess={() => api.close()} />
          </div>
          {f.status === "accepted" && (
            <div className="more-sheet-group">
              <Note icon="info">친구를 끊으면 대화방이 보관되고, 다시 친구가 되려면 새 초대 링크가 필요해요.</Note>
              <ConfirmButton label="친구 끊기" confirmLabel="한 번 더 누르면 친구를 끊어요" tone="neutral" onConfirm={run(() => removeFriend(f.userId))} onSuccess={() => api.close()} />
            </div>
          )}
        </>
      )}
      <InlineError>{error}</InlineError>
    </div>
  );
}

/** `https://…/i/<token>`, `/?invite=<token>` or the bare token */
export function parseInviteToken(input: string): string | null {
  const v = input.trim();
  if (!v) return null;
  const m = v.match(/\/i\/([A-Za-z0-9_-]{8,})/) ?? v.match(/[?&]invite=([A-Za-z0-9_-]{8,})/) ?? v.match(/^([A-Za-z0-9_-]{8,})$/);
  return m?.[1] ?? null;
}

function AddByLink() {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [added, setAdded] = useState<string | null>(null);
  const add = async () => {
    setError(undefined);
    const token = parseInviteToken(value);
    if (!token) {
      setError("초대 링크를 확인해 주세요. 친구가 보낸 링크를 그대로 붙여 넣으면 돼요.");
      throw new Error("bad link");
    }
    try {
      const f = await acceptInvite(token);
      setAdded(f.displayName);
      setValue("");
    } catch (e) {
      setError(toApiError(e).message);
      throw e;
    }
  };
  return (
    <section className="friend-add" aria-label="받은 초대 링크로 친구 추가">
      <div className="friend-add__row">
        <TextField label="받은 초대 링크로 친구 추가" value={value} onChange={setValue} placeholder="받은 링크를 붙여 넣어 주세요" type="url" inputMode="url" autoCapitalize="off" error={error} hint={added ? `${added} 님과 친구가 됐어요` : undefined} onEnter={() => void add().catch(() => {})} />
        <Button tone="secondary" size="md" action={add} disabled={!value.trim()} successLabel="친구가 됐어요" className="friend-add__btn">
          추가
        </Button>
      </div>
    </section>
  );
}

function InviteAccept({ token }: { token: string }) {
  const [state, setState] = useState<"idle" | "done">("idle");
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState<string | null>(null);
  useEffect(() => setState("idle"), [token]);
  const accept = async () => {
    setError(null);
    try {
      const f = await acceptInvite(token);
      setName(f.displayName);
    } catch (e) {
      setError(toApiError(e).message);
      throw e;
    }
  };
  return (
    <div className="friend-invite-card paper">
      <p className="friend-invite-card__title">{state === "done" && name ? `${name} 님과 친구가 됐어요` : "초대 링크로 들어왔어요"}</p>
      <p className="friend-invite-card__body">친구가 되면 서로의 모시에게 말을 전하고, 함께 쓰는 대화방이 생겨요.</p>
      <InlineError>{error}</InlineError>
      <Button tone="primary" size="md" action={accept} onSuccess={() => setState("done")} holdSuccess successLabel="친구가 됐어요">
        친구 추가하기
      </Button>
    </div>
  );
}
