/**
 * Invest wire types (agent-runtime 2006 §5–§7, 2039, 2052; DD 1935, 2008, 2010, 2015-b, 2042-b). B1 serves the
 * overview, symbols, rules, watchlist, Toss status, settings, the `invest` event and the alert and mock stop cards; the
 * other card types are here so every board shares one shape (B2: rule change, daily, level chart; C: deck; B4: real).
 * B2a adds the indicator ledger, the forecast ledger, the event calendar and the D-1 card (`invest_event`). B2b-1 sends
 * the rule change card from the model's proposals (decided with POST /api/invest/proposals/:proposalId) and fills
 * `InvestForecast.proposal`.
 *
 * Every figure and time text is made by the server with @pickle/quant format.ts; screens show `text` as it comes and
 * never format a number again (DD 1935 §0-5). A `v: null` figure reads "확인 불가".
 */
type ID = string;
type Millis = number;

export type InvestUnit = "usd" | "krw" | "index" | "pct" | "pctp" | "qty" | "bp" | "count";
export interface InvestNum {
  v: number | null;
  text: string;
  unit: InvestUnit;
  estimate?: true;
}
export type InvestGrade = "A" | "B+" | "B" | "C";
/** where a figure came from: 토스증권 · A, Yahoo(지연 시세) · B+ … (the server's source table) */
export interface InvestSource {
  name: string;
  grade: InvestGrade;
  asOf: string;
  delay?: string;
}
/** DD 1935 §0-4's four marks by meaning, never by colour (DD 2010 §7 end) */
export type InvestSignal = "risk" | "caution" | "normal" | "unknown";
export type InvestMarket = "US" | "KR";
export type InvestMode = "mock" | "real";

export type InvestRuleKind = "stop" | "target" | "buy_zone" | "alert" | "resistance" | "invalidate";
export type InvestAction = "notify" | "call" | "sell";
export type InvestDirection = "below" | "above" | "inside";
/**
 * armed: watching (대기, or `12-01까지` with a deadline); hit: inside the condition since its alert, nothing is sent
 * again until a check sees it outside (닿음); paused: alerted once and stopped ("한 번 알리고 멈추기", and every sell
 * stop after its record) until the person saves the rule again (멈춤); expired: past its deadline (만료)
 */
export type InvestRuleState = "armed" | "hit" | "paused" | "expired";
/** how a stop is judged (D5-2): the close and an intraday buffer below the stop, or the intraday price alone */
export type InvestStopBasis = "close_and_intraday" | "intraday";

export interface InvestRuleRow {
  id: ID;
  symbol: string;
  rev: number;
  kind: InvestRuleKind;
  level?: 1 | 2 | 3;
  price?: InvestNum;
  lo?: InvestNum;
  hi?: InvestNum;
  direction: InvestDirection;
  action: InvestAction;
  until: string | null;
  once?: true;
  state: InvestRuleState;
  hitAt?: Millis;
  pausedAt?: Millis;
  /** stops: the intraday buffer price, its percent, and whether the percent is the operating default (5%) */
  buffer?: InvestNum;
  bufferPct?: InvestNum;
  bufferDefault?: boolean;
  /** "손절 $25.80 이하" / "기록(모의)" / "닿음 · 11-27 00:45" */
  left: string;
  actionText: string;
  stateText: string;
  /** the sheet's footnote under the result sentence for a hit or paused rule (DD 2008 §5, DD 2042-b §1) */
  stateFoot?: string;
}

export interface InvestSymbolRow {
  symbol: string;
  name: string;
  market: InvestMarket;
  price: InvestNum | null;
  /** 전일 대비 */
  change: InvestNum | null;
  holding: { qty: InvestNum; vsAvg: InvestNum; line: string } | null;
  /** the last value from before the watch went blind (DD 2010 §7): change drawn in --label-3 */
  stale?: true;
}

export interface InvestTossStatus {
  connected: boolean;
  okAt: Millis | null;
  checkedAt: Millis | null;
  /** the server's outbound IP as the operator set it (PICKLE_OUTBOUND_IP); null when not set */
  outboundIp: string | null;
  error: { code: "ip_not_allowed" | "auth" | "rate_limited" | "down" | "off"; at: Millis; text: string } | null;
}

/** Why real orders cannot be turned on (B4). A device without a device key cannot sign: the app knows that itself
 * and says so first (DD 2042-b §5); the server refuses an unsigned enable. */
