import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { AttachmentRef, ID, Message } from "@pickle/protocol";

/**
 * A send with files that the server refuses before its turn starts (429 the day's quota, 5xx, no model key) keeps its
 * bubble as failed WITH its files, and 다시 보내기 sends the same attachment ids again (DD 0121): a long text sent as a
 * .txt has no text of its own, so a bubble without its file was an empty pill, and 다시 보내기 sent nothing at all and
 * dropped the bubble — the text was gone. A photo sent alone took the same path. The island's 다시 시도 after a turn's
 * error sends the line's files too.
 * Drives the real store through a fake fetch (no server). bun runs every test file in one process: the file starts and
 * ends with resetSession.
 */

const realFetch = globalThis.fetch;
let at = 1_900_000_000_000;
const row = (threadId: ID, id: ID, role: Message["role"], text: string, attachments: AttachmentRef[] = []): Message => ({ id, threadId, role, text, cards: [], tools: [], attachments, createdAt: ++at });
const enc = new TextEncoder();
const sse = (e: unknown) => enc.encode(`data: ${JSON.stringify(e)}\n\n`);
const ref = (id: ID, filename: string, mime: string, size: number): AttachmentRef => ({ id, filename, mime, size, url: `/api/attachments/${id}/raw` });
const TXT = ref("f_txt1", "긴 메모 하나.txt", "text/plain", 12_480);
const PHOTO = ref("f_img1", "IMG_0412.jpg", "image/jpeg", 812_000);

/** POST bodies, in order */
const posts: { threadId: string; text: string; attachmentIds?: ID[] }[] = [];
/** the next POST answers: an error status (code, message) or a turn that streams start → done, or start → error */
const answers: ({ status: number; error: string; message: string } | { ok: ID } | { failsMidway: ID })[] = [];

const json = (v: unknown, status: number) => new Response(JSON.stringify(v), { status, headers: { "Content-Type": "application/json" } });
const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  const m = /\/api\/threads\/([^/?]+)\/messages/.exec(url);
  if (m && (init?.method ?? "GET") === "GET") return json([], 200);
  if (m && init?.method === "POST") {
    const threadId = decodeURIComponent(m[1]!);
    const body = JSON.parse(String(init.body)) as { text: string; attachmentIds?: ID[] };
    posts.push({ threadId, text: body.text, attachmentIds: body.attachmentIds });
    const a = answers.shift();
    if (!a) return json({ error: "no_answer", message: "no answer queued" }, 500);
    if ("status" in a) return json({ error: a.error, message: a.message }, a.status);
    const id = "ok" in a ? a.ok : a.failsMidway;
    const files = [TXT, PHOTO].filter((f) => body.attachmentIds?.includes(f.id));
    const um = row(threadId, id, "user", body.text, files);
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(sse({ type: "start", threadId, userMessage: um, messageId: `${id}_a` }));
        if ("ok" in a) c.enqueue(sse({ type: "done", message: row(threadId, `${id}_a`, "assistant", "받았어요") }));
        else c.enqueue(sse({ type: "error", error: "upstream_rate_limited", message: "지금 요청이 많아요. 잠시 후 다시 시도해 주세요." }));
        c.close();
      },
    });
    return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
  }
  return json({}, 200);
}) as unknown as typeof fetch;

const store = () => import("../src/api/store");
const isl = () => import("../src/app/island");
const T = "t_files";
const thread = async () => (await store()).messagesStore.get()[T]!;

beforeAll(async () => {
  const { resetSession } = await store();
  const { island } = await isl();
  resetSession();
  island.clearBanners();
  globalThis.fetch = fakeFetch;
  const { setToken } = await import("../src/api/client");
  setToken("qa-token");
});
afterEach(async () => {
  posts.length = 0;
  answers.length = 0;
  const { resetSession } = await store();
  const { setToken } = await import("../src/api/client");
  resetSession();
  setToken("qa-token");
  (await isl()).island.clearBanners();
});
afterAll(async () => {
  const { resetSession } = await store();
  resetSession();
  (await isl()).island.clearBanners();
  globalThis.fetch = realFetch;
});

