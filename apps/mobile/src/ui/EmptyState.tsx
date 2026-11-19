import { motion } from "framer-motion";
import type { ReactNode } from "react";
import { SPRING } from "../motion/springs";
import { useTierValue } from "../motion/tier";
import { Icon, type AppIconName } from "./Icon";
import { copy } from "./Text";
import "./EmptyState.css";

/**
 * Empty state: a bare glyph (no plate), a title, a short body and at most one action. Arrives once
 * with a 6 px rise (morph) and a fade; never loops. Reduced motion: simply there.
 */
export interface EmptyStateProps {
  icon: AppIconName;
  title: string;
  body?: ReactNode;
  action?: ReactNode;
  className?: string;
}

export function EmptyState({ icon, title, body, action, className }: EmptyStateProps) {
  const reduce = useTierValue("reduceMotion");
  return (
    <motion.div
      className={`empty-state${className ? ` ${className}` : ""}`}
      initial={reduce ? false : { opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ y: SPRING.morph, opacity: SPRING.fade }}
    >
      <span className="empty-state__plate">
        <Icon name={icon} size={30} />
      </span>
      <h2 className="empty-state__title">{title}</h2>
      {body ? <p className="empty-state__body t-copy">{copy(body)}</p> : null}
      {action ? <div className="empty-state__action">{action}</div> : null}
    </motion.div>
  );
}
