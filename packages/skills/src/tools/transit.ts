import type { ResultListCard } from "@pickle/protocol";
import { geocode, type Located } from "../geocode";
import { proxyGet } from "../http";
import { defineSkill, fail, failText, int, meters, minutes, schema, str, wonKo } from "../util";

// ───────────────────────────── subway ─────────────────────────────

const SUBWAY_LINES: Record<string, string> = {
  "1001": "1호선",
  "1002": "2호선",
  "1003": "3호선",
  "1004": "4호선",
  "1005": "5호선",
  "1006": "6호선",
  "1007": "7호선",
  "1008": "8호선",
  "1009": "9호선",
  "1032": "GTX-A",
  "1061": "중앙선",
  "1063": "경의중앙선",
  "1065": "공항철도",
  "1067": "경춘선",
  "1075": "수인분당선",
  "1077": "신분당선",
  "1081": "경강선",
  "1092": "우이신설선",
  "1093": "서해선",
  "1094": "신림선",
};

export interface SubwayArrival {
  subwayId?: string;
  updnLine?: string;
  trainLineNm?: string;
  statnNm?: string;
  btrainSttus?: string | null;
  barvlDt?: string;
  bstatnNm?: string;
  arvlMsg2?: string;
  arvlMsg3?: string;
  arvlCd?: string;
  ordkey?: string;
  lstcarAt?: string;
  recptnDt?: string;
}
export interface SubwayResponse {
  errorMessage?: { status?: number; code?: string; message?: string; total?: number };
  realtimeArrivalList?: SubwayArrival[];
  status?: number;
  code?: string;
  message?: string;
}

/** "강남역" → "강남", "서울역" → "서울", "강남역 2호선" → "강남" */
export function stationName(input: string): string {
  let s = input.replace(/\s*\(.*?\)\s*/g, "").replace(/\s*\d+호선.*$/, "").trim();
  s = s.replace(/역$/, "");
  return s || input.trim();
}

export function buildSubway(station: string, body: SubwayResponse): { summary: string; data: Record<string, unknown>; card: ResultListCard } | null {
  const list = body.realtimeArrivalList ?? [];
  if (list.length === 0) return null;
  const rows = list
    .map((r) => {
      const line = SUBWAY_LINES[r.subwayId ?? ""] ?? r.subwayId ?? "";
      const towards = (r.trainLineNm ?? "").split(" - ")[0] ?? "";
      const kind = r.btrainSttus && r.btrainSttus !== "일반" ? ` (${r.btrainSttus})` : "";
      return {
        line,
        direction: r.updnLine ?? "",
        towards: towards + kind,
        message: r.arvlMsg2 ?? "",
        currentAt: r.arvlMsg3 ?? "",
        etaSec: Number(r.barvlDt) > 0 ? Number(r.barvlDt) : null,
        lastTrain: r.lstcarAt === "1" ? true : undefined,
        order: r.ordkey ?? "",
        receivedAt: r.recptnDt ?? "",
      };
    })
    .sort((a, b) => (a.line + a.order < b.line + b.order ? -1 : 1));
  const first = rows[0];
  const summary = first ? `${station}역 ${first.line} ${first.towards} ${first.message}` : `${station}역 도착 정보`;
  return {
    summary,
    data: {
      station: `${station}역`,
      arrivals: rows.slice(0, 12).map(({ order: _o, ...r }) => r),
      note: "실시간 도착 정보는 수신 시각(receivedAt) 기준이라 1~2분 차이가 날 수 있어요.",
      source: "서울교통공사 실시간 도착정보",
    },
    card: {
      type: "results",
      title: `${station}역 실시간 도착`,
      source: "서울 열린데이터광장",
      items: rows.slice(0, 8).map((r) => ({
        title: `${r.line} ${r.towards}`,
        subtitle: r.message,
        meta: [r.direction, r.currentAt ? `현재 ${r.currentAt}` : ""].filter(Boolean).join(" · "),
        icon: "train" as const,
      })),
    },
  };
}

export const kSubwayArrival = defineSkill({
  name: "k_subway_arrival",
  description:
    "Real-time train arrivals at a Seoul metropolitan subway station (Seoul Open Data, via k-skill). Use for " +
    "'지하철 언제 와', '도착 정보'. `station` is the station name in Korean, with or without the trailing '역' (e.g. '강남', '서울역').",
  parameters: schema({ station: { type: "string", description: "Korean station name, e.g. '강남', '홍대입구', '서울역'" } }, ["station"]),
  icon: "train",
  title: (a) => `${stationName(str(a.station, 30)) || "역"}역 지하철 도착 확인`,
  meta: {
    source: "seoul-subway-arrival",
    title: "지하철 도착",
    description: "수도권 지하철역 실시간 열차 도착 정보를 알려줘요.",
    category: "교통",
    example: "강남역 지하철 언제 와?",
  },
  async run(a, rc) {
    const raw = str(a.station, 40);
    if (!raw) return failText("지하철: 역 이름을 알려주세요");
    const station = stationName(raw);
    const r = await proxyGet<SubwayResponse>("/v1/seoul-subway/arrival", { stationName: station }, rc.signal, { ttlMs: 20_000 });
    if (!r.ok) return fail(r.error, "지하철 도착");
    const built = buildSubway(station, r.body);
    if (!built) return failText(`지하철: ‘${station}’역 도착 정보를 찾지 못했어요 (수도권 역만 지원)`, "not_found");
    return { ok: true, ...built };
  },
});

