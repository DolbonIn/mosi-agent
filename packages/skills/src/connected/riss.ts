/**
 * RISS (KERIS) academic search with the owner's own RISS 검색 Open API key (issued to non-profit institutions).
 *
 * Ported from NomaDamas/k-skill `keris-academic-search/scripts/keris_academic.py` (MIT): GET
 * https://www.riss.kr/openApi?key&version=1.0&type&rsnum&rowcount + keyword/title/author fields; the XML envelope
 * <record><head><totalcount/><Error/><ErrorMessage/></head><metadata><riss.title/>…</metadata></record>; resource type
 * aliases (ALL = T/A/O/U/F/S, A = A/O, D = A, B = U) merged round-robin on page 1; full-text flags from riss.image /
 * riss.charge. Metadata only: no institutional login, copy requests or downloads.
 */
import type { ConnectionServiceContext } from "@pickle/agent";
import { needsConnection } from "@pickle/agent";
import type { ResultListCard } from "@pickle/protocol";
import { cleanText, defineSkill, failText, int, schema, str, type SkillConnection } from "../util";
import { directRequest, fromDirect, verifyFailure, verifyKey, type UpstreamFailure, type VerifyResult } from "../direct";

export const RISS_ORIGIN = "https://www.riss.kr";
const ORIGINS = [RISS_ORIGIN] as const;

export const RISS: SkillConnection = {
  id: "riss",
  name: "RISS",
  reason: "학술자료를 검색하려면 RISS 검색 API 키 연결이 필요해요",
};

export const RESOURCE_TYPES: Record<string, string[]> = { ALL: ["T", "A", "O", "U", "F", "S"], T: ["T"], A: ["A", "O"], D: ["A"], B: ["U"] };
const TYPE_LABEL: Record<string, string> = { T: "학위논문", A: "국내학술논문", O: "해외학술논문", U: "단행본", F: "연구보고서", S: "학술지" };

type Secret = Readonly<Record<string, string>>;

export interface RissItem {
  type: string | undefined;
  title: string;
  authors: string[];
  publisher?: string;
  year?: string;
  journal?: string;
  link?: string;
  fullText: "free" | "paid_or_restricted" | "available" | "none" | "unknown";
}

/** the tag's text (CDATA and entities decoded); tag names contain a dot ("riss.title") */
function tagText(block: string, tag: string): string | undefined {
  const re = new RegExp(`<${tag.replace(".", "\\.")}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag.replace(".", "\\.")}>`, "i");
  const m = re.exec(block);
  if (!m) return undefined;
  const raw = m[1]!.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
  const t = cleanText(raw);
  return t || undefined;
}

export type RissParsed = { ok: true; total: number; items: RissItem[] } | { ok: false; code: string; message: string };

export function parseRiss(xml: string): RissParsed {
  const rec = /<record[\s>][\s\S]*<\/record>/i.exec(xml)?.[0];
  if (!rec) return { ok: false, code: "parse", message: "RISS 응답 형식이 올바르지 않아요" };
  const head = /<head>([\s\S]*?)<\/head>/i.exec(rec)?.[1] ?? "";
  const code = tagText(head, "Error");
  if (code === undefined) return { ok: false, code: "parse", message: "RISS 응답에 상태 값이 없어요" };
  if (code !== "0" && code !== "000") return { ok: false, code, message: tagText(head, "ErrorMessage") ?? "RISS 오류" };
  const total = Number(tagText(head, "totalcount") ?? "0");
  const items: RissItem[] = [];
  for (const m of rec.matchAll(/<metadata>([\s\S]*?)<\/metadata>/gi)) {
    const b = m[1]!;
    const image = (tagText(b, "riss.image") ?? "").toUpperCase();
    const charge = tagText(b, "riss.charge");
    const available = image === "Y" ? true : image === "N" ? false : null;
    const fullText: RissItem["fullText"] = available && charge === "1" ? "free" : available && charge === "0" ? "paid_or_restricted" : available ? "available" : available === false ? "none" : "unknown";
    const author = tagText(b, "riss.author") ?? "";
    items.push({
      type: tagText(b, "riss.type"),
      title: tagText(b, "riss.title") ?? "",
      authors: author
        .split(/[;,]/)
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 6),
      publisher: tagText(b, "riss.publisher"),
      year: tagText(b, "riss.pubdate"),
      journal: tagText(b, "riss.stitle"),
      link: tagText(b, "riss.url"),
      fullText,
    });
  }
  return { ok: true, total: Number.isFinite(total) && total >= 0 ? total : items.length, items };
}

