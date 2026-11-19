/**
 * The meeting behind a '회의 참여' thread, for the app (the thread header / "회의에서 나오기"):
 *  - GET  /api/threads/:id/meet        → { meeting: MeetView | null }
 *  - POST /api/threads/:id/meet/leave  → { ok: true, left: true, state: "ended" } when it took 모시 out; idempotent: a
 *    thread whose meeting is already over (or that has none) answers { ok: true, left: false, state: <its state> | null }
 * Owner only (a member of someone else's thread gets 404 like any thread they can't see). Bearer auth, no cookies,
 * so nothing here is reachable cross-site. Leaving needs no approval: it only takes 모시 out.
 * Uses MeetHub's own queries and leave(); the meeting code is masked ("abc-****-hij").
 *
 * Meeting B: GET /api/threads/:origin/meet?approval=<id> is the meeting a join card in the origin (chat) thread
 * started, so the card can follow it. The approval must be the caller's and that thread's (else 404, like a thread
 * they can't see); `threadId` in the view is the '회의 참여' thread, where leave goes.
 */
import type { Core } from "./core.ts";
import { json, notFound, type Ctx } from "./http.ts";
import { maskMeetCode, meetNote, type MeetingRow } from "./meet.ts";

export const LIVE_MEET_STATES = new Set(["launching", "prejoin", "waiting_admission", "in_call"]);

export interface MeetView {
  id: string;
  state: string;
  live: boolean;
  code: string;
  title: string | null;
  purpose: string;
  startedAt: number;
  joinedAt: number | null;
  endedAt: number | null;
  /** the '회의 참여' thread (POST …/meet/leave goes there) */
  threadId: string;
  /** the sentence that thread shows for the state ("회의가 끝나서 나왔어요."), null while it starts */
  note: string | null;
  /** why it ended or failed ("left", "meeting_ended", "host_denied"…), null while live */
  reason: string | null;
}

export function meetView(row: MeetingRow): MeetView {
  return {
    id: row.id,
    state: row.state,
    live: LIVE_MEET_STATES.has(row.state),
    code: maskMeetCode(row.code),
    title: row.title ?? null,
    purpose: row.purpose ?? "",
    startedAt: row.started_at,
    joinedAt: row.joined_at ?? null,
    endedAt: row.ended_at ?? null,
    threadId: row.thread_id,
    note: meetNote(row.state, row.reason ?? null),
    reason: row.reason ?? null,
  };
}

export function meetRoutes(core: Core) {
  const ownThread = (threadId: string, userId: string) => {
    const t = core.db.threadFor(threadId, userId);
    if (!t || t.owner_id !== userId) throw notFound("대화를 찾을 수 없어요", "thread_not_found");
    return t;
  };
  return {
    get: (c: Ctx, userId: string) => {
      const t = ownThread(c.params.id!, userId);
      const approvalId = c.url.searchParams.get("approval");
      if (approvalId !== null) {
        const a = core.db.getApproval(userId, approvalId);
        if (!a || a.thread_id !== t.id) throw notFound("승인 요청을 찾을 수 없어요", "approval_not_found");
        const linked = core.meet.byApproval(userId, t.id, a.id);
        return json({ meeting: linked ? meetView(linked) : null });
      }
      const row = core.meet.byThread(userId, t.id);
      return json({ meeting: row ? meetView(row) : null });
    },
    leave: async (c: Ctx, userId: string) => {
      const t = ownThread(c.params.id!, userId);
      const row = core.meet.byThread(userId, t.id);
      const active = core.meet.active(userId);
      // leave() ends the user's active meeting: only when that is this thread's meeting. Otherwise 모시 is already out
      // of this thread's meeting (it ended, or another thread's meeting is the live one): nothing to do, same answer
      // on every retry
      const already = () => json({ ok: true, left: false, state: core.meet.byThread(userId, t.id)?.state ?? null });
      if (!row || !active || active.id !== row.id) return already();
      const r = await core.meet.leave(userId);
      if (!r.ok) return already(); // it ended between the check and the leave
      core.log.info("meet leave", { meeting: maskMeetCode(row.code), via: "app" });
      return json({ ok: true, left: true, state: "ended" });
    },
  };
}