// ───────────────────────────── 따릉이 ─────────────────────────────

export interface BikeNearbyResponse {
  count?: number;
  items?: {
    station_id?: string;
    station_name?: string;
    rack_total_count?: number | null;
    available_bikes?: number | null;
    empty_docks?: number | null;
    distance_m?: number | null;
  }[];
}

export function buildBike(place: string, body: BikeNearbyResponse, radius: number): { summary: string; data: Record<string, unknown>; card: ResultListCard } {
  const items = (body.items ?? []).map((s) => ({
    name: (s.station_name ?? "").replace(/^\d+\.\s*/, ""),
    bikes: s.available_bikes ?? null,
    emptyDocks: s.empty_docks ?? null,
    distanceM: s.distance_m ?? null,
  }));
  const total = items.reduce((acc, s) => acc + (s.bikes ?? 0), 0);
  const summary = items.length
    ? `${place} 근처 따릉이 대여소 ${items.length}곳 · 대여 가능 ${total}대`
    : `${place} 반경 ${meters(radius)} 안에 따릉이 대여소가 없어요`;
  return {
    summary,
    data: { place, radiusM: radius, stations: items, source: "서울 열린데이터광장 공공자전거 실시간" },
    card: {
      type: "results",
      title: `${place} 근처 따릉이`,
      source: "서울시 공공자전거",
      items: items.map((s) => ({
        title: s.name,
        subtitle: `대여 가능 ${s.bikes ?? "-"}대 · 빈 거치대 ${s.emptyDocks ?? "-"}`,
        meta: s.distanceM !== null ? meters(s.distanceM) : undefined,
        icon: "map" as const,
      })),
    },
  };
}

export const kSeoulBike = defineSkill({
  name: "k_seoul_bike",
  description:
    "Nearby Seoul public bike (따릉이) rental stations with live available bikes and empty docks (Seoul Open Data, via k-skill). " +
    "Seoul only. `place` is a Korean place name in Seoul (e.g. '광화문', '여의도역'); `radius` in metres (100-3000, default 1000).",
  parameters: schema(
    {
      place: { type: "string", description: "Korean place name in Seoul, e.g. '광화문', '성수역'" },
      radius: { type: "integer", minimum: 100, maximum: 3000, description: "search radius in metres, default 1000" },
    },
    ["place"],
  ),
  icon: "map",
  title: (a) => `${str(a.place, 30) || "근처"} 따릉이 찾기`,
  meta: {
    source: "seoul-bike",
    title: "따릉이",
    description: "서울 따릉이 대여소별 실시간 대여 가능 대수를 알려줘요.",
    category: "교통",
    example: "광화문 근처 따릉이 남은 거 있어?",
  },
  async run(a, rc) {
    const place = str(a.place, 60);
    if (!place) return failText("따릉이: 위치를 알려주세요");
    const radius = int(a.radius, 100, 3000, 1000);
    const g = await geocode(place, rc.signal);
    if (!g.ok) return g.error ? fail(g.error, "따릉이") : failText(`따릉이: ‘${place}’ 위치를 찾지 못했어요`, "not_found");
    const r = await proxyGet<BikeNearbyResponse>(
      "/v1/seoul-bike/nearby",
      { lat: g.loc.lat.toFixed(6), lon: g.loc.lon.toFixed(6), radius_m: radius, limit: 6 },
      rc.signal,
      { ttlMs: 30_000 },
    );
    if (!r.ok) return fail(r.error, "따릉이");
    return { ok: true, ...buildBike(place, r.body, radius) };
  },
});

// ───────────────────────────── 길찾기 (자동차) ─────────────────────────────

export interface DirectionsResponse {
  routes?: {
    result_code?: number;
    result_msg?: string;
    summary?: { distance?: number; duration?: number; fare?: { taxi?: number; toll?: number } };
    sections?: { roads?: { name?: string; distance?: number }[] }[];
  }[];
}

export function mainRoads(body: DirectionsResponse, limit = 4): string[] {
  const roads = body.routes?.[0]?.sections?.flatMap((s) => s.roads ?? []) ?? [];
  const order: string[] = [];
  const total = new Map<string, number>();
  for (const r of roads) {
    if (!r.name) continue;
    if (!total.has(r.name)) order.push(r.name);
    total.set(r.name, (total.get(r.name) ?? 0) + (r.distance ?? 0));
  }
  const top = new Set([...total.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([n]) => n));
  return order.filter((n) => top.has(n));
}

