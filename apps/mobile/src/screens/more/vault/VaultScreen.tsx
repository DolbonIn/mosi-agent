import type { AccessRecord, CredentialInfo, KeepFor, ProviderInfo } from "@pickle/protocol";
import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { loadConnections, useConnections } from "../../../api/store";
import { nav, type ScreenProps } from "../../../app/nav";
import { Screen } from "../../../app/Screen";
import { EXIT, SPRING, t } from "../../../motion/springs";
import { useTierValue } from "../../../motion/tier";
import { Button } from "../../../ui/Button";
import { Icon } from "../../../ui/Icon";
import { LargeTitle } from "../../../ui/LargeTitle";
import { List, ListRow, ListSection } from "../../../ui/List";
import { SegmentedControl, SegmentedPanels } from "../../../ui/SegmentedControl";
import { ConnectSheet } from "../connections/ConnectSheet";
import { CONNECTIONS_TITLE, loginCopy } from "../connections/providerCopy";
import { accessLogRes, credentialsRes, removeCredential, setKeepFor, useResource } from "../data";
import { ago, clock, dateKo, josa, KEEP_FOR, keepForLabel, remainingKo, useCoarseNow } from "../format";
import { InlineError, Note, Placeholder, ProviderIcon, Stack, useAgentName, useRouteVisible } from "../parts";
import "./vault.css";

/**
 * Vault — 저장된 로그인 · 접근 기록 (MOTION-SPEC §6.8, research §4-8), one list like 나의 모시 and 연결:
 *  - a saved login is one inset group: the app and its masked account, 보관 기간 (the value carries the time left; the
 *    row opens the keep-for choice), 마지막 사용, and a red 이 로그인 지우기 row (hold, or tap twice), with the saved
 *    date and what deleting breaks as the group's footer;
 *  - the access log is a row list per day: the time is the trailing value, and a quiet third line appears only for a
 *    refusal or a failure, or for the owner's device-signed decisions;
 *  - an empty vault offers the KakaoTalk row, which opens its connect sheet directly.
 * Secrets never reach the app: the server returns a masked hint only, and even that is hidden at once (no animation)
 * whenever the page's visibility changes or the person leaves this screen (§8.15); it stays hidden on return until
 * they tap 보기 on that row, and hides itself again after 10 s.
 * Keep-for changes are optimistic with rollback; deletes wait for the server.
 * Params: { segment?: "logins" | "log" }. The large title follows the segment.
 */
type Seg = "logins" | "log";
const SEGS: { value: Seg; label: string }[] = [
  { value: "logins", label: "로그인 정보" },
  { value: "log", label: "접근 기록" },
];
const TITLE: Record<Seg, string> = { logins: "저장된 로그인", log: "접근 기록" };

const KIND_LABEL: Record<CredentialInfo["kind"], string> = { login: "로그인", token: "토큰", card: "카드" };
const REVEAL_MS = 10_000;
/** the app an empty vault offers: the one most people come here to connect */
const FIRST_PROVIDER = "kakaotalk";

