import type { ID, Thread } from "@pickle/protocol";
import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useState } from "react";
import { apiGet, apiPost, toApiError, type ApiError } from "../../api/client";
import { messagesStore } from "../../api/store";
import { useStore } from "../../lib/createStore";
import { EXIT, t } from "../../motion/springs";
import { ConfirmButton } from "../../ui/ConfirmButton";
import { Icon } from "../../ui/Icon";
import { josa } from "./util";

/**
 * The live meeting in a "회의 참여" thread (server meet.ts): where it stands and the one way out. While the agent is
 * in (or on its way into) the meeting, the end of the thread shows "회의 중 · abc-****-hij" and a neutral
 * "회의에서 내보내기" — tap, then tap again (or hold) to confirm — which asks the server to leave
 * (POST /api/threads/:id/meet/leave). The state is read from GET /api/threads/:id/meet when the thread opens and again
 * whenever a new note arrives (the server posts one on every state change); no meeting, or one that has ended, shows
 * nothing. A leave the server answers with 409 not_live (the meeting ended on its own meanwhile) or 404 is not an
 * error to the person: the agent is already out, so the control goes away and the state is read again.
 * The shape is the server's MeetView (apps/server/src/meetRoutes.ts; docs/architecture/SERVER-CONTRACT.md).
 */
export interface MeetSummary {
  id: string;
  state: string;
  live: boolean;
  /** masked, "abc-****-hij" */
  code: string;
  title: string | null;
  purpose: string;
  startedAt: number;
  joinedAt: number | null;
  endedAt: number | null;
}

/** a meeting thread: kind "call" with the people glyph (the server's "회의 참여" thread) */
export const isMeetThread = (t: Thread | null | undefined): boolean => !!t && t.kind === "call" && t.icon === "people";

const path = (threadId: ID) => `/api/threads/${encodeURIComponent(threadId)}/meet`;

const STATE_TEXT: Record<string, string> = {
  launching: "회의에 들어가는 중",
  prejoin: "회의에 들어가는 중",
  waiting_admission: "참여 요청 중",
  in_call: "회의 중",
};

export function MeetLive({ threadId, agentName }: { threadId: ID; agentName: string }) {
  const [meeting, setMeeting] = useState<MeetSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  // refetch on every new message in the thread: the server notes each state change there
  const tick = useStore(messagesStore, (s) => s[threadId]?.items.length ?? 0);
  const [reread, setReread] = useState(0);

  useEffect(() => {
    let alive = true;
    apiGet<{ meeting: MeetSummary | null }>(path(threadId))
      .then((r) => {
        if (alive) setMeeting(r?.meeting ?? null);
      })
      .catch(() => {
        if (alive) setMeeting(null);
      });
    return () => {
      alive = false;
    };
  }, [threadId, tick, reread]);

  const leave = async () => {
    setError(null);
    try {
      await apiPost(`${path(threadId)}/leave`);
    } catch (e) {
      const err: ApiError = toApiError(e);
      // already out (ended on its own, or the thread has no meeting): nothing for the person to fix
      if (err.code !== "not_live" && err.status !== 404) {
        setError(err.message);
        throw e;
      }
      setReread((n) => n + 1);
    }
    setMeeting((m) => (m ? { ...m, live: false, state: "ended" } : m));
  };

  const live = !!meeting?.live;
  return (
    <AnimatePresence initial={false}>
      {live && meeting && (
        <motion.section
          key="meet-live"
          className="meet-live"
          aria-label="진행 중인 회의"
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, transition: EXIT }}
          transition={t("snap")}
        >
          <p className="meet-live-state">
            {STATE_TEXT[meeting.state] ?? "회의 중"}
            {meeting.code && (
              <>
                <span aria-hidden="true"> · </span>
                <span className="tnum">{meeting.code}</span>
              </>
            )}
          </p>
          <ConfirmButton
            label="회의에서 내보내기"
            confirmLabel={`한 번 더 누르면 ${josa(agentName, "이", "가")} 나와요`}
            tone="neutral"
            size="md"
            fullWidth={false}
            onConfirm={leave}
          />
          {error && (
            <p className="meet-live-error" role="alert">
              <Icon name="exclamation" size={15} weight="medium" /> {error}
            </p>
          )}
        </motion.section>
      )}
    </AnimatePresence>
  );
}
