import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Connection, KeepFor, SaveCredentialRequest } from "@pickle/protocol";
import type { ToolContext, ToolStore } from "@pickle/agent";
import { Enclave, MemoryVaultStorage, Vault } from "@pickle/vault";
import { maskHint, sealForEnclave } from "@pickle/vault/client";
import type { KakaoChat, KakaoMember, KakaoMessage } from "agent-messenger/kakaotalk";
import { MessengerHub, providerName, type MessengerStorage, type SdkFactories } from "../src/index.ts";
import type { KakaoClientLike, KakaoSdk, SlackClientLike } from "../src/sdk.ts";
import { fakeSlackWeb, type FakeSlackWeb } from "./fake-slack-web.ts";

export class MemoryMessengerStorage implements MessengerStorage {
  readonly rows = new Map<string, Connection & { meta: string | null }>();
  private k(u: string, p: string) {
    return `${u}:${p}`;
  }
  async getConnection(userId: string, provider: string) {
    const r = this.rows.get(this.k(userId, provider));
    return r ? { ...r } : null;
  }
  async listConnections(userId: string): Promise<Connection[]> {
    return [...this.rows.entries()].filter(([k]) => k.startsWith(`${userId}:`)).map(([, v]) => ({ ...v }));
  }
  async upsertConnection(userId: string, c: Connection & { meta?: string | null }) {
    const prev = this.rows.get(this.k(userId, c.provider));
    this.rows.set(this.k(userId, c.provider), { ...c, meta: c.meta === undefined ? (prev?.meta ?? null) : c.meta });
  }
  async deleteConnection(userId: string, provider: string) {
    this.rows.delete(this.k(userId, provider));
  }
}

export function gate() {
  let open!: () => void;
  const p = new Promise<void>((r) => (open = r));
  return { wait: () => p, open };
}

// ───────────────────────────── fake KakaoTalk SDK ─────────────────────────────

export const KAKAO_EMAIL = "haneul@kakao.com";
export const KAKAO_PASSWORD = "카톡-비번-🔒-hunter2";

export const KAKAO_CHATS: KakaoChat[] = [
  {
    chat_id: "1001",
    type: 0,
    display_name: "엄마",
    title: null,
    active_members: 2,
    unread_count: 1,
    last_message: { author_id: 5, author_name: "엄마", message: "밥 먹었니?", sent_at: 1_731_300_000 },
  },
  {
    chat_id: "1002",
    type: 1,
    display_name: "민지, 준호",
    title: "가족 단톡방",
    active_members: 4,
    unread_count: 0,
    last_message: { author_id: 6, author_name: "민지", message: "주말에 봐요", sent_at: 1_731_300_100 },
  },
  { chat_id: "1003", type: 1, display_name: null, title: "회사 동기", active_members: 12, unread_count: 3, last_message: null },
  { chat_id: "1004", type: 1, display_name: null, title: "가족 여행", active_members: 3, unread_count: 0, last_message: null },
];

/** An extra room for the fake client (e.g. test/fixtures/kakao-room.ts). */
export interface FakeKakaoRoom {
  chat: KakaoChat;
  logs: KakaoMessage[];
  members: KakaoMember[];
  /** members who left: only getMembersByIds knows them */
  left?: KakaoMember[];
}

const fakeMember = (user_id: string, nickname: string): KakaoMember => ({
  user_id,
  nickname,
  profile_image_url: null,
  full_profile_image_url: null,
  original_profile_image_url: null,
  status_message: null,
  country_iso: null,
  user_type: 100,
  open_token: null,
  open_profile_link_id: null,
  open_permission: null,
});

