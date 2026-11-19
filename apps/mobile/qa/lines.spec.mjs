// Line-break sweep (FOUNDATION.md › Line breaks): every screen that opens without a model turn, at 320 / 360 / 390 / 430
// wide in Chrome and WebKit, measured with the shared checker (qa/lib/lines.mjs). Covers the Gallery (and its sheets),
// the onboarding landing and its two sheets, the empty chat, and the 둘러보기 / 보관함 / 나의 모시 tabs with the screens
// and sheets their rows open (two levels deep; rows that delete, disconnect, sign out or pay are never pressed, nor is
// anything inside a sheet). "cards" is a chat thread of every card kind, served by route interception
// (fixtures/lines-cards.mjs). Its turn lines are opened, the credential card's 보관 기간 sheet is measured too, and so
// are the heads (title, basis, summary) of a '전부' answer on three html cards drawn by the agent's own code, and the
// thread's last reply (fixtures/glue-reply.mjs › GLUE_REPLY, long and synthetic: Korean in brackets, prices, long
// numbers, dates, times, Japanese, " · " lists) has its blocks checked on their own too (results.glueReply; the glue
// rules GLUE_RULES: open-end, close-start, number, particle, overflow; ui/Text.tsx › glued() keeps them all away). Each
// finding is attributed to the stylesheet that defines the block's nearest class, and so to its owner (an html card's
// head to agent-runtime: explore.ts writes it). Fails on findings in foundation blocks (src/ui, src/app, src/dev …); the
// rest is listed for its owner.
//
//   QA_BASE=http://127.0.0.1:<preview> QA_API=http://127.0.0.1:<server> node apps/mobile/qa/lines.spec.mjs
// Env: QA_ENGINES (chromium,webkit) · QA_WIDTHS (320,360,390,430) · QA_ONLY (gallery,onboarding,chat,cards,explore,
//      archive,profile) · QA_SHOTS=1 (per engine and width: the Gallery's 줄바꿈 section; the card thread a screen at a
//      time at 1x, and each html card) · QA_OUT (docs/qa/lines) ·
//      QA_NARROW (160: the copy-block width below which copy rules may not add a line) · QA_RECTS=<selector> (record
//      those elements' layout boxes per screen, to compare two builds for a no-layout-change check) · QA_BLOCKS=1
//      (every measured block's lines go to results.blocks, to compare line counts between two builds) ·
//      QA_GLUE_EXPECT=0 (fail on any glue-rule finding in GLUE_REPLY, or when the reply is not found: a build whose
//      replies go through glued(); a build drawing them as plain runs trips open-end and number in WebKit)
// Narrow copy blocks (under QA_NARROW) are listed in their own table for their owners: a layout question, not a finding.
// The preview must proxy /api to QA_API (PICKLE_API); the server should run with fresh data and no live services
// (PICKLE_AUDIO_TUNNEL=0, MEET_BOT_URL=off, STT_URL=off, blank TWILIO_*). Accounts are made with the briefing off.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { linesInPage } from "./lib/lines.mjs";
import { linesCardsThread, rowsCards } from "./fixtures/lines-cards.mjs";
import { GLUE_REPLY, GLUE_RULES } from "./fixtures/glue-reply.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, "..");
const repo = path.resolve(appDir, "../..");
const require = createRequire(path.join(repo, "package.json"));
const { chromium, webkit } = require("playwright");

