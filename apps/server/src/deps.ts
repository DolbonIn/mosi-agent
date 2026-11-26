/**
 * Dependency contracts for createApp(). These are structural mirrors of the package APIs pinned in
 * docs/architecture/PACKAGES.md, so the real classes satisfy them and tests can pass small fakes
 * without importing any package at runtime.
 */
import type {
  AccessRecord,
  AgentPatch,
  AgentProfile,
  AgentStatus,
  AvatarSpec,
  Connection,
  ConnectRequest,
  ConnectResponse,
  CredentialInfo,
  EnclaveEnvelope,
  EnclaveInfo,
  KeepFor,
  MessengerChat,
  ProviderInfo,
  SaveCredentialRequest,
  SkillInfo,
} from "@pickle/protocol";
import type { ConnectionRegistry, ConnectionService, CredentialAccess, RunTurn, ToolDef, TurnOutcome } from "@pickle/agent";
import type { Db } from "./db/index.ts";

export interface LeaseLike {
  release(): void;
  steer(text: string): void;
  drain(): string[];
  /** queued steered messages, without draining them (@pickle/launcher Lease.pending → TurnInput.steerPending) */
  pending?(): number;
}

export interface LauncherLike {
  provision(
    userId: string,
    init: { agentName: string; displayName: string; persona?: string; avatar?: AvatarSpec; enabledSkills?: string[] },
  ): Promise<AgentProfile>;
  profile(userId: string): Promise<AgentProfile | null>;
  /** merged inside the per-user queue (@pickle/launcher applyAgentPatch); `changed` = a value moved and rev went up */
  update(userId: string, patch: AgentPatch, opts?: { allSkills?: readonly string[] }): Promise<{ profile: AgentProfile; changed: boolean }>;
  workspaceDir(userId: string): string;
  systemPrompt(
    userId: string,
    ctx: { displayName: string; now: Date; mode: "text" | "voice"; connections: string[]; skills: string[]; recalled: string[] },
  ): Promise<string>;
  appendDaily(userId: string, e: { user: string; assistant: string; at: Date }): Promise<void>;
  remember(userId: string, text: string): Promise<{ id: string }>;
  recall(userId: string, query: string, limit?: number): Promise<string[]>;
  listMemories(userId: string): Promise<{ id: string; text: string; createdAt: number }[]>;
  forget(userId: string, id: string): Promise<boolean>;
  acquire(userId: string): Promise<LeaseLike>;
  tryAcquire(userId: string): LeaseLike | null;
  steer(userId: string, text: string): boolean;
  status(userId: string): AgentStatus;
  setStatus(userId: string, s: AgentStatus): void;
  restart(userId: string): Promise<void>;
  /** boot-time repair of agent dirs (never deletes) */
  reconcile?(userIds: string[]): Promise<unknown>;
}

export interface VaultLike {
  save(userId: string, req: SaveCredentialRequest): Promise<CredentialInfo>;
  list(userId: string): Promise<CredentialInfo[]>;
  renew(userId: string, id: string, keepFor: KeepFor): Promise<CredentialInfo>;
  remove(userId: string, id: string): Promise<boolean>;
  access(userId: string, opts?: { actor?: "agent" | "user" | "system"; deviceVerified?: boolean }): CredentialAccess;
  record(userId: string, rec: Omit<AccessRecord, "id" | "createdAt">): Promise<void>;
  accessLog(userId: string, limit?: number): Promise<AccessRecord[]>;
  /** seal a secret produced server-side (the Slack login relay's session token + cookie); @pickle/vault Vault.saveSystem */
  saveSystem?(
    userId: string,
    i: { service: string; label: string; kind: "login" | "card" | "token"; hint: string; keepFor: KeepFor; secret: Record<string, string> },
  ): Promise<CredentialInfo>;
}

export interface EnclaveLike {
  info(): EnclaveInfo;
  /** open a device-sealed envelope without storing it (login relay inputs); @pickle/vault Enclave.openEnvelope */
  openEnvelope?(env: EnclaveEnvelope, expectedAad: string): Promise<Record<string, string>>;
}

export interface HubLike {
  /** `opts.session`: req.credentialId is a session the server obtained (login relay) — the connection owns it, so
   *  disconnect / re-login remove it (@pickle/messengers ConnectOptions) */
  connect(userId: string, provider: string, req: ConnectRequest, opts?: { session?: boolean }): Promise<ConnectResponse>;
  verify(userId: string, provider: string, code: string): Promise<ConnectResponse>;
  disconnect(userId: string, provider: string): Promise<void>;
  connections(userId: string): Promise<Connection[]>;
  listChats(userId: string, provider: string, opts?: { search?: string; limit?: number }): Promise<MessengerChat[]>;
  tools(): ToolDef[];
  shutdown(): Promise<void>;
}

export interface SkillsLike {
  listSkills(): SkillInfo[];
  skillTools(enabled?: string[]): ToolDef[];
  skillCatalogForPrompt(enabled?: string[]): string;
  /** @pickle/skills httpStats(): upstream call/cache counters (numbers only) */
  httpStats?(): Record<string, unknown>;
  /** @pickle/skills connectionServices(): the k-skill services a person connects with their own account */
  connectionServices?(): ConnectionService[];
}

/**
 * k-skill logins (@pickle/agent ConnectionRegistry, docs/architecture/KSKILL-CONNECTIONS.md): the catalog, per-user
 * resolvers for ToolContext.connections, verify after a save, wake waiting turns, revoke on disconnect.
 */
export type ConnectionsLike = Pick<
  ConnectionRegistry,
  "catalog" | "service" | "isService" | "serviceName" | "forUser" | "status" | "verify" | "notifyConnected" | "revoke" | "forget" | "sessionFor"
>;

