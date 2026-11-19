import { useCallback, useId, useRef, useState } from "react";
import { ContentSwap } from "../../../motion/ContentSwap";
import { Button, type ButtonState } from "../../../ui/Button";
import { ConfirmButton } from "../../../ui/ConfirmButton";
import { Icon } from "../../../ui/Icon";
import { presentSheet, type SheetApi, type SheetSource } from "../../../ui/Sheet";
import { TextField } from "../../../ui/TextField";
import { josa, useSecondTicker } from "../format";
import { copyOf, InlineError, Note, useAgentName } from "../parts";
import {
  confirmCode,
  formatPhoneInput,
  getPending,
  looksDialable,
  phoneErrorMessage,
  removePhone,
  requestCall,
  RESEND_MS,
  usePhone,
  type PhoneInfo,
} from "./phone";
import "./phone.css";

/**
 * 내 전화번호 (HIG entering data + MOTION-SPEC §8): three steps in one sheet, page-swapped (ContentSwap, direction ±1).
 *   enter → one sentence, the number as the sheet's subject (a large filled field, no placeholder: the label says it
 *           and the number groups itself as it is typed), the +1 note right above "인증 전화 받기" (the one accent;
 *           off = a quiet fill); the server places a call that reads 4 digits (my-mosi B)
 *   code  → one-time-code field shown as 4 cells, submits itself on the 4th digit; "다시 걸기" waits 30 s; "번호 바꾸기"
 *   done  → the verified number, "번호 바꾸기", "번호 삭제" (two-step)
 * Every state change comes from the server's answer; errors sit at the field with an icon.
 */
export function presentPhone(source: SheetSource) {
  return presentSheet({ source, title: "내 전화번호", render: (api) => <PhoneBody api={api} /> });
}

type Step = "enter" | "code" | "done";

function initialStep(phone: PhoneInfo | null | undefined): Step {
  if (phone?.verified) return "done";
  if (phone && getPending()) return "code";
  return "enter";
}

function PhoneBody({ api }: { api: SheetApi }) {
  const phone = usePhone();
  const [step, setStep] = useState<Step>(() => initialStep(phone));
  const [dir, setDir] = useState<1 | -1>(1);
  // the done step keeps showing the number it was opened with while the delete settles
  const lastPhone = useRef(phone);
  if (phone) lastPhone.current = phone;

  const toCode = useCallback(() => {
    setDir(1);
    setStep("code");
  }, []);
  const toEnter = useCallback(() => {
    setDir(-1);
    setStep("enter");
  }, []);
  const close = useCallback(() => api.close(), [api]);

  return (
    <div className="phone-sheet">
      <ContentSwap swapKey={step} as="div" display="block" direction={dir}>
        {step === "enter" && <EnterStep current={phone ?? null} onSent={toCode} />}
        {step === "code" && <CodeStep onChangeNumber={toEnter} onVerified={close} />}
        {step === "done" && lastPhone.current && <DoneStep phone={lastPhone.current} onChangeNumber={toEnter} onRemoved={close} />}
      </ContentSwap>
    </div>
  );
}

function EnterStep({ current, onSent }: { current: PhoneInfo | null; onSent: () => void }) {
  const agentName = useAgentName();
  const [value, setValue] = useState(() => getPending()?.number ?? "");
  const [error, setError] = useState<string | undefined>();
  // driven here, not by `action`: a refused number is said at the field and the button goes back to its label
  // (an error state would offer "다시 시도하기" for a number that cannot work)
  const [state, setState] = useState<ButtonState>("idle");
  const busy = useRef(false);
  const ok = looksDialable(value);

  const send = async () => {
    if (busy.current || !ok) return;
    busy.current = true;
    setError(undefined);
    setState("loading");
    try {
      await requestCall(value);
      setState("success");
    } catch (e) {
      busy.current = false;
      setState("idle");
      setError(phoneErrorMessage(e, "call"));
    }
  };

  return (
    <div className="phone-step" data-step="enter">
      <p className="phone-lead t-copy">{copyOf(`${josa(agentName, "이가")} 모닝콜이나 알림 전화는 이 번호로만 걸어요.`)}</p>
      {current && (
        <Note>
          {current.verified
            ? `인증 전화를 받으면 지금 번호(${current.masked})는 새 번호로 바뀌어요.`
            : `${current.masked} 번호는 아직 인증하지 않았어요. 인증 전화를 다시 받아 주세요.`}
        </Note>
      )}
      <TextField
        label="휴대폰 번호"
        type="tel"
        inputMode="tel"
        autoComplete="tel"
        enterKeyHint="send"
        name="tel"
        variant="filled"
        value={value}
        onChange={(v) => {
          if (busy.current) return;
          setValue(formatPhoneInput(v));
          if (error) setError(undefined);
        }}
        onEnter={() => void send()}
        error={error}
        className="phone-tel"
      />
      <div className="phone-cta">
        <Note>인증 전화는 해외 번호(+1)로 걸려 와요. 모르는 번호여도 받아 주세요.</Note>
        <Button
          tone="primary"
          size="lg"
          fullWidth
          state={state}
          onClick={() => void send()}
          disabled={!ok && state === "idle"}
          busyLabel="인증 전화를 거는 중"
          successLabel="전화를 걸었어요"
          holdSuccess
          onSuccess={onSent}
          className="phone-call profile-off"
        >
          인증 전화 받기
        </Button>
      </div>
    </div>
  );
}

