import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm, stat, readFile } from "node:fs/promises";
import { createCipheriv, createECDH, createHash, hkdfSync, randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Enclave, enclaveMeasurement, VaultError, type VaultErrorCode } from "../src/index.ts";
import { sealForEnclave } from "../src/client.ts";
import { b64urlDecode, b64urlEncode } from "../src/encoding.ts";

let dir: string;
const masterKey = crypto.getRandomValues(new Uint8Array(32));
let enclave: Enclave;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "pickle-enclave-"));
  enclave = await Enclave.load({ dir, masterKey });
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

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

describe("Enclave", () => {
  test("info() exposes kid, public key, alg and measurement", () => {
    const info = enclave.info();
    expect(info.alg).toBe("ECDH-P256+HKDF-SHA256+A256GCM");
    expect(info.kid).toMatch(/^[0-9a-f]{16}$/);
    expect(info.publicKey.kty).toBe("EC");
    expect(info.publicKey.crv).toBe("P-256");
    expect((info.publicKey as { d?: string }).d).toBeUndefined();
    expect(info.measurement).toMatch(/^[0-9a-f]{64}$/);
    expect(info.measurement).toBe(enclaveMeasurement());
  });

  test("kid is the first 16 hex of sha256(canonical public JWK)", () => {
    const { publicKey, kid } = enclave.info();
    const canon = JSON.stringify({ crv: publicKey.crv, kty: publicKey.kty, x: publicKey.x, y: publicKey.y });
    expect(createHash("sha256").update(canon).digest("hex").slice(0, 16)).toBe(kid);
  });

  test("measurement is reproducible from the source files on disk", async () => {
    const h = createHash("sha256");
    for (const name of ["enclave.ts", "aead.ts", "encoding.ts", "errors.ts"]) {
      const src = await readFile(join(import.meta.dir, "../src", name));
      h.update(`${name}\0${src.byteLength}\0`);
      h.update(src);
    }
    expect(h.digest("hex")).toBe(enclaveMeasurement());
  });

  test("device seal → enclave open round-trip (Korean + emoji)", async () => {
    const secret = { username: "하늘@카카오.com", password: "비밀번호🔒 p@ss \"quoted\" \\ back" };
    const env = await sealForEnclave(enclave.info(), secret, "u1:kakaotalk:login");
    expect(env.v).toBe(1);
    expect(env.kid).toBe(enclave.info().kid);
    expect(JSON.stringify(env)).not.toContain("비밀번호");
    expect(JSON.stringify(env)).not.toContain("p@ss");
    expect((env.epk as { d?: string }).d).toBeUndefined();
    expect(await enclave.openEnvelope(env, "u1:kakaotalk:login")).toEqual(secret);
  });

  test("interoperates with an independent node:crypto implementation of the protocol algorithm", async () => {
    // Seal exactly as documented on protocol EnclaveEnvelope, without WebCrypto or our helpers.
    const info = enclave.info();
    const eph = createECDH("prime256v1");
    eph.generateKeys();
    const enclavePub = Buffer.concat([Buffer.from([4]), Buffer.from(info.publicKey.x!, "base64url"), Buffer.from(info.publicKey.y!, "base64url")]);
    const shared = eph.computeSecret(enclavePub);
    const key = Buffer.from(hkdfSync("sha256", shared, Buffer.from(info.kid, "utf8"), Buffer.from("pickle-enclave/v1", "utf8"), 32));
    const iv = randomBytes(12);
    const aad = "u1:webex:login";
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from(aad, "utf8"));
    const ct = Buffer.concat([cipher.update(JSON.stringify({ email: "a@b.c", password: "독립구현✓" }), "utf8"), cipher.final(), cipher.getAuthTag()]);
    const pub = eph.getPublicKey();
    const env = {
      v: 1 as const,
      alg: "ECDH-P256+HKDF-SHA256+A256GCM" as const,
      kid: info.kid,
      epk: { kty: "EC", crv: "P-256", x: pub.subarray(1, 33).toString("base64url"), y: pub.subarray(33, 65).toString("base64url") },
      iv: iv.toString("base64url"),
      ct: ct.toString("base64url"),
      aad,
    };
    expect(await enclave.openEnvelope(env, aad)).toEqual({ email: "a@b.c", password: "독립구현✓" });
  });

  test("each envelope uses a fresh ephemeral key and iv", async () => {
    const a = await sealForEnclave(enclave.info(), { p: "x" }, "a");
    const b = await sealForEnclave(enclave.info(), { p: "x" }, "a");
    expect(a.epk.x).not.toBe(b.epk.x);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ct).not.toBe(b.ct);
  });

  test("rejects wrong expected aad (and a forged aad field)", async () => {
    const env = await sealForEnclave(enclave.info(), { p: "x" }, "u1:slack:token");
    await expectCode(enclave.openEnvelope(env, "u2:slack:token"), "envelope_aad");
    // attacker rewrites env.aad to match: GCM authentication must fail
    await expectCode(enclave.openEnvelope({ ...env, aad: "u2:slack:token" }, "u2:slack:token"), "envelope_decrypt");
  });

  test("rejects wrong kid, version and alg", async () => {
    const env = await sealForEnclave(enclave.info(), { p: "x" }, "a");
    await expectCode(enclave.openEnvelope({ ...env, kid: "0000000000000000" }, "a"), "envelope_kid");
    await expectCode(enclave.openEnvelope({ ...env, v: 2 as unknown as 1 }, "a"), "envelope_version");
    await expectCode(
      enclave.openEnvelope({ ...env, alg: "RSA" as unknown as "ECDH-P256+HKDF-SHA256+A256GCM" }, "a"),
      "envelope_alg",
    );
  });

  test("rejects tampered ciphertext, iv and epk", async () => {
    const env = await sealForEnclave(enclave.info(), { p: "tamper-me" }, "a");
    const ct = b64urlDecode(env.ct);
    ct[0]! ^= 0x01;
    await expectCode(enclave.openEnvelope({ ...env, ct: b64urlEncode(ct) }, "a"), "envelope_decrypt");
    const iv = b64urlDecode(env.iv);
    iv[3]! ^= 0x80;
    await expectCode(enclave.openEnvelope({ ...env, iv: b64urlEncode(iv) }, "a"), "envelope_decrypt");
    const other = await sealForEnclave(enclave.info(), { p: "other" }, "a");
    await expectCode(enclave.openEnvelope({ ...env, epk: other.epk }, "a"), "envelope_decrypt");
    await expectCode(enclave.openEnvelope({ ...env, ct: "not base64!!" }, "a"), "envelope_invalid");
  });

  test("an envelope sealed for another enclave cannot be opened", async () => {
    const otherDir = await mkdtemp(join(tmpdir(), "pickle-enclave-b-"));
    try {
      const other = await Enclave.load({ dir: otherDir, masterKey });
      const env = await sealForEnclave(other.info(), { p: "x" }, "a");
      await expectCode(enclave.openEnvelope(env, "a"), "envelope_kid");
      // even if the kid is forged, the ECDH secret differs
      await expectCode(enclave.openEnvelope({ ...env, kid: enclave.info().kid }, "a"), "envelope_decrypt");
    } finally {
      await rm(otherDir, { recursive: true, force: true });
    }
  });

  test("key persists across reloads; file is 0600 and holds no plaintext private key", async () => {
    const env = await sealForEnclave(enclave.info(), { token: "xoxc-123" }, "u:slack:token");
    const reloaded = await Enclave.load({ dir, masterKey });
    expect(reloaded.info().kid).toBe(enclave.info().kid);
    expect(reloaded.info().createdAt).toBe(enclave.info().createdAt);
    expect(await reloaded.openEnvelope(env, "u:slack:token")).toEqual({ token: "xoxc-123" });

    const path = join(dir, "enclave-key.json");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    const file = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    expect(file.kid).toBe(enclave.info().kid);
    expect(JSON.stringify(file)).not.toContain('"d"');
  });

  test("a wrong master key cannot unseal the enclave key", async () => {
    const wrong = crypto.getRandomValues(new Uint8Array(32));
    await expectCode(Enclave.load({ dir, masterKey: wrong }), "enclave_key_invalid");
    await expectCode(Enclave.load({ dir, masterKey: new Uint8Array(16) }), "master_key_invalid");
  });
});
