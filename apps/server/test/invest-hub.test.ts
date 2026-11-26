/**
 * Invest B1 through the server: routes, the 5-minute watch, alerts and their re-alert rule (team-lead 2045-8), mock stop
 * records, invest calls, Toss status, blind, expiry, and the boundaries (G8: no order call, the watch never moves a
 * rule; keys never leave the vault path). Upstreams are test/fake-toss.ts (synthetic bodies); nothing real is called.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { InvestAlertCard, InvestOverview, InvestRuleRow, InvestStopCard, ServerEvent } from "@pickle/protocol";
import type { CredentialAccess } from "@pickle/agent";
import { etToEpoch } from "../src/invest/calendar.ts";
import * as idb from "../src/invest/db.ts";
import { writeMyPhone } from "../src/phone.ts";
import type { Logger, LogFields } from "../src/log.ts";
import { BOGUS_TOSS_SECRET, FAKE_TOSS_BASE, makeInvestUpstream, syntheticBars } from "./fake-toss.ts";
import { makeFakeVault, makeHarness, type Harness } from "./helpers.ts";

const DAY = "2026-11-30"; // a Monday, a full session (EST: 09:30 ET = 14:30Z)
const ET = (h: number, m: number, day = DAY) => etToEpoch(day, h, m);
const TWILIO = { accountSid: "AC123", authToken: "tok", from: "+15550000000" };
const PERIOD = "가격 규칙은 개장 15분 뒤부터 마감까지 5분마다 확인해요.";

type Up = ReturnType<typeof makeInvestUpstream>;
interface World {
  h: Harness;
  up: Up;
  uid: string;
  token: string;
  events: ServerEvent[];
  logs: string[];
}

/** the vault hands the bogus Toss key material to `use` (the shared fake vault has no Toss fields) */
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

const worlds: World[] = [];
async function world(o: { sources?: boolean; toss?: boolean; twilio?: boolean } = {}): Promise<World> {
  const up = makeInvestUpstream();
  const h = await makeHarness({
    now: ET(9, 0),
    config: {
      invest: { sources: o.sources ?? true, tossBase: o.toss === false ? null : FAKE_TOSS_BASE, outboundIp: "203.0.113.7" },
      ...(o.twilio ? { twilio: TWILIO } : {}),
    },
    deps: ({ vault }) => ({ investFetch: up.fetch, vault: tossVault(vault) }),
  });
  const me = await h.signup("alice");
  const events: ServerEvent[] = [];
  const pub = h.app.core.events.publish.bind(h.app.core.events);
  h.app.core.events.publish = (u, e) => {
    if (u === me.session.user.id) events.push(e);
    pub(u, e);
  };
  const logs: string[] = [];
  const rec = (level: string) => (event: string, fields?: LogFields) => void logs.push(`${level} ${event} ${JSON.stringify(fields ?? {})}`);
  const logger: Logger = { info: rec("info"), warn: rec("warn"), error: rec("error") };
  h.app.core.log = logger;
  const w = { h, up, uid: me.session.user.id, token: me.token, events, logs };
  worlds.push(w);
  return w;
}

afterEach(async () => {
  while (worlds.length) await worlds.pop()!.h.close();
});

