/**
 * k-skill login connections (docs/architecture/KSKILL-CONNECTIONS.md): the server-side registry that resolves a
 * tool's `connection` to the owner's sealed vault login, the per-credential session cache, the in-turn "wait for
 * the user to connect" signal, revoke, and the redaction that keeps secret values out of tool results.
 *
 * Plaintext secrets exist only inside `ConnectionResolver.use()` (the vault's `use` callback); the vault wipes the
 * object when it settles. Nothing here logs.
 */
import type { CredentialInfo } from "@pickle/protocol";
import { scrubSecrets } from "./secrets";
import type {
  ConnectionHandle,
  ConnectionNeed,
  ConnectionResolver,
  ConnectionService,
  ConnectionSession,
  ConnectionVerifyResult,
  CredentialAccess,
  ToolResult,
} from "./types";

/** vault service ids (same rule as @pickle/vault) */
export const CONNECTION_SERVICE_RE = /^[a-z0-9_-]{2,32}$/;
const MASK = "[가림]";

export type ConnectionErrorCode = "not_connected" | "expired" | "unavailable";

export class ConnectionError extends Error {
  readonly code: ConnectionErrorCode;
  readonly service: string;
  constructor(code: ConnectionErrorCode, service: string) {
    super(`${service}: ${code}`);
    this.name = "ConnectionError";
    this.code = code;
    this.service = service;
  }
}

/** "not_connected" / "expired" for a ConnectionError or the vault's credential_not_found / credential_expired. */
export function connectionErrorCode(err: unknown): "not_connected" | "expired" | null {
  if (err instanceof ConnectionError) return err.code === "expired" ? "expired" : err.code === "not_connected" ? "not_connected" : null;
  const code = err && typeof err === "object" ? (err as { code?: unknown }).code : undefined;
  if (code === "credential_expired") return "expired";
  if (code === "credential_not_found") return "not_connected";
  return null;
}

/** What a tool returns when the upstream refused its login (401, wrong key, expired session). */
export function needsConnection(service: string, serviceName: string, reason?: string, summary?: string): ToolResult {
  const name = serviceName || service;
  return {
    ok: false,
    summary: summary ?? `${name} 연결이 필요해요`,
    needsConnection: { service, serviceName: name, reason: reason?.trim() || `${name} 연결이 끊겼거나 정보가 맞지 않아요. 다시 연결해 주세요.` },
  };
}

// ───────────────────────────── redaction ─────────────────────────────

/** every secret value a handle has carried (initial + update()) and every secret-looking session string it saw */
const seenSecrets = new WeakMap<ConnectionHandle, { secret: Set<string>; session: Set<string> }>();

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

/** MIME types by their registered top-level type (a bare "word/word" check also skipped ~5% of random base64 tokens) */
const MIME = /^(?:application|text|image|audio|video|multipart|font|model|message)\/[a-z0-9.+-]+$/i;
/** IANA time-zone names by region ("Asia/Seoul", "America/Argentina/Buenos_Aires", "Etc/GMT+9") */
const ZONE = /^(?:Africa|America|Antarctica|Arctic|Asia|Atlantic|Australia|Europe|Indian|Pacific|Etc)\/[A-Za-z0-9_+-]+(?:\/[A-Za-z_-]+)?$/;
/**
 * A session-id label, not a host one. Judged per hyphen-separated part ("ap-northeast-2" is fine): 12+ letters with a
 * run of 5+ consonants ("qwhfkzpxmtrbnvcl.worker"; real long labels such as "tosspayments" or "githubusercontent" have
 * none), 8+ chars mixing letters and digits ("k3j4h5g6.f7d8s9a0.token"), or 6+ digits ("1731400000.abc123.sig").
 */
function randomLabel(l: string): boolean {
  return l.split("-").some((p) =>
    /^[a-z]+$/.test(p) ? p.length >= 12 && /[b-df-hj-np-tv-xz]{5,}/.test(p) : (p.length >= 8 && /\d/.test(p) && /[a-z]/.test(p)) || /^\d{6,}$/.test(p),
  );
}
/** a host name: lowercase labels ending in a 2–6 letter TLD ("api2.popbill.co.kr", "cdn3.example.tv"), no random label */
function hostName(s: string): boolean {
  return /^(?:[a-z0-9-]+\.)+[a-z]{2,6}$/.test(s) && !s.split(".").some(randomLabel);
}
/**
 * A word-shaped path segment: lowercase ("api", "v1", "main.3f9a2b.js"), Capitalized, camelCase or PascalCase with
 * humps of 3+ letters and an optional file extension ("Invoice", "getAccountInfo", "Login.do", "Invoice.aspx"), or a
 * short CONSTANT ("API", "V1"). Never upper, lower and digits mixed. Anything else (base64 text, 2-letter humps such
 * as "/user/MyPage") is random: collected, and matched only as a whole token.
 */
