/**
 * bun:sqlite persistence. Every query that touches user data is scoped by user id (or by thread
 * membership, which is itself user-scoped). Implements the VaultStorage and MessengerStorage
 * interfaces from docs/architecture/PACKAGES.md.
 */
import { Database } from "bun:sqlite";
import type {
  AccessRecord,
  ApprovalStatus,
  Card,
  Connection,
  CredentialKind,
  KeepFor,
  Message,
  ThreadKind,
  ToolActivity,
  AttachmentRef,
  IconName,
} from "@pickle/protocol";
import { MIGRATIONS } from "./schema.ts";
import { safeJson } from "../util.ts";

// ───────────────────────────── row types ─────────────────────────────

export interface UserRow {
  id: string;
  handle: string;
  display_name: string;
  agent_name: string;
  password_hash: string;
  settings_json: string;
  main_thread_id: string | null;
  created_at: number;
}

export interface ThreadRow {
  id: string;
  owner_id: string;
  kind: ThreadKind;
  title: string;
  subtitle: string;
  icon: IconName;
  auto_title: number;
  created_at: number;
  updated_at: number;
  archived: number;
  unread: number;
}

export interface MessageRow {
  id: string;
  thread_id: string;
  role: Message["role"];
  text: string;
  cards_json: string;
  tools_json: string;
  attachments_json: string;
  author_user_id: string | null;
  author_kind: "human" | "agent" | null;
  llm_json: string | null;
  steered: number;
  created_at: number;
}

export interface NewMessage {
  id: string;
  threadId: string;
  role: Message["role"];
  text: string;
  cards?: Card[];
  tools?: ToolActivity[];
  attachments?: AttachmentRef[];
  authorUserId?: string | null;
  authorKind?: "human" | "agent" | null;
  llm?: unknown[] | null;
  steered?: boolean;
  createdAt: number;
}

export interface ApprovalRow {
  id: string;
  user_id: string;
  thread_id: string;
  message_id: string;
  call_json: string;
  prior_messages_json: string;
  spec_json: string;
  status: ApprovalStatus;
  nonce: string | null;
  device_verified: number;
  created_at: number;
  resolved_at: number | null;
  expires_at: number;
}

export interface ArtifactRow {
  id: string;
  user_id: string;
  thread_id: string | null;
  title: string;
  kind: "document" | "dashboard" | "table" | "checklist" | "html";
  content: string;
  created_at: number;
  updated_at: number;
}

export interface AttachmentRow {
  id: string;
  user_id: string;
  thread_id: string | null;
  filename: string;
  mime: string;
  size: number;
  created_at: number;
}

/** Something a user owns that their side can put in a friend thread: an artifact (as a card) or an attachment (sent). */
export type FriendThreadItem = { kind: "artifact" | "attachment"; id: string };

export interface TemplateRow {
  id: string;
  category: string;
  title: string;
  description: string;
  icon: IconName;
  hue: number;
  prompt: string;
  skills_json: string;
  sort: number;
  hidden: number;
  count: number;
}

export interface FriendRow {
  user_id: string;
  friend_id: string;
  status: "accepted" | "pending_in" | "pending_out" | "blocked";
  thread_id: string | null;
  created_at: number;
  updated_at: number;
}

export interface InviteRow {
  token: string;
  user_id: string;
  created_at: number;
  expires_at: number;
  uses: number;
}

export interface ScheduleRow {
  id: string;
  user_id: string;
  title: string;
  prompt: string;
  rule: string;
  human: string;
  enabled: number;
  thread_id: string | null;
  last_run_at: number | null;
  next_run_at: number | null;
  created_at: number;
}

/** Same shape as @pickle/vault CredentialRow. */
export interface CredentialRow {
  id: string;
  userId: string;
  service: string;
  label: string;
  kind: CredentialKind;
  hint: string;
  keepFor: KeepFor;
  expiresAt: number | null;
  sealed: string;
  createdAt: number;
  lastUsedAt: number | null;
  useCount: number;
}

/** Structural twin of @pickle/vault VaultStorage. */
export interface VaultStorageImpl {
  insertCredential(row: CredentialRow): Promise<void>;
  getCredential(userId: string, id: string): Promise<CredentialRow | null>;
  listCredentials(userId: string): Promise<CredentialRow[]>;
  updateCredential(userId: string, id: string, patch: Partial<CredentialRow>): Promise<void>;
  deleteCredential(userId: string, id: string): Promise<boolean>;
  getWrappedUserKey(userId: string): Promise<string | null>;
  setWrappedUserKey(userId: string, wrapped: string): Promise<void>;
  insertAccess(userId: string, rec: AccessRecord): Promise<void>;
  listAccess(userId: string, limit: number): Promise<AccessRecord[]>;
}

/** Structural twin of @pickle/messengers MessengerStorage. */
export interface MessengerStorageImpl {
  getConnection(userId: string, provider: string): Promise<(Connection & { meta: string | null }) | null>;
  listConnections(userId: string): Promise<Connection[]>;
  upsertConnection(userId: string, c: Connection & { meta?: string | null }): Promise<void>;
  deleteConnection(userId: string, provider: string): Promise<void>;
}

// ───────────────────────────── helpers ─────────────────────────────

