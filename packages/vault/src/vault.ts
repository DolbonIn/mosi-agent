/**
 * Per-user envelope encryption + audited, time-limited credential access.
 *
 * Key hierarchy:
 *   VAULT_MASTER_KEY (env, 32 bytes)
 *     └─ wraps a random 32-byte DEK per user   (AES-256-GCM, aad `dek:<userId>`)
 *          └─ seals each credential secret JSON (AES-256-GCM, aad `cred:<userId>:<credId>`)
 *
 * Plaintext exists only inside `CredentialAccess.use()` callbacks and is wiped (best effort)
 * right after. Every use — allowed, denied (expired) or failed — writes an AccessRecord.
 * Nothing in this module logs; errors carry fixed messages without secrets.
 */
import type { AccessRecord, CredentialInfo, CredentialKind, KeepFor, SaveCredentialRequest } from "@pickle/protocol";
import type { CredentialAccess } from "@pickle/agent";
import { importAesKey, openWith, sealWith } from "./aead";
import { fromUtf8, parseSecret, utf8, wipe } from "./encoding";
import type { Enclave } from "./enclave";
import { VaultError } from "./errors";

export interface CredentialRow {
  id: string;
  userId: string;
  service: string;
  label: string;
  kind: CredentialKind;
  hint: string;
  keepFor: KeepFor;
  expiresAt: number | null;
  /** `v1.<iv>.<ct>` — AES-256-GCM with the user's DEK, aad `cred:<userId>:<id>` */
  sealed: string;
  createdAt: number;
  lastUsedAt: number | null;
  useCount: number;
}

/** Implemented by apps/server (SQLite). All methods must be scoped by userId. */
export interface VaultStorage {
  insertCredential(row: CredentialRow): Promise<void>;
  getCredential(userId: string, id: string): Promise<CredentialRow | null>;
  listCredentials(userId: string): Promise<CredentialRow[]>;
  updateCredential(userId: string, id: string, patch: Partial<CredentialRow>): Promise<void>;
  deleteCredential(userId: string, id: string): Promise<boolean>;
  getWrappedUserKey(userId: string): Promise<string | null>;
  setWrappedUserKey(userId: string, wrapped: string): Promise<void>;
  insertAccess(userId: string, rec: AccessRecord): Promise<void>;
  listAccess(userId: string, limit: number): Promise<AccessRecord[]>;
}

