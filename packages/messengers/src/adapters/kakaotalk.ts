/**
 * KakaoTalk via agent-messenger's Android *tablet* sub-device login (the phone and the PC
 * desktop app keep working; a real tablet login would be replaced).
 *
 * Flow (same steps as the SDK's `loginFlow`, split so the HTTP request can return early):
 *   attemptLogin(email, pw, deviceUuid, "tablet", forced=false)
 *     ├─ ok → tokens
 *     └─ device not registered → requestPasscode → show the code to the user, who types it
 *        INTO THE KAKAOTALK APP ON THEIR PHONE → registerDevice polls (≤10×) → attemptLogin again
 * The device uuid is generated once per user and always reused (also after a failed passcode
 * step), so a registered device never needs the passcode again.
 * Expired access tokens (LOCO LOGINLIST status -950) are refreshed with the refresh token.
 */
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { MessengerChat } from "@pickle/protocol";
import { maskHint } from "@pickle/vault/client";
import { MessengerError, looksLikeAuthError } from "../errors";
import type { KakaoClientLike, KakaoLoginResult, KakaoSdk } from "../sdk";
import { clip, toMillis, type RoomInfo, type ThreadRead } from "../util";
import { exactId, normalizeKakao, unknownAuthorIds } from "./kakao-normalize";
import type { AdapterCtx, Connected, Meta, ProviderAdapter, Secret, Session } from "./types";
import { req } from "./types";

const DEVICE_FILE = "kakaotalk-device.json";
export const KAKAO_PASSCODE_PROMPT = "화면에 보이는 코드를 휴대폰 카카오톡에 입력해 주세요.";

export function kakaoError(r: Pick<KakaoLoginResult, "error" | "message" | "next_action">): MessengerError {
  switch (r.error) {
    case "bad_credentials":
      return new MessengerError("bad_credentials", "카카오계정 이메일 또는 비밀번호가 맞지 않아요.");
    case "login_failed":
      return new MessengerError(
        "login_rejected",
        "카카오톡이 로그인을 거절했어요. 다른 태블릿에서 이미 로그인 중이거나 2단계 인증을 쓰는 계정일 수 있어요. (2단계 인증 계정은 아직 연결할 수 없어요)",
      );
    case "registration_timeout":
      return new MessengerError("verification_expired", "기기 등록 확인 시간이 지났어요. 다시 연결해서 새 코드를 받아 주세요.");
    case "registration_failed":
      return new MessengerError("verification_failed", "새 기기 등록이 완료되지 않았어요. 다시 연결해 주세요.");
    case "login_http_error":
    case "passcode_request_failed":
      return new MessengerError("network", "카카오 서버와 통신하지 못했어요. 잠시 후 다시 시도해 주세요.");
    default:
      return new MessengerError("upstream", "카카오톡에 로그인하지 못했어요. 잠시 후 다시 시도해 주세요.");
  }
}

/** Reuse meta.deviceUuid → `<configDir>/kakaotalk-device.json` → generate + persist (0600). */
async function deviceUuidFor(ctx: AdapterCtx, sdk: KakaoSdk, meta: Meta): Promise<string> {
  const path = join(ctx.configDir, DEVICE_FILE);
  let fromFile: string | null = null;
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as { deviceUuid?: unknown };
    if (typeof parsed.deviceUuid === "string" && parsed.deviceUuid) fromFile = parsed.deviceUuid;
  } catch {
    /* none yet */
  }
  const id = (typeof meta.deviceUuid === "string" && meta.deviceUuid) || fromFile || sdk.generateDeviceUuid();
  if (id !== fromFile) {
    await mkdir(ctx.configDir, { recursive: true, mode: 0o700 });
    await writeFile(path, JSON.stringify({ deviceUuid: id, deviceType: "tablet", createdAt: ctx.now() }), { mode: 0o600 });
    await chmod(path, 0o600).catch(() => {});
  }
  return id;
}

