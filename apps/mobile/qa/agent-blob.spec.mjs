// AgentBlob edge quality + cost (three/AgentBlob.tsx: MSAA at every size, DPR ≤ 1.5 below 160 px and ≤ 2 from it). Isolated server only (never
// 8787 / 5173). From the repo root:
//   node apps/mobile/qa/agent-blob.spec.mjs <before-dist> <after-dist> [runs=3]
// Env: QA_API (default http://127.0.0.1:8797) · QA_PORTS (previews, default 5201,5202) · QA_PAIRS_ONLY=1 (re-compose).
// For each build, Chrome (channel "chrome", fake media devices) and WebKit at 390×844 @3x:
//   - onboarding (logged out, 208 px character) and the call screen (208 px) → a 3× crop of the character into
//     docs/qa/agent-blob/<label>-<engine>-<screen>.png, and side-by-side pairs <engine>-<screen>.png (before | after);
//   - the WebGL renderer and the canvas backing size (to show which DPR / MSAA path ran).
// Chrome at 4× CPU, interleaved before/after `runs` times: the call screen with the character animating (fake mic level
// → amplitude), 5 s of rAF intervals (p50 / p95 / max, frames over 25 ms), main-thread task time per second, draw calls
// (proof the character really animated in the window) and the character's GPU time per frame (EXT_disjoint_timer_query
// around each three.js render: clear → end of the synchronous render; the compositor's MSAA resolve is not in it).
// The agent sheet's 120 px character is checked too (DPR ≤ 1.5, with MSAA).
// Results: docs/qa/agent-blob/results.json. Never runs `playwright install`; never opens a real camera or mic.
import { chromium, webkit } from "playwright";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, "..");
const outDir = path.resolve(appDir, "../../docs/qa/agent-blob");
// both builds up front, before anything is spawned: run without them (e.g. picked up by a directory-wide `bun test`,
// which matches *.spec.*) this throws and leaves nothing behind
const dists = process.argv.slice(2, 4);
if (!process.env.QA_PAIRS_ONLY && (dists.length < 2 || !dists.every((d) => fs.existsSync(path.join(d, "index.html")))))
  throw new Error("usage: node apps/mobile/qa/agent-blob.spec.mjs <before-dist> <after-dist> [runs] — two built apps (each with index.html)");
fs.mkdirSync(outDir, { recursive: true });
const [beforeDist, afterDist] = dists.map((p) => path.resolve(p));
const RUNS = Number(process.argv[4] || 3);
const API = process.env.QA_API || "http://127.0.0.1:8797";
if (/:(8787|5173)\b/.test(API)) throw new Error("QA_API points at the live preview");
const [PA, PB] = (process.env.QA_PORTS || "5201,5202").split(",").map(Number);
const CHROME_ARGS = ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** init script: counts draws and times each three.js render on the GPU (Chrome exposes the timer; WebKit does not) */
function gpuProbe() {
  const P = (window.__blobProbe = { draws: 0, gpuNs: [], disjoint: 0, timer: null });
  const G = WebGL2RenderingContext.prototype;
  const draw = G.drawElements;
  G.drawElements = function (...a) {
    P.draws++;
    return draw.apply(this, a);
  };
  const pending = [];
  const clear = G.clear;
  G.clear = function (...a) {
    const ext = this.__timer === undefined ? (this.__timer = this.getExtension("EXT_disjoint_timer_query_webgl2")) : this.__timer;
    P.timer = !!ext;
    if (ext && !this.__q) {
      const q = this.createQuery();
      this.beginQuery(ext.TIME_ELAPSED_EXT, q);
      this.__q = q;
      queueMicrotask(() => {
        this.endQuery(ext.TIME_ELAPSED_EXT);
        pending.push([this, q, ext]);
        this.__q = null;
      });
    }
    return clear.apply(this, a);
  };
  const poll = () => {
    for (let i = pending.length - 1; i >= 0; i--) {
      const [gl, q, ext] = pending[i];
      if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) continue;
      if (gl.getParameter(ext.GPU_DISJOINT_EXT)) P.disjoint++;
      else P.gpuNs.push(gl.getQueryParameter(q, gl.QUERY_RESULT));
      gl.deleteQuery(q);
      pending.splice(i, 1);
    }
    requestAnimationFrame(poll);
  };
  requestAnimationFrame(poll);
}

async function text(url) {
  try {
    return await (await fetch(url)).text();
  } catch {
    return null;
  }
}

/** a preview that provably serves `dist` (ports on this Mac are shared with other QA runs) */
async function serve(dist, port, label) {
  if ((await text(`http://127.0.0.1:${port}/`)) !== null) throw new Error(`port ${port} is already serving something; set QA_PORTS`);
  const html = fs.readFileSync(path.join(dist, "index.html"), "utf8");
  const proc = spawn("bunx", ["vite", "preview", "--outDir", dist, "--port", String(port), "--strictPort", "--host", "127.0.0.1"], { cwd: appDir, stdio: "ignore", detached: true, env: { ...process.env, PICKLE_API: API } });
  for (let i = 0; i < 100; i++) {
    if ((await text(`http://127.0.0.1:${port}/`)) === html) return { label, base: `http://127.0.0.1:${port}`, stop: () => process.kill(-proc.pid, "SIGTERM") };
    await sleep(150);
  }
  try {
    process.kill(-proc.pid, "SIGTERM");
  } catch {
    /* gone */
  }
  throw new Error(`${label} preview did not start serving ${dist}`);
}

