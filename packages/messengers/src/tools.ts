/**
 * Agent tools over the hub. Tool data/cards contain chat names and message text only — never
 * tokens or credential ids. Sending always requires the user's approval.
 */
import type { CredentialNeed, ToolContext, ToolDef, ToolResult } from "@pickle/agent";
import type { MessengerCard } from "@pickle/protocol";
import { MessengerError } from "./errors";
import type { MessengerHub } from "./hub";
import { PROVIDER_IDS, isProviderId, providerInfo, providerName, providers } from "./providers";
import { cardThread, focusTerms, pickHighlights, roomOf, transcript } from "./thread";
import { clip } from "./util";

type ListArgs = { provider: string; search?: string };
type ReadArgs = { provider: string; chat: string; limit?: number; focus?: string };
type SendArgs = { provider: string; chat: string; text: string };

const KST = 9 * 60 * 60 * 1000;
function kst(ms: number | null): string | undefined {
  return ms ? new Date(ms + KST).toISOString().slice(5, 16).replace("T", " ") : undefined;
}

function fail(e: unknown): ToolResult {
  if (e instanceof MessengerError) {
    return {
      ok: false,
      summary: e.message,
      data: { error: e.code, message: e.message, ...(e.candidates ? { candidates: e.candidates } : {}), ...(e.retryAfter ? { retryAfter: e.retryAfter } : {}) },
    };
  }
  return { ok: false, summary: "메신저 요청을 처리하지 못했어요.", data: { error: "upstream" } };
}

function checkProvider(provider: unknown): asserts provider is (typeof PROVIDER_IDS)[number] {
  if (!isProviderId(provider)) throw new MessengerError("unknown_provider", "지원하지 않는 메신저예요.");
}

async function needCredential(hub: MessengerHub, provider: string, ctx: ToolContext, reason: string): Promise<CredentialNeed | null> {
  if (!isProviderId(provider)) return null;
  const info = providerInfo(provider);
  if (!info.available || (info.auth !== "credentials" && info.auth !== "token")) return null;
  const c = await hub.connection(ctx.userId, provider);
  if (c && (c.status === "connected" || c.status === "connecting" || c.status === "needs_verification")) return null;
  return { service: info.id, serviceName: info.name, reason, fields: info.fields.map((f) => ({ ...f })) };
}

const providerProp = {
  type: "string" as const,
  description: "Messenger id: kakaotalk, slack, slackbot, discord, discordbot, telegram, telegrambot, line, instagram, teams, webex",
  enum: [...PROVIDER_IDS],
};

