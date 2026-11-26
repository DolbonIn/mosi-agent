import type {
  AgentEvent,
  AgentProfile,
  AgentStatus,
  ApprovalStatus,
  Card,
  ConnectRequest,
  ConnectResponse,
  Connection,
  ConnectionsResponse,
  DeepPartial,
  ID,
  Message,
  ProfileResponse,
  Quota,
  SessionBootstrap,
  SettingsPatch,
  Thread,
  Tickets,
  ToolActivity,
  UiDefinitions,
  UserSettings,
} from "@pickle/protocol";
import { isBusy, island, islandStore } from "../app/island";
import { createStore, useStore } from "../lib/createStore";
import { getTier, setDisplayPrefs, type DisplayPrefs } from "../motion/tier";
import { ApiError, clearToken, getToken, isAborted, koreanMessage, setUnauthorizedHandler, toApiError } from "./client";
import { DEFAULT_UI } from "./defaults";
import * as ep from "./endpoints";
import { connectEvents, disconnectEvents, onServerEvent } from "./events";
import type { TurnResult } from "./sse";

/**
 * App data: tiny external stores (lib/createStore) + useSyncExternalStore hooks. No provider.
 * Streaming: sendMessage() adds an optimistic user message, then folds AgentEvents into a per-thread StreamingDraft
 * (text deltas coalesced per frame) and drives the agent-state store (app/island.ts: thinking → tool:<name> →
 * streaming → done / awaiting_approval / error); `done` replaces the draft with the final Message.
 * Server behaviour follows docs/architecture/SERVER-CONTRACT.md (steer 202, busy 409, friend delivery 201, …).
 */

// ───────────────────────────── state shapes ─────────────────────────────

export type SessionStatus = "unknown" | "anon" | "loading" | "ready" | "error";
export interface SessionState {
  status: SessionStatus;
  session: SessionBootstrap | null;
  error?: string;
}

export interface ThreadsState {
  items: Thread[]; // newest first
  loading: boolean;
  loaded: boolean;
  error?: string;
}

export interface StreamingDraft {
  messageId: ID;
  text: string;
  tools: ToolActivity[];
  cards: Card[];
  /** short Korean status ("날씨 보는 중") */
  status: string | null;
  startedAt: number;
}

export interface ThreadMessages {
  items: Message[]; // oldest → newest
  draft: StreamingDraft | null;
  /** a turn this client started is streaming */
  streaming: boolean;
  loading: boolean;
  loaded: boolean;
  hasMore: boolean;
  /** Korean, user-facing; cleared by the next send */
  error?: string;
  /** optimistic user messages whose send failed (keep them; offer "다시 보내기") */
  failed: ID[];
  /**
   * a reconnect may have missed changes here: the first page is read again when the thread is next on screen (catchUp).
   * Which reconnect (a count): a read answers only the one it was sent for, not one that came while it was out
   */
  stale?: number;
  /**
   * when a re-read last dropped the pages held (more than a page missed; ms, new on every such re-read): the thread
   * view starts over at the end, and rows dated before it don't enter (as on opening)
   */
  epoch?: number;
}

export interface ConnectionsState extends ConnectionsResponse {
  loading: boolean;
  loaded: boolean;
  error?: string;
}

export interface ProfileState {
  data: ProfileResponse | null;
  loading: boolean;
  error?: string;
}

// ───────────────────────────── stores ─────────────────────────────

export const sessionStore = createStore<SessionState>({ status: "unknown", session: null });
export const uiStore = createStore<UiDefinitions>(DEFAULT_UI);
export const threadsStore = createStore<ThreadsState>({ items: [], loading: false, loaded: false });
export const messagesStore = createStore<Record<ID, ThreadMessages>>({});
export const connectionsStore = createStore<ConnectionsState>({ providers: [], connections: [], loading: false, loaded: false });
export const profileStore = createStore<ProfileState>({ data: null, loading: false });
export const settingsStore = createStore<UserSettings | null>(null);

const EMPTY_THREAD: ThreadMessages = Object.freeze({
  items: [],
  draft: null,
  streaming: false,
  loading: false,
  loaded: false,
  hasMore: true,
  failed: [],
}) as unknown as ThreadMessages;

// ───────────────────────────── hooks ─────────────────────────────

export const useSession = () => useStore(sessionStore);
export const useUi = () => useStore(uiStore);
export const useThreads = () => useStore(threadsStore);
export const useThread = (id: ID | null | undefined) => useStore(threadsStore, (s) => (id ? s.items.find((t) => t.id === id) : undefined), Object.is);
export const useMessages = (threadId: ID | null | undefined) => useStore(messagesStore, (s) => (threadId ? s[threadId] : undefined) ?? EMPTY_THREAD, Object.is);
export const useDraft = (threadId: ID | null | undefined) => useStore(messagesStore, (s) => (threadId ? s[threadId]?.draft ?? null : null), Object.is);
export const useConnections = () => useStore(connectionsStore);
export const useProfile = () => useStore(profileStore);
export const useSettings = () => useStore(settingsStore);
export const useQuota = () => useStore(sessionStore, (s) => s.session?.quota ?? null, Object.is);
export const useAgent = () => useStore(sessionStore, (s) => s.session?.agent ?? null, Object.is);

// ───────────────────────────── helpers ─────────────────────────────

const TEMP_PREFIX = "tmp_";
export const isTempId = (id: ID) => id.startsWith(TEMP_PREFIX);
let tempSeq = 0;
const tempId = () => `${TEMP_PREFIX}${Date.now().toString(36)}${(++tempSeq).toString(36)}`;

function patchThread(threadId: ID, fn: (t: ThreadMessages) => ThreadMessages) {
  messagesStore.set((prev) => ({ ...prev, [threadId]: fn(prev[threadId] ?? EMPTY_THREAD) }));
}

function sortMessages(items: Message[]): Message[] {
  // temp (optimistic) rows stay at the end in insertion order
  return items.slice().sort((a, b) => {
    const ta = isTempId(a.id);
    const tb = isTempId(b.id);
    if (ta !== tb) return ta ? 1 : -1;
    return a.createdAt - b.createdAt;
  });
}

function mergeById(a: Message[], b: Message[]): Message[] {
  const map = new Map<ID, Message>();
  for (const m of a) map.set(m.id, m);
  for (const m of b) map.set(m.id, m);
  return sortMessages([...map.values()]);
}

