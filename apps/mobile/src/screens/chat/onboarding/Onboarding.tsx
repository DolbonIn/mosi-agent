import type { AvatarSpec, PasswordResetStartResponse } from "@pickle/protocol";
import { motion } from "framer-motion";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type FormEvent } from "react";
import { login, resetStart, resetVerify, signup } from "../../../api/auth";
import type { ApiError } from "../../../api/client";
import * as ep from "../../../api/endpoints";
import { applyAgent, bootstrap, sessionStore, useSession } from "../../../api/store";
import { ContentSwap } from "../../../motion/ContentSwap";
import { EXIT, t } from "../../../motion/springs";
import { useTierValue } from "../../../motion/tier";
import { AgentBlobLazy } from "../../../ui/AgentBlobLazy";
import { Button } from "../../../ui/Button";
import { Chip } from "../../../ui/Chip";
import { Icon } from "../../../ui/Icon";
import { Sheet } from "../../../ui/Sheet";
import { TextField } from "../../../ui/TextField";
import { deviceAgentSpec, onboardingHold, pendingInvite } from "./state";
import "./onboarding.css";

/**
 * Launch / onboarding (MOTION-SPEC §6.1 + §8.12, research §4-1; draft "onboarding" B, picked 2026-11-12). No splash,
 * first paint is the final layout: the agent character (SVG poster first, 3D later), "나만의 모시를 만나보세요", ONE
 * primary capsule "시작하기".
 *  - The character met here is the one that stays: the device's preview spec (state.ts) is saved to the agent right
 *    after sign-up, the same colour and eyes as in the chat. The server's spec is the one source: after a login (or
 *    when the save fails) the character on the stage takes the account's spec before the chat takes over, and the
 *    device copy follows it.
 *  - The sheets are undimmed (iOS medium detent): when one opens, the character leaves the hero and settles above
 *    the sheet (one element moving on `morph`, never a second copy), the headline fades on `fade`; the shell stays
 *    inert behind the sheet. In sign-up step 2 the name being typed sits under the face, and the face sits next to
 *    the name field too (the user's memo on the pick).
 *  - Sign-up is a 2-step sheet that morphs out of "시작하기": (1) 아이디·비밀번호, (2) my name + 모시 name with a
 *    suggested default; both steps share one sheet height, and "이전 단계" sits in the sheet head's leading slot.
 *  - "로그인" opens one sheet that also holds the way back in: "비밀번호를 잊었어요" → a code to the phone the account
 *    verified → a new password (content swaps inside the same sheet), and "처음이에요 · 시작하기".
 * Errors are the server's Korean `message`, inline at the field they belong to; the button shows loader → check only
 * after the server confirmed, then the sheet folds away and the chat arrives. No permission is asked here.
 */
const HANDLE_RE = /^[a-z0-9_]{3,20}$/;
const NAMES = ["깽이", "콩이", "몽이", "두부"];
/** hero blob size; on the stage above a sheet the same element is scaled to the stage slot (168 px, onboarding.css) */
const HERO = 208;
/** sheet heights (px, panel incl. padding): both sign-up steps share one, login and its reset views share one */
const SHEET_H = { signup: 404, login: 436 } as const;

type Mode = "signup" | "login" | null;
type FieldErrors = Partial<Record<"handle" | "password" | "displayName" | "agentName" | "code" | "form", string>>;

