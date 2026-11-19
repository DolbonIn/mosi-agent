import { test, expect, describe, afterEach } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ConnectionVerification } from "@pickle/protocol";
import { MessengerError, providers } from "../src/index.ts";
import type { InstagramSdk, TeamsAuth, TeamsSdk } from "../src/sdk.ts";
import type { ProviderAdapter } from "../src/adapters/types.ts";
import { KAKAO_EMAIL, KAKAO_PASSWORD, fakeKakao, fakeSlack, gate, harness, sealedLogin, type Harness } from "./helpers.ts";
import { fakeSlackWeb, type FakeSlackWeb } from "./fake-slack-web.ts";

let h: Harness | null = null;
let slackWeb: FakeSlackWeb | null = null;
afterEach(async () => {
  await h?.cleanup();
  h = null;
  slackWeb?.stop();
  slackWeb = null;
});

const U = "user_1";

function secretsLeaked(blob: string, secrets: string[]): string[] {
  return secrets.filter((s) => blob.includes(s));
}

async function sessionSecret(hh: Harness, userId: string, provider: string) {
  const conn = await hh.storage.getConnection(userId, provider);
  const meta = JSON.parse(conn!.meta!) as { sessionCredentialId: string };
  return hh.vault.access(userId, { actor: "system" }).use(meta.sessionCredentialId, { action: "view", purpose: "test" }, async (s) => ({ ...s }));
}

