/** The deck generator's JSON checks and F-A HTML (DD 1935 §5, DD 0059 §6, DD 0103-b F): the three samples, synthetic. */
import { describe, expect, test } from "bun:test";
import { DISCLAIMER, DISCLAIMER_PLAYBOOK, textW } from "@pickle/quant";
import { inflateSync } from "node:zlib";
import { chars, deckCss, fill, figureText, FONT_LICENCE, kstStamp, lintModelText, LOCAL_FONT_SRC, methodBars, renderDeck, validateDeck, type DeckFail, type DeckSpec, type Slide } from "../src/deck";
import { ESCAPE_A_RULES, ESCAPE_D_RULES, RECOVERY_RULES, type Grid11Item, type Tri } from "@pickle/quant";
import { deckStages, noteIdsFor } from "../src/deck/stages";
import { nextLineHtml, valuePieces } from "../src/deck/render";
import { narrowDots } from "../src/deck/text";
import { noteNames } from "../src/deck/validate";
import { escapeHead, gaugesOf, nextLines, recoveryHead, type Assessed, type InputKey, type Missing } from "../src/invest/stages";
import { assessedOf, deckFixture, FIXTURE_AS_OF, synthCapture } from "./deck-fixtures";

const rules = (f: DeckFail[]) => f.map((x) => x.rule);
/** a page's markup without narrowDots' wrappers, as the tests before DD 1704 5 read it (the wrappers have their own test) */
const undot = (h: string) =>
  h
    .replace(/<span class="dot">·<\/span>/g, "·")
    .replace(/<span class="nw">([^<]*)<\/span>/g, "$1")
    .replace(/<tspan class="dot" dx="-0.14em">·<\/tspan>/g, "·")
    .replace(/<tspan dx="-0.14em">([^<]*)<\/tspan>/g, "$1");
