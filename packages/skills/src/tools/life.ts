import type { ResultListCard } from "@pickle/protocol";
import { wgs84ToKatec } from "../geo";
import { geocode } from "../geocode";
import { proxyGet, proxyGetText } from "../http";
import { dayDiff, defineSkill, fail, failText, int, kst, mdDow, meters, num, optInt, schema, str, weekday, won, xmlBlocks, xmlText } from "../util";

// ───────────────────────────── 주유소 가격 (Opinet) ─────────────────────────────

const FUEL: Record<string, { code: string; label: string }> = {
  gasoline: { code: "B027", label: "휘발유" },
  premium: { code: "B034", label: "고급휘발유" },
  diesel: { code: "D047", label: "경유" },
  lpg: { code: "K015", label: "LPG" },
};
const BRANDS: Record<string, string> = {
  SKE: "SK에너지",
  GSC: "GS칼텍스",
  HDO: "HD현대오일뱅크",
  SOL: "S-OIL",
  RTE: "자영알뜰",
  RTX: "고속도로알뜰",
  NHO: "농협알뜰",
  ETC: "자가상표",
  E1G: "E1",
  SKG: "SK가스",
};

export interface OpinetAroundResponse {
  RESULT?: { OIL?: { UNI_ID?: string; POLL_DIV_CO?: string; POLL_DIV_CD?: string; OS_NM?: string; PRICE?: string | number; DISTANCE?: string | number }[] };
}

export function buildGas(place: string, fuelKey: string, radius: number, body: OpinetAroundResponse): { summary: string; data: Record<string, unknown>; card: ResultListCard } {
  const fuel = FUEL[fuelKey] ?? FUEL.gasoline!;
  const stations = (body.RESULT?.OIL ?? [])
    .map((s) => ({
      id: s.UNI_ID ?? "",
      name: s.OS_NM ?? "",
      brand: BRANDS[s.POLL_DIV_CO ?? s.POLL_DIV_CD ?? ""] ?? s.POLL_DIV_CO ?? s.POLL_DIV_CD ?? "",
      price: num(s.PRICE),
      distanceM: num(s.DISTANCE),
    }))
    .filter((s) => s.name && s.price !== null && s.price > 0)
    .sort((a, b) => (a.price ?? 0) - (b.price ?? 0) || (a.distanceM ?? 0) - (b.distanceM ?? 0))
    .slice(0, 8);
  const cheapest = stations[0];
  const summary = cheapest
    ? `${place} 근처 ${fuel.label} 최저 ${won(cheapest.price ?? 0)}/L · ${cheapest.name}`
    : `${place} 반경 ${meters(radius)} 안 ${fuel.label} 가격 정보가 없어요 (오피넷 갱신 중일 수 있어요)`;
  return {
    summary,
    data: { place, fuel: fuel.label, radiusM: radius, stations, unit: "원/L", source: "오피넷(한국석유공사)" },
    card: {
      type: "results",
      title: `${place} 근처 ${fuel.label} 가격`,
      source: "오피넷",
      items: stations.map((s) => ({
        title: s.name,
        subtitle: `${won(s.price ?? 0)}/L${s.brand ? ` · ${s.brand}` : ""}`,
        meta: s.distanceM !== null ? meters(s.distanceM) : undefined,
        icon: "won" as const,
      })),
    },
  };
}

export const kGasPrices = defineSkill({
  name: "k_gas_prices",
  description:
    "Cheapest gas stations near a place in South Korea with live prices per litre (Opinet / Korea National Oil Corp., via k-skill). " +
    "`place` is a Korean place name; `fuel` is gasoline (default), premium, diesel or lpg; `radius` metres 500-5000 (default 3000). " +
    "Results are sorted by price.",
  parameters: schema(
    {
      place: { type: "string", description: "Korean place name, e.g. '서울역', '판교'" },
      fuel: { type: "string", enum: ["gasoline", "premium", "diesel", "lpg"], description: "fuel type, default gasoline" },
      radius: { type: "integer", minimum: 500, maximum: 5000, description: "radius in metres, default 3000" },
    },
    ["place"],
  ),
  icon: "won",
  title: (a) => `${str(a.place, 30) || "근처"} 주유소 가격 확인`,
  meta: {
    source: "cheap-gas-nearby",
    title: "주유소 가격",
    description: "오피넷 실시간 가격으로 근처 가장 싼 주유소를 찾아줘요.",
    category: "생활",
    example: "판교 근처 제일 싼 주유소 어디야?",
  },
  async run(a, rc) {
    const place = str(a.place, 60);
    if (!place) return failText("주유소: 위치를 알려주세요");
    const fuelKey = typeof a.fuel === "string" && FUEL[a.fuel] ? a.fuel : "gasoline";
    const radius = int(a.radius, 500, 5000, 3000);
    const g = await geocode(place, rc.signal);
    if (!g.ok) return g.error ? fail(g.error, "주유소") : failText(`주유소: ‘${place}’ 위치를 찾지 못했어요`, "not_found");
    const k = wgs84ToKatec(g.loc.lat, g.loc.lon);
    rc.status("오피넷 가격 조회 중");
    const r = await proxyGet<OpinetAroundResponse>(
      "/v1/opinet/around",
      { x: Math.round(k.x), y: Math.round(k.y), radius, prodcd: FUEL[fuelKey]!.code, sort: 1 },
      rc.signal,
    );
    if (!r.ok) return fail(r.error, "주유소");
    return { ok: true, ...buildGas(place, fuelKey, radius, r.body) };
  },
});

