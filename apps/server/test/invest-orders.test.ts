/**
 * B3a: real stop orders (team-lead 2040 · 2045b; DD 1935 §2-2, 2044, 2046-b). The executor (src/invest/orders.ts)
 * through the hub: the gates one by one (G8), the order body, resends, fill checks, planned orders and their drops,
 * cards, banners, pushes and calls. B3a has no enable path: each test writes real mode and the rule's confirmation into
 * the database. Toss is test/fake-toss.ts (synthetic bodies); nothing real is called, and no real order exists.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { InvestStopCard, ServerEvent } from "@pickle/protocol";
import type { CredentialAccess, ToolContext } from "@pickle/agent";
import { kst } from "@pickle/quant";
import { etToEpoch, kstToEpochDay } from "../src/invest/calendar.ts";
import { realStopBanner, realStopCallLine, realStopCard } from "../src/invest/cards.ts";
import * as idb from "../src/invest/db.ts";
import { INTRADAY_ONLY } from "../src/invest/rules.ts";
import { clientOrderIdOf, orderWindow, qtyText } from "../src/invest/orders.ts";
import { oneLine, TOSS_PURPOSE_READ, TOSS_PURPOSE_REAL, type TossOrderResult } from "../src/invest/toss.ts";
import { investTools } from "../src/invest/tools.ts";
import type { Logger, LogFields } from "../src/log.ts";
import { writeMyPhone } from "../src/phone.ts";
import { ieyo } from "../src/util.ts";
import { BOGUS_TOSS_SECRET, FAKE_TOSS_BASE, makeInvestUpstream, type OrderAnswer, type OrderStep } from "./fake-toss.ts";
import { makeFakeVault, makeHarness, type Harness } from "./helpers.ts";

const DAY = "2026-11-30"; // a Monday, a full session (EST: 09:30 ET = 14:30Z, 23:30 KST)
const NEXT = "2026-12-01";
const ET = (h: number, m: number, day = DAY, s = 0) => etToEpoch(day, h, m) + s * 1000;
const TWILIO = { accountSid: "AC123", authToken: "tok", from: "+15550000000" };
const MARKET = "시장 상태는 이번에는 확인하지 못했어요.";

type Up = ReturnType<typeof makeInvestUpstream>;
interface World {
  h: Harness;
  up: Up;
  uid: string;
  token: string;
  events: ServerEvent[];
  pushes: { title: string; tag?: string }[];
  logs: string[];
  purposes: string[];
}

const worlds: World[] = [];
afterEach(async () => {
  while (worlds.length) await worlds.pop()!.h.close();
});

async function world(o: { orders?: boolean; twilio?: boolean; sources?: boolean } = {}): Promise<World> {
  const up = makeInvestUpstream();
  const purposes: string[] = [];
  const h = await makeHarness({
    now: ET(9, 0),
    config: {
      invest: { sources: o.sources ?? false, tossBase: FAKE_TOSS_BASE, outboundIp: "203.0.113.7", orders: o.orders ?? true },
      ...(o.twilio ? { twilio: TWILIO } : {}),
    },
    deps: ({ vault }) => ({
      investFetch: up.fetch,
      vault: {
        ...vault,
        access(userId, a) {
          const acc = vault.access(userId, a);
          const use: CredentialAccess["use"] = (id, p, fn) => {
            purposes.push(p.purpose);
            return acc.use(id, p, () => fn({ ...BOGUS_TOSS_SECRET }));
          };
          return { ...acc, use };
        },
      } as ReturnType<typeof makeFakeVault>,
    }),
  });
  up.state.clock = () => h.clock.t;
  const me = await h.signup("alice");
  const uid = me.session.user.id;
  const events: ServerEvent[] = [];
  const pub = h.app.core.events.publish.bind(h.app.core.events);
  h.app.core.events.publish = (u, e) => {
    if (u === uid) events.push(e);
    pub(u, e);
  };
  const pushes: World["pushes"] = [];
  h.app.core.push.send = async (u, m) => {
    if (u === uid) pushes.push(m as World["pushes"][number]);
    return 0;
  };
  const logs: string[] = [];
  const rec = (level: string) => (event: string, fields?: LogFields) => void logs.push(`${level} ${event} ${JSON.stringify(fields ?? {})}`);
  h.app.core.log = { info: rec("info"), warn: rec("warn"), error: rec("error") } satisfies Logger;
  const w = { h, up, uid, token: me.token, events, pushes, logs, purposes };
  worlds.push(w);
  return w;
}

const api = async <T = unknown>(w: World, method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> => {
  const res = await w.h.req(method, path, { token: w.token, body });
  return { status: res.status, body: (await res.json()) as T };
};

async function connectToss(w: World) {
  const envelope = { v: 1, alg: "ECDH-P256+HKDF-SHA256+A256GCM", kid: "kid-test", epk: { kty: "EC" }, iv: "aXY", ct: "Y3Q", aad: `${w.uid}:toss-investment:token` };
  const r = await api(w, "POST", "/api/credentials", { service: "toss-investment", label: "토스증권", kind: "token", hint: "계좌 1개", keepFor: "forever", envelope });
  expect(r.status).toBe(201);
  await w.h.app.core.idle();
}

async function tickAt(w: World, at: number) {
  w.h.clock.t = at;
  await w.h.app.core.invest.tick();
  await w.h.app.core.idle();
}

async function beatAt(w: World, at: number) {
  w.h.clock.t = at;
  await w.h.app.core.invest.desk.beat(at);
  await w.h.app.core.idle();
}

interface Setup {
  symbol?: string;
  held?: number;
  sellable?: number;
  confirm?: number | null;
  confirmRev?: number;
  stop?: number;
  mode?: "real" | "mock";
  plan?: OrderStep[];
  others?: { symbol: string; held?: number; sellable: number; stop: number; confirm?: number }[];
}

/** a person with Toss, SOXL held and a sell stop at $27; real mode and the rule confirmed (unless told otherwise) */
async function setup(w: World, o: Setup = {}) {
  const symbol = o.symbol ?? "SOXL";
  w.up.state.tossHoldings = [{ symbol, quantity: o.held ?? 47, averagePrice: 30 }, ...(o.others ?? []).filter((x) => x.held).map((x) => ({ symbol: x.symbol, quantity: x.held!, averagePrice: 12 }))];
  w.up.state.tossSellable.set(symbol, o.sellable ?? o.held ?? 47);
  w.up.state.tossPrices.set(symbol, { price: 27.5 });
  for (const x of o.others ?? []) {
    w.up.state.tossSellable.set(x.symbol, x.sellable);
    w.up.state.tossPrices.set(x.symbol, { price: x.stop + 0.5 });
  }
  if (o.plan) w.up.state.orderPlan = o.plan;
  await connectToss(w);
  expect((await api(w, "POST", "/api/invest/watchlist", { symbol })).status).toBeLessThan(300);
  const r = (await api<{ id: string; rev: number }>(w, "POST", "/api/invest/rules", { draft: { symbol, kind: "stop", price: o.stop ?? 27, action: "sell" } })).body;
  const others: { id: string; rev: number; symbol: string }[] = [];
  for (const x of o.others ?? []) {
    expect((await api(w, "POST", "/api/invest/watchlist", { symbol: x.symbol })).status).toBeLessThan(300);
    const ro = (await api<{ id: string; rev: number }>(w, "POST", "/api/invest/rules", { draft: { symbol: x.symbol, kind: "stop", price: x.stop, action: "sell" } })).body;
    others.push({ ...ro, symbol: x.symbol });
    if (x.confirm !== undefined) idb.confirmReal(w.h.db, w.uid, ro.id, ro.rev, x.confirm, w.h.clock.t);
  }
  const db = w.h.db;
  idb.ensureSettings(db, w.uid, w.h.clock.t);
  if ((o.mode ?? "real") === "real") idb.updateSettings(db, w.uid, { mode: "real", real_since: w.h.clock.t }, w.h.clock.t);
  const confirm = o.confirm === undefined ? (o.held ?? 47) : o.confirm;
  if (confirm != null) idb.confirmReal(db, w.uid, r.id, o.confirmRev ?? r.rev, confirm, w.h.clock.t);
  return { r, others };
}

/** arm at `armAt` (above the line), then a price under it at `hitAt` */
async function hit(w: World, armAt: number, hitAt: number, price = 26.8, symbols = ["SOXL"]) {
  await tickAt(w, armAt);
  for (const s of symbols) w.up.state.tossPrices.set(s, { price });
  await tickAt(w, hitAt);
}

function stopCards(w: World): InvestStopCard[] {
  const tid = idb.getSettings(w.h.db, w.uid)?.thread_id;
  if (!tid) return [];
  const rows = w.h.db.sql.query("SELECT cards_json FROM messages WHERE thread_id = $t ORDER BY created_at, id").all({ t: tid }) as { cards_json: string }[];
  return rows.flatMap((r) => JSON.parse(r.cards_json) as InvestStopCard[]).filter((c) => c.type === "invest_stop");
}
const card = (w: World, symbol = "SOXL") => stopCards(w).filter((c) => c.symbol === symbol).at(-1)!;
const banners = (w: World) => w.events.filter((e): e is Extract<ServerEvent, { type: "notification" }> => e.type === "notification").map((e) => e.title);
const posts = (w: World) => w.up.calls.filter((c) => c.method === "POST" && c.path === "/api/v1/orders");
/** an order already in Toss's list (placed elsewhere): a market SELL of 47 SOXL unless said otherwise */
const fakeOrder = (body: Record<string, unknown>, at: number, orderId = "tso-00000066") => ({
  orderId, clientOrderId: null, body: { symbol: "SOXL", side: "SELL", orderType: "MARKET", timeInForce: "DAY", quantity: "47", ...body }, orderedAt: at, plan: [{ status: "PENDING" as const }], step: 0,
});
const orderReads = (w: World) => w.up.calls.filter((c) => c.method === "GET" && c.path.startsWith("/api/v1/orders/"));
const rows = (w: World) => w.h.db.sql.query("SELECT * FROM invest_real_orders ORDER BY created_at, rowid").all() as idb.RealOrderRow[];
const row = (w: World, symbol = "SOXL") => rows(w).filter((x) => x.symbol === symbol).at(-1)!;
const value = (c: InvestStopCard, label: string) => c.rows.find((x) => x.label === label)?.value;

