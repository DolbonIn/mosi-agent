/**
 * k-skill connections, server side (docs/architecture/KSKILL-CONNECTIONS.md "Server side", apps/server/src/kskill.ts):
 * the catalog in GET /api/connections, connect = save → verify → wake waiting turns → flip cards, disconnect = revoke,
 * upstream outages (kept, re-checked), and the turn wiring (ToolContext.connections, connectionWaitMs, steerPending,
 * card settling, friend threads and other speakers).
 *
 * Bogus credentials only, sealed with the real device sealing into the real @pickle/vault, against a fake upstream on
 * an ephemeral local port. Every test checks that no secret reaches a response, the stream, the stored messages, the
 * logs or the model.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConnectionRegistry, createRunTurn, needsConnection, type ConnectionService, type LlmChunk, type LlmClient, type LlmRequest, type ToolDef, type TurnInput } from "@pickle/agent";
import type { AgentEvent, Card, ConnectResponse, Connection, ConnectionRequestCard, CredentialInfo, ProviderInfo, SaveCredentialRequest, SkillInfo } from "@pickle/protocol";
import { Enclave, Vault } from "@pickle/vault";
import { sealForEnclave } from "@pickle/vault/client";
import type { ServerConfig } from "../src/deps.ts";
import type { Logger } from "../src/log.ts";
import { recheckDelays } from "../src/kskill.ts";
import { executeTurn, runSystemTurn } from "../src/turns.ts";
import type { ConnectionsLike, Timers } from "../src/deps.ts";
import { makeHarness, outcome, readSse, sseReader, SKILLS, weatherTool, type Harness } from "./helpers.ts";

// ───────────────────────────── bogus credentials, fake upstream ─────────────────────────────

const GOOD = { apiKey: "bogus-faketax-key-7Q9Z-0001", corpNum: "1234567890" };
const BAD = { apiKey: "bogus-faketax-key-WRONG-0002", corpNum: "1234567890" };
const SECRETS = [GOOD.apiKey, BAD.apiKey];

type Hit = { path: string; key: string | null };
let hits: Hit[] = [];
/** the upstream is having an outage (503 for everything) */
let upstreamDown = false;
/** only its login check is down (503 for /verify); the API itself answers */
let verifyDown = false;
const upstream = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(req) {
    const url = new URL(req.url);
    const key = req.headers.get("x-api-key");
    hits.push({ path: url.pathname, key });
    if (upstreamDown || (verifyDown && url.pathname === "/verify")) return new Response("down", { status: 503 });
    if (key !== GOOD.apiKey) return Response.json({ error: "bad key" }, { status: 401 });
    if (url.pathname === "/verify") return Response.json({ account: "하늘 상점" });
    if (url.pathname === "/invoices") return Response.json({ count: 2 });
    if (url.pathname === "/revoke") return Response.json({ ok: true });
    return new Response("nope", { status: 404 });
  },
});
afterAll(() => upstream.stop(true));
const UP = `http://127.0.0.1:${upstream.port}`;

const call = (path: string, secret: Readonly<Record<string, string>>, signal?: AbortSignal) => fetch(`${UP}${path}`, { headers: { "x-api-key": secret.apiKey ?? "" }, signal });

const FAKETAX: ConnectionService = {
  id: "faketax",
  name: "가짜세무",
  description: "테스트용 세금계산서 조회",
  kind: "token",
  fields: [
    { key: "apiKey", label: "API 키", type: "password", autocomplete: "off" },
    { key: "corpNum", label: "사업자번호", type: "text", autocomplete: "off" },
    { key: "userId", label: "아이디", type: "text", autocomplete: "off", optional: true },
  ],
  async verify(secret, { signal }) {
    const r = await call("/verify", secret, signal);
    // an outage is not a refusal (`retryable`, docs/architecture/KSKILL-CONNECTIONS.md)
    if (r.status >= 500) return { ok: false, message: "가짜세무가 지금 응답하지 않아요.", retryable: true };
    if (!r.ok) return { ok: false, message: "가짜세무 키가 맞지 않아요. 다시 확인해 주세요." };
    return { ok: true, accountLabel: ((await r.json()) as { account: string }).account };
  },
  async revoke(secret, { signal }) {
    await call("/revoke", secret, signal);
  },
};

let toolRuns: { secret: Record<string, string> }[] = [];
const listTool: ToolDef = {
  name: "k_faketax_list",
  description: "List my e-tax invoices",
  parameters: { type: "object", properties: {} },
  icon: "doc",
  title: () => "가짜세무 세금계산서 조회",
  connection: "faketax",
  connectionReason: "세금계산서를 보려면 가짜세무 연결이 필요해요",
  async run(_a, ctx) {
    const c = ctx.connection!;
    toolRuns.push({ secret: { ...c.secret } });
    const r = await call("/invoices", c.secret, ctx.signal);
    if (!r.ok) return { ok: false, summary: "조회하지 못했어요" };
    // a careless tool that echoes its key: the runtime's redaction is the backstop
    return { ok: true, summary: "세금계산서 2건", data: { count: 2, debug: `key=${c.secret.apiKey}` } };
  },
};
const issueTool: ToolDef = {
  name: "k_faketax_issue",
  description: "Issue an e-tax invoice",
  parameters: { type: "object", properties: {} },
  icon: "doc",
  title: () => "가짜세무 세금계산서 발행",
  connection: "faketax",
  write: true,
  async run() {
    return { ok: true, summary: "발행했어요" };
  },
};

/** verify accepts the key, but this endpoint refuses it (a scope the key lacks): needs_connection on every call */
const scopedTool: ToolDef = {
  name: "k_faketax_scoped",
  description: "List my e-tax invoices (needs a scope)",
  parameters: { type: "object", properties: {} },
  icon: "doc",
  title: () => "가짜세무 조회",
  connection: "faketax",
  async run() {
    return needsConnection("faketax", "가짜세무", "가짜세무 키에 조회 권한이 없어요. 다시 연결해 주세요.");
  },
};

/** the API refuses a wrong key at use (needs_connection); records which key each run got */
let keyedRuns: string[] = [];
const keyedTool: ToolDef = {
  name: "k_faketax_keyed",
  description: "List my e-tax invoices",
  parameters: { type: "object", properties: {} },
  icon: "doc",
  title: () => "가짜세무 조회",
  connection: "faketax",
  async run(_a, ctx) {
    const c = ctx.connection!;
    keyedRuns.push(c.secret.apiKey ?? "");
    const r = await call("/invoices", c.secret, ctx.signal);
    if (r.status === 401) return needsConnection("faketax", "가짜세무", "가짜세무 키가 맞지 않아요. 다시 연결해 주세요.");
    return { ok: true, summary: "세금계산서 2건" };
  },
};

/** an acting tool without a login of its own (still never for anyone but the owner) */
const marketBuy: ToolDef = {
  name: "k_market_buy",
  description: "Buy an item",
  parameters: { type: "object", properties: {} },
  icon: "bag",
  title: () => "구매",
  write: true,
  async run() {
    return { ok: true, summary: "샀어요" };
  },
};

// ───────────────────────────── harness with the real vault ─────────────────────────────

const MASTER = new Uint8Array(32).fill(7);
let enclaveDir = "";
let enclave: Enclave;
beforeAll(async () => {
  enclaveDir = mkdtempSync(join(tmpdir(), "pickle-kskill-enclave-"));
  enclave = await Enclave.load({ dir: enclaveDir, masterKey: MASTER });
});
afterAll(() => rmSync(enclaveDir, { recursive: true, force: true }));

let h: Harness | null = null;
let vaultNow = Date.now();
afterEach(async () => {
  await h?.close();
  h = null;
  hits = [];
  toolRuns = [];
  vaultNow = Date.now();
  upstreamDown = false;
  verifyDown = false;
  catalogCalls = [];
});

