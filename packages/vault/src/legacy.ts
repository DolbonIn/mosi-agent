/** Legacy env-key helpers (AES-256-GCM with VAULT_MASTER_KEY from env). Kept for existing callers. */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGO = "aes-256-gcm";
const IV_LEN = 12;
const KEY_LEN = 32;

function masterKey(): Buffer {
  const b64 = process.env.VAULT_MASTER_KEY;
  if (!b64) {
    throw new Error(
      "VAULT_MASTER_KEY is not set. Generate 32 random bytes (base64) and provide it via env only.",
    );
  }
  const key = Buffer.from(b64, "base64");
  if (key.length !== KEY_LEN) {
    throw new Error(`VAULT_MASTER_KEY must decode to ${KEY_LEN} bytes, got ${key.length}.`);
  }
  return key;
}

export interface SealedSecret {
  v: 1;
  iv: string;
  tag: string;
  ct: string;
  aad?: string;
}

export function seal(plaintext: string, aad?: string): SealedSecret {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, masterKey(), iv);
  if (aad) cipher.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    v: 1,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ct: ct.toString("base64"),
    ...(aad ? { aad } : {}),
  };
}

export function open(sealed: SealedSecret): string {
  const decipher = createDecipheriv(ALGO, masterKey(), Buffer.from(sealed.iv, "base64"));
  if (sealed.aad) decipher.setAAD(Buffer.from(sealed.aad, "utf8"));
  decipher.setAuthTag(Buffer.from(sealed.tag, "base64"));
  const pt = Buffer.concat([
    decipher.update(Buffer.from(sealed.ct, "base64")),
    decipher.final(),
  ]);
  return pt.toString("utf8");
}
