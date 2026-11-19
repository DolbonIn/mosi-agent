// The deep-rows fixtures (../rows-*.html and ../answers.json), drawn by the agent's own rows card code (explore.ts)
// and passed through the server's cleanArtifactHtml (what the app gets). See README.md for the command line.
// The real run goes through the tracker's own card_rows tool (ExploreTracker.rowsTool, saved with saveAgentCard: the
// 300 KB cap). Synthetic rows take reserved example.* links, which cardRowOf drops as junk, so they go in as that tool
// takes them, by hand: cardRowOf, then the link under the card's rule (whole, https, href ≤ CARD_URL_MAX, else no link),
// deduped by name|group and by phone (their links are all different: the page rule never applies), at most
// CARD_ALL_ROWS; the title clip(rowsCardTitle(page titles), 60), the basis the first one clipped at 120.
// usage: bun gen-rows4.ts <agent explore.ts> <server artifactHtml.ts> <pages.json> <out dir> [--write]
// (paths relative to the working directory; without --write it only prints the report)
import { writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [EXPLORE, CLEAN, PAGES, OUT] = process.argv.slice(2);
if (!EXPLORE || !CLEAN || !PAGES || !OUT) throw new Error("usage: bun gen-rows4.ts <explore.ts> <artifactHtml.ts> <pages.json> <out dir> [--write]");
const write = process.argv.includes("--write");
const A = await import(pathToFileURL(resolve(EXPLORE)).href);
const { drawRowsCard, cardRowOf, rowsCardTitle, CARD_ALL_ROWS, CARD_URL_MAX, ExploreTracker } = A;
const { cleanArtifactHtml } = await import(pathToFileURL(resolve(CLEAN)).href);
type Row = { group: string; name: string; area: string; price: string; contact: string; url: string; check: string };

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const normName = (s: string) => s.toLowerCase().replace(/[\s·・()（）[\]【】\-–—.,'"]/g, "");
/** the card's link rule (cardRowOf), for links set after it: whole, https, its href ≤ CARD_URL_MAX, else no link */
const linkOf = (raw: string) => {
  const given = raw.trim();
  if (!given || given.length > CARD_URL_MAX) return "";
  try {
    const u = new URL(given);
    return u.protocol === "https:" && u.href.length <= CARD_URL_MAX ? u.href : "";
  } catch {
    return "";
  }
};
/** the card_rows intake (explore.ts rowsTool run) for rows whose links all differ */
function intake(raws: unknown[], url?: (i: number) => string): Row[] {
  const keys = new Set<string>();
  const tels = new Set<string>();
  const pages = new Set<string>();
  const out: Row[] = [];
  raws.forEach((raw, i) => {
    if (out.length >= CARD_ALL_ROWS) return;
    const row = cardRowOf(raw) as Row | null;
    if (!row) return;
    if (url) row.url = linkOf(url(i));
    const key = `${normName(row.name)}|${normName(row.group)}`;
    const tel = (/\+?\d[\d\s()-]{7,}\d/.exec(row.contact)?.[0] ?? "").replace(/\D/g, "");
    if (keys.has(key) || (tel.length >= 9 && tels.has(tel))) return;
    const page = row.url.replace(/#.*$/, "").replace(/\/$/, "");
    if (page && pages.has(page)) throw new Error(`synthetic links must differ: ${page}`);
    if (page) pages.add(page);
    keys.add(key);
    if (tel.length >= 9) tels.add(tel);
    out.push(row);
  });
  return out;
}

function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const GROUPS: [string, string[], number][] = [
  ["도쿄", ["신주쿠", "시부야", "긴자", "이케부쿠로", "롯폰기", "우에노", "시나가와"], 34],
  ["온라인", ["전국 배송", "앱 진료", "화상 진료"], 18],
  ["오사카", ["우메다", "난바", "신사이바시", "덴노지"], 16],
  ["후쿠오카", ["덴진", "하카타"], 10],
  ["나고야", ["사카에", "나고야역"], 8],
  ["교토", ["시조", "교토역"], 6],
  ["삿포로", ["오도리", "스스키노"], 5],
  ["요코하마", ["요코하마역", "미나토미라이"], 4],
  ["고베", ["산노미야"], 3],
  ["센다이", ["센다이역"], 2],
  ["히로시마", ["핫초보리"], 2],
  ["오키나와", ["나하"], 2],
];
const PREFIX = ["모시", "가람", "다온", "새봄", "누리", "라온", "도담", "온새", "별빛", "해솔"];
const KIND = ["클리닉", "내과", "메디컬", "피부과", "의원", "다이어트 클리닉"];
const CHECK = ["정리 사이트", "정리 사이트", "정리 사이트", "공식 페이지", ""];
const H = "가나다라마바사아자차카타파하";
const fill = (k: number, off: number) => Array.from({ length: k }, (_, i) => H[(i + off) % H.length]).join("");
const id3 = (i: number) => String(i).padStart(3, "0");

/** synthetic rows: made-up names, reserved example.* links (set after cardRowOf, which drops reserved hosts), masked
 *  numbers. size: "typical" | "max" (every field at its clip length; links long, a third on a Hangul host and path) */
function synth(n: number, seed: number, size: "typical" | "max"): Row[] {
  const r = rng(seed);
  const pick = <T,>(a: readonly T[]) => a[Math.floor(r() * a.length)]!;
  const total = GROUPS.reduce((a, g) => a + g[2], 0);
  const raws: unknown[] = [];
  for (let i = 1; i <= n; i++) {
    let w = r() * total;
    const g = GROUPS.find((x) => (w -= x[2]) < 0) ?? GROUPS[0]!;
    const id = id3(i);
    const area = pick(g[1]);
    const yen = (18 + Math.floor(r() * 30)) * 1000 - 20;
    const price = r() < 0.72 ? (r() < 0.6 ? `2.5mg 4개 ¥${yen.toLocaleString()}` : `2.5mg 1개 ¥${((25 + Math.floor(r() * 50)) * 100).toLocaleString()}`) : "";
    const contact = r() < 0.4 ? `03-****-${String(1000 + i).slice(-4)}` : r() < 0.5 ? "웹 예약" : r() < 0.5 ? "LINE 예약" : "";
    const check = pick(CHECK);
    if (size === "typical") raws.push([g[0], `${pick(PREFIX)} ${pick(KIND)} ${area}점 ${id}`, `${area}역 도보 ${1 + Math.floor(r() * 9)}분`, price, contact, "", check]);
    else
      raws.push([
        `${g[0]}${"가".repeat(20)}`,
        `${pick(PREFIX)} ${pick(KIND)} ${id} ${"하나둘셋넷다섯여섯일곱여덟아홉열".repeat(4)}`,
        `${area} ${"역 서쪽 출구에서 걸어서 일 분".repeat(3)}`,
        `2.5mg 4개 ¥${(19980 + i).toLocaleString()} ${"첫 달 할인가 별도 진찰료 포함".repeat(3)}`,
        `${contact || "웹 예약"} ${"평일 오전 열 시부터 오후 일곱 시까지 전화 접수".repeat(3)}`,
        "",
        "공식 페이지 확인함".repeat(3),
      ]);
  }
  // one row in nine has no link. max rows: a 570-character ASCII link (whole: nothing clips it now), every third on a
  // Hangul (IDN) host and path: 40 steps (href 1,618) open, every sixth 70 steps (href 2,758, past the 2,048 the app
  // opens): no link, the row stays without one
  return intake(raws, (i) => {
    const id = id3(i + 1);
    if ((i + 1) % 9 === 0) return "";
    if (size !== "max") return `https://clinic-${id}.example.jp/mounjaro`;
    if ((i + 1) % 3 === 0) return `https://가상클리닉${id}.example/진료/마운자로/${"처방-안내/".repeat((i + 1) % 6 === 0 ? 70 : 40)}`;
    return `https://clinic-${id}.example.jp/${"mounjaro/".repeat(60)}`;
  });
}

/** a model's page titles for one card: the first with a count and a page mark, the rest with page marks (rowsCardTitle cleans them) */
const pagesOf = (t: string, n: number, pages = 3) => [`${t} ${n}곳 (1/${pages})`, ...Array.from({ length: pages - 1 }, (_, i) => (i ? `${t} (${i + 2}/${pages})` : `${t} (계속)`))];

const report: Record<string, unknown>[] = [];
/** each card's answer: a model's short reply, then the line the code adds after a rows card (cardLine) */
const answers: Record<string, string> = {};
const REPLY = "지역별로 묶고 가격 낮은 순으로 정리했어요.";
function emit(file: string, o: { titles: string[]; basis: string; rows: Row[]; regulated: boolean; want?: string }) {
  const title = clip(rowsCardTitle(o.titles), 60) || "찾은 곳 목록";
  if (o.want && title !== o.want) throw new Error(`${file}: title '${title}' (want '${o.want}')`);
  const card = drawRowsCard({ title, basis: clip(o.basis.trim(), 120), rows: o.rows, regulated: o.regulated });
  const c = cleanArtifactHtml(card.html);
  const hrefs = [...c.html.matchAll(/<a href="([^"]*)"/g)].map((m) => m[1]!.replaceAll("&amp;", "&"));
  report.push({
    file,
    title,
    sent: o.rows.length,
    shown: card.shown.length,
    short: card.short,
    px256: card.px,
    links: (c.html.match(/<li><a /g) ?? []).length,
    lis: (c.html.match(/<li>/g) ?? []).length,
    groups: new Set(o.rows.map((r) => r.group)).size,
    heads: (c.html.match(/<h3>/g) ?? []).length,
    seps: (c.html.match(/<p class="sep">/g) ?? []).length,
    longestHref: Math.max(0, ...hrefs.map((h) => h.length)),
    bytes: Buffer.byteLength(c.html),
    cleanSame: c.html === card.html,
    removed: Object.entries(c.removed).filter(([, v]) => v),
    tuned: Object.entries(c.tuned).filter(([, v]) => v),
    sum: /<div class="sum">(.*?)<\/div>/.exec(c.html)?.[1]?.replace(/<[^>]+>/g, " ").slice(0, 140),
  });
  const shown = card.shown.length;
  const left = card.left.map((r: Row) => r.name);
  const line = left.length
    ? `카드에 전체 ${shown + left.length}곳 중 ${shown}곳을 담았어요(카드 크기 한도로 지역마다 가격 없는 곳·비싼 곳부터 뺐어요). 카드에 못 담은 곳: ${left.join(", ")}.`
    : `카드에 ${shown}곳 전부 정리했어요.`;
  answers[file.replace(/\.html$/, "")] = `${REPLY}\n\n${line}`;
  if (write) {
    mkdirSync(OUT!, { recursive: true });
    writeFileSync(`${OUT}/${file}`, c.html);
  }
}

const BASIS = "마운자로 공개 가격(2.5mg 4개 또는 1개) · 2026-11-15 확인 (합성)";
emit("rows-150.html", { titles: pagesOf("도쿄·오사카 마운자로 클리닉 (합성)", 150, 2), want: "도쿄·오사카 마운자로 클리닉 (합성)", basis: BASIS, rows: synth(150, 150, "typical"), regulated: true });
emit("rows-500.html", { titles: pagesOf("일본 마운자로 처방 클리닉 (합성)", 500, 4), want: "일본 마운자로 처방 클리닉 (합성)", basis: BASIS, rows: synth(500, 500, "typical"), regulated: true });
// the tall case: 500 rows, names at 60, areas at 40, no contact (past the height estimate at 256: each region's tail goes)
{
  const G = GROUPS.map((g) => g[0]);
  const raws = Array.from({ length: 500 }, (_, i) => [G[i % G.length], `${id3(i + 1)} ${fill(56, i)}`, fill(40, i + 3), `2.5mg 4개 ¥${(18000 + i * 10).toLocaleString()}`, "", "", "정리 사이트"]);
  emit("rows-tall.html", { titles: pagesOf("이름이 아주 긴 클리닉 (합성)", 500, 4), want: "이름이 아주 긴 클리닉 (합성)", basis: BASIS, rows: intake(raws, (i) => `https://clinic-${i + 1}.example.jp/m`), regulated: true });
}
// cut by height alone (agent-runtime's 139k 'noamount' case): half the prices are words with no amount, half
// the rows carry a pill; the bytes fit, the height estimate does not, so each region's tail goes
{
  const G = ["도쿄", "오사카", "온라인", "후쿠오카", "나고야", "교토", "삿포로", "요코하마", "고베", "센다이", "히로시마", "오키나와"];
  const raws = Array.from({ length: 500 }, (_, i) => [
    G[i % G.length],
    `${id3(i + 1)} ${fill(56, i)}`,
    fill(40, i + 3),
    Math.floor(i / 12) % 2 ? `상담 후 결정 ${fill(20, i)}` : `2.5mg 4개 ¥${(18000 + i * 10).toLocaleString()}`,
    `웹 예약 ${fill(34, i + 5)}`,
    "",
    i % 2 ? "정리 사이트" : "공식 페이지",
  ]);
  emit("rows-cut.html", { titles: pagesOf("가격 말이 긴 클리닉 (합성)", 500, 4), want: "가격 말이 긴 클리닉 (합성)", basis: BASIS, rows: intake(raws, (i) => `https://clinic-${i + 1}.example.jp/m`), regulated: true });
}
emit("rows-long.html", { titles: pagesOf("칸이 아주 긴 행 (합성)", 40, 1), want: "칸이 아주 긴 행 (합성)", basis: BASIS, rows: synth(40, 40, "max"), regulated: true });
emit("rows-max.html", { titles: pagesOf("칸이 아주 긴 행, 크기 한도 (합성)", 500, 4), want: "칸이 아주 긴 행, 크기 한도 (합성)", basis: BASIS, rows: synth(500, 7, "max"), regulated: true });

// the real runs (pages.json: card_rows calls of three real '전부' runs) through the tracker's own tool, page by page as
// the model sent them; run 2 is the largest
const runs = JSON.parse(readFileSync(PAGES!, "utf8")) as { title?: string; basis?: string; rows?: unknown[] }[][];
const realRuns: Record<string, unknown>[] = [];
for (const [i, pages] of runs.entries()) {
  const t = new ExploreTracker(undefined, 0, "text", { text: "일본 마운자로 살 수 있는 곳 전부 찾아줘 카드로", card: { name: "sys_create_artifact", kind: "html" } });
  let saved = { title: "", html: "" };
  const real = { name: "sys_create_artifact", saveAgentCard: async (a: { title: string; html: string }) => ((saved = a), { ok: true, summary: "" }), run: async () => ({ ok: false, summary: "" }) };
  const tool = t.rowsTool(real);
  for (const [k, p] of pages.entries()) await tool.run({ title: p.title, basis: p.basis, rows: p.rows, more: k < pages.length - 1 }, {} as never);
  const d = t.drawn();
  const sent = pages.reduce((n, p) => n + (p.rows?.length ?? 0), 0);
  realRuns.push({ run: i + 1, sent, kept: t.rows().length, drawn: d?.rows, left: d?.left.length, title: saved.title });
  if (i !== 1) continue;
  const c = cleanArtifactHtml(saved.html);
  const hrefs = [...c.html.matchAll(/<a href="([^"]*)"/g)].map((m) => m[1]!.replaceAll("&amp;", "&"));
  report.push({ file: "rows-mounjaro.html", title: saved.title, sent: t.rows().length, shown: d!.rows, links: (c.html.match(/<li><a /g) ?? []).length, lis: (c.html.match(/<li>/g) ?? []).length, groups: new Set(t.rows().map((r: Row) => r.group)).size, heads: (c.html.match(/<h3>/g) ?? []).length, seps: (c.html.match(/<p class="sep">/g) ?? []).length, longestHref: Math.max(0, ...hrefs.map((h) => h.length)), bytes: Buffer.byteLength(c.html), cleanSame: c.html === saved.html, sum: /<div class="sum">(.*?)<\/div>/.exec(c.html)?.[1]?.replace(/<[^>]+>/g, " ").slice(0, 140) });
  if (d!.left.length) throw new Error("the real run is cut: write its line");
  answers["rows-mounjaro"] = `${REPLY}\n\n카드에 ${d!.rows}곳 전부 정리했어요.`;
  if (write) writeFileSync(`${OUT}/rows-mounjaro.html`, c.html);
}
report.push({ realRuns });
if (write) writeFileSync(`${OUT}/answers.json`, `${JSON.stringify(answers, null, 1)}\n`);
console.log(JSON.stringify(report, null, 1));
