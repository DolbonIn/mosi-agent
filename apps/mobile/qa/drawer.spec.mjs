// Drawer QA (draft "drawer" B: search first, "지금 하는 일" from server state, the agent's last sentence as each row's
// subtitle). Against a running server and a built preview — never :5173 / :8787:
//   PICKLE_AUDIO_TUNNEL=0 MEET_BOT_URL=off STT_URL=off TWILIO_ACCOUNT_SID= TWILIO_AUTH_TOKEN= TWILIO_FROM= \
//     PICKLE_DATA_DIR=<fresh> PORT=<api> bun run apps/server/src/index.ts
//   PICKLE_API=http://127.0.0.1:<api> bunx vite preview --outDir <dist> --port <web> --strictPort
//   QA_BASE=http://127.0.0.1:<web> QA_API=http://127.0.0.1:<api> node apps/mobile/qa/drawer.spec.mjs
// The real server is checked for the thread-list contract (`preview` string, `waiting` null or {kind, text}); the
// rendered states use a synthetic thread list (page.route on GET /api/threads) so the captures match the draft's
// fixture: five threads, synthetic names, masked numbers only.
// Env: QA_ENGINES (chromium,webkit) · QA_THEMES (light,dark) · QA_SHOTS=1 (docs/design/drafts/drawer/applied-*.jpg from
// chromium, 390×844 @2x q82) · QA_SERVER_FIELDS=0 (skip the contract check while the server part is in flight).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, webkit } from "playwright";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../../..");
const BASE = process.env.QA_BASE;
const API = process.env.QA_API;
if (!BASE || !API) throw new Error("set QA_BASE (preview) and QA_API (server)");
const ENGINES = (process.env.QA_ENGINES || "chromium,webkit").split(",");
const THEMES = (process.env.QA_THEMES || "light,dark").split(",");
const SHOTS = process.env.QA_SHOTS === "1";
const SERVER_FIELDS = process.env.QA_SERVER_FIELDS !== "0";
const OUT = path.join(repo, "docs/design/drafts/drawer");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = () => Math.random().toString(36).slice(2, 8);

const results = [];
let failed = false;
function check(tag, name, ok, detail) {
  results.push({ tag, name, ok: !!ok, detail });
  if (!ok) failed = true;
  console.log(`${ok ? "ok  " : "FAIL"} ${tag} · ${name}${detail !== undefined ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
}

async function api(p, { method = "GET", body, token } = {}) {
  const res = await fetch(API + p, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${method} ${p} → ${res.status} ${JSON.stringify(json)}`);
  return json;
}

async function signup() {
  const handle = `qa_dw_${rand()}`;
  const device = { id: `qa-${rand()}`, label: "QA", signingKey: { kty: "EC", crv: "P-256", x: "f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU", y: "x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0" } };
  return api("/api/auth/signup", { method: "POST", body: { handle, password: "qa-pass-1234", displayName: "하늘", agentName: "깽이", device } });
}

/** the draft's fixture (same names, same times), synthetic; `live` puts the meeting into "지금 하는 일" */
function fixture(mainThread, live) {
  const now = Date.now();
  const min = 60_000;
  const base = { archived: false, unread: false, subtitle: "" };
  return [
    { ...mainThread },
    { ...base, id: "qa-friend", kind: "friend", title: "깽이와 진우님의 모시", icon: "people", unread: true, createdAt: now - 9 * min, updatedAt: now - 1 * min, peer: { userId: "qa-peer-1", displayName: "진우", agentName: "콩이" }, preview: "진우님의 모시와 친구가 되었어요.", waiting: null },
    { ...base, id: "qa-call", kind: "call", title: "연세바른치과에 전화", icon: "phone-out", unread: true, createdAt: now - 9 * min, updatedAt: now - 2 * min, preview: "02-****-1234로 전화해서 전했어요.", waiting: null },
    {
      ...base,
      id: "qa-meet",
      kind: "call",
      title: "11월 12일 주간회의",
      icon: "people",
      createdAt: now - 90 * min,
      updatedAt: live ? now - 10_000 : now - 60 * min,
      preview: "정한 것 2개, 할 일 2개를 정리했어요.",
      waiting: live ? { kind: "meeting", text: "회의 중 · 듣고 받아 적고 있어요." } : null,
    },
    { ...base, id: "qa-task", kind: "task", title: "이사 준비", icon: "sparkles", createdAt: now - 23 * 60 * min, updatedAt: now - 22 * 60 * min, preview: "체크리스트를 만들었어요.", waiting: null },
    { ...base, id: "qa-sched", kind: "schedule", title: "아침 브리핑", icon: "clock", createdAt: now - 30 * 60 * min, updatedAt: now - 26 * 60 * min, preview: "내일 오전 7:00에 보내 드릴게요.", waiting: null },
  ];
}

