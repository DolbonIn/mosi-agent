// The deck's font, the PDF build and the rendered-page check (lead 0102, DD 0103-b E/F, DD 0059 §6, DD 1935 §5-3).
// Chrome tests run when Chrome is installed; the font tests that need the real file run when PICKLE_DECK_FONT names it
// (QA passes the path through env only). PICKLE_DECK_SAMPLES_OUT, when set, receives the three samples' outputs.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_ATTACHMENT_BYTES } from "../src/archive";
import { accepted, buildDeck, CHECK_FAIL, DECK_FACE, DECK_FILE_MAX, deckPages, NO_BROWSER_FAIL, pdfPageCount, pngSize, sheetHtml, type DeckBuild } from "../src/deck/build";
import { pageCheckExpression, type DomReport } from "../src/deck/check";
import { CHROME_FLAGS, DEFAULT_CHROME, withChrome } from "../src/deck/chrome";
import { DECK_FONT_FAMILY, fontFacts, fontFileSrc, judgeFont, loadDeckFont, NO_FONT_FAIL, NO_FONT_ROW, type DeckFont } from "../src/deck/font";
import { deckCss, FA3, FONT_LICENCE, LOCAL_FONT_SRC } from "../src/deck";
import { DISCLAIMER } from "@pickle/quant";
import { narrowDots } from "../src/deck/text";
import { deckFixture, synthCapture } from "./deck-fixtures";

