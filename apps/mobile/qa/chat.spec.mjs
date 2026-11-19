// Chat screens QA (screens-chat). Runs against a LIVE pickle server with a real LLM. Run it from the repo root:
//   PICKLE_DATA_DIR=… PORT=8791 bun --env-file=… run apps/server/src/index.ts      (the server, separately)
//   node apps/mobile/qa/chat.spec.mjs                                            (all engines × variants)
//   QA_ENGINES=chromium QA_VARIANTS=light node apps/mobile/qa/chat.spec.mjs     (one pass)
// Env: QA_API (server, default http://127.0.0.1:8791) · QA_PORT (preview, default 5182) · QA_BUILD=0 (reuse the build)
//      the server, for a full run: PICKLE_DAILY_TOKENS=20000000 (the default 400k a day per account runs out mid-run:
//      the model steps get 429 quota_exceeded)
//      QA_ONLY=onboarding,weather,…  (scenario subset; onboarding always runs because it creates the account)
//      QA_DIST (build dir, default <tmp>/pickle-chat-qa-dist) · QA_STRIP=before|after (transcript / deslop shot names)
//      QA_API_AUTH=1  (sign up through the API instead of the onboarding UI: fixture-only scenarios, e.g. deslop)
//      QA_TTS_REAL=1  (the voice talks to the server's real /api/tts/stream: measures time to first audio; the
//                      mock-only fallback scenario is skipped)
// It builds the app with the QA stub config (other builders' missing screens become placeholders) into a temp dir,
// serves it with `vite preview` (proxying /api to the server), and drives 390×844 @3x in installed Google Chrome
// (channel "chrome") and Playwright WebKit, light / dark / reduced motion. Never runs `playwright install`.
// Scenarios: invite link + onboarding errors (wrong login, taken handle) + 2-step sign-up → invite accepted → friend
// thread (two users, 201 delivered, my Pickle and the friend's Pickle answering) → welcome briefing → weather (the
// turn's line: tool status → "자료 1개 보기 · 기상청" with the card behind it → text, first-token timing) → parallel
// tools → schedule (low risk: done + undo) → phone call
// approval (high risk: ConfirmButton, device-key signature, "이 기기의 키로 확인했어요", Twilio missing) →
// credential_request (sealed on the device, "저장됨 · 7일") → steer while streaming (202) → stop → drawer + 초성
// search → explore call-demo thread → voice call card (STT fallback) open / minimise / end → the agent's voice
// (/api/tts intercepted with qa/fixtures/tts-sentence.mp3: sentences requested in order and pipelined, playback with a
// real output level, barge-in by mute / by the person talking (scripted recogniser) / by ending the call, and the 503
// path falling back to Web Speech for the rest of the session) → de-slop fixtures → the user's picks (chat B with the
// KakaoTalk room per A, empty-thread A) on a fixture thread (qa/fixtures/picks-thread.mjs): bubble-less turns with the
// face head, the cards, the grouped credential field, the welcome rows, the composer's call fold → toolfold (fixture
// thread + a scripted turn: records folded behind the turn's line by default, open/fold in place, keyboard, approvals
// never folded, the answer on screen while it streams, kept per message, folded again after a reload) → jumpfit, last
// (새 메시지 from far up after a width change, in a second friend's thread: the end reached, no bubble drawn at its
// old width, watched until the scroll stands still; the bubbles a glide passes between two frames are counted apart).
// Assertions per pass: 0 console errors (expected 4xx of the error steps are logged separately), 0 horizontal overflow
// at every screenshot, Chrome: no long task > 50 ms inside interaction windows, first-token placeholder ≤ 150 ms.
// Screenshots: docs/qa/chat/<engine>-<variant>-NN-name.png · results: docs/qa/chat/results.json
import { chromium, webkit } from "playwright";
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { picksThread } from "./fixtures/picks-thread.mjs";
import { MEET_APPROVAL, MEET_CODE, MEET_THREAD, meetThread, meetView } from "./fixtures/meet-thread.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, "..");
const repo = path.resolve(appDir, "../..");
const outDir = path.join(repo, "docs/qa/chat");
fs.mkdirSync(outDir, { recursive: true });
const API = process.env.QA_API || "http://127.0.0.1:8791";
const PORT = Number(process.env.QA_PORT || 5182);
const BASE = `http://127.0.0.1:${PORT}`;
const DIST = process.env.QA_DIST || path.join(os.tmpdir(), "pickle-chat-qa-dist");
/** the transcript strip's name: docs/qa/chat/call-transcript-<QA_STRIP>-<engine>.{jpg,json} (light variant only) */
const STRIP = process.env.QA_STRIP || "after";
/** QA_API_AUTH=1: skip the onboarding UI (sign up through the API); for fixture-only scenarios such as deslop */
const API_AUTH = process.env.QA_API_AUTH === "1";
const ENGINES = (process.env.QA_ENGINES || "chromium,webkit").split(",");
const VARIANTS = (process.env.QA_VARIANTS || "light,dark,reduced").split(",");
const ONLY = process.env.QA_ONLY ? new Set(process.env.QA_ONLY.split(",")) : null;
const want = (s) => !ONLY || ONLY.has(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = () => crypto.randomBytes(4).toString("hex");
const PASSWORD = "qa-pass-1234";
/** jumpfit: sentences that make bubbles of two lines or more at 390 and 430 (each sent by both people) */
const JUMP_TEXTS = [
  "내일 아침 7시에 회의 있다고 팀원들한테 카톡으로 보내 줘",
  "오늘 저녁에 엄마한테 전화해서 생일 선물 뭐 갖고 싶은지 물어봐 줘",
  "지난주에 받은 세금계산서 전부 정리해서 엑셀로 만들어 줘",
  "공연팀 단톡방에 리허설 장소가 대학로 연습실로 바뀌었다고 전해 줘",
  "민수한테 어제 빌린 돈 3만 원 오늘 저녁에 보낸다고 말해 줘",
  "주말에 아이랑 갈 만한 실내 놀이터 찾아 줘. 너무 멀지 않은 곳으로",
  "요즘 많이 쓰는 무선 청소기 20만 원 이하로 비교해 줘",
  "진우한테 토요일 약속 1시간 늦춰도 되는지 물어봐 줘",
  "나 대신 식당에 전화해서 7시 4명 예약 가능한지 물어봐 줄래?",
  "할머니 생신이 다음 주 목요일이야. 미리 꽃 배달 예약해 줘",
  "혹시 이번 주말에 시간 되면 같이 전시 보러 갈래? 성수에 새로 생긴 곳 있대",
  "오늘 먹은 거 칼로리 대충 계산해 줘. 아침에 샌드위치, 점심에 김치찌개",
  "월요일까지 견적서 다시 보내 달라고 거래처에 말해 줘",
  "3시 15분에 강남역 2번 출구 앞에서 만나서 같이 들어가자 늦으면 전화해",
  "주차는 건물 지하 2층에 하면 돼요 요금은 내가 낼게",
  "회의 자료는 공유 폴더에 올려 뒀으니까 확인해 줘",
  "지하철 2호선 타고 가다가 시청역에서 1호선으로 갈아타",
  "오늘따라 퇴근길이 엄청 막히네 30분은 늦을 것 같아",
  "다음 주 수요일 저녁 7시 홍대입구역 9번 출구 어때",
  "초대장 문구 이렇게 바꿔 봤는데 어때 너무 길어?",
  "엄마 생신 선물로 스카프랑 장갑 중에 뭐가 나을까",
  "어제 보내 준 사진 너무 잘 나왔다 고마워 진짜",
  "택배 오면 문 앞에 두라고 기사님께 말씀드렸어요",
  "아까 말한 책 제목이 뭐였지 기억이 안 나네 다시 알려 줘",
];
/** how long a step waits for the LLM (the provider has had 40–50 s before its first tool call on slow days) */
const LLM_MS = 120_000;
/** our app's index.html (brand renamed 피클 → 모시; either title means the preview is ours) */
const APP_HTML = /모시|피클/;

// ── server + app ──

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

// ── auth pacing (server: 10 sign-up/login per minute per IP) ──

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

// ── node-side API client for the second user ("진우", the friend) ──

async function api(method, p, body, token) {
  const res = await fetch(API + p, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const type = res.headers.get("content-type") || "";
  if (type.includes("text/event-stream")) {
    const text = await res.text(); // consume the whole turn
    return { status: res.status, body: text };
  }
  const j = type.includes("json") ? await res.json() : await res.text();
  return { status: res.status, body: j };
}

/**
 * The server's daily briefing (settings.notifications.briefing, 07:30 KST by default, a 2-hour window) is a system turn
 * in the main thread that starts on the first scheduler tick after sign-up whenever a run falls inside that window. It
 * would steer whatever the spec sends next (202), and the weather step would never see its own turn start. Each QA
 * account turns it off as soon as it exists.
 */
async function quietBriefing(token) {
  if (!token) return;
  const r = await api("PATCH", "/api/settings", { notifications: { briefing: false } }, token).catch((e) => ({ status: 0, body: String(e) }));
  if (r.status !== 200) console.log(`  (could not turn the daily briefing off: ${r.status})`);
}

async function deviceReg() {
  const kp = await crypto.webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const jwk = await crypto.webcrypto.subtle.exportKey("jwk", kp.publicKey);
  return { id: `qa-${rand()}`, label: "QA node", signingKey: jwk };
}

async function signupApi(handle, displayName, agentName) {
  for (let i = 0; i < 4; i++) {
    await authSlot();
    const r = await api("POST", "/api/auth/signup", { handle, password: PASSWORD, displayName, agentName, device: await deviceReg() });
    if (r.status === 201 || r.status === 200) return r.body;
    if (r.status === 429) {
      await sleep(20_000);
      continue;
    }
    throw new Error(`signup ${handle}: ${r.status} ${JSON.stringify(r.body)}`);
  }
  throw new Error("signup rate limited");
}

// ── page helpers ──

const INIT = () => {
  const qa = (window.__qa = { long: [], windows: [], sendAt: 0, liveAt: 0, cur: null, ac: [] });
  // every AudioContext construction and its cost (Chrome's first one per page is the expensive one)
  try {
    const Orig = window.AudioContext;
    if (Orig)
      window.AudioContext = class extends Orig {
        constructor(...a) {
          const t = performance.now();
          super(...a);
          qa.ac.push({ at: Math.round(t), dur: Math.round(performance.now() - t), in: qa.cur?.name || "" });
        }
      };
  } catch {
    /* ignore */
  }
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) qa.long.push({ start: e.startTime, dur: e.duration });
    }).observe({ type: "longtask", buffered: true });
  } catch {
    /* WebKit: no longtask */
  }
  qa.begin = (name) => {
    qa.cur = { name, start: performance.now(), end: 0 };
    qa.windows.push(qa.cur);
  };
  qa.end = () => {
    if (qa.cur) qa.cur.end = performance.now();
    qa.cur = null;
  };
  document.addEventListener(
    "keydown",
    (e) => {
      if (e.key === "Enter" && !e.shiftKey && e.target instanceof HTMLTextAreaElement && e.target.classList.contains("composer-field") && e.target.value.trim()) {
        qa.sendAt = performance.now();
        qa.liveAt = 0;
      }
    },
    true,
  );
  new MutationObserver(() => {
    if (qa.sendAt && !qa.liveAt && document.querySelector(".msg-live")) qa.liveAt = performance.now();
  }).observe(document, { childList: true, subtree: true });
};

