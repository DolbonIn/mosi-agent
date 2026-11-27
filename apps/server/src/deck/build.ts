/**
 * The deck, built (DD 0059 §6, DD 1935 §5-3, lead 0102): the JSON check, then the page in an already-installed Chrome
 * with the font file PICKLE_DECK_FONT names, the rendered-page check, one PNG per slide, the PDF, a contact sheet and
 * deck-check.json. A deck that fails anything is refused: no PDF goes out, and the reason is a sentence.
 *
 * The archived HTML is a second rendering that names the font by local() only: the font file's path and bytes never go
 * into it, so it stays small (the captures it carries are the bulk) and it opens anywhere the font is installed.
 */
import { DISCLAIMER, DISCLAIMER_PLAYBOOK } from "@pickle/quant";
import { pageCheckExpression, type DomReport } from "./check";
import { ChromeMissing, withChrome, type Page } from "./chrome";
import { fontFileSrc, NO_FONT_FAIL, type DeckFont } from "./font";
import { FONT_LICENCE, PAGE_H, PAGE_W, renderDeck } from "./render";
import { FA3 } from "./style";
import type { DeckData, DeckSpec } from "./types";
import { DECK_MAX, DECK_MIN, validateDeck } from "./validate";

/** the 보관함's cap on one file (archive.ts MAX_ATTACHMENT_BYTES): the PDF and the archived HTML each fit under it */
export const DECK_FILE_MAX = 10 * 1024 * 1024;
/** the font face the PDF pass loads (deckCss) */
export const DECK_FACE = "Noto Sans KR VF";

/** the server's sentences when a deck is not made (DD words the last two; NO_FONT_FAIL is DD 0103-b F) */
export const NO_BROWSER_FAIL = "이 서버에 브라우저가 없어서 심층판을 만들지 못했어요.";
export const CHECK_FAIL = "심층판이 검사를 통과하지 못해서 보내지 않았어요.";

export interface SlideCheck {
  n: number;
  kind: string;
  fails: { rule: string; what: string; selector?: string }[];
}

/** deck-check.json (DD 0059 §6-1) */
export interface DeckCheck {
  deck: string;
  slides: number;
  pdfPages: number;
  perSlide: SlideCheck[];
  /** fails that belong to no one slide (the font, the slide count, the file sizes) */
  deckFails: { rule: string; what: string }[];
  totals: { fails: number; minFontPx: number; overlaps: number; clipped: number; levelLinesOutside: number; captures: number };
  fonts: string[];
  generatedAt: string;
  dataAsOf: string;
  accepted: boolean;
}

export type DeckBuild =
  | { ok: true; pdf: Uint8Array; html: string; pngs: Uint8Array[]; sheet: Uint8Array; check: DeckCheck }
  | { ok: false; reason: "font" | "browser" | "check"; sentence: string; retry: boolean; check?: DeckCheck; pngs?: Uint8Array[]; sheet?: Uint8Array };

export interface BuildOptions {
  /** deck-check.json's name for it: fixture-a, daily-2026-11-27, SOXL-2026-11-27 */
  name: string;
  font: DeckFont;
  /** Chrome's executable (PICKLE_DECK_CHROME, else DEFAULT_CHROME) */
  chrome: string;
  /** when the server made it, ISO */
  generatedAt: string;
  timeoutMs?: number;
}

/** DD 0059 §6-2: a deck goes out only with no fails, as many PDF pages as slides, 24–30 slides, the disclaimer word for word */
export function accepted(c: { slides: number; pdfPages: number; fails: number; disclaimerOk: boolean }): boolean {
  return c.fails === 0 && c.pdfPages === c.slides && c.slides >= DECK_MIN && c.slides <= DECK_MAX && c.disclaimerOk;
}

/** the PDF's page count: its page objects, else the page tree's largest /Count */
export function pdfPageCount(pdf: Uint8Array): number {
  const txt = new TextDecoder("latin1").decode(pdf);
  const pages = txt.match(/\/Type\s*\/Page(?![a-zA-Z])/g)?.length ?? 0;
  if (pages) return pages;
  return Math.max(0, ...[...txt.matchAll(/\/Count\s+(\d+)/g)].map((m) => Number(m[1])));
}

/** a PNG's width and height from its IHDR */
export function pngSize(png: Uint8Array): { width: number; height: number } | null {
  if (png.length < 24 || png[0] !== 0x89 || png[1] !== 0x50) return null;
  const v = new DataView(png.buffer, png.byteOffset, png.byteLength);
  return { width: v.getUint32(16), height: v.getUint32(20) };
}

const b64 = (s: string) => Uint8Array.from(Buffer.from(s, "base64"));

