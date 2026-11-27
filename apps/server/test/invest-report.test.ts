/**
 * Invest B2c-1: the 08:00 daily report (A13 · A15, DD 1935 §2-4, DD 0059 §2, DD 0733, team-lead 0747). Code writes every
 * number and word but the summary, §1's paragraph and §7's cells; the model is a scripted LlmHelpers.chat here and the
 * series are synthetic (test/fake-toss.ts). Nothing real is called.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { InvestDailyCard, InvestOverview, InvestReport, InvestStagesDetail, ServerEvent } from "@pickle/protocol";
import * as idb from "../src/invest/db.ts";
import { writeLedger } from "../src/invest/ledger.ts";
import { allowedNumbers, checkSentence, checkWords, claimReport, confidenceOf, etfGroups, highlightsOf, holidayNote, judgmentOf, NO_ETF, NO_EVENTS, NO_SCENARIOS, NO_SUMMARY, REPORT_NOTE, shortHead, stageToneOf } from "../src/invest/report.ts";
import type { ChatRequest } from "../src/meet.ts";
import { makeInvestUpstream, syntheticBars } from "./fake-toss.ts";
import { makeHarness, type Harness } from "./helpers.ts";

const LAST = "2026-11-30";
const KST = (y: number, mo: number, d: number, hh = 9, mi = 0) => Date.UTC(y, mo - 1, d, hh - 9, mi);
const EIGHT = KST(2026, 12, 1, 8, 0);

const harnesses: Harness[] = [];
afterEach(async () => {
  while (harnesses.length) await harnesses.pop()!.close();
});

function weekdays(from: string, to = LAST): string[] {
  const out: string[] = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86_400_000) {
    const d = new Date(t);
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) out.push(d.toISOString().slice(0, 10));
  }
  return out;
}
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

/** a calm market but for credit and CPI: HY 3.0 → 3.6 on the last day (A1), core CPI +0.3% a month (A4) */
function calm(): Map<string, string | number> {
  const days = weekdays("2025-10-01");
  const flat = (v: number) => days.map((t): [string, number] => [t, v]);
  const fred = new Map<string, string | number>();
  fred.set("DGS10", csv("DGS10", flat(4.5)));
  fred.set("DGS2", csv("DGS2", days.map((t, i): [string, number] => [t, i === days.length - 1 ? 3.96 : 4])));
  fred.set("DFEDTARU", csv("DFEDTARU", flat(4.25)));
  fred.set("BAMLH0A0HYM2", csv("BAMLH0A0HYM2", days.map((t, i): [string, number] => [t, i === days.length - 1 ? 3.6 : 3])));
  fred.set("DEXJPUS", csv("DEXJPUS", flat(150)));
  fred.set("UNRATE", csv("UNRATE", months("2024-01").map((t): [string, number] => [t, 4.1])));
  fred.set("CPILFESL", csv("CPILFESL", months("2024-01").map((t, i): [string, number] => [t, Number((300 * 1.003 ** i).toFixed(3))])));
  fred.set("VIXCLS", csv("VIXCLS", flat(20)));
  fred.set("SP500", csv("SP500", days.map((t, i): [string, number] => [t, 5000 + i * 3])));
  fred.set("NASDAQ100", csv("NASDAQ100", days.map((t, i): [string, number] => [t, i === days.length - 1 ? 20_200 : 20_000])));
  fred.set("SAHMREALTIME", csv("SAHMREALTIME", months("2024-01").map((t): [string, number] => [t, 0.1])));
  fred.set("IC4WSA", csv("IC4WSA", days.filter((_, i) => i % 5 === 4).map((t): [string, number] => [t, 220_000])));
  fred.set("DEXKOUS", csv("DEXKOUS", flat(1350)));
  fred.set("NFCI", csv("NFCI", days.filter((_, i) => i % 5 === 4).map((t): [string, number] => [t, -0.5])));
  return fred;
}

interface Person {
  id: string;
  token: string;
  events: ServerEvent[];
  pushes: { title: string; tag?: string; body?: string }[];
}

async function world(fred = calm(), o: { sources?: boolean } = {}) {
  const up = makeInvestUpstream();
  for (const [k, v] of fred) up.state.fred.set(k, v);
  up.state.yahooDaily.set("^KS11", syntheticBars("2026-12-01", 260, 2500, 30));
  up.state.yahooDaily.set("^SOX", syntheticBars("2026-12-01", 260, 5000, 50));
  const h = await makeHarness({ now: EIGHT - 3_600_000, config: { invest: { sources: o.sources ?? true, tossBase: null, outboundIp: null } }, deps: () => ({ investFetch: up.fetch }) });
  harnesses.push(h);
  const people = new Map<string, Person>();
  const pub = h.app.core.events.publish.bind(h.app.core.events);
  h.app.core.events.publish = (u, e) => {
    people.get(u)?.events.push(e);
    pub(u, e);
  };
  h.app.core.push.send = async (u, m) => {
    people.get(u)?.pushes.push(m as Person["pushes"][number]);
    return 0;
  };
  const person = async (handle: string, invest = true): Promise<Person> => {
    const me = await h.signup(handle);
    const p: Person = { id: me.session.user.id, token: me.token, events: [], pushes: [] };
    people.set(p.id, p);
    if (invest) idb.ensureSettings(h.db, p.id, h.clock.t);
    return p;
  };
  const chats: ChatRequest[] = [];
  const answers: string[] = [];
  h.app.core.deps.llm!.chat = async function* (i: ChatRequest) {
    chats.push(i);
    i.onUsage?.(900);
    yield answers.shift() ?? "";
  };
  const get = async <T>(p: Person, path: string) => {
    const res = await h.req("GET", path, { token: p.token });
    return { status: res.status, body: (await res.json()) as T };
  };
  /** one beat of the server's clock at `at` (judgment, then the report; D-1 alongside) */
  const beat = async (at: number) => {
    h.clock.t = at;
    await h.app.core.invest.beat(at);
    await h.app.core.idle();
  };
  const cards = (p: Person) =>
    (h.db.sql.query("SELECT m.id, m.cards_json, m.llm_json, t.owner_id FROM messages m JOIN threads t ON t.id = m.thread_id WHERE m.cards_json LIKE '%invest_%' ORDER BY m.created_at, m.rowid").all() as { id: string; cards_json: string; llm_json: string; owner_id: string }[])
      .filter((r) => r.owner_id === p.id)
      .map((r) => ({ id: r.id, card: (JSON.parse(r.cards_json) as { type: string }[])[0]!, record: (JSON.parse(r.llm_json) as { content: string }[])[0]!.content }));
  const reportRows = () => h.db.sql.query("SELECT user_id, day, state, calls FROM invest_reports ORDER BY day, user_id").all() as { user_id: string; day: string; state: string; calls: number }[];
  return { h, up, person, chats, answers, get, beat, cards, reportRows };
}

