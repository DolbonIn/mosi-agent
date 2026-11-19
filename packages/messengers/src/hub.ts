/**
 * MessengerHub — connects a user's own messenger accounts and runs list/read/send for them.
 *
 * Secrets: the user's login (device-sealed) and the session tokens a login produces live only
 * in the vault. Every operation goes through `CredentialAccess.use()` on the session credential,
 * so the lending period is enforced and each use lands in the access log — even when a live
 * client is already cached. Nothing here logs; errors are mapped to fixed Korean messages.
 *
 * Connection.meta (JSON, never secret): { loginCredentialId, sessionCredentialId, ...adapter meta
 * such as KakaoTalk's deviceUuid }. The connection OWNS its session credential unless that is the
 * user's own saved login (token providers, loginCredentialId === sessionCredentialId): an owned
 * session is signed out (best-effort `revoke`) and deleted on disconnect, and likewise when a
 * re-login replaces it.
 * Sessions the server produced elsewhere (login relays) are handed over with
 * `connect(…, { credentialId }, { session: true })` and owned the same way.
 */
import type { ConnectRequest, ConnectResponse, Connection, ConnectionVerification, CredentialInfo, MessengerChat } from "@pickle/protocol";
import { MAX_MESSAGE_CHARS } from "@pickle/protocol";
import type { CredentialAccess, ToolDef } from "@pickle/agent";
import { VaultError, type Vault } from "@pickle/vault";
import { join } from "node:path";
import { discordAdapter, discordBotAdapter } from "./adapters/discord";
import { instagramAdapter } from "./adapters/instagram";
import { kakaoAdapter } from "./adapters/kakaotalk";
import { lineAdapter } from "./adapters/line";
import { slackAdapter, slackBotAdapter } from "./adapters/slack";
import { teamsAdapter } from "./adapters/teams";
import { telegramBotAdapter } from "./adapters/telegram";
import { telegramUserAdapter } from "./adapters/telegram-user";
import type { AdapterCtx, Connected, LoginOutcome, Meta, Pending, ProviderAdapter, Secret, Session, WithLogin } from "./adapters/types";
import { webexAdapter } from "./adapters/webex";
import { MessengerError, isNetworkError } from "./errors";
import { PROVIDER_IDS, isProviderId, probeProviders, providerInfo, type ProviderId } from "./providers";
import { defaultSdk, userConfigDir, type SdkFactories } from "./sdk";
import { messengerTools } from "./tools";
import { CONFIG_DIR_ENV, clip, type ChatMessage, type ThreadRead } from "./util";

/** Implemented by apps/server. `meta` is opaque JSON owned by the hub (never contains secrets). */
export interface MessengerStorage {
  getConnection(userId: string, provider: string): Promise<(Connection & { meta: string | null }) | null>;
  listConnections(userId: string): Promise<Connection[]>;
  upsertConnection(userId: string, c: Connection & { meta?: string | null }): Promise<void>;
  deleteConnection(userId: string, provider: string): Promise<void>;
}

export interface MessengerHubOptions {
  vault: Vault;
  storage: MessengerStorage;
  /** per-user SDK files go to `<configRoot>/<userId>` */
  configRoot: string;
  /** called whenever a connection changes (incl. background verification results) → SSE `connection` */
  onUpdate: (userId: string, c: Connection) => void;
  /** test seam: replace SDK modules with fakes */
  sdk?: Partial<SdkFactories>;
  /** close cached clients after this much inactivity (default 10 min) */
  idleMs?: number;
  /** disconnect waits at most this long for an adapter's sign-out (default 10 s) */
  revokeMs?: number;
  now?: () => number;
}

export interface ConnectOptions {
  /**
   * The credential (`req.credentialId`, kind "token") is a session the server already produced (a login relay
   * sealed it with `vault.saveSystem`), not a login the user saved: the connection owns it — it is deleted on
   * disconnect and replaced by the next login — and it never shows up as the connection's login.
   */
  session?: boolean;
}

type Purpose = { action: string; purpose: string };

interface PendingEntry {
  gen: number;
  verification: ConnectionVerification;
  submit?: Pending["submit"];
  loginCredentialId: string | null;
  credInfo: CredentialInfo | null;
  meta: Meta;
}

interface CacheEntry {
  session: Session;
  credentialId: string;
  timer: ReturnType<typeof setTimeout> | null;
}

const DEFAULT_IDLE_MS = 10 * 60_000;
const DEFAULT_REVOKE_MS = 10_000;
/** a Slack channel / group / DM id (C…, G…, D…): resolveChat names it without listing every chat */
const SLACK_CHAT_ID = /^[CGD][A-Z0-9]{8,}$/;
/** a KakaoTalk chat id: a Long, 13–20 digits (a phone number, 10–12, stays a name) */
const KAKAO_CHAT_ID = /^\d{13,20}$/;
/** a Discord channel / DM id: a snowflake, 17–20 digits (no phone number runs that long) */
const DISCORD_CHAT_ID = /^\d{17,20}$/;
/**
 * a Telegram chat id (TDLib and the Bot API alike): a basic group is negative (-…), a supergroup or channel -100…, a
 * private chat the user's own id (5–16 digits, a safe integer). A phone number written in digits stays a name: one
 * that starts with 0, or 82 plus a 9–10 digit number (821012345678). A 10-digit 82… is a user id (ids reach 8.2e9).
 */
