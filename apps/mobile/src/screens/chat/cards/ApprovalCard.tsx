import type { ApprovalCard as Approval, ID, ToolActivity } from "@pickle/protocol";
import { AnimatePresence, motion } from "framer-motion";
import { Fragment, useEffect, useId, useState } from "react";
import * as ep from "../../../api/endpoints";
import { decideApproval, useAgent } from "../../../api/store";
import { ContentSwap } from "../../../motion/ContentSwap";
import { EXIT, t } from "../../../motion/springs";
import { Avatar, DEFAULT_AVATAR } from "../../../ui/Avatar";
import { Button } from "../../../ui/Button";
import { ConfirmButton } from "../../../ui/ConfirmButton";
import { Icon, type AppIconName } from "../../../ui/Icon";
import { copy } from "../../../ui/Text";
import { clockKo, riskOf, type Risk } from "../util";
import { MeetFollow, phaseOf, useMeetOfApproval } from "./MeetFollow";

/** a call is one-way: said under the words it carries */
const ONE_WAY = "이 말을 전하고 끊어요. 상대의 대답은 들을 수 없어요.";
/** the server's words in a copy slot (ui/Text.tsx: a sentence that fits a line never splits across two), with the
 *  line breaks it wrote kept (the slot is pre-wrap) */
const paragraphs = (text: string) =>
  text.split("\n").map((line, i) => (
    <Fragment key={i}>
      {i > 0 ? "\n" : null}
      {copy(line)}
    </Fragment>
  ));

/**
 * Approval card by risk (MOTION-SPEC §8.6, research §3-4), worded by what the tool actually does.
 *  - medium: a message to others shows the FULL preview of exactly what will be sent + 보내기; joining a meeting shows
 *    one meta line "Google Meet · {code}" (the full code from `card.meet`, owner's device only; else the title's,
 *    masked), what the agent will do there and the purpose + 참여 승인. Approved, the join card follows the meeting it
 *    started (meeting B, MeetFollow.tsx): on its way in → in the meeting (회의에서 내보내기) → ended, in place.
 *    Anything else: its plain detail + 승인하기.
 *  - high (phone call, payment, delete): the summary + ConfirmButton — hold 1.2 s or tap twice in the same place, said
 *    in visible words under the button too (phone B). A call (phone B) is checked in the order the person checks it:
 *    the title names who, then the FULL number it will dial as the card's largest line (`card.call`, sent to the owner's
 *    device only; title/detail stay masked), a hairline, the agent's face before the words (the voice the other side
 *    hears), and that the call is one-way. No glyph: the number says what this is.
 *  - low (reversible): one approve button + "되돌릴 수 있어요" (the agent normally just does these with an undo banner).
 * One accent: the approve action is the only blue; 취소 is neutral. No icon plate: a glyph that names the action sits
 * inline before the title (phone, people, card, trash, send), and none when it would only decorate.
 * Every tier signs the approval with this device's key (decideApproval → @pickle/vault). The card flips only when the
 * server accepted the decision (stream `start`); then it folds into a receipt pill, and once the access log confirms
 * the signature verified it says "이 기기의 키로 확인했어요".
 */

type Kind = "phone" | "meet" | "pay" | "delete" | "message" | "other";
const KIND_GLYPH: Record<Kind, AppIconName | null> = { phone: null, meet: "people", pay: "card", delete: "trash", message: "send", other: null };

