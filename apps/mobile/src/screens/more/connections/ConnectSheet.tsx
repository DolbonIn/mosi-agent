import type { Connection, ConnectionVerification, ConnectResponse, KeepFor, MessengerChat, ProviderInfo } from "@pickle/protocol";
import { AnimatePresence, motion } from "framer-motion";
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { toApiError } from "../../../api/client";
import * as ep from "../../../api/endpoints";
import { onServerEvent } from "../../../api/events";
import { loadConnections, upsertConnection, useConnections } from "../../../api/store";
import { nav } from "../../../app/nav";
import { ContentSwap } from "../../../motion/ContentSwap";
import { SPRING, t } from "../../../motion/springs";
import { useTierValue } from "../../../motion/tier";
import { Button, type ButtonState } from "../../../ui/Button";
import { Chip } from "../../../ui/Chip";
import { ConfirmButton } from "../../../ui/ConfirmButton";
import { Icon } from "../../../ui/Icon";
import { SegmentedControl } from "../../../ui/SegmentedControl";
import { Sheet } from "../../../ui/Sheet";
import { TextField } from "../../../ui/TextField";
import { ago, dateKo, josa, KEEP_FOR, keepForLabel } from "../format";
import { copyOf, InlineError, Lead, Note, SectionLabel, useAgentName, useUserId } from "../parts";
import { useDiscordLogin } from "./DiscordLogin";
import { Passcode } from "./Passcode";
import { autocompleteFor, CANNOT_LINE, CAPABILITY, CAPABILITY_SHORT, CHAT_KIND, examplesFor, inputModeFor, sealKind } from "./providerCopy";
import { useSlackLogin } from "./SlackLogin";
import { useTelegramLogin } from "./TelegramLogin";

/**
 * Connect sheet (MOTION-SPEC §6.7, research §4-7): morphs out of the provider row. The form is built from the
 * provider's fields; the secret is sealed ON THE DEVICE for the enclave (sealCredential) before it leaves. Then:
 *   display_code → the big passcode + a countdown ring with the real remaining time; polls POST /verify {} every 3 s
 *                  and listens for the `connection` event
 *   enter_code   → one code field → POST /verify {code}
 *   connected    → the status pill morphs into "연결됨" (the check draws) + prompts that need this connection
 * Draft connections B: the title reads from the leading edge, the live pill sits under it (no icon plate); the inputs
 * come first, the sealing sentence is the secret field's own hint (said once per flow), and what the agent can do and
 * how long the login is kept are two summary rows that open in place.
 * A failed login is 200 with status "error" and a Korean lastError — shown inline, inputs kept. The sheet refuses to
 * close while a request the person started is in flight. A provider that is already connected opens the manage
 * view instead: account, recent chats, 연결 해제 (hold or tap twice).
 *
 * Providers that sign in through the login relay (`provider.login`) show that flow instead of the form — no token:
 *   relay_code  → SlackLogin (email code / password, "고급: 토큰 직접 입력" falls back to this sheet's token form)
 *   remote_auth → DiscordLogin (approve in the Discord app / scan the QR)
 *   phone_code  → TelegramLogin (phone → code → 2FA password)
 * The relay hands the finished connection back here (becomeConnected); closing the sheet cancels the relay.
 */

type Phase = "form" | "verify" | "connected";

export interface ConnectSheetProps {
  provider: ProviderInfo;
  source: HTMLElement | null;
  open: boolean;
  onClose: () => void;
  onClosed: () => void;
}