interface CredentialDbRow {
  id: string;
  user_id: string;
  service: string;
  label: string;
  kind: CredentialKind;
  hint: string;
  keep_for: KeepFor;
  expires_at: number | null;
  sealed: string;
  created_at: number;
  last_used_at: number | null;
  use_count: number;
}

const credFromDb = (r: CredentialDbRow): CredentialRow => ({
  id: r.id,
  userId: r.user_id,
  service: r.service,
  label: r.label,
  kind: r.kind,
  hint: r.hint,
  keepFor: r.keep_for,
  expiresAt: r.expires_at,
  sealed: r.sealed,
  createdAt: r.created_at,
  lastUsedAt: r.last_used_at,
  useCount: r.use_count,
});

const CRED_COLS: Record<keyof Omit<CredentialRow, "id" | "userId">, string> = {
  service: "service",
  label: "label",
  kind: "kind",
  hint: "hint",
  keepFor: "keep_for",
  expiresAt: "expires_at",
  sealed: "sealed",
  createdAt: "created_at",
  lastUsedAt: "last_used_at",
  useCount: "use_count",
};

interface AccessDbRow {
  id: string;
  credential_id: string | null;
  service: string;
  service_name: string;
  action: string;
  purpose: string;
  actor: AccessRecord["actor"];
  outcome: AccessRecord["outcome"];
  device_verified: number;
  created_at: number;
}

interface ConnectionDbRow {
  provider: string;
  status: Connection["status"];
  account_label: string | null;
  credential_id: string | null;
  last_error: string | null;
  connected_at: number | null;
  updated_at: number;
  meta: string | null;
}

const connFromDb = (r: ConnectionDbRow): Connection => ({
  provider: r.provider,
  status: r.status,
  accountLabel: r.account_label,
  credentialId: r.credential_id,
  lastError: r.last_error,
  connectedAt: r.connected_at,
  updatedAt: r.updated_at,
});

// ───────────────────────────── Db ─────────────────────────────

export class Db {
  readonly sql: Database;

  constructor(path: string) {
    this.sql = new Database(path, { create: true, strict: true });
    this.sql.exec("PRAGMA journal_mode = WAL;");
    this.sql.exec("PRAGMA foreign_keys = ON;");
    this.sql.exec("PRAGMA busy_timeout = 5000;");
    this.sql.exec("PRAGMA synchronous = NORMAL;");
    this.migrate();
  }

  private migrate(): void {
    const row = this.sql.query("PRAGMA user_version").get() as { user_version: number };
    let version = row.user_version;
    for (let i = version; i < MIGRATIONS.length; i++) {
      this.sql.transaction(() => {
        this.sql.exec(MIGRATIONS[i]!);
        this.sql.exec(`PRAGMA user_version = ${i + 1}`);
      })();
      version = i + 1;
    }
  }

  get schemaVersion(): number {
    return (this.sql.query("PRAGMA user_version").get() as { user_version: number }).user_version;
  }

  ping(): boolean {
    try {
      this.sql.query("SELECT 1").get();
      return true;
    } catch {
      return false;
    }
  }

  close(): void {
    this.sql.close();
  }

  tx<T>(fn: () => T): T {
    return this.sql.transaction(fn)();
  }

  // ───────────── users ─────────────

  createUser(u: { id: string; handle: string; displayName: string; agentName: string; passwordHash: string; settingsJson: string; createdAt: number }): void {
    this.sql
      .query(
        `INSERT INTO users (id, handle, display_name, agent_name, password_hash, settings_json, created_at)
         VALUES ($id, $handle, $dn, $an, $ph, $s, $c)`,
      )
      .run({ id: u.id, handle: u.handle, dn: u.displayName, an: u.agentName, ph: u.passwordHash, s: u.settingsJson, c: u.createdAt });
    this.sql.query("INSERT INTO tickets (user_id) VALUES ($id)").run({ id: u.id });
  }

  userByHandle(handle: string): UserRow | null {
    return (this.sql.query("SELECT * FROM users WHERE handle = $h").get({ h: handle }) as UserRow | null) ?? null;
  }

  setPasswordHash(userId: string, passwordHash: string): void {
    this.sql.query("UPDATE users SET password_hash = $p WHERE id = $id").run({ id: userId, p: passwordHash });
  }

  userById(id: string): UserRow | null {
    return (this.sql.query("SELECT * FROM users WHERE id = $id").get({ id }) as UserRow | null) ?? null;
  }

  setUserSettings(id: string, settingsJson: string): void {
    this.sql.query("UPDATE users SET settings_json = $s WHERE id = $id").run({ id, s: settingsJson });
  }

  setMainThread(id: string, threadId: string): void {
    this.sql.query("UPDATE users SET main_thread_id = $t WHERE id = $id").run({ id, t: threadId });
  }

  setAgentName(id: string, name: string): void {
    this.sql.query("UPDATE users SET agent_name = $n WHERE id = $id").run({ id, n: name });
  }

  /** Users that used the app recently (any live session seen since `since`). */
  allUserIds(): string[] {
    return (this.sql.query("SELECT id FROM users").all() as { id: string }[]).map((r) => r.id);
  }

  activeUsers(since: number): UserRow[] {
    return this.sql
      .query(
        `SELECT u.* FROM users u WHERE EXISTS (SELECT 1 FROM sessions s WHERE s.user_id = u.id AND s.last_seen_at >= $since)`,
      )
      .all({ since }) as UserRow[];
  }

