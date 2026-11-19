import type { TaskTemplate } from "@pickle/protocol";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { toApiError } from "../../../api/client";
import * as ep from "../../../api/endpoints";
import { loadConnections, loadProfile, sendMessage, upsertThread, useConnections, useQuota } from "../../../api/store";
import { nav } from "../../../app/nav";
import { Button, type ButtonState } from "../../../ui/Button";
import { R } from "../../../ui/geometry";
import { Icon } from "../../../ui/Icon";
import { Sheet, type SheetSource } from "../../../ui/Sheet";
import { friendsRes, skillsRes, useResource } from "../data";
import { josa } from "../format";
import { InlineError, Lead, Note, ProviderIcon, SectionLabel, useAgentName } from "../parts";
import { usePhone } from "../profile/phone";
import { presentPhone } from "../profile/PhoneSheet";
import { asksFirst, estimateSeconds, estimateTokens, needsFor, resultFor, secondsKo, stepsFor, type Need } from "./templateInfo";

/**
 * "맡기기 전 확인" (MOTION-SPEC §8.9, draft B): the tapped row morphs into this sheet. Its sentence-length title reads
 * from the leading edge; the body says what the agent will do in plain numbered lines (source under each) and where
 * the result lands. What is still missing (a messenger to connect, a friend, a verified phone number) and what it
 * costs (time · quota · what is left today) sit in one block right above "맡기기", the screen's only accent; nothing
 * that is already in place is listed. 맡기기 = POST delegate → the check draws once the server created the thread →
 * the sheet folds away, the chat tab opens that thread and the prompt goes out as the first message (optimistic
 * bubble in the same frame). call-demo opens its call thread without sending; without a verified number its button
 * is "인증하고 받아 보기": the phone sheet takes this sheet's place (one sheet at a time) and the screen brings this
 * sheet back once the server says the number is verified (onNeedPhone), now with "전화 받아 보기".
 */
