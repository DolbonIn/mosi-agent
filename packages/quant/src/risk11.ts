/**
 * A2, the eleven core risk indicators. CORE11 keeps the master prompt's table word for word (the gate compares it with
 * the source); CORE11_LIMITS holds the same thresholds as numbers, and judgeCore11 applies them. A missing input is
 * ⚪ ("unknown"), never 🟢. Indicator 9 has no number in the source: its 🟡 comes in as a judgment with its basis, and the
 * code only adds the figures (no 🔴 exists for it). Indicator 8 reads "M7 전체" company by company (the lead's
 * decision, 11-26): 🔴 only when all seven are confirmed as revised down, 🟢 as soon as one is confirmed as not revised
 * down, otherwise ⚪. A few companies down are never read as all seven ("일부 기업만 확인 시 전체로 확대 해석 금지").
 */
import { atOrBefore, changeOver, covers, lastMonths, latest, monthChangePct, monthsBefore, oldest, present, r9, streak } from "./series";
import type { Point, Signal, Tri } from "./types";

export interface Core11Row {
  no: number;
  name: string;
  source: string;
  rule: string;
  extras: string;
}

/** the master prompt's A2 table, word for word */
export const CORE11: readonly Core11Row[] = [
  { no: 1, name: "미국 10년물 금리", source: "FRED `DGS10`", rule: "`>5%` 🔴 / `≤5%` 🟢", extras: "5% 초과 연속 거래일 수, 최근 5·20거래일 변화, 상승 속도" },
  { no: 2, name: "2년물 − 기준금리 상단", source: "`DGS2` − `DFEDTARU`", rule: "`>0` 🔴 / `≤0` 🟢", extras: "추가 인상·고금리 장기화 반영 여부 해석" },
  { no: 3, name: "하이일드 스프레드", source: "`BAMLH0A0HYM2`", rule: "6개월 최저 대비 `+0.5%p↑` 🔴 / `+0.3~0.5%p` 🟡 / `<+0.3%p` 🟢", extras: "현재·6개월 최저/최고·20거래일 최고·5/20거래일 변화·고점 대비 축소 폭·3.5%p·4.0%p 돌파" },
  { no: 4, name: "엔화 절상률(엔캐리)", source: "USD/JPY", rule: "1개월 절상 `≥5%` 🔴 / `3~5%` 🟡 / `<3%` 🟢", extras: "계산식 `(1개월 전 ÷ 현재 − 1)×100`, BOJ 정책 변화 결합" },
  { no: 5, name: "미국 실업률", source: "`UNRATE`", rule: "직전 발표 대비 상승 🟡 / 2026년 8월 기준 **4.1%** 대비 `+0.3%p↑` 🔴 / 그 외 🟢", extras: "**4.1%는 임의 변경 금지**, 통계 개정은 별도 표시" },
  { no: 6, name: "삼전·하닉 이익 컨센서스", source: "S&P Global·증권사", rule: "최근 3개월 12M fwd 이익 전망 `−5% 초과` 🔴(둘 중 하나라도) / 그 외 🟢", extras: "기업별 수치 개별 표시, **다른 회계연도 직접 비교 금지**, HBM·DRAM·NAND·AI 서버 연결 분석" },
  { no: 7, name: "S&P500 시장 폭", source: "자체 계산", rule: "200일선 상회 종목 `<60%` 🔴 / `≥60%` 🟢", extras: "50일선 비율, A/D Line, 신고가·신저가, 동일가중 vs 시총가중" },
  { no: 8, name: "M7 이익 전망", source: "컨센서스", rule: "**M7 전체** 이익 전망 하향 전환 🔴 / 미확인 🟢", extras: "일부 기업만 확인 시 전체로 확대 해석 금지" },
  { no: 9, name: "외국인 코스피 순매매", source: "KRX·토스 API", rule: "대규모 순매도 지속 🟡", extras: "당일·5일·20일 누적, 연속 매수/매도일, 삼전·하닉 수급, 코스피200 선물. **원문에 없는 🔴 조건 추가 금지**" },
  { no: 10, name: "미국 근원 CPI", source: "BLS", rule: "MoM `≥0.3%` 🔴 / `0.2~0.3%` 🟡 / `<0.2%` 🟢", extras: "YoY 병기하되 판정은 MoM, 예상치 대비 차이" },
  { no: 11, name: "빅테크 AI CAPEX", source: "MSFT·GOOGL·META·AMZN 가이던스", rule: "내년 설비투자 증가율 `<20%` 🔴(개별)", extras: "개별 표시, 합산은 동일 기준일 때만, 공식 가이던스 vs 추정 구분, **2개 이상 <20%면 A6 별도 신호**" },
];

