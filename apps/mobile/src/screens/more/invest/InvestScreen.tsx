import { nav, type ScreenProps } from "../../../app/nav";
import { Screen } from "../../../app/Screen";
import { LargeTitle } from "../../../ui/LargeTitle";
import { InvestNum, IvDisclaimer, SignalMark } from "../../../ui/Invest";
import { ListRow, ListSection } from "../../../ui/List";
import { investRes, useResource } from "../data";
import { copyOf, Foot, InlineError, Placeholder, Stack, useAgentName, useRouteVisible } from "../parts";
import { presentPhone } from "../profile/PhoneSheet";
import { presentAddSymbol } from "./AddSymbolSheet";
import { presentRule } from "./RuleSheet";
import { boardOf, gaugeSaid, gaugeTone, isLiveSale, phoneNotice, pricePhrase, ruleGroups, rulesFoot, stageEmptyLine, watchNotice, type StageGauge } from "./rules";
import type { InvestNum as InvestNumber, InvestOverview, InvestRuleRow, InvestStages, InvestSymbolRow } from "@pickle/protocol";
import "./invest.css";

/** the server's number text for ui/InvestNum, or null where it has no number (InvestNum then says 확인 불가) */
const numText = (n: InvestNumber | null | undefined): string | null => (n && n.v !== null ? n.text : null);

/**
 * 투자 (DD 1935 §3-2, first part: ① 시장 단계, ② 감시 종목, ③ 감시 규칙, ④ 보고서; DD 2008, DD 2010). One read
 * (investRes, kept current by the `invest` event) draws the whole screen. Every number and every rule sentence on it is
 * the server's text (agent-runtime 2006 §5): the screen never formats a number. Directions are told by sign, never by
 * colour (DD §0-3); red is for risk only: the severe cells, a live sale, a stop warning, quotes lost under a live stop.
 * An empty section is its title and one footnote (DD 2008 §2). The A17 sentence closes the screen once.
 *
 * Not here yet (next parts): the order-mode capsule (DD 2008 §1: not pressable in this part; it waits for the top
 * bar's static capsule), 11지표 자세히, the symbol screen, ⑤ 덱, ⑥ 투자 설정 and the live-order sheet.
 */
export function InvestScreen({ route }: ScreenProps) {
  const visible = useRouteVisible(route.key);
  const res = useResource(investRes, visible);
  const d = res.data;

  return (
    <Screen routeKey={route.key} className="invest">
      <LargeTitle title={route.title ?? "투자"} layoutId={route.titleLayoutId} />
      <Stack>
        {!res.loaded && !d ? (
          res.error ? (
            <InlineError>{res.error}</InlineError>
          ) : (
            <Placeholder rows={4} height={64} />
          )
        ) : d ? (
          <>
            <StageSection stages={d.stages} />
            <WatchSection d={d} />
            <RulesSection d={d} />
            <ReportsSection reports={d.reports} />
            <div className="iv-disclaimer">
              <IvDisclaimer />
            </div>
          </>
        ) : null}
      </Stack>
    </Screen>
  );
}