const api = async <T = unknown>(w: World, method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> => {
  const res = await w.h.req(method, path, { token: w.token, body });
  return { status: res.status, body: (await res.json()) as T };
};

async function connectToss(w: World): Promise<string> {
  const envelope = { v: 1, alg: "ECDH-P256+HKDF-SHA256+A256GCM", kid: "kid-test", epk: { kty: "EC" }, iv: "aXY", ct: "Y3Q", aad: `${w.uid}:tossinvest:token` };
  const r = await api<{ id: string }>(w, "POST", "/api/credentials", { service: "tossinvest", label: "토스증권", kind: "token", hint: "계좌 1개", keepFor: "forever", envelope });
  expect(r.status).toBe(201);
  await w.h.app.core.idle();
  return r.body.id;
}

async function tickAt(w: World, h: number, m: number, day = DAY) {
  w.h.clock.t = ET(h, m, day);
  const r = await w.h.app.core.invest.tick();
  await w.h.app.core.idle();
  return r;
}

async function watch(w: World, symbol: string) {
  const r = await api(w, "POST", "/api/invest/watchlist", { symbol });
  expect([200, 201]).toContain(r.status);
}

async function addRule(w: World, draft: Record<string, unknown>): Promise<InvestRuleRow> {
  const r = await api<InvestRuleRow>(w, "POST", "/api/invest/rules", { draft });
  expect(r.status).toBe(201);
  return r.body;
}

function investCards(w: World): (InvestAlertCard | InvestStopCard)[] {
  const tid = idb.getSettings(w.h.db, w.uid)?.thread_id;
  if (!tid) return [];
  const rows = w.h.db.sql.query("SELECT cards_json FROM messages WHERE thread_id = $t ORDER BY created_at, id").all({ t: tid }) as { cards_json: string }[];
  return rows.flatMap((r) => JSON.parse(r.cards_json) as (InvestAlertCard | InvestStopCard)[]);
}

const alerts = (w: World) => investCards(w).filter((c): c is InvestAlertCard => c.type === "invest_alert");

/** what a person reads (cards, overview) never shows a broken number or an emoji (DD 2045, team-lead 888c34b) */
async function expectClean(w: World) {
  const text = JSON.stringify(investCards(w)) + JSON.stringify((await api(w, "GET", "/api/invest")).body);
  expect(text).not.toMatch(/NaN|Infinity|undefined|\$null|null원/);
  expect(text).not.toMatch(/\p{Extended_Pictographic}/u);
}
const banners = (w: World) => w.events.filter((e): e is Extract<ServerEvent, { type: "notification" }> => e.type === "notification");

// ───────────────────────────── routes ─────────────────────────────

describe("invest routes", () => {
  test("off server: overview off, watchlist by format only, rule checks and their copy", async () => {
    const w = await world({ sources: false, toss: false });
    const ov = await api<InvestOverview>(w, "GET", "/api/invest");
    expect(ov.status).toBe(200);
    expect(ov.body.watch).toEqual({ state: "off", text: "지금은 시세를 받지 않아요" });
    expect(ov.body.quotesFoot).toBe(PERIOD);
    expect(ov.body.settings.toss.error?.code).toBe("off");
    expect(ov.body.settings.realBlockers).toEqual(["toss_off"]);
    expect(ov.body.settings.callBlock).toBe("not_configured");
    expect(ov.body.settings.calls).toEqual({ stopResult: true, stage: false, expiry: false });

    const add = await api<{ symbol: string; name: string; price: unknown }>(w, "POST", "/api/invest/watchlist", { symbol: " soxl " });
    expect(add.status).toBe(201);
    expect(add.body).toMatchObject({ symbol: "SOXL", name: "SOXL", market: "US", price: null, change: null, holding: null });
    expect((await api(w, "POST", "/api/invest/watchlist", { symbol: "SOXL" })).status).toBe(200);
    expect(await api(w, "POST", "/api/invest/watchlist", { symbol: "!!" })).toEqual({ status: 404, body: { error: "unknown_symbol", message: "찾을 수 없는 종목이에요. 기호를 다시 확인해 주세요." } });

    const no = async (draft: Record<string, unknown>) => (await api(w, "POST", "/api/invest/rules", { draft })).body;
    expect(await no({ symbol: "SOXL", kind: "resistance", price: 34, action: "notify" })).toEqual({ error: "kind_not_allowed", message: "저항과 무효화 규칙은 전략 제안으로만 만들 수 있어요." });
    expect(await no({ symbol: "SOXL", kind: "target", price: 34, action: "sell" })).toEqual({ error: "sell_not_allowed", message: "매도는 손절 규칙에만 걸 수 있어요." });
    expect(await no({ symbol: "TQQQ", kind: "stop", price: 34, action: "notify" })).toEqual({ error: "not_watched", message: "감시 종목에 먼저 추가해 주세요." });
    expect(await no({ symbol: "SOXL", kind: "stop", price: 27, action: "notify", bufferPct: 25 })).toEqual({ error: "invalid_rule", message: "장중 버퍼는 1–20% 사이로 정해 주세요." });
    expect(await no({ symbol: "SOXL", kind: "stop", price: -1, action: "notify" })).toEqual({ error: "invalid_rule", message: "가격은 0보다 커야 해요." });
    expect(await no({ symbol: "SOXL", kind: "buy_zone", lo: 22, hi: 20, action: "notify" })).toMatchObject({ error: "invalid_rule" });

    const rule = await addRule(w, { symbol: "SOXL", kind: "stop", price: 27, action: "notify" });
    expect(rule).toMatchObject({
      symbol: "SOXL",
      kind: "stop",
      rev: 1,
      state: "armed",
      stateText: "대기",
      price: { v: 27, text: "$27.00" },
      buffer: { v: 25.65, text: "$25.65" },
      bufferPct: { v: 5, text: "5%" },
      bufferDefault: true,
    });

    // PATCH: a stale ifRev answers the current row; the right one raises rev
    const stale = await api<{ error: string; message: string; rule: InvestRuleRow }>(w, "PATCH", `/api/invest/rules/${rule.id}`, { changes: { price: 26 }, ifRev: 0 });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toBe("rule_changed");
    expect(stale.body.message).toBe("그사이 규칙이 바뀌었어요. 바뀐 내용을 확인하고 다시 저장해 주세요.");
    expect(stale.body.rule.id).toBe(rule.id);
    const ok = await api<InvestRuleRow>(w, "PATCH", `/api/invest/rules/${rule.id}`, { changes: { price: 26, bufferPct: 7 }, ifRev: 1 });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ rev: 2, price: { v: 26 }, bufferPct: { v: 7 }, bufferDefault: false });
    expect((await api(w, "PATCH", `/api/invest/rules/${rule.id}`, { changes: { direction: "above" }, ifRev: 2 })).body).toMatchObject({ error: "invalid_rule" });
    expect((await api(w, "PATCH", "/api/invest/rules/ir_nope", { changes: {}, ifRev: 1 })).body).toEqual({ error: "rule_not_found", message: "이미 지워진 규칙이에요." });

    // a symbol with rules: 409 with the count, then withRules=1 takes both
    const has = await api<{ error: string; message: string; count: number }>(w, "DELETE", "/api/invest/watchlist/SOXL");
    expect(has).toEqual({ status: 409, body: { error: "has_rules", message: "이 종목에 규칙이 1개 있어요. 규칙과 함께 뺄지 다시 골라 주세요.", count: 1 } });
    expect((await api(w, "DELETE", "/api/invest/watchlist/SOXL?withRules=1")).status).toBe(200);
    const after = (await api<InvestOverview>(w, "GET", "/api/invest")).body;
    expect(after.watchlist).toEqual([]);
    expect(after.rules).toEqual([]);
  });

  test("preview: the server's sentence, warning, buffer and call note; a stale previewId is 409 with a new preview", async () => {
    const w = await world({ toss: true });
    w.up.state.yahoo.set("SOXL", { price: 26.5, prevClose: 27.1, time: Math.floor(ET(9, 0) / 1000), name: "Direxion Daily Semiconductor Bull 3X" });
    await watch(w, "SOXL");
    const ov = (await api<InvestOverview>(w, "GET", "/api/invest")).body;
    expect(ov.watchlist[0]).toMatchObject({ symbol: "SOXL", name: "Direxion Daily Semiconductor Bull 3X", price: { v: 26.5 } });
    const p = await api<Record<string, unknown>>(w, "POST", "/api/invest/rules/preview", { symbol: "SOXL", kind: "stop", price: 27, action: "call" });
    expect(p.status).toBe(200);
    expect(p.body).toMatchObject({
      changed: true,
      sentence: "SOXL에 손절 $27.00 이하 규칙을 더해요. 장중에 $27.00 이하로 내려가면 전화로 알려요.",
      warning: "지금 가격 $26.50보다 높아서, 저장하면 바로 손절 조건이 돼요.",
      basis: "intraday",
      bufferDefault: true,
      bufferFoot: "지금은 장중 가격만으로 판단해요. 종가로 판단할 때, 장중 가격이 손절선보다 이만큼 더 내려가면 마감을 기다리지 않아요. 원문에 숫자가 없어서 정한 운영 기본값(5%)이에요.",
      confirm: "tap",
      callNote: "지금은 전화를 걸 수 없어요",
      price: { v: 26.5, text: "$26.50" },
    });
    // the draft changed after the preview: stale
    const stale = await api<{ error: string; preview: { previewId: string } }>(w, "POST", "/api/invest/rules", { draft: { symbol: "SOXL", kind: "stop", price: 26, action: "call" }, previewId: p.body.previewId });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toBe("preview_stale");
    expect(stale.body.preview.previewId).not.toBe(p.body.previewId);
    const ok = await api(w, "POST", "/api/invest/rules", { draft: { symbol: "SOXL", kind: "stop", price: 26, action: "call" }, previewId: stale.body.preview.previewId });
    expect(ok.status).toBe(201);
    // a preview is used once
    expect((await api(w, "POST", "/api/invest/rules", { draft: { symbol: "SOXL", kind: "stop", price: 26, action: "call" }, previewId: stale.body.preview.previewId })).status).toBe(409);
    // an edit sheet with nothing changed yet (DD 2135)
    const id = (ok.body as InvestRuleRow).id;
    const same = await api<{ sentence: string; changed: boolean }>(w, "POST", "/api/invest/rules/preview", { ruleId: id, changes: { price: 26, direction: "below" } });
    expect(same.body).toMatchObject({ changed: false, sentence: "지금 규칙이에요. 장중에 $26.00 이하로 내려가면 전화로 알려요." });
    const moved = await api<{ sentence: string; changed: boolean }>(w, "POST", "/api/invest/rules/preview", { ruleId: id, changes: { price: 25.5 } });
    expect(moved.body).toMatchObject({ changed: true, sentence: "SOXL 손절을 $26.00에서 $25.50으로 바꿔요. 장중에 $25.50 이하로 내려가면 전화로 알려요." });
  });

  test("settings, the profile row, hello.investRev; session has no investMode in mock", async () => {
    const w = await world({ sources: false, toss: false });
    const s = await api<{ calls: Record<string, boolean> }>(w, "PATCH", "/api/invest/settings", { calls: { expiry: true } });
    expect(s.body.calls).toEqual({ stopResult: true, stage: false, expiry: true });
    expect((await api(w, "PATCH", "/api/invest/settings", { calls: { expiry: "yes" } })).status).toBe(400);
    const ui = (await api<{ profile: { sections: { rows: { id: string; title: string; icon: string; target: string }[] }[] } }>(w, "GET", "/api/ui-definitions")).body;
    expect(ui.profile.sections.flatMap((x) => x.rows).find((r) => r.id === "invest")).toEqual({ id: "invest", title: "투자", icon: "chart", target: "invest" });
    const me = (await api<Record<string, unknown>>(w, "GET", "/api/session")).body;
    expect("investMode" in me).toBe(false);
    const rev = idb.getSettings(w.h.db, w.uid)!.rev;
    expect(rev).toBeGreaterThan(0);
    const ev = w.events.filter((e) => e.type === "invest").at(-1) as Extract<ServerEvent, { type: "invest" }>;
    expect(ev.rev).toBe(rev);
    expect(ev.overview.rev).toBe(rev);
    // the same overview again: no new event, no new rev
    const n = w.events.length;
    await w.h.app.core.invest.publish(w.uid);
    expect(w.events.length).toBe(n);
    const ac = new AbortController();
    const res = await w.h.req("GET", "/api/events", { token: w.token, signal: ac.signal });
    const { sseReader } = await import("./helpers.ts");
    const r = sseReader(res);
    const hello = await r.next<Extract<ServerEvent, { type: "hello" }>>((e) => e.type === "hello");
    expect(hello?.investRev).toBe(rev);
    await r.cancel();
    ac.abort();
  });
});

