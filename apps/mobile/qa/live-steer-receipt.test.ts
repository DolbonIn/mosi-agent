import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ID, Message, ServerEvent } from "@pickle/protocol";

/**
 * The server pushes the person's lines to every device of theirs. A line it steered into a running turn comes with
 * `steered: true`, their friend-thread line that reached the friend without a turn with `delivered: true` (live pushes
 * only; a page read never carries them). Such a line gets "하던 일에 이어서 전했어요" / "전달됨" on every device, as on
 * the one whose 202 / 201 said so (composerStore), so a failed turn's error row goes above a steered line everywhere
 * (errorRowAfter, DD 1819). Never for a line already on this device before the push (DD 1854), one a `steers_dropped`
 * named, or a row that is not the person's.
 * Drives the real events.ts dispatch through a fake EventSource and the real sends through a fake fetch (no server).
 * bun runs every test file in one process: the file starts and ends with resetSession (the sign-out reset).
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
const LINE = "오늘 우산 필요해?";
let at = 1_900_000_000_000;
const row = (threadId: ID, id: ID, role: Message["role"], text: string, steered?: true): Message => ({ id, threadId, role, text, cards: [], tools: [], attachments: [], createdAt: ++at, ...(steered ? { steered } : {}) });
/** a friend-thread line: theirs ("me") or the friend's ("peer"), with the 201's flag or not */
const friendRow = (threadId: ID, id: ID, who: "me" | "peer", text: string, delivered?: true): Message => ({
  ...row(threadId, id, "user", text),
  author: who === "me" ? { kind: "me", name: "하늘" } : { kind: "peer", name: "서연 님" },
  ...(delivered ? { delivered } : {}),
});
const enc = new TextEncoder();
const sse = (e: unknown) => enc.encode(`data: ${JSON.stringify(e)}\n\n`);

const pages = new Map<string, Message[]>();
/** the next POSTs: a 202 that lands when the test calls `land`, or a turn stream the test writes; none: hangs */
const answers: ({ lateSteer: ID } | { stream: ID })[] = [];
let land: (() => void) | null = null;
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
    const a = answers.shift();
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
const tick = () => new Promise((r) => setTimeout(r, 5));
const store = () => import("../src/api/store");
const chat = () => import("../src/screens/chat/composerStore");
const ids = async (threadId: ID) => (await store()).messagesStore.get()[threadId]!.items.map((m) => m.id);

beforeAll(async () => {
  const { resetSession } = await store();
  const { island } = await import("../src/app/island");
  resetSession();
  island.clearBanners();
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
  const { island } = await import("../src/app/island");
  resetSession();
  island.clearBanners();
  globalThis.fetch = realFetch;
  (globalThis as { EventSource?: unknown }).EventSource = realEventSource;
});

describe("a live push of a steered line: the receipt on every device of the person", () => {
  test("another device: the line with steered: true gets the receipt; the line that started the turn (no field) none", async () => {
    const { loadMessages } = await store();
    const { receiptOf } = await chat();
    await loadMessages("t_l");
    push({ type: "message", threadId: "t_l", message: row("t_l", "l1", "user", "오늘 날씨 알려줘") });
    push({ type: "message", threadId: "t_l", message: row("t_l", "l2", "user", LINE, true) });
    expect(await ids("t_l")).toEqual(["l1", "l2"]);
    expect(receiptOf("l1")).toBeUndefined();
    expect(receiptOf("l2")).toBe("steered");
  });

  test("a thread not loaded here: the pushed line keeps its receipt once the page comes", async () => {
    const { loadMessages } = await store();
    const { receiptOf } = await chat();
    push({ type: "message", threadId: "t_u", message: row("t_u", "u2", "user", LINE, true) });
    expect(receiptOf("u2")).toBe("steered");
    pages.set("t_u", [row("t_u", "u1", "user", "오늘 날씨 알려줘"), row("t_u", "u2", "user", LINE)]);
    await loadMessages("t_u");
    expect(await ids("t_u")).toEqual(["u1", "u2"]);
    expect(receiptOf("u2")).toBe("steered");
  });

  test("a line already here before the push (a page read) gets none: a push again brings no dropped receipt back (DD 1854)", async () => {
    const { loadMessages } = await store();
    const { receiptOf } = await chat();
    pages.set("t_p", [row("t_p", "p1", "user", "오늘 날씨 알려줘"), row("t_p", "p2", "user", LINE)]);
    await loadMessages("t_p");
    push({ type: "message", threadId: "t_p", message: row("t_p", "p2", "user", LINE, true) });
    expect(await ids("t_p")).toEqual(["p1", "p2"]);
    expect(receiptOf("p2")).toBeUndefined();
  });

  test("a line a steers_dropped already named gets none; nor a row that is not the person's", async () => {
    const { loadMessages } = await store();
    const { receiptOf } = await chat();
    await loadMessages("t_d");
    push({ type: "steers_dropped", threadId: "t_d", messageIds: ["d2"] });
    push({ type: "message", threadId: "t_d", message: row("t_d", "d2", "user", LINE, true) });
    expect(receiptOf("d2")).toBeUndefined();
    push({ type: "message", threadId: "t_d", message: row("t_d", "d3", "assistant", "오늘은 맑아서 우산은 필요 없어요.", true) });
    expect(receiptOf("d3")).toBeUndefined();
    expect(await ids("t_d")).toEqual(["d2", "d3"]);
  });

  test("the device that sent it: the push before its 202: one row, the receipt at once; the 202 keeps both", async () => {
    const { loadMessages, sendMessage, messagesStore, stopTurn } = await store();
    const { receiptOf } = await chat();
    await loadMessages("t_s");
    answers.push({ stream: "s1" });
    void sendMessage("t_s", "오늘 날씨 알려줘");
    await tick();
    answers.push({ lateSteer: "s2" });
    const steered = sendMessage("t_s", LINE);
    await tick();
    const users = () => messagesStore.get().t_s!.items.filter((m) => m.role === "user" && m.text === LINE).map((m) => m.id);
    expect(users()).toHaveLength(1);
    expect(users()[0]).not.toBe("s2"); // still the optimistic row
    push({ type: "message", threadId: "t_s", message: row("t_s", "s2", "user", LINE, true) });
    expect(users()).toEqual(["s2"]);
    expect(receiptOf("s2")).toBe("steered");
    land!();
    expect((await steered).status).toBe("steered");
    expect(users()).toEqual(["s2"]);
    expect(receiptOf("s2")).toBe("steered");
    stopTurn("t_s");
    await tick();
  });
});