  // ───────────── devices ─────────────

  upsertDevice(userId: string, d: { id: string; label: string; signingJwk: string }, now: number): void {
    this.sql
      .query(
        `INSERT INTO devices (user_id, id, label, signing_jwk, created_at, last_seen_at) VALUES ($u, $id, $l, $j, $n, $n)
         ON CONFLICT(user_id, id) DO UPDATE SET label = excluded.label, signing_jwk = excluded.signing_jwk, last_seen_at = excluded.last_seen_at`,
      )
      .run({ u: userId, id: d.id, l: d.label, j: d.signingJwk, n: now });
  }

  getDevice(userId: string, deviceId: string): { id: string; label: string; signing_jwk: string } | null {
    return (
      (this.sql.query("SELECT id, label, signing_jwk FROM devices WHERE user_id = $u AND id = $id").get({ u: userId, id: deviceId }) as {
        id: string;
        label: string;
        signing_jwk: string;
      } | null) ?? null
    );
  }

  // ───────────── sessions ─────────────

  createSession(s: { tokenHash: string; userId: string; deviceId: string | null; now: number; expiresAt: number }): void {
    this.sql
      .query(
        `INSERT INTO sessions (token_hash, user_id, device_id, created_at, expires_at, last_seen_at) VALUES ($h, $u, $d, $n, $e, $n)`,
      )
      .run({ h: s.tokenHash, u: s.userId, d: s.deviceId, n: s.now, e: s.expiresAt });
  }

  sessionByHash(hash: string): { token_hash: string; user_id: string; device_id: string | null; expires_at: number; last_seen_at: number } | null {
    return (
      (this.sql.query("SELECT token_hash, user_id, device_id, expires_at, last_seen_at FROM sessions WHERE token_hash = $h").get({ h: hash }) as {
        token_hash: string;
        user_id: string;
        device_id: string | null;
        expires_at: number;
        last_seen_at: number;
      } | null) ?? null
    );
  }

  touchSession(hash: string, now: number): void {
    this.sql.query("UPDATE sessions SET last_seen_at = $n WHERE token_hash = $h").run({ h: hash, n: now });
  }

  deleteSession(hash: string): void {
    this.sql.query("DELETE FROM sessions WHERE token_hash = $h").run({ h: hash });
  }

  /** password reset: every device signs in again */
  deleteUserSessions(userId: string): number {
    return this.sql.query("DELETE FROM sessions WHERE user_id = $u").run({ u: userId }).changes;
  }

  purgeExpiredSessions(now: number): number {
    return this.sql.query("DELETE FROM sessions WHERE expires_at < $n").run({ n: now }).changes;
  }

  // ───────────── threads ─────────────

  createThread(
    t: { id: string; ownerId: string; kind: ThreadKind; title: string; subtitle: string; icon: IconName; autoTitle?: boolean; now: number },
    members: string[],
  ): void {
    this.tx(() => {
      this.sql
        .query(
          `INSERT INTO threads (id, owner_id, kind, title, subtitle, icon, auto_title, created_at, updated_at)
           VALUES ($id, $o, $k, $t, $s, $i, $a, $n, $n)`,
        )
        .run({ id: t.id, o: t.ownerId, k: t.kind, t: t.title, s: t.subtitle, i: t.icon, a: t.autoTitle ? 1 : 0, n: t.now });
      for (const m of members) this.sql.query("INSERT INTO thread_members (thread_id, user_id) VALUES ($t, $u)").run({ t: t.id, u: m });
    });
  }

  /** The thread as seen by `userId`, or null when they are not a member. */
  threadFor(threadId: string, userId: string): ThreadRow | null {
    return (
      (this.sql
        .query(
          `SELECT t.*, m.archived, m.unread FROM threads t JOIN thread_members m ON m.thread_id = t.id
           WHERE t.id = $t AND m.user_id = $u`,
        )
        .get({ t: threadId, u: userId }) as ThreadRow | null) ?? null
    );
  }

  threadsFor(userId: string): ThreadRow[] {
    return this.sql
      .query(
        `SELECT t.*, m.archived, m.unread FROM threads t JOIN thread_members m ON m.thread_id = t.id
         WHERE m.user_id = $u ORDER BY t.updated_at DESC`,
      )
      .all({ u: userId }) as ThreadRow[];
  }

  threadMembers(threadId: string): string[] {
    return (this.sql.query("SELECT user_id FROM thread_members WHERE thread_id = $t").all({ t: threadId }) as { user_id: string }[]).map((r) => r.user_id);
  }

  setThreadArchived(threadId: string, userId: string, archived: boolean): void {
    this.sql.query("UPDATE thread_members SET archived = $a WHERE thread_id = $t AND user_id = $u").run({ t: threadId, u: userId, a: archived ? 1 : 0 });
  }

  setThreadTitle(threadId: string, title: string): void {
    this.sql.query("UPDATE threads SET title = $title, auto_title = 0 WHERE id = $t").run({ t: threadId, title });
  }

  touchThread(threadId: string, now: number, subtitle?: string): void {
    if (subtitle === undefined) this.sql.query("UPDATE threads SET updated_at = $n WHERE id = $t").run({ t: threadId, n: now });
    else this.sql.query("UPDATE threads SET updated_at = $n, subtitle = $s WHERE id = $t").run({ t: threadId, n: now, s: subtitle });
  }

