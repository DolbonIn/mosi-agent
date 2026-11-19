/**
 * Slack's Web API for the user session (xoxc token + d cookie): auth.test (login), listing, reading and sending, all
 * with plain fetch instead of agent-messenger's WebClient. That client waits out every 429 by itself (Retry-After 30 s,
 * for up to about 30 min) and paged conversations.list, a Tier 2 method, so a busy workspace hung msg_read past its turn.
 *
 * Here:
 * - every call has a deadline (`callMs`) and follows the caller's AbortSignal; closing the session aborts what is left;
 * - a 429 fails fast with `rate_limited` (seconds from Retry-After) and starts a cooldown for that method in this
 *   session, during which calls to it fail fast without reaching Slack; one quiet retry only when Retry-After ≤ 3 s
 *   and the deadline allows; nothing retries in the background;
 * - the chat list (users.conversations, at most 5 pages) is fetched once for concurrent callers and kept for 5 min;
 *   names come from users.info per user id, kept for the session (never users.list).
 *
 * The token and cookie go only to `api` (https://slack.com/api; a local fake in tests). Nothing here logs, and error
 * messages carry a Slack method and error code at most — never a secret or message text.
 */
import type { MessengerChat } from "@pickle/protocol";
import { MessengerError } from "../errors";
import { finishMessages, toMillis, type ChatMessage, type RawMessage, type RoomInfo, type ThreadRead } from "../util";

/** per-call deadline (the 429 quiet retry included) */
export const SLACK_CALL_MS = 10_000;
/** how long a fetched chat list is reused */
export const SLACK_LIST_TTL_MS = 5 * 60_000;
const LIST_PAGES = 5;
const PAGE_SIZE = 200;
/** Retry-After at most this many seconds gets one quiet retry */
const QUIET_RETRY_S = 3;
/** users.info lookups one listing/read may start, how many at once, and how long names may hold the answer up */
const NAME_LOOKUPS = 60;
const NAME_PARALLEL = 6;
const NAME_MS = 4_000;
/** Retry-After when Slack sends none */
const DEFAULT_RETRY_S = 30;

type Json = Record<string, unknown>;
type Params = Record<string, string | number | boolean | undefined>;

interface SlackConversation {
  id?: unknown;
  name?: unknown;
  is_channel?: unknown;
  is_group?: unknown;
  is_im?: unknown;
  is_mpim?: unknown;
  is_archived?: unknown;
  is_user_deleted?: unknown;
  user?: unknown;
}

interface SlackHistoryMessage {
  ts?: unknown;
  text?: unknown;
  user?: unknown;
  username?: unknown;
  subtype?: unknown;
  bot_profile?: { name?: unknown } | null;
  user_profile?: { real_name?: unknown; display_name?: unknown; name?: unknown } | null;
}

export interface SlackWebOptions {
  /** Web API base, e.g. https://slack.com/api */
  api: string;
  token: string;
  cookie: string;
  /** the signed-in Slack user (connection meta from the login); else auth.test once, when a read needs it */
  userId?: string | null;
  callMs?: number;
  listTtlMs?: number;
  now?: () => number;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

function rateLimited(seconds: number): MessengerError {
  return new MessengerError("rate_limited", `슬랙이 요청을 잠시 막았어요. ${seconds}초 뒤에 다시 시도해 주세요.`, { retryAfter: seconds });
}

/** a Slack `{ ok: false, error }` (or HTTP failure): `code` drives the hub's mapping (invalid_auth, channel_not_found, …) */
function apiError(method: string, code: string, status?: number): Error {
  return Object.assign(new Error(`slack ${method}: ${code}`), { name: "SlackApiError", code, ...(status ? { status } : {}) });
}

function retryAfterOf(res: Response): number {
  const n = Number.parseInt(res.headers.get("retry-after") ?? "", 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 3600) : DEFAULT_RETRY_S;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortReason(signal));
    const onAbort = () => {
      clearTimeout(t);
      reject(abortReason(signal));
    };
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** "mpdm-minji--junho--haneul-1" → "minji, junho, haneul" */
function mpimName(raw: string): string {
  const names = raw.replace(/^mpdm-/, "").replace(/-\d+$/, "").split("--").filter(Boolean);
  return names.length ? names.join(", ") : "그룹 DM";
}

const SYSTEM_SUBTYPES = new Set([
  "channel_join",
  "channel_leave",
  "channel_topic",
  "channel_purpose",
  "channel_name",
  "channel_archive",
  "channel_unarchive",
  "group_join",
  "group_leave",
  "group_topic",
  "group_purpose",
  "group_name",
  "pinned_item",
  "unpinned_item",
]);

/**
 * One shared run for concurrent callers. Each caller may give up (its signal); the run itself is aborted only once
 * every caller has given up, so an abandoned listing leaves no request behind.
 */
class Flight<T> {
  private cur: { p: Promise<T>; ctrl: AbortController; waiters: number } | null = null;
  constructor(private readonly start: (signal: AbortSignal) => Promise<T>) {}