async function drawerFacts(page) {
  return page.evaluate(() => {
    const q = (s) => document.querySelector(s);
    const extra = q(".drawer-extra");
    const rows = [...document.querySelectorAll(".dw-threads .dw-row")].map((r) => ({
      title: r.querySelector(".dw-row-title-text")?.textContent,
      sub: r.querySelector(".dw-row-sub")?.textContent ?? "",
      clamp: r.querySelector(".dw-row-sub") ? getComputedStyle(r.querySelector(".dw-row-sub")).webkitLineClamp : null,
      glyph: (() => {
        const g = r.querySelector(".dw-row-glyph");
        const svg = g?.querySelector("svg");
        return svg ? { w: Math.round(svg.getBoundingClientRect().width), avatar: svg.classList.contains("avatar") || !!g.querySelector(".avatar") } : null;
      })(),
      plateBg: r.querySelector(".dw-row-glyph") ? getComputedStyle(r.querySelector(".dw-row-glyph")).backgroundColor : null,
    }));
    const live = [...document.querySelectorAll(".dw-sec")].find((s) => s.querySelector(".dw-h")?.textContent?.trim() === "지금 하는 일");
    return {
      head: !!q(".drawer-head"),
      firstIsSearch: extra?.querySelector(".dw")?.firstElementChild?.classList.contains("dw-search-wrap") ?? false,
      threadsHeading: q(".dw-threads .dw-h")?.textContent?.trim(),
      textbtn: q(".dw-textbtn")?.textContent?.trim(),
      rows,
      badges: document.querySelectorAll(".dw-badge").length,
      plates: document.querySelectorAll(".dw-row-icon").length,
      live: live ? [...live.querySelectorAll(".dw-row")].map((r) => ({ title: r.querySelector(".dw-row-title-text")?.textContent, sub: r.querySelector(".dw-row-sub")?.textContent })) : null,
      liveBeforeMain: live ? !!(live.compareDocumentPosition(q(".dw-main")) & Node.DOCUMENT_POSITION_FOLLOWING) : null,
      text: extra?.innerText ?? "",
    };
  });
}