function upsertById<T extends { id: ID }>(list: T[], item: T): T[] {
  const i = list.findIndex((x) => x.id === item.id);
  if (i < 0) return [...list, item];
  const next = list.slice();
  next[i] = item;
  return next;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** Deep merge for settings patches (arrays and primitives replace). */
export function deepMerge<T>(base: T, patch: DeepPartial<T>): T {
  if (!isPlainObject(base) || !isPlainObject(patch)) return (patch as T) ?? base;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    out[k] = isPlainObject(v) && isPlainObject(out[k]) ? deepMerge(out[k], v as DeepPartial<unknown>) : v;
  }
  return out as T;
}

// text deltas coalesced to one store write per frame
const pendingText = new Map<ID, string>();
let flushScheduled = false;
function scheduleFlush() {
  if (flushScheduled) return;
  flushScheduled = true;
  const run = () => {
    flushScheduled = false;
    flushText();
  };
  if (typeof requestAnimationFrame === "function" && typeof document !== "undefined" && !document.hidden) requestAnimationFrame(run);
  else setTimeout(run, 32);
}
function flushText(only?: ID) {
  for (const [threadId, delta] of [...pendingText]) {
    if (only && threadId !== only) continue;
    pendingText.delete(threadId);
    patchThread(threadId, (t) => (t.draft ? { ...t, draft: { ...t.draft, text: t.draft.text + delta } } : t));
  }
}

function hasPendingDecision(m: Message): boolean {
  return m.cards.some((c) => (c.type === "approval" && c.status === "pending") || (c.type === "credential_request" && c.status === "pending"));
}

/** Turn a partially streamed draft into a message so nothing the person already read disappears. */
function finalizeDraft(threadId: ID): Message | null {
  flushText(threadId);
  let partial: Message | null = null;
  patchThread(threadId, (t) => {
    const d = t.draft;
    if (!d) return t;
    if (!d.text.trim() && !d.tools.length && !d.cards.length) return { ...t, draft: null };
    partial = { id: d.messageId, threadId, role: "assistant", text: d.text, cards: d.cards, tools: d.tools, attachments: [], createdAt: d.startedAt };
    return { ...t, draft: null, items: mergeById(t.items, [partial]) };
  });
  return partial;
}

function setThreadError(threadId: ID, error: string | undefined) {
  patchThread(threadId, (t) => ({ ...t, error }));
}

function touchThread(threadId: ID, at: number) {
  const s = threadsStore.get();
  const i = s.items.findIndex((t) => t.id === threadId);
  if (i < 0) return;
  const items = s.items.slice();
  items[i] = { ...items[i], updatedAt: Math.max(items[i].updatedAt, at) };
  threadsStore.set({ ...s, items: items.sort((a, b) => b.updatedAt - a.updatedAt) });
}

// ───────────────────────────── mutators (used by events.ts too) ─────────────────────────────

/** this device's copy: the server clears `unread` on GET messages and tells the person's other devices (thread_updated) */
export function markThreadRead(threadId: ID) {
  const s = threadsStore.get();
  const i = s.items.findIndex((t) => t.id === threadId);
  if (i < 0 || !s.items[i].unread) return;
  const items = s.items.slice();
  items[i] = { ...items[i], unread: false };
  threadsStore.set({ ...s, items });
}

export function upsertThread(thread: Thread) {
  const s = threadsStore.get();
  const items = s.items.filter((t) => t.id !== thread.id);
  items.push(thread);
  threadsStore.set({ ...s, items: items.sort((a, b) => b.updatedAt - a.updatedAt) });
}

/**
 * A message pushed by the server (or another device). Replaces an optimistic copy of the same user text. A row the
 * server deleted (message_deleted, or gone from a re-read page) stays out, should its push come late.
 */
export function appendMessage(threadId: ID, m: Message) {
  if (deletedIds.has(m.id)) return;
  patchThread(threadId, (t) => {
    let items = t.items;
    if (!items.some((x) => x.id === m.id) && m.role === "user") {
      const temp = items.find((x) => isTempId(x.id) && x.role === "user" && x.text === m.text);
      if (temp) {
        items = items.filter((x) => x.id !== temp.id);
        sentHere.add(m.id); // our line, pushed before our request's answer came back
      }
    }
    const draft = t.draft && t.draft.messageId === m.id ? null : t.draft;
    return { ...t, draft, items: sortMessages(upsertById(items, m)) };
  });
  touchThread(threadId, m.createdAt);
}

/**
 * events.ts `message_deleted`: the server deleted a row it had stored (a failed briefing attempt's event row, there on a
 * screen that loaded the thread while the attempt ran). Every screen of this app drops it, and a page already on its way
 * (fetched before the delete) doesn't bring it back.
 */
export function removeMessage(threadId: ID, messageId: ID) {
  deletedIds.add(messageId);
  if (!messagesStore.get()[threadId]?.items.some((m) => m.id === messageId)) return;
  patchThread(threadId, (t) => ({ ...t, items: t.items.filter((m) => m.id !== messageId) }));
}

export function setQuota(quota: Quota) {
  const s = sessionStore.get();
  if (s.session) sessionStore.set({ ...s, session: { ...s.session, quota } });
  const p = profileStore.get();
  if (p.data) profileStore.set({ ...p, data: { ...p.data, quota } });
}

function setTickets(tickets: Tickets) {
  const s = sessionStore.get();
  if (s.session) sessionStore.set({ ...s, session: { ...s.session, tickets } });
  const p = profileStore.get();
  if (p.data) profileStore.set({ ...p, data: { ...p.data, tickets } });
}

export function upsertConnection(c: Connection) {
  const s = connectionsStore.get();
  const others = s.connections.filter((x) => x.provider !== c.provider);
  connectionsStore.set({ ...s, connections: [...others, c] });
}

function setSessionSettings(settings: UserSettings) {
  settingsStore.set(settings);
  const s = sessionStore.get();
  if (s.session) sessionStore.set({ ...s, session: { ...s.session, settings } });
}

export function applyUi(ui: UiDefinitions | null | undefined) {
  if (!ui || typeof ui !== "object") return;
  const merged: UiDefinitions = { ...DEFAULT_UI, ...ui };
  if (!Array.isArray(merged.tabs) || !merged.tabs.length) merged.tabs = DEFAULT_UI.tabs;
  uiStore.set(merged);
}

/** Install a fresh session (bootstrap, login, signup). */
export function applySession(session: SessionBootstrap) {
  sessionStore.set({ status: "ready", session });
  settingsStore.set(session.settings);
  const display = session.settings?.display;
  if (display) {
    const cur = getTier().prefs;
    if (cur.theme !== display.theme || cur.reduceMotion !== display.reduceMotion || cur.reduceTransparency !== display.reduceTransparency || cur.textScale !== display.textScale) {
      setDisplayPrefs(display);
    }
  }
}