async function overflow(page) {
  return page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const doc = document.documentElement.scrollWidth - vw;
    const offenders = [];
    for (const sc of document.querySelectorAll(".screen-scroll, .dw, .onb, .call-inner")) {
      const scr = sc.getBoundingClientRect();
      if (!scr.width) continue;
      for (const el of sc.querySelectorAll("*")) {
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) continue;
        // visually hidden (sr-only: 1px, clipped) — not something anyone can see overflow
        if (r.width <= 1 && r.height <= 1) continue;
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
    this.skipped = [];
    this.engine = engine;
    this.variant = variant;
    this.tag = `${engine}-${variant}`;
    this.page = page;
    this.n = 0;
    this.shots = [];
    this.overflows = [];
    this.checks = [];
    this.errors = [];
    this.expected = [];
    this.step = "load";
    this.metrics = {};
  }
  async shot(name) {
    const file = path.join(outDir, `${this.tag}-${String(++this.n).padStart(2, "0")}-${name}.png`);
    await this.page.screenshot({ path: file });
    this.shots.push(path.relative(repo, file));
    const o = await overflow(this.page);
    if (o.doc > 0 || o.offenders.length) this.overflows.push({ at: name, ...o });
  }
  check(name, ok, detail) {
    this.checks.push({ name, ok: !!ok, ...(detail === undefined ? {} : { detail }) });
    console.log(`  ${ok ? "ok  " : "FAIL"} ${this.tag} ${name}${detail !== undefined ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  }
  /** the agent (an LLM) chose not to take the path this scenario needs: recorded, reported, not a UI failure */
  skip(name, why) {
    this.skipped.push({ name, why });
    console.log(`  skip ${this.tag} ${name} — ${why}`);
  }
  async interact(name, fn) {
    await this.page.evaluate((n) => window.__qa.begin(n), name);
    try {
      return await fn();
    } finally {
      await this.page.evaluate(() => window.__qa.end()).catch(() => {});
    }
  }
}

const composer = (page) => page.locator("textarea.composer-field");
/** scroll a list element to the middle of the screen (clear of the floating bars), then tap it */
async function tapIn(locator) {
  await locator.evaluate((el) => el.scrollIntoView({ block: "center", behavior: "instant" }));
  await sleep(250);
  await locator.click();
}
const streaming = (page) => page.locator(".send-btn[data-mode=stop]");

async function waitIdle(page, timeout = 90_000) {
  await page.waitForFunction(() => !document.querySelector(".send-btn[data-mode=stop]") && !document.querySelector(".msg-live"), null, { timeout });
  await sleep(400);
}

/** the agent is free: no local turn, and no remote/follow-up turn (the island is not busy) */
async function waitAgentIdle(page, timeout = 120_000) {
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

/** reload, then let the archive prefetch that every load starts (GET /api/artifacts and /api/attachments, ~1.2 s
 *  after the session in WebKit) finish: the next step's own reload would otherwise cut it off mid-flight, which
 *  WebKit reports as a page error "… due to access control checks" */
async function reloadSettled(page) {
  const lists = Promise.all(
    ["/api/artifacts", "/api/attachments"].map((path) => page.waitForResponse((r) => new URL(r.url()).pathname === path, { timeout: 6000 }).catch(() => null)),
  );
  await page.reload({ waitUntil: "load" });
  await lists;
}

/** open every turn line that folds records ("자료 N개 보기"), one at a time, each settled before the next */
async function openFolds(page) {
  const lines = page.locator(".thread-content .tools-line[aria-expanded=false]", { hasText: /자료 \d+개 보기/ });
  for (let i = 0, n = await lines.count(); i < n; i++) {
    const l = lines.first();
    if (!(await l.count())) break;
    await l.evaluate((e) => e.scrollIntoView({ block: "center", behavior: "instant" }));
    await l.click();
    await sleep(900);
  }
}

/** a banner (a friend's message, their Pickle's answer) drops over the top bar's 뒤로 / 메뉴, and a pointer over it
 *  holds it there: move away, then wait for a quiet moment with none */
async function waitNoBanner(page, ms = 25_000) {
  await page.mouse.move(195, 640);
  for (const until = Date.now() + ms; Date.now() < until; ) {
    await page.waitForSelector(".banner", { state: "detached", timeout: 12_000 }).catch(() => {});
    await sleep(1500);
    if (!(await page.locator(".banner").count())) return true;
  }
  return false;
}

async function send(p, text, { measure = false } = {}) {
  const page = p.page;
  const f = composer(page);
  await f.click();
  await f.fill(text);
  await p.interact(`send:${text.slice(0, 12)}`, async () => {
    await page.keyboard.press("Enter");
    await sleep(250);
  });
  if (measure) {
    await page.waitForFunction(() => window.__qa.liveAt > 0 || !!document.querySelector(".msg-asst:last-child .asst-text"), null, { timeout: 15_000 }).catch(() => {});
    const t = await page.evaluate(() => (window.__qa.liveAt ? window.__qa.liveAt - window.__qa.sendAt : -1));
    return t;
  }
  return 0;
}

async function lastAssistantText(page) {
  return page.evaluate(() => {
    const rows = [...document.querySelectorAll(".thread-content .msg-asst .asst-text, .thread-content .msg-other .asst-text")];
    return rows.length ? rows[rows.length - 1].textContent : "";
  });
}

/** send, and if the agent does not produce `selector` in time, rephrase once */
async function ask(p, texts, selector, timeout = 60_000) {
  for (const text of texts) {
    await send(p, text);
    try {
      await p.page.waitForSelector(selector, { timeout });
      return true;
    } catch {
      await waitIdle(p.page).catch(() => {});
    }
  }
  return false;
}

// ── the agent's voice (/api/tts/stream → /api/tts → Web Speech) ──

const TTS_REAL = process.env.QA_TTS_REAL === "1";
const TTS_MP3 = fs.readFileSync(path.join(here, "fixtures/tts-sentence.mp3")); // 1.2 s, 24 kHz mono, modulated tone
/** the stream fixture: 3 s of raw PCM s16le mono, the same modulated tone (made here, no file) */
const TTS_PCM_RATE = 16000;
const TTS_PCM = (() => {
  const n = TTS_PCM_RATE * 3;
  const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const t = i / TTS_PCM_RATE;
    b.writeInt16LE(Math.round(0.6 * Math.sin(2 * Math.PI * 220 * t) * (0.55 + 0.45 * Math.sin(2 * Math.PI * 2.5 * t)) * 32767), i * 2);
  }
  return b;
})();
const squash = (s) => String(s || "").replace(/\p{Extended_Pictographic}|️|‍/gu, "").replace(/\s+/g, "");
/** letters and digits only: the stream text closes sentences with punctuation the transcript doesn't show */
const lettersOnly = (s) => String(s || "").replace(/[^\p{L}\p{N}]/gu, "");

/**
 * Intercept both voice routes. /api/tts/stream: page.route can't stream, so the whole PCM body is fulfilled at once
 * after `stream.delay` (the reader still gets it in chunks). /api/tts: the mp3 after `delay(i)`.
 * Modes: "ok" · "503" (tts_unavailable) · stream "empty" (200, then no audio at all).
 */
async function installTts(page) {
  const tts = { reqs: [], failed: 0, mode: "ok", delay: (i) => (i === 0 ? 300 : 700), stream: { reqs: [], failed: 0, mode: "ok", delay: 250 } };
  const entry = (req) => {
    let text = "";
    try {
      text = JSON.parse(req.postData() || "{}").text || "";
    } catch {
      /* not JSON */
    }
    return { text, at: Date.now(), done: 0, bearer: /^Bearer \S+/.test(req.headers()["authorization"] || "") };
  };
  const unavailable = (route) => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "tts_unavailable" }) }).catch(() => {});
  await page.route("**/api/tts/stream", async (route) => {
    const st = tts.stream;
    const e = entry(route.request());
    st.reqs.push(e);
    if (st.mode === "503") return (e.done = Date.now()), unavailable(route);
    await sleep(st.delay);
    e.done = Date.now();
    const headers = { "Content-Type": `audio/L16; rate=${TTS_PCM_RATE}; channels=1`, "X-Sample-Rate": String(TTS_PCM_RATE), "Cache-Control": "no-store" };
    await route.fulfill({ status: 200, headers, body: st.mode === "empty" ? Buffer.alloc(0) : TTS_PCM }).catch(() => (e.dropped = true));
  });
  await page.route("**/api/tts", async (route) => {
    const e = entry(route.request());
    const i = tts.reqs.push(e) - 1;
    if (tts.mode === "503") return (e.done = Date.now()), unavailable(route);
    await sleep(tts.delay(i));
    e.done = Date.now();
    await route.fulfill({ status: 200, contentType: "audio/mpeg", body: TTS_MP3 }).catch(() => (e.dropped = true));
  });
  page.on("requestfailed", (r) => {
    if (r.url().endsWith("/api/tts/stream")) tts.stream.failed++;
    else if (r.url().endsWith("/api/tts")) tts.failed++;
  });
  tts.count = () => tts.reqs.length + tts.stream.reqs.length;
  return tts;
}

/** QA_TTS_REAL: no mocks; requests to the real voice routes are only recorded (sent → response headers) */
async function watchTts(page) {
  const tts = { real: true, reqs: [], failed: 0, mode: "ok", delay: () => 0, stream: { reqs: [], failed: 0, mode: "ok", delay: 0 } };
  const list = (url) => (url.endsWith("/api/tts/stream") ? tts.stream.reqs : url.endsWith("/api/tts") ? tts.reqs : null);
  const byReq = new Map();
  page.on("request", (req) => {
    const l = list(req.url());
    if (!l) return;
    let text = "";
    try {
      text = JSON.parse(req.postData() || "{}").text || "";
    } catch {
      /* not JSON */
    }
    const e = { text, at: Date.now(), done: 0, bearer: /^Bearer \S+/.test(req.headers()["authorization"] || "") };
    l.push(e);
    byReq.set(req, e);
  });
  page.on("response", (res) => {
    const e = byReq.get(res.request());
    if (e) (e.done = Date.now()), (e.status = res.status());
  });
  page.on("requestfailed", (r) => {
    if (r.url().endsWith("/api/tts/stream")) tts.stream.failed++;
    else if (r.url().endsWith("/api/tts")) tts.failed++;
  });
  tts.count = () => tts.reqs.length + tts.stream.reqs.length;
  return tts;
}

/** watch the call card close: from the tap, every frame — the card's opacity and pointer-events, whether a tap at its
 * centre still lands on it, and when it leaves the DOM */
async function watchClose(page) {
  await page.evaluate(() => {
    const born = performance.now();
    const out = (window.__close = { t0: null, samples: [], gone: null, hit: null });
    const onClick = () => {
      if (out.t0 === null) out.t0 = performance.now();
    };
    window.addEventListener("click", onClick, true);
    const tick = () => {
      if (out.t0 !== null) {
        const el = document.querySelector(".call-card");
        const t = Math.round(performance.now() - out.t0);
        if (!el) {
          out.gone = t;
          window.removeEventListener("click", onClick, true);
          return;
        }
        const cs = getComputedStyle(el);
        out.samples.push({ t, o: Number(Number(cs.opacity).toFixed(3)), pe: cs.pointerEvents });
        if (out.hit === null) {
          const r = el.getBoundingClientRect();
          out.hit = !!document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest(".call-card");
        }
      }
      const now = performance.now();
      if (now - born < 15_000 && (out.t0 === null || now - out.t0 < 3000)) requestAnimationFrame(tick);
      else window.removeEventListener("click", onClick, true);
    };
    requestAnimationFrame(tick);
  });
}
/** the close watch, judged: ≤ 0.05 opacity from 200 ms, out of the DOM soon after it is clear, taps through at once */
async function checkClose(p, page, what) {
  await page.waitForFunction(() => window.__close?.gone !== null, null, { timeout: 4000 }).catch(() => {});
  const c = await page.evaluate(() => window.__close);
  const late = c.samples.filter((x) => x.t >= 200);
  const maxLate = late.length ? Math.max(...late.map((x) => x.o)) : 0;
  const first = c.samples[0];
  const trace = c.samples.filter((_, i) => i % 2 === 0).map((x) => `${x.t}:${x.o}`).join(" ");
  p.metrics.close ??= {};
  p.metrics.close[what] = { gone: c.gone, maxAfter200: maxLate, trace };
  p.check(`${what}: the card is clear (≤ 0.05) 200 ms after the tap`, maxLate <= 0.05, { maxAfter200: maxLate, trace });
  p.check(`${what}: the card leaves the DOM as soon as it is clear`, c.gone !== null && c.gone <= 320, { gone: c.gone });
  p.check(`${what}: taps pass through the closing card from its first frame`, !!first && first.pe === "none" && c.hit === false, { first, hit: c.hit });
}

/** De-slop fixtures (scenario 18): one main-thread history with every card the chat renders, plus a live meeting
 * thread. Copy follows the server's own strings (phone.ts, meet.ts). `call` on the phone approval is the device-only
 * full number (ApprovalCard.call); a build that does not know the field shows the masked detail as before. */
function deslopThread(threadId, agent) {
  const T = Date.now() - 2 * 3600_000;
  let n = 0;
  const msg = (role, text, extra = {}) => ({ id: `ds-m${++n}`, threadId, role, text, cards: [], tools: [], attachments: [], createdAt: T + n * 60_000, ...extra });
  const tool = (name, title, state, summary) => ({ id: `ds-t${++n}`, name, title, state, summary, startedAt: T + n * 60_000, endedAt: state === "done" ? T + n * 60_000 + 3000 : undefined });
  return [
    msg("user", "내가 지금 신청할 수 있는 정부 지원사업 찾아줘"),
    msg("assistant", "조건에 맞는 지원사업을 3개 찾았어요. 청년 월세 지원은 이번 달 말에 마감이라 먼저 보시는 게 좋아요.", {
      tools: [tool("k_gov24", "정부24 지원사업 검색", "done", "3건")],
      cards: [
        {
          type: "results",
          title: "신청할 수 있는 지원사업",
          source: "정부24",
          items: [
            { title: "청년 월세 한시 특별지원", subtitle: "월 최대 20만 원 · 12개월", meta: "11월 30일 마감", icon: "house" },
            { title: "국민내일배움카드", subtitle: "훈련비 최대 500만 원", meta: "상시", icon: "card" },
            { title: "청년도약계좌", subtitle: "정부 기여금 월 최대 3.3만 원", meta: "12월 신청", icon: "coins" },
          ],
        },
      ],
    }),
    msg("user", "카톡 안 읽은 대화도 정리해 줘"),
    msg("assistant", "카카오톡을 읽으려면 로그인이 한 번 필요해요.", {
      tools: [tool("msg_read", "카카오톡 읽기", "needs_credential")],
      cards: [
        {
          type: "credential_request",
          service: "kakaotalk",
          serviceName: "카카오톡",
          reason: "안 읽은 대화를 가져오려면 카카오 계정으로 로그인해야 해요.",
          fields: [
            { key: "username", label: "카카오 계정", type: "email", autocomplete: "username", placeholder: "이메일 또는 전화번호" },
            { key: "password", label: "비밀번호", type: "password", autocomplete: "current-password" },
          ],
          status: "pending",
        },
      ],
    }),
    msg("user", "지난번 회의 들어가서 받아 적어 줘 https://meet.google.com/abc-defg-hij"),
    msg("assistant", "", {
      tools: [tool("sys_join_meet", "회의 참여", "done", "승인됨")],
      cards: [{ type: "approval", approvalId: "ds-ap-meet-done", title: "Google Meet 회의(abc-defg-hij)에 참여할까요?", detail: `${agent}가 이 회의에 참여해 듣고 받아 적어요. 참석자들에게는 AI 비서라고 먼저 알려요.`, status: "approved" }],
    }),
    msg("event", "Google Meet 회의(abc-****-hij)에 참여하러 갈게요."),
    msg("event", `회의에 들어왔어요. 지금부터 받아 적을게요. 회의 중에 '${agent}야'라고 부르면 대답해요.`),
    msg("event", "호스트가 참여 요청을 받아 주지 않았어요."),
    msg("assistant", "**회의 요약**\n\n**정한 것**\n- 출시일은 12월 2일로 확정했어요.\n\n**할 일**\n- 하늘: 랜딩 문구 금요일까지", {
      cards: [{ type: "artifact", artifactId: "ds-art-doc", title: "11월 12일 주간회의 회의록", kind: "document", preview: "참석 4명 · 42분 · 정한 것 2 · 할 일 2" }],
    }),
    msg("user", "매일 아침 7시에 날씨랑 뉴스 브리핑해줘"),
    msg("assistant", "매일 아침 7시에 브리핑을 보내 드릴게요.", {
      tools: [tool("sys_schedule_create", "예약 만들기", "done", "매일 오전 7:00")],
      cards: [{ type: "schedule", scheduleId: "ds-sc-1", title: "아침 브리핑", when: "매일 오전 7:00", enabled: true }],
    }),
    msg("user", "이 회의에도 들어가 줘 https://meet.google.com/rak-dmqe-kud 주간 회의 받아 적기"),
    msg("assistant", "", {
      tools: [tool("sys_join_meet", "회의 참여", "needs_approval")],
      cards: [
        {
          type: "approval",
          approvalId: "ds-ap-meet",
          // today's server: the title is masked, the full code travels in `meet` (owner's device only)
          title: "Google Meet 회의(rak-****-kud)에 참여할까요?",
          detail: `${agent}가 이 회의에 참여해 듣고 받아 적어요. 참석자들에게는 AI 비서라고 먼저 알려요.\n목적: 주간 회의 받아 적기`,
          status: "pending",
          meet: { code: "rak-dmqe-kud" },
        },
      ],
    }),
    msg("user", "연세바른치과에 내일 3시 예약 되는지 전화해서 물어봐 줘"),
    msg("assistant", "", {
      tools: [tool("sys_phone_call", "전화 걸기", "needs_approval")],
      cards: [
        {
          type: "approval",
          approvalId: "ds-ap-call",
          title: "연세바른치과에 전화할까요?",
          detail: "02-****-1234로 전화해서 이렇게 전할게요: “안녕하세요, 하늘 님 대신 연락드렸어요. 내일 오후 3시에 진료 예약이 가능한지 여쭤봐도 될까요?”",
          status: "pending",
          call: { target: "연세바른치과", number: "02-1234-1234", message: "안녕하세요, 하늘 님 대신 연락드렸어요. 내일 오후 3시에 진료 예약이 가능한지 여쭤봐도 될까요?" },
        },
      ],
    }),
  ];
}
function deslopMeetThread(agent) {
  const T = Date.now() - 20 * 60_000;
  const thread = { id: "ds-meet", kind: "call", title: "회의 참여", subtitle: `${agent}의 회의 참여`, icon: "people", archived: false, unread: false, createdAt: T, updatedAt: T + 10 * 60_000 };
  const ev = (i, text) => ({ id: `ds-me${i}`, threadId: thread.id, role: "event", text, cards: [], tools: [], attachments: [], createdAt: T + i * 60_000 });
  const items = [ev(1, "Google Meet 회의(rak-****-kud)에 참여하러 갈게요."), ev(2, "참여 요청을 보냈어요. 호스트가 수락하면 들어가요."), ev(3, `회의에 들어왔어요. 지금부터 받아 적을게요. 회의 중에 '${agent}야'라고 부르면 대답해요.`)];
  const meeting = { id: "ds-mt", state: "in_call", live: true, code: "rak-****-kud", title: "주간 회의", purpose: "주간 회의 받아 적기", startedAt: T, joinedAt: T + 2 * 60_000, endedAt: null };
  return { thread, items, meeting };
}

/** toolfold (2026-11-15): research turns whose records fold behind the turn's line, beside cards that never fold */
const FOLD_ANSWER =
  "일본은 지금 여행경보가 없는 나라라서 오사카 여행은 괜찮아요. 다만 외교부는 출발 전에 지진과 태풍 소식을 확인하라고 안내하고 있어요.\n\n마운자로는 일본에서도 처방전이 있어야 살 수 있고, 최근 오사카 약국 재고가 부족하다는 기사가 있었어요. 가져가실 약은 영문 처방전과 함께 챙기세요.";
const FOLD_LIVE_ANSWER =
  "오사카는 내일 맑고 낮 최고 17도예요. 우메다와 난바 근처 약국 다섯 곳 중 두 곳에 재고가 있다고 나와 있지만, 블로그 정보라 가시기 전에 전화로 한 번 더 확인해 보세요. 처방전은 영문으로 챙기시면 돼요.";
function foldResults(title, source, n) {
  const names = ["간사이 공항 약국", "우메다 역 약국", "난바 파크스 약국", "신사이바시 약국", "덴노지 약국", "교바시 약국"];
  return {
    type: "results",
    title,
    source,
    items: names.slice(0, n).map((x, i) => ({ title: x, subtitle: i % 2 ? "재고 없음 · 입고 예정" : "재고 있음 · 처방전 필요", meta: `${i + 1}.${i}km` })),
  };
}
function foldWeather(place) {
  return {
    type: "weather",
    place,
    now: { tempC: 14, condition: "맑음", icon: "sun" },
    high: 17,
    low: 9,
    hourly: [9, 12, 15, 18, 21].map((h, i) => ({ hour: `${h}시`, tempC: 11 + i, icon: i > 3 ? "moon" : "sun", pop: 10 })),
    source: "기상청",
  };
}
function foldThread(threadId) {
  const T = Date.now() - 3 * 3600_000;
  let n = 0;
  const msg = (role, text, extra = {}) => ({ id: `tf-m${++n}`, threadId, role, text, cards: [], tools: [], attachments: [], createdAt: T + n * 60_000, ...extra });
  const tool = (name, title, state, summary, ms = 2000) => ({ id: `tf-t${++n}`, name, title, state, summary, startedAt: T + n * 60_000, endedAt: state === "done" ? T + n * 60_000 + ms : undefined });
  return [
    msg("user", "일본 여행 가도 괜찮은지랑 마운자로 오사카 뉴스 찾아 줘"),
    msg("assistant", FOLD_ANSWER, {
      tools: [tool("k_travel_safety", "일본 여행경보 확인", "done", "여행경보 없음"), tool("k_news", "'마운자로 일본 오사카' 뉴스 검색", "done", "기사 5건", 4000), tool("k_weather", "오사카 날씨 확인", "done", "맑음 14°")],
      cards: [
        { type: "results", title: "일본 여행경보", source: "외교부 해외안전여행", items: [{ title: "일본 전 지역", subtitle: "여행경보 없음 · 특별여행주의보 없음", meta: "11월 14일" }, { title: "지진·태풍 안전 공지", subtitle: "출발 전 기상청 정보 확인", meta: "11월 10일" }] },
        { type: "results", title: "'마운자로 일본 오사카' 뉴스", source: "네이버 뉴스", items: [{ title: "日 약국 마운자로 품귀… 처방전 없으면 못 사", subtitle: "연합뉴스", meta: "2시간 전" }, { title: "오사카 여행객 약 반입 규정 정리", subtitle: "한국일보", meta: "어제" }, { title: "비만치료제 해외 구매 주의보", subtitle: "뉴시스", meta: "3일 전" }] },
        foldWeather("오사카"),
      ],
    }),
    msg("user", "공연 모임 단톡에 리허설 시간 바뀐 거 보내 줘"),
    msg("assistant", "보내기 전에 한 번 확인해 주세요.", {
      tools: [tool("msg_send", "카카오톡 '주말 연극 모임'에 보내기", "needs_approval")],
      cards: [{ type: "approval", approvalId: "tf-ap-send", title: "'주말 연극 모임'에 이 메시지를 보낼까요?", detail: "“이번 주 리허설은 토요일 오후 3시로 바뀌었어요. 장소는 그대로 대학로 연습실이에요.”", status: "pending" }],
    }),
    msg("user", "지원사업 찾아 둔 거 다시 보여 줘"),
    msg("assistant", "지난번에 찾은 지원사업이에요. 청년 월세 지원이 이번 달 말에 마감이에요.", {
      cards: [{ type: "results", title: "신청할 수 있는 지원사업", source: "정부24", items: [{ title: "청년 월세 한시 특별지원", subtitle: "월 최대 20만 원", meta: "11월 30일 마감" }] }],
    }),
    msg("user", "제주 2박 3일 일정 문서로 만들어 줘"),
    msg("assistant", "제주 2박 3일 일정을 문서로 만들었어요. 날씨도 같이 넣어 두었어요.", {
      tools: [tool("k_weather", "제주 날씨 확인", "done", "맑음 18°"), tool("sys_create_artifact", "문서 만들기", "done", "제주 2박 3일 일정")],
      cards: [foldWeather("제주"), { type: "artifact", artifactId: "tf-art-1", title: "제주 2박 3일 일정", kind: "document", preview: "1일차 · 2일차 · 3일차 · 맛집 6곳" }],
    }),
    // web_search rows (user report 2026-11-15): the page's snippet came in `meta`, the never-wrapping right column, and
    // pushed the row off the card while the domain stood one letter a line
    msg("user", "마운자로 오사카 병원 웹에서 찾아 줘"),
    msg("assistant", "웹에서 찾은 곳이에요. 고토의원은 인스타그램 DM으로 예약해요.", {
      tools: [tool("web_search", "'마운자로 오사카 병원' 웹 검색", "done", "10건")],
      cards: [
        {
          type: "results",
          title: "'마운자로 오사카 병원' 웹 검색",
          source: "웹 검색",
          items: [
            { title: "오사카 마운자로 성지 가격·병원·처방 후기: 고토의원, 신사이바시 | 자로자로", subtitle: "jarojaro.com", meta: "신사이바시 | 14,800엔 | 22, ... - 예약: 인스타그램 DM으로 날짜, 용량, 이름을 보내면 하루 안에 답이 와요. 한국어 상담은 평일…", url: "https://jarojaro.com/osaka" },
            { title: "스시자로(스시마운자로) 총정리 - 일본 마운자로 처방 병원 125곳과 반입 기준", subtitle: "aitoolog.com · 2026-11-10", meta: "https://aitoolog.com/clinics?city=osaka&dose=2.5mg&sort=price_asc&lang=ko&page=2&per=50 에서 전체 목록", url: "https://aitoolog.com/clinics" },
            { title: "後藤医院 マンジャロ価格", subtitle: "goto-iin.com", meta: "¥14,800", url: "https://goto-iin.com/" },
            // the news shape (domain · time, 23) still fits the right column; the place shape (facts, 31) goes under
            { title: "日 약국 마운자로 품귀… 처방전 없으면 못 사", subtitle: "연합뉴스", meta: "yna.co.kr · 11/15 09:30", url: "https://www.yna.co.kr/" },
            { title: "난바 숯불 야키니쿠", subtitle: "오사카시 주오구 난바 3-2-18 난바 센터 빌딩 2층", meta: "육류,고기 · 06-1234-5678 · 350m" },
          ],
        },
      ],
    }),
    msg("user", "고마워"),
    msg("assistant", "천만에요. 더 필요한 게 있으면 말씀해 주세요."),
  ];
}
/** The next chat-mode POST to /api/threads/:id/messages is answered inside the page by a scripted SSE turn
 *  (`window.__turnScript` = [[delayMs, event], …]; "$mid"/"$now" placeholders filled in), so the tool calls, the
 *  cards and the token cadence are exact and no LLM is involved. Everything else goes to the real fetch. */
async function installTurnScript(page) {
  await page.evaluate(() => {
    const real = window.__realFetch ?? window.fetch.bind(window);
    window.__realFetch = real;
    const prev = window.fetch;
    window.fetch = async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input.url, location.href);
      const m = /^\/api\/threads\/([^/]+)\/messages$/.exec(url.pathname);
      const script = window.__turnScript;
      let body = null;
      try {
        body = m && init?.method === "POST" ? JSON.parse(init.body || "{}") : null;
      } catch {}
      if (!script || !body || body.mode === "voice") return prev(input, init);
      window.__turnScript = null;
      const threadId = decodeURIComponent(m[1]);
      const enc = new TextEncoder();
      const now = Date.now();
      const mid = `m_tf_${now}`;
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const fill = (o) => JSON.parse(JSON.stringify(o).replaceAll('"$mid"', JSON.stringify(mid)).replaceAll('"$thread"', JSON.stringify(threadId)).replaceAll('"$text"', JSON.stringify(body.text)));
      const stream = new ReadableStream({
        async start(c) {
          const send = (o) => c.enqueue(enc.encode(`data: ${JSON.stringify(o)}\n\n`));
          send({ type: "start", threadId, messageId: mid, userMessage: { id: `u_tf_${now}`, threadId, role: "user", text: body.text, cards: [], tools: [], attachments: [], createdAt: now } });
          for (const [ms, ev] of script) {
            await wait(ms);
            const e = fill(ev);
            if (e.type === "tool") e.tool.startedAt = e.tool.startedAt ?? now;
            if (e.type === "tool" && e.tool.state === "done") e.tool.endedAt = Date.now();
            if (e.type === "done") e.message.createdAt = Date.now();
            send(e);
          }
          c.close();
        },
      });
      return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
    };
  });
}
// 적용 후 captures for the picked drafts (docs/design/drafts/APPLY.md): with QA_APPLIED_DIR set, these states are also
// saved at device scale (PNG) from the Chrome light / dark passes; `sips` turns them into the 390×844 @2x q82 JPEGs.
const APPLIED_DIR = process.env.QA_APPLIED_DIR ? path.resolve(process.env.QA_APPLIED_DIR) : "";
const APPLIED = {
  "deslop:01-latest-phone-approval": "phone-delegation/applied",
  "meetb:01-pending": "meeting/applied-pending",
  "meetb:03-live": "meeting/applied",
  "meetb:05-summary": "meeting/applied-summary",
};
async function appliedShot(page, p, step, name) {
  const stem = APPLIED[`${step}:${name}`];
  const [engine, variant] = p.tag.split("-");
  if (!APPLIED_DIR || !stem || engine !== "chromium" || (variant !== "light" && variant !== "dark")) return;
  const file = path.join(APPLIED_DIR, `${stem}-${variant}.png`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await page.screenshot({ path: file, type: "png", scale: "device" });
}
/** the rendered colour of one CSS pixel (a 1×1 PNG screenshot: with no neighbours every PNG filter reads raw) */
async function pixelAt(page, x, y) {
  const png = await page.screenshot({ type: "png", scale: "css", clip: { x: Math.round(x), y: Math.round(y), width: 1, height: 1 } });
  let at = 8;
  let colorType = 2;
  const idat = [];
  while (at < png.length) {
    const len = png.readUInt32BE(at);
    const type = png.toString("ascii", at + 4, at + 8);
    if (type === "IHDR") colorType = png[at + 8 + 9];
    if (type === "IDAT") idat.push(png.subarray(at + 8, at + 8 + len));
    at += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  void colorType; // RGB or RGBA: the first three bytes after the filter byte either way
  return { r: raw[1], g: raw[2], b: raw[3] };
}
/** WCAG contrast ratio of two opaque colours */
function ratioOf(a, b) {
  const f = (v) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const lum = (c) => 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return Math.round(((hi + 0.05) / (lo + 0.05)) * 1000) / 1000;
}
/** in-page: WCAG contrast of an element's text against what is actually behind it (its own fill composited over the
 * first opaque ancestor, else the --bg token) */
async function contrastOf(page, selector) {
  return page.evaluate((sel) => {
    const parse = (c) => {
      const m = /rgba?\(([^)]+)\)/.exec(c);
      if (!m) return null;
      const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
      return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
    };
    const over = (top, bottom) => ({ r: top.r * top.a + bottom.r * (1 - top.a), g: top.g * top.a + bottom.g * (1 - top.a), b: top.b * top.a + bottom.b * (1 - top.a), a: 1 });
    const lum = (c) => {
      const f = (v) => {
        v /= 255;
        return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
    };
    const probe = document.createElement("span");
    probe.style.color = "var(--bg)";
    document.body.appendChild(probe);
    const bgTok = parse(getComputedStyle(probe).color);
    probe.remove();
    return [...document.querySelectorAll(sel)]
      .filter((el) => el.getClientRects().length)
      .map((el) => {
        const layers = [];
        for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
          const c = parse(getComputedStyle(n).backgroundColor);
          if (c && c.a > 0) {
            layers.push(c);
            if (c.a >= 1) break;
          }
        }
        let bg = layers.length && layers[layers.length - 1].a >= 1 ? layers.pop() : bgTok;
        for (let i = layers.length - 1; i >= 0; i--) bg = over(layers[i], bg);
        const fg = over(parse(getComputedStyle(el).color), bg);
        const [a, b] = [lum(fg), lum(bg)].sort((x, y) => y - x);
        return { text: el.textContent.trim().slice(0, 24), ratio: Math.round(((a + 0.05) / (b + 0.05)) * 100) / 100 };
      });
  }, selector);
}
/** Turn streams for the transcript scenario, scripted inside the page: the next voice-mode POST to
 * /api/threads/:id/messages is answered by a local SSE stream (start → text deltas every `everyMs` → done) instead of
 * the server, so the token cadence is exact and no LLM is involved. Everything else goes to the real fetch. */
async function installStreamScript(page) {
  await page.evaluate(() => {
    const real = window.__realFetch ?? window.fetch.bind(window);
    window.__realFetch = real;
    window.__streamScript = null;
    window.fetch = async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input.url, location.href);
      const m = /^\/api\/threads\/([^/]+)\/messages$/.exec(url.pathname);
      const script = window.__streamScript;
      let body = null;
      try {
        body = m && init?.method === "POST" ? JSON.parse(init.body || "{}") : null;
      } catch {}
      if (!script || !body || body.mode !== "voice") return real(input, init);
      window.__streamScript = null;
      const threadId = decodeURIComponent(m[1]);
      const enc = new TextEncoder();
      const now = Date.now();
      const mid = `m_qa_${now}`;
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const stream = new ReadableStream({
        async start(c) {
          const send = (o) => c.enqueue(enc.encode(`data: ${JSON.stringify(o)}\n\n`));
          send({ type: "start", messageId: mid, userMessage: { id: `u_qa_${now}`, threadId, role: "user", text: body.text, cards: [], tools: [], attachments: [], createdAt: now } });
          await wait(script.firstMs ?? 200);
          for (const d of script.deltas) {
            send({ type: "text", delta: d });
            await wait(script.everyMs);
          }
          const quota = { usedPct: 1, usedTokens: 1000, limitTokens: 100000, resetsAt: Date.now() + 3600_000, resetHour: 4 };
          send({ type: "done", message: { id: mid, threadId, role: "assistant", text: script.deltas.join(""), cards: [], tools: [], attachments: [], createdAt: Date.now() }, quota });
          c.close();
        },
      });
      return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
    };
  });
}
/** split text into stream deltas of 2–4 characters (a fixed pattern, so every run streams the same tokens) */
function deltasOf(text) {
  const out = [];
  const sizes = [3, 2, 4, 3, 2];
  for (let i = 0, k = 0; i < text.length; k++) {
    const n = sizes[k % sizes.length];
    out.push(text.slice(i, i + n));
    i += n;
  }
  return out;
}
/** every frame: each transcript line's left edge, its first glyph's x, and where its finished words sit */
async function sampleTranscript(page) {
  await page.evaluate(() => {
    const out = (window.__tx = { frames: [], run: true });
    const PROBES = [0, 8, 16, 24, 40, 60, 90];
    const tick = () => {
      const lines = [...document.querySelectorAll(".call-transcript .call-line")].map((li) => {
        const r = li.getBoundingClientRect();
        let tn = null;
        for (const n of li.childNodes) if (n.nodeType === 3 && n.data.trim()) tn = tn ?? n;
        const text = tn ? tn.data : "";
        const at = (i) => {
          const rg = document.createRange();
          rg.setStart(tn, i);
          rg.setEnd(tn, i + 1);
          const q = rg.getClientRects()[0];
          return q ? { x: q.left, y: q.top - r.top } : null;
        };
        const first = tn ? text.search(/\S/) : -1;
        const g = first >= 0 ? at(first) : null;
        // a probe counts once its word is finished (a space follows it): the word being typed may still wrap
        const words = tn ? PROBES.filter((k) => k < text.length && text[k] !== " " && text.indexOf(" ", k) !== -1).map((k) => ({ k, ...at(k) })) : [];
        return { id: li.dataset.line || "", who: li.dataset.who || "", cur: li.hasAttribute("data-current"), left: r.left, width: r.width, top: r.top, gx: g ? g.x : null, len: text.length, words };
      });
      out.frames.push({ t: performance.now(), lines });
      if (out.run && out.frames.length < 2400) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}
/** the strip's numbers: the worst sideways move of any line already on screen, frame to frame */
function judgeTranscript(frames) {
  const r1 = (v) => Math.round(v * 100) / 100;
  let maxLeft = 0;
  let maxGlyph = 0;
  let maxWord = 0;
  let maxWordY = 0;
  const worst = { left: null, glyph: null, word: null };
  for (let i = 1; i < frames.length; i++) {
    const a = new Map(frames[i - 1].lines.map((l) => [l.id, l]));
    for (const b of frames[i].lines) {
      const p = a.get(b.id);
      if (!p) continue;
      const dl = Math.abs(b.left - p.left);
      if (dl > maxLeft) [maxLeft, worst.left] = [dl, { t: Math.round(frames[i].t - frames[0].t), id: b.id, who: b.who, from: r1(p.left), to: r1(b.left) }];
      if (p.gx !== null && b.gx !== null) {
        const dg = Math.abs(b.gx - p.gx);
        if (dg > maxGlyph) [maxGlyph, worst.glyph] = [dg, { t: Math.round(frames[i].t - frames[0].t), id: b.id, who: b.who, len: b.len, from: r1(p.gx), to: r1(b.gx) }];
      }
      const pw = new Map(p.words.map((w) => [w.k, w]));
      for (const w of b.words) {
        const q = pw.get(w.k);
        if (!q || q.x == null || w.x == null) continue;
        const dx = Math.abs(w.x - q.x);
        const dy = Math.abs(w.y - q.y);
        if (dx > maxWord || dy > maxWordY) worst.word = { t: Math.round(frames[i].t - frames[0].t), id: b.id, who: b.who, k: w.k, dx: r1(w.x - q.x), dy: r1(w.y - q.y) };
        maxWord = Math.max(maxWord, dx);
        maxWordY = Math.max(maxWordY, dy);
      }
    }
  }
  const ms = frames.length > 1 ? Math.round(frames[frames.length - 1].t - frames[0].t) : 0;
  return { frames: frames.length, ms, maxLeftPx: r1(maxLeft), maxGlyphPx: r1(maxGlyph), maxWordXPx: r1(maxWord), maxWordYPx: r1(maxWordY), worst };
}

/** sample the call card (phase, voice, level bar) every 40 ms inside the page */
async function sampleCall(page) {
  await page.evaluate(() => {
    clearInterval(window.__callSampler);
    window.__callSamples = [];
    window.__callSampler = setInterval(() => {
      const card = document.querySelector(".call-card");
      // voice-call B: the card has no level bar (the character takes the level); the island's dots show it as --lvl
      const level = Number(document.querySelector(".island-anchor[data-kind=call] .island-dots")?.style.getPropertyValue("--lvl") || 0);
      window.__callSamples.push({ t: performance.now(), w: Date.now(), phase: card?.dataset.phase || "", voice: card?.dataset.voice || "", level });
    }, 40);
  });
}
async function stopSampling(page) {
  return page.evaluate(() => {
    clearInterval(window.__callSampler);
    return window.__callSamples || [];
  });
}
/** the longest stretch (ms) of zero level between the first and the last audible sample */
function longestSilence(samples) {
  const loud = samples.filter((x) => x.level > 0.01);
  if (loud.length < 2) return -1;
  const from = loud[0].t;
  const to = loud[loud.length - 1].t;
  let worst = 0;
  let start = null;
  for (const x of samples) {
    if (x.t < from || x.t > to) continue;
    if (x.level <= 0.01) start ??= x.t;
    else if (start !== null) {
      worst = Math.max(worst, x.t - start);
      start = null;
    }
  }
  return Math.round(worst);
}
/** poll a node-side condition */
async function until(fn, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await sleep(50);
  }
  return fn();
}
const levelNow = (page) => page.evaluate(() => Number(document.querySelector(".island-anchor[data-kind=call] .island-dots")?.style.getPropertyValue("--lvl") || 0));
const callVoice = (page) => page.evaluate(() => document.querySelector(".call-card")?.dataset.voice || "");
const callPhase = (page) => page.evaluate(() => document.querySelector(".call-card")?.dataset.phase || "");
async function waitVoice(page, voice, timeout) {
  return page
    .waitForFunction((v) => document.querySelector(".call-card")?.dataset.voice === v, voice, { timeout })
    .then(() => true)
    .catch(() => false);
}
async function waitPhase(page, phase, timeout) {
  return page
    .waitForFunction((ph) => document.querySelector(".call-card")?.dataset.phase === ph, phase, { timeout })
    .then(() => true)
    .catch(() => false);
}
/** a scripted microphone + speech recogniser (both engines): the test says what the person said */
async function installScriptedSpeech(page) {
  await page.evaluate(() => {
    // one silent source for every call; patched on the prototype too (WebKit drops the instance override after a call)
    const fakeMic = async () => {
      window.__micCtx ??= new AudioContext();
      return window.__micCtx.createMediaStreamDestination().stream;
    };
    MediaDevices.prototype.getUserMedia = fakeMic;
    navigator.mediaDevices.getUserMedia = fakeMic;
    class ScriptedRecognition {
      constructor() {
        Object.assign(this, { lang: "", continuous: false, interimResults: false, maxAlternatives: 1, onresult: null, onerror: null, onend: null });
      }
      start() {
        window.__rec.cur = this;
        window.__rec.starts++;
      }
      // like Chrome's: stop() finalises words still being heard (window.__rec.pending) before it ends; abort() drops them
      stop() {
        const pending = window.__rec.cur === this ? window.__rec.pending : null;
        window.__rec.pending = null;
        if (window.__rec.cur === this) window.__rec.cur = null;
        setTimeout(() => {
          if (pending) this.onresult?.({ resultIndex: 0, results: [Object.assign({ isFinal: true, 0: { transcript: pending } }, { length: 1 })] });
          this.onend?.();
        }, 0);
      }
      abort() {
        window.__rec.pending = null;
        this.stop();
      }
    }
    window.__rec = {
      cur: null,
      starts: 0,
      pending: null,
      say(text, isFinal) {
        const r = window.__rec.cur;
        if (!r || !r.onresult) return false;
        r.onresult({ resultIndex: 0, results: [Object.assign({ isFinal, 0: { transcript: text } }, { length: 1 })] });
        return true;
      },
    };
    window.SpeechRecognition = ScriptedRecognition;
  });
}
/** Web Speech output spy (the 503 fallback): records what is spoken; each utterance "ends" after 500 ms */
async function installSpeechSpy(page) {
  await page.evaluate(() => {
    window.__spoken = [];
    let cur = null;
    if (typeof window.SpeechSynthesisUtterance === "undefined")
      window.SpeechSynthesisUtterance = class {
        constructor(text) {
          this.text = text;
        }
      };
    const fake = {
      speak(u) {
        window.__spoken.push(u.text);
        cur = u;
        setTimeout(() => {
          if (cur !== u) return;
          cur = null;
          u.onend?.(new Event("end"));
        }, 500);
      },
      cancel() {
        const u = cur;
        cur = null;
        if (u) setTimeout(() => u.onerror?.(new Event("error")), 0);
      },
      getVoices: () => [],
    };
    Object.defineProperty(window, "speechSynthesis", { value: fake, configurable: true });
  });
}
const recSay = (page, text, isFinal) => page.evaluate(([t, f]) => window.__rec.say(t, f), [text, isFinal]);

// ── the pass ──

async function runPass(browserType, engine, variant, friend) {
  const browser = await browserType.launch(engine === "chromium" ? { channel: "chrome", args: ["--use-fake-device-for-media-stream"] } : {});
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    colorScheme: variant === "dark" ? "dark" : "light",
    reducedMotion: variant === "reduced" ? "reduce" : "no-preference",
    locale: "ko-KR",
  });
  await context.addInitScript(INIT);
  const page = await context.newPage();
  const p = new Pass(engine, variant, page);
  const isChrome = engine === "chromium";
  const tts = TTS_REAL ? await watchTts(page) : await installTts(page);
  // the account made through the onboarding UI turns the daily briefing off the moment the server answers the sign-up
  // (the scheduler ticks every 30 s; waiting for the hand-off into the chat left a ~2 s window it sometimes hit)
  const quieted = new Promise((resolve) => {
    page.on("response", (res) => {
      if (res.status() !== 201 || res.request().method() !== "POST" || !new URL(res.url()).pathname.endsWith("/api/auth/signup")) return;
      res.json().then((b) => quietBriefing(b?.token)).catch(() => {}).finally(resolve);
    });
  });
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const entry = { step: p.step, text: m.text().slice(0, 300) };
    if (/Failed to load resource: the server responded with a status of (401|409|429)/.test(entry.text) && ["login-error", "signup-taken", "steer", "busy", "deslop-409"].includes(p.step)) p.expected.push(entry);
    else if (/status of 503/.test(entry.text) && p.step === "call-tts-503") p.expected.push(entry);
    // WebKit reports the reload cancelling an in-flight fetch as "… due to access control checks"
    else if (p.step === "older" && /due to access control checks/.test(entry.text)) p.expected.push(entry);
    else if (p.step === "failed" && /ERR_INTERNET_DISCONNECTED|Failed to fetch|NetworkError|net::ERR|WebKit encountered an internal error|network connection was lost/.test(entry.text)) p.expected.push(entry);
    else p.errors.push(entry);
  });
  // which API requests a navigation cut off, and how long after it started (WebKit then reports "… due to access
  // control checks"): kept in the metrics so such an error can be told apart from a real one
  let navAt = 0;
  page.on("framenavigated", (f) => {
    if (f === page.mainFrame()) navAt = Date.now();
  });
  page.on("requestfailed", (r) => {
    const u = new URL(r.url());
    if (!u.pathname.startsWith("/api/")) return;
    (p.metrics.cutRequests ??= []).push({ step: p.step, path: u.pathname, failure: r.failure()?.errorText ?? "", msAfterNav: Date.now() - navAt });
  });
  page.on("pageerror", (e) => {
    const entry = { step: p.step, text: `pageerror: ${e.message}`, msAfterNav: Date.now() - navAt };
    if (p.step === "older" && /due to access control checks/.test(e.message)) p.expected.push(entry);
    else p.errors.push(entry);
  });

  const handle = `qa${variant.slice(0, 1)}${engine.slice(0, 1)}${rand()}`;
  try {
    let friendThreadId = null;
    if (API_AUTH) {
      // QA_API_AUTH=1: the account comes from the API and the token goes straight into storage — no password form
      // (WebKit's password submit can stall on a busy macOS keychain daemon on a shared machine)
      p.step = "api-auth";
      const made = await signupApi(handle, "하늘", "깽이");
      await page.goto(`${BASE}/`, { waitUntil: "load" });
      await page.evaluate((t) => localStorage.setItem("pickle.token", t), made.token);
      await quietBriefing(made.token);
      await page.goto(`${BASE}/`, { waitUntil: "load" });
      await page.waitForSelector("#tab-explore", { timeout: 20_000 });
      await sleep(1200);
      p.check("signed in through the API (no onboarding UI)", (await page.locator(".onb").count()) === 0);
    } else {
      // ── 1. invite link + onboarding ──
      p.step = "onboarding";
      await page.goto(`${BASE}/?invite=${friend.invite}`, { waitUntil: "load" });
      await page.waitForSelector(".onb");
      await sleep(1600);
      p.check("onboarding shows the invite note", await page.locator(".onb-invite").isVisible());
      p.check("invite token removed from the URL", !page.url().includes("invite="));
      await p.shot("onboarding");

      p.step = "login-error";
      await p.interact("open-login", () => page.getByRole("button", { name: /로그인/ }).first().click());
      await page.waitForSelector("[role=dialog] .onb-form");
      await sleep(500);
      await page.getByRole("textbox", { name: "아이디" }).fill(`nobody_${rand()}`);
      await page.getByRole("textbox", { name: "비밀번호" }).fill("wrong-pass-0");
      await authSlot();
      // onboarding B: the login footer also holds "처음이에요 · 시작하기", so press 로그인 by name
      await page.getByRole("button", { name: "로그인", exact: true }).click();
      const loginErr = await page.waitForSelector("[role=dialog] .tf-error, [role=dialog] .onb-form-error, [role=dialog] [role=alert]", { timeout: 10_000 }).then((h) => h.textContent()).catch(() => "");
      p.check("wrong login shows the server's Korean error inline", /[가-힣]/.test(loginErr || ""), loginErr);
      p.check("still on onboarding after a failed login", (await page.locator(".onb").count()) === 1);
      await p.shot("login-error");
      await page.keyboard.press("Escape");
      await page.waitForSelector("[role=dialog]", { state: "detached", timeout: 5000 }).catch(() => {});
      await sleep(400);

      p.step = "signup-taken";
      await p.interact("open-signup", () => page.getByRole("button", { name: "시작하기" }).click());
      await page.waitForSelector("[role=dialog] .onb-form");
      await sleep(500);
      await page.getByRole("textbox", { name: "아이디" }).fill("A!");
      await page.getByRole("textbox", { name: "비밀번호" }).fill("short");
      await page.getByRole("button", { name: "다음" }).click();
      await sleep(300);
      const clientErrs = await page.locator("[role=dialog] .tf-error, [role=dialog] [role=alert]").count();
      p.check("invalid handle / short password are caught before the server", clientErrs >= 1, clientErrs);
      await page.getByRole("textbox", { name: "아이디" }).fill(friend.handle);
      await page.getByRole("textbox", { name: "비밀번호" }).fill(PASSWORD);
      await page.getByRole("button", { name: "다음" }).click();
      await page.waitForSelector("[role=dialog] >> text=내 이름");
      await page.getByRole("textbox", { name: "내 이름" }).fill("하늘");
      await sleep(300);
      await p.shot("signup-step2");
      await authSlot();
      await page.getByRole("button", { name: "모시 만들기" }).click();
      const takenErr = await page
        .waitForFunction(() => document.querySelector("[role=dialog]")?.textContent?.includes("아이디") && document.querySelector("[role=dialog] .tf-error, [role=dialog] [role=alert]")?.textContent, null, { timeout: 10_000 })
        .then((h) => h.jsonValue())
        .catch(() => "");
      p.check("taken handle: server error shown at the 아이디 field (back on step 1)", /[가-힣]/.test(String(takenErr)), String(takenErr));
      await sleep(900);
      await p.shot("signup-taken");

      p.step = "signup";
      await page.getByRole("textbox", { name: "아이디" }).fill(handle);
      await page.getByRole("button", { name: "다음" }).click();
      await page.waitForSelector("[role=dialog] >> text=내 이름");
      await sleep(300);
      await authSlot();
      const t0 = Date.now();
      await p.interact("signup", () => page.getByRole("button", { name: "모시 만들기" }).click());
      await page.waitForSelector(".onb", { state: "detached", timeout: 20_000 });
      p.metrics.signupToChatMs = Date.now() - t0;
      p.check("sign-up hands off into the chat", true, `${p.metrics.signupToChatMs} ms`);
      await Promise.race([quieted, sleep(5000)]);

      // ── 2. invite accepted → banner → friend thread ──
      p.step = "invite";
      const banner = await page.waitForSelector(".banner-title", { timeout: 15_000 }).then((h) => h.textContent()).catch(() => "");
      p.check("invite accepted: banner names the friend", /친구가 됐어요/.test(banner || ""), banner);
      await page.waitForSelector(".thread-intro[data-kind=friend]", { timeout: 15_000 }).catch(() => {});
      p.check("the friend thread opened", (await page.locator(".thread-intro[data-kind=friend]").count()) > 0);
      await sleep(700);
      await p.shot("invite-friend-thread");

      if (want("friend")) {
        p.step = "friend";
        const threads = await api("GET", "/api/threads", undefined, friend.token);
        const items = threads.body.items ?? threads.body;
        const ft = items.find((t) => t.kind === "friend" && t.peer && t.peer.handle === handle) ?? items.find((t) => t.kind === "friend");
        friendThreadId = ft?.id ?? null;
        if (ft) {
          await api("POST", `/api/threads/${ft.id}/messages`, { text: "안녕하세요 하늘 님! 진우예요." }, friend.token);
          await page.waitForSelector(".msg-other[data-author=peer]", { timeout: 15_000 }).catch(() => {});
          p.check("friend's message arrives live (peer bubble, name)", (await page.locator(".msg-other[data-author=peer]").count()) > 0);
          await send(p, "반가워요 진우 님!");
          const delivered = await page.waitForSelector(".msg-receipt >> text=전달됨", { timeout: 8000 }).then(() => true).catch(() => false);
          p.check("201 delivered: bubble kept with 전달됨, no agent turn", delivered);
          await composer(page).click();
          await composer(page).fill("");
          await sleep(300);
          p.check("@mention hint offered in a friend thread", (await page.locator(".composer-mention").count()) > 0);
          // CP-8: it leads with the @ glyph (inner ring + tail), not sparkles, and still reads "@이름 붙이면 …"
          const hint = await page.locator(".composer-mention").first().evaluate((b) => ({ text: b.textContent.trim(), at: !!b.querySelector('svg circle[r="3.5"]') })).catch(() => ({ text: "", at: false }));
          p.check("the mention hint leads with the @ glyph and reads '@이름 붙이면'", hint.at && /^@\S+ 붙이면/.test(hint.text), hint);
          await p.shot("friend-mention-hint");
          await send(p, "@깽이 우리 이번 주말에 같이 볼 만한 전시 하나 추천해 줘");
          await page.waitForSelector(".msg-other[data-author=my-agent] .asst-text", { timeout: LLM_MS }).catch(() => {});
          await waitIdle(page).catch(() => {});
          p.check("my Pickle answers in the shared thread", (await page.locator(".msg-other[data-author=my-agent]").count()) > 0);
          await api("POST", `/api/threads/${ft.id}/messages`, { text: "@콩이 좋은데? 너도 하나 골라 줘" }, friend.token);
          await page.waitForSelector(".msg-other[data-author=peer-agent] .asst-text", { timeout: LLM_MS }).catch(() => {});
          await sleep(800);
          const authors = await page.evaluate(() => [...new Set([...document.querySelectorAll(".msg-me, .msg-other")].map((e) => (e.classList.contains("msg-me") ? "me" : e.getAttribute("data-author"))))]);
          p.check("four author kinds shown (me, my Pickle, friend, friend's Pickle)", ["me", "my-agent", "peer", "peer-agent"].every((a) => authors.includes(a)), authors);
          await p.shot("friend-thread");
          // a banner never covers the top bar's controls (iOS: a tap on a banner opens the banner, so the controls stay
          // clear of it instead of letting taps fall through). The friend writes again; with the banner up, 뒤로's 44 pt
          // hit area is outside the banner's rect and is what a tap there reaches, and the tap leaves the friend's thread
          const BANNER = ".banner-anchor .banner-content";
          const bannerUp = () => page.waitForSelector(BANNER, { timeout: 10_000 }).then(() => sleep(500)).then(() => true).catch(() => false);
          const clearOf = (name) =>
            page.evaluate((label) => {
              const btn = [...document.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === label && b.getBoundingClientRect().width > 0);
              const banner = document.querySelector(".banner-anchor .banner");
              if (!btn || !banner) return { found: !!btn, banner: !!banner };
              const r = btn.getBoundingClientRect();
              const cx = r.left + r.width / 2;
              const cy = r.top + r.height / 2;
              const hit = { left: cx - 22, right: cx + 22, top: cy - 22, bottom: cy + 22 }; // the 44 pt target around its centre
              const b = banner.getBoundingClientRect();
              const overlap = !(hit.right <= b.left || hit.left >= b.right || hit.bottom <= b.top || hit.top >= b.bottom);
              const top = document.elementFromPoint(cx, cy);
              // visible: the top bar used to recede under a banner (opacity 0, pointer-events none)
              let opacity = 1;
              for (let n = btn; n && n !== document.body; n = n.parentElement) opacity *= Number(getComputedStyle(n).opacity);
              return { found: true, banner: true, overlap, opacity: Math.round(opacity * 100) / 100, events: getComputedStyle(btn).pointerEvents, reaches: !!top && (top === btn || btn.contains(top)), btn: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)], rect: [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)] };
            }, name);
          await waitNoBanner(page);
          await api("POST", `/api/threads/${ft.id}/messages`, { text: "참, 사진은 내일 보내 줄게요" }, friend.token);
          const dropped = await bannerUp();
          const clear = dropped ? await clearOf("뒤로") : null;
          if (dropped && clear?.found && clear.banner) {
            await page.getByRole("button", { name: "뒤로" }).click({ timeout: 3000 }).catch(() => {});
            const left = await page
              .waitForFunction(() => !/님에게 메시지/.test(document.querySelector("textarea.composer-field")?.getAttribute("placeholder") || ""), null, { timeout: 2500 })
              .then(() => true)
              .catch(() => false);
            p.check("with a friend's banner up, 뒤로 stays clear of it (44 pt hit area outside the banner, the tap reaches it) and leaves the friend's thread", !clear.overlap && clear.reaches && clear.opacity >= 0.99 && clear.events !== "none" && left, { ...clear, left });
          } else p.check("with a friend's banner up, 뒤로 stays clear of it (44 pt hit area outside the banner, the tap reaches it) and leaves the friend's thread", false, { dropped, clear });
          const inMain = () => composer(page).first().getAttribute("placeholder").then((ph) => !/님에게 메시지/.test(ph || "")).catch(() => false);
          if (await inMain()) {
            // back in the main thread: the same holds for 메뉴
            await waitNoBanner(page);
            await api("POST", `/api/threads/${ft.id}/messages`, { text: "그럼 내일 봐요" }, friend.token);
            const dropped2 = await bannerUp();
            const menu = dropped2 ? await clearOf("메뉴") : null;
            p.check("with a banner up, 메뉴 stays clear of it too", dropped2 && !!menu?.found && !menu.overlap && menu.reaches && menu.opacity >= 0.99 && menu.events !== "none", { dropped2, menu });
            // a tap outside a banner dismisses it and still lands (here the composer takes focus). Timed from the tap: the
            // banner starts leaving at once (its content is gone within 250 ms; its own hold would run ~1.4 s more), then
            // it contracts into the island and leaves the DOM when that spring settles (~0.85 s), and no other banner
            // takes its place
            await page.evaluate((sel) => {
              const s = (window.__bout = { down: null, faded: null, removed: null, other: false });
              const body0 = document.querySelector(`${sel} .banner-body`)?.textContent ?? "";
              const start = performance.now();
              addEventListener("pointerdown", () => (s.down ??= performance.now()), { capture: true, once: true });
              const tick = () => {
                const now = performance.now();
                const c = document.querySelector(sel);
                if (s.down !== null) {
                  if (c && (c.querySelector(".banner-body")?.textContent ?? "") !== body0) s.other = true;
                  if (s.faded === null && (!c || Number(getComputedStyle(c).opacity) <= 0.05)) s.faded = Math.round(now - s.down);
                  if (!c) return void (s.removed = Math.round(now - s.down));
                }
                if (now - start < 6000) requestAnimationFrame(tick);
              };
              requestAnimationFrame(tick);
            }, BANNER);
            await composer(page).click();
            const focused = await composer(page).evaluate((e) => document.activeElement === e).catch(() => false);
            await page.waitForFunction(() => window.__bout.removed !== null, null, { timeout: 3000 }).catch(() => {});
            const out = await page.evaluate(() => window.__bout);
            p.check(
              "a tap outside a banner dismisses it at once and still lands (the composer takes focus; the banner's content is gone within 250 ms, the banner within 1.5 s)",
              dropped2 && focused && out.faded !== null && out.faded <= 250 && out.removed !== null && out.removed <= 1500 && !out.other,
              { dropped2, focused, ...out },
            );
            await composer(page).blur().catch(() => {});
            // and a tap on the banner itself still does the banner's action: the friend's thread opens
            await waitNoBanner(page);
            await api("POST", `/api/threads/${ft.id}/messages`, { text: "아, 하나만 더요" }, friend.token);
            const dropped3 = await bannerUp();
            if (dropped3) await page.locator(BANNER).first().click({ timeout: 3000 }).catch(() => {});
            const opened = await page
              .waitForFunction(() => /님에게 메시지/.test(document.querySelector("textarea.composer-field")?.getAttribute("placeholder") || ""), null, { timeout: 3000 })
              .then(() => true)
              .catch(() => false);
            p.check("a tap on the friend's banner opens the friend's thread", dropped3 && opened, { dropped3, opened });
          }
        } else p.check("friend thread found via API", false);
      }

      // back to the default chat (the banner checks above end in the friend's thread). Where a banner can still sit
      // over 뒤로 (webkit once sent the whole main-thread run into the friend thread this way), wait it out, go back,
      // and make sure it took
      // (the composer belongs to the active thread only: a friend thread's reads "… 님에게 메시지")
      const inFriend = () => composer(page).first().getAttribute("placeholder").then((ph) => /님에게 메시지/.test(ph || "")).catch(() => false);
      for (let i = 0; i < 2 && (await inFriend()); i++) {
        await waitNoBanner(page);
        await page.getByRole("button", { name: "뒤로" }).click().catch(() => {});
        await sleep(900);
      }
      if (await inFriend()) p.check("back in the default chat after the friend thread", false);

    }

    // ── 3. welcome briefing ──
    p.step = "welcome";
    await page.waitForSelector(".ccard-briefing", { timeout: 30_000 }).catch(() => {});
    {
      // empty-thread A: the rows are the buttons; no chips repeating them, no icon plates
      const brief = page.locator(".ccard-briefing").last();
      const rows = await brief.locator(".brief-row").count();
      const buttons = await brief.locator("button.brief-row").count();
      const extra = await brief.locator(".quick-replies, .chip, .brief-icon").count();
      p.check("welcome briefing: the rows are the buttons (no chips, no plates)", rows >= 3 && buttons >= 3 && extra === 0, { rows, buttons, extra });
    }
    await p.shot("welcome-briefing");

    // ── 4. weather: tool chip → weather card → text ──
    if (want("weather")) {
      p.step = "weather";
      // the turn's opacity on every frame, from the send until the final message has replaced the live draft: the
      // final row must not enter a second time (the draft already did; it used to blink from 0 for ~150 ms)
      await page.evaluate(() => {
        const s = (window.__swap = { frames: [], on: true });
        const tick = () => {
          if (!s.on) return;
          const rows = document.querySelectorAll(".thread-content .msg-row.msg-asst");
          const row = rows[rows.length - 1];
          if (row) s.frames.push({ live: row.classList.contains("msg-live"), wait: row.hasAttribute("data-placeholder"), op: Number(getComputedStyle(row).opacity) });
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
      const ft = await send(p, "오늘 서울 날씨 알려 줘", { measure: true });
      p.metrics.firstTokenPlaceholderMs = Math.round(ft);
      p.check("first-token placeholder ≤ 150 ms after send", ft > 0 && ft <= 150, `${Math.round(ft)} ms`);
      // the turn's line shows up in the live turn (MOTION-SPEC §8.5): the real tool's words while it runs — a fast
      // turn (the QA model answers in ~1 s, a cached forecast) can deliver "running" and "done" in one render, so the
      // line may already read its summary; the running words are recorded when seen
      const chip = await page.waitForSelector(".msg-live .tools-line", { timeout: LLM_MS }).then(() => true).catch(() => false);
      const chipSeen = chip ? await page.locator(".msg-live .tools-line").first().evaluate((l) => ({ state: l.getAttribute("data-state"), words: (l.querySelector(".tools-line-text > :not([aria-hidden])")?.textContent ?? "").replace(/\u00a0/g, " ").trim() })).catch(() => null) : null;
      p.check("live tool status in the turn's line, with the real tool label", chip && !!chipSeen?.words, chipSeen);
      if (chip) await p.shot("weather-tool-chip");
      await waitIdle(page, LLM_MS).catch(() => {});
      await sleep(400); // a few frames past the swap, longer than the old entrance
      const swap = await page.evaluate(() => {
        const s = window.__swap;
        s.on = false;
        const f = s.frames;
        let last = -1; // the last frame that showed the draft with content
        for (let i = 0; i < f.length; i++) if (f[i].live && !f[i].wait) last = i;
        const after = last >= 0 ? f.slice(last + 1, last + 1 + 40) : [];
        return { frames: f.length, draftFrames: f.filter((x) => x.live && !x.wait).length, after: after.length, finalLive: after.some((x) => x.live), minAfter: after.length ? Math.min(...after.map((x) => x.op)) : null, minDraft: Math.min(...f.filter((x) => x.live).map((x) => x.op)) };
      });
      p.metrics.draftSwap = swap;
      p.check("the reply does not blink when it finishes: the final row keeps the draft's full opacity (no second entrance)", swap.draftFrames > 0 && swap.after >= 10 && !swap.finalLive && swap.minAfter >= 0.99, swap);
      // the weather card is a record: it folds behind the line (toolfold), the answer stays in view
      const wxTurn = page.locator(".thread-content > .msg-asst").last();
      const wxLine = wxTurn.locator(".tools-line");
      const folded = ((await wxLine.locator(".tools-line-text > :not([aria-hidden])").first().textContent().catch(() => "")) || "").replace(/\u00a0/g, " ").trim();
      p.check("the tool status folds into the line '자료 1개 보기 · 기상청', the weather card behind it", /^자료 1개 보기 · 기상청/.test(folded) && (await wxTurn.locator(".ccard-weather").count()) === 0, folded);
      await p.shot("weather-card");
      await p.interact("expand-steps", () => tapIn(wxLine));
      await sleep(900);
      p.check("weather card rendered (opened from the line)", (await wxTurn.locator(".tools-panel .ccard-weather").count()) > 0);
      p.check("expanded steps show summary / source", (await wxTurn.locator(".tools-panel .tools-steps .tools-step-meta").count()) > 0);
      await p.shot("weather-steps");
      await tapIn(wxLine);
    }

    // ── 5. parallel tools ──
    if (want("parallel")) {
      p.step = "parallel";
      await send(p, "서울이랑 부산 날씨를 동시에 확인해서 비교해 줘");
      let maxLive = 0;
      const until = Date.now() + 60_000;
      while (Date.now() < until) {
        // the line names the newest running tool and "외 N개" for the others in flight
        const n = await page.evaluate(() => {
          const l = document.querySelector('.msg-live .tools-line[data-state="running"]');
          const more = l?.querySelector(".tools-line-text > :not([aria-hidden]) .tools-line-more")?.textContent ?? "";
          return l ? 1 + (Number(more.replace(/\D/g, "")) || 0) : 0;
        });
        maxLive = Math.max(maxLive, n);
        if (!(await streaming(page).count()) && !(await page.locator(".msg-live").count())) break;
        await sleep(150);
      }
      await waitIdle(page).catch(() => {});
      const parTurn = page.locator(".thread-content > .msg-asst").last();
      if (await parTurn.locator(".tools-line").count()) {
        await tapIn(parTurn.locator(".tools-line"));
        await sleep(900);
      }
      const steps = await parTurn.locator(".tools-panel .tools-step").count();
      const pill = ((await parTurn.locator(".tools-line").textContent().catch(() => "")) || "").replace(/\u00a0/g, " ").trim();
      if (maxLive >= 2 || steps >= 2) p.check("parallel tools: ≥ 2 running together or 2+ steps behind the line", true, { maxLive, steps, pill });
      else p.skip("parallel tools", `the agent made a single tool call this time (${pill})`);
      await p.shot("parallel-tools");
    }

    // ── 6. schedule: low risk → done at once + undo ──
    if (want("schedule")) {
      p.step = "schedule";
      const ok = await ask(p, ["매일 아침 8시에 오늘 날씨를 알려 주는 예약을 만들어 줘", "매일 오전 8시 날씨 브리핑 예약해 줘"], ".ccard-sched", 60_000);
      p.check("schedule card appears", ok);
      if (ok) {
        const undo = await page.waitForSelector(".banner-action", { timeout: 8000 }).then(() => true).catch(() => false);
        p.check("low risk: done at once with an undo banner", undo);
        await p.shot("schedule-undo-banner");
        if (undo) {
          await p.interact("undo", () => page.locator(".banner-action").click());
          await sleep(200);
          const removed = await page.waitForSelector(".ccard-sched.is-removed", { timeout: 10_000 }).then(() => true).catch(() => false);
          p.check("undo deletes the schedule on the server and the card says so", removed);
        }
        await waitIdle(page).catch(() => {});
        await p.shot("schedule-undone");
      }
    }

    // ── 7. phone call: high risk approval signed with the device key ──
    if (want("approval")) {
      p.step = "approval";
      await waitAgentIdle(page);
      const ok = await ask(
        p,
        ["010-2345-6789로 전화해서 내일 저녁 7시에 두 명 예약 되는지 물어봐 줘", "010-2345-6789에 전화 걸어서 예약 가능한지 확인해 줘. 승인할게"],
        ".ccard-approval[data-approval-pending]",
        60_000,
      );
      p.check("approval card for the phone call", ok);
      if (ok) {
        await waitIdle(page).catch(() => {});
        await page.locator(".ccard-approval[data-approval-pending]").last().evaluate((el) => el.scrollIntoView({ block: "center", behavior: "instant" }));
        await sleep(400);
        await p.shot("approval-card");
        // the island says 승인이 필요해요: tapping it brings the waiting card back from wherever the list is
        await page.locator(".screen-scroll").last().evaluate((el) => (el.scrollTop = 0));
        await sleep(500);
        await p.interact("island-to-approval", async () => {
          const box = await page.locator(".island").boundingBox();
          await page.mouse.click(box.x + box.width / 2, box.y + 18);
        });
        await sleep(1100);
        const inView = await page
          .locator(".ccard-approval[data-approval-pending]")
          .last()
          .evaluate((el) => {
            const r = el.getBoundingClientRect();
            return r.top >= 0 && r.bottom <= innerHeight && r.top < innerHeight * 0.75;
          });
        p.check("island tap scrolls to the pending approval", inView);
        // the composer still has focus from sending: the first tap also blurs it (the tab bar comes back after the tap)
        const btn = page.locator(".ccard-approval[data-approval-pending]").last().locator(".appr-actions button").first();
        const appId = await page.locator(".ccard-approval[data-approval-pending]").last().getAttribute("data-approval-id");
        await p.interact("confirm-1", () => tapIn(btn));
        await sleep(150);
        p.check("first tap asks once more in the same place", /한 번 더/.test((await btn.textContent()) || ""));
        await sleep(450);
        await p.interact("confirm-2", () => btn.click());
        const approved = await page.waitForSelector(`.ccard-approval[data-approval-id="${appId}"] .appr-receipt[data-status=approved]`, { timeout: 30_000 }).then(() => true).catch(() => false);
        p.check("approved after the server accepted the signed decision", approved);
        const verified = await page.waitForSelector(`.ccard-approval[data-approval-id="${appId}"] .appr-verified`, { timeout: 20_000 }).then(() => true).catch(() => false);
        p.check("이 기기의 키로 확인했어요 (access log deviceVerified)", verified);
        await waitIdle(page).catch(() => {});
        const said = await lastAssistantText(page);
        p.check("agent says the call could not be placed (Twilio missing)", /전화|통화/.test(said) && /(못|않|없|설정|연결|준비|불가|어려)/.test(said), said.slice(0, 120));
        await p.shot("approval-approved");
      }
    }

    // ── 8. credential request: sealed on the device ──
    if (want("credential")) {
      p.step = "credential";
      await waitAgentIdle(page);
      // the agent often checks msg_connections first and just says "연결해 주세요"; asking it to request the login
      // makes it call the messenger tool, whose credential gate produces the card
      const ok = await ask(
        p,
        [
          "카카오톡 대화방 목록 불러와 줘. 로그인 정보가 필요하면 저장 카드로 물어봐 줘, 지금 바로 입력할게",
          // the agent usually checks msg_connections and answers "프로필 > 연결에서 연결해 주세요"; naming the tool makes
          // it call msg_list_chats, whose credential gate is what produces the card
          "연결 확인은 건너뛰고 msg_list_chats 도구로 kakaotalk 대화방 목록을 바로 조회해 줘",
        ],
        ".ccard-cred:not(.is-done) .cred-form",
        60_000,
      );
      if (ok) p.check("credential_request card with an inline secure form", ok);
      else p.skip("credential_request card", `the agent answered without calling a messenger tool: ${(await lastAssistantText(page)).slice(0, 80)}`);
      if (ok) {
        await waitIdle(page).catch(() => {});
        const card = page.locator(".ccard-cred:not(.is-done)").last();
        await card.evaluate((el) => el.scrollIntoView({ block: "center", behavior: "instant" }));
        // chat B: the promise once, under the secret; no footnote, no reason paragraph, no lock
        const hint = (await card.locator(".cred-group .tf-hint").allTextContents()).join(" | ").replace(/\u00a0/g, " "); // copy()'s nbsp ties ("이\u00a0기기에서")
        p.check("the promise is said once, under the password (no footnote)", /이 기기에서 암호화돼요/.test(hint) && (await card.locator(".cred-group .tf-hint").count()) === 1 && (await card.locator(".cred-foot, .cred-reason").count()) === 0, hint);
        const inputs = card.locator(".cred-form input");
        const n = await inputs.count();
        for (let i = 0; i < n; i++) {
          const type = await inputs.nth(i).getAttribute("type");
          await inputs.nth(i).fill(type === "password" ? "qa-secret-pass-1" : `qa_user_${rand()}`);
        }
        await sleep(200);
        await p.shot("credential-form");
        // "저장하고 이어서 하기" sends the continue reply on its own after the 201. The QA account's login is made up, so
        // that reply is answered here (201 delivered, no turn): the agent never tries the bogus login on a real service
        const continued = [];
        const onContinue = async (r) => {
          const req = r.request();
          const text = req.method() === "POST" ? (JSON.parse(req.postData() || "{}").text ?? "") : "";
          if (!/로그인 정보를 저장했어요/.test(text)) return r.fallback();
          continued.push(text);
          const tid = decodeURIComponent(new URL(req.url()).pathname.split("/")[3]);
          return r.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ delivered: true, userMessage: { id: `qa-cont-${rand()}`, threadId: tid, role: "user", text, cards: [], tools: [], attachments: [], createdAt: Date.now() } }) });
        };
        await page.route(/\/api\/threads\/[^/]+\/messages(\?.*)?$/, onContinue);
        await p.interact("seal-save", () => tapIn(card.getByRole("button", { name: /저장/ })));
        const saved = await page.waitForSelector(".cred-pill[data-status=saved]", { timeout: 20_000 }).then((h) => h.textContent()).catch(() => "");
        p.check("saved (sealed for the enclave): 저장됨 · 7일 pill", /저장됨/.test(saved || ""), saved);
        await until(() => continued.length > 0, 5000);
        p.check("저장하고 이어서 하기: the continue reply goes out with the save (one tap)", continued.length === 1, continued);
        await page.unroute(/\/api\/threads\/[^/]+\/messages(\?.*)?$/, onContinue);
        await sleep(500);
        await p.shot("credential-saved");
      }
    }

    // ── 9. steer while streaming (202) ──
    if (want("steer")) {
      p.step = "steer";
      // The check is about the UI after a 202. With the fast model the first turn can end before the second send
      // lands; the server then answers 201 (a new turn), which says nothing about the steer UI. Read the steer
      // POST's status: on 201 it was that race, so try once more with a fresh turn; a 202 must show "이어서".
      let running = false;
      let steered = false;
      const steerTries = [];
      for (let attempt = 0; attempt < 2 && !steered; attempt++) {
        if (attempt) {
          await waitIdle(page, 120_000).catch(() => {});
          await waitAgentIdle(page);
        }
        await send(p, "서울 성수동 카페 다섯 곳을 찾아서 특징을 정리해 줘");
        running = await streaming(page).waitFor({ timeout: 10_000 }).then(() => true).catch(() => false);
        if (!running) break;
        await sleep(900);
        const steerResp = page
          .waitForResponse((r) => r.request().method() === "POST" && /\/api\/threads\/[^/]+\/messages(\?.*)?$/.test(r.url()) && (r.request().postData() || "").includes("조용한 곳 위주로"), { timeout: 10_000 })
          .catch(() => null);
        await send(p, "조용한 곳 위주로 골라 줘");
        const status = (await steerResp)?.status() ?? 0;
        steerTries.push(status);
        if (status !== 202) continue;
        steered = await page.waitForSelector(".msg-receipt >> text=이어서", { timeout: 8000 }).then(() => true).catch(() => false);
        break;
      }
      p.metrics.steerTries = steerTries;
      if (running) {
        p.check("202 steered: bubble in, the running turn keeps streaming", steered, { statuses: steerTries });
        await p.shot("steer");
      } else p.check("turn was running for the steer", false);
      await waitIdle(page, 120_000).catch(() => {});
      const follow = await page.waitForSelector("[data-follow]", { timeout: 2500 }).then(() => true).catch(() => false);
      p.metrics.steerFollowUpRow = follow;
      if (follow) await p.shot("steer-follow-up");
      await waitAgentIdle(page);
      await p.shot("steer-done");
    }

    // ── 10. stop ──
    if (want("stop")) {
      p.step = "stop";
      await waitAgentIdle(page);
      await send(p, "한국의 사계절 풍경을 아주 길고 자세하게 설명해 줘");
      const running = await streaming(page).waitFor({ timeout: 10_000 }).then(() => true).catch(() => false);
      if (running) {
        await sleep(1500);
        await p.interact("stop", () => streaming(page).click());
        const stopped = await page.waitForFunction(() => !document.querySelector(".send-btn[data-mode=stop]"), null, { timeout: 10_000 }).then(() => true).catch(() => false);
        p.check("stop ends the turn (send button morphs back)", stopped);
        await sleep(600);
        p.check("a stop is not an error (no error line, no retry banner)", !(await page.locator(".thread-error").count()) && !(await page.locator(".island[data-kind=error]").count()));
        await p.shot("stopped");
      } else p.check("turn was running for the stop", false);
    }

    // ── 10b. composer guards: 4,000 characters, an image attachment ──
    if (want("composer")) {
      p.step = "composer";
      await waitAgentIdle(page);
      const f = composer(page);
      await f.click();
      await f.fill("가".repeat(4001));
      await sleep(300);
      p.check("4,000-character guard: counter over + send disabled", (await page.locator(".composer-count[data-over]").count()) > 0 && (await page.locator(".send-btn[data-mode=send]").isDisabled()));
      await page.keyboard.press("Enter");
      await sleep(300);
      p.check("Enter over the limit explains instead of sending", /4,000자/.test((await page.locator(".composer-err").textContent().catch(() => "")) || ""));
      await p.shot("composer-limit");
      await f.fill("");
      const png = await page.evaluate(() => {
        const c = document.createElement("canvas");
        c.width = c.height = 96;
        const g = c.getContext("2d");
        g.fillStyle = "#2f7d4f";
        g.fillRect(0, 0, 96, 96);
        g.fillStyle = "#f5c518";
        g.beginPath();
        g.arc(48, 48, 28, 0, Math.PI * 2);
        g.fill();
        return c.toDataURL("image/png").split(",")[1];
      });
      await page.locator(".composer-row input[type=file]").setInputFiles({ name: "qa-circle.png", mimeType: "image/png", buffer: Buffer.from(png, "base64") });
      const ready = await page.waitForSelector(".composer-file[data-state=ready]", { timeout: 15_000 }).then(() => true).catch(() => false);
      p.check("image attachment uploads (thumbnail → ready)", ready);
      await sleep(500);
      await p.shot("composer-attachment");
      if (ready) {
        await send(p, "이 그림에 무슨 색이 있는지 한 줄로 알려 줘");
        const inBubble = await page.waitForSelector(".msg-me .bubble-img", { timeout: 10_000 }).then(() => true).catch(() => false);
        p.check("sent bubble carries the image", inBubble);
        await waitIdle(page).catch(() => {});
        await sleep(400);
        await p.shot("composer-attachment-sent");
      }
    }

    // ── 10c. offline send → failed bubble → 다시 보내기 ──
    if (want("failed")) {
      p.step = "failed";
      await waitAgentIdle(page);
      await context.setOffline(true);
      await sleep(300);
      await send(p, "연결이 끊겼을 때 보낸 메시지");
      const failed = await page.waitForSelector(".msg-me[data-failed] .msg-failed", { timeout: 15_000 }).then(() => true).catch(() => false);
      p.check("offline send keeps the bubble as failed with 다시 보내기", failed);
      await p.shot("failed-message");
      await context.setOffline(false);
      await sleep(1200);
      if (failed) {
        await p.interact("retry", () => tapIn(page.locator(".msg-me[data-failed]").last().getByRole("button", { name: /다시 보내기/ })));
        const resent = await page.waitForFunction(() => !document.querySelector(".msg-me[data-failed]"), null, { timeout: 15_000 }).then(() => true).catch(() => false);
        p.check("다시 보내기 sends it again", resent);
        await waitIdle(page).catch(() => {});
        await sleep(400);
        await p.shot("failed-retried");
      }
    }

    // ── 10d. 409 busy: a turn runs in the default chat, an @mention in the friend thread is refused, text kept ──
    if (want("busy") && friendThreadId) {
      p.step = "busy";
      await waitAgentIdle(page);
      await waitNoBanner(page); // the friend's last banners sit over the top bar's 메뉴
      // the friend thread first, then the default chat's turn starts through the API and the @mention goes out at once:
      // a turn started from the UI could end (a fast model answers in ~1.5 s) while the drawer was still on its way
      await page.getByRole("button", { name: "메뉴" }).click();
      await page.waitForSelector(".dw");
      await sleep(500);
      await page.locator(".dw-row").filter({ hasText: "진우" }).first().click();
      await page.waitForSelector(".thread-intro[data-kind=friend]", { timeout: 10_000 }).catch(() => {});
      await sleep(500);
      const sess = await page.evaluate(async () => {
        const token = localStorage.getItem("pickle.token");
        const r = await fetch("/api/session", { headers: { authorization: `Bearer ${token}` } });
        return r.ok ? { token, ...(await r.json()) } : null;
      });
      const mainId = sess?.mainThreadId ?? sess?.session?.mainThreadId ?? null;
      // the response headers arrive once the turn holds the agent (threads.ts decides busy/steer before it streams)
      const turn = mainId
        ? await fetch(`${API}/api/threads/${mainId}/messages`, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${sess.token}` },
            body: JSON.stringify({ text: "부산 2박 3일 여행 일정을 시간대별로 자세하게 짜 줘" }),
          }).catch(() => null)
        : null;
      const running = !!turn && turn.status === 200 && (turn.headers.get("content-type") || "").includes("text/event-stream");
      if (running) {
        const text = "@깽이 지금 바빠?";
        await send(p, text);
        const banner = await page
          .waitForFunction(() => [...document.querySelectorAll(".banner-title, .banner-body")].map((e) => e.textContent).find((t) => /다른 일/.test(t || "")) || false, null, { timeout: 8000 })
          .then((h) => h.jsonValue())
          .catch(() => "");
        p.check("409 busy: the server's words in a banner", /다른 일/.test(banner || ""), banner);
        p.check("409 busy: the text stays in the composer", (await composer(page).inputValue()) === text);
        await p.shot("busy-409");
        await composer(page).fill("");
        await turn.text().catch(() => {}); // let the default chat's turn finish
        await page.getByRole("button", { name: "뒤로" }).click().catch(() => {});
        await sleep(600);
      } else p.check("turn was running for the busy check", false, turn ? `${turn.status} ${turn.headers.get("content-type")}` : "no main thread");
      await waitAgentIdle(page);
    }

    // ── 10e. history: 60 friend messages → load older at the top, jump to latest ──
    if (want("older") && friendThreadId) {
      p.step = "older";
      for (let i = 1; i <= 60; i++) await api("POST", `/api/threads/${friendThreadId}/messages`, { text: `기록 메시지 ${i}` }, friend.token);
      await page.reload();
      await page.waitForSelector("textarea.composer-field", { timeout: 20_000 });
      await sleep(1200);
      await page.getByRole("button", { name: "메뉴" }).click();
      await page.waitForSelector(".dw");
      await sleep(600);
      await page.locator(".dw-row").filter({ hasText: "진우" }).first().click();
      await page.waitForSelector(".msg-other[data-author=peer]", { timeout: 15_000 });
      await sleep(900);
      const before = await page.locator(".thread-content .msg-row").count();
      const sc = page.locator(".screen-scroll").last();
      for (let i = 0; i < 6; i++) {
        await sc.evaluate((el) => el.scrollBy({ top: -2400, behavior: "instant" }));
        await sleep(450);
      }
      await page.waitForFunction((n) => document.querySelectorAll(".thread-content .msg-row").length > n, before, { timeout: 10_000 }).catch(() => {});
      const after = await page.locator(".thread-content .msg-row").count();
      p.check("scrolling to the top loads older messages", after > before, `${before} → ${after}`);
      // chat B: reading above with nothing new shows no capsule; it rises only when something arrives below
      await sleep(600);
      p.check("reading far above with nothing new: no capsule", (await page.locator(".jump-latest").count()) === 0);
      await p.shot("older-loaded");
      await api("POST", `/api/threads/${friendThreadId}/messages`, { text: "방금 온 메시지" }, friend.token);
      const jump = await page.waitForSelector(".jump-latest", { timeout: 8000 }).then(() => true).catch(() => false);
      const look = jump ? await page.locator(".jump-latest").evaluate((e) => ({ text: e.textContent.trim(), bg: getComputedStyle(e).backgroundColor, blur: getComputedStyle(e).backdropFilter || getComputedStyle(e).webkitBackdropFilter || "none", glass: !!e.closest(".glass") || e.classList.contains("glass") })) : null;
      p.check("something new below: a 새 메시지 capsule on opaque paper (not glass)", !!look && look.text === "새 메시지" && !/rgba\(\d+, \d+, \d+, 0\)|transparent/.test(look.bg) && (look.blur === "none" || !look.blur) && !look.glass, look);
      if (jump) await p.shot("older-new-below");
      if (jump) {
        await p.interact("jump-latest", () => page.locator(".jump-latest").click());
        await sleep(1200);
        const atEnd = await sc.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight < 90);
        p.check("capsule takes you to the latest message", atEnd);
        await p.shot("older-jumped");
      }
      await page.getByRole("button", { name: "뒤로" }).click().catch(() => {});
      await sleep(600);
    }

    // ── 10f. a new task thread: empty state with three suggestions ──
    if (want("empty")) {
      p.step = "empty";
      const made = await page.evaluate(async () => {
        const token = localStorage.getItem("pickle.token");
        const r = await fetch("/api/threads", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ title: "QA 빈 대화" }) });
        return r.ok;
      });
      if (made) {
        await page.getByRole("button", { name: "메뉴" }).click();
        await page.waitForSelector(".dw");
        await sleep(700);
        await page.locator(".dw-row").filter({ hasText: "QA 빈 대화" }).first().click();
        await page.waitForSelector(".thread-empty", { timeout: 10_000 }).catch(() => {});
        await sleep(700);
        // empty-thread A: the agent's still face, the same sentence, three suggestions as one grouped list
        const face = await page.locator(".thread-empty .thread-empty-face").count();
        const rows = await page.locator(".thread-empty-list .list-row").count();
        const old = await page.locator(".thread-empty .chip, .thread-empty-glyph").count();
        p.check("empty thread: the agent's face and three suggestions in one list (no chips, no plate)", face === 1 && rows === 3 && old === 0, { face, rows, old });
        await p.shot("empty-thread");
        // a tap puts the words in the composer and focuses it; nothing is sent
        const sentBefore = await page.locator(".msg-me").count();
        const first = ((await page.locator(".thread-empty-list .list-row").first().textContent()) || "").trim();
        await p.interact("empty-suggestion", () => page.locator(".thread-empty-list .list-row").first().click());
        await sleep(600);
        const filled = await composer(page).evaluate((el) => ({ value: el.value, focused: document.activeElement === el }));
        p.check("empty thread: a suggestion fills the composer and focuses it (nothing sent)", filled.value === first && filled.focused && (await page.locator(".msg-me").count()) === sentBefore, { ...filled, first });
        await p.shot("empty-thread-filled");
        await composer(page).fill("");
        await composer(page).blur();
        await page.getByRole("button", { name: "뒤로" }).click().catch(() => {});
        await sleep(600);
      } else p.check("task thread created", false);
    }

    // ── 11. explore call-demo thread (opens in the thread screen with its greeting) ──
    let callThread = null;
    if (want("drawer")) {
      p.step = "call-demo";
      callThread = await page.evaluate(async () => {
        const token = localStorage.getItem("pickle.token");
        const r = await fetch("/api/explore/call-demo/delegate", { method: "POST", headers: { authorization: `Bearer ${token}` } });
        return r.ok ? r.json() : null;
      });
      p.check("call-demo delegated", !!callThread);
    }

    // ── 12. drawer + 초성 search ──
    if (want("drawer")) {
      p.step = "drawer";
      await p.interact("open-drawer", () => page.getByRole("button", { name: "메뉴" }).click());
      await page.waitForSelector(".dw");
      await sleep(900);
      p.check("drawer lists 맡긴 일", (await page.locator(".dw-row").count()) > 0, await page.locator(".dw-row").count());
      await p.shot("drawer");
      await p.interact("search", () => page.locator(".dw-search").click());
      await sleep(400);
      await page.keyboard.type("ㅈㅇ");
      await sleep(500);
      const hits = await page.locator(".dw-spot [role=option]").count();
      p.check("초성 search (ㅈㅇ → 진우 님 thread)", hits > 0, hits);
      await p.shot("drawer-search");
      await page.locator(".dw-cancel").click();
      await sleep(300);
      const callRow = page.locator(".dw-row").filter({ has: page.locator(".dw-row-glyph") }).filter({ hasText: /통화|전화/ });
      if (await callRow.count()) {
        await p.interact("open-call-thread", () => callRow.first().click());
        await page.waitForSelector(".thread-intro", { timeout: 10_000 }).catch(() => {});
        await page.waitForSelector(".msg-asst .asst-text", { timeout: 15_000 }).catch(() => {});
        await sleep(800);
        p.check("call-demo thread opens with its greeting", (await page.locator(".msg-asst .asst-text").count()) > 0);
        await p.shot("call-demo-thread");
        await page.getByRole("button", { name: "뒤로" }).click();
        await sleep(600);
      } else {
        p.check("call-demo thread listed in the drawer", false);
        await page.keyboard.press("Escape");
        await sleep(500);
      }
    }

    // ── 13. call: circle → island → card; the mic prompt left unanswered → typed fallback ──
    if (want("call")) {
      p.step = "call";
      await waitAgentIdle(page);
      await composer(page).click();
      await page.keyboard.press("Escape").catch(() => {});
      await p.interact("open-call", () => page.getByRole("button", { name: "통화하기" }).click());
      const open = await page.waitForSelector(".call-card", { timeout: 8000 }).then(() => true).catch(() => false);
      p.check("call card opens (circle → island → card)", open);
      const t0 = Date.now();
      const connected = await page
        .waitForFunction(() => {
          const ph = document.querySelector(".call-phase")?.textContent || "";
          return ph && !ph.includes("연결 중");
        }, null, { timeout: 8000 })
        .then(() => true)
        .catch(() => false);
      p.check("connects without waiting on an unanswered mic prompt", connected, `${Date.now() - t0} ms`);
      await sleep(1300);
      await p.shot("call-card");
      const typeIn = page.locator(".call-type-input");
      const canType = await typeIn.waitFor({ timeout: 4000 }).then(() => true).catch(() => false);
      p.check("typed fallback offered while the mic is not available", canType);
      if (canType) {
        // ── the agent's voice: spoken while the reply streams (/api/tts/stream per piece, one in flight), gap-free ──
        const s0 = tts.stream.reqs.length;
        const n0 = tts.reqs.length;
        await sampleCall(page);
        // when the voice-mode turn's stream ends (the reply has finished streaming)
        let turnEnded = 0;
        const onTurnEnd = (req) => {
          if (req.method() === "POST" && /\/api\/threads\/[^/]+\/messages$/.test(new URL(req.url()).pathname)) turnEnded = Date.now();
        };
        page.on("requestfinished", onTurnEnd);
        await typeIn.fill("안녕! 오늘 기분 어때? 두세 문장으로 답해 줘");
        await page.keyboard.press("Enter");
        await page.waitForFunction(() => [...document.querySelectorAll(".call-line[data-who=agent]")].some((l) => l.textContent.trim().length > 4), null, { timeout: LLM_MS }).catch(() => {});
        p.check("typed line → the agent answers in the transcript", (await page.locator(".call-line[data-who=agent]").count()) > 0);
        const playing = await waitVoice(page, "stream", 12_000);
        p.check("the reply plays from the stream (/api/tts/stream)", playing);
        await sleep(700);
        await p.shot("call-speaking");
        const back = await waitPhase(page, "listening", 40_000);
        const samples = await stopSampling(page);
        p.check("after the reply the call listens again", back);
        const agentText = await page.evaluate(() => {
          const li = [...document.querySelectorAll(".call-line[data-who=agent]")].pop()?.cloneNode(true);
          li?.querySelectorAll(".sr-only").forEach((x) => x.remove());
          return li?.textContent || "";
        });
        page.off("requestfinished", onTurnEnd);
        const sreqs = tts.stream.reqs.slice(s0);
        p.check("stream requests only, each with the bearer token (no sentence requests)", sreqs.length >= 1 && sreqs.every((r) => r.bearer) && tts.reqs.length === n0, { stream: sreqs.length, sentences: tts.reqs.length - n0 });
        p.check("one request in flight: each next piece is asked for once the previous one has arrived", sreqs.slice(1).every((r, i) => r.at >= sreqs[i].done - 5), sreqs.map((r) => [r.at - sreqs[0].at, r.done - sreqs[0].at]));
        p.check("the stream texts together are the whole spoken reply, in order, each piece once, without markdown or URLs", lettersOnly(sreqs.map((r) => r.text).join("")) === lettersOnly(agentText) && !sreqs.some((r) => /https?:|\*\*|`|\]\(/.test(r.text)), sreqs.map((r) => r.text.slice(0, 24)));
        p.metrics.streamPieces = sreqs.length;
        p.metrics.streamFirstBeforeTurnEndMs = turnEnded && sreqs[0] ? turnEnded - sreqs[0].at : null;
        if (sreqs.length > 1) p.check("the voice starts before the reply has finished streaming", !!turnEnded && sreqs[0].at < turnEnded, `${turnEnded - sreqs[0].at} ms before the turn's end`);
        else p.skip("the voice starts before the reply has finished streaming", `the reply was one piece: ${sreqs[0]?.text.slice(0, 30)}`);
        const loud = samples.filter((x) => x.voice === "stream" && x.level > 0.01);
        const peak = Math.max(0, ...loud.map((x) => x.level));
        p.check("the level follows the stream's real output", peak > 0.05, `peak ${peak.toFixed(2)}`);
        const silence = longestSilence(samples.filter((x) => x.phase === "speaking"));
        p.metrics.streamLongestSilenceMs = silence;
        const firstAudio = sreqs[0] && loud[0] ? loud[0].w - sreqs[0].at : -1;
        if (tts.real) {
          // real speech pauses between sentences, so silence is only recorded here
          p.metrics.streamFirstAudioRealMs = firstAudio;
          p.metrics.streamHeadersRealMs = sreqs[0]?.done ? sreqs[0].done - sreqs[0].at : -1;
          p.check("real server: first audio within 2 s of the request", firstAudio > 0 && firstAudio < 2000, `${firstAudio} ms (headers ${p.metrics.streamHeadersRealMs} ms, longest quiet ${silence} ms)`);
        } else {
          p.check("the PCM pieces play back to back (the output never drops out)", silence >= 0 && silence < 250, `${silence} ms`);
          p.metrics.streamFirstAudioMockMs = firstAudio;
          p.check("first audio ≈ server latency + the 150 ms cushion (mocked server: 250 ms)", firstAudio > 0 && firstAudio < 900, `${firstAudio} ms`);
        }

        // ── barge-in: mute cuts the stream off at once, and nothing falls back ──
        p.step = "call-barge-mute";
        await typeIn.fill("제주도 여행 팁을 세 문장으로 알려 줘");
        await page.keyboard.press("Enter");
        const speaking2 = await waitVoice(page, "stream", LLM_MS);
        const audible = speaking2 && (await page.waitForFunction(() => Number(document.querySelector(".island-anchor[data-kind=call] .island-dots")?.style.getPropertyValue("--lvl") || 0) > 0.13, null, { timeout: 5000 }).then(() => true).catch(() => false));
        p.check("the next reply is audible", audible);
        if (audible) {
          const before = tts.count();
          const t0 = Date.now();
          await p.interact("mute-while-speaking", () => page.locator(".call-card").getByRole("button", { name: "음소거", exact: true }).click());
          const cut = await page
            .waitForFunction(() => {
              const c = document.querySelector(".call-card");
              return c?.dataset.phase === "paused" && !c.dataset.voice;
            }, null, { timeout: 2000 })
            .then(() => Date.now() - t0)
            .catch(() => -1);
          await sleep(150);
          const after = await levelNow(page);
          p.check("mute stops the stream at once (playback flushed)", cut >= 0 && cut < 600 && after === 0, `${cut} ms, level after ${after.toFixed(2)}`);
          await sleep(2500);
          p.check("a barge-in is not a failure: nothing falls back to /api/tts", tts.count() === before, { requested: tts.count() - before });
          await p.shot("call-barge-mute");
          await page.locator(".call-card").getByRole("button", { name: "음소거", exact: true }).click();
          await waitPhase(page, "listening", 4000);
        }
        p.step = "call";
        await sleep(400);
        await p.shot("call-talk");
      }
      await watchClose(page);
      await p.interact("minimise-call", () => page.getByRole("button", { name: "통화 화면 접기" }).click());
      await page.waitForSelector(".call-card", { state: "detached", timeout: 8000 }).catch(() => {});
      await checkClose(p, page, "minimise");
      await sleep(500);
      p.check("minimised: the island keeps the call", (await page.locator(".island-anchor[data-kind=call]").count()) > 0);
      await p.shot("call-island");
      // tap the visible pill (the island's layout box is taller than the pill; the top bar sits under its lower half)
      await p.interact("reopen-call", async () => {
        const box = await page.locator(".island").boundingBox();
        await page.mouse.click(box.x + box.width / 2, box.y + 18);
      });
      const reopened = await page.waitForSelector(".call-card", { timeout: 8000 }).then(() => true).catch(() => false);
      p.check("tapping the island brings the card back", reopened);
      await sleep(900);
      await watchClose(page);
      await page.locator(".call-card").getByRole("button", { name: "통화 종료" }).click({ timeout: 8000 });
      await page.waitForSelector(".call-card", { state: "detached", timeout: 8000 }).catch(() => {});
      await checkClose(p, page, "end call");
      await sleep(700);
      p.check("call ended", (await page.locator(".island-anchor[data-kind=call]").count()) === 0);
      await p.shot("call-ended");
    }

    // ── an undo toast still up when a call opens stays under the call card (MOTION-SPEC §8.13: the card is a full-screen
    //    surface and covers it like a sheet). It used to draw over the card's captions, and on desktop a mouse resting
    //    on it held it there for the whole call. Folding the card shows it again while it is within its time, and the
    //    call never resets or pauses its timer. The main thread's history gains a schedule card created "now" (route
    //    mock), so the chat offers its 5 s undo on load; then the call opens: by a tap on 통화하기 (then folded), and
    //    from the keyboard while the mouse rests on the toast ──
    if (want("calltoast")) {
      p.step = "calltoast";
      await waitAgentIdle(page);
      const sess = await page.evaluate(async () => {
        const token = localStorage.getItem("pickle.token");
        const r = await fetch("/api/session", { headers: { authorization: `Bearer ${token}` } });
        return r.ok ? r.json() : null;
      });
      const mainId = sess?.mainThreadId ?? sess?.session?.mainThreadId ?? null;
      if (!mainId) p.check("calltoast: main thread id from the session", false);
      else {
        const re = new RegExp(`/api/threads/${mainId}/messages(\\?.*)?$`);
        let sid = "";
        await page.route(re, async (route) => {
          if (route.request().method() !== "GET" || !sid) return route.continue();
          const res = await route.fetch();
          const list = await res.json().catch(() => []);
          const card = { type: "schedule", scheduleId: sid, title: "아침 브리핑", when: "매일 오전 8:00", enabled: true };
          const msg = { id: `m_${sid}`, threadId: mainId, role: "assistant", text: "매일 오전 8시에 아침 브리핑을 보내 드릴게요.", cards: [card], tools: [], attachments: [], createdAt: Date.now() };
          await route.fulfill({ response: res, json: [...(Array.isArray(list) ? list : []), msg] });
        });
        // what is on top across the toast's rect (a 5 × 3 grid): the toast, or the call card and which part of it
        const overToast = () =>
          page.evaluate(() => {
            const t = document.querySelector(".toast");
            const card = document.querySelector(".call-card");
            if (!t) return { toast: false, card: !!card, over: 0 };
            const r = t.getBoundingClientRect();
            let over = 0;
            const under = new Set();
            for (let i = 1; i <= 5; i++)
              for (let j = 1; j <= 3; j++) {
                const el = document.elementFromPoint(r.left + (r.width * i) / 6, r.top + (r.height * j) / 4);
                if (el?.closest(".toast")) over++;
                else if (el?.closest(".call-card")) under.add([...el.closest("[class^='call-'], [class*=' call-']").classList].find((c) => c.startsWith("call-")) ?? "call-card");
              }
            // the call card's parts that the toast's rect lies across (its captions, the typed line, the controls)
            const parts = [".call-transcript", ".call-type", ".call-controls", ".call-who"].filter((sel) => {
              const b = document.querySelector(sel)?.getBoundingClientRect();
              return !!b && b.height > 0 && b.bottom > r.top && b.top < r.bottom;
            });
            return { toast: true, card: !!card, over, under: [...under], parts, rect: [Math.round(r.top), Math.round(r.bottom)] };
          });
        const endCall = async () => {
          if (!(await page.locator(".call-card").count())) {
            // folded: the island's pill brings the card back (the island's box is taller than the pill)
            const pill = await page.locator(".island").boundingBox();
            if (pill) await page.mouse.click(pill.x + pill.width / 2, pill.y + 18);
            await page.waitForSelector(".call-card", { timeout: 8000 }).catch(() => {});
            await sleep(600);
          }
          await page.locator(".call-card").getByRole("button", { name: "통화 종료" }).click({ timeout: 8000 }).catch(() => {});
          await page.waitForSelector(".call-card", { state: "detached", timeout: 8000 }).catch(() => {});
          await page.waitForFunction(() => !document.querySelector(".island-anchor[data-kind=call]"), null, { timeout: 8000 }).catch(() => {});
          await page.mouse.move(195, 300);
          await page.waitForSelector(".toast", { state: "detached", timeout: 10_000 }).catch(() => {});
        };
        // the toast's life in the page, from its node's insertion to its removal (Playwright sees it only after the
        // reload settles, ~1.3 s late in WebKit, so the timer is never read from the test's side); only while this step
        // turns it on. The app's own document only: init scripts run in every frame, and an html card's sandboxed frame
        // has no storage (reading it there is a page error)
        await page.addInitScript(() => {
          if (window.top !== window || sessionStorage.getItem("qa.toastLife") !== "1") return;
          const life = (window.__toastLife = { in: null, out: null });
          const mo = new MutationObserver(() => {
            const has = !!document.querySelector(".toast");
            if (has && life.in === null) life.in = performance.now();
            else if (!has && life.in !== null) {
              life.out = performance.now();
              mo.disconnect();
            }
          });
          mo.observe(document, { subtree: true, childList: true });
        });
        await page.evaluate(() => sessionStorage.setItem("qa.toastLife", "1"));
        for (const mode of ["tap", "hover"]) {
          sid = `sch_qa_calltoast_${mode}_${rand()}`;
          await reloadSettled(page);
          const up = await page.waitForSelector(".toast", { timeout: 6000 }).then(() => true).catch(() => false);
          await sleep(500); // risen into place
          if (!up) {
            p.check(`calltoast (${mode}): the schedule's undo toast is up`, false);
            continue;
          }
          const call = page.getByRole("button", { name: "통화하기" });
          if (mode === "hover") {
            const b = await page.locator(".toast").boundingBox();
            await page.mouse.move(b.x + 40, b.y + b.height / 2); // on the toast's body, not on 실행 취소
            await call.focus();
            await page.keyboard.press("Enter");
          } else await call.click();
          const open = await page.waitForSelector(".call-card", { timeout: 8000 }).then(() => true).catch(() => false);
          await sleep(900); // the card has grown over the whole device
          const s1 = await overToast();
          if (mode === "tap") await p.shot("call-over-toast");
          if (mode === "tap") {
            p.check("an undo toast still up when a call opens stays under the call card (its captions and controls stay on top)", open && s1.toast && s1.card && s1.over === 0, s1);
            // fold the card while the toast is within its time: it is there again, on top; and it leaves at its own 5 s
            await page.getByRole("button", { name: "통화 화면 접기" }).click({ timeout: 3000 }).catch(() => {});
            await page.waitForSelector(".call-card", { state: "detached", timeout: 3000 }).catch(() => {});
            await sleep(300);
            const sFold = { ...(await overToast()), sinceIn: await page.evaluate(() => Math.round(performance.now() - (window.__toastLife?.in ?? NaN))) };
            await page.waitForSelector(".toast", { state: "detached", timeout: 8000 }).catch(() => {});
            const life = await page.evaluate(() => {
              const l = window.__toastLife;
              return l?.in != null && l.out != null ? Math.round(l.out - l.in) : -1;
            });
            // 5 s, then its exit fade (~120 ms)
            p.check(
              "folding the call shows the toast again while it is within its time, and it still leaves at its own 5 s (the call neither resets nor pauses it)",
              sFold.toast && sFold.over === 15 && sFold.sinceIn < 4500 && life >= 4900 && life <= 5600,
              { fold: sFold, life },
            );
          } else {
            await sleep(5200); // past the toast's own 5 s: a resting mouse may still hold it, but never above the card
            const s6 = await overToast();
            p.check("…also with a mouse resting on the toast as the call opens, and still after the toast's 5 s", open && s1.toast && s1.card && s1.over === 0 && s6.over === 0, { at900ms: s1, at6s: s6 });
          }
          await endCall();
        }
        await page.evaluate(() => sessionStorage.removeItem("qa.toastLife"));
        await page.unroute(re);
      }
    }

    // ── 14. call with a (fake) microphone: the level follows the real input; mute (Chrome: fake capture device) ──
    if (want("call") && isChrome) {
      p.step = "call-mic";
      await context.grantPermissions(["microphone"], { origin: BASE });
      await page.getByRole("button", { name: "통화하기" }).click();
      await page.waitForSelector(".call-card", { timeout: 8000 });
      await page.waitForFunction(() => (document.querySelector(".call-phase")?.textContent || "").includes("듣고"), null, { timeout: 8000 }).catch(() => {});
      const levels = new Set();
      for (let i = 0; i < 12; i++) {
        levels.add(await levelNow(page));
        await sleep(120);
      }
      p.check("mic level drives the bar (real input level)", levels.size > 1, [...levels].slice(0, 4));
      await p.shot("call-mic");
      const mute = page.locator(".call-card").getByRole("button", { name: "음소거", exact: true });
      // the real recogniser now and then hears a word in the fake device's tone and sends it; mute ends listening, not a
      // turn already sent (its answer still plays), so press it while the call is listening
      await waitPhase(page, "listening", LLM_MS);
      await p.interact("mute", () => mute.click());
      await sleep(400);
      p.check("mute: pressed + paused", (await mute.getAttribute("aria-pressed")) === "true" && (await callPhase(page)) === "paused");
      await p.shot("call-muted");
      await page.locator(".call-card").getByRole("button", { name: "통화 종료" }).click();
      await page.waitForSelector(".call-card", { state: "detached", timeout: 8000 }).catch(() => {});
      await sleep(500);
    }

    // ── 15. barge-in by voice (scripted mic + recogniser in both engines): mid-playback, mid-request, and ending ──
    if (want("call")) {
      p.step = "call-barge";
      await waitAgentIdle(page);
      await installScriptedSpeech(page);
      await page.getByRole("button", { name: "통화하기" }).click();
      await page.waitForSelector(".call-card", { timeout: 8000 });
      const ready = await page.waitForFunction(() => !!window.__rec?.cur, null, { timeout: 8000 }).then(() => true).catch(() => false);
      p.check("scripted mic + recogniser: the call is listening", ready);
      if (ready) {
        // mute while words are still being heard: the recogniser would finalise them on stop (Chrome does, and the
        // half-heard word went to the agent as a request after the mute), but after 음소거 nothing more goes to the
        // agent: no voice turn, the call stays paused, and the half-heard line leaves the transcript
        const posts = [];
        const onPost = (r) => r.method() === "POST" && /\/api\/threads\/[^/]+\/messages$/.test(new URL(r.url()).pathname) && posts.push(r.postData() || "");
        page.on("request", onPost);
        await recSay(page, "내일 제주", false);
        await page.evaluate(() => (window.__rec.pending = "내일 제주"));
        const shown = await page.evaluate(() => [...document.querySelectorAll(".call-line[data-who=me]")].some((l) => l.textContent.includes("내일 제주")));
        await p.interact("mute-mid-word", () => page.locator(".call-card").getByRole("button", { name: "음소거", exact: true }).click());
        await sleep(1500);
        const afterMute = await page.evaluate(() => ({
          phase: document.querySelector(".call-card")?.dataset.phase,
          line: [...document.querySelectorAll(".call-line[data-who=me]")].some((l) => l.textContent.includes("내일 제주")),
        }));
        page.off("request", onPost);
        p.check(
          "mute drops words still being heard: nothing goes to the agent, the call stays paused, the half-heard line leaves",
          shown && posts.length === 0 && afterMute.phase === "paused" && !afterMute.line,
          { shown, posts: posts.length, ...afterMute },
        );
        // (a build that sent it: let that turn finish before going on)
        if (posts.length) await waitPhase(page, "paused", LLM_MS);
        await page.locator(".call-card").getByRole("button", { name: "음소거", exact: true }).click();
        await page.waitForFunction(() => !!window.__rec?.cur && document.querySelector(".call-card")?.dataset.phase === "listening", null, { timeout: 8000 }).catch(() => {});
        const s0 = tts.stream.reqs.length;
        await recSay(page, "두세 문장으로 짧게 인사해 줘", true);
        const speaking = await waitVoice(page, "stream", LLM_MS);
        const audible = speaking && (await page.waitForFunction(() => Number(document.querySelector(".island-anchor[data-kind=call] .island-dots")?.style.getPropertyValue("--lvl") || 0) > 0.13, null, { timeout: 5000 }).then(() => true).catch(() => false));
        p.check("a spoken line is answered aloud", audible);
        if (audible) {
          p.check("the recogniser keeps listening while the agent speaks", await page.evaluate(() => !!window.__rec.cur));
          const own = tts.stream.reqs[s0]?.text || "";
          await recSay(page, own.slice(0, 14), false);
          await sleep(400);
          p.check("its own voice coming back (echo) doesn't cut it off", (await callVoice(page)) === "stream", own.slice(0, 14));
          const before = tts.count();
          const t0 = Date.now();
          await recSay(page, "잠깐만요", false);
          const cut = await page
            .waitForFunction(() => {
              const c = document.querySelector(".call-card");
              return c?.dataset.phase === "listening" && !c.dataset.voice;
            }, null, { timeout: 2000 })
            .then(() => Date.now() - t0)
            .catch(() => -1);
          await sleep(150);
          const after = await levelNow(page);
          p.check("the person talking cuts the stream off at once (barge-in)", cut >= 0 && cut < 600 && after === 0, `${cut} ms, level after ${after.toFixed(2)}`);
          await p.shot("call-barge-voice");
          await sleep(2500);
          p.check("nothing is requested after the barge-in", tts.count() === before, { requested: tts.count() - before });

          // cut in while the stream request is still being generated: the fetch is aborted
          tts.stream.delay = 4000;
          const s1 = tts.stream.reqs.length;
          const f1 = tts.stream.failed;
          await recSay(page, "잠깐만요, 두 문장으로 다시 말해 줘", true);
          const inFlight = await page.waitForFunction(() => document.querySelector(".call-card")?.dataset.voice === "stream", null, { timeout: LLM_MS }).then(() => true).catch(() => false);
          await until(() => tts.stream.reqs.length > s1, 5000);
          await sleep(300);
          const before2 = tts.count();
          await recSay(page, "아니 그만", false);
          await sleep(600);
          const abortedNow = tts.stream.failed > f1 || !!tts.stream.reqs[s1]?.dropped;
          if (tts.real && !abortedNow) p.skip("stream request aborted mid-generation", "the real stream had already finished arriving");
          else p.check("barge-in during generation aborts the stream request (AbortController)", inFlight && tts.stream.reqs.length > s1 && abortedNow, { aborted: tts.stream.failed - f1 });
          await sleep(3600);
          p.check("…and nothing falls back after it", tts.count() === before2, { requested: tts.count() - before2 });
          tts.stream.delay = 250;

          // the interruption is the person's turn; then end the call mid-reply
          await recSay(page, "아니 그만, 한 문장으로 답해 줘", true);
          const again = await waitVoice(page, "stream", LLM_MS);
          p.check("the interrupting line is answered", again);
          if (again) {
            await sleep(450);
            const n = tts.count();
            await p.interact("end-while-speaking", () => page.locator(".call-card").getByRole("button", { name: "통화 종료" }).click());
            await page.waitForSelector(".call-card", { state: "detached", timeout: 8000 }).catch(() => {});
            await sleep(2500);
            p.check("ending the call mid-reply stops the voice and asks for nothing more", tts.count() === n, { requested: tts.count() - n });
            p.check("the island lets the call go", (await page.locator(".island-anchor[data-kind=call]").count()) === 0);
          }
        }
      }
      if (await page.locator(".call-card").count()) {
        await page.locator(".call-card").getByRole("button", { name: "통화 종료" }).click();
        await page.waitForSelector(".call-card", { state: "detached", timeout: 8000 }).catch(() => {});
      }
      tts.stream.delay = 250;
      await sleep(500);
    }

    // ── 16. fallbacks: stream fails before any audio → /api/tts sentences; both 503 → Web Speech, remembered ──
    if (want("call") && tts.real) p.skip("voice fallbacks", "QA_TTS_REAL: the fallbacks need the mocked routes");
    if (want("call") && !tts.real) {
      p.step = "call-tts-fallback";
      await waitAgentIdle(page);
      await installSpeechSpy(page);
      await page.getByRole("button", { name: "통화하기" }).click();
      await page.waitForSelector(".call-card", { timeout: 8000 });
      const ready = await page.waitForFunction(() => !!window.__rec?.cur, null, { timeout: 8000 }).then(() => true).catch(() => false);
      if (!ready) {
        p.check("scripted recogniser ready for the fallback call", false, await page.evaluate(() => ({ phase: document.querySelector(".call-card")?.dataset.phase, lines: [...document.querySelectorAll(".call-line")].map((l) => l.textContent).slice(-3), err: document.querySelector(".call-error")?.textContent })));
        await p.shot("call-fallback-not-ready");
      } else {
        // a) the stream answers 200 but no audio comes → the sentence pipeline takes the reply
        tts.stream.mode = "empty";
        let s0 = tts.stream.reqs.length;
        let n0 = tts.reqs.length;
        await recSay(page, "한 문장으로 짧게 인사해 줘", true);
        const viaEmpty = await waitVoice(page, "sentences", LLM_MS);
        p.check("a stream that ends before any audio hands the reply to /api/tts", viaEmpty && tts.stream.reqs.length - s0 === 1 && tts.reqs.length > n0, { stream: tts.stream.reqs.length - s0, sentences: tts.reqs.length - n0 });
        await waitPhase(page, "listening", 40_000);

        // b) stream 503 → /api/tts sentences: in order, pipelined, back to back
        p.step = "call-tts-503";
        tts.stream.mode = "503";
        s0 = tts.stream.reqs.length;
        n0 = tts.reqs.length;
        await sampleCall(page);
        await recSay(page, "안녕! 오늘 기분 어때? 두세 문장으로 답해 줘", true);
        const viaSentences = await waitVoice(page, "sentences", LLM_MS);
        p.check("stream 503 → the reply plays sentence by sentence from /api/tts", viaSentences && tts.stream.reqs.length - s0 === 1);
        await sleep(400);
        await p.shot("call-sentences");
        await waitPhase(page, "listening", 40_000);
        const samples = await stopSampling(page);
        const agentText = await page.evaluate(() => {
          const li = [...document.querySelectorAll(".call-line[data-who=agent]")].pop()?.cloneNode(true);
          li?.querySelectorAll(".sr-only").forEach((x) => x.remove());
          return li?.textContent || "";
        });
        const reqs = tts.reqs.slice(n0);
        const flat = lettersOnly(agentText);
        let pos = 0;
        let ordered = reqs.length > 0 && reqs.every((r) => r.bearer);
        for (const r of reqs) {
          const k = flat.indexOf(lettersOnly(r.text), pos);
          if (k < 0) {
            ordered = false;
            break;
          }
          pos = k + lettersOnly(r.text).length;
        }
        p.check("sentences are requested in order and cover the whole reply", ordered && pos === flat.length, reqs.map((r) => r.text.slice(0, 24)));
        const peak = Math.max(0, ...samples.filter((x) => x.voice === "sentences").map((x) => x.level));
        p.check("the level follows the sentences' real output", peak > 0.05, `peak ${peak.toFixed(2)}`);
        if (reqs.length > 1) {
          const gaps = reqs.slice(1).map((r, i) => r.at - reqs[i].done);
          p.check("pipelined: the next sentence is requested as the previous one arrives (one in flight)", gaps.every((g) => g >= -20 && g < 400), gaps);
          const silence = longestSilence(samples.filter((x) => x.phase === "speaking"));
          p.metrics.sentencesLongestSilenceMs = silence;
          p.check("no gap between sentences (the output never drops out)", silence >= 0 && silence < 250, `${silence} ms`);
        } else p.skip("sentence pipelining", `the reply was one sentence (${reqs[0]?.text.slice(0, 30)})`);

        // c) both 503 → Web Speech ko-KR, and tts_unavailable is remembered
        tts.mode = "503";
        s0 = tts.stream.reqs.length;
        n0 = tts.reqs.length;
        await recSay(page, "고마워, 한 문장으로 답해 줘", true);
        const viaWeb = await waitVoice(page, "webspeech", LLM_MS);
        const spoken = await page.evaluate(() => window.__spoken.slice());
        p.check("stream 503 → /api/tts 503 → the reply is spoken with Web Speech ko-KR", viaWeb && spoken.length > 0 && tts.stream.reqs.length - s0 === 1 && tts.reqs.length - n0 === 1, { stream: tts.stream.reqs.length - s0, sentences: tts.reqs.length - n0, spoken: spoken.map((x) => x.slice(0, 20)) });
        await p.shot("call-webspeech");
        await waitPhase(page, "listening", 30_000);
        const before = tts.count();
        await recSay(page, "응, 한 문장으로 하나만 더 말해 줘", true);
        const viaWeb2 = await waitVoice(page, "webspeech", LLM_MS);
        p.check("tts_unavailable is remembered: the next reply goes straight to Web Speech", viaWeb2 && tts.count() === before, { requested: tts.count() - before });
      }
      await page.locator(".call-card").getByRole("button", { name: "통화 종료" }).click();
      await page.waitForSelector(".call-card", { state: "detached", timeout: 8000 }).catch(() => {});
      tts.mode = "ok";
      tts.stream.mode = "ok";
      await sleep(500);
    }
    // ── 17. call transcript: streamed text grows in place, no line ever moves sideways (frame-sampled) ──
    if (want("transcript")) {
      p.step = "call-transcript";
      await waitAgentIdle(page);
      await installScriptedSpeech(page);
      await installStreamScript(page);
      await page.getByRole("button", { name: "통화하기" }).click();
      await page.waitForSelector(".call-card", { timeout: 8000 });
      const ready = await page.waitForFunction(() => !!window.__rec?.cur, null, { timeout: 8000 }).then(() => true).catch(() => false);
      p.check("transcript: scripted recogniser ready", ready);
      if (ready) {
        // two short exchanges first, so the stream runs under lines that are already on screen
        const seed = async (heard, reply) => {
          await page.evaluate((s) => (window.__streamScript = s), { deltas: deltasOf(reply), everyMs: 30, firstMs: 120 });
          await recSay(page, heard, true);
          await waitPhase(page, "speaking", 8000);
          await waitPhase(page, "listening", 15_000);
        };
        await seed("안녕 깽이야", "안녕하세요, 하늘님! 오늘 목소리가 밝네요.");
        await seed("응 오늘 좀 좋은 일이 있었어", "좋은 일이라니 궁금해요. 어떤 일이었는지 들려주세요.");
        const heard = "그럼 이번 주말에 서울에서 가볼 만한 조용한 전시 하나만 추천해 줄래";
        const reply =
          "좋아요, 이번 주말이면 국립현대미술관 서울관의 소장품 기획전을 추천해요. 평일보다는 붐비지만 오전 열 시쯤 가면 꽤 한산하고, 전시실이 넓어서 천천히 걷기 좋아요. 끝나고 삼청동 쪽으로 걸어 나오면 조용한 찻집도 많으니 같이 들러 보세요.";
        await page.evaluate((s) => (window.__streamScript = s), { deltas: deltasOf(reply), everyMs: 40, firstMs: 300 });
        await sampleTranscript(page);
        const tStart = Date.now();
        // the person's words arrive as growing interim results (1–3 syllables at a time), then the final
        await page.evaluate((text) => {
          const parts = [];
          for (let i = 0, k = 0; i < text.length; k++) {
            const n = [2, 1, 3][k % 3];
            parts.push(text.slice(0, i + n));
            i += n;
          }
          parts.forEach((t, i) => setTimeout(() => window.__rec.say(t, false), i * 70));
          setTimeout(() => window.__rec.say(text, true), parts.length * 70 + 150);
        }, heard);
        // strip frames while it streams (the light variant keeps them)
        const box = await page.locator(".call-transcript").boundingBox();
        const keep = p.variant === "light";
        const tmpShots = [];
        const tmpDir = keep ? fs.mkdtempSync(path.join(os.tmpdir(), "pickle-strip-")) : null;
        if (keep)
          await page.evaluate((b) => {
            // thin guides at the column's left edge and centre: anything sliding sideways shows against them
            for (const [x, c] of [[b.x + 0.5, "rgba(255,80,80,.9)"], [b.x + b.width / 2, "rgba(80,160,255,.6)"]]) {
              const g = document.createElement("div");
              g.className = "qa-guide";
              g.style.cssText = `position:fixed;left:${x}px;top:${b.y - 4}px;width:1px;height:${b.height + 8}px;background:${c};pointer-events:none;z-index:99999`;
              document.body.appendChild(g);
            }
          }, box);
        // the voice now starts while the reply streams: the stream is done once the whole reply is on the line
        const streamDone = page
          .waitForFunction(
            (n) => {
              const li = [...document.querySelectorAll(".call-line[data-who=agent]")].pop();
              return (li?.textContent || "").replace(/[^\p{L}\p{N}]/gu, "").length >= n;
            },
            lettersOnly(reply).length,
            { timeout: 30_000 },
          )
          .catch(() => {});
        let finished = false;
        void streamDone.then(() => (finished = true));
        while (keep && !finished && Date.now() - tStart < 20_000) {
          const f = path.join(tmpDir, `f${String(tmpShots.length).padStart(2, "0")}.jpg`);
          await page.screenshot({ path: f, type: "jpeg", quality: 85, scale: "css", clip: { x: 0, y: Math.max(0, box.y - 8), width: 390, height: box.height + 16 } });
          tmpShots.push(f);
          await sleep(220);
        }
        await streamDone;
        await sleep(700);
        const frames = await page.evaluate(() => {
          window.__tx.run = false;
          document.querySelectorAll(".qa-guide").forEach((g) => g.remove());
          return window.__tx.frames;
        });
        const j = judgeTranscript(frames);
        const align = await page.evaluate(() => getComputedStyle(document.querySelector(".call-transcript")).textAlign);
        p.metrics.transcript = { ...j, align };
        p.check("transcript: no line already on screen moves sideways (left edge ≤ 0.5 px, every frame)", j.frames > 30 && j.maxLeftPx <= 0.5, { frames: j.frames, ms: j.ms, maxLeftPx: j.maxLeftPx, worst: j.worst.left });
        p.check("transcript: the first glyph of a line on screen never moves sideways (≤ 0.5 px)", j.frames > 30 && j.maxGlyphPx <= 0.5, { maxGlyphPx: j.maxGlyphPx, worst: j.worst.glyph });
        p.check("transcript: streamed text grows in place (finished words never move)", j.frames > 30 && j.maxWordXPx <= 0.5 && j.maxWordYPx <= 0.5, { maxWordXPx: j.maxWordXPx, maxWordYPx: j.maxWordYPx, worst: j.worst.word });
        if (keep) {
          const base = path.join(outDir, `call-transcript-${STRIP}-${p.engine}`);
          fs.writeFileSync(`${base}.json`, JSON.stringify({ engine: p.engine, variant: p.variant, strip: STRIP, at: new Date().toISOString(), align, ...j, frameCount: j.frames, frames: frames.map((f) => ({ t: Math.round(f.t - frames[0].t), lines: f.lines.map((l) => ({ id: l.id, who: l.who, cur: l.cur, left: Math.round(l.left * 100) / 100, gx: l.gx === null ? null : Math.round(l.gx * 100) / 100, top: Math.round(l.top * 10) / 10, len: l.len })) })) }));
          if (tmpShots.length) {
            const pick = tmpShots.length > 10 ? tmpShots.filter((_, i) => i % Math.ceil(tmpShots.length / 10) === 0) : tmpShots;
            const args = ["-y", "-loglevel", "error", ...pick.flatMap((f) => ["-i", f]), "-filter_complex", `${pick.map((_, i) => `[${i}]pad=iw:ih+4:0:0:0x808080[p${i}]`).join(";")};${pick.map((_, i) => `[p${i}]`).join("")}vstack=inputs=${pick.length}`, "-q:v", "3", `${base}.jpg`];
            const ff = spawnSync("ffmpeg", args, { encoding: "utf8" });
            if (ff.status !== 0) console.log(`  (strip not written: ${ff.stderr.slice(0, 200)})`);
            p.shots.push(path.relative(repo, `${base}.jpg`));
          }
          fs.rmSync(tmpDir, { recursive: true, force: true });
        }
      }
      if (await page.locator(".call-card").count()) {
        await page.locator(".call-card").getByRole("button", { name: "통화 종료" }).click();
        await page.waitForSelector(".call-card", { state: "detached", timeout: 8000 }).catch(() => {});
      }
      await page.evaluate(() => {
        if (window.__realFetch) window.fetch = window.__realFetch;
      });
      await sleep(400);
    }
    // ── 18. de-slop: every card from fixtures + a live meeting thread; before/after shots (QA_STRIP) ──
    if (want("deslop")) {
      p.step = "deslop";
      const dir = path.join(outDir, "deslop");
      fs.mkdirSync(dir, { recursive: true });
      const snap = async (name) => {
        const file = path.join(dir, `${STRIP}-${p.tag}-${name}.jpg`);
        await page.screenshot({ path: file, type: "jpeg", quality: 82, scale: "css" });
        p.shots.push(path.relative(repo, file));
        if (STRIP === "after") await appliedShot(page, p, "deslop", name);
      };
      const sess = await page.evaluate(async () => {
        const token = localStorage.getItem("pickle.token");
        const r = await fetch("/api/session", { headers: { authorization: `Bearer ${token}` } });
        return r.ok ? r.json() : null;
      });
      const mainId = sess?.mainThreadId ?? sess?.session?.mainThreadId ?? null;
      const agentName = sess?.agent?.name ?? "깽이";
      p.check("deslop: main thread id from the session", !!mainId);
      if (mainId) {
        const meet = deslopMeetThread(agentName);
        const left = { calls: 0, notLive: false };
        const onMessages = async (r) => {
          if (r.request().method() !== "GET") return r.fallback();
          const id = decodeURIComponent(new URL(r.request().url()).pathname.split("/")[3]);
          if (id === mainId) return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(deslopThread(mainId, agentName)) });
          if (id === meet.thread.id) return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(meet.items) });
          return r.fallback();
        };
        const onThreads = async (r) => {
          if (r.request().method() !== "GET") return r.fallback();
          const res = await r.fetch();
          const body = await res.json();
          const list = Array.isArray(body) ? body : body.items ?? [];
          const items = [meet.thread, ...list.filter((t) => t.id !== meet.thread.id)];
          return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(Array.isArray(body) ? items : { ...body, items }) });
        };
        const onMeet = async (r) => {
          const u = new URL(r.request().url());
          if (r.request().method() === "POST" && u.pathname.endsWith("/meet/leave")) {
            left.calls++;
            meet.meeting = { ...meet.meeting, state: "ended", live: false, endedAt: Date.now() };
            // the server's answer when the meeting ended on its own between the GET and the tap
            if (left.notLive) return r.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "not_live", message: "지금 참여 중인 회의가 없어요" }) });
            return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, state: "ended" }) });
          }
          // an approved join card in the main thread follows the meeting its approval started (GET …/meet?approval=);
          // these fixture approvals are not on the server (it would answer 404), and the older card started none
          if (u.searchParams.has("approval")) return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ meeting: null }) });
          return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ meeting: meet.meeting }) });
        };
        await page.route(/\/api\/threads\/[^/]+\/messages(\?.*)?$/, onMessages);
        await page.route(/\/api\/threads(\?.*)?$/, onThreads);
        await page.route(/\/api\/threads\/[^/]+\/meet(\/leave)?(\?.*)?$/, onMeet);
        await page.reload({ waitUntil: "load" });
        await page.waitForSelector(".ccard-approval", { timeout: 20_000 }).catch(() => {});
        await sleep(1200);
        await snap("01-latest-phone-approval");
        // read-only records fold behind their turn's line (toolfold): open those, one at a time, for the card shots
        await openFolds(page);
        for (const [sel, name] of [
          ['.ccard-approval[data-approval-id="ds-ap-meet"]', "02-meet-approval-pending"],
          ['.ccard-approval[data-approval-id="ds-ap-meet-done"]', "03-meet-approved"],
          [".msg-event", "04-event-notes"],
          [".ccard-artifact", "05-artifact"],
          [".ccard-sched", "06-schedule"],
          [".ccard-cred", "07-credential"],
          [".ccard-results", "08-results"],
        ]) {
          const el = page.locator(sel).first();
          if (!(await el.count())) {
            p.check(`deslop: ${name} rendered`, false);
            continue;
          }
          await el.evaluate((e) => e.scrollIntoView({ block: "center" }));
          await sleep(500);
          await snap(name);
        }
        // my bubble on the paper (Flat Paper: no shadow, so its fill alone has to set it apart from the wallpaper).
        // Measured on rendered pixels: the fill just inside its left edge against the paper just outside it, for the
        // first my-bubble (under the wallpaper's top light) and the last one (on the flat --bg).
        const mine = page.locator(".msg-row .bubble-me");
        const myBubbles = [];
        for (const [which, el] of [
          ["top", mine.first()],
          ["bottom", mine.last()],
        ]) {
          if (!(await el.count())) continue;
          await el.evaluate((e) => e.scrollIntoView({ block: "center" })); // the first one clamps at the top of the list
          await sleep(500);
          const box = await el.boundingBox();
          const shadow = await el.evaluate((e) => getComputedStyle(e).boxShadow);
          if (!box) continue;
          const y = box.y + box.height / 2;
          const fill = await pixelAt(page, box.x + 5, y);
          const paper = await pixelAt(page, box.x - 10, y);
          myBubbles.push({ which, fill, paper, ratio: ratioOf(fill, paper), shadow });
          if (which === "top") await snap("13-my-bubble");
        }
        p.metrics.myBubble = myBubbles;
        p.check("deslop: my bubble has no shadow", myBubbles.length > 0 && myBubbles.every((m) => m.shadow === "none"), myBubbles.map((m) => m.shadow));
        p.check("deslop: my bubble's fill stands apart from the paper (≥ 1.18:1, iMessage's grey on white is 1.21)", myBubbles.length > 0 && myBubbles.every((m) => m.ratio >= 1.18), myBubbles);
        // ... and under every wallpaper hue, not only this account's random one: the agent's colour tints the light,
        // and a fixed grey sank into a blue-violet light (opaque #dfdfe1 measured 1.169:1 on a lilac account; the
        // sweep's worst was hue 247 in light, 57 in dark). Re-tint the wallpaper in place, with the same data-tint /
        // --wp-hue that WallpaperHost sets, measure the same two bubbles across a spread of hues, then restore it.
        const HUES = [null, 0, 57, 120, 190, 247, 300];
        const wpWas = await page.evaluate(() => {
          const w = document.querySelector(".wallpaper");
          return w ? { tint: w.hasAttribute("data-tint"), style: w.getAttribute("style") } : null;
        });
        const hueSweep = [];
        if (wpWas) {
          for (const [which, el] of [
            ["top", mine.first()],
            ["bottom", mine.last()],
          ]) {
            if (!(await el.count())) continue;
            await el.evaluate((e) => e.scrollIntoView({ block: "center" }));
            await sleep(500);
            const box = await el.boundingBox();
            if (!box) continue;
            const y = box.y + box.height / 2;
            for (const hue of HUES) {
              await page.evaluate((h) => {
                const w = document.querySelector(".wallpaper");
                if (h === null) {
                  w.removeAttribute("data-tint");
                  w.style.removeProperty("--wp-hue");
                } else {
                  w.setAttribute("data-tint", "");
                  w.style.setProperty("--wp-hue", String(h));
                }
                return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
              }, hue);
              const fill = await pixelAt(page, box.x + 5, y);
              const paper = await pixelAt(page, box.x - 10, y);
              hueSweep.push({ which, hue, ratio: ratioOf(fill, paper), fill, paper });
            }
          }
          await page.evaluate((was) => {
            const w = document.querySelector(".wallpaper");
            if (was.tint) w.setAttribute("data-tint", "");
            else w.removeAttribute("data-tint");
            if (was.style === null) w.removeAttribute("style");
            else w.setAttribute("style", was.style);
          }, wpWas);
        }
        p.metrics.myBubbleHues = hueSweep;
        const hueWorst = hueSweep.reduce((a, b) => (b.ratio < a.ratio ? b : a), hueSweep[0]);
        p.check("deslop: my bubble stands apart from the paper under every wallpaper hue (≥ 1.18:1)", hueSweep.length === HUES.length * 2 && hueSweep.every((m) => m.ratio >= 1.18), { worst: hueWorst, measured: hueSweep.length });
        // the numbers behind the shots
        const ev = await contrastOf(page, ".msg-event");
        const source = await contrastOf(page, ".ccard-source");
        p.metrics.deslop = { eventContrast: ev, sourceContrast: source };
        p.check("deslop: event notes ≥ 4.5:1 against what is behind them", ev.length > 0 && ev.every((x) => x.ratio >= 4.5), ev);
        // chat B: the source is words at the card head's right (no pill)
        p.check("deslop: card sources are words ≥ 4.5:1 (no pill)", source.length > 0 && source.every((x) => x.ratio >= 4.5) && (await page.locator(".ccard-badge").count()) === 0, source);
        // (the live chips went with toolfold, 2026-11-15: a long status in the turn's line is checked there)
        // the artifact plate (IT-9) went with meeting B (2026-11-12); the others were R
        const plates = await page.locator(".appr-icon, .res-icon, .sched-icon, .cred-lock, .thread-intro-plate, .art-plate").count();
        p.check("deslop: no icon plates on the cards (approval, results, schedule, credential, artifact)", plates === 0, { plates });
        p.check("deslop: the artifact card has no kicker above its title", (await page.locator(".ccard-artifact .art-kind").count()) === 0);
        const phone = page.locator('.ccard-approval[data-approval-id="ds-ap-call"]');
        const phoneText = (await phone.textContent()) ?? "";
        p.check("deslop: the phone approval shows the full number it will dial", /02-1234-1234/.test(phoneText) && !/\*\*\*\*/.test(phoneText), phoneText.slice(0, 120));
        p.check("deslop: the phone approval says the call is one-way", /대답은 들을 수 없어요/.test(phoneText));
        p.check("deslop: no red 확인 필요 badge on the phone approval", !/확인 필요/.test(phoneText));
        // phone B (2026-11-12): the number is the one fact to check, the words are the agent's voice, the gesture is said
        const phoneLook = await phone.evaluate((card) => {
          const num = card.querySelector(".appr-number");
          const title = card.querySelector(".ccard-title");
          const voice = card.querySelector(".appr-voice");
          const hint = card.querySelector(".appr-hold-hint");
          const confirm = [...card.querySelectorAll("button")].find((b) => /전화 걸기/.test(b.textContent));
          const cancel = [...card.querySelectorAll("button")].find((b) => /취소/.test(b.textContent));
          const sizes = [...card.querySelectorAll("*")].filter((e) => e.childElementCount === 0 && e.textContent.trim()).map((e) => parseFloat(getComputedStyle(e).fontSize));
          const y = (e) => e?.getBoundingClientRect().top ?? -1;
          return {
            num: num?.textContent.trim() ?? null,
            numSize: num ? parseFloat(getComputedStyle(num).fontSize) : 0,
            titleSize: title ? parseFloat(getComputedStyle(title).fontSize) : 0,
            largest: Math.max(...sizes),
            glyph: card.querySelectorAll(".appr-glyph").length,
            face: voice?.querySelectorAll(".avatar").length ?? 0,
            rule: voice ? parseFloat(getComputedStyle(voice).borderTopWidth) : 0,
            hint: hint?.textContent.trim() ?? null,
            hintHidden: hint?.getAttribute("aria-hidden") ?? null,
            order: y(confirm) < y(hint) && y(hint) < y(cancel),
          };
        });
        p.check("phone B: the full number is the card's largest line, no glyph before the title", phoneLook.num === "02-1234-1234" && phoneLook.numSize >= 22 && phoneLook.numSize === phoneLook.largest && phoneLook.numSize > phoneLook.titleSize && phoneLook.glyph === 0, phoneLook);
        p.check("phone B: under a hairline, the agent's face stands before the words (the voice they will hear)", phoneLook.face === 1 && phoneLook.rule > 0, phoneLook);
        p.check("phone B: the hold / two-tap gesture is said in words between 전화 걸기 and 취소 (announced once: the button's description)", phoneLook.hint === "길게 누르거나, 두 번 눌러 확인해요" && phoneLook.hintHidden === "true" && phoneLook.order, phoneLook);
        const cancel = await phone.getByRole("button", { name: "취소" }).evaluate((b) => {
          const probe = document.createElement("span");
          probe.style.color = "var(--label)";
          document.body.appendChild(probe);
          const label = getComputedStyle(probe).color;
          probe.remove();
          return { color: getComputedStyle(b).color, label };
        });
        p.check("deslop: 취소 on the phone approval is in the label colour, not a second blue", cancel.color === cancel.label, cancel);
        const meetCard = page.locator('.ccard-approval[data-approval-id="ds-ap-meet"]');
        const meetText = (await meetCard.textContent()) ?? "";
        p.check("deslop: the meeting approval reads as joining a meeting (회의 참여, its code, purpose)", /회의 참여/.test(meetText) && /주간 회의 받아 적기/.test(meetText) && !/보낼 내용/.test(meetText), meetText.slice(0, 140));
        // the code: FULL from card.meet, on one line in tabular figures; a card stored before the field (full code only in
        // its old title) shows it masked
        const codeCell = await meetCard.locator(".appr-code").evaluate((e) => ({ text: e.textContent, ws: getComputedStyle(e).whiteSpace, num: getComputedStyle(e).fontVariantNumeric })).catch(() => null);
        p.check("deslop: the meeting approval shows the FULL code from card.meet, nowrap and tabular", codeCell?.text === "rak-dmqe-kud" && codeCell.ws === "nowrap" && /tabular-nums/.test(codeCell.num), codeCell);
        const oldCode = await page.locator('.ccard-approval[data-approval-id="ds-ap-meet-done"] .appr-code').textContent().catch(() => null);
        const oldText = (await page.locator('.ccard-approval[data-approval-id="ds-ap-meet-done"]').textContent().catch(() => "")) ?? "";
        p.check("deslop: an older join card (full code only in its title, no card.meet) never shows the full code", (oldCode == null || oldCode === "abc-****-hij") && !/abc-defg-hij/.test(oldText), { oldCode, oldText: oldText.slice(0, 80) });
        p.check("deslop: its button is 참여 승인, not 보내기", (await meetCard.getByRole("button", { name: "참여 승인" }).count()) === 1 && (await meetCard.getByRole("button", { name: "보내기" }).count()) === 0);
        // agent sheet: no "AI 에이전트" filler
        const agentBtn = page.getByRole("button", { name: /프로필$/ }).first();
        if (await agentBtn.count()) {
          await agentBtn.click();
          await page.waitForSelector(".agent-sheet", { timeout: 6000 }).catch(() => {});
          await sleep(700);
          await snap("09-agent-sheet");
          // the persona is the agent's own words (it may say "AI 에이전트"); the filler was the "{이름} 님의 AI 에이전트" line
          p.check("deslop: the agent sheet has no '님의 AI 에이전트' filler line", !/님의 AI 에이전트/.test((await page.locator(".agent-sheet").textContent().catch(() => "")) ?? ""));
          await page.keyboard.press("Escape");
          await sleep(600);
        }
        // the live meeting thread: one tap (and a confirm) takes the agent out
        await page.getByRole("button", { name: "메뉴" }).click();
        await page.waitForSelector(".dw");
        await sleep(700);
        await page.locator(".dw-row").filter({ hasText: "회의 참여" }).first().click();
        await page.waitForSelector(".msg-event", { timeout: 10_000 }).catch(() => {});
        await sleep(1200);
        await snap("10-meeting-thread-live");
        const leave = page.getByRole("button", { name: "회의에서 내보내기" });
        p.check("deslop: a live meeting thread offers 회의에서 내보내기", (await leave.count()) > 0);
        if (await leave.count()) {
          await leave.first().click();
          await sleep(500);
          await snap("11-meeting-leave-confirm");
          p.check("deslop: the first tap only asks (no leave yet)", left.calls === 0, { calls: left.calls });
          await page.locator(".meet-live").getByRole("button").first().click();
          await until(() => left.calls > 0, 5000);
          await sleep(1200);
          await snap("12-meeting-left");
          p.check("deslop: confirming calls POST …/meet/leave once and the control goes away", left.calls === 1 && (await page.getByRole("button", { name: "회의에서 내보내기" }).count()) === 0, { calls: left.calls });
          // 409 not_live (it ended on its own meanwhile): the agent is already out, so no error, the control just goes
          p.step = "deslop-409"; // its 409 is expected
          meet.meeting = { ...meet.meeting, state: "in_call", live: true, endedAt: null };
          left.notLive = true;
          await page.getByRole("button", { name: "뒤로" }).click().catch(() => {});
          await sleep(600);
          await page.getByRole("button", { name: "메뉴" }).click();
          await page.waitForSelector(".dw");
          await sleep(700);
          await page.locator(".dw-row").filter({ hasText: "회의 참여" }).first().click();
          await page.getByRole("button", { name: "회의에서 내보내기" }).first().waitFor({ timeout: 8000 }).catch(() => {});
          const again = page.getByRole("button", { name: "회의에서 내보내기" });
          if (await again.count()) {
            await again.first().click();
            await sleep(400);
            await page.locator(".meet-live").getByRole("button").first().click();
            await until(() => left.calls > 1, 5000);
            await sleep(1000);
            const alert = await page.locator(".meet-live-error").count();
            p.check("deslop: a leave answered 409 not_live shows no error and the control goes away", left.calls === 2 && alert === 0 && (await page.getByRole("button", { name: "회의에서 내보내기" }).count()) === 0, { calls: left.calls, alert });
          } else p.check("deslop: the meeting thread offers the control again for the 409 case", false);
          p.step = "deslop";
        }
        await page.getByRole("button", { name: "뒤로" }).click().catch(() => {});
        await sleep(500);
        await page.unroute(/\/api\/threads\/[^/]+\/messages(\?.*)?$/, onMessages);
        await page.unroute(/\/api\/threads(\?.*)?$/, onThreads);
        await page.unroute(/\/api\/threads\/[^/]+\/meet(\/leave)?(\?.*)?$/, onMeet);
        await reloadSettled(page);
        await sleep(400);
      }
    }

    // ── 19. the user's picks (2026-11-12): chat B (the KakaoTalk room per A) + empty-thread A, on fixture threads ──
    if (want("picks")) {
      p.step = "picks";
      const dir = path.join(outDir, "picks");
      fs.mkdirSync(dir, { recursive: true });
      const snap = async (name) => {
        const file = path.join(dir, `${p.tag}-${name}.jpg`);
        await page.screenshot({ path: file, type: "jpeg", quality: 82, scale: "css" });
        p.shots.push(path.relative(repo, file));
      };
      const sess = await page.evaluate(async () => {
        const token = localStorage.getItem("pickle.token");
        const r = await fetch("/api/session", { headers: { authorization: `Bearer ${token}` } });
        return r.ok ? r.json() : null;
      });
      const mainId = sess?.mainThreadId ?? sess?.session?.mainThreadId ?? null;
      const agentName = sess?.agent?.name ?? "깽이";
      if (!mainId) p.check("picks: main thread id from the session", false);
      else {
        const T = Date.now() - 4 * 3600_000;
        // the server's welcome after the empty-thread A copy (two lines; the rows are the buttons)
        const welcome = {
          id: "pk-w0",
          threadId: mainId,
          role: "assistant",
          text: `안녕하세요, 하늘 님. 저는 ${agentName}예요.\n궁금한 걸 묻거나 귀찮은 일을 맡겨 주세요.`,
          tools: [],
          attachments: [],
          createdAt: T,
          cards: [
            {
              type: "briefing",
              title: "이런 일을 맡겨 보세요",
              items: [
                { icon: "sun", text: "오늘 날씨와 미세먼지를 알려 드려요", action: { label: "오늘 날씨 알려 줘", send: "오늘 날씨 알려 줘" } },
                { icon: "doc", text: "지금 신청할 수 있는 정부 지원사업을 찾아 드려요", action: { label: "지원사업 찾아줘", send: "내가 지금 신청할 수 있는 정부 지원사업 찾아줘" } },
                { icon: "kakao", text: "카카오톡을 연결하면 안 읽은 대화를 정리해 드려요", action: { label: "카카오톡 연결하기", open: "connections" } },
                { icon: "clock", text: "매일 아침 브리핑을 먼저 보내 드려요", action: { label: "모닝 브리핑 예약", send: "매일 아침 7시에 날씨랑 뉴스 브리핑해줘" } },
              ],
            },
          ],
        };
        const mode = { items: [welcome] };
        const sent = [];
        const held = [];
        // POSTs to the main thread never reach the server: held (the turn "runs"), then answered 201 delivered
        const release = async () => {
          while (held.length) {
            const { r, text } = held.shift();
            await r.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ delivered: true, userMessage: { id: `pk-u${rand()}`, threadId: mainId, role: "user", text, cards: [], tools: [], attachments: [], createdAt: Date.now() } }) }).catch(() => {});
          }
        };
        const onMessages = async (r) => {
          const req = r.request();
          const id = decodeURIComponent(new URL(req.url()).pathname.split("/")[3]);
          if (id !== mainId) return r.fallback();
          if (req.method() === "GET") return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(mode.items) });
          if (req.method() === "POST") {
            const text = JSON.parse(req.postData() || "{}").text ?? "";
            sent.push(text);
            held.push({ r, text });
            return;
          }
          return r.fallback();
        };
        const MSG_ROUTE = /\/api\/threads\/[^/]+\/messages(\?.*)?$/;
        await page.route(MSG_ROUTE, onMessages);
        const color = (v) =>
          page.evaluate((v) => {
            const s = document.createElement("span");
            s.style.color = v;
            document.body.appendChild(s);
            const c = getComputedStyle(s).color;
            s.remove();
            return c;
          }, v);
        const fill = (v) =>
          page.evaluate((v) => {
            const s = document.createElement("span");
            s.style.background = v;
            document.body.appendChild(s);
            const c = getComputedStyle(s).backgroundColor;
            s.remove();
            return c;
          }, v);

        // ── empty-thread A: the welcome, its rows as buttons ──
        await page.reload({ waitUntil: "load" });
        await page.waitForSelector(".ccard-briefing", { timeout: 20_000 }).catch(() => {});
        await sleep(1200);
        await snap("01-welcome");
        const greet = await page.locator(".msg-asst .asst-text").first().evaluate((e) => ({ bg: getComputedStyle(e).backgroundColor, shadow: getComputedStyle(e).boxShadow })).catch(() => null);
        p.check("picks: the welcome greeting is text on the canvas (no bubble)", !!greet && /rgba\(0, 0, 0, 0\)|transparent/.test(greet.bg) && greet.shadow === "none", greet);
        const brief = page.locator(".ccard-briefing").first();
        const rows = brief.locator("button.brief-row");
        p.check("picks: the welcome rows are the buttons, glyphs without plates, the open row with a chevron", (await rows.count()) === 4 && (await brief.locator(".list-row-plate, .brief-icon, .quick-replies").count()) === 0 && (await brief.locator(".brief-row").nth(2).locator(".list-row-chevron").count()) === 1 && (await brief.locator(".brief-row").nth(0).locator(".list-row-chevron").count()) === 0);
        const before = await page.locator(".msg-me").count();
        await p.interact("welcome-row", () => rows.first().click());
        await sleep(250);
        const mine = ((await page.locator(".msg-me .bubble-text").last().textContent().catch(() => "")) || "").trim();
        p.check("picks: a send row posts its words at once (the bubble is there)", (await page.locator(".msg-me").count()) === before + 1 && mine === "오늘 날씨 알려 줘" && sent.length === 1, { mine, sent });
        await sleep(2400);
        await snap("02-welcome-picked");
        const label2 = await color("var(--label-2)");
        const picked = await rows.first().evaluate((e) => ({ sent: e.classList.contains("is-sent"), color: getComputedStyle(e.querySelector(".list-row-title")).color, disabled: e.disabled }));
        const others = await rows.evaluateAll((els) => els.slice(1).map((e) => ({ sent: e.classList.contains("is-sent"), disabled: e.disabled })));
        p.check("picks: the picked row rests in label-2 (not disabled); the others stay live", picked.sent && picked.color === label2 && !picked.disabled && others.every((o) => !o.sent && !o.disabled), { picked, others, label2 });
        await rows.first().click();
        await sleep(300);
        p.check("picks: tapping the picked row again sends nothing", sent.length === 1, sent);
        await release();
        await page.waitForFunction(() => !document.querySelector(".ccard-briefing .brief-row.is-sent"), null, { timeout: 6000 }).catch(() => {});
        p.check("picks: once its answer is in, the row is live again", (await brief.locator(".brief-row.is-sent").count()) === 0);

        // ── chat B on the record thread ──
        mode.items = picksThread(mainId, agentName);
        await page.reload({ waitUntil: "load" });
        await page.waitForSelector(".thread-content .tools-line", { timeout: 20_000 }).catch(() => {});
        await sleep(1400);
        const turns = await page.evaluate(() =>
          [...document.querySelectorAll(".thread-content > .msg-asst")].map((row) => {
            const head = row.querySelector(".asst > .turn-head, .asst > .tools-fold > .turn-head");
            const text = row.querySelector(".asst-text");
            const cs = text ? getComputedStyle(text) : null;
            return { face: !!head?.querySelector(".avatar"), head: head?.textContent.trim() ?? null, bg: cs?.backgroundColor ?? null, shadow: cs?.boxShadow ?? null, radius: cs?.borderTopLeftRadius ?? null };
          }),
        );
        p.check("picks: every assistant turn opens with the agent's face", turns.length >= 5 && turns.every((t) => t.face), turns.map((t) => t.head));
        p.check("picks: the assistant's words have no bubble (no fill, no edge)", turns.filter((t) => t.bg !== null).every((t) => /rgba\(0, 0, 0, 0\)|transparent/.test(t.bg) && t.shadow === "none"), turns);
        const stepsHead = ((await page.locator(".tools-line.turn-head").first().textContent().catch(() => "")) || "").replace(/\u00a0/g, " ");
        p.check("picks: the turn's records fold into the head's line (자료 1개 보기 · 기상청), face first", /^자료 1개 보기 · 기상청/.test(stepsHead.trim()) && (await page.locator(".tools-line.turn-head").first().locator(".avatar").count()) === 1, stepsHead.trim());
        // the cards below are measured open: open each folded line, one at a time
        await openFolds(page);
        const stepsCap = ((await page.locator(".tools-steps-cap").first().textContent().catch(() => "")) || "").trim();
        p.check("picks: behind the line the steps keep their time, in minutes past a minute (2단계 · 1분 33초)", stepsCap === "2단계 · 1분 33초", stepsCap);
        // one 16 pt gutter: the column runs edge to edge of the composer
        const gutter = await page.evaluate(() => {
          const c = document.querySelector(".thread-content");
          const me = [...document.querySelectorAll(".bubble-me")].pop();
          const comp = document.querySelector(".composer");
          return { pad: getComputedStyle(c).paddingLeft, contentLeft: c.getBoundingClientRect().left, contentRight: c.getBoundingClientRect().right, meRight: me?.getBoundingClientRect().right ?? 0, width: innerWidth };
        });
        p.check("picks: one 16 pt gutter (the column is 16 from each edge, not 32)", gutter.pad === "0px" && Math.abs(gutter.contentLeft - 16) <= 0.5 && Math.abs(gutter.contentRight - (gutter.width - 16)) <= 0.5 && Math.abs(gutter.meRight - (gutter.width - 16)) <= 0.5, gutter);
        // weather
        const wx = page.locator(".ccard-weather").first();
        await wx.evaluate((e) => e.scrollIntoView({ block: "center" }));
        await sleep(600);
        await snap("03-weather");
        const wxLook = await wx.evaluate((card) => ({
          plates: card.querySelectorAll(".wx-icon").length,
          tiles: [...card.querySelectorAll(".wx-hour")].filter((h) => !/rgba\(0, 0, 0, 0\)|transparent/.test(getComputedStyle(h).backgroundColor)).length,
          rule: parseFloat(getComputedStyle(card.querySelector(".wx-hours")).borderTopWidth),
          source: card.querySelector(".wx-head .ccard-source")?.textContent ?? null,
          moon: card.querySelector(".wx-hour:last-child svg")?.innerHTML.length ?? 0,
          hours: card.querySelectorAll(".wx-hour").length,
        }));
        p.check("picks: weather — no glyph plate, the hours flat under one hairline, the source on the head", wxLook.plates === 0 && wxLook.tiles === 0 && wxLook.rule > 0 && wxLook.source === "기상청" && wxLook.hours === 5, wxLook);
        p.check("picks: weather — 0시 draws the moon", wxLook.moon > 20, wxLook.moon);
        // results
        const res = page.locator(".ccard-results").first();
        await res.evaluate((e) => e.scrollIntoView({ block: "center" }));
        await sleep(600);
        await snap("04-results");
        const resLook = await res.evaluate((card) => {
          const pad = parseFloat(getComputedStyle(card).paddingLeft);
          const list = card.querySelector(".res-list").getBoundingClientRect();
          const metas = [...card.querySelectorAll(".res-meta")].map((m) => m.getBoundingClientRect().right);
          const subs = [...card.querySelectorAll(".res-row")].map((r) => ({ sub: r.querySelector(".res-sub")?.getBoundingClientRect().right ?? 0, meta: r.querySelector(".res-meta")?.getBoundingClientRect().left ?? 0 }));
          return { source: card.querySelector(".res-head .ccard-source")?.textContent ?? null, badges: card.querySelectorAll(".ccard-badge").length, listInset: Math.round(list.left - card.getBoundingClientRect().left - pad), metaRights: metas, subs };
        });
        p.check("picks: results — the source is words on the head (no pill), the rows inside the text column", resLook.source === "정부24" && resLook.badges === 0 && Math.abs(resLook.listInset) <= 1, resLook);
        p.check("picks: results — 'when' stands in one right-aligned column beside 'what'", resLook.metaRights.length === 3 && Math.max(...resLook.metaRights) - Math.min(...resLook.metaRights) <= 1 && resLook.subs.every((x) => x.meta > x.sub), resLook);
        // KakaoTalk room (draft A)
        const mt = page.locator(".mt-card").first();
        await mt.evaluate((e) => e.scrollIntoView({ block: "center" }));
        await sleep(600);
        await snap("05-messenger");
        const meta = ((await mt.locator(".mt-meta").textContent().catch(() => "")) || "").replace(/\s+/g, " ");
        p.check("picks: KakaoTalk (A) — 안 읽음 comes right after the app", /카카오톡\s*·\s*안 읽음 7\s*·\s*메시지 6개/.test(meta), meta);
        // 대화 펼치기 expands in place: on every frame from the tap the toggle stays where the finger is, and the body
        // is never blank — the highlights, or the room fully opaque with at least the highlights' height showing
        // (it used to fade in from opacity 0 with a 100 % clip, ~80 ms of nothing, then land 10 px off). Nor is any of
        // the room's place empty: from the first frame its rows paint everything between the head and the toggle, and
        // its latest messages stay put while the top edge rises (a clip opening upward left the upper half empty for
        // ~50 ms while the latest messages already showed, then filled it bottom-up)
        const expandFrames = async () => {
          await mt.evaluate((card) => {
            const s = (window.__mtx = { frames: [], on: true, card });
            const btn = card.querySelector(".mt-toggle");
            const hls = card.querySelector(".mt-hls");
            s.top0 = btn.getBoundingClientRect().top;
            s.hlsH = hls ? hls.getBoundingClientRect().height : 0;
            const tick = () => {
              if (!s.on) return;
              const room = card.querySelector(".mt-room");
              const f = { top: btn.getBoundingClientRect().top, hls: !!card.querySelector(".mt-hls") };
              if (room) {
                const cs = getComputedStyle(room);
                const rr = room.getBoundingClientRect();
                const body = card.querySelector(".mt-body");
                const br = body.getBoundingClientRect();
                const inset = (/^inset\(([^)]*)\)/.exec(cs.clipPath)?.[1] ?? "").split(/\s+/).filter(Boolean);
                const px = (v, of) => (!v ? 0 : v.endsWith("%") ? (parseFloat(v) / 100) * of : parseFloat(v));
                const [it, , ib = it] = inset;
                // the room's painted part: its own clip, then the body's edge when the body cuts its overflow
                const cuts = getComputedStyle(body).overflowY !== "visible";
                const top = Math.max(rr.top + px(it, rr.height), cuts ? br.top : -Infinity);
                const bottom = Math.min(rr.bottom - px(ib, rr.height), cuts ? br.bottom : Infinity);
                f.op = Number(cs.opacity);
                f.visible = Math.round(bottom - top);
                f.ty = new DOMMatrix(cs.transform === "none" ? undefined : cs.transform).m42;
                // the room's place is the body; any of it above or below the painted part is an empty band
                f.empty = Math.round((Math.max(0, top - br.top) + Math.max(0, br.bottom - bottom)) * 10) / 10;
                f.last = room.lastElementChild?.getBoundingClientRect().top;
              }
              s.frames.push(f);
              requestAnimationFrame(tick);
            };
            requestAnimationFrame(tick);
          });
          await mt.locator(".mt-toggle").first().click();
          await sleep(1200);
          return page.evaluate(() => {
            const s = window.__mtx;
            s.on = false;
            const f = s.frames;
            const blank = f.filter((x) => !x.hls && !(x.op >= 0.99 && x.visible >= s.hlsH - 1)).length;
            const drift = Math.max(...f.map((x) => Math.abs(x.top - s.top0)));
            const shifted = Math.max(0, ...f.filter((x) => x.ty !== undefined).map((x) => Math.abs(x.ty)));
            const rf = f.filter((x) => x.op !== undefined);
            const emptyFrames = rf.filter((x) => x.empty > 0.5).length;
            const emptyMax = Math.max(0, ...rf.map((x) => x.empty));
            const rowsMoved = rf.length ? Math.round(Math.max(...rf.map((x) => Math.abs(x.last - rf[0].last))) * 10) / 10 : null;
            // and it lets go: no fixed height, no growing state, the thread's own scroll anchoring back
            const card = s.card;
            const body = card.querySelector(".mt-body");
            const settled = card.hasAttribute("data-open") && !!body && !body.style.height && !body.hasAttribute("data-growing") && !card.closest(".screen-scroll")?.style.overflowAnchor;
            return { frames: f.length, roomFrames: rf.length, hlsH: Math.round(s.hlsH), blank, drift: Math.round(drift * 10) / 10, shifted, emptyFrames, emptyMax, rowsMoved, settled, first: rf[0] ?? null };
          });
        };
        const mtx = await expandFrames();
        p.metrics.messengerExpand = mtx;
        p.check("picks: KakaoTalk 대화 펼치기 — no blank frame: the highlights' place shows the room from the first frame, fully opaque", mtx.roomFrames > 0 && mtx.blank === 0 && mtx.shifted <= 0.5, mtx);
        p.check("picks: KakaoTalk 대화 펼치기 — the toggle stays under the finger on every frame (≤ 1 px)", mtx.roomFrames > 0 && mtx.drift <= 1, mtx);
        p.check("picks: KakaoTalk 대화 펼치기 — no empty band in the room's place on any frame; its latest messages stay put and it settles", mtx.roomFrames > 0 && mtx.emptyFrames === 0 && mtx.rowsMoved <= 1 && mtx.settled, mtx);
        // again with the thread pinned at its end (the demo's case: the room is the latest reply). The thread follows
        // the latest when its content grows; that must not pull the room away from the finger
        await mt.locator(".mt-toggle").first().click(); // 접기
        await sleep(800);
        // make the room the thread's last turn for this measurement (the rows after it step out, then come back)
        const hidAfter = await mt.evaluate((card) => {
          const after = [];
          for (let n = card.closest(".msg-row")?.nextElementSibling; n; n = n.nextElementSibling) {
            if (!n.matches(".msg-row, .msg-sep, .msg-event")) continue;
            n.style.display = "none";
            after.push(n);
          }
          window.__mtHidden = after;
          return after.length;
        });
        await sleep(300);
        await page.locator(".screen-scroll").last().evaluate((el) => (el.scrollTop = el.scrollHeight));
        await sleep(600);
        const pinnedView = await mt.locator(".mt-toggle").first().evaluate((b) => {
          const r = b.getBoundingClientRect();
          const sc = b.closest(".screen-scroll");
          return { inView: r.top > 60 && r.bottom < innerHeight - 120, dist: Math.round(sc.scrollHeight - sc.scrollTop - sc.clientHeight) };
        });
        pinnedView.hidAfter = hidAfter;
        if (pinnedView.inView) {
          const mtp = await expandFrames();
          p.metrics.messengerExpandPinned = { ...mtp, dist: pinnedView.dist };
          p.check("picks: KakaoTalk 대화 펼치기 at the thread's end — the toggle stays under the finger, no blank frame, no empty band", mtp.roomFrames > 0 && mtp.drift <= 1 && mtp.blank === 0 && mtp.emptyFrames === 0 && mtp.rowsMoved <= 1 && mtp.settled, { ...mtp, dist: pinnedView.dist });
        } else {
          p.skip("KakaoTalk 대화 펼치기 at the thread's end", `the toggle is off screen at the end (${JSON.stringify(pinnedView)})`);
          await mt.locator(".mt-toggle").first().evaluate((e) => e.scrollIntoView({ block: "center" }));
          await sleep(400);
          await mt.locator(".mt-toggle").first().click(); // leave the room open for what follows
          await sleep(1200);
        }
        await page.evaluate(() => (window.__mtHidden || []).forEach((n) => (n.style.display = "")));
        await sleep(300);
        const myBubble = await mt.locator(".mt-bubble.is-me").first().evaluate((e) => getComputedStyle(e).backgroundColor).catch(() => null);
        const fill2 = await fill("var(--fill-2)");
        p.check("picks: KakaoTalk (A) — my bubble is one neutral value step (--fill-2), not a warm tint", myBubble === fill2, { myBubble, fill2 });
        await mt.locator(".mt-card .mt-bubble.is-me, .mt-bubble.is-me").first().evaluate((e) => e.scrollIntoView({ block: "center" }));
        await sleep(600);
        await snap("06-messenger-open");
        // credential (B)
        const cred = page.locator(".ccard-cred:not(.is-done)").first();
        await cred.evaluate((e) => e.scrollIntoView({ block: "center" }));
        await sleep(600);
        await snap("07-credential");
        const group = await cred.evaluate((card) =>
          [...card.querySelectorAll(".cred-group .tf")].map((tf) => {
            const l = tf.querySelector(".tf-label").getBoundingClientRect();
            const i = tf.querySelector(".tf-input").getBoundingClientRect();
            return { label: tf.querySelector(".tf-label").textContent.trim(), leads: l.right <= i.left + 0.5, sameRow: l.top + l.height / 2 > i.top && l.top + l.height / 2 < i.bottom };
          }),
        );
        p.check("picks: credential — one grouped field, each label leading its row", group.length === 2 && group.every((g) => g.leads && g.sameRow), group);
        const hint = (await cred.locator(".cred-group .tf-hint").allTextContents()).map((t) => t.replace(/\u00a0/g, " ")); // copy()'s nbsp ties
        p.check("picks: credential — the promise once, under the password, with the agent's name; the brand mark heads it", hint.length === 1 && hint[0] === `이 기기에서 암호화돼요. ${agentName}도 볼 수 없어요.` && (await cred.locator(".cred-foot, .cred-reason, .cred-lock").count()) === 0 && (await cred.locator(".ccard-head .brand-icon").count()) === 1, hint);
        await cred.getByRole("button", { name: /저장하고 이어서 하기/ }).click();
        await sleep(700);
        const invalid = await cred.evaluate((card) => [...card.querySelectorAll(".cred-group .tf")].map((tf) => ({ invalid: tf.classList.contains("is-invalid"), aria: tf.querySelector("input").getAttribute("aria-invalid"), error: tf.querySelector(".tf-error")?.textContent.trim() ?? null })));
        p.check("picks: credential — a missing value is that field's own error", invalid[0]?.invalid && invalid[0].aria === "true" && /입력해 주세요/.test(invalid[0].error || "") && !invalid[1]?.invalid, invalid);
        await snap("08-credential-missing");
        const keep0 = ((await cred.locator(".cred-keep-label").textContent()) || "").trim();
        await cred.locator(".cred-keep-change").click();
        await page.waitForSelector(".sheet-panel .list-row", { timeout: 6000 }).catch(() => {});
        await sleep(600);
        const options = await page.locator(".sheet-panel .list-row").count();
        await snap("09-credential-keep-menu");
        await page.locator(".sheet-panel .list-row", { hasText: "30일 동안" }).first().click();
        await sleep(700);
        const keep1 = ((await cred.locator(".cred-keep-label").textContent()) || "").trim();
        p.check("picks: credential — keep-for is a sentence (7일 default) changed from a menu that grows out of 바꾸기", keep0 === "7일 동안 보관해요" && options === 5 && keep1 === "30일 동안 보관해요", { keep0, options, keep1 });
        // top bar and the agent sheet: no trailing capsule; 친구 초대 lives in the sheet
        const right = await page.locator(".tb-right-slot").evaluate((e) => e.childElementCount).catch(() => -1);
        p.check("picks: no trailing top-bar capsule on the chat tab", right === 0, right);
        const glass = await page.evaluate(() =>
          [...document.querySelectorAll(".glass")]
            .filter((g) => {
              const r = g.getBoundingClientRect();
              const st = getComputedStyle(g);
              return r.width > 1 && r.height > 1 && r.bottom > 0 && r.top < innerHeight && st.visibility !== "hidden" && Number(st.opacity) > 0.05 && !g.closest(".sheet-root");
            })
            .map((g) => g.className.replace(/\s+/g, ".").slice(0, 60)),
        );
        p.metrics.picksGlass = glass;
        p.check("picks: glass is three shapes on the chat tab (menu, composer, tab bar)", glass.length === 3, glass);
        // composer: the call circle is a waveform and folds while there is something to send
        const call = page.locator(".composer-call");
        const call0 = await call.evaluate((e) => ({ w: e.getBoundingClientRect().width, glyph: e.querySelector("svg")?.innerHTML.length ?? 0 }));
        await composer(page).click();
        await composer(page).fill("내일 오전에 비 오면 우산 챙기라고 알려 줘");
        await sleep(800);
        const call1 = await call.evaluate((e) => ({ w: e.getBoundingClientRect().width, hidden: e.getAttribute("aria-hidden"), tab: e.tabIndex }));
        await snap("10-composer-typed");
        await composer(page).fill("");
        await sleep(800);
        const call2 = await call.evaluate((e) => ({ w: e.getBoundingClientRect().width, hidden: e.getAttribute("aria-hidden") }));
        p.check("picks: the composer's call circle folds away while there is something to send, and comes back", Math.abs(call0.w - 44) <= 0.5 && call1.w < 1 && call1.hidden === "true" && call1.tab === -1 && Math.abs(call2.w - 44) <= 0.5 && call2.hidden === null, { call0, call1, call2 });
        await composer(page).blur();
        const agentBtn = page.getByRole("button", { name: /프로필$/ }).first();
        if (await agentBtn.count()) {
          await agentBtn.click();
          await page.waitForSelector(".agent-sheet", { timeout: 6000 }).catch(() => {});
          await sleep(700);
          const invite = page.locator(".agent-sheet").getByRole("button", { name: "친구 초대" });
          p.check("picks: the agent sheet offers 친구 초대", (await invite.count()) === 1);
          if (await invite.count()) {
            await invite.click();
            await sleep(1200);
            const title = ((await page.locator(".sheet-panel").last().textContent().catch(() => "")) || "").slice(0, 40);
            p.check("picks: 친구 초대 opens the one invite sheet", /친구 초대/.test(title), title);
            await snap("11-invite-from-agent-sheet");
          }
          await page.keyboard.press("Escape");
          await sleep(700);
        } else p.check("picks: the agent sheet opens from the top bar", false);
        await release();
        await page.unroute(MSG_ROUTE, onMessages);
        await reloadSettled(page);
        await sleep(400);
      }
    }

    // ── toolfold (user request 2026-11-15, "가능한 더보기 눌러서 펼쳤을때 보이도록"): the read-only records a turn looked
    // up fold behind its one line ("자료 3개 보기 · 외교부 …"), the answer comes right after it, and cards that ask
    // something of the person stay open. Fixture thread + a scripted turn (no LLM).
    if (want("toolfold")) {
      p.step = "toolfold";
      const sess = await page.evaluate(async () => {
        const token = localStorage.getItem("pickle.token");
        const r = await fetch("/api/session", { headers: { authorization: `Bearer ${token}` } });
        return r.ok ? r.json() : null;
      });
      const mainId = sess?.mainThreadId ?? sess?.session?.mainThreadId ?? null;
      if (!mainId) p.check("toolfold: main thread id from the session", false);
      else {
        const items = foldThread(mainId);
        const onMessages = async (r) => {
          const req = r.request();
          const id = decodeURIComponent(new URL(req.url()).pathname.split("/")[3]);
          if (id === mainId && req.method() === "GET") return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(items) });
          return r.fallback();
        };
        const MSG_ROUTE = /\/api\/threads\/[^/]+\/messages(\?.*)?$/;
        await page.route(MSG_ROUTE, onMessages);
        await reloadSettled(page);
        await page.waitForSelector(".thread-content .tools-line", { timeout: 20_000 }).catch(() => {});
        await sleep(900);
        const reduced = variant === "reduced";
        /** every assistant turn: its line (words, state, height), where its records and its answer are */
        const turns = () =>
          page.evaluate(() => {
            const col = document.querySelector(".thread-content").getBoundingClientRect();
            return [...document.querySelectorAll(".thread-content > .msg-asst")].map((row) => {
              const line = row.querySelector(".asst > .tools-fold > .tools-line");
              const r = line?.getBoundingClientRect();
              const text = row.querySelector(".asst > .asst-text");
              const src = line?.querySelector(".tools-line-text > :not([aria-hidden]) .tools-line-src");
              const chev = line?.querySelector(".tools-line-chev")?.getBoundingClientRect().left ?? Infinity;
              const ends = [...(line?.querySelectorAll(".tools-line-text > :not([aria-hidden]) .tools-line-copy > *") ?? [])].map((c) => c.getBoundingClientRect().right);
              return {
                answer: (text?.textContent ?? "").slice(0, 14),
                line: line ? (line.querySelector(".tools-line-text > :not([aria-hidden])")?.textContent ?? "").replace(/\u00a0/g, " ").trim() : null,
                expanded: line?.getAttribute("aria-expanded") ?? null,
                face: !!row.querySelector(".asst > .turn-head .avatar, .asst > .tools-fold > .turn-head .avatar"),
                h: r ? Math.round(r.height * 10) / 10 : null,
                fits: r ? r.right <= col.right + 0.5 && r.left >= col.left - 0.5 && ends.every((x) => x <= chev + 0.5) : null,
                cut: src ? src.scrollWidth > src.clientWidth + 0.5 : null,
                records: row.querySelectorAll(".ccard-results, .ccard-weather, .mt-card").length,
                open: [...row.querySelectorAll(".asst > .ccard")].map((c) => c.className.split(" ")[1]),
                lineFirst: line && text ? !!(line.compareDocumentPosition(text) & Node.DOCUMENT_POSITION_FOLLOWING) : null,
              };
            });
          });
        const t0 = await turns();
        const research = t0.find((x) => x.answer.startsWith("일본은 지금"));
        const asks = t0.find((x) => x.answer.startsWith("보내기 전에"));
        const older = t0.find((x) => x.answer.startsWith("지난번에"));
        const made = t0.find((x) => x.answer.startsWith("제주 2박 3일 일정을"));
        const plain = t0.find((x) => x.answer.startsWith("천만에요"));
        p.check("toolfold: records are folded by default — the line says what came back, the cards are not there", !!research && research.expanded === "false" && research.records === 0 && /^자료 3개 보기 · 외교부 해외안전여행, 네이버 뉴스, 기상청$/.test(research.line ?? ""), research);
        p.check("toolfold: the folded line is one 44 pt row with the face, inside the column (the sources end in …)", !!research && research.h >= 44 && research.h <= 44.5 && research.face && research.fits && research.cut === true, research);
        p.check("toolfold: the answer comes right after the line", !!research && research.lineFirst === true, research);
        p.check("toolfold: an approval is never folded — it stays open under the answer", !!asks && asks.open.includes("ccard-approval") && asks.records === 0 && asks.expanded === "false" && /^1단계/.test(asks.line ?? ""), asks);
        p.check("toolfold: records without tool calls fold the same way (자료 1개 보기 · 정부24)", !!older && older.line === "자료 1개 보기 · 정부24" && older.records === 0 && older.face, older);
        p.check("toolfold: what the agent made (an artifact) is the answer — open under it, only the weather it looked up folds", !!made && made.open.includes("ccard-artifact") && made.records === 0 && made.line === "자료 1개 보기 · 기상청", made);
        p.check("toolfold: a turn with nothing to fold keeps the plain face head", !!plain && plain.line === null && plain.face, plain);
        const line = page.locator(".thread-content > .msg-asst", { hasText: "일본은 지금" }).locator(".tools-line");
        await line.evaluate((e) => e.scrollIntoView({ block: "center", behavior: "instant" }));
        await sleep(400);
        await p.shot("toolfold-collapsed");
        /** per frame from the tap: where the line is, how tall the panel is, and whether the answer is below it */
        const watch = () =>
          page.evaluate(() => {
            const row = [...document.querySelectorAll(".thread-content > .msg-asst")].find((r) => r.querySelector(".asst-text")?.textContent.startsWith("일본은 지금"));
            const s = (window.__fold = { frames: [], on: true });
            const tick = () => {
              if (!s.on) return;
              const l = row.querySelector(".tools-line").getBoundingClientRect();
              const panel = row.querySelector(".tools-panel");
              const text = row.querySelector(".asst-text").getBoundingClientRect();
              s.frames.push({ top: l.top, h: panel ? panel.getBoundingClientRect().height : 0, below: panel ? text.top >= panel.getBoundingClientRect().bottom - 0.5 : true });
              requestAnimationFrame(tick);
            };
            requestAnimationFrame(tick);
          });
        const stop = () =>
          page.evaluate(() => {
            const s = window.__fold;
            s.on = false;
            const f = s.frames;
            const top0 = f[0]?.top ?? 0;
            const full = Math.max(...f.map((x) => x.h));
            const firstFull = f.findIndex((x) => x.h >= full - 0.5);
            return { frames: f.length, drift: Math.round(Math.max(...f.map((x) => Math.abs(x.top - top0))) * 10) / 10, full: Math.round(full), between: f.filter((x) => x.h > 1 && x.h < full - 1).length, firstFull, overlap: f.filter((x) => !x.below).length };
          });
        await watch();
        await p.interact("toolfold-open", () => line.click());
        await sleep(1000);
        const opened = await stop();
        const inside = await page.evaluate(() => {
          const row = [...document.querySelectorAll(".thread-content > .msg-asst")].find((r) => r.querySelector(".asst-text")?.textContent.startsWith("일본은 지금"));
          const l = row.querySelector(".tools-line");
          const panel = row.querySelector(".tools-panel");
          return { expanded: l.getAttribute("aria-expanded"), controls: l.getAttribute("aria-controls") === panel?.id && !!panel?.id, role: panel?.getAttribute("role") ?? null, results: panel?.querySelectorAll(".ccard-results").length ?? 0, weather: panel?.querySelectorAll(".ccard-weather").length ?? 0, steps: panel?.querySelectorAll(".tools-step").length ?? 0, cap: panel?.querySelector(".tools-steps-cap")?.textContent.trim() ?? null, clip: panel ? getComputedStyle(panel).overflow : null };
        });
        p.metrics.toolfoldOpen = { opened, inside };
        p.check("toolfold: tapping the line opens the records and the steps in place (aria-expanded, aria-controls → the region)", inside.expanded === "true" && inside.controls && inside.role === "region" && inside.results === 2 && inside.weather === 1 && inside.steps === 3 && /^3단계 · /.test(inside.cap ?? ""), inside);
        p.check("toolfold: the line stays under the finger while the panel opens, and the answer moves down below it", opened.drift <= 1 && opened.overlap === 0 && opened.full > 300, opened);
        // (the sampling starts a few frames before the tap lands, so "at once" = no frame between closed and open)
        if (reduced) p.check("toolfold: reduced motion — the panel is open at once (no frame in between)", opened.firstFull > 0 && opened.between === 0, opened);
        else p.check("toolfold: the panel grows on the morph spring (its height moves over several frames, then stops clipping)", opened.between >= 4 && inside.clip === "visible", { ...opened, clip: inside.clip });
        await p.shot("toolfold-open");
        await watch();
        await p.interact("toolfold-close", () => line.click());
        await sleep(1000);
        const closed = await stop();
        const after = (await turns()).find((x) => x.answer.startsWith("일본은 지금"));
        p.check("toolfold: tapping it again folds them back (the line stays put)", after?.expanded === "false" && after.records === 0 && closed.drift <= 1, { closed, after });
        // keyboard: the line is a button — Enter opens, Space folds, the focus stays on it
        await line.focus();
        await page.keyboard.press("Enter");
        await sleep(reduced ? 200 : 900);
        const kOpen = await line.getAttribute("aria-expanded");
        await page.keyboard.press("Space");
        await sleep(reduced ? 200 : 900);
        const kClosed = await line.getAttribute("aria-expanded");
        const focused = await line.evaluate((e) => e === document.activeElement);
        p.check("toolfold: Enter opens, Space folds, focus stays on the line", kOpen === "true" && kClosed === "false" && focused, { kOpen, kClosed, focused });
        // web rows (user report 2026-11-15): a snippet goes under the source in at most two lines, the source keeps its
        // line, a short meta (a price) stays in the right column, and nothing leaves the card
        const webLine = page.locator(".thread-content > .msg-asst", { hasText: "웹에서 찾은 곳이에요" }).locator(".tools-line");
        await webLine.evaluate((e) => e.scrollIntoView({ block: "start", behavior: "instant" }));
        await webLine.click();
        await sleep(reduced ? 300 : 1100);
        const web = await page.evaluate(() => {
          const row = [...document.querySelectorAll(".thread-content > .msg-asst")].find((r) => r.querySelector(".asst-text")?.textContent.startsWith("웹에서 찾은"));
          const card = row?.querySelector(".tools-panel .ccard-results");
          if (!card) return null;
          const c = card.getBoundingClientRect();
          return {
            line: (row.querySelector(".tools-line-text > :not([aria-hidden])")?.textContent ?? "").replace(/\u00a0/g, " ").trim(),
            cardOverflow: card.scrollWidth - card.clientWidth,
            rows: [...card.querySelectorAll(".res-row")].map((r) => {
              const sub = r.querySelector(".res-sub");
              const snip = r.querySelector(".res-snippet");
              const lines = (e) => (e ? Math.round(e.getBoundingClientRect().height / parseFloat(getComputedStyle(e).lineHeight)) : 0);
              const right = Math.max(...[...r.querySelectorAll("*")].map((e) => e.getBoundingClientRect().right));
              const meta = r.querySelector(".res-meta");
              return { sub: sub?.textContent ?? null, subLines: lines(sub), subFits: sub ? sub.scrollWidth <= sub.clientWidth + 0.5 : null, snipLines: lines(snip), meta: meta?.textContent ?? null, metaFits: meta ? meta.scrollWidth <= meta.clientWidth + 0.5 : null, inside: right <= c.right + 0.5 };
            }),
          };
        });
        p.metrics.webRows = web;
        const [w1, w2, w3, w4, w5] = web?.rows ?? [];
        p.check("toolfold: web rows — the source stays on one line (not one letter a line), the snippet sits under it in at most two lines, the price stays on the right, nothing leaves the card", !!web && web.line === "자료 1개 보기 · 웹 검색" && web.cardOverflow <= 0 && web.rows.length === 5 && web.rows.every((x) => x.inside) && w1.subLines === 1 && w1.subFits && w1.meta === null && w1.snipLines >= 1 && w1.snipLines <= 2 && w2.subLines === 1 && w2.meta === null && w2.snipLines >= 1 && w2.snipLines <= 2 && w3.subLines === 1 && w3.meta === "¥14,800" && w3.snipLines === 0, web);
        p.check("toolfold: a news meta (domain · time) still fits the right column whole; a run of facts (31) goes under the address, which keeps its width", !!w4 && w4.meta === "yna.co.kr · 11/15 09:30" && w4.metaFits && w4.snipLines === 0 && !!w5 && w5.meta === null && w5.snipLines >= 1 && w5.snipLines <= 2 && w5.subLines <= 2 && w5.subFits, { w4, w5 });
        await page.evaluate(() => {
          const row = [...document.querySelectorAll(".thread-content > .msg-asst")].find((r) => r.querySelector(".asst-text")?.textContent.startsWith("웹에서 찾은"));
          row?.querySelector(".tools-panel .ccard-results")?.scrollIntoView({ block: "center", behavior: "instant" });
        });
        await sleep(300);
        await p.shot("toolfold-web-rows");
        await webLine.click();
        await sleep(reduced ? 300 : 900);
        const appr = page.locator(".thread-content .ccard-approval").first();
        await appr.evaluate((e) => e.scrollIntoView({ block: "center", behavior: "instant" }));
        await sleep(400);
        await p.shot("toolfold-approval");
        // ── the live turn: tools run, records arrive, then the answer streams — the line is one element throughout
        // and the answer stays on screen without scrolling up
        await page.evaluate(() => document.querySelector(".thread-content")?.closest(".screen-scroll")?.scrollTo({ top: 1e9 }));
        await installTurnScript(page);
        const LONG = "'마운자로 일본 오사카 약국 재고와 가격 비교' 웹 검색 결과 정리하기";
        await page.evaluate(
          ([answer, long, w, r1, r2]) => {
            const deltas = [];
            const sizes = [3, 2, 4, 3, 2];
            for (let i = 0, k = 0; i < answer.length; k++) {
              deltas.push(answer.slice(i, i + sizes[k % sizes.length]));
              i += sizes[k % sizes.length];
            }
            const toolA = { id: "tf-live-a", name: "k_weather", title: "오사카 날씨 확인" };
            const toolB = { id: "tf-live-b", name: "sys_web_search", title: long };
            const done = { id: "$mid", threadId: "$thread", role: "assistant", text: answer, cards: [w, r1, r2], tools: [{ ...toolA, state: "done", startedAt: Date.now(), endedAt: Date.now() + 1200 }, { ...toolB, state: "done", startedAt: Date.now(), endedAt: Date.now() + 2100 }], attachments: [] };
            window.__turnScript = [
              [250, { type: "tool", tool: { ...toolA, state: "running" } }],
              [700, { type: "tool", tool: { ...toolB, state: "running" } }],
              [900, { type: "tool", tool: { ...toolA, state: "done", summary: "맑음 14°" } }],
              [60, { type: "card", card: w }],
              [700, { type: "tool", tool: { ...toolB, state: "done", summary: "약국 5곳" } }],
              [60, { type: "card", card: r1 }],
              [60, { type: "card", card: r2 }],
              [400, { type: "text", delta: deltas[0] }],
              ...deltas.slice(1).map((d) => [55, { type: "text", delta: d }]),
              [300, { type: "done", message: done, quota: { usedPct: 1, usedTokens: 1000, limitTokens: 100000, resetsAt: Date.now() + 3600_000, resetHour: 4 } }],
            ];
            // per frame: the live turn's line (how many, the same node?, its words), records outside its panel, and
            // where the streamed answer is against the visible part of the thread (under the top bar, above the composer)
            const s = (window.__live = { frames: [], on: true, node: null, clickAt: 0 });
            const tick = () => {
              if (!s.on) return;
              const row = document.querySelector(".thread-content > .msg-live");
              if (row) {
                const lines = row.querySelectorAll(".tools-line");
                const l = lines[0] ?? null;
                if (l && !s.node) s.node = l;
                const text = row.querySelector(".asst > .asst-text");
                const top = document.querySelector(".topbar")?.getBoundingClientRect().bottom ?? 0;
                const bottom = document.querySelector(".composer")?.getBoundingClientRect().top ?? innerHeight;
                const col = document.querySelector(".thread-content").getBoundingClientRect();
                const tr = text?.getBoundingClientRect();
                const lr = l?.getBoundingClientRect();
                // the words end before the chevron's place (a long status ends in …, it does not run under it); the
                // chevron's own slide to its new place (layout="position", a transform) is not its place
                const shown = l?.querySelector(".tools-line-text > :not([aria-hidden]) .tools-line-copy");
                const words = shown ? [...shown.children].map((c) => c.getBoundingClientRect().right) : [];
                const chevEl = l?.querySelector(".tools-line-chev");
                const chev = chevEl ? chevEl.getBoundingClientRect().left - new DOMMatrix(getComputedStyle(chevEl).transform === "none" ? undefined : getComputedStyle(chevEl).transform).m41 : Infinity;
                s.frames.push({
                  t: performance.now(),
                  lines: lines.length,
                  same: !l || l === s.node,
                  words: l ? (l.querySelector(".tools-line-text > :not([aria-hidden])")?.textContent ?? "").replace(/\u00a0/g, " ").trim() : null,
                  state: l?.getAttribute("data-state") ?? null,
                  fits: lr ? lr.right <= col.right + 0.5 && words.every((r) => r <= chev + 0.5) : true,
                  records: [...row.querySelectorAll(".ccard-results, .ccard-weather")].filter((c) => !c.closest(".tools-panel")).length,
                  text: tr ? { len: text.textContent.length, top: tr.top, bottom: tr.bottom, visTop: top, visBottom: bottom } : null,
                  clicked: s.clickAt > 0,
                });
              }
              requestAnimationFrame(tick);
            };
            requestAnimationFrame(tick);
          },
          [FOLD_LIVE_ANSWER, LONG, foldWeather("오사카"), foldResults("우메다·난바 약국 재고", "네이버 블로그", 5), foldResults("간사이 공항 근처 약국", "구글 지도", 5)],
        );
        await composer(page).click();
        await composer(page).fill("오사카 날씨랑 마운자로 파는 약국 같이 찾아 줘");
        await page.keyboard.press("Enter");
        if (await page.waitForFunction(() => /외 1개/.test(document.querySelector(".msg-live .tools-line .tools-line-text > :not([aria-hidden])")?.textContent ?? ""), null, { timeout: 10_000 }).then(() => true).catch(() => false)) {
          await sleep(350); // past the content swap
          await p.shot("toolfold-running");
        }
        // halfway through the answer, open the line: it must still be open once the final message replaces the draft
        await page.waitForFunction(() => (document.querySelector(".msg-live .asst-text")?.textContent.length ?? 0) >= 60, null, { timeout: 20_000 }).catch(() => {});
        await p.shot("toolfold-streaming");
        await page.evaluate(() => (window.__live.clickAt = performance.now()));
        await page.locator(".msg-live .tools-line").click().catch(() => {});
        await waitIdle(page, 30_000).catch(() => {});
        const live = await page.evaluate(() => {
          const s = window.__live;
          s.on = false;
          const f = s.frames;
          const pre = f.filter((x) => !x.clicked);
          const withText = pre.filter((x) => x.text && x.text.len > 0);
          const words = [];
          for (const x of f) if (x.words && words[words.length - 1] !== x.words) words.push(x.words);
          const off = withText.filter((x) => !(x.text.bottom <= x.text.visBottom + 1 && x.text.bottom >= x.text.visTop + 20));
          const notWhole = withText.filter((x) => x.text.bottom - x.text.top < x.text.visBottom - x.text.visTop - 60 && x.text.top < x.text.visTop - 1);
          return {
            frames: f.length,
            textFrames: withText.length,
            maxLines: Math.max(0, ...f.map((x) => x.lines)),
            sameNode: f.every((x) => x.same),
            words,
            states: [...new Set(f.map((x) => x.state).filter(Boolean))],
            unfit: f.filter((x) => !x.fits).length,
            recordsOut: Math.max(0, ...pre.map((x) => x.records)),
            off: off.length,
            offSample: off.slice(0, 2).map((x) => x.text),
            notWhole: notWhole.length,
          };
        });
        p.metrics.toolfoldLive = live;
        p.check("toolfold: while tools run the line says so (one row: the status, \"외 1개\" when two run at once), then becomes the summary — the same element, never two", live.maxLines === 1 && live.sameNode && live.words.some((w) => w === "날씨 보는 중") && live.words.some((w) => /외 1개$/.test(w)) && /^자료 3개 보기 · 기상청, 네이버 블로그, 구글 지도$/.test(live.words[live.words.length - 1] ?? "") && live.states.includes("running") && live.states.includes("done"), live);
        p.check("toolfold: a long status ends in … inside the column", live.unfit === 0 && live.words.includes(LONG), { unfit: live.unfit });
        p.check("toolfold: while the answer streams its records stay folded and the answer is on screen (never pushed up past the top bar)", live.textFrames >= 20 && live.recordsOut === 0 && live.off === 0 && live.notWhole === 0, live);
        const kept = await page.evaluate(() => {
          const rows = [...document.querySelectorAll(".thread-content > .msg-asst")];
          const row = rows[rows.length - 1];
          const l = row?.querySelector(".tools-line");
          return { live: row?.classList.contains("msg-live") ?? null, expanded: l?.getAttribute("aria-expanded") ?? null, records: row?.querySelectorAll(".tools-panel .ccard").length ?? 0 };
        });
        p.check("toolfold: opened while streaming, it is still open on the final message (kept per message)", kept.live === false && kept.expanded === "true" && kept.records === 3, kept);
        await p.shot("toolfold-final-open");
        // a reload (or opening the thread again) starts folded
        const again = page.locator(".thread-content > .msg-asst", { hasText: "일본은 지금" }).locator(".tools-line");
        await again.evaluate((e) => e.scrollIntoView({ block: "center", behavior: "instant" }));
        await again.click();
        await sleep(reduced ? 200 : 900);
        const beforeReload = await again.getAttribute("aria-expanded");
        await reloadSettled(page);
        await page.waitForSelector(".thread-content .tools-line", { timeout: 20_000 }).catch(() => {});
        await sleep(600);
        const afterReload = (await turns()).find((x) => x.answer.startsWith("일본은 지금"));
        p.check("toolfold: a reload starts folded again", beforeReload === "true" && afterReload?.expanded === "false" && afterReload.records === 0, { beforeReload, afterReload });
        await page.unroute(MSG_ROUTE, onMessages);
        await reloadSettled(page);
        await sleep(400);
      }
    }

    // ── 20. meeting B (2026-11-12, user pick): the join card is the meeting — pending → on its way in → in it → over ──
    if (want("meetb")) {
      p.step = "meetb";
      const dir = path.join(outDir, "meetb");
      fs.mkdirSync(dir, { recursive: true });
      const snap = async (name) => {
        const file = path.join(dir, `${p.tag}-${name}.jpg`);
        await page.screenshot({ path: file, type: "jpeg", quality: 82, scale: "css" });
        p.shots.push(path.relative(repo, file));
        await appliedShot(page, p, "meetb", name);
      };
      const sess = await page.evaluate(async () => {
        const token = localStorage.getItem("pickle.token");
        const r = await fetch("/api/session", { headers: { authorization: `Bearer ${token}` } });
        return r.ok ? r.json() : null;
      });
      const mainId = sess?.mainThreadId ?? sess?.session?.mainThreadId ?? null;
      const agentName = sess?.agent?.name ?? "깽이";
      if (!mainId) p.check("meetb: main thread id from the session", false);
      else {
        const approvedAt = Date.now() - 48 * 60_000;
        const mode = { items: meetThread(mainId, agentName), meeting: null };
        const calls = { get: [], leave: [] };
        const onMessages = async (r) => {
          const req = r.request();
          const id = decodeURIComponent(new URL(req.url()).pathname.split("/")[3]);
          if (id !== mainId) return r.fallback();
          if (req.method() === "GET") return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(mode.items) });
          return r.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "qa_hold", message: "QA: not sent" }) });
        };
        const onMeet = async (r) => {
          const req = r.request();
          const u = new URL(req.url());
          if (req.method() === "POST" && u.pathname.endsWith("/meet/leave")) {
            calls.leave.push(decodeURIComponent(u.pathname.split("/")[3]));
            mode.meeting = meetView("left", agentName);
            return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, left: true, state: "ended" }) });
          }
          calls.get.push({ thread: decodeURIComponent(u.pathname.split("/")[3]), approval: u.searchParams.get("approval") });
          return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ meeting: mode.meeting }) });
        };
        const MSG_ROUTE = /\/api\/threads\/[^/]+\/messages(\?.*)?$/;
        const MEET_ROUTE = /\/api\/threads\/[^/]+\/meet(\/leave)?(\?.*)?$/;
        await page.route(MSG_ROUTE, onMessages);
        await page.route(MEET_ROUTE, onMeet);
        const card = page.locator(`.ccard-approval[data-approval-id="${MEET_APPROVAL}"]`);
        const open = async () => {
          await page.reload({ waitUntil: "load" });
          await card.waitFor({ timeout: 20_000 }).catch(() => {});
          await sleep(1400);
          await card.evaluate((e) => e.scrollIntoView({ block: "center" })).catch(() => {});
          await sleep(500);
        };
        const look = () =>
          card.evaluate((c) => {
            const state = c.querySelector(".meet-state");
            const leave = [...c.querySelectorAll("button")].find((b) => /회의에서 내보내기/.test(b.textContent));
            const inner = c.getBoundingClientRect().width - parseFloat(getComputedStyle(c).paddingLeft) - parseFloat(getComputedStyle(c).paddingRight);
            return {
              meta: c.querySelector(".appr-meta")?.textContent.replace(/\s+/g, " ").trim() ?? null,
              facts: c.querySelectorAll(".appr-facts, dl").length,
              what: !!c.querySelector(".appr-meet-what"),
              phase: c.querySelector(".meet-follow")?.dataset.phase ?? null,
              state: state?.textContent.trim() ?? null,
              face: state?.querySelectorAll(".avatar").length ?? 0,
              sub: [...c.querySelectorAll(".meet-state-sub")].map((e) => e.textContent.trim()),
              leaveW: leave ? Math.round(leave.getBoundingClientRect().width) : 0,
              leaveColor: leave ? getComputedStyle(leave).color : null,
              inner: Math.round(inner),
              foot: c.querySelector(".meet-approved")?.textContent.trim() ?? null,
              receipt: !!c.querySelector(".appr-receipt"),
              alert: c.querySelector(".meet-state")?.getAttribute("role") ?? null,
            };
          });
        const label = await page.evaluate(() => {
          const s = document.createElement("span");
          s.style.color = "var(--label)";
          document.body.appendChild(s);
          const c = getComputedStyle(s).color;
          s.remove();
          return c;
        });

        // pending: the meeting in one meta line, what the agent will do, 취소 / 참여 승인
        await open();
        await snap("01-pending");
        const l0 = await look();
        p.check("meetb: pending — one meta line 'Google Meet · rak-mnpq-kud' (the full code, the owner's card), no fact table", l0.meta === `Google Meet · ${MEET_CODE}` && l0.facts === 0 && l0.what, l0);
        p.check("meetb: pending — 참여 승인 and a neutral 취소, nothing followed yet", (await card.getByRole("button", { name: "참여 승인" }).count()) === 1 && (await card.getByRole("button", { name: "취소" }).count()) === 1 && l0.phase === null && calls.get.length === 0, { l0, gets: calls.get.length });

        // approved, on its way in
        mode.items = meetThread(mainId, agentName, { status: "approved", decidedAt: approvedAt });
        mode.meeting = meetView("joining", agentName);
        await open();
        const l1 = await look();
        p.check("meetb: the approved card asks for the meeting its approval started (GET …/meet?approval=)", calls.get.some((g) => g.thread === mainId && g.approval === MEET_APPROVAL), calls.get);
        p.check("meetb: on its way in — the agent's face, '회의에 들어가는 중이에요', the admission line, and already a way out", l1.phase === "joining" && l1.face === 1 && l1.state === "회의에 들어가는 중이에요" && /호스트가 수락하면/.test(l1.sub.join(" ")) && l1.leaveW > 0, l1);
        await snap("02-joining");

        // in the meeting: the draft's base state
        mode.meeting = meetView("live", agentName);
        await open();
        const l2 = await look();
        await snap("03-live");
        p.check("meetb: in the meeting — the face and '회의에 들어와 있어요', with how to call the agent by name", l2.phase === "live" && l2.face === 1 && l2.state === "회의에 들어와 있어요" && l2.sub.some((x) => x.includes(`'${agentName}야'라고 부르면 대답해요`)), l2);
        p.check("meetb: in the meeting — 회의에서 내보내기 is full width and neutral (the label colour, not a second blue)", Math.abs(l2.leaveW - l2.inner) <= 1 && l2.leaveColor === label, { leaveW: l2.leaveW, inner: l2.inner, color: l2.leaveColor, label });
        p.check("meetb: the approval is one footnote line at the card's foot, with its time", typeof l2.foot === "string" && l2.foot.includes("에 승인했어요") && !l2.receipt, l2.foot);

        // leave: the same card turns into the record in place
        const before = await card.elementHandle();
        await card.getByRole("button", { name: "회의에서 내보내기" }).click();
        await sleep(500);
        p.check("meetb: the first tap only asks", calls.leave.length === 0, calls.leave);
        await card.locator(".meet-leave").click();
        await until(() => calls.leave.length > 0, 5000);
        await sleep(1600);
        const same = await page.evaluate(([a, sel]) => a === document.querySelector(sel), [before, `.ccard-approval[data-approval-id="${MEET_APPROVAL}"]`]);
        const l3 = await look();
        await snap("04-left");
        p.check("meetb: confirming leaves through the meeting's own thread (POST …/:meetThread/meet/leave)", calls.leave.length === 1 && calls.leave[0] === MEET_THREAD, calls.leave);
        // the span in the iOS form: "오전 8:22 – 9:04 · 42분", 오전/오후 said again only when the range crosses noon
        const isoSpan = (x) => {
          const m = /(오[전후]) \d{1,2}:\d\d – (?:(오[전후]) )?\d{1,2}:\d\d · 42분/.exec(x);
          return !!m && m[2] !== m[1];
        };
        p.check("meetb: the same card becomes the record in place — '회의에서 나왔어요', the span and length, no plan, no footnote", same && l3.phase === "ended" && l3.state === "회의에서 나왔어요" && l3.sub.some((x) => /오[전후] \d+:\d\d – .*· 42분/.test(x)) && !l3.what && l3.foot === null && l3.leaveW === 0, { same, l3 });
        p.check("meetb: the span says 오전/오후 once (오전 8:22 – 9:04), twice only across noon", l3.sub.some(isoSpan), l3.sub);

        // over on its own, with the summary under it (plain text: a title, section heads, list rhythm) and the minutes row
        mode.items = meetThread(mainId, agentName, { status: "approved", decidedAt: approvedAt, summary: true });
        mode.meeting = meetView("ended", agentName);
        await open();
        const l4 = await look();
        p.check("meetb: a meeting that ended reads '회의가 끝나서 나왔어요 · … · 42분'", l4.phase === "ended" && l4.state === "회의가 끝나서 나왔어요" && l4.sub.some((x) => /· 42분$/.test(x)), l4);
        const sum = await page.evaluate(() => {
          const rows = [...document.querySelectorAll(".thread-content > .msg-asst")];
          const row = rows.find((r) => /회의 요약/.test(r.textContent));
          if (!row) return null;
          const h2 = row.querySelector(".md-h2");
          const h3 = [...row.querySelectorAll(".md-h3")];
          const art = row.querySelector(".ccard-artifact");
          const cs = (e) => getComputedStyle(e);
          return {
            h2: h2 ? { text: h2.textContent, size: parseFloat(cs(h2).fontSize), weight: cs(h2).fontWeight } : null,
            h3: h3.map((e) => ({ text: e.textContent, size: parseFloat(cs(e).fontSize), weight: cs(e).fontWeight, top: parseFloat(cs(e).marginTop) })),
            bubble: cs(row.querySelector(".asst-text")).backgroundColor,
            plate: art ? art.querySelectorAll(".art-plate").length : -1,
            glyph: art ? Math.round(art.querySelector(".art-glyph")?.getBoundingClientRect().width ?? 0) : 0,
          };
        });
        const summaryLink = page.locator(".thread-content > .msg-asst", { hasText: "회의 요약" }).first();
        await summaryLink.evaluate((e) => e.scrollIntoView({ block: "end" })).catch(() => {});
        await card.evaluate((e) => e.scrollIntoView({ block: "start" })).catch(() => {});
        await sleep(600);
        await snap("05-summary");
        p.check("meetb: the summary is plain text with a title (title2) and section heads (600, 16 above, 12 after the title)", !!sum && sum.h2?.text === "회의 요약" && sum.h2.size === 22 && sum.h3.length === 3 && sum.h3.every((h) => h.size === 17 && Number(h.weight) >= 600) && sum.h3[0].top === 12 && sum.h3.slice(1).every((h) => h.top === 16) && /rgba\(0, 0, 0, 0\)|transparent/.test(sum.bubble), sum);
        p.check("meetb: the minutes row has a text-size glyph, no plate", !!sum && sum.plate === 0 && sum.glyph > 0 && sum.glyph <= 18, sum);

        // the meeting never let it in
        mode.items = meetThread(mainId, agentName, { status: "approved", decidedAt: approvedAt });
        mode.meeting = meetView("failed", agentName);
        await open();
        const l5 = await look();
        await snap("06-failed");
        p.check("meetb: a refusal is the card's own line, in the danger colour, announced", l5.phase === "failed" && l5.state === "호스트가 참여 요청을 받아 주지 않았어요" && l5.alert === "alert", l5);

        // no meeting behind the card (an older server or card): the receipt, as before
        mode.meeting = null;
        await open();
        const l6 = await look();
        p.check("meetb: no meeting found → the plain receipt (승인했어요)", l6.phase === null && l6.receipt, l6);

        await page.unroute(MSG_ROUTE, onMessages);
        await page.unroute(MEET_ROUTE, onMeet);
        await page.reload({ waitUntil: "load" });
        await sleep(1200);
      }
    }
    // ── 21. a width change, then 새 메시지 from far up (snap-prefit-1): a thread of multi-line bubbles with a second
    //    friend, read up to the top at 390, the width goes to 430 (only the bubbles near the top are fitted again), the
    //    friend writes, the capsule is tapped. The list reaches the end (WebKit stopped 1.5 screens short when a fit ran
    //    during the glide) and no bubble is drawn at its old width first (the observer fitted them a frame late). Last
    //    in the pass: the second friend's thread would join the drawer's shots. Light and reduced only (dark draws the
    //    same widths and scroll) ──
    if (want("jumpfit") && variant !== "dark") {
      p.step = "jumpfit";
      const myToken = await page.evaluate(() => localStorage.getItem("pickle.token"));
      const other = await signupApi(`qj${rand()}`, "서연", "토리");
      await quietBriefing(other.token);
      const inv = await api("POST", "/api/invites", {}, other.token);
      const code = inv.body.token ?? String(inv.body.url || "").split("invite=")[1];
      const acc = await api("POST", `/api/invites/${encodeURIComponent(code)}/accept`, {}, myToken);
      const list = await api("GET", "/api/threads", undefined, other.token);
      const th = (list.body.items ?? list.body).find((t) => t.kind === "friend");
      p.check("jumpfit: a second friend thread", acc.status < 300 && !!th, acc.status);
      if (th) {
        for (const text of JUMP_TEXTS) {
          for (const token of [myToken, other.token]) await api("POST", `/api/threads/${th.id}/messages`, { text }, token);
          await sleep(20);
        }
        await page.waitForSelector(".banner-anchor .banner-content", { state: "detached", timeout: 10_000 }).catch(() => {});
        await page.getByRole("button", { name: "메뉴" }).click();
        await page.waitForSelector(".dw");
        await sleep(600);
        await page.locator(".dw-row").filter({ hasText: "서연" }).first().click();
        await page.waitForFunction((n) => document.querySelectorAll(".thread-content[data-thread-kind=friend] .bubble-text").length >= n, JUMP_TEXTS.length * 2, { timeout: 15_000 }).catch(() => {});
        await sleep(900);
        const sc = page.locator(".thread-content[data-thread-kind=friend]").locator("xpath=ancestor::*[contains(@class,'screen-scroll')][1]");
        // up to the top half a screen at a time, as a reader would
        await sc.evaluate(async (el) => {
          for (let i = 0; i < 60 && el.scrollTop > 0; i++) {
            el.scrollTop -= el.clientHeight / 2;
            await new Promise((r) => setTimeout(r, 120));
          }
        });
        await sleep(400);
        await page.setViewportSize({ width: 430, height: 844 });
        await sleep(900);
        const far = await sc.evaluate((el) => (el.scrollHeight - el.scrollTop - el.clientHeight) / el.clientHeight);
        await api("POST", `/api/threads/${th.id}/messages`, { text: "방금 보낸 일정 확인하고 답 줘" }, other.token);
        const jump = await page.waitForSelector(".jump-latest", { timeout: 8000 }).then(() => true).catch(() => false);
        p.check("jumpfit: 새 메시지 shows far up after the width change", jump && far > 3, `${far.toFixed(1)} screens up`);
        if (jump) {
          // each bubble's width in the frame it first comes into view, against its width once settled; watched until
          // the scroll has stood still for 300 ms (at most 8 s), so a slow glide is followed to its end. The bubbles
          // between the start and the end that no frame showed (a glide passes them between two frames) are counted
          // apart: the check says nothing about them. The watch ends either way, but only the stand-still passes: an 8 s
          // time-out (a scroll that never moved or never settled) fails the check
          await sc.evaluate((el) => {
            const w = (window.__jumpWatch = { seen: new Map(), from: el.scrollTop, top: el.scrollTop, moved: false, still: false, timedOut: false, ms: 0 });
            const t0 = performance.now();
            let top = el.scrollTop;
            let at = t0;
            const tick = (now) => {
              const v = el.getBoundingClientRect();
              for (const b of el.querySelectorAll(".thread-content[data-thread-kind=friend] .bubble")) {
                if (w.seen.has(b)) continue;
                const r = b.getBoundingClientRect();
                if (r.bottom > v.top && r.top < v.bottom) w.seen.set(b, b.offsetWidth);
              }
              if (el.scrollTop !== top) (top = el.scrollTop), (at = now), (w.moved = true);
              w.top = top;
              w.ms = Math.round(now - t0);
              if (w.moved && now - at >= 300) w.still = true;
              else if (now - t0 >= 8000) w.timedOut = true;
              else requestAnimationFrame(tick);
            };
            requestAnimationFrame(tick);
          });
          await p.interact("jumpfit-latest", () => page.locator(".jump-latest").click());
          await page.mouse.move(1, 1);
          await page.waitForFunction(() => window.__jumpWatch.still || window.__jumpWatch.timedOut, null, { timeout: 10_000 }).catch(() => {});
          await sleep(300);
          const end = await sc.evaluate((el) => Math.round(el.scrollHeight - el.scrollTop - el.clientHeight));
          p.check("jumpfit: the capsule reaches the end after a width change", end < 2, `${end} px short`);
          const watch = await sc.evaluate((el) => {
            const w = window.__jumpWatch;
            const drawn = [...w.seen].filter(([b, x]) => b.isConnected && Math.abs(b.offsetWidth - x) > 0.5).map(([b, x]) => `${x}→${b.offsetWidth}`);
            // the glide's path: from the top of the view it started in to the bottom of the view it ended in
            const base = el.getBoundingClientRect().top - el.scrollTop;
            const lo = w.from;
            const hi = el.scrollTop + el.clientHeight;
            const path = [...el.querySelectorAll(".thread-content[data-thread-kind=friend] .bubble")].filter((b) => {
              const r = b.getBoundingClientRect();
              return r.bottom - base > lo && r.top - base < hi;
            });
            // the scroll stood still after the watch ended (a glide that paused and went on would have left frames unwatched)
            const after = Math.round(el.scrollTop - w.top);
            return { drawn, seen: w.seen.size, path: path.length, unseen: path.filter((b) => !w.seen.has(b)).length, ms: w.ms, still: w.still, timedOut: w.timedOut, after };
          });
          const ended = watch.still ? "stood still 300 ms" : watch.timedOut ? "timed out at 8 s" : "not ended";
          p.check(
            "jumpfit: no bubble drawn at its old width, then cut",
            watch.drawn.length === 0 && watch.still && watch.after === 0,
            `${watch.drawn.length}/${watch.seen} · on the way ${watch.path}, never in view ${watch.unseen} · watched ${watch.ms} ms (${ended}), moved after ${watch.after} px ${watch.drawn.join(" ")}`,
          );
        }
        await page.setViewportSize({ width: 390, height: 844 });
        await sleep(500);
        await page.getByRole("button", { name: "뒤로" }).click().catch(() => {});
        await sleep(600);
      }
    }
  } catch (e) {
    p.check(`pass aborted at ${p.step}`, false, String(e.message || e).slice(0, 300));
    await p.shot(`aborted-${p.step}`).catch(() => {});
  }

  // ── metrics ──
  const q = await page.evaluate(() => ({ long: window.__qa.long, windows: window.__qa.windows, ac: window.__qa.ac })).catch(() => ({ long: [], windows: [], ac: [] }));
  p.metrics.audioContexts = q.ac;
  const inWindows = q.long.filter((l) => l.dur > 50 && q.windows.some((w) => l.start < (w.end || Infinity) + 50 && l.start + l.dur > w.start));
  p.metrics.longTasksInInteractions = inWindows.map((l) => ({ dur: Math.round(l.dur), at: q.windows.find((w) => l.start < (w.end || Infinity) + 50 && l.start + l.dur > w.start)?.name }));
  if (isChrome) p.check("no long task > 50 ms during interactions", inWindows.length === 0, p.metrics.longTasksInInteractions);
  p.check("0 console errors", p.errors.length === 0, p.errors.slice(0, 5));
  p.check("0 horizontal overflow", p.overflows.length === 0, p.overflows.slice(0, 3));
  await browser.close();
  return { tag: p.tag, handle, checks: p.checks, skipped: p.skipped, metrics: p.metrics, errors: p.errors, expectedNetworkErrors: p.expected.length, overflows: p.overflows, shots: p.shots };
}

