// Foundation QA — run from the repo root after `bun run --filter './apps/mobile' build`:
//   node apps/mobile/qa/foundation.spec.mjs            (all engines / variants)
//   QA_ENGINES=chromium QA_VARIANTS=light node apps/mobile/qa/foundation.spec.mjs
// Serves dist with `vite preview` (port 4319 by default; QA_PORT overrides), opens /?gallery=1 at 390×844 @3x in Chromium (installed Google Chrome,
// channel "chrome") and WebKit (Playwright revision 2336), light / dark / reduced-motion. For each it screenshots the
// gallery section by section plus live states (sheet, banner, island, call, drawer, tab switch) into
// docs/qa/foundation/*.png, fails on console errors / page errors / horizontal overflow, and records a performance
// pass during a tab-bar drag + sheet open: long tasks > 50 ms (PerformanceObserver + Chromium trace) and a dropped-frame
// estimate from a rAF gap sampler. Results: docs/qa/foundation/results.json.
// MOTION-SPEC §8 checks: idle cost (2 s after load / after a tab round trip: document.getAnimations().length === 0 and
// no requestAnimationFrame callbacks except the guarded WebGL wallpaper's) and the tab transition (old page hidden on
// the next frame, new page opacity > 0.2 at ~50 ms, blurred area ≤ 25 % of the viewport on every frame).
// The undo toast under the call card (§8.13), once per engine in the real chat (it needs the preview's /api, i.e.
// PICKLE_API): while the card covers the toast, the toast is inert, out of the accessibility tree and never reached by
// Tab; a mouse resting on it as the call opens by touch holds it no longer than it held it before the card came.
// The bottom bar's shared blur (BlurGroup), once per engine in the real chat (PICKLE_API too): a box at the top of the
// chrome slot grows the bar 54 px above the composer, as the "새 메시지" capsule does; the blur layer stays on the
// members in the frame the bar grows and in the frame it shrinks back.
// The floor (reduced transparency), once per engine in the real chat (PICKLE_API too): a black z-index 2 block at the
// thread's end is scrolled under the composer; the gap between composer and tab bar and the strip below the tab bar
// stay plain --bg (pixels read back in a canvas), the floor's top is 6 px above the composer and follows it to 4 lines,
// 6 px above the tab bar on 둘러보기, and nothing is drawn with the setting off. Then the same with increased contrast
// from the OS (the context's prefers-contrast: more; tier.ts sets data-contrast="more", transparency stays normal), off
// by turning the media feature back to no-preference.
// While other builders' screens are still missing, build with the stub config and point QA at it:
//   bunx vite build -c apps/mobile/qa/vite.qa.config.mjs && QA_DIST=dist-qa node apps/mobile/qa/foundation.spec.mjs
// Never runs `playwright install`.
import { chromium, webkit } from "playwright";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import zlib from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, "..");
const repo = path.resolve(appDir, "../..");
const outDir = process.env.QA_OUT ? path.resolve(process.env.QA_OUT) : path.join(repo, "docs/qa/foundation");
fs.mkdirSync(outDir, { recursive: true });
// 4173 is often taken by other previews on this machine: use a dedicated port and verify it serves this app
const PORT = Number(process.env.QA_PORT || 4319);
const BASE = `http://127.0.0.1:${PORT}`;
const ENGINES = (process.env.QA_ENGINES || "chromium,webkit").split(",");
const VARIANTS = (process.env.QA_VARIANTS || "light,dark,reduced").split(",");
const DIST = process.env.QA_DIST || "dist";
/** QA_ONLY=motion: just the §8 idle-cost / tab-transition checks · QA_ONLY=toastcall: just the toast under the call ·
 * QA_ONLY=lensoverlay: just the droplet lens under an open sheet (hidden) and on the next tab travel (back) ·
 * QA_ONLY=blurhost: just the bottom bar's blur while the bar grows above the composer · QA_ONLY=floor: just the
 * floor under the composer and the tab bar (reduced transparency, then increased contrast) · QA_OUT: results and shots go
 * there instead of docs/qa/foundation */
const ONLY = process.env.QA_ONLY || "";
const runs = (part) => !ONLY || ONLY === part;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function up() {
  try {
    const r = await fetch(BASE + "/");
    return r.ok && /모시/.test(await r.text());
  } catch {
    return false;
  }
}

async function startServer() {
  if (await up()) return null;
  if (!fs.existsSync(path.resolve(appDir, DIST, "index.html"))) throw new Error(`${DIST} missing — build first`);
  const proc = spawn("bunx", ["vite", "preview", "--outDir", DIST, "--port", String(PORT), "--strictPort", "--host", "127.0.0.1"], { cwd: appDir, stdio: "ignore" });
  for (let i = 0; i < 80; i++) {
    if (await up()) return proc;
    await sleep(150);
  }
  proc.kill();
  throw new Error("vite preview did not start");
}

const SECTIONS = ["settings", "buttons", "segmented", "controls", "list", "fields", "data", "avatars", "island", "sheet", "spotlight", "glass", "swap", "cards", "thread", "icons"];

async function scrollToSection(page, id) {
  await page.evaluate((sid) => {
    const el = document.getElementById(`gal-${sid}`);
    const sc = el?.closest(".screen-scroll");
    if (!el || !sc) return;
    const top = el.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop;
    const clear = parseFloat(getComputedStyle(sc).paddingTop) || 112;
    sc.scrollTo({ top: Math.max(0, top - clear + 4), behavior: "instant" });
  }, id);
  await sleep(450);
}

async function overflow(page) {
  return page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const doc = document.documentElement.scrollWidth - vw;
    const sc = document.querySelector(".screen-scroll");
    const scr = sc ? sc.getBoundingClientRect() : null;
    const offenders = [];
    if (sc && scr) {
      for (const el of sc.querySelectorAll("*")) {
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) continue;
        // ignore content clipped by an overflow-hidden ancestor inside the scroller (marquee-free UI expects none)
        if (r.right > scr.right + 0.5 || r.left < scr.left - 0.5) {
          let clipped = false;
          for (let p = el.parentElement; p && p !== sc; p = p.parentElement) {
            const o = getComputedStyle(p);
            if (o.overflowX !== "visible" || o.clipPath !== "none") {
              const pr = p.getBoundingClientRect();
              if (pr.right <= scr.right + 0.5 && pr.left >= scr.left - 0.5) {
                clipped = true;
                break;
              }
            }
          }
          if (!clipped) offenders.push(`${el.tagName.toLowerCase()}.${String(el.className).slice(0, 40)} [${Math.round(r.left)}–${Math.round(r.right)}]`);
        }
      }
    }
    return { doc, scroller: sc ? sc.scrollWidth - sc.clientWidth : 0, offenders: offenders.slice(0, 8) };
  });
}

async function shot(page, name) {
  const file = path.join(outDir, `${name}.png`);
  await page.screenshot({ path: file });
  return path.relative(repo, file);
}

/**
 * The active tab label on its droplet, measured on the real render (DESIGN.md: text ≥4.5:1 in every theme). For each
 * of several scroll positions (content passing under the bar changes the blurred backdrop): the page's top and bottom,
 * and the top, ¼, mid, ¾ and bottom of the gallery's list and of its thread with cards (bubbles, a card with a filled
 * button, a card with tiles), each point placed at the bar's centre line,
 * the tab bar is screenshotted and decoded in the page (canvas); droplet pixels away from the glyphs and the rim give
 * the background. Worst case = the background percentile nearest the label (2nd for a dark label, 98th for a light
 * one), against the label's computed colour. Also the droplet's median luminance against the bar's (the selection has
 * to read: ratio ≥ 1.1).
 */
async function tabLabelContrast(page) {
  const points = [0, 0.25, 0.5, 0.75, 1];
  const positions = [
    { surface: "page", sel: null, f: 0 },
    { surface: "page", sel: null, f: 1 },
    ...points.map((f) => ({ surface: "list", sel: "#gal-list .list-card", f })),
    ...points.map((f) => ({ surface: "thread", sel: "#gal-thread .gal-thread", f })),
  ];
  const per = [];
  for (const pos of positions) {
    const geo = await page.evaluate(({ sel, f }) => {
      const sc = document.elementFromPoint(innerWidth / 2, innerHeight / 2)?.closest(".screen-scroll");
      const barEl = document.querySelector(".tabbar");
      if (!sc || !barEl) return null;
      const max = sc.scrollHeight - sc.clientHeight;
      let want = max * f;
      if (sel) {
        // put the point at fraction f of the surface on the bar's centre line
        const el = document.querySelector(sel);
        if (!el) return { missing: sel };
        const e = el.getBoundingClientRect(), s = sc.getBoundingClientRect(), b = barEl.getBoundingClientRect();
        want = e.top - s.top + sc.scrollTop + e.height * f - (b.top + b.height / 2 - s.top);
      }
      const top = Math.max(0, Math.min(max, want));
      sc.scrollTo({ top, behavior: "instant" });
      const box = (el) => {
        const b = el.getBoundingClientRect();
        return { x: b.left, y: b.top, w: b.width, h: b.height };
      };
      const on = document.querySelector(".tab-item[data-on] .tab-label");
      const droplet = document.querySelector(".tab-droplet");
      const bar = document.querySelector(".tabbar");
      if (!on || !droplet || !bar) return null;
      return {
        bar: box(bar),
        barR: parseFloat(getComputedStyle(bar).borderTopLeftRadius) || 0,
        droplet: box(droplet),
        dropletR: parseFloat(getComputedStyle(droplet).borderTopLeftRadius) || 0,
        glyphs: [...bar.querySelectorAll(".tab-icon, .tab-label")].map(box),
        label: getComputedStyle(on).color,
        clamped: Math.abs(top - want) > 2,
      };
    }, pos);
    if (!geo) return { ratio: null, why: "no active tab / droplet / bar" };
    if (geo.missing) return { ratio: null, why: `no ${geo.missing} in the gallery` };
    await sleep(300);
    const clip = { x: Math.floor(geo.bar.x), y: Math.floor(geo.bar.y), width: Math.ceil(geo.bar.w), height: Math.ceil(geo.bar.h) };
    const b64 = (await page.screenshot({ clip, scale: "css" })).toString("base64");
    per.push({
      at: pos.sel ? `${pos.surface} ${{ 0: "top", 0.25: "¼", 0.5: "mid", 0.75: "¾", 1: "bottom" }[pos.f]}` : `page ${pos.f ? "bottom" : "top"}`,
      surface: pos.surface,
      clamped: geo.clamped,
      ...(await page.evaluate(
        async ({ b64, geo, clip }) => {
          const img = new Image();
          img.src = `data:image/png;base64,${b64}`;
          await img.decode();
          const cv = document.createElement("canvas");
          cv.width = img.width;
          cv.height = img.height;
          const ctx = cv.getContext("2d");
          ctx.drawImage(img, 0, 0);
          const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
          ctx.fillStyle = "#000";
          ctx.fillStyle = geo.label;
          const lv = ctx.fillStyle;
          const label = lv.startsWith("#") ? [1, 3, 5].map((i) => parseInt(lv.slice(i, i + 2), 16)) : lv.match(/[\d.]+/g).slice(0, 3).map(Number);
          const lum = ([r, g, b]) => {
            const t = (c) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
            return 0.2126 * t(r) + 0.7152 * t(g) + 0.0722 * t(b);
          };
          // inside a rounded rect shrunk by `inset` (negative grows it)
          const inRR = (x, y, R, rad, inset) => {
            const x0 = R.x + inset, y0 = R.y + inset, x1 = R.x + R.w - inset, y1 = R.y + R.h - inset;
            if (x < x0 || x > x1 || y < y0 || y > y1) return false;
            const r = Math.max(0, Math.min(rad - inset, (x1 - x0) / 2, (y1 - y0) / 2));
            const cx = Math.min(Math.max(x, x0 + r), x1 - r), cy = Math.min(Math.max(y, y0 + r), y1 - r);
            return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
          };
          const nearGlyph = (x, y) => geo.glyphs.some((b) => x >= b.x - 3 && x <= b.x + b.w + 3 && y >= b.y - 3 && y <= b.y + b.h + 3);
          const sx = cv.width / clip.width;
          const drop = [], bar = [];
          for (let j = 0; j < cv.height; j++)
            for (let i = 0; i < cv.width; i++) {
              const x = clip.x + (i + 0.5) / sx, y = clip.y + (j + 0.5) / sx;
              if (nearGlyph(x, y)) continue;
              const k = (j * cv.width + i) * 4;
              const px = [d[k], d[k + 1], d[k + 2]];
              if (inRR(x, y, geo.droplet, geo.dropletR, 3)) drop.push(px);
              else if (inRR(x, y, geo.bar, geo.barR, 6) && !inRR(x, y, geo.droplet, geo.dropletR, -5)) bar.push(px);
            }
          if (drop.length < 50 || bar.length < 50) return { error: `too few pixels (droplet ${drop.length}, bar ${bar.length})` };
          const byLum = (a) => a.map((p) => [lum(p), p]).sort((m, n) => m[0] - n[0]);
          const dl = byLum(drop), bl = byLum(bar);
          const q = (a, f) => a[Math.min(a.length - 1, Math.max(0, Math.round(f * (a.length - 1))))];
          const L = lum(label);
          const darkLabel = L < q(dl, 0.5)[0];
          const worst = darkLabel ? q(dl, 0.02) : q(dl, 0.98);
          const ratio = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
          const hex = (c) => "#" + c.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
          return {
            ratio: Math.round(ratio(L, worst[0]) * 100) / 100,
            label: hex(label),
            worstBg: hex(worst[1]),
            medianBg: hex(q(dl, 0.5)[1]),
            dropletVsBar: Math.round(ratio(q(dl, 0.5)[0], q(bl, 0.5)[0]) * 1000) / 1000,
            pixels: { droplet: drop.length, bar: bar.length },
          };
        },
        { b64, geo, clip },
      )),
    });
  }
  const bad = per.find((x) => x.error);
  if (bad) return { ratio: null, why: bad.error };
  const worstOf = (a) => a.reduce((m, x) => (x.ratio < m.ratio ? x : m));
  const w = worstOf(per);
  const bySurface = {};
  for (const sf of new Set(per.map((x) => x.surface))) {
    const ws = worstOf(per.filter((x) => x.surface === sf));
    bySurface[sf] = { ratio: ws.ratio, at: ws.at, on: ws.worstBg };
  }
  return {
    ratio: w.ratio,
    label: w.label,
    on: w.worstBg,
    at: w.at,
    dropletVsBar: Math.min(...per.map((x) => x.dropletVsBar)),
    bySurface,
    clamped: per.filter((x) => x.clamped).map((x) => x.at),
    perScroll: per.map((x) => ({ at: x.at, ratio: x.ratio, worstBg: x.worstBg, medianBg: x.medianBg, dropletVsBar: x.dropletVsBar })),
  };
}

