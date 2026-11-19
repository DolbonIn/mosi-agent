/**
 * web_search providers. Each adapter turns one search into `SearchHit`s; only providers whose key is in the server's
 * environment (secrets.env) are tried. Keys are read at call time and go only into that provider's own request
 * header: never into a result, a summary, an error or a log. Only the query, page and a language/country hint
 * leave the server.
 *
 * - exa:    Exa search (web / news; blog / cafe through domain filters; similar sites), EXA_API_KEY — tried first
 * - kskill: the hosted k-skill proxy's Naver news route (keyless; the proxy holds the key) — news only
 * - naver:  네이버 검색 API (webkr / blog / cafearticle / news), NAVER_CLIENT_ID + NAVER_CLIENT_SECRET
 * - kakao:  다음 검색 API (web / blog / cafe), KAKAO_REST_API_KEY
 * - brave:  Brave Search API (web / news), BRAVE_SEARCH_API_KEY
 * - tavily: Tavily search (web / news), TAVILY_API_KEY
 * Naver, Kakao, Brave and Tavily stay dormant until their keys are added: a provider without its key is never tried.
 *
 * Exa (docs: exa.ai/docs, 2026-11): POST /search {query, type "auto", numResults, userLocation, contents.highlights};
 * "이런 사이트 더" uses POST /findSimilar {url, excludeSourceDomain} (deprecated but live) and falls back to /search
 * with the site excluded. No user identifier is ever sent (Exa's optional `userIdentifier` stays unset).
 */
import { proxyGet, TtlCache } from "../http";
import { directRequest, parseJson, type DirectFailure } from "../direct";
import { cleanText } from "../util";
import { displayHost, displayUrl } from "./html";

export type WebKind = "web" | "blog" | "cafe" | "news";
export type WebLang = "ko" | "ja" | "en";
export type ProviderId = "kskill" | "naver" | "kakao" | "brave" | "tavily" | "exa";

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
  provider: ProviderId;
  /** display host, Unicode (스시자로.site), without "www." */
  domain: string;
  /** YYYY-MM-DD when the provider gives one */
  date?: string;
}

export interface SearchQuery {
  query: string;
  kind: WebKind;
  lang: WebLang;
  limit: number;
  page: number;
  /** "more sites like this one": an http(s) URL (only Exa can) */
  like?: string;
}

export type ProviderErrorKind = "auth" | "rate" | "input" | "upstream" | "timeout" | "network";
export interface ProviderError {
  kind: ProviderErrorKind;
  /** Korean; never contains a key or an upstream body */
  message: string;
  status?: number;
}
export type SearchOutcome = { ok: true; hits: SearchHit[]; more: boolean } | { ok: false; error: ProviderError };

export interface Provider {
  id: ProviderId;
  /** Korean display name (card source line) */
  name: string;
  kinds: readonly WebKind[];
  /** can find sites similar to a URL (SearchQuery.like) */
  similar?: boolean;
  /** env names this provider needs (all of them, first alias that is set wins) */
  env: readonly (readonly string[])[];
  run(q: SearchQuery, keys: string[], signal: AbortSignal): Promise<SearchOutcome>;
}

export const SNIPPET_CHARS = 200;

// ───────────────────────────── env ─────────────────────────────

function readEnv(name: string): string | undefined {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  const v = env?.[name];
  return v && v.trim() ? v.trim() : undefined;
}

/** the provider's keys in `env` order, or null when one is missing */
export function providerKeys(p: Provider): string[] | null {
  if (p.env.length === 0) return [];
  const out: string[] = [];
  for (const aliases of p.env) {
    const v = aliases.map(readEnv).find((x) => x !== undefined);
    if (!v) return null;
    out.push(v);
  }
  return out;
}

// ───────────────────────────── shared ─────────────────────────────

/** "20261115", "2026-11-15T10:00:00.000+09:00", "Sat, 15 Nov 2026 10:00:00 +0900" → "2026-11-15" */
export function isoDay(v: unknown): string | undefined {
  if (typeof v !== "string" || !v.trim()) return undefined;
  const s = v.trim();
  let m = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  // a date-time with a zone ("…Z", "…+09:00") is turned into the Korean calendar day below
  m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m && !/T\d{2}:\d{2}.*(?:Z|[+-]\d{2}:?\d{2})$/i.test(s)) return `${m[1]}-${m[2]}-${m[3]}`;
  const t = Date.parse(s);
  if (!Number.isFinite(t)) return undefined;
  const d = new Date(t + 9 * 3600_000); // KST calendar day
  return d.toISOString().slice(0, 10);
}

