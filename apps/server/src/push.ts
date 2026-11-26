/**
 * Web Push from the server (B1c; team-lead 2045-9, DD 2042-b §4): the lock-screen line for an invest alert. The service
 * worker that shows it is the app's (mobile-foundation). No package: RFC 8291 (aes128gcm payload encryption) and
 * RFC 8292 (VAPID) on WebCrypto; test/push.test.ts checks the encryption against RFC 8291's own example.
 *
 * - Nothing is sent unless PICKLE_PUSH_SUBJECT is set (cfg.push; team-lead 2210: the contact goes to Apple, Google and
 *   Mozilla, so the person decides it first, and no personal address is a default). Until then the key and a new
 *   subscription answer 503 push_off (team-lead 2331b, DD 2330: the app then offers no lock-screen line it cannot
 *   deliver, and says no reason); removing one still works, and rows from before are kept, never sent to. QA servers
 *   and tests never reach a push service.
 * - The VAPID key pair lives in the data dir (`vapid.json`, 0600), made on first use. Its private half never leaves that
 *   file: never logged, never sent. A new key pair makes every subscription stale (the browser's applicationServerKey).
 * - A subscription belongs to the session that sent it: signing out (or a password reset) deletes the session and its
 *   subscriptions with it, so a signed-out phone gets no lock-screen line. The same endpoint again moves it.
 * - Payload WebPushPayload: a title only, the body empty (DD 2042-b §4: no amount, quantity or average price on a lock
 *   screen), the tag, and the row to open. The endpoint must be https on a known push service: no request elsewhere.
 * - 404/410 drop the subscription; any other failure keeps it and records the status (no retry). Endpoints are never
 *   logged (an endpoint is a capability URL).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { WebPushPayload } from "@pickle/protocol";
import type { AuthedUser } from "./auth.ts";
import type { Core } from "./core.ts";
import type { ServerConfig } from "./deps.ts";
import { bad, json, readJson, type Ctx } from "./http.ts";

export const PUSH_TIMEOUT_MS = 10_000;
/** a lock-screen line older than this is not worth showing (a 5-minute watch slot has moved on many times) */
export const PUSH_TTL_S = 4 * 3600;
export const MAX_SUBS_PER_USER = 10;
/** the push services browsers hand out; an endpoint on any other host is refused (no request elsewhere through it) */
export const PUSH_HOSTS = ["fcm.googleapis.com", "updates.push.services.mozilla.com", "push.services.mozilla.com", "web.push.apple.com", "notify.windows.com"];

export function pushConfigFromEnv(env: Record<string, string | undefined>): ServerConfig["push"] {
  const s = env.PICKLE_PUSH_SUBJECT?.trim() ?? "";
  if (/^mailto:[^@\s]+@[^@\s]+$/.test(s)) return { subject: s };
  try {
    const u = new URL(s);
    if (u.protocol === "https:" && !u.username && !u.password) return { subject: u.href };
  } catch {
    // not a URL: off
  }
  return null;
}

export interface PushMessage {
  title: string;
  /** a later push with the same tag replaces the earlier one on the device */
  tag: string;
  threadId?: string;
  messageId?: string;
}

interface SubRow {
  id: string;
  user_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

const enc = new TextEncoder();
type Bytes = Uint8Array<ArrayBuffer>;
export const b64url = (b: Uint8Array | ArrayBuffer): string => Buffer.from(b instanceof Uint8Array ? b : new Uint8Array(b)).toString("base64url");
export const unb64url = (s: string): Bytes => new Uint8Array(Buffer.from(s, "base64url"));
const B64URL = /^[A-Za-z0-9_-]+$/;
const concat = (...parts: Uint8Array[]): Bytes => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

export function endpointAllowed(endpoint: string): boolean {
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" || u.port || u.username || u.password) return false;
  return PUSH_HOSTS.some((h) => u.hostname === h || u.hostname.endsWith(`.${h}`));
}

async function hkdf(salt: Bytes, ikm: Bytes, info: Bytes, bytes: number): Promise<Bytes> {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, bytes * 8));
}

