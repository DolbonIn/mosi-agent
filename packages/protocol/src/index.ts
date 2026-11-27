/**
 * @pickle/protocol — the single wire contract shared by apps/server, packages/* and apps/mobile.
 *
 * Mirrors the REA of com.pickle.client (server-driven UI, Bearer sessions, api/session,
 * api/ui-definitions, /messages, api/attachments, api/blobs) and adds the endpoints this
 * rebuild needs. Every HTTP body is JSON unless noted. All authed routes take
 * `Authorization: Bearer <token>`.
 *
 * Streaming routes answer `text/event-stream`; each event is one line `data: <AgentEvent JSON>\n\n`.
 */

// ───────────────────────────── primitives ─────────────────────────────

export type ID = string;
/** Unix epoch milliseconds. */
export type Millis = number;

export interface ApiError {
  error: string; // machine code, e.g. "unauthorized", "quota_exceeded"
  message?: string; // Korean, user-facing
}

// ───────────────────────────── auth / session ─────────────────────────────

/** Device key registered at sign-up/login. ECDSA P-256 public key (JWK) used to verify approvals. */
export interface DeviceRegistration {
  id: ID; // random, generated on device, persisted in localStorage
  label: string; // e.g. "iPhone Safari"
  signingKey: JsonWebKey; // ECDSA P-256 public JWK
}

export interface SignupRequest {
  handle: string; // 3–20 [a-z0-9_]
  password: string; // ≥ 8 chars
  displayName: string; // shown as "하늘 님"
  agentName: string; // the character's name, e.g. "깽이"
  device: DeviceRegistration;
}

export interface LoginRequest {
  handle: string;
  password: string;
  device: DeviceRegistration;
}

export interface AuthResponse {
  token: string;
  session: SessionBootstrap;
}

/** Password reset by the verified phone (나의 모시 > 내 전화번호): a call reads a 6-digit code. */
export interface PasswordResetStartRequest {
  handle: string;
}

/** 409 `no_verified_phone` for an unknown handle and for one without a verified phone alike. */
export interface PasswordResetStartResponse {
  channel: "call";
  masked: string; // "010-****-5678"
}

/** → AuthResponse (logged in; the user's other sessions end). Errors: invalid_code {attemptsLeft}, code_expired, weak_password. */
export interface PasswordResetVerifyRequest {
  handle: string;
  code: string;
  password: string;
  device: DeviceRegistration;
}

export interface UserPublic {
  id: ID;
  handle: string;
  displayName: string;
  createdAt: Millis;
}

export interface AgentProfile {
  id: ID; // == user id (one agent per user)
  name: string; // "깽이"
  persona: string; // free text, editable
  avatar: AvatarSpec;
  model: string; // "deepseek/deepseek-v4.1-flash-ultrafast"
  status: AgentStatus;
  enabledSkills: string[]; // skill ids (see SkillInfo.id)
  createdAt: Millis;
  lastActiveAt: Millis | null;
  /**
   * The person's agent-profile revision (name, persona, avatar, enabledSkills), made by the server alone: it goes up
   * only when one of those changes, to max(previous + 1, server clock in ms), so it never goes down (not after a
   * restart, nor when the profile is put back from a backup or made anew); compare sizes only. A response or `agent` event whose rev is not above the one a device has seen is older than
   * what it shows (PATCH answers and events come on different connections). 0 = the server could not read the profile
   * and answered with defaults.
   */
  rev: number;
}

export type AgentStatus = "idle" | "starting" | "running" | "stopped" | "error";

/** Procedural avatar (blob character like the real app's red face). */
export interface AvatarSpec {
  hue: number; // 0–360
  shape: "blob" | "round" | "drop";
  eyes: "dot" | "oval" | "smile";
}

export interface Quota {
  usedPct: number; // 0–100 (integer)
  usedTokens: number;
  limitTokens: number;
  resetsAt: Millis; // next 04:00 KST
  resetHour: number; // 4
}

export interface Tickets {
  basic: number;
  premium: number;
}

export interface SessionBootstrap {
  user: UserPublic;
  agent: AgentProfile;
  quota: Quota;
  tickets: Tickets;
  settings: SettingsView;
  mainThreadId: ID;
  unreadThreads: number;
  server: { llm: "configured" | "missing"; model: string | null; version: string };
  /** "real" while real invest orders are on (나의 모시 "투자" row: 실제 주문); absent in mock mode */
  investMode?: "real";
}

// ───────────────────────────── settings ─────────────────────────────

export interface UserSettings {
  notifications: {
    briefing: boolean; // daily briefing push
    /** the 08:00 daily invest report's push (B2c-1, DD 0733 2): off keeps the report in the invest thread, only the push goes */
    investReport: boolean;
    taskDone: boolean;
    friendMessages: boolean;
    marketing: boolean; // 혜택·소식 알림 (선택 동의)
    briefingTime: string; // "07:30" KST
  };
  privacy: {
    /** who can see what — 정보 공개 범위 */
    friendsCanSeeSchedule: boolean;
    friendsCanAskMyPickle: boolean;
    shareLocation: boolean;
    memoryEnabled: boolean; // 모시가 기억하기
  };
  display: {
    theme: "system" | "light" | "dark";
    reduceMotion: "system" | "on" | "off";
    reduceTransparency: "system" | "on" | "off";
    textScale: number; // 0.9 – 1.3
  };
  /** Ask before payments / irreversible actions (always true for payments; this covers messages to others). */
  confirmBeforeSend: boolean;
}

/**
 * UserSettings as the server hands them out (GET /api/session, GET /api/profile, the PATCH /api/settings answer, the
 * `settings` event), with the person's settings revision: made by the server alone, raised on every change that alters
 * a value to max(previous + 1, server clock in ms) (none, and no event, when a PATCH leaves every value as it was), so
 * never down, not even after a restore from a backup; 0 before the first change; compare sizes only. Always sent by
 * the server; optional so an app can keep its own optimistic copy in the same place. Never part of a PATCH body (400).
 */
export type SettingsView = UserSettings & { rev?: number };
export type SettingsPatch = DeepPartial<UserSettings>;
export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

// ───────────────────────────── server-driven UI ─────────────────────────────

