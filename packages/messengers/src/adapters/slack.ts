/**
 * Slack as the user (browser session token `xoxc-…` + `d` cookie `xoxd-…`) and Slack bots
 * (`xoxb-…`). Token providers: the user's sealed credential is itself the session secret.
 * The user session talks to Slack only through `SlackWeb` (plain fetch: deadlines, abort, 429 fails fast) — auth.test
 * at login, listing, reading and sending; agent-messenger's client is not used for it (bots still use theirs).
 */
import { MessengerError, looksLikeAuthError } from "../errors";
import type { SlackBotClientLike, SlackBotSdk, SlackMessageLike, SlackSdk, SlackUserLike } from "../sdk";
import { clip, finishChats, finishMessages, toMillis } from "../util";
import { SlackWeb } from "./slack-web";
import type { AdapterCtx, Meta, ProviderAdapter, Secret, Session } from "./types";
import { req } from "./types";

function userName(u: SlackUserLike | undefined): string | null {
  if (!u) return null;
  return u.real_name || u.name || null;
}

function mapMessages(msgs: SlackMessageLike[], users: Map<string, SlackUserLike>, limit: number, myId: string | null) {
  return finishMessages(
    msgs.map((m) => ({
      id: m.ts,
      senderId: m.user ?? m.username ?? "",
      senderName: userName(m.user ? users.get(m.user) : undefined) ?? m.username ?? "알 수 없음",
      isMe: !!myId && m.user === myId,
      text: m.text ?? "",
      at: toMillis(m.ts),
    })),
    limit,
  );
}

function slackCreds(secret: Secret | null): { token: string; cookie: string } {
  const token = req(secret, "token", "xoxc").trim();
  let cookie = req(secret, "cookie", "xoxd", "d").trim();
  if (cookie.startsWith("d=")) cookie = cookie.slice(2);
  if (!/^xoxc-/.test(token)) throw new MessengerError("invalid_credential", "슬랙 토큰은 'xoxc-'로 시작해야 해요.");
  if (!/^xoxd-|^xoxd%2D/i.test(cookie)) throw new MessengerError("invalid_credential", "슬랙 쿠키(d)는 'xoxd-'로 시작해야 해요.");
  return { token, cookie };
}

/** Slack's Web API — the host agent-messenger's WebClient talks to */
export const SLACK_API = "https://slack.com/api";

/** errors that mean the session is already gone at Slack (nothing left to sign out) */
const ALREADY_OUT = new Set(["invalid_auth", "not_authed", "token_revoked", "token_expired", "account_inactive"]);

/**
 * Sign a browser session (xoxc token + d cookie) out at Slack: `auth.signout`, the call Slack's own web client makes on
 * sign-out; a workspace that does not know it falls back to `auth.revoke`. Resolves when Slack says ok (or that the
 * session is already gone), throws otherwise — callers treat it as best-effort. The token and cookie go only to Slack,
 * never into an error message or a log.
 */
export async function slackSignOut(creds: { token: string; cookie: string }, signal: AbortSignal, api = SLACK_API): Promise<void> {
  let last = "unknown";
  for (const method of ["auth.signout", "auth.revoke"]) {
    const res = await fetch(`${api}/${method}`, {
      method: "POST",
      headers: { authorization: `Bearer ${creds.token}`, cookie: `d=${creds.cookie}`, "content-type": "application/x-www-form-urlencoded; charset=utf-8" },
      body: "",
      redirect: "manual",
      signal,
    });
    const body = (await res.json().catch(() => null)) as { ok?: unknown; error?: unknown } | null;
    if (body?.ok === true) return;
    last = typeof body?.error === "string" ? body.error.slice(0, 40) : `http_${res.status}`;
    if (ALREADY_OUT.has(last)) return;
    if (last !== "unknown_method" && last !== "method_deprecated") break;
  }
  throw new MessengerError("upstream", `슬랙 로그아웃을 확인하지 못했어요 (${last}).`);
}

