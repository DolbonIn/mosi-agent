/**
 * 쿠팡 파트너스 상품 검색 with the owner's own Partners access/secret key.
 *
 * NomaDamas/k-skill `coupang-product-search` (MIT) sends this search through its hosted proxy with the operator's key
 * (whose key is currently refused upstream); here the owner's own key signs the call directly against Coupang's
 * documented Partners Open API: Authorization "CEA algorithm=HmacSHA256, access-key=…, signed-date=yyMMdd'T'HHmmss'Z',
 * signature=hex(HMAC-SHA256(secret, signedDate + METHOD + path + query))". Our own implementation of the public spec;
 * no proxy code is used. Search only: no cart, deeplink or order calls.
 *
 * Coupang limits the search API per key (about 10 calls an hour), so results are cached per owner for 30 minutes
 * and a local limiter refuses early instead of burning the quota.
 */
import type { ConnectionServiceContext } from "@pickle/agent";
import { needsConnection } from "@pickle/agent";
import type { ResultListCard } from "@pickle/protocol";
import { TtlCache } from "../http";
import { defineSkill, failText, int, schema, str, won, type SkillConnection } from "../util";
import { directRequest, fromDirect, hmacSha256, limiterWaitMs, parseJson, verifyFailure, verifyKey, type DirectLimit, type UpstreamFailure, type VerifyResult } from "../direct";

export const COUPANG_ORIGIN = "https://api-gateway.coupang.com";
export const COUPANG_SEARCH_PATH = "/v2/providers/affiliate_open_api/apis/openapi/v1/products/search";
const ORIGINS = [COUPANG_ORIGIN] as const;
export const AFFILIATE_NOTICE = "쿠팡 파트너스 활동을 통해 일정액의 수수료를 제공받을 수 있습니다.";

export const COUPANG: SkillConnection = {
  id: "coupang-partners",
  name: "쿠팡 파트너스",
  reason: "쿠팡 상품을 검색하려면 쿠팡 파트너스 연결이 필요해요",
};

type Secret = Readonly<Record<string, string>>;

/** yyMMdd'T'HHmmss'Z' in UTC */
export function coupangSignedDate(now: number): string {
  const iso = new Date(now).toISOString(); // 2026-11-12T03:04:05.678Z
  return `${iso.slice(2, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}T${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}Z`;
}

export function coupangAuthorization(accessKey: string, secretKey: string, method: string, path: string, query: string, now: number): string {
  const signedDate = coupangSignedDate(now);
  const signature = hmacSha256(secretKey, `${signedDate}${method}${path}${query}`, "hex");
  return `CEA algorithm=HmacSHA256, access-key=${accessKey}, signed-date=${signedDate}, signature=${signature}`;
}

interface Product {
  productId?: number | string;
  productName?: string;
  productPrice?: number;
  productUrl?: string;
  isRocket?: boolean;
  isFreeShipping?: boolean;
  categoryName?: string;
}

type Out = { ok: true; products: Product[] } | { ok: false; error: UpstreamFailure };

const cache = new TtlCache<Product[]>(30 * 60_000, 300);
const limitFor = (credentialId: string): DirectLimit => ({ key: `coupang:${credentialId}`, burst: 10, refill: 10, windowMs: 60 * 60_000 });

/** tests */
export function resetCoupangCache(): void {
  cache.clear();
}

export async function coupangSearch(secret: Secret, credentialId: string, keyword: string, limit: number, signal: AbortSignal, now: () => number = Date.now): Promise<Out> {
  const accessKey = (secret.accessKey ?? "").trim();
  const secretKey = (secret.secretKey ?? "").trim();
  if (!accessKey || !secretKey) return { ok: false, error: { kind: "auth", message: "쿠팡 파트너스 Access Key·Secret Key가 비어 있어요" } };
  // the signature covers the query exactly as sent: build it by hand (%20 for spaces, like Coupang's examples)
  const query = `keyword=${encodeURIComponent(keyword)}&limit=${limit}`;
  const r = await directRequest({
    url: `${COUPANG_ORIGIN}${COUPANG_SEARCH_PATH}?${query}`,
    headers: { Authorization: coupangAuthorization(accessKey, secretKey, "GET", COUPANG_SEARCH_PATH, query, now()), "Content-Type": "application/json;charset=UTF-8" },
    origins: ORIGINS,
    signal,
    limit: limitFor(credentialId),
  });
  if (!r.ok) return { ok: false, error: r.error.kind === "rate_limited" ? { kind: "rate", message: "쿠팡 검색은 시간당 10번까지라 잠시 후에 다시 할 수 있어요" } : fromDirect(r.error, "쿠팡 파트너스") };
  const j = parseJson(r.res.text) as { rCode?: string | number; rMessage?: string; code?: string | number; message?: string; data?: { productData?: Product[] } | Product[] } | null | undefined;
  const code = String(j?.rCode ?? j?.code ?? "");
  if (r.res.status === 401 || r.res.status === 403 || code === "401" || code === "403") return { ok: false, error: { kind: "auth", status: r.res.status, message: "쿠팡 파트너스가 키를 거절했어요" } };
  if (r.res.status === 429 || code === "429") return { ok: false, error: { kind: "rate", status: 429, message: "쿠팡 검색 한도(시간당 약 10번)를 넘었어요. 잠시 후 다시 해 주세요" } };
  if (r.res.status !== 200 || (code !== "" && code !== "0")) return { ok: false, error: { kind: r.res.status === 400 ? "input" : "upstream", status: r.res.status, message: str(j?.rMessage ?? j?.message, 120) || "쿠팡 파트너스 응답이 원활하지 않아요" } };
  const data = j?.data;
  const products = Array.isArray(data) ? data : Array.isArray(data?.productData) ? data.productData : [];
  return { ok: true, products };
}

