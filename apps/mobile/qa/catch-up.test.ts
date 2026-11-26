import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { ID, Message, ServerEvent, Thread } from "@pickle/protocol";

/**
 * Catching up after a reconnect (screens/chat/catchUp.ts, store refreshThreads / refreshRecent; DD 2259 §6, 0327): the
 * server does not replay what it sent while this device was away, so a `hello` that is not the first since sign-in
 * reads the thread list again and marks held threads stale, and a thread on screen swaps its first page in. Drives the
 * real events.ts dispatch through a fake EventSource; fetch is faked and answers like the server (the newest 50 rows,
 * or the 50 before `before`). bun runs every test file in one process: the file starts and ends with resetSession.
 *   bun test ./qa/catch-up.test.ts
 */

class FakeEventSource {
  static last: FakeEventSource | null = null;
  readyState = 1;
  onmessage: ((m: MessageEvent<string>) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeEventSource.last = this;
  }
  close() {
    this.readyState = 2;
  }
}

const realFetch = globalThis.fetch;
const realEventSource = (globalThis as { EventSource?: unknown }).EventSource;
const g = globalThis as Record<string, unknown>;
const realDocument = g.document;

/** the server's rows per thread, oldest first */
const server = new Map<ID, Message[]>();
/** the server's thread list */
let listed: Thread[] = [];
/** requests that answer only once released (the answer is taken when the request comes in, as a server would) */
const holds = new Map<string, Promise<void>>();
const calls: string[] = [];

let at = 1_800_000_000_000;
const row = (threadId: ID, id: ID, role: Message["role"], text: string, extra: Partial<Message> = {}): Message => ({ id, threadId, role, text, cards: [], tools: [], attachments: [], createdAt: ++at, ...extra });
const thread = (id: ID, extra: Partial<Thread> = {}): Thread => ({ id, kind: "task", title: id, subtitle: "", icon: "sparkles", archived: false, unread: false, createdAt: 1, updatedAt: 2, preview: "", ...extra });
const push = (e: ServerEvent) => FakeEventSource.last!.onmessage!({ data: JSON.stringify(e) } as MessageEvent<string>);
const hello = () => push({ type: "hello", at: Date.now() });
const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = async () => {
  for (let i = 0; i < 5; i++) await tick();
};
const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { "Content-Type": "application/json" } });

const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input), "http://qa.local");
  if ((init?.method ?? "GET") === "GET" && url.pathname === "/api/threads") {
    calls.push("threads");
    const body = listed.map((t) => ({ ...t }));
    const hold = holds.get("threads");
    if (hold) await hold;
    return json(body);
  }
  const m = /^\/api\/threads\/([^/]+)\/messages$/.exec(url.pathname);
  if (m && (init?.method ?? "GET") === "GET") {
    const id = decodeURIComponent(m[1]!);
    const before = Number(url.searchParams.get("before") || Infinity);
    const limit = Number(url.searchParams.get("limit") || 50);
    calls.push(`messages ${id}${url.searchParams.get("before") ? " older" : ""}`);
    const body = (server.get(id) ?? []).filter((r) => r.createdAt < before).slice(-limit).map((r) => structuredClone(r));
    const hold = holds.get(url.searchParams.get("before") ? `${id} older` : id);
    if (hold) await hold;
    return json(body);
  }
  return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
}) as unknown as typeof fetch;

type Store = typeof import("../src/api/store");
let store: Store;
const ids = (threadId: ID) => (store.messagesStore.get()[threadId]?.items ?? []).map((m) => m.id);
const held = (threadId: ID) => store.messagesStore.get()[threadId]!;
const hold = (key: string) => {
  let release!: () => void;
  holds.set(
    key,
    new Promise<void>((r) => (release = r)),
  );
  return () => {
    holds.delete(key);
    release();
  };
};

async function signIn({ firstHello = true } = {}) {
  const { setToken } = await import("../src/api/client");
  setToken("qa-token");
  const { connectEvents } = await import("../src/api/events");
  connectEvents();
  expect(FakeEventSource.last?.url).toContain("/api/events?token=");
  if (!firstHello) return;
  hello(); // the first hello of the sign-in: comes with the first reads, catches nothing up
  await settle();
}