export function VaultScreen({ route }: ScreenProps) {
  const initial: Seg = route.params?.segment === "log" ? "log" : "logins";
  const [seg, setSeg] = useState<Seg>(initial);
  // The large title morphs out of the row that opened the screen (layoutId) and follows the segment by the content
  // swap (LargeTitle `swap`, §3): after the first change it lets go of the shared element by itself.
  const changeSeg = (s: Seg) => setSeg(s);
  const visible = useRouteVisible(route.key);
  const creds = useResource(credentialsRes, visible);
  const log = useResource(accessLogRes, visible);
  const { providers, loaded: connLoaded, connections } = useConnections();
  const agentName = useAgentName();
  const [active, setActive] = useState<{ provider: ProviderInfo; el: HTMLElement | null; open: boolean; n: number } | null>(null);
  const firstRow = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!connLoaded) void loadConnections();
  }, [connLoaded]);

  // §8.15: every visibility change hides the account hints synchronously (no animation), and so does leaving this
  // screen inside the app (a tab switch, a pop). Each hide is a new epoch; a row's 보기 reveals it for that epoch only.
  const [hideEpoch, setHideEpoch] = useState(0);
  useEffect(() => {
    const hide = () => flushSync(() => setHideEpoch((e) => e + 1));
    document.addEventListener("visibilitychange", hide);
    window.addEventListener("pagehide", hide);
    return () => {
      document.removeEventListener("visibilitychange", hide);
      window.removeEventListener("pagehide", hide);
    };
  }, []);
  useEffect(() => {
    if (!visible) setHideEpoch((e) => e + 1);
  }, [visible]);

  const providerOf = useMemo(() => {
    const m = new Map<string, ProviderInfo>();
    for (const p of providers) m.set(p.id, p);
    return (id: string) => m.get(id);
  }, [providers]);

  const first = providerOf(FIRST_PROVIDER);
  const openSheet = (p: ProviderInfo) => {
    const el = firstRow.current?.querySelector<HTMLElement>(".list-row") ?? null;
    setActive((a) => ({ provider: p, el, open: true, n: (a?.n ?? 0) + 1 }));
  };

  const linkedName = (c: CredentialInfo) =>
    connections.some((x) => x.credentialId === c.id && (x.status === "connected" || x.status === "needs_verification" || x.status === "connecting"))
      ? providerOf(c.service)?.name ?? c.serviceName
      : null;

  return (
    <Screen routeKey={route.key}>
      <LargeTitle swap title={TITLE[seg]} layoutId={route.titleLayoutId} />
      <Stack gap={18}>
        <SegmentedControl idBase="vault" label="보기" value={seg} onChange={changeSeg} options={SEGS} />
        <SegmentedPanels value={seg} order={["logins", "log"]} idBase="vault">
          {seg === "logins" ? (
            !creds.loaded && creds.loading ? (
              <Placeholder rows={2} height={216} />
            ) : creds.error && !creds.data.length ? (
              <InlineError>{creds.error}</InlineError>
            ) : creds.data.length === 0 ? (
              <VaultEmpty title="아직 저장된 로그인이 없어요" body={`메신저를 연결하거나 ${josa(agentName, "이가")} 로그인이 필요할 때 입력한 정보가 여기에 보관돼요.`}>
                {first ? (
                  <div ref={firstRow}>
                    <List>
                      <ListRow
                        leading={<ProviderIcon provider={first} size={30} />}
                        title={`${first.name} 연결하기`}
                        subtitle={first.available ? loginCopy(first) : first.unavailableReason ?? "지금은 연결할 수 없어요"}
                        onClick={first.available ? () => openSheet(first) : undefined}
                        chevron={first.available}
                        disabled={!first.available}
                      />
                    </List>
                  </div>
                ) : connLoaded ? (
                  // a server without KakaoTalk in its catalog: the way in is the list of everything that can connect
                  <List>
                    <ListRow title="메신저 연결하기" onClick={() => nav.push("connections", undefined, { title: CONNECTIONS_TITLE })} />
                  </List>
                ) : null}
              </VaultEmpty>
            ) : (
              <Stack gap={24}>
                {/* said once per flow (CP-5, critique settings P2-1): here, only when there is something to protect */}
                <Note>비밀번호는 이 기기에서 암호화한 뒤 보안 금고에만 보관해요. {agentName}도, 운영자도 원문을 볼 수 없어요.</Note>
                <AnimatePresence mode="popLayout" initial={false}>
                  {creds.data.map((c) => (
                    <LoginGroup key={c.id} cred={c} provider={providerOf(c.service)} hideEpoch={hideEpoch} linkedTo={linkedName(c)} />
                  ))}
                </AnimatePresence>
              </Stack>
            )
          ) : (
            <AccessLog records={log.data} loading={!log.loaded && log.loading} error={log.error} agentName={agentName} providerOf={providerOf} />
          )}
        </SegmentedPanels>
      </Stack>
      {active && (
        <ConnectSheet
          key={`${active.provider.id}:${active.n}`}
          provider={active.provider}
          source={active.el}
          open={active.open}
          onClose={() => setActive((a) => (a ? { ...a, open: false } : a))}
          onClosed={() => {
            setActive((a) => (a && !a.open ? null : a));
            void credentialsRes.load();
          }}
        />
      )}
    </Screen>
  );
}

/**
 * Empty vault page: a left-aligned title and one sentence (no glyph, no promise), then whatever fills it. Arrives once
 * with a 6 px rise (morph) and a fade, like ui/EmptyState; reduced motion: simply there.
 */
function VaultEmpty({ title, body, children }: { title: string; body: string; children?: ReactNode }) {
  const reduce = useTierValue("reduceMotion");
  return (
    <motion.div
      className="vault-empty"
      initial={reduce ? false : { opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ y: SPRING.morph, opacity: SPRING.fade }}
    >
      <div className="vault-empty__text">
        <h2 className="vault-empty__title">{title}</h2>
        <p className="vault-empty__body">{body}</p>
      </div>
      {children}
    </motion.div>
  );
}

// ───────────────────────────── saved logins ─────────────────────────────

/**
 * One saved login = one inset group. 보관 기간 opens the keep-for choice under itself: the panel's height follows the
 * `morph` spring and its content fades in after it; the chevron turns on `snap` (same as 연결's 고급 fold). Deleting
 * takes the hold or the second tap (ui/Button confirm), then the group leaves on EXIT while the groups below close up
 * on `morph` (layout, position only: a group that opens never scales). Reduced motion: all of it at once.
 */