const BASE = process.env.QA_BASE;
const API = process.env.QA_API;
if (!BASE || !API) throw new Error("set QA_BASE (a preview proxying /api) and QA_API (its server)");
for (const u of [BASE, API]) if (/:(8787|5173|8781|8782|8789|8794|8795|8810)\b/.test(u)) throw new Error(`${u}: a live port; start your own server and preview`);
const ENGINES = (process.env.QA_ENGINES || "chromium,webkit").split(",").filter(Boolean);
const WIDTHS = (process.env.QA_WIDTHS || "320,360,390,430").split(",").map(Number);
const ONLY = (process.env.QA_ONLY || "gallery,onboarding,chat,cards,explore,archive,profile").split(",");
const SHOTS = process.env.QA_SHOTS === "1";
const OUT = path.resolve(repo, process.env.QA_OUT || "docs/qa/lines");
const NARROW = Number(process.env.QA_NARROW || 160);
const RECTS = process.env.QA_RECTS || "";
const BLOCKS = process.env.QA_BLOCKS === "1";
const GLUE_EXPECT = process.env.QA_GLUE_EXPECT;
// the glue rules: what glued() keeps away (fixtures/glue-reply.mjs › GLUE_RULES)
const glueRule = (f) => GLUE_RULES.includes(f.rule);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// the '전부' cards, drawn once by explore.ts (bun); an html card's head is measured inside its frame
const DRAWN = ONLY.includes("cards") ? rowsCards() : null;
const CARD_HEAD = "h2, p.meta, .sum p";
// the block as the card's CSS names it: "meta", "sum p", "h2"
const cardHeadOwner = (u) => {
  const [up = "", el = ""] = u.path.split(" > ").slice(-2);
  return { owner: "agent-runtime", file: "packages/agent/src/explore.ts", cls: u.own[0] ?? (up.includes(".") ? `${up.split(".")[1]} ${el}` : el) };
};
// rows never pressed: they delete, disconnect, sign out, pay, or start something real
const DENY = /로그아웃|삭제|해제|탈퇴|초기화하기|(설정|데이터|기록) 초기화|끊기|나가기|차단|지우기|결제|구매|충전|구독|티켓 쓰기|맡기기|전화 걸기|보내기/;

// ── owners: the stylesheet defining a block's nearest class ──
// teams as in docs/design/drafts/APPLY.md: screens/chat → screens-chat (but the drawer and onboarding are the
// foundation's), screens/more → screens-more (connections too), the k-skill sheet (connections/SkillAccounts*) → kakao-chat
const FOUNDATION_FILE = /^src\/((ui|app|styles|dev|motion|three)\/|screens\/chat\/(onboarding\/|drawer\.css|DrawerContent))/;
const GENERIC = new Set(["t-copy", "t-s", "t-tie", "tnum", "keep-all", "sr-only", "swap-host", "block", "glass", "is-clickable", "is-tinted", "is-disabled", "is-destructive"]);
const classFiles = new Map();
const selectors = []; // [file, selector text]
(function index(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) index(p);
    else if (e.name.endsWith(".css")) {
      const css = fs.readFileSync(p, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
      for (const m of css.matchAll(/([^{}]+)\{/g)) for (const sel of m[1].split(",")) selectors.push([path.relative(appDir, p), sel.trim()]);
      for (const m of css.matchAll(/\.([A-Za-z_][\w-]*)/g)) {
        const rel = path.relative(appDir, p);
        if (!classFiles.has(m[1])) classFiles.set(m[1], new Set());
        classFiles.get(m[1]).add(rel);
      }
    }
  }
})(path.join(appDir, "src"));
// the foundation's copy slots always carry .t-copy; the same class without it is a screen's own markup reusing the look
const SLOTS = new Set(["list-footer", "list-row-sub", "tf-hint", "tf-error", "empty-state__body", "large-title-sub", "banner-body", "spot-empty-hint"]);
function ownerOf(unit) {
  // a chat answer's markdown (screens/chat/markdown.tsx, styled by chat.css as ".md p" and the like): screens-chat's,
  // though another screen's stylesheet may name the same class first (archive.css: ".arc-doc .md-p")
  if (unit.classes.includes("asst-text")) return { owner: "screens-chat", file: "src/screens/chat/chat.css", cls: unit.own.find((c) => !GENERIC.has(c)) ?? "md", reused: false };
  const reused = unit.own.some((c) => SLOTS.has(c)) && !unit.own.includes("t-copy");
  if (reused) {
    const r = resolve(unit.classes, true);
    if (r.owner !== "?") return { ...r, reused };
  }
  const own = { ...resolve(unit.classes, false), reused: false };
  if (own.owner !== "foundation") return own;
  // a foundation row (or field) a screen gave a class of its own and restyled inside — ".profile-tickets
  // .list-row-detail { max-width: 62% }" — is that screen's layout: the finding goes to the screen
  for (const level of unit.levels) {
    if (!level.some((c) => /^(list-row|tf|empty-state|large-title)$/.test(c))) continue;
    for (const c of level) {
      if (GENERIC.has(c) || !classFiles.has(c) || resolve([c], false).owner === "foundation") continue;
      const hit = selectors.find(([f, sel]) => !FOUNDATION_FILE.test(f) && new RegExp(`\\.${c}(?![\\w-])[^,]*\\.(list-row|tf|empty-state|large-title)-`).test(sel));
      if (hit) {
        const r = resolve([c], false);
        return { ...r, restyled: `${hit[0]}: ${hit[1]}`, reused: false };
      }
    }
  }
  return own;
}
function resolve(classes, skipFoundation) {
  for (const c of classes) {
    if (GENERIC.has(c) || !classFiles.has(c)) continue;
    const file = [...classFiles.get(c)].sort((a, b) => a.length - b.length)[0];
    const owner = FOUNDATION_FILE.test(file)
      ? "foundation"
      : /^src\/screens\/more\/connections\/SkillAccounts/.test(file)
        ? "kakao-chat"
        : /^src\/screens\/more\//.test(file)
          ? "screens-more"
          : /^src\/screens\/chat\//.test(file)
            ? "screens-chat"
            : "?";
    if (skipFoundation && owner === "foundation") continue;
    return { owner, file, cls: c };
  }
  return { owner: "?", file: null, cls: null };
}

