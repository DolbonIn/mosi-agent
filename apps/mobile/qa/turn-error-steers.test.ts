import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ServerEvent } from "@pickle/protocol";
import type { ThreadMessages } from "../src/api/store";

/**
 * A failed turn takes "하던 일에 이어서 전했어요" only from the lines the server names (`steers_dropped`), for every kind
 * of turn: one the app started (after the stream's error), a briefing, a schedule or a steer follow-up (after its
 * `turn_error`, which puts the error row up on every device). The row order takes nothing: a line the failed turn left
 * queued keeps its receipt until a later notice names it (its follow-up failed too). (ThreadView's and the call's
 * wiring: the captures S, L, F, KS, N2, OS.)
 * Drives the real events.ts dispatch through a fake EventSource (no server).
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
/** no request of this file needs an answer: each waits until aborted */
const fakeFetch = ((_input: RequestInfo | URL, init?: RequestInit) =>
  new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))))) as unknown as typeof fetch;
const push = (e: ServerEvent) => FakeEventSource.last!.onmessage!({ data: JSON.stringify(e) } as MessageEvent<string>);
const ERROR = "지금 요청이 많아요. 잠시 후 다시 시도해 주세요.";
const turnError = (threadId: string) => push({ type: "turn_error", threadId, error: "upstream_rate_limited", message: ERROR } as ServerEvent);

const store = async () => import("../src/api/store");
const chat = async () => import("../src/screens/chat/composerStore");
/** the error row a stream's "error" puts up on the device streaming the turn (store.ts setThreadError: no event) */
const streamError = async (threadId: string) => {
  const { messagesStore } = await store();
  const empty: ThreadMessages = { items: [], draft: null, streaming: false, loading: false, loaded: true, hasMore: false, failed: [] };
  messagesStore.set((prev) => ({ ...prev, [threadId]: { ...(prev[threadId] ?? empty), error: ERROR } }));
};
const dropped = (threadId: string, messageIds: string[]) => push({ type: "steers_dropped", threadId, messageIds } as ServerEvent);

beforeAll(async () => {
  const { resetSession } = await store();
  resetSession();
  (globalThis as { EventSource?: unknown }).EventSource = FakeEventSource;
  globalThis.fetch = fakeFetch;
  const { setToken } = await import("../src/api/client");
  setToken("qa-token");
  const { connectEvents } = await import("../src/api/events");
  connectEvents();
  expect(FakeEventSource.last?.url).toContain("/api/events?token=");
  await chat(); // the chat screen's module: it listens from its first load
});
afterAll(async () => {
  const { resetSession } = await store();
  resetSession();
  globalThis.fetch = realFetch;
  (globalThis as { EventSource?: unknown }).EventSource = realEventSource;
});

describe("a failed turn takes receipts only from steers_dropped", () => {
  test("a stream's error row (a turn the app started failed): steers_dropped takes the lines it read, the line left queued keeps its receipt", async () => {
    const { markReceipt, receiptOf } = await chat();
    await streamError("t_own");
    markReceipt("o_b1", "steered");
    markReceipt("o_b2", "steered");
    expect([receiptOf("o_b1"), receiptOf("o_b2")]).toEqual(["steered", "steered"]);
    dropped("t_own", ["o_b1"]);
    expect(receiptOf("o_b1")).toBeUndefined();
    expect(receiptOf("o_b2")).toBe("steered");
  });

  test("a turn_error (a briefing, a schedule): the error row is up and every receipt stays; then steers_dropped takes the lines it read, the queued one keeps its receipt", async () => {
    const { messagesStore } = await store();
    const { markReceipt, receiptOf } = await chat();
    markReceipt("r_b1", "steered");
    markReceipt("r_b2", "steered");
    turnError("t_rem");
    expect(messagesStore.get().t_rem?.error).toBe(ERROR);
    expect([receiptOf("r_b1"), receiptOf("r_b2")]).toEqual(["steered", "steered"]);
    dropped("t_rem", ["r_b1"]);
    expect(receiptOf("r_b1")).toBeUndefined();
    expect(receiptOf("r_b2")).toBe("steered");
  });

  test("a turn_error with no notice (the turn read nothing): every receipt stays, the error row up", async () => {
    const { messagesStore } = await store();
    const { markReceipt, receiptOf } = await chat();
    markReceipt("n_b1", "steered");
    turnError("t_none");
    expect(messagesStore.get().t_none?.error).toBe(ERROR);
    expect(receiptOf("n_b1")).toBe("steered");
  });

  test("the follow-up for the queued line fails too (its turn_error over that row): its notice takes that line; another thread's notice takes nothing here", async () => {
    const { markReceipt, receiptOf } = await chat();
    markReceipt("f_b1", "steered");
    markReceipt("f_b2", "steered");
    await streamError("t_fu");
    dropped("t_fu", ["f_b1"]);
    expect([receiptOf("f_b1"), receiptOf("f_b2")]).toEqual([undefined, "steered"]);
    turnError("t_fu");
    expect(receiptOf("f_b2")).toBe("steered");
    dropped("t_other", ["x_b9"]);
    expect(receiptOf("f_b2")).toBe("steered");
    dropped("t_fu", ["f_b2"]);
    expect(receiptOf("f_b2")).toBeUndefined();
  });

  test("a 202 that lands after the notice named its line adds no receipt", async () => {
    const { markReceipt, receiptOf } = await chat();
    turnError("t_late");
    dropped("t_late", ["l_b1"]);
    markReceipt("l_b1", "steered");
    expect(receiptOf("l_b1")).toBeUndefined();
  });
});
