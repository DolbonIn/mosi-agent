import type {
  AccessRecord,
  Artifact,
  Attachment,
  CredentialInfo,
  ExploreResponse,
  Friend,
  ID,
  InvestOverview,
  KeepFor,
  Schedule,
  SkillInfo,
} from "@pickle/protocol";
import { useEffect } from "react";
import { toApiError } from "../../api/client";
import * as ep from "../../api/endpoints";
import { onServerEvent } from "../../api/events";
import { sessionStore } from "../../api/store";
import { preloadBrandMarks } from "../../assets/brands/BrandIcon";
import { createStore, useStore, type Store } from "../../lib/createStore";
import * as investApi from "./invest/api";

/**
 * Screen-level caches for the explore / archive / profile half (owned by screens-more; the foundation store keeps
 * session, threads, messages, connections, profile, settings). Stale-while-revalidate: a screen shows what it has at
 * once and refreshes in the background when it mounts or becomes visible. Mutations change the cache only after the
 * server confirms (never claim success first) — except toggles/segments, which are optimistic with rollback, like
 * updateSettings().
 */

export interface Resource<T> {
  data: T;
  loading: boolean;
  loaded: boolean;
  error?: string;
  at: number;
}

export interface ResourceApi<T> {
  store: Store<Resource<T>>;
  /** refresh (shared while in flight) */
  load(): Promise<void>;
  /** replace the cached data (after a confirmed mutation) */
  set(fn: (d: T) => T): void;
  reset(): void;
  use(): Resource<T>;
}

const all: ResourceApi<unknown>[] = [];

function resource<T>(initial: T, fetcher: () => Promise<T>): ResourceApi<T> {
  const store = createStore<Resource<T>>({ data: initial, loading: false, loaded: false, at: 0 });
  let inflight: Promise<void> | null = null;
  let gen = 0;
  const api: ResourceApi<T> = {
    store,
    load() {
      if (inflight) return inflight;
      const g = gen;
      store.patch({ loading: true, error: undefined });
      inflight = fetcher()
        .then(
          (data) => {
            if (g === gen) store.set({ data, loading: false, loaded: true, at: Date.now() });
          },
          (e) => {
            if (g === gen) store.patch({ loading: false, error: toApiError(e).message });
          },
        )
        .finally(() => {
          inflight = null;
        });
      return inflight;
    },
    set(fn) {
      const s = store.get();
      store.set({ ...s, data: fn(s.data) });
    },
    reset() {
      gen++;
      inflight = null;
      store.set({ data: initial, loading: false, loaded: false, at: 0 });
    },
    use: () => useStore(store),
  };
  all.push(api as ResourceApi<unknown>);
  return api;
}

/** Load on mount (and whenever `active` turns true); the cached copy shows meanwhile. */
export function useResource<T>(r: ResourceApi<T>, active = true): Resource<T> {
  const s = r.use();
  useEffect(() => {
    if (active) void r.load();
  }, [r, active]);
  return s;
}

// ───────────────────────────── resources ─────────────────────────────

export const exploreRes = resource<ExploreResponse | null>(null, () => ep.explore());
export const artifactsRes = resource<Artifact[]>([], async () => (await ep.artifacts()).sort((a, b) => b.updatedAt - a.updatedAt));
export const attachmentsRes = resource<Attachment[]>([], async () => (await ep.attachments()).sort((a, b) => b.createdAt - a.createdAt));
export const friendsRes = resource<Friend[]>([], () => ep.friends());
export const schedulesRes = resource<Schedule[]>([], () => ep.schedules());
export const credentialsRes = resource<CredentialInfo[]>([], () => ep.credentials());
export const accessLogRes = resource<AccessRecord[]>([], async () => (await ep.accessLog(100)).sort((a, b) => b.createdAt - a.createdAt));
export const skillsRes = resource<SkillInfo[]>([], () => ep.skills());
export const memoriesRes = resource<ep.MemoryItem[]>([], async () => (await ep.memories()).sort((a, b) => b.createdAt - a.createdAt));
/**
 * 투자: one read for the whole screen; the `invest` event replaces it whole. A read that answers with an older rev than
 * the overview already here (an event came in while it was on its way) keeps it.
 */
