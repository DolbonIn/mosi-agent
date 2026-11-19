// Run (repo root): node qa/e2e-app.mjs   · own server :8799 (audio :8796) + vite preview :5199 · QA_ENGINES=chromium or webkit for one engine
// @ts-nocheck — the page.evaluate callbacks use window.__qa (installed by INIT), which checkJs cannot type
//
// Full-app integration e2e: the server and the PWA together, the way a person uses them.
// - One fresh pickle server: temp PICKLE_DATA_DIR, the real LLM from ~/.config/pickle-clone/secrets.env (passed to bun
//   with --env-file; nothing from it is read or printed here).
// - One production build of apps/mobile, served by `vite preview` with its /api proxy pointed at that server.
// - Driven at 390×844 @3x in installed Google Chrome (channel "chrome") and Playwright WebKit. Never runs
//   `playwright install`. Never uses :8787 (the user's preview server) or the other QA servers' ports.
// Per engine, one new user:
//   1 sign-up through the onboarding UI → the welcome message in the chat
//   2 "오늘 서울 날씨 알려줘": live text, the turn's tool line (status → "자료 1개 보기 · 기상청"), the final answer
//   3 Stop mid-stream → "고마워": a fresh answer comes back; the rest of the stopped answer never shows (live, after a
//     reload, or in the server's history)
//   4 a call to a bogus number → approval card → device-signed approve → the turn resumes and shows the call error
//   5 a chat turn makes a document, then every sheet a person meets is opened and closed with its ×: Agent (채팅 · 이름),
//     PreDelegate (둘러보기), Artifact + Upload (보관함), Phone + Connect (나의 모시), and one push/back (화면 및 디자인)
//   6 regressions, sampled every ~33 ms for 1.2 s around each action:
//     (a) chat thread scrolled up and down (composer blurred, then focused; Chrome: CDP touch drags, WebKit: scripted
//         flicks): the tab bar and composer rects never overlap, and the tab bar is never half-minimised
//     (b) after each close/back in 5 (sampled on every animation frame as well), the rows that were on screen stay
//         visible on every frame (height > 0, opacity 1);
//         for a sheet, also: no sheet/dialog surface (panel, scrim, morph clone) painted at opacity > 0.05 later than
//         200 ms after the tap, and a tap at the source row's centre would hit the row (nothing left on top of it)
//   7 0 console errors · 0 horizontal overflow at every screenshot · the page requests nothing but its own origin
//     (the server's own LLM / k-skill calls are outside the browser and allowed)
// Output: docs/qa/app/<engine>-NN-<step>.jpg (1×, q70) and docs/qa/app/results.json (a run of one engine keeps the
// other's entry).
// Env: QA_ENGINES · QA_SERVER_PORT · QA_AUDIO_PORT · QA_PORT · PICKLE_SECRETS (path) · QA_KEEP=1 keeps the temp data
//      dir and build · QA_REF=HEAD (server + app from that commit, not the working tree) · QA_APP_DIR (another
//      apps/mobile copy to build) + QA_APP_REF (its label) · QA_OUT (another output dir).
import { chromium, webkit } from "playwright";
import { execSync, spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");

/**
 * QA_REF=<git ref> (e.g. HEAD): run the server and build the app from that commit, not from this working tree.
 * `git archive` into a temp dir; each workspace's node_modules is copied as links (`cp -RP`), so @pickle/* resolve to
 * the export's own packages and third-party deps to this checkout's store (the export's node_modules → this one's).
 */
function exportRef(ref) {
  const sha = execSync(`git rev-parse --short ${JSON.stringify(ref)}`, { cwd: repo, encoding: "utf8" }).trim();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `pickle-e2e-src-${sha}-`));
  execSync(`git archive ${sha} apps/server apps/mobile packages package.json tsconfig.base.json | tar -x -C ${JSON.stringify(dir)}`, { cwd: repo, stdio: "pipe" });
  fs.symlinkSync(path.join(repo, "node_modules"), path.join(dir, "node_modules"));
  const workspaces = ["apps/server", "apps/mobile", ...fs.readdirSync(path.join(dir, "packages")).map((p) => `packages/${p}`)];
  for (const w of workspaces) {
    const from = path.join(repo, w, "node_modules");
    if (fs.existsSync(from) && fs.existsSync(path.join(dir, w))) execSync(`cp -RP ${JSON.stringify(from)} ${JSON.stringify(path.join(dir, w, "node_modules"))}`);
  }
  return { dir, sha };
}
const REF = process.env.QA_REF || "";
const src = REF ? exportRef(REF) : null;
const srcRoot = src ? src.dir : repo;
// QA_APP_DIR: build another copy of the app (e.g. an older commit's apps/mobile) · QA_OUT: write somewhere else
const appDir = path.resolve(process.env.QA_APP_DIR || path.join(srcRoot, "apps/mobile"));
const outDir = path.resolve(process.env.QA_OUT || path.join(repo, "docs/qa/app"));
const SERVER_PORT = Number(process.env.QA_SERVER_PORT || 8799);
const AUDIO_PORT = Number(process.env.QA_AUDIO_PORT || 8796);
const PREVIEW_PORT = Number(process.env.QA_PORT || 5199);
const API = `http://127.0.0.1:${SERVER_PORT}`;
const BASE = `http://127.0.0.1:${PREVIEW_PORT}`;
const SECRETS = process.env.PICKLE_SECRETS || path.join(os.homedir(), ".config/pickle-clone/secrets.env");
const ENGINES = (process.env.QA_ENGINES || "chromium,webkit").split(",").map((s) => s.trim()).filter(Boolean);
const KEEP = process.env.QA_KEEP === "1";
/** the user's preview server and audio, the meet/stt/tts services, the app QA servers */
const RESERVED = new Set([8787, 8789, 8781, 8782, 8790, 8791, 8792, 8769]);
const LLM_MS = 90_000;
const SAMPLE_MS = 1200;
const PASSWORD = "qa-pass-1234";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = () => crypto.randomBytes(3).toString("hex");

for (const p of [SERVER_PORT, AUDIO_PORT, PREVIEW_PORT]) if (RESERVED.has(p)) throw new Error(`port ${p} belongs to another server; pick another`);

// ── processes ──

function portBusy(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: "127.0.0.1", port });
    s.once("connect", () => (s.destroy(), resolve(true)));
    s.once("error", () => resolve(false));
  });
}

async function up(url, re) {
  try {
    const r = await fetch(url);
    return r.ok && (!re || re.test(await r.text()));
  } catch {
    return false;
  }
}

function killGroup(proc) {
  if (!proc || proc.exitCode !== null) return;
  try {
    process.kill(-proc.pid, "SIGTERM");
  } catch {
    proc.kill("SIGTERM");
  }
}

async function startServer() {
  if (!fs.existsSync(SECRETS)) throw new Error("secrets file not found (set PICKLE_SECRETS to its path)");
  for (const p of [SERVER_PORT, AUDIO_PORT]) if (await portBusy(p)) throw new Error(`port ${p} is in use; set QA_SERVER_PORT / QA_AUDIO_PORT`);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pickle-e2e-app-"));
  const logFile = path.join(dataDir, "server.log");
  const log = fs.openSync(logFile, "a");
  const proc = spawn(process.env.BUN || "bun", [`--env-file=${SECRETS}`, "run", "apps/server/src/index.ts"], {
    cwd: srcRoot,
    detached: true,
    stdio: ["ignore", log, log],
    env: { ...process.env, PORT: String(SERVER_PORT), PICKLE_DATA_DIR: dataDir, PICKLE_AUDIO_PORT: String(AUDIO_PORT), PICKLE_AUDIO_TUNNEL: "0" },
  });
  for (let i = 0; i < 200; i++) {
    if (proc.exitCode !== null) break;
    try {
      const r = await fetch(`${API}/api/health`);
      if (r.ok) return { proc, dataDir, logFile, health: await r.json() };
    } catch {
      /* not yet */
    }
    await sleep(200);
  }
  killGroup(proc);
  const tail = fs.readFileSync(logFile, "utf8").split("\n").slice(-6).join("\n");
  throw new Error(`server did not start (log: ${logFile})\n${tail}`);
}

