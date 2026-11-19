#!/usr/bin/env node
/*
 * Gallery generator: docs/design/drafts/_kit/gallery.html (index.html is the team viewer, see ../FORMAT.md), built from every draft's #kit-meta and its rendered PNGs.
 *
 *   node docs/design/drafts/_kit/gallery.mjs        # rebuild only (render.mjs also calls this at the end)
 *
 * Per draft, the meta block (a <script type="application/json" id="kit-meta"> in the draft HTML) can carry:
 *   feature, variant, title, rationale[5], motion[], fixes[] (slop-inventory / critique ids),
 *   compare[] (shot file names in docs/design/impeccable/shots/ to show the current app beside it)
 * The gallery is static HTML that loads the app's tokens.css, so it follows the same light/dark switch
 * (?theme=dark).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

export function buildGallery(draftsDir) {
  const features = fs
    .readdirSync(draftsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith("_"))
    .map((d) => d.name)
    .sort();
  const sections = [];
  for (const feature of features) {
    const dir = path.join(draftsDir, feature);
    const pngs = fs.existsSync(path.join(dir, "png")) ? fs.readdirSync(path.join(dir, "png")) : [];
    const drafts = fs.readdirSync(dir).filter((f) => f.endsWith(".html")).sort();
    const cards = [];
    let featureName = feature;
    for (const file of drafts) {
      const base = file.replace(/\.html$/, "");
      const html = fs.readFileSync(path.join(dir, file), "utf8");
      const m = html.match(/<script type="application\/json" id="kit-meta">([\s\S]*?)<\/script>/);
      let meta = {};
      try {
        meta = m ? JSON.parse(m[1]) : {};
      } catch {
        meta = { title: "(kit-meta is not valid JSON)" };
      }
      featureName = meta.feature || featureName;
      // chromium before webkit, light before dark
      const rank = (p) => (p.includes("-webkit") ? 2 : 0) + (p.includes("-dark") ? 1 : 0);
      const shots = pngs.filter((p) => p.replace(/-(light|dark)(-webkit)?\.png$/, "") === base).sort((a, b) => rank(a) - rank(b));
      const compare = (meta.compare || []).map(
        (c) => `<figure class="g-shot is-now"><img loading="lazy" src="../../impeccable/shots/${esc(c)}" alt=""><figcaption>현재 앱 · ${esc(c.replace(/\.jpg$/, ""))}</figcaption></figure>`,
      );
      cards.push(`
      <article class="g-card">
        <header><h3>${esc(meta.variant || base)} · ${esc(meta.title || "")}</h3>
          <a href="../${esc(feature)}/${esc(file)}">HTML</a> · <a href="../${esc(feature)}/${esc(file)}?theme=dark">dark</a></header>
        <div class="g-shots">
          ${shots.map((s) => `<figure class="g-shot"><img loading="lazy" src="../${esc(feature)}/png/${esc(s)}" alt=""><figcaption>${esc(s.replace(/\.png$/, ""))}</figcaption></figure>`).join("")}
          ${compare.join("")}
        </div>
        ${meta.rationale ? `<ol class="g-why">${meta.rationale.map((r) => `<li>${esc(r)}</li>`).join("")}</ol>` : ""}
        ${meta.motion ? `<p class="g-motion"><strong>Motion kept</strong> ${meta.motion.map(esc).join(" · ")}</p>` : ""}
        ${meta.fixes ? `<p class="g-fixes"><strong>Fixes</strong> ${meta.fixes.map(esc).join(", ")}</p>` : ""}
      </article>`);
    }
    if (cards.length === 0) continue; // a team's folder with no draft yet
    sections.push(`<section class="g-feature"><h2>${esc(featureName)} <small>${esc(feature)}/</small></h2>${cards.join("")}</section>`);
  }
  const page = `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>모시 드래프트 갤러리</title>
<link rel="stylesheet" href="../../../../apps/mobile/src/styles/tokens.css">
<link rel="stylesheet" href="../../../../apps/mobile/src/styles/base.css">
<style>
  body { padding: 40px 32px 80px; background: var(--bg); }
  h1 { font-family: var(--font-display); font-size: var(--t-title1); letter-spacing: -0.02em; }
  .g-lede { margin-top: 6px; color: var(--label-2); font-size: var(--t-subhead); max-width: 70ch; }
  .g-feature { margin-top: 44px; }
  .g-feature h2 { font-size: var(--t-title2); letter-spacing: -0.01em; }
  .g-feature h2 small { font-size: var(--t-footnote); color: var(--label-2); font-weight: 500; margin-left: 6px; }
  .g-card { margin-top: 20px; padding: 20px; background: var(--surface); border-radius: var(--r-card); }
  .g-card header { display: flex; gap: 12px; align-items: baseline; flex-wrap: wrap; font-size: var(--t-footnote); color: var(--label-2); }
  .g-card h3 { font-size: var(--t-body); color: var(--label); margin-right: auto; }
  .g-shots { display: flex; gap: 16px; flex-wrap: wrap; margin-top: 14px; }
  .g-shot { width: 260px; }
  .g-shot img { width: 260px; height: auto; border-radius: 28px; display: block; background: var(--surface-2); }
  .g-shot.is-now img { opacity: 0.9; outline: 1px dashed var(--separator); outline-offset: 3px; }
  .g-shot figcaption { margin-top: 6px; font-size: var(--t-footnote); color: var(--label-2); }
  .g-why { margin: 14px 0 0 1.2em; font-size: var(--t-subhead); line-height: 1.6; max-width: 90ch; }
  .g-motion, .g-fixes { margin-top: 10px; font-size: var(--t-footnote); color: var(--label-2); max-width: 90ch; }
  .g-motion strong, .g-fixes strong { color: var(--label); margin-right: 6px; }
</style>
</head>
<body>
<h1>모시 드래프트 갤러리</h1>
<p class="g-lede">De-slop drafts, rendered by docs/design/drafts/_kit/render.mjs at 390×844 @2x in light and dark. Each draft loads the app's real tokens.css, base.css, glass.css and the wallpaper. The dashed frame is the current app, for comparison. Generated ${new Date().toLocaleString("sv-SE", { timeZone: "Asia/Seoul" }).slice(0, 16)} KST.</p>
${sections.join("\n")}
<script>if (new URLSearchParams(location.search).get("theme") === "dark") document.documentElement.dataset.theme = "dark";</script>
</body>
</html>
`;
  const out = path.join(draftsDir, "_kit", "gallery.html");
  fs.writeFileSync(out, page);
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = buildGallery(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));
  console.log(`gallery → ${out}`);
}
