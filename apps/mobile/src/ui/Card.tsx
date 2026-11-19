import type { CSSProperties, HTMLAttributes, KeyboardEvent, ReactNode } from "react";
import { concentric } from "./geometry";
import "./Card.css";

/**
 * Paper (MOTION-SPEC §1 content layer): opaque --surface, radius 24, padding 18, a soft two-layer shadow (dark: a
 * hairline instead). Pressable cards answer with a FLAT tint — paper never lifts or grows. Tiles inside use the
 * concentric radius (radius − padding → 12).
 */
export interface CardProps extends Omit<HTMLAttributes<HTMLElement>, "onClick" | "children"> {
  children?: ReactNode;
  padding?: number;
  radius?: number;
  as?: "div" | "section" | "article" | "li";
  onClick?: () => void;
  className?: string;
  style?: CSSProperties;
}

export function Card({ children, padding = 18, radius = 24, as: Tag = "div", onClick, className, style, onKeyDown, onKeyUp, ...rest }: CardProps) {
  const pressable = !!onClick;
  const vars = {
    "--paper-r": `${radius}px`,
    "--paper-pad": `${padding}px`,
    "--tile-r": `${concentric(radius, padding)}px`,
    ...style,
  } as CSSProperties;
  return (
    <Tag
      className={`paper${className ? ` ${className}` : ""}`}
      style={vars}
      data-pressable={pressable ? "" : undefined}
      role={pressable ? "button" : undefined}
      tabIndex={pressable ? 0 : undefined}
      onClick={onClick}
      onKeyDown={(e: KeyboardEvent<HTMLElement>) => {
        onKeyDown?.(e as never);
        if (!pressable || e.defaultPrevented || e.target !== e.currentTarget) return;
        if (e.key === "Enter") {
          e.preventDefault();
          onClick?.();
        } else if (e.key === " ") e.preventDefault();
      }}
      onKeyUp={(e: KeyboardEvent<HTMLElement>) => {
        onKeyUp?.(e as never);
        if (pressable && e.key === " " && e.target === e.currentTarget) onClick?.();
      }}
      {...rest}
    >
      {children}
    </Tag>
  );
}

export interface CardHeaderProps {
  title: ReactNode;
  detail?: ReactNode;
  action?: ReactNode;
  className?: string;
}

export function CardHeader({ title, detail, action, className }: CardHeaderProps) {
  return (
    <div className={`paper-header${className ? ` ${className}` : ""}`}>
      <h3 className="paper-header__title">{title}</h3>
      {detail !== undefined ? <span className="paper-header__detail tnum">{detail}</span> : null}
      {action ? <span className="paper-header__action">{action}</span> : null}
    </div>
  );
}

export interface CardTileProps {
  children?: ReactNode;
  padding?: number;
  className?: string;
  style?: CSSProperties;
}

/** Inner tile: recessed paper with the card's concentric radius. */
export function CardTile({ children, padding = 12, className, style }: CardTileProps) {
  return (
    <div className={`paper-tile${className ? ` ${className}` : ""}`} style={{ padding, ...style }}>
      {children}
    </div>
  );
}
