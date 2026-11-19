import { motion } from "framer-motion";
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { nav, type ScreenProps } from "../../../app/nav";
import { Screen } from "../../../app/Screen";
import { ContentSwap } from "../../../motion/ContentSwap";
import { CONTENT_DELAY, t } from "../../../motion/springs";
import { useTierValue } from "../../../motion/tier";
import { Button } from "../../../ui/Button";
import { R } from "../../../ui/geometry";
import { LargeTitle } from "../../../ui/LargeTitle";
import { ListRow, ListSection } from "../../../ui/List";
import { Toggle } from "../../../ui/Toggle";
import { josa } from "../format";
import { copyOf, Stack, useAgentName } from "../parts";
import { useCurrentSettings, useSettingsPatch } from "./useSetting";
import "./settings.css";

/**
 * 정보 공개 범위 (settings B "말한 그대로", MOTION-SPEC §6.12, research 12-5, HIG privacy). Three groups, no plates:
 *
 * 1. 보내기 전에 — the switch that keeps "nothing leaves without consent" (critique P1-1): confirmBeforeSend. On is one
 *    tap. Off asks first, in place: no modal — the same group grows (§3 Morph) and the question and 취소 | 끄기 come in
 *    by content swap (§3), a two-step tap in the same place (§8.6). The switch stays on until 끄기 (the Toggle's
 *    `onRequest` keeps the knob where it is); nothing is saved before 끄기, and 취소, Escape or leaving the screen
 *    keep it on. The group is labelled and read politely; focus goes to 취소, and back to the switch on close.
 * 2. 친구의 모시에게 — each row's subtitle IS what a friend's 모시 sees, and swaps with its toggle (the preview card
 *    is gone: the same thing is never said twice).
 * 3. memory, under the agent's name.
 * Every change is optimistic; a failure springs the control back and the island says so once (§8.13).
 */
