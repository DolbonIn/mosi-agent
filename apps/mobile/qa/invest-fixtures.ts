/**
 * 투자 cards for the second slice's tests and captures: rule change, the 08:00 report, D-1 events and the deck.
 *   - rule change and report: the server's own cards word for word (apps/server test/invest-proposals.test.ts and
 *     invest-report.test.ts at 4ba7be7). The server makes them inside a turn or the 08:00 job, out of a unit's reach.
 *   - D-1 events and the report's 일정 rows: the server's builders (invest/events.ts eventCard, report.ts eventLines).
 *   - deck: hand-made (board C has no server yet: DD 1935 §2-6, 0059 §3, agent-runtime 0221).
 * Shared by qa/invest-cards-2.test.ts and the invest capture stub.
 */
import type { InvestDailyCard, InvestDeckCard, InvestEventCard, InvestRuleChangeCard } from "@pickle/protocol";
import { eventCard, type EventRow } from "../../server/src/invest/events.ts";
import { eventLines } from "../../server/src/invest/report.ts";

const DAY = 86_400_000;
/** 11-27 08:00 KST: the report's hour; the D-1 rows are the US session of 11-27 (KST 11-28 morning) */
export const FIX_NOW = Date.UTC(2026, 10, 26, 23, 0);

/** the server's foot for a card made from the person's own request (proposals.ts REQUEST_FOOT) */
const REQUEST_FOOT = "요청으로 만든 제안이에요.";

const ruleBase: InvestRuleChangeCard = {
  type: "invest_rule_change",
  proposalId: "p_soxl_1",
  symbol: "SOXL",
  title: "SOXL 손절선을 $30.50으로 올릴까요?",
  changes: [{ label: "손절", from: "$25.80", to: "$30.50" }],
  reason: "ATR 두 배 아래로 손절을 올려요",
  reasonFoot: REQUEST_FOOT,
  result: "장중에 $30.50 이하로 내려가면 알려요.",
  confirm: "tap",
  status: "pending",
  expiresAt: FIX_NOW + DAY,
  disclaimer: true,
};

export const RULE_CHANGES: Record<string, InvestRuleChangeCard> = {
  "rc-mock": ruleBase,
  // a real sell stop above the price (invest-proposals "a real sell stop" + "a stop above the price warns")
  "rc-real": {
    ...ruleBase,
    proposalId: "p_soxl_2",
    title: "SOXL 손절선을 $27.00으로 올릴까요?",
    changes: [{ label: "손절", from: "$25.80", to: "$27.00" }],
    reason: "20일선 아래로 마감했어요",
    reasonFoot: "11-27 기준, Yahoo 일봉 · B+",
    result: "실제 주문이 켜져 있어서, 장중에 $27.00 이하로 내려가면 바로 47주를 시장가로 팔아요.",
    warning: "지금 가격 $26.50보다 높아서, 바꾸면 바로 손절 조건이 돼요.",
    confirm: "hold",
  },
  // several: one line each (DD 0452 §4: `\n`, the card draws them as lines)
  "rc-many": {
    ...ruleBase,
    proposalId: "p_soxl_3",
    title: "SOXL 새 전략 가격 3개를 적용할까요?",
    changes: [
      { label: "손절", from: "$25.80", to: "$27.00" },
      { label: "저항", from: "없음", to: "$34.10" },
      { label: "전략 무효화", from: "없음", to: "$24.00 이하" },
    ],
    reason: "2 ATR 아래예요",
    reasonFoot: "11-27 기준, Yahoo 일봉 · B+",
    result: "손절은 장중에 $27.00 이하로 내려가면 전화로 알려요.\n저항은 $34.10을 넘으면 알려요.\n전략 무효화는 $24.00 이하로 내려가면 알려요.",
  },
  // one taken away among two: 규칙 N개를 바꿀까요, the removal line without its kind first (DD 0452 §2–4)
  "rc-mixed": {
    ...ruleBase,
    proposalId: "p_soxl_8",
    title: "SOXL 규칙 2개를 바꿀까요?",
    changes: [
      { label: "매수 검토", from: "$28.00–29.00", to: "없음" },
      { label: "저항", from: "없음", to: "$34.10" },
    ],
    reason: "가격이 매수 검토 구간 위로 올라와서 저항을 새로 봐요",
    reasonFoot: "11-27 기준, Yahoo 일봉 · B+",
    result: "지우면 SOXL이 매수 검토 구간에 들어와도 알리지 않아요.\n저항은 $34.10을 넘으면 알려요.",
  },
  // the person's request with no reason given in that turn (DD 0717): no reason line, the request foot alone
  "rc-noreason": {
    ...ruleBase,
    proposalId: "p_soxl_9",
    title: "SOXL 손절선을 지울까요?",
    changes: [{ label: "손절", from: "$25.80", to: "없음" }],
    reason: undefined,
    result: "지우면 SOXL이 손절선에 닿아도 알리지 않아요.",
  },
  "rc-applied": { ...ruleBase, proposalId: "p_soxl_4", status: "applied", decidedAt: FIX_NOW - 60_000 },
  "rc-kept": { ...ruleBase, proposalId: "p_soxl_5", status: "kept", decidedAt: FIX_NOW - 60_000 },
  "rc-expired": { ...ruleBase, proposalId: "p_soxl_6", status: "expired" },
  "rc-stale": { ...ruleBase, proposalId: "p_soxl_7", status: "stale" },
};

