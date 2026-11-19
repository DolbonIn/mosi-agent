import type { ResultListCard } from "@pickle/protocol";
import { KAKAO_KEYWORD, type KakaoKeywordResponse } from "../geocode";
import { proxyGet } from "../http";
import { cleanText, defineSkill, fail, failText, int, meters, num, schema, str, won } from "../util";

// ───────────────────────────── 장소 검색 ─────────────────────────────

export function buildPlaces(label: string, body: KakaoKeywordResponse, limit: number): { summary: string; data: Record<string, unknown>; card: ResultListCard } | null {
  const docs = (body.documents ?? []).slice(0, limit);
  if (docs.length === 0) return null;
  const places = docs.map((d) => {
    const cat = (d.category_name ?? "").split(">").map((x) => x.trim()).filter(Boolean);
    const dist = num(d.distance);
    return {
      name: d.place_name ?? "",
      category: cat[cat.length - 1] ?? d.category_group_name ?? "",
      address: d.road_address_name || d.address_name || "",
      phone: d.phone || undefined,
      url: d.place_url || undefined,
      distanceM: dist ?? undefined,
    };
  });
  return {
    summary: `‘${label}’ 장소 ${places.length}곳 · ${places
      .slice(0, 3)
      .map((p) => p.name)
      .join(", ")}`,
    data: { query: label, total: body.meta?.total_count ?? undefined, places, source: "카카오맵" },
    card: {
      type: "results",
      title: `‘${label}’ 검색 결과`,
      source: "카카오맵",
      items: places.map((p) => ({
        title: p.name,
        subtitle: p.address,
        meta: [p.category, p.phone, p.distanceM !== undefined ? meters(p.distanceM) : ""].filter(Boolean).join(" · ") || undefined,
        url: p.url,
        icon: "map" as const,
      })),
    },
  };
}

export const kPlaceSearch = defineSkill({
  name: "k_place_search",
  description:
    "Search places in South Korea on Kakao Map (restaurants, cafes, shops, hospitals, offices, landmarks…), via k-skill. " +
    "Returns name, category, road address, phone and Kakao Map link. `query` is what to look for (e.g. '카페', '을지로 노포', " +
    "'서울대병원'); `near` optionally anchors the search to an area (e.g. '성수동'); `limit` 1-10 (default 5).",
  parameters: schema(
    {
      query: { type: "string", description: "what to search, Korean, e.g. '카페', '돈까스 맛집', '약국'" },
      near: { type: "string", description: "optional area/landmark, e.g. '성수동', '판교역'" },
      limit: { type: "integer", minimum: 1, maximum: 10, description: "number of places, default 5" },
    },
    ["query"],
  ),
  icon: "map",
  title: (a) => `${[str(a.near, 20), str(a.query, 30)].filter(Boolean).join(" ")} 장소 찾기`,
  meta: {
    source: "kakao-map",
    title: "장소 검색",
    description: "카카오맵에서 가게·병원·명소를 찾아 주소·전화·지도 링크를 알려줘요.",
    category: "생활",
    example: "성수동 조용한 카페 찾아줘",
  },
  async run(a, rc) {
    const query = str(a.query, 60);
    if (!query) return failText("장소 검색: 무엇을 찾을지 알려주세요");
    const near = str(a.near, 40);
    const limit = int(a.limit, 1, 10, 5);
    const label = near && !query.includes(near) ? `${near} ${query}` : query;
    const r = await proxyGet<KakaoKeywordResponse>(KAKAO_KEYWORD, { query: label, size: Math.max(limit, 5) }, rc.signal);
    if (!r.ok) return fail(r.error, "장소 검색");
    const built = buildPlaces(label, r.body, limit);
    if (!built) return failText(`장소 검색: ‘${label}’ 결과가 없어요`, "not_found");
    return { ok: true, ...built };
  },
});

// ───────────────────────────── 뉴스 ─────────────────────────────

export interface NaverNewsResponse {
  items?: { title?: string; description?: string; link?: string; original_link?: string; pub_date?: string; pub_date_iso?: string }[];
  total?: number;
}

function kstStamp(iso: string | undefined): string | undefined {
  if (!iso) return undefined;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return undefined;
  const d = new Date(t + 9 * 3600_000);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

function outlet(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).hostname.replace(/^(www|m|news)\./, "");
  } catch {
    return undefined;
  }
}

export function buildNews(query: string, body: NaverNewsResponse, limit: number): { summary: string; data: Record<string, unknown>; card: ResultListCard } | null {
  const items = (body.items ?? []).slice(0, limit).map((n) => ({
    title: cleanText(n.title, 120),
    summary: cleanText(n.description, 160),
    url: n.link || n.original_link || undefined,
    outlet: outlet(n.original_link),
    publishedAt: kstStamp(n.pub_date_iso) ?? n.pub_date,
  }));
  if (items.length === 0) return null;
  return {
    summary: `‘${query}’ 뉴스 ${items.length}건 · ${items[0]?.title ?? ""}`.slice(0, 90),
    data: { query, articles: items, source: "네이버 뉴스 검색" },
    card: {
      type: "results",
      title: `‘${query}’ 뉴스`,
      source: "네이버 뉴스",
      items: items.map((n) => ({
        title: n.title,
        subtitle: n.summary.slice(0, 80),
        // time first: a narrow card cuts the end of the right column, and the time is what the row needs
        meta: [n.publishedAt, n.outlet].filter(Boolean).join(" · ") || undefined,
        url: n.url,
        icon: "doc" as const,
      })),
    },
  };
}