/** what a person reads never shows a broken number or an emoji (DD 2045) */
function expectClean(w: World) {
  const text = JSON.stringify(stopCards(w), (k, v: unknown) => (/^id$|Id$/.test(k) ? undefined : v));
  expect(text).not.toMatch(/NaN|Infinity|undefined|\$null|null원|null주/);
  expect(text).not.toMatch(/\p{Extended_Pictographic}/u);
}

// ───────────────────────────── the happy path ─────────────────────────────

describe("invest real orders: one confirmed stop", () => {
  test("in the session: one market SELL with the confirmed quantity; submitted, then filled only after FILLED", async () => {
    const w = await world();
    const { r } = await setup(w, { held: 60, confirm: 47, plan: [{ status: "PENDING" }, { status: "PENDING" }, { status: "FILLED", filled: 47, avg: 26.6, at: ET(9, 51) }] });
    await hit(w, ET(9, 45), ET(9, 50));
    // G8: one POST, the SELL literal, the confirmed quantity, the account header, the hit's key
    expect(posts(w)).toHaveLength(1);
    const cid = clientOrderIdOf(w.uid, r.id, r.rev, 1);
    expect(JSON.parse(posts(w)[0]!.body!)).toEqual({ clientOrderId: cid, symbol: "SOXL", side: "SELL", orderType: "MARKET", timeInForce: "DAY", quantity: "47" });
    expect(posts(w)[0]!.account).toBe("7");
    expect(cid).toMatch(/^m[A-Za-z0-9_-]{32}$/);
    expect(cid).not.toContain(w.uid);
    let c = card(w);
    expect(c).toMatchObject({ mode: "real", state: "submitted", title: "손절 주문을 냈어요", hero: { v: 26.8 }, status: "체결 확인 중", glyph: "loader", disclaimer: true });
    expect(c.rows).toEqual([
      { label: "주문", value: "47주 · 시장가 · 정규장" },
      { label: "주문 번호", value: "…0001" },
      { label: "낸 시각", value: kst(ET(9, 50)) },
    ]);
    expect(c.notes).toContain("확인한 47주만 팔아요. 그 뒤 늘어난 13주는 팔지 않아요.");
    expect(banners(w)).toEqual(["실제 · SOXL 손절 주문 냄"]);
    expect(w.pushes.map((p) => [p.title, p.tag])).toEqual([["실제 · SOXL 손절 주문 냄", `invest:${r.id}`]]);
    // G8-7: nothing says sold before Toss says FILLED
    expect(JSON.stringify(stopCards(w))).not.toMatch(/체결됐어요|팔았어요|매도 완료/);

    // checks: every beat for the first five minutes; PENDING changes nothing
    await beatAt(w, ET(9, 50, DAY, 29));
    expect(orderReads(w)).toHaveLength(0);
    await beatAt(w, ET(9, 50, DAY, 30));
    await beatAt(w, ET(9, 51));
    expect(orderReads(w)).toHaveLength(2);
    expect(card(w).state).toBe("submitted");
    expect(banners(w)).toHaveLength(1);
    await beatAt(w, ET(9, 51, DAY, 30));
    c = card(w);
    expect(c).toMatchObject({ state: "filled", title: "손절 매도가 체결됐어요", hero: { v: 26.6 }, sub: "체결가(평균)", glyph: "check" });
    expect(c.rows).toEqual([
      { label: "수량", value: "47주" },
      { label: "금액", value: "$1,250.20" },
      { label: "손절선 대비", value: "−$0.40" },
      { label: "평단 대비", value: "−11.33%" },
      { label: "체결 시각", value: kst(ET(9, 51)) },
    ]);
    expect(c.notes).toContain("확인한 47주만 팔았어요. 늘어난 13주는 그대로 있어요.");
    expect(banners(w)).toEqual(["실제 · SOXL 손절 주문 냄", "실제 · SOXL 손절 체결"]);
    expect(row(w)).toMatchObject({ state: "filled", qty: 47, filled_qty: 47, avg_price: 26.6, sends: 1, check_at: null, market_day: DAY, toss_order_id: "tso-00000001" });
    // one card for the order, rewritten in place; the alert row follows it
    expect(stopCards(w)).toHaveLength(1);
    const alert = w.h.db.sql.query("SELECT * FROM invest_alerts WHERE rule_id = $r").get({ r: r.id }) as idb.AlertRow;
    expect(alert).toMatchObject({ kind: "stop_order", title: "실제 · SOXL 손절 체결", message_id: row(w).message_id });
    // the model's history: the record line, no order number, no account
    const llm = (w.h.db.sql.query("SELECT llm_json FROM messages WHERE id = $m").get({ m: row(w).message_id }) as { llm_json: string }).llm_json;
    expect(JSON.parse(llm)[0].content).toBe("[투자 기록] SOXL 실제 손절 · 손절 매도가 체결됐어요 · 체결 47주 · 평균 $26.60 · 관측 $26.80 · 손절선 $27.00");
    const seen = JSON.stringify(stopCards(w)) + llm + JSON.stringify(w.events) + w.logs.join("\n");
    for (const s of ["tso-00000001", "12345678901", BOGUS_TOSS_SECRET.clientId, BOGUS_TOSS_SECRET.clientSecret]) expect(seen).not.toContain(s);
    // done: no more reads, no second order
    await beatAt(w, ET(10, 30));
    expect(orderReads(w)).toHaveLength(3);
    expect(posts(w)).toHaveLength(1);
    // real mode with no ATR: the stop was judged on intraday prices alone, and the card says so
    expect(c.notes.at(-1)).toBe(INTRADAY_ONLY);
    expectClean(w);
  });

  test("checks slow down after five minutes and end at the close + 15 minutes as unknown", async () => {
    const w = await world();
    await setup(w, { plan: [{ status: "PENDING" }] });
    await hit(w, ET(15, 0), ET(15, 5));
    expect(card(w).state).toBe("submitted");
    for (let s = 30; s <= 300; s += 30) await beatAt(w, ET(15, 5, DAY, s));
    expect(orderReads(w)).toHaveLength(10);
    // past five minutes: every five minutes
    await beatAt(w, ET(15, 10, DAY, 30));
    await beatAt(w, ET(15, 14, DAY, 59));
    expect(orderReads(w)).toHaveLength(10);
    await beatAt(w, ET(15, 15));
    expect(orderReads(w)).toHaveLength(11);
    for (let t = ET(15, 20); t < ET(16, 15); t += 5 * 60_000) await beatAt(w, t);
    expect(card(w).state).toBe("submitted");
    await beatAt(w, ET(16, 15));
    expect(card(w)).toMatchObject({ state: "unknown", title: "손절 주문 결과를 확인하지 못했어요", why: "마감 뒤에도 토스증권에서 주문이 끝났다는 답을 받지 못했어요.", glyph: "caution" });
    expect(card(w).notes).toEqual(["토스증권 앱의 주문 내역에서 확인해 주세요.", "같은 주문을 다시 내지 않았어요.", INTRADAY_ONLY]);
    expect(banners(w).at(-1)).toBe("실제 · SOXL 손절 주문 확인 필요");
    expect(posts(w)).toHaveLength(1);
  });

  test("a partial fill, then the rest cancelled at the close: one banner and one call at the end", async () => {
    const w = await world();
    await setup(w, { plan: [{ status: "PARTIAL_FILLED", filled: 30, avg: 26.7 }, { status: "CANCELED", filled: 30, avg: 26.7, at: ET(15, 59) }] });
    await hit(w, ET(15, 45), ET(15, 50));
    await beatAt(w, ET(15, 50, DAY, 30));
    expect(card(w)).toMatchObject({ state: "partial", title: "47주 중 30주가 체결됐어요", hero: { v: 26.7 }, status: "남은 17주는 체결을 계속 확인해요", glyph: "loader" });
    expect(banners(w)).toEqual(["실제 · SOXL 손절 주문 냄"]);
    await beatAt(w, ET(15, 51));
    expect(card(w)).toMatchObject({ state: "partial", status: "남은 17주는 마감에 취소됐어요. 토스증권 앱에서 확인해 주세요.", glyph: "caution" });
    expect(row(w).state).toBe("partial_closed");
    expect(banners(w).at(-1)).toBe("실제 · SOXL 손절 일부 체결");
  });

  test("Toss ends an order with nothing filled: failed, never sold", async () => {
    for (const [status, code, text] of [
      ["REJECTED", "rejected", "토스증권이 주문을 거절했어요"],
      ["CANCELED", "canceled", "토스증권에서 주문이 취소돼서 체결되지 않았어요."],
    ] as const) {
      const w = await world();
      await setup(w, { plan: [{ status }] });
      await hit(w, ET(10, 0), ET(10, 5));
      await beatAt(w, ET(10, 5, DAY, 30));
      expect(card(w)).toMatchObject({ state: "failed", title: "손절 주문이 되지 않았어요", reason: { code, text }, glyph: "fail" });
      expect(card(w).notes).toContain("주문을 다시 내지 않았어요.");
      expect(banners(w).at(-1)).toBe("실제 · SOXL 손절 주문 안 됨");
    }
  });
});

// ───────────────────────────── G8: the gates, one by one ─────────────────────────────