const pages = (html: string) => [...html.matchAll(/<section class="page" data-n="(\d+)" data-kind="([a-z0-9+-]+)">([\s\S]*?)<\/section>/g)].map((m) => ({ n: Number(m[1]), kind: m[2]!, html: undot(m[3]!) }));
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
  test("the conditions card says each thing once: the server's next, a note about what is not on (DD 1509 5)", () => {
    for (const k of ["a", "b", "c"] as const) {
      const { spec, data } = deckFixture(k);
      const g = spec.slides.find((x) => x.kind === "gauges" && x.focus === "escape") as Extract<Slide, { kind: "gauges" }>;
      const rows = [...data.stages!.conditions.escape, ...data.stages!.conditions.severe];
      // the note names only conditions not met yet, and nothing the next already says
      const named = g.note!.match(/[AD]\d/g) ?? [];
      expect(named.length).toBeGreaterThan(0);
      for (const id of named) expect(rows.find((r) => r.id === id)!.status).not.toBe("met");
      expect(data.stages!.next.escape).not.toContain("자료 없음");
      expect(g.note).not.toContain("자료 없음");
      // the kicker is not the headline's opening words
      expect(g.headline.startsWith(g.kicker!.split(" ")[0]!)).toBe(false);
    }
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
    // a stage put as a time to act is advice too (A17; DD 1509 6)
    expect(rules(lintModelText("방어를 준비할 때예요"))).toEqual(["copy"]);
    expect(rules(lintModelText("정리할 때입니다"))).toEqual(["copy"]);
    expect(rules(lintModelText("방어 준비 단계예요"))).toEqual([]);
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
    // 2 + "3.76%p" (6) + 22 = 30 characters: at the limit; one more is over
    const { spec, data } = withSlide(2, (s) => ({ ...s, headline: "지금{hy}" + "가".repeat(22) }));
    expect(validateDeck(spec, data)).toEqual([]);
    const over = withSlide(2, (s) => ({ ...s, headline: "지금{hy}" + "가".repeat(23) }));
    expect(validateDeck(over.spec, over.data).map((x) => x.what)).toEqual(["headline는 30자까지예요(지금 31자)"]);
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
    // a spread's level: %p, no sign of its own (DD 1520); a negative one keeps U+2212
    expect(figureText(f.hy!)).toBe("3.76%p");
    expect(figureText(f.hy_th!)).toBe("3.5%p");
    expect(figureText({ ...f.hy!, value: -0.25 })).toBe("−0.25%p");
    // the stage conditions on the spread say its level the same way: A1, D1, R2 (DD 1520; agent-runtime 1534 §2)
    for (const k of ["a", "c"] as const) {
      const d = deckFixture(k).data;
      const hy = figureText(d.figures.hy!);
      const c = d.stages!.conditions;
      const rows = [...c.escape, ...c.severe, ...c.recovery];
      const val = (id: string) => rows.find((r) => r.id === id)!.value;
      expect(val("A1")).toBe(`${hy} · 6개월 최저보다 ${k === "c" ? "+0.77%p" : "+0.41%p"}`);
      expect(val("D1")).toBe(val("A1"));
      expect(val("R2")).toBe(`${hy} · 20거래일 최고보다 0.60%p 좁음`);
      // A1 and D1 hold as their thresholds say: 3.5%p and 4.0%p (the sample's statuses agree with its figure)
      const st = (id: string) => rows.find((r) => r.id === id)!.status;
      const v = d.figures.hy!.value!;
      expect([st("A1"), st("D1")]).toEqual([v >= 3.5 ? "met" : "unmet", v >= 4.0 ? "met" : "unmet"]);
      // nowhere the level with a bare % (the old "3.76% · …")
      expect(rows.filter((r) => r.value.includes(`${hy.slice(0, -2)}% `))).toEqual([]);
    }
    expect(figureText(f.core_cpi!)).toBe("확인 불가");
    expect(figureText(f.asp_decline!)).toBe("약 −14.0%(추정)");
    expect(figureText(f.amp_b!)).toBe("약 ±2.5%(추정)");
    expect(figureText(f.usdkrw!)).toBe("1,398원");
  });
  test("fill: each reference becomes its figure in a span, a server phrase too; an unknown id is kept and named", () => {
    const { data } = deckFixture("a");
    const r = fill("하이일드 {hy}, {escape_label}, {nope} <b>", data.figures, data.words);
    expect(r.plain).toBe("하이일드 3.76%p, 탈출 2단계 경계, {nope} <b>");
    expect(r.html).toContain('<span class="fig" data-ref="hy">3.76%p</span>');
    expect(r.html).toContain("&lt;b&gt;");
    expect(r.missing).toEqual(["nope"]);
    expect(r.refs).toEqual(["hy", "escape_label"]);
    expect(fill("<i>{hy}", data.figures).html).toBe('&lt;i&gt;<span class="fig" data-ref="hy">3.76%p</span>');
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
    expect(undot(html).split(FONT_LICENCE).length - 1).toBe(1);
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
    expect(p2).toContain('<div class="num">3.76%p</div>');
    // a figure from another day says its day as M/D, the deck's short date (DD 1509 2)
    expect(textOf(p2)).toContain("FRED · A · 11/25 기준");
    expect(textOf(p2)).toContain("FRED · A · 11/26 기준 · 다른 출처 4.51% · 합성 매체");
    expect(html).not.toMatch(/\d{2}-\d{2} 기준/);
    expect(textOf(ps[22]!.html)).toContain("임계 5.0% · 지금 4.53%다른 출처 4.51% · 합성 매체");
  });
  test("the cover: the highlight inside the hand-drawn ring, the as of once, in the footer; no tabs", () => {
    const p1 = ps[0]!.html;
    expect(p1).toContain('<span class="ring" data-viz="hand-mark"><mark class="hl">경계가 이어지고</mark></span>');
    // DD 1509 4: no second basis line above the footer
    expect(textOf(p1).split("2026-11-27 08:00 KST").length - 1).toBe(1);
    expect(footLeft(p1)).toBe("출처: FRED · 기준 2026-11-27 08:00 KST");
    // the particle after the highlight stays on its line
    const c = deckFixture("c");
    expect(pages(renderDeck(c.spec, c.data))[0]!.html).toContain('<span class="tie"><span class="ring" data-viz="hand-mark"><mark class="hl">방어 준비 단계</mark></span>예요</span>');
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
  test("the sources page names each source first, so every footer's names are found there (DD 1509 1)", () => {
    const list = [...ps[26]!.html.matchAll(/<li>([^<]*)<\/li>/g)].map((m) => m[1]!);
    expect(list).toContain("FRED · 미 국채·하이일드 시계열(합성) · 합성 데이터 · 2026-11-26 · example.invalid/fred");
    // a capture is listed under its grade by the outlet the footer names
    expect(list.some((l) => /^합성 SNS · @sample_analyst · 캡처 11월 26일 \d{2}:\d{2} · example\.invalid\/cap-post$/.test(l))).toBe(true);
    const named = new Set(list.map((l) => l.split(" · ")[0]));
    const inFooters = new Set(ps.flatMap((p) => /^출처: (.+) · 기준/.exec(footLeft(p.html))?.[1]!.split(", ") ?? []));
    expect(inFooters.size).toBeGreaterThan(5);
    for (const n of inFooters) expect(named.has(n)).toBe(true);
    expect(html).not.toContain("quant");
  });
  test("an event's amplitude is a figure, written as the scenarios write theirs (DD 1509 3)", () => {
    const tl = textOf(ps[21]!.html);
    expect(tl).toContain("진폭 약 ±1.5%(추정)");
    expect(tl).not.toMatch(/진폭 ±/);
    expect(textOf(ps[20]!.html)).toContain("진폭 약 ±1.5%(추정)");
    const x = deckFixture("a");
    x.data.events!.list[0] = { ...x.data.events!.list[0]!, amplitudeRef: "nope" };
    expect(validateDeck(x.spec, x.data)).toContainEqual({ n: 22, kind: "timeline", rule: "schema", what: '이벤트 "미국 10월 PCE"의 진폭 nope가 figures에 없어요' });
  });
  test("the grid says what a figure says: same value, same day (DD 1509 7)", () => {
    const grid = data.core11!.items;
    expect(grid[8]!.value).toBe(figureText(data.figures.foreign_kospi!));
    expect(grid[8]!.value).toBe("−8,130억원");
    expect(grid[4]!).toMatchObject({ value: "4.3%", asOf: "11/7 기준" });
    expect(textOf(ps[8]!.html)).toContain("−8,130억원");
    expect(textOf(ps[8]!.html)).not.toContain("−2.1조");
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

describe("the stage cell is the 투자 screen's (DD 1704 1·2·3)", () => {
  const statuses = (cs: { id: string; status: Tri }[]) => Object.fromEntries(cs.map((c) => [c.id, c.status])) as Record<string, Tri>;
  /** the reading behind a sample, again from its grid and its conditions by quant's rules */
  const readingOf = (k: "a" | "b" | "c") => {
    const { data } = deckFixture(k);
    const c = data.stages!.conditions;
    return { data, s: assessedOf(data.core11!.items, statuses(c.escape), statuses(c.severe), statuses(c.recovery)) };
  };
  const none = () => null;
  /** readings across the rule's corners: every escape floor, a held and an open recovery */
  const corners = (): [string, Assessed][] => {
    const { data } = deckFixture("a");
    const items = data.core11!.items;
    const calm: Grid11Item[] = items.map((it) => (it.signal === "risk" ? { ...it, signal: "caution" as const } : it));
    const all = (rules: Readonly<Record<string, string>>, t: Tri) => Object.fromEntries(Object.keys(rules).map((id) => [id, t])) as Record<string, Tri>;
    const unmetA = all(ESCAPE_A_RULES, "unmet");
    const unmetD = all(ESCAPE_D_RULES, "unmet");
    const r = (o: Record<string, Tri>) => ({ ...all(RECOVERY_RULES, "unmet"), ...o });
    return [
      ["floor 1", assessedOf(calm, unmetA, unmetD, r({ R1: "met" }))],
      ["floor 2", assessedOf(items, { ...unmetA, A1: "met" }, unmetD, r({ R1: "met", R2: "met" }))],
      ["floor 3", assessedOf(items, { ...unmetA, A1: "met", A2: "met" }, { ...unmetD, D3: "met" }, r({ R2: "met", R5: "met", R6: "met" }))],
      ["floor 4", assessedOf(items, { ...unmetA, A1: "met", A2: "met" }, { ...unmetD, D1: "met", D3: "met" }, r({ R1: "met", R2: "met", R4: "met", R6: "met" }))],
      ["recovery held", assessedOf(items, { ...unmetA, A1: "met" }, { ...unmetD, D3: "met" }, r({ R1: "met", R2: "met", R4: "met", R6: "met" }))],
      ["recovery open", assessedOf(items, { ...unmetA, A1: "met" }, { ...unmetD, D5: "unknown" }, r({ R2: "met", R5: "met", R4: "unknown", R6: "unknown" }))],
      ["escape open", assessedOf(items, { ...unmetA, A1: "met", A4: "unknown" }, unmetD, r({ R2: "met", R6: "met" }))],
      ["recovery 2, R3 off", assessedOf(items, { ...unmetA, A1: "met" }, unmetD, r({ R1: "met", R2: "met", R4: "met", R5: "met", R6: "met" }))],
      ["recovery 1, D on", assessedOf(items, { ...unmetA, A1: "met" }, { ...unmetD, D3: "met" }, r({ R1: "met", R2: "met" }))],
      ["recovery 2, R3 unknown", assessedOf(items, { ...unmetA, A1: "met" }, unmetD, r({ R1: "met", R2: "met", R3: "unknown", R4: "met", R5: "met", R6: "met" }))],
    ];
  };

  test("heads, gauges and next lines are escapeHead, recoveryHead, gaugesOf and nextLines, word for word, at every corner", () => {
    const seen = new Set<string>();
    for (const [name, s] of [...corners(), ...(["a", "b", "c"] as const).map((k) => [k, readingOf(k).s] as [string, Assessed])]) {
      const st = deckStages(s, { values: {}, scenario: "B 둔화", sources: [] });
      const [eh, rh] = [escapeHead(s, none), recoveryHead(s, none)];
      expect([name, st.escape.head]).toEqual([name, { text: eh.text, ...(eh.name ? { name: eh.name } : {}), ...(eh.pending ? { pending: eh.pending } : {}) }]);
      expect([name, st.recovery.head]).toEqual([name, { text: rh.text, ...(rh.name ? { name: rh.name } : {}), ...(rh.pending ? { pending: rh.pending } : {}) }]);
      expect([name, st.next]).toEqual([name, nextLines(s)]);
      const g = gaugesOf(s);
      expect([st.escape.gauges.a.met, st.escape.gauges.a.unknown, st.escape.gauges.d.met, st.escape.gauges.d.unknown, st.recovery.gauge.met, st.recovery.gauge.unknown]).toEqual([g[0]!.met, g[0]!.unknown, g[1]!.met, g[1]!.unknown, g[2]!.met, g[2]!.unknown]);
      seen.add(eh.text.replace(/\d/g, "n")).add(rh.text.replace(/\d/g, "n")).add(String(st.next.escape == null)).add(String(st.next.recovery == null));
    }
    // the corners reach every kind of head and both a line and none
    expect([...seen].sort()).toEqual(["false", "true", "탈출 n단계", "탈출 최소 n단계", "회복 n단계", "회복 최소 n단계", "회복 단계 미확정", "회복 판정 보류"].sort());
  });

  test("a note may name what its next line's clauses need: n개 더 → that gauge's unmet, 심각 신호 n개 덜 → the met D's, R3 켜짐 → R3", () => {
    const by = Object.fromEntries(corners());
    const ids = (name: string, which: "escape" | "recovery") => noteIdsFor(nextLines(by[name]!)[which], gaugesOf(by[name]!));
    expect(nextLines(by["floor 1"]!).escape).toContain("핵심 위험 지표");
    expect(ids("floor 1", "escape")).toEqual([]);
    expect(nextLines(by["floor 2"]!).escape).toContain("악화 신호");
    expect(ids("floor 2", "escape")).toEqual(["A2", "A3", "A4", "A5", "A6", "A7", "A8"]);
    expect(nextLines(by["floor 3"]!).escape).toContain("심각 신호");
    expect(ids("floor 3", "escape")).toEqual(["D1", "D2", "D4", "D5"]);
    expect(nextLines(by["floor 4"]!).escape).toBeNull();
    expect(ids("floor 4", "escape")).toEqual([]);
    expect(nextLines(by["floor 2"]!).recovery).toBe("회복 2단계까지: 회복 신호 2개 더");
    expect(ids("floor 2", "recovery")).toEqual(["R3", "R4", "R5", "R6"]);
    // 덜: the met severe signals are the ones that must go off; with 더 beside it, both
    expect(nextLines(by["recovery 1, D on"]!).recovery).toBe("회복 2단계까지: 회복 신호 2개 더, 심각 신호 1개 덜");
    expect(ids("recovery 1, D on", "recovery")).toEqual(["R3", "R4", "R5", "R6", "D3"]);
    expect(nextLines(by["recovery held"]!).recovery).toBe("회복 2단계까지: 심각 신호 1개 덜");
    expect(ids("recovery held", "recovery")).toEqual(["D3"]);
    // R3 켜짐 names R3 alone
    expect(nextLines(by["recovery 2, R3 off"]!).recovery).toBe("회복 3단계까지: R3 켜짐");
    expect(ids("recovery 2, R3 off", "recovery")).toEqual(["R3"]);
    // ... unless R3 is unknown: the line is the same, the note names nothing
    expect(nextLines(by["recovery 2, R3 unknown"]!).recovery).toBe("회복 3단계까지: R3 켜짐");
    expect(ids("recovery 2, R3 unknown", "recovery")).toEqual([]);
    // an unknown condition is never one to name
    expect(ids("escape open", "escape")).toEqual(["A2", "A3", "A5", "A6", "A7", "A8"]);
  });

  test("the samples tell the stories the rules allow: (a) 2단계 경계, (b) 최소 2단계 and why, (c) 3단계 방어 준비", () => {
    const st = (k: "a" | "b" | "c") => deckFixture(k).data.stages!;
    expect([st("a").escape.head, st("a").recovery.head, st("a").next]).toEqual([
      { text: "탈출 2단계", name: "경계" },
      { text: "회복 1단계", name: "바닥 탐색" },
      { escape: "탈출 3단계까지: 악화 신호 1개 더", recovery: "회복 2단계까지: 회복 신호 1개 더" },
    ]);
    expect([st("b").escape.head, st("b").recovery.head, st("b").next.escape]).toEqual([
      { text: "탈출 최소 2단계", pending: "오늘 지표 2개를 받지 못해서 3단계 여부는 아직 몰라요." },
      { text: "회복 1단계", name: "바닥 탐색" },
      "탈출 3단계까지: 악화 신호 1개 더",
    ]);
    expect([st("c").escape.head, st("c").next.escape, st("c").moved]).toEqual([{ text: "탈출 3단계", name: "방어 준비" }, "탈출 4단계까지: 심각 신호 1개 더", "탈출 2단계 → 3단계"]);
    for (const k of ["a", "b", "c"] as const) {
      const { data, s } = readingOf(k);
      expect(data.stages!.next).toEqual(nextLines(s));
      expect(data.words!.escape_label).toBe([data.stages!.escape.head.text, data.stages!.escape.head.name].filter(Boolean).join(" "));
    }
  });

  test("a head's pending line is the server's for the same missing inputs, each reason in its own words (DD 1704 2, lead 2246)", () => {
    const { data, s } = readingOf("b");
    const opts = { values: {}, scenario: "B 둔화", sources: [] };
    // (b): the inputs behind A4 and A6 (core CPI, CAPEX) did not come today, as the fixture passes them
    const today = new Set<InputKey>(["coreCpiMoM", "capex"]);
    const fixtureMissing = (k: InputKey): Missing => (today.has(k) ? "today" : null);
    const eh = escapeHead(s, fixtureMissing);
    expect(eh.pending).toBe("오늘 지표 2개를 받지 못해서 3단계 여부는 아직 몰라요.");
    expect(data.stages!.escape.head).toEqual({ text: eh.text, pending: eh.pending });
    // an open condition with no reason given reads as not come today (the server's rule): the words a call without
    // reasons gets, which every other reason must not fall back to
    const bare = deckStages(s, opts).escape.head.pending;
    expect(bare).toBe(escapeHead(s, none).pending!);
    const cases: [string, (k: InputKey) => Missing, string][] = [
      ["nowhere yet", (k) => (today.has(k) ? "none" : null), "지표 2개 값이 없어서 3단계 여부는 아직 몰라요."],
      ["one of each", (k) => (k === "capex" ? "none" : k === "coreCpiMoM" ? "today" : null), "지표 1개 값이 없고 오늘 1개를 받지 못해서 3단계 여부는 아직 몰라요."],
      ["토스증권 not connected", (k) => (today.has(k) ? "connect" : null), "지표 2개 값이 없어서 3단계 여부는 아직 몰라요."],
    ];
    for (const [name, m, want] of cases) {
      const st = deckStages(s, { ...opts, missing: m });
      expect([name, st.escape.head.pending]).toEqual([name, escapeHead(s, m).pending]);
      expect([name, st.escape.head.pending]).toEqual([name, want]);
      expect([name, st.escape.head.pending === bare]).toEqual([name, false]);
    }
    // the recovery head too: an open recovery (R4 and R6 unknown), its inputs nowhere yet → the quiet words
    const open = corners().find(([n]) => n === "recovery open")![1];
    const quiet = (k: InputKey): Missing => (k === "breadth200" || k === "foreignKospi" || k === "kospi" || k === "nfci" ? "none" : null);
    const rh = recoveryHead(open, quiet);
    expect(rh.pending).toMatch(/^지표 \d개 값이 없어서 회복 단계는 아직 몰라요\.$/);
    expect(deckStages(open, { ...opts, missing: quiet }).recovery.head.pending).toBe(rh.pending!);
    expect(deckStages(open, opts).recovery.head.pending).toBe(recoveryHead(open, none).pending!);
    expect(rh.pending).not.toBe(recoveryHead(open, none).pending);
    // nothing open: no pending line, reasons or none
    const { s: a } = readingOf("a");
    for (const m of [undefined, quiet, fixtureMissing]) {
      const st = deckStages(a, { ...opts, ...(m ? { missing: m } : {}) });
      expect([st.escape.head.pending, st.recovery.head.pending]).toEqual([undefined, undefined]);
    }
  });

  test("each sample's values agree with their statuses and figures, and its headlines' counts with the gauges (DD 1704 1)", () => {
    const COUNT: Record<string, number> = { 하나: 1, 둘: 2, 셋: 3, 넷: 4, 다섯: 5 };
    const word = (h: string) => COUNT[Object.keys(COUNT).find((w) => h.includes(w)) ?? ""];
    for (const k of ["a", "b", "c"] as const) {
      const { spec, data } = deckFixture(k);
      const st = data.stages!;
      const all = [...st.conditions.escape, ...st.conditions.severe, ...st.conditions.recovery];
      // a value says 확인 불가 or 자료 없음 exactly when its condition is unknown
      for (const c of all) expect([k, c.id, /확인 불가|자료 없음/.test(c.value)]).toEqual([k, c.id, c.status === "unknown"]);
      // every VIX the conditions name is the VIX figure
      for (const c of all.filter((x) => x.value.includes("VIX"))) expect([k, c.id, c.value.startsWith(`VIX ${figureText(data.figures.vix!)}`)]).toEqual([k, c.id, true]);
      // the gauges count the statuses
      const n = (cs: typeof all, t: Tri) => cs.filter((c) => c.status === t).length;
      expect([st.escape.gauges.a.met, st.escape.gauges.a.unknown, st.escape.gauges.d.met, st.escape.gauges.d.unknown, st.recovery.gauge.met, st.recovery.gauge.unknown]).toEqual([
        n(st.conditions.escape, "met"), n(st.conditions.escape, "unknown"), n(st.conditions.severe, "met"), n(st.conditions.severe, "unknown"), n(st.conditions.recovery, "met"), n(st.conditions.recovery, "unknown"),
      ]);
      // a headline that counts signals counts what the gauge shows
      for (const g of spec.slides.filter((x): x is Extract<Slide, { kind: "gauges" }> => x.kind === "gauges")) {
        const met = g.focus === "recovery" ? st.recovery.gauge.met : st.escape.gauges.a.met;
        if (word(g.headline) != null) expect([k, g.headline, word(g.headline)]).toEqual([k, g.headline, met]);
      }
      const grid = spec.slides.find((x) => x.kind === "grid11")!;
      const items = data.core11!.items;
      const cnt = (sig: string) => items.filter((i) => i.signal === sig).length;
      const said = [...grid.headline.matchAll(/(위험|경계|확인 불가) (하나|둘|셋|넷|다섯)/g)].map((m) => [m[1], COUNT[m[2]!]]);
      expect(said.length).toBeGreaterThan(0);
      for (const [what, num] of said) expect([k, what, num]).toEqual([k, what, cnt(what === "위험" ? "risk" : what === "경계" ? "caution" : "unknown")]);
    }
  });

  test("a gauges note naming a met, an unknown or another group's condition goes back (B2-note); the samples' notes pass", () => {
    const note = (k: "a" | "b" | "c", n: number, text: string) => {
      const x = withSlide(n, (s) => ({ ...s, note: text }) as Slide, k);
      return validateDeck(x.spec, x.data).filter((f) => f.rule === "B2-note").map((f) => f.what);
    };
    // slide 11 shows the escape conditions, slide 12 the recovery ones
    expect(note("c", 11, "다음으로 켜질 수 있는 것은 D1과 D2예요.")).toEqual([]);
    expect(note("c", 11, "다음으로 켜질 수 있는 것은 A4와 A5예요.")).toEqual([
      "note가 부르는 A4는 다음 단계가 세는 조건이 아니에요(탈출 4단계까지: 심각 신호 1개 더)",
      "note가 부르는 A5는 다음 단계가 세는 조건이 아니에요(탈출 4단계까지: 심각 신호 1개 더)",
    ]);
    expect(note("c", 11, "D3가 이미 켜졌어요.")).toEqual(["note가 부르는 D3는 이미 충족이에요"]);
    expect(note("b", 11, "A4가 켜질 수 있어요.")).toEqual(["note가 부르는 A4는 확인 불가라서 부르지 않아요"]);
    expect(note("a", 12, "D1이 꺼져야 해요.")).toEqual(["note가 부르는 D1는 다음 단계가 세는 조건이 아니에요(회복 2단계까지: 회복 신호 1개 더)"]);
    // (c)'s recovery line asks D3 to go off: beside it the note may name D3, met as it is
    expect(deckFixture("c").data.stages!.next.recovery).toBe("회복 2단계까지: 회복 신호 1개 더, 심각 신호 1개 덜");
    expect(note("c", 12, "D3가 꺼져야 2단계가 돼요.")).toEqual([]);
    // A9 is no id; in A12 and DA3 no id stands alone (A1 is met, A3 is not the recovery line's): nothing is named
    expect(note("a", 12, "A9와 A12, DA3는 조건 id가 아니에요.")).toEqual([]);
    expect(note("a", 12, "R7이 켜지면 바뀌어요.")).toEqual(["note가 부르는 R7는 없는 조건이에요"]);
    // no next line: no condition to name
    const s4 = deckStages(corners().find(([n]) => n === "floor 4")![1], { values: {}, scenario: "", sources: [] });
    expect(noteNames("A3가 켜지면 바뀌어요.", "escape", s4)).toEqual(["다음 단계 줄이 없어서 note가 조건(A3)을 부르지 않아요"]);
  });

  test("a condition as drawn: the rule without its markdown, the server's value, else 확인 불가 when unknown and nothing otherwise", () => {
    const { s } = readingOf("b");
    const plain = (r: string) => r.replace(/\*\*|`/g, "");
    const RULES: Record<string, string> = { ...ESCAPE_A_RULES, ...ESCAPE_D_RULES, ...RECOVERY_RULES };
    const bare = deckStages(s, { values: {}, scenario: "", sources: [] });
    const all = [...bare.conditions.escape, ...bare.conditions.severe, ...bare.conditions.recovery];
    expect(all.map((c) => c.id)).toEqual(Object.keys(RULES));
    expect(all.filter((c) => c.status === "unknown").length).toBeGreaterThan(0);
    for (const c of all) {
      expect([c.id, c.rule]).toEqual([c.id, plain(RULES[c.id]!)]);
      expect([c.id, /\*\*|`/.test(c.rule)]).toEqual([c.id, false]);
      expect([c.id, c.value]).toEqual([c.id, c.status === "unknown" ? "확인 불가" : ""]);
    }
    // the rules carry markdown in quant (the master prompt's words): stripping is not idle
    expect(Object.values(RULES).filter((r) => /\*\*|`/.test(r)).length).toBeGreaterThan(10);
    const given = deckStages(s, { values: { A1: "3.76%p", A4: "자료 없음" }, scenario: "", sources: [] });
    expect([given.conditions.escape[0]!.value, given.conditions.escape[3]!.value]).toEqual(["3.76%p", "자료 없음"]);
  });
  test("a value breaks only between its pieces: split after each \" · \", the dot ending the piece before (DD 1704 4)", () => {
    expect(valuePieces("3.76%p · 6개월 최저보다 +0.41%p")).toEqual(["3.76%p ·", "6개월 최저보다 +0.41%p"]);
    expect(valuePieces("VIX 24.10")).toEqual(["VIX 24.10"]);
    expect(valuePieces("2년물 > 상단 · 근원 CPI 확인 불가 · 3일째")).toEqual(["2년물 > 상단 ·", "근원 CPI 확인 불가 ·", "3일째"]);
    const p11 = pages(renderDeck(deckFixture("a").spec, deckFixture("a").data))[10]!.html;
    expect(p11).toContain('<span class="val t-table"><span class="pc">3.76%p ·</span> <span class="pc">6개월 최저보다 +0.41%p</span></span>');
  });
  test("the conditions card is titled 다음 단계, and a null next line is left out; the board shows each head and its pending line", () => {
    const { spec, data } = deckFixture("b");
    const html = renderDeck(spec, data);
    const ps = pages(html);
    expect(html).not.toContain("다음 단계까지</div>");
    expect(ps[10]!.html).toContain('<div class="t">다음 단계</div><p class="next t-body"><span class="tie">탈출 3단계까지:</span> <span class="tie">악화 신호 1개 더</span></p>');
    // the line breaks only between its clauses, each keeping its comma
    expect(nextLineHtml("회복 2단계까지: 회복 신호 2개 더, 심각 신호 1개 덜")).toBe('<span class="tie">회복 2단계까지:</span> <span class="tie">회복 신호 2개 더,</span> <span class="tie">심각 신호 1개 덜</span>');
    expect(nextLineHtml("회복 3단계까지: 회복 신호 1개 더(R3 포함), 탈출 2단계 이하")).toBe('<span class="tie">회복 3단계까지:</span> <span class="tie">회복 신호 1개 더(R3 포함),</span> <span class="tie">탈출 2단계 이하</span>');
    expect(nextLineHtml("탈출 2단계까지: 핵심 위험 지표 2개 더, 또는 하이일드 스프레드 위험")).toBe('<span class="tie">탈출 2단계까지:</span> <span class="tie">핵심 위험 지표 2개 더,</span> <span class="tie">또는 하이일드 스프레드 위험</span>');
    expect(ps[2]!.html).toContain('<div class="sb-stage" data-stage="escape">탈출 최소 2단계</div><p class="sb-pend t-body">오늘 지표 2개를 받지 못해서 3단계 여부는 아직 몰라요.</p>');
    expect(ps[2]!.html).toContain('<div class="sb-stage" data-stage="recovery">회복 1단계 <span class="sb-sname">바닥 탐색</span></div>');
    data.stages!.next.escape = null;
    const p11 = pages(renderDeck(spec, data))[10]!.html;
    expect(p11).toContain('<div class="t">다음 단계</div><p class="note t-body">');
    expect(p11).not.toContain('class="next');
  });
});

describe("one width for U+00B7 (DD 1704 5)", () => {
  test("HTML: each dot an inline-block, a word's dot inside its nowrap word; attributes and <style> untouched", () => {
    expect(narrowDots('<p aria-label="a · b">FRED · 미 국채, 가 · 나</p>')).toBe('<p aria-label="a · b">FRED <span class="dot">·</span> 미 국채, 가 <span class="dot">·</span> 나</p>');
    expect(narrowDots("<p>탈출·회복은 4.53% · 0일</p>")).toBe('<p><span class="nw">탈출<span class="dot">·</span>회복은</span> 4.53% <span class="dot">·</span> 0일</p>');
    expect(narrowDots("<p>A&amp;B·C (합성)·합성</p>")).toBe('<p><span class="nw">A&amp;B<span class="dot">·</span>C</span> <span class="nw">(합성)<span class="dot">·</span>합성</span></p>');
    expect(narrowDots("<style>.a::after{content:'·'}</style><p>x</p>")).toBe("<style>.a::after{content:'·'}</style><p>x</p>");
  });
  test("SVG: the dot held wide and pulled in 0.14em, the next character too (across a tspan, an entity whole); <title> untouched", () => {
    expect(narrowDots('<svg><title>a · b</title><text x="0">단위 · KRX</text></svg>')).toBe(
      '<svg><title>a · b</title><text x="0">단위 <tspan class="dot" dx="-0.14em">·</tspan><tspan dx="-0.14em"> </tspan>KRX</text></svg>',
    );
    expect(narrowDots("<svg><text><tspan>선물·</tspan><tspan>옵션</tspan> ·&amp;</text><text>B</text></svg>")).toBe(
      '<svg><text><tspan>선물<tspan class="dot" dx="-0.14em">·</tspan></tspan><tspan><tspan dx="-0.14em">옵</tspan>션</tspan> <tspan class="dot" dx="-0.14em">·</tspan><tspan dx="-0.14em">&amp;</tspan></text><text>B</text></svg>',
    );
  });
  test("the wrappers' rules: an HTML dot an inline-block, a word nowrap, an SVG dot held wide (the widths need the font: deck-pdf)", () => {
    const css = deckCss(LOCAL_FONT_SRC);
    for (const r of [".dot{display:inline-block}", ".nw{white-space:nowrap}", 'svg .dot{display:inline;font-feature-settings:"locl" 0}']) expect(css).toContain(r);
  });
  test("every dot a sample draws is wrapped: none is left bare between tags", () => {
    for (const k of ["a", "b", "c"] as const) {
      const { spec, data } = deckFixture(k);
      const html = renderDeck(spec, data);
      const body = html.slice(html.indexOf("</style>"));
      const toks = body.match(/<[^>]*>|[^<]+/g)!;
      let dots = 0;
      toks.forEach((t, i) => {
        if (t.startsWith("<") || !t.includes("·")) return;
        dots += t.split("·").length - 1;
        expect([k, t, toks[i - 1]]).toEqual([k, "·", toks[i - 1]!.startsWith("<tspan") ? '<tspan class="dot" dx="-0.14em">' : '<span class="dot">']);
      });
      expect(dots).toBeGreaterThan(100);
    }
  });
});

describe("the samples' captures at real shapes (DD 1704 6)", () => {
  /** a PNG's chunks, each CRC checked, and its pixels inflated */
  const readPng = (src: string) => {
    const b = Buffer.from(src.slice(src.indexOf(",") + 1), "base64");
    expect([...b.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const chunks: { type: string; data: Buffer }[] = [];
    for (let at = 8; at < b.length; ) {
      const n = b.readUInt32BE(at);
      const type = b.subarray(at + 4, at + 8).toString("latin1");
      const data = b.subarray(at + 8, at + 8 + n);
      expect([type, b.readUInt32BE(at + 8 + n)]).toEqual([type, Bun.hash.crc32(b.subarray(at + 4, at + 8 + n))]);
      chunks.push({ type, data });
      at += 12 + n;
    }
    const ihdr = chunks[0]!.data;
    const [w, h] = [ihdr.readUInt32BE(0), ihdr.readUInt32BE(4)];
    const raw = inflateSync(Buffer.concat(chunks.filter((c) => c.type === "IDAT").map((c) => c.data)));
    return { types: chunks.map((c) => c.type), w, h, depth: ihdr[8], colour: ihdr[9], rawLength: raw.length };
  };
  test("a portrait post 1080 × 1350, a reply 1080 × 1080, a broadcast and a chart 1600 × 900: whole PNGs whose sizes match", () => {
    for (const [id, w, h] of [["cap-post", 1080, 1350], ["cap-reply", 1080, 1080], ["cap-broadcast", 1600, 900], ["cap-chart", 1600, 900]] as const) {
      const c = synthCapture(id);
      expect([id, c.width, c.height]).toEqual([id, w, h]);
      const p = readPng(c.src);
      expect([id, p.types[0], p.types.at(-1), p.w, p.h, p.depth, p.colour, p.rawLength]).toEqual([id, "IHDR", "IEND", w, h, 8, 2, h * (w * 3 + 1)]);
    }
  });
  test("each sample's captures are those pictures when asked for, and a dot otherwise", () => {
    for (const k of ["a", "b", "c"] as const) {
      const real = deckFixture(k, synthCapture).data.captures;
      const dots = deckFixture(k).data.captures;
      expect(Object.keys(real).length).toBeGreaterThan(0);
      for (const [id, c] of Object.entries(real)) {
        expect([k, id, c.width, c.height]).toEqual([k, id, synthCapture(id).width, synthCapture(id).height]);
        expect([k, id, dots[id]!.width, dots[id]!.height]).toEqual([k, id, 1, 1]);
      }
    }
  });
});
