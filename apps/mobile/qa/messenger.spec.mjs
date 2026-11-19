// Messenger card QA (kakao-chat): the msg_read card as a reconstructed chat room. Fully synthetic — its own server
// (apps/mobile/qa/messenger-server.ts: the real app server, a fake KakaoTalk SDK serving the fixture room, a
// deterministic stand-in for the LLM), its own throwaway data dir and account. Never touches :8787 / :5173.
//   node apps/mobile/qa/messenger.spec.mjs                       (tag "after": new card, both engines, light + dark)
//   QA_TAG=before QA_LEGACY=1 node apps/mobile/qa/messenger.spec.mjs   (old card output, whatever card the build has)
//   QA_TAG=after-legacy QA_LEGACY=1 node …                       (an old stored card rendered by the new component)
// Env: QA_ENGINES=chromium,webkit · QA_VARIANTS=light,dark · QA_API_PORT (8806) · QA_PORT (5196) · QA_BUILD=0
// Browsers: installed Chrome (channel "chrome") + Playwright's cached WebKit. Never runs `playwright install`.
// Screenshots: docs/qa/messenger/<tag>-<engine>-<variant>-<step>.png · results: docs/qa/messenger/<tag>-results.json
import { chromium, webkit } from "playwright";
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, "..");
const repo = path.resolve(appDir, "../..");
const outDir = path.join(repo, "docs/qa/messenger");
fs.mkdirSync(outDir, { recursive: true });
const TAG = process.env.QA_TAG || "after";
const LEGACY = process.env.QA_LEGACY === "1";
const API_PORT = Number(process.env.QA_API_PORT || 8806);
const PORT = Number(process.env.QA_PORT || 5196);
if ([8787, 5173].includes(API_PORT) || [8787, 5173].includes(PORT)) throw new Error("8787/5173 are the real preview — pick other ports");
const API = `http://127.0.0.1:${API_PORT}`;
const BASE = `http://127.0.0.1:${PORT}`;
const DIST = path.join(os.tmpdir(), `pickle-messenger-qa-dist-${PORT}`); // per port: parallel runs never share a build
const ENGINES = (process.env.QA_ENGINES || "chromium,webkit").split(",");
const VARIANTS = (process.env.QA_VARIANTS || "light,dark").split(",");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const own = []; // processes this run started (killed by pid group only)

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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pickle-msgqa-"));
  const log = fs.openSync(path.join(dataDir, "server.log"), "w");
  const proc = startGroup("bun", ["run", "apps/mobile/qa/messenger-server.ts"], {
    cwd: repo,
    stdio: ["ignore", log, log],
    env: { ...process.env, PICKLE_DATA_DIR: dataDir, PORT: String(API_PORT), QA_LEGACY: LEGACY ? "1" : "0" },
  });
  for (let i = 0; i < 100; i++) {
    if (await up(`${API}/api/health`)) return { proc, dataDir };
    await sleep(150);
  }
  throw new Error("messenger QA server did not start: " + fs.readFileSync(path.join(dataDir, "server.log"), "utf8").slice(-800));
}

