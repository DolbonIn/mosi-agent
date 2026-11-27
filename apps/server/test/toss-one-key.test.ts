/**
 * One Toss login for the whole app (team-lead 0059, agent-runtime 0057): the invest watch reads the k-skill connection
 * `toss-investment` (saved from 연결 › 토스증권), and it and the agent's Toss tools share that login's one live token
 * (ConnectionRegistry session). The vault here is the real one (bogus key material sealed for a test enclave); the
 * catalog is @pickle/skills' own 토스증권 entry, so its check (verifyToss) runs as on the server. Every Toss request,
 * from either side, lands on test/fake-toss.ts: the skills' fetch maps the official origin onto it, and any other
 * outbound fetch fails the test. Nothing real is called.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext, ToolResult } from "@pickle/agent";
import type { ConnectResponse, InvestOverview, SaveCredentialRequest } from "@pickle/protocol";
import { connectionServices, resetDirectState, setFetch, skillTools, type TossSession } from "@pickle/skills";
import { Enclave, Vault } from "@pickle/vault";
import { sealForEnclave } from "@pickle/vault/client";
import * as idb from "../src/invest/db.ts";
import { TOSS_SERVICE, TossClient } from "../src/invest/toss.ts";
import { FAKE_TOSS_BASE, makeInvestUpstream } from "./fake-toss.ts";
import { makeHarness, type Harness } from "./helpers.ts";

const OFFICIAL = "https://openapi.tossinvest.com";
const ALICE_KEY = { clientId: "ci-bogus-alice-1", clientSecret: "cs-bogus-alice-1" };
const BOB_KEY = { clientId: "ci-bogus-bob-2", clientSecret: "cs-bogus-bob-2" };
const KSKILL_UA = /k-skill client/;

const MASTER = new Uint8Array(32).fill(9);
let enclaveDir = "";
let enclave: Enclave;
beforeAll(async () => {
  enclaveDir = mkdtempSync(join(tmpdir(), "pickle-toss-enclave-"));
  enclave = await Enclave.load({ dir: enclaveDir, masterKey: MASTER });
});
afterAll(() => rmSync(enclaveDir, { recursive: true, force: true }));

/** fetches that went anywhere but the fake (a real Toss call would be one of these) */
let stray: string[] = [];
const realFetch = globalThis.fetch;
type Up = ReturnType<typeof makeInvestUpstream>;
let up: Up;

beforeEach(() => {
  stray = [];
  up = makeInvestUpstream();
  resetDirectState();
  // the agent's Toss tools call the official origin: here it is the fake
  setFetch(async (url, init) => {
    const u = new URL(url);
    if (u.origin !== OFFICIAL) {
      stray.push(`skills ${u.origin}`);
      throw new Error("unexpected outbound fetch");
    }
    return up.fetch(`${FAKE_TOSS_BASE}${u.pathname}${u.search}`, init);
  });
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    stray.push(`global ${String(input instanceof Request ? input.url : input)}`);
    throw new Error("unexpected outbound fetch");
  }) as unknown as typeof fetch;
});

const worlds: Harness[] = [];
afterEach(async () => {
  while (worlds.length) await worlds.pop()!.close();
  setFetch(null);
  globalThis.fetch = realFetch;
  // no request ever left for a real host
  expect(stray).toEqual([]);
  expect(up.calls.every((c) => c.host === new URL(FAKE_TOSS_BASE).host)).toBe(true);
});

/** the server with the real vault and @pickle/skills' 토스증권 catalog entry (`catalog: false`: a server without it) */
async function world(o: { catalog?: boolean } = {}): Promise<Harness> {
  const services = o.catalog === false ? [] : connectionServices().filter((s) => s.id === TOSS_SERVICE);
  const h = await makeHarness({
    // the tools compare a token's `exp` with the wall clock; the registry's session clock is the harness's
    now: Date.now(),
    config: { invest: { sources: false, tossBase: FAKE_TOSS_BASE, outboundIp: "203.0.113.7" } },
    deps: ({ db }) => ({
      investFetch: up.fetch,
      vault: new Vault({ enclave, masterKey: MASTER, storage: db.vaultStorage() as never, serviceName: (id) => id }),
      skills: { listSkills: () => [], skillTools: () => [], skillCatalogForPrompt: () => "", connectionServices: () => services },
    }),
  });
  worlds.push(h);
  return h;
}

