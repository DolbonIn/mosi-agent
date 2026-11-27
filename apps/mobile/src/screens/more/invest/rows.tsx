import type { ReactNode } from "react";
import { InvestNum } from "../../../ui/Invest";
import { ListRow, ListSection } from "../../../ui/List";
import { copyOf, Foot } from "../parts";
import { presentPhone } from "../profile/PhoneSheet";
import { NoticeRow } from "./NoticeRow";
import { presentRule } from "./RuleSheet";
import { isLiveSale, pricePhrase, rulesFoot } from "./rules";
import type { InvestNum as InvestNumber, InvestOverview, InvestRuleRow, InvestSymbolRow } from "@pickle/protocol";

/**
 * The rows 투자 and its symbol screen share (DD 1935 §3-2 ②③, DD 0914 D1): a watched symbol's row, a symbol's rule
 * group, an empty section. Every word and number in them is the server's.
 */

/** a route's own screen: a second 투자 screen can sit on the stack (a chat card opens one over the first) */
export const routeClass = (key: string) => `iv-route-${key.replace(/[^A-Za-z0-9_-]/g, "-")}`;

/** the server's number text for ui/InvestNum, or null where it has no number (InvestNum then says 확인 불가) */
export const numText = (n: InvestNumber | null | undefined): string | null => (n && n.v !== null ? n.text : null);

/** a section with nothing to list: its title and one footnote, no card (AgentScreen's grammar) */
export function EmptySection({ title, className, children }: { title: string; className: string; children: string }) {
  return (
    <section className={`list-section iv-empty ${className}`}>
      <div className="list">
        <div className="list-header">
          <h2 className="list-section-title">{title}</h2>
        </div>
        <Foot className="iv-empty-foot">{children}</Foot>
      </div>
    </section>
  );
}

/** ②'s row: the symbol and its name (or the holding line), the price and the change; pressed, the symbol's screen */
export function WatchRow({ w, onPress }: { w: InvestSymbolRow; onPress?: () => void }) {
  const h = w.holding;
  const body = (
    <span className="list-row-main">
      <span className="iv-two">
        <span className="iv-symbol">{w.symbol}</span>
        <span className={`iv-second t-copy${h ? " tnum" : ""}`}>{h ? h.line : w.name}</span>
      </span>
      <span className="iv-two is-end">
        <InvestNum value={numText(w.price)} className="iv-price" />
        {numText(w.price) !== null && w.change && <InvestNum value={numText(w.change)} className={`iv-change${w.stale ? " is-stale" : ""}`} />}
      </span>
    </span>
  );
  if (!onPress) return <div className="list-row iv-watch-row">{body}</div>;
  return (
    <button type="button" className={`list-row is-clickable iv-watch-row iv-watch-${w.symbol}`} onClick={onPress}>
      {body}
    </button>
  );
}

/** ③'s foot (G8-5): the paragraphs rulesFoot gives for the mode */
export function rulesFootNode(mode: InvestOverview["mode"], agentName: string): ReactNode {
  return rulesFoot(mode, agentName).map((p) => (
    <p key={p} className="iv-foot-p">
      {copyOf(p)}
    </p>
  ));
}

/**
 * One symbol's rules: the phone notice first when it applies, the rows, and 규칙 추가 last. `scope` is the route's own
 * class, so a sheet opened from 규칙 추가 springs from this screen's row, not from a screen under it on the stack.
 */
export function RuleGroup({
  d,
  symbol,
  rules,
  title,
  footer,
  notice,
  scope,
}: {
  d: InvestOverview;
  symbol: string;
  rules: InvestRuleRow[];
  title: string;
  footer?: ReactNode;
  notice: { text: string; verify: boolean } | null;
  scope: string;
}) {
  return (
    <ListSection title={title} footer={footer} className="iv-rules">
      {notice && <PhoneNotice {...notice} />}
      {rules.map((r) => (
        <RuleRow key={r.id} r={r} d={d} />
      ))}
      <ListRow
        title="규칙 추가"
        chevron={false}
        className={`iv-add iv-add-rule-${symbol}`}
        onClick={() => presentRule(document.querySelector<HTMLElement>(`.${scope} .iv-add-rule-${CSS.escape(symbol)}`), { symbol, rule: null })}
      />
    </ListSection>
  );
}

/** calls cannot be placed (DD 2010 §4): said once, at the top; an unverified number leads to verifying it */
function PhoneNotice({ text, verify }: { text: string; verify: boolean }) {
  return <NoticeRow signal="caution" text={text} className="iv-phone-notice" onPress={verify ? (el) => presentPhone(el) : undefined} />;
}

function RuleRow({ r, d }: { r: InvestRuleRow; d: InvestOverview }) {
  return (
    <button type="button" className={`list-row is-clickable iv-rule-row iv-rule-${r.id}`} onClick={(e) => presentRule(e.currentTarget, { symbol: r.symbol, rule: r })}>
      <span className="list-row-main">
        <span className="iv-rule-title tnum">
          <PriceTied text={r.left} />
        </span>
        <span className="iv-two is-end">
          <span className={`iv-action${isLiveSale(r, d.mode) ? " is-live" : ""}`}>{r.actionText}</span>
          <span className={`iv-state tnum${r.state === "expired" ? " is-expired" : ""}`}>{r.stateText}</span>
        </span>
      </span>
    </button>
  );
}

/** the server's rule text with its price phrase on one line */
function PriceTied({ text }: { text: string }) {
  const p = pricePhrase(text);
  if (!p) return <>{text}</>;
  return (
    <>
      {p[0]}
      <span className="iv-tie">{p[1]}</span>
      {p[2]}
    </>
  );
}
