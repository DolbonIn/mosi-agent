// Side-by-side strips for the wallpaper QA: for each engine × theme, the five screens before (top row) and after
// (bottom row), from docs/qa/wallpaper/raw/<label>-<engine>-<theme>-N-name.png → docs/qa/wallpaper/<engine>-<theme>.png.
//   node apps/mobile/qa/wallpaper-strips.mjs            (QA_BEFORE=before QA_AFTER=after by default)
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(here, "../../../docs/qa/wallpaper");
const rawDir = path.join(outDir, "raw");
const BEFORE = process.env.QA_BEFORE || "before";
const AFTER = process.env.QA_AFTER || "after";
const SCREENS = [
  ["1-chat", "채팅 (메시지)"],
  ["2-empty", "빈 대화 (제안)"],
  ["3-archive", "보관함"],
  ["4-profile", "나의 모시"],
  ["5-drawer", "서랍 열림"],
];
const img = (f) => (fs.existsSync(f) ? `data:image/png;base64,${fs.readFileSync(f).toString("base64")}` : "");

const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage({ viewport: { width: 1480, height: 1300 }, deviceScaleFactor: 1.5 });
for (const engine of ["chromium", "webkit"]) {
  for (const theme of ["light", "dark"]) {
    const row = (label) =>
      `<div class="lab">${label === BEFORE ? "이전" : "이후"}<small>${label}</small></div>` +
      SCREENS.map(([k]) => `<img src="${img(path.join(rawDir, `${label}-${engine}-${theme}-${k}.png`))}">`).join("");
    const html = `<!doctype html><meta charset="utf-8"><style>
      body{margin:0;padding:24px;background:${theme === "dark" ? "#1a1a1a" : "#e8e8ec"};font:600 15px -apple-system,"Apple SD Gothic Neo",sans-serif;color:${theme === "dark" ? "#eee" : "#222"}}
      h1{font-size:18px;margin:0 0 14px}
      .g{display:grid;grid-template-columns:70px repeat(5,260px);gap:12px;align-items:start}
      .h{font-size:13px;text-align:center;opacity:.8}
      .lab{writing-mode:vertical-rl;transform:rotate(180deg);align-self:center;font-size:16px}
      .lab small{display:block;font-weight:400;opacity:.6}
      img{width:260px;border-radius:22px;box-shadow:0 0 0 1px rgb(127 127 127 / .3)}
    </style><h1>Wallpaper · ${engine === "chromium" ? "Chrome" : "WebKit"} · ${theme} · 390×844</h1>
    <div class="g"><div></div>${SCREENS.map(([, t]) => `<div class="h">${t}</div>`).join("")}${row(BEFORE)}${row(AFTER)}</div>`;
    await page.setContent(html, { waitUntil: "load" });
    const file = path.join(outDir, `${engine}-${theme}.png`);
    await page.locator("body").screenshot({ path: file });
    console.log(path.relative(path.resolve(outDir, "../../.."), file));
  }
}
await browser.close();