describe("invest real orders: the gates (G8)", () => {
  test("the server switch off at a close hit: skipped, never planned", async () => {
    const w = await world({ orders: false });
    await setup(w);
    await hit(w, ET(15, 55), ET(16, 5));
    expect(row(w)).toMatchObject({ state: "skipped", reason: "server_off", due_at: null, check_at: null });
  });

  test("the server switch off: skipped server_off, no POST", async () => {
    const w = await world({ orders: false });
    await setup(w);
    await hit(w, ET(10, 0), ET(10, 5));
    expect(posts(w)).toHaveLength(0);
    expect(card(w)).toMatchObject({ state: "skipped", title: "실제 주문이 잠시 멈춰 있어서 주문을 내지 않았어요", reason: { code: "server_off" }, glyph: "caution" });
    expect(value(card(w), "손절선")).toBe("$27.00");
    expect(banners(w)).toEqual(["실제 · SOXL 손절 주문 건너뜀"]);
    expectClean(w);
  });

  test("not confirmed, confirmed at another rev, or with no quantity: skipped not_confirmed, and Toss's account is not read", async () => {
    for (const o of [{ confirm: null }, { confirmRev: 0 }, { confirm: 0 }] as Setup[]) {
      const w = await world();
      await setup(w, o);
      await tickAt(w, ET(10, 0));
      const before = w.up.calls.length;
      w.up.state.tossPrices.set("SOXL", { price: 26.8 });
      await tickAt(w, ET(10, 5));
      expect(posts(w)).toHaveLength(0);
      expect(w.up.calls.slice(before).filter((c) => c.path.startsWith("/api/v1/sellable-quantity"))).toHaveLength(0);
      expect(card(w)).toMatchObject({ state: "skipped", title: "실제 매도로 확인하지 않은 손절이라 주문을 내지 않았어요", reason: { code: "not_confirmed" } });
      expect(card(w).notes).toContain("규칙 시트에서 길게 눌러 확인하면, 다음에 닿을 때부터 팔아요.");
    }
  });

  test("mock mode with a confirmation: the mock record, no POST", async () => {
    const w = await world();
    await setup(w, { mode: "mock" });
    await hit(w, ET(10, 0), ET(10, 5));
    expect(posts(w)).toHaveLength(0);
    expect(card(w)).toMatchObject({ mode: "mock", state: "recorded" });
    expect(rows(w)).toHaveLength(0);
  });

  test("zero sellable: skipped; fractions only until an hour before the close; KR whole shares", async () => {
    const zero = await world();
    await setup(zero);
    zero.up.state.tossSellable.set("SOXL", 0);
    await hit(zero, ET(10, 0), ET(10, 5));
    expect(card(zero)).toMatchObject({ state: "skipped", title: "팔 수 있는 수량이 0주라서 주문을 내지 않았어요", reason: { code: "zero_sellable" } });
    expect(posts(zero)).toHaveLength(0);

    const early = await world();
    await setup(early, { held: 47.35 });
    await hit(early, ET(10, 0), ET(10, 5));
    expect(JSON.parse(posts(early)[0]!.body!).quantity).toBe("47.35");

    const late = await world();
    await setup(late, { held: 47.35 });
    await hit(late, ET(15, 0), ET(15, 5));
    expect(JSON.parse(posts(late)[0]!.body!).quantity).toBe("47");
    expect(card(late).notes).toContain("0.35주는 마감 1시간 전부터 시장가로 팔 수 없어서 남겨요.");
    await beatAt(late, ET(15, 5, DAY, 30));
    await beatAt(late, ET(15, 6));
    expect(card(late).state).toBe("filled");
    expect(card(late).notes).toContain("0.35주는 마감 1시간 전부터 시장가로 팔 수 없어서 남겼어요.");

    const part = await world();
    await setup(part, { held: 0.5 });
    await hit(part, ET(15, 0), ET(15, 5));
    expect(posts(part)).toHaveLength(0);
    expect(card(part).reason?.code).toBe("fraction_hours");

    const kr = await world();
    const K = (h: number, m: number) => kstToEpochDay(DAY, h, m);
    await setup(kr, { symbol: "005930", held: 10.7, stop: 50_000 });
    kr.up.state.tossPrices.set("005930", { price: 51_000 });
    await tickAt(kr, K(10, 0));
    kr.up.state.tossPrices.set("005930", { price: 49_000 });
    await tickAt(kr, K(10, 5));
    expect(JSON.parse(posts(kr)[0]!.body!)).toMatchObject({ symbol: "005930", side: "SELL", quantity: "10" });
  });

  test("an early-close day: skipped early_close, never deferred", async () => {
    const w = await world();
    await setup(w);
    await hit(w, ET(10, 0, "2026-11-27"), ET(10, 5, "2026-11-27"));
    expect(posts(w)).toHaveLength(0);
    expect(card(w)).toMatchObject({ state: "skipped", title: "조기 폐장일이라 시장가 주문을 내지 않았어요", reason: { code: "early_close" } });
    expect(row(w)).toMatchObject({ state: "skipped", market_day: null, check_at: null });
    // a close hit the day before Thanksgiving: the next session is the early close, so no order is planned either
    const w2 = await world();
    await setup(w2);
    await hit(w2, ET(16, 0, "2026-11-25"), ET(16, 5, "2026-11-25"));
    expect(card(w2)).toMatchObject({ state: "skipped", reason: { code: "early_close" } });
    expect(row(w2).check_at).toBeNull();
  });

  test("a 403 on the sellable read: skipped with the allowed IP, paused an hour, no POST", async () => {
    const w = await world();
    await setup(w);
    await tickAt(w, ET(10, 0));
    w.up.state.pathStatus.set("/api/v1/sellable-quantity", [403, 403]);
    w.up.state.tossPrices.set("SOXL", { price: 26.8 });
    await tickAt(w, ET(10, 5));
    expect(posts(w)).toHaveLength(0);
    expect(card(w)).toMatchObject({ state: "skipped", title: "토스증권이 이 서버의 접속을 막고 있어서 주문을 내지 않았어요(허용 IP)", reason: { code: "ip_paused", ip: "203.0.113.7" } });
    expect(card(w).notes).toContain("토스증권 설정에서 이 IP를 다시 허용해 주세요.");
    expect(idb.getSettings(w.h.db, w.uid)).toMatchObject({ toss_error: "ip_not_allowed", toss_paused_until: ET(10, 5) + 3_600_000 });
    expect(banners(w)).toEqual(["실제 · SOXL 손절 주문 건너뜀"]);
  });

  test("a hit while Toss's 403 pause holds: skipped at once (the quote from another source)", async () => {
    const w = await world({ sources: true });
    await setup(w);
    await tickAt(w, ET(10, 0));
    idb.updateSettings(w.h.db, w.uid, { toss_error: "ip_not_allowed", toss_error_at: ET(10, 1), toss_paused_until: ET(11, 1) }, ET(10, 1));
    w.up.state.yahoo.set("SOXL", { price: 26.8, time: Math.floor(ET(10, 5) / 1000) - 10 });
    await tickAt(w, ET(10, 5));
    expect(posts(w)).toHaveLength(0);
    expect(card(w)).toMatchObject({ state: "skipped", reason: { code: "ip_paused" } });
    expect(row(w).check_at).toBeNull();
  });

  test("a 429 on the sellable read: the hit waits (no banner, no call), then goes out after the pause", async () => {
    const w = await world();
    await setup(w);
    await tickAt(w, ET(10, 0));
    w.up.state.pathStatus.set("/api/v1/sellable-quantity", [429]);
    w.up.state.tossPrices.set("SOXL", { price: 26.8 });
    await tickAt(w, ET(10, 5));
    expect(card(w)).toMatchObject({ state: "waiting", title: "손절 주문을 잠시 뒤에 내요", status: "토스증권이 잠시 요청을 막고 있어서, 풀리면 바로 내요 · 실제 주문을 끄면 내지 않아요", glyph: "loader" });
    expect(card(w).rows).toEqual([
      { label: "손절선", value: "$27.00" },
      { label: "주문", value: "47주 · 시장가" },
    ]);
    expect(banners(w)).toEqual([]);
    expect(w.pushes).toEqual([]);
    await beatAt(w, ET(10, 9, DAY, 59));
    expect(posts(w)).toHaveLength(0);
    await beatAt(w, ET(10, 10));
    expect(posts(w)).toHaveLength(1);
    expect(JSON.parse(posts(w)[0]!.body!).clientOrderId).toBe(row(w).client_order_id);
    expect(card(w).state).toBe("submitted");
    expect(banners(w)).toEqual(["실제 · SOXL 손절 주문 냄"]);
  });

  test("a 429 pause that outlasts the session: skipped, not carried to the next day; a wait dropped by a rule delete", async () => {
    const w = await world();
    await setup(w);
    await tickAt(w, ET(15, 50));
    w.up.state.pathStatus.set("/api/v1/sellable-quantity", [429]);
    w.up.state.tossPrices.set("SOXL", { price: 26.8 });
    await tickAt(w, ET(15, 55));
    expect(card(w)).toMatchObject({ state: "skipped", title: "토스증권이 잠시 요청을 막고 있어서 주문을 내지 않았어요", reason: { code: "rate_paused" } });
    expect(banners(w)).toEqual(["실제 · SOXL 손절 주문 건너뜀"]);
    expect(posts(w)).toHaveLength(0);

    const d = await world();
    const { r } = await setup(d);
    await tickAt(d, ET(10, 0));
    d.up.state.pathStatus.set("/api/v1/sellable-quantity", [429]);
    d.up.state.tossPrices.set("SOXL", { price: 26.8 });
    await tickAt(d, ET(10, 5));
    expect(card(d).state).toBe("waiting");
    expect((await api(d, "DELETE", `/api/invest/rules/${r.id}`)).status).toBe(200);
    expect(card(d)).toMatchObject({ state: "skipped", title: "손절 규칙을 지워서 예정된 주문을 내지 않았어요", reason: { code: "rule_deleted" } });
    expect(banners(d)).toEqual([]);
    await beatAt(d, ET(10, 10));
    expect(posts(d)).toHaveLength(0);
  });

  test("the day's caps: one order per rule and market day; a person's orders within the symbols they hold", async () => {
    const w = await world();
    // two symbols held: the person's cap (2) leaves room, so only the rule's one-a-day index stops the second
    const { r } = await setup(w, { others: [{ symbol: "SOXS", held: 10, sellable: 10, stop: 10 }] });
    await hit(w, ET(10, 0), ET(10, 5));
    expect(posts(w)).toHaveLength(1);
    // a second hit of the same rule that day (a later hit number): skipped, not sent
    const hub = w.h.app.core.invest;
    const rule = idb.rule(w.h.db, w.uid, r.id)!;
    w.h.clock.t = ET(10, 30);
    await hub.desk.hit({ userId: w.uid, rule, hitSeq: 2, obs: { price: 26.5, prevClose: null, at: ET(10, 30), source: "toss" }, slot: { market: "US", day: DAY, at: ET(10, 30), close: false, key: "x" }, now: ET(10, 30), alertId: "ia_none", intradayOnly: false });
    expect(posts(w)).toHaveLength(1);
    // the rule's one order a market day: its own words (DD 2314 §1), Toss's quantity kept for the call (§4)
    expect(row(w)).toMatchObject({ state: "skipped", reason: "rule_day", market_day: null, qty: null, sellable: 47 });
    expect(card(w)).toMatchObject({ title: "손절 주문은 규칙마다 하루 한 번이라 주문을 내지 않았어요", reason: { code: "rule_day" } });
    expect(realStopCallLine("모시", row(w), "{④}")).toContain("실제 주문을 내지 않았어요. 손절 주문은 규칙마다 하루 한 번이에요. 47주를 그대로 갖고 있어요. {④}");

    // SOXS has a confirmed stop but is not in the holdings read: one held symbol, one order that day
    const two = await world();
    await setup(two, { others: [{ symbol: "SOXS", sellable: 10, stop: 10, confirm: 10 }] });
    await tickAt(two, ET(10, 0));
    two.up.state.tossPrices.set("SOXL", { price: 26.8 });
    two.up.state.tossPrices.set("SOXS", { price: 9.5 });
    await tickAt(two, ET(10, 5));
    expect(posts(two)).toHaveLength(1);
    expect(rows(two).map((x) => x.reason ?? x.state).sort()).toEqual(["daily_limit", "submitted"]);

    // two hits at once (one held symbol): the first one's send in flight counts, so the second is capped
    const three = await world();
    await setup(three, { others: [{ symbol: "SOXS", sellable: 10, stop: 10, confirm: 10 }] });
    await tickAt(three, ET(10, 0));
    const hub3 = three.h.app.core.invest;
    const at = ET(10, 5);
    three.h.clock.t = at;
    const ruleOf = (symbol: string) => idb.rules(three.h.db, three.uid).find((x) => x.symbol === symbol)!;
    const go = (symbol: string, price: number) => hub3.desk.hit({ userId: three.uid, rule: ruleOf(symbol), hitSeq: 1, obs: { price, prevClose: null, at, source: "toss" }, slot: { market: "US", day: DAY, at, close: false, key: "y" }, now: at, alertId: "ia_none", intradayOnly: false });
    await Promise.all([go("SOXL", 26.8), go("SOXS", 9.5)]);
    expect(posts(three)).toHaveLength(1);
    expect(rows(three).map((x) => x.reason ?? x.state).sort()).toEqual(["daily_limit", "submitted"]);
    const capped = rows(two).find((x) => x.reason === "daily_limit")!;
    expect(capped).toMatchObject({ symbol: "SOXS", sellable: 10 });
    expect(realStopCallLine("모시", capped, "{④}")).toContain("실제 주문은 하루에 보유 종목 수까지예요. 10주를 그대로 갖고 있어요. {④}");
  });
});

