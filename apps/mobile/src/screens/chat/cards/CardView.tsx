import type { Card, ID, ToolActivity } from "@pickle/protocol";
import { memo } from "react";
import { ApprovalCard } from "./ApprovalCard";
import { HtmlArtifactCard } from "../../../artifact/HtmlArtifactCard";
import { ArtifactCard } from "./ArtifactCard";
import { ConnectionRequestView } from "../../more/connections/ConnectionRequestView";
import { CredentialCard } from "./CredentialCard";
import { BriefingCard, MessengerCard, ResultsCard, ScheduleCard, WeatherCard } from "./InfoCards";
import { PROVIDER_NAME } from "./MessengerThreadCard";
import "./cards.css";

/**
 * Read-only records the turn folds behind its one line ("자료 3개 보기", ToolChips TurnFold): what the agent looked
 * up — a results list, the weather, a messenger room it read. Everything that asks the person for something stays
 * open under the answer: approval, credential, connection, briefing choices, the schedule switch, a sent message's
 * receipt, and an artifact (what the agent made is the answer, not material behind it).
 */
export function foldable(card: Card): boolean {
  return card.type === "results" || card.type === "weather" || (card.type === "messenger" && card.action === "read");
}

/** where a folded record came from, for the line ("외교부, 네이버 뉴스") */
export function foldSource(card: Card): string | undefined {
  if (card.type === "results") return card.source?.trim() || undefined;
  if (card.type === "weather") return card.source?.trim() || undefined;
  if (card.type === "messenger") return PROVIDER_NAME[card.provider] ?? card.provider;
  return undefined;
}

/** Every protocol Card variant → its paper card. Unknown variants render nothing (forward compatible). */
export const CardView = memo(function CardView({
  card,
  messageId,
  threadId,
  tools,
  onSend,
  interactive = true,
  deletedNote,
}: {
  card: Card;
  /** position in the message (keys only) */
  index?: number;
  messageId: ID;
  threadId: ID;
  tools: ToolActivity[];
  onSend: (text: string) => void;
  interactive?: boolean;
  /** what a card deleted from the archive says (cards/deleted.ts: who deleted it, by the row's author) */
  deletedNote?: string;
}) {
  switch (card.type) {
    case "briefing":
      return <BriefingCard card={card} threadId={threadId} onSend={onSend} interactive={interactive} />;
    case "approval":
      return <ApprovalCard card={card} threadId={threadId} tools={tools} interactive={interactive} />;
    case "credential_request":
      return <CredentialCard card={card} messageId={messageId} onSend={onSend} interactive={interactive} />;
    case "connection_request":
      return <ConnectionRequestView card={card} threadId={threadId} onSend={onSend} interactive={interactive} />;
    case "artifact":
      // html: the model's own page, drawn inline in a sandboxed frame (never folded: it is the answer); once deleted from
      // the archive, the one-row card like any other document (no frame: the page is gone)
      return card.kind === "html" && !card.deleted ? <HtmlArtifactCard card={card} /> : <ArtifactCard card={card} note={deletedNote} />;
    case "results":
      return <ResultsCard card={card} />;
    case "weather":
      return <WeatherCard card={card} />;
    case "messenger":
      return <MessengerCard card={card} />;
    case "schedule":
      return <ScheduleCard card={card} />;
    default:
      return null;
  }
});