function wordSegment(seg: string): boolean {
  if (/[A-Z]/.test(seg) && /[a-z]/.test(seg) && /\d/.test(seg)) return false;
  return seg === "" || /^[a-z0-9_.-]+$/.test(seg) || /^[a-z]*(?:[A-Z][a-z]{2,})+(?:\.[a-z]{1,5})?$/.test(seg) || /^[A-Z0-9_]{1,6}$/.test(seg);
}
/** a path ("/api/v1/invoice", "/Popbill/Invoice"): no "+"/"=" and only word-shaped segments */
function pathName(s: string): boolean {
  return /^\/[A-Za-z0-9_.\/-]*$/.test(s) && s.split("/").every(wordSegment);
}

/**
 * A session-store string worth masking: anything of 8+ chars that isn't a URL, a date, a MIME type, a time zone, prose
 * or cookie-jar metadata. Metadata has no "+"/"=" and no random-looking part, so a base64 token that happens to start
 * with "/" is still collected.
 */
function secretish(s: string): boolean {
  if (s.length < 8 || /\s/.test(s)) return false;
  if (/^https?:\/\//i.test(s) || /^\d{4}-\d{2}-\d{2}/.test(s) || MIME.test(s) || ZONE.test(s)) return false;
  // cookie-jar metadata: paths, domains (".popbill.com", "api2.popbill.co.kr"), dotted scopes ("invoice.read")
  const dottedWords = /^[a-z][a-z-]*(?:\.[a-z][a-z-]*)+$/.test(s) && !s.split(".").some(randomLabel);
  if (pathName(s) || /^\.[a-z0-9.-]+$/.test(s) || dottedWords || hostName(s)) return false;
  return true;
}

/** secret-looking strings inside a session value (cookie jars: each `k=v` value too), bounded */
function sessionLeaves(v: unknown, out: Set<string>, depth = 0): void {
  if (out.size >= 256 || depth > 6 || v == null) return;
  if (typeof v === "string") {
    if (secretish(v)) out.add(v);
    if (v.includes("=")) {
      for (const part of v.split(/;\s*/)) {
        const i = part.indexOf("=");
        const val = i > 0 ? part.slice(i + 1).trim() : "";
        if (secretish(val)) out.add(val);
      }
    }
    return;
  }
  if (Array.isArray(v)) {
    for (const x of v) sessionLeaves(x, out, depth + 1);
    return;
  }
  if (typeof v === "object") for (const x of Object.values(v as Record<string, unknown>)) sessionLeaves(x, out, depth + 1);
}

/** what a connection run must not echo, split by origin: secret fields match anywhere, session strings only as whole tokens */
export interface KnownSecrets {
  secret: string[];
  session: string[];
}

/**
 * The values a result must not echo: the secret fields (always masked, as substrings too) and the secret-looking
 * session strings set, read or cleared during the run (masked on token boundaries). Call while the handle is live.
 */
export function knownSecrets(conn: ConnectionHandle): KnownSecrets {
  const seen = seenSecrets.get(conn);
  const secret = new Set<string>(seen?.secret ?? []);
  try {
    for (const v of Object.values(conn.secret)) if (typeof v === "string") secret.add(v);
  } catch {
    /* wiped */
  }
  const session = new Set<string>(seen?.session ?? []);
  try {
    sessionLeaves(conn.session.get(), session);
  } catch {
    /* ignore */
  }
  return { secret: [...secret], session: [...session].filter((s) => !secret.has(s)) };
}

/** values that are configuration words, not secrets */
const GENERIC = /^(?:true|false|null|none|test|user|admin|prod|production|real|live|dev|sandbox|staging|demo|default|yes|no)$/i;

/** too short or too generic to mask without mangling ordinary data */
function maskable(s: string): boolean {
  if (typeof s !== "string") return false;
  const t = s.trim();
  if (t.length < 4) return false;
  if (/^\d+$/.test(t) && t.length < 6) return false;
  return !GENERIC.test(t);
}

function encodings(v: string): string[] {
  const out = [v, v.trim()];
  for (const x of [...out]) {
    out.push(encodeURIComponent(x), new URLSearchParams({ x }).toString().slice(2), JSON.stringify(x).slice(1, -1));
    if (x.length >= 8) {
      const b = b64(x);
      out.push(b, b.replace(/=+$/, ""), b.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""), Buffer.from(x, "utf8").toString("hex"));
    }
  }
  return out;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

interface Needle {
  n: string;
  /** null → plain substring; else a boundary-aware matcher (all-digit, short and session needles) */
  re: RegExp | null;
}

/**
 * Random-looking (16+ chars: letters with digits, hex, or base64 with "+" or "="): can't sit inside an ordinary word, so
 * it matches as a substring. Letters with "/" only ("/Popbill/Invoice", "Europe/Amsterdam") stay whole-token matches.
 */
const entropic = (s: string) =>
  s.length >= 16 && ((/[A-Za-z]/.test(s) && /\d/.test(s)) || /^[0-9a-f]+$/i.test(s) || (/^[A-Za-z0-9+/]+={0,2}$/.test(s) && /[+=]/.test(s)));

/** a session needle only matches as a whole token: no [A-Za-z0-9_-] right before or after it (checked on such ends only) */
function tokenRe(n: string): RegExp {
  const before = /^[\w-]/.test(n) ? "(?<![\\w-])" : "";
  const after = /[\w-]$/.test(n) ? "(?![\\w-])" : "";
  return new RegExp(`${before}${escapeRe(n)}${after}`, "g");
}

/**
 * Each value in every encoding, plus base64("a:b") pairs (Basic auth); bounded, longest first. Secret fields match
 * as substrings (8+ chars). Word-like session strings match only on token boundaries, so "verified" never masks inside
 * "unverified"; high-entropy session strings (and their encodings) match as substrings, like secrets.
 */
function needlesFor(secret: string[], session: string[]): Needle[] {
  const all = [...secret, ...session];
  const vals = [...new Set(all.filter(maskable))].slice(0, 160);
  const sessionOnly = new Set(session.filter((s) => !secret.includes(s) && !entropic(s)));
  const kinds = new Map<string, "secret" | "session">();
  for (const v of vals) for (const e of encodings(v)) if (maskable(e) && kinds.get(e) !== "secret") kinds.set(e, sessionOnly.has(v) ? "session" : "secret");
  const pairs = all.filter((s) => typeof s === "string" && s.trim().length >= 2).slice(0, 8);
  for (const a of pairs) for (const b of pairs) if (a !== b) for (const x of [`${a}:${b}`, `${a.trim()}:${b.trim()}`]) for (const e of [b64(x), b64(x).replace(/=+$/, "")]) kinds.set(e, "secret");
  return [...kinds]
    .sort(([a], [b]) => b.length - a.length)
    .map(([n, kind]) => {
      if (kind === "session") return { n, re: tokenRe(n) };
      if (/^\d+$/.test(n)) return { n, re: new RegExp(`(?<!\\d)${n}(?!\\d)`, "g") };
      if (n.length < 8) return { n, re: new RegExp(`(?<![A-Za-z0-9])${escapeRe(n)}(?![A-Za-z0-9])`, "g") };
      return { n, re: null };
    });
}

/** keys (lower-cased, "-" and "_" removed) whose values are credentials whatever they hold — suffix-anchored */
const SENSITIVE_KEY =
  /(?:password|passwd|passcode|^pass|pwd|secret|secretkey|accesskey|apikey|privatekey|(?<!page|continuation|next|sync|cursor|pagination|resumption|skip)token|authorization|bearer|cookie|sessionid|sessionkey|credential|^pin|otp)(?:s|header|value|hash)?$/;
/** token shapes masked everywhere: JWT, sk-/ghp_/AKIA… keys, any Bearer/Basic value of 10+ chars (safe over pretty) */
const TOKEN_SHAPES = [
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]+)?/g,
  /\b(?:sk|pk|rk)[-_](?:live|test)?[-_]?[A-Za-z0-9]{16,}/g,
  /\b(?:ghp|gho|ghs|xox[abprs])[-_][A-Za-z0-9-]{12,}/g,
  /\bAKIA[A-Z0-9]{12,}/g,
  /\bAIza[A-Za-z0-9_-]{20,}/g,
  /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{10,}/gi,
];