async function person(h: Harness, handle: string): Promise<{ uid: string; token: string }> {
  const me = await h.signup(handle);
  return { uid: me.session.user.id, token: me.token };
}

async function sealed(uid: string, secret: Record<string, string>): Promise<SaveCredentialRequest> {
  return {
    service: TOSS_SERVICE,
    label: "토스증권",
    kind: "token",
    hint: "토스증권",
    keepFor: "forever",
    envelope: await sealForEnclave(enclave.info(), secret, `${uid}:${TOSS_SERVICE}:token`),
  };
}

/** 연결 › 토스증권 (the same sheet the invest settings row opens) */
async function connect(h: Harness, p: { uid: string; token: string }, secret: Record<string, string>): Promise<ConnectResponse> {
  const res = await h.req("POST", `/api/connections/${TOSS_SERVICE}`, { token: p.token, body: { credential: await sealed(p.uid, secret) } });
  expect(res.status).toBe(200);
  const body = (await res.json()) as ConnectResponse;
  await h.app.core.idle();
  return body;
}

async function overview(h: Harness, p: { token: string }): Promise<InvestOverview> {
  return (await (await h.req("GET", "/api/invest", { token: p.token })).json()) as InvestOverview;
}

/** POST /api/invest/toss/check a minute after the last one */
async function check(h: Harness, p: { token: string }) {
  h.clock.t += 61_000;
  const res = await h.req("POST", "/api/invest/toss/check", { token: p.token });
  expect(res.status).toBe(200);
  await h.app.core.idle();
}

/** the agent's 토스증권 보유 주식 tool, run the way the runtime runs it: the login resolved through the registry */
async function portfolio(h: Harness, uid: string): Promise<ToolResult> {
  const tool = skillTools().find((t) => t.name === "k_toss_portfolio")!;
  return h.app.core.connections.forUser(uid).use(TOSS_SERVICE, { action: "k_toss_portfolio", purpose: "토스증권 보유 주식 확인" }, (conn) =>
    tool.run({}, { connection: conn, signal: new AbortController().signal, status: () => undefined, now: () => new Date() } as unknown as ToolContext),
  );
}

const tokenCalls = () => up.calls.filter((c) => c.path === "/oauth2/token");
const after = (n: number) => up.calls.slice(n);
/** SOXL on the watchlist, held in the account (47 shares): read by the connect check's holdings call */
async function watchHeld(h: Harness, p: { token: string }) {
  up.state.tossHoldings = [{ symbol: "SOXL", quantity: 47, averagePrice: 30 }];
  up.state.tossPrices.set("SOXL", { price: 32.5 });
  expect([200, 201]).toContain((await h.req("POST", "/api/invest/watchlist", { token: p.token, body: { symbol: "SOXL" } })).status);
}
const heldRow = async (h: Harness, p: { token: string }) => (await overview(h, p)).watchlist.find((w) => w.symbol === "SOXL")!.holding;
const session = async (h: Harness, uid: string) => (await h.app.core.connections.sessionFor(uid, TOSS_SERVICE))?.session.get<TossSession>() ?? null;

