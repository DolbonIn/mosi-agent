/**
 * Invest B2c-2: what the session's checks read besides the rules (A14 매 실행 13단계 — 급격한 갭, 추격 금지,
 * 분할·병합; team-lead 0747 8 · 0856, DD 0847): the buy zone alert in A16's middle frame, the `시장` row from the
 * day's judgment, a big gap at the open, a run far above the buy zone, a split or a merge that stops the symbol's rules
 * until the person saves them. Code only, no model. Upstreams are test/fake-toss.ts; nothing real is called.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { InvestAlertCard, InvestOverview, InvestRuleRow, InvestStopCard, ServerEvent } from "@pickle/protocol";
import type { CredentialAccess } from "@pickle/agent";
import { etToEpoch } from "../src/invest/calendar.ts";
import { stopCallLine } from "../src/invest/cards.ts";
import type { RuleSpec } from "../src/invest/rules.ts";
import * as idb from "../src/invest/db.ts";
import { BIG_MOVE_ATR, BIG_MOVE_PCT, gapOf, runAbove, SPLIT_RATIOS, SPLIT_TOLERANCE, splitOf } from "../src/invest/intraday.ts";
import { parseYahooQuote } from "../src/invest/sources.ts";
import { RECOVERY_HOLD, stageCallOf, stageRowText } from "../src/invest/stages.ts";
import { writeMyPhone } from "../src/phone.ts";
import { BOGUS_TOSS_SECRET, FAKE_TOSS_BASE, makeInvestUpstream, syntheticBars } from "./fake-toss.ts";
import { makeFakeVault, makeHarness, type Harness } from "./helpers.ts";

const A = "2026-11-30"; // Monday, a full session
const B = "2026-12-01"; // Tuesday: its first check's check before is A's close check
const ET = (day: string, h: number, m: number) => etToEpoch(day, h, m);
const sec = (ms: number) => Math.floor(ms / 1000);
const KST = (y: number, mo: number, d: number, hh = 9, mi = 0) => Date.UTC(y, mo - 1, d, hh - 9, mi);

// the report tests' calm market for the day's judgment (탈출 3단계 · 회복 최소 1단계), ending on A
function weekdays(from: string, to = A): string[] {
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
  while (`${y}-${String(m).padStart(2, "0")}` <= A.slice(0, 7)) {
    out.push(`${y}-${String(m).padStart(2, "0")}-01`);
    if (++m > 12) {
      m = 1;
      y++;
    }
  }
  return out;
}
const csv = (id: string, rows: [string, number][]) => `observation_date,${id}\n${rows.map(([t, v]) => `${t},${v}`).join("\n")}\n`;
function calm(): Map<string, string> {
  const days = weekdays("2025-10-01");
  const flat = (v: number) => days.map((t): [string, number] => [t, v]);
  const last = (v: number, l: number) => days.map((t, i): [string, number] => [t, i === days.length - 1 ? l : v]);
  return new Map([
    ["DGS10", csv("DGS10", flat(4.5))],
    ["DGS2", csv("DGS2", last(4, 3.96))],
    ["DFEDTARU", csv("DFEDTARU", flat(4.25))],
    ["BAMLH0A0HYM2", csv("BAMLH0A0HYM2", last(3, 3.6))],
    ["DEXJPUS", csv("DEXJPUS", flat(150))],
    ["UNRATE", csv("UNRATE", months("2024-01").map((t): [string, number] => [t, 4.1]))],
    ["CPILFESL", csv("CPILFESL", months("2024-01").map((t, i): [string, number] => [t, Number((300 * 1.003 ** i).toFixed(3))]))],
    ["VIXCLS", csv("VIXCLS", flat(20))],
    ["SP500", csv("SP500", days.map((t, i): [string, number] => [t, 5000 + i * 3]))],
    ["NASDAQ100", csv("NASDAQ100", last(20_000, 20_200))],
    ["SAHMREALTIME", csv("SAHMREALTIME", months("2024-01").map((t): [string, number] => [t, 0.1]))],
    ["IC4WSA", csv("IC4WSA", days.filter((_, i) => i % 5 === 4).map((t): [string, number] => [t, 220_000]))],
    ["DEXKOUS", csv("DEXKOUS", flat(1350))],
    ["NFCI", csv("NFCI", days.filter((_, i) => i % 5 === 4).map((t): [string, number] => [t, -0.5]))],
  ]);
}

function tossVault(v: ReturnType<typeof makeFakeVault>): ReturnType<typeof makeFakeVault> {
  return {
    ...v,
    access(userId, o) {
      const a = v.access(userId, o);
      const use: CredentialAccess["use"] = (id, p, fn) => a.use(id, p, () => fn({ ...BOGUS_TOSS_SECRET }));
      return { ...a, use };
    },
  };
}

interface World {
  h: Harness;
  up: ReturnType<typeof makeInvestUpstream>;
  uid: string;
  token: string;
  events: ServerEvent[];
  pushes: { title: string; tag?: string }[];
}
const worlds: World[] = [];
afterEach(async () => {
  while (worlds.length) await worlds.pop()!.h.close();
});

/** ATR14 = `atr` exactly: flat bars with that high-low range, the last on the day before `B` */
async function world(o: { toss?: boolean; sources?: boolean; atr?: number; twilio?: boolean } = {}): Promise<World> {
  const up = makeInvestUpstream();
  for (const [k, v] of calm()) up.state.fred.set(k, v);
  up.state.yahooDaily.set("^KS11", syntheticBars(B, 260, 2500, 30));
  up.state.yahooDaily.set("^SOX", syntheticBars(B, 260, 5000, 50));
  up.state.yahooDaily.set("SOXL", syntheticBars(B, 60, 30, o.atr ?? 1));
  const h = await makeHarness({
    now: ET(A, 9, 0),
    config: { invest: { sources: o.sources ?? true, tossBase: o.toss ? FAKE_TOSS_BASE : null, outboundIp: "203.0.113.7" }, ...(o.twilio ? { twilio: { accountSid: "AC123", authToken: "tok", from: "+15550000000" } } : {}) },
    deps: ({ vault }) => ({ investFetch: up.fetch, vault: tossVault(vault) }),
  });
  const me = await h.signup("alice");
  const uid = me.session.user.id;
  const events: ServerEvent[] = [];
  const pushes: World["pushes"] = [];
  const pub = h.app.core.events.publish.bind(h.app.core.events);
  h.app.core.events.publish = (u, e) => {
    if (u === uid) events.push(e);
    pub(u, e);
  };
  h.app.core.push.send = async (u, m) => {
    if (u === uid) pushes.push(m as World["pushes"][number]);
    return 0;
  };
  const w = { h, up, uid, token: me.token, events, pushes };
  worlds.push(w);
  return w;
}

