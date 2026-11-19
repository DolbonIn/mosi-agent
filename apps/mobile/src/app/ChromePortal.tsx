import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { BlurGroupContext, getNamedBlurGroup, onNamedBlurGroups } from "../ui/Glass";

/**
 * Render screen-owned floating glass INTO a shell bar group so it shares that group's single backdrop-filter
 * (≤ 3 on screen). The chat composer does this:
 *   <ChromePortal group="bottom"><Glass blur="group" radius={R.composer} text lens>…composer…</Glass></ChromePortal>
 * The bottom slot sits just above the tab bar (`.chrome-slot`, bottom-anchored, full width, gutter 12px). Both are
 * static (the §8.8 minimise was removed, user-rejected): the slot applies `--composer-inset-start` (12px) as its direct
 * child's margin-inline-start — don't add it again.
 */
export function ChromePortal({ group = "bottom", children }: { group?: "bottom" | "top"; children: ReactNode }) {
  const [entry, setEntry] = useState(() => getNamedBlurGroup(group));
  useEffect(() => {
    setEntry(getNamedBlurGroup(group));
    const off = onNamedBlurGroups(() => setEntry(getNamedBlurGroup(group)));
    return () => {
      off();
    };
  }, [group]);
  const slot = entry?.host.querySelector<HTMLElement>(":scope > .chrome-slot") ?? null;
  if (!entry || !slot) return null;
  return createPortal(<BlurGroupContext.Provider value={entry.api}>{children}</BlurGroupContext.Provider>, slot);
}
