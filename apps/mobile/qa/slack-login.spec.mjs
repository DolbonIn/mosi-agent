// Slack 로그인 QA (connect sheet → in-app Slack sign-in). NEVER a real Slack account or email:
//   the spec starts its OWN server (apps/server/test/fixtures/qa-slack-login-server.ts: throwaway data dir, real vault +
//   enclave + hub, the relay drives real headless Chrome against the local FAKE Slack site) and its own vite preview.
//   From the repo root:  node apps/mobile/qa/slack-login.spec.mjs
// Env: QA_SLACK_PORT (server, default 8823) · QA_PORT (preview, default 5193) · QA_ENGINES · QA_VARIANTS (light,dark)
//      QA_BUILD=0 (reuse the build)
// 390×844 @3x in installed Google Chrome (channel "chrome") and Playwright WebKit. Never runs `playwright install`.
// Walks per pass: form → 고급 (token paste) and back → SSO workspace (friendly error + token offer) → password + 2FA
// (wrong code) → password-only workspace → email code (typing, wrong code) → no workspace + code → workspace picker →
// connected (server says connected, vault holds the session).
// Asserts: 0 console errors, 0 horizontal overflow, the OTP input is autocomplete="one-time-code", every error is
// Korean, and at the end: no fake secret (email, code, password, TOTP, token, cookie) in the server's output.
// Screenshots: docs/qa/slack-login/slack-<engine>-<variant>-NN-name.png · results: docs/qa/slack-login/results.json
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
const outDir = path.join(repo, "docs/qa/slack-login");
fs.mkdirSync(outDir, { recursive: true });
const API_PORT = Number(process.env.QA_SLACK_PORT || 8823);
const PORT = Number(process.env.QA_PORT || 5193);
for (const p of [API_PORT, PORT]) if (p === 8787 || p === 5173) throw new Error("8787/5173 are the live preview: never use them");
const API = `http://127.0.0.1:${API_PORT}`;
const BASE = `http://127.0.0.1:${PORT}`;
const DIST = path.join(os.tmpdir(), "pickle-slack-login-qa-dist");
const ENGINES = (process.env.QA_ENGINES || "chromium,webkit").split(",");
const VARIANTS = (process.env.QA_VARIANTS || "light,dark").split(",");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = () => crypto.randomBytes(3).toString("hex");

