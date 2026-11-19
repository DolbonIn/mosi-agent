/**
 * Discord (remote auth) and Telegram (phone login) relay, server side: routes, sealing, validation, rate limits,
 * expiry, cancel, wrong code, 2FA, the vault hand-off through the real hub + adapters, cleanup and log hygiene.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { TG_CODE, TG_HINT, TG_PASSWORD, TG_PHONE_E164, TG_PHONE_LOCAL } from "../../../packages/messengers/test/fake-tdlib.ts";
import { DISCORD_TOKEN, FINGERPRINT, makeMessengerLoginHarness, type MessengerLoginHarness } from "./fixtures/messenger-login-harness.ts";

let h: MessengerLoginHarness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

async function setup(o: Parameters<typeof makeMessengerLoginHarness>[0] = {}) {
  h = await makeMessengerLoginHarness(o);
  const auth = await h.signup(`user${Math.floor(Math.random() * 1e6)}`);
  return { h, token: auth.token, userId: auth.session.user.id };
}

/** every value a person typed or a provider handed back must stay out of the logs */
function assertNoSecretsInLogs(logs: string[], extra: string[] = []) {
  const text = logs.join("\n");
  expect(text.length).toBeGreaterThan(0);
  for (const s of [DISCORD_TOKEN, "mfa.FAKE", FINGERPRINT, "discord.com/ra", "data:image/svg", TG_PHONE_LOCAL, TG_PHONE_E164, "23456789", "2345-6789", TG_CODE, TG_PASSWORD, TG_HINT, ...extra]) {
    expect(text).not.toContain(s);
  }
}

/** database directories the fake TDLib currently treats as logged in */
function authorisedDbs(x: MessengerLoginHarness): string[] {
  return [...x.td.dbs.entries()].filter(([, d]) => d.authorised).map(([dir]) => dir);
}

async function connections(token: string) {
  const res = await h!.req("GET", "/api/connections", { token });
  return ((await res.json()) as { connections: { provider: string; status: string; accountLabel: string | null; credentialId: string | null }[] }).connections;
}

// ───────────────────────────── Discord ─────────────────────────────