describe("a send with files refused before its turn (DD 0121)", () => {
  for (const [label, err] of [
    ["503 no model key", { status: 503, error: "llm_not_configured", message: "AI 서버 설정이 아직 안 됐어요. 관리자에게 알려 주세요." }],
    ["429 the day's quota", { status: 429, error: "quota_exceeded", message: "오늘 쓸 수 있는 양을 다 썼어요." }],
  ] as const) {
    test(`a long text sent as its .txt alone, ${label}: the failed bubble keeps the file; 다시 보내기 posts the same id once (text ""), and the answer replaces the bubble`, async () => {
      const { loadMessages, sendMessage, retryMessage } = await store();
      await loadMessages(T);
      answers.push(err);
      const r = await sendMessage(T, "", { attachmentIds: [TXT.id], attachments: [TXT] });
      expect(r.status).toBe("failed");
      expect(r.keepText).toBe(false);
      let t = await thread();
      expect(t.failed.length).toBe(1);
      const failed = t.items.find((m) => m.id === t.failed[0])!;
      expect(failed.text).toBe("");
      expect(failed.attachments).toEqual([TXT]);
      expect(t.error).toBe(err.message);
      expect(posts).toEqual([{ threadId: T, text: "", attachmentIds: [TXT.id] }]);

      answers.push({ ok: "m_long1" });
      const again = await retryMessage(T, failed.id);
      expect(again.status).toBe("done");
      expect(posts.length).toBe(2);
      expect(posts[1]).toEqual({ threadId: T, text: "", attachmentIds: [TXT.id] });
      t = await thread();
      expect(t.failed).toEqual([]);
      expect(t.items.some((m) => m.id === failed.id)).toBe(false);
      const sent = t.items.find((m) => m.id === "m_long1")!;
      expect(sent.attachments.map((a) => a.id)).toEqual([TXT.id]);
      expect(t.items.filter((m) => m.role === "user").length).toBe(1);
    });
  }

  test("a photo sent alone, 429: the same — the failed bubble shows the photo, 다시 보내기 posts its id", async () => {
    const { loadMessages, sendMessage, retryMessage } = await store();
    await loadMessages(T);
    answers.push({ status: 429, error: "quota_exceeded", message: "오늘 쓸 수 있는 양을 다 썼어요." });
    await sendMessage(T, "", { attachmentIds: [PHOTO.id], attachments: [PHOTO] });
    const t = await thread();
    const failed = t.items.find((m) => m.id === t.failed[0])!;
    expect(failed.attachments).toEqual([PHOTO]);
    answers.push({ ok: "m_photo1" });
    await retryMessage(T, failed.id);
    expect(posts[1]).toEqual({ threadId: T, text: "", attachmentIds: [PHOTO.id] });
    expect((await thread()).failed).toEqual([]);
  });

  test("refused again on 다시 보내기: the bubble keeps the file through the second failure too, and the third press posts the same id", async () => {
    const { loadMessages, sendMessage, retryMessage } = await store();
    await loadMessages(T);
    const quota = { status: 429, error: "quota_exceeded", message: "오늘 쓸 수 있는 양을 다 썼어요." };
    answers.push(quota);
    await sendMessage(T, "", { attachmentIds: [TXT.id], attachments: [TXT] });
    let t = await thread();
    const first = t.items.find((m) => m.id === t.failed[0])!;
    answers.push(quota);
    const second = await retryMessage(T, first.id);
    expect(second.status).toBe("failed");
    t = await thread();
    expect(t.failed.length).toBe(1);
    const again = t.items.find((m) => m.id === t.failed[0])!;
    expect(again.attachments).toEqual([TXT]);
    expect(t.items.filter((m) => m.role === "user").length).toBe(1);
    answers.push({ ok: "m_third1" });
    await retryMessage(T, again.id);
    expect(posts.map((p) => p.attachmentIds)).toEqual([[TXT.id], [TXT.id], [TXT.id]]);
    expect(posts.map((p) => p.text)).toEqual(["", "", ""]);
    t = await thread();
    expect(t.failed).toEqual([]);
    expect(t.items.find((m) => m.id === "m_third1")!.attachments.map((a) => a.id)).toEqual([TXT.id]);
  });

  test("text with files: both go again, the files in the order they went", async () => {
    const { loadMessages, sendMessage, retryMessage } = await store();
    await loadMessages(T);
    answers.push({ status: 503, error: "llm_not_configured", message: "AI 서버 설정이 아직 안 됐어요." });
    await sendMessage(T, "이거 봐 줘", { attachmentIds: [PHOTO.id, TXT.id], attachments: [TXT, PHOTO] });
    const t = await thread();
    const failed = t.items.find((m) => m.id === t.failed[0])!;
    expect(failed.text).toBe("이거 봐 줘");
    expect(failed.attachments.map((a) => a.id)).toEqual([PHOTO.id, TXT.id]);
    answers.push({ ok: "m_both1" });
    await retryMessage(T, failed.id);
    expect(posts[1]).toEqual({ threadId: T, text: "이거 봐 줘", attachmentIds: [PHOTO.id, TXT.id] });
  });

  test("an id sent without its ref still goes (the bubble draws what it knows)", async () => {
    const { loadMessages, sendMessage } = await store();
    await loadMessages(T);
    answers.push({ status: 503, error: "llm_not_configured", message: "x" });
    await sendMessage(T, "", { attachmentIds: [TXT.id] });
    expect(posts[0]!.attachmentIds).toEqual([TXT.id]);
    const t = await thread();
    expect(t.items.find((m) => m.id === t.failed[0])!.attachments).toEqual([]);
  });
});

