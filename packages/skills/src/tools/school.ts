import type { ResultListCard } from "@pickle/protocol";
import { geocode } from "../geocode";
import { proxyGet } from "../http";
import { defineSkill, fail, failText, kst, mdDow, parseUserDate, schema, str } from "../util";

/** NEIS 시도교육청 codes. */
const OFFICES: { code: string; aliases: string[] }[] = [
  { code: "B10", aliases: ["서울"] },
  { code: "C10", aliases: ["부산"] },
  { code: "D10", aliases: ["대구"] },
  { code: "E10", aliases: ["인천"] },
  { code: "F10", aliases: ["광주"] },
  { code: "G10", aliases: ["대전"] },
  { code: "H10", aliases: ["울산"] },
  { code: "I10", aliases: ["세종"] },
  { code: "J10", aliases: ["경기"] },
  { code: "K10", aliases: ["강원"] },
  { code: "M10", aliases: ["충북", "충청북"] },
  { code: "N10", aliases: ["충남", "충청남"] },
  { code: "P10", aliases: ["전북", "전라북"] },
  { code: "Q10", aliases: ["전남", "전라남"] },
  { code: "R10", aliases: ["경북", "경상북"] },
  { code: "S10", aliases: ["경남", "경상남"] },
  { code: "T10", aliases: ["제주"] },
];

export function officeCode(text: string): string | undefined {
  const t = text.replace(/\s+/g, "");
  if (/^[B-T]10$/.test(t)) return t;
  return OFFICES.find((o) => o.aliases.some((a) => t.startsWith(a)))?.code;
}

interface SchoolRow {
  ATPT_OFCDC_SC_CODE?: string;
  SD_SCHUL_CODE?: string;
  SCHUL_NM?: string;
  SCHUL_KND_SC_NM?: string;
  ORG_RDNMA?: string;
}
export interface SchoolSearchResponse {
  schoolInfo?: [unknown, { row?: SchoolRow[] }?];
  RESULT?: { CODE?: string; MESSAGE?: string };
}
export interface MealResponse {
  mealServiceDietInfo?: [unknown, { row?: { MMEAL_SC_NM?: string; MLSV_YMD?: string; DDISH_NM?: string; CAL_INFO?: string }[] }?];
  RESULT?: { CODE?: string; MESSAGE?: string };
}

/** "쌀국수 (2.5.6.12.13.15.16)" → { name: "쌀국수", allergens: [2,5,6,12,13,15,16] } */
export function parseDishes(ddish: string): { name: string; allergens: number[] }[] {
  return ddish
    .split(/<br\s*\/?>/i)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const m = /\s*\(([\d.]+)\)\s*$/.exec(s);
      const allergens = m ? (m[1] ?? "").split(".").filter(Boolean).map(Number) : [];
      return { name: (m ? s.slice(0, m.index) : s).replace(/\*+$/, "").trim(), allergens };
    })
    .filter((d) => d.name);
}

export function buildMeal(school: string, ymd: string, body: MealResponse): { summary: string; data: Record<string, unknown>; card: ResultListCard } | null {
  const rows = body.mealServiceDietInfo?.[1]?.row ?? [];
  if (rows.length === 0) return null;
  const meals = rows.map((r) => ({ kind: r.MMEAL_SC_NM ?? "", calories: r.CAL_INFO ?? "", dishes: parseDishes(r.DDISH_NM ?? "") }));
  const lunch = meals.find((m) => m.kind === "중식") ?? meals[0]!;
  return {
    summary: `${school} ${mdDow(ymd)} ${lunch.kind}: ${lunch.dishes.slice(0, 4).map((d) => d.name).join(", ")}`,
    data: {
      school,
      date: mdDow(ymd),
      meals,
      allergenLegend: "1난류 2우유 3메밀 4땅콩 5대두 6밀 7고등어 8게 9새우 10돼지고기 11복숭아 12토마토 13아황산류 14호두 15닭고기 16쇠고기 17오징어 18조개류 19잣",
      source: "NEIS 학교급식",
    },
    card: {
      type: "results",
      title: `${school} ${mdDow(ymd)} 급식`,
      source: "NEIS",
      items: meals.map((m) => ({ title: `${m.kind}${m.calories ? ` · ${m.calories}` : ""}`, subtitle: m.dishes.map((d) => d.name).join(" · "), icon: "star" as const })),
    },
  };
}

