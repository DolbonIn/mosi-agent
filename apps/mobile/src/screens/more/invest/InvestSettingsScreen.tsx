import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { toApiError } from "../../../api/client";
import { island } from "../../../app/island";
import { nav, type ScreenProps } from "../../../app/nav";
import { Screen } from "../../../app/Screen";
import { Button } from "../../../ui/Button";
import { LargeTitle } from "../../../ui/LargeTitle";
import { ListRow, ListSection } from "../../../ui/List";
import { Toggle } from "../../../ui/Toggle";
import { copyText } from "../archive/share";
import { useSkillSheet } from "../connections/SkillAccounts";
import { investRes, reloadInvest, useResource } from "../data";
import { copyOf, InlineError, Placeholder, Stack, useRouteVisible } from "../parts";
import { presentPhone } from "../profile/PhoneSheet";
import * as api from "./api";
import { readLockScreen } from "./lockScreen";
import { scrollToTop } from "./scroll";
import { useModeCapsule } from "./mode";
import { NoticeRow } from "./NoticeRow";
import { CALL_ROWS, callsGroup, canCheckToss, LOCK_SCREEN_VALUE, modeFoot, tossAlert, tossFoot, tossRow, type LockScreen } from "./rules";
import type { InvestSettingsView } from "@pickle/protocol";
import "./invest.css";

/** the one Toss connection: the same vault entry and sheet as 연결 › 토스증권 (team-lead 0059, DD 0059 §5-1) */
const TOSS_SERVICE = "toss-investment";

/**
 * ⑥ 투자 설정 (DD 1935 §3-4, DD 2010 §4 / §6, DD 0059 §5 with DD 0103-b A–D). Four groups:
 * - 토스증권: the connection (the app's one, opening the same sheet as 연결 › 토스증권), a refusal or a cut key at the
 *   top in the server's words, the server's outbound IP to allow with 복사, and 연결 확인 (the server's check).
 * - 주문 모드: 실제 주문 and why it cannot be turned on. The switch stays as the mode is until the server's enable and
 *   its sheet (B3); turning off waits for B3's route too.
 * - 전화: which events no rule decides call, changed at once and back with the server's words if the PATCH fails.
 * - 잠금 화면 알림: this device's state, leading to 알림 설정 (the one place that asks); no row while the server sends none.
 * Everything else is the overview's `settings`, kept current by the `invest` event. The top bar says the mode (a status
 * here; on 투자 the capsule opens this screen at 주문 모드, which is scrolled to the top of the view).
 */
export function InvestSettingsScreen({ route }: ScreenProps) {
  const visible = useRouteVisible(route.key);
  const res = useResource(investRes, visible);
  const s = res.data?.settings;
  const skill = useSkillSheet();
  useModeCapsule();

  // opened from the capsule: 주문 모드 at the top of the view, clear of the top bar, no flash (DD 0103-b D)
  const focus = (route.params as { focus?: string } | undefined)?.focus;
  const ready = !!s;
  useLayoutEffect(() => {
    const el = focus === "mode" && ready ? document.getElementById(`iv-mode-${route.key}`) : null;
    return el ? scrollToTop(el) : undefined;
  }, [focus, ready, route.key]);

  // read again each time the screen comes back (알림 설정 may have changed it)
  const [lock, setLock] = useState<LockScreen>("none");
  useEffect(() => {
    if (!visible) return;
    let live = true;
    void readLockScreen().then((v) => live && setLock(v));
    return () => {
      live = false;
    };
  }, [visible]);

  return (
    <Screen routeKey={route.key} className="invest iv-settings">
      <LargeTitle title={route.title ?? "투자 설정"} layoutId={route.titleLayoutId} />
      <Stack>
        {!s ? (
          res.error ? (
            <InlineError>{res.error}</InlineError>
          ) : (
            <Placeholder rows={3} height={52} />
          )
        ) : (
          <>
            <TossSection s={s} openSheet={(el) => skill.open(TOSS_SERVICE, el)} />
            <div id={`iv-mode-${route.key}`} className="iv-mode-anchor">
              <ModeSection s={s} />
            </div>
            <CallsSection s={s} />
            {lock !== "none" && (
              <ListSection className="iv-lock">
                <ListRow
                  title="잠금 화면 알림"
                  detail={LOCK_SCREEN_VALUE[lock]}
                  className="iv-lock-row"
                  onClick={() => nav.push("settings.notifications", undefined, { title: "알림 설정" })}
                />
              </ListSection>
            )}
          </>
        )}
      </Stack>
      {skill.sheet}
    </Screen>
  );
}

