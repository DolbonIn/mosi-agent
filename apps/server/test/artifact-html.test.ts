import { describe, expect, test } from "bun:test";
import { htmlPreview, htmlText } from "@pickle/protocol";
import type { LlmMessage } from "@pickle/agent";
import { cleanArtifactHtml, cleanCss, MAX_ARTIFACT_HTML_BYTES, tuneCss, type CssTunes } from "../src/artifactHtml.ts";
import { compactHtmlCalls, HTML_GUIDE_REPLAY, sanitizeHistory, trimHistory } from "../src/history.ts";

const clean = (h: string) => cleanArtifactHtml(h).html;
const zero = () => ({ elements: 0, handlers: 0, remote: 0, links: 0 });

describe("cleanArtifactHtml: what stays", () => {
  test("a normal fragment comes through as written (style, markup, classes, SVG, data: images, links)", () => {
    const h = [
      "<style>.card{border-radius:16px;padding:12px;background:#fff}.t{font:600 17px/1.4 -apple-system}</style>",
      '<div class="card" style="color:#111"><h1 class="t">갤러리</h1><p>조회 <b>1,204</b> · 추천 32</p>',
      '<img alt="썸네일" src="data:image/png;base64,iVBORw0KGgo=">',
      '<svg viewBox="0 0 10 10" width="10"><defs><linearGradient id="g"><stop offset="0" stop-color="#f00"/></linearGradient></defs><rect fill="url(#g)" width="10" height="10"/><use href="#g"/></svg>',
      '<a href="https://example.com/a?b=1&amp;c=2">원문</a> <a href=" HTTPS://www.visitjeju.net/kr">비짓제주</a>',
      "<details open><summary>더 보기</summary><table><tr><th>A</th><td>B</td></tr></table></details></div>",
    ].join("");
    const r = cleanArtifactHtml(h);
    expect(r.removed).toEqual(zero());
    expect(r.html).toBe(h.replace("<stop offset=\"0\" stop-color=\"#f00\"/>", '<stop offset="0" stop-color="#f00" />').replace('<rect fill="url(#g)" width="10" height="10"/>', '<rect fill="url(#g)" width="10" height="10" />').replace('<use href="#g"/>', '<use href="#g" />'));
  });

  test("the document wrapper is stripped: doctype, html/head/body tags, title, meta, link; the head's <style> stays", () => {
    const h = '<!DOCTYPE html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>제목</title><link rel="stylesheet" href="https://cdn.x/a.css"><style>p{margin:0}</style></head><body class="x"><p>본문</p></body></html>';
    expect(clean(h)).toBe("<style>p{margin:0}</style><p>본문</p>");
  });

  test("text keeps its entities; a stray < becomes &lt;", () => {
    expect(clean("<p>1 < 2 &amp; 3 &gt; 2 &hellip;</p>")).toBe("<p>1 &lt; 2 &amp; 3 &gt; 2 &hellip;</p>");
  });

  test("attributes are re-quoted; the first of duplicates wins; odd names go", () => {
    expect(clean("<p class=a title='say \"hi\"' hidden data-x=1 class=b \"bad=1>x</p>")).toBe('<p class="a" title="say &quot;hi&quot;" hidden data-x="1">x</p>');
  });
});