// ───────────────────────────── the watch ─────────────────────────────

describe("invest watch", () => {
  test("alert once while inside, again after one check outside (same day); a slot runs once", async () => {
    const w = await world();
    await connectToss(w);
    await watch(w, "SOXL");
    const rule = await addRule(w, { symbol: "SOXL", kind: "stop", price: 27, action: "notify" });
    w.up.state.tossPrices.set("SOXL", { price: 27.5, prevClose: 28 });
    expect(await tickAt(w, 9, 44)).toEqual({ slots: 0, alerts: 0 }); // before 09:45 ET
    expect(await tickAt(w, 9, 45)).toEqual({ slots: 1, alerts: 0 });
    expect(await tickAt(w, 9, 47)).toEqual({ slots: 0, alerts: 0 }); // same slot
    const ov = (await api<InvestOverview>(w, "GET", "/api/invest")).body;
    expect(ov.quotesFoot).toMatch(/^시세 .+ 기준 · 토스증권\. 가격 규칙은 개장 15분 뒤부터 마감까지 5분마다 확인해요\.$/);
    expect(ov.watch.state).toBe("ok");

    w.up.state.tossPrices.set("SOXL", { price: 26.9, prevClose: 28 });
    expect(await tickAt(w, 9, 50)).toEqual({ slots: 1, alerts: 1 });
    const [a] = alerts(w);
    expect(a).toMatchObject({ kind: "stop_alert", tone: "danger", title: "SOXL이 손절 관찰가에 닿았어요", price: { v: 26.9, text: "$26.90" }, disclaimer: true });
    expect(a!.titleLines).toBeUndefined(); // seen at 09:45: the earlier state is known
    expect(a!.notes).toContain("주문은 내지 않았어요.");
    expect(a!.notes).toContain("보유 중일 때 해당하는 알림이에요.");
    expect(a!.foot).toContain("토스증권");
    expect(a!.sub).toContain("손절선보다 $0.10 아래");
    expect(banners(w).at(-1)).toMatchObject({ title: "SOXL 손절 관찰가 도달", body: "$26.90 · 손절선 $27.00 · 주문은 내지 않았어요", icon: "chart" });
    const thread = w.h.db.threadFor(idb.getSettings(w.h.db, w.uid)!.thread_id!, w.uid)!;
    expect(thread).toMatchObject({ kind: "schedule", title: "투자", icon: "chart" });

    w.up.state.tossPrices.set("SOXL", { price: 26.5 });
    expect(await tickAt(w, 9, 55)).toEqual({ slots: 1, alerts: 0 }); // still inside: nothing
    w.up.state.tossPrices.set("SOXL", { price: 27.2 });
    expect(await tickAt(w, 10, 0)).toEqual({ slots: 1, alerts: 0 }); // outside once: cleared
    expect(idb.rule(w.h.db, w.uid, rule.id)).toMatchObject({ state: "armed", hit_seq: 1 });
    w.up.state.tossPrices.set("SOXL", { price: 26.95 });
    expect(await tickAt(w, 10, 5)).toEqual({ slots: 1, alerts: 1 }); // touched again: a new alert
    const keys = (w.h.db.sql.query("SELECT dedupe_key FROM invest_alerts WHERE user_id = $u ORDER BY created_at").all({ u: w.uid }) as { dedupe_key: string }[]).map((x) => x.dedupe_key);
    expect(keys).toEqual([`${rule.id}:1:1`, `${rule.id}:1:2`]);

    // G8: the watch moved nothing the person set
    expect(idb.rule(w.h.db, w.uid, rule.id)).toMatchObject({ price: 27, direction: "below", action: "notify", rev: 1 });
    // a restarted hub does not run a slot it already ran
    const { InvestHub } = await import("../src/invest/hub.ts");
    const again = new InvestHub(w.h.app.core);
    expect(await again.tick(ET(10, 6))).toEqual({ slots: 0, alerts: 0 });
    await expectClean(w);
  });

  test("the earlier state is not known: first look, after an edit, after a gap", async () => {
    const w = await world();
    await connectToss(w);
    await watch(w, "SOXL");
    w.up.state.tossPrices.set("SOXL", { price: 26 });
    const r1 = await addRule(w, { symbol: "SOXL", kind: "stop", price: 27, action: "notify" });
    await tickAt(w, 9, 45);
    expect(alerts(w).at(-1)!.titleLines).toEqual(["감시를 시작할 때 이미 아래에 있었어요."]);
    expect(banners(w).at(-1)!.title).toBe("SOXL 손절 관찰가 도달");

    // an edit that moves the line: the next touch says so
    const cur = idb.rule(w.h.db, w.uid, r1.id)!;
    expect((await api(w, "PATCH", `/api/invest/rules/${r1.id}`, { changes: { price: 26.5 }, ifRev: cur.rev })).status).toBe(200);
    expect(idb.rule(w.h.db, w.uid, r1.id)).toMatchObject({ state: "armed", seen_slot: "@edited", rev: 2 });
    await tickAt(w, 9, 50);
    expect(alerts(w).at(-1)!.titleLines).toEqual(["규칙을 고칠 때 이미 아래에 있었어요."]);

    // a gap: outside at 09:55, no quote at 10:00, inside at 10:05
    w.up.state.tossPrices.set("SOXL", { price: 27 });
    await tickAt(w, 9, 55);
    w.up.state.tossPrices.delete("SOXL");
    await tickAt(w, 10, 0);
    w.up.state.tossPrices.set("SOXL", { price: 26 });
    await tickAt(w, 10, 5);
    expect(alerts(w).at(-1)!.titleLines).toEqual(["시세를 받지 못한 사이에 닿았어요. 닿은 시각은 몰라요."]);
    expect(alerts(w)).toHaveLength(3);
  });

  test("resistance with an unknown earlier state is '위에 있어요', not a breakout", async () => {
    const w = await world();
    await connectToss(w);
    await watch(w, "SOXL");
    w.up.state.tossPrices.set("SOXL", { price: 35 });
    // resistance rules come from proposals (B2); the row is put in directly here
    idb.insertRule(w.h.db, {
      id: "ir_res",
      user_id: w.uid,
      symbol: "SOXL",
      kind: "resistance",
      level: null,
      price: 34.1,
      lo: null,
      hi: null,
      direction: "above",
      action: "notify",
      once: 0,
      buffer_pct: null,
      conditions_json: null,
      until_day: null,
      state: "armed",
      hit_at: null,
      hit_seq: 0,
      cleared_at: null,
      paused_at: null,
      seen_slot: null,
      real_confirmed_at: null,
      rev: 1,
      created_by: "proposal",
      created_at: w.h.clock.t,
      updated_at: w.h.clock.t,
    });
    await tickAt(w, 9, 45);
    expect(alerts(w).at(-1)).toMatchObject({ kind: "breakout", title: "SOXL이 저항 $34.10 위에 있어요", noPrior: true, titleLines: ["감시를 시작할 때 이미 위에 있었어요."] });
    expect(banners(w).at(-1)!.title).toBe("SOXL 저항 위");
    w.up.state.tossPrices.set("SOXL", { price: 34 });
    await tickAt(w, 9, 50);
    w.up.state.tossPrices.set("SOXL", { price: 34.5 });
    await tickAt(w, 9, 55);
    expect(alerts(w).at(-1)).toMatchObject({ kind: "breakout", title: "SOXL이 저항 $34.10을 넘었어요" });
    expect(alerts(w).at(-1)!.noPrior).toBeUndefined();
    expect(banners(w).at(-1)!.title).toBe("SOXL 저항 돌파");
  });

  test("once: alerts and stops; any save watches it again with the earlier state unknown", async () => {
    const w = await world();
    await connectToss(w);
    await watch(w, "SOXL");
    w.up.state.tossPrices.set("SOXL", { price: 31 });
    const r = await addRule(w, { symbol: "SOXL", kind: "target", level: 1, price: 30, action: "notify", once: true });
    await tickAt(w, 9, 45);
    expect(alerts(w).at(-1)!.notes).toContain("이 규칙은 한 번 알리고 멈췄어요.");
    const row = (await api<InvestOverview>(w, "GET", "/api/invest")).body.rules[0]!;
    expect(row).toMatchObject({ state: "paused", once: true });
    expect(row.stateText).toMatch(/^멈춤 · \d\d-\d\d \d\d:\d\d$/);
    expect(row.stateFoot).toMatch(/에 닿아서 멈췄어요\.$/);
    await tickAt(w, 9, 50);
    await tickAt(w, 9, 55);
    expect(alerts(w)).toHaveLength(1);
    expect((await api(w, "PATCH", `/api/invest/rules/${r.id}`, { changes: { once: true }, ifRev: row.rev })).status).toBe(200);
    expect(idb.rule(w.h.db, w.uid, r.id)).toMatchObject({ state: "armed", seen_slot: "@resumed" });
    await tickAt(w, 10, 0);
    expect(alerts(w).at(-1)!.titleLines).toEqual(["다시 감시할 때 이미 위에 있었어요."]);
  });

  test("close basis: waits between the buffer and the stop, decides at the close check; below the buffer at once", async () => {
    const w = await world();
    await connectToss(w);
    await watch(w, "SOXL");
    w.up.state.yahooDaily.set("SOXL", syntheticBars(DAY, 30, 28, 3)); // ATR ≈ 3 > 28 − 27
    w.up.state.tossPrices.set("SOXL", { price: 28 });
    await addRule(w, { symbol: "SOXL", kind: "stop", price: 27, action: "notify" });
    const p = await api<Record<string, unknown>>(w, "POST", "/api/invest/rules/preview", { symbol: "SOXL", kind: "stop", price: 27, action: "notify" });
    expect(p.body).toMatchObject({ basis: "close_and_intraday", sentence: "SOXL에 손절 $27.00 이하 규칙을 더해요. 종가가 $27.00 이하로 마감하거나 장중에 $25.65 이하로 내려가면 알려요." });
    await tickAt(w, 9, 45);
    w.up.state.tossPrices.set("SOXL", { price: 26 });
    await tickAt(w, 9, 50);
    await tickAt(w, 15, 0);
    await tickAt(w, 16, 0); // the last session slot is not the close check
    expect(alerts(w)).toHaveLength(0);
    await tickAt(w, 16, 5);
    expect(alerts(w)).toHaveLength(1);
    // the daily bars were read once for the day, with the default User-Agent (no header set)
    const daily = w.up.calls.filter((c) => c.host === "query1.finance.yahoo.com" && c.path.includes("range=1y"));
    expect(daily).toHaveLength(1);
    expect(daily.every((c) => c.userAgent === null)).toBe(true);

    // next day: below the buffer during the session alerts at once
    const next = "2026-12-01";
    w.up.state.tossPrices.set("SOXL", { price: 28 });
    await tickAt(w, 9, 45, next);
    w.up.state.tossPrices.set("SOXL", { price: 25.6 });
    await tickAt(w, 9, 50, next);
    expect(alerts(w)).toHaveLength(2);
  });

  test("mock sell stop: a record with the sellable quantity, then paused; zero sellable is skipped; no order call", async () => {
    const w = await world();
    await connectToss(w);
    await watch(w, "SOXL");
    await watch(w, "SOXS");
    w.up.state.tossHoldings = [
      { symbol: "SOXL", quantity: 47, averagePrice: 30 },
      { symbol: "SOXS", quantity: 0 },
    ];
    w.up.state.tossSellable.set("SOXL", 47);
    w.up.state.tossSellable.set("SOXS", 0);
    w.up.state.tossPrices.set("SOXL", { price: 27.5 });
    w.up.state.tossPrices.set("SOXS", { price: 11 });
    const r = await addRule(w, { symbol: "SOXL", kind: "stop", price: 27, action: "sell" });
    await addRule(w, { symbol: "SOXS", kind: "stop", price: 10, action: "sell" });
    await tickAt(w, 9, 45);
    w.up.state.tossPrices.set("SOXL", { price: 26.8 });
    w.up.state.tossPrices.set("SOXS", { price: 9.5 });
    await tickAt(w, 9, 50);
    const stops = investCards(w).filter((c): c is InvestStopCard => c.type === "invest_stop");
    expect(stops).toHaveLength(2);
    const soxl = stops.find((c) => c.symbol === "SOXL")!;
    expect(soxl).toMatchObject({ mode: "mock", state: "recorded", title: "실제 주문이었다면 47주를 팔았을 거예요", hero: { v: 26.8 }, disclaimer: true });
    expect(soxl.notes).toContain("주문은 내지 않았어요.");
    expect(soxl.rows.find((x) => x.label === "평단 대비")!.value).toBe("−10.67%"); // U+2212 (format.ts)
    const soxs = stops.find((c) => c.symbol === "SOXS")!;
    expect(soxs).toMatchObject({ state: "skipped", title: "팔 수 있는 수량이 0주라서 주문을 내지 않았어요", reason: { code: "zero_sellable" } });
    expect(banners(w).map((b) => b.title)).toEqual(expect.arrayContaining(["SOXL 모의 손절 기록", "SOXS 손절 주문 건너뜀"]));
    expect(idb.rule(w.h.db, w.uid, r.id)).toMatchObject({ state: "paused", price: 27, action: "sell", rev: 1 });
    const order = w.h.db.sql.query("SELECT * FROM invest_orders WHERE rule_id = $r").get({ r: r.id }) as idb.OrderRow;
    expect(order).toMatchObject({ mode: "mock", state: "recorded", qty: 47, client_order_id: `${r.id}:1:1`, toss_order_id: null });
    // the card never says it sold (G8-7)
    expect(JSON.stringify(investCards(w))).not.toMatch(/팔았어요|매도 완료|체결/);
    // G8: Toss saw only the token POST and GETs; no order path at all
    const toss = w.up.calls.filter((c) => c.host === new URL(FAKE_TOSS_BASE).host);
    expect(toss.filter((c) => c.method !== "GET").map((c) => c.path)).toEqual(toss.filter((c) => c.method !== "GET").map(() => "/oauth2/token"));
    expect(toss.some((c) => /order/i.test(c.path))).toBe(false);
    // paused: later checks send nothing
    await tickAt(w, 9, 55);
    expect(investCards(w).filter((c) => c.type === "invest_stop")).toHaveLength(2);
    await expectClean(w);
  });

  test("expiry: the deadline day's close check ends the rule with its own card", async () => {
    const w = await world();
    await connectToss(w);
    await watch(w, "SOXL");
    w.up.state.tossPrices.set("SOXL", { price: 28 });
    const r = await addRule(w, { symbol: "SOXL", kind: "stop", price: 27, action: "notify", until: DAY });
    expect(r.stateText).toBe("11-30까지");
    await tickAt(w, 16, 0);
    expect(alerts(w)).toHaveLength(0);
    await tickAt(w, 16, 5);
    expect(alerts(w).at(-1)).toMatchObject({ kind: "expired", title: "SOXL 감시 기간이 끝났어요", titleLines: ["11월 30일까지였던 손절 알림을 더 보지 않아요."], disclaimer: true });
    expect(alerts(w).at(-1)!.price).toBeUndefined();
    expect(banners(w).at(-1)!.title).toBe("SOXL 감시 기간 끝");
    expect(idb.rule(w.h.db, w.uid, r.id)!.state).toBe("expired");
    await tickAt(w, 9, 45, "2026-12-01");
    expect(alerts(w)).toHaveLength(1);
    await expectClean(w);
  });

  test("blind: no quote for 15 minutes of the session with a live rule; one banner a day", async () => {
    const w = await world({ toss: false });
    await watch(w, "SOXL");
    await addRule(w, { symbol: "SOXL", kind: "stop", price: 27, action: "notify" });
    w.up.state.yahoo.set("SOXL", 429);
    const quoteCalls = () => w.up.calls.filter((c) => c.host === "query1.finance.yahoo.com" && c.path.includes("range=1d")).length;
    const added = quoteCalls(); // the watchlist add asked once (500: no name, no quote)
    await tickAt(w, 9, 45);
    // Yahoo answered 429 once and rests until the next day: no second request
    expect(quoteCalls()).toBe(added + 1);
    expect(idb.sourcePausedUntil(w.h.db, "yahoo")).toBe(ET(0, 0, "2026-12-01"));
    await tickAt(w, 9, 50);
    await tickAt(w, 9, 55);
    expect(quoteCalls()).toBe(added + 1);
    expect((await api<InvestOverview>(w, "GET", "/api/invest")).body.watch.state).toBe("ok");
    await tickAt(w, 10, 0);
    const ov = (await api<InvestOverview>(w, "GET", "/api/invest")).body;
    expect(ov.watch).toMatchObject({ state: "blind", tone: "caution" });
    expect(ov.watch.text).toMatch(/^시세를 받지 못하고 있어요 · .+부터$/);
    expect(ov.quotesFoot).toBe(ov.watch.foot!);
    const blind = banners(w).filter((b) => b.title === "시세를 받지 못하고 있어요");
    expect(blind).toHaveLength(1);
    expect(blind[0]!.body).toBe("23:45부터 가격 확인이 멈췄어요. 손절선 확인도 멈춰 있어요.");
    await tickAt(w, 10, 5);
    expect(banners(w).filter((b) => b.title === "시세를 받지 못하고 있어요")).toHaveLength(1);
    expect(alerts(w)).toHaveLength(0);
    await expectClean(w);
  });

  test("odd numbers (a zero average price, a zero previous close) never print NaN or Infinity", async () => {
    const w = await world();
    await connectToss(w);
    await watch(w, "SOXL");
    w.up.state.tossHoldings = [{ symbol: "SOXL", quantity: 3, averagePrice: 0 }];
    w.up.state.tossSellable.set("SOXL", 3);
    // no Toss price for it: Yahoo's quote (with its previous close, here 0) is the one the watch reads
    w.up.state.yahoo.set("SOXL", { price: 27.5, prevClose: 0, time: Math.floor(ET(9, 44) / 1000) });
    await addRule(w, { symbol: "SOXL", kind: "stop", price: 27, action: "sell" });
    await addRule(w, { symbol: "SOXL", kind: "target", level: 1, price: 27.2, action: "notify" });
    await tickAt(w, 9, 45);
    w.up.state.yahoo.set("SOXL", { price: 26.9, prevClose: 0, time: Math.floor(ET(9, 49) / 1000) });
    await tickAt(w, 9, 50);
    expect(investCards(w).every((c) => c.foot.includes("Yahoo"))).toBe(true);
    expect(investCards(w).length).toBeGreaterThanOrEqual(2);
    await expectClean(w);
  });

  test("the last ATR serves 5 market days without daily bars, as of its last bar; then intraday with the DD line", async () => {
    const w = await world();
    await connectToss(w);
    await watch(w, "SOXL");
    w.up.state.yahooDaily.set("SOXL", syntheticBars(DAY, 30, 28, 3)); // last bar 11-27, ATR ≈ 3 > 28 − 27
    w.up.state.tossPrices.set("SOXL", { price: 28 });
    const draft = { symbol: "SOXL", kind: "stop", price: 27, action: "notify" };
    const basisOn = async (day: string) => {
      w.h.clock.t = ET(9, 40, day);
      const p = (await api<Record<string, unknown>>(w, "POST", "/api/invest/rules/preview", draft)).body;
      return { basis: p.basis, foot: p.bufferFoot as string };
    };
    expect((await basisOn(DAY)).basis).toBe("close_and_intraday");
    w.up.state.yahooDaily.delete("SOXL"); // Yahoo has no bars from here on
    expect((await basisOn("2026-12-01")).basis).toBe("close_and_intraday"); // 2 market days after 11-27
    expect((await basisOn("2026-12-04")).basis).toBe("close_and_intraday"); // 5
    const late = await basisOn("2026-12-07"); // 6: too old
    expect(late.basis).toBe("intraday");
    expect(late.foot.startsWith("지금은 장중 가격만으로 판단해요. ")).toBe(true);
    // the kept ATR decides a stop on 12-04, and the ledger keeps its as_of
    await addRule(w, draft);
    w.up.state.tossPrices.set("SOXL", { price: 28 });
    await tickAt(w, 9, 45, "2026-12-04");
    w.up.state.tossPrices.set("SOXL", { price: 26.5 }); // under the stop, above the buffer $25.65: close basis waits
    await tickAt(w, 9, 50, "2026-12-04");
    expect(alerts(w)).toHaveLength(0);
    w.up.state.tossPrices.set("SOXL", { price: 25.6 });
    await tickAt(w, 9, 55, "2026-12-04");
    expect(alerts(w)).toHaveLength(1);
    const led = w.h.db.sql.query("SELECT as_of, value FROM invest_ledger WHERE user_id = $u AND id = 'atr14.SOXL'").get({ u: w.uid }) as { as_of: string; value: number };
    expect(led.as_of).toBe("2026-11-27");
    expect(led.value).toBeCloseTo(3, 5);
    expect(alerts(w)[0]!.notes).not.toContain("지금은 장중 가격만으로 판단해요."); // mock mode: no line
  });

  test("real mode without an ATR: the stop is judged intraday and the card says so; mock mode does not", async () => {
    const w = await world();
    await connectToss(w);
    await watch(w, "SOXL");
    w.up.state.tossHoldings = [{ symbol: "SOXL", quantity: 10, averagePrice: 30 }];
    w.up.state.tossSellable.set("SOXL", 10);
    w.up.state.tossPrices.set("SOXL", { price: 27.5 });
    await addRule(w, { symbol: "SOXL", kind: "stop", price: 27, action: "notify" }); // no daily bars at all
    await tickAt(w, 9, 45);
    w.up.state.tossPrices.set("SOXL", { price: 26.9 });
    await tickAt(w, 9, 50);
    expect(alerts(w).at(-1)!.notes).not.toContain("지금은 장중 가격만으로 판단해요.");
    idb.updateSettings(w.h.db, w.uid, { mode: "real" }, w.h.clock.t);
    w.up.state.tossPrices.set("SOXL", { price: 27.3 });
    await tickAt(w, 9, 55); // outside once: cleared
    w.up.state.tossPrices.set("SOXL", { price: 26.8 });
    await tickAt(w, 10, 0);
    expect(alerts(w)).toHaveLength(2);
    expect(alerts(w).at(-1)!.notes).toContain("지금은 장중 가격만으로 판단해요.");
    // a sell stop's record says it too
    await addRule(w, { symbol: "SOXL", kind: "stop", price: 26.5, action: "sell" });
    w.up.state.tossPrices.set("SOXL", { price: 26.4 });
    await tickAt(w, 10, 5);
    const rec = investCards(w).filter((c): c is InvestStopCard => c.type === "invest_stop").at(-1)!;
    expect(rec.notes).toContain("지금은 장중 가격만으로 판단해요.");
    await expectClean(w);
  });
});

