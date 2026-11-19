import { afterEach, beforeEach, describe, expect, test } from "bun:test";

/**
 * api/ against docs/architecture/SERVER-CONTRACT.md over a mocked fetch: heartbeats, 201/202/409 send answers,
 * bare-array lists, signed approvals, display_code polling.
 */

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});
// banners queue across tests (and across test files in one bun process): start each test with none
beforeEach(async () => {
  const { island } = await import("../src/app/island");
  island.clearBanners();
});

type Call = { url: string; method: string; body: unknown; headers: Record<string, string> };
function mockFetch(handler: (c: Call) => Response | Promise<Response>): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = init?.body;
    let body: unknown = raw;
    if (typeof raw === "string") {
      try {
        body = JSON.parse(raw);
      } catch {
        body = raw;
      }
    }
    const c: Call = { url: String(input), method: init?.method ?? "GET", body, headers: (init?.headers ?? {}) as Record<string, string> };
    calls.push(c);
    return handler(c);
  }) as unknown as typeof fetch;
  return calls;
}

const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "Content-Type": "application/json" } });
function sse(chunks: string[]) {
  const enc = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(c) {
        for (const ch of chunks) c.enqueue(enc.encode(ch));
        c.close();
      },
    }),
    { status: 200, headers: { "Content-Type": "text/event-stream" } },
  );
}
const msg = (id: string, threadId: string, role: "user" | "assistant", text: string) => ({ id, threadId, role, text, cards: [], tools: [], attachments: [], createdAt: Date.now() });
const quota = { usedPct: 1, usedTokens: 1, limitTokens: 2, resetsAt: 0, resetHour: 4 };

describe("turn stream framing", () => {
  test("`: hb` heartbeats between events are ignored; events arrive in order", async () => {
    const { streamTurn } = await import("../src/api/sse");
    mockFetch(() =>
      sse([
        ": hb\n\n",
        `data: ${JSON.stringify({ type: "start", threadId: "t", userMessage: null, messageId: "a" })}\n\n: hb\n\n`,
        `data: ${JSON.stringify({ type: "status", text: "x" })}\n\n`,
        ": hb\n",
        `\ndata: ${JSON.stringify({ type: "error", error: "upstream", message: "답하지 못했어요" })}\n\n`,
      ]),
    );
    const seen: string[] = [];
    const res = await streamTurn("/api/threads/t/messages", { text: "a" }, { onEvent: (e) => seen.push(e.type) });
    expect(seen).toEqual(["start", "status", "error"]);
    expect(res.kind).toBe("stream");
    if (res.kind === "stream") expect(res.error?.message).toBe("답하지 못했어요");
  });
});