describe("KakaoTalk", () => {
  test("device-sealed envelope → enclave → login → session sealed back (end-to-end)", async () => {
    const kakao = fakeKakao();
    h = await harness({ kakaotalk: async () => kakao.sdk });
    const credential = await sealedLogin(h, U, "kakaotalk", { email: KAKAO_EMAIL, password: KAKAO_PASSWORD });
    // the request body that crosses the wire holds no plaintext
    expect(secretsLeaked(JSON.stringify(credential), [KAKAO_PASSWORD, KAKAO_EMAIL])).toEqual([]);

    const res = await h.hub.connect(U, "kakaotalk", { credential });
    expect(res.verification).toBeUndefined();
    expect(res.connection.status).toBe("connected");
    expect(res.connection.accountLabel).toBe("하늘 (ha***@kakao.com)");
    expect(res.connection.lastError).toBeNull();

    // the connector got exactly the device-entered secret, on the tablet slot, not forced
    expect(kakao.state.loginCalls[0]).toEqual({ email: KAKAO_EMAIL, password: KAKAO_PASSWORD, deviceUuid: "device-uuid-1", deviceType: "tablet", forced: false });

    // vault: the login + a system "카카오톡 세션" token, both sealed
    const creds = await h.vault.list(U);
    expect(creds.map((c) => [c.kind, c.label]).sort()).toEqual([
      ["login", "카카오톡 (ha***@kakao.com)"],
      ["token", "카카오톡 세션"],
    ]);
    expect(res.connection.credentialId).toBe(creds.find((c) => c.kind === "login")!.id);
    expect(await sessionSecret(h, U, "kakaotalk")).toMatchObject({
      access_token: "kakao-access-1",
      refresh_token: "kakao-refresh-1",
      user_id: "777",
      device_uuid: "device-uuid-1",
    });

    // nothing secret in connection rows, events or vault storage
    const blob =
      JSON.stringify([...h.storage.rows.values()]) + JSON.stringify(h.updates) + JSON.stringify([...h.vaultStorage.rows.values()]);
    expect(secretsLeaked(blob, [KAKAO_PASSWORD, KAKAO_EMAIL, "kakao-access-1", "kakao-refresh-1"])).toEqual([]);
    const meta = JSON.parse((await h.storage.getConnection(U, "kakaotalk"))!.meta!);
    expect(meta.deviceUuid).toBe("device-uuid-1");

    // device uuid persisted per user (0600) for reuse
    const devFile = JSON.parse(await readFile(join(h.dir, "messengers", U, "kakaotalk-device.json"), "utf8"));
    expect(devFile.deviceUuid).toBe("device-uuid-1");

    // access log: save + login (actor user)
    const log = await h.vault.accessLog(U);
    expect(log.some((r) => r.action === "login" && r.actor === "user" && r.outcome === "ok")).toBe(true);
    expect(h.hub.hasLiveSession(U, "kakaotalk")).toBe(true);

    // list/read/send go through the cached client
    const chats = await h.hub.listChats(U, "kakaotalk");
    expect(chats.map((c) => [c.id, c.name, c.kind])).toEqual([
      ["1001", "엄마", "dm"],
      ["1002", "가족 단톡방", "group"],
      ["1003", "회사 동기", "group"],
      ["1004", "가족 여행", "group"],
    ]);
    expect(chats[0]!.lastAt).toBe(1_731_300_000_000);
    const msgs = await h.hub.readMessages(U, "kakaotalk", "1002", 2);
    expect(msgs.map((m) => ({ senderName: m.senderName, text: m.text, at: m.at, kind: m.kind, isMe: m.isMe }))).toEqual([
      { senderName: "준호", text: "좋아요!", at: 1_731_300_060_000, kind: "text", isMe: false },
      { senderName: "민지", text: "방 1002", at: 1_731_300_120_000, kind: "text", isMe: false },
    ]);
    expect(await h.hub.send(U, "kakaotalk", "1002", "저녁 7시 어때요?")).toEqual({ ok: true, id: "log-1" });
    expect(kakao.state.clients).toHaveLength(1);
    const actions = (await h.vault.accessLog(U)).map((r) => r.action);
    expect(actions).toContain("list_chats");
    expect(actions).toContain("read_messages");
    expect(actions).toContain("send_message");
  });

  test("new device: needs_verification with a display code, background registration, then onUpdate(connected)", async () => {
    const g = gate();
    const kakao = fakeKakao({ registered: false, registerGate: g });
    h = await harness({ kakaotalk: async () => kakao.sdk });
    const credential = await sealedLogin(h, U, "kakaotalk", { email: KAKAO_EMAIL, password: KAKAO_PASSWORD });

    const res = await h.hub.connect(U, "kakaotalk", { credential });
    expect(res.connection.status).toBe("needs_verification");
    const v = res.verification as ConnectionVerification;
    expect(v.kind).toBe("display_code");
    expect(v.code).toBe("4821");
    expect(v.prompt).toContain("휴대폰 카카오톡");
    expect(v.expiresAt).toBe(h.clock.t + 180_000);
    expect((await h.storage.getConnection(U, "kakaotalk"))!.status).toBe("needs_verification");
    // the uuid is persisted before the user even confirms
    const meta = JSON.parse((await h.storage.getConnection(U, "kakaotalk"))!.meta!);
    expect(meta.deviceUuid).toBe("device-uuid-1");
    // verify() on a display_code just reports progress
    const progress = await h.hub.verify(U, "kakaotalk", "");
    expect(progress.connection.status).toBe("needs_verification");
    expect(progress.verification?.code).toBe("4821");

    const before = h.updates.length;
    g.open(); // the user typed 4821 into KakaoTalk on the phone
    await h.hub.idle();

    const last = h.updates.at(-1)!;
    expect(h.updates.length).toBeGreaterThan(before);
    expect(last.userId).toBe(U);
    expect(last.c.status).toBe("connected");
    expect(last.c.accountLabel).toBe("하늘 (ha***@kakao.com)");
    expect((await h.storage.getConnection(U, "kakaotalk"))!.status).toBe("connected");
    // same device uuid for the login before and after registration
    expect(new Set(kakao.state.loginCalls.map((c) => c.deviceUuid))).toEqual(new Set(["device-uuid-1"]));
    expect(kakao.state.generated).toBe(1);
    // background step re-opened the login through the vault (audited)
    expect((await h.vault.accessLog(U)).some((r) => r.purpose === "카카오톡 새 기기 등록 확인" && r.outcome === "ok")).toBe(true);
    expect((await h.hub.listChats(U, "kakaotalk")).length).toBe(4);
  });

  test("registration timeout → error; device uuid kept and reused on the next attempt", async () => {
    const g = gate();
    const kakao = fakeKakao({ registered: false, registerGate: g, registerError: "registration_timeout" });
    h = await harness({ kakaotalk: async () => kakao.sdk });
    const res = await h.hub.connect(U, "kakaotalk", { credential: await sealedLogin(h, U, "kakaotalk", { email: KAKAO_EMAIL, password: KAKAO_PASSWORD }) });
    expect(res.connection.status).toBe("needs_verification");
    g.open();
    await h.hub.idle();
    const conn = (await h.storage.getConnection(U, "kakaotalk"))!;
    expect(conn.status).toBe("error");
    expect(conn.lastError).toBe("기기 등록 확인 시간이 지났어요. 다시 연결해서 새 코드를 받아 주세요.");
    expect(h.updates.at(-1)!.c.status).toBe("error");

    // retry with the saved credential id: same device uuid, no new one generated
    const again = await h.hub.connect(U, "kakaotalk", { credentialId: res.connection.credentialId! });
    expect(again.connection.status).toBe("needs_verification");
    expect(kakao.state.generated).toBe(1);
    expect(new Set(kakao.state.loginCalls.map((c) => c.deviceUuid))).toEqual(new Set(["device-uuid-1"]));
  });

  test("wrong password → status error with a Korean message, no secret in it", async () => {
    const kakao = fakeKakao();
    h = await harness({ kakaotalk: async () => kakao.sdk });
    const res = await h.hub.connect(U, "kakaotalk", { credential: await sealedLogin(h, U, "kakaotalk", { email: KAKAO_EMAIL, password: "wrong-pass-123" }) });
    expect(res.connection.status).toBe("error");
    expect(res.connection.lastError).toBe("카카오계정 이메일 또는 비밀번호가 맞지 않아요.");
    expect(JSON.stringify(h.updates)).not.toContain("wrong-pass-123");
    expect(JSON.stringify(h.updates)).not.toContain(KAKAO_EMAIL);
    expect((await h.vault.list(U)).filter((c) => c.kind === "token")).toHaveLength(0);
    await expect(h.hub.listChats(U, "kakaotalk")).rejects.toMatchObject({ code: "not_connected" });
  });

  test("expired access token → refresh → BOTH tokens replaced in the vault → call retried", async () => {
    const kakao = fakeKakao();
    h = await harness({ kakaotalk: async () => kakao.sdk });
    await h.hub.connect(U, "kakaotalk", { credential: await sealedLogin(h, U, "kakaotalk", { email: KAKAO_EMAIL, password: KAKAO_PASSWORD }) });
    const credsBefore = await h.vault.list(U);

    kakao.state.valid.delete("kakao-access-1"); // server-side expiry (-950)
    const chats = await h.hub.listChats(U, "kakaotalk", { search: "단톡" });
    expect(chats.map((c) => c.name)).toEqual(["가족 단톡방"]);

    expect(kakao.state.refreshCalls).toEqual([{ accessToken: "kakao-access-1", refreshToken: "kakao-refresh-1", deviceUuid: "device-uuid-1" }]);
    expect(await sessionSecret(h, U, "kakaotalk")).toMatchObject({ access_token: "kakao-access-2", refresh_token: "kakao-refresh-2", device_uuid: "device-uuid-1" });
    // updated in place (same credential rows), old client closed, new one open
    expect((await h.vault.list(U)).map((c) => c.id).sort()).toEqual(credsBefore.map((c) => c.id).sort());
    expect(kakao.state.clients[0]!.closed).toBe(true);
    expect(kakao.state.clients.at(-1)!.token).toBe("kakao-access-2");
    expect((await h.storage.getConnection(U, "kakaotalk"))!.status).toBe("connected");
  });

  test("refresh rejected → falls back to re-login with the saved password", async () => {
    const kakao = fakeKakao();
    h = await harness({ kakaotalk: async () => kakao.sdk });
    await h.hub.connect(U, "kakaotalk", { credential: await sealedLogin(h, U, "kakaotalk", { email: KAKAO_EMAIL, password: KAKAO_PASSWORD }) });
    kakao.state.refresh = "server-rotated"; // our refresh token no longer accepted
    kakao.state.access = "kakao-access-3";
    kakao.state.valid = new Set(["kakao-access-3"]);
    expect((await h.hub.listChats(U, "kakaotalk")).length).toBe(4);
    expect((await sessionSecret(h, U, "kakaotalk")).access_token).toBe("kakao-access-3");
    expect((await h.vault.accessLog(U)).some((r) => r.actor === "system" && r.action === "login")).toBe(true);
  });

  test("lending period over → operations denied, recorded, connection marked error", async () => {
    const kakao = fakeKakao();
    h = await harness({ kakaotalk: async () => kakao.sdk });
    await h.hub.connect(U, "kakaotalk", {
      credential: await sealedLogin(h, U, "kakaotalk", { email: KAKAO_EMAIL, password: KAKAO_PASSWORD }, "login", "1h"),
    });
    h.clock.t += 2 * 3_600_000;
    await expect(h.hub.send(U, "kakaotalk", "1001", "hi")).rejects.toMatchObject({ code: "credential_expired" });
    expect(kakao.state.sent).toHaveLength(0);
    expect((await h.vault.accessLog(U, 1))[0]).toMatchObject({ action: "send_message", outcome: "denied" });
    const conn = (await h.storage.getConnection(U, "kakaotalk"))!;
    expect(conn.status).toBe("error");
    expect(conn.lastError).toContain("보관 기간");
    expect(h.hub.hasLiveSession(U, "kakaotalk")).toBe(false);
  });

  test("disconnect closes the client, removes the session token, keeps the saved login", async () => {
    const kakao = fakeKakao();
    h = await harness({ kakaotalk: async () => kakao.sdk });
    await h.hub.connect(U, "kakaotalk", { credential: await sealedLogin(h, U, "kakaotalk", { email: KAKAO_EMAIL, password: KAKAO_PASSWORD }) });
    await h.hub.disconnect(U, "kakaotalk");
    expect(kakao.state.clients[0]!.closed).toBe(true);
    expect((await h.vault.list(U)).map((c) => c.kind)).toEqual(["login"]);
    expect(await h.hub.connections(U)).toEqual([]);
    expect(h.updates.at(-1)!.c.status).toBe("disconnected");
  });

  test("idle clients are closed after idleMs", async () => {
    const kakao = fakeKakao();
    h = await harness({ kakaotalk: async () => kakao.sdk });
    // rebuild the hub with a tiny idle timeout
    await h.hub.shutdown();
    const { MessengerHub } = await import("../src/index.ts");
    h.hub = new MessengerHub({ vault: h.vault, storage: h.storage, configRoot: join(h.dir, "m2"), onUpdate: () => {}, sdk: { kakaotalk: async () => kakao.sdk }, idleMs: 20, now: () => h!.clock.t });
    await h.hub.connect(U, "kakaotalk", { credential: await sealedLogin(h, U, "kakaotalk", { email: KAKAO_EMAIL, password: KAKAO_PASSWORD }) });
    expect(h.hub.hasLiveSession(U, "kakaotalk")).toBe(true);
    await Bun.sleep(60);
    expect(h.hub.hasLiveSession(U, "kakaotalk")).toBe(false);
    expect(kakao.state.clients[0]!.closed).toBe(true);
    // next call reopens from the sealed session
    expect((await h.hub.listChats(U, "kakaotalk")).length).toBe(4);
    expect(kakao.state.clients).toHaveLength(2);
  });
});

