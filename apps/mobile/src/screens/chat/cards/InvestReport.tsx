import type { ID, InvestDailyCard, InvestDeckCard } from "@pickle/protocol";
import { Fragment, type ReactNode } from "react";
import { tokenUrl } from "../../../api/client";
import { messagesStore } from "../../../api/store";
import { getScreen, nav } from "../../../app/nav";
import { Button } from "../../../ui/Button";
import { IvDisclaimer, IvFoot, IvRow, IvRows, SignalMark } from "../../../ui/Invest";
import { ProgressBar } from "../../../ui/ProgressBar";
import { copy, glued } from "../../../ui/Text";
import { openMedia } from "../../more/archive/MediaGrid";
import { whenText } from "./InvestEvent";

/**
 * The 08:00 report card and the deck card (DD 1935 §2-4·2-6, 0059 §2·§3). The server writes every word and count.
 *   invest_daily  (the server's card, B2c-1 at 47dd01d) title + time (the head opens the 보고서 screen once it is in the
 *                 app: DD 0059 §2-4); the holiday line; up to two highlight lines (danger full mark, caution half, a
 *                 recovery line plain; 외 n건); the stage line (two groups, a line breaks only at its "·": 0059 §2-1),
 *                 the pending line right under it (§1-3: said once), the move line with its tone's mark (DD 0828 1a);
 *                 the data-gap line; three summary lines, or the no-summary line; the 11-indicator tally in the server's
 *                 first row's place (each item whole) and the other rows; 일정 (D-1, DD 0109); 덱 보기 (덱 만드는 중
 *                 while it is made, none without a deck); foot + closing sentence
 *   invest_deck   making: name, 만드는 중 · n/m장 and its bar over a still 16:9 box; ready: the first slide, the name (two
 *                 lines), meta, 3–5 summary lines, tap → the archive's PDF sheet; failed: the reason and 다시 만들기
 */

/** the deck card of the same message (it joins the report's message once ready: DD 1935 §2-4 6) */
function deckOf(threadId: ID, messageId: ID, deckId: ID | undefined): InvestDeckCard | null {
  if (!deckId) return null;
  const m = messagesStore.get()[threadId]?.items.find((x) => x.id === messageId);
  const c = m?.cards?.find((x) => x.type === "invest_deck" && x.deckId === deckId);
  return (c as InvestDeckCard | undefined) ?? null;
}

/** the deck's PDF file (agent-runtime 0221: the card carries it once the deck board lands; until then the id alone) */
type DeckFile = { id: ID; filename: string; size: number; createdAt: number };
const fileOf = (x: object): DeckFile | undefined => (x as { file?: DeckFile }).file;

/** the PDF in the archive's own preview sheet (DD 0059 §3: no new viewer); without `file` the name and size are guessed */
function openPdf(id: ID, file: DeckFile | undefined, name: string, source: HTMLElement | null): void {
  openMedia(
    { id, filename: file?.filename ?? `${name}.pdf`, mime: "application/pdf", size: file?.size ?? 0, url: `/api/attachments/${encodeURIComponent(id)}/raw`, threadId: null, createdAt: file?.createdAt ?? 0 },
    source,
  );
}

export function openDeck(deck: InvestDeckCard, source: HTMLElement | null): void {
  const file = fileOf(deck);
  const id = file?.id ?? deck.attachmentId;
  if (id) openPdf(id, file, deck.name, source);
}

/** a slide picture the server names by its path (/api/attachments/:id/raw, no cookie session here): the token goes on */
const thumbSrc = (url: string): string => (url.startsWith("/api/") ? tokenUrl(url) : url);

/** "탈출 2단계 경계 · 회복 1단계 바닥 탐색": two boxes, the " ·" kept on the first, so a line breaks only between them */
function StageLine({ text }: { text: string }) {
  const parts = text.split(" · ");
  return (
    <p className="ivdaily-stage-line">
      {/* the space between the groups outside their boxes: a trailing space inside an inline-block is not drawn
          ("방어 준비 ·회복" on one line) */}
      {parts.map((part, i) => (
        <Fragment key={i}>
          <span className="ivdaily-stage-part">{glued(i < parts.length - 1 ? `${part} ·` : part)}</span>
          {i < parts.length - 1 ? " " : null}
        </Fragment>
      ))}
    </p>
  );
}

/**
 * the move line (DD 0828 1a, 2225 N5): "탈출 최소 1단계 → 탈출 3단계 · 회복 최소 2 → 1단계" in the stage line's two
 * boxes (a line breaks between them, after " ·"), and in a box "→" stays with the new value ("회복 최소 2 →" / "1단계"
 * was drawn at 390). The tone's mark rides in the first box, before its first word.
 */
