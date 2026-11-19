import type { AvatarSpec, ID } from "@pickle/protocol";
import { useEffect, useState } from "react";
import { apiGet, apiPost, toApiError, type ApiError } from "../../../api/client";
import { messagesStore, threadsStore } from "../../../api/store";
import { useStore } from "../../../lib/createStore";
import { ContentSwap } from "../../../motion/ContentSwap";
import { Avatar } from "../../../ui/Avatar";
import { ConfirmButton } from "../../../ui/ConfirmButton";
import { Icon } from "../../../ui/Icon";
import type { MeetSummary } from "../MeetLive";
import { clockKo, clockRangeKo, josa } from "../util";

/**
 * Meeting B (2026-11-12, user pick): the join card IS the meeting. Once approved, the card in the thread where the
 * person asked follows the meeting it started — on its way in → "회의에 들어와 있어요" (the agent's face, the wake-word
 * hint, a full-width neutral "회의에서 내보내기") → "회의가 끝나서 나왔어요 · 오전 10:04 – 10:46 · 42분" — re-shaping in
 * place (MOTION-SPEC §3 morph; the status block is a content swap). The approval itself becomes one footnote line.
 * The meeting is read from GET /api/threads/:origin/meet?approval=:id (server meetRoutes.ts) when the card mounts and
 * again whenever the origin thread or the meeting's own '회의 참여' thread changes (the server notes every state change
 * there and publishes the thread), so nothing polls. Leaving uses the meeting thread's POST …/meet/leave (idempotent).
 * No meeting found (an older server, or a card from before the link) → the plain receipt, as before.
 */
export type MeetPhase = "joining" | "live" | "ended" | "failed";

export interface MeetFollowView extends MeetSummary {
  /** the '회의 참여' thread (leave, refetch) */
  threadId?: ID;
  /** the latest state sentence the server posted to that thread (masked), null before the first */
  note?: string | null;
  reason?: string | null;
}

const JOINING = new Set(["launching", "prejoin", "waiting_admission"]);

export function phaseOf(m: MeetFollowView): MeetPhase {
  if (m.state === "in_call") return "live";
  if (JOINING.has(m.state)) return "joining";
  if (m.state === "ended") return "ended";
  return "failed";
}

/** the server's note → a head line (its first sentence, no full stop) and the rest */
export function splitNote(note: string | null | undefined, fallback: string): [string, string | null] {
  const text = (note ?? "").trim() || fallback;
  const m = /^(.+?[.!?])(\s+[\s\S]*)?$/.exec(text);
  const head = (m ? m[1]! : text).replace(/[.]$/, "");
  const rest = m?.[2]?.trim() || null;
  return [head, rest];
}

/** "42분" · "1시간 5분" (a meeting's length, minutes only) */
export function meetLengthKo(ms: number): string {
  const m = Math.max(1, Math.round(ms / 60_000));
  if (m < 60) return `${m}분`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? `${h}시간 ${r}분` : `${h}시간`;
}

/**
 * The meeting an approved join card started. `undefined` while the first read is out, `null` when there is none.
 * Rereads on the origin thread's message count and on the meeting thread's `updatedAt`.
 */
export function useMeetOfApproval(originId: ID, approvalId: ID, enabled: boolean): [MeetFollowView | null | undefined, () => void] {
  const [meeting, setMeeting] = useState<MeetFollowView | null | undefined>(undefined);
  const [reread, setReread] = useState(0);
  const originTick = useStore(messagesStore, (s) => s[originId]?.items.length ?? 0);
  const meetThread = meeting?.threadId;
  const meetTick = useStore(threadsStore, (s) => (meetThread ? (s.items.find((t) => t.id === meetThread)?.updatedAt ?? 0) : 0));
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    apiGet<{ meeting: MeetFollowView | null }>(`/api/threads/${encodeURIComponent(originId)}/meet?approval=${encodeURIComponent(approvalId)}`)
      .then((r) => {
        if (alive) setMeeting(r?.meeting ?? null);
      })
      .catch(() => {
        if (alive) setMeeting((m) => m ?? null);
      });
    return () => {
      alive = false;
    };
  }, [enabled, originId, approvalId, originTick, meetTick, reread]);
  return [meeting, () => setReread((n) => n + 1)];
}