/**
 * §8.13 (lead's rule, 2026-11-12): a banner never takes a tap meant for something else. It drops from the island to rest
 * BELOW the top bar (the bar stays visible and 메뉴 stays hittable): a tap on 메뉴 opens the drawer and the banner
 * leaves; a tap elsewhere (a tab) lands and dismisses it; the mouse resting on its content still holds it.
 */
async function bannerTaps(page, btn, reduced) {
  const out = {};
  const gone = (ms) =>
    page.waitForFunction(() => !document.querySelector(".banner-anchor"), null, { timeout: ms }).then(
      () => true,
      () => false,
    );
  const centre = async (loc) => {
    const b = await loc.boundingBox();
    return [b.x + b.width / 2, b.y + b.height / 2];
  };
  const menu = page.locator(".topbar .tb-circle").first();
  const [mx, my] = await centre(menu);

  // the entrance: the box travels from the island (y ≈ 11) down to its place and settles within 500 ms of mounting
  // (screens-chat's chat.spec measures 500 ms after it appears); reduced motion: no travel, a fade in place
  const travel = page.evaluate(async () => {
    const f = [];
    let t0 = null;
    const start = performance.now();
    while (performance.now() - start < 1500 && (t0 === null || performance.now() - t0 < 900)) {
      const b = document.querySelector(".banner-anchor .banner");
      if (b) {
        t0 ??= performance.now();
        const o = +getComputedStyle(b.parentElement).opacity;
        const text = b.querySelector(".banner-text").getBoundingClientRect();
        f.push({
          t: Math.round(performance.now() - t0),
          y: Math.round(new DOMMatrixReadOnly(getComputedStyle(b).transform).m42),
          o,
          // the banner's text inside the top bar's band, and how visible it is there
          over: text.top < document.querySelector(".topbar").getBoundingClientRect().bottom,
          co: o * +getComputedStyle(b.querySelector(".banner-content")).opacity,
        });
      }
      await new Promise((r) => requestAnimationFrame(r));
    }
    return f;
  });
  await btn("배너").click();
  const fr = await travel;
  const visible = fr.filter((x) => x.o > 0.01);
  out.travelFirst = fr[0]?.y ?? null;
  out.travelLast = fr.at(-1)?.y ?? null;
  // settled: from this frame on, in place and opaque
  const settledAt = fr.findIndex((_, i) => fr.slice(i).every((x) => Math.abs(x.y) <= 1 && x.o >= 0.99));
  out.settleMs = settledAt < 0 ? null : fr[settledAt].t;
  out.travelOk =
    (reduced ? fr.every((x) => x.y === 0) && fr.some((x) => x.o > 0.05 && x.o < 0.95) : fr.length > 3 && visible[0]?.y < -60) &&
    out.settleMs !== null &&
    out.settleMs <= 500;
  // never banner text over the top bar's title on the way down
  out.textOverBarMax = Math.max(0, ...fr.filter((x) => x.over).map((x) => +x.co.toFixed(3)));
  out.textClearOfBar = out.textOverBarMax <= 0.05;
  const geo = await page.evaluate(
    ([x, y]) => {
      const bar = document.querySelector(".topbar");
      const box = document.querySelector(".banner-anchor .banner").getBoundingClientRect();
      return {
        menuHit: !!document.elementFromPoint(x, y)?.closest(".topbar .tb-circle"),
        barOpacity: getComputedStyle(bar).opacity,
        gap: Math.round(box.top - bar.getBoundingClientRect().bottom),
      };
    },
    [mx, my],
  );
  out.menuHittable = geo.menuHit && geo.barOpacity === "1";
  out.belowBar = geo.gap >= 4;
  out.gap = geo.gap;
  await page.touchscreen.tap(mx, my);
  await sleep(1000);
  out.menuOpened = await page.evaluate(() => !!document.querySelector(".drawer:not([aria-hidden])"));
  out.leftOnMenu = await gone(1500);
  await page.keyboard.press("Escape");
  await sleep(1000);

  await btn("배너").click();
  await sleep(700);
  const tab = page.getByRole("tab", { name: "나의 모시" });
  await page.touchscreen.tap(...(await centre(tab)));
  await sleep(500);
  out.tabLanded = (await tab.getAttribute("aria-selected")) === "true";
  out.leftOnOutside = await gone(1500);
  await page.getByRole("tab", { name: "채팅" }).click();
  await sleep(900);

  // a resting mouse pauses the hold, but 8 s at most in all (island.BANNER_CAP_MS)
  await scrollToSection(page, "island");
  await btn("배너").click();
  const shownAt = Date.now();
  await sleep(500);
  const [bx, by] = await centre(page.locator(".banner-anchor .banner"));
  await page.mouse.move(bx, by);
  await sleep(5000); // hold ≈ 3.4 s
  out.heldWithMouseOnContent = await page.evaluate(() => !!document.querySelector(".banner-anchor"));
  out.cappedWithMouseResting = await gone(5000);
  out.cappedAfterMs = Date.now() - shownAt;
  out.capOk = out.cappedWithMouseResting && out.cappedAfterMs >= 7800 && out.cappedAfterMs <= 9800;
  await page.mouse.move(195, 700);
  out.ok = ["travelOk", "textClearOfBar", "menuHittable", "belowBar", "menuOpened", "leftOnMenu", "tabLanded", "leftOnOutside", "heldWithMouseOnContent", "capOk"].every((k) => out[k]);
  return out;
}

