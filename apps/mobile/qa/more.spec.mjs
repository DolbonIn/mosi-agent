// 둘러보기 / 보관함 / 나의 모시 QA (screens-more). Runs against a LIVE pickle server with a real LLM. From the repo root:
//   PICKLE_DATA_DIR=… PORT=8792 bun --env-file=… run apps/server/src/index.ts      (the server, separately)
//   node apps/mobile/qa/more.spec.mjs                                            (Chrome + WebKit × light/dark/reduced)
//   QA_ENGINES=chromium QA_VARIANTS=light node apps/mobile/qa/more.spec.mjs     (one pass)
// Env: QA_API (server, default http://127.0.0.1:8792) · QA_PORT (preview, default 5186) · QA_BUILD=0 (reuse the build)
//      QA_ONLY=explore,profile,…  (scenario subset) · QA_OUT (screenshots + results.json, default docs/qa/more)
//      QA_DIST (build dir, default a temp dir unique to this checkout and port)
// Builds the real app (all screens exist) into a temp dir, serves it with `vite preview` (proxying /api), and drives
// 390×844 @3x in installed Google Chrome (channel "chrome") and Playwright WebKit. Never runs `playwright install`.
// Each pass signs up fresh users through the API (paced under the server's sign-up limit) and walks:
//   explore: draft B — word rail (추천 · 전체 …, no plates) · 추천 = 깽이의 제안 (face) + two first tries + the 전체 row
//            (real count) → 전체 lists every template · real app icons for service rows, bare glyphs otherwise ·
//            call-demo sheet (내 전화번호 + cost over 인증하고 받아 보기 → phone sheet on top, phone API blocked) →
//            pre-delegation sheet → 맡기기 (real turn on the server; quota goes up)
//   profile: quota → ticket sheet → 티켓 쓰기 (server confirms, quota back to 0, one basic ticket fewer) → privacy
//            explainer (enclave measurement from the server) → every row pushes its detail (title morphs from the row) ·
//            결제 수단: '아직 연결할 수 없어요', three rows (<ul>) under a conditional label, all above the tab bar, the one
//            action opens 개인 정보 보호
//   schedules (seeded via API): two-line rows · toggle off → server says disabled · row sheet (facts, quoted task) ·
//            바꿔 달라고 하기 and 예약 부탁하기 fill the composer (nothing sent) · two-step delete → server
//   settings.display: theme → data-theme + server; text size slider (keyboard) → --text-scale + server; reset
//   settings.privacy (B): toggles round-trip and each row's subtitle says what a friend's 모시 sees · 보내기 전에 묻기
//            off grows the same group in place (취소 | 끄기, Escape, focus), on is one tap; the server is the truth
//   settings.notifications (B, device permission faked in-page): the device card first, switches disabled with their
//            saved state until asked → 알림 허용하기 → switches work, one round-trips to the server
//   connections: 카카오톡 with BOGUS credentials → Korean error (never a real account)
//   vault: the sealed login from that attempt → 보관 기간 7일 (server) → 접근 기록 (every action key in Korean, the
//          device-key line only on signed rows)
//   friends: no top-bar capsule · the empty state's 친구 초대하기 → the one invite sheet (title from the leading edge,
//            no printed URL, "…까지 · 한 번만" over ONE accent action) → second API user accepts → friend row (list
//            chevron + "…") → the group ends in the 친구 초대하기 row with the how-to as its caption → that row opens
//            the same sheet → shared thread → block (two-step) → unblock; (light) paste a third user's invite link
//            → friend
//   agent: switch a skill off and on (server), memories list
//   archive: draft A on fixture records (page.route): 문서 | 사진·파일, cards led by the title (no plate) with ' · '
//            previews, the document sheet says its title once and puts share / copy under the record, the summary
//            sheet has no panels (caption "4주 · 312,000원", amounts in one right column), the empty 사진·파일 panel
//            has one action and no FAB; plus the artifact sheet (document) from a shared seeded user (real LLM)
// Assertions per pass: 0 console errors, 0 horizontal overflow at every screenshot, Chrome: no long task > 50 ms inside
// interaction windows. Screenshots: docs/qa/more/more-<engine>-<variant>-NN-name.png · results: docs/qa/more/results.json
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
const outDir = process.env.QA_OUT ? path.resolve(process.env.QA_OUT) : path.join(repo, "docs/qa/more"); // QA_OUT: spot re-checks without touching the published set
fs.mkdirSync(outDir, { recursive: true });
const API = process.env.QA_API || "http://127.0.0.1:8792";
const PORT = Number(process.env.QA_PORT || 5186);
const BASE = `http://127.0.0.1:${PORT}`;
// one build dir per preview port (and per app copy): a second run, or a copy of this spec run from another checkout,
// must never rebuild the dir this run is serving from (that once swapped assets out from under a live pass)
const DIST = process.env.QA_DIST || path.join(os.tmpdir(), `pickle-more-qa-dist-${PORT}-${crypto.createHash("sha1").update(appDir).digest("hex").slice(0, 8)}`);
const ENGINES = (process.env.QA_ENGINES || "chromium,webkit").split(",");
const VARIANTS = (process.env.QA_VARIANTS || "light,dark,reduced").split(",");
const ONLY = process.env.QA_ONLY ? new Set(process.env.QA_ONLY.split(",")) : null;
const want = (s) => !ONLY || ONLY.has(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = () => crypto.randomBytes(3).toString("hex");
const PASSWORD = "qa-pass-1234";

// ── server + app ──

async function up(url, needle) {
  try {
    const r = await fetch(url);
    return r.ok && (!needle || (await r.text()).includes(needle));
  } catch {
    return false;
  }
}

async function startPreview() {
  if (!(await up(`${API}/api/health`))) throw new Error(`pickle server is not answering at ${API}`);
  if (await up(`${BASE}/`)) throw new Error(`port ${PORT} is already serving something; set QA_PORT`);
  if (process.env.QA_BUILD !== "0" || !fs.existsSync(path.join(DIST, "index.html"))) {
    const b = spawnSync("bunx", ["vite", "build", "--outDir", DIST, "--emptyOutDir"], { cwd: appDir, stdio: "pipe", encoding: "utf8" });
    if (b.status !== 0) throw new Error(`build failed:\n${b.stdout}\n${b.stderr}`);
  }
  const proc = spawn("bunx", ["vite", "preview", "--outDir", DIST, "--port", String(PORT), "--strictPort", "--host", "127.0.0.1"], {
    cwd: appDir,
    stdio: "ignore",
    env: { ...process.env, PICKLE_API: API },
  });
  for (let i = 0; i < 100; i++) {
    if (await up(`${BASE}/`, "<title>")) return proc;
    await sleep(150);
  }
  proc.kill();
  throw new Error("vite preview did not start");
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
  if (type.includes("text/event-stream")) return { status: res.status, body: await res.text() };
  return { status: res.status, body: type.includes("json") ? await res.json() : await res.text() };
}

async function signupApi(handle, displayName, agentName) {
  for (let i = 0; i < 5; i++) {
    await authSlot();
    const kp = await crypto.webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const jwk = await crypto.webcrypto.subtle.exportKey("jwk", kp.publicKey);
    const r = await api("POST", "/api/auth/signup", { handle, password: PASSWORD, displayName, agentName, device: { id: `qa-${rand()}`, label: "QA", signingKey: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y } } });
    if (r.status === 201 || r.status === 200) return { token: r.body.token, userId: r.body.session?.user?.id, handle };
    if (r.status === 429) {
      await sleep(20_000);
      continue;
    }
    throw new Error(`signup ${handle}: ${r.status} ${JSON.stringify(r.body)}`);
  }
  throw new Error("signup rate limited");
}

async function until(fn, { timeout = 15_000, every = 400, label = "condition" } = {}) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    last = await fn();
    if (last) return last;
    await sleep(every);
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** one artifact (document) for the archive check, shared by every pass (read-only there) */
async function seedArchiveUser() {
  const u = await signupApi(`qaarc${rand()}`, "보관", "깽이");
  const s = await api("GET", "/api/session", undefined, u.token);
  const main = s.body.mainThreadId;
  await api(
    "POST",
    `/api/threads/${main}/messages`,
    { text: "주말 장보기 목록을 문서 아티팩트로 만들어 보관함에 저장해 줘. 질문 없이 바로 만들어 줘. 채소·과일·생활용품 세 칸으로 나누고 체크리스트(- [ ]) 형식으로 써 줘." },
    u.token,
  );
  const arts = await until(async () => {
    const r = await api("GET", "/api/artifacts", undefined, u.token);
    return Array.isArray(r.body) && r.body.length ? r.body : null;
  }, { timeout: 60_000, label: "seeded artifact" }).catch(() => []);
  return { ...u, artifacts: arts.length };
}

// ── page helpers ──

const INIT = () => {
  const qa = (window.__qa = { long: [], windows: [], cur: null });
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

class Pass {
  constructor(engine, variant, page) {
    this.headingFoundation = 0;
    Object.assign(this, { engine, variant, page, tag: `${engine}-${variant}`, n: 0, shots: [], overflows: [], checks: [], errors: [], expected: [], expectedUrls: [], skipped: [] });
  }
  async shot(name) {
    await sleep(this.variant === "reduced" ? 150 : 450);
    const file = `more-${this.tag}-${String(++this.n).padStart(2, "0")}-${name}.png`;
    await this.page.screenshot({ path: path.join(outDir, file) });
    const o = await overflow(this.page);
    if (o.doc > 0 || o.offenders.length) this.overflows.push({ file, ...o });
    this.shots.push(file);
  }
  /** a crisp element-only screenshot (3x), e.g. a list section, for detail review */
  async shotEl(name, locator) {
    await sleep(this.variant === "reduced" ? 150 : 450);
    const file = `more-${this.tag}-${String(++this.n).padStart(2, "0")}-${name}.png`;
    await locator.screenshot({ path: path.join(outDir, file) });
    this.shots.push(file);
  }
  check(name, ok, detail = "") {
    this.checks.push({ name, ok: !!ok, detail: String(detail).slice(0, 300) });
    console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${String(detail).slice(0, 160)}` : ""}`);
  }
  async window(name, fn) {
    await this.page.evaluate((n) => window.__qa?.begin(n), name);
    try {
      return await fn();
    } finally {
      await sleep(this.variant === "reduced" ? 250 : 700);
      await this.page.evaluate(() => window.__qa?.end());
    }
  }
}

const activeScroller = (page) => page.evaluateHandle(() => document.elementFromPoint(195, 430)?.closest(".screen-scroll"));

/**
 * Heading levels on what is in front (an open sheet, else the visible screen): each heading at most one level below
 * the one before it, starting under the screen's h1 / the sheet's h2. Skips by the foundation's ListSection title
 * (`.list-section-title` inside `.list-section`) are counted apart: they wait on ui/List.tsx.
 */