beforeAll(async () => {
  store = await import("../src/api/store");
  await import("../src/screens/chat/catchUp"); // listens for hello
  const { island } = await import("../src/app/island");
  store.resetSession();
  island.clearBanners();
  (globalThis as { EventSource?: unknown }).EventSource = FakeEventSource;
  globalThis.fetch = fakeFetch;
});
afterAll(async () => {
  const { island } = await import("../src/app/island");
  store.resetSession();
  island.clearBanners();
  globalThis.fetch = realFetch;
  (globalThis as { EventSource?: unknown }).EventSource = realEventSource;
  g.document = realDocument;
});
beforeEach(async () => {
  store.resetSession();
  server.clear();
  listed = [];
  holds.clear();
  calls.length = 0;
  g.document = realDocument;
  await signIn();
  calls.length = 0;
});

describe("when a hello catches up", () => {
  test("the first hello of a sign-in reads nothing; the next reads the list, then marks held threads stale; after a sign-out the count starts over", async () => {
    listed = [thread("t1")];
    server.set("t1", [row("t1", "a1", "user", "안녕")]);
    await store.loadThreads();
    await store.loadMessages("t1");
    calls.length = 0;
    hello();
    await settle();
    expect(calls).toEqual(["threads"]);
    expect(held("t1").stale).toBeGreaterThan(0);
    // signed out and in again: that sign-in's first hello reads nothing
    store.resetSession();
    await signIn();
    expect(calls).toEqual(["threads"]);
  });

  test("hidden, it waits for the page to be visible; several reconnects while hidden make one catch-up", async () => {
    const listeners = new Set<() => void>();
    const doc = {
      visibilityState: "hidden",
      hidden: true,
      addEventListener: (_: string, f: () => void) => listeners.add(f),
      removeEventListener: (_: string, f: () => void) => listeners.delete(f),
    };
    g.document = doc;
    listed = [thread("t1")];
    await store.loadThreads();
    calls.length = 0;
    hello();
    hello();
    await settle();
    expect(calls).toEqual([]);
    doc.visibilityState = "visible";
    doc.hidden = false;
    for (const f of [...listeners]) f();
    await settle();
    expect(calls).toEqual(["threads"]);
  });

  test("hidden twice (DD 0703 P1): one catch-up per hidden spell; shown again with no reconnect, nothing; the next hidden reconnect waits again", async () => {
    const listeners = new Set<() => void>();
    const doc = {
      visibilityState: "hidden",
      hidden: true,
      addEventListener: (_: string, f: () => void) => listeners.add(f),
      removeEventListener: (_: string, f: () => void) => listeners.delete(f),
    };
    g.document = doc;
    const turn = (shown: boolean) => {
      doc.visibilityState = shown ? "visible" : "hidden";
      doc.hidden = !shown;
      for (const f of [...listeners]) f();
    };
    listed = [thread("t1")];
    await store.loadThreads();
    calls.length = 0;
    hello();
    await settle();
    expect(calls).toEqual([]);
    turn(true);
    await settle();
    expect(calls).toEqual(["threads"]);
    turn(false); // hidden and shown with no reconnect between: nothing to catch up
    turn(true);
    await settle();
    expect(calls).toEqual(["threads"]);
    turn(false);
    hello();
    await settle();
    expect(calls).toEqual(["threads"]);
    turn(true);
    await settle();
    expect(calls).toEqual(["threads", "threads"]);
  });

  test("the first hello reads nothing also when the first list landed before it", async () => {
    store.resetSession();
    await signIn({ firstHello: false });
    listed = [thread("t1")];
    server.set("t1", [row("t1", "f1", "user", "안녕")]);
    await store.loadThreads();
    await store.loadMessages("t1");
    calls.length = 0;
    hello(); // the stream's first hello comes after the first reads
    await settle();
    expect(calls).toEqual([]);
    expect(held("t1").stale).toBeUndefined();
    hello(); // a reconnect
    await settle();
    expect(calls).toEqual(["threads"]);
  });

  test("nothing held yet (no list, no thread read): a reconnect reads nothing", async () => {
    hello();
    await settle();
    expect(calls).toEqual([]);
  });
});

