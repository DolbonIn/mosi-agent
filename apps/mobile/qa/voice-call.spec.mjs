// Voice call QA (voice-call B, user pick 2026-11-12): the call card's layout and the island's call controls, then
// talking to the agent with scripted turns (answered inside the page, no LLM) and a mocked voice (/api/tts/stream via
// page.route). Run it from the repo root against a LIVE pickle server:
//   PICKLE_DATA_DIR=… PORT=8823 bun --env-file=… run apps/server/src/index.ts      (the server, separately)
//   QA_API=http://127.0.0.1:8823 node apps/mobile/qa/voice-call.spec.mjs
// Env: QA_API (default http://127.0.0.1:8791) · QA_PORT (preview, default 5188) · QA_BUILD=0 (reuse the build) ·
//      QA_DIST (default <tmp>/pickle-voice-call-qa-dist) · QA_ENGINES=chromium,webkit · QA_VARIANTS=light,dark,reduced
// Same harness as chat.spec.mjs (its preview, sign-up and scripted-speech helpers are copied here, not imported:
// chat.spec runs on import): the QA stub build served by `vite preview` (proxying /api), 390×844 @3x in installed
// Google Chrome (channel "chrome", fake media devices) and Playwright WebKit. Never runs `playwright install`.
// Checks per pass:
//   card   the top keeps only the minimise chevron; name + status are the character's caption (right under the 208 px
//          character, centred); no level bar; 64 px controls named 음소거 · 스피커 · 통화 종료 whatever their state,
//          the state in aria-pressed and an 88 % fill; the end red is --call-end #d70015 in both themes and its icon
//          keeps ≥ 3:1 against it (graphic minimum; --danger in dark was 2.82:1), on the island too; "깽이와 통화";
//          with speech recognition no "말씀하시면…" note; without it the "음성 인식을 쓸 수 없어서…" note + typing;
//          a mic granted late: the "마이크 허용을 기다리고 있어요…" note and typing until it joins, then neither;
//          the same without speech recognition: that note turns into the "음성 인식을 쓸 수 없어서…" one, typing stays.
//   talk   a finished line is sent at once; the reply is spoken while it streams ("확인해 볼게요." while its tool runs,
//          thinking again until the rest), stream requests only, one in flight, the whole reply once; an unfinished
//          line ("내일 회의 자료를") waits for the rest and goes as one line, or alone after 1.5 s; a line said before
//          the first audio is steered into the running turn (202, one reply, the voice held while they talk and
//          started over after, the steered answer said) — or, once that turn has ended, a turn of its own answered
//          after the unheard reply, which is said first; talking over the voice cuts it and stops the turn, their
//          line is a new turn; a done text that no longer starts with what was said stops the voice and says none of it.
//   heard  a cut-off reply reports what was heard of it (POST …/heard: whole words, a prefix of what was said, about as
//          much as played) and the next line waits for that report (≤ 1 s); a line meant as a steer that the server
//          started as a turn of its own (the running turn ended in between) is that thread's running turn: a barge-in
//          stops it too.
//   level  Chrome (fake capture device): the real mic level reaches the island's dots and stretches them; muted
//          (level 0) they are five round 4 × 4 px dots.
//   island a tap opens the card; a long-press (500 ms) grows it in place into 음소거 · 통화 종료 (no 스피커, no card),
//          "듣고 있어요 · 00:12"; its mute is the call's mute (mirrored on the card); it folds after 4 s untouched, on
//          Escape and on a tap outside; with the card up a long-press changes nothing; its 통화 종료 ends the call.
//   plus   0 console errors, 0 horizontal overflow at every screenshot.
// Results: docs/qa/voice-call/results.json · screenshots: docs/qa/voice-call/<engine>-<variant>-NN-name.jpg
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
const outDir = path.join(repo, "docs/qa/voice-call");
fs.mkdirSync(outDir, { recursive: true });
const API = process.env.QA_API || "http://127.0.0.1:8791";
const PORT = Number(process.env.QA_PORT || 5188);
const BASE = `http://127.0.0.1:${PORT}`;
const DIST = process.env.QA_DIST || path.join(os.tmpdir(), "pickle-voice-call-qa-dist");
const ENGINES = (process.env.QA_ENGINES || "chromium,webkit").split(",");
const VARIANTS = (process.env.QA_VARIANTS || "light,dark,reduced").split(",");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = () => crypto.randomBytes(4).toString("hex");
const APP_HTML = /모시|피클/;
const END_RED = "rgb(215, 0, 21)";

// ── server + app (as chat.spec.mjs) ──

async function up(url, needle) {
  try {
    const r = await fetch(url);
    return r.ok && (!needle || needle.test(await r.text()));
  } catch {
    return false;
  }
}

async function startPreview() {
  if (!(await up(`${API}/api/health`))) throw new Error(`pickle server is not answering at ${API}`);
  if (process.env.QA_BUILD !== "0" || !fs.existsSync(path.join(DIST, "index.html"))) {
    const b = spawnSync("bunx", ["vite", "build", "-c", "qa/vite.qa.config.mjs", "--outDir", DIST, "--emptyOutDir"], { cwd: appDir, stdio: "pipe", encoding: "utf8" });
    if (b.status !== 0) throw new Error(`build failed:\n${b.stdout}\n${b.stderr}`);
  }
  if (await up(`${BASE}/`, APP_HTML)) throw new Error(`port ${PORT} is already serving something; set QA_PORT`);
  // own process group: bunx → node vite; killing only bunx would orphan the server on the port
  const proc = spawn("bunx", ["vite", "preview", "--outDir", DIST, "--port", String(PORT), "--strictPort", "--host", "127.0.0.1"], {
    cwd: appDir,
    stdio: "ignore",
    detached: true,
    env: { ...process.env, PICKLE_API: API },
  });
  proc.stopAll = () => {
    try {
      process.kill(-proc.pid, "SIGTERM");
    } catch {
      proc.kill();
    }
  };
  const ours = fs.readFileSync(path.join(DIST, "index.html"), "utf8");
  for (let i = 0; i < 100; i++) {
    if (await up(`${BASE}/`, APP_HTML)) {
      // strictPort fails quietly in a detached child: make sure the page on the port is THIS build, not another preview
      const served = await fetch(`${BASE}/`).then((r) => r.text()).catch(() => "");
      if (served === ours) return proc;
      proc.stopAll();
      throw new Error(`port ${PORT} serves a different build than ${DIST}; set QA_PORT`);
    }
    await sleep(150);
  }
  proc.stopAll();
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

/** sign up through the API (server: 10 sign-ups per minute per IP → wait and retry on 429). Synthetic: 하늘 / 깽이 */
async function signupApi() {
  for (let i = 0; i < 4; i++) {
    const kp = await crypto.webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const jwk = await crypto.webcrypto.subtle.exportKey("jwk", kp.publicKey);
    const r = await api("POST", "/api/auth/signup", { handle: `qavc${rand()}`, password: "qa-pass-1234", displayName: "하늘", agentName: "깽이", device: { id: `qa-${rand()}`, label: "QA node", signingKey: jwk } });
    if (r.status === 201 || r.status === 200) return r.body;
    if (r.status === 429) {
      await sleep(20_000);
      continue;
    }
    throw new Error(`signup: ${r.status} ${JSON.stringify(r.body)}`);
  }
  throw new Error("signup rate limited");
}

/** a recogniser the test controls (it hears nothing unless told); WebKit also gets a silent mic (no fake device) */
const SCRIPTED_SPEECH = (silentMic) => {
  if (silentMic) {
    const fakeMic = async () => {
      window.__micCtx ??= new AudioContext();
      return window.__micCtx.createMediaStreamDestination().stream;
    };
    MediaDevices.prototype.getUserMedia = fakeMic;
    navigator.mediaDevices.getUserMedia = fakeMic;
  }
  class ScriptedRecognition {
    constructor() {
      Object.assign(this, { lang: "", continuous: false, interimResults: false, maxAlternatives: 1, onresult: null, onerror: null, onend: null });
    }
    start() {
      window.__rec.cur = this;
    }
    stop() {
      if (window.__rec.cur === this) window.__rec.cur = null;
      setTimeout(() => this.onend?.(), 0);
    }
    abort() {
      this.stop();
    }
  }
  window.__rec = { cur: null };
  window.__scriptedSR = ScriptedRecognition;
  window.SpeechRecognition = ScriptedRecognition;
};

async function overflow(page) {
  return page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const doc = document.documentElement.scrollWidth - vw;
    const offenders = [];
    for (const sc of document.querySelectorAll(".screen-scroll, .call-inner")) {
      const scr = sc.getBoundingClientRect();
      if (!scr.width) continue;
      for (const el of sc.querySelectorAll("*")) {
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height || (r.width <= 1 && r.height <= 1)) continue;
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
    return { doc, offenders: offenders.slice(0, 5) };
  });
}