/** the contact sheet (DD 1935 §5-3, DD 0059 §6-1): six columns of 320 × 180, number and kind under each, a failing
 * slide framed 2 px in FA3 red */
export function sheetHtml(name: string, files: string[], check: Pick<DeckCheck, "perSlide" | "totals" | "slides">, stamp: string): { html: string; width: number; height: number } {
  const cols = 6;
  const rows = Math.max(1, Math.ceil(files.length / cols));
  const width = 32 * 2 + cols * 320 + (cols - 1) * 16;
  const height = 32 + 34 + rows * (180 + 26) + (rows - 1) * 18 + 32;
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const cells = files
    .map((f, i) => {
      const sc = check.perSlide[i];
      const bad = !!sc && sc.fails.length > 0;
      const rules = bad ? ` · ${[...new Set(sc!.fails.map((x) => x.rule))].join(", ")}` : "";
      return `<div class="c"><img src="${esc(f)}" width="320" height="180" class="${bad ? "bad" : ""}"><div class="l${bad ? " bad" : ""}">${i + 1} · ${esc(sc?.kind ?? "")}${esc(rules)}</div></div>`;
    })
    .join("");
  const head = `${esc(name)} · ${check.slides}장 · 검사 실패 ${check.totals.fails} · ${esc(stamp)}`;
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;background:${FA3.paper}}body{width:${width}px;height:${height}px;padding:32px;box-sizing:border-box;font-family:"${DECK_FACE}",sans-serif}
.h{height:34px;font-size:15px;font-weight:700;color:${FA3.ink2}}
.g{display:grid;grid-template-columns:repeat(${cols},320px);column-gap:16px;row-gap:18px}
.c img{display:block;width:320px;height:180px;outline:1px solid ${FA3.rule};outline-offset:0}
.c img.bad{outline:2px solid ${FA3.red}}
.l{height:26px;line-height:26px;font-size:14px;color:${FA3.ink2};white-space:nowrap;overflow:hidden}
.l.bad{color:${FA3.red};font-weight:700}
</style></head><body><div class="h">${head}</div><div class="g">${cells}</div></body></html>`;
  return { html, width, height };
}

async function shoot(page: Page, x: number, y: number, width: number, height: number): Promise<Uint8Array> {
  const r = await page.cdp.send<{ data: string }>("Page.captureScreenshot", { format: "png", clip: { x, y, width, height, scale: 1 }, captureBeyondViewport: true }, page.session);
  return b64(r.data);
}

/**
 * The deck's two pages, drawn with no browser and no file read. The PDF pass names the font file by URL; the archived
 * copy, the one a person keeps, names the font by local() only, so the file's path and bytes never reach it. Tests hold
 * this with no font and no browser on the machine (lead 1655 D1).
 */
export function deckPages(spec: DeckSpec, data: DeckData, o: { font: { path: string } }): { html: string; archived: string } {
  const html = renderDeck(spec, data, { fontSrc: fontFileSrc(o.font.path) });
  const archived = renderDeck(spec, data);
  return { html, archived };
}

/**
 * Build the deck. Never throws for a deck that cannot be made: the font missing, no browser, a check failed — each is
 * `ok: false` with the sentence the person sees. `retry` says whether making it again could change the answer.
 */
export async function buildDeck(spec: DeckSpec, data: DeckData, o: BuildOptions): Promise<DeckBuild> {
  if (!o.font.ok) return { ok: false, reason: "font", sentence: NO_FONT_FAIL, retry: false };
  const N = spec.slides.length;
  const perSlide: SlideCheck[] = spec.slides.map((s, i) => ({ n: i + 1, kind: s.kind, fails: [] }));
  const deckFails: { rule: string; what: string }[] = [];
  const base = { deck: o.name, slides: N, generatedAt: o.generatedAt, dataAsOf: new Date(data.asOf).toISOString() };
  const finish = (pdfPages: number, dom: DomReport | null): DeckCheck => {
    const fails = perSlide.reduce((a, s) => a + s.fails.length, 0) + deckFails.length;
    const disclaimerOk = !perSlide.some((s) => s.fails.some((f) => f.rule === "B2-disclaimer"));
    return {
      ...base,
      pdfPages,
      perSlide,
      deckFails,
      totals: { fails, minFontPx: dom?.minFontPx ?? 0, overlaps: dom?.overlaps ?? 0, clipped: dom?.clipped ?? 0, levelLinesOutside: dom?.levelLinesOutside ?? 0, captures: dom?.captures ?? 0 },
      fonts: dom?.fonts ?? [],
      accepted: accepted({ slides: N, pdfPages, fails, disclaimerOk }),
    };
  };

  // 1. the JSON: a deck the check refuses is never drawn
  for (const f of validateDeck(spec, data)) {
    const s = f.n != null ? perSlide[f.n - 1] : undefined;
    if (s) s.fails.push({ rule: f.rule, what: f.what });
    else deckFails.push({ rule: f.rule, what: f.what });
  }
  if (deckFails.length || perSlide.some((s) => s.fails.length)) return { ok: false, reason: "check", sentence: CHECK_FAIL, retry: true, check: finish(0, null) };

  // 2. the page: the PDF pass reads the font file; the archived copy names it by local() only
  const { html, archived } = deckPages(spec, data, { font: o.font });
  try {
    const out = await withChrome(
      o.chrome,
      async (page) => {
        const deckFile = `${page.dir}/deck.html`;
        await Bun.write(deckFile, html);
        await page.viewport(PAGE_W, PAGE_H);
        await page.goto(`file://${deckFile}`);
        await page.evaluate("document.fonts.ready.then(() => true)");
        const dom = await page.evaluate<DomReport>(
          pageCheckExpression({ disclaimer: DISCLAIMER, playbook: spec.slides.some((s) => s.kind === "disclaimer" && s.playbook) ? DISCLAIMER_PLAYBOOK : null, licence: FONT_LICENCE, palette: Object.values(FA3), fontFamily: DECK_FACE }),
        );
        const pngs: Uint8Array[] = [];
        for (let i = 0; i < dom.pages; i++) pngs.push(await shoot(page, 0, i * PAGE_H, PAGE_W, PAGE_H));
        const pdf = await page.cdp.send<{ data: string }>(
          "Page.printToPDF",
          { printBackground: true, preferCSSPageSize: true, marginTop: 0, marginBottom: 0, marginLeft: 0, marginRight: 0 },
          page.session,
        );
        return { dom, pngs, pdf: b64(pdf.data) };
      },
      o.timeoutMs,
    );
    const { dom, pngs, pdf } = out;
    for (const f of dom.fails) {
      const s = f.n >= 1 ? perSlide[f.n - 1] : undefined;
      if (s) s.fails.push({ rule: f.rule, what: f.what, ...(f.selector ? { selector: f.selector } : {}) });
      else deckFails.push({ rule: f.rule, what: f.what });
    }
    if (dom.pages !== N) deckFails.push({ rule: "B2-pages", what: `HTML 장 수 ${dom.pages}가 JSON의 ${N}장과 달라요` });
    const pdfPages = pdfPageCount(pdf);
    if (pdfPages !== N) deckFails.push({ rule: "B2-pages", what: `PDF ${pdfPages}쪽이 ${N}장과 달라요` });
    if (pdf.length > DECK_FILE_MAX) deckFails.push({ rule: "B2-size", what: `PDF가 ${(pdf.length / 1048576).toFixed(1)}MB예요(10MB까지)` });
    const htmlBytes = new TextEncoder().encode(archived).length;
    if (htmlBytes > DECK_FILE_MAX) deckFails.push({ rule: "B2-size", what: `보관 HTML이 ${(htmlBytes / 1048576).toFixed(1)}MB예요(10MB까지)` });
    const check = finish(pdfPages, dom);
    const sheet = await drawSheet(o, check, pngs);
    if (!check.accepted) return { ok: false, reason: "check", sentence: CHECK_FAIL, retry: true, check, pngs, sheet };
    return { ok: true, pdf, html: archived, pngs, sheet, check };
  } catch (e) {
    if (e instanceof ChromeMissing) return { ok: false, reason: "browser", sentence: NO_BROWSER_FAIL, retry: false };
    throw e;
  }
}

/** the contact sheet, drawn by a second short Chrome run over the slide PNGs */
async function drawSheet(o: BuildOptions, check: DeckCheck, pngs: Uint8Array[]): Promise<Uint8Array> {
  return withChrome(
    o.chrome,
    async (page) => {
      const files = pngs.map((_, i) => `s-${String(i + 1).padStart(2, "0")}.png`);
      for (let i = 0; i < pngs.length; i++) await Bun.write(`${page.dir}/${files[i]}`, pngs[i]!);
      const stamp = check.generatedAt.replace("T", " ").slice(0, 16) + " UTC";
      const s = sheetHtml(o.name, files, check, stamp);
      await Bun.write(`${page.dir}/sheet.html`, s.html);
      await page.viewport(s.width, s.height);
      await page.goto(`file://${page.dir}/sheet.html`);
      await page.evaluate("Promise.all([...document.images].map((i) => i.decode())).then(() => document.fonts.ready).then(() => true)");
      return shoot(page, 0, 0, s.width, s.height);
    },
    o.timeoutMs,
  );
}
