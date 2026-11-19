import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SaveCredentialRequest } from "@pickle/protocol";
import { Enclave, keepForToExpiry, MemoryVaultStorage, Vault, VaultError, type VaultErrorCode } from "../src/index.ts";
import { sealForEnclave } from "../src/client.ts";

let dir: string;
let enclave: Enclave;
const masterKey = crypto.getRandomValues(new Uint8Array(32));
const names: Record<string, string> = { kakaotalk: "카카오톡", slack: "슬랙" };
const serviceName = (id: string) => names[id] ?? id;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "pickle-vault-"));
  enclave = await Enclave.load({ dir, masterKey });
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

function makeVault(storage = new MemoryVaultStorage(), clock = { t: Date.now() }) {
  const vault = new Vault({ enclave, masterKey, storage, serviceName, now: () => clock.t });
  return { vault, storage, clock };
}

async function loginReq(
  userId: string,
  over: Partial<SaveCredentialRequest> = {},
  secret: Record<string, string> = { email: "haneul@kakao.com", password: "hunter2-비번" },
): Promise<SaveCredentialRequest> {
  const service = over.service ?? "kakaotalk";
  const kind = over.kind ?? "login";
  return {
    service,
    label: "카카오톡 (ha***@kakao.com)",
    kind,
    hint: "ha***@kakao.com",
    keepFor: "7d",
    envelope: await sealForEnclave(enclave.info(), secret, `${userId}:${service}:${kind}`),
    ...over,
  };
}

async function expectCode(p: Promise<unknown>, code: VaultErrorCode) {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(VaultError);
    expect((e as VaultError).code).toBe(code);
    return;
  }
  throw new Error(`expected rejection with ${code}`);
}

describe("keepForToExpiry", () => {
  test("maps lending periods", () => {
    const now = 1_000;
    expect(keepForToExpiry("1h", now)).toBe(now + 3_600_000);
    expect(keepForToExpiry("1d", now)).toBe(now + 86_400_000);
    expect(keepForToExpiry("7d", now)).toBe(now + 7 * 86_400_000);
    expect(keepForToExpiry("30d", now)).toBe(now + 30 * 86_400_000);
    expect(keepForToExpiry("forever", now)).toBeNull();
  });
});