/** key refused / not approved → the login is the problem (needsConnection); anything else is a normal failure */
function isKeyError(message: string): boolean {
  // "키워드" must not count: only an API key / authorisation wording
  return /인증|권한|승인|허가|등록되지\s*않은|api\s*키|api\s*key|invalid\s*key|\bkey\b/i.test(message);
}

async function rissFetch(secret: Secret, limitKey: string, type: string, q: Record<string, string>, page: number, size: number, signal: AbortSignal): Promise<{ ok: true; total: number; items: RissItem[] } | { ok: false; error: UpstreamFailure }> {
  const key = (secret.apiKey ?? "").trim();
  if (!key) return { ok: false, error: { kind: "auth", message: "RISS API 키가 비어 있어요" } };
  const qs = new URLSearchParams({ ...q, key, version: "1.0", type, rsnum: String((page - 1) * size + 1), rowcount: String(size) });
  const r = await directRequest({ url: `${RISS_ORIGIN}/openApi?${qs}`, headers: { Accept: "application/xml" }, origins: ORIGINS, signal, limit: { key: `riss:${limitKey}`, burst: 10, refill: 30, windowMs: 60_000 } });
  if (!r.ok) return { ok: false, error: fromDirect(r.error, "RISS") };
  if (r.res.status === 401 || r.res.status === 403) return { ok: false, error: { kind: "auth", status: r.res.status, message: "RISS가 API 키를 거절했어요" } };
  if (r.res.status === 429) return { ok: false, error: { kind: "rate", status: 429, message: "RISS 호출량을 넘었어요. 잠시 후 다시 해 주세요" } };
  if (r.res.status !== 200) return { ok: false, error: { kind: "upstream", status: r.res.status, message: "RISS 서버 응답이 원활하지 않아요" } };
  const p = parseRiss(r.res.text);
  if (!p.ok) {
    if (isKeyError(p.message)) return { ok: false, error: { kind: "auth", code: p.code, message: "RISS가 API 키를 받지 않았어요" } };
    return { ok: false, error: { kind: p.code === "parse" ? "upstream" : "input", code: p.code, message: str(p.message, 120) } };
  }
  return p;
}

export async function verifyRiss(secret: Secret, x: ConnectionServiceContext): Promise<VerifyResult> {
  const r = await rissFetch(secret, verifyKey(secret.apiKey ?? ""), "T", { keyword: "교육" }, 1, 1, x.signal);
  if (!r.ok) return verifyFailure(r.error, "RISS가 API 키를 받지 않았어요. RISS API 센터에서 승인된 검색 API 키인지 확인해 주세요.");
  return { ok: true, accountLabel: "RISS 검색 API" };
}

const ACCESS_LABEL: Record<RissItem["fullText"], string> = { free: "원문 무료", paid_or_restricted: "원문 유료/기관", available: "원문 있음", none: "원문 없음", unknown: "" };

