/**
 * Harness for the Slack login relay: a real createApp() with the REAL vault + enclave (@pickle/vault) and the REAL
 * MessengerHub (@pickle/messengers), whose Slack Web API is a local fake that answers auth.test for the fake site's tokens.
 * Console output is captured so tests can prove that no secret reaches the logs.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuthResponse, EnclaveEnvelope, LoginRelayResponse } from "@pickle/protocol";
import { Enclave, Vault } from "@pickle/vault";
import { sealForEnclave } from "@pickle/vault/client";
import { MessengerHub, providers } from "@pickle/messengers";
import { createApp, type App } from "../../src/app.ts";
import { openDatabase, type Db } from "../../src/db/index.ts";
import type { SlackLoginOptions } from "../../src/slack-login/relay.ts";
import { fakeServer, FakeLauncher, makeDevice, SKILLS, webcryptoVerifyApproval } from "../helpers.ts";

export interface FakeSlackSdkState {
  logins: { token: string; cookie: string }[];
  /** auth.test accepts tokens that start with this */
  accept: RegExp;
}

/**
 * The Slack Web API the adapter calls with fetch (never slack.com): auth.test accepts the fake site's tokens
 * (`state.accept` plus a `xoxd-` d cookie) and records the session it carried in `state.logins`; every other method
 * (auth.signout on disconnect) goes on to `upstream` — the fake site's /api — or, without one, is refused.
 */
export function startFakeSlackApi(state: FakeSlackSdkState, upstream?: string) {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const method = new URL(req.url).pathname.replace(/^\/api\//, "");
      const body = await req.text();
      const authorization = req.headers.get("authorization") ?? "";
      const cookie = req.headers.get("cookie") ?? "";
      if (method === "auth.test") {
        const creds = { token: authorization.replace(/^Bearer /, ""), cookie: cookie.replace(/^d=/, "") };
        state.logins.push(creds);
        if (!state.accept.test(creds.token) || !/^xoxd-/.test(creds.cookie)) return Response.json({ ok: false, error: "invalid_auth" });
        const team = /xoxc-FAKE-(T\w+)-/.exec(creds.token)?.[1] ?? "T0";
        return Response.json({ ok: true, user_id: "U0FAKE", team_id: team, user: "kim", team: team === "T0BETA002" ? "Beta Labs" : "Acme Corp" });
      }
      if (!upstream) return new Response("no upstream", { status: 503 });
      const headers = { authorization, cookie, "content-type": req.headers.get("content-type") ?? "application/x-www-form-urlencoded" };
      const res = await fetch(`${upstream}/${method}`, { method: "POST", headers, body, redirect: "manual" });
      return new Response(await res.text(), { status: res.status, headers: { "content-type": res.headers.get("content-type") ?? "application/json" } });
    },
  });
  return { url: `http://127.0.0.1:${server.port}/api`, stop: () => server.stop(true) };
}

/** the Slack SDK the hub loads: only `apiUrl` is used (the user session talks to the Web API with fetch) */
export function fakeSlackSdk(apiUrl: string) {
  return {
    apiUrl,
    createClient() {
      throw new Error("the Slack user session does not use agent-messenger's client");
    },
  };
}

export interface RelayHarness {
  app: App;
  db: Db;
  vault: Vault;
  enclave: Enclave;
  slack: FakeSlackSdkState;
  logs: string[];
  req(method: string, path: string, opts?: { token?: string; body?: unknown; headers?: Record<string, string>; raw?: BodyInit }): Promise<Response>;
  signup(handle: string): Promise<AuthResponse>;
  seal(userId: string, aadTail: string, plaintext: Record<string, string>): Promise<EnclaveEnvelope>;
  /** POST /login then /login/step helpers returning the parsed body */
  start(token: string, userId: string, body: { workspace?: string; method?: "code" | "password"; email: string; keepFor?: string }): Promise<{ status: number; body: LoginRelayResponse & { error?: unknown; message?: string } }>;
  step(token: string, userId: string, relayId: string, kind: "code" | "password" | "totp" | "teamId", value: string): Promise<{ status: number; body: LoginRelayResponse & { message?: string } }>;
  close(): Promise<void>;
}