function MoveLine({ text, mark, tone }: { text: string; mark: ReactNode; tone: InvestDailyCard["stageTone"] }) {
  const parts = text.split(" · ");
  if (parts.length === 1 && !text.includes(" → "))
    return (
      <p className="ivcard-sub ivdaily-sub" data-tone={tone}>
        {mark}
        {copy(text, { sentences: false })}
      </p>
    );
  return (
    <p className="ivcard-sub ivdaily-sub" data-tone={tone}>
      {parts.map((part, i) => {
        const tail = i < parts.length - 1 ? " ·" : "";
        const at = part.lastIndexOf(" → ");
        return (
          <Fragment key={i}>
            <span className="ivdaily-sub-part">
              {i === 0 && mark}
              {at < 0 ? (
                glued(`${part}${tail}`)
              ) : (
                <>
                  {glued(part.slice(0, at))} <span className="t-glue">{`→ ${part.slice(at + 3)}${tail}`}</span>
                </>
              )}
            </span>
            {i < parts.length - 1 ? " " : null}
          </Fragment>
        );
      })}
    </p>
  );
}

export function InvestDailyCardView({ card, threadId, messageId, interactive = true }: { card: InvestDailyCard; threadId: ID; messageId: ID; interactive?: boolean }) {
  // the server sends two lines at most and counts the rest in moreCount (report.ts HIGHLIGHTS_SHOWN: lead 2235b M4)
  const lines = card.highlights;
  // the server's first row says the 11 indicators' tally in words; the card draws it as the tally's marks and counts in
  // that row's place, said once (DD 0828 화면 팀, DD 1935 §2-4)
  const tallyRow = card.rows[0]?.label === "11지표" ? card.rows[0] : null;
  const rows = tallyRow ? card.rows.slice(1) : card.rows;
  const tally = (
    <span className="ivtally">
      {card.tally.map((t) => (
        <span key={t.signal} className="ivtally-item" data-signal={t.signal}>
          <SignalMark signal={t.signal} />
          <span className="ivtally-word">{t.label}</span> <span className="tnum">{t.count}</span>
        </span>
      ))}
    </span>
  );
  const head = (
    <>
      <h3 className="ccard-title ivcard-title">{card.title}</h3>
      <span className="ccard-source tnum">{glued(card.atText)}</span>
    </>
  );
  const report = interactive && getScreen("investReport");
  return (
    <section className="ccard ivcard" aria-label={card.title} data-card="invest_daily">
      {report ? (
        <button type="button" className="ccard-head ivcard-head ivdaily-headbtn" onClick={() => nav.push("investReport", { reportId: card.reportId }, { title: "보고서" })}>
          {head}
        </button>
      ) : (
        <div className="ccard-head ivcard-head">{head}</div>
      )}
      {card.holidayNote && <p className="ivdaily-holiday">{copy(card.holidayNote)}</p>}
      {lines.length > 0 && (
        <div className="ivdaily-high">
          {lines.map((h, i) => (
            <p key={i} data-tone={h.tone}>
              {/* a recovery line is plain: no mark (DD 0733 B) */}
              {h.tone !== "plain" && <SignalMark signal={h.tone === "danger" ? "risk" : "caution"} />}
              {copy(h.text, { sentences: false })}
              {i === lines.length - 1 && card.moreCount ? <span className="ivdaily-more">{` 외 ${card.moreCount}건`}</span> : null}
            </p>
          ))}
        </div>
      )}
      <div className="ivdaily-stage">
        <StageLine text={card.stageLine} />
        {card.pending && (
          <p className="ivcall ivdaily-pending">
            <SignalMark signal="caution" />
            {copy(card.pending, { sentences: false })}
          </p>
        )}
        {card.stageSub && (
          <MoveLine text={card.stageSub} mark={card.stageTone && <SignalMark signal={card.stageTone === "danger" ? "risk" : "caution"} />} tone={card.stageTone} />
        )}
      </div>
      {/* sources that did not answer today (code's line; the summary does not repeat it: DD 0828 1b, 2) */}
      {card.dataGap && (
        <p className="ivcall ivdaily-gap">
          <SignalMark signal="caution" />
          {copy(card.dataGap, { sentences: false })}
        </p>
      )}
      {card.summary.length > 0 ? (
        <div className="ivcard-notes">
          {card.summary.map((s, i) => (
            <p key={i}>{copy(s)}</p>
          ))}
        </div>
      ) : (
        card.summaryNote && (
          <p className="ivcall ivdaily-nosummary">
            <SignalMark signal="caution" />
            {copy(card.summaryNote, { sentences: false })}
          </p>
        )
      )}
      <IvRows>
        <IvRow label={tallyRow?.label ?? "11지표"} value={tally} />
        {rows.map((r) => (
          <IvRow key={r.label} label={r.label} value={r.value} />
        ))}
      </IvRows>
      {/* D-1 (DD 0109 §1): under the rows, above the foot; the server sends three rows at most (CARD_EVENTS_MAX: lead
          2235b M7) */}
      {card.events && card.events.rows.length > 0 && (
        <div className="ivdaily-events">
          <p className="ivdaily-events-head">{glued(card.events.head)}</p>
          <IvRows>
            {card.events.rows.map((r, i) => (
              <IvRow key={i} label={r.title} value={<span className="tnum">{whenText(r.value)}</span>} />
            ))}
          </IvRows>
        </div>
      )}
      {card.deck.state !== "none" && (
        <div className="ivdaily-actions">
          <Button
            variant="capsule"
            tone="neutral"
            size="md"
            disabled={!interactive || card.deck.state === "making"}
            onClick={(e) => {
              const deck = deckOf(threadId, messageId, card.deck.deckId);
              // the deck card lives in its own message when it was made later (agent-runtime 0221: the id is on the report)
              const id = (card.deck as { attachmentId?: ID }).attachmentId;
              if (deck) openDeck(deck, e.currentTarget);
              else if (id) openPdf(id, undefined, card.title, e.currentTarget);
            }}
          >
            {card.deck.state === "making" ? "덱 만드는 중" : "덱 보기"}
          </Button>
        </div>
      )}
      <div className="ivcard-foot">
        <IvFoot>{card.foot}</IvFoot>
        {card.disclaimer && <IvDisclaimer />}
      </div>
    </section>
  );
}

