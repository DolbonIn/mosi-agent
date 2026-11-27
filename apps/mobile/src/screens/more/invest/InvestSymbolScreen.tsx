import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { toApiError } from "../../../api/client";
import { nav, type ScreenProps } from "../../../app/nav";
import { Screen } from "../../../app/Screen";
import { setCompactTitle } from "../../../app/topBarStore";
import { useTierValue } from "../../../motion/tier";
import { Button } from "../../../ui/Button";
import { EmptyState } from "../../../ui/EmptyState";
import { Icon } from "../../../ui/Icon";
import { IvDisclaimer } from "../../../ui/Invest";
import { ListSection } from "../../../ui/List";
import { copy } from "../../../ui/Text";
import { investRes, useResource } from "../data";
import { InlineError, Placeholder, Stack, useAgentName, useRouteVisible } from "../parts";
import { presentAddSymbol } from "./AddSymbolSheet";
import * as api from "./api";
import { landOn } from "./landing";
import { useModeCapsule } from "./mode";
import { EmptySection, routeClass, RuleGroup, rulesFootNode, WatchRow } from "./rows";
import { ALERTS_EMPTY, alertRows, phoneNotice, symbolTarget } from "./rules";
import { scrollToTop } from "./scroll";
import type { InvestSymbolDetail } from "@pickle/protocol";
import "./invest.css";

/**
 * A watched symbol's screen (DD 1935 §3-2 ② 331, DD 0914): ②'s row for it on top, its 감시 규칙 as ③ draws them,
 * its 최근 알림 (five at most), the A17 sentence once at the end. The title is the symbol, small, in the top bar (a
 * pushed screen; only 투자 itself has a large title).
 *
 * The row and the rules come from the overview (investRes, kept current by the `invest` event), so they read exactly as
 * on 투자; the alerts from `GET /api/invest/symbols/:symbol`, read again whenever the overview's rev moves.
 *
 * Opened by a chat card's 규칙 보기 (`{ symbol, ruleId }`, the same route as 투자; DD 0914 D6), it scrolls that rule's
 * row into view once and tints it a moment once it is there (landing.ts, DD 0918 §1).
 *
 * A symbol no longer watched (taken off elsewhere, or an old card's) is not an error (DD 0918 §2): the server's sentence
 * as an empty state, and 종목 추가 with the symbol filled in; once added, the overview brings the screen back.
 *
 * Not here yet (next part): the level chart between the row and the rules (ui/InvestChart and the server's chart
 * levels, aria and foot: DD 0914 D1–D5, agent-runtime 0913).
 */
export function InvestSymbolScreen({ route }: ScreenProps) {
  const symbol = symbolTarget(route.params)?.symbol ?? "";
  const ruleId = symbolTarget(route.params)?.ruleId ?? null;
  const visible = useRouteVisible(route.key);
  const res = useResource(investRes, visible);
  const d = res.data;
  // read once the overview is here (the row comes from it; its rev says when to read again)
  const detail = useDetail(symbol, d?.rev ?? null, visible && !!d);
  const agentName = useAgentName();
  const reduce = useTierValue("reduceMotion");
  const scope = routeClass(route.key);
  useModeCapsule(() => nav.push("invest-settings", { focus: "mode" }, { title: "투자 설정" }));

  useEffect(() => {
    if (!visible) return;
    setCompactTitle(route.key, symbol);
    return () => setCompactTitle(route.key, null);
  }, [visible, symbol, route.key]);

  // a chat card's rule: its row at the top of the view once the overview and the alerts are here (the alerts below it
  // set how far the screen can scroll), then a moment's tint. Once only: `ready` turns true once and stays (a refresh
  // keeps what was read), so a refresh neither scrolls nor tints again; a rule that is gone leaves the screen at its
  // top. The cleanup (unmount) undoes it.
  const ready = !!d && (detail.data !== null || (detail.error !== null && detail.code !== "not_watched"));
  const reduceNow = useRef(reduce);
  reduceNow.current = reduce;
  useLayoutEffect(() => {
    if (!ready || !ruleId) return;
    const row = document.querySelector<HTMLElement>(`.${scope} .iv-rule-${CSS.escape(ruleId)}`);
    if (!row) return;
    const stop = scrollToTop(row);
    const unland = landOn(row, reduceNow.current);
    return () => {
      stop();
      unland();
    };
  }, [ready, ruleId, scope]);

  const row = d?.watchlist.find((w) => w.symbol === symbol) ?? null;
  const rules = d ? d.rules.filter((r) => r.symbol === symbol) : [];
  return (
    <Screen routeKey={route.key} className={`iv-symbol-screen ${scope}`}>
      <Stack>
        {!res.loaded && !d ? (
          res.error ? (
            <InlineError>{res.error}</InlineError>
          ) : (
            <Placeholder rows={3} height={64} />
          )
        ) : d && !row ? (
          // no longer watched: the server's sentence and the one thing it asks for; no disclaimer, the screen stays
          detail.code === "not_watched" ? (
            <EmptyState
              icon="chart"
              title={detail.error ?? ""}
              className="iv-not-watched"
              action={
                <Button tone="neutral" size="md" className="iv-not-watched-add" onClick={(e) => presentAddSymbol(e.currentTarget, symbol)}>
                  종목 추가
                </Button>
              }
            />
          ) : detail.error ? (
            <InlineError>{detail.error}</InlineError>
          ) : (
            <Placeholder rows={1} height={64} />
          )
        ) : d && row ? (
          <>
            <ListSection className="iv-sym-head">
              <WatchRow w={row} />
            </ListSection>
            <RuleGroup
              d={d}
              symbol={symbol}
              rules={rules}
              title="감시 규칙"
              footer={rulesFootNode(d.mode, agentName)}
              notice={rules.some((r) => r.action === "call") ? phoneNotice(d.settings) : null}
              scope={scope}
            />
            <AlertsSection detail={detail} />
            <div className="iv-disclaimer">
              <IvDisclaimer />
            </div>
          </>
        ) : null}
      </Stack>
    </Screen>
  );
}

