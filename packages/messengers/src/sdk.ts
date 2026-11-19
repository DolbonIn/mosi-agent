/**
 * Narrow seams over agent-messenger@2.43.0 (MIT). Each provider gets a small interface listing
 * exactly the SDK calls this package makes; the default loaders below assign the real SDK
 * objects to those interfaces, so `tsc` verifies every call against the installed `.d.ts`.
 * Tests inject fakes through `new MessengerHub({ sdk: { kakaotalk: async () => fake } })`.
 *
 * SDK modules are imported lazily (first use), so a broken optional dependency only disables
 * that provider.
 */
import { join } from "node:path";
import { telegramAppFromEnv, type TelegramApp } from "./login/telegram";
import { sharedTdRuntime, type TdClient } from "./tdlib/runtime";
import type * as KakaoT from "agent-messenger/kakaotalk";
import type * as SlackT from "agent-messenger/slack";
import type * as LineT from "agent-messenger/line";
import type * as IgT from "agent-messenger/instagram";
import type * as TeamsT from "agent-messenger/teams";
import type * as WebexT from "agent-messenger/webex";
import type * as TgT from "agent-messenger/telegrambot";

// ───────────────────────────── KakaoTalk ─────────────────────────────

export type KakaoLoginResult = KakaoT.KakaoLoginResult & { credentials?: KakaoT.LoginCredentials };

export interface KakaoClientLike {
  login(c: { oauthToken: string; userId: string; deviceUuid?: string; deviceType?: KakaoT.KakaoDeviceType }): Promise<unknown>;
  getChats(o?: { all?: boolean; search?: string; resolveTitles?: boolean }): Promise<KakaoT.KakaoChat[]>;
  getMessages(chatId: string, o?: { count?: number; from?: string }): Promise<KakaoT.KakaoMessage[]>;
  /** read-only CHATINFO (+ open-link name): title, type, member count, unread */
  getChat(chatId: string): Promise<KakaoT.KakaoChat>;
  /** read-only CHATINFO + GETMEM (allowRoomEntry stays false: never advances the user's unread state) */
  getMemberSnapshot(chatId: string, o: { allowPartial: true }): Promise<KakaoT.KakaoMemberSnapshot | KakaoT.KakaoPartialMemberSnapshot>;
  /** MEMBER lookup for ids the snapshot lacks (people who left) */
  getMembersByIds(chatId: string, userIds: string[]): Promise<KakaoT.KakaoMember[]>;
  sendMessage(chatId: string, text: string): Promise<KakaoT.KakaoSendResult>;
  getProfile(): Promise<{ nickname: string; user_id: string }>;
  close(): void;
}

export interface KakaoSdk {
  attemptLogin(email: string, password: string, deviceUuid: string, deviceType: KakaoT.KakaoDeviceType, forced: boolean): Promise<KakaoLoginResult>;
  requestPasscode(email: string, password: string, deviceUuid: string): Promise<KakaoT.KakaoLoginResult>;
  registerDevice(email: string, password: string, passcode: string, deviceUuid: string): Promise<KakaoT.KakaoLoginResult>;
  generateDeviceUuid(): string;
  refreshKakaoOAuthToken(input: KakaoT.KakaoOAuthRefreshInput): Promise<KakaoT.KakaoOAuthRefreshResult>;
  classifyKakaoChat(chat: Pick<KakaoT.KakaoChat, "type" | "active_members">): KakaoT.KakaoChatKind;
  createClient(): KakaoClientLike;
}

// ───────────────────────────── Slack ─────────────────────────────

export interface SlackChannelLike { id: string; name: string; is_private?: boolean; is_archived?: boolean }
export interface SlackMessageLike { ts: string; text: string; user?: string; username?: string }
export interface SlackUserLike { id: string; name: string; real_name?: string }

export interface SlackClientLike {
  login(c: { token: string; cookie: string }): Promise<unknown>;
  testAuth(): Promise<{ user_id: string; team_id: string; user?: string; team?: string }>;
  listChannels(): Promise<SlackChannelLike[]>;
  listDMs(): Promise<SlackT.SlackDM[]>;
  listUsers(): Promise<SlackUserLike[]>;
  getMessages(channel: string, limit?: number): Promise<SlackMessageLike[]>;
  sendMessage(channel: string, text: string): Promise<SlackMessageLike>;
}
export interface SlackSdk {
  createClient(): SlackClientLike;
  /** Slack Web API base for calls the SDK has no method for (auth.signout); test seam, default https://slack.com/api */
  apiUrl?: string;
}

