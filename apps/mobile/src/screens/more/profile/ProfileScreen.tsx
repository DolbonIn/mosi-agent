import type { ProfileSection } from "@pickle/protocol";
import { motion } from "framer-motion";
import { useEffect, useMemo, type ReactNode } from "react";
import { loadConnections, loadProfile, useAgent, useConnections, useProfile, useSession, useSettings, useUi } from "../../../api/store";
import type { ScreenProps } from "../../../app/nav";
import { Screen } from "../../../app/Screen";
import { t as spring } from "../../../motion/springs";
import { Avatar, DEFAULT_AVATAR } from "../../../ui/Avatar";
import { BarChart } from "../../../ui/BarChart";
import { Icon } from "../../../ui/Icon";
import { LargeTitle } from "../../../ui/LargeTitle";
import { ListRow, ListSection } from "../../../ui/List";
import { Odometer } from "../../../ui/Odometer";
import { ProgressBar } from "../../../ui/ProgressBar";
import { schedulesRes, useResource } from "../data";
import { num, untilKo, useCoarseNow } from "../format";
import { copyOf, InlineError, pushDetail, Stack, useAgentName, useTabVisible } from "../parts";
import { presentPhone } from "./PhoneSheet";
import { usePhone } from "./phone";
import { presentPrivacy } from "./PrivacySheet";
import { presentTickets } from "./TicketSheet";
import "./profile.css";

/**
 * 나의 모시 (MOTION-SPEC §6.6, my-mosi B "하나의 목록"): the whole tab speaks one list grammar — every block is a
 * section title, a group, and a footer. The agent is the first group; the quota is the first row of 사용량 (its bar
 * inside the row, the empty 7-day history said once as the footer, or a chart row once there is history). Sections,
 * their order and titles come from the server (ui.profile.sections); the client knows how to draw each row target.
 * No icon column: grouping by meaning replaces it.
 * Every row pushes a detail screen whose large title morphs out of the row label (layoutId).
 */

interface Target {
  screen: string;
  title: string;
  params?: Record<string, unknown>;
}
export const PROFILE_TARGETS: Record<string, Target> = {
  payments: { screen: "payment", title: "결제 수단" },
  logins: { screen: "vault", title: "저장된 로그인", params: { segment: "logins" } },
  "privacy-scope": { screen: "settings.privacy", title: "정보 공개 범위" },
  schedules: { screen: "schedules", title: "예약된 일" },
  "access-log": { screen: "vault", title: "접근 기록", params: { segment: "log" } },
  notifications: { screen: "settings.notifications", title: "알림 설정" },
  display: { screen: "settings.display", title: "화면 및 디자인" },
  connections: { screen: "connections", title: "앱 연결" },
  account: { screen: "account", title: "내 계정" },
  friends: { screen: "friends", title: "친구" },
};

/** section titles for an older ui-definitions payload that sent these sections untitled */
const FALLBACK_TITLES: Record<string, string> = { quota: "사용량", account: "내 계정" };

const go = (rowId: string, target: string, title?: string) => {
  const t = PROFILE_TARGETS[target];
  if (!t) return;
  pushDetail(t.screen, title ?? t.title, t.params, `row-${rowId}`);
};

/** the sheet morphs out of the row that opened it */
const rowEl = (cls: string) => document.querySelector<HTMLElement>(`.profile .${cls}`);

type Row = ProfileSection["rows"][number];

export function ProfileScreen({ route }: ScreenProps) {
  const ui = useUi();
  const visible = useTabVisible("profile");
  const profile = useProfile();
  const agentName = useAgentName();

  useEffect(() => {
    if (visible) void loadProfile();
  }, [visible]);

  const sections = useMemo(() => withFriends(ui.profile.sections), [ui.profile.sections]);
  // 내 전화번호 sits under 내 계정 unless the server places it itself
  const sduiPhone = useMemo(() => sections.some((s) => s.rows.some((r) => r.target === "phone")), [sections]);
  const title = ui.tabs.find((t) => t.id === "profile")?.title ?? "나의 모시";

  return (
    <Screen routeKey={route.key} className="profile">
      <LargeTitle title={title} />
      <Stack>
        <AgentRow />
        {profile.error && !profile.data && <InlineError>{profile.error}</InlineError>}
        {sections.map((s) => (
          <Section key={s.id} section={s} agentName={agentName} withPhone={!sduiPhone && s.rows.some((r) => r.target === "account")} />
        ))}
      </Stack>
    </Screen>
  );
}

/** 친구 is reachable from the drawer; an older payload left it out of the agent section */
function withFriends(sections: ProfileSection[]): ProfileSection[] {
  return sections.map((s) => (s.id === "agent" && !s.rows.some((r) => r.target === "friends") ? { ...s, rows: [...s.rows, { id: "friends", title: "친구", icon: "people", target: "friends" }] } : s));
}