export function Onboarding() {
  const session = useSession();
  const reduce = useTierValue("reduceMotion");
  const start = useRef<HTMLButtonElement>(null);
  const loginBtn = useRef<HTMLButtonElement>(null);
  const blobBox = useRef<HTMLDivElement>(null);
  const slot = useRef<HTMLDivElement>(null);
  const [mode, setMode] = useState<Mode>(null);
  const [done, setDone] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [stageName, setStageName] = useState<string | null>(null);
  const [spec, setSpec] = useState<AvatarSpec>(deviceAgentSpec);
  const [move, setMove] = useState({ x: 0, y: 0, scale: 1 });
  const invite = pendingInvite();
  const staged = mode !== null || done;
  const sheetH = SHEET_H[mode ?? "signup"];

  const reduceRef = useRef(reduce);
  reduceRef.current = reduce;
  // the server confirmed: the character stays on its stage, the sheet folds away, then the chat takes over (stable:
  // Button's success timer keys on it)
  const finish = useCallback(() => {
    const r = reduceRef.current;
    setDone(true);
    setMode(null);
    setTimeout(() => setLeaving(true), r ? 0 : 380);
    setTimeout(() => onboardingHold.set(false), r ? 0 : 560);
  }, []);
  // each sheet closes only itself: opening one sheet closes the other (one sheet at a time), and that close must not
  // take the new one with it
  const closeSignup = useCallback(() => setMode((m) => (m === "signup" ? null : m)), []);
  const closeLogin = useCallback(() => setMode((m) => (m === "login" ? null : m)), []);

  // the stage slot sits above the sheet (CSS, follows the keyboard); the hero blob travels there as ONE element
  useLayoutEffect(() => {
    if (!staged) {
      setMove({ x: 0, y: 0, scale: 1 });
      return;
    }
    const measure = () => {
      const a = blobBox.current?.getBoundingClientRect();
      const b = slot.current?.getBoundingClientRect();
      if (!a || !b || !a.width || !b.width) return;
      setMove({
        x: Math.round(b.left + b.width / 2 - (a.left + a.width / 2)),
        y: Math.round(b.top + b.height / 2 - (a.top + a.height / 2)),
        scale: Math.max(0.25, Math.min(b.width, b.height) / HERO),
      });
    };
    measure();
    const vv = window.visualViewport;
    addEventListener("resize", measure);
    vv?.addEventListener("resize", measure);
    return () => {
      removeEventListener("resize", measure);
      vv?.removeEventListener("resize", measure);
    };
  }, [staged, sheetH]);

  return (
    <motion.main
      className="onb"
      aria-label="모시 시작하기"
      data-staged={staged || undefined}
      style={{ "--onb-sheet-h": `${sheetH}px` } as CSSProperties}
      animate={leaving ? { opacity: 0, y: -6 } : { opacity: 1, y: 0 }}
      transition={leaving ? EXIT : t("camera")}
    >
      <div className="onb-hero">
        <div ref={blobBox} className="onb-blob" aria-hidden="true">
          <motion.div className="onb-blob-move" initial={false} animate={move} transition={t("morph")}>
            <AgentBlobLazy size={HERO} spec={spec} />
          </motion.div>
        </div>
        <motion.div className="onb-copy" initial={false} animate={{ opacity: staged ? 0 : 1 }} transition={t("fade")}>
          <h1 className="onb-title">나만의 모시를 만나보세요</h1>
          <p className="onb-sub">말로 맡기면 전화도 대신 걸고, 카카오톡도 정리해 드려요.</p>
          {invite && (
            <p className="onb-invite">
              <Icon name="people" size={16} weight="medium" />
              친구 초대를 받았어요 · 시작하면 바로 친구가 돼요
            </p>
          )}
        </motion.div>
      </div>

      <motion.div className="onb-foot" initial={false} animate={{ opacity: staged ? 0 : 1 }} transition={t("fade")}>
        {session.status === "error" && (
          <div className="onb-error" role="alert">
            <Icon name="exclamation" size={16} weight="medium" />
            <span>{session.error ?? "서버에 연결하지 못했어요"}</span>
            <button type="button" className="onb-link" onClick={() => void bootstrap()}>
              다시 시도
            </button>
          </div>
        )}

        <div className="onb-actions">
          <Button ref={start} fullWidth size="lg" tone="primary" onClick={() => setMode("signup")}>
            시작하기
          </Button>
          <button ref={loginBtn} type="button" className="onb-login" onClick={() => setMode("login")}>
            이미 계정이 있어요 · <span className="onb-login-em">로그인</span>
          </button>
        </div>
      </motion.div>

      {/* the stage above an open sheet: where the character settles, and (sign-up step 2) the name under its face */}
      <div className="onb-stage" aria-hidden="true">
        <div ref={slot} className="onb-stage-slot" />
        <p className="onb-stage-name" data-on={stageName !== null || undefined}>
          {stageName || "\u00a0"}
        </p>
      </div>

      <SignupSheet open={mode === "signup"} source={start} spec={spec} onClose={closeSignup} onDone={finish} onStage={setStageName} onAdopt={setSpec} />
      <LoginSheet open={mode === "login"} source={loginBtn} onClose={closeLogin} onDone={finish} onSignup={() => setMode("signup")} onAdopt={setSpec} />
    </motion.main>
  );
}

