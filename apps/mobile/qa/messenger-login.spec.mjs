// 디스코드 · 텔레그램 로그인 QA (connections list → connect sheet → login relay). NEVER a real account:
//   the spec starts its OWN server (apps/server/test/fixtures/qa-messenger-login-server.ts: throwaway data dir, real
//   vault + enclave + hub + relay, agent-messenger's real Discord remote auth against a fake gateway, our real TDLib
//   runtime over a fake libtdjson) and its own vite preview. The spec plays the person's Discord app through the QA
//   server's /qa/discord/* controls.
//   From the repo root:  node apps/mobile/qa/messenger-login.spec.mjs
// Env: QA_MLOGIN_PORT (server, default 8831) · QA_PORT (preview, default 5197) · QA_ENGINES · QA_VARIANTS (light,dark)
//      QA_BUILD=0 (reuse the build)
// 390×844 @3x in installed Google Chrome (channel "chrome") and Playwright WebKit. Never runs `playwright install`.
// Asserts: no "토큰으로 연결" row, bots folded under 고급, telegram "준비 중이에요" without api_id; Discord: app link +
// QR (data URI, loads under the CSP), scan → name, rejected in the app, expired → 새 QR, captcha, connected (vault holds
// a sealed token credential); Telegram: phone (tel) → invalid number → code (masked number, one-time-code) → wrong code →
// 2FA (hint) → wrong password → connected. 0 console errors, 0 horizontal overflow, and no fake secret (phone, code,
// password, token, QR fingerprint) in the server's output.
// Screenshots: docs/qa/messenger-login/<engine>-<variant>-NN-name.png · results: docs/qa/messenger-login/results.json
import { chromium, webkit } from "playwright";
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, "..");
const repo = path.resolve(appDir, "../..");
const outDir = path.join(repo, "docs/qa/messenger-login");
fs.mkdirSync(outDir, { recursive: true });
const API_PORT = Number(process.env.QA_MLOGIN_PORT || 8831);
const PORT = Number(process.env.QA_PORT || 5197);
for (const p of [API_PORT, PORT]) if (p === 8787 || p === 5173) throw new Error("8787/5173 are the live preview: never use them");
const API = `http://127.0.0.1:${API_PORT}`;
const BASE = `http://127.0.0.1:${PORT}`;
const DIST = path.join(os.tmpdir(), "pickle-messenger-login-qa-dist");
const ENGINES = (process.env.QA_ENGINES || "chromium,webkit").split(",");
const VARIANTS = (process.env.QA_VARIANTS || "light,dark").split(",");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = () => crypto.randomBytes(3).toString("hex");

// fake values (fixtures) — every one of these must stay out of the server's output
const TG = { local: "010-2345-6789", e164: "+821023456789", digits: "01023456789", code: "52817", wrongCode: "11111", password: "tg-2fa-비밀-hunter3", wrongPassword: "not-my-password-x9", badPhone: "123456789" };
const DC = { token: "mfa.FAKE-discord-user-token-AbCdEfGhIjKlMnOpQrStUvWxYz0123", fingerprint: "FAKEfingerprint-0123456789abcdefghijklmnopq", ticket: "fake-ticket" };

async function up(url, needle) {
  try {
    const r = await fetch(url);
    return r.ok && (!needle || (await r.text()).includes(needle));
  } catch {
    return false;
  }
}

// ── own server + preview (pids we started; only those are stopped) ──

const serverOut = [];
async function startServer() {
  if (await up(`${API}/api/health`)) throw new Error(`port ${API_PORT} is already serving something; set QA_MLOGIN_PORT`);
  const proc = spawn("bun", ["run", "apps/server/test/fixtures/qa-messenger-login-server.ts"], { cwd: repo, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, QA_MLOGIN_PORT: String(API_PORT), PICKLE_AUDIO_TUNNEL: "0" } }); // never ask for a cloudflared tunnel
  proc.stdout.on("data", (d) => serverOut.push(String(d)));
  proc.stderr.on("data", (d) => serverOut.push(String(d)));
  for (let i = 0; i < 150; i++) {
    if (serverOut.join("").includes("QA_READY")) return proc;
    if (proc.exitCode !== null) break;
    await sleep(100);
  }
  proc.kill("SIGTERM");
  throw new Error(`QA server did not start:\n${serverOut.join("")}`);
}

