import type { ReactNode } from "react";
import { DISCLAIMER, SIGNAL_SHAPES, SIGNAL_VIEWBOX, SIGNAL_WORD, UNKNOWN_TEXT, type Signal } from "@pickle/quant";
import { glued } from "./Text";
import "./Invest.css";

/**
 * 투자's shared parts (DD 1935 §0-4, §1, §0-7). Numbers arrive already formatted by @pickle/quant's formatter (the one
 * the server and the deck use), so no screen formats a number of its own.
 *
 *   <SignalMark signal="risk" />              the mark alone (1em, aria-hidden; the word beside it speaks)
 *   <SignalLabel signal="caution" />          mark + word (경계), both in the signal's colour
 *   <InvestNum value="+2.31%" />             a formatted number, tabular; null → the 확인 불가 mark + words
 *   <IvRows><IvRow label="현재가" value="$32.57" /></IvRows>
 *   <IvFoot>관측 11월 27일 00:45(미 동부 10:45) · 토스증권 · A</IvFoot>
 *   <IvDisclaimer />                         the fixed sentence, word for word, once per message
 *   <IvHero value="$32.57" />                the card's one big number
 *   <ModeWord mode="real" />                 모의 (--label-2) / 실제 (--danger), text only
 */

/** the signal's shape from the shared set (the deck draws the same SVG) */
export function SignalMark({ signal, className }: { signal: Signal; className?: string }) {
  return (
    <svg
      className={`sigmark ${className ?? ""}`}
      viewBox={SIGNAL_VIEWBOX}
      aria-hidden="true"
      data-signal={signal}
      dangerouslySetInnerHTML={{ __html: SIGNAL_SHAPES[signal] }}
    />
  );
}

/** the mark and its word together: 위험, 경계, 정상, 확인 불가 */
export function SignalLabel({ signal, className }: { signal: Signal; className?: string }) {
  return (
    <span className={`ivsig ${className ?? ""}`} data-signal={signal}>
      <SignalMark signal={signal} />
      {SIGNAL_WORD[signal]}
    </span>
  );
}

/** a number from the shared formatter, tabular; missing → 확인 불가 with its mark, in the number's place (never 0 or "-") */
export function InvestNum({ value, className }: { value: string | null | undefined; className?: string }) {
  if (value == null || value === "")
    return (
      <span className={`ivsig ivunknown ${className ?? ""}`} data-signal="unknown">
        <SignalMark signal="unknown" />
        {UNKNOWN_TEXT}
      </span>
    );
  return <span className={`tnum ${className ?? ""}`}>{figure(value)}</span>;
}

const EST = "(추정)";
/** a formatted figure; an estimate's trailing "(추정)" in --label-2 (DD 1935 §0-5, DD 2224): "약 $1,204.00(추정)" */
function figure(value: string): ReactNode {
  if (!value.endsWith(EST) || value.length === EST.length) return glued(value);
  return (
    <>
      {glued(value.slice(0, -EST.length))}
      <span className="ivest">{EST}</span>
    </>
  );
}

/** a card's group of rows: a hairline and 12px above, 6px between rows */
export function IvRows({ children }: { children: ReactNode }) {
  return <div className="ivrows">{children}</div>;
}

/** one row: the word left, the value right (a formatted string, or a node such as a SignalLabel) */
export function IvRow({ label, value }: { label: string; value: string | null | ReactNode }) {
  return (
    <div className="ivrow">
      <span className="ivrow-label">{label}</span>
      <span className="ivrow-value">{typeof value === "string" || value == null ? <InvestNum value={value as string | null} /> : value}</span>
    </div>
  );
}

/** a short bracketed part with the " ·" after it: "(미 동부 10:45) ·" */
const FOOT_GROUP = /\([^()]{1,24}\)(?: ·)?/;

/**
 * the card's foot line: observed time and source (dates and times kept whole by the app's ties). A bracketed part and
 * the " ·" after it are one box (DD 2224: "미 동부 / 10:45)" at 320, text size 130 %), so a line breaks before "(" or
 * after " · ", never inside it.
 */
export function IvFoot({ children }: { children: string }) {
  const m = FOOT_GROUP.exec(children);
  if (!m) return <p className="ivfoot">{glued(children)}</p>;
  const pre = children.slice(0, m.index);
  const post = children.slice(m.index + m[0].length);
  return (
    <p className="ivfoot">
      {pre && glued(pre)}
      <span className="ivfoot-tie">{m[0]}</span>
      {post && glued(post, m[0])}
    </p>
  );
}

/** the fixed closing sentence (A17 = FA9's first), word for word from @pickle/quant; never written by the model */
export function IvDisclaimer() {
  return <p className="ivdisclaimer">{DISCLAIMER}</p>;
}

/** the card's one big number */
export function IvHero({ value }: { value: string | null }) {
  return <div className="ivhero">{value == null ? <InvestNum value={null} /> : figure(value)}</div>;
}

/** 모의 / 실제 as a word (13/600), no chip */
export function ModeWord({ mode }: { mode: "mock" | "real" }) {
  return (
    <span className="ivmode" data-mode={mode}>
      {mode === "real" ? "실제" : "모의"}
    </span>
  );
}