// ── server side: a throwaway account ──
async function api(method, p, body, token) {
  const res = await fetch(API + p, { method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const type = res.headers.get("content-type") || "";
  return { status: res.status, body: type.includes("json") ? await res.json() : await res.text() };
}
async function account() {
  const kp = await crypto.webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const jwk = await crypto.webcrypto.subtle.exportKey("jwk", kp.publicKey);
  const handle = `qa${crypto.randomBytes(4).toString("hex")}`;
  const su = await api("POST", "/api/auth/signup", { handle, password: "qa-pass-1234", displayName: "하늘", agentName: "모시", device: { id: `qa-${handle}`, label: "QA", signingKey: jwk } });
  if (su.status !== 201 && su.status !== 200) throw new Error(`signup ${su.status}`);
  const off = await api("PATCH", "/api/settings", { notifications: { briefing: false } }, su.body.token);
  if (off.status !== 200) throw new Error(`briefing off: ${off.status}`);
  return su.body.token;
}

// ── in the page ──
const SHEET = ".sheet-root .sheet-panel, [role=dialog]";
const LAYER = ".tab-layer[data-active] .stack-layer[data-top]:not([data-leaving])";
async function sheetOpen(page) {
  return page.evaluate((sel) => !![...document.querySelectorAll(sel)].find((el) => el.getBoundingClientRect().height > 40), SHEET);
}
async function screenName(page) {
  return page.evaluate(
    ({ SHEET, LAYER }) => {
      const sheet = [...document.querySelectorAll(SHEET)].find((el) => el.getBoundingClientRect().height > 40);
      if (sheet) return `sheet: ${(sheet.querySelector(".sheet-title")?.textContent || sheet.getAttribute("aria-label") || "?").trim()}`;
      const layer = document.querySelector(LAYER);
      const title = document.querySelector(".topbar .tb-title")?.textContent?.trim() || layer?.querySelector(".large-title-text, h1, h2")?.textContent?.trim();
      return title || "?";
    },
    { SHEET, LAYER },
  );
}
async function scopeOf(page) {
  if (await sheetOpen(page)) return SHEET;
  return (await page.$(LAYER)) ? `${LAYER}, .topbar` : ".tab-layer[data-active], .topbar";
}
// wait until the scope stops moving (a sheet's spring, a pushed screen's slide): its rects equal for 3 frames, 2 s at most
async function settle(page, scope) {
  await page
    .evaluate(
      (sel) =>
        new Promise((done) => {
          const t0 = performance.now();
          let last = "";
          let same = 0;
          const tick = () => {
            const now = [...document.querySelectorAll(sel)].map((el) => { const r = el.getBoundingClientRect(); return `${r.x.toFixed(1)},${r.y.toFixed(1)},${r.width.toFixed(1)},${r.height.toFixed(1)}`; }).join("|");
            same = now === last ? same + 1 : 0;
            last = now;
            if (same >= 3 || performance.now() - t0 > 2000) done(null);
            else requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        }),
      scope,
    )
    .catch(() => {});
}
async function closeSheet(page) {
  await page.keyboard.press("Escape");
  for (let i = 0; i < 20 && (await sheetOpen(page)); i++) await sleep(150);
  if (await sheetOpen(page)) {
    const close = page.locator(".sheet-root .sheet-close").first();
    if (await close.count()) await close.click().catch(() => {});
    for (let i = 0; i < 20 && (await sheetOpen(page)); i++) await sleep(150);
  }
  await sleep(250);
}

async function runPass(browser, engine, width, token, out) {
  const isChrome = engine === "chromium";
  const ctx = await browser.newContext({ viewport: { width, height: 844 }, deviceScaleFactor: 3, isMobile: isChrome, hasTouch: true, colorScheme: "light", locale: "ko-KR", timezoneId: "Asia/Seoul" });
  const errors = [];
  const visited = [];
  const seen = new Set();
  const narrow = [];
  const rects = [];
  const blocks = [];
  const glue = [];
  // one measurement's findings and narrow blocks, each once per pass, with its owner
  const record = (r, area, screen, owner = ownerOf) => {
    visited.push({ area, screen, scanned: r.scanned, multiline: r.multiline });
    if (BLOCKS)
      for (const u of r.units) {
        const key = `block|${area}|${screen}|${u.path}|${u.text}`;
        if (seen.has(key)) continue;
        seen.add(key);
        blocks.push({ engine, width, area, screen, path: u.path, owner: owner(u).owner, text: u.text, lines: u.lines });
      }
    for (const u of r.narrow) {
      const key = `narrow|${u.path}|${u.text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const who = owner(u);
      narrow.push({ engine, width, area, screen, path: u.path, owner: who.owner, file: who.file, cls: who.cls, restyled: who.restyled, text: u.text, px: u.width, lines: u.lines });
    }
    for (const u of r.units) {
      const who = owner(u);
      for (const f of u.findings) {
        const key = `${f.rule}|${f.line}|${u.path}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ engine, width, area, screen, rule: f.rule, line: f.line, by: f.by, path: u.path, owner: who.owner, file: who.file, cls: who.cls, slot: who.reused ? u.own.find((c) => SLOTS.has(c)) : undefined, restyled: who.restyled, text: u.text, lines: u.lines });
      }
    }
  };
  const scan = async (page, area, scope, label) => {
    const name = label ?? (await screenName(page));
    const screen = name === "?" ? area : name;
    const where = scope ?? (await scopeOf(page));
    await settle(page, where);
    const r = await page.evaluate(linesInPage, { scope: where, narrowPx: NARROW, all: BLOCKS });
    record(r, area, screen);
    if (RECTS)
      rects.push({
        screen: `${area} › ${screen}`,
        boxes: await page.evaluate(
          ({ sel, where }) =>
            [...document.querySelectorAll(where)].flatMap((root) =>
              [...root.querySelectorAll(sel)].map((el) => ({ text: (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 40), x: el.offsetLeft, w: el.offsetWidth, h: el.offsetHeight })),
            ),
          { sel: RECTS, where },
        ),
      });
  };
  const fresh = async (withToken) => {
    const page = await ctx.newPage();
    page.on("console", (m) => m.type() === "error" && !/status of (401|404|409)/.test(m.text()) && errors.push(m.text().slice(0, 160)));
    page.on("pageerror", (e) => errors.push(`pageerror: ${e.message.slice(0, 160)}`));
    // the app's own document only: init scripts run in every frame, and an html card's sandboxed frame has no storage
    if (withToken) await page.addInitScript((t) => window === window.top && localStorage.setItem("pickle.token", t), token);
    else await page.addInitScript(() => window === window.top && localStorage.removeItem("pickle.token"));
    return page;
  };
  // rows on the current screen (not in a sheet), pressed one by one: a sheet is measured and closed, a pushed screen is
  // measured, its own rows too while depth allows, then popped
  let crawlId = 0;
  const crawl = async (page, area, depth) => {
    const tag = `c${++crawlId}`; // rows of screens below keep their marks: each crawl marks its own
    const rows = await page.evaluate(
      ({ LAYER, DENY, tag }) => {
        const deny = new RegExp(DENY);
        const scope = document.querySelector(LAYER) ?? document.querySelector(".tab-layer[data-active]");
        if (!scope) return [];
        const out = [];
        [...scope.querySelectorAll("button.list-row, button.tpl-row")].forEach((b, k) => {
          const text = (b.textContent || "").replace(/\s+/g, " ").trim();
          if (b.disabled || b.classList.contains("is-destructive") || b.querySelector("[role=switch]") || deny.test(text) || b.getAttribute("aria-disabled") === "true") return;
          b.setAttribute("data-lines-k", `${tag}-${k}`);
          out.push({ k: `${tag}-${k}`, text: text.slice(0, 40) });
        });
        return out;
      },
      { LAYER, DENY: DENY.source, tag },
    );
    for (const row of rows.slice(0, 24)) {
      const loc = page.locator(`[data-lines-k="${row.k}"]`).first();
      if (!(await loc.count())) continue;
      const stack = () => page.evaluate(() => document.querySelectorAll(".tab-layer[data-active] .stack-layer").length);
      const depthBefore = await stack();
      await loc.evaluate((el) => el.scrollIntoView({ block: "center" })).catch(() => {});
      await sleep(250);
      await loc.click({ timeout: 3000 }).catch(() => {});
      // a lazy screen waits for its chunk before it slides in: give either outcome up to 4 s
      let opened = "none";
      for (let i = 0; i < 40 && opened === "none"; i++) {
        await sleep(100);
        if (await sheetOpen(page)) opened = "sheet";
        else if ((await stack()) > depthBefore) opened = "push";
      }
      if (opened === "sheet") {
        await sleep(700);
        await scan(page, area);
        await closeSheet(page);
        continue;
      }
      if (opened === "push") {
        await sleep(1200);
        await scan(page, area);
        if (depth > 1) await crawl(page, area, depth - 1);
        const back = page.locator('.tb-circle[aria-label="뒤로"]');
        if (await back.count()) await back.first().click().catch(() => {});
        for (let i = 0; i < 30 && (await stack()) > depthBefore; i++) await sleep(100);
        await sleep(400);
      }
    }
  };

  if (ONLY.includes("gallery")) {
    const page = await fresh(false);
    await page.goto(`${BASE}/?gallery=1&gl=off`, { waitUntil: "load" });
    await page.waitForSelector("#gal-sheet", { timeout: 15_000 });
    await sleep(1500);
    await scan(page, "gallery", "body");
    if (SHOTS && (await page.$("#gal-lines"))) {
      await page.evaluate(() => document.getElementById("gal-lines").scrollIntoView({ block: "start" }));
      await sleep(400);
      fs.mkdirSync(OUT, { recursive: true });
      await page.locator("#gal-lines").screenshot({ path: path.join(OUT, `${engine}-${width}-gallery-lines.png`) });
    }
    const n = await page.locator("#gal-sheet button").count();
    for (let i = 0; i < n; i++) {
      const b = page.locator("#gal-sheet button").nth(i);
      await b.evaluate((el) => el.scrollIntoView({ block: "center" }));
      await sleep(200);
      await b.click().catch(() => {});
      await sleep(900);
      if (await sheetOpen(page)) {
        await scan(page, "gallery");
        await closeSheet(page);
      }
    }
    await page.close();
  }
  if (ONLY.includes("onboarding")) {
    const page = await fresh(false);
    await page.goto(`${BASE}/`, { waitUntil: "load" });
    await page.waitForSelector(".onb", { timeout: 15_000 });
    await sleep(1500);
    await scan(page, "onboarding", "body");
    for (const open of [() => page.getByRole("button", { name: "시작하기" }).first().click(), () => page.locator(".onb-login").first().click()]) {
      await open().catch(() => {});
      await sleep(1000);
      if (await sheetOpen(page)) {
        await scan(page, "onboarding");
        await closeSheet(page);
      }
    }
    await page.close();
  }
  // before the tabs: the profile crawl presses 화면 및 디자인's theme rows, and the account stays dark after it
  if (ONLY.includes("cards")) {
    const page = await fresh(true);
    const sess = await api("GET", "/api/session", undefined, token);
    const mainId = sess.body?.mainThreadId ?? sess.body?.session?.mainThreadId;
    if (!mainId) throw new Error(`cards: no main thread (session ${sess.status})`);
    const { items, artifacts } = linesCardsThread(mainId, "모시", DRAWN);
    const idAt = (url) => decodeURIComponent(new URL(url).pathname.split("/")[3]);
    await page.route(/\/api\/threads\/[^/]+\/messages(\?.*)?$/, (r) =>
      r.request().method() === "GET" && idAt(r.request().url()) === mainId ? r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(items) }) : r.fallback(),
    );
    await page.route(/\/api\/artifacts\/[^/?]+(\?.*)?$/, (r) => {
      const a = artifacts[idAt(r.request().url())];
      return r.request().method() === "GET" && a ? r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(a) }) : r.fallback();
    });
    await page.goto(`${BASE}/`, { waitUntil: "load" });
    await page.waitForSelector(".thread-content .ccard-cred", { timeout: 20_000 });
    await page.waitForFunction((n) => document.querySelectorAll(".hart iframe.hframe[data-ready]").length >= n, DRAWN.cards.length, { timeout: 20_000 }).catch(() => {});
    // every turn's line opened: the folded records (results, weather, the room) and the steps
    const heads = page.locator('.thread-content .tools-line.turn-head[aria-expanded="false"]');
    for (let i = await heads.count(); i > 0 && (await heads.count()); i--) {
      const h = heads.first();
      await h.evaluate((el) => el.scrollIntoView({ block: "center" })).catch(() => {});
      await sleep(150);
      await h.click({ timeout: 3000 }).catch(() => h.evaluate((el) => el.click()));
      await sleep(700);
    }
    await sleep(500);
    await scan(page, "cards", ".thread-content", "thread");
    // GLUE_REPLY's blocks on their own: the reply found by its first line (marked for the checker's scope)
    const marked = await page.evaluate((start) => {
      let n = 0;
      for (const el of document.querySelectorAll(".thread-content .asst-text"))
        if (el.textContent.replace(/\s+/g, " ").trim().startsWith(start)) (el.setAttribute("data-qa-glue", ""), n++);
      return n;
    }, GLUE_REPLY.split("\n")[0].slice(0, 30));
    const g = marked ? await page.evaluate(linesInPage, { scope: "[data-qa-glue]", narrowPx: NARROW }) : { scanned: 0, units: [] };
    const all = g.units.flatMap((u) => u.findings.map((f) => ({ rule: f.rule, line: f.line, by: f.by, text: u.text })));
    glue.push({ engine, width, found: marked, scanned: g.scanned, glue: all.filter(glueRule), other: all.filter((f) => !glueRule(f)) });
    if (SHOTS) {
      // the thread scrolls inside its layer: a screen at a time, top to bottom, then each html card
      fs.mkdirSync(OUT, { recursive: true });
      const scrollTo = (k) =>
        page.evaluate((k) => {
          let el = document.querySelector(".thread-content");
          while (el && !(el.scrollHeight > el.clientHeight + 4 && /auto|scroll/.test(getComputedStyle(el).overflowY))) el = el.parentElement;
          if (!el) return false;
          const step = el.clientHeight - 160;
          el.scrollTop = k * step;
          return k * step < el.scrollHeight - el.clientHeight;
        }, k);
      for (let k = 0, more = true; more && k < 40; k++) {
        more = await scrollTo(k);
        await sleep(300);
        await page.screenshot({ path: path.join(OUT, `${engine}-${width}-cards-${String(k + 1).padStart(2, "0")}.png`), scale: "css" });
      }
      const harts = page.locator(".thread-content .hart");
      for (let i = 0; i < (await harts.count()); i++) await harts.nth(i).screenshot({ path: path.join(OUT, `${engine}-${width}-html-card-${i + 1}.png`) }).catch(() => {});
    }
    const keep = page.locator(".thread-content .cred-keep-change").first();
    if (await keep.count()) {
      await keep.evaluate((el) => el.scrollIntoView({ block: "center" })).catch(() => {});
      await sleep(200);
      await keep.click().catch(() => {});
      for (let i = 0; i < 30 && !(await sheetOpen(page)); i++) await sleep(100);
      if (await sheetOpen(page)) {
        await sleep(700);
        await scan(page, "cards");
        await closeSheet(page);
      }
    }
    // the html cards' heads, inside their frames
    for (const el of await page.$$(".thread-content .hart iframe.hframe")) {
      const frame = await el.contentFrame();
      if (!frame) continue;
      await frame.waitForSelector(".sum p", { timeout: 10_000 }).catch(() => {});
      const title = await frame.evaluate(() => document.querySelector("h2")?.textContent?.trim() ?? "");
      record(await frame.evaluate(linesInPage, { select: CARD_HEAD, narrowPx: NARROW }), "cards", `html card ${title.match(/\(\d+\/\d+\)$/)?.[0] ?? title}`, cardHeadOwner);
    }
    await page.close();
  }
  const tabs = ["chat", "explore", "archive", "profile"].filter((t) => ONLY.includes(t));
  if (tabs.length) {
    const page = await fresh(true);
    await page.goto(`${BASE}/`, { waitUntil: "load" });
    await page.waitForSelector("#tab-chat", { timeout: 20_000 });
    await sleep(2000);
    for (const t of tabs) {
      await page.click(`#tab-${t}`).catch(() => {});
      await sleep(1800);
      await scan(page, t);
      if (t !== "chat") await crawl(page, t, t === "profile" ? 2 : 1);
    }
    await page.close();
  }
  await ctx.close();
  return { visited, errors, narrow, rects, blocks, glue };
}