/** the skills screen rows: the keyless weather skill plus the two login tools (unconfigured, as @pickle/skills lists them) */
const SKILL_ROWS: SkillInfo[] = [
  ...SKILLS,
  { id: "k_faketax_list", title: "세금계산서 조회", description: "가짜세무", category: "업무", icon: "doc", needsKey: true, configured: false, source: "test", connection: "faketax", connectionName: "가짜세무" },
  { id: "k_faketax_issue", title: "세금계산서 발행", description: "가짜세무", category: "업무", icon: "doc", needsKey: true, configured: false, source: "test", connection: "faketax", connectionName: "가짜세무" },
];
/** what the prompt's skill list was asked for (undefined = every skill) */
let catalogCalls: (string[] | undefined)[] = [];

/** the registry with one method replaced (e.g. a notifyConnected held at a gate); delegates everything else */
function withRegistry(reg: ConnectionRegistry, patch: Partial<ConnectionsLike>): ConnectionsLike {
  return {
    catalog: () => reg.catalog(),
    service: (id) => reg.service(id),
    isService: (id) => reg.isService(id),
    serviceName: (id) => reg.serviceName(id),
    forUser: (u) => reg.forUser(u),
    status: (u) => reg.status(u),
    verify: (u, svc, o) => reg.verify(u, svc, o),
    notifyConnected: (u, svc, o) => reg.notifyConnected(u, svc, o),
    revoke: (u, svc) => reg.revoke(u, svc),
    forget: (u, svc) => reg.forget(u, svc),
    sessionFor: (u, svc) => reg.sessionFor(u, svc),
    ...patch,
  };
}

async function harness(extra: { tools?: ToolDef[]; config?: Partial<ServerConfig>; registry?: (reg: ConnectionRegistry) => ConnectionsLike; timers?: Timers; services?: ConnectionService[] } = {}) {
  const services = extra.services ?? [FAKETAX];
  const hh = await makeHarness({
    config: extra.config,
    deps: ({ db }) => {
      const vault = new Vault({ enclave, masterKey: MASTER, storage: db.vaultStorage() as never, serviceName: (id) => (id === "faketax" ? "가짜세무" : id), now: () => vaultNow });
      return {
      vault,
      ...(extra.registry ? { connections: extra.registry(new ConnectionRegistry({ vault, services: () => services })) } : {}),
      ...(extra.timers ? { timers: extra.timers } : {}),
      enclave,
      skills: {
        listSkills: () => SKILL_ROWS,
        skillTools: () => [weatherTool, listTool, issueTool, ...(extra.tools ?? [])],
        skillCatalogForPrompt: (enabled?: string[]) => {
          catalogCalls.push(enabled);
          return "- k_weather: 날씨 확인";
        },
        connectionServices: () => services,
      },
      };
    },
  });
  h = hh;
  return hh;
}

function captureLogs(hh: Harness): string[] {
  const lines: string[] = [];
  const rec = (level: string) => (event: string, fields?: Record<string, unknown>) => void lines.push(`${level} ${event} ${JSON.stringify(fields ?? {})}`);
  hh.app.core.log = { info: rec("info"), warn: rec("warn"), error: rec("error") } as Logger;
  return lines;
}

async function sealed(userId: string, secret: Record<string, string>, o: { kind?: "login" | "token"; service?: string; keepFor?: SaveCredentialRequest["keepFor"] } = {}): Promise<SaveCredentialRequest> {
  const service = o.service ?? "faketax";
  const kind = o.kind ?? "token";
  return {
    service,
    label: "가짜세무 (12***90)",
    kind,
    hint: "12***90",
    keepFor: o.keepFor ?? "30d",
    envelope: await sealForEnclave(enclave.info(), secret, `${userId}:${service}:${kind}`),
  };
}

const noSecret = (where: string, text: string) => {
  for (const s of SECRETS) expect([where, text.includes(s)]).toEqual([where, false]);
};

function storedText(hh: Harness): string {
  return JSON.stringify(hh.db.sql.query("SELECT text, cards_json, tools_json, llm_json FROM messages").all());
}

async function list(hh: Harness, token: string) {
  const res = await hh.req("GET", "/api/connections", { token });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { providers: ProviderInfo[]; connections: Connection[] };
  noSecret("GET /api/connections", JSON.stringify(body));
  return body;
}

/** a stored assistant message with a pending connection_request card (as a finished turn leaves it) */
function storePendingCard(hh: Harness, threadId: string, id: string, createdAt: number) {
  const card: ConnectionRequestCard = {
    type: "connection_request",
    service: "faketax",
    serviceName: "가짜세무",
    title: "가짜세무 연결이 필요해요",
    reason: "세금계산서를 보려면 가짜세무 연결이 필요해요",
    status: "pending",
    action: { label: "연결하기", open: "connections" },
  };
  hh.db.insertMessage({ id, threadId, role: "assistant", text: "가짜세무를 연결하면 이어서 할게요.", cards: [card], createdAt });
}

const cardsOf = (hh: Harness, id: string) => JSON.parse((hh.db.getMessage(id) as { cards_json: string }).cards_json) as Card[];

// ───────────────────────────── catalog ─────────────────────────────

describe("GET /api/connections: the k-skill catalog next to the messengers", () => {
  test("korea providers carry auth api_key, kind token and the fields (optional kept); no row before connecting", async () => {
    const hh = await harness();
    const { token } = await hh.signup("haneul");
    const body = await list(hh, token);
    const p = body.providers.find((x) => x.id === "faketax")!;
    expect(p).toMatchObject({ id: "faketax", name: "가짜세무", category: "korea", auth: "api_key", kind: "token", icon: "key", available: true, description: "테스트용 세금계산서 조회" });
    expect(p.fields.map((f) => [f.key, !!f.optional])).toEqual([
      ["apiKey", false],
      ["corpNum", false],
      ["userId", true],
    ]);
    expect(p.login).toBeUndefined();
    // the messenger providers are still there, first
    expect(body.providers[0]!.category).not.toBe("korea");
    expect(body.connections.some((c) => c.provider === "faketax")).toBe(false);
  });
});

// ───────────────────────────── connect ─────────────────────────────

