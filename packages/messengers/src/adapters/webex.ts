/**
 * Webex email/password login (`loginWithPassword` → access/refresh token + device URL). The SDK
 * exports no refresh call, so an expired token is replaced by logging in again with the saved
 * login (the hub's generic re-login path).
 */
import type { MessengerChat } from "@pickle/protocol";
import { MessengerError, looksLikeAuthError } from "../errors";
import type { WebexClientLike, WebexSdk } from "../sdk";
import { clip, finishChats, finishMessages, toMillis } from "../util";
import type { ProviderAdapter, Secret, Session } from "./types";
import { req } from "./types";

function webexSession(client: WebexClientLike): Session {
  return {
    async listChats({ search, limit }) {
      const spaces = await client.listSpaces({ max: 200 });
      const mapped: MessengerChat[] = spaces.map((s) => ({
        id: s.id,
        name: s.title || "(이름 없는 스페이스)",
        kind: s.type === "direct" ? "dm" : "group",
        lastAt: toMillis(s.lastActivity) ?? undefined,
      }));
      return finishChats(mapped, search, limit);
    },
    async readMessages(chatId, limit) {
      const msgs = await client.listMessages(chatId, { max: limit });
      return finishMessages(
        msgs.map((m) => ({ id: m.id, senderId: m.personId ?? m.personEmail ?? "", senderName: m.personEmail?.split("@")[0] || "알 수 없음", text: m.text ?? m.markdown ?? "", at: toMillis(m.created) })),
        limit,
      );
    },
    async send(chatId, text) {
      const m = await client.sendMessage(chatId, text);
      return { ok: true, id: m.id };
    },
    async close() {
      await client.dispose().catch(() => {});
    },
  };
}

export function webexAdapter(load: () => Promise<WebexSdk>): ProviderAdapter {
  const open = async (s: Secret) => {
    const sdk = await load();
    const client = sdk.createClient();
    await client.login({ token: s.access_token ?? "", deviceUrl: s.device_url || undefined, tokenType: "password" });
    return { client, session: webexSession(client) };
  };
  return {
    async login(_ctx, secret) {
      const email = req(secret, "email", "username").trim();
      const password = req(secret, "password");
      if (!email || !password) throw new MessengerError("invalid_credential", "Webex 이메일과 비밀번호를 입력해 주세요.");
      const sdk = await load();
      let r;
      try {
        r = await sdk.loginWithPassword(email, password);
      } catch (e) {
        if (/password|credential|invalid_grant|401/i.test(e instanceof Error ? e.message : "")) {
          throw new MessengerError("bad_credentials", "Webex 이메일 또는 비밀번호가 맞지 않아요. (SSO 회사 계정은 지원하지 않아요)");
        }
        throw e;
      }
      const token: Secret = {
        access_token: r.accessToken,
        refresh_token: r.refreshToken,
        expires_at: String(r.expiresAt),
        device_url: r.deviceUrl,
        user_id: r.userId,
      };
      const { client, session } = await open(token);
      let label: string | null = null;
      try {
        label = (await client.testAuth()).displayName || null;
      } catch {
        /* cosmetic */
      }
      return { kind: "connected", token, accountLabel: label ? clip(label, 80) : null, meta: { webexUserId: r.userId }, session };
    },
    async open(_ctx, s) {
      if (!s.access_token) throw new MessengerError("session_expired", "Webex 로그인이 만료됐어요. 다시 연결해 주세요.");
      return (await open(s)).session;
    },
    isAuthError: looksLikeAuthError,
  };
}