async function headingSkips(page) {
  return page.evaluate(() => {
    const sheets = [...document.querySelectorAll(".sheet-root")].filter((el) => el.getBoundingClientRect().height > 0);
    const root = sheets.at(-1) ?? document.elementFromPoint(195, 430)?.closest(".screen-scroll");
    if (!root) return { mine: ["no root"], foundation: [] };
    const hs = [...root.querySelectorAll("h1, h2, h3, h4, h5, h6")].filter((h) => h.getClientRects().length && !h.closest('[aria-hidden="true"]'));
    let prev = sheets.length ? 1 : 0;
    const mine = [];
    const foundation = [];
    for (const h of hs) {
      const lv = Number(h.tagName[1]);
      if (lv > prev + 1) (h.matches(".list-section .list-section-title") ? foundation : mine).push(`h${prev}→h${lv} ${h.textContent.trim().slice(0, 20)}`);
      prev = lv;
    }
    return { mine, foundation };
  });
}
async function checkHeadings(pass, where) {
  const { mine, foundation } = await headingSkips(pass.page);
  pass.headingFoundation += foundation.length;
  pass.check(`headings: no skipped level on ${where}`, mine.length === 0, [...mine, foundation.length ? `ListSection h3 ×${foundation.length} (foundation)` : ""].filter(Boolean).join(" · "));
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

async function back(page) {
  await page.locator('.tb-circle[aria-label="뒤로"]').click();
  await sleep(750);
}

async function closeSheet(page) {
  const close = page.locator(".sheet-root .sheet-close");
  if (await close.count()) await close.first().click();
  await page.locator(".sheet-root").waitFor({ state: "detached", timeout: 6000 }).catch(() => {});
  await sleep(250);
}

/** ConfirmButton: first tap arms it (label → `armed`), the second tap within 3 s confirms */
async function twoStep(page, label, armed) {
  const h = await page.locator(".sheet-root button", { hasText: label }).first().elementHandle();
  await h.click();
  await page.waitForFunction(([el, t]) => el.textContent?.includes(t), [h, armed], { timeout: 2000 }).catch(() => {});
  await h.click();
}

async function tab(pass, id) {
  await pass.window(`tab-${id}`, () => pass.page.click(`#tab-${id}`));
}

/** scroll the visible screen so `locator` sits mid-screen (the tab bar covers the bottom) */
async function reveal(page, locator) {
  await locator.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await sleep(350);
}

const BRAND_OF = { kakaotalk: "kakaotalk", slack: "slack", slackbot: "slack", discord: "discord", discordbot: "discord", telegram: "telegram", telegrambot: "telegram", line: "line", instagram: "instagram", teams: "teams", webex: "webex", whatsapp: "whatsapp" };

/** For each container: which brand tile it shows, whether its mark is drawn (paths / the Webex image loads), painted, aria-hidden, size. */
async function brandIcons(page, selector, idOf) {
  const els = await page.locator(selector).elementHandles();
  const out = [];
  for (const el of els) {
    const id = await el.evaluate(idOf);
    const r = await el.evaluate(async (row) => {
      const tile = row.querySelector(".brand-icon");
      const svg = tile?.querySelector("svg");
      const cs = tile ? getComputedStyle(tile) : null;
      const im = svg?.querySelector("image");
      // the Webex mark is an <image>: it must actually decode (a 404 draws a broken-image glyph inside the tile)
      const img = im ? await (async () => { const i = new Image(); i.src = im.getAttribute("href"); return i.decode().then(() => i.naturalWidth > 0, () => false); })() : true;
      return {
        got: tile?.getAttribute("data-brand") ?? null,
        marks: svg ? svg.querySelectorAll("path,image,circle,rect").length : 0,
        painted: !!cs && (cs.backgroundImage !== "none" || cs.backgroundColor !== "rgba(0, 0, 0, 0)"),
        hidden: !!tile?.closest('[aria-hidden="true"]'),
        img,
        w: tile ? Math.round(tile.getBoundingClientRect().width) : 0,
      };
    });
    out.push({ id, want: BRAND_OF[id] ?? null, ...r });
  }
  return out;
}

// ── scenarios ──

async function explore(pass, ctx) {
  const { page } = pass;
  await tab(pass, "explore");
  await page.waitForSelector(".tpl-row", { timeout: 15_000 });
  await sleep(600);
  await pass.shot("explore");
  // draft B: categories are words (추천 · 전체 · 혜택 …) with the neutral droplet, no plates or hues
  const words = (await page.locator(".cat-item").allInnerTexts()).map((t) => t.trim());
  pass.check(
    "explore: the rail is words, 전체 right after 추천, no plates",
    words[0] === "추천" && words[1] === "전체" && words.includes("여행") && (await page.locator(".cat-plate, .cat-glyph").count()) === 0 && (await page.locator(".cat-droplet").count()) === 1,
    words.join(" · "),
  );
  pass.check("explore: no trailing capsule in the top bar (menu only)", (await page.locator(".topbar .tb-right-slot > *").count()) === 0);
  pass.check("explore: one accent (no primary button on the root)", (await page.locator('.screen-scroll [data-tone="primary"]:visible').count()) === 0);

  // 추천 = "<agent>의 제안" signed with its face + at most two first tries + "맡길 수 있는 일 전체 N개" (the real list length)
  const total = Object.keys(ctx.exploreCounts).length;
  const suggestHead = page.locator('section[aria-labelledby="explore-suggest"] h2');
  const suggestText = (await suggestHead.innerText().catch(() => "")).trim();
  pass.check("explore: '<agent>의 제안' is signed with the agent's face (no sparkles)", suggestText === `${ctx.agentName}의 제안` && (await suggestHead.locator("svg.avatar").count()) === 1, suggestText);
  const firstTries = await page.locator('section[aria-labelledby="explore-popular"] .tpl-row').evaluateAll((els) => els.map((e) => e.dataset.tpl));
  const allRow = page.locator(".tpl-all");
  const allText = ((await allRow.count()) ? await allRow.innerText() : "").replace(/\s+/g, " ").trim();
  pass.check(
    "explore: 추천 shows at most two first tries, then '맡길 수 있는 일 전체 N개' with the real count",
    firstTries.length >= 1 && firstTries.length <= 2 && allText.startsWith("맡길 수 있는 일 전체") && allText.includes(`${total}개`) && total >= 10,
    `${firstTries.join(",")} · "${allText}" · ${total} templates`,
  );
  // the user's memo: a row about a real service leads with its real app icon (30 px, R.plate 8, mark drawn); the rest
  // keep a bare 22 px glyph — never a tile or plate
  const leadsOf = (sel) =>
    page.locator(sel).evaluateAll((els) =>
      els.map((e) => {
        const tile = e.querySelector(".tpl-lead .brand-icon");
        const glyph = e.querySelector(".tpl-lead > svg");
        return {
          id: e.dataset.tpl,
          brand: tile?.getAttribute("data-brand") ?? null,
          w: tile ? Math.round(tile.getBoundingClientRect().width) : 0,
          r: tile ? parseFloat(getComputedStyle(tile).borderTopLeftRadius) : 0,
          marks: tile ? tile.querySelectorAll("svg path, svg image, svg circle, svg rect").length : 0,
          glyph: glyph ? Math.round(glyph.getBoundingClientRect().width) : 0,
          tiled: !!e.querySelector(".more-plate, .tpl-lead [style*='--h']"),
        };
      }),
    );
  const BRAND = { "kakao-unread": "kakaotalk", "slack-digest": "slack", "connect-kakao": "kakaotalk" };
  const leadOk = (l) => (BRAND[l.id] ? l.brand === BRAND[l.id] && l.w === 30 && l.r === 8 && l.marks > 0 : l.brand === null && l.glyph === 22) && !l.tiled;
  await page.waitForFunction(() => [...document.querySelectorAll(".tpl-lead .brand-icon svg")].every((s) => s.childElementCount > 0), null, { timeout: 5000 }).catch(() => {});
  const recLeads = await leadsOf(".tpl-row");
  pass.check(
    "explore: 추천 rows lead with the real app icon for a service (connect-kakao → kakaotalk), else a bare 22 px glyph",
    recLeads.length > 0 && recLeads.every(leadOk),
    recLeads.map((l) => `${l.id}:${l.brand ?? `glyph${l.glyph}`}`).join(","),
  );

  // the last row selects 전체: the droplet travels to 전체 and every template is listed
  await reveal(page, allRow);
  await pass.shot("explore-end");
  await pass.window("explore-all", () => allRow.click());
  await page.waitForFunction(() => document.querySelector('.cat-item[aria-selected="true"]')?.textContent?.trim() === "전체", null, { timeout: 4000 }).catch(() => {});
  await sleep(900);
  const allIds = await page.locator('section[aria-labelledby="explore-popular"] .tpl-row').evaluateAll((els) => els.map((e) => e.dataset.tpl));
  const selected = (await page.locator('.cat-item[aria-selected="true"]').innerText()).trim();
  const railTop = await page.locator(".cat-rail").evaluate((el) => Math.round(el.getBoundingClientRect().top));
  pass.check("explore: '전체' row selects 전체, lists every template and brings the rail back into view", selected === "전체" && allIds.length === total && railTop >= 0 && railTop < 400, `${selected} · ${allIds.length}/${total} · rail at ${railTop}px`);
  await pass.shot("explore-all");

  // the server's counts were rewritten on the way in (0 / null / missing for the first three): only a real, positive
  // count may say "N명이 맡겼어요" (CP-7); 전체 holds every template, so every rewritten one is on screen here
  const shownCounts = await page
    .locator('section[aria-labelledby="explore-popular"] .tpl-row')
    .evaluateAll((els) => els.map((e) => ({ id: e.dataset.tpl, shown: /명이 맡겼어요/.test(e.textContent ?? "") })));
  const real = (n) => typeof n === "number" && n > 0;
  const wrongCount = shownCounts.filter((r) => r.id in ctx.exploreCounts && r.shown !== real(ctx.exploreCounts[r.id]));
  const rewritten = ctx.exploreRewritten.slice(0, 3);
  const forced = ctx.exploreRewritten[3];
  pass.check(
    "explore: '명이 맡겼어요' only for a real count (0 / null / missing → nothing)",
    rewritten.length === 3 && rewritten.every((id) => shownCounts.some((r) => r.id === id && !r.shown)) && shownCounts.some((r) => r.id === forced && r.shown) && wrongCount.length === 0,
    `silent ${rewritten.join(",")} · 1234 ${forced} · real ${Object.values(ctx.exploreCounts).filter(real).length} · shown ${shownCounts.filter((r) => r.shown).length} · wrong ${wrongCount.map((r) => r.id).join(",") || "none"}`,
  );
  await page.waitForFunction(() => [...document.querySelectorAll(".tpl-lead .brand-icon svg")].every((s) => s.childElementCount > 0), null, { timeout: 5000 }).catch(() => {});
  const allLeads = await leadsOf('section[aria-labelledby="explore-popular"] .tpl-row');
  const badLeads = allLeads.filter((l) => !leadOk(l));
  pass.check(
    "explore: 전체 — kakaotalk / slack templates lead with their app icon (30 px, R.plate), every other row a bare 22 px glyph, no tiles",
    allLeads.length === total && badLeads.length === 0 && ["kakao-unread", "slack-digest"].every((id) => allLeads.some((l) => l.id === id && l.brand)),
    badLeads.map((b) => JSON.stringify(b)).join(" ") || allLeads.filter((l) => l.brand).map((l) => `${l.id}=${l.brand}`).join(","),
  );

  await pass.window("category-travel", () => page.locator(".cat-item", { hasText: "여행" }).click());
  await sleep(500);
  await pass.shot("explore-travel");
  const travel = await page.locator('section[aria-labelledby="explore-popular"] .tpl-row').evaluateAll((els) => els.filter((e) => e.offsetParent).map((e) => e.dataset.tpl));
  pass.check("explore: 여행 filters to travel templates", travel.length > 0 && travel.includes("jeju-trip") && !travel.includes("crowd-check"), travel.join(","));
  await pass.window("category-recommend", () => page.locator(".cat-item", { hasText: "추천" }).click());
  await sleep(500);

  // call-demo without a verified number (draft B sheet): title from the leading edge, numbered step, the missing number
  // and the cost in one block over "인증하고 받아 보기". That button hands over to the phone sheet (one sheet at a time);
  // once the number is verified the pre-delegation sheet comes back out of its row with "전화 받아 보기". Every phone
  // path is mocked here (the real server would place an actual call): nothing may fall through.
  const pm = { phone: null, puts: 0, verifies: 0, other: 0 };
  const profileRe = /\/api\/profile(\?.*)?$/;
  const phoneRe = /\/api\/profile\/phone(\/|\?|$)/;
  const onProfile = async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const res = await route.fetch();
    const body = await res.json();
    await route.fulfill({ response: res, json: { ...body, phone: pm.phone } });
  };
  const onPhone = async (route) => {
    const req = route.request();
    const body = (() => {
      try {
        return req.postDataJSON();
      } catch {
        return null;
      }
    })();
    await sleep(300);
    if (req.method() === "PUT") {
      pm.puts++;
      const d = String(body?.phone ?? "").replace(/\D/g, "");
      pm.phone = { masked: `${d.slice(0, 3)}-****-${d.slice(-4)}`, verified: false };
      return route.fulfill({ json: pm.phone });
    }
    if (req.method() === "POST" && req.url().endsWith("/verify") && body?.code === "4321") {
      pm.verifies++;
      pm.phone = { ...pm.phone, verified: true };
      return route.fulfill({ json: pm.phone });
    }
    pm.other++;
    return route.fulfill({ status: 404, json: { error: "not_found" } });
  };
  await page.route(profileRe, onProfile);
  await page.route(phoneRe, onPhone);
  try {
    const call = page.locator('.tpl-row[data-tpl="call-demo"]');
    await reveal(page, call);
    await pass.window("predelegate-call-open", () => call.click());
    await page.waitForSelector(".sheet-root .pre-steps", { timeout: 6000 });
    await page.waitForSelector('.sheet-root .pre-need[data-need="phone"]', { timeout: 6000 }).catch(() => {});
    await sleep(600);
    await pass.shot("predelegate-call");
    const s = await page.locator(".sheet-root").evaluate((root) => ({
      align: getComputedStyle(root.querySelector(".sheet-title")).textAlign,
      steps: [...root.querySelectorAll(".pre-step")].map((li) => li.textContent.replace(/\s+/g, " ").trim()),
      need: root.querySelector('.pre-need[data-need="phone"]')?.textContent.replace(/\s+/g, " ").trim() ?? "",
      facts: root.querySelector(".pre-facts")?.textContent.trim() ?? "",
      primary: [...root.querySelectorAll('[data-tone="primary"]')].map((b) => b.textContent.trim()),
      inFooter: !!root.querySelector(".pre-footer .pre-need"),
    }));
    pass.check(
      "pre-delegation (call-demo): title from the leading edge, numbered step, 내 전화번호 + cost line over ONE '인증하고 받아 보기'",
      ["left", "start"].includes(s.align) &&
        s.steps.length === 1 && s.steps[0].startsWith("1") && s.steps[0].includes("내 휴대폰으로 전화 걸기") &&
        s.need.includes("내 전화번호") && s.need.includes("인증해야 전화를 받을 수 있어요") && s.inFooter &&
        /^약 1분 · 한도 약 \d+% · 오늘 \d+% 남음$/.test(s.facts) &&
        s.primary.length === 1 && s.primary[0] === "인증하고 받아 보기",
      JSON.stringify(s),
    );
    await checkHeadings(pass, "pre-delegation sheet (call-demo)");
    await pass.window("phone-from-predelegate", () => page.locator(".sheet-root .pre-footer button", { hasText: "인증하고 받아 보기" }).click());
    await page.waitForSelector('.sheet-root .phone-step[data-step="enter"]', { timeout: 6000 }).catch(() => {});
    await page.waitForFunction(() => !document.querySelector(".sheet-root .pre-steps"), null, { timeout: 6000 }).catch(() => {});
    await sleep(500);
    await pass.shot("predelegate-phone");
    const top = (await page.locator(".sheet-root .sheet-title").first().innerText().catch(() => "")).trim();
    pass.check("pre-delegation (call-demo): '인증하고 받아 보기' hands over to 내 전화번호 (one sheet at a time)", (await page.locator(".sheet-root").count()) === 1 && top === "내 전화번호", top);
    await page.locator('.sheet-root input[type="tel"]').fill("01000005432");
    await page.locator(".sheet-root .phone-call").click();
    await page.waitForSelector('.sheet-root .phone-step[data-step="code"]', { timeout: 8000 });
    await sleep(600);
    await page.locator(".sheet-root .phone-otp__input").click();
    await page.keyboard.type("4321", { delay: 60 });
    // the phone sheet holds its check, folds away, and the pre-delegation sheet morphs back with the need resolved
    await page.waitForFunction(() => document.querySelector(".sheet-root .pre-steps") && !document.querySelector(".sheet-root .phone-step"), null, { timeout: 10_000 }).catch(() => {});
    await sleep(700);
    await pass.shot("predelegate-call-verified");
    const after = await page.locator(".sheet-root").first().evaluate((root) => ({
      need: !!root.querySelector('.pre-need[data-need="phone"]'),
      primary: [...root.querySelectorAll('[data-tone="primary"]')].map((b) => b.textContent.trim()),
    })).catch(() => ({ need: null, primary: [] }));
    pass.check(
      "pre-delegation (call-demo): verified → the sheet comes back with '전화 받아 보기' and no 내 전화번호 line (phone API mocked, nothing fell through)",
      (await page.locator(".sheet-root").count()) === 1 && after.need === false && after.primary.length === 1 && after.primary[0] === "전화 받아 보기" && pm.puts === 1 && pm.verifies === 1 && pm.other === 0,
      `${JSON.stringify(after)} · put ${pm.puts} · verify ${pm.verifies} · other ${pm.other}`,
    );
    await closeSheet(page);
  } finally {
    await page.unroute(profileRe, onProfile);
    await page.unroute(phoneRe, onPhone);
  }

  // pre-delegation sheet → 맡기기 (real turn)
  await pass.window("category-all", () => page.locator(".cat-item", { hasText: "전체" }).click());
  await sleep(500);
  const row = page.locator('.tpl-row[data-tpl="crowd-check"]');
  await reveal(page, row);
  await pass.window("predelegate-open", () => row.click());
  await page.waitForSelector(".sheet-root .pre-steps", { timeout: 6000 });
  await sleep(400);
  await pass.shot("predelegate-sheet");
  await checkHeadings(pass, "pre-delegation sheet");
  const sheetText = await page.locator(".sheet-root").innerText();
  pass.check(
    "pre-delegation: says what it does (numbered), the cost line, and lists nothing already in place",
    /이렇게 해요/.test(sheetText) && (await page.locator(".sheet-root .pre-step").count()) >= 1 && /약 \d+(초|분) · 한도 약 \d+% · 오늘 \d+% 남음/.test(sheetText) && (await page.locator(".sheet-root .pre-need").count()) === 0,
    sheetText.replace(/\s+/g, " ").slice(0, 160),
  );
  const before = (await api("GET", "/api/session", undefined, ctx.a.token)).body.quota.usedTokens;
  const delegated = page
    .waitForResponse((r) => r.request().method() === "POST" && /\/api\/explore\/crowd-check\/delegate$/.test(r.url()), { timeout: 10_000 })
    .then((r) => r.json())
    .catch(() => null);
  await page.locator(".sheet-root button", { hasText: "맡기기" }).click();
  const tid = (await delegated)?.thread?.id ?? null;
  await page.waitForSelector('#tab-chat[aria-selected="true"]', { timeout: 10_000 });
  await page.waitForSelector(".thread-intro-title", { timeout: 10_000 }).catch(() => {});
  await sleep(1200);
  await pass.shot("delegated-thread");
  // the reply must land in the delegated thread itself (quota alone would also move for any other turn of the account)
  const q = await until(
    async () => {
      if (!tid) return null;
      const msgs = (await api("GET", `/api/threads/${tid}/messages`, undefined, ctx.a.token)).body;
      const replied = Array.isArray(msgs) && msgs.some((m) => m.role === "user") && msgs.some((m) => m.role === "assistant" && (m.text?.trim() || m.cards?.length));
      if (!replied) return null;
      const s = await api("GET", "/api/session", undefined, ctx.a.token);
      return s.body.quota.usedTokens > before ? s.body.quota : null;
    },
    { timeout: 180_000, every: 2000, label: "delegated turn to finish (reply in the thread, quota)" },
  ).catch((e) => (pass.check("delegate: turn finished on the server", false, `${tid ?? "no thread"} · ${e.message}`), null));
  if (q) pass.check("delegate: the turn ran in the delegated thread, quota went up", q.usedPct > 0, `${q.usedPct}% (${q.usedTokens} tokens)`);
  await sleep(1500);
  await pass.shot("delegated-thread-done");
}