// ───────────────────────────── Toss ─────────────────────────────

describe("invest Toss status", () => {
  test("a saved key is checked once; the allowed-IP 403 after a new token is ip_not_allowed and rests the person's Toss calls", async () => {
    const w = await world();
    w.up.state.tossHoldings = [{ symbol: "SOXL", quantity: 3, averagePrice: 29 }];
    const credId = await connectToss(w);
    let st = (await api<InvestOverview>(w, "GET", "/api/invest")).body.settings;
    expect(st.toss).toMatchObject({ connected: true, error: null, outboundIp: "203.0.113.7" });
    expect(st.toss.okAt).not.toBeNull();
    expect(st.realBlockers).toEqual([]);
    expect(w.up.calls.filter((c) => c.path === "/oauth2/token")).toHaveLength(1);
    const tok = w.up.calls.find((c) => c.path === "/oauth2/token")!;
    expect(tok.body).toContain("grant_type=client_credentials");
    expect(w.up.calls.find((c) => c.path === "/api/v1/holdings")).toMatchObject({ auth: "Bearer tok-1", account: "7" });

    // check again within a minute: 429
    expect(await api(w, "POST", "/api/invest/toss/check")).toEqual({ status: 429, body: { error: "toss_check_too_soon", message: "조금 뒤에 다시 확인해 주세요." } });
    w.h.clock.t += 61_000;
    w.up.state.tossStatus = 403;
    const before = w.up.calls.length;
    const chk = await api<{ error: { code: string; text: string } }>(w, "POST", "/api/invest/toss/check");
    expect(chk.status).toBe(200);
    expect(chk.body.error).toMatchObject({ code: "ip_not_allowed", text: "토스증권이 접속을 막았어요(허용 IP)" });
    const tried = w.up.calls.slice(before).map((c) => c.path);
    expect(tried).toEqual(["/api/v1/holdings", "/oauth2/token", "/api/v1/holdings"]); // once more with a new token
    st = (await api<InvestOverview>(w, "GET", "/api/invest")).body.settings;
    expect(st.realBlockers).toEqual(["toss_ip_blocked"]);

    // the watch does not call Toss while it rests
    await watch(w, "SOXL");
    await addRule(w, { symbol: "SOXL", kind: "alert", price: 40, direction: "above", action: "notify" });
    const n = w.up.calls.filter((c) => c.host === new URL(FAKE_TOSS_BASE).host).length;
    await tickAt(w, 9, 45);
    expect(w.up.calls.filter((c) => c.host === new URL(FAKE_TOSS_BASE).host)).toHaveLength(n);

    // the key deleted: not connected, mock
    expect((await api(w, "DELETE", `/api/credentials/${credId}`)).status).toBe(200);
    st = (await api<InvestOverview>(w, "GET", "/api/invest")).body.settings;
    expect(st.toss.connected).toBe(false);
    expect(st.mode).toBe("mock");
    expect(st.realBlockers).toEqual(["toss_not_connected"]);
  });

  test("no Toss calls without PICKLE_TOSS_BASE, even with a saved key", async () => {
    const w = await world({ toss: false, sources: false });
    await connectToss(w);
    await watch(w, "SOXL");
    await addRule(w, { symbol: "SOXL", kind: "stop", price: 27, action: "notify" });
    await tickAt(w, 9, 45);
    expect(w.up.calls).toEqual([]);
    expect((await api<InvestOverview>(w, "GET", "/api/invest")).body.settings.toss).toMatchObject({ connected: false, error: { code: "off", text: "이 서버는 토스증권에 연결하지 않아요" } });
  });

  test("Toss on but no key saved and public sources off: the watch is off, never blind", async () => {
    const w = await world({ sources: false });
    await watch(w, "SOXL");
    await addRule(w, { symbol: "SOXL", kind: "stop", price: 27, action: "notify" });
    for (const [h, m] of [[9, 45], [9, 50], [9, 55], [10, 0], [10, 5]] as const) await tickAt(w, h, m);
    expect((await api<InvestOverview>(w, "GET", "/api/invest")).body.watch.state).toBe("off");
    expect(banners(w).filter((b) => b.title === "시세를 받지 못하고 있어요")).toHaveLength(0);
    expect(w.up.calls).toEqual([]);
  });

  test("key material never reaches events, rows, logs or upstream paths", async () => {
    const w = await world();
    await connectToss(w);
    await watch(w, "SOXL");
    w.up.state.tossSellable.set("SOXL", 5);
    w.up.state.tossPrices.set("SOXL", { price: 26 });
    await addRule(w, { symbol: "SOXL", kind: "stop", price: 27, action: "sell" });
    await tickAt(w, 9, 45);
    w.up.state.tossStatus = 401;
    await tickAt(w, 9, 50);
    const secrets = [BOGUS_TOSS_SECRET.clientKey, BOGUS_TOSS_SECRET.secretKey];
    const dump = [
      JSON.stringify(w.events),
      w.logs.join("\n"),
      JSON.stringify(w.h.db.sql.query("SELECT * FROM messages").all()),
      ...["invest_settings", "invest_alerts", "invest_orders", "invest_ledger", "invest_cache", "invest_previews", "invest_calls", "invest_source_state"].map((t) => JSON.stringify(w.h.db.sql.query(`SELECT * FROM ${t}`).all())),
      w.up.calls.map((c) => `${c.path} ${c.auth}`).join("\n"),
    ].join("\n");
    for (const s of secrets) expect(dump).not.toContain(s);
    // the key went only into token request bodies (the 401 asked for one new token, then stopped)
    const withKey = w.up.calls.filter((c) => c.body?.includes(BOGUS_TOSS_SECRET.secretKey)).map((c) => c.path);
    expect(withKey).toEqual(["/oauth2/token", "/oauth2/token"]);
  });
});

