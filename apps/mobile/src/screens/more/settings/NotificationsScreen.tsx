import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useRef, useState } from "react";
import type { ScreenProps } from "../../../app/nav";
import { Screen } from "../../../app/Screen";
import { EXIT, t } from "../../../motion/springs";
import { useTierValue } from "../../../motion/tier";
import { Button } from "../../../ui/Button";
import { LargeTitle } from "../../../ui/LargeTitle";
import { ListRow, ListSection } from "../../../ui/List";
import { Toggle } from "../../../ui/Toggle";
import { josa } from "../format";
import { Stack, useAgentName } from "../parts";
import { useCurrentSettings, useSettingsPatch } from "./useSetting";
import "./settings.css";

/**
 * 알림 설정 (settings B, MOTION-SPEC §6.12, research 12-4). It starts with this device (critique P1-2): until the
 * browser has been asked, a card on top asks for permission (the screen's one accent), and the kinds below show their
 * SAVED state on disabled switches — nothing looks on that cannot arrive. Their words stay at full strength; only the
 * controls are dimmed. Once the question is answered (or the browser cannot ask) the switches work: in-app banners and
 * the briefing do not need the permission, and a denied device says how to allow it again. Asked here, when it is
 * first needed, never during sign-up. No plates, no interruption-level tails; the briefing time is a plain value.
 */
export function NotificationsScreen({ route }: ScreenProps) {
  const settings = useCurrentSettings();
  const patch = useSettingsPatch();
  const agentName = useAgentName();
  const reduce = useTierValue("reduceMotion");
  const [perm, ask] = useDevicePermission();
  const n = settings?.notifications;
  const gated = perm === "default";
  const off = !n || gated;
  const set = (k: "briefing" | "taskDone" | "friendMessages" | "marketing") => (v: boolean) => patch({ notifications: { [k]: v } }, "알림 설정");
  // the device card leaves once answered; what sits below moves up with it (§3 Morph, transform only)
  const moves = { layout: reduce ? false : ("position" as const), layoutDependency: perm, transition: { layout: t("morph") } };

  return (
    <Screen routeKey={route.key}>
      <LargeTitle title={route.title ?? "알림 설정"} layoutId={route.titleLayoutId} />
      <Stack>
        <AnimatePresence initial={false} mode="popLayout">
          {perm !== "granted" && <DeviceCard key="device" perm={perm} ask={ask} reduce={reduce} />}
        </AnimatePresence>

        <motion.div {...moves}>
          <ListSection title={`${josa(agentName, "이가")} 보내는 알림`} footer="앱을 쓰는 동안에는 화면 맨 위에서 알림이 잠깐 내려와요.">
            <ListRow
              title="매일 브리핑"
              subtitle="날씨·일정·뉴스를 정해진 시간에 정리해 보내요"
              accessory={<Toggle label="매일 브리핑" checked={!!n?.briefing} onChange={set("briefing")} disabled={off} />}
            />
            <ListRow
              title="브리핑 시간"
              accessory={
                <TimeValue
                  label="브리핑 시간"
                  value={n?.briefingTime ?? "07:30"}
                  disabled={off || !n?.briefing}
                  onChange={(v) => patch({ notifications: { briefingTime: v } }, "브리핑 시간")}
                />
              }
            />
            <ListRow title="맡긴 일 완료" subtitle="맡긴 일이 끝나면 알려요" accessory={<Toggle label="맡긴 일 완료" checked={!!n?.taskDone} onChange={set("taskDone")} disabled={off} />} />
            <ListRow
              title="친구 메시지"
              subtitle="친구나 친구의 모시가 말을 전하면 알려요"
              accessory={<Toggle label="친구 메시지" checked={!!n?.friendMessages} onChange={set("friendMessages")} disabled={off} />}
            />
          </ListSection>
        </motion.div>

        <motion.div {...moves}>
          <ListSection title="선택 동의" footer="새 기능과 혜택 소식은 동의한 경우에만 보내요. 언제든 끌 수 있어요.">
            <ListRow
              title="혜택·소식"
              subtitle="켜면 알림 없이 목록에만 쌓여요"
              accessory={<Toggle label="혜택·소식 알림" checked={!!n?.marketing} onChange={set("marketing")} disabled={off} />}
            />
          </ListSection>
        </motion.div>
      </Stack>
    </Screen>
  );
}

