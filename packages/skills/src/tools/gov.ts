import type { ResultListCard } from "@pickle/protocol";
import { proxyGet } from "../http";
import { cleanText, dayDiff, defineSkill, fail, failText, kst, optInt, schema, str, toYmd } from "../util";
import { REGION_HINT, sidoOf } from "./culture";

// ───────────────────────────── 정부 지원사업 ─────────────────────────────

export interface KstartupResponse {
  totalCount?: number;
  data?: {
    pbanc_sn?: number;
    biz_pbanc_nm?: string;
    pbanc_rcpt_bgng_dt?: string;
    pbanc_rcpt_end_dt?: string;
    rcrt_prgs_yn?: string;
    supt_regin?: string;
    aply_trgt?: string;
    aply_trgt_ctnt?: string;
    biz_enyy?: string;
    biz_trgt_age?: string;
    supt_biz_clsfc?: string;
    pbanc_ntrp_nm?: string;
    detl_pg_url?: string;
  }[];
}
export interface SurveyResponse {
  complete?: boolean;
  sources?: Record<string, { ok?: boolean; error?: string | null }>;
  items?: { source?: string; id?: string; title?: string; field?: string; org?: string; apply_start?: string; apply_end?: string; url?: string }[];
}

const SOURCE_LABEL: Record<string, string> = {
  kstartup: "K-Startup",
  bizinfo: "기업마당",
  nipa: "정보통신산업진흥원",
  kocca: "한국콘텐츠진흥원",
  smtech: "중소기업기술정보진흥원",
};

export interface Programme {
  title: string;
  org: string;
  field: string;
  source: string;
  start: string; // YYYYMMDD or ""
  end: string; // YYYYMMDD or ""
  region: string;
  target: string;
  ages: string;
  url?: string;
}

/** "만 20세 이상 ~ 만 39세 이하" bands → does `age` fit any band? Empty = everyone. */
export function ageMatches(bands: string, age: number): boolean {
  if (!bands.trim()) return true;
  return bands.split(",").some((band) => {
    const nums = [...band.matchAll(/(\d+)\s*세\s*(이상|이하|미만|초과)/g)];
    if (nums.length === 0) return true;
    let lo = 0;
    let hi = 200;
    for (const m of nums) {
      const n = Number(m[1]);
      if (m[2] === "이상") lo = Math.max(lo, n);
      else if (m[2] === "초과") lo = Math.max(lo, n + 1);
      else if (m[2] === "이하") hi = Math.min(hi, n);
      else hi = Math.min(hi, n - 1);
    }
    return age >= lo && age <= hi;
  });
}

const SIDO_TAG = /^\s*\[([^\]]{1,10})\]/;

export function regionMatches(p: Programme, region: string): boolean {
  const want = sidoOf(region);
  if (!want) return true;
  if (p.region) {
    if (/전국/.test(p.region)) return true;
    const got = sidoOf(p.region);
    return !got || got.key === want.key;
  }
  const tag = SIDO_TAG.exec(p.title)?.[1];
  const fromTitle = tag ? sidoOf(tag) : undefined;
  if (fromTitle) return fromTitle.key === want.key;
  const fromOrg = sidoOf(p.org.split("/")[0] ?? "");
  return !fromOrg || fromOrg.key === want.key;
}

export function fromKstartup(body: KstartupResponse): Programme[] {
  return (body.data ?? []).map((d) => ({
    title: cleanText(d.biz_pbanc_nm, 140),
    org: cleanText(d.pbanc_ntrp_nm, 60),
    field: cleanText(d.supt_biz_clsfc, 40),
    source: "kstartup",
    start: toYmd(d.pbanc_rcpt_bgng_dt),
    end: toYmd(d.pbanc_rcpt_end_dt),
    region: d.supt_regin ?? "",
    target: cleanText([d.aply_trgt, d.biz_enyy, d.aply_trgt_ctnt].filter(Boolean).join(" / "), 200),
    ages: d.biz_trgt_age ?? "",
    url: d.detl_pg_url,
  }));
}

export function fromSurvey(body: SurveyResponse): Programme[] {
  return (body.items ?? [])
    .filter((i) => i.source !== "kstartup") // the survey loses K-Startup dates; we query K-Startup directly
    .map((i) => ({
      title: cleanText(i.title, 140),
      org: cleanText(i.org, 60),
      field: cleanText(i.field, 40),
      source: i.source ?? "",
      start: toYmd(i.apply_start),
      end: toYmd(i.apply_end),
      region: "",
      target: "",
      ages: "",
      url: i.url,
    }));
}