  setUnread(threadId: string, userId: string, unread: boolean): void {
    this.sql.query("UPDATE thread_members SET unread = $v WHERE thread_id = $t AND user_id = $u").run({ t: threadId, u: userId, v: unread ? 1 : 0 });
  }

  unreadCount(userId: string): number {
    return (this.sql.query("SELECT COUNT(*) AS n FROM thread_members WHERE user_id = $u AND unread = 1 AND archived = 0").get({ u: userId }) as { n: number }).n;
  }

  // ───────────── messages ─────────────

  insertMessage(m: NewMessage): void {
    this.sql
      .query(
        `INSERT INTO messages (id, thread_id, role, text, cards_json, tools_json, attachments_json, author_user_id, author_kind, llm_json, steered, created_at)
         VALUES ($id, $t, $r, $x, $c, $tl, $a, $au, $ak, $l, $s, $n)`,
      )
      .run({
        id: m.id,
        t: m.threadId,
        r: m.role,
        x: m.text,
        c: JSON.stringify(m.cards ?? []),
        tl: JSON.stringify(m.tools ?? []),
        a: JSON.stringify(m.attachments ?? []),
        au: m.authorUserId ?? null,
        ak: m.authorKind ?? null,
        l: m.llm ? JSON.stringify(m.llm) : null,
        s: m.steered ? 1 : 0,
        n: m.createdAt,
      });
  }

  getMessage(id: string): MessageRow | null {
    return (this.sql.query("SELECT * FROM messages WHERE id = $id").get({ id }) as MessageRow | null) ?? null;
  }

  /** Newest `limit` messages created before `before`, returned oldest → newest. */
  listMessages(threadId: string, before: number | null, limit: number): MessageRow[] {
    const rows = this.sql
      .query(
        `SELECT * FROM messages WHERE thread_id = $t AND ($b IS NULL OR created_at < $b)
         ORDER BY created_at DESC, rowid DESC LIMIT $l`,
      )
      .all({ t: threadId, b: before, l: limit }) as MessageRow[];
    return rows.reverse();
  }

  /** Messages for history replay: newest `limit` strictly before message `beforeId` (or all), oldest → newest. */
  historyRows(threadId: string, limit: number, excludeFromRowOf?: string): MessageRow[] {
    if (excludeFromRowOf) {
      const rows = this.sql
        .query(
          `SELECT * FROM messages WHERE thread_id = $t AND rowid < (SELECT rowid FROM messages WHERE id = $x)
           ORDER BY rowid DESC LIMIT $l`,
        )
        .all({ t: threadId, x: excludeFromRowOf, l: limit }) as MessageRow[];
      return rows.reverse();
    }
    const rows = this.sql.query(`SELECT * FROM messages WHERE thread_id = $t ORDER BY rowid DESC LIMIT $l`).all({ t: threadId, l: limit }) as MessageRow[];
    return rows.reverse();
  }

  /** Rows of a thread inserted after `afterId` (rowid order). */
  messagesAfter(threadId: string, afterId: string): MessageRow[] {
    return this.sql
      .query(`SELECT * FROM messages WHERE thread_id = $t AND rowid > (SELECT rowid FROM messages WHERE id = $x) ORDER BY rowid ASC`)
      .all({ t: threadId, x: afterId }) as MessageRow[];
  }

  /** Replace what a row contributes to LLM history (never changes what the chat shows). */
  setMessageLlm(id: string, llm: unknown[] | null): void {
    this.sql.query("UPDATE messages SET llm_json = $l WHERE id = $id").run({ id, l: llm ? JSON.stringify(llm) : null });
  }

  updateMessageCards(id: string, cards: Card[]): void {
    this.sql.query("UPDATE messages SET cards_json = $c WHERE id = $id").run({ id, c: JSON.stringify(cards) });
  }

  /** Messages in the user's own threads whose cards contain a card of `type` (LIKE prefilter). */
  messagesWithCard(userId: string, type: string): MessageRow[] {
    return this.sql
      .query(
        `SELECT msg.* FROM messages msg JOIN thread_members m ON m.thread_id = msg.thread_id
         WHERE m.user_id = $u AND msg.cards_json LIKE $p ORDER BY msg.created_at DESC LIMIT 200`,
      )
      .all({ u: userId, p: `%"type":"${type}"%` }) as MessageRow[];
  }

  // ───────────── approvals ─────────────

  insertApproval(a: {
    id: string;
    userId: string;
    threadId: string;
    messageId: string;
    callJson: string;
    priorJson: string;
    specJson: string;
    now: number;
    expiresAt: number;
  }): void {
    this.sql
      .query(
        `INSERT INTO approvals (id, user_id, thread_id, message_id, call_json, prior_messages_json, spec_json, status, created_at, expires_at)
         VALUES ($id, $u, $t, $m, $c, $p, $s, 'pending', $n, $e)`,
      )
      .run({ id: a.id, u: a.userId, t: a.threadId, m: a.messageId, c: a.callJson, p: a.priorJson, s: a.specJson, n: a.now, e: a.expiresAt });
  }