const FOMC = { market: "US", day: "2026-12-02", kind: "macro", title: "FOMC 의사록 공개", source: "Federal Reserve", sourceTier: "T1", confidence: "A" };

const GOOD = JSON.stringify({
  summary: ["하이일드 스프레드가 3.60%로 올라 경계가 필요해요.", "S&P500이 200일선 위에 있어요.", "지수는 오르지만 신용 쪽은 조심스러운 시장이에요."],
  conclusion: ["지수는 오르지만 신용 스프레드가 넓어지며 시장이 조심스러워졌어요.", "하이일드 스프레드가 넓어진 것이 가장 큰 위험이에요.", "S&P500이 200일선 위에 머문 것은 회복 쪽 근거예요."],
  scenarios: {
    next: { up: "신용 스프레드가 다시 좁아지면", flat: "지표 발표가 없으면", down: "스프레드가 더 넓어지면" },
    week: { up: "물가 둔화가 확인되면", flat: "금리가 그대로면", down: "VIX가 25를 넘으면" },
    month: { up: "회복 신호가 늘면", flat: "실적이 예상 수준이면", down: "심각 신호가 나오면" },
  },
});

const TWO = (summary: string[], conclusion: string[], scenarios: unknown = JSON.parse(GOOD).scenarios) => JSON.stringify({ summary, conclusion, scenarios });
const SUMMARY = (JSON.parse(GOOD) as { summary: string[] }).summary;
const card = (c: { card: { type: string } } | undefined) => c!.card as InvestDailyCard;
/** a figure the person put in their ledger */
const put = (h: Harness, uid: string, id: string, asOf: string, value: number, unit = "pct") =>
  writeLedger(h.db, uid, { id, asOf, value, unit, definition: "테스트 값", source: "예시 증권", sourceTier: "T2", confidence: "B+" }, "person", h.clock.t);
function rule(uid: string, symbol: string, r: Partial<idb.RuleRow> & Pick<idb.RuleRow, "kind" | "direction">): idb.RuleRow {
  return { id: `r_${symbol}_${r.kind}_${r.level ?? 0}`, user_id: uid, symbol, level: null, price: null, lo: null, hi: null, action: "notify", once: 0, buffer_pct: null, conditions_json: null, until_day: null, state: "armed", hit_at: null, hit_seq: 0, cleared_at: null, paused_at: null, seen_slot: null, real_confirmed_at: null, rev: 1, created_by: "person", created_at: EIGHT - 86_400_000, updated_at: EIGHT - 86_400_000, ...r };
}

