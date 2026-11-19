/*
 * Static server for the draft comparison viewer.
 *
 *   bun docs/design/drafts/serve.ts            # http://127.0.0.1:8810/drafts/
 *   PORT=8811 bun docs/design/drafts/serve.ts
 *
 * - Serves docs/design/ (so ../impeccable/shots and ../impeccable/critique resolve from /drafts/).
 * - Also serves apps/mobile/src/** read-only at /apps/mobile/src/**: the draft HTML links the app's real CSS as
 *   ../../../../apps/mobile/src/styles/tokens.css, which a browser resolves to that path on this origin.
 * - GET /drafts/_status.json lists every feature folder that holds a meta.json or a draft .html, with file mtimes, so
 *   the viewer can poll without probing for missing files (no 404 noise in the console).
 * - POST /drafts/api/picks takes the user's picks (현재 유지 / A / B + memo) and writes picks.json + .picks.log
 *   (see APPLY.md and picks-lib.ts). Same-origin only: the Origin must be this server, the Host must be this server.
 * - Bound to 127.0.0.1 only, with no-cache headers on everything. Memo text is never printed to the console.
 */
import { readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import {
  PICKS,
  MEMO_MAX,
  manifestFeatures,
  variantIds,
  cleanText,
  textLength,
  readPicks,
  writePicks,
  appendLog,
  core,
  type Picks,
} from "./picks-lib.ts";

const here = import.meta.dir;
const ROOT = path.resolve(here, ".."); // docs/design
const REPO = path.resolve(ROOT, "../.."); // pickle-clone
const APP_SRC = path.join(REPO, "apps/mobile/src");
const DRAFTS = here;
const PORT = Number(process.env.PORT || 8810);
const BLOCKED = new Set([8787, 5173, 8781, 8782, 8794, 8795]);
if (BLOCKED.has(PORT)) throw new Error(`port ${PORT} is reserved`);
const ORIGINS = new Set([`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`]);
const HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
const MAX_BODY = 16 * 1024;
if (!existsSync(PICKS)) writePicks({});

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};
const APP_EXT = new Set([".css", ".svg", ".png", ".jpg", ".webp", ".woff2"]);
const HEADERS = {
  "cache-control": "no-store, no-cache, must-revalidate",
  pragma: "no-cache",
  "x-content-type-options": "nosniff",
};