const CHROME = process.env.PICKLE_DECK_CHROME || DEFAULT_CHROME;
const HAS_CHROME = existsSync(CHROME);
const FONT_PATH = process.env.PICKLE_DECK_FONT;
const tmp = mkdtempSync(join(tmpdir(), "deck-pdf-test-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** a minimal sfnt: a name table with the given family records and, when asked, an fvar with one wght axis */
function sfnt(o: { family?: string; typo?: string; mac?: string; wght?: [number, number] | null }): Uint8Array {
  const recs: { platform: number; encoding: number; id: number; bytes: number[] }[] = [];
  const utf16 = (s: string) => [...s].flatMap((ch) => [ch.charCodeAt(0) >> 8, ch.charCodeAt(0) & 255]);
  if (o.mac) recs.push({ platform: 1, encoding: 0, id: 1, bytes: [...o.mac].map((c) => c.charCodeAt(0)) });
  if (o.family) recs.push({ platform: 3, encoding: 1, id: 1, bytes: utf16(o.family) });
  if (o.typo) recs.push({ platform: 3, encoding: 1, id: 16, bytes: utf16(o.typo) });
  const strings: number[] = [];
  const nameRecs: number[] = [];
  const u16 = (n: number) => [n >> 8, n & 255];
  const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  for (const r of recs) {
    nameRecs.push(...u16(r.platform), ...u16(r.encoding), ...u16(0), ...u16(r.id), ...u16(r.bytes.length), ...u16(strings.length));
    strings.push(...r.bytes);
  }
  const name = [...u16(0), ...u16(recs.length), ...u16(6 + nameRecs.length), ...nameRecs, ...strings];
  const tables: [string, number[]][] = [["name", name]];
  if (o.wght) {
    const fx = (v: number) => u32(Math.round(v * 65536) >>> 0);
    const axis = [..."wght"].map((c) => c.charCodeAt(0)).concat(fx(o.wght[0]), fx(400), fx(o.wght[1]), u16(0), u16(256));
    tables.push(["fvar", [...u16(1), ...u16(0), ...u16(16), ...u16(2), ...u16(1), ...u16(20), ...u16(0), ...u16(8), ...axis]]);
  }
  const head = [...u32(0x00010000), ...u16(tables.length), ...u16(0), ...u16(0), ...u16(0)];
  let at = 12 + tables.length * 16;
  const dir: number[] = [];
  const body: number[] = [];
  for (const [tag, bytes] of tables) {
    dir.push(...[...tag].map((c) => c.charCodeAt(0)), ...u32(0), ...u32(at), ...u32(bytes.length));
    body.push(...bytes);
    at += bytes.length;
  }
  return new Uint8Array([...head, ...dir, ...body]);
}

const GOOD = { typo: "Noto Sans KR", family: "Noto Sans KR Regular", wght: [100, 900] as [number, number] };
const file = (name: string, bytes: Uint8Array | string) => {
  const p = join(tmp, name);
  writeFileSync(p, bytes);
  return p;
};

describe("the deck's font (lead 0102 가; DD 0103-b E, F)", () => {
  test("the name table's family (ID 16 before ID 1, Windows before Mac) and the fvar's wght axis", () => {
    expect(fontFacts(sfnt(GOOD))).toEqual({ family: "Noto Sans KR", wght: [100, 900] });
    expect(fontFacts(sfnt({ family: "Noto Sans KR", wght: [400, 900] }))).toEqual({ family: "Noto Sans KR", wght: [400, 900] });
    expect(fontFacts(sfnt({ mac: "Noto Sans KR", wght: null }))).toEqual({ family: "Noto Sans KR", wght: null });
    expect(fontFacts(sfnt({ mac: "Mac Name", family: "Win Name" }))!.family).toBe("Win Name");
    expect(fontFacts(new TextEncoder().encode("not a font at all, just words"))).toBeNull();
    expect(fontFacts(new Uint8Array(4))).toBeNull();
  });
  test("no path, a file that cannot be read, not a font, another family, no wght axis to 900: off, with the reason", async () => {
    expect(await loadDeckFont(undefined)).toMatchObject({ ok: false, reason: "no_path" });
    expect(await loadDeckFont("  ")).toMatchObject({ ok: false, reason: "no_path" });
    expect(await loadDeckFont(join(tmp, "missing.ttf"))).toMatchObject({ ok: false, reason: "unreadable" });
    expect(await loadDeckFont(file("words.ttf", "hello"))).toMatchObject({ ok: false, reason: "not_font" });
    expect(await loadDeckFont(file("jp.ttf", sfnt({ typo: "Noto Sans JP", wght: [100, 900] })))).toMatchObject({ ok: false, reason: "wrong_family" });
    expect(await loadDeckFont(file("static.ttf", sfnt({ family: "Noto Sans KR" })))).toMatchObject({ ok: false, reason: "no_wght" });
    expect(await loadDeckFont(file("light.ttf", sfnt({ family: "Noto Sans KR", wght: [100, 700] })))).toMatchObject({ ok: false, reason: "no_wght" });
    // the axis's low end counts too: a font that starts at 500 cannot draw the 400 body (lead 1655 D6)
    expect(await loadDeckFont(file("heavy.ttf", sfnt({ family: "Noto Sans KR", wght: [500, 900] })))).toMatchObject({ ok: false, reason: "no_wght" });
    const good = file("good.ttf", sfnt(GOOD));
    expect(await loadDeckFont(good)).toEqual({ ok: true, path: good, family: "Noto Sans KR", wght: [100, 900], bytes: sfnt(GOOD).length });
  });
  test("the sentences, word for word (DD 0103-b E)", () => {
    expect(NO_FONT_ROW).toBe("이 서버에는 글꼴 파일이 없어서 심층판을 만들지 않아요.");
    expect(NO_FONT_FAIL).toBe("이 서버에 글꼴 파일이 없어서 심층판을 만들지 못했어요.");
  });
  test("the PDF pass names the file by URL; the archived page names the font by local() only", () => {
    expect(fontFileSrc("/opt/fonts/Noto Sans KR.ttf")).toBe('url("file:///opt/fonts/Noto%20Sans%20KR.ttf") format("truetype")');
    expect(LOCAL_FONT_SRC).not.toContain("file:");
    expect(deckCss(LOCAL_FONT_SRC)).not.toContain("url(\"file:");
  });
  test.skipIf(!FONT_PATH)("the file PICKLE_DECK_FONT names is the deck's font", async () => {
    const f = await loadDeckFont(FONT_PATH);
    expect(f).toMatchObject({ ok: true, family: "Noto Sans KR" });
    if (f.ok) expect(f.wght[0] <= 400 && f.wght[1] >= 900).toBe(true);
  });
});

test("the weight axis must reach 400 at its low end and 900 at its high end; the ends themselves are enough (lead 1655 D6)", () => {
  const at = (wght: [number, number]) => judgeFont({ family: DECK_FONT_FAMILY, wght }).ok;
  expect([at([400, 900]), at([100, 1000]), at([401, 900]), at([500, 900]), at([400, 899]), at([100, 700])]).toEqual([true, true, false, false, false, false]);
});

describe("the archived page never carries the font file, with no font and no browser on the machine (lead 1655 D1)", () => {
  // a path as a person's machine might have it: no spelling of its folder or file name may reach the kept page
  const path = "/Users/someone/모시 글꼴/NotoSansKR-VF.ttf";
  for (const k of ["a", "b", "c"] as const) {
    test(`fixture ${k}: the PDF pass names the file, the archived page differs only in naming the font by local()`, () => {
      const { spec, data } = deckFixture(k);
      const { html, archived } = deckPages(spec, data, { font: { path } });
      // what the checks look for is there to be found, in the page that is not kept
      expect(html).toContain(fontFileSrc(path));
      expect(html).toContain(encodeURI("모시 글꼴"));
      for (const bit of ["file:", "someone", "모시 글꼴", encodeURI("모시 글꼴"), "NotoSansKR-VF", ".ttf", "truetype"]) expect(archived).not.toContain(bit);
      // no font bytes: every @font-face src is local() names and nothing else
      const faces = archived.match(/@font-face\{[^}]*\}/g) ?? [];
      expect(faces.length).toBe(1);
      for (const f of faces) expect(f).toMatch(/src:local\("[^"]+"\)(, local\("[^"]+"\))*;/);
      expect(archived.split(LOCAL_FONT_SRC).join("@")).toBe(html.split(fontFileSrc(path)).join("@"));
    });
  }
  test("buildDeck draws both pages through deckPages and keeps the archived one (a source check: the build itself needs Chrome and the font)", () => {
    const src = readFileSync(join(import.meta.dir, "../src/deck/build.ts"), "utf8");
    const at = src.indexOf("export async function buildDeck(");
    const body = src.slice(at, src.indexOf("\n}\n", at));
    expect(at).toBeGreaterThan(0);
    expect(body).not.toContain("renderDeck(");
    expect(body).not.toContain("fontFileSrc(");
    expect(body.split("const { html, archived } = deckPages(spec, data, { font: o.font });").length).toBe(2);
    // and neither name is given anything else afterwards
    expect(body.match(/\b(html|archived)\s*=(?!=)/g)).toBeNull();
    expect(body.match(/return \{ ok: true, [^}]*\}/g)).toEqual(["return { ok: true, pdf, html: archived, pngs, sheet, check }"]);
    expect(body).toContain("new TextEncoder().encode(archived).length");
    // the page Chrome opens is the PDF one: it is the only one written to the page's folder
    expect(body.match(/Bun\.write\([^)]*\)/g)).toEqual(["Bun.write(deckFile, html)"]);
  });
});

