/**
 * Web Push from the server (B1c, push.ts): RFC 8291 encryption against the RFC's own example, VAPID (RFC 8292) headers
 * checked with the public key, the payload the service worker gets (a title only: DD 2042-b §4), subscriptions (allowed
 * push hosts, keys, the cap, moving an endpoint, the session owning it), what a push service's answer does, and the
 * off server. The push service is a fake fetch: nothing real is called.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ServerEvent, WebPushPayload } from "@pickle/protocol";
import type { CredentialAccess } from "@pickle/agent";
import { etToEpoch } from "../src/invest/calendar.ts";
import * as idb from "../src/invest/db.ts";
import type { Logger, LogFields } from "../src/log.ts";
import { PUSH_HOSTS, PushHub, b64url, encryptPayload, pushConfigFromEnv, unb64url } from "../src/push.ts";
import { BOGUS_TOSS_SECRET, FAKE_TOSS_BASE, makeInvestUpstream } from "./fake-toss.ts";
import { sha256Hex } from "../src/util.ts";
import { makeDevice, makeFakeVault, makeHarness, type Harness } from "./helpers.ts";

const DAY = "2026-11-30"; // a Monday, a full session
const ET = (h: number, m: number, day = DAY) => etToEpoch(day, h, m);
const SUBJECT = "mailto:ops@example.com";
const enc = new TextEncoder();
type Bytes = Uint8Array<ArrayBuffer>;

// ───────────────────────────── the device side (what a browser does) ─────────────────────────────

interface Device {
  sub: { endpoint: string; keys: { p256dh: string; auth: string } };
  priv: CryptoKey;
  pub: Bytes;
  auth: Bytes;
}

async function device(endpoint: string): Promise<Device> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  const pub = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const auth = crypto.getRandomValues(new Uint8Array(16));
  return { sub: { endpoint, keys: { p256dh: b64url(pub), auth: b64url(auth) } }, priv: pair.privateKey, pub, auth };
}

async function hkdf(salt: Bytes, ikm: Bytes, info: Bytes, n: number): Promise<Bytes> {
  const k = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, k, n * 8));
}

/** RFC 8291 §3–4 from the receiving side, written apart from push.ts */
async function decrypt(body: Bytes, d: { priv: CryptoKey; pub: Bytes; auth: Bytes }): Promise<string> {
  const salt = body.slice(0, 16);
  const rs = new DataView(body.buffer, body.byteOffset + 16, 4).getUint32(0);
  const idlen = body[20]!;
  const asPub = body.slice(21, 21 + idlen);
  const ct = body.slice(21 + idlen);
  expect(rs).toBeGreaterThan(ct.length);
  const as = await crypto.subtle.importKey("raw", asPub, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: as }, d.priv, 256));
  const info = new Uint8Array([...enc.encode("WebPush: info\0"), ...d.pub, ...asPub]);
  const ikm = await hkdf(d.auth, ecdh, info, 32);
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, ct));
  expect(plain.at(-1)).toBe(2); // the last (only) record's delimiter
  return new TextDecoder().decode(plain.slice(0, -1));
}

// ───────────────────────────── a fake push service ─────────────────────────────

interface PushCall {
  url: string;
  headers: Headers;
  body: Bytes;
}

function pushService() {
  const calls: PushCall[] = [];
  /** per endpoint: the status it answers, or "throw" for a network error */
  const answer = new Map<string, number | "throw">();
  let hold: Promise<void> | null = null;
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, headers: new Headers(init?.headers), body: new Uint8Array(init!.body as Uint8Array) });
    if (hold) await hold;
    const a = answer.get(url) ?? 201;
    if (a === "throw") throw new TypeError("network down");
    return new Response(a === 201 ? null : "no", { status: a });
  }) as typeof fetch;
  return {
    calls,
    answer,
    fetch: fetchFn,
    holdUntil(p: Promise<void>) {
      hold = p;
    },
  };
}

// ───────────────────────────── world ─────────────────────────────