describe("Slack", () => {
  test("connect with xoxc token + xoxd cookie; the credential itself is the session", async () => {
    slackWeb = fakeSlackWeb();
    const slack = fakeSlack(slackWeb);
    h = await harness({ slack: async () => slack.sdk });
    const credential = await sealedLogin(h, U, "slack", { token: "xoxc-111-222-abc", cookie: "d=xoxd-SECRETCOOKIE%2F" }, "token");
    const res = await h.hub.connect(U, "slack", { credential });
    expect(res.connection.status).toBe("connected");
    expect(res.connection.accountLabel).toBe("haneul · Acme");
    expect(slack.state.logins[0]).toEqual({ token: "xoxc-111-222-abc", cookie: "xoxd-SECRETCOOKIE%2F" });
    expect((await h.vault.list(U)).map((c) => c.kind)).toEqual(["token"]); // no extra session row
    const chats = await h.hub.listChats(U, "slack");
    expect(chats).toEqual([
      { id: "C1", name: "#general", kind: "channel" },
      { id: "D1", name: "김민지", kind: "dm" },
    ]);
    const msgs = await h.hub.readMessages(U, "slack", "C1", 10);
    expect(msgs.map((m) => m.text)).toEqual(["첫 번째", "두 번째"]);
    expect(msgs[1]!.senderName).toBe("김민지");
    expect(msgs.map((m) => m.isMe)).toEqual([true, false]); // U1 is the logged-in user (testAuth)
    expect(await h.hub.send(U, "slack", "C1", "안녕하세요")).toEqual({ ok: true, id: "1731300100.000300" });
    const blob = JSON.stringify([...h.storage.rows.values()]) + JSON.stringify(h.updates);
    expect(secretsLeaked(blob, ["xoxc-111-222-abc", "SECRETCOOKIE"])).toEqual([]);
  });

  test("malformed token is rejected with a Korean hint", async () => {
    const slack = fakeSlack();
    h = await harness({ slack: async () => slack.sdk });
    const res = await h.hub.connect(U, "slack", { credential: await sealedLogin(h, U, "slack", { token: "abc", cookie: "xoxd-1" }, "token") });
    expect(res.connection.status).toBe("error");
    expect(res.connection.lastError).toContain("xoxc-");
    expect(slack.state.logins).toHaveLength(0);
  });
});

