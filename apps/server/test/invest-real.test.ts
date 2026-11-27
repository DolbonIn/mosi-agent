/**
 * B3b: turning real stop orders on and off (team-lead 2040 10·11·13, 2342; DD 1935 §3-4 · §3-5, 2042-b §2 · §3 · §5,
 * 2044 §4 · §5, 2314 §6). The preview, the signed enable, the disable, where confirmations are written (enable, a
 * real-mode rule save, a real-mode proposal apply) and nowhere else, the blockers and their sentence. Toss is
 * test/fake-toss.ts (synthetic bodies); nothing real is called, and no real order exists.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { InvestRealPreview, InvestRuleChangeCard, InvestSettingsView, InvestStopCard, ServerEvent } from "@pickle/protocol";
import type { CredentialAccess, ToolContext, ToolDef } from "@pickle/agent";
import { etToEpoch } from "../src/invest/calendar.ts";
import * as idb from "../src/invest/db.ts";
import { REAL_BLOCKER_TEXT, REAL_ERRORS, REAL_PREVIEW_REUSE_MS, REAL_PREVIEW_TTL_MS } from "../src/invest/real.ts";
import { investTools } from "../src/invest/tools.ts";
import { writeMyPhone } from "../src/phone.ts";
import { BOGUS_TOSS_SECRET, FAKE_TOSS_BASE, makeInvestUpstream, syntheticBars } from "./fake-toss.ts";
import { makeDevice, makeFakeVault, makeHarness, type Harness, type TestDevice } from "./helpers.ts";

const DAY = "2026-11-30"; // a Monday, a full session
const ET = (h: number, m: number, day = DAY, s = 0) => etToEpoch(day, h, m) + s * 1000;
const TWILIO = { accountSid: "AC123", authToken: "tok", from: "+15550000000" };

type Up = ReturnType<typeof makeInvestUpstream>;
interface World {
  h: Harness;
  up: Up;
  uid: string;
  token: string;
  device: TestDevice;
  thread: string;
  events: ServerEvent[];
  pushes: { title: string }[];
  /** set to hold a Toss call until the promise it returns settles (by path) */
  hold: { fn: null | ((path: string) => Promise<void>) };
}

const worlds: World[] = [];
afterEach(async () => {
  while (worlds.length) await worlds.pop()!.h.close();
  twilio = [];
});

// calls never leave: Twilio answers here, anything else on the global fetch is refused (Toss is investFetch)
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