// the fake site's accounts (apps/server/test/fixtures/fake-slack.ts) — every one of these must stay out of the logs
const FAKE = { code: "Q7K9X2", pw2fa: "pw-2fa", totp: "246810", pwKim: "pw-correct-horse", emails: ["kim@example.com", "multi@example.com", "twofa@example.com", "member@ssoco.example"] };

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
  if (await up(`${API}/api/health`)) throw new Error(`port ${API_PORT} is already serving something; set QA_SLACK_PORT`);
  const proc = spawn("bun", ["run", "apps/server/test/fixtures/qa-slack-login-server.ts"], { cwd: repo, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, QA_SLACK_PORT: String(API_PORT), PICKLE_AUDIO_TUNNEL: "0" } }); // the QA server never opens a tunnel (createApp only, no main.ts); belt and braces
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
  for (let i = 0; i < 100; i++) {
    if (await up(`${BASE}/`, "<title>")) {
      // the page must be OUR build (a port taken by someone else's preview would otherwise pass silently)
      const served = await fetch(`${BASE}/`).then((r) => r.text());
      if (served !== fs.readFileSync(path.join(DIST, "index.html"), "utf8")) {
        proc.kill();
        throw new Error(`port ${PORT} serves a different build; set QA_PORT`);
      }
      return proc;
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
    const file = `slack-${this.tag}-${String(++this.n).padStart(2, "0")}-${name}.png`;
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
const primary = (page) => page.locator(".conn-sheet .sheet-footer .slk-footer > button").last();
const errorText = (page) =>
  page
    .waitForSelector(".conn-sheet .more-error", { timeout: 60_000 })
    .then((e) => e.textContent())
    .catch(() => null);

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

async function fillForm(page, { workspace, email, password }) {
  const f = page.locator(".conn-sheet .conn-form .tf-input");
  await f.nth(0).fill(workspace ?? "");
  await f.nth(1).fill(email);
  if (password !== undefined) await f.nth(2).fill(password);
}

async function restart(page) {
  await page.locator(".conn-sheet .slk-restart").click();
  await page.waitForSelector(".conn-sheet .conn-form", { timeout: 6000 });
  await sleep(300);
}

async function openSlackSheet(pass) {
  const { page } = pass;
  await page.click("#tab-profile");
  await sleep(700);
  const card = page.locator(".screen-scroll .profile-conns").first();
  await card.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await sleep(300);
  await card.click();
  await page.waitForSelector(".conn-row-slack", { timeout: 10_000 });
  await sleep(500);
  await page.mouse.move(-20, -20);
  await pass.shot("connections-list");
  await page.click(".conn-row-slack");
  await page.waitForSelector(".conn-sheet .conn-form", { timeout: 8000 });
}

// ── the walk ──

async function walk(pass, user) {
  const { page } = pass;
  await openSlackSheet(pass);

  // 1. the first screen: Slack 로그인 is the default, the token paste sits under 고급
  const text0 = await sheet(page).innerText();
  pass.check("form: Slack 로그인 first (workspace optional + email, no token fields)", /워크스페이스 주소 \(선택\)/.test(text0) && /이메일/.test(text0) && !/xoxc/.test(text0), text0.slice(0, 120));
  pass.check("form: 고급: 토큰 직접 입력 is offered", /고급: 토큰 직접 입력/.test(text0));
  pass.check("form: 코드 받기 is disabled until an email is typed", await primary(page).isDisabled());
  await pass.shot("form");

  // 2. 고급 → the token paste form (and back)
  await page.locator(".conn-sheet .slk-advanced").click();
  await page.waitForSelector('.conn-sheet input[name="slack-token"]', { timeout: 5000 });
  const adv = await sheet(page).innerText();
  pass.check("advanced: the old token + cookie form", /xoxc/.test(adv) && /xoxd/.test(adv));
  await pass.shot("advanced-token-form");
  if (await page.locator(".conn-sheet .slk-back").count()) {
    await page.locator(".conn-sheet .slk-back").click();
    pass.check("advanced: 'Slack 로그인으로 돌아가기' goes back", true);
  } else {
    // no back link (yet): close and reopen the sheet — it opens on Slack 로그인 again
    await page.locator(".sheet-root .sheet-close").first().click();
    await page.locator(".sheet-root").waitFor({ state: "detached", timeout: 6000 });
    await page.click(".conn-row-slack");
  }
  await page.waitForSelector(".conn-sheet .conn-form input[name=slack-email]", { timeout: 5000 });

  // 3. SSO-only workspace → friendly error + the token offer
  await fillForm(page, { workspace: "ssoco", email: "member@ssoco.example" });
  await primary(page).click();
  const sso = await errorText(page);
  pass.check("sso: friendly Korean message, no automation of the company login", !!sso && /SSO/.test(sso) && /[가-힣]/.test(sso), sso ?? "no error");
  pass.check("sso: offers 토큰 직접 입력으로 연결하기", (await page.locator(".conn-sheet .sheet-footer button", { hasText: "토큰 직접 입력으로 연결하기" }).count()) === 1);
  await pass.shot("sso-unsupported");

  // 4. password + 2FA
  await page.locator(".conn-sheet .slk-links .slk-link").click();
  await fillForm(page, { workspace: "acme", email: "twofa@example.com", password: FAKE.pw2fa });
  pass.check("password form: 비밀번호 field is autocomplete=current-password", (await page.locator('.conn-sheet input[name="slack-password"]').getAttribute("autocomplete")) === "current-password");
  await pass.shot("form-password");
  const unslow = await slowNext(page, /\/api\/connections\/slack\/login$/, 1800);
  await primary(page).click();
  await page.waitForSelector(".conn-sheet .slk-progress", { timeout: 3000 });
  pass.check("progress: the button says what is happening", /로그인하는 중/.test(await primary(page).innerText()), await primary(page).innerText());
  await pass.shot("signing-in");
  await unslow();
  await page.waitForSelector(".conn-sheet .slk-otp", { timeout: 60_000 });
  const otpT = page.locator(".conn-sheet .slk-otp__input");
  pass.check("2fa: numeric OTP (inputmode numeric, one-time-code)", (await otpT.getAttribute("inputmode")) === "numeric" && (await otpT.getAttribute("autocomplete")) === "one-time-code");
  await pass.shot("totp");
  await otpT.fill("111111");
  const wrongTotp = await errorText(page);
  pass.check("2fa: wrong code → Korean message, same step", !!wrongTotp && /[가-힣]/.test(wrongTotp) && (await page.locator(".conn-sheet .slk-otp").count()) === 1, wrongTotp ?? "none");
  await pass.shot("totp-wrong");
  await restart(page);

  // 5. password-only workspace (no email codes) → the password step
  await page.locator(".conn-sheet .slk-links .slk-link").click(); // back to 메일 코드
  await fillForm(page, { workspace: "pwonly", email: "kim@example.com" });
  await primary(page).click();
  await page.waitForSelector('.conn-sheet input[name="slack-password"]', { timeout: 60_000 });
  await pass.shot("password-step");
  await restart(page);

  // 6. email code: typing, wrong code
  await fillForm(page, { workspace: "acme", email: "kim@example.com" });
  await pass.shot("form-filled");
  const unslow2 = await slowNext(page, /\/api\/connections\/slack\/login$/, 1800);
  await primary(page).click();
  await page.waitForSelector(".conn-sheet .slk-progress", { timeout: 3000 });
  pass.check("progress: 코드 보내는 중 in the button", /코드 보내는 중/.test(await primary(page).innerText()));
  await pass.shot("sending-code");
  await unslow2();
  await page.waitForSelector(".conn-sheet .slk-otp", { timeout: 60_000 });
  const otp = page.locator(".conn-sheet .slk-otp__input");
  pass.check("code: one-time-code input, upper-case letters allowed", (await otp.getAttribute("autocomplete")) === "one-time-code" && (await otp.getAttribute("inputmode")) === "text");
  const leadT = await sheet(page).innerText();
  pass.check("code: says where the code went", /kim@example\.com/.test(leadT) && /6자리/.test(leadT));
  await pass.shot("code");
  await otp.pressSequentially("q7k", { delay: 40 });
  pass.check("code: typed letters are upper-cased into the cells", (await page.locator(".conn-sheet .slk-otp__cell.is-filled").allInnerTexts()).join("") === "Q7K");
  await pass.shot("code-typing");
  await otp.fill("");
  await otp.fill("ZZZZZZ");
  const wrong = await errorText(page);
  pass.check("code: wrong code → 그 코드는 맞지 않아요-style Korean message, retry allowed", !!wrong && /[가-힣]/.test(wrong) && (await page.locator(".conn-sheet .slk-otp").count()) === 1, wrong ?? "none");
  await pass.shot("code-wrong");
  await restart(page);

  // 7. no workspace → Slack finds them by email → code → picker → connected
  await fillForm(page, { workspace: "", email: "multi@example.com" });
  await primary(page).click();
  await page.waitForSelector(".conn-sheet .slk-otp", { timeout: 60_000 });
  await page.locator(".conn-sheet .slk-otp__input").fill(FAKE.code);
  await page.waitForSelector(".conn-sheet .slk-ws__row", { timeout: 60_000 });
  const ws = await page.locator(".conn-sheet .slk-ws__row").allInnerTexts();
  pass.check("workspaces: both of the account's workspaces are listed", ws.length === 2 && ws.some((t) => /Acme/.test(t)) && ws.some((t) => /Beta/.test(t)), ws.join(" | "));
  await pass.shot("workspaces");
  const unslow3 = await slowNext(page, /\/api\/connections\/slack\/login\/step$/, 1800);
  await page.locator(".conn-sheet .slk-ws__row", { hasText: "Beta" }).click();
  await sleep(250);
  await pass.shot("workspace-connecting");
  await unslow3();
  const connected = await page
    .waitForSelector(".conn-sheet .conn-livepill", { timeout: 60_000 })
    .then(() => page.waitForFunction(() => /연결됨/.test(document.querySelector(".conn-sheet .conn-livepill")?.textContent ?? ""), null, { timeout: 60_000 }))
    .then(() => true)
    .catch(() => false);
  pass.check("connected: the pill says 연결됨", connected);
  await sleep(2200); // the sheet's success → 완료 morph settles
  await pass.shot("connected");
  const conns = await api("GET", "/api/connections", undefined, user.token);
  const sl = conns.body.connections?.find((c) => c.provider === "slack");
  pass.check("server: slack is connected for this user", sl?.status === "connected", JSON.stringify(sl ?? null).slice(0, 200));
  const creds = await api("GET", "/api/credentials", undefined, user.token);
  const cred = (Array.isArray(creds.body) ? creds.body : creds.body.items ?? []).find((c) => c.service === "slack");
  pass.check("vault: the session is a sealed credential (hint = the workspace, never the token)", !!cred && /beta\.slack\.com/.test(cred.hint ?? "") && !/xox/.test(JSON.stringify(cred)), JSON.stringify(cred ?? null).slice(0, 200));
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
      const user = await signupApi(`qaslk${rand()}`);
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, colorScheme: variant === "dark" ? "dark" : "light", locale: "ko-KR", timezoneId: "Asia/Seoul" });
      await context.addInitScript((t) => localStorage.setItem("pickle.token", t), user.token);
      const page = await context.newPage();
      const pass = new Pass(engine, variant, page);
      page.on("console", (m) => {
        if (m.type() === "error") pass.errors.push(m.text());
      });
      page.on("pageerror", (e) => pass.errors.push(`pageerror: ${e.message}`));
      await page.goto(BASE + "/");
      await page.waitForSelector("#tab-profile", { timeout: 20_000 });
      await sleep(1000);
      try {
        await walk(pass, user);
      } catch (e) {
        pass.check("walk: ran to the end", false, e.message.split("\n")[0]);
        await page.screenshot({ path: path.join(outDir, `slack-${pass.tag}-error.png`) }).catch(() => {});
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
const needles = [FAKE.code, FAKE.pw2fa, FAKE.totp, FAKE.pwKim, "ZZZZZZ", "111111", "xoxc-", "xoxd-", "FAKEsecretcookie", ...FAKE.emails];
const leaks = needles.filter((n) => out.includes(n));
const relaySteps = (out.match(/slack_login/g) || []).length;
results.serverLog = { lines: out.split("\n").length, relaySteps, leaks };
console.log(`\nserver log: ${relaySteps} relay step lines · secrets found: ${leaks.length ? leaks.join(", ") : "none"}`);
if (leaks.length || relaySteps === 0) failed++;
fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(results, null, 2));
console.log(`results → ${path.relative(repo, path.join(outDir, "results.json"))} · ${failed ? `${failed} problem(s)` : "all clean"}`);
process.exit(failed ? 1 : 0);