// the long-title gallery sheet is open (a footer under a body taller than the sheet): its body's scroll edges
// (Sheet.tsx/Sheet.css, like Screen's top edge), at the top, at a middle position and at the end. Top edge: at rest the
// first row keeps its ink; scrolled so the second row is cut by the head, the 12 px under the head are thinned. Bottom
// edge: with a row cut by the footer, the 12 px above it are thinned while more is below; at the end the last row keeps
// its ink and nothing is flagged. Ink is compared with the same pixels, the mask off inline. Before, cut rows sat at full
// contrast against the head and the footer. Reduced transparency keeps the thinning (the sheet is opaque, no lines);
// increased contrast drops it for lines under the head and above the footer. Leaves the body at the top.
async function sheetEdge(page) {
  const settle = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 60)))));
  const geo = () =>
    page.evaluate(() => {
      const panel = document.querySelector(".sheet-panel");
      const head = panel?.querySelector(".sheet-head");
      const body = panel?.querySelector(".sheet-body");
      const titles = body ? [...body.querySelectorAll(".list-row-title")] : [];
      if (!head || !body || titles.length < 3) return null;
      const text = (el) => {
        const r = document.createRange();
        r.selectNodeContents(el);
        const b = r.getBoundingClientRect();
        return { x: b.x, y: b.y, w: b.width, h: b.height };
      };
      return {
        headBottom: head.getBoundingClientRect().bottom,
        bodyBottom: body.getBoundingClientRect().bottom,
        scrollTop: body.scrollTop,
        max: body.scrollHeight - body.clientHeight,
        rows: titles.map(text),
        scrolled: panel.hasAttribute("data-scrolled"),
        more: panel.hasAttribute("data-more"),
        footer: !!panel.querySelector(".sheet-footer"),
      };
    });
  const scrollTo = async (y) => {
    await page.evaluate((y) => (document.querySelector(".sheet-panel .sheet-body").scrollTop = y), y);
    await settle();
    return geo();
  };
  // the same pixels with the body's mask switched off inline: what the edge would show without the thinning
  const plain = (off) =>
    page.evaluate((off) => {
      const b = document.querySelector(".sheet-panel .sheet-body");
      for (const p of ["mask-image", "-webkit-mask-image"]) off ? b.style.setProperty(p, "none") : b.style.removeProperty(p);
    }, off);
  // ink: mean |luminance − the region's median| (the text against its sheet); contrast: the 98th-percentile pixel's
  // WCAG ratio to the median
  const ink = async (r) => {
    const clip = { x: Math.floor(r.x), y: Math.floor(r.y), width: Math.ceil(r.w), height: Math.ceil(r.h) };
    const b64 = (await page.screenshot({ clip, scale: "css" })).toString("base64");
    return page.evaluate(async (b64) => {
      const img = new Image();
      img.src = `data:image/png;base64,${b64}`;
      await img.decode();
      const cv = document.createElement("canvas");
      cv.width = img.width;
      cv.height = img.height;
      const ctx = cv.getContext("2d");
      ctx.drawImage(img, 0, 0);
      const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
      const t = (c) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
      const L = [];
      for (let k = 0; k < d.length; k += 4) L.push(0.2126 * t(d[k]) + 0.7152 * t(d[k + 1]) + 0.0722 * t(d[k + 2]));
      const med = [...L].sort((a, b) => a - b)[Math.floor(L.length / 2)];
      const dev = L.map((l) => [Math.abs(l - med), l]).sort((a, b) => a[0] - b[0]);
      const far = dev[Math.min(dev.length - 1, Math.round(0.98 * (dev.length - 1)))][1];
      return { ink: L.reduce((s, l) => s + Math.abs(l - med), 0) / L.length, contrast: Math.round(((Math.max(far, med) + 0.05) / (Math.min(far, med) + 0.05)) * 100) / 100 };
    }, b64);
  };
  const r2 = (x) => Math.round(x * 100) / 100;
  const vs = async (r) => {
    const a = await ink(r);
    await plain(true);
    await settle();
    const b = await ink(r);
    await plain(false);
    await settle();
    return { k: r2(a.ink / b.ink), contrast: a.contrast, plainContrast: b.contrast };
  };
  const pad = (r) => ({ x: r.x - 1, y: r.y - 1, w: r.w + 2, h: r.h + 2 });
  const g = await geo();
  if (!g || !g.footer || g.max < 120) return null;
  // the top: the first row at rest
  const first = await vs(pad(g.rows[0]));
  // the head edge: the second row's title cut by the head, its top 5 px above the head's bottom
  const headAt = Math.round(g.rows[1].y - g.headBottom + 5);
  const h = await scrollTo(headAt);
  const headEdge = await vs({ x: h.rows[1].x, y: h.headBottom, w: h.rows[1].w, h: 12 });
  // a middle position: the first title below the body's end, scrolled until its top is 7 px above that end (cut by the
  // footer), the head edge still on
  const below = h.rows.findIndex((r) => r.y > h.bodyBottom);
  if (below < 0) return null;
  const footAt = Math.round(h.scrollTop + h.rows[below].y - (h.bodyBottom - 7));
  const m = await scrollTo(footAt);
  const footEdge = await vs({ x: m.rows[below].x, y: m.bodyBottom - 12, w: m.rows[below].w, h: 12 });
  // reduced transparency and increased contrast here, with both edges on (the root flags tier.ts sets, restored after)
  const mode = (key, value) =>
    page.evaluate(
      async ({ key, value }) => {
        const root = document.documentElement;
        const was = root.dataset[key];
        root.dataset[key] = value;
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        const cs = getComputedStyle(document.querySelector(".sheet-panel .sheet-body"));
        const drawn = (el, pseudo) => {
          const s = getComputedStyle(el, pseudo);
          return s.content !== "none" && s.content !== "normal" && parseFloat(s.height) >= 0.5;
        };
        const lines = [drawn(document.querySelector(".sheet-panel .sheet-head"), "::after") && "head", drawn(document.querySelector(".sheet-panel .sheet-footer"), "::before") && "footer"].filter(Boolean);
        const mask = cs.maskImage || cs.webkitMaskImage; // read before the flag goes back: computed styles are live
        if (was === undefined) delete root.dataset[key];
        else root.dataset[key] = was;
        return { mask, lines: lines.join("+") || "none" };
      },
      { key, value },
    );
  const reducedT = await mode("transparency", "reduce");
  const contrast = await mode("contrast", "more");
  // the end: the last row at rest, nothing below
  const e = await scrollTo(g.max + 50);
  const lastRow = await vs(pad(e.rows[e.rows.length - 1]));
  const t = await scrollTo(0);
  const out = {
    firstRowInk: first.k,
    top: { scrolled: g.scrolled, more: g.more, clearedAgain: !t.scrolled },
    headAt,
    headEdge,
    footAt,
    footEdge,
    mid: { scrolled: m.scrolled, more: m.more },
    endAt: e.scrollTop,
    lastRowInk: lastRow.k,
    end: { scrolled: e.scrolled, more: e.more },
    reducedT,
    contrast,
  };
  out.ok =
    out.firstRowInk >= 0.97 &&
    !g.scrolled &&
    g.more &&
    out.top.clearedAgain &&
    headEdge.k <= 0.7 &&
    footEdge.k <= 0.7 &&
    m.scrolled &&
    m.more &&
    out.lastRowInk >= 0.97 &&
    !e.more &&
    reducedT.mask !== "none" &&
    reducedT.lines === "none" &&
    contrast.mask === "none" &&
    contrast.lines === "head+footer";
  return out;
}

async function runVariant(browserType, engine, variant) {
  const launchOpts = engine === "chromium" ? { channel: "chrome" } : {};
  const browser = await browserType.launch(launchOpts);
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    colorScheme: variant === "dark" ? "dark" : "light",
    reducedMotion: variant === "reduced" ? "reduce" : "no-preference",
    locale: "ko-KR",
  });
  const page = await context.newPage();
  const errors = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  const shots = [];
  const overflows = [];
  const tag = `${engine}-${variant}`;

  await page.goto(`${BASE}/?gallery=1&gl=force`, { waitUntil: "load" });
  await page.waitForSelector("#gal-settings");
  await sleep(2200); // fonts, idle-loaded wallpaper chunk fade-in
  const wallpaper = await page.evaluate(() => document.querySelector(".wallpaper")?.getAttribute("data-wallpaper"));
  shots.push(await shot(page, `${tag}-00-top`));
  overflows.push({ at: "top", ...(await overflow(page)) });

  for (const [i, id] of SECTIONS.entries()) {
    if (id === "settings") continue;
    await scrollToSection(page, id);
    shots.push(await shot(page, `${tag}-${String(i).padStart(2, "0")}-${id}`));
    overflows.push({ at: id, ...(await overflow(page)) });
  }

  // live states — the agent-state vocabulary (§8.3)
  await scrollToSection(page, "island");
  const btn = (name) => page.getByRole("button", { name, exact: true });
  await btn("도구").click();
  await sleep(2400); // past 2 s → elapsed seconds appear
  shots.push(await shot(page, `${tag}-s1-island-tool`));
  await btn("+16초").click();
  await sleep(700);
  shots.push(await shot(page, `${tag}-s1b-island-stalled`));
  await btn("완료").click();
  await sleep(500);
  shots.push(await shot(page, `${tag}-s2-island-done`));
  await sleep(1500); // back to idle
  await btn("오류").click();
  await sleep(600);
  shots.push(await shot(page, `${tag}-s2b-island-error`));
  await btn("대기").click();
  await btn("통화").click();
  await sleep(900);
  shots.push(await shot(page, `${tag}-s3-call-expanded`));
  await page.getByRole("button", { name: "통화 종료" }).click();
  await sleep(600);
  await btn("배너").click();
  await sleep(800);
  shots.push(await shot(page, `${tag}-s4-banner`));
  await sleep(4200);
  await btn("실행 취소 배너").click();
  await sleep(800);
  shots.push(await shot(page, `${tag}-s4b-banner-undo`));
  await page.getByRole("button", { name: "실행 취소", exact: true }).click();
  await sleep(900);
  await btn("오류 배너").click();
  await sleep(800);
  shots.push(await shot(page, `${tag}-s4c-banner-error`));
  await sleep(2700); // hold ≈ 2.9 s, then the shape contracts into a red dot at the island
  shots.push(await shot(page, `${tag}-s4d-error-dot`));
  await sleep(1200);
  const banner = await bannerTaps(page, btn, variant === "reduced");
  if (!banner.ok) errors.push(`banner taps (§8.13): ${JSON.stringify(banner)}`);

  // bottom slot with a demo composer; the tab bar never changes size (§8.8 minimise removed): scroll both ways and
  // check the bar keeps its rect and never overlaps the composer
  await page.getByRole("switch", { name: "컴포저" }).click();
  await sleep(500);
  shots.push(await shot(page, `${tag}-s8a-composer`));
  const rects = () =>
    page.evaluate(() => {
      const r = (el) => (el ? el.getBoundingClientRect().toJSON() : null);
      return { bar: r(document.querySelector(".bottom-chrome .tabbar")), comp: r(document.querySelector(".chrome-slot > *")) };
    });
  const before = await rects();
  await page.evaluate(() => {
    const sc = document.querySelector(".tab-layer[data-active] .screen-scroll");
    sc.scrollTop += 600;
  });
  await sleep(150);
  await page.evaluate(() => {
    const sc = document.querySelector(".tab-layer[data-active] .screen-scroll");
    sc.scrollTop -= 300;
  });
  await sleep(600);
  const after = await rects();
  shots.push(await shot(page, `${tag}-s8b-composer-scrolled`));
  const same = (a, b) => a && b && Math.abs(a.x - b.x) < 0.5 && Math.abs(a.width - b.width) < 0.5 && Math.abs(a.height - b.height) < 0.5;
  const overlap = (a, b) => a && b && a.bottom > b.top + 0.5 && b.bottom > a.top + 0.5;
  if (!same(before.bar, after.bar)) errors.push(`tab bar changed while scrolling: ${JSON.stringify(before.bar)} → ${JSON.stringify(after.bar)}`);
  if (overlap(after.bar, after.comp)) errors.push(`tab bar overlaps the composer: ${JSON.stringify(after)}`);
  await page.getByRole("switch", { name: "컴포저" }).click();
  await sleep(700);

  // high-risk confirm (§8.6): step two of the two-step tap, then a hold in progress
  await scrollToSection(page, "buttons");
  const confirm = page.getByRole("button", { name: "39,000원 결제하기" });
  await confirm.click();
  await sleep(500);
  shots.push(await shot(page, `${tag}-s9a-confirm-step2`));
  await sleep(3200); // the question times out
  const cb = await confirm.boundingBox();
  if (cb) {
    await page.mouse.move(cb.x + cb.width / 2, cb.y + cb.height / 2);
    await page.mouse.down();
    await sleep(600);
    shots.push(await shot(page, `${tag}-s9b-confirm-holding`));
    await page.mouse.up();
    await sleep(500);
  }

  // white words on a filled confirm — the destructive step two (solid red) and the primary one — ≥4.5:1 in every
  // theme, at rest and under the hold fill
  const measureFill = (sel) =>
    page.evaluate((sel) => {
      const b = document.querySelector(sel);
      if (!b) return null;
      const rgb = (s) => (s.match(/[\d.]+/g) || []).map(Number);
      const lum = ([r, g, bb]) => {
        const f = (v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
        return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(bb);
      };
      const ratio = (a, c) => {
        const [x, y] = [lum(a), lum(c)].sort((m, n) => n - m);
        return Math.round(((x + 0.05) / (y + 0.05)) * 100) / 100;
      };
      const bg = rgb(getComputedStyle(b).backgroundColor);
      const fg = rgb(getComputedStyle(b).color);
      const hold = b.querySelector(".btn-hold");
      const ov = hold ? rgb(getComputedStyle(hold).backgroundColor) : null; // rgba: the fill laid over while held
      const held = ov && ov.length === 4 ? bg.slice(0, 3).map((v, i) => v * (1 - ov[3]) + ov[i] * ov[3]) : bg;
      return { bg: getComputedStyle(b).backgroundColor, fg: getComputedStyle(b).color, ratio: ratio(fg, bg), held: ratio(fg, held) };
    }, sel);
  const primaryConfirm = await measureFill('.btn[data-tone="primary"]:has(.btn-hold)');
  if (!primaryConfirm || primaryConfirm.ratio < 4.5 || primaryConfirm.held < 4.5) errors.push(`primary confirm below 4.5:1: ${JSON.stringify(primaryConfirm)}`);
  const danger = page.getByRole("button", { name: "연결 해제" });
  let dangerConfirm = null;
  if (await danger.count()) {
    await danger.click();
    await sleep(500);
    shots.push(await shot(page, `${tag}-s9c-confirm-destructive`));
    dangerConfirm = await measureFill('.btn[data-tone="destructive"][data-confirming]');
    if (!dangerConfirm || dangerConfirm.ratio < 4.5 || dangerConfirm.held < 4.5) errors.push(`destructive confirm step two below 4.5:1: ${JSON.stringify(dangerConfirm)}`);
    await sleep(3200); // the question times out
  }

  await scrollToSection(page, "sheet");
  await page.locator(".gal-sheet-btn").click();
  await sleep(1000);
  shots.push(await shot(page, `${tag}-s5-sheet`));
  overflows.push({ at: "sheet", ...(await overflow(page)) });
  await page.keyboard.press("Escape");
  await sleep(900);

  // a start-aligned two-line title over a body taller than the sheet: the title's last line ends inside the head
  // (Sheet.css .sheet-head flex: none). Before, the panel's flex column squeezed the head to its 52 px min-height and
  // the second line ran ~12 px down into the body.
  await page.locator(".gal-longsheet-btn").click();
  await sleep(1000);
  const sheetHead = await page.evaluate(() => {
    const panel = document.querySelector(".sheet-panel");
    const head = panel?.querySelector(".sheet-head");
    const title = head?.querySelector(".sheet-title");
    const body = panel?.querySelector(".sheet-body");
    if (!head || !title || !body) return null;
    const range = document.createRange();
    range.selectNodeContents(title);
    const rects = [...range.getClientRects()].filter((r) => r.width > 0);
    const h = head.getBoundingClientRect();
    return {
      lines: new Set(rects.map((r) => Math.round(r.top))).size,
      headPx: Math.round(h.height * 10) / 10,
      titlePastHeadPx: Math.round((Math.max(...rects.map((r) => r.bottom)) - h.bottom) * 10) / 10,
      bodyScrolls: body.scrollHeight > body.clientHeight + 1,
    };
  });
  if (sheetHead) sheetHead.ok = sheetHead.lines >= 2 && sheetHead.bodyScrolls && sheetHead.titlePastHeadPx <= 0.5;
  shots.push(await shot(page, `${tag}-s5b-sheet-long-title`));
  overflows.push({ at: "sheet-long-title", ...(await overflow(page)) });
  const sheetEdgeResult = await sheetEdge(page);
  if (sheetEdgeResult?.footAt) {
    await page.evaluate((by) => (document.querySelector(".sheet-panel .sheet-body").scrollTop = by), sheetEdgeResult.footAt);
    await sleep(300);
    shots.push(await shot(page, `${tag}-s5c-sheet-scrolled`));
    // the same place with increased contrast (lines under the head and above the footer), then the end
    const contrastWas = await page.evaluate(() => {
      const was = document.documentElement.dataset.contrast;
      document.documentElement.dataset.contrast = "more";
      return was ?? null;
    });
    await sleep(200);
    shots.push(await shot(page, `${tag}-s5d-sheet-scrolled-contrast`));
    await page.evaluate((was) => (was == null ? delete document.documentElement.dataset.contrast : (document.documentElement.dataset.contrast = was)), contrastWas);
    await page.evaluate(() => (document.querySelector(".sheet-panel .sheet-body").scrollTop = 1e5));
    await sleep(300);
    shots.push(await shot(page, `${tag}-s5e-sheet-end`));
    await page.evaluate(() => (document.querySelector(".sheet-panel .sheet-body").scrollTop = 0));
    await sleep(200);
  }
  await page.keyboard.press("Escape");
  await sleep(900);

  await page.getByRole("button", { name: "메뉴" }).click();
  await sleep(1100);
  shots.push(await shot(page, `${tag}-s6-drawer`));
  await page.keyboard.press("Escape");
  await sleep(1000);

  await page.getByRole("tab", { name: "나의 모시" }).click();
  await sleep(900);
  shots.push(await shot(page, `${tag}-s7-tab-profile`));
  await page.getByRole("tab", { name: "채팅" }).click();
  await sleep(700);

  const lensInDom = await page.evaluate(() => document.querySelectorAll(".lqg-lens").length);
  const tabLabel = await tabLabelContrast(page);
  await browser.close();
  return { engine, variant, wallpaper, lensInDom, errors, shots, overflows, tabLabel, dangerConfirm, primaryConfirm, banner, sheetHead, sheetEdge: sheetEdgeResult };
}