function fieldFor(e: ApiError): keyof FieldErrors {
  switch (e.code) {
    case "invalid_handle":
    case "handle_taken":
    case "no_verified_phone":
    case "phone_unavailable":
    case "phone_failed":
      return "handle";
    case "weak_password":
    case "invalid_password":
    case "invalid_credentials":
      return "password";
    case "invalid_code":
    case "code_expired":
      return "code";
    case "invalid_field":
      return "displayName";
    default:
      return "form";
  }
}

/** the reset flow's own words for the server's codes (409 no_verified_phone hides whether the 아이디 exists) */
function resetMessage(e: ApiError): string {
  switch (e.code) {
    case "no_verified_phone":
      return "인증한 전화번호가 없거나 없는 아이디예요";
    case "phone_unavailable":
      return "지금은 전화를 걸 수 없어요. 잠시 후 다시 시도해 주세요";
    case "phone_failed":
      return "전화를 걸지 못했어요. 잠시 후 다시 시도해 주세요";
    case "invalid_code": {
      const left = typeof e.data?.attemptsLeft === "number" ? e.data.attemptsLeft : null;
      return left ? `인증번호가 맞지 않아요. ${left}번 더 입력할 수 있어요` : "인증번호가 맞지 않아요";
    }
    case "code_expired":
      return "인증번호가 만료됐어요. 다시 받아 주세요";
    case "weak_password":
      return "비밀번호는 8자 이상이어야 해요";
    default:
      return e.message;
  }
}