/** plural look-alikes that are counts, not credentials ("tokens": 1234, "inputTokens", "pins"); a number only */
const USAGE_KEY = /^(?:(?:input|output|total|prompt|completion|max|used|remaining)?tokens|pins)$/;
const isCount = (x: unknown) => typeof x === "number" || typeof x === "bigint";
const isPlainObject = (x: unknown) => typeof x === "object" && x !== null && !Array.isArray(x);
/** map or chat pins ({lat, lng}, {id, title}) are walked key by key; strings or numbers in a list may be PIN codes */
const isPinObjects = (x: unknown) => isPlainObject(x) || (Array.isArray(x) && x.length > 0 && x.every(isPlainObject));
/** keys inside pins whose 4–8 digit values are data, not PIN codes (normalized: lower-case, no "-"/"_") */
const PIN_DATA_WORD =
  /^(?:lat|lng|lon|long|latitude|longitude|alt|altitude|x|y|z|zoom|ids?|count|\w*count|index|idx|order|seq|sort|position|pos|rank|page|size|width|height|level|floor|year|month|day|date|time|version|zip|zipcode|postcode|postalcode|price|amount|cost|distance|duration)$/;
function pinDataKey(raw: string, norm: string): boolean {
  if (/account$/.test(norm)) return false; // bankAccount, myAccount
  if (PIN_DATA_WORD.test(norm)) return true;
  if (/pass|pin|code|otp|secret/.test(norm)) return false; // passcodeId, pinId
  // an "…Id" suffix on the raw key (placeId, place_id, userIDs), not "valid", "paid" or "android"
  return /(?:^|[a-z0-9])(?:Id|ID)s?$/.test(raw) || /[_-]ids?$/i.test(raw);
}
/** inside a pins walk: "check" masks all-digit strings and integers of 4–8 digits (PIN codes), "data" keeps them */
type PinMode = "check" | "data";
const pinDigits = (x: unknown) =>
  typeof x === "string" ? /^\d{4,8}$/.test(x.trim()) : typeof x === "number" ? Number.isInteger(x) && Math.abs(x) >= 1000 && Math.abs(x) <= 99_999_999 : typeof x === "bigint" ? x >= 1000n && x <= 99_999_999n : false;