function kindOf(card: Approval, tools: ToolActivity[]): Kind {
  const names = tools.map((t) => t.name);
  if (names.includes("sys_phone_call") || /전화/.test(card.title)) return "phone";
  if (names.includes("sys_join_meet") || /Google Meet|회의\(/.test(card.title)) return "meet";
  if (typeof card.amount === "number") return "pay";
  if (/삭제|지울/.test(card.title) || names.some((n) => /delete/.test(n))) return "delete";
  if (names.some((n) => /^msg_/.test(n) || n === "sys_friend_message")) return "message";
  return "other";
}

/** "abc-defg-hij" → "abc-****-hij" (the same mask the server uses in its notes) */
const maskMeetCode = (code: string) => {
  const p = code.split("-");
  return p.length === 3 ? `${p[0]}-****-${p[2]}` : code;
};

/** the meeting on a join card: the FULL code from `card.meet` (sent to the owner's device only); without it (cards
 * stored before the field) the code in the title, masked (the server masks new titles; older ones weren't). The
 * purpose comes from the detail's "목적:" line. */
function meetOf(card: Approval): { code: string | null; purpose: string | null; body: string } {
  const titled = /\(([a-z]{3}-(?:[a-z]{4}|\*{4})-[a-z]{3})\)/i.exec(card.title)?.[1] ?? null;
  const code = card.meet?.code?.trim() || (titled ? maskMeetCode(titled.toLowerCase()) : null);
  const lines = card.detail.split("\n");
  const purposeLine = lines.find((l) => /^\s*목적\s*[:：]/.test(l));
  const purpose = purposeLine ? purposeLine.replace(/^\s*목적\s*[:：]\s*/, "").trim() || null : null;
  return { code, purpose, body: lines.filter((l) => l !== purposeLine).join("\n").trim() };
}
const verified = new Map<ID, boolean>();
const decidedAt = new Map<ID, number>();

async function checkVerified(since: number): Promise<boolean> {
  try {
    const log = await ep.accessLog(10);
    return log.some((r) => r.deviceVerified && r.createdAt >= since - 5_000 && r.outcome !== "denied");
  } catch {
    return false;
  }
}

export function ApprovalCard({ card, threadId, tools, interactive }: { card: Approval; threadId: ID; tools: ToolActivity[]; interactive: boolean }) {
  const risk: Risk = riskOf(card, tools);
  const kind = kindOf(card, tools);
  const agent = useAgent();
  const face = agent?.avatar ?? DEFAULT_AVATAR;
  const descId = useId();
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isVerified, setVerified] = useState(() => verified.get(card.approvalId) ?? false);

  // when the person decided: this tab's own tap, else the server's record (`decidedAt`, once the server sends it)
  const decidedTime = decidedAt.get(card.approvalId) ?? (card as Approval & { decidedAt?: number }).decidedAt;
  useEffect(() => {
    if (card.status !== "approved" || verified.get(card.approvalId)) return;
    const since = decidedTime;
    if (!since) return;
    let alive = true;
    void checkVerified(since).then((ok) => {
      verified.set(card.approvalId, ok);
      if (alive) setVerified(ok);
    });
    return () => {
      alive = false;
    };
  }, [card.status, card.approvalId, decidedTime]);

  const decide = async (decision: "approve" | "reject") => {
    setError(null);
    setBusy(decision);
    decidedAt.set(card.approvalId, Date.now());
    const r = await decideApproval(threadId, card.approvalId, decision);
    setBusy(null);
    if (!r.ok && r.error.code !== "aborted") {
      setError(r.error.message);
      throw r.error;
    }
  };

  const glyph = KIND_GLYPH[kind];
  const pending = card.status === "pending";
  const confirmLabel = kind === "phone" ? "전화 걸기" : kind === "pay" ? "결제하기" : kind === "delete" ? "삭제하기" : "승인하기";
  const approveLabel = kind === "meet" ? "참여 승인" : kind === "message" ? "보내기" : "승인하기";
  const call = kind === "phone" ? card.call : undefined;
  const meet = kind === "meet" ? meetOf(card) : null;
  const [meeting, rereadMeeting] = useMeetOfApproval(threadId, card.approvalId, kind === "meet" && card.status === "approved");
  const meetPhase = meeting ? phaseOf(meeting) : null;
  // an ended meeting is a record: what the agent was going to do there is no longer news
  const meetOver = meetPhase === "ended" || meetPhase === "failed";
  const friendMessage = tools.some((t) => t.name === "sys_friend_message");

  return (
    <section
      className="ccard ccard-approval"
      data-risk={risk}
      data-kind={kind}
      data-status={card.status}
      data-approval-pending={pending || undefined}
      data-approval-id={card.approvalId}
      role="group"
      aria-label={card.title}
      aria-describedby={descId}
    >
      <div className="ccard-head appr-head">
        {glyph && <Icon name={glyph} size={17} weight="medium" className="appr-glyph" />}
        <h3 className="ccard-title">{meet ? "회의 참여" : card.title}</h3>
      </div>

      {call ? (
        <div className="appr-call" id={descId}>
          <p className="appr-number tnum" data-missing={call.number ? undefined : true}>
            {call.number ?? "번호 확인 필요"}
          </p>
          {call.digits && <p className="appr-sub t-copy tnum">{copy(`연결되면 ${call.digits.replace(/w/g, "")}을 눌러요`)}</p>}
          <div className="appr-voice">
            <Avatar spec={face} size={24} />
            <p className="appr-script">“{call.message}”</p>
          </div>
          <p className="appr-sub t-copy">{copy(ONE_WAY)}</p>
        </div>
      ) : meet ? (
        <div className="appr-meet" id={descId}>
          <p className="appr-meta">
            Google Meet
            {meet.code && (
              <>
                <span aria-hidden="true"> · </span>
                <span className="tnum appr-code">{meet.code}</span>
              </>
            )}
          </p>
          <AnimatePresence initial={false}>
            {!meetOver && (meet.body || meet.purpose) && (
              <motion.div
                key="meet-what"
                className="appr-meet-what"
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={{ height: 0, opacity: 0, transition: EXIT }}
                transition={t("morph")}
              >
                {meet.body && <p className="appr-detail t-copy">{paragraphs(meet.body)}</p>}
                {meet.purpose && <p className="appr-sub t-copy">{copy(`목적 · ${meet.purpose}`)}</p>}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      ) : kind === "message" ? (
        <div className="appr-preview" id={descId}>
          <span className="appr-preview-label">{friendMessage ? "전할 말" : "보낼 내용"}</span>
          <p className="appr-preview-text">{card.detail}</p>
        </div>
      ) : (
        <div className="appr-body" id={descId}>
          <p className="appr-detail t-copy">{paragraphs(card.detail)}</p>
          {kind === "phone" && <p className="appr-sub t-copy">{copy(ONE_WAY)}</p>}
        </div>
      )}
      {typeof card.amount === "number" && (
        <p className="appr-amount tnum" aria-label={`금액 ${card.amount.toLocaleString("ko-KR")}원`}>
          {card.amount.toLocaleString("ko-KR")}원
        </p>
      )}

      <ContentSwap swapKey={pending ? "pending" : meeting ? "meeting" : card.status} display="block">
        {pending ? (
          <div className="appr-actions" data-risk={risk}>
            {risk === "high" ? (
              <>
                <ConfirmButton
                  label={confirmLabel}
                  holdMs={1200}
                  tone={kind === "delete" ? "destructive" : "primary"}
                  disabled={!interactive || (!!call && !call.number)}
                  onConfirm={() => decide("approve")}
                />
                {/* the same words the button's description reads, visible (it is already announced: aria-hidden) */}
                <p className="appr-hold-hint" aria-hidden="true">
                  길게 누르거나, 두 번 눌러 확인해요
                </p>
                <Button variant="plain" tone="neutral" size="md" disabled={!interactive || !!busy} action={() => decide("reject")}>
                  취소
                </Button>
              </>
            ) : (
              <>
                <Button variant="capsule" tone="neutral" size="md" disabled={!interactive || busy === "approve"} action={() => decide("reject")}>
                  취소
                </Button>
                <Button variant="capsule" tone="primary" size="md" disabled={!interactive || busy === "reject"} action={() => decide("approve")} busyLabel="기기 키로 서명하는 중">
                  {approveLabel}
                </Button>
              </>
            )}
            {risk === "low" && <p className="appr-note">되돌릴 수 있어요</p>}
          </div>
        ) : meeting && card.status === "approved" ? (
          <MeetFollow meeting={meeting} agentName={agent?.name ?? "깽이"} face={face} approvedAt={decidedTime} verified={isVerified} onChanged={rereadMeeting} />
        ) : (
          <Receipt status={card.status} verified={isVerified} at={decidedTime} />
        )}
      </ContentSwap>
      {error && (
        <p className="ccard-error" role="alert">
          <Icon name="exclamation" size={15} weight="medium" /> {error}
        </p>
      )}
    </section>
  );
}

function Receipt({ status, verified: ok, at }: { status: Approval["status"]; verified: boolean; at?: number }) {
  const text = status === "approved" ? "승인했어요" : status === "rejected" ? "취소했어요" : "시간이 지나 만료됐어요";
  return (
    <div className="appr-receipt" data-status={status}>
      <span className="appr-receipt-pill">
        <Icon name={status === "approved" ? "check-circle" : status === "rejected" ? "x-circle" : "clock"} size={16} weight="medium" />
        <span>
          {text}
          {at && status !== "expired" ? ` · ${clockKo(at)}` : ""}
        </span>
      </span>
      {status === "approved" && ok && (
        <span className="appr-verified">
          <Icon name="shield" size={14} weight="medium" />이 기기의 키로 확인했어요
        </span>
      )}
    </div>
  );
}