export type InvestRealBlocker = "toss_off" | "toss_not_connected" | "toss_never_ok" | "toss_ip_blocked";

export interface InvestSettingsView {
  mode: InvestMode;
  realSince?: Millis;
  toss: InvestTossStatus;
  /** calls for events no rule decides (DD 2010 §4): stop results on, stage changes off, watch expiry off */
  calls: { stopResult: boolean; stage: boolean; expiry: boolean };
  /** why calls cannot go out now; null: they can */
  callBlock: "not_verified" | "not_configured" | null;
  /** the footnote under a call action, the words of a preview's callNote (DD 2341: the app keeps no copy) */
  callNote: string;
  /** the operating default intraday buffer (5%): the add sheet's placeholder before the first preview (DD 2341) */
  bufferPctDefault: InvestNum;
  phone: { masked: string; verified: boolean } | null;
  openOrders: number;
  realBlockers: InvestRealBlocker[];
}

export interface InvestWatch {
  /** off: the server has no quote source switched on; closed: outside the run window; blind: quotes stopped */
  state: "ok" | "closed" | "blind" | "off";
  since?: Millis;
  tone?: "danger" | "caution";
  text: string;
  /** the watchlist section's foot (DD 2010 §1 / §7) */
  foot?: string;
}

export interface InvestStages {
  line: string;
  sub: string;
  escape: { floor: 1 | 2 | 3 | 4; ceiling: 1 | 2 | 3 | 4; label: string };
  recovery: { stage: 0 | 1 | 2 | 3 | "hold"; label: string };
  gauges: { id: "worse" | "severe" | "recovery"; label: string; cells: ("met" | "unmet" | "unknown")[]; text: string }[];
  next: string | null;
}

export interface InvestOverview {
  rev: number;
  mode: InvestMode;
  /** B1b */
  stages: InvestStages | null;
  /** newest first */
  watchlist: InvestSymbolRow[];
  rules: InvestRuleRow[];
  /** B2: the last 3 */
  reports: { id: ID; title: string; line: string; threadId: ID; messageId: ID }[];
  /** C */
  decks: { id: ID; headline: string; meta: string; attachmentId: ID; thumbUrl: string }[];
  settings: InvestSettingsView;
  /** "시세 00:45 기준 · 토스증권. 가격 규칙은 개장 15분 뒤부터 마감까지 5분마다 확인해요." (null with no symbols: the app shows the period sentence alone) */
  quotesFoot: string | null;
  watch: InvestWatch;
}