describe("refreshThreads: the answer wins, a change made while it was out stays", () => {
  test("archived, renamed or read elsewhere with updatedAt unchanged: the answer's copy replaces the held one", async () => {
    listed = [thread("t1", { title: "옛 이름", unread: true }), thread("t2")];
    await store.loadThreads();
    listed = [thread("t1", { title: "새 이름", unread: false }), thread("t2", { archived: true })];
    await store.refreshThreads();
    const items = store.threadsStore.get().items;
    expect(items.find((t) => t.id === "t1")).toMatchObject({ title: "새 이름", unread: false, updatedAt: 2 });
    expect(items.find((t) => t.id === "t2")?.archived).toBe(true);
  });

  test("a thread_updated while the request was out keeps its change; a thread made meanwhile stays; one the answer leaves out goes", async () => {
    listed = [thread("t1"), thread("t_gone")];
    await store.loadThreads();
    listed = [thread("t1", { title: "읽기 전 이름" })];
    const release = hold("threads");
    const reading = store.refreshThreads();
    await tick();
    push({ type: "thread_updated", thread: thread("t1", { title: "이벤트 이름", updatedAt: 2 }) });
    push({ type: "thread_updated", thread: thread("t_new", { updatedAt: 3 }) });
    release();
    await reading;
    const items = store.threadsStore.get().items;
    expect(items.find((t) => t.id === "t1")?.title).toBe("이벤트 이름");
    expect(items.map((t) => t.id).sort()).toEqual(["t1", "t_new"]);
  });

  test("a thread on screen stays read in the merged list", async () => {
    listed = [thread("t1")];
    await store.loadThreads();
    listed = [thread("t1", { unread: true, updatedAt: 5 })];
    await store.refreshThreads(new Set(["t1"]));
    expect(store.threadsStore.get().items[0]).toMatchObject({ id: "t1", unread: false, updatedAt: 5 });
  });
});

