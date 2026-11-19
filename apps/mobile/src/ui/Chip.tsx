import { motion } from "framer-motion";
import type { ReactNode } from "react";
import { ContentSwap } from "../motion/ContentSwap";
import { usePress } from "../motion/usePress";
import { Icon, type AppIconName } from "./Icon";
import "./Chip.css";

/**
 * Chip — a capsule on paper (r = h/2). Neutral = fill + label; selected = accent fill + on-accent text (accent only
 * for selected). Press = opaque lift 1.03 + 6 % darker fill (never shrinks). md is 36px tall inside a 44px hit area.
 * The label changes by the content swap. Colour change rides the `snap` spring (CSS tokens).
 */
export interface ChipProps {
  label: string;
  icon?: AppIconName;
  selected?: boolean;
  onClick?: () => void;
  size?: "sm" | "md";
  trailing?: ReactNode;
  disabled?: boolean;
  className?: string;
  /** when the label alone is not descriptive */
  ariaLabel?: string;
}

export function Chip({ label, icon, selected, onClick, size = "md", trailing, disabled, className, ariaLabel }: ChipProps) {
  const press = usePress({ kind: "opaque", scale: 1.03, disabled: !onClick || disabled });
  const cls = `chip chip--${size}${selected ? " is-selected" : ""}${className ? ` ${className}` : ""}`;
  const inner = (
    <>
      {icon && <Icon name={icon} size={size === "sm" ? 15 : 17} weight="medium" />}
      <ContentSwap swapKey={label} className="chip-label">
        {label}
      </ContentSwap>
      {trailing}
    </>
  );
  if (!onClick) {
    return (
      <span className={cls} aria-label={ariaLabel}>
        {inner}
      </span>
    );
  }
  return (
    <motion.button
      type="button"
      className={cls}
      style={{ scale: press.scale }}
      aria-pressed={selected === undefined ? undefined : selected}
      aria-label={ariaLabel}
      disabled={disabled}
      onPointerDown={press.bind.onPointerDown}
      onClick={onClick}
    >
      {inner}
    </motion.button>
  );
}

/** Horizontal, snap-scrolling row of chips (edge padding 16, hidden scrollbar). */
export function ChipGroup({ children, label, className }: { children: ReactNode; label?: string; className?: string }) {
  return (
    <div role="group" aria-label={label} className={`chip-group${className ? ` ${className}` : ""}`}>
      {children}
    </div>
  );
}
