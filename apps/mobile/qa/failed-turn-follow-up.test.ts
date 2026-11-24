import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ID, Message, ServerEvent } from "@pickle/protocol";

/**
 * A turn of theirs fails and the server runs a follow-up turn for the lines it had not read (DD 1503):
 *  - the island's "다시 시도할까요?" gives way to that turn's work while it runs, and comes back when it ends with the
 *    thread's error row still up (store.ts heldError); a failure with no follow-up keeps it at every step, whichever
 *    comes first, the stream's end or the server's idle
 *  - the error row keeps its place after the failed turn's last row (composerStore errorAnchorOf), above the lines it
 *    handed to the follow-up, which keep "하던 일에 이어서 전했어요" (errorRowAfter): those lines, the follow-up's answer
 *    and anything after it go below
 * Drives the real events.ts dispatch through a fake EventSource and the real turn stream through a fake fetch whose
 * stream the test writes (no server). bun runs every test file in one process: the file starts and ends with
 * resetSession (the sign-out reset) and no banner.
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
const MSG = "지금 요청이 많아요. 잠시 후 다시 시도해 주세요.";
let at = 1_900_000_000_000;
const row = (threadId: ID, id: ID, role: Message["role"], text: string): Message => ({ id, threadId, role, text, cards: [], tools: [], attachments: [], createdAt: ++at });
const enc = new TextEncoder();
const sse = (e: unknown) => enc.encode(`data: ${JSON.stringify(e)}\n\n`);

/** POST bodies; GET messages answers from `pages` */
const sends: { threadId: string; text: string }[] = [];
const pages = new Map<string, Message[]>();
/**
 * the next POSTs: a 202 steer (the line's id), one that lands when the test calls `land` (a late 202), or a turn stream
 * the test writes (its line's id); none: hangs until stopped
 */
const answers: ({ steer: ID } | { lateSteer: ID } | { stream: ID })[] = [];
let land: (() => void) | null = null;
/** the open turn stream: write events, then end it */
let stream: { write: (e: unknown) => void; end: () => void } | null = null;

const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  const m = /\/api\/threads\/([^/?]+)\/messages/.exec(url);
  if (m && (init?.method ?? "GET") === "GET") {
    return new Response(JSON.stringify(pages.get(decodeURIComponent(m[1]!)) ?? []), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  if (m && init?.method === "POST") {
    const threadId = decodeURIComponent(m[1]!);
    const text = JSON.parse(String(init.body)).text as string;
    sends.push({ threadId, text });
    const a = answers.shift();
    if (a && "steer" in a) return new Response(JSON.stringify({ steered: true, userMessage: row(threadId, a.steer, "user", text) }), { status: 202, headers: { "Content-Type": "application/json" } });
    if (a && "lateSteer" in a) {
      const um = row(threadId, a.lateSteer, "user", text);
      return new Promise<Response>((resolve) => {
        land = () => resolve(new Response(JSON.stringify({ steered: true, userMessage: um }), { status: 202, headers: { "Content-Type": "application/json" } }));
      });
    }
    if (a && "stream" in a) {
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(sse({ type: "start", threadId, userMessage: row(threadId, a.stream, "user", text), messageId: `${a.stream}_a` }));
          stream = { write: (e) => c.enqueue(sse(e)), end: () => c.close() };
        },
      });
      return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    }
  }
  return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
}) as unknown as typeof fetch;

const push = (e: ServerEvent) => FakeEventSource.last!.onmessage!({ data: JSON.stringify(e) } as MessageEvent<string>);
const status = (s: "running" | "idle") => push({ type: "agent_status", status: s, ...(s === "running" ? { text: "일하는 중" } : {}) } as ServerEvent);
const tick = () => new Promise((r) => setTimeout(r, 5));
const store = () => import("../src/api/store");
const isl = () => import("../src/app/island");
const chat = () => import("../src/screens/chat/composerStore");
/** every island kind from now on, with remote */
async function watchIsland() {
  const { islandStore } = await isl();
  const seen: string[] = [];
  const off = islandStore.subscribe(() => {
    const s = islandStore.get();
    const k = `${s.kind}${s.remote ? "(remote)" : ""}`;
    if (seen.at(-1) !== k) seen.push(k);
  });
  return { seen, off };
}

/**
 * the person's own turn on `threadId` (its line `id`, the thread open), a line steered into it (`steer`), then the
 * stream's error: returns the send's promise, still pending (the stream is open)
 */
