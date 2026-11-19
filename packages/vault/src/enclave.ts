/**
 * Credential Enclave — the only server code that turns a device-sealed envelope back into
 * plaintext.
 *
 * - An ECDH P-256 key pair is created once and persisted at `<dir>/enclave-key.json` (0600).
 *   The private JWK is never stored in the clear: it is sealed with the server master key
 *   (AES-256-GCM, aad "enclave-key"). In memory it lives as a non-extractable CryptoKey.
 * - Devices fetch `info()` (kid + public key), seal credentials with `sealForEnclave()`
 *   (`@pickle/vault/client`) and send only the envelope. Plaintext never crosses the wire.
 * - `measurement` = sha256 of this module's source and of every local module it imports
 *   (read at runtime from disk). Publishing it lets anyone check exactly which code opens
 *   secrets ("누구나 검증 가능"): hash the same files from the published source and compare.
 */
import { link, mkdir, readFile, unlink, writeFile, chmod } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { EnclaveEnvelope, EnclaveInfo } from "@pickle/protocol";
import { importAesKey, openWith, sealWith } from "./aead";
import { b64urlDecode, bytes, canonicalJwk, fromUtf8, parseSecret, publicEcJwk, utf8, wipe } from "./encoding";
import { VaultError } from "./errors";

export const ENCLAVE_ALG = "ECDH-P256+HKDF-SHA256+A256GCM" as const;
export const ENCLAVE_HKDF_INFO = "pickle-enclave/v1";
const KEY_FILE = "enclave-key.json";
const KEY_AAD = "enclave-key";
const MAX_CT_B64 = 64 * 1024;

const subtle = globalThis.crypto.subtle;

/** Files hashed into the measurement: this module plus the local modules it imports. */
const MEASURED_FILES = ["enclave.ts", "aead.ts", "encoding.ts", "errors.ts"] as const;
let cachedMeasurement: string | null = null;

/**
 * sha256 (hex) over the enclave source files, read from disk at runtime:
 * for each file in order, `name \0 byteLength \0 contents`.
 */
export function enclaveMeasurement(): string {
  if (cachedMeasurement) return cachedMeasurement;
  const h = createHash("sha256");
  for (const name of MEASURED_FILES) {
    const src = readFileSync(fileURLToPath(new URL(`./${name}`, import.meta.url)));
    h.update(`${name}\0${src.byteLength}\0`);
    h.update(src);
  }
  cachedMeasurement = h.digest("hex");
  return cachedMeasurement;
}

/** First 16 hex chars of sha256(canonical public JWK). */
export function enclaveKid(publicJwk: JsonWebKey): string {
  return createHash("sha256").update(canonicalJwk(publicJwk)).digest("hex").slice(0, 16);
}

interface EnclaveKeyFile {
  v: 1;
  alg: typeof ENCLAVE_ALG;
  kid: string;
  publicKey: JsonWebKey;
  createdAt: number;
  /** AES-256-GCM(masterKey, privateJwkJson, aad "enclave-key") — see aead.ts for the format */
  sealedPrivateKey: string;
}

export class Enclave {
  private constructor(
    private readonly privateKey: CryptoKey,
    private readonly publicJwk: JsonWebKey,
    private readonly kid: string,
    private readonly createdAt: number,
  ) {}