export interface SlackBotClientLike {
  login(c: { token: string }): Promise<unknown>;
  testAuth(): Promise<{ user_id: string; team_id: string; bot_id?: string; user?: string; team?: string }>;
  listChannels(o?: { limit?: number }): Promise<SlackChannelLike[]>;
  listUsers(o?: { limit?: number }): Promise<SlackUserLike[]>;
  getConversationHistory(channel: string, o?: { limit?: number }): Promise<SlackMessageLike[]>;
  postMessage(channel: string, text: string): Promise<SlackMessageLike>;
}
export interface SlackBotSdk { createClient(): SlackBotClientLike }

// ───────────────────────────── Discord ─────────────────────────────

export interface DiscordUserLike { id: string; username: string; global_name?: string }
export interface DiscordChannelLike { id: string; name: string; type: number }
export interface DiscordMessageLike { id: string; author: { id: string; username: string }; content: string; timestamp: string }

export interface DiscordClientLike {
  login(c: { token: string }): Promise<unknown>;
  testAuth(): Promise<DiscordUserLike>;
  listServers(): Promise<{ id: string; name: string }[]>;
  listChannels(serverId: string): Promise<DiscordChannelLike[]>;
  listDMChannels(): Promise<{ id: string; type: number; recipients: DiscordUserLike[]; name?: string }[]>;
  getMessages(channelId: string, limit?: number): Promise<DiscordMessageLike[]>;
  sendMessage(channelId: string, content: string): Promise<DiscordMessageLike>;
}
export interface DiscordSdk { createClient(): DiscordClientLike }

export interface DiscordBotClientLike {
  login(c: { token: string }): Promise<unknown>;
  testAuth(): Promise<DiscordUserLike>;
  listGuilds(): Promise<{ id: string; name: string }[]>;
  listChannels(guildId: string): Promise<DiscordChannelLike[]>;
  getMessages(channelId: string, limit?: number): Promise<DiscordMessageLike[]>;
  sendMessage(channelId: string, content: string): Promise<DiscordMessageLike>;
}
export interface DiscordBotSdk { createClient(): DiscordBotClientLike }

// ───────────────────────────── Telegram bot ─────────────────────────────

export interface TelegramBotClientLike {
  login(c: { token: string }): Promise<unknown>;
  getMe(): Promise<{ id: number; first_name: string; username?: string }>;
  getUpdates(o?: { limit?: number; timeout?: number }): Promise<TgT.TelegramUpdate[]>;
  sendMessage(chatId: number | string, text: string): Promise<{ message_id: number }>;
}
export interface TelegramBotSdk { createClient(): TelegramBotClientLike }

// ───────────────────────────── Telegram user (TDLib, see tdlib/runtime.ts) ─────────────────────────────

/** agent-messenger does not export its Telegram user client; TDLib runs through our own runtime instead. */
export interface TelegramUserSdk {
  /** a TDLib instance from the process-wide runtime */
  client(): Promise<TdClient>;
  /** the operator's api_id/api_hash (server env); null → "준비 중" */
  app(): TelegramApp | null;
}

// ───────────────────────────── LINE ─────────────────────────────

export interface LineClientLike {
  loginWithEmail(o: { email: string; password: string; onPincode: (pin: string) => void }): Promise<LineT.LineLoginResult>;
  login(c: LineT.LineAccountCredentials): Promise<unknown>;
  getChats(o?: { limit?: number }): Promise<LineT.LineChat[]>;
  getMessages(chatId: string, o?: { count?: number }): Promise<LineT.LineMessage[]>;
  sendMessage(chatId: string, text: string): Promise<LineT.LineSendResult>;
  close(): void;
}
export interface LineCredStoreLike {
  getAccount(accountId?: string): Promise<LineT.LineAccountCredentials | null>;
  removeAccount(accountId: string): Promise<void>;
}
export interface LineSdk {
  /** client + its credential store, both rooted at `configDir` */
  createSession(configDir: string): { client: LineClientLike; creds: LineCredStoreLike };
}

// ───────────────────────────── Instagram ─────────────────────────────