// ───────────────────────────── planned orders ─────────────────────────────

describe("invest real orders: the next session", () => {
  test("a close hit: scheduled with its send time and a call; sent at the next session's first check", async () => {
    const w = await world({ twilio: true });
    writeMyPhone(w.h.app.core, w.uid, { e164: "+821012345678", verifiedAt: w.h.clock.t, codeHash: null, codeExpiresAt: 0, attempts: 0 });
    await setup(w);
    await hit(w, ET(15, 55), ET(16, 5));
    expect(posts(w)).toHaveLength(0);
    const c = card(w);
    expect(c).toMatchObject({ state: "scheduled", title: "다음 거래일에 손절 주문을 내요", hero: { v: 26.8 }, sub: "11월 30일 종가", why: "종가가 손절선 아래로 마감해서, 다음 거래일 개장 15분 뒤에 팔아요.", status: "주문 예정 · 실제 주문을 끄면 내지 않아요" });
    expect(c.glyph).toBeUndefined();
    expect(c.rows).toEqual([
      { label: "손절선", value: "$27.00" },
      { label: "주문", value: "47주 · 시장가" },
      { label: "낼 시각", value: "12월 1일 23:45" },
    ]);
    expect(banners(w)).toEqual(["실제 · SOXL 손절 주문 예정"]);
    expect(row(w)).toMatchObject({ state: "scheduled", market_day: NEXT, due_at: ET(9, 45, NEXT), basis: "close" });
    await beatAt(w, ET(9, 44, NEXT, 59));
    expect(posts(w)).toHaveLength(0);
    // the hub's own beat runs the desk after its watch tick
    w.h.clock.t = ET(9, 45, NEXT);
    await w.h.app.core.invest.beat(w.h.clock.t);
    await w.h.app.core.idle();
    expect(posts(w)).toHaveLength(1);
    expect(card(w).state).toBe("submitted");
    expect(stopCards(w)).toHaveLength(1);
  });

  test("a hit at the close's own check: scheduled with the near-close words", async () => {
    const w = await world();
    await setup(w);
    await hit(w, ET(15, 55), ET(16, 0));
    expect(card(w)).toMatchObject({ state: "scheduled", sub: "관측가 · 06:00", why: "마감 직전에 장중 기준 가격에 닿아서, 다음 거래일 개장 15분 뒤에 팔아요." });
    expect(row(w).basis).toBe("late");
  });

  test("planned orders dropped: rule saved or deleted, real mode off, nothing to sell — no banner; the switch off — a banner", async () => {
    const make = async () => {
      const w = await world();
      const { r } = await setup(w);
      await hit(w, ET(15, 55), ET(16, 5));
      expect(card(w).state).toBe("scheduled");
      return { w, r, n: banners(w).length };
    };
    const a = await make();
    expect((await api(a.w, "PATCH", `/api/invest/rules/${a.r.id}`, { changes: { price: 26.5 }, ifRev: a.r.rev })).status).toBe(200);
    expect(card(a.w)).toMatchObject({ state: "skipped", title: "손절 규칙이 바뀌어서 예정된 주문을 내지 않았어요", reason: { code: "rule_changed" } });
    expect(banners(a.w)).toHaveLength(a.n);

    const b = await make();
    expect((await api(b.w, "DELETE", "/api/invest/watchlist/SOXL?withRules=1")).status).toBe(200);
    expect(card(b.w).title).toBe("손절 규칙을 지워서 예정된 주문을 내지 않았어요");

    const c = await make();
    idb.updateSettings(c.w.h.db, c.w.uid, { mode: "mock" }, c.w.h.clock.t);
    await beatAt(c.w, ET(9, 45, NEXT));
    expect(card(c.w)).toMatchObject({ title: "실제 주문을 꺼서 예정된 주문을 내지 않았어요", reason: { code: "disabled" } });
    expect(banners(c.w)).toHaveLength(c.n);

    const d = await make();
    d.w.up.state.tossSellable.set("SOXL", 0);
    await beatAt(d.w, ET(9, 45, NEXT));
    expect(card(d.w)).toMatchObject({ title: "팔 수 있는 수량이 0주라서 예정된 주문을 내지 않았어요", reason: { code: "zero_sellable" } });
    expect(banners(d.w)).toHaveLength(d.n);

    const e = await make();
    e.w.h.app.core.cfg.invest.orders = false;
    await beatAt(e.w, ET(9, 45, NEXT));
    expect(card(e.w)).toMatchObject({ title: "실제 주문이 잠시 멈춰 있어서 예정된 주문을 내지 않았어요", reason: { code: "server_off" } });
    expect(banners(e.w).slice(e.n)).toEqual(["실제 · SOXL 손절 주문 건너뜀"]);

    for (const x of [a, b, c, d, e]) {
      expect(posts(x.w)).toHaveLength(0);
      expect(rows(x.w).every((o) => o.market_day === null && o.check_at === null)).toBe(true);
    }
  });

  test("a rule whose rev moved with no hook: dropped at its time as changed", async () => {
    const w = await world();
    const { r } = await setup(w);
    await hit(w, ET(15, 55), ET(16, 5));
    w.h.db.sql.query("UPDATE invest_rules SET rev = rev + 1 WHERE id = $id").run({ id: r.id });
    await beatAt(w, ET(9, 45, NEXT));
    expect(posts(w)).toHaveLength(0);
    expect(row(w)).toMatchObject({ state: "canceled", reason: "rule_changed" });
  });

  test("a planned order at its time when the person's day cap is already used: skipped daily_limit, not sent", async () => {
    const w = await world();
    await setup(w, { others: [{ symbol: "SOXS", sellable: 10, stop: 10, confirm: 10 }] });
    w.up.state.tossPrices.set("SOXS", { price: 10.5 });
    await hit(w, ET(15, 55), ET(16, 5));
    expect(row(w).state).toBe("scheduled");
    // the next session's first check: SOXS hits in the watch, then the desk releases SOXL (one held symbol: cap 1)
    w.up.state.tossPrices.set("SOXS", { price: 9.5 });
    await tickAt(w, ET(9, 45, NEXT));
    expect(posts(w)).toHaveLength(1);
    await beatAt(w, ET(9, 45, NEXT));
    expect(posts(w)).toHaveLength(1);
    expect(JSON.parse(posts(w)[0]!.body!).symbol).toBe("SOXS");
    expect(row(w)).toMatchObject({ state: "skipped", reason: "daily_limit", market_day: null, sellable: 47 });
  });

  test("real mode off with no hook: at the time no Toss read, dropped as disabled (lead B18)", async () => {
    const w = await world();
    await setup(w);
    await hit(w, ET(15, 55), ET(16, 5));
    const reads = () => w.up.calls.filter((c) => c.path.startsWith("/api/v1/sellable-quantity")).length;
    const before = reads();
    expect(before).toBeGreaterThan(0); // the close hit read it: the counter sees reads
    idb.updateSettings(w.h.db, w.uid, { mode: "mock" }, w.h.clock.t);
    await beatAt(w, ET(9, 45, NEXT));
    expect(reads()).toBe(before);
    expect(posts(w)).toHaveLength(0);
    expect(row(w)).toMatchObject({ state: "canceled", reason: "disabled" });
  });

  test("the same hit handed twice: the second asks Toss nothing and posts nothing (lead B26)", async () => {
    const w = await world();
    const { r } = await setup(w);
    await hit(w, ET(10, 0), ET(10, 5));
    const reads = () => w.up.calls.filter((c) => c.path.startsWith("/api/v1/sellable-quantity")).length;
    const n = { reads: reads(), msgs: w.h.db.sql.query("SELECT COUNT(*) AS n FROM messages").get() as { n: number }, banners: banners(w).length };
    expect(n.reads).toBe(1); // the first hit read it: the counter sees reads
    // hitSeq 1 again (an overlapping run of the same check)
    const rule = { ...idb.rule(w.h.db, w.uid, r.id)!, rev: row(w).rule_rev };
    const out = await w.h.app.core.invest.desk.hit({ userId: w.uid, rule, hitSeq: 1, obs: { price: 26.8, prevClose: null, at: ET(10, 5), source: "toss" }, slot: { market: "US", day: DAY, at: ET(10, 5), close: false, key: "x" }, now: ET(10, 5), alertId: "ia_none", intradayOnly: false });
    expect(out.title).toBe("");
    expect(reads()).toBe(n.reads);
    expect((w.h.db.sql.query("SELECT COUNT(*) AS n FROM messages").get() as { n: number }).n).toBe(n.msgs.n);
    expect(banners(w)).toHaveLength(n.banners);
    expect(posts(w)).toHaveLength(1);
    expect(rows(w)).toHaveLength(1);
  });

  test("a proposal applied to the rule drops its planned order", async () => {
    const w = await world();
    const { r } = await setup(w);
    await hit(w, ET(15, 55), ET(16, 5));
    const me = (await w.h.req("GET", "/api/me", { token: w.token }).then((x) => x.json())) as { mainThreadId?: string; session?: { mainThreadId: string } };
    const tool = investTools(w.h.app.core, w.uid).find((t) => t.name === "invest_watch_propose")!;
    const ctx = { userId: w.uid, threadId: me.mainThreadId ?? me.session?.mainThreadId ?? "", agentName: "모시", displayName: "앨리스", now: () => new Date(w.h.clock.t), status: () => {} } as unknown as ToolContext;
    const out = await tool.run({ symbol: "SOXL", changes: [{ ruleId: r.id, price: 26.5 }], reason: "손절을 내려요", basis: "request" }, ctx);
    const proposalId = (out.card as { proposalId: string }).proposalId;
    expect((await api(w, "POST", `/api/invest/proposals/${proposalId}`, { decision: "apply" })).status).toBe(200);
    expect(row(w)).toMatchObject({ state: "canceled", reason: "rule_changed" });
    await beatAt(w, ET(9, 45, NEXT));
    expect(posts(w)).toHaveLength(0);
  });

  test("the Toss login removed: planned orders dropped, sent ones no longer checked", async () => {
    const w = await world();
    await setup(w, { plan: [{ status: "PENDING" }], others: [{ symbol: "SOXS", held: 10, sellable: 10, stop: 10, confirm: 10 }] });
    await tickAt(w, ET(15, 55));
    w.up.state.tossPrices.set("SOXL", { price: 26.8 });
    await tickAt(w, ET(16, 0));
    w.up.state.tossPrices.set("SOXS", { price: 9.5 });
    await tickAt(w, ET(9, 50, NEXT));
    expect(card(w, "SOXL").state).toBe("scheduled");
    expect(card(w, "SOXS").state).toBe("submitted");
    const n = banners(w).length;
    await w.h.app.core.invest.onTossRemoved(w.uid);
    expect(card(w, "SOXL")).toMatchObject({ title: "토스증권 연결을 지워서 예정된 주문을 내지 않았어요", reason: { code: "key_removed" } });
    expect(card(w, "SOXS")).toMatchObject({ state: "submitted", status: "토스증권 연결을 지워서 체결 확인을 멈췄어요. 토스증권 앱에서 확인해 주세요.", glyph: "caution" });
    expect(banners(w)).toHaveLength(n);
    const reads = orderReads(w).length;
    await beatAt(w, ET(9, 55, NEXT));
    expect(orderReads(w)).toHaveLength(reads);
    expect(posts(w)).toHaveLength(1);
  });
});

