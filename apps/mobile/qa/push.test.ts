/**
 * Lock-screen notifications (B1c): public/sw.js run against a stand-in worker scope, and app/push.ts against stand-in
 * browser parts. No network, no real push service.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ApiError } from "../src/api/client";
import {
  isVapidKey,
  keyBytes,
  messageTarget,
  MSG_OPEN,
  type PushDeps,
  readOpenTarget,
  runPushSync,
  syncPush,
  withoutOpenKeys,
} from "../src/app/push";

const SW = readFileSync(join(import.meta.dir, "../public/sw.js"), "utf8");

interface FakeClient {
  focused: boolean;
  visibilityState: "visible" | "hidden";
  sent: unknown[];
  focusedCalls: number;
  postMessage(m: unknown): void;
  focus(): Promise<FakeClient>;
}
const client = (focused: boolean, visible = focused): FakeClient => ({
  focused,
  visibilityState: visible ? "visible" : "hidden",
  sent: [],
  focusedCalls: 0,
  postMessage(m) {
    this.sent.push(m);
  },
  focus() {
    this.focusedCalls++;
    return Promise.resolve(this);
  },
});

/** run sw.js in a scope with recorded side effects; `fire` dispatches an event and waits for its waitUntil */
function worker(windows: FakeClient[] = []) {
  const handlers = new Map<string, (e: unknown) => void>();
  const shown: { title: string; options: Record<string, unknown> }[] = [];
  const opened: string[] = [];
  const subscribed: unknown[] = [];
  const self = {
    addEventListener: (type: string, fn: (e: unknown) => void) => {
      expect(handlers.has(type)).toBe(false);
      handlers.set(type, fn);
    },
    skipWaiting: () => Promise.resolve(),
    clients: {
      claim: () => Promise.resolve(),
      matchAll: (o: unknown) => {
        expect(o).toEqual({ type: "window", includeUncontrolled: true });
        return Promise.resolve(windows);
      },
      openWindow: (url: string) => {
        opened.push(url);
        return Promise.resolve(null);
      },
    },
    registration: {
      showNotification: (title: string, options: Record<string, unknown>) => {
        shown.push({ title, options });
        return Promise.resolve();
      },
      pushManager: {
        subscribe: (o: unknown) => {
          subscribed.push(o);
          return Promise.resolve({});
        },
      },
    },
  };
  new Function("self", SW)(self);
  const fire = async (type: string, e: Record<string, unknown>) => {
    let wait: Promise<unknown> = Promise.resolve();
    handlers.get(type)!({ ...e, waitUntil: (p: Promise<unknown>) => (wait = p) });
    await wait;
  };
  return { handlers, shown, opened, subscribed, fire };
}

const data = (v: unknown) => ({
  json: () => {
    if (typeof v === "string") return JSON.parse(v);
    return v;
  },
});
const notification = (tag: string, d: unknown) => {
  const n = { tag, data: d, closed: 0, close: () => n.closed++ };
  return n;
};

