import { josa } from "../format";
import type {
  InvestAction,
  InvestDirection,
  InvestOverview,
  InvestRuleChanges,
  InvestRuleDraft,
  InvestRuleKind,
  InvestRuleRow,
  InvestSettingsView,
  InvestStages,
  InvestWatch,
} from "@pickle/protocol";

/**
 * What the 투자 screen decides itself (everything it shows as a number or a rule sentence is the server's text):
 * which rules the sheet edits and what it may offer, the draft it sends, the 기한 dates, and the few sentences DD wrote
 * for the screen (DD 1935 §3, DD 2008, DD 2010 §1/§4/§7). Pure functions, unit-tested in qa/invest-rules.test.ts.
 */

/**
 * The kinds 규칙 추가 makes (DD 1935 §3-3). Resistance and invalidate rows come only from strategy proposals; the
 * sheet edits them too (price, 알림 · 전화, 기한) and deletes them, but never changes their kind (DD 2015-b).
 */
export const NEW_KINDS = ["stop", "target", "buy_zone", "alert"] as const;
export type NewKind = (typeof NEW_KINDS)[number];
export const KIND_WORD: Record<NewKind, string> = { stop: "손절", target: "익절", buy_zone: "매수 검토", alert: "가격 알림" };
export const isNewKind = (kind: InvestRuleKind): kind is NewKind => (NEW_KINDS as readonly string[]).includes(kind);

/** a kind's own word when the server's row text has none to give */
const RULE_WORD: Record<InvestRuleKind, string> = { ...KIND_WORD, resistance: "저항", invalidate: "전략 무효화" };

/**
 * a rule's word as its row says it, the server's text before the price: "1차 익절 $36.50 이상" → "1차 익절", "저항
 * $34.10" → "저항"; the kind's word when the text has no price (확인 불가)
 */
export function ruleWord(r: Pick<InvestRuleRow, "kind" | "level" | "left">): string {
  const before = pricePhrase(r.left)?.[0].trim();
  if (before) return before;
  return r.kind === "target" && r.level ? `${r.level}차 익절` : RULE_WORD[r.kind];
}

/**
 * the sheet's title: "SOXL 규칙 추가"; a rule's sheet names it as its row does, "SOXL 손절", "SOXL 1차 익절", "SOXL
 * 저항" (DD 2135): a rule's kind is not changed there (PATCH has no kind), so the title says it instead of a control
 */
export function sheetTitle(symbol: string, rule: Pick<InvestRuleRow, "kind" | "level" | "left"> | null): string {
  return rule ? `${symbol} ${ruleWord(rule)}` : `${symbol} 규칙 추가`;
}

/** a stop may sell, and only on a held symbol; nothing else ever does (G6: no automatic buy, no take-profit sale) */
export const canSell = (kind: InvestRuleKind, held: boolean) => kind === "stop" && held;

/** the 닿으면 choices: 알림 and 전화 for every kind, 매도 for a held stop */
export const actionChoices = (kind: InvestRuleKind, held: boolean): InvestAction[] => (canSell(kind, held) ? ["notify", "call", "sell"] : ["notify", "call"]);

/** what happens by default (DD 2010 §4): take-profit calls (G7), a held stop sells, the rest notify */
export function defaultAction(kind: InvestRuleKind, held: boolean): InvestAction {
  if (kind === "target") return "call";
  if (kind === "stop") return held ? "sell" : "notify";
  return "notify";
}

/** the direction a kind fixes; null = the person picks (가격 알림) or the server's stays (저항, 무효화) */

/** 한 번 알리고 멈추기 is offered on every rule but a stop that sells: a sale happens once anyway (DD 2042-b §1) */
export const canOnce = (kind: InvestRuleKind, action: InvestAction) => !(kind === "stop" && action === "sell");

/** what the sheet holds while the person edits */
export interface Draft {
  kind: InvestRuleKind;
  price: string;
  lo: string;
  hi: string;
  direction: InvestDirection;
  action: InvestAction;
  /** "YYYY-MM-DD" (KST) or null: no end */
  until: string | null;
  once: boolean;
  /** a stop's 장중 버퍼 field: "" = the operating default */
  bufferPct: string;
}

/** a typed price: digits with an optional decimal part, commas and $ or 원 allowed; zero and words refused */
export function parsePrice(text: string): number | null {
  const t = text.replace(/[\s,$원]/g, "");
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  const v = Number(t);
  return v > 0 && Number.isFinite(v) ? v : null;
}

/**
 * a typed 장중 버퍼: "" is the default (null), else a number from 1 to 20 with an optional decimal part ("7", "7.5",
 * "7%"); undefined = not a buffer the server takes
 */