async function signup() {
  const kp = await crypto.webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const jwk = await crypto.webcrypto.subtle.exportKey("jwk", kp.publicKey);
  const res = await fetch(`${API}/api/auth/signup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      handle: `qablob${crypto.randomBytes(3).toString("hex")}`,
      password: "qa-pass-1234",
      displayName: "하늘",
      agentName: "깽이",
      device: { id: `qa-${crypto.randomBytes(3).toString("hex")}`, label: "QA", signingKey: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y } },
    }),
  });
  if (!res.ok) throw new Error(`signup ${res.status}`);
  return (await res.json()).token;
}

async function newPage(engine, token, probe = false) {
  const browser = await (engine === "webkit" ? webkit : chromium).launch(engine === "webkit" ? {} : { channel: "chrome", args: CHROME_ARGS });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, colorScheme: "dark", locale: "ko-KR" });
  if (token) await context.addInitScript((t) => localStorage.setItem("pickle.token", t), token);
  if (probe) await context.addInitScript(gpuProbe);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  return { browser, context, page, errors };
}

/** the character's canvas once drawn; null when the SVG poster stayed (no hardware WebGL2) */
async function blobCanvas(page, scope) {
  const sel = `${scope} canvas`;
  const ok = await page.waitForSelector(sel, { timeout: 12_000 }).then(() => true).catch(() => false);
  if (!ok) return null;
  await sleep(1800); // fade in on `fade`, a few frames
  return page.locator(sel).first();
}

async function info(page, canvas) {
  return canvas.evaluate((c) => {
    const gl = c.getContext("webgl2") || c.getContext("webgl");
    const ext = gl?.getExtension("WEBGL_debug_renderer_info");
    return {
      css: Math.round(c.getBoundingClientRect().width),
      backing: `${c.width}×${c.height}`,
      msaaSamples: gl ? gl.getParameter(gl.SAMPLES) : null,
      renderer: gl ? String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)) : null,
    };
  });
}

async function crop(page, canvas, file) {
  const b = await canvas.boundingBox();
  await page.screenshot({ path: file, clip: { x: b.x - 6, y: b.y - 6, width: b.width + 12, height: b.height + 12 } });
}

async function openCall(page, base) {
  await page.goto(`${base}/`, { waitUntil: "load" });
  await page.waitForSelector(".composer", { timeout: 20_000 });
  await sleep(1500);
  await page.getByRole("button", { name: "통화하기" }).click();
  await page.waitForSelector(".call-card", { timeout: 10_000 });
}

async function shots(server, engine, token) {
  const out = { label: server.label, engine };
  {
    const { browser, page, errors } = await newPage(engine, null);
    await page.goto(`${server.base}/`, { waitUntil: "load" });
    await page.waitForSelector(".onb", { timeout: 20_000 });
    const c = await blobCanvas(page, ".onb");
    if (c) {
      out.onboarding = await info(page, c);
      await crop(page, c, path.join(outDir, `${server.label}-${engine}-onboarding.png`));
    } else out.onboarding = { canvas: false };
    out.onboardingErrors = errors;
    await browser.close();
  }
  {
    const { browser, page, errors } = await newPage(engine, token);
    await openCall(page, server.base);
    const c = await blobCanvas(page, ".call-card");
    if (c) {
      out.call = await info(page, c);
      await crop(page, c, path.join(outDir, `${server.label}-${engine}-call.png`));
    } else out.call = { canvas: false };
    out.callErrors = errors;
    await browser.close();
  }
  {
    // the agent sheet's 120 px character: MSAA, but DPR stays ≤ 1.5
    const { browser, page } = await newPage(engine, token);
    await page.goto(`${server.base}/`, { waitUntil: "load" });
    await page.waitForSelector(".composer", { timeout: 20_000 });
    await sleep(1500);
    await page.locator(".tb-center").click();
    const c = await blobCanvas(page, ".agent-sheet-hero");
    out.sheet = c ? await info(page, c) : { canvas: false };
    if (c) await crop(page, c, path.join(outDir, `${server.label}-${engine}-sheet.png`));
    await browser.close();
  }
  return out;
}

async function frameTime(server, token) {
  const { browser, context, page } = await newPage("chromium", token, true);
  await openCall(page, server.base);
  const c = await blobCanvas(page, ".call-card");
  await page.mouse.move(195, 300); // fresh input: the character keeps breathing through the window (§8.16 10 s rule)
  const cdp = await context.newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  await cdp.send("Performance.enable");
  await sleep(1000);
  const m0 = Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map((m) => [m.name, m.value]));
  const p0 = await page.evaluate(() => ({ draws: window.__blobProbe.draws, n: window.__blobProbe.gpuNs.length }));
  const gaps = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const g = [];
        let prev = 0;
        const t0 = performance.now();
        const step = (t) => {
          if (prev) g.push(t - prev);
          prev = t;
          if (t - t0 < 5000) requestAnimationFrame(step);
          else resolve(g);
        };
        requestAnimationFrame(step);
      }),
  );
  const m1 = Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map((m) => [m.name, m.value]));
  await sleep(300); // the last queries resolve
  const p1 = await page.evaluate((n) => ({ draws: window.__blobProbe.draws, gpuNs: window.__blobProbe.gpuNs.slice(n), disjoint: window.__blobProbe.disjoint, timer: window.__blobProbe.timer }), p0.n);
  // the call's level as drawn on the island's dots (the card has no level bar: the character takes the value)
  const level = await page.evaluate(() => document.querySelector(".island-anchor[data-kind=call] .island-dots")?.style.getPropertyValue("--lvl") ?? null);
  await browser.close();
  const s = [...gaps].sort((a, b) => a - b);
  const q = (p) => +s[Math.min(s.length - 1, Math.floor(s.length * p))].toFixed(1);
  const gs = p1.gpuNs.map((ns) => ns / 1e6).sort((a, b) => a - b);
  const gq = (p) => (gs.length ? +gs[Math.min(gs.length - 1, Math.floor(gs.length * p))].toFixed(3) : null);
  return { canvas: !!c, renders: gs.length, drawsPerSec: Math.round((p1.draws - p0.draws) / 5.3), gpuMsP50: gq(0.5), gpuMsP95: gq(0.95), gpuTimer: p1.timer, disjoint: p1.disjoint, frames: gaps.length, p50: q(0.5), p95: q(0.95), max: +s[s.length - 1].toFixed(1), over25ms: gaps.filter((x) => x > 25).length, taskMsPerSec: +(((m1.TaskDuration - m0.TaskDuration) * 1000) / ((m1.Timestamp - m0.Timestamp) || 5)).toFixed(1), callLevel: level };
}

/** before | after side by side, at the crops' own 3× pixels */
async function pairs() {
  const browser = await chromium.launch({ channel: "chrome" });
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
  const made = [];
  for (const engine of ["chromium", "webkit"]) {
    for (const screen of ["onboarding", "call", "sheet"]) {
      const files = ["before", "after"].map((l) => path.join(outDir, `${l}-${engine}-${screen}.png`));
      if (!files.every((f) => fs.existsSync(f))) continue;
      const src = files.map((f) => `data:image/png;base64,${fs.readFileSync(f).toString("base64")}`);
      await page.setContent(
        `<style>body{margin:0}main{display:inline-flex;gap:16px;padding:16px;background:#000;color:#ddd;font:600 22px -apple-system,sans-serif}figure{margin:0}figcaption{margin:0 0 8px}img{display:block}</style><main>` +
          src.map((s, i) => `<figure><figcaption>${i ? (screen === "sheet" ? "이후 (MSAA, DPR ≤ 1.5)" : "이후 (MSAA, DPR ≤ 2)") : "이전 (DPR ≤ 1.5, AA 없음)"} · ${engine} · ${screen} · 3×</figcaption><img src="${s}"></figure>`).join("") + "</main>",
      );
      const file = path.join(outDir, `${engine}-${screen}.png`);
      await page.locator("main").screenshot({ path: file });
      made.push(path.relative(path.resolve(appDir, "../.."), file));
    }
  }
  await browser.close();
  return made;
}

