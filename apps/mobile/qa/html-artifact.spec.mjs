// HTML artifacts QA (screens-more): the model's own page drawn inside the reply. From the repo root:
//   PICKLE_DATA_DIR=… PORT=8792 bun --env-file=… run apps/server/src/index.ts       (the server, separately)
//   node apps/mobile/qa/html-artifact.spec.mjs                                    (Chrome + WebKit × light/dark/reduced)
//   QA_ENGINES=chromium QA_VARIANTS=light node apps/mobile/qa/html-artifact.spec.mjs   (one pass)
// Env: QA_API (server, default http://127.0.0.1:8792) · QA_PORT (app, default 5188) · QA_BUILD=0 (reuse the build)
//      QA_ONLY=inline,links,cap,full,long,wheel,theme,security,big,placeholder,archive,llm,deep,rows
//      QA_OUT (default docs/qa/html-artifact) · QA_DIST (build dir, default a temp dir unique to this checkout and port)
//      QA_WIDTH (viewport width, default 390; the rows scenario also visits 320, where the sheet leaves a card 244 px
//      of content, under the 256 a '전부' card's height estimate is made at)
// The app is served the way production serves it: this spec builds it into its own dir and serves that dir itself
// with the SERVER's security headers (read from /api/health, so the real Content-Security-Policy applies: an
// about:srcdoc frame inherits it), proxying /api to the server. vite preview would serve no CSP and prove nothing.
// It never writes apps/mobile/dist. Drives 390×844 @3x in installed Google Chrome (channel "chrome") and Playwright
// WebKit; never runs `playwright install`. One fresh user per pass (하늘); the main thread's messages and the
// artifacts are fixtures (page.route; design-director's guide examples, qa/fixtures/html-artifacts/), so no LLM is
// needed. Every https request the browser makes is answered by a local stub: nothing leaves the machine.
//   inline:      every example inline (captures); on the comparison (shorter than the cap): the card is solid paper
//                the width of the turn, its frame is sandbox="allow-scripts" and nothing more, titled after the
//                artifact; the srcdoc starts its head with the CSP meta (a fresh nonce that the one script carries, and
//                whose text hash the app CSP lists); height = content, no fade, no 전체 화면; base type (16–17 px,
//                keep-all, line-height 1.5–1.7, the system Korean face); theme variables = the app's; a table already
//                in the page's own scroll box is not boxed again; every example's text clears AA contrast
//   links:       a tap anywhere inside a row link (<b>, <i>, the ::after chevron) asks first: "외부 사이트 열기 · host"
//                and the whole URL, focus on the bar, Esc / 취소 dismiss, nothing navigates; 열기 is a target=_blank
//                noopener noreferrer link (opened against the stub)
//   cap:         taller than 70% of the screen → the card stops there and fades into --bg under 전체 화면 (44 pt, not
//                under the composer); first view grows on the spring (instant under reduced motion)
//   full:        전체 화면 morphs a sheet out of the card (clip from the card's width; instant under reduced motion),
//                the title said once, the whole page at its height, a link asks in a bar inside the sheet, Esc
//                closes only the bar
//   long:        the clinic list five times over (60 rows) in the sheet: full height, the last row reachable and live
//   wheel:       a wheel over the card scrolls the chat (the frame never traps scrolling)
//   llm:         the twelve pages the real model wrote (qa/fixtures/html-artifacts/llm/): each draws in the card with
//                nothing sideways (captures); its contrast is recorded as a note (the model's colours, not the
//                renderer's); its table headers are 13 px and up (10 and 11 leave th to the frame's default: 11.4 and
//                12.25 px before the floor), and so is its <small> text (12 gives small no size: 11.67 px before the
//                floor); 07's tracking link (&amp; in the markup) asks with the whole URL, & intact
//   deep:        the three '전부' answers of a real deep search (qa/fixtures/html-artifacts/deep/, up to 21.6 KB and
//                120 links): each stops at 70% under the fade and 전체 화면, its own * reset beats the frame's
//                defaults (no list indent), nothing sideways or clipped (long names
//                and links wrap in their rows), its first link asks in the bar above the composer; in the sheet the
//                whole page at its height, scrolled to the end in steps (two frames < 100 ms each), the last link
//                asks; frames while the sheet opens and closes are recorded (max, p95, long tasks) and stay < 100 ms
//   rows:        the '전부' cards drawn by code from rows (qa/fixtures/html-artifacts/deep-rows/, agent-runtime's
//                deep-15: synthetic 150 / 500, two of 500 cut by height (long names; prices in words), 40 and 500 at
//                every field's clip length (the 500 past 300 KB), the real mounjaro run's 236): each stops at
//                70% under the fade and 전체 화면; type 13 px and up; every text AA, none in --text-3, the light --accent
//                #0066cc; nothing sideways or cut off; every link row one whole-row tap area of 44 px and up; each
//                head's 'N곳' = its rows; the summary counts every row found and says the rows shown; every region
//                stays; every link opens (https, ≤ 2048); the line after the card says the count and names every
//                place a cut card left off; the first row tapped at its far corner asks in the bar above the composer;
//                the sheet holds the whole card, scrolls to the end in steps (two frames ≤ 100 ms each), is painted
//                top to bottom (no blank tile), the last row asks; opening and closing frames ≤ 100 ms; memory noted.
//                Then at 320 wide (244 px of content) the two cut by height: the frame holds the whole card under
//                100,000 px and the sheet's end shows its last row
//   theme:       (light) the OS goes dark → the frame follows without reloading
//   security:    the hostile page: no script ran (window.__pwned), no handler survived, no remote request left
//                (server log + request events), meta refresh / base / form / iframe / object gone, only https links
//                keep an href, an IDN link shows its xn-- host, the frame is still about:srcdoc; then the second wall
//                alone: a script and an image injected past the sanitiser are refused by the CSP; and the app ignores
//                forged messages (wrong window, wrong channel, bad heights, non-https links)
//   big:         over 300 KB (the largest card the server keeps: a '전부' card drawn from rows) → a Korean error in the
//                card, no frame; exactly 300 KB draws, and so does a 160 KB page (over the model's 150 KB)
//   placeholder: a reply already seen comes back with its artifact late: the placeholder holds the card's height
//   archive:     보관함 문서 lists the pages (메타 '페이지', text previews); the sheet renders the same frame
// Per pass: 0 console errors, 0 horizontal overflow (app and inside every frame) at every screenshot.
// Screenshots: docs/qa/html-artifact/hart-<engine>-<variant>-NN-name.png · results: docs/qa/html-artifact/results.json
import { chromium, webkit } from "playwright";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEEP, HOSTILE, LLM, longDirectory, ROWS, sample, SAMPLES } from "./fixtures/html-artifacts.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, "..");
const repo = path.resolve(appDir, "../..");
const outDir = process.env.QA_OUT ? path.resolve(process.env.QA_OUT) : path.join(repo, "docs/qa/html-artifact");
fs.mkdirSync(outDir, { recursive: true });
const API = process.env.QA_API || "http://127.0.0.1:8792";
const PORT = Number(process.env.QA_PORT || 5188);
const BASE = `http://127.0.0.1:${PORT}`;
const DIST = process.env.QA_DIST || path.join(os.tmpdir(), `pickle-html-qa-dist-${PORT}-${crypto.createHash("sha1").update(appDir).digest("hex").slice(0, 8)}`);
const ENGINES = (process.env.QA_ENGINES || "chromium,webkit").split(",");
const VARIANTS = (process.env.QA_VARIANTS || "light,dark,reduced").split(",");
const WIDTH = Number(process.env.QA_WIDTH || 390);
const ONLY = process.env.QA_ONLY ? new Set(process.env.QA_ONLY.split(",")) : null;
const want = (s) => !ONLY || ONLY.has(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = () => crypto.randomBytes(3).toString("hex");
const PASSWORD = "qa-pass-1234";
const CAP = 0.7;
const SANDBOX_BAD = ["allow-same-origin", "allow-forms", "allow-popups", "allow-top-navigation", "allow-modals", "allow-popups-to-escape-sandbox"];

// ── the app, served with the server's own security headers ──

const SEC_HEADERS = ["content-security-policy", "x-content-type-options", "referrer-policy", "x-frame-options", "permissions-policy", "cross-origin-opener-policy"];
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".ico": "image/x-icon", ".json": "application/json", ".webmanifest": "application/manifest+json", ".woff2": "font/woff2", ".mp3": "audio/mpeg", ".wasm": "application/wasm", ".txt": "text/plain; charset=utf-8" };

async function startApp() {
  const health = await fetch(`${API}/api/health`).catch(() => null);
  if (!health?.ok) throw new Error(`pickle server is not answering at ${API}`);
  const headers = {};
  for (const h of SEC_HEADERS) {
    const v = health.headers.get(h);
    if (v) headers[h] = v;
  }
  if (!headers["content-security-policy"]) throw new Error("the server sends no Content-Security-Policy");
  if (process.env.QA_BUILD !== "0" || !fs.existsSync(path.join(DIST, "index.html"))) {
    const b = spawnSync("bunx", ["vite", "build", "--outDir", DIST, "--emptyOutDir"], { cwd: appDir, stdio: "pipe", encoding: "utf8" });
    if (b.status !== 0) throw new Error(`build failed:\n${b.stdout}\n${b.stderr}`);
  }
  const api = new URL(API);
  const remoteHits = [];
  const root = path.resolve(DIST);
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, BASE);
    if (url.pathname.startsWith("/qa-remote/")) {
      // the hostile page points here: anything that arrives slipped past both walls
      remoteHits.push(`${req.method} ${url.pathname}`);
      res.writeHead(404, headers).end();
      return;
    }
    if (url.pathname.startsWith("/api/")) {
      const up = http.request({ host: api.hostname, port: api.port, method: req.method, path: req.url, headers: { ...req.headers, host: api.host } }, (r) => {
        res.writeHead(r.statusCode ?? 502, r.headers);
        r.pipe(res);
      });
      up.on("error", () => (res.headersSent ? res.destroy() : res.writeHead(502).end()));
      res.on("close", () => up.destroy());
      req.pipe(up);
      return;
    }
    let rel;
    try {
      rel = decodeURIComponent(url.pathname);
    } catch {
      res.writeHead(400).end();
      return;
    }
    let file = path.normalize(path.join(root, rel));
    if (file !== root && !file.startsWith(root + path.sep)) {
      res.writeHead(403).end();
      return;
    }
    if (rel === "/" || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      if (/\.[a-z0-9]{1,8}$/i.test(rel)) {
        res.writeHead(404, headers).end();
        return;
      }
      file = path.join(root, "index.html");
    }
    res.writeHead(200, { ...headers, "content-type": TYPES[path.extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise((ok, bad) => {
    server.once("error", (e) => bad(new Error(`port ${PORT}: ${e.message}; set QA_PORT`)));
    server.listen(PORT, "127.0.0.1", ok);
  });
  // our own server answers: the index it serves is the one just built
  const served = await (await fetch(`${BASE}/`)).text();
  if (served !== fs.readFileSync(path.join(root, "index.html"), "utf8")) throw new Error("the app port serves another build");
  const s = await fetch(`${BASE}/api/session`);
  if (s.status !== 401 && !s.ok) throw new Error(`/api via the app port answered ${s.status}`);
  return { server, csp: headers["content-security-policy"], remoteHits };
}

// ── node-side API (paced: the server allows 10 sign-ups/logins per minute per IP) ──

const authLog = [];
async function authSlot() {
  for (;;) {
    const now = Date.now();
    while (authLog.length && now - authLog[0] > 61_000) authLog.shift();
    if (authLog.length < 8) {
      authLog.push(now);
      return;
    }
    await sleep(authLog[0] + 61_500 - now);
  }
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

async function signupApi(handle, displayName, agentName) {
  for (let i = 0; i < 5; i++) {
    await authSlot();
    const kp = await crypto.webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const jwk = await crypto.webcrypto.subtle.exportKey("jwk", kp.publicKey);
    const r = await api("POST", "/api/auth/signup", { handle, password: PASSWORD, displayName, agentName, device: { id: `qa-${rand()}`, label: "QA", signingKey: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y } } });
    if (r.status === 201 || r.status === 200) return { token: r.body.token, handle };
    if (r.status === 429) {
      await sleep(20_000);
      continue;
    }
    throw new Error(`signup ${handle}: ${r.status} ${JSON.stringify(r.body)}`);
  }
  throw new Error("signup rate limited");
}


// ── fixtures ──

const NOW = Date.now();
const record = (id, title, html, i) => ({ id, threadId: null, title, kind: "html", content: html, createdAt: NOW - (i + 2) * 3600_000, updatedAt: NOW - (i + 1) * 3600_000 });
const ART = new Map(SAMPLES.map((s, i) => [s.id, record(s.id, s.title, s.html, i)]));
LLM.forEach((s, i) => ART.set(s.id, record(s.id, s.title, s.html, 10 + i)));
DEEP.forEach((s, i) => ART.set(s.id, record(s.id, s.title, s.html, 20 + i)));
ROWS.forEach((s, i) => ART.set(s.id, record(s.id, s.title, s.html, 30 + i)));
ART.set("qa-html-hostile", record("qa-html-hostile", "보안 점검", HOSTILE.replaceAll("REMOTE", BASE), 6));
ART.set("qa-html-long", record("qa-html-long", "도쿄·오사카 클리닉 60곳", longDirectory(), 7));
// > 300 KB of real markup (UTF-8 bytes); 160 KB; exactly 300 KB (padded with spaces) and one byte more
const BIG_ROW = "<tr><td>하늘 님의 아주 긴 표 한 줄이에요</td><td>12,345원</td></tr>";
ART.set("qa-html-big", record("qa-html-big", "아주 긴 표", `<table>${BIG_ROW.repeat(3900)}</table>`, 8));
ART.set("qa-html-mid", record("qa-html-mid", "긴 표 160KB", `<table>${BIG_ROW.repeat(2000)}</table>`, 8));
const atBytes = (n) => {
  const head = `<table>${BIG_ROW.repeat(100)}</table>`;
  return head + " ".repeat(n - Buffer.byteLength(head));
};
ART.set("qa-html-cap", record("qa-html-cap", "딱 300KB", atBytes(300 * 1024), 8));
ART.set("qa-html-cap1", record("qa-html-cap1", "300KB + 1", atBytes(300 * 1024 + 1), 8));

/** a two-message main thread: the ask, then the answer carrying the html card */
function turn(mainId, artId, ask = "보여 줘", answer = "만들어 봤어요.") {
  const a = ART.get(artId);
  return [
    { id: `qa-u-${artId}`, threadId: mainId, role: "user", text: ask, cards: [], tools: [], attachments: [], createdAt: NOW - 120_000 },
    {
      id: `qa-a-${artId}`,
      threadId: mainId,
      role: "assistant",
      text: answer,
      cards: [{ type: "artifact", artifactId: artId, title: a.title, kind: "html", preview: a.title }],
      tools: [],
      attachments: [],
      createdAt: NOW - 110_000,
    },
  ];
}
const turnOf = (mainId, s) => turn(mainId, s.id, s.ask, s.answer);
// ── page helpers ──

const INIT = () => {
  if (window !== window.top) return;
  const qa = (window.__qa = { shifts: [] });
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) if (!e.hadRecentInput) qa.shifts.push({ t: e.startTime, v: e.value });
    }).observe({ type: "layout-shift", buffered: true });
  } catch {
    /* WebKit: no layout-shift entries (the rect checks still run) */
  }
};

