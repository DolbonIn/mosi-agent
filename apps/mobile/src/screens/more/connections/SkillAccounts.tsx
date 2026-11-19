import type { Connection, CredentialField, KeepFor, ProviderInfo } from "@pickle/protocol";
import { AnimatePresence, motion } from "framer-motion";
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { toApiError } from "../../../api/client";
import * as ep from "../../../api/endpoints";
import { connectionsStore, loadConnections, upsertConnection, useConnections } from "../../../api/store";
import { nav } from "../../../app/nav";
import { SPRING, t } from "../../../motion/springs";
import { useTierValue } from "../../../motion/tier";
import { Button, type ButtonState } from "../../../ui/Button";
import { Chip } from "../../../ui/Chip";
import { ConfirmButton } from "../../../ui/ConfirmButton";
import { Icon } from "../../../ui/Icon";
import { ListRow, ListSection } from "../../../ui/List";
import { SegmentedControl } from "../../../ui/SegmentedControl";
import { Sheet } from "../../../ui/Sheet";
import { TextField } from "../../../ui/TextField";
import { Sentences } from "../../../ui/Text";
import { ago, dateKo, josa, KEEP_FOR, keepForLabel } from "../format";
import { InlineError, Note, SectionLabel, StatusPill, useAgentName, useUserId, type PillTone } from "../parts";
import { lockSentence, SKILL_COPY, SKILL_HIDDEN, skillCopy, type SkillCopy, type SkillIssue } from "./skillCatalog";
import "./SkillAccounts.css";

/**
 * "모시가 쓰는 서비스" (KSKILL-LOGIN-BRIEF A) and the folded "키로 연결" (C) on the connections screen. The services are
 * the server's "korea" providers (GET /api/connections), in the brief's order, with the words of skillCatalog on top.
 * Rows are words only (no service here has a mark in assets/brands); the state is the trailing pill — 연결됨 / 다시
 * 연결 — or, before connecting, what connecting unlocks. Each row morphs into its connect sheet. `focus` + `connect`
 * (route params, e.g. from a connection_request card) open that service's sheet at once. Hidden when the server lists
 * no k-skill service.
 */