async function startPreview() {
  if (await portBusy(PREVIEW_PORT)) throw new Error(`port ${PREVIEW_PORT} is in use; set QA_PORT`);
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), "pickle-e2e-app-dist-"));
  const t0 = Date.now();
  const b = spawnSync("bunx", ["vite", "build", "--outDir", dist, "--emptyOutDir"], { cwd: appDir, stdio: "pipe", encoding: "utf8" });
  if (b.status !== 0) throw new Error(`production build failed:\n${b.stdout.slice(-1500)}\n${b.stderr.slice(-1500)}`);
  const buildMs = Date.now() - t0;
  const proc = spawn("bunx", ["vite", "preview", "--outDir", dist, "--port", String(PREVIEW_PORT), "--strictPort", "--host", "127.0.0.1"], {
    cwd: appDir,
    detached: true,
    stdio: "ignore",
    env: { ...process.env, PICKLE_API: API },
  });
  for (let i = 0; i < 100; i++) {
    if (await up(`${BASE}/`, /<title>/)) {
      if (!(await up(`${BASE}/api/health`))) throw new Error("vite preview is up but its /api proxy does not reach the server");
      return { proc, dist, buildMs };
    }
    await sleep(150);
  }
  killGroup(proc);
  throw new Error("vite preview did not start");
}

// ── in-page instrumentation ──

const INIT = () => {
  const qa = (window.__qa = { clickAt: 0, frameAfterClick: 0, stopClickAt: 0, samples: [], tracked: [], trackSel: "", source: null, sourceSel: "", sourceCentre: null, timer: 0, seen: 0, seenText: "", turn: null });
  document.addEventListener(
    "click",
    (e) => {
      const t = performance.now();
      qa.clickAt = t;
      qa.frameAfterClick = 0;
      requestAnimationFrame(() => {
        if (qa.clickAt === t) qa.frameAfterClick = performance.now();
      });
      if (e.target instanceof Element && e.target.closest(".send-btn[data-mode=stop]")) qa.stopClickAt = t;
    },
    true,
  );
  const rect = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height };
  };
  const opacityOf = (el) => {
    let o = 1;
    for (let n = el; n instanceof Element; n = n.parentElement) o *= parseFloat(getComputedStyle(n).opacity || "1");
    return o;
  };
  const inView = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.bottom > 120 && r.top < innerHeight - 120 && r.right > 0 && r.left < innerWidth;
  };
  const centre = (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  };
  const shownNow = (el) => opacityOf(el) >= 0.999 && getComputedStyle(el).visibility !== "hidden";
  const unobstructed = (el) => {
    const c = centre(el);
    const hit = document.elementFromPoint(c.x, c.y);
    return !!hit && el.contains(hit);
  };
  const describe = (el) => (el ? `${el.tagName.toLowerCase()}${el.classList.length ? "." + [...el.classList].slice(0, 2).join(".") : ""}${el.closest(".sheet-root") ? " (in .sheet-root)" : ""}` : "nothing");
  /**
   * Call before opening the window: remember the rows of `sel` that are on screen and unobstructed now, and `src`
   * (what the window opens from; its centre is hit-tested on every frame of the close).
   */
  qa.track = (sel, src) => {
    qa.trackSel = sel || "";
    const rows = sel ? [...document.querySelectorAll(sel)].filter((el) => inView(el) && shownNow(el) && unobstructed(el)) : [];
    qa.source = src && shownNow(src) && unobstructed(src) ? src : null;
    qa.sourceSel = "";
    qa.sourceCentre = null;
    if (qa.source) {
      qa.sourceSel = sel || `${src.tagName.toLowerCase()}${[...src.classList].map((c) => "." + CSS.escape(c)).join("")}`;
      qa.sourceCentre = centre(src);
      if (!rows.includes(src)) rows.push(src);
    }
    qa.tracked = rows;
    return { rows: rows.length, source: !!qa.source, sourceText: qa.source ? (qa.source.textContent || "").trim().slice(0, 20) : null };
  };
  const SURFACES = "[role=dialog], [role=alertdialog], .sheet-panel, .sheet-scrim, [data-morph-clone], .sheet-clone, .morph-clone";
  const sampleOnce = () => {
    const tb = document.querySelector("nav.tabbar");
    const cp = document.querySelector(".chrome-slot .composer-wrap") || document.querySelector(".composer-wrap");
    const sc = document.querySelector("[data-qa-scroller]");
    const s = { t: performance.now(), tab: rect(tb), tabMin: !!tb?.classList.contains("is-minimized"), comp: rect(cp), top: sc ? Math.round(sc.scrollTop) : null };
    if (qa.tracked.length) {
      let els = qa.tracked.filter((el) => el.isConnected);
      const detached = qa.tracked.length - els.length;
      const again = qa.trackSel || qa.sourceSel;
      if (detached && again) els = els.concat([...document.querySelectorAll(again)].filter((el) => !qa.tracked.includes(el) && inView(el)));
      let bad = null;
      let minOp = 1;
      if (!els.length) bad = { why: "rows gone", detached };
      for (const el of els) {
        const r = el.getBoundingClientRect();
        const op = opacityOf(el);
        const vis = getComputedStyle(el).visibility;
        minOp = Math.min(minOp, op);
        if (!bad && (!(r.height > 0) || op < 0.999 || vis === "hidden")) bad = { row: (el.textContent || "").trim().slice(0, 20), h: Math.round(r.height), opacity: Math.round(op * 1000) / 1000, vis };
      }
      s.rows = { n: qa.tracked.length, detached, minOp: Math.round(minOp * 1000) / 1000, bad };
    }
    // every sheet / dialog surface still painted (on screen, with an area): its effective opacity
    const surf = { panel: 0, scrim: 0, other: 0 };
    for (const el of document.querySelectorAll(SURFACES)) {
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1 || r.right <= 0 || r.left >= innerWidth || r.bottom <= 0 || r.top >= innerHeight) continue;
      if (getComputedStyle(el).visibility === "hidden") continue;
      const k = el.matches(".sheet-scrim") ? "scrim" : el.matches("[role=dialog], [role=alertdialog], .sheet-panel") ? "panel" : "other";
      surf[k] = Math.max(surf[k], Math.round(opacityOf(el) * 1000) / 1000);
    }
    s.surf = surf;
    s.sheet = !!document.querySelector(".sheet-root");
    // what a tap at the source row's centre would hit
    if (qa.sourceCentre) {
      const el = qa.source?.isConnected ? qa.source : null;
      const c = el ? centre(el) : qa.sourceCentre;
      const hit = document.elementFromPoint(c.x, c.y);
      const ok = !!hit && (el ? el.contains(hit) : !!hit.closest(qa.sourceSel));
      // what is on top, and how visible it is (an invisible sheet that is still mounted swallows a tap all the same)
      s.cover = ok ? null : { by: describe(hit), op: hit ? Math.round(opacityOf(hit) * 1000) / 1000 : 0 };
    }
    qa.samples.push(s);
  };
  /** sample every ~33 ms; `everyFrame` also samples in every animation frame (a close's last frames are ~16 ms apart) */
  qa.sampleStart = (everyFrame = false) => {
    clearInterval(qa.timer);
    qa.raf = false;
    qa.samples = [];
    qa.clickAt = 0;
    qa.frameAfterClick = 0;
    sampleOnce();
    qa.timer = setInterval(sampleOnce, 33);
    if (everyFrame) {
      qa.raf = true;
      const loop = () => {
        if (!qa.raf) return;
        sampleOnce();
        requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
    }
  };
  qa.sampleStop = () => {
    clearInterval(qa.timer);
    qa.raf = false;
    return { samples: qa.samples, clickAt: qa.clickAt, frameAfterClick: qa.frameAfterClick };
  };
  /** first moment text matching `src` shows anywhere in a thread */
  qa.watchText = (src) => {
    const re = new RegExp(src);
    qa.seen = 0;
    qa.seenText = "";
    qa.stopClickAt = 0;
    const check = () => {
      if (qa.seen) return;
      for (const el of document.querySelectorAll(".thread-content")) {
        const m = (el.textContent || "").match(re);
        if (m) {
          qa.seen = performance.now();
          qa.seenText = m[0];
          return;
        }
      }
    };
    qa.textObs?.disconnect();
    qa.textObs = new MutationObserver(check);
    qa.textObs.observe(document.body, { childList: true, subtree: true, characterData: true });
    check();
  };
  /** live text and the tool line of the next turn (one row per turn: its words and state as they change) */
  qa.watchTurn = () => {
    const w = (qa.turn = { t0: performance.now(), textAt: 0, lens: [], chipAt: 0, chips: [], errChip: false });
    const check = () => {
      const live = document.querySelector(".msg-live .asst-text:not(.asst-wait)");
      const len = (live?.textContent || "").trim().length;
      if (len) {
        if (!w.textAt) w.textAt = performance.now() - w.t0;
        if (w.lens[w.lens.length - 1] !== len) w.lens.push(len);
      }
      for (const c of document.querySelectorAll(".msg-live .tools-line")) {
        if (!w.chipAt) w.chipAt = performance.now() - w.t0;
        const words = (c.querySelector(".tools-line-text > :not([aria-hidden])")?.textContent || "").replace(/\u00a0/g, " ").trim();
        const key = `${words}:${c.getAttribute("data-state")}`;
        if (!w.chips.includes(key)) w.chips.push(key);
        if (c.hasAttribute("data-errors")) w.errChip = true;
      }
    };
    qa.turnObs?.disconnect();
    qa.turnObs = new MutationObserver(check);
    qa.turnObs.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["data-state", "data-errors"] });
  };
};

