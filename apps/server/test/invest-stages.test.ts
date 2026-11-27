/**
 * Invest B2b-2: the stage reading over the macro series. The server gathers the inputs (FRED for rates, credit, jobs,
 * CPI, VIX, the S&P 500, FX and conditions; Yahoo for KOSPI; the person's own ledger for 6, 7 and 11) and
 * @pickle/quant judges. Bodies are synthetic (test/fake-toss.ts); nothing real is called.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { InvestOverview, InvestStagesDetail } from "@pickle/protocol";
import { pct } from "@pickle/quant";
import { etToEpoch } from "../src/invest/calendar.ts";
import * as idb from "../src/invest/db.ts";
import { writeLedger } from "../src/invest/ledger.ts";
import { pctChange } from "../src/invest/stage-ledger.ts";
import { FRED_FEEDS, readStages, recoveryHead, type Assessed } from "../src/invest/stages.ts";
import { investTools } from "../src/invest/tools.ts";
import { makeInvestUpstream, syntheticBars } from "./fake-toss.ts";
import { makeHarness, type Harness } from "./helpers.ts";

const DAY = "2026-11-30";
const LAST = "2026-11-27";
const ET = (h: number, m: number, day = DAY) => etToEpoch(day, h, m);

const harnesses: Harness[] = [];
afterEach(async () => {
  while (harnesses.length) await harnesses.pop()!.close();
});

/** weekdays from `from` to LAST */
function weekdays(from: string): string[] {
  const out: string[] = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${LAST}T00:00:00Z`); t += 86_400_000) {
    const d = new Date(t);
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) out.push(d.toISOString().slice(0, 10));
  }
  return out;
}
/** the first of each month from `from` to LAST's month */
function months(from: string): string[] {
  const out: string[] = [];
  let [y, m] = from.split("-").map(Number) as [number, number];
  while (`${y}-${String(m).padStart(2, "0")}` <= LAST.slice(0, 7)) {
    out.push(`${y}-${String(m).padStart(2, "0")}-01`);
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }
  return out;
}
const csv = (id: string, rows: [string, number | null][]) => `observation_date,${id}\n${rows.map(([t, v]) => `${t},${v ?? ""}`).join("\n")}\n`;

/** a calm market but for credit and CPI: HY up 0.6%p on the last day, core CPI +0.3% a month */
function calm(): Map<string, string | number> {
  const days = weekdays("2025-10-01");
  const flat = (v: number) => days.map((t): [string, number] => [t, v]);
  const fred = new Map<string, string | number>();
  fred.set("DGS10", csv("DGS10", flat(4.5)));
  fred.set("DGS2", csv("DGS2", flat(4)));
  fred.set("DFEDTARU", csv("DFEDTARU", flat(4.25)));
  fred.set("BAMLH0A0HYM2", csv("BAMLH0A0HYM2", days.map((t, i): [string, number] => [t, i === days.length - 1 ? 3.6 : 3])));
  fred.set("DEXJPUS", csv("DEXJPUS", flat(150)));
  fred.set("UNRATE", csv("UNRATE", months("2024-01").map((t): [string, number] => [t, 4.1])));
  fred.set("CPILFESL", csv("CPILFESL", months("2024-01").map((t, i): [string, number] => [t, Number((300 * 1.003 ** i).toFixed(3))])));
  fred.set("VIXCLS", csv("VIXCLS", flat(20)));
  fred.set("SP500", csv("SP500", days.map((t, i): [string, number] => [t, 5000 + i * 3])));
  fred.set("SAHMREALTIME", csv("SAHMREALTIME", months("2024-01").map((t): [string, number] => [t, 0.1])));
  fred.set("IC4WSA", csv("IC4WSA", days.filter((_, i) => i % 5 === 4).map((t): [string, number] => [t, 220_000])));
  fred.set("DEXKOUS", csv("DEXKOUS", flat(1350)));
  fred.set("NFCI", csv("NFCI", days.filter((_, i) => i % 5 === 4).map((t): [string, number] => [t, -0.5])));
  return fred;
}

async function world(fred: Map<string, string | number>, o: { sources?: boolean } = {}) {
  const up = makeInvestUpstream();
  for (const [k, v] of fred) up.state.fred.set(k, v);
  up.state.yahooDaily.set("^KS11", syntheticBars(LAST, 260, 2500, 30));
  const h = await makeHarness({ now: ET(9, 0), config: { invest: { sources: o.sources ?? true, tossBase: null, outboundIp: null } }, deps: () => ({ investFetch: up.fetch }) });
  harnesses.push(h);
  return { h, up };
}

/** quiet: no core risk, nothing met; only the indicators nobody can give yet keep stage 2 open */
function quiet(): Map<string, string | number> {
  const fred = calm();
  const days = weekdays("2025-10-01");
  fred.set("BAMLH0A0HYM2", csv("BAMLH0A0HYM2", days.map((t): [string, number] => [t, 3])));
  fred.set("CPILFESL", csv("CPILFESL", months("2024-01").map((t, i): [string, number] => [t, Number((300 * 1.001 ** i).toFixed(3))])));
  return fred;
}

const KST = (y: number, mo: number, d: number, hh = 9, mi = 0) => Date.UTC(y, mo - 1, d, hh - 9, mi);
async function people(h: Harness) {
  const a = await h.signup("alice");
  const b = await h.signup("bob");
  idb.ensureSettings(h.db, a.session.user.id, h.clock.t); // alice uses invest; bob does not
  const get = async <T>(token: string, path: string) => (await (await h.req("GET", path, { token })).json()) as T;
  return {
    alice: { id: a.session.user.id, overview: () => get<InvestOverview>(a.token, "/api/invest"), detail: () => get<InvestStagesDetail>(a.token, "/api/invest/stages") },
    bob: { id: b.session.user.id, overview: () => get<InvestOverview>(b.token, "/api/invest"), detail: () => get<InvestStagesDetail>(b.token, "/api/invest/stages") },
  };
}
async function judgeAt(h: Harness, at: number) {
  h.clock.t = at;
  return h.app.core.invest.judgeStages(at);
}
const rows = (h: Harness) => h.db.sql.query("SELECT user_id, day, at FROM invest_judgments ORDER BY day, user_id").all() as { user_id: string; day: string; at: number }[];

describe("the stage reading's inputs", () => {
  test("every FRED series feeds its input once, KOSPI comes from Yahoo, each with its day, source and grade; quant judges", async () => {
    const { h, up } = await world(calm());
    const s = await readStages(h.app.core);
    // one call per series, every FRED id the stages use and nothing else
    const ids = up.calls.filter((c) => c.host === "fred.stlouisfed.org").map((c) => new URL(`https://x${c.path}`).searchParams.get("id"));
    expect(ids.sort()).toEqual(Object.values(FRED_FEEDS).sort());
    expect(up.calls.filter((c) => c.host === "query1.finance.yahoo.com")).toHaveLength(1);
    expect(s.basis.dgs10).toEqual({ asOf: LAST, source: "FRED", grade: "A" });
    expect(s.basis.coreCpiMoM).toEqual({ asOf: "2026-11-01", source: "FRED", grade: "A" });
    // KOSPI: Yahoo's daily closes on Korean market days
    expect(s.input.kospi).toHaveLength(260);
    expect(s.basis.kospi).toEqual({ asOf: s.input.kospi!.at(-1)!.t, source: "Yahoo(지연 시세)", grade: "B+" });
    // CPI comes in as the month-over-month change, rounded as BLS rounds it
    expect(s.input.coreCpiMoM!.at(-1)).toEqual({ t: "2026-11-01", v: 0.3 });
    const core = Object.fromEntries(s.core.items.map((j) => [j.no, [j.signal, j.value]]));
    expect(core[1]).toEqual(["normal", 4.5]);
    expect(core[3]![0]).toBe("risk");
    expect(core[10]).toEqual(["risk", 0.3]);
    for (const no of [6, 7, 11]) expect(core[no]![0]).toBe("unknown");
    const a = Object.fromEntries(s.a.map((c) => [c.id, c.status]));
    expect(a).toMatchObject({ A1: "met", A2: "unmet", A3: "unmet", A4: "met", A5: "unmet", A6: "unknown", A7: "unmet", A8: "unmet" });
    expect(s.d.map((c) => c.status)).toEqual(["unmet", "unmet", "unmet", "unmet", "unmet"]);
    expect(s.escape).toMatchObject({ floor: 3, ceiling: 3, confirmed: true, label: "3단계 방어 준비" });
  });

  test("a series that cannot be read leaves its input out: what rests on it is unknown, never unmet", async () => {
    const fred = calm();
    fred.set("VIXCLS", 404);
    fred.set("NFCI", "observation_date,NFCI\n");
    const { h } = await world(fred);
    const s = await readStages(h.app.core);
    expect([s.basis.vix, s.basis.nfci, s.input.vix, s.input.nfci]).toEqual([null, null, undefined, undefined]);
    const st = (id: string) => [...s.a, ...s.d, ...s.r].find((c) => c.id === id)!.status;
    expect([st("A2"), st("D2"), st("D5"), st("R1")]).toEqual(["unknown", "unknown", "unknown", "unknown"]);
    // two D signals unknown: stage 4 may still hold
    expect(s.escape).toMatchObject({ floor: 3, ceiling: 4, confirmed: false, label: "최소 3단계, 4단계 여부 미확정" });
  });
});