// ───────────────────────────── calls ─────────────────────────────

describe("invest calls", () => {
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

  const verified = (w: World) => writeMyPhone(w.h.app.core, w.uid, { e164: "+821012345678", verifiedAt: w.h.clock.t, codeHash: null, codeExpiresAt: 0, attempts: 0 });

  test("a call rule dials the verified number and the card says so; 10 a day, then the card says why not", async () => {
    const w = await world({ twilio: true });
    verified(w);
    await connectToss(w);
    await watch(w, "SOXL");
    w.up.state.tossHoldings = [{ symbol: "SOXL", quantity: 10, averagePrice: 30 }];
    await addRule(w, { symbol: "SOXL", kind: "stop", price: 27, action: "notify" });
    const r = await addRule(w, { symbol: "SOXL", kind: "alert", price: 30, direction: "above", action: "call" });
    // after 10:00 ET (00:00 KST): the day the 10 calls count in is the KST day
    w.up.state.tossPrices.set("SOXL", { price: 29 });
    await tickAt(w, 10, 0);
    w.up.state.tossPrices.set("SOXL", { price: 30.5 });
    await tickAt(w, 10, 5);
    expect(twilio).toHaveLength(1);
    const twiml = twilio[0]!.get("Twiml") ?? "";
    // G7: what, at what price, so what (the stop line, the holding), the market — and nothing else
    expect(twiml).toContain("깽이예요. 투자 알림이에요. SOXL이 알림 가격 30.00달러에 닿았어요. 지금 가격은 30.50달러예요. 손절선 27.00달러보다 3.50달러 위예요. 보유한 10주는 평단보다 1.67% 높아요. 시장 상태는 이번에는 확인하지 못했어요.");
    expect(twiml).not.toMatch(/면책|투자 판단|권유|사세요|파세요|채팅에서/);
    expect(alerts(w).at(-1)!.call).toMatchObject({ ok: true });
    expect(alerts(w).at(-1)!.call!.text).toMatch(/^전화로 알렸어요 · \d\d:\d\d$/);

    // nine more calls used today (another rule's), then the next touch is over the limit
    for (let i = 0; i < 9; i++) idb.insertCall(w.h.db, { id: `ic_x${i}`, user_id: w.uid, ref: "x", state: "dialing", at: w.h.clock.t });
    w.up.state.tossPrices.set("SOXL", { price: 29 });
    await tickAt(w, 10, 10);
    w.up.state.tossPrices.set("SOXL", { price: 31 });
    await tickAt(w, 10, 15);
    expect(twilio).toHaveLength(1);
    expect(alerts(w).at(-1)!.call).toEqual({ at: expect.any(Number), ok: false, reason: "daily_limit", text: "전화를 걸지 못했어요 · 오늘 투자 전화 10통을 다 썼어요" });
    expect(idb.rule(w.h.db, w.uid, r.id)!.action).toBe("call");
  });

  test("an unverified number: no dial, the card says why", async () => {
    const w = await world({ twilio: true });
    await connectToss(w);
    await watch(w, "SOXL");
    await addRule(w, { symbol: "SOXL", kind: "alert", price: 30, direction: "above", action: "call" });
    w.up.state.tossPrices.set("SOXL", { price: 31 });
    await tickAt(w, 9, 45);
    expect(twilio).toHaveLength(0);
    expect(alerts(w).at(-1)!.call).toMatchObject({ ok: false, reason: "not_verified", text: "전화를 걸지 못했어요 · 번호를 인증하지 않았어요" });
    expect((await api<InvestOverview>(w, "GET", "/api/invest")).body.settings.callBlock).toBe("not_verified");
  });
});