// ───────────────────────────── a person's action while Toss is asked ─────────────────────────────

describe("invest real orders: changes that land while Toss is asked", () => {
  /** something the person (or the operator) does while the hit's sellable quantity is being read */
  const during = (w: World, path: string, act: () => void) => {
    w.up.state.onCall = (_m, p) => {
      if (p === path) {
        w.up.state.onCall = null;
        act();
      }
    };
  };

  test("the last check before a first POST: the switch, real mode, the confirmation as they are right then", async () => {
    const cases: [string, (w: World, ruleId: string) => void, Record<string, unknown>][] = [
      ["switch", (w) => (w.h.app.core.cfg.invest.orders = false), { state: "skipped", reason: "server_off" }],
      ["mode", (w) => idb.updateSettings(w.h.db, w.uid, { mode: "mock" }, w.h.clock.t), { state: "canceled", reason: "disabled" }],
      ["confirm gone", (w, id) => w.h.db.sql.query("DELETE FROM invest_real_confirms WHERE rule_id = $r").run({ r: id }), { state: "canceled", reason: "disabled" }],
      ["confirm lowered", (w, id) => w.h.db.sql.query("UPDATE invest_real_confirms SET qty = 10 WHERE rule_id = $r").run({ r: id }), { state: "canceled", reason: "disabled" }],
    ];
    for (const [, act, want] of cases) {
      const w = await world();
      const { r } = await setup(w);
      await tickAt(w, ET(10, 0));
      during(w, "/api/v1/sellable-quantity", () => act(w, r.id));
      w.up.state.tossPrices.set("SOXL", { price: 26.8 });
      await tickAt(w, ET(10, 5));
      expect(posts(w)).toHaveLength(0);
      expect(row(w)).toMatchObject({ ...want, market_day: null, sends: 0 });
    }
  });

  test("a rule whose rev moved during a release's read, with no hook: the last check drops it as changed", async () => {
    const w = await world();
    const { r } = await setup(w);
    await hit(w, ET(15, 55), ET(16, 5));
    during(w, "/api/v1/sellable-quantity", () => w.h.db.sql.query("UPDATE invest_rules SET rev = rev + 1 WHERE id = $id").run({ id: r.id }));
    await beatAt(w, ET(9, 45, NEXT));
    expect(posts(w)).toHaveLength(0);
    expect(row(w)).toMatchObject({ state: "canceled", reason: "rule_changed", sends: 0 });
  });

  test("a close hit whose rule changed during the read: dropped at once, never planned", async () => {
    const w = await world();
    const { r } = await setup(w);
    await tickAt(w, ET(15, 55));
    during(w, "/api/v1/sellable-quantity", () => w.h.db.sql.query("UPDATE invest_rules SET rev = rev + 1 WHERE id = $id").run({ id: r.id }));
    w.up.state.tossPrices.set("SOXL", { price: 26.8 });
    await tickAt(w, ET(16, 5));
    expect(row(w)).toMatchObject({ state: "canceled", reason: "rule_changed", due_at: null, check_at: null });
  });

  test("a search while the login is removed: it stays stopped", async () => {
    const w = await world();
    await setup(w);
    w.up.state.orderAnswers = ["lost", "lost"];
    await hit(w, ET(10, 0), ET(10, 5));
    await beatAt(w, ET(10, 5, DAY, 30));
    expect(row(w).state).toBe("searching");
    during(w, "/api/v1/orders", () => w.h.app.core.invest.desk.keyRemoved(w.uid, w.h.clock.t));
    await beatAt(w, ET(10, 6));
    expect(row(w)).toMatchObject({ state: "searching", check_at: null });
    expect(row(w).stopped_at).not.toBeNull();
  });

  test("fill checks wait out the allowed-IP pause, not a 429 pause", async () => {
    const w = await world();
    await setup(w, { plan: [{ status: "PENDING" }] });
    await hit(w, ET(10, 0), ET(10, 5));
    idb.updateSettings(w.h.db, w.uid, { toss_error: "ip_not_allowed", toss_paused_until: ET(10, 7) }, w.h.clock.t);
    await beatAt(w, ET(10, 5, DAY, 30));
    expect(orderReads(w)).toHaveLength(0);
    idb.updateSettings(w.h.db, w.uid, { toss_error: "rate_limited", toss_paused_until: ET(10, 9) }, w.h.clock.t);
    await beatAt(w, ET(10, 6));
    expect(orderReads(w)).toHaveLength(1);
  });

  test("the rule changed during the hit's sellable read: no order", async () => {
    const w = await world();
    const { r } = await setup(w);
    await tickAt(w, ET(10, 0));
    w.up.state.onCall = (_m, path) => {
      if (path === "/api/v1/sellable-quantity") {
        w.h.db.sql.query("UPDATE invest_rules SET rev = rev + 1 WHERE id = $id").run({ id: r.id });
        w.up.state.onCall = null;
      }
    };
    w.up.state.tossPrices.set("SOXL", { price: 26.8 });
    await tickAt(w, ET(10, 5));
    expect(posts(w)).toHaveLength(0);
    expect(row(w)).toMatchObject({ state: "canceled", reason: "rule_changed", market_day: null });
    expect(card(w).title).toBe("손절 규칙이 바뀌어서 주문을 내지 않았어요");
    expect(banners(w)).toEqual([]);
  });

  test("a planned order dropped during its release's Toss read stays dropped (no send, no flip back)", async () => {
    for (const answer of [null, 429] as const) {
      const w = await world();
      const { r } = await setup(w);
      await hit(w, ET(15, 55), ET(16, 5));
      expect(card(w).state).toBe("scheduled");
      w.up.state.onCall = (_m, path) => {
        if (path === "/api/v1/sellable-quantity") {
          w.up.state.onCall = null;
          w.h.app.core.invest.ruleChanged(w.uid, r.id, false);
        }
      };
      if (answer) w.up.state.pathStatus.set("/api/v1/sellable-quantity", [answer]);
      await beatAt(w, ET(9, 45, NEXT));
      expect(posts(w)).toHaveLength(0);
      expect(row(w)).toMatchObject({ state: "canceled", reason: "rule_changed", check_at: null });
      expect(card(w).title).toBe("손절 규칙이 바뀌어서 예정된 주문을 내지 않았어요");
    }
  });

  test("the login removed while the order is POSTed: the answer is kept, checks stay stopped", async () => {
    const w = await world();
    await setup(w);
    await tickAt(w, ET(10, 0));
    w.up.state.onCall = (method, path) => {
      if (method === "POST" && path === "/api/v1/orders") {
        w.up.state.onCall = null;
        w.h.app.core.invest.desk.keyRemoved(w.uid, w.h.clock.t);
      }
    };
    w.up.state.tossPrices.set("SOXL", { price: 26.8 });
    await tickAt(w, ET(10, 5));
    expect(posts(w)).toHaveLength(1);
    expect(row(w)).toMatchObject({ state: "submitted", toss_order_id: "tso-00000001", check_at: null });
    expect(row(w).stopped_at).not.toBeNull();
    expect(card(w).status).toBe("토스증권 연결을 지워서 체결 확인을 멈췄어요. 토스증권 앱에서 확인해 주세요.");
    await beatAt(w, ET(10, 10));
    expect(orderReads(w)).toHaveLength(0);
  });

  test("the login removed during a POST with no answer: no resend and no search is scheduled", async () => {
    for (const answers of [["lost"], ["lost", "lost"]] as OrderAnswer[][]) {
      const w = await world();
      await setup(w);
      w.up.state.orderAnswers = answers;
      if (answers.length === 1) {
        during(w, "/api/v1/orders", () => w.h.app.core.invest.desk.keyRemoved(w.uid, w.h.clock.t));
        await hit(w, ET(10, 0), ET(10, 5));
        expect(row(w)).toMatchObject({ state: "sending", sends: 1, check_at: null });
      } else {
        await hit(w, ET(10, 0), ET(10, 5));
        during(w, "/api/v1/orders", () => w.h.app.core.invest.desk.keyRemoved(w.uid, w.h.clock.t));
        await beatAt(w, ET(10, 5, DAY, 30));
        expect(row(w)).toMatchObject({ state: "searching", sends: 2, check_at: null });
      }
      expect(row(w).stopped_at).not.toBeNull();
    }
  });

  test("the login removed during a fill check: the check's answer does not undo the stop", async () => {
    const w = await world();
    await setup(w, { plan: [{ status: "PENDING" }] });
    await hit(w, ET(10, 0), ET(10, 5));
    w.up.state.onCall = (_m, path) => {
      if (path.startsWith("/api/v1/orders/")) {
        w.up.state.onCall = null;
        w.h.app.core.invest.desk.keyRemoved(w.uid, w.h.clock.t);
      }
    };
    await beatAt(w, ET(10, 5, DAY, 30));
    expect(row(w).stopped_at).not.toBeNull();
    expect(row(w).check_at).toBeNull();
    await beatAt(w, ET(10, 10));
    expect(orderReads(w)).toHaveLength(1);
  });
});