/** Bound helpers over the agent package's LlmClient (null when no key is configured). */
export interface LlmHelpers {
  model: string;
  extractMemories(i: { userText: string; assistantText: string; existing: string[] }): Promise<string[]>;
  titleFor(text: string): Promise<string>;
  /** one plain-text call (no tools, hidden reasoning off) streamed as text deltas — meeting answers and summaries (meet.ts) */
  chat?(i: import("./meet.ts").ChatRequest): AsyncIterable<string>;
  /** who an unnamed meeting line is for, in conversation mode (meetAddressee.ts); none → the name is needed every time */
  addressee?: import("./meetAddressee.ts").AddresseeClassifier;
  /** the meeting model's LlmClient with hidden reasoning off — tool-calling meeting answers (meetAgent.ts) */
  meetClient?: Pick<import("@pickle/agent").LlmClient, "stream" | "model">;
}

export interface Clock {
  now(): number;
}

export interface ServerConfig {
  dataDir: string;
  version: string;
  /** e.g. https://pickle.example.com — used for invite URLs; falls back to the request origin */
  publicOrigin: string | null;
  /** dev mode enables CORS for the Vite dev server */
  dev: boolean;
  /** built PWA (apps/mobile/dist); null/missing dir disables static serving */
  staticDir: string | null;
  dailyTokens: number;
  /** honour X-Forwarded-For for rate limiting (only behind a trusted proxy) */
  trustProxy: boolean;
  twilio: { accountSid: string; authToken: string; from: string } | null;
  /** local Drama-3 TTS service (services/tts); null = off (calls use <Say>, /api/tts answers 503) */
  tts: { url: string } | null;
  /** Google Meet browser bot (services/meet); null = off (sys_join_meet answers "not configured") */
  /**
   * services/meet; `conversationIdleMs` from MEET_CONVERSATION_IDLE_MS (meet.ts conversation mode), `turnHoldMs` from
   * MEET_TURN_HOLD_MS (an unfinished line waits for the rest), `yieldSyllables` from MEET_YIELD_SYLLABLES (talked over → stop)
   */
  meet: { url: string; conversationIdleMs?: number; turnHoldMs?: number; yieldSyllables?: number } | null;
  /** local STT (services/stt), probed for /api/health only — the meet bot calls it directly */
  stt: { url: string } | null;
  /** argon2id cost override (tests use a cheap setting) */
  passwordCost: { memoryCost?: number; timeCost?: number } | null;
  authRatePerMinute: number;
  /** abort a turn when runTurn emits nothing for this long */
  turnIdleTimeoutMs: number;
  turnMaxMs: number;
  /** after an abort/timeout, wait this long for runTurn (and its running tool) to wind down before releasing the lease */
  turnSettleMs: number;
  /** how long an interactive text turn waits for the owner to connect a k-skill login (TurnInput.connectionWaitMs) */
  connectionWaitMs: number;
  /** a saved k-skill login whose verify could not reach the upstream is checked again after each of these delays */
  connectionRecheckMs: number[];
  /** per k-skill service id: no re-check sooner than this (its verify spends the user's own API quota) */
  connectionRecheckFloorMs: Record<string, number>;
  schedulerIntervalMs: number;
  /**
   * invest (agent-runtime 2052): `sources` from PICKLE_INVEST_SOURCES=on — the public quote source (Yahoo) is called
   * only then (QA and tests never set it); `tossBase` from PICKLE_TOSS_BASE — no Toss call at all without it;
   * `outboundIp` from PICKLE_OUTBOUND_IP — shown for the Toss allowed-IP setting, never looked up
   */
  invest: { sources: boolean; tossBase: string | null; outboundIp: string | null };
  /** Web Push (push.ts, B1c): the VAPID contact from PICKLE_PUSH_SUBJECT (mailto: or https:); null = off, no push request */
  push: { subject: string } | null;
  sseHeartbeatMs: number;
  eventsHeartbeatMs: number;
  quiet: boolean;
}

export interface AppDeps {
  db: Db;
  launcher: LauncherLike;
  vault: VaultLike;
  enclave: EnclaveLike;
  hub: HubLike;
  providers: () => ProviderInfo[];
  runTurn: RunTurn | null;
  /** @pickle/agent partialOutcome: what a rejected runTurn already produced (e.g. an approved send that ran) */
  partialOutcome?: (err: unknown) => TurnOutcome | null;
  llm: LlmHelpers | null;
  skills: SkillsLike;
  systemTools: () => ToolDef[];
  verifyApproval: (publicJwk: JsonWebKey, approvalId: string, nonce: string, signatureB64url: string) => Promise<boolean>;
  clock?: Clock;
  config?: Partial<ServerConfig>;
  /** package load status for /api/health (filled by main.ts) */
  packages?: Record<string, string>;
  /** Slack login relay (slack-login/relay.ts): test seams (driver, URLs, timeouts); omitted → real Slack in headless Chrome */
  slackLogin?: import("./slack-login/relay.ts").SlackLoginOptions;
  /** Discord / Telegram login relay (messenger-login/relay.ts): test seams (fake gateway, fake TDLib, timeouts) */
  messengerLogin?: import("./messenger-login/relay.ts").MessengerLoginOptions;
  /** k-skill logins; omitted → a ConnectionRegistry over `vault` and `skills.connectionServices` (kskill.ts) */
  connections?: ConnectionsLike;
  /** background timers (the k-skill login re-checks); omitted → setTimeout/clearTimeout, unref'd */
  timers?: Timers;
  /** invest sources and Toss go through this fetch (tests: synthetic responses and the fake Toss); omitted → fetch */
  investFetch?: typeof fetch;
  /** Web Push requests go through this fetch (tests: a fake push service); omitted → fetch */
  pushFetch?: typeof fetch;
}

export interface Timers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}
