/** The deck generator's JSON checks and F-A HTML (DD 1935 §5, DD 0059 §6, DD 0103-b F): the three samples, synthetic. */
import { describe, expect, test } from "bun:test";
import { DISCLAIMER, DISCLAIMER_PLAYBOOK, textW } from "@pickle/quant";
import { chars, fill, figureText, FONT_LICENCE, kstStamp, lintModelText, LOCAL_FONT_SRC, methodBars, renderDeck, validateDeck, type DeckFail, type DeckSpec, type Slide } from "../src/deck";
import { deckFixture, FIXTURE_AS_OF } from "./deck-fixtures";

const rules = (f: DeckFail[]) => f.map((x) => x.rule);
const pages = (html: string) => [...html.matchAll(/<section class="page" data-n="(\d+)" data-kind="([a-z0-9+-]+)">([\s\S]*?)<\/section>/g)].map((m) => ({ n: Number(m[1]), kind: m[2]!, html: m[3]! }));
const textOf = (h: string) => h.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
const footLeft = (h: string) => textOf(h.match(/<span class="l" data-role="foot-left">([\s\S]*?)<\/span>/)![1]!);
/** a sample with one slide changed */
const withSlide = (n: number, change: (s: Slide) => Slide, kind: "a" | "b" | "c" = "a") => {
  const { spec, data } = deckFixture(kind);
  spec.slides[n - 1] = change(structuredClone(spec.slides[n - 1]!));
  return { spec, data };
};

describe("the three samples (DD 0059 §6-1)", () => {
  test("each passes every JSON check: 28 slides, 17 kinds, hero first, disclaimer last", () => {
    for (const k of ["a", "b", "c"] as const) {
      const { spec, data } = deckFixture(k);
      expect(validateDeck(spec, data)).toEqual([]);
      expect(spec.slides.length).toBe(28);
      expect(new Set(spec.slides.map((s) => s.kind)).size).toBe(17);
    }
  });
  test("(b) the missing capture is left out of its page, three remain; three indicators are 확인 불가", () => {
    const { spec, data } = deckFixture("b");
    const html = renderDeck(spec, data);
    expect(html.match(/data-viz="capture"/g)!.length).toBe(3);
    const p4 = pages(html)[3]!;
    expect(p4.html.match(/data-capture=/g)!.length).toBe(1);
    expect(data.core11!.items.filter((i) => i.signal === "unknown").length).toBe(3);
    expect(textOf(pages(html)[8]!.html)).toContain("확인 불가");
  });
  test("(c) the stage move is the signal board's one highlighted line", () => {
    const { spec, data } = deckFixture("c");
    const p3 = pages(renderDeck(spec, data))[2]!;
    expect(p3.html.match(/<mark class="hl">/g)!.length).toBe(1);
    expect(p3.html).toContain('<mark class="hl">탈출 2단계 → 3단계</mark>');
    expect(textOf(p3.html)).toContain("3단계 방어 준비");
  });
});