export interface Redactor {
  text(s: string): string;
  deep<T>(v: T): T;
}

/**
 * Masks exact secret values (in their usual encodings), credential-named keys and token-shaped strings. A plain list
 * is treated as secret fields; knownSecrets() output also carries session strings, masked on token boundaries.
 */
export function redactor(secrets: string[] | KnownSecrets): Redactor {
  const { secret, session } = Array.isArray(secrets) ? { secret: secrets, session: [] } : secrets;
  const needles = needlesFor(secret, session);
  const exact = new Set([...secret, ...session].filter(maskable).flatMap((v) => [v, v.trim()]));
  const text = (s: string): string => {
    if (typeof s !== "string" || !s) return s;
    let out = s;
    for (const { n, re } of needles) {
      if (!out.includes(n)) continue;
      out = re ? out.replace(re, MASK) : out.split(n).join(MASK);
    }
    for (const re of TOKEN_SHAPES) out = out.replace(re, (_m, scheme?: string) => (typeof scheme === "string" && /^(?:bearer|basic)$/i.test(scheme) ? `${scheme} ${MASK}` : MASK));
    return out;
  };
  const deep = (v: unknown, depth: number, pin?: PinMode): unknown => {
    if (pin === "check" && pinDigits(v)) return MASK;
    if (typeof v === "string") return text(v);
    if (typeof v === "number" || typeof v === "bigint") return exact.has(String(v)) ? MASK : v;
    if (v == null || typeof v !== "object") return v;
    if (depth > 12) return MASK;
    if (Array.isArray(v)) return v.map((x) => deep(x, depth + 1, pin));
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) {
      // Date, URL, class instances: keep their JSON form, redacted
      try {
        const j = JSON.parse(JSON.stringify(v)) as unknown;
        return typeof j === "object" && j !== null ? deep(j, depth + 1, pin) : typeof j === "string" ? deep(j, depth + 1, pin) : j;
      } catch {
        return MASK;
      }
    }
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      const norm = k.toLowerCase().replace(/[-_]/g, "");
      const pinWalk = norm === "pins" && isPinObjects(x);
      const exempt = USAGE_KEY.test(norm) && (isCount(x) || pinWalk);
      const sensitive = x != null && x !== "" && typeof x !== "boolean" && SENSITIVE_KEY.test(norm) && !exempt;
      const childPin: PinMode | undefined = pinWalk ? "check" : pin && (pinDataKey(k, norm) ? "data" : "check");
      out[text(k)] = sensitive ? MASK : deep(x, depth + 1, childPin);
    }
    return out;
  };
  return { text, deep: <T>(v: T) => deep(v, 0) as T };
}

/** A connection tool's result with every string redacted; failure text also gets the pattern scrub. */
export function redactResult(r: ToolResult, secrets: string[] | KnownSecrets): ToolResult {
  const R = redactor(secrets);
  const summary = R.text(typeof r.summary === "string" ? r.summary : "");
  const out: ToolResult = { ok: r.ok, summary: r.ok ? summary : scrubSecrets(summary) };
  if (r.data !== undefined) out.data = R.deep(r.data);
  if (r.card) out.card = R.deep(r.card);
  if (typeof r.memory === "string" && r.memory) out.memory = R.text(r.memory);
  if (r.needsConnection) {
    const n = r.needsConnection;
    out.needsConnection = { service: String(n.service), serviceName: R.text(String(n.serviceName ?? n.service)), reason: scrubSecrets(R.text(String(n.reason ?? ""))) };
  }
  return out;
}

// ───────────────────────────── handles ─────────────────────────────

/** in-memory ConnectionSession (tests, or a resolver without a registry) */
export function memorySession(now: () => number = Date.now): ConnectionSession {
  let slot: { value: unknown; expiresAt: number } | null = null;
  return {
    get<T>() {
      if (!slot) return null;
      if (slot.expiresAt <= now()) {
        slot = null;
        return null;
      }
      return slot.value as T;
    },
    set(value, ttlMs) {
      slot = { value, expiresAt: now() + clampTtl(ttlMs) };
    },
    clear() {
      slot = null;
    },
  };
}

const clampTtl = (ms: number) => Math.max(1000, Math.min(24 * 3600_000, Number.isFinite(ms) ? Math.floor(ms) : 0));