// ───────────────────────────── G8 boundaries, one by one ─────────────────────────────

describe("invest G8 boundaries", () => {
  test("people are apart: another person's rule id is 404 to preview, PATCH and DELETE; watchlist, alerts and rules stay theirs", async () => {
    const w = await world();
    await connectToss(w);
    await watch(w, "SOXL");
    const mine = await addRule(w, { symbol: "SOXL", kind: "stop", price: 27, action: "notify" });
    w.up.state.tossPrices.set("SOXL", { price: 27.5 });
    await tickAt(w, 9, 45);
    w.up.state.tossPrices.set("SOXL", { price: 26.9 });
    await tickAt(w, 9, 50);
    expect(alerts(w)).toHaveLength(1);
    const bob = await w.h.signup("bob");
    const as = async (method: string, path: string, body?: unknown) => {
      const res = await w.h.req(method, path, { token: bob.token, body });
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    };
    expect(await as("POST", "/api/invest/rules/preview", { ruleId: mine.id, changes: { price: 20 } })).toMatchObject({ status: 404, body: { error: "rule_not_found" } });
    expect(await as("PATCH", `/api/invest/rules/${mine.id}`, { changes: { price: 20 }, ifRev: mine.rev })).toMatchObject({ status: 404, body: { error: "rule_not_found" } });
    expect(await as("DELETE", `/api/invest/rules/${mine.id}`)).toMatchObject({ status: 404, body: { error: "rule_not_found" } });
    expect(await as("DELETE", "/api/invest/watchlist/SOXL?withRules=1")).toMatchObject({ status: 404, body: { error: "not_watched" } });
    expect(idb.rule(w.h.db, w.uid, mine.id)).toMatchObject({ price: 27, rev: mine.rev, action: "notify" });
    expect(idb.watchRow(w.h.db, w.uid, "SOXL")).not.toBeNull();
    // the same symbol on Bob's own list shows none of Alice's rules or alerts
    expect((await as("POST", "/api/invest/watchlist", { symbol: "SOXL" })).status).toBeLessThan(300);
    const d = await as("GET", "/api/invest/symbols/SOXL");
    expect(d.status).toBe(200);
    expect(d.body.rules).toEqual([]);
    expect(d.body.alerts).toEqual([]);
    expect(((await as("GET", "/api/invest")).body as unknown as InvestOverview).rules).toEqual([]);
    // and below the routes: a rule read or delete under the wrong person finds nothing
    const bid = bob.session.user.id;
    expect(idb.rule(w.h.db, bid, mine.id)).toBeNull();
    expect(idb.deleteRule(w.h.db, bid, mine.id)).toBe(false);
    expect(idb.rule(w.h.db, w.uid, mine.id)).not.toBeNull();
    expect(idb.recentAlerts(w.h.db, bid, "SOXL")).toEqual([]);
    expect(idb.recentAlerts(w.h.db, w.uid, "SOXL")).toHaveLength(1);
  });

  test("real mode never sells what is not held: a sell stop or a change to sell at zero sellable is 400 not_held", async () => {
    const w = await world();
    await connectToss(w);
    await watch(w, "SOXL");
    w.up.state.tossPrices.set("SOXL", { price: 28 });
    w.up.state.tossSellable.set("SOXL", 0);
    // mock mode takes it (the record says it skipped, at the time)
    expect((await api(w, "POST", "/api/invest/rules", { draft: { symbol: "SOXL", kind: "stop", price: 26, action: "sell" } })).status).toBe(201);
    idb.updateSettings(w.h.db, w.uid, { mode: "real" }, w.h.clock.t); // B1 has no route that turns real on
    const sell = await api<Record<string, unknown>>(w, "POST", "/api/invest/rules", { draft: { symbol: "SOXL", kind: "stop", price: 27, action: "sell" } });
    expect(sell).toEqual({ status: 400, body: { error: "not_held", message: "보유한 종목에만 매도를 걸 수 있어요." } });
    const r = await addRule(w, { symbol: "SOXL", kind: "stop", price: 27, action: "notify" });
    const toSell = await api<Record<string, unknown>>(w, "PATCH", `/api/invest/rules/${r.id}`, { changes: { action: "sell" }, ifRev: r.rev });
    expect(toSell).toEqual({ status: 400, body: { error: "not_held", message: "보유한 종목에만 매도를 걸 수 있어요." } });
    expect(idb.rule(w.h.db, w.uid, r.id)).toMatchObject({ action: "notify", rev: r.rev });
    // held: the same change goes through
    w.up.state.tossSellable.set("SOXL", 47);
    expect((await api(w, "PATCH", `/api/invest/rules/${r.id}`, { changes: { action: "sell" }, ifRev: r.rev })).status).toBe(200);
  });

  test("G8-1: the Toss client has no order method (B1 reads only)", async () => {
    const { TossClient } = await import("../src/invest/toss.ts");
    const names = Object.getOwnPropertyNames(TossClient.prototype).sort();
    expect(names).toEqual(["base", "connected", "constructor", "forget", "get", "holdings", "prices", "sellable", "token"]);
    expect(names.some((n) => /order|sell$|buy|cancel/i.test(n))).toBe(false);
  });

  test("a used dedupe key is refused; a watch write with a stale rev changes nothing", async () => {
    const w = await world({ sources: false, toss: false });
    await watch(w, "SOXL");
    const r = await addRule(w, { symbol: "SOXL", kind: "stop", price: 27, action: "notify" });
    const row = (k: string) => ({
      id: `ia_${k}`,
      user_id: w.uid,
      rule_id: r.id,
      symbol: "SOXL",
      kind: "stop",
      dedupe_key: `${r.id}:1:1`,
      price: 26,
      observed_at: 1,
      source: "toss",
      title: "",
      thread_id: null,
      message_id: null,
      call_state: null,
      called_at: null,
      created_at: 1,
    });
    expect(idb.insertAlert(w.h.db, row("a"))).toBe(true);
    expect(idb.insertAlert(w.h.db, row("b"))).toBe(false);
    const before = idb.rule(w.h.db, w.uid, r.id)!;
    expect(idb.updateRuleWatch(w.h.db, r.id, before.rev + 1, { state: "hit", hit_at: 5, hit_seq: 1, cleared_at: null, paused_at: null, seen_slot: "x" }, 5)).toBe(false);
    expect(idb.rule(w.h.db, w.uid, r.id)).toEqual(before);
  });

  test("a save between the watch's read and its alert wins: no alert for the old rule", async () => {
    const w = await world();
    await connectToss(w);
    await watch(w, "SOXL");
    const r = await addRule(w, { symbol: "SOXL", kind: "stop", price: 27, action: "notify" });
    w.up.state.tossPrices.set("SOXL", { price: 27.5 });
    await tickAt(w, 9, 45);
    w.up.state.tossPrices.set("SOXL", { price: 26.9 });
    // the person moves the stop after the 09:50 check read the rule, while it fetches the daily bars for the stop basis
    w.h.db.sql.exec("DELETE FROM invest_cache");
    const realFetch = w.up.fetch;
    let saved = false;
    w.h.app.core.invest.gate["fetchFn" as never] = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (!saved && String(input).includes("range=1y")) {
        saved = true;
        const cur = idb.rule(w.h.db, w.uid, r.id)!;
        expect((await api(w, "PATCH", `/api/invest/rules/${r.id}`, { changes: { price: 25 }, ifRev: cur.rev })).status).toBe(200);
      }
      return realFetch(input, init);
    }) as never;
    await tickAt(w, 9, 50);
    expect(saved).toBe(true);
    expect(alerts(w)).toHaveLength(0);
    expect(idb.rule(w.h.db, w.uid, r.id)).toMatchObject({ price: 25, rev: 2, state: "armed", seen_slot: "@edited" });
  });
});