/** calendar rows as the server stores them (invest_events), for its own builders */
const event = (over: Partial<EventRow> & Pick<EventRow, "id" | "title">): EventRow => ({
  user_id: "u_fix",
  market: "US",
  day: "2026-11-27",
  time: null,
  kind: "earnings",
  symbol: null,
  source: "Federal Reserve",
  source_tier: "T1",
  confidence: "A",
  url: null,
  author: "person",
  remind: 1,
  created_at: FIX_NOW - 5 * DAY,
  updated_at: FIX_NOW - 5 * DAY,
  disc_source: null,
  disc_item: null,
  ...over,
});
const NVDA = event({ id: "ev_nvda", title: "3분기 실적 발표", symbol: "NVDA", time: "16:20", source: "NVIDIA IR" });
const MINUTES = event({ id: "ev_minutes", title: "FOMC 의사록 공개", kind: "macro" });
const ADP = event({ id: "ev_adp", title: "ADP 고용", kind: "macro", time: "08:15", source: "ADP" });
const GDP = event({ id: "ev_gdp", title: "GDP 잠정치", kind: "macro", time: "08:30", source: "BEA" });

/** D-1 cards (DD 0109 §1): one event; several on one day are one card */
export const EVENTS: Record<string, InvestEventCard> = {
  "event-one": eventCard([NVDA], FIX_NOW),
  "event-many": eventCard([NVDA, ADP, MINUTES], FIX_NOW),
};

// the server's first report of invest-report.test.ts (12-01 there; the date moved to the fixtures' day)
const dailyBase: InvestDailyCard = {
  type: "invest_daily",
  reportId: "ir_1127",
  title: "시장 위험 보고서",
  atText: "11월 27일(금) 08:00",
  highlights: [{ tone: "caution", text: "하이일드 스프레드가 3.5%p 이상이 됐어요" }],
  stageLine: "탈출 3단계 방어 준비 · 회복 최소 1단계",
  summary: [
    "하이일드 스프레드가 3.5%p를 넘어 위험 쪽 신호가 커졌어요.",
    "VIX가 18로 내려와 회복 신호 하나가 켜졌어요.",
    "지수는 200일선 위에서 옆으로 움직였어요.",
  ],
  tally: [
    { signal: "risk", label: "위험", count: 2 },
    { signal: "caution", label: "경계", count: 0 },
    { signal: "normal", label: "정상", count: 4 },
    { signal: "unknown", label: "확인 불가", count: 5 },
  ],
  rows: [
    { label: "11지표", value: "위험 2 · 경계 0 · 정상 4 · 확인 불가 5" },
    { label: "신호", value: "악화 2/8 · 심각 0/5 · 회복 3/6" },
  ],
  pending: "지표 2개 값이 없어서 회복 단계는 아직 몰라요.",
  deck: { state: "none" },
  foot: "기준 11월 27일 08:00 · FRED · Yahoo(지연 시세)",
  disclaimer: true,
};