export function ConnectSheet({ provider, source, open, onClose, onClosed }: ConnectSheetProps) {
  const { connections } = useConnections();
  const connection = connections.find((c) => c.provider === provider.id);
  const userId = useUserId();
  const agentName = useAgentName();
  const [manage] = useState(() => connection?.status === "connected");
  const [values, setValues] = useState<Record<string, string>>({});
  const [keepFor, setKeepFor] = useState<KeepFor>("30d");
  const [phase, setPhase] = useState<Phase>("form");
  const [verification, setVerification] = useState<ConnectionVerification | null>(null);
  const [btn, setBtn] = useState<ButtonState>("idle");
  const [error, setError] = useState<string | null>(connection?.status === "error" ? connection.lastError : null);
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState("");
  const [expired, setExpired] = useState(false);
  const [doneLabel, setDoneLabel] = useState(false);
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true; // StrictMode re-runs effects: set it again on every mount
    return () => {
      mounted.current = false;
    };
  }, []);

  const oauth = provider.auth === "oauth" || provider.auth === "none";
  // the sealing sentence goes under the last secret field (the password, or a bot's token)
  const secretKey = [...provider.fields].reverse().find((f) => f.type === "password")?.key;
  const missing = !oauth && provider.fields.some((f) => !(values[f.key] ?? "").trim());

  const becomeConnected = useCallback(() => {
    if (phaseRef.current === "connected") return;
    setPhase("connected");
    setError(null);
    setBtn("success");
    setTimeout(() => {
      if (mounted.current) {
        setBtn("idle");
        setDoneLabel(true);
      }
    }, 1200);
  }, []);

  // login relay providers: the relay flow replaces the form (Slack can still fall back to the token paste)
  const relayKind = provider.login === "relay_code" ? "slack" : provider.login === "remote_auth" ? "discord" : provider.login === "phone_code" ? "telegram" : null;
  const [tokenForm, setTokenForm] = useState(false);
  const onRelayConnected = useCallback(
    (c: Connection) => {
      upsertConnection(c);
      becomeConnected();
    },
    [becomeConnected],
  );
  const abilities = <Abilities provider={provider} />;
  const slackLogin = useSlackLogin({
    userId,
    intro: relayKind === "slack" ? abilities : undefined,
    initialError: relayKind === "slack" ? error : null,
    onConnected: onRelayConnected,
    onAdvanced: () => setTokenForm(true),
  });
  const discordLogin = useDiscordLogin({ userId, enabled: relayKind === "discord" && !manage, intro: abilities, onConnected: onRelayConnected });
  const telegramLogin = useTelegramLogin({ userId, enabled: relayKind === "telegram" && !manage, intro: abilities, onConnected: onRelayConnected });
  const relay =
    manage || phase !== "form" || tokenForm ? null : relayKind === "slack" ? slackLogin : relayKind === "discord" ? discordLogin : relayKind === "telegram" ? telegramLogin : null;

  /** fold a server answer (connect / verify / event) into the sheet */
  const apply = useCallback(
    (c: Connection, v?: ConnectionVerification | null) => {
      upsertConnection(c);
      switch (c.status) {
        case "connected":
          becomeConnected();
          return;
        case "needs_verification":
          if (v) setVerification(v);
          setPhase("verify");
          setBtn("idle");
          // enter_code: a wrong code comes back here with a Korean lastError
          setError(c.lastError ?? null);
          return;
        case "error":
          setPhase("form");
          setVerification(null);
          setError(c.lastError || "연결하지 못했어요. 입력한 정보를 확인하고 다시 시도해 주세요.");
          setBtn("error");
          return;
        case "connecting":
          setBtn("loading");
          return;
        case "disconnected":
          if (phaseRef.current !== "form") {
            setPhase("form");
            setVerification(null);
            setBtn("idle");
          }
          return;
      }
    },
    [becomeConnected],
  );

  const applyRes = useCallback((res: ConnectResponse) => apply(res.connection, res.verification ?? null), [apply]);

  // reopened while a display-code wait was pending: ask the server for the code again
  useEffect(() => {
    if (manage || connection?.status !== "needs_verification") return;
    let stop = false;
    ep.verifyConnection(provider.id, "")
      .then((res) => {
        if (!stop) applyRes(res);
      })
      .catch(() => {});
    return () => {
      stop = true;
    };
    // once, on open
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // live: the server pushes `connection` when the phone confirms (or the login fails)
  useEffect(
    () =>
      onServerEvent((e) => {
        if (e.type !== "connection" || e.connection.provider !== provider.id || manage) return;
        if (phaseRef.current === "form" && e.connection.status === "needs_verification") return; // the POST answer carries the code
        apply(e.connection);
      }),
    [provider.id, apply, manage],
  );

  // display_code: poll POST /verify {} every 3 s while the code is on screen
  useEffect(() => {
    if (phase !== "verify" || verification?.kind !== "display_code" || expired || !open) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        const res = await ep.verifyConnection(provider.id, "");
        if (stop) return;
        applyRes(res);
      } catch (e) {
        if (stop) return;
        const err = toApiError(e);
        if (err.status >= 400 && err.status < 500) {
          setPhase("form");
          setVerification(null);
          setError(err.message);
          return;
        }
      }
      if (!stop && phaseRef.current === "verify") timer = setTimeout(tick, 3000);
    };
    timer = setTimeout(tick, 3000);
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [phase, verification, expired, open, provider.id, applyRes]);

  const submit = async () => {
    if (busy || missing) return;
    setError(null);
    setExpired(false);
    setBtn("loading");
    setBusy(true);
    try {
      let res: ConnectResponse;
      if (oauth) {
        res = await ep.connect(provider.id, {});
      } else {
        if (!userId) throw new Error("no session");
        const fields: Record<string, string> = {};
        for (const f of provider.fields) fields[f.key] = f.type === "password" ? values[f.key] ?? "" : (values[f.key] ?? "").trim();
        const credential = await ep.sealCredential({ userId, service: provider.id, label: provider.name, kind: sealKind(provider), keepFor, fields });
        credential.label = credential.hint ? `${provider.name} (${credential.hint})` : provider.name;
        res = await ep.connect(provider.id, { credential });
      }
      if (mounted.current) applyRes(res);
    } catch (e) {
      if (!mounted.current) return;
      setError(toApiError(e).message);
      setBtn("error");
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const submitCode = async () => {
    const clean = code.replace(/[\s-]/g, "");
    if (busy || !clean) return;
    setError(null);
    setBtn("loading");
    setBusy(true);
    try {
      const res = await ep.verifyConnection(provider.id, clean);
      if (mounted.current) applyRes(res);
    } catch (e) {
      if (!mounted.current) return;
      setError(toApiError(e).message);
      setBtn("error");
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const restart = () => {
    setPhase("form");
    setVerification(null);
    setExpired(false);
    setCode("");
    void submit();
  };

  const footer = manage ? (
    <DisconnectButton provider={provider} agentName={agentName} onDone={onClose} onBusy={setBusy} />
  ) : relay ? (
    relay.footer
  ) : phase === "form" ? (
    <div className="conn-footer">
      <InlineError>{error}</InlineError>
      <Button fullWidth state={btn} disabled={missing} onClick={submit} busyLabel="연결하는 중" successLabel="연결했어요" errorLabel="다시 연결하기">
        {oauth ? "코드 받기" : "연결하기"}
      </Button>
    </div>
  ) : phase === "verify" ? (
    verification?.kind === "enter_code" ? (
      <Button fullWidth state={btn} disabled={!code.trim()} onClick={submitCode} busyLabel="확인하는 중" successLabel="연결했어요" errorLabel="다시 확인하기">
        확인하기
      </Button>
    ) : expired ? (
      <Button fullWidth state={btn} onClick={restart} busyLabel="연결하는 중">
        다시 연결하기
      </Button>
    ) : null
  ) : (
    <Button fullWidth tone={doneLabel ? "secondary" : "primary"} state={btn} holdSuccess onClick={doneLabel ? onClose : undefined} successLabel="연결했어요">
      완료
    </Button>
  );

  return (
    <Sheet open={open} onClose={onClose} onClosed={onClosed} source={source} title={provider.name} titleAlign="start" busy={busy || !!relay?.busy} footer={footer} className="conn-sheet">
      <div className="more-sheet">
        <div className="conn-sheet-status">
          <LivePill
            status={
              phase === "connected"
                ? "connected"
                : manage
                  ? connection?.status
                  : relay
                    ? relay.status
                    : phase === "verify"
                      ? "needs_verification"
                      : btn === "loading"
                        ? "connecting"
                        : connection?.status === "error" || error
                          ? "error"
                          : undefined
            }
          />
          {connection?.accountLabel && <span className="conn-sheet-account">{connection.accountLabel}</span>}
        </div>

        {manage ? (
          <ManageView provider={provider} connection={connection} />
        ) : relay ? (
          relay.body
        ) : phase === "connected" ? (
          <ConnectedView provider={provider} onPick={(text) => {
            onClose();
            nav.compose(text);
          }} />
        ) : phase === "verify" && verification ? (
          verification.kind === "display_code" ? (
            <>
              <Passcode verification={verification} onExpired={() => setExpired(true)} />
              <InlineError>{error}</InlineError>
            </>
          ) : (
            <div className="more-sheet-group">
              <Lead>{verification.prompt}</Lead>
              <TextField
                label="인증 코드"
                value={code}
                onChange={(v) => setCode(v.replace(/[^\dA-Za-z-\s]/g, ""))}
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={verification.length ?? 8}
                error={error ?? undefined}
                onEnter={submitCode}
                autoFocus
              />
            </div>
          )
        ) : (
          <>
            <Lead>{provider.description}</Lead>
            {!oauth && (
              <form
                className="conn-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  void submit();
                }}
              >
                {provider.fields.map((f, i) => (
                  <TextField
                    key={f.key}
                    label={f.label}
                    type={f.type}
                    value={values[f.key] ?? ""}
                    onChange={(v) => {
                      setValues((s) => ({ ...s, [f.key]: v }));
                      if (btn === "error") setBtn("idle");
                    }}
                    placeholder={f.placeholder}
                    hint={
                      f.key === secretKey ? (
                        <span className="conn-lockhint">
                          <Icon name="lock" size={14} weight="medium" />
                          <span className="t-copy">{copyOf(`입력한 정보는 이 기기에서 암호화한 뒤에만 보내요. ${agentName}도 서버 운영자도 원문을 볼 수 없어요.`)}</span>
                        </span>
                      ) : (
                        f.hint
                      )
                    }
                    autoComplete={autocompleteFor(f)}
                    inputMode={inputModeFor(f)}
                    autoCapitalize="none"
                    enterKeyHint={i === provider.fields.length - 1 ? "go" : "next"}
                    onEnter={i === provider.fields.length - 1 ? () => void submit() : undefined}
                    name={`${provider.id}-${f.key}`}
                    disabled={busy}
                  />
                ))}
              </form>
            )}
            <div className="conn-folds">
              <Abilities provider={provider} />
              {!oauth && (
                <Fold title="로그인 정보 보관" value={keepForLabel(keepFor)}>
                  <SegmentedControl role="radiogroup" size="sm" label="로그인 정보 보관 기간" value={keepFor} onChange={setKeepFor} options={KEEP_FOR} />
                </Fold>
              )}
            </div>
            {tokenForm && relayKind === "slack" && (
              <button type="button" className="slk-link slk-back" onClick={() => setTokenForm(false)} disabled={busy}>
                Slack 로그인으로 돌아가기
              </button>
            )}
            {oauth ? (
              <Note icon="lock">{provider.name} 로그인은 Microsoft 화면에서 직접 해요. 비밀번호는 모시에 전달되지 않아요.</Note>
            ) : !secretKey ? (
              <Note icon="lock">입력한 정보는 이 기기에서 암호화한 뒤에만 보내요. {agentName}도 서버 운영자도 원문을 볼 수 없어요.</Note>
            ) : null}
          </>
        )}
      </div>
    </Sheet>
  );
}

/**
 * "깽이가 할 수 있는 일" — the permission scope as one summary row (research 7-5, draft B): its subtitle already says
 * all of it ("목록 보기 · 읽기 · … 친구 추가·삭제나 설정은 바꾸지 않아요."); opened, the same four read as a checked
 * column closed by the one "never" line. Also the relay sheets' intro.
 */
function Abilities({ provider }: { provider: ProviderInfo }) {
  const agentName = useAgentName();
  return (
    <Fold title={`${josa(agentName, "이가")} 할 수 있는 일`} sub={`${provider.capabilities.map((c) => CAPABILITY_SHORT[c]).join(" · ")}. ${CANNOT_LINE}`}>
      <ul className="conn-can">
        {provider.capabilities.map((c) => (
          <li key={c}>
            <Icon name="checkmark" size={15} weight="semibold" />
            <span>{CAPABILITY[c]}</span>
          </li>
        ))}
        <li className="is-not">{CANNOT_LINE}</li>
      </ul>
    </Fold>
  );
}

/**
 * A summary row that opens in place (the sheet's version of the "고급" fold): the panel's height follows on the morph
 * spring and its content fades in after it; the chevron turns on snap. Opened, the subtitle gives way to the panel
 * (it said the same thing, short). Reduced motion: opens and closes at once.
 */
function Fold({ title, sub, value, children }: { title: string; sub?: string; value?: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const reduce = useTierValue("reduceMotion");
  const panelId = useId();
  return (
    <div className={`conn-fold${open ? " is-open" : ""}`}>
      <button type="button" className="conn-fold__row" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen((o) => !o)}>
        <span className="conn-fold__main">
          <span className="conn-fold__title">{title}</span>
          {sub && !open && <span className="conn-fold__sub t-copy">{copyOf(sub)}</span>}
        </span>
        {value && <span className="conn-fold__value tnum">{value}</span>}
        <span className="conn-fold__chev" aria-hidden="true">
          <Icon name="chevron-down" size={16} weight="semibold" />
        </span>
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            key="panel"
            id={panelId}
            className="conn-fold__panel"
            initial={reduce ? false : { height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1, transition: reduce ? { duration: 0 } : { height: t("morph"), opacity: { ...(t("fade") as object), delay: 0.06 } } }}
            exit={reduce ? { opacity: 0, transition: { duration: 0 } } : { height: 0, opacity: 0, transition: { height: t("morph"), opacity: { duration: 0.12 } } }}
          >
            <div className="conn-fold__inner">{children}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** The status capsule in the sheet head: its width morphs, the words swap, the check draws on "연결됨". */
function LivePill({ status }: { status: Connection["status"] | undefined }) {
  const reduce = useTierValue("reduceMotion");
  if (!status || status === "disconnected")
    return (
      <span className="conn-livepill conn-livepill--none">
        <span className="conn-livepill__icon" aria-hidden="true">
          <Icon name="info" size={14} weight="semibold" />
        </span>
        연결 전
      </span>
    );
  const tone = status === "connected" ? "ok" : status === "error" ? "error" : "wait";
  const label = status === "connected" ? "연결됨" : status === "connecting" ? "연결 중" : status === "needs_verification" ? "확인 기다리는 중" : "연결 안 됨";
  return (
    <motion.span layout transition={{ layout: t("morph") }} className={`conn-livepill conn-livepill--${tone}`} role="status">
      <span className="conn-livepill__icon" aria-hidden="true">
        {tone === "ok" ? (
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <circle cx="8" cy="8" r="7" stroke="currentColor" strokeWidth="1.6" />
            <motion.path
              d="M4.8 8.3l2.2 2.2 4.2-4.6"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              initial={reduce ? false : { pathLength: 0 }}
              animate={{ pathLength: 1 }}
              transition={reduce ? { duration: 0 } : { ...SPRING.snap, delay: 0.12 }}
            />
          </svg>
        ) : tone === "error" ? (
          <Icon name="exclamation" size={15} weight="semibold" />
        ) : (
          <span className="conn-livepill__ring" data-loop={status === "connecting" ? "busy" : undefined} />
        )}
      </span>
      <ContentSwap swapKey={label}>{label}</ContentSwap>
    </motion.span>
  );
}

function ConnectedView({ provider, onPick }: { provider: ProviderInfo; onPick: (text: string) => void }) {
  const reduce = useTierValue("reduceMotion");
  return (
    <div className="more-sheet-group conn-next">
      <SectionLabel level={3}>이제 이렇게 부탁해 보세요</SectionLabel>
      <div className="conn-next__chips">
        {examplesFor(provider).map((text, i) => (
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

/** Already connected: who, since when, the latest chats, and how to disconnect. */
function ManageView({ provider, connection }: { provider: ProviderInfo; connection: Connection | undefined }) {
  const [chats, setChats] = useState<MessengerChat[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let stop = false;
    ep.chats(provider.id)
      .then((list) => {
        if (!stop) setChats(list.slice(0, 5));
      })
      .catch((e) => {
        if (!stop) setError(toApiError(e).message);
      });
    return () => {
      stop = true;
    };
  }, [provider.id]);

  return (
    <>
      <div className="more-sheet-rows">
        <div className="more-sheet-row">
          <span className="more-sheet-row__icon">
            <Icon name="person" size={17} weight="medium" />
          </span>
          <span className="more-sheet-row__main">
            <span className="more-sheet-row__title">{connection?.accountLabel ?? "내 계정"}</span>
            <span className="more-sheet-row__sub">계정</span>
          </span>
        </div>
        {connection?.connectedAt ? (
          <div className="more-sheet-row">
            <span className="more-sheet-row__icon">
              <Icon name="clock" size={17} weight="medium" />
            </span>
            <span className="more-sheet-row__main">
              <span className="more-sheet-row__title tnum">{dateKo(connection.connectedAt)}부터</span>
              <span className="more-sheet-row__sub">{ago(connection.connectedAt)} 연결했어요</span>
            </span>
          </div>
        ) : null}
      </div>

      <div className="more-sheet-group">
        <SectionLabel level={3}>최근 대화</SectionLabel>
        {error ? (
          <Note icon="info">{error}</Note>
        ) : chats === null ? (
          <div className="conn-chats-placeholder" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
        ) : chats.length === 0 ? (
          <Note icon="info">아직 불러올 대화가 없어요.</Note>
        ) : (
          <ul className="more-sheet-rows conn-chats" aria-label={`${provider.name} 최근 대화`}>
            {chats.map((c) => (
              <li key={c.id} className="more-sheet-row">
                <span className="more-sheet-row__icon">
                  <Icon name={c.kind === "dm" ? "person" : "people"} size={17} weight="medium" />
                </span>
                <span className="more-sheet-row__main">
                  <span className="more-sheet-row__title">
                    {c.name} <span className="conn-chat-kind">{CHAT_KIND[c.kind]}</span>
                  </span>
                  {c.lastMessage && <span className="more-sheet-row__sub conn-chat-last">{c.lastMessage}</span>}
                </span>
                <span className="conn-chat-meta">
                  {c.lastAt ? <span className="tnum">{ago(c.lastAt)}</span> : null}
                  {c.unread ? (
                    <span className="conn-unread tnum" aria-label={`안 읽은 메시지 ${c.unread}개`}>
                      {c.unread > 99 ? "99+" : c.unread}
                    </span>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

function DisconnectButton({ provider, agentName, onDone, onBusy }: { provider: ProviderInfo; agentName: string; onDone: () => void; onBusy: (b: boolean) => void }) {
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    setError(null);
    onBusy(true);
    try {
      await ep.disconnect(provider.id);
      await loadConnections();
    } catch (e) {
      setError(toApiError(e).message);
      throw e;
    } finally {
      onBusy(false);
    }
  };
  return (
    <div className="conn-disconnect">
      <Note className="conn-disconnect__note">
        연결을 해제하면 {josa(agentName, "이가")} {provider.name}에서 더 이상 대화를 읽거나 보낼 수 없어요. 저장된 로그인 정보는 &lsquo;저장된 로그인&rsquo;에서 따로 지울 수 있어요.
      </Note>
      <InlineError>{error}</InlineError>
      {/* the check draws only after the server confirmed; then the sheet folds away */}
      <ConfirmButton label="연결 해제" tone="destructive" onConfirm={run} onSuccess={onDone} />
    </div>
  );
}