async function overflow(page) {
  return page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const doc = document.documentElement.scrollWidth - vw;
    const offenders = [];
    for (const sc of document.querySelectorAll(".screen-scroll, .sheet-body")) {
      const scr = sc.getBoundingClientRect();
      if (!scr.width || scr.right < 0 || scr.left > vw) continue;
      for (const el of sc.querySelectorAll("*")) {
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height || el.closest(".sr-only")) continue;
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

/** inside one artifact frame: nothing wider than the frame, unless it sits in a scroll box (.m-scroll) or is clipped */
const FRAME_OVERFLOW = () => {
  const vw = document.documentElement.clientWidth;
  const doc = document.documentElement.scrollWidth - vw;
  const offenders = [];
  for (const el of document.querySelectorAll("#m-root *")) {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    if (r.right <= vw + 0.5 && r.left >= -0.5) continue;
    let clipped = false;
    for (let p = el.parentElement; p && p.id !== "m-root"; p = p.parentElement) {
      const o = getComputedStyle(p);
      if (o.overflowX !== "visible") {
        const pr = p.getBoundingClientRect();
        if (pr.right <= vw + 0.5 && pr.left >= -0.5) {
          clipped = true;
          break;
        }
      }
    }
    if (!clipped) offenders.push(`${el.tagName.toLowerCase()}.${String(el.className).slice(0, 30)} [${Math.round(r.left)}–${Math.round(r.right)}]`);
  }
  return { doc, offenders: offenders.slice(0, 6) };
};

async function frameOf(locator) {
  const h = await locator.elementHandle();
  return h ? h.contentFrame() : null;
}
/** the frame's own location (Playwright's frame.url() is "" for srcdoc frames) */
const where = (frame) => frame.evaluate(() => location.href).catch(() => "detached");

class Pass {
  constructor(engine, variant, page) {
    Object.assign(this, { engine, variant, page, tag: `${engine}-${variant}`, n: 0, shots: [], overflows: [], checks: [], notes: [], errors: [], expected: [], cspWindow: false, expectRe: null });
  }
  /** recorded, never a failure (what the model chose, for the report) */
  note(name, detail = "") {
    const d = typeof detail === "string" ? detail : JSON.stringify(detail);
    this.notes.push({ name, detail: d.slice(0, 400) });
    console.log(`  note ${name}${d ? ` — ${d.slice(0, 180)}` : ""}`);
  }
  async shot(name) {
    await sleep(this.variant === "reduced" ? 150 : 450);
    const file = `hart-${this.tag}-${String(++this.n).padStart(2, "0")}-${name}.png`;
    await this.page.screenshot({ path: path.join(outDir, file) });
    const o = await overflow(this.page);
    const inner = [];
    for (const f of this.page.frames()) {
      if (f === this.page.mainFrame()) continue;
      const r = await f.evaluate(() => (document.getElementById("m-root") ? null : "skip")).then((x) => (x ? null : f.evaluate(FRAME_OVERFLOW)), () => null);
      if (r && (r.doc > 0 || r.offenders.length)) inner.push(r);
    }
    if (o.doc > 0 || o.offenders.length || inner.length) this.overflows.push({ file, ...o, frames: inner });
    this.shots.push(file);
  }
  async shotEl(name, locator) {
    await sleep(this.variant === "reduced" ? 150 : 450);
    const file = `hart-${this.tag}-${String(++this.n).padStart(2, "0")}-${name}.png`;
    // the card alone: the composer and the tab bar float over the chat, so they are hidden for this one picture
    await locator.screenshot({ path: path.join(outDir, file), style: ".composer, .tabbar { visibility: hidden !important; }" });
    this.shots.push(file);
  }
  check(name, ok, detail = "") {
    const d = typeof detail === "string" ? detail : JSON.stringify(detail);
    this.checks.push({ name, ok: !!ok, detail: d.slice(0, 400) });
    console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${d ? ` — ${d.slice(0, 180)}` : ""}`);
  }
}

/** show one turn: the main thread answers with these messages; wait for the html card to be ready */
async function showTurn(pass, ctx, items, { wait = true } = {}) {
  ctx.items = items;
  await pass.page.reload({ waitUntil: "load" });
  await pass.page.waitForSelector("#tab-chat", { timeout: 20_000 });
  if (wait) await pass.page.waitForSelector(".hart iframe.hframe[data-ready]", { timeout: 15_000 });
  await sleep(pass.variant === "reduced" ? 300 : 900);
}

/** the card at the top of the screen (its question above it), for captures */
async function frameCard(page) {
  await page.evaluate(() => {
    const card = document.querySelector(".hart");
    const sc = card?.closest(".screen-scroll");
    if (!card || !sc) return;
    const q = card.closest(".msg-asst")?.previousElementSibling ?? card;
    sc.scrollTop += q.getBoundingClientRect().top - 110;
  });
  await sleep(350);
}

const cardBox = (page) =>
  page.locator(".hart").first().evaluate((el) => {
    const r = el.getBoundingClientRect();
    const f = el.querySelector("iframe");
    return { h: Math.round(r.height * 10) / 10, w: Math.round(r.width), top: Math.round(r.top), frameH: f ? parseFloat(f.style.height) || 0 : null, vh: innerHeight };
  });

async function closeSheet(page) {
  const close = page.locator(".sheet-root .sheet-close");
  if (await close.count()) await close.first().click();
  await page.locator(".sheet-root").waitFor({ state: "detached", timeout: 6000 }).catch(() => {});
  await sleep(250);
}

const sha256b64 = (s) => crypto.createHash("sha256").update(s, "utf8").digest("base64");

const FRAME = ".hart iframe.hframe";
const SHEET_FRAME = ".sheet-root .hart-full iframe.hframe";
const firstText = (frame) => frame.evaluate(() => document.getElementById("m-root").textContent.replace(/\s+/g, " ").trim().slice(0, 60));
const contentH = (frame) => frame.evaluate(() => Math.ceil(document.getElementById("m-root").getBoundingClientRect().height));

/**
 * Text contrast inside a frame, against the composited background (WCAG AA: 4.5:1, or 3:1 for 24 px / 18.66 px bold),
 * after design-director's guide harness (genui/check.mjs LOW-CONTRAST): with the app's real light and dark values,
 * an example that passes here is readable in the app.
 */
const CONTRAST = () => {
  const rgba = (v) => {
    const m = v.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
  };
  const mix = (c, under) => [0, 1, 2].map((i) => c[i] * c[3] + under[i] * (1 - c[3]));
  const lum = (c) => {
    const r = c.map((v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r[0] + 0.7152 * r[1] + 0.0722 * r[2];
  };
  const low = [];
  let worst = 99;
  for (const el of document.querySelectorAll("#m-root *")) {
    if (![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || el.closest("[aria-hidden=true]") || !el.getClientRects().length) continue;
    const layers = [];
    for (let q = el; q; q = q.parentElement) {
      const c = rgba(getComputedStyle(q).backgroundColor);
      if (c && c[3] > 0) {
        layers.push(c);
        if (c[3] >= 1) break;
      }
    }
    const under = layers.reverse().reduce((acc, c) => mix(c, acc), [255, 255, 255]);
    const fg = mix(rgba(cs.color) ?? [0, 0, 0, 1], under);
    const [hi, lo] = [lum(fg), lum(under)].sort((x, y) => y - x);
    const ratio = (hi + 0.05) / (lo + 0.05);
    const fs = parseFloat(cs.fontSize);
    const big = fs >= 24 || (fs >= 18.66 && +cs.fontWeight >= 700);
    worst = Math.min(worst, ratio);
    if (ratio < (big ? 3 : 4.5)) low.push(`${el.tagName.toLowerCase()}.${el.className} ${ratio.toFixed(2)} ${fs}px "${el.textContent.trim().slice(0, 8)}"`);
  }
  return { low: low.slice(0, 6), worst: Math.round(worst * 100) / 100 };
};

/** the card's link bar (in the app's overlay layer, above the composer) */
const CARD_BAR = ".hlink[data-placement=card]";
/** the link bar as the app shows it; `seen`: wholly on screen, below the top bar and above the composer (when there is
 *  one), and nothing covers 열기 */
const barState = (page, sel) =>
  page.evaluate((sel) => {
    const d = document.querySelector(sel);
    if (!d) return null;
    const open = d.querySelector("a.hlink-open");
    const r = d.getBoundingClientRect();
    const composer = document.querySelector(".composer")?.getBoundingClientRect();
    const sheet = d.closest(".sheet-root");
    const floor = !sheet && composer ? composer.top : innerHeight;
    const o = open?.getBoundingClientRect();
    const hit = o ? document.elementFromPoint(o.left + o.width / 2, o.top + o.height / 2) : null;
    return {
      host: d.querySelector(".hlink-host")?.textContent,
      url: d.querySelector(".hlink-url")?.textContent,
      href: open?.getAttribute("href"),
      target: open?.target,
      rel: open?.rel,
      focus: document.activeElement === d,
      label: d.getAttribute("aria-label"),
      btns: [...d.querySelectorAll(".hlink-actions > *")].map((b) => Math.round(b.getBoundingClientRect().height)),
      radii: [...d.querySelectorAll(".hlink-actions > *")].map((b) => Math.round(parseFloat(getComputedStyle(b).borderTopLeftRadius))),
      top: Math.round(r.top),
      bottom: Math.round(r.bottom),
      left: Math.round(r.left),
      width: Math.round(r.width),
      seen: r.top >= 0 && r.bottom <= floor + 0.5 && r.left >= 0 && r.right <= innerWidth + 0.5 && !!hit && open.contains(hit),
    };
  }, sel);

// ── scenarios ──

async function inline(pass, ctx) {
  const { page } = pass;
  // every example inline, for the record (most run past the cap)
  for (const s of SAMPLES) {
    await showTurn(pass, ctx, turnOf(ctx.mainId, s));
    const c = await (await frameOf(page.locator(FRAME).first())).evaluate(CONTRAST);
    pass.check(`inline: ${s.file} — every text clears AA contrast with the app's ${pass.variant === "dark" ? "dark" : "light"} values`, c.low.length === 0, `worst ${c.worst}${c.low.length ? ` · ${c.low.join("; ")}` : ""}`);
    await frameCard(page);
    await pass.shot(`inline-${s.file}`);
    await pass.shotEl(`card-${s.file}`, page.locator(".hart").first());
  }
  const s = sample("product-compare"); // shorter than the cap
  await showTurn(pass, ctx, turnOf(ctx.mainId, s));
  const frameEl = page.locator(FRAME).first();
  // reading contentDocument is the probe: WebKit logs the refusal ("Blocked a frame … sandboxed"), which is expected here
  pass.expectRe = /Blocked a frame|sandboxed and lacks the "allow-same-origin"/;
  const attrs = await frameEl.evaluate((f) => ({ sandbox: f.getAttribute("sandbox"), title: f.title, srcdoc: f.getAttribute("srcdoc") ?? "", doc: f.contentDocument === null }));
  await sleep(100);
  pass.expectRe = null;
  pass.check("inline: the frame is sandbox=\"allow-scripts\" and nothing more", attrs.sandbox === "allow-scripts" && !SANDBOX_BAD.some((t) => attrs.sandbox.includes(t)), attrs.sandbox);
  pass.check("inline: the app cannot reach into the frame (opaque origin: contentDocument is null)", attrs.doc);
  pass.check("inline: the frame's title is the artifact's title", attrs.title === s.title, attrs.title);
  const head = /^<!doctype html><html lang="ko" data-theme="(light|dark)" data-ch="([^"]+)"><head><meta http-equiv="Content-Security-Policy" content="([^"]+)">/i.exec(attrs.srcdoc);
  const csp = head?.[3] ?? "";
  const nonce = /script-src 'nonce-([A-Za-z0-9_-]{16,})'/.exec(csp)?.[1] ?? "";
  pass.check(
    "inline: the CSP meta is the first thing in head, as specified",
    !!head && csp === `default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'` && nonce.length >= 16,
    csp,
  );
  const scripts = [...attrs.srcdoc.matchAll(/<script nonce="([^"]+)">([\s\S]*?)<\/script>/g)];
  pass.check("inline: one script, carrying this document's nonce", scripts.length === 1 && scripts[0][1] === nonce, `${scripts.length} script(s)`);
  const hash = scripts[0] ? `'sha256-${sha256b64(scripts[0][2])}'` : "";
  pass.check("inline: the app CSP allows that script by its hash (the frame inherits the app's policy)", !!hash && ctx.csp.includes(hash), hash);
  ctx.nonces.push(nonce);

  const frame = await frameOf(frameEl);
  const inner = await frame.evaluate(() => {
    const b = getComputedStyle(document.body);
    const root = document.getElementById("m-root").getBoundingClientRect();
    const de = document.documentElement;
    const v = (n) => getComputedStyle(de).getPropertyValue(n).trim();
    const names = ["--bg", "--surface", "--text", "--text-2", "--text-3", "--line", "--accent", "--accent-fill", "--on-accent", "--danger", "--success", "--fill", "--radius", "--radius-sm", "--space", "--space-sm", "--font"];
    const table = document.querySelector("table");
    return {
      url: location.href,
      fs: parseFloat(b.fontSize),
      lh: parseFloat(b.lineHeight) / parseFloat(b.fontSize),
      wb: b.wordBreak,
      font: b.fontFamily,
      scheme: getComputedStyle(de).colorScheme,
      theme: de.dataset.theme,
      content: Math.ceil(root.height),
      vars: Object.fromEntries(names.map((n) => [n, v(n)])),
      scripts: document.scripts.length,
      tableBox: table ? `${table.parentElement.className}` : "none",
      boxes: document.querySelectorAll(".m-scroll").length,
    };
  });
  const app = await page.evaluate(() => {
    const cs = getComputedStyle(document.documentElement);
    return { theme: document.documentElement.dataset.theme, surface: cs.getPropertyValue("--surface").trim(), label: cs.getPropertyValue("--label").trim(), accent: cs.getPropertyValue("--accent-text").trim() };
  });
  pass.check("inline: the frame stays about:srcdoc", inner.url === "about:srcdoc", inner.url);
  pass.check("inline: base type — 16–17 px, line-height 1.5–1.7, keep-all, the system Korean face", inner.fs >= 16 && inner.fs <= 17 && inner.lh >= 1.5 && inner.lh <= 1.7 && inner.wb === "keep-all" && /Apple SD Gothic Neo/.test(inner.font), `${inner.fs}px · ${inner.lh.toFixed(2)} · ${inner.wb}`);
  // light --accent is the frame's own #0066cc (AA on --surface too, where the app's #0071e3 is 4.21:1); dark is the app's
  const accent = app.theme === "light" ? "#0066cc" : app.accent;
  pass.check("inline: the theme is the app's (data-theme, color-scheme, --bg/--text = app tokens; --accent the app's in dark, #0066cc in light)", inner.theme === app.theme && inner.scheme === app.theme && inner.vars["--bg"] === app.surface && inner.vars["--text"] === app.label && inner.vars["--accent"] === accent && inner.vars["--accent-fill"] === "#0071e3", { inner: [inner.theme, inner.scheme, inner.vars["--accent"], inner.vars["--accent-fill"]], app });
  pass.check("inline: every guide variable is defined in the frame (values recorded)", Object.values(inner.vars).every(Boolean), inner.vars);
  pass.check("inline: a table already alone in the page's own scroll box is not boxed again", inner.tableBox === "scroll" && inner.boxes === 0, `${inner.tableBox} · ${inner.boxes} m-scroll`);

  const card = await page.locator(".hart").first().evaluate((el) => {
    const cs = getComputedStyle(el);
    const parent = el.parentElement;
    const pcs = getComputedStyle(parent);
    const inner = parent.clientWidth - parseFloat(pcs.paddingLeft) - parseFloat(pcs.paddingRight);
    const r = el.getBoundingClientRect();
    return { bg: cs.backgroundColor, blur: cs.backdropFilter ?? cs.webkitBackdropFilter ?? "none", w: r.width, inner, h: r.height, more: !!el.querySelector(".hart-more") };
  });
  const opaque = !/rgba\(.*,\s*0?\.\d+\)$|transparent/.test(card.bg);
  pass.check("inline: the card is solid paper (opaque, no backdrop blur)", opaque && (!card.blur || card.blur === "none"), `${card.bg} · ${card.blur}`);
  pass.check("inline: the card is the full width of the turn", Math.abs(card.w - card.inner) <= 1, `${card.w} of ${card.inner}`);
  pass.check("inline: a page shorter than the cap: the card is exactly its height, no fade, no 전체 화면", Math.abs(card.h - inner.content) <= 1 && !card.more && card.h < CAP * 844, `${card.h} vs content ${inner.content}`);
  pass.check("inline: only our script is in the frame", inner.scripts === 1, inner.scripts);
}

async function links(pass, ctx) {
  const { page } = pass;
  const s = sample("directory-list");
  await showTurn(pass, ctx, turnOf(ctx.mainId, s));
  await frameCard(page);
  const frame = await frameOf(page.locator(FRAME).first());
  const startUrl = page.url();
  const popups = [];
  const onPage = (p) => popups.push(p);
  page.context().on("page", onPage);
  try {
    // a tap on the clinic's name (<b> inside the row's <a>)
    await frame.locator('a[href="https://hana-clinic.example.com/reserve"] b').click();
    await page.waitForSelector(`${CARD_BAR}[role=dialog]`, { timeout: 4000 });
    await sleep(400);
    const bar = await barState(page, CARD_BAR);
    pass.check("links: a tap inside a row link asks first — 외부 사이트 열기 · host, then the whole URL", bar?.host === "외부 사이트 열기 · hana-clinic.example.com" && bar.url === "https://hana-clinic.example.com/reserve" && bar.label === "링크 열기", bar);
    pass.check("links: 열기 is a target=_blank noopener noreferrer link to that URL; focus moves to the bar", bar?.href === "https://hana-clinic.example.com/reserve" && bar.target === "_blank" && /noopener/.test(bar.rel) && /noreferrer/.test(bar.rel) && bar.focus, bar);
    const geo = await page.evaluate(() => {
      const c = document.querySelector(".hart").getBoundingClientRect();
      return { card: [Math.round(c.left), Math.round(c.width), Math.round(c.bottom)], composer: Math.round(document.querySelector(".composer")?.getBoundingClientRect().top ?? -1) };
    });
    pass.check(
      "links: the bar is seen whole where the tap was — the card's width, just above the composer, 열기 uncovered (this card runs on under the composer)",
      !!bar?.seen && Math.abs(bar.left - geo.card[0]) <= 1 && Math.abs(bar.width - geo.card[1]) <= 1 && geo.card[2] > geo.composer && geo.composer - bar.bottom <= 24,
      { bar: bar && [bar.top, bar.bottom, bar.left, bar.width, bar.seen], ...geo },
    );
    pass.check("links: 취소 and 열기 are at least 44 pt tall, both capsules (radius = half the height)", bar?.btns.length === 2 && bar.btns.every((h, i) => h >= 44 && Math.abs(bar.radii[i] - h / 2) <= 1), `${bar?.btns.join(",")} · r ${bar?.radii.join(",")}`);
    const fu = await where(frame);
    pass.check("links: nothing navigated (page and frame), no window opened", page.url() === startUrl && fu === "about:srcdoc" && popups.length === 0, `${page.url()} · ${fu} · ${popups.length} popup(s)`);
    await pass.shot("link-confirm-card");
    await page.keyboard.press("Escape");
    await page.locator(CARD_BAR).waitFor({ state: "detached", timeout: 3000 }).catch(() => {});
    pass.check("links: Esc dismisses the bar", (await page.locator(CARD_BAR).count()) === 0);

    // the badge (<i>) of another row, then the chevron (a::after: the click lands on the <a> itself)
    await frame.locator('a[href="https://sora-medical.example.com/reserve"] i.ko').click();
    await page.waitForSelector(CARD_BAR, { timeout: 4000 }).catch(() => {});
    const b2 = await barState(page, CARD_BAR);
    await page.locator(`${CARD_BAR} button`, { hasText: "취소" }).click();
    await page.locator(CARD_BAR).waitFor({ state: "detached", timeout: 3000 }).catch(() => {});
    const gone = (await page.locator(CARD_BAR).count()) === 0;
    const row = frame.locator('a[href="https://midori-naika.example.com/reserve"]');
    const box = await row.boundingBox();
    // a locator click at the chevron's spot: Playwright waits for the frame to settle after the bar left and checks the
    // point lands on the row (a raw mouse click right after a layout change can be routed before the frame's hit-test
    // data catches up, in Chrome's out-of-process sandboxed frames)
    await row.click({ position: { x: box.width - 10, y: box.height / 2 } });
    await page.waitForSelector(CARD_BAR, { timeout: 4000 }).catch(() => {});
    const b3 = await barState(page, CARD_BAR);
    pass.check("links: a tap on a badge or on the chevron finds its row link; 취소 dismisses", b2?.host === "외부 사이트 열기 · sora-medical.example.com" && gone && b3?.host === "외부 사이트 열기 · midori-naika.example.com", [b2?.host, gone, b3?.host]);

    const popup = page.context().waitForEvent("page", { timeout: 6000 }).catch(() => null);
    await page.locator(`${CARD_BAR} a.hlink-open`).click();
    const p = await popup;
    const opened = p ? p.url() : "";
    if (p) await p.close().catch(() => {});
    await sleep(300);
    pass.check("links: 열기 opens the URL in a new tab (stubbed), the app stays and the bar goes", opened === "https://midori-naika.example.com/reserve" && page.url() === startUrl && (await page.locator(CARD_BAR).count()) === 0, `${opened} · ${page.url()}`);

    // another link tapped while the bar is up: the bar now says that link, and the focus is back on the bar
    await frame.locator('a[href="https://sora-medical.example.com/reserve"] i.ko').click();
    await page.waitForSelector(CARD_BAR, { timeout: 4000 }).catch(() => {});
    await frame.locator('a[href="https://hana-clinic.example.com/reserve"] b').click();
    await page.waitForFunction(() => /hana-clinic/.test(document.querySelector(".hlink[data-placement=card] .hlink-host")?.textContent ?? ""), null, { timeout: 4000 }).catch(() => {});
    await sleep(100);
    const b4 = await barState(page, CARD_BAR);
    pass.check("links: a second tap while the bar is up re-asks for that link, focus on the bar again", b4?.host === "외부 사이트 열기 · hana-clinic.example.com" && b4.focus === true, b4 && [b4.host, b4.focus]);
    await page.keyboard.press("Escape");
    await page.locator(CARD_BAR).waitFor({ state: "detached", timeout: 3000 }).catch(() => {});
  } finally {
    page.context().off("page", onPage);
  }
}

async function llm(pass, ctx) {
  const { page } = pass;
  for (const s of LLM) {
    await showTurn(pass, ctx, turnOf(ctx.mainId, s));
    const frame = await frameOf(page.locator(FRAME).first());
    const fit = await frame.evaluate(() => {
      const de = document.documentElement;
      return { sw: de.scrollWidth, cw: de.clientWidth, h: Math.ceil(document.getElementById("m-root").getBoundingClientRect().height) };
    });
    const box = await cardBox(page);
    pass.check(`llm: ${s.file} draws in the card, nothing sideways`, fit.h > 40 && fit.sw <= fit.cw && box.h > 40 && box.h <= box.vh * CAP + 1, `content ${fit.h} · card ${box.h} · width ${fit.sw}/${fit.cw}`);
    const c = await frame.evaluate(CONTRAST);
    pass.note(`llm: ${s.file} contrast (the model's colours)`, `worst ${c.worst}${c.low.length ? ` · ${c.low.join("; ")}` : ""}`);
    const [th, small] = await frame.evaluate(() =>
      ["th", "small"].map((sel) => {
        const px = [...document.querySelectorAll(`#m-root ${sel}`)].filter((t) => t.textContent.trim()).map((t) => parseFloat(getComputedStyle(t).fontSize));
        return { n: px.length, min: px.length ? Math.min(...px) : null };
      }),
    );
    if (th.n) pass.check(`llm: ${s.file} table headers 13 px and up`, th.min >= 13, th);
    if (small.n) pass.check(`llm: ${s.file} <small> text 13 px and up`, small.min >= 13, small);
    await frameCard(page);
    await pass.shot(`llm-${s.file}`);
    await pass.shotEl(`llm-card-${s.file}`, page.locator(".hart").first());
    if (s.file !== "07-delivery") continue;
    // the tracking link: &amp; in the markup is & in the URL the bar shows and opens
    const want = "https://trace.cjlogistics.com/next/tracking.html?wblNo=689412345678&utm_source=mosi_app&utm_medium=push&utm_campaign=delivery_tracking_notice_20261115";
    const capped = (await page.locator(".hart .hart-more").count()) > 0;
    let scope = CARD_BAR;
    let target = frame;
    if (capped) {
      // under the fade: the page's own link is reached in 전체 화면, as a person would
      await page.locator(".hart .hart-more button, .hart button.hart-more").first().click();
      await page.waitForSelector(".sheet-root iframe.hframe[data-ready]", { timeout: 8000 });
      await sleep(pass.variant === "reduced" ? 200 : 900);
      scope = ".sheet-root .hlink";
      target = await frameOf(page.locator(".sheet-root iframe.hframe").first());
    }
    await target.locator('a[href^="https://trace.cjlogistics.com/"]').first().click();
    await page.waitForSelector(scope, { timeout: 4000 }).catch(() => {});
    await sleep(300);
    const bar = await barState(page, scope);
    const fits = await page.evaluate((scope) => {
      const d = document.querySelector(scope);
      const u = d?.querySelector(".hlink-url");
      return !!d && d.getBoundingClientRect().right <= innerWidth + 0.5 && u.scrollWidth <= u.clientWidth + 1;
    }, scope);
    pass.check(
      "llm: 07's tracking link asks with its host and the whole URL, & intact (the query string is not mangled)",
      bar?.host === "외부 사이트 열기 · trace.cjlogistics.com" && bar.url === want && bar.href === want && fits && bar.seen,
      bar && { host: bar.host, url: bar.url, fits, seen: bar.seen, in: capped ? "sheet" : "card" },
    );
    await pass.shot("llm-link-07");
    await page.keyboard.press("Escape");
    await page.locator(scope).waitFor({ state: "detached", timeout: 3000 }).catch(() => {});
    if (capped) await closeSheet(page);
  }
}

/** frame gaps (rAF to rAF) and long tasks in the app while something animates: start, act, then stop */
async function framesStart(page) {
  await page.evaluate(() => {
    const qa = window.__qa;
    qa.gaps = [];
    qa.long = [];
    qa.rec = true;
    let last = 0;
    const tick = (t) => {
      if (!qa.rec) return;
      if (last) qa.gaps.push(t - last);
      last = t;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    try {
      qa.lt?.disconnect();
      qa.lt = new PerformanceObserver((l) => {
        for (const e of l.getEntries()) qa.long.push(Math.round(e.duration));
      });
      qa.lt.observe({ type: "longtask" });
    } catch {
      /* WebKit: no long-task entries (the frame gaps still count) */
    }
  });
}
const framesStop = (page) =>
  page.evaluate(() => {
    const qa = window.__qa;
    qa.rec = false;
    qa.lt?.disconnect();
    const g = qa.gaps.map((x) => Math.round(x)).sort((a, b) => a - b);
    return { frames: g.length, max: g.at(-1) ?? 0, p95: g[Math.floor(g.length * 0.95)] ?? 0, over34: g.filter((x) => x > 34).length, long: qa.long };
  });

/** text cut off inside the frame: an element that clips (overflow not visible) holding more than it shows, except the
 *  scroll boxes we add around tables */
const FRAME_CLIPPED = () => {
  const out = [];
  for (const el of document.querySelectorAll("#m-root *")) {
    const cs = getComputedStyle(el);
    if (cs.overflowX === "visible" || el.classList.contains("m-scroll") || cs.overflowX === "auto" || cs.overflowX === "scroll") continue;
    if (el.scrollWidth > el.clientWidth + 1) out.push(`${el.tagName.toLowerCase()}.${String(el.className).slice(0, 20)} ${el.scrollWidth}/${el.clientWidth}`);
  }
  const links = [...document.querySelectorAll("#m-root a")];
  const lines = links.map((a) => Math.round(a.getBoundingClientRect().height / parseFloat(getComputedStyle(a).lineHeight || "20")));
  return { clipped: out.slice(0, 6), links: links.length, wrapped: lines.filter((n) => n > 1).length, widest: Math.max(0, ...links.map((a) => Math.round(a.getBoundingClientRect().width))), vw: document.documentElement.clientWidth };
};

async function deep(pass, ctx) {
  const { page } = pass;
  for (const s of DEEP) {
    const hrefs = [...s.html.matchAll(/href="(https:[^"]+)"/g)].map((m) => m[1].replaceAll("&amp;", "&"));
    await page.evaluate(() => localStorage.removeItem("pickle.htmlArtifactHeights"));
    await showTurn(pass, ctx, turnOf(ctx.mainId, s));
    // the card where a reply's card rests: its top under the bar, its bottom (fade, 전체 화면) above the composer
    await page.evaluate(() => {
      const card = document.querySelector(".hart");
      card.closest(".screen-scroll").scrollTop += card.getBoundingClientRect().top - 88;
    });
    await sleep(400);
    const frame = await frameOf(page.locator(FRAME).first());
    const content = await contentH(frame);
    const box = await cardBox(page);
    const capPx = Math.round(box.vh * CAP);
    const more = await page.evaluate(() => {
      const m = document.querySelector(".hart .hart-more");
      const b = m?.querySelector("button");
      const r = b?.getBoundingClientRect();
      const hit = r ? document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) : null;
      return m ? { fade: getComputedStyle(m).backgroundImage, onTop: !!hit?.closest(".hart-more button"), bottom: Math.round(r.bottom), composer: Math.round(document.querySelector(".composer")?.getBoundingClientRect().top ?? 0) } : null;
    });
    pass.check(
      `deep: ${s.file} stops at 70% under the fade, 전체 화면 on top and above the composer`,
      Math.abs(box.h - capPx) <= 1 && content > capPx && /gradient/.test(more?.fade ?? "") && more.onTop && more.bottom <= more.composer,
      { card: box.h, cap: capPx, content, more },
    );
    // all three open with *{margin:0;padding:0}: that reset, not the frame's defaults, decides list indents and gaps
    const reset = await frame.evaluate(() => {
      const ul = document.querySelector("#m-root ul");
      const li = document.querySelectorAll("#m-root ul > li")[1];
      const cs = getComputedStyle(ul);
      return { ulPadding: cs.paddingLeft, ulMargin: cs.marginBottom, liMargin: li ? getComputedStyle(li).marginTop : "0px" };
    });
    pass.check(`deep: ${s.file} the page's own *{margin:0;padding:0} wins over the frame's defaults (no list indent, no extra gaps)`, reset.ulPadding === "0px" && reset.ulMargin === "0px" && reset.liMargin === "0px", reset);
    const over = await frame.evaluate(FRAME_OVERFLOW);
    const fit = await frame.evaluate(FRAME_CLIPPED);
    pass.check(
      `deep: ${s.file} nothing sideways or cut off; long names and links wrap inside their rows`,
      over.doc <= 0 && over.offenders.length === 0 && fit.clipped.length === 0 && fit.widest <= fit.vw,
      { ...fit, offenders: over.offenders },
    );
    await pass.shot(`deep-${s.file}-card`);
    // its first link, tapped in the card: the bar comes up above the composer
    await frame.locator('a[href^="https://"]').first().click();
    await page.waitForSelector(CARD_BAR, { timeout: 4000 }).catch(() => {});
    await sleep(200);
    const b1 = await barState(page, CARD_BAR);
    const host1 = new URL(hrefs[0]).host;
    pass.check(`deep: ${s.file} its first link asks in the bar, seen whole above the composer`, b1?.host === `외부 사이트 열기 · ${host1}` && b1.url === hrefs[0] && b1.seen, b1 && [b1.host, b1.seen]);
    await page.keyboard.press("Escape");
    await page.locator(CARD_BAR).waitFor({ state: "detached", timeout: 3000 }).catch(() => {});

    // 전체 화면: frames recorded from the tap until the sheet has settled
    await framesStart(page);
    const t0 = Date.now();
    await page.locator(".hart .hart-more button").click();
    await page.waitForSelector(`${SHEET_FRAME}[data-ready]`, { timeout: 10_000 });
    const ready = Date.now() - t0;
    await sleep(pass.variant === "reduced" ? 400 : 1100);
    const opening = await framesStop(page);
    const sframe = await frameOf(page.locator(SHEET_FRAME));
    const full = await contentH(sframe);
    const frameH = await page.locator(SHEET_FRAME).evaluate((f) => parseFloat(f.style.height));
    pass.check(`deep: ${s.file} the sheet holds the whole page at its height`, Math.abs(frameH - full) <= 1 && full >= content - 60, `${frameH} vs ${full} · ready in ${ready} ms`);
    await pass.shot(`deep-${s.file}-sheet-top`);
    const steps = await page.evaluate(async () => {
      const b = document.querySelector(".sheet-root .sheet-body");
      const gaps = [];
      for (let i = 0; i < 40 && b.scrollTop < b.scrollHeight - b.clientHeight - 1; i++) {
        const t = performance.now();
        b.scrollTop += 420;
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        gaps.push(Math.round(performance.now() - t));
      }
      return { gaps, end: Math.round(b.scrollTop), max: b.scrollHeight - b.clientHeight };
    });
    pass.check(`deep: ${s.file} the sheet scrolls to the end, two frames per step under 100 ms`, steps.end >= steps.max - 1 && steps.gaps.every((g) => g < 100), { steps: steps.gaps.length, max: Math.max(...steps.gaps), end: steps.end, of: steps.max });
    await pass.shot(`deep-${s.file}-sheet-bottom`);
    await sframe.locator('a[href^="https://"]').last().click();
    await page.waitForSelector(".sheet-root .hlink", { timeout: 4000 }).catch(() => {});
    await sleep(300);
    const b2 = await barState(page, ".sheet-root .hlink");
    const hostN = new URL(hrefs.at(-1)).host;
    pass.check(`deep: ${s.file} the last link asks in the sheet's bar`, b2?.host === `외부 사이트 열기 · ${hostN}` && b2.url === hrefs.at(-1) && b2.seen, b2 && [b2.host, b2.seen]);
    await pass.shot(`deep-${s.file}-sheet-link`);
    await page.keyboard.press("Escape");
    await sleep(300);
    await framesStart(page);
    await closeSheet(page);
    await sleep(pass.variant === "reduced" ? 300 : 700);
    const closing = await framesStop(page);
    const back = await page.evaluate(() => getComputedStyle(document.querySelector(".hart")).opacity);
    pass.check(
      `deep: ${s.file} opening and closing the sheet drop no frame past 100 ms (the card comes back)`,
      opening.max < 100 && closing.max < 100 && back === "1",
      { open: opening, close: closing, ready },
    );
  }
}

/** a rows card's facts inside its frame: the smallest type, --text-3 / --accent use, the row tap areas and the counts */
const ROWS_FACTS = () => {
  const root = document.getElementById("m-root");
  const probe = document.createElement("span");
  root.appendChild(probe);
  const resolve = (v) => {
    probe.style.color = v;
    return getComputedStyle(probe).color;
  };
  const text3 = resolve("var(--text-3)");
  const accent = resolve("var(--accent)");
  probe.remove();
  let smallest = 99;
  const tiny = [];
  const inText3 = [];
  const inAccent = [];
  for (const el of root.querySelectorAll("*")) {
    if (![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
    const cs = getComputedStyle(el);
    const fs = parseFloat(cs.fontSize);
    smallest = Math.min(smallest, fs);
    const what = `${el.tagName.toLowerCase()}.${el.className} "${el.textContent.trim().slice(0, 8)}"`;
    if (fs < 13) tiny.push(`${what} ${fs}px`);
    if (cs.color === text3) inText3.push(what);
    if (cs.color === accent) inAccent.push(what);
  }
  const rows = [...root.querySelectorAll("ul > li")];
  const bad = [];
  let links = 0;
  let lowest = 999;
  for (const li of rows) {
    const t = li.firstElementChild;
    if (t?.tagName !== "A") continue;
    links++;
    const r = t.getBoundingClientRect();
    const l = li.getBoundingClientRect();
    const top = parseFloat(getComputedStyle(li).borderTopWidth) || 0;
    lowest = Math.min(lowest, r.height);
    // the link is the whole row: its width, its height under the rule line, and 44 px or more
    if (r.height < 44 || r.width < l.width - 1 || r.height < l.height - top - 1) bad.push(`${t.textContent.trim().slice(0, 10)} ${Math.round(r.width)}×${Math.round(r.height)} in ${Math.round(l.width)}×${Math.round(l.height)}`);
  }
  // a region's head: its name and 'N곳' (the last number in it), and the rows under it up to the next head (a region
  // with two price units has two lists, the '다른 기준 가격' line between them: not a row)
  const heads = [...root.querySelectorAll("h3")].map((h) => {
    let n = 0;
    let lists = 0;
    for (let e = h.nextElementSibling; e && e.tagName !== "H3"; e = e.nextElementSibling) if (e.tagName === "UL") (lists++, (n += e.children.length));
    return { g: (h.firstChild?.textContent ?? "").slice(0, 12), said: Number(/(\d+)곳\s*$/.exec(h.textContent)?.[1] ?? -1), n: lists ? n : -1 };
  });
  const seps = [...root.querySelectorAll(".sep")].map((p) => p.parentElement === root && p.previousElementSibling?.tagName === "UL" && p.nextElementSibling?.tagName === "UL").filter(Boolean).length;
  // a link the app cannot open: not https, or longer than the 2,048 characters an open message may carry
  const deadLinks = [...root.querySelectorAll("a[href]")].filter((a) => !a.href.startsWith("https://") || a.href.length > 2048).map((a) => `${a.textContent.trim().slice(0, 10)} ${a.href.length}`);
  const longestHref = Math.max(0, ...[...root.querySelectorAll("a[href]")].map((a) => a.href.length));
  // the summary's first line: 'N곳', or 'N곳 중 M곳' when the card had to leave rows out (its size cap)
  const lead = root.querySelector(".sum p, .sum")?.textContent.trim() ?? "";
  const cut = /전체\s*(\d+)곳\s*중\s*(\d+)곳/.exec(lead);
  const found = cut ? Number(cut[1]) : Number(/^(\d+)곳/.exec(lead)?.[1] ?? -1);
  const shownSaid = cut ? Number(cut[2]) : found;
  // the name's column beside the price: how narrow the price leaves it (a long price that never wraps squeezes it)
  const names = [...root.querySelectorAll("ul > li .t")].map((t) => ({ w: Math.round(t.getBoundingClientRect().width), t: t.textContent.slice(0, 12) }));
  const narrowest = names.reduce((a, x) => (!a || x.w < a.w ? x : a), null);
  return {
    narrowest,
    smallest,
    tiny: tiny.slice(0, 4),
    text3,
    accent,
    inText3: inText3.slice(0, 4),
    inAccent: inAccent.slice(0, 4),
    rows: rows.length,
    links,
    lowest: Math.round(lowest * 10) / 10,
    bad: bad.slice(0, 4),
    badCount: bad.length,
    heads,
    seps,
    seen: root.querySelectorAll(".sep").length,
    deadLinks: deadLinks.slice(0, 4),
    deadCount: deadLinks.length,
    longestHref,
    lead: lead.slice(0, 60),
    found,
    shownSaid,
    cut: !!cut,
  };
};

/**
 * WebKit's page memory: RSS of the WebContent and GPU processes this browser started (ps, by age since launch; another
 * WebKit run started in the same seconds could be counted too, so it is a note, never a check). Chrome runs as the
 * installed Google Chrome, whose renderers cannot be told from other Chrome windows: its JS heap is noted instead.
 */
let launchedAt = 0;
function procMem(engine) {
  if (engine !== "webkit") return null;
  const r = spawnSync("ps", ["-axo", "pid=,rss=,etime=,comm="], { encoding: "utf8", maxBuffer: 1 << 26 });
  const age = (Date.now() - launchedAt) / 1000 + 2;
  const secs = (e) => e.split(/[-:]/).map(Number).reverse().reduce((a, v, i) => a + v * [1, 60, 3600, 86400][i], 0);
  const rows = (r.stdout || "").split("\n").map((l) => /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(l)).filter((m) => m && /ms-playwright\/webkit/.test(m[4]) && secs(m[3]) <= age);
  const mb = (re) => {
    const ms = rows.filter((m) => re.test(m[4]));
    return { n: ms.length, mb: Math.round(ms.reduce((a, m) => a + Number(m[2]), 0) / 1024) };
  };
  return { content: mb(/WebContent/), gpu: mb(/WebKit\.GPU/) };
}
const jsHeapMB = (page) => page.evaluate(() => (performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null)).catch(() => null);

/**
 * The sheet painted all the way down: from the top, one view at a time (up to 24 views spread over the whole card,
 * the last one at the end), a screenshot right after each scroll, cut into 120 px bands across the frame's visible
 * part; a band with no ink (no pixel far from the paper) is a tile left blank or a white screen.
 */
async function sheetPainted(page) {
  const dec = await page.context().newPage();
  try {
    const geo = await page.evaluate(() => {
      const b = document.querySelector(".sheet-root .sheet-body");
      b.scrollTop = 0;
      return { of: b.scrollHeight - b.clientHeight, view: b.clientHeight };
    });
    const stepPx = Math.max(200, geo.view - 40);
    const all = Math.ceil(geo.of / stepPx);
    const at = [...new Set([...Array.from({ length: Math.min(24, all + 1) }, (_, i) => Math.round((i * geo.of) / Math.max(1, Math.min(24, all + 1) - 1)))])];
    const blank = [];
    let bands = 0;
    for (const y of at) {
      const clip = await page.evaluate(async (y) => {
        const b = document.querySelector(".sheet-root .sheet-body");
        b.scrollTop = y;
        await new Promise((r) => requestAnimationFrame(r));
        const s = b.getBoundingClientRect();
        const f = document.querySelector(".sheet-root .hart-full iframe.hframe").getBoundingClientRect();
        const top = Math.max(s.top, f.top, 0);
        const bottom = Math.min(s.bottom, f.bottom, innerHeight);
        return { x: Math.round(f.left), y: Math.round(top), width: Math.round(f.width), height: Math.round(bottom - top), bg: getComputedStyle(document.querySelector(".sheet-root .hart-full") ?? b).backgroundColor };
      }, y);
      if (clip.height < 120) continue;
      const png = await page.screenshot({ clip: { x: clip.x, y: clip.y, width: clip.width, height: clip.height }, scale: "css" });
      const r = await dec.evaluate(async (b64) => {
        const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        const img = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
        const c = new OffscreenCanvas(img.width, img.height);
        const g = c.getContext("2d");
        g.drawImage(img, 0, 0);
        const d = g.getImageData(0, 0, img.width, img.height).data;
        const lum = (i) => 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
        // the paper: the first pixel (the frame's left padding)
        const paper = lum(0);
        const out = [];
        for (let y0 = 0; y0 + 120 <= img.height; y0 += 120) {
          let ink = 0;
          for (let y = y0; y < y0 + 120; y++) for (let x = 0; x < img.width; x++) if (Math.abs(lum((y * img.width + x) * 4) - paper) > 60) ink++;
          out.push(ink);
        }
        return { w: img.width, h: img.height, bands: out };
      }, png.toString("base64"));
      bands += r.bands.length;
      r.bands.forEach((ink, i) => ink < 20 && blank.push({ y, band: i, ink }));
    }
    return { views: at.length, bands, blank: blank.slice(0, 6), blankCount: blank.length };
  } finally {
    await dec.close();
  }
}

/** a link's URL as the bar shows it (the frame sends the browser's href: punycode host, %-encoded path) */
const hrefOf = (raw) => new URL(raw.replaceAll("&amp;", "&")).href;

async function rows(pass, ctx) {
  const { page } = pass;
  const light = pass.variant !== "dark";
  for (const s of ROWS) {
    await page.evaluate(() => localStorage.removeItem("pickle.htmlArtifactHeights"));
    await showTurn(pass, ctx, turnOf(ctx.mainId, s));
    await page.evaluate(() => {
      const card = document.querySelector(".hart");
      card.closest(".screen-scroll").scrollTop += card.getBoundingClientRect().top - 88;
    });
    await sleep(400);
    const frame = await frameOf(page.locator(FRAME).first());
    const content = await contentH(frame);
    const box = await cardBox(page);
    const capPx = Math.round(box.vh * CAP);
    const more = await page.evaluate(() => {
      const m = document.querySelector(".hart .hart-more");
      const b = m?.querySelector("button");
      const r = b?.getBoundingClientRect();
      const hit = r ? document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) : null;
      return m ? { fade: getComputedStyle(m).backgroundImage, onTop: !!hit?.closest(".hart-more button"), bottom: Math.round(r.bottom), composer: Math.round(document.querySelector(".composer")?.getBoundingClientRect().top ?? 0) } : null;
    });
    pass.check(
      `rows: ${s.file} stops at 70% under the fade, 전체 화면 on top and above the composer`,
      Math.abs(box.h - capPx) <= 1 && content > capPx && /gradient/.test(more?.fade ?? "") && more.onTop && more.bottom <= more.composer,
      { card: box.h, cap: capPx, content, more },
    );
    const kb = Buffer.byteLength(s.html) / 1024;
    if (kb > 150) {
      const err = await page.evaluate(() => document.querySelector(".hart")?.textContent.includes("내용이 너무 커서") ?? true);
      pass.check(`rows: ${s.file} a ${kb.toFixed(1)} KB card (over the model's 150 KB) draws whole, no size error`, !err && content > capPx && !!(await frame.evaluate(() => document.querySelector("#m-root h2")?.textContent)), { kb: Math.round(kb * 10) / 10, content, err });
    }
    const f = await frame.evaluate(ROWS_FACTS);
    const total = f.heads.reduce((n, h) => n + h.n, 0);
    pass.note(`rows: ${s.file} narrowest name beside its price`, f.narrowest);
    pass.check(`rows: ${s.file} type 13 px and up`, f.smallest >= 13 && f.tiny.length === 0, { smallest: f.smallest, tiny: f.tiny });
    const c = await frame.evaluate(CONTRAST);
    pass.check(
      `rows: ${s.file} every text clears AA, none in --text-3${light ? ", the frame's light --accent is #0066cc" : ""}`,
      c.low.length === 0 && f.inText3.length === 0 && (!light || f.accent === "rgb(0, 102, 204)"),
      { worst: c.worst, low: c.low, text3: f.inText3, accentUse: f.inAccent, accent: f.accent },
    );
    const over = await frame.evaluate(FRAME_OVERFLOW);
    const fit = await frame.evaluate(FRAME_CLIPPED);
    pass.check(
      `rows: ${s.file} nothing sideways or cut off (long names, prices and links wrap in their rows)`,
      over.doc <= 0 && over.offenders.length === 0 && fit.clipped.length === 0 && fit.widest <= fit.vw,
      { doc: over.doc, offenders: over.offenders, clipped: fit.clipped, widest: fit.widest, vw: fit.vw },
    );
    pass.check(`rows: ${s.file} every link row is one tap area, the whole row, 44 px and up`, f.links > 0 && f.badCount === 0, { links: f.links, rows: f.rows, lowest: f.lowest, bad: f.bad, badCount: f.badCount });
    pass.check(
      `rows: ${s.file} each region's head says its rows; the summary counts every row found (${s.sent}) and says the rows shown`,
      f.heads.length > 0 && f.heads.every((h) => h.said === h.n) && f.found === s.sent && f.shownSaid === total && total === f.rows,
      { heads: f.heads.filter((h) => h.said !== h.n).slice(0, 4), groups: f.heads.length, total, lead: f.lead },
    );
    // every region the rows came in is on the card; every row found is a row on it (all its links), unless the card
    // had to leave rows out (rows-max past 300 KB, rows-tall and rows-cut past the height estimate: '전체 N곳 중 M곳', each
    // region kept)
    pass.check(
      s.cut ? `rows: ${s.file} past a cap (size or height): every region kept (${s.groups}), the summary says ${s.sent} found and the rows shown` : `rows: ${s.file} every row found is on the card (${s.sent} rows, ${s.links} links), every region (${s.groups})`,
      f.heads.length === s.groups && (s.cut ? f.cut && total < s.sent : !f.cut && total === s.sent && f.links === s.links),
      { shown: total, links: f.links, sent: s.sent, regions: f.heads.length, cut: f.cut, lead: f.lead, groups: f.heads.map((h) => `${h.g} ${h.n}`).join(", ").slice(0, 160) },
    );
    pass.check(
      `rows: ${s.file} every link opens (https, ≤ 2048 characters); a '다른 기준 가격' line sits between two lists, never a row`,
      f.deadCount === 0 && f.seps === f.seen,
      { dead: f.deadLinks, deadCount: f.deadCount, longestHref: f.longestHref, seps: f.seen },
    );
    // nothing found is hidden: the line after the card says the count, and a cut card's line names every place it left
    // off (none of them on the card; the card's names and these together are every row found)
    const said = await page.evaluate(() => document.querySelector(".msg-asst .asst-text")?.textContent ?? "");
    const left = /카드에 못 담은 곳: (.*)\.\s*$/.exec(said)?.[1].split(", ") ?? [];
    const named = await frame.evaluate((left) => {
      const on = new Set([...document.querySelectorAll("#m-root ul > li .t > b")].map((b) => b.textContent.trim()));
      return { on: on.size, leftOn: left.filter((n) => on.has(n)).slice(0, 3), all: new Set([...on, ...left]).size };
    }, left);
    pass.check(
      s.cut ? `rows: ${s.file} the line after the card says ${s.sent} found, ${total} on the card, and names the ${s.sent - total} left off` : `rows: ${s.file} the line after the card says all ${s.sent} are on it`,
      s.cut
        ? said.includes(`카드에 전체 ${s.sent}곳 중 ${total}곳을 담았어요`) && left.length === s.sent - total && named.leftOn.length === 0 && named.all === s.sent
        : said.includes(`카드에 ${s.sent}곳 전부 정리했어요.`) && left.length === 0,
      { line: said.replace(/^.*?(카드에)/s, "$1").slice(0, 70), left: left.length, ...named },
    );
    await pass.shot(`rows-${s.file}-card`);
    await pass.shotEl(`rows-card-${s.file}`, page.locator(".hart").first());

    // its first link, tapped at the row's far corner (the row is the link): the bar comes up above the composer
    const first = frame.locator('ul > li > a[href^="https://"]').first();
    const fb = await first.boundingBox();
    const want1 = hrefOf(await first.getAttribute("href"));
    await first.click({ position: { x: Math.max(4, fb.width - 6), y: Math.max(4, fb.height - 6) } });
    await page.waitForSelector(CARD_BAR, { timeout: 4000 }).catch(() => {});
    await sleep(200);
    const b1 = await barState(page, CARD_BAR);
    pass.check(`rows: ${s.file} its first row, tapped at its far corner, asks in the bar above the composer`, b1?.host === `외부 사이트 열기 · ${new URL(want1).host}` && b1.url === want1 && b1.seen, b1 && [b1.host, b1.url?.slice(0, 60), b1.seen]);
    await pass.shot(`rows-${s.file}-card-link`);
    await page.keyboard.press("Escape");
    await page.locator(CARD_BAR).waitFor({ state: "detached", timeout: 3000 }).catch(() => {});

    const mem = { card: { ...procMem(pass.engine), heap: await jsHeapMB(page) } };
    await framesStart(page);
    const t0 = Date.now();
    await page.locator(".hart .hart-more button").click();
    await page.waitForSelector(`${SHEET_FRAME}[data-ready]`, { timeout: 10_000 });
    const ready = Date.now() - t0;
    await sleep(pass.variant === "reduced" ? 400 : 1100);
    const opening = await framesStop(page);
    mem.open = { ...procMem(pass.engine), heap: await jsHeapMB(page) };
    const sframe = await frameOf(page.locator(SHEET_FRAME));
    const full = await contentH(sframe);
    const frameH = await page.locator(SHEET_FRAME).evaluate((el) => parseFloat(el.style.height));
    pass.check(`rows: ${s.file} the sheet holds the whole card at its height`, Math.abs(frameH - full) <= 1 && full >= content - 60, `${frameH} vs ${full} · ready in ${ready} ms`);
    await pass.shot(`rows-${s.file}-sheet-top`);
    const steps = await page.evaluate(async () => {
      const b = document.querySelector(".sheet-root .sheet-body");
      const gaps = [];
      for (let i = 0; i < 400 && b.scrollTop < b.scrollHeight - b.clientHeight - 1; i++) {
        const t = performance.now();
        b.scrollTop += 420;
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        gaps.push(Math.round(performance.now() - t));
      }
      const sorted = [...gaps].sort((x, y) => x - y);
      return { n: gaps.length, max: sorted.at(-1) ?? 0, p95: sorted[Math.floor(sorted.length * 0.95)] ?? 0, over: gaps.filter((g) => g > 100).length, end: Math.round(b.scrollTop), of: b.scrollHeight - b.clientHeight };
    });
    // at the end of the sheet's own scroll the card's last row is in view (the frame is never scrolled inside)
    const lastRow = await sframe.evaluate(() => {
      const r = [...document.querySelectorAll("#m-root ul > li")].at(-1).getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, inner: Math.round(document.scrollingElement.scrollTop) };
    });
    const view = await page.evaluate(() => {
      const f = document.querySelector(".sheet-root .hart-full iframe.hframe").getBoundingClientRect();
      const b = document.querySelector(".sheet-root .sheet-body").getBoundingClientRect();
      return { frameTop: f.top, top: b.top, bottom: b.bottom };
    });
    // (its end: a row taller than the view still ends in it)
    const lastSeen = lastRow.inner === 0 && view.frameTop + lastRow.bottom >= view.top && view.frameTop + lastRow.bottom <= view.bottom + 1;
    pass.check(`rows: ${s.file} the sheet scrolls to the end in steps (two frames ≤ 100 ms each), the last row in view`, steps.end >= steps.of - 1 && steps.over === 0 && lastSeen, { ...steps, lastSeen, lastBottom: Math.round(view.frameTop + lastRow.bottom), bodyBottom: Math.round(view.bottom) });
    mem.scrolled = { ...procMem(pass.engine), heap: await jsHeapMB(page) };
    const painted = await sheetPainted(page);
    pass.check(`rows: ${s.file} the sheet is painted top to bottom (no blank tile or white view, ${frameH} px)`, painted.bands > 0 && painted.blankCount === 0, painted);
    await page.evaluate(() => {
      const b = document.querySelector(".sheet-root .sheet-body");
      b.scrollTop = b.scrollHeight;
    });
    await sleep(200);
    await pass.shot(`rows-${s.file}-sheet-bottom`);
    const last = sframe.locator('ul > li > a[href^="https://"]').last();
    const wantN = hrefOf(await last.getAttribute("href"));
    await last.click();
    await page.waitForSelector(".sheet-root .hlink", { timeout: 4000 }).catch(() => {});
    await sleep(300);
    const b2 = await barState(page, ".sheet-root .hlink");
    pass.check(`rows: ${s.file} its last row asks in the sheet's bar`, b2?.host === `외부 사이트 열기 · ${new URL(wantN).host}` && b2.url === wantN && b2.seen, b2 && [b2.host, b2.url?.slice(0, 60), b2.seen]);
    await pass.shot(`rows-${s.file}-sheet-link`);
    await page.keyboard.press("Escape");
    await sleep(300);
    await framesStart(page);
    await closeSheet(page);
    await sleep(pass.variant === "reduced" ? 300 : 700);
    const closing = await framesStop(page);
    mem.closed = { ...procMem(pass.engine), heap: await jsHeapMB(page) };
    pass.note(`rows: ${s.file} memory (WebKit: WebContent and GPU RSS MB; Chrome: JS heap MB)`, mem);
    const back = await page.evaluate(() => getComputedStyle(document.querySelector(".hart")).opacity);
    pass.check(
      `rows: ${s.file} opening and closing the sheet drop no frame past 100 ms (the card comes back)`,
      opening.max <= 100 && closing.max <= 100 && back === "1",
      { open: opening, close: closing, ready },
    );
  }

  // 320 wide (iPhone SE's zoomed view): the sheet leaves 244 px of content, under the 256 a card's height estimate is
  // made at. The two cut by that estimate are the tallest cards the code draws: the frame holds each whole, under its
  // 100,000 px, and the end of the sheet's scroll shows the last row
  if (WIDTH > 320) {
    await page.setViewportSize({ width: 320, height: 844 });
    try {
      for (const s of ROWS.filter((r) => r.file === "rows-tall" || r.file === "rows-cut")) {
        await page.evaluate(() => localStorage.removeItem("pickle.htmlArtifactHeights"));
        await showTurn(pass, ctx, turnOf(ctx.mainId, s));
        await page.evaluate(() => {
          const card = document.querySelector(".hart");
          card.closest(".screen-scroll").scrollTop += card.getBoundingClientRect().top - 88;
        });
        await sleep(300);
        await page.locator(".hart .hart-more button").click();
        await page.waitForSelector(`${SHEET_FRAME}[data-ready]`, { timeout: 10_000 });
        await sleep(pass.variant === "reduced" ? 400 : 1100);
        const sframe = await frameOf(page.locator(SHEET_FRAME));
        const whole = await contentH(sframe);
        const frameH = await page.locator(SHEET_FRAME).evaluate((el) => parseFloat(el.style.height));
        const inner = await sframe.evaluate(() => {
          const root = document.getElementById("m-root");
          const cs = getComputedStyle(root);
          return Math.round(root.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight));
        });
        await page.evaluate(() => {
          const b = document.querySelector(".sheet-root .sheet-body");
          b.scrollTop = b.scrollHeight;
        });
        await sleep(300);
        const lastRow = await sframe.evaluate(() => [...document.querySelectorAll("#m-root ul > li")].at(-1).getBoundingClientRect().bottom);
        const view = await page.evaluate(() => {
          const f = document.querySelector(".sheet-root .hart-full iframe.hframe").getBoundingClientRect();
          const b = document.querySelector(".sheet-root .sheet-body").getBoundingClientRect();
          return { frameTop: f.top, top: b.top, bottom: b.bottom };
        });
        const bottom = view.frameTop + lastRow;
        const lastSeen = bottom >= view.top && bottom <= view.bottom + 1;
        pass.check(
          `rows: ${s.file} at 320 wide (${inner} px of content, the estimate's 256 or less) the frame holds the whole card under 100,000 px, and the sheet's end shows its last row`,
          inner <= 256 && Math.abs(frameH - whole) <= 1 && whole < 100_000 && lastSeen,
          { inner, frameH, whole, lastSeen, lastBottom: Math.round(bottom), bodyBottom: Math.round(view.bottom) },
        );
        await pass.shot(`rows-${s.file}-320-sheet-bottom`);
        await closeSheet(page);
        await sleep(300);
      }
    } finally {
      await page.setViewportSize({ width: WIDTH, height: 844 });
    }
  }
}

async function cap(pass, ctx) {
  const { page } = pass;
  const s = sample("travel-timeline"); // taller than the cap
  // first view (no remembered height): the card grows on the spring, or at once under reduced motion
  await page.evaluate(() => localStorage.removeItem("pickle.htmlArtifactHeights"));
  ctx.items = turnOf(ctx.mainId, s);
  await page.reload({ waitUntil: "load" });
  await page.waitForSelector(`${FRAME}[data-ready]`, { timeout: 15_000 });
  const grow = await page.evaluate(
    () =>
      new Promise((res) => {
        const el = document.querySelector(".hart");
        const out = [];
        let n = 0;
        const tick = () => {
          out.push(Math.round(el.getBoundingClientRect().height));
          if (++n < 4) requestAnimationFrame(tick);
          else res(out);
        };
        requestAnimationFrame(tick);
      }),
  );
  await sleep(pass.variant === "reduced" ? 300 : 1200);
  const box = await cardBox(page);
  const capPx = Math.round(box.vh * CAP);
  if (pass.variant === "reduced") pass.check("cap: under reduced motion the card takes its height at once", grow.every((h) => Math.abs(h - capPx) <= 1), grow.join(","));
  else pass.check("cap: the card grows to its height on the spring", grow[0] < capPx - 4 && grow.some((h, i) => i && h > grow[0]), grow.join(","));
  const frame = await frameOf(page.locator(FRAME).first());
  const content = await contentH(frame);
  pass.check("cap: a page taller than 70% of the screen stops at 70%", Math.abs(box.h - capPx) <= 1 && content > capPx, `${box.h} (cap ${capPx}, content ${content})`);
  // the whole card in view, its bottom above the composer
  await page.evaluate(() => {
    const card = document.querySelector(".hart");
    card.closest(".screen-scroll").scrollTop += card.getBoundingClientRect().top - 88;
  });
  await sleep(400);
  const more = await page.evaluate(() => {
    const m = document.querySelector(".hart .hart-more");
    const b = m?.querySelector("button");
    if (!b) return null;
    const r = b.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    const probe = document.createElement("span");
    probe.style.color = "var(--surface)";
    document.body.appendChild(probe);
    const surface = getComputedStyle(probe).color;
    probe.remove();
    return { fade: getComputedStyle(m).backgroundImage, surface, label: b.textContent.trim(), aria: b.getAttribute("aria-label"), h: Math.round(r.height), w: Math.round(r.width), onTop: !!hit?.closest(".hart-more button") };
  });
  pass.check("cap: the bottom fades into --bg (the card's paper) under 전체 화면", !!more && /gradient/.test(more.fade) && more.fade.includes(more.surface.replace(/\)$/, "")), more && `${more.fade} · ${more.surface}`);
  pass.check("cap: 전체 화면 is 44 pt, named for the page, on top (not under the composer)", !!more && more.label === "전체 화면" && more.aria === `${s.title} 전체 화면으로 보기` && more.h >= 44 && more.w >= 44 && more.onTop, more);
  await pass.shot("cap-trip");
}