  getApproval(userId: string, id: string): ApprovalRow | null {
    return (this.sql.query("SELECT * FROM approvals WHERE id = $id AND user_id = $u").get({ id, u: userId }) as ApprovalRow | null) ?? null;
  }

  /** Atomically moves a pending approval to `status`; false if it was no longer pending. */
  resolveApproval(userId: string, id: string, status: ApprovalStatus, now: number, nonce: string | null, deviceVerified: boolean): boolean {
    return (
      this.sql
        .query(
          `UPDATE approvals SET status = $s, resolved_at = $n, nonce = $nonce, device_verified = $dv
           WHERE id = $id AND user_id = $u AND status = 'pending'`,
        )
        .run({ id, u: userId, s: status, n: now, nonce, dv: deviceVerified ? 1 : 0 }).changes === 1
    );
  }

  // ───────────── artifacts ─────────────

  insertArtifact(a: { id: string; userId: string; threadId: string | null; title: string; kind: ArtifactRow["kind"]; content: string; now: number }): void {
    this.sql
      .query(
        `INSERT INTO artifacts (id, user_id, thread_id, title, kind, content, created_at, updated_at) VALUES ($id, $u, $t, $ti, $k, $c, $n, $n)`,
      )
      .run({ id: a.id, u: a.userId, t: a.threadId, ti: a.title, k: a.kind, c: a.content, n: a.now });
  }

  listArtifacts(userId: string): ArtifactRow[] {
    return this.sql.query("SELECT * FROM artifacts WHERE user_id = $u ORDER BY created_at DESC LIMIT 500").all({ u: userId }) as ArtifactRow[];
  }

  getArtifact(userId: string, id: string): ArtifactRow | null {
    return (this.sql.query("SELECT * FROM artifacts WHERE id = $id AND user_id = $u").get({ id, u: userId }) as ArtifactRow | null) ?? null;
  }

  deleteArtifact(userId: string, id: string): boolean {
    return this.sql.query("DELETE FROM artifacts WHERE id = $id AND user_id = $u").run({ id, u: userId }).changes === 1;
  }

  /** Any user's artifact by id, owner unchecked: only for a read the caller has cleared (archive.ts readableArtifact). */
  artifactById(id: string): ArtifactRow | null {
    return (this.sql.query("SELECT * FROM artifacts WHERE id = $id").get({ id }) as ArtifactRow | null) ?? null;
  }

  /**
   * Whether the owner put this artifact or attachment in a friend thread `viewerId` is in: a message the owner's side
   * wrote there (they, or their agent) carries it — the artifact as a card, the attachment as a sent file — and both
   * are still members of that thread. Friendship is the caller's check (archive.ts sharedByFriend).
   */
  postedInFriendThread(viewerId: string, ownerId: string, item: FriendThreadItem): boolean {
    const carries =
      item.kind === "artifact"
        ? `EXISTS (SELECT 1 FROM json_each(m.cards_json) c
                   WHERE json_extract(c.value, '$.type') = 'artifact' AND json_extract(c.value, '$.artifactId') = $id)`
        : `EXISTS (SELECT 1 FROM json_each(m.attachments_json) f WHERE json_extract(f.value, '$.id') = $id)`;
    return !!this.sql
      .query(
        `SELECT 1 FROM messages m
         JOIN threads t ON t.id = m.thread_id AND t.kind = 'friend'
         JOIN thread_members mv ON mv.thread_id = t.id AND mv.user_id = $v
         JOIN thread_members mo ON mo.thread_id = t.id AND mo.user_id = $o
         WHERE m.author_user_id = $o AND ${carries}
         LIMIT 1`,
      )
      .get({ v: viewerId, o: ownerId, id: item.id });
  }

  // ───────────── attachments ─────────────

  insertAttachment(a: { id: string; userId: string; threadId: string | null; filename: string; mime: string; size: number; now: number }): void {
    this.sql
      .query(`INSERT INTO attachments (id, user_id, thread_id, filename, mime, size, created_at) VALUES ($id, $u, $t, $f, $m, $s, $n)`)
      .run({ id: a.id, u: a.userId, t: a.threadId, f: a.filename, m: a.mime, s: a.size, n: a.now });
  }

  listAttachments(userId: string): AttachmentRow[] {
    return this.sql.query("SELECT * FROM attachments WHERE user_id = $u ORDER BY created_at DESC LIMIT 500").all({ u: userId }) as AttachmentRow[];
  }

  getAttachment(userId: string, id: string): AttachmentRow | null {
    return (this.sql.query("SELECT * FROM attachments WHERE id = $id AND user_id = $u").get({ id, u: userId }) as AttachmentRow | null) ?? null;
  }

  /** Any user's attachment by id, owner unchecked: only for a read the caller has cleared (archive.ts readableAttachment). */
  attachmentById(id: string): AttachmentRow | null {
    return (this.sql.query("SELECT * FROM attachments WHERE id = $id").get({ id }) as AttachmentRow | null) ?? null;
  }

  setAttachmentThread(userId: string, id: string, threadId: string): void {
    this.sql.query("UPDATE attachments SET thread_id = $t WHERE id = $id AND user_id = $u").run({ id, u: userId, t: threadId });
  }

  deleteAttachment(userId: string, id: string): boolean {
    return this.sql.query("DELETE FROM attachments WHERE id = $id AND user_id = $u").run({ id, u: userId }).changes === 1;
  }