export const investRes: ResourceApi<InvestOverview | null> = resource<InvestOverview | null>(null, async (): Promise<InvestOverview> => {
  const o = await investApi.overview();
  const have: InvestOverview | null = investRes.store.get().data;
  return have && have.rev > o.rev ? have : o;
});

/** take an overview (a read after a write, or the `invest` event) unless an equal or newer one is already here */
export function applyInvest(o: InvestOverview) {
  const s = investRes.store.get();
  if (s.data && s.data.rev >= o.rev) return;
  investRes.store.set({ data: o, loading: false, loaded: true, error: undefined, at: Date.now() });
}

/** after a confirmed write: a fresh read (not the shared in-flight one, which may predate the write), by rev */
export async function reloadInvest() {
  applyInvest(await investApi.overview());
}

/**
 * The 나의 모시 row's "실제 주문": the overview's mode once one is here (it follows the `invest` event), else the
 * session's `investMode` (agent-runtime 2006 §5; absent = paper).
 */
export function useInvestLive(): boolean {
  const o = investRes.use().data;
  const session = useStore(sessionStore).session;
  return o ? o.mode === "real" : session?.investMode === "real";
}

// ───────────────────────────── mutations (server first) ─────────────────────────────

export async function removeArtifact(id: ID) {
  await ep.deleteArtifact(id);
  artifactsRes.set((l) => l.filter((a) => a.id !== id));
}

export async function removeAttachment(id: ID) {
  await ep.deleteAttachment(id);
  attachmentsRes.set((l) => l.filter((a) => a.id !== id));
}

export async function upload(file: File): Promise<Attachment> {
  const a = await ep.uploadAttachment(file);
  attachmentsRes.set((l) => [a, ...l.filter((x) => x.id !== a.id)]);
  return a;
}

export async function removeCredential(id: ID) {
  await ep.deleteCredential(id);
  credentialsRes.set((l) => l.filter((c) => c.id !== id));
  void accessLogRes.load();
}

/** optimistic: the segmented control moves at once; rolls back and throws on failure */
export async function setKeepFor(id: ID, keepFor: KeepFor) {
  const prev = credentialsRes.store.get().data.find((c) => c.id === id);
  credentialsRes.set((l) => l.map((c) => (c.id === id ? { ...c, keepFor } : c)));
  try {
    const saved = await ep.patchCredential(id, { keepFor });
    credentialsRes.set((l) => l.map((c) => (c.id === id ? saved : c)));
  } catch (e) {
    if (prev) credentialsRes.set((l) => l.map((c) => (c.id === id ? prev : c)));
    throw toApiError(e);
  }
}

/** optimistic toggle with rollback */
export async function setScheduleEnabled(id: ID, enabled: boolean) {
  const prev = schedulesRes.store.get().data.find((s) => s.id === id);
  schedulesRes.set((l) => l.map((s) => (s.id === id ? { ...s, enabled } : s)));
  try {
    const saved = await ep.patchSchedule(id, { enabled });
    schedulesRes.set((l) => l.map((s) => (s.id === id ? saved : s)));
  } catch (e) {
    if (prev) schedulesRes.set((l) => l.map((s) => (s.id === id ? prev : s)));
    throw toApiError(e);
  }
}

export async function removeSchedule(id: ID) {
  await ep.deleteSchedule(id);
  schedulesRes.set((l) => l.filter((s) => s.id !== id));
}

export async function blockFriend(userId: ID) {
  const res = await ep.blockFriend(userId);
  if (res && typeof res === "object" && "userId" in res) {
    const f = res as Friend;
    friendsRes.set((l) => (l.some((x) => x.userId === userId) ? l.map((x) => (x.userId === userId ? f : x)) : [...l, f]));
  } else void friendsRes.load();
}