const results = { when: new Date().toISOString(), widths: WIDTHS, engines: ENGINES, narrowPx: NARROW, passes: [], findings: [], narrow: [], glueReply: [], ...(BLOCKS ? { blocks: [] } : {}) };
for (const engine of ENGINES) {
  const browser = await (engine === "chromium" ? chromium : webkit).launch(engine === "chromium" ? { channel: "chrome", args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] } : {});
  for (const width of WIDTHS) {
    const token = ONLY.some((a) => ["chat", "cards", "explore", "archive", "profile"].includes(a)) ? await account() : null;
    const t0 = Date.now();
    const found = [];
    const { visited, errors, narrow, rects, blocks, glue } = await runPass(browser, engine, width, token, found);
    results.glueReply.push(...glue);
    for (const r of glue) {
      const by = r.glue.reduce((m, f) => ((m[f.rule] = (m[f.rule] ?? 0) + 1), m), {});
      console.log(`  glue reply: ${r.found ? `${r.scanned} blocks · glue findings ${r.glue.length} ${JSON.stringify(by)} · other ${r.other.length}` : "NOT FOUND"}`);
      for (const f of r.glue) console.log(`    ${f.rule}${f.by ? ` +${f.by}px` : ""}: "${f.line}"`);
    }
    if (BLOCKS) results.blocks.push(...blocks);
    results.passes.push({ engine, width, ms: Date.now() - t0, screens: visited.length, blocks: visited.reduce((s, v) => s + v.scanned, 0), visited, errors, ...(RECTS ? { rects } : {}) });
    results.findings.push(...found);
    results.narrow.push(...narrow);
    const by = found.reduce((m, f) => ((m[f.owner] = (m[f.owner] ?? 0) + 1), m), {});
    console.log(`${engine}/${width}: ${visited.length} screens, ${visited.reduce((s, v) => s + v.scanned, 0)} blocks, ${Math.round((Date.now() - t0) / 1000)} s · findings ${JSON.stringify(by)}${errors.length ? ` · errors ${errors.length}` : ""}`);
    for (const f of found.filter((f) => f.owner === "foundation")) console.log(`  FOUNDATION ${f.rule}${f.by ? ` +${f.by}px` : ""}: "${f.line}" · ${f.area} › ${f.screen} · ${f.cls} (${f.file}) · ${f.lines.join(" / ")}`);
  }
  await browser.close();
}