describe("POST /api/threads/:id/messages answers", () => {
  test("201 delivered (friend thread) → bubble kept, no turn", async () => {
    const { sendMessage, messagesStore } = await import("../src/api/store");
    mockFetch(() => json({ delivered: true, userMessage: msg("u9", "f1", "user", "안녕 진우") }, 201));
    const res = await sendMessage("f1", "안녕 진우");
    expect(res.status).toBe("delivered");
    expect(res.keepText).toBe(false);
    const t = messagesStore.get().f1;
    expect(t.items.map((m) => m.id)).toEqual(["u9"]);
    expect(t.streaming).toBe(false);
  });

  test("202 steered → the user bubble replaces the optimistic copy", async () => {
    const { sendMessage, messagesStore } = await import("../src/api/store");
    mockFetch(() => json({ steered: true, userMessage: msg("u3", "s1", "user", "그리고 내일도") }, 202));
    const res = await sendMessage("s1", "그리고 내일도");
    expect(res.status).toBe("steered");
    expect(messagesStore.get().s1.items.map((m) => m.id)).toEqual(["u3"]);
  });

  test("409 busy → bubble removed, keepText, the server's message as a banner", async () => {
    const { sendMessage, messagesStore } = await import("../src/api/store");
    const { islandStore, island } = await import("../src/app/island");
    const message = "깽이가 다른 일을 하고 있어요. 끝나면 다시 보내 주세요.";
    mockFetch(() => json({ error: "busy", message }, 409));
    const res = await sendMessage("b1", "이것도 해 줘");
    expect(res.status).toBe("busy");
    expect(res.keepText).toBe(true);
    expect(res.error?.message).toBe(message);
    expect(messagesStore.get().b1.items).toEqual([]);
    expect(islandStore.get().banner?.title).toBe(message);
    expect(islandStore.get().kind).toBe("idle");
    island.dismissBanner();
  });

  test("429 quota → failed bubble kept (다시 보내기), the server's reason as the thread error, no turn", async () => {
    const { sendMessage, messagesStore } = await import("../src/api/store");
    const { islandStore } = await import("../src/app/island");
    const message = "오늘 쓸 수 있는 양을 다 썼어요. 새벽 4시에 다시 채워져요.";
    mockFetch(() => json({ error: "quota_exceeded", message }, 429));
    const res = await sendMessage("q1", "날씨");
    expect(res.ok).toBe(false);
    expect(res.status).toBe("failed");
    expect(res.keepText).toBe(false);
    expect(res.error?.message).toBe(message);
    const t = messagesStore.get().q1;
    expect(t.items.length).toBe(1);
    expect(t.failed).toEqual([t.items[0]!.id]);
    expect(t.error).toBe(message);
    expect(islandStore.get().kind).toBe("idle");
  });

  test("413 too large → rejected, bubble removed, keepText, error banner carries the server message", async () => {
    const { sendMessage, messagesStore } = await import("../src/api/store");
    const { islandStore, island } = await import("../src/app/island");
    mockFetch(() => json({ error: "payload_too_large", message: "첨부가 너무 커요. 10MB 이하로 보내 주세요." }, 413));
    const res = await sendMessage("p1", "이 파일 봐 줘");
    expect(res.status).toBe("rejected");
    expect(res.keepText).toBe(true);
    expect(messagesStore.get().p1.items).toEqual([]);
    expect(messagesStore.get().p1.error).toBeUndefined();
    const b = islandStore.get().banner;
    expect(b?.tone).toBe("error");
    expect(b?.body).toBe("첨부가 너무 커요. 10MB 이하로 보내 주세요.");
    island.dismissBanner();
  });

  test("Stop mid-stream → aborted (not a cut): no thread error, no island error, no retry", async () => {
    const { sendMessage, stopTurn, messagesStore } = await import("../src/api/store");
    const { islandStore } = await import("../src/app/island");
    const enc = new TextEncoder();
    // a stream that sends a start + some text and then stays open until the client cancels it
    mockFetch(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(c) {
              c.enqueue(enc.encode(`data: ${JSON.stringify({ type: "start", threadId: "st1", userMessage: msg("u9", "st1", "user", "긴 답 부탁해"), messageId: "a9" })}\n\n`));
              c.enqueue(enc.encode(`data: ${JSON.stringify({ type: "text", delta: "길게 답하는 중" })}\n\n`));
            },
          }),
          { status: 200, headers: { "Content-Type": "text/event-stream" } },
        ),
    );
    const p = sendMessage("st1", "긴 답 부탁해");
    await new Promise((r) => setTimeout(r, 30));
    stopTurn("st1");
    const res = await p;
    expect(res.status).toBe("aborted");
    expect(res.error?.code).toBe("aborted");
    expect(messagesStore.get().st1.error).toBeUndefined();
    expect(messagesStore.get().st1.failed).toEqual([]);
    expect(messagesStore.get().st1.streaming).toBe(false);
    expect(islandStore.get().kind).not.toBe("error");
    expect(islandStore.get().banner).toBeNull();
  });

  test("ApiError keeps the parsed error body (400 bad_code → data.attemptsLeft)", async () => {
    const { api, ApiError } = await import("../src/api/client");
    mockFetch(() => json({ error: "bad_code", message: "인증번호가 맞지 않아요.", attemptsLeft: 2 }, 400));
    const err = await api("POST", "/api/profile/phone/verify", { code: "000000" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    const e = err as InstanceType<typeof ApiError>;
    expect(e.code).toBe("bad_code");
    expect(e.message).toBe("인증번호가 맞지 않아요.");
    expect(e.data?.attemptsLeft).toBe(2);
  });

  test("island follows the stream: thinking → tool label from the real name → streaming → done", async () => {
    const { sendMessage } = await import("../src/api/store");
    const { islandStore } = await import("../src/app/island");
    const kinds: string[] = [];
    const unsub = islandStore.subscribe(() => {
      const s = islandStore.get();
      const k = s.kind === "tool" ? `tool:${s.text}` : s.kind;
      if (kinds[kinds.length - 1] !== k) kinds.push(k);
    });
    mockFetch(() =>
      sse([
        `data: ${JSON.stringify({ type: "start", threadId: "i1", userMessage: msg("u1", "i1", "user", "날씨"), messageId: "a1" })}\n\n`,
        `data: ${JSON.stringify({ type: "status", text: "서버가 준 문구" })}\n\n`,
        `data: ${JSON.stringify({ type: "tool", tool: { id: "k", name: "k_weather", title: "서울 날씨 확인", state: "running", startedAt: 1 } })}\n\n`,
        `data: ${JSON.stringify({ type: "text", delta: "맑아요" })}\n\n`,
        `data: ${JSON.stringify({ type: "done", message: msg("a1", "i1", "assistant", "맑아요"), quota })}\n\n`,
      ]),
    );
    const res = await sendMessage("i1", "날씨");
    unsub();
    expect(res.status).toBe("done");
    expect(kinds).toEqual(["thinking", "tool:날씨 보는 중", "streaming", "done"]);
  });
});