async function ownTurnFails(threadId: ID, id: ID, steer: ID): Promise<{ sent: Promise<{ status: string }> }> {
  const { loadMessages, sendMessage } = await store();
  await loadMessages(threadId);
  answers.push({ stream: id });
  const sent = sendMessage(threadId, "오늘 날씨 알려줘");
  await tick();
  status("running"); // the server's own-turn start
  answers.push({ steer });
  expect((await sendMessage(threadId, "오늘 우산 필요해?")).status).toBe("steered");
  stream!.write({ type: "error", error: "upstream_rate_limited", message: MSG });
  await tick();
  return { sent };
}

beforeAll(async () => {
  const { resetSession } = await store();
  const { island, islandStore } = await isl();
  resetSession();
  island.clearBanners();
  expect(islandStore.get().kind).toBe("idle");
  (globalThis as { EventSource?: unknown }).EventSource = FakeEventSource;
  globalThis.fetch = fakeFetch;
  const { setToken } = await import("../src/api/client");
  setToken("qa-token");
  const { connectEvents } = await import("../src/api/events");
  connectEvents();
  expect(FakeEventSource.last?.url).toContain("/api/events?token=");
  await chat();
});
afterAll(async () => {
  const { resetSession } = await store();
  const { island } = await isl();
  resetSession();
  island.clearBanners();
  globalThis.fetch = realFetch;
  (globalThis as { EventSource?: unknown }).EventSource = realEventSource;
});

describe("a failed turn's follow-up: the island shows its work, then 다시 시도할까요? again", () => {
  test("the follow-up starts before the stream ends: its work shows; it answers and ends with the error row up: 다시 시도할까요? again, which sends the failed line", async () => {
    const { messagesStore, stopTurn } = await store();
    const { island, islandStore } = await isl();
    const { errorAnchorOf } = await chat();
    const { sent } = await ownTurnFails("t_a", "a1", "a_b1");
    expect(islandStore.get().kind).toBe("error");
    status("idle"); // the failed turn's end on the server
    status("running"); // its follow-up for the line it left
    expect(islandStore.get().kind).toBe("error"); // the stream is still open
    stream!.end();
    expect((await sent).status).toBe("failed");
    expect([islandStore.get().kind, islandStore.get().remote]).toEqual(["thinking", true]);
    // the error row's place: after the failed turn's last row; the follow-up's answer goes below
    expect(messagesStore.get().t_a!.error).toBe(MSG);
    expect(errorAnchorOf("t_a")).toBe("a_b1");
    push({ type: "message", threadId: "t_a", message: row("t_a", "a_r1", "assistant", "오늘은 맑아서 우산은 필요 없어요.") });
    expect(messagesStore.get().t_a!.items.map((m) => m.id)).toEqual(["a1", "a_b1", "a_r1"]);
    expect(errorAnchorOf("t_a")).toBe("a_b1");
    status("idle");
    expect([islandStore.get().kind, islandStore.get().text]).toEqual(["error", "다시 시도할까요?"]);
    island.press();
    await tick();
    expect(sends.at(-1)).toEqual({ threadId: "t_a", text: "오늘 날씨 알려줘" });
    expect(messagesStore.get().t_a!.error).toBeUndefined();
    expect(errorAnchorOf("t_a")).toBeUndefined();
    stopTurn("t_a");
    await tick();
  });

  test("the follow-up starts after the stream ended (stream end, idle, running): the same", async () => {
    const { stopTurn } = await store();
    const { island, islandStore } = await isl();
    island.idle();
    const { sent } = await ownTurnFails("t_b", "b1", "b_b1");
    stream!.end();
    expect((await sent).status).toBe("failed");
    expect(islandStore.get().kind).toBe("error");
    status("idle");
    expect(islandStore.get().kind).toBe("error");
    status("running");
    expect([islandStore.get().kind, islandStore.get().remote]).toEqual(["thinking", true]);
    status("idle");
    expect(islandStore.get().kind).toBe("error");
    stopTurn("t_b");
    await tick();
  });

  test("no follow-up: 다시 시도할까요? stays at every step, the server's idle before or after the stream's end", async () => {
    const { islandStore } = await isl();
    const { island } = await isl();
    for (const [n, idleFirst] of [
      ["c", true],
      ["d", false],
    ] as const) {
      island.idle();
      const { sent } = await ownTurnFails(`t_${n}`, `${n}1`, `${n}_b1`);
      const w = await watchIsland();
      if (idleFirst) status("idle");
      stream!.end();
      expect((await sent).status).toBe("failed");
      if (!idleFirst) status("idle");
      w.off();
      expect([islandStore.get().kind, w.seen.filter((k) => k !== "error")]).toEqual(["error", []]);
    }
  });

  test("the person sends again while the follow-up runs (the error row goes): when it ends the island goes idle", async () => {
    const { messagesStore, sendMessage } = await store();
    const { island, islandStore } = await isl();
    island.idle();
    const { sent } = await ownTurnFails("t_e", "e1", "e_b1");
    status("idle");
    status("running");
    stream!.end();
    await sent;
    expect(islandStore.get().kind).toBe("thinking");
    answers.push({ steer: "e_b2" });
    expect((await sendMessage("t_e", "내일은?")).status).toBe("steered");
    expect(messagesStore.get().t_e!.error).toBeUndefined();
    status("idle");
    expect(islandStore.get().kind).toBe("idle");
  });

  test("a turn_error on the device that sent the line, then the follow-up for a line that turn left: its work, then 다시 시도할까요? again", async () => {
    const { messagesStore, sendMessage } = await store();
    const { errorAnchorOf } = await chat();
    const { island, islandStore } = await isl();
    island.idle();
    push({ type: "message", threadId: "t_f", message: row("t_f", "f_ev", "event", "오늘의 브리핑") });
    status("running"); // the briefing
    answers.push({ steer: "f_b1" });
    expect((await sendMessage("t_f", "오늘 우산 필요해?")).status).toBe("steered");
    push({ type: "turn_error", threadId: "t_f", error: "upstream_rate_limited", message: MSG });
    // never loaded here (rows from the stream and the send): the row still follows the last of them
    expect(messagesStore.get().t_f!.loaded).toBe(false);
    expect(errorAnchorOf("t_f")).toBe("f_b1");
    status("idle");
    expect(islandStore.get().kind).toBe("error");
    status("running");
    expect([islandStore.get().kind, islandStore.get().remote]).toEqual(["thinking", true]);
    status("idle");
    expect(islandStore.get().kind).toBe("error");
  });

  test("a device with no failure of its own: a turn from elsewhere shows and ends as before", async () => {
    const { islandStore } = await isl();
    const { island } = await isl();
    island.idle();
    status("running");
    expect([islandStore.get().kind, islandStore.get().remote]).toEqual(["thinking", true]);
    status("idle");
    expect(islandStore.get().kind).toBe("idle");
  });
});

