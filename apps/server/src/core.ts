/**
 * Shared server context + mapping from DB rows to protocol wire types (per viewer).
 */
import {
  QUOTA_RESET_HOUR,
  type AgentProfile,
  type Message,
  type Quota,
  type Thread,
  type SettingsView,
  type UserPublic,
  type UserSettings,
} from "@pickle/protocol";
import type { AppDeps, ConnectionsLike, ServerConfig } from "./deps.ts";
import type { Db, MessageRow, ThreadRow, UserRow } from "./db/index.ts";
import type { EventHub } from "./events.ts";
import type { VoiceIo } from "./audio.ts";
import type { InvestHub } from "./invest/hub.ts";
import type { MeetHub } from "./meet.ts";
import type { Logger } from "./log.ts";
import { nextQuotaReset, quotaDay } from "./kst.ts";
import { normalizeSettings } from "./settings.ts";
import { safeJson, wa } from "./util.ts";
import { threadPreview, threadWaiting } from "./threadState.ts";

export interface Core {
  deps: AppDeps;
  db: Db;
  cfg: ServerConfig;
  events: EventHub;
  log: Logger;
  now(): number;
  /** background tasks (memory extraction, titles, follow-ups) — awaited by close() and tests */
  track(p: Promise<unknown>): void;
  /**
   * Which thread currently holds each user's agent lease (null = busy, not steerable yet).
   * Steering is only allowed into a turn running in the *same* thread.
   */
  /**
   * per user: the turn holding the agent; `stopping` is set once its client stopped it (resolves at release);
   * `steered`: the rows of the lines steered into it (202), oldest first
   */
  activeTurns: Map<string, { threadId: string | null; token: object; stopping?: Promise<void>; steered: string[] }>;
  idle(): Promise<void>;
  /** local TTS client + public audio tokens for Twilio <Play> (see audio.ts) */
  voice: VoiceIo;
  /** Google Meet participation through services/meet (see meet.ts) */
  meet: MeetHub;
  /** invest watch, alerts, overview (invest/hub.ts) */
  invest: InvestHub;
  /** k-skill logins (kskill.ts, docs/architecture/KSKILL-CONNECTIONS.md) */
  connections: ConnectionsLike;
}

export function userPublic(u: UserRow): UserPublic {
  return { id: u.id, handle: u.handle, displayName: u.display_name, createdAt: u.created_at };
}

export function settingsOf(u: UserRow): UserSettings {
  return normalizeSettings(safeJson(u.settings_json, null));
}

/** The settings as handed out (session, profile, PATCH answer, `settings` event): with the person's revision. */
export function settingsView(u: UserRow): SettingsView {
  return { ...settingsOf(u), rev: u.settings_rev };
}

export function quotaFor(core: Core, userId: string): Quota {
  const now = core.now();
  const used = core.db.usage(userId, quotaDay(now)).counted;
  const limit = core.cfg.dailyTokens;
  const pct = used <= 0 ? 0 : Math.min(100, Math.max(1, Math.round((used / limit) * 100)));
  return { usedPct: pct, usedTokens: used, limitTokens: limit, resetsAt: nextQuotaReset(now), resetHour: QUOTA_RESET_HOUR };
}

export function quotaExceeded(core: Core, userId: string): boolean {
  const q = quotaFor(core, userId);
  return q.usedTokens >= q.limitTokens;
}

export const QUOTA_MESSAGE =
  "오늘 사용량 한도를 다 썼어요. 매일 새벽 4시에 초기화되고, 지금 바로 이어서 쓰려면 나의 모시에서 한도 초기화 티켓을 사용해 주세요.";

/** The agent's live status (the launcher's turn pool); "idle" when it cannot tell. */
export function agentStatusOf(core: Core, userId: string): AgentProfile["status"] {
  try {
    return core.deps.launcher.status(userId);
  } catch {
    return "idle";
  }
}

/** Agent profile from the launcher with live status; synthesised if the workspace is missing. */
export async function agentFor(core: Core, user: UserRow): Promise<AgentProfile> {
  let p: AgentProfile | null = null;
  try {
    p = await core.deps.launcher.profile(user.id);
  } catch (err) {
    core.log.warn("launcher.profile failed", { user: user.id, err: String(err).slice(0, 80) });
  }
  const status = agentStatusOf(core, user.id);
  if (p) return { ...p, status };
  return {
    id: user.id,
    name: user.agent_name,
    persona: "",
    avatar: { hue: 8, shape: "blob", eyes: "dot" },
    model: core.deps.llm?.model ?? "",
    status,
    enabledSkills: [],
    createdAt: user.created_at,
    lastActiveAt: null,
    rev: 0, // below any stored revision: a device that has seen one keeps it (AgentProfile.rev)
  };
}