describe("POST /api/connections/:service", () => {
  test("seal → save → verify upstream with the unsealed key → connected; the row lists; the access log says 가짜세무", async () => {
    const hh = await harness();
    const logs = captureLogs(hh);
    const { token, session } = await hh.signup("haneul");
    const uid = session.user.id;
    const ev = sseReader(await hh.req("GET", `/api/events?token=${token}`));
    await ev.next((e) => e.type === "hello");

    const res = await hh.req("POST", "/api/connections/faketax", { token, body: { credential: await sealed(uid, GOOD) } });
    const text = await res.text();
    noSecret("connect response", text);
    expect(res.status).toBe(200);
    const r = JSON.parse(text) as ConnectResponse;
    expect(r.connection).toMatchObject({ provider: "faketax", status: "connected", accountLabel: "하늘 상점", lastError: null });
    expect(r.connection.credentialId).toBeTruthy();
    // the upstream got the real (bogus) key exactly once, from the vault
    expect(hits).toEqual([{ path: "/verify", key: GOOD.apiKey }]);

    const pushed = await ev.next<{ type: "connection"; connection: Connection }>((e) => e.type === "connection" && e.connection.provider === "faketax");
    expect(pushed?.connection.status).toBe("connected");
    await ev.cancel();

    const body = await list(hh, token);
    expect(body.connections.find((c) => c.provider === "faketax")).toMatchObject({ status: "connected", accountLabel: "12***90", credentialId: r.connection.credentialId });

    const access = (await (await hh.req("GET", "/api/access-log", { token })).json()) as { serviceName: string; actor: string; action: string }[];
    expect(access[0]).toMatchObject({ serviceName: "가짜세무", actor: "user", action: "login" });
    noSecret("logs", logs.join("\n"));
    noSecret("db", storedText(hh));
  });

  test("the upstream refuses: status error with the Korean line, the new row is removed again", async () => {
    const hh = await harness();
    const logs = captureLogs(hh);
    const { token, session } = await hh.signup("haneul");
    const res = await hh.req("POST", "/api/connections/faketax", { token, body: { credential: await sealed(session.user.id, BAD) } });
    const text = await res.text();
    noSecret("connect response", text);
    const r = JSON.parse(text) as ConnectResponse;
    expect(r.connection).toMatchObject({ provider: "faketax", status: "error", lastError: "가짜세무 키가 맞지 않아요. 다시 확인해 주세요.", credentialId: null, accountLabel: null });
    const creds = (await (await hh.req("GET", "/api/credentials", { token })).json()) as CredentialInfo[];
    expect(creds).toEqual([]);
    expect((await list(hh, token)).connections.some((c) => c.provider === "faketax")).toBe(false);
    noSecret("logs", logs.join("\n"));
  });

  test("a reconnect replaces the old login (older rows dropped once the new one verifies)", async () => {
    const hh = await harness();
    const { token, session } = await hh.signup("haneul");
    const first = (await (await hh.req("POST", "/api/connections/faketax", { token, body: { credential: await sealed(session.user.id, GOOD) } })).json()) as ConnectResponse;
    vaultNow += 1_000; // the vault's clock is pinned in these tests; a later save is a later row
    const second = (await (await hh.req("POST", "/api/connections/faketax", { token, body: { credential: await sealed(session.user.id, GOOD) } })).json()) as ConnectResponse;
    expect(second.connection.status).toBe("connected");
    const creds = (await (await hh.req("GET", "/api/credentials", { token })).json()) as CredentialInfo[];
    expect(creds.map((c) => c.id)).toEqual([second.connection.credentialId!]);
    expect(first.connection.credentialId).not.toBe(second.connection.credentialId);
  });

  test("a refused reconnect keeps the login that works, and the error names it (the app's row stays)", async () => {
    const hh = await harness();
    const { token, session } = await hh.signup("haneul");
    const ok = (await (await hh.req("POST", "/api/connections/faketax", { token, body: { credential: await sealed(session.user.id, GOOD) } })).json()) as ConnectResponse;
    vaultNow += 1_000;
    const bad = (await (await hh.req("POST", "/api/connections/faketax", { token, body: { credential: await sealed(session.user.id, BAD) } })).json()) as ConnectResponse;
    expect(bad.connection).toMatchObject({ status: "error", lastError: "가짜세무 키가 맞지 않아요. 다시 확인해 주세요.", credentialId: ok.connection.credentialId, accountLabel: "12***90" });
    const creds = (await (await hh.req("GET", "/api/credentials", { token })).json()) as CredentialInfo[];
    expect(creds.map((c) => c.id)).toEqual([ok.connection.credentialId!]);
  });

  test("{credentialId}: a failed re-check (upstream outage) never deletes the saved login", async () => {
    const hh = await harness();
    const { token, session } = await hh.signup("haneul");
    const ok = (await (await hh.req("POST", "/api/connections/faketax", { token, body: { credential: await sealed(session.user.id, GOOD) } })).json()) as ConnectResponse;
    upstreamDown = true;
    const again = (await (await hh.req("POST", "/api/connections/faketax", { token, body: { credentialId: ok.connection.credentialId } })).json()) as ConnectResponse;
    expect(again.connection).toMatchObject({ status: "error", lastError: "지금은 가짜세무에 확인하지 못했어요. 잠시 후 다시 시도해 주세요." });
    expect(again.connection.credentialId).toBe(ok.connection.credentialId);
    const creds = (await (await hh.req("GET", "/api/credentials", { token })).json()) as CredentialInfo[];
    expect(creds.map((c) => c.id)).toEqual([ok.connection.credentialId!]);
    upstreamDown = false;
    const back = (await (await hh.req("POST", "/api/connections/faketax", { token, body: { credentialId: ok.connection.credentialId } })).json()) as ConnectResponse;
    expect(back.connection.status).toBe("connected");
  });

  test("the sealed kind must be the catalog's; the aad must be this user's; a messenger route stays a messenger route", async () => {
    const hh = await harness();
    const { token, session } = await hh.signup("haneul");
    const uid = session.user.id;
    const wrongKind = await hh.req("POST", "/api/connections/faketax", { token, body: { credential: await sealed(uid, GOOD, { kind: "login" }) } });
    expect(wrongKind.status).toBe(400);
    expect((await wrongKind.json()) as { error: string; message: string }).toEqual({ error: "invalid_credential", message: "이 서비스의 연결 방식과 맞지 않아요" });
    // the kind the catalog advertises (auth "api_key" → "token") is the one accepted
    const asToken = await hh.req("POST", "/api/connections/faketax", { token, body: { credential: await sealed(uid, GOOD, { kind: "token" }) } });
    expect(asToken.status).toBe(200);
    expect(((await asToken.json()) as ConnectResponse).connection.status).toBe("connected");
    hits = [];
    const other = await sealed("someone-else", GOOD);
    const wrongAad = await hh.req("POST", "/api/connections/faketax", { token, body: { credential: other } });
    expect(wrongAad.status).toBe(400);
    const wrongService = await hh.req("POST", "/api/connections/faketax", { token, body: { credential: await sealed(uid, GOOD, { service: "other" }) } });
    expect(wrongService.status).toBe(400);
    const empty = await hh.req("POST", "/api/connections/faketax", { token, body: {} });
    expect(empty.status).toBe(400);
    expect(hits).toEqual([]); // nothing reached the upstream
    // an unknown id is still a 404 from the messenger branch
    expect((await hh.req("POST", "/api/connections/nosuch", { token, body: {} })).status).toBe(404);
  });

  test("an expired login lists as error (다시 연결) with its hint", async () => {
    const hh = await harness();
    const { token, session } = await hh.signup("haneul");
    await hh.req("POST", "/api/connections/faketax", { token, body: { credential: await sealed(session.user.id, GOOD, { keepFor: "1h" }) } });
    vaultNow += 2 * 3_600_000;
    const row = (await list(hh, token)).connections.find((c) => c.provider === "faketax");
    expect(row).toMatchObject({ status: "error", accountLabel: "12***90", lastError: "보관 기간이 끝났어요. 다시 연결해 주세요." });
    expect(row?.credentialId).toBeTruthy();
  });
});

// ───────────────────────────── upstream outages ─────────────────────────────

/** the re-check timers on a clock of their own: `advance` runs each due timer in order and waits for its work */
class FakeTimers implements Timers {
  t = 0;
  #seq = 0;
  readonly pending = new Map<number, { due: number; fn: () => void }>();
  /** every delay asked for, in order */
  readonly delays: number[] = [];
  constructor(private readonly idle: () => Promise<void>) {}
  set(fn: () => void, ms: number): unknown {
    const id = ++this.#seq;
    this.pending.set(id, { due: this.t + ms, fn });
    this.delays.push(ms);
    return id;
  }
  clear(handle: unknown): void {
    this.pending.delete(handle as number);
  }
  async advance(ms: number): Promise<void> {
    const target = this.t + ms;
    for (;;) {
      let next: [number, { due: number; fn: () => void }] | null = null;
      for (const e of this.pending) if (e[1].due <= target && (!next || e[1].due < next[1].due)) next = e;
      if (!next) break;
      this.pending.delete(next[0]);
      this.t = next[1].due;
      next[1].fn();
      await this.idle();
    }
    this.t = target;
  }
}

/** a harness whose re-checks run on FakeTimers (the defaults: 30 s, 2 min, 10 min; 쿠팡 파트너스 an hour) */
async function recheckHarness(extra: Parameters<typeof harness>[0] = {}) {
  let core: Harness["app"]["core"] | null = null;
  const timers = new FakeTimers(async () => {
    await core?.idle();
  });
  const hh = await harness({ ...extra, timers });
  core = hh.app.core;
  return { hh, timers };
}
const verifyHits = () => hits.filter((x) => x.path === "/verify").length;
const COUPANG: ConnectionService = { ...FAKETAX, id: "coupang-partners", name: "쿠팡 파트너스" };

