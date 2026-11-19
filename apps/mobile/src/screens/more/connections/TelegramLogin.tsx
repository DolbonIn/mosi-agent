import type { Connection } from "@pickle/protocol";
import { useState, type ReactNode } from "react";
import * as ep from "../../../api/endpoints";
import { Button } from "../../../ui/Button";
import { TextField } from "../../../ui/TextField";
import { InlineError, Lead, Note } from "../parts";
import type { RelayLoginView } from "./DiscordLogin";
import { OtpField } from "./SlackLogin";
import { useLoginRelay } from "./useLoginRelay";
import "./RelayLogin.css";

/**
 * "텔레그램 로그인" inside the connect sheet (TDLib on the server, like Telegram's own apps):
 *
 *   phone      "010-1234-5678" → "코드 받기" (start + the sealed number in one go)
 *   code       the code Telegram sent to the Telegram app (or SMS), one-time-code field, submits itself when full
 *   password   the 2FA password when the account has one (with the person's own hint)
 *   → connected: handed back to ConnectSheet
 *
 * The number, the code and the password are sealed on this device for the enclave, bound to this relay, and never
 * stored: the server hands them to Telegram and drops them. The number is shown back masked only (010-****-1234).
 */

const VIA: Record<string, string> = {
  app: "텔레그램 앱",
  sms: "문자 메시지",
  call: "전화",
  email: "이메일",
};

export function useTelegramLogin({
  userId,
  enabled,
  intro,
  onConnected,
}: {
  userId: string | null;
  enabled: boolean;
  intro?: ReactNode;
  onConnected: (c: Connection) => void;
}): RelayLoginView {
  const relay = useLoginRelay({ provider: "telegram", userId, enabled, onConnected });
  const { live, ended, busy, error } = relay;
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");

  const state = live?.state ?? "intro";
  const phoneOk = phone.replace(/\D/g, "").length >= 9;
  const codeLength = live?.codeLength ?? 5;

  const sendPhone = () => {
    if (!phoneOk) return;
    const value = phone.trim();
    if (live?.state === "needs_phone") return void relay.submit("phone", value, "코드 보내는 중");
    void relay.start("코드 보내는 중", async (res) => {
      if (res.state !== "needs_phone") return null;
      return ep.loginRelayStep("telegram", { relayId: res.relayId, phone: await relay.seal(res.relayId, "phone", value) });
    });
  };

  const submitCode = (v: string) => {
    const clean = v.replace(/\D/g, "");
    if (clean.length !== codeLength) return;
    void relay.submit("code", clean, "확인하는 중").then(() => setCode(""));
  };

  const submitPassword = () => {
    if (!password) return;
    void relay.submit("password", password, "로그인하는 중").then(() => setPassword(""));
  };

  const restart = () => {
    relay.reset();
    setCode("");
    setPassword("");
  };

  let body: ReactNode;
  let primary: { label: string; disabled: boolean; onClick: () => void } | null = null;

  if (state === "needs_code") {
    const via = VIA[live?.codeVia ?? "app"] ?? "텔레그램 앱";
    body = (
      <div className="more-sheet-group">
        <Lead>
          {via}으로 <strong className="rl-strong tnum">{live?.phoneMasked ?? "내 번호"}</strong> 계정의 로그인 코드 {codeLength}자리를 보냈어요.
        </Lead>
        <OtpField
          label={`로그인 코드 ${codeLength}자리`}
          length={codeLength}
          numeric
          value={code}
          onChange={(v) => {
            setCode(v);
            if (error) relay.clearError();
          }}
          onComplete={submitCode}
          error={error?.message}
          disabled={!!busy}
        />
        {live?.codeVia === "app" && <Note icon="telegram">휴대폰이나 컴퓨터의 텔레그램 앱에서 &lsquo;Telegram&rsquo; 공식 계정이 보낸 메시지를 열어 보세요.</Note>}
      </div>
    );
    primary = { label: "확인", disabled: code.length !== codeLength, onClick: () => submitCode(code) };
  } else if (state === "needs_password") {
    body = (
      <div className="more-sheet-group">
        <Lead>2단계 인증을 켠 계정이에요. 텔레그램 2단계 인증 비밀번호를 입력해 주세요.</Lead>
        <TextField
          label="2단계 인증 비밀번호"
          type="password"
          value={password}
          onChange={(v) => {
            setPassword(v);
            if (error) relay.clearError();
          }}
          hint={live?.passwordHint ? `힌트: ${live.passwordHint}` : undefined}
          autoComplete="current-password"
          autoCapitalize="none"
          enterKeyHint="go"
          onEnter={submitPassword}
          name="telegram-password"
          error={error?.message}
          disabled={!!busy}
          autoFocus
        />
      </div>
    );
    primary = { label: "로그인", disabled: !password, onClick: submitPassword };
  } else {
    // intro / phone (also after a relay ended: the reason is shown in the footer)
    body = (
      <>
        <Lead>텔레그램에 가입한 전화번호로 로그인해요. 텔레그램 앱으로 오는 코드를 입력하면 연결돼요.</Lead>
        {intro}
        <form
          className="conn-form"
          onSubmit={(e) => {
            e.preventDefault();
            sendPhone();
          }}
        >
          <TextField
            label="전화번호"
            type="tel"
            placeholder="010-1234-5678"
            value={phone}
            onChange={(v) => {
              setPhone(v.replace(/[^\d+\-\s()]/g, ""));
              if (error) relay.clearError();
            }}
            hint="해외 번호는 +국가번호부터 입력해 주세요."
            autoComplete="tel"
            inputMode="tel"
            enterKeyHint="go"
            onEnter={sendPhone}
            name="telegram-phone"
            error={live?.state === "needs_phone" && error?.code === "phone_invalid" ? error.message : undefined}
            disabled={!!busy}
          />
        </form>
        <Note icon="lock">전화번호·코드·비밀번호는 이 기기에서 암호화돼 텔레그램 로그인에만 쓰이고 저장되지 않아요. 보안 금고에는 연결 정보만 보관해요.</Note>
      </>
    );
    primary = { label: ended || (error && error.code !== "phone_invalid") ? "다시 시도" : "코드 받기", disabled: !phoneOk, onClick: sendPhone };
  }

  const footerError = state === "intro" || state === "needs_phone" ? (error?.code === "phone_invalid" ? null : (ended?.error?.message ?? error?.message ?? null)) : null;
  const footer = (
    <div className="conn-footer rl-footer">
      <InlineError>{footerError}</InlineError>
      {primary && (
        <Button fullWidth state={busy ? "loading" : "idle"} busyLabel={busy ?? undefined} disabled={primary.disabled && !busy} onClick={busy ? undefined : primary.onClick}>
          {primary.label}
        </Button>
      )}
      {live && (
        <button type="button" className="rl-link" onClick={restart} disabled={!!busy}>
          처음부터 다시
        </button>
      )}
    </div>
  );

  const status: RelayLoginView["status"] = busy ? "connecting" : live && live.state !== "needs_phone" ? "needs_verification" : ended?.state === "error" || (error && error.code !== "phone_invalid") ? "error" : undefined;
  return { busy: !!busy, status, body, footer };
}
