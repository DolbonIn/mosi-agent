// Wallpaper QA (MOTION-SPEC §0 "Wallpaper"). Runs against an ISOLATED pickle server with a throwaway account — never
// the user's live preview (8787 / 5173). From the repo root:
//   PICKLE_DATA_DIR=$(mktemp -d) PORT=8797 PICKLE_AUDIO_PORT=8798 bun --env-file=<secrets without TWILIO_*> run apps/server/src/index.ts
//   bunx vite build --outDir /tmp/wp-dist                                   (in apps/mobile)
//   QA_DIST=/tmp/wp-dist QA_LABEL=after node apps/mobile/qa/wallpaper.spec.mjs
//   QA_LABEL=before QA_QUERY='?gl=force' …                                  (the old WebGL wallpaper, as hardware-GL phones saw it)
// Env: QA_API (default http://127.0.0.1:8797) · QA_PORT (preview, default 5193) · QA_DIST (built app, required)
//      QA_LABEL (file prefix) · QA_QUERY (appended to every URL) · QA_ENGINES (chromium,webkit) · QA_THEMES (light,dark)
//      QA_SEED (json with {token}; default <tmp>/pickle-wallpaper-seed.json, created on first run: sign-up + three real
//      turns + one document artifact + one empty thread) · QA_PERF=0 skips the throttled Chrome runs · QA_SHOTS=0 skips
//      the screenshots.
// Per engine × theme at 390×844 @2x (Chrome channel "chrome" with fake media devices, Playwright WebKit): chat with
// messages, empty thread (suggestions), archive, profile, drawer → docs/qa/wallpaper/raw/<label>-<engine>-<theme>-N-name.png,
// plus the measured contrast of glass labels against the pixels actually rendered behind them (text hidden, clip
// screenshot, every pixel). Chrome only: 3 cold loads at 4× CPU throttle (LCP, TBT, JS requested, three chunk
// requested?) and an idle window (rAF callbacks, running animations, canvases, main-thread task time).
// Re-tint (light theme, both engines + Chrome reduced motion): save a new agent colour on 나의 모시 → 모시 설정 and
// check the light re-tints once (a transition on .wallpaper-light only, or none under reduced motion) and then rests
// (no animation on the wallpaper after 1.2 s); the colour is restored through the API afterwards.
// Results: docs/qa/wallpaper/<label>-results.json. Never runs `playwright install`; never opens a real camera or mic.
import { chromium, webkit } from "playwright";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, "..");
const repo = path.resolve(appDir, "../..");
const outDir = path.join(repo, "docs/qa/wallpaper");
const rawDir = path.join(outDir, "raw");
fs.mkdirSync(rawDir, { recursive: true });
const API = process.env.QA_API || "http://127.0.0.1:8797";
if (/:(8787|5173)\b/.test(API)) throw new Error("QA_API points at the live preview — use an isolated server");
const PORT = Number(process.env.QA_PORT || 5193);
if (PORT === 5173 || PORT === 8787) throw new Error("QA_PORT is the live preview's port");
const BASE = `http://127.0.0.1:${PORT}`;
const DIST = process.env.QA_DIST;
const LABEL = process.env.QA_LABEL || "after";
const QUERY = process.env.QA_QUERY || "";
const ENGINES = (process.env.QA_ENGINES || "chromium,webkit").split(",");
const THEMES = (process.env.QA_THEMES || "light,dark").split(",");
const SEED = process.env.QA_SEED || path.join(os.tmpdir(), "pickle-wallpaper-seed.json");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CHROME_ARGS = ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"];

async function up(url, needle) {
  try {
    const r = await fetch(url);
    return r.ok && (!needle || (await r.text()).includes(needle));
  } catch {
    return false;
  }
}

async function startPreview() {
  if (!DIST || !fs.existsSync(path.join(DIST, "index.html"))) throw new Error("QA_DIST must point at a built app");
  if (!(await up(`${API}/api/health`))) throw new Error(`pickle server is not answering at ${API}`);
  if (await up(`${BASE}/`)) throw new Error(`port ${PORT} is already serving something; set QA_PORT`);
  const proc = spawn("bunx", ["vite", "preview", "--outDir", DIST, "--port", String(PORT), "--strictPort", "--host", "127.0.0.1"], {
    cwd: appDir,
    stdio: "ignore",
    detached: true,
    env: { ...process.env, PICKLE_API: API },
  });
  proc.stopAll = () => {
    try {
      process.kill(-proc.pid, "SIGTERM"); // our own process group only
    } catch {
      proc.kill();
    }
  };
  // ours, not another QA run's: the preview must serve exactly this dist's index.html
  const html = fs.readFileSync(path.join(DIST, "index.html"), "utf8");
  for (let i = 0; i < 100; i++) {
    try {
      if ((await (await fetch(`${BASE}/`)).text()) === html) return proc;
    } catch {
      /* not up yet */
    }
    await sleep(150);
  }
  proc.stopAll();
  throw new Error(`vite preview did not start serving ${DIST}`);
}