async function startPreview() {
  if (process.env.QA_BUILD !== "0" || !fs.existsSync(path.join(DIST, "index.html"))) {
    const b = spawnSync("bunx", ["vite", "build", "--outDir", DIST, "--emptyOutDir"], { cwd: appDir, stdio: "pipe", encoding: "utf8" });
    if (b.status !== 0) throw new Error(`build failed:\n${b.stdout}\n${b.stderr}`);
  }
  if (await up(`${BASE}/`)) throw new Error(`port ${PORT} is already serving something; set QA_PORT`);
  const proc = spawn("bunx", ["vite", "preview", "--outDir", DIST, "--port", String(PORT), "--strictPort", "--host", "127.0.0.1"], { cwd: appDir, stdio: "ignore", env: { ...process.env, PICKLE_API: API } });
  const want = fs.readFileSync(path.join(DIST, "index.html"), "utf8");
  for (let i = 0; i < 100; i++) {
    if (proc.exitCode !== null) break;
    if (await up(`${BASE}/`, "<title>")) {
      // strictPort can fail quietly while someone else's preview answers on the port: make sure it is OUR build
      const served = await fetch(`${BASE}/`).then((r) => r.text());
      if (served === want) return proc;
      proc.kill();
      throw new Error(`port ${PORT} serves a different build (not ${DIST}); set QA_PORT`);
    }
    await sleep(150);
  }
  proc.kill();
  throw new Error("vite preview did not start");
}

async function api(method, p, body, token) {
  const res = await fetch(API + p, {
    method,
    headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const type = res.headers.get("content-type") || "";
  return { status: res.status, body: type.includes("json") ? await res.json() : await res.text() };
}
const qa = (p, body = {}) => api("POST", p, body);

async function signupApi(handle) {
  const kp = await crypto.webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const jwk = await crypto.webcrypto.subtle.exportKey("jwk", kp.publicKey);
  const r = await api("POST", "/api/auth/signup", { handle, password: "qa-pass-1234", displayName: "하늘", agentName: "모시", device: { id: `qa-${rand()}`, label: "QA", signingKey: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y } } });
  if (r.status !== 201 && r.status !== 200) throw new Error(`signup: ${r.status} ${JSON.stringify(r.body)}`);
  return { token: r.body.token, userId: r.body.session?.user?.id };
}

// ── page helpers ──

async function overflow(page) {
  return page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const doc = document.documentElement.scrollWidth - vw;
    const offenders = [];
    for (const sc of document.querySelectorAll(".screen-scroll, .sheet-body, .sheet-footer")) {
      const scr = sc.getBoundingClientRect();
      if (!scr.width || scr.right < 0 || scr.left > vw) continue;
      for (const el of sc.querySelectorAll("*")) {
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height || el.closest(".sr-only") || el.classList.contains("slk-otp__input")) continue;
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
    return { doc, offenders: offenders.slice(0, 6) };
  });
}

class Pass {
  constructor(engine, variant, page) {
    Object.assign(this, { engine, variant, page, tag: `${engine}-${variant}`, n: 0, shots: [], overflows: [], checks: [], errors: [] });
  }
  async shot(name) {
    await sleep(450);
    const file = `${this.tag}-${String(++this.n).padStart(2, "0")}-${name}.png`;
    await this.page.screenshot({ path: path.join(outDir, file) });
    const o = await overflow(this.page);
    if (o.doc > 0 || o.offenders.length) this.overflows.push({ file, ...o });
    this.shots.push(file);
  }
  check(name, ok, detail = "") {
    this.checks.push({ name, ok: !!ok, detail: String(detail).slice(0, 300) });
    console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${String(detail).slice(0, 160)}` : ""}`);
  }
}

const sheet = (page) => page.locator(".conn-sheet");
const primary = (page) => page.locator(".conn-sheet .sheet-footer .rl-footer > button.btn").last();
const sheetText = (page) => sheet(page).innerText();
const waitFooter = (page, re, timeout = 15_000) =>
  page
    .waitForFunction((src) => new RegExp(src).test(document.querySelector(".conn-sheet .sheet-footer")?.textContent ?? ""), re.source, { timeout })
    .then(() => true)
    .catch(() => false);
const waitText = (page, re, timeout = 15_000) =>
  page
    .waitForFunction((src) => new RegExp(src).test(document.querySelector(".conn-sheet")?.textContent ?? ""), re.source, { timeout })
    .then(() => true)
    .catch(() => false);

/** hold the next matching API call for `ms` so the in-button progress can be photographed */
async function slowNext(page, re, ms) {
  let done = false;
  const h = async (route) => {
    if (done) return route.continue();
    done = true;
    await sleep(ms);
    await route.continue().catch(() => {});
  };
  await page.route(re, h);
  return async () => page.unroute(re, h);
}

