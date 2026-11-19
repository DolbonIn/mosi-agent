/**
 * Instagram DMs via the private mobile API (username + password). Accounts with two-factor
 * authentication get an `enter_code` verification: the code Instagram sends by SMS/app is
 * submitted through `MessengerHub.verify()` → `twoFactorLogin`. Security challenges
 * ("Was this you?") can't be completed here and surface as a clear error.
 *
 * The session (cookies + device fingerprint) is sealed in the vault; to restore it the SDK
 * needs a file, so it is written 0600 for the duration of `loadSession` and deleted right after.
 */
import { mkdir, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { MessengerError, looksLikeAuthError } from "../errors";
import type { InstagramClientLike, InstagramSdk } from "../sdk";
import { clip, finishMessages, toMillis } from "../util";
import type { Connected, LoginOutcome, ProviderAdapter, Session } from "./types";
import { req } from "./types";

function igSession(client: InstagramClientLike): Session {
  return {
    async listChats({ search, limit }) {
      const chats = search?.trim() ? await client.searchChats(search.trim(), limit) : await client.listChats(limit);
      return chats.slice(0, limit).map((c) => ({
        id: c.id,
        name: c.name,
        kind: c.is_group ? ("group" as const) : ("dm" as const),
        unread: c.unread_count,
        lastMessage: c.last_message?.text ? clip(c.last_message.text, 80) : undefined,
        lastAt: c.last_message ? (toMillis(c.last_message.timestamp) ?? undefined) : undefined,
      }));
    },
    async readMessages(chatId, limit) {
      const msgs = await client.getMessages(chatId, limit);
      return finishMessages(
        msgs.map((m) => ({
          id: m.id,
          senderId: m.from,
          senderName: m.from_name || m.from,
          isMe: !!m.is_outgoing,
          text: m.text ?? "",
          ...(m.text ? {} : { kind: "other" as const, attachment: { label: "첨부" } }),
          at: toMillis(m.timestamp),
        })),
        limit,
      );
    },
    async send(chatId, text) {
      const m = await client.sendMessage(chatId, text);
      return { ok: true, id: m.id };
    },
    close() {},
  };
}

function connected(client: InstagramClientLike, username: string): Connected {
  return {
    kind: "connected",
    token: { session: JSON.stringify(client.getSessionState()), username },
    accountLabel: `@${username}`,
    meta: { igUserId: client.getSessionState().user_id ?? null },
    session: igSession(client),
  };
}

function mapLoginError(e: unknown): never {
  if (e instanceof MessengerError) throw e;
  const code = String((e as { code?: unknown } | null)?.code ?? "");
  const msg = e instanceof Error ? e.message : "";
  if (/bad_password|invalid_user|incorrect|password/i.test(code + " " + msg)) {
    throw new MessengerError("bad_credentials", "인스타그램 아이디 또는 비밀번호가 맞지 않아요.");
  }
  if (/challenge/i.test(code + " " + msg)) {
    throw new MessengerError("challenge_required", "인스타그램이 보안 확인을 요청했어요. 인스타그램 앱에서 로그인 시도를 '본인'으로 확인한 뒤 다시 연결해 주세요.");
  }
  throw e;
}

export function instagramAdapter(load: () => Promise<InstagramSdk>): ProviderAdapter {
  return {
    async login(ctx, secret): Promise<LoginOutcome> {
      const username = req(secret, "username", "email").trim().replace(/^@/, "");
      const password = req(secret, "password");
      if (!username || !password) throw new MessengerError("invalid_credential", "인스타그램 아이디와 비밀번호를 입력해 주세요.");
      const sdk = await load();
      await mkdir(ctx.configDir, { recursive: true, mode: 0o700 });
      const client = sdk.createClient(ctx.configDir);
      const r = await client.authenticate(username, password).catch(mapLoginError);
      if (r.userId) return connected(client, username);
      if (r.requiresTwoFactor) {
        const identifier = String(r.twoFactorInfo?.["two_factor_identifier"] ?? "");
        return {
          kind: "pending",
          verification: {
            kind: "enter_code",
            prompt: "인스타그램이 보낸 6자리 인증 코드를 입력해 주세요.",
            length: 6,
            expiresAt: ctx.now() + 10 * 60_000,
          },
          meta: {},
          submit: async (code) => {
            try {
              await client.twoFactorLogin(username, code, identifier);
            } catch (e) {
              if (/two_factor|code/i.test(String((e as { code?: unknown }).code ?? ""))) {
                throw new MessengerError("wrong_code", "인증 코드가 맞지 않아요. 다시 입력해 주세요.");
              }
              throw e;
            }
            return connected(client, username);
          },
        };
      }
      if (r.challengeRequired) mapLoginError(Object.assign(new Error("challenge"), { code: "challenge_required" }));
      throw new MessengerError("login_rejected", "인스타그램이 비밀번호 로그인을 거절했어요. 앱에서 로그인을 확인한 뒤 다시 시도해 주세요.");
    },

    async open(ctx, s) {
      if (!s.session) throw new MessengerError("session_expired", "인스타그램 로그인이 만료됐어요. 다시 연결해 주세요.");
      const sdk = await load();
      await mkdir(ctx.configDir, { recursive: true, mode: 0o700 });
      const client = sdk.createClient(ctx.configDir);
      const path = join(ctx.configDir, `.ig-session-${randomBytes(6).toString("hex")}.json`);
      await writeFile(path, s.session, { mode: 0o600 });
      try {
        await client.loadSession(path);
      } finally {
        await unlink(path).catch(() => {});
      }
      client.setSessionPath(""); // keep the SDK from writing the session back to disk
      return igSession(client);
    },

    isAuthError: looksLikeAuthError,

    async cleanup(ctx) {
      await rm(join(ctx.configDir, "instagram"), { recursive: true, force: true }).catch(() => {});
      await rm(join(ctx.configDir, "instagram-credentials.json"), { force: true }).catch(() => {});
    },
  };
}