/** the thresholds of CORE11 as numbers (units: %, %p) */
export const CORE11_LIMITS = {
  /** 1: risk above */
  dgs10: 5,
  /** 2: risk above */
  policyGap: 0,
  /** 3: widening from the 6-month low, risk at or above, caution at or above */
  hy: { risk: 0.5, caution: 0.3 },
  /** 4: 1-month yen appreciation, risk at or above, caution at or above */
  yen: { risk: 5, caution: 3 },
  /** 5: the fixed base (never changed) and the rise over it that is risk */
  unrate: { base: 4.1, risk: 0.3 },
  /** 6: a 3-month revision below this is risk */
  eps: -5,
  /** 7: risk below */
  breadth: 60,
  /** 10: core CPI MoM, risk at or above, caution at or above */
  cpi: { risk: 0.3, caution: 0.2 },
  /** 11: next year's capex growth below this is risk, per company */
  capex: 20,
} as const;

/** the companies indicator 8 covers */
export const M7 = ["AAPL", "MSFT", "GOOGL", "AMZN", "META", "NVDA", "TSLA"] as const;

/** the companies indicator 11 covers */
export const CAPEX_COMPANIES = ["MSFT", "GOOGL", "META", "AMZN"] as const;

export interface Core11Input {
  /** FRED DGS10, % */
  dgs10?: readonly Point[];
  /** FRED DGS2, % */
  dgs2?: readonly Point[];
  /** FRED DFEDTARU, % */
  fedUpper?: readonly Point[];
  /** FRED BAMLH0A0HYM2, % */
  hy?: readonly Point[];
  /** USD/JPY */
  usdjpy?: readonly Point[];
  /** FRED UNRATE, % (monthly) */
  unrate?: readonly Point[];
  /** 12M forward earnings estimate change over the last 3 months, %, per company (t: as of) */
  eps3m?: { samsung?: Point | null; hynix?: Point | null };
  /** share of S&P 500 members above their 200-day average, % */
  breadth200?: readonly Point[];
  /** per M7 company, whether its earnings estimate has turned down: true, false (not down), null or missing (not
   * confirmed); t is the check's as of */
  m7?: { t: string; down: Readonly<Partial<Record<(typeof M7)[number], boolean | null>>> } | null;
  /** foreigners' daily net KOSPI trading (억원), for the figures */
  foreignKospi?: readonly Point[];
  /** the judgment "대규모 순매도 지속" with its basis (no number in the source) */
  foreignSelling?: { t: string; sustained: boolean; basis: string } | null;
  /** core CPI MoM as published, % (one decimal; see momFromIndex) */
  coreCpiMoM?: readonly Point[];
  /** next year's capex growth, %, per company (official guidance or estimate, said by the caller) */
  capex?: Readonly<Partial<Record<(typeof CAPEX_COMPANIES)[number], Point | null>>>;
}

export type Extra = number | string | boolean | null;

export interface Judgment {
  no: number;
  name: string;
  signal: Signal;
  /** the judged value in the row's unit (%, %p); null when unknown or not a number */
  value: number | null;
  /** the date of the newest observation behind the value (the oldest of several inputs) */
  asOf: string | null;
  /** the comparison, in a short line ("4.53% ≤ 5%") */
  reason: string;
  extras: Record<string, Extra>;
  /** for an unknown: whether the missing data could still make it 🔴 (indicator 9 never can; indicator 5 with its
   * latest release known but no prior one has already ruled 🔴 out) */
  mayBeRisk: boolean;
}

export interface Core11Result {
  items: Judgment[];
  counts: Record<Signal, number>;
  /** the unknowns that could still be 🔴, for A5's "core 🔴 ≥3" while data is missing */
  riskPossible: number;
  /** whether indicator 3 (high yield) is risk, for A5's stage 2 */
  hyRisk: Tri;
}

const fmt = (x: number, d = 2) => (Math.round(x * 10 ** d) / 10 ** d).toFixed(d);
const sgn = (x: number, d = 2) => (x > 0 ? "+" : x < 0 ? "−" : "") + fmt(Math.abs(x), d);
const unknown = (no: number, why: string, extras: Record<string, Extra> = {}, mayBeRisk = true): Judgment => ({
  no,
  name: CORE11[no - 1]!.name,
  signal: "unknown",
  value: null,
  asOf: null,
  reason: why,
  extras,
  mayBeRisk,
});
const judged = (no: number, signal: Signal, value: number | null, asOf: string | null, reason: string, extras: Record<string, Extra> = {}): Judgment => ({
  no,
  name: CORE11[no - 1]!.name,
  signal,
  value,
  asOf,
  reason,
  extras,
  mayBeRisk: false,
});
const NO_DATA = "데이터 없음";