describe("refreshRecent: the first page swaps in for the server rows it covers (DD 2259 §6)", () => {
  test("changed rows take the server's copy in place, unchanged rows keep their object, new rows join, deleted rows go and stay out", async () => {
    const card = { type: "approval", id: "ap1", title: "보낼까요?", status: "pending" } as unknown as Message["cards"][number];
    const r1 = row("t1", "m1", "user", "메일 보내 줘");
    const r2 = row("t1", "m2", "assistant", "보낼까요?", { cards: [card] });
    const r3 = row("t1", "m3", "event", "오늘의 브리핑");
    server.set("t1", [r1, r2, r3]);
    await store.loadMessages("t1");
    const kept = held("t1").items[0];
    // while away: the approval was decided elsewhere, the briefing row deleted, a new answer came
    server.set("t1", [r1, { ...r2, cards: [{ ...card, status: "approved" } as Message["cards"][number]] }, row("t1", "m4", "assistant", "보냈어요")]);
    await store.refreshRecent("t1");
    expect(ids("t1")).toEqual(["m1", "m2", "m4"]);
    expect(held("t1").items[0]).toBe(kept);
    expect((held("t1").items[1]!.cards[0] as { status: string }).status).toBe("approved");
    // the deleted row's late push and a page fetched before stay without it (message_deleted's way)
    push({ type: "message", threadId: "t1", message: r3 });
    expect(ids("t1")).toEqual(["m1", "m2", "m4"]);
  });

  test("optimistic and failed lines, older pages held, and rows that came while the request was out stay", async () => {
    const rows = Array.from({ length: 60 }, (_, i) => row("t1", `o${i}`, i % 2 ? "assistant" : "user", `줄 ${i}`));
    server.set("t1", rows);
    await store.loadMessages("t1"); // the newest 50
    await store.loadMessages("t1", { older: true }); // and the 10 before
    expect(ids("t1").length).toBe(60);
    // a line still on its way (its optimistic copy), and a row inside what the page covers deleted while away
    const { sendMessage } = store;
    void sendMessage("t1", "가는 중인 줄");
    await settle();
    const temps = ids("t1").filter((id) => store.isTempId(id));
    expect(temps.length).toBe(1);
    server.set("t1", rows.filter((r) => r.id !== "o30"));
    // the page is read; while it is out a new row is pushed and an old row changes in place (a push of the same id)
    const release = hold("t1");
    const reading = store.refreshRecent("t1");
    await tick();
    push({ type: "message", threadId: "t1", message: row("t1", "late", "assistant", "읽는 동안 온 답") });
    push({ type: "message", threadId: "t1", message: { ...rows[59]!, text: "push로 바뀐 줄" } });
    release();
    await reading;
    const now = ids("t1");
    expect(now.slice(0, 10)).toEqual(rows.slice(0, 10).map((r) => r.id)); // the older page held stays
    expect(now).not.toContain("o30");
    expect(now).toContain("late");
    expect(now).toContain(temps[0]!);
    expect(held("t1").items.find((m) => m.id === rows[59]!.id)?.text).toBe("push로 바뀐 줄");
  });

  test("a line still on its way whose stored row the page brings: the row takes the optimistic copy's place", async () => {
    server.set("t1", [row("t1", "g1", "user", "안녕")]);
    await store.loadMessages("t1");
    void store.sendMessage("t1", "보내는 중인 줄"); // the fake POST never answers: the copy stays on its way
    await settle();
    expect(ids("t1").filter((id) => store.isTempId(id)).length).toBe(1);
    server.set("t1", [...server.get("t1")!, row("t1", "g2", "user", "보내는 중인 줄")]);
    await store.refreshRecent("t1");
    expect(ids("t1")).toEqual(["g1", "g2"]);
    // a failed line (다시 보내기) stays, whatever comes with the same text: the server never stored it
    const temp = "tmp_failed_cu";
    store.messagesStore.set((s) => ({ ...s, t1: { ...s.t1!, items: [...s.t1!.items, { ...row("t1", temp, "user", "같은 줄") }], failed: [temp] } }));
    server.set("t1", [...server.get("t1")!, row("t1", "g3", "user", "같은 줄")]);
    await store.refreshRecent("t1");
    expect(ids("t1")).toEqual(["g1", "g2", "g3", temp]);
  });

  test("receipts are not touched: a line with one keeps it, a new line comes without", async () => {
    const { markReceipt, receiptOf } = await import("../src/screens/chat/composerStore");
    // ids of this file only: receipts live in composerStore, which a sign-out does not clear
    const r1 = row("t1", "cu_r1", "user", "우산 챙겨야 해?");
    server.set("t1", [r1]);
    await store.loadMessages("t1");
    markReceipt("cu_r1", "steered");
    server.set("t1", [r1, row("t1", "cu_r2", "user", "내일은?", { steered: true } as Partial<Message>)]);
    await store.refreshRecent("t1");
    expect(receiptOf("cu_r1")).toBe("steered");
    expect(receiptOf("cu_r2")).toBeUndefined();
  });

  test("a line its turn left unanswered: the page says so (steerDropped) and its receipt goes, as with the notice", async () => {
    const { markReceipt, receiptOf, steerDropped } = await import("../src/screens/chat/composerStore");
    // ids of this file only (receipts outlive a sign-out)
    const r0 = row("t1", "cu_d0", "user", "날씨 알려줘");
    const r1 = row("t1", "cu_d1", "user", "우산도 챙겨야 해?");
    server.set("t1", [r0, r1]);
    await store.loadMessages("t1");
    markReceipt("cu_d1", "steered");
    // while away the turn failed after reading it: steers_dropped never came here, the server keeps it on the row
    server.set("t1", [r0, { ...r1, steerDropped: true }]);
    await store.refreshRecent("t1");
    expect(receiptOf("cu_d1")).toBeUndefined();
    expect(steerDropped("cu_d1")).toBe(true);
    markReceipt("cu_d1", "steered"); // a 202 still on its way adds none
    expect(receiptOf("cu_d1")).toBeUndefined();
  });

  test("a held row of the same ms as the page's oldest, left out only by the page limit, stays (DD 0703 P2)", async () => {
    const rows = Array.from({ length: 50 }, (_, i) => row("t2", `q${i}`, i % 2 ? "assistant" : "user", `줄 ${i}`));
    rows[1] = { ...rows[1]!, createdAt: rows[0]!.createdAt }; // the server orders q1 (the later rowid) before q0
    server.set("t2", rows);
    await store.loadMessages("t2");
    expect(ids("t2").length).toBe(50);
    server.set("t2", [...rows, row("t2", "q50", "assistant", "새 줄")]); // the page: q1…q50, q0 cut by the limit
    await store.refreshRecent("t2");
    expect(ids("t2")).toContain("q50");
    expect(ids("t2")).toContain("q0");
    expect(ids("t2").length).toBe(51);
  });

  test("a page that is the whole thread: every held row it leaves out goes, and there is no more to load", async () => {
    server.set("t1", [row("t1", "w1", "user", "하나"), row("t1", "w2", "event", "지워질 줄"), row("t1", "w3", "assistant", "둘")]);
    await store.loadMessages("t1");
    store.messagesStore.set((s) => ({ ...s, t1: { ...s.t1!, hasMore: true } })); // as if never asked for more yet
    server.set("t1", server.get("t1")!.filter((r) => r.id !== "w2"));
    await store.refreshRecent("t1");
    expect(ids("t1")).toEqual(["w1", "w3"]);
    expect(held("t1").hasMore).toBe(false);
  });

  test("over a page missed (no row in common, more behind): the held rows give way to the page, epoch is set (now), and they read again later", async () => {
    const old = Array.from({ length: 50 }, (_, i) => row("t1", `p${i}`, "assistant", `옛 줄 ${i}`));
    server.set("t1", old);
    await store.loadMessages("t1");
    const epoch = held("t1").epoch ?? 0;
    const missed = Array.from({ length: 60 }, (_, i) => row("t1", `n${i}`, "assistant", `놓친 줄 ${i}`));
    server.set("t1", [...old, ...missed]);
    await store.refreshRecent("t1");
    expect(ids("t1")).toEqual(missed.slice(-50).map((r) => r.id));
    expect(held("t1").epoch).toBeGreaterThan(epoch);
    expect(Math.abs(held("t1").epoch! - Date.now())).toBeLessThan(5_000); // when: rows dated before it don't enter
    expect(held("t1").hasMore).toBe(true);
    // the rows given way were not deleted: loading older pages brings them back
    await store.loadMessages("t1", { older: true });
    expect(ids("t1")).toContain("n0");
    await store.loadMessages("t1", { older: true });
    expect(ids("t1")).toContain("p49");
  });

  test("an older page on its way when a rebuild lands is dropped (it no longer joins on)", async () => {
    const old = Array.from({ length: 60 }, (_, i) => row("t1", `q${i}`, "assistant", `옛 줄 ${i}`));
    server.set("t1", old);
    await store.loadMessages("t1"); // q10..q59
    const release = hold("t1 older");
    const loadingOlder = store.loadMessages("t1", { older: true }); // asks for q0..q9, answer held
    await tick();
    const missed = Array.from({ length: 60 }, (_, i) => row("t1", `x${i}`, "assistant", `놓친 줄 ${i}`));
    server.set("t1", [...old, ...missed]);
    await store.refreshRecent("t1"); // the rebuild lands first
    release();
    await loadingOlder;
    expect(ids("t1")).toEqual(missed.slice(-50).map((r) => r.id));
    expect(held("t1").loading).toBe(false);
  });

  test("stale: a read answers the reconnect it was sent for, not one that came while it was out", async () => {
    listed = [thread("t1")];
    server.set("t1", [row("t1", "k1", "user", "하나")]);
    await store.loadThreads();
    await store.loadMessages("t1");
    store.markThreadsStale();
    const first = held("t1").stale;
    const release = hold("t1");
    const reading = store.refreshRecent("t1");
    await tick();
    store.markThreadsStale(); // another reconnect meanwhile
    release();
    await reading;
    expect(held("t1").stale).toBeGreaterThan(first!);
    await store.refreshRecent("t1");
    expect(held("t1").stale).toBeUndefined();
  });

  test("the answer's row takes over this device's running answer (as a push of it would)", async () => {
    server.set("t1", [row("t1", "d1", "user", "날씨")]);
    await store.loadMessages("t1");
    store.messagesStore.set((s) => ({ ...s, t1: { ...s.t1!, draft: { messageId: "d2", text: "맑", tools: [], cards: [], status: null, startedAt: Date.now() } } }));
    server.set("t1", [...server.get("t1")!, row("t1", "d2", "assistant", "맑아요")]);
    await store.refreshRecent("t1");
    expect(held("t1").draft).toBeNull();
    expect(ids("t1")).toEqual(["d1", "d2"]);
  });
});