  join(signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    let f = this.cur;
    if (!f) {
      const ctrl = new AbortController();
      const p = Promise.resolve().then(() => this.start(ctrl.signal));
      const flight = { p, ctrl, waiters: 0 };
      this.cur = f = flight;
      p.then(
        () => {},
        () => {},
      ).finally(() => {
        if (this.cur === flight) this.cur = null;
      });
    }
    const flight = f;
    if (!signal) {
      flight.waiters = Number.POSITIVE_INFINITY; // a caller that cannot give up keeps the run alive
      return flight.p;
    }
    flight.waiters++;
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => {
        flight.waiters--;
        if (flight.waiters <= 0) {
          if (this.cur === flight) this.cur = null;
          flight.ctrl.abort(abortReason(signal));
        }
        reject(abortReason(signal));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      flight.p.then(
        (v) => {
          signal.removeEventListener("abort", onAbort);
          resolve(v);
        },
        (e) => {
          signal.removeEventListener("abort", onAbort);
          reject(e);
        },
      );
    });
  }

  abort(): void {
    const f = this.cur;
    this.cur = null;
    f?.ctrl.abort(new DOMException("The session was closed.", "AbortError"));
  }
}

export class SlackWeb {
  private readonly api: string;
  private readonly token: string;
  private readonly cookie: string;
  private readonly callMs: number;
  private readonly listTtlMs: number;
  private readonly now: () => number;
  /** method → epoch ms until which it is not called (Slack's Retry-After) */
  private readonly cooldown = new Map<string, number>();
  private readonly inflight = new Set<AbortController>();
  private chats: { at: number; list: MessengerChat[] } | null = null;
  private readonly listing: Flight<MessengerChat[]>;
  /** rooms named one by one (conversations.info), for the session */
  private readonly infos = new Map<string, MessengerChat>();
  /** user id → display name (null: Slack had no usable name) */
  private readonly names = new Map<string, string | null>();
  private readonly naming = new Map<string, Promise<void>>();
  private me: string | null;
  private readonly whoami: Flight<string | null>;
  private closed = false;

  constructor(o: SlackWebOptions) {
    this.api = o.api.replace(/\/+$/, "");
    this.token = o.token;
    this.cookie = o.cookie;
    this.callMs = o.callMs ?? SLACK_CALL_MS;
    this.listTtlMs = o.listTtlMs ?? SLACK_LIST_TTL_MS;
    this.now = o.now ?? Date.now;
    this.me = o.userId || null;
    this.listing = new Flight((signal) => this.fetchChats(signal));
    this.whoami = new Flight(async (signal) => (await this.authTest(signal)).user_id || null);
  }