export function SkillAccounts({ focus, connect }: { focus?: string; connect?: boolean }) {
  const { providers, connections } = useConnections();
  const agentName = useAgentName();
  const { open, sheet } = useSkillSheet();
  const keys = useDisclosure(focus ? skillCopy(focus)?.section === "key" : false);
  const focused = useRef(false);

  const entries = skillEntries(providers, connections);
  const focusable = !!focus && !!connect && entries.some((e) => e.id === focus && e.state !== "soon");
  useEffect(() => {
    if (!focusable || focused.current) return;
    focused.current = true;
    const id = requestAnimationFrame(() => {
      const el = document.querySelector<HTMLElement>(`.sk-row-${CSS.escape(focus!)}`);
      el?.scrollIntoView({ block: "center" });
      open(focus!, el);
    });
    return () => cancelAnimationFrame(id);
  }, [focusable, focus, open]);

  if (!entries.length) return null;
  const accounts = entries.filter((e) => e.section === "account");
  const keyed = entries.filter((e) => e.section === "key");
  const keyedLinked = keyed.filter((k) => k.state === "connected" || k.state === "reconnect").length;

  const row = (e: SkillEntry) => {
    const c = e.connection;
    const sub =
      e.state === "connected"
        ? [c?.accountLabel, c?.connectedAt ? `${ago(c.connectedAt)} 연결` : null].filter(Boolean).join(" · ") || e.unlocks
        : e.state === "reconnect"
          ? c?.lastError || "저장한 정보로 연결하지 못했어요"
          : e.state === "waiting"
            ? "연결하고 있어요"
            : e.unlocks;
    const pill = PILL[e.state];
    const label = e.state === "soon" ? (e.provider?.available === false && e.provider.unavailableReason) || "곧 연결돼요" : pill?.label ?? "연결 전";
    return (
      <ListRow
        key={e.id}
        className={`sk-row sk-row-${e.id}${e.state === "soon" ? " is-soon" : ""}`}
        title={e.name}
        // a node, so ListRow's copy() leaves it as built: the sentences and ties go in here ("…만료됐어요. / 다시 입력해 주세요.")
        subtitle={
          <span className={e.state === "reconnect" ? "more-danger-text" : undefined}>
            <Sentences text={sub} />
          </span>
        }
        detail={pill ? <StatusPill tone={pill.tone}>{pill.label}</StatusPill> : e.state === "soon" ? label : undefined}
        onClick={e.state === "soon" ? undefined : () => open(e.id, document.querySelector<HTMLElement>(`.sk-row-${CSS.escape(e.id)}`))}
        chevron={e.state !== "soon"}
        ariaLabel={`${e.name}, ${label}, ${sub}`}
      />
    );
  };

  return (
    <>
      <ListSection className="sk-group" title={`${josa(agentName, "이가")} 쓰는 서비스`}>
        {accounts.map(row)}
      </ListSection>
      {keyed.length > 0 && (
        <ListSection className={`sk-keys sk-keys--${keys.state}`} footer={keys.state !== "closed" ? "직접 발급한 개발자 키가 있을 때만 필요해요." : undefined}>
          {/* the fold is the group's own heading, like the 고급 fold: words and a chevron, no plate */}
          <h2 className="sk-keys-h">
            <button type="button" className="list-row is-clickable sk-keys-toggle" aria-expanded={keys.state === "open"} onClick={keys.toggle}>
              <span className="list-row-main">
                <span className="list-row-text">
                  <span className="list-row-title">키로 연결</span>
                  <span className="list-row-sub">{[keyedLinked ? `연결됨 ${keyedLinked}` : null, ...keyed.map((k) => k.name)].filter(Boolean).join(" · ")}</span>
                </span>
                <span className="list-row-chevron sk-keys-chev" aria-hidden="true">
                  <Icon name="chevron-down" size={16} weight="semibold" />
                </span>
              </span>
            </button>
          </h2>
          {keys.state !== "closed" && keyed.map(row)}
        </ListSection>
      )}
      {sheet}
    </>
  );
}

// ───────────────────────────── state ─────────────────────────────

/** connected / a saved login that stopped working / mid-connect / never connected / not connectable yet */
export type SkillState = "connected" | "reconnect" | "waiting" | "none" | "soon";

interface SkillEntry {
  id: string;
  name: string;
  section: "account" | "key";
  unlocks: string;
  provider: ProviderInfo | undefined;
  connection: Connection | undefined;
  state: SkillState;
}

export const isSkillProvider = (p: ProviderInfo) => p.category === "korea" || p.auth === "api_key";

export function skillState(p: ProviderInfo | undefined, copy: SkillCopy | undefined, c: Connection | undefined): SkillState {
  if (c?.status === "connected") return "connected";
  // browser logins wait for the login relay (kskill-tools phase 2); this sheet has no relay flow for them yet
  if (!p || !p.available || copy?.auth === "browser") return "soon";
  if (c?.status === "error" && (c.accountLabel || c.credentialId)) return "reconnect";
  if (c?.status === "connecting" || c?.status === "needs_verification") return "waiting";
  return "none";
}

/** the server's k-skill services in the brief's order, then any other it adds; never the ones the app doesn't offer
 *  (SKILL_HIDDEN), and a browser login only once the server marks it available. Linked first, 곧 연결돼요 last. */
function skillEntries(providers: ProviderInfo[], connections: Connection[]): SkillEntry[] {
  const korea = new Map(providers.filter((p) => isSkillProvider(p) && !SKILL_HIDDEN.has(p.id)).map((p) => [p.id, p]));
  const conn = new Map(connections.map((c) => [c.provider, c]));
  const list: SkillEntry[] = [];
  for (const copy of SKILL_COPY) {
    const p = korea.get(copy.id);
    korea.delete(copy.id);
    if (!p || (copy.auth === "browser" && !p.available)) continue;
    const c = conn.get(copy.id);
    list.push({ id: copy.id, name: p?.name ?? copy.name, section: copy.section, unlocks: copy.unlocks, provider: p, connection: c, state: skillState(p, copy, c) });
  }
  for (const p of korea.values()) {
    const c = conn.get(p.id);
    list.push({ id: p.id, name: p.name, section: "account", unlocks: p.description, provider: p, connection: c, state: skillState(p, undefined, c) });
  }
  const rank: Record<SkillState, number> = { connected: 0, reconnect: 0, waiting: 0, none: 1, soon: 2 };
  return list.map((e, i) => ({ e, i })).sort((a, b) => rank[a.e.state] - rank[b.e.state] || a.i - b.i).map((x) => x.e);
}

