import { describe, expect, test } from "bun:test";
import type { InvestStages } from "@pickle/protocol";
import {
  actionChoices,
  boardOf,
  STAGE_EMPTY,
  stageEmptyLine,
  BUFFER_RANGE,
  CALL_NOTE,
  canOnce,
  canSell,
  defaultAction,
  deleteNote,
  draftOf,
  gaugeSaid,
  gaugeTone,
  isLiveSale,
  kstDay,
  marketOf,
  ONCE_NOTE,
  parseBufferPct,
  parsePrice,
  phoneNotice,
  pricePhrase,
  ruleChanges,
  ruleGroups,
  ruleWord,
  rulesFoot,
  sheetTitle,
  subjectOf,
  toRuleDraft,
  untilDefault,
  untilMin,
  watchNotice,
  type Draft,
} from "../src/screens/more/invest/rules";
import type { InvestNum, InvestRuleRow, InvestSymbolRow } from "@pickle/protocol";

/**
 * What the 투자 screen decides itself (every number and rule sentence it shows is the server's text): the sheet's draft
 * and what it may offer (G6: only a held stop sells; DD 2010 §4 default actions), the 기한 dates in KST (DD 2008 §5),
 * and the sentences DD wrote for the screen. Synthetic symbols and prices only.
 */

const kst = (y: number, m: number, d: number, h: number, min: number) => Date.UTC(y, m - 1, d, h - 9, min);
const usd = (v: number | null, text: string): InvestNum => ({ v, text, unit: "usd" });
const rule = (p: Partial<InvestRuleRow>): InvestRuleRow => ({
  id: "r1",
  symbol: "SOXL",
  rev: 3,
  kind: "stop",
  price: usd(25.8, "$25.80"),
  direction: "below",
  action: "sell",
  until: null,
  state: "armed",
  left: "손절 $25.80 이하",
  actionText: "기록(모의)",
  stateText: "대기",
  ...p,
});
const sym = (symbol: string, market: "US" | "KR", held = false): InvestSymbolRow => ({
  symbol,
  name: symbol,
  market,
  price: usd(30, "$30.00"),
  change: null,
  holding: held ? { qty: { v: 47, text: "47주", unit: "qty" }, vsAvg: { v: 6.8, text: "+6.80%", unit: "pct" }, line: "보유 47주 · 평단 대비 +6.80%" } : null,
});
const draft = (p: Partial<Draft>): Draft => ({ kind: "stop", price: "27", lo: "", hi: "", direction: "below", action: "notify", until: null, once: false, bufferPct: "", ...p });