async function full(pass, ctx) {
  const { page } = pass;
  const s = sample("travel-timeline");
  await showTurn(pass, ctx, turnOf(ctx.mainId, s));
  await page.evaluate(() => {
    const card = document.querySelector(".hart");
    card.closest(".screen-scroll").scrollTop += card.getBoundingClientRect().top - 88;
  });
  await sleep(400);
  const cardFrame = await frameOf(page.locator(FRAME).first());
  const cardLead = await firstText(cardFrame);
  await page.locator(".hart .hart-more button").click();
  const early = await page.evaluate(
    () =>
      new Promise((res) => {
        requestAnimationFrame(() => {
          const panel = document.querySelector(".sheet-root .sheet-panel");
          const card = document.querySelector(".hart");
          const c = card.getBoundingClientRect();
          const p = panel?.getBoundingClientRect();
          const clip = panel ? getComputedStyle(panel).clipPath : "none";
          // inset(t r b l) in px (1–4 values), then the visible box
          const n = (/inset\(([^)]*?)(?:round|\))/.exec(clip)?.[1] ?? "").trim().split(/\s+/).filter(Boolean).map(parseFloat);
          const [t, r, b, l] = n.length === 1 ? [n[0], n[0], n[0], n[0]] : n.length === 2 ? [n[0], n[1], n[0], n[1]] : n.length === 3 ? [n[0], n[1], n[2], n[1]] : n;
          const vis = p && n.length ? { w: Math.round(p.width - r - l), h: Math.round(p.height - t - b) } : null;
          res({ clip, card: card.style.opacity, cardW: Math.round(c.width), cardH: Math.round(c.height), panelW: p ? Math.round(p.width) : 0, vis });
        });
      }),
  );
  if (pass.variant === "reduced") pass.check("full: under reduced motion the sheet is simply there (no morph, the card stays)", early.card === "" && (!early.vis || early.vis.w >= early.panelW - 1), early);
  else pass.check("full: the sheet morphs out of the card (starts clipped to the card's width, the card hidden under it)", early.card === "0" && !!early.vis && Math.abs(early.vis.w - early.cardW) <= 6 && early.vis.w < early.panelW - 4, early);
  await page.waitForSelector(`${SHEET_FRAME}[data-ready]`, { timeout: 10_000 });
  await sleep(pass.variant === "reduced" ? 300 : 1100);
  const sheet = await page.evaluate(() => {
    const root = document.querySelector(".sheet-root");
    const f = root.querySelector(".hart-full iframe");
    return { title: root.querySelector(".sheet-title")?.textContent?.trim(), sandbox: f.getAttribute("sandbox"), frameH: parseFloat(f.style.height), label: f.title };
  });
  const frame = await frameOf(page.locator(SHEET_FRAME));
  const content = await contentH(frame);
  pass.check("full: the sheet carries the page's title and the same sandboxed frame", sheet.title === s.title && sheet.label === s.title && sheet.sandbox === "allow-scripts", sheet);
  pass.check("full: the whole page at its own height (the sheet scrolls, not the frame)", Math.abs(sheet.frameH - content) <= 1 && content > 0.7 * 844, `${sheet.frameH} vs ${content}`);
  const lead = await firstText(frame);
  pass.check("full: the title is said once (the sheet's bar; the page's own first heading repeating it is left out)", cardLead.startsWith(s.title) && !lead.startsWith(s.title), `${cardLead.slice(0, 20)} → ${lead.slice(0, 20)}`);
  const nonce = /'nonce-([^']+)'/.exec((await page.locator(".sheet-root .hart-full iframe").getAttribute("srcdoc")) ?? "")?.[1];
  ctx.nonces.push(nonce);
  pass.check("full: each frame gets its own nonce", !!nonce && new Set(ctx.nonces).size === ctx.nonces.length, ctx.nonces.length);
  await pass.shot("full-top");
  // a real tap on the 출처 row at the bottom (Playwright scrolls the sheet to it)
  await frame.locator('a[href="https://www.visitjeju.net/kr"] span').click();
  await page.waitForSelector(".sheet-root .hlink[data-placement=sheet]", { timeout: 4000 });
  await sleep(450);
  const bar = await barState(page, ".sheet-root .hlink");
  const body = await page.evaluate(() => {
    const r = (document.querySelector(".sheet-root .sheet-body") ?? document.querySelector(".sheet-root .sheet-panel")).getBoundingClientRect();
    return { top: Math.round(r.top), bottom: Math.round(Math.min(r.bottom, innerHeight)) };
  });
  pass.check("full: a link in the sheet asks in a bar inside the sheet's view", bar?.host === "외부 사이트 열기 · www.visitjeju.net" && bar.top >= body.top && bar.bottom <= body.bottom + 1, { bar, body });
  await pass.shot("full-link");
  await page.keyboard.press("Escape");
  await sleep(500);
  pass.check("full: Esc closes the bar, not the sheet", (await page.locator(".sheet-root .hlink").count()) === 0 && (await page.locator(".sheet-root").count()) === 1);
  await closeSheet(page);
  const after = await page.locator(".hart").first().evaluate((el) => el.style.opacity);
  pass.check("full: closing gives the card back", after === "" || after === "1", after);
}