export function parseBufferPct(text: string): number | null | undefined {
  const t = text.replace(/[\s%]/g, "");
  if (t === "") return null;
  if (!/^\d+(\.\d+)?$/.test(t)) return undefined;
  const v = Number(t);
  return v >= 1 && v <= 20 ? v : undefined;
}
export const BUFFER_RANGE = "장중 버퍼는 1–20% 사이로 정해 주세요.";

/** a number's server text as a field shows it: "$25.80" → "25.80", "189,400원" → "189400", "7%" → "7" */
const fieldText = (n: { v: number | null; text: string } | undefined) => (n && n.v !== null ? n.text.replace(/[\s$,원%]/g, "") : "");

/** the sheet's draft for a rule, or a new one on a symbol */
export function draftOf(rule: InvestRuleRow | null, held: boolean): Draft {
  if (!rule) return { kind: "stop", price: "", lo: "", hi: "", direction: "below", action: defaultAction("stop", held), until: null, once: false, bufferPct: "" };
  return {
    kind: rule.kind,
    price: fieldText(rule.price),
    lo: fieldText(rule.lo),
    hi: fieldText(rule.hi),
    direction: rule.direction,
    action: rule.action,
    until: rule.until,
    once: rule.once === true,
    // a buffer the person set shows as typed; the default leaves the field empty (its placeholder says the default)
    bufferPct: rule.kind === "stop" && rule.bufferDefault === false ? fieldText(rule.bufferPct) : "",
  };
}

/** what the draft sends, or null while it cannot be sent (a missing or bad price, a range upside down) */
export function toRuleDraft(d: Draft, symbol: string, held: boolean, level?: 1 | 2 | 3): InvestRuleDraft | null {
  const action: InvestAction = d.action === "sell" && !canSell(d.kind, held) ? defaultAction(d.kind, false) : d.action;
  const once = d.once && canOnce(d.kind, action);
  let buffer = {};
  if (d.kind === "stop") {
    const pct = parseBufferPct(d.bufferPct);
    if (pct === undefined) return null;
    buffer = { bufferPct: pct };
  }
  const base = { symbol, kind: d.kind, action, until: d.until, once, ...buffer };
  if (d.kind === "buy_zone") {
    const lo = parsePrice(d.lo);
    const hi = parsePrice(d.hi);
    if (lo === null || hi === null || hi <= lo) return null;
    return { ...base, lo, hi };
  }
  const price = parsePrice(d.price);
  if (price === null) return null;
  // only a price alert says which way (the protocol's draft): every other kind's direction is the server's
  const direction = d.kind === "alert" ? { direction: d.direction === "above" ? ("above" as const) : ("below" as const) } : {};
  return { ...base, price, ...direction, ...(d.kind === "target" && level ? { level } : {}) };
}

/** PATCH's `changes` from a draft: what a rule can change (agent-runtime 2052 D3), never its kind, direction or symbol */
export function ruleChanges(d: InvestRuleDraft): InvestRuleChanges {
  const c: InvestRuleChanges = { action: d.action, until: d.until ?? null, once: d.once === true };
  if (d.kind === "buy_zone") Object.assign(c, { lo: d.lo, hi: d.hi });
  else c.price = d.price;
  if (d.kind === "stop") c.bufferPct = d.bufferPct ?? null;
  return c;
}

// ─────────────────────────── 기한 (DD 2008 §5) ───────────────────────────

const KST = 9 * 3_600_000;
const DAY = 86_400_000;

/** the KST calendar day `plus` days from `now`: "2026-12-04" */
export const kstDay = (now: number, plus = 0) => new Date(now + KST + plus * DAY).toISOString().slice(0, 10);

/** switching 기한 on: a week from today (KST), and nothing before tomorrow */
export const untilDefault = (now: number) => kstDay(now, 7);
export const untilMin = (now: number) => kstDay(now, 1);

// ─────────────────────────── sentences DD wrote for the screen ───────────────────────────

/** under the 한 번 알리고 멈추기 switch while it is on (DD 2042-b §1) */
export const ONCE_NOTE = "닿으면 한 번 알리고 이 규칙을 멈춰요.";

/** a symbol with 이/가 as it is read: SOXL(엘)이, KORU(유)가, 005930(영)이 */
export function subjectOf(symbol: string): string {
  const ch = symbol.trim().slice(-1).toUpperCase();
  const code = ch.charCodeAt(0);
  if (code >= 0xac00 && code <= 0xd7a3) return josa(symbol, "이가");
  return `${symbol}${/[LMNR013678]/.test(ch) ? "이" : "가"}`;
}

/** above 규칙 지우기 when the rule is a live stop sale (DD 2008 §5) */
export const deleteNote = (r: Pick<InvestRuleRow, "symbol" | "kind" | "action">, mode: InvestOverview["mode"]) =>
  mode === "real" && r.kind === "stop" && r.action === "sell" ? `지우면 ${subjectOf(r.symbol)} 손절선에 닿아도 팔지 않아요.` : null;