describe("what the sheet may offer (G6, DD 2010 §4)", () => {
  test("only a stop on a held symbol may sell", () => {
    expect(canSell("stop", true)).toBe(true);
    expect(canSell("stop", false)).toBe(false);
    for (const k of ["target", "buy_zone", "alert", "resistance", "invalidate"] as const) expect(canSell(k, true)).toBe(false);
    expect(actionChoices("stop", true)).toEqual(["notify", "call", "sell"]);
    expect(actionChoices("stop", false)).toEqual(["notify", "call"]);
    expect(actionChoices("resistance", true)).toEqual(["notify", "call"]);
  });
  test("default actions: take-profit calls, a held stop sells, the rest notify", () => {
    expect(defaultAction("target", false)).toBe("call");
    expect(defaultAction("stop", true)).toBe("sell");
    expect(defaultAction("stop", false)).toBe("notify");
    expect(defaultAction("buy_zone", true)).toBe("notify");
    expect(defaultAction("alert", true)).toBe("notify");
    expect(draftOf(null, true).action).toBe("sell");
    expect(draftOf(null, false).action).toBe("notify");
  });
  test("titles: a new rule; a rule's sheet names it as its row does, since its kind never changes there (DD 2135)", () => {
    expect(sheetTitle("SOXL", null)).toBe("SOXL 규칙 추가");
    expect(sheetTitle("SOXL", { kind: "stop", left: "손절 $25.80 이하" })).toBe("SOXL 손절");
    expect(sheetTitle("SOXL", { kind: "target", level: 1, left: "1차 익절 $36.50 이상" })).toBe("SOXL 1차 익절");
    expect(sheetTitle("SOXL", { kind: "resistance", left: "저항 $34.10" })).toBe("SOXL 저항");
    expect(sheetTitle("SOXL", { kind: "buy_zone", left: "매수 검토 $30.00–31.50" })).toBe("SOXL 매수 검토");
    expect(sheetTitle("005930", { kind: "alert", left: "가격 알림 189,400원 이상" })).toBe("005930 가격 알림");
    // the server's word wins; with no price in the text, the kind's own
    expect(ruleWord({ kind: "invalidate", left: "전략 무효화 $28.00 이하" })).toBe("전략 무효화");
    // …even where it is not the app's own word for the kind (a text unlike the fallback, so the order shows)
    expect(ruleWord({ kind: "invalidate", left: "무효화 기준 $28.00 이하" })).toBe("무효화 기준");
    expect(sheetTitle("SOXL", { kind: "target", level: 1, left: "1차 목표 $36.50 이상" })).toBe("SOXL 1차 목표");
    expect(ruleWord({ kind: "invalidate", left: "확인 불가" })).toBe("전략 무효화");
    expect(ruleWord({ kind: "target", level: 2, left: "확인 불가" })).toBe("2차 익절");
    expect(ruleWord({ kind: "stop", left: "" })).toBe("손절");
  });
});

describe("the draft the sheet sends", () => {
  test("a typed price: digits with an optional decimal, commas and $ or 원 allowed; zero and words refused", () => {
    expect(parsePrice("27")).toBe(27);
    expect(parsePrice(" 1,234.50 ")).toBe(1234.5);
    expect(parsePrice("$27.5")).toBe(27.5);
    expect(parsePrice("189,400원")).toBe(189400);
    for (const bad of ["", "0", "abc", "27..5", "-3", ".5"]) expect(parsePrice(bad)).toBeNull();
  });
  test("a rule's fields come from the server's number text", () => {
    expect(draftOf(rule({}), true)).toEqual({ kind: "stop", price: "25.80", lo: "", hi: "", direction: "below", action: "sell", until: null, once: false, bufferPct: "" });
    const kr = draftOf(rule({ symbol: "005930", price: { v: 189400, text: "189,400원", unit: "krw" }, action: "notify", until: "2026-12-01" }), false);
    expect(kr.price).toBe("189400");
    expect(kr.until).toBe("2026-12-01");
    expect(draftOf(rule({ price: usd(null, "확인 불가") }), true).price).toBe("");
  });
  test("a rule's 한 번 알리고 멈추기 and 장중 버퍼: a buffer the person set shows, the default leaves the field empty", () => {
    const pct = (v: number): InvestNum => ({ v, text: `${v}%`, unit: "pct" });
    expect(draftOf(rule({ once: true, action: "notify" }), true).once).toBe(true);
    expect(draftOf(rule({ bufferPct: pct(7), bufferDefault: false }), true).bufferPct).toBe("7");
    expect(draftOf(rule({ bufferPct: pct(7.5), bufferDefault: false }), true).bufferPct).toBe("7.5");
    expect(draftOf(rule({ bufferPct: pct(5), bufferDefault: true }), true).bufferPct).toBe("");
    expect(draftOf(rule({ kind: "alert", bufferPct: pct(7), bufferDefault: false }), true).bufferPct).toBe("");
  });
  test("only 가격 알림 sends a direction, the person's (the protocol's draft); every other kind's is the server's", () => {
    expect(toRuleDraft(draft({ direction: "above" }), "SOXL", true)).toEqual({ symbol: "SOXL", kind: "stop", action: "notify", until: null, once: false, bufferPct: null, price: 27 });
    expect(toRuleDraft(draft({ kind: "target", action: "call" }), "SOXL", true, 2)).toEqual({ symbol: "SOXL", kind: "target", action: "call", until: null, once: false, price: 27, level: 2 });
    expect(toRuleDraft(draft({ kind: "alert", direction: "above" }), "SOXL", true)?.direction).toBe("above");
    expect(toRuleDraft(draft({ kind: "alert", direction: "below" }), "SOXL", true)?.direction).toBe("below");
    // a rule row's "inside" never reaches an alert's draft as such
    expect(toRuleDraft(draft({ kind: "alert", direction: "inside" }), "SOXL", true)?.direction).toBe("below");
    expect(toRuleDraft(draft({ kind: "resistance", direction: "above", price: "34.10" }), "SOXL", true)).not.toHaveProperty("direction");
  });
  test("a range for 매수 검토: both ends, the upper above the lower", () => {
    expect(toRuleDraft(draft({ kind: "buy_zone", lo: "30", hi: "31.50" }), "SOXL", false)).toEqual({ symbol: "SOXL", kind: "buy_zone", action: "notify", until: null, once: false, lo: 30, hi: 31.5 });
    expect(toRuleDraft(draft({ kind: "buy_zone", lo: "31.5", hi: "30" }), "SOXL", false)).toBeNull();
    expect(toRuleDraft(draft({ kind: "buy_zone", lo: "30", hi: "" }), "SOXL", false)).toBeNull();
  });
  test("nothing sendable without a price; a sale the symbol cannot make is never sent", () => {
    expect(toRuleDraft(draft({ price: "" }), "SOXL", true)).toBeNull();
    expect(toRuleDraft(draft({ action: "sell" }), "SOXL", false)?.action).toBe("notify");
    expect(toRuleDraft(draft({ action: "sell" }), "SOXL", true)?.action).toBe("sell");
    expect(toRuleDraft(draft({ kind: "target", action: "sell" }), "SOXL", true)?.action).toBe("call");
  });
});