// ── throwaway account ──

async function api(method, p, body, token) {
  const res = await fetch(API + p, {
    method,
    headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const type = res.headers.get("content-type") || "";
  if (type.includes("text/event-stream")) return { status: res.status, body: await res.text() };
  return { status: res.status, body: type.includes("json") ? await res.json() : await res.text() };
}

async function seed() {
  if (fs.existsSync(SEED)) {
    const s = JSON.parse(fs.readFileSync(SEED, "utf8"));
    if ((await api("GET", "/api/session", undefined, s.token)).status === 200) return s;
  }
  const kp = await crypto.webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const jwk = await crypto.webcrypto.subtle.exportKey("jwk", kp.publicKey);
  const r = await api("POST", "/api/auth/signup", {
    handle: `qawp${crypto.randomBytes(3).toString("hex")}`,
    password: "qa-pass-1234",
    displayName: "하늘",
    agentName: "깽이",
    device: { id: `qa-${crypto.randomBytes(3).toString("hex")}`, label: "QA", signingKey: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y } },
  });
  if (r.status !== 201 && r.status !== 200) throw new Error(`signup ${r.status} ${JSON.stringify(r.body)}`);
  const token = r.body.token;
  const main = (await api("GET", "/api/session", undefined, token)).body.mainThreadId;
  const turns = [
    "이번 주말에 서울에서 가볼 만한 전시 두 곳만 짧게 추천해 줘. 도구 쓰지 말고 아는 범위에서 두 줄로.",
    "고마워. 토요일 오후 3시에 가려면 뭘 챙기면 좋을지 세 가지만 알려 줘. 도구 없이 짧게.",
    "주말 장보기 목록을 문서 아티팩트로 만들어 보관함에 저장해 줘. 질문 없이 바로 만들어 줘. 채소·과일·생활용품 세 칸으로 나누고 체크리스트(- [ ]) 형식으로 써 줘.",
  ];
  for (const text of turns) await api("POST", `/api/threads/${main}/messages`, { text }, token); // SSE: returns when the turn ends
  await api("POST", "/api/threads", { title: "새 대화" }, token);
  const s = { token, main };
  fs.writeFileSync(SEED, JSON.stringify(s), { mode: 0o600 });
  return s;
}

// ── measurements ──

/** contrast of a label against every pixel rendered behind it (text hidden, element-clip screenshot) */
async function labelContrast(page, selector) {
  const loc = page.locator(selector).first();
  if (!(await loc.count())) return null;
  const color = await loc.evaluate((el) => {
    const c = getComputedStyle(el).color;
    el.dataset.qaColor = el.style.color;
    el.style.setProperty("color", "transparent", "important");
    el.style.setProperty("-webkit-text-fill-color", "transparent", "important");
    return c;
  });
  await sleep(60);
  const box = await loc.boundingBox();
  const png = await page.screenshot({ clip: box, animations: "disabled" });
  await loc.evaluate((el) => {
    el.style.removeProperty("-webkit-text-fill-color");
    el.style.color = el.dataset.qaColor || "";
    delete el.dataset.qaColor;
  });
  const px = decodePng(png);
  const m = color.match(/[\d.]+/g).map(Number);
  const fg = [m[0], m[1], m[2]];
  const a = m.length > 3 ? m[3] : 1;
  const ratios = [];
  const bg = [0, 0, 0];
  for (let i = 0; i < px.data.length; i += px.channels) {
    const b = [px.data[i], px.data[i + 1], px.data[i + 2]];
    bg[0] += b[0];
    bg[1] += b[1];
    bg[2] += b[2];
    const f = fg.map((c, k) => c * a + b[k] * (1 - a));
    ratios.push(contrast(f, b));
  }
  ratios.sort((x, y) => x - y);
  const n = ratios.length;
  return {
    selector,
    text: color,
    bgMean: `rgb(${bg.map((c) => Math.round(c / n)).join(" ")})`,
    min: +ratios[0].toFixed(2),
    p5: +ratios[Math.floor(n * 0.05)].toFixed(2),
    median: +ratios[Math.floor(n / 2)].toFixed(2),
  };
}

const lin = (c) => ((c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const lum = (rgb) => 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
function contrast(a, b) {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

/** minimal PNG decoder (8-bit RGB/RGBA, non-interlaced — what Playwright writes) */
function decodePng(buf) {
  let off = 8;
  let w = 0;
  let h = 0;
  let type = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const kind = buf.toString("ascii", off + 4, off + 8);
    const body = buf.subarray(off + 8, off + 8 + len);
    if (kind === "IHDR") {
      w = body.readUInt32BE(0);
      h = body.readUInt32BE(4);
      type = body[9];
    } else if (kind === "IDAT") idat.push(body);
    else if (kind === "IEND") break;
    off += 12 + len;
  }
  const channels = type === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * channels;
  const out = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? out[y * stride + x - channels] : 0;
      const up = y ? out[(y - 1) * stride + x] : 0;
      const ul = y && x >= channels ? out[(y - 1) * stride + x - channels] : 0;
      let v = src[x];
      if (f === 1) v += left;
      else if (f === 2) v += up;
      else if (f === 3) v += (left + up) >> 1;
      else if (f === 4) {
        const p = left + up - ul;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - ul);
        v += pa <= pb && pa <= pc ? left : pb <= pc ? up : ul;
      }
      out[y * stride + x] = v & 255;
    }
  }
  return { w, h, channels, data: out };
}