type Perm = NotificationPermission | "unsupported";

function useDevicePermission(): [Perm, () => Promise<void>] {
  const supported = typeof window !== "undefined" && "Notification" in window;
  const [perm, setPerm] = useState<Perm>(() => (supported ? Notification.permission : "unsupported"));
  useEffect(() => {
    if (!supported) return;
    // the answer may change in the browser's own settings while the app is away
    const on = () => setPerm(Notification.permission);
    document.addEventListener("visibilitychange", on);
    return () => document.removeEventListener("visibilitychange", on);
  }, [supported]);
  const ask = async () => {
    if (!supported) return;
    try {
      setPerm(await Notification.requestPermission());
    } catch {
      setPerm(Notification.permission);
    }
  };
  return [perm, ask];
}

/** The device first: ask (one primary action), or say why nothing arrives while the app is closed. */
function DeviceCard({ perm, ask, reduce }: { perm: Perm; ask: () => Promise<void>; reduce: boolean }) {
  const copy =
    perm === "default"
      ? { title: "이 기기에서 알림을 받으려면 허용해 주세요", body: "허용하기 전에는 아래 알림이 앱을 닫았을 때 오지 않아요." }
      : perm === "denied"
        ? { title: "이 기기에서는 알림이 꺼져 있어요", body: "브라우저 설정에서 이 사이트의 알림을 허용하면 앱을 닫았을 때도 받을 수 있어요." }
        : { title: "이 브라우저에서는 앱을 닫았을 때 알림을 받을 수 없어요", body: "앱을 쓰는 동안 오는 알림은 아래에서 고를 수 있어요." };
  return (
    <motion.section className="settings-device paper" aria-labelledby="settings-device-h" exit={reduce ? { opacity: 0, transition: { duration: 0 } } : { opacity: 0, scale: 0.96, transition: EXIT }}>
      <h2 className="settings-device__title" id="settings-device-h">
        {copy.title}
      </h2>
      <p className="settings-device__body">{copy.body}</p>
      {perm === "default" && (
        <Button tone="primary" size="lg" fullWidth onClick={() => void ask()}>
          알림 허용하기
        </Button>
      )}
    </motion.section>
  );
}

/** "07:30" → "오전 7:30" */
function hhmmKo(v: string): string {
  const [h = 0, m = 0] = v.split(":").map(Number);
  return `${h < 12 ? "오전" : "오후"} ${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, "0")}`;
}

/**
 * The briefing time as a plain value (44 px, field radius, no clock glyph). The real <input type="time"> lies over it,
 * invisible, so a tap opens the system's own picker (showPicker where the browser has it) and the keyboard edits it.
 */
function TimeValue({ label, value, disabled, onChange }: { label: string; value: string; disabled: boolean; onChange: (v: string) => void }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <span className="settings-time tnum" data-disabled={disabled || undefined}>
      <span aria-hidden="true">{hhmmKo(value)}</span>
      <input
        ref={input}
        type="time"
        className="settings-time__input"
        aria-label={label}
        value={value}
        disabled={disabled}
        step={300}
        onClick={() => {
          try {
            input.current?.showPicker?.();
          } catch {
            /* the browser opens its own picker, or the field takes the keyboard */
          }
        }}
        onChange={(e) => {
          if (/^\d{2}:\d{2}$/.test(e.target.value)) onChange(e.target.value);
        }}
      />
    </span>
  );
}
