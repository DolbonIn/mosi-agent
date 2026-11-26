/**
 * Invest wire types (agent-runtime 2006 §5–§7, 2039, 2052; DD 1935, 2008, 2010, 2015-b, 2042-b). B1 serves the
 * overview, symbols, rules, watchlist, Toss status, settings, the `invest` event and the alert and mock stop cards; the
 * other card types are here so every board shares one shape (B2: rule change, daily, level chart; C: deck; B4: real).
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

export type InvestCard = InvestAlertCard | InvestStopCard | InvestRuleChangeCard | InvestDailyCard | InvestLevelChartCard | InvestDeckCard;

/** PATCH /api/invest/settings */
export interface InvestSettingsPatch {
  calls?: Partial<InvestSettingsView["calls"]>;
}