  // ───────────── usage / tickets ─────────────

  addUsage(userId: string, day: string, tokens: number): void {
    if (!(tokens > 0)) return;
    this.sql
      .query(
        `INSERT INTO usage (user_id, kst_day, tokens, counted) VALUES ($u, $d, $t, $t)
         ON CONFLICT(user_id, kst_day) DO UPDATE SET tokens = tokens + excluded.tokens, counted = counted + excluded.counted`,
      )
      .run({ u: userId, d: day, t: Math.round(tokens) });
  }

  usage(userId: string, day: string): { tokens: number; counted: number } {
    return (
      (this.sql.query("SELECT tokens, counted FROM usage WHERE user_id = $u AND kst_day = $d").get({ u: userId, d: day }) as {
        tokens: number;
        counted: number;
      } | null) ?? { tokens: 0, counted: 0 }
    );
  }

  usageDays(userId: string, days: string[]): Map<string, number> {
    const out = new Map<string, number>();
    if (!days.length) return out;
    const rows = this.sql
      .query("SELECT kst_day, tokens FROM usage WHERE user_id = $u AND kst_day >= $from AND kst_day <= $to")
      .all({ u: userId, from: days[0]!, to: days[days.length - 1]! }) as { kst_day: string; tokens: number }[];
    for (const r of rows) out.set(r.kst_day, r.tokens);
    return out;
  }

  resetCounted(userId: string, day: string): void {
    this.sql.query("UPDATE usage SET counted = 0 WHERE user_id = $u AND kst_day = $d").run({ u: userId, d: day });
  }

  tickets(userId: string): { basic: number; premium: number } {
    return (this.sql.query("SELECT basic, premium FROM tickets WHERE user_id = $u").get({ u: userId }) as { basic: number; premium: number } | null) ?? {
      basic: 0,
      premium: 0,
    };
  }

  /** Decrements one ticket of `kind`; false when none left. */
  useTicket(userId: string, kind: "basic" | "premium"): boolean {
    const col = kind === "premium" ? "premium" : "basic";
    return this.sql.query(`UPDATE tickets SET ${col} = ${col} - 1 WHERE user_id = $u AND ${col} > 0`).run({ u: userId }).changes === 1;
  }

  // ───────────── templates ─────────────

  upsertTemplate(t: { id: string; category: string; title: string; description: string; icon: IconName; hue: number; prompt: string; skills: string[]; sort: number; hidden: boolean }): void {
    this.sql
      .query(
        `INSERT INTO templates (id, category, title, description, icon, hue, prompt, skills_json, sort, hidden)
         VALUES ($id, $c, $t, $d, $i, $h, $p, $s, $o, $hid)
         ON CONFLICT(id) DO UPDATE SET category = excluded.category, title = excluded.title, description = excluded.description,
           icon = excluded.icon, hue = excluded.hue, prompt = excluded.prompt, skills_json = excluded.skills_json, sort = excluded.sort, hidden = excluded.hidden`,
      )
      .run({ id: t.id, c: t.category, t: t.title, d: t.description, i: t.icon, h: t.hue, p: t.prompt, s: JSON.stringify(t.skills), o: t.sort, hid: t.hidden ? 1 : 0 });
  }

  hideTemplate(id: string): void {
    this.sql.query("UPDATE templates SET hidden = 1 WHERE id = $id").run({ id });
  }

  listTemplates(includeHidden = false): TemplateRow[] {
    return this.sql
      .query(
        `SELECT t.*, COALESCE(c.count, 0) AS count FROM templates t LEFT JOIN template_counts c ON c.template_id = t.id
         WHERE ($all = 1 OR t.hidden = 0) ORDER BY count DESC, t.sort ASC`,
      )
      .all({ all: includeHidden ? 1 : 0 }) as TemplateRow[];
  }

  getTemplate(id: string): TemplateRow | null {
    return (
      (this.sql
        .query(`SELECT t.*, COALESCE(c.count, 0) AS count FROM templates t LEFT JOIN template_counts c ON c.template_id = t.id WHERE t.id = $id`)
        .get({ id }) as TemplateRow | null) ?? null
    );
  }

  incrementTemplate(id: string): void {
    this.sql
      .query("INSERT INTO template_counts (template_id, count) VALUES ($id, 1) ON CONFLICT(template_id) DO UPDATE SET count = count + 1")
      .run({ id });
  }

  // ───────────── friends / invites ─────────────

  upsertFriend(userId: string, friendId: string, status: FriendRow["status"], threadId: string | null, now: number): void {
    this.sql
      .query(
        `INSERT INTO friends (user_id, friend_id, status, thread_id, created_at, updated_at) VALUES ($u, $f, $s, $t, $n, $n)
         ON CONFLICT(user_id, friend_id) DO UPDATE SET status = excluded.status, thread_id = COALESCE(excluded.thread_id, friends.thread_id), updated_at = excluded.updated_at`,
      )
      .run({ u: userId, f: friendId, s: status, t: threadId, n: now });
  }

  getFriend(userId: string, friendId: string): FriendRow | null {
    return (this.sql.query("SELECT * FROM friends WHERE user_id = $u AND friend_id = $f").get({ u: userId, f: friendId }) as FriendRow | null) ?? null;
  }

