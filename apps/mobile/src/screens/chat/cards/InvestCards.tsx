import type { InvestAlertCard, InvestCall, InvestNum as Num, InvestStopCard } from "@pickle/protocol";
import { UNKNOWN_TEXT, type Signal } from "@pickle/quant";
import { getScreen, nav } from "../../../app/nav";
import { IvDisclaimer, IvFoot, IvHero, IvRow, IvRows, ModeWord, SignalMark } from "../../../ui/Invest";
import { copy } from "../../../ui/Text";
import { copyText } from "../../more/archive/share";
import { island } from "../../../app/island";
import "./InvestCards.css";

/**
 * The chat's 투자 cards (DD 1935 §2; 2010 §2·3·5; 2100 C1). The server writes every word and figure (@pickle/quant
 * format.ts): a card draws what it is given and never formats a number again (DD 1935 §0-5).
 *   invest_alert  a price alert: glyph by tone, title + KST time, the price, rows, the call line, notes, foot, 규칙 보기
 *   invest_stop   a stop record (모의 / 실제): mode word first, title, the price, rows, status, reason, notes, foot
 * The fixed closing sentence comes once per message, on the card the server marked (`disclaimer`, DD 1935 §0-7).
 */

/** a row's value: the server's "확인 불가" is the mark and its words in the number's place (DD 1935 §0-4) */
const cell = (value: string): string | null => (value.trim() === UNKNOWN_TEXT ? null : value);

/** a figure from the server: missing → 확인 불가 */
const figure = (n: Num | undefined): string | null => (n && n.v != null && n.text ? n.text : null);

/** the card's lines (title lines, notes): one sentence block each, ties kept (DD 1949: numbers and dates whole) */
function Lines({ lines, className }: { lines: string[] | undefined; className: string }) {
  if (!lines?.length) return null;
  return (
    <div className={className}>
      {lines.map((l, i) => (
        <p key={i}>{copy(l)}</p>
      ))}
    </div>
  );
}

/** 전화로 알렸어요 · 00:46, or the half mark and 전화를 걸지 못했어요 · {까닭} (DD 2010 §5) */
function CallLine({ call }: { call: InvestCall }) {
  return (
    <p className="ivcall" data-ok={call.ok ? "true" : "false"}>
      {!call.ok && <SignalMark signal="caution" />}
      {copy(call.text, { sentences: false })}
    </p>
  );
}

/**
 * 규칙 보기 opens 투자 at the symbol's rules (screens-more's screen) on the profile tab; hidden while that screen is not
 * in the app. A symbol's own alert (a gap, a split pause) names no rule: the screen opens at the symbol all the same.
 * Whatever 투자 screen is already on top there (the list, another symbol) gets the symbol's screen pushed over it; only
 * the very same one (symbol and rule) is not stacked twice (lead 2122).
 */
export function openRules(symbol: string, ruleId?: string): void {
  nav.setTab("profile");
  const top = nav.current();
  if (top?.screen === "invest" && top.params?.symbol === symbol && top.params?.ruleId === ruleId) return;
  nav.push("invest", ruleId ? { symbol, ruleId } : { symbol }, { title: "투자" });
}

function alertGlyph(card: InvestAlertCard): Signal | null {
  if (card.tone === "danger") return "risk";
  if (card.tone === "caution") return "caution";
  return null;
}

export function InvestAlertCardView({ card, interactive = true }: { card: InvestAlertCard; interactive?: boolean }) {
  const glyph = alertGlyph(card);
  const price = card.kind === "expired" ? undefined : card.price;
  return (
    <section className="ccard ivcard" aria-label={card.title} data-card="invest_alert" data-kind={card.kind}>
      <div className="ccard-head ivcard-head">
        <h3 className="ccard-title ivcard-title">
          {glyph && <SignalMark signal={glyph} className="ivcard-glyph" />}
          {copy(card.title, { sentences: false })}
        </h3>
        <span className="ccard-source tnum">{card.atText}</span>
      </div>
      <Lines lines={card.titleLines} className="ivcard-lines" />
      {price && (
        <div className="ivcard-price">
          <IvHero value={figure(price)} />
          {card.sub && <p className="ivcard-sub">{copy(card.sub, { sentences: false })}</p>}
        </div>
      )}
      {card.rows.length > 0 && (
        <IvRows>
          {card.rows.map((r) => (
            <IvRow key={r.label} label={r.label} value={cell(r.value)} />
          ))}
        </IvRows>
      )}
      {card.call && <CallLine call={card.call} />}
      <Lines lines={card.notes} className="ivcard-notes" />
      <div className="ivcard-foot">
        <IvFoot>{card.foot}</IvFoot>
        {card.disclaimer && <IvDisclaimer />}
      </div>
      {interactive && getScreen("invest") && (
        <button type="button" className="ccard-more" onClick={() => openRules(card.symbol, card.ruleId)}>
          규칙 보기
        </button>
      )}
    </section>
  );
}