export interface UiDefinitions {
  version: number;
  tabs: { id: TabId; title: string; icon: IconName }[];
  drawer: { id: string; title: string; icon: IconName; target: TabId | "friends" }[];
  composer: { placeholder: string; attach: boolean; voice: boolean; call: boolean };
  explore: { title: string; categories: TemplateCategory[] };
  archive: { segments: { id: "artifacts" | "media"; title: string }[]; emptyArtifacts: string; emptyMedia: string };
  profile: { sections: ProfileSection[] };
}

export type TabId = "chat" | "explore" | "archive" | "profile";

export type IconName =
  | "chat" | "compass" | "archive" | "person" | "people" | "search" | "plus" | "mic" | "phone" | "phone-out"
  | "calendar" | "cloud" | "sun" | "moon" | "checkmark" | "chevron-right" | "chevron-left" | "close" | "menu"
  | "shield" | "lock" | "key" | "card" | "bell" | "paintbrush" | "star" | "coins" | "bag" | "plane"
  | "film" | "house" | "sparkles" | "doc" | "chart" | "photo" | "link" | "send" | "paperclip" | "trash"
  | "clock" | "bolt" | "gift" | "map" | "train" | "bus" | "won" | "heart" | "slack" | "kakao" | "discord"
  | "telegram" | "mail" | "ellipsis" | "eye" | "wave" | "stop" | "play" | "pause" | "speaker" | "magnifier";

export interface ProfileSection {
  id: string;
  title?: string;
  rows: { id: string; title: string; icon: IconName; target: string }[];
}

// ───────────────────────────── threads & messages ─────────────────────────────

export type ThreadKind = "main" | "task" | "call" | "friend" | "schedule";

export interface Thread {
  id: ID;
  kind: ThreadKind;
  title: string;
  subtitle: string; // e.g. "깽이의 외부 통화" / last message preview
  icon: IconName;
  archived: boolean;
  unread: boolean;
  createdAt: Millis;
  updatedAt: Millis;
  /** friend threads: the other user */
  peer?: { userId: ID; displayName: string; agentName: string };
  /**
   * First sentence of the agent's latest final answer or event note, markdown and tool lines stripped, phone numbers /
   * emails / codes / card and account numbers / amounts masked on the server, ≤60 chars ("…"); "" when there is none.
   */
  preview?: string;
  /** what the thread is waiting on right now (approval > call > meeting); null when nothing */
  waiting?: ThreadWaiting | null;
}

export interface ThreadWaiting {
  kind: "approval" | "call" | "meeting";
  /** "전화 승인을 기다려요" · "전화를 거는 중이에요" · "호스트 수락을 기다려요" · "회의 중 · 듣고 받아 적고 있어요." … */
  text: string;
}

export type MessageRole = "user" | "assistant" | "event";

export interface Message {
  id: ID;
  threadId: ID;
  role: MessageRole;
  /** plain text (assistant text may contain light markdown: **bold**, lists, `code`) */
  text: string;
  cards: Card[]; // rich content attached to this message, rendered under the text
  tools: ToolActivity[]; // what the agent did while producing this message
  attachments: AttachmentRef[];
  createdAt: Millis;
  /** sender for friend threads ("내 모시", "진우 님의 모시", ...) */
  author?: { kind: "me" | "my-agent" | "peer" | "peer-agent"; name: string };
  /**
   * Only on a live `message` push of the person's line that the server steered into a running turn (202), so another
   * device of theirs can show that line's steer receipt as the sending device does. Never in page reads (GET messages)
   * or the 202 body, and absent on a line that became a turn of its own (the running turn ended in between) or that its
   * turn left unanswered (`steerDropped` instead).
   */
  steered?: true;
  /**
   * Only on a live `message` push, to the sender's own devices, of their friend-thread line that reached the friend
   * without calling their agent (the send's 201 `delivered`), so every open device of theirs shows it delivered as the
   * sending one does. Never on the friend's devices, in page reads (GET messages) or the 201 body, nor on a line that
   * called the agent (it became a turn).
   */
  delivered?: true;
  /**
   * The person's own line that the server steered into a running turn (202) and that turn left unanswered: a
   * `steers_dropped` named it. The server stores it, so every view of the line carries it from then on: page reads (GET
   * messages) and any later `message` push (which then carries no `steered`). A device that missed the event (asleep,
   * offline) drops the line's steer receipt when it reads the page again. Never on a line its turn answered, nor on one
   * handed to a follow-up turn that ran, nor on the friend's view of a line.
   */
  steerDropped?: true;
}

export interface ToolActivity {
  id: ID;
  name: string; // tool name, e.g. "k.weather"
  title: string; // Korean, e.g. "서울 날씨 확인"
  state: "running" | "done" | "error" | "needs_approval" | "needs_credential";
  summary?: string; // short Korean result
  startedAt: Millis;
  endedAt?: Millis;
}

export type Card =
  | BriefingCard
  | ApprovalCard
  | CredentialRequestCard
  | ConnectionRequestCard
  | ArtifactCard
  | ResultListCard
  | WeatherCard
  | MessengerCard
  | ScheduleCard
  | InvestCard;

export interface BriefingCard {
  type: "briefing";
  title: string; // "오늘의 브리핑"
  items: { icon: IconName; text: string; action?: CardAction }[];
}

export interface ApprovalCard {
  type: "approval";
  approvalId: ID;
  title: string; // "슬랙 #general에 메시지를 보낼까요?"
  detail: string; // what exactly will happen
  amount?: number; // KRW, payments
  /** a phone call (sys_phone_call): who and the FULL number, for the card only. Absent on other tools and older cards. */
  call?: ApprovalCall;
  /** joining a Google Meet (sys_join_meet): the FULL meeting code, for the card only. Absent on other tools and older cards. */
  meet?: ApprovalMeet;
  status: ApprovalStatus;
  /** when the person approved or rejected it (epoch ms): absent while pending, on expiry and on older cards */
  decidedAt?: number;
}

/**
 * What the person approves on a call card. `title` / `detail` stay masked (the model's history and the logs see
 * those); the full number travels only here, to the owner's device.
 */
export interface ApprovalCall {
  /** "단아님" / "relay daily 회의", null when the model gave no name */
  target: string | null;
  /** national format, "010-1234-5678" / "02-1234-1234" ("+1 415-555-0123" abroad); null when the number isn't valid */
  number: string | null;
  /** what will be said, as approved */
  message: string;
  /** keys pressed after it connects ("463394124#"), when any */
  digits?: string;
}