async function profile(pass, ctx) {
  const { page } = pass;
  await tab(pass, "profile");
  await page.waitForSelector(".profile-quota", { timeout: 10_000 });
  await sleep(900);
  await pass.shot("profile");
  await checkHeadings(pass, "나의 모시");
  // spaces folded first: copy() ties a lone "·" to the word before it with a nbsp ("3장\u00a0·")
  const ticketsText = (await page.locator(".profile-tickets").innerText()).replace(/\s+/g, " ");
  pass.check("profile: ticket kinds in words, one value '기본 N장 · 프리미엄 N장' (CL-1, my-mosi B)", /기본 \d+장 · 프리미엄 \d+장/.test(ticketsText), ticketsText);
  // my-mosi B: one list grammar — server-ordered section titles, no icon column, the agent group first, an empty centre
  const hub = await page.evaluate(() => {
    const scroll = document.querySelector(".screen-scroll.profile");
    return {
      titles: [...(scroll?.querySelectorAll(".list-section-title") ?? [])].map((h) => h.textContent.trim()),
      plates: scroll?.querySelectorAll(".list-row-plate").length ?? -1,
      papers: scroll?.querySelectorAll(".paper").length ?? -1,
      first: scroll?.querySelector(".more-stack > *")?.classList.contains("profile-agent-group") ?? false,
      agentLabel: scroll?.querySelector(".profile-agent")?.getAttribute("aria-label") ?? "",
      persona: scroll?.querySelector(".profile-agent__persona")?.textContent ?? "",
      foot: scroll?.querySelector(".profile-section--quota .list-footer")?.textContent ?? "",
      chart: !!scroll?.querySelector(".profile-usage"),
    };
  });
  pass.check("profile B: sections 사용량 · 내 계정 · agent · 개인 정보와 보안 · 앱 사용 (SDUI order)", hub.titles.join("/") === ["사용량", "내 계정", ctx.agentName, "개인 정보와 보안", "앱 사용"].join("/"), hub.titles.join(" / "));
  pass.check("profile B: no icon column, no cards; the agent group comes first", hub.plates === 0 && hub.papers === 0 && hub.first, `${hub.plates} plates · ${hub.papers} papers · first=${hub.first}`);
  pass.check("profile B: the agent row reads its persona's first sentence, labelled '<name> 설정'", hub.agentLabel === `${ctx.agentName} 설정` && hub.persona.length > 0 && !/[.!?]\s+\S/.test(hub.persona.trim()), `${hub.agentLabel} · ${hub.persona}`);
  pass.check("profile B: the 7-day history is one footer line when empty, a chart row otherwise", hub.chart ? hub.foot === "" : /최근 7일 동안 쓴 기록이 아직 없어요/.test(hub.foot), hub.chart ? "chart row" : hub.foot);
  await (await activeScroller(page)).evaluate((el) => el?.scrollTo(0, el.scrollHeight));
  const swapped = await page
    .waitForFunction(() => document.querySelector(".topbar .tb-title")?.textContent.trim() === "나의 모시", null, { timeout: 4000 })
    .then(() => true)
    .catch(() => false);
  pass.check("profile B: scrolled, '나의 모시' comes into the top bar centre (content swap)", swapped);
  await sleep(400);
  await pass.shot("profile-scrolled");
  await (await activeScroller(page)).evaluate((el) => el?.scrollTo(0, 0));
  await sleep(600);

  // tickets
  const s0 = (await api("GET", "/api/session", undefined, ctx.a.token)).body;
  await pass.window("tickets-open", () => page.click(".profile-tickets"));
  await page.waitForSelector(".ticket-body", { timeout: 6000 });
  await pass.shot("tickets-sheet");
  await checkHeadings(pass, "tickets sheet");
  const tk = await page.evaluate(() => {
    const body = document.querySelector(".ticket-body");
    const btn = [...(body?.querySelectorAll("button") ?? [])].find((b) => b.textContent.includes("티켓 쓰기"));
    return {
      now: !!body?.querySelector(".ticket-now"),
      why: body?.querySelector(".ticket-why")?.textContent ?? "",
      plates: body?.querySelectorAll(".more-sheet-row__icon").length ?? -1,
      disabled: !!btn?.disabled,
      opacity: btn ? getComputedStyle(btn).opacity : "",
      label: body?.querySelector("h3")?.textContent.trim() ?? "",
    };
  });
  pass.check(
    "tickets B: no plates; with nothing to reset there is no usage panel and the reason sits above an off button (a fill, not a faded accent)",
    tk.plates === 0 && tk.label === "쓸 티켓" && (s0.quota.usedPct > 0 ? tk.now : !tk.now && /초기화할 사용량이 없어요/.test(tk.why) && tk.disabled && tk.opacity === "1"),
    JSON.stringify(tk),
  );
  const useBtn = page.locator(".ticket-body button", { hasText: "티켓 쓰기" });
  if (s0.quota.usedPct > 0 && (await useBtn.isEnabled())) {
    await useBtn.click();
    await page.locator(".sheet-root").waitFor({ state: "detached", timeout: 15_000 }).catch(() => {});
    const s1 = (await api("GET", "/api/session", undefined, ctx.a.token)).body;
    pass.check("tickets: server reset the quota and spent one basic ticket", s1.quota.usedPct === 0 && s1.tickets.basic === s0.tickets.basic - 1, `${s0.quota.usedPct}%→${s1.quota.usedPct}%, basic ${s0.tickets.basic}→${s1.tickets.basic}`);
    await sleep(900);
    await pass.shot("profile-after-ticket");
  } else {
    pass.skipped.push(`tickets: nothing to reset (usedPct ${s0.quota.usedPct})`);
    await closeSheet(page);
  }

  // privacy explainer
  const priv = page.locator(".profile-privacy");
  await reveal(page, priv);
  await pass.window("privacy-open", () => priv.click());
  await page.waitForSelector(".privacy-body", { timeout: 6000 });
  await pass.shot("privacy-sheet");
  await checkHeadings(pass, "privacy sheet");
  pass.check(
    "privacy sheet: the three questions are headings with no tiles (GR-R1); it keeps the explainer",
    (await page.locator(".privacy-line h3").count()) === 3 && (await page.locator(".privacy-line__icon").count()) === 0 && /암호화된 채로만/.test(await page.locator(".privacy-body").innerText()),
  );
  const links = await page.locator(".privacy-body .privacy-link").allInnerTexts();
  const linkH = (await page.locator(".privacy-body .privacy-link").first().boundingBox())?.height ?? 0;
  pass.check(
    "privacy B: the shortcuts are 44px text links under their answers, no button pair; the sheet ends on 자세히 보기",
    links.join("/") === "접근 기록 보기/저장된 로그인 보기" && linkH >= 44 && (await page.locator(".privacy-body .more-actions").count()) === 0 && (await page.locator(".privacy-body > :last-child").evaluate((el) => el.classList.contains("privacy-more"))),
    `${links.join(" / ")} · ${linkH}px`,
  );
  await pass.window("privacy-details", () => page.click(".privacy-more"));
  const m = await page
    .waitForFunction(() => /^[0-9a-f]{64}$/.test(document.querySelector(".privacy-hash")?.getAttribute("data-measurement") ?? ""), null, { timeout: 8000 })
    .then(() => page.locator(".privacy-hash").first().getAttribute("data-measurement"))
    .catch(() => null);
  const enc = (await api("GET", "/api/enclave", undefined, ctx.a.token)).body;
  pass.check("privacy: shows the enclave's real measurement", m && m === enc.measurement, m ?? "none");
  await pass.shot("privacy-details");
  await closeSheet(page);
  // a link closes the sheet and opens what it names
  await reveal(page, priv);
  await priv.click();
  await page.waitForSelector(".privacy-body .privacy-link", { timeout: 6000 });
  await sleep(400);
  await page.locator(".privacy-body .privacy-link", { hasText: "접근 기록 보기" }).click();
  pass.check("privacy B: 접근 기록 보기 opens 접근 기록", await titleVisible(page, "접근 기록"));
  await back(page);

  // every row pushes a detail whose title morphs out of the row
  const rows = [
    ["결제 수단", "결제 수단"],
    ["저장된 로그인", "저장된 로그인"],
    ["정보 공개 범위", "정보 공개 범위"],
    ["예약된 일", "예약된 일"],
    ["접근 기록", "접근 기록"],
    ["친구", "친구"],
    ["알림 설정", "알림 설정"],
    ["화면 및 디자인", "화면 및 디자인"],
  ];
  for (const [label, title] of rows) {
    const r = page.locator(".screen-scroll .list-row", { hasText: label }).first();
    if (!(await r.count())) {
      pass.check(`profile row "${label}" exists`, false);
      continue;
    }
    await reveal(page, r);
    await pass.window(`push-${label}`, () => r.click());
    const okTitle = await titleVisible(page, title);
    pass.check(`profile → ${label}: detail title "${title}"`, okTitle);
    await pass.shot(`detail-${title.replace(/\s+/g, "")}`);
    await checkHeadings(pass, label);
    if (label === "결제 수단") {
      const text = await (await activeScroller(page)).evaluate((el) => el?.innerText ?? "");
      pass.check("payment: no step tiles, the sealing story not repeated (CP-5, IT-16)", !/암호화|원문/.test(text) && (await page.locator(".pay-step__icon").count()) === 0 && /결제할 때마다 물어봐요/.test(text));
      const pay = await (await activeScroller(page)).evaluate((el) => {
        const list = el?.querySelector(".pay-steps");
        const rows = [...(list?.querySelectorAll(":scope > li") ?? [])];
        const bar = document.querySelector(".tabbar")?.getBoundingClientRect();
        return {
          title: el?.querySelector(".empty-state__title")?.textContent.trim() ?? "",
          body: el?.querySelector(".empty-state__body")?.textContent.trim() ?? "",
          action: el?.querySelector(".empty-state__action .btn-label")?.textContent.trim() ?? "",
          label: el?.querySelector(".pay-how .more-label")?.textContent.trim() ?? "",
          tag: list?.tagName ?? "",
          rows: rows.length,
          lastBottom: Math.round(rows.at(-1)?.getBoundingClientRect().bottom ?? 9999),
          barTop: Math.round(bar?.top ?? 0),
        };
      });
      pass.check(
        "payment: the state says it can't be connected yet (not 'none yet'), one sentence, the action names what it shows (P2-1)",
        pay.title === "아직 연결할 수 없어요" && !/아직 연결된 결제 수단이 없어요/.test(text) && /^[^.]+\.$/.test(pay.body) && pay.action === "로그인 정보는 어떻게 지키는지 보기",
        `${pay.title} · ${pay.body} · ${pay.action}`,
      );
      pass.check(
        "payment: three plain rows (a <ul>) under a conditional label, no quoted setting name (P2-2, GR-R2)",
        pay.tag === "UL" && pay.rows === 3 && pay.label === "결제 수단을 연결할 수 있게 되면" && !/"보내기 전에 묻기"/.test(text) && /정보 공개 범위 설정과 관계없어요/.test(text),
        `${pay.tag} · ${pay.rows} rows · ${pay.label}`,
      );
      pass.check("payment: all three rows end above the tab bar on the first view (P3-1)", pay.barTop > 0 && pay.lastBottom <= pay.barTop, `last row ends ${pay.lastBottom} · tab bar ${pay.barTop}`);
      await pass.window("payment-privacy", () => page.locator(".empty-state__action button").click());
      const sheetTitle = await page
        .waitForSelector(".sheet-root .sheet-title", { timeout: 6000 })
        .then((h) => h.textContent())
        .catch(() => "");
      pass.check("payment: 로그인 정보는 어떻게 지키는지 보기 opens 개인 정보 보호", sheetTitle?.trim() === "개인 정보 보호", sheetTitle ?? "");
      await pass.shot("payment-privacy");
      await closeSheet(page);
    }
    await back(page);
  }
  for (const [sel, title, name] of [
    [".profile-agent", ctx.agentName, "agent"],
    [".profile-conns", "앱 연결", "connections"],
    [".profile-account", "내 계정", "account"],
  ]) {
    const el = page.locator(`.screen-scroll ${sel}`).first();
    await reveal(page, el);
    await pass.window(`push-${name}`, () => el.click());
    pass.check(`profile → ${name}: detail title "${title}"`, await titleVisible(page, title));
    await pass.shot(`detail-${name}`);
    await checkHeadings(pass, name);
    if (name === "account") {
      const ac = await (await activeScroller(page)).evaluate((el) => ({
        plates: el?.querySelectorAll(".list-row-plate").length ?? -1,
        text: el?.innerText ?? "",
        logout: el?.querySelector(".account-logout .btn .btn-label")?.textContent.trim() ?? "",
        agentRow: !!el?.querySelector(".account-agent .list-row-chevron"),
      }));
      pass.check(
        "account B: no plates, no model id; 모시 이름 is a row to the agent; sign-out is its own red row",
        ac.plates === 0 && !/AI 모델/.test(ac.text) && ac.logout === "이 기기에서 로그아웃" && ac.agentRow,
        `${ac.plates} plates · ${ac.logout}`,
      );
      await page.locator(".account-logout .btn").click();
      const armed = await page
        .waitForFunction(() => /한 번 더 누르면 로그아웃해요/.test(document.querySelector(".account-logout .btn")?.textContent ?? ""), null, { timeout: 2000 })
        .then(() => true)
        .catch(() => false);
      pass.check("account B: 로그아웃 asks again in place (§8.6), still signed in", armed && !!(await api("GET", "/api/session", undefined, ctx.a.token)).body?.user);
      await pass.shot("account-logout-armed");
    }
    if (name === "connections") {
      // draft B: the screen's one sentence is the large title's subtitle; no page note, no encryption line (CP-5)
      const intro = await (await activeScroller(page)).evaluate((el) => ({ sub: el?.querySelector(".conn-title .large-title-sub")?.textContent ?? "", notes: el?.querySelectorAll(".more-note").length ?? -1 }));
      pass.check("connections: the one sentence is the title's subtitle, no page note (CP-5, draft B)", /대화를 읽고/.test(intro.sub) && !/암호화/.test(intro.sub) && intro.notes === 0, `${intro.sub.slice(0, 60)} · ${intro.notes} notes`);
    }
    await back(page);
  }
}

