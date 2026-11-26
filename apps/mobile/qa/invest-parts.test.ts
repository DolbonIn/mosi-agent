// 투자's shared parts (DD 1935 §0-3, §0-4, §1, §0-7) and the top bar's status capsule (DD 1935 §3-1, DD 2008 §1).
// The marks, words, figures and closing sentence come from @pickle/quant, the one source the server and the deck share.
//   bun test ./qa/invest-parts.test.ts
import { describe, expect, test } from "bun:test";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DISCLAIMER, SIGNAL_SHAPES, pct, type Signal } from "@pickle/quant";
import { TopBar } from "../src/app/TopBar";
import { topBarStore } from "../src/app/topBarStore";
import { InvestNum, IvDisclaimer, IvFoot, IvHero, IvRow, IvRows, ModeWord, SignalLabel, SignalMark } from "../src/ui/Invest";

const html = (el: ReactElement) => renderToStaticMarkup(el);
const text = (markup: string) => markup.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/[ ⁠]/g, (c) => (c === " " ? " " : ""));
const SIGNALS: Signal[] = ["risk", "caution", "normal", "unknown"];

describe("signal marks", () => {
  test("each mark draws quant's shape, hidden from assistive tech, in the signal's colour slot", () => {
    for (const s of SIGNALS) {
      const m = html(createElement(SignalMark, { signal: s }));
      expect(m).toContain(SIGNAL_SHAPES[s]);
      expect(m).toContain('viewBox="0 0 16 16"');
      expect(m).toContain('aria-hidden="true"');
      expect(m).toContain(`data-signal="${s}"`);
    }
  });
  test("a label is the mark and its word: 위험, 경계, 정상, 확인 불가 (colour is never the only cue)", () => {
    expect(SIGNALS.map((s) => text(html(createElement(SignalLabel, { signal: s }))))).toEqual(["위험", "경계", "정상", "확인 불가"]);
    expect(html(createElement(SignalLabel, { signal: "caution" }))).toMatch(/^<span class="ivsig " data-signal="caution"><svg/);
  });
});

describe("figures", () => {
  test("a missing figure is 확인 불가 with its mark, never 0 or a dash", () => {
    for (const v of [null, undefined, ""]) {
      const m = html(createElement(InvestNum, { value: v }));
      expect(text(m)).toBe("확인 불가");
      expect(m).toContain(SIGNAL_SHAPES.unknown);
    }
  });
  test("a formatted figure is shown as given, tabular", () => {
    const m = html(createElement(InvestNum, { value: pct(-1.04) }));
    expect(text(m)).toBe("−1.04%");
    expect(m).toContain('class="tnum ');
  });
  test("rows: word left, value right (a string, a missing value, or a node)", () => {
    const m = html(
      createElement(IvRows, null, [
        createElement(IvRow, { key: "a", label: "오늘", value: "+2.31%" }),
        createElement(IvRow, { key: "b", label: "공매도 잔고", value: null }),
        createElement(IvRow, { key: "c", label: "시장 단계", value: createElement(SignalLabel, { signal: "risk" }) }),
      ]),
    );
    expect(m.startsWith('<div class="ivrows">')).toBe(true);
    const rows = [...m.matchAll(/<span class="ivrow-label">(.*?)<\/span><span class="ivrow-value">(.*?)<\/span><\/div>/g)].map((r) => [r[1], text(r[2]!)]);
    expect(rows).toEqual([
      ["오늘", "+2.31%"],
      ["공매도 잔고", "확인 불가"],
      ["시장 단계", "위험"],
    ]);
  });
  test("foot, hero, mode word", () => {
    expect(text(html(createElement(IvFoot, { children: "관측 11월 27일 00:45(미 동부 10:45) · 토스증권 · A" })))).toBe("관측 11월 27일 00:45(미 동부 10:45) · 토스증권 · A");
    expect(text(html(createElement(IvHero, { value: "$32.57" })))).toBe("$32.57");
    expect(text(html(createElement(IvHero, { value: null })))).toBe("확인 불가");
    expect(html(createElement(ModeWord, { mode: "real" }))).toBe('<span class="ivmode" data-mode="real">실제</span>');
    expect(html(createElement(ModeWord, { mode: "mock" }))).toBe('<span class="ivmode" data-mode="mock">모의</span>');
  });
  test("the closing sentence is quant's, word for word", () => {
    expect(html(createElement(IvDisclaimer))).toBe(`<p class="ivdisclaimer">${DISCLAIMER}</p>`);
  });
});

describe("the top bar's trailing capsule", () => {
  const bar = () => html(createElement(TopBar));
  const slot = (m: string) => m.slice(m.indexOf('class="tb-right-slot"'));
  test("with onPress: a button named by its label; tone rides on the same element", () => {
    topBarStore.patch({ right: { label: "초대", onPress: () => {} } });
    let s = slot(bar());
    expect(s).toMatch(/^class="tb-right-slot"><button[^>]*class="[^"]*tb-capsule/);
    expect(s).toContain('aria-label="초대"');
    topBarStore.patch({ right: { label: "실제 주문", tone: "danger", onPress: () => {} } });
    s = slot(bar());
    expect(s).toMatch(/<button[^>]*data-tone="danger"/);
  });
  test("without onPress: a status — no button, no role, no tabindex; read as its ariaLabel, the words hidden", () => {
    topBarStore.patch({ right: { label: "모의 주문", ariaLabel: "지금은 모의 주문이에요" } });
    const s = slot(bar());
    expect(s).not.toContain("<button");
    expect(s).not.toMatch(/role=|tabindex=/);
    expect(s).toMatch(/^class="tb-right-slot"><div[^>]*class="[^"]*tb-capsule tb-status/);
    expect(s).toContain('<span class="sr-only">지금은 모의 주문이에요</span>');
    expect(s).toContain('<span class="tb-status-face" aria-hidden="true">');
    expect(s).not.toContain("data-tone");
  });
  test("the hidden copy that sizes the capsule is aria-hidden and carries the same words", () => {
    topBarStore.patch({ right: { label: "실제 주문", tone: "danger", ariaLabel: "지금은 실제 주문이에요" } });
    const s = slot(bar());
    expect(s).toContain('<span class="tb-capsule tb-sizer" aria-hidden="true"><span class="tb-capsule-label">실제 주문</span></span>');
    topBarStore.patch({ right: null });
  });
});