// ───────────────────────────── resends ─────────────────────────────

describe("invest real orders: resends (team-lead 2040 5)", () => {
  const sent = async (answers: OrderAnswer[], o: Setup = {}) => {
    const w = await world();
    await setup(w, o);
    w.up.state.orderAnswers = answers;
    await hit(w, ET(10, 0), ET(10, 5));
    return w;
  };
  const bodies = (w: World) => posts(w).map((c) => c.body);
  const w403Reads = (w: World) => w.up.calls.filter((c) => c.method === "GET" && c.path.startsWith("/api/v1/orders"));

  test("no answer, or 409 in progress: sent once more with the same body at the next beat", async () => {
    for (const a of ["drop", "lost", { status: 409, code: "request-in-progress" }] as OrderAnswer[]) {
      const w = await sent([a]);
      expect(posts(w)).toHaveLength(1);
      expect(card(w)).toMatchObject({ state: "submitted", status: "주문 접수 확인 중", glyph: "loader" });
      expect(banners(w)).toEqual([]);
      await beatAt(w, ET(10, 5, DAY, 30));
      expect(posts(w)).toHaveLength(2);
      expect(new Set(bodies(w)).size).toBe(1);
      expect(card(w)).toMatchObject({ state: "submitted", status: "체결 확인 중" });
      expect(value(card(w), "주문 번호")).toBe("…0001");
      expect(w.up.state.tossOrders).toHaveLength(1);
      expect(banners(w)).toEqual(["실제 · SOXL 손절 주문 냄"]);
    }
  });

  test("no answer twice: looked for in the order list; found → followed, not found → unknown, never a third send", async () => {
    const found = await sent(["lost", "lost"]);
    await beatAt(found, ET(10, 5, DAY, 30));
    expect(card(found)).toMatchObject({ state: "unknown", status: "주문 내역에서 찾는 중", glyph: "loader" });
    await beatAt(found, ET(10, 6));
    expect(card(found).state).toBe("submitted");
    expect(row(found)).toMatchObject({ toss_order_id: "tso-00000001", reason: null });
    expect(banners(found)).toEqual(["실제 · SOXL 손절 주문 냄"]);
    await beatAt(found, ET(10, 6, DAY, 30));
    await beatAt(found, ET(10, 7));
    expect(card(found).state).toBe("filled");
    expect(posts(found)).toHaveLength(2);

    const lost = await sent(["drop", "drop"]);
    await beatAt(lost, ET(10, 5, DAY, 30));
    for (let s = 60; s < 300; s += 30) await beatAt(lost, ET(10, 5, DAY, s));
    expect(card(lost).state).toBe("unknown");
    expect(card(lost).why).toBeUndefined();
    await beatAt(lost, ET(10, 10));
    expect(card(lost)).toMatchObject({ state: "unknown", title: "손절 주문 결과를 확인하지 못했어요", why: "토스증권이 답하지 않아서, 주문이 들어갔는지 알 수 없어요.", glyph: "caution" });
    expect(card(lost).notes).toEqual(["토스증권 앱의 주문 내역에서 확인해 주세요.", "같은 주문을 다시 내지 않았어요.", INTRADAY_ONLY]);
    expect(banners(lost)).toEqual(["실제 · SOXL 손절 주문 확인 필요"]);
    await beatAt(lost, ET(10, 30));
    expect(posts(lost)).toHaveLength(2);
  });

  test("a resend checks the switch and real mode right before its POST: off → looked for, never sent again (team-lead 2310)", async () => {
    const cases: ((w: World) => void)[] = [(w) => (w.h.app.core.cfg.invest.orders = false), (w) => idb.updateSettings(w.h.db, w.uid, { mode: "mock" }, w.h.clock.t)];
    for (const act of cases) {
      const w = await sent(["drop"]);
      expect(row(w)).toMatchObject({ state: "sending", sends: 1 });
      act(w);
      await beatAt(w, ET(10, 5, DAY, 30));
      expect(posts(w)).toHaveLength(1);
      expect(row(w)).toMatchObject({ state: "searching", reason: "no_answer", sends: 1 });
      for (let t = 60; t < 300; t += 30) await beatAt(w, ET(10, 5, DAY, t));
      await beatAt(w, ET(10, 10));
      expect(row(w).state).toBe("unknown");
      expect(posts(w)).toHaveLength(1);
    }
    // the first send was in: found in the list and followed
    const w = await sent(["lost"]);
    w.h.app.core.cfg.invest.orders = false;
    await beatAt(w, ET(10, 5, DAY, 30));
    await beatAt(w, ET(10, 6));
    expect(posts(w)).toHaveLength(1);
    expect(row(w)).toMatchObject({ state: "submitted", toss_order_id: "tso-00000001" });
  });

  test("a send that never reached the orders POST uses neither the rule's day nor the person's cap (team-lead 2310)", async () => {
    for (const [error, state, reason] of [["down", "failed", "toss_down"], ["not_connected", "skipped", "toss_not_connected"], ["ip_not_allowed", "failed", "ip_not_allowed"]] as const) {
      const w = await world();
      const { r } = await setup(w);
      const toss = w.h.app.core.invest.toss;
      const real = toss.sellStop.bind(toss);
      toss.sellStop = async (): Promise<TossOrderResult> => ({ ok: false, error, posted: false });
      try {
        await hit(w, ET(10, 0), ET(10, 5));
      } finally {
        toss.sellStop = real;
      }
      expect(posts(w)).toHaveLength(0);
      expect(row(w)).toMatchObject({ state, reason, sends: 0, sent_at: null, market_day: null });
      expect(idb.realOrdersSentOn(w.h.db, w.uid, DAY)).toBe(0);
      if (error !== "down") continue;
      // the same rule again that day (a later hit number) still goes out, and then counts
      const rule = idb.rule(w.h.db, w.uid, r.id)!;
      w.h.clock.t = ET(10, 30);
      await w.h.app.core.invest.desk.hit({ userId: w.uid, rule, hitSeq: 2, obs: { price: 26.5, prevClose: null, at: ET(10, 30), source: "toss" }, slot: { market: "US", day: DAY, at: ET(10, 30), close: false, key: "x" }, now: ET(10, 30), alertId: "ia_none", intradayOnly: false });
      expect(posts(w)).toHaveLength(1);
      expect(idb.realOrdersSentOn(w.h.db, w.uid, DAY)).toBe(1);
    }
  });

  test("a 401 on the orders POST and then no new token: the POST was made, so the send counts and keeps its day (lead B40)", async () => {
    for (const [tokenStatus, error, reason] of [[500, "down", "toss_down"], [401, "auth", "auth"]] as const) {
      const w = await world();
      await setup(w);
      w.up.state.orderAnswers = [{ status: 401 }];
      // the session's token serves the sellable read; the one asked for after the 401 is refused
      w.up.state.onCall = (method, path) => {
        if (method === "POST" && path === "/api/v1/orders") w.up.state.tokenStatus = tokenStatus;
      };
      await hit(w, ET(10, 0), ET(10, 5));
      w.up.state.onCall = null;
      expect(posts(w)).toHaveLength(1);
      expect(w.up.calls.filter((c) => c.path === "/oauth2/token" && w.up.calls.indexOf(c) > w.up.calls.indexOf(posts(w)[0]!))).toHaveLength(1);
      expect([tokenStatus, row(w)]).toMatchObject([tokenStatus, { state: "failed", reason, sends: 1, sent_at: ET(10, 5), market_day: DAY }]);
      expect(idb.realOrdersSentOn(w.h.db, w.uid, DAY)).toBe(1);
      const order = { symbol: "SOXL", quantity: "1", clientOrderId: "mBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB" };
      w.up.state.tokenStatus = null;
      w.up.state.orderAnswers = [{ status: 401 }];
      w.up.state.onCall = (method, path) => {
        if (method === "POST" && path === "/api/v1/orders") w.up.state.tokenStatus = tokenStatus;
      };
      expect(await w.h.app.core.invest.toss.sellStop(w.uid, order)).toEqual({ ok: false, error, posted: true });
      w.up.state.onCall = null;
    }
  });

  test("sellStop says whether the orders POST was made", async () => {
    const order = { symbol: "SOXL", quantity: "1", clientOrderId: "mAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" };
    const none = await world();
    expect(await none.h.app.core.invest.toss.sellStop(none.uid, order)).toEqual({ ok: false, error: "not_connected", posted: false });
    const off = await world();
    await setup(off);
    off.h.app.core.cfg.invest.tossBase = null;
    expect(await off.h.app.core.invest.toss.sellStop(off.uid, order)).toEqual({ ok: false, error: "off", posted: false });
    // the session's token or account gone, and Toss refusing the new one: no POST
    for (const kind of ["token", "account"] as const) {
      const w = await world();
      await setup(w);
      const login = await w.h.app.core.connections.sessionFor(w.uid, "toss-investment");
      const cur = login!.session.get<{ token: string; exp: number; accountSeq?: string }>()!;
      if (kind === "token") {
        login!.session.set({ ...cur, token: "", exp: 0 }, 60_000);
        w.up.state.tokenStatus = 403;
      } else {
        login!.session.set({ ...cur, accountSeq: undefined }, 60_000);
        w.up.state.tossStatus = 500;
      }
      expect([kind, await w.h.app.core.invest.toss.sellStop(w.uid, order)]).toEqual([kind, { ok: false, error: kind === "token" ? "ip_not_allowed" : "down", posted: false }]);
      expect(posts(w)).toHaveLength(0);
    }
    for (const [answer, error] of [["drop", "lost"], [{ status: 403, code: "x" }, "ip_not_allowed"], [{ status: 429, code: "x" }, "rate_limited"], [{ status: 503, code: "x" }, "server"]] as [OrderAnswer, string][]) {
      const w = await world();
      await setup(w);
      w.up.state.orderAnswers = [answer];
      expect(await w.h.app.core.invest.toss.sellStop(w.uid, order)).toMatchObject({ ok: false, error, posted: true });
    }
  });

  test("the search adopts only a market SELL of the same quantity, placed since the send, not already another row's (lead B21–B23)", async () => {
    const seeds: [string, (w: World) => void][] = [
      ["a BUY", (w) => w.up.state.tossOrders.push(fakeOrder({ side: "BUY" }, w.h.clock.t))],
      ["another quantity", (w) => w.up.state.tossOrders.push(fakeOrder({ quantity: "46" }, w.h.clock.t))],
      ["another row's", (w) => {
        w.up.state.tossOrders.push(fakeOrder({}, w.h.clock.t, "tso-00000077"));
        const mine = row(w);
        idb.insertRealOrder(w.h.db, { ...mine, id: "io_other", client_order_id: "mOTHER", rule_id: "ir_other", toss_order_id: "tso-00000077", state: "filled", market_day: null, check_at: null, message_id: null, created_at: mine.created_at - 60_000 });
      }],
    ];
    for (const [, seed] of seeds) {
      const w = await sent(["drop", "drop"]);
      seed(w);
      await beatAt(w, ET(10, 5, DAY, 30));
      expect(row(w).state).toBe("searching");
      for (let t = 60; t < 300; t += 30) await beatAt(w, ET(10, 5, DAY, t));
      await beatAt(w, ET(10, 10));
      expect(row(w)).toMatchObject({ state: "unknown", toss_order_id: null });
    }
    // the same seed as a SELL of the same quantity: adopted
    const w = await sent(["drop", "drop"]);
    w.up.state.tossOrders.push(fakeOrder({}, w.h.clock.t, "tso-00000088"));
    await beatAt(w, ET(10, 5, DAY, 30));
    await beatAt(w, ET(10, 6));
    expect(row(w)).toMatchObject({ state: "submitted", toss_order_id: "tso-00000088" });
  });

  test("a 5xx is never resent: searched for, then unknown with its own words", async () => {
    const w = await sent([{ status: 500, code: "internal-error" }]);
    expect(posts(w)).toHaveLength(1);
    expect(card(w).state).toBe("unknown");
    for (let s = 30; s <= 300; s += 30) await beatAt(w, ET(10, 5, DAY, s));
    expect(card(w).why).toBe("토스증권이 오류로 답해서, 주문이 들어갔는지 알 수 없어요.");
    expect(posts(w)).toHaveLength(1);
  });

  test("a 403 is never resent: failed with the allowed IP, an hour's pause", async () => {
    const w = await sent([{ status: 403 }]);
    await beatAt(w, ET(10, 6));
    expect(posts(w)).toHaveLength(1);
    expect(card(w)).toMatchObject({ state: "failed", title: "손절 주문이 되지 않았어요", reason: { code: "ip_not_allowed", text: "토스증권이 이 서버의 접속을 막았어요(허용 IP).", ip: "203.0.113.7" }, glyph: "fail" });
    expect(card(w).notes).toEqual(["토스증권 설정에서 이 IP를 다시 허용해 주세요.", "주문을 다시 내지 않았어요.", INTRADAY_ONLY]);
    expect(idb.getSettings(w.h.db, w.uid)?.toss_paused_until).toBe(ET(10, 5) + 3_600_000);
    expect(banners(w)).toEqual(["실제 · SOXL 손절 주문 안 됨"]);
  });

  test("a 429 is failed; a rejection keeps Toss's message as one safe line; neither is resent", async () => {
    const r429 = await sent([{ status: 429 }]);
    expect(card(r429)).toMatchObject({ state: "failed", reason: { code: "rate_limited", text: "토스증권이 잠시 요청을 막아서 주문이 들어가지 않았어요." } });
    const rlo = String.fromCharCode(0x202e);
    const rej = await sent([{ status: 422, code: "stock-restricted", message: `해당 종목은${rlo} 현재\n주문이 제한되어 있습니다.` }]);
    expect(card(rej)).toMatchObject({ state: "failed", reason: { code: "rejected", text: "토스증권이 주문을 거절했어요" } });
    expect(card(rej).notes).toEqual(["해당 종목은 현재 주문이 제한되어 있습니다.", "주문을 다시 내지 않았어요.", INTRADAY_ONLY]);
    for (const w of [r429, rej]) {
      await beatAt(w, ET(10, 6));
      expect(posts(w)).toHaveLength(1);
    }
  });

  test("a 401: once more with a new token and the same body; twice: failed auth", async () => {
    const once = await sent([{ status: 401 }]);
    expect(posts(once)).toHaveLength(2);
    expect(posts(once)[0]!.auth).not.toBe(posts(once)[1]!.auth);
    expect(new Set(bodies(once)).size).toBe(1);
    expect(card(once).state).toBe("submitted");
    const twice = await sent([{ status: 401 }, { status: 401 }]);
    expect(posts(twice)).toHaveLength(2);
    expect(card(twice)).toMatchObject({ state: "failed", reason: { code: "auth", text: "토스증권 연결이 끊겨서 주문이 들어가지 않았어요." } });
    expect(card(twice).notes).toEqual(["투자 설정에서 토스증권 연결을 확인해 주세요.", "주문을 다시 내지 않았어요.", INTRADAY_ONLY]);
  });

  test("a 409 that is not request-in-progress is a rejection with Toss's message, not resent (lead B28)", async () => {
    const w = await sent([{ status: 409, code: "order-conflict", message: "이미 처리 중인 주문이 있습니다." }]);
    expect(row(w)).toMatchObject({ state: "failed", reason: "rejected", reason_text: "이미 처리 중인 주문이 있습니다." });
    await beatAt(w, ET(10, 6));
    expect(posts(w)).toHaveLength(1);
  });

  test("a 200 with no order id is no answer: sent once more with the same body, never submitted without an id (lead B29)", async () => {
    const w = await sent(["noid"]);
    expect(row(w)).toMatchObject({ state: "sending", toss_order_id: null, sends: 1 });
    await beatAt(w, ET(10, 5, DAY, 30));
    expect(posts(w)).toHaveLength(2);
    expect(new Set(bodies(w)).size).toBe(1);
    expect(row(w)).toMatchObject({ state: "submitted", toss_order_id: "tso-00000001" });
  });

  test("after a send with no answer, a refusal of the resend is not taken as Toss's word: searched for", async () => {
    for (const again of [[{ status: 429 }], [{ status: 401 }, { status: 401 }], [{ status: 500 }]] as OrderAnswer[][]) {
      const w = await sent(["lost", ...again]);
      await beatAt(w, ET(10, 5, DAY, 30));
      expect(row(w).state).toBe("searching");
      await beatAt(w, ET(10, 6));
      // the first send went in: found and followed (a 429 pause does not stop following an order)
      expect(card(w).state).toBe("submitted");
      expect(w.up.state.tossOrders).toHaveLength(1);
      expect(posts(w).length).toBe(1 + again.length);
    }
    // a 403 on the resend: Toss refuses every call for the hour, so the order cannot be looked for: unknown
    const ip = await sent(["lost", { status: 403 }]);
    await beatAt(ip, ET(10, 5, DAY, 30));
    for (let s = 60; s <= 300; s += 30) await beatAt(ip, ET(10, 5, DAY, s));
    expect(card(ip)).toMatchObject({ state: "unknown", why: "토스증권이 답하지 않아서, 주문이 들어갔는지 알 수 없어요." });
    expect(w403Reads(ip)).toHaveLength(0);
    expect(posts(ip)).toHaveLength(2);
  });
});