/** the high-yield figures A2's row 3, A5's A1/D1 and A6's R2 read: current, 6-month low and high, 20-day high, changes.
 * The 6-month figures need a series reaching back six months, the 20-day high twenty observations; short of that they
 * are null (unknown), never computed from the part at hand */
export function hyFigures(hy: readonly Point[] | null | undefined) {
  const now = latest(hy);
  if (!now) return null;
  const m6 = covers(hy, 6) ? lastMonths(hy, 6).map((p) => p.v) : null;
  const all = present(hy);
  const d20 = all.length >= 20 ? all.slice(-20).map((p) => p.v) : null;
  const low6m = m6 ? Math.min(...m6) : null;
  const high20 = d20 ? Math.max(...d20) : null;
  return {
    now,
    low6m,
    high6m: m6 ? Math.max(...m6) : null,
    high20,
    /** widening from the 6-month low, %p */
    fromLow: low6m != null ? r9(now.v - low6m) : null,
    /** narrowing from the 20-day high, %p (positive: narrower) */
    offHigh20: high20 != null ? r9(high20 - now.v) : null,
    change5: changeOver(hy, 5),
    change20: changeOver(hy, 20),
  };
}

/** foreigners' net trading figures: the day, 5- and 20-day sums, and the buying or selling streak */
export function netFlowFigures(daily: readonly Point[] | null | undefined) {
  const xs = present(daily);
  if (!xs.length) return null;
  const v = xs.map((p) => p.v);
  const sum = (n: number) => (v.length >= n ? r9(v.slice(-n).reduce((s, x) => s + x, 0)) : null);
  return {
    asOf: xs[xs.length - 1]!.t,
    day: v[v.length - 1]!,
    sum5: sum(5),
    sum20: sum(20),
    buyStreak: streak(v, (x) => x > 0),
    sellStreak: streak(v, (x) => x < 0),
  };
}

/** a month-over-month change from a monthly index series, rounded as the release rounds it (BLS: one decimal); a month
 * whose previous month is missing gets no value (never a two-month change) */
export function momFromIndex(index: readonly Point[], decimals = 1): Point[] {
  const xs = present(index);
  const month = (t: string) => t.slice(0, 7);
  const out: Point[] = [];
  for (let i = 1; i < xs.length; i++) {
    const p = xs[i]!;
    const prev = xs[i - 1]!;
    if (month(monthsBefore(`${month(p.t)}-01`, 1)) === month(prev.t)) out.push({ t: p.t, v: Number(((p.v / prev.v - 1) * 100).toFixed(decimals)) });
  }
  return out;
}

function judge1(dgs10?: readonly Point[]): Judgment {
  const now = latest(dgs10);
  if (!now) return unknown(1, NO_DATA);
  const v = present(dgs10).map((p) => p.v);
  const extras = { daysAbove5: streak(v, (x) => x > CORE11_LIMITS.dgs10), change5: changeOver(dgs10, 5), change20: changeOver(dgs10, 20) };
  return now.v > CORE11_LIMITS.dgs10
    ? judged(1, "risk", now.v, now.t, `${fmt(now.v)}% > 5%`, extras)
    : judged(1, "normal", now.v, now.t, `${fmt(now.v)}% ≤ 5%`, extras);
}

function judge2(dgs2?: readonly Point[], fedUpper?: readonly Point[]): Judgment {
  const two = latest(dgs2);
  const upper = two ? atOrBefore(fedUpper, two.t) : null;
  if (!two || !upper) return unknown(2, NO_DATA);
  const gap = r9(two.v - upper.v);
  const extras = { dgs2: two.v, fedUpper: upper.v, fedUpperAsOf: upper.t };
  return gap > CORE11_LIMITS.policyGap
    ? judged(2, "risk", gap, two.t, `${fmt(two.v)}% − ${fmt(upper.v)}% = ${sgn(gap)}%p > 0`, extras)
    : judged(2, "normal", gap, two.t, `${fmt(two.v)}% − ${fmt(upper.v)}% = ${sgn(gap)}%p ≤ 0`, extras);
}

