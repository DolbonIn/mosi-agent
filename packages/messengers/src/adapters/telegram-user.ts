/**
 * Telegram user account (TDLib). Login happens in the login relay (login/telegram.ts): phone → code → 2FA. The session
 * secret the vault seals is `{ databaseKey, tdDir }`: the key of the TDLib database at `<configDir>/telegram/<tdDir>`.
 * `login(secret)` here is only the hub's check of a relay result (connect with `{ session: true }`): open the
 * database, require "ready", read the account name. A database that is no longer logged in maps to session_expired.
 * Disconnect signs the device out at Telegram (`revoke` → logOut) before the files are deleted.
 */
import type { MessengerChat } from "@pickle/protocol";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { MessengerError, looksLikeAuthError } from "../errors";
import { TELEGRAM_DIR, tdlibParameters } from "../login/telegram";
import type { TelegramUserSdk } from "../sdk";
import { TdError, type TdClient, type TdObject } from "../tdlib/runtime";
import { clip, finishChats, finishMessages, type RawMessage } from "../util";
import type { AdapterCtx, ProviderAdapter, Secret, Session } from "./types";
import { req } from "./types";


const TD_DIR_RE = /^s-[A-Za-z0-9_-]{8,24}$/;

function chatKind(c: TdObject): MessengerChat["kind"] {
  const t = (c.type as TdObject | undefined)?.["@type"];
  if (t === "chatTypePrivate" || t === "chatTypeSecret") return "dm";
  if (t === "chatTypeSupergroup" && (c.type as { is_channel?: boolean }).is_channel) return "channel";
  return "group";
}

function textOf(content: TdObject | undefined): { text: string; kind: RawMessage["kind"]; label?: string } {
  const t = content?.["@type"];
  const ft = (k: string) => String(((content?.[k] as TdObject | undefined)?.text as string | undefined) ?? "");
  switch (t) {
    case "messageText":
      return { text: ft("text"), kind: "text" };
    case "messagePhoto":
      return { text: ft("caption"), kind: "photo", label: "사진" };
    case "messageVideo":
      return { text: ft("caption"), kind: "video", label: "동영상" };
    case "messageDocument":
      return { text: ft("caption"), kind: "file", label: "파일" };
    case "messageSticker":
    case "messageAnimatedEmoji":
      return { text: "", kind: "emoticon", label: "스티커" };
    case "messageVoiceNote":
      return { text: "", kind: "file", label: "음성 메시지" };
    default:
      return { text: "", kind: "other", label: "메시지" };
  }
}

/** Opens the account database and waits for a terminal auth state. */
async function openDb(load: () => Promise<TelegramUserSdk>, ctx: AdapterCtx, secret: Secret): Promise<{ td: TdClient; me: TdObject }> {
  const sdk = await load().catch(() => null);
  const app = sdk?.app() ?? null;
  if (!sdk || !app) throw new MessengerError("provider_unavailable", "텔레그램 연결은 아직 준비 중이에요.");
  const key = req(secret, "databaseKey");
  const dir = req(secret, "tdDir");
  if (!key || !TD_DIR_RE.test(dir)) throw new MessengerError("invalid_credential", "텔레그램 로그인 정보가 올바르지 않아요. 다시 연결해 주세요.");
  const td = await sdk.client();
  try {
    await td.waitAuth((s) => s["@type"] === "authorizationStateWaitTdlibParameters", 20_000);
    await td.request(tdlibParameters(app, join(ctx.configDir, TELEGRAM_DIR, dir), key), 20_000);
    const s = await td.waitAuth((x) => x["@type"] !== "authorizationStateWaitTdlibParameters", 30_000);
    if (s["@type"] !== "authorizationStateReady") throw new MessengerError("session_expired", "텔레그램 로그인이 만료됐어요. 다시 연결해 주세요.");
    const me = await td.request<TdObject>({ "@type": "getMe" });
    return { td, me };
  } catch (e) {
    await td.close().catch(() => {});
    if (e instanceof TdError && /ENCRYPTION|DATABASE|WRONG/i.test(e.message)) {
      throw new MessengerError("session_expired", "텔레그램 로그인이 만료됐어요. 다시 연결해 주세요.");
    }
    throw e;
  }
}