/**
 * Build a ConnectionHandle around a live secret object. `secret` is used as is (the vault wipes it after `use`);
 * `update` reseals and swaps the values in place. Also the test double for tool unit tests:
 * `connectionHandle({ service: "popbill", secret: { linkId: "BOGUS", secretKey: "bogus-key" } })`.
 */
export function connectionHandle(i: {
  service: string;
  secret: Record<string, string>;
  credentialId?: string;
  hint?: string;
  session?: ConnectionSession;
  update?: (secret: Record<string, string>) => Promise<void>;
}): ConnectionHandle {
  const live = i.secret;
  const seen = { secret: new Set<string>(Object.values(live).filter((v) => typeof v === "string")), session: new Set<string>() };
  const inner = i.session ?? memorySession();
  // every session value set or read during the run is remembered, so a token cleared before the result is built
  // is still masked in it
  const session: ConnectionSession = {
    get<T>() {
      const v = inner.get<T>();
      sessionLeaves(v, seen.session);
      return v;
    },
    set(value, ttlMs) {
      sessionLeaves(value, seen.session);
      inner.set(value, ttlMs);
    },
    clear() {
      sessionLeaves(inner.get(), seen.session);
      inner.clear();
    },
  };
  const handle: ConnectionHandle = {
    service: i.service,
    credentialId: i.credentialId ?? "cred_test",
    hint: i.hint ?? "",
    secret: live,
    session,
    async update(next) {
      if (!next || typeof next !== "object") throw new TypeError("secret must be an object");
      const clean: Record<string, string> = {};
      for (const [k, v] of Object.entries(next)) if (typeof v === "string") clean[k] = v;
      for (const v of Object.values(clean)) seen.secret.add(v);
      if (i.update) await i.update(clean);
      for (const k of Object.keys(live)) delete live[k];
      Object.assign(live, clean);
    },
  };
  seenSecrets.set(handle, seen);
  return handle;
}

/**
 * An in-memory resolver for tests and local tools: `logins` maps service → secret. `connect()` / `disconnect()`
 * simulate the user (connect wakes `waitFor`).
 */
export function memoryConnections(
  logins: Record<string, Record<string, string>> = {},
  names: Record<string, string> = {},
): ConnectionResolver & {
  connect(service: string, secret: Record<string, string>): void;
  disconnect(service: string): void;
  uses: { service: string; action: string; purpose: string }[];
  sessions: Map<string, ConnectionSession>;
} {
  const store = new Map(Object.entries(logins).map(([k, v]) => [k, { ...v }] as const));
  /** a reconnect is a new credential id (cred_<service>#<n>) */
  const gen = new Map<string, number>();
  const waiters = new Map<string, Set<() => void>>();
  const sessions = new Map<string, ConnectionSession>();
  const uses: { service: string; action: string; purpose: string }[] = [];
  return {
    uses,
    sessions,
    async find(service) {
      return store.has(service) ? { credentialId: `cred_${service}#${gen.get(service) ?? 0}`, hint: "••••" } : null;
    },
    async use(service, purpose, fn) {
      const saved = store.get(service);
      if (!saved) throw new ConnectionError("not_connected", service);
      uses.push({ service, ...purpose });
      const secret = { ...saved };
      let session = sessions.get(service);
      if (!session) sessions.set(service, (session = memorySession()));
      const h = connectionHandle({
        service,
        credentialId: `cred_${service}#${gen.get(service) ?? 0}`,
        hint: "••••",
        secret,
        session,
        update: async (next) => void store.set(service, { ...next }),
      });
      try {
        return await fn(h);
      } finally {
        for (const k of Object.keys(secret)) delete secret[k];
      }
    },
    waitFor(service, o) {
      return waitUntil(waiters, service, () => Promise.resolve(store.has(service) && `cred_${service}#${gen.get(service) ?? 0}` !== o.exclude), o);
    },
    serviceName: (service) => names[service] ?? service,
    owns: (service) => service in names || store.has(service),
    ownsCredential: async (credentialId) => /^cred_[a-z0-9_-]+#\d+$/.test(credentialId),
    connect(service, secret) {
      store.set(service, { ...secret });
      gen.set(service, (gen.get(service) ?? 0) + 1);
      for (const w of waiters.get(service) ?? []) w();
    },
    disconnect(service) {
      store.delete(service);
      sessions.delete(service);
    },
  };
}

