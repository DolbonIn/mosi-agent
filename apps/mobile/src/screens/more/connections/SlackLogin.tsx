import type { Connection, LoginRelayResponse, LoginRelayWorkspace } from "@pickle/protocol";
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { isAborted, toApiError } from "../../../api/client";
import * as ep from "../../../api/endpoints";
import { Button } from "../../../ui/Button";
import { Icon } from "../../../ui/Icon";
import { TextField } from "../../../ui/TextField";
import { InlineError, Lead, Note } from "../parts";
import "./SlackLogin.css";

/**
 * "Slack 로그인" inside the connect sheet: the person signs in with their own Slack account and the server keeps only
 * the resulting session (POST /api/connections/slack/login → /step, see SERVER-CONTRACT "Slack 로그인 릴레이").
 *
 *   form        workspace (optional) + email  → "코드 받기"      (or email + password → "로그인")
 *   code        the 6 characters Slack emailed (one-time-code field, auto-submits when full)
 *   password    the workspace only signs in with a password
 *   totp        two-factor code (authenticator / SMS)
 *   workspaces  several workspaces: tap one
 *   → connected: handed back to ConnectSheet (its pill morphs to 연결됨 and the example prompts appear)
 *
 * Every typed value is sealed on this device for the enclave (sealRelayInput) before it leaves; the server opens it
 * only to type it into Slack and never stores it. Each server step can take several seconds (a real browser signs in
 * on the server), so the primary button shows what is happening in words. Closing the sheet cancels the relay.
 */

type Step = "form" | "code" | "password" | "totp" | "workspaces";

export interface SlackLogin {
  step: Step;
  busy: boolean;
  /** for the sheet's live pill */
  status: "connecting" | "needs_verification" | "error" | undefined;
  body: ReactNode;
  footer: ReactNode;
}

const PROVIDER = "slack";
/** after these the token paste is the way forward, so it is offered right under the message */
const OFFER_ADVANCED = new Set(["sso_unsupported", "captcha", "browser_unavailable", "relay_unavailable", "token_not_found", "upstream"]);

interface RelayRef {
  id: string;
  codeLength: number;
}

