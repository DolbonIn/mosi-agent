import type { ConnectionVerification } from "@pickle/protocol";
import { useRef } from "react";
import { island } from "../../../app/island";
import { useTierValue } from "../../../motion/tier";
import { Icon } from "../../../ui/Icon";
import { useSecondTicker } from "../format";

/**
 * display_code verification (KakaoTalk passcode, LINE PIN, Teams device code): the code the person types into the
 * provider's phone app, big and tabular, with a countdown ring that drains with the REAL remaining time
 * (research §4-7 7-2). The 1 Hz ticker runs only while this is mounted (the person is watching it).
 * Reduced motion: the ring steps without a transition; the text always says how long is left.
 */
export function Passcode({ verification, onExpired }: { verification: ConnectionVerification; onExpired?: () => void }) {
  const code = verification.code ?? "";
  const expiresAt = verification.expiresAt ?? null;
  const startedAt = useRef<{ key: string; at: number } | null>(null);
  if (!startedAt.current || startedAt.current.key !== `${code}:${expiresAt}`) startedAt.current = { key: `${code}:${expiresAt}`, at: Date.now() };
  const now = useSecondTicker(!!expiresAt);
  const reduce = useTierValue("reduceMotion");

  const total = expiresAt ? Math.max(1, expiresAt - startedAt.current.at) : 1;
  const left = expiresAt ? Math.max(0, expiresAt - now) : 0;
  const frac = expiresAt ? Math.min(1, left / total) : 1;
  const expired = !!expiresAt && left <= 0;
  const firedExpiry = useRef(false);
  if (expired && !firedExpiry.current) {
    firedExpiry.current = true;
    queueMicrotask(() => onExpired?.());
  }

  const secs = Math.ceil(left / 1000);
  const mm = Math.floor(secs / 60);
  const ss = String(secs % 60).padStart(2, "0");
  const R = 26;
  const C = 2 * Math.PI * R;
  const cells = code.replace(/\s+/g, "").split("");
  const asCells = cells.length > 0 && cells.length <= 8;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      island.banner({ icon: "checkmark", title: "코드를 복사했어요", body: code });
    } catch {
      island.banner({ icon: "bolt", tone: "error", title: "복사하지 못했어요", body: "코드를 직접 입력해 주세요." });
    }
  };

  return (
    <div className="conn-passcode" role="group" aria-label="인증 코드">
      <p className="conn-passcode__prompt">{verification.prompt}</p>
      <div className="conn-passcode__row">
        <div className="conn-passcode__code tnum" aria-label={`인증 코드 ${cells.join(" ")}`} role="text">
          {asCells ? (
            cells.map((ch, i) => (
              <span key={i} className="conn-passcode__cell" aria-hidden="true">
                {ch}
              </span>
            ))
          ) : (
            <span className="conn-passcode__long" aria-hidden="true">
              {code}
            </span>
          )}
        </div>
        {expiresAt ? (
          <div className="conn-ring" aria-hidden="true">
            <svg width="64" height="64" viewBox="0 0 64 64">
              <circle cx="32" cy="32" r={R} className="conn-ring__track" />
              <circle
                cx="32"
                cy="32"
                r={R}
                className="conn-ring__fill"
                strokeDasharray={C}
                strokeDashoffset={C * (1 - frac)}
                style={reduce ? { transition: "none" } : undefined}
                transform="rotate(-90 32 32)"
              />
            </svg>
            <span className="conn-ring__text tnum">{expired ? "0:00" : `${mm}:${ss}`}</span>
          </div>
        ) : null}
      </div>
      <p className="conn-passcode__status" aria-live="polite">
        {expired ? "인증 시간이 지났어요" : expiresAt ? `${mm > 0 ? `${mm}분 ` : ""}${secs % 60}초 안에 입력해 주세요 · 확인되면 바로 연결돼요` : "확인되면 바로 연결돼요"}
      </p>
      {code && !expired && (
        <button type="button" className="conn-plain-btn" onClick={copy}>
          <Icon name="copy" size={17} weight="medium" />
          <span>코드 복사</span>
        </button>
      )}
    </div>
  );
}