if (process.env.QA_PAIRS_ONLY) {
  console.log((await pairs()).join("\n"));
  process.exit(0);
}
const servers = [await serve(beforeDist, PA, "before"), await serve(afterDist, PB, "after")];
const results = { at: new Date().toISOString(), shots: [], frameTime: { before: [], after: [] } };
try {
  const token = await signup();
  for (const s of servers) for (const engine of ["chromium", "webkit"]) {
    const r = await shots(s, engine, token);
    results.shots.push(r);
    console.log(`${s.label} ${engine}: onboarding ${JSON.stringify(r.onboarding)} · call ${JSON.stringify(r.call)} · sheet ${JSON.stringify(r.sheet)}`);
  }
  for (let i = 0; i < RUNS; i++) for (const s of i % 2 ? [...servers].reverse() : servers) results.frameTime[s.label].push(await frameTime(s, token));
  const med = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  results.frameTimeMedian = Object.fromEntries(
    Object.entries(results.frameTime).map(([k, rs]) => [k, Object.fromEntries(["frames", "p50", "p95", "max", "over25ms", "taskMsPerSec", "renders", "drawsPerSec", "gpuMsP50", "gpuMsP95"].map((f) => [f, med(rs.map((r) => r[f]))]))]),
  );
  console.log(`call screen, Chrome 4× CPU, median of ${RUNS}: ${JSON.stringify(results.frameTimeMedian)}`);
  results.pairs = await pairs();
  console.log(results.pairs.join("\n"));
} finally {
  for (const s of servers) {
    try {
      s.stop();
    } catch {
      /* gone */
    }
  }
  fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(results, null, 2));
}