describe("verify could not reach the upstream (timeout, 5xx, network)", () => {
  test("a new login is kept as needs_verification with the copy; the re-check connects it, wakes the app and flips the cards", async () => {
    const { hh, timers } = await recheckHarness();
    const logs = captureLogs(hh);
    const { token, session } = await hh.signup("haneul");
    storePendingCard(hh, session.mainThreadId, "m1", hh.clock.t);
    const ev = sseReader(await hh.req("GET", `/api/events?token=${token}`));
    await ev.next((e) => e.type === "hello");
    upstreamDown = true;
    const res = await hh.req("POST", "/api/connections/faketax", { token, body: { credential: await sealed(session.user.id, GOOD) } });
    const text = await res.text();
    noSecret("connect response", text);
    const r = JSON.parse(text) as ConnectResponse;
    expect(r.connection).toMatchObject({ status: "needs_verification", lastError: "지금은 가짜세무에 확인하지 못했어요. 저장해 두었고 잠시 후 다시 확인할게요.", accountLabel: "12***90" });
    const id = r.connection.credentialId!;
    expect(((await (await hh.req("GET", "/api/credentials", { token })).json()) as CredentialInfo[]).map((c) => c.id)).toEqual([id]);
    expect((await list(hh, token)).connections.find((c) => c.provider === "faketax")).toMatchObject({ status: "needs_verification", credentialId: id });
    expect(cardsOf(hh, "m1")[0]).toMatchObject({ status: "pending" }); // not a connect yet
    expect((await ev.next<{ connection: Connection }>((e) => e.type === "connection"))?.connection.status).toBe("needs_verification");
    expect(timers.delays).toEqual([30_000]);

    upstreamDown = false; // the upstream is back before the first re-check
    await timers.advance(29_999);
    expect(verifyHits()).toBe(1);
    await timers.advance(1);
    const back = await ev.next<{ connection: Connection }>((e) => e.type === "connection" && e.connection.status === "connected", 2_000);
    expect(back?.connection).toMatchObject({ provider: "faketax", credentialId: id, accountLabel: "하늘 상점" });
    await ev.cancel();
    expect((await list(hh, token)).connections.find((c) => c.provider === "faketax")).toMatchObject({ status: "connected", lastError: null });
    expect(cardsOf(hh, "m1")[0]).toMatchObject({ status: "connected", action: { label: "이어서 하기" } });
    expect(hits.filter((x) => x.path === "/verify").map((x) => x.key)).toEqual([GOOD.apiKey, GOOD.apiKey]);
    expect(timers.pending.size).toBe(0);
    noSecret("logs", logs.join("\n"));
  });

  test("an outage, then the key turns out refused on the re-check: removed, and the app hears the Korean line", async () => {
    const { hh, timers } = await recheckHarness();
    const { token, session } = await hh.signup("haneul");
    const ev = sseReader(await hh.req("GET", `/api/events?token=${token}`));
    await ev.next((e) => e.type === "hello");
    upstreamDown = true;
    const r = (await (await hh.req("POST", "/api/connections/faketax", { token, body: { credential: await sealed(session.user.id, BAD) } })).json()) as ConnectResponse;
    expect(r.connection.status).toBe("needs_verification");
    upstreamDown = false;
    await timers.advance(30_000);
    const refused = await ev.next<{ connection: Connection }>((e) => e.type === "connection" && e.connection.status === "error", 2_000);
    await ev.cancel();
    expect(refused?.connection).toMatchObject({ provider: "faketax", lastError: "가짜세무 키가 맞지 않아요. 다시 확인해 주세요.", credentialId: null });
    expect((await (await hh.req("GET", "/api/credentials", { token })).json()) as unknown[]).toEqual([]);
    expect(timers.pending.size).toBe(0);
  });

  test("still unreachable after 30 s, 2 min and 10 min: the login stays unconfirmed (listed so), nothing more is scheduled; a later hand check is the connect", async () => {
    const { hh, timers } = await recheckHarness();
    const { token, session } = await hh.signup("haneul");
    storePendingCard(hh, session.mainThreadId, "m1", hh.clock.t);
    upstreamDown = true;
    const r = (await (await hh.req("POST", "/api/connections/faketax", { token, body: { credential: await sealed(session.user.id, GOOD) } })).json()) as ConnectResponse;
    await timers.advance(30_000);
    expect(verifyHits()).toBe(2);
    await timers.advance(120_000);
    expect(verifyHits()).toBe(3);
    await timers.advance(600_000);
    expect(verifyHits()).toBe(4); // the save + three re-checks
    expect(timers.delays).toEqual([30_000, 120_000, 600_000]);
    expect(timers.pending.size).toBe(0);
    await timers.advance(24 * 3_600_000);
    expect(verifyHits()).toBe(4);
    expect(((await (await hh.req("GET", "/api/credentials", { token })).json()) as CredentialInfo[]).map((c) => c.id)).toEqual([r.connection.credentialId!]);
    // never confirmed: not shown as 연결됨, and the line says how to get it checked
    expect((await list(hh, token)).connections.find((c) => c.provider === "faketax")).toMatchObject({ status: "needs_verification", credentialId: r.connection.credentialId, lastError: "아직 가짜세무에 확인하지 못했어요. 키를 다시 입력하면 바로 다시 확인할게요." });
    expect(cardsOf(hh, "m1")[0]).toMatchObject({ status: "pending" });
    upstreamDown = false;
    const back = (await (await hh.req("POST", "/api/connections/faketax", { token, body: { credentialId: r.connection.credentialId } })).json()) as ConnectResponse;
    expect(back.connection.status).toBe("connected");
    expect(cardsOf(hh, "m1")[0]).toMatchObject({ status: "connected", action: { label: "이어서 하기" } });
    expect((await list(hh, token)).connections.find((c) => c.provider === "faketax")).toMatchObject({ status: "connected", lastError: null });
  });

  test("a re-check refuses the unconfirmed new key while a turn waits on it: the older login remains, the turn wakes and retries with it", async () => {
    const { hh, timers } = await recheckHarness({ tools: [keyedTool], config: { connectionWaitMs: 5_000 } });
    keyedRuns = [];
    const { token, session } = await hh.signup("haneul");
    await hh.req("POST", "/api/connections/faketax", { token, body: { credential: await sealed(session.user.id, GOOD) } });
    verifyDown = true;
    vaultNow += 1_000;
    const b = (await (await hh.req("POST", "/api/connections/faketax", { token, body: { credential: await sealed(session.user.id, BAD) } })).json()) as ConnectResponse;
    expect(b.connection.status).toBe("needs_verification"); // the newest row, so tools use it meanwhile
    hh.turns.set((input, emit) => createRunTurn(scriptedModel("k_faketax_keyed", "세금계산서가 2건 있어요.", []))(input, emit));
    const sse = sseReader(await hh.req("POST", `/api/threads/${session.mainThreadId}/messages`, { token, body: { text: "세금계산서 보여줘" } }));
    expect(await sse.next((e) => e.type === "status" && String(e.text).includes("가짜세무 연결 기다리는 중"), 5_000)).toBeTruthy();
    verifyDown = false;
    const t0 = performance.now();
    await timers.advance(30_000); // the re-check refuses the new key: removed
    const done = await sse.next<{ type: "done"; message: { cards: Card[] } }>((e) => e.type === "done", 10_000);
    await sse.cancel();
    expect(performance.now() - t0).toBeLessThan(4_000); // woken, not timed out
    expect(keyedRuns).toEqual([BAD.apiKey, GOOD.apiKey]);
    expect(done!.message.cards.find((c) => c.type === "connection_request")).toMatchObject({ status: "connected" });
    expect(((await (await hh.req("GET", "/api/credentials", { token })).json()) as CredentialInfo[]).length).toBe(1);
  });

  test("a replaced login is not re-checked", async () => {
    const { hh, timers } = await recheckHarness();
    const { token, session } = await hh.signup("haneul");
    upstreamDown = true;
    await hh.req("POST", "/api/connections/faketax", { token, body: { credential: await sealed(session.user.id, GOOD) } });
    upstreamDown = false;
    vaultNow += 1_000;
    const fresh = (await (await hh.req("POST", "/api/connections/faketax", { token, body: { credential: await sealed(session.user.id, GOOD) } })).json()) as ConnectResponse;
    expect(fresh.connection.status).toBe("connected"); // drops the unverified older row
    hits = [];
    await timers.advance(30_000 + 120_000 + 600_000);
    expect(hits).toEqual([]);
    expect(timers.pending.size).toBe(0);
  });

  test("close() stops the re-checks: no timer left, no verify after it (30 s, 10 min, an hour later)", async () => {
    let verifyCalls = 0;
    const { hh, timers } = await recheckHarness({
      registry: (reg) =>
        withRegistry(reg, {
          verify: (u, svc, o) => {
            verifyCalls++;
            return reg.verify(u, svc, o);
          },
        }),
    });
    const { token, session } = await hh.signup("haneul");
    upstreamDown = true;
    const r = (await (await hh.req("POST", "/api/connections/faketax", { token, body: { credential: await sealed(session.user.id, GOOD) } })).json()) as ConnectResponse;
    expect(r.connection.status).toBe("needs_verification");
    expect(verifyCalls).toBe(1);
    expect(timers.pending.size).toBe(1);
    const t0 = performance.now();
    await hh.close();
    h = null;
    expect(performance.now() - t0).toBeLessThan(2_000);
    expect(timers.pending.size).toBe(0);
    await timers.advance(30_000);
    await timers.advance(600_000);
    await timers.advance(3_600_000);
    expect(verifyCalls).toBe(1);
    expect(verifyHits()).toBe(1);
  });

  test("an unconfirmed login checked by hand ({credentialId}) once the upstream is back is the connect; its scheduled re-check is dropped", async () => {
    const { hh, timers } = await recheckHarness();
    const { token, session } = await hh.signup("haneul");
    storePendingCard(hh, session.mainThreadId, "m1", hh.clock.t);
    upstreamDown = true;
    const r = (await (await hh.req("POST", "/api/connections/faketax", { token, body: { credential: await sealed(session.user.id, GOOD) } })).json()) as ConnectResponse;
    expect(r.connection.status).toBe("needs_verification");
    upstreamDown = false;
    const back = (await (await hh.req("POST", "/api/connections/faketax", { token, body: { credentialId: r.connection.credentialId } })).json()) as ConnectResponse;
    expect(back.connection).toMatchObject({ status: "connected", credentialId: r.connection.credentialId });
    expect(cardsOf(hh, "m1")[0]).toMatchObject({ status: "connected", action: { label: "이어서 하기" } });
    expect(timers.pending.size).toBe(0);
    hits = [];
    await timers.advance(30_000 + 120_000 + 600_000);
    expect(hits).toEqual([]); // no background check after the connect
  });

  test("쿠팡 파트너스 (its verify spends the user's search quota): the first re-check after 60 min, then at most one an hour", async () => {
    const { hh, timers } = await recheckHarness({ services: [FAKETAX, COUPANG] });
    const { token, session } = await hh.signup("haneul");
    upstreamDown = true;
    const r = (await (await hh.req("POST", "/api/connections/coupang-partners", { token, body: { credential: await sealed(session.user.id, GOOD, { service: "coupang-partners" }) } })).json()) as ConnectResponse;
    expect(r.connection).toMatchObject({ provider: "coupang-partners", status: "needs_verification" });
    expect(verifyHits()).toBe(1);
    await timers.advance(30_000);
    await timers.advance(120_000);
    await timers.advance(600_000);
    expect(verifyHits()).toBe(1); // none of the usual 30 s / 2 min / 10 min checks
    await timers.advance(3_600_000 - 750_000 - 1);
    expect(verifyHits()).toBe(1);
    await timers.advance(1); // 60 min after the save
    expect(verifyHits()).toBe(2);
    await timers.advance(3_600_000 - 1);
    expect(verifyHits()).toBe(2);
    await timers.advance(1);
    expect(verifyHits()).toBe(3);
    await timers.advance(3_600_000);
    expect(verifyHits()).toBe(4);
    expect(timers.delays).toEqual([3_600_000, 3_600_000, 3_600_000]);
    expect(timers.pending.size).toBe(0);
    // the other services keep 30 s, 2 min, 10 min
    expect(recheckDelays(hh.app.core, "faketax")).toEqual([30_000, 120_000, 600_000]);
    expect(recheckDelays(hh.app.core, "popbill")).toEqual([30_000, 120_000, 600_000]);
  });

  test("a refused new login drops only its own cached session: the working login keeps its session", async () => {
    const hh = await harness();
    const { token, session } = await hh.signup("haneul");
    const a = (await (await hh.req("POST", "/api/connections/faketax", { token, body: { credential: await sealed(session.user.id, GOOD) } })).json()) as ConnectResponse;
    const seen: { credentialId: string; session: unknown }[] = [];
    let step = 0;
    hh.turns.set(async (input) => {
      await input.ctx.connections!.use("faketax", { action: "view", purpose: "세금계산서 조회" }, async (c) => {
        seen.push({ credentialId: c.credentialId, session: c.session.get() });
        if (step === 0) c.session.set({ cookie: "sess-0001" }, 60_000);
      });
      step++;
      return outcome("네");
    });
    await readSse(await hh.req("POST", `/api/threads/${session.mainThreadId}/messages`, { token, body: { text: "세금계산서" } }));
    vaultNow += 1_000;
    const refused = (await (await hh.req("POST", "/api/connections/faketax", { token, body: { credential: await sealed(session.user.id, BAD) } })).json()) as ConnectResponse;
    expect(refused.connection.status).toBe("error");
    await readSse(await hh.req("POST", `/api/threads/${session.mainThreadId}/messages`, { token, body: { text: "다시" } }));
    expect(seen).toEqual([
      { credentialId: a.connection.credentialId!, session: null },
      { credentialId: a.connection.credentialId!, session: { cookie: "sess-0001" } },
    ]);
  });
});

