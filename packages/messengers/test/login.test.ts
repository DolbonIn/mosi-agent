import { afterEach, describe, expect, it } from "bun:test";
import { constants as cryptoConstants, createPublicKey, publicEncrypt } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loginWithRemoteAuth } from "agent-messenger/discord";
import { telegramUserAdapter } from "../src/adapters/telegram-user";
import { DiscordRemoteAuth, type LoginWithRemoteAuth, type RemoteAuthSocket } from "../src/login/discord";
import { TelegramLogin, telegramAppFromEnv } from "../src/login/telegram";
import { maskPhone, normalizePhone, type LoginView } from "../src/login/types";
import { TdRuntime } from "../src/tdlib/runtime";
import { FakeTdJson, TG_CODE, TG_HINT, TG_PASSWORD, TG_PHONE_E164, TG_PHONE_LOCAL } from "./fake-tdlib";

// ───────────────────────────── helpers ─────────────────────────────

describe("phone helpers", () => {
  it("normalises Korean local numbers and international forms", () => {
    expect(normalizePhone("010-2345-6789")).toBe("+821023456789");
    expect(normalizePhone("010 2345 6789")).toBe("+821023456789");
    expect(normalizePhone("+82 10-2345-6789")).toBe("+821023456789");
    expect(normalizePhone("0044 20 7946 0958")).toBe("+442079460958");
    expect(normalizePhone("+1 (415) 555-0100")).toBe("+14155550100");
    expect(normalizePhone("12")).toBeNull();
    expect(normalizePhone("abc")).toBeNull();
  });
  it("masks phone numbers (010-****-1234)", () => {
    expect(maskPhone("+821023456789")).toBe("010-****-6789");
    expect(maskPhone("+14155550100")).toBe("+1 ****0100");
    expect(maskPhone("+442079460958")).toBe("+44 ****0958");
  });
  it("reads the operator registration only from well-formed env values", () => {
    expect(telegramAppFromEnv({})).toBeNull();
    expect(telegramAppFromEnv({ AGENT_TELEGRAM_API_ID: "12345", AGENT_TELEGRAM_API_HASH: "nothex" })).toBeNull();
    expect(telegramAppFromEnv({ AGENT_TELEGRAM_API_ID: "12345", AGENT_TELEGRAM_API_HASH: "0123456789abcdef0123456789abcdef" })).toEqual({
      apiId: 12345,
      apiHash: "0123456789abcdef0123456789abcdef",
    });
  });
});

// ───────────────────────────── Telegram ─────────────────────────────

const APP = { apiId: 12345, apiHash: "0123456789abcdef0123456789abcdef" };
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function tg(opts: ConstructorParameters<typeof FakeTdJson>[0] = {}) {
  const fake = new FakeTdJson(opts);
  const runtime = new TdRuntime(fake);
  const configDir = await mkdtemp(join(tmpdir(), "tg-login-"));
  dirs.push(configDir);
  const login = new TelegramLogin({ client: () => runtime.client(), app: APP, configDir, stepTimeoutMs: 400 });
  return { fake, runtime, configDir, login };
}

