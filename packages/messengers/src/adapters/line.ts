/**
 * LINE email/password login (secondary Android device). The SDK shows a PIN that the user
 * confirms in the LINE app on their phone; `loginWithEmail` resolves once they did.
 *
 * Caveat: LINE's E2EE key store path comes from AGENT_MESSENGER_CONFIG_DIR at call time, so
 * logins run under a process-wide, serialised env override (see util.withConfigDirEnv). E2EE
 * key material stays in `<configRoot>/<userId>/line-storage` (the SDK needs it to read/send in
 * encrypted chats); the auth token is moved into the vault and deleted from the SDK's file.
 */
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { MessengerChat } from "@pickle/protocol";
import type { LineAccountCredentials, LineDevice, LineLoginResult } from "agent-messenger/line";
import { MessengerError, looksLikeAuthError } from "../errors";
import type { LineClientLike, LineCredStoreLike, LineSdk } from "../sdk";
import { clip, deferred, finishChats, finishMessages, toMillis, withConfigDirEnv } from "../util";
import type { AdapterCtx, Connected, ProviderAdapter, Session } from "./types";
import { req } from "./types";

export const LINE_PIN_PROMPT = "휴대폰 LINE 앱에 로그인 확인 화면이 뜨면 이 PIN 번호를 입력해 주세요. 입력하면 자동으로 연결돼요.";

function kind(t: string): MessengerChat["kind"] {
  return t === "user" ? "dm" : t === "square" ? "channel" : "group";
}

function lineSession(client: LineClientLike): Session {
  return {
    async listChats({ search, limit }) {
      const chats = await client.getChats({ limit: Math.max(limit, 100) });
      return finishChats(
        chats.map((c) => ({ id: c.chat_id, name: c.display_name || "(이름 없음)", kind: kind(c.type) })),
        search,
        limit,
      );
    },
    async readMessages(chatId, limit) {
      const msgs = await client.getMessages(chatId, { count: limit });
      return finishMessages(
        msgs.map((m) => ({
          id: m.message_id,
          senderId: m.author_id,
          senderName: m.author_name || "알 수 없음",
          text: m.text ?? "",
          ...(m.text ? {} : { kind: "other" as const, attachment: { label: m.decryption_error ? "암호화된 메시지" : "첨부" } }),
          at: toMillis(m.sent_at),
        })),
        limit,
      );
    },
    async send(chatId, text) {
      const r = await client.sendMessage(chatId, text);
      return { ok: r.success, id: r.message_id };
    },
    close() {
      client.close();
    },
  };
}

async function finish(r: LineLoginResult, client: LineClientLike, creds: LineCredStoreLike): Promise<Connected> {
  if (!r.authenticated || !r.account_id) {
    throw new MessengerError("login_rejected", "LINE 로그인이 완료되지 않았어요. 이메일·비밀번호를 확인하고 다시 시도해 주세요.");
  }
  const acct = await creds.getAccount(r.account_id);
  if (!acct?.auth_token) throw new MessengerError("upstream", "LINE 로그인 정보를 받지 못했어요. 다시 시도해 주세요.");
  // move the token into the vault; don't leave it in the SDK's plaintext credentials file
  await creds.removeAccount(acct.account_id).catch(() => {});
  return {
    kind: "connected",
    token: {
      auth_token: acct.auth_token,
      account_id: acct.account_id,
      device: acct.device,
      certificate: acct.certificate ?? "",
      display_name: acct.display_name ?? r.display_name ?? "",
    },
    accountLabel: r.display_name ? clip(r.display_name, 80) : null,
    meta: { lineAccountId: acct.account_id, device: acct.device },
    session: lineSession(client),
  };
}

export function lineAdapter(load: () => Promise<LineSdk>): ProviderAdapter {
  return {
    async login(ctx: AdapterCtx, secret) {
      const email = req(secret, "email", "username").trim();
      const password = req(secret, "password");
      if (!email || !password) throw new MessengerError("invalid_credential", "LINE 이메일과 비밀번호를 입력해 주세요.");
      const sdk = await load();
      const { client, creds } = sdk.createSession(ctx.configDir);
      const pin = deferred<string>();
      const done = withConfigDirEnv(ctx.configDir, () => client.loginWithEmail({ email, password, onPincode: (p) => pin.resolve(p) }));
      const first = await Promise.race([pin.promise.then((p) => ({ pin: p })), done.then((r) => ({ result: r }))]);
      if ("result" in first) return finish(first.result, client, creds);
      return {
        kind: "pending",
        verification: { kind: "display_code", code: first.pin, prompt: LINE_PIN_PROMPT, expiresAt: ctx.now() + 3 * 60_000 },
        meta: {},
        wait: async () => finish(await done, client, creds),
      };
    },

    async open(ctx, s) {
      if (!s.auth_token || !s.account_id) throw new MessengerError("session_expired", "LINE 로그인이 만료됐어요. 다시 연결해 주세요.");
      const sdk = await load();
      const { client } = sdk.createSession(ctx.configDir);
      const now = new Date().toISOString();
      const creds: LineAccountCredentials = {
        account_id: s.account_id,
        auth_token: s.auth_token,
        device: (s.device || "ANDROIDSECONDARY") as LineDevice,
        ...(s.certificate ? { certificate: s.certificate } : {}),
        ...(s.display_name ? { display_name: s.display_name } : {}),
        created_at: now,
        updated_at: now,
      };
      await withConfigDirEnv(ctx.configDir, () => client.login(creds));
      return lineSession(client);
    },

    isAuthError: looksLikeAuthError,

    async cleanup(ctx) {
      await rm(join(ctx.configDir, "line-storage"), { recursive: true, force: true });
    },
  };
}