const firstSentence = (text: string | undefined) => (text ?? "").trim().split(/(?<=[.!?。])\s+/)[0] ?? "";

/** the agent is the first group: its face, its name and the first sentence of its persona */
function AgentRow() {
  const agent = useAgent();
  const name = agent?.name ?? "모시";
  const persona = firstSentence(agent?.persona) || "성격과 말투를 정해 주세요";
  return (
    <div className="list-card profile-agent-group">
      <button type="button" className="list-row is-clickable profile-agent" aria-label={`${name} 설정`} onClick={() => pushDetail("agent", name, undefined, "row-agent")}>
        <Avatar spec={agent?.avatar ?? DEFAULT_AVATAR} size={56} breathing={false} />
        <span className="list-row-main">
          <span className="list-row-text t-cell">
            <motion.span layoutId="row-agent" className="profile-agent__name" transition={{ layout: spring("morph") }}>
              {name}
            </motion.span>
            <span className="profile-agent__persona t-copy">{copyOf(persona)}</span>
          </span>
          <span className="list-row-chevron" aria-hidden="true">
            <Icon name="chevron-right" size={16} weight="semibold" />
          </span>
        </span>
      </button>
    </div>
  );
}

function Section({ section, agentName, withPhone }: { section: ProfileSection; agentName: string; withPhone: boolean }) {
  const isQuota = section.rows.some((r) => r.target === "quota");
  const usage = useUsage();
  const title = section.title ?? FALLBACK_TITLES[section.id] ?? (section.id === "agent" ? agentName : undefined);
  const rows: ReactNode[] = [];
  for (const r of section.rows) {
    if (r.target === "quota") {
      rows.push(<QuotaRow key={r.id} title={r.title} />, <TicketsRow key="tickets" />);
      if (usage.total > 0) rows.push(<UsageRow key="usage7d" usage={usage} />);
    } else rows.push(<RowView key={r.id} row={r} />);
    if (r.target === "account" && withPhone) rows.push(<PhoneRow key="phone" />);
  }
  // the empty 7-day history is said once, under the group; the chart row above replaces it once there is history
  const footer = isQuota && usage.loaded && usage.total === 0 ? "최근 7일 동안 쓴 기록이 아직 없어요. 일을 맡기면 날마다 얼마나 썼는지 여기에 쌓여요." : undefined;
  return (
    <ListSection title={title} footer={footer} className={`profile-section profile-section--${section.id}`}>
      {rows}
    </ListSection>
  );
}

function RowView({ row }: { row: Row }) {
  switch (row.target) {
    case "account":
      return <AccountRow />;
    case "phone":
      return <PhoneRow title={row.title} />;
    case "privacy":
      return <ListRow title={row.title} subtitle="어떻게 암호화하고 보관하는지 알려 드려요" className="profile-privacy" onClick={() => presentPrivacy(rowEl("profile-privacy"))} />;
    case "connections":
      return <ConnectionsRow row={row} />;
    default:
      return <DetailRow row={row} />;
  }
}

/** the quota as the first row of 사용량: title and %, the bar, when it resets */
function QuotaRow({ title }: { title: string }) {
  const quota = useSession().session?.quota;
  const now = useCoarseNow(quota?.resetsAt);
  const pct = quota?.usedPct ?? 0;
  const hour = quota?.resetHour ?? 4;
  return (
    <div className="list-row profile-quota">
      <div className="profile-quota__main">
        <div className="profile-quota__head">
          <span className="profile-quota__title">{title}</span>
          <span className="profile-quota__pct tnum">
            <Odometer value={pct} id="profile-quota" suffix="%" />
          </span>
        </div>
        <ProgressBar value={pct / 100} label="오늘 사용한 한도" tone="label" height={8} />
        <p className="profile-quota__sub">
          매일 새벽 {hour}시에 초기화돼요
          {quota && <span className="tnum"> · {untilKo(quota.resetsAt, now)}</span>}
        </p>
      </div>
    </div>
  );
}

/**
 * The kinds in words, not in colour (CL-1): "기본 3장 · 프리미엄 0장", under the title. As a right-hand value it left
 * the title 68–138 px at 320–390 wide ("한도 / 초기화 / 티켓").
 */
function TicketsRow() {
  const tickets = useSession().session?.tickets ?? { basic: 0, premium: 0 };
  return (
    <ListRow
      title="한도 초기화 티켓"
      subtitle={`기본 ${tickets.basic}장 · 프리미엄 ${tickets.premium}장`}
      ariaLabel={`한도 초기화 티켓, 기본 ${tickets.basic}장, 프리미엄 ${tickets.premium}장`}
      className="profile-tickets"
      onClick={() => presentTickets(rowEl("profile-tickets"))}
    />
  );
}

function shortDay(day: string, i: number, n: number): string {
  if (i === n - 1) return "오늘";
  const [m, d] = day.split("-").map(Number);
  if (!m || !d) return day;
  const y = new Date().getFullYear();
  return "일월화수목금토"[new Date(Date.UTC(y, m - 1, d)).getUTCDay()] ?? day;
}