// ───────────────────────────── session lifecycle ─────────────────────────────

let bootPromise: Promise<void> | null = null;

/** Token? → session + ui-definitions in parallel → ready + live events. No token → anon. */
/** the agent changed (PATCH /api/agent): the session's copy follows, so every avatar re-renders */
export function applyAgent(agent: AgentProfile) {
  sessionStore.set((s) => (s.session ? { ...s, session: { ...s.session, agent } } : s));
}

export function bootstrap(): Promise<void> {
  bootPromise ??= (async () => {
    try {
      if (!getToken()) {
        sessionStore.set({ status: "anon", session: null });
        ep.uiDefinitions({ auth: false })
          .then(applyUi)
          .catch(() => {});
        return;
      }
      sessionStore.set({ ...sessionStore.get(), status: "loading", error: undefined });
      const [session, ui] = await Promise.all([ep.session(), ep.uiDefinitions().catch(() => null)]);
      applySession(session);
      applyUi(ui);
      connectEvents();
    } catch (e) {
      const err = toApiError(e);
      if (err.status === 401) return; // unauthorized handler already reset to anon
      sessionStore.set({ status: "error", session: null, error: err.message });
    } finally {
      bootPromise = null;
    }
  })();
  return bootPromise;
}

/** Re-read the session (e.g. after a ticket was used elsewhere). */
export async function refreshSession(): Promise<void> {
  if (!getToken()) return;
  try {
    applySession(await ep.session());
  } catch {
    /* keep what we have */
  }
}

const turns = new Map<ID, AbortController>();
/** an agent turn runs somewhere else (another tab, a schedule, a friend's thread) — from agent_status */
let remoteBusy = false;
/** the last failed send, for island 다시 시도 */
let lastFailed: { threadId: ID; text: string; tempId: ID | null } | null = null;
/**
 * The island's "다시 시도할까요?" (lastFailed's thread) gave way to a turn from elsewhere that started while it showed: the
 * follow-up the server runs right after a failed turn for the lines it left (or any other turn). That turn's work shows
 * as usual; when it ends with that thread's error row still up, the island asks again (yieldError, setRemoteAgentStatus)
 */
let heldError: ID | null = null;
/** an agent_status other than running came since this device's own turn started: a running one now is another turn */
let idleSinceOwn = false;
/**
 * the person's lines this device sent and the server took (a turn's start, a steer or friend delivery, the pushed copy
 * that replaced our optimistic one): `turn_error` reaches every device of theirs, and only the one that sent the line
 * offers 다시 시도 (two devices pressing it would send the line twice). Memory only: after a reload it is empty
 */
const sentHere = new Set<ID>();
/** rows the server deleted (`message_deleted`), kept out of messages pages that were fetched before the delete */
const deletedIds = new Set<ID>();

/** Local sign-out: forget the token, close live events, clear every store. */
export function resetSession(error?: string) {
  clearToken();
  disconnectEvents();
  for (const c of turns.values()) c.abort();
  turns.clear();
  pendingText.clear();
  threadsStore.set({ items: [], loading: false, loaded: false });
  messagesStore.set({});
  connectionsStore.set({ providers: [], connections: [], loading: false, loaded: false });
  profileStore.set({ data: null, loading: false });
  settingsStore.set(null);
  remoteBusy = false;
  lastFailed = null;
  heldError = null;
  sentHere.clear();
  deletedIds.clear();
  hellos = 0;
  island.idle();
  sessionStore.set({ status: "anon", session: null, error });
}

/** Server sign-out (best effort) + local reset. */
export async function logout(): Promise<void> {
  if (getToken()) await ep.logout().catch(() => {});
  resetSession();
}

setUnauthorizedHandler(() => resetSession(koreanMessage(401)));

// ───────────────────────────── loaders ─────────────────────────────

export async function loadThreads(): Promise<void> {
  const s = threadsStore.get();
  if (s.loading) return;
  threadsStore.set({ ...s, loading: true, error: undefined });
  try {
    const items = (await ep.threads()).sort((a, b) => b.updatedAt - a.updatedAt);
    threadsStore.set({ items, loading: false, loaded: true });
  } catch (e) {
    threadsStore.set({ ...threadsStore.get(), loading: false, error: toApiError(e).message });
  }
}

/** First page (newest) or, with `older`, the page before the oldest loaded message. */
export async function loadMessages(threadId: ID, { older = false }: { older?: boolean } = {}): Promise<void> {
  const cur = messagesStore.get()[threadId] ?? EMPTY_THREAD;
  if (cur.loading || (older && !cur.hasMore)) return;
  patchThread(threadId, (t) => ({ ...t, loading: true }));
  try {
    const oldest = cur.items.find((m) => !isTempId(m.id));
    const page = await ep.messages(threadId, { before: older ? oldest?.createdAt : undefined });
    const messages = page.messages.filter((m) => !deletedIds.has(m.id));
    // a re-read dropped the pages held meanwhile (refreshRecent): this page no longer joins on to them
    if ((messagesStore.get()[threadId]?.epoch ?? 0) !== (cur.epoch ?? 0)) return patchThread(threadId, (t) => ({ ...t, loading: false }));
    patchThread(threadId, (t) => ({ ...t, items: mergeById(t.items, messages), loading: false, loaded: true, hasMore: page.hasMore }));
  } catch (e) {
    patchThread(threadId, (t) => ({ ...t, loading: false, error: toApiError(e).message }));
  }
}

// ── catching up after a reconnect (screens/chat/catchUp.ts): the server does not replay events sent while this device
// was away, so the thread list and the first page of a thread on screen are read again and merged in (DD 2259 §6, 0327)

/** `hello` counted since sign-in: the first one comes with the reads the app starts with, later ones are reconnects */
let hellos = 0;
/** whether this `hello` is a reconnect (not the first since sign-in; resetSession counts again) */
export function noteHello(): boolean {
  return ++hellos > 1;
}

/**
 * Read the thread list again and merge it in. The answer wins, except for a thread changed here while the request was
 * out (a thread_updated, a local read or touch: its object is no longer the one held when the request went), which keeps
 * its change; archiving, renaming and reading don't move updatedAt, so it can't decide. A thread the answer leaves out
 * goes (deleted, unfriended) unless it came in meanwhile. Threads in `shown` stay read: their view reads the first page.
 */