describe("한 번 알리고 멈추기, 장중 버퍼 and what a change sends (DD 2042-b §1–§2, agent-runtime 2052 D3)", () => {
  test("once is offered on every rule but a stop that sells, and sent only where offered", () => {
    expect(canOnce("stop", "sell")).toBe(false);
    for (const a of ["notify", "call"] as const) expect(canOnce("stop", a)).toBe(true);
    for (const k of ["target", "buy_zone", "alert", "resistance", "invalidate"] as const) expect(canOnce(k, "call")).toBe(true);
    expect(toRuleDraft(draft({ once: true }), "SOXL", true)?.once).toBe(true);
    expect(toRuleDraft(draft({ once: true, action: "sell" }), "SOXL", true)?.once).toBe(false);
    // a sale the symbol cannot make becomes 알림, and then once may go
    expect(toRuleDraft(draft({ once: true, action: "sell" }), "SOXL", false)?.once).toBe(true);
    expect(toRuleDraft(draft({ kind: "resistance", price: "34.10", direction: "above", once: true }), "SOXL", true)?.once).toBe(true);
  });
  test("장중 버퍼: empty is the default (null), 1 to 20 with decimals, anything else holds the draft back", () => {
    expect(parseBufferPct("")).toBeNull();
    expect(parseBufferPct(" ")).toBeNull();
    expect(parseBufferPct("7")).toBe(7);
    expect(parseBufferPct("7.5")).toBe(7.5);
    expect(parseBufferPct("7%")).toBe(7);
    expect(parseBufferPct("1")).toBe(1);
    expect(parseBufferPct("20")).toBe(20);
    for (const bad of ["0", "0.5", "20.5", "21", "abc", "-3", "7..5", ".5"]) expect(parseBufferPct(bad)).toBeUndefined();
    expect(toRuleDraft(draft({ bufferPct: "7" }), "SOXL", true)?.bufferPct).toBe(7);
    expect(toRuleDraft(draft({ bufferPct: "" }), "SOXL", true)?.bufferPct).toBeNull();
    expect(toRuleDraft(draft({ bufferPct: "25" }), "SOXL", true)).toBeNull();
    // only a stop has one: a leftover field on another kind is neither sent nor checked
    expect(toRuleDraft(draft({ kind: "target", action: "call", bufferPct: "25" }), "SOXL", true)).not.toHaveProperty("bufferPct");
    expect(BUFFER_RANGE).toBe("장중 버퍼는 1–20% 사이로 정해 주세요.");
  });
  test("a change sends what a rule can change: never its kind, direction or symbol", () => {
    const stop = toRuleDraft(draft({ bufferPct: "7", until: "2026-12-01" }), "SOXL", true)!;
    expect(ruleChanges(stop)).toEqual({ price: 27, action: "notify", until: "2026-12-01", once: false, bufferPct: 7 });
    const zone = toRuleDraft(draft({ kind: "buy_zone", lo: "30", hi: "31.50", once: true }), "SOXL", false)!;
    expect(ruleChanges(zone)).toEqual({ lo: 30, hi: 31.5, action: "notify", until: null, once: true });
    const res = toRuleDraft(draft({ kind: "resistance", price: "34.10", direction: "above", action: "call" }), "SOXL", true)!;
    expect(ruleChanges(res)).toEqual({ price: 34.1, action: "call", until: null, once: false });
  });
});