describe("the island's 다시 시도 after a turn's error sends the line's files too", () => {
  test("a .txt line whose turn errors after the server took it: 다시 시도 posts the same id (text \"\")", async () => {
    const { loadMessages, sendMessage } = await store();
    const { island, islandStore } = await isl();
    await loadMessages(T);
    answers.push({ failsMidway: "m_mid1" });
    await sendMessage(T, "", { attachmentIds: [TXT.id], attachments: [TXT] });
    expect(islandStore.get().kind).toBe("error");
    answers.push({ ok: "m_mid2" });
    island.press();
    for (let i = 0; i < 20 && posts.length < 2; i++) await new Promise((r) => setTimeout(r, 5));
    expect(posts.length).toBe(2);
    expect(posts[1]).toEqual({ threadId: T, text: "", attachmentIds: [TXT.id] });
  });

  test("a turn_error on a line with two files, one since taken out of the archive: 다시 시도 posts only the one still there (lead 0254)", async () => {
    const { loadMessages, sendMessage, appendMessage, failRemoteTurn } = await store();
    const { island, islandStore } = await isl();
    await loadMessages(T);
    answers.push({ ok: "m_two1" });
    await sendMessage(T, "이거 봐 줘", { attachmentIds: [PHOTO.id, TXT.id], attachments: [PHOTO, TXT] });
    const line = (await thread()).items.find((m) => m.id === "m_two1")!;
    expect(line.attachments.map((a) => a.id).sort()).toEqual([PHOTO.id, TXT.id].sort());
    // the archive deleted the .txt: the server sends the line again with it marked (url "", deleted)
    appendMessage(T, { ...line, attachments: [PHOTO, { ...TXT, url: "", deleted: true }] });
    expect(failRemoteTurn(T, "upstream_rate_limited", "지금 요청이 많아요. 잠시 후 다시 시도해 주세요.")).toBe(true);
    expect(islandStore.get().kind).toBe("error");
    answers.push({ ok: "m_two2" });
    island.press();
    for (let i = 0; i < 20 && posts.length < 2; i++) await new Promise((r) => setTimeout(r, 5));
    expect(posts.length).toBe(2);
    expect(posts[1]).toEqual({ threadId: T, text: "이거 봐 줘", attachmentIds: [PHOTO.id] });
  });
});
