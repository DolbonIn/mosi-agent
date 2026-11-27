import type { ReactNode } from "react";
import { SignalMark } from "../../../ui/Invest";
import { copyOf } from "../parts";

/**
 * A notice at the top of a group (DD 2010 §4 / §7, DD 0103-b A): a SignalMark and one line in --label, the mark
 * carrying the tone. Pressable only where it leads to the fix (an unverified number, a key to put in again).
 */
export function NoticeRow({ signal, text, className, onPress }: { signal: "risk" | "caution"; text: string; className: string; onPress?: (el: HTMLElement) => void }) {
  const line: ReactNode = (
    <span className="iv-notice-line">
      <SignalMark signal={signal} className="iv-mark" />
      <span className="t-copy tnum">{copyOf(text)}</span>
    </span>
  );
  const cls = `list-row iv-notice is-${signal === "risk" ? "danger" : "caution"} ${className}`;
  if (onPress)
    return (
      <button type="button" className={`${cls} is-clickable`} onClick={(e) => onPress(e.currentTarget)}>
        <span className="list-row-main">{line}</span>
      </button>
    );
  return (
    <div className={cls}>
      <span className="list-row-main">{line}</span>
    </div>
  );
}
