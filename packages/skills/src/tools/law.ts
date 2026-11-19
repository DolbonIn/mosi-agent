import type { ResultListCard } from "@pickle/protocol";
import { proxyGet } from "../http";
import { cleanText, defineSkill, fail, failText, schema, str } from "../util";

interface LawRow {
  법령일련번호?: string;
  법령ID?: string;
  법령명한글?: string;
  법령약칭명?: string;
  법령구분명?: string;
  소관부처명?: string;
  시행일자?: string;
  현행연혁코드?: string;
}
export interface LawSearchResponse {
  LawSearch?: { totalCnt?: string; law?: LawRow | LawRow[] };
}
interface Hang {
  항번호?: string;
  항내용?: string;
  호?: { 호번호?: string; 호내용?: string } | { 호번호?: string; 호내용?: string }[];
}
interface Article {
  조문번호?: string;
  조문가지번호?: string;
  조문제목?: string;
  조문내용?: string;
  항?: Hang | Hang[];
}
export interface LawDetailResponse {
  법령?: { 기본정보?: { 법령명_한글?: string; 시행일자?: string }; 조문?: { 조문단위?: Article | Article[] } };
}

const arr = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

/** "주택임대차보호법 제3조의2" → { name: "주택임대차보호법", jo: "000302", label: "제3조의2" } */
export function splitArticle(query: string): { name: string; jo?: string; label?: string } {
  const m = /제\s*(\d{1,4})\s*조(?:\s*의\s*(\d{1,2}))?/.exec(query);
  if (!m) return { name: query.trim() };
  const art = Number(m[1]);
  const branch = m[2] ? Number(m[2]) : 0;
  return {
    name: query.replace(m[0], "").replace(/\s+/g, " ").trim(),
    jo: `${String(art).padStart(4, "0")}${String(branch).padStart(2, "0")}`,
    label: `제${art}조${branch ? `의${branch}` : ""}`,
  };
}

function ymdDots(s: string | undefined): string | undefined {
  return s && /^\d{8}$/.test(s) ? `${s.slice(0, 4)}.${s.slice(4, 6)}.${s.slice(6)}` : s;
}

function lawUrl(name: string, label?: string): string {
  return `https://www.law.go.kr/법령/${encodeURIComponent(name)}${label ? `/${encodeURIComponent(label)}` : ""}`;
}

export function articleText(detail: LawDetailResponse, max = 1500): { title: string; text: string } | null {
  const a = arr(detail.법령?.조문?.조문단위)[0];
  if (!a) return null;
  const lines: string[] = [];
  if (a.조문내용) lines.push(cleanText(a.조문내용, 400));
  for (const h of arr(a.항)) {
    if (h.항내용) lines.push(cleanText(h.항내용, 600));
    for (const ho of arr(h.호)) if (ho.호내용) lines.push(cleanText(ho.호내용, 300));
  }
  const text = lines.join("\n");
  return { title: a.조문제목 ?? "", text: text.length > max ? text.slice(0, max - 1) + "…" : text };
}

export function buildLaw(
  query: string,
  search: LawSearchResponse,
  article: { label: string; title: string; text: string } | null,
): { summary: string; data: Record<string, unknown>; card: ResultListCard } | null {
  const rows = arr(search.LawSearch?.law).slice(0, 6);
  if (rows.length === 0) return null;
  const laws = rows.map((r) => ({
    name: r.법령명한글 ?? "",
    short: r.법령약칭명 || undefined,
    kind: r.법령구분명,
    ministry: r.소관부처명,
    effective: ymdDots(r.시행일자),
    mst: r.법령일련번호,
    url: r.법령명한글 ? lawUrl(r.법령명한글) : undefined,
  }));
  const top = laws[0]!;
  const summary = article
    ? `${top.name} ${article.label}${article.title ? `(${article.title})` : ""}`
    : `‘${query}’ 법령 ${laws.length}건 · ${top.name} (${top.effective ?? ""} 시행)`;
  const items: ResultListCard["items"] = [];
  if (article) items.push({ title: `${top.name} ${article.label} ${article.title}`.trim(), subtitle: article.text.slice(0, 120), url: lawUrl(top.name, article.label), icon: "doc" });
  for (const l of laws) items.push({ title: l.name, subtitle: [l.kind, l.ministry].filter(Boolean).join(" · "), meta: l.effective ? `${l.effective} 시행` : undefined, url: l.url, icon: "shield" });
  return {
    summary,
    data: {
      query,
      laws: laws.map(({ mst: _m, ...l }) => l),
      article: article ?? undefined,
      note: "법령 원문 요약이에요. 구체적인 사건은 변호사·법률구조공단(132) 상담을 권해요.",
      source: "국가법령정보센터",
    },
    card: { type: "results", title: article ? `${top.name} ${article.label}` : `‘${query}’ 법령 검색`, source: "국가법령정보센터", items },
  };
}

export const kLawSearch = defineSkill({
  name: "k_law_search",
  description:
    "Search Korean statutes (laws, decrees) by name or keyword in the National Law Information Center, via k-skill, and optionally " +
    "fetch one article's text when the query names it (e.g. '주택임대차보호법 제3조', '근로기준법 제60조'). " +
    "`query` is a law name or keyword in Korean.",
  parameters: schema({ query: { type: "string", description: "law name/keyword, optionally with an article, e.g. '근로기준법 제60조'" } }, ["query"]),
  icon: "shield",
  title: (a) => `‘${str(a.query, 30)}’ 법령 찾기`,
  meta: {
    source: "korean-law-search",
    title: "법령 검색",
    description: "국가법령정보센터에서 법령과 조문 원문을 찾아줘요.",
    category: "공공",
    example: "주택임대차보호법 제3조 내용 알려줘",
  },
  async run(a, rc) {
    const query = str(a.query, 80);
    if (!query) return failText("법령: 찾을 법령 이름을 알려주세요");
    const { name, jo, label } = splitArticle(query);
    const s = await proxyGet<LawSearchResponse>("/v1/korean-law/search", { target: "law", query: name || query, display: 6 }, rc.signal);
    if (!s.ok) return fail(s.error, "법령");
    let article: { label: string; title: string; text: string } | null = null;
    const top = arr(s.body.LawSearch?.law)[0];
    if (jo && label && top?.법령일련번호) {
      const d = await proxyGet<LawDetailResponse>("/v1/korean-law/detail", { target: "law", MST: top.법령일련번호, JO: jo }, rc.signal);
      const t = d.ok ? articleText(d.body) : null;
      if (t) article = { label, ...t };
    }
    const built = buildLaw(name || query, s.body, article);
    if (!built) return failText(`법령: ‘${name || query}’ 법령을 찾지 못했어요`, "not_found");
    return { ok: true, ...built };
  },
});