function session(td: TdClient, myId: number): Session {
  const chat = (id: number) => td.request<TdObject>({ "@type": "getChat", chat_id: id });
  return {
    async listChats({ search, limit }) {
      const want = Math.min(100, Math.max(limit, search ? 100 : limit));
      await td.request({ "@type": "loadChats", chat_list: { "@type": "chatListMain" }, limit: want }).catch(() => {});
      const ids = ((await td.request<TdObject>({ "@type": "getChats", chat_list: { "@type": "chatListMain" }, limit: want })).chat_ids as number[] | undefined) ?? [];
      const chats: MessengerChat[] = [];
      for (const id of ids) {
        const c = await chat(id).catch(() => null);
        if (!c) continue;
        const last = c.last_message as TdObject | undefined;
        const t = textOf(last?.content as TdObject | undefined);
        chats.push({
          id: String(id),
          name: clip(String(c.title ?? "") || "대화", 80),
          kind: chatKind(c),
          ...(typeof c.unread_count === "number" && c.unread_count > 0 ? { unread: c.unread_count } : {}),
          ...(t.text ? { lastMessage: clip(t.text, 80) } : {}),
          ...(typeof last?.date === "number" ? { lastAt: (last.date as number) * 1000 } : {}),
        });
      }
      return finishChats(chats, search, limit);
    },
    async readMessages(chatId, limit) {
      const id = Number(chatId);
      if (!Number.isSafeInteger(id)) throw new MessengerError("chat_not_found", "대화방을 찾지 못했어요. 대화방 목록을 다시 확인해 주세요.");
      const c = await chat(id).catch(() => {
        throw new MessengerError("chat_not_found", "대화방을 찾지 못했어요. 대화방 목록을 다시 확인해 주세요.");
      });
      const n = Math.min(100, Math.max(1, limit));
      let msgs: TdObject[] = [];
      // TDLib returns what it has locally first; ask again until the count settles (at most 3 times)
      for (let i = 0; i < 3 && msgs.length < n; i++) {
        const r = await td.request<TdObject>({ "@type": "getChatHistory", chat_id: id, from_message_id: 0, offset: 0, limit: n, only_local: false });
        const got = (r.messages as TdObject[] | undefined) ?? [];
        if (got.length <= msgs.length) break;
        msgs = got;
      }
      const names = new Map<number, string>();
      const nameOf = async (sender: TdObject | undefined): Promise<{ id: string; name: string }> => {
        if (sender?.["@type"] === "messageSenderUser") {
          const uid = Number(sender.user_id);
          if (!names.has(uid)) {
            const u = await td.request<TdObject>({ "@type": "getUser", user_id: uid }).catch(() => null);
            names.set(uid, u ? [u.first_name, u.last_name].filter(Boolean).join(" ") || "알 수 없음" : "알 수 없음");
          }
          return { id: String(uid), name: names.get(uid)! };
        }
        return { id: String(sender?.chat_id ?? ""), name: String(c.title ?? "") };
      };
      const raw: RawMessage[] = [];
      for (const m of msgs) {
        const s = await nameOf(m.sender_id as TdObject | undefined);
        const t = textOf(m.content as TdObject | undefined);
        raw.push({
          id: String(m.id),
          at: typeof m.date === "number" ? (m.date as number) * 1000 : null,
          senderId: s.id,
          senderName: s.name,
          isMe: !!m.is_outgoing || s.id === String(myId),
          kind: t.kind,
          text: t.text,
          ...(t.label ? { attachment: { label: t.label } } : {}),
        });
      }
      return finishMessages(raw, n);
    },
    async send(chatId, text) {
      const id = Number(chatId);
      if (!Number.isSafeInteger(id)) throw new MessengerError("chat_not_found", "대화방을 찾지 못했어요. 대화방 목록을 다시 확인해 주세요.");
      const m = await td.request<TdObject>({
        "@type": "sendMessage",
        chat_id: id,
        input_message_content: { "@type": "inputMessageText", text: { "@type": "formattedText", text, entities: [] }, clear_draft: true },
      });
      return { ok: true, id: String(m.id) };
    },
    async close() {
      await td.close().catch(() => {});
    },
  };
}

export function telegramUserAdapter(load: () => Promise<TelegramUserSdk>): ProviderAdapter {
  return {
    async login(ctx, secret) {
      if (!secret) throw new MessengerError("credential_required", "텔레그램은 전화번호 로그인으로 연결해 주세요.");
      const { td, me } = await openDb(load, ctx, secret);
      const name = [me.first_name, me.last_name].filter((x) => typeof x === "string" && x).join(" ").trim();
      return {
        kind: "connected",
        token: null,
        accountLabel: name ? clip(name, 80) : "텔레그램",
        meta: { telegramUserId: String(me.id ?? "") },
        session: session(td, Number(me.id)),
      };
    },
    async open(ctx, secret) {
      const { td, me } = await openDb(load, ctx, secret);
      return session(td, Number(me.id));
    },
    // 401 / AUTH_KEY_UNREGISTERED / SESSION_REVOKED: signed out elsewhere (no refresh → the hub marks session_expired)
    isAuthError: (e) => (e instanceof TdError && (e.code === 401 || /AUTH_KEY|SESSION_REVOKED|SESSION_EXPIRED|USER_DEACTIVATED/.test(e.message))) || looksLikeAuthError(e),
    /**
     * Disconnect: sign this device out at Telegram (TDLib logOut), so the session also disappears from the person's
     * "활성 세션" list. The hub closed the live session first (one TDLib client per database), calls this before
     * `cleanup` deletes the files, and stops waiting after its timeout (`signal`). A database that is already logged
     * out or unreadable throws in openDb — the hub swallows it.
     */
    async revoke(ctx, secret, _meta, signal) {
      if (signal.aborted) return;
      const { td } = await openDb(load, ctx, secret);
      const stop = () => void td.close().catch(() => {});
      signal.addEventListener("abort", stop, { once: true });
      try {
        if (signal.aborted) return;
        await td.request({ "@type": "logOut" }, 10_000).catch(() => {});
        await td.waitAuth((s) => s["@type"] === "authorizationStateClosed", 10_000).catch(() => {});
      } finally {
        signal.removeEventListener("abort", stop);
        await td.close().catch(() => {});
      }
    },
    async cleanup(ctx) {
      await rm(join(ctx.configDir, TELEGRAM_DIR), { recursive: true, force: true });
    },
  };
}