async function long(pass, ctx) {
  const { page } = pass;
  await showTurn(pass, ctx, turn(ctx.mainId, "qa-html-long", "클리닉 60곳 다 보여 줘", "60곳이에요."));
  const t0 = Date.now();
  await page.locator(".hart .hart-more button").click();
  await page.waitForSelector(`${SHEET_FRAME}[data-ready]`, { timeout: 10_000 });
  const ready = Date.now() - t0;
  await sleep(pass.variant === "reduced" ? 300 : 1100);
  const frame = await frameOf(page.locator(SHEET_FRAME));
  const content = await contentH(frame);
  const frameH = await page.locator(SHEET_FRAME).evaluate((f) => parseFloat(f.style.height));
  pass.check("long: 60 rows in the sheet at their full height", content > 4000 && Math.abs(frameH - content) <= 1, `${frameH} vs ${content} · ready in ${ready} ms`);
  // scroll the sheet down in steps (as a finger would); then the last row is live
  const steps = await page.evaluate(async () => {
    const b = document.querySelector(".sheet-root .sheet-body");
    const out = [];
    for (let i = 0; i < 12; i++) {
      const t = performance.now();
      b.scrollTop += 420;
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      out.push(Math.round(performance.now() - t));
    }
    return { gaps: out, end: Math.round(b.scrollTop), max: b.scrollHeight - b.clientHeight };
  });
  const last = frame.locator("a").last();
  await last.locator("b").click();
  await page.waitForSelector(".sheet-root .hlink", { timeout: 4000 }).catch(() => {});
  const bar = await barState(page, ".sheet-root .hlink");
  pass.check("long: the sheet scrolls to the last row, and that row asks like the first", !!bar && /^외부 사이트 열기 · .+\.example\.com$/.test(bar.host), { steps, host: bar?.host });
  pass.check("long: two frames per scroll step stay under 100 ms", steps.gaps.every((g) => g < 100), steps.gaps.join(","));
  await pass.shot("long-sheet-bottom");
  await page.keyboard.press("Escape");
  await sleep(300);
  await closeSheet(page);
}