describe("cleanArtifactHtml: what goes", () => {
  test("script, iframe, object, embed, noscript, template, math … with their content", () => {
    const r = cleanArtifactHtml(
      '<p>a</p><script>alert(1)</script><SCRIPT src="x.js"></SCRIPT><iframe src="https://x"></iframe><object data="x"><p>fallback</p></object><embed src="x"><noscript><img src=x onerror=alert(1)></noscript><template><b>t</b></template><math><mi>x</mi></math><xmp><b></xmp><p>b</p>',
    );
    expect(r.html).toBe("<p>a</p><p>b</p>");
    expect(r.removed.elements).toBe(9);
  });

  test("on* handlers, srcdoc, formaction, ping; <form> goes (its fields stay, as decoration)", () => {
    const r = cleanArtifactHtml('<div onclick="x()" OnMouseOver=y><form action="https://x" method="post"><input placeholder="검색"><button formaction="https://y">b</button></form><a href="https://x" ping="https://t">l</a></div>');
    expect(r.html).toBe('<div><input placeholder="검색"><button>b</button><a href="https://x">l</a></div>');
    expect(r.removed).toEqual({ elements: 1, handlers: 3, remote: 1, links: 0 }); // form; onclick, OnMouseOver, formaction; ping
  });

  test("links keep only https: javascript:, http, mailto, tel, #, relative and others lose the href (entities, case, spaces too)", () => {
    for (const href of ["http://example.com", "mailto:a@b.c", "tel:010", "#top", "//example.com", "https:/x", "javascript:alert(1)", " JaVaScRiPt:x", "java&#x09;script:x", "java&#115;cript:x", "javascript&colon;x", "&#106;avascript:x", "vbscript:x", "data:text/html,<script>x</script>", "file:///etc/passwd", "/relative", "x&unknownentity;y:z"]) {
      const r = cleanArtifactHtml(`<a href="${href}">x</a>`);
      expect([href, r.html]).toEqual([href, "<a>x</a>"]);
      expect(r.removed.links).toBe(1);
    }
    // SVG links follow the same rule
    expect(clean('<svg><a xlink:href="javascript:x"><text>t</text></a></svg>')).toBe("<svg><a><text>t</text></a></svg>");
  });

  test("resources: only data: images; srcset always goes; SVG href only #id (image/feImage may be a data: image)", () => {
    const r = cleanArtifactHtml(
      '<img src="https://x/a.png"><img src="//x/a.png"><img src="/api/attachments/x/raw"><img src="data:text/html,x"><img src="data:image/gif;base64,R0lGOD" srcset="https://x 2x"><video poster="https://x" src="https://x/v.mp4"></video><table background="http://x"></table><input type="image" src="https://x"><svg><image href="https://x/a.png"/><image href="data:image/png;base64,AA"/><use href="https://x/s.svg#a"/><feImage href="https://x"/></svg>',
    );
    expect(r.html).toBe(
      '<img><img><img><img><img src="data:image/gif;base64,R0lGOD"><video></video><table></table><input type="image"><svg><image /><image href="data:image/png;base64,AA" /><use /><feImage /></svg>',
    );
    expect(r.removed.remote).toBe(12);
  });

  test("SVG <set>/<animate> that target an href go, also spelled with entities", () => {
    expect(clean('<svg><a><set attributeName="href" to="javascript:x"/><animate attributeName="xlink:hr&#101;f" values="javascript:x"/><animate attributeName="opacity" values="0;1" dur="1s"/></a></svg>')).toBe(
      '<svg><a><animate attributeName="opacity" values="0;1" dur="1s" /></a></svg>',
    );
  });

  test("comments, CDATA, processing instructions and bogus end tags go", () => {
    // outside SVG, <![CDATA[ is a bogus comment up to the first ">", as in the browser
    expect(clean("<p>a<!-- <script>x</script> -->b<!---->c<![CDATA[x]]><?php x ?></ p>d</>e</p>")).toBe("<p>abcde</p>");
  });

  test("raw-text tricks: </script> inside strings, a self-closing script, an unclosed one, plaintext", () => {
    // the browser ends a script at the first </script, string or not: what follows is markup, then text
    expect(clean('<script>var s="</script><p>shown</p>";</script>')).toBe('<p>shown</p>";');
    expect(clean('<script>var s="</scr"+"ipt>";</script><p>ok</p>')).toBe("<p>ok</p>");
    expect(clean("<script/><p>hidden</p></script><p>shown</p>")).toBe("<p>shown</p>");
    expect(clean("<p>a</p><script>never closed <p>x</p>")).toBe("<p>a</p>");
    expect(clean("<p>a</p><plaintext><p>x</p>")).toBe("<p>a</p>");
  });

  test("mXSS shapes come out inert: quoted markup in attributes is escaped, noscript content is dropped", () => {
    const a = clean('<p title="</p><img src=x onerror=alert(1)>">t</p>');
    expect(a).toBe('<p title="&lt;/p&gt;&lt;img src=x onerror=alert(1)&gt;">t</p>');
    // read as raw text (scripting on): the <img> is real and gets cleaned; noscript itself never reaches the output,
    // so the sandbox (scripting off) can't read it the other way
    const n = cleanArtifactHtml('<noscript><p title="</noscript><img src=x onerror=alert(1)>"></noscript>');
    expect(n.html).toBe('<img>">');
    expect(n.removed).toEqual({ elements: 1, handlers: 1, remote: 1, links: 0 });
    expect(clean('<svg><style><img src=x onerror=alert(1)></style></svg>')).toBe("<svg><style>\\3c img src=x onerror=alert(1)></style></svg>");
    // inside <svg> the browser decodes entities in <style>: a fetch spelled with them is caught, "&" is written back
    expect(clean("<svg><style>a{fill:url&#40;https://x/f.svg#g&#41;}&amp;:hover{opacity:.5}</style></svg><style>b{c:d}&:hover{e:f}</style>")).toBe(
      "<svg><style>a{fill:none}&amp;:hover{opacity:.5}</style></svg><style>b{c:d}&:hover{e:f}</style>",
    );
    expect(clean("<svg><style>a{fill:&weird;}</style><svg/></svg>")).toBe("<svg><svg /></svg>");
    // a tag never closed before the end: dropped, like the browser does
    expect(clean('<p>a</p><img src="x" onerror="y')).toBe("<p>a</p>");
  });

  test("textarea content is text", () => {
    expect(clean("<textarea rows=2><script>x</script></textarea>")).toBe('<textarea rows="2">&lt;script>x&lt;/script></textarea>');
  });

  test("an element dropped with its content can nest; its end tag counts", () => {
    expect(clean("<object><object><p>in</p></object><p>still in</p></object><p>out</p>")).toBe("<p>out</p>");
  });
});