export async function refreshThreads(shown: ReadonlySet<ID> = new Set()): Promise<void> {
  const before = new Map(threadsStore.get().items.map((t) => [t.id, t] as const));
  let fetched: Thread[];
  try {
    fetched = await ep.threads();
  } catch {
    return; // keep what we have; the next reconnect or opening the drawer reads again
  }
  const cur = threadsStore.get();
  const now = new Map(cur.items.map((t) => [t.id, t] as const));
  const touched = (id: ID) => now.has(id) && now.get(id) !== before.get(id);
  const items: Thread[] = [];
  for (const t of fetched) {
    const kept = touched(t.id) ? now.get(t.id)! : t;
    items.push(shown.has(t.id) && kept.unread ? { ...kept, unread: false } : kept);
  }
  const listed = new Set(fetched.map((t) => t.id));
  for (const t of cur.items) if (!listed.has(t.id) && (!before.has(t.id) || touched(t.id))) items.push(t);
  threadsStore.set({ ...cur, items: items.sort((a, b) => b.updatedAt - a.updatedAt), loading: false, loaded: true, error: undefined });
}

let staleCount = 0;
/** every thread whose pages are held reads its first page again when it is next on screen (ThreadView) */
export function markThreadsStale() {
  const all = messagesStore.get();
  if (!Object.values(all).some((t) => t.loaded)) return;
  const stale = ++staleCount;
  messagesStore.set(Object.fromEntries(Object.entries(all).map(([id, t]) => [id, t.loaded ? { ...t, stale } : t])));
}

/**
 * Read a thread's first page again and swap it in for the server rows it covers (DD 2259 §6): after the page's oldest
 * row (the whole thread when there is no more), rows the page leaves out were deleted and go the way of
 * message_deleted; rows changed or added here while the request was out (a push, this device's own turn) keep the
 * change; optimistic and failed lines, older pages and receipts (composerStore) are not touched; a row the same as before
 * keeps its object. A page that shares no row with the ones held, with more behind it (over a page missed), replaces
 * them: `epoch` is set and the view starts over at the end. Two reads that overlap merge safely: each keeps what
 * changed since it was sent, so the later answer landing first loses nothing.
 */
export async function refreshRecent(threadId: ID): Promise<void> {
  const held = messagesStore.get()[threadId];
  if (!held?.loaded) return;
  const before = new Map(held.items.map((m) => [m.id, m] as const));
  const answers = held.stale;
  try {
    const page = await ep.messages(threadId);
    // a reconnect that came while this was out wants its own read (the rows it may have missed came after this one)
    patchThread(threadId, (t) => ({ ...t, ...recentSwap(t, before, page.messages, page.hasMore), stale: t.stale === answers ? undefined : t.stale }));
  } catch {
    /* stays stale: read again when next on screen or at the next reconnect */
  }
}

/** the swap itself (refreshRecent): `before` is the thread's rows when the request went, `rows` the page */
export function recentSwap(t: ThreadMessages, before: ReadonlyMap<ID, Message>, rows: readonly Message[], hasMore: boolean): Partial<ThreadMessages> {
  const page = rows.filter((m) => !deletedIds.has(m.id));
  const now = new Map(t.items.map((m) => [m.id, m] as const));
  const touched = (id: ID) => now.has(id) && now.get(id) !== before.get(id);
  const oldest = page.length ? Math.min(...page.map((m) => m.createdAt)) : Infinity;
  const held = [...before.values()].filter((m) => !isTempId(m.id));
  const rebuild = hasMore && held.length > 0 && !page.some((m) => before.has(m.id));
  const gone = new Set<ID>();
  const listed = new Set(page.map((m) => m.id));
  // deleted: a row held from before, inside what the page covers, that the page leaves out (and not changed meanwhile).
  // With more behind, a row of the same ms as the page's oldest may have been cut by the limit (the server orders by
  // created_at, then rowid): it stays (DD 0703; one really deleted then stays until the next full read)
  for (const m of held) if (!listed.has(m.id) && !touched(m.id) && now.has(m.id) && (!hasMore || m.createdAt > oldest)) gone.add(m.id);
  for (const id of gone) deletedIds.add(id);
  // a line of ours still on its way whose stored row the page brings (a reconnect while sending): the row takes the
  // optimistic copy's place, as its push would (appendMessage). Never a failed one: the server never stored it
  const taken = new Set<ID>();
  for (const p of page) {
    if (p.role !== "user" || now.has(p.id)) continue;
    const copy = t.items.find((m) => isTempId(m.id) && !t.failed.includes(m.id) && m.role === "user" && m.text === p.text && !taken.has(m.id));
    if (!copy) continue;
    taken.add(copy.id);
    sentHere.add(p.id);
  }
  const items: Message[] = [];
  for (const m of t.items) {
    if (gone.has(m.id) || listed.has(m.id) || taken.has(m.id)) continue;
    if (rebuild && before.has(m.id) && !isTempId(m.id)) continue; // the older pages go with a rebuild (not deleted: they read again)
    items.push(m);
  }
  for (const p of page) {
    const cur = now.get(p.id);
    items.push(cur && (touched(p.id) || sameMessage(cur, p)) ? cur : p);
  }
  const draft = t.draft && listed.has(t.draft.messageId) ? null : t.draft;
  // hasMore: false when the page is the whole thread; a rebuild starts over from the page; else the older pages' own
  return { items: sortMessages(items), draft, ...(rebuild ? { hasMore, epoch: Math.max(Date.now(), (t.epoch ?? 0) + 1) } : hasMore ? {} : { hasMore: false }) };
}

const sameMessage = (a: Message, b: Message) => a === b || JSON.stringify(a) === JSON.stringify(b);

export async function loadConnections(): Promise<void> {
  const s = connectionsStore.get();
  if (s.loading) return;
  connectionsStore.set({ ...s, loading: true, error: undefined });
  try {
    const res = await ep.connections();
    connectionsStore.set({ providers: res.providers ?? [], connections: res.connections ?? [], loading: false, loaded: true });
  } catch (e) {
    connectionsStore.set({ ...connectionsStore.get(), loading: false, error: toApiError(e).message });
  }
}

export async function loadProfile(): Promise<void> {
  const s = profileStore.get();
  if (s.loading) return;
  profileStore.set({ ...s, loading: true, error: undefined });
  try {
    const data = await ep.profile();
    profileStore.set({ data, loading: false });
    setSessionSettings(data.settings);
  } catch (e) {
    profileStore.set({ ...profileStore.get(), loading: false, error: toApiError(e).message });
  }
}

/** Spend a quota-reset ticket; quota + tickets update from the server's answer only. */
export async function spendTicket(kind: keyof Tickets): Promise<{ quota: Quota; tickets: Tickets }> {
  const res = await ep.useTicket(kind);
  setQuota(res.quota);
  setTickets(res.tickets);
  return res;
}

