import { motion } from "framer-motion";
import type { KeyboardEvent, ReactNode } from "react";
import { t } from "../motion/springs";
import { Icon, type AppIconName } from "./Icon";
import { copy } from "./Text";
import "./List.css";

/**
 * Inset grouped list (HIG lists and tables): a paper group r20, 54px rows, icon plates 30×30 r8, hairline separators
 * inset to the text start, chevrons for navigation. Rows answer a press with a FLAT tint (a row never grows); keyboard
 * focus highlights the whole row. `layoutId` on a row title lets a pushed screen morph it into its large title.
 */
export interface ListProps {
  header?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
  className?: string;
  /** accessible name for the group when there is no visible header */
  label?: string;
}

export function List({ header, footer, children, className, label }: ListProps) {
  return (
    <div className={`list${className ? ` ${className}` : ""}`}>
      {header && <div className="list-header">{header}</div>}
      <div className="list-card" role="group" aria-label={label}>
        {children}
      </div>
      {footer && <div className="list-footer t-copy">{copy(footer)}</div>}
    </div>
  );
}

export interface ListRowProps {
  icon?: AppIconName;
  /** custom leading visual (e.g. a brand logo) in the same 30×30 slot, in place of the icon plate; decorative
   * (aria-hidden) — the title names the row. Wins over `icon` when both are set. */
  leading?: ReactNode;
  /** plate background (e.g. "hsl(212 90% 52%)"); the glyph turns white. Default: neutral fill with a label glyph */
  iconTint?: string;
  title: ReactNode;
  subtitle?: ReactNode;
  /** trailing value (label-2, tabular numbers) */
  detail?: ReactNode;
  /** trailing control, e.g. a Toggle */
  accessory?: ReactNode;
  /** default: true when the row is clickable and not destructive */
  chevron?: boolean;
  onClick?: () => void;
  destructive?: boolean;
  disabled?: boolean;
  /** shared-element id for the title → large title morph */
  layoutId?: string;
  className?: string;
  ariaLabel?: string;
}

export function ListRow({ icon, leading, iconTint, title, subtitle, detail, accessory, chevron, onClick, destructive, disabled, layoutId, className, ariaLabel }: ListRowProps) {
  const clickable = !!onClick;
  const showChevron = chevron ?? (clickable && !destructive);
  const cls = `list-row${clickable ? " is-clickable" : ""}${destructive ? " is-destructive" : ""}${disabled ? " is-disabled" : ""}${className ? ` ${className}` : ""}`;
  const titleNode = layoutId ? (
    <motion.span layoutId={layoutId} className="list-row-title t-copy" transition={{ layout: t("morph") }}>
      {copy(title)}
    </motion.span>
  ) : (
    <span className="list-row-title t-copy">{copy(title)}</span>
  );
  const body = (
    <>
      {leading !== undefined && leading !== null && leading !== false ? (
        <span className="list-row-lead" aria-hidden="true">
          {leading}
        </span>
      ) : (
        icon && (
          <span className={`list-row-plate${iconTint ? " is-tinted" : ""}`} style={iconTint ? { background: iconTint } : undefined} aria-hidden="true">
            <Icon name={icon} size={19} weight="medium" />
          </span>
        )
      )}
      <span className="list-row-main">
        <span className="list-row-text t-cell">
          {titleNode}
          {subtitle && <span className="list-row-sub t-copy">{copy(subtitle)}</span>}
        </span>
        {detail !== undefined && detail !== null && <span className="list-row-detail tnum">{detail}</span>}
        {accessory && (
          <span
            className="list-row-accessory"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e: KeyboardEvent) => e.stopPropagation()}
          >
            {accessory}
          </span>
        )}
        {showChevron && (
          <span className="list-row-chevron" aria-hidden="true">
            <Icon name="chevron-right" size={16} weight="semibold" />
          </span>
        )}
      </span>
    </>
  );
  // A row with an accessory is a <div>: the accessory (e.g. a Toggle) is the keyboard control, and a tap on the row
  // body may forward to onClick (no nested interactive elements).
  if (clickable && !accessory) {
    return (
      <button type="button" className={cls} onClick={onClick} disabled={disabled} aria-label={ariaLabel}>
        {body}
      </button>
    );
  }
  return (
    <div className={cls} aria-label={ariaLabel} aria-disabled={disabled || undefined} onClick={disabled ? undefined : onClick}>
      {body}
    </div>
  );
}

export interface ListSectionProps {
  title?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
  className?: string;
  /** heading level of the title: 2 on a screen (right under its large-title h1), 3 inside a sheet */
  level?: 2 | 3;
}

/** A section header (13px, 600, label-2) above an inset grouped list. */
export function ListSection({ title, footer, children, className, level = 2 }: ListSectionProps) {
  const H = level === 3 ? "h3" : "h2";
  return (
    <section className={`list-section${className ? ` ${className}` : ""}`}>
      <List header={title ? <H className="list-section-title">{title}</H> : undefined} footer={footer}>
        {children}
      </List>
    </section>
  );
}