  /** auth.test: whom the session belongs to (the login validates the session with it) */
  async authTest(signal?: AbortSignal): Promise<{ user_id: string; team_id: string; user?: string; team?: string }> {
    const r = await this.call("auth.test", {}, signal);
    const out: { user_id: string; team_id: string; user?: string; team?: string } = { user_id: str(r.user_id), team_id: str(r.team_id) };
    if (str(r.user)) out.user = str(r.user);
    if (str(r.team)) out.team = str(r.team);
    if (out.user_id) this.me = out.user_id;
    return out;
  }

  /** chat.postMessage as the user. A 429 fails fast like every call (nothing was posted then). */
  async postMessage(channel: string, text: string, signal?: AbortSignal): Promise<{ ts: string }> {
    const r = await this.call("chat.postMessage", { channel, text }, signal);
    return { ts: str(r.ts) };
  }

  /** Channels, group DMs and DMs (channels first), from the session's list when it is younger than the TTL. */
  async listChats(signal?: AbortSignal): Promise<MessengerChat[]> {
    const hit = this.chats;
    if (hit && this.now() - hit.at < this.listTtlMs) return hit.list;
    try {
      this.checkCooldown("users.conversations");
      return await this.listing.join(signal);
    } catch (e) {
      // an older list beats none while Slack is limiting or slow (a caller that gave up still gets its abort)
      if (hit && !signal?.aborted && e instanceof MessengerError && (e.code === "rate_limited" || e.code === "network")) return hit.list;
      throw e;
    }
  }

  /** The newest `limit` messages (oldest → newest) plus what the session knows about the room. */
  async readThread(chatId: string, limit: number, signal?: AbortSignal): Promise<ThreadRead> {
    const n = Math.max(1, Math.min(100, Math.floor(limit)));
    // one signal for the whole read: when the history call fails, the room lookup beside it stops too
    const local = new AbortController();
    const sig = signal ? AbortSignal.any([signal, local.signal]) : local.signal;
    try {
      const [history, room] = await Promise.all([this.call("conversations.history", { channel: chatId, limit: n }, sig), this.roomFacts(chatId, sig)]);
      const msgs = (Array.isArray(history.messages) ? history.messages : []) as SlackHistoryMessage[];
      for (const m of msgs) {
        const id = str(m.user);
        const p = m.user_profile;
        const name = p ? str(p.real_name) || str(p.display_name) || str(p.name) : "";
        if (id && name && !this.names.get(id)) this.names.set(id, name);
      }
      const [me] = await Promise.all([this.myId(sig), this.lookupNames(msgs.map((m) => str(m.user)), sig)]);
      signal?.throwIfAborted();
      return { room, messages: this.toMessages(msgs, n, me) };
    } finally {
      local.abort();
    }
  }

  /**
   * One room by id without listing: the cached list, else conversations.info (+ users.info for a DM), kept for the
   * session. null: Slack has the room but no usable name for it (a DM whose user has none). Errors propagate.
   */
  async chatInfo(chatId: string, signal?: AbortSignal): Promise<MessengerChat | null> {
    const known = this.chats?.list.find((c) => c.id === chatId) ?? this.infos.get(chatId);
    if (known) return known;
    const r = await this.call("conversations.info", { channel: chatId }, signal);
    const c = (r.channel ?? {}) as SlackConversation;
    let chat: MessengerChat | null = null;
    if (c.is_im === true) {
      const user = str(c.user);
      if (user) await this.lookupNames([user], signal);
      const name = user ? this.names.get(user) : null;
      if (name) chat = { id: chatId, name, kind: "dm" };
    } else if (c.is_mpim === true) {
      chat = { id: chatId, name: mpimName(str(c.name)), kind: "group" };
    } else if (str(c.name)) {
      chat = { id: chatId, name: `#${str(c.name)}`, kind: "channel" };
    }
    if (chat) this.infos.set(chatId, chat);
    return chat;
  }

  /** Abort everything still running for this session (the hub closes idle or replaced sessions). */
  close(): void {
    this.closed = true;
    this.listing.abort();
    this.whoami.abort();
    for (const c of this.inflight) c.abort(new DOMException("The session was closed.", "AbortError"));
    this.inflight.clear();
  }