async function run(engineName, theme) {
  const tag = `${engineName}/${theme}`;
  const auth = await signup();
  const token = auth.token;
  const realList = await api("/api/threads", { token });
  const main = realList.find((t) => t.kind === "main") ?? realList[0];
  if (SERVER_FIELDS) {
    const bad = realList.filter((t) => typeof t.preview !== "string" || !("waiting" in t) || (t.waiting !== null && !(t.waiting && typeof t.waiting.text === "string" && /^(approval|call|meeting)$/.test(t.waiting.kind))));
    check(tag, "server: every thread carries preview (string) and waiting (null | {kind, text})", realList.length > 0 && bad.length === 0, bad.map((t) => ({ id: t.id, preview: typeof t.preview, waiting: t.waiting })));
  }

  const bt = engineName === "chromium" ? chromium : webkit;
  const browser = await bt.launch(engineName === "chromium" ? { channel: "chrome", args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] } : {});
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: engineName === "chromium", hasTouch: true, colorScheme: theme, locale: "ko-KR" });
  await ctx.addInitScript((tk) => localStorage.setItem("pickle.token", tk), token);
  const page = await ctx.newPage();
  const errors = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  let live = false;
  await page.route(/\/api\/threads(\?[^/]*)?$/, (route) => {
    if (route.request().method() !== "GET") return route.continue();
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(fixture(main, live)) });
  });
  const sx = (n) => (SHOTS && engineName === "chromium" ? page.screenshot({ path: path.join(OUT, `${n.replace("{t}", theme)}.jpg`), type: "jpeg", quality: 82 }) : null);
  const openDrawer = async () => {
    await page.getByRole("button", { name: "메뉴" }).click();
    await page.waitForSelector(".dw");
    await sleep(1000);
  };
  const closeDrawer = async () => {
    await page.keyboard.press("Escape");
    await sleep(700);
  };

  await page.goto(`${BASE}/`, { waitUntil: "load" });
  await page.waitForSelector(".composer, [aria-label='메뉴']", { timeout: 20_000 });
  await sleep(1500);

  // ── default ──
  await openDrawer();
  let f = await drawerFacts(page);
  check(tag, "no agent head; the search comes first", !f.head && f.firstIsSearch);
  check(tag, "'맡긴 일' with the '보관한 대화' text switch", f.threadsHeading === "맡긴 일" && f.textbtn === "보관한 대화", { h: f.threadsHeading, b: f.textbtn });
  check(tag, "no '지금 하는 일' while nothing is live", f.live === null);
  check(tag, "rows: subtitles are the agent's last sentence (2-line clamp)", f.rows.length === 5 && f.rows.every((r) => r.sub && r.clamp === "2"), f.rows.map((r) => [r.title, r.sub, r.clamp]));
  check(tag, "rows: 20 px glyphs, no plates; the friend shows their agent's face", f.plates === 0 && f.rows.filter((r) => !r.glyph?.avatar).every((r) => r.glyph?.w === 20) && f.rows.some((r) => r.glyph?.avatar), f.rows.map((r) => r.glyph));
  check(tag, "no badges", f.badges === 0);
  check(tag, "no unmasked number in the drawer", !/\d{2,4}-\d{3,4}-\d{4}|\d{9,}/.test(f.text));
  await sx("applied-{t}");

  // archive switch
  await page.getByRole("button", { name: "보관한 대화" }).click();
  await sleep(500);
  f = await drawerFacts(page);
  check(tag, "archive switch: heading '보관한 대화', button back to '맡긴 일'", f.threadsHeading === "보관한 대화" && f.textbtn === "맡긴 일", { h: f.threadsHeading, b: f.textbtn });
  await page.locator(".dw-textbtn").click();
  await sleep(400);

  // ── search ㅎㅇ ──
  await page.locator(".dw-search").click();
  await sleep(500);
  const recentFacts = await page.evaluate(() => ({
    head: document.querySelector(".dw-spot .spot-section")?.textContent?.trim(),
    n: document.querySelectorAll(".dw-spot [role=option]").length,
    label: document.querySelector(".dw-spot [role=listbox]")?.getAttribute("aria-label"),
  }));
  check(tag, "empty search lists the recent conversations", recentFacts.head === "최근 대화" && recentFacts.n === 5 && recentFacts.label === "최근 대화", recentFacts);
  await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
  await sleep(300);
  await sx("applied-recent-{t}");
  await page.locator(".dw-spot input").focus();
  await page.keyboard.type("ㅎㅇ");
  await sleep(700);
  const hit = await page.evaluate(() => {
    const opts = [...document.querySelectorAll(".dw-spot [role=option]")];
    const o = opts[0];
    const title = o?.querySelector(".dw-row-title");
    const mark = o?.querySelector("mark");
    return {
      n: opts.length,
      text: o?.querySelector(".dw-row-title-text")?.textContent,
      titleWeight: title ? getComputedStyle(title).fontWeight : null,
      mark: mark ? { text: mark.textContent, weight: getComputedStyle(mark).fontWeight, color: getComputedStyle(mark).color, bg: getComputedStyle(mark).backgroundColor } : null,
      label: title ? getComputedStyle(title).color : null,
      slab: o ? getComputedStyle(o).backgroundColor : null,
      chev: !!o?.querySelector(".dw-row-chev"),
      coarse: matchMedia("(pointer: coarse)").matches,
    };
  });
  check(tag, "초성 ㅎㅇ → 11월 12일 주간회의, the matched letters bold", hit.n >= 1 && hit.text === "11월 12일 주간회의" && hit.mark?.text === "회의" && Number(hit.mark.weight) >= 700, hit);
  check(tag, "hit title regular, matched letters --label (not accent)", Number(hit.titleWeight) === 400 && (hit.coarse ? hit.mark?.color === hit.label : true), { w: hit.titleWeight, mark: hit.mark?.color, label: hit.label });
  if (hit.coarse) check(tag, "phone (coarse pointer): no accent slab; the top hit shows the chevron", /rgba\(0, 0, 0, 0\)|transparent/.test(hit.slab) && hit.chev, { slab: hit.slab, chev: hit.chev });
  await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
  await sleep(300);
  await sx("applied-search-{t}");
  await page.locator(".dw-spot input").fill("ㅋㅋㅋㅋ");
  await sleep(500);
  const empty = await page.locator(".dw-spot .spot-empty").innerText().catch(() => "");
  check(tag, "no hit: says so and how to search", /찾는 대화가 없어요/.test(empty) && /초성/.test(empty), empty);
  await page.locator(".dw-cancel").click();
  await sleep(400);
  await closeDrawer();

  // ── live: the meeting is pinned on top, its state as the subtitle, no badge ──
  live = true;
  await openDrawer();
  f = await drawerFacts(page);
  check(tag, "'지금 하는 일' pinned above 기본 채팅 with the meeting", f.live?.length === 1 && f.live[0].title === "11월 12일 주간회의" && f.live[0].sub === "회의 중 · 듣고 받아 적고 있어요." && f.liveBeforeMain, { live: f.live, before: f.liveBeforeMain });
  check(tag, "the live meeting left '맡긴 일' (no duplicate row), still no badge", f.rows.length === 4 && !f.rows.some((r) => r.title === "11월 12일 주간회의") && f.badges === 0, f.rows.map((r) => r.title));
  await sx("applied-live-{t}");
  await closeDrawer();

  check(tag, "no console errors", errors.length === 0, errors.slice(0, 3));
  await browser.close();
}

for (const e of ENGINES) for (const t of THEMES) await run(e, t);
fs.mkdirSync(path.join(repo, "docs/qa/drawer"), { recursive: true });
fs.writeFileSync(path.join(repo, "docs/qa/drawer/results.json"), JSON.stringify({ when: new Date().toISOString(), results }, null, 2));
console.log(failed ? "QA: FAIL" : `QA: PASS (${results.length} checks)`);
process.exit(failed ? 1 : 0);