describe("cleanCss", () => {
  const css = (c: string) => cleanCss(c, zero());
  test("remote url(), @import, image-set and src() go; data: images and #refs stay", () => {
    expect(css('a{background:url(https://x/a.png) no-repeat}b{background-image:url("data:image/png;base64,AA")}c{fill:url(#g)}')).toBe(
      'a{background:none no-repeat}b{background-image:url("data:image/png;base64,AA")}c{fill:url(#g)}',
    );
    expect(css('@import url(https://x/a.css);@import "b.css";p{color:red}')).toBe("p{color:red}");
    expect(css('p{background:image-set("https://x/a.png" 1x, url(data:image/png;base64,AA) 2x)}')).toBe("p{background:none}");
    expect(css('p{background:-webkit-image-set(url(data:image/png;base64,AA) 1x)}')).toBe("p{background:-webkit-image-set(url(data:image/png;base64,AA) 1x)}");
    expect(css("p{background:src(var(--u))}q{background:image-set(var(--u) 1x)}")).toBe("p{background:none}q{background:none}");
    expect(css("@font-face{font-family:x;src:url(https://x/f.woff2) format('woff2'),local(Arial)}")).toBe("@font-face{font-family:x;src:none format('woff2'),local(Arial)}");
  });

  test("escapes and comments can't hide a fetch", () => {
    expect(css("a{background:\\75 rl(https://x)}")).toBe("a{background:none}");
    expect(css("a{background:u\\72 l(https://x)}")).toBe("a{background:none}");
    expect(css("\\@import 'x.css';p{}")).toBe("p{}");
    expect(css("a{background:url(/**/https://x)}")).toBe("a{background:none}");
    expect(css("a{background:url(https://x")).toBe("a{background:none");
    expect(css("a{background:\\-webkit-image-set('https://x' 1x)}")).toBe("a{background:none}");
    // other escapes stay as written (digits, ":" and "/" in utility class names, quotes)
    expect(css('.\\31 23{content:"\\201C"}.md\\:flex{display:flex}.w-1\\/2{width:50%}')).toBe('.\\31 23{content:"\\201C"}.md\\:flex{display:flex}.w-1\\/2{width:50%}');
    // an escaped URL is never recognised as safe
    expect(css("a{background:url(data\\3a image/png,AA)}")).toBe("a{background:none}");
  });

  test("legacy script hooks go; nothing can close the <style>", () => {
    expect(css("p{width:expression(alert(1));behavior:url(x.htc);-moz-binding:url(x)}")).toBe("p{width:x-blocked(alert(1));x-blocked:none;x-blocked:none}");
    expect(css("p{}</style><script>x</script>")).toBe("p{}\\3c /style>\\3c script>x\\3c /script>");
  });

  test("style attributes are cleaned too (entities decoded first, as the browser does)", () => {
    expect(clean('<p style="background:url(&quot;https://x&quot;)">a</p>')).toBe('<p style="background:none">a</p>');
    expect(clean('<p style="background:url&lpar;https://x&rpar;">a</p>')).toBe('<p style="background:none">a</p>');
    expect(clean('<p style="color:&weird;">a</p>')).toBe("<p>a</p>");
    expect(clean('<rect filter="url(https://x/f.svg#a)" fill="url(#g)"/>')).toBe('<rect filter="none" fill="url(#g)" />');
    // a title with an unknown entity is just text
    expect(clean('<p title="a &hellip; b">a</p>')).toBe('<p title="a &hellip; b">a</p>');
  });
});