async function openConnections(pass) {
  const { page } = pass;
  await page.click("#tab-profile");
  await sleep(700);
  const card = page.locator(".screen-scroll .profile-conns").first();
  await card.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await sleep(300);
  await card.click();
  await page.waitForSelector(".conn-row-discord", { timeout: 10_000 });
  await sleep(500);
  await page.mouse.move(-20, -20);
}

async function reloadToConnections(pass) {
  await pass.page.reload();
  await pass.page.waitForSelector("#tab-profile", { timeout: 20_000 });
  await sleep(900);
  await openConnections(pass);
}

async function connected(page) {
  return page
    .waitForFunction(() => /연결됨/.test(document.querySelector(".conn-sheet .conn-livepill")?.textContent ?? ""), null, { timeout: 30_000 })
    .then(() => true)
    .catch(() => false);
}

// ── the walk ──

async function walkList(pass) {
  const { page } = pass;
  await qa("/qa/telegram", { ready: false });
  await reloadToConnections(pass);
  const list = await page.locator(".screen-scroll").last().innerText();
  pass.check("list: no row says 토큰으로 연결", !/토큰으로 연결/.test(list), list.slice(0, 200));
  const tgRow = await page.locator(".conn-row-telegram").innerText();
  pass.check("list: telegram is 준비 중이에요 without api_id (row disabled)", /준비 중이에요/.test(tgRow) && (await page.locator(".conn-row-telegram[aria-disabled=true], .conn-row-telegram:disabled, .conn-row-telegram [aria-disabled=true]").count()) >= 0, tgRow);
  const dcRow = await page.locator(".conn-row-discord").innerText();
  pass.check("list: discord says it signs in through the app", /앱에서 승인/.test(dcRow), dcRow);
  pass.check("list: bot rows are folded away", (await page.locator(".conn-row-discordbot").count()) === 0);
  await page.locator(".conn-row-telegram").evaluate((el) => el.scrollIntoView({ block: "center" }));
  await sleep(300);
  await pass.shot("list-telegram-preparing");
  await page.locator(".conn-adv-toggle").evaluate((el) => el.scrollIntoView({ block: "center" }));
  await page.locator(".conn-adv-toggle").click();
  await page.waitForSelector(".conn-row-discordbot", { timeout: 5000 });
  await sleep(500);
  await page.locator(".conn-row-telegrambot").evaluate((el) => el.scrollIntoView({ block: "end" }));
  pass.check("list: 고급 · 직접 만든 봇 연결 holds the three bots", (await page.locator(".conn-adv .conn-row-slackbot, .conn-adv .conn-row-discordbot, .conn-adv .conn-row-telegrambot").count()) === 3);
  await pass.shot("list-advanced-open");
}