// ───────────────────────────── thread / message views ─────────────────────────────

export function threadView(core: Core, t: ThreadRow, viewerId: string): Thread {
  const base: Thread = {
    id: t.id,
    kind: t.kind,
    title: t.title,
    subtitle: t.subtitle,
    icon: t.icon,
    archived: t.archived === 1,
    unread: t.unread === 1,
    createdAt: t.created_at,
    updatedAt: t.updated_at,
    preview: threadPreview(core, t.id),
    waiting: threadWaiting(core, t, viewerId),
  };
  if (t.kind === "friend") {
    const peerId = core.db.threadMembers(t.id).find((id) => id !== viewerId);
    const me = core.db.userById(viewerId);
    const peer = peerId ? core.db.userById(peerId) : null;
    if (peer) {
      base.peer = { userId: peer.id, displayName: peer.display_name, agentName: peer.agent_name };
      base.title = `${wa(me?.agent_name ?? "모시")} ${peer.display_name}님의 모시`;
    }
  }
  return base;
}

export function threadViewById(core: Core, threadId: string, viewerId: string): Thread | null {
  const row = core.db.threadFor(threadId, viewerId);
  return row ? threadView(core, row, viewerId) : null;
}

export function messageView(core: Core, m: MessageRow, viewerId: string): Message {
  const msg: Message = {
    id: m.id,
    threadId: m.thread_id,
    role: m.role,
    text: m.text,
    cards: safeJson(m.cards_json, []),
    tools: safeJson(m.tools_json, []),
    attachments: safeJson(m.attachments_json, []),
    createdAt: m.created_at,
  };
  if (m.author_kind && m.author_user_id) {
    const author = core.db.userById(m.author_user_id);
    const mine = m.author_user_id === viewerId;
    if (m.author_kind === "human") {
      msg.author = mine ? { kind: "me", name: author?.display_name ?? "나" } : { kind: "peer", name: `${author?.display_name ?? "친구"} 님` };
    } else {
      msg.author = mine
        ? { kind: "my-agent", name: author?.agent_name ?? "내 모시" }
        : { kind: "peer-agent", name: `${author?.display_name ?? "친구"} 님의 ${author?.agent_name ?? "모시"}` };
    }
  }
  // a line of the viewer's own that its turn left unanswered (steers_dropped); a line in their own thread has no author
  if (m.steered === 2 && m.role === "user" && (m.author_user_id ?? core.db.threadFor(m.thread_id, viewerId)?.owner_id) === viewerId) msg.steerDropped = true;
  return msg;
}

export function messageViewById(core: Core, id: string, viewerId: string): Message | null {
  const row = core.db.getMessage(id);
  return row ? messageView(core, row, viewerId) : null;
}

/** Push `thread_updated` to every member of the thread (each with their own view). */
export function publishThread(core: Core, threadId: string): void {
  for (const uid of core.db.threadMembers(threadId)) {
    const t = threadViewById(core, threadId, uid);
    if (t) core.events.publish(uid, { type: "thread_updated", thread: t });
  }
}

/**
 * Push a `message` event for a stored message to every thread member (each device of theirs). Two flags ride this live
 * push alone; page reads and the request's own answer (202 / 201) leave them out, as an app that reloads can't know
 * which receipts went away since (`steerDropped`, stored, comes with every view of the line: messageView):
 *  - `steered: true` on a line the server steered into a running turn, while no `steers_dropped` named it (a dropped line
 *    carries `steerDropped` alone);
 *  - with `delivered`, `delivered: true` on a friend-thread line that reached the friend without a turn (201), for the
 *    devices of the line's author alone (the friend got the line itself; the flag means nothing there).
 */
export function publishMessage(core: Core, messageId: string, opts: { delivered?: boolean } = {}): void {
  const row = core.db.getMessage(messageId);
  if (!row) return;
  for (const uid of core.db.threadMembers(row.thread_id)) {
    const message = messageView(core, row, uid);
    if (row.steered === 1) message.steered = true;
    if (opts.delivered && uid === row.author_user_id) message.delivered = true;
    core.events.publish(uid, { type: "message", threadId: row.thread_id, message });
  }
}