describe("relay sessions (connect … { session: true })", () => {
  const SLACK_A = { token: "xoxc-relay-aaa", cookie: "xoxd-RELAYCOOKIEA" };
  const SLACK_B = { token: "xoxc-relay-bbb", cookie: "xoxd-RELAYCOOKIEB" };

  /** what a login relay does: seal the session it produced, then hand it to the hub */
  async function relaySession(hh: Harness, secret: Record<string, string>, service = "slack") {
    return hh.vault.saveSystem(U, { service, label: `${service} (relay)`, kind: "token", hint: "acme.slack.com", keepFor: "30d", secret });
  }

  type Revoke = NonNullable<ProviderAdapter["revoke"]>;
  function setRevoke(hh: Harness, provider: string, fn: Revoke | undefined) {
    const adapters = (hh.hub as unknown as { adapters: Record<string, ProviderAdapter> }).adapters;
    adapters[provider]!.revoke = fn;
  }

  async function connMeta(hh: Harness, provider: string) {
    return JSON.parse((await hh.storage.getConnection(U, provider))!.meta!) as { loginCredentialId: string | null; sessionCredentialId: string };
  }

  test("the connection owns the session: disconnect signs it out, deletes it, and it leaves 저장된 로그인", async () => {
    slackWeb = fakeSlackWeb();
    const slack = fakeSlack(slackWeb);
    h = await harness({ slack: async () => slack.sdk });
    const saved = await relaySession(h, SLACK_A);
    const res = await h.hub.connect(U, "slack", { credentialId: saved.id }, { session: true });
    expect(res.connection.status).toBe("connected");
    expect(res.connection.credentialId).toBe(saved.id);
    expect(await connMeta(h, "slack")).toMatchObject({ loginCredentialId: null, sessionCredentialId: saved.id });
    expect((await h.vault.list(U)).map((c) => c.id)).toEqual([saved.id]); // the adapter returned no token: no second row
    expect((await h.hub.listChats(U, "slack")).length).toBe(2);

    const revoked: Record<string, string>[] = [];
    setRevoke(h, "slack", async (_ctx, secret) => {
      revoked.push({ ...secret });
    });
    await h.hub.disconnect(U, "slack");
    expect(revoked).toEqual([SLACK_A]);
    expect(await h.vault.list(U)).toEqual([]);
    expect(await h.hub.connections(U)).toEqual([]);
    expect((await h.vault.accessLog(U)).some((r) => r.action === "logout" && r.outcome === "ok" && r.credentialId === saved.id)).toBe(true);
    const blob = JSON.stringify([...h.storage.rows.values()]) + JSON.stringify(h.updates) + JSON.stringify(await h.vault.accessLog(U));
    expect(secretsLeaked(blob, [SLACK_A.token, "RELAYCOOKIEA"])).toEqual([]);
  });

  test("re-login through the relay replaces the previous session row (rows never pile up)", async () => {
    const slack = fakeSlack();
    h = await harness({ slack: async () => slack.sdk });
    const a = await relaySession(h, SLACK_A);
    await h.hub.connect(U, "slack", { credentialId: a.id }, { session: true });
    const b = await relaySession(h, SLACK_B);
    const res = await h.hub.connect(U, "slack", { credentialId: b.id }, { session: true });
    expect(res.connection.status).toBe("connected");
    expect((await h.vault.list(U)).map((c) => c.id)).toEqual([b.id]);
    const c = await relaySession(h, SLACK_A);
    await h.hub.connect(U, "slack", { credentialId: c.id }, { session: true });
    expect((await h.vault.list(U)).map((x) => x.id)).toEqual([c.id]);
    expect(await sessionSecret(h, U, "slack")).toEqual(SLACK_A);
    await h.hub.disconnect(U, "slack");
    expect(await h.vault.list(U)).toEqual([]);
  });

  test("re-login signs the replaced session out once with the OLD secret; a failing sign-out never blocks the new one", async () => {
    const slack = fakeSlack();
    h = await harness({ slack: async () => slack.sdk });
    const revoked: Record<string, string>[] = [];
    setRevoke(h, "slack", async (_ctx, secret) => {
      revoked.push({ ...secret });
      throw new Error("upstream down");
    });
    const a = await relaySession(h, SLACK_A);
    await h.hub.connect(U, "slack", { credentialId: a.id }, { session: true });
    expect(revoked).toEqual([]); // nothing replaced yet
    const b = await relaySession(h, SLACK_B);
    const res = await h.hub.connect(U, "slack", { credentialId: b.id }, { session: true });
    expect(revoked).toEqual([SLACK_A]);
    expect(res.connection.status).toBe("connected");
    expect(res.connection.credentialId).toBe(b.id);
    expect((await h.vault.list(U)).map((c) => c.id)).toEqual([b.id]);
    expect((await h.vault.accessLog(U)).some((r) => r.action === "logout" && r.outcome === "error" && r.credentialId === a.id)).toBe(true);
    expect(await h.hub.send(U, "slack", "C1", "새 세션으로 보내요")).toEqual({ ok: true, id: "1731300100.000300" });
    expect(slack.state.logins.at(-1)).toEqual({ token: SLACK_B.token, cookie: SLACK_B.cookie });
  });

  test("user-saved logins are unaffected: never revoked or deleted, survive a relay login and its disconnect", async () => {
    const slack = fakeSlack();
    h = await harness({ slack: async () => slack.sdk });
    const revoked: string[] = [];
    setRevoke(h, "slack", async (_ctx, secret) => {
      revoked.push(secret.token ?? "");
    });
    const own = await sealedLogin(h, U, "slack", { token: "xoxc-own-111", cookie: "xoxd-OWN" }, "token");
    const first = await h.hub.connect(U, "slack", { credential: own });
    const userCred = first.connection.credentialId!;
    await h.hub.disconnect(U, "slack");
    expect(revoked).toEqual([]); // the user's own token is the session: not ours to sign out
    expect((await h.vault.list(U)).map((c) => c.id)).toEqual([userCred]);

    await h.hub.connect(U, "slack", { credentialId: userCred });
    const relay = await relaySession(h, SLACK_A);
    await h.hub.connect(U, "slack", { credentialId: relay.id }, { session: true });
    expect((await h.vault.list(U)).map((c) => c.id).sort()).toEqual([userCred, relay.id].sort()); // re-login kept the user's row
    await h.hub.disconnect(U, "slack");
    expect(revoked).toEqual([SLACK_A.token]);
    expect((await h.vault.list(U)).map((c) => c.id)).toEqual([userCred]);
  });

  test("an adapter that returns a token updates the adopted row instead of adding one", async () => {
    const kakao = fakeKakao();
    h = await harness({ kakaotalk: async () => kakao.sdk });
    const saved = await relaySession(h, { email: KAKAO_EMAIL, password: KAKAO_PASSWORD }, "kakaotalk");
    const res = await h.hub.connect(U, "kakaotalk", { credentialId: saved.id }, { session: true });
    expect(res.connection.status).toBe("connected");
    expect((await h.vault.list(U)).map((c) => c.id)).toEqual([saved.id]);
    const s = await sessionSecret(h, U, "kakaotalk");
    expect(s.access_token).toBeTruthy();
    expect(s.password).toBeUndefined();
    await h.hub.disconnect(U, "kakaotalk");
    expect(await h.vault.list(U)).toEqual([]);
  });

  test("sign-out is best-effort: a throwing or hanging revoke never blocks disconnect", async () => {
    const slack = fakeSlack();
    h = await harness({ slack: async () => slack.sdk });
    await h.hub.shutdown();
    const { MessengerHub } = await import("../src/index.ts");
    h.hub = new MessengerHub({ vault: h.vault, storage: h.storage, configRoot: join(h.dir, "m3"), onUpdate: () => {}, sdk: { slack: async () => slack.sdk }, revokeMs: 40, now: () => h!.clock.t });

    setRevoke(h, "slack", async () => {
      throw new Error("upstream down");
    });
    const a = await relaySession(h, SLACK_A);
    await h.hub.connect(U, "slack", { credentialId: a.id }, { session: true });
    await h.hub.disconnect(U, "slack");
    expect(await h.vault.list(U)).toEqual([]);
    expect((await h.vault.accessLog(U)).some((r) => r.action === "logout" && r.outcome === "error")).toBe(true);

    let aborted = false;
    setRevoke(h, "slack", (_ctx, _secret, _meta, signal) => {
      signal.addEventListener("abort", () => (aborted = true));
      return new Promise<void>(() => {}); // never settles
    });
    const b = await relaySession(h, SLACK_B);
    await h.hub.connect(U, "slack", { credentialId: b.id }, { session: true });
    const t0 = performance.now();
    await h.hub.disconnect(U, "slack");
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(aborted).toBe(true);
    expect(await h.vault.list(U)).toEqual([]);
    expect(await h.hub.connections(U)).toEqual([]);
  });

  test("validation: a session needs one saved token of the same service", async () => {
    const slack = fakeSlack();
    h = await harness({ slack: async () => slack.sdk });
    await expect(h.hub.connect(U, "slack", {}, { session: true })).rejects.toMatchObject({ code: "invalid_request" });
    const login = await h.vault.save(U, await sealedLogin(h, U, "slack", { token: "xoxc-1", cookie: "xoxd-1" }, "login"));
    await expect(h.hub.connect(U, "slack", { credentialId: login.id }, { session: true })).rejects.toMatchObject({ code: "credential_not_found" });
    const kakaoRow = await relaySession(h, SLACK_A, "kakaotalk");
    await expect(h.hub.connect(U, "slack", { credentialId: kakaoRow.id }, { session: true })).rejects.toMatchObject({ code: "credential_not_found" });
    // a session the adapter rejects: status error, the hub keeps no reference to it
    const bad = await relaySession(h, { token: "nope", cookie: "xoxd-1" });
    const res = await h.hub.connect(U, "slack", { credentialId: bad.id }, { session: true });
    expect(res.connection.status).toBe("error");
    expect(res.connection.credentialId).toBeNull();
  });
});

