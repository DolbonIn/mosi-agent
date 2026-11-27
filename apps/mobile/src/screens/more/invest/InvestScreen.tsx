import { nav, type ScreenProps } from "../../../app/nav";
import { Screen } from "../../../app/Screen";
import { LargeTitle } from "../../../ui/LargeTitle";
import { IvDisclaimer } from "../../../ui/Invest";
import { ListRow, ListSection } from "../../../ui/List";
import { investRes, useResource } from "../data";
import { copyOf, InlineError, Placeholder, Stack, useAgentName, useRouteVisible } from "../parts";
import { presentAddSymbol } from "./AddSymbolSheet";
import { useModeCapsule } from "./mode";
import { NoticeRow } from "./NoticeRow";
import { EmptySection, routeClass, RuleGroup, rulesFootNode, WatchRow } from "./rows";
import { boardOf, gaugeSaid, gaugeTone, phoneNotice, ruleGroups, stageEmptyLine, watchNotice, type StageGauge } from "./rules";
import type { InvestOverview, InvestStages } from "@pickle/protocol";
import "./invest.css";

/**
 * 투자 (DD 1935 §3-2, first part: ① 시장 단계, ② 감시 종목, ③ 감시 규칙, ④ 보고서; DD 2008, DD 2010). One read
 * (investRes, kept current by the `invest` event) draws the whole screen. Every number and every rule sentence on it is
 * the server's text (agent-runtime 2006 §5): the screen never formats a number. Directions are told by sign, never by
 * colour (DD §0-3); red is for risk only: the severe cells, a live sale, a stop warning, quotes lost under a live stop.
 * An empty section is its title and one footnote (DD 2008 §2). The A17 sentence closes the screen once.
 *
 * The top bar says the order mode; pressed, it opens ⑥ 투자 설정 at 주문 모드 (DD 1935 §3-1, DD 2008 §1's next part).
 * ⑥ is the last row before the A17 sentence.
 *
 * A watched symbol's row opens its screen (InvestSymbolScreen: the same route with `{ symbol }`, DD 0914).
 *
 * Not here yet (next parts): 11지표 자세히, ⑤ 덱 and the live-order sheet.
 */
export function InvestScreen({ route }: ScreenProps) {
  const visible = useRouteVisible(route.key);
  const res = useResource(investRes, visible);
  const d = res.data;
  useModeCapsule(() => nav.push("invest-settings", { focus: "mode" }, { title: "투자 설정" }));

  return (
    <Screen routeKey={route.key} className={`invest ${routeClass(route.key)}`}>
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
            <RulesSection d={d} scope={routeClass(route.key)} />
            <ReportsSection reports={d.reports} />
            <ListSection className="iv-settings-link">
              <ListRow title="투자 설정" layoutId="iv-settings-row" onClick={() => nav.push("invest-settings", undefined, { title: "투자 설정", titleLayoutId: "iv-settings-row" })} />
            </ListSection>
            <div className="iv-disclaimer">
              <IvDisclaimer />
            </div>
          </>
        ) : null}
      </Stack>
    </Screen>
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
      {notice && <NoticeRow signal={notice.tone === "danger" ? "risk" : "caution"} text={notice.text} className="iv-watch-notice" />}
      {d.watchlist.map((w) => (
        <WatchRow key={w.symbol} w={w} onPress={() => nav.push("invest", { symbol: w.symbol }, { title: w.symbol })} />
      ))}
      <ListRow title="종목 추가" chevron={false} className="iv-add" onClick={() => presentAddSymbol(document.querySelector<HTMLElement>(".invest .iv-watch .iv-add"))} />
    </ListSection>
  );
}

// ───────────────────────────── ③ 감시 규칙 ─────────────────────────────

function RulesSection({ d, scope }: { d: InvestOverview; scope: string }) {
  const agentName = useAgentName();
  const groups = ruleGroups(d);
  // no symbol: no rules section at all; ② already says what to do (DD 2008 §2)
  if (!groups.length) return null;
  const notice = d.rules.some((r) => r.action === "call") ? phoneNotice(d.settings) : null;
  const foot = rulesFootNode(d.mode, agentName);
  return (
    <>
      {groups.map((g, i) => (
        <RuleGroup
          key={g.symbol}
          d={d}
          symbol={g.symbol}
          rules={g.rules}
          title={`감시 규칙 · ${g.symbol}`}
          footer={i === groups.length - 1 ? foot : undefined}
          notice={i === 0 ? notice : null}
          scope={scope}
        />
      ))}
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
