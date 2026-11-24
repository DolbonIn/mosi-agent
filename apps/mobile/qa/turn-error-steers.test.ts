import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ServerEvent } from "@pickle/protocol";
import type { ThreadMessages } from "../src/api/store";

/**
 * Which failed turns let the row order take "하던 일에 이어서 전했어요" (composerStore failedRemotely, failedTurnSteers).
 * A turn the app started that fails names the lines it had read (`steers_dropped`); the lines it left queued get a
 * follow-up turn, so they keep the receipt, on the device that streamed the turn as on the others. A turn the app did
 * not start (a briefing, a schedule, a steer follow-up) names none: its `turn_error` puts the error row up on every
 * device, and then the row order says which lines it left unanswered (ThreadView, the call's notes). The mark goes with
 * the error row: every send clears it, and so does sign-out. (ThreadView's wiring: the captures OS, OL, S, L, F, N2.)
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
const rows = (spec: string) => spec.split(" ").map((id) => ({ id, role: id.startsWith("R") ? "assistant" : "user" }));
/** "A" a line that started a turn, "B*" a steered line, "R" a reply, "tmp_…" a line still being sent */
const thread = (spec: string, over: Partial<{ error: string; failed: string[]; streaming: boolean }> = {}) => ({
  error: ERROR,
  failed: [] as string[],
  streaming: false,
  items: rows(spec),
  ...over,
});
const has = (id: string) => id.endsWith("*");

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

describe("a failed turn: the row order takes receipts only after a turn_error", () => {
  test("a stream's error row (a turn the app started failed): the row order takes nothing; steers_dropped takes the lines it read, the line left queued keeps its receipt", async () => {
    const { failedRemotely, failedTurnSteers, markReceipt, receiptOf } = await chat();
    await streamError("t_own");
    expect(failedRemotely("t_own")).toBe(false);
    expect(failedTurnSteers("t_own", thread("A1 B1* B2*"), has)).toEqual([]);
    markReceipt("o_b1", "steered");
    markReceipt("o_b2", "steered");
    push({ type: "steers_dropped", threadId: "t_own", messageIds: ["o_b1"] } as ServerEvent);
    expect(receiptOf("o_b1")).toBeUndefined();
    expect(receiptOf("o_b2")).toBe("steered");
  });

  test("a turn_error (a turn the app did not start failed): its error row is up, and the row order says which lines it left", async () => {
    const { messagesStore } = await store();
    const { failedRemotely, failedTurnSteers } = await chat();
    expect(failedRemotely("t_rem")).toBe(false);
    turnError("t_rem");
    expect(messagesStore.get().t_rem?.error).toBe(ERROR);
    expect(failedRemotely("t_rem")).toBe(true);
    expect(failedTurnSteers("t_rem", thread("A1 B1*"), has)).toEqual(["B1*"]);
    // only while that row is up: an error, nothing of theirs unsent, no turn streaming
    expect(failedTurnSteers("t_rem", thread("A1 B1*", { error: "" }), has)).toEqual([]);
    expect(failedTurnSteers("t_rem", thread("A1 B1*", { failed: ["tmp_1"] }), has)).toEqual([]);
    expect(failedTurnSteers("t_rem", thread("A1 B1*", { streaming: true }), has)).toEqual([]);
    expect(failedTurnSteers("t_rem", undefined, has)).toEqual([]);
    // a line still being sent is not a row yet
    expect(failedTurnSteers("t_rem", thread("A1 B1* R1 tmp_2"), has)).toEqual(["B1*"]);
    // another thread's turn_error is not this one's
    expect(failedTurnSteers("t_own", thread("A1 B1*"), has)).toEqual([]);
  });

  test("the follow-up for the lines a failed turn of the app's left queued fails too (its turn_error over that row): marked", async () => {
    const { failedRemotely } = await chat();
    await streamError("t_fu");
    expect(failedRemotely("t_fu")).toBe(false);
    turnError("t_fu");
    expect(failedRemotely("t_fu")).toBe(true);
  });

  test("a thread not open here: the row waits for it, and the mark with it, while other threads change", async () => {
    const { failedRemotely } = await chat();
    turnError("t_far");
    await streamError("t_other");
    expect(failedRemotely("t_far")).toBe(true);
  });

  test("the next send clears the error row and the mark with it; other threads keep theirs", async () => {
    const { messagesStore, sendMessage, stopTurn } = await store();
    const { failedRemotely } = await chat();
    const sent = sendMessage("t_rem", "다시 알려줘");
    expect(messagesStore.get().t_rem?.error).toBeUndefined();
    expect(failedRemotely("t_rem")).toBe(false);
    stopTurn("t_rem");
    expect((await sent).status).toBe("aborted");
    expect(failedRemotely("t_rem")).toBe(false);
    expect([failedRemotely("t_fu"), failedRemotely("t_far")]).toEqual([true, true]);
  });

  test("sign-out (resetSession) clears every mark", async () => {
    const { resetSession } = await store();
    const { failedRemotely } = await chat();
    resetSession();
    expect([failedRemotely("t_fu"), failedRemotely("t_far")]).toEqual([false, false]);
  });
});
