import { AnimatePresence, motion } from "framer-motion";
import { useCallback, useId, useRef, useState, type FocusEvent, type HTMLAttributes, type ReactNode, type Ref } from "react";
import { ContentSwap } from "../motion/ContentSwap";
import { t } from "../motion/springs";
import { Icon } from "./Icon";
import { copy } from "./Text";
import "./TextField.css";

/**
 * Text field (HIG text fields + entering data): visible label, ≥16px text (17px), 52px tall, r14, focus ring at once
 * on the field's own radius, inline error with an icon that opens in flow on a height spring (never a shake),
 * aria-invalid/aria-describedby, a clear button while focused with a value, and a secure toggle for passwords.
 */
export interface TextFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: "text" | "email" | "tel" | "password" | "url" | "search" | "number";
  error?: string;
  hint?: ReactNode;
  placeholder?: string;
  autoComplete?: string;
  inputMode?: HTMLAttributes<HTMLInputElement>["inputMode"];
  enterKeyHint?: HTMLAttributes<HTMLInputElement>["enterKeyHint"];
  autoCapitalize?: string;
  name?: string;
  id?: string;
  disabled?: boolean;
  required?: boolean;
  maxLength?: number;
  autoFocus?: boolean;
  onBlur?: (e: FocusEvent<HTMLInputElement>) => void;
  onFocus?: (e: FocusEvent<HTMLInputElement>) => void;
  /** Enter pressed (IME-safe) */
  onEnter?: () => void;
  trailing?: ReactNode;
  /** decorative content before the text (e.g. the agent's face next to its name); aria-hidden */
  leading?: ReactNode;
  /** "plain" = paper field (default), "filled" = recessed fill (on paper cards) */
  variant?: "filled" | "plain";
  className?: string;
  ref?: Ref<HTMLInputElement>;
}

export function TextField({
  label,
  value,
  onChange,
  type = "text",
  error,
  hint,
  placeholder,
  autoComplete,
  inputMode,
  enterKeyHint,
  autoCapitalize,
  name,
  id,
  disabled,
  required,
  maxLength,
  autoFocus,
  onBlur,
  onFocus,
  onEnter,
  trailing,
  leading,
  variant = "plain",
  className,
  ref,
}: TextFieldProps) {
  const auto = useId().replace(/:/g, "");
  const inputId = id ?? `tf-${auto}`;
  const errorId = `${inputId}-error`;
  const hintId = `${inputId}-hint`;
  const [focused, setFocused] = useState(false);
  const [reveal, setReveal] = useState(false);
  const local = useRef<HTMLInputElement | null>(null);
  const setRef = useCallback(
    (el: HTMLInputElement | null) => {
      local.current = el;
      if (typeof ref === "function") ref(el);
      else if (ref && typeof ref === "object") (ref as { current: HTMLInputElement | null }).current = el;
    },
    [ref],
  );

  const isPassword = type === "password";
  const showClear = focused && !!value && !isPassword && !disabled;
  const describedBy = [error ? errorId : null, hint && !error ? hintId : null].filter(Boolean).join(" ") || undefined;

  return (
    <div className={`tf tf--${variant}${error ? " is-invalid" : ""}${disabled ? " is-disabled" : ""}${className ? ` ${className}` : ""}`}>
      <label htmlFor={inputId} className="tf-label">
        {label}
        {required && <span className="sr-only"> (필수)</span>}
      </label>
      <div className="tf-box">
        {leading ? (
          <span className="tf-leading" aria-hidden="true">
            {leading}
          </span>
        ) : null}
        <input
          ref={setRef}
          id={inputId}
          className="tf-input"
          type={isPassword && reveal ? "text" : type}
          value={value}
          name={name}
          placeholder={placeholder}
          autoComplete={autoComplete}
          inputMode={inputMode}
          enterKeyHint={enterKeyHint}
          autoCapitalize={autoCapitalize}
          disabled={disabled}
          required={required}
          maxLength={maxLength}
          autoFocus={autoFocus}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          onChange={(e) => onChange(e.target.value)}
          onFocus={(e) => {
            setFocused(true);
            onFocus?.(e);
          }}
          onBlur={(e) => {
            setFocused(false);
            onBlur?.(e);
          }}
          onKeyDown={(e) => {
            if (e.key !== "Enter" || e.nativeEvent.isComposing || e.keyCode === 229) return;
            if (onEnter) {
              e.preventDefault();
              onEnter();
            }
          }}
        />
        <AnimatePresence initial={false}>
          {showClear && (
            <motion.button
              key="clear"
              type="button"
              className="tf-btn"
              aria-label="입력 지우기"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0, transition: { duration: 0.12 } }}
              transition={t("fade")}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                onChange("");
                local.current?.focus();
              }}
            >
              <span className="tf-clear-dot">
                <Icon name="close" size={12} weight="semibold" />
              </span>
            </motion.button>
          )}
        </AnimatePresence>
        {isPassword && (
          <button
            type="button"
            className={`tf-btn tf-eye${reveal ? " is-on" : ""}`}
            aria-label={reveal ? "비밀번호 숨기기" : "비밀번호 보기"}
            aria-pressed={reveal}
            disabled={disabled}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setReveal((r) => !r)}
          >
            <Icon name="eye" size={20} />
          </button>
        )}
        {trailing && <span className="tf-trailing">{trailing}</span>}
      </div>
      <AnimatePresence initial={false}>
        {error && (
          <motion.div
            key="error"
            className="tf-error-wrap"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1, transition: { height: t("morph"), opacity: { ...(t("fade") as object), delay: 0.06 } } }}
            exit={{ height: 0, opacity: 0, transition: { height: t("morph"), opacity: { duration: 0.12 } } }}
          >
            <p id={errorId} className="tf-error t-copy" role="alert">
              <Icon name="exclamation" size={16} />
              <ContentSwap swapKey={error}>{copy(error)}</ContentSwap>
            </p>
          </motion.div>
        )}
      </AnimatePresence>
      {hint && !error && (
        <p id={hintId} className="tf-hint t-copy">
          {copy(hint)}
        </p>
      )}
    </div>
  );
}