describe("building the deck: refused before any work when it cannot be made", () => {
  const nowhere = join(tmp, "no-chrome");
  const fakeFont: DeckFont = { ok: true, path: join(tmp, "good.ttf"), family: "Noto Sans KR", wght: [100, 900], bytes: 1 };
  const opts = { name: "fixture-a", chrome: nowhere, generatedAt: "2026-11-26T23:12:00.000Z" };
  test("no font: the failure sentence, no retry, and no browser started", async () => {
    const { spec, data } = deckFixture("a");
    const r = await buildDeck(spec, data, { ...opts, font: { ok: false, reason: "no_path", detail: "" } });
    expect(r).toEqual({ ok: false, reason: "font", sentence: NO_FONT_FAIL, retry: false });
  });
  test("a deck the JSON check refuses is not drawn: the check names the slide, and making it again may pass", async () => {
    const { spec, data } = deckFixture("a");
    spec.slides[2] = { ...spec.slides[2]!, headline: "매우 좋아요!" };
    const r = await buildDeck(spec, data, { ...opts, font: fakeFont });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r).toMatchObject({ reason: "check", sentence: CHECK_FAIL, retry: true });
    expect(r.check!.pdfPages).toBe(0);
    expect(r.check!.accepted).toBe(false);
    expect(r.check!.perSlide[2]!.fails.map((f) => f.rule).sort()).toEqual(["FA4-10", "FA4-10"]);
    expect(r.check!.totals.fails).toBe(2);
  });
  test("no browser: its sentence, no retry", async () => {
    const { spec, data } = deckFixture("a");
    expect(await buildDeck(spec, data, { ...opts, font: fakeFont })).toEqual({ ok: false, reason: "browser", sentence: NO_BROWSER_FAIL, retry: false });
  });
});

