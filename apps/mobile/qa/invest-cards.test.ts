/**
 * The chat's 투자 cards (DD 1935 §2-1·2-2, 2010 §2·3·5): cards the server's own builders make (apps/server
 * invest/cards.ts), drawn by CardView. The card draws the server's words and figures as they come.
 */
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createElement, type ComponentType, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Card, InvestStopCard } from "@pickle/protocol";
import { DISCLAIMER } from "@pickle/quant";
import { alertCard, callText, expiredCard, mockStopCard, type AlertInput } from "../../server/src/invest/cards.ts";
import type { RuleSpec } from "../../server/src/invest/rules.ts";
import { getScreen, getTabRoot, nav, navStore, registerScreen, registerTabRoot, unregisterScreen, type ScreenProps } from "../src/app/nav";
import { CardView } from "../src/screens/chat/cards/CardView";
import { openRules } from "../src/screens/chat/cards/InvestCards";

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

  const real = (over: Partial<InvestStopCard>): InvestStopCard => ({
    ...stop(47),
    mode: "real",
    state: "submitted",
    title: "손절 주문을 냈어요",
    status: "체결 확인 중",
    notes: [],
    ...over,
  });

  test("real: 실제 in danger; submitted shows the loader and 체결 확인 중; the check only once filled", () => {
    const sub = view(real({}));
    expect(sub).toContain('<span class="ivmode" data-mode="real">실제</span>');
    expect(sub).toMatch(/<p class="ivstatus" data-state="submitted" role="status"><span class="ivspin" aria-hidden="true"><\/span>체결 확인 중/);
    expect(sub).not.toContain("ivcheck");
    const filled = view(real({ state: "filled", title: "손절 매도가 체결됐어요", status: "체결됐어요 · 00:47" }));
    expect(filled).toContain("ivcheck");
    expect(filled).not.toContain("ivspin");
  });

  test("partial: still the loader, never the check (G8-7: done only once the server saw FILLED)", () => {
    const part = view(real({ state: "partial", title: "손절 주문이 일부 체결됐어요", status: "20주 체결 · 나머지 확인 중" }));
    expect(part).toMatch(/<p class="ivstatus" data-state="partial" role="status"><span class="ivspin" aria-hidden="true"><\/span>20주 /);
    expect(text(part)).toContain("20주 체결 · 나머지 확인 중");
    expect(part).not.toContain("ivcheck");
  });

  test("a 403 failure: the danger mark, the reason line, the allowed IP row with 복사 (plain when it cannot be pressed)", () => {
    const card = real({ state: "failed", title: "손절 주문이 되지 않았어요", status: undefined, reason: { code: "ip_not_allowed", text: "토스증권이 이 서버의 접속을 막았어요(허용 IP).", ip: "203.0.113.24" } });
    const out = view(card);
    expect(out).toMatch(/data-signal="risk"/);
    expect(text(out)).toContain("토스증권이 이 서버의 접속을 막았어요(허용 IP).");
    expect(out).toContain('aria-label="허용 IP 203.0.113.24 복사"');
    const still = view(card, false);
    expect(still).not.toContain("<button");
    expect(text(still)).toContain("203.0.113.24");
  });
});
