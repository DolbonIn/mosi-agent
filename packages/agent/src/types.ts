/**
 * Server-internal contracts shared by @pickle/agent, @pickle/skills, @pickle/messengers,
 * @pickle/vault, @pickle/launcher and apps/server. Wire types live in @pickle/protocol.
 */
import type { AgentEvent, ApprovalCall, ApprovalMeet, Card, CredentialField, IconName, ToolActivity } from "@pickle/protocol";

/** JSON Schema subset accepted by OpenAI-compatible tool calling. */
export interface JsonSchema {
  type: "object";
  properties: Record<string, JsonSchemaProp>;
  required?: string[];
  additionalProperties?: boolean;
}
export type JsonSchemaProp =
  | { type: "string"; description?: string; enum?: string[] }
  | { type: "number" | "integer"; description?: string; minimum?: number; maximum?: number }
  | { type: "boolean"; description?: string }
  | { type: "array"; description?: string; items: JsonSchemaProp | { type: "object"; properties: Record<string, JsonSchemaProp>; required?: string[] } };

/** What a tool returns. `data` goes back to the LLM (JSON, keep it small, ≤ 6 KB); `card` goes to the UI. */
export interface ToolResult {
  ok: boolean;
  /** one short Korean line shown in the activity chip, e.g. "서울 14°, 흐림" */
  summary: string;
  data?: unknown;
  card?: Card;
  /** cards after `card` from the same call, in order: a rows card continued on more cards (explore.ts '전부') */
  moreCards?: Card[];
  /** a durable fact the tool just saved; runTurn emits `{type:"memory", text}` for it ("기억했어요") */
  memory?: string;
  /**
   * The upstream refused the tool's login (missing, wrong or expired): runTurn posts the `connection_request`
   * card and waits for the user to connect, then retries (see docs/architecture/KSKILL-CONNECTIONS.md).
   */
  needsConnection?: ConnectionNeed;
}

/** A k-skill login a tool needs (ToolDef.connection) that the owner hasn't connected or that the upstream refused. */
export interface ConnectionNeed {
  service: string; // vault service id, e.g. "popbill"
  serviceName: string; // "팝빌"
  reason: string; // one Korean line: why the login is needed ("전자세금계산서를 발행하려면 팝빌 연결이 필요해요")
}

/**
 * The owner's unsealed login for one service, handed to a `connection` tool for the duration of run() only
 * (ToolContext.connection). The secret object is wiped when run() settles — don't keep references to it.
 */
export interface ConnectionHandle {
  readonly service: string;
  readonly credentialId: string;
  /** masked hint the user saw when saving ("ha***@…", "•••• 1234") */
  readonly hint: string;
  /** the fields as the user saved them on the device (e.g. {linkId, secretKey, userId}) */
  readonly secret: Readonly<Record<string, string>>;
  /** reseal rotated / refreshed values into the same vault row */
  update(secret: Record<string, string>): Promise<void>;
  /** per-owner, per-credential cache in server memory (cookies, access tokens); dropped on disconnect */
  readonly session: ConnectionSession;
}

export interface ConnectionSession {
  get<T = unknown>(): T | null;
  set(value: unknown, ttlMs: number): void;
  clear(): void;
}

/** Per-user resolver of k-skill logins (ToolContext.connections), built by the server from ConnectionRegistry.forUser. */
export interface ConnectionResolver {
  /** the newest usable login for the service, or null */
  find(service: string): Promise<{ credentialId: string; hint: string } | null>;
  /** unseal (audited as actor "agent"), call fn, wipe; throws ConnectionError "not_connected" / "expired" */
  use<T>(service: string, purpose: { action: string; purpose: string }, fn: (conn: ConnectionHandle) => Promise<T>): Promise<T>;
  /**
   * Resolves true once the service has a usable login other than `exclude` (the one the upstream just refused) —
   * at once when there already is one — and false on timeout or abort.
   */
  waitFor(service: string, o: { timeoutMs: number; signal: AbortSignal; exclude?: string }): Promise<boolean>;
  /** display name from the catalog ("팝빌"); the id when unknown */
  serviceName(service: string): string;
  /** true for a catalog service: plain tools can't reach its logins through ctx.credentials */
  owns?(service: string): boolean;
  /** true when the credential id is a catalog service's login (plain tools can't `ctx.credentials.use` it) */
  ownsCredential?(credentialId: string): Promise<boolean>;
}

