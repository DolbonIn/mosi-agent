/**
 * 네이버 검색광고 API, read-only, with the owner's own API key/secret/customer id (HMAC-SHA256 signed requests).
 *
 * Ported from NomaDamas/k-skill `naver-ad-performance/scripts/naver_ad_performance.py` (MIT; its signing follows
 * NariP/naver-searchad, MIT): signature = base64(HMAC-SHA256(secret, "{timestamp}.{METHOD}.{path}")) over the path
 * without the query; X-Timestamp / X-API-KEY / X-Customer / X-Signature headers; CTR and CPC derived when missing.
 * Only GET /ncc/campaigns, /ncc/adgroups, /stats and /keywordstool are implemented — no bid, budget, status or
 * create/update/delete calls exist in this module.
 */
import type { ConnectionServiceContext } from "@pickle/agent";
import { needsConnection } from "@pickle/agent";
import type { ResultListCard } from "@pickle/protocol";
import { addDays, defineSkill, failText, kst, schema, str, type SkillConnection } from "../util";
import { directRequest, fromDirect, hmacSha256, parseJson, verifyFailure, verifyKey, type UpstreamFailure, type VerifyResult } from "../direct";

export const NAVER_AD_ORIGIN = "https://api.searchad.naver.com";
const ORIGINS = [NAVER_AD_ORIGIN] as const;

export const NAVER_AD: SkillConnection = {
  id: "naver-searchad",
  name: "네이버 검색광고",
  reason: "광고 성과를 보려면 네이버 검색광고 연결이 필요해요",
};

const STATS_FIELDS = ["impCnt", "clkCnt", "salesAmt", "ctr", "cpc", "avgRnk", "ccnt"] as const;

type Secret = Readonly<Record<string, string>>;
type Out<T> = { ok: true; body: T } | { ok: false; error: UpstreamFailure };

/** signature over "{timestamp}.{METHOD}.{path}" (path only, no query) */
export function naverSignature(secretKey: string, timestamp: string, method: string, path: string): string {
  return hmacSha256(secretKey, `${timestamp}.${method.toUpperCase()}.${path}`, "base64");
}

export async function naverGet<T>(secret: Secret, credentialId: string, path: string, query: Record<string, string>, signal: AbortSignal, now: () => number = Date.now): Promise<Out<T>> {
  const apiKey = (secret.apiKey ?? "").trim();
  const secretKey = (secret.secretKey ?? "").trim();
  const customer = (secret.customerId ?? "").replace(/\D/g, "");
  if (!apiKey || !secretKey || !customer) return { ok: false, error: { kind: "auth", message: "네이버 검색광고 API 키·시크릿·고객 ID 중 빈 값이 있어요" } };
  const ts = String(now());
  const qs = new URLSearchParams(query).toString();
  const r = await directRequest({
    url: `${NAVER_AD_ORIGIN}${path}${qs ? `?${qs}` : ""}`,
    headers: { "X-Timestamp": ts, "X-API-KEY": apiKey, "X-Customer": customer, "X-Signature": naverSignature(secretKey, ts, "GET", path), Accept: "application/json" },
    origins: ORIGINS,
    signal,
    limit: { key: `naverad:${credentialId}`, burst: 6, refill: 30, windowMs: 60_000 },
  });
  if (!r.ok) return { ok: false, error: fromDirect(r.error, "네이버 검색광고") };
  const j = parseJson(r.res.text) as (T & { title?: string; detail?: string; code?: number }) | null | undefined;
  const s = r.res.status;
  if (s === 200 && j !== undefined) return { ok: true, body: j as T };
  if (s === 401) return { ok: false, error: { kind: "auth", status: s, message: "네이버 검색광고가 서명을 거절했어요(키·시크릿 확인)" } };
  if (s === 403) return { ok: false, error: { kind: "auth", status: s, message: "이 고객 ID로 조회할 권한이 없어요" } };
  if (s === 429) return { ok: false, error: { kind: "rate", status: s, message: "네이버 검색광고 호출 한도를 넘었어요. 잠시 후 다시 해 주세요" } };
  if (s === 400 || s === 404) return { ok: false, error: { kind: "input", status: s, message: str(j?.title ?? j?.detail, 120) || "네이버 검색광고가 요청 값을 받지 않았어요" } };
  return { ok: false, error: { kind: "upstream", status: s, message: "네이버 검색광고 서버 응답이 원활하지 않아요" } };
}