describe("the build's pieces", () => {
  test("a PDF's pages: its page objects, not the page tree; else the tree's largest /Count", () => {
    const enc = (s: string) => new TextEncoder().encode(s);
    expect(pdfPageCount(enc("<</Type /Pages /Count 2>> <</Type /Page>> <</Type/Page >> <</Type /Page/Parent 3 0 R>>"))).toBe(3);
    expect(pdfPageCount(enc("<</Type /Pages /Count 8>> <</Type /Pages /Count 28>>"))).toBe(28);
    expect(pdfPageCount(enc("nothing"))).toBe(0);
  });
  test("a PNG's size from its header", () => {
    const png = new Uint8Array(24);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 5, 0, 0, 0, 2, 208]);
    expect(pngSize(png)).toEqual({ width: 1280, height: 720 });
    expect(pngSize(new Uint8Array(10))).toBeNull();
  });
  test("the contact sheet: six columns of 320 × 180, number and kind under each, a failing slide framed 2 px red", () => {
    const perSlide = Array.from({ length: 28 }, (_, i) => ({ n: i + 1, kind: i === 0 ? "hero" : "table", fails: i === 11 ? [{ rule: "FA4-2", what: "표 글자 14px" }, { rule: "B2-clip", what: "…" }] : [] }));
    const s = sheetHtml("fixture-a", perSlide.map((p) => `s-${p.n}.png`), { perSlide, slides: 28, totals: { fails: 2, minFontPx: 14, overlaps: 0, clipped: 1, levelLinesOutside: 0, captures: 3 } }, "2026-11-27 08:12 KST");
    expect(s.width).toBe(32 * 2 + 6 * 320 + 5 * 16);
    expect(s.height).toBe(32 + 34 + 5 * 206 + 4 * 18 + 32);
    expect(s.html).toContain("grid-template-columns:repeat(6,320px)");
    expect(s.html).toContain(`.c img.bad{outline:2px solid ${FA3.red}}`);
    expect(s.html.match(/<img [^>]*class="bad"/g)!.length).toBe(1);
    expect(s.html).toContain('<img src="s-12.png" width="320" height="180" class="bad"><div class="l bad">12 · table · FA4-2, B2-clip</div>');
    expect(s.html).toContain('<div class="l">1 · hero</div>');
    expect(s.html).toContain("fixture-a · 28장 · 검사 실패 2 · 2026-11-27 08:12 KST");
  });
  test("a deck goes out only with no fails, PDF pages = slides, 24–30 slides, the disclaimer word for word (DD 0059 §6-2)", () => {
    const ok = { slides: 28, pdfPages: 28, fails: 0, disclaimerOk: true };
    expect(accepted(ok)).toBe(true);
    expect(accepted({ ...ok, fails: 1 })).toBe(false);
    expect(accepted({ ...ok, pdfPages: 29 })).toBe(false);
    expect(accepted({ ...ok, disclaimerOk: false })).toBe(false);
    expect(accepted({ ...ok, slides: 24, pdfPages: 24 })).toBe(true);
    expect(accepted({ ...ok, slides: 30, pdfPages: 30 })).toBe(true);
    expect(accepted({ ...ok, slides: 23, pdfPages: 23 })).toBe(false);
    expect(accepted({ ...ok, slides: 31, pdfPages: 31 })).toBe(false);
  });
  test("the PDF and the archived page each fit the 보관함's file cap", () => {
    expect(DECK_FILE_MAX).toBe(MAX_ATTACHMENT_BYTES);
  });
});

// ---- in Chrome

/** run the page check over an HTML document */
async function checkHtml(html: string): Promise<DomReport> {
  return withChrome(CHROME, async (page) => {
    const f = `${page.dir}/p.html`;
    await Bun.write(f, html);
    await page.viewport(1280, 720);
    await page.goto(`file://${f}`);
    await page.evaluate("document.fonts.ready.then(() => true)");
    return page.evaluate<DomReport>(pageCheckExpression({ disclaimer: DISCLAIMER, playbook: null, licence: FONT_LICENCE, palette: Object.values(FA3), fontFamily: DECK_FACE }));
  });
}

const PX = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=";
const section = (n: number, kind: string, inner: string, foot = "출처: FRED · 기준 2026-11-27 08:00 KST") =>
  `<section class="page" data-n="${n}" data-kind="${kind}">${inner}<footer class="foot"><span class="l" data-role="foot-left">${foot}</span><span class="r">${n} / 5</span></footer></section>`;
const doc = (sections: string[]) => `<!doctype html><html lang="ko"><head><meta charset="utf-8"><style>${deckCss(LOCAL_FONT_SRC)}</style></head><body>${sections.join("")}</body></html>`;

test("behind the page's own refusal two more layers: no name resolves, no proxy answers; and it is always headless", () => {
  for (const f of ["--headless=new", "--host-resolver-rules=MAP * ~NOTFOUND", "--proxy-server=127.0.0.1:9"]) expect(CHROME_FLAGS).toContain(f);
  expect(CHROME_FLAGS.some((f) => f.startsWith("--user-data-dir"))).toBe(false); // a fresh profile per run, added by the run
});