function tossVault(v: ReturnType<typeof makeFakeVault>): ReturnType<typeof makeFakeVault> {
  return {
    ...v,
    access(userId, o) {
      const a = v.access(userId, o);
      const use: CredentialAccess["use"] = (id, p, fn) => a.use(id, p, () => fn({ ...BOGUS_TOSS_SECRET }));
      return { ...a, use };
    },
  };
}

interface World {
  h: Harness;
  up: ReturnType<typeof makeInvestUpstream>;
  ps: ReturnType<typeof pushService>;
  uid: string;
  token: string;
  events: ServerEvent[];
  logs: string[];
}

const worlds: World[] = [];
afterEach(async () => {
  while (worlds.length) await worlds.pop()!.h.close();
});

async function world(o: { push?: boolean; toss?: boolean } = {}): Promise<World> {
  const up = makeInvestUpstream();
  const ps = pushService();
  const h = await makeHarness({
    now: ET(9, 0),
    config: {
      invest: { sources: true, tossBase: o.toss === false ? null : FAKE_TOSS_BASE, outboundIp: null },
      push: o.push === false ? null : { subject: SUBJECT },
    },
    deps: ({ vault }) => ({ investFetch: up.fetch, pushFetch: ps.fetch, vault: tossVault(vault) }),
  });
  const me = await h.signup("alice");
  const events: ServerEvent[] = [];
  const pub = h.app.core.events.publish.bind(h.app.core.events);
  h.app.core.events.publish = (u, e) => {
    if (u === me.session.user.id) events.push(e);
    pub(u, e);
  };
  const logs: string[] = [];
  const rec = (level: string) => (event: string, fields?: LogFields) => void logs.push(`${level} ${event} ${JSON.stringify(fields ?? {})}`);
  const logger: Logger = { info: rec("info"), warn: rec("warn"), error: rec("error") };
  h.app.core.log = logger;
  const w = { h, up, ps, uid: me.session.user.id, token: me.token, events, logs };
  worlds.push(w);
  return w;
}

const api = async <T = Record<string, unknown>>(w: World, method: string, path: string, body?: unknown, token = w.token): Promise<{ status: number; body: T }> => {
  const res = await w.h.req(method, path, { token, body });
  return { status: res.status, body: (await res.json()) as T };
};

async function connectToss(w: World): Promise<void> {
  const envelope = { v: 1, alg: "ECDH-P256+HKDF-SHA256+A256GCM", kid: "kid-test", epk: { kty: "EC" }, iv: "aXY", ct: "Y3Q", aad: `${w.uid}:toss-investment:token` };
  expect((await api(w, "POST", "/api/credentials", { service: "toss-investment", label: "토스증권", kind: "token", hint: "계좌 1개", keepFor: "forever", envelope })).status).toBe(201);
  await w.h.app.core.idle();
}

async function tickAt(w: World, h: number, m: number, day = DAY): Promise<void> {
  w.h.clock.t = ET(h, m, day);
  await w.h.app.core.invest.tick();
  await w.h.app.core.idle();
}

async function stopRule(w: World, symbol: string, price: number, action = "notify"): Promise<string> {
  expect([200, 201]).toContain((await api(w, "POST", "/api/invest/watchlist", { symbol })).status);
  const r = await api<{ id: string }>(w, "POST", "/api/invest/rules", { draft: { symbol, kind: "stop", price, action } });
  expect(r.status).toBe(201);
  return r.body.id;
}

const FCM = (n: number | string) => `https://fcm.googleapis.com/fcm/send/dev-${n}`;
const subs = (w: World) => w.h.db.sql.query("SELECT * FROM push_subscriptions ORDER BY created_at, id").all() as { user_id: string; endpoint: string; session_hash: string; last_status: number | null; last_ok_at: number | null }[];
const banners = (w: World) => w.events.filter((e): e is Extract<ServerEvent, { type: "notification" }> => e.type === "notification");

// ───────────────────────────── tests ─────────────────────────────