describe("tuneCss: the card's type and contrast floor", () => {
  const run = (css: string) => {
    const t: CssTunes = { fontSize: 0, textColor: 0 };
    return { css: tuneCss(css, t), t };
  };

  test("font sizes under 13px are raised; 13px and up and 0 stay", () => {
    expect(run(".a{font-size:12px}.b{font-size: 11.5px !important}.c{font-size:.75rem}.d{font-size:9pt}").css).toBe(
      ".a{font-size:13px}.b{font-size: 13px !important}.c{font-size:13px}.d{font-size:13px}",
    );
    const keep = ".a{font-size:13px}.b{font-size:0}.c{font-size:0em}.f{font-size:1rem}.g{font-size:10pt}.h{font-size:small}.i{font-size:inherit}";
    expect(run(keep)).toEqual({ css: keep, t: { fontSize: 0, textColor: 0 } });
    expect(run(".a{font-size:12px}.b{FONT-SIZE:12PX}").t.fontSize).toBe(2);
  });

  test("relative sizes and functions get the floor in max() (a .8em th of a 14px table was 11.2px); small keywords become 13px", () => {
    const r = run(
      "th{font-size:.8em}.p{font-size:80%}.v{font-size:var(--s)}.c{font-size:calc(14px - 3px)}.k{font-size:clamp(11px,3vw,14px)}" +
        ".w{font-size:2vw}.big{font-size:1.4em !important}.xs{font-size:x-small}.xxs{font-size:XX-SMALL}.sm{font-size:smaller}.done{font-size:max(13px,.8em)}",
    );
    expect(r.css).toBe(
      "th{font-size:max(13px,.8em)}.p{font-size:max(13px,80%)}.v{font-size:max(13px,var(--s))}.c{font-size:max(13px,calc(14px - 3px))}" +
        ".k{font-size:max(13px,clamp(11px,3vw,14px))}.w{font-size:max(13px,2vw)}.big{font-size:max(13px,1.4em) !important}.xs{font-size:13px}" +
        ".xxs{font-size:13px}.sm{font-size:max(13px,.8333em)}.done{font-size:max(13px,.8em)}",
    );
    // counted only when surely under the floor (.8em, 80%, the keywords), not for functions or units that may be big
    expect(r.t.fontSize).toBe(5);
    expect(run(".a{font:600 .8em/1.4 var(--font)}.b{font:italic 80% var(--font)}.c{font:x-small var(--font)}.d{font:600 1.2em/1.4 var(--font)}").css).toBe(
      ".a{font:600 max(13px,.8em)/1.4 var(--font)}.b{font:italic max(13px,80%) var(--font)}.c{font:13px var(--font)}.d{font:600 max(13px,1.2em)/1.4 var(--font)}",
    );
    expect(run(".a{font-size:constructor}.b{font-size:toString}").css).toBe(".a{font-size:constructor}.b{font-size:toString}");
    // a style attribute too
    expect(cleanArtifactHtml('<th style="font-size:.75em">열</th>').html).toBe('<th style="font-size:max(13px,.75em)">열</th>');
  });

  test("the font shorthand's size is raised; line-height, weight and bigger sizes untouched", () => {
    expect(run(".a{font:600 12px/1.4 var(--font)}").css).toBe(".a{font:600 13px/1.4 var(--font)}");
    expect(run(".a{font: 11px var(--font)}").css).toBe(".a{font: 13px var(--font)}");
    expect(run(".a{font:600 15px/18px var(--font)}").css).toBe(".a{font:600 15px/18px var(--font)}");
  });

  test("only text colours move from --text-3 to --text-2", () => {
    const r = run(
      ".ip{color:var(--text-3)}.n{color: var(--text-3, #999)}.dot{background:var(--text-3)}.r{border-color:var(--text-3)}.s{fill:var(--text-3);stroke:var(--text-3)}.bc{background-color:var(--text-3)}",
    );
    expect(r.css).toBe(
      ".ip{color:var(--text-2)}.n{color: var(--text-2, #999)}.dot{background:var(--text-3)}.r{border-color:var(--text-3)}.s{fill:var(--text-3);stroke:var(--text-3)}.bc{background-color:var(--text-3)}",
    );
    expect(r.t.textColor).toBe(2);
  });

  test("selectors, at-rules and attribute selectors are not taken for declarations", () => {
    const css = "@media (max-width:360px){.a{font-size:12px}}a:hover{color:var(--text-3)}.x[data-k='font-size:1px']{}";
    expect(run(css).css).toBe("@media (max-width:360px){.a{font-size:13px}}a:hover{color:var(--text-2)}.x[data-k='font-size:1px']{}");
  });

  test("cleanArtifactHtml applies it to <style> blocks and style attributes, never inside <svg>, and counts it", () => {
    const { html, tuned } = cleanArtifactHtml(
      '<style>.t{font-size:12px;color:var(--text-3)}</style><p style="font-size:11px">작은 글</p>' +
        '<svg viewBox="0 0 100 40" style="font-size:8px"><style>text{font-size:6px}</style><text style="font-size:7px;fill:var(--text-3)">축</text></svg>',
    );
    expect(html).toBe(
      '<style>.t{font-size:13px;color:var(--text-2)}</style><p style="font-size:13px">작은 글</p>' +
        '<svg viewBox="0 0 100 40" style="font-size:8px"><style>text{font-size:6px}</style><text style="font-size:7px;fill:var(--text-3)">축</text></svg>',
    );
    expect(tuned).toEqual({ fontSize: 2, textColor: 1 });
    // after the <svg> closes, tuning applies again
    expect(cleanArtifactHtml('<svg></svg><p style="font-size:10px">x</p>').tuned.fontSize).toBe(1);
  });

  test("it cannot bring back what cleaning removed", () => {
    const { html } = cleanArtifactHtml('<style>.a{font-size:12px;background:url(https://evil.example/x.png)}</style>');
    expect(html).toBe("<style>.a{font-size:13px;background:none}</style>");
  });
});

