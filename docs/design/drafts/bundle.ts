/*
 * Publish bundle for the draft viewer: one self-contained folder that works from any static host (or a claude.ai
 * artifact published from files). Run through bundle.sh.
 *
 *   bun docs/design/drafts/bundle.ts <out-dir>
 *
 * Layout of <out-dir>:
 *   index.html viewer.css viewer.js   the viewer, config rewritten (shots/, engines: chromium, data: bundle-data.json)
 *   bundle-data.json                  every text file the viewer reads: manifest, _status, meta.json, notes.md,
 *                                     critiques, slop inventory; plus `live`: each draft HTML with its CSS/JS inlined
 *                                     (shown through iframe srcdoc, so no relative links can break)
 *   shots/chromium-<screen>.jpg       only the 현재 screens the drafts compare against (features without a draft get
 *                                     their primary screen), light | dark packed side by side in one JPEG
 *   <feature>/<variant>[-<state>].jpg draft captures (Chrome), light | dark packed side by side, JPEG q82
 * Packing the two themes into one image halves the file count; the viewer shows one half (url#L / url#R).
 * Needs python3 with Pillow (PIL) for the packing.
 * Budget: < 200 files and < 40 MB. The script fails (exit 2) when the budget is exceeded.
 */
import { readdirSync, readFileSync, statSync, existsSync, mkdirSync, rmSync, copyFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const DRAFTS = import.meta.dir;
const ROOT = path.resolve(DRAFTS, ".."); // docs/design
const REPO = path.resolve(ROOT, "../..");
const SHOTS = path.join(ROOT, "impeccable/shots");
const CRIT = path.join(ROOT, "impeccable/critique");
const OUT = path.resolve(process.argv[2] || "draft-bundle");
const MAX_FILES = 200;
const MAX_BYTES = 40 * 1024 * 1024;

if (OUT === "/" || OUT === REPO || OUT.startsWith(DRAFTS) || !path.basename(OUT)) throw new Error(`refusing to write to ${OUT}`);
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const HTML_RE = /^([a-z])(?:[-_]([^/]+))?\.html$/i;
const SHOT_RE = /^(?:png\/|shots\/)?([a-z])(?:[-_](.+?))?-(light|dark)(-webkit)?\.(png|jpe?g)$/i;
const shotKey = (f: string) =>
  f.split("/").pop()!.replace(/^(chromium|webkit)-(light|dark)-/, "").replace(/\.(jpe?g|png)$/i, "");

const files: Record<string, string> = {}; // url -> text, read by the viewer instead of fetch
const live: Record<string, string> = {}; // "feature/X.html" -> inlined document
const rename: Record<string, string> = {}; // "feature/png/A-light.png" -> "png/A-light.jpg"
const status: { at: number; features: Record<string, Record<string, number>> } = { at: Date.now(), features: {} };
const warnings: string[] = [];
const currentKeys = new Set<string>();

const manifest: any[] = JSON.parse(readFileSync(path.join(DRAFTS, "manifest.json"), "utf8"));
files["manifest.json"] = JSON.stringify(manifest);

function walk(dir: string, sub = ""): string[] {
  const out: string[] = [];
  for (const d of readdirSync(path.join(dir, sub), { withFileTypes: true })) {
    if (d.name.startsWith(".")) continue;
    const rel = sub ? `${sub}/${d.name}` : d.name;
    if (d.isDirectory()) {
      if (rel.split("/").length < 3) out.push(...walk(dir, rel));
    } else out.push(rel);
  }
  return out;
}

/* inline <link rel=stylesheet>, <script src> and relative <img src> so the mock needs no other file */
function inlineHtml(file: string): string {
  const dir = path.dirname(file);
  const read = (ref: string) => {
    const p = path.resolve(dir, ref.split(/[?#]/)[0]);
    if (!p.startsWith(REPO + path.sep) || !existsSync(p)) {
      warnings.push(`${path.relative(REPO, file)}: cannot inline ${ref}`);
      return null;
    }
    return p;
  };
  const cssWithUrls = (p: string) =>
    readFileSync(p, "utf8").replace(/url\(\s*(['"]?)(?!data:|#|https?:)([^'")]+)\1\s*\)/g, (m, _q, ref) => {
      const asset = path.resolve(path.dirname(p), ref);
      if (!existsSync(asset)) return m;
      const ext = path.extname(asset).slice(1).toLowerCase();
      const mime = ext === "svg" ? "image/svg+xml" : ext === "jpg" ? "image/jpeg" : `image/${ext}`;
      return `url("data:${mime};base64,${readFileSync(asset).toString("base64")}")`;
    });
  let html = readFileSync(file, "utf8");
  html = html.replace(/<link\b[^>]*rel=["']?stylesheet["']?[^>]*>/gi, (tag) => {
    const href = (tag.match(/href=["']([^"']+)["']/i) || [])[1];
    if (!href || /^(https?:|data:)/.test(href)) return tag;
    const p = read(href);
    return p ? `<style data-src="${href}">\n${cssWithUrls(p).replace(/<\/style/gi, "<\\/style")}\n</style>` : tag;
  });
  html = html.replace(/<script\b([^>]*)\bsrc=["']([^"']+)["']([^>]*)>\s*<\/script>/gi, (tag, a, src, b) => {
    if (/^(https?:|data:)/.test(src)) return tag;
    const p = read(src);
    if (!p) return tag;
    const js = readFileSync(p, "utf8").replace(/<\/script/gi, "<\\/script");
    return `<script${a}${b} data-src="${src}">\n${js}\n</script>`;
  });
  // srcdoc has no query string: the viewer injects window.__DV_SEARCH ("?theme=dark&state=…") instead
  html = html.replace(/\blocation\.search\b/g, "(window.__DV_SEARCH || location.search)");
  html = html.replace(/<img\b([^>]*)\bsrc=["'](?!data:|https?:)([^"']+)["']/gi, (tag, a, src) => {
    const p = read(src);
    if (!p) return tag;
    const ext = path.extname(p).slice(1).toLowerCase();
    const mime = ext === "svg" ? "image/svg+xml" : ext === "jpg" ? "image/jpeg" : `image/${ext}`;
    return `<img${a}src="data:${mime};base64,${readFileSync(p).toString("base64")}"`;
  });
  return html;
}

const packs: { light: string | null; dark: string | null; out: string }[] = [];
const PACK_PY = `
import json, sys
from PIL import Image
for job in json.load(sys.stdin):
    ims = [Image.open(p).convert("RGB") if p else None for p in (job["light"], job["dark"])]
    w = max(i.width for i in ims if i); h = max(i.height for i in ims if i)
    out = Image.new("RGB", (w * 2, h), (128, 128, 128))
    for n, im in enumerate(ims):
        if im:
            out.paste(im.resize((w, h)) if im.size != (w, h) else im, (n * w, 0))
    out.save(job["out"], "JPEG", quality=82, optimize=True, progressive=True)
`;
function runPacks() {
  for (const p of packs) mkdirSync(path.dirname(p.out), { recursive: true });
  const r = spawnSync("python3", ["-c", PACK_PY], { cwd: OUT, input: JSON.stringify(packs), encoding: "utf8" });
  if (r.status !== 0) throw new Error(`packing failed (python3 + Pillow needed): ${r.stderr}`);
}

/* ── feature folders ─────────────────────────────────────────────────── */
const known = new Set(manifest.map((m) => m.feature));
const folders = readdirSync(DRAFTS, { withFileTypes: true })
  .filter((d) => d.isDirectory() && !d.name.startsWith(".") && !d.name.startsWith("_"))
  .map((d) => d.name)
  .sort();
for (const f of folders) {
  const dir = path.join(DRAFTS, f);
  const all = walk(dir);
  const hasMeta = all.includes("meta.json");
  const htmls = all.filter((n) => !n.includes("/") && HTML_RE.test(n));
  if (!hasMeta && !htmls.length) continue;
  if (!known.has(f)) warnings.push(`${f}/ is not in manifest.json (bundled as an extra feature)`);
  const list: Record<string, number> = {};
  const mt = (rel: string) => Math.round(statSync(path.join(dir, rel)).mtimeMs);
  let meta: any = null;
  if (hasMeta) {
    const t = readFileSync(path.join(dir, "meta.json"), "utf8");
    files[`${f}/meta.json`] = t;
    list["meta.json"] = mt("meta.json");
    try {
      meta = JSON.parse(t);
    } catch {
      warnings.push(`${f}/meta.json is not valid JSON`);
    }
  }
  if (all.includes("notes.md")) {
    files[`${f}/notes.md`] = readFileSync(path.join(dir, "notes.md"), "utf8");
    list["notes.md"] = mt("notes.md");
  }
  for (const h of htmls) {
    const doc = inlineHtml(path.join(dir, h));
    live[`${f}/${h}`] = doc;
    list[h] = mt(h);
    const km = doc.match(/<script[^>]*id=["']kit-meta["'][^>]*>([\s\S]*?)<\/script>/i);
    if (km) {
      try {
        for (const c of JSON.parse(km[1]).compare || []) currentKeys.add(`${f}|${shotKey(c)}`);
      } catch {
        /* viewer copes */
      }
    }
  }
  // captures: one file per (variant, state, theme), Chrome only, preferring what the viewer prefers
  const pref = (rel: string) => (rel.includes("/") ? 2 : 0) + (/\.png$/i.test(rel) ? 1 : 0);
  const chosen = new Map<string, string>();
  for (const rel of all) {
    const m = rel.match(SHOT_RE);
    if (!m || m[4]) continue; // skip -webkit
    const stem = `${m[1].toUpperCase()}|${(m[2] || "").toLowerCase()}|${m[3]}`;
    const prev = chosen.get(stem);
    if (!prev || pref(rel) < pref(prev)) chosen.set(stem, rel);
  }
  const pairs = new Map<string, { light?: string; dark?: string }>();
  for (const [stem, rel] of chosen) {
    const [id, state, theme] = stem.split("|");
    const k = `${id}|${state}`;
    if (!pairs.has(k)) pairs.set(k, {});
    (pairs.get(k) as any)[theme] = rel;
    list[rel] = mt(rel);
  }
  for (const [k, pr] of pairs) {
    const [id, state] = k.split("|");
    const outRel = `${state ? `${id}-${state}` : id}.jpg`;
    packs.push({ light: pr.light ? path.join(dir, pr.light) : null, dark: pr.dark ? path.join(dir, pr.dark) : null, out: path.join(OUT, f, outRel) });
    if (pr.light) rename[`${f}/${pr.light}`] = `${outRel}#L`;
    if (pr.dark) rename[`${f}/${pr.dark}`] = `${outRel}#R`;
  }
  status.features[f] = list;
  // 현재 screens the draft compares against
  const cur = (arr: any) => (Array.isArray(arr) ? arr : []).forEach((c: string) => currentKeys.add(`${f}|${shotKey(c)}`));
  if (meta) {
    cur(meta.current);
    for (const v of meta.variants || []) {
      for (const s of v.states || []) cur(s.current);
      for (const s of v.extraShots || []) cur(s.current);
    }
  }
}
for (const fe of manifest) {
  const has = [...currentKeys].some((k) => k.startsWith(fe.feature + "|"));
  if (!has && fe.primary) currentKeys.add(`${fe.feature}|${fe.primary}`);
}

/* ── 현재 shots (Chrome, light + dark) ─────────────────────────────────── */
mkdirSync(path.join(OUT, "shots"), { recursive: true });
const screenKeys = new Set<string>();
for (const fk of currentKeys) {
  const key = fk.split("|")[1];
  if (screenKeys.has(key)) continue;
  const src = (theme: string) => {
    const p = path.join(SHOTS, `chromium-${theme}-${key}.jpg`);
    if (existsSync(p)) return p;
    warnings.push(`missing 현재 shot chromium-${theme}-${key}.jpg`);
    return null;
  };
  const light = src("light");
  const dark = src("dark");
  if (!light && !dark) continue;
  packs.push({ light, dark, out: path.join(OUT, "shots", `chromium-${key}.jpg`) });
  screenKeys.add(key);
}
runPacks();

/* ── critiques + inventory ─────────────────────────────────────────── */
for (const fe of manifest) {
  const name = fe.critique || `${fe.feature}.md`;
  const p = path.join(CRIT, name);
  if (existsSync(p)) files[`critique/${name}`] = readFileSync(p, "utf8");
  else warnings.push(`missing critique ${name}`);
}
files["slop-inventory.md"] = readFileSync(path.join(ROOT, "impeccable/slop-inventory.md"), "utf8");
files["_status.json"] = JSON.stringify(status);

writeFileSync(
  path.join(OUT, "bundle-data.json"),
  JSON.stringify({ at: new Date().toISOString(), files, live, rename, shots: [...screenKeys].sort() }),
);

/* ── viewer ────────────────────────────────────────────────────────── */
const cfg = {
  shots: "shots/",
  critique: "critique/",
  inventory: "slop-inventory.md",
  status: "_status.json",
  engines: ["chromium"],
  packed: true,
  poll: 0,
  data: "bundle-data.json",
};
let index = readFileSync(path.join(DRAFTS, "index.html"), "utf8");
const before = index;
index = index.replace(
  /(<script id="viewer-config" type="application\/json">)[\s\S]*?(<\/script>)/,
  (_m, a, b) => `${a}\n${JSON.stringify(cfg)}\n${b}`,
);
if (index === before) throw new Error("viewer-config block not found in index.html");
index = index.replace(/<div id="poll-note"[^>]*>[^<]*<\/div>/, `<div id="poll-note" class="tnum">스냅숏 ${new Date().toLocaleString("ko-KR", { hour12: false })}</div>`);
writeFileSync(path.join(OUT, "index.html"), index);
copyFileSync(path.join(DRAFTS, "viewer.css"), path.join(OUT, "viewer.css"));
copyFileSync(path.join(DRAFTS, "viewer.js"), path.join(OUT, "viewer.js"));

/* ── report ────────────────────────────────────────────────────────── */
const listAll = (d: string): string[] =>
  readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? listAll(path.join(d, e.name)) : [path.join(d, e.name)]));
const outFiles = listAll(OUT);
const bytes = outFiles.reduce((n, p) => n + statSync(p).size, 0);
const drafted = Object.keys(status.features).length;
console.log(`bundle: ${OUT}`);
console.log(`  files ${outFiles.length} / ${MAX_FILES}, size ${(bytes / 1024 / 1024).toFixed(1)} MB / ${MAX_BYTES / 1024 / 1024} MB`);
console.log(`  features with drafts ${drafted}, live mocks ${Object.keys(live).length}, 현재 screens ${screenKeys.size}`);
console.log(`  bundle-data.json ${(statSync(path.join(OUT, "bundle-data.json")).size / 1024).toFixed(0)} KB`);
for (const w of warnings) console.log(`  warn: ${w}`);
if (outFiles.length >= MAX_FILES || bytes >= MAX_BYTES) {
  console.error("  OVER BUDGET");
  process.exit(2);
}
