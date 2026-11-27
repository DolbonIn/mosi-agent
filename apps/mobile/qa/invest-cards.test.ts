/**
 * The chat's 투자 cards (DD 1935 §2-1·2-2, 2010 §2·3·5): cards the server's own builders make (apps/server
 * invest/cards.ts), drawn by CardView. The card draws the server's words and figures as they come.
 */
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createElement, type ComponentType, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Card, InvestCall } from "@pickle/protocol";
import { DISCLAIMER } from "@pickle/quant";
import { alertCard, callText, expiredCard, mockStopCard, realStopCard, type AlertInput } from "../../server/src/invest/cards.ts";
import type { RealOrderRow } from "../../server/src/invest/db.ts";
import type { RuleSpec } from "../../server/src/invest/rules.ts";
import { getScreen, getTabRoot, nav, navStore, registerScreen, registerTabRoot, unregisterScreen, type ScreenProps } from "../src/app/nav";
import { CardView } from "../src/screens/chat/cards/CardView";
import { openRules } from "../src/screens/chat/cards/InvestCards";
import { STOP_STATES } from "../src/screens/chat/cards/stopStates";

const html = (el: ReactElement) => renderToStaticMarkup(el);
const view = (card: Card, interactive = true) =>
  html(createElement(CardView, { card, messageId: "m1", threadId: "t1", tools: [], onSend: () => {}, interactive }));
const text = (s: string) => s.replace(/<[^>]+>/g, "").replace(/ /g, " ");
const count = (s: string, part: string) => s.split(part).length - 1;

/**
 * 규칙 보기 with the profile tab's root already in, the nav state put back after. setTab waits for a tab root's chunk,
 * and qa/lazy-screen.test.ts leaves a profile root that never loads: after that file the tab would never change (seen
 * in the reversed list). A press before the chunk is in (a cold start) is nav.ts's case, DD 2131 §2: not tested here.
 */
function pressing(fn: () => void) {
  const root = getTabRoot("profile");
  const was = navStore.get();
  registerTabRoot("profile", () => null);
  withInvest(() => null, () => {
    try {
      fn();
    } finally {
      navStore.set(was);
      if (root) registerTabRoot("profile", root);
    }
  });
}

/**
 * The "invest" registration set for `fn` (undefined: none, the app without 투자), then put back as it was found, so
 * this file depends on no other file's order and leaves none behind (DD 2359: a file that left it registered made the
 * reversed list fail)
 */
function withInvest(screen: ComponentType<ScreenProps> | undefined, fn: () => void) {
  const set = (c: ComponentType<ScreenProps> | undefined) => (c ? registerScreen("invest", c) : unregisterScreen("invest"));
  const was = getScreen("invest");
  set(screen);
  try {
    fn();
  } finally {
    set(was);
  }
}

/** the registration as this file found it, read right before its first test: every test leaves it so (DD 0116 K1) */
let found: ComponentType<ScreenProps> | undefined;
beforeAll(() => {
  found = getScreen("invest");
});
afterEach(() => {
  expect(getScreen("invest")).toBe(found);
});

const NOW = Date.UTC(2026, 10, 26, 15, 46); // 11-27 00:46 KST
const rule = (over: Partial<RuleSpec> = {}): RuleSpec => ({
  symbol: "SOXL",
  kind: "stop",
  level: null,
  price: 25.8,
  lo: null,
  hi: null,
  direction: "below",
  action: "notify",
  once: 0,
  buffer_pct: null,
  until_day: null,
  ...over,
});
const input = (over: Partial<AlertInput> = {}): AlertInput => ({
  alertId: "a1",
  ruleId: "r1",
  rule: rule(),
  market: "US",
  mode: "mock",
  obs: { price: 25.62, prevClose: 27.97, at: NOW - 60_000, source: "toss" },
  now: NOW,
  holding: null,
  noPrior: null,
  paused: false,
  nextTarget: null,
  stopPrice: 25.8,
  ...over,
});