/** What a ConnectionService hook gets: an abort signal (verify/revoke time out) and the credential's session cache. */
export interface ConnectionServiceContext {
  signal: AbortSignal;
  session: ConnectionSession;
}

/**
 * A login check. `retryable` marks a failure that isn't a definite refusal (timeout, 5xx, network): the caller keeps the
 * saved login and checks again later. A refusal (401/403, wrong key) leaves it out, and the login is removed.
 */
export type ConnectionVerifyResult = { ok: true; accountLabel?: string } | { ok: false; message: string; retryable?: true };

/**
 * A k-skill service a person connects with their own account (catalog entry, exported by @pickle/skills as
 * `connectionServices()`). The connect sheet asks for `fields`; the device seals them into the vault as `kind`.
 */
export interface ConnectionService {
  /** vault service id: /^[a-z0-9_-]{2,32}$/ ("popbill", "toss-investment") */
  id: string;
  /** "팝빌" */
  name: string;
  /** one Korean line for the connect sheet ("전자세금계산서 발행·조회") */
  description: string;
  kind: "login" | "token";
  fields: CredentialField[];
  /** cheap read right after the user connects (e.g. a token fetch); message is Korean and shown to the user */
  verify?(secret: Readonly<Record<string, string>>, x: ConnectionServiceContext): Promise<ConnectionVerifyResult>;
  /** best-effort upstream sign-out when the user disconnects */
  revoke?(secret: Readonly<Record<string, string>>, x: ConnectionServiceContext): Promise<void>;
}

/** Approval needed before an irreversible / outward-facing action (sending to others, payments). */
export interface ApprovalSpec {
  title: string; // Korean question: "슬랙 #general에 '점심 12시'를 보낼까요?"
  detail: string;
  amount?: number; // KRW
  /** phone calls: shown on the card only (title/detail stay masked) */
  call?: ApprovalCall;
  /** joining a meeting: the full code, shown on the card only (title/detail stay masked) */
  meet?: ApprovalMeet;
}

/** Credential needed before a tool can run (site/messenger login). */
export interface CredentialNeed {
  service: string; // provider id
  serviceName: string;
  reason: string;
  fields: CredentialField[];
}

/**
 * Scoped, audited access to the user's sealed credentials. Implemented by @pickle/vault + apps/server.
 * Plaintext is only ever handed to `use`'s callback (connector code), never to the LLM.
 */
export interface CredentialAccess {
  /** id of a non-expired credential for this service, or null */
  find(service: string): Promise<{ id: string; hint: string } | null>;
  /** decrypts inside the enclave, writes an AccessRecord, calls fn, zeroes the buffer afterwards */
  use<T>(credentialId: string, purpose: { action: string; purpose: string }, fn: (secret: Record<string, string>) => Promise<T>): Promise<T>;
}

