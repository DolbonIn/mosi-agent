/**
 * AES-256-GCM helpers (WebCrypto) used by the enclave (sealing its private key) and the vault
 * (wrapping per-user DEKs and sealing credential secrets).
 *
 * Sealed string format: `v1.<iv base64url>.<ciphertext||tag base64url>`, with the AAD bound
 * at seal time and required again at open time (it is not stored in the string).
 */
import { b64urlDecode, b64urlEncode, bytes, utf8 } from "./encoding";
import { VaultError } from "./errors";

const subtle = globalThis.crypto.subtle;

export async function importAesKey(raw: Uint8Array, usages: KeyUsage[] = ["encrypt", "decrypt"]): Promise<CryptoKey> {
  if (raw.byteLength !== 32) throw new VaultError("master_key_invalid", "AES-256 key must be 32 bytes");
  const copy = bytes(raw);
  try {
    return await subtle.importKey("raw", copy, { name: "AES-GCM", length: 256 }, false, usages);
  } finally {
    copy.fill(0);
  }
}

export async function sealWith(key: CryptoKey, plaintext: Uint8Array, aad: string): Promise<string> {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = await subtle.encrypt({ name: "AES-GCM", iv, additionalData: utf8(aad) }, key, bytes(plaintext));
  return `v1.${b64urlEncode(iv)}.${b64urlEncode(new Uint8Array(ct))}`;
}

/** Returns the plaintext bytes; the caller must `wipe()` them when done. */
export async function openWith(key: CryptoKey, sealed: string, aad: string): Promise<Uint8Array<ArrayBuffer>> {
  const parts = typeof sealed === "string" ? sealed.split(".") : [];
  if (parts.length !== 3 || parts[0] !== "v1") throw new VaultError("decrypt_failed", "sealed value is malformed");
  let iv: Uint8Array<ArrayBuffer>;
  let ct: Uint8Array<ArrayBuffer>;
  try {
    iv = b64urlDecode(parts[1]!);
    ct = b64urlDecode(parts[2]!);
  } catch {
    throw new VaultError("decrypt_failed", "sealed value is malformed");
  }
  if (iv.byteLength !== 12) throw new VaultError("decrypt_failed", "sealed value is malformed");
  try {
    const pt = await subtle.decrypt({ name: "AES-GCM", iv, additionalData: utf8(aad) }, key, ct);
    return new Uint8Array(pt);
  } catch {
    throw new VaultError("decrypt_failed", "could not open sealed value");
  }
}