describe("push encryption", () => {
  test("RFC 8291 Appendix A: the same message from the same keys and salt", async () => {
    const asPub = unb64url("BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8");
    const jwk = (d: string, pub: Bytes) => ({ kty: "EC", crv: "P-256", d, x: b64url(pub.slice(1, 33)), y: b64url(pub.slice(33)), ext: true });
    const as = {
      privateKey: await crypto.subtle.importKey("jwk", jwk("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw", asPub), { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]),
      publicKey: await crypto.subtle.importKey("raw", asPub, { name: "ECDH", namedCurve: "P-256" }, true, []),
    } as CryptoKeyPair;
    const uaPub = unb64url("BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4");
    const auth = unb64url("BTBZMqHH6r4Tts7J_aSIgg");
    const out = await encryptPayload(enc.encode("When I grow up, I want to be a watermelon"), uaPub, auth, { as, salt: unb64url("DGv6ra1nlYgDCS1FRnbzlw") });
    expect(b64url(out)).toBe(
      "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
    );
    // and the receiving side of the same example reads it back
    const uaPriv = await crypto.subtle.importKey("jwk", jwk("q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94", uaPub), { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
    expect(await decrypt(out, { priv: uaPriv, pub: uaPub, auth })).toBe("When I grow up, I want to be a watermelon");
  });

  test("PICKLE_PUSH_SUBJECT: mailto: or https:, anything else is off", () => {
    expect(pushConfigFromEnv({})).toBeNull();
    expect(pushConfigFromEnv({ PICKLE_PUSH_SUBJECT: " mailto:ops@example.com " })).toEqual({ subject: "mailto:ops@example.com" });
    expect(pushConfigFromEnv({ PICKLE_PUSH_SUBJECT: "https://pickle.example.com" })).toEqual({ subject: "https://pickle.example.com/" });
    for (const bad of ["http://pickle.example.com", "mailto:ops", "ops@example.com", "https://u:p@pickle.example.com", "on"]) expect(pushConfigFromEnv({ PICKLE_PUSH_SUBJECT: bad })).toBeNull();
  });
});

describe("push subscriptions", () => {
  test("no PICKLE_PUSH_SUBJECT: the key and a new subscription answer 503 push_off, removal works; a row from before is kept and sent nothing", async () => {
    const w = await world({ push: false });
    const off = { status: 503, body: { error: "push_off" } };
    // team-lead 2331b (DD 2330): the app takes this as off and offers no lock-screen line; no reason words
    expect(await api(w, "GET", "/api/push/key")).toEqual(off);
    const d = await device(FCM(1));
    expect(await api(w, "POST", "/api/push/subscriptions", d.sub)).toEqual(off);
    expect(await api(w, "POST", "/api/push/subscriptions", { endpoint: "http://example.com/x" })).toEqual(off); // off comes first
    expect(subs(w)).toHaveLength(0);
    expect(existsSync(join(w.h.dir, "vapid.json"))).toBe(false); // no key pair made while off
    // a row from before (the subject taken out, the server restarted): kept, never sent to
    w.h.app.core.push.save({ userId: w.uid, tokenHash: sha256Hex(w.token), deviceId: null }, d.sub);
    expect(subs(w)).toHaveLength(1);
    await connectToss(w);
    await stopRule(w, "SOXL", 27);
    w.up.state.tossPrices.set("SOXL", { price: 27.5 });
    await tickAt(w, 9, 45);
    w.up.state.tossPrices.set("SOXL", { price: 26.9 });
    await tickAt(w, 9, 50);
    expect(banners(w).map((b) => b.title)).toContain("SOXL 손절 관찰가 도달");
    expect(w.ps.calls).toHaveLength(0);
    expect(subs(w)).toMatchObject([{ last_status: null, last_ok_at: null }]);
    expect(w.logs.filter((l) => l.includes("push"))).toEqual([]);
    // removing it works while off
    expect(await api(w, "DELETE", "/api/push/subscriptions", { endpoint: FCM(1) })).toEqual({ status: 200, body: { ok: true, removed: true } });
    expect(subs(w)).toHaveLength(0);
  });

  test("the key: a P-256 point, made once in the data dir (0600), the same after a restart; its private half never shown", async () => {
    const w = await world();
    const a = await api<{ publicKey: string }>(w, "GET", "/api/push/key");
    expect(a.status).toBe(200);
    const pk = unb64url(a.body.publicKey);
    expect(pk.length).toBe(65);
    expect(pk[0]).toBe(4);
    expect((await api<{ publicKey: string }>(w, "GET", "/api/push/key")).body.publicKey).toBe(a.body.publicKey);
    const file = join(w.h.dir, "vapid.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(await new PushHub(w.h.app.core).publicKey()).toBe(a.body.publicKey);
    const d = (JSON.parse(await Bun.file(file).text()) as { privateJwk: { d: string } }).privateJwk.d;
    expect(JSON.stringify(a.body)).not.toContain(d);
    expect(w.logs.join("\n")).not.toContain(d);
    expect(w.logs.some((l) => l.startsWith("info push keys made"))).toBe(true);
  });

  test("a subscription: push hosts only, real keys, the same endpoint moves, ten a person, removal is the owner's", async () => {
    const w = await world();
    const ok = await device(FCM("a"));
    for (const endpoint of ["http://fcm.googleapis.com/fcm/send/x", "https://evil.example/fcm/send/x", "https://fcm.googleapis.com:8443/x", "https://u:p@fcm.googleapis.com/x", "https://fcm.googleapis.com.evil.example/x", "https://127.0.0.1/x", "not a url", `https://fcm.googleapis.com/${"x".repeat(1100)}`]) {
      const r = await api(w, "POST", "/api/push/subscriptions", { ...ok.sub, endpoint });
      expect(r).toEqual({ status: 400, body: { error: "invalid_subscription", message: "이 기기로는 알림을 보낼 수 없어요" } });
    }
    const short = b64url(crypto.getRandomValues(new Uint8Array(64)));
    const notPoint = b64url(new Uint8Array(65).fill(5));
    for (const keys of [{ p256dh: short, auth: ok.sub.keys.auth }, { p256dh: notPoint, auth: ok.sub.keys.auth }, { p256dh: ok.sub.keys.p256dh, auth: b64url(new Uint8Array(15)) }, { p256dh: `${ok.sub.keys.p256dh}=`, auth: ok.sub.keys.auth }, {}]) {
      expect(await api(w, "POST", "/api/push/subscriptions", { endpoint: ok.sub.endpoint, keys })).toEqual({ status: 400, body: { error: "invalid_subscription", message: "이 기기로는 알림을 보낼 수 없어요" } });
    }
    expect(subs(w)).toHaveLength(0);
    for (const endpoint of [FCM("a"), "https://updates.push.services.mozilla.com/wpush/v2/x", "https://web.push.apple.com/QX", "https://wns2-par02p.notify.windows.com/w/?token=x"]) {
      expect(await api(w, "POST", "/api/push/subscriptions", { ...ok.sub, endpoint })).toEqual({ status: 200, body: { ok: true } });
    }
    expect(subs(w)).toHaveLength(4);
    // again from the same device: still one row
    expect((await api(w, "POST", "/api/push/subscriptions", ok.sub)).status).toBe(200);
    expect(subs(w).filter((s) => s.endpoint === FCM("a"))).toHaveLength(1);
    // another person signs in on that phone: the endpoint is theirs now
    const bob = await w.h.signup("bob");
    expect((await api(w, "POST", "/api/push/subscriptions", ok.sub, bob.token)).status).toBe(200);
    expect(subs(w).find((s) => s.endpoint === FCM("a"))!.user_id).toBe(bob.session.user.id);
    expect(await api(w, "DELETE", "/api/push/subscriptions", { endpoint: FCM("a") })).toEqual({ status: 200, body: { ok: true, removed: false } });
    expect(await api(w, "DELETE", "/api/push/subscriptions", { endpoint: FCM("a") }, bob.token)).toEqual({ status: 200, body: { ok: true, removed: true } });
    // the cap: the eleventh pushes out the oldest
    for (let i = 0; i < 9; i++) {
      w.h.clock.t += 1000;
      expect((await api(w, "POST", "/api/push/subscriptions", { ...ok.sub, endpoint: FCM(`n${i}`) })).status).toBe(200);
    }
    const mine = () => subs(w).filter((s) => s.user_id === w.uid).map((s) => s.endpoint);
    expect(mine()).toHaveLength(10);
    expect(mine()).not.toContain("https://updates.push.services.mozilla.com/wpush/v2/x");
    expect(mine()).toContain(FCM("n8"));
  });

  test("the session owns its subscription: signing out drops it, another session's stays; a password reset drops all", async () => {
    const w = await world();
    const phone = await device(FCM("phone"));
    expect((await api(w, "POST", "/api/push/subscriptions", phone.sub)).status).toBe(200);
    const login = await w.h.req("POST", "/api/auth/login", { ip: "10.9.9.9", body: { handle: "alice", password: "correct horse battery", device: await makeDevice() } });
    expect(login.status).toBe(200);
    const laptopToken = ((await login.json()) as { token: string }).token;
    const laptop = await device(FCM("laptop"));
    expect((await api(w, "POST", "/api/push/subscriptions", laptop.sub, laptopToken)).status).toBe(200);
    expect(subs(w).map((s) => s.endpoint).sort()).toEqual([FCM("laptop"), FCM("phone")]);
    expect((await w.h.req("POST", "/api/auth/logout", { token: w.token })).status).toBeLessThan(300);
    expect(subs(w).map((s) => s.endpoint)).toEqual([FCM("laptop")]);
    w.h.db.deleteUserSessions(w.uid);
    expect(subs(w)).toHaveLength(0);
  });
});

describe("push for invest alerts", () => {
  test("a stop alert: one encrypted push per device with the banner's title alone, VAPID signed for that push service", async () => {
    const w = await world();
    await connectToss(w);
    const phone = await device(FCM("phone"));
    const mac = await device("https://updates.push.services.mozilla.com/wpush/v2/mac");
    for (const d of [phone, mac]) expect((await api(w, "POST", "/api/push/subscriptions", d.sub)).status).toBe(200);
    const ruleId = await stopRule(w, "SOXL", 27);
    w.up.state.tossHoldings = [{ symbol: "SOXL", quantity: 10, averagePrice: 30 }];
    w.up.state.tossPrices.set("SOXL", { price: 27.5 });
    await tickAt(w, 9, 45);
    expect(w.ps.calls).toHaveLength(0);
    w.up.state.tossPrices.set("SOXL", { price: 26.9 });
    await tickAt(w, 9, 50);
    const banner = banners(w).at(-1)!;
    expect(banner).toMatchObject({ title: "SOXL 손절 관찰가 도달", body: "$26.90 · 손절선 $27.00 · 주문은 내지 않았어요" });
    expect(w.ps.calls.map((c) => c.url)).toEqual([FCM("phone"), "https://updates.push.services.mozilla.com/wpush/v2/mac"]);
    const keyB64 = (await api<{ publicKey: string }>(w, "GET", "/api/push/key")).body.publicKey;
    const vapidKey = await crypto.subtle.importKey("raw", unb64url(keyB64), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    for (const [i, d] of [phone, mac].entries()) {
      const c = w.ps.calls[i]!;
      expect(c.headers.get("content-encoding")).toBe("aes128gcm");
      expect(c.headers.get("ttl")).toBe("14400"); // DD: a lock-screen line may arrive up to 4 hours late, no later
      expect(c.headers.get("urgency")).toBe("high");
      const m = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(c.headers.get("authorization") ?? "");
      expect(m).not.toBeNull();
      const [, head, claims, sig, k] = m!;
      expect(k).toBe(keyB64);
      expect(JSON.parse(new TextDecoder().decode(unb64url(head!)))).toEqual({ typ: "JWT", alg: "ES256" });
      const cl = JSON.parse(new TextDecoder().decode(unb64url(claims!))) as { aud: string; exp: number; sub: string };
      expect(cl.aud).toBe(new URL(d.sub.endpoint).origin);
      expect(cl.sub).toBe(SUBJECT);
      const now = Math.floor(w.h.clock.t / 1000);
      expect(cl.exp).toBeGreaterThan(now);
      expect(cl.exp - now).toBeLessThanOrEqual(24 * 3600);
      expect(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, vapidKey, unb64url(sig!), enc.encode(`${head}.${claims}`))).toBe(true);
      const payload = JSON.parse(await decrypt(c.body, d)) as WebPushPayload;
      expect(payload).toEqual({ v: 1, title: "SOXL 손절 관찰가 도달", body: "", tag: `invest:${ruleId}`, threadId: banner.threadId!, messageId: banner.messageId! });
    }
    // nothing of the amounts reaches the push service, even encrypted: only these fields, and no amount in the words
    // (the ids are random base64url, so the words are checked, not the whole body: DD 2257)
    for (const c of w.ps.calls) {
      const p = JSON.parse(await decrypt(c.body, c.url === FCM("phone") ? phone : mac)) as WebPushPayload;
      expect(Object.keys(p).sort()).toEqual(["body", "messageId", "tag", "threadId", "title", "v"]);
      expect(`${p.title}\n${p.body}`).not.toMatch(/\$|26\.9|27|주|평단|손절선/);
    }
    expect(subs(w).every((s) => s.last_status === 201 && s.last_ok_at === w.h.clock.t)).toBe(true);
    expect(w.ps.calls.every((c) => PUSH_HOSTS.some((h) => new URL(c.url).hostname.endsWith(h)))).toBe(true);
  });

  test("lock-screen titles: mock stop record, skipped stop, expiry; blind is '시세 확인 멈춤' with no row", async () => {
    const w = await world();
    await connectToss(w);
    const phone = await device(FCM("phone"));
    expect((await api(w, "POST", "/api/push/subscriptions", phone.sub)).status).toBe(200);
    w.up.state.tossSellable.set("SOXL", 47);
    w.up.state.tossSellable.set("SOXS", 0);
    w.up.state.tossPrices.set("SOXL", { price: 27.5 });
    w.up.state.tossPrices.set("SOXS", { price: 11 });
    const soxl = await stopRule(w, "SOXL", 27, "sell");
    await stopRule(w, "SOXS", 10, "sell");
    expect([200, 201]).toContain((await api(w, "POST", "/api/invest/watchlist", { symbol: "TQQQ" })).status);
    w.up.state.tossPrices.set("TQQQ", { price: 80 });
    expect((await api(w, "POST", "/api/invest/rules", { draft: { symbol: "TQQQ", kind: "stop", price: 70, action: "notify", until: DAY } })).status).toBe(201);
    await tickAt(w, 9, 45);
    w.up.state.tossPrices.set("SOXL", { price: 26.8 });
    w.up.state.tossPrices.set("SOXS", { price: 9.5 });
    await tickAt(w, 9, 50);
    await tickAt(w, 16, 5);
    const got = await Promise.all(w.ps.calls.map(async (c) => JSON.parse(await decrypt(c.body, phone)) as WebPushPayload));
    expect(got.map((p) => p.title).sort()).toEqual(["SOXL 모의 손절 기록", "SOXS 손절 주문 건너뜀", "TQQQ 감시 기간 끝"]);
    expect(got.find((p) => p.title === "SOXL 모의 손절 기록")!.tag).toBe(`invest:${soxl}`);
    expect(got.every((p) => p.body === "" && p.threadId && p.messageId)).toBe(true);

    // blind: Toss gone and Yahoo resting, a live rule, 15 minutes of the session
    const b = await world({ toss: false });
    const bp = await device(FCM("b"));
    expect((await api(b, "POST", "/api/push/subscriptions", bp.sub)).status).toBe(200);
    await stopRule(b, "SOXL", 27);
    b.up.state.yahoo.set("SOXL", 429);
    for (const m of [45, 50, 55]) await tickAt(b, 9, m);
    expect(b.ps.calls).toHaveLength(0);
    await tickAt(b, 10, 0);
    await tickAt(b, 10, 5);
    expect(b.ps.calls).toHaveLength(1);
    expect(JSON.parse(await decrypt(b.ps.calls[0]!.body, bp))).toEqual({ v: 1, title: "시세 확인 멈춤", body: "", tag: "invest:blind" });
  });

  test("what the push service answers: 404/410 drop the device, 429/500/network keep it; endpoints never logged", async () => {
    const w = await world();
    await connectToss(w);
    const ds = await Promise.all(["gone", "missing", "busy", "down", "net", "ok"].map((n) => device(FCM(n))));
    for (const d of ds) expect((await api(w, "POST", "/api/push/subscriptions", d.sub)).status).toBe(200);
    // a row whose host is no longer allowed is dropped without a request
    w.h.db.sql.query("INSERT INTO push_subscriptions (id, user_id, session_hash, endpoint, p256dh, auth, created_at) SELECT 'ps_bad', user_id, token_hash, 'https://push.example.net/x', $p, $a, 0 FROM sessions WHERE user_id = $u").run({ u: w.uid, p: ds[0]!.sub.keys.p256dh, a: ds[0]!.sub.keys.auth });
    w.ps.answer.set(FCM("gone"), 410);
    w.ps.answer.set(FCM("missing"), 404);
    w.ps.answer.set(FCM("busy"), 429);
    w.ps.answer.set(FCM("down"), 500);
    w.ps.answer.set(FCM("net"), "throw");
    await stopRule(w, "SOXL", 27);
    w.up.state.tossPrices.set("SOXL", { price: 27.5 });
    await tickAt(w, 9, 45);
    w.up.state.tossPrices.set("SOXL", { price: 26.9 });
    await tickAt(w, 9, 50);
    expect(w.ps.calls.map((c) => c.url)).toEqual(ds.map((d) => d.sub.endpoint));
    const left = new Map(subs(w).map((s) => [s.endpoint, s.last_status]));
    expect([...left.keys()].sort()).toEqual([FCM("busy"), FCM("down"), FCM("net"), FCM("ok")]);
    expect([left.get(FCM("busy")), left.get(FCM("down")), left.get(FCM("net")), left.get(FCM("ok"))]).toEqual([429, 500, 0, 201]);
    const warns = w.logs.filter((l) => l.startsWith("warn push not taken"));
    expect(warns).toHaveLength(3);
    expect(w.logs.join("\n")).not.toMatch(/fcm\.googleapis|push\.example|p256dh|auth"/);
    // the next alert tries the kept ones again, once each (no retry inside one push)
    w.up.state.tossPrices.set("SOXL", { price: 27.3 });
    await tickAt(w, 9, 55);
    w.up.state.tossPrices.set("SOXL", { price: 26.8 });
    await tickAt(w, 10, 0);
    expect(w.ps.calls.slice(ds.length).map((c) => c.url)).toEqual([FCM("busy"), FCM("down"), FCM("net"), FCM("ok")]);
  });

  test("a slow push service never holds the watch: the tick ends first, the push lands after", async () => {
    const w = await world();
    await connectToss(w);
    const d = await device(FCM("slow"));
    expect((await api(w, "POST", "/api/push/subscriptions", d.sub)).status).toBe(200);
    await stopRule(w, "SOXL", 27);
    w.up.state.tossPrices.set("SOXL", { price: 27.5 });
    await tickAt(w, 9, 45);
    let release!: () => void;
    w.ps.holdUntil(new Promise<void>((r) => (release = r)));
    w.up.state.tossPrices.set("SOXL", { price: 26.9 });
    w.h.clock.t = ET(9, 50);
    try {
      expect(await w.h.app.core.invest.tick()).toEqual({ slots: 1, alerts: 1 });
      expect(banners(w).at(-1)!.title).toBe("SOXL 손절 관찰가 도달");
      for (let i = 0; i < 200 && !w.ps.calls.length; i++) await Bun.sleep(5);
      expect(w.ps.calls).toHaveLength(1); // asked, and still waiting for an answer
      expect(subs(w)[0]!.last_status).toBeNull();
    } finally {
      release();
    }
    await w.h.app.core.idle();
    expect(subs(w)[0]!.last_status).toBe(201);
    expect(idb.getSettings(w.h.db, w.uid)!.thread_id).toBe(banners(w).at(-1)!.threadId!);
  });
});