async function schedules(pass, ctx) {
  const { page } = pass;
  const [s0, s1, s2] = ctx.schedules;
  const rowOf = (s) => page.locator(`.sched-row[data-schedule="${s.id}"]`);
  const openSchedules = async () => {
    await tab(pass, "profile");
    if (await page.locator(".sched-row").first().isVisible().catch(() => false)) return;
    const row = page.locator(".screen-scroll .list-row", { hasText: "예약된 일" }).first();
    await reveal(page, row);
    await row.click();
    await page.waitForSelector(".sched-row", { timeout: 10_000 });
  };
  /** nav.compose: the chat tab opens with `text` in the composer and nothing sent; the composer is emptied after */
  const composed = async (text) => {
    const field = page.locator("textarea.composer-field").first();
    await field.waitFor({ state: "visible", timeout: 8000 }).catch(() => {});
    const value = await until(async () => {
      const v = await field.inputValue().catch(() => "");
      return v === text ? v : null;
    }, { timeout: 6000, label: "composer text" }).catch(async () => field.inputValue().catch(() => ""));
    const bubbles = await page.locator(".screen-scroll", { hasText: text }).locator(`text="${text}"`).count().catch(() => 0);
    await field.fill("").catch(() => {});
    return { ok: value === text && bubbles === 0, value, bubbles };
  };
  await openSchedules();
  await pass.shot("schedules");
  // copy() ties words over a nbsp ("깨워\u00a0줘”처럼"): fold it before matching plain text
  const schedText = (await (await activeScroller(page)).evaluate((el) => el?.innerText ?? "")).replace(/\u00a0/g, " ");
  const capsule = page.locator(".screen-scroll .sched-new button", { hasText: `${ctx.agentName}에게 예약 부탁하기` });
  pass.check(
    "schedules: one add action (the capsule under the list, named for the agent), no top-bar +, hint names the agent",
    (await capsule.count()) === 1 &&
      (await page.locator('.tb-circle[aria-label="새 예약 만들기"]').count()) === 0 &&
      schedText.includes(`“매일 7시 30분에 깨워 줘”처럼 말하면 ${ctx.agentName}가 예약을 만들어요`),
    schedText.match(/처럼 말하면[^\n]*/)?.[0] ?? "",
  );
  const r0 = (await rowOf(s0).innerText()).replace(/\s+/g, " ");
  const r2 = (await rowOf(s2).innerText()).replace(/\s+/g, " ");
  pass.check(
    "schedules: two-line rows, no tiles ('매일 오전 7:30 · 다음은 …', off → '꺼져 있어요')",
    (await page.locator(".sched-row .sched-main svg").count()) === 0 &&
      /모닝콜 매일 오전 7:30 · 다음은 (오늘|내일)/.test(r0) &&
      /저녁 브리핑 매일 오후 9:30 · 꺼져 있어요/.test(r2) &&
      !/다음 오늘|다음 실행 없음/.test(schedText),
    `${r0} | ${r2}`,
  );
  const toggle = rowOf(s1).locator('[role="switch"]');
  await pass.window("schedule-toggle", () => toggle.click());
  const off = await until(async () => {
    const l = (await api("GET", "/api/schedules", undefined, ctx.a.token)).body;
    return l.find((s) => s.id === s1.id)?.enabled === false;
  }, { timeout: 8000, label: "schedule disabled" }).catch(() => false);
  pass.check("schedules: toggle off reaches the server", off);
  pass.check("schedules: row says 꺼져 있어요", /평일 오전 9:00 · 꺼져 있어요/.test((await rowOf(s1).innerText()).replace(/\s+/g, " ")));
  await pass.shot("schedules-toggled");

  await pass.window("schedule-sheet", () => rowOf(s0).locator(".sched-main").click());
  await page.waitForSelector(".sheet-root .sched-quote", { timeout: 6000 });
  await pass.shot("schedule-sheet");
  const sheet = page.locator(".sheet-root");
  const facts = (await sheet.locator(".sched-fact").allInnerTexts()).map((t) => t.replace(/\s+/g, " ").trim());
  const asked = await sheet.locator("h3", { hasText: `${ctx.agentName}에게 맡긴 일` }).count();
  const quote = (await sheet.locator(".sched-quote").innerText()).trim();
  const del = sheet.locator("button", { hasText: "예약 지우기" }).first();
  const delBox = await del.boundingBox();
  const sheetBox = await sheet.locator(".sched-danger").boundingBox();
  pass.check(
    "schedule sheet: label/value facts on hairlines, the task as quoted text (h3), a change button, a compact delete",
    facts.length === 3 && facts[0] === "반복 매일 오전 7:30" && /^다음 실행 (오늘|내일) 오전 7:30$/.test(facts[1]) && facts[2] === "마지막 실행 아직 없어요" &&
      asked === 1 && quote === "“7시 30분에 전화로 깨워 줘”" &&
      (await sheet.locator("button", { hasText: `${ctx.agentName}에게 바꿔 달라고 하기` }).count()) === 1 &&
      (await sheet.locator(".more-sheet-rows, .more-sheet-row__icon").count()) === 0 &&
      !!delBox && !!sheetBox && delBox.width < sheetBox.width * 0.6,
    `${facts.join(" / ")} | ${quote} | delete ${Math.round(delBox?.width ?? 0)}/${Math.round(sheetBox?.width ?? 0)}`,
  );
  // 바꿔 달라고 하기 → the chat with "모닝콜 바꿔 줘" in the composer, nothing sent
  await pass.window("schedule-change", () => sheet.locator("button", { hasText: `${ctx.agentName}에게 바꿔 달라고 하기` }).click());
  await page.locator(".sheet-root").waitFor({ state: "detached", timeout: 6000 }).catch(() => {});
  const changed = await composed("모닝콜 바꿔 줘");
  pass.check("schedule sheet: 바꿔 달라고 하기 fills the composer with '모닝콜 바꿔 줘' and sends nothing", changed.ok, JSON.stringify(changed));
  // the capsule → the chat with the example sentence in the composer, nothing sent
  await openSchedules();
  await pass.window("schedule-new", () => page.locator(".screen-scroll .sched-new button").first().click());
  const asked2 = await composed("매일 7시 30분에 깨워 줘");
  pass.check("schedules: 예약 부탁하기 fills the composer with the example and sends nothing", asked2.ok, JSON.stringify(asked2));
  // §8.6 two-step delete: the sheet closes only after the server confirms, and the row goes
  await openSchedules();
  await pass.window("schedule-sheet-2", () => rowOf(s2).locator(".sched-main").click());
  await page.waitForSelector(".sheet-root .sched-quote", { timeout: 6000 });
  await twoStep(page, "예약 지우기", "한 번 더 누르면 지워요");
  await page.locator(".sheet-root").waitFor({ state: "detached", timeout: 8000 }).catch(() => {});
  const gone = await until(async () => {
    const l = (await api("GET", "/api/schedules", undefined, ctx.a.token)).body;
    return !l.some((s) => s.id === s2.id);
  }, { timeout: 8000, label: "schedule deleted" }).catch(() => false);
  await sleep(400);
  pass.check("schedule sheet: two-step delete reaches the server and the row goes", gone && (await rowOf(s2).count()) === 0);
  await closeSheet(page);
  await back(page);
}

