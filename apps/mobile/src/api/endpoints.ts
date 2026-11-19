import type {
  AccessRecord,
  AgentPatch,
  AgentProfile,
  ApprovalDecisionRequest,
  Artifact,
  Attachment,
  AuthResponse,
  ConnectRequest,
  ConnectResponse,
  ConnectionsResponse,
  CredentialInfo,
  CredentialKind,
  DelegateResponse,
  EnclaveInfo,
  ExploreResponse,
  Friend,
  HeardRequest,
  ID,
  InviteResponse,
  KeepFor,
  LoginRelayResponse,
  LoginRelayStartRequest,
  LoginRelayStepRequest,
  LoginRequest,
  Message,
  MessengerChat,
  PasswordResetStartRequest,
  PasswordResetStartResponse,
  PasswordResetVerifyRequest,
  ProfileResponse,
  Quota,
  SaveCredentialRequest,
  Schedule,
  SendMessageRequest,
  SessionBootstrap,
  SettingsPatch,
  SignupRequest,
  SkillInfo,
  Thread,
  ThreadKind,
  Tickets,
  UiDefinitions,
  UseTicketRequest,
  UserSettings,
} from "@pickle/protocol";
import { maskHint, sealForEnclave, signApproval } from "@pickle/vault/client";
import { API_BASE, apiDelete, apiGet, apiPatch, apiPost, apiRaw, query, tokenUrl, type ApiOptions } from "./client";
import { streamTurn, type StreamOptions, type TurnResult } from "./sse";

/**
 * One typed function per protocol ROUTES entry, shaped by docs/architecture/SERVER-CONTRACT.md:
 *  - lists are BARE ARRAYS (threads, messages, artifacts, attachments, friends, schedules, credentials, access-log,
 *    skills, memories); the one exception is GET /api/connections → {providers, connections}
 *  - every DELETE → {ok:true}
 *  - GET /api/session → SessionBootstrap only
 */

const enc = encodeURIComponent;
export type Ok = { ok: true };

/** GET a bare-array list (anything else reads as empty rather than crashing a screen) */
async function list<T>(path: string, opts?: ApiOptions): Promise<T[]> {
  const v = await apiGet<unknown>(path, opts);
  return Array.isArray(v) ? (v as T[]) : [];
}

/** RFC 4122 v4 — crypto.randomUUID() where available (secure contexts), the same shape from getRandomValues otherwise */
export function uuid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// ── health / auth / session ──
export const health = (opts?: ApiOptions) => apiGet<{ ok: boolean; [k: string]: unknown }>("/api/health", { auth: false, ...opts });
export const signup = (req: SignupRequest) => apiPost<AuthResponse>("/api/auth/signup", req, { auth: false });
export const login = (req: LoginRequest) => apiPost<AuthResponse>("/api/auth/login", req, { auth: false });
export const logout = () => apiPost<Ok>("/api/auth/logout");
/** password reset through the phone the account verified (나의 모시 > 내 전화번호): start → a code reaches that phone */
export const resetStart = (handle: string) => apiPost<PasswordResetStartResponse>("/api/auth/reset/start", { handle } satisfies PasswordResetStartRequest, { auth: false });
/** the code + the new password → signed in (same response as login) */
export const resetVerify = (req: PasswordResetVerifyRequest) => apiPost<AuthResponse>("/api/auth/reset/verify", req, { auth: false });
export const session = (opts?: ApiOptions) => apiGet<SessionBootstrap>("/api/session", opts);
export const uiDefinitions = (opts?: ApiOptions) => apiGet<UiDefinitions>("/api/ui-definitions", opts);

// ── threads & messages ──
export const threads = (opts?: ApiOptions) => list<Thread>("/api/threads", opts);
/** 201 Thread — the server creates kind "task" threads only */
export const createThread = (body: { kind?: Extract<ThreadKind, "task">; title: string }) => apiPost<Thread>("/api/threads", { kind: "task", ...body });
export const patchThread = (id: ID, body: { archived?: boolean; title?: string }) => apiPatch<Thread>(`/api/threads/${enc(id)}`, body);

export interface MessagesPage {
  messages: Message[];
  hasMore: boolean;
}
/**
 * GET /api/threads/:id/messages?before=&limit= (1..200, default 50) → Message[] (bare array). Returned oldest → newest.
 * `before` = createdAt of the oldest message already shown. No `hasMore` on the wire: a full page means "maybe more".
 */
export async function messages(threadId: ID, { before, limit = 50 }: { before?: number; limit?: number } = {}, opts?: ApiOptions): Promise<MessagesPage> {
  const items = (await list<Message>(`/api/threads/${enc(threadId)}/messages${query({ before, limit })}`, opts)).slice().sort((a, b) => a.createdAt - b.createdAt);
  return { messages: items, hasMore: items.length >= limit };
}

