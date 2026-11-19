import type { ResultListCard } from "@pickle/protocol";
import { isDeterministicUpstreamFailure, proxyGet, type ProxyError } from "../http";
import { defineSkill, fail, failText, kst, manwon, pad, schema, str, won } from "../util";

// ───────────────────────────── 주식 (KRX) ─────────────────────────────

export interface KrxListing {
  market?: string;
  code?: string;
  standard_code?: string;
  name?: string;
  short_name?: string;
  english_name?: string;
  listed_at?: string;
  stock_kind?: string;
  par_value?: number | null;
  listed_shares?: number | null;
}
export interface KrxSearchResponse {
  items?: KrxListing[];
  query?: { bas_dd?: string };
}
export interface KrxTradeResponse {
  item?: {
    date?: string;
    close_price?: number | null;
    change_price?: number | null;
    fluctuation_rate?: number | null;
    open_price?: number | null;
    high_price?: number | null;
    low_price?: number | null;
    volume?: number | null;
    trading_value?: number | null;
    market_cap?: number | null;
  };
}

export function pickListing(query: string, items: KrxListing[]): KrxListing | undefined {
  const q = query.replace(/\s+/g, "").toLowerCase();
  return (
    items.find((i) => i.code === query.trim()) ??
    items.find((i) => (i.short_name ?? "").replace(/\s+/g, "").toLowerCase() === q) ??
    items.find((i) => (i.name ?? "").replace(/\s+/g, "").toLowerCase() === q) ??
    items.find((i) => i.stock_kind === "보통주") ??
    items[0]
  );
}

function eokWon(v: number): string {
  if (v >= 1e12) return `${(v / 1e12).toFixed(1)}조원`;
  if (v >= 1e8) return `${Math.round(v / 1e8).toLocaleString("en-US")}억원`;
  return `${Math.round(v).toLocaleString("en-US")}원`;
}

/**
 * Why there is no quote, as a sentence the model can say out loud (in a call it reads data aloud, so no status codes
 * or upstream wording here).
 */
export function quoteErrorText(err: ProxyError | null, market: string | undefined): string {
  const m = market ?? "이 시장";
  if (!err) return `거래소 응답에 ${m} 가격이 없어요 (거래정지이거나 아직 집계 전일 수 있어요)`;
  if (isDeterministicUpstreamFailure(err)) {
    const us = (err.body?.upstream as { status_code?: unknown } | undefined)?.status_code;
    if (us === 429 || /LIMITED_NUMBER|quota/i.test(err.message)) return "거래소 시세 조회 한도가 차서 지금은 못 가져와요";
    return `거래소 시세 제공처가 지금 ${m} 시세를 주지 않아요`;
  }
  switch (err.kind) {
    case "timeout":
      return "거래소 시세 응답이 너무 늦어요";
    case "rate_limited":
      return "시세 요청이 몰려 잠시 후에 다시 볼 수 있어요";
    case "network":
      return "시세 서버에 연결하지 못했어요";
    default:
      return "거래소 시세 서비스가 지금 원활하지 않아요";
  }
}