// ───────────────────────────── calls ─────────────────────────────

describe("invest real orders: calls (DD 2044 §3)", () => {
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
  const said = () => twilio.map((t) => (t.get("Twiml") ?? "").replace(/<[^>]+>/g, ""));

  test("one call per outcome: none for submitted or a wait; one for filled, with the real words first", async () => {
    const w = await world({ twilio: true });
    writeMyPhone(w.h.app.core, w.uid, { e164: "+821012345678", verifiedAt: w.h.clock.t, codeHash: null, codeExpiresAt: 0, attempts: 0 });
    await setup(w, { plan: [{ status: "FILLED", filled: 47, avg: 25.58, at: ET(10, 11) }], stop: 25.8 });
    w.up.state.tossPrices.set("SOXL", { price: 26 });
    await tickAt(w, ET(10, 0));
    // a 429 on the sellable read: the hit waits, with no call (DD 2046-b)
    w.up.state.pathStatus.set("/api/v1/sellable-quantity", [429]);
    w.up.state.tossPrices.set("SOXL", { price: 25.4 });
    await tickAt(w, ET(10, 5));
    expect(card(w).state).toBe("waiting");
    await w.h.app.core.idle();
    expect(twilio).toHaveLength(0);
    // sent after the pause: submitted, still no call
    await beatAt(w, ET(10, 10));
    expect(card(w).state).toBe("submitted");
    expect(twilio).toHaveLength(0);
    await beatAt(w, ET(10, 10, DAY, 30));
    expect(twilio).toHaveLength(1);
    const name = w.h.db.userById(w.uid)!.agent_name;
    expect(said()[0]).toContain(`${ieyo(name)}. 실제 주문으로 SOXL 손절 매도가 체결됐어요. 47주를 평균 25.58달러에 팔았어요. 손절선 25.8달러보다 0.22달러 낮고, 평단 대비 14.73% 손실이에요. ${MARKET}`);
    expect(card(w).call).toMatchObject({ ok: true });
    expect(said()[0]).not.toMatch(/면책|권유|사세요|파세요/);
  });

  test("a skip calls; a planned order dropped by the person does not", async () => {
    const w = await world({ twilio: true });
    writeMyPhone(w.h.app.core, w.uid, { e164: "+821012345678", verifiedAt: w.h.clock.t, codeHash: null, codeExpiresAt: 0, attempts: 0 });
    const { r } = await setup(w, { confirm: null });
    await hit(w, ET(10, 0), ET(10, 5));
    expect(said()).toHaveLength(1);
    expect(said()[0]).toContain("SOXL이 손절선 27달러 아래 26.8달러에 닿았지만 실제 주문을 내지 않았어요. 실제 매도로 확인하지 않은 손절이에요. 47주를 그대로 갖고 있어요.");
    idb.confirmReal(w.h.db, w.uid, r.id, r.rev, 47, w.h.clock.t);
    idb.updateRuleWatch(w.h.db, r.id, r.rev, { state: "armed", hit_at: null, hit_seq: 1, cleared_at: null, paused_at: null, seen_slot: null }, w.h.clock.t);
    w.up.state.tossPrices.set("SOXL", { price: 27.5 });
    await hit(w, ET(15, 55), ET(16, 5));
    expect(card(w).state).toBe("scheduled");
    expect(said()).toHaveLength(2);
    w.h.app.core.invest.ruleChanged(w.uid, r.id, true);
    await w.h.app.core.idle();
    expect(said()).toHaveLength(2);
  });
});

