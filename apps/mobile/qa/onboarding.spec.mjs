// Onboarding QA (draft "onboarding" B + the user's memo: the face next to the 모시 name). Against a running server and a
// built preview — never :5173 / :8787:
//   PICKLE_AUDIO_TUNNEL=0 MEET_BOT_URL=off STT_URL=off TWILIO_ACCOUNT_SID= TWILIO_AUTH_TOKEN= TWILIO_FROM= \
//     PICKLE_DATA_DIR=<fresh> PORT=<api> bun run apps/server/src/index.ts
//   PICKLE_API=http://127.0.0.1:<api> bunx vite preview --outDir <dist> --port <web> --strictPort
//   QA_BASE=http://127.0.0.1:<web> QA_API=http://127.0.0.1:<api> node apps/mobile/qa/onboarding.spec.mjs
// Env: QA_ENGINES (chromium,webkit) · QA_THEMES (light,dark) · QA_SHOTS=1 (write docs/design/drafts/onboarding/
// applied-*.jpg from chromium, 390×844 @2x q82) · QA_HUE (the device's character hue, default 96 as the draft).
// Synthetic data only ("하늘", qa_* handles, bogus passwords). Fake media devices; no permission is asked here anyway.
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
const THEMES = (process.env.QA_THEMES || "light,dark").split(",");
const SHOTS = process.env.QA_SHOTS === "1";
const HUE = Number(process.env.QA_HUE || 96);
const OUT = path.join(repo, "docs/design/drafts/onboarding");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = () => Math.random().toString(36).slice(2, 8);
const PASSWORD = "qa-pass-1234";