export interface GovFilter {
  keyword?: string;
  region?: string;
  age?: number;
  target?: string;
}

export function selectOpen(all: Programme[], today: string, f: GovFilter): Programme[] {
  const seen = new Set<string>();
  const kw = (f.keyword ?? "").replace(/\s+/g, "").toLowerCase();
  const tg = (f.target ?? "").replace(/\s+/g, "").toLowerCase();
  return all
    .filter((p) => {
      const key = p.title.replace(/\s+/g, "");
      if (!p.title || seen.has(key)) return false;
      seen.add(key);
      if (p.start && p.start > today) return false;
      if (p.end && p.end < today) return false;
      const hay = `${p.title} ${p.field} ${p.org} ${p.target}`.replace(/\s+/g, "").toLowerCase();
      if (kw && !hay.includes(kw)) return false;
      // sources without applicant metadata (survey items) are kept unless they contradict the title
      if (tg && p.target && !hay.includes(tg)) return false;
      if (f.region && !regionMatches(p, f.region)) return false;
      if (f.age !== undefined && !ageMatches(p.ages, f.age)) return false;
      return true;
    })
    .sort((a, b) => (a.end || "99999999").localeCompare(b.end || "99999999"));
}

function deadlineText(end: string, today: string): string {
  if (!end) return "마감일 미정";
  const d = dayDiff(today, end);
  return `~${+end.slice(4, 6)}/${+end.slice(6)} ${d === 0 ? "(오늘 마감)" : `(D-${d})`}`;
}

export function buildGov(list: Programme[], today: string, label: string, partial: string[]): { summary: string; data: Record<string, unknown>; card: ResultListCard } {
  const shown = list.slice(0, 10);
  const soon = shown.filter((p) => p.end && dayDiff(today, p.end) <= 7).length;
  return {
    summary: shown.length
      ? `${label} 신청 가능한 지원사업 ${list.length}건${soon ? ` · 7일 내 마감 ${soon}건` : ""}`
      : `${label} 지금 신청 가능한 지원사업을 찾지 못했어요`,
    data: {
      filter: label,
      programmes: shown.map((p) => ({
        title: p.title,
        org: p.org,
        field: p.field || undefined,
        source: SOURCE_LABEL[p.source] ?? p.source,
        period: p.start || p.end ? `${p.start || "?"}~${p.end || "?"}` : undefined,
        daysLeft: p.end ? dayDiff(today, p.end) : undefined,
        region: p.region || undefined,
        target: p.target ? p.target.slice(0, 120) : undefined,
        url: p.url,
      })),
      sourcesFailed: partial.length ? partial : undefined,
      coverage:
        "K-Startup·기업마당·NIPA·KOCCA·SMTECH의 창업·기업·청년일자리 지원 공고예요. 정부24 개인 복지 혜택(보조금24)은 포함하지 않아요.",
      source: "K-Startup 외 4개 공공 지원사업 포털",
    },
    card: {
      type: "results",
      title: `${label} 지원사업`,
      source: "K-Startup · 기업마당 외",
      items: shown.map((p) => ({
        title: p.title,
        subtitle: [p.org, SOURCE_LABEL[p.source] ?? p.source].filter(Boolean).join(" · "),
        meta: deadlineText(p.end, today),
        url: p.url,
        icon: "gift" as const,
      })),
    },
  };
}

