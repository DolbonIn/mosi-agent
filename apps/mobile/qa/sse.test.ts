import { describe, expect, test } from "bun:test";
import { createSseParser } from "../src/api/sse";

function collect() {
  const out: { data: string; event: string }[] = [];
  const p = createSseParser((data, event) => out.push({ data, event }));
  return { out, p };
}

describe("createSseParser", () => {
  test("one event per blank-line-terminated block, data with or without the space", () => {
    const { out, p } = collect();
    p.push('data: {"type":"status","text":"날씨 보는 중"}\n\ndata:{"type":"text","delta":"안녕"}\n\n');
    expect(out.map((e) => JSON.parse(e.data).type)).toEqual(["status", "text"]);
    expect(JSON.parse(out[1].data).delta).toBe("안녕");
  });

  test("events split across arbitrary chunk boundaries (incl. inside a multibyte-free token)", () => {
    const { out, p } = collect();
    const raw = 'data: {"type":"text","delta":"a"}\n\ndata: {"type":"text","delta":"b"}\n\n';
    for (const ch of raw) p.push(ch);
    expect(out.map((e) => JSON.parse(e.data).delta)).toEqual(["a", "b"]);
  });

  test("CRLF and lone CR line endings, CR split from LF across chunks", () => {
    const { out, p } = collect();
    p.push('data: {"n":1}\r');
    p.push('\n\r');
    p.push('\ndata: {"n":2}\r\r');
    // a CR at the very end of a chunk may be half of CRLF: the parser waits for the next byte (or end)
    expect(out.map((e) => JSON.parse(e.data).n)).toEqual([1]);
    p.end();
    expect(out.map((e) => JSON.parse(e.data).n)).toEqual([1, 2]);
  });

  test("multi-line data joined with \\n", () => {
    const { out, p } = collect();
    p.push("data: line one\ndata: line two\ndata:\n\n");
    expect(out[0].data).toBe("line one\nline two\n");
  });

  test("comments and unknown fields ignored, event name passed through and reset", () => {
    const { out, p } = collect();
    p.push(": keep-alive\n\nid: 7\nretry: 1000\nevent: error\ndata: {\"error\":\"quota_exceeded\"}\n\ndata: x\n\n");
    expect(out).toEqual([
      { data: '{"error":"quota_exceeded"}', event: "error" },
      { data: "x", event: "message" },
    ]);
  });

  test("end() flushes a trailing event without the final blank line", () => {
    const { out, p } = collect();
    p.push('data: {"type":"done"}');
    expect(out.length).toBe(0);
    p.end();
    expect(out.length).toBe(1);
    expect(JSON.parse(out[0].data).type).toBe("done");
  });
});

// ── streamTurn + store.sendMessage over a mocked fetch ──
import { streamTurn } from "../src/api/sse";

function sseResponse(chunks: string[]) {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(ch));
      c.close();
    },
  });
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

const msg = (id: string, role: "user" | "assistant", text: string) => ({ id, threadId: "t1", role, text, cards: [], tools: [], attachments: [], createdAt: Date.now() });

describe("streamTurn", () => {
  test("parses a stream and captures done", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      sseResponse([
        `data: ${JSON.stringify({ type: "start", threadId: "t1", userMessage: msg("u1", "user", "hi"), messageId: "a1" })}\n\n`,
        `data: ${JSON.stringify({ type: "text", delta: "안" })}\n\ndata: ${JSON.stringify({ type: "text", delta: "녕" })}\n\n`,
        `data: ${JSON.stringify({ type: "done", message: msg("a1", "assistant", "안녕"), quota: { usedPct: 7, usedTokens: 1, limitTokens: 2, resetsAt: 0, resetHour: 4 } })}\n\n`,
      ])) as unknown as typeof fetch;
    const seen: string[] = [];
    const res = await streamTurn("/api/threads/t1/messages", { text: "hi" }, { onEvent: (e) => seen.push(e.type) });
    globalThis.fetch = realFetch;
    expect(seen).toEqual(["start", "text", "text", "done"]);
    expect(res.kind).toBe("stream");
    if (res.kind === "stream") expect(res.done?.message.text).toBe("안녕");
  });

  test("202 JSON → steered", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({ steered: true, userMessage: msg("u2", "user", "또") }), { status: 202, headers: { "Content-Type": "application/json" } })) as unknown as typeof fetch;
    const res = await streamTurn("/x", {}, { onEvent: () => {} });
    globalThis.fetch = realFetch;
    expect(res.kind).toBe("steered");
  });

  test("non-OK → Korean ApiError from the server body", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: "quota_exceeded", message: "오늘 사용량을 모두 썼어요." }), { status: 429 })) as unknown as typeof fetch;
    let err: unknown;
    try {
      await streamTurn("/x", {}, { onEvent: () => {} });
    } catch (e) {
      err = e;
    }
    globalThis.fetch = realFetch;
    expect((err as { code: string }).code).toBe("quota_exceeded");
    expect((err as Error).message).toBe("오늘 사용량을 모두 썼어요.");
  });
});

describe("store.sendMessage", () => {
  test("optimistic message → replaced by start.userMessage → draft → done message", async () => {
    const { sendMessage, messagesStore } = await import("../src/api/store");
    const realFetch = globalThis.fetch;
    let snapshotDuring: { items: number; draft: string | null } | null = null;
    globalThis.fetch = (async () =>
      sseResponse([
        `data: ${JSON.stringify({ type: "start", threadId: "t1", userMessage: msg("u1", "user", "안녕"), messageId: "a1" })}\n\n`,
        `data: ${JSON.stringify({ type: "tool", tool: { id: "k1", name: "k.weather", title: "서울 날씨 확인", state: "running", startedAt: 1 } })}\n\n`,
        `data: ${JSON.stringify({ type: "done", message: msg("a1", "assistant", "맑아요"), quota: { usedPct: 7, usedTokens: 1, limitTokens: 2, resetsAt: 0, resetHour: 4 } })}\n\n`,
      ])) as unknown as typeof fetch;
    const unsub = messagesStore.subscribe(() => {
      const t = messagesStore.get().t1;
      if (t?.draft && !snapshotDuring) snapshotDuring = { items: t.items.length, draft: t.draft.messageId };
    });
    const res = await sendMessage("t1", "  안녕 ");
    unsub();
    globalThis.fetch = realFetch;
    expect(res.ok).toBe(true);
    expect(snapshotDuring).toEqual({ items: 1, draft: "a1" });
    const t = messagesStore.get().t1;
    expect(t.items.map((m) => m.id)).toEqual(["u1", "a1"]);
    expect(t.draft).toBeNull();
    expect(t.streaming).toBe(false);
  });

  test("network failure keeps the user message and marks it failed", async () => {
    const { sendMessage, messagesStore } = await import("../src/api/store");
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    const res = await sendMessage("t2", "보내기");
    globalThis.fetch = realFetch;
    expect(res.ok).toBe(false);
    const t = messagesStore.get().t2;
    expect(t.items.length).toBe(1);
    expect(t.failed).toEqual([t.items[0].id]);
    expect(t.error).toBe("서버에 연결하지 못했어요. 네트워크를 확인해 주세요.");
  });
});