export function buildStock(
  query: string,
  search: KrxSearchResponse,
  trade: KrxTradeResponse | null,
  tradeError: ProxyError | null,
): { summary: string; data: Record<string, unknown>; card: ResultListCard } | null {
  const items = search.items ?? [];
  const pick = pickListing(query, items);
  if (!pick) return null;
  const name = pick.short_name ?? pick.name ?? query;
  const t = trade?.item;
  const price = typeof t?.close_price === "number" ? t.close_price : null;
  const rate = typeof t?.fluctuation_rate === "number" ? t.fluctuation_rate : null;
  const listing = {
    name,
    fullName: pick.name,
    code: pick.code,
    market: pick.market,
    kind: pick.stock_kind,
    listedAt: pick.listed_at,
    listedShares: pick.listed_shares ?? undefined,
  };
  const others = items.filter((i) => i !== pick).slice(0, 4).map((i) => ({ name: i.short_name ?? i.name, code: i.code, market: i.market }));
  const summary =
    price !== null
      ? `${name} ${won(price)}${rate !== null ? ` (${rate > 0 ? "+" : ""}${rate}%)` : ""} · ${t?.date ?? ""} 종가`
      : `${name} (${pick.market} ${pick.code}) · 시세를 지금 못 가져와요`;
  const cardItems: ResultListCard["items"] = [];
  if (price !== null) {
    cardItems.push({
      title: `종가 ${won(price)}`,
      subtitle: [rate !== null ? `${rate > 0 ? "▲" : rate < 0 ? "▼" : ""}${Math.abs(rate)}%` : "", t?.date ?? ""].filter(Boolean).join(" · "),
      meta: typeof t?.market_cap === "number" ? `시총 ${eokWon(t.market_cap)}` : undefined,
      icon: "chart",
    });
    if (typeof t?.high_price === "number" && typeof t.low_price === "number") {
      cardItems.push({ title: `고가 ${won(t.high_price)} · 저가 ${won(t.low_price)}`, subtitle: typeof t.volume === "number" ? `거래량 ${t.volume.toLocaleString("en-US")}주` : "", icon: "chart" });
    }
  }
  const quoteUrl = pick.code ? `https://finance.naver.com/item/main.naver?code=${pick.code}` : undefined;
  if (price === null) {
    cardItems.push({ title: "시세를 지금 가져올 수 없어요", subtitle: "네이버 증권에서 현재가를 확인하세요", url: quoteUrl, icon: "chart" });
  }
  cardItems.push({
    title: `${name} ${pick.code ?? ""}`,
    subtitle: [pick.market, pick.stock_kind, pick.listed_at ? `${pick.listed_at} 상장` : ""].filter(Boolean).join(" · "),
    meta: typeof pick.listed_shares === "number" ? `상장주식 ${pick.listed_shares.toLocaleString("en-US")}주` : undefined,
    url: quoteUrl,
    icon: "chart",
  });
  return {
    summary,
    data: {
      listing,
      quoteAvailable: price !== null,
      quote: t ? { date: t.date, close: price, change: t.change_price, changeRate: rate, open: t.open_price, high: t.high_price, low: t.low_price, volume: t.volume, marketCap: t.market_cap } : null,
      quoteError: price === null ? quoteErrorText(tradeError, pick.market) : undefined,
      quoteUrl,
      hint:
        price === null
          ? "시세(현재가·종가·등락률)는 지금 가져올 수 없어요. 가격을 추측하거나 기억으로 말하지 말고, 못 가져왔다고 말한 뒤 quoteUrl(네이버 증권)을 안내하세요."
          : undefined,
      otherMatches: others.length ? others : undefined,
      note: price !== null ? "KRX 일별 데이터라 실시간 시세가 아니라 직전 거래일 종가예요." : undefined,
      source: "한국거래소(KRX) 정보데이터",
    },
    card: { type: "results", title: `${name} 주식`, source: "한국거래소", items: cardItems },
  };
}

export const kStock = defineSkill({
  name: "k_stock",
  description:
    "Korean listed stock lookup (KOSPI/KOSDAQ/KONEX, Korea Exchange data via k-skill): resolves a company name or 6-digit code " +
    "to its listing, and the previous trading day's close / change / volume when available (daily data, not real-time). " +
    "`query` is a company name or ticker (e.g. '삼성전자', '005930').",
  parameters: schema({ query: { type: "string", description: "company name or 6-digit code, e.g. '삼성전자', '035720'" } }, ["query"]),
  icon: "chart",
  title: (a) => `${str(a.query, 20)} 주식 정보 확인`,
  meta: {
    source: "korean-stock-search",
    title: "주식",
    description: "한국거래소 상장 종목 정보와 직전 거래일 시세를 알려줘요.",
    category: "금융",
    example: "삼성전자 어제 종가 얼마였어?",
  },
  async run(a, rc) {
    const query = str(a.query, 40);
    if (!query) return failText("주식: 종목 이름이나 코드를 알려주세요");
    rc.status("KRX 종목 검색 중");
    const s = await proxyGet<KrxSearchResponse>("/v1/korean-stock/search", { q: query, limit: 5 }, rc.signal);
    if (!s.ok) return fail(s.error, "주식");
    const pick = pickListing(query, s.body.items ?? []);
    if (!pick || !pick.code || !pick.market) return failText(`주식: ‘${query}’ 종목을 찾지 못했어요`, "not_found");
    // KRX approves each market's daily-trade API separately (KOSPI can be rejected while KOSDAQ/KONEX answer), so a
    // failure closes the breaker for that market only
    const tr = await proxyGet<KrxTradeResponse>(
      "/v1/korean-stock/trade-info",
      { market: pick.market, code: pick.code },
      rc.signal,
      { breakerScope: pick.market },
    );
    const built = buildStock(query, s.body, tr.ok ? tr.body : null, tr.ok ? null : tr.error);
    if (!built) return failText(`주식: ‘${query}’ 종목을 찾지 못했어요`, "not_found");
    return { ok: true, ...built };
  },
});