/**
 * What the person approves on a join card. `title` ("Google Meet 회의(abc-****-hij)에 참여할까요?") and `detail` stay
 * masked; the full code travels only here, to the owner's device.
 */
export interface ApprovalMeet {
  /** "abc-defg-hij" */
  code: string;
}

export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired";

export interface CredentialRequestCard {
  type: "credential_request";
  service: string; // provider id, e.g. "kakaotalk", "naver"
  serviceName: string; // "카카오톡"
  reason: string; // why the agent needs it
  fields: CredentialField[];
  status: "pending" | "saved" | "dismissed";
}

/**
 * A k-skill login a tool needs (팝빌, 토스증권 …): "<서비스> 연결이 필요해요" with a 연결하기 action that opens the connect
 * sheet for `service` (fields are sealed on the device there; the chat never asks for them). The server flips it to
 * "connected" once the user connects; a turn still running retries the call (docs/architecture/KSKILL-CONNECTIONS.md).
 */
export interface ConnectionRequestCard {
  type: "connection_request";
  service: string; // vault service id, e.g. "popbill"
  serviceName: string; // "팝빌"
  title: string; // "팝빌 연결이 필요해요"
  reason: string; // one line: why ("팝빌 세금계산서 발행에 팝빌 계정 연결이 필요해요.")
  status: "pending" | "connected" | "dismissed";
  /** { label: "연결하기", open: "connections" } — open the connect sheet focused on `service` */
  action: CardAction;
}

export interface CredentialField {
  key: string; // "username" | "password" | "otp" | "token" ...
  label: string;
  type: "text" | "email" | "tel" | "password";
  autocomplete?: string;
  placeholder?: string;
  /** may be left empty (the key is then left out of the sealed secret), e.g. 팝빌 아이디 */
  optional?: boolean;
  /** one short line under the field (e.g. a limit of this login), shown until there is an error */
  hint?: string;
}

export interface ArtifactCard {
  type: "artifact";
  artifactId: ID;
  title: string;
  kind: ArtifactKind;
  preview: string;
  /** Deleted from the archive (보관함): `preview` is "", the card no longer opens; title and kind stay. Set by the server
   *  on every message carrying it, which goes out again as `message`. */
  deleted?: true;
}

export interface ResultListCard {
  type: "results";
  title: string;
  source?: string; // "정부24", "기상청", "Open-Meteo" ...
  items: { title: string; subtitle?: string; meta?: string; url?: string; icon?: IconName }[];
}

export interface WeatherCard {
  type: "weather";
  place: string;
  now: { tempC: number; condition: string; icon: IconName };
  high?: number;
  low?: number;
  hourly?: { hour: string; tempC: number; icon: IconName; pop?: number }[];
  source: string;
}

/**
 * A messenger result (msg_read / msg_send). Cards stored before 2026-11-12 carry only `messages` (author/text/at);
 * newer cards also carry `room` + `thread` + `highlights` (the reconstructed chat room) and leave `messages` empty.
 * Clients render `thread` when present and fall back to `messages`.
 */
export interface MessengerCard {
  type: "messenger";
  provider: string; // "slack" | "kakaotalk" | ...
  action: "sent" | "read";
  target: string; // channel / chat name (= room.title on new cards)
  /** legacy rows (old stored cards); [] on new cards */
  messages: { author: string; text: string; at?: Millis }[];
  room?: MessengerRoom;
  /** oldest → newest, normalised (no raw ids, no JSON); at most ~50 */
  thread?: MessengerMessage[];
  /** ids (from `thread`) of the 1–3 messages the collapsed card shows */
  highlights?: string[];
  /** how many messages were read (≥ thread.length when the card was capped) */
  total?: number;
}

export interface MessengerRoom {
  /** display title: the room's own name, or "김도윤, 초롱별 외 3명" for an unnamed group */
  title: string;
  /** every member name as the messenger shows it (unnamed groups), for the expanded view */
  fullTitle?: string;
  kind: "dm" | "group" | "open" | "channel";
  memberCount?: number;
  unread?: number;
}

export type MessengerMessageKind = "text" | "photo" | "video" | "file" | "emoticon" | "link" | "reply" | "system" | "other";

/** One message of a reconstructed room. `id` / `senderId` are opaque per-card keys, never messenger ids. */
export interface MessengerMessage {
  id: string;
  at?: Millis;
  senderId: string;
  /** display name with open-chat profile tags stripped ("김도윤/남/68년생/사진" → "김도윤"); "" for system lines */
  senderName: string;
  /** the full nickname when it differed from senderName */
  senderFull?: string;
  isMe: boolean;
  kind: MessengerMessageKind;
  /** body text; for photo/video/file/emoticon possibly "" (see attachment.label) */
  text: string;
  replyTo?: { senderName: string; text: string };
  attachment?: { label: string };
}

export interface ScheduleCard {
  type: "schedule";
  scheduleId: ID;
  title: string;
  when: string; // Korean human text "매일 오전 7:00"
  enabled: boolean;
  /** the text file whose text every run follows (DD 1852: a third line); `deleted` once it left the archive */
  file?: ScheduleFile;
}

/**
 * A schedule's attached text file: its name, and `deleted: true` once the person deleted it. The first run after that
 * tells the person and switches the schedule off (`enabled: false`, cards too); it cannot be switched on again (DD 2014).
 */
export interface ScheduleFile {
  name: string;
  deleted?: true;
}

export interface CardAction {
  label: string;
  /** text sent as a new user message when tapped */
  send?: string;
  /** client-side navigation target */
  open?: string;
}

export interface SendMessageRequest {
  text: string;
  attachmentIds?: ID[];
  /** "voice" = called from the call screen; agent answers short & speakable */
  mode?: "text" | "voice";
}

/**
 * When a turn is already running for this user, POST /api/threads/:id/messages does not start a
 * second turn: the text is steered into the running one (gajae-code style) and the server answers
 * `202 application/json` with this body instead of an SSE stream.
 */
export interface SteeredResponse {
  steered: true;
  userMessage: Message;
}

/**
 * The voice call cut a spoken reply off (the person talked over it): what they heard of it, so its history keeps only
 * that (POST /api/threads/:id/messages/:messageId/heard → 204). `heard` is a prefix of the reply's speakable() text,
 * in whole words ("" = nothing); the server counts it in spoken letters (speech.ts).
 */
export interface HeardRequest {
  heard: string;
}