// ── desktop: the 402 × 874 device frame centred on the stage (fine pointer → adaptive pointer) ──
async function desktop(browserType, engine, scheme) {
  const browser = await browserType.launch(engine === "chromium" ? { channel: "chrome" } : {});
  const page = await browser.newPage({ viewport: { width: 1280, height: 960 }, deviceScaleFactor: 2, colorScheme: scheme, locale: "ko-KR" });
  const errors = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  await page.goto(`${BASE}/?gallery=1&gl=force`, { waitUntil: "load" });
  await page.waitForSelector("#gal-settings");
  await sleep(2200);
  const btn = await page.getByRole("button", { name: "도구", exact: true }).boundingBox();
  await scrollToSection(page, "buttons");
  // hover a control so the adaptive pointer snaps into it
  const target = await page.getByRole("button", { name: "티켓 사용하기" }).boundingBox();
  if (target) await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 6 });
  await sleep(600);
  const file = await shot(page, `${engine}-desktop-${scheme}`);
  const frame = await page.evaluate(() => document.querySelector(".stage")?.getAttribute("data-frame"));
  await browser.close();
  return { engine, scheme, frame, errors, shot: file, sawIslandButton: !!btn };
}

// ── MOTION-SPEC §8.16 idle cost + §8.2 tab transition ──
// counts requestAnimationFrame registrations while `on`, attributing each by its stack: the WebGL wallpaper (its own
// lazy chunk + the R3F chunk) is allowed, anything else is a loop on an idle screen
const RAF_PROBE = `(() => {
  const orig = window.requestAnimationFrame.bind(window);
  const w = window;
  w.__raf = { on: false, n: 0, stacks: {} };
  window.requestAnimationFrame = function (cb) {
    const p = w.__raf;
    if (p.on) {
      p.n++;
      // every rAF counts (the wallpaper is static CSS: there is no exempt loop any more); stacks name the culprit
      const st = (new Error().stack || "").split("\\n").slice(1).join(" ");
      const key = st.replace(/https?:\\/\\/[^/]+/g, "").slice(0, 240);
      p.stacks[key] = (p.stacks[key] || 0) + 1;
    }
    return orig(cb);
  };
})();`;

async function sampleIdle(page) {
  return page.evaluate(async () => {
    const list = document.getAnimations().map((a) => {
      const tgt = a.effect && a.effect.target;
      const cls = tgt ? String((tgt.className && tgt.className.baseVal) ?? tgt.className ?? "") : "";
      return { kind: a.constructor.name, name: a.animationName || a.transitionProperty || a.id || "", state: a.playState, target: `${tgt ? tgt.tagName.toLowerCase() : "?"}.${cls.slice(0, 50)}` };
    });
    const p = window.__raf;
    p.n = 0;
    p.stacks = {};
    p.on = true;
    await new Promise((r) => setTimeout(r, 1000));
    p.on = false;
    const after = document.getAnimations().length;
    return {
      animations: list.length,
      animationsAfter1s: after,
      animationList: list.slice(0, 8),
      rafPerSec: p.n,
      rafStacks: Object.entries(p.stacks).sort((a, b) => b[1] - a[1]).slice(0, 4),
    };
  });
}

async function tabTransition(page, tabId = "profile") {
  return page.evaluate(
    (tabId) =>
      new Promise((resolve) => {
        const vw = innerWidth;
        const vh = innerHeight;
        const frames = [];
        const area = (b) => Math.max(0, Math.min(b.right, vw) - Math.max(b.left, 0)) * Math.max(0, Math.min(b.bottom, vh) - Math.max(b.top, 0));
        const t0 = performance.now();
        document.getElementById(`tab-${tabId}`).click();
        const step = () => {
          const t = performance.now() - t0;
          let blur = 0;
          for (const el of document.querySelectorAll('[style*="filter"]')) {
            const f = getComputedStyle(el).filter;
            if (f && f.includes("blur") && !/blur\(0(px)?\)/.test(f)) blur += area(el.getBoundingClientRect());
          }
          const active = document.querySelector(".tab-layer[data-active]");
          const olds = [...document.querySelectorAll(".tab-layer:not([data-active])")];
          frames.push({
            t: Math.round(t),
            newOpacity: active ? Math.round(Number(getComputedStyle(active).opacity) * 100) / 100 : null,
            oldVisible: olds.some((o) => getComputedStyle(o).visibility !== "hidden" && Number(getComputedStyle(o).opacity) > 0.01),
            blurFrac: Math.round((blur / (vw * vh)) * 1000) / 1000,
          });
          if (t < 700) requestAnimationFrame(step);
          else resolve(frames);
        };
        requestAnimationFrame(step);
      }),
    tabId,
  );
}

/**
 * §8.2 (2026-11-12, user-rejected "닫힌 창이 남아 있음"): after a close, no sheet / drawer surface may be visible
 * (opacity > .05) on any frame later than 200 ms after the click, and the source is itself again: opacity 1 from the
 * first frame, and from 200 ms on, elementFromPoint at its centre hits it (no overlay on top).
 */
async function sampleClose(page, kind, label) {
  return page.evaluate(
    ([kind, label]) =>
      new Promise((resolve) => {
        const chain = (el) => {
          let o = getComputedStyle(el).visibility === "hidden" ? 0 : 1;
          for (let n = el; n && n.nodeType === 1; n = n.parentElement) o *= parseFloat(getComputedStyle(n).opacity);
          return o;
        };
        const src =
          kind === "drawer"
            ? document.querySelector(".main-card")
            : label.startsWith(".")
              ? document.querySelector(label)
              : [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === label);
        const surfaces = kind === "drawer" ? ".drawer, .main-dim" : ".sheet-root .sheet-panel, .sheet-root .sheet-scrim";
        const frames = [];
        const t0 = performance.now();
        if (kind === "drawer") document.querySelector(".main-dim").click();
        else document.querySelector(".sheet-root .sheet-close").click();
        const step = () => {
          const t = performance.now() - t0;
          let surface = 0;
          for (const el of document.querySelectorAll(surfaces)) surface = Math.max(surface, chain(el));
          const r = (kind === "drawer" ? document.querySelector(".tab-layer[data-active] .screen-scroll") : src).getBoundingClientRect();
          const hit = document.elementFromPoint(r.left + r.width / 2, r.top + Math.min(r.height / 2, 200));
          const srcHit = !!hit && (hit === src || src.contains(hit));
          frames.push({ t: Math.round(t), surface: Math.round(surface * 1000) / 1000, srcOp: Math.round(chain(src) * 1000) / 1000, srcHit, hit: srcHit || !hit ? undefined : `${hit.tagName.toLowerCase()}.${String(hit.className).split(" ").slice(0, 2).join(".")}` });
          if (t < 700) requestAnimationFrame(step);
          else resolve(frames);
        };
        requestAnimationFrame(step);
      }),
    [kind, label],
  );
}