/** a footer of one or more paragraphs; none, no footer */
function feet(items: string[]) {
  return items.length ? (
    <>
      {items.map((p) => (
        <p key={p} className="iv-foot-p">
          {copyOf(p)}
        </p>
      ))}
    </>
  ) : undefined;
}

function TossSection({ s, openSheet }: { s: InvestSettingsView; openSheet: (el: HTMLElement | null) => void }) {
  const alert = tossAlert(s.toss);
  const row = tossRow(s.toss);
  const ip = s.toss.outboundIp;
  return (
    <ListSection title="토스증권" footer={feet(tossFoot(s.toss))} className="iv-toss">
      {alert && <NoticeRow signal={alert.tone} text={alert.text} className="iv-toss-alert" onPress={alert.opens ? openSheet : undefined} />}
      {row.value === null ? (
        <ListRow title="토스증권" subtitle={row.subtitle ?? undefined} className="iv-toss-row" />
      ) : (
        <FitRow
          title="토스증권"
          value={row.value}
          className="iv-toss-row"
          onClick={row.opens ? () => openSheet(document.querySelector<HTMLElement>(".iv-settings .iv-toss-row")) : undefined}
        />
      )}
      {ip && <FitRow title="허용 IP" className="iv-ip-row" value={<span className="iv-ip tnum">{ip}</span>} accessory={<CopyButton text={ip} />} />}
      {canCheckToss(s.toss) && <CheckRow />}
    </ListSection>
  );
}

/**
 * A row whose value sits on the right while all of it fits there, else on a second line under the title: never cut
 * off (an IP is copied and compared by eye; 320 / 130 % cut both). Decided on measured widths: a hidden copy of the
 * title and the value at their natural widths, against what the row leaves (ListRow keeps a value within 45 %).
 */
function FitRow({ title, value, className, accessory, onClick }: { title: string; value: ReactNode; className: string; accessory?: ReactNode; onClick?: () => void }) {
  const [stacked, setStacked] = useState(false);
  const probe = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const m = probe.current;
    const main = m?.closest<HTMLElement>(".list-row-main");
    if (!m || !main) return;
    const check = () => {
      const cs = getComputedStyle(main);
      const room = main.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      const gap = parseFloat(cs.columnGap) || 0;
      const [tw = 0, vw = 0] = [...m.children].map((c) => c.getBoundingClientRect().width);
      const side = [...main.querySelectorAll<HTMLElement>(":scope > .list-row-accessory, :scope > .list-row-chevron")].reduce((a, e) => a + e.getBoundingClientRect().width + gap, 0);
      setStacked(!(vw <= 0.45 * room + 0.5 && tw + gap + vw + side <= room + 0.5));
    };
    check();
    let frame = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(check);
    });
    ro.observe(main);
    ro.observe(m);
    return () => {
      ro.disconnect();
      cancelAnimationFrame(frame);
    };
  }, []);
  const titleNode = (
    <>
      {title}
      <span ref={probe} className="iv-fit-probe" aria-hidden="true">
        <span>{title}</span>
        <span className="list-row-detail">{value}</span>
      </span>
    </>
  );
  return (
    <ListRow
      title={titleNode}
      detail={stacked ? undefined : value}
      subtitle={stacked ? value : undefined}
      className={`${className}${stacked ? " is-stacked" : ""}`}
      accessory={accessory}
      onClick={onClick}
    />
  );
}