function SignupSheet({
  open,
  source,
  spec,
  onClose,
  onDone,
  onStage,
  onAdopt,
}: {
  open: boolean;
  source: React.RefObject<HTMLButtonElement | null>;
  spec: AvatarSpec;
  onClose: () => void;
  onDone: () => void;
  onStage: (name: string | null) => void;
  /** the account's spec when it is not the one on screen (the save failed): the stage takes it */
  onAdopt: (spec: AvatarSpec) => void;
}) {
  const [step, setStep] = useState<1 | 2>(1);
  const [handle, setHandle] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [agentName, setAgentName] = useState(NAMES[0]!);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [busy, setBusy] = useState(false);

  // step 2: the name being typed shows under the face on the stage (same frame as the input, no animation)
  useEffect(() => onStage(open && step === 2 ? agentName.trim() : null), [open, step, agentName, onStage]);

  const next = (e?: FormEvent) => {
    e?.preventDefault();
    const errs: FieldErrors = {};
    if (!HANDLE_RE.test(handle)) errs.handle = "아이디는 영문 소문자와 숫자, 밑줄(_)로 3~20자여야 해요";
    if (password.length < 8) errs.password = "비밀번호는 8자 이상이어야 해요";
    setErrors(errs);
    if (!Object.keys(errs).length) setStep(2);
  };

  const create = async () => {
    const errs: FieldErrors = {};
    if (!displayName.trim()) errs.displayName = "이름을 알려 주세요";
    if (!agentName.trim()) errs.agentName = "모시 이름을 정해 주세요";
    setErrors(errs);
    if (Object.keys(errs).length) throw new Error(Object.values(errs)[0]);
    setBusy(true);
    onboardingHold.set(true);
    try {
      await signup({ handle, password, displayName: displayName.trim(), agentName: agentName.trim() });
    } catch (err) {
      onboardingHold.set(false);
      const e = err as ApiError;
      const f = fieldFor(e);
      setErrors({ [f]: e.message });
      if (f === "handle" || f === "password") setStep(1);
      throw err;
    } finally {
      setBusy(false);
    }
    // the character met on the first screen is the one that stays: save its spec before the chat shows it (one
    // retry). The account exists either way; if the save still fails the server keeps its default, and the stage
    // takes THAT one, so the chat never shows a different face from the one the person just saw.
    for (let tries = 0; tries < 2; tries++) {
      try {
        applyAgent(await ep.patchAgent({ avatar: spec }));
        return;
      } catch {
        /* retry once, then adopt the server's */
      }
    }
    const own = sessionStore.get().session?.agent?.avatar;
    if (own) onAdopt(own);
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      source={source}
      busy={busy}
      dim={false}
      className="onb-sheet onb-sheet--signup"
      leading={step === 2 ? { label: "이전 단계", onClick: () => setStep(1) } : undefined}
      title={
        <span className="onb-sheet-title">
          모시 만들기 <span className="onb-step tnum">{step}/2</span>
        </span>
      }
      footer={
        <ContentSwap swapKey={step} display="block">
          {step === 1 ? (
            <Button fullWidth size="lg" tone="primary" onClick={() => next()}>
              다음
            </Button>
          ) : (
            <Button fullWidth size="lg" tone="primary" action={create} holdSuccess errorLabel="다시 만들기" busyLabel="모시를 만드는 중" successLabel="만들었어요" onSuccess={onDone}>
              모시 만들기
            </Button>
          )}
        </ContentSwap>
      }
    >
      <ContentSwap swapKey={step} display="block" direction={step === 2 ? 1 : -1}>
        {step === 1 ? (
          <form className="onb-form" onSubmit={next} noValidate>
            <TextField
              label="아이디"
              value={handle}
              onChange={(v) => {
                setHandle(v.trim().toLowerCase());
                setErrors((e) => ({ ...e, handle: undefined, form: undefined }));
              }}
              autoComplete="username"
              autoCapitalize="none"
              enterKeyHint="next"
              hint="영문 소문자와 숫자로 3~20자예요. 밑줄(_)도 쓸 수 있어요"
              error={errors.handle}
              maxLength={20}
              autoFocus
            />
            <TextField
              label="비밀번호"
              type="password"
              value={password}
              onChange={(v) => {
                setPassword(v);
                setErrors((e) => ({ ...e, password: undefined, form: undefined }));
              }}
              autoComplete="new-password"
              enterKeyHint="next"
              hint="8자 이상"
              error={errors.password}
              onEnter={() => next()}
            />
            {errors.form && <FormError text={errors.form} />}
            <button type="submit" hidden />
          </form>
        ) : (
          <form className="onb-form" onSubmit={(e) => e.preventDefault()} noValidate>
            <TextField
              label="내 이름"
              value={displayName}
              onChange={(v) => {
                setDisplayName(v);
                setErrors((e) => ({ ...e, displayName: undefined, form: undefined }));
              }}
              autoComplete="name"
              enterKeyHint="next"
              hint={displayName.trim() ? `모시가 "${displayName.trim()} 님"이라고 불러요` : "모시가 부를 이름이에요"}
              error={errors.displayName}
              maxLength={20}
            />
            <TextField
              label="모시 이름"
              value={agentName}
              onChange={(v) => {
                setAgentName(v);
                setErrors((e) => ({ ...e, agentName: undefined, form: undefined }));
              }}
              leading={<AgentBlobLazy size={30} spec={spec} />}
              enterKeyHint="done"
              error={errors.agentName}
              maxLength={12}
            />
            <div className="onb-names" role="group" aria-label="추천 이름">
              {NAMES.map((n) => (
                <Chip key={n} size="sm" label={n} selected={agentName === n} onClick={() => setAgentName(n)} />
              ))}
            </div>
            {errors.form && <FormError text={errors.form} />}
          </form>
        )}
      </ContentSwap>
    </Sheet>
  );
}

type LoginView = "login" | "reset" | "code";
const LOGIN_TITLE: Record<LoginView, string> = { login: "로그인", reset: "비밀번호 다시 만들기", code: "비밀번호 다시 만들기" };

