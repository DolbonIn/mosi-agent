/**
 * Harness for the Discord / Telegram login relay: a real createApp() with the REAL vault + enclave (@pickle/vault) and
 * the REAL MessengerHub (@pickle/messengers). Discord runs agent-messenger's real `loginWithRemoteAuth` against a fake
 * remote-auth gateway (in-memory socket) and a fake ticket exchange; the Discord SDK the hub validates with accepts
 * only the fake token. Telegram runs our real TDLib runtime, login driver and adapter over a fake libtdjson.
 * Console output is captured so tests can prove that no secret reaches the logs.
 */
import { constants as cryptoConstants, createPublicKey, publicEncrypt } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuthResponse, EnclaveEnvelope, LoginRelayResponse } from "@pickle/protocol";
import { Enclave, Vault } from "@pickle/vault";
import { sealForEnclave } from "@pickle/vault/client";
import { MessengerHub, providers } from "@pickle/messengers";
import { TdRuntime, type RemoteAuthSocket } from "@pickle/messengers/login";
import { createApp, type App } from "../../src/app.ts";
import { openDatabase, type Db } from "../../src/db/index.ts";
import type { MessengerLoginOptions } from "../../src/messenger-login/relay.ts";
import { fakeServer, FakeLauncher, makeDevice, SKILLS, webcryptoVerifyApproval } from "../helpers.ts";
import { FakeTdJson, type FakeTdOptions } from "../../../../packages/messengers/test/fake-tdlib.ts";

export const DISCORD_TOKEN = "mfa.FAKE-discord-user-token-AbCdEfGhIjKlMnOpQrStUvWxYz0123";
export const DISCORD_USER = { id: "852892297661906993", username: "alice_dc", discriminator: "0", avatar: "abc" };
export const FINGERPRINT = "FAKEfingerprint-0123456789abcdefghijklmnopq";
export const TG_APP = { apiId: 12345, apiHash: "0123456789abcdef0123456789abcdef" };

