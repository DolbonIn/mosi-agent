import type { InviteResponse } from "@pickle/protocol";
import { toApiError } from "../../../api/client";
import * as ep from "../../../api/endpoints";
import { island } from "../../../app/island";
import { nav } from "../../../app/nav";
import { createStore, useStore, type Store } from "../../../lib/createStore";
import { Button } from "../../../ui/Button";
import { presentSheet, type SheetApi, type SheetSource } from "../../../ui/Sheet";
import { untilKo } from "../format";
import { InlineError, Lead, Note } from "../parts";
import "./friends.css";

/**
 * The one invite sheet (MOTION-SPEC §6.9, research 9-3/9-4) — chat, 친구 and 둘러보기 all open this one. POST
 * /api/invites makes a one-time link. The body says what happens and, once, what a friend's Pickle can see (with a way
 * to the 정보 공개 범위 setting). The footer holds the decision: the two facts that matter (until when · once) right
 * above ONE accent action — 공유하기 where the system share sheet exists, else 링크 복사 — and copy as the quiet second.
 * No link panel, no raw URL: a person needs the facts, not the token. Copy draws its check only after the clipboard
 * accepted it, then the island says so.
 */
export function presentInvite(source: SheetSource): SheetApi {
  // the sheet host renders body and footer apart: they share this presentation's invite through one small store
  const store = createStore<InviteState>({ invite: null, error: null });
  void make(store);
  return presentSheet({
    source,
    title: "친구 초대",
    titleAlign: "start",
    render: (api) => <InviteBody api={api} store={store} />,
    footer: () => <InviteFooter store={store} />,
  });
}

type InviteState = { invite: InviteResponse | null; error: string | null };

async function make(store: Store<InviteState>) {
  store.set({ invite: null, error: null });
  try {
    store.set({ invite: await ep.createInvite(), error: null });
  } catch (e) {
    store.set({ invite: null, error: toApiError(e).message });
  }
}

function InviteBody({ api, store }: { api: SheetApi; store: Store<InviteState> }) {
  const error = useStore(store, (s) => s.error);
  return (
    <div className="more-sheet invite-body">
      <Lead>친구가 이 링크를 열면 바로 모시 친구가 돼요. 서로의 모시에게 말을 전하고, 함께 쓰는 대화방이 생겨요.</Lead>
      <Note icon="lock">
        친구의 모시에게는 정보 공개 범위에서 허락한 것만 보여요.{" "}
        <button
          type="button"
          className="more-inline-link"
          onClick={() => {
            api.close();
            nav.push("settings.privacy", undefined, { title: "정보 공개 범위" });
          }}
        >
          설정 보기
        </button>
      </Note>
      <InlineError>{error}</InlineError>
    </div>
  );
}

function InviteFooter({ store }: { store: Store<InviteState> }) {
  const { invite, error } = useStore(store);
  const canShare = typeof navigator !== "undefined" && typeof navigator.share === "function";

  const copy = async () => {
    if (!invite) throw new Error("no invite");
    await navigator.clipboard.writeText(invite.url);
    island.banner({ icon: "link", title: "초대 링크를 복사했어요", body: "친구에게 보내 주세요" });
  };
  const share = async () => {
    if (!invite) return;
    try {
      await navigator.share({ title: "모시 친구 초대", text: "모시에서 친구가 돼요. 서로의 모시에게 말을 전할 수 있어요.", url: invite.url });
    } catch {
      /* the person closed the share sheet */
    }
  };

  if (error)
    return (
      <div className="invite-footer">
        <Button tone="secondary" size="lg" icon="refresh" fullWidth onClick={() => void make(store)}>
          다시 만들기
        </Button>
      </div>
    );
  return (
    <div className="invite-footer">
      {/* data-invite-url: the link for QA and assistive tech is in the DOM, never printed as a machine string */}
      <p className="invite-until tnum" aria-live="polite" data-invite-url={invite?.url ?? ""}>
        {invite ? `${untilKo(invite.expiresAt)}까지 · 한 번만 쓸 수 있어요` : "링크를 만드는 중이에요"}
      </p>
      {canShare ? (
        <>
          <Button tone="primary" size="lg" icon="share" fullWidth onClick={() => void share()} disabled={!invite}>
            공유하기
          </Button>
          <Button variant="plain" tone="neutral" size="lg" fullWidth action={copy} disabled={!invite} successLabel="복사했어요" errorLabel="다시 복사하기">
            링크 복사
          </Button>
        </>
      ) : (
        <Button tone="primary" size="lg" icon="copy" fullWidth action={copy} disabled={!invite} successLabel="복사했어요" errorLabel="다시 복사하기">
          링크 복사
        </Button>
      )}
    </div>
  );
}
