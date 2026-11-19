// k-skill accounts QA (kakao-chat): "모시가 쓰는 서비스" + the folded "키로 연결" on the connections screen, their connect
// sheets, and the chat's connection_request card. Fully synthetic — its own server (apps/mobile/qa/skill-accounts-server.ts:
// the real app server plus synthetic "korea" providers whose POST /api/connections/:id OPENS each sealed credential with
// the real enclave, and a stand-in turn that posts the card), its own throwaway data dir and account, bogus values only.
// Never touches :8787 / :5173 / :8789.
//   node apps/mobile/qa/skill-accounts.spec.mjs
// Env: QA_ENGINES=chromium,webkit · QA_VARIANTS=light,dark · QA_API_PORT (8916) · QA_PORT (5306) · QA_BUILD=0 ·
//      QA_REAL=1 (the app serves the real routes: no stand-in, no seeding)
// Browsers: installed Chrome (channel "chrome") + Playwright's cached WebKit. Never runs `playwright install`.
// Shots: docs/qa/skill-accounts/<engine>-<variant>-<step>.png, applied-<state>-<variant>.jpg (390×844 @2x, q82, Chrome)
import { chromium, webkit } from "playwright";
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkLines, describe } from "./lib/lines.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, "..");
const repo = path.resolve(appDir, "../..");
const outDir = path.join(repo, "docs/qa/skill-accounts");
fs.mkdirSync(outDir, { recursive: true });
const API_PORT = Number(process.env.QA_API_PORT || 8916);
const AUDIO_PORT = Number(process.env.QA_AUDIO_PORT || API_PORT + 2);
const PORT = Number(process.env.QA_PORT || 5306);
const TAKEN = [8787, 5173, 8781, 8782, 8789, 8794, 8795, 8810];
if ([API_PORT, PORT, AUDIO_PORT].some((p) => TAKEN.includes(p))) throw new Error(`${API_PORT}/${PORT}/${AUDIO_PORT}: one of those ports belongs to someone else`);
const API = `http://127.0.0.1:${API_PORT}`;
const BASE = `http://127.0.0.1:${PORT}`;
const DIST = path.join(os.tmpdir(), `pickle-skill-qa-dist-${PORT}`);
const ENGINES = (process.env.QA_ENGINES || "chromium,webkit").split(",");
const VARIANTS = (process.env.QA_VARIANTS || "light,dark").split(",");
const REAL = process.env.QA_REAL === "1";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const own = [];

// bogus values only — none of these is a real key
const BOGUS = { client_id: "qa-client-0001", client_secret: "qa-secret-not-a-real-key", access: "qa-access-0001", card_secret: "qa-card-secret-0002", riss: "zq-riss-not-a-real-key" };

async function up(url) {
  try {
    return (await fetch(url)).ok;
  } catch {
    return false;
  }
}
function startGroup(cmd, args, opts) {
  const proc = spawn(cmd, args, { ...opts, detached: true });
  proc.stopAll = () => {
    try {
      process.kill(-proc.pid, "SIGTERM");
    } catch {
      /* gone */
    }
  };
  own.push(proc);
  return proc;
}

async function startServer() {
  if (await up(`${API}/api/health`)) throw new Error(`port ${API_PORT} is already serving something; set QA_API_PORT`);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pickle-skillqa-"));
  const log = fs.openSync(path.join(dataDir, "server.log"), "w");
  startGroup("bun", ["run", "apps/mobile/qa/skill-accounts-server.ts"], {
    cwd: repo,
    stdio: ["ignore", log, log],
    env: { ...process.env, PICKLE_DATA_DIR: dataDir, PORT: String(API_PORT), PICKLE_AUDIO_PORT: String(AUDIO_PORT), QA_REAL: REAL ? "1" : "0", PICKLE_AUDIO_TUNNEL: "0", MEET_BOT_URL: "off", STT_URL: "off", TWILIO_ACCOUNT_SID: "", TWILIO_AUTH_TOKEN: "", TWILIO_FROM: "" },
  });
  for (let i = 0; i < 120; i++) {
    if (await up(`${API}/api/health`)) return dataDir;
    await sleep(150);
  }
  throw new Error("skill QA server did not start: " + fs.readFileSync(path.join(dataDir, "server.log"), "utf8").slice(-800));
}

async function startPreview() {
  if (process.env.QA_BUILD !== "0" || !fs.existsSync(path.join(DIST, "index.html"))) {
    const b = spawnSync("bunx", ["vite", "build", "-c", "qa/vite.qa.config.mjs", "--outDir", DIST, "--emptyOutDir"], { cwd: appDir, stdio: "pipe", encoding: "utf8" });
    if (b.status !== 0) throw new Error(`build failed:\n${b.stdout}\n${b.stderr}`);
  }
  if (await up(`${BASE}/`)) throw new Error(`port ${PORT} is already serving something; set QA_PORT`);
  startGroup("bunx", ["vite", "preview", "--outDir", DIST, "--port", String(PORT), "--strictPort", "--host", "127.0.0.1"], { cwd: appDir, stdio: "ignore", env: { ...process.env, PICKLE_API: API } });
  for (let i = 0; i < 100; i++) {
    if (await up(`${BASE}/`)) {
      const served = await (await fetch(`${BASE}/`)).text();
      if (served !== fs.readFileSync(path.join(DIST, "index.html"), "utf8")) throw new Error(`port ${PORT} is serving a different build`);
      return;
    }
    await sleep(150);
  }
  throw new Error("vite preview did not start");
}

async function api(method, p, body, token) {
  const res = await fetch(API + p, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const type = res.headers.get("content-type") || "";
  return { status: res.status, body: type.includes("json") ? await res.json() : await res.text() };
}

/** the statuses of this account's stored connection_request cards of `service`, from the server (every thread) */
async function storedCards(token, service) {
  const out = [];
  const threads = (await api("GET", "/api/threads", undefined, token)).body;
  for (const t of Array.isArray(threads) ? threads : []) {
    const msgs = (await api("GET", `/api/threads/${t.id}/messages`, undefined, token)).body;
    for (const m of Array.isArray(msgs) ? msgs : []) for (const c of m.cards ?? []) if (c.type === "connection_request" && c.service === service) out.push(c.status);
  }
  return out;
}

/**
 * In the page: for each element matching `sel`, how its sentences sit on lines. A line of two or more sentences must be
 * cut into one .t-s per sentence (ui/Text Sentences), and a sentence that starts on the line where the one before ends must end there too
 * (a "…해요. 주문은 / 넣지 않아요." break fails).
 */
function sentenceBreaks(sel) {
  const linesOf = (node) => {
    const r = document.createRange();
    r.selectNodeContents(node);
    const tops = [];
    for (const rect of r.getClientRects()) if (rect.width > 0 && !tops.some((t) => Math.abs(t - rect.top) < 3)) tops.push(rect.top);
    return tops.sort((a, b) => a - b);
  };
  return [...document.querySelectorAll(sel)].map((el) => {
    const text = (el.textContent ?? "").trim();
    const sentences = text.split(/(?<=[.!?])\s+/).filter(Boolean).length;
    const spans = [...el.querySelectorAll(".t-s")];
    const lines = spans.map(linesOf);
    const shared = lines.some((l, i) => i > 0 && l.length > 1 && Math.abs(l[0] - lines[i - 1][lines[i - 1].length - 1]) < 3);
    const ok = sentences < 2 || (spans.length === sentences && !shared);
    return { text: text.slice(0, 24), sentences, spans: spans.length, lines: lines.map((l) => l.length), ok };
  });
}

/**
 * In the page: each matching element's text as laid out, line by line — per character (Korean may break inside a word) —
 * and the lines whose last glyph runs past the element's own box (a nowrap tie wider than the column)
 */
function laidOutLines(sel) {
  return [...document.querySelectorAll(sel)].map((el) => {
    const lines = [];
    const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let node = walk.nextNode(); node; node = walk.nextNode()) {
      const text = node.textContent ?? "";
      for (let i = 0; i < text.length; i++) {
        const rg = document.createRange();
        rg.setStart(node, i);
        rg.setEnd(node, i + 1);
        const rect = rg.getClientRects()[0];
        if (!rect) continue;
        let line = lines.find((l) => Math.abs(l.top - rect.top) < 3);
        if (!line) lines.push((line = { top: rect.top, text: "", right: -Infinity }));
        line.text += text[i];
        if (text[i].trim()) line.right = Math.max(line.right, rect.right);
      }
    }
    lines.sort((a, b) => a.top - b.top);
    const box = el.getBoundingClientRect().right;
    return {
      id: el.closest("[data-skill]")?.getAttribute("data-skill") ?? null,
      lines: lines.map((l) => l.text.trim()).filter(Boolean),
      over: lines.filter((l) => l.right > box + 0.5).map((l) => ({ line: l.text.trim(), by: Math.round(l.right - box) })),
    };
  });
}