function inside(base: string, p: string) {
  const rel = path.relative(base, p);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function status() {
  const features: Record<string, Record<string, number>> = {};
  for (const d of readdirSync(DRAFTS, { withFileTypes: true })) {
    if (!d.isDirectory() || d.name.startsWith(".") || d.name === "_kit" || d.name === "_viewer-shots") continue;
    const dir = path.join(DRAFTS, d.name);
    const top = readdirSync(dir);
    if (!top.includes("meta.json") && !top.some((n) => n.endsWith(".html"))) continue;
    const files: Record<string, number> = {};
    const walk = (sub: string) => {
      for (const f of readdirSync(path.join(dir, sub), { withFileTypes: true })) {
        if (f.name.startsWith(".")) continue;
        const rel = sub ? `${sub}/${f.name}` : f.name;
        if (f.isDirectory()) {
          if (rel.split("/").length < 3) walk(rel);
        } else files[rel] = Math.round(statSync(path.join(dir, rel)).mtimeMs);
      }
    };
    walk("");
    features[d.name] = files;
  }
  return { at: Date.now(), features };
}

function bad(status: number, error: string) {
  return Response.json({ ok: false, error }, { status, headers: HEADERS });
}

async function postPicks(req: Request): Promise<Response> {
  if (req.method !== "POST") return bad(405, "POST만 받아요");
  const origin = req.headers.get("origin");
  if (!origin || !ORIGINS.has(origin)) return bad(403, "이 뷰어에서만 제출할 수 있어요");
  const type = (req.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (type !== "application/json") return bad(400, "Content-Type은 application/json이어야 해요");
  if (Number(req.headers.get("content-length") || 0) > MAX_BODY) return bad(400, "요청이 너무 커요 (16 KB 이하)");
  const buf = await req.arrayBuffer();
  if (buf.byteLength > MAX_BODY) return bad(400, "요청이 너무 커요 (16 KB 이하)");
  let body: any;
  try {
    body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buf));
  } catch {
    return bad(400, "JSON을 읽지 못했어요");
  }
  const list = body && body.picks;
  if (!Array.isArray(list) || list.length === 0 || list.length > 50) return bad(400, "picks는 1개 이상의 배열이어야 해요");
  const features = manifestFeatures();
  const seen = new Set<string>();
  const clean: { feature: string; choice: string; memo: string }[] = [];
  for (const p of list) {
    if (!p || typeof p !== "object" || Array.isArray(p)) return bad(400, "pick 형식이 맞지 않아요");
    const feature = p.feature;
    if (typeof feature !== "string" || !features.has(feature)) return bad(400, `알 수 없는 기능이에요: ${String(feature).slice(0, 40)}`);
    if (seen.has(feature)) return bad(400, `같은 기능이 두 번 있어요: ${feature}`);
    seen.add(feature);
    const allowed = ["current", ...variantIds(feature)];
    if (typeof p.choice !== "string" || !allowed.includes(p.choice))
      return bad(400, `${feature}: 고를 수 있는 값은 ${allowed.join(", ")}이에요`);
    if (p.memo !== undefined && p.memo !== null && typeof p.memo !== "string") return bad(400, `${feature}: memo는 문자열이어야 해요`);
    const memo = cleanText(p.memo);
    if (textLength(memo) > MEMO_MAX) return bad(400, `${feature}: 고칠 점은 ${MEMO_MAX}자 이하로 써 주세요`);
    clean.push({ feature, choice: p.choice, memo });
  }
  let picks: Picks;
  try {
    picks = readPicks();
  } catch {
    return bad(500, "picks.json을 읽지 못했어요. 파일을 확인해 주세요");
  }
  const at = new Date().toISOString();
  for (const c of clean) {
    const prev = picks[c.feature];
    picks[c.feature] = {
      choice: c.choice,
      memo: c.memo,
      submittedAt: at,
      status: "submitted",
      history: prev ? [...(Array.isArray(prev.history) ? prev.history : []), core(prev)] : [],
    };
  }
  writePicks(picks);
  for (const c of clean) appendLog({ at, ...c });
  console.log(`picks submitted ${at}: ${clean.map((c) => `${c.feature}=${c.choice}${c.memo ? "+memo" : ""}`).join(", ")}`);
  return Response.json({ ok: true, at, picks: Object.fromEntries(clean.map((c) => [c.feature, picks[c.feature]])) }, { headers: HEADERS });
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: PORT,
  fetch(req) {
    const url = new URL(req.url);
    let pathname: string;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      return new Response("bad path", { status: 400, headers: HEADERS });
    }
    if (!HOSTS.has(req.headers.get("host") || "")) return new Response("forbidden host", { status: 403, headers: HEADERS });
    if (pathname === "/drafts/api/picks") return postPicks(req);
    if (req.method !== "GET" && req.method !== "HEAD") return new Response("method not allowed", { status: 405, headers: HEADERS });
    if (pathname === "/" || pathname === "/drafts") return Response.redirect("/drafts/", 302);
    if (pathname === "/drafts/_status.json") return Response.json(status(), { headers: HEADERS });
    if (pathname === "/drafts/picks.json")
      return new Response(existsSync(PICKS) ? Bun.file(PICKS) : "{}", { headers: { ...HEADERS, "content-type": TYPES[".json"] } });

    // never serve dotfiles (.picks.log holds memos, .serve.pid / .serve.log are local state)
    if (pathname.split("/").some((seg) => seg.startsWith("."))) return new Response("not found", { status: 404, headers: HEADERS });
    let file: string;
    if (pathname.startsWith("/apps/mobile/src/")) {
      file = path.join(APP_SRC, pathname.slice("/apps/mobile/src/".length));
      if (!inside(APP_SRC, file) || !APP_EXT.has(path.extname(file))) return new Response("not found", { status: 404, headers: HEADERS });
    } else {
      file = path.join(ROOT, pathname);
      if (!inside(ROOT, file)) return new Response("not found", { status: 404, headers: HEADERS });
    }
    if (existsSync(file) && statSync(file).isDirectory()) {
      if (!pathname.endsWith("/")) return Response.redirect(`${pathname}/`, 302);
      file = path.join(file, "index.html");
    }
    if (!existsSync(file)) return new Response("not found", { status: 404, headers: HEADERS });
    const type = TYPES[path.extname(file).toLowerCase()] || "application/octet-stream";
    return new Response(Bun.file(file), { headers: { ...HEADERS, "content-type": type } });
  },
});

console.log(`draft viewer: http://${server.hostname}:${server.port}/drafts/  (pid ${process.pid})`);