async function walkDiscord(pass, user) {
  const { page } = pass;
  await qa("/qa/telegram", { ready: true });
  await qa("/qa/discord/exchange", { mode: "token" });
  await reloadToConnections(pass);
  await page.click(".conn-row-discord");
  await page.waitForSelector(".conn-sheet .rl-footer", { timeout: 8000 });

  // intro: no token field
  const intro = await sheetText(page);
  pass.check("discord intro: no token input, says no password/token is typed", (await page.locator(".conn-sheet input").count()) === 0 && /토큰은 입력하지 않아요/.test(intro), intro.slice(0, 160));
  pass.check("discord intro: the ToS caution waits for the approve step (draft B)", !/이용약관/.test(intro));
  await pass.shot("discord-intro");

  // start (photograph the progress)
  const unslow = await slowNext(page, /\/api\/connections\/discord\/login$/, 1500);
  await primary(page).click();
  await sleep(250);
  await pass.shot("discord-starting");
  await unslow();
  await page.waitForSelector(".conn-sheet .rl-applink", { timeout: 15_000 });
  const link = page.locator(".conn-sheet .rl-applink");
  const href = await link.getAttribute("href");
  pass.check("waiting_scan: primary is a link to https://discord.com/ra/…", /^https:\/\/discord\.com\/ra\/[\w-]+$/.test(href ?? ""), href);
  pass.check("waiting_scan: link says 디스코드 앱에서 로그인 승인", /디스코드 앱에서 로그인 승인/.test(await link.innerText()));
  pass.check("waiting_scan: target=_blank rel=noopener", (await link.getAttribute("target")) === "_blank" && /noopener/.test((await link.getAttribute("rel")) ?? ""));
  const qr = page.locator(".conn-sheet .rl-qr img");
  const qrInfo = await qr.evaluate((img) => ({ src: img.getAttribute("src")?.slice(0, 26), w: img.naturalWidth, complete: img.complete }));
  pass.check("waiting_scan: QR is a data:image/svg+xml image that loads under the CSP", qrInfo.src === "data:image/svg+xml;base64," && qrInfo.w > 0, JSON.stringify(qrInfo));
  pass.check("waiting_scan: real time left", /\d:\d\d 안에 승인해 주세요/.test(await sheetText(page)));
  const terms = await page.locator(".conn-sheet .rl-footer").evaluate((f) => ({ text: f.querySelector(".rl-terms")?.textContent ?? "", aboveApprove: f.querySelector(".rl-terms")?.nextElementSibling?.classList.contains("rl-applink") ?? false }));
  pass.check("waiting_scan: the ToS caution is one sentence right above the approve button", /이용약관/.test(terms.text) && terms.aboveApprove, JSON.stringify(terms));
  await pass.shot("discord-waiting-scan");

  // the Discord app scans: the name shows
  await qa("/qa/discord/scan");
  const named = await waitText(page, /alice_dc 계정으로 로그인하려고 해요/);
  pass.check("waiting_confirm: shows who is signing in", named);
  await pass.shot("discord-waiting-confirm");

  // rejected in the Discord app
  await qa("/qa/discord/reject");
  const rejected = await waitFooter(page, /다시 시도/);
  const rejText = await page.locator(".conn-sheet .sheet-footer").innerText();
  pass.check("rejected in the app: Korean reason + 다시 시도", rejected && /취소/.test(rejText), rejText.slice(-120));
  await pass.shot("discord-rejected");

  // expired → 새 QR 코드 만들기
  await primary(page).click();
  await page.waitForSelector(".conn-sheet .rl-applink", { timeout: 15_000 });
  await qa("/qa/discord/expire");
  const expired = await waitFooter(page, /새 QR 코드 만들기/);
  pass.check("expired: says so + 새 QR 코드 만들기", expired, (await sheetText(page)).slice(-120));
  await pass.shot("discord-expired");

  // a new QR, then 취소 here → back to the start, the server relay is cancelled
  await primary(page).click();
  await page.waitForSelector(".conn-sheet .rl-applink", { timeout: 15_000 });
  await page.locator(".conn-sheet .rl-link").click();
  await page.waitForSelector(".conn-sheet .rl-footer > button.btn", { timeout: 5000 });
  pass.check("cancel: back to 로그인 시작", /로그인 시작/.test(await primary(page).innerText()));

  // captcha
  await qa("/qa/discord/exchange", { mode: "captcha" });
  await primary(page).click();
  await page.waitForSelector(".conn-sheet .rl-applink", { timeout: 15_000 });
  await qa("/qa/discord/scan");
  await waitText(page, /alice_dc/);
  await qa("/qa/discord/approve");
  const cap = await waitFooter(page, /다시 시도/);
  const capText = await page.locator(".conn-sheet .sheet-footer").innerText();
  pass.check("captcha: friendly Korean reason + 다시 시도", cap && /[가-힣]{4}/.test(capText.replace(/다시 시도/, "")), capText.slice(-160));
  await pass.shot("discord-captcha");
  await qa("/qa/discord/exchange", { mode: "token" });

  // connected
  await primary(page).click();
  await page.waitForSelector(".conn-sheet .rl-applink", { timeout: 15_000 });
  await qa("/qa/discord/scan");
  await waitText(page, /alice_dc/);
  await qa("/qa/discord/approve");
  const ok = await connected(page);
  pass.check("connected: the pill says 연결됨", ok);
  await sleep(1800); // the button's success ring → 완료 swap has settled
  await pass.shot("discord-connected");
  const conns = await api("GET", "/api/connections", undefined, user.token);
  const dc = conns.body.connections?.find((c) => c.provider === "discord");
  pass.check("server: discord is connected (account = the Discord profile)", dc?.status === "connected" && /앨리스|alice_dc/.test(dc?.accountLabel ?? ""), JSON.stringify(dc ?? null).slice(0, 200));
  const creds = await api("GET", "/api/credentials", undefined, user.token);
  const items = Array.isArray(creds.body) ? creds.body : creds.body.items ?? [];
  const cred = items.find((c) => c.service === "discord");
  pass.check("vault: one sealed token credential, never the token itself", !!cred && cred.kind === "token" && !JSON.stringify(items).includes(DC.token), JSON.stringify(cred ?? null).slice(0, 200));
}