describe("lists are bare arrays", () => {
  test("credentials / access-log / friends / schedules / connections", async () => {
    const ep = await import("../src/api/endpoints");
    const calls = mockFetch((c) => {
      if (c.url.includes("/api/connections")) return json({ providers: [{ id: "kakaotalk" }], connections: [] });
      return json([{ id: "x" }]);
    });
    expect((await ep.credentials()).length).toBe(1);
    expect((await ep.accessLog(500)).length).toBe(1);
    expect(calls[calls.length - 1].url).toContain("limit=200");
    expect((await ep.friends()).length).toBe(1);
    expect((await ep.schedules()).length).toBe(1);
    const conn = await ep.connections();
    expect(conn.providers.length).toBe(1);
    expect(conn.connections).toEqual([]);
  });

  test("messages → bare array sorted oldest → newest", async () => {
    const ep = await import("../src/api/endpoints");
    mockFetch(() => json([{ ...msg("b", "t", "assistant", "2"), createdAt: 2 }, { ...msg("a", "t", "user", "1"), createdAt: 1 }]));
    const page = await ep.messages("t", { limit: 50 });
    expect(page.messages.map((m) => m.id)).toEqual(["a", "b"]);
    expect(page.hasMore).toBe(false);
  });
});

describe("approvals", () => {
  test("approve sends {decision, signature, nonce, deviceId}: nonce is a UUID, signature verifies over approve:<id>:<nonce>", async () => {
    const ep = await import("../src/api/endpoints");
    const { getOrCreateDeviceKey } = await import("@pickle/vault/client");
    const calls = mockFetch(() => sse([`data: ${JSON.stringify({ type: "start", threadId: "t", userMessage: null, messageId: "a" })}\n\n`]));
    await ep.approve("ap_123", "approve", { onEvent: () => {} });
    const c = calls[0];
    expect(c.url).toContain("/api/approvals/ap_123");
    const b = c.body as { decision: string; signature: string; nonce: string; deviceId: string };
    expect(b.decision).toBe("approve");
    expect(b.nonce).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(b.signature).toMatch(/^[A-Za-z0-9_-]{86}$/); // 64-byte IEEE P1363, base64url, no padding
    const key = await getOrCreateDeviceKey();
    expect(b.deviceId).toBe(key.id);
    expect("d" in key.publicJwk).toBe(false);
    const pub = await crypto.subtle.importKey("jwk", key.publicJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    const sig = Uint8Array.from(atob(b.signature.replace(/-/g, "+").replace(/_/g, "/")), (ch) => ch.charCodeAt(0));
    const ok = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pub, sig, new TextEncoder().encode(`approve:ap_123:${b.nonce}`));
    expect(ok).toBe(true);
  });

  test("410 approval_expired → card flips to expired, message shown", async () => {
    const { decideApproval, messagesStore, appendMessage } = await import("../src/api/store");
    const { island } = await import("../src/app/island");
    appendMessage("ap", { ...msg("m1", "ap", "assistant", "보낼까요?"), cards: [{ type: "approval", approvalId: "ap_9", title: "메일 보내기", detail: "x", status: "pending" }] } as never);
    mockFetch(() => json({ error: "approval_expired", message: "승인 시간이 지났어요" }, 410));
    const res = await decideApproval("ap", "ap_9", "approve");
    expect(res.ok).toBe(false);
    expect(res.error?.message).toBe("승인 시간이 지났어요");
    const card = messagesStore.get().ap.items[0].cards[0] as { status: string };
    expect(card.status).toBe("expired");
    island.dismissBanner();
  });
});