/** an order row as B3a's executor keeps it (apps/server invest/db.ts RealOrderRow): SOXL, stop $25.80, 47 confirmed */
const T = (d: number, h: number, mi: number, s = 0) => Date.UTC(2026, 10, d, h, mi, s);
const ORDER_ROW: RealOrderRow = {
  id: "ro1", user_id: "u1", rule_id: "r1", rule_rev: 2, symbol: "SOXL", client_order_id: "c1", toss_order_id: null,
  state: "waiting", reason: null, reason_text: null, basis: "intraday", intraday_only: 0,
  observed_price: 25.42, observed_at: T(24, 18, 2), source: "toss", stop_price: 25.8, avg_cost: 30.49,
  confirmed_qty: 47, sellable: 47, qty: 47, fraction_left: null, filled_qty: null, avg_price: null,
  market_day: "2026-11-24", due_at: null, sent_at: null, sends: 0, check_at: null, check_until: null,
  filled_at: null, stopped_at: null, message_id: "m1", created_at: T(24, 18, 2), updated_at: T(24, 18, 2),
};
const SENT = { sent_at: T(24, 18, 2, 4), sends: 1 };
const TOSS_ID = { toss_order_id: "2611240004821" };
const NEXT_OPEN = { due_at: T(25, 14, 45), market_day: "2026-11-25" };
/** every row state the card draws (the gallery's names), with the server's x (allowed IP, the call line) */
const STOP_ROWS: Record<string, { row: Partial<RealOrderRow>; ip?: string; call?: InvestCall }> = {
  waiting: { row: { state: "waiting" } },
  "scheduled · 종가": { row: { state: "scheduled", basis: "close", observed_price: 25.4, observed_at: T(24, 21, 0), ...NEXT_OPEN } },
  "scheduled · 마감 직전": { row: { state: "scheduled", basis: "late", observed_price: 24.4, observed_at: T(24, 20, 58, 30), intraday_only: 1, ...NEXT_OPEN } },
  sending: { row: { state: "sending", ...SENT } },
  submitted: { row: { state: "submitted", ...SENT, ...TOSS_ID } },
  "submitted · 확인 멈춤": { row: { state: "submitted", ...SENT, ...TOSS_ID, stopped_at: T(24, 18, 30) } },
  partial: { row: { state: "partial", ...SENT, ...TOSS_ID, filled_qty: 30, avg_price: 25.38 } },
  partial_closed: { row: { state: "partial_closed", ...SENT, ...TOSS_ID, filled_qty: 30, avg_price: 25.38 } },
  filled: { row: { state: "filled", ...SENT, ...TOSS_ID, sellable: 50, filled_qty: 47, avg_price: 25.37, filled_at: T(24, 18, 2, 9) }, call: callText({ ok: true, at: T(24, 18, 2, 40) }) },
  "failed · 허용 IP": { row: { state: "failed", reason: "ip_not_allowed", ...SENT }, ip: "203.0.113.24" },
  "failed · 거절": { row: { state: "failed", reason: "rejected", reason_text: "매도 가능 수량이 부족해요", ...SENT } },
  searching: { row: { state: "searching", ...SENT } },
  unknown: { row: { state: "unknown", reason: "no_answer", ...SENT, sends: 2 } },
  "skipped · 확인 전": { row: { state: "skipped", reason: "not_confirmed" } },
  "skipped · 허용 IP": { row: { state: "skipped", reason: "ip_paused" }, ip: "203.0.113.24" },
  "canceled · 예정": { row: { state: "canceled", reason: "disabled", observed_at: T(24, 21, 0), basis: "close", ...NEXT_OPEN } },
};
const stopRowCard = (name: string) => {
  const s = STOP_ROWS[name]!;
  return realStopCard({ ...ORDER_ROW, ...s.row }, { ip: s.ip ?? null, ...(s.call ? { call: s.call } : {}) });
};
/** the mock records (mockStopCard): with a quantity, without one, at zero sellable */
const MOCK_QTY: Record<string, number | null> = { "모의 · 기록": 47, "모의 · 수량 모름": null, "모의 · 0주": 0 };
const mockRowCard = (name: string) =>
  mockStopCard({ orderId: "o1", ruleId: "r1", rule: { symbol: "SOXL", kind: "stop", level: null, price: 25.8, lo: null, hi: null, direction: "below", action: "sell", once: 0, buffer_pct: null, until_day: null }, market: "US", obs: { price: 25.42, prevClose: 27.97, at: T(24, 18, 2), source: "toss" }, now: T(24, 18, 2), qty: MOCK_QTY[name]!, avgPrice: 30.49 });