describe("the 08:00 report", () => {
  test("one beat at 08:00 judges and reports: the card is code's but the three lines, the lock screen gets its title alone, the overview lists it and the screen opens it for its owner only", async () => {
    const w = await world();
    const a = await w.person("alice");
    const b = await w.person("bob");
    const c = await w.person("carol", false); // no invest: no reading, no report
    await w.beat(EIGHT - 60_000);
    expect(w.reportRows()).toEqual([]);
    w.answers.push(GOOD, GOOD);
    await w.beat(EIGHT);
    expect(w.reportRows()).toEqual([
      { user_id: [a.id, b.id].sort()[0]!, day: "2026-12-01", state: "sent", calls: 1 },
      { user_id: [a.id, b.id].sort()[1]!, day: "2026-12-01", state: "sent", calls: 1 },
    ]);
    const [one, ...more] = w.cards(a);
    expect(more).toEqual([]);
    expect(card(one)).toEqual({
      type: "invest_daily",
      reportId: expect.stringMatching(/^ir_/),
      title: "시장 위험 보고서",
      atText: "12월 1일(화) 08:00",
      highlights: [{ tone: "caution", text: "하이일드 스프레드가 3.5%p 이상이 됐어요" }],
      stageLine: "탈출 3단계 방어 준비 · 회복 최소 1단계",
      summary: SUMMARY,
      tally: [
        { signal: "risk", label: "위험", count: 2 },
        { signal: "caution", label: "경계", count: 0 },
        { signal: "normal", label: "정상", count: 4 },
        { signal: "unknown", label: "확인 불가", count: 5 },
      ],
      rows: [
        { label: "11지표", value: "위험 2 · 경계 0 · 정상 4 · 확인 불가 5" },
        { label: "신호", value: "악화 2/8 · 심각 0/5 · 회복 3/6" },
      ],
      pending: "지표 2개 값이 없어서 회복 단계는 아직 몰라요.",
      deck: { state: "none" },
      foot: "기준 12월 1일 08:00 · FRED · Yahoo(지연 시세)",
      disclaimer: true,
    });
    expect(one!.record).toBe(["[투자 보고서] 12월 1일(화) 08:00 · 탈출 3단계 방어 준비 · 회복 최소 1단계", ...SUMMARY].join("\n"));
    // the banner and the lock screen: the title alone (DD 2042-b §4), one tag per day
    expect(a.pushes.map((p) => [p.title, p.tag, p.body])).toEqual([["시장 위험 보고서 · 탈출 3단계", "invest:report:2026-12-01", undefined]]);
    expect(a.events.flatMap((e) => (e.type === "notification" ? [[e.title, e.body]] : []))).toEqual([["시장 위험 보고서 · 탈출 3단계", ""]]);
    expect([c.pushes, w.cards(c)]).toEqual([[], []]);
    // one plain call per person: the note, the data as JSON (nobody's name in it), no tools
    expect(w.chats).toHaveLength(2);
    expect(w.chats[0]!.system).toBe(REPORT_NOTE);
    const input = JSON.parse(w.chats[0]!.user) as Record<string, unknown>;
    expect(Object.keys(input)).toEqual(["day", "judgedAt", "holiday", "stages", "signals", "next", "core11", "met", "market", "etf", "events", "highlights", "horizons"]);
    for (const word of ["alice", "bob", "하늘", "깽이"]) expect(w.chats[0]!.user).not.toContain(word);
    // overview.reports and the screen
    const id = card(one).reportId;
    const ov = (await w.get<InvestOverview>(a, "/api/invest")).body;
    expect(ov.reports).toEqual([{ id, title: "12월 1일(화) · 탈출 3 · 회복 최소 1", line: SUMMARY[0]!, threadId: expect.any(String), messageId: one!.id }]);
    const rep = await w.get<InvestReport>(a, `/api/invest/reports/${id}`);
    expect(rep.status).toBe(200);
    expect([rep.body.id, rep.body.title, rep.body.atText, rep.body.disclaimer]).toEqual([id, "12월 1일 보고서", "12월 1일(화) 08:00", true]);
    expect(rep.body.sections.map((s) => [s.key, s.title])).toEqual([
      ["conclusion", "핵심 결론"],
      ["market", "주요 시장 데이터"],
      ["core11", "핵심 11지표"],
      ["worse", "악화·위험 신호"],
      ["recovery", "회복 신호"],
      ["etf", "ETF 검토 가격"],
      ["scenarios", "향후 시나리오"],
      ["events", "주요 경제 일정"],
    ]);
    const sec = Object.fromEntries(rep.body.sections.map((s) => [s.key, s])) as Record<string, InvestReport["sections"][number]>;
    expect(sec.conclusion).toEqual({
      key: "conclusion",
      title: "핵심 결론",
      heads: [
        { stage: 3, name: "방어 준비", text: "탈출 3단계" },
        { stage: 1, floor: true, text: "회복 최소 1단계", pending: "지표 2개 값이 없어서 회복 단계는 아직 몰라요.", pendingTone: "quiet" },
      ],
      paragraph: (JSON.parse(GOOD) as { conclusion: string[] }).conclusion,
      confidence: { label: "판정 신뢰도", value: "낮음", sub: "확인 불가 5개" },
    });
    expect(sec.market).toEqual({
      key: "market",
      title: "주요 시장 데이터",
      rows: [
        { name: "S&P500", value: "5,909.00", sub: "변화 +0.05% · 11월 30일 · FRED · A" },
        { name: "나스닥100", value: "20,200.00", sub: "변화 +1.00% · 11월 30일 · FRED · A" },
        { name: "필라델피아 반도체 지수", value: "5,000.00", sub: "변화 0.00% · 11월 30일 · Yahoo(지연 시세) · B+" },
        { name: "코스피", value: "2,500.00", sub: "변화 0.00% · 11월 30일 · Yahoo(지연 시세) · B+" },
        { name: "VIX", value: "20.00", sub: "변화 0.00% · 11월 30일 · FRED · A" },
        { name: "미국 10년물 금리", value: "4.50%", sub: "변화 0.00%p · 11월 30일 · FRED · A" },
        { name: "미국 2년물 금리", value: "3.96%", sub: "변화 −0.04%p · 11월 30일 · FRED · A" },
        { name: "하이일드 스프레드", value: "3.60%", sub: "변화 +0.60%p · 11월 30일 · FRED · A" },
        { name: "엔/달러 환율", value: "150.00", sub: "변화 0.00% · 11월 30일 · FRED · A" },
        { name: "원/달러 환율", value: "1,350.00", sub: "변화 0.00% · 11월 30일 · FRED · A" },
      ],
    });
    // §3–§5 are the board's own rows (GET /api/invest/stages): only the met conditions, the board's next lines
    const detail = (await w.get<InvestStagesDetail>(a, "/api/invest/stages")).body;
    expect(sec.core11).toEqual({ key: "core11", title: "핵심 11지표", tally: "위험 2 · 경계 0 · 정상 4 · 확인 불가 5", rows: detail.core11 });
    const metOf = (k: string) => detail.groups.find((g) => g.key === k)!.rows.filter((r) => r.state === "met");
    expect(sec.worse).toEqual({ key: "worse", title: "악화·위험 신호", gauges: ov.stages.kind === "judged" ? ov.stages.gauges.slice(0, 2) : [], rows: [...metOf("worse"), ...metOf("severe")], next: detail.groups.slice(0, 2).map((g) => g.next) });
    expect((sec.worse as { rows: { id: string }[] }).rows.map((r) => r.id)).toEqual(["A1", "A4"]);
    expect(sec.recovery).toMatchObject({ rows: metOf("recover"), next: ["회복 2단계까지: 회복 신호 1개 더, 심각 신호 0개"] });
    expect(sec.etf).toEqual({ key: "etf", title: "ETF 검토 가격", groups: [], empty: NO_ETF });
    expect(sec.scenarios).toEqual({
      key: "scenarios",
      title: "향후 시나리오",
      rows: [
        { horizon: "다음 거래일", up: "신용 스프레드가 다시 좁아지면", flat: "지표 발표가 없으면", down: "스프레드가 더 넓어지면" },
        { horizon: "5거래일", up: "물가 둔화가 확인되면", flat: "금리가 그대로면", down: "VIX가 25를 넘으면" },
        { horizon: "20거래일", up: "회복 신호가 늘면", flat: "실적이 예상 수준이면", down: "심각 신호가 나오면" },
      ],
    });
    expect(sec.events).toEqual({ key: "events", title: "주요 경제 일정", rows: [], empty: NO_EVENTS });
    // someone else's report reads as missing; so does a made-up id
    for (const [p, path] of [
      [b, `/api/invest/reports/${id}`],
      [a, "/api/invest/reports/ir_nope"],
    ] as const) {
      const r = await w.get<{ error: string; message: string }>(p, path);
      expect([r.status, r.body.error, r.body.message]).toEqual([404, "report_not_found", "볼 수 없는 보고서예요."]);
    }
    // the rest of the day: nothing again, no call
    await w.beat(EIGHT + 30_000);
    await w.beat(KST(2026, 12, 1, 23, 59));
    expect([w.cards(a).length, w.chats.length, a.pushes.length]).toEqual([1, 2, 1]);
  });

  test("the next day: the stage line's change under it, a break told once (the series did not move), the overview newest first", async () => {
    const w = await world();
    const a = await w.person("alice");
    w.answers.push(GOOD, GOOD);
    await w.beat(EIGHT);
    await w.beat(KST(2026, 12, 2, 8, 0));
    const [, second] = w.cards(a);
    expect(card(second)).toMatchObject({ atText: "12월 2일(수) 08:00", highlights: [], stageSub: "어제와 같아요" });
    const rep = (await w.get<InvestReport>(a, `/api/invest/reports/${card(second).reportId}`)).body;
    expect(rep.sections[0]).toMatchObject({ change: "어제와 같아요" });
    const ov = (await w.get<InvestOverview>(a, "/api/invest")).body;
    expect(ov.reports.map((r) => r.title)).toEqual(["12월 2일(수) · 탈출 3 · 회복 최소 1", "12월 1일(화) · 탈출 3 · 회복 최소 1"]);
  });

  test("two of the top lines shown and 외 N; with fewer than 4 indicators unknown no data-gap line, and the confidence is 보통", async () => {
    const fred = calm();
    const days = weekdays("2025-10-01");
    fred.set("VIXCLS", csv("VIXCLS", days.map((t, i): [string, number] => [t, i === days.length - 1 ? 26 : 20])));
    fred.set("SP500", csv("SP500", days.map((t, i): [string, number] => [t, i === days.length - 1 ? 5500 : 5000 + i * 3])));
    const w = await world(fred);
    const a = await w.person("alice");
    // 6 and 7 from the person's ledger: 3 of the 11 left unknown
    w.h.clock.t = KST(2026, 12, 1, 7, 0);
    put(w.h, a.id, "stage.eps.samsung.2027", "2026-08-28", 104, "krw");
    put(w.h, a.id, "stage.eps.samsung.2027", "2026-11-25", 100, "krw");
    put(w.h, a.id, "stage.eps.hynix.2027", "2026-08-20", 100, "krw");
    put(w.h, a.id, "stage.eps.hynix.2027", "2026-11-20", 99, "krw");
    put(w.h, a.id, "stage.breadth200", "2026-11-30", 65);
    w.answers.push(GOOD);
    await w.beat(EIGHT);
    const c = card(w.cards(a)[0]);
    expect([c.highlights, c.moreCount, c.dataGap]).toEqual([
      [
        { tone: "caution", text: "하이일드 스프레드가 3.5%p 이상이 됐어요" },
        { tone: "caution", text: "VIX가 25 이상이 됐어요" },
      ],
      1,
      undefined,
    ]);
    expect(c.foot).toBe("기준 12월 1일 08:00 · FRED · Yahoo(지연 시세) · 예시 증권"); // DD 0828 5: three are all named
    const rep = (await w.get<InvestReport>(a, `/api/invest/reports/${c.reportId}`)).body;
    expect(rep.sections[0]).toMatchObject({ confidence: { label: "판정 신뢰도", value: "보통", sub: "확인 불가 3개" } });
    // the third line (the S&P 500 under its 200-day line) is on the model's list, not lost
    expect((JSON.parse(w.chats[0]!.user) as { highlights: string[] }).highlights).toEqual(["하이일드 스프레드가 3.5%p 이상이 됐어요", "VIX가 25 이상이 됐어요", "S&P500이 200일선 아래로 내려갔어요"]);
  });

  test("sources off: no reading, no report row, no call; the D-1 card goes at 08:00 as before", async () => {
    const w = await world(calm(), { sources: false });
    const a = await w.person("alice");
    w.h.clock.t = KST(2026, 12, 1, 7, 0);
    expect((await w.h.req("POST", "/api/invest/events", { token: a.token, body: FOMC })).status).toBe(201);
    await w.beat(EIGHT);
    expect([w.reportRows(), w.chats.length]).toEqual([[], 0]);
    expect(w.cards(a).map((x) => x.card.type)).toEqual(["invest_event"]);
  });

  test("push off (notifications.investReport, on by default): the report is in the thread, unread, with no banner and no lock-screen line", async () => {
    const w = await world();
    const a = await w.person("alice");
    const s = await w.h.req("PATCH", "/api/settings", { token: a.token, body: { notifications: { briefing: true } } });
    expect(((await s.json()) as { notifications: { investReport: boolean } }).notifications.investReport).toBe(true);
    expect((await w.h.req("PATCH", "/api/settings", { token: a.token, body: { notifications: { investReport: "no" } } })).status).toBe(400);
    expect((await w.h.req("PATCH", "/api/settings", { token: a.token, body: { notifications: { investReport: false } } })).status).toBe(200);
    w.answers.push(GOOD);
    await w.beat(EIGHT);
    expect(w.cards(a).map((x) => x.card.type)).toEqual(["invest_daily"]);
    expect([a.pushes, a.events.filter((e) => e.type === "notification")]).toEqual([[], []]);
    const ov = (await w.get<InvestOverview>(a, "/api/invest")).body;
    const unread = w.h.db.sql.query("SELECT unread FROM thread_members WHERE thread_id = $t AND user_id = $u").get({ t: ov.reports[0]!.threadId, u: a.id }) as { unread: number };
    expect(unread.unread).toBe(1);
  });
});

