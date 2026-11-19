// Top bar QA (shared top-bar rule, MOTION-SPEC §8.17): the centre is never glass. 채팅's root shows the agent (face +
// name, a ≥ 44 px button that opens the agent sheet); every other root and every pushed screen is empty at rest and
// takes the large title's words as plain text once the title scrolls under the bar; the agent's name never repeats.
// Against a running server and a built preview (never :5173 / :8787):
//   PICKLE_AUDIO_TUNNEL=0 PICKLE_AUDIO_PORT=<own> MEET_BOT_URL=off STT_URL=off TWILIO_ACCOUNT_SID= TWILIO_AUTH_TOKEN= \
//     TWILIO_FROM= PICKLE_DATA_DIR=<fresh> PORT=<api> bun run apps/server/src/index.ts
//   PICKLE_API=http://127.0.0.1:<api> bunx vite preview --outDir <dist> --port <web> --strictPort
//   QA_BASE=http://127.0.0.1:<web> QA_API=http://127.0.0.1:<api> node apps/mobile/qa/topbar.spec.mjs
// Env: QA_ENGINES (chromium,webkit) · QA_VARIANTS (light,dark,reduced) · QA_SHOTS=1 (docs/qa/topbar/*.jpg, 390×844 @2x q82)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, webkit } from "playwright";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../../..");
const BASE = process.env.QA_BASE;
const API = process.env.QA_API;
if (!BASE || !API) throw new Error("set QA_BASE (preview) and QA_API (server)");
const ENGINES = (process.env.QA_ENGINES || "chromium,webkit").split(",");
const VARIANTS = (process.env.QA_VARIANTS || "light,dark,reduced").split(",");
const SHOTS = process.env.QA_SHOTS === "1";
const OUT = path.join(repo, "docs/qa/topbar");
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = () => Math.random().toString(36).slice(2, 8);

const results = [];
let failed = false;
function check(tag, name, ok, detail) {
  results.push({ tag, name, ok: !!ok, detail });
  if (!ok) failed = true;
  console.log(`${ok ? "ok  " : "FAIL"} ${tag} · ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`);
}

