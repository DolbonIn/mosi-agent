import { cityFallback } from "./geo";
import { proxyGet, type ProxyError } from "./http";
import { str } from "./util";

export interface KakaoPlace {
  id?: string;
  place_name?: string;
  category_name?: string;
  category_group_code?: string;
  category_group_name?: string;
  phone?: string;
  address_name?: string;
  road_address_name?: string;
  place_url?: string;
  distance?: string;
  x?: string;
  y?: string;
}

export interface KakaoKeywordResponse {
  documents?: KakaoPlace[];
  meta?: { total_count?: number; pageable_count?: number; is_end?: boolean };
}

export interface Located {
  query: string;
  name: string;
  address: string;
  lat: number;
  lon: number;
  via: "kakao" | "fallback";
}

export const KAKAO_KEYWORD = "/v1/kakao-map/search/keyword";

export function toLocated(query: string, d: KakaoPlace): Located | null {
  const lat = Number(d.y);
  const lon = Number(d.x);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return {
    query,
    name: d.place_name || query,
    address: d.road_address_name || d.address_name || "",
    lat,
    lon,
    via: "kakao",
  };
}

/**
 * Resolve a Korean place name to WGS84 via the proxy's Kakao keyword search (1 request, cached 5 min).
 * Falls back to the built-in table of major cities when the search fails or finds nothing.
 */
export async function geocode(
  place: string,
  signal: AbortSignal,
): Promise<{ ok: true; loc: Located } | { ok: false; error?: ProxyError }> {
  const q = str(place, 80);
  if (!q) return { ok: false };
  const r = await proxyGet<KakaoKeywordResponse>(KAKAO_KEYWORD, { query: q, size: 1 }, signal);
  if (r.ok) {
    const first = r.body.documents?.[0];
    const loc = first ? toLocated(q, first) : null;
    if (loc) return { ok: true, loc };
  } else if (r.error.kind === "aborted" || r.error.kind === "timeout") {
    return { ok: false, error: r.error };
  }
  const fb = cityFallback(q);
  if (fb) return { ok: true, loc: { query: q, name: fb.name, address: fb.name, lat: fb.lat, lon: fb.lon, via: "fallback" } };
  return { ok: false, error: r.ok ? undefined : r.error };
}

/** "서울 강남구 역삼동 858" → "서울 강남구" (sido + sigungu) */
export function regionOf(address: string): string {
  const parts = address.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "";
  // 세종특별자치시 has no 시군구 level
  if (parts[0]?.startsWith("세종")) return parts[0];
  return parts.slice(0, 2).join(" ");
}