async function closeChecks(page) {
  const out = {};
  await scrollToSection(page, "sheet");
  await sleep(300);
  for (const [name, label] of [
    ["sheet", "시트 열기"],
    ["presentSheet", "명령형 시트"],
    ["drawer", null],
    // the top bar's agent (as in 채팅): its own CSS fades opacity 353 ms (the pressed dim), which turned the source's
    // return into a fade-in (screens-chat, 2026-11-15); at the top of the page, where the bar shows the agent
    ["agent", ".topbar button.tb-agent"],
  ]) {
    if (name === "drawer") await page.locator(".topbar .tb-circle").first().click();
    else if (label.startsWith(".")) {
      await page.evaluate(() => document.querySelector(".tab-layer[data-active] .screen-scroll")?.scrollTo(0, 0));
      await page.locator(label).waitFor({ timeout: 4000 });
      await sleep(400); // the centre's swap from the compact title back to the agent
      await page.locator(label).click();
    } else await page.getByRole("button", { name: label, exact: true }).click();
    await sleep(900);
    const frames = await sampleClose(page, name === "drawer" ? "drawer" : "sheet", label);
    const late = frames.filter((f) => f.t > 200);
    const lastVisible = [...frames].reverse().find((f) => f.surface > 0.05);
    out[name] = {
      lastSurfaceMs: lastVisible ? lastVisible.t : 0,
      minSourceOpacity: Math.min(...frames.map((f) => f.srcOp)),
      sourceHitAfter200: late.every((f) => f.srcHit),
      firstMiss: late.find((f) => !f.srcHit || f.surface > 0.05) ?? null,
      frames: frames.length,
    };
    out[name].ok = late.length > 0 && late.every((f) => f.surface <= 0.05) && out[name].minSourceOpacity >= 0.999 && out[name].sourceHitAfter200;
    await sleep(400);
  }
  // back where the checks left the page before the agent case (the top shows the loading demo, whose spinner would
  // count in the idle sample that follows)
  await scrollToSection(page, "sheet");
  await sleep(300);
  out.ok = Object.values(out).every((x) => x.ok);
  return out;
}

async function motionChecks(browserType, engine, gl) {
  const browser = await browserType.launch(engine === "chromium" ? { channel: "chrome" } : {});
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: "ko-KR" });
  await context.addInitScript(RAF_PROBE);
  const page = await context.newPage();
  const errors = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  await page.goto(`${BASE}/?gallery=1&gl=${gl}`, { waitUntil: "load" });
  await page.waitForSelector("#gal-settings");
  // an idle screen: the gallery's settings-like list (the catalogue above it keeps a spinner demo on screen)
  await scrollToSection(page, "list");
  await sleep(3800); // load settles (~2 s: wallpaper + lens chunks on idle) + 2 s idle
  const wallpaper = await page.evaluate(() => document.querySelector(".wallpaper")?.getAttribute("data-wallpaper"));
  const afterLoad = await sampleIdle(page);
  const frames = await tabTransition(page);
  const at50 = frames.find((f) => f.t >= 45) ?? null;
  // §8.2: the entrance is a 0→1 / 180 ms ramp timed from the tap (floor .12). Every frame shows at least what that ramp
  // wanted at the frame before it (one frame between the value and this sample), whenever the frames land: WebKit under
  // load draws its first frame 40-90 ms after the tap, and a ramp timed from the commit then still read .12 at 80 ms
  const want = (t) => Math.min(1, Math.max(0.12, t / 180));
  let behind = 0;
  let behindAt = null;
  frames.forEach((f, i) => {
    if (f.t > 260) return;
    const d = want(i ? frames[i - 1].t : 0) - (f.newOpacity ?? 0);
    if (d > behind) [behind, behindAt] = [d, f.t];
  });
  const opaqueAt = frames.find((f) => (f.newOpacity ?? 0) >= 0.999)?.t ?? null;
  const by80 = frames.filter((f) => f.t <= 80);
  const max80 = by80.length ? Math.max(...by80.map((f) => f.newOpacity ?? 0)) : null;
  const transition = {
    newOpacityAt50ms: at50 ? at50.newOpacity : null,
    at50ms: at50 ? at50.t : null,
    newOpacityMaxBy80ms: max80,
    firstFrameMs: frames[0]?.t ?? null,
    behindTapRamp: Math.round(behind * 100) / 100,
    behindAt,
    opaqueAt,
    oldPageEverVisible: frames.some((f) => f.oldVisible),
    maxBlurFraction: Math.max(0, ...frames.map((f) => f.blurFrac)),
    frames: frames.length,
  };
  transition.ok = behind <= 0.03 && opaqueAt !== null && opaqueAt <= 260 && !transition.oldPageEverVisible && transition.maxBlurFraction <= 0.25;
  await sleep(900);
  // §8.2 (2026-11-12): back to a tab already visited — complete on every frame, no re-entrance (user-rejected)
  const back = await tabTransition(page, "chat");
  transition.revisitMinOpacity = Math.min(...back.map((f) => f.newOpacity ?? 0));
  transition.revisitOldEverVisible = back.some((f) => f.oldVisible);
  transition.ok = transition.ok && transition.revisitMinOpacity >= 0.99 && !transition.revisitOldEverVisible;
  const closes = await closeChecks(page);
  await sleep(2600); // the camera spring settles well within 2 s, then 2 s idle… (sample starts here)
  const afterTabs = await sampleIdle(page);
  await browser.close();
  const idleOk = (x) => x.animations === 0 && x.animationsAfter1s === 0 && x.rafPerSec === 0;
  return { engine, gl, wallpaper, errors, afterLoad, afterTabs, transition, closes, ok: idleOk(afterLoad) && idleOk(afterTabs) && transition.ok && closes.ok && !errors.length };
}

// ── performance: tab-bar drag + sheet open ──
async function perf(browserType, engine, throttle) {
  const browser = await browserType.launch(engine === "chromium" ? { channel: "chrome" } : {});
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, locale: "ko-KR" });
  const page = await context.newPage();
  const errors = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  await page.goto(`${BASE}/?gallery=1`, { waitUntil: "load" });
  await page.waitForSelector("#gal-settings");
  await sleep(2500);
  await scrollToSection(page, "sheet");
  const wallpaper = await page.evaluate(() => document.querySelector(".wallpaper")?.getAttribute("data-wallpaper"));
  if (engine === "chromium" && throttle > 1) {
    const cdp = await context.newCDPSession(page);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: throttle });
  }
  // in-page probes
  await page.evaluate(() => {
    const w = window;
    w.__qa = { long: [], gaps: [], run: true };
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) w.__qa.long.push(Math.round(e.duration));
      }).observe({ type: "longtask", buffered: false });
    } catch {
      w.__qa.longUnsupported = true;
    }
    let last = performance.now();
    const loop = (t) => {
      if (!w.__qa.run) return;
      w.__qa.gaps.push(t - last);
      last = t;
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  });
  const tracePath = path.join(outDir, `perf-trace-${engine}${throttle > 1 ? `-x${throttle}` : ""}.json`);
  if (engine === "chromium") await browser.startTracing(page, { path: tracePath, categories: ["devtools.timeline", "disabled-by-default-devtools.timeline", "disabled-by-default-devtools.timeline.frame"] });

  // drag the droplet from the first tab across to the last one, then release
  const drop = await page.locator(".tab-droplet").boundingBox();
  const bar = await page.locator(".tabbar").boundingBox();
  const y = drop.y + drop.height / 2;
  await page.mouse.move(drop.x + drop.width / 2, y);
  await page.mouse.down();
  const x0 = drop.x + drop.width / 2;
  const x1 = bar.x + bar.width - drop.width / 2 - 6;
  for (let i = 1; i <= 24; i++) {
    await page.mouse.move(x0 + ((x1 - x0) * i) / 24, y);
    await sleep(16);
  }
  await page.mouse.up();
  await sleep(900);
  // back by tap
  await page.getByRole("tab", { name: "채팅" }).click();
  await sleep(800);
  // sheet open (morph from its button) and close
  await page.locator(".gal-sheet-btn").click();
  await sleep(1100);
  await page.keyboard.press("Escape");
  await sleep(900);

  if (engine === "chromium") await browser.stopTracing();
  const probe = await page.evaluate(() => {
    const w = window;
    w.__qa.run = false;
    const gaps = w.__qa.gaps.slice(2);
    const frame = 1000 / 60;
    const dropped = gaps.reduce((n, g) => n + Math.max(0, Math.round(g / frame) - 1), 0);
    const sorted = [...gaps].sort((a, b) => a - b);
    return {
      frames: gaps.length,
      droppedEstimate: dropped,
      worstGapMs: Math.round(sorted[sorted.length - 1] || 0),
      p95GapMs: Math.round((sorted[Math.floor(sorted.length * 0.95)] || 0) * 10) / 10,
      longTasksObserved: w.__qa.longUnsupported ? "unsupported" : w.__qa.long,
    };
  });
  let traceLong = null;
  if (engine === "chromium" && fs.existsSync(tracePath)) {
    const raw = JSON.parse(fs.readFileSync(tracePath, "utf8"));
    const events = raw.traceEvents || raw;
    const mains = new Set(events.filter((e) => e.name === "thread_name" && e.args?.name === "CrRendererMain").map((e) => `${e.pid}:${e.tid}`));
    traceLong = events
      .filter((e) => e.ph === "X" && (e.name === "RunTask" || e.name === "ThreadControllerImpl::RunTask") && mains.has(`${e.pid}:${e.tid}`) && e.dur > 50000)
      .map((e) => Math.round(e.dur / 1000));
    // keep the trace (load it in DevTools → Performance), gzipped
    fs.writeFileSync(`${tracePath}.gz`, zlib.gzipSync(fs.readFileSync(tracePath)));
    fs.unlinkSync(tracePath);
  }
  await browser.close();
  return { engine, throttle, wallpaper, errors, ...probe, traceLongTasksMs: traceLong, trace: engine === "chromium" ? path.relative(repo, `${tracePath}.gz`) : null };
}

/** a throwaway account through the preview's /api (vite preview proxies it to PICKLE_API), the morning briefing off */
async function qaAccount() {
  const rand = () => crypto.randomBytes(4).toString("hex");
  for (let i = 0; i < 4; i++) {
    const kp = await crypto.webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const signingKey = await crypto.webcrypto.subtle.exportKey("jwk", kp.publicKey);
    const r = await fetch(`${BASE}/api/auth/signup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ handle: `qafdn${rand()}`, password: "qa-pass-1234", displayName: "하늘", agentName: "모시", device: { id: `qa-${rand()}`, label: "QA node", signingKey } }),
    });
    if (r.status === 429) {
      await sleep(20_000);
      continue;
    }
    if (!r.ok) throw new Error(`signup ${r.status}: is the preview's PICKLE_API a running server?`);
    const { token } = await r.json();
    await fetch(`${BASE}/api/settings`, { method: "PATCH", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ notifications: { briefing: false } }) });
    return token;
  }
  throw new Error("signup rate limited");
}

// a call without real speech: the recogniser hears nothing (no network), and WebKit gets a silent microphone (Chrome
// runs on its fake capture device)
const CALL_STUBS = (silentMic) => {
  if (silentMic) {
    const mic = async () => {
      window.__qaMic ??= new AudioContext();
      return window.__qaMic.createMediaStreamDestination().stream;
    };
    MediaDevices.prototype.getUserMedia = mic;
    if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = mic;
  }
  class Quiet {
    constructor() {
      Object.assign(this, { lang: "", continuous: false, interimResults: false, maxAlternatives: 1, onresult: null, onerror: null, onend: null });
    }
    start() {}
    stop() {
      setTimeout(() => this.onend?.(), 0);
    }
    abort() {
      this.stop();
    }
  }
  window.SpeechRecognition = Quiet;
  window.webkitSpeechRecognition = Quiet;
};
// the toast's life in the page, node insertion to removal, and when the call card came over it (Playwright's own
// clock sees the toast late after a reload)
const TOAST_LIFE = () => {
  const l = (window.__qaToastLife = { in: null, out: null, card: null });
  new MutationObserver(() => {
    const now = performance.now();
    const has = !!document.querySelector(".toast");
    if (has && l.in === null) l.in = now;
    else if (!has && l.in !== null && l.out === null) l.out = now;
    if (l.in !== null && l.card === null && document.querySelector(".call-card")) l.card = now;
  }).observe(document, { subtree: true, childList: true });
};