export function fakeKakao(
  opts: { registered?: boolean; registerGate?: { wait(): Promise<void> }; registerError?: string; rooms?: FakeKakaoRoom[]; userId?: string } = {},
) {
  const rooms = opts.rooms ?? [];
  const chats = [...KAKAO_CHATS, ...rooms.map((r) => r.chat)];
  const userId = opts.userId ?? "777";
  const state = {
    registered: opts.registered ?? true,
    access: "kakao-access-1",
    refresh: "kakao-refresh-1",
    valid: new Set(["kakao-access-1"]),
    loginCalls: [] as { email: string; password: string; deviceUuid: string; deviceType: string; forced: boolean }[],
    generated: 0,
    refreshCalls: [] as { accessToken: string; refreshToken: string; deviceUuid: string }[],
    sent: [] as { chatId: string; text: string }[],
    clients: [] as { token: string | null; closed: boolean }[],
  };
  const sdk: KakaoSdk = {
    async attemptLogin(email, password, deviceUuid, deviceType, forced) {
      state.loginCalls.push({ email, password, deviceUuid, deviceType, forced });
      if (email !== KAKAO_EMAIL || password !== KAKAO_PASSWORD) {
        return { authenticated: false, error: "bad_credentials", message: `Login failed: ${email} wrong password` };
      }
      if (!state.registered) return { authenticated: false, next_action: "provide_passcode", message: "Device not registered." };
      return {
        authenticated: true,
        credentials: { access_token: state.access, refresh_token: state.refresh, user_id: userId, device_uuid: deviceUuid, device_type: "tablet" },
      };
    },
    async requestPasscode() {
      return { authenticated: false, next_action: "confirm_on_phone", passcode: "4821", remaining_seconds: 180 };
    },
    async registerDevice() {
      await opts.registerGate?.wait();
      if (opts.registerError) return { authenticated: false, error: opts.registerError, message: "x" };
      state.registered = true;
      return { authenticated: false, message: "Device registered." };
    },
    generateDeviceUuid() {
      state.generated++;
      return `device-uuid-${state.generated}`;
    },
    async refreshKakaoOAuthToken(input) {
      state.refreshCalls.push(input);
      if (input.refreshToken !== state.refresh) throw Object.assign(new Error("refresh rejected"), { code: "refresh_rejected" });
      state.access = "kakao-access-2";
      state.refresh = "kakao-refresh-2";
      state.valid.add(state.access);
      return { accessToken: state.access, refreshToken: state.refresh };
    },
    classifyKakaoChat: (c) => ([2, 13, 14, 15, 16, "OM", "OD"].includes(c.type) ? "open" : c.active_members <= 2 ? "dm" : "group"),
    createClient(): KakaoClientLike {
      const rec = { token: null as string | null, closed: false };
      state.clients.push(rec);
      const check = () => {
        if (!rec.token || !state.valid.has(rec.token)) {
          throw Object.assign(new Error("KakaoTalk LOGINLIST invalid access token (status -950)"), { code: "invalid_access_token", serverStatus: -950 });
        }
      };
      return {
        async login(c) {
          rec.token = c.oauthToken;
        },
        async getChats(o) {
          check();
          return chats.filter((c) => !o?.search || (c.title ?? c.display_name ?? "").includes(o.search));
        },
        async getChat(chatId) {
          check();
          const c = chats.find((x) => x.chat_id === chatId);
          if (!c) throw Object.assign(new Error("CHATINFO missing"), { code: "get_chat_failed" });
          return c;
        },
        async getMemberSnapshot(chatId) {
          check();
          const room = rooms.find((r) => r.chat.chat_id === chatId);
          const members = room ? room.members : [fakeMember(userId, "하늘"), fakeMember("6", "민지"), fakeMember("7", "준호")];
          return { chat_id: chatId, active_members: members.length, members, complete: true, consistency_basis: "stable_double_read_chatinfo_getmem" };
        },
        async getMembersByIds(chatId, ids) {
          check();
          const room = rooms.find((r) => r.chat.chat_id === chatId);
          return [...(room?.members ?? []), ...(room?.left ?? [])].filter((m) => ids.includes(m.user_id));
        },
        async getMessages(chatId, o) {
          check();
          const room = rooms.find((r) => r.chat.chat_id === chatId);
          if (room) return room.logs.slice(-(o?.count ?? 20));
          const msgs: KakaoMessage[] = [
            { log_id: "1", type: 1, author_id: 6, author_name: "민지", message: "이번 주말 어때?", attachment: null, sent_at: 1_731_300_000 },
            { log_id: "2", type: 1, author_id: 7, author_name: "준호", message: "좋아요!", attachment: null, sent_at: 1_731_300_060 },
            { log_id: "3", type: 1, author_id: 6, author_name: "민지", message: `방 ${chatId}`, attachment: null, sent_at: 1_731_300_120 },
          ];
          return msgs.slice(-(o?.count ?? 20));
        },
        async sendMessage(chatId, text) {
          check();
          state.sent.push({ chatId, text });
          return { success: true, status_code: 0, chat_id: chatId, log_id: `log-${state.sent.length}`, sent_at: 1_731_300_200 };
        },
        async getProfile() {
          return { nickname: "하늘", user_id: userId };
        },
        close() {
          rec.closed = true;
        },
      };
    },
  };
  return { sdk, state };
}

