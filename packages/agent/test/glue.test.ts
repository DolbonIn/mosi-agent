/** The card's glued text (glue.ts: the app's glued() for HTML strings, deep-37). */
import { describe, expect, test } from "bun:test";
import { gluedHtml, gluedPieces } from "../src/glue";

const unesc = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
/** the text runs between tags: each one escaped on its own (no tag inside an entity), and the text they make */
const runs = (html: string) => html.split(/<span class="t-glue">|<\/span>|<span class="t-brk">/);
const textOf = (html: string) => unesc(runs(html).join(""));
const RUN = /^(?:[^&<>"']|&(?:amp|lt|gt|quot|#39);)*$/;

describe("gluedHtml (the app's glued() as HTML, for the card's row names)", () => {
  test("the app's spots: an opener after a character with a box before it and what it holds, a number with its separators, a closer with what it closes on, 。 before kana or kanji, a word's ·", () => {
    for (const [name, html] of [
      // design-director's deep-38 case: WebKit ended lines on '(' ('주차장( / 민영)')
      ["현대주차장(민영)", '현대주차장<span class="t-brk"></span><span class="t-glue">(민영)</span>'],
      ["8,000엔(내원)", '<span class="t-glue">8,000</span>엔<span class="t-brk"></span><span class="t-glue">(내원)</span>'],
      // the bracket joins no run before: '과의원 / (달빛어린이병원)', never a break inside the word
      ["과의원(달빛어린이병원)", '과의원<span class="t-brk"></span><span class="t-glue">(달</span>빛어린이병<span class="t-glue">원)</span>'],
      // nor a glued run ending right before it: two runs, the box between ('1,000 / (2,000)')
      ["1,000(2,000)", '<span class="t-glue">1,000</span><span class="t-brk"></span><span class="t-glue">(2,000)</span>'],
      ["池袋クリニック(東京都)のマンジャロ。初診", '池袋クリニック<span class="t-brk"></span><span class="t-glue">(東</span>京<span class="t-glue">都)</span><span class="t-brk"></span>のマンジャ<span class="t-glue">ロ。</span><span class="t-brk"></span>初診'],
      ["전화·카카오톡", '전<span class="t-glue">화·</span><span class="t-brk"></span>카카오톡'],
      ["24일–28일", '24일<span class="t-glue">–28</span>일'],
      ["03-5579-5993", '<span class="t-glue">03-5579-5993</span>'],
    ] as const)
      expect([name, gluedHtml(name)]).toEqual([name, html]);
  });

  test("nothing to glue: the escaped text itself (a number with no separator, a URL-like piece too long for a glued run)", () => {
    for (const name of ["클리닉 000", "역삼 제1호 공영주차장", "Tom & Jerry's", "<b>X</b>"]) expect([name, gluedHtml(name)]).toEqual([name, Bun.escapeHTML(name).replace(/&#x27;/g, "&#39;")]);
    expect(gluedHtml("seoul.go.kr/clinic/list(p)")).toBe('seoul.go.kr/clinic/list<span class="t-brk"></span><span class="t-glue">(p)</span>');
    // a long URL-like piece keeps its number plain (WebKit drops the "/" and "." breaks around a span edge)
    expect(gluedHtml("https://example.com/2026-11-18/list")).toBe("https://example.com/2026-11-18/list");
    // a glued run is 16 characters and 9 em at most: a longer number keeps its breaks
    expect(gluedHtml("1.1.1.1.1.1.1.1")).toBe('<span class="t-glue">1.1.1.1.1.1.1.1</span>');
    expect(gluedHtml("1.1.1.1.1.1.1.1.1")).toBe("1.1.1.1.1.1.1.1.1"); // 17 characters
    expect(gluedHtml("1234567890123–45")).toBe("1234567890123–45"); // 16, 9.85 em
  });

  test("`before` (the run drawn before in the same block; a card's name has none): an opener after a character gets a box, a ' ·' at the start rides on the word before", () => {
    expect(gluedHtml("(달빛)", "의원")).toBe('<span class="t-brk"></span><span class="t-glue">(달빛)</span>');
    expect(gluedHtml("(달빛)")).toBe('<span class="t-glue">(달빛)</span>');
    expect(gluedHtml(" · 8,000엔", "구름 클리닉")).toBe('<span class="t-glue"> ·</span> <span class="t-glue">8,000</span>엔');
    expect(gluedHtml(" · 8,000엔")).toBe(' · <span class="t-glue">8,000</span>엔');
  });

  test("each piece escaped on its own: no span edge inside an entity, the text as written (names holding & < > \" ' and entities)", () => {
    expect(gluedHtml("(&B)")).toBe('<span class="t-glue">(&amp;B)</span>');
    expect(gluedHtml("A&B(東京)")).toBe('A&amp;B<span class="t-brk"></span><span class="t-glue">(東京)</span>');
    expect(gluedHtml("<b>X</b>(3)")).toBe('&lt;b&gt;X&lt;/b&gt;<span class="t-brk"></span><span class="t-glue">(3)</span>');
    expect(gluedHtml("A&amp;B (1,000円)")).toBe('A&amp;amp;B <span class="t-glue">(1,000円)</span>');
    for (const name of ["(<3)", "Tom's(2.5mg)", "&#39;(1,000)", '"Q" 클리닉(서울)', "(’A&amp;B’)", "1,000'(x)", "가&lt;(1)", "<(&)>", "''(\"1,0\")", "クリニック(A&B)。&予約"]) {
      const html = gluedHtml(name);
      expect([name, html.includes("t-glue")]).toEqual([name, true]);
      for (const r of runs(html)) expect([name, r, RUN.test(r)]).toEqual([name, r, true]);
      expect([name, textOf(html)]).toEqual([name, name]);
    }
  });

  test("no span or box edge inside a grapheme cluster: a flag, a family, a skin tone, a keycap or a letter with its mark goes in whole", () => {
    expect(gluedHtml("가족(👨‍👩‍👧 사진)")).toBe('가족<span class="t-brk"></span><span class="t-glue">(👨‍👩‍👧</span> 사<span class="t-glue">진)</span>');
    expect(gluedHtml("한국🇰🇷) 여행")).toBe('한국<span class="t-glue">🇰🇷)</span> 여행');
    expect(gluedHtml("좋아요👍🏻·최고")).toBe('좋아요<span class="t-glue">👍🏻·</span><span class="t-brk"></span>최고');
    const seg = new Intl.Segmenter("ko", { granularity: "grapheme" });
    const E = ["👨‍👩‍👧", "🇰🇷", "👍🏻", "❤️", "1️⃣", "가̂", "é", "🏳️‍🌈", "👩🏽‍💻", "🇰🇷🇯🇵"];
    const S = ["(", ")", "·", " ·", "。", "「", "」", "1,000", "-1", "가", " "];
    let glued = 0;
    for (const e of E)
      for (const a of S)
        for (const b of S) {
          const name = `가${a}${e}${b}나`;
          const pieces = gluedPieces(name);
          if (pieces.some((p) => typeof p !== "string")) glued++;
          const edges: number[] = [];
          let at = 0;
          for (const p of pieces) {
            if (typeof p === "string") at += p.length;
            else if ("glue" in p) edges.push(at, (at += p.glue.length));
            else edges.push(at);
          }
          const bounds = new Set([0, name.length, ...[...seg.segment(name)].map((s) => s.index)]);
          expect([name, edges.filter((x) => !bounds.has(x))]).toEqual([name, []]);
          expect([name, textOf(gluedHtml(name))]).toEqual([name, name]);
        }
    expect(glued).toBeGreaterThan(E.length * S.length * S.length * 0.8);
  });

  test("a character WebKit sizes apart from how it draws it (the app's ODD: a keycap frame or style selector on # * ‼ ⁉ 〽, a skin tone on no emoji, a mark with no letter under it or of a script with no font, the Hangul fillers): plain from it to its line's end, so nothing after it moves; the spots before it and on the next lines glue as before", () => {
    const g = (s: string) => `<span class="t-glue">${s}</span>`;
    const b = '<span class="t-brk"></span>';
    for (const [name, html] of [
      // the app's case (fnd-em): "(#️⃣" in a span put "번" 10 px to the right in WebKit at 17 px
      ["(#️⃣ 번호) 다음 (1) 끝", "(#️⃣ 번호) 다음 (1) 끝"],
      // spots before it on its line glue; from it on, plain
      ["주차장(민영) ‼️ 1,000원 (예약)", `주차장${b}${g("(민영)")} ‼️ 1,000원 (예약)`],
      // a "#" with nothing on it is no such character: the "‼️" after it is the one the line goes plain from
      ["#1 가(나) ‼️ 가(다)", `#1 가${b}${g("(나)")} ‼️ 가(다)`],
      // only its own line: the lines before and after it glue
      ["가(나)\n#️⃣ 다(라)\n마(바)", `가${b}${g("(나)")}\n#️⃣ 다(라)\n마${b}${g("(바)")}`],
      ["가\u{1f3fb}(나)", "가\u{1f3fb}(나)"], // a skin tone after no emoji
      ["(\u{113b8}) 2,000", "(\u{113b8}) 2,000"], // a mark of a script with no font here
      ["가\u3164(나) 3,000", "가\u3164(나) 3,000"], // a Hangul filler
      ["〽️(표)", "〽️(표)"],
      ["#\ufe0f(1)", "#\ufe0f(1)"], // a style selector on "#" with no keycap frame
      ["가\ufe0f(나)", "가\ufe0f(나)"], // a style selector on no emoji
      ["가 \u0301(나)", "가 \u0301(나)"], // a mark with no letter under it
      ["⁉︎(1)", "⁉︎(1)"],
      // not ODD: a digit's keycap, an emoji's style selector, a mark of a script with a font, a tag or joiner after a letter
      ["(1️⃣ 먼저)", `${g("(1️⃣")} 먼${g("저)")}`],
      ["(❤️ 하트)", `${g("(❤️")} 하${g("트)")}`],
      ["e\u0301(1)", `e\u0301${b}${g("(1)")}`],
      ["가\u0302(나)", `가\u0302${b}${g("(나)")}`],
      ["가\u{e0067}(나)", `가\u{e0067}${b}${g("(나)")}`],
    ] as const)
      expect([name, gluedHtml(name)]).toEqual([name, html]);
  });

  test("linear on hostile input, the text kept whole", () => {
    const t = performance.now();
    for (const s of ["(‍".repeat(1 << 17), ")".repeat(1 << 18), "1,0".repeat(1 << 16), "🇰🇷".repeat(1 << 16), "&<'\"(".repeat(1 << 15), "#(1".repeat(1 << 16), "(#️⃣\n(1)".repeat(1 << 14), "가\u3164(1)\n".repeat(1 << 14)])
      expect(textOf(gluedHtml(s)) === s).toBe(true);
    expect(performance.now() - t).toBeLessThan(3000); // about 140 ms; a quadratic scan takes minutes
  });
});