async function wheel(pass, ctx) {
  const { page } = pass;
  // a turn above the card so the chat has room to scroll up
  ctx.items = [...turnOf(ctx.mainId, sample("week-schedule")), ...turnOf(ctx.mainId, sample("dc-thread")).map((m) => ({ ...m, id: `${m.id}-2` }))];
  await page.reload({ waitUntil: "load" });
  await page.waitForFunction(() => document.querySelectorAll(".hart iframe.hframe[data-ready]").length === 2, null, { timeout: 15_000 });
  await sleep(800);
  const sc = () => page.evaluate(() => document.querySelector(".hart").closest(".screen-scroll").scrollTop);
  const before = await sc();
  const r = await page.locator(".hart").last().boundingBox();
  await page.mouse.move(r.x + r.width / 2, Math.min(r.y + 120, 600));
  await page.mouse.wheel(0, -500);
  await sleep(700);
  const after = await sc();
  await page.mouse.move(1, 1);
  pass.check("wheel: scrolling over the card scrolls the chat (the frame never traps it)", after < before - 100, `${before} → ${after}`);
}

async function theme(pass, ctx) {
  const { page } = pass;
  const s = sample("week-schedule");
  await showTurn(pass, ctx, turnOf(ctx.mainId, s));
  const frame = await frameOf(page.locator(FRAME).first());
  await frame.evaluate(() => (window.__qaMark = 1));
  await page.emulateMedia({ colorScheme: "dark" });
  await page.waitForFunction(() => document.documentElement.dataset.theme === "dark", null, { timeout: 4000 }).catch(() => {});
  await sleep(700);
  const app = await page.evaluate(() => ({ theme: document.documentElement.dataset.theme, surface: getComputedStyle(document.documentElement).getPropertyValue("--surface").trim() }));
  const inner = await frame.evaluate(() => ({ mark: window.__qaMark, theme: document.documentElement.dataset.theme, scheme: getComputedStyle(document.documentElement).colorScheme, bg: getComputedStyle(document.documentElement).getPropertyValue("--bg").trim() }));
  pass.check("theme: the OS goes dark → the frame follows without reloading", app.theme === "dark" && inner.mark === 1 && inner.theme === "dark" && inner.scheme === "dark" && inner.bg === app.surface, { app, inner });
  await frameCard(page);
  await pass.shot("theme-live-dark");
  await page.emulateMedia({ colorScheme: "light" });
  await page.waitForFunction(() => document.documentElement.dataset.theme === "light", null, { timeout: 4000 }).catch(() => {});
  await sleep(500);
}