/** why calls cannot be placed now (DD 2010 §4), and whether verifying the number fixes it; null when they can */
export function phoneNotice(s: Pick<InvestSettingsView, "callBlock">): { text: string; verify: boolean } | null {
  if (s.callBlock === "not_verified") return { text: "번호를 인증하지 않아 전화를 걸 수 없어요", verify: true };
  if (s.callBlock === "not_configured") return { text: "지금은 전화를 걸 수 없어요", verify: false };
  return null;
}
export const CALL_NOTE = "앱에서 인증한 번호로 걸어요. 하루 10통까지예요.";

/**
 * ③ footer, a paragraph each: the paper mode's meaning first (DD 2008 §1), then who changes alert prices (G8-5). Two
 * paragraphs, not one block of three sentences: at 320 / 130 % the sentence layout of one block took two lines more
 */
export function rulesFoot(mode: InvestOverview["mode"], agentName: string): string[] {
  const own = `알림 가격은 ${josa(agentName, "이가")} 혼자 바꾸지 않아요. 바꾸자는 제안은 채팅에서 확인을 받아요.`;
  return mode === "mock" ? ["모의 주문이라 손절선에 닿아도 주문을 내지 않고, 팔았을 시점과 가격만 기록해요.", own] : [own];
}

/**
 * a rule row's price phrase, to keep on one line: "1차 익절 $36.50 이상" → ["1차 익절 ", "$36.50 이상", ""]; the
 * server's text otherwise as it is (null). At 320 / 130 % the row broke "$36.50 / 이상" and, in WebKit, "$30. / 00–31.50"
 */
export function pricePhrase(text: string): [string, string, string] | null {
  const m = /(?:\$\d[\d,]*(?:\.\d+)?(?:–\d[\d,]*(?:\.\d+)?)?|\d[\d,]*(?:–\d[\d,]*)?원)(?:\s+(?:이하|이상))?/.exec(text);
  return m ? [text.slice(0, m.index), m[0], text.slice(m.index + m[0].length)] : null;
}

/** a live sale's action word is red (DD 1935 §1: "실제" in --danger) */
export const isLiveSale = (r: Pick<InvestRuleRow, "action">, mode: InvestOverview["mode"]) => r.action === "sell" && mode === "real";

/**
 * ② 감시 종목's top row and foot (DD 0225). No quote source (off) and quotes lost (blind) both say so in the server's
 * words at the top of the group, in its tone (caution unless the server says danger), and the group's foot is the
 * server's watch foot when it sends one, else its quotes line. Outside the run window (closed) and ok: no row.
 */
export function watchNotice(w: InvestWatch, quotesFoot: string | null | undefined): { notice: { tone: "danger" | "caution"; text: string } | null; foot: string | undefined } {
  const says = w.state === "off" || w.state === "blind";
  return { notice: says ? { tone: w.tone ?? "caution", text: w.text } : null, foot: (says ? w.foot : undefined) ?? quotesFoot ?? undefined };
}

/** ③ groups: one per watched symbol in the list's order, then any symbol a rule still names */
export function ruleGroups(o: Pick<InvestOverview, "watchlist" | "rules">): { symbol: string; rules: InvestRuleRow[] }[] {
  const order = [...o.watchlist.map((w) => w.symbol), ...o.rules.map((r) => r.symbol)].filter((s, i, a) => a.indexOf(s) === i);
  return order.map((symbol) => ({ symbol, rules: o.rules.filter((r) => r.symbol === symbol) }));
}

/** a symbol's market: the watch list's, else six digits are KR (agent-runtime 2006 §5) */
export const marketOf = (o: Pick<InvestOverview, "watchlist">, symbol: string): "US" | "KR" => o.watchlist.find((w) => w.symbol === symbol)?.market ?? (/^\d{6}$/.test(symbol) ? "KR" : "US");

export const isHeld = (o: Pick<InvestOverview, "watchlist">, symbol: string) => !!o.watchlist.find((w) => w.symbol === symbol)?.holding;

/** a gauge's tone and its one-sentence reading (the cells are drawn, the sentence is what is read) */
export const gaugeTone = (id: InvestStages["gauges"][number]["id"]) => (id === "worse" ? "caution" : id === "severe" ? "danger" : "label");
export function gaugeSaid(g: InvestStages["gauges"][number]): string {
  const met = g.cells.filter((c) => c === "met").length;
  const unknown = g.cells.filter((c) => c === "unknown").length;
  return `${g.label} ${g.cells.length}개 중 ${met}개 충족${unknown ? `, 확인 불가 ${unknown}개` : ""}`;
}
