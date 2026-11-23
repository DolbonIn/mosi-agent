// Streaming answer (screens/chat/StreamText.tsx): which blocks and lines draw again on a commit. The layout itself (lines
// that freeze, the swap to the static answer) is measured in browsers by the stream probe of snap-reply-glue.
import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseBlocks, parseInline, renderRuns, sliceRuns } from "../src/screens/chat/markdown";
import { commitPoint, sameBlock, sameLine, StreamText } from "../src/screens/chat/StreamText";

// a table (each row a paragraph), a paragraph a list follows, a paragraph ending in a number that a list item continues
const TABLE = "가격을 정리했어요.\n| 이름 | 가격 |\n|---|---|\n| 구름 클리닉 | 10,200엔 |\n| 하늘 의원 | 8,000엔(내원) |\n목록으로 보면\n- **구름 클리닉** · 신천동\n- 하늘 의원 (내원)\n2026년 기준\n1. 첫째\n2. 둘째";
const DRAFT = "**회의 요약**\n\n정리했어요. 진료비는 8,000엔(내원)이에요.\n- 첫째: 10,200엔\n- 둘째 [링크(1)](https://a.example)\n```\ncode(1,000)\n```\n> 인용 3.5%\n- [x] 끝난 일\n---\n**정한 것:**\n1. 출시일은 12월 2일로";

/** the draft's commits as the stream shows them, a few characters at a time */
const commits = (text: string, step = 3) => {
  const out: string[] = [];
  for (let i = step; i < text.length + step; i += step) {
    const c = commitPoint(text.slice(0, i));
    if (c && c !== out[out.length - 1]) out.push(c);
  }
  return out;
};

