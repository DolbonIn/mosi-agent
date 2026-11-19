/** Discord user token (self-bot — against Discord ToS, the catalog warns) and Discord bots. */
import type { MessengerChat } from "@pickle/protocol";
import { MessengerError, looksLikeAuthError } from "../errors";
import type { DiscordBotClientLike, DiscordBotSdk, DiscordChannelLike, DiscordMessageLike, DiscordSdk } from "../sdk";
import { clip, finishChats, finishMessages, toMillis } from "../util";
import type { ProviderAdapter, Secret, Session } from "./types";
import { req } from "./types";

const TEXT_CHANNEL_TYPES = new Set([0, 5]); // GUILD_TEXT, GUILD_ANNOUNCEMENT
const MAX_GUILDS = 10;

function token(secret: Secret | null): string {
  const t = req(secret, "token").trim().replace(/^(Bot|Bearer)\s+/i, "");
  if (t.length < 20) throw new MessengerError("invalid_credential", "디스코드 토큰을 다시 확인해 주세요.");
  return t;
}

function messages(msgs: DiscordMessageLike[], limit: number, myId: string | null = null) {
  return finishMessages(
    msgs.map((m) => ({
      id: m.id,
      senderId: m.author?.id ?? "",
      senderName: m.author?.username ?? "알 수 없음",
      isMe: !!myId && m.author?.id === myId,
      text: m.content ?? "",
      at: toMillis(m.timestamp),
    })),
    limit,
  );
}

async function guildChannels(
  guilds: { id: string; name: string }[],
  list: (id: string) => Promise<DiscordChannelLike[]>,
): Promise<MessengerChat[]> {
  const per = await Promise.all(
    guilds.slice(0, MAX_GUILDS).map(async (g) => {
      const chans = await list(g.id).catch(() => [] as DiscordChannelLike[]);
      return chans
        .filter((c) => TEXT_CHANNEL_TYPES.has(c.type))
        .map((c) => ({ id: c.id, name: `${g.name} #${c.name}`, kind: "channel" as const }));
    }),
  );
  return per.flat();
}

export function discordAdapter(load: () => Promise<DiscordSdk>): ProviderAdapter {
  const open = async (secret: Secret) => {
    const sdk = await load();
    const client = sdk.createClient();
    await client.login({ token: token(secret) });
    let me: Promise<string | null> | null = null;
    const myId = () => (me ??= client.testAuth().then((u) => u.id || null, () => null));
    const session: Session = {
      async listChats({ search, limit }) {
        const [dms, servers] = await Promise.all([client.listDMChannels().catch(() => []), client.listServers()]);
        const dmChats: MessengerChat[] = dms.map((d) => ({
          id: d.id,
          name: d.name || d.recipients.map((r) => r.global_name || r.username).join(", ") || "DM",
          kind: d.recipients.length > 1 ? "group" : "dm",
        }));
        return finishChats([...dmChats, ...(await guildChannels(servers, (id) => client.listChannels(id)))], search, limit);
      },
      async readMessages(chatId, limit) {
        const [msgs, mine] = await Promise.all([client.getMessages(chatId, Math.min(100, limit)), myId()]);
        return messages(msgs, limit, mine);
      },
      async send(chatId, text) {
        const m = await client.sendMessage(chatId, text);
        return { ok: true, id: m.id };
      },
      close() {},
    };
    return { client, session };
  };
  return {
    async login(_ctx, secret) {
      const { client, session } = await open(secret ?? {});
      const me = await client.testAuth();
      return { kind: "connected", token: null, accountLabel: clip(me.global_name || me.username, 80), meta: { discordUserId: me.id }, session };
    },
    async open(_ctx, secret) {
      return (await open(secret)).session;
    },
    isAuthError: looksLikeAuthError,
  };
}

export function discordBotAdapter(load: () => Promise<DiscordBotSdk>): ProviderAdapter {
  const open = async (secret: Secret): Promise<{ client: DiscordBotClientLike; session: Session }> => {
    const sdk = await load();
    const client = sdk.createClient();
    await client.login({ token: token(secret) });
    const session: Session = {
      async listChats({ search, limit }) {
        return finishChats(await guildChannels(await client.listGuilds(), (id) => client.listChannels(id)), search, limit);
      },
      async readMessages(chatId, limit) {
        return messages(await client.getMessages(chatId, Math.min(100, limit)), limit);
      },
      async send(chatId, text) {
        const m = await client.sendMessage(chatId, text);
        return { ok: true, id: m.id };
      },
      close() {},
    };
    return { client, session };
  };
  return {
    async login(_ctx, secret) {
      const { client, session } = await open(secret ?? {});
      const me = await client.testAuth();
      return { kind: "connected", token: null, accountLabel: clip(`${me.username} 봇`, 80), meta: { botUserId: me.id }, session };
    },
    async open(_ctx, secret) {
      return (await open(secret)).session;
    },
    isAuthError: looksLikeAuthError,
  };
}