describe("what the model may not write (FA4 #6, #9, #10; DD 1935 §0-6)", () => {
  test("a number of its own is refused; dates, times, tenors, names and references are not", () => {
    expect(lintModelText("하이일드가 3.76%로 올랐어요")[0]!.rule).toBe("FA4-9");
    expect(lintModelText("확인 불가 지표가 3개예요")[0]!.rule).toBe("FA4-9");
    expect(lintModelText("11/27에 발표해요")[0]!.rule).toBe("FA4-9");
    for (const ok of ["11월 27일 08:00 발표", "미 10년물과 20거래일", "MA20과 HBM3E", "S&P 500과 나스닥 100", "1차 익절", "3분기 실적", "D-1 알림", "하이일드가 {hy}로 올랐어요", "2026년 전망"])
      expect(lintModelText(ok)).toEqual([]);
  });
  test("emoji, exclamation marks, the adverbs, the hype words and advice are refused", () => {
    expect(rules(lintModelText("오늘은 🚀 올라요").map((f) => ({ ...f })))).toContain("FA4-10");
    expect(rules(lintModelText("올랐어요!"))).toEqual(["FA4-10"]);
    expect(rules(lintModelText("매우 좋아요"))).toEqual(["FA4-10"]);
    expect(rules(lintModelText("혁신적인 변화예요"))).toEqual(["FA4-6"]);
    expect(rules(lintModelText("지금 사세요"))).toEqual(["copy"]);
  });
  test("a slide's text over its limit, a missing reference and a number go back with the field named", () => {
    const { spec, data } = withSlide(2, (s) => ({ ...s, headline: "가".repeat(31), kicker: "숫자 {nope}" }));
    const f = validateDeck(spec, data);
    expect(f).toContainEqual({ n: 2, kind: "numbers3", rule: "limit", what: "headline는 30자까지예요(지금 31자)" });
    expect(f).toContainEqual({ n: 2, kind: "numbers3", rule: "schema", what: "kicker: 없는 데이터 id {nope}" });
    const g = validateDeck(...(Object.values(withSlide(3, (s) => ({ ...s, note: "탈출 조건이 3개 켜졌어요" }))) as [DeckSpec, never]));
    expect(g.map((x) => [x.n, x.rule])).toContainEqual([3, "FA4-9"]);
  });
  test("limits count graphemes, not UTF-16 units: decomposed Hangul and joined emoji are one each", () => {
    expect(chars("가".normalize("NFD"))).toBe(1);
    expect("가".normalize("NFD").length).toBe(2);
    expect(chars("👨‍👩‍👧")).toBe(1);
    // a headline of 30 decomposed syllables (60 UTF-16 units) is within its 30; 31 is not
    const at30 = withSlide(2, (s) => ({ ...s, headline: "가".normalize("NFD").repeat(30) }));
    expect(validateDeck(at30.spec, at30.data)).toEqual([]);
    const at31 = withSlide(2, (s) => ({ ...s, headline: "가".normalize("NFD").repeat(31) }));
    expect(validateDeck(at31.spec, at31.data).map((x) => x.what)).toEqual(["headline는 30자까지예요(지금 31자)"]);
  });
  test("limits count what is read: a reference counts as its formatted figure", () => {
    // 2 + "3.76%" (5) + 21 = 28 characters: under 30
    const { spec, data } = withSlide(2, (s) => ({ ...s, headline: "지금{hy}" + "가".repeat(21) }));
    expect(validateDeck(spec, data)).toEqual([]);
    const over = withSlide(2, (s) => ({ ...s, headline: "지금{hy}" + "가".repeat(24) }));
    expect(rules(validateDeck(over.spec, over.data))).toEqual(["limit"]);
  });
  test("three sentences over 40 characters on one slide is a text wall (FA4 #1)", () => {
    const long = "하이일드 스프레드가 넓어지는 동안 회사채 발행도 함께 줄어들었다는 보도가 이어졌어요";
    const { spec, data } = withSlide(4, (s) => (s.kind === "issue+capture" ? { ...s, points: s.points.map((p) => ({ ...p, text: long })) } : s));
    expect(rules(validateDeck(spec, data))).toContain("FA4-1");
  });
});