/** in-memory remote-auth gateway socket (the SDK's `ws` surface) */
export class FakeGateway extends EventEmitter implements RemoteAuthSocket {
  sent: Record<string, unknown>[] = [];
  closed = false;
  send(raw: string): void {
    this.sent.push(JSON.parse(raw));
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    queueMicrotask(() => this.emit("close", 1000));
  }
  push(payload: Record<string, unknown>): void {
    this.emit("message", Buffer.from(JSON.stringify(payload)));
  }
  encrypt(data: string): string {
    const key = (this.sent.find((m) => m.op === "init") as { encoded_public_key: string }).encoded_public_key;
    const pub = createPublicKey({ key: Buffer.from(key, "base64"), format: "der", type: "spki" });
    return publicEncrypt({ key: pub, padding: cryptoConstants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, Buffer.from(data)).toString("base64");
  }
  handshake(): void {
    this.push({ op: "hello", heartbeat_interval: 41250, timeout_ms: 248000 });
    this.push({ op: "nonce_proof", encrypted_nonce: this.encrypt("nonce") });
    this.push({ op: "pending_remote_init", fingerprint: FINGERPRINT });
  }
  scan(): void {
    const u = DISCORD_USER;
    this.push({ op: "pending_ticket", encrypted_user_payload: this.encrypt(`${u.id}:${u.discriminator}:${u.avatar}:${u.username}`) });
  }
  approve(): void {
    this.push({ op: "pending_login", ticket: "fake-ticket" });
  }
}

/** the Discord SDK the hub validates with: accepts only DISCORD_TOKEN (records every token it was given) */
export function fakeDiscordSdk(logins: string[]) {
  return {
    createClient() {
      let tok = "";
      return {
        async login(c: { token: string }) {
          tok = c.token;
          logins.push(c.token);
        },
        async testAuth() {
          if (tok !== DISCORD_TOKEN) throw Object.assign(new Error("401: Unauthorized"), { code: "unauthorized" });
          return { id: DISCORD_USER.id, username: DISCORD_USER.username, global_name: "앨리스" };
        },
        async listServers() {
          return [];
        },
        async listChannels() {
          return [];
        },
        async listDMChannels() {
          return [{ id: "D1", type: 1, recipients: [{ id: "9", username: "bob" }] }];
        },
        async getMessages() {
          return [];
        },
        async sendMessage() {
          return { id: "m1", author: { id: DISCORD_USER.id, username: "alice_dc" }, content: "", timestamp: new Date().toISOString() };
        },
      };
    },
  };
}

export interface MessengerLoginHarness {
  app: App;
  db: Db;
  vault: Vault;
  logs: string[];
  dir: string;
  gateways: FakeGateway[];
  td: FakeTdJson;
  discordLogins: string[];
  /** what the ticket exchange answers: "token" (default) | "captcha" */
  exchange: { mode: "token" | "captcha" };
  req(method: string, path: string, opts?: { token?: string; body?: unknown; headers?: Record<string, string>; raw?: BodyInit }): Promise<Response>;
  signup(handle: string): Promise<AuthResponse>;
  seal(userId: string, provider: string, aadTail: string, plaintext: Record<string, string>): Promise<EnclaveEnvelope>;
  /** a credential the person saves themselves (POST /api/connections/:p {credential}), aad `${userId}:${service}:${kind}` */
  sealCredential(userId: string, service: string, kind: "login" | "token", plaintext: Record<string, string>): Promise<EnclaveEnvelope>;
  start(token: string, provider: "discord" | "telegram", body?: Record<string, unknown>): Promise<{ status: number; body: LoginRelayResponse & { message?: string } }>;
  step(token: string, userId: string, relayId: string, kind: "phone" | "code" | "password", value: string): Promise<{ status: number; body: LoginRelayResponse & { message?: string } }>;
  poll(token: string, provider: "discord" | "telegram", relayId: string): Promise<{ status: number; body: LoginRelayResponse & { message?: string } }>;
  /** lets the gateway → SDK → relay → vault → hub chain settle */
  settle(): Promise<void>;
  close(): Promise<void>;
}

export async function makeMessengerLoginHarness(
  o: { relay?: MessengerLoginOptions; telegram?: FakeTdOptions | "not_configured"; revokeMs?: number } = {},
): Promise<MessengerLoginHarness> {
  const dir = mkdtempSync(join(tmpdir(), "pickle-messenger-login-test-"));
  const db = openDatabase(join(dir, "pickle.db"));
  const masterKey = crypto.getRandomValues(new Uint8Array(32));
  const enclave = await Enclave.load({ dir: join(dir, "enclave"), masterKey });
  const vault = new Vault({ enclave, masterKey, storage: db.vaultStorage() as never, serviceName: (id) => id });
  const td = new FakeTdJson(o.telegram === "not_configured" ? {} : (o.telegram ?? {}));
  const runtime = new TdRuntime(td);
  const discordLogins: string[] = [];
  const gateways: FakeGateway[] = [];
  const exchange = { mode: "token" as "token" | "captcha" };
  const configRoot = join(dir, "messengers");

  let appRef: App | null = null;
  const hub = new MessengerHub({
    vault,
    storage: db.messengerStorage() as never,
    configRoot,
    onUpdate: (u, c) => appRef?.notifyConnection(u, c),
    ...(o.revokeMs ? { revokeMs: o.revokeMs } : {}),
    sdk: {
      discord: async () => fakeDiscordSdk(discordLogins) as never,
      telegram: async () => ({ client: async () => runtime.client(), app: () => TG_APP }),
    },
  });

  const logs: string[] = [];
  const orig = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  const grab = (...a: unknown[]) => logs.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "));
  console.log = grab;
  console.warn = grab;
  console.error = grab;
  console.info = grab;

  const relay: MessengerLoginOptions = {
    configRoot,
    pollMs: 1000,
    stepTimeoutMs: 500,
    // discordLogin omitted: the relay loads agent-messenger's real loginWithRemoteAuth
    discordSocket: () => {
      const g = new FakeGateway();
      gateways.push(g);
      // the real gateway greets right away; the fingerprint follows the SDK's init + nonce proof
      queueMicrotask(() => g.handshake());
      return g;
    },
    discordFetch: (async () => {
      const g = gateways[gateways.length - 1]!;
      if (exchange.mode === "captcha") return new Response(JSON.stringify({ captcha_sitekey: "k", captcha_key: ["captcha-required"] }), { status: 400 });
      return new Response(JSON.stringify({ encrypted_token: g.encrypt(DISCORD_TOKEN) }), { status: 200 });
    }) as unknown as typeof fetch,
    telegram: async () => (o.telegram === "not_configured" ? { ok: false, reason: "not_configured" } : { ok: true, app: TG_APP, runtime }),
    ...o.relay,
  };

  const app = createApp({
    db,
    launcher: new FakeLauncher(),
    vault: vault as never,
    enclave,
    hub,
    providers,
    runTurn: null,
    llm: null,
    skills: { listSkills: () => SKILLS, skillTools: () => [], skillCatalogForPrompt: () => "" },
    systemTools: () => [],
    verifyApproval: webcryptoVerifyApproval,
    messengerLogin: relay,
    config: { dataDir: dir, quiet: false, passwordCost: { memoryCost: 4096, timeCost: 2 }, sseHeartbeatMs: 0, eventsHeartbeatMs: 0 },
  });
  appRef = app;

  const req: MessengerLoginHarness["req"] = async (method, path, r = {}) => {
    const headers: Record<string, string> = { ...(r.headers ?? {}) };
    if (r.token) headers.authorization = `Bearer ${r.token}`;
    let body: BodyInit | undefined = r.raw;
    if (r.body !== undefined) {
      headers["content-type"] ??= "application/json";
      body = JSON.stringify(r.body);
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
      fakeServer(`10.8.0.${++ip}`),
    );
    if (res.status !== 201) throw new Error(`signup failed ${res.status}`);
    return (await res.json()) as AuthResponse;
  };

  const seal: MessengerLoginHarness["seal"] = (userId, provider, tail, plaintext) => sealForEnclave(enclave.info(), plaintext, `${userId}:${provider}:login-relay:${tail}`);
  const sealCredential: MessengerLoginHarness["sealCredential"] = (userId, service, kind, plaintext) => sealForEnclave(enclave.info(), plaintext, `${userId}:${service}:${kind}`);
  const parse = async (res: Response) => ({ status: res.status, body: (await res.json()) as never });

  return {
    app,
    db,
    vault,
    logs,
    dir,
    gateways,
    td,
    discordLogins,
    exchange,
    req,
    signup,
    seal,
    sealCredential,
    start: async (token, provider, body = {}) => parse(await req("POST", `/api/connections/${provider}/login`, { token, body })),
    step: async (token, userId, relayId, kind, value) =>
      parse(await req("POST", "/api/connections/telegram/login/step", { token, body: { relayId, [kind]: await seal(userId, "telegram", relayId, { [kind]: value }) } })),
    poll: async (token, provider, relayId) => parse(await req("POST", `/api/connections/${provider}/login/step`, { token, body: { relayId } })),
    async settle() {
      for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 5));
    },
    async close() {
      await app.close();
      console.log = orig.log;
      console.warn = orig.warn;
      console.error = orig.error;
      console.info = orig.info;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