async function security(pass, ctx) {
  const { page } = pass;
  const reqs = [];
  const onReq = (r) => /qa-remote/.test(r.url()) && !pass.cspWindow && reqs.push(r.url());
  page.on("request", onReq);
  try {
    await showTurn(pass, ctx, turn(ctx.mainId, "qa-html-hostile", "보안 점검 페이지 보여 줘", "점검용 페이지예요."));
    await sleep(1500); // a meta refresh (0 s) would have fired by now
    const frameEl = page.locator(FRAME).first();
    const frame = await frameOf(frameEl);
    const r = await frame.evaluate(() => {
      const all = [...document.querySelectorAll("*")];
      const handlers = all.flatMap((el) => [...el.attributes].filter((a) => /^on|^data-m-on/i.test(a.name)).map((a) => `${el.localName}[${a.name}]`));
      const css = [...document.styleSheets].map((s) => {
        try {
          return [...s.cssRules].map((x) => x.cssText).join("\n");
        } catch {
          return "";
        }
      });
      const styleAttrs = all.map((el) => el.getAttribute("style") ?? "").join("\n");
      const href = (id) => document.getElementById(id)?.getAttribute("href") ?? null;
      return {
        url: location.href,
        pwned: window.__pwned ?? null,
        scripts: document.scripts.length,
        handlers,
        gone: ["iframe", "object", "embed", "base", "link", "form", "noscript", "template", 'meta[http-equiv="refresh" i]'].filter((s) => document.querySelector(s)),
        metas: [...document.querySelectorAll("meta")].map((m) => m.getAttribute("http-equiv") || m.getAttribute("name") || m.getAttribute("charset")),
        hrefs: Object.fromEntries(["qa-js", "qa-data", "qa-hash", "qa-http", "qa-mail", "qa-tel", "qa-idn", "qa-area"].map((id) => [id, href(id)])),
        remoteCss: /qa-remote/.test(css.join("\n") + styleAttrs),
        noimg: [...document.querySelectorAll(".m-noimg")].map((s) => s.textContent),
        dataImg: document.querySelectorAll('img[src^="data:image/png"]').length,
        imgs: document.querySelectorAll("img").length,
        tall: Math.round(document.querySelector(".tall")?.getBoundingClientRect().height ?? -1),
        text: document.querySelector("h2")?.textContent,
      };
    });
    pass.check("security: the page still renders its own content", r.text === "보안 점검 페이지", r.text);
    pass.check("security: no model script ran (<script>, onerror, svg onload, javascript:, mXSS)", r.pwned === null && r.scripts === 1, `${r.pwned} · ${r.scripts} script(s)`);
    pass.check("security: no on* handler survived", r.handlers.length === 0, r.handlers.join(" "));
    pass.check("security: meta refresh, base, link, form, iframe, object, embed are gone", r.gone.length === 0 && r.metas.join() === "Content-Security-Policy,utf-8,viewport", `${r.gone.join(" ")} · metas ${r.metas.join(",")}`);
    const h = r.hrefs;
    pass.check("security: only https links keep an href (javascript:, data:, #, http:, mailto:, tel: lose it)", ["qa-js", "qa-data", "qa-hash", "qa-http", "qa-mail", "qa-tel"].every((k) => h[k] === null) && /^https:/.test(h["qa-idn"] ?? "") && h["qa-area"] === "https://example.com/area", h);
    pass.check("security: remote images become their alt text; data: images stay", r.noimg.join() === "원격 이미지" && r.dataImg === 1 && r.imgs === 1, { noimg: r.noimg, imgs: r.imgs });
    pass.check("security: no remote url() / @import / image-set left in CSS", !r.remoteCss);
    pass.check("security: 100vh cannot grow the frame (vh is the app's viewport)", r.tall > 0 && r.tall <= 120, r.tall);
    pass.check("security: autofocus does not steal focus", (await page.evaluate(() => document.activeElement?.localName)) !== "iframe", await page.evaluate(() => document.activeElement?.localName));
    pass.check("security: after 1.5 s the frame is still about:srcdoc (meta refresh dead)", r.url === "about:srcdoc", r.url);

    // the form's button (unwrapped: no form), links that lost their href
    for (const id of ["qa-submit", "qa-js", "qa-hash", "qa-http", "qa-mail", "qa-tel"]) await frame.locator(`#${id}`).click();
    await sleep(500);
    const quiet = await page.locator(CARD_BAR).count();
    const fu = await where(frame);
    pass.check("security: submit and every non-https link do nothing (no bar, no navigation)", quiet === 0 && fu === "about:srcdoc" && (await frame.evaluate(() => window.__pwned ?? null)) === null, `${quiet} bar(s) · ${fu}`);
    // an IDN look-alike: the bar names it in punycode
    await frame.locator("#qa-idn b").click();
    await page.waitForSelector(CARD_BAR, { timeout: 3000 }).catch(() => {});
    const idn = await barState(page, CARD_BAR);
    pass.check("security: a look-alike domain shows as xn-- punycode (host and URL)", idn?.host === "외부 사이트 열기 · xn--80ak6aa92e.com" && idn.url === "https://xn--80ak6aa92e.com/login", idn && [idn.host, idn.url]);
    await pass.shot("security-idn");
    await page.keyboard.press("Escape");
    await sleep(300);
    await frame.evaluate(() => document.getElementById("qa-area").click());
    await page.waitForSelector(CARD_BAR, { timeout: 3000 }).catch(() => {});
    const area = await page.locator(`${CARD_BAR} .hlink-url`).textContent().catch(() => null);
    pass.check("security: an image-map <area> link is caught like <a> (asks, never navigates the frame)", area === "https://example.com/area" && (await where(frame)) === "about:srcdoc", area);
    await page.keyboard.press("Escape");
    await sleep(300);

    // the second wall alone: inject past the sanitiser → the CSP refuses (these console lines are expected)
    pass.cspWindow = true;
    await frame.evaluate((remote) => {
      const s = document.createElement("script");
      s.textContent = "window.__pwned2 = 'csp'";
      document.body.appendChild(s);
      const i = new Image();
      i.src = `${remote}/qa-remote/csp.png`;
      document.body.appendChild(i);
      const st = document.createElement("div");
      st.style.background = `url(${remote}/qa-remote/csp-bg.png)`;
      st.style.height = "2px";
      document.body.appendChild(st);
    }, BASE);
    await sleep(900);
    pass.cspWindow = false;
    const csp = await frame.evaluate(() => window.__pwned2 ?? null);
    pass.check("security: past the sanitiser, the CSP still refuses a script and remote loads", csp === null, csp);
    pass.check("security: nothing asked for /qa-remote (no browser request from the page; the CSP probe's attempts never reached the server)", ctx.remoteHits.length === 0 && reqs.length === 0, [...ctx.remoteHits, ...reqs].join(" "));

    // forged messages: from the app window itself, then from the frame with a wrong channel, bad heights, bad links
    const before = await cardBox(page);
    const ch = await frame.evaluate(() => document.documentElement.dataset.ch);
    await page.evaluate((ch) => window.postMessage({ ch, type: "height", h: 5 }, "*"), ch);
    await frame.evaluate((ch) => {
      parent.postMessage({ ch: "nope", type: "height", h: 7 }, "*");
      parent.postMessage({ ch, type: "height", h: "9" }, "*");
      parent.postMessage({ ch, type: "height", h: Number.NaN }, "*");
      parent.postMessage({ ch, type: "height", h: Number.POSITIVE_INFINITY }, "*");
      for (const href of ["javascript:alert(1)", "http://example.com/x", "mailto:a@example.com", "tel:1", "data:text/html,x", `https://example.com/${"x".repeat(3000)}`]) parent.postMessage({ ch, type: "open", href }, "*");
      parent.postMessage({ ch: "nope", type: "open", href: "https://example.com/" }, "*");
    }, ch);
    await sleep(500);
    const mid = await cardBox(page);
    pass.check("security: forged messages change nothing (wrong window, wrong channel, non-numbers, non-https links)", Math.abs(mid.h - before.h) <= 0.5 && mid.frameH === before.frameH && (await page.locator(CARD_BAR).count()) === 0, { before, mid });
    await frame.evaluate((ch) => parent.postMessage({ ch, type: "height", h: 1e9 }, "*"), ch);
    await sleep(pass.variant === "reduced" ? 300 : 1000);
    const huge = await cardBox(page);
    pass.check("security: a huge height is clamped (frame ≤ 100000 px, card ≤ 70%)", huge.frameH === 100_000 && huge.h <= Math.round(huge.vh * CAP) + 1, huge);
    // the edge of the clamp: under it a height is taken as sent (rounded), at it and over it the frame stops at 100000
    const edge = [];
    for (const h of [99_999, 99_999.6, 100_000, 100_000.4, 100_001, 1e6]) {
      await frame.evaluate(([ch, h]) => parent.postMessage({ ch, type: "height", h }, "*"), [ch, h]);
      await sleep(250);
      edge.push([h, (await cardBox(page)).frameH]);
    }
    const wantEdge = [99_999, 100_000, 100_000, 100_000, 100_000, 100_000];
    pass.check("security: at the clamp's edge (99999 → 99999, 99999.6 / 100000 / 100000.4 / 100001 / 1e6 → 100000)", edge.every(([, got], i) => got === wantEdge[i]), edge);
    await frame.evaluate((ch) => parent.postMessage({ ch, type: "height", h: Math.ceil(document.getElementById("m-root").getBoundingClientRect().height) }, "*"), ch);
    await sleep(500);
    await frameCard(page);
    await pass.shot("security-hostile");
  } finally {
    page.off("request", onReq);
    pass.cspWindow = false;
  }
}

