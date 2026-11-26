/**
 * Lock-screen notifications (Web Push, B1c; lead 2045-9). The server side is agent-runtime's (SERVER-CONTRACT
 * "Web Push (B1c)"); the worker is `public/sw.js`.
 *
 * - `syncPush()` subscribes this device and sends the subscription to the server. It runs only once notification
 *   permission is granted. The app calls it on every start with a session, when the permission turns granted, and when
 *   the worker reports a replaced subscription. Screens that ask for the permission may call it too (it returns the
 *   state). Calls while one runs share it.
 * - A tap on a notification opens its target: in a running app through a worker message, otherwise through
 *   `/?open=…` on start (`readOpenTarget`), which is removed from the address at once.
 * - Nothing here asks for the permission and nothing is requested before it is granted. `pushAskable()` says whether a
 *   screen may offer to (DD 2330: the notification settings card and the invest screen's paper use the same rule).
 */
import { ApiError, apiGet, apiPost } from "../api/client";
import { getScreen, nav } from "./nav";

export type PushState = "unsupported" | "no_permission" | "off" | "subscribed" | "invalid" | "error";

export const SW_URL = "/sw.js";
export const PUSH_KEY_PATH = "/api/push/key";
export const PUSH_SUBSCRIPTIONS_PATH = "/api/push/subscriptions";
/** worker → app messages (public/sw.js) */
export const MSG_OPEN = "pickle:open";
export const MSG_RESUBSCRIBED = "pickle:push-resubscribed";

/** base64url (no padding) → bytes; null when it is not base64url */
export function keyBytes(b64url: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]+$/.test(b64url) || b64url.length % 4 === 1) return null;
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** a VAPID public key: an uncompressed P-256 point, 65 bytes starting with 0x04 */
export const isVapidKey = (k: Uint8Array | null): k is Uint8Array<ArrayBuffer> => !!k && k.length === 65 && k[0] === 4;

function sameBytes(a: ArrayBuffer | null | undefined, b: Uint8Array): boolean {
  if (!a || a.byteLength !== b.length) return false;
  const x = new Uint8Array(a);
  return x.every((v, i) => v === b[i]);
}

interface Sub {
  options: { applicationServerKey: ArrayBuffer | null };
  toJSON(): unknown;
  unsubscribe(): Promise<boolean>;
}

/** what syncPush touches, so tests can stand in for the browser */
export interface PushDeps {
  supported(): boolean;
  permission(): NotificationPermission;
  getKey(): Promise<{ publicKey: string }>;
  /** register the worker and resolve with its push manager once a worker is active */
  pushManager(): Promise<{
    getSubscription(): Promise<Sub | null>;
    subscribe(o: { userVisibleOnly: true; applicationServerKey: Uint8Array<ArrayBuffer> }): Promise<Sub>;
  }>;
  post(body: unknown): Promise<unknown>;
}

export const browserPush: PushDeps = {
  supported: () =>
    typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window,
  permission: () => Notification.permission,
  getKey: () => apiGet<{ publicKey: string }>(PUSH_KEY_PATH),
  pushManager: async () => {
    await navigator.serviceWorker.register(SW_URL, { scope: "/" });
    return (await navigator.serviceWorker.ready).pushManager;
  },
  post: (body) => apiPost(PUSH_SUBSCRIPTIONS_PATH, body),
};

const status = (e: unknown) => (e instanceof ApiError ? e.status : 0);

export async function runPushSync(deps: PushDeps): Promise<PushState> {
  if (!deps.supported()) return "unsupported";
  if (deps.permission() !== "granted") return "no_permission";
  let publicKey: string;
  try {
    ({ publicKey } = await deps.getKey());
  } catch (e) {
    // 503 push_off: the server sends nothing; 404: a server without the routes
    return status(e) === 503 || status(e) === 404 ? "off" : "error";
  }
  const key = keyBytes(typeof publicKey === "string" ? publicKey : "");
  if (!isVapidKey(key)) return "error";
  let sub: Sub | null;
  try {
    const pm = await deps.pushManager();
    sub = await pm.getSubscription();
    // a subscription made for another server key cannot receive this server's pushes
    if (sub && !sameBytes(sub.options.applicationServerKey, key)) {
      await sub.unsubscribe().catch(() => false);
      sub = null;
    }
    sub ??= await pm.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  } catch {
    return "error";
  }
  try {
    await deps.post(sub.toJSON());
  } catch (e) {
    return status(e) === 400 ? "invalid" : status(e) === 503 ? "off" : "error";
  }
  return "subscribed";
}

