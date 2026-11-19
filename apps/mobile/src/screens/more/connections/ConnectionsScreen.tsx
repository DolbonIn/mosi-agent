import type { Connection, ProviderInfo } from "@pickle/protocol";
import { useEffect, useMemo, useRef, useState } from "react";
import { loadConnections, useConnections, useSettings } from "../../../api/store";
import { BrandIcon, hasBrandIcon } from "../../../assets/brands/BrandIcon";
import type { ScreenProps } from "../../../app/nav";
import { Screen } from "../../../app/Screen";
import { R } from "../../../ui/geometry";
import { LargeTitle } from "../../../ui/LargeTitle";
import { Icon } from "../../../ui/Icon";
import { ListRow, ListSection } from "../../../ui/List";
import { ago, josa } from "../format";
import { copyOf, InlineError, Placeholder, Stack, StatusPill, useAgentName } from "../parts";
import { ConnectSheet } from "./ConnectSheet";
import { isSkillProvider, SkillAccounts } from "./SkillAccounts";
import { CATEGORY_ORDER, CATEGORY_TITLE, CONNECTIONS_TITLE, isLinked, LOGIN_GROUPS, loginCopy, statusPill } from "./providerCopy";
import "./connections.css";

/**
 * Connections (MOTION-SPEC §6.7, research §4-7, draft connections B): "앱 연결", what it does said once as the
 * large title's subtitle; "연결됨" on top, then the login rows chunked by where they're used (일상 · 업무), then the
 * folded "고급" bots. Each row shows the messenger's real app icon (assets/brands) and morphs into its connect sheet.
 * Status lives in the foundation connections store, which the `connection` server event keeps current — a passcode
 * confirmed on the phone updates the row even after the sheet was closed. Rows and pills are neutral; the one accent is
 * the connect button inside the sheet.
 */
/** hue plate behind a white glyph; lightness/saturation come from CSS so dark / contrast twins apply */
export const plateTint = (hue: number) => `hsl(${hue} var(--plate-s, 72%) var(--plate-l, 52%))`;