async function display(pass, ctx) {
  const { page } = pass;
  const row = page.locator(".screen-scroll .list-row", { hasText: "화면 및 디자인" }).first();
  await reveal(page, row);
  await row.click();
  await titleVisible(page, "화면 및 디자인");
  // settings B: the theme is a choice list with one checkmark, preview + slider are one paper, overrides say their value
  const themeGroup = page.locator('[role="radiogroup"][aria-label="테마"]');
  const radios = themeGroup.locator('[role="radio"]');
  pass.check(
    "display: theme is a choice list (3 rows, one checked, one checkmark)",
    (await radios.count()) === 3 && (await themeGroup.locator('[role="radio"][aria-checked="true"]').count()) === 1 && (await themeGroup.locator(".settings-choice__check").count()) === 1,
  );
  const paper = page.locator(".list-card", { has: page.locator(".text-preview") });
  const bubbles = await page.evaluate(() => {
    const bg = (sel) => getComputedStyle(document.querySelector(sel)).backgroundColor;
    return { me: bg(".text-preview__me"), agent: bg(".text-preview__agent") };
  });
  pass.check(
    "display: preview and slider share one paper; my line is a bubble, the agent's is plain text",
    (await paper.count()) === 1 && (await paper.locator('[role="slider"]').count()) === 1 && !/rgba\(0, 0, 0, 0\)|transparent/.test(bubbles.me) && /rgba\(0, 0, 0, 0\)|transparent/.test(bubbles.agent),
    JSON.stringify(bubbles),
  );
  const nows = await (await activeScroller(page)).evaluate((el) => [...(el?.querySelectorAll(".settings-override__now") ?? [])].map((x) => x.textContent.trim()));
  pass.check("display: each override row says its current value", nows.length === 2 && nows.every((x) => /^지금은 (켜짐|꺼짐)$/.test(x)), nows.join(" / "));
  const startTheme = await page.evaluate(() => document.documentElement.dataset.theme);
  const flip = startTheme === "dark" ? "라이트" : "다크";
  const flipRadio = radios.filter({ hasText: flip }).first();
  await pass.window("theme-switch", () => flipRadio.click());
  const flipped = await page.waitForFunction((s) => document.documentElement.dataset.theme !== s, startTheme, { timeout: 4000 }).then(() => true).catch(() => false);
  const sTheme = await until(async () => (await api("GET", "/api/session", undefined, ctx.a.token)).body?.settings?.display?.theme === (flip === "다크" ? "dark" : "light"), { timeout: 6000, label: "theme saved" }).catch(() => false);
  pass.check("display: theme applies live and is saved", flipped && sTheme, `${startTheme} → ${await page.evaluate(() => document.documentElement.dataset.theme)}`);
  pass.check("display: the checkmark moved to the chosen row", (await flipRadio.getAttribute("aria-checked")) === "true" && (await flipRadio.locator(".settings-choice__check").count()) === 1 && (await themeGroup.locator(".settings-choice__check").count()) === 1);
  await pass.shot("display-theme-flipped");

  const slider = page.getByRole("slider", { name: "글자 크기" });
  await slider.focus();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  const scale = await page.waitForFunction(() => Math.abs(parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--text-scale")) - 1.1) < 0.001, null, { timeout: 4000 }).then(() => true).catch(() => false);
  const sScale = await until(async () => Math.abs(((await api("GET", "/api/session", undefined, ctx.a.token)).body?.settings?.display?.textScale ?? 0) - 1.1) < 0.001, { timeout: 6000, label: "text scale saved" }).catch(() => false);
  pass.check("display: text size applies live (--text-scale 1.1) and is saved", scale && sScale);
  await pass.shot("display-text-110");
  // back to defaults (system theme, 100%): the theme by keyboard — the checked row is the one tab stop, arrows choose
  const saved = (want, label) =>
    until(async () => {
      const d = (await api("GET", "/api/session", undefined, ctx.a.token)).body?.settings?.display;
      return !!d && want(d);
    }, { timeout: 10000, label }).catch(() => false);
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  const scaleBack = await saved((d) => Math.abs(d.textScale - 1) < 0.001, "text scale back to 1");
  await flipRadio.focus();
  // 다크 (3rd) goes up twice; 라이트 (2nd) goes down twice and wraps — every arrow chooses, like a radio group.
  // Each step is waited for on the server so the check does not race the view transition and the save.
  const key = flip === "다크" ? "ArrowUp" : "ArrowDown";
  await page.keyboard.press(key);
  const mid = await saved((d) => d.theme === (flip === "다크" ? "light" : "dark"), "first arrow saved");
  await page.keyboard.press(key);
  const reset = scaleBack && mid && (await saved((d) => d.theme === "system" && Math.abs(d.textScale - 1) < 0.001, "display reset"));
  // the store applies every PATCH answer as it lands, so an older answer can move the checkmark back for a moment while
  // newer ones are still in flight (api/store.ts, reported); this check reads the list once it has settled
  const sysRadio = radios.filter({ hasText: "시스템 따름" }).first();
  const settled = await until(async () => {
    if ((await sysRadio.getAttribute("aria-checked")) !== "true") return false;
    await sleep(600);
    return (await sysRadio.getAttribute("aria-checked")) === "true";
  }, { timeout: 8000, label: "checkmark settled" }).catch(() => false);
  const finalDisplay = (await api("GET", "/api/session", undefined, ctx.a.token)).body?.settings?.display;
  const checkedNow = await themeGroup.locator('[role="radio"][aria-checked="true"]').innerText().catch(() => "?");
  pass.check(
    "display: arrows choose a theme; reset to defaults",
    !!reset && settled,
    `server ${finalDisplay?.theme} ${finalDisplay?.textScale} · checked ${checkedNow.trim()}${scaleBack && mid ? "" : ` · steps scale ${!!scaleBack} arrow ${!!mid}`}`,
  );
  await sleep(500);
  await back(page);
}

async function privacySettings(pass, ctx) {
  const { page } = pass;
  const row = page.locator(".screen-scroll .list-row", { hasText: "정보 공개 범위" }).first();
  await reveal(page, row);
  // the large title is the row's own label (it morphs out of it), whatever the server names the row
  const rowTitle = (await row.locator(".list-row-title").first().innerText()).trim();
  await row.click();
  pass.check("privacy settings: the large title is the row's label (title morph)", await titleVisible(page, rowTitle), rowTitle);
  const scroller = await activeScroller(page);
  const order = await scroller.evaluate((el) => [...(el?.querySelectorAll(".list-section-title") ?? [])].map((h) => h.textContent.trim()));
  pass.check("privacy settings: 보내기 전에 is the first group (critique P1-1)", order[0] === "보내기 전에", order.join(" / "));
  const sw = page.locator('[role="switch"][aria-label="내 일정 보여 주기"]');
  const was = (await sw.getAttribute("aria-checked")) === "true";
  await pass.window("privacy-toggle", () => sw.click());
  const saved = await until(async () => (await api("GET", "/api/session", undefined, ctx.a.token)).body?.settings?.privacy?.friendsCanSeeSchedule === !was, { timeout: 6000, label: "privacy saved" }).catch(() => false);
  await sleep(500);
  const said = (await page.locator(".list-row", { has: sw }).innerText()).replace(/\s+/g, " ");
  pass.check(
    "privacy settings: toggle round-trips; the row's subtitle says what a friend's 모시 sees (B)",
    saved && (was ? /친구의 모시는 내 일정을 볼 수 없어요/ : /‘오후 3:00 · 팀 회의’처럼 제목과 시간만 보여요/).test(said),
    said,
  );
  pass.check(
    "privacy settings: no preview card, no plates; the login line is the friends footer (B, IT-15, IT-16, CP-5)",
    (await page.locator(".privacy-preview").count()) === 0 &&
      (await scroller.evaluate((el) => el?.querySelectorAll(".list-row-plate").length ?? -1)) === 0 &&
      (await page.locator(".list-footer", { hasText: "로그인 정보는 어떤 경우에도" }).count()) === 1,
  );
  await pass.shot("privacy-settings");
  await checkHeadings(pass, "정보 공개 범위");

  // 보내기 전에 묻기 (B): off asks IN PLACE — the same group grows (취소 | 끄기), the switch stays on until 끄기; on is
  // one tap; the server is the truth
  const askLabel = "다른 사람에게 보내기 전에 묻기";
  const ask = page.locator(`[role="switch"][aria-label="${askLabel}"]`);
  const server = async () => (await api("GET", "/api/session", undefined, ctx.a.token)).body?.settings?.confirmBeforeSend;
  const card = page.locator(".list-card", { has: ask });
  const confirm = card.locator('[role="group"][aria-labelledby="privacy-confirm-h"]');
  const confirmGone = () => until(async () => (await confirm.count()) === 0, { timeout: 5000, label: "confirm folded" }).catch(() => false);
  const focused = () => page.evaluate(() => (document.activeElement?.getAttribute("aria-label") || document.activeElement?.textContent || "").trim());
  const knobOn = () => ask.evaluate((el) => {
    const k = el.querySelector(".toggle-knob").getBoundingClientRect();
    const r = el.getBoundingClientRect();
    return k.left + k.width / 2 > r.left + r.width / 2;
  });
  pass.check("ask before sending: starts on", (await ask.getAttribute("aria-checked")) === "true" && (await server()) === true);
  await reveal(page, ask);
  // sample the group's transform for a few frames: the grow is a layout morph (transform only); reduced motion: none
  await card.evaluate((el) => {
    window.__qaMorph = [];
    const t0 = performance.now();
    const tick = () => {
      window.__qaMorph.push(el.style.transform || "");
      if (performance.now() - t0 < 500) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await pass.window("ask-off-confirm", () => ask.click());
  await confirm.waitFor({ timeout: 5000 }).catch(() => {});
  await sleep(700);
  const morphs = await page.evaluate(() => window.__qaMorph ?? []);
  const scaled = morphs.some((x) => /scale/.test(x) && !/scale\(1, 1\)|scale\(1\)/.test(x));
  pass.check(
    pass.variant === "reduced" ? "ask before sending: reduced motion — the group takes its new size at once" : "ask before sending: the group grows by a layout morph (transform), not a modal",
    pass.variant === "reduced" ? !scaled : scaled,
    `${morphs.length} frames · ${morphs.filter(Boolean)[0] ?? "none"}`,
  );
  const ctext = (await confirm.innerText().catch(() => "")).replace(/\s+/g, " ");
  pass.check(
    "ask before sending: OFF grows the same group: '이제 깽이가 묻지 않고 보내요' · 취소 | 끄기; no sheet; the switch stays on; nothing saved",
    (await page.locator(".sheet-root").count()) === 0 &&
      ctext.includes(`이제 ${ctx.agentName}가 묻지 않고 보내요`) &&
      ctext.includes("언제든 여기서 다시 켤 수 있어요") &&
      (await confirm.locator("button", { hasText: "취소" }).count()) === 1 &&
      (await confirm.locator("button", { hasText: "끄기" }).count()) === 1 &&
      (await ask.getAttribute("aria-checked")) === "true" &&
      (await knobOn()) &&
      (await server()) === true,
    ctext,
  );
  pass.check("ask before sending: a labelled group read politely; focus moves to 취소", (await card.locator('[aria-live="polite"]').count()) >= 1 && (await focused()) === "취소", await focused());
  await pass.shot("privacy-ask-confirm");
  await checkHeadings(pass, "ask-off confirm");
  await page.keyboard.press("Escape");
  const escaped = await confirmGone();
  await sleep(400);
  pass.check("ask before sending: Escape folds it back, focus returns to the switch; still on", escaped && (await focused()) === askLabel && (await ask.getAttribute("aria-checked")) === "true" && (await knobOn()) && (await server()) === true, await focused());
  await ask.click();
  await confirm.waitFor({ timeout: 5000 });
  await confirm.locator("button", { hasText: "취소" }).click();
  const cancelled = await confirmGone();
  await sleep(400);
  pass.check("ask before sending: 취소 keeps it on (switch, knob and server); focus back on the switch", cancelled && (await ask.getAttribute("aria-checked")) === "true" && (await knobOn()) && (await server()) === true && (await focused()) === askLabel);

  await pass.window("ask-off", async () => {
    await ask.click();
    await confirm.waitFor({ timeout: 5000 });
    await confirm.locator("button", { hasText: "끄기" }).click();
  });
  const off = await until(async () => (await server()) === false, { timeout: 6000, label: "confirmBeforeSend off" }).catch(() => false);
  await confirmGone();
  await sleep(600);
  const askRow = page.locator(".list-row", { has: ask });
  pass.check(
    "ask before sending: 끄기 saves OFF; the knob goes off; the row says what OFF means",
    off && (await ask.getAttribute("aria-checked")) === "false" && !(await knobOn()) && /지금은 묻지 않고 바로 보내요/.test(await askRow.innerText()) && (await focused()) === askLabel,
  );
  await pass.shot("privacy-ask-off");
  await back(page);
  const scopeRow = page.locator(".screen-scroll .list-row", { hasText: "정보 공개 범위" }).first();
  await reveal(page, scopeRow);
  pass.check("ask before sending: 나의 모시 row says it is off", /보내기 전 확인이 꺼져 있어요/.test(await scopeRow.innerText()));
  await pass.shot("profile-ask-off");

  await scopeRow.click();
  const reopened = await titleVisible(page, rowTitle);
  await reveal(page, ask);
  await pass.window("ask-on", () => ask.click());
  const on = await until(async () => (await server()) === true, { timeout: 6000, label: "confirmBeforeSend on" }).catch(() => false);
  await sleep(400);
  pass.check("ask before sending: ON is one tap, no confirm, saved — reversible", reopened && on && (await confirm.count()) === 0 && (await page.locator(".sheet-root").count()) === 0 && (await ask.getAttribute("aria-checked")) === "true" && (await knobOn()));
  await (await activeScroller(page)).evaluate((el) => el?.scrollTo(0, el.scrollHeight));
  await sleep(400);
  await pass.shot("privacy-settings-end");
  await back(page);
}

async function notificationsSettings(pass, ctx) {
  const { page } = pass;
  // this device's permission is the page's own business: fake an unasked one (and its answer) so the check never
  // depends on the browser's default
  await page.evaluate(() => {
    if (window.__qaNotif) {
      window.__qaNotif.state = "default";
      window.__qaNotif.asked = 0;
      return;
    }
    const real = window.Notification;
    const box = { state: "default", asked: 0, real, desc: real ? Object.getOwnPropertyDescriptor(real, "permission") : undefined, req: real?.requestPermission };
    window.__qaNotif = box;
    if (!real) window.Notification = function Notification() {};
    Object.defineProperty(window.Notification, "permission", { configurable: true, get: () => box.state });
    window.Notification.requestPermission = async () => {
      box.asked++;
      box.state = "granted";
      return "granted";
    };
  });
  const restore = () =>
    page.evaluate(() => {
      const b = window.__qaNotif;
      if (!b) return;
      if (b.real) {
        if (b.desc) Object.defineProperty(b.real, "permission", b.desc);
        b.real.requestPermission = b.req;
      } else delete window.Notification;
      delete window.__qaNotif;
    });
  try {
    const row = page.locator(".screen-scroll .list-row", { hasText: "알림 설정" }).first();
    await reveal(page, row);
    await row.click();
    await titleVisible(page, "알림 설정");
    const scroller = await activeScroller(page);
    const server = async () => (await api("GET", "/api/session", undefined, ctx.a.token)).body?.settings?.notifications;
    const n0 = await server();
    const sw = (label) => page.locator(`[role="switch"][aria-label="${label}"]`);
    const kinds = [
      ["매일 브리핑", "briefing"],
      ["맡긴 일 완료", "taskDone"],
      ["친구 메시지", "friendMessages"],
      ["혜택·소식 알림", "marketing"],
    ];
    const device = page.locator(".settings-device");
    const first = await scroller.evaluate((el) => el?.querySelector(".more-stack > *")?.className ?? "");
    pass.check(
      "notifications: the device comes first and asks (one primary action) (critique P1-2)",
      /settings-device/.test(first) && /이 기기에서 알림을 받으려면 허용해 주세요/.test(await device.innerText()) && (await device.locator('button[data-tone="primary"]', { hasText: "알림 허용하기" }).count()) === 1,
      String(first),
    );
    const states = [];
    for (const [label, k] of kinds) states.push({ k, checked: (await sw(label).getAttribute("aria-checked")) === "true", disabled: await sw(label).isDisabled() });
    pass.check(
      "notifications: before the device is asked, every switch is disabled and shows the SAVED state",
      !!n0 && states.every((s) => s.disabled && s.checked === !!n0[s.k]),
      states.map((s) => `${s.k}:${s.checked ? "on" : "off"}${s.disabled ? "·disabled" : ""}`).join(" "),
    );
    const look = await scroller.evaluate((el) => ({
      dims: [...el.querySelectorAll(".list-row .list-row-main")].map((m) => getComputedStyle(m).opacity),
      plates: el.querySelectorAll(".list-row-plate").length,
      text: el.innerText,
    }));
    pass.check(
      "notifications: words at full strength (only the controls dim); no plates, no level tails; B's copy",
      look.dims.length >= 5 &&
        look.dims.every((o) => o === "1") &&
        look.plates === 0 &&
        !/일반 알림|시간 맞춤 알림/.test(look.text) &&
        look.text.includes(`${ctx.agentName}가 보내는 알림`) &&
        look.text.includes("선택 동의") &&
        look.text.includes("켜면 알림 없이 목록에만 쌓여요") &&
        look.text.includes("앱을 쓰는 동안에는 화면 맨 위에서 알림이 잠깐 내려와요."),
      look.dims.join(","),
    );
    const time = page.locator(".settings-time");
    const tbox = await time.boundingBox();
    const ttext = (await time.innerText()).trim();
    pass.check("notifications: the briefing time is a plain value, 44px, no glyph", /^(오전|오후) \d{1,2}:\d{2}$/.test(ttext) && (await time.locator("svg").count()) === 0 && (tbox?.height ?? 0) >= 44, `${ttext} · ${tbox?.height}px`);
    await pass.shot("notifications-device");
    await checkHeadings(pass, "알림 설정");

    await pass.window("notif-allow", () => device.locator("button", { hasText: "알림 허용하기" }).click());
    const gone = await until(async () => (await device.count()) === 0, { timeout: 5000, label: "device card gone" }).catch(() => false);
    await sleep(500);
    const enabled = [];
    for (const [label] of kinds) enabled.push(await sw(label).isEnabled());
    pass.check("notifications: 알림 허용하기 asks the browser once; the card leaves, the switches work", gone && enabled.every(Boolean) && (await page.evaluate(() => window.__qaNotif?.asked)) === 1, enabled.join(","));
    const done = sw("맡긴 일 완료");
    const was = (await done.getAttribute("aria-checked")) === "true";
    await pass.window("notif-toggle", () => done.click());
    const saved = await until(async () => (await server())?.taskDone === !was, { timeout: 6000, label: "taskDone saved" }).catch(() => false);
    await sleep(300);
    await done.click();
    const restored = await until(async () => (await server())?.taskDone === was, { timeout: 6000, label: "taskDone restored" }).catch(() => false);
    pass.check("notifications: a switch round-trips to the server", saved && restored);
    await sleep(300);
    await pass.shot("notifications-granted");
    await back(page);
  } finally {
    await restore().catch(() => {});
  }
}

async function connections(pass) {
  const { page } = pass;
  const card = page.locator(".screen-scroll .profile-conns").first();
  await reveal(page, card);
  await card.click();
  await page.waitForSelector(".conn-row-kakaotalk", { timeout: 10_000 });
  // real app icons (assets/brands): every row of a known messenger shows its brand tile with the official mark drawn
  await page.waitForFunction(() => !!document.querySelector(".conn-row-kakaotalk .brand-icon svg"), null, { timeout: 8000 }).catch(() => {});
  const scrollTo = (where) => page.evaluate((w) => { const sc = document.elementFromPoint(195, 430)?.closest(".screen-scroll"); sc?.scrollTo({ top: w === "end" ? sc.scrollHeight : 0 }); }, where);
  // bots the person made themselves are folded into "고급 · 직접 만든 봇 연결"; no main row asks for a token
  const mainSubs = await page.locator(".screen-scroll .list-section:not(.conn-adv) .conn-row .list-row-sub").allInnerTexts();
  pass.check("connections: no main-list row says 토큰으로 연결", mainSubs.length > 0 && !mainSubs.some((t) => /토큰/.test(t)), mainSubs.join(" | "));
  // draft B: the login rows are chunked by where they're used, in this order
  const chunks = await page.locator(".screen-scroll .list-section:has(.conn-row):not(.conn-adv)").evaluateAll((secs) =>
    secs.map((s) => ({ title: s.querySelector(".list-section-title")?.textContent?.trim() ?? "", ids: [...s.querySelectorAll(".conn-row")].map((r) => [...r.classList].find((c) => c.startsWith("conn-row-"))?.slice(9)) })),
  );
  const chunk = (t) => chunks.find((c) => c.title === t)?.ids.join(",") ?? "";
  pass.check(
    "connections: 일상 메신저 (카카오톡 · 인스타그램 · 라인 · 텔레그램 · 디스코드) then 업무 메신저 (슬랙 · Teams · Webex)",
    chunk("일상 메신저") === "kakaotalk,instagram,line,telegram,discord" && chunk("업무 메신저") === "slack,teams,webex" && chunks.findIndex((c) => c.title === "일상 메신저") < chunks.findIndex((c) => c.title === "업무 메신저"),
    chunks.map((c) => `${c.title}: ${c.ids.join(",")}`).join(" | "),
  );
  const toggle = page.locator(".screen-scroll .conn-adv-toggle");
  const hasFold = (await toggle.count()) === 1;
  const toggleText = hasFold ? (await toggle.innerText()).replace(/\s+/g, " ") : "no fold"; // nbsp before a tied "·" folded too
  pass.check(
    "connections: bots sit in one collapsed 고급 · 직접 만든 봇 연결 group",
    hasFold && (await toggle.getAttribute("aria-expanded")) === "false" && /고급 · 직접 만든 봇 연결/.test(toggleText) && (await page.locator(".conn-adv .conn-row").count()) === 0,
    toggleText,
  );
  await scrollTo("top");
  await page.mouse.move(-20, -20); // no hover tint on whichever row the last click left the pointer over
  await pass.shot("connections-list");
  const msgSection = page.locator(".screen-scroll .list", { has: page.locator(".conn-row-kakaotalk") }).first();
  await pass.shotEl("connections-messengers", msgSection);
  await scrollTo("end");
  await pass.shot("connections-list-end");
  if (hasFold) {
    await pass.window("advanced-open", () => toggle.click());
    const botRows = await page.locator(".conn-adv .conn-row").count();
    pass.check("connections: 고급 opens (aria-expanded) and shows the bot rows", (await toggle.getAttribute("aria-expanded")) === "true" && botRows >= 1, `${botRows} bot rows`);
    await scrollTo("end");
    await page.mouse.move(-20, -20);
    await pass.shot("connections-advanced-open");
  }
  const icons = await brandIcons(page, ".screen-scroll .conn-row", (row) => [...row.classList].find((c) => c.startsWith("conn-row-"))?.slice(9));
  const branded = icons.filter((i) => i.want);
  const badIcons = branded.filter((i) => i.got !== i.want || !i.marks || !i.painted || !i.hidden || !i.img || i.w !== 30);
  pass.check(
    "connections: every messenger row shows its real app icon (tile + mark, aria-hidden, 30px)",
    branded.length >= 5 && badIcons.length === 0,
    `${branded.map((i) => i.id).join(",")}${badIcons.length ? ` · bad ${JSON.stringify(badIcons)}` : ""} · plain: ${icons.filter((i) => !i.want).map((i) => i.id).join(",") || "none"}`,
  );
  const names = await page.locator(".screen-scroll .conn-row").evaluateAll((rows) => rows.map((r) => r.getAttribute("aria-label") || "").filter((l) => !/^[^,]+, /.test(l)));
  pass.check("connections: row names still read 이름, 상태, 설명 (icon adds nothing to the name)", names.length === 0, names.join(" | "));
  if (hasFold) {
    await pass.window("advanced-close", () => toggle.click());
    await sleep(200);
    pass.check("connections: 고급 folds back", (await toggle.getAttribute("aria-expanded")) === "false" && (await page.locator(".conn-adv .conn-row").count()) === 0);
  }
  await scrollTo("top");
  await sleep(300);
  await pass.window("kakaotalk-sheet", () => page.click(".conn-row-kakaotalk"));
  await page.waitForSelector(".conn-sheet .tf-input", { timeout: 6000 });
  // draft B sheet: no icon plate; the title reads from the leading edge with the 연결 전 pill under it; the inputs come
  // first, the sealing sentence is the password field's hint, and 할 수 있는 일 · 로그인 정보 보관 are summary rows
  const sh = await page.locator(".conn-sheet").evaluate((el) => {
    const title = el.querySelector(".sheet-title");
    const pw = el.querySelector('input[type="password"]')?.closest(".tf");
    const email = el.querySelector('input[type="email"]')?.closest(".tf");
    const form = el.querySelector(".conn-form");
    const folds = el.querySelector(".conn-folds");
    return {
      plates: el.querySelectorAll(".sheet-body .brand-icon, .sheet-body .more-plate").length,
      align: title ? getComputedStyle(title).textAlign : "",
      titleAlign: el.getAttribute("data-title"),
      pill: el.querySelector(".conn-sheet-status .conn-livepill")?.textContent?.trim() ?? "",
      pwHint: pw?.querySelector(".tf-hint .conn-lockhint")?.textContent ?? "",
      emailHint: email?.querySelector(".tf-hint")?.textContent ?? "",
      rows: [...el.querySelectorAll(".conn-fold__row")].map((b) => ({ text: b.textContent?.replace(/\s+/g, " ").trim() ?? "", open: b.getAttribute("aria-expanded") })),
      formFirst: !!form && !!folds && !!(form.compareDocumentPosition(folds) & Node.DOCUMENT_POSITION_FOLLOWING),
      notes: el.querySelectorAll(".sheet-body .more-note").length,
    };
  });
  pass.check(
    "connections: 카카오톡 sheet is draft B (no plate, start title + 연결 전 pill, form first, lock hint under the password, 2FA hint under the email, two closed summary rows, no notes)",
    sh.plates === 0 && sh.align === "left" && sh.titleAlign === "start" && /연결 전/.test(sh.pill) && /암호화/.test(sh.pwHint) && /2단계 인증/.test(sh.emailHint) && sh.formFirst && sh.notes === 0 &&
      sh.rows.length === 2 && sh.rows.every((r) => r.open === "false") && /할 수 있는 일.*허락받은 메시지 보내기.*설정은 바꾸지 않아요/.test(sh.rows[0].text) && /로그인 정보 보관\s*30일/.test(sh.rows[1].text),
    JSON.stringify(sh),
  );
  await pass.shot("kakaotalk-sheet");
  // the summary rows open in place: the four checks + the one "never" line; the five keep-for choices
  const foldRows = page.locator(".conn-sheet .conn-fold__row");
  await pass.window("sheet-fold-open", () => foldRows.nth(0).click());
  await foldRows.nth(1).click();
  await sleep(800);
  const opened = await page.locator(".conn-sheet").evaluate((el) => ({ can: el.querySelectorAll(".conn-can li").length, radios: el.querySelectorAll('.conn-fold [role="radio"]').length, exp: [...el.querySelectorAll(".conn-fold__row")].map((b) => b.getAttribute("aria-expanded")) }));
  pass.check("connections: both summary rows open in place (what 깽이 can do in five lines, the five keep-for choices)", opened.can === 5 && opened.radios === 5 && opened.exp.every((e) => e === "true"), JSON.stringify(opened));
  await pass.shot("kakaotalk-sheet-open");
  const inputs = page.locator(".conn-sheet .tf-input");
  await inputs.nth(0).fill(`qa-bogus-${rand()}@example.com`);
  await inputs.nth(1).fill("not-a-real-password-1");
  await page.locator(".conn-sheet .sheet-footer button").first().click();
  const err = await page
    .waitForSelector(".conn-sheet .more-error", { timeout: 90_000 })
    .then((e) => e.textContent())
    .catch(() => null);
  pass.check("connections: bogus 카카오톡 login fails with a Korean error", !!err && /[가-힣]/.test(err), err ?? "no error shown");
  await pass.shot("kakaotalk-error");
  await closeSheet(page);
  await back(page);
}

/**
 * Records the server writes that this run can't produce live: the owner's device-signed approve and deny, an agent
 * use (never signed), remove, logout and a key the app doesn't know yet. They are appended to the server's own
 * 접근 기록 list (page.route) so every label and the signed-only line are checked next to the real records.
 */
function syntheticAccess(now) {
  return [
    { action: "approval", actor: "user", outcome: "ok", deviceVerified: true, purpose: "카카오톡으로 메시지 보내기" },
    { action: "approval", actor: "user", outcome: "denied", deviceVerified: true, purpose: "카카오톡으로 메시지 보내기" },
    { action: "send_message", actor: "agent", outcome: "ok", deviceVerified: false, purpose: "카카오톡 메시지 보내기" },
    { action: "remove", actor: "user", outcome: "ok", deviceVerified: false, purpose: "" },
    { action: "logout", actor: "user", outcome: "ok", deviceVerified: false, purpose: "카카오톡 연결 해제" },
    { action: "qa_unknown_action", actor: "system", outcome: "ok", deviceVerified: false, purpose: "" },
  ].map((r, i) => ({ id: `qa-rec-${i}`, credentialId: null, service: "kakaotalk", serviceName: "카카오톡", createdAt: now - (i + 1) * 60_000, ...r }));
}

async function vault(pass, ctx) {
  const { page } = pass;
  const logRe = /\/api\/access-log(\?.*)?$/;
  let served = [];
  await page.route(logRe, async (route) => {
    const res = await route.fetch();
    const real = res.ok() ? await res.json() : [];
    served = [...(Array.isArray(real) ? real : []), ...syntheticAccess(Date.now())];
    await route.fulfill({ response: res, json: served });
  });
  const row = page.locator(".screen-scroll .list-row", { hasText: "저장된 로그인" }).first();
  await reveal(page, row);
  await row.click();
  const has = await page.waitForSelector(".vault-login", { timeout: 10_000 }).then(() => true).catch(() => false);
  pass.check("vault: the sealed login is listed", has);
  if (has) {
    const card = await brandIcons(page, ".vault-login", () => "kakaotalk");
    pass.check("vault: the 카카오톡 login group shows the KakaoTalk app icon (30px)", card.some((c) => c.got === "kakaotalk" && c.marks > 0 && c.w === 30), JSON.stringify(card));
    // draft B: one group per login: account · 보관 기간 (value + countdown, closed) · 마지막 사용 · 이 로그인 지우기, footer
    const g = await page.locator(".vault-login").first().evaluate((el) => ({
      keep: el.querySelector(".vault-keep")?.textContent?.replace(/\s+/g, " ").trim() ?? "",
      open: el.querySelector(".vault-keep")?.getAttribute("aria-expanded"),
      radios: el.querySelectorAll('[role="radio"]').length,
      text: el.textContent ?? "",
      foot: el.querySelector(".list-footer")?.textContent ?? "",
      pills: el.querySelectorAll(".more-pill").length,
    }));
    pass.check(
      "vault: one group per login (보관 기간 row closed with value + time left, 마지막 사용, 이 로그인 지우기, saved date as the footer, no pill)",
      /보관 기간\s*\d+(시간|일)|보관 기간\s*계속/.test(g.keep) && g.open === "false" && g.radios === 0 && /마지막 사용/.test(g.text) && /이 로그인 지우기/.test(g.text) && /저장했어요/.test(g.foot) && g.pills === 0,
      JSON.stringify({ ...g, text: undefined }),
    );
  }
  await pass.shot("vault");
  if (has) {
    await pass.window("keep-open", () => page.locator(".vault-login .vault-keep").first().click());
    await sleep(500);
    await pass.window("keep-for-7d", () => page.locator('.vault-login [role="radio"]', { hasText: "7일" }).first().click());
    const kept = await until(async () => (await api("GET", "/api/credentials", undefined, ctx.a.token)).body?.[0]?.keepFor === "7d", { timeout: 6000, label: "keepFor 7d" }).catch(() => false);
    pass.check("vault: 보관 기간 7일 saved on the server", kept);
    await pass.shot("vault-7d");
    await pass.window("vault-log", () => page.click("#vault-tab-log"));
    const recs = await page.waitForSelector(".vault-rec", { timeout: 8000 }).then(() => page.locator(".vault-rec").count()).catch(() => 0);
    pass.check("vault: 접근 기록 shows records", recs > 0, `${recs} records`);
    pass.check("vault: the large title follows the segment (접근 기록)", await titleVisible(page, "접근 기록"));
    const logIcons = await brandIcons(page, ".vault-rec", () => "kakaotalk");
    pass.check("vault: 접근 기록 rows for 카카오톡 show its app icon (30px row list)", recs > 0 && logIcons.some((c) => c.got === "kakaotalk" && c.marks > 0 && c.w === 30), `${logIcons.filter((c) => c.got).length}/${logIcons.length} rows with an icon`);
    const rows = await page.locator(".vault-rec").evaluateAll((els) =>
      els.map((el) => ({
        id: el.querySelector(".vault-rec__what")?.getAttribute("data-rec") ?? null,
        what: el.querySelector(".vault-rec__what")?.textContent?.trim() ?? "",
        action: el.querySelector(".vault-rec__action")?.textContent?.trim() ?? "",
        text: el.textContent ?? "",
        outcome: el.querySelector(".vault-rec__note b")?.textContent?.trim() ?? "",
        time: el.querySelector(".list-row-detail time")?.textContent?.trim() ?? "",
        verified: !!el.querySelector(".vault-verified"),
      })),
    );
    const rec = new Map(served.map((r) => [r.id, r]));
    const keys = [...new Set(served.map((r) => r.action))];
    const raw = rows.filter((r) => /[A-Za-z_]/.test(r.action) || keys.some((k) => r.text.includes(k)));
    const label = (a) => rows.filter((r) => rec.get(r.id)?.action === a).map((r) => r.action);
    pass.check(
      "vault: 접근 기록 says every action in Korean, never a raw key (approval → 승인 요청, an unknown key → 사용)",
      rows.length === served.length && raw.length === 0 && label("approval").every((l) => l === "승인 요청") && label("approval").length === 2 && label("qa_unknown_action")[0] === "사용" && label("remove")[0] === "삭제" && label("logout")[0] === "연결 해제",
      raw.length ? `raw: ${raw.map((r) => r.what).join(" / ")}` : `${rows.length}/${served.length} rows · keys ${keys.join(",")} · ${rows.map((r) => r.what).join(" / ")}`,
    );
    const wrongLine = rows.filter((r) => r.verified !== !!rec.get(r.id)?.deviceVerified);
    pass.check(
      "vault: '이 기기의 키로 확인했어요' only on the owner's device-signed rows, never on an agent use",
      wrongLine.length === 0 && rows.filter((r) => r.verified).length === served.filter((r) => r.deviceVerified).length && rows.some((r) => rec.get(r.id)?.actor === "agent" && !r.verified),
      wrongLine.map((r) => `${r.what} verified=${r.verified}`).join(" / ") || `${rows.filter((r) => r.verified).length} signed rows`,
    );
    const outcomes = Object.fromEntries(rows.filter((r) => rec.get(r.id)?.action === "approval").map((r) => [rec.get(r.id).outcome, r.outcome]));
    pass.check(
      "vault: rows carry no 완료 / 승인됨 pills; only a refusal says 거절됨 on its third line; every row has its time as the trailing value",
      outcomes.ok === "" && outcomes.denied === "거절됨" && rows.every((r) => !/완료|승인됨/.test(r.text) && /\d:\d\d/.test(r.time)),
      JSON.stringify(outcomes),
    );
    await pass.shot("vault-log");
  }
  await page.unroute(logRe);
  await back(page);
}

async function friends(pass, ctx) {
  const { page } = pass;
  const row = page.locator(".screen-scroll .list-row", { hasText: "친구" }).last();
  await reveal(page, row);
  await row.click();
  await titleVisible(page, "친구");
  await pass.shot("friends-empty");
  // glass: back + tab bar only (no "초대" capsule — the invite lives in the page)
  const trailing = await page.locator(".topbar .tb-right-slot > *").count();
  // chat's audio unlock warms an AudioContext once: 1.5 s after the last tap it queues an idle callback (timeout 3 s)
  // that costs ~150 ms (LoAF: IdleRequestCallback in audioUnlock) and otherwise lands inside the next measured window.
  // Let its timer fire, then wait for an idle callback queued after it (same queue, longer timeout: it runs later).
  await sleep(1700);
  await page.evaluate(() => new Promise((r) => (window.requestIdleCallback ? requestIdleCallback(() => r(), { timeout: 5000 }) : setTimeout(r, 0))));
  pass.check("friends: no trailing top-bar capsule (the invite is in the page)", trailing === 0, `${trailing}`);
  await pass.window("invite-sheet", () => page.locator(".screen-scroll .empty-state button", { hasText: "친구 초대하기" }).click());
  const url = await page
    .waitForSelector('.sheet-root [data-invite-url*="/i/"]', { timeout: 8000 })
    .then((e) => e.getAttribute("data-invite-url"))
    .catch(() => null);
  pass.check("friends: invite sheet holds a server link", !!url && /\/i\/[A-Za-z0-9_-]{16,}/.test(url), url ?? "none");
  const sheet = await page.evaluate(() => {
    const root = document.querySelector(".sheet-root");
    const title = root?.querySelector(".sheet-title");
    const t = title?.getBoundingClientRect();
    const p = root?.querySelector(".sheet-panel")?.getBoundingClientRect();
    return {
      text: root?.innerText ?? "",
      start: !!t && !!p && t.left - p.left < 40 && getComputedStyle(title).textAlign === "left",
      primary: root?.querySelectorAll('.btn[data-tone="primary"]').length ?? 0,
      until: root?.querySelector(".invite-until")?.textContent ?? "",
      untilAbovePrimary: (() => {
        const u = root?.querySelector(".invite-until")?.getBoundingClientRect();
        const b = root?.querySelector('.btn[data-tone="primary"]')?.getBoundingClientRect();
        return !!u && !!b && u.bottom <= b.top + 1 && b.top - u.bottom < 24;
      })(),
    };
  });
  pass.check("friends: invite sheet title reads from the leading edge", sheet.start);
  pass.check("friends: invite sheet prints no URL (facts only)", !/https?:\/\/|\/i\//.test(sheet.text), sheet.text.match(/\S*\/i\/\S*/)?.[0] ?? "");
  pass.check("friends: '…까지 · 한 번만 쓸 수 있어요' sits right above the one accent action", sheet.primary === 1 && /까지 · 한 번만 쓸 수 있어요$/.test(sheet.until.trim()) && sheet.untilAbovePrimary, `${sheet.primary} primary · "${sheet.until}"`);
  await checkHeadings(pass, "invite sheet");
  await pass.shot("invite-sheet");
  await closeSheet(page);
  if (url) {
    const token = url.match(/\/i\/([A-Za-z0-9_-]+)/)[1];
    const acc = await api("POST", `/api/invites/${token}/accept`, undefined, ctx.b.token);
    pass.check("friends: second user accepts the invite (API)", acc.status < 300, `${acc.status}`);
    const shown = await page.waitForSelector(`.friend-row[data-friend="${ctx.b.handle}"]`, { timeout: 12_000 }).then(() => true).catch(() => false);
    pass.check("friends: the new friend appears without a reload", shown);
    await pass.shot("friends-list");
    if (shown) {
      const group = await page.evaluate((h) => {
        const row = document.querySelector(`.friend-row[data-friend="${h}"]`);
        const list = row?.closest(".list");
        const card = row?.closest(".list-card");
        return {
          chev: !!row?.querySelector(".friend-chev"),
          more: row?.querySelectorAll("button").length ?? 0,
          last: card?.lastElementChild?.matches(".friend-invite-row") ?? false,
          label: card?.querySelector(".friend-invite-row")?.textContent?.trim() ?? "",
          caption: list?.querySelector(".list-footer")?.textContent?.trim() ?? "",
          pageNote: [...(row?.closest(".screen-scroll")?.querySelectorAll(".more-note") ?? [])].filter((n) => n.getClientRects().length).length,
        };
      }, ctx.b.handle);
      pass.check("friends: a friend row ends in the list chevron, '…' its one other button", group.chev && group.more === 2, JSON.stringify({ chev: group.chev, buttons: group.more }));
      pass.check("friends: the group's last row is 친구 초대하기", group.last && group.label === "친구 초대하기", group.label);
      pass.check("friends: the how-to is the group's caption (no page note)", group.caption.startsWith("메시지에서 모시 이름을 부르거나") && group.pageNote === 0, `${group.pageNote} notes`);
      await checkHeadings(pass, "친구");
      await pass.window("invite-from-row", () => page.locator(".friend-invite-row").click());
      const again = await page.waitForSelector(".sheet-root .invite-until", { timeout: 8000 }).then(() => true).catch(() => false);
      pass.check("friends: the invite row opens the same invite sheet", again);
      await closeSheet(page);
      await pass.window("friend-thread", () => page.locator(`.friend-row[data-friend="${ctx.b.handle}"] .friend-main`).click());
      const inThread = await page.waitForSelector(".thread-intro-title", { timeout: 8000 }).then(() => true).catch(() => false);
      pass.check("friends: tapping a friend opens the shared thread", inThread);
      await pass.shot("friend-thread");
      await back(page);
      await pass.window("friend-sheet", () => page.locator(`.friend-row[data-friend="${ctx.b.handle}"] .friend-more`).click());
      await page.waitForSelector(".sheet-root .friend-sheet-head", { timeout: 6000 });
      await pass.shot("friend-sheet");
      await twoStep(page, "차단하기", "한 번 더 누르면 차단해요");
      const blocked = await until(async () => (await api("GET", "/api/friends", undefined, ctx.a.token)).body?.find((f) => f.handle === ctx.b.handle)?.status === "blocked", { timeout: 8000, label: "blocked" }).catch(() => false);
      pass.check("friends: block (two-step) reaches the server", blocked);
      await page.locator(".sheet-root").waitFor({ state: "detached", timeout: 6000 }).catch(() => {});
      await sleep(600);
      await pass.shot("friends-blocked");
      if (blocked) {
        await page.locator(`.friend-row[data-friend="${ctx.b.handle}"] .friend-more`).click();
        await page.waitForSelector(".sheet-root .friend-sheet-head", { timeout: 6000 });
        await twoStep(page, "차단 풀기", "한 번 더 누르면 차단을 풀어요");
        const gone = await until(async () => !(await api("GET", "/api/friends", undefined, ctx.a.token)).body?.some((f) => f.handle === ctx.b.handle && f.status === "blocked"), { timeout: 8000, label: "unblocked" }).catch(() => false);
        pass.check("friends: 차단 풀기 lifts the block", gone);
        await page.locator(".sheet-root").waitFor({ state: "detached", timeout: 6000 }).catch(() => {});
      }
    }
  }
  if (ctx.c) {
    const inv = await api("POST", "/api/invites", undefined, ctx.c.token);
    const field = page.locator('.friend-add input[type="url"]');
    await reveal(page, field);
    await field.fill(inv.body.url);
    await page.locator(".friend-add button", { hasText: "추가" }).click();
    const added = await page.waitForSelector(`.friend-row[data-friend="${ctx.c.handle}"]`, { timeout: 10_000 }).then(() => true).catch(() => false);
    pass.check("friends: pasting a received invite link adds the friend", added);
    await pass.shot("friends-added-by-link");
  }
  await back(page);
}

async function agent(pass, ctx) {
  const { page } = pass;
  const card = page.locator(".screen-scroll .profile-agent").first();
  await reveal(page, card);
  await card.click();
  await titleVisible(page, ctx.agentName);
  await page.waitForSelector(".agent-skill", { timeout: 10_000 });
  await pass.shot("agent");
  const ag = await (await activeScroller(page)).evaluate((el) => ({
    status: el?.querySelector(".agent-identity__status")?.textContent.trim() ?? "",
    plates: el?.querySelectorAll(".agent-skill__icon, .list-row-plate").length ?? -1,
    cats: el?.querySelectorAll(".agent-skill-groups h3").length ?? 0,
    heads: [...(el?.querySelectorAll(".agent-head h2") ?? [])].map((h) => h.textContent.trim()),
    save: [...(el?.querySelectorAll("button") ?? [])].find((b) => b.textContent.trim() === "저장하기")?.disabled ?? null,
    restart: el?.querySelector(".agent-restart__row")?.textContent.trim() ?? "",
  }));
  pass.check(
    "agent B: the state sits by the face; skills under category h3s with no plates; list heads; 저장하기 off at rest; restart row",
    /쉬는 중|일하는 중|준비 중|멈춤|문제가 생겼어요/.test(ag.status) && ag.plates === 0 && ag.cats > 0 && ag.heads[0] === "이름과 성격" && ag.heads[1] === "할 수 있는 일" && ag.save === true && /다시 시작하기$/.test(ag.restart),
    JSON.stringify(ag),
  );
  const sk = page.locator('.agent-skill[data-skill="k_weather"] [role="switch"]');
  await reveal(page, sk);
  await pass.window("skill-off", () => sk.click());
  const off = await until(async () => !(await api("GET", "/api/session", undefined, ctx.a.token)).body.agent.enabledSkills.includes("k_weather"), { timeout: 6000, label: "skill off" }).catch(() => false);
  pass.check("agent: switching a skill off reaches the server", off);
  await pass.shot("agent-skill-off");
  await sk.click();
  const on = await until(async () => (await api("GET", "/api/session", undefined, ctx.a.token)).body.agent.enabledSkills.includes("k_weather"), { timeout: 6000, label: "skill on" }).catch(() => false);
  pass.check("agent: and back on", on);
  const mem = page.locator(".agent-memories");
  await reveal(page, mem);
  await pass.shot("agent-memories");

  // my-mosi B: a colour is saved the moment it is picked (no 저장하기), and springs back with a banner when refused
  const before = (await api("GET", "/api/session", undefined, ctx.a.token)).body.agent.avatar;
  const pick = page.locator('.agent-hue[aria-checked="false"]').first();
  const want = await pick.evaluate((el) => Number(el.style.getPropertyValue("--h")));
  await pass.window("hue-pick", () => pick.click());
  const saved = await until(async () => (await api("GET", "/api/session", undefined, ctx.a.token)).body.agent.avatar?.hue === want, { timeout: 6000, label: "hue saved" }).catch(() => false);
  pass.check("agent B: a colour is saved on pick, without 저장하기", saved, `${before?.hue} → ${want}`);
  const agentRe = /\/api\/agent(\?.*)?$/;
  const refuse = async (route) => {
    const req = route.request();
    if (req.method() === "PATCH" && /"avatar"/.test(req.postData() ?? "")) return route.fulfill({ status: 400, json: { error: "bad_request" } });
    return route.fallback();
  };
  await page.route(agentRe, refuse);
  pass.expectedUrls.push(agentRe);
  try {
    await page.locator('.agent-hue[aria-checked="false"]').first().click();
    const rolled = await page
      .waitForFunction((h) => Number(document.querySelector('.agent-hue[aria-checked="true"]')?.style.getPropertyValue("--h")) === h, want, { timeout: 6000 })
      .then(() => true)
      .catch(() => false);
    const banner = await page
      .getByText("색을 바꾸지 못했어요")
      .first()
      .waitFor({ timeout: 4000 })
      .then(() => true)
      .catch(() => false);
    pass.check("agent B: a refused colour springs back to the saved one, with a banner (§8.13)", rolled && banner);
    await pass.shot("agent-hue-rollback");
  } finally {
    pass.expectedUrls.splice(pass.expectedUrls.indexOf(agentRe), 1);
    await page.unroute(agentRe, refuse);
  }
  if (before) await api("PATCH", "/api/agent", { avatar: before }, ctx.a.token);
  // the banner steps the top bar back; wait for it to leave before pressing 뒤로
  await page.waitForFunction(() => !document.querySelector(".topbar.under-banner"), null, { timeout: 15_000 }).catch(() => {});
  await back(page);
}

async function archive(pass, browser, ctxOpts, arc) {
  if (!arc?.artifacts) {
    pass.skipped.push("archive: no seeded artifact");
    return;
  }
  const c2 = await browser.newContext(ctxOpts);
  await c2.addInitScript((t) => localStorage.setItem("pickle.token", t), arc.token);
  const p2 = await c2.newPage();
  const errs = [];
  p2.on("console", (m) => m.type() === "error" && errs.push(m.text()));
  p2.on("pageerror", (e) => errs.push(`pageerror: ${e.message}`));
  await p2.goto(BASE + "/");
  await p2.waitForSelector("#tab-archive", { timeout: 15_000 });
  await p2.click("#tab-archive");
  const card = p2.locator(".screen-scroll .arc-card").first();
  const ok = await card.waitFor({ timeout: 10_000 }).then(() => true).catch(() => false);
  const sub = new Pass(pass.engine, pass.variant, p2);
  sub.n = 90;
  await sub.shot("archive");
  if (ok) {
    await card.click();
    const opened = await p2.waitForSelector(".sheet-root", { timeout: 8000 }).then(() => true).catch(() => false);
    await sleep(1200);
    pass.check("archive: artifact opens as a sheet with its document", opened && (await p2.locator(".sheet-root").innerText()).length > 40);
    await sub.shot("archive-artifact-sheet");
  } else pass.check("archive: artifact card listed", false);
  pass.shots.push(...sub.shots);
  pass.overflows.push(...sub.overflows);
  pass.errors.push(...errs.map((e) => `[archive] ${e}`));
  await c2.close();
}

/**
 * 보관함 draft A on fixture records (page.route answers GET /api/artifacts, /api/blobs/:id and an empty
 * /api/attachments), so every rule is checked without an LLM-made record: the segment words, cards led by their title
 * with no kind plate and ' · ' previews, the document sheet (title said once, share / copy under the record, tasks on
 * the paper), the summary sheet (no panels, the accent bar explained in words, amounts in one right column) and the
 * empty 사진·파일 panel (one action, no FAB). Synthetic records only (하늘, made-up sums).
 */
// "어제" / "3일 전" by the calendar in Asia/Seoul (the browser's zone here), whatever the hour the run starts
const kstDay = (now = Date.now()) => Math.floor((now + 9 * 3600_000) / 86_400_000) * 86_400_000 - 9 * 3600_000;
const ARCHIVE_FIXTURE = (today = kstDay()) => [
  {
    id: "qa-art-doc",
    threadId: null,
    title: "11월 12일 주간회의 회의록",
    kind: "document",
    content:
      "# 11월 12일 주간회의\n\n참석: 하늘, 지현, 민호, 다은 · 42분\n\n## 정한 것\n- 출시일은 **12월 2일**로 확정\n- 랜딩 페이지는 시안 B\n\n## 할 일\n- [ ] 하늘: 랜딩 문구 (금)\n- [ ] 지현: 앱 스토어 스크린샷 5장\n\n## 메모\n지난주 베타 피드백 중 \"알림이 너무 많다\"는 의견이 6건 있었어요. 알림 묶음 보내기를 다음 스프린트에 넣기로 했어요.",
    createdAt: today - 86_400_000 + 10 * 3600_000,
    updatedAt: today - 86_400_000 + 12 * 3600_000,
  },
  {
    id: "qa-art-dash",
    threadId: null,
    title: "11월 지출 정리",
    kind: "dashboard",
    content: JSON.stringify({
      widgets: [
        { type: "stat", label: "이번 달 지출", value: "1,284,000원", delta: "지난달보다 8% 적어요" },
        { type: "bars", label: "주별 지출", unit: "원", points: [{ x: "1주", y: 268000 }, { x: "2주", y: 412000 }, { x: "3주", y: 292000 }, { x: "4주", y: 312000 }] },
        { type: "list", label: "많이 쓴 곳", items: ["배달의민족 182,000원", "쿠팡 164,500원", "카카오T 88,300원"] },
      ],
    }),
    createdAt: today - 86_400_000 + 9 * 3600_000,
    updatedAt: today - 86_400_000 + 11 * 3600_000,
  },
  {
    id: "qa-art-check",
    threadId: null,
    title: "이사 준비 체크리스트",
    kind: "checklist",
    content: "# 이사 준비\n\n- [ ] 이사 업체 견적 3곳\n- [ ] 전입신고 날짜 정하기\n- [ ] 인터넷 이전 신청\n- [ ] 도시가스 전출 신청\n- [ ] 우편물 주소 변경\n- [ ] 짐 정리 목록 만들기",
    createdAt: today - 4 * 86_400_000 + 12 * 3600_000,
    updatedAt: today - 3 * 86_400_000 + 12 * 3600_000,
  },
];

/** install the fixture routes on a context; returns nothing (records are read-only here) */
async function routeArchiveFixture(target, records) {
  await target.route(/\/api\/artifacts(\?.*)?$/, (r) => (r.request().method() === "GET" ? r.fulfill({ json: records }) : r.fallback()));
  await target.route(/\/api\/blobs\/[^/?]+/, (r) => {
    const id = decodeURIComponent(new URL(r.request().url()).pathname.split("/").pop());
    const a = records.find((x) => x.id === id);
    return a ? r.fulfill({ status: 200, contentType: a.kind === "dashboard" ? "application/json" : "text/markdown; charset=utf-8", body: a.content }) : r.fallback();
  });
  await target.route(/\/api\/attachments(\?.*)?$/, (r) => (r.request().method() === "GET" ? r.fulfill({ json: [] }) : r.fallback()));
}

async function archiveA(pass, browser, ctxOpts, ctx) {
  const c2 = await browser.newContext(ctxOpts);
  await c2.addInitScript((t) => localStorage.setItem("pickle.token", t), ctx.a.token);
  await routeArchiveFixture(c2, ARCHIVE_FIXTURE());
  const p2 = await c2.newPage();
  const errs = [];
  p2.on("console", (m) => m.type() === "error" && errs.push(m.text()));
  p2.on("pageerror", (e) => errs.push(`pageerror: ${e.message}`));
  const sub = new Pass(pass.engine, pass.variant, p2);
  sub.n = 80;
  try {
    await p2.goto(BASE + "/");
    await p2.waitForSelector("#tab-archive", { timeout: 15_000 });
    await p2.click("#tab-archive");
    await p2.waitForSelector(".screen-scroll .arc-card", { timeout: 10_000 });
    await sleep(600);
    const list = await p2.evaluate(() => {
      const scr = document.querySelector(".arc-screen")?.closest(".screen-scroll") ?? document;
      return {
        segs: [...scr.querySelectorAll('.arc-seg [role="tab"]')].map((t) => t.textContent.trim()),
        cards: [...scr.querySelectorAll(".arc-card")].map((c) => ({
          first: c.firstElementChild?.matches("h2.arc-card__title") ?? false,
          plate: c.querySelectorAll(".more-plate").length,
          meta: c.querySelector(".arc-card__meta")?.textContent ?? "",
          preview: c.querySelector(".arc-card__preview")?.textContent ?? "",
        })),
      };
    });
    pass.check("archive A: segments read 문서 | 사진·파일", list.segs.join("|") === "문서|사진·파일", list.segs.join("|"));
    pass.check("archive A: cards are led by their title, no kind plate", list.cards.length === 3 && list.cards.every((c) => c.first && c.plate === 0), JSON.stringify(list.cards.map((c) => [c.first, c.plate])));
    const want = [
      "참석: 하늘, 지현, 민호, 다은 · 42분 · 출시일은 12월 2일로 확정 · 랜딩 페이지는 시안 B · 하늘: 랜딩 문구 (금) · 지현: 앱 스토어 스크린샷 5장 · 지난주 베타 피드백 중",
      "이번 달 지출 1,284,000원 · 지난달보다 8% 적어요 · 많이 쓴 곳 배달의민족",
      "6개 중 0개 완료 · 이사 업체 견적 3곳 · 전입신고 날짜 정하기",
    ];
    pass.check("archive A: previews read as ' · ' sentences (no repeated title, checklist progress first)", list.cards.length === 3 && list.cards.every((c, i) => c.preview.startsWith(want[i])), list.cards.map((c) => c.preview.slice(0, 50)).join(" | "));
    pass.check("archive A: meta is '<kind> · <when> 수정'", list.cards[0]?.meta === "문서 · 어제 수정" && list.cards[1]?.meta === "대시보드 · 어제 수정" && list.cards[2]?.meta === "체크리스트 · 3일 전 수정", list.cards.map((c) => c.meta).join(" | "));
    await checkHeadings(sub, "보관함");
    await sub.shot("archive-a-list");

    // document sheet
    await p2.locator(".arc-card", { hasText: "주간회의" }).click();
    await p2.waitForSelector(".sheet-root .arc-doc .md", { timeout: 8000 });
    await sleep(900);
    const doc = await p2.evaluate(() => {
      const d = document.querySelector(".sheet-root .arc-doc");
      const kids = [...d.children].map((k) => k.className.split(" ")[0]);
      const tasks = d.querySelector(".md-tasks");
      return {
        kids,
        firstHeading: d.querySelector(".md .md-h")?.textContent ?? "",
        h1: d.querySelectorAll(".md .md-h1").length,
        tasksBg: tasks ? getComputedStyle(tasks).backgroundColor : "none",
      };
    });
    const order = ["arc-doc__meta", "arc-doc__body", "arc-doc__actions", "arc-doc__danger"].map((k) => doc.kids.indexOf(k));
    pass.check("archive A: the document sheet says its title once (no repeated H1)", doc.h1 === 0 && doc.firstHeading === "정한 것", `${doc.h1} h1 · first "${doc.firstHeading}"`);
    pass.check("archive A: share / copy sit under the record, delete last", order.every((x, i) => x >= 0 && (i === 0 || x > order[i - 1])), doc.kids.join(" > "));
    pass.check("archive A: tasks lie on the sheet (no inset panel)", doc.tasksBg === "rgba(0, 0, 0, 0)", doc.tasksBg);
    await checkHeadings(sub, "document sheet");
    await sub.shot("archive-a-doc");
    await closeSheet(p2);

    // summary (dashboard) sheet
    await p2.locator(".arc-card", { hasText: "지출" }).click();
    await p2.waitForSelector(".sheet-root .arc-doc .dash-list li", { timeout: 8000 });
    await sleep(1400);
    const dash = await p2.evaluate(() => {
      const d = document.querySelector(".sheet-root .arc-doc");
      const bg = [...d.querySelectorAll(".dash-stat, .dash-block")].map((e) => getComputedStyle(e).backgroundColor);
      const listR = d.querySelector(".dash-list")?.getBoundingClientRect().right ?? 0;
      const amounts = [...d.querySelectorAll(".dash-list__amount")].map((a) => Math.round(a.getBoundingClientRect().right - listR));
      return { bg, caption: d.querySelector(".dash-block__caption")?.textContent ?? "", amounts, labels: [...d.querySelectorAll(".dash-list__label")].map((l) => l.textContent) };
    });
    pass.check("archive A: summary sheet has no panels", dash.bg.length >= 3 && dash.bg.every((c) => c === "rgba(0, 0, 0, 0)"), dash.bg.join(" "));
    pass.check("archive A: the accent bar is said in words ('4주 · 312,000원')", dash.caption === "4주 · 312,000원", dash.caption);
    pass.check("archive A: amounts stand in one right column", dash.amounts.length === 3 && dash.amounts.every((x) => Math.abs(x) <= 1) && dash.labels.join() === "배달의민족,쿠팡,카카오T", `${dash.amounts.join(",")} · ${dash.labels.join(",")}`);
    await checkHeadings(sub, "summary sheet");
    await sub.shot("archive-a-dash");
    await closeSheet(p2);

    // empty 사진·파일: one action, no FAB
    await p2.locator('.arc-seg [role="tab"]', { hasText: "사진" }).click();
    await p2.waitForSelector(".arc-panels .empty-state", { timeout: 8000 });
    await sleep(700);
    const media = await p2.evaluate(() => ({
      fab: document.querySelectorAll(".arc-fab").length,
      buttons: document.querySelectorAll(".arc-panels .empty-state button").length,
      body: document.querySelector(".arc-panels .empty-state__body")?.textContent ?? "",
    }));
    pass.check("archive A: empty 사진·파일 has one action and no FAB", media.fab === 0 && media.buttons === 1, `${media.fab} fab · ${media.buttons} buttons`);
    pass.check("archive A: the empty copy names both ways in", /여기에서 올리거나 대화에서 \+ 버튼으로 보내면/.test(media.body), media.body);
    await sub.shot("archive-a-media");
    // back to 문서 so the next pass starts there (the segment is remembered for the session)
    await p2.locator('.arc-seg [role="tab"]', { hasText: "문서" }).click();
  } finally {
    pass.shots.push(...sub.shots);
    pass.overflows.push(...sub.overflows);
    pass.checks.push(...sub.checks);
    pass.errors.push(...errs.map((e) => `[archive A] ${e}`));
    await c2.close();
  }
}

/**
 * 내 전화번호: the server side is still being built, so the four endpoints are mocked with page.route (a stateful fake
 * that answers like the contract: invalid_phone, bad_code + attemptsLeft, expired, verify, delete). GET /api/profile is
 * the real response with the fake `phone` merged in.
 */
async function phone(pass) {
  const { page } = pass;
  const m = { phone: null, puts: 0, verifies: 0, deletes: 0, attempts: 3, sent: [], deliberate: 0 };
  const profileRe = /\/api\/profile(\?.*)?$/;
  // every phone path (any method, any query): the real server would place an actual call, so nothing may fall through
  const phoneRe = /\/api\/profile\/phone(\/|\?|$)/;
  const onProfile = async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const res = await route.fetch();
    const body = await res.json();
    await route.fulfill({ response: res, json: { ...body, phone: m.phone } });
  };
  const onPhone = async (route) => {
    const req = route.request();
    const method = req.method();
    const body = (() => {
      try {
        return req.postDataJSON();
      } catch {
        return null;
      }
    })();
    await sleep(300); // a real round trip
    if (method === "POST" && req.url().endsWith("/verify")) {
      m.verifies++;
      if (body?.code === "2222") return m.deliberate++, route.fulfill({ status: 410, json: { error: "expired" } });
      if (body?.code !== "4321") return m.deliberate++, route.fulfill({ status: 400, json: { error: "bad_code", attemptsLeft: --m.attempts } });
      m.phone = { masked: m.phone?.masked ?? "010-****-0000", verified: true };
      return route.fulfill({ json: m.phone });
    }
    if (method === "PUT") {
      m.puts++;
      m.sent.push(body?.phone);
      const d = String(body?.phone ?? "").replace(/\D/g, "");
      if (!d.startsWith("01")) return m.deliberate++, route.fulfill({ status: 400, json: { error: "invalid_phone" } });
      m.attempts = 3;
      m.phone = { masked: `${d.slice(0, 3)}-****-${d.slice(-4)}`, verified: false };
      return route.fulfill({ json: m.phone });
    }
    if (method === "DELETE") {
      m.deletes++;
      m.phone = null;
      return route.fulfill({ json: { ok: true } });
    }
    return route.fulfill({ status: 404, json: { error: "not_found" } });
  };
  await page.route(profileRe, onProfile);
  await page.route(phoneRe, onPhone);
  pass.expectedUrls.push(phoneRe);
  try {
    await tab(pass, "profile");
    const row = page.locator(".screen-scroll .profile-phone-row").first();
    await row.waitFor({ timeout: 10_000 });
    await reveal(page, row);
    pass.check("phone: row says 등록 안 됨 before a number exists", (await row.innerText()).includes("등록 안 됨"), (await row.innerText()).replace(/\s+/g, " "));
    await pass.shot("phone-row-empty");

    // step 1: tel field
    await pass.window("phone-open", () => row.click());
    await page.waitForSelector('.sheet-root .phone-step[data-step="enter"]', { timeout: 6000 });
    await sleep(500);
    const tel = page.locator('.sheet-root input[type="tel"]');
    const attrs = await tel.evaluate((el) => ({ im: el.inputMode, ac: el.autocomplete, fs: parseFloat(getComputedStyle(el).fontSize) }));
    pass.check("phone: tel field (inputmode tel, autocomplete tel, ≥16px)", attrs.im === "tel" && attrs.ac === "tel" && attrs.fs >= 16, JSON.stringify(attrs));
    const sheetText = (await page.locator(".sheet-root").innerText()).replace(/\u00a0/g, " "); // copy()'s nbsp ties ("이\u00a0번호로만")
    pass.check("phone: helper says who calls and that it comes from +1", /이 번호로만 걸어요/.test(sheetText) && /해외 번호\(\+1\)/.test(sheetText));
    const big = await tel.evaluate((el) => ({ ph: el.placeholder, fs: parseFloat(getComputedStyle(el).fontSize), fw: getComputedStyle(el).fontWeight }));
    pass.check(
      "phone B: the number field is large (title3 600) with no placeholder; the +1 note sits on its button with no glyph",
      big.ph === "" && big.fs >= 20 && Number(big.fw) >= 600 && (await page.locator(".sheet-root .phone-cta .more-note").count()) === 1 && (await page.locator(".sheet-root .phone-cta .more-note svg").count()) === 0,
      JSON.stringify(big),
    );
    const call = page.locator(".sheet-root .phone-call");
    pass.check("phone: 인증 전화 받기 waits for a number", await call.isDisabled());
    await pass.shot("phone-enter");

    await tel.fill("021234567");
    await call.click();
    await page.waitForSelector(".sheet-root .tf.is-invalid", { timeout: 6000 });
    const invalid = await page.locator(".sheet-root .phone-tel").innerText();
    pass.check("phone: invalid_phone shows a Korean error at the field", /번호 형식이 맞지 않아요/.test(invalid), invalid.replace(/\s+/g, " "));
    await pass.shot("phone-invalid");

    await tel.fill("01012345678");
    const formatted = await tel.inputValue();
    pass.check("phone: the number is grouped as it is typed", formatted === "010-1234-5678", formatted);
    await pass.window("phone-call", () => call.click());
    await page.waitForSelector('.sheet-root .phone-step[data-step="code"]', { timeout: 8000 });
    await sleep(700);
    pass.check("phone: PUT went out with the number", m.puts === 2 && m.sent.at(-1) === "01012345678", m.sent.join(","));

    // step 2: one-time code
    const otp = page.locator(".sheet-root .phone-otp__input");
    const oattrs = await otp.evaluate((el) => ({ im: el.inputMode, ac: el.autocomplete, max: el.maxLength, fs: parseFloat(getComputedStyle(el).fontSize) }));
    pass.check("phone: code field (one-time-code, numeric, 4 digits, ≥16px)", oattrs.ac === "one-time-code" && oattrs.im === "numeric" && oattrs.max === 4 && oattrs.fs >= 16, JSON.stringify(oattrs));
    const resend = page.locator(".sheet-root .phone-resend");
    const r0 = (await resend.innerText()).trim();
    pass.check("phone: 다시 걸기 waits with a countdown", (await resend.isDisabled()) && /다시 걸기 · \d+초/.test(r0), r0);
    await otp.click();
    await sleep(200);
    await pass.shot("phone-code");

    await page.keyboard.type("1111", { delay: 60 });
    await page.waitForSelector(".sheet-root .phone-error", { timeout: 6000 });
    const bad = await page.locator(".sheet-root .phone-error").innerText();
    pass.check("phone: a wrong code says how many tries are left", /숫자가 맞지 않아요/.test(bad) && /2번 더/.test(bad), bad);
    pass.check("phone: the cells clear for another try", (await otp.inputValue()) === "");
    await pass.shot("phone-bad-code");

    await otp.click();
    await page.keyboard.type("2222", { delay: 60 });
    await page.waitForFunction(() => /시간이 지났어요/.test(document.querySelector(".sheet-root .phone-error")?.textContent ?? ""), null, { timeout: 6000 });
    pass.check("phone: an expired code says to call again", true);
    await pass.shot("phone-expired");

    // 다시 걸기 unlocks after 30 s
    await page.waitForFunction(() => !document.querySelector(".sheet-root .phone-resend")?.disabled, null, { timeout: 40_000 });
    await pass.shot("phone-resend-ready");
    await pass.window("phone-resend", () => resend.click());
    await page.waitForFunction(() => /다시 걸기 · \d+초/.test(document.querySelector(".sheet-root .phone-resend")?.textContent ?? ""), null, { timeout: 8000 });
    pass.check("phone: 다시 걸기 calls again and restarts the countdown", m.puts === 3, `${m.puts} PUTs`);

    // 번호 바꾸기 → back to step 1 with the number kept
    await pass.window("phone-change", () => page.locator(".sheet-root .phone-change").click());
    await page.waitForSelector('.sheet-root .phone-step[data-step="enter"]', { timeout: 6000 });
    await sleep(500);
    pass.check("phone: 번호 바꾸기 keeps the typed number", (await tel.inputValue()) === "010-1234-5678", await tel.inputValue());
    await pass.shot("phone-change");
    await tel.fill("01098765432");
    await call.click();
    await page.waitForSelector('.sheet-root .phone-step[data-step="code"]', { timeout: 8000 });
    await sleep(600);
    await otp.click();
    await page.keyboard.type("4321", { delay: 60 });
    await page.waitForSelector('.sheet-root .phone-verify[data-state="success"]', { timeout: 6000 });
    await sleep(250);
    await pass.shot("phone-verified-check");
    await page.locator(".sheet-root").waitFor({ state: "detached", timeout: 6000 });
    await sleep(500);
    const rowText = (await row.innerText()).replace(/\s+/g, " ");
    pass.check("phone: verified → sheet closes, row shows the number with 인증됨", rowText.includes("010-****-5432") && rowText.includes("인증됨"), rowText);
    await pass.shot("phone-row-verified");

    // verified: 번호 삭제 (two-step)
    await pass.window("phone-reopen", () => row.click());
    await page.waitForSelector('.sheet-root .phone-step[data-step="done"]', { timeout: 6000 });
    await sleep(500);
    await pass.shot("phone-done");
    await twoStep(page, "번호 삭제", "한 번 더 누르면 삭제해요");
    await page.locator(".sheet-root").waitFor({ state: "detached", timeout: 8000 });
    await sleep(500);
    const after = (await row.innerText()).replace(/\s+/g, " ");
    pass.check("phone: 번호 삭제 reaches the server and the row says 등록 안 됨", m.deletes === 1 && after.includes("등록 안 됨"), after);
    await pass.shot("phone-row-deleted");
    const logged = pass.expected.filter((e) => /\/api\/profile\/phone/.test(e)).length;
    pass.check("phone: the only browser-logged failures are the contract errors asked for", logged <= m.deliberate, `${logged} logged · ${m.deliberate} asked`);
  } finally {
    pass.expectedUrls.splice(pass.expectedUrls.indexOf(phoneRe), 1);
    await page.unroute(profileRe, onProfile);
    await page.unroute(phoneRe, onPhone);
  }
}

// ── run ──

const results = { at: new Date().toISOString(), api: API, passes: [] };
const preview = await startPreview();
let failed = 0;
try {
  const arc = want("archive") ? await seedArchiveUser() : null;
  if (arc) console.log(`archive seed: ${arc.artifacts} artifact(s)`);
  for (const engine of ENGINES) {
    const browser = engine === "webkit" ? await webkit.launch() : await chromium.launch({ channel: "chrome" });
    for (const variant of VARIANTS) {
      console.log(`\n── ${engine} · ${variant}`);
      const agentName = "깽이";
      const a = await signupApi(`qa${rand()}m`, "하늘", agentName);
      const b = await signupApi(`qa${rand()}f`, "진우", "콩이");
      const c = variant === "light" && want("friends") ? await signupApi(`qa${rand()}c`, "다은", "모모") : null;
      const seeded = [];
      for (const s of [
        { title: "모닝콜", prompt: "7시 30분에 전화로 깨워 줘", rule: "daily@07:30" },
        { title: "출석체크", prompt: "평일 9시에 출석체크 알려 줘", rule: "weekly@1,2,3,4,5@09:00" },
        { title: "저녁 브리핑", prompt: "내일 일정과 날씨를 정리해 줘", rule: "daily@21:30", enabled: false },
      ])
        seeded.push((await api("POST", "/api/schedules", s, a.token)).body);
      // the daily briefing (default 07:30 KST) runs for every new account within two hours of its time, so a pass between
      // 07:30 and 09:30 KST raced it: the first message of a scenario got 409 (busy elsewhere). QA accounts keep it off.
      for (const u of [a, b, c].filter(Boolean)) await api("PATCH", "/api/settings", { notifications: { briefing: false } }, u.token);
      const ctxOpts = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: false, hasTouch: false, colorScheme: variant === "dark" ? "dark" : "light", reducedMotion: variant === "reduced" ? "reduce" : "no-preference", locale: "ko-KR", timezoneId: "Asia/Seoul" };
      const context = await browser.newContext(ctxOpts);
      await context.addInitScript((t) => localStorage.setItem("pickle.token", t), a.token);
      await context.addInitScript(INIT);
      const page = await context.newPage();
      const pass = new Pass(engine, variant, page);
      // explore counts: the first three popular templates come back with 0 / null / no count and the fourth with 1234,
      // so the screen must show "N명이 맡겼어요" only for a real value (the rest keep the server's own counts)
      const exploreCounts = {};
      const exploreRewritten = [];
      if (want("explore"))
        await page.route(/\/api\/explore(\?.*)?$/, async (route) => {
          if (route.request().method() !== "GET") return route.continue();
          const res = await route.fetch();
          const body = await res.json();
          exploreRewritten.length = 0;
          (body.popular ?? []).forEach((t, i) => {
            if (i === 0) t.count = 0;
            else if (i === 1) t.count = null;
            else if (i === 2) delete t.count;
            else if (i === 3) t.count = 1234; // and one real count, so the positive side never depends on server data
            if (i < 4) exploreRewritten.push(t.id);
            exploreCounts[t.id] = t.count;
          });
          await route.fulfill({ response: res, json: body });
        });
      page.on("console", (m) => {
        if (m.type() !== "error") return;
        // a contract error response the scenario asked for (e.g. 400 bad_code) is logged by the browser itself: count it apart
        const url = m.location()?.url ?? "";
        if (/^Failed to load resource: the server responded with a status of 4\d\d/.test(m.text()) && pass.expectedUrls.some((re) => re.test(url))) pass.expected.push(`${m.text()} ${url}`);
        else pass.errors.push(m.text());
      });
      page.on("pageerror", (e) => pass.errors.push(`pageerror: ${e.message}`));
      const ctx = { a, b, c, agentName, schedules: seeded, exploreCounts, exploreRewritten };
      await page.goto(BASE + "/");
      await page.waitForSelector("#tab-explore", { timeout: 20_000 });
      await sleep(1200);
      const steps = [
        ["explore", explore],
        ["profile", profile],
        ["phone", phone],
        ["schedules", seeded.length === 3 && seeded.every((x) => x?.id) ? schedules : null],
        ["display", display],
        ["privacy", privacySettings],
        ["notifications", notificationsSettings],
        ["connections", connections],
        ["vault", vault],
        ["friends", friends],
        ["agent", agent],
      ];
      for (const [name, fn] of steps) {
        if (!want(name) || !fn) continue;
        try {
          await tab(pass, "profile");
          await (await activeScroller(page)).evaluate((el) => el?.scrollTo(0, 0)).catch(() => {});
          await fn(pass, ctx);
        } catch (e) {
          pass.check(`${name}: scenario ran`, false, e.message.split("\n")[0]);
          await page.screenshot({ path: path.join(outDir, `more-${pass.tag}-error-${name}.png`) }).catch(() => {});
          for (let i = 0; i < 4 && (await page.locator('.tb-circle[aria-label="뒤로"]').count()); i++) {
            await closeSheet(page).catch(() => {});
            await back(page).catch(() => {});
          }
        }
      }
      if (want("archive")) {
        await archiveA(pass, browser, ctxOpts, ctx).catch((e) => pass.check("archive A: scenario ran", false, e.message.split("\n")[0]));
        await archive(pass, browser, ctxOpts, arc).catch((e) => pass.check("archive: scenario ran", false, e.message));
      }

      const perf = await page.evaluate(() => {
        const qa = window.__qa;
        if (!qa) return { supported: false, long: [] };
        const hits = [];
        for (const w of qa.windows) {
          const end = w.end || performance.now();
          for (const l of qa.long) if (l.dur > 50 && l.start < end && l.start + l.dur > w.start) hits.push({ window: w.name, dur: Math.round(l.dur) });
        }
        return { supported: PerformanceObserver.supportedEntryTypes?.includes("longtask") ?? false, windows: qa.windows.length, long: hits };
      });
      const r = {
        engine,
        variant,
        checks: pass.checks,
        failed: pass.checks.filter((c) => !c.ok).map((c) => c.name),
        consoleErrors: pass.errors,
        overflow: pass.overflows,
        longTasks: perf,
        skipped: pass.skipped,
        expectedErrors: pass.expected,
        screenshots: pass.shots.length,
      };
      results.passes.push(r);
      failed += r.failed.length + r.consoleErrors.length + r.overflow.length + (engine === "chromium" ? perf.long.length : 0);
      console.log(`  checks ${r.checks.length - r.failed.length}/${r.checks.length} · console errors ${r.consoleErrors.length} · overflow ${r.overflow.length} · long tasks ${engine === "chromium" ? perf.long.length : "n/a"} · shots ${r.screenshots}`);
      for (const e of r.consoleErrors) console.log(`    console: ${e.slice(0, 200)}`);
      for (const o of r.overflow) console.log(`    overflow: ${o.file} ${o.doc} ${o.offenders.join(" | ")}`);
      for (const l of perf.long) console.log(`    long task: ${l.window} ${l.dur}ms`);
      await context.close();
    }
    await browser.close();
  }
} finally {
  preview.kill();
  fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(results, null, 2));
}
console.log(`\n${failed ? `${failed} problem(s)` : "all clean"} · results: docs/qa/more/results.json`);
process.exit(failed ? 1 : 0);