export interface InvestBar {
  t: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface InvestSymbolDetail {
  row: InvestSymbolRow;
  rules: InvestRuleRow[];
  /** the last 5 alerts, newest first */
  alerts: { id: ID; kind: string; title: string; at: Millis; threadId: ID | null; messageId: ID | null }[];
  chart: { bars: InvestBar[]; levels: { kind: string; label: string; price: number }[]; asOf: string; source: InvestSource } | null;
}

export interface InvestRuleDraft {
  symbol: string;
  kind: InvestRuleKind;
  level?: 1 | 2 | 3;
  price?: number;
  lo?: number;
  hi?: number;
  /** price alerts only; the other kinds have a fixed direction */
  direction?: "below" | "above";
  action: InvestAction;
  until?: string | null;
  once?: boolean;
  /** stops: 1–20; null or absent = the default 5 */
  bufferPct?: number | null;
}

export interface InvestRuleChanges {
  price?: number;
  lo?: number;
  hi?: number;
  direction?: "below" | "above";
  action?: InvestAction;
  until?: string | null;
  once?: boolean;
  bufferPct?: number | null;
}

/** POST /api/invest/rules/preview: what saving would do, in the server's own sentence (DD 2042-b §3) */
export interface InvestRulePreview {
  previewId: ID;
  expiresAt: Millis;
  /** "SOXL 손절을 $25.80에서 $27.00으로 바꿔요." + the result sentence; nothing changed: "지금 규칙이에요." + it (DD 2135) */
  sentence: string;
  /** false when the changes leave the rule as it is (the sheet keeps 저장 off; a paused rule still has 다시 감시하기) */
  changed: boolean;
  /** a stop above the current price (DD 1935 §2-3 4) */
  warning: string | null;
  basis: InvestStopBasis | null;
  buffer: InvestNum | null;
  bufferPct: InvestNum | null;
  bufferDefault: boolean;
  /** the buffer row's footnote (DD 2042-b §2) */
  bufferFoot: string | null;
  sellable: InvestNum | null;
  price: InvestNum | null;
  /** hold: a real sell rule (ConfirmButton) */
  confirm: "tap" | "hold";
  /** under the action row when it is a call (DD 2010 §4) */
  callNote: string | null;
}

export type InvestCall =
  | { at: Millis; ok: true; text: string }
  | { at: Millis; ok: false; reason: "not_verified" | "not_configured" | "daily_limit" | "failed"; text: string };

export type InvestAlertKind =
  | "buy_zone_wait"
  | "buy_zone_met"
  | "target"
  | "stop_alert"
  | "breakout"
  | "invalidated"
  | "chase"
  | "gap"
  | "split"
  | "custom"
  | "expired";

export interface InvestAlertCard {
  type: "invest_alert";
  alertId: ID;
  ruleId: ID;
  symbol: string;
  kind: InvestAlertKind;
  level?: 1 | 2 | 3;
  /** the state before this check was not known (first look, after quotes stopped, after an edit): not "새 돌파" */
  noPrior?: true;
  tone?: "danger" | "caution";
  title: string;
  titleLines?: string[];
  at: Millis;
  atText: string;
  /** empty on expired (DD 2010 §2) */
  price?: InvestNum;
  sub?: string;
  rows: { label: string; value: string }[];
  call?: InvestCall;
  notes: string[];
  foot: string;
  disclaimer?: true;
}

export interface InvestStopCard {
  type: "invest_stop";
  orderId: ID;
  ruleId: ID;
  symbol: string;
  mode: InvestMode;
  state: "recorded" | "submitted" | "filled" | "partial" | "failed" | "skipped";
  title: string;
  hero: InvestNum;
  rows: { label: string; value: string }[];
  status?: string;
  reason?: { code: "ip_not_allowed" | "early_close" | "off_hours" | "zero_sellable" | "rejected" | "calendar_unknown"; text: string; ip?: string };
  notes: string[];
  call?: InvestCall;
  foot: string;
  disclaimer?: true;
}

/**
 * The model's proposal to move rules (A12 · G8-5, DD 1935 §2-3): nothing changed until the person decides with POST
 * /api/invest/proposals/:proposalId {decision: "apply" | "keep"} → {card}; 409 proposal_stale / proposal_decided and 410
 * proposal_expired carry the card too. The stored message's card follows the decision (`message` event). A change row
 * reads `$30.00 → $30.50`; a new rule's `없음 → $30.50`, a rule taken away `$30.50 → 없음` (DD 0405 G).
 */
export interface InvestRuleChangeCard {
  type: "invest_rule_change";
  proposalId: ID;
  symbol: string;
  title: string;
  changes: { label: string; from: string; to: string }[];
  reason: string;
  reasonFoot: string;
  result: string;
  warning?: string;
  confirm: "tap" | "hold";
  status: "pending" | "applied" | "kept" | "expired" | "stale";
  decidedAt?: Millis;
  expiresAt: Millis;
  disclaimer?: true;
}

export interface InvestDailyCard {
  type: "invest_daily";
  reportId: ID;
  title: string;
  atText: string;
  highlights: { tone: "danger" | "caution"; text: string }[];
  moreCount?: number;
  stageLine: string;
  stageSub: string;
  summary: string[];
  tally: { signal: InvestSignal; label: string; count: number }[];
  rows: { label: string; value: string }[];
  pending?: string;
  deck: { state: "none" | "making" | "ready"; deckId?: ID };
  foot: string;
  disclaimer?: true;
}

export interface InvestLevelChartCard {
  type: "invest_level_chart";
  symbol: string;
  title: string;
  span: string;
  chart: { bars: InvestBar[]; levels: { kind: string; label: string; price: number }[]; asOf: string };
  levels: { label: string; value: string; basis: string }[];
  aria: string;
  foot: string;
  disclaimer?: true;
}

export interface InvestDeckCard {
  type: "invest_deck";
  deckId: ID;
  state: "making" | "ready" | "failed";
  name: string;
  progress?: { done: number; total: number };
  attachmentId?: ID;
  thumbUrl?: string;
  meta?: string;
  summary?: string[];
  failReason?: string;
  foot?: string;
  disclaimer?: true;
}

/**
 * The D-1 reminder (DD 0109 §1; team-lead 0056: 08:00 KST the day before the event's market date). One card per person
 * and send: one row for one event, several rows under "일정 N개". No buttons, no tap target; A17 at the end.
 */
export interface InvestEventCard {
  type: "invest_event";
  /** the event's heading (symbol first) when one row; "일정 N개" when several */
  title: string;
  rows: { eventId: ID; title: string; when: string; foot: string }[];
  disclaimer?: true;
}

export type InvestCard = InvestAlertCard | InvestStopCard | InvestRuleChangeCard | InvestDailyCard | InvestLevelChartCard | InvestDeckCard | InvestEventCard;

// ───────────── B2a: the indicator ledger, the forecast ledger, the event calendar ─────────────

/**
 * A source's tier (B1): T1 primary (filings, rules, contracts, official series), T2 measured (APIs that measure, such
 * as 토스증권 and Yahoo), T3 analysis (brokers, research), T4 field (posts, videos, interviews: grade C until a T1 or T2
 * source confirms it)
 */
export type InvestTier = "T1" | "T2" | "T3" | "T4";
/** B1.2: L1 leads alone, L2 leads only in a pair, G moves with, T trails (checks only) */
export type InvestLeadClass = "L1" | "L2" | "G" | "T";
/** a ledger value's unit: the invest units, 조 tokens (T), GW, $B, or a worded value (text) */
export type InvestLedgerUnit = InvestUnit | "T" | "GW" | "$B" | "text";
/** who wrote a ledger, forecast or event row: the server's code, the model (B2b tools), or the person (these APIs) */
export type InvestAuthor = "code" | "model" | "person";

/** one row of the indicator ledger (B2's nine fields). GET /api/invest/ledger */
export interface InvestLedgerEntry {
  id: string;
  /** the day or time the figure describes: YYYY-MM-DD or an ISO time */
  asOf: string;
  /** when it was published or read, when that differs */
  publishedAt: string | null;
  /** a number and its text in `unit` (format.ts); null for a worded value */
  value: { v: number; text: string } | null;
  valueText: string | null;
  unit: InvestLedgerUnit;
  definition: string;
  source: string;
  sourceTier: InvestTier;
  url: string | null;
  revision: string | null;
  confidence: InvestGrade;
  leadClass: InvestLeadClass | null;
  author: InvestAuthor;
  /** a row the server keeps for everyone (a public series), not this person's */
  shared: boolean;
  createdAt: Millis;
}

/** POST /api/invest/ledger (author person; the same checks guard the model's tool) */
export interface InvestLedgerDraft {
  id: string;
  asOf: string;
  publishedAt?: string | null;
  value?: number | null;
  valueText?: string | null;
  unit: InvestLedgerUnit;
  definition: string;
  source: string;
  sourceTier: InvestTier;
  url?: string | null;
  revision?: string | null;
  confidence: InvestGrade;
  leadClass?: InvestLeadClass | null;
}

export type InvestOutcome = "hit" | "miss" | "partial";
export type InvestErrorCause = "data" | "interpretation" | "model" | "timing" | "narrative";
/** open: on or before its due day (기한 전); waiting: past it, not judged (판정 기다림); or the person's judgement */
export type InvestForecastStatus = "open" | "waiting" | InvestOutcome;

/** one forecast (B6). The person judges it; the model only proposes (B2b) */
export interface InvestForecast {
  id: ID;
  /** KST day it was made */
  madeOn: string;
  claim: string;
  /** the stated probability, 0–1, and its text (65%) */
  probability: { v: number; text: string };
  /** the stated interval, both ends in one unit */
  interval: { lo: number; hi: number; unit: InvestLedgerUnit; text: string } | null;
  /** KST day; the forecast is judged by it */
  dueOn: string;
  /** 12월 31일까지 · 2027년 3월 31일까지 (another KST year names it, DD 0405 E) */
  dueText: string;
  criterion: string;
  status: InvestForecastStatus;
  /** 기한 전 · 판정 기다림 · 적중 · 빗나감 · 부분 적중 (DD 0109 §2) */
  statusText: string;
  actual: { v: number; text: string } | null;
  /** how far the actual value fell outside the interval, in its unit, signed (above +); 0 inside. text: 구간 안 ·
   * 구간보다 0.20%p 위 · 구간보다 $0.30 아래 (DD 0405 D) */
  intervalError: { v: number; text: string } | null;
  errorCause: InvestErrorCause | null;
  /** 데이터 · 해석 · 모델 · 시기 · 이야기 */
  errorCauseText: string | null;
  /** the model's proposed judgement (B2b-1), the agent's own name first: 모시 제안: 빗나감 · 시기; never the outcome */
  proposal: { outcome: InvestOutcome; errorCause: InvestErrorCause | null; text: string } | null;
  ledgerIds: string[];
  author: InvestAuthor;
  resolvedAt: Millis | null;
  rev: number;
  createdAt: Millis;
  updatedAt: Millis;
}

/** POST /api/invest/forecasts */
export interface InvestForecastDraft {
  claim: string;
  /** 0–1, both ends left out */
  p: number;
  interval?: { lo: number; hi: number; unit: InvestLedgerUnit } | null;
  dueOn: string;
  criterion: string;
  ledgerIds?: string[];
}

/** PATCH /api/invest/forecasts/:id — the person's judgement; outcome null takes it back. `rev` (optional) guards a stale screen */
export interface InvestForecastJudgement {
  outcome: InvestOutcome | null;
  actual?: number | null;
  errorCause?: InvestErrorCause | null;
  rev?: number;
}

/**
 * The score (B6, DD 0109 §2), over judged forecasts by due day: direction hit rate for 3 and 12 months and the Brier
 * score for 12 months, partial hits left out of both. The sentences are the server's.
 */
export interface InvestForecastScore {
  /** 방향 적중률 3개월 64% · 11건 · 목표 65% / 방향 적중률 12개월 … / Brier 점수 0.21 · 목표 0.25 이하 (with its
   * foot); the count is the window's hits and misses (DD 0405 B); a window with nothing judged in it has no row */
  rows: { key: "hit3m" | "hit12m" | "brier"; text: string; foot?: string }[];
  /** 부분 적중 2건은 두 점수에 넣지 않았어요. — beside rows only */
  partialFoot?: string;
  /** when, and only when, rows is empty (DD 0405 C): 아직 판정한 예측이 없어요. · 부분 적중 2건뿐이라 아직 점수를 내지
   * 않아요. · 최근 12개월에 판정한 예측이 없어요. */
  empty?: string;
  hitRate3m: number | null;
  hitRate12m: number | null;
  brier: number | null;
  /** hits and misses in the 12-month window, and the partial hits beside them */
  judged: number;
  partial: number;
}

/** GET /api/invest/forecasts: the forecasts, the score, and the words of the judging sheet (the app keeps no copy) */
export interface InvestForecastList {
  items: InvestForecast[];
  score: InvestForecastScore;
  outcomes: { value: InvestOutcome; word: string }[];
  /** picked for a miss or a partial hit: the short word for tables and counts, the sentence for the list */
  causes: { value: InvestErrorCause; word: string; sentence: string }[];
}

export type InvestEventKind = "earnings" | "macro" | "policy" | "contract" | "other";

/** one calendar event. GET /api/invest/events */
export interface InvestEvent {
  id: ID;
  market: InvestMarket;
  /** the market's date */
  day: string;
  /** the market's wall-clock time, HH:MM */
  time: string | null;
  kind: InvestEventKind;
  title: string;
  symbol: string | null;
  /** the title as cards show it, the symbol first (DD 0109 §1) */
  heading: string;
  /** 11월 26일 06:20(미 동부 16:20) · 11월 26일 10:00 · 미 동부 11월 25일 · 시각 미정 · 11월 26일 · 시각 미정; another
   * KST year names it: 2027년 1월 5일 06:20(미 동부 16:20) · 미 동부 2027년 1월 5일 · 시각 미정 (DD 0405 E) */
  when: string;
  source: string;
  sourceTier: InvestTier;
  url: string | null;
  confidence: InvestGrade;
  /** 출처 · 등급 */
  foot: string;
  remind: boolean;
  /** the KST day its D-1 goes, the day before `day` */
  remindOn: string;
  /** its D-1 went (by any path) */
  reminded: boolean;
  author: InvestAuthor;
  createdAt: Millis;
  updatedAt: Millis;
}

/** POST /api/invest/events */
export interface InvestEventDraft {
  market: InvestMarket;
  day: string;
  time?: string | null;
  kind: InvestEventKind;
  title: string;
  symbol?: string | null;
  source: string;
  sourceTier: InvestTier;
  url?: string | null;
  confidence: InvestGrade;
  remind?: boolean;
}

/** PATCH /api/invest/settings */
export interface InvestSettingsPatch {
  calls?: Partial<InvestSettingsView["calls"]>;
}