function LoginSheet({
  open,
  source,
  onClose,
  onDone,
  onSignup,
  onAdopt,
}: {
  open: boolean;
  source: React.RefObject<HTMLButtonElement | null>;
  onClose: () => void;
  onDone: () => void;
  onSignup: () => void;
  /** the account's spec: the stage shows it before the chat takes over (this device only had a preview) */
  onAdopt: (spec: AvatarSpec) => void;
}) {
  const [view, setView] = useState<LoginView>("login");
  const [handle, setHandle] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [sent, setSent] = useState<PasswordResetStartResponse | null>(null);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [busy, setBusy] = useState(false);
  const submit = useRef<HTMLButtonElement>(null);

  // a closed sheet opens on 로그인 again
  useEffect(() => {
    if (!open) return;
    setView("login");
    setErrors({});
  }, [open]);

  const go = async () => {
    const errs: FieldErrors = {};
    if (!handle.trim()) errs.handle = "아이디를 입력해 주세요";
    if (!password) errs.password = "비밀번호를 입력해 주세요";
    setErrors(errs);
    if (Object.keys(errs).length) throw new Error(Object.values(errs)[0]);
    setBusy(true);
    onboardingHold.set(true);
    try {
      const s = await login(handle.trim().toLowerCase(), password);
      if (s.agent?.avatar) onAdopt(s.agent.avatar); // the device copy follows the session by itself (state.ts)
    } catch (err) {
      onboardingHold.set(false);
      const e = err as ApiError;
      setErrors({ [fieldFor(e)]: e.message });
      throw err;
    } finally {
      setBusy(false);
    }
  };

  /** `again`: from the code view, where only the form-level error line is on screen */
  const sendCode = async (again = false) => {
    const h = handle.trim().toLowerCase();
    if (!h) {
      setErrors({ handle: "아이디를 입력해 주세요" });
      throw new Error("아이디를 입력해 주세요");
    }
    setErrors({});
    setBusy(true);
    try {
      setSent(await resetStart(h));
      setCode("");
      setNewPassword("");
    } catch (err) {
      const e = err as ApiError;
      setErrors({ [again ? "form" : fieldFor(e)]: resetMessage(e) });
      throw err;
    } finally {
      setBusy(false);
    }
  };

  const reset = async () => {
    const errs: FieldErrors = {};
    if (!/^\d{6}$/.test(code.trim())) errs.code = "전화로 들은 6자리 인증번호를 입력해 주세요";
    if (newPassword.length < 8) errs.password = "비밀번호는 8자 이상이어야 해요";
    setErrors(errs);
    if (Object.keys(errs).length) throw new Error(Object.values(errs)[0]);
    setBusy(true);
    onboardingHold.set(true);
    try {
      const s = await resetVerify(handle.trim().toLowerCase(), code.trim(), newPassword);
      if (s.agent?.avatar) onAdopt(s.agent.avatar);
    } catch (err) {
      onboardingHold.set(false);
      const e = err as ApiError;
      setErrors({ [fieldFor(e)]: resetMessage(e) });
      throw err;
    } finally {
      setBusy(false);
    }
  };

  const to = (v: LoginView) => {
    setErrors({});
    setView(v);
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      source={source}
      busy={busy}
      dim={false}
      className="onb-sheet onb-sheet--login"
      leading={view === "reset" ? { label: "로그인으로", onClick: () => to("login") } : view === "code" ? { label: "이전 단계", onClick: () => to("reset") } : undefined}
      title={
        <ContentSwap swapKey={LOGIN_TITLE[view]}>
          <span>{LOGIN_TITLE[view]}</span>
        </ContentSwap>
      }
      footer={
        <ContentSwap swapKey={view} display="block">
          {view === "login" ? (
            <>
              <Button ref={submit} fullWidth size="lg" tone="primary" action={go} holdSuccess errorLabel="다시 로그인" busyLabel="로그인하는 중" successLabel="로그인했어요" onSuccess={onDone}>
                로그인
              </Button>
              <button type="button" className="onb-login onb-foot-link" onClick={onSignup}>
                처음이에요 · <span className="onb-login-em">시작하기</span>
              </button>
            </>
          ) : view === "reset" ? (
            <>
              <Button fullWidth size="lg" tone="primary" action={() => sendCode()} errorLabel="다시 받기" busyLabel="전화를 거는 중" successLabel="전화했어요" onSuccess={() => to("code")}>
                전화로 인증번호 받기
              </Button>
              <button type="button" className="onb-login onb-foot-link" onClick={onSignup}>
                새 아이디로 · <span className="onb-login-em">시작하기</span>
              </button>
            </>
          ) : (
            <Button fullWidth size="lg" tone="primary" action={reset} holdSuccess errorLabel="다시 바꾸기" busyLabel="바꾸는 중" successLabel="바꿨어요" onSuccess={onDone}>
              비밀번호 바꾸기
            </Button>
          )}
        </ContentSwap>
      }
    >
      <ContentSwap swapKey={view} display="block" direction={view === "login" ? -1 : 1}>
        {view === "login" ? (
          <form className="onb-form" onSubmit={(e) => e.preventDefault()} noValidate>
            <TextField
              label="아이디"
              value={handle}
              onChange={(v) => {
                setHandle(v);
                setErrors((e) => ({ ...e, handle: undefined, form: undefined }));
              }}
              autoComplete="username"
              autoCapitalize="none"
              enterKeyHint="next"
              error={errors.handle}
              autoFocus
            />
            <TextField
              label="비밀번호"
              type="password"
              value={password}
              onChange={(v) => {
                setPassword(v);
                setErrors((e) => ({ ...e, password: undefined, form: undefined }));
              }}
              autoComplete="current-password"
              enterKeyHint="go"
              error={errors.password}
              onEnter={() => submit.current?.click()}
            />
            {errors.form && <FormError text={errors.form} />}
            <button type="button" className="onb-text-action" onClick={() => to("reset")}>
              비밀번호를 잊었어요
            </button>
          </form>
        ) : view === "reset" ? (
          <form className="onb-form" onSubmit={(e) => e.preventDefault()} noValidate>
            <p className="onb-reset-lead">{RESET_LEAD}</p>
            <TextField
              label="아이디"
              value={handle}
              onChange={(v) => {
                setHandle(v.trim().toLowerCase());
                setErrors((e) => ({ ...e, handle: undefined, form: undefined }));
              }}
              autoComplete="username"
              autoCapitalize="none"
              enterKeyHint="send"
              error={errors.handle}
            />
            {errors.form && <FormError text={errors.form} />}
            <p className="onb-reset-note">나의 모시에서 전화번호를 인증하지 않았다면 비밀번호를 다시 만들 수 없어요. 새 아이디로 시작하면 새 모시를 만나요.</p>
          </form>
        ) : (
          <form className="onb-form" onSubmit={(e) => e.preventDefault()} noValidate>
            <p className="onb-reset-lead">
              {sent ? `${sent.masked}로 전화를 걸어 인증번호를 불러 드렸어요.` : "인증한 전화번호로 전화를 걸어 인증번호를 불러 드렸어요."}
            </p>
            <TextField
              label="인증번호"
              value={code}
              onChange={(v) => {
                setCode(v.replace(/\D/g, ""));
                setErrors((e) => ({ ...e, code: undefined, form: undefined }));
              }}
              inputMode="numeric"
              autoComplete="one-time-code"
              enterKeyHint="next"
              error={errors.code}
              maxLength={6}
              autoFocus
              trailing={
                <button type="button" className="onb-code-again" aria-label="인증번호 다시 받기" disabled={busy} onClick={() => void sendCode(true).catch(() => {})}>
                  다시 받기
                </button>
              }
            />
            <TextField
              label="새 비밀번호"
              type="password"
              value={newPassword}
              onChange={(v) => {
                setNewPassword(v);
                setErrors((e) => ({ ...e, password: undefined, form: undefined }));
              }}
              autoComplete="new-password"
              enterKeyHint="done"
              hint="8자 이상"
              error={errors.password}
            />
            {errors.form && <FormError text={errors.form} />}
          </form>
        )}
      </ContentSwap>
    </Sheet>
  );
}

/** the reset sheet's first line: says how the code arrives (the server's channel for the verified phone) */
const RESET_LEAD = "인증한 전화번호로 전화를 걸어 인증번호를 불러 드려요. 확인하면 새 비밀번호를 만들 수 있어요.";

function FormError({ text }: { text: string }) {
  return (
    <p className="onb-form-error" role="alert">
      <Icon name="exclamation" size={15} weight="medium" />
      {text}
    </p>
  );
}