export interface ApprovalDecisionRequest {
  decision: "approve" | "reject";
  /** base64url ECDSA P-256 signature (IEEE P1363) over `approve:<approvalId>:<nonce>` with the device signing key */
  signature?: string;
  nonce?: string;
  deviceId?: ID;
}

// ───────────────────────────── agent stream events ─────────────────────────────

export type AgentEvent =
  | { type: "start"; threadId: ID; userMessage: Message | null; messageId: ID }
  | { type: "status"; text: string } // short Korean status for the Dynamic Island ("날씨 보는 중")
  | { type: "text"; delta: string }
  | { type: "tool"; tool: ToolActivity } // emitted on start AND on every state change (same id)
  | { type: "card"; card: Card }
  | { type: "memory"; text: string } // a new memory was saved ("기억했어요")
  | { type: "done"; message: Message; quota: Quota }
  /**
   * The turn failed. `steersDropped`: the rows of the lines steered into it (202) that it read and leaves unanswered,
   * oldest first — the same rows as the `steers_dropped` every device got right before it, with no wait between, so
   * the app can drop their receipts as it draws the error row. Absent: none (lines still queued get a follow-up turn).
   */
  | { type: "error"; error: string; message: string; steersDropped?: ID[] };

// ───────────────────────────── explore (task templates) ─────────────────────────────

export interface TemplateCategory {
  id: string; // "recommend" | "benefit" | "shopping" | "travel" | "people" | "culture" | "home"
  title: string; // "추천"
  icon: IconName;
  emoji3d?: string; // optional asset key for the 3D-ish category icon
}

export interface TaskTemplate {
  id: ID;
  category: string;
  title: string;
  description: string;
  icon: IconName;
  hue: number; // tint of the template's icon plate
  /** what the person sends on "부탁하기": one short line in their own words (no tool ids); the server adds the
   * model-only how-to when this exact line opens a new task thread */
  prompt: string;
  /** the agent asks for missing details before it starts (PreDelegateSheet: "시작하기 전에 필요한 것만 짧게 물어봐요") */
  asksFirst: boolean;
  count: number; // "N명이 맡겼어요"
  skills: string[]; // which skills it exercises
}

export interface ExploreResponse {
  categories: TemplateCategory[];
  popular: TaskTemplate[];
  suggestions: TaskTemplate[]; // "깽이의 제안" (personalised)
}

export interface DelegateResponse {
  thread: Thread;
  prompt: string;
}

// ───────────────────────────── archive ─────────────────────────────

export type ArtifactKind = "document" | "dashboard" | "table" | "checklist" | "html";

/** most UTF-8 bytes an "html" artifact from the model may hold (the server refuses more) */
export const MAX_ARTIFACT_HTML_BYTES = 150 * 1024;
/**
 * most UTF-8 bytes of an "html" card the agent's own code renders (deep search '전부': one row per place), after
 * cleaning. Never reachable from a tool's arguments; the app shows cards up to this size.
 */
export const MAX_ARTIFACT_HTML_CARD_BYTES = 300 * 1024;

export interface Artifact {
  id: ID;
  threadId: ID | null;
  title: string;
  kind: ArtifactKind;
  /**
   * markdown for documents/checklists/tables; JSON string `{ "widgets": DashboardWidget[] }` for dashboards;
   * for "html" an HTML fragment (`<style>` blocks + body markup, no html/head/body) already cleaned by the server:
   * no scripts, frames, plugins, event handlers, forms or remote resources (images are data: URLs only, links https
   * only). Render it isolated (sandboxed iframe without allow-same-origin, a CSP without network) — the cleaning is
   * defence in depth.
   */
  content: string;
  createdAt: Millis;
  updatedAt: Millis;
}

export type DashboardWidget =
  | { type: "stat"; label: string; value: string; delta?: string }
  | { type: "bars"; label: string; points: { x: string; y: number }[]; /** the values' unit, e.g. "원" (shown with each value) */ unit?: string }
  | { type: "list"; label: string; items: string[] };

export interface AttachmentRef {
  id: ID;
  filename: string;
  mime: string;
  size: number;
  url: string; // authed GET, e.g. /api/attachments/:id/raw; "" once deleted
  /** Deleted from the archive (보관함): `url` is "", nothing to open; filename, mime and size stay. Set by the server on
   *  every message carrying it, which goes out again as `message`. */
  deleted?: true;
}

export interface Attachment extends AttachmentRef {
  threadId: ID | null;
  createdAt: Millis;
}

// ───────────────────────────── profile / usage ─────────────────────────────

export interface ProfileResponse {
  user: UserPublic;
  agent: AgentProfile;
  quota: Quota;
  tickets: Tickets;
  usage7d: { day: string; tokens: number }[]; // "MM-DD", oldest → newest
  connections: { connected: number; total: number; icons: string[] };
  paymentMethods: number;
  savedLogins: number;
  settings: SettingsView;
  memories: { id: ID; text: string; createdAt: Millis }[];
  /** 나의 모시 > 내 전화번호 (masked; null = not registered). Verified numbers can be called by sys_call_me. */
  phone?: { masked: string; verified: boolean } | null;
}

export interface UseTicketRequest {
  kind: keyof Tickets;
}

/**
 * PATCH /api/agent: only the fields sent change, merged into the profile as it is when the server applies the patch,
 * so two devices changing different fields both keep their change (the same field: the later request wins, and the
 * `agent` event brings every device to it).
 */
export interface AgentPatch {
  name?: string;
  persona?: string;
  /** only the parts sent change (`{ hue }` keeps shape and eyes); a full AvatarSpec still works */
  avatar?: Partial<AvatarSpec>;
  /** skill id → on / off, only the ids sent; at least one skill must stay on after the merge (400 no_skills) */
  skills?: Record<string, boolean>;
  /** older apps: the whole list, replacing it (the later request wins); 400 together with `skills` */
  enabledSkills?: string[];
}

// ───────────────────────────── Credential Enclave (vault) ─────────────────────────────

/**
 * Sealed-box envelope produced ON THE DEVICE. Plaintext = JSON of the credential fields
 * (e.g. {"username":"...","password":"..."}), never sent in the clear and never shown to the LLM.
 *
 * Algorithm "ECDH-P256+HKDF-SHA256+A256GCM":
 *   1. device makes an ephemeral ECDH P-256 key pair (epk)
 *   2. shared = ECDH(epk.private, enclave.publicKey)
 *   3. key = HKDF-SHA256(ikm=shared, salt=utf8(kid), info=utf8("pickle-enclave/v1"), 32 bytes)
 *   4. ct = AES-256-GCM(key, iv(12 random bytes), plaintext, additionalData=utf8(aad))
 *   aad = `${userId}:${service}:${kind}`
 */