describe("the day's judgment (v12)", () => {
  test("from 08:00 KST once a day, for the people who use invest; one read serves them all; the board says none, then judged, then how it moved", async () => {
    const { h, up } = await world(calm());
    const { alice, bob } = await people(h);
    h.clock.t = KST(2026, 12, 1, 7, 0);
    expect((await alice.overview()).stages).toEqual({ kind: "none", none: "첫 판정은 오늘 08:00에 나와요." });
    expect(await judgeAt(h, KST(2026, 12, 1, 7, 59))).toBe(0);
    expect(up.calls).toHaveLength(0);
    expect(await judgeAt(h, KST(2026, 12, 1, 8, 0))).toBe(1);
    expect(await judgeAt(h, KST(2026, 12, 1, 8, 0, ) + 30_000)).toBe(0);
    expect(rows(h)).toEqual([{ user_id: alice.id, day: "2026-12-01", at: KST(2026, 12, 1, 8, 0) }]);
    const fredReads = up.calls.filter((c) => c.host === "fred.stlouisfed.org").length;
    expect(fredReads).toBe(Object.keys(FRED_FEEDS).length);
    const st = (await alice.overview()).stages;
    expect(st).toEqual({
      kind: "judged",
      escape: { stage: 3, name: "방어 준비", text: "탈출 3단계" },
      recovery: expect.objectContaining({ stage: expect.anything() }),
      gauges: [
        expect.objectContaining({ key: "worse", label: "악화 신호", met: 2, of: 8, unknown: 1, aria: "악화 신호 8개 중 2개 충족, 확인 불가 1개" }),
        expect.objectContaining({ key: "severe", label: "심각 신호", met: 0, of: 5, unknown: 0, aria: "심각 신호 5개 중 0개 충족" }),
        expect.objectContaining({ key: "recover", label: "회복 신호", of: 6 }),
      ],
      next: expect.arrayContaining(["탈출 4단계까지: 심각 신호 2개 더"]),
      judgedAt: KST(2026, 12, 1, 8, 0),
      judgedText: "12월 1일 08:00 판정",
    });
    // bob does not use invest: no row, the first-judgment sentence (now past 08:00, the next beat makes it)
    expect((await bob.overview()).stages).toEqual({ kind: "none", none: "첫 판정은 곧 나와요." });
    // the next day: the same reading, said so; a day missed is named; a missed 08:00 is stale until it comes
    await judgeAt(h, KST(2026, 12, 2, 8, 0));
    expect(((await alice.overview()).stages as { judgedText: string }).judgedText).toBe("12월 2일 08:00 판정 · 어제와 같아요");
    // DD 0710: before the next 08:00 nothing is stale, and 어제 is said only on the judged day (to the reader, 어제 is 12월 2일)
    h.clock.t = KST(2026, 12, 3, 7, 0);
    const early = (await alice.overview()).stages as { stale?: string; judgedText: string };
    expect([early.stale, early.judgedText]).toEqual([undefined, "12월 2일 08:00 판정 · 12월 1일 판정과 같아요"]);
    h.clock.t = KST(2026, 12, 4, 9, 0);
    const late = (await alice.overview()).stages as { stale?: string; judgedText: string };
    expect(late.stale).toBe("오늘 08:00 판정을 하지 못했어요. 12월 2일 판정이에요.");
    expect(late.judgedText).toBe("12월 2일 08:00 판정 · 12월 1일 판정과 같아요");
    await judgeAt(h, KST(2026, 12, 4, 9, 0));
    const caught = (await alice.overview()).stages as { stale?: string; judgedText: string };
    expect([caught.stale, caught.judgedText]).toEqual([undefined, "12월 4일 09:00 판정 · 12월 2일 판정과 같아요"]);
  });

  test("a day of another KST year is named with its year (DD 0710 2, DD 0405 E)", async () => {
    const { h } = await world(calm());
    const { alice } = await people(h);
    await judgeAt(h, KST(2026, 12, 30, 8, 0));
    await judgeAt(h, KST(2026, 12, 31, 8, 0));
    expect(((await alice.overview()).stages as { judgedText: string }).judgedText).toBe("12월 31일 08:00 판정 · 어제와 같아요");
    h.clock.t = KST(2027, 1, 1, 7, 0);
    const early = (await alice.overview()).stages as { stale?: string; judgedText: string };
    expect([early.stale, early.judgedText]).toEqual([undefined, "2026년 12월 31일 08:00 판정 · 2026년 12월 30일 판정과 같아요"]);
    // DD 0731 E5: on the same screen the as-of days take their year by the reading time too
    expect((await alice.detail()).core11.find((r) => r.no === 1)?.basis).toBe("2026년 11월 27일 · FRED · A");
    h.clock.t = KST(2027, 1, 1, 9, 0);
    expect(((await alice.overview()).stages as { stale?: string }).stale).toBe("오늘 08:00 판정을 하지 못했어요. 2026년 12월 31일 판정이에요.");
    await judgeAt(h, KST(2027, 1, 1, 9, 0));
    expect(((await alice.overview()).stages as { judgedText: string }).judgedText).toBe("1월 1일 09:00 판정 · 어제와 같아요");
    // an as-of day of the year before the judgment names its year too
    expect((await alice.detail()).core11.find((r) => r.no === 1)?.basis).toBe("2026년 11월 27일 · FRED · A");
  });

  test("a stage that moved is said with its old and new number", async () => {
    const { h, up } = await world(quiet());
    const { alice } = await people(h);
    await judgeAt(h, KST(2026, 12, 1, 8, 0));
    expect(((await alice.overview()).stages as { escape: { text: string } }).escape.text).toBe("탈출 최소 1단계");
    // the next day credit widens and CPI runs hot (calm): 3단계
    for (const [k, v] of calm()) up.state.fred.set(k, v);
    await judgeAt(h, KST(2026, 12, 2, 8, 0) + 7 * 3_600_000); // past the 6-hour FRED cache
    expect(((await alice.overview()).stages as { judgedText: string }).judgedText).toBe("12월 2일 15:00 판정 · 탈출 최소 1단계 → 탈출 3단계 · 회복 최소 2 → 1단계");
  });

  test("sources off: no judgment, ever; the board says so", async () => {
    const { h, up } = await world(calm(), { sources: false });
    const { alice } = await people(h);
    expect(await judgeAt(h, KST(2026, 12, 1, 8, 0))).toBe(0);
    expect([rows(h), up.calls]).toEqual([[], []]);
    const OFF = "지금은 지표를 받지 않아서 단계를 판정하지 않아요."; // DD 0710 D10: the words, not the constant
    expect((await alice.overview()).stages).toEqual({ kind: "off", off: OFF });
    expect(await alice.detail()).toEqual({ stages: { kind: "off", off: OFF }, core11: [], groups: [], method: expect.any(Array), disclaimer: true });
  });
});