describe("the stage line and the data-gap line (DD 0828 1a · 2)", () => {
  test("a stage move is the stage line's, with its tone; no top line repeats it", async () => {
    const quiet = calm();
    const days = weekdays("2025-10-01");
    quiet.set("BAMLH0A0HYM2", csv("BAMLH0A0HYM2", days.map((t): [string, number] => [t, 3])));
    quiet.set("CPILFESL", csv("CPILFESL", months("2024-01").map((t, i): [string, number] => [t, Number((300 * 1.001 ** i).toFixed(3))])));
    const w = await world(quiet);
    const a = await w.person("alice");
    w.answers.push(GOOD, GOOD);
    await w.beat(EIGHT);
    for (const [k, v] of calm()) w.up.state.fred.set(k, v); // the next day credit and CPI turn: escape 3
    await w.beat(KST(2026, 12, 2, 8, 0));
    const [first, second] = w.cards(a).map((x) => card(x));
    expect([first!.stageLine, first!.stageSub, first!.stageTone]).toEqual(["탈출 최소 1단계 · 회복 최소 2단계", undefined, undefined]);
    expect([second!.stageLine, second!.stageSub, second!.stageTone]).toEqual(["탈출 3단계 방어 준비 · 회복 최소 1단계", "탈출 최소 1단계 → 탈출 3단계 · 회복 최소 2 → 1단계", "caution"]);
    expect(second!.highlights.filter((h) => h.text.includes("단계"))).toEqual([]);
  });

  test("only what did not come today is counted, and not when the stage's pending line already says it; nowhere-to-get stays in the tally and the confidence", async () => {
    const f1 = calm();
    f1.set("DGS10", 404);
    const w1 = await world(f1);
    const a = await w1.person("alice");
    await w1.beat(EIGHT);
    const c1 = card(w1.cards(a)[0]);
    expect([c1.dataGap, c1.pending]).toEqual(["오늘 지표 1개를 받지 못했어요.", "지표 2개 값이 없어서 회복 단계는 아직 몰라요."]);
    expect(c1.tally.at(-1)).toEqual({ signal: "unknown", label: "확인 불가", count: 6 });
    // the 2-year yield missing: the recovery's pending line says it already
    const f2 = calm();
    f2.set("DGS2", 404);
    const w2 = await world(f2);
    const b = await w2.person("bob");
    await w2.beat(EIGHT);
    const c2 = card(w2.cards(b)[0]);
    expect([c2.dataGap, c2.pending]).toEqual([undefined, "지표 2개 값이 없고 오늘 1개를 받지 못해서 회복 단계는 아직 몰라요."]);
  });
});