describe.skipIf(!HAS_CHROME)("the browser run (lead 1438): nothing leaves, and it ends what it started", () => {
  test(
    "a page asking for http, even on this machine, gets nothing: the server sees no request",
    async () => {
      let hits = 0;
      const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => (hits++, new Response("x")) });
      try {
        const base = `http://127.0.0.1:${server.port}`;
        const r = await withChrome(CHROME, async (page) => {
          // why each request failed: the page's own refusal (BlockedByClient) comes first, before any name lookup or proxy
          const failed: { url: string; error: string }[] = [];
          const urls = new Map<string, string>();
          page.cdp.on("Network.requestWillBeSent", (p) => urls.set(String(p.requestId), String((p.request as { url: string }).url)));
          page.cdp.on("Network.loadingFailed", (p) => failed.push({ url: urls.get(String(p.requestId)) ?? "", error: String(p.errorText) }));
          await page.cdp.send("Network.enable", {}, page.session);
          const f = `${page.dir}/p.html`;
          await Bun.write(f, `<!doctype html><img id="i" src="${base}/a.png"><link rel="stylesheet" href="${base}/b.css"><iframe src="${base}/c"></iframe>`);
          await page.goto(`file://${f}`);
          const fetched = await page.evaluate<string>(`fetch("${base}/d").then(() => "fetched", () => "refused")`);
          const img = await page.evaluate<number>(`document.getElementById("i").naturalWidth`);
          return { fetched, img, dir: page.dir, pid: page.pid, failed: failed.filter((x) => x.url.startsWith(base)) };
        });
        expect(r).toMatchObject({ fetched: "refused", img: 0 });
        expect(hits).toBe(0);
        // the image, the style sheet and the fetch were each refused by the run itself (Fetch.failRequest's own reason,
        // not a failed lookup or proxy)
        const REFUSED = "net::ERR_BLOCKED_BY_CLIENT.Inspector";
        for (const p of ["/a.png", "/b.css", "/d"]) expect(r.failed.filter((x) => x.url === base + p).map((x) => x.error)).toEqual([REFUSED]);
        // the frame's page load is refused the same way, on the navigation path (no ".Inspector")
        expect(r.failed.filter((x) => x.url === `${base}/c`).map((x) => x.error)).toEqual(["net::ERR_BLOCKED_BY_CLIENT"]);
        expect(r.failed.every((x) => x.error.startsWith("net::ERR_BLOCKED_BY_CLIENT"))).toBe(true);
        // the temporary profile and work folder are gone, and so is the browser this run started
        expect(existsSync(r.dir)).toBe(false);
        expect(() => process.kill(r.pid, 0)).toThrow();
      } finally {
        server.stop(true);
      }
    },
    60_000,
  );
});