const results = [];
let failed = false;
function check(tag, name, ok, detail) {
  results.push({ tag, name, ok: !!ok, detail });
  if (!ok) failed = true;
  console.log(`${ok ? "ok  " : "FAIL"} ${tag} · ${name}${detail !== undefined ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
}

// the server allows 10 sign-ups / logins per minute per IP: pace them
const authTimes = [];
async function authSlot() {
  for (;;) {
    const now = Date.now();
    while (authTimes.length && now - authTimes[0] > 61_000) authTimes.shift();
    if (authTimes.length < 8) {
      authTimes.push(now);
      return;
    }
    await sleep(61_000 - (now - authTimes[0]) + 200);
  }
}

async function shot(page, name) {
  if (!SHOTS) return;
  await page.screenshot({ path: path.join(OUT, `${name}.jpg`), type: "jpeg", quality: 82 });
}

/** layout facts of the open sheet and the character */
/** the first non-empty inline error under the open sheet (the text enters a beat after its row; waits for the words) */
const errorText = (page, sel, timeout) =>
  page
    .waitForFunction((sel) => [...document.querySelectorAll(sel)].map((e) => e.textContent?.trim()).find(Boolean) || false, sel, { timeout })
    .then((h) => h.jsonValue())
    .catch(() => "");

async function geometry(page) {
  return page.evaluate(() => {
    const r = (el) => {
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return { x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height), bottom: Math.round(b.bottom) };
    };
    const panel = document.querySelector("[role=dialog].sheet-panel, .sheet-panel[role=dialog]");
    const scrim = document.querySelector(".sheet-scrim");
    const blob = document.querySelector(".onb-blob-move");
    const name = document.querySelector(".onb-stage-name");
    const field = [...document.querySelectorAll(".tf")].find((t) => t.querySelector(".tf-label")?.textContent?.trim() === "모시 이름");
    return {
      panel: r(panel),
      scrimBg: scrim ? getComputedStyle(scrim).backgroundColor : null,
      shellInert: !!document.querySelector("[inert]"),
      blob: r(blob),
      name: name ? { text: name.textContent?.trim(), visible: getComputedStyle(name).visibility === "visible", box: r(name) } : null,
      faceInField: !!field?.querySelector(".tf-leading svg, .tf-leading canvas"),
      leading: document.querySelector(".sheet-leading")?.getAttribute("aria-label") ?? null,
      title: document.querySelector(".sheet-title")?.textContent?.trim() ?? null,
      copyOpacity: Number(getComputedStyle(document.querySelector(".onb-copy")).opacity),
      active: document.activeElement?.getAttribute("aria-label") || document.activeElement?.closest(".tf")?.querySelector(".tf-label")?.textContent?.trim() || document.activeElement?.tagName,
    };
  });
}

/** the hue an Avatar draws (its mid stop, `hsl(<hue> 80% 58%)`); null when none is on screen */
const hueIn = (page, sel) =>
  page.evaluate((sel) => {
    const m = document.querySelector(sel)?.outerHTML.match(/hsl\(([\d.]+) 80% 58%\)/);
    return m ? Number(m[1]) : null;
  }, sel);

/**
 * The hue a person actually sees in an element's box (pixels, so the 3D canvas counts as much as the SVG poster):
 * circular mean over the saturated, mid-light pixels; null when there are too few.
 */
async function visibleHue(page, sel) {
  const box = await page.locator(sel).first().boundingBox();
  if (!box) return null;
  const png = await page.screenshot({ clip: box, type: "png" });
  return page.evaluate(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const img = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
    const g = new OffscreenCanvas(img.width, img.height).getContext("2d");
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, img.width, img.height).data;
    let x = 0, y = 0, n = 0;
    for (let i = 0; i < d.length; i += 16) {
      const r = d[i] / 255, gr = d[i + 1] / 255, b = d[i + 2] / 255;
      const max = Math.max(r, gr, b), min = Math.min(r, gr, b), c = max - min, l = (max + min) / 2;
      if (!c || c / (1 - Math.abs(2 * l - 1)) < 0.45 || l < 0.2 || l > 0.85) continue;
      let h = max === r ? ((gr - b) / c) % 6 : max === gr ? (b - r) / c + 2 : (r - gr) / c + 4;
      h = (h * 60 + 360) % 360;
      x += Math.cos((h * Math.PI) / 180);
      y += Math.sin((h * Math.PI) / 180);
      n++;
    }
    return n < 50 ? null : Math.round(((Math.atan2(y, x) * 180) / Math.PI + 360) % 360);
  }, png.toString("base64"));
}
const near = (a, b, tol = 20) => a !== null && b !== null && Math.abs((((a - b) % 360) + 540) % 360 - 180) <= tol;

/** an account made through the API, the way the capture scripts and other devices meet one (no character saved) */
async function signupApi() {
  const { publicKey } = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", publicKey);
  const device = { id: `qa-${rand()}`, label: "QA", signingKey: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y } };
  const handle = `qa_onb_api_${rand()}`;
  await authSlot();
  const res = await fetch(`${API}/api/auth/signup`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ handle, password: PASSWORD, displayName: "하늘", agentName: "깽이", device }) });
  if (!res.ok) throw new Error(`signup ${res.status} ${await res.text()}`);
  return handle;
}

/**
 * Another device logs in: its own preview hue on the hero first, then the account's character on the stage (sampled
 * until the onboarding leaves), in the chat, in the device copy, and again after a reload.
 */
async function loginElsewhere(browser, engineName, theme, handle, previewHue) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: engineName === "chromium", hasTouch: true, colorScheme: theme, locale: "ko-KR" });
  await ctx.addInitScript((hue) => {
    try {
      if (!localStorage.getItem("pickle.agentSpec")) localStorage.setItem("pickle.agentSpec", JSON.stringify({ hue, shape: "blob", eyes: "dot" }));
    } catch {}
  }, previewHue);
  const page = await ctx.newPage();
  const errors = [];
  page.on("console", (m) => m.type() === "error" && !/status of (401|409|429)/.test(m.text()) && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  await page.goto(`${BASE}/`, { waitUntil: "load" });
  await page.waitForSelector(".onb");
  await sleep(1500);
  const before = await hueIn(page, ".onb-blob-move svg.avatar");
  const heroSeen = await visibleHue(page, ".onb-blob-move");
  await page.getByRole("button", { name: /로그인/ }).first().click();
  await page.waitForSelector("[role=dialog] .onb-form");
  await sleep(700);
  await page.getByRole("textbox", { name: "아이디" }).fill(handle);
  await page.getByRole("textbox", { name: "비밀번호" }).fill(PASSWORD);
  await authSlot();
  const sampled = page.evaluate(async () => {
    const out = [];
    const t0 = performance.now();
    while (document.querySelector(".onb") && performance.now() - t0 < 15_000) {
      const m = document.querySelector(".onb-blob-move svg.avatar")?.outerHTML.match(/hsl\(([\d.]+) 80% 58%\)/);
      if (m) out.push(Number(m[1]));
      await new Promise((r) => setTimeout(r, 40));
    }
    return out;
  });
  await page.getByRole("button", { name: "로그인", exact: true }).click();
  // the confirmed beat: the character still on its stage, the sheet showing "로그인했어요"
  await page.waitForFunction(() => /로그인했어요/.test(document.querySelector("[role=dialog]")?.textContent || ""), null, { timeout: 15_000 }).catch(() => {});
  await sleep(120);
  const canvas = await page.evaluate(() => !!document.querySelector(".onb-blob-move canvas"));
  const stageSeen = await visibleHue(page, ".onb-blob-move");
  const stage = await sampled;
  await page.waitForSelector(".topbar .tb-agent svg.avatar", { timeout: 15_000 }).catch(() => {});
  await sleep(600);
  const bar = await hueIn(page, ".topbar .tb-agent svg.avatar");
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("pickle.agentSpec") || "null")?.hue ?? null);
  const token = await page.evaluate(() => localStorage.getItem("pickle.token"));
  const server = await fetch(`${API}/api/agent`, { headers: { Authorization: `Bearer ${token}` } })
    .then((r) => r.json())
    .then((a) => a?.avatar?.hue ?? null);
  await page.reload({ waitUntil: "load" });
  await page.waitForSelector(".topbar .tb-agent svg.avatar", { timeout: 15_000 }).catch(() => {});
  await sleep(800);
  const reloadBar = await hueIn(page, ".topbar .tb-agent svg.avatar");
  const reloadStored = await page.evaluate(() => JSON.parse(localStorage.getItem("pickle.agentSpec") || "null")?.hue ?? null);
  await ctx.close();
  return { before, heroSeen, stageFirst: stage[0] ?? null, stageLast: stage.at(-1) ?? null, stageSeen, canvas, bar, stored, server, reloadBar, reloadStored, errors };
}

async function run(engineName, theme) {
  const tag = `${engineName}/${theme}`;
  const bt = engineName === "chromium" ? chromium : webkit;
  const browser = await bt.launch(engineName === "chromium" ? { channel: "chrome", args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] } : {});
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: engineName === "chromium", hasTouch: true, colorScheme: theme, locale: "ko-KR" });
  await ctx.addInitScript((hue) => {
    try {
      if (!localStorage.getItem("pickle.agentSpec")) localStorage.setItem("pickle.agentSpec", JSON.stringify({ hue, shape: "blob", eyes: "dot" }));
    } catch {}
  }, HUE);
  const page = await ctx.newPage();
  const errors = [];
  // expected 4xx/5xx of the error steps: 401 (wrong login), 409 (taken / no verified phone), 429 (paced auth), and the
  // reset start's 503 phone_unavailable (QA servers run with TWILIO_* blank, so no call can be placed)
  let resetUnavailable = false;
  let verifyMocked = false; // the route-mocked 400 invalid_code below
  page.on("response", (r) => r.url().includes("/api/auth/reset/start") && r.status() === 503 && (resetUnavailable = true));
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const t = m.text();
    if (/Failed to load resource: the server responded with a status of (401|409|429)/.test(t)) return;
    if (resetUnavailable && /status of 503/.test(t)) return;
    if (verifyMocked && /status of 400/.test(t)) return;
    errors.push(t);
  });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  const sx = (n) => (SHOTS && engineName === "chromium" ? shot(page, n.replace("{t}", theme)) : null);

  await page.goto(`${BASE}/`, { waitUntil: "load" });
  await page.waitForSelector(".onb");
  await sleep(1800);
  const hero = await geometry(page);
  const sub = await page.locator(".onb-sub").innerText();
  check(tag, "hero: the new subtitle (B)", sub.includes("전화도 대신 걸고, 카카오톡도 정리해 드려요"), sub);
  await sx("applied-{t}");

  // ── sign-up step 1 ──
  await page.getByRole("button", { name: "시작하기" }).click();
  await page.waitForSelector("[role=dialog] .onb-form");
  await sleep(900);
  const s1 = await geometry(page);
  check(tag, "step 1: no dimming (undimmed sheet), shell still inert", /rgba?\(0, 0, 0, 0\)|transparent/.test(s1.scrimBg) && s1.shellInert, s1.scrimBg);
  check(tag, "step 1: the character rose above the sheet (one element, scaled ≈168/208)", s1.blob && s1.panel && s1.blob.bottom <= s1.panel.y - 8 && Math.abs(s1.blob.w - 168) <= 6, { blob: s1.blob, panelTop: s1.panel?.y, heroBlob: hero.blob });
  check(tag, "step 1: headline faded", s1.copyOpacity < 0.05, s1.copyOpacity);
  check(tag, "step 1: no leading button", s1.leading === null, s1.leading);
  const hint = await page.locator("[role=dialog] .tf-hint").first().innerText();
  check(tag, "step 1: id hint in plain words (P3-1)", hint.startsWith("영문 소문자와 숫자로 3~20자예요"), hint);
  await sx("applied-step1-{t}");

  const handle = `qa_onb_${rand()}`;
  await page.getByRole("textbox", { name: "아이디" }).fill(handle);
  await page.getByRole("textbox", { name: "비밀번호" }).fill(PASSWORD);
  await page.getByRole("button", { name: "다음" }).click();
  await page.waitForSelector("[role=dialog] >> text=내 이름");
  await sleep(700);
  const s2 = await geometry(page);
  check(tag, "step 2: same sheet height as step 1 (P2-2)", s1.panel && s2.panel && Math.abs(s1.panel.h - s2.panel.h) <= 1 && Math.abs(s1.panel.y - s2.panel.y) <= 1, { s1: s1.panel, s2: s2.panel });
  check(tag, "step 2: '이전 단계' in the sheet head", s2.leading === "이전 단계", s2.leading);
  check(tag, "step 2: no autofocus (no blue ring on arrival)", !/내 이름|모시 이름/.test(String(s2.active)), s2.active);
  check(tag, "step 2: the face next to the 모시 name (memo)", s2.faceInField);
  check(tag, "step 2: the name under the face on the stage", s2.name?.visible && s2.name.text === "깽이" && s2.name.box.y > s2.blob.bottom - 4 && s2.name.box.bottom <= s2.panel.y, s2.name);
  check(tag, "step 2: the character did not move between steps", Math.abs(s2.blob.y - s1.blob.y) <= 1, { s1: s1.blob.y, s2: s2.blob.y });
  await page.getByRole("textbox", { name: "모시 이름" }).fill("콩콩이");
  await sleep(100);
  const typed = await page.locator(".onb-stage-name").innerText();
  check(tag, "step 2: the stage name follows the input", typed.trim() === "콩콩이", typed);
  await page.getByRole("button", { name: "깽이" }).click();
  await page.getByRole("textbox", { name: "내 이름" }).fill("하늘");
  await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
  await sleep(400);
  await sx("applied-step2-{t}");
  await page.getByRole("button", { name: "이전 단계" }).click();
  await sleep(500);
  check(tag, "'이전 단계' goes back to step 1 with the input kept", (await page.getByRole("textbox", { name: "아이디" }).inputValue()) === handle);
  await page.getByRole("button", { name: "다음" }).click();
  await page.waitForSelector("[role=dialog] >> text=내 이름");
  await sleep(500);

  // ── create: the character is saved as the agent's ──
  await authSlot();
  await page.getByRole("button", { name: "모시 만들기" }).click();
  await page.waitForSelector(".onb", { state: "detached", timeout: 20_000 });
  const token = await page.evaluate(() => localStorage.getItem("pickle.token"));
  const agent = await fetch(`${API}/api/agent`, { headers: { Authorization: `Bearer ${token}` } }).then((r) => r.json());
  check(tag, "sign-up saves the character met on the first screen", agent?.avatar?.hue === HUE && agent.avatar.eyes === "dot", agent?.avatar);
  await page.waitForSelector(".topbar .tb-agent svg.avatar", { timeout: 10_000 }).catch(() => {});
  const chatHue = await hueIn(page, ".topbar .tb-agent svg.avatar");
  check(tag, "sign-up: the chat shows the same character (server's hue)", chatHue === HUE, { chatHue, server: agent?.avatar?.hue });
  await sleep(1200);

  // ── login sheet + reset (a fresh context: signed out) ──
  await page.evaluate(() => {
    localStorage.removeItem("pickle.token");
  });
  await page.goto(`${BASE}/`, { waitUntil: "load" });
  await page.waitForSelector(".onb");
  await sleep(1200);
  await page.getByRole("button", { name: /로그인/ }).first().click();
  await page.waitForSelector("[role=dialog] .onb-form");
  await sleep(900);
  const lg = await geometry(page);
  check(tag, "login: undimmed, character above the sheet", /rgba?\(0, 0, 0, 0\)|transparent/.test(lg.scrimBg) && lg.blob.bottom <= lg.panel.y - 8, { blob: lg.blob, panel: lg.panel });
  check(tag, "login: '비밀번호를 잊었어요' and '처음이에요 · 시작하기'", (await page.getByRole("button", { name: "비밀번호를 잊었어요" }).count()) === 1 && (await page.getByRole("button", { name: /처음이에요/ }).count()) === 1);
  await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
  await sleep(300);
  await sx("applied-login-{t}");
  await page.getByRole("button", { name: "비밀번호를 잊었어요" }).click();
  await sleep(700);
  const rs = await geometry(page);
  check(tag, "reset: same sheet, title and back button", rs.title === "비밀번호 다시 만들기" && rs.leading === "로그인으로" && Math.abs(rs.panel.h - lg.panel.h) <= 1, { title: rs.title, leading: rs.leading, h: [lg.panel.h, rs.panel.h] });
  // Sheet guard (design-director): a start-aligned title next to the leading button keeps to its own column
  const startGuard = await page.evaluate(() => {
    const panel = document.querySelector("[role=dialog].sheet-panel, .sheet-panel[role=dialog]");
    panel.setAttribute("data-title", "start");
    const lead = panel.querySelector(".sheet-leading").getBoundingClientRect();
    const title = panel.querySelector(".sheet-title").getBoundingClientRect();
    const close = panel.querySelector(".sheet-close:not(.sheet-leading)").getBoundingClientRect();
    panel.removeAttribute("data-title");
    return { leadRight: Math.round(lead.right), titleLeft: Math.round(title.left), titleRight: Math.round(title.right), closeLeft: Math.round(close.left) };
  });
  check(tag, "sheet: a start title never overlaps the leading button", startGuard.titleLeft >= startGuard.leadRight && startGuard.titleRight <= startGuard.closeLeft, startGuard);
  await page.getByRole("textbox", { name: "아이디" }).fill(handle);
  await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
  await sleep(300);
  await sx("applied-reset-{t}");
  // this account never verified a phone (and the QA server has no Twilio): either answer is said inline under 아이디,
  // in the reset flow's own words — never a raw 404 / English message
  await authSlot();
  const startRes = page.waitForResponse((r) => r.url().includes("/api/auth/reset/start"), { timeout: 10_000 }).catch(() => null);
  await page.getByRole("button", { name: "전화로 인증번호 받기" }).click();
  const res = await startRes;
  const err = await errorText(page, "[role=dialog] .tf-error, [role=dialog] .onb-form-error", 10_000);
  check(
    tag,
    "reset: the server route answers 409 no_verified_phone or 503 phone_unavailable, said inline",
    !!res && [409, 503].includes(res.status()) && /인증한 전화번호가 없거나 없는 아이디예요|지금은 전화를 걸 수 없어요/.test(err),
    { status: res?.status() ?? null, err },
  );
  // the code step, route-mocked (no call can be placed here): a verified phone answers {channel:"call", masked}; a
  // wrong 6-digit code answers 400 invalid_code {attemptsLeft}
  await page.route("**/api/auth/reset/start", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ channel: "call", masked: "010-****-5678" }) }));
  await page.route("**/api/auth/reset/verify", (r) => {
    verifyMocked = true;
    return r.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: "invalid_code", message: "invalid code", attemptsLeft: 4 }) });
  });
  // the button kept the failed press as "다시 받기" (Button's error state): pressing it again is the user's retry
  await page.getByRole("button", { name: "다시 받기", exact: true }).click();
  await page.waitForSelector("[role=dialog] .onb-reset-lead >> text=010-****-5678", { timeout: 8000 }).catch(() => {});
  await sleep(900);
  const cd = await geometry(page);
  const codeFacts = await page.evaluate(() => {
    const tf = [...document.querySelectorAll(".tf")].find((t) => t.querySelector(".tf-label")?.textContent?.trim() === "인증번호");
    const input = tf?.querySelector("input");
    return {
      lead: document.querySelector("[role=dialog] .onb-reset-lead")?.textContent?.trim(),
      maxLength: input?.maxLength,
      inputMode: input?.inputMode,
      autocomplete: input?.getAttribute("autocomplete"),
      again: (() => {
        const b = tf?.querySelector(".tf-trailing button");
        const r = b?.getBoundingClientRect();
        return !!b && b.getAttribute("aria-label") === "인증번호 다시 받기" && r.height >= 44 && r.width >= 44;
      })(),
      // nothing in the code view hides under the footer: the last line ends above the primary button
      clear: (() => {
        const form = document.querySelector("[role=dialog] .onb-form");
        const foot = document.querySelector("[role=dialog] .sheet-footer, [role=dialog] footer");
        const last = form && [...form.querySelectorAll(".tf-hint, .tf-error, .tf, .onb-form-error")].pop();
        return !!last && !!foot && last.getBoundingClientRect().bottom <= foot.getBoundingClientRect().top + 1;
      })(),
    };
  });
  check(
    tag,
    "code step: the masked number is said, 6-digit one-time-code field with '다시 받기' inside (≥44 px), nothing under the footer, same sheet, '이전 단계'",
    codeFacts.lead === "010-****-5678로 전화를 걸어 인증번호를 불러 드렸어요." && codeFacts.maxLength === 6 && codeFacts.inputMode === "numeric" && codeFacts.autocomplete === "one-time-code" && codeFacts.again && codeFacts.clear && cd.leading === "이전 단계" && Math.abs(cd.panel.h - lg.panel.h) <= 1,
    { ...codeFacts, leading: cd.leading, h: [lg.panel.h, cd.panel.h] },
  );
  await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
  await sleep(300);
  await sx("applied-code-{t}");
  await page.getByRole("textbox", { name: "인증번호" }).fill("123456");
  await page.getByLabel("새 비밀번호").fill("qa-new-pass-1234");
  await page.getByRole("button", { name: "비밀번호 바꾸기" }).click();
  const wrong = await errorText(page, "[role=dialog] .tf-error", 8000);
  check(tag, "a wrong code says how many tries are left (attemptsLeft)", wrong.trim() === "인증번호가 맞지 않아요. 4번 더 입력할 수 있어요", wrong);
  await page.unroute("**/api/auth/reset/start");
  await page.unroute("**/api/auth/reset/verify");
  await sleep(1200); // the button's error label settles
  await page.getByRole("button", { name: "이전 단계" }).click();
  await sleep(600);
  await page.getByRole("button", { name: "로그인으로" }).click();
  await sleep(500);
  check(tag, "back to 로그인", (await page.locator(".sheet-title").innerText()).trim() === "로그인");
  await page.getByRole("button", { name: /처음이에요/ }).click();
  await sleep(900);
  check(tag, "'처음이에요 · 시작하기' opens sign-up", /모시 만들기/.test(await page.locator(".sheet-title").innerText()));
  await page.keyboard.press("Escape");
  await sleep(700);
  const back = await geometry(page);
  check(tag, "closed: the character is back in the hero, the headline visible", !back.panel && back.copyOpacity > 0.95 && Math.abs(back.blob.y - hero.blob.y) <= 2, { blob: back.blob, hero: hero.blob });

  check(tag, "no console errors", errors.length === 0, errors.slice(0, 3));

  // ── one character across devices: the server's agent spec is the one source ──
  const other = HUE === 262 ? 28 : 262; // another device's preview, different from the account's
  const x = await loginElsewhere(browser, engineName, theme, handle, other);
  check(tag, "another device: its own preview on the hero before login", x.before === other, x);
  check(tag, "another device: after login the stage takes the account's character before the chat", x.stageFirst === other && x.stageLast === HUE, x);
  check(tag, `another device: the colour on screen follows (pixels${x.canvas ? ", 3D canvas" : ", poster"}: hero ≈${other}, stage ≈${HUE})`, near(x.heroSeen, other) && near(x.stageSeen, HUE), { heroSeen: x.heroSeen, stageSeen: x.stageSeen, canvas: x.canvas });
  check(tag, "another device: the chat shows the server's character", x.server === HUE && x.bar === HUE, x);
  check(tag, "another device: the device copy follows the server, and a reload keeps it", x.stored === HUE && x.reloadBar === HUE && x.reloadStored === HUE, x);
  // an account made through the API never saved a character: the server's default is the one, everywhere
  const y = await loginElsewhere(browser, engineName, theme, await signupApi(), other);
  check(tag, "API-made account: stage, chat, device copy and reload all show the server's character", y.server !== null && y.stageLast === y.server && near(y.stageSeen, y.server) && y.bar === y.server && y.stored === y.server && y.reloadBar === y.server, y);
  check(tag, "no console errors on the other devices", !x.errors.length && !y.errors.length, [...x.errors, ...y.errors].slice(0, 3));
  await browser.close();
}

for (const e of ENGINES) for (const t of THEMES) await run(e, t);
fs.mkdirSync(path.join(repo, "docs/qa/onboarding"), { recursive: true });
fs.writeFileSync(path.join(repo, "docs/qa/onboarding/results.json"), JSON.stringify({ when: new Date().toISOString(), results }, null, 2));
console.log(failed ? "QA: FAIL" : `QA: PASS (${results.length} checks)`);
process.exit(failed ? 1 : 0);
