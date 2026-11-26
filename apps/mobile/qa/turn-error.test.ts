import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ID, Message, ServerEvent } from "@pickle/protocol";

/**
 * `turn_error` (snap-steer-error): a turn the person's line was steered into (a briefing, a schedule, or that line's own
 * follow-up turn) failed. The app shows it like a failed send of theirs: the thread's error row and island 다시 시도.
 * turn_error reaches every device of theirs; 다시 시도 is offered only where the line was sent (snap-turn-error-device):
 * another device, or this one after a reload, keeps the row alone.
 * Drives the real events.ts dispatch through a fake EventSource; fetch is faked (no server).
 * bun runs every test file in one process: a file before this one can leave a turn, the island (error, say) or the
 * stores behind, so the file starts and ends with resetSession (the sign-out reset) and no banner.
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
/** POST /api/threads/:id/messages bodies; GET messages answers from `pages` */
const sends: { threadId: string; text: string }[] = [];
const pages = new Map<string, Message[]>();
/**
 * how the server answers the next POSTs, in order: 202 steered (the line joins a running turn; its id), a turn stream
 * (start with the line, then done), a refusal before any turn (status, the server's error code and message), or nothing
 * queued: the request hangs until stopped
 */
const answers: ({ steer: ID } | { stream: ID } | { refuse: { status: number; error: string; message: string } })[] = [];

const MSG = "지금 요청이 많아요. 잠시 후 다시 시도해 주세요.";
let at = 1_800_000_000_000;
const row = (threadId: ID, id: ID, role: Message["role"], text: string, extra: Partial<Message> = {}): Message => ({
  id,
  threadId,
  role,
  text,
  cards: [],
  tools: [],
  attachments: [],
  createdAt: ++at,
  ...extra,
});
const push = (e: ServerEvent) => FakeEventSource.last!.onmessage!({ data: JSON.stringify(e) } as MessageEvent<string>);
const tick = () => new Promise((r) => setTimeout(r, 0));

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
    if (a && "refuse" in a) return new Response(JSON.stringify({ error: a.refuse.error, message: a.refuse.message }), { status: a.refuse.status, headers: { "Content-Type": "application/json" } });
    if (a && "steer" in a) return new Response(JSON.stringify({ steered: true, userMessage: row(threadId, a.steer, "user", text) }), { status: 202, headers: { "Content-Type": "application/json" } });
    if (a && "stream" in a) {
      const events = [
        { type: "start", threadId, userMessage: row(threadId, a.stream, "user", text), messageId: `${a.stream}_a` },
        { type: "done", message: row(threadId, `${a.stream}_a`, "assistant", "답이에요"), quota: { used: 1, limit: 100 } },
      ];
      return new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""), { status: 200, headers: { "Content-Type": "text/event-stream" } });
    }
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
  const { resetSession } = await import("../src/api/store");
  const { island, islandStore } = await import("../src/app/island");
  resetSession(); // no turn, stores empty, island idle (and its error timer cleared), the last events connection closed
  island.clearBanners();
  expect(islandStore.get().kind).toBe("idle");
  (globalThis as { EventSource?: unknown }).EventSource = FakeEventSource;
  globalThis.fetch = fakeFetch;
  await signIn();
});
afterAll(async () => {
  const { resetSession } = await import("../src/api/store");
  const { island } = await import("../src/app/island");
  resetSession(); // turns stopped, events closed, token cleared, island idle: nothing left for the next file
  island.clearBanners();
  globalThis.fetch = realFetch;
  (globalThis as { EventSource?: unknown }).EventSource = realEventSource;
});