describe.skipIf(!HAS_CHROME)("the rendered-page check (DD 1935 §5-3), in Chrome", () => {
  test(
    "each rule finds what it is for",
    async () => {
      const r = await checkHtml(
        doc([
          section(
            1,
            "table",
            `<div class="body"><p class="t-body" style="font-size:17px">본문이 작아요</p><p style="font-size:11px">아주 작아요</p><p class="t-foot" style="font-size:13px">각주가 작아요</p><table class="tbl" style="width:300px"><tr><td style="font-size:14px">표가 작아요</td><td>가<br>나<br>다<br>라<br>마</td></tr></table></div>`,
          ),
          section(
            2,
            "table",
            `<div class="body"><svg width="20" height="20"><rect width="20" height="20" fill="${FA3.ink}"/></svg><img src="${PX}" width="10" height="10"><div style="background:linear-gradient(#fff,#000);width:10px;height:10px"></div><div style="backdrop-filter:blur(4px);width:10px;height:10px"></div><div style="box-shadow:0 4px 20px rgba(0,0,0,.2);width:10px;height:10px"></div><p style="color:#FF0000">빨강</p><p>SIL OFL</p></div>`,
          ),
          section(
            3,
            "table",
            `<div class="body"><p style="position:absolute;left:0;top:0;font-size:19px">겹치는 글</p><p style="position:absolute;left:10px;top:4px;font-size:19px">겹치는 글</p><p style="position:absolute;left:1300px;top:100px">장 밖</p><p style="position:absolute;left:1060px;top:200px;white-space:nowrap;font-size:19px">여백에 들어가요</p><p style="position:absolute;left:0;top:430px;font-size:19px">푸터에 닿는 글</p><div style="position:absolute;left:600px;top:100px;width:50px;height:20px;overflow:hidden;white-space:nowrap">잘리는 아주 긴 글이에요</div></div>`,
          ),
          section(
            4,
            "level-chart",
            `<div class="body"><div class="viz" data-viz="level-chart" data-plot="10,100"><svg width="400" height="120"><text data-role="caption" x="0" y="8" font-size="15" fill="${FA3.foot}">단위 달러 · 11월 26일 종가 · 토스증권</text><line x1="0" x2="300" y1="150" y2="150" stroke="${FA3.red}" data-level="stop"/></svg></div><div class="viz" data-viz="chart" style="margin-top:20px"><svg width="200" height="40"><text x="0" y="30" font-size="15" fill="${FA3.foot}">이름 없음</text></svg></div><figure class="cap" style="margin:0;width:300px;height:150px"><div class="frame"><img src="file:///no/such.png" data-viz="capture" width="100" height="50"></div><div class="cm">합성 SNS</div></figure><div class="hero" style="position:static"><h1 style="font-size:60px">작은 표지</h1></div><span class="fig">3.76%</span></div>`,
            "기준 2026-11-27 08:00 KST",
          ),
          section(5, "disclaimer", `<div class="dc"><p data-role="disclaimer">다른 문장이에요.</p></div>`, "출처 줄"),
        ]),
      );
      const got = (n: number, rule: string) => r.fails.filter((f) => f.n === n && f.rule === rule).map((f) => f.what);
      expect(r.pages).toBe(5);
      expect(got(1, "FA4-2")).toEqual(expect.arrayContaining(["본문 글자 17px(19px 아래)", "글자 11px(12px 아래)", "각주 글자 13px(14px 아래)", "표 글자 14px(15px 아래)", "표 칸이 5줄이에요(5줄 이상)"]));
      expect(got(2, "FA4-3")).toEqual(["차트·캡처·신호 칩이 아닌 svg", "차트·캡처·신호 칩이 아닌 img"]);
      expect(got(2, "FA4-4")).toEqual(expect.arrayContaining(["장 배경 밖의 그라디언트", "backdrop-filter", "그림자 흐림 20px(8px 넘음)", "FA3 밖의 색 #FF0000"]));
      expect(got(2, "B2-ofl")).toEqual(["글꼴 표기는 마지막 장에만 있어요"]);
      expect(got(3, "B2-overlap")).toContain('글자가 겹쳐요: "겹치는 글" / "겹치는 글"');
      expect(got(3, "B2-clip")).toEqual(expect.arrayContaining(["글자가 장 밖으로 나가요", "글자가 좌우 여백(64px)에 들어가요", "글자가 푸터 줄에 닿아요"]));
      expect(got(3, "B2-clip").some((w) => w.startsWith("넘친 내용이 잘려요"))).toBe(true);
      expect(got(4, "B2-levels")).toEqual(["stop 선이 축 밖이에요"]);
      expect(r.levelLinesOutside).toBe(1);
      expect(got(4, "FA4-8")).toEqual(["차트에 단위·기준·출처 줄이 없어요", "숫자나 차트가 있는데 푸터에 출처가 없어요"]);
      expect(got(4, "FA4-11")).toEqual(["캡처 그림을 읽지 못했어요", "캡처에 캡션이 없어요", "캡처에 출처·시각·등급이 없어요", "캡처에 원래 주소가 없어요"]);
      expect(got(4, "B2-hero64")).toEqual(["표지 제목 60px(64px 아래)"]);
      expect(got(5, "B2-disclaimer")).toEqual(["마지막 장의 면책 문장이 글자 그대로가 아니에요"]);
      expect(got(5, "B2-ofl")).toEqual(["마지막 장 푸터에 글꼴 표기가 없어요"]);
      // the deck face is not on this page: the font check says so (deck-wide, n 0)
      expect(got(0, "B2-font")).toEqual([`${DECK_FACE} 글꼴을 읽지 못했어요`]);
      expect(r.minFontPx).toBe(11);
    },
    60_000,
  );
  test(
    "the licence in another size or colour is caught (its baseline is measured with the deck's font, below)",
    async () => {
      const r = await checkHtml(doc([section(1, "disclaimer", `<div class="dc"><p data-role="disclaimer">${DISCLAIMER}</p></div>`, FONT_LICENCE).replace('<span class="l"', '<span style="font-size:13px;color:#5A616C" class="l"')]));
      const ofl = r.fails.filter((f) => f.rule === "B2-ofl").map((f) => f.what);
      expect(ofl).toContain("글꼴 표기 13px(14px)");
      expect(ofl).toContain("글꼴 표기 색 #5A616C(#7B8089)");
    },
    60_000,
  );
});

// ---- the whole build, with the real font

const samplesOut = process.env.PICKLE_DECK_SAMPLES_OUT;

describe.skipIf(!HAS_CHROME || !FONT_PATH)("the licence line with the deck's font (DD 0103-b F)", () => {
  test(
    "in its place it passes: 14px, #7B8089, its baseline at 700; three pixels up it does not",
    async () => {
      const page = (extra: string) =>
        doc([section(1, "disclaimer", `<div class="dc"><p data-role="disclaimer">${DISCLAIMER}</p></div>`, FONT_LICENCE).replace('<span class="l"', `<span${extra} class="l"`)]).replace(`src:${LOCAL_FONT_SRC}`, `src:${fontFileSrc(FONT_PATH!)}`);
      const r = await checkHtml(page(""));
      expect(r.fails).toEqual([]);
      const moved = await checkHtml(page(' style="top:6px"'));
      expect(moved.fails.map((f) => f.what)).toEqual(["글꼴 표기 기준선 y 697.0(700)"]);
    },
    60_000,
  );
});

