import type { ConnectionRequestCard, ID } from "@pickle/protocol";
import { useEffect, useRef, useState } from "react";
import { loadConnections, useConnections, useTurnRunning } from "../../../api/store";
import { nav } from "../../../app/nav";
import { Button } from "../../../ui/Button";
import { Icon } from "../../../ui/Icon";
import { ListRow } from "../../../ui/List";
import { CONNECTIONS_TITLE } from "./providerCopy";
import { Sentences } from "../../../ui/Text";
import { useSkillSheet } from "./SkillAccounts";
import { requestLine } from "./skillCatalog";

/**
 * "<서비스> 연결이 필요해요" (connection_request, docs/architecture/KSKILL-CONNECTIONS.md § Card): a paper card with
 * the title, one line, and 연결하기. The line is what the agent will do with the login (the connect sheet's own scope
 * line, e.g. "…조회만 해요. 주문은 넣지 않아요.") for the services the app has words for: the agent's answer above
 * and the title already say why, so the card says what connecting allows. Other services keep the server's reason. The button opens the service's connect sheet right over the thread, morphing out of the
 * button: the turn that asked is still waiting (up to 90 s) and its stream stays open, so after connecting the
 * person sees the agent carry on at once. Never asks for a secret in the chat; the fields live only in the sheet.
 *   pending   → title, reason, 연결하기 — always, whatever the connections list says: a login the tool just refused is
 *               still listed as connected, and the server keeps that card pending. 연결하기 then opens the sheet on its
 *               fields (다시 연결). It stays pending until the server sends the card back as connected.
 *   connected → "<서비스> 연결됐어요" (no chip: the title says it) with no button; "이어서 하기" as a send row when
 *               the server added it
 *   dismissed → muted, no button
 * The card's own status decides, never the connections list: after a connect the server flips the stored card (a
 * message event) — or keeps a new one pending when the retry is refused again.
 * Read-only history (interactive false) shows the state without actions.
 */
export function ConnectionRequestView({ card, threadId, onSend, interactive = true }: { card: ConnectionRequestCard; threadId: ID; onSend: (text: string) => void; interactive?: boolean }) {
  const { providers, loaded, loading } = useConnections();
  const { open, sheet } = useSkillSheet();
  const btn = useRef<HTMLDivElement>(null);
  const running = useTurnRunning(threadId);
  const [sent, setSent] = useState(false);
  const tried = useRef(false);
  useEffect(() => {
    // the provider list tells whether the sheet can open here; load it once (a failed load isn't retried in a loop)
    if (loaded || loading || tried.current || card.status !== "pending") return;
    tried.current = true;
    void loadConnections();
  }, [loaded, loading, card.status]);
  useEffect(() => {
    if (sent && !running) {
      const id = setTimeout(() => setSent(false), 4000);
      return () => clearTimeout(id);
    }
  }, [sent, running]);

  const status = card.status;
  const known = providers.some((p) => p.id === card.service);
  const connect = () => {
    if (known) return open(card.service, btn.current, { form: true });
    // a service this device's list doesn't know yet: the connections screen, focused on it
    nav.push("connections", { focus: card.service, connect: true }, { title: CONNECTIONS_TITLE });
  };
  const next = interactive && status === "connected" && card.action?.send ? card.action : null;
  const line = requestLine(card);

  return (
    <section className={`ccard sk-req${status === "dismissed" ? " is-muted" : ""}`} aria-label={status === "connected" ? `${card.serviceName} 연결됐어요` : card.title}>
      <h3 className="ccard-title">{status === "connected" ? `${card.serviceName} 연결됐어요` : card.title}</h3>
      {status !== "connected" && line ? (
        <p className="sk-req__why">
          <Sentences text={line} />
        </p>
      ) : null}
      {interactive && status === "pending" ? (
        <div ref={btn}>
          <Button fullWidth onClick={connect}>
            {card.action?.label || "연결하기"}
          </Button>
        </div>
      ) : null}
      {next ? (
        <div className="brief-rows sk-req__next">
          <ListRow
            className={`brief-row${sent ? " is-sent" : ""}`}
            leading={<Icon name="chat" size={20} weight="regular" />}
            title={next.label}
            chevron={false}
            onClick={() => {
              if (sent) return;
              setSent(true);
              onSend(next.send!);
            }}
            ariaLabel={sent ? `${next.label}, 답을 기다리는 중` : undefined}
          />
        </div>
      ) : null}
      {sheet}
    </section>
  );
}