export const kSchoolLunch = defineSkill({
  name: "k_school_lunch",
  description:
    "School meal menu (급식) for a Korean elementary/middle/high school on a date, from NEIS via k-skill, with allergen numbers. " +
    "`school` is the full school name (e.g. '서울고등학교', '미래초등학교'); `region` 시/도 helps find the right education office " +
    "(e.g. '서울', '경기'; resolved automatically from the map when omitted); `date` YYYYMMDD or '오늘'/'내일' (default today).",
  parameters: schema(
    {
      school: { type: "string", description: "full school name, e.g. '서울고등학교'" },
      region: { type: "string", description: "시/도 of the school, e.g. '서울', '경기'" },
      date: { type: "string", description: "YYYYMMDD, '오늘' or '내일' (default today)" },
    },
    ["school"],
  ),
  icon: "star",
  title: (a) => `${str(a.school, 20)} 급식 확인`,
  meta: {
    source: "k-schoollunch-menu",
    title: "학교 급식",
    description: "NEIS로 학교 급식 메뉴와 알레르기 정보를 알려줘요.",
    category: "생활",
    example: "내일 서울고등학교 급식 뭐야?",
  },
  async run(a, rc) {
    const school = str(a.school, 40);
    if (!school) return failText("급식: 학교 이름을 알려주세요");
    const today = kst(rc.now).ymd;
    const ymd = parseUserDate(a.date, today);
    if (!ymd) return failText("급식: 날짜는 YYYYMMDD 형식으로 알려주세요");
    rc.status("학교 찾는 중");
    const search = (office: string) =>
      proxyGet<SchoolSearchResponse>("/v1/neis/school-search", { educationOffice: office, schoolName: school, pSize: 5 }, rc.signal);
    // 1) explicit region, else a 시/도 prefix in the school name ("서울고등학교")
    const first = officeCode(str(a.region, 20)) ?? officeCode(school);
    let rows: SchoolRow[] = [];
    if (first) {
      const s = await search(first);
      if (!s.ok && s.error.kind !== "not_found") return fail(s.error, "급식");
      rows = s.ok ? (s.body.schoolInfo?.[1]?.row ?? []) : [];
    }
    // 2) not found (e.g. 경기고등학교 is in Seoul): locate the school on the map and use its 시/도
    if (rows.length === 0) {
      const g = await geocode(school, rc.signal);
      const second = g.ok && g.loc.via === "kakao" ? officeCode(g.loc.address) : undefined;
      if (!first && !second) return failText(`급식: ‘${school}’이 어느 시·도 학교인지 알려주세요`, "need_region");
      if (second && second !== first) {
        const s = await search(second);
        if (!s.ok && s.error.kind !== "not_found") return fail(s.error, "급식");
        rows = s.ok ? (s.body.schoolInfo?.[1]?.row ?? []) : [];
      }
    }
    const pick = rows.find((r) => r.SCHUL_NM === school) ?? rows[0];
    if (!pick?.SD_SCHUL_CODE || !pick.ATPT_OFCDC_SC_CODE) return failText(`급식: ‘${school}’ 학교를 찾지 못했어요`, "not_found");
    const name = pick.SCHUL_NM ?? school;
    const m = await proxyGet<MealResponse>(
      "/v1/neis/school-meal",
      { educationOfficeCode: pick.ATPT_OFCDC_SC_CODE, schoolCode: pick.SD_SCHUL_CODE, mealDate: ymd },
      rc.signal,
    );
    if (!m.ok) return fail(m.error, "급식");
    const built = buildMeal(name, ymd, m.body);
    if (!built) {
      return {
        ok: true,
        summary: `${name} ${mdDow(ymd)} 급식 정보가 없어요 (주말·방학·재량휴업일일 수 있어요)`,
        data: { school: name, date: mdDow(ymd), meals: [], source: "NEIS 학교급식" },
      };
    }
    if (rows.length > 1 && pick.SCHUL_NM !== school) built.data.otherSchools = rows.slice(0, 5).map((r) => r.SCHUL_NM);
    return { ok: true, ...built };
  },
});