// ───────────────────────────── 공휴일 ─────────────────────────────

export interface Holiday {
  date: string; // YYYYMMDD
  name: string;
  isHoliday: boolean;
}

export function parseHolidaysXml(xml: string): Holiday[] {
  return xmlBlocks(xml, "item")
    .map((it) => ({ date: xmlText(it, "locdate"), name: xmlText(it, "dateName"), isHoliday: xmlText(it, "isHoliday") === "Y" }))
    .filter((h) => /^\d{8}$/.test(h.date) && h.name)
    .sort((a, b) => (a.date < b.date ? -1 : 1));
}

export function buildHolidays(list: Holiday[], today: string, label: string): { summary: string; data: Record<string, unknown>; card: ResultListCard } {
  const upcoming = list.filter((h) => h.date >= today);
  const next = upcoming[0];
  const summary = next
    ? `${label} 공휴일 ${list.length}일 · 다음은 ${mdDow(next.date)} ${next.name}${dayDiff(today, next.date) > 0 ? ` (D-${dayDiff(today, next.date)})` : " (오늘)"}`
    : `${label} 공휴일 ${list.length}일 · 남은 공휴일 없음`;
  return {
    summary,
    data: {
      period: label,
      holidays: list.map((h) => ({ date: `${h.date.slice(0, 4)}-${h.date.slice(4, 6)}-${h.date.slice(6)}`, weekday: weekday(h.date), name: h.name })),
      next: next ? { date: mdDow(next.date), name: next.name, inDays: dayDiff(today, next.date) } : null,
      source: "한국천문연구원 특일정보",
    },
    card: {
      type: "results",
      title: `${label} 공휴일`,
      source: "한국천문연구원",
      items: list.map((h) => {
        const d = dayDiff(today, h.date);
        return { title: h.name, subtitle: `${h.date.slice(0, 4)}. ${mdDow(h.date)}`, meta: d > 0 ? `D-${d}` : d === 0 ? "오늘" : "지남", icon: "calendar" as const };
      }),
    },
  };
}

export const kHolidays = defineSkill({
  name: "k_holidays",
  description:
    "Korean public holidays (법정 공휴일, incl. substitute holidays) for a year or month, from KASI via k-skill. " +
    "Use for '다음 공휴일', '연휴', '빨간 날'. `year` (default current year), `month` 1-12 optional.",
  parameters: schema({
    year: { type: "integer", minimum: 2004, maximum: 2030, description: "year, default this year" },
    month: { type: "integer", minimum: 1, maximum: 12, description: "optional month 1-12" },
  }),
  icon: "calendar",
  title: (a) => `${optInt(a.year, 2004, 2030) ?? ""}${a.month ? ` ${optInt(a.month, 1, 12)}월` : ""} 공휴일 확인`.trim(),
  meta: {
    source: "korean-holiday-calendar",
    title: "공휴일",
    description: "올해·이번 달 공휴일과 대체공휴일, 다음 연휴까지 남은 날을 알려줘요.",
    category: "생활",
    example: "다음 빨간 날 언제야?",
  },
  async run(a, rc) {
    const t = kst(rc.now);
    const year = optInt(a.year, 2004, 2030) ?? t.y;
    const month = optInt(a.month, 1, 12);
    const r = await proxyGetText(
      "/v1/korean-holiday/calendar",
      { year, month: month ? String(month).padStart(2, "0") : undefined, operation: "rest" },
      rc.signal,
    );
    if (!r.ok) return fail(r.error, "공휴일");
    const code = xmlText(r.body, "resultCode");
    if (code && code !== "00") return failText(`공휴일: 특일정보 응답 오류 (${xmlText(r.body, "resultMsg") || code})`, "upstream");
    const list = parseHolidaysXml(r.body).filter((h) => h.isHoliday);
    const label = month ? `${year}년 ${month}월` : `${year}년`;
    return { ok: true, ...buildHolidays(list, t.ymd, label) };
  },
});