describe("the model's words (team-lead 0747: two calls at most per person and day, the row first)", () => {
  test("a line with a number not in the data, a probability or too long is left out; a second call only for the summary; each part keeps its first good answer", async () => {
    const w = await world();
    // the reports go in user-id order (random ids): a is whoever comes first
    const [a, b] = [await w.person("alice"), await w.person("bob")].sort((x, y) => (x.id < y.id ? -1 : 1)) as [Person, Person];
    const long = "가".repeat(61);
    w.answers.push(
      // a: 7.5 is in no data, the probability line goes, the scenarios are good → one more call for the summary
      TWO([SUMMARY[0]!, "S&P500이 7.5% 올랐어요.", SUMMARY[2]!], ["지수는 오르지만 신용 쪽이 불안해요.", "하락 확률은 60%예요.", "탈출 단계는 3단계예요."]),
      TWO(SUMMARY, ["두 번째 문단은 쓰지 않아요."], { next: { up: "x" } }),
      // b: a long line, then no JSON at all → no summary, no paragraph, no scenarios
      TWO([long, SUMMARY[1]!, SUMMARY[2]!], [], { next: { up: "오르면", flat: "그대로면", down: "내리면" } }),
      "오늘은 쉬어요",
    );
    await w.beat(EIGHT);
    expect(w.reportRows().map((r) => r.calls)).toEqual([2, 2]);
    expect(w.chats).toHaveLength(4);
    const ca = card(w.cards(a)[0]);
    expect([ca.summary, ca.summaryNote]).toEqual([SUMMARY, undefined]);
    const ra = (await w.get<InvestReport>(a, `/api/invest/reports/${ca.reportId}`)).body;
    expect(ra.sections[0]).toMatchObject({ paragraph: ["지수는 오르지만 신용 쪽이 불안해요."] }); // the stage sentence is code's (DD 0828 1c)
    expect(ra.sections[0]).not.toHaveProperty("note");
    expect(ra.sections[6]).toMatchObject({ rows: [{ horizon: "다음 거래일" }, { horizon: "5거래일" }, { horizon: "20거래일" }] });
    // b: DD 0733 3's words, caution on the card and §1, §7 all or nothing
    const cb = card(w.cards(b)[0]);
    expect([cb.summary, cb.summaryNote]).toEqual([[], "오늘은 요약을 쓰지 못했어요."]); // the words themselves (DD N5)
    expect(w.cards(b)[0]!.record).toBe(`[투자 보고서] 12월 1일(화) 08:00 · 탈출 3단계 방어 준비 · 회복 최소 1단계\n${NO_SUMMARY}`);
    const rb = (await w.get<InvestReport>(b, `/api/invest/reports/${cb.reportId}`)).body;
    expect(rb.sections[0]).toMatchObject({ paragraph: [], note: NO_SUMMARY });
    expect(rb.sections[6]).toEqual({ key: "scenarios", title: "향후 시나리오", rows: [], empty: "오늘은 시나리오를 쓰지 못했어요." });
    expect((await w.get<InvestOverview>(b, "/api/invest")).body.reports[0]!.line).toBe(NO_SUMMARY);
  });

  test("a row left making by a restart is finished with the calls it has left, never a third; a fresh one waits its turn; no model at all still sends the report", async () => {
    const w = await world();
    const a = await w.person("alice");
    const b = await w.person("bob");
    const c = await w.person("carol");
    w.h.clock.t = EIGHT;
    await w.h.app.core.invest.judgeStages(EIGHT);
    // as a crash left them: alice after one call, bob after two
    const take = (id: string, uid: string, calls: number) =>
      w.h.db.sql.query("INSERT INTO invest_reports (id, user_id, day, state, calls, judged_at, created_at) VALUES ($id, $u, '2026-12-01', 'making', $c, $at, $at)").run({ id, u: uid, c: calls, at: EIGHT });
    take("ir_a", a.id, 1);
    take("ir_b", b.id, 2);
    // one row per person and day: a second take of alice's day is refused (UNIQUE)
    expect(claimReport(w.h.app.core, "ir_again", judgmentOf(w.h.app.core, a.id, "2026-12-01")!, EIGHT)).toBe(false);
    w.answers.push(GOOD);
    await w.beat(EIGHT + 5 * 60_000); // carol's goes; the two are not stale yet
    expect(w.reportRows().map((r) => [r.user_id === c.id ? "carol" : r.user_id === a.id ? "alice" : "bob", r.state, r.calls]).sort()).toEqual([
      ["alice", "making", 1],
      ["bob", "making", 2],
      ["carol", "sent", 1],
    ]);
    w.answers.push("{}", GOOD);
    await w.beat(EIGHT + 11 * 60_000);
    // alice: one call left (its answer had no summary), bob: none
    expect(w.chats).toHaveLength(2);
    expect(w.reportRows().map((r) => [r.state, r.calls])).toEqual(expect.arrayContaining([["sent", 2], ["sent", 2], ["sent", 1]]));
    expect([card(w.cards(a)[0]).summaryNote, card(w.cards(b)[0]).summaryNote]).toEqual([NO_SUMMARY, NO_SUMMARY]);
    // a server without a model: the next day's report still goes, from code
    w.h.app.core.deps.llm!.chat = undefined;
    await w.beat(KST(2026, 12, 2, 8, 0));
    expect(w.reportRows().filter((r) => r.day === "2026-12-02").map((r) => [r.state, r.calls])).toEqual([
      ["sent", 0],
      ["sent", 0],
      ["sent", 0],
    ]);
  });

  test("checkWords: a JSON object anywhere, three summary lines or none, marks and long lines out, numbers only from the data, no probability with a number, §7 all or none", () => {
    const allowed = allowedNumbers({ a: "3.60% · 25 이상 · 5거래일 · 20거래일" });
    const sc = { next: { up: "오르면", flat: "그대로면", down: "내리면" }, week: { up: "a", flat: "b", down: "c" }, month: { up: "d", flat: "e", down: "f" } };
    const ok = checkWords("```json\n" + JSON.stringify({ summary: ["하나예요.", "3.60%예요.", "셋이에요."], conclusion: ["5거래일 뒤를 봐요."], scenarios: sc }) + "\n```", allowed);
    expect(ok).toEqual({ summary: ["하나예요.", "3.60%예요.", "셋이에요."], paragraph: ["5거래일 뒤를 봐요."], scenarios: [
      { horizon: "다음 거래일", up: "오르면", flat: "그대로면", down: "내리면" },
      { horizon: "5거래일", up: "a", flat: "b", down: "c" },
      { horizon: "20거래일", up: "d", flat: "e", down: "f" },
    ] });
    expect(checkWords("not json", allowed)).toEqual({ summary: null, paragraph: [], scenarios: null });
    expect(checkWords(JSON.stringify({ summary: ["하나", "둘"] }), allowed).summary).toBeNull();
    expect(checkSentence("**굵게** 써요.", 60, allowed)).toBeNull();
    expect(checkSentence("가".repeat(61), 60, allowed)).toBeNull();
    expect(checkSentence("가".repeat(60), 60, allowed)).toBe("가".repeat(60));
    expect(checkSentence("VIX가 26이에요.", 60, allowed)).toBeNull();
    expect(checkSentence("VIX가 25 이상이에요.", 60, allowed)).toBe("VIX가 25 이상이에요.");
    expect(checkSentence("S&P500이 200일선 위예요.", 60, allowedNumbers({ a: "S&P500" }))).toBe("S&P500이 200일선 위예요."); // a name's numbers
    expect(checkSentence("S&P500이 300일선 위예요.", 60, allowedNumbers({ a: "S&P500" }))).toBeNull();
    expect(checkSentence("오를 확률이 25예요.", 60, allowed)).toBeNull();
    expect(checkSentence("하락 가능성을 살펴봐요.", 60, allowed)).toBe("하락 가능성을 살펴봐요.");
    expect(checkSentence("  줄이\n 바뀌어도  하나예요. ", 60, allowed)).toBe("줄이 바뀌어도 하나예요.");
    // DD 0828 1b · 1c: the stages, missing data and trust are code's; a summary or §1 sentence on them goes
    for (const s of ["탈출 단계는 그대로예요.", "판정 신뢰도는 보통이에요.", "확인 불가 지표가 많아요.", "데이터 누락이 있어요.", "오늘 일부 지표를 받지 못했어요."]) {
      expect(checkWords(JSON.stringify({ summary: [s, "둘이에요.", "셋이에요."], conclusion: [s, "남아요."] }), allowed)).toMatchObject({ summary: null, paragraph: ["남아요."] });
    }
    expect(checkWords(JSON.stringify({ summary: [], scenarios: { ...sc, month: { up: "d", flat: "e" } } }), allowed).scenarios).toBeNull();
    // the note quotes none of the code's own sentences (no-sample-lines)
    for (const s of [NO_SUMMARY, NO_SCENARIOS, "오늘 지표", "보유 중일 때만", "만료·무효화", "확인 대기"]) expect(REPORT_NOTE).not.toContain(s);
  });
});