const TELEGRAM_CHAT_ID = /^-?[1-9]\d{4,15}$/;
const TELEGRAM_PHONE = /^82\d{9,10}$/;
const isTelegramChatId = (s: string) => TELEGRAM_CHAT_ID.test(s) && Number.isSafeInteger(Number(s)) && !TELEGRAM_PHONE.test(s);
/** chats resolveChat remembers per user+provider (for synchronous approvals) */
const KNOWN_CHATS = 200;

function once<T>(f: () => Promise<T>): () => Promise<T> {
  let p: Promise<T> | null = null;
  return () => {
    if (!p) {
      p = f();
      p.catch(() => {
        p = null;
      });
    }
    return p;
  };
}

function parseMeta(raw: string | null | undefined): Meta {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Meta) : {};
  } catch {
    return {};
  }
}

function str(v: unknown): string | null {
  return typeof v === "string" && v ? v : null;
}

/** Strip storage-only fields so only the protocol `Connection` leaves the hub. */
function pub(c: Connection): Connection {
  return {
    provider: c.provider,
    status: c.status,
    accountLabel: c.accountLabel ?? null,
    credentialId: c.credentialId ?? null,
    lastError: c.lastError ?? null,
    connectedAt: c.connectedAt ?? null,
    updatedAt: c.updatedAt,
  };
}

export class MessengerHub {
  private readonly vault: Vault;
  private readonly storage: MessengerStorage;
  private readonly configRoot: string;
  private readonly onUpdate: (userId: string, c: Connection) => void;
  private readonly injected: Partial<SdkFactories>;
  private readonly idleMs: number;
  private readonly revokeMs: number;
  private readonly now: () => number;
  private readonly adapters: Record<ProviderId, ProviderAdapter>;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly opening = new Map<string, Promise<Session>>();
  private readonly reauthing = new Map<string, Promise<Session>>();
  private readonly pending = new Map<string, PendingEntry>();
  /** chats resolveChat named, per user+provider (newest last) — what approval cards show for an id */
  private readonly known = new Map<string, Map<string, MessengerChat>>();
  private readonly background = new Set<Promise<unknown>>();
  private gen = 0;
  private closed = false;

  constructor(opts: MessengerHubOptions) {
    this.vault = opts.vault;
    this.storage = opts.storage;
    this.configRoot = opts.configRoot;
    this.onUpdate = opts.onUpdate;
    this.injected = opts.sdk ?? {};
    this.idleMs = opts.idleMs ?? DEFAULT_IDLE_MS;
    this.revokeMs = opts.revokeMs ?? DEFAULT_REVOKE_MS;
    this.now = opts.now ?? Date.now;
    // SDK pieces that still resolve their config dir from the env (e.g. KakaoTalk's LOCO sync
    // state, keyed by device uuid) must not write into the server user's home directory.
    if (!process.env[CONFIG_DIR_ENV]) process.env[CONFIG_DIR_ENV] = join(this.configRoot, "_shared");
    const sdk: SdkFactories = { ...defaultSdk, ...this.injected };
    this.adapters = {
      kakaotalk: kakaoAdapter(once(() => sdk.kakaotalk())),
      slack: slackAdapter(once(() => sdk.slack())),
      slackbot: slackBotAdapter(once(() => sdk.slackbot())),
      discord: discordAdapter(once(() => sdk.discord())),
      discordbot: discordBotAdapter(once(() => sdk.discordbot())),
      telegrambot: telegramBotAdapter(once(() => sdk.telegrambot())),
      telegram: telegramUserAdapter(once(() => sdk.telegram())),
      line: lineAdapter(once(() => sdk.line())),
      instagram: instagramAdapter(once(() => sdk.instagram())),
      teams: teamsAdapter(once(() => sdk.teams())),
      webex: webexAdapter(once(() => sdk.webex())),
    };
    if (PROVIDER_IDS.some((id) => !this.injected[id])) probeProviders().catch(() => {});
  }

  // ───────────────────────────── connect / verify / disconnect ─────────────────────────────