/**
 * 최근 알림 (DD 0914 D2): the server's words and the KST time; a row with its thread opens it, at the message. A
 * not_watched answer here is the read from before the symbol was added again: the next read is on its way.
 */
function AlertsSection({ detail }: { detail: Detail }) {
  if (!detail.data) return detail.error && detail.code !== "not_watched" ? <InlineError>{detail.error}</InlineError> : <Placeholder rows={2} height={52} />;
  const rows = alertRows(detail.data.alerts);
  if (!rows.length)
    return (
      <EmptySection title="최근 알림" className="iv-alerts">
        {ALERTS_EMPTY}
      </EmptySection>
    );
  return (
    <ListSection title="최근 알림" className="iv-alerts">
      {rows.map((a) => {
        const to = a.to;
        return <AlertRow key={a.id} text={a.text} when={a.when} onPress={to ? () => nav.push("thread", to) : undefined} />;
      })}
    </ListSection>
  );
}

/**
 * An alert's row (DD 0914 D2): its words on the left, the KST time on the right; when both do not fit one line the time
 * goes under the words, at the right, as ③'s right side does at 320 / 130 % (a list row's detail keeps 45 % and cut
 * the time there: "11-27 01:…"). The words are copy, and `.t-copy`'s text-wrap: pretty leaves no word alone on their
 * last line (the lone "… 구간 / 진입" was ListRow's title column beside that detail: a `.t-cell` under 160 px, where
 * pretty is off). With its thread: a button with a chevron; without: a plain row.
 */
function AlertRow({ text, when, onPress }: { text: string; when: string; onPress?: () => void }) {
  const main = (
    <span className="list-row-main">
      <span className="iv-alert-body">
        <span className="list-row-title t-copy iv-alert-text">{copy(text)}</span>
        <span className="iv-alert-when tnum">{when}</span>
      </span>
      {onPress && (
        <span className="list-row-chevron" aria-hidden="true">
          <Icon name="chevron-right" size={16} weight="semibold" />
        </span>
      )}
    </span>
  );
  return onPress ? (
    <button type="button" className="list-row is-clickable iv-alert-row" onClick={onPress}>
      {main}
    </button>
  ) : (
    <div className="list-row iv-alert-row">{main}</div>
  );
}

interface Detail {
  data: InvestSymbolDetail | null;
  error: string | null;
  /** the error's code (not_watched: the empty state) */
  code: string | null;
}

/** the symbol's detail, read when the screen is shown and again when the overview moves; an error keeps what was read */
function useDetail(symbol: string, rev: number | null, active: boolean): Detail {
  const [s, set] = useState<Detail>({ data: null, error: null, code: null });
  useEffect(() => {
    if (!active || !symbol) return;
    let live = true;
    // a second read while the first is out (StrictMode's trial remount) joins it: apiGet shares identical GETs in flight
    api.symbolDetail(symbol).then(
      (data) => live && set({ data, error: null, code: null }),
      (e) => {
        if (!live) return;
        const err = toApiError(e);
        set((p) => ({ data: p.data, error: err.message, code: err.code ?? null }));
      },
    );
    return () => {
      live = false;
    };
  }, [symbol, rev, active]);
  return s;
}