describe("D-1 rides on the report (team-lead 0747 7)", () => {
  test("the report carries the lines (three at most), each claimed via daily in the same send; no card of its own; §8 lists what is ahead", async () => {
    const w = await world();
    const a = await w.person("alice");
    w.h.clock.t = KST(2026, 12, 1, 7, 0);
    const ev = (o: Record<string, unknown>) => w.h.req("POST", "/api/invest/events", { token: a.token, body: { ...FOMC, ...o } });
    for (const o of [{ title: "FOMC 의사록 공개" }, { title: "ISM 서비스업", time: "10:00" }, { title: "ADP 고용", time: "08:15" }, { title: "베이지북", time: "14:00" }]) expect((await ev(o)).status).toBe(201);
    w.answers.push(GOOD);
    await w.beat(EIGHT);
    const list = w.cards(a);
    expect(list.map((x) => x.card.type)).toEqual(["invest_daily"]);
    const c = card(list[0]);
    expect(c.events).toEqual({
      head: "12월 2일 일정 4개",
      rows: [
        { title: "ADP 고용", value: "12월 2일 22:15(미 동부 08:15)" },
        { title: "ISM 서비스업", value: "12월 3일 00:00(미 동부 10:00)" },
        { title: "베이지북", value: "12월 3일 04:00(미 동부 14:00)" },
      ],
    });
    expect(list[0]!.record.split("\n").at(-1)).toBe("12월 2일 일정 4개: ADP 고용 12월 2일 22:15(미 동부 08:15) / ISM 서비스업 12월 3일 00:00(미 동부 10:00) / 베이지북 12월 3일 04:00(미 동부 14:00)");
    const claims = w.h.db.sql.query("SELECT title, via, message_id FROM invest_event_reminders ORDER BY title").all() as { title: string; via: string; message_id: string }[];
    expect(claims.map((r) => [r.via, r.message_id])).toEqual(Array(4).fill(["daily", list[0]!.id]));
    // later beats: nothing more (each D-1 once by any path)
    await w.beat(KST(2026, 12, 1, 9, 30));
    expect(w.cards(a)).toHaveLength(1);
    const rep = (await w.get<InvestReport>(a, `/api/invest/reports/${c.reportId}`)).body;
    expect(rep.sections[7]).toMatchObject({ rows: [{ title: "ADP 고용", when: "12월 2일 22:15(미 동부 08:15)", foot: "Federal Reserve · A" }, {}, {}, { title: "FOMC 의사록 공개", when: "미 동부 12월 2일 · 시각 미정" }] });
  });

  test("while the report may still come the card waits, up to an hour past 08:00; then it goes on its own", async () => {
    const w = await world();
    const a = await w.person("alice");
    w.h.clock.t = KST(2026, 12, 1, 7, 0);
    expect((await w.h.req("POST", "/api/invest/events", { token: a.token, body: FOMC })).status).toBe(201);
    const remind = async (at: number) => {
      w.h.clock.t = at;
      const n = await w.h.app.core.invest.remindEvents(at);
      await w.h.app.core.idle();
      return n;
    };
    expect(await remind(EIGHT)).toBe(0);
    expect(await remind(EIGHT + 59 * 60_000)).toBe(0);
    expect(await remind(EIGHT + 60 * 60_000)).toBe(1);
    expect(w.cards(a).map((x) => x.card.type)).toEqual(["invest_event"]);
    // the report that comes after it carries no line of that event
    w.answers.push(GOOD);
    await w.beat(EIGHT + 61 * 60_000);
    expect(card(w.cards(a)[1]).events).toBeUndefined();
  });
});