function mapLink(o: Located, d: Located): string {
  const seg = (l: Located) => `${encodeURIComponent(l.name)},${l.lat},${l.lon}`;
  return `https://map.kakao.com/link/from/${seg(o)}/to/${seg(d)}`;
}

export function buildDirections(o: Located, d: Located, body: DirectionsResponse): { summary: string; data: Record<string, unknown>; card: ResultListCard } | null {
  const route = body.routes?.[0];
  const s = route?.summary;
  if (!route || route.result_code !== 0 || !s || typeof s.distance !== "number" || typeof s.duration !== "number") return null;
  const roads = mainRoads(body);
  const taxi = s.fare?.taxi ?? null;
  const toll = s.fare?.toll ?? 0;
  const summary = `${o.query} → ${d.query} 차로 약 ${minutes(s.duration)} · ${meters(s.distance)}${taxi ? ` · 택시 약 ${wonKo(taxi)}` : ""}`;
  return {
    summary,
    data: {
      origin: { name: o.name, address: o.address },
      destination: { name: d.name, address: d.address },
      mode: "car (실시간 교통 반영 추천 경로)",
      distanceKm: Math.round(s.distance / 100) / 10,
      durationMin: Math.round(s.duration / 60),
      taxiFareWon: taxi,
      tollWon: toll,
      mainRoads: roads,
      mapUrl: mapLink(o, d),
      source: "카카오모빌리티",
    },
    card: {
      type: "results",
      title: `${o.query} → ${d.query}`,
      source: "카카오모빌리티",
      items: [
        { title: `약 ${minutes(s.duration)}`, subtitle: `${meters(s.distance)} · 자동차 추천 경로`, url: mapLink(o, d), icon: "map" },
        ...(taxi ? [{ title: `택시 약 ${wonKo(taxi)}`, subtitle: toll ? `통행료 ${wonKo(toll)}` : "통행료 없음", icon: "won" as const }] : []),
        ...(roads.length ? [{ title: "주요 경로", subtitle: roads.join(" → "), icon: "bus" as const }] : []),
      ],
    },
  };
}

export const kDirections = defineSkill({
  name: "k_directions",
  description:
    "Driving route between two places in South Korea (Kakao Mobility, via k-skill): live-traffic duration, distance, " +
    "estimated taxi fare and tolls, main roads. Use for '차로 얼마나 걸려', '택시비', '운전 경로'. Not for public transit. " +
    "`origin` and `destination` are Korean place names or addresses.",
  parameters: schema(
    {
      origin: { type: "string", description: "start, Korean place name or address, e.g. '강남역'" },
      destination: { type: "string", description: "end, Korean place name or address, e.g. '서울역'" },
    },
    ["origin", "destination"],
  ),
  icon: "map",
  title: (a) => `${str(a.origin, 20) || "출발지"} → ${str(a.destination, 20) || "도착지"} 길찾기`,
  meta: {
    source: "kakao-map",
    title: "길찾기",
    description: "카카오모빌리티로 자동차 소요 시간·거리·예상 택시비를 알려줘요.",
    category: "교통",
    example: "강남역에서 김포공항까지 택시 타면 얼마나 걸려?",
  },
  async run(a, rc) {
    const origin = str(a.origin, 60);
    const destination = str(a.destination, 60);
    if (!origin || !destination) return failText("길찾기: 출발지와 도착지를 알려주세요");
    rc.status("출발지·도착지 찾는 중");
    const [go, gd] = await Promise.all([geocode(origin, rc.signal), geocode(destination, rc.signal)]);
    if (!go.ok) return go.error ? fail(go.error, "길찾기") : failText(`길찾기: ‘${origin}’ 위치를 찾지 못했어요`, "not_found");
    if (!gd.ok) return gd.error ? fail(gd.error, "길찾기") : failText(`길찾기: ‘${destination}’ 위치를 찾지 못했어요`, "not_found");
    const o = go.loc;
    const d = gd.loc;
    rc.status("경로 계산 중");
    const r = await proxyGet<DirectionsResponse>(
      "/v1/kakao-mobility/directions",
      { origin: `${o.lon.toFixed(6)},${o.lat.toFixed(6)}`, destination: `${d.lon.toFixed(6)},${d.lat.toFixed(6)}` },
      rc.signal,
    );
    if (!r.ok) return fail(r.error, "길찾기");
    const built = buildDirections(o, d, r.body);
    if (!built) return failText("길찾기: 경로를 찾지 못했어요 (너무 가깝거나 도로로 갈 수 없는 곳일 수 있어요)", "no_route");
    return { ok: true, ...built };
  },
});