  // ───────────────────────────── internals ─────────────────────────────

  private toMessages(msgs: SlackHistoryMessage[], limit: number, me: string | null): ChatMessage[] {
    const raw: RawMessage[] = msgs.map((m) => {
      const user = str(m.user);
      const subtype = str(m.subtype);
      const text = str(m.text);
      const name = (user ? this.names.get(user) : null) || str(m.bot_profile?.name) || str(m.username) || "";
      return {
        id: str(m.ts),
        senderId: user || str(m.username),
        senderName: name || (SYSTEM_SUBTYPES.has(subtype) ? "" : "알 수 없음"),
        isMe: !!me && user === me,
        ...(SYSTEM_SUBTYPES.has(subtype) ? { kind: "system" as const } : {}),
        text,
        at: toMillis(str(m.ts)),
        ...(me && text.includes(`<@${me}>`) ? { mentionsMe: true } : {}),
      };
    });
    return finishMessages(raw, limit);
  }

  private async fetchChats(signal: AbortSignal): Promise<MessengerChat[]> {
    const convs: SlackConversation[] = [];
    let cursor = "";
    for (let page = 0; page < LIST_PAGES; page++) {
      const r = await this.call(
        "users.conversations",
        { types: "public_channel,private_channel,mpim,im", exclude_archived: true, limit: PAGE_SIZE, cursor: cursor || undefined },
        signal,
      );
      if (Array.isArray(r.channels)) convs.push(...(r.channels as SlackConversation[]));
      cursor = str((r.response_metadata as Json | undefined)?.next_cursor);
      if (!cursor) break;
    }
    const ims = convs.filter((c) => c.is_im === true && c.is_user_deleted !== true && str(c.user));
    await this.lookupNames(
      ims.map((c) => str(c.user)),
      signal,
    );
    const channels: MessengerChat[] = [];
    const groups: MessengerChat[] = [];
    const dms: MessengerChat[] = [];
    for (const c of convs) {
      const id = str(c.id);
      if (!id || c.is_archived === true) continue;
      if (c.is_im === true) {
        const user = str(c.user);
        if (!user || c.is_user_deleted === true) continue;
        dms.push({ id, name: this.names.get(user) || user, kind: "dm" });
      } else if (c.is_mpim === true) {
        groups.push({ id, name: mpimName(str(c.name)), kind: "group" });
      } else if (str(c.name)) {
        channels.push({ id, name: `#${str(c.name)}`, kind: "channel" });
      }
    }
    const list = [...channels, ...groups, ...dms];
    this.chats = { at: this.now(), list };
    return list;
  }

  /** What the session knows about a room (chatInfo); never fails the read. */
  private async roomFacts(chatId: string, signal?: AbortSignal): Promise<RoomInfo> {
    const c = await this.chatInfo(chatId, signal).catch(() => null);
    if (!c) return {};
    return c.kind === "group" ? { kind: "group", memberNames: c.name.split(/,\s*/) } : { title: c.name, kind: c.kind };
  }

  private async myId(signal?: AbortSignal): Promise<string | null> {
    if (this.me) return this.me;
    try {
      this.me = await this.whoami.join(signal);
    } catch {
      /* unknown: no message is marked as mine */
    }
    return this.me;
  }