/** a throwaway account; with the stand-in, one key connected and one expired so the list shows every state */
async function account() {
  const kp = await crypto.webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const jwk = await crypto.webcrypto.subtle.exportKey("jwk", kp.publicKey);
  const handle = `qa${crypto.randomBytes(4).toString("hex")}`;
  const su = await api("POST", "/api/auth/signup", { handle, password: "qa-pass-1234", displayName: "하늘", agentName: "모시", device: { id: `qa-${handle}`, label: "QA", signingKey: jwk } });
  if (su.status !== 201 && su.status !== 200) throw new Error(`signup ${su.status}`);
  const token = su.body.token;
  // a fresh account inside the briefing window (07:30–09:30 KST) would get a briefing turn within 30 s, and the
  // stand-in turn would post a card into the chat under test: off from the start
  const off = await api("PATCH", "/api/settings", { notifications: { briefing: false } }, token);
  if (off.status !== 200) throw new Error(`briefing off: ${off.status}`);
  if (!REAL) {
    await api("POST", "/qa/skill/seed", { service: "naver-searchad", status: "connected", accountLabel: "01***" }, token);
    await api("POST", "/qa/skill/seed", { service: "popbill", status: "error", accountLabel: "li***", lastError: "저장한 키가 만료됐어요. 다시 입력해 주세요." }, token);
  }
  return token;
}

