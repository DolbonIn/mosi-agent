import { test, expect, beforeAll } from "bun:test";
import { randomBytes } from "node:crypto";
import { seal, open, type SealedSecret } from "../src/index.ts";

beforeAll(() => {
  process.env.VAULT_MASTER_KEY = randomBytes(32).toString("base64");
});

test("round-trips a unicode secret", () => {
  const secret = "hunter2!@# 한글-비밀 🔒";
  expect(open(seal(secret))).toBe(secret);
});

test("ciphertext does not leak the plaintext", () => {
  const sealed = seal("super-secret-oauth-token");
  expect(Buffer.from(sealed.ct, "base64").toString("utf8")).not.toContain("super-secret");
});

test("each seal uses a fresh IV and differing ciphertext", () => {
  const a = seal("same-input");
  const b = seal("same-input");
  expect(a.iv).not.toBe(b.iv);
  expect(a.ct).not.toBe(b.ct);
});

test("tampered ciphertext is rejected (GCM auth fails)", () => {
  const sealed = seal("tamper-me");
  const ctBytes = Buffer.from(sealed.ct, "base64");
  ctBytes[0] ^= 0xff;
  const bad: SealedSecret = { ...sealed, ct: ctBytes.toString("base64") };
  expect(() => open(bad)).toThrow();
});

test("wrong AAD is rejected", () => {
  const sealed = seal("bound-secret", "user:42:slack");
  const bad: SealedSecret = { ...sealed, aad: "user:99:slack" };
  expect(() => open(bad)).toThrow();
});

test("missing master key throws a clear error", () => {
  const saved = process.env.VAULT_MASTER_KEY;
  delete process.env.VAULT_MASTER_KEY;
  try {
    expect(() => seal("x")).toThrow(/VAULT_MASTER_KEY/);
  } finally {
    process.env.VAULT_MASTER_KEY = saved;
  }
});