/** register first, then check: a connect landing between the check and the registration still wakes us */
function waitUntil(
  waiters: Map<string, Set<() => void>>,
  key: string,
  check: () => Promise<boolean>,
  o: { timeoutMs: number; signal: AbortSignal },
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let done = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const set = waiters.get(key) ?? new Set<() => void>();
    waiters.set(key, set);
    const finish = (v: boolean) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      o.signal.removeEventListener("abort", onAbort);
      set.delete(wake);
      if (!set.size && waiters.get(key) === set) waiters.delete(key);
      resolve(v);
    };
    const wake = () => {
      check().then(
        (ok) => (ok ? finish(true) : undefined),
        () => undefined,
      );
    };
    const onAbort = () => finish(false);
    set.add(wake);
    if (o.signal.aborted) return finish(false);
    o.signal.addEventListener("abort", onAbort, { once: true });
    // the deadline runs from now, even while the first check is still pending
    if (o.timeoutMs > 0) timer = setTimeout(() => finish(false), o.timeoutMs);
    check().then(
      (ok) => {
        if (done) return;
        if (ok) finish(true);
        else if (!(o.timeoutMs > 0)) finish(false);
      },
      () => finish(false),
    );
  });
}

// ───────────────────────────── registry (server) ─────────────────────────────

/** The vault surface the registry needs (@pickle/vault Vault, apps/server VaultLike). */
export interface ConnectionVault {
  list(userId: string): Promise<CredentialInfo[]>;
  remove(userId: string, id: string): Promise<boolean>;
  update?(userId: string, id: string, secret: Record<string, string>): Promise<void>;
  access(userId: string, opts?: { actor?: "agent" | "user" | "system"; deviceVerified?: boolean }): CredentialAccess;
}

export interface ConnectionStatus {
  service: string;
  serviceName: string;
  connected: boolean;
  credentialId: string | null;
  hint: string;
  label: string;
  expiresAt: number | null;
  connectedAt: number | null;
  lastUsedAt: number | null;
}

export interface ConnectionRegistryOptions {
  vault: ConnectionVault;
  /** the catalog (packages/skills `connectionServices()`); called on every lookup, so it may change at runtime */
  services: () => readonly ConnectionService[];
  now?: () => number;
  /** service.verify budget. Default 20 s. */
  verifyTimeoutMs?: number;
  /** service.revoke budget. Default 10 s. */
  revokeTimeoutMs?: number;
}

/**
 * Server-side owner of k-skill connections. One instance per server: per-credential session caches (memory only),
 * in-turn connect waiters, verify after save, revoke on disconnect.
 */
export class ConnectionRegistry {
  readonly #vault: ConnectionVault;
  readonly #services: () => readonly ConnectionService[];
  readonly #now: () => number;
  readonly #verifyMs: number;
  readonly #revokeMs: number;
  readonly #sessions = new Map<string, { value: unknown; expiresAt: number }>();
  readonly #waiters = new Map<string, Set<() => void>>();

  constructor(o: ConnectionRegistryOptions) {
    this.#vault = o.vault;
    this.#services = o.services;
    this.#now = o.now ?? Date.now;
    this.#verifyMs = o.verifyTimeoutMs ?? 20_000;
    this.#revokeMs = o.revokeTimeoutMs ?? 10_000;
  }

  /** valid, de-duplicated catalog entries (a throwing or malformed catalog yields what is usable) */
  catalog(): ConnectionService[] {
    let list: readonly ConnectionService[] = [];
    try {
      list = this.#services() ?? [];
    } catch {
      list = [];
    }
    const seen = new Set<string>();
    const out: ConnectionService[] = [];
    for (const s of list) {
      if (!s || typeof s.id !== "string" || !CONNECTION_SERVICE_RE.test(s.id) || seen.has(s.id)) continue;
      if (typeof s.name !== "string" || !s.name.trim() || !Array.isArray(s.fields)) continue;
      seen.add(s.id);
      out.push(s);
    }
    return out;
  }

  service(id: string): ConnectionService | undefined {
    return this.catalog().find((s) => s.id === id);
  }

  isService(id: string): boolean {
    return !!this.service(id);
  }

  serviceName(id: string): string {
    return this.service(id)?.name ?? id;
  }