export async function verifyNaverAd(secret: Secret, x: ConnectionServiceContext): Promise<VerifyResult> {
  const r = await naverGet<unknown[]>(secret, verifyKey(secret.apiKey ?? ""), "/ncc/campaigns", {}, x.signal);
  if (!r.ok) return verifyFailure(r.error, "네이버 검색광고가 키를 받지 않았어요. 도구 > API 사용 관리의 API 키, 시크릿, 고객 ID를 확인해 주세요.");
  const count = Array.isArray(r.body) ? r.body.length : 0;
  return { ok: true, accountLabel: `검색광고 · 캠페인 ${count}개` };
}

function failed(e: UpstreamFailure) {
  if (e.kind === "auth") return needsConnection(NAVER_AD.id, NAVER_AD.name, `${e.message}. 네이버 검색광고를 다시 연결해 주세요.`);
  return failText(`네이버 검색광고: ${e.message}`, e.kind);
}

// ───────────────────────────── period ─────────────────────────────

export type Period = "today" | "yesterday" | "last7" | "last30" | "this_month" | "last_month";

/** KST day ranges as YYYY-MM-DD (the stats API's timeRange format) */
export function periodRange(p: string, now: Date): { since: string; until: string; label: string } {
  const t = kst(now);
  const dash = (ymd: string) => `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;
  const today = t.ymd;
  const mm = (m: number) => String(m).padStart(2, "0");
  switch (p) {
    case "today":
      return { since: dash(today), until: dash(today), label: "오늘" };
    case "yesterday":
      return { since: dash(addDays(today, -1)), until: dash(addDays(today, -1)), label: "어제" };
    case "last30":
      return { since: dash(addDays(today, -30)), until: dash(addDays(today, -1)), label: "최근 30일" };
    case "this_month":
      return { since: `${t.y}-${mm(t.m)}-01`, until: dash(today), label: "이번 달" };
    case "last_month": {
      const y = t.m === 1 ? t.y - 1 : t.y;
      const m = t.m === 1 ? 12 : t.m - 1;
      const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
      return { since: `${y}-${mm(m)}-01`, until: `${y}-${mm(m)}-${mm(last)}`, label: "지난달" };
    }
    default:
      return { since: dash(addDays(today, -7)), until: dash(addDays(today, -1)), label: "최근 7일" };
  }
}

// ───────────────────────────── stats ─────────────────────────────

interface StatRow {
  id?: string;
  impCnt?: number;
  clkCnt?: number;
  salesAmt?: number;
  ctr?: number;
  cpc?: number;
  avgRnk?: number;
  ccnt?: number;
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() && Number.isFinite(Number(v)) ? Number(v) : 0);

/** CTR (%) and CPC (₩) derived when the API leaves them out, like the upstream helper */
export function derive(r: StatRow) {
  const imp = num(r.impCnt);
  const clk = num(r.clkCnt);
  const cost = num(r.salesAmt);
  return {
    impressions: imp,
    clicks: clk,
    cost,
    ctr: r.ctr !== undefined ? num(r.ctr) : imp ? Math.round((clk / imp) * 10000) / 100 : 0,
    cpc: r.cpc !== undefined ? num(r.cpc) : clk ? Math.round(cost / clk) : 0,
    avgRank: r.avgRnk !== undefined ? num(r.avgRnk) : null,
    conversions: num(r.ccnt),
  };
}

const won = (v: number) => `₩${Math.round(v).toLocaleString("en-US")}`;
const count = (v: number) => Math.round(v).toLocaleString("en-US");

interface NccItem {
  nccCampaignId?: string;
  nccAdgroupId?: string;
  name?: string;
  status?: string;
  userLock?: boolean;
}

export const kNaverAdReport = defineSkill({
  name: "k_naver_ad_report",
  description:
    "The owner's 네이버 검색광고 performance (impressions, clicks, CTR, cost, CPC, avg rank, conversions) per campaign for a period; " +
    "with `campaign` (a name) it breaks that campaign down by ad group. Needs the owner's 네이버 검색광고 connection. " +
    "Read-only: never changes bids, budgets or status. `period`: today | yesterday | last7 (default) | last30 | this_month | last_month.",
  parameters: schema({
    period: { type: "string", enum: ["today", "yesterday", "last7", "last30", "this_month", "last_month"], description: "default last7" },
    campaign: { type: "string", description: "optional campaign name (or part) to break down by ad group" },
  }),
  icon: "chart",
  title: (a) => (a.campaign ? `${str(a.campaign, 16)} 광고 성과 확인` : "네이버 광고 성과 확인"),
  meta: { source: "naver-ad-performance", title: "네이버 검색광고", description: "내 네이버 검색광고 캠페인 성과를 봐요. 입찰가는 바꾸지 않아요.", category: "비즈니스", example: "이번 달 네이버 광고 성과 어때?" },
  connection: NAVER_AD,
  private: true,
  async run(a, rc) {
    const conn = rc.conn!;
    const range = periodRange(str(a.period, 12), rc.now);
    rc.status("네이버 검색광고 캠페인 조회 중");
    const c = await naverGet<NccItem[]>(conn.secret, conn.credentialId, "/ncc/campaigns", {}, rc.signal);
    if (!c.ok) return failed(c.error);
    const campaigns = (Array.isArray(c.body) ? c.body : []).filter((x) => x.nccCampaignId);
    if (!campaigns.length) return { ok: true, summary: "캠페인이 없어요", data: { campaigns: [], period: range } };
    const want = str(a.campaign, 40).replace(/\s+/g, "").toLowerCase();
    let rows: { id: string; name: string; level: "campaign" | "adgroup"; off: boolean }[];
    let scope = "캠페인";
    if (want) {
      const hit = campaigns.filter((x) => (x.name ?? "").replace(/\s+/g, "").toLowerCase().includes(want));
      if (!hit.length) return failText(`네이버 검색광고: ‘${str(a.campaign, 40)}’ 캠페인을 찾지 못했어요`, "not_found", { campaigns: campaigns.slice(0, 20).map((x) => x.name) });
      if (hit.length > 1) return failText(`네이버 검색광고: ‘${str(a.campaign, 40)}’에 맞는 캠페인이 여러 개예요`, "ambiguous", { candidates: hit.slice(0, 10).map((x) => x.name) });
      rc.status("광고그룹 조회 중");
      const g = await naverGet<NccItem[]>(conn.secret, conn.credentialId, "/ncc/adgroups", { nccCampaignId: hit[0]!.nccCampaignId! }, rc.signal);
      if (!g.ok) return failed(g.error);
      rows = (Array.isArray(g.body) ? g.body : []).filter((x) => x.nccAdgroupId).map((x) => ({ id: x.nccAdgroupId!, name: x.name ?? x.nccAdgroupId!, level: "adgroup" as const, off: !!x.userLock }));
      scope = `${hit[0]!.name} 광고그룹`;
      if (!rows.length) return { ok: true, summary: `${hit[0]!.name}: 광고그룹이 없어요`, data: { campaign: hit[0]!.name, adgroups: [], period: range } };
    } else {
      rows = campaigns.map((x) => ({ id: x.nccCampaignId!, name: x.name ?? x.nccCampaignId!, level: "campaign" as const, off: !!x.userLock }));
    }
    rows = rows.slice(0, 100);
    rc.status("성과 집계 중");
    const st = await naverGet<{ data?: StatRow[] } | StatRow[]>(
      conn.secret,
      conn.credentialId,
      "/stats",
      { ids: JSON.stringify(rows.map((r) => r.id)), fields: JSON.stringify(STATS_FIELDS), timeRange: JSON.stringify({ since: range.since, until: range.until }) },
      rc.signal,
    );
    if (!st.ok) return failed(st.error);
    const list = Array.isArray(st.body) ? st.body : (st.body?.data ?? []);
    const byId = new Map(list.map((r) => [r.id, r] as const));
    const perf = rows
      .map((r) => ({ name: r.name, paused: r.off || undefined, ...derive(byId.get(r.id) ?? {}) }))
      .sort((x, y) => y.cost - x.cost || y.clicks - x.clicks);
    const tot = perf.reduce((acc, p) => ({ impressions: acc.impressions + p.impressions, clicks: acc.clicks + p.clicks, cost: acc.cost + p.cost, conversions: acc.conversions + p.conversions }), { impressions: 0, clicks: 0, cost: 0, conversions: 0 });
    const total = { ...tot, ctr: tot.impressions ? Math.round((tot.clicks / tot.impressions) * 10000) / 100 : 0, cpc: tot.clicks ? Math.round(tot.cost / tot.clicks) : 0 };
    const card: ResultListCard = {
      type: "results",
      title: `${range.label} ${scope} 성과`,
      source: "네이버 검색광고",
      items: [
        { title: `광고비 ${won(total.cost)} · 클릭 ${count(total.clicks)}`, subtitle: `노출 ${count(total.impressions)} · CTR ${total.ctr}% · CPC ${won(total.cpc)}${total.conversions ? ` · 전환 ${count(total.conversions)}` : ""}`, icon: "chart" },
        ...perf.slice(0, 8).map((p) => ({
          title: p.name,
          subtitle: `광고비 ${won(p.cost)} · 클릭 ${count(p.clicks)} · CTR ${p.ctr}%`,
          meta: p.avgRank ? `평균 ${p.avgRank}위` : p.paused ? "중지" : undefined,
          icon: "chart" as const,
        })),
      ],
    };
    return {
      ok: true,
      summary: `${range.label} 광고비 ${won(total.cost)} · 클릭 ${count(total.clicks)} · CTR ${total.ctr}%`,
      data: { period: range, scope, total, rows: perf.slice(0, 30), count: perf.length, note: range.label === "오늘" ? "오늘 수치는 집계 중이라 바뀔 수 있어요." : undefined, readOnly: true, private: true },
      card,
    };
  },
});

interface KeywordRow {
  relKeyword?: string;
  monthlyPcQcCnt?: number | string;
  monthlyMobileQcCnt?: number | string;
  monthlyAvePcClkCnt?: number | string;
  monthlyAveMobileClkCnt?: number | string;
  compIdx?: string;
}

/** "< 10" → 5 (the API hides tiny volumes); numbers pass through */
const volume = (v: unknown): number => (typeof v === "string" && v.includes("<") ? 5 : num(v));

export const kNaverAdKeywords = defineSkill({
  name: "k_naver_ad_keywords",
  description:
    "네이버 검색광고 keyword tool with the owner's key: related keywords, monthly PC/mobile search volume and competition for up to 5 hint keywords. " +
    "Needs the owner's 네이버 검색광고 connection. `keywords`: comma-separated ('제주여행, 게스트하우스').",
  parameters: schema({ keywords: { type: "string", description: "up to 5 comma-separated hint keywords" } }, ["keywords"]),
  icon: "magnifier",
  title: (a) => `${str(a.keywords, 20)} 검색량 확인`,
  meta: { source: "naver-ad-performance", title: "네이버 키워드 검색량", description: "연관 키워드와 월간 검색량·경쟁도를 봐요.", category: "비즈니스", example: "‘제주여행’ 월간 검색량 알려줘" },
  connection: { ...NAVER_AD, reason: "키워드 검색량을 보려면 네이버 검색광고 연결이 필요해요" },
  private: false, // public search volumes, not the owner's account data
  async run(a, rc) {
    const conn = rc.conn!;
    // the keyword tool rejects spaces inside a hint keyword
    const hints = str(a.keywords, 120)
      .split(/[,，]/)
      .map((k) => k.replace(/\s+/g, ""))
      .filter(Boolean)
      .slice(0, 5);
    if (!hints.length) return failText("네이버 키워드: 키워드를 알려주세요");
    rc.status("키워드 검색량 조회 중");
    const r = await naverGet<{ keywordList?: KeywordRow[] }>(conn.secret, conn.credentialId, "/keywordstool", { hintKeywords: hints.join(","), showDetail: "1" }, rc.signal);
    if (!r.ok) return failed(r.error);
    const rows = (r.body?.keywordList ?? [])
      .map((k) => ({ keyword: k.relKeyword ?? "", pc: volume(k.monthlyPcQcCnt), mobile: volume(k.monthlyMobileQcCnt), competition: k.compIdx }))
      .filter((k) => k.keyword)
      .map((k) => ({ ...k, total: k.pc + k.mobile }));
    const hinted = new Set(hints.map((h) => h.toLowerCase()));
    const top = [...rows.filter((k) => hinted.has(k.keyword.toLowerCase())), ...rows.filter((k) => !hinted.has(k.keyword.toLowerCase())).sort((x, y) => y.total - x.total)].slice(0, 15);
    if (!top.length) return { ok: true, summary: "연관 키워드가 없어요", data: { hints, keywords: [] } };
    const lead = top[0]!;
    return {
      ok: true,
      summary: `${lead.keyword} 월간 ${count(lead.total)}회 (모바일 ${count(lead.mobile)}) · 경쟁 ${lead.competition ?? "-"}`,
      data: { hints, keywords: top, note: "월간 조회수는 최근 30일 기준이고, 10 미만은 ‘<10’으로만 나와요." },
      card: {
        type: "results",
        title: "키워드 검색량",
        source: "네이버 검색광고",
        items: top.slice(0, 10).map((k) => ({ title: k.keyword, subtitle: `월 ${count(k.total)}회 · PC ${count(k.pc)} · 모바일 ${count(k.mobile)}`, meta: k.competition ? `경쟁 ${k.competition}` : undefined, icon: "magnifier" })),
      },
    };
  },
});

export const NAVER_AD_FIELDS = [
  { key: "apiKey", label: "API 키 (액세스 라이선스)", type: "text" as const, autocomplete: "off", placeholder: "검색광고 > 도구 > API 사용 관리" },
  { key: "secretKey", label: "비밀키", type: "password" as const, autocomplete: "off" },
  { key: "customerId", label: "고객 ID (CUSTOMER_ID)", type: "text" as const, autocomplete: "off", placeholder: "숫자", hint: "조회에만 써요." },
];