export const kRissSearch = defineSkill({
  name: "k_riss_search",
  description:
    "Academic search on RISS (KERIS) with the owner's own RISS API key: theses, domestic/foreign articles, books, reports, journals — " +
    "title, authors, publisher/journal, year, link and whether full text exists. Needs the owner's RISS connection. " +
    "Give at least one of keyword/title/author. `type`: ALL (default) | T 학위논문 | A 학술논문 | D 국내논문 | B 단행본.",
  parameters: schema({
    keyword: { type: "string", description: "free keyword" },
    title: { type: "string", description: "title words" },
    author: { type: "string", description: "author name" },
    type: { type: "string", enum: ["ALL", "T", "A", "D", "B"], description: "default ALL" },
    page: { type: "integer", minimum: 1, maximum: 50, description: "single types only; default 1" },
  }),
  icon: "doc",
  title: (a) => `${str(a.keyword || a.title || a.author, 20)} 논문 찾기`,
  meta: { source: "keris-academic-search", title: "RISS 학술검색", description: "내 RISS API 키로 논문·학술지·단행본을 찾아요.", category: "교육", example: "RISS에서 인공지능 교육 학위논문 찾아줘" },
  connection: RISS,
  private: false, // a paper search
  async run(a, rc) {
    const conn = rc.conn!;
    const q: Record<string, string> = {};
    for (const f of ["keyword", "title", "author"] as const) {
      const v = str(a[f], 100);
      if (v) q[f] = v;
    }
    if (!Object.keys(q).length) return failText("RISS: 검색어(키워드·제목·저자 중 하나)를 알려주세요");
    const alias = typeof a.type === "string" && RESOURCE_TYPES[a.type] ? a.type : "ALL";
    const types = RESOURCE_TYPES[alias]!;
    const page = types.length > 1 ? 1 : int(a.page, 1, 50, 1);
    const size = 10;
    rc.status("RISS 검색 중");
    const results = await Promise.all(types.map((t) => rissFetch(conn.secret, conn.credentialId, t, q, page, size, rc.signal)));
    const bad = results.find((r): r is { ok: false; error: UpstreamFailure } => !r.ok);
    const good = results.filter((r): r is { ok: true; total: number; items: RissItem[] } => r.ok);
    if (bad && (bad.error.kind === "auth" || !good.length)) {
      if (bad.error.kind === "auth") return needsConnection(RISS.id, RISS.name, `${bad.error.message}. RISS를 다시 연결해 주세요.`);
      return failText(`RISS: ${bad.error.message}`, bad.error.kind);
    }
    // round-robin across resource types, like the upstream helper
    const queues = good.map((r) => [...r.items]);
    const items: RissItem[] = [];
    while (items.length < size && queues.some((x) => x.length)) for (const x of queues) if (x.length && items.length < size) items.push(x.shift()!);
    const total = good.reduce((s, r) => s + r.total, 0);
    const what = Object.values(q).join(" ");
    if (!items.length) return { ok: true, summary: `RISS에 ‘${what}’ 자료가 없어요`, data: { query: q, type: alias, total: 0, items: [] } };
    const card: ResultListCard = {
      type: "results",
      title: `RISS ‘${what}’`,
      source: "RISS",
      items: items.slice(0, 8).map((i) => ({
        title: i.title,
        subtitle: [i.authors.slice(0, 2).join(", "), i.journal ?? i.publisher, i.year].filter(Boolean).join(" · "),
        meta: [TYPE_LABEL[i.type ?? ""] ?? "", ACCESS_LABEL[i.fullText]].filter(Boolean).join(" · ") || undefined,
        url: i.link,
        icon: "doc",
      })),
    };
    return {
      ok: true,
      summary: `RISS ‘${what}’ ${total.toLocaleString("en-US")}건 중 ${items.length}건`,
      data: { query: q, type: alias, page, total, items: items.map((i) => ({ ...i, typeLabel: TYPE_LABEL[i.type ?? ""] })), partial: bad ? "일부 자료유형 조회에 실패했어요" : undefined },
      card,
    };
  },
});

export const RISS_FIELDS = [
  { key: "apiKey", label: "RISS 검색 API 키", type: "password" as const, autocomplete: "off", hint: "RISS API 센터에서 기관 승인 후 받은 키예요." },
];