export interface EnclaveEnvelope {
  v: 1;
  alg: "ECDH-P256+HKDF-SHA256+A256GCM";
  kid: string; // enclave key id
  epk: JsonWebKey; // ephemeral public key (ECDH P-256)
  iv: string; // base64url
  ct: string; // base64url (ciphertext||tag as produced by WebCrypto)
  aad: string;
}

export interface EnclaveInfo {
  kid: string;
  publicKey: JsonWebKey; // ECDH P-256
  alg: EnclaveEnvelope["alg"];
  /** sha256 of the enclave module source — "누구나 검증 가능" */
  measurement: string;
  createdAt: Millis;
}

export type CredentialKind = "login" | "card" | "token";
export type KeepFor = "1h" | "1d" | "7d" | "30d" | "forever";

export interface SaveCredentialRequest {
  service: string; // provider id
  label: string; // "카카오톡 (haneul@…)"
  kind: CredentialKind;
  /** masked hint only, e.g. "ha***@gmail.com" / "•••• 1234" */
  hint: string;
  keepFor: KeepFor;
  envelope: EnclaveEnvelope;
}

export interface CredentialInfo {
  id: ID;
  service: string;
  serviceName: string;
  label: string;
  kind: CredentialKind;
  hint: string;
  keepFor: KeepFor;
  expiresAt: Millis | null; // null = forever
  expired: boolean;
  createdAt: Millis;
  lastUsedAt: Millis | null;
  useCount: number;
}

export interface AccessRecord {
  id: ID;
  credentialId: ID | null;
  service: string;
  serviceName: string;
  action: string; // "login" | "send_message" | "read_messages" | "payment" | "view"
  purpose: string; // Korean, why
  actor: "agent" | "user" | "system";
  outcome: "ok" | "denied" | "error";
  deviceVerified: boolean; // "이 기기의 키로 확인했어요"
  createdAt: Millis;
}

// ───────────────────────────── connections (messengers + services) ─────────────────────────────

export type ProviderCategory = "messenger" | "service" | "korea";

export interface ProviderInfo {
  id: string; // "slack" | "kakaotalk" | "discord" | "telegram" | "teams" | "line" | "naver" | ...
  name: string; // "카카오톡"
  category: ProviderCategory;
  icon: IconName;
  hue: number;
  /**
   * how the user connects. "api_key": a k-skill service connected with the person's own API keys (토스증권 Open API,
   * 네이버 검색광고, 팝빌 …), sealed as kind "token"; the sheet and the row say "API 키로 연결".
   */
  auth: "credentials" | "token" | "oauth" | "none" | "api_key";
  fields: CredentialField[]; // for credentials/token auth
  /**
   * Vault kind the device seals the fields as (aad `${userId}:${id}:${kind}`). Absent → "token" for auth "token" or
   * "api_key", else "login". k-skill services (category "korea") always send it: API-key services are "token".
   */
  kind?: "login" | "token";
  /**
   * The sign-in the connect sheet runs (and the row subtitle names). Absent on old servers → derive from `auth`.
   *   relay_code   in-app login relay, the provider emails/sends a code (Slack)          "이메일 코드로 로그인"
   *   remote_auth  in-app login relay, approve in the provider's app / QR (Discord)    "앱에서 승인해 로그인"
   *   phone_code   in-app login relay, phone number + code (+2FA) (Telegram)          "전화번호로 로그인"
   *   password     id + password sealed on the device (KakaoTalk, LINE, Instagram, Webex) "계정으로 로그인"
   *   device_code  code shown here, typed on the provider's site (Teams)               "회사 계정으로 로그인"
   *   bot_token    a bot token the person made themselves (advanced)                    "봇 토큰으로 연결"
   */
  login?: LoginMethod;
  /** a bot the person made themselves: listed under "고급 · 직접 만든 봇 연결", not in the main list */
  advanced?: boolean;
  description: string;
  capabilities: ("read" | "send" | "list" | "search")[];
  /** false when the server lacks a runtime dependency (e.g. agent-messenger CLI missing) */
  available: boolean;
  unavailableReason?: string;
}

export type LoginMethod = "relay_code" | "remote_auth" | "phone_code" | "password" | "device_code" | "bot_token";

export type ConnectionStatus = "connected" | "needs_verification" | "error" | "disconnected" | "connecting";

export interface Connection {
  provider: string;
  status: ConnectionStatus;
  accountLabel: string | null;
  credentialId: ID | null;
  lastError: string | null;
  connectedAt: Millis | null;
  updatedAt: Millis;
}

export interface ConnectionsResponse {
  providers: ProviderInfo[];
  connections: Connection[];
}

export interface ConnectRequest {
  /** either reference an already saved credential, or send a fresh device-sealed envelope */
  credentialId?: ID;
  credential?: SaveCredentialRequest;
}

export interface ConnectResponse {
  connection: Connection;
  verification?: ConnectionVerification;
}

/**
 * - "display_code": the SERVER shows a code the user must type into the provider's phone app
 *   (KakaoTalk new-device passcode, LINE PIN). The server keeps polling in the background and
 *   pushes ServerEvent {type:"connection"} when the device is registered; the client may also
 *   poll GET /api/connections.
 * - "enter_code": the user types a code they received (Telegram login code, Instagram 2FA)
 *   and sends it with POST /api/connections/:provider/verify.
 */
export interface ConnectionVerification {
  kind: "display_code" | "enter_code";
  prompt: string; // Korean instructions
  code?: string; // display_code only
  length?: number; // enter_code only
  expiresAt?: Millis;
}

export interface VerifyConnectionRequest {
  code: string;
}