async function overflow(page) {
  return page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const doc = document.documentElement.scrollWidth - vw;
    const offenders = [];
    for (const sc of document.querySelectorAll(".screen-scroll, .sheet-body, .dw, .onb")) {
      const scr = sc.getBoundingClientRect();
      if (!scr.width || scr.right < 0 || scr.left > vw) continue;
      for (const el of sc.querySelectorAll("*")) {
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height || (r.width <= 1 && r.height <= 1) || el.closest(".sr-only")) continue;
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

// ── chat helpers ──

const composer = (page) => page.locator("textarea.composer-field");
const streaming = (page) => page.locator(".send-btn[data-mode=stop]");

async function tapIn(locator) {
  await locator.evaluate((el) => el.scrollIntoView({ block: "center", behavior: "instant" }));
  await sleep(250);
  await locator.click();
}

async function send(page, text) {
  const f = composer(page);
  await f.click();
  await f.fill(text);
  await page.keyboard.press("Enter");
  await sleep(200);
}

async function waitIdle(page, timeout = LLM_MS) {
  await page.waitForFunction(() => !document.querySelector(".send-btn[data-mode=stop]") && !document.querySelector(".msg-live"), null, { timeout });
  await sleep(400);
}

/** no local turn, no follow-up row, and the island is not busy */
async function waitAgentIdle(page, timeout = LLM_MS) {
  await page
    .waitForFunction(
      () =>
        !document.querySelector(".send-btn[data-mode=stop]") &&
        !document.querySelector(".msg-live, [data-follow]") &&
        !document.querySelector(".island[data-kind=thinking], .island[data-kind=tool], .island[data-kind=streaming]"),
      null,
      { timeout },
    )
    .catch(() => {});
  await sleep(300);
}

const asstCount = (page) => page.evaluate(() => document.querySelectorAll(".thread-content .msg-asst:not(.msg-live)").length);
const lastAsstText = (page) =>
  page.evaluate(() => {
    const rows = [...document.querySelectorAll(".thread-content .msg-asst:not(.msg-live) .asst-text")];
    return rows.length ? (rows[rows.length - 1].textContent || "").trim() : "";
  });

/** send; if the turn ends without `selector` (the agent asked something instead), send the next phrasing */
async function ask(page, texts, selector, timeout = LLM_MS) {
  for (const text of texts) {
    await send(page, text);
    await streaming(page).waitFor({ timeout: 10_000 }).catch(() => {});
    const hit = await page
      .waitForFunction((sel) => (document.querySelector(sel) ? "hit" : !document.querySelector(".send-btn[data-mode=stop]") && !document.querySelector(".msg-live") ? "idle" : false), selector, { timeout })
      .then((h) => h.jsonValue())
      .catch(() => "timeout");
    if (hit === "hit") return text;
    await waitIdle(page).catch(() => {});
    if (await page.locator(selector).count()) return text;
  }
  return null;
}

async function api(token, method, p, body) {
  const r = await fetch(API + p, {
    method,
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const type = r.headers.get("content-type") || "";
  return { status: r.status, body: type.includes("json") ? await r.json() : await r.text() };
}

/** tap a tab like a person: if an older build has minimised the bar to its circle, tap the circle first */
async function gotoTab(page, id) {
  const mini = page.locator(".tabbar.is-minimized .tab-mini");
  if (await mini.count()) {
    await mini.first().click();
    await sleep(700);
  }
  await page.click(`#tab-${id}`);
}

async function titleVisible(page, text, timeout = 6000) {
  return page
    .waitForFunction(
      (t) =>
        [...document.querySelectorAll(".large-title-text")].some((el) => {
          if (el.textContent?.trim() !== t) return false;
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.left < -1 || r.right > innerWidth + 1) return false;
          const hit = document.elementFromPoint(Math.min(innerWidth - 2, r.left + 8), r.top + r.height / 2);
          return !!hit && (el.contains(hit) || hit.closest(".large-title") === el.closest(".large-title"));
        }),
      text,
      { timeout },
    )
    .then(() => true)
    .catch(() => false);
}

// ── the run of one engine ──

class Run {
  constructor(engine, page) {
    Object.assign(this, { engine, page, n: 0, step: "load", shots: [], overflows: [], errors: [], external: [], requests: { api: 0, static: 0 }, flows: [], cur: null, metrics: {} });
  }
  request(url, type) {
    let u;
    try {
      u = new URL(url);
    } catch {
      return;
    }
    if (["data:", "blob:", "about:"].includes(u.protocol)) return;
    if (u.origin !== BASE) this.external.push({ step: this.step, url: `${u.origin}${u.pathname}`.slice(0, 140), type });
    else this.requests[u.pathname.startsWith("/api/") ? "api" : "static"]++;
  }
  async shot(name) {
    await sleep(350);
    // 1× JPEG (q70): small enough to commit; the 390×844 layout is what the checks are about
    const file = `${this.engine}-${String(++this.n).padStart(2, "0")}-${name}.jpg`;
    await this.page.screenshot({ path: path.join(outDir, file), type: "jpeg", quality: 70, scale: "css" });
    this.shots.push(file);
    const o = await overflow(this.page);
    if (o.doc > 0 || o.offenders.length) this.overflows.push({ file, ...o });
  }
  flowEntry(name) {
    let f = this.flows.find((x) => x.name === name);
    if (!f) this.flows.push((f = { name, ok: false, ms: 0, times: {}, checks: [] }));
    return f;
  }
  check(name, ok, detail, flow = this.cur) {
    flow.checks.push({ name, ok: !!ok, ...(detail === undefined ? {} : { detail }) });
    const d = detail === undefined ? "" : ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}`.slice(0, 260);
    console.log(`  ${ok ? "ok  " : "FAIL"} ${this.engine} ${name}${d}`);
  }
  time(label, ms) {
    this.cur.times[label] = Math.round(ms);
  }
  async flow(name, fn) {
    const f = this.flowEntry(name);
    this.cur = f;
    console.log(`\n▶ ${this.engine} · ${name}`);
    const t0 = Date.now();
    // a frozen page (renderer hung) makes keyboard/screenshot calls wait forever: fail the rest instead of hanging the run
    if (!this.hungIn && (await bounded(this.page.evaluate(() => 1), 15_000)) === TIMED_OUT) this.hungIn = `before ${name}`;
    if (this.hungIn) {
      this.check("page responds", false, `the page stopped responding (${this.hungIn}); this flow was not run`);
    } else {
      try {
        await fn();
      } catch (e) {
        this.check("ran to the end", false, String(e?.message || e).split("\n")[0].slice(0, 240));
        const shot = await bounded(this.shot(`error-${name.split(" ")[0]}`).catch(() => {}), 20_000);
        if (shot === TIMED_OUT || (await bounded(this.recover(), 30_000)) === TIMED_OUT) {
          this.hungIn = name;
          this.check("page responds after the failure", false, "screenshot / Escape did not return; the remaining flows of this engine are not run");
        }
      }
    }
    f.ms = Date.now() - t0;
    f.ok = f.checks.length > 0 && f.checks.every((c) => c.ok);
  }
  async recover() {
    const page = this.page;
    for (let i = 0; i < 4; i++) {
      await page.keyboard.press("Escape").catch(() => {});
      await sleep(300);
      const close = page.locator(".sheet-root .sheet-close");
      if (await close.count().catch(() => 0)) await close.first().click({ timeout: 2000 }).catch(() => {});
      const back = page.locator('.tb-circle[aria-label="뒤로"]');
      if (await back.count().catch(() => 0)) await back.first().click({ timeout: 2000 }).catch(() => {});
      await sleep(500);
    }
  }
}

const TIMED_OUT = Symbol("timed out");
/** p, or TIMED_OUT after ms (p keeps running; its rejection is swallowed) */
function bounded(p, ms) {
  let timer;
  const t = new Promise((res) => (timer = setTimeout(() => res(TIMED_OUT), ms)));
  return Promise.race([p.catch(() => undefined), t]).finally(() => clearTimeout(timer));
}

function settledFrames(res) {
  const from = res.frameAfterClick || (res.clickAt ? res.clickAt + 17 : Infinity);
  return res.samples.filter((s) => s.t >= from);
}

/** a sheet surface or a cover that is still there this long after the close tap fails (b) */
const LATE_MS = 200;
const r3 = (x) => Math.round(x * 1000) / 1000;

/**
 * (b) after the close/back tap:
 * - from the first frame: the tracked rows (and the source) are shown (height > 0, effective opacity 1)
 * - after LATE_MS: no sheet / dialog surface is painted with opacity > 0.05, and a tap at the source row's centre
 *   would land on the row (nothing on top of it)
 */
function analyseReturn(res, tracked) {
  const after = settledFrames(res);
  const post = after.filter((s) => s.rows);
  const bad = post.filter((s) => s.rows.bad);
  const ms = (s) => Math.round(s.t - res.clickAt);
  const late = after.filter((s) => s.t - res.clickAt > LATE_MS);
  const surfMax = (s) => Math.max(s.surf.panel, s.surf.scrim, s.surf.other);
  const lateSurf = late.filter((s) => surfMax(s) > 0.05);
  const lateCover = late.filter((s) => s.cover);
  const gone = after.find((s) => !s.sheet);
  const top = (k) => (late.length ? r3(Math.max(...late.map((s) => s.surf[k]))) : null);
  return {
    tracked: tracked.rows,
    sourceTracked: tracked.source,
    clicked: !!res.clickAt,
    frames: post.length,
    badFrames: bad.length,
    minOpacity: post.length ? Math.min(...post.map((s) => s.rows.minOp)) : null,
    detachedFrames: post.filter((s) => s.rows.detached).length,
    firstBad: bad[0] ? { ms: ms(bad[0]), ...bad[0].rows.bad } : null,
    lateFrames: late.length,
    surfaceFrames: lateSurf.length,
    surfaceLastMs: lateSurf.length ? ms(lateSurf[lateSurf.length - 1]) : null,
    panelMaxAfter200: top("panel"),
    scrimMaxAfter200: top("scrim"),
    otherMaxAfter200: top("other"),
    coveredFrames: lateCover.length,
    coveredLastMs: lateCover.length ? ms(lateCover[lateCover.length - 1]) : null,
    coveredBy: lateCover[0] ? `${lateCover[0].cover.by} @ ${ms(lateCover[0])} ms` : null,
    coverMaxOpacity: lateCover.length ? r3(Math.max(...lateCover.map((s) => s.cover.op))) : null,
    sheetUnmountedMs: gone ? ms(gone) : null,
  };
}

const overlapPx = (a, b) => (a && b ? Math.max(0, Math.min(a.b, b.b) - Math.max(a.t, b.t)) * (Math.min(a.r, b.r) - Math.max(a.l, b.l) > 0.5 ? 1 : 0) : 0);

/** (a): every sampled frame: tab bar ∩ composer = ∅ and the bar is full size (or, if it ever minimises, fully so) */
function analyseScroll(samples, rest) {
  let overlap = 0;
  let half = 0;
  let mini = 0;
  let notFull = 0;
  let firstOverlap = null;
  let firstHalf = null;
  for (const s of samples) {
    if (!s.tab) continue;
    const o = overlapPx(s.tab, s.comp);
    if (o > 0.5) {
      overlap++;
      firstOverlap ??= { tab: [Math.round(s.tab.t), Math.round(s.tab.b)], composer: [Math.round(s.comp.t), Math.round(s.comp.b)], px: Math.round(o) };
    }
    const full = Math.abs(s.tab.w - rest.w) <= 1 && Math.abs(s.tab.h - rest.h) <= 1;
    const isMini = !full && s.tabMin && s.tab.w <= 48 && s.tab.h <= 48;
    if (!full) notFull++;
    if (isMini) mini++;
    else if (!full) {
      half++;
      firstHalf ??= { w: Math.round(s.tab.w), h: Math.round(s.tab.h), minimizedClass: s.tabMin };
    }
  }
  return { frames: samples.length, overlap, firstOverlap, half, firstHalf, mini, notFull };
}

async function runEngine(engine) {
  const type = engine === "webkit" ? webkit : chromium;
  const browser = await type.launch(engine === "chromium" ? { channel: "chrome" } : {});
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    locale: "ko-KR",
    timezoneId: "Asia/Seoul",
    colorScheme: "light",
  });
  await context.addInitScript(INIT);
  const page = await context.newPage();
  const r = new Run(engine, page);
  context.on("request", (req) => r.request(req.url(), req.resourceType()));
  page.on("websocket", (ws) => r.request(ws.url(), "websocket"));
  page.on("console", (m) => {
    if (m.type() === "error") r.errors.push({ step: r.step, text: m.text().slice(0, 300), url: (m.location()?.url || "").split("?")[0] });
  });
  page.on("pageerror", (e) => r.errors.push({ step: r.step, text: `pageerror: ${String(e.message).slice(0, 300)}` }));
  const handle = `qa${engine.slice(0, 1)}${rand()}`;
  let token = null;
  let mainThreadId = null;

  // ── 1 ──
  await r.flow("1 sign-up + welcome", async () => {
    r.step = "onboarding";
    let t = Date.now();
    await page.goto(`${BASE}/`, { waitUntil: "load" });
    await page.waitForSelector(".onb", { timeout: 20_000 });
    r.time("load → onboarding", Date.now() - t);
    await sleep(1200);
    await r.shot("onboarding");
    await page.getByRole("button", { name: "시작하기", exact: true }).click();
    await page.waitForSelector("[role=dialog] .onb-form", { timeout: 8000 });
    await sleep(500);
    await page.getByRole("textbox", { name: "아이디" }).fill(handle);
    await page.getByRole("textbox", { name: "비밀번호" }).fill(PASSWORD);
    await r.shot("signup-step1");
    await page.getByRole("button", { name: "다음", exact: true }).click();
    const name = page.getByRole("textbox", { name: "내 이름" });
    await name.waitFor({ timeout: 8000 });
    await name.fill("큐에이");
    await sleep(300);
    await r.shot("signup-step2");
    r.step = "signup";
    t = Date.now();
    await page.getByRole("button", { name: /^(모시|피클) 만들기$/ }).click(); // 피클: builds from before the rename
    await page.waitForSelector(".onb", { state: "detached", timeout: 30_000 });
    r.time("모시 만들기 → chat", Date.now() - t);
    r.check("sign-up through the onboarding UI lands in the chat", true, `${Date.now() - t} ms`);
    r.step = "welcome";
    t = Date.now();
    const welcome = await page.waitForSelector(".thread-content .ccard-briefing", { timeout: 30_000 }).then(() => true).catch(() => false);
    r.time("chat → welcome card", Date.now() - t);
    const replies = await page.locator(".ccard-briefing .quick-replies button").count();
    r.check("welcome message with its briefing card in the chat", welcome, `${replies} quick replies`);
    await sleep(600);
    await r.shot("welcome");
    token = await page.evaluate(() => localStorage.getItem("pickle.token"));
    const s = token ? await api(token, "GET", "/api/session") : null;
    mainThreadId = s?.body?.mainThreadId ?? null;
    r.check("session token stored by the app works against the server", s?.status === 200 && !!mainThreadId, s?.status);
  });

  // ── 2 ──
  await r.flow("2 weather turn", async () => {
    r.step = "weather";
    await waitAgentIdle(page);
    await page.evaluate(() => window.__qa.watchTurn());
    const t = Date.now();
    await send(page, "오늘 서울 날씨 알려줘");
    const chip = await page.waitForSelector(".msg-live .tools-line", { timeout: LLM_MS }).then(() => true).catch(() => false);
    if (chip) await r.shot("weather-tool-chip");
    await waitIdle(page, LLM_MS);
    r.time("send → done", Date.now() - t);
    const w = await page.evaluate(() => window.__qa.turn);
    r.time("send → first tool chip", w.chipAt);
    r.time("send → first live text", w.textAt);
    r.check("the turn's tool line shows while the turn runs", w.chipAt > 0, w.chips.join(", "));
    r.check("streaming text appears in the live row", w.textAt > 0, `${w.lens.length} text updates`);
    const text = await lastAsstText(page);
    // the weather card is a record: folded behind the turn's line ("자료 1개 보기 · 기상청") unless opened
    const card = (await page.locator(".thread-content .ccard-weather").count()) + (await page.locator(".thread-content .tools-line", { hasText: "기상청" }).count());
    r.check("the final answer lands", text.length > 10 && /날씨|기온|°|도|맑|흐|비|눈|구름|습도/.test(text), `${card ? "weather card + " : ""}${text.slice(0, 80)}`);
    await r.shot("weather-answer");
  });

  // ── 3 ──
  await r.flow("3 stop → 고마워", async () => {
    r.step = "stop";
    await waitAgentIdle(page);
    // A long answer whose checked value comes LAST, stopped once its first lines are on screen: a real mid-turn Stop.
    // If the value had already streamed before the Stop (the model led with it), that try proves nothing: next one.
    const cases = [
      ["피보나치 수열을 1번째부터 30번째까지 한 줄에 하나씩 번호를 붙여서 모두 적어줘", "832[,.]?040"],
      ["2의 1제곱부터 2의 20제곱까지 한 줄에 하나씩 모두 적어줘", "1[,.]?048[,.]?576"],
    ];
    let used = null;
    for (const [q, re] of cases) {
      await page.evaluate((s) => (window.__qa.watchText(s), window.__qa.watchTurn()), re);
      const n0 = await asstCount(page);
      await send(page, q);
      const running = await streaming(page).waitFor({ timeout: 10_000 }).then(() => true).catch(() => false);
      if (!running) {
        r.check("the turn is running when Stop is pressed", false, q);
        return;
      }
      const live = await page
        .waitForFunction(() => window.__qa.turn.textAt > 0 || !document.querySelector(".send-btn[data-mode=stop]"), null, { timeout: LLM_MS })
        .then(() => page.evaluate(() => window.__qa.turn.textAt > 0 && !!document.querySelector(".send-btn[data-mode=stop]")))
        .catch(() => false);
      const t = Date.now();
      if (live) await streaming(page).click({ timeout: 3000 }).catch(() => {});
      const stopped = await page.waitForFunction(() => !document.querySelector(".send-btn[data-mode=stop]"), null, { timeout: 10_000 }).then(() => true).catch(() => false);
      const stopMs = Date.now() - t;
      await sleep(600);
      const st = await page.evaluate(() => ({ stopAt: window.__qa.stopClickAt, textAt: window.__qa.turn.textAt }));
      const kept = (await asstCount(page)) > n0 ? await lastAsstText(page) : "";
      const why = !live ? "the turn ended before Stop could be pressed mid-stream" : !st.stopAt ? "the Stop tap did not land" : new RegExp(re).test(kept) ? "the value had already streamed before Stop" : "";
      if (why) {
        r.metrics.stopRetries = [...(r.metrics.stopRetries || []), { q, why }];
        console.log(`  note ${engine} "${q}": ${why}; trying the next question`);
        await waitAgentIdle(page);
        continue;
      }
      r.time("send → first live text", st.textAt);
      r.time("Stop → send button back", stopMs);
      r.metrics.stoppedPartialChars = kept.length;
      r.check("Stop ends the turn mid-stream (send button comes back, partial text kept)", stopped, `${kept.length} chars kept`);
      used = { q, re };
      break;
    }
    if (!used) {
      r.check("a mid-stream Stop before the checked value (test precondition)", false, (r.metrics.stopRetries || []).map((x) => x.why).join("; "));
      return;
    }
    await sleep(500);
    r.check("a stop is not an error (no error line)", (await page.locator(".thread-error").count()) === 0);
    await r.shot("stopped");
    const before = await asstCount(page);
    const t = Date.now();
    await send(page, "고마워");
    await page.waitForFunction((n) => document.querySelectorAll(".thread-content .msg-asst:not(.msg-live)").length > n && !document.querySelector(".send-btn[data-mode=stop]") && !document.querySelector(".msg-live"), before, { timeout: LLM_MS });
    r.time("고마워 → answer", Date.now() - t);
    await sleep(2000);
    const reply = await lastAsstText(page);
    const seen = await page.evaluate(() => ({ seen: window.__qa.seen, text: window.__qa.seenText }));
    r.check("a fresh answer to 고마워 comes back", reply.length > 0 && !new RegExp(used.re).test(reply), reply.slice(0, 80));
    r.check("the stopped answer never appears (live)", !seen.seen, seen.text || `${used.q} → not shown`);
    await r.shot("after-thanks");
    r.step = "stop-reload";
    await page.reload({ waitUntil: "load" });
    await page.waitForSelector(".thread-content .msg-row", { timeout: 20_000 });
    await sleep(1500);
    const after = await page.evaluate((src) => [...document.querySelectorAll(".thread-content")].some((el) => new RegExp(src).test(el.textContent || "")), used.re);
    r.check("the stopped answer is not in the thread after a reload", !after);
    const hist = token && mainThreadId ? await api(token, "GET", `/api/threads/${mainThreadId}/messages`) : null;
    const items = Array.isArray(hist?.body) ? hist.body : hist?.body?.items ?? [];
    r.check("server history has no answer to the stopped request", items.length > 0 && !items.some((m) => m.role === "assistant" && new RegExp(used.re).test(m.text || "")), `${items.length} messages`);
  });

  // ── 4 ──
  await r.flow("4 call approval", async () => {
    r.step = "approval";
    await waitAgentIdle(page);
    let t = Date.now();
    // everything a call needs is in the request (number, place, name, what to ask), so the agent has nothing to ask back
    const asked = await ask(
      page,
      ["모시식당(010-1234-5678)에 전화해서 내일 저녁 7시에 큐에이 이름으로 2명 예약 되는지 물어봐줘", "가게는 모시식당, 예약자는 큐에이야. 더 묻지 말고 010-1234-5678로 바로 전화 걸어 줘"],
      ".ccard-approval[data-approval-pending]",
    );
    r.check("the outbound call raises the approval card in the UI", !!asked, asked ? undefined : (await lastAsstText(page)).slice(0, 100));
    if (!asked) return;
    r.time("send → approval card", Date.now() - t);
    await waitIdle(page).catch(() => {});
    const pending = page.locator(".ccard-approval[data-approval-pending]").last();
    const appId = await pending.getAttribute("data-approval-id");
    await pending.evaluate((el) => el.scrollIntoView({ block: "center", behavior: "instant" }));
    await sleep(400);
    await r.shot("approval-card");
    const card = page.locator(`.ccard-approval[data-approval-id="${appId}"]`);
    const btn = card.locator(".appr-actions button").first();
    await tapIn(btn);
    await sleep(150);
    r.check("first tap arms the confirm button (한 번 더)", /한 번 더/.test((await btn.textContent()) || ""), (await btn.textContent())?.trim());
    await sleep(450);
    await page.evaluate(() => window.__qa.watchTurn());
    t = Date.now();
    await btn.click();
    const approved = await card.locator(".appr-receipt[data-status=approved]").waitFor({ timeout: 30_000 }).then(() => true).catch(() => false);
    r.time("approve → approved receipt", Date.now() - t);
    r.check("approved: the server accepted the device-signed decision", approved);
    const verified = await card.locator(".appr-verified").waitFor({ timeout: 20_000 }).then(() => true).catch(() => false);
    r.check("이 기기의 키로 확인했어요 (signature verified)", verified);
    await waitIdle(page, LLM_MS).catch(() => {});
    r.time("approve → resumed turn done", Date.now() - t);
    const w = await page.evaluate(() => window.__qa.turn);
    const errUi = w.errChip || (await page.locator(".thread-content .tools-line[data-errors], .thread-content .tools-step[data-state=error]").count()) > 0;
    const said = await lastAsstText(page);
    r.check("the resumed turn shows the call error (tool marked 오류)", errUi, w.chips.join(", ") || "summary pill");
    r.check("the agent says the call could not be placed", /전화|통화|발신|연결/.test(said) && /(못|않|없|실패|오류|불가|어려|안 ?돼|안 ?됐|제한|인증)/.test(said), said.slice(0, 100));
    const hist = await api(token, "GET", `/api/threads/${mainThreadId}/messages`);
    const tools = (Array.isArray(hist.body) ? hist.body : []).flatMap((m) => m.tools || []).filter((x) => x.name === "sys_phone_call");
    r.check("server history: sys_phone_call ended in error", tools.some((x) => x.state === "error"), tools.map((x) => x.state).join(","));
    await r.shot("approval-resumed");
  });

  // ── 5 (+ 6b) ──
  const fb = r.flowEntry("6b close/back: rows shown, no sheet left on them");
  /**
   * Remember `rows` and `source`, open with `open`, then close with `close` while sampling. `sheet`: also require that
   * no sheet surface is left after LATE_MS and that nothing covers the source row by then.
   */
  async function sampledReturn(label, { rows = null, source = null, open, close, sheet = false }) {
    const tracked = source ? await source.evaluate((el, s) => window.__qa.track(s, el), rows) : await page.evaluate((s) => window.__qa.track(s, null), rows);
    await open();
    await page.evaluate(() => window.__qa.sampleStart(true));
    await sleep(150);
    await close();
    await sleep(SAMPLE_MS);
    const res = await page.evaluate(() => window.__qa.sampleStop());
    const a = analyseReturn(res, tracked);
    r.metrics[`return:${label}`] = a;
    const { tracked: n, frames, badFrames, minOpacity, firstBad } = a;
    r.check(`(b) ${label}: rows stay visible on every frame`, a.clicked && a.tracked > 0 && a.frames >= 15 && a.badFrames === 0, { tracked: n, frames, badFrames, minOpacity, firstBad }, fb);
    if (sheet) {
      const { lateFrames, surfaceFrames, surfaceLastMs, panelMaxAfter200, scrimMaxAfter200, otherMaxAfter200, sheetUnmountedMs } = a;
      r.check(`(b) ${label}: no sheet surface after ${LATE_MS} ms`, a.lateFrames >= 10 && a.surfaceFrames === 0, { lateFrames, surfaceFrames, surfaceLastMs, panelMaxAfter200, scrimMaxAfter200, otherMaxAfter200, sheetUnmountedMs }, fb);
      const { coveredFrames, coveredLastMs, coveredBy, coverMaxOpacity, sourceTracked } = a;
      r.check(`(b) ${label}: nothing covers the row after ${LATE_MS} ms`, a.sourceTracked && a.lateFrames >= 10 && a.coveredFrames === 0, { sourceTracked, lateFrames, coveredFrames, coveredLastMs, coveredBy, coverMaxOpacity }, fb);
    }
    return a;
  }

  /** open a sheet from `source`, close it with its × while sampling (b), and check it opened and went away */
  async function sheetCase(label, { source, rows = null, shot, reveal = true, ready = ".sheet-root [role=dialog]" }) {
    if (reveal) {
      await source.evaluate((el) => el.scrollIntoView({ block: "center", behavior: "instant" }));
      await sleep(500);
    }
    let opened = false;
    let title = "";
    await sampledReturn(label, {
      rows,
      source,
      sheet: true,
      open: async () => {
        await source.click();
        opened = await page.locator(ready).first().waitFor({ timeout: 8000 }).then(() => true).catch(() => false);
        await sleep(1000);
        title = ((await page.locator(".sheet-root .sheet-title").first().textContent().catch(() => "")) || "").trim();
        await r.shot(shot);
      },
      close: () => page.locator(".sheet-root .sheet-close").first().click(),
    });
    const closed = await page.locator(".sheet-root").waitFor({ state: "detached", timeout: 6000 }).then(() => true).catch(() => false);
    r.check(`${label}: opens and closes`, opened && closed, title);
    await r.shot(`${shot}-closed`);
  }

  await r.flow("5 tabs + sheets: chat / explore / archive / profile", async () => {
    r.step = "artifact";
    await waitAgentIdle(page);
    let t = Date.now();
    const asked = await ask(page, ["제주 2박3일 일정 문서로 만들어줘", "질문 없이 제주 2박3일 일정을 문서로 바로 만들어서 보관함에 저장해 줘"], ".thread-content .ccard-artifact");
    r.check("a chat turn makes the document (artifact card)", !!asked);
    r.time("send → artifact card", Date.now() - t);
    await waitAgentIdle(page);
    await page.locator(".thread-content .ccard-artifact").last().evaluate((el) => el.scrollIntoView({ block: "center", behavior: "instant" })).catch(() => {});
    await r.shot("artifact-card");

    // the agent's name in the chat's top bar → its sheet (친구 초대 lives there since chat B: the bar has no trailing capsule)
    r.step = "agent";
    await sheetCase("Agent sheet (채팅 · 이름)", { source: page.locator(".topbar .tb-agent").first(), shot: "agent-sheet", reveal: false });

    // 둘러보기 → PreDelegate
    r.step = "explore";
    await gotoTab(page, "explore");
    await page.waitForSelector(".tpl-row", { timeout: 15_000 });
    await sleep(900);
    await r.shot("explore");
    await sheetCase("PreDelegate sheet (둘러보기)", { source: page.locator(".tpl-row").nth(2), rows: ".tpl-row", shot: "predelegate-sheet", ready: ".sheet-root .pre-steps" });

    // 보관함 → artifact, Upload
    r.step = "archive";
    await gotoTab(page, "archive");
    const listed = await page.locator(".screen-scroll .arc-card").first().waitFor({ timeout: 15_000 }).then(() => true).catch(() => false);
    r.check("보관함 lists the document made in the chat", listed, await page.locator(".screen-scroll .arc-card__title").first().textContent().catch(() => ""));
    await sleep(800);
    await r.shot("archive");
    if (listed) {
      await sheetCase("Artifact sheet (보관함)", { source: page.locator(".screen-scroll .arc-card").first(), rows: ".arc-card", shot: "artifact-sheet", ready: ".sheet-root .sheet-body" });
    }
    r.step = "upload";
    // the segments are 문서 | 사진·파일 since archive draft A (90fc088)
    await page.locator(".screen-scroll .seg-item", { hasText: "사진·파일" }).first().click();
    const uploadBtn = page.locator(".screen-scroll .empty-state button", { hasText: "올리기" }).first();
    const uploadShown = await uploadBtn.waitFor({ timeout: 10_000 }).then(() => true).catch(() => false);
    r.check("보관함 · 사진·파일 offers 올리기", uploadShown);
    await sleep(600);
    if (uploadShown) await sheetCase("Upload sheet (보관함 · 사진·파일)", { source: uploadBtn, shot: "upload-sheet" });
    await page.locator(".screen-scroll .seg-item", { hasText: "문서" }).first().click().catch(() => {});

    // 나의 모시 → PhoneSheet, detail push/back, 연결 → Connect
    r.step = "profile";
    await gotoTab(page, "profile");
    await page.waitForSelector(".profile-quota", { timeout: 15_000 });
    await sleep(900);
    await r.shot("profile");
    await sheetCase("Phone sheet (나의 모시 · 내 전화번호)", { source: page.locator(".screen-scroll .profile-phone-row").first(), rows: ".screen-scroll .list-row", shot: "phone-sheet" });

    r.step = "profile-push";
    const label = "화면 및 디자인";
    const target = page.locator(".screen-scroll .list-row", { hasText: label }).first();
    await target.evaluate((el) => el.scrollIntoView({ block: "center", behavior: "instant" }));
    await sleep(500);
    let pushed = false;
    // a pop slides the page away over the rows, so only the rows' own visibility is checked here (the cover is logged)
    await sampledReturn("profile detail back", {
      rows: ".screen-scroll .list-row",
      source: target,
      open: async () => {
        await target.click();
        pushed = await titleVisible(page, label);
        await sleep(400);
        await r.shot("profile-detail");
      },
      close: () => page.locator('.tb-circle[aria-label="뒤로"]').first().click(),
    });
    await sleep(300);
    const backAtRoot = (await page.locator('.tb-circle[aria-label="뒤로"]:visible').count()) === 0;
    r.check(`나의 모시: ${label} pushes its detail and back returns`, pushed && backAtRoot);
    await r.shot("profile-back");

    r.step = "connections";
    const conns = page.locator(".screen-scroll .profile-conns").first();
    await conns.evaluate((el) => el.scrollIntoView({ block: "center", behavior: "instant" }));
    await sleep(400);
    await conns.click();
    const inConns = await titleVisible(page, "앱 연결");
    r.check("나의 모시 → 앱 연결", inConns);
    const kakao = page.locator(".screen-scroll .conn-row-kakaotalk").first();
    if (inConns && (await kakao.waitFor({ timeout: 10_000 }).then(() => true).catch(() => false))) {
      await sleep(500);
      await sheetCase("Connect sheet (연결 · 카카오톡)", { source: kakao, rows: ".screen-scroll .conn-row", shot: "connect-sheet" });
    } else r.check("카카오톡 row in 앱 연결", false);
    await page.locator('.tb-circle[aria-label="뒤로"]').first().click().catch(() => {});
    await sleep(800);
  });

  // ── 6a ──
  await r.flow("6a chat scroll: tab bar vs composer", async () => {
    r.step = "scroll";
    await gotoTab(page, "chat");
    await page.waitForSelector("textarea.composer-field", { timeout: 10_000 });
    await sleep(900);
    const range = await page.evaluate(() => {
      document.querySelector("[data-qa-scroller]")?.removeAttribute("data-qa-scroller");
      const sc = document.elementFromPoint(195, 400)?.closest(".screen-scroll");
      if (!sc) return null;
      sc.setAttribute("data-qa-scroller", "");
      sc.scrollTop = sc.scrollHeight;
      document.activeElement instanceof HTMLElement && document.activeElement.blur();
      return sc.scrollHeight - sc.clientHeight;
    });
    await sleep(800);
    r.check("the chat thread is long enough to scroll", (range ?? 0) > 300, `${range} px`);
    const rest = await page.evaluate(() => {
      const b = document.querySelector("nav.tabbar")?.getBoundingClientRect();
      return b ? { w: b.width, h: b.height } : null;
    });
    r.check("tab bar at rest is full width", !!rest && Math.abs(rest.w - (390 - 32)) <= 2 && Math.abs(rest.h - 68) <= 1, rest);
    if (!rest) return;
    await r.shot("chat-before-scroll");
    const cdp = engine === "chromium" ? await context.newCDPSession(page) : null;
    const methods = new Set();
    async function scroll(dy) {
      if (cdp) {
        try {
          // a finger drag (touch), like the phone the bug was seen on; yDistance > 0 scrolls up
          await cdp.send("Input.synthesizeScrollGesture", { x: 195, y: 430, yDistance: -dy, speed: 1400, gestureSourceType: "touch" });
          methods.add("touch");
          return;
        } catch {
          /* fall back to the scripted flick */
        }
      }
      // mobile WebKit has no wheel and Playwright has no touch drag there: move the scroller frame by frame like a
      // flick (ease-out over 450 ms), which fires the same scroll events a finger does
      await page.evaluate(
        (d) =>
          new Promise((done) => {
            const sc = document.querySelector("[data-qa-scroller]");
            if (!sc) return done();
            const from = sc.scrollTop;
            const t0 = performance.now();
            const stepFrame = (now) => {
              const k = Math.min(1, (now - t0) / 450);
              sc.scrollTop = from + d * (1 - Math.pow(1 - k, 3));
              if (k < 1) requestAnimationFrame(stepFrame);
              else done();
            };
            requestAnimationFrame(stepFrame);
          }),
        dy,
      );
      methods.add("scripted flick");
    }
    const actions = [
      ["up", () => scroll(-620)],
      ["down", () => scroll(620)],
      ["up", () => scroll(-420)],
      ["down", () => scroll(420)],
      ["focus composer", () => composer(page).click()],
      ["up (focused)", () => scroll(-620)],
      ["down (focused)", () => scroll(620)],
      ["up (focused)", () => scroll(-420)],
      ["down (focused)", () => scroll(420)],
      ["blur", () => page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur())],
    ];
    const all = [];
    const per = [];
    let moved = 0;
    for (const [name, act] of actions) {
      await page.evaluate(() => window.__qa.sampleStart());
      await sleep(100);
      const a0 = Date.now();
      await act();
      await sleep(Math.max(0, SAMPLE_MS - (Date.now() - a0)));
      const res = await page.evaluate(() => window.__qa.sampleStop());
      const tops = res.samples.map((s) => s.top).filter((x) => x !== null);
      const delta = tops.length ? Math.max(...tops) - Math.min(...tops) : 0;
      moved += delta;
      const a = analyseScroll(res.samples, rest);
      per.push({ action: name, scrolledPx: delta, ...a });
      all.push(...res.samples);
      if (name === "up (focused)" && per.filter((x) => x.action === name).length === 1) await r.shot("chat-scrolled-focused");
    }
    await r.shot("chat-after-scroll");
    const total = analyseScroll(all, rest);
    r.metrics.scroll = { method: [...methods].join("+"), rest, perAction: per };
    r.check("the thread actually scrolled during the test", moved > 600, `${moved} px over ${actions.length} actions (${[...methods].join("+")})`);
    r.check("(a) tab bar and composer never overlap", total.overlap === 0, { frames: total.frames, overlapFrames: total.overlap, first: total.firstOverlap });
    r.check("(a) tab bar is never half-minimised", total.half === 0, { frames: total.frames, halfFrames: total.half, first: total.firstHalf, minimisedFrames: total.mini });
  });

  // ── 7 ──
  await r.flow("7 console / overflow / network", async () => {
    r.step = "final";
    r.check("0 console errors", r.errors.length === 0, r.errors.slice(0, 5));
    r.check("0 horizontal overflow at every screenshot", r.overflows.length === 0, r.overflows.slice(0, 3));
    r.check("the PWA only requests its own origin", r.external.length === 0, r.external.length ? r.external.slice(0, 5) : `${r.requests.api} /api + ${r.requests.static} static requests, all ${BASE}`);
  });

  // 6b's verdict (its checks were made inside flow 5)
  fb.ok = fb.checks.length > 0 && fb.checks.every((c) => c.ok);
  if (!fb.checks.length) fb.checks.push({ name: "(b) no close/back was sampled (flow 5 stopped early)", ok: false });
  if ((await bounded(browser.close(), 20_000)) === TIMED_OUT) console.log(`  (${engine} did not close in 20 s; left to the exit cleanup)`);
  return { engine, handle, flows: r.flows, metrics: r.metrics, consoleErrors: r.errors, overflows: r.overflows, externalRequests: r.external, requests: r.requests, shots: r.shots };
}

// ── main ──

async function main() {
  fs.mkdirSync(outDir, { recursive: true });
  for (const f of fs.readdirSync(outDir)) if (ENGINES.some((e) => new RegExp(`^${e}-\\d\\d-.*\\.(png|jpg)$`).test(f))) fs.rmSync(path.join(outDir, f));
  let commit = "";
  try {
    if (src) throw Object.assign(new Error("exported"), { exported: true });
    commit = execSync("git rev-parse --short HEAD", { cwd: repo, encoding: "utf8" }).trim();
    const dirty = execSync("git status --porcelain -- apps/mobile apps/server packages", { cwd: repo, encoding: "utf8" }).trim();
    if (dirty) commit += ` + ${dirty.split("\n").length} uncommitted files (apps/mobile, apps/server, packages)`;
  } catch {
    /* not a checkout, or QA_REF */
  }
  if (src) commit = `${REF} = ${src.sha} (exported: server + app, no working-tree changes)`;
  // which app was built: this checkout's apps/mobile, or QA_APP_DIR (label it with QA_APP_REF, e.g. "HEAD abc1234")
  const appRef = process.env.QA_APP_REF || (process.env.QA_APP_DIR ? appDir : src ? `apps/mobile @ ${src.sha}` : `apps/mobile @ ${commit}`);
  const server = await startServer();
  let preview = null;
  const stopAll = () => {
    killGroup(preview?.proc);
    killGroup(server.proc);
  };
  process.on("SIGINT", () => (stopAll(), process.exit(130)));
  process.on("SIGTERM", () => (stopAll(), process.exit(143)));
  const results = [];
  try {
    console.log(`server ${API} model=${server.health.model} · data ${server.dataDir}${src ? ` · ${REF} = ${src.sha} exported to ${src.dir}` : ""}${appDir !== path.join(srcRoot, "apps/mobile") ? ` · app ${appDir}` : ""}`);
    preview = await startPreview();
    console.log(`production build ${preview.buildMs} ms · preview ${BASE} (/api → ${API})`);
    for (const engine of ENGINES) results.push(await runEngine(engine));
  } finally {
    stopAll();
    if (!KEEP) {
      fs.rmSync(server.dataDir, { recursive: true, force: true });
      if (preview?.dist) fs.rmSync(preview.dist, { recursive: true, force: true });
      if (src) fs.rmSync(src.dir, { recursive: true, force: true });
    }
  }
  const summary = results.flatMap((x) => x.flows.map((f) => ({ engine: x.engine, flow: f.name, ok: f.ok, ms: f.ms, failed: f.checks.filter((c) => !c.ok).map((c) => c.name) })));
  let prev = { results: [] };
  try {
    prev = JSON.parse(fs.readFileSync(path.join(outDir, "results.json"), "utf8"));
  } catch {
    /* first run */
  }
  const ran = new Set(results.map((x) => x.engine));
  const at = new Date().toISOString();
  const all = [...(prev.results || []).filter((x) => !ran.has(x.engine)), ...results.map((x) => ({ ...x, at, commit, app: appRef }))];
  const allSummary = [...(prev.summary || []).filter((x) => !ran.has(x.engine)), ...summary];
  fs.writeFileSync(
    path.join(outDir, "results.json"),
    JSON.stringify({ at, commit, app: appRef, server: { api: API, model: server.health.model, version: server.health.version }, preview: BASE, buildMs: preview?.buildMs, summary: allSummary, results: all }, null, 2),
  );
  console.log("\n" + summary.map((s) => `${s.ok ? "PASS" : "FAIL"} ${s.engine.padEnd(8)} ${s.flow.padEnd(40)} ${String(s.ms).padStart(6)} ms${s.failed.length ? `  ✗ ${s.failed.join("; ")}` : ""}`).join("\n"));
  process.exit(summary.every((s) => s.ok) ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