/** at most 10 attachments per message (server limit) */
export const MAX_ATTACHMENTS = 10;

/**
 * POST a message → 200 SSE turn stream · 202 SteeredResponse (busy in this thread) · 201 {delivered} (friend thread,
 * not for the agent). 409 busy / 413 / 400 / 429 / 503 throw ApiError with the server's Korean message.
 */
export const send = (threadId: ID, body: SendMessageRequest, opts: StreamOptions): Promise<TurnResult> =>
  streamTurn(`/api/threads/${enc(threadId)}/messages`, body.attachmentIds && body.attachmentIds.length > MAX_ATTACHMENTS ? { ...body, attachmentIds: body.attachmentIds.slice(0, MAX_ATTACHMENTS) } : body, opts);

/**
 * The call cut a spoken reply off: what the person heard of it (a prefix of its speakable text, whole words) → 204. The
 * server keeps only that in the reply's history. 404 (not stored yet) / 409 (not how the reply begins) throw; the call
 * drops them.
 */
export const heard = (threadId: ID, messageId: ID, text: string) =>
  apiPost<void>(`/api/threads/${enc(threadId)}/messages/${enc(messageId)}/heard`, { heard: text } satisfies HeardRequest, { timeoutMs: 8000 });

/**
 * POST /api/approvals/:id {decision, signature, nonce, deviceId} → 200 SSE of the resumed turn. `approvalId` is the
 * card's `approvalId` (ap_…, already the DB id). Approve is signed with the device's non-extractable P-256 key over
 * UTF-8 `approve:<approvalId>:<nonce>` (ECDSA SHA-256, IEEE P1363, base64url), nonce = crypto.randomUUID().
 * Errors: 404 approval_not_found · 400 invalid_signature/unknown_device · 403 bad_signature · 409 already_decided/busy ·
 * 410 approval_expired · 429 quota_exceeded — ApiError with the server's message.
 */
export async function approve(approvalId: ID, decision: "approve" | "reject", opts: StreamOptions): Promise<TurnResult> {
  const body: ApprovalDecisionRequest = { decision };
  if (decision === "approve") {
    const nonce = uuid();
    try {
      const { signature, deviceId } = await signApproval(approvalId, nonce);
      Object.assign(body, { signature, nonce, deviceId });
    } catch {
      // no device key (storage blocked): the server records the approval as not device-verified
    }
  }
  return streamTurn(`/api/approvals/${enc(approvalId)}`, body, opts);
}

// ── explore ──
export const explore = (opts?: ApiOptions) => apiGet<ExploreResponse>("/api/explore", opts);
/** 201 {thread, prompt}. `call-demo` returns prompt "" (do NOT auto-send); `connect-kakao` is not delegated (open Connections). */
export const delegate = (templateId: ID) => apiPost<DelegateResponse>(`/api/explore/${enc(templateId)}/delegate`);
/** Explore special template ids (SERVER-CONTRACT §Explore) */
export const TEMPLATE_CALL_DEMO = "call-demo";
export const TEMPLATE_CONNECT_KAKAO = "connect-kakao";

// ── archive ──
export const artifacts = (opts?: ApiOptions) => list<Artifact>("/api/artifacts", opts);
export const artifact = (id: ID, opts?: ApiOptions) => apiGet<Artifact>(`/api/artifacts/${enc(id)}`, opts);
export const deleteArtifact = (id: ID) => apiDelete<Ok>(`/api/artifacts/${enc(id)}`);
/** raw artifact content (markdown, or JSON for dashboards) */
export const blob = async (artifactId: ID, opts?: ApiOptions) => (await apiRaw("GET", `/api/blobs/${enc(artifactId)}`, undefined, opts)).text();
/** `?token=` URL of an artifact's content (iframes / links) */
export const blobUrl = (artifactId: ID) => tokenUrl(`/api/blobs/${enc(artifactId)}`);

/**
 * POST /api/attachments multipart — field `file` (+ optional `threadId`) → 201 Attachment
 * {id, filename, mime, size, threadId, url:"/api/attachments/<id>/raw", createdAt}. Raster images, PDF, text/plain.
 * 413 file_too_large (10 MB) · 415 unsupported_type · 400 invalid_upload → ApiError with the server's message.
 */