/**
 * Login relay (Slack, Discord, Telegram): the server signs in to the provider's own login and keeps only the resulting
 * session (sealed into the vault). Every secret the person types (email, phone, password, codes) is sealed ON THE
 * DEVICE with `sealForEnclave`, like a credential, but it is never stored: the relay opens it only to hand it to the
 * provider.
 *   start aad = `${userId}:${provider}:login-relay:start`, plaintext {email}            (slack only)
 *   step  aad = `${userId}:${provider}:login-relay:${relayId}`, plaintext {code} | {password} | {totp} | {phone}
 * Discord (remote auth): start {} → waiting_scan {qrUrl} → (poll: step {relayId}) → waiting_confirm {account} →
 *   connected | expired | cancelled | error.
 * Telegram (TDLib): start {} → needs_phone → step {phone} → needs_code {codeLength, codeVia, phoneMasked} →
 *   step {code} → needs_password {passwordHint?} (2FA) → step {password} → connected.
 */
export type LoginRelayState =
  | "needs_code"
  | "needs_password"
  | "needs_2fa"
  | "workspaces"
  | "needs_phone" // telegram: type the phone number
  | "waiting_scan" // discord: open qrUrl in the Discord app (same phone) or scan it from another device
  | "waiting_confirm" // discord: scanned; approve in the Discord app (`account` says who)
  | "connected"
  | "expired" // terminal: the provider's own time limit (discord QR) — offer "start again"
  | "cancelled" // terminal: cancelled here or in the provider's app
  | "error";

export type LoginRelayErrorCode =
  | "wrong_code" // retry allowed (state stays needs_code)
  | "wrong_password" // retry allowed (needs_password)
  | "wrong_totp" // retry allowed (needs_2fa)
  | "code_expired"
  | "too_many_attempts"
  | "sso_unsupported"
  | "workspace_not_found"
  | "workspace_required"
  | "password_unavailable"
  | "invalid_email"
  | "no_account"
  | "captcha"
  | "slack_ratelimited"
  | "token_not_found"
  | "auth_failed"
  | "timeout"
  | "cancelled"
  | "browser_unavailable"
  | "upstream"
  | "phone_invalid" // retry allowed (needs_phone)
  | "phone_banned"
  | "flood_wait" // the provider blocked attempts for a while (message says how long)
  | "unsupported" // the account needs a login step this relay does not support
  | "qr_rejected" // the person cancelled in the Discord app
  | "not_configured" // the operator has not configured this provider (e.g. Telegram api_id)
  | "network";

export interface LoginRelayStartRequest {
  provider?: "slack" | "discord" | "telegram"; // optional: the path already names it; must match when sent
  /** "sionic", "sionic.slack.com" or a URL; empty → find the workspaces by email */
  workspace?: string;
  /** "code" (default): Slack emails a 6-character code. "password": email + password on the workspace page */
  method?: "code" | "password";
  /** slack: required. discord / telegram: omitted (no secret at start; telegram sends the phone as a step) */
  email?: EnclaveEnvelope;
  /** how long the resulting session stays in the vault (default "30d") */
  keepFor?: KeepFor;
}

export interface LoginRelayStepRequest {
  relayId: ID;
  code?: EnclaveEnvelope;
  password?: EnclaveEnvelope;
  totp?: EnclaveEnvelope;
  /** telegram needs_phone: plaintext {phone} ("010-1234-5678" or "+8210…") */
  phone?: EnclaveEnvelope;
  /** pick one entry of `workspaces` */
  teamId?: string;
  /* discord / telegram: no secret field at all = poll (returns the current state) */
}

export interface LoginRelayWorkspace {
  id: string; // opaque, pass back as teamId
  name: string;
  domain: string | null; // "sionic.slack.com"
}

export interface LoginRelayResponse {
  relayId: ID;
  state: LoginRelayState;
  /** needs_code / needs_2fa: number of characters to type */
  codeLength?: number;
  workspaces?: LoginRelayWorkspace[];
  /** state "connected" */
  connection?: Connection;
  /** set on "error" (terminal, the relay is closed) and on a retryable wrong_* answer (state unchanged) */
  error?: { code: LoginRelayErrorCode; message: string };
  /** when the relay closes on its own */
  expiresAt: Millis;
  /** waiting_scan: https://discord.com/ra/<fingerprint> — open it (Discord app) or show it as a QR code */
  qrUrl?: string;
  /** waiting_scan: the same link as a QR code, "data:image/svg+xml;base64,…" (rendered by the server) */
  qrSvg?: string;
  /** waiting_confirm: who scanned, display name only */
  account?: { name: string };
  /** needs_code (telegram): where the code went, masked ("010-****-1234") */
  phoneMasked?: string;
  /** needs_code: where the provider sent the code */
  codeVia?: "app" | "sms" | "call" | "email";
  /** needs_password (telegram 2FA): the hint the person set themselves */
  passwordHint?: string;
  /** while waiting on another device: poll POST …/login/step {relayId} this often */
  pollMs?: number;
}

export interface MessengerChat {
  id: string;
  name: string;
  kind: "dm" | "group" | "channel";
  unread?: number;
  lastMessage?: string;
  lastAt?: Millis;
}

// ───────────────────────────── friends ─────────────────────────────

export interface Friend {
  userId: ID;
  displayName: string;
  handle: string;
  agentName: string;
  avatar: AvatarSpec;
  status: "accepted" | "pending_in" | "pending_out" | "blocked";
  threadId: ID | null;
  since: Millis;
}

export interface InviteResponse {
  token: string;
  url: string; // `${origin}/i/${token}`
  expiresAt: Millis;
}

// ───────────────────────────── schedules ─────────────────────────────

export interface Schedule {
  id: ID;
  title: string;
  prompt: string;
  /** "daily@07:30" | "weekly@1,3,5@09:00" | "once@<epoch ms>" (KST) */
  rule: string;
  human: string; // "매일 오전 7:30"
  enabled: boolean;
  threadId: ID | null;
  lastRunAt: Millis | null;
  nextRunAt: Millis | null;
  createdAt: Millis;
  /** the text file attached to every run (sys_schedule_create `file`, or POST attachmentId); absent when none */
  file?: ScheduleFile;
}

// ───────────────────────────── skills (k-skill) ─────────────────────────────

export interface SkillInfo {
  id: string; // "k.weather"
  title: string; // "날씨"
  description: string;
  category: string;
  icon: IconName;
  needsKey: boolean;
  configured: boolean; // key present (or keyless); for a `connection` skill: the owner has connected it
  source: string; // "NomaDamas/k-skill · weather"
  /** the k-skill login this skill runs with (vault service id, e.g. "popbill"); absent → keyless via the proxy */
  connection?: string;
  /** that login's display name ("팝빌") */
  connectionName?: string;
}