describe("Vault", () => {
  test("save + list never expose the secret", async () => {
    const { vault, storage, clock } = makeVault();
    const info = await vault.save("u1", await loginReq("u1"));
    expect(info.serviceName).toBe("카카오톡");
    expect(info.expiresAt).toBe(clock.t + 7 * 86_400_000);
    expect(info.expired).toBe(false);
    expect(info.useCount).toBe(0);
    const list = await vault.list("u1");
    expect(list).toHaveLength(1);
    const dump = JSON.stringify(list) + JSON.stringify([...storage.rows.values()]) + JSON.stringify([...storage.userKeys]);
    expect(dump).not.toContain("hunter2");
    expect(dump).not.toContain("haneul@kakao.com");
    expect(Object.keys(list[0]!)).not.toContain("sealed");
    expect(await vault.list("u2")).toHaveLength(0);
    // saving was recorded
    const log = await vault.accessLog("u1");
    expect(log[0]!.action).toBe("save");
  });

  test("save rejects envelopes bound to another user/service/kind and bad metadata", async () => {
    const { vault } = makeVault();
    const forOther = await loginReq("u2");
    await expectCode(vault.save("u1", forOther), "envelope_aad");
    const wrongKind = { ...(await loginReq("u1")), kind: "token" as const };
    await expectCode(vault.save("u1", wrongKind), "envelope_aad");
    await expectCode(vault.save("u1", await loginReq("u1", { hint: "x".repeat(65) })), "invalid_request");
    await expectCode(vault.save("u1", await loginReq("u1", { label: "x".repeat(81) })), "invalid_request");
    await expectCode(vault.save("u1", await loginReq("u1", { service: "Kakao Talk" })), "invalid_request");
    await expectCode(vault.save("u1", await loginReq("u1", { keepFor: "2d" as never })), "invalid_request");
  });

  test("use() decrypts, records an access and bumps useCount", async () => {
    const { vault, clock } = makeVault();
    const info = await vault.save("u1", await loginReq("u1"));
    clock.t += 1000;
    const access = vault.access("u1", { actor: "agent", deviceVerified: true });
    const found = await access.find("kakaotalk");
    expect(found).toEqual({ id: info.id, hint: "ha***@kakao.com" });
    let seen: Record<string, string> | null = null;
    const out = await access.use(info.id, { action: "login", purpose: "카카오톡 로그인" }, async (s) => {
      seen = { ...s };
      return 42;
    });
    expect(out).toBe(42);
    expect(seen!).toEqual({ email: "haneul@kakao.com", password: "hunter2-비번" });
    const [after] = await vault.list("u1");
    expect(after!.useCount).toBe(1);
    expect(after!.lastUsedAt).toBe(clock.t);
    const [rec] = await vault.accessLog("u1", 1);
    expect(rec).toMatchObject({
      credentialId: info.id,
      service: "kakaotalk",
      serviceName: "카카오톡",
      action: "login",
      purpose: "카카오톡 로그인",
      actor: "agent",
      outcome: "ok",
      deviceVerified: true,
    });
    expect(JSON.stringify(await vault.accessLog("u1"))).not.toContain("hunter2");
  });

  test("the secret object handed to use() is scrubbed afterwards", async () => {
    const { vault } = makeVault();
    const info = await vault.save("u1", await loginReq("u1"));
    let ref: Record<string, string> = {};
    await vault.access("u1").use(info.id, { action: "view", purpose: "t" }, async (s) => {
      ref = s;
    });
    expect(Object.keys(ref)).toHaveLength(0);
  });

  test("expired credentials are denied and the denial is recorded", async () => {
    const { vault, clock } = makeVault();
    const info = await vault.save("u1", await loginReq("u1", { keepFor: "1h" }));
    clock.t += 3_600_000;
    const access = vault.access("u1", { actor: "agent" });
    expect(await access.find("kakaotalk")).toBeNull();
    let called = false;
    await expectCode(
      access.use(info.id, { action: "login", purpose: "만료 테스트" }, async () => {
        called = true;
      }),
      "credential_expired",
    );
    expect(called).toBe(false);
    const [rec] = await vault.accessLog("u1", 1);
    expect(rec).toMatchObject({ credentialId: info.id, outcome: "denied", action: "login" });
    expect((await vault.list("u1"))[0]!.expired).toBe(true);
    expect((await vault.list("u1"))[0]!.useCount).toBe(0);
  });

  test("fn errors are recorded as outcome error and rethrown", async () => {
    const { vault } = makeVault();
    const info = await vault.save("u1", await loginReq("u1"));
    await expect(
      vault.access("u1").use(info.id, { action: "login", purpose: "x" }, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    const [rec] = await vault.accessLog("u1", 1);
    expect(rec!.outcome).toBe("error");
  });

  test("per-user DEKs: user B cannot open user A's row, even with shared storage", async () => {
    const { vault, storage } = makeVault();
    const info = await vault.save("userA", await loginReq("userA"));
    expect(storage.userKeys.size).toBe(1);
    // B can't see it through its scoped access
    await expectCode(vault.access("userB").use(info.id, { action: "x", purpose: "x" }, async () => 1), "credential_not_found");
    // copy A's row under B's id (as if storage were compromised / mis-scoped): B's DEK + aad fail
    const row = storage.rows.get(info.id)!;
    await storage.insertCredential({ ...row, id: "stolen", userId: "userB" });
    await expectCode(
      vault.access("userB").use("stolen", { action: "x", purpose: "x" }, async () => 1),
      "decrypt_failed",
    );
    expect(storage.userKeys.size).toBe(2);
    expect(storage.userKeys.get("userA")).not.toBe(storage.userKeys.get("userB"));
    // a different vault instance (fresh caches) over the same storage still opens A's row
    const again = new Vault({ enclave, masterKey, storage, serviceName });
    const got = await again.access("userA").use(info.id, { action: "x", purpose: "x" }, async (s) => s.email);
    expect(got).toBe("haneul@kakao.com");
    // a vault with another master key cannot unwrap A's DEK
    const foreign = new Vault({ enclave, masterKey: crypto.getRandomValues(new Uint8Array(32)), storage, serviceName });
    await expectCode(foreign.access("userA").use(info.id, { action: "x", purpose: "x" }, async () => 1), "decrypt_failed");
  });

  test("concurrent first saves share one DEK", async () => {
    const { vault, storage } = makeVault();
    const reqs = await Promise.all([1, 2, 3].map(() => loginReq("u9")));
    const infos = await Promise.all(reqs.map((r) => vault.save("u9", r)));
    expect(storage.userKeys.size).toBe(1);
    const fresh = new Vault({ enclave, masterKey, storage, serviceName });
    for (const i of infos) {
      expect(await fresh.access("u9").use(i.id, { action: "x", purpose: "x" }, async (s) => s.password)).toBe("hunter2-비번");
    }
  });

  test("saveSystem + update replace the sealed secret atomically", async () => {
    const { vault } = makeVault();
    const info = await vault.saveSystem("u1", {
      service: "kakaotalk",
      label: "카카오톡 세션",
      kind: "token",
      hint: "ha***@kakao.com",
      keepFor: "30d",
      secret: { access_token: "a1", refresh_token: "r1" },
    });
    await vault.update("u1", info.id, { access_token: "a2", refresh_token: "r2" });
    const s = await vault.access("u1", { actor: "system" }).use(info.id, { action: "login", purpose: "x" }, async (x) => ({ ...x }));
    expect(s).toEqual({ access_token: "a2", refresh_token: "r2" });
    await expectCode(vault.update("u2", info.id, { a: "b" }), "credential_not_found");
  });

  test("find prefers user-saved logins over system tokens of the same service", async () => {
    const { vault, clock } = makeVault();
    const login = await vault.save("u1", await loginReq("u1"));
    clock.t += 10;
    await vault.saveSystem("u1", { service: "kakaotalk", label: "카카오톡 세션", kind: "token", hint: "", keepFor: "30d", secret: { t: "x" } });
    expect((await vault.access("u1").find("kakaotalk"))!.id).toBe(login.id);
  });

  test("renew extends the lending period; remove deletes", async () => {
    const { vault, clock } = makeVault();
    const info = await vault.save("u1", await loginReq("u1", { keepFor: "1h" }));
    clock.t += 3_600_000;
    expect((await vault.list("u1"))[0]!.expired).toBe(true);
    const renewed = await vault.renew("u1", info.id, "1d");
    expect(renewed.expired).toBe(false);
    expect(renewed.keepFor).toBe("1d");
    expect(renewed.expiresAt).toBe(clock.t + 86_400_000);
    expect(await vault.access("u1").use(info.id, { action: "x", purpose: "x" }, async () => "ok")).toBe("ok");
    const forever = await vault.renew("u1", info.id, "forever");
    expect(forever.expiresAt).toBeNull();
    await expectCode(vault.renew("u2", info.id, "1d"), "credential_not_found");
    expect(await vault.remove("u2", info.id)).toBe(false);
    expect(await vault.remove("u1", info.id)).toBe(true);
    expect(await vault.list("u1")).toHaveLength(0);
    expect(await vault.remove("u1", info.id)).toBe(false);
  });
});