const RAF_PROBE = `(() => {
  const orig = window.requestAnimationFrame.bind(window);
  const w = window;
  w.__raf = { on: false, n: 0, stacks: {} };
  window.requestAnimationFrame = function (cb) {
    const p = w.__raf;
    if (p.on) {
      p.n++;
      const st = (new Error().stack || "").split("\\n").slice(1, 4).join(" ").replace(/https?:\\/\\/[^/]+/g, "").slice(0, 200);
      p.stacks[st] = (p.stacks[st] || 0) + 1;
    }
    return orig(cb);
  };
})();`;

// ── screens ──

async function shoot(browserType, engine, theme, token) {
  const browser = await browserType.launch(engine === "chromium" ? { channel: "chrome", args: CHROME_ARGS } : {});
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: theme, locale: "ko-KR" });
  await context.addInitScript((t) => localStorage.setItem("pickle.token", t), token);
  const page = await context.newPage();
  const errors = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  const tag = `${LABEL}-${engine}-${theme}`;
  const shots = [];
  const shot = async (n, name) => {
    const file = path.join(rawDir, `${tag}-${n}-${name}.png`);
    await page.screenshot({ path: file });
    shots.push(path.relative(repo, file));
  };
  await page.goto(`${BASE}/${QUERY}`, { waitUntil: "load" });
  await page.waitForSelector(".bubble", { timeout: 20_000 });
  await sleep(3200); // startup effects (the old WebGL wallpaper fades in after load + reads + prefetch)
  const wallpaper = await page.evaluate(() => document.querySelector(".wallpaper")?.getAttribute("data-wallpaper") ?? null);
  await shot(1, "chat");
  const contrastOut = [];
  for (const sel of [".tb-name", ".tab-item:not([data-on]) .tab-label", ".tab-item[data-on] .tab-label"]) {
    const c = await labelContrast(page, sel);
    if (c) contrastOut.push({ screen: "chat", ...c });
  }
  await page.getByRole("button", { name: "메뉴" }).click();
  await page.waitForSelector(".dw");
  await sleep(1000);
  await shot(5, "drawer");
  await page.locator(".dw-row").filter({ hasText: "새 대화" }).first().click();
  await page.waitForSelector(".thread-empty", { timeout: 10_000 });
  await sleep(1000);
  await shot(2, "empty");
  for (const sel of [".tb-title", ".tb-name"]) {
    const c = await labelContrast(page, sel);
    if (c) {
      contrastOut.push({ screen: "empty", ...c });
      break;
    }
  }
  await page.getByRole("button", { name: "뒤로" }).click();
  await sleep(800);
  await page.click("#tab-archive");
  await sleep(1600);
  await shot(3, "archive");
  await page.click("#tab-profile");
  await sleep(1600);
  await shot(4, "profile");
  const c = await labelContrast(page, ".tab-item:not([data-on]) .tab-label");
  if (c) contrastOut.push({ screen: "profile", ...c });
  await browser.close();
  return { engine, theme, wallpaper, errors, shots, contrast: contrastOut };
}

// ── re-tint: the light moves only when the agent's colour changes, then rests ──

