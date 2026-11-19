/**
 * A fake of Slack's Web API on a loopback port (never slack.com) for the user session (adapters/slack-web.ts):
 * users.conversations (paged), conversations.history, conversations.info, users.info, chat.postMessage, auth.test and
 * auth.signout. It records every call with its auth headers; `limit(method, retryAfter, times)` answers 429 +
 * Retry-After; `hang(method)` keeps requests open (counted by `pending()` until the client goes away);
 * `delay(method, ms)` slows answers so parallel callers really overlap; `fail(method, …)` answers an error.
 */
export interface FakeConv {
  id: string;
  name?: string;
  is_channel?: boolean;
  is_private?: boolean;
  is_im?: boolean;
  is_mpim?: boolean;
  is_archived?: boolean;
  user?: string;
}
export interface FakeMsg {
  ts: string;
  text: string;
  user?: string;
  subtype?: string;
  user_profile?: { real_name: string };
  bot_profile?: { name: string };
}
export interface FakeSlackData {
  me: string;
  convs: FakeConv[];
  users: Record<string, { real_name?: string; name: string }>;
  /** newest first, like Slack */
  history: Record<string, FakeMsg[]>;
}
export interface FakeCall {
  method: string;
  params: Record<string, string>;
  authorization: string | null;
  cookie: string | null;
}

export const DEFAULT_SLACK_DATA: FakeSlackData = {
  me: "U1",
  convs: [
    { id: "C1", name: "general", is_channel: true },
    { id: "C2", name: "old", is_channel: true, is_archived: true },
    { id: "D1", is_im: true, user: "U2" },
  ],
  users: { U1: { name: "haneul", real_name: "하늘" }, U2: { name: "minji", real_name: "김민지" } },
  history: {
    C1: [
      { ts: "1731300060.000200", text: "두 번째", user: "U2" },
      { ts: "1731300000.000100", text: "첫 번째", user: "U1" },
    ],
  },
};

export function fakeSlackWeb(data: FakeSlackData = DEFAULT_SLACK_DATA) {
  const calls: FakeCall[] = [];
  const limits = new Map<string, { retryAfter: number; times: number }>();
  const hangs = new Set<string>();
  const delays = new Map<string, number>();
  const failures = new Map<string, { status: number; error: string }>();
  let open = 0;
  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    async fetch(req) {
      const method = new URL(req.url).pathname.replace(/^\/api\//, "");
      const params = Object.fromEntries(new URLSearchParams(await req.text()));
      calls.push({ method, params, authorization: req.headers.get("authorization"), cookie: req.headers.get("cookie") });
      const lim = limits.get(method);
      if (lim && lim.times > 0) {
        lim.times--;
        return json({ ok: false, error: "ratelimited" }, 429, { "retry-after": String(lim.retryAfter) });
      }
      if (hangs.has(method)) {
        open++;
        return new Promise<Response>((resolve) => {
          const done = () => {
            open--;
            resolve(json({ ok: false, error: "gone" }, 499));
          };
          if (req.signal.aborted) done();
          else req.signal.addEventListener("abort", done, { once: true });
        });
      }
      const f = failures.get(method);
      if (f) return json({ ok: false, error: f.error }, f.status);
      const ms = delays.get(method);
      if (ms) await Bun.sleep(ms);
      switch (method) {
        case "auth.test":
          return json({ ok: true, user_id: data.me, team_id: "T1", user: "haneul", team: "Acme" });
        case "auth.signout":
        case "auth.revoke":
          return json({ ok: true });
        case "chat.postMessage": {
          if (!data.history[params.channel ?? ""] && !data.convs.some((c) => c.id === params.channel)) return json({ ok: false, error: "channel_not_found" });
          const ts = "1731300100.000300";
          return json({ ok: true, channel: params.channel, ts, message: { ts, text: params.text, user: data.me } });
        }
        case "users.conversations": {
          const all = params.exclude_archived === "true" ? data.convs.filter((c) => !c.is_archived) : data.convs;
          const size = Math.max(1, Number(params.limit) || 100);
          const start = Number(params.cursor || 0);
          const page = all.slice(start, start + size);
          const next = start + size < all.length ? String(start + size) : "";
          return json({ ok: true, channels: page, response_metadata: { next_cursor: next } });
        }
        case "conversations.history": {
          const msgs = data.history[params.channel ?? ""];
          if (!msgs) return json({ ok: false, error: "channel_not_found" });
          return json({ ok: true, messages: msgs.slice(0, Number(params.limit) || 100), has_more: false });
        }
        case "conversations.info": {
          const c = data.convs.find((x) => x.id === params.channel);
          return c ? json({ ok: true, channel: c }) : json({ ok: false, error: "channel_not_found" });
        }
        case "users.info": {
          const u = data.users[params.user ?? ""];
          return u ? json({ ok: true, user: { id: params.user, ...u } }) : json({ ok: false, error: "user_not_found" });
        }
        default:
          return json({ ok: false, error: "unknown_method" });
      }
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}/api`,
    calls,
    /** how many calls of `method` arrived */
    count: (method: string) => calls.filter((c) => c.method === method).length,
    /** requests held open by `hang` that the client has not abandoned yet */
    pending: () => open,
    limit(method: string, retryAfter: number, times = 1) {
      limits.set(method, { retryAfter, times });
    },
    hang(method: string, on = true) {
      if (on) hangs.add(method);
      else hangs.delete(method);
    },
    delay(method: string, ms: number) {
      delays.set(method, ms);
    },
    /** answer `method` with `{ ok: false, error }` and this HTTP status (null: answer normally again) */
    fail(method: string, f: { status?: number; error: string } | null) {
      if (f) failures.set(method, { status: f.status ?? 200, error: f.error });
      else failures.delete(method);
    },
    stop: () => server.stop(true),
  };
}

export type FakeSlackWeb = ReturnType<typeof fakeSlackWeb>;