function chatKind(sdk: KakaoSdk, c: Parameters<KakaoSdk["classifyKakaoChat"]>[0]): MessengerChat["kind"] {
  const k = sdk.classifyKakaoChat(c);
  return k === "dm" ? "dm" : "group";
}

/** An optional extra read: resolves null on error or after `ms` (the messages are what matter). */
async function soft<T>(p: Promise<T>, ms = 4000): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p.catch(() => null), new Promise<null>((r) => (timer = setTimeout(() => r(null), ms)))]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Messages + room facts. Everything here is read-only: MCHATLOGS for the logs, CHATINFO for the title/kind/member
 * count, GETMEM (snapshot, no room entry) for nicknames, MEMBER for authors who already left — so reading never marks
 * the room as read on the user's phone. Only the logs are required; the rest degrades to "unknown".
 */
async function readKakaoThread(sdk: KakaoSdk, client: KakaoClientLike, myUserId: string | null, chatId: string, limit: number): Promise<ThreadRead> {
  const logs = await client.getMessages(chatId, { count: Math.min(100, limit + 15) }); // + slack for dropped feeds
  const info = await soft(client.getChat(chatId));
  const snap = await soft(client.getMemberSnapshot(chatId, { allowPartial: true }));
  const names = new Map<string, string>();
  for (const m of snap?.members ?? []) if (m.nickname) names.set(exactId(m.user_id), m.nickname);
  const ctx = { myUserId, names };
  const missing = unknownAuthorIds(logs, ctx).slice(0, 100);
  if (missing.length) {
    for (const m of (await soft(client.getMembersByIds(chatId, missing))) ?? []) if (m.nickname) names.set(exactId(m.user_id), m.nickname);
  }
  const messages = normalizeKakao(logs, ctx, limit);
  const others = (snap?.members ?? []).filter((m) => exactId(m.user_id) !== myUserId).map((m) => m.nickname).filter(Boolean);
  const listed = info?.display_name ? info.display_name.split(/,\s*/).filter(Boolean) : [];
  const kind = info ? sdk.classifyKakaoChat(info) : null;
  const myName = myUserId ? names.get(myUserId) : undefined;
  const room: RoomInfo = {
    ...(info?.title?.trim() ? { title: info.title.trim() } : {}),
    ...(kind === "dm" || kind === "group" || kind === "open" ? { kind } : {}),
    ...(info?.active_members || snap?.active_members ? { memberCount: info?.active_members || snap?.active_members } : {}),
    ...(info?.unread_count ? { unread: info.unread_count } : {}),
    ...(others.length || listed.length ? { memberNames: others.length ? others : listed } : {}),
    ...(myName ? { myNames: [myName] } : {}),
  };
  return { room, messages };
}

function kakaoSession(sdk: KakaoSdk, client: KakaoClientLike, myUserId: string | null): Session {
  return {
    async listChats({ search, limit }) {
      const chats = await client.getChats({ search: search?.trim() || undefined, resolveTitles: Boolean(search) });
      return chats.slice(0, limit).map((c) => ({
        id: c.chat_id,
        name: c.title || c.display_name || "(이름 없는 대화방)",
        kind: chatKind(sdk, c),
        unread: c.unread_count,
        lastMessage: c.last_message ? clip(c.last_message.message, 80) : undefined,
        lastAt: c.last_message ? (toMillis(c.last_message.sent_at) ?? undefined) : undefined,
      }));
    },
    async readMessages(chatId, limit) {
      return (await readKakaoThread(sdk, client, myUserId, chatId, limit)).messages;
    },
    readThread(chatId, limit) {
      return readKakaoThread(sdk, client, myUserId, chatId, limit);
    },
    async send(chatId, text) {
      const r = await client.sendMessage(chatId, text);
      return { ok: r.success, id: r.log_id };
    },
    close() {
      client.close();
    },
  };
}

