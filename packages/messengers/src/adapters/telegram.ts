/**
 * Telegram bots (BotFather token). The Bot API has no "list my chats" or history call, so
 * chats/messages come from the bot's pending updates (`getUpdates` without an offset — read-only,
 * nothing is acknowledged). Only chats that wrote to the bot recently (≤ 24 h) are visible.
 */
import type { MessengerChat } from "@pickle/protocol";
import { MessengerError, looksLikeAuthError } from "../errors";
import type { TelegramBotSdk } from "../sdk";
import type { TelegramChat, TelegramMessage, TelegramUpdate } from "agent-messenger/telegrambot";
import { clip, finishChats, finishMessages, toMillis } from "../util";
import type { ProviderAdapter, Secret, Session } from "./types";
import { req } from "./types";

function chatName(c: TelegramChat): string {
  return c.title || [c.first_name, c.last_name].filter(Boolean).join(" ") || (c.username ? `@${c.username}` : String(c.id));
}

function chatKind(c: TelegramChat): MessengerChat["kind"] {
  return c.type === "private" ? "dm" : c.type === "channel" ? "channel" : "group";
}

function messagesOf(updates: TelegramUpdate[]): TelegramMessage[] {
  const out: TelegramMessage[] = [];
  for (const u of updates) {
    const m = u.message ?? u.channel_post ?? u.edited_message ?? u.edited_channel_post;
    if (m) out.push(m);
  }
  return out;
}

export function telegramBotAdapter(load: () => Promise<TelegramBotSdk>): ProviderAdapter {
  const open = async (secret: Secret) => {
    const token = req(secret, "token").trim();
    if (!/^\d{5,}:[A-Za-z0-9_-]{20,}$/.test(token)) {
      throw new MessengerError("invalid_credential", "봇 토큰 형식이 아니에요. BotFather가 준 '123456:ABC…' 형태의 토큰을 붙여 넣어 주세요.");
    }
    const sdk = await load();
    const client = sdk.createClient();
    await client.login({ token });
    const recent = async () => messagesOf(await client.getUpdates({ limit: 100, timeout: 0 }));
    const session: Session = {
      async listChats({ search, limit }) {
        const byId = new Map<string, MessengerChat>();
        for (const m of await recent()) {
          byId.set(String(m.chat.id), {
            id: String(m.chat.id),
            name: chatName(m.chat),
            kind: chatKind(m.chat),
            lastMessage: clip(m.text ?? m.caption ?? "", 80) || undefined,
            lastAt: toMillis(m.date) ?? undefined,
          });
        }
        return finishChats([...byId.values()].reverse(), search, limit);
      },
      async readMessages(chatId, limit) {
        const msgs = (await recent()).filter((m) => String(m.chat.id) === chatId);
        return finishMessages(
          msgs.map((m) => ({
            id: String(m.message_id),
            senderId: m.from ? String(m.from.id) : `chat:${m.chat.id}`,
            senderName: m.from ? [m.from.first_name, m.from.last_name].filter(Boolean).join(" ") || m.from.username || "알 수 없음" : chatName(m.chat),
            text: m.text ?? m.caption ?? "",
            ...(m.text || m.caption ? {} : { kind: "other" as const, attachment: { label: "미디어" } }),
            at: toMillis(m.date),
          })),
          limit,
        );
      },
      async send(chatId, text) {
        const m = await client.sendMessage(/^-?\d+$/.test(chatId) ? Number(chatId) : chatId, text);
        return { ok: true, id: String(m.message_id) };
      },
      close() {},
    };
    return { client, session };
  };
  return {
    async login(_ctx, secret) {
      const { client, session } = await open(secret ?? {});
      const me = await client.getMe();
      return {
        kind: "connected",
        token: null,
        accountLabel: me.username ? `@${me.username}` : me.first_name,
        meta: { botId: me.id },
        session,
      };
    },
    async open(_ctx, secret) {
      return (await open(secret)).session;
    },
    isAuthError: looksLikeAuthError,
  };
}