// ───────────────────────────── cards ─────────────────────────────

describe("connecting resolves the stored connection_request cards", () => {
  test("no turn waiting: every pending card flips to connected, the newest one offers 이어서 하기", async () => {
    const hh = await harness();
    const { token, session } = await hh.signup("haneul");
    const tid = session.mainThreadId;
    storePendingCard(hh, tid, "m_old", hh.clock.t - 60_000);
    storePendingCard(hh, tid, "m_new", hh.clock.t);
    const ev = sseReader(await hh.req("GET", `/api/events?token=${token}`));
    await ev.next((e) => e.type === "hello");

    await hh.req("POST", "/api/connections/faketax", { token, body: { credential: await sealed(session.user.id, GOOD) } });
    expect(cardsOf(hh, "m_new")[0]).toMatchObject({ status: "connected", action: { label: "이어서 하기", send: "가짜세무 연결했어요. 이어서 해 주세요." } });
    expect(cardsOf(hh, "m_old")[0]).toMatchObject({ status: "connected", action: { label: "연결하기", open: "connections" } });
    expect(await ev.next((e) => e.type === "message" && e.message?.id === "m_new")).toBeTruthy();
    await ev.cancel();
  });

  test("a failed verify leaves the cards pending", async () => {
    const hh = await harness();
    const { token, session } = await hh.signup("haneul");
    storePendingCard(hh, session.mainThreadId, "m1", hh.clock.t);
    await hh.req("POST", "/api/connections/faketax", { token, body: { credential: await sealed(session.user.id, BAD) } });
    expect(cardsOf(hh, "m1")[0]).toMatchObject({ status: "pending" });
  });

  test("a save through POST /api/credentials connects the same way (and a refused one is a 400)", async () => {
    const hh = await harness();
    const { token, session } = await hh.signup("haneul");
    storePendingCard(hh, session.mainThreadId, "m1", hh.clock.t);
    const bad = await hh.req("POST", "/api/credentials", { token, body: await sealed(session.user.id, BAD) });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string; message: string }).message).toBe("가짜세무 키가 맞지 않아요. 다시 확인해 주세요.");
    expect((await (await hh.req("GET", "/api/credentials", { token })).json()) as unknown[]).toEqual([]);
    const ev = sseReader(await hh.req("GET", `/api/events?token=${token}`));
    await ev.next((e) => e.type === "hello");
    const ok = await hh.req("POST", "/api/credentials", { token, body: await sealed(session.user.id, GOOD) });
    expect(ok.status).toBe(201);
    expect((await ev.next<{ connection: Connection }>((e) => e.type === "connection" && e.connection.provider === "faketax"))?.connection.status).toBe("connected");
    await ev.cancel();
    expect(cardsOf(hh, "m1")[0]).toMatchObject({ status: "connected", action: { label: "이어서 하기" } });
    expect((await list(hh, token)).connections.find((c) => c.provider === "faketax")?.status).toBe("connected");
  });
});