export async function verifyCoupang(secret: Secret, x: ConnectionServiceContext): Promise<VerifyResult> {
  // one real search (limit 1): the Partners API has no cheaper authenticated read
  const r = await coupangSearch(secret, verifyKey(secret.accessKey ?? ""), "생수", 1, x.signal);
  if (!r.ok) return verifyFailure(r.error, "쿠팡 파트너스가 키를 받지 않았어요. 파트너스 > 추가기능 > Open API의 Access Key와 Secret Key를 확인해 주세요.");
  return { ok: true, accountLabel: "쿠팡 파트너스" };
}

export const kCoupangSearch = defineSkill({
  name: "k_coupang_search",
  description:
    "Coupang product search with the owner's own 쿠팡 파트너스 key: title, price, 로켓배송, free shipping, link. Needs the owner's 쿠팡 파트너스 connection " +
    "(use this instead of k_shopping when it says 쿠팡 검색이 제한돼 있어요). About 10 searches an hour, so search once with a precise query. " +
    "Links are affiliate links: always add the disclosure in `data.notice` when you share them. Optional `maxPrice` (KRW), `rocketOnly`.",
  parameters: schema(
    {
      query: { type: "string", description: "product search query, 2–50 chars" },
      limit: { type: "integer", minimum: 1, maximum: 10, description: "default 10" },
      maxPrice: { type: "integer", description: "optional budget in KRW" },
      rocketOnly: { type: "boolean", description: "only 로켓배송" },
    },
    ["query"],
  ),
  icon: "bag",
  title: (a) => `쿠팡에서 ${str(a.query, 20)} 찾기`,
  meta: { source: "coupang-product-search", title: "쿠팡 파트너스 검색", description: "내 쿠팡 파트너스 키로 상품·가격·로켓배송을 찾아요.", category: "쇼핑", example: "쿠팡에서 무선청소기 20만원 이하로 찾아줘" },
  connection: COUPANG,
  private: false, // a product search
  async run(a, rc) {
    const conn = rc.conn!;
    const query = str(a.query, 50);
    if (query.length < 2) return failText("쿠팡: 검색어를 두 글자 이상 알려주세요");
    const limit = int(a.limit, 1, 10, 10);
    const key = `${conn.credentialId}\u0000${query}\u0000${limit}`;
    let products = cache.get(key);
    const cached = !!products;
    if (!products) {
      if (limiterWaitMs(limitFor(conn.credentialId)) > 3000) return failText("쿠팡: 검색은 시간당 10번까지라 잠시 후에 다시 할 수 있어요", "rate");
      rc.status("쿠팡 상품 검색 중");
      const r = await coupangSearch(conn.secret, conn.credentialId, query, limit, rc.signal);
      if (!r.ok) {
        if (r.error.kind === "auth") return needsConnection(COUPANG.id, COUPANG.name, `${r.error.message}. 쿠팡 파트너스를 다시 연결해 주세요.`);
        return failText(`쿠팡: ${r.error.message}`, r.error.kind);
      }
      products = r.products;
      cache.set(key, products);
    }
    const max = typeof a.maxPrice === "number" && a.maxPrice > 0 ? a.maxPrice : null;
    const items = products
      .map((p) => ({ id: p.productId, title: str(p.productName, 90), price: typeof p.productPrice === "number" ? p.productPrice : null, rocket: !!p.isRocket, freeShipping: !!p.isFreeShipping, category: p.categoryName, url: p.productUrl }))
      .filter((p) => p.title)
      .filter((p) => (max === null || (p.price !== null && p.price <= max)) && (!a.rocketOnly || p.rocket));
    if (!items.length) return { ok: true, summary: `‘${query}’ 조건에 맞는 상품이 없어요`, data: { query, items: [], cached } };
    const card: ResultListCard = {
      type: "results",
      title: `쿠팡 ‘${query}’`,
      source: "쿠팡 파트너스",
      items: items.slice(0, 8).map((p) => ({
        title: p.title,
        subtitle: [p.price !== null ? won(p.price) : "", p.rocket ? "로켓배송" : p.freeShipping ? "무료배송" : ""].filter(Boolean).join(" · "),
        meta: p.category,
        url: p.url,
        icon: "bag",
      })),
    };
    const cheapest = items.filter((p) => p.price !== null).sort((x, y) => x.price! - y.price!)[0];
    return {
      ok: true,
      summary: `‘${query}’ ${items.length}개${cheapest ? ` · 최저 ${won(cheapest.price!)}` : ""}`,
      data: { query, items: items.slice(0, 10), cached, notice: AFFILIATE_NOTICE, caution: "가격·재고·배송은 바뀔 수 있어요." },
      card,
    };
  },
});

export const COUPANG_FIELDS = [
  { key: "accessKey", label: "Access Key", type: "text" as const, autocomplete: "off", placeholder: "추가기능 > Open API" },
  { key: "secretKey", label: "Secret Key", type: "password" as const, autocomplete: "off", hint: "상품 검색에만 써요." },
];
