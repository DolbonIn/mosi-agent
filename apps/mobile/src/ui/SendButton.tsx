import { ContentSwap } from "../motion/ContentSwap";
import { haptic } from "../motion/haptics";
import { Icon } from "./Icon";
import "./SendButton.css";

/**
 * The composer's trailing control (MOTION-SPEC §8.4): ONE 44 px circle that morphs between
 *   mic (neutral, empty field) ↔ send arrow (accent fill — the chat screen's one accent) ↔ stop (a rounded square,
 *   label fill) while a turn runs. The glyph swaps by the content rule (small container, so blur is allowed);
 * the fill changes by a CSS transition; press feedback is CSS `:active` (same frame as the tap, no React round-trip).
 *   <SendButton mode={running ? "stop" : text ? "send" : "mic"} onSend={send} onStop={stopTurn} onMic={listen} />
 */
export type SendButtonMode = "mic" | "send" | "stop";

export interface SendButtonProps {
  mode: SendButtonMode;
  onSend?: () => void;
  onStop?: () => void;
  onMic?: () => void;
  disabled?: boolean;
  /** extra reason for screen readers when disabled (e.g. "오프라인이라 보낼 수 없어요") */
  disabledReason?: string;
  className?: string;
}

const LABEL: Record<SendButtonMode, string> = { mic: "음성으로 말하기", send: "보내기", stop: "멈추기" };

export function SendButton({ mode, onSend, onStop, onMic, disabled, disabledReason, className }: SendButtonProps) {
  const stopActive = mode === "stop";
  const off = disabled && !stopActive;
  return (
    <button
      type="button"
      className={`send-btn${className ? ` ${className}` : ""}`}
      data-mode={mode}
      aria-label={off && disabledReason ? `${LABEL[mode]}, ${disabledReason}` : LABEL[mode]}
      aria-disabled={off || undefined}
      onClick={() => {
        if (off) return;
        if (mode === "stop") {
          haptic("impact");
          onStop?.();
        } else if (mode === "send") {
          haptic("selection");
          onSend?.();
        } else onMic?.();
      }}
    >
      <ContentSwap swapKey={mode} className="send-btn-glyph">
        {mode === "stop" ? (
          <span className="send-btn-stop" aria-hidden="true" />
        ) : (
          <Icon name={mode === "send" ? "arrow-up" : "mic"} size={22} weight={mode === "send" ? "semibold" : "medium"} />
        )}
      </ContentSwap>
    </button>
  );
}