export function InvestDeckCardView({ card, onSend, interactive = true }: { card: InvestDeckCard; onSend: (text: string) => void; interactive?: boolean }) {
  if (card.state === "failed")
    return (
      <section className="ccard ivcard" aria-label={card.name} data-card="invest_deck" data-state="failed">
        <h3 className="ccard-title ivcard-title">덱을 만들지 못했어요</h3>
        {card.failReason && <p className="ivcard-reason">{copy(card.failReason)}</p>}
        {interactive && (
          <div className="ivdaily-actions">
            <Button variant="capsule" tone="neutral" size="md" onClick={() => onSend(`${card.name} 다시 만들어 줘`)}>
              다시 만들기
            </Button>
          </div>
        )}
        {(card.foot || card.disclaimer) && (
          <div className="ivcard-foot">
            {card.foot && <IvFoot>{card.foot}</IvFoot>}
            {card.disclaimer && <IvDisclaimer />}
          </div>
        )}
      </section>
    );
  const making = card.state === "making";
  const body = (
    <>
      {/* the hairline goes over the slide (an <img>'s own inset shadow is drawn under its picture) */}
      <span className="ivdeck-thumb" aria-hidden="true">
        {!making && card.thumbUrl && <img src={thumbSrc(card.thumbUrl)} alt="" />}
      </span>
      <span className="ccard-title ivdeck-name">{card.name}</span>
      {/* the progress said once (DD 2225 N3): the bar's label is the line you see, and the bar's name */}
      {making ? (
        card.progress ? (
          <ProgressBar className="ivdeck-progress" value={card.progress.total ? card.progress.done / card.progress.total : 0} label={`만드는 중 · ${card.progress.done}/${card.progress.total}장`} />
        ) : (
          <span className="ivcard-sub">만드는 중</span>
        )
      ) : (
        card.meta && <span className="ivfoot tnum">{glued(card.meta)}</span>
      )}
    </>
  );
  return (
    <section className="ccard ivcard" aria-label={card.name} data-card="invest_deck" data-state={card.state}>
      {interactive && !making && (card.attachmentId || fileOf(card)) ? (
        <button type="button" className="ivdeck-open" onClick={(e) => openDeck(card, e.currentTarget)}>
          {body}
        </button>
      ) : (
        <div className="ivdeck-open">{body}</div>
      )}
      {!making && card.summary && card.summary.length > 0 && (
        <div className="ivcard-notes">
          {card.summary.map((s, i) => (
            <p key={i}>{copy(s)}</p>
          ))}
        </div>
      )}
      {(card.foot || card.disclaimer) && (
        <div className="ivcard-foot">
          {card.foot && <IvFoot>{card.foot}</IvFoot>}
          {card.disclaimer && <IvDisclaimer />}
        </div>
      )}
    </section>
  );
}