// ───────────────────────────── 아파트 실거래가 (국토부) ─────────────────────────────

export interface RegionCodeResponse {
  results?: { lawd_cd?: string; name?: string }[];
}
export interface AptTradeResponse {
  items?: { name?: string; district?: string; area_m2?: number; floor?: number; price_10k?: number; deal_date?: string; build_year?: number }[];
  summary?: { median_price_10k?: number; min_price_10k?: number; max_price_10k?: number; sample_count?: number };
  total_count?: number;
}

export function pickRegion(region: string, results: { lawd_cd?: string; name?: string }[]): { lawdCd: string; name: string } | { ambiguous: string[] } | null {
  const valid = results.filter((r): r is { lawd_cd: string; name: string } => !!r.lawd_cd && !!r.name);
  if (valid.length === 0) return null;
  if (valid.length === 1) return { lawdCd: valid[0]!.lawd_cd, name: valid[0]!.name };
  const norm = (s: string) => s.replace(/\s+/g, "");
  const q = norm(region);
  const exact = valid.find((r) => norm(r.name) === q);
  if (exact) return { lawdCd: exact.lawd_cd, name: exact.name };
  const suffix = valid.filter((r) => norm(r.name).endsWith(q));
  if (suffix.length === 1) return { lawdCd: suffix[0]!.lawd_cd, name: suffix[0]!.name };
  return { ambiguous: valid.map((r) => r.name) };
}

function pyeong(m2: number): number {
  return Math.round(m2 / 3.3058);
}

export function buildApt(regionName: string, ym: string, body: AptTradeResponse): { summary: string; data: Record<string, unknown>; card: ResultListCard } {
  const items = (body.items ?? []).filter((i) => typeof i.price_10k === "number");
  const prices = items.map((i) => i.price_10k as number).sort((a, b) => a - b);
  const median = prices.length ? (prices[Math.floor((prices.length - 1) / 2)]! + prices[Math.ceil((prices.length - 1) / 2)]!) / 2 : null;
  const recent = [...items].sort((a, b) => ((a.deal_date ?? "") < (b.deal_date ?? "") ? 1 : -1)).slice(0, 10);
  const label = `${ym.slice(0, 4)}년 ${+ym.slice(4)}월`;
  const fmt = (i: (typeof items)[number]) => ({
    apt: i.name,
    dong: i.district,
    priceText: manwon(i.price_10k as number),
    area: typeof i.area_m2 === "number" ? `${i.area_m2}㎡(${pyeong(i.area_m2)}평)` : undefined,
    floor: i.floor,
    date: i.deal_date,
    built: i.build_year,
  });
  const top = [...items].sort((a, b) => (b.price_10k ?? 0) - (a.price_10k ?? 0)).slice(0, 3);
  const summary = items.length
    ? `${regionName} ${label} 아파트 매매 ${items.length}건 · 중위 ${manwon(median ?? 0)}`
    : `${regionName} ${label} 신고된 아파트 매매가 아직 없어요`;
  return {
    summary,
    data: {
      region: regionName,
      month: label,
      count: items.length,
      reportedTotal: typeof body.total_count === "number" && body.total_count !== items.length ? body.total_count : undefined,
      medianText: median !== null ? manwon(median) : null,
      minText: prices.length ? manwon(prices[0]!) : null,
      maxText: prices.length ? manwon(prices[prices.length - 1]!) : null,
      recent: recent.map(fmt),
      highest: top.map(fmt),
      note: "실거래 신고는 계약 후 30일 이내라 최근 달은 건수가 적을 수 있어요. 가격 단위는 만원 기준을 억/만원으로 표기.",
      source: "국토교통부 실거래가 공개시스템",
    },
    card: {
      type: "results",
      title: `${regionName} ${label} 아파트 실거래`,
      source: "국토교통부",
      items: recent.slice(0, 8).map((i) => ({
        title: `${i.name ?? ""}${i.district ? ` (${i.district})` : ""}`,
        subtitle: `${manwon(i.price_10k as number)} · ${typeof i.area_m2 === "number" ? `${i.area_m2}㎡` : ""}${typeof i.floor === "number" ? ` · ${i.floor}층` : ""}`,
        meta: i.deal_date ? i.deal_date.slice(5).replace("-", "/") : undefined,
        icon: "house" as const,
      })),
    },
  };
}