export const kNews = defineSkill({
  name: "k_news",
  description:
    "Search Korean news articles (Naver News search, via k-skill). Use for current events, '요즘 ~ 소식', company/person news. " +
    "`query` is the search keyword (Korean or English); `limit` 1-10 (default 5); `sort` 'date' for the latest first (default) or 'relevance'.",
  parameters: schema(
    {
      query: { type: "string", description: "news search keyword, e.g. 'AI', '금리 인하'" },
      limit: { type: "integer", minimum: 1, maximum: 10, description: "number of articles, default 5" },
      sort: { type: "string", enum: ["date", "relevance"], description: "'date' (latest, default) or 'relevance'" },
    },
    ["query"],
  ),
  icon: "doc",
  title: (a) => `‘${str(a.query, 30)}’ 뉴스 검색`,
  meta: {
    source: "naver-news-search",
    title: "뉴스",
    description: "네이버 뉴스에서 최신 기사를 찾아 제목·요약·링크를 알려줘요.",
    category: "정보",
    example: "오늘 AI 관련 뉴스 정리해줘",
  },
  async run(a, rc) {
    const query = str(a.query, 80);
    if (!query) return failText("뉴스: 검색어를 알려주세요");
    const limit = int(a.limit, 1, 10, 5);
    const sort = a.sort === "relevance" ? "sim" : "date";
    const r = await proxyGet<NaverNewsResponse>("/v1/naver-news/search", { query, display: Math.max(limit, 5), sort }, rc.signal);
    if (!r.ok) return fail(r.error, "뉴스");
    const built = buildNews(query, r.body, limit);
    if (!built) return failText(`뉴스: ‘${query}’ 기사를 찾지 못했어요`, "not_found");
    return { ok: true, ...built };
  },
});

// ───────────────────────────── 쇼핑 (쿠팡) ─────────────────────────────

export interface CoupangResponse {
  items?: {
    rank?: number;
    product_id?: string | null;
    title?: string | null;
    price?: number | null;
    url?: string | null;
    review_count?: number | null;
    score?: number | null;
    is_rocket?: boolean;
    is_free_shipping?: boolean;
  }[];
}

export function buildShopping(query: string, body: CoupangResponse, limit: number): { summary: string; data: Record<string, unknown>; card: ResultListCard } | null {
  const items = (body.items ?? [])
    .filter((p) => p.title)
    .slice(0, limit)
    .map((p) => ({
      title: cleanText(p.title, 100),
      price: typeof p.price === "number" ? p.price : null,
      priceText: typeof p.price === "number" ? won(p.price) : "-",
      rocket: p.is_rocket || undefined,
      freeShipping: p.is_free_shipping || undefined,
      rating: p.score ?? undefined,
      reviews: p.review_count ?? undefined,
      url: p.url ?? undefined,
    }));
  if (items.length === 0) return null;
  const prices = items.map((p) => p.price).filter((x): x is number => x !== null);
  const min = prices.length ? Math.min(...prices) : null;
  return {
    summary: `쿠팡 ‘${query}’ ${items.length}개${min !== null ? ` · 최저 ${won(min)}` : ""}`,
    data: { query, products: items, note: "쿠팡 파트너스 검색 결과 (가격은 조회 시점 기준)", source: "쿠팡" },
    card: {
      type: "results",
      title: `쿠팡 ‘${query}’`,
      source: "쿠팡",
      items: items.map((p) => ({
        title: p.title,
        subtitle: [p.priceText, p.rocket ? "로켓배송" : p.freeShipping ? "무료배송" : ""].filter(Boolean).join(" · "),
        meta: p.rating !== undefined ? `★${p.rating}${p.reviews !== undefined ? ` (${p.reviews.toLocaleString("en-US")})` : ""}` : undefined,
        url: p.url,
        icon: "bag" as const,
      })),
    },
  };
}

export const kShopping = defineSkill({
  name: "k_shopping",
  description:
    "Search products and current prices on Coupang (Korean e-commerce, via k-skill's Coupang Partners proxy). " +
    "Use for '최저가', '얼마야', product comparisons. `query` is a product keyword (≥ 2 chars); `limit` 1-10 (default 5). " +
    "Read-only: never buys anything.",
  parameters: schema(
    {
      query: { type: "string", description: "product keyword, e.g. '생수 2L', '에어팟 프로'" },
      limit: { type: "integer", minimum: 1, maximum: 10, description: "number of products, default 5" },
    },
    ["query"],
  ),
  icon: "bag",
  title: (a) => `쿠팡에서 ‘${str(a.query, 30)}’ 찾기`,
  meta: {
    source: "coupang-product-search",
    title: "쇼핑 검색",
    description: "쿠팡 상품과 현재 가격·로켓배송 여부를 찾아줘요.",
    category: "쇼핑",
    example: "생수 2L 쿠팡 최저가 찾아줘",
  },
  async run(a, rc) {
    const query = str(a.query, 100);
    if (query.length < 2) return failText("쇼핑: 상품 이름을 두 글자 이상 알려주세요");
    const limit = int(a.limit, 1, 10, 5);
    const r = await proxyGet<CoupangResponse>("/v1/coupang/products/search", { query, limit: Math.max(limit, 5) }, rc.signal);
    if (!r.ok) {
      const blocked = r.error.code === "upstream_forbidden";
      return fail(
        r.error,
        "쇼핑",
        blocked ? "쇼핑: 쿠팡 검색이 지금은 제한돼 있어요 (제휴 API 이용 제한)" : undefined,
        blocked ? { hint: "주인이 쿠팡 파트너스 키를 연결하면 k_coupang_search로 검색할 수 있어요." } : undefined,
      );
    }
    const built = buildShopping(query, r.body, limit);
    if (!built) return failText(`쇼핑: ‘${query}’ 상품을 찾지 못했어요`, "not_found");
    return { ok: true, ...built };
  },
});
