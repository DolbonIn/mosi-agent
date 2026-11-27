/**
 * Invest B2e rest (team-lead 1854, DD 1857-b): foreigners' daily net KOSPI trading for indicator 9 and R6, asked with
 * each person's own Toss token at their 08:00 judgment, settled days only, kept as that person's rows (v16
 * `invest_flows`). Toss is test/fake-toss.ts with synthetic records; nothing real is called.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { InvestOverview, InvestStagesDetail } from "@pickle/protocol";
import type { CredentialAccess } from "@pickle/agent";
import * as idb from "../src/invest/db.ts";
import { flowSumText } from "../src/invest/stages.ts";
import { readInvestorTrading } from "../src/invest/toss.ts";
import { FAKE_TOSS_BASE, flowRecord, makeInvestUpstream, syntheticBars } from "./fake-toss.ts";
import { makeFakeVault, makeHarness, type Harness } from "./helpers.ts";

const LAST = "2026-11-27";
const KST = (y: number, mo: number, d: number, hh = 9, mi = 0) => Date.UTC(y, mo - 1, d, hh - 9, mi);
const EIGHT = KST(2026, 12, 1, 8, 0);
const FLOW_PATH = "/api/v1/market-indicators/KOSPI/investor-trading?interval=1d&count=30";

const harnesses: Harness[] = [];
afterEach(async () => {
  while (harnesses.length) await harnesses.pop()!.close();
});

/** weekdays from `from` to `to` */
function weekdays(from: string, to: string): string[] {
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
    if (++m > 12) {
      m = 1;
      y++;
    }
  }
  return out;
}
const csv = (id: string, rows: [string, number][]) => `observation_date,${id}\n${rows.map(([t, v]) => `${t},${v}`).join("\n")}\n`;

/** a quiet market (as invest-stages' quiet): nothing at risk, recovery signals R1, R2, R3 and R5 on, KOSPI on its 200-day line */
function quietFred(): Map<string, string> {
  const days = weekdays("2025-10-01", LAST);
  const flat = (v: number) => days.map((t): [string, number] => [t, v]);
  const fred = new Map<string, string>();
  for (const [id, v] of [["DGS10", 4.5], ["DGS2", 4], ["DFEDTARU", 4.25], ["BAMLH0A0HYM2", 3], ["DEXJPUS", 150], ["VIXCLS", 20], ["DEXKOUS", 1350]] as const) fred.set(id, csv(id, flat(v)));
  fred.set("UNRATE", csv("UNRATE", months("2024-01").map((t): [string, number] => [t, 4.1])));
  fred.set("CPILFESL", csv("CPILFESL", months("2024-01").map((t, i): [string, number] => [t, Number((300 * 1.001 ** i).toFixed(3))])));
  fred.set("SP500", csv("SP500", days.map((t, i): [string, number] => [t, 5000 + i * 3])));
  fred.set("SAHMREALTIME", csv("SAHMREALTIME", months("2024-01").map((t): [string, number] => [t, 0.1])));
  fred.set("IC4WSA", csv("IC4WSA", days.filter((_, i) => i % 5 === 4).map((t): [string, number] => [t, 220_000])));
  fred.set("NFCI", csv("NFCI", days.filter((_, i) => i % 5 === 4).map((t): [string, number] => [t, -0.5])));
  return fred;
}

/** each person's Toss login hands its own bogus client id to `use`: one person's token is told apart from another's */
const clientOf = (userId: string) => `ci-${userId}`;
function personVault(v: ReturnType<typeof makeFakeVault>): ReturnType<typeof makeFakeVault> {
  return {
    ...v,
    access(userId, o) {
      const a = v.access(userId, o);
      const use: CredentialAccess["use"] = (id, p, fn) => a.use(id, p, () => fn({ clientId: clientOf(userId), clientSecret: "cs-bogus-91c2" }));
      return { ...a, use };
    },
  };
}