/** remove a friend — on a blocked row this lifts the block */
export async function removeFriend(userId: ID) {
  await ep.deleteFriend(userId);
  friendsRes.set((l) => l.filter((x) => x.userId !== userId));
}

export async function acceptInvite(token: string): Promise<Friend> {
  const f = await ep.acceptInvite(token);
  friendsRes.set((l) => [f, ...l.filter((x) => x.userId !== f.userId)]);
  return f;
}

export async function forgetMemory(id: ID) {
  await ep.deleteMemory(id);
  memoriesRes.set((l) => l.filter((m) => m.id !== id));
}

// ───────────────────────────── live invalidation ─────────────────────────────

let wired = false;
/** Server events that make a cache stale; session changes clear everything. Idempotent. */
export function wireMoreData() {
  if (wired) return;
  wired = true;
  onServerEvent((e) => {
    if (e.type === "message") {
      for (const c of e.message.cards) {
        if (c.type === "artifact") void artifactsRes.load();
        if (c.type === "schedule") void schedulesRes.load();
        if (c.type === "credential_request" && c.status === "saved") void credentialsRes.load();
      }
      if (e.message.attachments.length) void attachmentsRes.load();
    } else if (e.type === "thread_updated" && e.thread.kind === "friend") {
      if (friendsRes.store.get().loaded) void friendsRes.load();
    } else if (e.type === "notification" && e.icon === "people") {
      if (friendsRes.store.get().loaded) void friendsRes.load();
    } else if (e.type === "connection") {
      if (credentialsRes.store.get().loaded) void credentialsRes.load();
      if (accessLogRes.store.get().loaded) void accessLogRes.load();
    }
    // 투자 (agent-runtime 2006 §6): the event carries the whole overview; a reconnect's hello says the server's rev,
    // and a cached overview behind it is read again
    if (e.type === "invest") applyInvest(e.overview);
    else if (e.type === "hello" && typeof e.investRev === "number") {
      const have = investRes.store.get().data;
      if (have && have.rev < e.investRev) void reloadInvest().catch(() => undefined);
    }
  });
  // Caches belong to one account: they clear on sign-out ("anon") or when a different account signs in, never on a
  // transient session error (status "error" keeps the same person; wiping would flash the first-load placeholders).
  let user = sessionStore.get().session?.user.id ?? null;
  const onSession = () => {
    const s = sessionStore.get();
    const next = s.session?.user.id ?? null;
    if (next === null) {
      if (s.status === "anon" && user !== null) {
        user = null;
        for (const r of all) r.reset();
      }
      return;
    }
    if (next === user) return;
    if (user !== null) for (const r of all) r.reset();
    user = next;
    prefetchArchive();
  };
  sessionStore.subscribe(onSession);
  onSession();
}

/**
 * 보관함 is a tab root: its first visit should already have rows, not the still placeholder. Once a session is ready,
 * fetch artifacts and media when the main thread is idle (two small GETs; later visits refetch behind the cached rows),
 * and warm the brand-icon marks chunk.
 */
function prefetchArchive() {
  const run = () => {
    if (!sessionStore.get().session) return;
    if (!artifactsRes.store.get().loaded) void artifactsRes.load();
    if (!attachmentsRes.store.get().loaded) void attachmentsRes.load();
    // messenger app icons (connections, vault, explore, chat cards): BrandIcon itself already ships in the entry chunk
    // (the chat cards import it statically, so a dynamic import here only drew INEFFECTIVE_DYNAMIC_IMPORT); its marks
    // stay one small lazy chunk, warmed here so no tile paints without its mark
    void preloadBrandMarks();
  };
  const ric = (globalThis as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
  if (ric) ric(run, { timeout: 2500 });
  else setTimeout(run, 1200);
}