export const kGovSupport = defineSkill({
  name: "k_gov_support",
  description:
    "Find government support programmes that are open for application right now, sorted by deadline (K-Startup, 기업마당 bizinfo, " +
    "NIPA, KOCCA, SMTECH — startup, SME, youth-employment, R&D and content grants), via k-skill. Use for '받을 수 있는 정부 지원', " +
    "'창업 지원금', '청년 지원사업'. Does NOT cover individual welfare benefits of 정부24/보조금24. All filters optional: " +
    "`keyword` (e.g. '청년', 'AI'), `region` 시/도 (e.g. '서울'), `age` (years), `target` (e.g. '예비창업자', '대학생', '소상공인').",
  parameters: schema({
    keyword: { type: "string", description: "topic keyword, e.g. '청년', '수출', 'AI'" },
    region: { type: "string", description: "시/도, e.g. '서울', '경기'" },
    age: { type: "integer", minimum: 10, maximum: 100, description: "applicant age in years" },
    target: { type: "string", description: "applicant type, e.g. '예비창업자', '대학생', '소상공인', '중소기업'" },
  }),
  icon: "gift",
  title: (a) => `${[str(a.region, 10), str(a.keyword, 20)].filter(Boolean).join(" ") || "정부"} 지원사업 찾기`,
  meta: {
    source: "government-support-survey · kstartup-search",
    title: "정부 지원사업",
    description: "지금 신청할 수 있는 창업·기업·청년 지원사업을 마감 임박 순으로 모아줘요.",
    category: "공공",
    example: "서울 사는 29살 예비창업자가 지금 신청할 수 있는 지원사업 찾아줘",
  },
  async run(a, rc) {
    const today = kst(rc.now).ymd;
    const f: GovFilter = {
      keyword: str(a.keyword, 40) || undefined,
      region: str(a.region, 20) || undefined,
      age: optInt(a.age, 10, 100),
      target: str(a.target, 20) || undefined,
    };
    if (f.region && !sidoOf(f.region)) return failText(`지원사업: ‘${f.region}’ 지역을 알아듣지 못했어요. ${REGION_HINT}`, "unknown_region");
    rc.status("지원사업 공고 모으는 중");
    const [ks, sv] = await Promise.all([
      proxyGet<KstartupResponse>("/v1/kstartup/announcements", { page: 1, perPage: 100, rcrt_prgs_yn: "Y" }, rc.signal),
      proxyGet<SurveyResponse>(
        "/v1/government-support/survey",
        { sources: "bizinfo,nipa,kocca,smtech", keyword: f.keyword, maxPages: 1 },
        rc.signal,
      ),
    ]);
    if (!ks.ok && !sv.ok) return fail(ks.error, "지원사업");
    const partial: string[] = [];
    if (!ks.ok) partial.push("K-Startup");
    if (!sv.ok) partial.push("기업마당·NIPA·KOCCA·SMTECH");
    else for (const [k, v] of Object.entries(sv.body.sources ?? {})) if (v && v.ok === false) partial.push(SOURCE_LABEL[k] ?? k);
    const all = [...(ks.ok ? fromKstartup(ks.body) : []), ...(sv.ok ? fromSurvey(sv.body) : [])];
    const list = selectOpen(all, today, f);
    const regionLabel = f.region ? sidoOf(f.region)?.key : undefined;
    const label = [regionLabel, f.age !== undefined ? `${f.age}세` : "", f.target, f.keyword ? `‘${f.keyword}’` : ""].filter(Boolean).join(" ") || "전체";
    return { ok: true, ...buildGov(list, today, label, partial) };
  },
});

// ───────────────────────────── LH 공고 ─────────────────────────────

export interface LhResponse {
  items?: {
    pan_id?: string;
    pan_nm?: string;
    upp_ais_tp_cd?: string;
    ais_tp_cd_nm?: string;
    cnp_cd_nm?: string;
    pan_ss?: string;
    pan_dt?: string | null;
    clsg_dt?: string | null;
    detail_url?: string;
    raw?: { PAN_NT_ST_DT?: string; UPP_AIS_TP_NM?: string; ALL_CNT?: string };
  }[];
}

const LH_KIND: Record<string, string[]> = { 임대: ["06"], 분양: ["05"], 주거복지: ["13"], 전체: ["05", "06", "13"] };
const LH_KIND_LABEL: Record<string, string> = { "05": "분양", "06": "임대", "13": "주거복지", "01": "토지", "22": "상가" };

