// Chat markdown (screens/chat/markdown.tsx): a bold-only line is a heading — the meeting summary's title and section
// heads (meeting B, 2026-11-12) — while bold inside a sentence stays inline, and an unclosed bold while streaming
// never becomes a heading early.
import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { keepsSpaces, Markdown, parseBlocks, parseInline, renderRuns, urlLong, urlPieces } from "../src/screens/chat/markdown";

const md = (text: string) => renderToStaticMarkup(createElement(Markdown, { text }));
const plain = (html: string) => html.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#x27;/g, "'");
/** `s` sits inside one glued span (where the span starts and ends is glued()'s business, FOUNDATION › Line breaks) */
const inGlue = (html: string, s: string) => new RegExp(`<span class="t-glue">[^<]*${s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^<]*</span>`).test(html);

const SUMMARY = "**회의 요약**\n\n**정한 것**\n- 출시일은 12월 2일로 확정했어요.\n\n**할 일**\n- 하늘: 랜딩 문구 금요일까지";

test("the summary: a title, then section heads, then items", () => {
  const b = parseBlocks(SUMMARY);
  expect(b.map((x) => (x.kind === "h" ? `h${x.level}` : x.kind))).toEqual(["h2", "h3", "li", "h3", "li"]);
  const first = b[0]!;
  expect(first.kind === "h" ? first.runs.map((r) => r.t).join("") : "").toBe("회의 요약");
});

test("a bold-only line later in a message is a section head (h3), with or without a colon", () => {
  const b = parseBlocks("오늘 정리예요.\n**정한 것:**\n- 하나");
  expect(b.map((x) => (x.kind === "h" ? `h${x.level}` : x.kind))).toEqual(["p", "h3", "li"]);
});

test("bold inside a sentence stays a paragraph", () => {
  const b = parseBlocks("**출시일**은 12월 2일이에요.");
  expect(b[0]!.kind).toBe("p");
});

test("an unclosed bold while streaming is not a heading yet", () => {
  const b = parseBlocks("**회의 요", true);
  expect(b[0]!.kind).toBe("p");
});

