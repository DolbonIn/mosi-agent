import type { Tickets } from "@pickle/protocol";
import { useState } from "react";
import { toApiError } from "../../../api/client";
import { spendTicket, useSession } from "../../../api/store";
import { Button } from "../../../ui/Button";
import { Icon } from "../../../ui/Icon";
import { Odometer } from "../../../ui/Odometer";
import { ProgressBar } from "../../../ui/ProgressBar";
import { presentSheet, type SheetApi, type SheetSource } from "../../../ui/Sheet";
import { InlineError, Note, SectionLabel } from "../parts";

/**
 * 한도 초기화 티켓 (MOTION-SPEC §6.6, research 6-2, my-mosi B): pick a ticket → 티켓 쓰기 → loader → the check draws
 * once the server answered → the bar in this sheet drains to 0 on `morph` (its value comes from the quota the server
 * returned, never from the tap) → the sheet closes. "오늘 사용한 한도" and its bar appear only when there is usage to
 * reset (decided when the sheet opens, so the drain still plays); otherwise the note above the button says why it
 * is off. A kind with none left is dimmed with its reason in label-2.
 */
export function presentTickets(source: SheetSource) {
  return presentSheet({ source, title: "한도 초기화 티켓", render: (api) => <TicketBody api={api} /> });
}

const KINDS: { kind: keyof Tickets; title: string }[] = [
  { kind: "basic", title: "한도 초기화 티켓" },
  { kind: "premium", title: "프리미엄 티켓" },
];

function TicketBody({ api }: { api: SheetApi }) {
  const session = useSession().session;
  const quota = session?.quota;
  const tickets = session?.tickets ?? { basic: 0, premium: 0 };
  const [kind, setKind] = useState<keyof Tickets>(tickets.basic > 0 ? "basic" : "premium");
  const [error, setError] = useState<string | null>(null);
  const pct = quota?.usedPct ?? 0;
  const [showNow] = useState(pct > 0);
  const none = tickets.basic + tickets.premium === 0;
  const nothing = pct <= 0;
  const why = none ? "남은 티켓이 없어요." : nothing ? "지금은 초기화할 사용량이 없어요. 한도를 쓴 다음에 써 주세요." : null;

  const use = async () => {
    setError(null);
    api.setBusy(true);
    try {
      await spendTicket(kind);
    } catch (e) {
      setError(toApiError(e).message);
      throw e;
    } finally {
      api.setBusy(false);
    }
  };

  return (
    <div className="more-sheet ticket-body">
      {showNow && (
        <div className="ticket-now">
          <div className="ticket-now__head">
            <span>오늘 사용한 한도</span>
            <span className="ticket-now__pct tnum">
              <Odometer value={pct} suffix="%" />
            </span>
          </div>
          <ProgressBar value={pct / 100} label="오늘 사용한 한도" tone="label" height={8} />
        </div>
      )}

      <div className="more-sheet-group">
        <SectionLabel level={3} id="ticket-kinds">
          쓸 티켓
        </SectionLabel>
        <div className="ticket-kinds" role="radiogroup" aria-labelledby="ticket-kinds">
          {KINDS.map((k) => {
            const n = tickets[k.kind];
            const on = kind === k.kind;
            return (
              <button
                key={k.kind}
                type="button"
                role="radio"
                aria-checked={on}
                disabled={n <= 0}
                className="ticket-kind"
                data-on={on || undefined}
                data-kind={k.kind}
                onClick={() => setKind(k.kind)}
              >
                <span className="ticket-kind__main">
                  <span className="ticket-kind__title">{k.title}</span>
                  <span className="ticket-kind__sub tnum">{n > 0 ? `${n}장 남았어요` : "남은 티켓이 없어요"}</span>
                </span>
                <span className="ticket-radio" aria-hidden="true">
                  {on && <Icon name="checkmark" size={14} weight="semibold" />}
                </span>
              </button>
            );
          })}
        </div>
        <Note>티켓을 쓰면 오늘 사용량이 바로 0%로 돌아가요. 매일 새벽 {quota?.resetHour ?? 4}시 초기화는 그대로예요.</Note>
      </div>

      <div className="ticket-cta">
        {why && <p className="ticket-why">{why}</p>}
        <InlineError>{error}</InlineError>
        <Button
          tone="primary"
          size="lg"
          fullWidth
          action={use}
          disabled={none || nothing || tickets[kind] <= 0}
          busyLabel="티켓 쓰는 중"
          successLabel="한도를 초기화했어요"
          onSuccess={() => api.close()}
          errorLabel="다시 시도하기"
          className="ticket-use profile-off"
        >
          티켓 쓰기
        </Button>
      </div>
    </div>
  );
}