/**
 * Whether a screen may offer to turn lock-screen notifications on (DD 2330, DD 2334): this device can take Web Push
 * (on iOS only an app added to the home screen; a Safari tab has no PushManager), the permission was never answered,
 * and the server gives its key, so nothing is offered while the server sends nothing (key 503 push_off, lead 2331b) or
 * 404, or cannot be reached. The key is asked for only once the first two hold.
 */
export async function pushAskable(deps: Pick<PushDeps, "supported" | "permission" | "getKey"> = browserPush): Promise<boolean> {
  if (!deps.supported() || deps.permission() !== "default") return false;
  try {
    const { publicKey } = await deps.getKey();
    return isVapidKey(keyBytes(typeof publicKey === "string" ? publicKey : ""));
  } catch {
    return false;
  }
}

let running: Promise<PushState> | null = null;
export function syncPush(deps: PushDeps = browserPush): Promise<PushState> {
  return (running ??= runPushSync(deps).finally(() => {
    running = null;
  }));
}

// ───────────────────────────── opening a tapped notification ─────────────────────────────

export type PushTarget = { threadId: string; messageId?: string } | { invest: true };

const OPEN_KEYS = ["open", "thread", "message"];

/** `?open=thread&thread=…[&message=…]` or `?open=invest` (written by public/sw.js), else null */
export function readOpenTarget(search: string): PushTarget | null {
  const q = new URLSearchParams(search);
  const open = q.get("open");
  if (open === "invest") return { invest: true };
  const threadId = q.get("thread");
  if (open !== "thread" || !threadId) return null;
  const messageId = q.get("message");
  return messageId ? { threadId, messageId } : { threadId };
}

/** the search string without the open keys (other keys stay in their order) */
export function withoutOpenKeys(search: string): string {
  const q = new URLSearchParams(search);
  for (const k of OPEN_KEYS) q.delete(k);
  const s = q.toString();
  return s ? `?${s}` : "";
}

/** a worker message → a target, or null (anything else) */
export function messageTarget(data: unknown): PushTarget | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (d.type !== MSG_OPEN) return null;
  if (typeof d.threadId === "string" && d.threadId) {
    return typeof d.messageId === "string" && d.messageId ? { threadId: d.threadId, messageId: d.messageId } : { threadId: d.threadId };
  }
  return d.invest === true ? { invest: true } : null;
}

/** the thread on the chat tab (not pushed again when it is already on top); the investment screen on 나의 모시 */
export function openTarget(t: PushTarget): void {
  if ("threadId" in t) {
    nav.setTab("chat");
    const top = nav.current();
    if (top?.screen === "thread" && top.params?.threadId === t.threadId) return;
    nav.push("thread", t.messageId ? { threadId: t.threadId, messageId: t.messageId } : { threadId: t.threadId });
    return;
  }
  nav.setTab("profile");
  if (!getScreen("invest") || nav.current()?.screen === "invest") return;
  nav.push("invest", undefined, { title: "투자" });
}

/**
 * Wire the worker messages and the permission change. Returns the cleanup. Call once from the app shell; it does not
 * subscribe by itself (the shell calls syncPush when a session is ready).
 */
export function listenPush(onTarget: (t: PushTarget) => void): () => void {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return () => {};
  const onMessage = (e: MessageEvent) => {
    if ((e.data as { type?: unknown } | null)?.type === MSG_RESUBSCRIBED) {
      void syncPush();
      return;
    }
    const t = messageTarget(e.data);
    if (t) onTarget(t);
  };
  navigator.serviceWorker.addEventListener("message", onMessage);
  navigator.serviceWorker.startMessages();
  let perm: PermissionStatus | null = null;
  let gone = false;
  const onPerm = () => {
    if (perm?.state === "granted") void syncPush();
  };
  navigator.permissions
    ?.query({ name: "notifications" })
    .then((p) => {
      if (gone) return;
      perm = p;
      p.addEventListener("change", onPerm);
    })
    .catch(() => {});
  return () => {
    gone = true;
    navigator.serviceWorker.removeEventListener("message", onMessage);
    perm?.removeEventListener("change", onPerm);
  };
}