// ───────────────────────────── settings ─────────────────────────────

/** the newest settings PATCH (updateSettings): only its answer may land */
let settingsSeq = 0;

/**
 * Optimistic settings change. Display prefs apply locally at once (tier.ts), then PATCH; on failure everything rolls
 * back and the ApiError is thrown (show it next to the control). Without a session only the local display applies.
 * Quick changes (arrow keys through the themes, slider keys, quick toggles) overlap: only the answer to the NEWEST
 * request is applied — an older one would put back a value the person has already moved past (the checkmark jumping
 * back, the text size going 1.1 → 1.05 → 1.1) — and the optimistic value stays the truth until it arrives. A failure
 * rolls back only while no newer request has been made (the newer one's answer carries the server's state).
 */
export async function updateSettings(patch: SettingsPatch): Promise<UserSettings | null> {
  const prev = settingsStore.get();
  const prevPrefs = getTier().prefs;
  if (patch.display) setDisplayPrefs(patch.display as Partial<DisplayPrefs>);
  if (!prev || !getToken()) return prev;
  const seq = ++settingsSeq;
  setSessionSettings(deepMerge(prev, patch));
  try {
    const saved = await ep.patchSettings(patch);
    if (seq === settingsSeq) setSessionSettings(saved);
    return saved;
  } catch (e) {
    if (seq === settingsSeq) {
      setSessionSettings(prev);
      if (patch.display) setDisplayPrefs(prevPrefs);
    }
    throw toApiError(e);
  }
}

// ───────────────────────────── streaming turns ─────────────────────────────

/**
 * What happened to a send (SERVER-CONTRACT §Sending a message):
 *  - "done"      200 stream finished with `done` (message = the agent's final message)
 *  - "steered"   202 — busy in the SAME thread: the user bubble is in, the running turn keeps streaming
 *  - "delivered" 201 — friend thread, not addressed to the agent: the bubble is in, no turn
 *  - "busy"      409 busy — the agent works in ANOTHER thread: bubble removed, banner shown, KEEP the composer text
 *  - "rejected"  other 4xx before streaming (413 / 400 …): bubble removed, banner, keep the text; no thread error
 *  - "failed"    429 quota / 5xx before streaming, the stream reported `error`, was cut, or the network failed: the
 *                bubble stays in `failed` (다시 보내기) and `thread.error` holds the Korean reason
 *  - "aborted"   the person stopped it (partial answer kept; messages refetched)
 */
export type SendStatus = "done" | "steered" | "delivered" | "busy" | "rejected" | "failed" | "aborted";

interface SendResultBase {
  status: SendStatus;
  /** the server accepted the message (a turn started, or it was steered / delivered) */
  accepted: boolean;
  /** composer: put the text back / don't clear it (busy, rejected, refused before streaming) */
  keepText: boolean;
  /** final assistant message (done) or the accepted user message (steered / delivered) */
  message: Message | null;
  /** what was streamed before a failure or stop */
  partial?: Message | null;
  /** 202: shown as a bubble, the running turn continues */
  steered: boolean;
  /** 201 friend thread: delivered to people, no agent turn */
  delivered: boolean;
}
/**
 * ok = done | steered | delivered. Otherwise `error` (Korean `message`, already shown as a banner / thread error;
 * code "aborted" when the user stopped it).
 */
export type SendResult = (SendResultBase & { ok: true; error?: undefined }) | (SendResultBase & { ok: false; error: ApiError });

function sendResult(
  status: SendStatus,
  f: { accepted: boolean; keepText: boolean; message?: Message | null; error?: ApiError; partial?: Message | null },
): SendResult {
  const base: SendResultBase = {
    status,
    accepted: f.accepted,
    keepText: f.keepText,
    message: f.message ?? null,
    partial: f.partial,
    steered: status === "steered",
    delivered: status === "delivered",
  };
  if (status === "done" || status === "steered" || status === "delivered") return { ...base, ok: true };
  return { ...base, ok: false, error: f.error ?? new ApiError(0, "unknown", koreanMessage(0)) };
}

interface TurnCtx {
  threadId: ID;
  temp: ID | null;
  /** the text, for 다시 시도 */
  text: string;
  onStart?: () => void;
  /** a decision is pending in the final message → island stays awaiting_approval */
  pendingDecision: boolean;
}


/** island back to what the agent is really doing when our send didn't start a turn */
function settleIsland() {
  if (turns.size) return;
  if (remoteBusy) island.thinking(null, { remote: true });
  else island.idle();
}

function applyEvent(ctx: TurnCtx, e: AgentEvent) {
  const { threadId } = ctx;
  if (e.type !== "text") {
    flushText(threadId);
    island.event();
  }
  switch (e.type) {
    case "start": {
      patchThread(threadId, (t) => {
        let items = t.items;
        if (ctx.temp) {
          items = items.filter((m) => m.id !== ctx.temp);
          if (e.userMessage) {
            items = sortMessages(upsertById(items, e.userMessage));
            sentHere.add(e.userMessage.id);
          }
        }
        return { ...t, items, failed: t.failed.filter((id) => id !== ctx.temp), draft: { messageId: e.messageId, text: "", tools: [], cards: [], status: null, startedAt: Date.now() } };
      });
      ctx.temp = null;
      ctx.onStart?.();
      return;
    }
    case "status":
      // kept on the draft for the thread; the island's label comes from real tool names, never this text
      patchThread(threadId, (t) => (t.draft ? { ...t, draft: { ...t.draft, status: e.text } } : t));
      return;
    case "text":
      pendingText.set(threadId, (pendingText.get(threadId) ?? "") + e.delta);
      scheduleFlush();
      island.tokens(Math.ceil(e.delta.length / 2));
      return;
    case "tool":
      patchThread(threadId, (t) => (t.draft ? { ...t, draft: { ...t.draft, tools: upsertById(t.draft.tools, e.tool) } } : t));
      if (e.tool.state === "running") island.tool(e.tool.name, e.tool.title);
      else if (e.tool.state === "needs_approval") island.awaitingApproval(e.tool.title);
      return;
    case "card":
      patchThread(threadId, (t) => (t.draft ? { ...t, draft: { ...t.draft, cards: [...t.draft.cards, e.card] } } : t));
      if (e.card.type === "approval" && e.card.status === "pending") {
        ctx.pendingDecision = true;
        island.awaitingApproval(e.card.title);
      }
      return;
    case "memory":
      island.banner({ icon: "checkmark", title: "기억했어요", body: e.text });
      return;
    case "done": {
      const m = e.message;
      patchThread(threadId, (t) => ({ ...t, draft: null, error: undefined, items: mergeById(t.items.filter((x) => x.id !== t.draft?.messageId), [m]) }));
      setQuota(e.quota);
      touchThread(threadId, m.createdAt);
      const approval = m.cards.find((c) => c.type === "approval" && c.status === "pending");
      if (approval && approval.type === "approval") island.awaitingApproval(approval.title);
      else if (hasPendingDecision(m) || ctx.pendingDecision) island.idle(); // credential request: nothing succeeded yet
      else island.done();
      return;
    }
    case "error":
      finalizeDraft(threadId);
      setThreadError(threadId, e.message || koreanMessage(0, e.error));
      lastFailed = { threadId, text: ctx.text, tempId: null };
      island.error();
      return;
  }
}