const KEEP_FOR_MS: Record<Exclude<KeepFor, "forever">, number> = {
  "1h": 60 * 60 * 1000,
  "1d": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

/** Lending period → absolute expiry (ms), `null` for "forever". */
export function keepForToExpiry(keepFor: KeepFor, now: number): number | null {
  if (keepFor === "forever") return null;
  const ms = KEEP_FOR_MS[keepFor];
  if (ms === undefined) throw new VaultError("invalid_request", "unknown keepFor");
  return now + ms;
}

const SERVICE_RE = /^[a-z0-9_-]{2,32}$/;
const KINDS: readonly CredentialKind[] = ["login", "card", "token"];
const KEEPS: readonly KeepFor[] = ["1h", "1d", "7d", "30d", "forever"];
const MAX_SECRET_JSON = 16 * 1024;

export interface VaultOptions {
  enclave: Enclave;
  masterKey: Uint8Array;
  storage: VaultStorage;
  serviceName: (id: string) => string;
  /** test hook */
  now?: () => number;
}

type Actor = AccessRecord["actor"];

export class Vault {
  private readonly enclave: Enclave;
  private readonly storage: VaultStorage;
  private readonly serviceName: (id: string) => string;
  private readonly now: () => number;
  private readonly masterKeyPromise: Promise<CryptoKey>;
  /** unwrapped DEKs as non-extractable CryptoKeys (raw bytes are wiped right after import) */
  private readonly deks = new Map<string, Promise<CryptoKey>>();

  constructor(opts: VaultOptions) {
    if (!(opts.masterKey instanceof Uint8Array) || opts.masterKey.byteLength !== 32) {
      throw new VaultError("master_key_invalid", "master key must be 32 bytes");
    }
    this.enclave = opts.enclave;
    this.storage = opts.storage;
    this.serviceName = opts.serviceName;
    this.now = opts.now ?? Date.now;
    this.masterKeyPromise = importAesKey(opts.masterKey);
    // keep the promise from surfacing as an unhandled rejection before first use
    this.masterKeyPromise.catch(() => {});
  }

  // ─────────────── writes ───────────────

  /** Saves a device-sealed credential. The envelope must be bound to `${userId}:${service}:${kind}`. */
  async save(userId: string, req: SaveCredentialRequest): Promise<CredentialInfo> {
    validateMeta(req);
    const expectedAad = `${userId}:${req.service}:${req.kind}`;
    if (!req.envelope || req.envelope.aad !== expectedAad) {
      throw new VaultError("envelope_aad", "envelope is bound to a different user/service");
    }
    const secret = await this.enclave.openEnvelope(req.envelope, expectedAad);
    try {
      const info = await this.insert(userId, req, secret);
      await this.record(userId, {
        credentialId: info.id,
        service: req.service,
        serviceName: this.serviceName(req.service),
        action: "save",
        purpose: "기기에서 암호화한 정보를 보관했어요",
        actor: "user",
        outcome: "ok",
        deviceVerified: false,
      });
      return info;
    } finally {
      scrub(secret);
    }
  }

  /** Saves a secret produced server-side (e.g. session tokens a login returned). */
  async saveSystem(
    userId: string,
    i: { service: string; label: string; kind: CredentialKind; hint: string; keepFor: KeepFor; secret: Record<string, string> },
  ): Promise<CredentialInfo> {
    validateMeta(i);
    validateSecret(i.secret);
    return this.insert(userId, i, i.secret);
  }

  /** Replaces the sealed secret of an existing credential in one write (e.g. both refreshed tokens). */
  async update(userId: string, id: string, secret: Record<string, string>): Promise<void> {
    validateSecret(secret);
    const row = await this.storage.getCredential(userId, id);
    if (!row || row.userId !== userId) throw new VaultError("credential_not_found", "credential not found");
    const sealed = await this.sealSecret(userId, id, secret);
    await this.storage.updateCredential(userId, id, { sealed });
  }

  async renew(userId: string, id: string, keepFor: KeepFor): Promise<CredentialInfo> {
    if (!KEEPS.includes(keepFor)) throw new VaultError("invalid_request", "unknown keepFor");
    const row = await this.storage.getCredential(userId, id);
    if (!row || row.userId !== userId) throw new VaultError("credential_not_found", "credential not found");
    const expiresAt = keepForToExpiry(keepFor, this.now());
    await this.storage.updateCredential(userId, id, { keepFor, expiresAt });
    return this.toInfo({ ...row, keepFor, expiresAt });
  }

  async remove(userId: string, id: string): Promise<boolean> {
    const row = await this.storage.getCredential(userId, id);
    const ok = await this.storage.deleteCredential(userId, id);
    if (ok && row) {
      await this.record(userId, {
        credentialId: id,
        service: row.service,
        serviceName: this.serviceName(row.service),
        action: "remove",
        purpose: "보관한 정보를 삭제했어요",
        actor: "user",
        outcome: "ok",
        deviceVerified: false,
      });
    }
    return ok;
  }

  // ─────────────── reads ───────────────

  async list(userId: string): Promise<CredentialInfo[]> {
    const rows = await this.storage.listCredentials(userId);
    return rows.filter((r) => r.userId === userId).map((r) => this.toInfo(r));
  }

  /**
   * Scoped access for connector code. `find` returns the newest non-expired credential for a
   * service (user-saved `login`/`card` rows are preferred over system `token` rows of the same
   * service). `use` refuses expired credentials (records outcome "denied", throws
   * `credential_expired`), otherwise decrypts, records the access, calls `fn`, and wipes.
   */
  access(userId: string, opts: { actor?: Actor; deviceVerified?: boolean } = {}): CredentialAccess {
    const actor: Actor = opts.actor ?? "agent";
    const deviceVerified = opts.deviceVerified ?? false;
    return {
      find: async (service: string) => {
        const now = this.now();
        const rows = (await this.storage.listCredentials(userId)).filter(
          (r) => r.userId === userId && r.service === service && !isExpired(r, now),
        );
        rows.sort((a, b) => kindRank(a.kind) - kindRank(b.kind) || b.createdAt - a.createdAt);
        const best = rows[0];
        return best ? { id: best.id, hint: best.hint } : null;
      },
      use: async <T>(
        credentialId: string,
        purpose: { action: string; purpose: string },
        fn: (secret: Record<string, string>) => Promise<T>,
      ): Promise<T> => {
        const row = await this.storage.getCredential(userId, credentialId);
        if (!row || row.userId !== userId) throw new VaultError("credential_not_found", "credential not found");
        const base = {
          credentialId: row.id,
          service: row.service,
          serviceName: this.serviceName(row.service),
          action: purpose.action,
          purpose: purpose.purpose,
          actor,
          deviceVerified,
        };
        const now = this.now();
        if (isExpired(row, now)) {
          await this.record(userId, { ...base, outcome: "denied" });
          throw new VaultError("credential_expired", "credential lending period has ended");
        }
        let secret: Record<string, string>;
        try {
          secret = await this.openSecret(userId, row);
        } catch (e) {
          await this.record(userId, { ...base, outcome: "error" });
          throw e;
        }
        await this.record(userId, { ...base, outcome: "ok" });
        await this.storage.updateCredential(userId, row.id, { useCount: row.useCount + 1, lastUsedAt: now });
        try {
          return await fn(secret);
        } catch (e) {
          await this.record(userId, { ...base, outcome: "error" }).catch(() => {});
          throw e;
        } finally {
          scrub(secret);
        }
      },
    };
  }

  async record(userId: string, rec: Omit<AccessRecord, "id" | "createdAt">): Promise<void> {
    await this.storage.insertAccess(userId, { ...rec, id: globalThis.crypto.randomUUID(), createdAt: this.now() });
  }

  async accessLog(userId: string, limit = 50): Promise<AccessRecord[]> {
    return this.storage.listAccess(userId, Math.max(1, Math.min(500, Math.floor(limit))));
  }

  // ─────────────── internals ───────────────

  private async insert(
    userId: string,
    m: { service: string; label: string; kind: CredentialKind; hint: string; keepFor: KeepFor },
    secret: Record<string, string>,
  ): Promise<CredentialInfo> {
    const id = globalThis.crypto.randomUUID();
    const now = this.now();
    const row: CredentialRow = {
      id,
      userId,
      service: m.service,
      label: m.label.trim(),
      kind: m.kind,
      hint: m.hint,
      keepFor: m.keepFor,
      expiresAt: keepForToExpiry(m.keepFor, now),
      sealed: await this.sealSecret(userId, id, secret),
      createdAt: now,
      lastUsedAt: null,
      useCount: 0,
    };
    await this.storage.insertCredential(row);
    return this.toInfo(row);
  }

  private async sealSecret(userId: string, credId: string, secret: Record<string, string>): Promise<string> {
    const dek = await this.userKey(userId);
    const pt = utf8(JSON.stringify(secret));
    try {
      return await sealWith(dek, pt, `cred:${userId}:${credId}`);
    } finally {
      wipe(pt);
    }
  }

  private async openSecret(userId: string, row: CredentialRow): Promise<Record<string, string>> {
    const dek = await this.userKey(userId);
    const pt = await openWith(dek, row.sealed, `cred:${userId}:${row.id}`);
    try {
      return parseSecret(fromUtf8(pt));
    } catch {
      throw new VaultError("decrypt_failed", "credential payload is corrupt");
    } finally {
      wipe(pt);
    }
  }

  /** Lazily creates and caches the user's DEK. Concurrent first calls share one creation. */
  private userKey(userId: string): Promise<CryptoKey> {
    let p = this.deks.get(userId);
    if (!p) {
      p = this.loadOrCreateUserKey(userId);
      this.deks.set(userId, p);
      p.catch(() => this.deks.delete(userId));
    }
    return p;
  }

  private async loadOrCreateUserKey(userId: string): Promise<CryptoKey> {
    const master = await this.masterKeyPromise;
    const aad = `dek:${userId}`;
    let wrapped = await this.storage.getWrappedUserKey(userId);
    if (!wrapped) {
      const raw = globalThis.crypto.getRandomValues(new Uint8Array(32));
      try {
        await this.storage.setWrappedUserKey(userId, await sealWith(master, raw, aad));
      } finally {
        wipe(raw);
      }
      // read back: if another process raced us, use whichever key actually got stored
      wrapped = await this.storage.getWrappedUserKey(userId);
      if (!wrapped) throw new VaultError("decrypt_failed", "user key was not persisted");
    }
    const raw = await openWith(master, wrapped, aad);
    try {
      return await importAesKey(raw);
    } finally {
      wipe(raw);
    }
  }

  private toInfo(r: CredentialRow): CredentialInfo {
    return {
      id: r.id,
      service: r.service,
      serviceName: this.serviceName(r.service),
      label: r.label,
      kind: r.kind,
      hint: r.hint,
      keepFor: r.keepFor,
      expiresAt: r.expiresAt,
      expired: isExpired(r, this.now()),
      createdAt: r.createdAt,
      lastUsedAt: r.lastUsedAt,
      useCount: r.useCount,
    };
  }
}

function isExpired(r: Pick<CredentialRow, "expiresAt">, now: number): boolean {
  return r.expiresAt !== null && r.expiresAt <= now;
}

function kindRank(k: CredentialKind): number {
  return k === "token" ? 1 : 0;
}

function validateMeta(m: { service: unknown; label: unknown; kind: unknown; hint: unknown; keepFor: unknown }): void {
  if (typeof m.service !== "string" || !SERVICE_RE.test(m.service)) {
    throw new VaultError("invalid_request", "service must match [a-z0-9_-]{2,32}");
  }
  if (typeof m.label !== "string" || m.label.trim().length === 0 || m.label.length > 80) {
    throw new VaultError("invalid_request", "label must be 1–80 characters");
  }
  if (typeof m.hint !== "string" || m.hint.length > 64) {
    throw new VaultError("invalid_request", "hint must be at most 64 characters");
  }
  if (!KINDS.includes(m.kind as CredentialKind)) throw new VaultError("invalid_request", "unknown credential kind");
  if (!KEEPS.includes(m.keepFor as KeepFor)) throw new VaultError("invalid_request", "unknown keepFor");
}

function validateSecret(secret: unknown): asserts secret is Record<string, string> {
  if (!secret || typeof secret !== "object" || Array.isArray(secret)) {
    throw new VaultError("invalid_request", "secret must be an object");
  }
  const entries = Object.entries(secret as Record<string, unknown>);
  if (entries.length === 0) throw new VaultError("invalid_request", "secret must not be empty");
  let size = 2;
  for (const [k, v] of entries) {
    if (typeof v !== "string") throw new VaultError("invalid_request", "secret values must be strings");
    size += k.length + v.length + 6;
  }
  if (size > MAX_SECRET_JSON) throw new VaultError("invalid_request", "secret is too large");
}

/** Best-effort: drop references to plaintext strings (JS strings themselves are immutable). */
function scrub(secret: Record<string, string>): void {
  for (const k of Object.keys(secret)) {
    secret[k] = "";
    delete secret[k];
  }
}