export async function makeRelayHarness(slackLogin: SlackLoginOptions, opts: { slackApiUrl?: string } = {}): Promise<RelayHarness> {
  const dir = mkdtempSync(join(tmpdir(), "pickle-slack-login-test-"));
  const db = openDatabase(join(dir, "pickle.db"));
  const masterKey = crypto.getRandomValues(new Uint8Array(32));
  const enclave = await Enclave.load({ dir: join(dir, "enclave"), masterKey });
  const vault = new Vault({ enclave, masterKey, storage: db.vaultStorage() as never, serviceName: (id) => (id === "slack" ? "슬랙" : id) });
  const slack: FakeSlackSdkState = { logins: [], accept: /^xoxc-FAKE-/ };
  const slackApi = startFakeSlackApi(slack, opts.slackApiUrl);
  let appRef: App | null = null;
  const hub = new MessengerHub({
    vault,
    storage: db.messengerStorage() as never,
    configRoot: join(dir, "messengers"),
    onUpdate: (u, c) => appRef?.notifyConnection(u, c),
    sdk: { slack: async () => fakeSlackSdk(slackApi.url) as never },
  });

  // capture everything the server prints (the relay logs through core.log → console)
  const logs: string[] = [];
  const orig = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  const grab = (...a: unknown[]) => logs.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "));
  console.log = grab;
  console.warn = grab;
  console.error = grab;
  console.info = grab;

  const app = createApp({
    db,
    launcher: new FakeLauncher(),
    vault: vault as never,
    enclave,
    hub,
    providers, // the real catalog: DELETE /api/connections/slack etc. need a known provider
    runTurn: null,
    llm: null,
    skills: { listSkills: () => SKILLS, skillTools: () => [], skillCatalogForPrompt: () => "" },
    systemTools: () => [],
    verifyApproval: webcryptoVerifyApproval,
    slackLogin,
    config: { dataDir: dir, quiet: false, passwordCost: { memoryCost: 4096, timeCost: 2 }, sseHeartbeatMs: 0, eventsHeartbeatMs: 0 },
  });
  appRef = app;

  const req: RelayHarness["req"] = async (method, path, o = {}) => {
    const headers: Record<string, string> = { ...(o.headers ?? {}) };
    if (o.token) headers.authorization = `Bearer ${o.token}`;
    let body: BodyInit | undefined = o.raw;
    if (o.body !== undefined) {
      headers["content-type"] ??= "application/json";
      body = JSON.stringify(o.body);
    }
    return app.fetch(new Request(`http://localhost${path}`, { method, headers, body }), fakeServer());
  };

  let ip = 0;
  const signup = async (handle: string) => {
    const device = await makeDevice();
    const res = await app.fetch(
      new Request("http://localhost/api/auth/signup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ handle, password: "correct horse battery", displayName: "하늘", agentName: "모시", device }),
      }),
      fakeServer(`10.9.0.${++ip}`),
    );
    if (res.status !== 201) throw new Error(`signup failed ${res.status}`);
    return (await res.json()) as AuthResponse;
  };

  const seal = (userId: string, tail: string, plaintext: Record<string, string>) => sealForEnclave(enclave.info(), plaintext, `${userId}:slack:login-relay:${tail}`);

  const start: RelayHarness["start"] = async (token, userId, b) => {
    const res = await req("POST", "/api/connections/slack/login", {
      token,
      body: { provider: "slack", workspace: b.workspace, method: b.method, keepFor: b.keepFor, email: await seal(userId, "start", { email: b.email }) },
    });
    return { status: res.status, body: (await res.json()) as never };
  };
  const step: RelayHarness["step"] = async (token, userId, relayId, kind, value) => {
    const body: Record<string, unknown> = { relayId };
    body[kind] = kind === "teamId" ? value : await seal(userId, relayId, { [kind]: value });
    const res = await req("POST", "/api/connections/slack/login/step", { token, body });
    return { status: res.status, body: (await res.json()) as never };
  };

  return {
    app,
    db,
    vault,
    enclave,
    slack,
    logs,
    req,
    signup,
    seal,
    start,
    step,
    async close() {
      await app.close();
      slackApi.stop();
      console.log = orig.log;
      console.warn = orig.warn;
      console.error = orig.error;
      console.info = orig.info;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
