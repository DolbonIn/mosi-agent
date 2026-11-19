// The main thread the meeting B checks read (chat.spec "meetb"): the person pastes a Google Meet link, the agent asks
// to join (the join approval card, full code in `card.meet` for the owner's card only), and — once it is over — the
// summary under the card plus the minutes as a document row. The meeting itself (GET /api/threads/:id/meet?approval=)
// is served by `meetView` below through route interception, so nothing reaches a meeting bot or an LLM.
// Synthetic code (rak-mnpq-kud) and people (하늘 is the owner, 지현 is made up).

export const MEET_CODE = "rak-mnpq-kud";
export const MEET_APPROVAL = "mb-ap-meet";
export const MEET_THREAD = "mb-meet-thread";

export function meetThread(threadId, agent, { status = "pending", decidedAt, summary = false } = {}) {
  const T = Date.now() - 50 * 60_000;
  let n = 0;
  const msg = (role, text, extra = {}) => ({ id: `mb-m${++n}`, threadId, role, text, cards: [], tools: [], attachments: [], createdAt: T + n * 60_000, ...extra });
  const tool = (name, title, state, summaryText, ms) => ({ id: `mb-t${++n}`, name, title, state, summary: summaryText, startedAt: T + n * 60_000, endedAt: state === "done" ? T + n * 60_000 + ms : undefined });
  const items = [
    msg("user", `이 회의 들어가서 받아 적어 줘 https://meet.google.com/${MEET_CODE}`),
    msg("assistant", "", {
      tools: [tool("sys_join_meet", "회의 참여", status === "pending" ? "needs_approval" : "done", status === "approved" ? "승인됨" : undefined, 3000)],
      cards: [
        {
          type: "approval",
          approvalId: MEET_APPROVAL,
          title: "Google Meet 회의(rak-****-kud)에 참여할까요?",
          detail: `${agent}가 이 회의에 참여해 듣고 받아 적어요. 참석자들에게는 AI 비서라고 먼저 알려요.`,
          status,
          meet: { code: MEET_CODE },
          ...(decidedAt ? { decidedAt } : {}),
        },
      ],
    }),
  ];
  if (summary)
    items.push(
      msg("assistant", "**회의 요약**\n\n**정한 것**\n- 출시일은 12월 2일로 확정했어요.\n- 랜딩 페이지는 시안 B로 가요.\n\n**할 일**\n- 하늘: 랜딩 문구 금요일까지\n- 지현: 앱 스토어 스크린샷 5장\n\n**다음 회의**\n- 11월 19일 화요일 오전 10시", {
        cards: [{ type: "artifact", artifactId: "mb-art-doc", title: "11월 12일 주간회의 회의록", kind: "document", preview: "참석 4명 · 42분 · 정한 것 2 · 할 일 2" }],
      }),
    );
  return items;
}

/** the server's MeetView for the meeting that approval started, in one of its phases */
export function meetView(phase, agent, base = Date.now() - 46 * 60_000) {
  const joinedAt = base + 2 * 60_000;
  const common = { id: "mb-mt", code: "rak-****-kud", title: "주간 회의", purpose: "", startedAt: base, threadId: MEET_THREAD };
  switch (phase) {
    case "joining":
      return { ...common, state: "waiting_admission", live: true, joinedAt: null, endedAt: null, note: "참여 요청을 보냈어요. 호스트가 수락하면 들어가요." };
    case "live":
      return { ...common, state: "in_call", live: true, joinedAt, endedAt: null, note: `회의에 들어왔어요. 지금부터 받아 적을게요. 회의 중에 '${agent}야'라고 부르면 대답해요.` };
    case "left":
      return { ...common, state: "ended", live: false, joinedAt, endedAt: joinedAt + 42 * 60_000, note: "회의에서 나왔어요.", reason: "left" };
    case "ended":
      return { ...common, state: "ended", live: false, joinedAt, endedAt: joinedAt + 42 * 60_000, note: "회의가 끝나서 나왔어요.", reason: "meeting_ended" };
    case "failed":
      return { ...common, state: "denied", live: false, joinedAt: null, endedAt: base + 5 * 60_000, note: "호스트가 참여 요청을 받아 주지 않았어요.", reason: "host_denied" };
    default:
      return null;
  }
}
