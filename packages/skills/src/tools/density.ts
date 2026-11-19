import type { ResultListCard } from "@pickle/protocol";
import { proxyGet } from "../http";
import { defineSkill, fail, failText, num, schema, str } from "../util";

/** Seoul real-time city data hotspots (official AREA_NM values of the 서울 실시간 도시데이터 API). */
export const SEOUL_HOTSPOTS: readonly string[] = [
  // 고궁·문화유산
  "경복궁", "광화문·덕수궁", "보신각", "서울 암사동 유적", "창덕궁·종묘",
  // 관광특구
  "강남 MICE 관광특구", "동대문 관광특구", "명동 관광특구", "이태원 관광특구", "잠실 관광특구", "종로·청계 관광특구", "홍대 관광특구",
  // 공원
  "강서한강공원", "고척돔", "광나루한강공원", "광화문광장", "국립중앙박물관·용산가족공원", "난지한강공원", "남산공원", "노들섬",
  "뚝섬한강공원", "망원한강공원", "반포한강공원", "보라매공원", "북서울꿈의숲", "서대문독립공원", "서리풀공원·몽마르뜨공원", "서울대공원",
  "서울숲공원", "송현녹지광장", "아차산", "안양천", "양화한강공원", "어린이대공원", "여의도한강공원", "여의서로", "올림픽공원", "월드컵공원",
  "응봉산", "이촌한강공원", "잠실종합운동장", "잠실한강공원", "잠원한강공원", "청계산", "홍제폭포",
  // 발달상권
  "가락시장", "가로수길", "광장(전통)시장", "김포공항", "남대문시장", "노량진", "덕수궁길·정동길", "북창동 먹자골목", "북촌한옥마을", "서촌",
  "성수카페거리", "송리단길·호수단길", "신촌 스타광장", "압구정로데오거리", "여의도", "연남동", "영등포 타임스퀘어", "용리단길",
  "이태원 앤틱가구거리", "익선동", "인사동", "잠실롯데타워·석촌호수", "창동 신경제 중심지", "청담동 명품거리", "청량리 제기동 일대 전통시장",
  "해방촌·경리단길", "DDP(동대문디자인플라자)", "DMC(디지털미디어시티)",
  // 인구밀집지역
  "가산디지털단지역", "강남역", "건대입구역", "고덕역", "고속터미널역", "교대역", "구로디지털단지역", "구로역", "군자역", "대림역", "동대문역",
  "뚝섬역", "미아사거리역", "발산역", "사당역", "삼각지역", "서울대입구역", "서울식물원·마곡나루역", "서울역", "성신여대입구역", "선릉역",
  "시의회 앞", "수유역", "신논현역·논현역", "신도림역", "신림역", "신촌·이대역", "쌍문역", "신정네거리역", "역삼역", "연신내역", "양재역",
  "왕십리역", "용산역", "오목교역·목동운동장", "잠실새내역", "잠실역", "장지역", "장한평역", "천호역", "총신대입구(이수)역", "충정로역",
  "합정역", "혜화역", "홍대입구역(2호선)", "회기역",
];

const SUFFIXES = ["관광특구", "한강공원", "공원", "시장", "거리", "광장", "역"];

function norm(s: string): string {
  let t = s.replace(/\s+/g, "").replace(/\(.*?\)/g, "").toLowerCase();
  for (const suf of SUFFIXES) if (t.endsWith(suf) && t.length > suf.length) t = t.slice(0, -suf.length);
  return t;
}

/** User text → official hotspot names (best first). "성수" → ["성수카페거리"], "홍대" → ["홍대 관광특구"]. */
export function matchHotspot(input: string): string[] {
  const raw = input.trim();
  if (SEOUL_HOTSPOTS.includes(raw)) return [raw];
  const q = norm(raw);
  if (!q) return [];
  const exact = SEOUL_HOTSPOTS.filter((a) => norm(a) === q || a.split("·").some((p) => norm(p) === q));
  if (exact.length) return exact;
  // the query is part of a hotspot name ("성수" → 성수카페거리): shortest name first
  const within = SEOUL_HOTSPOTS.filter((a) => norm(a).includes(q)).sort((a, b) => norm(a).length - norm(b).length);
  // a hotspot name is part of the query ("서울숲 카페" → 서울숲공원): longest (most specific) name first
  const contains = SEOUL_HOTSPOTS.filter((a) => !within.includes(a) && norm(a).length >= 2 && q.includes(norm(a))).sort(
    (a, b) => norm(b).length - norm(a).length,
  );
  return [...within, ...contains];
}