async function retint(browserType, engine, reduced, token) {
  const before = (await api("GET", "/api/agent", undefined, token)).body?.avatar;
  const browser = await browserType.launch(engine === "chromium" ? { channel: "chrome", args: CHROME_ARGS } : {});
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: "ko-KR", reducedMotion: reduced ? "reduce" : "no-preference" });
  await context.addInitScript((t) => localStorage.setItem("pickle.token", t), token);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  const light = () => page.evaluate(() => getComputedStyle(document.querySelector(".wallpaper-light")).backgroundColor);
  const wpAnims = () => page.evaluate(() => document.getAnimations().filter((a) => a.effect?.target?.closest?.(".wallpaper")).map((a) => a.transitionProperty || a.animationName || a.constructor.name));
  try {
    await page.goto(`${BASE}/${QUERY}`, { waitUntil: "load" });
    await page.waitForSelector(".bubble", { timeout: 20_000 });
    await page.click("#tab-profile");
    await page.waitForSelector(".profile-agent", { timeout: 10_000 });
    await sleep(800);
    await page.click(".profile-agent");
    await page.waitForSelector(".agent-hues", { timeout: 10_000 });
    await sleep(900);
    const from = await light();
    const target = (await page.locator('.agent-hue[aria-checked="false"]').count()) ? page.locator('.agent-hue[aria-checked="false"]').last() : null;
    await target.click();
    await page.getByRole("button", { name: "저장하기" }).click();
    await page.waitForFunction(() => document.querySelector(".wallpaper")?.style.getPropertyValue("--wp-hue") !== "", null, { timeout: 2000 }).catch(() => {});
    let during = [];
    const t0 = Date.now();
    while (Date.now() - t0 < 3000 && !during.length && (await light()) === from) {
      during = await wpAnims();
      await sleep(30);
    }
    if (!during.length) during = await wpAnims();
    await sleep(1300);
    const after = { color: await light(), anims: await wpAnims(), tintAnim: await page.evaluate(() => document.querySelector(".wallpaper")?.hasAttribute("data-tint-anim")) };
    const ok = after.color !== from && after.anims.length === 0 && !after.tintAnim && (reduced ? during.length === 0 : during.includes("background-color"));
    return { engine, reduced, from, to: after.color, during, after, errors, ok };
  } finally {
    await browser.close();
    if (before) await api("PATCH", "/api/agent", { avatar: before }, token);
  }
}

// ── Chrome: cold loads at 4× CPU throttle + idle window ──

function firstLoadJs() {
  const html = fs.readFileSync(path.join(DIST, "index.html"), "utf8");
  const files = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+\.js)"/g)].map((m) => m[1]);
  let raw = 0;
  let gz = 0;
  for (const f of new Set(files)) {
    const b = fs.readFileSync(path.join(DIST, f));
    raw += b.length;
    gz += zlib.gzipSync(b, { level: 9 }).length;
  }
  return { files: [...new Set(files)], rawKB: +(raw / 1024).toFixed(1), gzipKB: +(gz / 1024).toFixed(1) };
}