describe("other providers", () => {
  test("Instagram 2FA: enter_code → wrong code keeps waiting → right code connects", async () => {
    let twoFactorCode = "";
    const client = {
      authenticate: async () => ({ userId: "", requiresTwoFactor: true, twoFactorInfo: { two_factor_identifier: "tfid" } }),
      twoFactorLogin: async (_u: string, code: string, id: string) => {
        expect(id).toBe("tfid");
        twoFactorCode = code;
        if (code !== "123456") throw Object.assign(new Error("bad code"), { code: "two_factor_failed" });
        return { userId: "42" };
      },
      getSessionState: () => ({ cookies: "sessionid=IGSECRET", device: {} as never, user_id: "42" }),
      loadSession: async () => {},
      setSessionPath: () => {},
      listChats: async () => [],
      searchChats: async () => [],
      getMessages: async () => [],
      sendMessage: async () => ({ id: "m1", thread_id: "t", from: "me", timestamp: "0", is_outgoing: true, type: "text" }),
    };
    const ig: InstagramSdk = { createClient: () => client };
    h = await harness({ instagram: async () => ig });
    const res = await h.hub.connect(U, "instagram", { credential: await sealedLogin(h, U, "instagram", { username: "haneul", password: "ig-pw" }) });
    expect(res.connection.status).toBe("needs_verification");
    expect(res.verification).toMatchObject({ kind: "enter_code", length: 6 });
    const wrong = await h.hub.verify(U, "instagram", "000000");
    expect(wrong.connection.status).toBe("needs_verification");
    expect(wrong.connection.lastError).toContain("코드가 맞지 않아요");
    const ok = await h.hub.verify(U, "instagram", "123 456");
    expect(twoFactorCode).toBe("123456");
    expect(ok.connection.status).toBe("connected");
    expect(ok.connection.accountLabel).toBe("@haneul");
    expect((await sessionSecret(h, U, "instagram")).session).toContain("IGSECRET");
    expect(JSON.stringify([...h.storage.rows.values()])).not.toContain("IGSECRET");
  });

  test("Teams device code: display_code with URL, completes in the background, no password involved", async () => {
    const g = gate();
    const auth: TeamsAuth = { token: "skype-token", tokenExpiresAt: "", accountType: "work", region: "apac", userName: "Haneul Lee", config: '{"secret":"aad-refresh"}' };
    const teams: TeamsSdk = {
      async deviceLogin(_dir, onCode) {
        onCode({ verificationUri: "https://microsoft.com/devicelogin", verificationUriComplete: "", userCode: "ABCD-EFGH", expiresAt: 123 });
        await g.wait();
        return auth;
      },
      async refresh() {
        return auth;
      },
      createClient: () => ({
        login: async () => {},
        listChats: async () => [{ id: "19:abc", type: "group", topic: "프로젝트" }],
        getChatMessages: async () => [],
        sendChatMessage: async () => ({ id: "x" }) as never,
      }),
    };
    h = await harness({ teams: async () => teams });
    const res = await h.hub.connect(U, "teams", {});
    expect(res.connection.status).toBe("needs_verification");
    expect(res.verification).toMatchObject({ kind: "display_code", code: "ABCD-EFGH", expiresAt: 123 });
    expect(res.verification!.prompt).toContain("https://microsoft.com/devicelogin");
    g.open();
    await h.hub.idle();
    const conn = (await h.hub.connection(U, "teams"))!;
    expect(conn.status).toBe("connected");
    expect(conn.accountLabel).toBe("Haneul Lee");
    const creds = await h.vault.list(U);
    expect(creds.map((c) => c.label)).toEqual(["Microsoft Teams 세션"]);
    expect(conn.credentialId).toBe(creds[0]!.id);
    expect((await h.hub.listChats(U, "teams"))[0]!.name).toBe("프로젝트");
    await h.hub.disconnect(U, "teams");
    expect(await h.vault.list(U)).toEqual([]);
  });

  test("validation: unknown provider, missing credential, envelope for another service", async () => {
    const kakao = fakeKakao();
    h = await harness({ kakaotalk: async () => kakao.sdk });
    await expect(h.hub.connect(U, "myspace", {})).rejects.toBeInstanceOf(MessengerError);
    await expect(h.hub.connect(U, "kakaotalk", {})).rejects.toMatchObject({ code: "credential_required" });
    const slackCred = await sealedLogin(h, U, "slack", { token: "xoxc-1", cookie: "xoxd-1" }, "token");
    await expect(h.hub.connect(U, "kakaotalk", { credential: slackCred })).rejects.toMatchObject({ code: "invalid_request" });
    // an envelope sealed for another user is refused by the vault
    const other = await sealedLogin(h, "user_2", "kakaotalk", { email: KAKAO_EMAIL, password: KAKAO_PASSWORD });
    await expect(h.hub.connect(U, "kakaotalk", { credential: other })).rejects.toMatchObject({ code: "envelope_aad" });
    expect(kakao.state.loginCalls).toHaveLength(0);
  });
});