export function messengerTools(hub: MessengerHub): ToolDef[] {
  const connectionsTool: ToolDef<Record<string, never>> = {
    name: "msg_connections",
    description:
      "List which of the user's messenger accounts (KakaoTalk, Slack, Discord, Telegram bot, LINE, Instagram, Teams, Webex) are connected and usable for reading/sending.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    icon: "link",
    title: () => "연결된 메신저 확인",
    async run(_args, ctx) {
      try {
        const conns = await hub.connections(ctx.userId);
        const byId = new Map(conns.map((c) => [c.provider, c] as const));
        const connected = conns
          .filter((c) => c.status === "connected")
          .map((c) => ({ provider: c.provider, name: providerName(c.provider), account: c.accountLabel }));
        const other = providers()
          .filter((p) => p.available && byId.get(p.id)?.status !== "connected")
          .map((p) => ({ provider: p.id, name: p.name, status: byId.get(p.id)?.status ?? "disconnected" }));
        return {
          ok: true,
          summary: connected.length ? `${connected.map((c) => c.name).join(", ")} 연결됨` : "연결된 메신저가 없어요",
          data: { connected, notConnected: other },
        };
      } catch (e) {
        return fail(e);
      }
    },
  };

  const listTool: ToolDef<ListArgs> = {
    name: "msg_list_chats",
    description:
      "List the user's chats/channels in a connected messenger (KakaoTalk, Slack, …), newest first. Optional `search` filters by chat name. Messenger chats only: meetings 모시 attended (회의록, 회의 요약) are not here — use sys_meet_notes for those.",
    parameters: {
      type: "object",
      properties: { provider: providerProp, search: { type: "string", description: "part of a chat/channel/person name" } },
      required: ["provider"],
      additionalProperties: false,
    },
    icon: "chat",
    title: (a) => `${providerName(a.provider)} 대화방 보기`,
    credential: (a, ctx) => needCredential(hub, a.provider, ctx, `${providerName(a.provider)} 대화방을 보려면 로그인 정보가 필요해요.`),
    async run(a, ctx) {
      try {
        checkProvider(a.provider);
        const chats = await hub.listChats(ctx.userId, a.provider, { search: a.search, limit: 30, signal: ctx.signal }, ctx.credentials);
        return {
          ok: true,
          summary: chats.length ? `${providerName(a.provider)} 대화방 ${chats.length}개` : "대화방을 찾지 못했어요",
          data: {
            provider: a.provider,
            chats: chats.map((c) => ({
              id: c.id,
              name: c.name,
              kind: c.kind,
              ...(c.unread ? { unread: c.unread } : {}),
              ...(c.lastMessage ? { last: clip(c.lastMessage, 60) } : {}),
              ...(c.lastAt ? { lastAt: kst(c.lastAt) } : {}),
            })),
          },
        };
      } catch (e) {
        return fail(e);
      }
    },
  };

  const readTool: ToolDef<ReadArgs> = {
    name: "msg_read",
    description:
      "Read recent messages from one chat in a connected messenger (KakaoTalk, Slack, …). `chat` is a chat id from msg_list_chats or a chat/channel/person name (resolved by name). Returns a compact transcript ('[19:30] 이름: 내용'); the user sees the room as a card, so answer with what matters instead of repeating the messages. Pass `focus` with the keywords of what the user wants to know. Messenger chats only: for a meeting 모시 attended, use sys_meet_notes.",
    parameters: {
      type: "object",
      properties: {
        provider: providerProp,
        chat: { type: "string", description: "chat id or name, e.g. '가족' or '#general'" },
        limit: { type: "integer", description: "how many recent messages (1-50, default 20)", minimum: 1, maximum: 50 },
        focus: { type: "string", description: "optional keywords from the user's request, e.g. '공연 날짜 회비' — those messages are surfaced first" },
      },
      required: ["provider", "chat"],
      additionalProperties: false,
    },
    icon: "chat",
    title: (a) => (hub.isChatId(a.provider, a.chat) ? `${providerName(a.provider)} 대화방 읽기` : `${providerName(a.provider)} '${clip(String(a.chat ?? ""), 20)}' 읽기`),
    credential: (a, ctx) => needCredential(hub, a.provider, ctx, `${providerName(a.provider)} 메시지를 읽으려면 로그인 정보가 필요해요.`),
    async run(a, ctx) {
      try {
        checkProvider(a.provider);
        const limit = Math.max(1, Math.min(50, Math.floor(Number(a.limit) || 20)));
        const chat = await hub.resolveChat(ctx.userId, a.provider, String(a.chat ?? ""), ctx.credentials, ctx.signal);
        const { room: info, messages: msgs } = await hub.readThread(ctx.userId, a.provider, chat.id, limit, ctx.credentials, ctx.signal);
        const room = roomOf({ listName: chat.name, listKind: chat.kind, unread: chat.unread, info }, msgs);
        const focus = focusTerms(a.focus);
        const picked = pickHighlights(msgs, { myNames: [...(info.myNames ?? []), ctx.displayName].filter(Boolean), focus });
        const { thread, highlights } = cardThread(msgs, picked);
        const card: MessengerCard = { type: "messenger", provider: a.provider, action: "read", target: room.title, messages: [], room, thread, highlights, total: msgs.length };
        const byId = new Map(msgs.map((m) => [m.id, m] as const));
        return {
          ok: true,
          summary: `${room.title} 메시지 ${msgs.length}개 읽음`,
          data: {
            provider: a.provider,
            chat: { id: chat.id, name: room.title, kind: room.kind, ...(room.memberCount ? { members: room.memberCount } : {}) },
            count: msgs.length,
            transcript: transcript(msgs),
            ...(picked.length ? { notable: transcript(picked.map((id) => byId.get(id)!).filter(Boolean), { maxChars: 700 }) } : {}),
          },
          card,
        };
      } catch (e) {
        return fail(e);
      }
    },
  };

  const sendTool: ToolDef<SendArgs> = {
    name: "msg_send",
    description:
      "Send a text message as the user to one chat in a connected messenger. Always asks the user to approve first. `chat` is a chat id or an exact chat/channel/person name.",
    parameters: {
      type: "object",
      properties: {
        provider: providerProp,
        chat: { type: "string", description: "chat id or exact name" },
        text: { type: "string", description: "message text to send, exactly as it should appear" },
      },
      required: ["provider", "chat", "text"],
      additionalProperties: false,
    },
    icon: "send",
    title: (a) =>
      hub.isChatId(a.provider, a.chat) ? `${providerName(a.provider)} 대화방에 메시지 보내기` : `${providerName(a.provider)} '${clip(String(a.chat ?? ""), 20)}'에 메시지 보내기`,
    // an id is never shown as the target: credential() (the one async step before approval) has named it
    approval: (a, ctx) => {
      const target = hub.isChatId(a.provider, a.chat)
        ? (hub.knownChat(ctx.userId, a.provider, String(a.chat))?.name ?? "이름을 확인하지 못한 대화방")
        : String(a.chat ?? "");
      return { title: `${providerName(a.provider)} '${clip(target, 40)}'에 메시지를 보낼까요?`, detail: String(a.text ?? "") };
    },
    async credential(a, ctx) {
      const need = await needCredential(hub, a.provider, ctx, `${providerName(a.provider)}로 메시지를 보내려면 로그인 정보가 필요해요.`);
      if (need) return need;
      // approval() is synchronous: name a chat id now (cached list, else one lookup), or fail before any approval card
      if (hub.isChatId(a.provider, a.chat)) await hub.resolveChat(ctx.userId, a.provider, String(a.chat), ctx.credentials, ctx.signal, { forSend: true });
      return null;
    },
    async run(a, ctx) {
      try {
        checkProvider(a.provider);
        const text = String(a.text ?? "");
        const chat = await hub.resolveChat(ctx.userId, a.provider, String(a.chat ?? ""), ctx.credentials, ctx.signal, { forSend: true });
        const r = await hub.send(ctx.userId, a.provider, chat.id, text, ctx.credentials, ctx.signal);
        if (!r.ok) return { ok: false, summary: `${chat.name}에 보내지 못했어요`, data: { error: "send_failed" } };
        const at = ctx.now().getTime();
        const room = roomOf({ listName: chat.name, listKind: chat.kind, info: {} }, []);
        const card: MessengerCard = {
          type: "messenger",
          provider: a.provider,
          action: "sent",
          target: room.title,
          messages: [],
          room,
          thread: [{ id: "m1", at, senderId: "me", senderName: "나", isMe: true, kind: "text", text: clip(text, 600) }],
          highlights: ["m1"],
          total: 1,
        };
        return { ok: true, summary: `${chat.name}에 보냈어요`, data: { provider: a.provider, chat: chat.name, sent: true }, card };
      } catch (e) {
        return fail(e);
      }
    },
  };

  return [connectionsTool, listTool, readTool, sendTool] as ToolDef[];
}