export function uploadAttachment(file: Blob & { name?: string }, threadId?: ID, opts?: ApiOptions) {
  const form = new FormData();
  form.append("file", file, file.name ?? "upload");
  if (threadId) form.append("threadId", threadId);
  return apiPost<Attachment>("/api/attachments", form, { timeoutMs: 60_000, ...opts });
}
export const attachments = (opts?: ApiOptions) => list<Attachment>("/api/attachments", opts);
export const deleteAttachment = (id: ID) => apiDelete<Ok>(`/api/attachments/${enc(id)}`);
/** Authed path (needs the bearer header). */
export const attachmentRawPath = (id: ID) => `${API_BASE}/api/attachments/${enc(id)}/raw`;
/** `<img src>` / PDF URL with `?token=` (the server accepts the token in the query on this route) */
export const attachmentUrl = (id: ID) => tokenUrl(`/api/attachments/${enc(id)}/raw`);
/** `?token=` version of an AttachmentRef.url ("/api/attachments/<id>/raw") */
export const authedUrl = (url: string) => (/^https?:|^blob:|^data:/.test(url) ? url : tokenUrl(url));
/** Fetch with the bearer token and return an object URL (revoke it when done). */
export async function attachmentObjectUrl(id: ID, opts?: ApiOptions): Promise<string> {
  const res = await apiRaw("GET", `/api/attachments/${enc(id)}/raw`, undefined, { timeoutMs: 60_000, ...opts });
  return URL.createObjectURL(await res.blob());
}

// ── profile / usage / settings / agent ──
export const profile = (opts?: ApiOptions) => apiGet<ProfileResponse>("/api/profile", opts);
export const useTicket = (kind: UseTicketRequest["kind"]) => apiPost<{ quota: Quota; tickets: Tickets }>("/api/tickets/use", { kind } satisfies UseTicketRequest);
export const patchSettings = (patch: SettingsPatch) => apiPatch<UserSettings>("/api/settings", patch);
export const agent = (opts?: ApiOptions) => apiGet<AgentProfile>("/api/agent", opts);
export const patchAgent = (patch: AgentPatch) => apiPatch<AgentProfile>("/api/agent", patch);
export const restartAgent = () => apiPost<AgentProfile | Ok>("/api/agent/restart");
export const skills = (opts?: ApiOptions) => list<SkillInfo>("/api/skills", opts);
export type MemoryItem = { id: ID; text: string; createdAt: number };
export const memories = (opts?: ApiOptions) => list<MemoryItem>("/api/memories", opts);
export const deleteMemory = (id: ID) => apiDelete<Ok>(`/api/memories/${enc(id)}`);

// ── vault ──
let enclaveCache: Promise<EnclaveInfo> | null = null;
/** Enclave public key + measurement (cached for the session). */
export function enclave(opts?: ApiOptions & { refresh?: boolean }): Promise<EnclaveInfo> {
  if (!enclaveCache || opts?.refresh) {
    enclaveCache = apiGet<EnclaveInfo>("/api/enclave", opts);
    enclaveCache.catch(() => {
      enclaveCache = null;
    });
  }
  return enclaveCache;
}
export const credentials = (opts?: ApiOptions) => list<CredentialInfo>("/api/credentials", opts);
/** 201 CredentialInfo (never the secret). 400 invalid_envelope "이 계정용으로 암호화된 정보가 아니에요" (aad mismatch). */
export const saveCredential = (req: SaveCredentialRequest) => apiPost<CredentialInfo>("/api/credentials", req);
export const patchCredential = (id: ID, body: { keepFor: KeepFor }) => apiPatch<CredentialInfo>(`/api/credentials/${enc(id)}`, body);
export const deleteCredential = (id: ID) => apiDelete<Ok>(`/api/credentials/${enc(id)}`);
/** ?limit=1..200 (default 50) → AccessRecord[] */
export const accessLog = (limit = 50, opts?: ApiOptions) => list<AccessRecord>(`/api/access-log${query({ limit: Math.max(1, Math.min(200, Math.round(limit))) })}`, opts);

export interface SealInput {
  userId: ID;
  service: string;
  label: string;
  kind: CredentialKind;
  keepFor: KeepFor;
  /** plaintext fields — sealed ON THE DEVICE; never sent in the clear */
  fields: Record<string, string>;
  /** which field the masked hint is built from (default: username/email/phone/number/first field) */
  hintField?: string;
}

/** Build a device-sealed SaveCredentialRequest (aad = `${userId}:${service}:${kind}`). */
export async function sealCredential(i: SealInput): Promise<SaveCredentialRequest> {
  const info = await enclave();
  const aad = `${i.userId}:${i.service}:${i.kind}`;
  const envelope = await sealForEnclave(info, i.fields, aad);
  const pick = i.hintField ?? ["username", "email", "phone", "id", "number", "cardNumber"].find((k) => i.fields[k]) ?? Object.keys(i.fields)[0];
  const hint = pick ? maskHint(i.kind, i.fields[pick] ?? "") : "";
  return { service: i.service, label: i.label, kind: i.kind, hint, keepFor: i.keepFor, envelope };
}

