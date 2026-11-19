/**
 * @pickle/vault/client — browser-side half of the Credential Enclave.
 *
 * WebCrypto only: no `node:` imports and no Node Buffer API; it also runs under Bun (tests), where IndexedDB
 * and localStorage are absent and an in-memory device key is used instead.
 *
 * - `sealForEnclave` encrypts credential fields ON THE DEVICE for the server enclave's public
 *   key (ECDH-P256 + HKDF-SHA256 + AES-256-GCM, see protocol `EnclaveEnvelope`). The server
 *   only ever receives the envelope.
 * - `getOrCreateDeviceKey` keeps a non-extractable ECDSA P-256 signing key in IndexedDB; the
 *   private half can sign but can never be read out, even by this page's own scripts.
 * - `signApproval` signs `approve:<approvalId>:<nonce>` → the server verifies with
 *   `verifyApproval` and records `deviceVerified` ("이 기기의 키로 확인했어요").
 */
import type { CredentialKind, EnclaveEnvelope, EnclaveInfo } from "@pickle/protocol";
import { b64urlEncode, bytes, publicEcJwk, utf8, wipe } from "./encoding";

const ALG = "ECDH-P256+HKDF-SHA256+A256GCM" as const;
const HKDF_INFO = "pickle-enclave/v1";
const subtle = globalThis.crypto.subtle;

// ───────────────────────────── sealing ─────────────────────────────

export async function sealForEnclave(
  info: EnclaveInfo,
  plaintext: Record<string, string>,
  aad: string,
): Promise<EnclaveEnvelope> {
  if (!info || info.alg !== ALG) throw new Error("unsupported enclave algorithm");
  if (!plaintext || typeof plaintext !== "object" || Array.isArray(plaintext)) throw new Error("plaintext must be an object");
  for (const v of Object.values(plaintext)) if (typeof v !== "string") throw new Error("plaintext values must be strings");

  const enclaveKey = await subtle.importKey("jwk", publicEcJwk(info.publicKey), { name: "ECDH", namedCurve: "P-256" }, false, []);
  // Ephemeral pair: the private half is non-extractable and dropped after this call.
  const eph = (await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"])) as CryptoKeyPair;
  let shared: Uint8Array | null = null;
  let pt: Uint8Array | null = null;
  try {
    shared = new Uint8Array(await subtle.deriveBits({ name: "ECDH", public: enclaveKey }, eph.privateKey, 256));
    const ikm = await subtle.importKey("raw", bytes(shared), "HKDF", false, ["deriveKey"]);
    const key = await subtle.deriveKey(
      { name: "HKDF", hash: "SHA-256", salt: utf8(info.kid), info: utf8(HKDF_INFO) },
      ikm,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt"],
    );
    const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
    pt = utf8(JSON.stringify(plaintext));
    const ct = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv, additionalData: utf8(aad) }, key, bytes(pt)));
    const epk = publicEcJwk(await subtle.exportKey("jwk", eph.publicKey));
    return { v: 1, alg: ALG, kid: info.kid, epk, iv: b64urlEncode(iv), ct: b64urlEncode(ct), aad };
  } finally {
    wipe(shared);
    wipe(pt);
  }
}

// ───────────────────────────── device key ─────────────────────────────

export interface DeviceKey {
  id: string;
  publicJwk: JsonWebKey;
  /** ECDSA P-256 / SHA-256 over utf8(data) → base64url(r||s) (IEEE P1363) */
  sign(data: string): Promise<string>;
}

const DB_NAME = "pickle-device";
const STORE = "keys";
const KEY_NAME = "signing";
const DEVICE_ID_KEY = "pickle.deviceId";

interface StoredKey {
  privateKey: CryptoKey;
  publicJwk: JsonWebKey;
  createdAt: number;
}

let devicePromise: Promise<DeviceKey> | null = null;
let memoryDeviceId: string | null = null;
let memoryKey: StoredKey | null = null;

export function getOrCreateDeviceKey(): Promise<DeviceKey> {
  if (!devicePromise) {
    devicePromise = createDeviceKey();
    devicePromise.catch(() => {
      devicePromise = null;
    });
  }
  return devicePromise;
}

export async function signApproval(approvalId: string, nonce: string): Promise<{ signature: string; deviceId: string }> {
  const key = await getOrCreateDeviceKey();
  return { signature: await key.sign(`approve:${approvalId}:${nonce}`), deviceId: key.id };
}