describe("public/sw.js", () => {
  test("listens to install, activate, push, notificationclick and pushsubscriptionchange, and never to fetch", () => {
    const w = worker();
    expect([...w.handlers.keys()].sort()).toEqual(["activate", "install", "notificationclick", "push", "pushsubscriptionchange"]);
  });

  test("a push shows its title with an empty body, whatever body arrives (DD 2042-b §4)", async () => {
    const w = worker();
    const p = { v: 1, title: "SOXL 손절 관찰가 도달", body: "189,400원 · 12주", tag: "invest:r1", threadId: "t1", messageId: "m1" };
    await w.fire("push", { data: data(p) });
    expect(w.shown).toEqual([
      {
        title: "SOXL 손절 관찰가 도달",
        options: { body: "", tag: "invest:r1", data: { threadId: "t1", messageId: "m1" }, lang: "ko", renotify: true },
      },
    ]);
  });

  test("a push that is not a v1 payload still shows exactly one notification (userVisibleOnly)", async () => {
    const bad = [null, data("{not json"), data({ v: 2, title: "x", tag: "t" }), data({ v: 1, title: "  ", tag: "t" }), data({ v: 1, title: "x" }), data([1])];
    for (const d of bad) {
      const w = worker();
      await w.fire("push", { data: d });
      expect(w.shown).toEqual([{ title: "모시에서 알림이 왔어요", options: { body: "", tag: "pickle:other", data: {}, lang: "ko", renotify: true } }]);
    }
  });

  test("ids that are not strings are dropped; blind has no thread", async () => {
    const w = worker();
    await w.fire("push", { data: data({ v: 1, title: "시세 확인 멈춤", body: "", tag: "invest:blind", threadId: 7, messageId: "" }) });
    expect(w.shown[0]!.options.data).toEqual({ threadId: undefined, messageId: undefined });
  });

  test("with the app on screen the copy still shows, with its sound, and alerts again for the same tag (DD 2257)", async () => {
    const w = worker([client(true)]);
    await w.fire("push", { data: data({ v: 1, title: "SOXL 손절 관찰가 도달", body: "", tag: "invest:r2" }) });
    await w.fire("push", { data: data({ v: 1, title: "SOXL 모의 손절 기록", body: "", tag: "invest:r2" }) });
    expect(w.shown.map((n) => [n.title, n.options.tag, n.options.silent, n.options.renotify])).toEqual([
      ["SOXL 손절 관찰가 도달", "invest:r2", undefined, true],
      ["SOXL 모의 손절 기록", "invest:r2", undefined, true],
    ]);
  });

  test("a tap with the app running: closes, messages the focused window, focuses it, opens nothing", async () => {
    const a = client(false);
    const b = client(true);
    const w = worker([a, b]);
    const n = notification("invest:r1", { threadId: "t1", messageId: "m1" });
    await w.fire("notificationclick", { notification: n });
    expect(n.closed).toBe(1);
    expect(b.sent).toEqual([{ type: MSG_OPEN, threadId: "t1", messageId: "m1", invest: false }]);
    expect([a.sent.length, b.focusedCalls, w.opened.length]).toEqual([0, 1, 0]);
  });

  test("a tap on blind with the app running asks for the investment screen; with no focused window the first one is used", async () => {
    const a = client(false, false);
    const w = worker([a]);
    await w.fire("notificationclick", { notification: notification("invest:blind", {}) });
    expect(a.sent).toEqual([{ type: MSG_OPEN, threadId: undefined, messageId: undefined, invest: true }]);
  });

  test("a tap with no app running opens /?open=…: the thread (ids encoded), the investment screen, or the app", async () => {
    // tag, notification data, the address opened, what the app reads back from it
    const cases: [string, unknown, string, unknown][] = [
      ["invest:r1", { threadId: "t1", messageId: "m1" }, "/?open=thread&thread=t1&message=m1", { threadId: "t1", messageId: "m1" }],
      ["invest:r1", { threadId: "a&b=c d" }, "/?open=thread&thread=a%26b%3Dc+d", { threadId: "a&b=c d" }],
      ["invest:blind", {}, "/?open=invest", { invest: true }],
      ["pickle:other", {}, "/", null],
      ["pickle:other", null, "/", null],
    ];
    for (const [tag, d, url, back] of cases) {
      const w = worker();
      await w.fire("notificationclick", { notification: notification(tag, d) });
      expect(w.opened).toEqual([url]);
      expect(readOpenTarget(url.slice(1))).toEqual(back);
    }
  });

  test("a replaced subscription: subscribe again with the old key, then tell every window", async () => {
    const a = client(true);
    const b = client(false, false);
    const w = worker([a, b]);
    const key = new Uint8Array([4, 1, 2]).buffer;
    await w.fire("pushsubscriptionchange", { oldSubscription: { options: { applicationServerKey: key } } });
    expect(w.subscribed).toEqual([{ userVisibleOnly: true, applicationServerKey: key }]);
    expect([a.sent, b.sent]).toEqual([[{ type: "pickle:push-resubscribed" }], [{ type: "pickle:push-resubscribed" }]]);
    const none = worker([a]);
    await none.fire("pushsubscriptionchange", {});
    expect(none.subscribed).toEqual([]);
    expect(a.sent.length).toBe(2);
  });
});

describe("app/push.ts · opening", () => {
  test("readOpenTarget: thread (with or without message), invest, anything else null", () => {
    expect(readOpenTarget("?open=thread&thread=t1&message=m1")).toEqual({ threadId: "t1", messageId: "m1" });
    expect(readOpenTarget("?open=thread&thread=t1")).toEqual({ threadId: "t1" });
    expect(readOpenTarget("?open=invest")).toEqual({ invest: true });
    for (const s of ["", "?open=thread", "?thread=t1", "?open=other&thread=t1", "?gallery=1"]) expect(readOpenTarget(s)).toBeNull();
  });
  test("withoutOpenKeys keeps the other keys in order", () => {
    expect(withoutOpenKeys("?a=1&open=thread&thread=t1&b=2&message=m1")).toBe("?a=1&b=2");
    expect(withoutOpenKeys("?open=invest")).toBe("");
    expect(withoutOpenKeys("")).toBe("");
  });
  test("messageTarget takes only the worker's open message", () => {
    expect(messageTarget({ type: MSG_OPEN, threadId: "t1", messageId: "m1", invest: false })).toEqual({ threadId: "t1", messageId: "m1" });
    expect(messageTarget({ type: MSG_OPEN, threadId: "t1", messageId: "" })).toEqual({ threadId: "t1" });
    expect(messageTarget({ type: MSG_OPEN, invest: true })).toEqual({ invest: true });
    for (const d of [null, "x", { type: "other", threadId: "t1" }, { type: MSG_OPEN }, { type: MSG_OPEN, invest: "yes" }]) expect(messageTarget(d)).toBeNull();
  });
});

// ───────────────────────────── syncPush ─────────────────────────────

const KEY = "BAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8gISIjJCUmJygpKissLS4vMDEyMzQ1Njc4OTo7PD0-P0A";
const keyBuf = () => keyBytes(KEY)!.buffer;