describe("connections", () => {
  test("display_code: poll POST /verify {} until connected", async () => {
    const { pollConnection, connectionsStore } = await import("../src/api/store");
    let n = 0;
    const calls = mockFetch(() => {
      n++;
      const status = n < 3 ? "needs_verification" : "connected";
      return json({ connection: { provider: "kakaotalk", status, accountLabel: null, credentialId: null, lastError: null, connectedAt: null, updatedAt: n } });
    });
    const seen: string[] = [];
    const c = await pollConnection("kakaotalk", (x) => seen.push(x.status), { intervalMs: 5 });
    expect(c.status).toBe("connected");
    expect(seen).toEqual(["needs_verification", "needs_verification", "connected"]);
    expect(calls.every((x) => x.method === "POST" && x.url.endsWith("/api/connections/kakaotalk/verify"))).toBe(true);
    expect(calls[0].body).toEqual({});
    expect(connectionsStore.get().connections.find((x) => x.provider === "kakaotalk")?.status).toBe("connected");
  });

  test("display_code: aborting stops the poll", async () => {
    const { pollConnection } = await import("../src/api/store");
    mockFetch(() => json({ connection: { provider: "line", status: "needs_verification", accountLabel: null, credentialId: null, lastError: null, connectedAt: null, updatedAt: 1 } }));
    const ctrl = new AbortController();
    const p = pollConnection("line", () => ctrl.abort(), { intervalMs: 5, signal: ctrl.signal });
    let err: unknown;
    try {
      await p;
    } catch (e) {
      err = e;
    }
    expect((err as { code: string }).code).toBe("aborted");
  });

  test("enter_code sends {code}", async () => {
    const { submitConnectionCode } = await import("../src/api/store");
    const calls = mockFetch(() => json({ connection: { provider: "instagram", status: "connected", accountLabel: "me", credentialId: null, lastError: null, connectedAt: 1, updatedAt: 1 } }));
    await submitConnectionCode("instagram", "123456");
    expect(calls[0].body).toEqual({ code: "123456" });
  });
});

describe("token URLs", () => {
  test("events / attachments / blobs carry ?token=", async () => {
    const { setToken, clearToken } = await import("../src/api/client");
    const ep = await import("../src/api/endpoints");
    setToken("tok en");
    expect(ep.eventsUrl()).toBe("/api/events?token=tok%20en");
    expect(ep.attachmentUrl("at_1")).toBe("/api/attachments/at_1/raw?token=tok%20en");
    expect(ep.blobUrl("ar_1")).toBe("/api/blobs/ar_1?token=tok%20en");
    expect(ep.authedUrl("/api/attachments/at_2/raw")).toBe("/api/attachments/at_2/raw?token=tok%20en");
    clearToken();
    expect(ep.eventsUrl()).toBeNull();
  });
});