/** RFC 8291 aes128gcm body for one subscription, one record. `fixed`: RFC 8291's example keys and salt (tests only). */
export async function encryptPayload(plaintext: Bytes, uaPublic: Bytes, authSecret: Bytes, fixed?: { as: CryptoKeyPair; salt: Bytes }): Promise<Bytes> {
  const as = fixed?.as ?? ((await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", as.publicKey));
  const ua = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: ua }, as.privateKey, 256));
  const ikm = await hkdf(authSecret, ecdh, concat(enc.encode("WebPush: info\0"), uaPublic, asPublic), 32);
  const salt = fixed?.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  // one record, so the padding delimiter is 0x02 (last record) and no padding follows
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, concat(plaintext, new Uint8Array([2]))));
  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, 4096);
  return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, ct);
}

interface VapidFile {
  publicKey: string;
  privateJwk: JsonWebKey;
}

export class PushHub {
  private keys: Promise<{ pub: string; priv: CryptoKey }> | null = null;
  private jwts = new Map<string, { header: string; exp: number }>();
  private readonly fetchFn: typeof fetch;

  constructor(private core: Core) {
    this.fetchFn = core.deps.pushFetch ?? fetch;
  }

  enabled(): boolean {
    return !!this.core.cfg.push;
  }

  private loadKeys(): Promise<{ pub: string; priv: CryptoKey }> {
    this.keys ??= (async () => {
      const file = join(this.core.cfg.dataDir, "vapid.json");
      let k: VapidFile;
      if (existsSync(file)) k = JSON.parse(readFileSync(file, "utf8")) as VapidFile;
      else {
        const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
        k = { publicKey: b64url(await crypto.subtle.exportKey("raw", pair.publicKey)), privateJwk: await crypto.subtle.exportKey("jwk", pair.privateKey) };
        writeFileSync(file, JSON.stringify(k), { mode: 0o600, flag: "wx" });
        this.core.log.info("push keys made");
      }
      const priv = await crypto.subtle.importKey("jwk", k.privateJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
      return { pub: k.publicKey, priv };
    })().catch((err: unknown) => {
      this.keys = null;
      throw err;
    });
    return this.keys;
  }

  async publicKey(): Promise<string> {
    return (await this.loadKeys()).pub;
  }

  /** RFC 8292 header for one push-service origin; the JWT is kept until an hour before its 12-hour expiry */
  private async vapid(endpoint: string): Promise<string> {
    const aud = new URL(endpoint).origin;
    const now = Math.floor(this.core.now() / 1000);
    const have = this.jwts.get(aud);
    if (have && have.exp - now > 3600) return have.header;
    const { pub, priv } = await this.loadKeys();
    const exp = now + 12 * 3600;
    const head = b64url(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
    const claims = b64url(enc.encode(JSON.stringify({ aud, exp, sub: this.core.cfg.push!.subject })));
    const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, priv, enc.encode(`${head}.${claims}`));
    const header = `vapid t=${head}.${claims}.${b64url(sig)}, k=${pub}`;
    this.jwts.set(aud, { header, exp });
    return header;
  }

  count(userId: string): number {
    return (this.core.db.sql.query("SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = $u").get({ u: userId }) as { n: number }).n;
  }

  /** to every subscription of the person, one after another; resolves with how many push services took it */
  async send(userId: string, m: PushMessage): Promise<number> {
    if (!this.enabled()) return 0;
    const { db } = this.core;
    const subs = db.sql.query("SELECT id, user_id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = $u ORDER BY created_at, rowid").all({ u: userId }) as SubRow[];
    if (!subs.length) return 0;
    const payload: WebPushPayload = { v: 1, title: m.title, body: "", tag: m.tag, ...(m.threadId ? { threadId: m.threadId } : {}), ...(m.messageId ? { messageId: m.messageId } : {}) };
    const plain = enc.encode(JSON.stringify(payload));
    let ok = 0;
    for (const s of subs) {
      if (!endpointAllowed(s.endpoint)) {
        db.sql.query("DELETE FROM push_subscriptions WHERE id = $id").run({ id: s.id });
        continue;
      }
      let status = 0;
      try {
        const res = await this.fetchFn(s.endpoint, {
          method: "POST",
          headers: { authorization: await this.vapid(s.endpoint), "content-encoding": "aes128gcm", "content-type": "application/octet-stream", ttl: String(PUSH_TTL_S), urgency: "high" },
          body: await encryptPayload(plain, unb64url(s.p256dh), unb64url(s.auth)),
          redirect: "manual",
          signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
        });
        status = res.status;
        await res.body?.cancel().catch(() => undefined);
      } catch {
        status = 0;
      }
      const now = this.core.now();
      if (status >= 200 && status < 300) {
        ok++;
        db.sql.query("UPDATE push_subscriptions SET last_ok_at = $n, last_status = $s WHERE id = $id").run({ id: s.id, n: now, s: status });
      } else if (status === 404 || status === 410) db.sql.query("DELETE FROM push_subscriptions WHERE id = $id").run({ id: s.id });
      else {
        db.sql.query("UPDATE push_subscriptions SET last_status = $s WHERE id = $id").run({ id: s.id, s: status });
        this.core.log.warn("push not taken", { user: userId, status });
      }
    }
    return ok;
  }

  /** PushSubscription.toJSON() from the app; the same endpoint again (another person, another session) moves it here */
  save(a: AuthedUser, v: Record<string, unknown>): void {
    const endpoint = typeof v.endpoint === "string" ? v.endpoint : "";
    if (endpoint.length > 1024 || !endpointAllowed(endpoint)) throw bad("이 기기로는 알림을 보낼 수 없어요", "invalid_subscription");
    const keys = (v.keys && typeof v.keys === "object" ? v.keys : {}) as Record<string, unknown>;
    const p256dh = typeof keys.p256dh === "string" && B64URL.test(keys.p256dh) ? keys.p256dh : "";
    const auth = typeof keys.auth === "string" && B64URL.test(keys.auth) ? keys.auth : "";
    const pk = unb64url(p256dh);
    if (pk.length !== 65 || pk[0] !== 4 || unb64url(auth).length !== 16) throw bad("이 기기로는 알림을 보낼 수 없어요", "invalid_subscription");
    const { db } = this.core;
    const now = this.core.now();
    db.tx(() => {
      db.sql
        .query(
          `INSERT INTO push_subscriptions (id, user_id, session_hash, endpoint, p256dh, auth, created_at) VALUES ($id, $u, $sh, $e, $p, $a, $n)
           ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, session_hash = excluded.session_hash, p256dh = excluded.p256dh,
             auth = excluded.auth, created_at = excluded.created_at, last_status = NULL`,
        )
        .run({ id: `ps_${b64url(crypto.getRandomValues(new Uint8Array(12)))}`, u: a.userId, sh: a.tokenHash, e: endpoint, p: p256dh, a: auth, n: now });
      // past the cap the oldest go (devices that never unsubscribed)
      db.sql
        .query("DELETE FROM push_subscriptions WHERE user_id = $u AND id NOT IN (SELECT id FROM push_subscriptions WHERE user_id = $u ORDER BY created_at DESC, rowid DESC LIMIT $k)")
        .run({ u: a.userId, k: MAX_SUBS_PER_USER });
    });
  }

  remove(userId: string, endpoint: unknown): boolean {
    if (typeof endpoint !== "string" || !endpoint) return false;
    return this.core.db.sql.query("DELETE FROM push_subscriptions WHERE user_id = $u AND endpoint = $e").run({ u: userId, e: endpoint }).changes > 0;
  }
}

/** push off (no PICKLE_PUSH_SUBJECT): the app takes this as off and offers nothing; no reason line (team-lead 2331b) */
const pushOff = () => json({ error: "push_off" }, 503);

/** with push off the key and a new subscription answer 503 push_off; DELETE works either way */
export function pushRoutes(core: Core) {
  return {
    key: async (_c: Ctx, _userId: string) => (core.push.enabled() ? json({ publicKey: await core.push.publicKey() }) : pushOff()),
    save: async (c: Ctx, a: AuthedUser) => {
      if (!core.push.enabled()) return pushOff();
      core.push.save(a, await readJson(c.req));
      return json({ ok: true });
    },
    remove: async (c: Ctx, userId: string) => {
      const body = await readJson(c.req);
      return json({ ok: true, removed: core.push.remove(userId, body.endpoint) });
    },
  };
}