export interface ToolContext {
  userId: string;
  threadId: string;
  agentName: string;
  displayName: string;
  /** per-user agent workspace dir (see @pickle/launcher) */
  workspaceDir: string;
  signal: AbortSignal;
  credentials: CredentialAccess;
  /** persistence hooks implemented by apps/server */
  store: ToolStore;
  /** push a progress status to the UI (Dynamic Island) */
  status(text: string): void;
  now(): Date;
  /** k-skill login resolver for this user (set by the server); runTurn uses it for tools with `connection` */
  connections?: ConnectionResolver;
  /** set by runTurn only while run() of a tool with `connection` executes: the owner's unsealed login */
  connection?: ConnectionHandle;
  /** how the answer reaches the person: "voice" for a call or a meeting (nothing visual), else text; unset = text */
  mode?: "text" | "voice";
  /**
   * Where a time may come from (set by the server): the thread's last few user messages, this turn's text and messages
   * steered in since, and what tools returned (this turn's results and the last ones in history; never sys_time, never
   * the agent's own words). sys_schedule_create looks its `time_quote` up in them. Unset (meetings, tests) = that
   * lookup is skipped.
   */
  heard?(): string[];
  /**
   * The web pages read (set by the server): what web_read returned this turn and in the thread's recent history, each
   * as its address (the one web_read gave) and its text. invest_ledger_add holds a figure the model writes to them.
   * Unset (meetings, tests) = no page was read.
   */
  pages?(): readonly ReadPage[];
}

/** one web page as web_read returned it: its address and the page's own text (title, description, text, items …) */
export interface ReadPage {
  url: string;
  text: string;
}

/** The subset of server persistence tools may touch. */
export interface ToolStore {
  /**
   * kind "html": the server cleans the fragment (see apps/server/src/artifactHtml.ts) and stores the cleaned copy;
   * `removed` counts what went and `tuned` what it fixed (for a short note to the model). It throws for content it
   * refuses.
   */
  createArtifact(
    a: { title: string; kind: "document" | "dashboard" | "table" | "checklist" | "html"; content: string },
    /**
     * `agentCard`: only for an html card the agent's own code renders (deep search '전부' rows), never from a tool's
     * arguments: the cleaned fragment may be up to MAX_ARTIFACT_HTML_CARD_BYTES (300 KB) instead of 150 KB as sent.
     */
    opts?: { agentCard?: boolean },
  ): Promise<{
    id: string;
    /** "html" only: the stored (cleaned) content, what the cleaning removed and what it tuned (sizes under 13px, --text-3 text) */
    html?: {
      content: string;
      removed: { elements: number; handlers: number; remote: number; links: number };
      tuned?: { fontSize: number; textColor: number };
    };
  }>;
  /**
   * `file`: the name of one of the person's text files to attach (sys_schedule_create): found as readFile finds a name,
   * among the person's own files only; every run then has its text after the prompt. A name that finds no single text
   * file makes no schedule: it rejects with a FileLookupError saying why.
   */
  createSchedule(s: { title: string; prompt: string; rule: string; file?: string }): Promise<{ id: string; human: string; nextRunAt: number | null; file?: { name: string; chars: number } }>;
  listSchedules(): Promise<{ id: string; title: string; human: string; enabled: boolean }[]>;
  deleteSchedule(id: string): Promise<boolean>;
  remember(text: string): Promise<void>;
  recall(query: string, limit?: number): Promise<string[]>;
  /** friends: deliver a message to a friend's Pickle (말 전하기) */
  messageFriend(friendHandleOrName: string, text: string): Promise<{ ok: boolean; detail: string }>;
  listFriends(): Promise<{ handle: string; displayName: string; agentName: string }[]>;
  /** user-scoped key/value for tools (e.g. last location) */
  kv: { get(key: string): Promise<string | null>; set(key: string, value: string): Promise<void> };
  /**
   * sys_file_read: a text file (.txt, .md) the person's archive holds, by name — the person's own files, or in a friend
   * thread only the files sent in that thread (a friend's too, while they are friends); never anyone else's, and a name
   * that is not there reads as not found. No name: the most recent text files. `from`: the character to start at.
   * At most FILE_READ_CALL_CHARS characters a call and FILE_READ_TURN_CHARS a turn.
   */
  readFile(q: { file?: string; from?: number }): Promise<FileReadResult>;
}