describe("the ETF review table (A15 §6) and the rules' top lines", () => {
  test("per watched symbol with rules: the last close, the zone, targets and stop (보유 중일 때만 해당 unless held), (추정) rates, the R:R, the entry condition; an expired rule asks for a review", async () => {
    const w = await world();
    const a = await w.person("alice");
    w.up.state.yahooDaily.set("SOXL", syntheticBars("2026-12-01", 260, 25, 1));
    idb.addWatch(w.h.db, { user_id: a.id, symbol: "SOXL", market: "US", name: "SOXL", added_at: EIGHT - 86_400_000 });
    idb.addWatch(w.h.db, { user_id: a.id, symbol: "QQQ", market: "US", name: "QQQ", added_at: EIGHT - 86_400_000 }); // no rules: not listed
    idb.insertRule(w.h.db, rule(a.id, "SOXL", { kind: "buy_zone", direction: "inside", lo: 20, hi: 22 }));
    idb.insertRule(w.h.db, rule(a.id, "SOXL", { kind: "target", direction: "above", level: 1, price: 30 }));
    idb.insertRule(w.h.db, rule(a.id, "SOXL", { kind: "target", direction: "above", level: 2, price: 35 }));
    idb.insertRule(w.h.db, rule(a.id, "SOXL", { kind: "stop", direction: "below", price: 18 }));
    idb.insertRule(w.h.db, rule(a.id, "SOXL", { kind: "alert", direction: "above", price: 40, state: "expired", updated_at: EIGHT - 3_600_000 }));
    idb.insertRule(w.h.db, rule(a.id, "SOXL", { kind: "invalidate", direction: "below", price: 15, state: "hit", hit_at: EIGHT - 7_200_000 }));
    w.answers.push(GOOD, GOOD);
    await w.beat(EIGHT);
    const c = card(w.cards(a)[0]);
    expect([c.highlights, c.moreCount]).toEqual([
      [
        { tone: "caution", text: "하이일드 스프레드가 3.5%p 이상이 됐어요" },
        { tone: "caution", text: "SOXL 가격 알림 규칙의 기한이 지났어요" },
      ],
      1,
    ]);
    expect((JSON.parse(w.chats[0]!.user) as { highlights: string[] }).highlights.at(-1)).toBe("SOXL 전략 무효화 조건에 닿았어요");
    const rep = (await w.get<InvestReport>(a, `/api/invest/reports/${c.reportId}`)).body;
    expect(rep.sections[5]).toEqual({
      key: "etf",
      title: "ETF 검토 가격",
      groups: [
        {
          symbol: "SOXL",
          price: { value: "$25.00", sub: "11월 30일 종가 · Yahoo(지연 시세) · B+" },
          rows: [
            { label: "매수 검토 구간", value: "$20.00–22.00" },
            { label: "1차 익절", value: "$30.00", sub: "보유 중일 때만 해당" },
            { label: "2차 익절", value: "$35.00", sub: "보유 중일 때만 해당" },
            { label: "손절", value: "$18.00", sub: "보유 중일 때만 해당" },
            { label: "예상 수익률", value: "+20.0% (추정)" },
            { label: "예상 손실률", value: "−28.0% (추정)" },
            { label: "손익비", value: "0.71 / 1.43" },
            { label: "진입 조건", value: "미충족", sub: "가격이 구간 위예요" },
            { label: "전략", value: "재검토 필요", sub: "가격 알림 규칙의 기한이 지났어요" },
          ],
        },
      ],
    });
    // the next day: each told once (the rules did not change, the series has no newer value); the table stays, and
    // with Toss saying SOXL is held, targets and stop lose the held-only note
    (w.h.app.core.invest as unknown as { holdingsByUser: Map<string, { at: number; list: { symbol: string; qty: number; avgPrice: number | null }[] }> }).holdingsByUser.set(a.id, { at: KST(2026, 12, 2, 7, 0), list: [{ symbol: "SOXL", qty: 10, avgPrice: 21 }] });
    await w.beat(KST(2026, 12, 2, 8, 0));
    const next = card(w.cards(a)[1]);
    expect([next.highlights, next.moreCount]).toEqual([[], undefined]);
    const rows2 = ((await w.get<InvestReport>(a, `/api/invest/reports/${next.reportId}`)).body.sections[5] as { groups: { rows: { label: string; value: string; sub?: string }[] }[] }).groups[0]!.rows;
    expect(rows2.slice(1, 4)).toEqual([
      { label: "1차 익절", value: "$30.00" },
      { label: "2차 익절", value: "$35.00" },
      { label: "손절", value: "$18.00" },
    ]);
    expect(rows2.at(-1)!.label).toBe("전략");
  });
});