export function ConnectionsScreen({ route }: ScreenProps) {
  const { providers, connections, loaded, loading, error } = useConnections();
  const agentName = useAgentName();
  const asks = useSettings()?.confirmBeforeSend !== false;
  const [active, setActive] = useState<{ provider: ProviderInfo; el: HTMLElement | null; open: boolean; n: number } | null>(null);

  useEffect(() => {
    void loadConnections();
  }, []);

  const byProvider = useMemo(() => {
    const m = new Map<string, Connection>();
    for (const c of connections) m.set(c.provider, c);
    return m;
  }, [connections]);

  // connected (or waiting / failed with an account) stays on top, bots included; bots the person made themselves are
  // otherwise folded into one "고급" group so no main row asks for a token
  // k-skill services (category "korea", auth "api_key") are listed by <SkillAccounts /> below, never as messenger rows
  const messengers = providers.filter((p) => !isSkillProvider(p));
  const linked = messengers.filter((p) => isLinked(byProvider.get(p.id)));
  const rest = messengers.filter((p) => !isLinked(byProvider.get(p.id)));
  const advanced = rest.filter((p) => p.advanced);
  const logins = rest.filter((p) => !p.advanced);
  const grouped = new Set(LOGIN_GROUPS.flatMap((g) => g.ids));
  // 일상 · 업무 in the draft's order; anything the catalog adds later falls into its category's group after them
  const groups = [
    ...LOGIN_GROUPS.map((g) => ({ key: g.title, title: g.title, items: g.ids.flatMap((id) => logins.filter((p) => p.id === id)) })),
    ...CATEGORY_ORDER.map((cat) => ({ key: cat, title: CATEGORY_TITLE[cat], items: logins.filter((p) => p.category === cat && !grouped.has(p.id)) })),
  ].filter((g) => g.items.length);
  const adv = useDisclosure();

  const open = (p: ProviderInfo) => {
    const el = document.querySelector<HTMLElement>(`.conn-row-${CSS.escape(p.id)}`);
    setActive((a) => ({ provider: p, el, open: true, n: (a?.n ?? 0) + 1 }));
  };

  const row = (p: ProviderInfo) => {
    const c = byProvider.get(p.id);
    const pill = statusPill(c?.status);
    const sub = !p.available
      ? p.unavailableReason ?? "지금은 연결할 수 없어요"
      : c?.status === "error"
        ? c.lastError ?? "연결하지 못했어요"
        : c?.status === "connected"
          ? [c.accountLabel, c.connectedAt ? `${ago(c.connectedAt)} 연결` : null].filter(Boolean).join(" · ")
          : c?.status === "needs_verification"
            ? "휴대폰에서 확인을 기다리고 있어요"
            : c?.status === "connecting"
              ? "연결하고 있어요"
              : loginCopy(p);
    return (
      <ListRow
        key={p.id}
        className={`conn-row conn-row-${p.id}`}
        leading={hasBrandIcon(p.id) ? <BrandIcon provider={p.id} size={30} radius={R.plate} /> : undefined}
        icon={p.icon}
        iconTint={plateTint(p.hue)}
        title={p.name}
        subtitle={<span className={c?.status === "error" ? "more-danger-text" : undefined}>{sub}</span>}
        detail={pill ? <StatusPill tone={pill.tone}>{pill.label}</StatusPill> : undefined}
        onClick={p.available ? () => open(p) : undefined}
        chevron={p.available}
        disabled={!p.available}
        ariaLabel={`${p.name}, ${pill ? pill.label : "연결 전"}, ${sub}`}
      />
    );
  };

  return (
    <Screen routeKey={route.key}>
      {/* what connecting does is said once, as the title's subtitle; how a login is sealed is said once, under the
          password field where it is typed (P2-1 · CP-5) */}
      <LargeTitle
        className="conn-title"
        title={route.title ?? CONNECTIONS_TITLE}
        layoutId={route.titleLayoutId}
        subtitle={`연결하면 ${josa(agentName, "이가")} 대화를 읽고 내 서비스를 조회해요. ${asks ? "보내거나 실행하는 건 내가 허락할 때만 해요." : "보내기 전 확인이 꺼져 있어 메시지는 묻지 않고 보내요."}`}
      />
      <Stack>
        {!loaded && loading ? (
          <Placeholder rows={5} height={58} />
        ) : (
          <>
            {error && !providers.length ? <InlineError>{error}</InlineError> : null}
            {linked.length > 0 && <ListSection title={`연결됨 ${linked.length}`}>{linked.map(row)}</ListSection>}
            {groups.map((g) => (
              <ListSection key={g.key} title={g.title}>
                {g.items.map(row)}
              </ListSection>
            ))}
            <SkillAccounts focus={typeof route.params?.focus === "string" ? route.params.focus : undefined} connect={route.params?.connect === true} />
            {advanced.length > 0 && (
              <ListSection
                className={`conn-adv conn-adv--${adv.state}`}
                footer={adv.state !== "closed" ? "봇을 직접 만들어 둔 경우에만 필요해요. 내 계정은 위에서 로그인으로 연결해요." : undefined}
              >
                {/* the fold is the group's own heading: words and a chevron, no plate */}
                <h2 className="conn-adv-h">
                  <button type="button" className="list-row is-clickable conn-adv-toggle" aria-expanded={adv.state === "open"} onClick={adv.toggle}>
                    <span className="list-row-main">
                      <span className="list-row-text t-cell">
                        <span className="list-row-title t-copy">{copyOf("고급 · 직접 만든 봇 연결")}</span>
                        <span className="list-row-sub t-copy">{copyOf(advanced.map((p) => p.name).join(" · "))}</span>
                      </span>
                      <span className="list-row-chevron conn-adv-chev" aria-hidden="true">
                        <Icon name="chevron-down" size={16} weight="semibold" />
                      </span>
                    </span>
                  </button>
                </h2>
                {adv.state !== "closed" && advanced.map(row)}
              </ListSection>
            )}
          </>
        )}
      </Stack>
      {active && (
        <ConnectSheet
          key={`${active.provider.id}:${active.n}`}
          provider={active.provider}
          source={active.el}
          open={active.open}
          onClose={() => setActive((a) => (a ? { ...a, open: false } : a))}
          onClosed={() => setActive((a) => (a && !a.open ? null : a))}
        />
      )}
    </Screen>
  );
}

/**
 * The "고급" fold: open → rows rise in on the snap spring (CSS linear() spring, transform/opacity only); close → they
 * leave in --dur-exit, then unmount. Reduced motion: no animation, no wait.
 */
function useDisclosure() {
  const [state, setState] = useState<"closed" | "open" | "closing">("closed");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  const toggle = () => {
    if (timer.current) clearTimeout(timer.current);
    if (state === "open") {
      const reduce = document.documentElement.dataset.motion === "reduce";
      if (reduce) return setState("closed");
      setState("closing");
      timer.current = setTimeout(() => setState("closed"), 140);
    } else setState("open");
  };
  return { state, toggle };
}