describe("invest_alert (DD 1935 §2-1)", () => {
  test("a stop alert: the danger mark before the title, the KST time, the price and its line, rows, the two condition sentences, the foot and the closing sentence once", () => {
    const card = alertCard(input());
    const out = view(card);
    expect(out).toContain('data-card="invest_alert"');
    expect(out).toMatch(/<h3 class="ccard-title ivcard-title"><svg class="sigmark ivcard-glyph"[^>]*data-signal="risk"/);
    expect(text(out)).toContain("SOXL이 손절 관찰가에 닿았어요");
    expect(out).toContain(`<span class="ccard-source tnum">${card.atText}</span>`);
    expect(out).toContain('class="ivhero"');
    expect(text(out)).toContain(card.price!.text);
    expect(text(out)).toContain(card.sub!);
    expect(text(out)).toContain("보유 중일 때 해당하는 알림이에요.");
    expect(text(out)).toContain("주문은 내지 않았어요.");
    expect(text(out)).toContain(card.foot);
    expect(count(out, DISCLAIMER)).toBe(1);
  });

  test('"확인 불가" from the server is the dotted mark and its words in the value\'s place, never plain text alone', () => {
    const out = view(alertCard(input()));
    const market = out.slice(out.indexOf(">시장<"));
    expect(market.slice(0, 400)).toMatch(/class="ivsig ivunknown[^"]*" data-signal="unknown"><svg class="sigmark/);
  });

  test("no closing sentence without the server's flag (it marks the message's last 투자 card only)", () => {
    const { disclaimer: _d, ...rest } = alertCard(input());
    expect(view(rest as Card)).not.toContain(DISCLAIMER);
  });

  test("a buy-zone alert (caution tone): the half mark before the title", () => {
    const card = alertCard(input({ rule: rule({ kind: "buy_zone", direction: "inside", price: null, lo: 24, hi: 26 }), obs: { price: 25.1, prevClose: 25.9, at: NOW - 60_000, source: "toss" } }));
    expect(card.tone).toBe("caution");
    const out = view(card);
    expect(out).toMatch(/<h3 class="ccard-title ivcard-title"><svg class="sigmark ivcard-glyph"[^>]*data-signal="caution"/);
    expect(count(out, "ivcard-glyph")).toBe(1);
  });

  test("a target alert: no glyph; the next level row comes as the server wrote it", () => {
    const card = alertCard(input({ rule: rule({ kind: "target", level: 1, price: 24, direction: "above" }), nextTarget: { level: 2, price: 30 } }));
    const out = view(card);
    expect(out).not.toContain("ivcard-glyph");
    expect(text(out)).toContain(card.rows.find((r) => r.label === "다음")!.value);
  });

  test("expired (DD 2010 §2): no glyph, no big number and no line under it; the line under the title says what stopped", () => {
    const card = expiredCard({ alertId: "a2", ruleId: "r2", rule: rule({ kind: "buy_zone", price: null, lo: 30, hi: 31.5, direction: "inside", until_day: "2026-12-01" }), market: "US", mode: "mock", createdAt: NOW - 7 * 86_400_000, at: NOW, now: NOW });
    const out = view(card);
    expect(out).not.toContain("ivhero");
    expect(out).not.toContain("ivcard-sub");
    expect(out).not.toContain("ivcard-glyph");
    expect(text(out)).toContain(card.titleLines![0]);
    // a price that came with it anyway (an older server, a hand-made card) is still not drawn: the rule stopped watching
    const priced = view({ ...card, price: alertCard(input()).price, sub: "전일 대비 –8.40%" } as Card);
    expect(priced).not.toContain("ivhero");
    expect(priced).not.toContain("ivcard-sub");
  });

  test("the call line (DD 2010 §5): 전화로 알렸어요 plain; a call that did not go has the half mark", () => {
    const ok = view(alertCard(input({ call: callText({ ok: true, at: NOW }) })));
    const okLine = ok.slice(ok.indexOf('<p class="ivcall" data-ok="true">'), ok.indexOf("</p>", ok.indexOf('class="ivcall"')));
    expect(okLine).not.toContain("sigmark");
    expect(text(okLine)).toBe("전화로 알렸어요 · 00:46");
    const no = view(alertCard(input({ call: callText({ ok: false, at: NOW, reason: "not_verified" }) })));
    expect(no).toMatch(/<p class="ivcall" data-ok="false"><svg class="sigmark[^"]*"[^>]*data-signal="caution"/);
    expect(text(no)).toContain("전화를 걸지 못했어요 · 번호를 인증하지 않았어요");
  });

  test("규칙 보기 only where 투자 is in the app and the card can be pressed", () => {
    const card = alertCard(input());
    withInvest(undefined, () => {
      expect(getScreen("invest")).toBeUndefined();
      expect(view(card)).not.toContain("규칙 보기");
    });
    withInvest(() => null, () => {
      expect(view(card)).toContain(">규칙 보기</button>");
      expect(view(card, false)).not.toContain("규칙 보기");
    });
  });

  test("a symbol's own alert (a gap, a split pause: no ruleId) has 규칙 보기 too; it opens 투자 at the symbol", () => {
    pressing(() => {
      const { ruleId: _rule, ...own } = alertCard(input());
      expect(view(own as Card)).toContain(">규칙 보기</button>");
      openRules("SOXL");
      expect(nav.current()).toMatchObject({ screen: "invest", params: { symbol: "SOXL" } });
      expect(nav.current()?.params).not.toHaveProperty("ruleId");
      nav.popToRoot();
      openRules("SOXL", "r1");
      expect(nav.current()?.params).toEqual({ symbol: "SOXL", ruleId: "r1" });
    });
  });

  test("규칙 보기 from the chat tab goes to the profile tab and opens the symbol there (lead 2122)", () => {
    pressing(() => {
      const s = navStore.get();
      navStore.set({ ...s, tab: "chat", stacks: { ...s.stacks, chat: [], profile: [] } });
      openRules("SOXL", "r1");
      expect(navStore.get().tab).toBe("profile");
      expect(navStore.get().stacks.profile.map((r) => [r.screen, r.params])).toEqual([["invest", { symbol: "SOXL", ruleId: "r1" }]]);
      expect(navStore.get().stacks.chat).toEqual([]);
    });
  });

  test("a 투자 screen left on top of the profile tab: the list or another symbol gets the symbol pushed over it; the same symbol and rule is not stacked twice (lead 2122)", () => {
    let k = 0;
    const route = (params: Record<string, unknown>) => ({ key: `invest#qa${++k}`, screen: "invest", params, title: "투자" });
    // the card is in a chat thread: the chat tab is on screen, the profile tab keeps what was left on it
    const fromChat = (profile?: ReturnType<typeof route>[]) => {
      const s = navStore.get();
      navStore.set({ ...s, tab: "chat", stacks: { ...s.stacks, chat: [], profile: profile ?? s.stacks.profile } });
    };
    const profile = () => navStore.get().stacks.profile.map((r) => r.params);
    pressing(() => {
      fromChat([route({})]); // the list
      openRules("SOXL", "r1");
      expect(navStore.get().tab).toBe("profile");
      expect(profile()).toEqual([{}, { symbol: "SOXL", ruleId: "r1" }]);

      fromChat([route({ symbol: "TQQQ" })]); // another symbol
      openRules("SOXL", "r1");
      expect(profile()).toEqual([{ symbol: "TQQQ" }, { symbol: "SOXL", ruleId: "r1" }]);

      fromChat(); // the very same screen on top
      openRules("SOXL", "r1");
      expect(profile()).toEqual([{ symbol: "TQQQ" }, { symbol: "SOXL", ruleId: "r1" }]);

      fromChat(); // the symbol with no rule is another screen
      openRules("SOXL");
      expect(profile()).toEqual([{ symbol: "TQQQ" }, { symbol: "SOXL", ruleId: "r1" }, { symbol: "SOXL" }]);
      fromChat();
      openRules("SOXL");
      expect(profile()).toHaveLength(3);
    });
  });

  test("a symbol's own alert (no ruleId) over a 투자 screen with no rule either: the list or another symbol still gets the symbol (lead 2229, L13)", () => {
    let k = 0;
    const route = (params: Record<string, unknown>) => ({ key: `invest#qa13-${++k}`, screen: "invest", params, title: "투자" });
    const fromChat = (profile: ReturnType<typeof route>[]) => {
      const s = navStore.get();
      navStore.set({ ...s, tab: "chat", stacks: { ...s.stacks, chat: [], profile } });
    };
    const profile = () => navStore.get().stacks.profile.map((r) => r.params);
    pressing(() => {
      // (a) the list on top: its params carry no ruleId, and neither does the gap alert
      fromChat([route({})]);
      openRules("SOXL");
      expect(navStore.get().tab).toBe("profile");
      expect(profile()).toEqual([{}, { symbol: "SOXL" }]);
      // (b) another symbol's screen with no rule on top
      fromChat([route({ symbol: "005930" })]);
      openRules("SOXL");
      expect(profile()).toEqual([{ symbol: "005930" }, { symbol: "SOXL" }]);
    });
  });
});