describe("etfGroups (A15 §6, DD 0828 3 · 4 · 7)", () => {
  test("in the zone: 확인 대기 · 가격 구간 도달; under it: 미충족 · 가격이 구간 아래예요; one target, one R:R; held known false keeps the held-only note; no rule trouble: 만료·무효화 없음", () => {
    const bars = (c: number) => ({ bars: syntheticBars("2026-12-01", 20, c, 1), source: "yahoo" as const });
    const base = (sym: string, extra: Partial<idb.RuleRow>[]) => [rule("u", sym, { kind: "buy_zone", direction: "inside", lo: 20, hi: 26 }), rule("u", sym, { kind: "stop", direction: "below", price: 19 }), ...extra.map((r) => rule("u", sym, { kind: "target", direction: "above", level: 1, price: 31, ...r }))];
    const [inZone, under] = etfGroups(
      [
        { symbol: "KORU", market: "US", rules: base("KORU", [{}]), bars: bars(25), held: false },
        { symbol: "SOXS", market: "US", rules: base("SOXS", []), bars: bars(18), held: null },
      ],
      EIGHT,
    );
    expect(inZone!.rows).toEqual([
      { label: "매수 검토 구간", value: "$20.00–26.00" },
      { label: "1차 익절", value: "$31.00", sub: "보유 중일 때만 해당" },
      { label: "손절", value: "$19.00", sub: "보유 중일 때만 해당" },
      { label: "예상 수익률", value: "+24.0% (추정)" },
      { label: "예상 손실률", value: "−24.0% (추정)" },
      { label: "손익비", value: "1.00" },
      { label: "진입 조건", value: "확인 대기", sub: "가격 구간 도달" },
      { label: "전략", value: "만료·무효화 없음" },
    ]);
    // the stop above the price: no R:R
    expect(under!.rows.filter((r) => ["손익비", "진입 조건"].includes(r.label))).toEqual([{ label: "진입 조건", value: "미충족", sub: "가격이 구간 아래예요" }]);
  });
});

describe("words of the day", () => {
  test("A13 holidays: a US holiday between the last session and 08:00 names that session's day; a weekend alone says nothing", () => {
    expect(holidayNote(KST(2026, 11, 27, 8, 0))).toBe("휴장일이라 11월 25일(수) 마감 기준이에요."); // Thanksgiving
    expect(holidayNote(KST(2026, 11, 28, 8, 0))).toBeNull(); // the 27th's early close is a session
    expect(holidayNote(KST(2026, 11, 30, 8, 0))).toBeNull(); // Monday on Friday's close
    expect(holidayNote(KST(2027, 3, 29, 8, 0))).toBe("휴장일이라 3월 25일(목) 마감 기준이에요."); // Good Friday, then the weekend
    expect(holidayNote(KST(2027, 1, 1, 8, 0))).toBeNull(); // New Year's Eve was a session; the holiday is still ahead
    expect(holidayNote(KST(2027, 1, 4, 8, 0))).toBe("휴장일이라 2026년 12월 31일(목) 마감 기준이에요."); // New Year's Day, the weekend; another year named
  });

  test("a report of another KST year is named with its year when read (overview and screen); the card keeps its day's words", async () => {
    const w = await world();
    const a = await w.person("alice");
    w.answers.push(GOOD);
    await w.beat(KST(2026, 12, 31, 8, 0));
    const c = card(w.cards(a)[0]);
    expect(c.atText).toBe("12월 31일(목) 08:00");
    w.h.clock.t = KST(2027, 1, 1, 7, 0);
    expect((await w.get<InvestOverview>(a, "/api/invest")).body.reports.map((r) => r.title)).toEqual(["2026년 12월 31일(목) · 탈출 3 · 회복 최소 1"]);
    expect((await w.get<InvestReport>(a, `/api/invest/reports/${c.reportId}`)).body).toMatchObject({ title: "2026년 12월 31일 보고서", atText: "2026년 12월 31일(목) 08:00" });
  });

  test("highlightsOf: danger, caution, plain in that order; a line back under its mark and back over the 200-day line are recovery news (no stage move here)", () => {
    const s = (vs: number[]) => ({ values: vs.map((v, i) => ({ t: `2026-${String(1 + Math.floor(i / 28)).padStart(2, "0")}-${String((i % 28) + 1).padStart(2, "0")}`, v })), asOf: "x", source: "FRED", grade: "A" });
    // 199 days at 100, then 90 (under the line), then 120 (over it again)
    const back = s([...Array(199).fill(100), 90, 120]);
    const under = s([...Array(199).fill(100), 110, 90]);
    expect(highlightsOf({ read: { hy: s([3.9, 4.1]), vix: s([26, 24]), spx: back, kospi: under }, seen: {}, rules: [], since: 0 })).toEqual([
      { tone: "danger", text: "하이일드 스프레드가 4.0%p 이상이 됐어요" },
      { tone: "caution", text: "코스피가 200일선 아래로 내려갔어요" },
      { tone: "plain", text: "VIX가 25 아래로 내려왔어요" },
      { tone: "plain", text: "S&P500이 200일선 위로 올라왔어요" },
    ]);
    // told once: the last point already seen by the last report
    expect(highlightsOf({ read: { hy: s([3.9, 4.1]) }, seen: { hy: s([3.9, 4.1]).values[1]!.t }, rules: [], since: 0 })).toEqual([]);
  });

  test("the stage line's tone (DD 0828 1a), the short heads (DD 0733 C) and 판정 신뢰도's edges", () => {
    const h = (stage: number | null, o: { floor?: true; text?: string } = {}) => ({ stage, text: o.text ?? "", ...(o.floor ? { floor: true } : {}) });
    const tone = (pe: number | null, ne: number | null, pr: number | null, nr: number | null, floor = false) => stageToneOf({ escape: h(pe, floor ? { floor: true } : {}), recovery: h(pr) }, { escape: h(ne), recovery: h(nr) });
    expect([tone(2, 4, 0, 0, true), tone(3, 4, 1, 1), tone(2, 3, 0, 0), tone(3, 2, 1, 1), tone(2, 2, 1, 0), tone(2, 2, 0, 1), tone(2, 2, 1, null), tone(null, 3, 0, 0)]).toEqual(["danger", "danger", "caution", null, "caution", null, null, null]);
    expect([
      shortHead("탈출", h(2)),
      shortHead("탈출", h(2, { floor: true })),
      shortHead("회복", h(1)),
      shortHead("회복", h(null, { text: "회복 판정 보류" })),
      shortHead("회복", h(null, { text: "회복 단계 미확정" })),
    ]).toEqual(["탈출 2", "탈출 최소 2", "회복 1", "회복 보류", "회복 미확정"]);
    expect([0, 1, 3, 4, 5, 11].map(confidenceOf)).toEqual(["높음", "보통", "보통", "낮음", "낮음", "낮음"]);
  });
});