describe.skipIf(!HAS_CHROME)("the value, next-line and word-dot checks, which need no font (DD 1704 4, 5; DD 1719 1)", () => {
  const at = (top: number, html: string) => `<div style="position:absolute;left:64px;top:${top}px;width:700px">${html}</div>`;
  test(
    "a value piece that breaks inside or is wider than its column fails, a next line's clause that breaks inside, a word's dot that ends a line; pieces that fit pass",
    async () => {
      const row = (val: string, pcs: string) => `<div class="gg-list" style="position:static;--val:${val}"><div class="cond"><span class="chip">충족</span><span class="rule t-table">규칙</span><span class="val t-table">${pcs}</span></div></div>`;
      const r = await checkHtml(
        doc([
          section(
            1,
            "table",
            at(120, row("176px", '<span class="pc">VIX 27.40 ·</span> <span class="pc">2일째</span>')) +
              at(180, row("60px", '<span class="pc">VIX 27.40 ·</span> <span class="pc">2일째</span>')) +
              at(240, row("60px", '<span class="pc" style="white-space:normal">하이일드 3.20%p</span>')) +
              at(300, '<p class="next t-body" style="width:90px"><span class="tie" style="white-space:normal">회복 신호 2개 더,</span> <span class="tie">R3 켜짐</span></p>') +
              '<div style="position:absolute;left:64px;top:400px;width:40px;word-break:keep-all;font-size:16px"><span class="nw" style="white-space:normal">탈출<span class="dot">·</span>회복<span class="dot">·</span>지표</span></div>',
          ),
        ]),
      );
      expect(r.fails.filter((f) => f.rule === "B2-value").map((f) => f.what)).toEqual(['값 조각이 칸보다 넓어요: "VIX 27.40 ·"', '값 칸이 조각 안에서 줄이 바뀌어요: "하이일드 3.20%p"']);
      expect(r.fails.filter((f) => f.rule === "B2-next").map((f) => f.what)).toEqual(['다음 단계 줄이 조각 안에서 바뀌어요: "회복 신호 2개 더,"']);
      expect(r.fails.filter((f) => f.rule === "B2-dot" && f.what.startsWith("단어 안")).map((f) => f.what)).toEqual(['단어 안 구분점에서 줄이 바뀌어요: "탈출·회복·지표"']);
    },
    60_000,
  );
  test(
    "a footer's dot spans stay in its line: only the footer's own two spans are placed (.foot > span)",
    async () => {
      const r = await checkHtml(doc([section(1, "table", "", narrowDots("<b>출처: FRED · 판정 규칙 · 기준 2026-11-27 08:00 KST</b>").slice(3, -4))]));
      expect(r.fails.filter((f) => f.rule === "B2-overlap" || f.rule === "B2-clip")).toEqual([]);
      expect(narrowDots("<b>출처: FRED · 판정 규칙</b>")).toContain('<span class="dot">·</span>');
    },
    60_000,
  );
});

describe.skipIf(!HAS_CHROME || !FONT_PATH)("the dot widths with the deck's font (DD 1704 5)", () => {
  const at = (top: number, html: string) => `<div style="position:absolute;left:64px;top:${top}px;width:700px">${html}</div>`;
  test(
    "a wide U+00B7 fails at its weight's bound; the narrowed ones pass, in HTML and in SVG",
    async () => {
      const page = doc([
        section(
          1,
          "table",
          [
            at(120, '<p class="t-body">위험 · 경계</p>'),
            at(160, narrowDots('<p class="t-body">위험 · 경계, 탈출·회복</p>')),
            at(200, '<p style="font-weight:800;font-size:17px">지표 · 위험</p>'),
            at(240, narrowDots('<p style="font-weight:800;font-size:17px;letter-spacing:2.2px">지표 · 위험</p>')),
          ].join(""),
        ),
        section(2, "table", at(120, '<svg width="400" height="60"><text x="0" y="20" font-size="15">단위 · 합성</text></svg>') + at(220, narrowDots('<svg width="400" height="60"><text x="0" y="20" font-size="15">단위 · 합성 · KRX</text><text x="0" y="44" font-size="15" font-weight="700">선물·옵션</text></svg>'))),
      ]).replace(`src:${LOCAL_FONT_SRC}`, `src:${fontFileSrc(FONT_PATH!)}`);
      const r = await checkHtml(page);
      const dot = (n: number) => r.fails.filter((f) => f.n === n && f.rule === "B2-dot").map((f) => f.what);
      // 0.56em: the wide form at 400; 0.60em at 800, whose narrow form (0.34em) sets the bound
      expect(dot(1)).toEqual(["구분점 폭 0.56em(0.30em까지)", "구분점 폭 0.60em(0.35em까지)"]);
      expect(dot(2)).toEqual(["구분점 폭 0.56em(0.30em까지)"]);
    },
    60_000,
  );
});