describe("TelegramLogin (fake TDLib)", () => {
  it("phone → code → connected, then the adapter reopens the encrypted database", async () => {
    const { fake, runtime, configDir, login } = await tg();
    expect((await login.start()).state).toBe("needs_phone");
    const v1 = await login.submitPhone(TG_PHONE_LOCAL);
    expect(v1).toMatchObject({ state: "needs_code", codeLength: 5, codeVia: "app", phoneMasked: "010-****-6789" });
    // the number reached TDLib in E.164
    expect(fake.requests.find((r) => r.query["@type"] === "setAuthenticationPhoneNumber")?.query.phone_number).toBe(TG_PHONE_E164);
    const v2 = await login.submitCode(TG_CODE);
    expect(v2.state).toBe("done");
    const res = login.result()!;
    expect(res.accountLabel).toBe("Alice Kim");
    expect(res.meta).toEqual({ telegramUserId: "777001" });
    expect(Object.keys(res.secret).sort()).toEqual(["databaseKey", "tdDir"]);
    expect(Buffer.from(res.secret.databaseKey!, "base64").byteLength).toBe(32);
    expect(login.result()).toBeNull(); // handed over once
    // the login closed its TDLib instance (one instance per directory)
    expect(fake.open).toBe(0);
    // every TDLib open used the same per-login encryption key
    const params = fake.requests.filter((r) => r.query["@type"] === "setTdlibParameters");
    expect(params.every((p) => p.query.database_encryption_key === res.secret.databaseKey)).toBe(true);

    const adapter = telegramUserAdapter(async () => ({ client: async () => runtime.client(), app: () => APP }));
    const ctx = { userId: "u1", configDir, now: Date.now };
    const out = await adapter.login(ctx, res.secret, {});
    expect(out.kind).toBe("connected");
    if (out.kind !== "connected") return;
    expect(out.accountLabel).toBe("Alice Kim");
    const chats = await out.session!.listChats({ limit: 10 });
    expect(chats.map((c) => [c.name, c.kind])).toEqual([
      ["엄마", "dm"],
      ["스터디 모임", "group"],
    ]);
    const msgs = await out.session!.readMessages("1001", 10);
    expect(msgs.map((m) => [m.senderName, m.text, m.isMe])).toEqual([
      ["엄마", "저녁 먹으러 와", false],
      ["나", "응 갈게", true],
    ]);
    expect(await out.session!.send("1001", "곧 도착")).toEqual({ ok: true, id: "99" });
    expect(fake.sent).toEqual([{ chatId: 1001, text: "곧 도착" }]);
    await out.session!.close();
    expect(fake.open).toBe(0);
    // a wrong key cannot open the database
    await expect(adapter.open(ctx, { ...res.secret, databaseKey: Buffer.alloc(32, 1).toString("base64") }, {})).rejects.toMatchObject({ code: "session_expired" });
    await adapter.cleanup!(ctx);
    expect(await readdir(configDir)).toEqual([]);
  });

  it("asks for the 2FA password, keeps the state on a wrong one, then connects", async () => {
    const { login } = await tg({ twoFa: true });
    await login.start();
    await login.submitPhone(TG_PHONE_LOCAL);
    const v = await login.submitCode(TG_CODE);
    expect(v).toMatchObject({ state: "needs_password", passwordHint: TG_HINT });
    const wrong = await login.submitPassword("nope");
    expect(wrong).toMatchObject({ state: "needs_password", error: { code: "wrong_password" } });
    const ok = await login.submitPassword(TG_PASSWORD);
    expect(ok.state).toBe("done");
    expect(ok.error).toBeUndefined();
    expect(login.result()?.secret.databaseKey).toBeTruthy();
  });

  it("a wrong code is retryable; an expired code ends the attempt and removes its files", async () => {
    const { login, configDir, fake } = await tg({ expiredCode: "11111" });
    await login.start();
    await login.submitPhone(TG_PHONE_LOCAL);
    expect(await login.submitCode("99999")).toMatchObject({ state: "needs_code", error: { code: "wrong_code" } });
    expect(await login.submitCode("12")).toMatchObject({ state: "needs_code", error: { code: "wrong_code" } });
    const v = await login.submitCode("11111");
    expect(v).toMatchObject({ state: "error", error: { code: "code_expired" } });
    expect(fake.open).toBe(0);
    expect(await readdir(join(configDir, "telegram"))).toEqual([]);
    // terminal: later calls change nothing
    expect((await login.submitCode(TG_CODE)).state).toBe("error");
  });

  it("maps a bad number (retry), a banned number and flood waits", async () => {
    const a = await tg({ banned: TG_PHONE_E164 });
    await a.login.start();
    expect(await a.login.submitPhone("12")).toMatchObject({ state: "needs_phone", error: { code: "phone_invalid" } });
    expect(await a.login.submitPhone(TG_PHONE_LOCAL)).toMatchObject({ state: "error", error: { code: "phone_banned" } });

    const b = await tg({ floodSeconds: 600 });
    await b.login.start();
    const v = await b.login.submitPhone(TG_PHONE_LOCAL);
    expect(v).toMatchObject({ state: "error", error: { code: "flood_wait" } });
    expect(v.error!.message).toContain("10분");

    const c = await tg({ unregistered: true });
    await c.login.start();
    await c.login.submitPhone(TG_PHONE_LOCAL);
    expect(await c.login.submitCode(TG_CODE)).toMatchObject({ state: "error", error: { code: "no_account" } });
  });

  it("cancel closes TDLib and deletes the unfinished database", async () => {
    const { login, fake, configDir } = await tg();
    await login.start();
    await login.submitPhone(TG_PHONE_LOCAL);
    const v = await login.cancel();
    expect(v.state).toBe("cancelled");
    expect(fake.open).toBe(0);
    expect(await readdir(join(configDir, "telegram"))).toEqual([]);
  });

  it("a TDLib that stops answering ends in a network error, not a hang", async () => {
    const { login, fake } = await tg({ stallPhone: true });
    await login.start();
    const v = await login.submitPhone(TG_PHONE_LOCAL);
    expect(v).toMatchObject({ state: "error", error: { code: "network" } });
    expect(fake.open).toBe(0);
  });

  it("routes events by @client_id: two concurrent logins do not see each other's states", async () => {
    const fake = new FakeTdJson({ twoFa: true });
    const runtime = new TdRuntime(fake);
    const d1 = await mkdtemp(join(tmpdir(), "tg-a-"));
    const d2 = await mkdtemp(join(tmpdir(), "tg-b-"));
    dirs.push(d1, d2);
    const a = new TelegramLogin({ client: () => runtime.client(), app: APP, configDir: d1, stepTimeoutMs: 400 });
    const b = new TelegramLogin({ client: () => runtime.client(), app: APP, configDir: d2, stepTimeoutMs: 400 });
    await Promise.all([a.start(), b.start()]);
    await a.submitPhone(TG_PHONE_LOCAL);
    expect(b.current.state).toBe("needs_phone");
    await a.submitCode(TG_CODE);
    expect(a.current.state).toBe("needs_password");
    expect(b.current.state).toBe("needs_phone");
    await Promise.all([a.cancel(), b.cancel()]);
    expect(runtime.size).toBe(0);
  });
});

