import type { InvestRuleChangeCard } from "@pickle/protocol";
import { atText } from "@pickle/quant";
import { Fragment, useState } from "react";
import { ApiError, apiPost } from "../../../api/client";
import { Button } from "../../../ui/Button";
import { ConfirmButton } from "../../../ui/ConfirmButton";
import { IvDisclaimer, IvRow, IvRows, SignalMark } from "../../../ui/Invest";
import { copy, glued } from "../../../ui/Text";

/**
 * The rule change confirmation (DD 1935 §2-3; G8-5, A12): the model only proposes, the server changes the rule only
 * after the person presses 바꾸기 here. A question, exactly what changes (지금 → 바꿀 값, unchanged fields not listed),
 * the reason with its basis, the exact result, a danger line when the new stop is above the price (only while it asks:
 * DD 0636), then two buttons:
 * side by side with 바꾸기 on the right when both labels fit, else both full width, 바꾸기 on top (DD 1949). A real
 * sell rule's 바꾸기 is a ConfirmButton (hold 1.2 s or tap twice). Decided, the buttons give way to one foot line and the
 * danger line goes (nothing is asked any more; the reason and the result stay as the record, the foot line says how it went).
 * The answer is the server's: the loader runs until it answers, and the card takes the card the server sends back.
 * Until a press here is answered the card is the message's own, so a later word from the server (another device
 * decided, the proposal expired: the message comes again) is drawn as it comes (lead 2235b M1: no copy of the prop).
 */

/** POST /api/invest/proposals/:id {decision} → { card } (409 proposal_stale / 410 proposal_expired carry { card }) */
async function decide(proposalId: string, decision: "apply" | "keep"): Promise<InvestRuleChangeCard> {
  try {
    const r = await apiPost<{ card: InvestRuleChangeCard }>(`/api/invest/proposals/${encodeURIComponent(proposalId)}`, { decision });
    return r.card;
  } catch (e) {
    const card = e instanceof ApiError ? (e.data?.card as InvestRuleChangeCard | undefined) : undefined;
    if (card) return card;
    throw e;
  }
}

function doneText(card: InvestRuleChangeCard): string {
  switch (card.status) {
    case "applied":
      return card.decidedAt ? `바꿨어요 · ${atText(card.decidedAt, Date.now())}` : "바꿨어요";
    case "kept":
      return "그대로 뒀어요";
    case "expired":
      return "시간이 지나서 그대로 뒀어요";
    case "stale":
      return "그사이 규칙이 바뀌어서 적용하지 않았어요";
    default:
      return "";
  }
}

export function InvestRuleChangeCardView({ card: given, interactive = true }: { card: InvestRuleChangeCard; interactive?: boolean }) {
  // the server's answer to a press here: the same card the server writes into the message
  const [answer, setAnswer] = useState<InvestRuleChangeCard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const card = answer ?? given;
  const run = (decision: "apply" | "keep") => async () => {
    setError(null);
    try {
      setAnswer(await decide(card.proposalId, decision));
    } catch (e) {
      setError(e instanceof Error ? e.message : "지금은 바꿀 수 없어요");
      throw e;
    }
  };
  const pending = card.status === "pending";
  return (
    <section className="ccard ivcard" aria-label={card.title} data-card="invest_rule_change" data-status={card.status}>
      <h3 className="ccard-title ivcard-title">{copy(card.title, { sentences: false })}</h3>
      <IvRows>
        {card.changes.map((c) => (
          <IvRow
            key={c.label}
            label={c.label}
            value={
              // two flex items, the arrow with the new value: a gap goes only between them, never between "$" and its
              // number (each piece of glued() was its own item: "$ 25.80", DD 2225 N1). The space between them is not
              // drawn (a flex box drops it) but stays in the text: "$25.80 → $30.50"
              <span className="tnum ivrc-change">
                <span>{glued(c.from)}</span>{" "}
                <span>→ {glued(c.to)}</span>
              </span>
            }
          />
        ))}
      </IvRows>
      <div className="ivrc-reason">
        {card.reason && <p className="ivrc-reason-text">{copy(card.reason)}</p>}
        <p className="ivfoot">{glued(card.reasonFoot)}</p>
      </div>
      {/* one line per rule (DD 0452 §4: the server joins them with "\n"; pre-line draws the breaks) */}
      <p className="ivrc-result">
        {card.result.split("\n").map((line, i) => (
          <Fragment key={i}>
            {i > 0 ? "\n" : null}
            {copy(line)}
          </Fragment>
        ))}
      </p>
      {/* the danger line only while the card asks (DD 0636, 0638: applied, kept, expired, stale draw none) */}
      {pending && card.warning && (
        <p className="ivrc-warning" data-signal="risk">
          <SignalMark signal="risk" />
          {copy(card.warning, { sentences: false })}
        </p>
      )}
      {pending ? (
        <div className="ivrc-actions">
          {card.confirm === "hold" ? (
            <ConfirmButton label="길게 눌러 바꾸기" holdMs={1200} tone="primary" size="md" fullWidth={false} disabled={!interactive} onConfirm={run("apply")} />
          ) : (
            <Button variant="capsule" tone="primary" size="md" disabled={!interactive} action={run("apply")}>
              바꾸기
            </Button>
          )}
          <Button variant="capsule" tone="neutral" size="md" disabled={!interactive} action={run("keep")}>
            그대로 두기
          </Button>
        </div>
      ) : (
        <p className="ivrc-done" role="status">
          {doneText(card)}
        </p>
      )}
      {error && (
        <p className="ccard-error" role="alert">
          {error}
        </p>
      )}
      {card.disclaimer && <IvDisclaimer />}
    </section>
  );
}
