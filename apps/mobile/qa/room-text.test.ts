// The room card's text (screens/chat/cards/MessengerThreadCard.tsx `Linked`): links tappable, the rest tied a line at a
// time (the layout itself is checked in browsers by qa/lines.spec.mjs and qa/messenger.spec.mjs)
import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Linked, MessengerThreadCard, narrowEm } from "../src/screens/chat/cards/MessengerThreadCard";

/** at text size 1 in a row of the open room unless given (the card passes its line's narrowest, narrowEm) */
const html = (text: string, clamp = narrowEm("row", 1)) => renderToStaticMarkup(createElement(Linked, { text, clamp }));
const plain = (markup: string) => markup.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&");
const tie = (s: string) => `<span class="t-tie">${s}</span>`;

describe("Linked", () => {
  test("a number and its unit ride together (keep-all broke '회비 3만 / 원은' at 430)", () => {
    expect(html("이번 달 회비 3만 원은 금요일까지 보내 줘")).toContain(tie("3만 원은"));
  });
  test("the person's own lines stay: a '·' opening a line does not ride up", () => {
    const text = "준비물\n· 물\n· 회비 3만 원";
    expect(plain(html(text))).toBe("준비물\n· 물\n· 회비 3만 원");
    expect(html(text).split("\n")).toHaveLength(3);
    expect(plain(html("내일 \n  봐"))).toBe("내일 \n  봐");
  });
  test("nothing tied inside a link (a tie is a box: no underline)", () => {
    // "http://a/1.5" would be tied outside a link (a number with a point inside, 12 characters)
    const out = html("여기 http://a/1.5 3만 원");
    expect(out).toContain('class="mt-link">http://a/1.5</a>');
    expect(out).toContain(tie("3만 원"));
  });
  test("a quote stays with the word it touches", () => {
    expect(html("“알겠어”처럼 답해")).toContain(tie("“알겠어”처럼"));
  });
  test("no tie wider than the line it sits on (a box wrapping inside broke the 4-line clamp: 5 lines, 6 at size 1.3)", () => {
    // “알겠어”처럼 is 6.2 em by tied()'s count: tied where the line holds 8.2 em, not where it holds 5.4
    expect(html("“알겠어”처럼 답해", narrowEm("row", 1))).toContain(tie("“알겠어”처럼"));
    expect(html("“알겠어”처럼 답해", narrowEm("row", 1.3))).toBe("“알겠어”처럼 답해");
    // a short tie stays at the narrowest
    expect(html("회비 3만 원은 금요일까지 보내 줘", narrowEm("row", 1.3))).toContain(tie("3만\u00a0원은"));
    // a quote of 12 characters: the old cap tied it, and it wrapped in my highlight at 320
    expect(html("“열두글자다묶어요”처럼", narrowEm("mine", 1))).toBe("“열두글자다묶어요”처럼");
    const long = "「今日はとてもいい天気ですね」";
    const out = html(`그가 ${long} 했어 3만 원`, narrowEm("highlight", 0.9));
    expect(out).toContain(` ${long} `);
    expect(out).toContain(tie("3만\u00a0원"));
  });
  test("each place ties to its own line (text size 1): the room's highlight holds 10.9 em, mine 8.8", () => {
    // “알겠습니다요”처럼 is 9.2 em by tied()'s count
    const text = "그가 “알겠습니다요”처럼 답했어";
    const msg = (id: string, isMe: boolean) => ({ id, at: 1794927419138, senderId: isMe ? "me" : "u1", senderName: isMe ? "나" : "도윤", isMe, kind: "text" as const, text });
    const card = { type: "messenger" as const, provider: "kakaotalk", action: "read" as const, target: "방", messages: [], room: { title: "방", kind: "group" as const, memberCount: 3 }, total: 2, highlights: ["a", "b"], thread: [msg("a", false), msg("b", true)] };
    const out = renderToStaticMarkup(createElement(MessengerThreadCard, { card }));
    const hl = Object.fromEntries([...out.matchAll(/<li class="mt-hl (is-me|is-peer)">(.*?)<\/li>/g)].map((m) => [m[1], m[2]]));
    expect(hl["is-peer"]).toContain(tie("“알겠습니다요”처럼"));
    expect(hl["is-me"]).toContain("“알겠습니다요”처럼");
    expect(hl["is-me"]).not.toContain(tie("“알겠습니다요”처럼"));
  });
  test("narrowEm: the measured lines, and a size between two measured ones reads the narrower", () => {
    expect([0.9, 1, 1.1, 1.2, 1.3].map((s) => narrowEm("mine", s))).toEqual([10.3, 8.8, 7.7, 6.7, 5.9]);
    expect([0.9, 1, 1.1, 1.2, 1.3].map((s) => narrowEm("highlight", s))).toEqual([12.5, 10.9, 9.5, 8.4, 7.5]);
    expect([0.9, 1, 1.1, 1.2, 1.3].map((s) => narrowEm("row", s))).toEqual([9.5, 8.2, 7.1, 6.2, 5.4]);
    expect(narrowEm("row", 1.05)).toBe(7.1);
    expect(narrowEm("row", 1.01)).toBe(7.1);
    expect(narrowEm("row", 1.29)).toBe(5.4);
    // tier.ts keeps the size inside 0.9–1.3; outside it the ends hold
    expect(narrowEm("mine", 0.5)).toBe(10.3);
    expect(narrowEm("mine", 2)).toBe(5.9);
  });
  test("plain text is left as written", () => {
    expect(html("내일 보자")).toBe("내일 보자");
  });
});