  listFriends(userId: string): (FriendRow & { handle: string; display_name: string; agent_name: string })[] {
    return this.sql
      .query(
        `SELECT f.*, u.handle, u.display_name, u.agent_name FROM friends f JOIN users u ON u.id = f.friend_id
         WHERE f.user_id = $u ORDER BY f.created_at ASC`,
      )
      .all({ u: userId }) as (FriendRow & { handle: string; display_name: string; agent_name: string })[];
  }

  deleteFriend(userId: string, friendId: string): boolean {
    return this.sql.query("DELETE FROM friends WHERE user_id = $u AND friend_id = $f").run({ u: userId, f: friendId }).changes === 1;
  }

  insertInvite(i: { token: string; userId: string; now: number; expiresAt: number }): void {
    this.sql.query("INSERT INTO invites (token, user_id, created_at, expires_at) VALUES ($t, $u, $n, $e)").run({ t: i.token, u: i.userId, n: i.now, e: i.expiresAt });
  }

  getInvite(token: string): InviteRow | null {
    return (this.sql.query("SELECT * FROM invites WHERE token = $t").get({ t: token }) as InviteRow | null) ?? null;
  }

  useInvite(token: string): void {
    this.sql.query("UPDATE invites SET uses = uses + 1 WHERE token = $t").run({ t: token });
  }

  // ───────────── schedules ─────────────

  insertSchedule(s: { id: string; userId: string; title: string; prompt: string; rule: string; human: string; enabled: boolean; threadId: string | null; nextRunAt: number | null; now: number }): void {
    this.sql
      .query(
        `INSERT INTO schedules (id, user_id, title, prompt, rule, human, enabled, thread_id, next_run_at, created_at)
         VALUES ($id, $u, $t, $p, $r, $h, $e, $th, $nr, $n)`,
      )
      .run({ id: s.id, u: s.userId, t: s.title, p: s.prompt, r: s.rule, h: s.human, e: s.enabled ? 1 : 0, th: s.threadId, nr: s.nextRunAt, n: s.now });
  }

  listSchedules(userId: string): ScheduleRow[] {
    return this.sql.query("SELECT * FROM schedules WHERE user_id = $u ORDER BY created_at ASC").all({ u: userId }) as ScheduleRow[];
  }

  getSchedule(userId: string, id: string): ScheduleRow | null {
    return (this.sql.query("SELECT * FROM schedules WHERE id = $id AND user_id = $u").get({ id, u: userId }) as ScheduleRow | null) ?? null;
  }

  updateSchedule(userId: string, id: string, p: { title: string; prompt: string; rule: string; human: string; enabled: boolean; nextRunAt: number | null }): void {
    this.sql
      .query(
        `UPDATE schedules SET title = $t, prompt = $p, rule = $r, human = $h, enabled = $e, next_run_at = $nr WHERE id = $id AND user_id = $u`,
      )
      .run({ id, u: userId, t: p.title, p: p.prompt, r: p.rule, h: p.human, e: p.enabled ? 1 : 0, nr: p.nextRunAt });
  }

  deleteSchedule(userId: string, id: string): boolean {
    return this.sql.query("DELETE FROM schedules WHERE id = $id AND user_id = $u").run({ id, u: userId }).changes === 1;
  }

  dueSchedules(now: number, limit: number): ScheduleRow[] {
    return this.sql
      .query("SELECT * FROM schedules WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= $n ORDER BY next_run_at ASC LIMIT $l")
      .all({ n: now, l: limit }) as ScheduleRow[];
  }

  markScheduleRun(id: string, lastRunAt: number, nextRunAt: number | null): void {
    this.sql
      .query("UPDATE schedules SET last_run_at = $l, next_run_at = $nr, enabled = CASE WHEN $nr IS NULL THEN 0 ELSE enabled END WHERE id = $id")
      .run({ id, l: lastRunAt, nr: nextRunAt });
  }

  setScheduleThread(id: string, threadId: string): void {
    this.sql.query("UPDATE schedules SET thread_id = $t WHERE id = $id").run({ id, t: threadId });
  }

  // ───────────── kv ─────────────

  kvGet(userId: string, key: string): string | null {
    return (this.sql.query("SELECT value FROM kv WHERE user_id = $u AND key = $k").get({ u: userId, k: key }) as { value: string } | null)?.value ?? null;
  }