async function coldLoad(token) {
  const browser = await chromium.launch({ channel: "chrome", args: CHROME_ARGS });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: "ko-KR" });
  await context.addInitScript((t) => localStorage.setItem("pickle.token", t), token);
  await context.addInitScript(() => {
    const q = (window.__perf = { lcp: 0, long: [] });
    new PerformanceObserver((l) => l.getEntries().forEach((e) => (q.lcp = e.startTime))).observe({ type: "largest-contentful-paint", buffered: true });
    new PerformanceObserver((l) => l.getEntries().forEach((e) => q.long.push([e.startTime, e.duration]))).observe({ type: "longtask", buffered: true });
  });
  await context.addInitScript(RAF_PROBE);
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  await cdp.send("Performance.enable");
  await page.goto(`${BASE}/${QUERY}`, { waitUntil: "load" });
  await page.waitForSelector(".bubble", { timeout: 30_000 });
  await sleep(9000); // startup + idle-loaded effects settle (throttled)
  const r = await page.evaluate(() => {
    const q = window.__perf;
    const fcp = performance.getEntriesByName("first-contentful-paint")[0]?.startTime ?? 0;
    const tbt = q.long.filter(([s]) => s >= fcp).reduce((a, [, d]) => a + Math.max(0, d - 50), 0);
    const js = performance
      .getEntriesByType("resource")
      .filter((e) => /\.js(\?|$)/.test(e.name))
      .map((e) => ({ name: e.name.replace(/^https?:\/\/[^/]+/, ""), bytes: e.encodedBodySize }));
    const nav = performance.getEntriesByType("navigation")[0];
    const navJs = [...document.querySelectorAll('script[src], link[rel="modulepreload"]')].length;
    return { fcp, lcp: q.lcp, tbt, longTasks: q.long.length, js, navJs, canvases: document.querySelectorAll("canvas").length, wallpaper: document.querySelector(".wallpaper")?.getAttribute("data-wallpaper") ?? null, domContentLoaded: nav?.domContentLoadedEventEnd ?? 0 };
  });
  // idle window: 3 s with nothing happening (still throttled)
  const m0 = Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map((m) => [m.name, m.value]));
  const idle = await page.evaluate(async () => {
    const p = window.__raf;
    p.n = 0;
    p.stacks = {};
    p.on = true;
    await new Promise((res) => setTimeout(res, 3000));
    p.on = false;
    return { rafIn3s: p.n, rafStacks: Object.entries(p.stacks).sort((a, b) => b[1] - a[1]).slice(0, 3), animations: document.getAnimations().length };
  });
  const m1 = Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map((m) => [m.name, m.value]));
  idle.taskMsPerSec = +(((m1.TaskDuration - m0.TaskDuration) * 1000) / 3).toFixed(1);
  idle.scriptMsPerSec = +(((m1.ScriptDuration - m0.ScriptDuration) * 1000) / 3).toFixed(1);
  await browser.close();
  const three = r.js.filter((j) => /react-three-fiber|\/Wallpaper-|three/.test(j.name));
  return {
    fcp: Math.round(r.fcp),
    lcp: Math.round(r.lcp),
    tbt: Math.round(r.tbt),
    longTasks: r.longTasks,
    jsRequested: r.js.length,
    jsKB: +(r.js.reduce((a, j) => a + j.bytes, 0) / 1024).toFixed(1),
    threeRequested: three.map((j) => `${j.name} (${(j.bytes / 1024).toFixed(0)} KB)`),
    canvases: r.canvases,
    wallpaper: r.wallpaper,
    idle,
  };
}

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

// ── main ──

const server = await startPreview();
const results = { label: LABEL, query: QUERY, at: new Date().toISOString(), firstLoadJs: firstLoadJs(), passes: [], perf: null };
try {
  const { token } = await seed();
  for (const engine of process.env.QA_SHOTS === "0" ? [] : ENGINES) {
    for (const theme of THEMES) {
      const r = await shoot(engine === "webkit" ? webkit : chromium, engine, theme, token);
      results.passes.push(r);
      const worst = r.contrast.length ? Math.min(...r.contrast.map((c) => c.p5)) : null;
      console.log(`${LABEL} ${engine}/${theme}: wallpaper=${r.wallpaper} errors=${r.errors.length} shots=${r.shots.length} worst label contrast (p5)=${worst}`);
    }
  }
  if (process.env.QA_RETINT !== "0" && process.env.QA_SHOTS !== "0") {
    results.retint = [];
    for (const [bt, engine, reduced] of [[chromium, "chromium", false], [webkit, "webkit", false], [chromium, "chromium", true]]) {
      if (!ENGINES.includes(engine)) continue;
      const r = await retint(bt, engine, reduced, token);
      results.retint.push(r);
      console.log(`${LABEL} re-tint ${engine}${reduced ? " (reduced motion)" : ""}: ${r.ok ? "ok" : "FAIL"} · ${r.from} → ${r.to} · during [${r.during}] · after: anims [${r.after.anims}] tint-anim=${r.after.tintAnim}`);
    }
  }
  if (process.env.QA_PERF !== "0") {
    const runs = [];
    for (let i = 0; i < 3; i++) runs.push(await coldLoad(token));
    results.perf = {
      cpuThrottle: 4,
      runs,
      median: { fcp: median(runs.map((r) => r.fcp)), lcp: median(runs.map((r) => r.lcp)), tbt: median(runs.map((r) => r.tbt)), jsKB: median(runs.map((r) => r.jsKB)), idleRafIn3s: median(runs.map((r) => r.idle.rafIn3s)), idleTaskMsPerSec: median(runs.map((r) => r.idle.taskMsPerSec)) },
    };
    console.log(`${LABEL} perf (4× CPU, median of 3): ${JSON.stringify(results.perf.median)} three=${JSON.stringify(runs[0].threeRequested)} canvases=${runs[0].canvases}`);
  }
} finally {
  server.stopAll();
  fs.writeFileSync(path.join(outDir, `${LABEL}-results.json`), JSON.stringify(results, null, 2));
}
console.log(`first-load JS: ${results.firstLoadJs.gzipKB} KB gzip (${results.firstLoadJs.rawKB} KB raw) · results → docs/qa/wallpaper/${LABEL}-results.json`);