function LoginGroup({ cred, provider, hideEpoch, linkedTo }: { cred: CredentialInfo; provider: ProviderInfo | undefined; hideEpoch: number; linkedTo: string | null }) {
  const now = useCoarseNow(cred.expiresAt);
  const reduce = useTierValue("reduceMotion");
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [revealed, setRevealed] = useState<number | null>(null);
  const panelId = useId();
  const expired = cred.expired || (cred.expiresAt !== null && cred.expiresAt <= now);
  const name = provider?.name ?? cred.serviceName;
  // hidden once the screen was left, until 보기 on this row for the current epoch
  const masked = hideEpoch > 0 && revealed !== hideEpoch;

  // a reveal lasts 10 s
  useEffect(() => {
    if (revealed === null) return;
    const id = setTimeout(() => setRevealed(null), REVEAL_MS);
    return () => clearTimeout(id);
  }, [revealed]);

  const changeKeep = async (k: KeepFor) => {
    setError(null);
    try {
      await setKeepFor(cred.id, k);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const remove = async () => {
    setError(null);
    try {
      await removeCredential(cred.id);
    } catch (e) {
      setError((e as Error).message);
      throw e;
    }
  };

  const keep = keepForLabel(cred.keepFor);
  const keepValue: ReactNode = expired ? (
    <>
      {keep} · <span className="more-danger-text">만료됨</span>
    </>
  ) : cred.expiresAt ? (
    `${keep} · ${remainingKo(cred.expiresAt, now)}`
  ) : (
    keep
  );
  const lastUsed = cred.lastUsedAt ? `${ago(cred.lastUsedAt, now)} · ${cred.useCount}회` : "아직 안 썼어요";
  const footer = `${dateKo(cred.createdAt, now)}에 저장했어요. ${linkedTo ? `지우면 이 로그인으로 연결된 ${linkedTo}도 다시 로그인해야 해요.` : "지우면 보안 금고에서 바로 사라져요."}`;

  return (
    <motion.section
      layout={reduce ? false : "position"}
      transition={{ layout: t("morph") }}
      exit={reduce ? { opacity: 0, transition: { duration: 0 } } : { opacity: 0, scale: 0.96, transition: EXIT }}
      className="list-section vault-login"
    >
      <List
        label={`${name} ${provider?.auth === "api_key" ? "API 키" : KIND_LABEL[cred.kind]}`}
        footer={
          <>
            {error ? <InlineError className="vault-login__error">{error}</InlineError> : null}
            {footer}
          </>
        }
      >
        <ListRow
          leading={<ProviderIcon provider={provider} size={30} />}
          title={name}
          subtitle={
            masked ? (
              <span className="vault-hint" data-hidden="">
                <span aria-hidden="true">••••••</span>
                <span className="sr-only">계정 정보를 가렸어요</span>
              </span>
            ) : (
              <span className="vault-hint tnum">{cred.hint || "••••"}</span>
            )
          }
          accessory={
            masked ? (
              <Button tone="neutral" size="sm" icon="eye" ariaLabel={`${name} 계정 정보 보기`} onClick={() => setRevealed(hideEpoch)}>
                보기
              </Button>
            ) : undefined
          }
        />
        <button type="button" className="list-row is-clickable vault-keep" aria-expanded={open} aria-controls={open ? panelId : undefined} onClick={() => setOpen((o) => !o)}>
          <span className="list-row-main">
            <span className="list-row-text">
              <span className="list-row-title">보관 기간</span>
            </span>
            <span className="list-row-detail tnum">{keepValue}</span>
            <span className="list-row-chevron vault-keep__chev" aria-hidden="true">
              <Icon name="chevron-down" size={16} weight="semibold" />
            </span>
          </span>
        </button>
        <AnimatePresence initial={false}>
          {open && (
            <motion.div
              key="keep"
              id={panelId}
              className="vault-keep-panel"
              initial={reduce ? false : { height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1, transition: reduce ? { duration: 0 } : { height: t("morph"), opacity: { ...(t("fade") as object), delay: 0.06 } } }}
              exit={reduce ? { opacity: 0, transition: { duration: 0 } } : { height: 0, opacity: 0, transition: { height: t("morph"), opacity: { duration: 0.12 } } }}
            >
              <div className="vault-keep-panel__inner">
                <SegmentedControl role="radiogroup" size="sm" label={`${name} 보관 기간`} value={cred.keepFor} onChange={changeKeep} options={KEEP_FOR} />
                <span className="sr-only" aria-live="polite">
                  보관 기간 {keep}
                </span>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
        <ListRow title="마지막 사용" detail={lastUsed} />
        <div className="vault-del-row">
          <Button
            variant="plain"
            tone="destructive"
            size="md"
            fullWidth
            className="vault-del"
            style={{ height: 54, borderRadius: "0 0 var(--r-group) var(--r-group)" }}
            confirm={{ label: "한 번 더 누르면 지워요", hint: "길게 누르거나, 두 번 눌러 확인해요" }}
            action={remove}
          >
            이 로그인 지우기
          </Button>
        </div>
      </List>
    </motion.section>
  );
}

// ───────────────────────────── access log ─────────────────────────────

/**
 * Access-log action keys → Korean. The server writes save / remove (vault), login / logout / list_chats /
 * read_messages / send_message (messengers hub) and approval (the owner's approve or deny, threads.ts). A key this
 * table doesn't know yet reads as a generic "사용", never as the raw key.
 */
const ACTION: Record<string, string> = {
  login: "로그인",
  logout: "연결 해제",
  send_message: "메시지 보내기",
  read_messages: "메시지 읽기",
  list_chats: "대화방 보기",
  approval: "승인 요청",
  payment: "결제",
  view: "보기",
  save: "저장",
  remove: "삭제",
  delete: "삭제",
};
const actionLabel = (key: string) => (Object.hasOwn(ACTION, key) ? ACTION[key] : "사용");

function dayLabel(ms: number, now: number): string {
  const d = (x: number) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(new Date(x));
  const today = d(now);
  const y = d(now - 86_400_000);
  const k = d(ms);
  if (k === today) return "오늘";
  if (k === y) return "어제";
  return dateKo(ms, now);
}

function AccessLog({
  records,
  loading,
  error,
  agentName,
  providerOf,
}: {
  records: AccessRecord[];
  loading: boolean;
  error?: string;
  agentName: string;
  providerOf: (id: string) => ProviderInfo | undefined;
}) {
  const groups = useMemo(() => {
    const now = Date.now();
    const out: { label: string; items: AccessRecord[] }[] = [];
    for (const r of records) {
      const label = dayLabel(r.createdAt, now);
      const last = out[out.length - 1];
      if (last && last.label === label) last.items.push(r);
      else out.push({ label, items: [r] });
    }
    return out;
  }, [records]);

  if (loading) return <Placeholder rows={4} height={72} />;
  if (error && !records.length) return <InlineError>{error}</InlineError>;
  if (!records.length) return <VaultEmpty title="아직 접근 기록이 없어요" body={`${josa(agentName, "이가")} 저장된 로그인을 쓰면 언제, 무엇에 썼는지 여기에 남아요.`} />;

  const who = (a: AccessRecord["actor"]) => (a === "agent" ? agentName : a === "user" ? "나" : "시스템");
  return (
    <Stack gap={24}>
      <Note>저장된 로그인을 누가, 언제, 무엇에 썼는지 모두 남겨요. 기록은 지울 수 없어요.</Note>
      {groups.map((g) => (
        <ListSection key={g.label} title={g.label}>
          {g.items.map((r) => {
            const p = providerOf(r.service);
            const refused = r.outcome === "denied";
            const failed = r.outcome === "error";
            // the third line only when there is something to say: a refusal or failure, or the owner's device-signed
            // decision (threads.ts sets deviceVerified for those only; an agent's use never carries it)
            const note =
              refused || failed || r.deviceVerified ? (
                <span className="vault-rec__note" data-outcome={r.outcome}>
                  <Icon name={refused ? "x-circle" : failed ? "exclamation" : "shield"} size={14} weight="semibold" />
                  {refused ? <b>거절됨</b> : failed ? <b>실패</b> : null}
                  {r.deviceVerified && <span className="vault-verified">{refused || failed ? "· " : ""}이 기기의 키로 확인했어요</span>}
                </span>
              ) : null;
            return (
              <ListRow
                key={r.id}
                className="vault-rec"
                leading={p ? <ProviderIcon provider={p} size={30} /> : undefined}
                icon={p ? undefined : "key"}
                title={
                  <span className="vault-rec__what" data-rec={r.id}>
                    {r.serviceName} <span className="vault-rec__action">{actionLabel(r.action)}</span>
                  </span>
                }
                subtitle={
                  <>
                    {who(r.actor)}
                    {r.purpose ? ` · ${r.purpose}` : ""}
                    {note}
                  </>
                }
                detail={<time dateTime={new Date(r.createdAt).toISOString()}>{clock(r.createdAt)}</time>}
              />
            );
          })}
        </ListSection>
      ))}
    </Stack>
  );
}
