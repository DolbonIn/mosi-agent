// 실행 취소 toast QA (schedules A, messenger-login): a low-risk action's 5 s undo sits at the BOTTOM, above the composer
// and tab bar, never over the top bar's menu and title (MOTION-SPEC §8.13). No LLM and no real account: the spec starts
// its OWN server (apps/server/src/index.ts, a throwaway data dir, tunnel/bot/STT/Twilio off, the listener checked to be
// the pid it started) and its own vite preview (PICKLE_API = that server; the served index.html must be its build).
// The main thread's message list gets one assistant message with a schedule card, created "now", through a route mock,
// so the chat offers its undo exactly as after a live turn; DELETE /api/schedules/<that id> is mocked too.
//   From the repo root:  node apps/mobile/qa/undo-toast.spec.mjs
// Env: QA_UNDO_PORT (server, default 8873) · QA_PORT (preview, default 5293) · QA_AUDIO_PORT (default 8874)
//      QA_ENGINES (chromium,webkit) · QA_VARIANTS (light,dark,reduced) · QA_BUILD=0 (reuse the build) · QA_OUT
// 390×844 @3x in installed Google Chrome (channel "chrome") and Playwright WebKit. Never runs `playwright install`.
// Asserts, per engine × light / dark / reduced:
//  A  below the top bar (menu circle and title), above the composer and tab bar; the top bar stays visible and its menu
//     is still the element under its own centre; 실행 취소 ≥ 44×44; it rises (reduced: it doesn't); it follows the
//     composer when that grows; left alone it expires after ≈ 5 s and keeps the schedule
//  B  the pointer on it holds it past 5 s, also after a press on its body; it goes once the pointer leaves
//  C  swipe down dismisses it and keeps the schedule
//  D  a double tap on 실행 취소: one DELETE, no request from the card underneath, the next banner (예약을 취소했어요)
//     stays up, the card says so, the top bar comes back after that banner
//  E  in the gallery (no composer): an undo queued behind an island banner stays up after that banner's leave; it
//     sits just above the tab bar; an open sheet covers it
//  and 0 console errors, 0 horizontal overflow.
// Note: Playwright WebKit screenshots never draw backdrop-filter (not even on a bare test page), so in the webkit-*
// shots the card behind the toast shows through its tint. That is the capture, not the toast; Chrome shows the blur.
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
const outDir = process.env.QA_OUT || path.join(repo, "docs/qa/undo-toast");
fs.mkdirSync(outDir, { recursive: true });
const API_PORT = Number(process.env.QA_UNDO_PORT || 8873);
const PORT = Number(process.env.QA_PORT || 5293);
const AUDIO_PORT = Number(process.env.QA_AUDIO_PORT || 8874);
const LIVE = [8787, 5173, 8781, 8782, 8789, 8794, 8795, 8810];
for (const p of [API_PORT, PORT, AUDIO_PORT]) if (LIVE.includes(p)) throw new Error(`${p} belongs to the live preview or another team: never use it`);
const API = `http://127.0.0.1:${API_PORT}`;
const BASE = `http://127.0.0.1:${PORT}`;
const DIST = path.join(os.tmpdir(), `pickle-undo-toast-qa-dist-${PORT}`);
const ENGINES = (process.env.QA_ENGINES || "chromium,webkit").split(",");
const VARIANTS = (process.env.QA_VARIANTS || "light,dark,reduced").split(",");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = () => crypto.randomBytes(3).toString("hex");
const SCHEDULE = { type: "schedule", scheduleId: "sch_qa_undo", title: "아침 브리핑", when: "매일 오전 8:00", enabled: true };