describe("turn_error: a failed turn the person's line went into", () => {
  test("their line steered from this device: the thread gets the error row and the island 다시 시도; agent_status idle after it keeps the error; 다시 시도 sends their line again and clears the row", async () => {
    const { appendMessage, messagesStore, sendMessage, stopTurn } = await import("../src/api/store");
    const { island, islandStore } = await import("../src/app/island");
    appendMessage("t_main", row("t_main", "m_ev", "event", "오늘의 브리핑"));
    push({ type: "agent_status", status: "running", text: "일하는 중" });
    answers.push({ steer: "m_line" });
    expect((await sendMessage("t_main", "오늘 우산 필요해?")).status).toBe("steered");
    expect(messagesStore.get().t_main!.items.map((m) => m.id)).toEqual(["m_ev", "m_line"]);
    expect(islandStore.get().kind).toBe("thinking");

    push({ type: "turn_error", threadId: "t_main", error: "upstream_rate_limited", message: MSG });
    expect(messagesStore.get().t_main!.error).toBe(MSG);
    expect(islandStore.get().kind).toBe("error");
    expect(islandStore.get().banner).toBeNull();
    push({ type: "agent_status", status: "idle" }); // the server's turn end comes after the error
    expect(islandStore.get().kind).toBe("error");

    island.press();
    await tick();
    expect(sends.at(-1)).toEqual({ threadId: "t_main", text: "오늘 우산 필요해?" });
    expect(messagesStore.get().t_main!.error).toBeUndefined();
    stopTurn("t_main");
    await tick();
  });

  test("their line sent from another device (pushed here, no copy of ours): the row alone, no 다시 시도 and no banner", async () => {
    const { appendMessage, messagesStore } = await import("../src/api/store");
    const { island, islandStore } = await import("../src/app/island");
    island.idle();
    appendMessage("t_dev", row("t_dev", "m_dev", "user", "다른 폰에서 보낸 말"));
    push({ type: "turn_error", threadId: "t_dev", error: "upstream_rate_limited", message: MSG });
    expect(messagesStore.get().t_dev!.error).toBe(MSG);
    expect(islandStore.get().kind).toBe("idle");
    expect(islandStore.get().banner).toBeNull();
    const before = sends.length;
    island.press();
    await tick();
    expect(sends.length).toBe(before);
    // the device that sent it: a newer line of theirs from here gets 다시 시도 (their newest line decides)
    answers.push({ steer: "m_dev2" });
    await import("../src/api/store").then((s) => s.sendMessage("t_dev", "여기서 보낸 말"));
    push({ type: "turn_error", threadId: "t_dev", error: "upstream_rate_limited", message: MSG });
    expect(islandStore.get().kind).toBe("error");
    island.press();
    await tick();
    expect(sends.slice(before)).toEqual([
      { threadId: "t_dev", text: "여기서 보낸 말" },
      { threadId: "t_dev", text: "여기서 보낸 말" },
    ]);
    const { appendMessage: append, stopTurn } = await import("../src/api/store");
    stopTurn("t_dev");
    await tick();
    // and back: the other device's newer line decides again, a line of ours before it does not make it ours
    island.idle();
    append("t_dev", row("t_dev", "m_dev3", "user", "다시 다른 폰에서"));
    push({ type: "turn_error", threadId: "t_dev", error: "upstream_rate_limited", message: MSG });
    expect(islandStore.get().kind).toBe("idle");
    expect(islandStore.get().banner).toBeNull();
  });

  test("this device after a reload (memory empty, the line loaded from the server): the row alone", async () => {
    const { loadMessages, messagesStore, resetSession, sendMessage } = await import("../src/api/store");
    const { island, islandStore } = await import("../src/app/island");
    island.idle();
    answers.push({ steer: "m_rl" });
    expect((await sendMessage("t_reload", "새로 고치기 전에 보낸 말")).status).toBe("steered");
    pages.set("t_reload", [...messagesStore.get().t_reload!.items]);
    // the page reloads: stores and memory empty, signed in again, the thread loaded from the server
    resetSession();
    await signIn();
    await loadMessages("t_reload");
    expect(messagesStore.get().t_reload!.items.map((m) => m.id)).toEqual(["m_rl"]);
    push({ type: "turn_error", threadId: "t_reload", error: "timeout", message: "답이 너무 오래 걸렸어요." });
    expect(messagesStore.get().t_reload!.error).toBe("답이 너무 오래 걸렸어요.");
    expect(islandStore.get().kind).toBe("idle");
    expect(islandStore.get().banner).toBeNull();
    const before = sends.length;
    island.press();
    await tick();
    expect(sends.length).toBe(before);
  });

  test("a line that started its own turn here (the stream's start) and the pushed copy that beat our request's answer are this device's too", async () => {
    const { messagesStore, sendMessage, stopTurn, appendMessage } = await import("../src/api/store");
    const { island, islandStore } = await import("../src/app/island");
    island.idle();
    answers.push({ stream: "m_st" });
    expect((await sendMessage("t_stream", "처음 물어보는 말")).status).toBe("done");
    expect(messagesStore.get().t_stream!.items.map((m) => m.id)).toEqual(["m_st", "m_st_a"]);
    push({ type: "turn_error", threadId: "t_stream", error: "upstream_rate_limited", message: MSG }); // its follow-up failed
    expect(islandStore.get().kind).toBe("error");
    let before = sends.length;
    island.press();
    await tick();
    expect(sends.slice(before)).toEqual([{ threadId: "t_stream", text: "처음 물어보는 말" }]);
    stopTurn("t_stream");
    await tick();
    // the server's push of our line came before its answer: the copy of ours it replaced makes it ours
    island.idle();
    void sendMessage("t_push", "답보다 먼저 온 말"); // hangs: no answer yet
    appendMessage("t_push", row("t_push", "m_push", "user", "답보다 먼저 온 말"));
    expect(messagesStore.get().t_push!.items.map((m) => m.id)).toEqual(["m_push"]);
    stopTurn("t_push");
    await tick();
    push({ type: "turn_error", threadId: "t_push", error: "upstream_rate_limited", message: MSG });
    expect(islandStore.get().kind).toBe("error");
    before = sends.length;
    island.press();
    await tick();
    expect(sends.slice(before)).toEqual([{ threadId: "t_push", text: "답보다 먼저 온 말" }]);
    stopTurn("t_push");
    await tick();
  });

  test("a thread that isn't open keeps the row: a later load leaves it, the next send clears it", async () => {
    const { appendMessage, loadMessages, messagesStore, sendMessage, stopTurn } = await import("../src/api/store");
    appendMessage("t_other", row("t_other", "m_o1", "user", "내일 일정 알려줘"));
    push({ type: "turn_error", threadId: "t_other", error: "timeout", message: "답이 너무 오래 걸렸어요." });
    pages.set("t_other", [...messagesStore.get().t_other!.items, row("t_other", "m_o0", "assistant", "어제 답", { createdAt: 1 })]);
    await loadMessages("t_other"); // opening the thread later
    expect(messagesStore.get().t_other!.loaded).toBe(true);
    expect(messagesStore.get().t_other!.error).toBe("답이 너무 오래 걸렸어요.");
    void sendMessage("t_other", "다시 물어볼게");
    expect(messagesStore.get().t_other!.error).toBeUndefined();
    stopTurn("t_other");
    await tick();
  });

  test("no message text → the server's kind in Korean; a friend's line is never sent again", async () => {
    const { appendMessage, messagesStore, sendMessage } = await import("../src/api/store");
    const { island, islandStore } = await import("../src/app/island");
    island.idle();
    answers.push({ steer: "m_mine" });
    await sendMessage("t_shared", "내 질문");
    appendMessage("t_shared", row("t_shared", "m_peer", "user", "친구 질문", { author: { kind: "peer", name: "바다" } }));
    push({ type: "turn_error", threadId: "t_shared", error: "upstream_rate_limited", message: "" });
    expect(messagesStore.get().t_shared!.error).toBeTruthy();
    expect(islandStore.get().kind).toBe("error");
    const before = sends.length;
    island.press();
    await tick();
    expect(sends.slice(before)).toEqual([{ threadId: "t_shared", text: "내 질문" }]);
    const { stopTurn } = await import("../src/api/store");
    stopTurn("t_shared");
    await tick();
  });

  test("a friend's line newest, theirs from another device before it: the row alone, nothing sent again", async () => {
    const { appendMessage, messagesStore } = await import("../src/api/store");
    const { island, islandStore } = await import("../src/app/island");
    island.idle();
    appendMessage("t_shared2", row("t_shared2", "m_mine2", "user", "다른 폰의 내 질문", { author: { kind: "me", name: "하늘" } }));
    appendMessage("t_shared2", row("t_shared2", "m_peer2", "user", "친구 질문", { author: { kind: "peer", name: "바다" } }));
    push({ type: "turn_error", threadId: "t_shared2", error: "upstream_rate_limited", message: MSG });
    expect(messagesStore.get().t_shared2!.error).toBe(MSG);
    expect(islandStore.get().kind).toBe("idle");
    expect(islandStore.get().banner).toBeNull();
    const before = sends.length;
    island.press();
    await tick();
    expect(sends.length).toBe(before);
  });

  test("no line of theirs on this device (thread not loaded here): the row waits for the thread, an error banner instead of 다시 시도", async () => {
    const { messagesStore } = await import("../src/api/store");
    const { island, islandStore } = await import("../src/app/island");
    island.idle();
    push({ type: "turn_error", threadId: "t_cold", error: "upstream_rate_limited", message: MSG });
    expect(messagesStore.get().t_cold!.error).toBe(MSG);
    expect(islandStore.get().kind).toBe("idle");
    expect(islandStore.get().banner).toMatchObject({ tone: "error", title: "답하지 못했어요", body: MSG });
    const before = sends.length;
    island.press();
    await tick();
    expect(sends.length).toBe(before);
    // no message text: the banner says the server's kind in Korean, as the row does
    const { koreanMessage } = await import("../src/api/client");
    island.clearBanners();
    push({ type: "turn_error", threadId: "t_cold2", error: "timeout", message: "" });
    expect(koreanMessage(0, "timeout")).toBeTruthy();
    expect(islandStore.get().banner).toMatchObject({ tone: "error", title: "답하지 못했어요", body: koreanMessage(0, "timeout") });
    expect(messagesStore.get().t_cold2!.error).toBe(koreanMessage(0, "timeout"));
    island.clearBanners();
  });

  test("the day's quota, no line of theirs on this device: the banner says the quota and when it fills again, the row keeps the whole message (DD 0026)", async () => {
    const { messagesStore, QUOTA_TITLE } = await import("../src/api/store");
    const { koreanMessage, QUOTA_RESET } = await import("../src/api/client");
    const { island, islandStore } = await import("../src/app/island");
    island.idle();
    island.clearBanners();
    // the server's QUOTA_MESSAGE (76 characters): the banner's two lines cut its ticket hint
    const QUOTA = "오늘 사용량 한도를 다 썼어요. 매일 새벽 4시에 초기화되고, 지금 바로 이어서 쓰려면 나의 모시에서 한도 초기화 티켓을 사용해 주세요.";
    push({ type: "turn_error", threadId: "t_quota", error: "quota_exceeded", message: QUOTA });
    expect(islandStore.get().banner).toMatchObject({ tone: "error", title: "오늘 사용량을 다 썼어요", body: "새벽 4시에 다시 채워져요." });
    expect(messagesStore.get().t_quota!.error).toBe(QUOTA);
    expect(islandStore.get().banner?.title).toBe(QUOTA_TITLE);
    expect(islandStore.get().banner?.body).toBe(QUOTA_RESET);
    // no message text: the same banner; the row says koreanMessage's whole quota message
    island.clearBanners();
    push({ type: "turn_error", threadId: "t_quota2", error: "quota_exceeded", message: "" });
    expect(islandStore.get().banner).toMatchObject({ tone: "error", title: "오늘 사용량을 다 썼어요", body: "새벽 4시에 다시 채워져요." });
    expect(messagesStore.get().t_quota2!.error).toBe(koreanMessage(0, "quota_exceeded"));
    island.clearBanners();
  });

  test("the quota wording stays as it was: client.ts's quota_exceeded message word for word, its second sentence QUOTA_RESET; the send-refused banner's title QUOTA_TITLE", async () => {
    const { QUOTA_TITLE } = await import("../src/api/store");
    const { koreanMessage, QUOTA_RESET } = await import("../src/api/client");
    expect(QUOTA_RESET).toBe("새벽 4시에 다시 채워져요.");
    expect(koreanMessage(0, "quota_exceeded")).toBe("오늘 사용량을 모두 썼어요. 새벽 4시에 다시 채워져요.");
    expect(koreanMessage(0, "quota_exceeded").endsWith(` ${QUOTA_RESET}`)).toBe(true);
    expect(QUOTA_TITLE).toBe("오늘 사용량을 다 썼어요");
  });

  test("a send refused for the day's quota: the server's 429 keeps the failed bubble with the whole message in the row (no banner); a quota refusal that reaches the refused-send banner is titled 오늘 사용량을 다 썼어요", async () => {
    const { messagesStore, sendMessage } = await import("../src/api/store");
    const { island, islandStore } = await import("../src/app/island");
    const QUOTA = "오늘 사용량 한도를 다 썼어요. 매일 새벽 4시에 초기화되고, 지금 바로 이어서 쓰려면 나의 모시에서 한도 초기화 티켓을 사용해 주세요.";
    island.idle();
    island.clearBanners();
    // the server's quota refusal (threads.ts: 429 quota_exceeded before any turn): the row, not the banner
    answers.push({ refuse: { status: 429, error: "quota_exceeded", message: QUOTA } });
    const r429 = await sendMessage("t_qsend", "오늘 일정 알려줘");
    expect(r429).toMatchObject({ status: "failed", keepText: false });
    expect(messagesStore.get().t_qsend!.error).toBe(QUOTA);
    expect(islandStore.get().banner).toBeNull();
    // the refused-send banner (rejectionBanner: a refusal before streaming that is not 429/5xx/401): quota_exceeded gets
    // the quota title word for word, the server's message as its body, and the text goes back to the composer
    island.clearBanners();
    answers.push({ refuse: { status: 403, error: "quota_exceeded", message: QUOTA } });
    const r403 = await sendMessage("t_qsend2", "오늘 일정 알려줘");
    expect(r403).toMatchObject({ status: "rejected", keepText: true });
    expect(islandStore.get().banner).toMatchObject({ tone: "error", title: "오늘 사용량을 다 썼어요", body: QUOTA });
    expect(messagesStore.get().t_qsend2?.error).toBeUndefined();
    island.clearBanners();
    island.idle();
  });

  test("the day's quota in a thread whose line is on this device: the error row, no banner (as before)", async () => {
    const { appendMessage, messagesStore } = await import("../src/api/store");
    const { island, islandStore } = await import("../src/app/island");
    island.idle();
    island.clearBanners();
    appendMessage("t_quota3", row("t_quota3", "m_q3", "user", "다른 폰에서 보낸 말"));
    push({ type: "turn_error", threadId: "t_quota3", error: "quota_exceeded", message: MSG });
    expect(messagesStore.get().t_quota3!.error).toBe(MSG);
    expect(islandStore.get().banner).toBeNull();
  });

  test("a send of theirs still in flight keeps the island on it, and is not the line 다시 시도 sends again", async () => {
    const { sendMessage, stopTurn } = await import("../src/api/store");
    const { island, islandStore } = await import("../src/app/island");
    island.idle();
    answers.push({ steer: "m_line2" });
    await sendMessage("t_main", "한 번 더");
    void sendMessage("t_main", "지금 보내는 말"); // its optimistic copy is the thread's newest user row
    expect(islandStore.get().kind).toBe("thinking");
    push({ type: "turn_error", threadId: "t_main", error: "upstream_rate_limited", message: MSG });
    expect(islandStore.get().kind).toBe("thinking");
    stopTurn("t_main");
    await tick();
    island.error(); // 다시 시도 offered later (any failure): it sends the accepted line, never the optimistic copy
    const before = sends.length;
    island.press();
    await tick();
    expect(sends.slice(before)).toEqual([{ threadId: "t_main", text: "한 번 더" }]);
    stopTurn("t_main");
    await tick();
  });
});