const PILL: Record<SkillState, { tone: PillTone; label: string } | null> = {
  connected: { tone: "ok", label: "연결됨" },
  reconnect: { tone: "error", label: "다시 연결" },
  waiting: { tone: "wait", label: "연결 중" },
  none: null,
  soon: null,
};

// ───────────────────────────── sheet ─────────────────────────────

/**
 * One connect sheet at a time, morphing out of whatever opened it (a row here; the 연결하기 button of a
 * connection_request card in the chat — the sheet opens over the thread, so the waiting turn's stream stays open and
 * the retry shows the moment the sheet closes). `sheet` goes anywhere in the opener's tree: the Sheet portals itself.
 */
/** how the sheet opens: `form` starts on the fields even when the list says connected (a chat card whose login the
 *  tool just refused) */
export interface SkillSheetOptions {
  form?: boolean;
}

export function useSkillSheet() {
  const [active, setActive] = useState<{ id: string; el: HTMLElement | null; open: boolean; n: number; opts: SkillSheetOptions } | null>(null);
  const open = useCallback((id: string, el?: HTMLElement | null, opts: SkillSheetOptions = {}) => {
    setActive((a) => ({ id, el: el ?? null, open: true, n: (a?.n ?? 0) + 1, opts }));
  }, []);
  const sheet = active ? (
    <SkillSheet
      key={`${active.id}:${active.n}`}
      serviceId={active.id}
      source={active.el}
      open={active.open}
      form={active.opts.form}
      onClose={() => setActive((a) => (a ? { ...a, open: false } : a))}
      onClosed={() => setActive((a) => (a && !a.open ? null : a))}
    />
  ) : null;
  return { open, sheet };
}

/** checking: saved, but the service couldn't be reached to verify it; the server re-checks (30 s, 2 min, 10 min) and
 *  sends a `connection` event, which this sheet follows */
type Phase = "form" | "manage" | "connected" | "checking";
const CHECKING_LINE = "지금은 확인하지 못했어요. 저장해 두었고 잠시 후 다시 확인할게요.";
/** a field the person may leave empty (left out of the envelope when empty) */
const optional = (f: CredentialField) => !!f.optional;
/** the vault row's kind, which the AAD binds: the server's `kind` (always sent for k-skill services), else `auth` as
 *  for the messenger logins (older answers) */
const kindOf = (p: ProviderInfo): "login" | "token" => p.kind ?? (p.auth === "token" || p.auth === "api_key" ? "token" : "login");

export interface SkillSheetProps {
  serviceId: string;
  source: HTMLElement | null;
  open: boolean;
  onClose: () => void;
  onClosed: () => void;
  form?: boolean;
}

/**
 * The connect sheet, built like the messenger one (draft connections B): title from the leading edge, the live state
 * under it, one plain line of what the agent does with the account (and that it only reads, where true), the
 * provider's fields with visible labels, the sealing sentence under the last secret, then two summary rows — where the
 * key is issued (the official console, in a new tab) and how long it is kept. The values are sealed on this device
 * (sealCredential, aad `${userId}:${service}:${kind}`) and sent sealed to POST /api/connections/:id, which verifies
 * them upstream; they leave memory once connected. A refused key is said inline and the inputs stay. Connected: the
 * account, since when, and 연결 해제 (hold or tap twice), which revokes the stored login. A service that can't be
 * connected yet says so, with the button disabled.
 */