describe("sameBlock", () => {
  test("a block that is not live and reads the same is skipped; one that changed draws again", () => {
    const [a] = parseBlocks("앞 문단이에요.\n다음", true);
    expect(sameBlock({ block: a!, live: false }, { block: parseBlocks("앞 문단이에요.\n다음 줄", true)[0]!, live: false })).toBe(true);
    expect(sameBlock({ block: a!, live: false }, { block: parseBlocks("앞 문단이에요!\n다음", true)[0]!, live: false })).toBe(false);
    // the same line read as another kind (a bold line becomes a head once its ** closes), a code block that closed
    expect(sameBlock({ block: parseBlocks("**정한 것", true)[0]!, live: false }, { block: parseBlocks("**정한 것**", true)[0]!, live: false })).toBe(false);
    expect(sameBlock({ block: parseBlocks("```\na\n", true)[0]!, live: false }, { block: parseBlocks("```\na\n```\n", true)[0]!, live: false })).toBe(false);
  });
  test("the live block always draws again, and so does the block that just stopped being live", () => {
    const [a] = parseBlocks("문단", true);
    expect(sameBlock({ block: a!, live: true }, { block: a!, live: true })).toBe(false);
    expect(sameBlock({ block: a!, live: true }, { block: a!, live: false })).toBe(false);
    expect(sameBlock({ block: a!, live: false }, { block: a!, live: true })).toBe(false);
  });
  test("a block read as another kind at the same place draws again: a paragraph that is now a list item or a table row", () => {
    const [p] = parseBlocks("첫째 항목", true);
    const [li] = parseBlocks("- 첫째 항목", true);
    const [row] = parseBlocks("| 첫째 항목 |", true);
    expect(sameBlock({ block: p!, live: false }, { block: li!, live: false })).toBe(false);
    expect(sameBlock({ block: p!, live: false }, { block: row!, live: false })).toBe(false);
    expect(sameBlock({ block: li!, live: false }, { block: parseBlocks("1. 첫째 항목", true)[0]!, live: false })).toBe(false);
  });
  test.each([
    ["the draft", DRAFT],
    ["a table and lists after paragraphs", TABLE],
  ])("over %s: every block skipped on a commit reads exactly as on the commit before", (_, draft) => {
    let skipped = 0;
    const cs = commits(draft);
    for (let i = 1; i < cs.length; i++) {
      const prev = parseBlocks(cs[i - 1]!, true);
      const next = parseBlocks(cs[i]!, true);
      next.forEach((b, k) => {
        if (k >= prev.length) return;
        const pa = { block: prev[k]!, live: k === prev.length - 1 };
        const pb = { block: b, live: k === next.length - 1 };
        if (sameBlock(pa, pb)) {
          skipped++;
          expect(b).toEqual(prev[k]!);
        }
      });
    }
    expect(skipped).toBeGreaterThan(20);
  });
  test("a keycap *️⃣ while streaming: no commit reads its \"*\" as a mark; an italic after it opens once it closes", () => {
    const text = "*️⃣ 누르고 *️⃣ 다시, 그다음 *강조* 끝\n- *️⃣ 버튼 · 별표";
    const cs = commits(text, 1);
    expect(cs.length).toBeGreaterThan(5);
    for (const c of cs) {
      const runs = parseBlocks(c, true).flatMap((b) => ("runs" in b ? b.runs : []));
      // every keycap drawn whole, never inside an italic run
      for (const r of runs) if (r.i) expect(r.t).not.toContain("\u20e3");
      expect(runs.map((r) => r.t).join("").split("*\ufe0f\u20e3").length).toBe(c.split("*\ufe0f\u20e3").length);
    }
    const last = parseBlocks(text, true).flatMap((b) => ("runs" in b ? b.runs : []));
    expect(last.filter((r) => r.i).map((r) => r.t)).toEqual(["강조"]);
  });
  test("an italic closes only on its own mark while streaming too: no commit ends \"*snake_case\" at the \"_\"", () => {
    const text = "*snake_case 예시*를 보면 _밑줄 *별표_ 끝";
    const cs = commits(text, 1);
    expect(cs.length).toBeGreaterThan(3);
    for (const c of cs) {
      // an italic run is always a whole one, never cut at the other mark
      for (const r of parseBlocks(c, true).flatMap((b) => ("runs" in b ? b.runs : []))) if (r.i) expect(["snake_case 예시", "밑줄 *별표"]).toContain(r.t);
    }
    const last = parseBlocks(text, true).flatMap((b) => ("runs" in b ? b.runs : []));
    expect(last.filter((r) => r.i).map((r) => r.t)).toEqual(["snake_case 예시", "밑줄 *별표"]);
  });
  test("a bold closes only on its own mark while streaming too: no commit cuts \"**__init__ 함수**\" at a \"__\"", () => {
    const text = "**__init__ 함수**를 보면 __a**b__ 끝, ***️⃣ 메뉴__ 끝** 그리고";
    const whole = ["__init__ 함수", "a**b", "*️⃣ 메뉴__ 끝"];
    const cs = commits(text, 1);
    expect(cs.length).toBeGreaterThan(5);
    for (const c of cs) {
      // a bold run is always the start of a whole one (a bold still open while streaming is drawn bold), never cut at the other mark
      for (const r of parseBlocks(c, true).flatMap((b) => ("runs" in b ? b.runs : []))) if (r.b) expect(whole.some((w) => w.startsWith(r.t))).toBe(true);
    }
    const last = parseBlocks(text, true).flatMap((b) => ("runs" in b ? b.runs : []));
    expect(last.filter((r) => r.b).map((r) => r.t)).toEqual(whole);
  });
  test("a link whose URL holds a (…) pair while streaming: its label waits as text, never the raw markdown, then the whole link", () => {
    const text = "자세한 건 [x.com/(note)/y](https://x.com/(note)/y) 에서 봐요. 위키는 https://ja.wikipedia.org/wiki/A_(B) 참고";
    const cs = commits(text, 1);
    expect(cs.length).toBeGreaterThan(5);
    for (const c of cs) {
      const runs = parseBlocks(c, true).flatMap((b) => ("runs" in b ? b.runs : []));
      for (const r of runs) {
        if (!r.href) expect(r.t).not.toContain("](");
        else if (!r.href.includes("wikipedia")) expect(r.href).toBe("https://x.com/(note)/y");
        else expect("https://ja.wikipedia.org/wiki/A_(B)".startsWith(r.href)).toBe(true);
      }
    }
    const last = parseBlocks(text, true).flatMap((b) => ("runs" in b ? b.runs : []));
    expect(last.filter((r) => r.href).map((r) => r.href)).toEqual(["https://x.com/(note)/y", "https://ja.wikipedia.org/wiki/A_(B)"]);
    // the streamed text as it stands (not cut at a commit point): an open "(" in the URL still waits, a closed link shows
    const view = (t: string) => parseBlocks(t, true).flatMap((b) => ("runs" in b ? b.runs : [])).map((r) => (r.href ? `<${r.href}>` : r.t));
    expect(view("보기 [x](https://x.com/(no")).toEqual(["보기 x"]);
    expect(view("보기 [x](https://x.com/(note)/y")).toEqual(["보기 x"]);
    expect(view("보기 [x](https://x.com/(a)/(b")).toEqual(["보기 x"]);
    expect(view("보기 [x](https://x.com/a((b))")).toEqual(["보기 x"]);
    expect(view("보기 [x](https://x.com/(note)/y)")).toEqual(["보기 ", "<https://x.com/(note)/y>"]);
    expect(view("보기 [x](https://a.example)")).toEqual(["보기 ", "<https://a.example>"]);
    // only the last "[…](…" can still be coming: an earlier "[참고]" with a space after it stays, a "[" inside the label
    // stays in it, a "]" with a ")" after it and no "(" is no link
    expect(view("[참고] 그리고 [x](https://x.com/(no")).toEqual(["[참고] 그리고 x"]);
    expect(view("보기 [a [b](https://x.com/(no")).toEqual(["보기 a [b"]);
    expect(view("보기 [x]y)")).toEqual(["보기 [x]y)"]);
  });
  test("hostile URL parentheses never stall a commit: each shape × 5,000 parses in under 50 ms, streaming or not (DD 1432)", () => {
    const shapes = [
      "[a](https://" + "(a".repeat(5000) + " x",
      "[a](https://" + "((a".repeat(5000) + " x",
      "[a](https://" + "(a".repeat(5000) + ") 끝",
    ];
    for (const s of shapes) {
      let best = Infinity;
      for (let n = 0; n < 3; n++) {
        const t0 = performance.now();
        parseBlocks(s, true);
        parseBlocks(s);
        best = Math.min(best, performance.now() - t0);
      }
      expect(best).toBeLessThan(50);
    }
  });
  test("hostile brackets and marks never stall a commit: each 100k-character shape parses in under 100 ms (lead 1432)", () => {
    const K = 100000;
    const shapes = ["[".repeat(K), "[[ ".repeat(K / 3), "[a](".repeat(K / 4), "[".repeat(K) + "]x", "[".repeat(K) + "](https://a/(b", "[".repeat(K / 2) + "](https://" + "a".repeat(K / 2), "[a]".repeat(K / 3), "[".repeat(20000) + "\n끝", "*".repeat(K), "**".repeat(K / 2), "`".repeat(K), "*a".repeat(K / 2)];
    for (const s of shapes) {
      let best = Infinity;
      for (let n = 0; n < 2; n++) {
        const t0 = performance.now();
        parseBlocks(s, true);
        parseBlocks(s);
        parseInline(s, true);
        parseInline(s);
        best = Math.min(best, performance.now() - t0);
      }
      expect(best).toBeLessThan(100);
    }
  });
  test("blocks are plain data: they survive JSON as they are (no functions, no cycles, nothing dropped)", () => {
    for (const c of commits(DRAFT, 7)) for (const b of parseBlocks(c, true)) expect(JSON.parse(JSON.stringify(b))).toEqual(b);
  });
});