// ───────────────────────────── disconnect ─────────────────────────────

describe("disconnect", () => {
  test("DELETE /api/connections/:service signs out upstream with the key, removes every row, pushes the event", async () => {
    const hh = await harness();
    const { token, session } = await hh.signup("haneul");
    await hh.req("POST", "/api/connections/faketax", { token, body: { credential: await sealed(session.user.id, GOOD) } });
    hits = [];
    const ev = sseReader(await hh.req("GET", `/api/events?token=${token}`));
    await ev.next((e) => e.type === "hello");
    const res = await hh.req("DELETE", "/api/connections/faketax", { token });
    const text = await res.text();
    noSecret("disconnect response", text);
    expect(res.status).toBe(200);
    expect(JSON.parse(text)).toEqual({ ok: true, removed: 1 });
    expect(hits).toEqual([{ path: "/revoke", key: GOOD.apiKey }]);
    expect((await (await hh.req("GET", "/api/credentials", { token })).json()) as unknown[]).toEqual([]);
    expect((await list(hh, token)).connections.some((c) => c.provider === "faketax")).toBe(false);
    const pushed = await ev.next<{ connection: Connection }>((e) => e.type === "connection" && e.connection.provider === "faketax");
    expect(pushed?.connection.status).toBe("disconnected");
    await ev.cancel();
  });

  test("DELETE /api/credentials/:id of a k-skill login removes it (no upstream call) and the service lists as not connected", async () => {
    const hh = await harness();
    const { token, session } = await hh.signup("haneul");
    const r = (await (await hh.req("POST", "/api/connections/faketax", { token, body: { credential: await sealed(session.user.id, GOOD) } })).json()) as ConnectResponse;
    hits = [];
    const ev = sseReader(await hh.req("GET", `/api/events?token=${token}`));
    await ev.next((e) => e.type === "hello");
    expect((await hh.req("DELETE", `/api/credentials/${r.connection.credentialId}`, { token })).status).toBe(200);
    expect(hits).toEqual([]);
    expect((await ev.next<{ connection: Connection }>((e) => e.type === "connection" && e.connection.provider === "faketax"))?.connection.status).toBe("disconnected");
    await ev.cancel();
    expect((await list(hh, token)).connections.some((c) => c.provider === "faketax")).toBe(false);
  });
});

// ───────────────────────────── skills screen ─────────────────────────────

describe("GET /api/skills", () => {
  test("a login tool is configured once this owner connected its service (and only for them)", async () => {
    const hh = await harness();
    const a = await hh.signup("haneul");
    const b = await hh.signup("jinwoo", { displayName: "진우" });
    const configured = async (token: string) =>
      Object.fromEntries(((await (await hh.req("GET", "/api/skills", { token })).json()) as SkillInfo[]).map((r) => [r.id, r.configured]));
    expect(await configured(a.token)).toMatchObject({ k_faketax_list: false, k_faketax_issue: false });
    await hh.req("POST", "/api/connections/faketax", { token: a.token, body: { credential: await sealed(a.session.user.id, GOOD) } });
    const mine = await configured(a.token);
    expect(mine).toMatchObject({ k_faketax_list: true, k_faketax_issue: true });
    expect(Object.values(await configured(b.token)).filter((v) => v === true).length).toBe(Object.values(mine).length - 2);
  });
});

// ───────────────────────────── turns ─────────────────────────────

/** asks for `tool` once, then answers with `final` (and records what the model was sent) */
function scriptedModel(tool: string, final: string, seen: LlmRequest[]): LlmClient {
  let n = 0;
  return {
    async *stream(req: LlmRequest): AsyncGenerator<LlmChunk> {
      seen.push(JSON.parse(JSON.stringify(req)) as LlmRequest);
      if (n++ === 0) {
        yield { type: "tool_calls", calls: [{ id: "call_k1", type: "function", function: { name: tool, arguments: "{}" } }] };
        yield { type: "finish", reason: "tool_calls" };
      } else {
        yield { type: "text", delta: final };
        yield { type: "finish", reason: "stop" };
      }
    },
  } as unknown as LlmClient;
}