const api = async <T = unknown>(w: World, method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> => {
  const res = await w.h.req(method, path, { token: w.token, body });
  return { status: res.status, body: (await res.json()) as T };
};
async function watch(w: World, symbol = "SOXL") {
  expect([200, 201]).toContain((await api(w, "POST", "/api/invest/watchlist", { symbol })).status);
}
async function rule(w: World, draft: Record<string, unknown>): Promise<InvestRuleRow> {
  const r = await api<InvestRuleRow>(w, "POST", "/api/invest/rules", { draft: { symbol: "SOXL", action: "notify", ...draft } });
  expect(r.status).toBe(201);
  return r.body;
}
/** Yahoo's day chart for SOXL: price at `at`, the previous close, and (optionally) the first bar's open */
function quote(w: World, at: number, price: number, prevClose: number, open?: { price: number; at: number }) {
  w.up.state.yahoo.set("SOXL", { price, prevClose, time: sec(at), ...(open ? { open: { price: open.price, time: sec(open.at) } } : {}) });
}
async function judge(w: World, at: number) {
  const t = w.h.clock.t;
  w.h.clock.t = at;
  await w.h.app.core.invest.judgeStages(at);
  w.h.clock.t = t;
}
async function tickAt(w: World, day: string, h: number, m: number) {
  w.h.clock.t = ET(day, h, m);
  const r = await w.h.app.core.invest.tick();
  await w.h.app.core.idle();
  return r;
}
function alerts(w: World): InvestAlertCard[] {
  const tid = idb.getSettings(w.h.db, w.uid)?.thread_id;
  if (!tid) return [];
  const rows = w.h.db.sql.query("SELECT cards_json FROM messages WHERE thread_id = $t ORDER BY created_at, rowid").all({ t: tid }) as { cards_json: string }[];
  return rows.flatMap((r) => JSON.parse(r.cards_json) as InvestAlertCard[]).filter((c) => c.type === "invest_alert");
}
const banners = (w: World) => w.events.flatMap((e) => (e.type === "notification" ? [[e.title, e.body]] : []));
const rulesOf = async (w: World) => (await api<InvestOverview>(w, "GET", "/api/invest")).body.rules;

// ───────────────────────────── pure ─────────────────────────────

describe("the operational definitions (team-lead 0747 8b, 0856; contract)", () => {
  test("gap: ATR14 × 1 or more and 3% or more, both; either way up or down", () => {
    expect([BIG_MOVE_ATR, BIG_MOVE_PCT]).toEqual([1, 3]);
    expect(gapOf(103, 100, 3)).toEqual({ up: true, pct: 3, atrs: 1 });
    expect(gapOf(97, 100, 3)).toEqual({ up: false, pct: 3, atrs: 1 });
    expect(gapOf(102.99, 100, 1)).toBeNull(); // 2.99 ATR, 2.99%
    expect(gapOf(103.5, 100, 3.51)).toBeNull(); // 3.5%, 0.997 ATR
    expect([gapOf(104, 100, null), gapOf(104, 100, 0), gapOf(0, 100, 1), gapOf(104, 0, 1)]).toEqual([null, null, null, null]);
  });

  test("a run above the buy zone: in or under it before, above its top by ATR14 × 1 and 3% now", () => {
    expect(runAbove(26, 103, 100, 3)).toEqual({ over: 3, pct: 3, atrs: 1 });
    expect(runAbove(80, 103, 100, 3)).toEqual({ over: 3, pct: 3, atrs: 1 }); // from under the zone too
    expect(runAbove(100, 103, 100, 3)).not.toBeNull(); // the top itself is inside
    expect(runAbove(100.01, 110, 100, 3)).toBeNull(); // above the zone already at the check before
    expect(runAbove(99, 102.99, 100, 1)).toBeNull(); // 2.99%
    expect(runAbove(99, 103.5, 100, 3.51)).toBeNull(); // 0.997 ATR
    expect([runAbove(null, 110, 100, 3), runAbove(99, 110, 100, null)]).toEqual([null, null]);
  });

  test("split or merge: yesterday's price against today's previous close at a listed ratio, ±1%", () => {
    expect([...SPLIT_RATIOS]).toEqual([2, 3, 4, 5, 8, 10, 15, 20, 25, 50]);
    expect(SPLIT_TOLERANCE).toBe(0.01);
    expect(splitOf(32.57, 325.7)).toEqual({ kind: "merge", ratio: 10 });
    expect(splitOf(10, 100.9)).toEqual({ kind: "merge", ratio: 10 });
    expect(splitOf(10, 101.1)).toBeNull();
    expect(splitOf(40, 20)).toEqual({ kind: "split", ratio: 2 });
    expect(splitOf(100, 50.4)).toEqual({ kind: "split", ratio: 2 });
    expect(splitOf(100, 50.6)).toBeNull();
    expect(splitOf(10, 500)).toEqual({ kind: "merge", ratio: 50 });
    expect(splitOf(10, 70)).toBeNull(); // 7 is not a listed ratio
    // a crash does not rewrite yesterday's close: the ratio stays 1
    expect(splitOf(32.57, 32.57)).toBeNull();
    expect([splitOf(null, 10), splitOf(10, null), splitOf(0, 10)]).toEqual([null, null, null]);
  });

  test("the day chart's first bar with an open (a bar before the first trade has none)", () => {
    const body = (open: unknown[], ts: number[]) => JSON.stringify({ chart: { result: [{ meta: { regularMarketPrice: 31, regularMarketTime: 1_764_600_000, chartPreviousClose: 30 }, timestamp: ts, indicators: { quote: [{ open, close: [31, 31] }] } }], error: null } });
    expect(parseYahooQuote(body([null, 31.5], [1_764_599_400, 1_764_599_700]), "SOXL")).toMatchObject({ price: 31, prevClose: 30, open: { price: 31.5, at: 1_764_599_700_000 } });
    expect(parseYahooQuote(body([null, null], [1, 2]), "SOXL")).not.toHaveProperty("open");
  });
});

// ───────────────────────────── the buy zone alert and the 시장 row ─────────────────────────────

describe("the buy zone alert and the 시장 row (DD 0847 0 · 1)", () => {
  test("caution, A16's middle frame: 진입 조건 waits, 다음 = the person's stop and 1st target; 시장 = the day's judged heads", async () => {
    const w = await world();
    await watch(w);
    await rule(w, { kind: "buy_zone", lo: 25, hi: 27 });
    await rule(w, { kind: "stop", price: 22 });
    await rule(w, { kind: "target", level: 1, price: 32 });
    await rule(w, { kind: "target", level: 2, price: 36 });
    await judge(w, KST(2026, 12, 1, 8, 0));
    quote(w, ET(B, 9, 44), 26, 26.4);
    await tickAt(w, B, 9, 45);
    expect(alerts(w)).toMatchObject([
      {
        kind: "buy_zone_wait",
        tone: "caution",
        title: "SOXL이 매수 검토 구간에 들어왔어요",
        rows: [
          { label: "규칙", value: "매수 검토 $25.00–27.00 · 알림" },
          { label: "진입 조건", value: "확인 대기 · 가격 구간 도달" },
          { label: "다음", value: "손절 $22.00 · 1차 익절 $32.00" },
          { label: "시장", value: "탈출 3단계 · 회복 최소 1단계" },
        ],
      },
    ]);
    expect(banners(w)).toEqual([["SOXL 매수 검토 구간 진입", "$26.00 · 매수 검토 $25.00–27.00"]]);
  });

  test("no stop and no 1st target (expired counts as none): no 다음 row; the expiry card's 시장 row; no reading: 확인 불가", async () => {
    const w = await world();
    await watch(w);
    await rule(w, { kind: "buy_zone", lo: 25, hi: 27 });
    await rule(w, { kind: "target", level: 1, price: 32, until: A });
    await rule(w, { kind: "target", level: 2, price: 36 });
    await judge(w, KST(2026, 11, 30, 8, 0));
    quote(w, ET(A, 16, 0), 28, 28.4);
    await tickAt(w, A, 16, 5); // the 1st target's last day ends; 06:05 KST: 11-30's reading is the current one
    expect(alerts(w).map((c) => [c.kind, c.rows.at(-1)])).toEqual([["expired", { label: "시장", value: "탈출 3단계 · 회복 최소 1단계" }]]);
    quote(w, ET(B, 9, 44), 26, 26.4);
    await tickAt(w, B, 9, 45); // 23:45 KST 12-01: 11-30's reading is stale
    expect(alerts(w)[1]!.rows).toEqual([
      { label: "규칙", value: "매수 검토 $25.00–27.00 · 알림" },
      { label: "진입 조건", value: "확인 대기 · 가격 구간 도달" },
      { label: "시장", value: "확인 불가" },
    ]);
  });

  test("the 시장 row's sources: judged → heads; none, stale (a day missed after 08:00) or sources off → 확인 불가", async () => {
    const w = await world();
    await watch(w);
    const core = w.h.app.core;
    expect(stageRowText(core, w.uid, KST(2026, 12, 1, 9, 0))).toBe("확인 불가"); // no row yet
    await judge(w, KST(2026, 12, 1, 8, 0));
    expect(stageRowText(core, w.uid, KST(2026, 12, 1, 23, 45))).toBe("탈출 3단계 · 회복 최소 1단계");
    expect(stageRowText(core, w.uid, KST(2026, 12, 2, 6, 0))).toBe("탈출 3단계 · 회복 최소 1단계"); // before 08:00: the last one stands
    expect(stageRowText(core, w.uid, KST(2026, 12, 2, 9, 0))).toBe("확인 불가"); // stale
    core.cfg.invest.sources = false;
    expect(stageRowText(core, w.uid, KST(2026, 12, 1, 23, 45))).toBe("확인 불가");
  });
});

describe("the call's market sentence (DD 0924 1): the same reading as the 시장 row", () => {
  test("numbered heads, recovery on hold, recovery not known; no reading → null (the could-not-check line)", () => {
    const esc = { stage: 3, text: "탈출 3단계" };
    expect(stageCallOf({ escape: esc, recovery: { stage: 1, floor: true, text: "회복 최소 1단계" } })).toBe("시장 단계는 탈출 3단계, 회복 최소 1단계예요.");
    expect(stageCallOf({ escape: { stage: 2, floor: true, text: "탈출 최소 2단계" }, recovery: { stage: 0, text: "회복 0단계" } })).toBe("시장 단계는 탈출 최소 2단계, 회복 0단계예요.");
    expect(stageCallOf({ escape: esc, recovery: { stage: null, text: RECOVERY_HOLD } })).toBe("시장 단계는 탈출 3단계이고, 회복은 판정 보류예요.");
    expect(stageCallOf({ escape: esc, recovery: { stage: null, text: "회복 단계 미확정" } })).toBe("시장 단계는 탈출 3단계이고, 회복 단계는 아직 몰라요.");
    expect(stageCallOf(null)).toBeNull();
  });

  const realFetch = globalThis.fetch;
  let twilio: URLSearchParams[] = [];
  beforeAll(() => {
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).startsWith("https://api.twilio.com/")) {
        twilio.push(new URLSearchParams(String(init?.body)));
        return new Response(JSON.stringify({ sid: "CA1", status: "queued" }), { status: 201 });
      }
      throw new Error(`unexpected fetch ${String(url)}`);
    }) as typeof fetch;
  });
  afterAll(() => {
    globalThis.fetch = realFetch;
  });
  afterEach(() => {
    twilio = [];
  });

  test("the zero-sellable call ends on the reading too, or on the could-not-check line (DD 1441 2)", () => {
    const r: RuleSpec = { symbol: "SOXL", kind: "stop", level: null, price: 27, lo: null, hi: null, direction: "below", action: "sell", once: 0, buffer_pct: null, until_day: null };
    const card = { state: "skipped" } as InvestStopCard;
    const judged = stopCallLine("모시", r, "US", card, 26.5, null, "시장 단계는 탈출 3단계, 회복 최소 1단계예요.");
    const none = stopCallLine("모시", r, "US", card, 26.5, null);
    expect(judged).toBe("모시예요. SOXL이 손절선 27달러에 닿았는데, 팔 수 있는 수량이 0주라서 주문을 내지 않았어요. 시장 단계는 탈출 3단계, 회복 최소 1단계예요.");
    expect(none).toBe("모시예요. SOXL이 손절선 27달러에 닿았는데, 팔 수 있는 수량이 0주라서 주문을 내지 않았어요. 시장 상태는 이번에는 확인하지 못했어요.");
  });

  test("an expired stop is in neither the buy zone alert's 다음 row nor its call (DD 1441 1)", async () => {
    const w = await world({ twilio: true });
    writeMyPhone(w.h.app.core, w.uid, { e164: "+821012345678", verifiedAt: w.h.clock.t, codeHash: null, codeExpiresAt: 0, attempts: 0 });
    await watch(w);
    await rule(w, { kind: "stop", price: 22, until: A });
    await rule(w, { kind: "target", level: 1, price: 32 });
    await rule(w, { kind: "buy_zone", lo: 25, hi: 27, action: "call" });
    quote(w, ET(A, 16, 0), 28, 28.4);
    await tickAt(w, A, 16, 5); // the stop's last day ends
    quote(w, ET(B, 9, 44), 26, 28);
    await tickAt(w, B, 9, 45);
    expect(Object.fromEntries((await rulesOf(w)).map((r) => [r.left.split(" ")[0], r.state]))).toEqual({ 손절: "expired", "1차": "armed", 매수: "hit" });
    const zone = alerts(w).find((c) => c.kind === "buy_zone_wait")!;
    expect(zone.rows.find((x) => x.label === "다음")).toEqual({ label: "다음", value: "1차 익절 $32.00" });
    const said = twilio.map((t) => t.get("Twiml") ?? "");
    expect(said).toHaveLength(1);
    expect(said[0]).toContain("매수 검토 구간 25달러에서 27달러 사이에 들어왔어요.");
    expect(said[0]).not.toContain("손절선");
  });

  test("a rule alert's call and a mock stop record's call end on the current reading; none → the could-not-check line", async () => {
    const w = await world({ twilio: true });
    writeMyPhone(w.h.app.core, w.uid, { e164: "+821012345678", verifiedAt: w.h.clock.t, codeHash: null, codeExpiresAt: 0, attempts: 0 });
    await watch(w);
    await rule(w, { kind: "alert", price: 30, direction: "above", action: "call" });
    await rule(w, { kind: "alert", price: 27, direction: "below", action: "call" });
    await rule(w, { kind: "stop", price: 27, action: "sell" });
    quote(w, ET(B, 9, 44), 30.5, 30);
    await tickAt(w, B, 9, 45); // no reading yet
    await judge(w, KST(2026, 12, 2, 8, 0));
    quote(w, ET("2026-12-02", 9, 44), 26.5, 30.5);
    await tickAt(w, "2026-12-02", 9, 45);
    const said = twilio.map((t) => t.get("Twiml") ?? "");
    expect(said).toHaveLength(3);
    const up = said.find((x) => x.includes("알림 가격 30달러"))!;
    const down = said.find((x) => x.includes("알림 가격 27달러"))!;
    const record = said.find((x) => x.includes("모의 손절을 기록했어요."))!;
    expect(up).toContain("시장 상태는 이번에는 확인하지 못했어요.");
    expect(down).toContain("시장 단계는 탈출 3단계, 회복 최소 1단계예요.");
    expect(record).toContain("모의 주문이라 실제 주문은 내지 않았어요. 시장 단계는 탈출 3단계, 회복 최소 1단계예요.");
    for (const x of [down, record]) expect(x).not.toContain("확인하지 못했어요");
  });
});