describe("the deck's shape (FA4 #7, #12; B-2; FA7)", () => {
  test("24 and 30 slides pass the count, 23 and 31 do not", () => {
    const { spec, data } = deckFixture("a");
    const pages = (fs: DeckFail[]) => fs.filter((x) => x.rule === "B2-pages").map((x) => x.what);
    // copies put between the others, never three of a kind in a row
    const grow = (k: number) => {
      const out = [...spec.slides];
      for (let i = 0; i < k; i++) out.splice(4 + i * 5, 0, spec.slides[[7, 1, 12, 20, 15][i]!]!);
      return out;
    };
    expect(pages(validateDeck({ ...spec, slides: grow(2) }, data))).toEqual([]);
    expect(pages(validateDeck({ ...spec, slides: grow(3) }, data))).toEqual(["장 수는 24–30장이에요(지금 31장)"]);
    const cut = spec.slides.filter((_, i) => ![9, 13, 19, 21].includes(i));
    expect(cut.length).toBe(24);
    expect(pages(validateDeck({ ...spec, slides: cut }, data))).toEqual([]);
    expect(pages(validateDeck({ ...spec, slides: cut.filter((_, i) => i !== 6) }, data))).toEqual(["장 수는 24–30장이에요(지금 23장)"]);
  });
  test("slide count 24–30, hero first, disclaimer last and once, numbers3 in the first three", () => {
    const { spec, data } = deckFixture("a");
    expect(rules(validateDeck({ ...spec, slides: spec.slides.slice(0, 22).concat(spec.slides.slice(-1)) }, data))).toContain("B2-pages");
    expect(rules(validateDeck({ ...spec, slides: [spec.slides[1]!, spec.slides[0]!, ...spec.slides.slice(2)] }, data))).toContain("B2-order");
    expect(rules(validateDeck({ ...spec, slides: spec.slides.slice(0, -1).concat(spec.slides[25]!) }, data))).toContain("B2-disclaimer");
    // once, but not last
    const swapped = [...spec.slides.slice(0, 26), spec.slides[27]!, spec.slides[26]!];
    expect(validateDeck({ ...spec, slides: swapped }, data).filter((x) => x.rule === "B2-disclaimer").map((x) => x.what)).toEqual(["마지막 장은 disclaimer예요"]);
    const moved = [spec.slides[0]!, spec.slides[2]!, spec.slides[3]!, spec.slides[1]!, ...spec.slides.slice(4)];
    expect(rules(validateDeck({ ...spec, slides: moved }, data))).toContain("FA4-12");
  });
  test("the same kind three times running is refused, appendix excepted; one kind over a quarter is refused", () => {
    const { spec, data } = deckFixture("a");
    const three = [...spec.slides];
    three.splice(19, 1, spec.slides[18]!); // level-chart ×3 at 18–20
    const f = validateDeck({ ...spec, slides: three }, data);
    expect(f).toContainEqual({ n: 20, kind: "level-chart", rule: "FA4-7", what: "같은 kind level-chart가 3장 연속이에요(2장까지)" });
    const apx = [...spec.slides];
    apx.splice(26, 1, spec.slides[25]!); // appendix ×3 at 25–27, sources gone
    expect(validateDeck({ ...spec, slides: apx }, data).filter((x) => x.rule === "FA4-7")).toEqual([]);
    const tables = spec.slides.map((s, i) => (i >= 3 && i <= 20 && i % 3 === 0 ? spec.slides[7]! : s));
    expect(rules(validateDeck({ ...spec, slides: tables }, data))).toContain("FA4-7");
  });
  test("appendix and sources over a quarter of the deck are refused (FA4 #12)", () => {
    const { spec, data } = deckFixture("a");
    // 2 appendix + 1 sources + 5 more = 8 of 28
    const back = spec.slides.map((s, i) => ([5, 9, 13, 19, 23].includes(i) ? spec.slides[26]! : s));
    expect(validateDeck({ ...spec, slides: back }, data).some((x) => x.rule === "FA4-12" && x.what.includes("25%"))).toBe(true);
  });
  test("fewer than three captures, a level chart without its five levels, no risks page", () => {
    const b = deckFixture("b");
    delete b.data.captures["cap-post"];
    expect(rules(validateDeck(b.spec, b.data))).toContain("B2-captures");
    const a = deckFixture("a");
    a.data.charts!.SOXL!.input = { ...a.data.charts!.SOXL!.input, levels: a.data.charts!.SOXL!.input.levels.filter((l) => l.kind !== "support") };
    expect(validateDeck(a.spec, a.data)).toContainEqual({ n: 18, kind: "level-chart", rule: "B2-levels", what: "레벨 차트에 support이 없어요" });
    const r = withSlide(23, (s) => (s.kind === "risks" ? { ...s, items: s.items.slice(0, 2) } : s));
    expect(rules(validateDeck(r.spec, r.data))).toContain("B2-risks");
  });
  test("a table of seven rows goes to the appendix (FA7); an appendix holds ten", () => {
    const t = withSlide(8, (s) => (s.kind === "table" ? { ...s, rows: [...s.rows, s.rows[0]!] } : s));
    expect(validateDeck(t.spec, t.data)).toContainEqual({ n: 8, kind: "table", rule: "FA7", what: "rows는 6행까지예요(지금 7행), 넘으면 appendix로 보내요" });
    const a = withSlide(25, (s) => (s.kind === "appendix" ? { ...s, rows: [...s.rows, s.rows[0]!, s.rows[1]!] } : s));
    expect(rules(validateDeck(a.spec, a.data))).toContain("schema");
  });
  test("sections: four to eight, eight characters, the slide's section among them; timeline events eight at most", () => {
    const { spec, data } = deckFixture("a");
    expect(validateDeck({ ...spec, sections: spec.sections.slice(0, 3) }, data).map((x) => x.what)).toContain("sections는 4–8개예요(지금 3개)");
    expect(validateDeck({ ...spec, sections: [...spec.sections, "기타"] }, data).map((x) => x.what)).toContain("sections는 4–8개예요(지금 9개)");
    // a tab row just over the page (1152 < w < 1300) is refused; eight names of eight characters are far over
    const wide = ["가나다라마바사아", "자차카타파하가나", "다라마바사아자차", "카타파하가나다라", "마바사아자차카타", "파하가나다라마바", "사아자차카타파하", "가다라마바사아자"];
    const near = ["가나다라마바사", "자차카타파하가", "나다라마바사아", "자차카타파하가", "나다라마바사아", "자차카타파하가", "나다라마", "바사아자차"];
    const nearW = near.reduce((x, n) => x + textW(n, 19), 0) + 7 * 28;
    expect(nearW).toBeGreaterThan(1152);
    expect(nearW).toBeLessThan(1300);
    expect(validateDeck({ ...spec, sections: near }, data)).toContainEqual({ rule: "limit", what: "탭 줄이 1152px보다 넓어요(섹션 이름을 줄여요)" });
    const w = validateDeck({ ...spec, sections: wide }, data);
    expect(w).toContainEqual({ rule: "limit", what: "탭 줄이 1152px보다 넓어요(섹션 이름을 줄여요)" });
    expect(validateDeck(spec, data).map((x) => x.what)).not.toContain("탭 줄이 1152px보다 넓어요(섹션 이름을 줄여요)");
    expect(rules(validateDeck({ ...spec, sections: ["아주아주긴섹션이름", ...spec.sections.slice(1)] }, data))).toContain("limit");
    data.events!.list.push(data.events!.list[0]!);
    expect(validateDeck(spec, data).some((x) => x.kind === "timeline" && x.what.includes("9개"))).toBe(true);
  });
  test("a disputed figure named only inside a sentence is refused until a slot shows both values (B-2)", () => {
    const { spec, data } = deckFixture("a");
    expect(data.figures.ust10y!.conflict).toBeDefined();
    const slides = spec.slides.map((s) => {
      if (s.kind === "numbers3") return { ...s, items: s.items.map((it) => (it.ref === "ust10y" ? { ...it, ref: "vix" } : it)) };
      if (s.kind === "table" || s.kind === "appendix") return { ...s, rows: s.rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v === "{ust10y}" ? "{vix}" : v]))) };
      if (s.kind === "risks") return { ...s, items: s.items.map((it) => (it.ref === "ust10y" ? { ...it, ref: "vix" } : it)) };
      return s;
    });
    slides[1] = { ...slides[1]!, kicker: "금리 {ust10y}" };
    expect(rules(validateDeck({ ...spec, slides }, data))).toEqual(["B2-conflict"]);
  });
});

