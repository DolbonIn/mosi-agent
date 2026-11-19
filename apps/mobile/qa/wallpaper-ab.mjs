// Wallpaper A/B: interleaved cold loads in Chrome at 4× CPU — the old build (?gl=force, the WebGL wallpaper as
// hardware-GL phones ran it) vs the new one, alternating so both see the same machine load. Isolated server only.
//   node apps/mobile/qa/wallpaper-ab.mjs <before-dist> <after-dist> <seed.json from wallpaper.spec.mjs> [runs=6]
// Prints medians (FCP, LCP, TBT, JS requested, three chunk requested?, canvases, idle rAF / 3 s, idle task ms/s) and
// writes docs/qa/wallpaper/ab-results.json. API: QA_API (default http://127.0.0.1:8797); previews: QA_PORTS (5197,5198).
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const [beforeDist, afterDist, seedFile] = process.argv.slice(2).map((p) => path.resolve(p));
const N = Number(process.argv[5] || 6);
const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const API = process.env.QA_API || "http://127.0.0.1:8797";
if (/:(8787|5173)\b/.test(API)) throw new Error("QA_API points at the live preview");
const token = JSON.parse(fs.readFileSync(seedFile, "utf8")).token;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const up = async (u) => { try { return (await fetch(u)).ok; } catch { return false; } };
function serve(dist, port) {
  const p = spawn("bunx", ["vite", "preview", "--outDir", dist, "--port", String(port), "--strictPort", "--host", "127.0.0.1"], { cwd: appDir, stdio: "ignore", detached: true, env: { ...process.env, PICKLE_API: API } });
  return p;
}
// the previews must be OURS: ports free before, and each serves exactly its dist's index.html (another QA run on this
// machine once held a port and `--strictPort` failed silently)
const [PA, PB] = (process.env.QA_PORTS || "5197,5198").split(",").map(Number);
for (const p of [PA, PB]) if (await up(`http://127.0.0.1:${p}/`)) throw new Error(`port ${p} is already serving something; set QA_PORTS`);
const A = { name: "before", url: `http://127.0.0.1:${PA}/?gl=force`, proc: serve(beforeDist, PA), dist: beforeDist };
const B = { name: "after", url: `http://127.0.0.1:${PB}/`, proc: serve(afterDist, PB), dist: afterDist };
const ours = async (t) => {
  try {
    return (await (await fetch(t.url)).text()) === fs.readFileSync(path.join(t.dist, "index.html"), "utf8");
  } catch {
    return false;
  }
};
for (let i = 0; i < 100 && !((await ours(A)) && (await ours(B))); i++) await sleep(150);
for (const t of [A, B]) if (!(await ours(t))) throw new Error(`${t.name} preview is not serving ${t.dist}`);
async function run(t) {
  const browser = await chromium.launch({ channel: "chrome", args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: "ko-KR" });
  await ctx.addInitScript((tk) => localStorage.setItem("pickle.token", tk), token);
  await ctx.addInitScript(() => {
    const q = (window.__perf = { lcp: 0, long: [] });
    new PerformanceObserver((l) => l.getEntries().forEach((e) => (q.lcp = e.startTime))).observe({ type: "largest-contentful-paint", buffered: true });
    new PerformanceObserver((l) => l.getEntries().forEach((e) => q.long.push([e.startTime, e.duration]))).observe({ type: "longtask", buffered: true });
    const orig = window.requestAnimationFrame.bind(window);
    window.__raf = { on: false, n: 0 };
    window.requestAnimationFrame = (cb) => { if (window.__raf.on) window.__raf.n++; return orig(cb); };
  });
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  await cdp.send("Performance.enable");
  await page.goto(t.url, { waitUntil: "load" });
  await page.waitForSelector(".bubble", { timeout: 30000 });
  await sleep(9000);
  const r = await page.evaluate(() => {
    const q = window.__perf;
    const fcp = performance.getEntriesByName("first-contentful-paint")[0]?.startTime ?? 0;
    const tbtAll = q.long.filter(([s]) => s >= fcp).reduce((a, [, d]) => a + Math.max(0, d - 50), 0);
    const js = performance.getEntriesByType("resource").filter((e) => /\.js(\?|$)/.test(e.name));
    return { fcp, lcp: q.lcp, tbt: tbtAll, js: js.reduce((a, e) => a + e.encodedBodySize, 0) / 1024, three: js.some((e) => /react-three-fiber/.test(e.name)), canvases: document.querySelectorAll("canvas").length };
  });
  const m0 = Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map((m) => [m.name, m.value]));
  const raf = await page.evaluate(async () => { window.__raf.n = 0; window.__raf.on = true; await new Promise((r) => setTimeout(r, 3000)); window.__raf.on = false; return window.__raf.n; });
  const m1 = Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map((m) => [m.name, m.value]));
  await browser.close();
  return { ...r, rafIn3s: raf, idleTaskMsPerSec: ((m1.TaskDuration - m0.TaskDuration) * 1000) / 3 };
}
const out = { before: [], after: [] };
try {
  for (let i = 0; i < N; i++) for (const t of i % 2 ? [B, A] : [A, B]) out[t.name].push(await run(t));
} finally {
  for (const t of [A, B]) try { process.kill(-t.proc.pid, "SIGTERM"); } catch {}
}
const med = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
const summary = {};
for (const k of ["before", "after"]) {
  const rs = out[k];
  summary[k] = { n: rs.length, fcp: med(rs.map((r) => r.fcp)), lcp: med(rs.map((r) => r.lcp)), tbt: med(rs.map((r) => r.tbt)), jsKB: +med(rs.map((r) => r.js)).toFixed(1), three: rs.every((r) => r.three), canvases: med(rs.map((r) => r.canvases)), rafIn3s: med(rs.map((r) => r.rafIn3s)), idleTaskMsPerSec: +med(rs.map((r) => r.idleTaskMsPerSec)).toFixed(1), lcpAll: rs.map((r) => Math.round(r.lcp)), tbtAll: rs.map((r) => Math.round(r.tbt)) };
}
fs.writeFileSync(path.resolve(appDir, "../../docs/qa/wallpaper/ab-results.json"), JSON.stringify({ at: new Date().toISOString(), cpuThrottle: 4, summary, out }, null, 2));
console.log(JSON.stringify(summary, null, 1));