type StopGlyph = NonNullable<InvestStopCard["glyph"]>;

/**
 * the stop card's one mark (DD 2314 §5): the server's glyph first (a real card: loader while something is still to
 * come, check after FILLED, fail, caution; a planned order none); a mock record has none and goes by its state:
 * skipped at zero sellable the half circle, recorded none
 */
function stopGlyph(card: InvestStopCard): StopGlyph | null {
  if (card.glyph) return card.glyph;
  return card.state === "skipped" ? "caution" : null;
}

/**
 * loader: a small spinner (still under reduced motion), always on a status line (it comes with one); check: the stroke,
 * always before the title (filled has no status line, DD 0117); fail / caution: the full / half circle, either place.
 * `className` for the title's place (.ivcard-glyph)
 */
function StopMark({ glyph, className }: { glyph: StopGlyph; className?: string }) {
  if (glyph === "loader") return <span className="ivspin" aria-hidden="true" />;
  if (glyph === "check")
    return (
      <svg className={`ivcheck ${className ?? ""}`} viewBox="0 0 24 24" aria-hidden="true">
        <path d="m5 12.5 4.5 4.5L19 7.5" />
      </svg>
    );
  return <SignalMark signal={glyph === "fail" ? "risk" : "caution"} className={className} />;
}

/** the status line (체결 확인 중, 주문 예정 · …): the mark before its words when the card has one; the words one block */
function StopStatus({ card, glyph }: { card: InvestStopCard; glyph: StopGlyph | null }) {
  if (!card.status) return null;
  return (
    <p className="ivstatus" data-state={card.state} role="status">
      {glyph && <StopMark glyph={glyph} />}
      <span className="ivstatus-text">{copy(card.status, { sentences: false })}</span>
    </p>
  );
}

/** the allowed-IP row of a 403 (DD 1935 §2-2): the address and 복사, the only button a stop card has */
function IpValue({ ip }: { ip: string }) {
  return (
    <span className="ivip">
      <span className="tnum">{ip}</span>
      <button
        type="button"
        className="ivip-copy"
        onClick={() => copyText(ip).catch((e: Error) => island.errorBanner(e.message, "복사하지 못했어요"))}
        aria-label={`허용 IP ${ip} 복사`}
      >
        복사
      </button>
    </span>
  );
}

export function InvestStopCardView({ card, interactive = true }: { card: InvestStopCard; interactive?: boolean }) {
  const glyph = stopGlyph(card);
  // the mark before the status line when there is one, else before the title (DD 2314 §5)
  const titleGlyph = card.status ? null : glyph;
  // a skipped mock record's title is its reason: said once (DD Say it once)
  const reason = card.reason && card.reason.text !== card.title ? card.reason.text : null;
  return (
    <section className="ccard ivcard" aria-label={`${card.mode === "real" ? "실제" : "모의"} ${card.symbol} 손절, ${card.title}`} data-card="invest_stop" data-mode={card.mode} data-state={card.state}>
      <div className="ivcard-mode">
        <ModeWord mode={card.mode} />
        <span>{` · ${card.symbol} 손절`}</span>
      </div>
      <h3 className="ccard-title ivcard-title">
        {titleGlyph && <StopMark glyph={titleGlyph} className="ivcard-glyph" />}
        {copy(card.title, { sentences: false })}
      </h3>
      {/* the hero and its label right under it (체결가(평균), 11월 27일 종가: DD 2314 §5); then why, a subhead */}
      <div className="ivcard-price">
        <IvHero value={figure(card.hero)} />
        {card.sub && <p className="ivcard-sub">{copy(card.sub, { sentences: false })}</p>}
      </div>
      {card.why && <p className="ivstop-why">{copy(card.why)}</p>}
      <StopStatus card={card} glyph={glyph} />
      {reason && <p className="ivcard-reason">{copy(reason)}</p>}
      {(card.rows.length > 0 || card.reason?.ip) && (
        <IvRows>
          {card.rows.map((r) => (
            <IvRow key={r.label} label={r.label} value={cell(r.value)} />
          ))}
          {card.reason?.ip && <IvRow label="허용 IP" value={interactive ? <IpValue ip={card.reason.ip} /> : card.reason.ip} />}
        </IvRows>
      )}
      {card.call && <CallLine call={card.call} />}
      <Lines lines={card.notes} className="ivcard-notes" />
      <div className="ivcard-foot">
        <IvFoot>{card.foot}</IvFoot>
        {card.disclaimer && <IvDisclaimer />}
      </div>
    </section>
  );
}