/** banner for a request the server refused before streaming; `busy` is not an error (it's the agent being busy) */
function rejectionBanner(err: ApiError) {
  if (err.code === "busy") {
    island.banner({ icon: "clock", title: err.message });
    return;
  }
  const titles: Record<string, string> = {
    quota_exceeded: "오늘 사용량을 다 썼어요",
    message_too_long: "메시지가 너무 길어요",
    payload_too_large: "보내려는 내용이 너무 커요",
    empty_message: "보낼 내용이 없어요",
    llm_not_configured: "AI 연결이 필요해요",
    rate_limited: "잠시 후 다시 보내 주세요",
    approval_expired: "승인 시간이 지났어요",
    already_decided: "이미 처리한 승인이에요",
    bad_signature: "기기 확인에 실패했어요",
    not_friends: "친구가 아니에요",
  };
  const title = titles[err.code];
  if (title && title !== err.message) island.errorBanner(err.message, title);
  else island.errorBanner(err.message, "보내지 못했어요");
}

async function runTurn(ctx: TurnCtx, start: (signal: AbortSignal, onAccepted: (k: TurnResult["kind"]) => void) => Promise<TurnResult>, signal?: AbortSignal): Promise<SendResult> {
  const { threadId } = ctx;
  /** this send owns the thread's running turn (Stop and isTurnRunning reach it); else it is meant as a steer */
  let primary = !turns.has(threadId);
  const ctrl = new AbortController();
  const onOuterAbort = () => ctrl.abort();
  signal?.addEventListener("abort", onOuterAbort, { once: true });
  let accepted = false;
  const own = () => {
    primary = true;
    idleSinceOwn = false;
    turns.set(threadId, ctrl);
    patchThread(threadId, (t) => ({ ...t, streaming: true, error: undefined }));
  };
  if (primary) own();
  const dropTemp = () => {
    if (!ctx.temp) return;
    const id = ctx.temp;
    patchThread(threadId, (t) => ({ ...t, items: t.items.filter((m) => m.id !== id), failed: t.failed.filter((x) => x !== id) }));
    ctx.temp = null;
  };
  const failTemp = () => {
    if (!ctx.temp) return;
    const id = ctx.temp;
    patchThread(threadId, (t) => ({ ...t, failed: t.failed.includes(id) ? t.failed : [...t.failed, id] }));
  };
  const endPrimary = () => {
    if (primary && turns.get(threadId) === ctrl) {
      turns.delete(threadId);
      patchThread(threadId, (t) => ({ ...t, streaming: false }));
    }
  };
  try {
    const res = await start(ctrl.signal, (kind) => {
      accepted = true;
      // meant as a steer, but the running turn ended in between and the server started a turn of its own: that turn
      // is now the thread's running one (Stop, the call's barge-in and isTurnRunning must reach it)
      if (kind === "stream" && !primary) own();
    });
    if (res.kind === "steered" || res.kind === "delivered") {
      const um = res.response.userMessage;
      sentHere.add(um.id);
      patchThread(threadId, (t) => ({ ...t, items: sortMessages(upsertById(t.items.filter((m) => m.id !== ctx.temp), um)) }));
      ctx.temp = null;
      touchThread(threadId, um.createdAt);
      endPrimary();
      if (primary) settleIsland();
      return sendResult(res.kind, { accepted: true, keepText: false, message: um });
    }
    flushText(threadId);
    if (res.done) return sendResult("done", { accepted: true, keepText: false, message: res.done.message });
    if (res.error) {
      failTemp();
      return sendResult("failed", { accepted: true, keepText: false, error: new ApiError(500, res.error.error, res.error.message || koreanMessage(500)), partial: null });
    }
    if (ctrl.signal.aborted) {
      // the person pressed 멈추기 (or the caller aborted) and the stream simply ended: not a cut
      const partial = finalizeDraft(threadId);
      endPrimary();
      dropTemp();
      if (primary) settleIsland();
      void loadMessages(threadId); // the server persisted the partial answer
      return sendResult("aborted", { accepted: true, keepText: false, error: new ApiError(0, "aborted", koreanMessage(0, "aborted")), partial });
    }
    const partial = finalizeDraft(threadId);
    const err = new ApiError(0, "stream_cut", "답변이 중간에 끊겼어요. 다시 보내 주세요.");
    setThreadError(threadId, err.message);
    failTemp();
    lastFailed = { threadId, text: ctx.text, tempId: ctx.temp };
    island.error();
    void loadMessages(threadId); // the server persisted whatever it had
    return sendResult("failed", { accepted: true, keepText: false, error: err, partial });
  } catch (e) {
    const err = toApiError(e);
    const partial = finalizeDraft(threadId);
    endPrimary();
    if (isAborted(err)) {
      dropTemp();
      if (primary) settleIsland();
      if (accepted) void loadMessages(threadId); // client disconnect aborts the turn; the partial answer is persisted
      return sendResult("aborted", { accepted, keepText: !accepted, error: err, partial });
    }
    if (!accepted && (err.status === 429 || err.status >= 500)) {
      // quota / rate limit / no LLM key / server down before streaming: keep the bubble as failed (다시 보내기) with the
      // server's Korean reason inline (the quota text is long — a banner would cut it short); no turn ran
      setThreadError(threadId, err.message);
      failTemp();
      lastFailed = { threadId, text: ctx.text, tempId: ctx.temp };
      if (primary) settleIsland();
      return sendResult("failed", { accepted: false, keepText: false, error: err, partial: null });
    }
    if (!accepted && err.status >= 400 && err.status !== 401) {
      // refused before streaming (409 busy, 413, 400 …): the bubble is removed, the text goes back to the composer,
      // the server's message as a banner — no thread error
      dropTemp();
      if (primary) settleIsland();
      rejectionBanner(err);
      return sendResult(err.code === "busy" ? "busy" : "rejected", { accepted: false, keepText: true, error: err, partial: null });
    }
    if (err.status === 401) {
      dropTemp();
      if (primary) settleIsland();
      return sendResult("rejected", { accepted: false, keepText: true, error: err, partial: null });
    }
    // network / timeout / stream broke mid-way: keep the bubble, offer 다시 보내기
    setThreadError(threadId, err.message);
    failTemp();
    lastFailed = { threadId, text: ctx.text, tempId: ctx.temp };
    if (primary) island.error();
    if (accepted) void loadMessages(threadId);
    return sendResult("failed", { accepted, keepText: false, error: err, partial });
  } finally {
    signal?.removeEventListener("abort", onOuterAbort);
    endPrimary();
    // it failed while the server already runs another turn (the follow-up for the lines it left): that one shows
    if (primary && idleSinceOwn) yieldError();
  }
}

