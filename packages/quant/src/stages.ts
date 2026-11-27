/**
 * A5 and A6, the escape (risk) and recovery stages. Every condition is met, unmet or unknown; missing data never counts as
 * unmet. The escape stage is read from stage 4 down. When missing data could still make a higher stage hold, the result
 * keeps both ends ("최소 3단계, 4단계 여부 미확정") instead of settling on the lower one. A recovery count that fits no
 * stage exactly is "회복 신호 확인, 단계 판정 보류". When unknown signals leave more than one outcome possible, the
 * result lists them and settles on none.
 */
import { sma } from "./indicators";
import { capexBelowTwo, hyFigures, judgeCore11, type Core11Input, type Core11Result, type Extra } from "./risk11";
import { allOf, anyOf, atOrBefore, holds, inARow, latest, monthChangePct, present, r9, streak } from "./series";
import type { Point, Tri } from "./types";

/** the master prompt's conditions, word for word */
export const ESCAPE_A_RULES: Readonly<Record<string, string>> = {
  A1: "하이일드 `≥3.5%p` **또는** 6개월 최저 대비 `+1.0%p 이상` 확대",
  A2: "VIX 종가 `≥25` **2거래일 연속**",
  A3: "S&P500 종가가 200일선 **3거래일 연속 하회**",
  A4: "최근 근원 CPI MoM `≥0.3%`",
  A5: "미 10년물 `>5%` **10거래일 연속**",
  A6: "빅테크 **2개 이상** 내년 CAPEX 증가율 `<20%`",
  A7: "삼의 법칙 `≥0.3` **또는** 실업수당 4주 평균 `≥25만 건`",
  A8: "코스피 < 200일선 **AND** USD/KRW 1개월 `+5% 이상`",
};
export const ESCAPE_D_RULES: Readonly<Record<string, string>> = {
  D1: "하이일드 `≥4.0%p` **또는** 6개월 최저 대비 `+1.5%p 이상`",
  D2: "VIX 종가 `≥30` **3거래일 연속**",
  D3: "S&P500 50일선 < 200일선 **또는** 종가가 200일선보다 `5% 이상` 낮음",
  D4: "삼의 법칙 `≥0.5`",
  D5: "NFCI `≥0`",
};
export const RECOVERY_RULES: Readonly<Record<string, string>> = {
  R1: "VIX 종가 `<25` **5거래일 연속**",
  R2: "하이일드가 최근 고점 대비 `−0.5%p 이상` 축소 **또는** 6개월 최저 대비 확대 폭 `<+0.5%p`",
  R3: "S&P500 종가 > 200일선 **3거래일 연속**",
  R4: "S&P500 200일선 상회 종목 `≥60%`",
  R5: "2년물 `≤` 기준금리 상단 **또는** 근원 CPI MoM `≤0.2%`",
  R6: "외국인 코스피 **5거래일 연속 순매수** **또는** 코스피 > 200일선",
};
/** the stage names and conditions, word for word */
export const ESCAPE_STAGES: Readonly<Record<1 | 2 | 3 | 4, { name: string; rule: string; meaning: string }>> = {
  1: { name: "관찰", rule: "핵심 🔴 ≤2 AND 하이일드 🔴 아님", meaning: "일반 변동성 구간, 지속 관찰" },
  2: { name: "경계", rule: "핵심 🔴 ≥3 **OR** 하이일드 🔴", meaning: "신규 위험자산 진입 주의, 현금 비중·레버리지 점검" },
  3: { name: "방어 준비", rule: "2단계 조건 충족 **AND** A1~A8 중 **2개 이상**", meaning: "방어 계획 검토, 급반등 추격 금지, 레버리지 신규 진입 조건 강화" },
  4: { name: "회피", rule: "D1~D5 중 **2개 이상**", meaning: "위험자산 축소 검토, 레버리지 롱 신규 진입 보류, 신용·금융시스템 집중 감시" },
};
export const RECOVERY_STAGES: Readonly<Record<0 | 1 | 2 | 3, { name: string; rule: string }>> = {
  0: { name: "하락 진행", rule: "신호 0~1" },
  1: { name: "바닥 탐색", rule: "신호 2~3" },
  2: { name: "분할 재진입 검토", rule: "신호 ≥4 **AND** D신호 0개" },
  3: { name: "추세 회복", rule: "신호 ≥5 **AND R3 필수** **AND** 탈출 ≤2단계" },
};
export const RECOVERY_HOLD = "회복 신호 확인, 단계 판정 보류";

