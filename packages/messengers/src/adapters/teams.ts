/**
 * Microsoft Teams (work accounts) via the device-code flow: the server shows a short code and
 * a URL; the user opens the URL on any device, types the code and signs in with Microsoft.
 * No password ever reaches the server. The resulting tokens (incl. the AAD refresh token) are
 * sealed in the vault; the SDK's credentials file is cleared right after each login/refresh.
 */
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { MessengerChat } from "@pickle/protocol";
import type { TeamsAccountType } from "agent-messenger/teams";
import { MessengerError, looksLikeAuthError } from "../errors";
import type { TeamsAuth, TeamsClientLike, TeamsSdk } from "../sdk";
import { clip, deferred, finishChats, finishMessages, stripHtml, toMillis } from "../util";
import type { AdapterCtx, Connected, ProviderAdapter, Secret, Session } from "./types";

function teamsSession(client: TeamsClientLike): Session {
  return {
    async listChats({ search, limit }) {
      const chats = await client.listChats();
      const mapped: MessengerChat[] = chats.map((c) => ({
        id: c.id,
        name: c.topic || (c.type === "self" ? "나에게 보내기" : "(이름 없는 채팅)"),
        kind: c.type === "group" ? "group" : "dm",
        lastMessage: c.last_message ? clip(stripHtml(c.last_message), 80) : undefined,
        lastAt: toMillis(c.last_message_at) ?? undefined,
      }));
      return finishChats(mapped, search, limit);
    },
    async readMessages(chatId, limit) {
      const msgs = await client.getChatMessages(chatId, limit);
      return finishMessages(
        msgs.map((m) => ({ id: m.id, senderId: m.author?.id ?? m.author?.displayName ?? "", senderName: m.author?.displayName || "알 수 없음", text: stripHtml(m.content), at: toMillis(m.timestamp) })),
        limit,
      );
    },
    async send(chatId, text) {
      const m = await client.sendChatMessage(chatId, text);
      return { ok: true, id: m.id };
    },
    close() {},
  };
}

function toSecret(a: TeamsAuth): Secret {
  return { token: a.token, tokenExpiresAt: a.tokenExpiresAt, accountType: a.accountType, region: a.region, userName: a.userName, config: a.config };
}

function fromSecret(s: Secret): TeamsAuth {
  return {
    token: s.token ?? "",
    tokenExpiresAt: s.tokenExpiresAt ?? "",
    accountType: (s.accountType === "personal" ? "personal" : "work") as TeamsAccountType,
    region: s.region ?? "",
    userName: s.userName ?? "",
    config: s.config ?? "{}",
  };
}

export function teamsAdapter(load: () => Promise<TeamsSdk>): ProviderAdapter {
  const open = async (ctx: AdapterCtx, a: TeamsAuth) => {
    const sdk = await load();
    const client = sdk.createClient(ctx.configDir);
    await client.login({ token: a.token, tokenExpiresAt: a.tokenExpiresAt || undefined, accountType: a.accountType });
    return teamsSession(client);
  };
  const connected = async (ctx: AdapterCtx, a: TeamsAuth): Promise<Connected> => ({
    kind: "connected",
    token: toSecret(a),
    accountLabel: a.userName ? clip(a.userName, 80) : null,
    meta: { accountType: a.accountType },
    session: await open(ctx, a),
  });
  return {
    async login(ctx) {
      const sdk = await load();
      const code = deferred<{ verificationUri: string; userCode: string; expiresAt: number }>();
      const done = sdk.deviceLogin(ctx.configDir, (p) => code.resolve(p));
      const first = await Promise.race([code.promise.then((p) => ({ prompt: p })), done.then((a) => ({ auth: a }))]);
      if ("auth" in first) return connected(ctx, first.auth);
      const p = first.prompt;
      return {
        kind: "pending",
        verification: {
          kind: "display_code",
          code: p.userCode,
          prompt: `${p.verificationUri} 에 접속해 이 코드를 입력하고 회사 Microsoft 계정으로 로그인해 주세요. 로그인하면 자동으로 연결돼요.`,
          expiresAt: p.expiresAt,
        },
        meta: { verificationUri: p.verificationUri },
        wait: async () => connected(ctx, await done),
      };
    },
    async open(ctx, s) {
      if (!s.token) throw new MessengerError("session_expired", "Teams 로그인이 만료됐어요. 다시 연결해 주세요.");
      return open(ctx, fromSecret(s));
    },
    async refresh(ctx, s) {
      const sdk = await load();
      return toSecret(await sdk.refresh(ctx.configDir, fromSecret(s)));
    },
    isAuthError: looksLikeAuthError,
    async cleanup(ctx) {
      await rm(join(ctx.configDir, "teams-credentials.json"), { force: true }).catch(() => {});
    },
  };
}