  kvSet(userId: string, key: string, value: string, now: number): void {
    this.sql
      .query("INSERT INTO kv (user_id, key, value, updated_at) VALUES ($u, $k, $v, $n) ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
      .run({ u: userId, k: key, v: value, n: now });
  }

  // ───────────── credentials (counts for profile) ─────────────

  credentialCounts(userId: string): { card: number; login: number } {
    const rows = this.sql.query("SELECT kind, COUNT(*) AS n FROM credentials WHERE user_id = $u GROUP BY kind").all({ u: userId }) as { kind: string; n: number }[];
    const out = { card: 0, login: 0 };
    for (const r of rows) if (r.kind === "card" || r.kind === "login") out[r.kind] = r.n;
    return out;
  }

  // ───────────── storage adapters ─────────────

  vaultStorage(): VaultStorageImpl {
    const sql = this.sql;
    return {
      insertCredential: async (row) => {
        sql
          .query(
            `INSERT INTO credentials (id, user_id, service, label, kind, hint, keep_for, expires_at, sealed, created_at, last_used_at, use_count)
             VALUES ($id, $u, $s, $l, $k, $h, $kf, $e, $se, $c, $lu, $uc)`,
          )
          .run({
            id: row.id,
            u: row.userId,
            s: row.service,
            l: row.label,
            k: row.kind,
            h: row.hint,
            kf: row.keepFor,
            e: row.expiresAt,
            se: row.sealed,
            c: row.createdAt,
            lu: row.lastUsedAt,
            uc: row.useCount,
          });
      },
      getCredential: async (userId, id) => {
        const r = sql.query("SELECT * FROM credentials WHERE id = $id AND user_id = $u").get({ id, u: userId }) as CredentialDbRow | null;
        return r ? credFromDb(r) : null;
      },
      listCredentials: async (userId) =>
        (sql.query("SELECT * FROM credentials WHERE user_id = $u ORDER BY created_at DESC").all({ u: userId }) as CredentialDbRow[]).map(credFromDb),
      updateCredential: async (userId, id, patch) => {
        const sets: string[] = [];
        const params: Record<string, string | number | null> = { id, u: userId };
        for (const [k, col] of Object.entries(CRED_COLS)) {
          const v = (patch as Record<string, unknown>)[k];
          if (v === undefined) continue;
          sets.push(`${col} = $${k}`);
          params[k] = v as string | number | null;
        }
        if (!sets.length) return;
        sql.query(`UPDATE credentials SET ${sets.join(", ")} WHERE id = $id AND user_id = $u`).run(params);
      },
      deleteCredential: async (userId, id) => sql.query("DELETE FROM credentials WHERE id = $id AND user_id = $u").run({ id, u: userId }).changes === 1,
      getWrappedUserKey: async (userId) =>
        (sql.query("SELECT wrapped FROM user_keys WHERE user_id = $u").get({ u: userId }) as { wrapped: string } | null)?.wrapped ?? null,
      setWrappedUserKey: async (userId, wrapped) => {
        sql
          .query("INSERT INTO user_keys (user_id, wrapped, created_at) VALUES ($u, $w, $n) ON CONFLICT(user_id) DO NOTHING")
          .run({ u: userId, w: wrapped, n: Date.now() });
      },
      insertAccess: async (userId, rec) => {
        sql
          .query(
            `INSERT INTO access_log (id, user_id, credential_id, service, service_name, action, purpose, actor, outcome, device_verified, created_at)
             VALUES ($id, $u, $c, $s, $sn, $a, $p, $ac, $o, $dv, $n)`,
          )
          .run({
            id: rec.id,
            u: userId,
            c: rec.credentialId,
            s: rec.service,
            sn: rec.serviceName,
            a: rec.action,
            p: rec.purpose,
            ac: rec.actor,
            o: rec.outcome,
            dv: rec.deviceVerified ? 1 : 0,
            n: rec.createdAt,
          });
      },
      listAccess: async (userId, limit) =>
        (
          sql.query("SELECT * FROM access_log WHERE user_id = $u ORDER BY created_at DESC, rowid DESC LIMIT $l").all({ u: userId, l: limit }) as AccessDbRow[]
        ).map((r) => ({
          id: r.id,
          credentialId: r.credential_id,
          service: r.service,
          serviceName: r.service_name,
          action: r.action,
          purpose: r.purpose,
          actor: r.actor,
          outcome: r.outcome,
          deviceVerified: r.device_verified === 1,
          createdAt: r.created_at,
        })),
    };
  }

  messengerStorage(): MessengerStorageImpl {
    const sql = this.sql;
    return {
      getConnection: async (userId, provider) => {
        const r = sql.query("SELECT * FROM connections WHERE user_id = $u AND provider = $p").get({ u: userId, p: provider }) as ConnectionDbRow | null;
        return r ? { ...connFromDb(r), meta: r.meta } : null;
      },
      listConnections: async (userId) =>
        (sql.query("SELECT * FROM connections WHERE user_id = $u ORDER BY provider").all({ u: userId }) as ConnectionDbRow[]).map(connFromDb),
      upsertConnection: async (userId, c) => {
        sql
          .query(
            `INSERT INTO connections (user_id, provider, status, account_label, credential_id, last_error, connected_at, updated_at, meta)
             VALUES ($u, $p, $s, $al, $c, $le, $ca, $ua, $m)
             ON CONFLICT(user_id, provider) DO UPDATE SET status = excluded.status, account_label = excluded.account_label,
               credential_id = excluded.credential_id, last_error = excluded.last_error, connected_at = excluded.connected_at,
               updated_at = excluded.updated_at, meta = CASE WHEN $metaSet = 1 THEN excluded.meta ELSE connections.meta END`,
          )
          .run({
            u: userId,
            p: c.provider,
            s: c.status,
            al: c.accountLabel,
            c: c.credentialId,
            le: c.lastError,
            ca: c.connectedAt,
            ua: c.updatedAt,
            m: c.meta ?? null,
            metaSet: c.meta === undefined ? 0 : 1,
          });
      },
      deleteConnection: async (userId, provider) => {
        sql.query("DELETE FROM connections WHERE user_id = $u AND provider = $p").run({ u: userId, p: provider });
      },
    };
  }
}

export function openDatabase(path: string): Db {
  return new Db(path);
}

export { safeJson };