const tokensKo = (n: number) => (n >= 10000 ? `${(n / 10000).toFixed(n >= 100000 ? 0 : 1)}만` : num(n));

interface Usage {
  loaded: boolean;
  total: number;
  data: { label: string; value: number }[];
  peak: number;
}

function useUsage(): Usage {
  const profile = useProfile().data;
  return useMemo(() => {
    const usage = profile?.usage7d ?? [];
    const total = usage.reduce((a, u) => a + u.tokens, 0);
    const peak = usage.reduce((b, u, i) => (u.tokens > (usage[b]?.tokens ?? -1) ? i : b), 0);
    return { loaded: !!profile, total, peak, data: usage.map((u, i) => ({ label: shortDay(u.day, i, usage.length), value: u.tokens })) };
  }, [profile]);
}

/** once there is history, the 7-day chart is a row of 사용량 (in place of the footer line) */
function UsageRow({ usage }: { usage: Usage }) {
  const summary = `최근 7일 사용량, 모두 ${tokensKo(usage.total)} 토큰, 가장 많이 쓴 날 ${usage.data[usage.peak]?.label ?? ""}`;
  return (
    <div className="list-row profile-usage">
      <div className="profile-usage__main">
        <div className="profile-usage__head">
          <span className="profile-usage__title">최근 7일</span>
          <span className="list-row-detail tnum">{tokensKo(usage.total)} 토큰</span>
        </div>
        <BarChart id="profile-usage7d" data={usage.data} unit="토큰" format={tokensKo} ariaLabel={summary} height={120} />
      </div>
    </div>
  );
}

function AccountRow() {
  const user = useSession().session?.user;
  return <ListRow title={user?.displayName ?? "나"} subtitle={user ? `@${user.handle}` : undefined} layoutId="row-account" className="profile-account" onClick={() => go("account", "account")} />;
}

/** 내 전화번호: the masked number with its state, or 등록 안 됨; opens the phone sheet from the row */
function PhoneRow({ title = "내 전화번호" }: { title?: string }) {
  const phone = usePhone();
  const subtitle =
    phone == null ? undefined : phone.verified ? (
      <span className="profile-phone__state" data-verified="">
        <Icon name="checkmark" size={12} weight="semibold" />
        인증됨
      </span>
    ) : (
      <span className="profile-phone__state">인증이 필요해요</span>
    );
  const detail = phone === undefined ? undefined : phone === null ? "등록 안 됨" : <span className="tnum">{phone.masked}</span>;
  return <ListRow title={title} subtitle={subtitle} detail={detail} className="profile-phone-row" onClick={() => presentPhone(rowEl("profile-phone-row"))} />;
}

/** 앱 연결: one row, the count as its value ("없음" when none) */
function ConnectionsRow({ row }: { row: Row }) {
  const profile = useProfile().data;
  const conns = useConnections();
  useEffect(() => {
    if (!conns.loaded && !conns.loading) void loadConnections();
  }, [conns.loaded, conns.loading]);
  const count = conns.loaded ? conns.connections.filter((c) => c.status === "connected").length : profile?.connections.connected;
  const detail = count === undefined ? undefined : count ? `${count}개` : "없음";
  return <ListRow title={row.title} detail={detail} layoutId={`row-${row.id}`} className="profile-conns" onClick={() => go(row.id, row.target, row.title)} />;
}

function DetailRow({ row }: { row: Row }) {
  const profile = useProfile().data;
  const settings = useSettings();
  const schedules = useResource(schedulesRes, row.target === "schedules");
  const detail = ((): string | undefined => {
    switch (row.target) {
      case "payments":
        return profile ? (profile.paymentMethods ? `${profile.paymentMethods}개` : "없음") : undefined;
      case "logins":
        return profile ? (profile.savedLogins ? `${profile.savedLogins}개` : "없음") : undefined;
      case "schedules":
        return schedules.loaded ? (schedules.data.length ? `${schedules.data.filter((s) => s.enabled).length}개 켜짐` : "없음") : undefined;
      case "display": {
        const th = settings?.display.theme ?? "system";
        return th === "system" ? "시스템 따름" : th === "dark" ? "다크" : "라이트";
      }
      default:
        return undefined;
    }
  })();
  // the one switch that lets the agent send without asking: say so on the row that reaches it (critique settings
  // P1-1) — as a subtitle, since the row's title already fills the width a trailing detail would need
  const subtitle = row.target === "privacy-scope" && settings?.confirmBeforeSend === false ? "보내기 전 확인이 꺼져 있어요" : undefined;
  return (
    <ListRow
      title={row.title}
      subtitle={subtitle}
      detail={detail}
      layoutId={`row-${row.id}`}
      onClick={PROFILE_TARGETS[row.target] ? () => go(row.id, row.target, row.title) : undefined}
    />
  );
}