async function big(pass, ctx) {
  const { page } = pass;
  await showTurn(pass, ctx, turn(ctx.mainId, "qa-html-big", "아주 긴 표 보여 줘", "표가 길어요."), { wait: false });
  await page.waitForSelector(".hart[data-state=error]", { timeout: 10_000 }).catch(() => {});
  const r = await page.evaluate(() => ({ text: document.querySelector(".hart .hart-error")?.textContent?.trim(), frames: document.querySelectorAll(".hart iframe").length }));
  pass.check("big: over 300 KB → a Korean error, no frame", r.text === "내용이 너무 커서 여기에 보여 드릴 수 없어요." && r.frames === 0, r);
  const edge = {};
  for (const id of ["qa-html-mid", "qa-html-cap", "qa-html-cap1"]) {
    await showTurn(pass, ctx, turn(ctx.mainId, id, "표 보여 줘", "표예요."), { wait: false });
    await page.waitForSelector(".hart[data-state=error], .hart iframe.hframe[data-ready]", { timeout: 15_000 }).catch(() => {});
    edge[id] = await page.evaluate(() => ({ error: !!document.querySelector(".hart .hart-error"), frame: !!document.querySelector(".hart iframe.hframe[data-ready]") }));
  }
  pass.check(
    "big: 160 KB and exactly 300 KB draw (a '전부' card's size), 300 KB + 1 byte is refused",
    edge["qa-html-mid"].frame && !edge["qa-html-mid"].error && edge["qa-html-cap"].frame && !edge["qa-html-cap"].error && edge["qa-html-cap1"].error && !edge["qa-html-cap1"].frame,
    edge,
  );
}