// ───────────────────────────── Discord (real SDK, fake gateway) ─────────────────────────────

const USER = { id: "852892297661906993", username: "alice", discriminator: "0", avatar: "abc" };
const DISCORD_TOKEN = "mfa.FAKE-discord-token-AbCdEfGhIjKlMnOpQrStUvWxYz";

class FakeGateway extends EventEmitter implements RemoteAuthSocket {
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
  key(): string {
    return (this.sent.find((m) => m.op === "init") as { encoded_public_key: string }).encoded_public_key;
  }
  encrypt(data: string): string {
    const pub = createPublicKey({ key: Buffer.from(this.key(), "base64"), format: "der", type: "spki" });
    return publicEncrypt({ key: pub, padding: cryptoConstants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, Buffer.from(data)).toString("base64");
  }
  /** hello → nonce proof → fingerprint (what the real gateway does before anyone scans) */
  handshake(fp = "FINGERPRINT123"): void {
    this.push({ op: "hello", heartbeat_interval: 41250, timeout_ms: 248000 });
    this.push({ op: "nonce_proof", encrypted_nonce: this.encrypt("nonce") });
    this.push({ op: "pending_remote_init", fingerprint: fp });
  }
}

function discord(fetchImpl?: typeof fetch) {
  const gw = new FakeGateway();
  const changes: LoginView[] = [];
  const auth = new DiscordRemoteAuth({
    login: loginWithRemoteAuth as unknown as LoginWithRemoteAuth,
    socket: () => gw,
    timeoutMs: 5_000,
    onChange: (v) => changes.push(v),
    fetchImpl,
  });
  return { gw, auth, changes };
}

describe("DiscordRemoteAuth (agent-messenger SDK against a fake gateway)", () => {
  it("waiting_scan → waiting_confirm (name) → done with the decrypted token", async () => {
    let gwRef: FakeGateway | null = null;
    const fetchImpl = (async (_url: string, init?: { body?: string }) => {
      expect(JSON.parse(init?.body ?? "{}").ticket).toBe("the-ticket");
      return new Response(JSON.stringify({ encrypted_token: gwRef!.encrypt(DISCORD_TOKEN) }), { status: 200 });
    }) as unknown as typeof fetch;
    const { gw, auth, changes } = discord(fetchImpl);
    gwRef = gw;
    const started = auth.start();
    gw.handshake();
    const v = await started;
    expect(v).toEqual({ state: "waiting_scan", qrUrl: "https://discord.com/ra/FINGERPRINT123" });
    gw.push({ op: "pending_ticket", encrypted_user_payload: gw.encrypt(`${USER.id}:${USER.discriminator}:${USER.avatar}:${USER.username}`) });
    expect(auth.current).toEqual({ state: "waiting_confirm", account: { name: "alice" } });
    gw.push({ op: "pending_login", ticket: "the-ticket" });
    await auth.settledPromise();
    expect(auth.current.state).toBe("done");
    expect(changes.map((c) => c.state)).toEqual(["waiting_scan", "waiting_confirm", "done"]);
    // no state the relay can show carries the token
    expect(JSON.stringify(changes)).not.toContain(DISCORD_TOKEN);
    const res = auth.result()!;
    expect(res).toEqual({ secret: { token: DISCORD_TOKEN }, accountLabel: "alice", meta: { discordUserId: USER.id } });
    expect(auth.result()).toBeNull();
    expect(gw.closed).toBe(true);
  });

  it("gateway timeout (4003) → expired", async () => {
    const { gw, auth } = discord();
    const started = auth.start();
    gw.handshake();
    await started;
    gw.emit("close", 4003);
    await auth.settledPromise();
    expect(auth.current).toMatchObject({ state: "expired", error: { code: "timeout" } });
  });

  it("cancel in the Discord app → cancelled (qr_rejected)", async () => {
    const { gw, auth } = discord();
    const started = auth.start();
    gw.handshake();
    await started;
    gw.push({ op: "cancel" });
    await auth.settledPromise();
    expect(auth.current).toMatchObject({ state: "cancelled", error: { code: "qr_rejected" } });
  });

  it("cancel here closes the socket and drops everything", async () => {
    const { gw, auth } = discord();
    const started = auth.start();
    gw.handshake();
    await started;
    const v = await auth.cancel();
    expect(v).toMatchObject({ state: "cancelled", error: { code: "cancelled" } });
    expect(gw.closed).toBe(true);
    expect(auth.result()).toBeNull();
  });

  it("captcha on the ticket exchange → error captcha", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ captcha_sitekey: "k", captcha_key: ["captcha-required"] }), { status: 400 })) as unknown as typeof fetch;
    const { gw, auth } = discord(fetchImpl);
    const started = auth.start();
    gw.handshake();
    await started;
    gw.push({ op: "pending_login", ticket: "t" });
    await auth.settledPromise();
    expect(auth.current).toMatchObject({ state: "error", error: { code: "captcha" } });
    expect(auth.result()).toBeNull();
  });

  it("a socket that fails before the QR resolves start() with an error view", async () => {
    const { gw, auth } = discord();
    const started = auth.start();
    gw.emit("error", new Error("ECONNREFUSED"));
    const v = await started;
    expect(v).toMatchObject({ state: "error", error: { code: "network" } });
  });
});
