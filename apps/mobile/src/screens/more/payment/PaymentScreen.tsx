import type { ScreenProps } from "../../../app/nav";
import { Screen } from "../../../app/Screen";
import { Button } from "../../../ui/Button";
import { EmptyState } from "../../../ui/EmptyState";
import { LargeTitle } from "../../../ui/LargeTitle";
import { josa } from "../format";
import { SectionLabel, Stack, useAgentName } from "../parts";
import { presentPrivacy } from "../profile/PrivacySheet";
import "./payment.css";

/**
 * 결제 수단 (research §4-6): this build has no payment backend, so the state says it can't be done yet (not "none
 * added yet", which reads as "add one", payment P2-1), and a short list says how a card would be kept once it can —
 * under a conditional label, as plain rows, not steps (P2-2, GR-R2). No fake "add card" button. How a login is sealed
 * is told once, in the privacy sheet (CP-5): the one action opens it, labelled by what it shows. No tiles beside the
 * rows (IT-16): the titles carry them. The body measure is em-based so both engines wrap alike and all three rows end
 * above the tab bar (P3-1).
 */
export function PaymentScreen({ route }: ScreenProps) {
  const agentName = useAgentName();
  return (
    <Screen routeKey={route.key}>
      <LargeTitle title={route.title ?? "결제 수단"} layoutId={route.titleLayoutId} />
      <Stack>
        <EmptyState
          icon="card"
          className="pay-empty"
          title="아직 연결할 수 없어요"
          body={`${josa(agentName, "이가")} 대신 결제하는 일도 하지 않아요.`}
          action={
            <Button tone="secondary" size="md" icon="key" onClick={(e) => presentPrivacy(e.currentTarget)}>
              로그인 정보는 어떻게 지키는지 보기
            </Button>
          }
        />
        <section className="pay-how" aria-labelledby="pay-how-h">
          <SectionLabel id="pay-how-h">결제 수단을 연결할 수 있게 되면</SectionLabel>
          <ul className="pay-steps paper">
            <Step title="저장된 로그인처럼 보관해요" body="카드 정보도 저장된 로그인과 같은 방식으로 보관하고, 언제든 지울 수 있어요." />
            <Step title="결제할 때마다 물어봐요" body={`${josa(agentName, "이가")} 금액과 가게를 보여 드리고, 직접 확인한 다음에만 결제해요. 정보 공개 범위 설정과 관계없어요.`} />
            <Step title="모두 기록에 남아요" body="언제 어디에 썼는지 접근 기록에서 볼 수 있어요." />
          </ul>
        </section>
      </Stack>
    </Screen>
  );
}

function Step({ title, body }: { title: string; body: string }) {
  return (
    <li className="pay-step">
      <h3 className="pay-step__title">{title}</h3>
      <p className="pay-step__body">{body}</p>
    </li>
  );
}