export function MeetFollow({
  meeting,
  agentName,
  face,
  approvedAt,
  verified,
  onChanged,
}: {
  meeting: MeetFollowView;
  agentName: string;
  face: AvatarSpec;
  approvedAt?: number;
  verified: boolean;
  onChanged: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [left, setLeft] = useState(false);
  const phase: MeetPhase = left && phaseOf(meeting) !== "ended" && phaseOf(meeting) !== "failed" ? "ended" : phaseOf(meeting);

  const leave = async () => {
    setError(null);
    if (!meeting.threadId) return;
    try {
      await apiPost(`/api/threads/${encodeURIComponent(meeting.threadId)}/meet/leave`);
    } catch (e) {
      const err: ApiError = toApiError(e);
      // already out (it ended on its own meanwhile): nothing for the person to fix
      if (err.code !== "not_live" && err.status !== 404) {
        setError(err.message);
        throw e;
      }
    }
    setLeft(true);
    onChanged();
  };

  const [head, rest] = splitNote(left && phase === "ended" && phaseOf(meeting) !== "ended" ? "회의에서 나왔어요." : meeting.note, phase === "ended" ? "회의가 끝나서 나왔어요." : "회의에 참여하지 못했어요.");
  const from = meeting.joinedAt ?? meeting.startedAt;
  const span = meeting.endedAt ? `${clockRangeKo(from, meeting.endedAt)} · ${meetLengthKo(meeting.endedAt - from)}` : null;
  const call = josa(agentName, "아", "야");

  return (
    <>
      <ContentSwap swapKey={phase} display="block" as="div" className="meet-follow-swap">
        <div className="meet-follow" data-phase={phase}>
          {phase === "ended" || phase === "failed" ? (
            <>
              <p className="meet-state" role={phase === "failed" ? "alert" : undefined}>
                <Icon name={phase === "ended" ? "check-circle" : "exclamation"} size={18} weight="medium" className="meet-state-glyph" />
                {head}
              </p>
              {phase === "ended" && span && <p className="meet-state-sub tnum">{span}</p>}
              {rest && <p className="meet-state-sub">{rest}</p>}
            </>
          ) : (
            <>
              <p className="meet-state">
                <Avatar spec={face} size={22} breathing={phase === "joining"} />
                {phase === "live" ? "회의에 들어와 있어요" : "회의에 들어가는 중이에요"}
              </p>
              <p className="meet-state-sub">
                {phase === "live"
                  ? `지금부터 받아 적어요. 회의 중에 '${call}'라고 부르면 대답해요.`
                  : meeting.state === "waiting_admission"
                    ? "참여 요청을 보냈어요. 호스트가 수락하면 들어가요."
                    : "회의 페이지를 열고 있어요."}
              </p>
              {meeting.threadId && (
                <ConfirmButton
                  label="회의에서 내보내기"
                  confirmLabel={`한 번 더 누르면 ${josa(agentName, "이", "가")} 나와요`}
                  tone="neutral"
                  size="md"
                  className="meet-leave"
                  onConfirm={leave}
                />
              )}
              {error && (
                <p className="ccard-error" role="alert">
                  <Icon name="exclamation" size={15} weight="medium" /> {error}
                </p>
              )}
            </>
          )}
        </div>
      </ContentSwap>
      {phase !== "ended" && phase !== "failed" && (
        <p className="meet-approved tnum">
          <Icon name="check-circle" size={13} weight="medium" />
          {approvedAt ? `${clockKo(approvedAt)}에 승인했어요` : "승인했어요"}
          {verified ? " · 이 기기의 키로 확인했어요" : ""}
        </p>
      )}
    </>
  );
}