export interface StageInput extends Core11Input {
  /** VIX closes */
  vix?: readonly Point[];
  /** S&P 500 closes (at least 202 for the 200-day rules) */
  spx?: readonly Point[];
  /** FRED SAHMREALTIME */
  sahm?: readonly Point[];
  /** FRED IC4WSA, claims */
  claims4w?: readonly Point[];
  /** KOSPI closes */
  kospi?: readonly Point[];
  /** USD/KRW */
  usdkrw?: readonly Point[];
  /** FRED NFCI */
  nfci?: readonly Point[];
}

export interface Condition {
  id: string;
  rule: string;
  status: Tri;
  /** the figures behind the status */
  figures: Record<string, Extra>;
  /** the oldest date among the figures used */
  asOf: string | null;
}

/** closes with their 50- and 200-day averages */
function maFigures(points: readonly Point[] | undefined) {
  const xs = present(points);
  const c = xs.map((p) => p.v);
  const m200 = sma(c, 200);
  const m50 = sma(c, 50);
  const n = c.length;
  const last = n ? { t: xs[n - 1]!.t, close: c[n - 1]!, ma50: m50[n - 1] ?? null, ma200: m200[n - 1] ?? null } : null;
  /** the close against its 200-day average on each of the last `days` days, all passing `ok` */
  const daysVs200 = (days: number, ok: (close: number, ma: number) => boolean): Tri => {
    if (n < 200 + days - 1) return "unknown";
    for (let i = n - days; i < n; i++) if (!ok(c[i]!, m200[i]!)) return "unmet";
    return "met";
  };
  const dev200 = last?.ma200 != null ? r9((last.close / last.ma200 - 1) * 100) : null;
  return { last, daysVs200, dev200 };
}

const vals = (points: readonly Point[] | undefined) => present(points).map((p) => p.v);
const at = (points: readonly Point[] | undefined) => latest(points)?.t ?? null;
const oldestOf = (...ts: (string | null | undefined)[]) => ts.filter((t): t is string => !!t).sort()[0] ?? null;
const cond = (id: string, rule: string, status: Tri, figures: Record<string, Extra>, ...dates: (string | null | undefined)[]): Condition => ({
  id,
  rule,
  status,
  figures,
  asOf: oldestOf(...dates),
});