// per screen and owner: how many findings, in which engines and widths
const table = new Map();
for (const f of results.findings) {
  const k = `${f.owner}\t${f.area} › ${f.screen}\t${f.slot ? `${f.slot} (in ${f.cls})` : f.restyled ? `${f.path.split(" > ").pop().replace(/^\w+\./, "")} (restyled: ${f.restyled})` : (f.cls ?? "?")}`;
  if (!table.has(k)) table.set(k, { n: 0, rules: new Set(), at: new Set(), sample: f });
  const e = table.get(k);
  e.n++;
  e.rules.add(f.rule);
  e.at.add(`${f.engine === "chromium" ? "C" : "W"}${f.width}`);
}
results.table = [...table].map(([k, e]) => {
  const [owner, screen, cls] = k.split("\t");
  return { owner, screen, cls, findings: e.n, rules: [...e.rules], at: [...e.at], sample: { rule: e.sample.rule, line: e.sample.line, lines: e.sample.lines } };
});
results.table.sort((a, b) => (a.owner === b.owner ? b.findings - a.findings : a.owner.localeCompare(b.owner)));
console.log("\nowner · screen · block · findings · rules · where · sample");
for (const r of results.table) console.log(`${r.owner} · ${r.screen} · .${r.cls} · ${r.findings} · ${r.rules.join("+")} · ${r.at.join(" ")} · "${r.sample.line}"`);
// narrow copy blocks per screen: which widths, how wide
const narrowTable = new Map();
for (const n of results.narrow) {
  const k = `${n.owner}\t${n.area} › ${n.screen}\t${n.restyled ? `${n.path.split(" > ").pop().replace(/^\w+\./, "")} (restyled: ${n.restyled})` : (n.cls ?? "?")}`;
  if (!narrowTable.has(k)) narrowTable.set(k, { at: new Set(), px: [], sample: n });
  const e = narrowTable.get(k);
  e.at.add(`${n.engine === "chromium" ? "C" : "W"}${n.width}`);
  e.px.push(n.px);
}
results.narrowTable = [...narrowTable].map(([k, e]) => {
  const [owner, screen, cls] = k.split("\t");
  return { owner, screen, cls, at: [...e.at], px: [Math.min(...e.px), Math.max(...e.px)], sample: { text: e.sample.text, lines: e.sample.lines } };
});
results.narrowTable.sort((a, b) => a.owner.localeCompare(b.owner) || a.screen.localeCompare(b.screen));
console.log(`\nnarrow copy blocks (< ${NARROW} px) · owner · screen · block · where · px · sample`);
for (const r of results.narrowTable) console.log(`${r.owner} · ${r.screen} · .${r.cls} · ${r.at.join(" ")} · ${r.px[0]}–${r.px[1]} · "${r.sample.text}"`);
const foundation = results.findings.filter((f) => f.owner === "foundation").length;
const crashed = results.passes.filter((p) => p.errors.some((e) => e.startsWith("pageerror"))).length;
const glueBad = results.glueReply.filter((r) => !r.found || r.glue.length).length;
results.ok = foundation === 0 && crashed === 0 && (GLUE_EXPECT !== "0" || (ONLY.includes("cards") && glueBad === 0));
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, "results.json"), JSON.stringify(results, null, 2));
console.log(`\nfoundation findings ${foundation} · other ${results.findings.length - foundation} · passes with page errors ${crashed}`);
if (ONLY.includes("cards"))
  console.log(`glue reply: glue findings ${results.glueReply.reduce((n, r) => n + r.glue.length, 0)} in ${results.glueReply.filter((r) => r.glue.length).length} of ${results.glueReply.length} passes${results.glueReply.some((r) => !r.found) ? " · NOT FOUND in some" : ""}${GLUE_EXPECT === "0" ? ` · expected 0: ${glueBad ? "FAIL" : "ok"}` : ""}`);
console.log(results.ok ? "QA: PASS" : "QA: FAIL", "→", path.relative(repo, path.join(OUT, "results.json")));
process.exit(results.ok ? 0 : 1);