  /** ToolContext.connections for one owner (vault access is audited as actor "agent") */
  forUser(userId: string): ConnectionResolver {
    const access = () => this.#vault.access(userId, { actor: "agent" });
    const find = async (service: string) => {
      if (!CONNECTION_SERVICE_RE.test(service)) return null;
      const f = await access().find(service);
      return f ? { credentialId: f.id, hint: f.hint } : null;
    };
    return {
      find,
      use: async (service, purpose, fn) => {
        const f = await find(service);
        if (!f) throw new ConnectionError("not_connected", service);
        try {
          return await access().use(f.credentialId, purpose, (secret) => fn(this.#handle(userId, service, f.credentialId, f.hint, secret)));
        } catch (err) {
          const code = connectionErrorCode(err);
          if (code && !(err instanceof ConnectionError)) {
            if (code === "expired") this.forget(userId, service);
            throw new ConnectionError(code, service);
          }
          throw err;
        }
      },
      waitFor: (service, o) =>
        waitUntil(
          this.#waiters,
          this.#key(userId, service),
          async () => {
            const f = await find(service);
            return !!f && f.credentialId !== o.exclude;
          },
          o,
        ),
      serviceName: (service) => this.serviceName(service),
      owns: (service) => this.isService(service),
      ownsCredential: async (credentialId) => {
        const row = (await this.#vault.list(userId)).find((r) => r.id === credentialId);
        return !!row && this.isService(row.service);
      },
    };
  }

  /** one row per catalog service, newest usable login first */
  async status(userId: string): Promise<ConnectionStatus[]> {
    const rows = await this.#vault.list(userId);
    return this.catalog().map((s) => {
      const mine = rows.filter((r) => r.service === s.id && !r.expired).sort((a, b) => b.createdAt - a.createdAt);
      const r = mine[0];
      return {
        service: s.id,
        serviceName: s.name,
        connected: !!r,
        credentialId: r?.id ?? null,
        hint: r?.hint ?? "",
        label: r?.label ?? "",
        expiresAt: r?.expiresAt ?? null,
        connectedAt: r?.createdAt ?? null,
        lastUsedAt: r?.lastUsedAt ?? null,
      };
    });
  }

  /**
   * Run service.verify on a saved login (actor "user", action "login"). On failure the caller removes the row.
   * The message is Korean, redacted, and never carries upstream error text.
   */
  async verify(userId: string, service: string, o: { credentialId?: string; signal?: AbortSignal } = {}): Promise<ConnectionVerifyResult> {
    const svc = this.service(service);
    if (!svc) return { ok: false, message: "알 수 없는 서비스예요." };
    const access = this.#vault.access(userId, { actor: "user" });
    const id = o.credentialId ?? (await access.find(service))?.id;
    const row = id ? (await this.#vault.list(userId)).find((r) => r.id === id) : undefined;
    if (!id || !row || row.service !== service) return { ok: false, message: "저장된 연결 정보를 찾지 못했어요. 다시 연결해 주세요." };
    if (!svc.verify) return { ok: true };
    const failed = `${svc.name}에 연결하지 못했어요. 입력한 정보를 확인하고 다시 시도해 주세요.`;
    const unreachable = `${svc.name}에 지금 연결할 수 없어요. 잠시 후 다시 시도해 주세요.`;
    let reached = false;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(new Error("verify timed out")), this.#verifyMs);
    const onAbort = () => ctl.abort(o.signal?.reason);
    if (o.signal?.aborted) onAbort();
    else o.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      return await access.use(id, { action: "login", purpose: `${svc.name} 연결 확인` }, async (secret) => {
        reached = true;
        const R = redactor(Object.values(secret));
        const session = this.#session(userId, service, id);
        const r = await Promise.race([
          svc.verify!(secret, { signal: ctl.signal, session }),
          new Promise<never>((_, reject) => {
            if (ctl.signal.aborted) reject(ctl.signal.reason);
            else ctl.signal.addEventListener("abort", () => reject(ctl.signal.reason), { once: true });
          }),
        ]);
        if (r && r.ok === true) {
          const label = typeof r.accountLabel === "string" ? scrubSecrets(R.text(r.accountLabel)).slice(0, 60) : "";
          return label ? { ok: true as const, accountLabel: label } : { ok: true as const };
        }
        session.clear();
        const retryable = !!r && (r as { retryable?: unknown }).retryable === true;
        const msg = r && typeof r.message === "string" && r.message.trim() ? scrubSecrets(R.text(r.message.trim())).slice(0, 160) : retryable ? unreachable : failed;
        return retryable ? { ok: false as const, message: msg, retryable: true as const } : { ok: false as const, message: msg };
      });
    } catch (err) {
      this.#dropCredential(userId, service, id);
      // a missing or expired row is definite; a timeout, a cancelled check or a throwing service (network) is not
      if (connectionErrorCode(err)) return { ok: false, message: "저장된 연결 정보를 찾지 못했어요. 다시 연결해 주세요." };
      if (ctl.signal.aborted && !o.signal?.aborted) return { ok: false, message: `${svc.name} 응답이 늦어요. 잠시 후 다시 시도해 주세요.`, retryable: true };
      if (reached || o.signal?.aborted) return { ok: false, message: unreachable, retryable: true };
      return { ok: false, message: failed };
    } finally {
      clearTimeout(timer);
      o.signal?.removeEventListener("abort", onAbort);
    }
  }

  /**
   * The user connected `service` (saved + verified): when `credentialId` names the new row, drop the rows of the
   * service that are older than it (and their sessions), then wake turns waiting for it. Rows are ordered by
   * (createdAt, id), so two connects racing each other leave exactly the newer one. Returns how many waiting turns
   * were woken.
   */
  async notifyConnected(userId: string, service: string, o: { credentialId?: string } = {}): Promise<number> {
    const all = o.credentialId ? await this.#vault.list(userId) : [];
    const keep = all.find((r) => r.id === o.credentialId && r.service === service);
    if (keep) {
      const older = (r: CredentialInfo) => r.createdAt < keep.createdAt || (r.createdAt === keep.createdAt && r.id < keep.id);
      const rows = all.filter((r) => r.service === service && r.id !== keep.id && older(r));
      for (const r of rows) {
        try {
          await this.#vault.remove(userId, r.id);
        } catch {
          /* best effort */
        }
        this.#dropCredential(userId, service, r.id);
      }
    }
    const set = this.#waiters.get(this.#key(userId, service));
    const n = set?.size ?? 0;
    for (const w of [...(set ?? [])]) w();
    return n;
  }

  /**
   * Disconnect: best-effort upstream sign-out of each live login (service.revoke, actor "user", action "logout"),
   * then delete every vault row of the service and every cached session/token for it.
   */
  async revoke(userId: string, service: string): Promise<{ removed: number }> {
    const rows = (await this.#vault.list(userId)).filter((r) => r.service === service);
    const svc = this.service(service);
    if (svc?.revoke) {
      // every live login of the service signs out upstream, in parallel, best effort, within revokeTimeoutMs
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(new Error("revoke timed out")), this.#revokeMs);
      const stopped = new Promise<void>((resolve) => ctl.signal.addEventListener("abort", () => resolve(), { once: true }));
      try {
        await Promise.allSettled(
          rows
            .filter((r) => !r.expired)
            .slice(0, 5)
            .map((live) =>
              this.#vault.access(userId, { actor: "user" }).use(live.id, { action: "logout", purpose: `${svc.name} 연결 해제` }, async (secret) => {
                await Promise.race([svc.revoke!(secret, { signal: ctl.signal, session: this.#session(userId, service, live.id) }), stopped]);
              }),
            ),
        );
      } finally {
        clearTimeout(timer);
      }
    }
    let removed = 0;
    for (const r of rows) {
      try {
        if (await this.#vault.remove(userId, r.id)) removed++;
      } catch {
        /* keep going: remove every row we can */
      }
    }
    this.forget(userId, service);
    return { removed };
  }

  /** drop cached sessions/tokens of a service (all its credentials) without touching the vault */
  forget(userId: string, service: string): void {
    const prefix = `${this.#key(userId, service)}\u0000`;
    for (const k of [...this.#sessions.keys()]) if (k.startsWith(prefix)) this.#sessions.delete(k);
  }

  /**
   * A server job's handle on the newest usable login of `service` (the invest watch's Toss reads): its id and the same
   * per-credential session cache the agent's tools use, so both share one live token. The vault is not opened (no
   * access record); the job unseals the login itself, as its own actor, only when it needs a new token. null: no login.
   */
  async sessionFor(userId: string, service: string): Promise<{ credentialId: string; session: ConnectionSession } | null> {
    if (!CONNECTION_SERVICE_RE.test(service)) return null;
    const f = await this.#vault.access(userId, { actor: "system" }).find(service);
    return f ? { credentialId: f.id, session: this.#session(userId, service, f.id) } : null;
  }

  /** test/ops hook: number of live cached sessions */
  get sessionCount(): number {
    return this.#sessions.size;
  }

  #key(userId: string, service: string): string {
    return `${userId}\u0000${service}`;
  }

  #dropCredential(userId: string, service: string, credentialId: string): void {
    this.#sessions.delete(`${this.#key(userId, service)}\u0000${credentialId}`);
  }

  #session(userId: string, service: string, credentialId: string): ConnectionSession {
    const key = `${this.#key(userId, service)}\u0000${credentialId}`;
    return {
      get: <T>() => {
        const s = this.#sessions.get(key);
        if (!s) return null;
        if (s.expiresAt <= this.#now()) {
          this.#sessions.delete(key);
          return null;
        }
        return s.value as T;
      },
      set: (value, ttlMs) => {
        if (this.#sessions.size >= 2000) this.#sweep();
        this.#sessions.set(key, { value, expiresAt: this.#now() + clampTtl(ttlMs) });
      },
      clear: () => void this.#sessions.delete(key),
    };
  }

  #sweep(): void {
    const now = this.#now();
    for (const [k, s] of this.#sessions) if (s.expiresAt <= now) this.#sessions.delete(k);
    while (this.#sessions.size >= 2000) {
      const first = this.#sessions.keys().next().value;
      if (first === undefined) break;
      this.#sessions.delete(first);
    }
  }

  #handle(userId: string, service: string, credentialId: string, hint: string, secret: Record<string, string>): ConnectionHandle {
    return connectionHandle({
      service,
      credentialId,
      hint,
      secret,
      session: this.#session(userId, service, credentialId),
      update: async (next) => {
        if (!this.#vault.update) throw new Error("this vault cannot reseal credentials");
        await this.#vault.update(userId, credentialId, next);
      },
    });
  }
}

/** Default `connection_request` reason when a call has no login yet. */
export function connectionReason(title: string, serviceName: string): string {
  const t = title.trim();
  return t ? `${t}에 ${serviceName} 계정 연결이 필요해요.` : `${serviceName} 계정 연결이 필요해요.`;
}

export type { ConnectionNeed };