// ───────────────────────────── gap ─────────────────────────────

describe("a big gap at the open (A14 급격한 갭)", () => {
  test("first check only, one card per symbol and day; up and down both caution; the push is the banner's title", async () => {
    const w = await world({ atr: 1 });
    await watch(w);
    await rule(w, { kind: "stop", price: 20 });
    await judge(w, KST(2026, 12, 1, 8, 0));
    quote(w, ET(B, 9, 44), 31.6, 30, { price: 31.5, at: ET(B, 9, 30) });
    await tickAt(w, B, 9, 45);
    await tickAt(w, B, 9, 50);
    expect(alerts(w)).toEqual([
      {
        type: "invest_alert",
        alertId: expect.any(String),
        symbol: "SOXL",
        kind: "gap",
        tone: "caution",
        title: "SOXL이 전일 종가보다 5.0% 높게 시작했어요",
        at: ET(B, 9, 44),
        atText: expect.any(String),
        price: { v: 31.5, text: "$31.50", unit: "usd" },
        rows: [
          { label: "시가", value: "$31.50" },
          { label: "전일 종가", value: "$30.00 · 11월 30일" },
          { label: "갭", value: "5.0% · ATR 1.5배" },
          { label: "시장", value: "탈출 3단계 · 회복 최소 1단계" },
        ],
        notes: [],
        foot: expect.stringContaining("Yahoo(지연 시세) · B+"),
        disclaimer: true,
      },
    ]);
    expect(banners(w)).toEqual([["SOXL 갭 상승 출발", "시가 $31.50 · 전일 종가 대비 5.0%"]]);
    expect(w.pushes.map((p) => [p.title, p.tag])).toEqual([["SOXL 갭 상승 출발", "invest:gap:SOXL"]]);
    // the open and the ATR behind the card go to the person's ledger as code's (T2, the source's grade)
    expect(w.h.db.sql.query("SELECT id, value, source_tier, confidence, author FROM invest_ledger WHERE user_id = $u ORDER BY id").all({ u: w.uid })).toEqual([
      { id: "atr14.SOXL", value: 1, source_tier: "T2", confidence: "B+", author: "code" },
      { id: "quote.SOXL", value: 31.5, source_tier: "T2", confidence: "B+", author: "code" },
    ]);
    // the next day, down
    quote(w, ET("2026-12-02", 9, 44), 30, 31.6, { price: 30, at: ET("2026-12-02", 9, 30) });
    await tickAt(w, "2026-12-02", 9, 45);
    expect(alerts(w).map((c) => c.title)).toEqual(["SOXL이 전일 종가보다 5.0% 높게 시작했어요", "SOXL이 전일 종가보다 5.1% 낮게 시작했어요"]);
    expect(banners(w).at(-1)).toEqual(["SOXL 갭 하락 출발", "시가 $30.00 · 전일 종가 대비 5.1%"]);
  });

  test("no card: a small gap, no open in the body, an open from another day, a symbol without live rules", async () => {
    const w = await world({ atr: 1 });
    w.up.state.yahoo.set("SOXS", { price: 20, prevClose: 10, time: sec(ET(B, 9, 44)), open: { price: 20, time: sec(ET(B, 9, 30)) } });
    w.up.state.yahooDaily.set("SOXS", syntheticBars(B, 60, 10, 1));
    await watch(w, "SOXS"); // watched, no rule: its day chart is not read for an open
    await watch(w);
    await rule(w, { kind: "stop", price: 20 });
    quote(w, ET(B, 9, 44), 30.6, 30, { price: 30.6, at: ET(B, 9, 30) }); // 0.6 ATR, 2%
    await tickAt(w, B, 9, 45);
    quote(w, ET("2026-12-02", 9, 44), 33, 30); // no open
    await tickAt(w, "2026-12-02", 9, 45);
    quote(w, ET("2026-12-03", 9, 44), 33, 30, { price: 33, at: ET("2026-12-02", 9, 30) }); // yesterday's bar
    await tickAt(w, "2026-12-03", 9, 45);
    expect(alerts(w)).toEqual([]);
  });

  test("a Toss user: the price is Toss's, the open and the previous close are Yahoo's day chart, read at the first check only", async () => {
    const w = await world({ toss: true, atr: 1 });
    const envelope = { v: 1, alg: "ECDH-P256+HKDF-SHA256+A256GCM", kid: "kid-test", epk: { kty: "EC" }, iv: "aXY", ct: "Y3Q", aad: `${w.uid}:toss-investment:token` };
    expect((await api(w, "POST", "/api/credentials", { service: "toss-investment", label: "토스증권", kind: "token", hint: "계좌 1개", keepFor: "forever", envelope })).status).toBe(201);
    await w.h.app.core.idle();
    await watch(w);
    await rule(w, { kind: "stop", price: 20 });
    w.up.state.tossPrices.set("SOXL", { price: 31.6 });
    quote(w, ET(B, 9, 44), 31.6, 30, { price: 31.5, at: ET(B, 9, 30) });
    const yahooCalls = () => w.up.calls.filter((c) => c.host === "query1.finance.yahoo.com" && c.path.includes("range=1d")).length;
    const atWatch = yahooCalls(); // adding the symbol checks its name
    await tickAt(w, B, 9, 45);
    const atFirst = yahooCalls();
    await tickAt(w, B, 9, 50);
    expect([atFirst - atWatch, yahooCalls() - atWatch]).toEqual([1, 1]);
    expect(alerts(w).map((c) => [c.kind, c.rows[1]?.value])).toEqual([["gap", "$30.00 · 11월 30일"]]);
  });
});