describe("one Toss login", () => {
  test("the invest watch's service is the catalog's 토스증권: id, kind and the two fields the connect sheet asks for", () => {
    const toss = connectionServices().find((s) => s.name === "토스증권")!;
    expect(toss).toMatchObject({ id: TOSS_SERVICE, kind: "token" });
    expect(toss.fields.map((f) => f.key)).toEqual(["clientId", "clientSecret"]);
  });

  test("connected from 연결 › 토스증권: the check's token serves invest's holdings read (one token request); the BROKERAGE account; the account header on account reads only", async () => {
    const h = await world();
    const a = await person(h, "alice");
    up.state.tossAccounts = [
      { accountNo: "11111111111", accountSeq: 3, accountType: "PENSION" },
      { accountNo: "22222222222", accountSeq: 9, accountType: "BROKERAGE" },
    ];
    up.state.tossHoldings = [{ symbol: "SOXL", quantity: 3, averagePrice: 29 }];
    expect((await connect(h, a, ALICE_KEY)).connection).toMatchObject({ provider: TOSS_SERVICE, status: "connected" });
    const st = (await overview(h, a)).settings;
    expect(st.toss).toMatchObject({ connected: true, error: null });
    expect(st.toss.okAt).not.toBeNull();
    expect(st.realBlockers).toEqual(["orders_off"]); // Toss is fine; the server switch is off in this world (B3b)
    expect(tokenCalls()).toHaveLength(1);
    expect(tokenCalls()[0]!.body).toContain(`client_id=${ALICE_KEY.clientId}`);
    expect(tokenCalls()[0]!.userAgent).toMatch(KSKILL_UA); // the connect check asked; invest reused it
    const holdings = up.calls.filter((c) => c.path === "/api/v1/holdings");
    expect(holdings).toHaveLength(1);
    expect(holdings[0]).toMatchObject({ auth: "Bearer tok-1", account: "9" });
    expect(holdings[0]!.userAgent ?? "").not.toMatch(KSKILL_UA);
    for (const c of up.calls.filter((x) => x.path === "/api/v1/accounts")) expect(c.account).toBeNull();
    expect((await session(h, a.uid))?.token).toBe("tok-1");
    expect((await session(h, a.uid))?.accountSeq).toBe("9");
  });

  test("market data carries no account header; several reads at once ask for one token and one account lookup", async () => {
    const h = await world();
    const a = await person(h, "alice");
    up.state.tossPrices.set("SOXL", { price: 26 });
    up.state.tossSellable.set("SOXL", 5);
    up.state.tossCalendar.set("US:2026-11-30", { open: "2026-11-30T09:30:00-05:00", close: "2026-11-30T16:00:00-05:00" });
    await connect(h, a, ALICE_KEY);
    h.app.core.connections.forget(a.uid, TOSS_SERVICE); // no token, no account in memory
    const n = up.calls.length;
    const c = new TossClient(h.app.core, up.fetch);
    const [hold, price, sell, day] = await Promise.all([c.holdings(a.uid), c.prices(a.uid, ["SOXL"]), c.sellable(a.uid, "SOXL"), c.marketDay(a.uid, "US", "2026-11-30")]);
    expect([hold.ok, price.ok, sell.ok, day.ok]).toEqual([true, true, true, true]);
    const calls = after(n);
    expect(calls.filter((x) => x.path === "/oauth2/token")).toHaveLength(1);
    expect(calls.filter((x) => x.path === "/api/v1/accounts")).toHaveLength(1);
    const header = (p: string) => calls.find((x) => x.path.startsWith(p))!.account;
    expect([header("/api/v1/holdings"), header("/api/v1/sellable-quantity")]).toEqual(["7", "7"]);
    expect([header("/api/v1/prices"), header("/api/v1/market-calendar/US"), header("/api/v1/accounts")]).toEqual([null, null, null]);
  });

  test("the agent's Toss tool and the invest watch share one token, either way round", async () => {
    const h = await world();
    const a = await person(h, "alice");
    up.state.tossHoldings = [{ symbol: "SOXL", quantity: 3, averagePrice: 29 }];
    await connect(h, a, ALICE_KEY);
    // invest (and the connect check) first: the tool asks for no token
    let n = up.calls.length;
    expect((await portfolio(h, a.uid)).ok).toBe(true);
    let calls = after(n);
    expect(calls.filter((x) => x.path === "/oauth2/token")).toHaveLength(0);
    expect(calls.find((x) => x.path.startsWith("/api/v1/holdings"))).toMatchObject({ auth: "Bearer tok-1", account: "7" });
    expect(calls.every((x) => KSKILL_UA.test(x.userAgent ?? ""))).toBe(true);

    // the tool first (nothing in memory): invest's check uses the token the tool got
    h.app.core.connections.forget(a.uid, TOSS_SERVICE);
    n = up.calls.length;
    expect((await portfolio(h, a.uid)).ok).toBe(true);
    expect(after(n).filter((x) => x.path === "/oauth2/token")).toHaveLength(1);
    expect((await session(h, a.uid))?.token).toBe("tok-2");
    n = up.calls.length;
    await check(h, a);
    calls = after(n);
    expect(calls.map((x) => x.path)).toEqual(["/api/v1/holdings"]);
    expect(calls[0]).toMatchObject({ auth: "Bearer tok-2", account: "7" });
    expect(tokenCalls()).toHaveLength(2);
  });

  test("a new token on one side is the other's too: Toss refuses the old one, one side asks again, the other sends the new one", async () => {
    const h = await world();
    const a = await person(h, "alice");
    await connect(h, a, ALICE_KEY);
    // invest finds tok-1 refused: one new token, the read goes through
    up.state.tossRevoked.add("tok-1");
    let n = up.calls.length;
    await check(h, a);
    expect(after(n).map((x) => `${x.path} ${x.auth ?? ""}`)).toEqual(["/api/v1/holdings Bearer tok-1", "/oauth2/token ", "/api/v1/holdings Bearer tok-2"]);
    expect((await overview(h, a)).settings.toss.error).toBeNull();
    // the tool sends tok-2 without asking
    n = up.calls.length;
    expect((await portfolio(h, a.uid)).ok).toBe(true);
    expect(after(n).filter((x) => x.path === "/oauth2/token")).toHaveLength(0);
    expect(after(n).every((x) => x.auth === "Bearer tok-2")).toBe(true);
    // the tool finds tok-2 refused and asks again: invest sends tok-3
    up.state.tossRevoked.add("tok-2");
    expect((await portfolio(h, a.uid)).ok).toBe(true);
    expect((await session(h, a.uid))?.token).toBe("tok-3");
    n = up.calls.length;
    await check(h, a);
    expect(after(n).map((x) => `${x.path} ${x.auth}`)).toEqual(["/api/v1/holdings Bearer tok-3"]);
    expect(tokenCalls()).toHaveLength(3);
  });

  test("the key refused with the new token too: auth, and that token leaves the shared session", async () => {
    const h = await world();
    const a = await person(h, "alice");
    await connect(h, a, ALICE_KEY);
    up.state.tossStatus = 401;
    await check(h, a);
    expect((await overview(h, a)).settings.toss.error).toMatchObject({ code: "auth" });
    expect((await session(h, a.uid))?.token ?? "").toBe("");
    expect(tokenCalls()).toHaveLength(2);
  });

  test("one person's login never serves another: each their own token and account; someone with no login gets no Toss call", async () => {
    const h = await world();
    const a = await person(h, "alice");
    const b = await person(h, "bob");
    const c = await person(h, "carol");
    await connect(h, a, ALICE_KEY);
    const bobFrom = up.calls.length;
    await connect(h, b, BOB_KEY);
    await check(h, b);
    expect((await portfolio(h, b.uid)).ok).toBe(true);
    const sa = await session(h, a.uid);
    const sb = await session(h, b.uid);
    expect(sa?.token).toBeTruthy();
    expect(sb?.token).toBeTruthy();
    expect(sb!.token).not.toBe(sa!.token);
    expect(up.tokens.get(sa!.token)).toBe(ALICE_KEY.clientId);
    expect(up.tokens.get(sb!.token)).toBe(BOB_KEY.clientId);
    // every call made for bob carried bob's own token
    const bobCalls = after(bobFrom).filter((x) => x.auth);
    expect(bobCalls.length).toBeGreaterThan(2);
    for (const x of bobCalls) expect(up.tokens.get(x.auth!.replace("Bearer ", ""))).toBe(BOB_KEY.clientId);
    // carol has no login: not connected, no call, though alice and bob hold live tokens
    const n = up.calls.length;
    await check(h, c);
    expect((await overview(h, c)).settings.toss.connected).toBe(false);
    expect(after(n)).toEqual([]);
    expect(await h.app.core.connections.sessionFor(c.uid, TOSS_SERVICE)).toBeNull();
    await expect(portfolio(h, c.uid)).rejects.toMatchObject({ code: "not_connected" });
  });

  test("disconnected from 연결 › 토스증권: both sides lose it — session gone, invest not connected and back to mock, its holdings gone, the tool asks to connect", async () => {
    const h = await world();
    const a = await person(h, "alice");
    await watchHeld(h, a);
    await connect(h, a, ALICE_KEY);
    expect(await heldRow(h, a)).toMatchObject({ qty: { v: 47 } });
    idb.updateSettings(h.db, a.uid, { mode: "real", real_since: h.clock.t }, h.clock.t);
    expect((await h.req("DELETE", `/api/connections/${TOSS_SERVICE}`, { token: a.token })).status).toBe(200);
    await h.app.core.idle();
    expect(await h.app.core.connections.sessionFor(a.uid, TOSS_SERVICE)).toBeNull();
    expect((h.app.core.connections as unknown as { sessionCount: number }).sessionCount).toBe(0);
    const st = (await overview(h, a)).settings;
    expect(st.toss.connected).toBe(false);
    expect(st.mode).toBe("mock");
    expect(st.realBlockers).toContain("toss_not_connected");
    // DD 0212: the deleted account's holdings leave the symbol row and every reader of them (stop rules, previews)
    expect(await heldRow(h, a)).toBeNull();
    expect(h.app.core.invest.holding(a.uid, "SOXL")).toBeNull();
    await expect(portfolio(h, a.uid)).rejects.toMatchObject({ code: "not_connected" });
    const n = up.calls.length;
    await check(h, a);
    expect(after(n)).toEqual([]);
  });

  test("deleted from the vault screen: the same", async () => {
    const h = await world();
    const a = await person(h, "alice");
    await watchHeld(h, a);
    const res = await connect(h, a, ALICE_KEY);
    expect(await heldRow(h, a)).toMatchObject({ qty: { v: 47 } });
    idb.updateSettings(h.db, a.uid, { mode: "real", real_since: h.clock.t }, h.clock.t);
    expect((await h.req("DELETE", `/api/credentials/${res.connection.credentialId}`, { token: a.token })).status).toBe(200);
    await h.app.core.idle();
    expect(await h.app.core.connections.sessionFor(a.uid, TOSS_SERVICE)).toBeNull();
    const st = (await overview(h, a)).settings;
    expect(st.toss.connected).toBe(false);
    expect(st.mode).toBe("mock");
    expect(await heldRow(h, a)).toBeNull();
    expect(h.app.core.invest.holding(a.uid, "SOXL")).toBeNull();
    await expect(portfolio(h, a.uid)).rejects.toMatchObject({ code: "not_connected" });
  });

  test("a server without the k-skill catalog: a saved login is read after the save; empty fields ask Toss for nothing (auth)", async () => {
    const h = await world({ catalog: false });
    const a = await person(h, "alice");
    up.state.tossHoldings = [{ symbol: "SOXL", quantity: 1 }];
    const save = async (secret: Record<string, string>) => {
      const res = await h.req("POST", "/api/credentials", { token: a.token, body: await sealed(a.uid, secret) });
      expect(res.status).toBe(201);
      await h.app.core.idle();
      return ((await res.json()) as { id: string }).id;
    };
    const id = await save(ALICE_KEY);
    expect((await overview(h, a)).settings.toss).toMatchObject({ connected: true, error: null });
    expect(up.calls.map((c) => c.path)).toEqual(["/oauth2/token", "/api/v1/accounts", "/api/v1/holdings"]);
    expect((await h.req("DELETE", `/api/credentials/${id}`, { token: a.token })).status).toBe(200);
    await h.app.core.idle();
    // not a catalog service here, so only invest's own hook drops the session
    expect((h.app.core.connections as unknown as { sessionCount: number }).sessionCount).toBe(0);
    const n = up.calls.length;
    await save({ clientId: " ", clientSecret: "" });
    expect((await overview(h, a)).settings.toss.error).toMatchObject({ code: "auth" });
    expect(after(n)).toEqual([]);
  });
});
