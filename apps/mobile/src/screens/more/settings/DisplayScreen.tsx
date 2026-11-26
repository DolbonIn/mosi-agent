import type { UserSettings } from "@pickle/protocol";
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { ScreenProps } from "../../../app/nav";
import { Screen } from "../../../app/Screen";
import { useTier } from "../../../motion/tier";
import { LargeTitle } from "../../../ui/LargeTitle";
import { SegmentedControl } from "../../../ui/SegmentedControl";
import { Slider } from "../../../ui/Slider";
import { tied } from "../../../ui/Text";
import { josa } from "../format";
import { ChoiceList, copyOf, Stack, useAgentName } from "../parts";
import { useCurrentSettings, useSettingsPatch } from "./useSetting";
import "./settings.css";

/**
 * 화면 및 디자인 (settings B, MOTION-SPEC §6.12 + §8.15, research §4-12): the same list grammar as the other settings
 * screens, everything defaulting to 시스템 따름. Theme is a choice list with one checkmark (the one allowed root
 * crossfade, a 200 ms View Transition — instant under reduced motion); its note says what 시스템 따름 shows right now.
 * Text size is one paper: the turn drawn the way chat draws it (my words in a bubble, the agent's as plain text) over
 * the slider, which steps the preview live and the app on release. The "시스템과 다르게" overrides are rows that say
 * the current value, each with its 3-way control inside. All through updateSettings(): applied at once, persisted to
 * the server, rolled back on failure.
 */
type Display = UserSettings["display"];
type Tri = Display["reduceMotion"];

const THEMES: { value: Display["theme"]; label: string }[] = [
  { value: "system", label: "시스템 따름" },
  { value: "light", label: "라이트" },
  { value: "dark", label: "다크" },
];
const TRI: { value: Tri; label: string }[] = [
  { value: "system", label: "시스템 따름" },
  { value: "on", label: "켜기" },
  { value: "off", label: "끄기" },
];

export function DisplayScreen({ route }: ScreenProps) {
  const s = useCurrentSettings();
  const tier = useTier();
  const patch = useSettingsPatch();
  const agentName = useAgentName();
  // without a session (or before it loads) the local prefs are the truth
  const d: Display = s?.display ?? tier.prefs;
  const [scale, setScale] = useState(d.textScale);
  /** the knob is held (drag, between its first change and the release): a text size from another device waits */
  const holding = useRef(false);
  useEffect(() => {
    if (!holding.current) setScale(d.textScale);
  }, [d.textScale]);
  const setDisplay = (p: Partial<Display>) => patch({ display: p }, "화면 설정");
  const pctLabel = (v: number) => `${Math.round(v * 100)}%`;

  return (
    <Screen routeKey={route.key}>
      <LargeTitle title={route.title ?? "화면 및 디자인"} layoutId={route.titleLayoutId} />
      <Stack>
        <Group id="display-theme" title="테마" footer={d.theme === "system" ? `지금은 기기 설정에 맞춰 ${tier.theme === "dark" ? "다크" : "라이트"}로 보여요.` : "기기 설정과 관계없이 이 모양으로 보여요."}>
          <ChoiceList label="테마" value={d.theme} options={THEMES} onChange={(v) => setDisplay({ theme: v })} />
        </Group>

        <Group id="display-text" title="글자 크기" footer="손을 떼면 앱 전체 글자 크기가 바뀌어요. 기본은 100%예요.">
          <div className="text-preview" style={{ "--preview": scale / (tier.textScale || 1) } as CSSProperties} aria-hidden="true">
            <p className="text-preview__me">내일 아침 날씨 알려 줘</p>
            {/* data-lines="prose": a chat bubble's flowing talk, as in the chat (the line checker skips its sentence rule);
                tied() only, no sentence blocks, so "한 번" never splits */}
            <p className="text-preview__agent" data-lines="prose">
              {tied(`내일 아침 서울은 맑고 6도예요. 낮에는 14도까지 올라가니 얇은 겉옷이면 충분해요. ${josa(agentName, "이가")} 7시에 한 번 더 알려 드릴게요.`)}
            </p>
          </div>
          <div className="settings-rule settings-slider">
            <Slider
              label="글자 크기"
              value={scale}
              min={0.9}
              max={1.3}
              step={0.05}
              format={pctLabel}
              showValue
              minIcon="minus"
              maxIcon="plus"
              onChange={(v) => {
                holding.current = true;
                setScale(v);
              }}
              onCommit={(v) => {
                holding.current = false;
                if (Math.abs(v - d.textScale) > 0.001) setDisplay({ textScale: Math.round(v * 100) / 100 });
                else setScale(d.textScale);
              }}
            />
          </div>
        </Group>

        <Group id="display-override" title="시스템과 다르게" footer="켜면 화면 전환과 유리 효과를 줄여요. 기기의 손쉬운 사용 설정을 따르는 게 기본이에요.">
          <div className="settings-override">
            <span className="settings-override__line">
              <span className="settings-override__name" id="display-motion">
                동작 줄이기
              </span>
              <span className="settings-override__now">{tier.reduceMotion ? "지금은 켜짐" : "지금은 꺼짐"}</span>
            </span>
            <SegmentedControl idBase="display-motion" role="radiogroup" size="sm" label="동작 줄이기" value={d.reduceMotion} onChange={(v) => setDisplay({ reduceMotion: v })} options={TRI} />
          </div>
          <div className="settings-override settings-rule">
            <span className="settings-override__line">
              <span className="settings-override__name" id="display-transparency">
                투명도 줄이기
              </span>
              <span className="settings-override__now">{tier.reduceTransparency ? "지금은 켜짐" : "지금은 꺼짐"}</span>
            </span>
            <SegmentedControl
              idBase="display-transparency"
              role="radiogroup"
              size="sm"
              label="투명도 줄이기"
              value={d.reduceTransparency}
              onChange={(v) => setDisplay({ reduceTransparency: v })}
              options={TRI}
            />
          </div>
        </Group>
      </Stack>
    </Screen>
  );
}

/** A titled paper group with a footnote — ListSection's anatomy (h2 under the large title), for content that is not rows. */
function Group({ id, title, footer, children }: { id: string; title: string; footer: string; children: ReactNode }) {
  return (
    <section className="list-section" aria-labelledby={id}>
      <div className="list">
        <div className="list-header">
          <h2 className="list-section-title" id={id}>
            {title}
          </h2>
        </div>
        <div className="list-card">{children}</div>
        <div className="list-footer t-copy">{copyOf(footer)}</div>
      </div>
    </section>
  );
}