/** A1–A8 and D1–D5 */
export function escapeConditions(input: StageInput): { a: Condition[]; d: Condition[] } {
  const hy = hyFigures(input.hy);
  const spx = maFigures(input.spx);
  const kospi = maFigures(input.kospi);
  const vix = vals(input.vix);
  const cpi = latest(input.coreCpiMoM);
  const sahm = latest(input.sahm);
  const claims = latest(input.claims4w);
  const krw = monthChangePct(input.usdkrw);
  const capex = capexBelowTwo(input);
  const A = ESCAPE_A_RULES;
  const D = ESCAPE_D_RULES;
  const a = [
    cond("A1", A.A1!, anyOf(holds(hy?.now.v, (v) => v >= 3.5), holds(hy?.fromLow, (v) => v >= 1.0)), { hy: hy?.now.v ?? null, low6m: hy?.low6m ?? null, fromLow: hy?.fromLow ?? null }, hy?.now.t),
    cond("A2", A.A2!, inARow(vix, 2, (v) => v >= 25), { vix: vix.at(-1) ?? null, prev: vix.at(-2) ?? null }, at(input.vix)),
    cond("A3", A.A3!, spx.daysVs200(3, (c, m) => c < m), { close: spx.last?.close ?? null, ma200: spx.last?.ma200 ?? null }, spx.last?.t),
    cond("A4", A.A4!, holds(cpi?.v, (v) => r9(v) >= 0.3), { mom: cpi?.v ?? null }, cpi?.t),
    cond("A5", A.A5!, inARow(vals(input.dgs10), 10, (v) => v > 5), { dgs10: latest(input.dgs10)?.v ?? null }, at(input.dgs10)),
    cond("A6", A.A6!, capex.status, { below20: capex.risk, missing: capex.missing }, ...Object.values(input.capex ?? {}).map((p) => p?.t)),
    cond(
      "A7",
      A.A7!,
      anyOf(holds(sahm?.v, (v) => v >= 0.3), holds(claims?.v, (v) => v >= 250_000)),
      { sahm: sahm?.v ?? null, claims4w: claims?.v ?? null },
      sahm?.t,
      claims?.t,
    ),
    cond(
      "A8",
      A.A8!,
      allOf(holds(kospi.last?.ma200 != null ? kospi.last.close - kospi.last.ma200 : null, (v) => v < 0), holds(krw?.pct, (v) => v >= 5)),
      { kospi: kospi.last?.close ?? null, ma200: kospi.last?.ma200 ?? null, usdkrw1m: krw?.pct ?? null },
      kospi.last?.t,
      krw?.now.t,
    ),
  ];
  const d = [
    cond("D1", D.D1!, anyOf(holds(hy?.now.v, (v) => v >= 4.0), holds(hy?.fromLow, (v) => v >= 1.5)), { hy: hy?.now.v ?? null, low6m: hy?.low6m ?? null, fromLow: hy?.fromLow ?? null }, hy?.now.t),
    cond("D2", D.D2!, inARow(vix, 3, (v) => v >= 30), { vix: vix.at(-1) ?? null }, at(input.vix)),
    cond(
      "D3",
      D.D3!,
      anyOf(holds(spx.last?.ma50 != null && spx.last.ma200 != null ? spx.last.ma50 - spx.last.ma200 : null, (v) => v < 0), holds(spx.dev200, (v) => v <= -5)),
      { ma50: spx.last?.ma50 ?? null, ma200: spx.last?.ma200 ?? null, dev200: spx.dev200 },
      spx.last?.t,
    ),
    cond("D4", D.D4!, holds(sahm?.v, (v) => v >= 0.5), { sahm: sahm?.v ?? null }, sahm?.t),
    cond("D5", D.D5!, holds(latest(input.nfci)?.v, (v) => v >= 0), { nfci: latest(input.nfci)?.v ?? null }, at(input.nfci)),
  ];
  return { a, d };
}