export interface CityDataResponse {
  "SeoulRtd.citydata_ppltn"?: {
    AREA_NM?: string;
    AREA_CONGEST_LVL?: string;
    AREA_CONGEST_MSG?: string;
    AREA_PPLTN_MIN?: string;
    AREA_PPLTN_MAX?: string;
    PPLTN_TIME?: string;
    FCST_PPLTN?: { FCST_TIME?: string; FCST_CONGEST_LVL?: string; FCST_PPLTN_MIN?: string; FCST_PPLTN_MAX?: string }[];
  }[];
  RESULT?: { "RESULT.CODE"?: string; "RESULT.MESSAGE"?: string };
}

function people(min: number | null, max: number | null): string {
  if (min === null || max === null) return "-";
  const f = (n: number) => (n >= 10000 ? `${(n / 10000).toFixed(n % 10000 ? 1 : 0)}만` : n.toLocaleString("en-US"));
  return `${f(min)}~${f(max)}명`;
}

export function buildDensity(body: CityDataResponse): { summary: string; data: Record<string, unknown>; card: ResultListCard } | null {
  const row = body["SeoulRtd.citydata_ppltn"]?.[0];
  if (!row?.AREA_NM || !row.AREA_CONGEST_LVL) return null;
  const min = num(row.AREA_PPLTN_MIN);
  const max = num(row.AREA_PPLTN_MAX);
  const forecast = (row.FCST_PPLTN ?? []).slice(0, 6).map((f) => ({
    time: (f.FCST_TIME ?? "").slice(11, 16),
    level: f.FCST_CONGEST_LVL ?? "",
    people: people(num(f.FCST_PPLTN_MIN), num(f.FCST_PPLTN_MAX)),
  }));
  return {
    summary: `${row.AREA_NM} 지금 ${row.AREA_CONGEST_LVL} · 약 ${people(min, max)}`,
    data: {
      area: row.AREA_NM,
      level: row.AREA_CONGEST_LVL,
      people: people(min, max),
      message: row.AREA_CONGEST_MSG,
      asOf: row.PPLTN_TIME,
      forecast,
      note: "통신사 신호 기반 추정치로 약 15분 전 값이에요. 단계: 여유 < 보통 < 약간 붐빔 < 붐빔.",
      source: "서울 실시간 도시데이터",
    },
    card: {
      type: "results",
      title: `${row.AREA_NM} 혼잡도`,
      source: "서울 실시간 도시데이터",
      items: [
        { title: `지금 ${row.AREA_CONGEST_LVL}`, subtitle: `약 ${people(min, max)}`, meta: row.PPLTN_TIME?.slice(11), icon: "people" },
        ...forecast.slice(0, 4).map((f) => ({ title: `${f.time} ${f.level}`, subtitle: `예상 ${f.people}`, icon: "clock" as const })),
      ],
    },
  };
}

export const kSeoulDensity = defineSkill({
  name: "k_seoul_density",
  description:
    "Real-time crowd level (여유/보통/약간 붐빔/붐빔), estimated head count and next-hours forecast for ~120 Seoul hotspots " +
    "(stations, parks, shopping streets, palaces), from Seoul real-time city data via k-skill. Use for '지금 사람 많아?', '붐벼?'. " +
    "`place` is a Seoul hotspot in Korean (e.g. '강남역', '성수카페거리', '여의도한강공원', '홍대').",
  parameters: schema({ place: { type: "string", description: "Seoul hotspot, e.g. '강남역', '성수', '명동', '여의도한강공원'" } }, ["place"]),
  icon: "people",
  title: (a) => `${str(a.place, 20) || "서울"} 혼잡도 확인`,
  meta: {
    source: "seoul-density",
    title: "서울 혼잡도",
    description: "서울 주요 120여 곳의 실시간 혼잡도와 몇 시간 뒤 예측을 알려줘요.",
    category: "생활",
    example: "지금 성수 카페거리 사람 많아?",
  },
  async run(a, rc) {
    const place = str(a.place, 40);
    if (!place) return failText("혼잡도: 서울의 어느 곳인지 알려주세요");
    const matches = matchHotspot(place);
    if (matches.length === 0) {
      return failText(`혼잡도: ‘${place}’은 서울 실시간 도시데이터 지원 장소가 아니에요`, "unsupported_area", {
        examples: ["강남역", "홍대 관광특구", "성수카페거리", "여의도한강공원", "명동 관광특구"],
      });
    }
    const area = matches[0]!;
    const r = await proxyGet<CityDataResponse>("/v1/seoul-density/citydata", { area }, rc.signal, { ttlMs: 60_000 });
    if (!r.ok) return fail(r.error, "혼잡도");
    const code = r.body.RESULT?.["RESULT.CODE"];
    if (code && code !== "INFO-000") return failText(`혼잡도: 도시데이터 응답 오류 (${r.body.RESULT?.["RESULT.MESSAGE"] ?? code})`, "upstream");
    const built = buildDensity(r.body);
    if (!built) return failText(`혼잡도: ‘${area}’ 데이터가 비어 있어요`, "empty");
    if (matches.length > 1) built.data.otherAreas = matches.slice(1, 4);
    return { ok: true, ...built };
  },
});