describe("sameLine", () => {
  test("a frozen line keeps its nodes while its runs read the same, and draws again when a style or a letter changes", () => {
    const runs = [{ t: "진료비 " }, { t: "8,000엔", b: true }];
    expect(sameLine({ runs }, { runs: [{ t: "진료비 " }, { t: "8,000엔", b: true }] })).toBe(true);
    expect(sameLine({ runs }, { runs: [{ t: "진료비 " }, { t: "8,000엔" }] })).toBe(false);
    expect(sameLine({ runs }, { runs: [{ t: "진료비 " }, { t: "8,000엔!", b: true }] })).toBe(false);
    // a style that only the newer runs carry (a key the older run has not got at all), either way round
    expect(sameLine({ runs: [{ t: "진료비 " }] }, { runs: [{ t: "진료비 ", b: true }] })).toBe(false);
    expect(sameLine({ runs: [{ t: "링크" }] }, { runs: [{ t: "링크", href: "https://a.example" }] })).toBe(false);
    expect(sameLine({ runs: [{ t: "링크", href: "https://a.example" }] }, { runs: [{ t: "링크" }] })).toBe(false);
  });
  test("a line whose block stopped keeping spaces draws again (a bold line that became a head glues its runs apart)", () => {
    const runs = [{ t: "구름 클리닉", b: true }, { t: " · 8,000엔" }];
    expect(sameLine({ runs, spaces: true }, { runs: [{ t: "구름 클리닉", b: true }, { t: " · 8,000엔" }], spaces: true })).toBe(true);
    expect(sameLine({ runs, spaces: true }, { runs, spaces: false })).toBe(false);
    expect(sameLine({ runs, spaces: false }, { runs, spaces: true })).toBe(false);
  });
  test("a list and a keyed object holding the same values are not the same", () => {
    const runs = [{ t: "가" }];
    const keyed = { 0: { t: "가" } } as unknown as typeof runs;
    expect(sameLine({ runs }, { runs: keyed })).toBe(false);
    expect(sameLine({ runs: keyed }, { runs })).toBe(false);
  });
  test("the stream glues as the finished answer does: a list item's runs with the run before, a head's each on its own", () => {
    const live = (text: string) => renderToStaticMarkup(createElement(StreamText, { text }));
    // the last word is held back until a space follows it (commitPoint): "신천동 " is the next commit
    expect(live("- **구름 클리닉** · 신천동 ")).toContain('<span class="t-glue"> ·</span>');
    expect(live("문단 **구름 클리닉** · 신천동 ")).toContain('<span class="t-glue"> ·</span>');
    expect(live("# **구름 클리닉** · 신천동 ")).not.toContain('<span class="t-glue"> ·</span>');
    expect(live("> **구름 클리닉** · 신천동 ")).not.toContain('<span class="t-glue"> ·</span>');
  });
  test("a URL split over stream lines draws the finished URL's pieces, at every commit and at every break", () => {
    // the pieces between the URL's boxes, as text
    const pieces = (html: string) =>
      [...html.matchAll(/<a class="md-link"[^>]*>(.*?)<\/a>/g)].flatMap((m) => m[1]!.split('<span class="md-url-brk"></span>').map((p) => p.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&")));
    const html = (rs: ReturnType<typeof parseBlocks>[number] extends infer B ? (B extends { runs: infer R } ? R : never) : never) =>
      renderToStaticMarkup(createElement("span", null, ...renderRuns(rs, true)));
    const text = "- 06-6121-7600, LINE 예약 · https://clinique-osaka-shinsaibashi.com/menu/マンジャロ（オンライン）/ — 공식 확인";
    const final = parseBlocks(text)[0]!;
    if (!("runs" in final)) throw new Error("no runs");
    const all = pieces(html(final.runs));
    expect(all.join("")).toBe("https://clinique-osaka-shinsaibashi.com/menu/マンジャロ（オンライン）/");
    // every commit: the live URL's pieces are the finished ones, the last one cut short at most
    for (const c of commits(text, 1)) {
      const b = parseBlocks(c, true)[0];
      if (!b || !("runs" in b)) continue;
      const got = pieces(html(b.runs));
      if (!got.length) continue;
      expect(got.slice(0, -1)).toEqual(all.slice(0, got.length - 1));
      expect(all[got.length - 1]!.startsWith(got[got.length - 1]!)).toBe(true);
    }
    // a line break at any of the URL's breaks: the two lines' pieces are the finished ones
    const start = text.indexOf("https://") - 2;
    let at = start;
    for (const p of all.slice(0, -1)) {
      at += p.length;
      const two = [...pieces(html(sliceRuns(final.runs, 0, at))), ...pieces(html(sliceRuns(final.runs, at, 1e9)))];
      expect(two).toEqual(all);
    }
  });
  test("a visual line's first run is glued without the run before it (it starts where the browser broke)", () => {
    const runs = [{ t: "구름 클리닉", b: true }, { t: " · 신천동 · 10,200엔" }];
    const html = (rs: typeof runs, spaces = true) => renderToStaticMarkup(createElement("span", null, ...renderRuns(rs, spaces)));
    // the whole block: " ·" rides on the bold name
    expect(html(runs)).toContain('<span class="t-glue"> ·</span>');
    // a line starting at "·" (a line break never leaves a space at a line's start): its first run has no `before`
    const line = sliceRuns(runs, runs[0]!.t.length + 1, runs[0]!.t.length + runs[1]!.t.length);
    expect(line).toEqual([{ t: "· 신천동 · 10,200엔" }]);
    expect(html(line)).toBe(html(line, false));
  });
});