/**
 * The undo toast under the full-screen call card (MOTION-SPEC §8.13; the lead, 2026-11-12). The real chat: the main
 * thread's messages get a schedule card created "now" (a route mock, as chat.spec's calltoast), so the chat offers its
 * 5 s 실행 취소; then the call opens over it, by touch.
 *  (a) under the card the toast's anchor is inert, 12 Tabs from the call never land inside .toast-anchor (where Enter
 *      would cancel the schedule unseen), and in Chromium no node named 실행 취소 is left in the CDP accessibility tree.
 *      (WebKit has no AX tree API here, and Playwright's role query keeps inert nodes, so there `inert` stands for it.)
 *  (b) a mouse resting on the toast as the call opens (WebKit sends no pointerleave when the card appears under a still
 *      pointer): the toast still leaves under the open card, its life no longer than 5 s plus the time the pointer
 *      could have held it before the card came, plus the exit fade
 */
// The droplet's lens (liquid-glass-js, on <body>) under an open sheet: a resize springs the droplet and wakes the lens;
// it must stay unpainted while the overlay is up. Chrome paints the lens's SVG filter output even under visibility:
// hidden (a ring over 연결하기 at 320x568), so the check reads opacity, every frame for 700 ms after the resize.
async function lensOverlay(browserType, engine) {
  const isChrome = engine === "chromium";
  const out = { engine, ok: false, errors: [] };
  const browser = await browserType.launch(isChrome ? { channel: "chrome", args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] } : {});
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: isChrome, hasTouch: true, locale: "ko-KR" });
    const page = await context.newPage();
    page.on("console", (m) => m.type() === "error" && out.errors.push(m.text()));
    page.on("pageerror", (e) => out.errors.push(`pageerror: ${e.message}`));
    await page.goto(`${BASE}/?gallery=1&gl=force`, { waitUntil: "load" });
    await page.waitForSelector(".lqg-lens.lqg-tab", { state: "attached", timeout: 20_000 }).catch(() => {});
    out.lens = await page.evaluate(() => document.querySelectorAll(".lqg-tab").length);
    if (!out.lens) {
      out.why = "no lens in the DOM";
      return out;
    }
    await page.locator("#gal-sheet button").first().click();
    await page.waitForFunction(() => /sheet/.test(document.documentElement.dataset.overlay ?? ""), null, { timeout: 5000 });
    await sleep(600);
    await page.mouse.move(1, 1);
    const sampling = page.evaluate(
      () =>
        new Promise((done) => {
          const t0 = performance.now();
          let activeFrames = 0;
          let maxOpacity = 0;
          let frames = 0;
          const tick = () => {
            frames++;
            const overlay = !!document.documentElement.dataset.overlay;
            const lens = overlay ? [...document.querySelectorAll(".lqg-tab")] : [];
            if (lens.some((el) => el.hasAttribute("data-active"))) activeFrames++;
            for (const el of lens) maxOpacity = Math.max(maxOpacity, parseFloat(getComputedStyle(el).opacity) || 0);
            if (performance.now() - t0 < 700) requestAnimationFrame(tick);
            else done({ frames, activeFrames, maxOpacity: Math.round(maxOpacity * 1000) / 1000 });
          };
          requestAnimationFrame(tick);
        }),
    );
    await page.setViewportSize({ width: 320, height: 568 });
    Object.assign(out, await sampling);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.keyboard.press("Escape");
    // and once the sheet is gone the lens comes back: a tab travel shows it (a stuck overlay flag would hide it for good)
    out.cleared = await page
      .waitForFunction(() => !document.documentElement.dataset.overlay, null, { timeout: 5000 })
      .then(() => true)
      .catch(() => false);
    await sleep(600);
    const travel = page.evaluate(
      () =>
        new Promise((done) => {
          const t0 = performance.now();
          let frames = 0;
          let activeFrames = 0;
          let maxOpacity = 0;
          const tick = () => {
            frames++;
            const lens = [...document.querySelectorAll(".lqg-tab")];
            if (lens.some((el) => el.hasAttribute("data-active"))) activeFrames++;
            for (const el of lens) maxOpacity = Math.max(maxOpacity, parseFloat(getComputedStyle(el).opacity) || 0);
            if (performance.now() - t0 < 900) requestAnimationFrame(tick);
            else done({ frames, activeFrames, maxOpacity: Math.round(maxOpacity * 1000) / 1000 });
          };
          requestAnimationFrame(tick);
        }),
    );
    await page.locator(".tab-item:not([data-on])").first().click();
    out.after = await travel;
    // exercised only if the lens woke under the sheet; then it must never have been visible, and must show on the
    // first tab travel after the sheet closed
    out.ok = out.activeFrames > 0 && out.maxOpacity === 0 && out.cleared && out.after.activeFrames > 0 && out.after.maxOpacity > 0 && !out.errors.length;
    if (!out.activeFrames) out.why = "the lens never woke under the sheet (check not exercised)";
    else if (!out.cleared) out.why = "the overlay flag stayed after Escape";
    else if (!(out.after.maxOpacity > 0)) out.why = "no lens on the tab travel after the sheet closed";
  } catch (e) {
    out.errors.push(String(e?.message ?? e));
  } finally {
    await browser.close();
  }
  return out;
}

/**
 * BlurGroup (ui/Glass.tsx) places its layer from the host's top-left. When the host grows above members that keep
 * their size (the "새 메시지" capsule joins the bottom bar over the composer), every member's offset from the host's
 * top changes and no member resizes. Mimicked here by a 44 px box (+ 10 px margin, the capsule's) put first in the
 * chrome slot, then removed. The layer is read inside a ResizeObserver made after the app's, so it is what that frame
 * draws. On 9e5cf65 the layer stayed 54 px above the composer while the capsule showed and hid its text in Chrome.
 */
async function blurHost(browserType, engine) {
  const isChrome = engine === "chromium";
  const out = { engine, ok: false, errors: [] };
  let token;
  try {
    token = await qaAccount();
  } catch (e) {
    out.errors.push(`account: ${e.message}`);
    return out;
  }
  const browser = await browserType.launch(isChrome ? { channel: "chrome", args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] } : {});
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: isChrome, hasTouch: true, locale: "ko-KR" });
    await context.addInitScript((t) => window === window.top && localStorage.setItem("pickle.token", t), token);
    const page = await context.newPage();
    page.on("console", (m) => m.type() === "error" && out.errors.push(m.text()));
    page.on("pageerror", (e) => out.errors.push(`pageerror: ${e.message}`));
    await page.goto(`${BASE}/`, { waitUntil: "load" });
    await page.waitForSelector(".bottom-chrome .chrome-slot textarea.composer-field", { timeout: 20_000 });
    await sleep(800);
    Object.assign(
      out,
      await page.evaluate(async () => {
        const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
        const host = document.querySelector(".bottom-chrome");
        const layer = host.querySelector(":scope > .blur-layer");
        const members = [...host.querySelectorAll('[data-blur="group"]')];
        // BlurGroup's own rounding: floor / ceil of the members' union, from the host's top
        const off = () => {
          const hb = host.getBoundingClientRect();
          const ms = members.map((m) => m.getBoundingClientRect());
          const top = hb.top + Math.floor(Math.min(...ms.map((b) => b.top - hb.top)));
          const bottom = hb.top + Math.ceil(Math.max(...ms.map((b) => b.bottom - hb.top)));
          const l = layer.getBoundingClientRect();
          return Math.round(Math.max(Math.abs(l.top - top), Math.abs(l.bottom - bottom)) * 10) / 10;
        };
        const seen = [];
        const ro = new ResizeObserver(() => seen.push(off()));
        ro.observe(host);
        await frame();
        await frame();
        seen.length = 0;
        const h0 = host.getBoundingClientRect().height;
        const box = document.createElement("div");
        box.style.cssText = "height: 44px; margin-bottom: 10px; flex: none";
        host.querySelector(".chrome-slot").prepend(box);
        for (let i = 0; i < 3; i++) await frame();
        const grown = { by: Math.round(host.getBoundingClientRect().height - h0), atResize: seen.splice(0), after: off() };
        box.remove();
        for (let i = 0; i < 3; i++) await frame();
        const back = { atResize: seen.splice(0), after: off() };
        ro.disconnect();
        return { members: members.length, grown, back };
      }),
    );
    const bad = (x) => !x.atResize.length || x.atResize.some((v) => v > 1) || x.after > 1;
    out.ok = out.members >= 1 && out.grown.by >= 50 && !bad(out.grown) && !bad(out.back) && !out.errors.length;
  } catch (e) {
    out.errors.push(e.message.split("\n")[0]);
  } finally {
    await browser.close();
  }
  return out;
}

// the pixels of a PNG that differ from rgb by more than 60 in any channel, decoded in a canvas of the same browser
async function inkOf(context, png, rgb) {
  const p = await context.newPage();
  try {
    return await p.evaluate(
      async ({ b64, rgb }) => {
        const img = new Image();
        img.src = `data:image/png;base64,${b64}`;
        await img.decode();
        const c = document.createElement("canvas");
        c.width = img.width;
        c.height = img.height;
        const g = c.getContext("2d", { willReadFrequently: true });
        g.drawImage(img, 0, 0);
        const d = g.getImageData(0, 0, img.width, img.height).data;
        let n = 0;
        for (let i = 0; i < d.length; i += 4) if (Math.max(Math.abs(d[i] - rgb[0]), Math.abs(d[i + 1] - rgb[1]), Math.abs(d[i + 2] - rgb[2])) > 60) n++;
        return n;
      },
      { b64: png.toString("base64"), rgb },
    );
  } finally {
    await p.close();
  }
}