// ───────────────────────────── fake Slack SDK ─────────────────────────────

/** fake Slack Web APIs this file started (fakeSlack without one of its own); `harness().cleanup()` stops them */
const ownSlackApis = new Set<FakeSlackWeb>();

/**
 * The Slack SDK the hub loads for the user session. The adapter talks to Slack's Web API with fetch (auth.test at
 * login, listing, reading, sending), so this is mostly `apiUrl`: `web` (test/fake-slack-web.ts), or a fake of its own
 * with the default data — local, never slack.com. `state.logins` = the session each auth.test carried,
 * `state.sent` = chat.postMessage calls.
 */
export function fakeSlack(web?: FakeSlackWeb) {
  const api = web ?? fakeSlackWeb();
  if (!web) ownSlackApis.add(api);
  const state = {
    get logins() {
      return api.calls
        .filter((c) => c.method === "auth.test")
        .map((c) => ({ token: (c.authorization ?? "").replace(/^Bearer /, ""), cookie: (c.cookie ?? "").replace(/^d=/, "") }));
    },
    get sent() {
      return api.calls.filter((c) => c.method === "chat.postMessage").map((c) => ({ channel: c.params.channel ?? "", text: c.params.text ?? "" }));
    },
  };
  const unused = () => {
    throw new Error("the Slack user session does not use agent-messenger's client");
  };
  const client = { login: unused, testAuth: unused, listChannels: unused, listDMs: unused, listUsers: unused, getMessages: unused, sendMessage: unused } as unknown as SlackClientLike;
  return { sdk: { createClient: () => client, apiUrl: api.url }, state, web: api };
}

// ───────────────────────────── harness ─────────────────────────────

export interface Harness {
  dir: string;
  enclave: Enclave;
  vault: Vault;
  vaultStorage: MemoryVaultStorage;
  storage: MemoryMessengerStorage;
  hub: MessengerHub;
  updates: { userId: string; c: Connection }[];
  clock: { t: number };
  cleanup(): Promise<void>;
}

export async function harness(sdk: Partial<SdkFactories>): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), "pickle-msg-"));
  const masterKey = crypto.getRandomValues(new Uint8Array(32));
  const enclave = await Enclave.load({ dir: join(dir, "enclave"), masterKey });
  const clock = { t: Date.now() };
  const vaultStorage = new MemoryVaultStorage();
  const vault = new Vault({ enclave, masterKey, storage: vaultStorage, serviceName: providerName, now: () => clock.t });
  const storage = new MemoryMessengerStorage();
  const updates: { userId: string; c: Connection }[] = [];
  const hub = new MessengerHub({
    vault,
    storage,
    configRoot: join(dir, "messengers"),
    onUpdate: (userId, c) => updates.push({ userId, c }),
    sdk,
    now: () => clock.t,
  });
  return {
    dir,
    enclave,
    vault,
    vaultStorage,
    storage,
    hub,
    updates,
    clock,
    async cleanup() {
      await hub.shutdown();
      for (const api of ownSlackApis) api.stop();
      ownSlackApis.clear();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/** What the phone does: seal the login for the enclave; the server only sees the envelope. */
export async function sealedLogin(
  h: Harness,
  userId: string,
  service: string,
  secret: Record<string, string>,
  kind: "login" | "token" = "login",
  keepFor: KeepFor = "7d",
): Promise<SaveCredentialRequest> {
  const first = Object.values(secret)[0] ?? "";
  return {
    service,
    label: `${providerName(service)} (${maskHint(kind, first)})`,
    kind,
    hint: maskHint(kind, first),
    keepFor,
    envelope: await sealForEnclave(h.enclave.info(), secret, `${userId}:${service}:${kind}`),
  };
}

export function toolCtx(h: Harness, userId: string): ToolContext {
  return {
    userId,
    threadId: "t1",
    agentName: "깽이",
    displayName: "하늘",
    workspaceDir: h.dir,
    signal: new AbortController().signal,
    credentials: h.vault.access(userId, { actor: "agent", deviceVerified: true }),
    store: {} as ToolStore,
    status() {},
    now: () => new Date(h.clock.t),
  };
}
