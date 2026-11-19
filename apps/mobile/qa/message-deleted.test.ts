import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ID, Message, ServerEvent, Thread } from "@pickle/protocol";

/**
 * `message_deleted`: the server deleted a row it had stored. Today that is a failed briefing attempt's "오늘의 브리핑"
 * event row, never pushed, but in the messages page of a screen that opened the thread while the attempt ran. Every
 * open screen of the person (each device, each tab: each gets the event) drops it; a page already on its way doesn't
 * bring it back. Drives the real events.ts dispatch through a fake EventSource; fetch is faked (no server).
 * bun runs every test file in one process: the file starts and ends with resetSession (the sign-out reset) and no banner.
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
/** what GET messages answers per thread (the server's rows at the moment the request comes in) */
const pages = new Map<string, Message[]>();
/** GET messages of these threads answer only once released (the page is taken when the request comes in) */
const holds = new Map<string, Promise<void>>();

let at = 1_800_000_000_000;
const row = (threadId: ID, id: ID, role: Message["role"], text: string): Message => ({
  id,
  threadId,
  role,
  text,
  cards: [],
  tools: [],
  attachments: [],
  createdAt: ++at,
});
const thread = (id: ID, preview: string): Thread => ({
  id,
  kind: "main",
  title: "모시",
  subtitle: "",
  icon: "sparkles",
  archived: false,
  unread: false,
  createdAt: 1,
  updatedAt: 2,
  preview,
});
const push = (e: ServerEvent) => FakeEventSource.last!.onmessage!({ data: JSON.stringify(e) } as MessageEvent<string>);
let messages: typeof import("../src/api/store").messagesStore;
const ids = (threadId: ID) => (messages.get()[threadId]?.items ?? []).map((m) => m.id);

const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  const m = /\/api\/threads\/([^/?]+)\/messages/.exec(url);
  if (m && (init?.method ?? "GET") === "GET") {
    const id = decodeURIComponent(m[1]!);
    const body = JSON.stringify(pages.get(id) ?? []);
    const hold = holds.get(id);
    if (hold) await hold;
    return new Response(body, { status: 200, headers: { "Content-Type": "application/json" } });
  }
  return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
}) as unknown as typeof fetch;

/** signed in with live events (a fresh page: memory empty) */
async function signIn() {
  const { setToken } = await import("../src/api/client");
  setToken("qa-token");
  const { connectEvents } = await import("../src/api/events");
  connectEvents();
  expect(FakeEventSource.last?.url).toContain("/api/events?token=");
}

beforeAll(async () => {
  const { resetSession, messagesStore } = await import("../src/api/store");
  const { island, islandStore } = await import("../src/app/island");
  messages = messagesStore;
  resetSession(); // no turn, stores empty, island idle, the last events connection closed
  island.clearBanners();
  expect(islandStore.get().kind).toBe("idle");
  (globalThis as { EventSource?: unknown }).EventSource = FakeEventSource;
  globalThis.fetch = fakeFetch;
  await signIn();
});
afterAll(async () => {
  const { resetSession } = await import("../src/api/store");
  const { island } = await import("../src/app/island");
  resetSession(); // events closed, token cleared, stores empty, island idle: nothing left for the next file
  island.clearBanners();
  globalThis.fetch = realFetch;
  (globalThis as { EventSource?: unknown }).EventSource = realEventSource;
});

describe("message_deleted: a row the server deleted leaves open screens", () => {
  test("the chip of a failed briefing attempt, loaded while it ran, goes; the rest stays in order; the list row takes the preview that follows; island and banners untouched", async () => {
    const { loadMessages, threadsStore } = await import("../src/api/store");
    const { islandStore } = await import("../src/app/island");
    pages.set("t_main", [row("t_main", "m_q", "user", "오늘 일찍 일어났어"), row("t_main", "m_a", "assistant", "좋은 하루 보내세요"), row("t_main", "m_ev", "event", "오늘의 브리핑")]);
    await loadMessages("t_main");
    push({ type: "thread_updated", thread: thread("t_main", "오늘의 브리핑") });
    expect(ids("t_main")).toEqual(["m_q", "m_a", "m_ev"]);

    push({ type: "message_deleted", threadId: "t_main", messageId: "m_ev" });
    expect(ids("t_main")).toEqual(["m_q", "m_a"]);
    push({ type: "thread_updated", thread: thread("t_main", "좋은 하루 보내세요") });
    expect(threadsStore.get().items.find((t) => t.id === "t_main")?.preview).toBe("좋은 하루 보내세요");
    expect(islandStore.get().kind).toBe("idle");
    expect(islandStore.get().banner).toBeNull();
    // the same event again (another tab's delete echo, a replay) or an id this screen never had: nothing changes
    const before = messages.get().t_main;
    push({ type: "message_deleted", threadId: "t_main", messageId: "m_ev" });
    push({ type: "message_deleted", threadId: "t_main", messageId: "m_never" });
    expect(messages.get().t_main).toBe(before);
  });

  test("a page fetched before the delete (on its way when the event came) doesn't bring the row back", async () => {
    const { loadMessages } = await import("../src/api/store");
    pages.set("t_slow", [row("t_slow", "m_s1", "assistant", "어제 답"), row("t_slow", "m_sev", "event", "오늘의 브리핑")]);
    let release!: () => void;
    holds.set("t_slow", new Promise<void>((r) => (release = r)));
    const loading = loadMessages("t_slow");
    await new Promise((r) => setTimeout(r, 0));
    push({ type: "message_deleted", threadId: "t_slow", messageId: "m_sev" });
    release();
    await loading;
    holds.delete("t_slow");
    expect(ids("t_slow")).toEqual(["m_s1"]);
  });

  test("a thread this screen never loaded: no entry is made; opening it later shows what the server has", async () => {
    const { loadMessages } = await import("../src/api/store");
    push({ type: "message_deleted", threadId: "t_cold", messageId: "m_cev" });
    expect(messages.get().t_cold).toBeUndefined();
    pages.set("t_cold", [row("t_cold", "m_c1", "assistant", "답")]);
    await loadMessages("t_cold");
    expect(ids("t_cold")).toEqual(["m_c1"]);
  });

  test("only the row named goes, in the thread named: the same id in another thread's list, and a pushed row after it, stay", async () => {
    const { appendMessage } = await import("../src/api/store");
    appendMessage("t_two", row("t_two", "m_keep", "event", "영어 단어 · 매일 오전 7:30"));
    appendMessage("t_two", row("t_two", "m_keep_a", "assistant", "apple, river, stone"));
    push({ type: "message_deleted", threadId: "t_main", messageId: "m_keep" });
    expect(ids("t_two")).toEqual(["m_keep", "m_keep_a"]);
    push({ type: "message_deleted", threadId: "t_two", messageId: "m_keep" });
    expect(ids("t_two")).toEqual(["m_keep_a"]);
  });

  test("sign-out forgets the deleted ids with everything else (memory only, like the pages)", async () => {
    const { loadMessages, resetSession } = await import("../src/api/store");
    push({ type: "message_deleted", threadId: "t_out", messageId: "m_out" });
    resetSession();
    await signIn();
    pages.set("t_out", [row("t_out", "m_out", "assistant", "답")]);
    await loadMessages("t_out");
    expect(ids("t_out")).toEqual(["m_out"]);
  });
});