export const kRealEstate = defineSkill({
  name: "k_real_estate",
  description:
    "Apartment sale transactions (실거래가) for a Korean city/district and month from MOLIT, via k-skill: count, median/min/max price, " +
    "recent and highest deals. `region` is a 시/군/구 name (e.g. '마포구', '성남시 분당구'; add the city for ambiguous names like " +
    "'서울 중구'); `yearMonth` is YYYYMM (default: last month).",
  parameters: schema(
    {
      region: { type: "string", description: "시군구, e.g. '마포구', '서울 중구', '분당구'" },
      yearMonth: { type: "string", description: "contract month YYYYMM, default last month" },
    },
    ["region"],
  ),
  icon: "house",
  title: (a) => `${str(a.region, 20)} 아파트 실거래가 확인`,
  meta: {
    source: "real-estate-search",
    title: "아파트 실거래가",
    description: "국토부 실거래가로 지역별 아파트 매매 건수·중위가격·최근 거래를 알려줘요.",
    category: "금융",
    example: "마포구 지난달 아파트 실거래가 어때?",
  },
  async run(a, rc) {
    const region = str(a.region, 30);
    if (!region) return failText("실거래가: 지역(시군구)을 알려주세요");
    const t = kst(rc.now);
    const last = t.m === 1 ? `${t.y - 1}12` : `${t.y}${pad(t.m - 1)}`;
    const ymRaw = str(a.yearMonth, 10).replace(/[^0-9]/g, "");
    const ym = /^\d{6}$/.test(ymRaw) && +ymRaw.slice(4) >= 1 && +ymRaw.slice(4) <= 12 ? ymRaw : last;
    const rcode = await proxyGet<RegionCodeResponse>("/v1/real-estate/region-code", { q: region }, rc.signal);
    if (!rcode.ok) return fail(rcode.error, "실거래가");
    const pick = pickRegion(region, rcode.body.results ?? []);
    if (!pick) return failText(`실거래가: ‘${region}’ 지역 코드를 찾지 못했어요`, "not_found");
    if ("ambiguous" in pick) {
      return failText(`실거래가: ‘${region}’에 해당하는 곳이 여러 곳이에요 (${pick.ambiguous.slice(0, 5).join(", ")})`, "ambiguous_region", { candidates: pick.ambiguous.slice(0, 10) });
    }
    rc.status(`${pick.name} 실거래 조회 중`);
    const r = await proxyGet<AptTradeResponse>(`/v1/real-estate/apartment/trade`, { lawd_cd: pick.lawdCd, deal_ymd: ym, num_of_rows: 1000 }, rc.signal);
    if (!r.ok) return fail(r.error, "실거래가");
    return { ok: true, ...buildApt(pick.name, ym, r.body) };
  },
});