// WebKit keep-all broke after "(" and inside numbers in about half the saved replies at 390 ("8,000엔( / 내원)",
// "10, / 200엔"); FOUNDATION › Line breaks, glued()
test("a reply's tight spots are glued: a number with its separators, a bracket and what it holds on to", () => {
  const out = md("진료비는 8,000엔(내원)이고 재진은 10,200엔이에요.");
  expect(inGlue(out, "8,000")).toBe(true);
  expect(inGlue(out, "10,200")).toBe(true);
  expect(inGlue(out, "(내")).toBe(true);
});
test("glued inside bold and italic; code and a link's text left as written (a link breaks anywhere)", () => {
  const out = md("**FONTANA CLINIC(후쿠오카)** 예약은 `price(1,000)` 참고, [여기(링크)](https://a.example/p) *3.5%를*");
  const strong = /<strong>(.*?)<\/strong>/.exec(out)?.[1] ?? "";
  expect(inGlue(strong, "(후")).toBe(true);
  expect(out).toContain('<code class="md-code">price(1,000)</code>');
  const link = /<a class="md-link" href="https:\/\/a.example\/p" target="_blank" rel="noopener noreferrer">(.*?)<\/a>/.exec(out)?.[1] ?? "";
  expect(link).toBe("여기(링크)");
  const em = /<em>(.*?)<\/em>/.exec(out)?.[1] ?? "";
  expect(inGlue(em, "3.5%")).toBe(true);
});
test("a run is glued with the run before it: a ' ·' after a bold name rides on it, an opener after one gets its break", () => {
  // the second run opens on " ·": glued() sees the bold name's last word through `before`
  const dot = md("- **프라이빗 스킨 클리닉 오사카 우메다원** · 2.5mg 4펜");
  const second = /<\/strong><\/span><span>(.*?)<\/span><\/span>/.exec(dot)?.[1] ?? "";
  expect(second.startsWith('<span class="t-glue"> ·')).toBe(true);
  // an opener right after a bold name: a break box before it (keep-all leaves none between a word and "(")
  const open = md("**하이엔소아청소년과의원**(달빛어린이병원)");
  expect(/<\/strong><\/span><span><span class="t-brk"><\/span>/.test(open)).toBe(true);
  // a bold name too wide for a glued run with " ·" (16 Hangul, 9 em at most): the dot stays plain, as inside a text
  const wide = md("- **아이웰키즈맘키즈위즈소아청소년과** · 신천동");
  expect(/<\/strong><\/span><span>(.*?)<\/span><\/span>/.exec(wide)?.[1]).toBe(" · 신천동");
  // after a space an opener already has its break: no box
  expect(md("**구름 클리닉** (내원)")).not.toContain("t-brk");
});
test("heads and quotes keep no spaces (white-space normal): their runs are glued each on its own", () => {
  // a " ·" opening a run after an element's end, glued in a normal block, is where Chrome breaks and draws the space
  for (const t of ["### **구름 클리닉** · 8,000엔", "> **구름 클리닉** · 8,000엔"]) {
    const second = /<\/strong><\/span><span>(.*?)<\/span><\/(?:div|blockquote)>/.exec(md(t))?.[1] ?? "";
    expect(second).toBe(' · <span class="t-glue">8,000</span>엔');
  }
  expect(parseBlocks("### **구름 클리닉** · 8,000엔")[0]!.kind).toBe("h");
  expect(parseBlocks("> **구름 클리닉** · 8,000엔")[0]!.kind).toBe("quote");
  // which blocks keep their spaces (chat.css: .md p and .md-li-body are pre-wrap); a bold-only line is a head
  expect(parseBlocks("문단\n- 항목\n# 머리\n**굵은 머리**\n> 인용").map((b) => [b.kind, keepsSpaces(b)])).toEqual([
    ["p", true],
    ["li", true],
    ["h", false],
    ["h", false],
    ["quote", false],
  ]);
  // no break box before an opener after a bold name either (that needs the run before it)
  expect(md("# **하이엔소아청소년과의원**(달빛어린이병원)")).not.toContain("t-brk");
  expect(md("> **하이엔소아청소년과의원**(달빛어린이병원)")).not.toContain("t-brk");
  // renderRuns on its own: spaces off by default
  const runs = [{ t: "구름 클리닉", b: true }, { t: " · 신천동" }];
  const html = (spaces?: boolean) => renderToStaticMarkup(createElement("p", null, ...renderRuns(runs, spaces)));
  expect(html()).not.toContain('<span class="t-glue"> ·</span>');
  expect(html(true)).toContain('<span class="t-glue"> ·</span>');
});
test("the text reads as written (copy, screen readers): glue adds no character", () => {
  for (const t of ["진료비는 8,000엔(내원)이고 재진은 10,200엔이에요.", "- 「来院希望」 (2/3) 10:30–11:00", "1. **3만 원**(현금) · 카드 [링크(1)](https://a.example)"]) {
    const blocks = parseBlocks(t);
    const shown = blocks.map((b) => ("runs" in b ? b.runs.map((r) => r.t).join("") : "")).join("");
    expect(plain(renderToStaticMarkup(createElement("div", null, ...blocks.map((b) => ("runs" in b ? renderRuns(b.runs) : null)))))).toBe(shown);
  }
});
test("a code run inside a link stays plain text (as before)", () => {
  const out = renderToStaticMarkup(createElement("p", null, ...renderRuns([{ t: "f(1,2)", code: true, href: "https://a.example" }])));
  expect(out).toBe('<p><span><a class="md-link" href="https://a.example" target="_blank" rel="noopener noreferrer">f(1,2)</a></span></p>');
});
test("the keycap *️⃣ keeps its \"*\": it is no emphasis mark, and emphasis around it still works", () => {
  // "*" + VS16 + U+20E3 (and the bare "*⃣"): the "*" is the keycap's base, never an italic or bold mark
  const runs = (t: string) => parseBlocks(t).flatMap((b) => ("runs" in b ? b.runs : []));
  const view = (t: string) => runs(t).map((r) => (r.b ? "<b>" : "") + (r.i ? "<i>" : "") + r.t);
  expect(view("*️⃣ 누르고 *️⃣ 다시")).toEqual(["*️⃣ 누르고 *️⃣ 다시"]);
  expect(md("*️⃣ 누르고 *️⃣ 다시")).not.toContain("<em>");
  expect(plain(md("*️⃣ 누르고 *️⃣ 다시"))).toBe("*️⃣ 누르고 *️⃣ 다시");
  expect(view("*⃣ 옛 키캡 *⃣")).toEqual(["*⃣ 옛 키캡 *⃣"]);
  expect(view("- *️⃣ 버튼 · 별표")).toEqual(["*️⃣ 버튼 · 별표"]);
  // an opening "*" needs a real mark after it: a keycap's "*" does not close it
  expect(view("*별 *️⃣ 하나")).toEqual(["*별 *️⃣ 하나"]);
  // emphasis around or beside a keycap
  expect(view("*강조 *️⃣ 끝* 뒤")).toEqual(["<i>강조 *️⃣ 끝", " 뒤"]);
  expect(view("**굵게***️⃣")).toEqual(["<b>굵게", "*️⃣"]);
  expect(view("***️⃣ 키캡**")).toEqual(["<b>*️⃣ 키캡"]);
  expect(view("*강조**️⃣ 뒤")).toEqual(["<i>강조", "*️⃣ 뒤"]);
  // other keycaps and emoji were never marks
  expect(view("#️⃣ 1️⃣ ❤️ *️⃣")).toEqual(["#️⃣ 1️⃣ ❤️ *️⃣"]);
});
test("italic and bold read as before; an italic closes where its word ends, a space after it too", () => {
  const view = (t: string) => parseBlocks(t).flatMap((b) => ("runs" in b ? b.runs : [])).map((r) => (r.b ? "<b>" : "") + (r.i ? "<i>" : "") + r.t);
  expect(view("*강조*")).toEqual(["<i>강조"]);
  expect(view("*강조*이에요")).toEqual(["<i>강조", "이에요"]);
  expect(view("**굵게** 그리고")).toEqual(["<b>굵게", " 그리고"]);
  // a mark before a space closes an open italic (it opened nothing before: "*강조* 그리고" ran italic to the end)
  expect(view("가 *강조* 나")).toEqual(["가 ", "<i>강조", " 나"]);
  expect(view("**굵게** *기울임* 끝")).toEqual(["<b>굵게", " ", "<i>기울임", " 끝"]);
  expect(view("_밑줄_ 끝")).toEqual(["<i>밑줄", " 끝"]);
  expect(md("가 *강조* 나")).toContain("<em>");
  // and never opens one: a "*" before a space, inside a word or with no mark after it stays as written
  expect(view("2 * 3 * 4")).toEqual(["2 * 3 * 4"]);
  expect(view("a * b *")).toEqual(["a * b *"]);
  expect(view("snake_case_name 그대로")).toEqual(["snake_case_name 그대로"]);
  expect(view("별표* 하나")).toEqual(["별표* 하나"]);
});