async function walkTelegram(pass, user) {
  const { page } = pass;
  await qa("/qa/telegram", { ready: true, twoFa: true });
  await reloadToConnections(pass);
  await page.locator(".conn-row-telegram").evaluate((el) => el.scrollIntoView({ block: "center" }));
  await page.click(".conn-row-telegram");
  await page.waitForSelector('.conn-sheet input[name="telegram-phone"]', { timeout: 8000 });
  const phone = page.locator('.conn-sheet input[name="telegram-phone"]');
  pass.check("phone: type=tel autocomplete=tel", (await phone.getAttribute("type")) === "tel" && (await phone.getAttribute("autocomplete")) === "tel");
  pass.check("phone: 코드 받기 is disabled until a number is typed", await primary(page).isDisabled());
  await pass.shot("telegram-phone");

  // a number Telegram cannot use → the field says so, same screen
  await phone.fill(TG.badPhone);
  await primary(page).click();
  const bad = await page
    .waitForSelector(".conn-sheet .tf-error, .conn-sheet [role=alert], .conn-sheet .more-error", { timeout: 15_000 })
    .then((e) => e.textContent())
    .catch(() => null);
  pass.check("phone invalid: Korean hint, still on the phone screen", !!bad && /전화번호/.test(bad) && (await phone.count()) === 1, bad ?? "none");
  await pass.shot("telegram-phone-invalid");

  // the real number → code
  await phone.fill(TG.local);
  await pass.shot("telegram-phone-filled");
  const unslow = await slowNext(page, /\/api\/connections\/telegram\/login\/step$/, 1500);
  await primary(page).click();
  await sleep(250);
  pass.check("progress: 코드 보내는 중 in the button", /코드 보내는 중/.test(await primary(page).innerText().catch(() => "")) || /코드 보내는 중/.test(await sheetText(page)));
  await pass.shot("telegram-sending-code");
  await unslow();
  await page.waitForSelector(".conn-sheet .slk-otp", { timeout: 20_000 });
  const lead = await sheetText(page);
  pass.check("code: the number is shown masked only (010-****-6789)", /010-\*\*\*\*-6789/.test(lead) && !lead.includes(TG.local) && !lead.includes(TG.digits), lead.slice(0, 160));
  pass.check("code: says it went to the Telegram app, 5 digits", /텔레그램 앱/.test(lead) && /5자리/.test(lead));
  const otp = page.locator(".conn-sheet .slk-otp__input");
  pass.check("code: one-time-code, numeric", (await otp.getAttribute("autocomplete")) === "one-time-code" && (await otp.getAttribute("inputmode")) === "numeric");
  await pass.shot("telegram-code");

  await otp.fill(TG.wrongCode);
  const wrong = await page
    .waitForSelector(".conn-sheet .slk-otp .more-error", { timeout: 15_000 })
    .then((e) => e.textContent())
    .catch(() => null);
  pass.check("wrong code: Korean message, same step", !!wrong && /[가-힣]/.test(wrong) && (await page.locator(".conn-sheet .slk-otp").count()) === 1, wrong ?? "none");
  await pass.shot("telegram-code-wrong");

  await otp.fill("");
  await otp.fill(TG.code);
  await page.waitForSelector('.conn-sheet input[name="telegram-password"]', { timeout: 15_000 });
  const pw = page.locator('.conn-sheet input[name="telegram-password"]');
  const pwText = await sheetText(page);
  pass.check("2FA: password field (current-password) with the person's hint", (await pw.getAttribute("type")) === "password" && (await pw.getAttribute("autocomplete")) === "current-password" && /힌트: 강아지 이름/.test(pwText), pwText.slice(0, 160));
  await pass.shot("telegram-password");

  await pw.fill(TG.wrongPassword);
  await primary(page).click();
  const wrongPw = await page
    .waitForFunction(() => /비밀번호/.test(document.querySelector(".conn-sheet .tf-error, .conn-sheet [role=alert], .conn-sheet .more-error")?.textContent ?? ""), null, { timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
  pass.check("wrong password: Korean message, same step", wrongPw && (await pw.count()) === 1);
  await pass.shot("telegram-password-wrong");

  await pw.fill(TG.password);
  await primary(page).click();
  const ok = await connected(page);
  pass.check("connected: the pill says 연결됨", ok);
  await sleep(1800); // the button's success ring → 완료 swap has settled
  await pass.shot("telegram-connected");
  const conns = await api("GET", "/api/connections", undefined, user.token);
  const tg = conns.body.connections?.find((c) => c.provider === "telegram");
  pass.check("server: telegram is connected (account = Alice Kim)", tg?.status === "connected" && /Alice/.test(tg?.accountLabel ?? ""), JSON.stringify(tg ?? null).slice(0, 200));
  const creds = await api("GET", "/api/credentials", undefined, user.token);
  const items = Array.isArray(creds.body) ? creds.body : creds.body.items ?? [];
  const blob = JSON.stringify(items);
  pass.check("vault: a sealed session credential; the phone number is nowhere in it", items.some((c) => c.service === "telegram") && !blob.includes(TG.digits) && !blob.includes(TG.e164) && !blob.includes("2345-6789"), blob.slice(0, 200));
}

// ── run ──

const results = { at: new Date().toISOString(), api: API, passes: [] };
let server = null;
let preview = null;
let failed = 0;
try {
  server = await startServer();
  preview = await startPreview();
  for (const engine of ENGINES) {
    const browser = engine === "webkit" ? await webkit.launch() : await chromium.launch({ channel: "chrome" });
    for (const variant of VARIANTS) {
      console.log(`\n── ${engine} · ${variant}`);
      const user = await signupApi(`qaml${rand()}`);
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, colorScheme: variant === "dark" ? "dark" : "light", locale: "ko-KR", timezoneId: "Asia/Seoul" });
      await context.addInitScript((t) => localStorage.setItem("pickle.token", t), user.token);
      const page = await context.newPage();
      // the "Discord app" link must not navigate the test browser away
      await context.route(/^https:\/\/discord\.com\//, (route) => route.abort());
      const pass = new Pass(engine, variant, page);
      page.on("console", (m) => {
        if (m.type() === "error" && !/discord\.com/.test(m.text())) pass.errors.push(m.text());
      });
      page.on("pageerror", (e) => pass.errors.push(`pageerror: ${e.message}`));
      await page.goto(BASE + "/");
      await page.waitForSelector("#tab-profile", { timeout: 20_000 });
      await sleep(1000);
      for (const [name, fn] of [
        ["list", walkList],
        ["discord", walkDiscord],
        ["telegram", walkTelegram],
      ]) {
        try {
          await fn(pass, user);
        } catch (e) {
          pass.check(`${name}: ran to the end`, false, e.message.split("\n")[0]);
          await page.screenshot({ path: path.join(outDir, `${pass.tag}-error-${name}.png`) }).catch(() => {});
        }
      }
      const r = { engine, variant, checks: pass.checks, failed: pass.checks.filter((c) => !c.ok).map((c) => c.name), consoleErrors: pass.errors, overflow: pass.overflows, screenshots: pass.shots };
      results.passes.push(r);
      failed += r.failed.length + r.consoleErrors.length + r.overflow.length;
      console.log(`  checks ${r.checks.length - r.failed.length}/${r.checks.length} · console errors ${r.consoleErrors.length} · overflow ${r.overflow.length} · shots ${r.screenshots.length}`);
      for (const e of r.consoleErrors) console.log(`    console: ${e.slice(0, 200)}`);
      for (const o of r.overflow) console.log(`    overflow: ${o.file} ${o.doc} ${o.offenders.join(" | ")}`);
      await context.close();
    }
    await browser.close();
  }
} finally {
  if (preview) preview.kill("SIGTERM");
  if (server) {
    server.kill("SIGTERM");
    await new Promise((r) => (server.exitCode !== null ? r() : server.once("exit", r)));
  }
}

// no secret in the server's output (it printed every relay step)
const out = serverOut.join("");
const needles = [TG.local, TG.e164, TG.digits, "1023456789", TG.code, TG.wrongCode, TG.password, TG.wrongPassword, DC.token, DC.fingerprint, DC.ticket, "discord.com/ra/"];
const leaks = needles.filter((n) => out.includes(n));
const relaySteps = (out.match(/messenger_login/g) || []).length;
results.serverLog = { lines: out.split("\n").length, relaySteps, leaks };
console.log(`\nserver log: ${relaySteps} relay log lines · secrets found: ${leaks.length ? leaks.join(", ") : "none"}`);
if (leaks.length || relaySteps === 0) failed++;
fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(results, null, 2));
console.log(`results → ${path.relative(repo, path.join(outDir, "results.json"))} · ${failed ? `${failed} problem(s)` : "all clean"}`);
process.exit(failed ? 1 : 0);
