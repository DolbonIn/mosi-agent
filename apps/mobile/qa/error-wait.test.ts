import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Message, ServerEvent } from "@pickle/protocol";
import type { ThreadMessages } from "../src/api/store";

/**
 * A failed turn's error row waits a moment for the server's `steers_dropped` when the person's lines just above its
 * place still read "하던 일에 이어서 전했어요" (DD 0010: the notice comes on /api/events, another connection than the turn's
 * stream, and could land a frame after the row went up above a receipt it then took). composerStore's errorWaiting is
 * what ThreadView reads (useErrorWait): the row stays off screen while it is true. Ends with that thread's notice (in
 * the same task as the receipts it takes), after ERROR_WAIT_MS with none (the lines went to a follow-up turn), or when
 * the error goes away. (ThreadView's wiring: the captures N2, N4, OS, EA, F.)
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
const dropped = (threadId: string, messageIds: string[]) => push({ type: "steers_dropped", threadId, messageIds } as ServerEvent);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const store = async () => import("../src/api/store");
const chat = async () => import("../src/screens/chat/composerStore");

let at = Date.UTC(2026, 10, 27, 9, 0);
const row = (threadId: string, id: string, role: "user" | "assistant", text = id): Message =>
  ({ id, threadId, role, text, cards: [], tools: [], attachments: [], createdAt: (at += 1000) }) as Message;
/** a thread on screen: `items` as [id, role], streaming or not */
const thread = async (threadId: string, items: [string, "user" | "assistant"][], streaming: boolean) => {
  const { messagesStore } = await store();
  const t: ThreadMessages = { items: items.map(([id, role]) => row(threadId, id, role)), draft: null, streaming, loading: false, loaded: true, hasMore: false, failed: [] };
  messagesStore.set((prev) => ({ ...prev, [threadId]: t }));
};
const patch = async (threadId: string, p: Partial<ThreadMessages>) => {
  const { messagesStore } = await store();
  messagesStore.set((prev) => ({ ...prev, [threadId]: { ...prev[threadId]!, ...p } }));
};
/** the turn's stream: its "error" event (store.ts setThreadError while streaming), then it closes (streaming off) */
const streamError = (threadId: string) => patch(threadId, { error: ERROR });
const streamCloses = (threadId: string) => patch(threadId, { streaming: false });

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

describe("the wait row held while the error row waits (DD 1741; DD 2243 W2, lead 2252 W1·W2)", () => {
  /**
   * One server render of a probe that calls DraftRow as a function twice in one instance (its hooks are the probe's;
   * a render-phase update renders the same instance again with them kept, as qa/use-store.test.ts does): first
   * streaming and stalled ("오래 걸리고 있어요 · 멈추기"), then with `held` (the stream has closed, the error row waits).
   * What each render returned, and the 멈추기 handler of the first one: the button still on screen while held.
   */
  async function heldTwice(held: boolean) {
    const { createElement, useState } = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { DraftRow } = await import("../src/screens/chat/Messages");
    const { turnStarted } = await chat();
    const { islandStore } = await import("../src/app/island");
    const threadId = "w_held";
    turnStarted.set(threadId, performance.now() - 20_000);
    const was = islandStore.get();
    islandStore.set({ ...was, stalled: true, threadId });
    const stops: number[] = [];
    const out: unknown[] = [];
    const ctx = { threadId, thread: undefined, agentName: "모시", agentSpec: {} as never, onSend: () => {}, onRetry: () => {} };
    function Probe() {
      const [step, setStep] = useState(0);
      out.push(DraftRow({ draft: null, streaming: step === 0, held: step === 1 && held, ctx, onStop: () => stops.push(step) }));
      if (step === 0) setStep(1);
      return null;
    }
    try {
      renderToStaticMarkup(createElement(Probe));
    } finally {
      islandStore.set(was);
      turnStarted.delete(threadId);
    }
    /** the element with this class in a returned tree (host elements and components alike: their props are there) */
    const find = (node: unknown, cls: string): { props: Record<string, unknown> } | null => {
      if (!node || typeof node !== "object") return null;
      if (Array.isArray(node)) {
        for (const n of node) {
          const f = find(n, cls);
          if (f) return f;
        }
        return null;
      }
      const el = node as { props?: Record<string, unknown> };
      if (!el.props) return null;
      if (typeof el.props.className === "string" && el.props.className.split(" ").includes(cls)) return el as { props: Record<string, unknown> };
      return find(el.props.children, cls);
    };
    const stop = find(out[0], "wait-stop");
    return { out, stops, stop: stop?.props.onClick as (() => void) | undefined };
  }

  test("held: the row is the one last drawn (its seconds stopped), and 멈추기 on it does nothing", async () => {
    const { out, stops, stop } = await heldTwice(true);
    expect(out).toHaveLength(2);
    expect(find2(out[0])).toBe(true);
    // the same element, not drawn again (W2: gone → a frame with neither)
    expect(out[1]).toBe(out[0]);
    expect(typeof stop).toBe("function");
    stop!();
    expect(stops).toEqual([]);
  });

  test("not held (the positive control): the stream has closed and nothing waits, so the row is gone; a 멈추기 pressed before that stops the turn", async () => {
    const { out, stops, stop } = await heldTwice(false);
    expect(out).toHaveLength(2);
    expect(find2(out[0])).toBe(true);
    expect(out[1]).toBeNull();
    stop!();
    // once (the handler is the first render's: its onStop pushes that render's step)
    expect(stops).toEqual([0]);
  });
});