describe("discord remote-auth relay", () => {
  test("waiting_scan (QR link) → waiting_confirm (name) → connected; token sealed in the vault and validated by the adapter", async () => {
    const { h, token, userId } = await setup();
    const s = await h.start(token, "discord");
    expect(s.status).toBe(200);
    expect(s.body).toMatchObject({ state: "waiting_scan", qrUrl: `https://discord.com/ra/${FINGERPRINT}`, pollMs: 1000 });
    expect(s.body.relayId).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
    // the same link as a QR image the app can show under its CSP (data: only)
    expect(s.body.qrSvg).toStartWith("data:image/svg+xml;base64,");
    expect(Buffer.from(s.body.qrSvg!.split(",")[1]!, "base64").toString()).toStartWith("<svg");
    expect(s.body.expiresAt).toBeGreaterThan(Date.now());
    // the countdown follows Discord's own QR lifetime (hello.timeout_ms 248 s), shorter than the 5 min relay
    expect(s.body.expiresAt).toBeLessThanOrEqual(Date.now() + 248_000);
    expect(s.body.expiresAt).toBeGreaterThan(Date.now() + 240_000);
    const gw = h.gateways[0]!;

    expect((await h.poll(token, "discord", s.body.relayId)).body.state).toBe("waiting_scan");
    gw.scan();
    const c = await h.poll(token, "discord", s.body.relayId);
    expect(c.body).toMatchObject({ state: "waiting_confirm", account: { name: "alice_dc" }, pollMs: 1000 });
    expect(c.body.qrUrl).toBeUndefined();

    gw.approve();
    await h.settle();
    await h.app.core.idle();
    const done = await h.poll(token, "discord", s.body.relayId);
    expect(done.body.state).toBe("connected");
    expect(done.body.connection).toMatchObject({ provider: "discord", status: "connected", accountLabel: "앨리스" });
    // the adapter validated exactly the token Discord released
    expect(h.discordLogins).toEqual([DISCORD_TOKEN]);
    const conns = await connections(token);
    expect(conns.find((x) => x.provider === "discord")).toMatchObject({ status: "connected", accountLabel: "앨리스" });
    const creds = await h.vault.list(userId);
    expect(creds.map((x) => [x.service, x.kind])).toEqual([["discord", "token"]]);
    // nothing that leaves the server carries the token
    expect(JSON.stringify([s.body, c.body, done.body, conns, creds])).not.toContain(DISCORD_TOKEN);
    expect(gw.closed).toBe(true);
    // the hub can use the sealed session
    const chats = await h.req("GET", "/api/connections/discord/chats", { token });
    expect(chats.status).toBe(200);
    // the connection owns the session (hub session mode): 연결 해제 removes the sealed token too
    expect((await h.req("DELETE", "/api/connections/discord", { token })).status).toBeLessThan(300);
    expect(await h.vault.list(userId)).toEqual([]);
    assertNoSecretsInLogs(h.logs);
  });

  test("the gateway's own timeout → expired; the relay TTL → expired and the socket is closed", async () => {
    const { h, token } = await setup();
    const s = await h.start(token, "discord");
    h.gateways[0]!.emit("close", 4003);
    await h.settle();
    const p = await h.poll(token, "discord", s.body.relayId);
    expect(p.body).toMatchObject({ state: "expired", error: { code: "timeout" } });
    await h.close();

    const t = await setup({ relay: { ttlMs: 120 } });
    const s2 = await t.h.start(t.token, "discord");
    expect(s2.body.state).toBe("waiting_scan");
    await new Promise((r) => setTimeout(r, 250));
    await t.h.settle();
    const p2 = await t.h.poll(t.token, "discord", s2.body.relayId);
    expect(p2.body.state).toBe("expired");
    expect(t.h.gateways[0]!.closed).toBe(true);
  });

  test("cancel here closes the socket; cancel in the Discord app → cancelled (qr_rejected)", async () => {
    const { h, token, userId } = await setup();
    const s = await h.start(token, "discord");
    const res = await h.req("POST", "/api/connections/discord/login/cancel", { token, body: { relayId: s.body.relayId } });
    expect(await res.json()).toEqual({ ok: true });
    await h.settle();
    expect(h.gateways[0]!.closed).toBe(true);
    expect((await h.poll(token, "discord", s.body.relayId)).body).toMatchObject({ state: "cancelled", error: { code: "cancelled" } });

    const s2 = await h.start(token, "discord");
    h.gateways[1]!.push({ op: "cancel" });
    await h.settle();
    expect((await h.poll(token, "discord", s2.body.relayId)).body).toMatchObject({ state: "cancelled", error: { code: "qr_rejected" } });
    expect(await h.vault.list(userId)).toEqual([]);
  });

  test("captcha on the ticket exchange → error captcha, nothing stored", async () => {
    const { h, token, userId } = await setup();
    h.exchange.mode = "captcha";
    const s = await h.start(token, "discord");
    h.gateways[0]!.scan();
    h.gateways[0]!.approve();
    await h.settle();
    expect((await h.poll(token, "discord", s.body.relayId)).body).toMatchObject({ state: "error", error: { code: "captcha" } });
    expect(await h.vault.list(userId)).toEqual([]);
    expect((await connections(token)).find((c) => c.provider === "discord")).toBeUndefined();
  });

  test("a token the adapter rejects is removed from the vault again (auth_failed)", async () => {
    const { h, token, userId } = await setup();
    const s = await h.start(token, "discord");
    // the gateway encrypts a different token than the one the SDK fake accepts
    const g = h.gateways[0]!;
    const orig = g.encrypt.bind(g);
    g.encrypt = (d: string) => orig(d === DISCORD_TOKEN ? "mfa.some-other-token-that-is-long-enough" : d);
    g.scan();
    g.approve();
    await h.settle();
    await h.app.core.idle();
    expect((await h.poll(token, "discord", s.body.relayId)).body).toMatchObject({ state: "error", error: { code: "auth_failed" } });
    expect(await h.vault.list(userId)).toEqual([]);
  });
});

// ───────────────────────────── Telegram ─────────────────────────────