function judge3(hy?: readonly Point[]): Judgment {
  const f = hyFigures(hy);
  if (!f) return unknown(3, NO_DATA);
  if (f.fromLow == null || f.low6m == null) return { ...unknown(3, "6개월 이력 부족", { now: f.now.v }), asOf: f.now.t };
  const { risk, caution } = CORE11_LIMITS.hy;
  const extras = {
    now: f.now.v,
    low6m: f.low6m,
    high6m: f.high6m,
    high20: f.high20,
    change5: f.change5,
    change20: f.change20,
    offHigh20: f.offHigh20,
    above35: f.now.v >= 3.5,
    above40: f.now.v >= 4.0,
  };
  const line = `${fmt(f.now.v)}% − 6개월 최저 ${fmt(f.low6m)}% = ${sgn(f.fromLow)}%p`;
  if (f.fromLow >= risk) return judged(3, "risk", f.fromLow, f.now.t, `${line} ≥ +0.5%p`, extras);
  if (f.fromLow >= caution) return judged(3, "caution", f.fromLow, f.now.t, `${line} (+0.3~0.5%p)`, extras);
  return judged(3, "normal", f.fromLow, f.now.t, `${line} < +0.3%p`, extras);
}

function judge4(usdjpy?: readonly Point[]): Judgment {
  const now = latest(usdjpy);
  if (!now) return unknown(4, NO_DATA);
  const m = monthChangePct(usdjpy);
  if (!m) return unknown(4, "1개월 전 값 없음");
  // appreciation of the yen: (a month ago ÷ now − 1) × 100
  const up = r9((m.then.v / m.now.v - 1) * 100);
  const { risk, caution } = CORE11_LIMITS.yen;
  const extras = { now: m.now.v, monthAgo: m.then.v, monthAgoAsOf: m.then.t };
  const line = `(${fmt(m.then.v)} ÷ ${fmt(m.now.v)} − 1) × 100 = ${sgn(up)}%`;
  if (up >= risk) return judged(4, "risk", up, now.t, `${line} ≥ 5%`, extras);
  if (up >= caution) return judged(4, "caution", up, now.t, `${line} (3~5%)`, extras);
  return judged(4, "normal", up, now.t, `${line} < 3%`, extras);
}

function judge5(unrate?: readonly Point[]): Judgment {
  const xs = present(unrate);
  const now = xs[xs.length - 1];
  if (!now) return unknown(5, NO_DATA);
  const prev = xs[xs.length - 2];
  const { base, risk } = CORE11_LIMITS.unrate;
  const overBase = r9(now.v - base);
  const extras = { prev: prev?.v ?? null, prevAsOf: prev?.t ?? null, base, overBase };
  if (overBase >= risk) return judged(5, "risk", now.v, now.t, `${fmt(now.v, 1)}% − 4.1% = ${sgn(overBase, 1)}%p ≥ +0.3%p`, extras);
  // not risk already; the missing prior release decides only between 🟡 and 🟢
  if (!prev) return { ...unknown(5, "직전 발표치 없음", { ...extras, now: now.v }, false), asOf: now.t };
  if (now.v > prev.v) return judged(5, "caution", now.v, now.t, `직전 ${fmt(prev.v, 1)}% → ${fmt(now.v, 1)}% 상승`, extras);
  return judged(5, "normal", now.v, now.t, `직전 ${fmt(prev.v, 1)}% → ${fmt(now.v, 1)}%, 4.1% 대비 ${sgn(overBase, 1)}%p`, extras);
}

/** a per-company indicator: risk if any company is risk, unknown if one is unknown and none is risk */
function perCompany(no: number, entries: [string, Point | null | undefined][], isRisk: (v: number) => boolean, unit: string): Judgment {
  const extras: Record<string, Extra> = {};
  const risks: string[] = [];
  const missing: string[] = [];
  for (const [id, p] of entries) {
    extras[id] = p?.v ?? null;
    extras[`${id}AsOf`] = p?.t ?? null;
    if (p?.v == null) missing.push(id);
    else if (isRisk(p.v)) risks.push(id);
  }
  extras.riskCount = risks.length;
  const asOf = oldest(...entries.map(([, p]) => (p?.v != null ? p.t : null)));
  const vals = entries.filter(([, p]) => p?.v != null).map(([id, p]) => `${id} ${sgn(p!.v!, 1)}${unit}`).join(", ");
  if (risks.length) {
    const worst = Math.min(...entries.filter(([id]) => risks.includes(id)).map(([, p]) => p!.v!));
    return judged(no, "risk", worst, asOf, `${vals} · 위험 기준: ${risks.join("·")}`, extras);
  }
  if (missing.length) return { ...unknown(no, `${missing.join("·")} 미확인${vals ? ` (${vals})` : ""}`, extras), asOf };
  const least = Math.min(...entries.map(([, p]) => p!.v!));
  return judged(no, "normal", least, asOf, vals, extras);
}