/** Seal on device and save in one call. */
export async function saveCredentialSealed(i: SealInput): Promise<CredentialInfo> {
  return saveCredential(await sealCredential(i));
}

// ── connections (agent-messenger) ──
/** the one non-array list: {providers, connections} */
export const connections = async (opts?: ApiOptions): Promise<ConnectionsResponse> => {
  const r = await apiGet<Partial<ConnectionsResponse> | null>("/api/connections", opts);
  return { providers: Array.isArray(r?.providers) ? r.providers : [], connections: Array.isArray(r?.connections) ? r.connections : [] };
};
/**
 * POST /api/connections/:provider {credential} | {credentialId}. A failed login is still 200 with
 * connection.status "error" + Korean lastError. display_code providers return `verification` (the code to show).
 */
export const connect = (provider: string, req: ConnectRequest) => apiPost<ConnectResponse>(`/api/connections/${enc(provider)}`, req, { timeoutMs: 60_000 });
/**
 * POST /api/connections/:provider/verify — `{}` polls a display_code flow (KakaoTalk passcode, LINE, Teams);
 * `{code}` submits an enter_code flow (400 invalid_code).
 */
export const verifyConnection = (provider: string, code?: string, opts?: ApiOptions) =>
  apiPost<ConnectResponse>(`/api/connections/${enc(provider)}/verify`, code === undefined ? {} : { code }, { timeoutMs: 60_000, ...opts });
export const verify = verifyConnection;
export const disconnect = (provider: string) => apiDelete<Ok>(`/api/connections/${enc(provider)}`);
export const chats = (provider: string, opts?: ApiOptions) => list<MessengerChat>(`/api/connections/${enc(provider)}/chats`, opts);

// ── in-app sign-in relay (Slack) ──
/**
 * Seal one typed value (email / code / password / TOTP) ON THE DEVICE for the login relay. It is never stored: the
 * server opens it only to type it into Slack's own sign-in page. aad = `${userId}:${provider}:login-relay:${tail}`
 * where tail is "start" for the email and the relayId for every later step.
 */
export async function sealRelayInput(userId: ID, provider: string, tail: string, fields: Record<string, string>) {
  return sealForEnclave(await enclave(), fields, `${userId}:${provider}:login-relay:${tail}`);
}
/** POST /api/connections/:provider/login → needs_code | needs_password | workspaces | connected | error (each step can take a while: Slack runs in a server browser) */
export const loginRelayStart = (provider: string, req: LoginRelayStartRequest, opts?: ApiOptions) =>
  apiPost<LoginRelayResponse>(`/api/connections/${enc(provider)}/login`, req, { timeoutMs: 90_000, ...opts });
/** POST /api/connections/:provider/login/step — exactly one of code | password | totp (sealed) | teamId */
export const loginRelayStep = (provider: string, req: LoginRelayStepRequest, opts?: ApiOptions) =>
  apiPost<LoginRelayResponse>(`/api/connections/${enc(provider)}/login/step`, req, { timeoutMs: 120_000, ...opts });
/** POST /api/connections/:provider/login/cancel — closes the server browser at once */
export const loginRelayCancel = (provider: string, relayId: ID) => apiPost<Ok>(`/api/connections/${enc(provider)}/login/cancel`, { relayId });

// ── friends / invites ──
export const friends = (opts?: ApiOptions) => list<Friend>("/api/friends", opts);
/** 200 Friend with status "blocked" */
export const blockFriend = (userId: ID) => apiPost<Friend>(`/api/friends/${enc(userId)}/block`);
export const deleteFriend = (userId: ID) => apiDelete<Ok>(`/api/friends/${enc(userId)}`);
/** 201 InviteResponse */
export const createInvite = () => apiPost<InviteResponse>("/api/invites");
/** 201 Friend (200 if already friends). The landing page /i/:token sends people to `/?invite=<token>`. */
export const acceptInvite = (token: string) => apiPost<Friend>(`/api/invites/${enc(token)}/accept`);

// ── schedules ──
export type ScheduleInput = { title: string; prompt: string; rule: string; enabled?: boolean };
export const schedules = (opts?: ApiOptions) => list<Schedule>("/api/schedules", opts);
export const createSchedule = (body: ScheduleInput) => apiPost<Schedule>("/api/schedules", body);
export const patchSchedule = (id: ID, patch: Partial<ScheduleInput>) => apiPatch<Schedule>(`/api/schedules/${enc(id)}`, patch);
export const deleteSchedule = (id: ID) => apiDelete<Ok>(`/api/schedules/${enc(id)}`);

/** EventSource URL: GET /api/events?token=<session token> (EventSource has no headers). null without a session. */
export function eventsUrl(): string | null {
  const url = tokenUrl("/api/events");
  return url.includes("token=") ? url : null;
}