test("providers(): stable ids, Korean names, fields, SDK availability", () => {
  const list = providers();
  expect(list.map((p) => p.id)).toEqual(["kakaotalk", "slack", "slackbot", "discord", "discordbot", "telegram", "telegrambot", "line", "instagram", "teams", "webex"]);
  const kakao = list.find((p) => p.id === "kakaotalk")!;
  expect(kakao).toMatchObject({ name: "카카오톡", icon: "kakao", auth: "credentials", available: true });
  expect(kakao.fields.map((f) => f.key)).toEqual(["email", "password"]);
  const slack = list.find((p) => p.id === "slack")!;
  expect(slack.fields.map((f) => f.key)).toEqual(["token", "cookie"]);
  expect(slack.description).toContain("xoxd");
  expect(list.find((p) => p.id === "discord")!.description).toContain("이용약관");
  expect(list.find((p) => p.id === "teams")!.auth).toBe("oauth");
  // sign-in method per provider; bots go to the advanced group; nothing in the main list is a token form
  expect(Object.fromEntries(list.map((p) => [p.id, p.login]))).toEqual({
    kakaotalk: "password",
    slack: "relay_code",
    slackbot: "bot_token",
    discord: "remote_auth",
    discordbot: "bot_token",
    telegram: "phone_code",
    telegrambot: "bot_token",
    line: "password",
    instagram: "password",
    teams: "device_code",
    webex: "password",
  });
  expect(list.filter((p) => p.advanced).map((p) => p.id)).toEqual(["slackbot", "discordbot", "telegrambot"]);
  expect(list.filter((p) => !p.advanced).every((p) => p.login !== "bot_token")).toBe(true);
  for (const p of list) {
    // telegram (user) waits for the operator's api_id/api_hash: "준비 중" until configured
    if (p.id === "telegram" && !process.env.AGENT_TELEGRAM_API_ID) {
      expect(p).toMatchObject({ available: false, unavailableReason: "준비 중이에요" });
      continue;
    }
    expect(p.available).toBe(true);
    expect(p.name.length).toBeGreaterThan(0);
  }
});