export function PrivacyScreen({ route }: ScreenProps) {
  const s = useCurrentSettings();
  const patch = useSettingsPatch();
  const agentName = useAgentName();
  const reduce = useTierValue("reduceMotion");
  const cardRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [confirming, setConfirming] = useState(false);
  const p = s?.privacy;
  const asking = !!s?.confirmBeforeSend;
  const set = (k: "friendsCanSeeSchedule" | "friendsCanAskMyPickle" | "shareLocation" | "memoryEnabled") => (v: boolean) => patch({ privacy: { [k]: v } }, "정보 공개 범위");

  // turned off elsewhere (another device) while asking: nothing left to confirm
  useEffect(() => {
    if (!asking) setConfirming(false);
  }, [asking]);
  useEffect(() => {
    if (confirming) cancelRef.current?.focus();
  }, [confirming]);

  const focusSwitch = () => cardRef.current?.querySelector<HTMLElement>('[role="switch"]')?.focus();
  const requestAsk = (next: boolean) => {
    if (next || !asking) return true;
    setConfirming(true);
    return false;
  };
  const cancel = () => {
    setConfirming(false);
    focusSwitch();
  };
  const turnOff = () => {
    setConfirming(false);
    patch({ confirmBeforeSend: false }, "보내기 전 확인");
    focusSwitch();
  };
  const onCardKey = (e: KeyboardEvent) => {
    if (e.key !== "Escape" || !confirming) return;
    e.stopPropagation();
    cancel();
  };

  // the grow (§3 Morph): the group re-shapes on `morph` (transform only, radius corrected); what sits below it moves
  // with it. Measured only when the confirm opens or closes. Reduced motion: the new layout, at once.
  const morph = { layoutDependency: confirming, transition: { layout: t("morph") } };
  const moves = { layout: reduce ? false : ("position" as const), ...morph };

  return (
    <Screen routeKey={route.key}>
      <LargeTitle title={route.title ?? "정보 공개 범위"} layoutId={route.titleLayoutId} />
      <Stack>
        <section className="list-section" aria-labelledby="privacy-ask-h">
          <div className="list">
            <div className="list-header">
              <h2 className="list-section-title" id="privacy-ask-h">
                보내기 전에
              </h2>
            </div>
            <motion.div ref={cardRef} className="list-card privacy-ask" layout={!reduce} style={{ borderRadius: R.group }} onKeyDown={onCardKey} {...morph}>
              <motion.div {...moves}>
                <ListRow
                  title="다른 사람에게 보내기 전에 묻기"
                  subtitle={
                    <ContentSwap swapKey={asking || !s ? "on" : "off"}>{asking || !s ? "메시지를 보내기 전에 보낼 내용을 그대로 보여 드리고 확인받아요" : "지금은 묻지 않고 바로 보내요"}</ContentSwap>
                  }
                  accessory={<Toggle label="다른 사람에게 보내기 전에 묻기" checked={asking} onRequest={requestAsk} onChange={(v) => patch({ confirmBeforeSend: v }, "보내기 전 확인")} disabled={!s} />}
                />
              </motion.div>
              <motion.div className="privacy-ask__live" aria-live="polite" {...moves}>
                <ContentSwap as="div" display="block" swapKey={confirming ? "ask" : "idle"} enterDelay={CONTENT_DELAY}>
                  {confirming ? (
                    <div className="privacy-confirm" role="group" aria-labelledby="privacy-confirm-h" aria-describedby="privacy-confirm-b">
                      <p className="privacy-confirm__title" id="privacy-confirm-h">
                        이제 {josa(agentName, "이가")} 묻지 않고 보내요
                      </p>
                      <p className="privacy-confirm__body" id="privacy-confirm-b">
                        언제든 여기서 다시 켤 수 있어요.
                      </p>
                      <div className="privacy-confirm__actions">
                        <Button ref={cancelRef} tone="neutral" size="md" onClick={cancel}>
                          취소
                        </Button>
                        <Button tone="destructive" size="md" onClick={turnOff}>
                          끄기
                        </Button>
                      </div>
                    </div>
                  ) : null}
                </ContentSwap>
              </motion.div>
            </motion.div>
            <motion.div className="list-footer t-copy" {...moves}>
              {copyOf("결제와 지우기처럼 되돌릴 수 없는 일은 이 설정과 관계없이 항상 확인받아요.")}
            </motion.div>
          </div>
        </section>

        <motion.div aria-live="polite" {...moves}>
          <ListSection title="친구의 모시에게" footer="로그인 정보는 어떤 경우에도 친구의 모시에게 보이지 않아요.">
            <ListRow
              title="부탁 받기"
              subtitle={<Seen on={p?.friendsCanAskMyPickle} yes="친구의 모시가 내 모시에게 말을 전하거나 물어볼 수 있어요" no="친구의 모시는 부탁할 수 없어요" />}
              accessory={<Toggle label="친구 모시의 부탁 받기" checked={!!p?.friendsCanAskMyPickle} onChange={set("friendsCanAskMyPickle")} disabled={!p} />}
            />
            <ListRow
              title="내 일정 보여 주기"
              subtitle={<Seen on={p?.friendsCanSeeSchedule} yes="친구의 모시에게 ‘오후 3:00 · 팀 회의’처럼 제목과 시간만 보여요" no="친구의 모시는 내 일정을 볼 수 없어요" />}
              accessory={<Toggle label="내 일정 보여 주기" checked={!!p?.friendsCanSeeSchedule} onChange={set("friendsCanSeeSchedule")} disabled={!p} />}
            />
            <ListRow
              title="대략적인 위치"
              subtitle={<Seen on={p?.shareLocation} yes="‘강남구 근처’처럼 구 단위까지만 보여요" no="친구의 모시는 내 위치를 볼 수 없어요" />}
              accessory={<Toggle label="대략적인 위치 보여 주기" checked={!!p?.shareLocation} onChange={set("shareLocation")} disabled={!p} />}
            />
          </ListSection>
        </motion.div>

        <motion.div {...moves}>
          <ListSection title={agentName} footer={`끄면 새로 기억하지 않아요. 이미 기억한 내용은 ${agentName} 설정에서 하나씩 지울 수 있어요.`}>
            <ListRow
              title={`${josa(agentName, "이가")} 기억하기`}
              subtitle="대화에서 알게 된 취향과 정보를 기억해 다음에 써요"
              accessory={<Toggle label={`${josa(agentName, "이가")} 기억하기`} checked={!!p?.memoryEnabled} onChange={set("memoryEnabled")} disabled={!p} />}
            />
            <ListRow title="기억한 내용 보기" onClick={() => nav.push("agent", { section: "memories" }, { title: agentName })} />
          </ListSection>
        </motion.div>
      </Stack>
    </Screen>
  );
}

/**
 * What a friend's 모시 sees, swapping with the toggle (§3 Content swap). Before settings load: the "on" sentence. The
 * sentence goes through copy() here: the row gets a node, so ListRow leaves it as it is ("‘오후 3:00 · 팀 회의’처럼").
 */
function Seen({ on, yes, no }: { on: boolean | undefined; yes: ReactNode; no: ReactNode }) {
  const v = on ?? true;
  return <ContentSwap swapKey={v ? "on" : "off"}>{copyOf(v ? yes : no)}</ContentSwap>;
}