export interface InstagramClientLike {
  authenticate(username: string, password: string): Promise<{
    userId: string;
    requiresTwoFactor?: boolean;
    twoFactorInfo?: Record<string, unknown>;
    challengeRequired?: boolean;
    oneClickEmailAvailable?: boolean;
  }>;
  twoFactorLogin(username: string, code: string, twoFactorIdentifier: string): Promise<{ userId: string }>;
  getSessionState(): IgT.InstagramSessionState;
  loadSession(sessionPath: string): Promise<void>;
  setSessionPath(path: string): void;
  listChats(limit?: number): Promise<IgT.InstagramChatSummary[]>;
  searchChats(query: string, limit?: number): Promise<IgT.InstagramChatSummary[]>;
  getMessages(threadId: string, limit?: number): Promise<IgT.InstagramMessageSummary[]>;
  sendMessage(threadId: string, text: string): Promise<IgT.InstagramMessageSummary>;
}
export interface InstagramSdk { createClient(configDir: string): InstagramClientLike }

// ───────────────────────────── Teams ─────────────────────────────

/** Everything needed to restore/refresh a Teams device-code session (sealed into the vault). */
export interface TeamsAuth {
  token: string;
  tokenExpiresAt: string;
  accountType: TeamsT.TeamsAccountType;
  region: string;
  userName: string;
  /** full SDK config JSON (holds the AAD refresh token) — only ever stored sealed */
  config: string;
}
export interface TeamsClientLike {
  login(c: { token: string; tokenExpiresAt?: string; accountType?: TeamsT.TeamsAccountType }): Promise<unknown>;
  listChats(): Promise<{ id: string; type: "oneOnOne" | "group" | "self"; topic?: string; last_message?: string; last_message_at?: string }[]>;
  getChatMessages(chatId: string, limit?: number): Promise<TeamsT.TeamsMessage[]>;
  sendChatMessage(chatId: string, content: string): Promise<TeamsT.TeamsMessage>;
}
export interface TeamsSdk {
  /** runs the device-code flow; `onCode` fires once the user code is known */
  deviceLogin(configDir: string, onCode: (p: TeamsT.DeviceCodePrompt) => void): Promise<TeamsAuth>;
  refresh(configDir: string, auth: TeamsAuth): Promise<TeamsAuth>;
  createClient(configDir: string): TeamsClientLike;
}

// ───────────────────────────── Webex ─────────────────────────────

export interface WebexClientLike {
  login(c: { token: string; deviceUrl?: string; tokenType?: string }): Promise<unknown>;
  testAuth(): Promise<{ displayName: string; emails: string[] }>;
  listSpaces(o?: { max?: number }): Promise<WebexT.WebexSpace[]>;
  listMessages(roomId: string, o?: { max?: number }): Promise<WebexT.WebexMessage[]>;
  sendMessage(roomId: string, text: string): Promise<WebexT.WebexMessage>;
  dispose(): Promise<void>;
}
export interface WebexSdk {
  loginWithPassword(email: string, password: string): Promise<WebexT.PasswordLoginResult>;
  createClient(): WebexClientLike;
}

// ───────────────────────────── factories ─────────────────────────────

export interface SdkFactories {
  kakaotalk(): Promise<KakaoSdk>;
  slack(): Promise<SlackSdk>;
  slackbot(): Promise<SlackBotSdk>;
  discord(): Promise<DiscordSdk>;
  discordbot(): Promise<DiscordBotSdk>;
  telegrambot(): Promise<TelegramBotSdk>;
  telegram(): Promise<TelegramUserSdk>;
  line(): Promise<LineSdk>;
  instagram(): Promise<InstagramSdk>;
  teams(): Promise<TeamsSdk>;
  webex(): Promise<WebexSdk>;
}