async function startPreview() {
  if (process.env.QA_BUILD !== "0" || !fs.existsSync(path.join(DIST, "index.html"))) {
    const b = spawnSync("bunx", ["vite", "build", "-c", "qa/vite.qa.config.mjs", "--outDir", DIST, "--emptyOutDir"], { cwd: appDir, stdio: "pipe", encoding: "utf8" });
    if (b.status !== 0) throw new Error(`build failed:\n${b.stdout}\n${b.stderr}`);
  }
  if (await up(`${BASE}/`)) throw new Error(`port ${PORT} is already serving something; set QA_PORT`);
  const proc = startGroup("bunx", ["vite", "preview", "--outDir", DIST, "--port", String(PORT), "--strictPort", "--host", "127.0.0.1"], {
    cwd: appDir,
    stdio: "ignore",
    env: { ...process.env, PICKLE_API: API },
  });
  for (let i = 0; i < 100; i++) {
    if (await up(`${BASE}/`)) {
      // the port must be serving THIS build (a strictPort race could leave another team's preview answering)
      const served = await (await fetch(`${BASE}/`)).text();
      if (served !== fs.readFileSync(path.join(DIST, "index.html"), "utf8")) throw new Error(`port ${PORT} is serving a different build`);
      return proc;
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

/** a throwaway account (briefing off: one made in the 07:30–09:30 KST window would get a briefing turn) */
async function signup(displayName, agentName) {
  const kp = await crypto.webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const jwk = await crypto.webcrypto.subtle.exportKey("jwk", kp.publicKey);
  const handle = `qa${crypto.randomBytes(4).toString("hex")}`;
  const su = await api("POST", "/api/auth/signup", { handle, password: "qa-pass-1234", displayName, agentName, device: { id: `qa-${handle}`, label: "QA", signingKey: jwk } });
  if (su.status !== 201 && su.status !== 200) throw new Error(`signup ${su.status}`);
  const off = await api("PATCH", "/api/settings", { notifications: { briefing: false } }, su.body.token);
  if (off.status !== 200) throw new Error(`briefing off: ${off.status}`);
  return { token: su.body.token, userId: su.body.session.user.id };
}

/** a synthetic photo (a sky gradient and a sun), PNG-encoded here: no fixture file, nobody's picture */
function syntheticPhoto(w = 480, h = 320) {
  const row = 1 + w * 3;
  const px = Buffer.alloc(row * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const t = y / h;
      const d = Math.hypot(x - w * 0.68, y - h * 0.62);
      const sun = d < 46 ? 1 : d < 60 ? (60 - d) / 14 : 0;
      const o = y * row + 1 + x * 3;
      px[o] = Math.min(255, 70 + 170 * t + 60 * sun);
      px[o + 1] = Math.min(255, 110 + 60 * t + 120 * sun);
      px[o + 2] = Math.min(255, 200 - 90 * t + 20 * sun);
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // 8-bit
  ihdr[9] = 2; // RGB
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(px)), chunk("IEND", Buffer.alloc(0))]);
}

/** the friend's photo, uploaded into the friend thread through the real route */
async function uploadPhoto(token, threadId) {
  const form = new FormData();
  form.set("file", new Blob([syntheticPhoto()], { type: "image/png" }), "노을.png");
  form.set("threadId", threadId);
  const res = await fetch(API + "/api/attachments", { method: "POST", headers: { authorization: `Bearer ${token}` }, body: form });
  return { status: res.status, body: await res.json() };
}

/** a throwaway account with the fake KakaoTalk connected through the real connect route */
async function account() {
  const { token, userId } = await signup("지우", "모시");
  const c = await api("POST", "/qa/connect-kakao", { userId }, token);
  if (c.status !== 200 || c.body?.connection?.status !== "connected") throw new Error(`connect ${c.status}`);
  return token;
}

const results = { tag: TAG, legacy: LEGACY, passes: [] };

async function runPass(engine, variant) {
  const browserType = engine === "chromium" ? chromium : webkit;
  const browser = await browserType.launch(engine === "chromium" ? { channel: "chrome", args: ["--use-fake-device-for-media-stream"] } : {});
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    colorScheme: variant === "dark" ? "dark" : "light",
    locale: "ko-KR",
    timezoneId: "Asia/Seoul",
  });
  const token = await account();
  // the top page only: an html card's sandboxed frame has no storage, and the script would throw there (a pageerror)
  await context.addInitScript((tk) => {
    if (window.top === window) localStorage.setItem("pickle.token", tk);
  }, token);
  const page = await context.newPage();
  const pass = { engine, variant, checks: [], errors: [], shots: [] };
  const check = (name, ok, detail = "") => pass.checks.push({ name, ok: !!ok, detail: String(detail) });
  page.on("console", (m) => m.type() === "error" && pass.errors.push(m.text().slice(0, 200)));
  page.on("pageerror", (e) => pass.errors.push(`pageerror: ${e.message.slice(0, 200)}`));
  const artifactGets = [];
  page.on("response", (r) => /\/api\/artifacts\/[^/?]+$/.test(new URL(r.url()).pathname) && artifactGets.push(r.status()));
  const photoGets = [];
  page.on("response", (r) => /\/api\/attachments\/[^/?]+\/raw$/.test(new URL(r.url()).pathname) && photoGets.push(r.status()));
  const shot = async (step, target) => {
    const file = path.join(outDir, `${TAG}-${engine}-${variant}-${step}.png`);
    if (target) await target.screenshot({ path: file, animations: "disabled" });
    else await page.screenshot({ path: file });
    pass.shots.push(path.relative(repo, file));
  };
  const noOverflow = async (step) => {
    const o = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth - window.innerWidth, cards: [...document.querySelectorAll(".ccard")].map((c) => c.scrollWidth - c.clientWidth) }));
    check(`${step}: no horizontal overflow`, o.doc <= 0 && o.cards.every((x) => x <= 0), JSON.stringify(o));
  };

  try {
    await page.goto(BASE, { waitUntil: "networkidle" });
    const box = page.getByRole("textbox", { name: "메시지" });
    await box.waitFor({ timeout: 20_000 });
    await box.click();
    await box.fill("공연팀 카톡방에서 나한테 온 거 있어?");
    await page.keyboard.press("Enter");
    // a room it read is a record: it folds behind the turn's line ("자료 1개 보기 · 카카오톡", chat toolfold). Builds from
    // before the fold show the card itself: whichever comes first decides
    const cardSel = LEGACY && TAG === "before" ? ".ccard-msg" : ".ccard-msg, .mt-card";
    const seen = await page
      .waitForFunction(
        (sel) => {
          if (document.querySelector(sel)) return "card";
          const line = [...document.querySelectorAll(".thread-content > .msg-asst:not(.msg-live) .tools-line[aria-expanded='false']")].pop();
          return line && /자료 \d+개 보기/.test(line.textContent) ? "fold" : false;
        },
        cardSel,
        { timeout: 30_000 },
      )
      .then((h) => h.jsonValue())
      .catch(() => "");
    const folded = seen === "fold";
    if (folded) {
      await page.locator(".thread-content > .msg-asst:not(.msg-live) .tools-line[aria-expanded='false']").last().click();
      await sleep(900);
    }
    const card = page.locator(cardSel).last();
    await card.waitFor({ timeout: 30_000 });
    await page.locator(".msg-asst .asst-text").last().waitFor({ timeout: 15_000 }).catch(() => {});
    await sleep(900);
    // opened from the fold, the card hangs below the line and can end under the glass composer, which
    // scrollIntoViewIfNeeded counts as visible: centre it, so its toggle is where a person can tap it
    if (folded) await card.evaluate((el) => el.scrollIntoView({ block: "center" }));
    else await card.scrollIntoViewIfNeeded();
    await sleep(300);
    check("the room opens from the turn's line (folded record)", folded || (LEGACY && TAG === "before"), seen || "neither line nor card");
    await shot("collapsed");
    await shot("card-collapsed", card);
    await noOverflow("collapsed");
    const isNew = (await page.locator(".mt-card").count()) > 0;
    const text = await card.innerText();
    if (isNew) {
      check("no raw JSON in the card", !/feedType|\{"|":/.test(text), text.slice(0, 120));
      check("no raw ids in the card", !/\d{12,}/.test(text));
      check("no host-hidden message", !text.includes("무료 이벤트"));
      const hls = await card.locator(".mt-hls > li").count();
      check("collapsed shows 1–3 highlights only", hls >= 1 && hls <= 3, hls);
      check("collapsed hides the room", (await card.locator(".mt-list").count()) === 0);
      const narrow = await card.evaluate((el) =>
        [...el.querySelectorAll(".mt-text")].filter((t) => t.textContent.length > 20).map((t) => Math.round(t.getBoundingClientRect().width)),
      );
      check("long texts get a real column (≥ 160 px)", narrow.every((w) => w >= 160), narrow.join(","));
      const toggle = card.getByRole("button", { name: "대화 펼치기" });
      check("toggle aria-expanded=false", (await toggle.getAttribute("aria-expanded")) === "false");
      const controls = await toggle.getAttribute("aria-controls");
      check("aria-controls points at the body", controls && (await page.locator(`[id="${controls}"]`).count()) === 1, controls);
      const tb = await toggle.boundingBox();
      check("toggle ≥ 44 px tall", tb && tb.height >= 44, tb?.height);

      // expand: the toggle stays under the finger, the room grows upward. Measure only once the thread has stopped
      // moving (the chat's own smooth seek to the latest can still be running; a real tap cancels it, a mouse click doesn't)
      let before = (await toggle.boundingBox()).y;
      for (let still = 0, i = 0; still < 3 && i < 40; i++) {
        await sleep(150);
        const y = (await toggle.boundingBox()).y;
        still = Math.abs(y - before) < 0.5 ? still + 1 : 0;
        before = y;
      }
      await toggle.click();
      await sleep(80);
      await shot("expanding-80ms");
      await sleep(900);
      const t2 = card.getByRole("button", { name: "접기" });
      const after = (await t2.boundingBox()).y;
      check("expand keeps the toggle in place (±4 px)", Math.abs(after - before) <= 4, `${before.toFixed(1)} → ${after.toFixed(1)}`);
      check("toggle aria-expanded=true", (await t2.getAttribute("aria-expanded")) === "true");
      const items = await card.locator("ol.mt-list > li").count();
      check("room is a list", items >= (LEGACY ? 10 : 16), items);
      const spoken = await card.locator("ol.mt-list .sr-only").first().innerText();
      check("each bubble reads sender + time", /, 오후 \d+:\d\d/.test(spoken), spoken);
      await shot("expanded");
      await noOverflow("expanded");
      // scroll to the top of the card for the room's beginning
      await card.evaluate((el) => el.scrollIntoView({ block: "start" }));
      await sleep(250);
      await shot("expanded-top");
      // the whole room in one picture: grow the viewport to the card (the card lives in an inner scroller)
      const ch = Math.ceil((await card.boundingBox()).height);
      await page.setViewportSize({ width: 390, height: Math.min(6000, ch + 420) });
      await sleep(400);
      await card.evaluate((el) => el.scrollIntoView({ block: "center" }));
      await sleep(300);
      await shot("card-expanded", card);
      await page.setViewportSize({ width: 390, height: 844 });
      await sleep(400);
      const narrow2 = await card.evaluate((el) =>
        [...el.querySelectorAll(".mt-text")].filter((t) => t.textContent.length > 20).map((t) => Math.round(t.getBoundingClientRect().width)),
      );
      check("expanded long texts ≥ 160 px wide", narrow2.every((w) => w >= 160), narrow2.join(","));

      // collapse is a return: the highlights are complete on the first frame
      await t2.scrollIntoViewIfNeeded();
      const frames = await page.evaluate(
        () =>
          new Promise((resolve) => {
            const btn = [...document.querySelectorAll(".mt-card .mt-toggle")].pop();
            const out = [];
            btn.click();
            let n = 0;
            const tick = () => {
              const hl = [...document.querySelectorAll(".mt-card .mt-hls")].pop();
              const r = hl?.getBoundingClientRect();
              out.push(hl ? { h: Math.round(r.height), o: Number(getComputedStyle(hl).opacity) } : null);
              if (++n < 20) requestAnimationFrame(tick);
              else resolve(out);
            };
            requestAnimationFrame(tick);
          }),
      );
      check("collapse: highlights complete from the first frame", frames.every((f) => f && f.h > 0 && f.o === 1), JSON.stringify(frames.slice(0, 3)));
      await sleep(400);
      await shot("collapsed-again");
    }

    // ── the friend sends a photo, and their 모시 answers with an html card in the friend thread: both are the friend's
    //    (an attachment, an artifact), and both load here (GET /api/attachments/:id/raw and /api/artifacts/:id 200 for a
    //    member of that thread; both were 404 before, screens-chat 11-17) ──
    if (!LEGACY) {
      const friend = await signup("진우", "콩이");
      const inv = await api("POST", "/api/invites", undefined, token);
      const acc = await api("POST", `/api/invites/${inv.body.token}/accept`, undefined, friend.token);
      if (acc.status !== 201 || !acc.body.threadId) throw new Error(`friend accept ${acc.status}`);
      const up = await uploadPhoto(friend.token, acc.body.threadId);
      const sent = await api("POST", `/api/threads/${acc.body.threadId}/messages`, { text: "어제 본 노을이에요", attachmentIds: [up.body?.id] }, friend.token);
      check("friend step: the friend sent a photo (server)", up.status === 201 && sent.status === 201, `${up.status} ${sent.status}`);
      const ask = await api("POST", `/api/threads/${acc.body.threadId}/messages`, { text: "@콩이 강남역 저녁 카드로 보여 줘" }, friend.token);
      check("friend step: the friend's 모시 answered with an html card (server)", ask.status === 200 && /"type":"artifact"/.test(String(ask.body)), ask.status);
      // a fresh load (no banner over 메뉴), then the friend thread from the drawer
      await page.goto(BASE, { waitUntil: "networkidle" });
      await page.getByRole("button", { name: "메뉴" }).click();
      await page.waitForSelector(".dw");
      await sleep(500);
      await page.locator(".dw-row").filter({ hasText: "진우" }).first().click();
      const hart = page.locator(".msg-other[data-author=peer-agent] .hart").last();
      await hart.waitFor({ timeout: 15_000 });
      await page.waitForFunction(() => [...document.querySelectorAll(".msg-other[data-author=peer-agent] .hart")].pop()?.dataset.state !== "loading", null, { timeout: 15_000 }).catch(() => {});
      await sleep(600);
      const state = await hart.getAttribute("data-state");
      const inFrame = await page.frameLocator(".msg-other[data-author=peer-agent] .hart iframe").last().locator("body").innerText({ timeout: 5000 }).catch(() => "");
      check("friend thread: the friend's 모시 html card loads (GET /api/artifacts/:id 200, never 404) and shows its content", state === "ready" && artifactGets.length > 0 && artifactGets.every((s) => s === 200) && /세 곳을 골랐어요/.test(inFrame), JSON.stringify({ state, gets: artifactGets, frame: inFrame.slice(0, 40) }));
      await hart.scrollIntoViewIfNeeded();
      await sleep(300);
      await shot("friend-card");
      // the photo sits above the card; it loads lazily, once it is on screen
      const photo = page.locator(".msg-other[data-author=peer] .bubble-img").last();
      await photo.evaluate((el) => el.scrollIntoView({ block: "center" }));
      await page.waitForFunction(() => { const i = [...document.querySelectorAll(".msg-other[data-author=peer] .bubble-img")].pop(); return i && i.complete; }, null, { timeout: 15_000 }).catch(() => {});
      await sleep(400);
      const img = await photo.evaluate((i) => ({ complete: i.complete, w: i.naturalWidth, h: i.naturalHeight, shown: Math.round(i.getBoundingClientRect().height) }));
      check("friend thread: the friend's photo loads (GET /api/attachments/:id/raw 200, never 404) and shows", img.complete && img.w === 480 && img.h === 320 && img.shown > 40 && photoGets.length > 0 && photoGets.every((s) => s === 200), JSON.stringify({ ...img, gets: photoGets }));
      await shot("friend-photo");
    }
  } catch (e) {
    pass.errors.push(`fatal: ${e.message.slice(0, 300)}`);
    await shot("fatal").catch(() => {});
  } finally {
    await context.close();
    await browser.close();
  }
  check("no console errors", pass.errors.length === 0, pass.errors.join(" | "));
  results.passes.push(pass);
  const bad = pass.checks.filter((c) => !c.ok);
  console.log(`${TAG} ${engine}/${variant}: ${pass.checks.length - bad.length}/${pass.checks.length} ok${bad.length ? " — FAIL " + bad.map((b) => `${b.name} (${b.detail})`).join("; ") : ""}`);
}

let server = null;
try {
  server = await startServer();
  await startPreview();
  for (const engine of ENGINES) for (const variant of VARIANTS) await runPass(engine, variant);
} finally {
  for (const p of own) p.stopAll();
  if (server?.dataDir) {
    // the server writes on shutdown: remove its throwaway data dir only after it has exited
    if (server.proc.exitCode === null && server.proc.signalCode === null) {
      await Promise.race([new Promise((r) => server.proc.once("exit", r)), sleep(5000)]);
    }
    await sleep(200);
    fs.rmSync(server.dataDir, { recursive: true, force: true });
  }
  fs.writeFileSync(path.join(outDir, `${TAG}-results.json`), JSON.stringify(results, null, 2));
}
const failed = results.passes.flatMap((p) => p.checks.filter((c) => !c.ok));
process.exit(failed.length ? 1 : 0);
