import type { InvestEventCard } from "@pickle/protocol";
import { Fragment, type ReactNode } from "react";
import { IvDisclaimer, IvFoot } from "../../../ui/Invest";
import { copy, glued } from "../../../ui/Text";

/** "(미 동부 16:20)" or the words after the last " · " ("시각 미정"): one box each */
const WHEN_GROUP = /\([^()]{1,24}\)| · ([^·()]{1,8})$/;

/**
 * the server's when ("11월 28일 06:20(미 동부 16:20)", "미 동부 11월 27일 · 시각 미정"): a line breaks before "(" or after
 * " · ", never inside the bracket or the last words (at 320 and 130 % it broke "(미 / 동부 16:20)"). The same box as the
 * card foot's (ui/Invest .ivfoot-tie, DD 2224).
 */
/**
 * a box's words, each its own span: past its line the box breaks only at a space. As one text node WebKit's keep-all
 * broke inside "16:20" ("(미 동부 16:" / "20)", DD 2225 N4); a word that is its own element it never breaks (measured,
 * 300–430 px at text scales 1, 1.15 and 1.3: 0 words split in either engine, against 11, 41 and 67 widths in WebKit as
 * one text node), so the spans need no nowrap of their own
 */
function words(tie: string): ReactNode {
  const ws = tie.split(" ");
  return ws.map((w, i) => (
    <Fragment key={i}>
      {i > 0 ? " " : null}
      <span className="ivwhen-word">{w}</span>
    </Fragment>
  ));
}

export function whenText(text: string): ReactNode {
  const m = WHEN_GROUP.exec(text);
  if (!m) return glued(text);
  const tie = m[1] ?? m[0];
  const at = m.index + m[0].length - tie.length;
  const pre = text.slice(0, at);
  const post = text.slice(at + tie.length);
  return (
    <>
      {pre && glued(pre)}
      <span className="ivfoot-tie">{words(tie)}</span>
      {post && glued(post)}
    </>
  );
}

/**
 * The D-1 card `invest_event` (DD 0109 §1; the server's invest/events.ts eventCard): an event the day before its market
 * date, at 08:00 KST. No button, no press (the list of events has no screen yet).
 *   one event: its heading as the title (title3), when (KST first, the market's time in brackets; tnum), then 출처 · 등급
 *   several on one day: one card, `일정 N개`; each event its heading, when, and 출처 · 등급 as its second line
 * Every word and date is the server's. The closing sentence ends it (A17).
 */
export function InvestEventCardView({ card }: { card: InvestEventCard }) {
  const one = card.rows.length === 1 ? card.rows[0]! : null;
  return (
    <section className="ccard ivcard" aria-label={card.title} data-card="invest_event">
      <h3 className="ccard-title ivcard-title ivevent-title">{copy(card.title, { sentences: false })}</h3>
      {one ? (
        <div className="ivevent-one">
          <p className="ivevent-when tnum">{whenText(one.when)}</p>
          <IvFoot>{one.foot}</IvFoot>
        </div>
      ) : (
        <div className="ivevent-rows">
          {card.rows.map((r) => (
            <div key={r.eventId} className="ivevent-row">
              <p className="ivevent-name">{copy(r.title, { sentences: false })}</p>
              <p className="ivevent-when tnum">{whenText(r.when)}</p>
              <IvFoot>{r.foot}</IvFoot>
            </div>
          ))}
        </div>
      )}
      {card.disclaimer && (
        <div className="ivcard-foot">
          <IvDisclaimer />
        </div>
      )}
    </section>
  );
}