export function useSlackLogin({
  userId,
  intro,
  initialError,
  onConnected,
  onAdvanced,
}: {
  userId: string | null;
  /** shown under the lead on the first screen (the sheet's "할 수 있는 일 / 할 수 없는 일") */
  intro?: ReactNode;
  initialError?: string | null;
  onConnected: (c: Connection) => void;
  onAdvanced: () => void;
}): SlackLogin {
  const [step, setStep] = useState<Step>("form");
  const [method, setMethod] = useState<"code" | "password">("code");
  const [workspace, setWorkspace] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [relay, setRelay] = useState<RelayRef | null>(null);
  const [workspaces, setWorkspaces] = useState<LoginRelayWorkspace[]>([]);
  const [picked, setPicked] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<{ code?: string; message: string } | null>(initialError ? { message: initialError } : null);

  const relayRef = useRef<RelayRef | null>(null);
  relayRef.current = relay;
  const busyRef = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      // the sheet closed mid-login: close the server browser now instead of waiting for the 5-minute timeout
      const r = relayRef.current;
      if (r) void ep.loginRelayCancel(PROVIDER, r.id).catch(() => {});
    };
  }, []);

  const apply = useCallback(
    (res: LoginRelayResponse) => {
      if (!mounted.current) return;
      const next: RelayRef = { id: res.relayId, codeLength: res.codeLength ?? 6 };
      switch (res.state) {
        case "connected":
          setRelay(null);
          relayRef.current = null;
          setError(null);
          if (res.connection) onConnected(res.connection);
          return;
        case "error":
        case "expired":
        case "cancelled":
          setRelay(null);
          relayRef.current = null;
          setStep("form");
          setCode("");
          setPicked(null);
          setError(res.error ?? { message: "Slack 로그인을 마치지 못했어요. 다시 해 주세요." });
          return;
        case "needs_code":
        case "needs_2fa":
          setRelay(next);
          setStep(res.state === "needs_code" ? "code" : "totp");
          setCode("");
          break;
        case "needs_password":
          setRelay(next);
          setStep("password");
          break;
        case "workspaces":
          setRelay(next);
          setWorkspaces(res.workspaces ?? []);
          setPicked(null);
          setStep("workspaces");
          break;
      }
      // a wrong code/password comes back with the same step and a message
      setError(res.error ?? null);
    },
    [onConnected],
  );

  const run = useCallback(
    async (label: string, work: () => Promise<LoginRelayResponse>) => {
      if (busyRef.current || !userId) return;
      busyRef.current = true;
      setBusy(label);
      setError(null);
      try {
        apply(await work());
      } catch (e) {
        if (!mounted.current || isAborted(e)) return;
        const err = toApiError(e);
        if (err.code === "relay_not_found") {
          setRelay(null);
          setStep("form");
        }
        setError({ code: err.code, message: err.message });
      } finally {
        busyRef.current = false;
        if (mounted.current) setBusy(null);
      }
    },
    [apply, userId],
  );

  const seal = (tail: string, fields: Record<string, string>) => ep.sealRelayInput(userId ?? "", PROVIDER, tail, fields);

  const start = () =>
    run(method === "password" ? "Slack에 로그인하는 중" : "코드 보내는 중", async () => {
      const res = await ep.loginRelayStart(PROVIDER, {
        provider: "slack",
        workspace: workspace.trim() || undefined,
        method,
        email: await seal("start", { email: email.trim() }),
      });
      // email + password on the first screen: send the password right away
      if (res.state === "needs_password" && method === "password" && password) {
        return ep.loginRelayStep(PROVIDER, { relayId: res.relayId, password: await seal(res.relayId, { password }) });
      }
      return res;
    });

  const submitCode = (value: string) => {
    const r = relayRef.current;
    const clean = value.replace(/[\s-]/g, "").toUpperCase();
    if (!r || clean.length !== r.codeLength) return;
    void run("확인하는 중", async () =>
      step === "totp"
        ? ep.loginRelayStep(PROVIDER, { relayId: r.id, totp: await seal(r.id, { totp: clean }) })
        : ep.loginRelayStep(PROVIDER, { relayId: r.id, code: await seal(r.id, { code: clean }) }),
    );
  };

  const submitPassword = () => {
    const r = relayRef.current;
    if (!r || !password) return;
    void run("로그인하는 중", async () => ep.loginRelayStep(PROVIDER, { relayId: r.id, password: await seal(r.id, { password }) }));
  };

  const pick = (id: string) => {
    const r = relayRef.current;
    if (!r) return;
    setPicked(id);
    void run("연결하는 중", () => ep.loginRelayStep(PROVIDER, { relayId: r.id, teamId: id }));
  };

  const restart = () => {
    const r = relayRef.current;
    if (r) void ep.loginRelayCancel(PROVIDER, r.id).catch(() => {});
    setRelay(null);
    relayRef.current = null;
    setStep("form");
    setCode("");
    setPassword("");
    setPicked(null);
    setError(null);
  };

  const formReady = !!email.trim() && (method === "code" || (!!workspace.trim() && !!password));
  const offerAdvanced = step === "form" && !!error?.code && OFFER_ADVANCED.has(error.code);

  // ── body ──
  let body: ReactNode;
  if (step === "form") {
    body = (
      <>
        <Lead>Slack 계정으로 로그인하면 바로 연결돼요. 메일로 받은 코드로 로그인해서 비밀번호는 필요 없어요.</Lead>
        {intro}
        <form
          className="conn-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (formReady) void start();
          }}
        >
          <TextField
            label={method === "code" ? "워크스페이스 주소 (선택)" : "워크스페이스 주소"}
            hint={method === "code" ? "비워 두면 이메일로 내 워크스페이스를 찾아요." : undefined}
            placeholder="예: sionic.slack.com"
            value={workspace}
            onChange={setWorkspace}
            autoComplete="off"
            inputMode="url"
            autoCapitalize="none"
            enterKeyHint="next"
            name="slack-workspace"
            disabled={!!busy}
          />
          <TextField
            label="이메일"
            type="email"
            placeholder="name@company.com"
            value={email}
            onChange={setEmail}
            autoComplete="username"
            inputMode="email"
            autoCapitalize="none"
            enterKeyHint={method === "password" ? "next" : "go"}
            onEnter={method === "code" && formReady ? () => void start() : undefined}
            name="slack-email"
            disabled={!!busy}
          />
          {method === "password" && (
            <TextField
              label="Slack 비밀번호"
              type="password"
              value={password}
              onChange={setPassword}
              autoComplete="current-password"
              autoCapitalize="none"
              enterKeyHint="go"
              onEnter={formReady ? () => void start() : undefined}
              name="slack-password"
              disabled={!!busy}
            />
          )}
        </form>
        <div className="slk-links">
          <button
            type="button"
            className="slk-link"
            disabled={!!busy}
            onClick={() => {
              setMethod((m) => (m === "code" ? "password" : "code"));
              setPassword("");
              setError(null);
            }}
          >
            {method === "code" ? "비밀번호로 로그인할게요" : "메일 코드로 로그인할게요"}
          </button>
        </div>
        <Note icon="lock">입력한 이메일·코드·비밀번호는 이 기기에서 암호화돼 Slack 로그인에만 쓰이고 저장되지 않아요. 보안 금고에는 연결 정보만 보관해요.</Note>
        <button type="button" className="slk-advanced" onClick={onAdvanced} disabled={!!busy}>
          <span>고급: 토큰 직접 입력</span>
          <Icon name="chevron-right" size={14} weight="semibold" />
        </button>
      </>
    );
  } else if (step === "code" || step === "totp") {
    body = (
      <div className="more-sheet-group">
        {step === "code" ? (
          <Lead>
            Slack이 <strong className="slk-email">{email.trim()}</strong> 주소로 코드 {relay?.codeLength ?? 6}자리를 보냈어요. 메일을 열고 코드를 입력해 주세요.
          </Lead>
        ) : (
          <Lead>2단계 인증을 켠 계정이에요. 인증 앱이나 문자로 받은 숫자 6자리를 입력해 주세요.</Lead>
        )}
        <OtpField
          key={step}
          label={step === "code" ? "메일로 받은 코드 6자리" : "인증 코드 6자리"}
          length={relay?.codeLength ?? 6}
          numeric={step === "totp"}
          value={code}
          onChange={(v) => {
            setCode(v);
            if (error) setError(null);
          }}
          onComplete={submitCode}
          error={error?.message}
          disabled={!!busy}
        />
        {step === "code" && <Note icon="mail">메일이 안 보이면 스팸함도 확인해 주세요. 5분 안에 입력해야 해요.</Note>}
      </div>
    );
  } else if (step === "password") {
    body = (
      <div className="more-sheet-group">
        <Lead>이 워크스페이스는 비밀번호로 로그인해요. Slack 비밀번호를 입력해 주세요.</Lead>
        <TextField
          label="Slack 비밀번호"
          type="password"
          value={password}
          onChange={(v) => {
            setPassword(v);
            if (error) setError(null);
          }}
          autoComplete="current-password"
          autoCapitalize="none"
          enterKeyHint="go"
          onEnter={submitPassword}
          name="slack-password"
          error={error?.message}
          disabled={!!busy}
          autoFocus
        />
      </div>
    );
  } else {
    body = (
      <div className="more-sheet-group">
        <Lead>어느 워크스페이스를 연결할까요?</Lead>
        <ul className="more-sheet-rows slk-ws" aria-label="Slack 워크스페이스">
          {workspaces.map((w) => {
            const loading = picked === w.id && !!busy;
            return (
              <li key={w.id}>
                <button type="button" className="more-sheet-row slk-ws__row" disabled={!!busy} aria-busy={loading || undefined} onClick={() => pick(w.id)}>
                  <span className="more-sheet-row__main">
                    <span className="more-sheet-row__title">{w.name}</span>
                    {w.domain && <span className="more-sheet-row__sub">{w.domain}</span>}
                  </span>
                  {loading ? <span className="slk-spin" aria-hidden="true" /> : <Icon name="chevron-right" size={16} weight="semibold" />}
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    );
  }

  // ── footer ──
  const primary =
    step === "form"
      ? { label: method === "password" ? "로그인" : "코드 받기", disabled: !formReady, onClick: () => void start() }
      : step === "code" || step === "totp"
        ? { label: "확인", disabled: code.replace(/[\s-]/g, "").length !== (relay?.codeLength ?? 6), onClick: () => submitCode(code) }
        : step === "password"
          ? { label: "로그인", disabled: !password, onClick: submitPassword }
          : null;

  const footer = (
    <div className="conn-footer slk-footer">
      {(step === "form" || step === "workspaces") && <InlineError>{error?.message}</InlineError>}
      <span className="sr-only" role="status" aria-live="polite">
        {busy ?? ""}
      </span>
      {offerAdvanced && (
        <Button fullWidth tone="primary" onClick={onAdvanced}>
          토큰 직접 입력으로 연결하기
        </Button>
      )}
      {primary && (
        <Button fullWidth tone={offerAdvanced ? "neutral" : "primary"} disabled={primary.disabled && !busy} onClick={busy ? undefined : primary.onClick} className={busy ? "slk-busy" : undefined}>
          {busy ? (
            <span className="slk-progress">
              <span className="slk-spin" aria-hidden="true" />
              {busy}
            </span>
          ) : (
            primary.label
          )}
        </Button>
      )}
      {step !== "form" && (
        <button type="button" className="slk-link slk-restart" onClick={restart} disabled={!!busy}>
          처음부터 다시
        </button>
      )}
    </div>
  );

  const status: SlackLogin["status"] = busy ? "connecting" : step !== "form" ? "needs_verification" : error ? "error" : undefined;
  return { step, busy: !!busy, status, body, footer };
}

/**
 * One-time code: ONE real input (autocomplete="one-time-code", so iOS/Android offer the code from Mail/SMS) laid over
 * visual cells. Letters are upper-cased, a pasted "ABC-123" is accepted, it submits itself when full.
 */
export function OtpField({
  label,
  length,
  numeric,
  value,
  onChange,
  onComplete,
  error,
  disabled,
}: {
  label: string;
  length: number;
  numeric?: boolean;
  value: string;
  onChange: (v: string) => void;
  onComplete: (v: string) => void;
  error?: string;
  disabled?: boolean;
}) {
  const id = `otp-${useId().replace(/:/g, "")}`;
  const ref = useRef<HTMLInputElement | null>(null);
  const [focused, setFocused] = useState(false);
  // a wrong code re-enables the field: put the caret back so the next try is just typing
  useEffect(() => {
    if (!disabled) ref.current?.focus({ preventScroll: true });
  }, [disabled]);
  const clean = (v: string) => (numeric ? v.replace(/\D/g, "") : v.replace(/[^0-9A-Za-z]/g, "").toUpperCase()).slice(0, length);
  const chars = value.split("");
  const active = Math.min(value.length, length - 1);
  return (
    <div className={`slk-otp${error ? " is-invalid" : ""}${disabled ? " is-disabled" : ""}${focused ? " is-focused" : ""}`}>
      <label htmlFor={id} className="tf-label">
        {label}
      </label>
      <div className="slk-otp__box" data-len={length}>
        <input
          id={id}
          ref={ref}
          className="slk-otp__input"
          value={value}
          onChange={(e) => {
            const v = clean(e.target.value);
            onChange(v);
            if (v.length === length) onComplete(v);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing && value.length === length) onComplete(value);
          }}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          name="one-time-code"
          autoComplete="one-time-code"
          inputMode={numeric ? "numeric" : "text"}
          pattern={numeric ? "[0-9]*" : undefined}
          autoCapitalize={numeric ? "off" : "characters"}
          autoCorrect="off"
          spellCheck={false}
          maxLength={length + 2}
          enterKeyHint="done"
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-err` : undefined}
          disabled={disabled}
          autoFocus
        />
        <div className="slk-otp__cells" aria-hidden="true">
          {Array.from({ length }, (_, i) => (
            <span key={i} className={`slk-otp__cell${chars[i] ? " is-filled" : ""}${focused && i === active ? " is-active" : ""}`}>
              {chars[i] ?? ""}
            </span>
          ))}
        </div>
      </div>
      {error && (
        <p id={`${id}-err`} className="more-error" role="alert">
          <Icon name="exclamation" size={15} weight="semibold" />
          <span>{error}</span>
        </p>
      )}
    </div>
  );
}