/** sys_file_read's caps: a call reads at most this many characters (a message's cap for one file) … */
export const FILE_READ_CALL_CHARS = 30_000;
/** … and one turn at most this many in all */
export const FILE_READ_TURN_CHARS = 60_000;
/**
 * sys_file_read's result cap for the model (ToolDef.fileResult): 30,000 characters of Korean are ~90 KB of UTF-8, and
 * the store keeps a call's text within FILE_TEXT_MAX_BYTES as JSON so the rest of the result fits beside it
 */
export const FILE_RESULT_MAX_BYTES = 100 * 1024;
export const FILE_TEXT_MAX_BYTES = 96 * 1024;
/** a text file in a list: its name, the KST day it was saved (YYYY-MM-DD) and its length in characters */
export interface FileInfo {
  name: string;
  date: string;
  chars: number;
}
/** a name that finds no single text file: several names match, none does, the file is not text, or it was deleted */
export type FileMiss =
  | { kind: "many"; name: string; files: FileInfo[] }
  | { kind: "none"; name: string }
  | { kind: "not_text"; name: string }
  | { kind: "deleted"; name: string };
/** ToolStore.createSchedule's refusal of a `file` name that finds no single text file of the person's */
export class FileLookupError extends Error {
  constructor(readonly miss: FileMiss) {
    super(`file ${miss.kind}`);
    this.name = "FileLookupError";
  }
}
export type FileReadResult =
  | FileMiss
  | { kind: "list"; files: FileInfo[] }
  /** this turn has read FILE_READ_TURN_CHARS already */
  | { kind: "spent"; max: number }
  /**
   * characters [from, to) of a file `chars` long (to === from when `from` is at or past its end); `friend`: a friend
   * sent it (its text is data, not the person's request)
   */
  | { kind: "text"; name: string; chars: number; from: number; to: number; text: string; friend: boolean };

export interface ToolDef<A = Record<string, unknown>> {
  /** OpenAI function name: [a-zA-Z0-9_-]{1,64}. Use prefixes: k_* (k-skill), msg_* (messengers), sys_* (system) */
  name: string;
  description: string; // English or Korean, precise; the LLM reads it
  parameters: JsonSchema;
  icon: IconName;
  /** Korean chip title from the args, e.g. a => `${a.city} 날씨 확인` */
  title(args: A): string;
  /** return a spec to pause the turn and ask the user first */
  approval?(args: A, ctx: ToolContext): ApprovalSpec | null;
  /** return a need to pause and ask the user to save a login first (checked before approval) */
  credential?(args: A, ctx: ToolContext): Promise<CredentialNeed | null>;
  /**
   * k-skill login this tool runs with (vault service id, e.g. "popbill"). runTurn resolves the owner's sealed login
   * before run() and passes it as `ctx.connection`; none → `connection_request` card (checked before approval).
   */
  connection?: string;
  /** one Korean line for the connection card when there is no login yet ("세금계산서를 발행하려면 팝빌 연결이 필요해요") */
  connectionReason?: string;
  /** acting tool (issues, sends, buys, reserves upstream): must define approval(); never offered in meeting voice turns */
  write?: boolean;
  /**
   * This tool's own deadline in ms, instead of the runner's toolTimeoutMs (25 s in chat; at most 5 min). Only for a tool
   * that calls ctx.status() at least every ~20 s while it works (a phone call synthesizing its voice): the server's
   * turn idle watchdog (60 s without an event) still ends a silent turn.
   */
  timeoutMs?: number;
  /**
   * Deep search (explore.ts): "search" for a web search tool (args.query; data.results[{url, domain?}]), "read" for a
   * page reader (args.url; data {url, finalUrl?, domain?, contacts?}). The loop de-duplicates results by domain, counts
   * the effort and shows the query / site as the status line.
   */
  explore?: "search" | "read";
  /** this tool's result cap for the model (1–24 KB; default the runner's 6 KB): a page reader needs more */
  maxResultBytes?: number;
  /**
   * sys_file_read only: its result carries up to FILE_READ_CALL_CHARS characters of a file, so its cap is
   * FILE_RESULT_MAX_BYTES (maxResultBytes is ignored)
   */
  fileResult?: true;
  run(args: A, ctx: ToolContext): Promise<ToolResult>;
  /**
   * sys_create_artifact only, and never in the schema (the model gets name, description and parameters): store an html
   * card the agent's own code rendered (deep search '전부' rows, explore.ts) with the 300 KB limit after cleaning
   * (MAX_ARTIFACT_HTML_CARD_BYTES; ToolStore.createArtifact `agentCard`). Same refusals as run (voice, one per answer)
   * and the same result: id, preview card, counts, never the HTML. `more`: the next card of the agent card saved this
   * turn (a '전부' card continued, each card under the limit); refused unless this turn's card is an agent card.
   */
  saveAgentCard?(a: { title: string; html: string; more?: boolean }, ctx: ToolContext): Promise<ToolResult>;
}