/**
 * 복사: the label itself says 복사했어요 for 1.5 s, no banner and no ring (DD 0059 §5-1), and the same words go to
 * assistive tech; a failure says how to copy by hand.
 */
function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => setDone(false), 1500);
    return () => clearTimeout(t);
  }, [done]);
  const copy = () =>
    copyText(text, { quiet: true }).then(
      () => setDone(true),
      (e: unknown) => island.errorBanner(e instanceof Error ? e.message : "복사하지 못했어요.", "IP를 복사하지 못했어요"),
    );
  return (
    <>
      <Button variant="plain" size="sm" onClick={() => void copy()} ariaLabel={done ? "복사했어요" : `허용 IP ${text} 복사`} className="iv-copy">
        {done ? "복사했어요" : "복사"}
      </Button>
      <span className="sr-only" aria-live="polite">
        {done ? "복사했어요" : ""}
      </span>
    </>
  );
}

/**
 * 연결 확인: the server checks Toss now (once a minute at most). What it found comes back in the overview (the value and
 * the row at the top); a refusal of the check itself (too soon, no answer) is the server's sentence beside the button.
 */
function CheckRow() {
  const [note, setNote] = useState<string | null>(null);
  const check = async () => {
    setNote(null);
    try {
      await api.checkToss();
    } catch (e) {
      setNote(toApiError(e).message);
      throw e;
    }
    await reloadInvest().catch(() => undefined);
  };
  return (
    <div className="list-row iv-check-row">
      <span className="list-row-main">
        <Button variant="plain" size="sm" action={check} busyLabel="확인하는 중" successLabel="확인했어요">
          연결 확인
        </Button>
        {note && <span className="iv-check-note t-copy">{copyOf(note)}</span>}
      </span>
    </div>
  );
}

function ModeSection({ s }: { s: InvestSettingsView }) {
  return (
    <ListSection title="주문 모드" footer={feet(modeFoot(s))} className="iv-mode">
      <ListRow title="실제 주문" className="iv-mode-row" accessory={<Toggle label="실제 주문" checked={s.mode === "real"} onChange={() => undefined} disabled />} />
    </ListSection>
  );
}

function CallsSection({ s }: { s: InvestSettingsView }) {
  const g = callsGroup(s);
  const set = (key: keyof InvestSettingsView["calls"]) => (on: boolean) => {
    const st = investRes.store.get();
    const before = st.data;
    if (!before) return;
    // at once, as the app's settings switches do; the server's view (and its `invest` event) follow
    const mine = { ...before, settings: { ...before.settings, calls: { ...before.settings.calls, [key]: on } } };
    investRes.store.set({ ...st, data: mine });
    api.patchSettings({ calls: { [key]: on } }).then(
      () => reloadInvest().catch(() => undefined),
      (e) => {
        // back to what the server has, unless something newer came in meanwhile
        if (investRes.store.get().data === mine) investRes.store.set({ ...investRes.store.get(), data: before });
        island.errorBanner(toApiError(e).message, "전화 설정을 바꾸지 못했어요");
      },
    );
  };
  return (
    <ListSection title="전화" footer={feet([g.foot])} className="iv-calls">
      {g.notice && <NoticeRow signal="caution" text={g.notice.text} className="iv-calls-notice" onPress={g.notice.verify ? (el) => presentPhone(el) : undefined} />}
      {CALL_ROWS.map((r) => (
        <ListRow
          key={r.key}
          title={r.title}
          subtitle={r.subtitle}
          className={`iv-call-${r.key}`}
          accessory={<Toggle label={r.title} checked={s.calls[r.key]} onChange={set(r.key)} />}
        />
      ))}
    </ListSection>
  );
}