async function placeholder(pass, ctx) {
  const { page } = pass;
  const s = sample("product-compare"); // under the cap, so the height is its own
  // seen once (its height is remembered) …
  await showTurn(pass, ctx, turnOf(ctx.mainId, s));
  const seen = await cardBox(page);
  // … then the reply comes back with its artifact 1.5 s late
  ctx.artDelay = 1500;
  ctx.items = turnOf(ctx.mainId, s);
  await page.reload({ waitUntil: "load" });
  await page.waitForSelector(".hart[data-state=loading]", { timeout: 10_000 });
  await sleep(200);
  const loading = await page.evaluate(() => {
    const c = document.querySelector(".hart");
    return { h: Math.round(c.getBoundingClientRect().height * 10) / 10, skel: !!c.querySelector(".hart-skel[role=status]"), busy: c.getAttribute("aria-busy") };
  });
  const shiftsBefore = await page.evaluate(() => window.__qa?.shifts.length ?? 0);
  await page.waitForSelector(`${FRAME}[data-ready]`, { timeout: 10_000 });
  await sleep(pass.variant === "reduced" ? 300 : 900);
  ctx.artDelay = 0;
  const ready = await cardBox(page);
  pass.check("placeholder: while loading, the card holds the height it had (skeleton, aria-busy)", loading.skel && loading.busy === "true" && Math.abs(loading.h - seen.h) <= 1, `${loading.h} vs ${seen.h}`);
  pass.check("placeholder: the page lands in the same box (no jump)", Math.abs(ready.h - loading.h) <= 1, `${loading.h} → ${ready.h}`);
  if (pass.engine === "chromium") {
    const cls = await page.evaluate((n) => (window.__qa?.shifts ?? []).slice(n).reduce((a, e) => a + e.v, 0), shiftsBefore);
    pass.check("placeholder: no layout shift when the page arrives (Chrome layout-shift)", cls < 0.001, cls.toFixed(4));
  }
}

async function archive(pass, ctx) {
  const { page } = pass;
  const records = SAMPLES.map((s) => ART.get(s.id));
  const listRe = /\/api\/artifacts(\?.*)?$/;
  const blobRe = /\/api\/blobs\/[^/?]+/;
  const attRe = /\/api\/attachments(\?.*)?$/;
  await page.route(listRe, (r) => (r.request().method() === "GET" ? r.fulfill({ json: records }) : r.fallback()));
  await page.route(blobRe, (r) => {
    const id = decodeURIComponent(new URL(r.request().url()).pathname.split("/").pop());
    const a = ART.get(id);
    return a ? r.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: a.content }) : r.fallback();
  });
  await page.route(attRe, (r) => (r.request().method() === "GET" ? r.fulfill({ json: [] }) : r.fallback()));
  try {
    await page.click("#tab-archive");
    await page.waitForSelector(".screen-scroll .arc-card", { timeout: 10_000 });
    await sleep(700);
    const list = await page.evaluate(() =>
      [...document.querySelectorAll(".arc-card")].map((c) => ({ title: c.querySelector(".arc-card__title")?.textContent, meta: c.querySelector(".arc-card__meta")?.textContent ?? "", preview: c.querySelector(".arc-card__preview")?.textContent ?? "" })),
    );
    pass.check("archive: 문서 lists the pages with meta '페이지 · …'", list.length === SAMPLES.length && list.every((c) => c.meta.startsWith("페이지 · ")), list.map((c) => c.meta).join(" | "));
    pass.check("archive: previews are the page's words (no tags, no CSS, not the title again)", list.length === SAMPLES.length && list.every((c) => c.preview.length > 10 && !/[<>{}]/.test(c.preview) && !c.preview.startsWith(c.title)), list.map((c) => c.preview.slice(0, 40)).join(" | "));
    await pass.shot("archive-list");
    const s = sample("travel-timeline");
    await page.locator(".arc-card", { hasText: s.title }).click();
    await page.waitForSelector(`${SHEET_FRAME}[data-ready]`, { timeout: 10_000 });
    await sleep(pass.variant === "reduced" ? 300 : 1100);
    const f = await page.locator(".sheet-root .hart-full iframe").evaluate((el) => ({ sandbox: el.getAttribute("sandbox"), title: el.title, h: parseFloat(el.style.height) }));
    pass.check("archive: the document sheet draws the same sandboxed frame at full height", f.sandbox === "allow-scripts" && f.title === s.title && f.h > 0.7 * 844, f);
    const frame = await frameOf(page.locator(SHEET_FRAME));
    const lead = await firstText(frame);
    pass.check("archive: the sheet says the title once", !lead.startsWith(s.title), lead.slice(0, 30));
    await pass.shot("archive-sheet");
    await frame.locator('a[href="https://astro.kasi.re.kr/life/pageView/9"] b').click();
    await page.waitForSelector(".sheet-root .hlink", { timeout: 4000 }).catch(() => {});
    const bar = await barState(page, ".sheet-root .hlink");
    pass.check("archive: links there ask too", bar?.host === "외부 사이트 열기 · astro.kasi.re.kr", bar?.host);
    await page.keyboard.press("Escape");
    await sleep(300);
    await closeSheet(page);
  } finally {
    await page.unroute(listRe);
    await page.unroute(blobRe);
    await page.unroute(attRe);
    await page.click("#tab-chat").catch(() => {});
    await sleep(500);
  }
}

// ── run ──

const results = { at: new Date().toISOString(), api: API, passes: [] };
const app = await startApp();
let failed = 0;
try {
  for (const engine of ENGINES) {
    launchedAt = Date.now();
    const browser = engine === "webkit" ? await webkit.launch() : await chromium.launch({ channel: "chrome" });
    for (const variant of VARIANTS) {
      console.log(`\n── ${engine} · ${variant}`);
      const a = await signupApi(`qa${rand()}h`, "하늘", "모시");
      // the daily briefing (07:30 KST) must not race the scenarios
      await api("PATCH", "/api/settings", { notifications: { briefing: false } }, a.token);
      const sess = (await api("GET", "/api/session", undefined, a.token)).body;
      const mainId = sess?.mainThreadId ?? sess?.session?.mainThreadId;
      if (!mainId) throw new Error("no main thread");
      const ctxOpts = { viewport: { width: WIDTH, height: 844 }, deviceScaleFactor: 3, isMobile: false, hasTouch: false, colorScheme: variant === "dark" ? "dark" : "light", reducedMotion: variant === "reduced" ? "reduce" : "no-preference", locale: "ko-KR", timezoneId: "Asia/Seoul" };
      const context = await browser.newContext(ctxOpts);
      // init scripts run in every frame: the artifact frames are sandboxed (no storage, opaque origin), so top only
      await context.addInitScript((t) => window === window.top && localStorage.setItem("pickle.token", t), a.token);
      await context.addInitScript(INIT);
      // every https request (열기 on a page's link) is answered here: nothing leaves the machine
      await context.route(/^https:\/\//, (r) => r.fulfill({ status: 200, contentType: "text/plain; charset=utf-8", body: "qa stub" }));
      const page = await context.newPage();
      const pass = new Pass(engine, variant, page);
      const ctx = { mainId, items: [], artDelay: 0, csp: app.csp, remoteHits: app.remoteHits, nonces: [] };
      await page.route(/\/api\/threads\/[^/]+\/messages(\?.*)?$/, (r) => {
        const req = r.request();
        const id = decodeURIComponent(new URL(req.url()).pathname.split("/")[3]);
        if (id !== mainId || req.method() !== "GET") return r.fallback();
        return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(ctx.items) });
      });
      await page.route(/\/api\/artifacts\/[^/?]+(\?.*)?$/, async (r) => {
        const id = decodeURIComponent(new URL(r.request().url()).pathname.split("/").pop());
        const art = ART.get(id);
        if (!art || r.request().method() !== "GET") return r.fallback();
        if (ctx.artDelay) await sleep(ctx.artDelay);
        return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(art) }).catch(() => {});
      });
      page.on("console", (m) => {
        if (m.type() !== "error") return;
        if ((pass.cspWindow && /Content Security Policy|Refused to/i.test(m.text())) || pass.expectRe?.test(m.text())) pass.expected.push(m.text().slice(0, 160));
        else pass.errors.push(`${m.text()} @ ${m.location()?.url || "?"}:${m.location()?.lineNumber ?? "?"}`);
      });
      page.on("pageerror", (e) => (pass.expectRe?.test(e.message) ? pass.expected.push(e.message.slice(0, 160)) : pass.errors.push(`pageerror: ${e.message}`)));
      await page.goto(BASE + "/");
      await page.waitForSelector("#tab-chat", { timeout: 20_000 });
      await sleep(800);
      const steps = [
        ["inline", inline],
        ["links", links],
        ["cap", cap],
        ["full", full],
        ["long", long],
        ["wheel", wheel],
        ["theme", variant === "light" ? theme : null],
        ["security", security],
        ["big", big],
        ["placeholder", placeholder],
        ["archive", archive],
        ["llm", llm],
        ["deep", deep],
        ["rows", rows],
      ];
      for (const [name, fn] of steps) {
        if (!want(name) || !fn) continue;
        try {
          await fn(pass, ctx);
        } catch (e) {
          pass.check(`${name}: scenario ran`, false, e.message.split("\n")[0]);
          await page.screenshot({ path: path.join(outDir, `hart-${pass.tag}-error-${name}.png`) }).catch(() => {});
          await page.keyboard.press("Escape").catch(() => {});
          await closeSheet(page).catch(() => {});
          ctx.artDelay = 0;
        }
      }
      const r = {
        engine,
        variant,
        checks: pass.checks,
        notes: pass.notes,
        failed: pass.checks.filter((c) => !c.ok).map((c) => c.name),
        consoleErrors: pass.errors,
        expectedErrors: pass.expected,
        overflow: pass.overflows,
        screenshots: pass.shots.length,
      };
      results.passes.push(r);
      failed += r.failed.length + r.consoleErrors.length + r.overflow.length;
      console.log(`  checks ${r.checks.length - r.failed.length}/${r.checks.length} · console errors ${r.consoleErrors.length} · overflow ${r.overflow.length} · expected refusals ${r.expectedErrors.length} · shots ${r.screenshots}`);
      for (const e of r.consoleErrors) console.log(`    console: ${e.slice(0, 200)}`);
      for (const o of r.overflow) console.log(`    overflow: ${JSON.stringify(o).slice(0, 240)}`);
      await context.close();
    }
    await browser.close();
  }
} finally {
  app.server.close();
  app.server.closeAllConnections?.();
}
fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(results, null, 2));
const total = results.passes.reduce((n, p) => n + p.checks.length, 0);
const ok = results.passes.reduce((n, p) => n + p.checks.filter((c) => c.ok).length, 0);
console.log(`\n${ok}/${total} checks · ${failed ? `${failed} problem(s)` : "all clean"} → ${path.relative(repo, outDir)}/results.json`);
process.exit(failed ? 1 : 0);