// ───────────────────────────── 해외 여행경보 ─────────────────────────────

const ALARM: Record<number, string> = { 1: "1단계 여행유의", 2: "2단계 여행자제", 3: "3단계 출국권고", 4: "4단계 여행금지" };

export interface MofaResponse {
  items?: { alarm_lvl?: number | null; country_nm?: string; country_eng_nm?: string; country_iso_alp2?: string; region_ty?: string | null; remark?: string | null; written_dt?: string | null }[];
  total_count?: number;
}

export function buildTravel(country: string, body: MofaResponse): { summary: string; data: Record<string, unknown>; card: ResultListCard } {
  const alerts = (body.items ?? []).map((i) => ({
    level: i.alarm_lvl ?? null,
    label: i.alarm_lvl ? (ALARM[i.alarm_lvl] ?? `${i.alarm_lvl}단계`) : "경보 없음",
    scope: i.region_ty === "전체" ? "전 지역" : i.region_ty === "일부" ? "일부 지역" : (i.region_ty ?? ""),
    regions: (i.remark ?? "").trim(),
    country: i.country_nm ?? country,
  }));
  const name = alerts[0]?.country ?? country;
  const top = alerts.reduce<(typeof alerts)[number] | null>((m, x) => (m === null || (x.level ?? 0) > (m.level ?? 0) ? x : m), null);
  const summary = top
    ? `${name}: ${top.scope ? `${top.scope} ` : ""}${top.label}${top.regions ? ` — ${top.regions.slice(0, 40)}` : ""}`
    : `${name}: 외교부 여행경보 목록에 없어요 (발령된 경보가 없거나 나라 이름이 다를 수 있어요)`;
  return {
    summary,
    data: {
      country: name,
      found: alerts.length > 0,
      alerts,
      note: alerts.length
        ? "현지 안전 공지는 해외안전여행(0404.go.kr)에서 함께 확인하세요."
        : "목록에 없으면 발령된 경보가 없거나 국가명이 외교부 표기와 다른 경우예요(예: 영국, 미국, 베트남). 단정하지 말고 0404.go.kr 확인을 권하세요.",
      source: "외교부 해외안전여행",
    },
    card: {
      type: "results",
      title: `${name} 여행경보`,
      source: "외교부 해외안전여행",
      items: alerts.length
        ? alerts.map((x) => ({ title: x.label, subtitle: x.regions || x.scope, meta: x.scope, url: "https://www.0404.go.kr", icon: "plane" as const }))
        : [{ title: "여행경보 목록에 없음", subtitle: "경보가 없거나 나라 이름이 다를 수 있어요. 해외안전여행 사이트에서 확인하세요", url: "https://www.0404.go.kr", icon: "plane" as const }],
    },
  };
}

export const kTravelSafety = defineSkill({
  name: "k_travel_safety",
  description:
    "Korean Ministry of Foreign Affairs travel alert level for a country (1 여행유의 … 4 여행금지, with affected regions), via k-skill. " +
    "Use before overseas trips: '일본 여행 괜찮아?', '태국 여행경보'. `country` is the country name in Korean (e.g. '일본', '태국') " +
    "or an ISO alpha-2 code (e.g. 'JP').",
  parameters: schema({ country: { type: "string", description: "country in Korean (e.g. '일본') or ISO alpha-2 (e.g. 'JP')" } }, ["country"]),
  icon: "plane",
  title: (a) => `${str(a.country, 20)} 여행경보 확인`,
  meta: {
    source: "mofa-travel-safety",
    title: "해외 여행경보",
    description: "외교부 여행경보 단계와 위험 지역을 알려줘요.",
    category: "여행",
    example: "다음 달 태국 가는데 여행경보 있어?",
  },
  async run(a, rc) {
    const country = str(a.country, 40);
    if (!country) return failText("여행경보: 나라 이름을 알려주세요");
    const ISO_ALIAS: Record<string, string> = { UK: "GB", EN: "GB" };
    const isoRaw = /^[A-Za-z]{2}$/.test(country) ? country.toUpperCase() : undefined;
    const iso = isoRaw ? (ISO_ALIAS[isoRaw] ?? isoRaw) : undefined;
    const r = await proxyGet<MofaResponse>(
      "/v1/mofa-travel-safety/travel-alerts",
      iso ? { countryIsoAlp2: iso, perPage: 20 } : { countryNm: country, perPage: 20 },
      rc.signal,
    );
    if (!r.ok) return fail(r.error, "여행경보");
    return { ok: true, ...buildTravel(country, r.body) };
  },
});