describe("the error row's place (errorAnchorOf)", () => {
  test("a thread not loaded when its turn_error came: no place until its rows load, then their last row; later rows go below; the next send ends it", async () => {
    const { loadMessages, messagesStore, sendMessage, stopTurn } = await store();
    const { errorAnchorOf } = await chat();
    push({ type: "turn_error", threadId: "t_far", error: "upstream_rate_limited", message: MSG });
    expect(messagesStore.get().t_far?.error).toBe(MSG);
    expect(errorAnchorOf("t_far")).toBeUndefined();
    pages.set("t_far", [row("t_far", "g_ev", "event", "오늘의 브리핑"), row("t_far", "g_b1", "user", "오늘 우산 필요해?")]);
    await loadMessages("t_far");
    expect(messagesStore.get().t_far!.loaded).toBe(true);
    expect(errorAnchorOf("t_far")).toBe("g_b1");
    push({ type: "message", threadId: "t_far", message: row("t_far", "g_r1", "assistant", "답이에요") });
    expect(errorAnchorOf("t_far")).toBe("g_b1");
    const s = sendMessage("t_far", "고마워");
    expect(errorAnchorOf("t_far")).toBeUndefined();
    stopTurn("t_far");
    await s;
  });

  test("a later failure while the row is up (the follow-up failed too: a turn_error) moves it to that turn's end", async () => {
    const { loadMessages } = await store();
    const { errorAnchorOf } = await chat();
    pages.set("t_two", [row("t_two", "k_a1", "user", "오늘 날씨 알려줘")]);
    await loadMessages("t_two");
    push({ type: "turn_error", threadId: "t_two", error: "upstream_rate_limited", message: MSG });
    expect(errorAnchorOf("t_two")).toBe("k_a1");
    push({ type: "message", threadId: "t_two", message: row("t_two", "k_b1", "user", "오늘 우산 필요해?") });
    expect(errorAnchorOf("t_two")).toBe("k_a1");
    push({ type: "turn_error", threadId: "t_two", error: "upstream_rate_limited", message: MSG });
    expect(errorAnchorOf("t_two")).toBe("k_b1");
  });

  test("a line still being sent when the error came was sent before it: the row goes after it, at the server's row once its 202 lands; the answer below", async () => {
    const { loadMessages, messagesStore, sendMessage } = await store();
    const { errorAnchorOf } = await chat();
    pages.set("t_tmp", [row("t_tmp", "h_a1", "user", "오늘 날씨 알려줘")]);
    await loadMessages("t_tmp");
    answers.push({ lateSteer: "h_b1" });
    const s = sendMessage("t_tmp", "오늘 우산 필요해?"); // its optimistic row is the newest
    const temp = messagesStore.get().t_tmp!.items.at(-1)!.id;
    expect(temp).toMatch(/^tmp/);
    push({ type: "turn_error", threadId: "t_tmp", error: "upstream_rate_limited", message: MSG });
    expect(errorAnchorOf("t_tmp")).toBe(temp);
    land!();
    expect((await s).status).toBe("steered");
    expect(messagesStore.get().t_tmp!.items.map((m) => m.id)).toEqual(["h_a1", "h_b1"]);
    expect(errorAnchorOf("t_tmp")).toBe("h_b1");
    push({ type: "message", threadId: "t_tmp", message: row("t_tmp", "h_r1", "assistant", "답이에요") });
    expect(errorAnchorOf("t_tmp")).toBe("h_b1");
  });

  test("a line still being sent when the error came that goes away (stopped): the row goes after the row before it", async () => {
    const { loadMessages, messagesStore, sendMessage, stopTurn } = await store();
    const { errorAnchorOf } = await chat();
    pages.set("t_gone", [row("t_gone", "j_a1", "user", "오늘 날씨 알려줘")]);
    await loadMessages("t_gone");
    const s = sendMessage("t_gone", "보내는 중"); // hangs: no answer queued
    push({ type: "turn_error", threadId: "t_gone", error: "upstream_rate_limited", message: MSG });
    expect(errorAnchorOf("t_gone")).toMatch(/^tmp/);
    stopTurn("t_gone");
    await s;
    expect(messagesStore.get().t_gone!.items.map((m) => m.id)).toEqual(["j_a1"]);
    expect(messagesStore.get().t_gone!.error).toBe(MSG);
    expect(errorAnchorOf("t_gone")).toBe("j_a1");
  });
});