// ───────────────────────────── a run above the buy zone ─────────────────────────────

describe("a run far above the buy zone (A14 추격 금지: no buy signal, the strategy to look at again)", () => {
  test("from inside: the run card (not the gap card at the same check); once per entry into the zone", async () => {
    const w = await world({ atr: 1 });
    await watch(w);
    await rule(w, { kind: "buy_zone", lo: 25, hi: 27 });
    await rule(w, { kind: "stop", price: 20 });
    quote(w, ET(A, 16, 0), 26, 26.2);
    await tickAt(w, A, 16, 5); // the close check: inside → the buy zone alert
    quote(w, ET(B, 9, 44), 28.5, 26, { price: 28.4, at: ET(B, 9, 30) });
    await tickAt(w, B, 9, 45);
    quote(w, ET(B, 9, 49), 29, 26);
    await tickAt(w, B, 9, 50); // still above: nothing
    quote(w, ET(B, 9, 54), 26.5, 26);
    await tickAt(w, B, 9, 55); // back inside: the buy zone alert again
    quote(w, ET(B, 9, 59), 29, 26);
    await tickAt(w, B, 10, 0); // a second run
    quote(w, ET(B, 10, 4), 24, 26);
    await tickAt(w, B, 10, 5); // under the zone
    quote(w, ET(B, 10, 9), 29.5, 26);
    await tickAt(w, B, 10, 10); // from under, but no entry since the last run card: nothing
    const all = alerts(w);
    expect(all.map((c) => c.kind)).toEqual(["buy_zone_wait", "chase", "buy_zone_wait", "chase"]);
    expect(all[1]).toMatchObject({
      kind: "chase",
      tone: "caution",
      title: "SOXL이 매수 검토 구간 위로 크게 벗어났어요",
      titleLines: ["$28.50까지 올라왔어요.", "전략을 다시 봐야 해요."],
      price: { v: 28.5, text: "$28.50", unit: "usd" },
      rows: [
        { label: "규칙", value: "매수 검토 $25.00–27.00 · 알림" },
        { label: "벗어난 폭", value: "구간 위 $1.50 · 5.6% · ATR 1.5배" },
        { label: "시장", value: "확인 불가" },
      ],
      notes: [],
      disclaimer: true,
    });
    expect(JSON.stringify(all)).not.toContain("추격");
    expect(banners(w)[1]).toEqual(["SOXL 매수 검토 구간 크게 벗어남", "$28.50 · 매수 검토 $25.00–27.00"]);
  });

  test("from under the zone; not when the run is small or the check before did not see the rule", async () => {
    const w = await world({ atr: 1 });
    await watch(w);
    await rule(w, { kind: "buy_zone", lo: 25, hi: 27 });
    quote(w, ET(B, 9, 44), 24, 24.5);
    await tickAt(w, B, 9, 45);
    quote(w, ET(B, 9, 49), 27.5, 24.5);
    await tickAt(w, B, 9, 50); // 0.5 ATR over the top: nothing
    quote(w, ET(B, 9, 54), 24, 24.5);
    await tickAt(w, B, 9, 55);
    quote(w, ET(B, 10, 29), 29, 24.5);
    await tickAt(w, B, 10, 30); // the checks between were missed: the price before is not the check before's
    quote(w, ET(B, 10, 34), 24, 24.5);
    await tickAt(w, B, 10, 35);
    quote(w, ET(B, 10, 39), 28.6, 24.5);
    await tickAt(w, B, 10, 40); // from under: 1.6 ATR, 5.9%
    expect(alerts(w).map((c) => [c.kind, c.rows[1]?.value])).toEqual([["chase", "구간 위 $1.60 · 5.9% · ATR 1.6배"]]);
  });
});