export const defaultSdk: SdkFactories = {
  async kakaotalk() {
    const m = await import("agent-messenger/kakaotalk");
    return {
      attemptLogin: (e, p, d, t, f) => m.attemptLogin(e, p, d, t, f),
      requestPasscode: (e, p, d) => m.requestPasscode(e, p, d),
      registerDevice: (e, p, c, d) => m.registerDevice(e, p, c, d),
      generateDeviceUuid: () => m.generateDeviceUuid(),
      refreshKakaoOAuthToken: (i) => m.refreshKakaoOAuthToken(i),
      classifyKakaoChat: (c) => m.classifyKakaoChat(c),
      createClient: () => new m.KakaoTalkClient(),
    };
  },
  async slack() {
    const m = await import("agent-messenger/slack");
    return { createClient: () => new m.SlackClient() };
  },
  async slackbot() {
    const m = await import("agent-messenger/slackbot");
    return { createClient: () => new m.SlackBotClient() };
  },
  async discord() {
    const m = await import("agent-messenger/discord");
    return { createClient: () => new m.DiscordClient() };
  },
  async discordbot() {
    const m = await import("agent-messenger/discordbot");
    return { createClient: () => new m.DiscordBotClient() };
  },
  async telegrambot() {
    const m = await import("agent-messenger/telegrambot");
    return { createClient: () => new m.TelegramBotClient() };
  },
  async telegram() {
    const app = telegramAppFromEnv();
    if (!app) throw new Error("telegram app not configured");
    const runtime = await sharedTdRuntime();
    return { client: async () => runtime.client(), app: () => app };
  },
  async line() {
    const m = await import("agent-messenger/line");
    return {
      createSession(configDir: string) {
        const creds = new m.LineCredentialManager(configDir);
        return { client: new m.LineClient(creds), creds };
      },
    };
  },
  async instagram() {
    const m = await import("agent-messenger/instagram");
    return { createClient: (configDir: string) => new m.InstagramClient(new m.InstagramCredentialManager(configDir)) };
  },
  async teams() {
    const m = await import("agent-messenger/teams");
    // The SDK keeps Teams auth in `<configDir>/teams-credentials.json`. We read it right after a
    // login/refresh, seal it into the vault, and clear the file again.
    const readAuth = async (cm: InstanceType<typeof m.TeamsCredentialManager>, userName?: string): Promise<TeamsAuth> => {
      try {
        const t = await cm.getTokenWithExpiry();
        const config = await cm.loadConfig();
        if (!t || !config) throw new Error("teams credentials missing after login");
        const current = await cm.getCurrentAccount();
        return {
          token: t.token,
          tokenExpiresAt: t.tokenExpiresAt ?? "",
          accountType: t.accountType ?? "work",
          region: t.region ?? "",
          userName: userName ?? current?.user_name ?? "",
          config: JSON.stringify(config),
        };
      } finally {
        await cm.clearCredentials().catch(() => {});
      }
    };
    return {
      async deviceLogin(configDir, onCode) {
        const cm = new m.TeamsCredentialManager(configDir);
        const res = await m.loginWithDeviceCode({ onCode, accountType: "work" }, cm);
        return readAuth(cm, res.userName);
      },
      async refresh(configDir, auth) {
        const cm = new m.TeamsCredentialManager(configDir);
        await cm.saveConfig(JSON.parse(auth.config) as TeamsT.TeamsConfig);
        const ok = await m.refreshDeviceCodeAccount(auth.accountType, cm);
        if (!ok) {
          await cm.clearCredentials().catch(() => {});
          throw Object.assign(new Error("teams token refresh failed"), { code: "refresh_rejected" });
        }
        return readAuth(cm, auth.userName);
      },
      createClient: (configDir: string) => new m.TeamsClient(new m.TeamsCredentialManager(configDir)),
    };
  },
  async webex() {
    const m = await import("agent-messenger/webex");
    return {
      loginWithPassword: (e, p) => m.loginWithPassword(e, p),
      createClient: () => new m.WebexClient(),
    };
  },
};

/** The SDK subpath each provider needs (for availability probing). */
export const SDK_SUBPATH: Record<keyof SdkFactories, string> = {
  kakaotalk: "agent-messenger/kakaotalk",
  slack: "agent-messenger/slack",
  slackbot: "agent-messenger/slackbot",
  discord: "agent-messenger/discord",
  discordbot: "agent-messenger/discordbot",
  telegrambot: "agent-messenger/telegrambot",
  // TDLib through koffi + prebuilt-tdlib (agent-messenger's optional deps); availability also needs the operator's api_id
  telegram: "agent-messenger/package.json",
  line: "agent-messenger/line",
  instagram: "agent-messenger/instagram",
  teams: "agent-messenger/teams",
  webex: "agent-messenger/webex",
};

/** `<configRoot>/<userId>` with a filesystem-safe user segment. */
export function userConfigDir(configRoot: string, userId: string): string {
  const safe = /^[A-Za-z0-9_-]{1,64}$/.test(userId) ? userId : `u_${Bun.hash(userId).toString(16)}`;
  return join(configRoot, safe);
}