async function signup() {
  const device = { id: `qa-${rand()}`, label: "QA", signingKey: { kty: "EC", crv: "P-256", x: "f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU", y: "x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0" } };
  const res = await fetch(`${API}/api/auth/signup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ handle: `qa_tb_${rand()}`, password: "qa-pass-1234", displayName: "하늘", agentName: "깽이", device }),
  });
  if (!res.ok) throw new Error(`signup ${res.status} ${await res.text()}`);
  return res.json();
}

/** what the centre shows, and whether anything in it is glass */
const centre = (page) =>
  page.evaluate(() => {
    const c = document.querySelector(".topbar .tb-center");
    const btn = c?.querySelector("button.tb-agent");
    const r = btn?.getBoundingClientRect();
    const cs = c ? getComputedStyle(c) : null;
    return {
      mode: c?.getAttribute("data-mode"),
      text: (c?.querySelector(".swap-host > :not([aria-hidden='true'])")?.textContent ?? c?.textContent ?? "").trim(),
      glassInCentre: c ? c.querySelectorAll(".glass").length + (c.classList.contains("glass") ? 1 : 0) : -1,
      backdrop: cs ? cs.backdropFilter || cs.webkitBackdropFilter || "none" : null,
      bg: cs?.backgroundColor,
      button: r ? { w: Math.round(r.width), h: Math.round(r.height), label: btn.getAttribute("aria-label") } : null,
      barGlass: document.querySelectorAll(".topbar .glass").length,
      back: document.querySelector(".topbar > .tb-circle")?.getAttribute("aria-label"),
    };
  });

async function scrollActive(page, y) {
  await page.evaluate((y) => {
    const all = [...document.querySelectorAll(".screen-scroll")].filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.left >= -1 && r.left < innerWidth / 2 && getComputedStyle(el).visibility !== "hidden" && !el.closest("[inert]");
    });
    const el = all.at(-1);
    if (el) el.scrollTo({ top: y, behavior: "instant" });
  }, y);
  await sleep(900);
}

async function run(engineName, variant) {
  const tag = `${engineName}/${variant}`;
  const theme = variant === "dark" ? "dark" : "light";
  const auth = await signup();
  const agentName = auth.session?.agent?.name ?? "깽이";
  const bt = engineName === "chromium" ? chromium : webkit;
  const browser = await bt.launch(engineName === "chromium" ? { channel: "chrome", args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] } : {});
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: engineName === "chromium",
    hasTouch: true,
    colorScheme: theme,
    reducedMotion: variant === "reduced" ? "reduce" : "no-preference",
    locale: "ko-KR",
  });
  await ctx.addInitScript((tk) => localStorage.setItem("pickle.token", tk), auth.token);
  const page = await ctx.newPage();
  const errors = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  let n = 0;
  const shot = async (name) => {
    n++;
    if (SHOTS) await page.screenshot({ path: path.join(OUT, `${engineName}-${variant}-${String(n).padStart(2, "0")}-${name}.jpg`), type: "jpeg", quality: 82 });
  };

  await page.goto(`${BASE}/`, { waitUntil: "load" });
  await page.waitForSelector(".topbar .tb-center", { timeout: 20_000 });
  await sleep(1800);

  // ── 채팅's root: the agent, plain ──
  let c = await centre(page);
  check(tag, "채팅 root: the agent (face + name) in the centre", c.mode === "agent" && c.text === agentName, { mode: c.mode, text: c.text });
  check(tag, "채팅 root: nothing in the centre is glass (no backdrop, no fill)", c.glassInCentre === 0 && c.backdrop === "none" && /rgba\(0, 0, 0, 0\)|transparent/.test(c.bg), c);
  check(tag, "채팅 root: the agent is a ≥ 44 px button named for the profile", !!c.button && c.button.h >= 44 && c.button.w >= 44 && c.button.label === `${agentName} 프로필`, c.button);
  await shot("chat-root");
  await page.locator(".topbar button.tb-agent").click();
  const sheet = await page.waitForSelector("[role=dialog]", { timeout: 5000 }).then(() => true).catch(() => false);
  check(tag, "tapping the agent opens the agent sheet", sheet);
  await page.keyboard.press("Escape");
  await sleep(700);

  // ── another root: empty at rest, the large title's words as plain text once under the bar ──
  await page.click("#tab-explore");
  await sleep(1400);
  c = await centre(page);
  check(tag, "둘러보기 root at rest: the centre is empty (no agent)", c.mode === "none" && c.text === "", { mode: c.mode, text: c.text });
  await shot("explore-rest");
  await scrollActive(page, 420);
  c = await centre(page);
  check(tag, "둘러보기 scrolled: '둘러보기' as plain text, not glass", c.mode === "title" && c.text === "둘러보기" && c.glassInCentre === 0 && c.backdrop === "none", { mode: c.mode, text: c.text, glass: c.glassInCentre });
  await shot("explore-scrolled");
  await scrollActive(page, 0);
  c = await centre(page);
  check(tag, "둘러보기 back at the top: the title hands back (empty)", c.mode === "none", c.mode);

  // ── a pushed screen: back circle, empty at rest, never the agent's name ──
  await page.click("#tab-profile");
  await sleep(1400);
  c = await centre(page);
  check(tag, "나의 모시 root at rest: empty", c.mode === "none" && c.text === "", { mode: c.mode, text: c.text });
  // the account row (내 계정): found by the synthetic handle it shows, whatever its markup
  await page.locator("button, [role=button], a").filter({ hasText: `@${auth.session.user.handle}` }).first().click();
  await sleep(1300);
  c = await centre(page);
  check(tag, "pushed 내 계정 at rest: back circle, empty centre", c.back === "뒤로" && c.mode === "none" && c.text === "", { back: c.back, mode: c.mode, text: c.text });
  await shot("pushed-rest");
  await scrollActive(page, 600);
  c = await centre(page);
  check(tag, "pushed 내 계정 scrolled: its title or nothing — never the agent's name", c.text !== agentName && (c.mode === "none" || (c.mode === "title" && c.text === "내 계정")), { mode: c.mode, text: c.text });
  if (c.mode === "title") await shot("pushed-scrolled");
  await page.getByRole("button", { name: "뒤로" }).click();
  await sleep(900);

  // ── back on 채팅: the agent again; the bar's glass is its circles only ──
  await page.click("#tab-chat");
  await sleep(1400);
  c = await centre(page);
  check(tag, "back on 채팅: the agent again", c.mode === "agent" && c.text === agentName, { mode: c.mode, text: c.text });
  const circles = await page.evaluate(() => [...document.querySelectorAll(".topbar .glass")].every((g) => g.classList.contains("tb-circle") || g.classList.contains("tb-capsule")));
  check(tag, "the top bar's glass is only its side controls", circles && c.barGlass <= 2, { barGlass: c.barGlass });

  check(tag, "no console errors", errors.length === 0, errors.slice(0, 3));
  await browser.close();
}

for (const e of ENGINES) for (const v of VARIANTS) await run(e, v);
fs.writeFileSync(path.join(OUT, "results.json"), JSON.stringify({ when: new Date().toISOString(), results }, null, 2));
console.log(failed ? "QA: FAIL" : `QA: PASS (${results.length} checks)`);
process.exit(failed ? 1 : 0);