// ───────────────────────────── server push (/api/events SSE) ─────────────────────────────

export type ServerEvent =
  /**
   * First event of every stream. `settingsRev` / `agentRev`: the person's revisions as the stream opened (the stream is
   * registered before they are read, so a change made meanwhile still arrives as its event): a device that slept with
   * the stream closed re-reads GET /api/session when either differs from the one it has seen. Always sent by this
   * server.
   */
  | { type: "hello"; at: Millis; settingsRev?: number; agentRev?: number; investRev?: number }
  | { type: "thread_updated"; thread: Thread }
  /**
   * A row stored in a thread, to every member and every device of theirs: the person's lines (one that starts a turn,
   * one steered into a running turn, a queued first line, a friend-thread line), the agent's answers, event rows, card
   * status flips. The device whose request stored the row gets it too, besides that request's own answer (`start`, the
   * 202 / 201, `done`): merge by id, whichever comes first.
   */
  | { type: "message"; threadId: ID; message: Message }
  /**
   * A banner. `messageId`: the stored row it tells of (a friend's line, a friend's agent's message, a new friend's event
   * row, a schedule's or briefing's answer, a meeting's approval card), so an app showing that thread can leave the
   * banner out (the row is on screen). Left out when no row is behind it (a remembered fact, a skipped schedule).
   */
  | { type: "notification"; title: string; body: string; threadId?: ID; messageId?: ID; icon: IconName }
  | { type: "quota"; quota: Quota }
  | { type: "connection"; connection: Connection }
  | { type: "agent_status"; status: AgentStatus; text?: string }
  /**
   * The person's settings changed (PATCH /api/settings from any device of theirs, the one that sent it too): the whole
   * settings with their new `rev`. Never sent when a PATCH changes no value, never to anyone else.
   */
  | { type: "settings"; settings: SettingsView }
  /**
   * The person's agent profile changed (PATCH /api/agent from any device of theirs, the one that sent it too): the
   * whole profile with its new `rev`. Never sent when a PATCH changes nothing, never to anyone else.
   */
  | { type: "agent"; agent: AgentProfile }
  /**
   * A turn with no stream of its own (a briefing or schedule, a steer follow-up) failed after the person's lines went
   * into it, or a follow-up for the person's queued lines could not run (the day's quota is used up: `quota_exceeded`
   * with the quota message): show `message` as the thread's error, as a stream's `error` event does for a turn the app
   * started. A `steers_dropped` naming the lines it leaves unanswered comes right after it.
   */
  | { type: "turn_error"; threadId: ID; error: string; message: string }
  /**
   * A turn ended without answering lines the server steered into it (202; `messageIds` = their rows, oldest first).
   * A turn the app started: it stopped after the server took it (멈추기 on any device, the island's, the call talking
   * over it, the stream closing: all its lines, as no follow-up turn comes after a Stop), or it failed (the lines it took
   * in, right before its stream's `error`, which names the same rows; those still queued get a follow-up turn; the
   * error itself goes to the turn's stream alone). A turn with no
   * stream of its own (a briefing, a schedule, a follow-up; nothing stops it) failed: right after its `turn_error`, the
   * lines it took in and, for a follow-up, the lines it was answering (all of them when the day's quota kept it from
   * running); those still queued get a follow-up turn. Every
   * device of the person gets it, so the one that sent a line drops its steer receipt too. Not sent when no line goes
   * unanswered. The rows already carry `steerDropped` when it goes out (a page read meanwhile finds it).
   */
  | { type: "steers_dropped"; threadId: ID; messageIds: ID[] }
  /**
   * The server deleted a message it had stored (a failed briefing attempt's "오늘의 브리핑" event row: an app that loaded
   * the thread while the attempt ran holds it): drop it. A `thread_updated` with the list row's new preview follows.
   */
  | { type: "message_deleted"; threadId: ID; messageId: ID }
  /**
   * The person's invest overview changed (a quote, a rule, a watch state, Toss, settings): the whole overview with its new
   * `rev`, to every device of theirs alone. Sent only when the overview really changed. Alerts and stop records come as
   * `message` events like any row. `hello.investRev` tells a device that slept whether to re-read GET /api/invest.
   */
  | { type: "invest"; rev: number; overview: InvestOverview };

// ───────────────────────────── route table (documentation + client helper) ─────────────────────────────