async function createDeviceKey(): Promise<DeviceKey> {
  const id = deviceId();
  const stored = (await loadOrCreateIdbKey()) ?? (await memoryFallbackKey());
  return {
    id,
    publicJwk: { ...stored.publicJwk },
    async sign(data: string): Promise<string> {
      const sig = await subtle.sign({ name: "ECDSA", hash: "SHA-256" }, stored.privateKey, utf8(data));
      return b64urlEncode(new Uint8Array(sig));
    },
  };
}

async function generateSigningKey(): Promise<StoredKey> {
  const pair = (await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"])) as CryptoKeyPair;
  return { privateKey: pair.privateKey, publicJwk: publicEcJwk(await subtle.exportKey("jwk", pair.publicKey)), createdAt: Date.now() };
}

async function memoryFallbackKey(): Promise<StoredKey> {
  if (!memoryKey) memoryKey = await generateSigningKey();
  return memoryKey;
}

function deviceId(): string {
  const ls = safeLocalStorage();
  const existing = ls?.getItem(DEVICE_ID_KEY) ?? memoryDeviceId;
  if (existing) return existing;
  const fresh = b64urlEncode(globalThis.crypto.getRandomValues(new Uint8Array(16)));
  try {
    ls?.setItem(DEVICE_ID_KEY, fresh);
  } catch {
    /* storage full / blocked — keep it in memory */
  }
  memoryDeviceId = fresh;
  return fresh;
}

function safeLocalStorage(): Storage | null {
  try {
    const ls = (globalThis as { localStorage?: Storage }).localStorage;
    return ls && typeof ls.getItem === "function" ? ls : null;
  } catch {
    return null;
  }
}

/** Returns null when IndexedDB is unavailable (tests, some private modes). */
async function loadOrCreateIdbKey(): Promise<StoredKey | null> {
  const idb = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
  if (!idb) return null;
  let db: IDBDatabase;
  try {
    db = await openDb(idb);
  } catch {
    return null;
  }
  try {
    const existing = await idbGet(db);
    if (existing && existing.privateKey && existing.publicJwk) return existing;
    const fresh = await generateSigningKey();
    // `add` fails if another tab created the key first — then use theirs.
    const added = await idbAdd(db, fresh);
    return added ? fresh : ((await idbGet(db)) ?? fresh);
  } catch {
    return null;
  } finally {
    db.close();
  }
}

function openDb(idb: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = idb.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbGet(db: IDBDatabase): Promise<StoredKey | null> {
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, "readonly").objectStore(STORE).get(KEY_NAME);
    req.onsuccess = () => resolve((req.result as StoredKey | undefined) ?? null);
    req.onerror = () => reject(req.error);
  });
}

function idbAdd(db: IDBDatabase, value: StoredKey): Promise<boolean> {
  return new Promise((resolve) => {
    const tx = db.transaction(STORE, "readwrite");
    const req = tx.objectStore(STORE).add(value, KEY_NAME);
    req.onerror = (ev) => {
      ev.preventDefault();
      resolve(false);
    };
    tx.oncomplete = () => resolve(true);
    tx.onabort = () => resolve(false);
  });
}

// ───────────────────────────── hints ─────────────────────────────

/**
 * Masked hint shown in lists — never the secret itself.
 * emails "ha***@gmail.com", Korean mobiles "010-****-5678", other phones "***-5678",
 * cards "•••• 1234", anything else first 2 chars + "***".
 */
export function maskHint(kind: CredentialKind, value: string): string {
  const v = (value ?? "").trim();
  if (!v) return "";
  if (kind === "card") {
    const digits = v.replace(/\D/g, "");
    return `•••• ${digits.slice(-4)}`;
  }
  const at = v.indexOf("@");
  if (at > 0 && at < v.length - 1 && !/\s/.test(v)) {
    const local = v.slice(0, at);
    const shown = local.length <= 2 ? local.slice(0, 1) : local.slice(0, 2);
    return `${shown}***${v.slice(at)}`.slice(0, 64);
  }
  if (/^\+?[\d\s().-]{9,}$/.test(v)) {
    let digits = v.replace(/\D/g, "");
    if (digits.startsWith("82") && digits.length >= 11) digits = `0${digits.slice(2)}`;
    if (/^01[016789]\d{7,8}$/.test(digits)) return `${digits.slice(0, 3)}-****-${digits.slice(-4)}`;
    return `***-${digits.slice(-4)}`;
  }
  return `${Array.from(v).slice(0, 2).join("")}***`;
}
