#!/usr/bin/env node
/*
 * Render every draft to PNG (390×844 @2x), light + dark, in Chrome, then rebuild the gallery.
 *
 *   node docs/design/drafts/_kit/render.mjs                    # all features
 *   node docs/design/drafts/_kit/render.mjs empty-thread       # one feature (folder name)
 *   node docs/design/drafts/_kit/render.mjs --engines chromium,webkit --hue 205
 *
 * Output per draft and theme (webkit adds "-webkit"):
 *   docs/design/drafts/<feature>/<draft>-<theme>.jpg      JPEG q82, the capture ../FORMAT.md asks for (team viewer)
 *   docs/design/drafts/<feature>/png/<draft>-<theme>.png  lossless PNG
 * then the kit gallery docs/design/drafts/_kit/gallery.html.
 * Uses the repo-root Playwright with channel "chrome" (the installed Chrome) and Playwright's WebKit. It never runs
 * `playwright install`. Pages are opened from file:// so the drafts load the app's real CSS by relative path. No server,
 * no ports, no camera or mic.
 * Any console error or failed request (e.g. a wrong tokens.css path) fails the run.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium, webkit } from "playwright";
import { buildGallery } from "./gallery.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const draftsDir = path.resolve(here, "..");

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return dflt;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const engines = opt("engines", "chromium").split(",");
const themes = opt("themes", "light,dark").split(",");
const hue = opt("hue", "96");
const only = new Set(args);

const features = fs
  .readdirSync(draftsDir, { withFileTypes: true })
  .filter((d) => d.isDirectory() && !d.name.startsWith("_") && (only.size === 0 || only.has(d.name)))
  .map((d) => d.name);
if (features.length === 0) {
  console.error(`no draft folders${only.size ? ` matching ${[...only].join(", ")}` : ""} in ${draftsDir}`);
  process.exit(1);
}

const launchers = {
  chromium: () => chromium.launch({ channel: "chrome", headless: true }),
  webkit: () => webkit.launch({ headless: true }),
};

let failures = 0;
for (const engine of engines) {
  if (!launchers[engine]) throw new Error(`unknown engine ${engine}`);
  const browser = await launchers[engine]();
  for (const feature of features) {
    const dir = path.join(draftsDir, feature);
    const drafts = fs.readdirSync(dir).filter((f) => f.endsWith(".html")).sort();
    fs.mkdirSync(path.join(dir, "png"), { recursive: true });
    for (const file of drafts) {
      for (const theme of themes) {
        const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, colorScheme: theme });
        const page = await context.newPage();
        const problems = [];
        page.on("console", (m) => m.type() === "error" && problems.push(`console: ${m.text()}`));
        page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
        page.on("requestfailed", (r) => problems.push(`requestfailed: ${r.url()}`));
        const url = `${pathToFileURL(path.join(dir, file)).href}?theme=${theme}&hue=${hue}`;
        await page.goto(url);
        await page.waitForSelector("html[data-kit-ready]", { timeout: 10_000 });
        // let entrance animations (springs) land, so the still shows the resting state
        await page.evaluate(() => Promise.race([Promise.all(document.getAnimations().map((a) => a.finished.catch(() => {}))), new Promise((r) => setTimeout(r, 3000))]));
        const stem = `${file.replace(/\.html$/, "")}-${theme}${engine === "chromium" ? "" : `-${engine}`}`;
        const out = path.join(dir, "png", `${stem}.png`);
        await page.screenshot({ path: out });
        // FORMAT.md capture for the team viewer: JPEG q82 next to the HTML
        await page.screenshot({ path: path.join(dir, `${stem}.jpg`), type: "jpeg", quality: 82 });
        if (problems.length) {
          failures++;
          console.error(`✗ ${feature}/${file} [${engine} ${theme}]\n  ${problems.join("\n  ")}`);
        } else {
          console.log(`✓ ${path.relative(process.cwd(), out)}`);
        }
        await context.close();
      }
    }
  }
  await browser.close();
}

const galleryPath = buildGallery(draftsDir);
console.log(`gallery → ${path.relative(process.cwd(), galleryPath)}`);
if (failures) {
  console.error(`${failures} render(s) had problems`);
  process.exit(1);
}