// via: "transparency" (the root flag set in the page) or "contrast" (prefers-contrast: more from the context, as the OS
// gives it)
async function floorBand(browserType, engine, via = "transparency") {
  const isChrome = engine === "chromium";
  const byContrast = via === "contrast";
  const out = { engine, via, ok: false, errors: [] };
  let token;
  try {
    token = await qaAccount();
  } catch (e) {
    out.errors.push(`account: ${e.message}`);
    return out;
  }
  const browser = await browserType.launch(isChrome ? { channel: "chrome", args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] } : {});
  try {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 2,
      isMobile: isChrome,
      hasTouch: true,
      locale: "ko-KR",
      ...(byContrast ? { contrast: "more" } : {}),
    });
    await context.addInitScript((t) => window === window.top && localStorage.setItem("pickle.token", t), token);
    const page = await context.newPage();
    page.on("console", (m) => m.type() === "error" && out.errors.push(m.text()));
    page.on("pageerror", (e) => out.errors.push(`pageerror: ${e.message}`));
    await page.goto(`${BASE}/`, { waitUntil: "load" });
    await page.waitForSelector(".bottom-chrome .chrome-slot textarea.composer-field", { timeout: 20_000 });
    await page.mouse.move(1, 1);
    await sleep(800);
    const mode = () => page.evaluate(() => ({ contrast: document.documentElement.dataset.contrast ?? null, transparency: document.documentElement.dataset.transparency ?? null }));
    // the setting on (reduced transparency: the root flag tier.ts sets, restored at the end; increased contrast: from
    // the context), and the floor against the chrome
    const geo = () =>
      page.evaluate(() => {
        const r = (el) => el && ((b) => ({ top: b.top, bottom: b.bottom }))(el.getBoundingClientRect());
        const floor = [...(document.querySelector(".tab-layer[data-active]") ?? document).querySelectorAll(".screen-floor")].find((f) => getComputedStyle(f).display !== "none" && f.getBoundingClientRect().height > 0);
        return { floor: r(floor), composer: r(document.querySelector(".bottom-chrome .chrome-slot .composer")), tabbar: r(document.querySelector(".bottom-chrome .tabbar")), vh: innerHeight };
      });
    const was = await page.evaluate(async (byContrast) => {
      const root = document.documentElement;
      const w = root.dataset.transparency ?? null;
      if (!byContrast) root.dataset.transparency = "reduce";
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      return w;
    }, byContrast);
    out.mode = await mode();
    const rgb = await page.evaluate(() => {
      const probe = document.createElement("div");
      probe.style.background = "var(--bg)";
      document.body.append(probe);
      const m = getComputedStyle(probe).backgroundColor.match(/\d+(\.\d+)?/g).map(Number);
      probe.remove();
      return m.slice(0, 3);
    });
    // a black block, z-index 2, at the thread's end, scrolled 200 px up from the end: under the composer, the gap and the
    // tab bar to the screen's bottom (set twice: the thread may stick to its end as it grows)
    const place = () =>
      page.evaluate(() => {
        const sc = document.querySelector(".tab-layer[data-active] .thread-screen");
        sc.scrollTop = sc.scrollHeight - sc.clientHeight - 200;
      });
    await page.evaluate(() => {
      const block = document.createElement("div");
      block.id = "qa-floor-block";
      block.style.cssText = "position: relative; z-index: 2; height: 1200px; background: #000";
      document.querySelector(".tab-layer[data-active] .thread-screen .thread-content").append(block);
    });
    await place();
    await sleep(400);
    await place();
    await sleep(400);
    const g = await geo();
    out.chat = g;
    out.block = await page.evaluate(() => ((b) => ({ top: b.top, bottom: b.bottom }))(document.getElementById("qa-floor-block").getBoundingClientRect()));
    const W = 390;
    const strip = async (y0, y1) => (y1 - y0 >= 2 ? inkOf(context, await page.screenshot({ clip: { x: 0, y: y0, width: W, height: y1 - y0 } }), rgb) : -1);
    out.gapInk = g.composer && g.tabbar ? await strip(Math.ceil(g.composer.bottom) + 3, Math.floor(g.tabbar.top) - 3) : -1;
    out.belowInk = g.tabbar ? await strip(Math.ceil(g.tabbar.bottom) + 3, g.vh) : -1;
    await page.screenshot({ path: path.join(outDir, `${engine}-floor${byContrast ? "-contrast" : ""}.png`), clip: { x: 0, y: g.vh - 300, width: W, height: 300 } });
    await page.evaluate(() => document.getElementById("qa-floor-block")?.remove());
    // the composer at 4 lines
    const field = page.locator(".bottom-chrome .chrome-slot textarea.composer-field");
    await field.fill("첫째 줄\n둘째 줄\n셋째 줄\n넷째 줄");
    await sleep(600);
    out.grown = await geo();
    await field.fill("");
    await sleep(400);
    // the setting off: no floor drawn
    const drawn = () => page.evaluate(() => [...document.querySelectorAll(".screen-floor")].filter((f) => getComputedStyle(f).display !== "none").length);
    if (byContrast) {
      await page.emulateMedia({ contrast: "no-preference" });
      await sleep(300);
      out.offDrawn = await drawn();
      out.offMode = await mode();
      await page.emulateMedia({ contrast: "more" });
      await sleep(300);
    } else {
      out.offDrawn = await page.evaluate(async () => {
        const root = document.documentElement;
        delete root.dataset.transparency;
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        const n = [...document.querySelectorAll(".screen-floor")].filter((f) => getComputedStyle(f).display !== "none").length;
        root.dataset.transparency = "reduce";
        return n;
      });
    }
    // 둘러보기: the tab bar alone
    await page.click("#tab-explore");
    await sleep(1500);
    out.explore = await geo();
    await page.evaluate((w) => {
      const root = document.documentElement;
      if (w === null) delete root.dataset.transparency;
      else root.dataset.transparency = w;
    }, was);
    const near = (a, b) => a !== undefined && b !== undefined && Math.abs(a - b) <= 1;
    out.ok =
      !!g.floor &&
      near(g.floor.top, g.composer?.top - 6) &&
      near(g.floor.bottom, g.vh) &&
      out.block.top < g.composer.top &&
      out.block.bottom >= g.vh - 1 &&
      out.gapInk === 0 &&
      out.belowInk === 0 &&
      out.grown.composer?.top < g.composer.top - 40 &&
      near(out.grown.floor?.top, out.grown.composer?.top - 6) &&
      out.offDrawn === 0 &&
      near(out.explore.floor?.top, out.explore.tabbar?.top - 6) &&
      (byContrast
        ? out.mode.contrast === "more" && out.mode.transparency !== "reduce" && out.offMode?.contrast === "normal"
        : out.mode.transparency === "reduce") &&
      !out.errors.length;
  } catch (e) {
    out.errors.push(e.message.split("\n")[0]);
  } finally {
    await browser.close();
  }
  return out;
}

async function toastUnderCall(browserType, engine) {
  const isChrome = engine === "chromium";
  const out = { engine, ok: false, errors: [] };
  let token;
  try {
    token = await qaAccount();
  } catch (e) {
    out.errors.push(`account: ${e.message}`);
    return out;
  }
  const browser = await browserType.launch(isChrome ? { channel: "chrome", args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] } : {});
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: isChrome, hasTouch: true, locale: "ko-KR" });
    if (isChrome) await context.grantPermissions(["microphone"], { origin: BASE });
    await context.addInitScript((t) => localStorage.setItem("pickle.token", t), token);
    await context.addInitScript(CALL_STUBS, !isChrome);
    await context.addInitScript(TOAST_LIFE);
    const page = await context.newPage();
    page.on("console", (m) => m.type() === "error" && out.errors.push(m.text()));
    page.on("pageerror", (e) => out.errors.push(`pageerror: ${e.message}`));
    await page.goto(`${BASE}/`, { waitUntil: "load" });
    await page.waitForSelector("textarea.composer-field", { timeout: 30_000 });
    const mainId = await page.evaluate(async () => {
      const r = await fetch("/api/session", { headers: { authorization: `Bearer ${localStorage.getItem("pickle.token")}` } });
      const s = r.ok ? await r.json() : null;
      return s?.mainThreadId ?? s?.session?.mainThreadId ?? null;
    });
    if (!mainId) {
      out.errors.push("no main thread id from /api/session");
      return out;
    }
    let sid = "";
    await page.route(new RegExp(`/api/threads/${mainId}/messages(\\?.*)?$`), async (route) => {
      if (route.request().method() !== "GET" || !sid) return route.continue();
      const res = await route.fetch();
      const list = await res.json().catch(() => []);
      const card = { type: "schedule", scheduleId: sid, title: "아침 브리핑", when: "매일 오전 8:00", enabled: true };
      const msg = { id: `m_${sid}`, threadId: mainId, role: "assistant", text: "매일 오전 8시에 아침 브리핑을 보내 드릴게요.", cards: [card], tools: [], attachments: [], createdAt: Date.now() };
      await route.fulfill({ response: res, json: [...(Array.isArray(list) ? list : []), msg] });
    });
    const toastUp = async (mode) => {
      sid = `sch_qa_fdn_${mode}_${crypto.randomBytes(3).toString("hex")}`;
      await page.reload({ waitUntil: "load" });
      await page.waitForSelector("textarea.composer-field", { timeout: 30_000 });
      const up = await page.waitForSelector(".toast", { timeout: 8000 }).then(() => true, () => false);
      await sleep(500); // risen into place
      return up;
    };
    const tapCall = async () => {
      const b = await page.getByRole("button", { name: "통화하기" }).boundingBox();
      if (b) await page.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2);
      return page.waitForSelector(".call-card", { timeout: 8000 }).then(() => true, () => false);
    };
    const endCall = async () => {
      await page.evaluate(() => document.activeElement?.blur?.());
      await page.mouse.move(195, 300);
      await page.locator(".call-card").getByRole("button", { name: "통화 종료" }).click({ timeout: 8000 }).catch(() => {});
      await page.waitForSelector(".call-card", { state: "detached", timeout: 8000 }).catch(() => {});
      await page.waitForSelector(".toast", { state: "detached", timeout: 10_000 }).catch(() => {});
    };

    // (a) inert under the card: no Tab stop, out of the accessibility tree
    const a = { up: await toastUp("keys") };
    if (a.up) {
      a.open = await tapCall();
      await sleep(900); // the card has grown over the whole device
      a.present = await page.locator(".toast-anchor").count();
      a.inert = await page.evaluate(() => !!document.querySelector(".toast-anchor")?.closest("[inert]"));
      if (isChrome) {
        const cdp = await context.newCDPSession(page);
        const { nodes } = await cdp.send("Accessibility.getFullAXTree");
        a.ax = nodes.filter((n) => !n.ignored && n.name?.value === "실행 취소").length;
        await cdp.detach();
      }
      a.stops = [];
      for (let i = 0; i < 12; i++) {
        await page.keyboard.press("Tab");
        a.stops.push(
          await page.evaluate(() => {
            const el = document.activeElement;
            if (!el || el === document.body) return "body";
            if (el.closest(".toast-anchor")) return "TOAST";
            return el.closest(".call-card") ? "call" : el.getAttribute("aria-label") || el.className || el.tagName;
          }),
        );
      }
      a.tabToToast = a.stops.filter((x) => x === "TOAST").length;
      await endCall();
    }
    a.ok = !!(a.up && a.open && a.present && a.inert && (!isChrome || a.ax === 0) && a.tabToToast === 0);

    // (b) a resting mouse, the call opened by touch: the toast leaves under the open card at its own time
    const b = { up: await toastUp("hover") };
    if (b.up) {
      const t = await page.locator(".toast").boundingBox();
      await page.mouse.move(t.x + 40, t.y + t.height / 2); // on its body, not on 실행 취소
      await sleep(300);
      b.open = await tapCall();
      b.gone = await page.waitForSelector(".toast", { state: "detached", timeout: 9000 }).then(() => true, () => false);
      b.cardStillOpen = (await page.locator(".call-card").count()) > 0;
      const l = await page.evaluate(() => window.__qaToastLife);
      b.life = l?.in != null && l.out != null ? Math.round(l.out - l.in) : null;
      b.cardAt = l?.in != null && l.card != null ? Math.round(l.card - l.in) : null;
      // 5 s, plus what the pointer held before the card covered it (≤ cardAt), plus the exit fade (~120 ms) and slack
      b.bound = b.cardAt === null ? null : 5000 + b.cardAt + 400;
      await endCall();
    }
    b.ok = !!(b.up && b.open && b.gone && b.cardStillOpen && b.life !== null && b.life >= 4900 && b.life <= b.bound);
    Object.assign(out, { a, b, ok: a.ok && b.ok && out.errors.length === 0 });
  } catch (e) {
    out.errors.push(`step: ${e.message}`);
  } finally {
    await browser.close();
  }
  return out;
}