describe.skipIf(!HAS_CHROME || !FONT_PATH)("the three samples, built (DD 0059 §6-1)", () => {
  for (const k of ["a", "b", "c"] as const) {
    test(
      `(${k}) PDF pages = slides, every check passes, the archived page names no file`,
      async () => {
        const font = await loadDeckFont(FONT_PATH);
        // the samples carry pictures at real capture shapes (DD 1704 6)
        const { spec, data } = deckFixture(k, synthCapture);
        const r: DeckBuild = await buildDeck(spec, data, { name: `fixture-${k}`, font, chrome: CHROME, generatedAt: "2026-11-26T23:12:00.000Z" });
        if (!r.ok) throw new Error(`refused: ${r.reason} ${JSON.stringify(r.check?.perSlide.filter((s) => s.fails.length))} ${JSON.stringify(r.check?.deckFails)}`);
        expect(r.check.slides).toBe(spec.slides.length);
        expect(r.check.pdfPages).toBe(spec.slides.length);
        expect(r.check.totals.fails).toBe(0);
        expect(r.check.accepted).toBe(true);
        expect(r.check.totals.minFontPx).toBeGreaterThanOrEqual(14);
        expect(r.check.totals.captures).toBe(k === "b" ? 3 : 4);
        expect(r.check.fonts).toContain(DECK_FACE);
        expect(r.check).toMatchObject({ deck: `fixture-${k}`, generatedAt: "2026-11-26T23:12:00.000Z", dataAsOf: new Date(data.asOf).toISOString(), deckFails: [] });
        expect(r.pngs.length).toBe(spec.slides.length);
        for (const p of r.pngs) expect(pngSize(p)).toEqual({ width: 1280, height: 720 });
        expect(pngSize(r.sheet)).toEqual({ width: 2064, height: 1200 });
        expect(r.html).not.toContain("file:");
        expect(r.html).toContain(`src:${LOCAL_FONT_SRC}`);
        expect(r.pdf.length).toBeLessThanOrEqual(DECK_FILE_MAX);
        expect(new TextEncoder().encode(r.html).length).toBeLessThanOrEqual(DECK_FILE_MAX);
        expect(new TextDecoder("latin1").decode(r.pdf.subarray(0, 8))).toBe("%PDF-1.4");
        if (samplesOut) {
          const dir = join(samplesOut, `fixture-${k}`);
          mkdirSync(join(dir, "slides"), { recursive: true });
          writeFileSync(join(dir, "deck.pdf"), r.pdf);
          writeFileSync(join(dir, "deck.html"), r.html);
          writeFileSync(join(dir, "contact-sheet.png"), r.sheet);
          writeFileSync(join(dir, "deck-check.json"), JSON.stringify(r.check, null, 2));
          r.pngs.forEach((p, i) => writeFileSync(join(dir, "slides", `${String(i + 1).padStart(2, "0")}.png`), p));
        }
      },
      90_000,
    );
  }
  test(
    "an archived page over the 보관함's cap is refused (B2-size)",
    async () => {
      const font = await loadDeckFont(FONT_PATH);
      const { spec, data } = deckFixture("a", () => ({ src: `data:image/png;base64,${"A".repeat(4 * 1024 * 1024)}`, width: 1600, height: 900 }));
      const r = await buildDeck(spec, data, { name: "fixture-a-big", font, chrome: CHROME, generatedAt: "2026-11-26T23:12:00.000Z" });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.reason).toBe("check");
      expect(r.check!.deckFails.map((f) => f.rule)).toContain("B2-size");
      expect(r.check!.deckFails.find((f) => f.rule === "B2-size")!.what).toMatch(/^보관 HTML이 1\d\.\dMB예요\(10MB까지\)$/);
    },
    90_000,
  );
  test(
    "a page that breaks a rendered rule is refused, and the sheet frames that slide",
    async () => {
      const font = await loadDeckFont(FONT_PATH);
      const { spec, data } = deckFixture("a");
      // one source with a name too wide for any footer: its pages run into the right margin
      data.sources.fred = { ...data.sources.fred!, name: "아주 긴 출처 이름이 푸터 한 줄을 다 차지해서 오른쪽 여백까지 밀고 나가요".repeat(3) };
      const r = await buildDeck(spec, data, { name: "fixture-a-wide", font, chrome: CHROME, generatedAt: "2026-11-26T23:12:00.000Z" });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r).toMatchObject({ reason: "check", sentence: CHECK_FAIL, retry: true });
      expect(r.check!.accepted).toBe(false);
      expect(r.check!.pdfPages).toBe(28);
      // the cover's footer names FRED alone: it runs off the page
      expect(r.check!.perSlide[0]!.fails).toContainEqual(expect.objectContaining({ rule: "B2-clip", what: "글자가 장 밖으로 나가요" }));
      // the appendix's source column grows its table past the footer
      expect(r.check!.perSlide[24]!.fails.map((f) => f.rule)).toContain("B2-overlap");
      expect(r.pngs!.length).toBe(28);
      expect(pngSize(r.sheet!)).toEqual({ width: 2064, height: 1200 });
    },
    90_000,
  );
});