export interface SendOptions {
  mode?: "text" | "voice";
  attachmentIds?: ID[];
  signal?: AbortSignal;
  /** the server accepted the message (before any streamed event) */
  onAccepted?: (kind: TurnResult["kind"]) => void;
}

/**
 * Send a user message and stream the agent's turn into the thread. The optimistic bubble appears synchronously.
 * Resolves when the turn ends (or at once for steered / delivered / refused). See SendResult.status.
 */
export async function sendMessage(threadId: ID, text: string, opts: SendOptions = {}): Promise<SendResult> {
  const body = text.trim();
  if (!body && !opts.attachmentIds?.length) {
    return sendResult("rejected", { accepted: false, keepText: true, error: new ApiError(400, "empty_message", "메시지를 입력해 주세요"), partial: null });
  }
  const id = tempId();
  const optimistic: Message = { id, threadId, role: "user", text: body, cards: [], tools: [], attachments: [], createdAt: Date.now() };
  patchThread(threadId, (t) => ({ ...t, items: [...t.items, optimistic], error: undefined }));
  if (!turns.size) island.thinking(threadId); // a running turn here = steer (island keeps its state); elsewhere = 409
  const ctx: TurnCtx = { threadId, temp: id, text: body, pendingDecision: false };
  const attachmentIds = opts.attachmentIds?.slice(0, ep.MAX_ATTACHMENTS);
  return runTurn(
    ctx,
    (signal, accepted) =>
      ep.send(
        threadId,
        { text: body, mode: opts.mode, attachmentIds },
        {
          signal,
          onEvent: (e) => applyEvent(ctx, e),
          onAccepted: (k) => {
            accepted(k);
            opts.onAccepted?.(k);
          },
        },
      ),
    opts.signal,
  );
}

/** Re-send a failed optimistic message (removes the failed copy first). */
export function retryMessage(threadId: ID, failedId: ID, opts?: SendOptions): Promise<SendResult> {
  const t = messagesStore.get()[threadId];
  const m = t?.items.find((x) => x.id === failedId);
  patchThread(threadId, (s) => ({ ...s, items: s.items.filter((x) => x.id !== failedId), failed: s.failed.filter((x) => x !== failedId) }));
  return sendMessage(threadId, m?.text ?? "", opts);
}

/** the voice call cut a spoken reply off: its history keeps what the person heard (errors are the caller's to drop) */
export const reportHeard = (threadId: ID, messageId: ID, heard: string): Promise<void> => ep.heard(threadId, messageId, heard);

/** Stop the turn this client is streaming in a thread (no id: whichever is running). */
export function stopTurn(threadId?: ID | null) {
  if (threadId) turns.get(threadId)?.abort();
  else for (const c of turns.values()) c.abort();
}
/** @deprecated use stopTurn */
export const cancelTurn = (threadId: ID) => stopTurn(threadId);

/** is a turn this client started streaming in the thread? (composer: send ↔ Stop) */
export const isTurnRunning = (threadId?: ID | null) => (threadId ? turns.has(threadId) : turns.size > 0);
export const useTurnRunning = (threadId: ID | null | undefined) => useStore(messagesStore, (s) => (threadId ? !!s[threadId]?.streaming : false), Object.is);

/** events.ts: agent_status from the server (covers turns started in other tabs, schedules, briefings) */
export function setRemoteAgentStatus(status: AgentStatus, text?: string) {
  if (status === "running" || status === "starting") {
    remoteBusy = true;
    if (!turns.size) {
      const k = islandStore.get().kind;
      if (k === "idle" || k === "done" || k === "offline") island.thinking(null, { remote: true });
      else if (!yieldError()) island.event();
    }
  } else {
    remoteBusy = false;
    idleSinceOwn = true;
    const held = heldError;
    heldError = null;
    if (turns.size) return;
    const k = islandStore.get().kind;
    // the turn that took over "다시 시도할까요?" ended: the failed line is still unanswered while its error row is up
    const again = !!held && lastFailed?.threadId === held && !!messagesStore.get()[held]?.error;
    if (isBusy(k)) {
      if (again) island.error();
      else island.idle();
    }
    if (status === "error") island.errorBanner(text || "잠시 후 다시 시도해 주세요.", "모시가 잠시 멈췄어요");
  }
}
/** "다시 시도할까요?" is up and a turn from elsewhere runs (none of this device's): its work shows instead (heldError) */
function yieldError(): boolean {
  if (turns.size || !remoteBusy || !lastFailed || islandStore.get().kind !== "error") return false;
  heldError = lastFailed.threadId;
  island.thinking(null, { remote: true });
  return true;
}
/**
 * events.ts `turn_error`: a turn the person didn't start from this screen failed (a briefing or schedule turn their line
 * was steered into, or that line's own follow-up turn). Shown like a failed send of theirs: the thread's error row (there
 * when the thread is opened later too; their next send clears it) and island 다시 시도, which sends their last line
 * again, on the device that sent that line only (`sentHere`): another device of theirs, or this one after a reload,
 * keeps the row alone, as a stream's error reaches only the device streaming. False when this device has no line of
 * theirs in that thread (not loaded here): nothing to send again.
 */
export function failRemoteTurn(threadId: ID, error: string, message: string): boolean {
  setThreadError(threadId, message || koreanMessage(0, error));
  const items = messagesStore.get()[threadId]?.items ?? [];
  let line: Message | undefined;
  for (let i = items.length - 1; i >= 0 && !line; i--) {
    const m = items[i]!;
    if (m.role === "user" && !isTempId(m.id) && (!m.author || m.author.kind === "me")) line = m;
  }
  if (!line) return false;
  if (!sentHere.has(line.id)) return true; // sent from another device (or before a reload): the row only
  lastFailed = { threadId, text: line.text, tempId: null };
  if (!turns.size) island.error(); // a send of theirs runs: the island stays on it
  return true;
}
/** events.ts: any pushed event while a remote turn runs keeps the island's stall clock honest */
export function noteRemoteActivity() {
  if (remoteBusy && !turns.size) island.event();
}

