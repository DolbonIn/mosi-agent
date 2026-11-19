import { Button, type ButtonSize } from "./Button";

/**
 * High-risk confirm (MOTION-SPEC §8.6, research §3-4): press-and-hold fills the capsule linearly over `holdMs`
 * (release early → it rewinds on `snap`), AND the equivalent two-step tap in the same place — the first tap swaps
 * the label to "한 번 더 누르면 실행돼요", a second tap within 3 s confirms (keyboard: Enter twice; screen readers
 * get the same two steps). `onConfirm` runs the button's loader → check machine (resolve = the server confirmed).
 *   <ConfirmButton label="결제하기" holdMs={1200} tone="primary" onConfirm={() => pay()} />
 */
export interface ConfirmButtonProps {
  label: string;
  onConfirm: () => Promise<unknown> | void;
  holdMs?: number;
  tone?: "primary" | "destructive" | "neutral";
  size?: ButtonSize;
  fullWidth?: boolean;
  disabled?: boolean;
  /** the second-step label (default "한 번 더 누르면 실행돼요") */
  confirmLabel?: string;
  className?: string;
  onSuccess?: () => void;
  onError?: (err: unknown) => void;
}

export function ConfirmButton({
  label,
  onConfirm,
  holdMs = 1200,
  tone = "primary",
  size = "lg",
  fullWidth = true,
  disabled,
  confirmLabel = "한 번 더 누르면 실행돼요",
  className,
  onSuccess,
  onError,
}: ConfirmButtonProps) {
  return (
    <Button
      tone={tone}
      size={size}
      fullWidth={fullWidth}
      disabled={disabled}
      className={className}
      confirm={{ label: confirmLabel, holdMs, hint: "길게 누르거나, 두 번 눌러 확인해요" }}
      action={async () => {
        await onConfirm();
      }}
      onSuccess={onSuccess}
      onError={onError}
    >
      {label}
    </Button>
  );
}