class Pass {
  constructor(engine, variant, page) {
    this.tag = `${engine}-${variant}`;
    this.page = page;
    this.n = 0;
    this.shots = [];
    this.overflows = [];
    this.checks = [];
    this.errors = [];
    this.step = "load";
  }
  async shot(name) {
    const file = path.join(outDir, `${this.tag}-${String(++this.n).padStart(2, "0")}-${name}.jpg`);
    await this.page.screenshot({ path: file, type: "jpeg", quality: 82 });
    this.shots.push(path.relative(repo, file));
    const o = await overflow(this.page);
    if (o.doc > 0 || o.offenders.length) this.overflows.push({ at: name, ...o });
  }
  check(name, ok, detail) {
    this.checks.push({ name, ok: !!ok, ...(detail === undefined ? {} : { detail }) });
    console.log(`  ${ok ? "ok  " : "FAIL"} ${this.tag} ${name}${detail !== undefined ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  }
}

// ── page probes ──

const near = (a, b, d = 1) => Math.abs(a - b) <= d;
/** WCAG contrast of a CSS colour over an opaque one ("rgb(…)" / "rgba(…)" / "color(srgb …)"), the fg composited first */
function contrast(fg, bg) {
  const parse = (c) => {
    const n = String(c).match(/[\d.]+/g)?.map(Number) ?? [];
    const srgb = /^color\(srgb/.test(c);
    const [r, g, b] = (srgb ? n.slice(0, 3).map((v) => v * 255) : n.slice(0, 3));
    return { r, g, b, a: n.length > 3 ? n[3] : 1 };
  };
  const f = parse(fg);
  const k = parse(bg);
  const mix = (x, y) => x * f.a + y * (1 - f.a);
  const lum = ({ r, g, b }) => {
    const ch = (v) => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
  };
  const a = lum({ r: mix(f.r, k.r), g: mix(f.g, k.g), b: mix(f.b, k.b) });
  const b = lum(k);
  return Math.round(((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)) * 100) / 100;
}
/** the call's level as drawn: the island's five dots (--lvl 0..1); the card has no meter of its own */
const islandLevel = (page) => page.evaluate(() => Number(document.querySelector(".island-anchor[data-kind=call] .island-dots")?.style.getPropertyValue("--lvl") || 0));
const dotSizes = (page) =>
  page.evaluate(() => [...document.querySelectorAll(".island-anchor[data-kind=call] .island-dots i")].map((i) => i.getBoundingClientRect()).map((r) => [Math.round(r.width * 10) / 10, Math.round(r.height * 10) / 10]));
const phase = (page) => page.evaluate(() => document.querySelector(".call-card")?.dataset.phase || "");
const expandedCount = (page) => page.locator(".island[data-expanded]").count();
const cardCount = (page) => page.locator(".call-card").count();

/** the card's layout, as the person sees it */
const cardLayout = (page) =>
  page.evaluate(() => {
    const card = document.querySelector(".call-card");
    const box = (el) => el && el.getBoundingClientRect();
    const blob = box(card?.querySelector(".call-stage > :first-child"));
    const name = box(card?.querySelector(".call-name"));
    const ph = box(card?.querySelector(".call-phase"));
    const head = card?.querySelector(".call-head");
    const alpha = (c) => {
      const m = /\/\s*([\d.]+)\s*\)$/.exec(c) || /^rgba\([^)]*,\s*([\d.]+)\)$/.exec(c);
      return m ? Number(m[1]) : 1;
    };
    return {
      label: card?.getAttribute("aria-label"),
      blob: blob && { top: blob.top, bottom: blob.bottom, cx: blob.left + blob.width / 2, w: blob.width },
      name: name && { top: name.top, bottom: name.bottom, cx: name.left + name.width / 2 },
      phase: ph && { top: ph.top, cx: ph.left + ph.width / 2, text: card.querySelector(".call-phase").textContent },
      head: head ? [...head.querySelectorAll("button, [class^=call-]")].map((c) => c.getAttribute("aria-label") || c.className) : [],
      meter: card?.querySelectorAll(".call-level").length ?? -1,
      labels: [...(card?.querySelectorAll(".call-btn-label") ?? [])].map((l) => l.textContent),
      btns: [...(card?.querySelectorAll(".call-controls .call-btn") ?? [])].map((b) => {
        const r = b.getBoundingClientRect();
        const bg = getComputedStyle(b).backgroundColor;
        const fg = getComputedStyle(b.querySelector("svg") || b).color; // the icon strokes in currentColor
        return { name: b.getAttribute("aria-label"), pressed: b.getAttribute("aria-pressed"), w: r.width, h: r.height, bg, a: alpha(bg), fg };
      }),
      notes: [...(card?.querySelectorAll(".call-line[data-who=note]") ?? [])].map((l) => l.textContent),
      typing: !!card?.querySelector(".call-type-input"),
    };
  });

const islandState = (page) =>
  page.evaluate(() => ({
    expanded: !!document.querySelector(".island[data-expanded]"),
    card: !!document.querySelector(".call-card"),
    group: document.querySelector(".island-call")?.getAttribute("aria-label") || "",
    buttons: [...document.querySelectorAll(".island-call button")].map((b) => [b.getAttribute("aria-label"), b.getAttribute("aria-pressed")]),
    status: document.querySelector(".island-call-status")?.textContent || "",
    end: getComputedStyle(document.querySelector(".island-call .island-btn.end") || document.body).backgroundColor,
    endFg: getComputedStyle(document.querySelector(".island-call .island-btn.end svg") || document.body).color,
  }));

async function longPress(page) {
  const pill = await page.locator(".island").boundingBox();
  await page.mouse.move(pill.x + pill.width / 2, pill.y + 18);
  await page.mouse.down();
  await sleep(650);
  await page.mouse.up();
  await sleep(500);
}
async function tapIsland(page) {
  const pill = await page.locator(".island").boundingBox();
  await page.mouse.click(pill.x + pill.width / 2, pill.y + 18);
}
async function openCall(page) {
  await page.getByRole("button", { name: "통화하기" }).click({ timeout: 60_000 });
  await page.waitForSelector(".call-card", { timeout: 8000 });
  return page
    .waitForFunction(() => document.querySelector(".call-card")?.dataset.phase === "listening", null, { timeout: 10_000 })
    .then(() => true)
    .catch(() => false);
}

// ── talking to the agent: scripted turns and a mocked voice ──

/** letters and digits only (the stream text closes sentences with punctuation the voice requests may drop) */
const lettersOnly = (s) => String(s || "").replace(/[^\p{L}\p{N}]/gu, "");
const TALK_PCM_RATE = 22050;
/** `seconds` of a modulated 220 Hz tone, s16le mono (an audible level, so the voice's meter moves) */
function tonePcm(seconds) {
  const n = Math.round(TALK_PCM_RATE * seconds);
  const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const t = i / TALK_PCM_RATE;
    b.writeInt16LE(Math.round(0.6 * Math.sin(2 * Math.PI * 220 * t) * (0.55 + 0.45 * Math.sin(2 * Math.PI * 2.5 * t)) * 32767), i * 2);
  }
  return b;
}

/**
 * Scripted turns, inside the page: every voice-mode POST to /api/threads/:id/messages is answered locally (no LLM).
 * While a scripted stream is open, a POST is a steer (202 {steered, userMessage}), as the server answers a line sent
 * into a running turn; otherwise it takes the next plan from window.__talk.plans and streams it:
 *   steps: ["text", s] (deltas of 3 characters every `everyMs`) · ["wait", ms] · ["tool", state] · ["steer", maxMs]
 *          (waits for a steer) · ["done", text?] (the done message: the deltas joined, or `text` to make it diverge)
 *   endsOnSteer: a line sent into this turn ends it at once (done) and is answered as a turn of its own (a stream with
 *          the next plan), as the server does when the running turn finished in between
 * Heard reports (POST …/messages/:id/heard) are answered here too: 204 after window.__talk.heardDelay ms, kept in
 * window.__talk.heard ({messageId, heard, at, doneAt}).
 * Recorded with Date.now(): posts (text, kind, when it was aborted / done, its steps), the card's phase changes, and
 * every transcript line seen (by id). Everything else goes to the real fetch.
 */
async function installTalk(page) {
  await page.evaluate(() => {
    const real = window.__realFetch ?? window.fetch.bind(window);
    window.__realFetch = real;
    const T = (window.__talk = { posts: [], plans: [], phases: [], lines: {}, steerWaiters: [], heard: [], heardDelay: 0 });
    let last = "";
    setInterval(() => {
      const p = document.querySelector(".call-card")?.dataset.phase || "";
      if (p !== last) T.phases.push({ p: (last = p), t: Date.now() });
      // the text without its screen-reader speaker prefix ("나: ", "깽이: ")
      for (const li of document.querySelectorAll(".call-line[data-line]"))
        T.lines[li.dataset.line] = { who: li.dataset.who, text: [...li.childNodes].filter((n) => !n.classList?.contains("sr-only")).map((n) => n.textContent).join("") };
    }, 10);
    const enc = new TextEncoder();
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const deltas = (s) => Array.from({ length: Math.ceil(s.length / 3) }, (_, i) => s.slice(i * 3, i * 3 + 3));
    window.fetch = async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input.url, location.href);
      const hm = /^\/api\/threads\/[^/]+\/messages\/([^/]+)\/heard$/.exec(url.pathname);
      if (hm && init?.method === "POST") {
        const h = { messageId: decodeURIComponent(hm[1]), heard: JSON.parse(init.body || "{}").heard, at: Date.now(), doneAt: 0 };
        T.heard.push(h);
        await wait(T.heardDelay);
        h.doneAt = Date.now();
        return new Response(null, { status: 204 });
      }
      const m = /^\/api\/threads\/([^/]+)\/messages$/.exec(url.pathname);
      let body = null;
      try {
        body = m && init?.method === "POST" ? JSON.parse(init.body || "{}") : null;
      } catch {}
      if (!body || body.mode !== "voice") return real(input, init);
      const threadId = decodeURIComponent(m[1]);
      const now = Date.now();
      const post = { i: T.posts.length, text: body.text, at: now, kind: "", aborted: 0, doneAt: 0, steers: 0, steps: [] };
      T.posts.push(post);
      const userMessage = { id: `u_qa_${now}_${post.i}`, threadId, role: "user", text: body.text, cards: [], tools: [], attachments: [], createdAt: now };
      const open = T.posts.find((p) => p.kind === "stream" && !p.doneAt && !p.aborted);
      if (open?.endsOnSteer) {
        // the running turn finished just before this line arrived: it ends, and the line gets a turn of its own
        post.late = true;
        open.endsOnSteer = false;
        open.finish();
      } else if (open) {
        post.kind = "steered";
        open.steers++;
        for (const w of T.steerWaiters.splice(0)) w();
        return new Response(JSON.stringify({ steered: true, userMessage }), { status: 202, headers: { "content-type": "application/json" } });
      }
      post.kind = "stream";
      const plan = T.plans.shift() || { steps: [["text", "네."], ["done"]] };
      const mid = `m_qa_${now}_${post.i}`;
      post.messageId = mid;
      post.endsOnSteer = !!plan.endsOnSteer;
      let gone = false;
      init?.signal?.addEventListener(
        "abort",
        () => {
          gone = true;
          post.aborted = Date.now();
        },
        { once: true },
      );
      let text = "";
      const stream = new ReadableStream({
        async start(c) {
          const send = (o) => {
            if (gone) return;
            try {
              c.enqueue(enc.encode(`data: ${JSON.stringify(o)}\n\n`));
            } catch {
              gone = true;
            }
          };
          const quota = () => ({ usedPct: 1, usedTokens: 1000, limitTokens: 100000, resetsAt: Date.now() + 3600_000, resetHour: 4 });
          /** done now, with the text so far (endsOnSteer) */
          post.finish = () => {
            if (gone || post.doneAt) return;
            post.reply = text;
            send({ type: "done", message: { id: mid, threadId, role: "assistant", text, cards: [], tools: [], attachments: [], createdAt: Date.now() }, quota: quota() });
            post.doneAt = Date.now();
            gone = true;
            try {
              c.close();
            } catch {}
          };
          send({ type: "start", messageId: mid, userMessage });
          await wait(plan.firstMs ?? 200);
          for (const [kind, arg] of plan.steps) {
            if (gone) break;
            if (kind === "text") {
              for (const d of deltas(arg)) {
                if (gone) break;
                text += d;
                send({ type: "text", delta: d });
                await wait(plan.everyMs ?? 25);
              }
            } else if (kind === "wait") await wait(arg);
            else if (kind === "steer") {
              if (!post.steers) await Promise.race([new Promise((r) => T.steerWaiters.push(r)), wait(arg ?? 8000)]);
            } else if (kind === "tool")
              send({ type: "tool", tool: { id: `t_qa_${post.i}`, name: "k.weather", title: "서울 날씨 확인", state: arg, startedAt: now, ...(arg === "running" ? {} : { endedAt: Date.now(), summary: "맑음" }) } });
            else if (kind === "done") {
              post.reply = arg ?? text;
              send({ type: "done", message: { id: mid, threadId, role: "assistant", text: post.reply, cards: [], tools: [], attachments: [], createdAt: Date.now() }, quota: quota() });
              post.doneAt = Date.now();
            }
            post.steps.push({ kind: kind === "tool" ? `tool:${arg}` : kind, t: Date.now(), gone });
          }
          if (!gone)
            try {
              c.close();
            } catch {}
        },
        cancel() {
          // the client stopped reading (its stop cancels the reader once the headers are in): the turn is stopped
          gone = true;
          if (!post.doneAt) post.aborted ||= Date.now();
        },
      });
      return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
    };
  });
}

/**
 * The voice, mocked: /api/tts/stream answers `delay` ms later with `perLetter` s of tone per letter (page.route can't
 * stream: the whole body at once). A request the page aborted (the voice dropped or cut off) is marked failed: its
 * text was never heard. /api/tts (sentence fallback) is refused, and counted: the stream path must carry the call.
 */
async function installTalkTts(page) {
  const tts = { reqs: [], sentence: 0, delay: 200, perLetter: 0.08 };
  const byReq = new Map();
  await page.route("**/api/tts/stream", async (route) => {
    const req = route.request();
    let text = "";
    try {
      text = JSON.parse(req.postData() || "{}").text || "";
    } catch {
      /* not JSON */
    }
    const e = { text, at: Date.now(), done: 0, failed: false, bearer: /^Bearer \S+/.test(req.headers()["authorization"] || "") };
    tts.reqs.push(e);
    byReq.set(req, e);
    await sleep(tts.delay);
    e.done = Date.now();
    const secs = Math.min(4, Math.max(0.3, lettersOnly(text).length * tts.perLetter));
    const headers = { "Content-Type": `audio/L16; rate=${TALK_PCM_RATE}; channels=1`, "X-Sample-Rate": String(TALK_PCM_RATE), "Cache-Control": "no-store" };
    await route.fulfill({ status: 200, headers, body: tonePcm(secs) }).catch(() => (e.failed = true));
  });
  await page.route("**/api/tts", (route) => {
    tts.sentence++;
    return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "tts_unavailable" }) }).catch(() => {});
  });
  page.on("requestfailed", (r) => {
    const e = byReq.get(r);
    if (e) e.failed = true;
  });
  /** the requests from index `from` on that were heard (not aborted), their texts in order */
  tts.heard = (from = 0) => tts.reqs.slice(from).filter((e) => !e.failed).map((e) => e.text);
  return tts;
}

/** the scripted recogniser hears `text` (an interim result, or the final one); waits for a fresh recogniser first */
async function hear(page, text, final) {
  await page.waitForFunction(() => !!window.__rec.cur?.onresult && !window.__rec.cur.__final, null, { timeout: 5000 });
  return page.evaluate(
    ([t, f]) => {
      const r = window.__rec.cur;
      if (f) r.__final = true;
      r.onresult({ resultIndex: 0, results: [Object.assign({ isFinal: f, 0: { transcript: t } }, { length: 1 })] });
      return Date.now();
    },
    [text, final],
  );
}
const talk = (page) =>
  page.evaluate(() => ({ posts: window.__talk.posts.map(({ finish, ...p }) => p), phases: window.__talk.phases, lines: window.__talk.lines, heard: window.__talk.heard }));
/** wait (polling) until `pred(await talk(page))` holds; false on timeout */
async function until(page, pred, ms = 10_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred(await talk(page))) return true;
    await sleep(40);
  }
  return false;
}
const listening = (page, ms = 10_000) =>
  page
    .waitForFunction(() => document.querySelector(".call-card")?.dataset.phase === "listening", null, { timeout: ms })
    .then(() => true)
    .catch(() => false);
/** the phases the card went through from `t` on (Date.now()), repeats folded */
const phasesSince = (tk, t) => tk.phases.filter((x) => x.t >= t).map((x) => x.p);
/** the transcript lines first seen after `before` (a snapshot of tk.lines' keys) */
const newLines = (tk, before) => Object.entries(tk.lines).filter(([id]) => !before.includes(id)).map(([, l]) => l);

// ── the pass ──

async function runPass(browserType, engine, variant) {
  const isChrome = engine === "chromium";
  const browser = await browserType.launch(isChrome ? { channel: "chrome", args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] } : {});
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    colorScheme: variant === "dark" ? "dark" : "light",
    reducedMotion: variant === "reduced" ? "reduce" : "no-preference",
    locale: "ko-KR",
  });
  if (isChrome) await context.grantPermissions(["microphone"], { origin: BASE });
  await context.addInitScript(SCRIPTED_SPEECH, !isChrome);
  const page = await context.newPage();
  const p = new Pass(engine, variant, page);
  page.on("console", (m) => m.type() === "error" && p.errors.push({ step: p.step, text: m.text().slice(0, 300) }));
  page.on("pageerror", (e) => p.errors.push({ step: p.step, text: String(e).slice(0, 300) }));

  try {
    const made = await signupApi();
    await page.goto(`${BASE}/`, { waitUntil: "load" });
    await page.evaluate((t) => localStorage.setItem("pickle.token", t), made.token);
    await page.goto(`${BASE}/`, { waitUntil: "load" });
    await page.waitForSelector("textarea.composer-field", { timeout: 20_000 });

    // ── the card ──
    p.step = "card";
    p.check("the call connects and listens", await openCall(page));
    await sleep(1300);
    await p.shot("call-card");
    const lay = await cardLayout(page);
    p.check("the top keeps only the minimise chevron (no name or status up there)", lay.head.length === 1 && lay.head[0] === "통화 화면 접기", lay.head);
    p.check(
      "name and status sit right under the 208 px character, centred on it",
      !!(lay.blob && lay.name && lay.phase) && lay.blob.w === 208 && lay.name.top >= lay.blob.bottom - 1 && lay.name.top - lay.blob.bottom <= 24 && lay.phase.top >= lay.name.bottom - 1 && near(lay.name.cx, lay.blob.cx) && near(lay.phase.cx, lay.blob.cx),
      { blob: lay.blob, name: lay.name, phase: lay.phase },
    );
    p.check("the status reads '듣고 있어요'", lay.phase?.text === "듣고 있어요", lay.phase?.text);
    p.check("no level bar under the character (it takes the level itself)", lay.meter === 0);
    p.check("the dialog's name takes the right particle (깽이와 통화)", lay.label === "깽이와 통화", lay.label);
    const [mute, speaker, end] = lay.btns;
    p.check("three 64 px controls named 음소거 · 스피커 · 통화 종료", lay.btns.length === 3 && lay.btns.every((b) => b.w === 64 && b.h === 64) && JSON.stringify(lay.labels) === JSON.stringify(["음소거", "스피커", "통화 종료"]), { labels: lay.labels, sizes: lay.btns.map((b) => [b.w, b.h]) });
    p.check("speaker on = aria-pressed + an 88 % fill (no white disc); mute off and unpressed", speaker?.pressed === "true" && near(speaker.a, 0.88, 0.01) && mute?.pressed === "false" && near(mute.a, 0.16, 0.01), { speaker, mute });
    p.check("end is --call-end #d70015 in both themes", end?.bg === END_RED, end?.bg);
    const endRatio = end ? contrast(end.fg, end.bg) : 0;
    p.check("the end icon keeps ≥ 3:1 against the end red (graphic minimum)", endRatio >= 3, { fg: end?.fg, bg: end?.bg, ratio: endRatio });
    p.check("with speech recognition: no note in the captions (the status says it), no typing field", lay.notes.length === 0 && !lay.typing, lay.notes);

    // ── the level: the real mic reaches the island's dots (Chrome's fake capture device beeps) ──
    p.step = "level";
    if (isChrome) {
      const levels = [];
      let tallest = 0;
      for (let i = 0; i < 16; i++) {
        levels.push(await islandLevel(page));
        tallest = Math.max(tallest, ...(await dotSizes(page)).map(([, h]) => h));
        await sleep(120);
      }
      p.check("the mic's real level moves the island's dots (and stretches them past 4 px)", new Set(levels).size > 1 && Math.max(...levels) > 0.02 && tallest > 4.5, { levels: levels.slice(0, 6), tallest });
    }

    p.step = "toggles";
    const card = page.locator(".call-card");
    const speakerBtn = card.getByRole("button", { name: "스피커", exact: true });
    await speakerBtn.click();
    await sleep(250);
    const speakerOff = { pressed: await speakerBtn.getAttribute("aria-pressed"), label: await card.locator(".call-btn-label").nth(1).textContent() };
    await speakerBtn.click();
    await sleep(250);
    p.check("toggling the speaker keeps its name '스피커'; the state is aria-pressed", speakerOff.pressed === "false" && speakerOff.label === "스피커" && (await speakerBtn.getAttribute("aria-pressed")) === "true", speakerOff);
    const muteBtn = card.getByRole("button", { name: "음소거", exact: true });
    await muteBtn.click();
    await sleep(500);
    const muted = { pressed: await muteBtn.getAttribute("aria-pressed"), phase: await phase(page), label: await card.locator(".call-btn-label").first().textContent(), status: await card.locator(".call-phase").textContent() };
    p.check("mute: pressed, the call pauses ('음소거 중'), the name stays '음소거'", muted.pressed === "true" && muted.phase === "paused" && muted.label === "음소거" && muted.status === "음소거 중", muted);
    const dots = await dotSizes(page);
    p.check("level 0 (muted): the island shows five round 4 × 4 px dots, not dashes", dots.length === 5 && dots.every(([w, h]) => w === 4 && h === 4), dots);
    await p.shot("call-muted");
    await muteBtn.click();
    await sleep(400);
    p.check("unmute: unpressed, listening again", (await muteBtn.getAttribute("aria-pressed")) === "false" && (await phase(page)) === "listening");

    // ── the island: tap = the card, long-press = the controls in place ──
    p.step = "island";
    await page.getByRole("button", { name: "통화 화면 접기" }).click();
    await page.waitForSelector(".call-card", { state: "detached", timeout: 8000 }).catch(() => {});
    await sleep(600);
    p.check("minimised: the island keeps the call", (await page.locator(".island-anchor[data-kind=call]").count()) === 1);
    await p.shot("call-island");
    await longPress(page);
    const ex = await islandState(page);
    p.check("a long-press opens 음소거 · 통화 종료 on the island in place (no card, no 스피커)", ex.expanded && !ex.card && ex.group === "깽이와 통화 중" && JSON.stringify(ex.buttons) === JSON.stringify([["음소거", "false"], ["통화 종료", null]]), ex);
    p.check("the expanded island says what the call is doing, with the timer", /^듣고 있어요 · \d\d:\d\d$/.test(ex.status), ex.status);
    p.check("the island's end is the same --call-end red", ex.end === END_RED, ex.end);
    const islandEndRatio = contrast(ex.endFg, ex.end);
    p.check("the island's end icon keeps ≥ 3:1 against it too", islandEndRatio >= 3, { fg: ex.endFg, bg: ex.end, ratio: islandEndRatio });
    await p.shot("call-island-expanded");
    const islandMute = page.locator(".island-call").getByRole("button", { name: "음소거", exact: true });
    await islandMute.click();
    await sleep(300);
    const im = { pressed: await islandMute.getAttribute("aria-pressed"), status: (await page.locator(".island-call-status").textContent()) || "" };
    p.check("음소거 on the island mutes the call ('음소거 중'), its name unchanged", im.pressed === "true" && im.status.startsWith("음소거 중 · "), im);
    await islandMute.click();
    await sleep(300);
    p.check("…and unmutes it", (await islandMute.getAttribute("aria-pressed")) === "false" && ((await page.locator(".island-call-status").textContent()) || "").startsWith("듣고 있어요 · "));
    const t0 = Date.now();
    const folded = await page.waitForSelector(".island[data-expanded]", { state: "detached", timeout: 7000 }).then(() => Date.now() - t0).catch(() => -1);
    p.check("left alone, it folds 4 s after the last touch", folded >= 3000 && folded <= 4800, `${folded} ms after the wait began (last touch ≈ 300 ms before)`);

    p.step = "island-escape";
    await longPress(page);
    await islandMute.click();
    await sleep(300);
    await page.keyboard.press("Escape");
    await sleep(500);
    p.check("Escape folds it", (await expandedCount(page)) === 0 && (await cardCount(page)) === 0);
    await tapIsland(page);
    const reopened = await page.waitForSelector(".call-card", { timeout: 8000 }).then(() => true).catch(() => false);
    await sleep(900);
    p.check("a tap on the island brings the card back", reopened);
    p.check("the island's mute is the call's: the card shows it pressed and paused", (await muteBtn.getAttribute("aria-pressed")) === "true" && (await phase(page)) === "paused");
    await muteBtn.click();
    await sleep(300);

    p.step = "island-over-card";
    await longPress(page);
    p.check("with the card up a long-press on the island changes nothing", (await expandedCount(page)) === 0 && (await cardCount(page)) === 1);

    p.step = "island-outside";
    await page.getByRole("button", { name: "통화 화면 접기" }).click();
    await page.waitForSelector(".call-card", { state: "detached", timeout: 8000 }).catch(() => {});
    await sleep(600);
    await longPress(page);
    const again = (await expandedCount(page)) === 1;
    await page.mouse.click(6, 430); // the gutter beside the thread: nothing to press there
    await sleep(600);
    p.check("a tap outside folds it and opens nothing", again && (await expandedCount(page)) === 0 && (await cardCount(page)) === 0, { again });

    p.step = "island-end";
    await longPress(page);
    await page.locator(".island-call").getByRole("button", { name: "통화 종료" }).click();
    await sleep(800);
    p.check("통화 종료 on the island ends the call (no island call, no card)", (await page.locator(".island-anchor[data-kind=call]").count()) === 0 && (await cardCount(page)) === 0);

    // ── talking to the agent (scripted turns, mocked voice): the reply is spoken while it streams, an unfinished line
    //    waits for the rest, a line said before the first audio is steered into the running turn, talking over the
    //    voice stops it and the turn, a done text that no longer starts with what was said is not said ──
    p.step = "talk";
    await installTalk(page);
    const tts = await installTalkTts(page);
    p.check("the call connects again (for talking)", await openCall(page));
    await sleep(600);

    p.step = "talk-stream";
    {
      const tk0 = await talk(page);
      const before = Object.keys(tk0.lines);
      const posts0 = tk0.posts.length;
      const r0 = tts.reqs.length;
      tts.delay = 200;
      tts.perLetter = 0.08;
      await page.evaluate(() =>
        window.__talk.plans.splice(0, Infinity, { firstMs: 250, steps: [["text", "확인해 볼게요."], ["tool", "running"], ["wait", 2500], ["tool", "done"], ["text", "\n\n내일 서울은 맑고 따뜻하대요. 낮 기온은 십팔 도까지 올라가요. 우산은 필요 없어요."], ["done"]] }),
      );
      const tFinal = await hear(page, "내일 서울 날씨 알려 줘", true);
      await until(page, (tk) => tk.posts.length > posts0 && !!tk.posts[posts0].doneAt, 15_000);
      const back = await listening(page, 15_000);
      await sleep(200);
      const tk = await talk(page);
      const post = tk.posts[posts0] ?? {};
      const at = (k) => post.steps?.find((s) => s.kind === k)?.t ?? 0;
      const [toolRun, toolDone] = [at("tool:running"), at("tool:done")];
      const reqs = tts.reqs.slice(r0);
      const heard = tts.heard(r0);
      p.check("a finished line is sent at once (< 400 ms after the final)", post.kind === "stream" && post.text === "내일 서울 날씨 알려 줘" && post.at - tFinal < 400, { kind: post.kind, ms: post.at - tFinal });
      p.check(
        "'확인해 볼게요.' goes to the voice while the tool runs, and is heard before the tool ends",
        !!reqs[0] && lettersOnly(reqs[0].text) === "확인해볼게요" && reqs[0].at < toolDone && tk.phases.some((x) => x.p === "speaking" && x.t > toolRun && x.t < toolDone),
        { first: reqs[0]?.text, askedBeforeToolEnd: reqs[0] && toolDone - reqs[0].at },
      );
      const ph = phasesSince(tk, tFinal);
      p.check("the call speaks, thinks again during the tool, speaks the rest, then listens", back && /speaking.*thinking.*speaking.*listening/.test(ph.join(" ")), ph);
      p.check("the voice starts before the reply is over", !!reqs[0] && !!post.doneAt && reqs[0].at < post.doneAt, reqs[0] && post.doneAt - reqs[0].at);
      p.check(
        "stream requests only, each with the bearer token, one in flight (the next asked for once the previous arrived)",
        reqs.length >= 2 && tts.sentence === 0 && reqs.every((e) => e.bearer) && reqs.every((e, i) => i === 0 || e.at >= reqs[i - 1].done - 5),
        reqs.map((e) => [lettersOnly(e.text).length, e.at - reqs[0].at, e.done - reqs[0].at]),
      );
      p.check("what was said is the whole reply, in order, each piece once", heard.length === reqs.length && lettersOnly(heard.join("")) === lettersOnly(post.reply), heard);
      const lines = newLines(tk, before);
      const agent = lines.filter((l) => l.who === "agent");
      p.check("one line each, the person's and the reply's (which reads the whole reply)", lines.filter((l) => l.who === "me").length === 1 && agent.length === 1 && lettersOnly(agent[0].text) === lettersOnly(post.reply), lines);
      await p.shot("call-talk");
    }

    p.step = "talk-hold";
    {
      const tk0 = await talk(page);
      const before = Object.keys(tk0.lines);
      const posts0 = tk0.posts.length;
      await page.evaluate(() => window.__talk.plans.splice(0, Infinity, { steps: [["text", "네, 정리해 둘게요."], ["done"]] }, { steps: [["text", "어떤 문서 말씀이세요?"], ["done"]] }));
      await sleep(300);
      await hear(page, "내일 회의 자료를", true);
      await sleep(900);
      const early = (await talk(page)).posts.length - posts0;
      await hear(page, "정리해", false);
      await sleep(300);
      const tRest = await hear(page, "정리해 줘", true);
      await until(page, (tk) => tk.posts.length > posts0, 3000);
      await sleep(300); // the line is patched in the same tick as the send: let it render
      let tk = await talk(page);
      const joined = tk.posts[posts0] ?? {};
      p.check("an unfinished line ('내일 회의 자료를') waits: nothing sent 0.9 s later", early === 0, early);
      p.check("the rest joins it and the whole line goes at once, as one turn", joined.text === "내일 회의 자료를 정리해 줘" && joined.at - tRest < 400 && tk.posts.length === posts0 + 1, { text: joined.text, ms: joined.at - tRest });
      const mine = newLines(tk, before).filter((l) => l.who === "me").map((l) => l.text);
      p.check("the transcript keeps it as one line of the person's", JSON.stringify(mine) === JSON.stringify(["내일 회의 자료를 정리해 줘"]), mine);
      await listening(page, 10_000);
      await sleep(400);
      const tHeld = await hear(page, "그 문서를", true);
      await until(page, (k) => k.posts.length > posts0 + 1, 4000);
      tk = await talk(page);
      const alone = tk.posts[posts0 + 1] ?? {};
      p.check("left alone, it goes as it is once the hold (1.5 s) is up", alone.text === "그 문서를" && alone.at - tHeld >= 1400 && alone.at - tHeld <= 2300, { text: alone.text, ms: alone.at - tHeld });
      await listening(page, 10_000);
    }

    p.step = "talk-steer";
    {
      const tk0 = await talk(page);
      const before = Object.keys(tk0.lines);
      const posts0 = tk0.posts.length;
      const r0 = tts.reqs.length;
      tts.delay = 1200; // the first piece's audio is still on its way when the person goes on talking
      tts.perLetter = 0.06;
      await page.evaluate(() =>
        window.__talk.plans.splice(0, Infinity, { firstMs: 200, steps: [["text", "네, 내일 서울 날씨를 볼게요. "], ["steer", 8000], ["wait", 300], ["text", "부산도 같이 볼게요. 서울은 맑고, 부산은 오후에 비가 와요."], ["done"]] }),
      );
      await sleep(400);
      const tAsk = await hear(page, "내일 서울 날씨 알려 줘", true);
      const end = Date.now() + 5000;
      while (tts.reqs.length === r0 && Date.now() < end) await sleep(20);
      const asked = tts.reqs.length > r0;
      await hear(page, "그리고", false);
      await sleep(400);
      const tSteer = await hear(page, "그리고 부산도 알려 줘", true);
      await until(page, (k) => k.posts.length > posts0 && !!k.posts[posts0].doneAt, 15_000);
      const back = await listening(page, 15_000);
      await sleep(200);
      const tk = await talk(page);
      const [first, second] = [tk.posts[posts0] ?? {}, tk.posts[posts0 + 1] ?? {}];
      const heard = tts.heard(r0);
      p.check(
        "a line said before the reply's first audio goes into the running turn as a steer (202), not as a turn of its own",
        second.kind === "steered" && second.text === "그리고 부산도 알려 줘" && tk.posts.length === posts0 + 2 && !first.aborted && !!first.doneAt && second.at < first.doneAt && first.steers === 1,
        { kinds: tk.posts.slice(posts0).map((x) => x.kind), aborted: first.aborted },
      );
      p.check(
        "nothing was heard while the person talked: the voice waiting for them was dropped (its request aborted)",
        asked && tts.reqs[r0].failed && !tk.phases.some((x) => x.p === "speaking" && x.t >= tAsk && x.t < tSteer),
        { asked, failed: tts.reqs[r0]?.failed },
      );
      p.check(
        "once they are done the voice starts over from the first piece and says the whole reply once, the steered answer included",
        back && lettersOnly(heard[0]).startsWith(lettersOnly("네, 내일 서울 날씨를 볼게요.")) && lettersOnly(heard.join("")) === lettersOnly(first.reply) && /부산/.test(heard.join(" ")),
        heard,
      );
      const lines = newLines(tk, before);
      p.check(
        "one reply line (no second reply, no '하던 일에 이어서 전했어요' note); the person's two lines",
        lines.filter((l) => l.who === "agent").length === 1 && !lines.some((l) => l.who === "note") && JSON.stringify(lines.filter((l) => l.who === "me").map((l) => l.text)) === JSON.stringify(["내일 서울 날씨 알려 줘", "그리고 부산도 알려 줘"]),
        lines,
      );
    }

    // the same, once the turn has already ended (a fast model often finishes before the person does): their line is a
    // turn of its own, and the reply nobody has heard yet is said first, not dropped
    p.step = "talk-after";
    {
      const tk0 = await talk(page);
      const before = Object.keys(tk0.lines);
      const posts0 = tk0.posts.length;
      const r0 = tts.reqs.length;
      tts.delay = 1200;
      tts.perLetter = 0.06;
      await page.evaluate(() =>
        window.__talk.plans.splice(0, Infinity, { firstMs: 150, steps: [["text", "점심은 따뜻한 김치찌개 어때요?"], ["done"]] }, { firstMs: 300, steps: [["text", "저녁은 가볍게 비빔밥을 추천해요."], ["done"]] }),
      );
      await sleep(400);
      const tAsk = await hear(page, "점심 메뉴 하나만 추천해 줘", true);
      await until(page, (k) => k.posts.length > posts0 && !!k.posts[posts0].doneAt, 5000);
      await hear(page, "그리고", false);
      await sleep(400);
      const tMore = await hear(page, "그리고 저녁 메뉴도 알려 줘", true);
      await until(page, (k) => k.posts.length > posts0 + 1 && !!k.posts[posts0 + 1].doneAt, 8000);
      const back = await page
        .waitForFunction((n) => document.querySelector(".call-card")?.dataset.phase === "listening" && window.__talk.posts.length >= n, posts0 + 2, { timeout: 15_000 })
        .then(() => true)
        .catch(() => false);
      await sleep(300);
      const tk = await talk(page);
      const [first, second] = [tk.posts[posts0] ?? {}, tk.posts[posts0 + 1] ?? {}];
      const heard = tts.heard(r0);
      p.check("the line after the turn ended is a turn of its own (a stream), the first turn left alone", first.doneAt < tMore && !first.aborted && second.kind === "stream" && second.text === "그리고 저녁 메뉴도 알려 줘" && tk.posts.length === posts0 + 2, {
        kinds: tk.posts.slice(posts0).map((x) => x.kind),
      });
      p.check("nothing was heard while the person talked", !tk.phases.some((x) => x.p === "speaking" && x.t >= tAsk && x.t < tMore), phasesSince(tk, tAsk));
      p.check("the unheard first reply is said first, then the second, each once", back && lettersOnly(heard.join("")) === lettersOnly(first.reply + second.reply), heard);
      const lines = newLines(tk, before).map((l) => [l.who, lettersOnly(l.text)]);
      p.check(
        "the transcript reads in order: their line, its reply, their next line, its reply",
        JSON.stringify(lines) === JSON.stringify([["me", "점심메뉴하나만추천해줘"], ["agent", lettersOnly(first.reply)], ["me", "그리고저녁메뉴도알려줘"], ["agent", lettersOnly(second.reply)]]),
        lines,
      );
    }

    p.step = "talk-barge";
    {
      const tk0 = await talk(page);
      const before = Object.keys(tk0.lines);
      const posts0 = tk0.posts.length;
      tts.delay = 150;
      tts.perLetter = 0.12;
      await page.evaluate(() => {
        window.__talk.heardDelay = 500; // the report takes a while: the next line waits for it
        window.__talk.plans.splice(0, Infinity,
          { firstMs: 200, steps: [["text", "네, 오늘 할 일을 하나씩 말해 볼게요. "], ["wait", 300], ["text", "첫째, 아침 아홉 시에 팀 회의가 있어요. "], ["wait", 6000], ["text", "둘째, 오후에는 보고서를 마무리해요."], ["done"]] },
          { steps: [["text", "내일은 맑아요."], ["done"]] },
        );
      });
      await sleep(400);
      await hear(page, "오늘 할 일 알려 줘", true);
      const spoke = await page
        .waitForFunction(() => document.querySelector(".call-card")?.dataset.phase === "speaking", null, { timeout: 8000 })
        .then(() => true)
        .catch(() => false);
      await sleep(1000);
      const tCut = await hear(page, "잠깐만", false);
      await sleep(250);
      const cutPhase = await phase(page);
      const tAsk = await hear(page, "잠깐만, 내일 날씨는 어때?", true);
      await until(page, (k) => k.posts.length > posts0 + 1 && !!k.posts[posts0 + 1].doneAt, 10_000);
      const back = await listening(page, 10_000);
      await sleep(200);
      const tk = await talk(page);
      const [first, second] = [tk.posts[posts0] ?? {}, tk.posts[posts0 + 1] ?? {}];
      p.check("talking over the voice cuts it off at once (listening 250 ms later)", spoke && cutPhase === "listening" && phasesSince(tk, tCut)[0] === "listening", { spoke, cutPhase, after: phasesSince(tk, tCut).slice(0, 3) });
      p.check("…and stops the turn (its stream aborted, never done)", !!first.aborted && first.aborted - tCut < 250 && !first.doneAt, { abortedMs: first.aborted && first.aborted - tCut, done: first.doneAt });
      const later = tts.reqs.filter((e) => e.at > tCut).map((e) => e.text);
      p.check("nothing more of the cut reply is asked for", later.every((t) => lettersOnly("내일은 맑아요").includes(lettersOnly(t))), later);
      p.check("their line starts a turn of its own (a stream, not a steer) once the old one stopped", second.kind === "stream" && second.text === "잠깐만, 내일 날씨는 어때?" && second.at >= first.aborted && second.at - tAsk < 400 && back, { kind: second.kind, text: second.text });
      const agent = newLines(tk, before).filter((l) => l.who === "agent");
      p.check("the cut reply keeps what it had in its line; the new reply has its own", agent.length === 2 && lettersOnly(agent[0].text).startsWith("네오늘할일을") && lettersOnly(agent[1].text) === "내일은맑아요", agent);
      // what was heard: the first piece (14 letters, 1.68 s of audio) played from the speaking phase on, cut at tCut
      const reports = tk.heard.filter((h) => h.messageId === first.messageId);
      const said = "네, 오늘 할 일을 하나씩 말해 볼게요. 첫째, 아침 아홉 시에 팀 회의가 있어요.";
      const heard = reports[0]?.heard ?? null;
      const spokeAt = tk.phases.find((x) => x.p === "speaking" && x.t >= first.at)?.t ?? 0;
      const playedS = (tCut - spokeAt) / 1000;
      const n = lettersOnly(heard).length;
      p.check(
        "what was heard of the cut reply goes to its history: one report, whole words of what was said, about as much as played",
        reports.length === 1 && n > 0 && said.startsWith(heard) && /^[ .,]|^$/.test(said.slice(heard.length)) && n <= playedS / 0.12 + 0.5 && n >= (playedS - 0.15) / 0.12 - 4,
        { reports: reports.length, heard, letters: n, playedS },
      );
      p.check("their line waits for that report: sent once it was answered", !!reports[0]?.doneAt && second.at >= reports[0].doneAt, { sentAfterMs: second.at - (reports[0]?.doneAt ?? 0) });
      p.check("nothing else was reported (the new reply was not cut)", tk.heard.length - tk0.heard.length === 1, tk.heard.slice(tk0.heard.length));
    }

    // a report that hangs holds the next line back 1 s at most
    p.step = "talk-heard-wait";
    {
      const tk0 = await talk(page);
      const posts0 = tk0.posts.length;
      tts.delay = 150;
      tts.perLetter = 0.12;
      await page.evaluate(() => {
        window.__talk.heardDelay = 3000;
        window.__talk.plans.splice(0, Infinity,
          { firstMs: 200, steps: [["text", "네, 이번 주 일정을 차례로 말해 볼게요. "], ["wait", 6000], ["text", "월요일에는 회의가 있어요."], ["done"]] },
          { steps: [["text", "알겠어요."], ["done"]] },
        );
      });
      await sleep(400);
      await hear(page, "이번 주 일정 알려 줘", true);
      const spoke = await page
        .waitForFunction(() => document.querySelector(".call-card")?.dataset.phase === "speaking", null, { timeout: 8000 })
        .then(() => true)
        .catch(() => false);
      await sleep(800);
      await hear(page, "그만", false);
      await sleep(250);
      const tAsk = await hear(page, "그만, 됐어요.", true);
      await until(page, (k) => k.posts.length > posts0 + 1 && !!k.posts[posts0 + 1].doneAt, 10_000);
      await listening(page, 8000);
      const tk = await talk(page);
      const second = tk.posts[posts0 + 1] ?? {};
      const report = tk.heard.at(-1) ?? {};
      p.check("a slow report holds the line back about 1 s, no longer", spoke && report.messageId === tk.posts[posts0]?.messageId && second.at - tAsk >= 850 && second.at - tAsk <= 1500 && (!report.doneAt || second.at < report.doneAt), {
        waitedMs: second.at - tAsk,
        reportPending: !report.doneAt,
      });
      await page.evaluate(() => (window.__talk.heardDelay = 0));
      await sleep(3000);
    }

    // a line meant as a steer, but the running turn ended in between: the server answered it as a turn of its own. That
    // turn is the thread's running one now, so talking over its voice stops it too.
    p.step = "talk-late";
    {
      const tk0 = await talk(page);
      const posts0 = tk0.posts.length;
      const r0 = tts.reqs.length;
      tts.delay = 900;
      tts.perLetter = 0.1;
      await page.evaluate(() =>
        window.__talk.plans.splice(0, Infinity,
          { firstMs: 150, endsOnSteer: true, steps: [["text", "네, 날씨를 볼게요. "], ["steer", 8000], ["done"]] },
          { firstMs: 200, steps: [["text", "부산은 오후에 비가 와요. "], ["wait", 6000], ["text", "내일은 맑아요."], ["done"]] },
        ),
      );
      await sleep(400);
      await hear(page, "날씨 알려 줘", true);
      await until(page, (k) => k.posts.length > posts0, 3000);
      await sleep(300);
      // before the first audio: their next line is meant as a steer
      await hear(page, "부산", false);
      await sleep(200);
      await hear(page, "부산도 같이", true);
      await until(page, (k) => k.posts.length > posts0 + 1, 3000);
      // the late reply's voice: its first request answered (the first reply was said before it), then 0.5 s of it plays
      let lateSpoke = false;
      for (const end = Date.now() + 10_000; Date.now() < end && !lateSpoke; await sleep(40)) lateSpoke = tts.reqs.slice(r0).some((e) => /부산은/.test(e.text) && e.done && !e.failed);
      await sleep(500);
      // the stop runs inside the recogniser's callback, before hear() reads the clock: the abort can land a ms before tCut
      const tBefore = await page.evaluate(() => Date.now());
      const tCut = await hear(page, "아니", false);
      await sleep(400);
      await hear(page, "아니 됐어", true);
      await until(page, (k) => k.posts.length > posts0 + 2 && !!k.posts[posts0 + 2].doneAt, 8000);
      await listening(page, 8000);
      const tk = await talk(page);
      const [first, late] = [tk.posts[posts0] ?? {}, tk.posts[posts0 + 1] ?? {}];
      p.check("the line meant as a steer became a turn of its own (the first turn ended)", first.kind === "stream" && !!first.doneAt && late.kind === "stream" && late.late === true, {
        kinds: tk.posts.slice(posts0).map((x) => [x.kind, !!x.late]),
      });
      p.check("talking over its voice stops that turn as well (its stream aborted, never done)", lateSpoke && !!late.aborted && late.aborted >= tBefore && late.aborted - tCut < 400 && !late.doneAt, {
        lateSpoke,
        abortedMs: late.aborted ? late.aborted - tCut : null,
        done: !!late.doneAt,
        tts: tts.reqs.slice(r0).map((e) => [e.text, e.at - tCut, e.done - tCut, e.failed]),
        phases: tk.phases.filter((x) => x.t >= first.at).map((x) => [x.p, x.t - tCut]),
      });
      p.check("…and reports what was heard of it", tk.heard.some((h) => h.messageId === late.messageId && "부산은 오후에 비가 와요.".startsWith(h.heard) && h.heard.length > 0), tk.heard.slice(tk0.heard.length));
    }

    p.step = "talk-diverge";
    {
      const tk0 = await talk(page);
      const before = Object.keys(tk0.lines);
      const posts0 = tk0.posts.length;
      tts.delay = 150;
      tts.perLetter = 0.25; // 1.75 s of audio for the first piece: still playing when the done text arrives
      await page.evaluate(() => window.__talk.plans.splice(0, Infinity, { firstMs: 200, steps: [["text", "네, 오늘은 맑아요. "], ["wait", 700], ["done", "다시 보니 오늘은 흐리고 비가 와요."]] }));
      await sleep(400);
      await hear(page, "오늘 날씨 어때?", true);
      await until(page, (k) => k.posts.length > posts0 && !!k.posts[posts0].doneAt, 8000);
      const back = await listening(page, 5000);
      await sleep(300);
      const tk = await talk(page);
      const post = tk.posts[posts0] ?? {};
      const spokeAt = tk.phases.find((x) => x.p === "speaking" && x.t >= post.at)?.t ?? 0;
      const quietAt = tk.phases.find((x) => x.p === "listening" && x.t >= post.doneAt)?.t ?? 0;
      const said = tts.reqs.filter((e) => e.at >= post.at).map((e) => e.text);
      p.check(
        "a done text that no longer starts with what was said stops the voice at once and says none of it",
        back && !!spokeAt && !!quietAt && quietAt - post.doneAt < 500 && quietAt < spokeAt + 1750 && said.length === 1 && !/흐리고/.test(said.join(" ")),
        { said, quietAfterDoneMs: quietAt - post.doneAt, playedMs: quietAt - spokeAt },
      );
      const agent = newLines(tk, before).filter((l) => l.who === "agent");
      p.check("the reply's line reads the done text", agent.length === 1 && lettersOnly(agent[0].text) === lettersOnly("다시 보니 오늘은 흐리고 비가 와요."), agent);
    }
    p.check("the sentence voice (/api/tts) was never needed", tts.sentence === 0, tts.sentence);
    await page.locator(".call-card").getByRole("button", { name: "통화 종료" }).click();
    await page.waitForSelector(".call-card", { state: "detached", timeout: 8000 }).catch(() => {});
    await sleep(500);

    // ── without speech recognition: the one note that stays, and typing ──
    p.step = "no-stt";
    await page.evaluate(() => {
      window.SpeechRecognition = undefined;
      window.webkitSpeechRecognition = undefined;
    });
    await openCall(page);
    await sleep(800);
    const noStt = await cardLayout(page);
    p.check("no speech recognition: the '음성 인식을 쓸 수 없어서…' note and a typing field", noStt.notes.length === 1 && noStt.notes[0] === "음성 인식을 쓸 수 없어서 글자로 말할 수 있어요" && noStt.typing, noStt.notes);
    await p.shot("call-no-stt");
    await page.locator(".call-card").getByRole("button", { name: "통화 종료" }).click();
    await page.waitForSelector(".call-card", { state: "detached", timeout: 8000 }).catch(() => {});
    await sleep(500);

    // ── a mic granted late (a permission prompt answered after 4 s): the call connects at 2.5 s with typing, and the
    //    waiting note goes once the mic and recognition join ──
    p.step = "mic-late";
    await page.evaluate(() => {
      window.SpeechRecognition = window.__scriptedSR;
      const slowMic = () =>
        new Promise((resolve) =>
          setTimeout(() => {
            window.__micCtx ??= new AudioContext();
            resolve(window.__micCtx.createMediaStreamDestination().stream);
          }, 4000),
        );
      MediaDevices.prototype.getUserMedia = slowMic;
      navigator.mediaDevices.getUserMedia = slowMic;
    });
    await openCall(page);
    await sleep(300);
    const waiting = await cardLayout(page);
    const joined = await page
      .waitForFunction(() => !document.querySelector(".call-line[data-who=note]") && !document.querySelector(".call-type-input"), null, { timeout: 6000 })
      .then(() => true)
      .catch(() => false);
    await sleep(400);
    const after = await cardLayout(page);
    p.check(
      "mic granted late: the waiting note + typing first, then neither once the mic joins (the status already says '듣고 있어요')",
      JSON.stringify(waiting.notes) === JSON.stringify(["마이크 허용을 기다리고 있어요 · 그동안 글자로 말할 수 있어요"]) && waiting.typing && joined && after.notes.length === 0 && !after.typing && after.phase?.text === "듣고 있어요",
      { waiting: waiting.notes, after: after.notes, typing: [waiting.typing, after.typing] },
    );
    await page.locator(".call-card").getByRole("button", { name: "통화 종료" }).click();
    await page.waitForSelector(".call-card", { state: "detached", timeout: 8000 }).catch(() => {});
    await sleep(500);

    // ── the same late mic without speech recognition (Firefox-like): the waiting note doesn't stay forever, it
    //    becomes the no-recognition note once the mic joins, and typing stays (the slow mic above is still in place) ──
    p.step = "mic-late-no-stt";
    await page.evaluate(() => {
      window.SpeechRecognition = undefined;
      window.webkitSpeechRecognition = undefined;
    });
    await openCall(page);
    await sleep(300);
    const lateWaiting = await cardLayout(page);
    const turned = await page
      .waitForFunction(() => [...document.querySelectorAll(".call-line[data-who=note]")].some((l) => l.textContent?.startsWith("음성 인식을 쓸 수 없어서")), null, { timeout: 6000 })
      .then(() => true)
      .catch(() => false);
    await sleep(400);
    const lateAfter = await cardLayout(page);
    p.check(
      "mic granted late without speech recognition: the waiting note turns into the '음성 인식을 쓸 수 없어서…' note (one note), typing stays",
      JSON.stringify(lateWaiting.notes) === JSON.stringify(["마이크 허용을 기다리고 있어요 · 그동안 글자로 말할 수 있어요"]) &&
        lateWaiting.typing &&
        turned &&
        JSON.stringify(lateAfter.notes) === JSON.stringify(["음성 인식을 쓸 수 없어서 글자로 말할 수 있어요"]) &&
        lateAfter.typing,
      { waiting: lateWaiting.notes, after: lateAfter.notes, typing: [lateWaiting.typing, lateAfter.typing] },
    );
    await page.locator(".call-card").getByRole("button", { name: "통화 종료" }).click();
    await page.waitForSelector(".call-card", { state: "detached", timeout: 8000 }).catch(() => {});
    await sleep(500);
  } catch (e) {
    p.check(`pass ran to the end (stopped at "${p.step}")`, false, String(e).slice(0, 300));
  }
  p.check("0 console errors", p.errors.length === 0, p.errors.slice(0, 3));
  p.check("0 horizontal overflow", p.overflows.length === 0, p.overflows.slice(0, 3));
  await browser.close();
  return { tag: p.tag, checks: p.checks, errors: p.errors, overflows: p.overflows, shots: p.shots };
}

async function main() {
  const preview = await startPreview();
  const results = [];
  try {
    for (const engine of ENGINES) {
      const type = engine === "webkit" ? webkit : chromium;
      for (const variant of VARIANTS) {
        console.log(`\n▶ ${engine} ${variant}`);
        results.push(await runPass(type, engine, variant));
      }
    }
  } finally {
    preview?.stopAll();
  }
  const summary = results.map((r) => ({ tag: r.tag, passed: r.checks.filter((c) => c.ok).length, failed: r.checks.filter((c) => !c.ok).map((c) => c.name) }));
  // merge with earlier passes (one engine/variant per run is common): a pass replaces its own earlier entry
  let prev = { results: [], summary: [] };
  try {
    prev = JSON.parse(fs.readFileSync(path.join(outDir, "results.json"), "utf8"));
  } catch {
    /* first run */
  }
  const tags = new Set(results.map((r) => r.tag));
  const all = [...(prev.results || []).filter((r) => !tags.has(r.tag)), ...results.map((r) => ({ ...r, at: new Date().toISOString() }))];
  const allSummary = [...(prev.summary || []).filter((x) => !tags.has(x.tag)), ...summary];
  fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify({ at: new Date().toISOString(), summary: allSummary, results: all }, null, 2));
  console.log("\n" + summary.map((s) => `${s.tag}: ${s.passed} ok, ${s.failed.length} failed${s.failed.length ? ` (${s.failed.join("; ")})` : ""}`).join("\n"));
  process.exit(summary.some((s) => s.failed.length) ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