describe("htmlText / htmlPreview (@pickle/protocol)", () => {
  test("text only, a line per block: no style or script, tags out, entities decoded, whitespace folded", () => {
    expect(htmlText('<style>p{color:red}</style><h1>갤러리</h1><p>조회&nbsp;1,204 &amp;   추천<br>32</p><script>x</script>')).toBe("갤러리\n조회 1,204 & 추천\n32");
    expect(htmlText("<p>a&hellip;b &#x1F600; &#55296; &weird; &amp c</p><li>d</li><li>e</li>")).toBe("a…b 😀 & c\nd\ne");
  });
  test("touching inline elements get a space; text right after a closing tag stays joined", () => {
    expect(htmlText("<p><b>64</b><span>개추</span> <b>3</b>개 <i>댓글</i><a>[12]</a></p>")).toBe("64 개추 3개 댓글 [12]");
  });
  test("preview: lines joined with ' · ', a first line that repeats the title goes, long text is cut at a word", () => {
    expect(htmlPreview("<h1>주간 일정</h1><p>월 10:00 회의</p><p>화 14:00 치과</p>", "주간 일정")).toBe("월 10:00 회의 · 화 14:00 치과");
    expect(htmlPreview("<h1>주간 일정 (11/16~22)</h1><p>본문</p>", "주간 일정")).toBe("(11/16~22) · 본문");
    expect(htmlPreview("<h1>다른 제목</h1><p>본문</p>", "주간 일정")).toBe("다른 제목 · 본문");
    const p = htmlPreview(`<p>${"가나다라 ".repeat(60)}</p>`);
    expect(p.length).toBeLessThanOrEqual(140);
    expect(p.endsWith("가나다라…")).toBe(true);
  });

  test("preview skips tabs and navigation (nav, tablist, tab/nav/menu/filter/chip classes, 4+ very short items)", () => {
    const post = "<p>러스트 처음 배우는데 책 하나만 추천해 줘. 파이썬만 3년 했어요.</p>";
    expect(htmlPreview(`<h2>프로그래밍 갤러리</h2><ul class="tabs"><li class="on">전체글</li><li>개념글</li><li>공지</li></ul>${post}`)).toBe(
      "프로그래밍 갤러리 · 러스트 처음 배우는데 책 하나만 추천해 줘. 파이썬만 3년 했어요.",
    );
    expect(htmlPreview(`<nav><a href="https://a.example">홈</a> <a href="https://b.example">글쓰기</a></nav>${post}`)).toBe("러스트 처음 배우는데 책 하나만 추천해 줘. 파이썬만 3년 했어요.");
    expect(htmlPreview(`<div role="tablist"><span>전체</span><span>인기</span></div>${post}`)).toBe("러스트 처음 배우는데 책 하나만 추천해 줘. 파이썬만 3년 했어요.");
    expect(htmlPreview(`<div class="chips"><span>모두</span><span>14형</span></div>${post}`)).toBe("러스트 처음 배우는데 책 하나만 추천해 줘. 파이썬만 3년 했어요.");
    expect(htmlPreview(`<ul><li>전체</li><li>개념글</li><li>공지</li><li>인기</li></ul>${post}`)).toBe("러스트 처음 배우는데 책 하나만 추천해 줘. 파이썬만 3년 했어요.");
    // a list of longer items is content, and so is a short list when the card is little else
    expect(htmlPreview(`<ul><li>월 10:00 팀 주간 회의</li><li>수 19:30 치과 정기 검진</li><li>금 19:00 저녁</li><li>토 결혼식</li></ul>`)).toBe(
      "월 10:00 팀 주간 회의 · 수 19:30 치과 정기 검진 · 금 19:00 저녁 · 토 결혼식",
    );
    expect(htmlPreview(`<h2>2호선</h2><ul><li>시청</li><li>을지로입구</li><li>을지로3가</li><li>을지로4가</li></ul>`, "2호선")).toBe(
      "시청 · 을지로입구 · 을지로3가 · 을지로4가",
    );
  });
});