describe("the error row among the rows (errorRowAfter): above the lines handed to a follow-up turn", () => {
  const rows = (...xs: [ID, Message["role"]][]) => xs.map(([id, role]) => ({ id, role }));
  const marked = (...ids: ID[]) => (id: ID) => ids.includes(id);

  test("the anchor is a line the failed turn left to a follow-up (still marked): the row goes above it, right under the turn's line", async () => {
    const { errorRowAfter } = await chat();
    const items = rows(["a1", "user"], ["b1", "user"], ["r1", "assistant"]);
    expect(errorRowAfter(items, "b1", marked("b1"))).toBe(0);
    expect(errorRowAfter(items, "b1", marked())).toBe(1); // not handed over: it stays above
  });

  test("lines the failed turn read (receipts dropped) stay above it; handed-over lines after them go below", async () => {
    const { errorRowAfter } = await chat();
    const items = rows(["a1", "user"], ["x1", "user"], ["y1", "user"], ["y2", "user"]);
    expect(errorRowAfter(items, "y2", marked("y1", "y2"))).toBe(1);
    // a line between them that was read stops the walk there
    expect(errorRowAfter(items, "y2", marked("x1", "y2"))).toBe(2);
  });

  test("a partial answer or a line from another device (no receipt here) is the turn's: the row stays under it", async () => {
    const { errorRowAfter } = await chat();
    expect(errorRowAfter(rows(["a1", "user"], ["y1", "user"], ["p1", "assistant"]), "p1", marked("y1"))).toBe(2);
    expect(errorRowAfter(rows(["a1", "user"], ["o1", "user"]), "o1", marked())).toBe(1);
  });

  test("every row up to the first is handed over: above the first row, never last", async () => {
    const { errorRowAfter } = await chat();
    expect(errorRowAfter(rows(["y1", "user"], ["y2", "user"]), "y2", marked("y1", "y2"))).toBe(-1);
  });

  test("no anchor among the rows (none yet, null, deleted): last", async () => {
    const { errorRowAfter } = await chat();
    const items = rows(["a1", "user"]);
    expect(errorRowAfter(items, undefined, marked())).toBeNull();
    expect(errorRowAfter(items, null, marked())).toBeNull();
    expect(errorRowAfter(items, "gone", marked())).toBeNull();
  });
});