describe("figures (§0-5) and references", () => {
  test("formats: U+2212, grouping, %p, 확인 불가 for null, 약 …(추정), ±, units", () => {
    const { data } = deckFixture("b");
    const f = data.figures;
    expect(figureText(f.kospi_chg!)).toBe("−0.35%");
    expect(figureText(f.foreign_kospi!)).toBe("−8,130억원");
    expect(figureText(f.us2y_spread!)).toBe("+0.12%p");
    expect(figureText(f.core_cpi!)).toBe("확인 불가");
    expect(figureText(f.asp_decline!)).toBe("약 −14.0%(추정)");
    expect(figureText(f.amp_b!)).toBe("약 ±2.5%(추정)");
    expect(figureText(f.usdkrw!)).toBe("1,398원");
  });
  test("fill: each reference becomes its figure in a span, a server phrase too; an unknown id is kept and named", () => {
    const { data } = deckFixture("a");
    const r = fill("하이일드 {hy}, 탈출 {escape_label}, {nope} <b>", data.figures, data.words);
    expect(r.plain).toBe("하이일드 3.76%, 탈출 2단계 경계, {nope} <b>");
    expect(r.html).toContain('<span class="fig" data-ref="hy">3.76%</span>');
    expect(r.html).toContain("&lt;b&gt;");
    expect(r.missing).toEqual(["nope"]);
    expect(r.refs).toEqual(["hy", "escape_label"]);
    expect(fill("<i>{hy}", data.figures).html).toBe('&lt;i&gt;<span class="fig" data-ref="hy">3.76%</span>');
  });
});