/** `kospiLast`: KOSPI's last close (2,500 on every other day; the 200-day line moves with it); null: no KOSPI at all */
async function world(o: { tossBase?: string | null; kospiLast?: number | null } = {}) {
  const up = makeInvestUpstream();
  for (const [k, v] of quietFred()) up.state.fred.set(k, v);
  const bars = syntheticBars(LAST, 260, 2500, 30);
  if (typeof o.kospiLast === "number") bars[bars.length - 1] = { ...bars.at(-1)!, o: o.kospiLast, h: o.kospiLast + 15, l: o.kospiLast - 15, c: o.kospiLast };
  if (o.kospiLast !== null) up.state.yahooDaily.set("^KS11", bars);
  const h = await makeHarness({
    now: EIGHT - 3_600_000,
    config: { invest: { sources: true, tossBase: o.tossBase === undefined ? FAKE_TOSS_BASE : o.tossBase, outboundIp: null } },
    deps: ({ vault }) => ({ investFetch: up.fetch, vault: personVault(vault) }),
  });
  harnesses.push(h);
  /** `watchOnly`: no invest settings, one watched symbol (never opened the invest screen) */
  const person = async (handle: string, toss: boolean, o: { watchOnly?: boolean } = {}) => {
    const s = await h.signup(handle);
    const id = s.session.user.id;
    if (o.watchOnly) idb.addWatch(h.db, { user_id: id, symbol: "005930", market: "KR", name: "삼성전자", added_at: h.clock.t });
    else idb.ensureSettings(h.db, id, h.clock.t);
    if (toss) {
      const envelope = { v: 1, alg: "ECDH-P256+HKDF-SHA256+A256GCM", kid: "kid-test", epk: { kty: "EC" }, iv: "aXY", ct: "Y3Q", aad: `${id}:toss-investment:token` };
      const r = await h.req("POST", "/api/credentials", { token: s.token, body: { service: "toss-investment", label: "토스증권", kind: "token", hint: "계좌 1개", keepFor: "forever", envelope } });
      expect(r.status).toBe(201);
      await h.app.core.idle();
    }
    const get = async <T>(path: string) => (await (await h.req("GET", path, { token: s.token })).json()) as T;
    return { id, client: clientOf(id), detail: () => get<InvestStagesDetail>("/api/invest/stages"), overview: () => get<InvestOverview>("/api/invest") };
  };
  const judge = async (at: number) => {
    h.clock.t = at;
    return h.app.core.invest.judgeStages(at);
  };
  /** the Toss market-data calls since `from` (the token and the save's holdings check left out) */
  const flowCalls = (from: number) => up.calls.slice(from).filter((c) => c.host === "toss.fake.test" && c.path.includes("investor-trading"));
  const rows = (id: string) => h.db.sql.query("SELECT market, day, individual_net, foreign_net, institution_net, fetched_at FROM invest_flows WHERE user_id = $u ORDER BY day").all({ u: id }) as { market: string; day: string; individual_net: number | null; foreign_net: number; institution_net: number | null; fetched_at: number }[];
  return { h, up, person, judge, flowCalls, rows };
}

type P = Awaited<ReturnType<Awaited<ReturnType<typeof world>>["person"]>>;
const row9 = async (p: P) => (await p.detail()).core11.find((r) => r.no === 9)!;
const r6 = async (p: P) => (await p.detail()).groups.find((g) => g.key === "recover")!.rows.find((r) => r.id === "R6")!;
/** every row of the detail but R6 (11 indicators, each group's conditions) that carries an R6 tail's words */
const tailsBesideR6 = (d: InvestStagesDetail) =>
  [...d.core11.map((r) => [`#${r.no}`, JSON.stringify(r)] as const), ...d.groups.flatMap((g) => g.rows.filter((r) => r.id !== "R6").map((r) => [r.id, JSON.stringify(r)] as const))]
    .filter(([, s]) => s.includes("외국인 수급은") || s.includes("코스피는"))
    .map(([id]) => id);

/** 30 settled weekdays ending 11-30 (the day before the 12-01 judgment) */
const SETTLED = weekdays("2026-10-01", "2026-11-30").slice(-30);
/**
 * alice: the last 20 settled days sum to −12,345억 (19 × −600, then −945), the 10 before them +5,000 each; bob: +3,400억
 * (15 × +100, then 5 × +380). Both have 12-01's record too, provisional (the judgment's own day): +99,999억.
 */