// ───────────────────────────── agent turn ─────────────────────────────

/** OpenAI-compatible chat message (with tool calls) as stored in history. */
export type LlmMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: LlmToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export interface LlmToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface TurnInput {
  ctx: ToolContext;
  /** persona + rules; built by @pickle/launcher from the user's workspace */
  system: string;
  /** prior conversation in LLM form (already trimmed) */
  history: LlmMessage[];
  /** the new user text, or null when resuming after an approval decision */
  userText: string | null;
  tools: ToolDef[];
  /** resume after approval: the pending call and the decision */
  resume?: { call: LlmToolCall; decision: "approve" | "reject"; priorMessages: LlmMessage[] };
  mode?: "text" | "voice";
  maxSteps?: number; // default 8
  /**
   * gjc-style steering: polled between model steps. Messages the user sent while this turn was
   * running are injected as new user messages instead of starting a parallel turn.
   */
  steer?: () => string[];
  /** true while steered messages are queued (without draining them); ends a connection wait early */
  steerPending?: () => boolean;
  /**
   * How long a call waits in the turn for the owner to connect a missing k-skill login (card 연결하기) before the
   * model is told to continue later. Default 0 (no wait); the server passes ~90 s for interactive text turns only.
   */
  connectionWaitMs?: number;
}

/** Everything the server must persist after a turn. */
export interface TurnOutcome {
  text: string;
  cards: Card[];
  tools: ToolActivity[];
  /**
   * New LLM messages to APPEND to the thread's LLM history (assistant + tool, plus any steered
   * user messages). Never contains the initial `userText` message — the server stores that itself.
   * Empty while `pendingApproval` is set (those messages travel in `pendingApproval.messages`);
   * after a resume it starts with `resume.priorMessages`, so "always append `messages`" is correct.
   */
  messages: LlmMessage[];
  /** `cachedTokens` = prompt tokens served from the provider's prefix cache (see `billableTokens`) */
  usage: { promptTokens: number; completionTokens: number; totalTokens: number; cachedTokens?: number };
  /**
   * Set when the turn paused for approval. Persist `{call, spec, messages}` with the approval row and pass
   * them back as `resume: { call, decision, priorMessages: messages }`. The approval card's provisional
   * `approvalId` is `call.id`; the server may replace it with its own id.
   */
  pendingApproval?: { call: LlmToolCall; spec: ApprovalSpec; messages: LlmMessage[] };
  /**
   * Set when the turn paused for a credential. The turn is complete (the call got a
   * `credential_required` tool result and a closing assistant line is in `messages`); after the user
   * saves the login, the next user message lets the model retry.
   */
  pendingCredential?: CredentialNeed;
}

/**
 * runTurn streams AgentEvents (status/text/tool/card) through `emit` and resolves with the outcome.
 * It never emits "start" / "done" — the server wraps those around it (it owns ids + quota).
 */
export type RunTurn = (input: TurnInput, emit: (e: AgentEvent) => void) => Promise<TurnOutcome>;