async function connectedFrom(
  sdk: KakaoSdk,
  creds: NonNullable<KakaoLoginResult["credentials"]>,
  email: string,
  deviceUuid: string,
): Promise<Connected> {
  const token: Secret = {
    access_token: creds.access_token,
    refresh_token: creds.refresh_token,
    user_id: creds.user_id,
    device_uuid: creds.device_uuid || deviceUuid,
    device_type: "tablet",
  };
  const client = sdk.createClient();
  await client.login({ oauthToken: token.access_token!, userId: token.user_id!, deviceUuid: token.device_uuid, deviceType: "tablet" });
  let nickname: string | null = null;
  try {
    nickname = (await client.getProfile()).nickname || null;
  } catch {
    /* label is cosmetic */
  }
  const masked = maskHint("login", email);
  return {
    kind: "connected",
    token,
    accountLabel: nickname ? clip(`${nickname} (${masked})`, 80) : masked,
    meta: { deviceUuid: token.device_uuid, deviceType: "tablet", kakaoUserId: creds.user_id },
    session: kakaoSession(sdk, client, token.user_id || null),
  };
}

export function kakaoAdapter(load: () => Promise<KakaoSdk>): ProviderAdapter {
  return {
    async login(ctx, secret, meta) {
      const email = req(secret, "email", "username", "id").trim();
      const password = req(secret, "password");
      if (!email || !password) throw new MessengerError("invalid_credential", "카카오계정 이메일과 비밀번호를 입력해 주세요.");
      const sdk = await load();
      const deviceUuid = await deviceUuidFor(ctx, sdk, meta);

      const first = await sdk.attemptLogin(email, password, deviceUuid, "tablet", false);
      if (first.authenticated && first.credentials?.access_token) return connectedFrom(sdk, first.credentials, email, deviceUuid);
      if (first.next_action !== "provide_passcode") throw kakaoError(first);

      const pc = await sdk.requestPasscode(email, password, deviceUuid);
      if (pc.error || !pc.passcode) throw kakaoError(pc.error ? pc : { error: "registration_failed" });
      const passcode = pc.passcode;
      return {
        kind: "pending",
        verification: {
          kind: "display_code",
          code: passcode,
          prompt: KAKAO_PASSCODE_PROMPT,
          expiresAt: ctx.now() + (pc.remaining_seconds && pc.remaining_seconds > 0 ? pc.remaining_seconds : 180) * 1000,
        },
        meta: { deviceUuid, deviceType: "tablet" },
        wait: (withLogin) =>
          withLogin("카카오톡 새 기기 등록 확인", async (s) => {
            const e2 = req(s, "email", "username", "id").trim();
            const p2 = req(s, "password");
            const reg = await sdk.registerDevice(e2, p2, passcode, deviceUuid);
            if (reg.error) throw kakaoError(reg);
            const again = await sdk.attemptLogin(e2, p2, deviceUuid, "tablet", false);
            if (!again.authenticated || !again.credentials?.access_token) throw kakaoError(again);
            return connectedFrom(sdk, again.credentials, e2, deviceUuid);
          }),
      };
    },

    async open(_ctx, s) {
      const sdk = await load();
      if (!s.access_token || !s.user_id) throw new MessengerError("session_expired", "카카오톡 로그인이 만료됐어요. 다시 연결해 주세요.");
      const client = sdk.createClient();
      await client.login({ oauthToken: s.access_token, userId: s.user_id, deviceUuid: s.device_uuid, deviceType: "tablet" });
      return kakaoSession(sdk, client, s.user_id);
    },

    async refresh(_ctx, s) {
      const sdk = await load();
      const r = await sdk.refreshKakaoOAuthToken({
        accessToken: s.access_token ?? "",
        refreshToken: s.refresh_token ?? "",
        deviceUuid: s.device_uuid ?? "",
      });
      return { ...s, access_token: r.accessToken, refresh_token: r.refreshToken || (s.refresh_token ?? "") };
    },

    isAuthError(err) {
      const code = (err as { code?: unknown } | null)?.code;
      if (code === "invalid_access_token") return true;
      if (code === "login_rejected") return false; // LOCO rejected for another reason (e.g. kicked) — don't loop on refresh
      return looksLikeAuthError(err);
    },
  };
}