describe("turn wiring", () => {
  test("a user text turn gets ctx.connections, connectionWaitMs 90 s and steerPending over the lease", async () => {
    const hh = await harness();
    const { token, session } = await hh.signup("haneul");
    let pendingBefore: boolean | null = null;
    let pendingAfter: boolean | null = null;
    let first: TurnInput | null = null;
    hh.turns.set(async (input) => {
      if (!first) {
        first = input;
        pendingBefore = input.steerPending!();
        hh.launcher.steer(session.user.id, "아 그리고 하나 더");
        pendingAfter = input.steerPending!();
        input.steer?.(); // take it, so no follow-up turn starts
      }
      return outcome("네");
    });
    await readSse(await hh.req("POST", `/api/threads/${session.mainThreadId}/messages`, { token, body: { text: "세금계산서 보여줘" } }));
    const input = first as unknown as TurnInput;
    expect(input.connectionWaitMs).toBe(90_000);
    expect(input.ctx.connections).toBeDefined();
    expect(input.ctx.connections!.serviceName("faketax")).toBe("가짜세무");
    expect(input.tools.map((t) => t.name)).toEqual(expect.arrayContaining(["k_faketax_list", "k_faketax_issue"]));
    expect([pendingBefore as boolean | null, pendingAfter as boolean | null]).toEqual([false, true]);
    await hh.app.core.idle();
  });

  test("scheduled (system) turns never wait for a connect", async () => {
    const hh = await harness();
    const { session } = await hh.signup("haneul");
    const lease = await hh.launcher.acquire(session.user.id);
    await runSystemTurn(hh.app.core, { userId: session.user.id, threadId: session.mainThreadId, prompt: "세금계산서 확인", eventText: "세금계산서 · 매일", lease });
    lease.release();
    const input = hh.turns.inputs.at(-1)!;
    expect(input.connectionWaitMs ?? 0).toBe(0);
    expect(input.ctx.connections).toBeDefined(); // a connected login still works there
  });

  test("the system prompt names connected k-skill services by name only", async () => {
    const hh = await harness();
    const { token, session } = await hh.signup("haneul");
    await hh.req("POST", "/api/connections/faketax", { token, body: { credential: await sealed(session.user.id, GOOD) } });
    await readSse(await hh.req("POST", `/api/threads/${session.mainThreadId}/messages`, { token, body: { text: "안녕" } }));
    const ctx = hh.launcher.prompts.at(-1)!.ctx;
    expect(ctx.connections).toContain("가짜세무");
    noSecret("prompt", JSON.stringify(ctx));
  });

  test("friend threads get no login or write tools, no resolver and no wait", async () => {
    const hh = await harness({ tools: [marketBuy] });
    const a = await hh.signup("alice", { displayName: "하늘", agentName: "깽이" });
    const b = await hh.signup("bob", { displayName: "진우", agentName: "콩이" });
    const inv = (await (await hh.req("POST", "/api/invites", { token: a.token, headers: { host: "pickle.test" } })).json()) as { token: string };
    const friend = (await (await hh.req(`POST`, `/api/invites/${inv.token}/accept`, { token: b.token })).json()) as { threadId: string };
    await readSse(await hh.req("POST", `/api/threads/${friend.threadId}/messages`, { token: a.token, body: { text: "@깽이 세금계산서 보여줘" } }));
    const input = hh.turns.inputs.at(-1)!;
    expect(input.tools.some((t) => t.connection || t.write)).toBe(false);
    expect(input.tools.map((t) => t.name)).toContain(weatherTool.name);
    // the prompt's skill list leaves the login tools out too
    expect(catalogCalls.at(-1)).toEqual(SKILLS.map((s) => s.id)); // the keyless ones only
    expect(input.ctx.connections).toBeUndefined();
    expect(input.connectionWaitMs ?? 0).toBe(0);
  });

  test("a turn answering someone other than the owner (speaker \"other\", e.g. a third party on a call) gets none of it either", async () => {
    const hh = await harness({ tools: [marketBuy] });
    const { token, session } = await hh.signup("haneul");
    await hh.req("POST", "/api/connections/faketax", { token, body: { credential: await sealed(session.user.id, GOOD) } });
    const lease = await hh.launcher.acquire(session.user.id);
    for (const mode of ["voice", "text"] as const) {
      await executeTurn(hh.app.core, { userId: session.user.id, threadId: session.mainThreadId, userText: "그분 세금계산서 좀 알려 줘요", userMessage: null, mode, lease, sink: () => {}, initiatedBy: "user", speaker: "other" });
      const input = hh.turns.inputs.at(-1)!;
      expect(input.tools.some((t) => t.connection || t.write)).toBe(false);
      expect(input.tools.map((t) => t.name)).toContain(weatherTool.name);
      expect(input.ctx.connections).toBeUndefined();
      expect(input.connectionWaitMs ?? 0).toBe(0);
      expect(hh.launcher.prompts.at(-1)!.ctx.connections).toEqual([]); // no connected-service names either
    }
    // the owner's own turn in the same thread does get them
    await executeTurn(hh.app.core, { userId: session.user.id, threadId: session.mainThreadId, userText: "내 세금계산서", userMessage: null, mode: "text", lease, sink: () => {}, initiatedBy: "user" });
    expect(hh.turns.inputs.at(-1)!.tools.some((t) => t.name === "k_faketax_list")).toBe(true);
    expect(hh.turns.inputs.at(-1)!.ctx.connections).toBeDefined();
    lease.release();
    await hh.app.core.idle();
  });

  test("end to end: no login → card + wait; connecting from the sheet wakes the turn, the tool runs, nothing leaks", async () => {
    const hh = await harness();
    const logs = captureLogs(hh);
    const { token, session } = await hh.signup("haneul");
    const tid = session.mainThreadId;
    const seen: LlmRequest[] = [];
    hh.turns.set((input, emit) => createRunTurn(scriptedModel("k_faketax_list", "세금계산서가 2건 있어요.", seen))(input, emit));

    const res = await hh.req("POST", `/api/threads/${tid}/messages`, { token, body: { text: "세금계산서 보여줘" } });
    const sse = sseReader(res);
    const card = await sse.next<{ type: "card"; card: ConnectionRequestCard }>((e) => e.type === "card" && e.card.type === "connection_request", 5_000);
    expect(card?.card).toMatchObject({ service: "faketax", serviceName: "가짜세무", status: "pending", action: { label: "연결하기", open: "connections" } });
    expect(await sse.next((e) => e.type === "status" && String(e.text).includes("가짜세무 연결 기다리는 중"), 5_000)).toBeTruthy();
    expect(toolRuns).toEqual([]);

    // the owner connects from the sheet while the turn waits
    const conn = (await (await hh.req("POST", "/api/connections/faketax", { token, body: { credential: await sealed(session.user.id, GOOD) } })).json()) as ConnectResponse;
    expect(conn.connection.status).toBe("connected");

    const done = await sse.next<{ type: "done"; message: { id: string; text: string; cards: Card[] } }>((e) => e.type === "done", 10_000);
    await sse.cancel();
    expect(done?.message.text).toBe("세금계산서가 2건 있어요.");
    expect(toolRuns).toEqual([{ secret: GOOD }]); // the tool saw the unsealed key, only inside its run
    expect(hits.map((x) => x.path)).toEqual(["/verify", "/invoices"]);
    // the stored card: connected, and no 이어서 하기 (the waiting turn went on by itself)
    const stored = done!.message.cards.find((c) => c.type === "connection_request") as ConnectionRequestCard;
    expect(stored).toMatchObject({ status: "connected", action: { label: "연결하기" } });

    // the model never saw the key (the careless echo was redacted before it left the vault callback)
    const sent = JSON.stringify(seen);
    noSecret("model requests", sent);
    expect(sent).toContain("[가림]");
    noSecret("db", storedText(hh));
    noSecret("logs", logs.join("\n"));
  });

  test("the wait ended before the connect: the stored card is settled as connected with 이어서 하기", async () => {
    const hh = await harness();
    const { token, session } = await hh.signup("haneul");
    const tid = session.mainThreadId;
    storePendingCard(hh, tid, "m_old", hh.clock.t - 60_000); // an older turn's card, still pending
    // the turn's wait is over (or there was none), then the owner connects before the turn is stored
    hh.turns.set(async (_input, emit) => {
      const card: ConnectionRequestCard = {
        type: "connection_request",
        service: "faketax",
        serviceName: "가짜세무",
        title: "가짜세무 연결이 필요해요",
        reason: "세금계산서를 보려면 가짜세무 연결이 필요해요",
        status: "pending",
        action: { label: "연결하기", open: "connections" },
      };
      emit({ type: "card", card });
      const r = await hh.req("POST", "/api/connections/faketax", { token, body: { credential: await sealed(session.user.id, GOOD) } });
      expect(((await r.json()) as ConnectResponse).connection.status).toBe("connected");
      return outcome("가짜세무를 연결하면 이어서 할게요.", { cards: [card] });
    });
    const events = (await readSse(await hh.req("POST", `/api/threads/${tid}/messages`, { token, body: { text: "세금계산서 보여줘" } }))) as AgentEvent[];
    const done = events.find((e) => e.type === "done") as Extract<AgentEvent, { type: "done" }>;
    const stored = done.message.cards.find((c) => c.type === "connection_request");
    expect(stored).toMatchObject({ status: "connected", action: { label: "이어서 하기", send: "가짜세무 연결했어요. 이어서 해 주세요." } });
    // exactly one 이어서 하기: the running turn's card has it, so the older stored card is only flipped
    expect(cardsOf(hh, "m_old")[0]).toMatchObject({ status: "connected", action: { label: "연결하기", open: "connections" } });
  });

  test("connected during the wait, but the retried call refuses the new login: that second card stays pending", async () => {
    const hh = await harness({ tools: [scopedTool], config: { connectionWaitMs: 1_500 } });
    const { token, session } = await hh.signup("haneul");
    hh.turns.set((input, emit) => createRunTurn(scriptedModel("k_faketax_scoped", "다시 연결해 주시면 이어서 할게요.", []))(input, emit));
    const sse = sseReader(await hh.req("POST", `/api/threads/${session.mainThreadId}/messages`, { token, body: { text: "세금계산서 보여줘" } }));
    expect(await sse.next((e) => e.type === "status" && String(e.text).includes("가짜세무 연결 기다리는 중"), 5_000)).toBeTruthy();
    const conn = (await (await hh.req("POST", "/api/connections/faketax", { token, body: { credential: await sealed(session.user.id, GOOD) } })).json()) as ConnectResponse;
    expect(conn.connection.status).toBe("connected");
    const done = await sse.next<{ type: "done"; message: { id: string; cards: Card[] } }>((e) => e.type === "done", 10_000);
    await sse.cancel();
    const cards = done!.message.cards.filter((c): c is ConnectionRequestCard => c.type === "connection_request");
    expect(cards.map((c) => ({ status: c.status, label: c.action.label }))).toEqual([
      { status: "connected", label: "연결하기" }, // the wait it ended (the turn went on by itself)
      { status: "pending", label: "연결하기" }, // raised after the connect: still needs one
    ]);
    expect(cards[1]!.reason).toBe("가짜세무 키에 조회 권한이 없어요. 다시 연결해 주세요.");
    expect(cardsOf(hh, done!.message.id).filter((c) => c.type === "connection_request").map((c) => (c as ConnectionRequestCard).status)).toEqual(["connected", "pending"]);
  });

  test("a {credentialId} re-check of the login the running turn's tool just refused is no connect: the cards stay pending", async () => {
    const hh = await harness({ tools: [scopedTool], config: { connectionWaitMs: 1_000 } });
    const { token, session } = await hh.signup("haneul");
    const ok = (await (await hh.req("POST", "/api/connections/faketax", { token, body: { credential: await sealed(session.user.id, GOOD) } })).json()) as ConnectResponse;
    storePendingCard(hh, session.mainThreadId, "m_old", hh.clock.t - 60_000);
    hh.turns.set((input, emit) => createRunTurn(scriptedModel("k_faketax_scoped", "다시 연결해 주시면 이어서 할게요.", []))(input, emit));
    const sse = sseReader(await hh.req("POST", `/api/threads/${session.mainThreadId}/messages`, { token, body: { text: "세금계산서 보여줘" } }));
    expect(await sse.next((e) => e.type === "status" && String(e.text).includes("가짜세무 연결 기다리는 중"), 5_000)).toBeTruthy();
    const again = (await (await hh.req("POST", "/api/connections/faketax", { token, body: { credentialId: ok.connection.credentialId } })).json()) as ConnectResponse;
    expect(again.connection.status).toBe("connected"); // the key itself still passes verify
    const done = await sse.next<{ type: "done"; message: { cards: Card[] } }>((e) => e.type === "done", 10_000);
    await sse.cancel();
    expect(done!.message.cards.find((c) => c.type === "connection_request")).toMatchObject({ status: "pending", action: { label: "연결하기" } });
    expect(cardsOf(hh, "m_old")[0]).toMatchObject({ status: "pending" });
  });

  test("the turn is stored while notifyConnected is still running: one 이어서 하기 (the turn's), the older card is only flipped", async () => {
    let entered!: () => void;
    const inNotify = new Promise<void>((r) => (entered = r));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const hh = await harness({
      registry: (reg) =>
        withRegistry(reg, {
          async notifyConnected(u, svc, o) {
            entered();
            await gate; // the connect is counted; waking the turns is still in flight
            return reg.notifyConnected(u, svc, o);
          },
        }),
    });
    const { token, session } = await hh.signup("haneul");
    storePendingCard(hh, session.mainThreadId, "m_old", hh.clock.t - 60_000);
    let post: Promise<Response> | null = null;
    hh.turns.set(async (_input, emit) => {
      const card: ConnectionRequestCard = { type: "connection_request", service: "faketax", serviceName: "가짜세무", title: "가짜세무 연결이 필요해요", reason: "세금계산서를 보려면 가짜세무 연결이 필요해요", status: "pending", action: { label: "연결하기", open: "connections" } };
      emit({ type: "card", card });
      post = hh.req("POST", "/api/connections/faketax", { token, body: { credential: await sealed(session.user.id, GOOD) } });
      await inNotify;
      return outcome("가짜세무를 연결하면 이어서 할게요.", { cards: [card] });
    });
    const events = (await readSse(await hh.req("POST", `/api/threads/${session.mainThreadId}/messages`, { token, body: { text: "세금계산서 보여줘" } }))) as AgentEvent[];
    release();
    expect(((await (await post!).json()) as ConnectResponse).connection.status).toBe("connected");
    const done = events.find((e) => e.type === "done") as Extract<AgentEvent, { type: "done" }>;
    expect(done.message.cards.find((c) => c.type === "connection_request")).toMatchObject({ status: "connected", action: { label: "이어서 하기" } });
    expect(cardsOf(hh, "m_old")[0]).toMatchObject({ status: "connected", action: { label: "연결하기", open: "connections" } });
  });

  test("a card raised after the connect was counted (still waking turns) is not resolved by it", async () => {
    let entered!: () => void;
    const inNotify = new Promise<void>((r) => (entered = r));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const hh = await harness({
      registry: (reg) =>
        withRegistry(reg, {
          async notifyConnected(u, svc, o) {
            entered();
            await gate;
            return reg.notifyConnected(u, svc, o);
          },
        }),
    });
    const { token, session } = await hh.signup("haneul");
    storePendingCard(hh, session.mainThreadId, "m_old", hh.clock.t - 60_000);
    let post: Promise<Response> | null = null;
    hh.turns.set(async (_input, emit) => {
      post = hh.req("POST", "/api/connections/faketax", { token, body: { credential: await sealed(session.user.id, GOOD) } });
      await inNotify; // counted; now the tool refuses the new login and raises its card
      const card: ConnectionRequestCard = { type: "connection_request", service: "faketax", serviceName: "가짜세무", title: "가짜세무 연결이 필요해요", reason: "가짜세무 키에 조회 권한이 없어요. 다시 연결해 주세요.", status: "pending", action: { label: "연결하기", open: "connections" } };
      emit({ type: "card", card });
      return outcome("다시 연결해 주시면 이어서 할게요.", { cards: [card] });
    });
    const events = (await readSse(await hh.req("POST", `/api/threads/${session.mainThreadId}/messages`, { token, body: { text: "세금계산서 보여줘" } }))) as AgentEvent[];
    release();
    await post!;
    const done = events.find((e) => e.type === "done") as Extract<AgentEvent, { type: "done" }>;
    expect(cardsOf(hh, done.message.id).find((c) => c.type === "connection_request")).toMatchObject({ status: "pending", action: { label: "연결하기" } });
    // the card stored before the connect is resolved, and offers 이어서 하기 (no turn held a card when it was counted)
    expect(cardsOf(hh, "m_old")[0]).toMatchObject({ status: "connected", action: { label: "이어서 하기" } });
  });

  test("a login the upstream refuses: the stored card stays pending with 연결하기 (the login exists, but it is no connect)", async () => {
    const refusing: ToolDef = {
      name: "k_faketax_refused",
      description: "List my e-tax invoices (key revoked upstream)",
      parameters: { type: "object", properties: {} },
      icon: "doc",
      title: () => "가짜세무 조회",
      connection: "faketax",
      async run() {
        return needsConnection("faketax", "가짜세무", "가짜세무 키가 더 이상 맞지 않아요. 다시 연결해 주세요.");
      },
    };
    const hh = await harness({ tools: [refusing], config: { connectionWaitMs: 50 } });
    const { token, session } = await hh.signup("haneul");
    await hh.req("POST", "/api/connections/faketax", { token, body: { credential: await sealed(session.user.id, GOOD) } });
    hh.turns.set((input, emit) => createRunTurn(scriptedModel("k_faketax_refused", "다시 연결해 주시면 이어서 할게요.", []))(input, emit));
    const events = (await readSse(await hh.req("POST", `/api/threads/${session.mainThreadId}/messages`, { token, body: { text: "세금계산서 보여줘" } }))) as AgentEvent[];
    const done = events.find((e) => e.type === "done") as Extract<AgentEvent, { type: "done" }>;
    expect(done.message.cards.find((c) => c.type === "connection_request")).toMatchObject({ status: "pending", action: { label: "연결하기", open: "connections" } });
  });
});