test("the size limit is 150 KB", () => {
  expect(MAX_ARTIFACT_HTML_BYTES).toBe(150 * 1024);
});

describe("history replay of html artifact calls", () => {
  const call = (id: string, kind: string, content: string): LlmMessage[] => [
    { role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name: "sys_create_artifact", arguments: JSON.stringify({ title: `화면 ${id}`, kind, content }) } }] },
    { role: "tool", tool_call_id: id, content: JSON.stringify({ ok: true, summary: "만들었어요", data: { artifactId: `a_${id}` } }) },
    { role: "assistant", content: "만들었어요." },
  ];
  const args = (m: LlmMessage) => JSON.parse((m as { tool_calls: { function: { arguments: string } }[] }).tool_calls[0]!.function.arguments);
  const small = `<style>p{color:red}</style><p>${"가".repeat(1000)}</p>`; // ~3 KB
  const large = `<p>${"가".repeat(6000)}</p>`; // ~18 KB

  test("older html is replaced by its size; the last turn's stays whole when small; other kinds untouched", () => {
    const msgs: LlmMessage[] = [
      { role: "user", content: "스레드 만들어줘" },
      ...call("c1", "html", small),
      { role: "user", content: "문서로도" },
      ...call("c2", "document", "# 문서"),
      { role: "user", content: "일정 카드" },
      ...call("c3", "html", small),
    ];
    const out = compactHtmlCalls(sanitizeHistory(msgs));
    expect(args(out[1]!)).toEqual({ title: "화면 c1", kind: "html", content: "(HTML 3KB, 보관함에 있어요 — 여기선 생략)" });
    expect(args(out[5]!).content).toBe("# 문서");
    expect(args(out[9]!).content).toBe(small);
    expect(out[10]).toEqual(msgs[10]!); // the tool result is untouched
  });

  test("a design-guide result stays whole in the last turn (a follow-up card has it) and is replaced in older turns", () => {
    const guide = JSON.stringify({ ok: true, summary: "화면 가이드를 확인했어요", data: { guide: "THE CARD ".repeat(600) } });
    const guideTurn = (id: string, content: string): LlmMessage[] => [
      { role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name: "sys_create_artifact", arguments: JSON.stringify({ title: "일정", kind: "html", content }) } }] },
      { role: "tool", tool_call_id: id, content: guide },
    ];
    const msgs: LlmMessage[] = [
      { role: "user", content: "일정 카드" },
      ...guideTurn("g1", ""),
      ...call("c1", "html", small),
      { role: "user", content: "결혼식 추가해서 다시" },
      ...guideTurn("g2", "placeholder"), // a stand-in word is a guide call too
      ...call("c2", "html", small),
    ];
    const out = compactHtmlCalls(sanitizeHistory(msgs));
    expect(out[2]).toEqual({ role: "tool", tool_call_id: "g1", content: HTML_GUIDE_REPLAY }); // older turn: replaced
    expect(args(out[1]!)).toEqual({ title: "일정", kind: "html", content: "" }); // the call itself kept
    expect(args(out[3]!).content).toBe("(HTML 3KB, 보관함에 있어요 — 여기선 생략)");
    expect(out[8]).toEqual(msgs[8]!); // last turn: the guide stays whole
    expect(args(out[9]!).content).toBe(small); // and so does its small fragment
    expect(Buffer.byteLength(HTML_GUIDE_REPLAY)).toBeLessThan(200);
  });

  test("the last turn's html is replaced too when big, so the replay window keeps the conversation", () => {
    const msgs: LlmMessage[] = [{ role: "user", content: "이전 대화" }, { role: "assistant", content: "네" }, { role: "user", content: "비교표" }, ...call("c1", "html", large)];
    const out = trimHistory(compactHtmlCalls(sanitizeHistory(msgs)));
    expect(out).toHaveLength(msgs.length);
    expect(args(out[3]!).content).toBe("(HTML 18KB, 보관함에 있어요 — 여기선 생략)");
    expect(Buffer.byteLength(JSON.stringify(out))).toBeLessThan(2000);
  });
});