export const ROUTES = {
  health: "GET /api/health",
  signup: "POST /api/auth/signup",
  login: "POST /api/auth/login",
  logout: "POST /api/auth/logout",
  resetStart: "POST /api/auth/reset/start {handle} → {channel:'call', masked} (409 no_verified_phone)",
  resetVerify: "POST /api/auth/reset/verify {handle, code, password, device} → AuthResponse",
  session: "GET /api/session",
  ui: "GET /api/ui-definitions",
  events: "GET /api/events (SSE ServerEvent; token via ?token= because EventSource has no headers)",
  threads: "GET /api/threads",
  createThread: "POST /api/threads {kind,title}",
  patchThread: "PATCH /api/threads/:id {archived?,title?}",
  messages: "GET /api/threads/:id/messages?before=<ms>&limit=<n>",
  send: "POST /api/threads/:id/messages SendMessageRequest → SSE AgentEvent",
  heard: "POST /api/threads/:id/messages/:messageId/heard HeardRequest → 204 (the call cut the reply off: its history keeps what was heard)",
  meet: "GET /api/threads/:id/meet → {meeting: MeetView | null} | POST /api/threads/:id/meet/leave → {ok, left, state} (apps/server/src/meetRoutes.ts)",
  approve: "POST /api/approvals/:id ApprovalDecisionRequest → SSE AgentEvent",
  explore: "GET /api/explore",
  delegate: "POST /api/explore/:templateId/delegate → DelegateResponse",
  artifacts: "GET /api/artifacts | GET /api/artifacts/:id | DELETE /api/artifacts/:id",
  blobs: "GET /api/blobs/:artifactId (raw artifact content, alias)",
  attachments: "POST /api/attachments (multipart file, threadId?) | GET /api/attachments | GET /api/attachments/:id/raw | DELETE",
  profile: "GET /api/profile",
  useTicket: "POST /api/tickets/use UseTicketRequest → {quota,tickets}",
  settings: "PATCH /api/settings SettingsPatch → SettingsView (+ `settings` event to the person's devices when a value changed)",
  agent: "GET /api/agent | PATCH /api/agent AgentPatch → AgentProfile (+ `agent` event when it changed) | POST /api/agent/restart",
  skills: "GET /api/skills → SkillInfo[]",
  memories: "GET /api/memories | DELETE /api/memories/:id",
  enclave: "GET /api/enclave → EnclaveInfo",
  credentials: "GET /api/credentials | POST /api/credentials SaveCredentialRequest | PATCH /api/credentials/:id {keepFor} | DELETE /api/credentials/:id",
  accessLog: "GET /api/access-log?limit=",
  connections: "GET /api/connections → ConnectionsResponse",
  connect: "POST /api/connections/:provider ConnectRequest → ConnectResponse",
  verify: "POST /api/connections/:provider/verify VerifyConnectionRequest → ConnectResponse",
  disconnect: "DELETE /api/connections/:provider",
  chats: "GET /api/connections/:provider/chats → MessengerChat[]",
  loginRelayStart: "POST /api/connections/:provider/login LoginRelayStartRequest → LoginRelayResponse (slack | discord | telegram)",
  loginRelayStep: "POST /api/connections/:provider/login/step LoginRelayStepRequest → LoginRelayResponse",
  loginRelayCancel: "POST /api/connections/:provider/login/cancel {relayId} → {ok:true}",
  friends: "GET /api/friends | POST /api/friends/:userId/block | DELETE /api/friends/:userId",
  invite: "POST /api/invites → InviteResponse | POST /api/invites/:token/accept → Friend | GET /i/:token (HTML landing)",
  schedules: "GET /api/schedules | POST /api/schedules | PATCH /api/schedules/:id | DELETE /api/schedules/:id",
  invest: "GET /api/invest → InvestOverview | GET /api/invest/symbols/:symbol → InvestSymbolDetail",
  investRules:
    "POST /api/invest/rules/preview InvestRuleDraft & {ruleId?, changes?} → InvestRulePreview | POST /api/invest/rules {draft, previewId?} → InvestRuleRow | PATCH /api/invest/rules/:id {changes, ifRev, previewId?} → InvestRuleRow (409 rule_changed {rule} / preview_stale {preview}) | DELETE /api/invest/rules/:id",
  investWatchlist: "POST /api/invest/watchlist {symbol} → InvestSymbolRow (404 unknown_symbol) | DELETE /api/invest/watchlist/:symbol?withRules=1 (409 has_rules {count})",
  investToss: "GET /api/invest/toss → InvestTossStatus | POST /api/invest/toss/check → InvestTossStatus (429 toss_check_too_soon); keys go through POST /api/connections/toss-investment or POST /api/credentials (service toss-investment, 연결 › 토스증권과 같은 연결)",
  investSettings: "PATCH /api/invest/settings InvestSettingsPatch → InvestSettingsView",
  investReal:
    "POST /api/invest/real/preview → InvestRealPreview (409 real_blocked, 429 rate_limited, 503 sellable_unknown) | POST /api/invest/real/enable InvestRealEnable → InvestSettingsView (400 invalid_signature / unknown_device, 403 bad_signature, 409 real_blocked {realBlockerText} / preview_stale {preview?}) | POST /api/invest/real/disable → InvestSettingsView",
  investLedger: "GET /api/invest/ledger?id&limit → {items: InvestLedgerEntry[]} | POST /api/invest/ledger InvestLedgerDraft → InvestLedgerEntry (409 ledger_locked, 400 ledger_reserved)",
  investForecasts: "GET /api/invest/forecasts → InvestForecastList | POST /api/invest/forecasts InvestForecastDraft → InvestForecast | PATCH /api/invest/forecasts/:id InvestForecastJudgement → InvestForecast (409 forecast_changed {forecast})",
  investEvents: "GET /api/invest/events?from&to → {items: InvestEvent[]} | POST /api/invest/events InvestEventDraft → InvestEvent (409 event_exists {event}) | PATCH /api/invest/events/:id {remind} → InvestEvent | DELETE /api/invest/events/:id",
  investStages: "GET /api/invest/stages → InvestStagesDetail (the board's stages and the 11 indicators, A1–A8, D1–D5, R1–R6 with their figures; DD 0059 §1-4)",
  investProposals: "POST /api/invest/proposals/:id {decision: 'apply' | 'keep'} → {card: InvestRuleChangeCard} (409 proposal_stale {card} / proposal_decided {card}, 410 proposal_expired {card}, 404 proposal_not_found)",
  push: "GET /api/push/key → {publicKey} | POST /api/push/subscriptions PushSubscription.toJSON() → {ok:true} (400 invalid_subscription) | DELETE /api/push/subscriptions {endpoint} → {ok:true, removed} — while the server sends nothing (no PICKLE_PUSH_SUBJECT) the key and POST answer 503 {error:'push_off'}, DELETE works",
} as const;

/**
 * What the service worker gets in a push event (B1c, push.ts): `title` alone is shown (DD 2042-b §4: symbol and event, no
 * amount — the body stays empty), `tag` replaces an earlier line of the same rule (`invest:<ruleId>`, `invest:blind`),
 * `threadId`/`messageId` are the row a tap opens (absent for the blind line).
 */
export interface WebPushPayload {
  v: 1;
  title: string;
  body: "";
  tag: string;
  threadId?: ID;
  messageId?: ID;
}

// ───────────────────────────── shared constants ─────────────────────────────

export const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
export const QUOTA_RESET_HOUR = 4;
export const DEFAULT_DAILY_TOKENS = 400_000;
export const MAX_MESSAGE_CHARS = 4000;

// ───────────────────────────── shared speech helpers ─────────────────────────────

/** has a Korean speaker finished their line? (the meeting's turn-taking and the app's voice call) */
export { endsInConnective, turnIncomplete } from "./turn";
/** the text a reply is spoken as, and how much of it was heard (the app's voice call and the server's heard cut) */
export { forSpeech, letters, speakable, speechNorm } from "./speech";

// ───────────────────────────── html artifacts ─────────────────────────────

/** the visible text of an "html" artifact, and its preview line (the card, the archive list) */
export { htmlPreview, htmlText } from "./html";

// ───────────────────────────── invest ─────────────────────────────

export type * from "./invest";
import type { InvestCard, InvestOverview } from "./invest";
/** the html artifact frame's own inline script (its sha256 is in the server's CSP) */
export { HTML_FRAME_SCRIPT } from "./htmlFrame";