const ALICE = SETTLED.map((d, i) => flowRecord(d, i < 10 ? 5000 : i < 29 ? -600 : -945));
const BOB = SETTLED.map((d, i) => flowRecord(d, i < 10 ? -7000 : i < 25 ? 100 : 380));
const PROVISIONAL = flowRecord("2026-12-01", 99_999, { updatedAt: "2026-12-01T07:55:00+09:00" });

describe("the read (team-lead 1854 1, 3)", () => {
  test("at the 08:00 judgment, once, with each person's own token, KOSPI only; settled days kept as their rows; 9 and R6 read them; no login, no call", async () => {
    const w = await world();
    const alice = await w.person("alice", true);
    const bob = await w.person("bob", true);
    const carol = await w.person("carol", false);
    w.up.state.tossFlowsBy.set(alice.client, [...ALICE, PROVISIONAL]);
    w.up.state.tossFlowsBy.set(bob.client, [...BOB, PROVISIONAL]);
    const mark = w.up.calls.length;
    expect(await w.judge(EIGHT - 60_000)).toBe(0);
    expect(w.flowCalls(mark)).toEqual([]);
    expect(await w.judge(EIGHT)).toBe(3);
    // one call each for alice and bob, their own token each; carol has no login: no call for her
    const calls = w.flowCalls(mark);
    expect(calls.map((c) => [c.path, c.client]).sort()).toEqual([[FLOW_PATH, alice.client], [FLOW_PATH, bob.client]].sort());
    expect(w.up.calls.slice(mark).filter((c) => /KOSDAQ/.test(c.path))).toEqual([]);
    // settled days only: the 30 records asked for hold 12-01's provisional one (the judgment's own day), so 29 are kept;
    // each person's own amounts, the four groups net in won
    expect(w.rows(alice.id).map((r) => r.day)).toEqual(SETTLED.slice(1));
    expect(w.rows(alice.id).at(-1)).toEqual({ market: "KOSPI", day: "2026-11-30", individual_net: 472e8, foreign_net: -945e8, institution_net: 473e8, fetched_at: EIGHT });
    expect(w.rows(bob.id).map((r) => r.foreign_net / 1e8)).toEqual(SETTLED.map((_, i) => (i < 10 ? -7000 : i < 25 ? 100 : 380)).slice(1));
    expect(w.rows(carol.id)).toEqual([]);
    // the stored row (the screen, invest_snapshot and the report read it): where 9's input came from, as of its last settled day
    const stored = (id: string) => JSON.parse((w.h.db.sql.query("SELECT json FROM invest_judgments WHERE user_id = $u").get({ u: id }) as { json: string }).json) as { basis: Record<string, unknown>; missing: Record<string, unknown> };
    expect([stored(alice.id).basis.foreignKospi, stored(alice.id).missing.foreignKospi]).toEqual([{ asOf: "2026-11-30", source: "토스증권", grade: "A" }, null]);
    expect([stored(carol.id).basis.foreignKospi, stored(carol.id).missing.foreignKospi]).toEqual([null, "connect"]);
    // 9: the 20-day sum as its value while it stays without a judgment (DD 1857-b 3); where it came from (§1)
    expect(await row9(alice)).toMatchObject({ signal: "unknown", value: "20일 −1.2조원", basis: "11월 30일 · 토스증권 · A", reason: "대규모 순매도 지속 여부 판단 없음" });
    expect(await row9(bob)).toMatchObject({ signal: "unknown", value: "20일 +3,400억원", basis: "11월 30일 · 토스증권 · A", reason: "대규모 순매도 지속 여부 판단 없음" });
    expect(await row9(carol)).toMatchObject({ signal: "unknown", value: null, basis: "토스증권을 연결하면 받아요" });
    // R6 (DD 2012): bob's foreigners bought 20 days in a row (KOSPI sits on its 200-day line, not above): met on his
    // numbers alone; the rule's order, foreigners first, KOSPI named; carol: the foreign side's reason after the sources
    expect(await r6(bob)).toMatchObject({ state: "met", detail: "외국인 20거래일 연속 순매수 · 코스피 2,500.00 · 200일선 2,500.00 · 11월 26일 · 토스증권 · A, Yahoo(지연 시세) · B+" });
    expect(await r6(alice)).toMatchObject({ state: "unmet", detail: "외국인 20거래일 연속 순매도 · 코스피 2,500.00 · 200일선 2,500.00 · 11월 26일 · 토스증권 · A, Yahoo(지연 시세) · B+" });
    expect(await r6(carol)).toMatchObject({ state: "unknown", detail: "코스피 2,500.00 · 200일선 2,500.00 · 11월 26일 · Yahoo(지연 시세) · B+ · 외국인 수급은 토스증권을 연결하면 받아요" });
    // the tail is R6's alone (DD 2027 2): no other row of carol's says it
    expect(tailsBesideR6(await carol.detail())).toEqual([]);
    // once a day: the next beat asks nobody again
    const after = w.up.calls.length;
    expect(await w.judge(EIGHT + 30_000)).toBe(0);
    expect(w.flowCalls(after)).toEqual([]);
  });

  test("the head: no login counts with the quiet form, a read that did not come with the caution form; received, nothing missing on its side", async () => {
    const w = await world();
    const alice = await w.person("alice", true);
    const bob = await w.person("bob", true);
    const carol = await w.person("carol", false);
    w.up.state.tossFlowsBy.set(alice.client, ALICE);
    w.up.state.tossFlowsBy.set(bob.client, [flowRecord("2026-12-01", 10)]); // only today's provisional record: nothing settled
    await w.judge(EIGHT);
    const rec = async (p: P) => ((await p.overview()).stages as { recovery: { text: string; pending?: string; pendingTone?: string } }).recovery;
    // four ledger inputs have no figure (quiet); carol's R6 rests on a login she has not made: quiet too, five in all
    expect(await rec(carol)).toMatchObject({ pending: "지표 5개 값이 없어서 회복 단계는 아직 몰라요.", pendingTone: "quiet" });
    expect(await rec(bob)).toMatchObject({ pending: "지표 4개 값이 없고 오늘 1개를 받지 못해서 회복 단계는 아직 몰라요.", pendingTone: "caution" });
    expect(await row9(bob)).toMatchObject({ value: null, basis: "오늘 받지 못했어요" });
    // alice's R6 is settled (unmet): the four ledger inputs alone
    expect(await rec(alice)).toMatchObject({ pending: "지표 4개 값이 없어서 회복 단계는 아직 몰라요.", pendingTone: "quiet" });
  });

  test("a refused, paused, rate-limited or failed read: 오늘 받지 못했어요, nothing kept; 403 pauses an hour, 429 five minutes; an earlier day's rows are not used", async () => {
    const w = await world();
    const alice = await w.person("alice", true);
    w.up.state.tossFlowsBy.set(alice.client, ALICE);
    const paused = () => idb.getSettings(w.h.db, alice.id)!.toss_paused_until;
    // 403 (the allowed IP): the caution words, no rows, the person's Toss reads pause an hour
    w.up.state.tossStatus = 403;
    await w.judge(EIGHT);
    expect(await row9(alice)).toMatchObject({ value: null, basis: "오늘 받지 못했어요" });
    expect([w.rows(alice.id), paused()]).toEqual([[], EIGHT + 3_600_000]);
    // the next day it comes
    w.up.state.tossStatus = null;
    await w.judge(KST(2026, 12, 2, 8, 0));
    expect(await row9(alice)).toMatchObject({ value: "20일 −1.2조원", basis: "11월 30일 · 토스증권 · A" });
    expect(paused()).toBeNull();
    // a pause still running at 08:00 (a watch read was refused at 07:50): no call at all
    idb.updateSettings(w.h.db, alice.id, { toss_paused_until: KST(2026, 12, 3, 8, 30) }, KST(2026, 12, 3, 7, 50));
    let mark = w.up.calls.length;
    await w.judge(KST(2026, 12, 3, 8, 0));
    expect(w.flowCalls(mark)).toEqual([]);
    expect(await row9(alice)).toMatchObject({ value: null, basis: "오늘 받지 못했어요" });
    // 429: five minutes; 500: no pause (the 429's ends); neither uses the rows kept on 12-02
    w.up.state.tossStatus = 429;
    await w.judge(KST(2026, 12, 4, 8, 0));
    expect(await row9(alice)).toMatchObject({ value: null, basis: "오늘 받지 못했어요" });
    expect(paused()).toBe(KST(2026, 12, 4, 8, 5));
    w.up.state.tossStatus = 500;
    mark = w.up.calls.length;
    await w.judge(KST(2026, 12, 7, 8, 0));
    expect(w.flowCalls(mark).length).toBeGreaterThan(0);
    expect(await row9(alice)).toMatchObject({ value: null, basis: "오늘 받지 못했어요" });
    expect(paused()).toBeNull();
    expect(w.rows(alice.id)).toHaveLength(30);
  });

  test("a later read rewrites a kept day with its own numbers; fewer than 20 settled days: no 20-day sum (확인 불가), R6 still read", async () => {
    const w = await world();
    const alice = await w.person("alice", true);
    w.up.state.tossFlowsBy.set(alice.client, SETTLED.slice(-12).map((d) => flowRecord(d, 200)));
    await w.judge(EIGHT);
    expect(await row9(alice)).toMatchObject({ value: null, basis: "11월 30일 · 토스증권 · A" });
    expect((await r6(alice)).state).toBe("met");
    // the next day: 11-30 now reads −50억 (and 12-01 is settled)
    w.up.state.tossFlowsBy.set(alice.client, [...SETTLED.slice(-12, -1).map((d) => flowRecord(d, 200)), flowRecord("2026-11-30", -50), flowRecord("2026-12-01", 300)]);
    await w.judge(KST(2026, 12, 2, 8, 0));
    expect(w.rows(alice.id).slice(-2).map((r) => [r.day, r.foreign_net / 1e8, r.fetched_at])).toEqual([
      ["2026-11-30", -50, KST(2026, 12, 2, 8, 0)],
      ["2026-12-01", 300, KST(2026, 12, 2, 8, 0)],
    ]);
    expect((await r6(alice)).state).toBe("unmet");
    expect(await row9(alice)).toMatchObject({ value: null, basis: "12월 1일 · 토스증권 · A" });
    // a read that brings only the day's own provisional record: nothing today, the kept rows are not used
    w.up.state.tossFlowsBy.set(alice.client, [flowRecord("2026-12-03", 500)]);
    await w.judge(KST(2026, 12, 3, 8, 0));
    expect(await row9(alice)).toMatchObject({ value: null, basis: "오늘 받지 못했어요" });
    expect((await r6(alice)).state).toBe("unknown");
    expect(w.rows(alice.id).map((r) => r.day).at(-1)).toBe("2026-12-01");
  });

  test("someone who never opened the invest screen (a watched symbol, no settings) and has no login: no call, no settings row made", async () => {
    const w = await world();
    const dan = await w.person("dan", false, { watchOnly: true });
    const mark = w.up.calls.length;
    expect(await w.judge(EIGHT)).toBe(1);
    expect(w.flowCalls(mark)).toEqual([]);
    expect(idb.getSettings(w.h.db, dan.id)).toBeNull();
    expect(w.h.db.sql.query("SELECT json FROM invest_judgments WHERE user_id = $u").get({ u: dan.id })).toEqual({ json: expect.stringContaining('"foreignKospi":"connect"') });
  });

  test("Toss off on this server: nowhere to get it (받을 곳이 아직 없어요), no call, login or not; R6 says it after KOSPI's source, on a met day too", async () => {
    const w = await world({ tossBase: null, kospiLast: 2600 });
    const alice = await w.person("alice", true);
    const mark = w.up.calls.length;
    await w.judge(EIGHT);
    expect(w.up.calls.slice(mark).filter((c) => c.host === "toss.fake.test")).toEqual([]);
    expect(await row9(alice)).toMatchObject({ value: null, basis: "받을 곳이 아직 없어요" });
    expect(await r6(alice)).toMatchObject({ state: "met", detail: "코스피 2,600.00 · 200일선 2,500.50 · 11월 26일 · Yahoo(지연 시세) · B+ · 외국인 수급은 받을 곳이 아직 없어요" });
  });

  test("R6's run is the streak its state rests on (DD 2012 1): 5 days met, 4 with KOSPI below unmet; a last day of 0, no run; a read that did not come, said after the sources", async () => {
    const w = await world({ kospiLast: 2400 });
    const run = (n: number, last = 300) => SETTLED.map((d, i) => flowRecord(d, i === 29 ? last : i >= 30 - n ? 300 : -200));
    const erin = await w.person("erin", true);
    const finn = await w.person("finn", true);
    const gus = await w.person("gus", true);
    const hana = await w.person("hana", true);
    w.up.state.tossFlowsBy.set(erin.client, run(5));
    w.up.state.tossFlowsBy.set(finn.client, run(4));
    w.up.state.tossFlowsBy.set(gus.client, run(5, 0));
    // hana's read answers with no record at all: nothing today
    await w.judge(EIGHT);
    const tail = "11월 26일 · 토스증권 · A, Yahoo(지연 시세) · B+";
    expect(await r6(erin)).toMatchObject({ state: "met", detail: `외국인 5거래일 연속 순매수 · 코스피 2,400.00 · 200일선 2,499.50 · ${tail}` });
    expect(await r6(finn)).toMatchObject({ state: "unmet", detail: `외국인 4거래일 연속 순매수 · 코스피 2,400.00 · 200일선 2,499.50 · ${tail}` });
    expect(await r6(gus)).toMatchObject({ state: "unmet", detail: `코스피 2,400.00 · 200일선 2,499.50 · ${tail}` });
    // KOSPI below and the foreign side missing: 확인 불가 (Kleene OR), and the line says why
    expect(await r6(hana)).toMatchObject({ state: "unknown", detail: "코스피 2,400.00 · 200일선 2,499.50 · 11월 26일 · Yahoo(지연 시세) · B+ · 외국인 수급은 오늘 받지 못했어요" });
  });

  test("a login whose read finds no session (connected, then not_connected): a read that did not come, never 연결하면 (DD 2027 1)", async () => {
    const w = await world();
    const alice = await w.person("alice", true);
    w.up.state.tossFlowsBy.set(alice.client, ALICE);
    const conn = w.h.app.core.connections;
    const real = conn.sessionFor.bind(conn);
    conn.sessionFor = async (u, s) => (u === alice.id ? null : real(u, s));
    await w.judge(EIGHT);
    expect(await row9(alice)).toMatchObject({ value: null, basis: "오늘 받지 못했어요" });
    expect(await r6(alice)).toMatchObject({ detail: "코스피 2,500.00 · 200일선 2,500.00 · 11월 26일 · Yahoo(지연 시세) · B+ · 외국인 수급은 오늘 받지 못했어요" });
    const stored = JSON.parse((w.h.db.sql.query("SELECT json FROM invest_judgments WHERE user_id = $u").get({ u: alice.id }) as { json: string }).json) as { missing: Record<string, unknown> };
    expect(stored.missing.foreignKospi).toBe("today");
    expect(w.rows(alice.id)).toEqual([]);
  });

  test("KOSPI missing, the foreign side here: KOSPI's reason after the sources, unknown at 4 days and met at 6 (DD 2027 3); the tail is R6's alone", async () => {
    const w = await world({ kospiLast: null });
    const run = (n: number) => SETTLED.map((d, i) => flowRecord(d, i >= 30 - n ? 300 : -200));
    const ivy = await w.person("ivy", true);
    const jun = await w.person("jun", true);
    w.up.state.tossFlowsBy.set(ivy.client, run(4));
    w.up.state.tossFlowsBy.set(jun.client, run(6));
    await w.judge(EIGHT);
    expect(await r6(ivy)).toMatchObject({ state: "unknown", detail: "외국인 4거래일 연속 순매수 · 11월 30일 · 토스증권 · A · 코스피는 오늘 받지 못했어요" });
    expect(await r6(jun)).toMatchObject({ state: "met", detail: "외국인 6거래일 연속 순매수 · 11월 30일 · 토스증권 · A · 코스피는 오늘 받지 못했어요" });
    expect(tailsBesideR6(await ivy.detail())).toEqual([]);
    expect(tailsBesideR6(await jun.detail())).toEqual([]);
  });

  test("R6 with neither side: the basis words alone (오늘 받지 못했어요 first), no tail", async () => {
    const w = await world({ kospiLast: null });
    const carol = await w.person("carol", false);
    await w.judge(EIGHT);
    expect(await r6(carol)).toMatchObject({ state: "unknown", detail: "오늘 받지 못했어요" });
  });

  test("a flows read that throws: that person's judgment is still made, the caution words for 9; the others' are their own", async () => {
    const w = await world();
    const alice = await w.person("alice", true);
    const bob = await w.person("bob", true);
    w.up.state.tossFlowsBy.set(bob.client, BOB);
    const hub = w.h.app.core.invest;
    const real = hub.flowsFor.bind(hub);
    hub.flowsFor = async (u, now) => (u === alice.id ? Promise.reject(new Error("boom")) : real(u, now));
    expect(await w.judge(EIGHT)).toBe(2);
    expect(await row9(alice)).toMatchObject({ value: null, basis: "오늘 받지 못했어요" });
    expect(await row9(bob)).toMatchObject({ value: "20일 +3,400억원" });
  });

  test("a person's rows go with the person (v16, ON DELETE CASCADE)", async () => {
    const w = await world();
    const alice = await w.person("alice", true);
    w.up.state.tossFlowsBy.set(alice.client, ALICE);
    await w.judge(EIGHT);
    expect(w.rows(alice.id)).toHaveLength(30);
    w.h.db.sql.query("DELETE FROM users WHERE id = $u").run({ u: alice.id });
    expect(w.h.db.sql.query("SELECT COUNT(*) AS n FROM invest_flows").get()).toEqual({ n: 0 });
  });
});