export function buildLh(body: LhResponse, today: string, f: { kind: string; region?: string; openOnly: boolean }): { summary: string; data: Record<string, unknown>; card: ResultListCard } {
  const kinds = LH_KIND[f.kind] ?? LH_KIND.전체!;
  const want = f.region ? sidoOf(f.region) : undefined;
  const list = (body.items ?? [])
    .filter((i) => i.pan_nm && kinds.includes(i.upp_ais_tp_cd ?? ""))
    .map((i) => ({
      title: cleanText(i.pan_nm, 120),
      kind: LH_KIND_LABEL[i.upp_ais_tp_cd ?? ""] ?? i.raw?.UPP_AIS_TP_NM ?? "",
      type: i.ais_tp_cd_nm ?? "",
      region: i.cnp_cd_nm ?? "",
      status: i.pan_ss ?? "",
      posted: toYmd(i.raw?.PAN_NT_ST_DT ?? i.pan_dt ?? ""),
      deadline: toYmd(i.clsg_dt ?? ""),
      url: i.detail_url,
    }))
    .filter((i) => !want || !i.region || i.region.includes("전국") || sidoOf(i.region)?.key === want.key || i.region.includes(want.key))
    .filter((i) => !f.openOnly || ((i.status === "공고중" || i.status === "접수중") && (!i.deadline || i.deadline >= today)))
    .sort((a, b) => (a.deadline || "99999999").localeCompare(b.deadline || "99999999"));
  const shown = list.slice(0, 10);
  const label = [want?.key ?? f.region, f.kind !== "전체" ? f.kind : ""].filter(Boolean).join(" ") || "전체";
  return {
    summary: shown.length ? `LH ${label} 공고 ${list.length}건 · 가장 빠른 마감 ${shown[0]!.title.slice(0, 30)}` : `LH ${label} 진행 중인 공고가 없어요`,
    data: {
      filter: label,
      notices: shown.map((n) => ({ ...n, daysLeft: n.deadline ? dayDiff(today, n.deadline) : undefined })),
      note:
        want?.key === "서울" && shown.length === 0
          ? "서울 공공임대·분양은 SH서울주택도시공사(i-sh.co.kr) 공고가 대부분이에요. LH 공고는 최신 200건 기준으로 걸렀어요."
          : "공고 상세(자격·소득 기준)는 링크의 LH청약플러스에서 확인하세요. 최신 200건 기준으로 걸렀어요.",
      source: "LH 청약플러스 분양임대공고",
    },
    card: {
      type: "results",
      title: `LH ${label} 공고`,
      source: "LH 청약플러스",
      items: shown.map((n) => ({
        title: n.title,
        subtitle: [n.type, n.region, n.status].filter(Boolean).join(" · "),
        meta: n.deadline ? `~${+n.deadline.slice(4, 6)}/${+n.deadline.slice(6)} (D-${dayDiff(today, n.deadline)})` : undefined,
        url: n.url,
        icon: "house" as const,
      })),
    },
  };
}

export const kHousingNotices = defineSkill({
  name: "k_housing_notices",
  description:
    "LH (Korea Land & Housing Corp.) public housing notices open now — rental (행복주택, 국민임대, 매입·전세임대), sale (분양) and " +
    "housing-welfare — sorted by closing date, via k-skill. All optional: `keyword` in the notice title (e.g. '행복주택'), " +
    "`region` 시/도 (e.g. '서울', '경기'), `kind` 임대/분양/주거복지/전체 (default 전체), `openOnly` (default true).",
  parameters: schema({
    keyword: { type: "string", description: "title keyword, e.g. '행복주택', '신혼희망'" },
    region: { type: "string", description: "시/도, e.g. '서울', '경기'" },
    kind: { type: "string", enum: ["임대", "분양", "주거복지", "전체"], description: "notice type, default 전체" },
    openOnly: { type: "boolean", description: "only notices accepting applications now (default true)" },
  }),
  icon: "house",
  title: (a) => `LH ${[str(a.region, 10), str(a.keyword, 20)].filter(Boolean).join(" ")} 공고 확인`.replace(/\s+/g, " "),
  meta: {
    source: "lh-notice-search",
    title: "LH 임대·분양 공고",
    description: "LH 청약플러스의 진행 중인 임대·분양·주거복지 공고를 마감 순으로 알려줘요.",
    category: "공공",
    example: "서울 행복주택 지금 모집하는 거 있어?",
  },
  async run(a, rc) {
    const today = kst(rc.now).ymd;
    const kind = typeof a.kind === "string" && LH_KIND[a.kind] ? a.kind : "전체";
    const keyword = str(a.keyword, 40);
    const region = str(a.region, 20) || undefined;
    if (region && !sidoOf(region)) return failText(`LH 공고: ‘${region}’ 지역을 알아듣지 못했어요. ${REGION_HINT}`, "unknown_region");
    const r = await proxyGet<LhResponse>("/v1/lh-notice/search", { pageSize: 200, keyword: keyword || undefined }, rc.signal);
    if (!r.ok) return fail(r.error, "LH 공고");
    return { ok: true, ...buildLh(r.body, today, { kind, region, openOnly: a.openOnly !== false && a.openOnly !== "false" }) };
  },
});