// ───────────────────────────── split or merge ─────────────────────────────

describe("a split or a merge read from the prices (A14 분할·병합): the symbol's rules stop until the person saves them", () => {
  async function merged() {
    const w = await world({ atr: 1 });
    await watch(w);
    const stop = await rule(w, { kind: "stop", price: 30 });
    const target = await rule(w, { kind: "target", level: 1, price: 36 });
    const zone = await rule(w, { kind: "buy_zone", lo: 31, hi: 32 });
    quote(w, ET(A, 16, 0), 32.57, 32.1);
    await tickAt(w, A, 16, 5);
    return { w, stop, target, zone };
  }

  test("10 shares into 1: one danger card, the rules paused and marked, no rule alert and no gap card; prices unchanged", async () => {
    const { w, target } = await merged();
    quote(w, ET(B, 9, 44), 330, 325.7, { price: 345, at: ET(B, 9, 30) }); // a 5.9% gap too: the split card stands alone
    await tickAt(w, B, 9, 45);
    await tickAt(w, B, 9, 50);
    expect(alerts(w)).toEqual([
      {
        type: "invest_alert",
        alertId: expect.any(String),
        symbol: "SOXL",
        kind: "split",
        tone: "danger",
        title: "SOXL 가격 규칙을 멈췄어요",
        titleLines: ["10주가 1주로 합쳐진 것으로 보여요.", "규칙을 열어 저장하면 다시 봐요."],
        at: ET(B, 9, 44),
        atText: expect.any(String),
        rows: [
          { label: "지난 거래일에 본 가격", value: "$32.57 · 11월 30일" }, // DD 1441 3: not always yesterday
          { label: "전일 종가", value: "$325.70 · Yahoo(지연 시세) · B+" },
          { label: "멈춘 규칙", value: "3개" },
        ],
        notes: ["규칙 가격은 바꾸지 않았어요."],
        foot: expect.stringContaining("Yahoo(지연 시세) · B+"),
        disclaimer: true,
      },
    ]);
    expect(banners(w)).toEqual([["SOXL 가격 규칙 멈춤", "분할이나 병합으로 보여요 · 규칙 3개"]]);
    const rows = await rulesOf(w);
    // rows created in the same ms list in id order: compare by the words
    expect(Object.fromEntries(rows.map((r) => [r.left, r.state]))).toEqual({ "손절 $30.00 이하": "paused", "매수 검토 $31.00–32.00": "paused", "1차 익절 $36.00 이상": "paused" });
    for (const r of rows) expect(r.stateFoot).toMatch(/^.+에 분할이나 병합으로 보여서 멈췄어요\. 가격을 확인하고 저장하면 다시 봐요\.$/);
    // the person saves the target unchanged: it alone is watched again, its earlier state unknown (no prior check)
    const saved = await api<InvestRuleRow>(w, "PATCH", `/api/invest/rules/${target.id}`, { changes: {}, ifRev: rows.find((r) => r.id === target.id)!.rev });
    expect([saved.status, saved.body.state]).toEqual([200, "armed"]);
    expect(saved.body.stateFoot).toBeUndefined();
    await tickAt(w, B, 9, 55);
    expect(alerts(w).map((c) => [c.kind, c.noPrior ?? false])).toEqual([
      ["split", false],
      ["target", true],
    ]);
    expect(Object.fromEntries((await rulesOf(w)).map((r) => [r.left, r.state]))).toEqual({ "손절 $30.00 이하": "paused", "매수 검토 $31.00–32.00": "paused", "1차 익절 $36.00 이상": "hit" });
    // the same day's later checks never judge a split again (first check only), and the next day's key is new only on a new ratio
    expect(w.h.db.sql.query("SELECT kind, dedupe_key FROM invest_alerts WHERE kind = 'split'").all()).toEqual([{ kind: "split", dedupe_key: `split:SOXL:${B}` }]);
  });

  test("the last price seen is older than the check before (a session missed): nothing judged", async () => {
    const { w } = await merged(); // seen at A's close
    quote(w, ET("2026-12-02", 9, 44), 330, 325.7); // B had no check at all
    await tickAt(w, "2026-12-02", 9, 45);
    expect(alerts(w).map((c) => c.kind)).toEqual(["target"]);
    expect(w.h.db.sql.query("SELECT COUNT(*) AS n FROM invest_alerts WHERE kind = 'split'").get()).toEqual({ n: 0 });
  });

  test("1 share into 2: the other words; a crash is not a split; yesterday unknown → nothing judged", async () => {
    const { w } = await merged();
    quote(w, ET(B, 9, 44), 16.3, 16.285);
    await tickAt(w, B, 9, 45);
    expect(alerts(w).map((c) => [c.kind, c.titleLines?.[0]])).toEqual([["split", "1주가 2주로 나뉜 것으로 보여요."]]);
    expect(banners(w)).toEqual([["SOXL 가격 규칙 멈춤", "분할이나 병합으로 보여요 · 규칙 3개"]]);
    const crash = await merged();
    quote(crash.w, ET(B, 9, 44), 15, 32.57);
    await tickAt(crash.w, B, 9, 45);
    expect(alerts(crash.w).map((c) => c.kind)).toEqual(["stop_alert"]);
    const fresh = await world({ atr: 1 });
    await watch(fresh);
    await rule(fresh, { kind: "target", level: 1, price: 36 });
    quote(fresh, ET(B, 9, 44), 330, 325.7);
    await tickAt(fresh, B, 9, 45);
    expect(alerts(fresh).map((c) => c.kind)).toEqual(["target"]);
  });

  test("a Toss user: today's price is Toss's (no previous close), the previous close is Yahoo's day chart", async () => {
    const w = await world({ toss: true, atr: 1 });
    const envelope = { v: 1, alg: "ECDH-P256+HKDF-SHA256+A256GCM", kid: "kid-test", epk: { kty: "EC" }, iv: "aXY", ct: "Y3Q", aad: `${w.uid}:toss-investment:token` };
    expect((await api(w, "POST", "/api/credentials", { service: "toss-investment", label: "토스증권", kind: "token", hint: "계좌 1개", keepFor: "forever", envelope })).status).toBe(201);
    await w.h.app.core.idle();
    await watch(w);
    await rule(w, { kind: "stop", price: 30 });
    w.up.state.tossPrices.set("SOXL", { price: 32.57 });
    await tickAt(w, A, 16, 5);
    w.up.state.tossPrices.set("SOXL", { price: 330 });
    quote(w, ET(B, 9, 44), 330, 325.7);
    await tickAt(w, B, 9, 45);
    expect(alerts(w).map((c) => [c.kind, c.rows[1]?.value])).toEqual([["split", "$325.70 · Yahoo(지연 시세) · B+"]]);
    expect((await rulesOf(w)).map((r) => r.state)).toEqual(["paused"]);
  });

  test("rules already hit the session before stop too (team-lead 1500 W1): paused and marked, prices and revs kept, nothing after", async () => {
    const w = await world({ atr: 1 });
    await watch(w);
    const stop = await rule(w, { kind: "stop", price: 33 }); // A closes at 32.57: under it
    const zone = await rule(w, { kind: "buy_zone", lo: 32, hi: 33 }); // and inside it
    const target = await rule(w, { kind: "target", level: 1, price: 36 });
    quote(w, ET(A, 16, 0), 32.57, 32.1);
    await tickAt(w, A, 16, 5);
    const words = { [stop.id]: "손절 $33.00 이하", [zone.id]: "매수 검토 $32.00–33.00", [target.id]: "1차 익절 $36.00 이상" };
    const seen = async () => Object.fromEntries((await rulesOf(w)).map((r) => [r.id, [r.left, r.state, r.rev]]));
    expect(await seen()).toEqual({ [stop.id]: [words[stop.id], "hit", stop.rev], [zone.id]: [words[zone.id], "hit", zone.rev], [target.id]: [words[target.id], "armed", target.rev] });
    const n = alerts(w).length;
    const b = banners(w).length;
    quote(w, ET(B, 9, 44), 330, 325.7);
    await tickAt(w, B, 9, 45);
    quote(w, ET(B, 9, 49), 331, 325.7);
    await tickAt(w, B, 9, 50);
    quote(w, ET(B, 15, 59), 329, 325.7);
    await tickAt(w, B, 16, 5);
    // the hit ones count among the stopped; no chase card from the zone, no stop or zone card, no mock stop record after
    expect(alerts(w).slice(n).map((c) => [c.kind, c.rows.find((x) => x.label === "멈춘 규칙")?.value])).toEqual([["split", "3개"]]);
    expect(banners(w).slice(b)).toEqual([["SOXL 가격 규칙 멈춤", "분할이나 병합으로 보여요 · 규칙 3개"]]);
    expect(await seen()).toEqual({ [stop.id]: [words[stop.id], "paused", stop.rev], [zone.id]: [words[zone.id], "paused", zone.rev], [target.id]: [words[target.id], "paused", target.rev] });
    for (const r of await rulesOf(w)) expect(r.stateFoot).toMatch(/에 분할이나 병합으로 보여서 멈췄어요\. 가격을 확인하고 저장하면 다시 봐요\.$/);
  });

  test("a crash at the open is not a split (team-lead 1500 W4): only the first check reads the session before's price", async () => {
    const w = await world({ atr: 1 });
    await watch(w);
    const s30 = await rule(w, { kind: "stop", price: 30 });
    const s15 = await rule(w, { kind: "stop", price: 15 });
    quote(w, ET(A, 16, 0), 32.57, 32.1);
    await tickAt(w, A, 16, 5);
    // B opens at half A's close: the stop at 30 rings and the gap card goes; nothing is read as a split
    quote(w, ET(B, 9, 44), 16.3, 32.57, { price: 16.2, at: ET(B, 9, 30) });
    await tickAt(w, B, 9, 45);
    const ring = () => alerts(w).map((c) => [c.kind, c.ruleId ?? null]);
    expect(ring()).toEqual([
      ["stop_alert", s30.id],
      ["gap", null],
    ]);
    // the next check's check before saw 16.30, half the previous close (the ratio of 1 share into 2): still no split,
    // and the stop at 15, crossed for the first time, rings
    quote(w, ET(B, 9, 49), 12, 32.57);
    await tickAt(w, B, 9, 50);
    expect(ring()).toEqual([
      ["stop_alert", s30.id],
      ["gap", null],
      ["stop_alert", s15.id],
    ]);
    // back at half the previous close before the close check: the close check reads no split either
    quote(w, ET(B, 15, 54), 16.28, 32.57);
    await tickAt(w, B, 15, 55);
    quote(w, ET(B, 15, 59), 16.28, 32.57);
    await tickAt(w, B, 16, 5);
    expect(ring().filter(([k]) => k === "split")).toEqual([]);
    expect(w.h.db.sql.query("SELECT COUNT(*) AS n FROM invest_alerts WHERE kind = 'split'").get()).toEqual({ n: 0 });
    expect((await rulesOf(w)).filter((r) => r.state === "paused")).toEqual([]);
  });
});
