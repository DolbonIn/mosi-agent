import { logout, useSession } from "../../../api/store";
import type { ScreenProps } from "../../../app/nav";
import { Screen } from "../../../app/Screen";
import { Button } from "../../../ui/Button";
import { LargeTitle } from "../../../ui/LargeTitle";
import { ListRow, ListSection } from "../../../ui/List";
import { dateKo } from "../format";
import { Foot, pushDetail, Stack } from "../parts";
import "./profile.css";

/**
 * 내 계정 (my-mosi B): who is signed in (name, handle, since) as plain rows; 모시 이름 is the way to rename — it opens
 * the agent's settings, where the name field is (the model id is a support fact, not an account fact, so it is gone);
 * sign-out is a centred red row in its own group, two-step in place (MOTION-SPEC §8.6, research §3-4).
 */
export function AccountScreen({ route }: ScreenProps) {
  const s = useSession().session;
  const user = s?.user;
  const agentName = s?.agent.name;
  return (
    <Screen routeKey={route.key}>
      <LargeTitle title={route.title ?? "내 계정"} layoutId={route.titleLayoutId} />
      <Stack>
        <ListSection title="계정 정보">
          <ListRow title="표시 이름" detail={user ? `${user.displayName} 님` : "—"} />
          <ListRow title="아이디" detail={user ? `@${user.handle}` : "—"} />
          <ListRow title="가입한 날" detail={user ? dateKo(user.createdAt) : "—"} />
        </ListSection>
        <ListSection title="모시">
          <ListRow title="모시 이름" detail={agentName ?? "—"} className="account-agent" onClick={agentName ? () => pushDetail("agent", agentName) : undefined} />
        </ListSection>
        <section className="list-section account-logout" aria-label="로그아웃">
          <div className="list">
            <div className="list-card profile-action-group">
              <Button
                variant="plain"
                tone="destructive"
                size="lg"
                fullWidth
                style={{ height: 54, borderRadius: "var(--r-group)" }}
                className="profile-action"
                confirm={{ label: "한 번 더 누르면 로그아웃해요", holdMs: 900, hint: "길게 누르거나, 두 번 눌러 확인해요" }}
                action={() => logout()}
                busyLabel="로그아웃하는 중"
              >
                이 기기에서 로그아웃
              </Button>
            </div>
            <Foot>로그아웃해도 대화와 저장된 로그인은 지워지지 않아요. 다시 로그인하면 그대로 이어져요.</Foot>
          </div>
        </section>
      </Stack>
    </Screen>
  );
}