  async connect(userId: string, provider: string, req: ConnectRequest, opts: ConnectOptions = {}): Promise<ConnectResponse> {
    const p = this.provider(provider);
    if (opts.session) return this.adopt(userId, p.id, req);
    let credInfo: CredentialInfo | null = null;
    if (req?.credential) {
      if (req.credential.service !== p.id) throw new MessengerError("invalid_request", "다른 서비스용 로그인 정보예요.");
      credInfo = await this.vault.save(userId, req.credential);
    } else if (req?.credentialId) {
      credInfo = (await this.vault.list(userId)).find((c) => c.id === req.credentialId) ?? null;
      if (!credInfo || credInfo.service !== p.id) {
        throw new MessengerError("credential_not_found", "저장된 로그인 정보를 찾을 수 없어요. 다시 입력해 주세요.");
      }
    } else if (p.auth !== "oauth") {
      throw new MessengerError("credential_required", `${p.name} 로그인 정보가 필요해요.`);
    }
    const loginCredentialId = credInfo?.id ?? null;
    const key = this.key(userId, p.id);
    this.pending.delete(key);

    const prev = await this.storage.getConnection(userId, p.id);
    const prevMeta = parseMeta(prev?.meta);
    await this.upsert(
      userId,
      { provider: p.id, status: "connecting", accountLabel: prev?.accountLabel ?? null, credentialId: loginCredentialId, lastError: null, connectedAt: null, updatedAt: this.now() },
      prevMeta,
    );
    const adapter = this.adapters[p.id];
    const ctx = this.ctx(userId);
    try {
      const outcome = loginCredentialId
        ? await this.vault
            .access(userId, { actor: "user" })
            .use(loginCredentialId, { action: "login", purpose: `${p.name} 연결` }, (secret) => adapter.login(ctx, secret, prevMeta))
        : await adapter.login(ctx, null, prevMeta);
      return await this.applyOutcome(userId, p.id, loginCredentialId, credInfo, outcome, prevMeta);
    } catch (e) {
      return { connection: await this.fail(userId, p.id, loginCredentialId, e, prevMeta) };
    }
  }

  async verify(userId: string, provider: string, code: string): Promise<ConnectResponse> {
    const p = this.provider(provider);
    const key = this.key(userId, p.id);
    const pend = this.pending.get(key);
    const current = await this.storage.getConnection(userId, p.id);
    if (!pend) {
      if (!current) throw new MessengerError("no_pending_verification", "진행 중인 인증이 없어요. 다시 연결해 주세요.");
      return { connection: pub(current) };
    }
    const base: Connection = current
      ? pub(current)
      : { provider: p.id, status: "needs_verification", accountLabel: null, credentialId: pend.loginCredentialId, lastError: null, connectedAt: null, updatedAt: this.now() };
    if (!pend.submit) return { connection: base, verification: pend.verification }; // display_code: still waiting on the phone
    if (pend.verification.expiresAt && this.now() > pend.verification.expiresAt) {
      this.pending.delete(key);
      const err = new MessengerError("verification_expired", "인증 시간이 지났어요. 다시 연결해 주세요.");
      return { connection: await this.fail(userId, p.id, pend.loginCredentialId, err, pend.meta) };
    }
    const clean = String(code ?? "").replace(/[\s-]/g, "");
    if (!/^\d{4,8}$/.test(clean)) throw new MessengerError("invalid_request", "숫자로 된 인증 코드를 입력해 주세요.");
    try {
      const outcome = await pend.submit(clean, this.withLogin(userId, pend.loginCredentialId));
      if (this.pending.get(key)?.gen === pend.gen) this.pending.delete(key);
      return await this.applyOutcome(userId, p.id, pend.loginCredentialId, pend.credInfo, outcome, pend.meta);
    } catch (e) {
      if (e instanceof MessengerError && e.code === "wrong_code") {
        const conn: Connection = { ...base, status: "needs_verification", lastError: e.message, updatedAt: this.now() };
        await this.upsert(userId, conn, pend.meta);
        return { connection: conn, verification: pend.verification };
      }
      this.pending.delete(key);
      return { connection: await this.fail(userId, p.id, pend.loginCredentialId, e, pend.meta) };
    }
  }

  async disconnect(userId: string, provider: string): Promise<void> {
    const key = this.key(userId, provider);
    this.pending.delete(key);
    this.known.delete(key);
    await this.closeSession(key);
    const conn = await this.storage.getConnection(userId, provider);
    const meta = parseMeta(conn?.meta);
    const sessionCred = str(meta.sessionCredentialId);
    const owned = sessionCred && sessionCred !== str(meta.loginCredentialId) ? sessionCred : null;
    // sign out first (it may need the provider files), then drop the files, then the sealed session
    if (isProviderId(provider)) {
      if (owned) await this.revoke(userId, provider, owned, meta);
      await this.adapters[provider].cleanup?.(this.ctx(userId)).catch(() => {});
    }
    if (owned) await this.vault.remove(userId, owned).catch(() => {});
    await this.storage.deleteConnection(userId, provider);
    this.emit(userId, { provider, status: "disconnected", accountLabel: null, credentialId: null, lastError: null, connectedAt: null, updatedAt: this.now() });
  }

  async connections(userId: string): Promise<Connection[]> {
    return (await this.storage.listConnections(userId)).map(pub);
  }

  /** One connection (protocol shape) or null. */
  async connection(userId: string, provider: string): Promise<Connection | null> {
    const c = await this.storage.getConnection(userId, provider);
    return c ? pub(c) : null;
  }

  // ───────────────────────────── operations ─────────────────────────────