/** R1–R6 */
export function recoverySignals(input: StageInput): Condition[] {
  const hy = hyFigures(input.hy);
  const spx = maFigures(input.spx);
  const kospi = maFigures(input.kospi);
  const vix = vals(input.vix);
  const breadth = latest(input.breadth200);
  const two = latest(input.dgs2);
  const upper = two ? atOrBefore(input.fedUpper, two.t) : null;
  const cpi = latest(input.coreCpiMoM);
  const flows = vals(input.foreignKospi);
  const R = RECOVERY_RULES;
  return [
    cond("R1", R.R1!, inARow(vix, 5, (v) => v < 25), { vix: vix.at(-1) ?? null }, at(input.vix)),
    cond(
      "R2",
      R.R2!,
      anyOf(holds(hy?.offHigh20, (v) => v >= 0.5), holds(hy?.fromLow, (v) => v < 0.5)),
      { hy: hy?.now.v ?? null, high20: hy?.high20 ?? null, offHigh20: hy?.offHigh20 ?? null, fromLow: hy?.fromLow ?? null },
      hy?.now.t,
    ),
    cond("R3", R.R3!, spx.daysVs200(3, (c, m) => c > m), { close: spx.last?.close ?? null, ma200: spx.last?.ma200 ?? null }, spx.last?.t),
    cond("R4", R.R4!, holds(breadth?.v, (v) => v >= 60), { breadth: breadth?.v ?? null }, breadth?.t),
    cond(
      "R5",
      R.R5!,
      anyOf(holds(two && upper ? r9(two.v - upper.v) : null, (v) => v <= 0), holds(cpi?.v, (v) => r9(v) <= 0.2)),
      { dgs2: two?.v ?? null, fedUpper: upper?.v ?? null, mom: cpi?.v ?? null },
      two?.t,
      cpi?.t,
    ),
    cond(
      "R6",
      R.R6!,
      anyOf(inARow(flows, 5, (v) => v > 0), holds(kospi.last?.ma200 != null ? kospi.last.close - kospi.last.ma200 : null, (v) => v > 0)),
      {
        foreignDay: flows.at(-1) ?? null,
        // the run inARow counts, for the line (DD 2012 1): days in a row of net buying, of net selling
        foreignBuyRun: flows.length ? streak(flows, (v) => v > 0) : null,
        foreignSellRun: flows.length ? streak(flows, (v) => v < 0) : null,
        kospi: kospi.last?.close ?? null,
        ma200: kospi.last?.ma200 ?? null,
      },
      at(input.foreignKospi),
      kospi.last?.t,
    ),
  ];
}

const count = (cs: readonly Condition[], s: Tri) => cs.filter((c) => c.status === s).length;

/** the escape stage's possible range below stage 4, from the core risks and A1–A8 */
function below4(core: Core11Result, a: readonly Condition[]) {
  const risk = core.counts.risk;
  const s2def = risk >= 3 || core.hyRisk === "met";
  const s2pos = risk + core.riskPossible >= 3 || core.hyRisk !== "unmet";
  const aMet = count(a, "met");
  const aPos = aMet + count(a, "unknown");
  return { floor: s2def && aMet >= 2 ? 3 : s2def ? 2 : 1, ceiling: s2pos && aPos >= 2 ? 3 : s2pos ? 2 : 1 } as const;
}

export type EscapeLevel = 1 | 2 | 3 | 4;

export interface EscapeStage {
  /** the highest stage that surely holds */
  floor: EscapeLevel;
  /** the highest stage that may hold once the unknowns are known */
  ceiling: EscapeLevel;
  confirmed: boolean;
  label: string;
  /** A1–A8 met and unknown, D1–D5 met and unknown */
  gauges: { a: { met: number; unknown: number; of: 8 }; d: { met: number; unknown: number; of: 5 } };
  /** the unknown conditions that could raise the stage (core indicators by number, A and D by id) */
  open: string[];
}

export function escapeLabel(floor: EscapeLevel, ceiling: EscapeLevel): string {
  if (floor === ceiling) return `${floor}단계 ${ESCAPE_STAGES[floor].name}`;
  const up = ceiling === floor + 1 ? `${ceiling}단계` : `${floor + 1}~${ceiling}단계`;
  return `최소 ${floor}단계, ${up} 여부 미확정`;
}

export function escapeStage(core: Core11Result, a: readonly Condition[], d: readonly Condition[]): EscapeStage {
  const b = below4(core, a);
  const dMet = count(d, "met");
  const dUnk = count(d, "unknown");
  const floor: EscapeLevel = dMet >= 2 ? 4 : b.floor;
  const ceiling: EscapeLevel = dMet + dUnk >= 2 ? 4 : b.ceiling;
  const open: string[] = [];
  if (ceiling > floor) {
    if (ceiling === 4 && floor < 4) open.push(...d.filter((c) => c.status === "unknown").map((c) => c.id));
    if (b.ceiling >= 2 && b.floor < 2) open.push(...core.items.filter((j) => j.signal === "unknown" && j.mayBeRisk).map((j) => `#${j.no}`));
    if (b.ceiling === 3 && b.floor < 3) open.push(...a.filter((c) => c.status === "unknown").map((c) => c.id));
  }
  return {
    floor,
    ceiling,
    confirmed: floor === ceiling,
    label: escapeLabel(floor, ceiling),
    gauges: { a: { met: count(a, "met"), unknown: count(a, "unknown"), of: 8 }, d: { met: dMet, unknown: dUnk, of: 5 } },
    open: [...new Set(open)],
  };
}