export function hostOf(url: string): string {
  try {
    return displayHost(new URL(url).hostname);
  } catch {
    return "";
  }
}

function hit(provider: ProviderId, title: unknown, url: unknown, snippet: unknown, date?: unknown): SearchHit | null {
  if (typeof url !== "string" || !/^https?:\/\//i.test(url)) return null;
  let href: string;
  try {
    href = displayUrl(new URL(url)); // Unicode host (스시자로.site), like every link the web tools return
  } catch {
    return null;
  }
  const h: SearchHit = {
    title: cleanText(title, 140) || hostOf(href),
    url: href,
    snippet: cleanText(snippet, SNIPPET_CHARS),
    provider,
    domain: hostOf(href),
  };
  const d = isoDay(date);
  if (d) h.date = d;
  return h;
}

function compact<T>(xs: (T | null)[]): T[] {
  return xs.filter((x): x is T => x !== null);
}

function fromStatus(status: number, label: string): ProviderError {
  if (status === 401 || status === 403) return { kind: "auth", status, message: `${label} 검색 키가 거절됐어요` };
  if (status === 402 || status === 429 || status === 432 || status === 433) return { kind: "rate", status, message: `${label} 검색 한도에 걸렸어요` };
  if (status === 400 || status === 422) return { kind: "input", status, message: `${label} 검색어를 처리하지 못했어요` };
  return { kind: "upstream", status, message: `${label} 검색 서버 응답이 원활하지 않아요 (HTTP ${status})` };
}

function fromDirectFailure(e: DirectFailure, label: string): ProviderError {
  switch (e.kind) {
    case "timeout":
    case "aborted":
      return { kind: "timeout", message: `${label} 검색 응답이 너무 늦어요` };
    case "rate_limited":
      return { kind: "rate", message: `${label} 검색 요청이 몰려 잠시 쉬어야 해요` };
    default:
      return { kind: "network", message: `${label} 검색 서버에 연결하지 못했어요` };
  }
}

/** one bucket per provider (the keys are the server's, shared by everyone): ≤ 5 at once, 60 a minute */
const limitFor = (id: ProviderId) => ({ key: `web-search:${id}`, burst: 5, refill: 60, windowMs: 60_000 });

export async function getJson(p: { id: ProviderId; label: string; origin: string; url: string; headers: Record<string, string>; method?: "GET" | "POST"; body?: unknown; signal: AbortSignal }): Promise<{ ok: true; body: unknown } | { ok: false; error: ProviderError }> {
  const r = await directRequest({
    url: p.url,
    method: p.method ?? "GET",
    headers: { Accept: "application/json", ...(p.body !== undefined ? { "Content-Type": "application/json" } : {}), ...p.headers },
    body: p.body !== undefined ? JSON.stringify(p.body) : undefined,
    origins: [p.origin],
    limit: limitFor(p.id),
    signal: p.signal,
  });
  if (!r.ok) return { ok: false, error: fromDirectFailure(r.error, p.label) };
  if (r.res.status < 200 || r.res.status >= 300) return { ok: false, error: fromStatus(r.res.status, p.label) };
  const body = parseJson(r.res.text);
  if (body === undefined || body === null || typeof body !== "object") return { ok: false, error: { kind: "upstream", message: `${p.label} 검색 응답을 해석하지 못했어요` } };
  return { ok: true, body };
}

// ───────────────────────────── adapters ─────────────────────────────

interface NaverItem {
  title?: string;
  link?: string;
  originallink?: string;
  description?: string;
  postdate?: string;
  pubDate?: string;
}

const NAVER_PATH: Record<WebKind, string> = { web: "webkr", blog: "blog", cafe: "cafearticle", news: "news" };

export const naver: Provider = {
  id: "naver",
  name: "네이버",
  kinds: ["web", "blog", "cafe", "news"],
  env: [
    ["NAVER_CLIENT_ID", "NAVER_SEARCH_CLIENT_ID"],
    ["NAVER_CLIENT_SECRET", "NAVER_SEARCH_CLIENT_SECRET"],
  ],
  async run(q, [id, secret], signal) {
    const start = (q.page - 1) * q.limit + 1;
    if (start + q.limit - 1 > 1000) return { ok: true, hits: [], more: false };
    const u = new URL(`https://openapi.naver.com/v1/search/${NAVER_PATH[q.kind]}.json`);
    u.searchParams.set("query", q.query);
    u.searchParams.set("display", String(q.limit));
    u.searchParams.set("start", String(start));
    if (q.kind !== "web") u.searchParams.set("sort", "sim");
    const r = await getJson({ id: "naver", label: "네이버", origin: "https://openapi.naver.com", url: u.toString(), headers: { "X-Naver-Client-Id": id!, "X-Naver-Client-Secret": secret! }, signal });
    if (!r.ok) return r;
    const body = r.body as { items?: NaverItem[]; total?: number };
    const items = Array.isArray(body.items) ? body.items : [];
    const hits = compact(items.map((it) => hit("naver", it.title, it.link || it.originallink, it.description, it.postdate ?? it.pubDate)));
    const total = typeof body.total === "number" ? body.total : 0;
    return { ok: true, hits, more: start + q.limit <= Math.min(total, 1000) };
  },
};

interface KakaoDoc {
  title?: string;
  contents?: string;
  url?: string;
  datetime?: string;
}

const KAKAO_PATH: Partial<Record<WebKind, string>> = { web: "web", blog: "blog", cafe: "cafe" };

export const kakao: Provider = {
  id: "kakao",
  name: "다음",
  kinds: ["web", "blog", "cafe"],
  env: [["KAKAO_REST_API_KEY"]],
  async run(q, [key], signal) {
    const path = KAKAO_PATH[q.kind];
    if (!path || q.page > 50) return { ok: true, hits: [], more: false };
    const u = new URL(`https://dapi.kakao.com/v2/search/${path}`);
    u.searchParams.set("query", q.query);
    u.searchParams.set("sort", "accuracy");
    u.searchParams.set("page", String(q.page));
    u.searchParams.set("size", String(q.limit));
    const r = await getJson({ id: "kakao", label: "다음", origin: "https://dapi.kakao.com", url: u.toString(), headers: { Authorization: `KakaoAK ${key}` }, signal });
    if (!r.ok) return r;
    const body = r.body as { documents?: KakaoDoc[]; meta?: { is_end?: boolean } };
    const docs = Array.isArray(body.documents) ? body.documents : [];
    return { ok: true, hits: compact(docs.map((d) => hit("kakao", d.title, d.url, d.contents, d.datetime))), more: body.meta?.is_end === false && q.page < 50 };
  },
};

interface BraveResult {
  title?: string;
  url?: string;
  description?: string;
  page_age?: string;
}

const BRAVE_LANG: Record<WebLang, { country: string; search_lang: string }> = {
  ko: { country: "KR", search_lang: "ko" },
  ja: { country: "JP", search_lang: "jp" }, // Brave's code table lists Japanese as "jp"
  en: { country: "US", search_lang: "en" },
};

export const brave: Provider = {
  id: "brave",
  name: "Brave",
  kinds: ["web", "news"],
  env: [["BRAVE_SEARCH_API_KEY", "BRAVE_API_KEY"]],
  async run(q, [key], signal) {
    const offset = q.page - 1;
    if (offset > 9) return { ok: true, hits: [], more: false };
    const u = new URL(q.kind === "news" ? "https://api.search.brave.com/res/v1/news/search" : "https://api.search.brave.com/res/v1/web/search");
    u.searchParams.set("q", q.query);
    u.searchParams.set("count", String(Math.min(20, q.limit)));
    u.searchParams.set("offset", String(offset));
    u.searchParams.set("country", BRAVE_LANG[q.lang].country);
    u.searchParams.set("search_lang", BRAVE_LANG[q.lang].search_lang);
    const r = await getJson({ id: "brave", label: "Brave", origin: "https://api.search.brave.com", url: u.toString(), headers: { "X-Subscription-Token": key! }, signal });
    if (!r.ok) return r;
    const body = r.body as { web?: { results?: BraveResult[] }; results?: BraveResult[]; query?: { more_results_available?: boolean } };
    const list = (q.kind === "news" ? body.results : body.web?.results) ?? [];
    const hits = compact((Array.isArray(list) ? list : []).map((x) => hit("brave", x.title, x.url, x.description, x.page_age)));
    const more = body.query?.more_results_available ?? hits.length >= q.limit;
    return { ok: true, hits, more: more && offset < 9 };
  },
};

interface TavilyResult {
  title?: string;
  url?: string;
  content?: string;
  published_date?: string | null;
}

const TAVILY_COUNTRY: Record<WebLang, string> = { ko: "south korea", ja: "japan", en: "united states" };
/** Tavily returns at most 20 results and has no offset: page n asks for n × limit and keeps the last slice */
const TAVILY_MAX = 20;

export const tavily: Provider = {
  id: "tavily",
  name: "Tavily",
  kinds: ["web", "news"],
  env: [["TAVILY_API_KEY"]],
  async run(q, [key], signal) {
    const want = q.page * q.limit;
    if ((q.page - 1) * q.limit >= TAVILY_MAX) return { ok: true, hits: [], more: false };
    const body: Record<string, unknown> = { query: q.query, max_results: Math.min(TAVILY_MAX, want), search_depth: "basic", topic: q.kind === "news" ? "news" : "general" };
    if (q.kind !== "news") body.country = TAVILY_COUNTRY[q.lang];
    const r = await getJson({ id: "tavily", label: "Tavily", origin: "https://api.tavily.com", url: "https://api.tavily.com/search", method: "POST", headers: { Authorization: `Bearer ${key}` }, body, signal });
    if (!r.ok) return r;
    const res = (r.body as { results?: TavilyResult[] }).results;
    const all = compact((Array.isArray(res) ? res : []).map((x) => hit("tavily", x.title, x.url, x.content, x.published_date ?? undefined)));
    return { ok: true, hits: all.slice((q.page - 1) * q.limit, want), more: all.length >= want && want < TAVILY_MAX };
  },
};

interface ExaResult {
  title?: string | null;
  url?: string;
  publishedDate?: string | null;
  highlights?: string[];
  text?: string;
}

const EXA_COUNTRY: Record<WebLang, string> = { ko: "KR", ja: "JP", en: "US" };
/** Exa returns at most 100; pages beyond 50 results are not worth the cost */
const EXA_MAX = 50;
const EXA_HIGHLIGHTS = { maxCharacters: 320 };
/** Exa has no blog / café index of its own: the big hosts of each, by language */
const EXA_DOMAINS: Partial<Record<WebKind, Record<WebLang, string[]>>> = {
  blog: {
    ko: ["blog.naver.com", "m.blog.naver.com", "*.tistory.com", "brunch.co.kr", "velog.io", "blog.daum.net", "*.egloos.com"],
    ja: ["ameblo.jp", "note.com", "*.hatenablog.com", "*.hatenablog.jp", "*.hateblo.jp", "*.livedoor.blog", "blog.livedoor.jp", "*.fc2.com", "*.seesaa.net"],
    en: ["medium.com", "*.medium.com", "*.substack.com", "*.wordpress.com", "*.blogspot.com", "dev.to"],
  },
  cafe: {
    ko: ["cafe.naver.com", "m.cafe.naver.com", "cafe.daum.net", "m.cafe.daum.net"],
    ja: ["detail.chiebukuro.yahoo.co.jp", "*.5ch.net", "girlschannel.net", "komachi.yomiuri.co.jp"],
    en: ["reddit.com", "www.reddit.com", "quora.com", "www.quora.com"],
  },
};

const exaHits = (res: unknown) => compact((Array.isArray(res) ? (res as ExaResult[]) : []).map((x) => hit("exa", x.title, x.url, (x.highlights ?? []).join(" ") || x.text, x.publishedDate ?? undefined)));

export const exa: Provider = {
  id: "exa",
  name: "Exa",
  kinds: ["web", "news", "blog", "cafe"],
  similar: true,
  env: [["EXA_API_KEY"]],
  async run(q, [key], signal) {
    const want = q.page * q.limit;
    // the last page may be short (results 41–50 of 50); nothing past EXA_MAX
    if ((q.page - 1) * q.limit >= EXA_MAX) return { ok: true, hits: [], more: false };
    const n = Math.min(want, EXA_MAX);
    const post = (path: "/search" | "/findSimilar", body: Record<string, unknown>) =>
      getJson({ id: "exa", label: "Exa", origin: "https://api.exa.ai", url: `https://api.exa.ai${path}`, method: "POST", headers: { "x-api-key": key! }, body, signal });
    const done = (res: unknown) => {
      const all = exaHits(res);
      return { ok: true as const, hits: all.slice((q.page - 1) * q.limit, want), more: all.length >= want && want < EXA_MAX };
    };
    let excludeDomains: string[] | undefined;
    if (q.like) {
      const r = await post("/findSimilar", { url: q.like, numResults: n, excludeSourceDomain: true, contents: { highlights: EXA_HIGHLIGHTS } });
      if (r.ok) return done((r.body as { results?: unknown }).results);
      // deprecated endpoint gone (404/405/410): the same search by description, without the site itself
      if (!(r.error.status === 404 || r.error.status === 405 || r.error.status === 410) || !q.query) return r;
      try {
        excludeDomains = [new URL(q.like).hostname.replace(/^www\./, "")];
      } catch {
        return r;
      }
    }
    const body: Record<string, unknown> = { query: q.query, numResults: n, type: "auto", userLocation: EXA_COUNTRY[q.lang], contents: { highlights: EXA_HIGHLIGHTS } };
    if (q.kind === "news") body.category = "news";
    const domains = EXA_DOMAINS[q.kind]?.[q.lang];
    if (domains) body.includeDomains = domains;
    else if (excludeDomains) body.excludeDomains = excludeDomains;
    const r = await post("/search", body);
    if (!r.ok) return r;
    return done((r.body as { results?: unknown }).results);
  },
};

interface KskillNewsItem {
  title?: string;
  description?: string;
  link?: string;
  original_link?: string;
  pub_date_iso?: string;
  pub_date?: string;
}

export const kskillNews: Provider = {
  id: "kskill",
  name: "네이버 뉴스",
  kinds: ["news"],
  env: [],
  async run(q, _keys, signal) {
    const start = (q.page - 1) * q.limit + 1;
    if (start + q.limit - 1 > 1000) return { ok: true, hits: [], more: false };
    const r = await proxyGet<{ items?: KskillNewsItem[]; meta?: { total?: number } }>("/v1/naver-news/search", { query: q.query, display: q.limit, start, sort: "sim" }, signal);
    if (!r.ok) {
      const e = r.error;
      if (e.kind === "rate_limited") return { ok: false, error: { kind: "rate", message: "뉴스 검색 요청이 몰려 잠시 쉬어야 해요" } };
      if (e.kind === "timeout" || e.kind === "aborted") return { ok: false, error: { kind: "timeout", message: "뉴스 검색 응답이 너무 늦어요" } };
      if (e.kind === "bad_request") return { ok: false, error: { kind: "input", message: "뉴스 검색어를 처리하지 못했어요" } };
      if (e.kind === "network") return { ok: false, error: { kind: "network", message: "k-skill 프록시에 연결하지 못했어요" } };
      return { ok: false, error: { kind: "upstream", message: "뉴스 검색 서버 응답이 원활하지 않아요" } };
    }
    const items = Array.isArray(r.body.items) ? r.body.items : [];
    const hits = compact(items.map((n) => hit("kskill", n.title, n.original_link || n.link, n.description, n.pub_date_iso ?? n.pub_date)));
    const total = typeof r.body.meta?.total === "number" ? r.body.meta.total : 0;
    return { ok: true, hits, more: total ? start + q.limit <= Math.min(total, 1000) : hits.length >= q.limit };
  },
};

export const PROVIDERS: readonly Provider[] = [kskillNews, naver, kakao, brave, tavily, exa];
const byId = new Map(PROVIDERS.map((p) => [p.id, p]));

/**
 * Which providers to try, best first: Exa, then the others whose keys are set. Korean blogs and cafés go to Naver /
 * Daum first when their keys exist (their own indexes), Exa's domain-filtered search otherwise.
 */
export function providerOrder(kind: WebKind, lang: WebLang): ProviderId[] {
  if (kind === "blog" || kind === "cafe") return lang === "ko" ? ["naver", "kakao", "exa"] : ["exa", "naver", "kakao"];
  if (kind === "news") return lang === "ko" ? ["exa", "kskill", "naver", "brave", "tavily"] : ["exa", "brave", "tavily", "kskill"];
  return lang === "ko" ? ["exa", "naver", "kakao", "brave", "tavily"] : ["exa", "brave", "tavily", "naver", "kakao"];
}

/** ids of the providers that have their keys (no values) */
export function configuredProviders(): ProviderId[] {
  return PROVIDERS.filter((p) => providerKeys(p) !== null).map((p) => p.id);
}

// ───────────────────────────── search with fallback ─────────────────────────────

/** at most this many providers per call (bounded cost and time) */
const MAX_TRIES = 3;
/** each provider gets this long before the next one is tried */
const PROVIDER_TIMEOUT_MS = 5_000;
const CACHE_TTL_MS = 10 * 60_000;
const AUTH_PAUSE_MS = 60 * 60_000;
const RATE_PAUSE_MS = 2 * 60_000;

let clock: () => number = Date.now;
let cache = new TtlCache<{ hits: SearchHit[]; more: boolean }>(CACHE_TTL_MS, 300);
const paused = new Map<ProviderId, { until: number; error: ProviderError }>();

export function resetWebSearchState(o: { clock?: () => number } = {}): void {
  clock = o.clock ?? Date.now;
  cache = new TtlCache(CACHE_TTL_MS, 300, clock);
  paused.clear();
}

export type SearchResult =
  | { ok: true; provider: Provider; hits: SearchHit[]; more: boolean; tried: ProviderId[] }
  | { ok: false; error: ProviderError | { kind: "not_configured"; message: string }; tried: ProviderId[] };

export async function searchWeb(q: SearchQuery, signal: AbortSignal): Promise<SearchResult> {
  const tried: ProviderId[] = [];
  let lastError: ProviderError | null = null;
  let empty: { provider: Provider; more: boolean } | null = null;
  const candidates = providerOrder(q.kind, q.lang)
    .map((id) => byId.get(id)!)
    .map((p) => ({ p, keys: providerKeys(p) }))
    .filter((x): x is { p: Provider; keys: string[] } => x.keys !== null && x.p.kinds.includes(q.kind) && (!q.like || x.p.similar === true));
  if (candidates.length === 0) {
    const message = q.like ? "비슷한 사이트 찾기가 아직 연결되지 않았어요 (Exa 키 필요)" : q.kind === "blog" || q.kind === "cafe" ? "블로그·카페 검색이 아직 연결되지 않았어요 (Exa, 네이버 또는 다음 검색 키 필요)" : "일반 웹 검색이 아직 연결되지 않았어요";
    return { ok: false, tried, error: { kind: "not_configured", message } };
  }
  for (const { p, keys } of candidates) {
    if (tried.length >= MAX_TRIES || signal.aborted) break;
    const pause = paused.get(p.id);
    if (pause && pause.until > clock()) {
      lastError = pause.error;
      continue;
    }
    const cacheKey = `${p.id}|${q.kind}|${q.lang}|${q.page}|${q.limit}|${q.like ?? ""}|${q.query}`;
    const cached = cache.get(cacheKey);
    if (cached) {
      if (cached.hits.length) return { ok: true, provider: p, hits: cached.hits, more: cached.more, tried: [...tried, p.id] };
      empty ??= { provider: p, more: false };
      continue;
    }
    tried.push(p.id);
    const sub = AbortSignal.any([signal, AbortSignal.timeout(PROVIDER_TIMEOUT_MS)]);
    let out: SearchOutcome;
    try {
      out = await p.run(q, keys, sub);
    } catch {
      out = { ok: false, error: { kind: "upstream", message: `${p.name} 검색 중 오류가 났어요` } };
    }
    if (out.ok) {
      const hits = dedupe(out.hits).slice(0, q.limit);
      cache.set(cacheKey, { hits, more: out.more });
      if (hits.length) return { ok: true, provider: p, hits, more: out.more, tried };
      empty ??= { provider: p, more: false };
      continue; // nothing here: another index may have it
    }
    lastError = out.error;
    if (out.error.kind === "input") break; // the query itself is the problem
    if (out.error.kind === "auth") paused.set(p.id, { until: clock() + AUTH_PAUSE_MS, error: out.error });
    if (out.error.kind === "rate") paused.set(p.id, { until: clock() + RATE_PAUSE_MS, error: out.error });
  }
  if (empty) return { ok: true, provider: empty.provider, hits: [], more: false, tried };
  return { ok: false, tried, error: lastError ?? { kind: "upstream", message: "검색 서버 응답이 원활하지 않아요" } };
}

function dedupe(hits: SearchHit[]): SearchHit[] {
  const seen = new Set<string>();
  const out: SearchHit[] = [];
  for (const h of hits) {
    const k = h.url.replace(/#.*$/, "").replace(/\/$/, "").replace(/^https?:\/\/(www\.)?/i, "").toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(h);
  }
  return out;
}