describe("the F-A pages (DD 1935 §5-1, §5-2)", () => {
  const { spec, data } = deckFixture("a");
  const html = renderDeck(spec, data);
  const ps = pages(html);
  test("one 1280 × 720 page per slide in order, each with its number of the total", () => {
    expect(ps.map((p) => p.n)).toEqual(Array.from({ length: 28 }, (_, i) => i + 1));
    expect(ps.map((p) => p.kind)).toEqual(spec.slides.map((s) => s.kind));
    for (const p of ps) expect(p.html).toContain(`<span class="r" data-role="page-no">${p.n} / 28</span>`);
    expect(html).toContain("@page{size:1280px 720px;margin:0}");
    expect(html).toContain(".page{position:relative;width:1280px;height:720px;overflow:hidden;break-after:page");
  });
  test("tabs on every page but the cover and the disclaimer, the slide's section lit", () => {
    for (const [i, p] of ps.entries()) {
      const s = spec.slides[i]!;
      if (s.kind === "hero" || s.kind === "disclaimer") expect(p.html).not.toContain('class="tabs"');
      else {
        expect(p.html.match(/<span class="on">([^<]+)<\/span>/)![1]).toBe(s.section!);
        expect(p.html.match(/<span[^>]*>[^<]+<\/span>/g)!.filter((x) => !x.includes("data-role")).length).toBeGreaterThanOrEqual(spec.sections.length);
      }
    }
  });
  test("each footer names its page's sources and the as of; the last carries the font licence instead, once", () => {
    expect(footLeft(ps[1]!.html)).toBe("출처: FRED, CBOE · 기준 2026-11-27 08:00 KST");
    expect(footLeft(ps[26]!.html)).toBe("기준 2026-11-27 08:00 KST");
    // DD 0103-b F, word for word
    expect(FONT_LICENCE).toBe("글꼴 Noto Sans KR · SIL OFL 1.1");
    expect(footLeft(ps[27]!.html)).toBe(FONT_LICENCE);
    expect(html.split(FONT_LICENCE).length - 1).toBe(1);
    for (const p of ps.slice(0, -1)) expect(footLeft(p.html).endsWith(`기준 ${kstStamp(FIXTURE_AS_OF)}`)).toBe(true);
  });
  test("a footer too wide for its sources keeps the first ones and says how many more: 외 n곳", () => {
    const x = deckFixture("a");
    for (const [id, src] of Object.entries(x.data.sources)) x.data.sources[id] = { ...src, name: `${src.name} 아주 긴 출처 이름이에요` };
    const p3 = footLeft(pages(renderDeck(x.spec, x.data))[2]!.html);
    const m = /^출처: (.+) 외 (\d+)곳 · 기준 2026-11-27 08:00 KST$/.exec(p3);
    expect(m).not.toBeNull();
    // five sources on the page: those named plus those counted
    expect(m![1]!.split(", ").length + Number(m![2])).toBe(5);
    expect(textW(p3, 14)).toBeLessThanOrEqual(1152 - 120);
    // with the short names every source is named
    expect(footLeft(ps[2]!.html)).toBe("출처: FRED, CBOE, BLS, KRX, 판정 규칙 · 기준 2026-11-27 08:00 KST");
  });
  test("the disclaimer word for word on the last page, the playbook sentence only when asked", () => {
    const last = ps[27]!.html;
    expect(last).toContain(`<p data-role="disclaimer">${DISCLAIMER}</p>`);
    expect(last).not.toContain(DISCLAIMER_PLAYBOOK);
    const pb = deckFixture("a");
    pb.spec.slides[27] = { ...pb.spec.slides[27]!, kind: "disclaimer", playbook: true } as Slide;
    expect(pages(renderDeck(pb.spec, pb.data))[27]!.html).toContain(`<p data-role="disclaimer-playbook">${DISCLAIMER_PLAYBOOK}</p>`);
    expect(textOf(last)).toContain("생성 2026-11-27 08:12 KST · 데이터 기준 2026-11-27 08:00 KST");
  });
  test("numbers come from the data: big figures, a disputed one with the other source's value beside it", () => {
    const p2 = ps[1]!.html;
    expect(p2).toContain('<div class="num">3.76%</div>');
    expect(textOf(p2)).toContain("FRED · A · 11-25 기준");
    expect(textOf(p2)).toContain("FRED · A · 11-26 기준 · 다른 출처 4.51% · 합성 매체");
    expect(textOf(ps[22]!.html)).toContain("임계 5.0% · 지금 4.53%다른 출처 4.51% · 합성 매체");
  });
  test("the cover: the highlight inside the hand-drawn ring, the as of at the bottom; no tabs", () => {
    const p1 = ps[0]!.html;
    expect(p1).toContain('<span class="ring" data-viz="hand-mark"><mark class="hl">경계가 이어지고</mark></span>');
    expect(textOf(p1)).toContain("데이터 기준 2026-11-27 08:00 KST");
    // the particle after the highlight stays on its line
    const c = deckFixture("c");
    expect(pages(renderDeck(c.spec, c.data))[0]!.html).toContain('<span class="tie"><span class="ring" data-viz="hand-mark"><mark class="hl">방어를 준비할 때</mark></span>예요</span>');
  });
  test("charts are the quant renderers with their captions; the appendix names each row's source", () => {
    expect(ps[8]!.html).toContain('aria-label="11지표: 위험 3 · 경계 3 · 정상 4 · 확인 불가 1"');
    expect(ps[15]!.html).toContain("단위 억원 · 11월 26일 기준 · KRX · 합성");
    expect(ps[17]!.html).toContain("단위 달러 · 11월 26일 종가 · 토스증권 · 합성");
    expect(ps[17]!.html).toContain('data-viz="level-chart"');
    expect(ps[21]!.html).toContain("11월 26일 08:00 기준 · 각 기관 일정 · 합성");
    expect(ps[24]!.html).toContain('<td class="t-table src">FRED · A</td>');
    expect(ps[12]!.html).toContain("단위 % · 11월 26일 종가 · 합성 IR · 모시 계산");
  });
  test("the scenario probability only where a model gives one (E4-3)", () => {
    expect(ps[20]!.html.match(/class="prob"/g)!.length).toBe(3);
    const b = deckFixture("b");
    expect(pages(renderDeck(b.spec, b.data))[20]!.html).not.toContain('class="prob"');
  });
  test("the model's words are escaped; the font is only local() unless the PDF pass gives a file", () => {
    const x = deckFixture("a");
    x.spec.slides[1] = { ...x.spec.slides[1]!, kicker: "<script>x</script>" };
    const h = renderDeck(x.spec, x.data);
    expect(h).not.toContain("<script>");
    expect(h).toContain("&lt;script&gt;x&lt;/script&gt;");
    expect(html).toContain(`src:${LOCAL_FONT_SRC}`);
    expect(html).not.toContain("file://");
    expect(renderDeck(spec, data, { fontSrc: 'url("file:///f.ttf") format("truetype")' })).toContain('src:url("file:///f.ttf") format("truetype")');
  });
  test("methodBars: a bar, a label and a value per method, the zero line, the caption", () => {
    const svg = methodBars(
      [
        { name: "가", value: -3 },
        { name: "나", value: 2 },
      ],
      { width: 600, height: 300, unit: "%", digits: 1, caption: "단위 % · 기준 · 출처" },
    );
    expect(svg.match(/data-role="bar"/g)!.length).toBe(2);
    expect(svg.match(/data-role="value"/g)!.length).toBe(2);
    expect(svg).toContain(">−3.0</text>");
    expect(svg).toContain('data-role="zero"');
    expect(svg).toContain(">단위 % · 기준 · 출처</text>");
  });
});