export type RecoveryOutcome = 0 | 1 | 2 | 3 | "hold";

export interface RecoveryStage {
  /** the stage, "hold", or null when the unknowns leave more than one outcome */
  stage: RecoveryOutcome | null;
  possible: RecoveryOutcome[];
  /** the unknowns that keep it open: R and D signals by id, and the escape stage's own open conditions */
  open: string[];
  label: string;
  gauge: { met: number; unknown: number; of: 6 };
}

/** A6's table, read from the top: 3, then 2, then the count bands; a count that fits none is "hold" */
export function recoveryOutcome(signals: number, r3: boolean, dZero: boolean, escapeAtMost2: boolean): RecoveryOutcome {
  if (signals >= 5 && r3 && escapeAtMost2) return 3;
  if (signals >= 4 && dZero) return 2;
  if (signals >= 2 && signals <= 3) return 1;
  if (signals <= 1) return 0;
  return "hold";
}

const outcomeLabel = (o: RecoveryOutcome) => (o === "hold" ? RECOVERY_HOLD : `${o}단계 ${RECOVERY_STAGES[o].name}`);

/** every assignment of the unknown R signals, D signals and core/A unknowns is tried; one outcome settles the stage */
export function recoveryStage(r: readonly Condition[], core: Core11Result, a: readonly Condition[], d: readonly Condition[]): RecoveryStage {
  const r3 = r.find((c) => c.id === "R3")?.status ?? "unknown";
  const rMet = count(r, "met");
  const rUnk = count(r, "unknown");
  const otherMet = rMet - (r3 === "met" ? 1 : 0);
  const otherUnk = rUnk - (r3 === "unknown" ? 1 : 0);
  const b = below4(core, a);
  const dMet = count(d, "met");
  const dUnk = count(d, "unknown");
  const seen = new Set<RecoveryOutcome>();
  for (const r3v of r3 === "unknown" ? [true, false] : [r3 === "met"])
    for (let k = 0; k <= otherUnk; k++)
      for (let dc = dMet; dc <= dMet + dUnk; dc++) {
        // the escape stage with dc D signals met: 4 at two or more, else somewhere in the range below 4
        const escOk = dc >= 2 ? [false] : b.floor <= 2 && b.ceiling >= 3 ? [true, false] : [b.ceiling <= 2];
        for (const e of escOk) seen.add(recoveryOutcome(otherMet + k + (r3v ? 1 : 0), r3v, dc === 0, e));
      }
  const order: RecoveryOutcome[] = [0, 1, 2, 3, "hold"];
  const possible = order.filter((o) => seen.has(o));
  const gauge = { met: rMet, unknown: rUnk, of: 6 as const };
  if (possible.length === 1) return { stage: possible[0]!, possible, open: [], label: outcomeLabel(possible[0]!), gauge };
  const esc = escapeStage(core, a, d);
  const open = [...new Set([...r.filter((c) => c.status === "unknown").map((c) => c.id), ...d.filter((c) => c.status === "unknown").map((c) => c.id), ...esc.open])];
  const names = possible.map((o) => (o === "hold" ? "판정 보류" : `${o}단계`)).join("·");
  return { stage: null, possible, open, label: `회복 단계 미확정(가능: ${names}, 미확인: ${open.join("·")})`, gauge };
}

/** the whole A2 → A5 → A6 reading from one input */
export function assessStages(input: StageInput) {
  const core = judgeCore11(input);
  const { a, d } = escapeConditions(input);
  const r = recoverySignals(input);
  return { core, a, d, r, escape: escapeStage(core, a, d), recovery: recoveryStage(r, core, a, d) };
}