/** WCAG contrast of an element's text against the first opaque background up its ancestors */
async function contrastOf(locator) {
  return locator.evaluate((el) => {
    const parse = (c) => {
      const m = c.match(/rgba?\(([^)]+)\)/);
      if (!m) return null;
      const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
      return { r: p[0], g: p[1], b: p[2], a: p[3] ?? 1 };
    };
    const lum = ({ r, g, b }) => {
      const f = (v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const layers = [];
    for (let n = el; n; n = n.parentElement) {
      const bg = parse(getComputedStyle(n).backgroundColor);
      if (bg && bg.a > 0) {
        layers.push(bg);
        if (bg.a >= 1) break;
      }
    }
    let base = { r: 255, g: 255, b: 255 };
    if (document.documentElement.dataset.theme === "dark" || matchMedia("(prefers-color-scheme: dark)").matches) base = { r: 0, g: 0, b: 0 };
    for (const l of layers.reverse()) base = { r: l.r * l.a + base.r * (1 - l.a), g: l.g * l.a + base.g * (1 - l.a), b: l.b * l.a + base.b * (1 - l.a) };
    const fg0 = parse(getComputedStyle(el).color);
    let op = 1;
    for (let n = el; n; n = n.parentElement) op *= Number(getComputedStyle(n).opacity);
    const a = fg0.a * op;
    const fg = { r: fg0.r * a + base.r * (1 - a), g: fg0.g * a + base.g * (1 - a), b: fg0.b * a + base.b * (1 - a) };
    const [L1, L2] = [lum(fg), lum(base)].sort((x, y) => y - x);
    return Math.round(((L1 + 0.05) / (L2 + 0.05)) * 100) / 100;
  });
}

const results = { real: REAL, passes: [] };

async function runPass(engine, variant) {
  const browserType = engine === "chromium" ? chromium : webkit;
  const browser = await browserType.launch(engine === "chromium" ? { channel: "chrome", args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] } : {});
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: engine === "chromium",
    hasTouch: true,
    colorScheme: variant === "dark" ? "dark" : "light",
    locale: "ko-KR",
    timezoneId: "Asia/Seoul",
  });
  const token = await account();
  await context.addInitScript((tk) => localStorage.setItem("pickle.token", tk), token);
  const page = await context.newPage();
  const pass = { engine, variant, checks: [], errors: [], shots: [] };
  const check = (name, ok, detail = "") => pass.checks.push({ name, ok: !!ok, detail: String(detail).slice(0, 400) });
  // the shared line checker (qa/lib/lines.mjs, every rule) over the rows, cards and sheets this spec opens
  const lineRuns = [];
  const linesAt = async (where, opts) => {
    const r = await checkLines(page, opts);
    lineRuns.push({ where, scanned: r.scanned, units: r.units });
  };
  page.on("console", (m) => m.type() === "error" && pass.errors.push(m.text().slice(0, 200)));
  page.on("pageerror", (e) => pass.errors.push(`pageerror: ${e.message.slice(0, 200)}`));
  const posts = [];
  const deletes = [];
  page.on("request", (r) => {
    if (!/\/api\/connections\/[^/]+$/.test(new URL(r.url()).pathname)) return;
    if (r.method() === "POST") posts.push({ url: r.url(), body: r.postData() ?? "" });
    if (r.method() === "DELETE") deletes.push(r.url());
  });
  const shot = async (step, target) => {
    const file = path.join(outDir, `${engine}-${variant}-${step}.png`);
    if (target) await target.screenshot({ path: file, animations: "disabled" });
    else await page.screenshot({ path: file });
    pass.shots.push(path.relative(repo, file));
  };
  const applied = async (state) => {
    if (engine !== "chromium") return;
    const file = path.join(outDir, `applied-${state}-${variant}.jpg`);
    await page.screenshot({ path: file, type: "jpeg", quality: 82 });
    pass.shots.push(path.relative(repo, file));
  };
  const sheet = page.locator(".sheet-panel.sk-sheet");
  const settle = () => sleep(700);
  const closeSheet = async () => {
    await page.keyboard.press("Escape");
    await sheet.waitFor({ state: "detached", timeout: 5000 }).catch(() => {});
    await sleep(250);
  };
  const scrollTo = (sel, block = "start") =>
    page.evaluate(([s, b]) => document.querySelector(s)?.scrollIntoView({ block: b }), [sel, block]);

  async function openConnections(ready = ".sk-row-toss-investment") {
    await page.goto(BASE, { waitUntil: "networkidle" });
    await page.waitForSelector("#tab-profile", { timeout: 20_000 });
    await page.click("#tab-profile");
    const conns = page.locator(".screen-scroll .profile-conns").first();
    await conns.waitFor({ timeout: 10_000 });
    await conns.evaluate((el) => el.scrollIntoView({ block: "center" }));
    await sleep(300);
    await conns.click();
    await page.waitForSelector(ready, { timeout: 15_000 });
    await settle();
  }

  // before messenger-login's wiring lands, GET /api/connections lists no k-skill service: the group and the keys fold
  // stay out and the messenger screen is untouched (no stand-ins for this step)
  async function bareFlow() {
    await api("POST", "/qa/skill/bare", { on: true }, token);
    await openConnections(".conn-row-kakaotalk");
    const real = await api("GET", "/api/connections", undefined, token);
    const listsKorea = (real.body.providers ?? []).some((p) => p.category === "korea" || p.auth === "api_key");
    const bareUi = await page.evaluate(() => ({ group: document.querySelectorAll(".sk-group, .sk-keys, .sk-row").length, msgr: document.querySelectorAll(".conn-row").length, kor: [...document.querySelectorAll(".list-section-title")].some((t) => /국내 서비스/.test(t.textContent ?? "")) }));
    check(
      listsKorea ? "server lists k-skill services itself: no 국내 서비스 messenger group" : "server without k-skill wiring: no 모시가 쓰는 서비스 group, no 키로 연결, messenger rows as before",
      listsKorea ? !bareUi.kor : bareUi.group === 0 && bareUi.msgr > 0 && !bareUi.kor,
      JSON.stringify({ listsKorea, ...bareUi }),
    );
    await api("POST", "/qa/skill/bare", { on: false }, token);
  }

  // the folded "키로 연결" group: drawn only once the server lists a key service (none does today), so the stand-in adds
  // the four keys for this account (one it can't connect right now) and the screen loads again
  async function keysFlow() {
    await api("POST", "/qa/skill/extras", { on: true }, token);
    await openConnections();
    const toggle = page.locator(".sk-keys-toggle");
    check("키로 연결 starts folded (aria-expanded=false, no key rows)", (await toggle.getAttribute("aria-expanded")) === "false" && (await page.locator(".sk-keys .sk-row").count()) === 0 && /키로 연결/.test(await toggle.innerText()));
    await toggle.click();
    await sleep(500);
    const keyIds = await page.locator(".sk-keys .sk-row").evaluateAll((rows) => rows.map((r) => [...r.classList].find((c) => c.startsWith("sk-row-"))?.slice(7)));
    const keysFooter = await page.locator(".sk-keys .list-footer").innerText().catch(() => "");
    check("키로 연결 opens with the four keys and its one line", (await toggle.getAttribute("aria-expanded")) === "true" && keyIds.join(",") === "building-register-search,korean-patent-search,lck-analytics,government-bond-analysis" && /개발자 키/.test(keysFooter), `${keyIds.join(",")} · ${keysFooter}`);
    const soon = page.locator(".sk-row.is-soon");
    const soonInfo = await soon.evaluateAll((rows) => rows.map((r) => ({ id: [...r.classList].find((c) => c.startsWith("sk-row-"))?.slice(7), tag: r.tagName, chev: !!r.querySelector(".list-row-chevron"), detail: r.querySelector(".list-row-detail")?.textContent?.trim() })));
    if (!REAL) {
      check("a service the server can't connect now: not a button, no chevron, says the server's reason", soonInfo.length === 1 && soonInfo.every((s) => s.id === "government-bond-analysis" && s.tag !== "BUTTON" && !s.chev && s.detail === "점검 중이에요"), JSON.stringify(soonInfo));
      const soonContrast = await contrastOf(soon.first().locator(".list-row-detail"));
      const soonTitle = await contrastOf(soon.first().locator(".list-row-title"));
      check("that row stays readable (detail ≥ 4.5:1, title ≥ 4.5:1)", soonContrast >= 4.5 && soonTitle >= 4.5, `${soonContrast} / ${soonTitle}`);
    }
    await scrollTo(".sk-keys", "end");
    await sleep(300);
    await shot("keys-open");
    await applied("keys-open");
    // LCK: no console to link to — the row is words, not a link
    await page.locator(".sk-row-lck-analytics").click();
    await sheet.waitFor({ timeout: 5000 });
    await settle();
    check("LCK: the 언제 필요한가요 row is words only (no link)", (await sheet.locator("a.sk-issue").count()) === 0 && /공개 키가 막혔을 때만/.test(await sheet.locator(".sk-issue").innerText()));
    await closeSheet();
    await page.locator(".sk-row-korean-patent-search").click();
    await sheet.waitFor({ timeout: 5000 });
    await settle();
    const kipris = await sheet.locator("a.sk-issue").getAttribute("href");
    check("특허 검색: 발급처 links to KIPRIS Plus", kipris === "https://plus.kipris.or.kr", kipris);
    await shot("sheet-key");
    await closeSheet();
    await toggle.click();
    await sleep(400);
    check("키로 연결 folds back", (await toggle.getAttribute("aria-expanded")) === "false" && (await page.locator(".sk-keys .sk-row").count()) === 0);

  }

  // 나의 모시 › 모시 설정 › 할 수 있는 일: a skill that runs with a k-skill login shows 연결하기 (or 다시 연결) before its
  // switch instead of 키 필요, live from the connections list; it opens the same sheet over that screen
  async function skillsFlow() {
    await page.goto(BASE, { waitUntil: "networkidle" });
    await page.waitForSelector("#tab-profile", { timeout: 20_000 });
    await page.click("#tab-profile");
    const row = page.locator(".screen-scroll .profile-agent").first();
    await row.waitFor({ timeout: 10_000 });
    await row.evaluate((el) => el.scrollIntoView({ block: "center" }));
    await sleep(300);
    await row.click();
    const shown = await page.waitForSelector(".agent-skill", { timeout: 15_000 }).then(() => true).catch(() => false);
    if (!shown) return check("skills screen: rows load", false, "no .agent-skill");
    await page.waitForFunction(() => document.querySelectorAll(".agent-skill .sk-connect").length > 0, null, { timeout: 10_000 }).catch(() => {});
    await sleep(400);
    const rows = await page.evaluate(() =>
      [...document.querySelectorAll(".agent-skill")].map((r) => ({
        id: r.getAttribute("data-skill"),
        btn: r.querySelector(".sk-connect .btn")?.textContent?.trim() ?? null,
        h: Math.round(r.querySelector(".sk-connect .btn")?.getBoundingClientRect().height ?? 0),
        keyPill: [...r.querySelectorAll(".more-pill")].some((p) => /키 필요/.test(p.textContent ?? "")),
        label: r.querySelector(".sk-connect .btn")?.getAttribute("aria-label") ?? null,
        // under the line, in the row's one column: after .agent-skill__desc, text-left on the line's left, no fill; the switch alone at the end
        under: (() => {
          const b = r.querySelector(".sk-connect .btn");
          const d = r.querySelector(".agent-skill__desc");
          if (!b || !d) return null;
          const bt = b.querySelector(".btn-label") ?? b;
          const range = document.createRange();
          range.selectNodeContents(bt);
          const tx = range.getBoundingClientRect();
          const dr = d.getBoundingClientRect();
          return {
            inMain: b.closest(".agent-skill__main") != null && d.compareDocumentPosition(b) === Node.DOCUMENT_POSITION_FOLLOWING,
            below: tx.top >= dr.bottom - 1,
            left: Math.round(tx.left - dr.left),
            fill: getComputedStyle(b).backgroundColor,
            endKids: r.querySelector(".agent-skill__end")?.children.length ?? -1,
          };
        })(),
      })),
    );
    const withBtn = rows.filter((r) => r.btn);
    if (REAL) return check("skills screen: rows with a login carry 연결하기", withBtn.every((r) => r.h >= 44 && !r.keyPill), JSON.stringify(withBtn));
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    // the list at this point: 네이버 검색광고 and RISS connected, 팝빌 expired, 토스증권 revoked, 쿠팡 waiting on a re-check
    const toss = byId["toss_portfolio"] ?? rows.find((r) => /toss/.test(r.id ?? "") && r.btn);
    const pop = rows.find((r) => /popbill/.test(r.id ?? "") && r.btn);
    const naverOrRiss = rows.filter((r) => /naver|riss/.test(r.id ?? ""));
    check(
      "skills screen: 연결하기 (토스증권) and 다시 연결 (팝빌) on their rows, none on connected logins, never 키 필요 on them; ≥ 44 px",
      !!toss && toss.btn === "연결하기" && !!pop && pop.btn === "다시 연결" && naverOrRiss.length > 0 && naverOrRiss.every((r) => !r.btn && !r.keyPill) && withBtn.every((r) => r.h >= 44 && !r.keyPill),
      JSON.stringify({ toss, pop, naverOrRiss: naverOrRiss.map((r) => r.id), n: withBtn.length }),
    );
    check("skills screen: the button names its service", /토스증권 연결하기/.test(toss?.label ?? ""), toss?.label);
    check(
      "skills screen: 연결하기 is accent text under the line (left-aligned with it, no fill); the switch stays alone at the end",
      withBtn.length > 0 && withBtn.every((r) => r.under && r.under.inMain && r.under.below && Math.abs(r.under.left) <= 2 && /rgba\(0, 0, 0, 0\)|transparent/.test(r.under.fill) && r.under.endKids === 1),
      JSON.stringify(withBtn.map((r) => ({ id: r.id, ...r.under }))),
    );
    const descAt390 = await page.evaluate(laidOutLines, ".agent-skill__desc");
    const lone = withBtn.map((r) => descAt390.find((d) => d.id === r.id)).filter((d) => d && d.lines.length > 1 && !/\s/.test(d.lines[d.lines.length - 1]));
    check(
      "skills screen: a row with 연결하기 never ends its description on a one-word line (text-wrap: pretty)",
      withBtn.length > 0 && lone.length === 0,
      JSON.stringify(lone.length ? lone : withBtn.map((r) => descAt390.find((d) => d.id === r.id)?.lines)),
    );
    // every skill's line, 320 → 430 wide: no line ends on "(", none starts with ")", "·" or "." (ui/Text ties)
    const tight = [];
    const past = [];
    const split = [];
    let twoSentence = 0;
    let measured = 0;
    for (const w of [320, 360, 390, 430]) {
      await page.setViewportSize({ width: w, height: 844 });
      await sleep(350);
      const all = await page.evaluate(laidOutLines, ".agent-skill__desc");
      measured = Math.max(measured, all.length);
      const sb = await page.evaluate(sentenceBreaks, ".agent-skill__desc");
      twoSentence = Math.max(twoSentence, sb.filter((l) => l.sentences > 1).length);
      for (const l of sb) if (!l.ok) split.push({ w, ...l });
      for (const d of all) for (const l of d.lines) if (/\($/.test(l) || /^[)·.]/.test(l)) tight.push({ w, id: d.id, line: l });
      for (const d of all) for (const o of d.over) past.push({ w, id: d.id, ...o });
      await linesAt(`skills ${w}`, { scope: ".agent-skill" });
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await sleep(300);
    check("skills screen: no skill line ends on \"(\" or starts with \")\", \"·\" or \".\" — at 320 / 360 / 390 / 430", measured >= 10 && tight.length === 0, JSON.stringify({ measured, tight: tight.slice(0, 6) }));
    check("skills screen: a two-sentence skill line breaks only between its sentences — 320 → 430", measured >= 10 && twoSentence >= 2 && split.length === 0, JSON.stringify({ twoSentence, split: split.slice(0, 6) }));
    check("skills screen: every line's last glyph stays inside its description's box (no tie runs under the switch) — 320 → 430", measured >= 10 && past.length === 0, JSON.stringify(past.slice(0, 6)));
    // from the keyboard (WebKit doesn't focus a clicked button, so focus return is a keyboard matter)
    await page.locator(`.agent-skill[data-skill="${toss.id}"] .sk-connect .btn`).focus();
    await page.keyboard.press("Enter");
    await sheet.waitFor({ timeout: 5000 });
    await settle();
    const over = await sheet.evaluate((el) => ({ title: el.querySelector(".sheet-title")?.textContent?.trim(), inputs: el.querySelectorAll(".sk-form input").length, under: !!document.querySelector(".agent-skills") }));
    check("skills screen: 연결하기 opens the 토스증권 sheet over the skills screen", over.title === "토스증권" && over.inputs === 2 && over.under, JSON.stringify(over));
    await page.mouse.move(1, 1); // AdaptivePointer lights the last mouse spot: park it in the corner
    await shot("skills-sheet");
    await closeSheet();
    const back = await page.evaluate(() => document.activeElement?.closest(".sk-connect") != null);
    check("skills screen: opened from the keyboard, closing the sheet puts focus back on its 연결하기", back, back);
    await page.locator(`.agent-skill[data-skill="${toss.id}"]`).evaluate((el) => el.scrollIntoView({ block: "center" }));
    await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur()); // resting state for the shot
    await sleep(300);
    await page.mouse.move(1, 1); // AdaptivePointer lights the last mouse spot: park it in the corner
    await shot("skills-list");
    await applied("skills-list");
  }

  // the island's "완료했어요" after a turn is not the state under test: wait it back to idle before a shot
  const islandIdle = async () => {
    await page.waitForFunction(() => (document.querySelector(".island-anchor")?.getAttribute("data-kind") ?? "idle") === "idle", null, { timeout: 10_000 }).catch(() => {});
    await sleep(500);
  };

  // the sheet's status pill sits whole inside the scrolling body (the body clips what pokes above its top)
  const pillInside = async (name) => {
    const r = await page.evaluate(() => {
      const pill = document.querySelector(".sk-sheet .sk-live .more-pill") ?? document.querySelector(".sk-sheet .sk-live");
      const body = pill?.closest(".sheet-body");
      if (!pill || !body) return null;
      const a = pill.getBoundingClientRect();
      const b = body.getBoundingClientRect();
      return { top: Math.round(a.top - b.top), bottom: Math.round(b.bottom - a.bottom) };
    });
    check(`${name}: the status pill sits whole inside the sheet body (not clipped under the head)`, !!r && r.top >= 0 && r.bottom >= 0, JSON.stringify(r));
  };

  async function cardFlow() {
    // the login the tool just refused is still listed as connected: the server keeps the card pending, and so must the
    // card (it renders from its own status). Fresh load, so the card itself fetches that list.
    await api("POST", "/qa/skill/seed", { service: "toss-investment", status: "connected", accountLabel: "qa***" }, token);
    // whoever loads the list first after this fresh load (the app at boot, or the card): that's what the card sees
    const listed = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/connections" && r.request().method() === "GET", { timeout: 30_000 }).then((r) => r.json()).catch(() => null);
    await page.goto(BASE, { waitUntil: "networkidle" });
    await page.waitForSelector("#tab-chat", { timeout: 20_000 });
    await page.click("#tab-chat");
    const box = page.getByRole("textbox", { name: "메시지" });
    await box.waitFor({ timeout: 10_000 });
    await box.click();
    await box.fill("내 토스증권 보유 종목 보여 줘");
    await page.keyboard.press("Enter");
    const card = page.locator(".sk-req").last();
    const shown = await card.waitFor({ timeout: 15_000 }).then(() => true).catch(() => false);
    if (!shown) {
      check("card: this build renders connection_request (CardView hook)", false, "no .sk-req — CardView hunk not in this build");
      return;
    }
    const list = await listed;
    await sleep(300);
    const tossListed = list?.connections?.find((c) => c.provider === "toss-investment")?.status;
    const r0 = await card.evaluate((el) => ({ title: el.querySelector(".ccard-title")?.textContent?.trim(), btn: el.querySelector(".btn")?.textContent?.trim(), pill: el.querySelector(".more-pill")?.textContent?.trim() ?? null }));
    check("card: still pending with 연결하기 while the list says 토스증권 is connected (a refused login)", tossListed === "connected" && r0.title === "토스증권 연결이 필요해요" && r0.btn === "연결하기" && r0.pill === null, JSON.stringify({ tossListed, ...r0 }));
    const cards0 = await page.locator(".sk-req").count();
    await page.locator(".msg-asst .asst-text").last().waitFor({ timeout: 10_000 }).catch(() => {});
    await sleep(700);
    await card.scrollIntoViewIfNeeded();
    const c0 = await card.evaluate((el) => ({ title: el.querySelector(".ccard-title")?.textContent?.trim(), why: el.querySelector(".sk-req__why")?.textContent?.trim(), btn: el.querySelector(".btn")?.textContent?.trim(), inputs: el.querySelectorAll("input").length, plates: el.querySelectorAll(".list-row-plate, .more-sheet-row__icon, img").length }));
    check(
      "card: title, the sheet's scope line (not the server's reason again), 연결하기 — and no field in the chat",
      c0.title === "토스증권 연결이 필요해요" && c0.why === "계좌와 보유 종목, 시세를 조회만 해요. 주문은 넣지 않아요." && c0.btn === "연결하기" && c0.inputs === 0 && c0.plates === 0,
      JSON.stringify(c0),
    );
    const bb = await card.locator(".btn").boundingBox();
    check("card: 연결하기 ≥ 44 px", bb && bb.height >= 44, bb?.height);
    await page.mouse.move(1, 1); // AdaptivePointer lights the last mouse spot: park it in the corner
    await islandIdle();
    await shot("card-pending");
    await applied("card-pending");
    await card.locator(".btn").click();
    await sheet.waitFor({ timeout: 5000 });
    await settle();
    const over = await page.evaluate(() => ({ chatTab: document.querySelector("#tab-chat")?.getAttribute("aria-selected"), cardAttached: !!document.querySelector(".sk-req"), composer: !!document.querySelector('[aria-label="메시지"]') }));
    check("card: the sheet opens over the thread (no navigation: the waiting turn's stream stays)", over.chatTab === "true" && over.cardAttached && over.composer, JSON.stringify(over));
    const reform = await sheet.evaluate((el) => ({ live: el.querySelector(".sk-live")?.textContent?.trim(), inputs: el.querySelectorAll(".sk-form input").length, manage: !!document.querySelector(".sk-disconnect__note") }));
    check("card: its sheet opens on the fields (다시 연결), not the connected view", reform.live === "다시 연결" && reform.inputs === 2 && !reform.manage, JSON.stringify(reform));
    await page.getByLabel("Client ID").fill(BOGUS.client_id);
    await page.getByLabel("Client Secret").fill(BOGUS.card_secret);
    await shot("card-sheet");
    await page.getByRole("button", { name: "연결하기" }).last().click();
    await page.waitForFunction(() => document.querySelector(".sk-live")?.textContent?.includes("연결됨"), null, { timeout: 10_000 }).catch(() => {});
    const post = posts.filter((p) => p.url.endsWith("/toss-investment")).pop();
    check("card: sent sealed from the chat too", !!post && /"envelope"/.test(post.body) && !post.body.includes(BOGUS.card_secret), post ? `${post.body.length} bytes` : "no POST");
    await sleep(1400);
    await page.getByRole("button", { name: "완료" }).click();
    await sheet.waitFor({ state: "detached", timeout: 5000 }).catch(() => {});
    await sleep(500);
    // the server flips this same stored card (a message event, kskill.ts markConnectionCardsConnected); no turn was
    // waiting, so it offers 이어서 하기. No second card is posted, and the card never flips itself from the list.
    await page.waitForFunction(() => [...document.querySelectorAll(".sk-req .ccard-title")].some((t) => t.textContent?.includes("연결됐어요")), null, { timeout: 15_000 }).catch(() => {});
    await sleep(500);
    const c1 = await card.evaluate((el) => ({ title: el.querySelector(".ccard-title")?.textContent?.trim(), btn: el.querySelectorAll(".btn").length, pill: el.querySelector(".more-pill")?.textContent?.trim() ?? null, next: el.querySelector(".brief-row .list-row-title")?.textContent?.trim(), h: Math.round(el.querySelector(".brief-row")?.getBoundingClientRect().height ?? 0) }));
    const cards1 = await page.locator(".sk-req").count();
    check(
      "card (connected): the same card flips in place to 토스증권 연결됐어요 — no chip, no button, 이어서 하기 ≥ 44 px; no second card",
      c1.title === "토스증권 연결됐어요" && c1.btn === 0 && c1.pill === null && c1.next === "이어서 하기" && c1.h >= 44 && cards1 === cards0,
      JSON.stringify({ ...c1, cards0, cards1 }),
    );
    const stored = await storedCards(token, "toss-investment");
    check("card (connected): the stored card is what flipped (the server's message event, not the screen)", stored.join(",") === "connected", stored.join(","));
    await card.scrollIntoViewIfNeeded();
    await page.mouse.move(1, 1); // AdaptivePointer lights the last mouse spot: park it in the corner
    await islandIdle();
    await shot("card-connected");
    await applied("card-connected");
    const before = await page.locator(".msg-me").count();
    const asstBefore = await page.locator(".msg-asst").count();
    await card.locator(".brief-row").click();
    await sleep(800);
    const sentRow = await card.evaluate((el) => el.querySelector(".brief-row")?.classList.contains("is-sent") ?? false);
    const after = await page.locator(".msg-me").count();
    check("card (connected): 이어서 하기 sends the server's words once", sentRow && after === before + 1, `${sentRow} · ${before}→${after}`);
    await page.waitForFunction((n) => document.querySelectorAll(".msg-asst").length > n, asstBefore, { timeout: 10_000 }).catch(() => {});

    // ── a scope line breaks only between its sentences: one pending card per catalogued service, 320 → 430 wide ──
    const n0 = await page.locator(".sk-req").count();
    await box.click();
    await box.fill("문장 확인");
    await page.keyboard.press("Enter");
    await page.waitForFunction((n) => document.querySelectorAll(".sk-req").length >= n + 10, n0, { timeout: 15_000 }).catch(() => {});
    await sleep(500);
    const widths = [];
    for (const w of [320, 360, 390, 430]) {
      await page.setViewportSize({ width: w, height: 844 });
      await sleep(350);
      widths.push({ w, lines: await page.evaluate(sentenceBreaks, ".sk-req__why") });
      await linesAt(`cards ${w}`, { scope: ".sk-req" });
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await sleep(300);
    // a chat card never takes a key: its fields (and their placeholders) live only in the sheet, where the placeholder
    // check measures them. A field here would need that check too.
    const fieldsInCards = await page.evaluate(() => {
      const cards = [...document.querySelectorAll(".sk-req")];
      return { cards: cards.length, fields: cards.flatMap((c) => [...c.querySelectorAll("input, textarea, select, [contenteditable]:not([contenteditable=false])")].map((f) => `${c.querySelector(".ccard-title")?.textContent?.trim()}: ${f.tagName.toLowerCase()}`)) };
    });
    check("card: no connection card in the chat has a field (every service's card: keys go in the sheet only)", fieldsInCards.cards >= 10 && fieldsInCards.fields.length === 0, JSON.stringify(fieldsInCards));
    const lineBad = widths.flatMap(({ w, lines }) => lines.filter((l) => !l.ok).map((l) => ({ w, ...l })));
    const multi = widths[0].lines.filter((l) => l.sentences > 1).length;
    check(
      "card: every scope line breaks only between sentences (no sentence starts on the line before and wraps), at 320 / 360 / 390 / 430",
      widths.every(({ lines }) => lines.length >= 10) && multi >= 5 && lineBad.length === 0,
      JSON.stringify({ n: widths.map(({ w, lines }) => `${w}:${lines.length}`), multi, bad: lineBad.slice(0, 4) }),
    );
  }

  try {
    if (!REAL) await bareFlow();
    await openConnections();

    // ── the list ──
    const group = page.locator(".sk-group");
    const title = (await group.locator(".list-section-title").innerText()).trim();
    check("group title is 모시가 쓰는 서비스", title === "모시가 쓰는 서비스", title);
    const ids = await group.locator(".sk-row").evaluateAll((rows) => rows.map((r) => [...r.classList].find((c) => c.startsWith("sk-row-"))?.slice(7)));
    if (!REAL) {
      check("the five offered services, linked first (연결됨 / 다시 연결), then 연결 전", ids.join(",") === "naver-searchad,popbill,toss-investment,coupang-partners,riss", ids.join(","));
      const hidden = await page.locator(".sk-row-heyyumi, .sk-row-bunjang-search, .sk-row-saramin-talent-search, .sk-row-jobkorea-talent-search, .sk-row-korean-jangbu-for, .sk-row-foresttrip-vacancy").count();
      check("키로 연결 stays out while the server lists no key service (the four keys have no tool yet)", (await page.locator(".sk-keys").count()) === 0);
      check("never listed: 번개장터 · 사람인 · 잡코리아 · CODEF · 숲나들e, and 헤이유미 while the server hasn't enabled it", hidden === 0, hidden);
    }
    const leaked = await page.locator(".conn-row-toss-investment, .conn-row-popbill, .conn-row-heyyumi").count();
    const korSection = await page.locator(".list-section-title", { hasText: "국내 서비스" }).count();
    check("k-skill services are never messenger rows (no conn-row, no 국내 서비스 group)", leaked === 0 && korSection === 0, `${leaked} rows · ${korSection} sections`);
    const subtitle = await page.locator(".conn-title .large-title-sub").first().textContent({ timeout: 500 }).catch(() => null);
    if (subtitle !== null) check("title's one sentence covers services too (no sealing line there)", /대화를 읽고/.test(subtitle) && /서비스/.test(subtitle) && !/암호화/.test(subtitle), subtitle);
    check("no logos, plates or tiles on any k-skill row", (await page.locator(".sk-row .list-row-plate, .sk-row .list-row-lead, .sk-row img, .sk-row svg.brand").count()) === 0);
    const pills = await group.locator(".sk-row .more-pill").allInnerTexts();
    if (!REAL) check("states: one 연결됨, one 다시 연결 pill; 연결 전 rows carry no pill", pills.map((p) => p.trim()).sort().join(",") === "다시 연결,연결됨", pills.join(","));
    const subContrast = await contrastOf(group.locator(".sk-row-toss-investment .list-row-sub"));
    check("row subtitle ≥ 4.5:1", subContrast >= 4.5, subContrast);
    const heights = await page.locator(".sk-row, .sk-keys-toggle").evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().height)));
    check("every row ≥ 44 px", heights.every((h) => h >= 44), heights.join(","));
    const aria = await group.locator(".sk-row-toss-investment").getAttribute("aria-label");
    check("row name reads 이름, 상태, 설명", aria === "토스증권, 연결 전, 계좌 · 보유 종목 조회", aria);
    // the group's title just under the top bar
    await page.evaluate(() => {
      const g = document.querySelector(".sk-group");
      const sc = g?.closest(".screen-scroll");
      if (g && sc) sc.scrollTop += g.getBoundingClientRect().top - 112;
    });
    await page.mouse.move(1, 1); // AdaptivePointer lights the last mouse spot: park it in the corner
    await sleep(400);
    await shot("list");
    await applied("list");
    await scrollTo(".sk-group", "end");
    await sleep(300);
    await shot("list-end");
    for (const w of [320, 360, 390, 430]) {
      await page.setViewportSize({ width: w, height: 844 });
      await sleep(350);
      await linesAt(`rows ${w}`, { scope: ".sk-group" });
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await sleep(300);

    // RISS: keys go to universities and non-profit institutions only — the sheet's first line, before anyone tries; a
    // key-only service gets no masked hint (never the key's first characters)
    await page.locator(".sk-row-riss").click();
    await sheet.waitFor({ timeout: 5000 });
    await settle();
    const riss = await sheet.evaluate((el) => ({
      first: el.querySelector(".more-sheet > :not(.sk-sheet-status)")?.textContent?.trim(),
      how: el.querySelector(".sk-sheet-status .sk-sheet-hint")?.textContent?.trim(),
      href: el.querySelector("a.sk-issue")?.getAttribute("href"),
      issue: el.querySelector("a.sk-issue")?.textContent,
      fields: el.querySelectorAll(".sk-form input").length,
    }));
    check("RISS: first line says only universities and non-profits get the key; API 키로 연결; 발급 row links to the RISS API centre (said once)", /대학과 비영리 기관에만 발급돼요/.test(riss.first ?? "") && riss.how === "API 키로 연결" && riss.href === "https://www.riss.kr/apicenter/apiMain.do" && !/대학/.test(riss.issue ?? "") && riss.fields === 1, JSON.stringify(riss));
    const rissLines = await page.evaluate(sentenceBreaks, ".sk-sheet .more-note > span, .sk-sheet .more-sheet-lead, .sk-sheet .tf-hint");
    await linesAt("sheet RISS 390", { scope: ".sheet-panel.sk-sheet" });
    check("RISS sheet: the notice, the scope line and the sealing line under the key break only between sentences", rissLines.length >= 3 && rissLines.every((l) => l.ok) && rissLines.filter((l) => l.sentences > 1).length >= 3, JSON.stringify(rissLines));
    await page.mouse.move(1, 1); // AdaptivePointer lights the last mouse spot: park it in the corner
    await shot("sheet-riss");
    await applied("sheet-riss");
    await pillInside("sheet-riss");
    await page.getByLabel("RISS 검색 API 키").fill(BOGUS.riss);
    await page.getByRole("button", { name: "연결하기" }).last().click();
    await page.waitForFunction(() => document.querySelector(".sk-live")?.textContent?.includes("연결됨"), null, { timeout: 10_000 }).catch(() => {});
    const rissPost = posts.filter((p) => p.url.endsWith("/riss")).pop();
    const rissCred = rissPost ? JSON.parse(rissPost.body).credential : null;
    check("RISS: sealed, and the list hint is empty (label is just RISS)", !!rissCred && rissCred.hint === "" && rissCred.label === "RISS" && !rissPost.body.includes(BOGUS.riss) && !rissPost.body.includes(BOGUS.riss.slice(0, 2) + "***"), rissCred ? JSON.stringify({ hint: rissCred.hint, label: rissCred.label }) : "no POST");
    await sleep(600);
    await page.getByRole("button", { name: "완료" }).click();
    await sheet.waitFor({ state: "detached", timeout: 5000 }).catch(() => {});
    await sleep(400);

    // ── connect: 토스증권 ──
    await scrollTo(".sk-group");
    await page.locator(".sk-row-toss-investment").click();
    await sheet.waitFor({ timeout: 5000 });
    await settle();
    const form = await sheet.evaluate((el) => ({
      title: el.querySelector(".sheet-title")?.textContent?.trim(),
      titleAlign: getComputedStyle(el.querySelector(".sheet-title")).textAlign,
      live: el.querySelector(".sk-live")?.textContent?.trim(),
      lead: el.querySelector(".more-sheet-lead")?.textContent?.trim(),
      fields: [...el.querySelectorAll(".sk-form input")].map((i) => ({
        label: document.querySelector(`label[for="${i.id}"]`)?.textContent?.trim() ?? i.labels?.[0]?.textContent?.trim() ?? "",
        labelVisible: !!(i.labels?.[0] && i.labels[0].getBoundingClientRect().height > 0),
        type: i.type,
        ac: i.getAttribute("autocomplete"),
      })),
      lockUnder: [...el.querySelectorAll(".sk-form .tf-hint")].map((h) => h.textContent.replace(/\u00a0/g, " ")).join(" | "), // copy()'s nbsp ties
      plates: el.querySelectorAll(".more-plate, .list-row-plate, .ccard-plate").length,
      issue: el.querySelector("a.sk-issue") && { href: el.querySelector("a.sk-issue").getAttribute("href"), target: el.querySelector("a.sk-issue").getAttribute("target"), rel: el.querySelector("a.sk-issue").getAttribute("rel"), h: Math.round(el.querySelector("a.sk-issue").getBoundingClientRect().height), text: el.querySelector("a.sk-issue").textContent },
      foldValue: el.querySelector(".sk-fold__value")?.textContent?.trim(),
    }));
    check("sheet: start-aligned title 토스증권, live state 연결 전", form.title === "토스증권" && form.titleAlign === "left" && form.live === "연결 전", `${form.title} · ${form.titleAlign} · ${form.live}`);
    check("sheet: one plain line says what 모시 does and that it only reads", /조회만/.test(form.lead ?? "") && /주문은 넣지 않아요/.test(form.lead ?? ""), form.lead);
    check(
      "sheet: visible labels; secrets masked; autocomplete off on every field",
      form.fields.length === 2 && form.fields.every((f) => f.label && f.labelVisible && f.ac === "off") && form.fields[1].type === "password" && form.fields[0].type === "text",
      JSON.stringify(form.fields),
    );
    check("sheet: the sealing sentence sits under the secret", /이 기기에서 암호화한 뒤에만 보내요/.test(form.lockUnder), form.lockUnder);
    check("sheet: 어디서 발급하나요 → official console, new tab, noopener, ≥ 44 px", form.issue?.href === "https://www.tossinvest.com" && form.issue.target === "_blank" && /noopener/.test(form.issue.rel) && form.issue.h >= 44 && /어디서 발급하나요/.test(form.issue.text), JSON.stringify(form.issue));
    check("sheet: keep-for summary row says 30일", form.foldValue === "30일", form.foldValue);
    const btn = page.locator(".sheet-footer .btn, .sheet-panel.sk-sheet ~ * .btn").filter({ hasText: "연결하기" }).first();
    const connectBtn = (await btn.count()) ? btn : page.getByRole("button", { name: "연결하기" });
    check("연결하기 waits for the required fields", await connectBtn.isDisabled());
    const cb = await connectBtn.boundingBox();
    check("연결하기 ≥ 44 px", cb && cb.height >= 44, cb?.height);
    await page.mouse.move(1, 1); // AdaptivePointer lights the last mouse spot: park it in the corner
    await shot("sheet-form");
    await applied("sheet-form");
    await pillInside("sheet-form");
    // 320 → 430 wide: no sentence in the sheet ends on a one-word line, and every placeholder fits its field — every listed
    // service's placeholders (each sheet's fields span the same column), measured in this field's font against its room
    const listed = (await api("GET", "/api/connections", undefined, token)).body.providers ?? [];
    const allHolders = listed.filter((p) => p.category === "korea").flatMap((p) => (p.fields ?? []).filter((f) => f.placeholder).map((f) => ({ service: p.id, key: f.key, placeholder: f.placeholder })));
    const loneEnds = [];
    const cutHolders = [];
    let partsSeen = 0;
    let holdersSeen = 0;
    let holdersAt320 = [];
    await page.mouse.move(1, 1); // a narrower viewport would put the last mouse spot (and its pointer light) over 연결하기
    for (const w of [320, 360, 390, 430]) {
      await page.setViewportSize({ width: w, height: w === 320 ? 568 : 844 });
      await sleep(350);
      await linesAt(`sheet 토스증권 ${w}`, { scope: ".sheet-panel.sk-sheet" });
      const parts = await page.evaluate(laidOutLines, ".sk-sheet .t-s, .sk-sheet .more-sheet-lead:not(:has(.t-s)), .sk-sheet .tf-hint:not(:has(.t-s)), .sk-sheet .more-note > span:not(:has(.t-s))");
      partsSeen = Math.max(partsSeen, parts.length);
      for (const p of parts) if (p.lines.length > 1 && !/\s/.test(p.lines[p.lines.length - 1])) loneEnds.push({ w, lines: p.lines });
      const holders = await page.evaluate((all) => {
        const ctx = document.createElement("canvas").getContext("2d");
        const i = document.querySelector(".sk-sheet .sk-form input[type=text]");
        if (!i) return [];
        const cs = getComputedStyle(i);
        ctx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
        // offsetWidth (layout px, like the canvas; a rect would read a sheet still scaling in), not clientWidth: Chrome
        // reports an <input>'s clientWidth without its padding (228 for a 242 px box)
        const room = i.offsetWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - parseFloat(cs.borderLeftWidth) - parseFloat(cs.borderRightWidth);
        const body = i.closest(".sheet-body");
        const box = i.closest(".tf-box")?.offsetWidth ?? 0;
        const bar = body ? body.offsetWidth - body.clientWidth : 0; // a classic scrollbar (desktop Chrome) narrows the column
        return all.map((h) => ({ ...h, text: Math.round(ctx.measureText(h.placeholder).width * 10) / 10, room: Math.round(room * 10) / 10, box, bar }));
      }, allHolders);
      holdersSeen = Math.max(holdersSeen, holders.length);
      for (const h of holders) if (h.text > h.room) cutHolders.push({ w, ...h });
      if (w === 320) holdersAt320 = [`room ${holders[0]?.room} (box ${holders[0]?.box}, bar ${holders[0]?.bar})`, ...holders.map((h) => `${h.service}.${h.key} ${h.text}`)];
      // after the viewport change the tab bar's droplet lens (app/useDropletLens.ts) draws over 연결하기 for ~1 s in Chrome,
      // through the open sheet: html[data-overlay] makes it visibility:hidden, yet its SVG filter (feImage) still paints.
      // That is an app bug, with mobile-foundation (2026-11-16). This wait does not hide or settle it: it only keeps this
      // picture about the sheet's line breaks; the bug still shows in a picture taken right after a resize.
      if (w === 320) {
        await sleep(1200);
        await shot("sheet-form-320");
      }
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await sleep(350);
    check("sheet (토스증권): no sentence ends on a one-word line — 320 → 430 (the hint's .t-copy and each .t-s wrap pretty)", partsSeen >= 4 && loneEnds.length === 0, JSON.stringify({ partsSeen, loneEnds: loneEnds.slice(0, 4) }));
    check("sheets: every k-skill service's placeholder fits its field — 320 → 430", holdersSeen >= 6 && cutHolders.length === 0, JSON.stringify(cutHolders.length ? { holdersSeen, cut: cutHolders.slice(0, 6) } : { holdersSeen, at320: holdersAt320 }));
    await page.getByLabel("Client ID").fill(BOGUS.client_id);
    await page.getByLabel("Client Secret").fill(BOGUS.client_secret);
    check("연결하기 is ready once both fields are filled", !(await connectBtn.isDisabled()));
    await connectBtn.click();
    await page.waitForFunction(() => document.querySelector(".sk-live")?.textContent?.includes("연결됨"), null, { timeout: 10_000 }).catch(() => {});
    await sleep(900);
    const post = posts.find((p) => p.url.endsWith("/toss-investment"));
    check("sent sealed: the request carries an envelope and none of the typed values", !!post && /"envelope"/.test(post.body) && !post.body.includes(BOGUS.client_secret) && !post.body.includes(BOGUS.client_id), post ? `${post.body.length} bytes` : "no POST");
    const tossKind = post ? JSON.parse(post.body).credential?.kind : null;
    const tossLive = await sheet.locator(".sk-live").textContent().catch(() => "");
    // the server opens the envelope with aad `${userId}:toss-investment:token`: a "login" seal would not open (400)
    check("sealed as kind token (auth api_key) and the server accepted it", tossKind === "token" && /연결됨/.test(tossLive ?? ""), `${tossKind} · ${tossLive}`);
    const done = await sheet.evaluate((el) => ({ live: el.querySelector(".sk-live")?.textContent?.trim(), chips: [...el.querySelectorAll(".sk-next .chip")].map((c) => c.textContent.trim()), inputs: el.querySelectorAll("input").length }));
    check("connected: 연결됨, the form is gone, what to ask next", done.live === "연결됨" && done.inputs === 0 && done.chips.length >= 1, JSON.stringify(done));
    await sleep(800);
    await shot("sheet-connected");
    await applied("sheet-connected");
    await pillInside("sheet-connected");
    await page.getByRole("button", { name: "완료" }).click();
    await sheet.waitFor({ state: "detached", timeout: 5000 }).catch(() => {});
    await sleep(400);
    const tossRow = page.locator(".sk-row-toss-investment");
    check("row shows 연결됨 after connecting", /연결됨/.test(await tossRow.innerText()), (await tossRow.innerText()).replace(/\s+/g, " "));

    // ── refused key: 쿠팡 파트너스 ──
    await page.locator(".sk-row-coupang-partners").scrollIntoViewIfNeeded();
    await page.locator(".sk-row-coupang-partners").click();
    await sheet.waitFor({ timeout: 5000 });
    await settle();
    await page.getByLabel("Access Key").fill(BOGUS.access);
    await page.getByLabel("Secret Key").fill("qa-refused");
    await page.getByRole("button", { name: "연결하기" }).click();
    await page.waitForFunction(() => !!document.querySelector(".sk-footer .more-error"), null, { timeout: 10_000 }).catch(() => {});
    await sleep(500);
    const refused = await page.evaluate(() => ({
      err: document.querySelector(".sk-footer .more-error")?.textContent?.trim(),
      live: document.querySelector(".sk-live")?.textContent?.trim(),
      kept: document.querySelector('.sk-form input[name="coupang-partners-accessKey"]')?.value,
      btn: document.querySelector(".sk-footer .btn")?.textContent?.trim(),
    }));
    check("a refused key is said inline in Korean, inputs kept, 다시 연결 / 다시 연결하기", /[가-힣]/.test(refused.err ?? "") && refused.kept === BOGUS.access && refused.live === "다시 연결" && /다시 연결하기/.test(refused.btn ?? ""), JSON.stringify(refused));
    await shot("sheet-refused");
    // the service can't be reached to verify: kept and re-checked later — said as a note, not an error; no second try
    await page.locator('.sk-form input[name="coupang-partners-secretKey"]').fill("qa-unreachable");
    await page.getByRole("button", { name: /다시 연결하기|연결하기/ }).last().click();
    await page.waitForFunction(() => !document.querySelector(".sk-form"), null, { timeout: 10_000 }).catch(() => {});
    await sleep(500);
    const chk = await page.evaluate(() => ({
      live: document.querySelector(".sk-live")?.textContent?.trim(),
      note: document.querySelector(".sheet-panel.sk-sheet .more-note")?.textContent?.trim(),
      err: document.querySelector(".sheet-panel.sk-sheet .more-error")?.textContent?.trim() ?? null,
      inputs: document.querySelectorAll(".sheet-panel.sk-sheet input").length,
      btn: document.querySelector(".sheet-panel.sk-sheet .sheet-footer .btn, .sk-sheet .btn")?.textContent?.trim(),
    }));
    check("unreachable upstream (needs_verification): 연결 중 with the server's note, no error, the form cleared", chk.live === "연결 중" && /잠시 후 다시 확인할게요/.test(chk.note ?? "") && !chk.err && chk.inputs === 0, JSON.stringify(chk));
    await shot("sheet-checking");
    await page.getByRole("button", { name: "다시 입력하기" }).click();
    await sleep(400);
    const back = await page.evaluate(() => document.querySelectorAll(".sheet-panel.sk-sheet .sk-form input").length);
    check("다시 입력하기 brings the fields back", back === 2, back);
    await closeSheet();

    // ── expired key: 팝빌 (seeded) opens the form with the reason ──
    if (!REAL) {
      await page.locator(".sk-row-popbill").click();
      await sheet.waitFor({ timeout: 5000 });
      await settle();
      const re = await sheet.evaluate((el) => ({ live: el.querySelector(".sk-live")?.textContent?.trim(), err: document.querySelector(".sk-footer .more-error")?.textContent?.trim(), fields: el.querySelectorAll(".sk-form input").length, lead: el.querySelector(".more-sheet-lead")?.textContent }));
      check("다시 연결 (팝빌): the form with the reason; the line says it issues only with approval", re.live === "다시 연결" && /만료/.test(re.err ?? "") && re.fields === 5 && /승인하면/.test(re.lead ?? ""), JSON.stringify(re));
      await shot("sheet-reconnect");
      await linesAt("sheet 다시 연결 390", { scope: ".sheet-panel.sk-sheet" });
      const errAt = await page.evaluate(() => {
        const icon = document.querySelector(".sk-footer .more-error svg");
        const lead = document.querySelector(".sk-sheet .more-sheet-lead");
        const walk = lead && document.createTreeWalker(lead, NodeFilter.SHOW_TEXT);
        let leadLeft = null;
        for (let n = walk?.nextNode(); n && leadLeft == null; n = walk.nextNode()) {
          const i = (n.textContent ?? "").search(/\S/);
          if (i < 0) continue;
          const r = document.createRange();
          r.setStart(n, i);
          r.setEnd(n, i + 1);
          leadLeft = r.getBoundingClientRect().left;
        }
        return { icon: icon ? Math.round(icon.getBoundingClientRect().left * 2) / 2 : null, lead: leadLeft == null ? null : Math.round(leadLeft * 2) / 2 };
      });
      check("다시 연결 (팝빌): the error line's icon starts on the body's left line", errAt.icon != null && errAt.lead != null && Math.abs(errAt.icon - errAt.lead) <= 0.5, JSON.stringify(errAt));
      await page.getByLabel("LinkID").fill("qa-link-0001");
      await page.getByLabel("SecretKey").fill("qa-popbill-not-real");
      await page.getByLabel("사업자번호").fill("0000000000");
      check("fields the server marks optional (팝빌 아이디, 환경) can stay empty", !(await page.getByRole("button", { name: /연결하기/ }).isDisabled()));
      const labels = await sheet.evaluate((el) => [...el.querySelectorAll(".sk-form .tf-label")].map((l) => l.textContent?.trim()));
      check("optional fields say so in their label (선택), as the app's other forms do; required ones don't", labels.join(",") === "LinkID,SecretKey,사업자번호,팝빌 아이디 (선택),환경 (선택)", labels.join(","));
      await closeSheet();
    }

    // ── manage + revoke: 토스증권 ──
    await tossRow.scrollIntoViewIfNeeded();
    await tossRow.click();
    await sheet.waitFor({ timeout: 5000 });
    await settle();
    const manage = await sheet.evaluate((el) => ({ live: el.querySelector(".sk-live")?.textContent?.trim(), rows: [...el.querySelectorAll(".more-sheet-row__title")].map((t) => t.textContent.trim()), note: document.querySelector(".sk-disconnect__note")?.textContent?.trim() }));
    check("connected sheet: words only — no icon plates", (await sheet.locator(".more-sheet-row__icon, .list-row-plate").count()) === 0);
    check("connected sheet: the masked key, since when, and what 연결 해제 removes", manage.live === "연결됨" && manage.rows.length === 2 && /\*\*\*/.test(manage.rows[0]) && /키도 함께 지워요/.test(manage.note ?? ""), JSON.stringify(manage));
    await page.mouse.move(1, 1); // AdaptivePointer lights the last mouse spot: park it in the corner
    await shot("sheet-manage");
    await applied("sheet-manage");
    const noteAt = await page.evaluate(() => {
      const firstLeft = (el) => {
        const walk = el && document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        for (let n = walk?.nextNode(); n; n = walk.nextNode()) {
          const i = (n.textContent ?? "").search(/\S/);
          if (i < 0) continue;
          const r = document.createRange();
          r.setStart(n, i);
          r.setEnd(n, i + 1);
          return r.getBoundingClientRect().left;
        }
        return null;
      };
      const lead = firstLeft(document.querySelector(".sk-sheet .more-sheet-lead"));
      const note = firstLeft(document.querySelector(".sk-sheet .sk-disconnect__note"));
      return { lead: lead && Math.round(lead * 2) / 2, note: note && Math.round(note * 2) / 2 };
    });
    check("connected sheet: the 연결 해제 note starts on the lead's left line", noteAt.lead != null && noteAt.note != null && Math.abs(noteAt.lead - noteAt.note) <= 1, JSON.stringify(noteAt));
    const noteLines = await page.evaluate(sentenceBreaks, ".sk-sheet .sk-disconnect__note > span");
    await linesAt("sheet 관리 390", { scope: ".sheet-panel.sk-sheet" });
    check("connected sheet: the 연결 해제 note breaks only between its sentences", noteLines.length === 1 && noteLines[0].ok && noteLines[0].sentences === 2, JSON.stringify(noteLines));
    await pillInside("sheet-manage");
    const off = page.getByRole("button", { name: /연결 해제/ });
    await off.click();
    await sleep(250);
    await page.getByRole("button", { name: /한 번 더|연결 해제/ }).first().click();
    await sheet.waitFor({ state: "detached", timeout: 8000 }).catch(() => {});
    await sleep(500);
    check("연결 해제 (tap twice) revokes on the server and the row is back to 연결 전", deletes.some((u) => u.endsWith("/toss-investment")) && !/연결됨/.test(await tossRow.innerText()), deletes.join(","));
    if (!REAL) {
      const after = await api("GET", "/api/connections", undefined, token);
      check("server: the revoked login is gone", !after.body.connections.some((c) => c.provider === "toss-investment"), JSON.stringify(after.body.connections.map((c) => c.provider)));
    }

    const o = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check("no horizontal overflow", o <= 0, o);

    await skillsFlow();

    // ── the chat's connection_request card (only when the build renders it) ──
    if (!REAL) await cardFlow();
    if (!REAL) await keysFlow();

    const lineBad = lineRuns.flatMap((r) => r.units.filter((u) => u.findings.length).map((u) => `${r.where}: ${describe([u]).join(" ; ")}`));
    const scanned = (re) => lineRuns.filter((r) => re.test(r.where)).reduce((n, r) => n + r.scanned, 0);
    const seen = { rows: scanned(/^rows/), skills: scanned(/^skills/), sheets: scanned(/^sheet/), cards: scanned(/^cards/) };
    check(
      "lines (qa/lib/lines.mjs, every rule): no finding in the account rows, 나의 모시's skills and the chat cards (320 → 430) or the sheets (토스증권 320 → 430; RISS, 다시 연결, 관리 at 390)",
      (REAL || (seen.rows >= 20 && seen.skills >= 200 && seen.sheets >= 20 && seen.cards >= 40)) && lineBad.length === 0,
      JSON.stringify({ seen, bad: lineBad.slice(0, 3) }),
    );
  } catch (e) {
    check("pass ran to the end", false, e.stack?.slice(0, 600) ?? String(e));
    await shot("failure").catch(() => {});
  }
  check("no console errors", pass.errors.length === 0, pass.errors.join(" | "));
  await browser.close();
  results.passes.push(pass);
  const bad = pass.checks.filter((c) => !c.ok);
  console.log(`${engine}/${variant}: ${pass.checks.length - bad.length}/${pass.checks.length}${bad.length ? "\n  FAIL " + bad.map((b) => `${b.name} — ${b.detail}`).join("\n  FAIL ") : ""}`);
}

const cleanup = () => {
  for (const p of own) p.stopAll();
};
process.on("SIGINT", () => {
  cleanup();
  process.exit(130);
});
try {
  await startServer();
  await startPreview();
  for (const engine of ENGINES) for (const variant of VARIANTS) await runPass(engine, variant);
} finally {
  cleanup();
}
const all = results.passes.flatMap((p) => p.checks);
results.summary = { checks: all.length, failed: all.filter((c) => !c.ok).length };
fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(results, null, 2));
console.log(`total ${all.length - results.summary.failed}/${all.length}`);
process.exit(results.summary.failed ? 1 : 0);