async function world(o: { orders?: boolean; twilio?: boolean } = {}): Promise<World> {
  const up = makeInvestUpstream();
  const hold: World["hold"] = { fn: null };
  const h = await makeHarness({
    now: ET(9, 0),
    config: { invest: { sources: false, tossBase: FAKE_TOSS_BASE, outboundIp: "203.0.113.7", orders: o.orders ?? true }, ...(o.twilio ? { twilio: TWILIO } : {}) },
    deps: ({ vault }) => ({
      investFetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        if (hold.fn) await hold.fn(new URL(input instanceof Request ? input.url : String(input)).pathname);
        return up.fetch(input, init);
      }) as typeof fetch,
      vault: {
        ...vault,
        access(userId, a) {
          const acc = vault.access(userId, a);
          const use: CredentialAccess["use"] = (id, p, fn) => acc.use(id, p, () => fn({ ...BOGUS_TOSS_SECRET }));
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
    if (u === uid) pushes.push(m as { title: string });
    return 0;
  };
  const w = { h, up, uid, token: me.token, device: me.device, thread: me.session.mainThreadId, events, pushes, hold };
  worlds.push(w);
  return w;
}

const api = async <T = unknown>(w: World, method: string, path: string, body?: unknown, token = w.token): Promise<{ status: number; body: T }> => {
  const res = await w.h.req(method, path, { token, body });
  return { status: res.status, body: (await res.json()) as T };
};
type Err = { error: string; message: string; preview?: InvestRealPreview; realBlockerText?: string };

async function connectToss(w: World) {
  const envelope = { v: 1, alg: "ECDH-P256+HKDF-SHA256+A256GCM", kid: "kid-test", epk: { kty: "EC" }, iv: "aXY", ct: "Y3Q", aad: `${w.uid}:toss-investment:token` };
  expect((await api(w, "POST", "/api/credentials", { service: "toss-investment", label: "토스증권", kind: "token", hint: "계좌 1개", keepFor: "forever", envelope })).status).toBe(201);
  await w.h.app.core.idle();
}

interface Held {
  symbol: string;
  qty: number;
  stop: number;
  sellable?: number;
  buffer?: number;
  /** the daily range: wide (4) → the stop is judged on the close and intraday; narrow (0.5) → intraday only */
  range?: number;
}

/** Toss holdings and a sell stop per symbol (made in mock mode); returns the rules by symbol */
async function setup(w: World, list: Held[]): Promise<Record<string, { id: string; rev: number }>> {
  w.up.state.tossHoldings = list.filter((x) => x.qty > 0).map((x) => ({ symbol: x.symbol, quantity: x.qty, averagePrice: x.stop + 3 }));
  for (const x of list) {
    w.up.state.tossSellable.set(x.symbol, x.sellable ?? x.qty);
    w.up.state.tossPrices.set(x.symbol, { price: x.stop + 0.5 });
    w.up.state.tossCandles.set(x.symbol, syntheticBars(DAY, 30, x.stop + 1, x.range ?? 4));
  }
  await connectToss(w);
  const out: Record<string, { id: string; rev: number }> = {};
  for (const x of list) {
    expect((await api(w, "POST", "/api/invest/watchlist", { symbol: x.symbol })).status).toBeLessThan(300);
    const r = await api<{ id: string; rev: number }>(w, "POST", "/api/invest/rules", { draft: { symbol: x.symbol, kind: "stop", price: x.stop, action: "sell", ...(x.buffer ? { bufferPct: x.buffer } : {}) } });
    expect(r.status).toBe(201);
    out[x.symbol] = r.body;
  }
  return out;
}

const SOXL: Held = { symbol: "SOXL", qty: 47, stop: 27 };
const preview = (w: World) => api<InvestRealPreview & Err>(w, "POST", "/api/invest/real/preview");
async function signed(w: World, previewId: string, o: { device?: TestDevice; nonce?: string; over?: string } = {}) {
  const nonce = o.nonce ?? `n-${Math.random().toString(36).slice(2)}`;
  const signature = await (o.device ?? w.device).sign(`approve:${o.over ?? previewId}:${nonce}`);
  return { previewId, deviceId: w.device.id, nonce, signature };
}
const enable = async (w: World, body: unknown) => api<InvestSettingsView & Err>(w, "POST", "/api/invest/real/enable", body);
async function turnOn(w: World): Promise<InvestRealPreview> {
  const p = await preview(w);
  expect(p.status).toBe(200);
  const r = await enable(w, await signed(w, p.body.previewId));
  expect(r.status).toBe(200);
  expect(r.body.mode).toBe("real");
  return p.body;
}
const mode = (w: World) => idb.getSettings(w.h.db, w.uid)?.mode;
const confirms = (w: World) =>
  (w.h.db.sql.query("SELECT rule_id, rev, qty FROM invest_real_confirms WHERE user_id = $u ORDER BY rule_id").all({ u: w.uid }) as { rule_id: string; rev: number; qty: number }[]).map((c) => ({ ...c }));
const sellableReads = (w: World) => w.up.calls.filter((c) => c.path.startsWith("/api/v1/sellable-quantity")).length;
const posts = (w: World) => w.up.calls.filter((c) => c.method === "POST" && c.path === "/api/v1/orders");
const banners = (w: World) => w.events.filter((e) => e.type === "notification");
function investThread(w: World): string | null {
  return idb.getSettings(w.h.db, w.uid)?.thread_id ?? null;
}
function eventRows(w: World): { text: string; llm: string }[] {
  const tid = investThread(w);
  if (!tid) return [];
  return (w.h.db.sql.query("SELECT text, llm_json FROM messages WHERE thread_id = $t AND role = 'event' ORDER BY created_at, id").all({ t: tid }) as { text: string; llm_json: string }[]).map((r) => ({
    text: r.text,
    llm: (JSON.parse(r.llm_json) as { content: string }[])[0]!.content,
  }));
}
function stopCards(w: World): InvestStopCard[] {
  const tid = investThread(w);
  if (!tid) return [];
  const rows = w.h.db.sql.query("SELECT cards_json FROM messages WHERE thread_id = $t ORDER BY created_at, id").all({ t: tid }) as { cards_json: string }[];
  return rows.flatMap((r) => JSON.parse(r.cards_json) as InvestStopCard[]).filter((c) => c.type === "invest_stop");
}
const realRows = (w: World) => w.h.db.sql.query("SELECT * FROM invest_real_orders ORDER BY created_at, rowid").all() as idb.RealOrderRow[];
async function tickAt(w: World, at: number) {
  w.h.clock.t = at;
  await w.h.app.core.invest.tick();
  await w.h.app.core.idle();
}
async function hit(w: World, armAt: number, hitAt: number, symbol = "SOXL", price = 26.8) {
  await tickAt(w, armAt);
  w.up.state.tossPrices.set(symbol, { price });
  await tickAt(w, hitAt);
}

// ───────────────────────────── blockers ─────────────────────────────

describe("invest real orders on: the blockers (DD 2044 §4, team-lead 2342 6)", () => {
  test("the server switch off: orders_off first, its sentence; preview and enable 409 real_blocked, Toss not asked", async () => {
    const w = await world({ orders: false });
    await setup(w, [SOXL]);
    const v = await w.h.app.core.invest.settingsView(w.uid);
    expect(v.realBlockers).toEqual(["orders_off"]);
    expect(v.realBlockerText).toBe("실제 주문은 아직 준비 중이라 켤 수 없어요.");
    const before = sellableReads(w);
    const p = await preview(w);
    expect(p.status).toBe(409);
    expect(p.body).toMatchObject({ error: "real_blocked", message: "그사이 실제 주문을 켤 수 없게 됐어요. 실제 주문은 아직 준비 중이라 켤 수 없어요.", realBlockerText: "실제 주문은 아직 준비 중이라 켤 수 없어요." });
    // a signed enable with a made-up preview: still the blocker, and mode stays mock
    const e = await enable(w, await signed(w, "ip_whatever"));
    expect(e.status).toBe(409);
    expect(e.body.error).toBe("real_blocked");
    expect(mode(w)).toBe("mock");
    expect(sellableReads(w)).toBe(before);
  });

  test("the first that holds, in DD 2044 §4's order; a Toss pause blocks with no Toss read", async () => {
    const w = await world();
    const v0 = await w.h.app.core.invest.settingsView(w.uid);
    expect(v0.realBlockers).toEqual(["toss_not_connected"]);
    expect(v0.realBlockerText).toBe("토스증권을 연결하면 켤 수 있어요.");
    await setup(w, [SOXL]);
    const db = w.h.db;
    const now = w.h.clock.t;
    expect((await w.h.app.core.invest.settingsView(w.uid)).realBlockers).toEqual([]);
    idb.updateSettings(db, w.uid, { toss_ok_at: null }, now);
    let v = await w.h.app.core.invest.settingsView(w.uid);
    expect(v.realBlockers).toEqual(["toss_never_ok"]);
    expect(v.realBlockerText).toBe("토스증권 시세 확인이 한 번 성공하면 켤 수 있어요.");
    // a 429 pause: toss_paused, said before never-ok
    idb.updateSettings(db, w.uid, { toss_error: "rate_limited", toss_error_at: now, toss_paused_until: now + 300_000 }, now);
    v = await w.h.app.core.invest.settingsView(w.uid);
    expect(v.realBlockers).toEqual(["toss_never_ok", "toss_paused"]);
    expect(v.realBlockerText).toBe("토스증권 접속이 풀리면 켤 수 있어요.");
    const before = sellableReads(w);
    expect((await preview(w)).status).toBe(409);
    expect(sellableReads(w)).toBe(before);
    // the allowed IP
    idb.updateSettings(db, w.uid, { toss_ok_at: now, toss_error: "ip_not_allowed", toss_paused_until: now + 3_600_000 }, now);
    v = await w.h.app.core.invest.settingsView(w.uid);
    expect(v.realBlockers).toEqual(["toss_ip_blocked"]);
    expect(v.realBlockerText).toBe(REAL_BLOCKER_TEXT.toss_ip_blocked);
    expect((await preview(w)).status).toBe(409);
    expect(sellableReads(w)).toBe(before);
  });
});

// ───────────────────────────── the sheet ─────────────────────────────

describe("invest real orders on: the sheet (DD 1935 §3-5, 2042-b §2 · §3, 2044 §4)", () => {
  test("held symbols' watched sell stops, per rule, with Toss's quantity; the not-held line; the buffer foot; the conditions", async () => {
    const w = await world({ twilio: true });
    const r = await setup(w, [SOXL, { symbol: "TQQQ", qty: 3, stop: 50, buffer: 7 }, { symbol: "SOXS", qty: 0, stop: 10 }, { symbol: "QQQ", qty: 5, stop: 400, range: 0.5 }]);
    // not targets: a paused sell stop and a stop that calls
    const paused = (await api<{ id: string }>(w, "POST", "/api/invest/rules", { draft: { symbol: "SOXL", kind: "stop", price: 20, action: "sell" } })).body;
    w.h.db.sql.query("UPDATE invest_rules SET state = 'paused', paused_at = 1 WHERE id = $id").run({ id: paused.id });
    await api(w, "POST", "/api/invest/rules", { draft: { symbol: "TQQQ", kind: "stop", price: 45, action: "call" } });
    const p = await preview(w);
    expect(p.status).toBe(200);
    // by symbol, as the rule list
    // an intraday-only stop's second line is the cards' (DD 0010-b 1)
    expect(p.body.targets.map((t) => [t.ruleId, t.rev, t.head, t.line, t.note, t.qty.text])).toEqual([
      [r.QQQ!.id, 1, "QQQ · 5주 전량", "장중 $400.00 이하", "지금은 장중 가격만으로 판단해요.", "5주"],
      [r.SOXL!.id, 1, "SOXL · 47주 전량", "종가 $27.00 이하 또는 장중 $25.65 이하", null, "47주"],
      [r.TQQQ!.id, 1, "TQQQ · 3주 전량", "종가 $50.00 이하 또는 장중 $46.50 이하 · 장중 버퍼 7%(직접 정함)", null, "3주"],
    ]);
    expect(p.body.notHeld).toBe("보유하지 않아 팔지 않아요: SOXS");
    expect(p.body.bufferFoot).toBe("장중 기준 가격은 손절선의 5% 아래예요. 원문에 숫자가 없어서 정한 운영 기본값이에요.");
    expect(p.body.empty).toBeNull();
    expect(p.body.conditions).toEqual([
      "정규장 시간에만 시장가로 내요. 조기 폐장일과 장 밖에서는 내지 않아요.",
      "종가 기준은 마감 뒤에야 알 수 있어서, 다음 거래일 개장 15분 뒤에 팔아요. 장중 기준 가격 아래로 내려가면 그때 바로 팔아요.",
      "체결 가격은 보장되지 않아요. 손절선보다 낮게 팔릴 수 있어요.",
      "켠 뒤에 보유가 늘어도, 여기서 확인한 수량까지만 팔아요.",
      "사는 주문, 익절 매도, 손절선 변경은 하지 않아요.",
      "체결되면 채팅으로 알려요. 번호를 인증하면 전화로도 알려요.",
    ]);
    expect(p.body.expiresAt - w.h.clock.t).toBe(10 * 60_000);
    // one Toss read per symbol with a sell stop (SOXL's two rules share one)
    expect(w.up.calls.filter((c) => c.path.startsWith("/api/v1/sellable-quantity")).map((c) => c.path.split("=")[1]).sort()).toEqual(["QQQ", "SOXL", "SOXS", "TQQQ"]);
    // not verified with the 손절 결과 call off: the verifying sentence still (calls could not go out anyway; DD 0010-b 2)
    idb.updateSettings(w.h.db, w.uid, { calls_json: JSON.stringify({ stopResult: false }) }, w.h.clock.t);
    w.h.clock.t += REAL_PREVIEW_REUSE_MS + 1;
    expect((await preview(w)).body.conditions.at(-1)).toBe("체결되면 채팅으로 알려요. 번호를 인증하면 전화로도 알려요.");
    // verified, the call off: where to turn it on
    writeMyPhone(w.h.app.core, w.uid, { e164: "+821012345678", verifiedAt: w.h.clock.t, codeHash: null, codeExpiresAt: 0, attempts: 0 });
    w.h.clock.t += REAL_PREVIEW_REUSE_MS + 1;
    expect((await preview(w)).body.conditions.at(-1)).toBe("체결되면 채팅으로 알려요. 투자 설정에서 손절 결과 전화를 켜면 전화로도 알려요.");
    // verified, the call on: calls
    idb.updateSettings(w.h.db, w.uid, { calls_json: JSON.stringify({ stopResult: true }) }, w.h.clock.t);
    w.h.clock.t += REAL_PREVIEW_REUSE_MS + 1;
    expect((await preview(w)).body.conditions.at(-1)).toBe("체결되면 전화와 채팅으로 알려요.");
  });

  test("three symbols or more: the event row names the sheet's first and how many more (DD 0010-b 4)", async () => {
    const w = await world();
    await setup(w, [SOXL, { symbol: "TQQQ", qty: 3, stop: 50 }, { symbol: "QQQ", qty: 5, stop: 400 }]);
    const p = (await preview(w)).body;
    expect(p.targets.map((t) => t.symbol)).toEqual(["QQQ", "SOXL", "TQQQ"]);
    expect((await enable(w, await signed(w, p.previewId))).status).toBe(200);
    expect(eventRows(w)).toEqual([{ text: "실제 주문을 켰어요 · QQQ 5주 외 2종목", llm: "[투자 기록] 실제 주문 켬 · 대상 QQQ 5주, SOXL 47주, TQQQ 3주" }]);
  });

  test("a server that cannot place calls: condition 4 says chat alone, whatever the phone and the 손절 결과 call (DD 0055 §3)", async () => {
    const w = await world(); // no twilio
    await setup(w, [SOXL]);
    expect((await preview(w)).body.conditions.at(-1)).toBe("체결되면 채팅으로 알려요.");
    writeMyPhone(w.h.app.core, w.uid, { e164: "+821012345678", verifiedAt: w.h.clock.t, codeHash: null, codeExpiresAt: 0, attempts: 0 });
    idb.updateSettings(w.h.db, w.uid, { calls_json: JSON.stringify({ stopResult: false }) }, w.h.clock.t);
    w.h.clock.t += REAL_PREVIEW_REUSE_MS + 1;
    expect((await preview(w)).body.conditions.at(-1)).toBe("체결되면 채팅으로 알려요.");
  });

  test("no targets: the empty words and footnote, and it still turns on with no confirmation (lead 2040 10)", async () => {
    const w = await world();
    await setup(w, [{ symbol: "SOXS", qty: 0, stop: 10 }]);
    const p = await preview(w);
    expect(p.body.targets).toEqual([]);
    expect(p.body.empty).toEqual({ text: "지금은 손절 규칙이 있는 보유 종목이 없어요.", foot: "켠 뒤에 생기는 손절은 규칙 시트에서 길게 눌러 확인받아요." });
    expect(p.body.notHeld).toBe("보유하지 않아 팔지 않아요: SOXS");
    expect(p.body.bufferFoot).toBeNull();
    expect((await enable(w, await signed(w, p.body.previewId))).status).toBe(200);
    expect(mode(w)).toBe("real");
    expect(confirms(w)).toEqual([]);
    expect(eventRows(w)).toEqual([{ text: "실제 주문을 켰어요 · 지금은 대상 없음", llm: "[투자 기록] 실제 주문 켬 · 대상 없음" }]);
  });

  test("a live sheet is reused for 30 s with no Toss read; at most 6 in 10 minutes (429); a failed read is 503, no sheet", async () => {
    const w = await world();
    await setup(w, [SOXL]);
    const a = await preview(w);
    const reads = sellableReads(w);
    expect(reads).toBeGreaterThan(0);
    const b = await preview(w);
    expect(b.body.previewId).toBe(a.body.previewId);
    expect(sellableReads(w)).toBe(reads);
    for (let i = 0; i < 5; i++) {
      w.h.clock.t += REAL_PREVIEW_REUSE_MS + 1;
      expect((await preview(w)).status).toBe(200);
    }
    w.h.clock.t += REAL_PREVIEW_REUSE_MS + 1;
    const capped = await preview(w);
    expect(capped.status).toBe(429);
    expect(capped.body).toMatchObject({ error: "rate_limited", message: "요청이 많아요. 잠시 후 다시 시도해 주세요." });
    // the first one's ten minutes pass: room again
    w.h.clock.t = a.body.expiresAt + 1;
    expect((await preview(w)).status).toBe(200);
    // a read that fails
    w.h.clock.t += REAL_PREVIEW_REUSE_MS + 1;
    w.up.state.pathStatus.set("/api/v1/sellable-quantity", [500]);
    const n = (w.h.db.sql.query("SELECT COUNT(*) AS n FROM invest_previews WHERE kind = 'real'").get() as { n: number }).n;
    const down = await preview(w);
    expect(down.status).toBe(503);
    expect(down.body).toMatchObject({ error: "sellable_unknown", message: REAL_ERRORS.sellable_unknown });
    expect((w.h.db.sql.query("SELECT COUNT(*) AS n FROM invest_previews WHERE kind = 'real'").get() as { n: number }).n).toBe(n);
    // an answer with no quantity in it
    w.h.clock.t += REAL_PREVIEW_REUSE_MS + 1;
    w.up.state.tossSellable.set("SOXL", -1);
    expect((await preview(w)).status).toBe(503);
    w.up.state.tossSellable.set("SOXL", 47);
    // a 403 on the sheet's read: Toss's allowed-IP pause, a blocker from then on
    w.h.clock.t += REAL_PREVIEW_REUSE_MS + 1;
    w.up.state.pathStatus.set("/api/v1/sellable-quantity", [403, 403]); // once more with a new token, then the allowed IP
    expect((await preview(w)).status).toBe(503);
    const v = await w.h.app.core.invest.settingsView(w.uid);
    expect(v.realBlockers).toContain("toss_ip_blocked");
    expect(idb.getSettings(w.h.db, w.uid)!.toss_paused_until).toBe(w.h.clock.t + 3_600_000);
  });

  test("a stale enable's new sheet is one of the 6: past them, 429 and no new sheet", async () => {
    const w = await world();
    await setup(w, [SOXL]);
    const first = (await preview(w)).body;
    for (let i = 0; i < 5; i++) {
      w.h.clock.t += REAL_PREVIEW_REUSE_MS + 1;
      expect((await preview(w)).status).toBe(200);
    }
    w.up.state.tossSellable.set("SOXL", 40);
    const res = await enable(w, await signed(w, first.previewId));
    expect([res.status, res.body.error]).toEqual([429, "rate_limited"]);
    expect(res.body.preview).toBeUndefined();
    expect(mode(w)).toBe("mock");
  });
});

// ───────────────────────────── enable ─────────────────────────────

describe("invest real orders on: the signed enable (lead 2040 10, 2342 1)", () => {
  test("signed over approve:<previewId>:<nonce>: real mode, each target confirmed at its rev and quantity, others gone; the event row", async () => {
    const w = await world();
    const r = await setup(w, [SOXL, { symbol: "TQQQ", qty: 3, stop: 50 }]);
    // a confirmation left from before (another rule): enable replaces the person's confirmations with its own
    const other = (await api<{ id: string }>(w, "POST", "/api/invest/rules", { draft: { symbol: "SOXL", kind: "stop", price: 20, action: "notify" } })).body;
    idb.confirmReal(w.h.db, w.uid, other.id, 1, 5, w.h.clock.t);
    const p = await preview(w);
    const res = await enable(w, await signed(w, p.body.previewId));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ mode: "real", realSince: w.h.clock.t, realBlockers: [], realBlockerText: null });
    expect(confirms(w)).toEqual(
      [
        { rule_id: r.SOXL!.id, rev: 1, qty: 47 },
        { rule_id: r.TQQQ!.id, rev: 1, qty: 3 },
      ].sort((a, b) => (a.rule_id < b.rule_id ? -1 : 1)),
    );
    expect(eventRows(w)).toEqual([{ text: "실제 주문을 켰어요 · SOXL 47주 · TQQQ 3주", llm: "[투자 기록] 실제 주문 켬 · 대상 SOXL 47주, TQQQ 3주" }]);
    // the person's own act: no banner, no push; the record carries no account, token or key
    expect(banners(w)).toHaveLength(0);
    expect(w.pushes).toHaveLength(0);
    expect(JSON.stringify(eventRows(w))).not.toMatch(/tok-|secret|계좌|account/i);
    expect(w.h.db.sql.query("SELECT used_at FROM invest_previews WHERE id = $id").get({ id: p.body.previewId })).toEqual({ used_at: w.h.clock.t });
  });

  test("refused with nothing changed: fields missing or malformed 400, an unknown device 400, a wrong signature 403", async () => {
    const w = await world();
    await setup(w, [SOXL]);
    const p = await preview(w);
    const id = p.body.previewId;
    const good = await signed(w, id);
    const bads: [unknown, number, string][] = [
      [{}, 400, "invalid_signature"],
      [{ ...good, signature: undefined }, 400, "invalid_signature"],
      [{ ...good, nonce: "" }, 400, "invalid_signature"],
      [{ ...good, nonce: "x".repeat(129) }, 400, "invalid_signature"],
      [{ ...good, signature: "x".repeat(257) }, 400, "invalid_signature"],
      [{ ...good, previewId: 7 }, 400, "invalid_signature"],
      [{ ...good, previewId: "" }, 400, "invalid_signature"],
      [{ ...good, previewId: "x".repeat(65) }, 400, "invalid_signature"],
      [{ ...good, deviceId: 7 }, 400, "invalid_signature"],
      [{ ...good, nonce: 7 }, 400, "invalid_signature"],
      [{ ...good, signature: 7 }, 400, "invalid_signature"],
      [{ ...good, signature: "" }, 400, "invalid_signature"],
      [{ ...good, deviceId: "dev_unknown_123" }, 400, "unknown_device"],
      [await signed(w, id, { over: "ip_other" }), 403, "bad_signature"],
      [{ ...good, nonce: "another-nonce" }, 403, "bad_signature"],
    ];
    const stranger = await makeDevice();
    bads.push([await signed(w, id, { device: stranger }), 403, "bad_signature"]);
    for (const [body, status, code] of bads) {
      const res = await enable(w, body);
      expect([res.status, res.body.error]).toEqual([status, code]);
    }
    expect((await enable(w, await signed(w, id, { over: "ip_other" }))).body.message).toBe("기기 키로 확인하지 못해서 켜지 않았어요. 다시 길게 눌러 주세요.");
    expect(mode(w)).toBe("mock");
    expect(confirms(w)).toEqual([]);
    // the preview is still unused: the right signature turns it on
    expect((await enable(w, good)).status).toBe(200);
  });

  test("another person's previewId, an expired one, a rule preview's id: 409 preview_stale with nothing more said", async () => {
    const w = await world();
    await setup(w, [SOXL]);
    const bob = await w.h.signup("bob");
    const rulePreview = (await api<{ previewId: string }>(w, "POST", "/api/invest/rules/preview", { symbol: "SOXL", kind: "stop", price: 26, action: "sell" })).body.previewId;
    const mine = (await preview(w)).body;
    // bob's preview with alice's very list: bound to bob, so alice cannot use it
    const spec = (w.h.db.sql.query("SELECT spec_json FROM invest_previews WHERE id = $id").get({ id: mine.previewId }) as { spec_json: string }).spec_json;
    idb.putPreview(w.h.db, { id: "ip_bobs", user_id: bob.session.user.id, kind: "real", spec_json: spec, expires_at: w.h.clock.t + REAL_PREVIEW_TTL_MS });
    for (const id of ["ip_bobs", rulePreview, "ip_nothing"]) {
      const res = await enable(w, await signed(w, id));
      expect(res.status).toBe(409);
      expect(res.body).toEqual({ error: "preview_stale", message: "그사이 보유 수량이나 규칙이 바뀌었어요. 바뀐 목록을 확인하고 다시 길게 눌러 주세요." } as never);
    }
    w.h.clock.t = mine.expiresAt;
    const late = await enable(w, await signed(w, mine.previewId));
    expect(late.status).toBe(409);
    expect(late.body.preview).toBeUndefined();
    expect(mode(w)).toBe("mock");
  });

  test("Toss says another quantity, a rule moved, or a symbol is no longer held: 409 with the new sheet, which turns on", async () => {
    const w = await world();
    const r = await setup(w, [SOXL]);
    const cases: [string, () => Promise<void>][] = [
      ["qty", async () => void w.up.state.tossSellable.set("SOXL", 50)],
      ["rev", async () => void w.h.db.sql.query("UPDATE invest_rules SET rev = rev + 1 WHERE id = $id").run({ id: r.SOXL!.id })],
      ["sold", async () => void w.up.state.tossSellable.set("SOXL", 0)],
    ];
    for (const [name, change] of cases) {
      w.h.clock.t += REAL_PREVIEW_TTL_MS + 1; // each case in its own ten minutes (6 sheets at most)
      const p = (await preview(w)).body;
      await change();
      const res = await enable(w, await signed(w, p.previewId));
      expect([name, res.status, res.body.error]).toEqual([name, 409, "preview_stale"]);
      expect(res.body.preview!.previewId).not.toBe(p.previewId);
      if (name === "qty") expect(res.body.preview!.targets[0]!.head).toBe("SOXL · 50주 전량");
      if (name === "sold") expect([res.body.preview!.targets, res.body.preview!.notHeld]).toEqual([[], "보유하지 않아 팔지 않아요: SOXL"]);
      expect(mode(w)).toBe("mock");
      w.up.state.tossSellable.set("SOXL", 47);
    }
    // the new sheet (the latest list) turns on
    w.h.clock.t += REAL_PREVIEW_TTL_MS + 1;
    const p = (await preview(w)).body;
    w.up.state.tossSellable.set("SOXL", 40);
    const stale = await enable(w, await signed(w, p.previewId));
    const ok = await enable(w, await signed(w, stale.body.preview!.previewId));
    expect(ok.status).toBe(200);
    expect(confirms(w)).toEqual([{ rule_id: r.SOXL!.id, rev: 2, qty: 40 }]);
  });

  test("a rule saved while Toss is asked again: 409, never a confirmation at a rev the sheet did not show", async () => {
    const w = await world();
    const r = await setup(w, [SOXL]);
    const p = (await preview(w)).body;
    w.up.state.onCall = (_m, path) => {
      if (path === "/api/v1/sellable-quantity") {
        w.up.state.onCall = null;
        w.h.db.sql.query("UPDATE invest_rules SET rev = rev + 1 WHERE id = $id").run({ id: r.SOXL!.id });
      }
    };
    const res = await enable(w, await signed(w, p.previewId));
    expect([res.status, res.body.error]).toEqual([409, "preview_stale"]);
    expect(mode(w)).toBe("mock");
    expect(confirms(w)).toEqual([]);
  });

  test("a second press while on: 200, nothing rewritten; the same request after turning off: 409 from the used sheet (never a second enable)", async () => {
    const w = await world();
    const r = await setup(w, [SOXL]);
    const p = (await preview(w)).body;
    const body = await signed(w, p.previewId);
    expect((await enable(w, body)).status).toBe(200);
    const since = idb.getSettings(w.h.db, w.uid)!.real_since;
    w.h.clock.t += 1000;
    w.up.state.tossSellable.set("SOXL", 30);
    const again = await enable(w, body);
    expect([again.status, again.body.mode]).toEqual([200, "real"]);
    expect(idb.getSettings(w.h.db, w.uid)!.real_since).toBe(since);
    expect(confirms(w)).toEqual([{ rule_id: r.SOXL!.id, rev: 1, qty: 47 }]);
    expect(eventRows(w)).toHaveLength(1);
    expect((await api(w, "POST", "/api/invest/real/disable")).status).toBe(200);
    // the sheet's own quantities again (lead 0325 2): the 409 is the used sheet's, before any Toss read or new sheet
    w.up.state.tossSellable.set("SOXL", 47);
    const reads = sellableReads(w);
    const sheets = idb.realPreviewCount(w.h.db, w.uid, w.h.clock.t);
    const replay = await enable(w, body);
    expect([replay.status, replay.body.error, "preview" in replay.body]).toEqual([409, "preview_stale", false]);
    expect(sellableReads(w)).toBe(reads);
    expect(idb.realPreviewCount(w.h.db, w.uid, w.h.clock.t)).toBe(sheets);
    expect(mode(w)).toBe("mock");
    expect(confirms(w)).toEqual([]);
  });

  test("two presses of one sheet at once (both ask Toss again): one enable and one record; the other is answered on", async () => {
    const w = await world();
    const r = await setup(w, [SOXL]);
    const p = (await preview(w)).body;
    const before = w.up.calls.length;
    // the first sellable read waits for the second: both are past the first mode check before either step runs
    let release!: () => void;
    const second = new Promise<void>((r) => (release = r));
    let reads = 0;
    w.hold.fn = async (path) => {
      if (path !== "/api/v1/sellable-quantity") return;
      if (++reads === 1) await second;
      else release();
    };
    const [a, b] = await Promise.all([enable(w, await signed(w, p.previewId)), enable(w, await signed(w, p.previewId))]);
    w.hold.fn = null;
    expect(w.up.calls.slice(before).filter((c) => c.path.startsWith("/api/v1/sellable-quantity"))).toHaveLength(2); // both were past the first check
    expect([a.status, a.body.mode, b.status, b.body.mode]).toEqual([200, "real", 200, "real"]);
    expect(confirms(w)).toEqual([{ rule_id: r.SOXL!.id, rev: 1, qty: 47 }]);
    expect(eventRows(w)).toHaveLength(1);
  });

  test("a press still asking Toss while the same sheet turns real on and the person turns it off: 409, mock stays (lead 0310)", async () => {
    const w = await world();
    await setup(w, [SOXL]);
    const p = (await preview(w)).body;
    // B's sellable read waits until A has turned real on and the person has turned it off; A's read goes through
    let atRead!: () => void;
    const reached = new Promise<void>((r) => (atRead = r));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let reads = 0;
    w.hold.fn = async (path) => {
      if (path !== "/api/v1/sellable-quantity") return;
      if (++reads === 1) {
        atRead();
        await gate;
      }
    };
    const b = enable(w, await signed(w, p.previewId));
    await reached;
    const a = await enable(w, await signed(w, p.previewId));
    expect([a.status, a.body.mode]).toEqual([200, "real"]);
    w.h.clock.t += 1_000;
    expect((await api(w, "POST", "/api/invest/real/disable")).status).toBe(200);
    w.h.clock.t += 1_000;
    release();
    const late = await b;
    w.hold.fn = null;
    expect(reads).toBe(2);
    expect([late.status, late.body.error]).toEqual([409, "preview_stale"]);
    expect(mode(w)).toBe("mock");
    expect(idb.getSettings(w.h.db, w.uid)!.real_since).toBeNull();
    expect(confirms(w)).toEqual([]);
    expect(eventRows(w).map((e) => e.text)).toEqual(["실제 주문을 켰어요 · SOXL 47주", "실제 주문을 껐어요"]);
  });
});

// ───────────────────────────── disable ─────────────────────────────

describe("invest real orders off (lead 2040 11)", () => {
  test("no signature: mock, confirmations gone, a planned order dropped with no banner or call, a sent one still checked", async () => {
    const w = await world({ twilio: true });
    writeMyPhone(w.h.app.core, w.uid, { e164: "+821012345678", verifiedAt: w.h.clock.t, codeHash: null, codeExpiresAt: 0, attempts: 0 });
    await setup(w, [SOXL, { symbol: "SOXS", qty: 10, stop: 10 }]);
    w.up.state.orderPlan = [{ status: "PENDING" }];
    await turnOn(w);
    // SOXS sent in the session (stays PENDING), SOXL hit at the close: planned for the next session
    await hit(w, ET(9, 55), ET(10, 0), "SOXS", 9.5);
    expect(posts(w)).toHaveLength(1);
    await hit(w, ET(15, 55), ET(16, 5));
    expect(realRows(w).map((x) => [x.symbol, x.state])).toEqual([
      ["SOXS", "submitted"],
      ["SOXL", "scheduled"],
    ]);
    const b = banners(w).length;
    const p = w.pushes.length;
    expect(twilio).toHaveLength(1); // the planned order's call: calls do go out
    w.h.clock.t = ET(16, 8);
    const off = await api<InvestSettingsView>(w, "POST", "/api/invest/real/disable");
    expect(off.status).toBe(200);
    expect(off.body).toMatchObject({ mode: "mock", openOrders: 1 });
    expect(off.body.realSince).toBeUndefined();
    expect(confirms(w)).toEqual([]);
    expect(realRows(w).map((x) => [x.symbol, x.state, x.reason])).toEqual([
      ["SOXS", "submitted", null],
      ["SOXL", "canceled", "disabled"],
    ]);
    expect(stopCards(w).filter((c) => c.symbol === "SOXL").at(-1)!.title).toBe("실제 주문을 꺼서 예정된 주문을 내지 않았어요");
    await w.h.app.core.idle();
    expect([banners(w).length, w.pushes.length, twilio.length]).toEqual([b, p, 1]);
    expect(eventRows(w).at(-1)).toEqual({ text: "실제 주문을 껐어요 · 예정 주문 1건 취소 · 보낸 주문 1건 체결 확인 중", llm: "[투자 기록] 실제 주문 끔 · 예정 주문 1건 취소 · 보낸 주문 1건 체결 확인 중" });
    // the sent order is still checked
    const reads = w.up.calls.filter((c) => c.path.startsWith("/api/v1/orders/")).length;
    w.h.clock.t = ET(16, 9);
    await w.h.app.core.invest.desk.beat(w.h.clock.t);
    expect(w.up.calls.filter((c) => c.path.startsWith("/api/v1/orders/")).length).toBeGreaterThan(reads);
    // already off: 200 and no second row
    expect((await api(w, "POST", "/api/invest/real/disable")).status).toBe(200);
    expect(eventRows(w).filter((x) => x.text.startsWith("실제 주문을 껐어요"))).toHaveLength(1);
  });

  test("the Toss login removed takes the confirmations too", async () => {
    const w = await world();
    await setup(w, [SOXL]);
    await turnOn(w);
    expect(confirms(w)).toHaveLength(1);
    await w.h.app.core.invest.onTossRemoved(w.uid);
    expect(mode(w)).toBe("mock");
    expect(confirms(w)).toEqual([]);
  });
});

// ───────────────────────────── confirmations from saves ─────────────────────────────

describe("invest real orders: confirmations from the person's saves (lead 2040 2, 2342 3)", () => {
  const rulePreview = (w: World, body: Record<string, unknown>) => api<{ previewId: string; confirm: string; sentence: string; sellable: { text: string } | null }>(w, "POST", "/api/invest/rules/preview", body);

  test("real mode: a save with a preview drawn in real mode confirms the new rev with its quantity; without one, unconfirmed", async () => {
    const w = await world();
    const r = await setup(w, [SOXL]);
    await turnOn(w);
    const id = r.SOXL!.id;
    // a moved line with its real-mode preview (hold): rev 2 at the preview's 47
    const p = (await rulePreview(w, { ruleId: id, changes: { price: 26 } })).body;
    expect(p.confirm).toBe("hold");
    expect((await api(w, "PATCH", `/api/invest/rules/${id}`, { changes: { price: 26 }, ifRev: 1, previewId: p.previewId })).status).toBe(200);
    expect(confirms(w)).toEqual([{ rule_id: id, rev: 2, qty: 47 }]);
    // saved with no preview: rev 3, unconfirmed (its earlier confirmation goes)
    expect((await api(w, "PATCH", `/api/invest/rules/${id}`, { changes: { price: 25 }, ifRev: 2 })).status).toBe(200);
    expect(confirms(w)).toEqual([]);
    // a new sell stop with its preview: rev 1 confirmed
    w.up.state.tossSellable.set("SOXS", 10);
    w.up.state.tossHoldings.push({ symbol: "SOXS", quantity: 10, averagePrice: 12 });
    w.up.state.tossPrices.set("SOXS", { price: 12 });
    expect((await api(w, "POST", "/api/invest/watchlist", { symbol: "SOXS" })).status).toBeLessThan(300);
    const draft = { symbol: "SOXS", kind: "stop", price: 10, action: "sell" };
    const np = (await rulePreview(w, draft)).body;
    const made = await api<{ id: string }>(w, "POST", "/api/invest/rules", { draft, previewId: np.previewId });
    expect(made.status).toBe(201);
    expect(confirms(w)).toEqual([{ rule_id: made.body.id, rev: 1, qty: 10 }]);
    // the action changed to a call with its preview: not a sell, so no confirmation
    const cp = (await rulePreview(w, { ruleId: made.body.id, changes: { action: "call" } })).body;
    expect((await api(w, "PATCH", `/api/invest/rules/${made.body.id}`, { changes: { action: "call" }, ifRev: 1, previewId: cp.previewId })).status).toBe(200);
    expect(confirms(w)).toEqual([]);
  });

  test("mock mode confirms nothing; a quantity of 0 confirms nothing; two creates with one preview make one rule", async () => {
    const w = await world();
    const r = await setup(w, [SOXL]);
    const id = r.SOXL!.id;
    // mock: the preview has Toss's 47, the save confirms nothing
    const mp = (await rulePreview(w, { ruleId: id, changes: { price: 26 } })).body;
    expect(mp.sellable?.text).toBe("47주");
    expect((await api(w, "PATCH", `/api/invest/rules/${id}`, { changes: { price: 26 }, ifRev: 1, previewId: mp.previewId })).status).toBe(200);
    expect(confirms(w)).toEqual([]);
    await turnOn(w);
    expect(confirms(w)).toEqual([{ rule_id: id, rev: 2, qty: 47 }]);
    // real, but Toss says 0 to sell: the save leaves the rule unconfirmed
    w.up.state.tossSellable.set("SOXL", 0);
    const zp = (await rulePreview(w, { ruleId: id, changes: { price: 25 } })).body;
    expect((await api(w, "PATCH", `/api/invest/rules/${id}`, { changes: { price: 25 }, ifRev: 2, previewId: zp.previewId })).status).toBe(200);
    expect(confirms(w)).toEqual([]);
    // two creates with one preview: one rule, the other is stale
    w.up.state.tossSellable.set("SOXL", 47);
    const draft = { symbol: "SOXL", kind: "stop", price: 22, action: "sell" };
    const np = (await rulePreview(w, draft)).body;
    const both = await Promise.all([api(w, "POST", "/api/invest/rules", { draft, previewId: np.previewId }), api(w, "POST", "/api/invest/rules", { draft, previewId: np.previewId })]);
    expect(both.map((x) => x.status).sort()).toEqual([201, 409]);
    expect(idb.rules(w.h.db, w.uid).filter((x) => x.price === 22)).toHaveLength(1);
    expect(confirms(w)).toHaveLength(1);
  });

  test("taking a symbol off the watch with its rules takes their confirmations", async () => {
    const w = await world();
    const r = await setup(w, [SOXL, { symbol: "SOXS", qty: 10, stop: 10 }]);
    await turnOn(w);
    expect(confirms(w)).toHaveLength(2);
    expect((await api(w, "DELETE", "/api/invest/watchlist/SOXL?withRules=1")).status).toBeLessThan(300);
    // by id: an orphan row's missing rule would read as undefined, which toEqual skips at an array's end
    expect(confirms(w).map((c) => c.rule_id)).toStrictEqual([r.SOXS!.id]);
  });

  test("a preview drawn in one mode saved in the other: preview_stale (the gap since B2); a delete takes the confirmation", async () => {
    const w = await world();
    const r = await setup(w, [SOXL]);
    const id = r.SOXL!.id;
    const mockDrawn = (await rulePreview(w, { ruleId: id, changes: { price: 26 } })).body;
    expect(mockDrawn.confirm).toBe("tap");
    await turnOn(w);
    const res = await api<{ error: string; preview: { confirm: string; previewId: string } }>(w, "PATCH", `/api/invest/rules/${id}`, { changes: { price: 26 }, ifRev: 1, previewId: mockDrawn.previewId });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("preview_stale");
    expect(res.body.preview.confirm).toBe("hold");
    expect(confirms(w)).toEqual([{ rule_id: id, rev: 1, qty: 47 }]);
    const realDrawn = (await rulePreview(w, { ruleId: id, changes: { price: 26 } })).body;
    expect((await api(w, "POST", "/api/invest/real/disable")).status).toBe(200);
    const back = await api<{ error: string }>(w, "PATCH", `/api/invest/rules/${id}`, { changes: { price: 26 }, ifRev: 1, previewId: realDrawn.previewId });
    expect([back.status, back.body.error]).toEqual([409, "preview_stale"]);
    // delete
    await turnOn(w);
    expect(confirms(w)).toHaveLength(1);
    expect((await api(w, "DELETE", `/api/invest/rules/${id}`)).status).toBeLessThan(300);
    expect(confirms(w)).toEqual([]);
  });

  test("a proposal applied in real mode confirms the moved sell stop with the quantity its card printed; a mock card none", async () => {
    const w = await world();
    const r = await setup(w, [SOXL]);
    const id = r.SOXL!.id;
    await turnOn(w);
    const tools = Object.fromEntries(investTools(w.h.app.core, w.uid).map((t) => [t.name, t])) as Record<string, ToolDef>;
    const ctx = { userId: w.uid, threadId: w.thread, agentName: "모시", displayName: "앨리스", now: () => new Date(w.h.clock.t), status: () => {} } as unknown as ToolContext;
    const propose = async (price: number) => {
      const out = await tools.invest_watch_propose!.run({ symbol: "SOXL", changes: [{ ruleId: id, price }], reason: "손절을 올려요", basis: "request" }, ctx);
      expect(out.ok).toBe(true);
      return out.card as InvestRuleChangeCard;
    };
    const card = await propose(26.5);
    expect(card.confirm).toBe("hold");
    expect(card.result).toContain("47주");
    expect(confirms(w)).toEqual([{ rule_id: id, rev: 1, qty: 47 }]);
    const applied = await api<{ card: InvestRuleChangeCard }>(w, "POST", `/api/invest/proposals/${card.proposalId}`, { decision: "apply" });
    expect(applied.status).toBe(200);
    expect(confirms(w)).toEqual([{ rule_id: id, rev: 2, qty: 47 }]);
    // the quantity moved since the card: stale, no confirmation with a number the person did not see
    const second = await propose(26);
    w.up.state.tossSellable.set("SOXL", 40);
    const stale = await api<{ error: string }>(w, "POST", `/api/invest/proposals/${second.proposalId}`, { decision: "apply" });
    expect([stale.status, stale.body.error]).toEqual([409, "proposal_stale"]);
    expect(confirms(w)).toEqual([{ rule_id: id, rev: 2, qty: 47 }]);
    // mock: applying moves the rule and leaves it unconfirmed
    expect((await api(w, "POST", "/api/invest/real/disable")).status).toBe(200);
    const mockCard = await propose(26);
    expect(mockCard.confirm).toBe("tap");
    expect((await api(w, "POST", `/api/invest/proposals/${mockCard.proposalId}`, { decision: "apply" })).status).toBe(200);
    expect(confirms(w)).toEqual([]);
  });

  test("proposals: of two moved rules only the sell stop is confirmed; a card with no quantity, or real mode gone mid-apply, none", async () => {
    const w = await world();
    const r = await setup(w, [SOXL]);
    const stop = r.SOXL!.id;
    const alertRule = (await api<{ id: string }>(w, "POST", "/api/invest/rules", { draft: { symbol: "SOXL", kind: "alert", price: 35, direction: "above", action: "notify" } })).body.id;
    await turnOn(w);
    const tools = Object.fromEntries(investTools(w.h.app.core, w.uid).map((t) => [t.name, t])) as Record<string, ToolDef>;
    const ctx = { userId: w.uid, threadId: w.thread, agentName: "모시", displayName: "앨리스", now: () => new Date(w.h.clock.t), status: () => {} } as unknown as ToolContext;
    const propose = async (changes: Record<string, unknown>[]) => {
      const out = await tools.invest_watch_propose!.run({ symbol: "SOXL", changes, reason: "손절을 올려요", basis: "request" }, ctx);
      expect(out.ok).toBe(true);
      return out.card as InvestRuleChangeCard;
    };
    const rev = (id: string) => idb.rule(w.h.db, w.uid, id)!.rev;
    const two = await propose([{ ruleId: stop, price: 26.5 }, { ruleId: alertRule, price: 36 }]);
    expect((await api(w, "POST", `/api/invest/proposals/${two.proposalId}`, { decision: "apply" })).status).toBe(200);
    expect(confirms(w)).toEqual([{ rule_id: stop, rev: rev(stop), qty: 47 }]);
    // Toss gave no quantity when the card was drawn (and still gives none): applied, the stop left unconfirmed
    w.up.state.pathStatus.set("/api/v1/sellable-quantity", [500, 500]);
    const blind = await propose([{ ruleId: stop, price: 26 }]);
    expect(blind.result).not.toContain("47주");
    expect((await api(w, "POST", `/api/invest/proposals/${blind.proposalId}`, { decision: "apply" })).status).toBe(200);
    expect(confirms(w)).toEqual([]);
    // real mode turned off (no hook) while the apply reads Toss: moved, not confirmed
    idb.confirmReal(w.h.db, w.uid, stop, rev(stop), 47, w.h.clock.t);
    const last = await propose([{ ruleId: stop, price: 25.5 }]);
    w.up.state.onCall = (_m, path) => {
      if (path === "/api/v1/sellable-quantity") {
        w.up.state.onCall = null;
        idb.updateSettings(w.h.db, w.uid, { mode: "mock" }, w.h.clock.t);
      }
    };
    const res = await api<{ error?: string }>(w, "POST", `/api/invest/proposals/${last.proposalId}`, { decision: "apply" });
    expect(res.status).toBe(200);
    expect(idb.rule(w.h.db, w.uid, stop)!.price).toBe(25.5);
    expect(confirms(w)).toEqual([]);
  });
});

// ───────────────────────────── confirm_changed, end to end ─────────────────────────────

describe("invest real orders: after enable", () => {
  test("enabled through the API, a hit sells the confirmed quantity (fake Toss), never more", async () => {
    const w = await world();
    await setup(w, [SOXL]);
    await turnOn(w);
    w.up.state.tossSellable.set("SOXL", 60);
    w.up.state.tossHoldings = [{ symbol: "SOXL", quantity: 60, averagePrice: 30 }];
    await hit(w, ET(9, 55), ET(10, 0), "SOXL", 25); // under the intraday line ($25.65)
    expect(posts(w)).toHaveLength(1);
    expect(JSON.parse(posts(w)[0]!.body!)).toMatchObject({ symbol: "SOXL", side: "SELL", orderType: "MARKET", quantity: "47" });
  });

  test("the confirmation rewritten while the hit asks Toss: canceled confirm_changed in its own words, no banner or call (DD 2314 §6)", async () => {
    const w = await world({ twilio: true });
    writeMyPhone(w.h.app.core, w.uid, { e164: "+821012345678", verifiedAt: w.h.clock.t, codeHash: null, codeExpiresAt: 0, attempts: 0 });
    const r = await setup(w, [SOXL]);
    await turnOn(w);
    await tickAt(w, ET(9, 55));
    w.up.state.tossPrices.set("SOXL", { price: 25 });
    w.up.state.onCall = (_m, path) => {
      if (path === "/api/v1/sellable-quantity") {
        w.up.state.onCall = null;
        idb.confirmReal(w.h.db, w.uid, r.SOXL!.id, 1, 20, w.h.clock.t);
      }
    };
    const b = banners(w).length;
    await tickAt(w, ET(10, 0));
    expect(posts(w)).toHaveLength(0);
    expect(realRows(w).at(-1)).toMatchObject({ state: "canceled", reason: "confirm_changed" });
    expect(stopCards(w).at(-1)!.title).toBe("실제 매도 확인이 바뀌어서 주문을 내지 않았어요");
    expect(banners(w).length).toBe(b);
    expect(twilio).toHaveLength(0);
  });

  test("a planned order whose confirmation went with real mode still on: the planned words", async () => {
    const w = await world();
    const r = await setup(w, [SOXL]);
    await turnOn(w);
    await hit(w, ET(15, 55), ET(16, 5));
    expect(realRows(w).at(-1)!.state).toBe("scheduled");
    idb.deleteConfirm(w.h.db, w.uid, r.SOXL!.id);
    await tickAt(w, ET(9, 45, "2026-12-01"));
    await w.h.app.core.invest.desk.beat(w.h.clock.t);
    await w.h.app.core.idle();
    expect(posts(w)).toHaveLength(0);
    expect(realRows(w).at(-1)).toMatchObject({ state: "canceled", reason: "confirm_changed" });
    expect(stopCards(w).at(-1)!.title).toBe("실제 매도 확인이 바뀌어서 예정된 주문을 내지 않았어요");
  });
});

// ───────────────────────────── G8 in the source ─────────────────────────────

describe("invest real orders: who can write the mode and confirmations (team-lead 2342 8)", () => {
  const SRC = join(import.meta.dir, "..", "src");
  const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : []));
  const all = files(SRC).map((f) => ({ f: f.slice(SRC.length + 1), s: readFileSync(f, "utf8") }));
  const hits = (re: RegExp) => all.flatMap(({ f, s }) => (s.match(re) ?? []).map(() => f)).sort();

  test("confirmReal has three callers (enable, a rule save, a proposal apply); real mode is written by enable alone; tools reach neither", () => {
    expect(hits(/[^.\w]idb\.confirmReal\(/g)).toEqual(["invest/proposals.ts", "invest/real.ts", "invest/routes.ts"]);
    expect(hits(/updateSettings\([^;]*mode: "real"/g)).toEqual(["invest/real.ts"]);
    const tools = all.find((x) => x.f === "invest/tools.ts")!.s;
    expect(tools).not.toMatch(/confirmReal|clearConfirms|enableReal|disableReal|updateSettings|real\/enable/);
    expect(investTools.toString()).not.toMatch(/confirmReal|enableReal/);
    // the switch is read in config.ts alone
    expect(hits(/env(?:\.|\[["'`])PICKLE_INVEST_ORDERS/g)).toEqual(["invest/config.ts"]);
  });
});