export function PreDelegateSheet({
  tpl,
  source,
  open,
  onClose,
  onClosed,
  onNeedPhone,
}: {
  tpl: TaskTemplate;
  source: SheetSource;
  open: boolean;
  onClose: () => void;
  onClosed: () => void;
  /** "인증하고 받아 보기": open the phone sheet from this element (default: just present it) */
  onNeedPhone?: (el: HTMLElement) => void;
}) {
  const agentName = useAgentName();
  const quota = useQuota();
  const skills = useResource(skillsRes, open);
  const friends = useResource(friendsRes, open && tpl.skills.includes("sys_friend_message"));
  const conns = useConnections();
  const phone = usePhone();
  const isCall = tpl.id === "call-demo";
  const [state, setState] = useState<ButtonState>("idle");
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    if (open && !conns.loaded && !conns.loading && tpl.skills.some((s) => s.startsWith("msg_"))) void loadConnections();
  }, [open, conns.loaded, conns.loading, tpl]);
  useEffect(() => {
    if (open && isCall && phone === undefined) void loadProfile();
  }, [open, isCall, phone]);

  const needs = useMemo(
    () => needsFor(tpl, conns.providers, conns.connections, friends.data.filter((f) => f.status === "accepted").length),
    [tpl, conns.providers, conns.connections, friends.data],
  );
  const steps = useMemo(() => stepsFor(tpl, skills.data, needs.find((n) => n.kind === "messenger")?.name), [tpl, skills.data, needs]);
  // undefined while the profile loads: say nothing about the number until the server has answered
  const needsPhone = isCall && phone !== undefined && !phone?.verified;
  const missing = needs.filter((n) => !n.connected);
  const tokens = estimateTokens(tpl);
  const pct = quota ? Math.max(1, Math.round((tokens / Math.max(1, quota.limitTokens)) * 100)) : null;
  const left = quota ? Math.max(0, 100 - quota.usedPct) : null;
  const outOfQuota = left !== null && left <= 0;
  const result = resultFor(tpl);
  const facts = [secondsKo(estimateSeconds(tpl)), pct !== null ? `한도 약 ${pct}%` : "한도 조금", left !== null ? `오늘 ${left}% 남음` : null].filter(Boolean).join(" · ");

  const delegate = async () => {
    if (state === "loading" || state === "success") return;
    setError(null);
    setState("loading");
    try {
      const res = await ep.delegate(tpl.id);
      if (!alive.current) return;
      upsertThread(res.thread);
      setState("success");
      // the check is the server's confirmation; then the sheet folds and the work continues in the thread
      window.setTimeout(() => {
        onClose();
        nav.setTab("chat");
        nav.push("thread", { threadId: res.thread.id }, { title: res.thread.title });
        if (res.prompt && !isCall) void sendMessage(res.thread.id, res.prompt);
      }, 320);
    } catch (e) {
      if (!alive.current) return;
      setState("error");
      setError(toApiError(e).message);
    }
  };

  const press = (el: HTMLElement) => {
    if (!needsPhone) return void delegate();
    if (onNeedPhone) onNeedPhone(el);
    else presentPhone(el);
  };

  const openNeed = (n: Need) => {
    onClose();
    if (n.kind === "friend") nav.push("friends", undefined, { title: "친구" });
    else nav.push("connections", { focus: n.providers[0] }, { title: "앱 연결" });
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      onClosed={onClosed}
      source={source}
      busy={state === "loading"}
      title={tpl.title}
      titleAlign="start"
      className="pre-sheet"
      footer={
        <div className="pre-footer">
          {(missing.length > 0 || needsPhone) && (
            <div className="pre-needs" role="group" aria-label="준비할 것">
              {needsPhone && <NeedLine id="phone" lead={<Icon name="phone" size={20} weight="medium" />} title="내 전화번호" sub="인증해야 전화를 받을 수 있어요" />}
              {missing.map((n) =>
                n.kind === "friend" ? (
                  <NeedLine
                    key={n.name}
                    id="friend"
                    lead={<Icon name="people" size={20} weight="medium" />}
                    title="친구"
                    sub="친구가 있어야 말을 전할 수 있어요"
                    action={
                      <Button tone="secondary" size="sm" onClick={() => openNeed(n)}>
                        초대하기
                      </Button>
                    }
                  />
                ) : (
                  <NeedLine
                    key={n.name}
                    id={n.providers[0] ?? n.kind}
                    lead={<ProviderIcon provider={{ id: n.brand ?? "", icon: n.icon, hue: n.hue }} size={30} radius={R.plate} glyph={17} />}
                    title={n.name}
                    sub="연결하지 않으면 대화 중에 로그인 정보를 물어봐요"
                    action={
                      <Button tone="secondary" size="sm" onClick={() => openNeed(n)}>
                        연결하기
                      </Button>
                    }
                  />
                ),
              )}
            </div>
          )}
          <p className="pre-facts tnum">{facts}</p>
          <InlineError>{error}</InlineError>
          {outOfQuota && <Note icon="info">오늘 한도를 다 썼어요. 나의 모시에서 초기화 티켓을 쓰면 바로 맡길 수 있어요.</Note>}
          <Button
            tone="primary"
            size="lg"
            fullWidth
            state={state}
            onClick={(e) => press(e.currentTarget)}
            disabled={outOfQuota}
            busyLabel="맡기는 중"
            successLabel="맡겼어요"
            errorLabel="다시 맡기기"
          >
            {needsPhone ? "인증하고 받아 보기" : isCall ? "전화 받아 보기" : "맡기기"}
          </Button>
        </div>
      }
    >
      <div className="more-sheet pre-body" data-template={tpl.id}>
        <Lead>{tpl.description}</Lead>

        <section className="more-sheet-group" aria-labelledby="pre-steps">
          <SectionLabel level={3} id="pre-steps">
            {josa(agentName, "이가")} 이렇게 해요
          </SectionLabel>
          <ol className="pre-steps">
            {steps.map((s, i) => (
              <li key={s.id + i} className="pre-step">
                <span className="pre-step-no tnum" aria-hidden="true">
                  {i + 1}
                </span>
                <span className="pre-step-main">
                  <span className="pre-step-title">{s.title}</span>
                  {s.source && <span className="pre-step-sub">{s.source}</span>}
                </span>
              </li>
            ))}
          </ol>
          {asksFirst(tpl) && <Note icon="chat">시작하기 전에 필요한 것만 짧게 물어봐요.</Note>}
        </section>

        <Note icon={result.icon}>{result.text}</Note>
      </div>
    </Sheet>
  );
}

/** one missing prerequisite: a bare glyph or the service's app icon, what it is, why, and its own action if it has one */
function NeedLine({ id, lead, title, sub, action }: { id: string; lead: ReactNode; title: string; sub: string; action?: ReactNode }) {
  return (
    <div className="pre-need" data-need={id}>
      <span className="pre-need-lead" aria-hidden="true">
        {lead}
      </span>
      <span className="pre-need-main">
        <span className="pre-need-title">{title}</span>
        <span className="pre-need-sub">{sub}</span>
      </span>
      {action}
    </div>
  );
}