// ───────────────────────────── 한강 수위 ─────────────────────────────

export interface HanRiverResponse {
  station_code?: string;
  station_name?: string;
  address?: string;
  observed_at?: string;
  water_level?: { value_m?: number | null };
  flow_rate?: { value_cms?: number | null };
  thresholds?: { interest_level_m?: number | null; warning_level_m?: number | null; alarm_level_m?: number | null; serious_level_m?: number | null };
}

export function riverStatus(level: number | null, t: HanRiverResponse["thresholds"]): string {
  if (level === null || !t) return "정보 없음";
  if (t.serious_level_m && level >= t.serious_level_m) return "홍수경보 수준 (심각)";
  if (t.alarm_level_m && level >= t.alarm_level_m) return "홍수경보 수준";
  if (t.warning_level_m && level >= t.warning_level_m) return "홍수주의보 수준";
  if (t.interest_level_m && level >= t.interest_level_m) return "관심 단계";
  return "평상시";
}

export function buildRiver(body: HanRiverResponse): { summary: string; data: Record<string, unknown>; card: ResultListCard } {
  const level = typeof body.water_level?.value_m === "number" ? body.water_level.value_m : null;
  const flow = typeof body.flow_rate?.value_cms === "number" ? body.flow_rate.value_cms : null;
  const status = riverStatus(level, body.thresholds);
  const at = body.observed_at ? body.observed_at.replace("T", " ").slice(0, 16) : undefined;
  const name = body.station_name ?? "";
  return {
    summary: `${name} 수위 ${level ?? "-"}m · ${status}`,
    data: {
      station: name,
      code: body.station_code,
      observedAt: at,
      waterLevelM: level,
      flowCms: flow,
      status,
      thresholdsM: body.thresholds,
      source: "한강홍수통제소",
    },
    card: {
      type: "results",
      title: `${name} 수위`,
      source: "한강홍수통제소",
      items: [
        { title: `수위 ${level ?? "-"}m`, subtitle: status, meta: at, icon: "wave" },
        ...(flow !== null ? [{ title: `유량 ${flow.toLocaleString("en-US")}㎥/s`, subtitle: body.address ?? "", icon: "wave" as const }] : []),
        ...(body.thresholds?.interest_level_m
          ? [{ title: "기준 수위", subtitle: `관심 ${body.thresholds.interest_level_m}m · 주의보 ${body.thresholds.warning_level_m ?? "-"}m · 경보 ${body.thresholds.alarm_level_m ?? "-"}m`, icon: "shield" as const }]
          : []),
      ],
    },
  };
}

export const kHanRiver = defineSkill({
  name: "k_han_river",
  description:
    "Latest Han River (and tributary) water level and flow at a gauge station from the Han River Flood Control Office, via k-skill, " +
    "with the flood-threshold status. Use for heavy rain / flooding questions. `station` is a bridge or gauge name " +
    "(e.g. '한강대교', '잠수교', '팔당댐'; default '한강대교').",
  parameters: schema({ station: { type: "string", description: "gauge/bridge name, e.g. '한강대교', '잠수교'. default 한강대교" } }),
  icon: "wave",
  title: (a) => `${str(a.station, 20) || "한강대교"} 수위 확인`,
  meta: {
    source: "han-river-water-level",
    title: "한강 수위",
    description: "한강홍수통제소 관측소의 실시간 수위·유량과 홍수 기준 대비 상태를 알려줘요.",
    category: "생활",
    example: "비 많이 오는데 잠수교 수위 괜찮아?",
  },
  async run(a, rc) {
    const station = str(a.station, 30) || "한강대교";
    let r = await proxyGet<HanRiverResponse>("/v1/han-river/water-level", { stationName: station }, rc.signal);
    let picked: string | undefined;
    if (!r.ok && r.error.code === "ambiguous_station") {
      const cands = r.error.body?.candidate_stations;
      const first = Array.isArray(cands) && typeof cands[0] === "string" ? cands[0] : undefined;
      if (first) {
        picked = first;
        r = await proxyGet<HanRiverResponse>("/v1/han-river/water-level", { stationName: first }, rc.signal);
      }
    }
    if (!r.ok) {
      if (r.error.kind === "not_found" || r.error.kind === "bad_request") return fail(r.error, "한강 수위", `한강 수위: ‘${station}’ 관측소를 찾지 못했어요`);
      return fail(r.error, "한강 수위");
    }
    const built = buildRiver(r.body);
    if (picked) built.data.note = `‘${station}’과 일치하는 관측소가 여러 곳이라 ${picked} 기준으로 보여드려요`;
    return { ok: true, ...built };
  },
});