describe("why a stage is not settled (DD 0426 §1)", () => {
  const head = async (fred: Map<string, string | number>) => {
    const { h } = await world(fred);
    const { alice } = await people(h);
    await judgeAt(h, KST(2026, 12, 1, 8, 0));
    return (await alice.overview()).stages as { escape: { stage: number; floor?: boolean; text: string; pending?: string; pendingTone?: string } };
  };
  test("nowhere to get it yet: quiet; a source that did not answer: caution; both: caution; counts, never indicator numbers", async () => {
    const q = (await head(quiet())).escape;
    expect(q).toEqual({ stage: 1, floor: true, text: "탈출 최소 1단계", pending: "지표 4개 값이 없어서 2단계 여부는 아직 몰라요.", pendingTone: "quiet" });
    const c = calm();
    c.set("VIXCLS", 404);
    c.set("NFCI", 404); // two severe signals unknown: stage 4 may hold
    const t = (await head(c)).escape;
    expect(t).toEqual({ stage: 3, floor: true, text: "탈출 최소 3단계", pending: "오늘 지표 2개를 받지 못해서 4단계 여부는 아직 몰라요.", pendingTone: "caution" });
    const m = quiet();
    m.set("DGS10", 404);
    const both = (await head(m)).escape;
    expect(both).toEqual({ stage: 1, floor: true, text: "탈출 최소 1단계", pending: "지표 4개 값이 없고 오늘 1개를 받지 못해서 2~3단계 여부는 아직 몰라요.", pendingTone: "caution" });
    for (const p of [q.pending, t.pending, both.pending]) expect(p).not.toMatch(/\d+[·번]|#\d/);
  });

  test("DD 0428 §1: recovery outcomes {1, hold} → 미확정, {1, 2} → 최소 1단계, {2} → the stage and its name; hold itself", () => {
    const gauge = { met: 3, unknown: 1, of: 6 as const };
    const r = (stage: unknown, possible: unknown[]) => recoveryHead({ recovery: { stage, possible, open: ["R4"], label: "", gauge } } as unknown as Assessed, (k) => (k === "breadth200" ? "none" : null));
    expect(r(null, [1, "hold"])).toEqual({ stage: null, text: "회복 단계 미확정", pending: "지표 1개 값이 없어서 회복 단계는 아직 몰라요.", pendingTone: "quiet" });
    expect(r(null, [1, 2])).toEqual({ stage: 1, floor: true, text: "회복 최소 1단계", pending: "지표 1개 값이 없어서 회복 단계는 아직 몰라요.", pendingTone: "quiet" });
    expect(r(2, [2])).toEqual({ stage: 2, name: "분할 재진입 검토", text: "회복 2단계" });
    expect(r("hold", ["hold"])).toEqual({ stage: null, text: "회복 판정 보류", pending: "회복 신호는 3개지만 심각 신호가 있어서 맞는 단계가 없어요.", pendingTone: "caution" });
  });
});

describe("`11지표와 단계 조건` and the agent's invest_snapshot", () => {
  test("eleven rows with value, basis and reason; three groups of conditions with state words and figures; the method; A17", async () => {
    const { h } = await world(calm());
    const { alice, bob } = await people(h);
    await judgeAt(h, KST(2026, 12, 1, 8, 0));
    const d = await alice.detail();
    expect(d.core11).toHaveLength(11);
    const row = (no: number) => d.core11.find((r) => r.no === no)!;
    expect(row(1)).toEqual({ no: 1, name: "미국 10년물 금리", signal: "normal", value: "4.50%", basis: "11월 27일 · FRED · A", reason: "4.50% ≤ 5%" });
    expect(row(3)).toMatchObject({ signal: "risk", value: "3.60%" });
    expect(row(10)).toMatchObject({ signal: "risk", value: "0.3%", basis: "11월 1일 · FRED · A" });
    // 6, 7, 8 and 11 come from the person's ledger (값이 없어요 until a figure is in it); 9 has nowhere yet
    for (const no of [6, 7, 8, 11]) expect(row(no)).toMatchObject({ signal: "unknown", value: null, basis: "값이 없어요" });
    expect(row(9)).toMatchObject({ signal: "unknown", value: null, basis: "받을 곳이 아직 없어요" });
    expect(d.groups.map((g) => [g.key, g.title, g.rows.length])).toEqual([
      ["worse", "악화 신호 A1–A8", 8],
      ["severe", "심각 신호 D1–D5", 5],
      ["recover", "회복 신호 R1–R6", 6],
    ]);
    const a2 = d.groups[0]!.rows.find((r) => r.id === "A2")!;
    expect(a2).toEqual({ id: "A2", text: "VIX 종가 25 이상 2거래일 연속", state: "unmet", stateText: "미충족", detail: "20.00 · 11월 27일 · FRED · A" });
    expect(d.groups[0]!.rows.find((r) => r.id === "A6")).toMatchObject({ state: "unknown", stateText: "확인 불가", detail: "값이 없어요" });
    expect(d.groups[0]!.rows.find((r) => r.id === "A1")!.detail).toBe("3.60% · 6개월 최저보다 +0.60%p · 11월 27일 · FRED · A");
    expect(d.groups.map((g) => g.next)).toEqual(["2단계 조건에 악화 신호가 2개 이상이면 탈출 3단계예요. 지금 2개예요.", "심각 신호가 2개 이상이면 탈출 4단계예요. 지금 0개예요.", expect.any(String)]);
    expect(d.method.length).toBeGreaterThan(3);
    // DD 0710 D13: the stale rule in its numbers (120 days, 5 US trading days)
    expect(d.method).toContain("원장 값은 등급 C를 쓰지 않아요. 이익 전망, M7, 설비투자 값은 기준일이 120일, 시장 폭은 5거래일을 넘으면 확인 불가예요.");
    expect(d.disclaimer).toBe(true);
    expect(JSON.stringify(d)).not.toMatch(/\*\*|`/); // the master prompt's marks never reach the screen
    // bob: no row of his own
    expect((await bob.detail()).core11).toEqual([]);
  });

  test("invest_snapshot gives the judged words as they are, nothing worked out anew", async () => {
    const { h } = await world(calm());
    const { alice } = await people(h);
    const tool = investTools(h.app.core, alice.id).find((t) => t.name === "invest_snapshot")!;
    expect(tool.description).toContain("단계는 판정본만 말해요. 지금 값은 값으로만 말해요."); // team-lead 0437 2
    // DD 0717 1: off is the server's setting: nothing to turn on, no promise to tell later
    expect(tool.description).toContain("When the board is off, that is how this server is set up, not a setting the person can change: do not ask them to turn anything on, and do not promise to check again or tell them later.");
    const ctx = { userId: alice.id, threadId: null, now: () => new Date(h.clock.t) } as never;
    h.clock.t = KST(2026, 12, 1, 7, 0);
    expect(await tool.run({}, ctx)).toEqual({ ok: true, summary: "첫 판정은 오늘 08:00에 나와요.", data: { stages: { kind: "none", none: "첫 판정은 오늘 08:00에 나와요." } } });
    await judgeAt(h, KST(2026, 12, 1, 8, 0));
    const out = await tool.run({}, ctx);
    expect(out.ok).toBe(true);
    expect(out.summary).toMatch(/^탈출 3단계 · 회복 /);
    const data = out.data as { stages: { escape: unknown }; core11: unknown[]; conditions: { rows: unknown[] }[] };
    expect(data.stages.escape).toEqual({ stage: 3, name: "방어 준비", text: "탈출 3단계" });
    expect(data.core11).toEqual((await alice.detail()).core11);
    expect(data.conditions.map((c) => c.rows.length)).toEqual([8, 5, 6]);
  });
});

describe("6, 7 and 11 from the person's ledger (team-lead 0437 1a)", () => {
  /** a figure the person put in their ledger */
  const put = (h: Harness, uid: string, id: string, asOf: string, value: number, o: { unit?: string; grade?: string; source?: string } = {}) =>
    writeLedger(h.db, uid, { id, asOf, value, unit: o.unit ?? "pct", definition: "테스트 값", source: o.source ?? "예시 증권", sourceTier: "T2", confidence: o.grade ?? "B+" }, "person", h.clock.t);
  const rowsOf = (h: Harness) => h.db.sql.query("SELECT * FROM invest_ledger ORDER BY user_id, id, as_of").all();

  test("6: the fiscal year holding the middle of the next 12 months, against its own figure 3 months back (±15 days, the nearest); grade C and other years left out; −5% is not below −5%", async () => {
    const { h } = await world(calm());
    const { alice } = await people(h);
    h.clock.t = KST(2026, 12, 1, 7, 0); // FY 2027 (12-01 + 6 months)
    put(h, alice.id, "stage.eps.samsung.2027", "2026-08-20", 110, { unit: "krw" }); // 5 days off 08-25
    put(h, alice.id, "stage.eps.samsung.2027", "2026-08-28", 104, { unit: "krw" }); // 3 days off: this one
    put(h, alice.id, "stage.eps.samsung.2027", "2026-08-26", 50, { unit: "usd" }); // nearer, another unit: never compared
    put(h, alice.id, "stage.eps.samsung.2027", "2026-11-25", 100, { unit: "krw" });
    put(h, alice.id, "stage.eps.samsung.2027", "2026-11-30", 80, { unit: "krw", grade: "C" }); // never used
    put(h, alice.id, "stage.eps.samsung.2026", "2026-08-25", 200, { unit: "krw" }); // another year: never compared
    put(h, alice.id, "stage.eps.samsung.2026", "2026-11-25", 100, { unit: "krw" });
    put(h, alice.id, "stage.eps.hynix.2027", "2026-08-20", 100, { unit: "krw", grade: "B" });
    put(h, alice.id, "stage.eps.hynix.2027", "2026-11-20", 95, { unit: "krw" });
    const before = rowsOf(h);
    await judgeAt(h, KST(2026, 12, 1, 8, 0));
    const six = (await alice.detail()).core11.find((r) => r.no === 6)!;
    expect(six).toEqual({
      no: 6,
      name: "삼전·하닉 이익 컨센서스",
      signal: "normal",
      value: `삼성전자 ${pct(pctChange(100, 104)!, 1)} · SK하이닉스 ${pct(-5, 1)}`,
      basis: "11월 20일 · 예시 증권 · B",
      reason: expect.stringMatching(/^삼성전자 .+, SK하이닉스 .+$/),
    });
    expect(rowsOf(h)).toEqual(before); // code leaves every row as written
    // the next day hynix's newest figure is 6% under the one 3 months before it: 🔴
    h.clock.t = KST(2026, 12, 2, 7, 0);
    put(h, alice.id, "stage.eps.hynix.2027", "2026-11-21", 94, { unit: "krw" });
    await judgeAt(h, KST(2026, 12, 2, 8, 0));
    expect((await alice.detail()).core11.find((r) => r.no === 6)).toMatchObject({ signal: "risk", value: `삼성전자 ${pct(pctChange(100, 104)!, 1)} · SK하이닉스 ${pct(-6, 1)}` });
    // an earlier figure more than 15 days from 3 months back is no base: hynix unknown, samsung still shown
    h.clock.t = KST(2026, 12, 3, 7, 0);
    h.db.sql.query("DELETE FROM invest_ledger WHERE id = 'stage.eps.hynix.2027' AND as_of = '2026-08-20'").run();
    put(h, alice.id, "stage.eps.hynix.2027", "2026-07-30", 100, { unit: "krw" }); // 22 days off 08-21
    await judgeAt(h, KST(2026, 12, 3, 8, 0));
    expect((await alice.detail()).core11.find((r) => r.no === 6)).toMatchObject({ signal: "unknown", value: `삼성전자 ${pct(pctChange(100, 104)!, 1)}` });
  });

  test("11: next year's figure against this year's per company; 20% is not below 20%; A6 counts what is there and stays open for what is not", async () => {
    const { h } = await world(calm());
    const { alice } = await people(h);
    h.clock.t = KST(2026, 12, 1, 7, 0);
    const capex = (co: string, y: number, day: string, v: number) => put(h, alice.id, `stage.capex.${co}.${y}`, day, v, { unit: "$B" });
    capex("MSFT", 2027, "2026-11-10", 150);
    capex("MSFT", 2026, "2026-10-30", 120); // +25%
    capex("GOOGL", 2027, "2026-11-05", 120);
    capex("GOOGL", 2026, "2026-11-05", 100); // +20%
    capex("META", 2027, "2026-11-12", 105);
    capex("META", 2026, "2026-11-12", 100); // +5%: 🔴
    capex("AMZN", 2026, "2026-11-12", 100); // no 2027: unknown
    await judgeAt(h, KST(2026, 12, 1, 8, 0));
    const d = await alice.detail();
    expect(d.core11.find((r) => r.no === 11)).toMatchObject({ signal: "risk", value: `MSFT ${pct(25, 1)} · GOOGL ${pct(20, 1)} · META ${pct(5, 1)}`, basis: "10월 30일 · 예시 증권 · B+" });
    expect(d.groups[0]!.rows.find((r) => r.id === "A6")).toMatchObject({ state: "unknown", detail: "20% 미만 1곳 · 10월 30일 · 예시 증권 · B+" });
  });

  test("too old is unknown and said so (the caution form): 120 days for 6 and 11, 5 US trading days for 7; each person judged on their own ledger", async () => {
    const { h } = await world(quiet());
    const { alice, bob } = await people(h);
    idb.ensureSettings(h.db, bob.id, h.clock.t);
    h.clock.t = KST(2026, 12, 1, 7, 0);
    // alice: just inside — breadth on 11-20 (5 US trading days to 11-30: Thanksgiving closed), 6 and 11 at 120 days
    put(h, alice.id, "stage.breadth200", "2026-11-20", 57);
    put(h, alice.id, "stage.eps.samsung.2027", "2026-05-01", 100, { unit: "krw" });
    put(h, alice.id, "stage.eps.samsung.2027", "2026-08-03", 99, { unit: "krw" });
    put(h, alice.id, "stage.capex.MSFT.2027", "2026-08-03", 150, { unit: "$B" });
    put(h, alice.id, "stage.capex.MSFT.2026", "2026-08-03", 120, { unit: "$B" });
    // bob: one day further
    put(h, bob.id, "stage.breadth200", "2026-11-19", 57);
    put(h, bob.id, "stage.eps.samsung.2027", "2026-05-01", 100, { unit: "krw" });
    put(h, bob.id, "stage.eps.samsung.2027", "2026-08-01", 99, { unit: "krw" });
    put(h, bob.id, "stage.capex.MSFT.2027", "2026-11-10", 150, { unit: "$B" });
    put(h, bob.id, "stage.capex.MSFT.2026", "2026-08-02", 120, { unit: "$B" });
    expect(await judgeAt(h, KST(2026, 12, 1, 8, 0))).toBe(2);
    const a = await alice.detail();
    const b = await bob.detail();
    const at = (d: InvestStagesDetail, no: number) => d.core11.find((r) => r.no === no)!;
    expect([at(a, 7).signal, at(a, 7).value, at(a, 7).basis]).toEqual(["risk", "57.0%", "11월 20일 · 예시 증권 · B+"]);
    expect(a.groups[2]!.rows.find((r) => r.id === "R4")).toMatchObject({ state: "unmet", detail: "57.0% · 11월 20일 · 예시 증권 · B+" });
    expect(at(a, 6).value).toBe(`삼성전자 ${pct(-1, 1)}`);
    expect(at(a, 11).value).toBe(`MSFT ${pct(25, 1)}`);
    expect([at(b, 7).signal, at(b, 7).value, at(b, 7).basis]).toEqual(["unknown", null, "11월 19일 값이라 오래됐어요"]);
    expect([at(b, 6).value, at(b, 6).basis]).toEqual([null, "8월 1일 값이라 오래됐어요"]);
    expect([at(b, 11).value, at(b, 11).basis]).toEqual([null, "8월 2일 값이라 오래됐어요"]);
    expect(b.groups[2]!.rows.find((r) => r.id === "R4")).toMatchObject({ state: "unknown", detail: "11월 19일 값이라 오래됐어요" });
    const head = ((await bob.overview()).stages as { escape: { pending?: string; pendingTone?: string } }).escape;
    expect([head.pending, head.pendingTone]).toEqual(["지표 1개 값이 없고 오늘 3개를 받지 못해서 2단계 여부는 아직 몰라요.", "caution"]); // 8 has nowhere; 6, 7, 11 too old
  });

  test("8 (team-lead 0511): each M7 company's recent 3-month change, below 0 down; all seven down 🔴, one not down 🟢, one missing or too old 확인 불가; grade C left out", async () => {
    const { h } = await world(calm());
    const { alice } = await people(h);
    h.clock.t = KST(2026, 12, 1, 7, 0);
    const M7 = ["AAPL", "MSFT", "GOOGL", "AMZN", "META", "NVDA", "TSLA"];
    for (const s of M7.slice(0, 6)) put(h, alice.id, `stage.m7.${s}`, "2026-11-25", -1.2);
    put(h, alice.id, "stage.m7.TSLA", "2026-11-26", 3, { grade: "C" }); // never used
    const eight = async (day: number) => {
      await judgeAt(h, KST(2026, 12, day, 8, 0));
      return (await alice.detail()).core11.find((r) => r.no === 8)!;
    };
    expect(await eight(1)).toMatchObject({ signal: "unknown", value: null, basis: "11월 25일 · 예시 증권 · B+" }); // TSLA not known
    h.clock.t = KST(2026, 12, 2, 7, 0);
    put(h, alice.id, "stage.m7.TSLA", "2026-12-01", -0.4);
    expect(await eight(2)).toMatchObject({ signal: "risk", value: "하향 7곳" });
    h.clock.t = KST(2026, 12, 3, 7, 0);
    put(h, alice.id, "stage.m7.NVDA", "2026-12-02", 0); // 0 is not below 0
    expect(await eight(3)).toMatchObject({ signal: "normal", value: "하향 6곳" });
    // AAPL's figure past 120 days: unknown again, unless another company is not down
    h.clock.t = KST(2026, 12, 4, 7, 0);
    put(h, alice.id, "stage.m7.NVDA", "2026-12-03", -2);
    put(h, alice.id, "stage.m7.AAPL", "2026-08-05", -1, {}); // an older row does not replace the newer one
    expect((await eight(4)).signal).toBe("risk");
    h.db.sql.query("DELETE FROM invest_ledger WHERE id = 'stage.m7.AAPL' AND as_of = '2026-11-25'").run();
    expect(await eight(5)).toMatchObject({ signal: "unknown", value: null });
  });

  test("one figure a day: a later row of the same day (an ISO time) is that day's", async () => {
    const { h } = await world(calm());
    const { alice } = await people(h);
    h.clock.t = KST(2026, 12, 1, 7, 0);
    put(h, alice.id, "stage.breadth200", "2026-11-24", 50);
    put(h, alice.id, "stage.breadth200", "2026-11-25", 57);
    put(h, alice.id, "stage.breadth200", "2026-11-25T21:00:00Z", 61);
    await judgeAt(h, KST(2026, 12, 1, 8, 0));
    expect((await alice.detail()).core11.find((r) => r.no === 7)).toMatchObject({ signal: "normal", value: "61.0%", basis: "11월 25일 · 예시 증권 · B+" });
  });

  test("pctChange: (a − b) ÷ |b| × 100 without float residue; no base, no change", () => {
    expect([pctChange(95, 100), pctChange(110, 100), pctChange(-5, -10), pctChange(1, 0), pctChange(100, 104)]).toEqual([-5, 10, 50, null, -3.8462]);
  });
});