describe("the words and the reading (DD 1857-b 3, openapi 1.2.28)", () => {
  test("9's value: 조 with one decimal from 1조 (1만 억), else 억 with commas; signed with U+2212; zero unsigned", () => {
    expect([-12_345, 123_456, 10_000, 9_999.5, 9_999.4, 3_400, -850.4, 0, -0.4, 0.4].map(flowSumText)).toEqual([
      "20일 −1.2조원",
      "20일 +12.3조원",
      "20일 +1.0조원",
      "20일 +1.0조원",
      "20일 +9,999억원",
      "20일 +3,400억원",
      "20일 −850억원",
      "20일 0억원",
      "20일 0억원",
      "20일 0억원",
    ]);
    expect(flowSumText(-12_345)).toContain("−");
  });

  test("the record: net per group in won (buy − sell), oldest first, one a day; no day, or foreigners' amounts unreadable: left out", () => {
    const ok = flowRecord("2026-11-27", -945);
    const records = [
      flowRecord("2026-11-30", 120),
      { ...ok, date: "2026-11-27" },
      { ...flowRecord("2026-11-26", 10), foreigner: { buyAmount: "1.5", sellAmount: "1" } },
      { ...flowRecord("2026-11-25", 10), foreigner: { buyAmount: "-5", sellAmount: "1" } },
      { ...flowRecord("2026-11-24", 10), foreigner: { buyAmount: "100" } },
      { ...flowRecord("2026-11-21", 10), foreigner: { buyAmount: -5, sellAmount: 1 } },
      { ...flowRecord("2026-11-23", 10), date: "11/23" },
      { ...flowRecord("2026-11-20", 10), individual: null, institution: { buyAmount: 7e10, sellAmount: 2e10 } },
      flowRecord("2026-11-30", 999),
    ];
    expect(readInvestorTrading({ result: { nextUntil: null, records } })).toEqual([
      { day: "2026-11-20", individual: null, foreign: 10e8, institution: 5e10 },
      { day: "2026-11-27", individual: 472e8, foreign: -945e8, institution: 473e8 },
      { day: "2026-11-30", individual: -60e8, foreign: 120e8, institution: -60e8 },
    ]);
    for (const j of [null, {}, { result: null }, { result: { records: "x" } }, [ok]]) expect(readInvestorTrading(j)).toEqual([]);
  });
});