describe("telegram phone relay", () => {
  test("phone → wrong code (retry) → code → 2FA (wrong, then right) → connected; adapter reads chats", async () => {
    const { h, token, userId } = await setup({ telegram: { twoFa: true } });
    const s = await h.start(token, "telegram", { keepFor: "7d" });
    expect(s.body).toMatchObject({ state: "needs_phone" });
    const id = s.body.relayId;

    const p = await h.step(token, userId, id, "phone", TG_PHONE_LOCAL);
    expect(p.body).toMatchObject({ state: "needs_code", codeLength: 5, codeVia: "app", phoneMasked: "010-****-6789" });
    expect(h.td.requests.find((r) => r.query["@type"] === "setAuthenticationPhoneNumber")?.query.phone_number).toBe(TG_PHONE_E164);

    const wrong = await h.step(token, userId, id, "code", "99999");
    expect(wrong.body).toMatchObject({ state: "needs_code", error: { code: "wrong_code" } });
    const c = await h.step(token, userId, id, "code", TG_CODE);
    expect(c.body).toMatchObject({ state: "needs_password", passwordHint: TG_HINT });
    expect(c.body.error).toBeUndefined();

    const badPw = await h.step(token, userId, id, "password", "nope");
    expect(badPw.body).toMatchObject({ state: "needs_password", error: { code: "wrong_password" } });
    const done = await h.step(token, userId, id, "password", TG_PASSWORD);
    expect(done.body.state).toBe("connected");
    expect(done.body.connection).toMatchObject({ provider: "telegram", status: "connected", accountLabel: "Alice Kim" });

    const creds = await h.vault.list(userId);
    expect(creds).toHaveLength(1);
    expect(creds[0]).toMatchObject({ service: "telegram", kind: "token", keepFor: "7d" });
    const chats = await h.req("GET", "/api/connections/telegram/chats", { token });
    expect(chats.status).toBe(200);
    expect(((await chats.json()) as { name: string }[]).map((x) => x.name)).toEqual(["엄마", "스터디 모임"]);
    // a late poll gets the final answer
    expect((await h.poll(token, "telegram", id)).body.state).toBe("connected");

    // 연결 해제: Telegram logOut (the device leaves the person's active sessions), then the files, then the key
    const tdDir = [...h.td.dbs.keys()].find((d) => h.td.dbs.get(d)?.authorised)!;
    expect(tdDir).toBeTruthy();
    expect((await h.req("DELETE", "/api/connections/telegram", { token })).status).toBeLessThan(300);
    expect(h.td.loggedOut).toEqual([tdDir]);
    expect(h.td.dbs.get(tdDir)?.authorised).toBe(false);
    expect(await h.vault.list(userId)).toEqual([]);
    const users = await readdir(join(h.dir, "messengers"));
    const left = await readdir(join(h.dir, "messengers", users.find((u) => u !== "_shared")!, "telegram")).catch(() => [] as string[]);
    expect(left).toEqual([]);
    expect(h.td.open).toBe(0);
    assertNoSecretsInLogs(h.logs);
  });

  test("no 2FA: phone → code → connected; a re-login replaces the old session and its files", async () => {
    const { h, token, userId } = await setup();
    const login = async () => {
      const s = await h.start(token, "telegram");
      await h.step(token, userId, s.body.relayId, "phone", TG_PHONE_LOCAL);
      return h.step(token, userId, s.body.relayId, "code", TG_CODE);
    };
    expect((await login()).body.state).toBe("connected");
    const first = await h.vault.list(userId);
    const firstDb = authorisedDbs(h);
    expect(firstDb).toHaveLength(1);
    expect((await login()).body.state).toBe("connected");
    const second = await h.vault.list(userId);
    expect(second).toHaveLength(1);
    expect(second[0]!.id).not.toBe(first[0]!.id);
    // the replaced session was signed out at Telegram (the old "모시" device leaves the list); the new one was not
    expect(h.td.loggedOut).toEqual(firstDb);
    expect(authorisedDbs(h)).toHaveLength(1);
    expect(authorisedDbs(h)).not.toEqual(firstDb);
    // exactly one TDLib account directory is left (the hub's own session may hold it open)
    const users = await readdir(join(h.dir, "messengers"));
    const dirs = await readdir(join(h.dir, "messengers", users.find((u) => u !== "_shared")!, "telegram"));
    expect(dirs).toHaveLength(1);
  });

  test("연결 해제 never hangs on Telegram: a failing logOut is swallowed, a hanging one is cut off by the hub's timeout", async () => {
    for (const mode of ["logOutFails", "stallLogOut"] as const) {
      const { h: x, token, userId } = await setup({ telegram: { [mode]: true }, revokeMs: 300 });
      const s = await x.start(token, "telegram");
      await x.step(token, userId, s.body.relayId, "phone", TG_PHONE_LOCAL);
      expect((await x.step(token, userId, s.body.relayId, "code", TG_CODE)).body.state).toBe("connected");
      const t0 = Date.now();
      expect((await x.req("DELETE", "/api/connections/telegram", { token })).status).toBeLessThan(300);
      expect(Date.now() - t0).toBeLessThan(3_000);
      expect(x.td.logOutCalls).toBe(1);
      // the connection, the sealed key and the files are gone anyway
      expect((await connections(token)).find((c) => c.provider === "telegram")).toBeUndefined();
      expect(await x.vault.list(userId)).toEqual([]);
      const users = await readdir(join(x.dir, "messengers"));
      expect(await readdir(join(x.dir, "messengers", users.find((u) => u !== "_shared")!, "telegram")).catch(() => [] as string[])).toEqual([]);
      await x.close();
      h = null;
    }
  });

  test("a Telegram login the person saved themselves is never signed out by 연결 해제 (only relay sessions are)", async () => {
    const { h, token, userId } = await setup();
    // an authorised database the person brought (not produced by the relay)
    const { userConfigDir, TELEGRAM_DIR } = await import("@pickle/messengers/login");
    const tdDir = "s-mine000000";
    const databaseKey = "user-saved-key-0123456789abcdef";
    h.td.dbs.set(join(userConfigDir(join(h.dir, "messengers"), userId), TELEGRAM_DIR, tdDir, "db"), { key: databaseKey, authorised: true });
    const envelope = await h.sealCredential(userId, "telegram", "token", { databaseKey, tdDir });
    const res = await h.req("POST", "/api/connections/telegram", {
      token,
      body: { credential: { service: "telegram", label: "텔레그램 (내 세션)", kind: "token", hint: "내 세션", keepFor: "7d", envelope } },
    });
    expect(res.status).toBeLessThan(300);
    expect(((await res.json()) as { connection: { status: string } }).connection.status).toBe("connected");
    expect((await h.req("DELETE", "/api/connections/telegram", { token })).status).toBeLessThan(300);
    expect(h.td.logOutCalls).toBe(0);
    // the person's own saved login stays in their vault
    expect((await h.vault.list(userId)).map((c) => c.service)).toEqual(["telegram"]);
  });

  test("five wrong codes stop the relay (too_many_attempts) and remove the unfinished database", async () => {
    const { h, token, userId } = await setup();
    const s = await h.start(token, "telegram");
    await h.step(token, userId, s.body.relayId, "phone", TG_PHONE_LOCAL);
    let last;
    for (let i = 0; i < 5; i++) last = await h.step(token, userId, s.body.relayId, "code", `1111${i}`);
    expect(last!.body).toMatchObject({ state: "error", error: { code: "too_many_attempts" } });
    await h.app.core.idle();
    await h.settle();
    expect(h.td.open).toBe(0);
    const users = await readdir(join(h.dir, "messengers"));
    const base = join(h.dir, "messengers", users.find((u) => u !== "_shared")!, "telegram");
    expect(await readdir(base).catch(() => [])).toEqual([]);
    expect(await h.vault.list(userId)).toEqual([]);
  });

  test("not configured (no api_id): start answers error not_configured", async () => {
    const { h, token } = await setup({ telegram: "not_configured" });
    const s = await h.start(token, "telegram");
    expect(s.body).toMatchObject({ state: "error", error: { code: "not_configured" } });
  });

  test("relay TTL → expired; TDLib closed and files removed; cancel does the same", async () => {
    const { h, token, userId } = await setup({ relay: { ttlMs: 150 } });
    const s = await h.start(token, "telegram");
    await h.step(token, userId, s.body.relayId, "phone", TG_PHONE_LOCAL);
    await new Promise((r) => setTimeout(r, 250));
    await h.settle();
    expect((await h.poll(token, "telegram", s.body.relayId)).body).toMatchObject({ state: "expired", error: { code: "timeout" } });
    expect(h.td.open).toBe(0);
    const late = await h.step(token, userId, s.body.relayId, "code", TG_CODE);
    expect(late.body.state).toBe("expired");
  });

  test("validation: auth, JSON only, envelopes bound to this user AND this relay, replay, wrong step, other users", async () => {
    const { h, token, userId } = await setup();
    // no auth
    expect((await h.req("POST", "/api/connections/telegram/login", { body: {} })).status).toBe(401);
    // JSON only
    expect((await h.req("POST", "/api/connections/telegram/login", { token, raw: "keepFor=30d", headers: { "content-type": "application/x-www-form-urlencoded" } })).status).toBe(415);
    // no secrets at start
    expect((await h.start(token, "telegram", { phone: { v: 1 } })).status).toBe(400);
    // unknown provider keeps answering through the Slack routes (404 there)
    expect((await h.req("POST", "/api/connections/kakaotalk/login", { token, body: {} })).status).toBe(404);

    const s = await h.start(token, "telegram");
    const id = s.body.relayId;
    // sealed for the start aad (or another relay) → refused, relay stays usable
    const wrongAad = await h.seal(userId, "telegram", "start", { phone: TG_PHONE_LOCAL });
    const r1 = await h.req("POST", "/api/connections/telegram/login/step", { token, body: { relayId: id, phone: wrongAad } });
    expect(r1.status).toBe(400);
    expect(((await r1.json()) as { error: string }).error).toBe("invalid_envelope");
    const otherProvider = await h.seal(userId, "discord", id, { phone: TG_PHONE_LOCAL });
    expect((await h.req("POST", "/api/connections/telegram/login/step", { token, body: { relayId: id, phone: otherProvider } })).status).toBe(400);
    // code before phone → 409
    const early = await h.req("POST", "/api/connections/telegram/login/step", { token, body: { relayId: id, code: await h.seal(userId, "telegram", id, { code: TG_CODE }) } });
    expect(early.status).toBe(409);
    // two secret fields → 400
    const env = await h.seal(userId, "telegram", id, { phone: TG_PHONE_LOCAL });
    expect((await h.req("POST", "/api/connections/telegram/login/step", { token, body: { relayId: id, phone: env, code: env } })).status).toBe(400);
    // the right envelope works once; the same envelope again is a replay
    const ok = await h.req("POST", "/api/connections/telegram/login/step", { token, body: { relayId: id, phone: env } });
    expect(((await ok.json()) as { state: string }).state).toBe("needs_code");
    const codeEnv = await h.seal(userId, "telegram", id, { code: "99999" });
    expect((await h.req("POST", "/api/connections/telegram/login/step", { token, body: { relayId: id, code: codeEnv } })).status).toBe(200);
    const replay = await h.req("POST", "/api/connections/telegram/login/step", { token, body: { relayId: id, code: codeEnv } });
    expect(replay.status).toBe(400);
    // another user cannot see or drive this relay
    const other = await h.signup("otheruser9");
    expect((await h.poll(other.token, "telegram", id)).status).toBe(404);
    const theirs = await h.seal(other.session.user.id, "telegram", id, { code: TG_CODE });
    expect((await h.req("POST", "/api/connections/telegram/login/step", { token: other.token, body: { relayId: id, code: theirs } })).status).toBe(404);
    expect((await h.req("POST", "/api/connections/telegram/login/cancel", { token: other.token, body: { relayId: id } })).status).toBe(200);
    expect((await h.poll(token, "telegram", id)).body.state).toBe("needs_code");
    assertNoSecretsInLogs(h.logs);
  });

  test("rate limit: the 7th start in the window → 429 with Retry-After; one relay per user (a new start replaces the old)", async () => {
    const { h, token } = await setup();
    const first = await h.start(token, "telegram");
    for (let i = 0; i < 5; i++) expect((await h.start(token, i % 2 ? "discord" : "telegram")).status).toBe(200);
    // the first relay was replaced → its late poll says cancelled
    expect((await h.poll(token, "telegram", first.body.relayId)).body.state).toBe("cancelled");
    const r = await h.req("POST", "/api/connections/telegram/login", { token, body: {} });
    expect(r.status).toBe(429);
    expect(Number(r.headers.get("retry-after"))).toBeGreaterThan(0);
    await h.app.core.idle();
    await h.settle();
    // replaced relays closed their TDLib instances and sockets
    expect(h.td.open).toBeLessThanOrEqual(1);
    expect(h.gateways.slice(0, -1).every((g) => g.closed)).toBe(true);
  });
});