/** a section with nothing to list: its title and one footnote, no card (AgentScreen's grammar) */
function EmptySection({ title, className, children }: { title: string; className: string; children: string }) {
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

// ───────────────────────────── ① 시장 단계 ─────────────────────────────

function StageSection({ stages }: { stages: InvestStages | null }) {
  const board = boardOf(stages);
  if (!board)
    return (
      <EmptySection title="시장 단계" className="iv-stage">
        {stageEmptyLine(stages)}
      </EmptySection>
    );
  return (
    <ListSection title="시장 단계" className="iv-stage">
      <div className="list-row iv-stage-row">
        <span className="list-row-main iv-stage-main">
          <span className="iv-stage-head">
            <span className="iv-stage-title tnum">{board.line}</span>
            <span className="iv-stage-sub tnum">{board.sub}</span>
          </span>
          <span className="iv-gauges">
            {board.gauges.map((g) => (
              <Gauge key={g.id} g={g} />
            ))}
          </span>
          {board.next && <span className="iv-next t-copy">{copyOf(board.next)}</span>}
        </span>
      </div>
    </ListSection>
  );
}

/** "악화 신호 ●●●○○○◌○ 3/8": a cell per condition, met in the gauge's tone, unmet as fill, not known dotted */
function Gauge({ g }: { g: StageGauge }) {
  return (
    <span className="iv-gauge" role="img" aria-label={gaugeSaid(g)}>
      <span className="iv-gauge-word" aria-hidden="true">
        {g.label}
      </span>
      <span className={`iv-cells is-${gaugeTone(g.id)}`} aria-hidden="true">
        {g.cells.map((c, i) => (
          <i key={i} className={`iv-cell is-${c}`} />
        ))}
      </span>
      <span className="iv-gauge-n tnum" aria-hidden="true">
        {g.text}
      </span>
    </span>
  );
}

// ───────────────────────────── ② 감시 종목 ─────────────────────────────

function WatchSection({ d }: { d: InvestOverview }) {
  // no quote source or quotes lost: said at the top in the server's words, its foot under the group (DD 0225); the tone
  // is red while a live stop sale cannot happen: the server says so (DD 2010 §7)
  const { notice, foot } = watchNotice(d.watch, d.quotesFoot);
  return (
    <ListSection title="감시 종목" footer={foot} className="iv-watch">
      {notice && (
        <div className={`list-row iv-notice is-${notice.tone}`}>
          <span className="list-row-main">
            <span className="iv-notice-line">
              <SignalMark signal={notice.tone === "danger" ? "risk" : "caution"} className="iv-mark" />
              <span className="t-copy tnum">{copyOf(notice.text)}</span>
            </span>
          </span>
        </div>
      )}
      {d.watchlist.map((w) => (
        <WatchRow key={w.symbol} w={w} />
      ))}
      <ListRow title="종목 추가" chevron={false} className="iv-add" onClick={() => presentAddSymbol(document.querySelector<HTMLElement>(".invest .iv-watch .iv-add"))} />
    </ListSection>
  );
}

function WatchRow({ w }: { w: InvestSymbolRow }) {
  const h = w.holding;
  return (
    <div className="list-row iv-watch-row">
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
    </div>
  );
}

// ───────────────────────────── ③ 감시 규칙 ─────────────────────────────

function RulesSection({ d }: { d: InvestOverview }) {
  const agentName = useAgentName();
  const groups = ruleGroups(d);
  // no symbol: no rules section at all; ② already says what to do (DD 2008 §2)
  if (!groups.length) return null;
  const notice = d.rules.some((r) => r.action === "call") ? phoneNotice(d.settings) : null;
  const foot = rulesFoot(d.mode, agentName).map((p) => (
    <p key={p} className="iv-foot-p">
      {copyOf(p)}
    </p>
  ));
  return (
    <>
      {groups.map((g, i) => (
        <ListSection key={g.symbol} title={`감시 규칙 · ${g.symbol}`} footer={i === groups.length - 1 ? foot : undefined} className="iv-rules">
          {i === 0 && notice && <PhoneNotice {...notice} />}
          {g.rules.map((r) => (
            <RuleRow key={r.id} r={r} d={d} />
          ))}
          <ListRow
            title="규칙 추가"
            chevron={false}
            className={`iv-add iv-add-rule-${g.symbol}`}
            onClick={() => presentRule(document.querySelector<HTMLElement>(`.invest .iv-add-rule-${CSS.escape(g.symbol)}`), { symbol: g.symbol, rule: null })}
          />
        </ListSection>
      ))}
    </>
  );
}

/** calls cannot be placed (DD 2010 §4): said once, at the top; an unverified number leads to verifying it */
function PhoneNotice({ text, verify }: { text: string; verify: boolean }) {
  const line = (
    <span className="iv-notice-line">
      <SignalMark signal="caution" className="iv-mark" />
      <span className="t-copy">{copyOf(text)}</span>
    </span>
  );
  if (verify)
    return (
      <button type="button" className="list-row is-clickable iv-notice is-caution iv-phone-notice" onClick={(e) => presentPhone(e.currentTarget)}>
        <span className="list-row-main">{line}</span>
      </button>
    );
  return (
    <div className="list-row iv-notice is-caution iv-phone-notice">
      <span className="list-row-main">{line}</span>
    </div>
  );
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

// ───────────────────────────── ④ 보고서 ─────────────────────────────

type InvestReport = InvestOverview["reports"][number];

function ReportsSection({ reports }: { reports: InvestReport[] }) {
  if (!reports.length)
    return (
      <EmptySection title="보고서" className="iv-reports">
        아직 보고서가 없어요. 매일 오전 8시에 채팅으로 보내 드려요.
      </EmptySection>
    );
  return (
    <ListSection title="보고서" className="iv-reports">
      {reports.slice(0, 3).map((r) => (
        <ListRow key={r.id} title={<span className="tnum">{r.title}</span>} subtitle={r.line} className="iv-report-row" onClick={() => openReport(r)} />
      ))}
      <ListRow title="모두 보기" chevron={false} className="iv-add" onClick={() => openReport(reports[0]!)} />
    </ListSection>
  );
}

/** the thread the report is in (a jump to the message itself needs a thread anchor the chat screens do not take yet) */
function openReport(r: InvestReport) {
  nav.push("thread", { threadId: r.threadId });
}