// `bun test` would pick this file up (*.spec.*): there it only registers a skipped test — run it with node.
const underBunTest = typeof globalThis.Bun !== "undefined" && process.env.NODE_ENV === "test";
if (underBunTest) {
  const { test } = await import("bun:test");
  test.skip("foundation QA — run with: node apps/mobile/qa/foundation.spec.mjs", () => {});
} else {
  await main();
}

async function main() {
  const server = await startServer();
  const results = { when: new Date().toISOString(), runs: [], motion: [], perf: [], toastCall: [], lensOverlay: [], blurHost: [], floor: [] };
  let failed = false;
  try {
    for (const engine of ENGINES) {
      const type = engine === "webkit" ? webkit : chromium;
      for (const variant of runs("gallery") ? VARIANTS : []) {
        const r = await runVariant(type, engine, variant);
        results.runs.push(r);
        const bad = r.overflows.filter((o) => o.doc > 0 || o.offenders.length);
        // §8.1 / DESIGN.md: the active tab label on its droplet is text — ≥4.5:1 in every theme, worst case over the
        // content scrolled beneath; and the droplet must read against the bar (luminance ratio ≥ 1.1)
        const tabOk = r.tabLabel && r.tabLabel.ratio !== null && r.tabLabel.ratio >= 4.5 && r.tabLabel.dropletVsBar >= 1.1;
        if (r.errors.length || bad.length || !tabOk || !r.sheetHead?.ok || !r.sheetEdge?.ok) failed = true;
        const tab = r.tabLabel && r.tabLabel.ratio !== null ? `worst ${r.tabLabel.ratio}:1 (${r.tabLabel.label} on ${r.tabLabel.on} at ${r.tabLabel.at}; ${Object.entries(r.tabLabel.bySurface).map(([k, v]) => `${k} ${v.ratio}`).join(", ")}), droplet/bar ${r.tabLabel.dropletVsBar}${r.tabLabel.clamped.length ? ` (clamped: ${r.tabLabel.clamped.join(", ")})` : ""}` : `n/a (${r.tabLabel && r.tabLabel.why})`;
        const sh = r.sheetHead
          ? ` · sheet head ${r.sheetHead.ok ? "ok" : "FAIL"} (${r.sheetHead.lines} title lines, head ${r.sheetHead.headPx} px, title ends ${r.sheetHead.titlePastHeadPx} px past it, body scrolls ${r.sheetHead.bodyScrolls})`
          : " · sheet head FAIL (no sheet)";
        const ed = r.sheetEdge;
        const se = ed
          ? ` · sheet edges ${ed.ok ? "ok" : "FAIL"} (top: first row ${ed.firstRowInk}, more below ${ed.top.more}, scrolled ${ed.top.scrolled}; ` +
            `head edge at ${ed.headAt} px: ink ${ed.headEdge.k} of unmasked (${ed.headEdge.contrast}:1 vs ${ed.headEdge.plainContrast}:1); ` +
            `footer edge at ${ed.footAt} px: ink ${ed.footEdge.k} (${ed.footEdge.contrast}:1 vs ${ed.footEdge.plainContrast}:1), more below ${ed.mid.more}; ` +
            `end at ${ed.endAt} px: last row ${ed.lastRowInk}, more below ${ed.end.more}; ` +
            `reduced transparency: mask ${ed.reducedT.mask === "none" ? "none" : "kept"}, lines ${ed.reducedT.lines}; more contrast: mask ${ed.contrast.mask === "none" ? "none" : "kept"}, lines ${ed.contrast.lines})`
          : " · sheet edge FAIL (no sheet)";
        const dc =
          (r.dangerConfirm ? ` · destructive confirm ${r.dangerConfirm.ratio}:1 (held ${r.dangerConfirm.held}:1, ${r.dangerConfirm.fg} on ${r.dangerConfirm.bg})` : "") +
          (r.primaryConfirm ? ` · primary confirm ${r.primaryConfirm.ratio}:1 (held ${r.primaryConfirm.held}:1)` : "") +
          (r.banner ? ` · banner ${r.banner.ok ? "ok" : "FAIL"} (drop ${r.banner.travelFirst}→${r.banner.travelLast} px, settled ${r.banner.settleMs} ms, text over the bar ≤ ${r.banner.textOverBarMax}, ${r.banner.gap} px below the bar, 메뉴 hittable ${r.banner.menuHittable} → drawer ${r.banner.menuOpened}, tab ${r.banner.tabLanded}, held on content ${r.banner.heldWithMouseOnContent}, capped at ${r.banner.cappedAfterMs} ms)` : "");
        console.log(`${engine}/${variant}: wallpaper=${r.wallpaper} lens=${r.lensInDom} errors=${r.errors.length} overflow=${bad.length ? JSON.stringify(bad) : "none"} shots=${r.shots.length} tab label ${tab}${tabOk ? "" : " FAIL"}${dc}${sh}${se}`);
        for (const e of r.errors) console.log("   console:", e);
      }
      if (engine === "chromium" && runs("gallery")) {
        for (const scheme of ["light", "dark"]) {
          const d = await desktop(type, engine, scheme);
          results.runs.push({ desktop: true, ...d });
          if (d.errors.length || d.frame !== "device") failed = true;
          console.log(`${engine}/desktop-${scheme}: frame=${d.frame} errors=${d.errors.length} → ${d.shot}`);
        }
      }
      for (const gl of !runs("motion") ? [] : engine === "chromium" ? ["off", "force"] : ["off"]) {
        const m = await motionChecks(type, engine, gl);
        results.motion.push(m);
        if (!m.ok) failed = true;
        const fmt = (x) => `anims=${x.animations}/${x.animationsAfter1s} raf=${x.rafPerSec}/s`;
        console.log(
          `${engine}/motion gl=${gl} (wallpaper=${m.wallpaper}): ${m.ok ? "ok" : "FAIL"} · after load ${fmt(m.afterLoad)} · after tabs ${fmt(m.afterTabs)} · tab switch: new opacity ${m.transition.newOpacityAt50ms} at ${m.transition.at50ms} ms (max ${m.transition.newOpacityMaxBy80ms} by 80 ms; first frame ${m.transition.firstFrameMs} ms, behind the tap's ramp ${m.transition.behindTapRamp}${m.transition.behindAt === null ? "" : ` at ${m.transition.behindAt} ms`}, opaque at ${m.transition.opaqueAt} ms), old visible=${m.transition.oldPageEverVisible}, max blur=${m.transition.maxBlurFraction} · revisit min opacity ${m.transition.revisitMinOpacity} · close: ${["sheet", "presentSheet", "drawer", "agent"].map((k) => `${k} ${m.closes[k].ok ? "ok" : "FAIL"} (surface gone ${m.closes[k].lastSurfaceMs} ms, source min op ${m.closes[k].minSourceOpacity}, hit ${m.closes[k].sourceHitAfter200})`).join(", ")}`,
        );
        if (!m.ok) {
          for (const x of [m.afterLoad, m.afterTabs]) {
            if (x.animationList.length) console.log("   animations:", JSON.stringify(x.animationList));
            if (x.rafStacks.length) console.log("   raf:", JSON.stringify(x.rafStacks));
          }
          for (const e of m.errors) console.log("   console:", e);
        }
      }
      if (runs("toastcall")) {
        const t = await toastUnderCall(type, engine);
        results.toastCall.push(t);
        if (!t.ok) failed = true;
        const { a = {}, b = {} } = t;
        console.log(
          `${engine}/toastcall: ${t.ok ? "ok" : "FAIL"} · (a) under the call card: inert=${a.inert} · AX nodes named 실행 취소 ${a.ax ?? "n/a"} · Tab → toast ${a.tabToToast}/12 · (b) resting mouse, touch-opened call: life ${b.life ?? "> 9 s"} ms (card at ${b.cardAt} ms, bound ${b.bound}) · errors ${t.errors.length}`,
        );
        for (const e of t.errors) console.log("   ", e);
      }
      if (runs("blurhost")) {
        const b = await blurHost(type, engine);
        results.blurHost.push(b);
        if (!b.ok) failed = true;
        const g = b.grown ?? {};
        const k = b.back ?? {};
        console.log(`${engine}/blurhost: ${b.ok ? "ok" : "FAIL"} · members ${b.members ?? 0} · bar grew ${g.by ?? "n/a"} px: layer off at the resize ${JSON.stringify(g.atResize ?? [])} px, 3 frames later ${g.after ?? "n/a"} px · shrank back: at the resize ${JSON.stringify(k.atResize ?? [])} px, 3 frames later ${k.after ?? "n/a"} px · errors ${b.errors.length}`);
        for (const e of b.errors) console.log("   ", e);
      }
      if (runs("floor")) for (const via of ["transparency", "contrast"]) {
        const f = await floorBand(type, engine, via);
        results.floor.push(f);
        if (!f.ok) failed = true;
        const top = (x) => (x?.floor ? `${x.floor.top.toFixed(1)}` : "none");
        const m = (x) => (x ? `contrast ${x.contrast}, transparency ${x.transparency}` : "n/a");
        console.log(
          `${engine}/floor${via === "contrast" ? " (prefers-contrast: more)" : ""}: ${f.ok ? "ok" : "FAIL"} · ${m(f.mode)}${via === "contrast" ? ` (off: ${m(f.offMode)})` : ""} · floor top ${top(f.chat)} (composer ${f.chat?.composer?.top.toFixed(1) ?? "n/a"} − 6, bottom ${f.chat?.floor?.bottom.toFixed(1) ?? "n/a"} of ${f.chat?.vh ?? "n/a"}) · ink over a z-index 2 block: gap ${f.gapInk ?? "n/a"}, below the tab bar ${f.belowInk ?? "n/a"} · 4 lines: floor ${top(f.grown)} (composer ${f.grown?.composer?.top.toFixed(1) ?? "n/a"} − 6) · off: drawn ${f.offDrawn ?? "n/a"} · 둘러보기: floor ${top(f.explore)} (tab bar ${f.explore?.tabbar?.top.toFixed(1) ?? "n/a"} − 6) · errors ${f.errors.length}`,
        );
        for (const e of f.errors) console.log("   ", e);
      }
      if (runs("lensoverlay")) {
        const l = await lensOverlay(type, engine);
        results.lensOverlay.push(l);
        if (!l.ok) failed = true;
        console.log(`${engine}/lensoverlay: ${l.ok ? "ok" : "FAIL"} · lens elements ${l.lens ?? 0} · under the sheet, after a 390x844 → 320x568 resize: awake ${l.activeFrames ?? 0} of ${l.frames ?? 0} frames, max opacity ${l.maxOpacity ?? "n/a"} · sheet closed: overlay cleared ${l.cleared ?? "n/a"}, tab travel awake ${l.after?.activeFrames ?? 0} of ${l.after?.frames ?? 0} frames, max opacity ${l.after?.maxOpacity ?? "n/a"}${l.why ? ` (${l.why})` : ""} · errors ${l.errors.length}`);
        for (const e of l.errors) console.log("   ", e);
      }
      if (process.env.QA_PERF !== "0" && runs("gallery")) {
        const p1 = await perf(type, engine, 1);
        results.perf.push(p1);
        console.log(`perf ${engine} x1:`, JSON.stringify({ ...p1, trace: undefined }));
        if (engine === "chromium") {
          const p4 = await perf(type, engine, 4);
          results.perf.push(p4);
          console.log(`perf ${engine} x4:`, JSON.stringify({ ...p4, trace: undefined }));
        }
      }
    }
  } finally {
    fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(results, null, 2));
    server?.kill();
  }
  console.log(failed ? "QA: FAIL" : "QA: PASS", "→", path.relative(repo, path.join(outDir, "results.json")));
  process.exit(failed ? 1 : 0);
}