function judge7(breadth?: readonly Point[]): Judgment {
  const now = latest(breadth);
  if (!now) return unknown(7, NO_DATA);
  return now.v < CORE11_LIMITS.breadth
    ? judged(7, "risk", now.v, now.t, `${fmt(now.v, 1)}% < 60%`)
    : judged(7, "normal", now.v, now.t, `${fmt(now.v, 1)}% ≥ 60%`);
}

function judge8(m7: Core11Input["m7"]): Judgment {
  if (!m7) return unknown(8, NO_DATA);
  const down = M7.filter((id) => m7.down[id] === true);
  const notDown = M7.filter((id) => m7.down[id] === false);
  const missing = M7.filter((id) => m7.down[id] == null);
  const extras = { down: down.length, notDown: notDown.join(",") || null, missing: missing.join(",") || null };
  if (notDown.length) return judged(8, "normal", down.length, m7.t, `하향 아님: ${notDown.join("·")}`, extras);
  if (missing.length) return { ...unknown(8, `하향 ${down.length}/7, 미확인: ${missing.join("·")}`, extras), asOf: m7.t };
  return judged(8, "risk", 7, m7.t, "M7 7개 모두 이익 전망 하향", extras);
}

function judge9(daily: readonly Point[] | undefined, judgment: Core11Input["foreignSelling"]): Judgment {
  const f = netFlowFigures(daily);
  const extras: Record<string, Extra> = f ? { day: f.day, sum5: f.sum5, sum20: f.sum20, buyStreak: f.buyStreak, sellStreak: f.sellStreak, flowsAsOf: f.asOf } : {};
  // no 🔴 exists for indicator 9
  if (!judgment) return { ...unknown(9, "대규모 순매도 지속 여부 판단 없음", extras, false), asOf: f?.asOf ?? null };
  extras.basis = judgment.basis;
  return judgment.sustained
    ? judged(9, "caution", f?.sum20 ?? null, judgment.t, `대규모 순매도 지속: ${judgment.basis}`, extras)
    : judged(9, "normal", f?.sum20 ?? null, judgment.t, `대규모 순매도 지속 아님: ${judgment.basis}`, extras);
}

function judge10(mom?: readonly Point[]): Judgment {
  const now = latest(mom);
  if (!now) return unknown(10, NO_DATA);
  const { risk, caution } = CORE11_LIMITS.cpi;
  const v = r9(now.v);
  if (v >= risk) return judged(10, "risk", now.v, now.t, `MoM ${fmt(now.v, 1)}% ≥ 0.3%`);
  if (v >= caution) return judged(10, "caution", now.v, now.t, `MoM ${fmt(now.v, 1)}% (0.2~0.3%)`);
  return judged(10, "normal", now.v, now.t, `MoM ${fmt(now.v, 1)}% < 0.2%`);
}

export function judgeCore11(input: Core11Input): Core11Result {
  const items = [
    judge1(input.dgs10),
    judge2(input.dgs2, input.fedUpper),
    judge3(input.hy),
    judge4(input.usdjpy),
    judge5(input.unrate),
    perCompany(6, [["samsung", input.eps3m?.samsung], ["hynix", input.eps3m?.hynix]], (v) => v < CORE11_LIMITS.eps, "%"),
    judge7(input.breadth200),
    judge8(input.m7),
    judge9(input.foreignKospi, input.foreignSelling),
    judge10(input.coreCpiMoM),
    perCompany(11, CAPEX_COMPANIES.map((id) => [id, input.capex?.[id]] as [string, Point | null | undefined]), (v) => v < CORE11_LIMITS.capex, "%"),
  ];
  const counts: Record<Signal, number> = { normal: 0, caution: 0, risk: 0, unknown: 0 };
  for (const j of items) counts[j.signal]++;
  const hy = items[2]!.signal;
  return {
    items,
    counts,
    riskPossible: items.filter((j) => j.signal === "unknown" && j.mayBeRisk).length,
    hyRisk: hy === "risk" ? "met" : hy === "unknown" ? "unknown" : "unmet",
  };
}

/** the count of indicator-11 companies below 20 % as a condition of at least two (A5's A6) */
export function capexBelowTwo(input: Core11Input): { status: Tri; risk: number; missing: number } {
  let risk = 0;
  let missing = 0;
  for (const id of CAPEX_COMPANIES) {
    const p = input.capex?.[id];
    if (p?.v == null) missing++;
    else if (p.v < CORE11_LIMITS.capex) risk++;
  }
  return { status: risk >= 2 ? "met" : risk + missing >= 2 ? "unknown" : "unmet", risk, missing };
}