describe("기한 in KST (DD 2008 §5)", () => {
  test("a week from today by default, nothing before tomorrow, across the KST midnight", () => {
    const late = kst(2026, 11, 26, 23, 30);
    expect(kstDay(late)).toBe("2026-11-26");
    expect(untilDefault(late)).toBe("2026-12-03");
    expect(untilMin(late)).toBe("2026-11-27");
    const early = kst(2026, 11, 27, 0, 10); // still the 26th in UTC
    expect(untilDefault(early)).toBe("2026-12-04");
    expect(untilMin(early)).toBe("2026-11-28");
  });
});

describe("sentences DD wrote for the screen", () => {
  test("the once switch says what will happen (DD 2042-b §1; a hit or paused rule's note is the server's stateFoot)", () => {
    expect(ONCE_NOTE).toBe("닿으면 한 번 알리고 이 규칙을 멈춰요.");
  });
  test("deleting a live stop sale says what stops; nothing else adds the line", () => {
    expect(deleteNote({ symbol: "SOXL", kind: "stop", action: "sell" }, "real")).toBe("지우면 SOXL이 손절선에 닿아도 팔지 않아요.");
    expect(deleteNote({ symbol: "SOXL", kind: "stop", action: "sell" }, "mock")).toBeNull();
    expect(deleteNote({ symbol: "SOXL", kind: "stop", action: "notify" }, "real")).toBeNull();
    expect(subjectOf("KORU")).toBe("KORU가");
    expect(subjectOf("005930")).toBe("005930이");
    expect(subjectOf("TQQQ")).toBe("TQQQ가");
    expect(subjectOf("000665")).toBe("000665가");
    expect(subjectOf("하늘")).toBe("하늘이");
  });
  test("calls that cannot be placed: said once, and only an unverified number leads to verifying (DD 2010 §4)", () => {
    expect(phoneNotice({ callBlock: "not_verified" })).toEqual({ text: "번호를 인증하지 않아 전화를 걸 수 없어요", verify: true });
    expect(phoneNotice({ callBlock: "not_configured" })).toEqual({ text: "지금은 전화를 걸 수 없어요", verify: false });
    expect(phoneNotice({ callBlock: null })).toBeNull();
    expect(CALL_NOTE).toBe("앱에서 인증한 번호로 걸어요. 하루 10통까지예요.");
  });
  test("the rules footer: the paper mode's meaning before who changes alert prices (DD 2008 §1)", () => {
    expect(rulesFoot("mock", "모시")).toEqual(["모의 주문이라 손절선에 닿아도 주문을 내지 않고, 팔았을 시점과 가격만 기록해요.", "알림 가격은 모시가 혼자 바꾸지 않아요. 바꾸자는 제안은 채팅에서 확인을 받아요."]);
    expect(rulesFoot("real", "하늘")).toEqual(["알림 가격은 하늘이 혼자 바꾸지 않아요. 바꾸자는 제안은 채팅에서 확인을 받아요."]);
  });
  test("a rule row's price phrase stays whole: price, range or 원, with its direction", () => {
    expect(pricePhrase("1차 익절 $36.50 이상")).toEqual(["1차 익절 ", "$36.50 이상", ""]);
    expect(pricePhrase("매수 검토 $30.00–31.50")).toEqual(["매수 검토 ", "$30.00–31.50", ""]);
    expect(pricePhrase("손절 $1,234.50 이하")).toEqual(["손절 ", "$1,234.50 이하", ""]);
    expect(pricePhrase("손절 189,400원 이하")).toEqual(["손절 ", "189,400원 이하", ""]);
    expect(pricePhrase("매수 검토 30,000–31,500원")).toEqual(["매수 검토 ", "30,000–31,500원", ""]);
    expect(pricePhrase("저항 $34.10")).toEqual(["저항 ", "$34.10", ""]);
    expect(pricePhrase("확인 불가")).toBeNull();
  });
});

