import { test, expect, describe } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getOrCreateDeviceKey, maskHint, signApproval } from "../src/client.ts";
import { verifyApproval } from "../src/index.ts";
import { b64urlDecode, b64urlEncode } from "../src/encoding.ts";

describe("device key + approvals", () => {
  test("device key is stable within a session and its private half is not exposed", async () => {
    const a = await getOrCreateDeviceKey();
    const b = await getOrCreateDeviceKey();
    expect(a.id).toBe(b.id);
    expect(b64urlDecode(a.id).byteLength).toBe(16);
    expect(a.publicJwk).toEqual(b.publicJwk);
    expect(a.publicJwk.kty).toBe("EC");
    expect((a.publicJwk as { d?: string }).d).toBeUndefined();
  });

  test("signApproval → verifyApproval true; wrong id/nonce/key/tamper false", async () => {
    const key = await getOrCreateDeviceKey();
    const { signature, deviceId } = await signApproval("appr_1", "nonce-abc");
    expect(deviceId).toBe(key.id);
    expect(b64urlDecode(signature).byteLength).toBe(64); // IEEE P1363 r||s
    expect(await verifyApproval(key.publicJwk, "appr_1", "nonce-abc", signature)).toBe(true);
    expect(await verifyApproval(key.publicJwk, "appr_2", "nonce-abc", signature)).toBe(false);
    expect(await verifyApproval(key.publicJwk, "appr_1", "nonce-xyz", signature)).toBe(false);
    const sig = b64urlDecode(signature);
    sig[10]! ^= 0x01;
    expect(await verifyApproval(key.publicJwk, "appr_1", "nonce-abc", b64urlEncode(sig))).toBe(false);
    const other = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
    const otherJwk = await crypto.subtle.exportKey("jwk", other.publicKey);
    expect(await verifyApproval(otherJwk, "appr_1", "nonce-abc", signature)).toBe(false);
    expect(await verifyApproval(key.publicJwk, "appr_1", "nonce-abc", "!!!")).toBe(false);
    expect(await verifyApproval({ kty: "RSA" }, "appr_1", "nonce-abc", signature)).toBe(false);
  });

  test("verifyApproval accepts signatures from an independent WebCrypto signer", async () => {
    const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"])) as CryptoKeyPair;
    const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
    const sig = new Uint8Array(
      await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, new TextEncoder().encode("approve:a:n")),
    );
    expect(await verifyApproval(jwk, "a", "n", b64urlEncode(sig))).toBe(true);
  });
});

describe("maskHint", () => {
  test("emails", () => {
    expect(maskHint("login", "haneul@gmail.com")).toBe("ha***@gmail.com");
    expect(maskHint("login", "ab@x.io")).toBe("a***@x.io");
    expect(maskHint("login", "  kim.minji@kakao.com ")).toBe("ki***@kakao.com");
  });
  test("phones", () => {
    expect(maskHint("login", "010-1234-5678")).toBe("010-****-5678");
    expect(maskHint("login", "01012345678")).toBe("010-****-5678");
    expect(maskHint("login", "+82 10 1234 5678")).toBe("010-****-5678");
    expect(maskHint("login", "02-123-4567")).toBe("***-4567");
  });
  test("cards", () => {
    expect(maskHint("card", "1234 5678 9012 3456")).toBe("•••• 3456");
    expect(maskHint("card", "4111-1111-1111-1234")).toBe("•••• 1234");
  });
  test("generic", () => {
    expect(maskHint("login", "haneul_k")).toBe("ha***");
    expect(maskHint("token", "xoxc-1234567890")).toBe("xo***");
    expect(maskHint("login", "한글아이디")).toBe("한글***");
    expect(maskHint("login", "")).toBe("");
  });
});

test("client.ts stays browser-only (no node: imports, no Buffer)", async () => {
  for (const f of ["client.ts", "encoding.ts"]) {
    const src = await readFile(join(import.meta.dir, "../src", f), "utf8");
    expect(/(from|import)\s*\(?\s*["']node:/.test(src)).toBe(false);
    expect(/\bBuffer\s*[.(]/.test(src)).toBe(false);
  }
});