export function slackAdapter(load: () => Promise<SlackSdk>): ProviderAdapter {
  const open = async (ctx: AdapterCtx, secret: Secret, meta: Meta = {}) => {
    const sdk = await load();
    const creds = slackCreds(secret);
    const slackUserId = typeof meta.slackUserId === "string" ? meta.slackUserId : null;
    const web = new SlackWeb({ api: sdk.apiUrl ?? SLACK_API, token: creds.token, cookie: creds.cookie, userId: slackUserId, now: ctx.now });
    const session: Session = {
      async listChats({ search, limit, signal }) {
        return finishChats(await web.listChats(signal), search, limit);
      },
      async readMessages(chatId, limit, signal) {
        return (await web.readThread(chatId, limit, signal)).messages;
      },
      readThread(chatId, limit, signal) {
        return web.readThread(chatId, limit, signal);
      },
      describeChat(chatId, signal) {
        return web.chatInfo(chatId, signal);
      },
      async send(chatId, text, signal) {
        const m = await web.postMessage(chatId, text, signal);
        return { ok: true, id: m.ts };
      },
      close() {
        web.close();
      },
    };
    return { session, web };
  };
  return {
    async login(ctx, secret) {
      const { session, web } = await open(ctx, secret ?? {});
      const auth = await web.authTest().catch((e: unknown) => {
        session.close();
        throw e;
      });
      return {
        kind: "connected",
        token: null,
        accountLabel: clip([auth.user, auth.team].filter(Boolean).join(" · ") || "Slack", 80),
        meta: { teamId: auth.team_id, slackUserId: auth.user_id },
        session,
      };
    },
    async open(ctx, secret, meta) {
      return (await open(ctx, secret, meta)).session;
    },
    isAuthError: looksLikeAuthError,
    describesChats: true,
    // only for sessions the connection owns (the login relay's xoxc + d); the hub never calls it for a pasted token
    async revoke(_ctx, secret, _meta, signal) {
      const sdk = await load();
      await slackSignOut(slackCreds(secret), signal, sdk.apiUrl ?? SLACK_API);
    },
  };
}

export function slackBotAdapter(load: () => Promise<SlackBotSdk>): ProviderAdapter {
  const open = async (secret: Secret): Promise<{ client: SlackBotClientLike; session: Session }> => {
    const token = req(secret, "token", "xoxb").trim();
    if (!/^xoxb-/.test(token)) throw new MessengerError("invalid_credential", "슬랙 봇 토큰은 'xoxb-'로 시작해야 해요.");
    const sdk = await load();
    const client = sdk.createClient();
    await client.login({ token });
    let users: Promise<Map<string, SlackUserLike>> | null = null;
    const userMap = () =>
      (users ??= client
        .listUsers({ limit: 500 })
        .then((list) => new Map(list.map((u) => [u.id, u] as const)))
        .catch(() => new Map<string, SlackUserLike>()));
    const session: Session = {
      async listChats({ search, limit }) {
        const channels = await client.listChannels({ limit: 200 });
        return finishChats(
          channels.filter((c) => !c.is_archived).map((c) => ({ id: c.id, name: `#${c.name}`, kind: "channel" as const })),
          search,
          limit,
        );
      },
      async readMessages(chatId, limit) {
        const [msgs, umap] = await Promise.all([client.getConversationHistory(chatId, { limit }), userMap()]);
        return mapMessages(msgs, umap, limit, null);
      },
      async send(chatId, text) {
        const m = await client.postMessage(chatId, text);
        return { ok: true, id: m.ts };
      },
      close() {},
    };
    return { client, session };
  };
  return {
    async login(_ctx, secret) {
      const { client, session } = await open(secret ?? {});
      const auth = await client.testAuth();
      return {
        kind: "connected",
        token: null,
        accountLabel: clip([auth.user, auth.team].filter(Boolean).join(" · ") || "Slack 봇", 80),
        meta: { teamId: auth.team_id, botId: auth.bot_id ?? null },
        session,
      };
    },
    async open(_ctx, secret) {
      return (await open(secret)).session;
    },
    isAuthError: looksLikeAuthError,
  };
}