// URLs break only between fixed pieces (urlPieces): WebKit's own breaks after "/" and "." changed with the elements
// around a URL, so the stream's last line and the finished answer broke one URL two ways (DD 1415, reply 20 −79 px)
const URLS = [
  "https://saclinic.net/glp-1/",
  "https://www.uchida-naishikyo.com/",
  "https://clinique-osaka-shinsaibashi.com/",
  "https://velvaere-clinic.com/menu/マンジャロ（オンライン診療対応）/",
  "https://x.jp/ZIOIQU4ILRFAVNPBKR7XJKHI3U",
  "https://life-infohub.com/후쿠오카-마운자로-성지-총정리-텐진-병원-4곳-가격·-2/",
  "https://en.wikipedia.org/wiki/Foo_(bar)",
  "https://a.com/?q=1&r=%E3%83%9E#top",
  "https://shibuyakimuraclinic.com/",
  "https://b.example/👨‍👩‍👧/가̂/1️⃣",
  // graphemes of several code points at a long piece's ends
  "https://b.example/가̂가̂가̂가̂가̂가̂가̂가̂가̂/1️⃣2️⃣3️⃣4️⃣5️⃣6️⃣7️⃣8️⃣9️⃣/👨‍👩‍👧👨‍👩‍👧👨‍👩‍👧👨‍👩‍👧👨‍👩‍👧👨‍👩‍👧👨‍👩‍👧👨‍👩‍👧",
];
const cutsOf = (ps: string[]) => ps.slice(0, -1).map((_, k) => ps.slice(0, k + 1).join("").length);
const graphemeEnds = (t: string) => [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(t)].map((g) => g.index + g.segment.length);
test("a URL's pieces: after / . - _ ? # & = (a run of them together) and before an opener; never a line starting on a mark or closer", () => {
  expect(urlPieces("https://saclinic.net/glp-1/")).toEqual(["https://", "saclinic.", "net/", "glp-", "1/"]);
  expect(urlPieces("https://www.uchida-naishikyo.com/")).toEqual(["https://", "www.", "uchida-", "naishikyo.", "com/"]);
  expect(urlPieces("https://a.com/?q=1&r=%E3%83%9E#top")).toEqual(["https://", "a.", "com/?", "q=", "1&", "r=%", "E3%", "83%", "9E#", "top"]);
  // a bracket: a break before an opener, never after one or before a closer
  expect(urlPieces("https://en.wikipedia.org/wiki/Foo_(bar)")).toEqual(["https://", "en.", "wikipedia.", "org/", "wiki/", "Foo_", "(bar)"]);
  expect(urlPieces("https://velvaere-clinic.com/menu/マンジャロ（オンライン診療対応）/").slice(5)).toEqual(["マンジャロ", "（オンライン診療対応）/"]);
  expect(urlPieces("https://a.jp/x/（a）")).toEqual(["https://", "a.", "jp/", "x/", "（a）"]);
  expect(urlPieces("https://a.jp/x/)")).toEqual(["https://", "a.", "jp/", "x/)"]);
  expect(urlPieces("https://a.jp/x（「a」）")).toEqual(["https://", "a.", "jp/", "x", "（「a」）"]);
  // a label that is an address
  expect(urlPieces("kr.kimdentalclinic-tokyo.com")).toEqual(["kr.", "kimdentalclinic-", "tokyo.", "com"]);
  // an id or a long word stays one piece: past 9 em its middle breaks only where it overflows, its first grapheme (with
  // openers) and its last (with marks and closers) never (no line starts on its "/" or ".")
  expect(urlPieces("https://x.jp/ZIOIQU4ILRFAVNPBKR7XJKHI3U/").slice(3)).toEqual(["ZIOIQU4ILRFAVNPBKR7XJKHI3U/"]);
  expect(urlLong("ZIOIQU4ILRFAVNPBKR7XJKHI3U/")).toEqual(["Z", "IOIQU4ILRFAVNPBKR7XJKHI3", "U/"]);
  expect(urlLong("shibuyakimuraclinic.")).toEqual(["s", "hibuyakimuraclini", "c."]);
  expect(urlLong("（オンライン診療対応）/")).toEqual(["（オ", "ンライン診療対", "応）/"]);
  expect(urlLong("naishikyo.")).toBeNull();
  expect(urlLong("WWWWWWWW/")).toBeNull();
  expect(urlLong("WWWWWWWWW/")).toEqual(["W", "WWWWWWW", "W/"]);
  // openers to its end: nothing is left between its ends, so it stays whole
  expect(urlLong("（（（（（（（（（a")).toBeNull();
  // its ends are whole graphemes
  expect(urlLong("가̂가̂가̂가̂가̂가̂가̂가̂/")).toEqual(["가̂", "가̂가̂가̂가̂가̂가̂", "가̂/"]);
  expect(urlLong("👨‍👩‍👧👨‍👩‍👧👨‍👩‍👧👨‍👩‍👧👨‍👩‍👧👨‍👩‍👧👨‍👩‍👧/")).toEqual(["👨‍👩‍👧", "👨‍👩‍👧👨‍👩‍👧👨‍👩‍👧👨‍👩‍👧👨‍👩‍👧", "👨‍👩‍👧/"]);
});
test("pieces keep every character, never split a grapheme, and break where the finished URL does at every stage", () => {
  for (const u of URLS) {
    const ps = urlPieces(u);
    expect(ps.join("")).toBe(u);
    const ends = new Set(graphemeEnds(u));
    for (const c of cutsOf(ps)) expect(ends.has(c)).toBe(true);
    // a URL still streaming in (a bare URL is a link once its scheme and two more characters are in: URL_RE): its cuts
    // are the finished URL's cuts before its end
    for (const e of graphemeEnds(u).filter((e) => e > "https://".length)) {
      const part = u.slice(0, e);
      expect(cutsOf(urlPieces(part))).toEqual(cutsOf(ps).filter((c) => c < e));
    }
    // a line starting at one of its breaks: the same pieces from there on
    for (const [k, c] of cutsOf(ps).entries()) expect(urlPieces(u.slice(c))).toEqual(ps.slice(k + 1));
  }
});
test("a link that reads as a URL is drawn piece by piece; other link text as before", () => {
  expect(parseInline("예약 https://saclinic.net/glp-1/ 공식")[1]).toEqual({ t: "https://saclinic.net/glp-1/", href: "https://saclinic.net/glp-1/", url: true });
  expect(parseInline("[clinic.dmm.com](https://clinic.dmm.com/x)")[0]).toEqual({ t: "clinic.dmm.com", href: "https://clinic.dmm.com/x", url: true });
  expect(parseInline("[공식](https://a.jp/b)")[0]).toEqual({ t: "공식", href: "https://a.jp/b" });
  expect(parseInline("[3.5mg 안내](https://a.jp/b)")[0]!.url).toBeUndefined();
  const out = md("- 06-6121-7600 · https://saclinic.net/glp-1/ — 공식 확인");
  const link = /<a class="md-link" href="https:\/\/saclinic.net\/glp-1\/" target="_blank" rel="noopener noreferrer">(.*?)<\/a>/.exec(out)?.[1] ?? "";
  expect(link).toBe(
    '<span class="md-url">https://</span><span class="md-url-brk"></span><span class="md-url">saclinic.</span><span class="md-url-brk"></span><span class="md-url">net/</span><span class="md-url-brk"></span><span class="md-url">glp-</span><span class="md-url-brk"></span><span class="md-url">1/</span>',
  );
  expect(plain(link)).toBe("https://saclinic.net/glp-1/");
  expect(md("[공식](https://a.jp/b)")).toContain('rel="noopener noreferrer">공식</a>');
  // a piece past 9 em: its ends nowrap, its middle plain text that breaks where it overflows
  expect(md("https://x.jp/ZIOIQU4ILRFAVNPBKR7XJKHI3U")).toContain('<span class="md-url-brk"></span><span><span class="md-url">Z</span>IOIQU4ILRFAVNPBKR7XJKHI3<span class="md-url">U</span></span></a>');
  // bold link text: pieces inside the bold
  expect(md("**[www.a.jp](https://www.a.jp)** 참고")).toContain('<strong><a class="md-link" href="https://www.a.jp" target="_blank" rel="noopener noreferrer"><span class="md-url">www.</span>');
});
test("a keycap inside a URL or an address label: the URL takes it whole, no emphasis, no break inside it", () => {
  expect(parseInline("https://x.com/#️⃣ 확인")[0]).toEqual({ t: "https://x.com/#️⃣", href: "https://x.com/#️⃣", url: true });
  // "#️⃣" and "*️⃣" are one grapheme each: never a mark to break after
  expect(urlPieces("https://x.com/#️⃣/*️⃣a")).toEqual(["https://", "x.", "com/", "#️⃣/", "*️⃣a"]);
  const out = md("*️⃣ https://x.com/*️⃣ *️⃣ 그리고 [x.com/#️⃣](https://x.com/#️⃣) *강조*");
  expect(out.match(/<em>/g)?.length).toBe(1);
  expect(out).toContain('<span class="md-url">*️⃣</span></a>');
  expect(out).toContain('<span class="md-url">#️⃣</span></a>');
  expect(plain(out)).toBe("*️⃣ https://x.com/*️⃣ *️⃣ 그리고 x.com/#️⃣ 강조");
});