describe("the screen's tones and groups", () => {
  test("a sale is red only in the live mode", () => {
    expect(isLiveSale({ action: "sell" }, "real")).toBe(true);
    expect(isLiveSale({ action: "sell" }, "mock")).toBe(false);
    expect(isLiveSale({ action: "call" }, "real")).toBe(false);
  });
  test("rule groups follow the watch list, a rule on a symbol no longer watched comes last; no symbol, no group", () => {
    const groups = ruleGroups({ watchlist: [sym("TQQQ", "US"), sym("SOXL", "US", true)], rules: [rule({ id: "a", symbol: "SOXL" }), rule({ id: "b", symbol: "KORU" })] });
    expect(groups.map((g) => [g.symbol, g.rules.map((r) => r.id)])).toEqual([
      ["TQQQ", []],
      ["SOXL", ["a"]],
      ["KORU", ["b"]],
    ]);
    expect(ruleGroups({ watchlist: [], rules: [] })).toEqual([]);
  });
  test("a symbol's market: the watch list's, else six digits are KR", () => {
    expect(marketOf({ watchlist: [] }, "SOXL")).toBe("US");
    expect(marketOf({ watchlist: [] }, "005930")).toBe("KR");
    expect(marketOf({ watchlist: [sym("X1", "KR")] }, "X1")).toBe("KR");
  });
  test("② no quote source: the server's sentence on top (caution) and its foot under the group (DD 0225)", () => {
    const foot = "그래서 규칙을 확인하지 않아요. 토스증권을 연결하면 확인해요.";
    expect(watchNotice({ state: "off", text: "지금은 시세를 받지 않아요", foot }, "5분마다 확인해요")).toEqual({ notice: { tone: "caution", text: "지금은 시세를 받지 않아요" }, foot });
  });
  test("② no quote source and no rule (no foot): the row, and the quotes line as the foot", () => {
    expect(watchNotice({ state: "off", text: "지금은 시세를 받지 않아요" }, "5분마다 확인해요")).toEqual({ notice: { tone: "caution", text: "지금은 시세를 받지 않아요" }, foot: "5분마다 확인해요" });
    expect(watchNotice({ state: "off", text: "지금은 시세를 받지 않아요" }, null).foot).toBeUndefined();
  });
  test("② quotes lost: the server's tone and foot", () => {
    expect(watchNotice({ state: "blind", since: 1, tone: "danger", text: "시세를 받지 못하고 있어요 · 00:40부터", foot: "시세 00:40 기준" }, "5분마다 확인해요")).toEqual({
      notice: { tone: "danger", text: "시세를 받지 못하고 있어요 · 00:40부터" },
      foot: "시세 00:40 기준",
    });
  });
  test("② ok and closed: no row, the quotes line (a stray foot is not shown)", () => {
    for (const state of ["ok", "closed"] as const) expect(watchNotice({ state, text: "", foot: "x" }, "5분마다 확인해요")).toEqual({ notice: null, foot: "5분마다 확인해요" });
  });
  test("gauges: severe in red, worse in caution; the read sentence counts met and not known apart", () => {
    expect([gaugeTone("worse"), gaugeTone("severe"), gaugeTone("recovery")]).toEqual(["caution", "danger", "label"]);
    expect(gaugeSaid({ id: "worse", label: "악화 신호", cells: ["met", "met", "met", "unmet", "unknown", "unmet", "unmet", "unmet"], text: "3/8" })).toBe("악화 신호 8개 중 3개 충족, 확인 불가 1개");
    expect(gaugeSaid({ id: "recovery", label: "회복 신호", cells: ["unmet", "met"], text: "1/2" })).toBe("회복 신호 2개 중 1개 충족");
  });
  test("B2b-2 stages (team-lead 0554 guard): only a judged board is drawn, in today's shape; off, none, an unknown kind and null draw none", () => {
    const judged: InvestStages = {
      kind: "judged",
      escape: { stage: 2, name: "경계", text: "탈출 2단계" },
      recovery: { stage: null, text: "회복 판정 보류" },
      gauges: [
        { key: "worse", label: "악화 신호", met: 3, of: 8, unknown: 1, cells: [{ id: "A1", state: "met" }, { id: "A2", state: "unknown" }, { id: "A3", state: "unmet" }], aria: "" },
        { key: "recover", label: "회복 신호", met: 1, of: 6, unknown: 0, cells: [{ id: "R1", state: "met" }], aria: "" },
      ],
      next: ["탈출 3단계까지: 악화 신호 2개 더", "회복 1단계까지: 회복 신호 2개 더"],
      judgedAt: 0,
      judgedText: "11월 27일 08:00 판정 · 어제와 같아요",
    };
    expect(boardOf(judged)).toEqual({
      line: "탈출 2단계 · 회복 판정 보류",
      sub: "11월 27일 08:00 판정 · 어제와 같아요",
      gauges: [
        { id: "worse", label: "악화 신호", cells: ["met", "unknown", "unmet"], text: "3/8" },
        { id: "recovery", label: "회복 신호", cells: ["met"], text: "1/6" },
      ],
      next: "탈출 3단계까지: 악화 신호 2개 더",
    });
    expect(boardOf({ ...judged, next: [] })?.next).toBeNull();
    const none = [{ kind: "off", off: "지금은 지표를 받지 않아서 단계를 판정하지 않아요." }, { kind: "none", none: "첫 판정은 오늘 08:00에 나와요." }, { kind: "later" }, null, undefined];
    expect(none.map((s) => boardOf(s as InvestStages | null))).toEqual([null, null, null, null, null]);
    // the empty line (DD 0600): off and none in the server's words; an unknown kind or nothing keeps today's line
    expect(none.map((s) => stageEmptyLine(s as InvestStages | null))).toEqual(["지금은 지표를 받지 않아서 단계를 판정하지 않아요.", "첫 판정은 오늘 08:00에 나와요.", STAGE_EMPTY, STAGE_EMPTY, STAGE_EMPTY]);
    expect(STAGE_EMPTY).toBe("아직 판정이 없어요. 매일 오전 8시에 판정해요.");
  });
});