// ───────────────────────────── the words, one by one ─────────────────────────────

describe("invest real orders: banners and call lines (DD 2042-b §4, 2044 §2–3)", () => {
  const base: idb.RealOrderRow = {
    id: "io_x", user_id: "u", rule_id: "r", rule_rev: 1, symbol: "SOXL", client_order_id: "mx", toss_order_id: "tso-00004821", state: "filled", reason: null, reason_text: null,
    basis: "intraday", intraday_only: 0, observed_price: 25.4, observed_at: ET(10, 5), source: "toss", stop_price: 25.8, avg_cost: 30.5, confirmed_qty: 47, sellable: 47, qty: 47,
    fraction_left: null, filled_qty: 47, avg_price: 25.58, market_day: DAY, due_at: null, sent_at: ET(10, 5), sends: 1, check_at: null, check_until: null, filled_at: ET(10, 6),
    stopped_at: null, message_id: null, created_at: ET(10, 5), updated_at: ET(10, 6),
  };
  const line = (o: Partial<idb.RealOrderRow>) => realStopCallLine("모시", { ...base, ...o }, "{④}");

  test("call lines", () => {
    expect(line({})).toBe("모시예요. 실제 주문으로 SOXL 손절 매도가 체결됐어요. 47주를 평균 25.58달러에 팔았어요. 손절선 25.8달러보다 0.22달러 낮고, 평단 대비 16.13% 손실이에요. {④}");
    // filled above the stop (DD 2314 D19): the row and the call say it is higher
    expect(line({ avg_price: 25.9 })).toContain("손절선 25.8달러보다 0.1달러 높고, 평단 대비 15.08% 손실이에요.");
    expect(realStopCard({ ...base, avg_price: 25.9 }, { ip: null }).rows).toContainEqual({ label: "손절선 대비", value: "+$0.10" });
    // a zero-sellable skip carries no quantity: the call never says what is kept (DD 2314 D9), with a holdings read too
    expect(realStopCallLine("모시", { ...base, state: "skipped", reason: "zero_sellable", sellable: null }, "{④}", 47)).toBe("모시예요. SOXL이 손절선 25.8달러 아래 25.4달러에 닿았지만 실제 주문을 내지 않았어요. 팔 수 있는 수량이 0주예요. {④}");
    expect(line({ state: "failed", reason: "auth" })).toContain("되지 않았어요. 토스증권 연결이 끊겼어요. 앱의 투자 설정에서 확인해 주세요. 주문을 다시 내지 않았어요.");
    expect(line({ state: "failed", reason: "toss_down" })).toContain("되지 않았어요. 토스증권에 연결하지 못했어요. 주문을 다시 내지 않았어요.");
    expect(line({ state: "skipped", reason: "sellable_unknown" })).toContain("실제 주문을 내지 않았어요. 토스증권에서 팔 수 있는 수량을 받지 못했어요.");
    expect(line({ state: "failed", reason: "ip_not_allowed" })).toBe("모시예요. SOXL이 손절선 25.8달러 아래 25.4달러에 닿아서 실제 손절 주문을 냈지만 되지 않았어요. 토스증권이 접속을 막았어요. 앱에서 허용 IP를 확인해 주세요. 주문을 다시 내지 않았어요. 47주를 그대로 갖고 있어요. {④}");
    expect(line({ state: "failed", reason: "rate_limited" })).toContain("되지 않았어요. 토스증권이 잠시 요청을 막았어요. 주문을 다시 내지 않았어요.");
    expect(line({ state: "skipped", reason: "early_close" })).toBe("모시예요. SOXL이 손절선 25.8달러 아래 25.4달러에 닿았지만 실제 주문을 내지 않았어요. 조기 폐장일이에요. 47주를 그대로 갖고 있어요. {④}");
    expect(line({ state: "skipped", reason: "server_off" })).toContain("실제 주문을 내지 않았어요. 실제 주문이 잠시 멈춰 있어요. 47주를");
    expect(line({ state: "scheduled", basis: "close" })).toBe("모시예요. SOXL 실제 손절 주문 예정이에요. 손절선 25.8달러 아래 25.4달러로 마감해서, 다음 거래일 개장 15분 뒤에 47주를 시장가로 팔아요. 실제 주문을 끄면 팔지 않아요. {④}");
    expect(line({ state: "scheduled", basis: "late", observed_price: 24.4 })).toBe("모시예요. SOXL 실제 손절 주문 예정이에요. 마감 직전에 장중 기준 가격 아래 24.4달러에 닿아서, 다음 거래일 개장 15분 뒤에 47주를 시장가로 팔아요. 실제 주문을 끄면 팔지 않아요. {④}");
    expect(line({ state: "scheduled", basis: "close", qty: null, confirmed_qty: null })).toContain("다음 거래일 개장 15분 뒤에 시장가로 팔아요.");
    expect(line({ state: "unknown", reason: "no_answer" })).toBe("모시예요. SOXL 실제 손절 주문을 냈지만 결과를 확인하지 못했어요. 토스증권 앱의 주문 내역에서 확인해 주세요. 같은 주문을 다시 내지 않았어요. SOXL은 25.4달러, 손절선은 25.8달러예요. {④}");
    expect(line({ state: "partial_closed", filled_qty: 30 })).toBe("모시예요. SOXL 실제 손절 주문 47주 중 30주가 평균 25.58달러에 체결됐고, 남은 17주는 마감에 취소됐어요. 17주를 그대로 갖고 있어요. {④}");
    // the holdings read when Toss's sellable quantity was not asked
    expect(realStopCallLine("모시", { ...base, state: "skipped", reason: "not_confirmed", sellable: null, qty: null, confirmed_qty: null }, "{④}", 47)).toContain("실제 매도로 확인하지 않은 손절이에요. 47주를 그대로 갖고 있어요. {④}");
  });

  test("banners: the push titles, `실제 · ` first; none for a wait, a step or the person's own drop", () => {
    const t = (o: Partial<idb.RealOrderRow>) => realStopBanner({ ...base, ...o })?.title ?? null;
    expect([t({ state: "scheduled" }), t({ state: "submitted" }), t({}), t({ state: "partial_closed" }), t({ state: "failed" }), t({ state: "skipped" }), t({ state: "unknown" })]).toEqual([
      "실제 · SOXL 손절 주문 예정",
      "실제 · SOXL 손절 주문 냄",
      "실제 · SOXL 손절 체결",
      "실제 · SOXL 손절 일부 체결",
      "실제 · SOXL 손절 주문 안 됨",
      "실제 · SOXL 손절 주문 건너뜀",
      "실제 · SOXL 손절 주문 확인 필요",
    ]);
    expect([t({ state: "waiting" }), t({ state: "sending" }), t({ state: "searching" }), t({ state: "partial" }), t({ state: "canceled" })]).toEqual([null, null, null, null, null]);
  });

  test("the order window, the quantity text, Toss's message line", () => {
    expect(orderWindow("US", ET(9, 29))).toMatchObject({ kind: "next", due: ET(9, 45) });
    expect(orderWindow("US", ET(9, 30)).kind).toBe("now");
    expect(orderWindow("US", ET(15, 57, DAY, 59)).kind).toBe("now");
    expect(orderWindow("US", ET(15, 58))).toMatchObject({ kind: "next", due: ET(9, 45, NEXT) });
    expect(orderWindow("US", ET(10, 0, "2026-11-27")).kind).toBe("early_close");
    expect(orderWindow("US", ET(12, 0, "2026-11-28"))).toMatchObject({ kind: "next", due: ET(9, 45, DAY) });
    expect([qtyText(47), qtyText(47.35), qtyText(0.123456789), qtyText(1e-7)]).toEqual(["47", "47.35", "0.123457", "0"]);
    expect(oneLine(`a\u0000b`)).toBe("a b");
    expect(oneLine("x".repeat(200))!.length).toBe(120);
    expect(oneLine("  ")).toBeUndefined();
  });

  test("the vault's purpose follows the mode (team-lead 2040 12)", async () => {
    const w = await world();
    await connectToss(w);
    expect(w.purposes.at(-1)).toBe(TOSS_PURPOSE_READ);
    const n = w.purposes.length;
    idb.updateSettings(w.h.db, w.uid, { mode: "real", real_since: w.h.clock.t }, w.h.clock.t);
    for (const t of w.up.tokens.keys()) w.up.state.tossRevoked.add(t);
    await w.h.app.core.invest.checkToss(w.uid, { floor: false });
    expect(w.purposes.slice(n)).toEqual([TOSS_PURPOSE_REAL]);
  });
});

// ───────────────────────────── G8 in the source ─────────────────────────────

describe("invest real orders: G8 in the source (team-lead 2040 9)", () => {
  const SRC = join(import.meta.dir, "../src");
  const files = (dir: string): string[] => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? files(join(dir, n)) : n.endsWith(".ts") ? [join(dir, n)] : []));
  const all = files(SRC).map((f) => ({ f: f.slice(SRC.length + 1), s: readFileSync(f, "utf8") }));
  const count = (re: RegExp) => all.flatMap(({ f, s }) => [...s.matchAll(re)].map(() => f));

  test("one SELL literal, no BUY, one POST to the orders path, one caller of sellStop, no cancel or modify", () => {
    expect(count(/side: "SELL"/g)).toEqual(["invest/toss.ts"]);
    expect(count(/"BUY"/g)).toEqual([]);
    expect(count(/\/api\/v1\/orders`/g)).toEqual(["invest/toss.ts"]);
    expect(count(/\.sellStop\(/g)).toEqual(["invest/orders.ts"]);
    expect(count(/conditional-orders|\/cancel\b|\/modify\b|orderAmount|confirmHighValueOrder/g).filter((f) => f.startsWith("invest/"))).toEqual([]);
  });
});