async function main() {
  const preview = await startPreview();
  const results = [];
  try {
    for (const engine of ENGINES) {
      const type = engine === "webkit" ? webkit : chromium;
      for (const variant of VARIANTS) {
        console.log(`\n▶ ${engine} ${variant}`);
        // the friend: a second real account made through the API, with an invite link for this pass
        const fh = `qaf${rand()}`;
        const f = await signupApi(fh, "진우", "콩이");
        await quietBriefing(f.token);
        const inv = await api("POST", "/api/invites", {}, f.token);
        const invite = inv.body.token ?? String(inv.body.url || "").split("invite=")[1];
        results.push(await runPass(type, engine, variant, { handle: fh, token: f.token, invite }));
      }
    }
  } finally {
    preview?.stopAll();
  }
  const summary = results.map((r) => ({ tag: r.tag, passed: r.checks.filter((c) => c.ok).length, failed: r.checks.filter((c) => !c.ok).map((c) => c.name), skipped: (r.skipped || []).map((x) => x.name) }));
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
  fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify({ at: new Date().toISOString(), api: API, summary: allSummary, results: all }, null, 2));
  console.log("\n" + summary.map((s) => `${s.tag}: ${s.passed} ok, ${s.failed.length} failed${s.failed.length ? ` (${s.failed.join("; ")})` : ""}${s.skipped.length ? `, ${s.skipped.length} skipped (${s.skipped.join("; ")})` : ""}`).join("\n"));
  process.exit(summary.some((s) => s.failed.length) ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
