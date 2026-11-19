import type { ResultListCard } from "@pickle/protocol";
import { geocode, regionOf } from "../geocode";
import { proxyGet, type ProxyError } from "../http";
import { defineSkill, fail, failText, schema, str } from "../util";

export interface FineDustReport {
  station_name?: string;
  station_address?: string | null;
  lookup_mode?: string;
  measured_at?: string | null;
  pm10?: { value?: string; grade?: string };
  pm25?: { value?: string; grade?: string };
  khai_grade?: string;
}

const SLOW = "미세먼지: 지금은 측정소 응답이 늦어요";

function dustError(err: ProxyError): string {
  if (err.kind === "timeout" || err.kind === "upstream" || err.kind === "rate_limited") return SLOW;
  return "";
}

/** "강남역" → needs geocoding; "강남구", "수원시", "역삼동" → usable as an AirKorea region hint. */
export function looksLikeRegion(place: string): boolean {
  return /(특별시|광역시|자치시|자치도|[시군구동읍면도])$/.test(place.replace(/\s+/g, ""));
}

export function buildDust(place: string, r: FineDustReport): { summary: string; data: Record<string, unknown>; card: ResultListCard } {
  const pm10 = r.pm10?.value && r.pm10.value !== "-" ? `${r.pm10.value}㎍/㎥` : "-";
  const pm25 = r.pm25?.value && r.pm25.value !== "-" ? `${r.pm25.value}㎍/㎥` : "-";
  const station = r.station_name ?? "";
  const summary = `${place} 미세먼지 ${r.pm10?.grade ?? "정보없음"} · 초미세먼지 ${r.pm25?.grade ?? "정보없음"}`;
  return {
    summary,
    data: {
      place,
      station,
      stationAddress: r.station_address ?? undefined,
      measuredAt: r.measured_at ?? undefined,
      pm10: { value: r.pm10?.value ?? null, grade: r.pm10?.grade ?? null },
      pm25: { value: r.pm25?.value ?? null, grade: r.pm25?.grade ?? null },
      overall: r.khai_grade ?? null,
      source: "에어코리아",
    },
    card: {
      type: "results",
      title: `${place} 대기질`,
      source: "에어코리아",
      items: [
        { title: `미세먼지 ${r.pm10?.grade ?? "정보없음"}`, subtitle: `PM10 ${pm10}`, icon: "cloud" },
        { title: `초미세먼지 ${r.pm25?.grade ?? "정보없음"}`, subtitle: `PM2.5 ${pm25}`, icon: "cloud" },
        { title: `통합대기 ${r.khai_grade ?? "정보없음"}`, subtitle: `${station} 측정소`, meta: r.measured_at ?? undefined, icon: "clock" },
      ],
    },
  };
}

export const kFineDust = defineSkill({
  name: "k_fine_dust",
  description:
    "Real-time fine dust (PM10) / ultra-fine dust (PM2.5) levels and grades in South Korea from AirKorea, via k-skill. " +
    "Use for '미세먼지', '초미세먼지', '공기질', 'should I wear a mask'. `place` is a Korean district or place name " +
    "(e.g. '강남구', '수원시 영통구', '홍대입구역'); the nearest measuring station is chosen automatically.",
  parameters: schema({ place: { type: "string", description: "Korean district or place, e.g. '서울 강남구', '부산 해운대구'" } }, ["place"]),
  icon: "cloud",
  title: (a) => `${str(a.place, 30) || "현재 위치"} 미세먼지 확인`,
  meta: {
    source: "fine-dust-location",
    title: "미세먼지",
    description: "에어코리아 측정소 실시간 PM10·PM2.5 농도와 등급을 알려줘요.",
    category: "생활",
    example: "지금 강남구 미세먼지 어때?",
  },
  async run(a, rc) {
    const place = str(a.place, 60);
    if (!place) return failText("미세먼지: 어느 지역인지 알려주세요");
    let hint = place;
    if (!looksLikeRegion(place)) {
      const g = await geocode(place, rc.signal);
      if (g.ok && g.loc.via === "kakao" && g.loc.address) hint = regionOf(g.loc.address) || place;
    }
    rc.status("에어코리아 측정소 조회 중");
    let r = await proxyGet<FineDustReport>("/v1/fine-dust/report", { regionHint: hint }, rc.signal);
    let picked: string | undefined;
    if (!r.ok && r.error.code === "ambiguous_location") {
      const cands = r.error.body?.candidate_stations;
      const first = Array.isArray(cands) && typeof cands[0] === "string" ? cands[0] : undefined;
      if (first) {
        picked = first;
        r = await proxyGet<FineDustReport>("/v1/fine-dust/report", { stationName: first }, rc.signal);
      }
    }
    if (!r.ok) return fail(r.error, "미세먼지", dustError(r.error) || undefined, { regionHint: hint });
    const built = buildDust(place, r.body);
    if (picked) built.data.note = `여러 측정소 중 ${picked} 기준`;
    return { ok: true, summary: built.summary, data: built.data, card: built.card };
  },
});