  /**
   * users.info for ids without a name yet (at most NAME_LOOKUPS, NAME_PARALLEL at once, NAME_MS in all). Names are
   * extras: failures, a rate limit or the time budget only leave a name out, and nothing keeps running afterwards.
   */
  private async lookupNames(ids: string[], signal?: AbortSignal): Promise<void> {
    const want = [...new Set(ids.filter((id) => id && !this.names.get(id)))].slice(0, NAME_LOOKUPS);
    if (!want.length) return;
    const local = new AbortController();
    const sig = signal ? AbortSignal.any([signal, local.signal]) : local.signal;
    const timer = setTimeout(() => local.abort(), NAME_MS);
    const queue = [...want];
    const worker = async () => {
      for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
        if (sig.aborted) return;
        const shared = this.naming.get(id);
        if (shared) {
          await shared;
          continue;
        }
        const p = this.call("users.info", { user: id }, sig).then(
          (r) => {
            const u = (r.user ?? {}) as { real_name?: unknown; name?: unknown; profile?: { real_name?: unknown; display_name?: unknown } };
            const name = str(u.real_name) || str(u.profile?.real_name) || str(u.profile?.display_name) || str(u.name);
            this.names.set(id, name || null);
          },
          () => {},
        );
        this.naming.set(id, p);
        await p;
        this.naming.delete(id);
      }
    };
    try {
      await Promise.race([
        Promise.all(Array.from({ length: Math.min(NAME_PARALLEL, want.length) }, worker)),
        new Promise<void>((resolve) => sig.addEventListener("abort", () => resolve(), { once: true })),
      ]);
    } finally {
      clearTimeout(timer);
      local.abort(); // stop lookups still running (budget spent or the caller gave up)
    }
  }

  private checkCooldown(method: string): void {
    const until = this.cooldown.get(method) ?? 0;
    const left = until - this.now();
    if (left > 0) throw rateLimited(Math.max(1, Math.ceil(left / 1000)));
    if (until) this.cooldown.delete(method);
  }

  /** One Web API call: POST form body, Bearer token + d cookie, deadline + caller signal, 429 → rate_limited. */
  private async call(method: string, params: Params, signal?: AbortSignal): Promise<Json> {
    if (this.closed) throw new MessengerError("network", "슬랙 연결이 닫혔어요. 다시 시도해 주세요.");
    signal?.throwIfAborted();
    this.checkCooldown(method);
    const ctrl = new AbortController();
    const deadline = this.now() + this.callMs;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ctrl.abort();
    }, this.callMs);
    const onAbort = () => ctrl.abort(signal ? abortReason(signal) : undefined);
    signal?.addEventListener("abort", onAbort, { once: true });
    this.inflight.add(ctrl);
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined) body.set(k, String(v));
    try {
      for (let attempt = 0; ; attempt++) {
        const res = await fetch(`${this.api}/${method}`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.token}`,
            cookie: `d=${this.cookie}`,
            "content-type": "application/x-www-form-urlencoded; charset=utf-8",
          },
          body: body.toString(),
          redirect: "manual",
          signal: ctrl.signal,
        });
        const json = res.status === 429 ? null : ((await res.json().catch(() => null)) as Json | null);
        if (res.status === 429 || json?.error === "ratelimited" || json?.error === "rate_limited") {
          await res.body?.cancel().catch(() => {});
          const wait = retryAfterOf(res);
          if (attempt === 0 && wait <= QUIET_RETRY_S && this.now() + wait * 1000 + 1000 < deadline) {
            await sleep(wait * 1000, ctrl.signal);
            continue;
          }
          this.cooldown.set(method, this.now() + wait * 1000);
          throw rateLimited(wait);
        }
        if (!res.ok) throw apiError(method, `http_${res.status}`, res.status);
        if (json?.ok !== true) {
          const code = str(json?.error);
          throw apiError(method, /^[a-z0-9_]{1,40}$/.test(code) ? code : "unknown_error");
        }
        return json;
      }
    } catch (e) {
      if (signal?.aborted) throw abortReason(signal);
      if (timedOut) throw new MessengerError("network", "슬랙이 제때 답하지 않았어요. 잠시 후 다시 시도해 주세요.");
      if (this.closed) throw new MessengerError("network", "슬랙 연결이 닫혔어요. 다시 시도해 주세요.");
      if (e instanceof MessengerError || (e as { name?: unknown })?.name === "SlackApiError") throw e;
      throw new MessengerError("network", "네트워크 문제로 슬랙에 연결하지 못했어요. 잠시 후 다시 시도해 주세요.");
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      this.inflight.delete(ctrl);
    }
  }
}