export function SkillSheet({ serviceId, source, open, onClose, onClosed, form: startOnForm }: SkillSheetProps) {
  const { providers, connections, loaded, loading } = useConnections();
  const userId = useUserId();
  const agentName = useAgentName();
  const copy = skillCopy(serviceId);
  const provider = providers.find((p) => p.id === serviceId);
  const connection = connections.find((c) => c.provider === serviceId);
  const state = skillState(provider, copy, connection);
  const name = provider?.name ?? copy?.name ?? serviceId;
  const [phase, setPhase] = useState<Phase>(() =>
    startOnForm ? "form" : state === "connected" ? "manage" : connection?.status === "needs_verification" ? "checking" : "form",
  );
  const [values, setValues] = useState<Record<string, string>>({});
  const [keepFor, setKeepFor] = useState<KeepFor>("30d");
  const [btn, setBtn] = useState<ButtonState>("idle");
  const [error, setError] = useState<string | null>(state === "reconnect" ? connection?.lastError || "저장한 정보로 연결하지 못했어요. 다시 입력해 주세요." : null);
  const [busy, setBusy] = useState(false);
  const [doneLabel, setDoneLabel] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  // opened from a chat card before the connections screen ever loaded (once: a failed load isn't retried in a loop)
  const tried = useRef(false);
  useEffect(() => {
    if (loaded || loading || tried.current) return;
    tried.current = true;
    void loadConnections();
  }, [loaded, loading]);

  const soon = state === "soon";
  const fields = provider?.fields ?? [];
  const lastSecret = [...fields].reverse().find((f) => f.type === "password")?.key;
  const missing = !fields.length || fields.some((f) => !optional(f) && !(values[f.key] ?? "").trim());
  const does = copy?.does ?? provider?.description ?? "";

  const submit = async () => {
    if (busy || missing || soon || !provider) return;
    setError(null);
    setBtn("loading");
    setBusy(true);
    try {
      if (!userId) throw new Error("no session");
      const sealed: Record<string, string> = {};
      for (const f of fields) {
        const v = f.type === "password" ? values[f.key] ?? "" : (values[f.key] ?? "").trim();
        if (v || !optional(f)) sealed[f.key] = v;
      }
      // the list's hint comes from a field that isn't secret (an ID, a business number); a key-only service (RISS) gets
      // none — sealCredential would otherwise fall back to the key's first characters
      const hintField = fields.find((f) => f.type !== "password" && sealed[f.key])?.key;
      const credential = await ep.sealCredential({ userId, service: provider.id, label: provider.name, kind: kindOf(provider), keepFor, fields: sealed, hintField });
      if (!hintField) credential.hint = "";
      credential.label = credential.hint ? `${provider.name} (${credential.hint})` : provider.name;
      const res = await ep.connect(provider.id, { credential });
      if (res?.connection) upsertConnection(res.connection);
      if (!mounted.current) return;
      if (res?.connection?.status === "needs_verification") {
        // not a refusal: the key is kept and the server checks again, so no error tone and no second try needed
        setValues({});
        setBtn("idle");
        refocus.current = "checking";
        setPhase("checking");
      } else if (res?.connection?.status === "connected") {
        setValues({}); // the plaintext leaves memory with the form
        setPhase("connected");
        setBtn("success");
        setTimeout(() => {
          if (mounted.current) {
            setBtn("idle");
            setDoneLabel(true);
          }
        }, 1200);
      } else {
        setError(res?.connection?.lastError || "연결하지 못했어요. 입력한 값을 확인해 주세요.");
        setBtn("error");
      }
    } catch (e) {
      if (!mounted.current) return;
      setError(e instanceof Error && e.message === "no session" ? "다시 로그인해 주세요." : toApiError(e).message);
      setBtn("error");
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  // the button that was pressed leaves with its phase: keep focus in the sheet (Escape and screen readers stay on it)
  const refocus = useRef<"checking" | "form" | null>(null);
  const checkingFoot = useRef<HTMLDivElement>(null);
  const formEl = useRef<HTMLFormElement>(null);
  useEffect(() => {
    const want = refocus.current;
    if (!want || want !== phase) return;
    refocus.current = null;
    const el = want === "checking" ? checkingFoot.current?.querySelector("button") : formEl.current?.querySelector("input");
    el?.focus({ preventScroll: true });
  }, [phase]);

  // while checking, the server's re-check arrives as a `connection` event (the store upserts it): follow it here
  const checkedStatus = phase === "checking" ? connection?.status : undefined;
  useEffect(() => {
    if (!checkedStatus || checkedStatus === "needs_verification") return;
    if (checkedStatus === "connected") {
      setPhase("connected");
      setDoneLabel(true);
    } else {
      setError(connection?.lastError || "저장한 키로 연결하지 못했어요. 다시 입력해 주세요.");
      setPhase("form");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checkedStatus]);

  // on the form while the list still says connected (opened from a refused card): 다시 연결
  const live: SkillState = phase === "connected" || phase === "manage" ? "connected" : btn === "loading" || phase === "checking" ? "waiting" : soon ? "soon" : error || state === "connected" ? "reconnect" : "none";

  const footer =
    phase === "manage" ? (
      <DisconnectSkill id={serviceId} name={name} kind={provider ? kindOf(provider) : "token"} agentName={agentName} onDone={onClose} onBusy={setBusy} />
    ) : phase === "checking" ? (
      // the key is kept; entering it again is allowed (the server tidies the older row once one connects)
      <div ref={checkingFoot}>
        <Button
          fullWidth
          tone="secondary"
          onClick={() => {
            refocus.current = "form";
            setPhase("form");
          }}
        >
          다시 입력하기
        </Button>
      </div>
    ) : phase === "connected" ? (
      <Button fullWidth tone={doneLabel ? "secondary" : "primary"} state={btn} holdSuccess onClick={doneLabel ? onClose : undefined} successLabel="연결했어요">
        완료
      </Button>
    ) : soon ? (
      // the pill already says 곧 연결돼요; the button only shows the action isn't open yet
      <Button fullWidth disabled>
        연결하기
      </Button>
    ) : (
      <div className="sk-footer">
        <InlineError>{error}</InlineError>
        <Button fullWidth state={btn} disabled={missing} onClick={submit} busyLabel="연결하는 중" successLabel="연결했어요" errorLabel="다시 연결하기">
          연결하기
        </Button>
      </div>
    );

  return (
    <Sheet open={open} onClose={onClose} onClosed={onClosed} source={source} title={name} busy={busy} footer={footer} className="sk-sheet" ariaLabel={`${name} 연결`}>
      <div className="more-sheet">
        <div className="sk-sheet-status">
          <LiveState state={live} />
          {phase === "connected" && connection?.accountLabel ? (
            <span className="sk-sheet-hint">{connection.accountLabel}</span>
          ) : phase === "form" && !soon && provider?.auth === "api_key" ? (
            <span className="sk-sheet-hint">API 키로 연결</span>
          ) : null}
        </div>

        {phase === "checking" ? (
          <>
            {does ? <p className="more-sheet-lead"><Sentences text={does} /></p> : null}
            <Note icon="clock">{connection?.status === "needs_verification" && connection.lastError ? connection.lastError : CHECKING_LINE}</Note>
          </>
        ) : phase === "manage" ? (
          <ManageView does={does} connection={connection} kind={provider ? kindOf(provider) : "token"} />
        ) : phase === "connected" ? (
          copy?.examples.length ? (
            <ConnectedView examples={copy.examples} onPick={(text) => {
              onClose();
              nav.compose(text);
            }} />
          ) : (
            <p className="more-sheet-lead"><Sentences text={does} /></p>
          )
        ) : soon ? (
          <>
            {does ? <p className="more-sheet-lead"><Sentences text={does} /></p> : null}
            <Note icon="clock">
              {copy?.auth === "browser"
                ? `준비되면 여기서 ${name}에 직접 로그인해 연결해요.`
                : provider?.unavailableReason || "지금은 연결할 수 없어요. 준비되면 여기서 바로 연결해요."}
            </Note>
          </>
        ) : (
          <>
            {copy?.notice ? <Note icon="info"><Sentences text={copy.notice} /></Note> : null}
            {does ? <p className="more-sheet-lead"><Sentences text={does} /></p> : null}
            <form
              ref={formEl}
              className="sk-form"
              autoComplete="off"
              onSubmit={(e) => {
                e.preventDefault();
                void submit();
              }}
            >
              {fields.map((f, i) => (
                <TextField
                  key={f.key}
                  label={optional(f) ? `${f.label} (선택)` : f.label}
                  type={f.type === "password" ? "password" : f.type === "tel" ? "tel" : f.type === "email" ? "email" : "text"}
                  value={values[f.key] ?? ""}
                  onChange={(v) => {
                    setValues((s) => ({ ...s, [f.key]: v }));
                    if (btn === "error") setBtn("idle");
                  }}
                  placeholder={f.placeholder}
                  hint={f.key === lastSecret ? lockSentence(agentName) : f.hint || undefined}
                  // a third-party login or key: never autofilled from (or saved as) this app's own password
                  autoComplete="off"
                  inputMode={f.type === "tel" ? "tel" : f.type === "email" ? "email" : undefined}
                  autoCapitalize="none"
                  enterKeyHint={i === fields.length - 1 ? "go" : "next"}
                  onEnter={i === fields.length - 1 ? () => void submit() : undefined}
                  name={`${serviceId}-${f.key}`}
                  disabled={busy}
                />
              ))}
            </form>
            <div className="sk-folds">
              {copy?.issue ? <IssueRow issue={copy.issue} /> : null}
              <Fold title={provider && kindOf(provider) === "login" ? "로그인 정보 보관" : "키 보관"} value={keepForLabel(keepFor)}>
                <SegmentedControl role="radiogroup" size="sm" label="보관 기간" value={keepFor} onChange={setKeepFor} options={KEEP_FOR} />
              </Fold>
            </div>
          </>
        )}
      </div>
    </Sheet>
  );
}

/** "어디서 발급하나요?" — the official console, one row (52 px), opened in a new tab; words only when there is no page */
function IssueRow({ issue }: { issue: SkillIssue }) {
  const ask = issue.ask ?? "어디서 발급하나요?";
  const body = (
    <>
      <span className="sk-issue__main">
        <span className="sk-issue__ask">{ask}</span>
        <span className="sk-issue__where">
          {issue.where}
          {issue.note ? ` · ${issue.note}` : ""}
        </span>
      </span>
      {issue.url ? (
        <span className="sk-issue__go" aria-hidden="true">
          <Icon name="link" size={16} weight="semibold" />
        </span>
      ) : null}
    </>
  );
  return issue.url ? (
    <a className="sk-issue is-link" href={issue.url} target="_blank" rel="noopener noreferrer" aria-label={`${ask} ${issue.where}${issue.note ? `. ${issue.note}` : ""} (새 창에서 열려요)`}>
      {body}
    </a>
  ) : (
    <div className="sk-issue">{body}</div>
  );
}

/** A summary row that opens in place (the messenger sheet's fold, same motion: height on morph, content fades after). */
function Fold({ title, value, children }: { title: string; value?: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const reduce = useTierValue("reduceMotion");
  const panelId = useId();
  return (
    <div className={`sk-fold${open ? " is-open" : ""}`}>
      <button type="button" className="sk-fold__row" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen((o) => !o)}>
        <span className="sk-fold__title">{title}</span>
        {value && <span className="sk-fold__value tnum">{value}</span>}
        <span className="sk-fold__chev" aria-hidden="true">
          <Icon name="chevron-down" size={16} weight="semibold" />
        </span>
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            key="panel"
            id={panelId}
            className="sk-fold__panel"
            initial={reduce ? false : { height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1, transition: reduce ? { duration: 0 } : { height: t("morph"), opacity: { ...(t("fade") as object), delay: 0.06 } } }}
            exit={reduce ? { opacity: 0, transition: { duration: 0 } } : { height: 0, opacity: 0, transition: { height: t("morph"), opacity: { duration: 0.12 } } }}
          >
            <div className="sk-fold__inner">{children}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

const LIVE: Record<SkillState, { tone: PillTone; label: string; icon?: "info" | "clock" }> = {
  none: { tone: "neutral", label: "연결 전", icon: "info" },
  waiting: { tone: "wait", label: "연결 중" },
  connected: { tone: "ok", label: "연결됨" },
  reconnect: { tone: "error", label: "다시 연결" },
  soon: { tone: "neutral", label: "곧 연결돼요", icon: "clock" },
};

function LiveState({ state }: { state: SkillState }) {
  const l = LIVE[state];
  return (
    <span role="status" className="sk-live">
      <StatusPill tone={l.tone} icon={l.icon}>
        {l.label}
      </StatusPill>
    </span>
  );
}

function ConnectedView({ examples, onPick }: { examples: string[]; onPick: (text: string) => void }) {
  const reduce = useTierValue("reduceMotion");
  return (
    <div className="more-sheet-group sk-next">
      <SectionLabel level={3}>이제 이렇게 부탁해 보세요</SectionLabel>
      <div className="sk-next__chips">
        {examples.map((text, i) => (
          <motion.div
            key={text}
            initial={reduce ? false : { opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ y: { ...SPRING.morph, delay: 0.2 + i * 0.03 }, opacity: { ...SPRING.fade, delay: 0.2 + i * 0.03 } }}
          >
            <Chip label={text} icon="chat" onClick={() => onPick(text)} />
          </motion.div>
        ))}
      </div>
    </div>
  );
}

/** Connected: what it does, then the account and since when — words only (no icon plates, DESIGN.md) */
function ManageView({ does, connection, kind }: { does: string; connection: Connection | undefined; kind: "login" | "token" }) {
  return (
    <>
      {does ? <p className="more-sheet-lead"><Sentences text={does} /></p> : null}
      <div className="more-sheet-rows">
        <div className="more-sheet-row">
          <span className="more-sheet-row__main">
            <span className="more-sheet-row__title">{connection?.accountLabel || (kind === "login" ? "내 계정" : "저장한 키")}</span>
            <span className="more-sheet-row__sub">{kind === "login" ? "계정" : "연결한 키"}</span>
          </span>
        </div>
        {connection?.connectedAt ? (
          <div className="more-sheet-row">
            <span className="more-sheet-row__main">
              <span className="more-sheet-row__title tnum">{dateKo(connection.connectedAt)}부터</span>
              <span className="more-sheet-row__sub">{ago(connection.connectedAt)} 연결했어요</span>
            </span>
          </div>
        ) : null}
      </div>
    </>
  );
}

function DisconnectSkill({ id, name, kind, agentName, onDone, onBusy }: { id: string; name: string; kind: "login" | "token"; agentName: string; onDone: () => void; onBusy: (b: boolean) => void }) {
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    setError(null);
    onBusy(true);
    try {
      await ep.disconnect(id);
      await loadConnections();
    } catch (e) {
      setError(toApiError(e).message);
      throw e;
    } finally {
      onBusy(false);
    }
  };
  return (
    <div className="sk-disconnect">
      <Note className="sk-disconnect__note">
        <Sentences text={`연결을 해제하면 ${josa(agentName, "이가")} 더 이상 ${josa(name, "을를")} 쓰지 않아요. 저장한 ${kind === "login" ? "로그인 정보" : "키"}도 함께 지워요.`} />
      </Note>
      <InlineError>{error}</InlineError>
      {/* the check draws only after the server confirmed the revoke; then the sheet folds away */}
      <ConfirmButton label="연결 해제" tone="destructive" onConfirm={run} onSuccess={onDone} />
    </div>
  );
}

/** the "키로 연결" fold: open → rows rise in on the snap spring; close → they leave in --dur-exit, then unmount */
function useDisclosure(initialOpen = false) {
  const [state, setState] = useState<"closed" | "open" | "closing">(initialOpen ? "open" : "closed");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  const toggle = () => {
    if (timer.current) clearTimeout(timer.current);
    if (state === "open") {
      if (document.documentElement.dataset.motion === "reduce") return setState("closed");
      setState("closing");
      timer.current = setTimeout(() => setState("closed"), 140);
    } else setState("open");
  };
  return { state, toggle };
}

/** is a service the server lists as a k-skill provider (for callers outside this screen) */
export const hasSkillProvider = (id: string) => connectionsStore.get().providers.some((p) => p.id === id && isSkillProvider(p));