island.setHandlers({
  stop: () => stopTurn(islandStore.get().threadId),
  retry: () => {
    const f = lastFailed;
    if (!f) return;
    lastFailed = null;
    const t = messagesStore.get()[f.threadId];
    if (f.tempId && t?.failed.includes(f.tempId)) void retryMessage(f.threadId, f.tempId);
    else void sendMessage(f.threadId, f.text);
  },
});

function setApprovalStatus(threadId: ID, approvalId: ID, status: ApprovalStatus) {
  patchThread(threadId, (t) => ({
    ...t,
    items: t.items.map((m) =>
      m.cards.some((c) => c.type === "approval" && c.approvalId === approvalId)
        ? { ...m, cards: m.cards.map((c) => (c.type === "approval" && c.approvalId === approvalId ? { ...c, status } : c)) }
        : m,
    ),
  }));
}

/**
 * Approve (device-signed) or reject an approval card (`card.approvalId`, ap_…); the resumed turn streams into the same
 * thread. The card flips only once the server accepted (stream `start`). 410 → card "expired"; 409 already_decided →
 * refetch (the real status arrives as a `message` event too). The server's message is shown as a banner.
 */
export async function decideApproval(threadId: ID, approvalId: ID, decision: "approve" | "reject", signal?: AbortSignal): Promise<SendResult> {
  if (!turns.size) island.thinking(threadId);
  const ctx: TurnCtx = {
    threadId,
    temp: null,
    text: "",
    pendingDecision: false,
    onStart: () => setApprovalStatus(threadId, approvalId, decision === "approve" ? "approved" : "rejected"),
  };
  const res = await runTurn(ctx, (s, accepted) => ep.approve(approvalId, decision, { signal: s, onEvent: (e) => applyEvent(ctx, e), onAccepted: accepted }), signal);
  if (res.error && !res.ok) {
    if (res.error.code === "approval_expired") setApprovalStatus(threadId, approvalId, "expired");
    else if (res.error.code === "already_decided") void loadMessages(threadId);
  }
  if (res.status === "failed") lastFailed = null; // 다시 시도 = decide again from the card, not a resend
  return res;
}

// ───────────────────────────── connections (agent-messenger) ─────────────────────────────

const TERMINAL: ReadonlySet<Connection["status"]> = new Set(["connected", "error", "disconnected"]);

/** POST /api/connections/:provider — stores the connection; `verification` (if any) tells the screen what to show */
export async function connectProvider(provider: string, req: ConnectRequest): Promise<ConnectResponse> {
  const res = await ep.connect(provider, req);
  upsertConnection(res.connection);
  return res;
}

/** enter_code flow (Instagram 2FA, Telegram): POST /verify {code} — 400 invalid_code throws with the server message */
export async function submitConnectionCode(provider: string, code: string): Promise<ConnectResponse> {
  const res = await ep.verifyConnection(provider, code);
  upsertConnection(res.connection);
  return res;
}

/**
 * display_code flow (KakaoTalk passcode, LINE, Teams): poll POST /verify {} every `intervalMs` AND listen for the
 * `connection` ServerEvent, until the status is connected / error (resolves with the connection), the signal aborts
 * (ApiError "aborted"), or `timeoutMs` passes (ApiError "timeout"). `onUpdate` sees every intermediate state.
 */
export function pollConnection(
  provider: string,
  onUpdate: (c: Connection, verification?: ConnectResponse["verification"]) => void = () => {},
  { signal, intervalMs = 2000, timeoutMs = 180_000 }: { signal?: AbortSignal; intervalMs?: number; timeoutMs?: number } = {},
): Promise<Connection> {
  return new Promise<Connection>((resolve, reject) => {
    let finished = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ctrl = new AbortController();
    const finish = (fn: () => void) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearTimeout(deadline);
      unsub();
      ctrl.abort();
      signal?.removeEventListener("abort", onAbort);
      fn();
    };
    const seen = (c: Connection, v?: ConnectResponse["verification"]) => {
      if (finished || c.provider !== provider) return;
      upsertConnection(c);
      onUpdate(c, v);
      if (TERMINAL.has(c.status)) finish(() => resolve(c));
    };
    const unsub = onServerEvent((e) => {
      if (e.type === "connection") seen(e.connection);
    });
    const onAbort = () => finish(() => reject(new ApiError(0, "aborted", koreanMessage(0, "aborted"))));
    if (signal?.aborted) return onAbort();
    signal?.addEventListener("abort", onAbort, { once: true });
    const deadline = setTimeout(() => finish(() => reject(new ApiError(408, "timeout", "인증 시간이 지났어요. 다시 시도해 주세요."))), timeoutMs);
    const tick = async () => {
      if (finished) return;
      try {
        const res = await ep.verifyConnection(provider, undefined, { signal: ctrl.signal });
        seen(res.connection, res.verification);
      } catch (e) {
        const err = toApiError(e);
        if (finished || isAborted(err)) return;
        // 4xx (no_pending_verification, unknown_provider …) won't fix itself; 5xx / network: keep trying
        if (err.status >= 400 && err.status < 500) return finish(() => reject(err));
      }
      if (!finished) timer = setTimeout(tick, intervalMs);
    };
    timer = setTimeout(tick, intervalMs);
  });
}

// ───────────────────────────── explore ─────────────────────────────

export type TemplateStart =
  | { kind: "connections" }
  | { kind: "thread"; thread: Thread; prompt: string; /** false for call-demo (the agent asks for approval itself) */ autoSend: boolean };

/**
 * "부탁하기" on a template: `connect-kakao` → open the Connections screen (not delegated); otherwise delegate →
 * {thread, prompt} (thread stored). The screen opens the thread and, when `autoSend`, sends `prompt` as the first
 * message. `call-demo` creates a call thread with prompt "" — never auto-sent.
 */
export async function startTemplate(templateId: ID): Promise<TemplateStart> {
  if (templateId === ep.TEMPLATE_CONNECT_KAKAO) return { kind: "connections" };
  const res = await ep.delegate(templateId);
  upsertThread(res.thread);
  return { kind: "thread", thread: res.thread, prompt: res.prompt, autoSend: templateId !== ep.TEMPLATE_CALL_DEMO && !!res.prompt.trim() };
}