describe("invest_stop (DD 1935 §2-2)", () => {
  const stop = (qty: number | null, avg: number | null = 30.49) =>
    mockStopCard({ orderId: "o1", ruleId: "r1", rule: rule({ action: "sell" }), market: "US", obs: { price: 25.62, prevClose: 27.97, at: NOW, source: "toss" }, now: NOW, qty, avgPrice: avg });

  test("a mock record: 모의 first, the symbol, the title, the observed price, rows, 주문은 내지 않았어요; no button", () => {
    const card = stop(47);
    const out = view(card);
    expect(out).toMatch(/<div class="ivcard-mode"><span class="ivmode" data-mode="mock">모의<\/span><span> · SOXL 손절<\/span><\/div>/);
    expect(text(out)).toContain("실제 주문이었다면 47주를 팔았을 거예요");
    expect(text(out)).toContain(card.hero.text);
    for (const r of card.rows) expect(text(out)).toContain(r.value);
    expect(text(out)).toContain("주문은 내지 않았어요.");
    expect(out).not.toContain("<button");
    expect(count(out, DISCLAIMER)).toBe(1);
  });

  test("skipped at zero sellable: the half mark; the reason is the title, said once", () => {
    const card = stop(0);
    const out = view(card);
    expect(out).toMatch(/ivcard-title"><svg class="sigmark ivcard-glyph"[^>]*data-signal="caution"/);
    expect(count(text(out), "팔 수 있는 수량이 0주라서 주문을 내지 않았어요")).toBe(1);
  });

  test("real: 실제 in danger; submitted: the loader before 체결 확인 중, nothing before the title; the check only once filled", () => {
    const sub = view(stopRowCard("submitted"));
    expect(sub).toContain('<span class="ivmode" data-mode="real">실제</span>');
    expect(sub).toMatch(/<p class="ivstatus" data-state="submitted" role="status"><span class="ivspin" aria-hidden="true"><\/span><span class="ivstatus-text">체결 확인 중<\/span><\/p>/);
    expect(sub).toContain('<h3 class="ccard-title ivcard-title">손절 주문을 냈어요</h3>');
    expect(sub).not.toContain("ivcheck");
    // filled has no status line: the check goes before the title (DD 2314 §5)
    const filled = view(stopRowCard("filled"));
    expect(filled).toMatch(/<h3 class="ccard-title ivcard-title"><svg class="ivcheck ivcard-glyph"/);
    expect(filled).not.toContain("ivspin");
  });

  test("partial: still the loader, never the check (G8-7: done only once the server saw FILLED); closed, the half circle", () => {
    const part = view(stopRowCard("partial"));
    expect(part).toMatch(/<p class="ivstatus" data-state="partial" role="status"><span class="ivspin" aria-hidden="true"><\/span><span class="ivstatus-text">남은 17주는 /);
    expect(part).not.toContain("ivcheck");
    const closed = view(stopRowCard("partial_closed"));
    expect(closed).toMatch(/<p class="ivstatus" data-state="partial" role="status"><svg class="sigmark "[^>]*data-signal="caution"/);
    expect(closed).not.toContain("ivspin");
    expect(closed).not.toContain("ivcheck");
  });

  test("a 403 failure: the danger mark, the reason line, the allowed IP row with 복사 (plain when it cannot be pressed)", () => {
    const card = stopRowCard("failed · 허용 IP");
    const out = view(card);
    expect(out).toMatch(/<h3 class="ccard-title ivcard-title"><svg class="sigmark ivcard-glyph"[^>]*data-signal="risk"/);
    expect(text(out)).toContain("토스증권이 이 서버의 접속을 막았어요(허용 IP).");
    expect(out).toContain('aria-label="허용 IP 203.0.113.24 복사"');
    const still = view(card, false);
    expect(still).not.toContain("<button");
    expect(text(still)).toContain("203.0.113.24");
  });
});

describe("invest_stop in every state the server sends (DD 2314 §5)", () => {
  const card = (name: string) => (name in STOP_ROWS ? stopRowCard(name) : mockRowCard(name));
  const title = (out: string) => out.match(/<h3 class="ccard-title ivcard-title">([\s\S]*?)<\/h3>/)![1]!;
  const status = (out: string) => out.match(/<p class="ivstatus"[^>]*>([\s\S]*?)<\/p>/)?.[1];
  const MARKS = /class="(ivspin|ivcheck|sigmark)[ "]/g;
  const MARK: Record<string, RegExp> = {
    loader: /^<span class="ivspin[ "][^>]*><\/span>/,
    check: /^<svg class="ivcheck[ "]/,
    fail: /^<svg class="sigmark[ "][^>]*data-signal="risk"/,
    caution: /^<svg class="sigmark[ "][^>]*data-signal="caution"/,
  };

  test("the gallery's states are the server's own cards: realStopCard over every row state, then mockStopCard's three records", () => {
    expect(STOP_STATES.map((s) => s.name)).toEqual([...Object.keys(STOP_ROWS), ...Object.keys(MOCK_QTY)]);
    for (const s of STOP_STATES) expect(s.card).toStrictEqual(card(s.name));
    // every state an order row can be in has a card here (the record is checked by tsc: a new row state fails it)
    const ROW_STATES: Record<RealOrderRow["state"], true> = { waiting: true, scheduled: true, sending: true, submitted: true, partial: true, searching: true, filled: true, partial_closed: true, unknown: true, failed: true, skipped: true, canceled: true };
    expect(new Set(Object.values(STOP_ROWS).map((s) => s.row.state))).toEqual(new Set(Object.keys(ROW_STATES)));
    // and every mark the server gives, and a real card with none (a planned order)
    expect(new Set(STOP_STATES.filter((s) => s.card.mode === "real").map((s) => s.card.glyph ?? "none"))).toEqual(new Set(["loader", "check", "fail", "caution", "none"]));
  });

  test("one mark a card: the server's glyph (a mock record: skipped the half circle), before the status line when there is one, else before the title", () => {
    for (const s of STOP_STATES) {
      const out = view(s.card);
      const g = s.card.glyph ?? (s.card.state === "skipped" ? "caution" : null);
      const where = s.card.status ? status(out)! : title(out);
      if (g) expect(where, s.name).toMatch(MARK[g]!);
      if (s.card.status) expect(title(out), s.name).not.toMatch(MARKS);
      expect(out.match(MARKS)?.length ?? 0, s.name).toBe(g ? 1 : 0);
    }
  });

  test("every word the server sent is drawn, the title once; sub right under the big number, why after it, then the status line", () => {
    for (const s of STOP_STATES) {
      const c = s.card;
      const out = view(c);
      const words = text(out);
      expect(count(words, c.title), s.name).toBe(1);
      const parts = [c.hero.text, c.sub, c.why, c.status, c.reason?.text, c.reason?.ip, c.call?.text, ...c.rows.flatMap((r) => [r.label, r.value]), ...c.notes, c.foot];
      for (const p of parts) if (p) expect(words, `${s.name}: ${p}`).toContain(p);
      if (c.sub) expect(out, s.name).toMatch(/<div class="ivcard-price"><div class="ivhero">[\s\S]*?<\/div><p class="ivcard-sub">/);
      else expect(out, s.name).not.toContain("ivcard-sub");
      const at = (k: string) => out.indexOf(`class="${k}"`);
      if (c.why) expect(at("ivstop-why"), s.name).toBeGreaterThan(at("ivcard-price"));
      else expect(out, s.name).not.toContain("ivstop-why");
      if (c.why && c.status) expect(at("ivstatus"), s.name).toBeGreaterThan(at("ivstop-why"));
    }
  });
});