export const DAILIES: Record<string, InvestDailyCard> = {
  // the first judgment: no stageSub, one caution line, the pending sentence
  "daily-first": dailyBase,
  // a move up (DD 0828 1a: the move is the stage line's sub with its tone, not a highlight), two lines and 외 1건,
  // the deck being made, D-1 rows (DD 0109 §1: 일정 under the rows, three at most, 4개 in the head)
  "daily-move": {
    ...dailyBase,
    reportId: "ir_1127b",
    highlights: [
      { tone: "caution", text: "하이일드 스프레드가 3.5%p 이상이 됐어요" },
      { tone: "caution", text: "VIX가 25 이상이 됐어요" },
    ],
    moreCount: 1,
    stageSub: "탈출 최소 1단계 → 탈출 3단계 · 회복 최소 2 → 1단계",
    stageTone: "caution",
    events: eventLines([NVDA, ADP, GDP, MINUTES], FIX_NOW),
    deck: { state: "making", deckId: "deck_1127b" },
  },
  // escape stage 4 (danger tone), a severe-side break, a recovery line (plain), a source that did not answer today
  "daily-danger": {
    ...dailyBase,
    reportId: "ir_1127c",
    highlights: [
      { tone: "danger", text: "VIX가 30 이상이 됐어요" },
      { tone: "plain", text: "S&P500이 200일선 위로 올라왔어요" },
    ],
    stageLine: "탈출 4단계 회피 · 회복 0단계 하락 진행",
    stageSub: "탈출 3 → 4단계",
    stageTone: "danger",
    dataGap: "오늘 지표 1개를 받지 못했어요.",
    pending: undefined,
    // its deck card went out in a later row: 덱 보기 has the id on the report (agent-runtime 0221; not in the protocol yet)
    deck: { state: "ready", deckId: "deck_1127", ...{ attachmentId: "att_deck_1127" } },
  },
  // the day after a US holiday, no valid summary (DD 0733 3), the same stage as yesterday
  "daily-holiday": {
    ...dailyBase,
    reportId: "ir_1127d",
    holidayNote: "휴장일이라 11월 25일(수) 마감 기준이에요.",
    highlights: [],
    stageSub: "어제와 같아요",
    summary: [],
    summaryNote: "오늘은 요약을 쓰지 못했어요.",
    pending: undefined,
  },
};

const deckBase: InvestDeckCard = {
  type: "invest_deck",
  deckId: "deck_1127",
  state: "ready",
  name: "11월 27일 일일 심층판",
  attachmentId: "att_deck_1127",
  thumbUrl: "/api/attachments/att_thumb_1127/raw",
  // the time once, in the foot (DD 2225 decision 2: meta 28장 · PDF)
  meta: "28장 · PDF",
  summary: [
    "탈출 단계는 3단계 방어 준비예요.",
    "하이일드 스프레드가 3.5%p 문턱을 넘었어요.",
    "SOXL은 손절선 $25.80에서 26% 위에 있어요.",
  ],
  foot: "기준 11월 27일 08:00 · FRED · Yahoo(지연 시세)",
  disclaimer: true,
};

export const DECKS: Record<string, InvestDeckCard> = {
  "deck-ready": deckBase,
  "deck-making": { ...deckBase, deckId: "deck_1127b", state: "making", progress: { done: 12, total: 28 }, attachmentId: undefined, meta: undefined, summary: undefined, disclaimer: undefined, foot: undefined },
  "deck-failed": {
    ...deckBase,
    deckId: "deck_1127c",
    state: "failed",
    attachmentId: undefined,
    meta: undefined,
    summary: undefined,
    failReason: "검수에서 걸린 곳을 고치지 못했어요.",
  },
};