/** a stalled wait row: the live row with 오래 걸리고 있어요 · 멈추기 */
function find2(node: unknown): boolean {
  const html = (n: unknown): string => {
    if (n == null || typeof n === "boolean") return "";
    if (typeof n === "string" || typeof n === "number") return String(n);
    if (Array.isArray(n)) return n.map(html).join("");
    const el = n as { props?: { className?: string; children?: unknown } };
    return `${el.props?.className ? `[${el.props.className}]` : ""}${html(el.props?.children)}`;
  };
  const h = html(node);
  return h.includes("[msg-row msg-asst msg-live]") && h.includes("[wait-stall]오래 걸리고 있어요 ·") && h.includes("[wait-stop]멈추기");
}

describe("the error row waits for steers_dropped", () => {
  test("N2: the person's turn read the steered line and failed; the stream closes before the notice: the row waits, the notice takes the receipt and ends the wait at once", async () => {
    const { markReceipt, receiptOf, errorWaiting, errorAnchorOf } = await chat();
    await thread("w_n2", [["n2_start", "user"], ["n2_steer", "user"]], true);
    markReceipt("n2_steer", "steered");
    await streamError("w_n2");
    expect(errorWaiting("w_n2")).toBe(false); // still streaming: no row yet
    await streamCloses("w_n2");
    expect(errorAnchorOf("w_n2")).toBe("n2_steer");
    expect(errorWaiting("w_n2")).toBe(true);
    dropped("w_n2", ["n2_steer"]);
    expect(receiptOf("n2_steer")).toBeUndefined();
    expect(errorWaiting("w_n2")).toBe(false);
  });

  test("OS: the turn failed before reading the line (no notice comes, the line goes to a follow-up): the row shows after ERROR_WAIT_MS, the receipt stays", async () => {
    const { markReceipt, receiptOf, errorWaiting, ERROR_WAIT_MS } = await chat();
    await thread("w_os", [["os_start", "user"], ["os_steer", "user"]], true);
    markReceipt("os_steer", "steered");
    await streamError("w_os");
    await streamCloses("w_os");
    expect(errorWaiting("w_os")).toBe(true);
    await sleep(ERROR_WAIT_MS / 2);
    expect(errorWaiting("w_os")).toBe(true);
    await sleep(ERROR_WAIT_MS / 2 + 60);
    expect(errorWaiting("w_os")).toBe(false);
    expect(receiptOf("os_steer")).toBe("steered");
  });

  test("a failure with no steered line above the row (N): no wait", async () => {
    const { errorWaiting } = await chat();
    await thread("w_n", [["n_start", "user"]], true);
    await streamError("w_n");
    await streamCloses("w_n");
    expect(errorWaiting("w_n")).toBe(false);
  });

  test("a steered line answered by an earlier turn keeps its receipt but makes no wait: the row's place is the later turn's line", async () => {
    const { markReceipt, errorWaiting } = await chat();
    await thread("w_old", [["o_start", "user"], ["o_steer", "user"], ["o_reply", "assistant"], ["o_next", "user"]], true);
    markReceipt("o_steer", "steered");
    await streamError("w_old");
    await streamCloses("w_old");
    expect(errorWaiting("w_old")).toBe(false);
  });

  test("the notice before the stream closes (the server's order arriving in order): the receipt is gone when the row goes up, no wait", async () => {
    const { markReceipt, receiptOf, errorWaiting } = await chat();
    await thread("w_ord", [["d_start", "user"], ["d_steer", "user"]], true);
    markReceipt("d_steer", "steered");
    await streamError("w_ord");
    dropped("w_ord", ["d_steer"]);
    expect(receiptOf("d_steer")).toBeUndefined();
    await streamCloses("w_ord");
    expect(errorWaiting("w_ord")).toBe(false);
  });

  test("another thread's notice ends nothing here", async () => {
    const { markReceipt, receiptOf, errorWaiting } = await chat();
    await thread("w_x", [["x_start", "user"], ["x_steer", "user"]], true);
    markReceipt("x_steer", "steered");
    await streamError("w_x");
    await streamCloses("w_x");
    dropped("w_elsewhere", ["x_steer_other"]);
    expect(errorWaiting("w_x")).toBe(true);
    expect(receiptOf("x_steer")).toBe("steered");
    dropped("w_x", ["x_steer"]);
    expect(errorWaiting("w_x")).toBe(false);
  });

  test("S/F: a turn_error (a briefing, a follow-up) puts the row up with the line above it: it waits for the notice that follows", async () => {
    const { markReceipt, receiptOf, errorWaiting } = await chat();
    await thread("w_te", [["te_brief", "assistant"], ["te_steer", "user"]], false);
    markReceipt("te_steer", "steered");
    turnError("w_te");
    expect(errorWaiting("w_te")).toBe(true);
    dropped("w_te", ["te_steer"]);
    expect(receiptOf("te_steer")).toBeUndefined();
    expect(errorWaiting("w_te")).toBe(false);
  });

  test("a row already up moves to a later turn_error's end (the follow-up failed too, a line pushed from another device into it): it waits there", async () => {
    const { markReceipt, errorWaiting, errorAnchorOf } = await chat();
    await thread("w_re", [["re_start", "user"]], true);
    await streamError("w_re");
    await streamCloses("w_re");
    expect(errorWaiting("w_re")).toBe(false);
    const { appendMessage } = await store();
    appendMessage("w_re", row("w_re", "re_pushed", "user", "다른 기기의 줄"));
    markReceipt("re_pushed", "steered");
    expect(errorWaiting("w_re")).toBe(false); // the row stays where it is: under the failed turn
    turnError("w_re");
    expect(errorAnchorOf("w_re")).toBe("re_pushed");
    expect(errorWaiting("w_re")).toBe(true);
    dropped("w_re", ["re_pushed"]);
    expect(errorWaiting("w_re")).toBe(false);
  });

  test("a turn_error during a wait (the follow-up failed before any notice): the wait starts again there, the first wait's timer gone with it (lead 2252 W3)", async () => {
    const { markReceipt, errorWaiting, ERROR_WAIT_MS } = await chat();
    await thread("w_rw", [["rw_start", "user"], ["rw_steer", "user"]], true);
    markReceipt("rw_steer", "steered");
    await streamError("w_rw");
    await streamCloses("w_rw");
    expect(errorWaiting("w_rw")).toBe(true);
    await sleep(ERROR_WAIT_MS * 0.6);
    turnError("w_rw");
    expect(errorWaiting("w_rw")).toBe(true);
    // past the first wait's end (1.0 × ERROR_WAIT_MS from the stream's close), inside the new one's
    await sleep(ERROR_WAIT_MS * 0.6);
    expect(errorWaiting("w_rw")).toBe(true);
    await sleep(ERROR_WAIT_MS * 0.4 + 60);
    expect(errorWaiting("w_rw")).toBe(false);
  });

  test("a row up after its wait stays up whatever else changes in the thread (more history, a reload): no new wait (lead 2252 W5)", async () => {
    const { markReceipt, receiptOf, errorWaiting, ERROR_WAIT_MS } = await chat();
    await thread("w_up", [["up_start", "user"], ["up_steer", "user"]], true);
    markReceipt("up_steer", "steered");
    await streamError("w_up");
    await streamCloses("w_up");
    expect(errorWaiting("w_up")).toBe(true);
    await sleep(ERROR_WAIT_MS + 60);
    expect(errorWaiting("w_up")).toBe(false);
    // the line kept its receipt (no notice): a new wait would find it above the row again
    expect(receiptOf("up_steer")).toBe("steered");
    await patch("w_up", { hasMore: true });
    expect(errorWaiting("w_up")).toBe(false);
    await patch("w_up", { loading: true });
    await patch("w_up", { loading: false });
    expect(errorWaiting("w_up")).toBe(false);
  });

  test("the error going away (the next send) ends the wait; a later failure starts its own", async () => {
    const { markReceipt, errorWaiting, ERROR_WAIT_MS } = await chat();
    await thread("w_gone", [["g_start", "user"], ["g_steer", "user"]], true);
    markReceipt("g_steer", "steered");
    await streamError("w_gone");
    await streamCloses("w_gone");
    expect(errorWaiting("w_gone")).toBe(true);
    await patch("w_gone", { error: undefined, streaming: true });
    expect(errorWaiting("w_gone")).toBe(false);
    await sleep(ERROR_WAIT_MS * 0.6);
    // the first wait's timer is gone with it: the new one runs its own full time
    await streamError("w_gone");
    await streamCloses("w_gone");
    expect(errorWaiting("w_gone")).toBe(true);
    await sleep(ERROR_WAIT_MS * 0.6);
    expect(errorWaiting("w_gone")).toBe(true);
    await sleep(ERROR_WAIT_MS * 0.4 + 60);
    expect(errorWaiting("w_gone")).toBe(false);
  });
});