describe("a live push of a delivered friend-thread line: 전달됨 on every device of its author", () => {
  test("another device of theirs: their line with delivered: true gets 전달됨; one without the field, none", async () => {
    const { loadMessages } = await store();
    const { receiptOf } = await chat();
    await loadMessages("t_f");
    push({ type: "message", threadId: "t_f", message: friendRow("t_f", "f1", "me", "안녕, 오늘 저녁 어때?", true) });
    push({ type: "message", threadId: "t_f", message: friendRow("t_f", "f2", "me", "@깽이 7시 날씨 알려줘") });
    expect(receiptOf("f1")).toBe("delivered");
    expect(receiptOf("f2")).toBeUndefined();
  });

  test("the friend's line never gets it, even with the field; nor their line already here from a page read", async () => {
    const { loadMessages } = await store();
    const { receiptOf } = await chat();
    const g1 = friendRow("t_g", "g1", "me", "안녕");
    pages.set("t_g", [g1]);
    await loadMessages("t_g");
    push({ type: "message", threadId: "t_g", message: friendRow("t_g", "g2", "peer", "좋아, 7시 어때?", true) });
    push({ type: "message", threadId: "t_g", message: { ...g1, delivered: true } }); // the same row again
    expect(receiptOf("g2")).toBeUndefined();
    expect(receiptOf("g1")).toBeUndefined();
    expect(await ids("t_g")).toEqual(["g1", "g2"]);
  });
});

describe("the error row on the device streaming the failed turn, with a line another device steered (DD 1819)", () => {
  /** this device's own turn on `threadId` (its line `id`), another device's line pushed into it (`other`), the stream's error */
  async function streamFailsWithPushedLine(threadId: ID, id: ID, other: ID, steered: boolean) {
    const { loadMessages, sendMessage } = await store();
    await loadMessages(threadId);
    answers.push({ stream: id });
    const sent = sendMessage(threadId, "오늘 날씨 알려줘");
    await tick();
    push({ type: "message", threadId, message: row(threadId, other, "user", LINE, steered || undefined) });
    stream!.write({ type: "error", error: "upstream_rate_limited", message: MSG });
    await tick();
    stream!.end();
    expect((await sent).status).toBe("failed");
  }

  test("the line keeps its receipt: the error row goes after the failed turn's line, above it (A's order)", async () => {
    const { messagesStore, stopTurn } = await store();
    const { errorAnchorOf, errorRowAfter, receiptOf } = await chat();
    await streamFailsWithPushedLine("t_e", "e1", "e2", true);
    const items = messagesStore.get().t_e!.items;
    expect(items.map((m) => m.id)).toEqual(["e1", "e2"]);
    expect(messagesStore.get().t_e!.error).toBe(MSG);
    expect(errorAnchorOf("t_e")).toBe("e2");
    expect(errorRowAfter(items, errorAnchorOf("t_e"), (x) => receiptOf(x) === "steered")).toBe(0);
    stopTurn("t_e");
    await tick();
  });

  test("the failed turn had read it (steers_dropped names it): the receipt goes, the error row below it", async () => {
    const { messagesStore, stopTurn } = await store();
    const { errorAnchorOf, errorRowAfter, receiptOf } = await chat();
    await streamFailsWithPushedLine("t_r", "r1", "r2", true);
    push({ type: "steers_dropped", threadId: "t_r", messageIds: ["r2"] });
    const items = messagesStore.get().t_r!.items;
    expect(receiptOf("r2")).toBeUndefined();
    expect(errorRowAfter(items, errorAnchorOf("t_r"), (x) => receiptOf(x) === "steered")).toBe(1);
    stopTurn("t_r");
    await tick();
  });

  test("without the field (a server before it): no receipt, the error row below the line", async () => {
    const { messagesStore, stopTurn } = await store();
    const { errorAnchorOf, errorRowAfter, receiptOf } = await chat();
    await streamFailsWithPushedLine("t_n", "n1", "n2", false);
    const items = messagesStore.get().t_n!.items;
    expect(receiptOf("n2")).toBeUndefined();
    expect(errorRowAfter(items, errorAnchorOf("t_n"), (x) => receiptOf(x) === "steered")).toBe(1);
    stopTurn("t_n");
    await tick();
  });
});