  static async load(opts: { dir: string; masterKey: Uint8Array }): Promise<Enclave> {
    if (!(opts.masterKey instanceof Uint8Array) || opts.masterKey.byteLength !== 32) {
      throw new VaultError("master_key_invalid", "master key must be 32 bytes");
    }
    const wrapKey = await importAesKey(opts.masterKey);
    const path = join(opts.dir, KEY_FILE);
    const existing = await readKeyFile(path);
    if (existing) return Enclave.fromFile(existing, wrapKey);

    await mkdir(opts.dir, { recursive: true, mode: 0o700 });
    const pair = (await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
    const publicKey = publicEcJwk(await subtle.exportKey("jwk", pair.publicKey));
    const privJson = utf8(JSON.stringify(await subtle.exportKey("jwk", pair.privateKey)));
    let sealedPrivateKey: string;
    try {
      sealedPrivateKey = await sealWith(wrapKey, privJson, KEY_AAD);
    } finally {
      wipe(privJson);
    }
    const file: EnclaveKeyFile = {
      v: 1,
      alg: ENCLAVE_ALG,
      kid: enclaveKid(publicKey),
      publicKey,
      createdAt: Date.now(),
      sealedPrivateKey,
    };
    // Atomic create-if-absent: write a temp file, then hard-link it into place (fails if
    // another process won the race, in which case we load theirs).
    const tmp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
    await writeFile(tmp, JSON.stringify(file, null, 2), { mode: 0o600 });
    try {
      await link(tmp, path);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    } finally {
      await unlink(tmp).catch(() => {});
    }
    await chmod(path, 0o600).catch(() => {});
    const persisted = await readKeyFile(path);
    if (!persisted) throw new VaultError("enclave_key_invalid", "enclave key file missing after create");
    return Enclave.fromFile(persisted, wrapKey);
  }

  private static async fromFile(file: EnclaveKeyFile, wrapKey: CryptoKey): Promise<Enclave> {
    if (file.v !== 1 || file.alg !== ENCLAVE_ALG) throw new VaultError("enclave_key_invalid", "unsupported enclave key file");
    const publicKey = publicEcJwk(file.publicKey);
    if (enclaveKid(publicKey) !== file.kid) throw new VaultError("enclave_key_invalid", "enclave key id mismatch");
    let privBytes: Uint8Array | null = null;
    try {
      privBytes = await openWith(wrapKey, file.sealedPrivateKey, KEY_AAD);
    } catch {
      throw new VaultError("enclave_key_invalid", "cannot unseal enclave key (wrong master key?)");
    }
    try {
      const jwk = JSON.parse(fromUtf8(privBytes)) as JsonWebKey;
      if (jwk.x !== publicKey.x || jwk.y !== publicKey.y || typeof jwk.d !== "string") {
        throw new VaultError("enclave_key_invalid", "enclave private key does not match public key");
      }
      const privateKey = await subtle.importKey(
        "jwk",
        { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y, d: jwk.d },
        { name: "ECDH", namedCurve: "P-256" },
        false,
        ["deriveBits"],
      );
      return new Enclave(privateKey, publicKey, file.kid, file.createdAt);
    } finally {
      wipe(privBytes);
    }
  }

  info(): EnclaveInfo {
    return {
      kid: this.kid,
      publicKey: { ...this.publicJwk },
      alg: ENCLAVE_ALG,
      measurement: enclaveMeasurement(),
      createdAt: this.createdAt,
    };
  }

  /**
   * Opens a device-sealed envelope (algorithm documented on protocol `EnclaveEnvelope`):
   * shared = ECDH(enclave.private, epk) → key = HKDF-SHA256(shared, salt=utf8(kid),
   * info=utf8("pickle-enclave/v1"), 32 bytes) → AES-256-GCM decrypt with additionalData=utf8(aad).
   * Rejects a wrong version/alg/kid, an aad different from `expectedAad`, and any tampering.
   */
  async openEnvelope(env: EnclaveEnvelope, expectedAad: string): Promise<Record<string, string>> {
    if (!env || typeof env !== "object") throw new VaultError("envelope_invalid", "envelope is malformed");
    if (env.v !== 1) throw new VaultError("envelope_version", "unsupported envelope version");
    if (env.alg !== ENCLAVE_ALG) throw new VaultError("envelope_alg", "unsupported envelope algorithm");
    if (env.kid !== this.kid) throw new VaultError("envelope_kid", "envelope was sealed for a different enclave key");
    if (typeof env.aad !== "string" || env.aad !== expectedAad) {
      throw new VaultError("envelope_aad", "envelope is bound to a different user/service");
    }
    if (typeof env.iv !== "string" || typeof env.ct !== "string" || env.ct.length > MAX_CT_B64) {
      throw new VaultError("envelope_invalid", "envelope is malformed");
    }
    let epk: CryptoKey;
    let iv: Uint8Array<ArrayBuffer>;
    let ct: Uint8Array<ArrayBuffer>;
    try {
      epk = await subtle.importKey("jwk", publicEcJwk(env.epk), { name: "ECDH", namedCurve: "P-256" }, false, []);
      iv = b64urlDecode(env.iv);
      ct = b64urlDecode(env.ct);
    } catch {
      throw new VaultError("envelope_invalid", "envelope is malformed");
    }
    if (iv.byteLength !== 12 || ct.byteLength < 16) throw new VaultError("envelope_invalid", "envelope is malformed");

    let shared: Uint8Array | null = null;
    let pt: Uint8Array | null = null;
    try {
      shared = new Uint8Array(await subtle.deriveBits({ name: "ECDH", public: epk }, this.privateKey, 256));
      const ikm = await subtle.importKey("raw", bytes(shared), "HKDF", false, ["deriveKey"]);
      const aesKey = await subtle.deriveKey(
        { name: "HKDF", hash: "SHA-256", salt: utf8(this.kid), info: utf8(ENCLAVE_HKDF_INFO) },
        ikm,
        { name: "AES-GCM", length: 256 },
        false,
        ["decrypt"],
      );
      try {
        pt = new Uint8Array(await subtle.decrypt({ name: "AES-GCM", iv, additionalData: utf8(env.aad) }, aesKey, ct));
      } catch {
        throw new VaultError("envelope_decrypt", "envelope failed authentication");
      }
      try {
        return parseSecret(fromUtf8(pt));
      } catch {
        throw new VaultError("envelope_invalid", "envelope plaintext is not a credential object");
      }
    } catch (e) {
      if (e instanceof VaultError) throw e;
      throw new VaultError("envelope_invalid", "envelope could not be opened");
    } finally {
      wipe(shared);
      wipe(pt);
    }
  }
}

async function readKeyFile(path: string): Promise<EnclaveKeyFile | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
  try {
    return JSON.parse(raw) as EnclaveKeyFile;
  } catch {
    throw new VaultError("enclave_key_invalid", "enclave key file is corrupt");
  }
}

