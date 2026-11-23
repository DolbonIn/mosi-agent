import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ServerEvent } from "@pickle/protocol";

/**
 * `steers_dropped`: a turn the app started stopped (or failed after reading them), and the server answers none of the
 * lines named. Every device of the person gets the ids; wherever a 202 put "하던 일에 이어서 전했어요" on one of them, it
 * goes, also when the send's result went elsewhere (island 다시 시도, PreDelegateSheet, another device's turn), and a
 * 202 that lands after the notice adds none. The call's transcript asks steerDropped which of its notes such a notice
 * named (callStore can't be loaded here: audio-unlock.test mocks it for the whole run; the captures cover the call).
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
const dropped = (messageIds: string[], threadId = "t_main") => push({ type: "steers_dropped", threadId, messageIds } as ServerEvent);

beforeAll(async () => {
  const { resetSession } = await import("../src/api/store");
  resetSession();
  (globalThis as { EventSource?: unknown }).EventSource = FakeEventSource;
  globalThis.fetch = fakeFetch;
  const { setToken } = await import("../src/api/client");
  setToken("qa-token");
  const { connectEvents } = await import("../src/api/events");
  connectEvents();
  expect(FakeEventSource.last?.url).toContain("/api/events?token=");
  await import("../src/screens/chat/composerStore"); // the chat screen's module: it listens from its first load
});
afterAll(async () => {
  const { resetSession } = await import("../src/api/store");
  resetSession();
  globalThis.fetch = realFetch;
  (globalThis as { EventSource?: unknown }).EventSource = realEventSource;
});

describe("steers_dropped: the lines of a stopped or failed turn lose their receipt", () => {
  test("the lines named lose 하던 일에 이어서 전했어요; a delivered receipt, a steered line not named and an id never marked stay as they are", async () => {
    const { markReceipt, receiptOf } = await import("../src/screens/chat/composerStore");
    markReceipt("m_s1", "steered");
    markReceipt("m_s2", "steered");
    markReceipt("m_d", "delivered");
    markReceipt("m_keep", "steered");
    dropped(["m_s1", "m_s2", "m_d", "m_never"]);
    expect(receiptOf("m_s1")).toBeUndefined();
    expect(receiptOf("m_s2")).toBeUndefined();
    expect(receiptOf("m_d")).toBe("delivered");
    expect(receiptOf("m_keep")).toBe("steered");
    expect(receiptOf("m_never")).toBeUndefined();
  });

  test("a 202 that lands after the notice adds no receipt; a line the notice didn't name still gets one", async () => {
    const { markReceipt, receiptOf } = await import("../src/screens/chat/composerStore");
    dropped(["m_late"]);
    markReceipt("m_late", "steered");
    expect(receiptOf("m_late")).toBeUndefined();
    markReceipt("m_next", "steered");
    expect(receiptOf("m_next")).toBe("steered");
  });

  test("the device that stopped (its own dropStoppedSteers took the receipt first) and the same notice twice: no change, other receipts stay", async () => {
    const { dropStoppedSteers, markReceipt, receiptOf } = await import("../src/screens/chat/composerStore");
    markReceipt("m_q", "steered");
    markReceipt("m_own", "steered");
    // ThreadView's stopped send: the turn's line, then the steered one after the last reply
    dropStoppedSteers({ status: "aborted", accepted: true }, [
      { id: "m_a0", role: "assistant" },
      { id: "m_q0", role: "user" },
      { id: "m_own", role: "user" },
    ]);
    expect(receiptOf("m_own")).toBeUndefined();
    dropped(["m_own"]);
    dropped(["m_own"]);
    expect(receiptOf("m_own")).toBeUndefined();
    expect(receiptOf("m_q")).toBe("steered");
    expect(receiptOf("m_keep")).toBe("steered");
  });

  test("another event about the same id (message_deleted) leaves receipts alone", async () => {
    const { receiptOf } = await import("../src/screens/chat/composerStore");
    push({ type: "message_deleted", threadId: "t_main", messageId: "m_keep" });
    expect(receiptOf("m_keep")).toBe("steered");
    expect(receiptOf("m_q")).toBe("steered");
  });

  test("the call asks steerDropped about its notes: yes for every id a notice named (with a receipt or not), no for the rest", async () => {
    const { steerDropped } = await import("../src/screens/chat/composerStore");
    expect(["m_s1", "m_s2", "m_d", "m_never", "m_late", "m_own"].map(steerDropped)).toEqual([true, true, true, true, true, true]);
    expect(["m_keep", "m_q", "m_next", "m_q0"].map(steerDropped)).toEqual([false, false, false, false]);
  });
});