const CELLS = [0, 1, 2, 3];

function CodeStep({ onChangeNumber, onVerified }: { onChangeNumber: () => void; onVerified: () => void }) {
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [state, setState] = useState<ButtonState>("idle");
  const [focused, setFocused] = useState(false);
  const [sentAt, setSentAt] = useState(() => getPending()?.sentAt ?? 0);
  const busy = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  const uid = useId().replace(/:/g, "");
  const promptId = `phone-code-${uid}`;
  const errorId = `phone-code-err-${uid}`;
  // kept in state: the pending call is cleared the moment the code is accepted, the line must not jump away mid-check
  const [masked, setMasked] = useState(() => getPending()?.masked);

  const now = useSecondTicker(Date.now() - sentAt < RESEND_MS + 1000);
  const wait = Math.max(0, Math.ceil((sentAt + RESEND_MS - now) / 1000));

  const submit = async (c: string) => {
    if (busy.current || c.length !== 4) return;
    busy.current = true;
    setError(undefined);
    setState("loading");
    try {
      await confirmCode(c);
      setState("success");
    } catch (e) {
      busy.current = false;
      setState("idle");
      setCode("");
      setError(phoneErrorMessage(e, "verify"));
      requestAnimationFrame(() => input.current?.focus());
    }
  };

  const onInput = (v: string) => {
    const d = v.replace(/\D/g, "").slice(0, 4);
    setCode(d);
    if (d && error) setError(undefined);
    if (d.length === 4) void submit(d);
  };

  const resend = async () => {
    const p = getPending();
    if (!p) throw new Error("no_number");
    setError(undefined);
    try {
      const r = await requestCall(p.number);
      setMasked(r.masked);
      setSentAt(getPending()?.sentAt ?? Date.now());
      setCode("");
    } catch (e) {
      setError(phoneErrorMessage(e, "call"));
      throw e;
    }
  };

  const locked = state === "loading" || state === "success";
  const active = focused && !locked ? Math.min(code.length, 3) : -1;

  return (
    <div className="phone-step" data-step="code">
      <div className="phone-code-head">
        <h3 id={promptId} className="phone-code-title">
          전화로 들려드린 4자리 숫자를 입력해 주세요
        </h3>
        {masked && <p className="phone-code-sub tnum">{masked} 번호로 전화를 걸었어요. 해외 번호(+1)로 걸려 와요.</p>}
      </div>

      <div className="phone-otp" data-invalid={error ? true : undefined}>
        <input
          ref={input}
          className="phone-otp__input"
          value={code}
          onChange={(e) => onInput(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]*"
          maxLength={4}
          enterKeyHint="done"
          aria-labelledby={promptId}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          readOnly={locked}
        />
        <div className="phone-otp__cells tnum" aria-hidden="true">
          {CELLS.map((i) => (
            <span key={i} className="phone-otp__cell" data-filled={i < code.length || undefined} data-active={i === active || undefined}>
              {code[i] ?? ""}
            </span>
          ))}
        </div>
      </div>
      <div id={errorId}>
        <InlineError className="phone-error">{error}</InlineError>
      </div>

      <Button
        tone="primary"
        size="lg"
        fullWidth
        state={state}
        disabled={code.length !== 4 && !locked}
        onClick={() => void submit(code)}
        busyLabel="확인하는 중"
        successLabel="번호를 인증했어요"
        holdSuccess
        onSuccess={onVerified}
        className="phone-verify"
      >
        확인하기
      </Button>

      <div className="phone-code-actions">
        <Button tone="secondary" size="md" fullWidth action={resend} disabled={wait > 0 || locked} successLabel="다시 걸었어요" errorLabel="다시 걸기" className="phone-resend">
          {wait > 0 ? <span className="tnum">다시 걸기 · {wait}초</span> : "다시 걸기"}
        </Button>
        <Button tone="secondary" size="md" fullWidth onClick={onChangeNumber} disabled={locked} className="phone-change">
          번호 바꾸기
        </Button>
      </div>
    </div>
  );
}

function DoneStep({ phone, onChangeNumber, onRemoved }: { phone: PhoneInfo; onChangeNumber: () => void; onRemoved: () => void }) {
  const agentName = useAgentName();
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="phone-step" data-step="done">
      <div className="phone-done">
        <span className="phone-done__icon" aria-hidden="true">
          <Icon name="phone" size={22} weight="medium" />
        </span>
        <span className="phone-done__main">
          <span className="phone-done__number tnum">{phone.masked}</span>
          <span className="phone-done__state">
            <Icon name="checkmark" size={13} weight="semibold" />
            인증됨
          </span>
        </span>
      </div>
      <p className="phone-lead t-copy">{copyOf(`${josa(agentName, "이가")} 모닝콜이나 알림 전화를 이 번호로만 걸어요.`)}</p>
      <Note>전화는 해외 번호(+1)로 걸려 와요.</Note>
      <Button tone="secondary" size="md" fullWidth icon="phone" onClick={onChangeNumber} className="phone-change">
        번호 바꾸기
      </Button>
      <ConfirmButton
        label="번호 삭제"
        confirmLabel="한 번 더 누르면 삭제해요"
        tone="destructive"
        size="md"
        onConfirm={async () => {
          setError(null);
          await removePhone();
        }}
        onError={(e) => setError(phoneErrorMessage(e, "call"))}
        onSuccess={onRemoved}
        className="phone-delete"
      />
      <InlineError>{error}</InlineError>
    </div>
  );
}