function deps(over: Partial<PushDeps> & { existing?: ArrayBuffer | null } = {}) {
  const log: string[] = [];
  const sub = (k: ArrayBuffer | null, name: string) => ({
    options: { applicationServerKey: k },
    toJSON: () => ({ endpoint: `https://fcm.googleapis.com/fcm/send/${name}`, keys: { p256dh: "p", auth: "a" } }),
    unsubscribe: () => {
      log.push(`unsubscribe ${name}`);
      return Promise.resolve(true);
    },
  });
  const d: PushDeps = {
    supported: () => true,
    permission: () => "granted",
    getKey: () => {
      log.push("key");
      return Promise.resolve({ publicKey: KEY });
    },
    pushManager: () => {
      log.push("register");
      return Promise.resolve({
        getSubscription: () => Promise.resolve(over.existing === undefined ? null : sub(over.existing, "old")),
        subscribe: (o) => {
          log.push(`subscribe ${o.userVisibleOnly} ${o.applicationServerKey.length}`);
          return Promise.resolve(sub(o.applicationServerKey.buffer, "new"));
        },
      });
    },
    post: (b) => {
      log.push(`post ${(b as { endpoint: string }).endpoint.split("/").pop()}`);
      return Promise.resolve({ ok: true });
    },
    ...over,
  };
  return { d, log };
}

describe("app/push.ts · syncPush", () => {
  test("keyBytes / isVapidKey: base64url without padding, 65 bytes from 0x04", () => {
    const k = keyBytes(KEY)!;
    expect([k.length, k[0], k[1], k[64]]).toEqual([65, 4, 1, 64]);
    expect(isVapidKey(k)).toBe(true);
    expect(isVapidKey(keyBytes("BAEC"))).toBe(false);
    expect(keyBytes("a+b/")).toBeNull();
    expect(keyBytes("abcde")).toBeNull();
    expect(isVapidKey(keyBytes(KEY.replace(/^BA/, "BQ")))).toBe(false);
  });
  test("nothing is asked or requested before the permission is granted, or where push is missing", async () => {
    for (const p of ["default", "denied"] as const) {
      const { d, log } = deps({ permission: () => p });
      expect(await runPushSync(d)).toBe("no_permission");
      expect(log).toEqual([]);
    }
    const { d, log } = deps({ supported: () => false });
    expect(await runPushSync(d)).toBe("unsupported");
    expect(log).toEqual([]);
  });
  test("no subscription yet: key → register → subscribe (userVisibleOnly, 65-byte key) → post", async () => {
    const { d, log } = deps();
    expect(await runPushSync(d)).toBe("subscribed");
    expect(log).toEqual(["key", "register", "subscribe true 65", "post new"]);
  });
  test("the same key: the existing subscription is sent again, nothing new is made", async () => {
    const { d, log } = deps({ existing: keyBuf() });
    expect(await runPushSync(d)).toBe("subscribed");
    expect(log).toEqual(["key", "register", "post old"]);
  });
  test("another key (or none recorded): unsubscribe, subscribe with this server's key", async () => {
    for (const k of [new Uint8Array(65).fill(4).buffer, null]) {
      const { d, log } = deps({ existing: k });
      expect(await runPushSync(d)).toBe("subscribed");
      expect(log).toEqual(["key", "register", "unsubscribe old", "subscribe true 65", "post new"]);
    }
  });
  test("server answers: 503 push_off and 404 → off before registering; a bad key → error; 400 on post → invalid", async () => {
    for (const [st, want] of [[503, "off"], [404, "off"], [500, "error"]] as const) {
      const { d, log } = deps({ getKey: () => Promise.reject(new ApiError(st, "x", "x")) });
      expect(await runPushSync(d)).toBe(want);
      expect(log).toEqual([]);
    }
    const bad = deps({ getKey: () => Promise.resolve({ publicKey: "BAEC" }) });
    expect(await runPushSync(bad.d)).toBe("error");
    expect(bad.log).toEqual([]);
    for (const [st, want] of [[400, "invalid"], [503, "off"], [500, "error"]] as const) {
      const { d } = deps({ post: () => Promise.reject(new ApiError(st, "x", "x")) });
      expect(await runPushSync(d)).toBe(want);
    }
  });
  test("a browser that refuses to subscribe → error, nothing posted", async () => {
    const { d, log } = deps();
    const pm = d.pushManager;
    d.pushManager = async () => ({ ...(await pm()), subscribe: () => Promise.reject(new Error("NotAllowedError")) });
    expect(await runPushSync(d)).toBe("error");
    expect(log.some((l) => l.startsWith("post"))).toBe(false);
  });
  test("calls while one runs share it", async () => {
    const { d, log } = deps();
    const [a, b] = [syncPush(d), syncPush(d)];
    expect(a).toBe(b);
    expect(await a).toBe("subscribed");
    expect(log.filter((l) => l === "key").length).toBe(1);
    await syncPush(d);
    expect(log.filter((l) => l === "key").length).toBe(2);
  });
});