  /**
   * `access` defaults to the user acting directly; tools pass `ctx.credentials` (actor "agent").
   * `signal` (tools pass `ctx.signal`): the caller gave up — adapters that can then stop their requests.
   */
  async listChats(
    userId: string,
    provider: string,
    opts: { search?: string; limit?: number; signal?: AbortSignal } = {},
    access?: CredentialAccess,
  ): Promise<MessengerChat[]> {
    const p = this.provider(provider);
    const limit = Math.max(1, Math.min(200, Math.floor(opts.limit ?? 50)));
    const search = opts.search?.trim() ? clip(opts.search.trim(), 80) : undefined;
    const signal = opts.signal;
    return this.run(userId, p.id, access, { action: "list_chats", purpose: `${p.name} 대화방 목록 보기` }, (s) => s.listChats({ search, limit, signal }));
  }

  async readMessages(userId: string, provider: string, chatId: string, limit = 20, access?: CredentialAccess, signal?: AbortSignal): Promise<ChatMessage[]> {
    return (await this.readThread(userId, provider, chatId, limit, access, signal)).messages;
  }

  /** Messages (normalised, oldest → newest) plus whatever room facts the provider knows. */
  async readThread(userId: string, provider: string, chatId: string, limit = 20, access?: CredentialAccess, signal?: AbortSignal): Promise<ThreadRead> {
    const p = this.provider(provider);
    if (!chatId) throw new MessengerError("invalid_request", "대화방을 지정해 주세요.");
    const n = Math.max(1, Math.min(100, Math.floor(limit)));
    return this.run(userId, p.id, access, { action: "read_messages", purpose: `${p.name} 메시지 읽기` }, async (s) =>
      s.readThread ? s.readThread(chatId, n, signal) : { room: {}, messages: await s.readMessages(chatId, n, signal) },
    );
  }

  async send(userId: string, provider: string, chatId: string, text: string, access?: CredentialAccess, signal?: AbortSignal): Promise<{ ok: boolean; id?: string }> {
    const p = this.provider(provider);
    if (!chatId) throw new MessengerError("invalid_request", "대화방을 지정해 주세요.");
    if (typeof text !== "string" || !text.trim()) throw new MessengerError("invalid_request", "보낼 내용이 비어 있어요.");
    if (text.length > MAX_MESSAGE_CHARS) throw new MessengerError("invalid_request", `메시지는 ${MAX_MESSAGE_CHARS}자까지 보낼 수 있어요.`);
    return this.run(userId, p.id, access, { action: "send_message", purpose: `${p.name} 메시지 보내기` }, (s) => s.send(chatId, text, signal));
  }

