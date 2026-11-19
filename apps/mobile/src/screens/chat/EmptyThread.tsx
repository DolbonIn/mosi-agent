import type { AvatarSpec, ID, ThreadKind } from "@pickle/protocol";
import { useEffect, useState } from "react";
import { Avatar } from "../../ui/Avatar";
import { List, ListRow } from "../../ui/List";
import { requestComposerFocus } from "./composerStore";
import { josa } from "./util";

/**
 * Empty conversation (MOTION-SPEC §6 #14 / §8.14, research 1-5 / §3-10, empty-thread A): the agent itself (a still
 * 56 px avatar; in a friend thread the friend's), the same sentence about what happens here, and three suggestions as
 * one left-aligned grouped list. A tap puts the words in the composer and focuses it (edit, then send) instead of
 * sending at once. The rows rise in on `snap`, 30 ms apart, only the first time this thread's empty state shows —
 * coming back to it never re-enters.
 */
const SUGGEST: Record<"main" | "friend", string[]> = {
  main: ["내일 날씨 알려 줘", "이번 주 할 일 정리해 줘", "점심 메뉴 골라 줘"],
  friend: ["안녕하세요!", "이번 주말에 시간 괜찮아요?", "@{agent} 우리 둘 다 갈 만한 맛집 찾아 줘"],
};
const shown = new Set<ID>();

export function EmptyThread({ threadId, kind, agentName, face }: { threadId: ID; kind: ThreadKind; agentName: string; face: AvatarSpec }) {
  const friend = kind === "friend";
  const list = (friend ? SUGGEST.friend : SUGGEST.main).map((s) => s.replace("{agent}", agentName));
  const [enter] = useState(() => !shown.has(threadId));
  useEffect(() => {
    shown.add(threadId);
  }, [threadId]);
  return (
    <div className="thread-empty">
      <Avatar spec={face} size={56} className="thread-empty-face" />
      <p className="thread-empty-title">{friend ? "먼저 인사해 보세요" : `${josa(agentName, "이", "가")} 기다리고 있어요`}</p>
      <p className="thread-empty-body">{friend ? `@${josa(agentName, "을", "를")} 붙이면 모시도 대화에 들어와요.` : "말로 맡기면 알아서 찾아보고 정리해 드려요."}</p>
      <List className={`thread-empty-list${enter ? " is-entering" : ""}`} label="이렇게 말해 보세요">
        {list.map((s) => (
          <ListRow key={s} title={s} chevron={false} ariaLabel={`${s}, 입력창에 넣기`} onClick={() => requestComposerFocus(threadId, s)} />
        ))}
      </List>
    </div>
  );
}