async function up(url, needle) {
  try {
    const r = await fetch(url);
    return r.ok && (!needle || (await r.text()).includes(needle));
  } catch {
    return false;
  }
}
const listener = (port) => spawnSync("lsof", ["-t", "-nP", `-iTCP:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" }).stdout.trim().split("\n")[0] || "";

// ── own server + preview (pids we started; only those are stopped) ──

const serverOut = [];
async function startServer() {
  if (listener(API_PORT) || (await up(`${API}/api/health`))) throw new Error(`port ${API_PORT} is taken; set QA_UNDO_PORT`);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pickle-undo-toast-data-"));
  const env = { ...process.env, PORT: String(API_PORT), PICKLE_DATA_DIR: dataDir, PICKLE_AUDIO_TUNNEL: "0", PICKLE_AUDIO_PORT: String(AUDIO_PORT), MEET_BOT_URL: "off", STT_URL: "off", TWILIO_ACCOUNT_SID: "", TWILIO_AUTH_TOKEN: "", TWILIO_FROM: "", KSKILL_ANALYTICS_DISABLED: "1" };
  const proc = spawn("bun", ["apps/server/src/index.ts"], { cwd: repo, stdio: ["ignore", "pipe", "pipe"], env });
  proc.stdout.on("data", (d) => serverOut.push(String(d)));
  proc.stderr.on("data", (d) => serverOut.push(String(d)));
  for (let i = 0; i < 120; i++) {
    if (proc.exitCode !== null) break;
    const pid = listener(API_PORT);
    if (pid) {
      if (pid !== String(proc.pid)) {
        proc.kill("SIGTERM");
        throw new Error(`port ${API_PORT} answers from pid ${pid}, not ours (${proc.pid}); set QA_UNDO_PORT`);
      }
      if (await up(`${API}/api/health`)) return proc;
    }
    await sleep(150);
  }
  proc.kill("SIGTERM");
  throw new Error(`QA server did not start:\n${serverOut.join("").slice(-2000)}`);
}

async function startPreview() {
  if (process.env.QA_BUILD !== "0" || !fs.existsSync(path.join(DIST, "index.html"))) {
    const b = spawnSync("bunx", ["vite", "build", "--outDir", DIST, "--emptyOutDir"], { cwd: appDir, stdio: "pipe", encoding: "utf8" });
    if (b.status !== 0) throw new Error(`build failed:\n${b.stdout}\n${b.stderr}`);
  }
  if (listener(PORT) || (await up(`${BASE}/`))) throw new Error(`port ${PORT} is taken; set QA_PORT`);
  const proc = spawn("bunx", ["vite", "preview", "--outDir", DIST, "--port", String(PORT), "--strictPort", "--host", "127.0.0.1"], { cwd: appDir, stdio: "ignore", env: { ...process.env, PICKLE_API: API } });
  const want = fs.readFileSync(path.join(DIST, "index.html"), "utf8");
  for (let i = 0; i < 100; i++) {
    if (proc.exitCode !== null) break;
    if (await up(`${BASE}/`, "<title>")) {
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

async function signupApi(handle) {
  const kp = await crypto.webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const jwk = await crypto.webcrypto.subtle.exportKey("jwk", kp.publicKey);
  const r = await api("POST", "/api/auth/signup", { handle, password: "qa-pass-1234", displayName: "하늘", agentName: "모시", device: { id: `qa-${rand()}`, label: "QA", signingKey: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y } } });
  if (r.status !== 201 && r.status !== 200) throw new Error(`signup: ${r.status} ${JSON.stringify(r.body)}`);
  // no daily briefing turn on this throwaway account (it would add its own banner)
  await api("PATCH", "/api/settings", { notifications: { briefing: false } }, r.body.token);
  return { token: r.body.token, threadId: r.body.session?.mainThreadId };
}

async function overflow(page) {
  return page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    return { doc: document.documentElement.scrollWidth - vw };
  });
}

class Pass {
  constructor(engine, variant, page) {
    this.engine = engine;
    this.variant = variant;
    this.page = page;
    this.tag = `${engine}-${variant}`;
    this.checks = [];
    this.errors = [];
    this.overflows = [];
    this.shots = [];
    this.n = 0;
  }
  check(name, ok, detail) {
    this.checks.push({ name, ok: !!ok, detail: detail === undefined ? undefined : typeof detail === "string" ? detail : JSON.stringify(detail) });
    console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${detail === undefined ? "" : ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
  }
  async shot(name) {
    const file = `${this.tag}-${String(++this.n).padStart(2, "0")}-${name}.png`;
    await this.page.screenshot({ path: path.join(outDir, file) });
    this.shots.push(file);
    const o = await overflow(this.page);
    if (o.doc > 0) this.overflows.push({ file, ...o });
  }
}

const box = (page, sel) => page.locator(sel).first().boundingBox();

const UNDO = (page) => page.getByRole("button", { name: "실행 취소", exact: true });
/** DELETEs of the schedule answered by the in-page stub (it counts per page load, so phases read it right after) */
const deletes = (page) => page.evaluate(() => window.__qaDeletes ?? 0);

async function walk(pass) {
  const { page } = pass;
  const toast = page.locator(".toast");
  const appear = async () => {
    await toast.waitFor({ state: "visible", timeout: 15_000 });
    return Date.now();
  };
  const fresh = async () => {
    await page.reload();
    return appear();
  };
  const leaves = (ms) => toast.waitFor({ state: "detached", timeout: ms }).then(() => true).catch(() => false);
  /** a point on its body: the icon side, away from 실행 취소 */
  const onBody = async () => {
    const b = await toast.boundingBox();
    return { x: b.x + 40, y: b.y + b.height / 2 };
  };

  // A. where it is, what it says, how it arrives; it follows the composer; it expires on its own
  const tA = await appear();
  const firstY = (await toast.boundingBox())?.y ?? 0; // still rising, sampled right after it appears
  await sleep(700); // settled
  const t = await toast.boundingBox();
  const title = (await page.locator(".toast .banner-title").textContent()) || "";
  pass.check("it names what was done: 아침 브리핑을 예약했어요 · 매일 오전 8:00", title === "아침 브리핑을 예약했어요" && /매일 오전 8:00/.test((await page.locator(".toast .banner-body").textContent()) || ""), title);
  pass.check(pass.variant === "reduced" ? "reduced motion: no rise (it appears in place)" : "it rises into place (16 → 0 px on snap)", pass.variant === "reduced" ? Math.abs(firstY - (t?.y ?? 0)) < 1 : firstY - (t?.y ?? 0) > 1, { firstY, y: t?.y });
  const menu = await box(page, ".tb-circle");
  const center = await box(page, ".tb-center");
  const composer = await box(page, ".composer-wrap");
  const tabbar = await box(page, ".tabbar");
  const topBottom = Math.max(menu ? menu.y + menu.height : 0, center ? center.y + center.height : 0);
  pass.check("below the top bar: the menu circle and the title stay clear", !!t && !!menu && t.y >= topBottom, { toastTop: t?.y, topBarBottom: topBottom });
  const floor = Math.min(composer?.y ?? Infinity, tabbar?.y ?? Infinity);
  pass.check("above the composer and the tab bar", !!t && Number.isFinite(floor) && t.y + t.height <= floor - 4, { toastBottom: t && t.y + t.height, composerTop: composer?.y, tabbarTop: tabbar?.y });
  const hit = await page.evaluate(() => {
    const m = document.querySelector(".tb-circle");
    if (!m) return "no menu";
    const r = m.getBoundingClientRect();
    const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return !!el && (el === m || m.contains(el)) ? true : `at its centre: ${el?.tagName}.${String(el?.className).slice(0, 60)}`;
  });
  pass.check("the menu stays tappable while the toast is up (it is the element under its own centre)", hit === true, hit);
  const bar = await page.evaluate(() => getComputedStyle(document.querySelector(".topbar")).opacity);
  pass.check("the top bar stays visible (it steps back only for a banner from the island)", bar === "1", bar);
  const action = await box(page, ".toast .banner-action");
  pass.check("실행 취소 is a ≥ 44×44 target", !!action && action.height >= 44 && action.width >= 44, action);
  await pass.shot("undo-toast");
  const field = page.locator("textarea.composer-field");
  await field.fill("첫째 줄\n둘째 줄\n셋째 줄\n넷째 줄");
  await sleep(700);
  const grown = await box(page, ".composer-wrap");
  const tg = await toast.boundingBox();
  pass.check("it follows the composer when that grows (4 lines): still clear of it", !!grown && !!composer && !!tg && grown.y < composer.y - 10 && tg.y + tg.height <= grown.y - 4, { composerTop: grown?.y, was: composer?.y, toastBottom: tg && tg.y + tg.height });
  await pass.shot("composer-grown");
  await field.fill("");
  await field.blur();
  const expired = await leaves(9000);
  const lived = Date.now() - tA;
  pass.check("left alone, it expires after ≈ 5 s and keeps the schedule", expired && lived > 4500 && lived < 7500 && await deletes(page) === 0, { lived, deletes: await deletes(page) });

  // B. the pointer on it holds it, and a press on its body doesn't end that hold
  await fresh();
  let p = await onBody();
  await page.mouse.move(p.x, p.y);
  await sleep(1500);
  await page.mouse.down();
  await page.mouse.up();
  await sleep(5500);
  pass.check("held while the pointer rests on it, also after a press on its body (7 s)", await toast.isVisible());
  await page.mouse.move(195, 300);
  pass.check("…and it goes once the pointer leaves, keeping the schedule", (await leaves(8000)) && await deletes(page) === 0, { deletes: await deletes(page) });

  // C. swipe down dismisses it
  await fresh();
  await sleep(400);
  p = await onBody();
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  await page.mouse.move(p.x, p.y + 20, { steps: 4 });
  await page.mouse.move(p.x, p.y + 70, { steps: 6 });
  await page.mouse.up();
  pass.check("swipe down dismisses it and keeps the schedule", (await leaves(2500)) && await deletes(page) === 0, { deletes: await deletes(page) });
  await page.mouse.move(195, 300);

  // D. 실행 취소, tapped twice quickly: one DELETE, nothing underneath gets the second tap, the next banner stays
  await fresh();
  await sleep(400);
  await UNDO(page).dblclick();
  await sleep(1200);
  pass.check("a double tap on 실행 취소 deletes the schedule once", await deletes(page) === 1, { deletes: await deletes(page) });
  pass.check("the second tap doesn't reach the card under the toast (no other schedule request)", pass.api.other === 0, { other: pass.api.other });
  const next = page.locator(".banner-title", { hasText: "예약을 취소했어요" });
  pass.check("the next banner (예약을 취소했어요) stays up, not cleared by the toast's leave", await next.isVisible());
  pass.check("the card says the schedule was cancelled", await page.waitForSelector(".ccard-sched.is-removed", { timeout: 8000 }).then(() => true).catch(() => false));
  await pass.shot("undone");
  const back = await page.waitForFunction(() => !document.querySelector(".topbar.under-banner") && getComputedStyle(document.querySelector(".topbar")).opacity === "1", null, { timeout: 8000 }).then(() => true).catch(() => false);
  pass.check("the top bar comes back after that banner", back);

  // E. the gallery (no composer): an undo queued behind an island banner survives that banner's late leave; it sits
  //    just above the tab bar; an open sheet covers it and keeps its taps
  await page.goto(BASE + "/?gallery=1");
  await page.getByRole("button", { name: "배너", exact: true }).click();
  await page.getByRole("button", { name: "실행 취소 배너" }).click();
  await toast.waitFor({ state: "visible", timeout: 10_000 });
  await sleep(1000);
  pass.check("an undo queued behind a banner stays up after that banner's leave (1 s after it appears)", await toast.isVisible());
  const tb = await box(page, ".tabbar");
  const tt = await toast.boundingBox();
  pass.check("no composer: it sits just above the tab bar", !!tb && !!tt && tt.y + tt.height <= tb.y - 4 && tt.y + tt.height >= tb.y - 40, { toastBottom: tt && tt.y + tt.height, tabbarTop: tb?.y });
  const open = page.getByRole("button", { name: "시트 열기" });
  await open.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await open.focus();
  await page.keyboard.press("Enter");
  await sleep(700);
  const covered = await page.evaluate(() => {
    const el0 = document.querySelector(".toast");
    if (!el0) return "the toast is gone";
    const r = el0.getBoundingClientRect();
    const el = document.elementFromPoint(r.left + 40, r.top + r.height / 2);
    return !!el && !el0.contains(el) && !!el.closest(".sheet-root") ? true : `at the toast: ${el?.tagName}.${String(el?.className).slice(0, 60)}`;
  });
  pass.check("an open sheet covers the toast (a tap there goes to the sheet)", covered === true, covered);
  await pass.shot("under-sheet");
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
      const user = await signupApi(`qaundo${rand()}`);
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, colorScheme: variant === "dark" ? "dark" : "light", reducedMotion: variant === "reduced" ? "reduce" : "no-preference", locale: "ko-KR", timezoneId: "Asia/Seoul" });
      await context.addInitScript((t) => localStorage.setItem("pickle.token", t), user.token);
      // the main thread's history gains one assistant message whose schedule card was created just now
      await context.route(new RegExp(`/api/threads/${user.threadId}/messages(\\?.*)?$`), async (route) => {
        if (route.request().method() !== "GET") return route.continue();
        const res = await route.fetch();
        const list = await res.json().catch(() => []);
        const msg = { id: "m_qa_undo", threadId: user.threadId, role: "assistant", text: "매일 오전 8시에 아침 브리핑을 보내 드릴게요.", cards: [SCHEDULE], tools: [], attachments: [], createdAt: Date.now() };
        await route.fulfill({ response: res, json: [...(Array.isArray(list) ? list : []), msg] });
      });
      // DELETE of that schedule answers inside the page, at once: the "예약을 취소했어요" banner then arrives while the
      // toast is still leaving (< 120 ms), the order in which a late leave used to clear the next banner. Any other
      // request to the schedule (the card's switch under the toast) goes out and is counted by the route.
      await context.addInitScript((sid) => {
        const real = window.fetch.bind(window);
        window.__qaDeletes = 0;
        window.fetch = (input, init) => {
          const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
          const method = (init?.method || (typeof input === "object" && "method" in input ? input.method : "GET")).toUpperCase();
          if (method === "DELETE" && url.endsWith(`/api/schedules/${sid}`)) {
            window.__qaDeletes++;
            return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } }));
          }
          return real(input, init);
        };
      }, SCHEDULE.scheduleId);
      const calls = { other: 0 };
      await context.route(new RegExp(`/api/schedules/${SCHEDULE.scheduleId}$`), (route) => {
        calls.other++;
        return route.continue();
      });
      const page = await context.newPage();
      const pass = new Pass(engine, variant, page);
      pass.api = calls;
      page.on("console", (m) => {
        if (m.type() === "error") pass.errors.push(m.text());
      });
      page.on("pageerror", (e) => pass.errors.push(`pageerror: ${e.message}`));
      await page.goto(BASE + "/");
      try {
        await walk(pass);
      } catch (e) {
        pass.check("ran to the end", false, e.message.split("\n")[0]);
        await page.screenshot({ path: path.join(outDir, `${pass.tag}-error.png`) }).catch(() => {});
      }
      const r = { engine, variant, checks: pass.checks, failed: pass.checks.filter((c) => !c.ok).map((c) => c.name), consoleErrors: pass.errors, overflow: pass.overflows, screenshots: pass.shots };
      results.passes.push(r);
      failed += r.failed.length + r.consoleErrors.length + r.overflow.length;
      console.log(`  checks ${r.checks.length - r.failed.length}/${r.checks.length} · console errors ${r.consoleErrors.length} · overflow ${r.overflow.length} · shots ${r.screenshots.length}`);
      for (const e of r.consoleErrors) console.log(`    console: ${e.slice(0, 200)}`);
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
fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(results, null, 2));
console.log(`\nresults → ${path.relative(repo, path.join(outDir, "results.json"))} · ${failed ? `${failed} problem(s)` : "all clean"}`);
process.exit(failed ? 1 : 0);