  /**
   * Resolve a chat by id or (unique) name. Throws chat_not_found / chat_ambiguous (with candidates).
   * A Slack id skips the listing: the session names it (its cached list, else one conversations.info). `forSend`: a
   * chat that cannot be named fails — an approval and a sent card must name the room; a read falls back to the id.
   * A KakaoTalk id skips the name search and is matched in one full listing.
   * So does a Discord or Telegram id (neither adapter can name one chat).
   */
  async resolveChat(
    userId: string,
    provider: string,
    chat: string,
    access?: CredentialAccess,
    signal?: AbortSignal,
    opts: { forSend?: boolean } = {},
  ): Promise<MessengerChat> {
    const q = String(chat ?? "").trim();
    if (!q) throw new MessengerError("invalid_request", "대화방 이름을 알려 주세요.");
    if (this.isChatId(provider, q)) {
      const p = this.provider(provider);
      const known = this.knownChat(userId, p.id, q);
      if (known) return known;
      // only an adapter that can name one chat opens the login here; the others name it through the listing below
      if (this.adapters[p.id].describesChats) {
        const named = await this.run(userId, p.id, access, { action: "list_chats", purpose: `${p.name} 대화방 확인` }, async (s) =>
          s.describeChat
            ? s.describeChat(q, signal).catch((e: unknown) => {
                if (opts.forSend || signal?.aborted) throw e;
                return null; // a read names the room itself, or fails on a wrong id
              })
            : null,
        );
        if (named) return this.remember(userId, p.id, named);
        if (opts.forSend) throw new MessengerError("chat_not_found", "보낼 대화방의 이름을 확인하지 못했어요. 대화방 이름으로 다시 알려 주세요.");
        return { id: q, name: q, kind: q.startsWith("D") ? "dm" : "channel" };
      }
    }
    const norm = (s: string) => s.replace(/^#/, "").trim().toLocaleLowerCase("ko");
    // an id is matched in the full list below (a name search would not find it): one listing, one access-log line
    const found = this.isChatId(provider, q) ? [] : await this.listChats(userId, provider, { search: q.replace(/^#/, ""), limit: 50, signal }, access);
    const byId = found.find((c) => c.id === q);
    if (byId) return this.remember(userId, provider, byId);
    const exact = found.filter((c) => norm(c.name) === norm(q));
    if (exact.length === 1) return exact[0]!;
    const pool = exact.length > 1 ? exact : found;
    if (pool.length === 1) return pool[0]!;
    if (pool.length > 1) {
      const names = pool.slice(0, 8).map((c) => c.name);
      throw new MessengerError("chat_ambiguous", `'${clip(q, 30)}'와(과) 비슷한 대화방이 여러 개예요. 어느 방인지 알려 주세요.`, { candidates: names });
    }
    const all = await this.listChats(userId, provider, { limit: 200, signal }, access);
    const id2 = all.find((c) => c.id === q);
    if (id2) return this.remember(userId, provider, id2);
    // an id-shaped room name (a title of 13+ digits): the name search was skipped, so match it in the same listing
    const sameName = this.isChatId(provider, q) ? all.filter((c) => norm(c.name) === norm(q)) : [];
    if (sameName.length === 1) return this.remember(userId, provider, sameName[0]!);
    throw new MessengerError("chat_not_found", `'${clip(q, 30)}' 대화방을 찾지 못했어요.`);
  }

  /** `chat` is a chat id (not a name): a Slack channel/DM id, or a KakaoTalk chat id. Step titles never show one. */
  isChatId(provider: string, chat: unknown): boolean {
    if (typeof chat !== "string") return false;
    if (provider === "slack" || provider === "slackbot") return SLACK_CHAT_ID.test(chat.trim());
    // and a Discord snowflake or a Telegram chat id (see their patterns above)
    if (provider === "discord" || provider === "discordbot") return DISCORD_CHAT_ID.test(chat.trim());
    if (provider === "telegram" || provider === "telegrambot") return isTelegramChatId(chat.trim());
    return provider === "kakaotalk" && KAKAO_CHAT_ID.test(chat.trim());
  }

  /** A chat this user's resolveChat already named, without a request (approval cards are built synchronously). */
  knownChat(userId: string, provider: string, chatId: string): MessengerChat | null {
    return this.known.get(this.key(userId, provider))?.get(String(chatId ?? "").trim()) ?? null;
  }

  private remember(userId: string, provider: string, chat: MessengerChat): MessengerChat {
    const key = this.key(userId, provider);
    let chats = this.known.get(key);
    if (!chats) this.known.set(key, (chats = new Map()));
    chats.delete(chat.id);
    chats.set(chat.id, chat);
    if (chats.size > KNOWN_CHATS) chats.delete(chats.keys().next().value!);
    return chat;
  }

  tools(): ToolDef[] {
    return messengerTools(this);
  }

  /** Close every cached client and stop background work. */
  async shutdown(): Promise<void> {
    this.closed = true;
    this.pending.clear();
    this.known.clear();
    await Promise.allSettled([...this.cache.keys()].map((k) => this.closeSession(k)));
    await this.idle();
  }

  /** Resolves when background verification tasks have settled (tests, graceful shutdown). */
  async idle(): Promise<void> {
    while (this.background.size) await Promise.allSettled([...this.background]);
  }

  // ───────────────────────────── internals: connect ─────────────────────────────

  /**
   * `connect(…, { session: true })`: validate a server-produced session (login relay) through the adapter and let
   * the connection own it (meta.loginCredentialId stays null). A login that would still need a code is refused —
   * the relay has already finished the provider's own login.
   */
  private async adopt(userId: string, provider: ProviderId, req: ConnectRequest): Promise<ConnectResponse> {
    const name = providerInfo(provider).name;
    const id = req?.credentialId;
    if (!id || req.credential) throw new MessengerError("invalid_request", "세션 연결에는 저장된 세션 하나만 넘겨 주세요.");
    const credInfo = (await this.vault.list(userId)).find((c) => c.id === id) ?? null;
    if (!credInfo || credInfo.service !== provider || credInfo.kind !== "token") {
      throw new MessengerError("credential_not_found", "저장된 로그인 정보를 찾을 수 없어요. 다시 입력해 주세요.");
    }
    const key = this.key(userId, provider);
    this.pending.delete(key);
    const prev = await this.storage.getConnection(userId, provider);
    const prevMeta = parseMeta(prev?.meta);
    await this.upsert(
      userId,
      { provider, status: "connecting", accountLabel: prev?.accountLabel ?? null, credentialId: null, lastError: null, connectedAt: null, updatedAt: this.now() },
      prevMeta,
    );
    const adapter = this.adapters[provider];
    const ctx = this.ctx(userId);
    try {
      const outcome = await this.vault
        .access(userId, { actor: "user" })
        .use(id, { action: "login", purpose: `${name} 연결` }, (secret) => adapter.login(ctx, secret, prevMeta));
      if (outcome.kind !== "connected") throw new MessengerError("upstream", `${name} 로그인을 마치지 못했어요. 다시 시도해 주세요.`);
      return { connection: await this.finishConnected(userId, provider, null, credInfo, outcome, prevMeta, id) };
    } catch (e) {
      return { connection: await this.fail(userId, provider, null, e, prevMeta) };
    }
  }

  private async applyOutcome(
    userId: string,
    provider: ProviderId,
    loginCredentialId: string | null,
    credInfo: CredentialInfo | null,
    outcome: LoginOutcome,
    prevMeta: Meta,
  ): Promise<ConnectResponse> {
    if (outcome.kind === "connected") {
      return { connection: await this.finishConnected(userId, provider, loginCredentialId, credInfo, outcome, prevMeta) };
    }
    const key = this.key(userId, provider);
    const gen = ++this.gen;
    const meta: Meta = { ...prevMeta, ...outcome.meta, loginCredentialId };
    const conn: Connection = {
      provider,
      status: "needs_verification",
      accountLabel: null,
      credentialId: loginCredentialId,
      lastError: null,
      connectedAt: null,
      updatedAt: this.now(),
    };
    await this.upsert(userId, conn, meta);
    this.pending.set(key, { gen, verification: outcome.verification, submit: outcome.submit, loginCredentialId, credInfo, meta });
    if (outcome.wait) {
      const isCurrent = () => !this.closed && this.pending.get(key)?.gen === gen;
      const task = outcome
        .wait(this.withLogin(userId, loginCredentialId))
        .then(async (c) => {
          if (!isCurrent()) {
            await c.session?.close();
            return;
          }
          this.pending.delete(key);
          await this.finishConnected(userId, provider, loginCredentialId, credInfo, c, meta);
        })
        .catch(async (e) => {
          if (!isCurrent()) return;
          this.pending.delete(key);
          await this.fail(userId, provider, loginCredentialId, e, meta).catch(() => {});
        });
      this.track(task);
    }
    return { connection: conn, verification: outcome.verification };
  }

  private async finishConnected(
    userId: string,
    provider: ProviderId,
    loginCredentialId: string | null,
    credInfo: CredentialInfo | null,
    c: Connected,
    prevMeta: Meta,
    /** session credential handed over with `{ session: true }` (owned by the connection) */
    adopted: string | null = null,
  ): Promise<Connection> {
    const p = providerInfo(provider);
    let sessionCredentialId = loginCredentialId ?? adopted;
    if (c.token && adopted) {
      await this.vault.update(userId, adopted, c.token); // keep ONE row: the adopted session now holds the adapter's token
    } else if (c.token) {
      const saved = await this.vault.saveSystem(userId, {
        service: provider,
        label: `${p.name} 세션`,
        kind: "token",
        hint: clip(credInfo?.hint || c.accountLabel || "", 64),
        keepFor: credInfo?.keepFor ?? "30d",
        secret: c.token,
      });
      sessionCredentialId = saved.id;
    }
    // the session this login replaces, when the connection owned it (never the user's own saved login)
    const old = str(prevMeta.sessionCredentialId);
    const replaced = old && old !== sessionCredentialId && old !== loginCredentialId && old !== str(prevMeta.loginCredentialId) ? old : null;
    if (!sessionCredentialId) throw new MessengerError("upstream", `${p.name} 로그인 결과를 저장하지 못했어요.`);
    const meta: Meta = { ...prevMeta, ...c.meta, loginCredentialId, sessionCredentialId };
    const now = this.now();
    const conn: Connection = {
      provider,
      status: "connected",
      accountLabel: c.accountLabel,
      credentialId: loginCredentialId ?? sessionCredentialId,
      lastError: null,
      connectedAt: now,
      updatedAt: now,
    };
    await this.upsert(userId, conn, meta);
    const key = this.key(userId, provider);
    if (replaced) await this.closeSession(key); // the old client goes before its sign-out reopens that session
    if (c.session) this.setCache(key, sessionCredentialId, c.session);
    else await this.closeSession(key);
    if (replaced) {
      // the new connection is already live; signing the old one out is best-effort and bounded (revokeMs)
      await this.revoke(userId, provider, replaced, prevMeta);
      await this.vault.remove(userId, replaced).catch(() => {});
    }
    return conn;
  }

  private async fail(userId: string, provider: ProviderId, credentialId: string | null, err: unknown, meta: Meta): Promise<Connection> {
    const prev = await this.storage.getConnection(userId, provider).catch(() => null);
    const conn: Connection = {
      provider,
      status: "error",
      accountLabel: prev?.accountLabel ?? null,
      credentialId,
      lastError: this.describe(err, provider),
      connectedAt: null,
      updatedAt: this.now(),
    };
    await this.upsert(userId, conn, meta);
    return conn;
  }

  private describe(err: unknown, provider: ProviderId): string {
    const name = providerInfo(provider).name;
    if (err instanceof MessengerError) return err.message;
    if (err instanceof VaultError) {
      if (err.code === "credential_expired") return "보관 기간이 끝난 로그인 정보예요. 다시 입력해 주세요.";
      if (err.code === "credential_not_found") return "저장된 로그인 정보를 찾을 수 없어요. 다시 입력해 주세요.";
      return "로그인 정보를 열지 못했어요. 다시 입력해 주세요.";
    }
    if (isNetworkError(err)) return `네트워크 문제로 ${name}에 연결하지 못했어요. 잠시 후 다시 시도해 주세요.`;
    return `${name}에 연결하지 못했어요. 잠시 후 다시 시도해 주세요.`;
  }

  /**
   * Best-effort sign-out of a session the connection owns (e.g. Telegram's logOut), inside an audited `use()`
   * (action "logout", so it lands in the access log). Bounded by `revokeMs` (the adapter's signal aborts then);
   * failures, an expired lending period and timeouts are swallowed — disconnect always completes.
   */
  private async revoke(userId: string, provider: ProviderId, credentialId: string, meta: Meta): Promise<void> {
    const adapter = this.adapters[provider];
    const revoke = adapter.revoke;
    if (!revoke) return;
    const ctx = this.ctx(userId);
    const ctrl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        ctrl.abort();
        resolve();
      }, this.revokeMs);
      (timer as { unref?: () => void }).unref?.();
    });
    const work = this.vault
      .access(userId, { actor: "user" })
      .use(credentialId, { action: "logout", purpose: `${providerInfo(provider).name} 연결 해제` }, (secret) => revoke.call(adapter, ctx, secret, meta, ctrl.signal))
      .catch(() => {});
    try {
      await Promise.race([work, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  private withLogin(userId: string, loginCredentialId: string | null): WithLogin {
    return <T>(purpose: string, fn: (secret: Secret) => Promise<T>): Promise<T> =>
      loginCredentialId
        ? this.vault.access(userId, { actor: "user" }).use(loginCredentialId, { action: "login", purpose }, fn)
        : fn({});
  }

  // ───────────────────────────── internals: sessions ─────────────────────────────

  private async run<T>(userId: string, provider: ProviderId, access: CredentialAccess | undefined, purpose: Purpose, fn: (s: Session) => Promise<T>): Promise<T> {
    const p = providerInfo(provider);
    const conn = await this.storage.getConnection(userId, provider);
    if (!conn || conn.status !== "connected") {
      throw new MessengerError("not_connected", `${p.name} 연결이 필요해요. 설정 → 연결에서 먼저 연결해 주세요.`);
    }
    const meta = parseMeta(conn.meta);
    const sessionCredId = str(meta.sessionCredentialId) ?? conn.credentialId;
    if (!sessionCredId) throw new MessengerError("not_connected", `${p.name} 연결이 필요해요. 설정 → 연결에서 먼저 연결해 주세요.`);
    const adapter = this.adapters[provider];
    const ctx = this.ctx(userId);
    const key = this.key(userId, provider);
    const acc = access ?? this.vault.access(userId, { actor: "user" });
    try {
      return await acc.use(sessionCredId, purpose, async (secret) => {
        const sessionSecret: Secret = { ...secret };
        const session = await this.sessionFor(key, sessionCredId, () => adapter.open(ctx, sessionSecret, meta));
        try {
          return await fn(session);
        } catch (e) {
          if (!adapter.isAuthError(e)) throw e;
          return await fn(await this.reauth(userId, provider, meta, sessionCredId, sessionSecret));
        }
      });
    } catch (e) {
      throw await this.operationError(e, userId, conn, meta, key);
    }
  }

  private async operationError(e: unknown, userId: string, conn: Connection, meta: Meta, key: string): Promise<MessengerError> {
    const provider = conn.provider as ProviderId;
    const name = providerInfo(provider).name;
    if (e instanceof VaultError && (e.code === "credential_expired" || e.code === "credential_not_found")) {
      await this.closeSession(key);
      const msg =
        e.code === "credential_expired"
          ? `${name} 로그인 보관 기간이 끝났어요. 다시 연결해 주세요.`
          : `${name} 로그인 정보가 삭제됐어요. 다시 연결해 주세요.`;
      await this.markError(userId, conn, meta, msg);
      return new MessengerError(e.code, msg);
    }
    if (e instanceof MessengerError) {
      if (e.code === "session_expired") {
        await this.closeSession(key);
        await this.markError(userId, conn, meta, e.message);
      }
      return e;
    }
    const code = String((e as { code?: unknown } | null)?.code ?? "");
    const msg = e instanceof Error ? e.message : "";
    if (/channel_not_found|not_in_channel|chat_not_found|unknown channel|invalid chat/i.test(`${code} ${msg}`)) {
      return new MessengerError("chat_not_found", "대화방을 찾지 못했어요. 대화방 목록을 다시 확인해 주세요.");
    }
    if (isNetworkError(e)) return new MessengerError("network", `네트워크 문제로 ${name}에 연결하지 못했어요. 잠시 후 다시 시도해 주세요.`);
    return new MessengerError("upstream", `${name}에서 요청을 처리하지 못했어요. 잠시 후 다시 시도해 주세요.`);
  }

  private async markError(userId: string, conn: Connection, meta: Meta, message: string): Promise<void> {
    await this.upsert(userId, { ...pub(conn), status: "error", lastError: message, updatedAt: this.now() }, meta).catch(() => {});
  }

  private sessionFor(key: string, credentialId: string, open: () => Promise<Session>): Promise<Session> {
    const hit = this.cache.get(key);
    if (hit && hit.credentialId === credentialId) {
      this.touch(key, hit);
      return Promise.resolve(hit.session);
    }
    const inflight = this.opening.get(key);
    if (inflight) return inflight;
    const p = open()
      .then((s) => {
        this.setCache(key, credentialId, s);
        return s;
      })
      .finally(() => this.opening.delete(key));
    this.opening.set(key, p);
    return p;
  }

  /**
   * Session no longer accepted: refresh tokens (KakaoTalk, Teams) or log in again with the saved
   * login (Webex, …); persist the new session secret with ONE vault write; reopen the client.
   * Concurrent callers share one attempt.
   */
  private reauth(userId: string, provider: ProviderId, meta: Meta, sessionCredId: string, oldSecret: Secret): Promise<Session> {
    const key = this.key(userId, provider);
    const inflight = this.reauthing.get(key);
    if (inflight) return inflight;
    const p = (async () => {
      const adapter = this.adapters[provider];
      const ctx = this.ctx(userId);
      const name = providerInfo(provider).name;
      await this.closeSession(key);
      let fresh: Secret | null = null;
      let reopened: Session | undefined;
      if (adapter.refresh) {
        try {
          fresh = await adapter.refresh(ctx, oldSecret, meta);
        } catch (e) {
          if (isNetworkError(e)) throw e;
          fresh = null;
        }
      }
      const loginCred = str(meta.loginCredentialId);
      if (!fresh && loginCred && loginCred !== sessionCredId) {
        const outcome = await this.vault
          .access(userId, { actor: "system" })
          .use(loginCred, { action: "login", purpose: `${name} 세션 갱신을 위한 다시 로그인` }, (s) => adapter.login(ctx, s, meta))
          .catch((e) => {
            if (isNetworkError(e)) throw e;
            return null;
          });
        if (outcome?.kind === "connected" && outcome.token) {
          fresh = outcome.token;
          reopened = outcome.session;
        } else if (outcome?.kind === "connected") {
          await outcome.session?.close();
        }
      }
      if (!fresh) throw new MessengerError("session_expired", `${name} 로그인이 만료됐어요. 다시 연결해 주세요.`);
      await this.vault.update(userId, sessionCredId, fresh);
      const session = reopened ?? (await adapter.open(ctx, fresh, meta));
      this.setCache(key, sessionCredId, session);
      return session;
    })().finally(() => this.reauthing.delete(key));
    this.reauthing.set(key, p);
    return p;
  }

  private setCache(key: string, credentialId: string, session: Session): void {
    const old = this.cache.get(key);
    if (old && old.session !== session) {
      if (old.timer) clearTimeout(old.timer);
      Promise.resolve()
        .then(() => old.session.close())
        .catch(() => {});
    }
    const entry: CacheEntry = { session, credentialId, timer: null };
    this.cache.set(key, entry);
    this.touch(key, entry);
  }

  private touch(key: string, entry: CacheEntry): void {
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      if (this.cache.get(key) === entry) void this.closeSession(key);
    }, this.idleMs);
    (entry.timer as { unref?: () => void }).unref?.();
  }

  private async closeSession(key: string): Promise<void> {
    const entry = this.cache.get(key);
    if (!entry) return;
    this.cache.delete(key);
    if (entry.timer) clearTimeout(entry.timer);
    try {
      await entry.session.close();
    } catch {
      /* ignore */
    }
  }

  /** test/diagnostic: is a live client cached for this user+provider? */
  hasLiveSession(userId: string, provider: string): boolean {
    return this.cache.has(this.key(userId, provider));
  }

  // ───────────────────────────── internals: misc ─────────────────────────────

  private provider(id: string) {
    if (!isProviderId(id)) throw new MessengerError("unknown_provider", "지원하지 않는 메신저예요.");
    const info = providerInfo(id);
    if (!this.injected[id] && !info.available) {
      throw new MessengerError("provider_unavailable", info.unavailableReason ?? `${info.name}은(는) 지금 사용할 수 없어요.`);
    }
    return info as typeof info & { id: ProviderId };
  }

  private ctx(userId: string): AdapterCtx {
    return { userId, configDir: userConfigDir(this.configRoot, userId), now: this.now };
  }

  private key(userId: string, provider: string): string {
    return `${userId}\u0000${provider}`;
  }

  private async upsert(userId: string, conn: Connection, meta: Meta): Promise<void> {
    await this.storage.upsertConnection(userId, { ...conn, meta: JSON.stringify(meta) });
    this.emit(userId, conn);
  }

  private emit(userId: string, conn: Connection): void {
    try {
      this.onUpdate(userId, pub(conn));
    } catch {
      /* listener errors must not break connection handling */
    }
  }

  private track(p: Promise<unknown>): void {
    this.background.add(p);
    p.finally(() => this.background.delete(p)).catch(() => {});
  }
}
