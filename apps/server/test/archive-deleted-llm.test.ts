/**
 * H2: a document or file deleted from the archive leaves the model's copy of the conversation too (llm_json), in the
 * same transaction as H's marked cards. A document: the turn that made it keeps its sys_create_artifact call and result
 * as a pair (found by the result's data.artifactId), the call's arguments without `content`, the result saying it was
 * deleted. A file: the message that sent it gets its files' notes made again (the deleted one as deleted), the text
 * before and anything after kept. Nothing else changes: other calls, other files, rows without that id, the visible
 * answer, and every byte of the history before the changed row (the provider's prompt cache).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LlmMessage, LlmToolCall } from "@pickle/agent";
import type { AgentEvent, ApprovalCard, ArtifactCard, Attachment, Card, Message } from "@pickle/protocol";
import { fileText } from "../src/archive.ts";
import { makeHarness, outcome, readSse, type Harness } from "./helpers.ts";

let h: Harness;
beforeEach(async () => {
  h = await makeHarness();
});
afterEach(async () => {
  await h.close();
});

type Me = { token: string; session: { user: { id: string }; mainThreadId: string } };
const SECRET = "비밀메모-7Q3: 강남역 3번 출구 앞 카페, 예약 번호 4417";
const DELETED_SUMMARY = "사용자가 보관함에서 이 문서를 지웠어요. 내용은 남아 있지 않아요.";

let seq = 0;
function artifact(owner: Me, id: string, title: string): ArtifactCard {
  h.db.insertArtifact({ id, userId: owner.session.user.id, threadId: owner.session.mainThreadId, title, kind: "document", content: SECRET, now: h.clock.t });
  return { type: "artifact", artifactId: id, title, kind: "document", preview: "미리보기" };
}
function row(threadId: string, role: "user" | "assistant", text: string, llm: LlmMessage[] | null, extra: { cards?: Card[]; authorUserId?: string } = {}): string {
  const id = `m_${++seq}`;
  h.db.insertMessage({ id, threadId, role, text, cards: extra.cards, llm, authorUserId: extra.authorUserId ?? null, authorKind: extra.authorUserId ? "agent" : null, createdAt: h.clock.t + seq });
  return id;
}
const call = (id: string, args: Record<string, unknown>): LlmToolCall => ({ id, type: "function", function: { name: "sys_create_artifact", arguments: JSON.stringify(args) } });
const result = (callId: string, artifactId: string, title: string): LlmMessage => ({
  role: "tool",
  tool_call_id: callId,
  content: JSON.stringify({ ok: true, summary: `'${title}' 문서를 저장했어요`, data: { artifactId, title, kind: "document" } }),
});
/** a turn that made two documents (a_doc with SECRET, a_keep) and answered about them */
function madeTwo(me: Me): { rowId: string; llm: LlmMessage[] } {
  const doc = artifact(me, "a_doc", "저녁 후보");
  const keep = artifact(me, "a_keep", "준비물");
  const llm: LlmMessage[] = [
    { role: "assistant", content: null, tool_calls: [call("call_doc", { title: "저녁 후보", kind: "document", content: SECRET }), call("call_keep", { title: "준비물", kind: "document", content: "- 우산" })] },
    result("call_doc", "a_doc", "저녁 후보"),
    result("call_keep", "a_keep", "준비물"),
    { role: "assistant", content: "아래 문서 두 개에 정리했어요." },
  ];
  return { rowId: row(me.session.mainThreadId, "assistant", "아래 문서 두 개에 정리했어요.", llm, { cards: [doc, keep] }), llm };
}
const LIVE_CARD: ArtifactCard = { type: "artifact", artifactId: "a_live", title: "저녁 후보", kind: "document", preview: "미리보기" };
const llmOf = (id: string) => JSON.parse(h.db.getMessage(id)!.llm_json ?? "null") as LlmMessage[] | null;
async function turn(me: Me, text = "다음 거 알려줘"): Promise<LlmMessage[]> {
  await readSse(await h.req("POST", `/api/threads/${me.session.mainThreadId}/messages`, { token: me.token, body: { text } }));
  return h.turns.inputs.at(-1)!.history;
}
async function upload(token: string, name: string, body: BlobPart, type = "text/plain"): Promise<Attachment> {
  const form = new FormData();
  form.set("file", new File([body], name, { type }));
  const res = await h.req("POST", "/api/attachments", { token, raw: form });
  expect(res.status).toBe(201);
  return (await res.json()) as Attachment;
}
const del = (token: string, what: "artifacts" | "attachments", id: string) => h.req("DELETE", `/api/${what}/${id}`, { token });
/** the notes the send path made before H2 (threads.ts at 1835ad3: each small text file read with Bun.file().text()) */
async function notesBeforeH2(uid: string, atts: Attachment[]): Promise<string> {
  const notes: string[] = [];
  for (const a of atts) {
    if (a.mime === "text/plain" && a.size <= 8 * 1024) notes.push(`[첨부: ${a.filename}]\n${await Bun.file(join(h.dir, "attachments", uid, a.id)).text()}`);
    else notes.push(`[첨부: ${a.filename} (${a.mime}, ${Math.ceil(a.size / 1024)}KB) — 내용은 볼 수 없어요]`);
  }
  return notes.join("\n");
}
const bytes = (...parts: (number[] | string)[]) => new Uint8Array(parts.flatMap((p) => (typeof p === "string" ? [...new TextEncoder().encode(p)] : p)));
const utf16le = (s: string) => Array.from({ length: s.length }, (_, i) => s.charCodeAt(i)).flatMap((c) => [c & 255, c >> 8]);
/** text files whose bytes Bun.file().text() reads in its own way */
const ODD_FILES: [string, Uint8Array<ArrayBuffer>][] = [
  ["bom.txt", bytes([0xef, 0xbb, 0xbf], "메모\r\n둘째 줄 😀")],
  ["utf16.txt", bytes([0xff, 0xfe], utf16le("메모장 유니코드 😀\r\n"))], // Notepad's "Unicode"
  ["utf16-odd.txt", bytes([0xff, 0xfe], utf16le("AB"), [0x00, 0xd8], [0x43])], // a lone surrogate, an odd last byte
  ["bad.txt", bytes("A", [0xff, 0xfe, 0xc3, 0x28, 0xed, 0xa0, 0x80, 0xf0, 0x9f, 0x98], "B")],
  ["ff-fe.txt", bytes([0xff, 0xfe])],
  ["bom-bom.txt", bytes([0xef, 0xbb, 0xbf, 0xef, 0xbb, 0xbf], "A")],
];

describe("a deleted document in the model's copy", () => {
  test("the next turn's history has none of its content; its call and result stay a pair (arguments without content, result deleted); the other document's call, the answer and every message before that row are byte for byte the same", async () => {
    const me = (await h.signup("alice")) as Me;
    row(me.session.mainThreadId, "user", "안녕", [{ role: "user", content: "안녕" }]);
    row(me.session.mainThreadId, "assistant", "안녕하세요", [{ role: "assistant", content: "안녕하세요" }]);
    row(me.session.mainThreadId, "user", "정리해줘", [{ role: "user", content: "정리해줘" }]);
    const { llm } = madeTwo(me);
    const before = await turn(me, "고마워");
    expect(JSON.stringify(before)).toContain(SECRET);
    const at = before.findIndex((m) => m.role === "assistant" && !!m.tool_calls?.length);
    expect(at).toBeGreaterThanOrEqual(3); // the three rows above (and the main thread's greeting) come first

    expect((await del(me.token, "artifacts", "a_doc")).status).toBe(200);
    const after = await turn(me);
    expect(JSON.stringify(after)).not.toContain(SECRET);
    expect(JSON.stringify(after.slice(0, at))).toBe(JSON.stringify(before.slice(0, at)));
    const calls = after[at]!.role === "assistant" ? after[at]!.tool_calls! : [];
    expect(calls.map((c) => [c.id, c.function.name])).toEqual([["call_doc", "sys_create_artifact"], ["call_keep", "sys_create_artifact"]]);
    expect(JSON.parse(calls[0]!.function.arguments)).toEqual({ title: "저녁 후보", kind: "document" });
    expect(calls[1]).toEqual(llm[0]!.role === "assistant" ? llm[0]!.tool_calls![1]! : (null as never));
    expect(after[at + 1]).toMatchObject({ role: "tool", tool_call_id: "call_doc" });
    expect(JSON.parse((after[at + 1] as { content: string }).content)).toEqual({ ok: true, summary: DELETED_SUMMARY, data: { artifactId: "a_doc", title: "저녁 후보", kind: "document" }, deleted: true });
    expect(after[at + 2]).toEqual(llm[2]!);
    expect(after[at + 3]).toEqual({ role: "assistant", content: "아래 문서 두 개에 정리했어요." });
  });

  test("a deleted HTML card's call (no content now) is not taken for a design-guide call when replayed: its result still says deleted, a real guide call's result is still shortened", async () => {
    const me = (await h.signup("alice")) as Me;
    h.db.insertArtifact({ id: "a_html", userId: me.session.user.id, threadId: me.session.mainThreadId, title: "주말 일정", kind: "html", content: `<div>${SECRET}</div>`, now: h.clock.t });
    const card: ArtifactCard = { type: "artifact", artifactId: "a_html", title: "주말 일정", kind: "html", preview: "" };
    const htmlCall = (id: string, content: string): LlmToolCall => ({ id, type: "function", function: { name: "sys_create_artifact", arguments: JSON.stringify({ title: "주말 일정", kind: "html", content }) } });
    const guide = JSON.stringify({ ok: true, summary: "가이드예요", data: { guide: "긴 가이드" } });
    row(me.session.mainThreadId, "user", "주말 일정 화면으로 보여줘", [{ role: "user", content: "주말 일정 화면으로 보여줘" }]);
    const rowId = row(me.session.mainThreadId, "assistant", "화면으로 만들었어요.", [
      { role: "assistant", content: null, tool_calls: [htmlCall("call_guide", "")] },
      { role: "tool", tool_call_id: "call_guide", content: guide },
      { role: "assistant", content: null, tool_calls: [htmlCall("call_html", `<div>${SECRET}</div>`)] },
      { role: "tool", tool_call_id: "call_html", content: JSON.stringify({ ok: true, summary: "'주말 일정' 화면을 저장했어요", data: { artifactId: "a_html", title: "주말 일정", kind: "html" } }) },
      { role: "assistant", content: "화면으로 만들었어요." },
    ], { cards: [card] });
    row(me.session.mainThreadId, "user", "고마워", [{ role: "user", content: "고마워" }]); // a later turn: the card's turn is an older one
    row(me.session.mainThreadId, "assistant", "네", [{ role: "assistant", content: "네" }]);
    expect((await del(me.token, "artifacts", "a_html")).status).toBe(200);
    const made = llmOf(rowId)![2]!;
    expect(made.role === "assistant" && JSON.parse(made.tool_calls![0]!.function.arguments)).toEqual({ title: "주말 일정", kind: "html" });
    const history = await turn(me);
    expect(JSON.stringify(history)).not.toContain(SECRET);
    const results = Object.fromEntries(history.filter((m) => m.role === "tool").map((m) => [m.tool_call_id, JSON.parse(m.content as string)]));
    expect(results.call_html).toMatchObject({ summary: DELETED_SUMMARY, deleted: true, data: { artifactId: "a_html" } });
    expect(results.call_guide.summary).toBe("화면 가이드를 확인했어요"); // an older turn's guide call, shortened as before
  });

  test("rows whose model copy holds no call for it stay as they were: the card shown again in a friend thread, a turn paused for approval (its messages ride with the approval, not changed here), a row with no model copy", async () => {
    const me = (await h.signup("alice")) as Me;
    const friend = (await h.signup("bob")) as Me;
    const inv = (await (await h.req("POST", "/api/invites", { token: me.token })).json()) as { token: string };
    const ab = (await (await h.req("POST", `/api/invites/${inv.token}/accept`, { token: friend.token })).json()) as { threadId: string };
    const doc = artifact(me, "a_doc", "저녁 후보");
    const shown = row(ab.threadId, "assistant", "세 곳 골랐어요", [{ role: "assistant", content: "세 곳 골랐어요" }], { cards: [doc], authorUserId: me.session.user.id });
    const paused = row(me.session.mainThreadId, "assistant", "보내기 전에 확인해 주세요", [], { cards: [doc] });
    const bare = row(me.session.mainThreadId, "assistant", "정리했어요", null, { cards: [doc] });
    const was = [shown, paused, bare].map((id) => h.db.getMessage(id)!.llm_json);
    expect((await del(me.token, "artifacts", "a_doc")).status).toBe(200);
    expect([shown, paused, bare].map((id) => h.db.getMessage(id)!.llm_json)).toEqual(was);
    expect([shown, paused, bare].map((id) => (JSON.parse(h.db.getMessage(id)!.cards_json) as ArtifactCard[])[0]!.deleted)).toEqual([true, true, true]);
  });

  test("unreadable call arguments are dropped whole; a result for another document with the same title is left alone", async () => {
    const me = (await h.signup("alice")) as Me;
    const doc = artifact(me, "a_doc", "같은 제목");
    const llm: LlmMessage[] = [
      { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "sys_create_artifact", arguments: `{"title":"같은 제목","content":"${SECRET}` } }] },
      result("c1", "a_doc", "같은 제목"),
      { role: "assistant", content: null, tool_calls: [call("c2", { title: "같은 제목", kind: "document", content: "다른 문서" })] },
      result("c2", "a_twin", "같은 제목"),
      { role: "assistant", content: "두 개 만들었어요" },
    ];
    const id = row(me.session.mainThreadId, "assistant", "두 개 만들었어요", llm, { cards: [doc] });
    expect((await del(me.token, "artifacts", "a_doc")).status).toBe(200);
    const now = llmOf(id)!;
    expect(now[0]!.role === "assistant" && now[0]!.tool_calls![0]!.function.arguments).toBe("{}");
    expect(now.slice(2)).toEqual(llm.slice(2));
  });
});

describe("a deleted file in the model's copy", () => {
  test("sent with the message (two text files, one image): the deleted text file's content is gone from the next turn's history, its note says deleted; the other text file and the image note stay; the text before is the same", async () => {
    const me = (await h.signup("alice")) as Me;
    const a = await upload(me.token, "메모.txt", SECRET);
    const b = await upload(me.token, "목록.txt", "우산\n충전기");
    const img = await upload(me.token, "사진.png", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]), "image/png");
    await readSse(await h.req("POST", `/api/threads/${me.session.mainThreadId}/messages`, { token: me.token, body: { text: "이거 정리해줘", attachmentIds: [a.id, b.id, img.id] } }));
    const sent = h.turns.inputs.at(-1)!.userText!;
    expect(sent).toBe(`이거 정리해줘\n\n[첨부: 메모.txt]\n${SECRET}\n[첨부: 목록.txt]\n우산\n충전기\n[첨부: 사진.png (image/png, 1KB) — 내용은 볼 수 없어요]`);

    expect((await del(me.token, "attachments", a.id)).status).toBe(200);
    const history = await turn(me);
    expect(JSON.stringify(history)).not.toContain(SECRET);
    const user = history.find((m) => m.role === "user" && typeof m.content === "string" && m.content.startsWith("이거 정리해줘"))!;
    expect(user.content).toBe(`이거 정리해줘\n\n[첨부: 메모.txt — 보관함에서 지운 파일이라 내용이 없어요]\n[첨부: 목록.txt]\n우산\n충전기\n[첨부: 사진.png (image/png, 1KB) — 내용은 볼 수 없어요]`);
  });

  test("a deleted image or PDF (never inlined): its note becomes the deleted-file note in the next turn's history; the text file's note stays (DD 0130 F3)", async () => {
    const me = (await h.signup("alice")) as Me;
    const img = await upload(me.token, "사진.png", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]), "image/png");
    const pdf = await upload(me.token, "표.pdf", new TextEncoder().encode("%PDF-1.4\n%%EOF\n"), "application/pdf");
    const txt = await upload(me.token, "목록.txt", "우산");
    await readSse(await h.req("POST", `/api/threads/${me.session.mainThreadId}/messages`, { token: me.token, body: { text: "이거 봐줘", attachmentIds: [img.id, pdf.id, txt.id] } }));
    expect((await del(me.token, "attachments", img.id)).status).toBe(200);
    expect((await del(me.token, "attachments", pdf.id)).status).toBe(200);
    const history = await turn(me);
    const user = history.find((m) => m.role === "user" && typeof m.content === "string" && m.content.startsWith("이거 봐줘"))!;
    expect(user.content).toBe("이거 봐줘\n\n[첨부: 사진.png — 보관함에서 지운 파일이라 내용이 없어요]\n[첨부: 표.pdf — 보관함에서 지운 파일이라 내용이 없어요]\n[첨부: 목록.txt]\n우산");
  });

  test("two files with the same name and the same text: only the deleted one's note changes; anything after the notes (a template hint) is kept", async () => {
    const me = (await h.signup("alice")) as Me;
    const one = await upload(me.token, "메모.txt", "같은 내용");
    const two = await upload(me.token, "메모.txt", "같은 내용");
    const refs = [one, two].map((x) => ({ id: x.id, filename: x.filename, mime: x.mime, size: x.size, url: x.url }));
    const content = "봐줘\n\n[첨부: 메모.txt]\n같은 내용\n[첨부: 메모.txt]\n같은 내용\n\n(둘러보기 안내)";
    const id = `m_${++seq}`;
    h.db.insertMessage({ id, threadId: me.session.mainThreadId, role: "user", text: "봐줘", attachments: refs, llm: [{ role: "user", content }], createdAt: h.clock.t + seq });
    expect((await del(me.token, "attachments", two.id)).status).toBe(200);
    expect(llmOf(id)).toEqual([{ role: "user", content: "봐줘\n\n[첨부: 메모.txt]\n같은 내용\n[첨부: 메모.txt — 보관함에서 지운 파일이라 내용이 없어요]\n\n(둘러보기 안내)" }]);
  });

  test("the deleted text file starts with a BOM: the copy was made without it (as Bun.file().text() reads), and its text is still found and replaced", async () => {
    const me = (await h.signup("alice")) as Me;
    const a = await upload(me.token, "메모.txt", new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(SECRET)]));
    const b = await upload(me.token, "목록.txt", "우산");
    const refs = [a, b].map((x) => ({ id: x.id, filename: x.filename, mime: x.mime, size: x.size, url: x.url }));
    const id = `m_${++seq}`;
    h.db.insertMessage({ id, threadId: me.session.mainThreadId, role: "user", text: "봐줘", attachments: refs, llm: [{ role: "user", content: `봐줘\n\n[첨부: 메모.txt]\n${SECRET}\n[첨부: 목록.txt]\n우산` }], createdAt: h.clock.t + seq });
    expect((await del(me.token, "attachments", a.id)).status).toBe(200);
    expect(llmOf(id)).toEqual([{ role: "user", content: "봐줘\n\n[첨부: 메모.txt — 보관함에서 지운 파일이라 내용이 없어요]\n[첨부: 목록.txt]\n우산" }]);
  });

  test("text files with a BOM and other odd bytes (UTF-16 from Notepad, bad UTF-8): the notes sent now are byte for byte the ones made before H2 with Bun.file().text()", async () => {
    const me = (await h.signup("alice")) as Me;
    const atts: Attachment[] = [];
    for (const [name, body] of ODD_FILES) atts.push(await upload(me.token, name, body));
    await readSse(await h.req("POST", `/api/threads/${me.session.mainThreadId}/messages`, { token: me.token, body: { text: "봐줘", attachmentIds: atts.map((a) => a.id) } }));
    const sent = h.turns.inputs.at(-1)!.userText!;
    expect(sent).toBe(`봐줘\n\n${await notesBeforeH2(me.session.user.id, atts)}`);
    expect(sent).toContain("\n[첨부: bom.txt]\n메모\r\n둘째 줄 😀\n[첨부: utf16.txt]\n메모장 유니코드 😀\r\n\n[첨부: utf16-odd.txt]\nAB\ud800\n");
  });

  test("an old row (notes made with Bun.file().text()) whose UTF-16 file from Notepad is deleted: its text leaves the model copy; the BOM file's note and the hint after stay", async () => {
    const me = (await h.signup("alice")) as Me;
    const u16 = await upload(me.token, "메모.txt", bytes([0xff, 0xfe], utf16le(SECRET)));
    const bom = await upload(me.token, "목록.txt", bytes([0xef, 0xbb, 0xbf], "우산"));
    const notes = await notesBeforeH2(me.session.user.id, [u16, bom]);
    expect(notes).toBe(`[첨부: 메모.txt]\n${SECRET}\n[첨부: 목록.txt]\n우산`);
    const refs = [u16, bom].map((x) => ({ id: x.id, filename: x.filename, mime: x.mime, size: x.size, url: x.url }));
    const id = `m_${++seq}`;
    h.db.insertMessage({ id, threadId: me.session.mainThreadId, role: "user", text: "봐줘", attachments: refs, llm: [{ role: "user", content: `봐줘\n\n${notes}\n\n(둘러보기 안내)` }], createdAt: h.clock.t + seq });
    expect((await del(me.token, "attachments", u16.id)).status).toBe(200);
    expect(llmOf(id)).toEqual([{ role: "user", content: "봐줘\n\n[첨부: 메모.txt — 보관함에서 지운 파일이라 내용이 없어요]\n[첨부: 목록.txt]\n우산\n\n(둘러보기 안내)" }]);
  });

  test("a row whose other text file was deleted before H (its note no longer made the same way): the deleted file's inlined text is still replaced, the other's left as it was", async () => {
    const me = (await h.signup("alice")) as Me;
    const old = await upload(me.token, "예전.txt", "예전 내용");
    const a = await upload(me.token, "메모.txt", SECRET);
    const refs = [old, a].map((x) => ({ id: x.id, filename: x.filename, mime: x.mime, size: x.size, url: x.url }));
    const id = `m_${++seq}`;
    h.db.insertMessage({ id, threadId: me.session.mainThreadId, role: "user", text: "봐줘", attachments: refs, llm: [{ role: "user", content: `봐줘\n\n[첨부: 예전.txt]\n예전 내용\n[첨부: 메모.txt]\n${SECRET}` }], createdAt: h.clock.t + seq });
    h.db.deleteAttachment(me.session.user.id, old.id); // deleted the old way: row and file gone, the ref and the copy untouched
    rmSync(join(h.dir, "attachments", me.session.user.id, old.id));
    expect((await del(me.token, "attachments", a.id)).status).toBe(200);
    expect(llmOf(id)).toEqual([{ role: "user", content: "봐줘\n\n[첨부: 예전.txt]\n예전 내용\n[첨부: 메모.txt — 보관함에서 지운 파일이라 내용이 없어요]" }]);
  });

  test("a copy not made the usual way: the deleted file's inlined text is replaced where it appears; a row with no model copy and a row whose copy never held the file stay as they were", async () => {
    const me = (await h.signup("alice")) as Me;
    const a = await upload(me.token, "메모.txt", SECRET);
    const ref = { id: a.id, filename: a.filename, mime: a.mime, size: a.size, url: a.url };
    const ids = ["other", "none", "never"].map(() => `m_${++seq}`);
    const t = me.session.mainThreadId;
    h.db.insertMessage({ id: ids[0]!, threadId: t, role: "user", text: "봐줘", attachments: [ref], llm: [{ role: "user", content: `(음성) 봐줘 [첨부: 메모.txt]\n${SECRET} 끝` }], createdAt: h.clock.t + 1 });
    h.db.insertMessage({ id: ids[1]!, threadId: t, role: "user", text: "봐줘", attachments: [ref], llm: null, createdAt: h.clock.t + 2 });
    h.db.insertMessage({ id: ids[2]!, threadId: t, role: "user", text: "봐줘", attachments: [ref], llm: [{ role: "user", content: "봐줘" }], createdAt: h.clock.t + 3 });
    const was = ids.map((id) => h.db.getMessage(id)!.llm_json);
    expect((await del(me.token, "attachments", a.id)).status).toBe(200);
    expect(llmOf(ids[0]!)).toEqual([{ role: "user", content: "(음성) 봐줘 [첨부: 메모.txt — 보관함에서 지운 파일이라 내용이 없어요] 끝" }]);
    expect(ids.slice(1).map((id) => h.db.getMessage(id)!.llm_json)).toEqual(was.slice(1));
  });
});

describe("a document deleted while the turn that made it still runs (its answer row is written when the turn ends)", () => {
  /** a turn that makes a_live (SECRET), then waits for `release` before it ends; `extra` goes into its outcome */
  function liveTurn(me: Me, extra: (llm: LlmMessage[]) => Record<string, unknown> = () => ({})) {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let made!: () => void;
    const madeP = new Promise<void>((r) => (made = r));
    h.turns.set(async (_input, emit) => {
      const doc = artifact(me, "a_live", "저녁 후보");
      emit({ type: "card", card: doc });
      made();
      await gate;
      const llm: LlmMessage[] = [
        { role: "assistant", content: null, tool_calls: [call("call_live", { title: "저녁 후보", kind: "document", content: SECRET })] },
        result("call_live", "a_live", "저녁 후보"),
        { role: "assistant", content: "정리했어요" },
      ];
      return { ...outcome("정리했어요", { cards: [doc] }), messages: llm, ...extra(llm) };
    });
    return { madeP, release };
  }

  test("the answer row goes in with the card already marked and the model copy without the content: the turn's done message, the page read and the next request agree", async () => {
    const me = (await h.signup("alice")) as Me;
    const { madeP, release } = liveTurn(me);
    const res = h.req("POST", `/api/threads/${me.session.mainThreadId}/messages`, { token: me.token, body: { text: "정리해줘" } });
    await madeP;
    expect((await del(me.token, "artifacts", "a_live")).status).toBe(200);
    release();
    const done = (await readSse(await res)).at(-1) as Extract<AgentEvent, { type: "done" }>;
    expect(done.type).toBe("done");
    const marked: ArtifactCard = { type: "artifact", artifactId: "a_live", title: "저녁 후보", kind: "document", preview: "", deleted: true };
    expect(done.message.cards).toEqual([marked]);
    const shown = ((await (await h.req("GET", `/api/threads/${me.session.mainThreadId}/messages`, { token: me.token })).json()) as Message[]).find((m) => m.id === done.message.id)!;
    expect(shown.cards).toEqual([marked]);
    const stored = llmOf(done.message.id)!;
    expect(JSON.stringify(stored)).not.toContain(SECRET);
    expect(stored[0]!.role === "assistant" && JSON.parse(stored[0]!.tool_calls![0]!.function.arguments)).toEqual({ title: "저녁 후보", kind: "document" });
    h.turns.set(async () => outcome("네"));
    expect(JSON.stringify(await turn(me))).not.toContain(SECRET);
  });

  test("a document still in the archive when the turn ends goes in as made: live card, content in the model copy", async () => {
    const me = (await h.signup("alice")) as Me;
    const { madeP, release } = liveTurn(me);
    const res = h.req("POST", `/api/threads/${me.session.mainThreadId}/messages`, { token: me.token, body: { text: "정리해줘" } });
    await madeP;
    release();
    const done = (await readSse(await res)).at(-1) as Extract<AgentEvent, { type: "done" }>;
    expect(done.message.cards).toEqual([LIVE_CARD]);
    expect(JSON.stringify(llmOf(done.message.id))).toContain(SECRET);
  });

  test("a turn that pauses for approval: the approval's messages lose it too", async () => {
    const me = (await h.signup("alice")) as Me;
    const send: LlmToolCall = { id: "call_send", type: "function", function: { name: "msg_send", arguments: "{}" } };
    const spec = { title: "보낼까요?", detail: "" };
    const { madeP, release } = liveTurn(me, (llm) => ({
      messages: [],
      cards: [{ type: "approval", approvalId: send.id, title: spec.title, detail: spec.detail, status: "pending" } satisfies ApprovalCard, LIVE_CARD],
      pendingApproval: { call: send, spec, messages: [...llm.slice(0, 2), { role: "assistant", content: null, tool_calls: [send] }] },
    }));
    const res = h.req("POST", `/api/threads/${me.session.mainThreadId}/messages`, { token: me.token, body: { text: "정리해서 보내줘" } });
    await madeP;
    expect((await del(me.token, "artifacts", "a_live")).status).toBe(200);
    release();
    const done = (await readSse(await res)).at(-1) as Extract<AgentEvent, { type: "done" }>;
    const approvalId = (done.message.cards.find((c) => c.type === "approval") as ApprovalCard).approvalId;
    const prior = JSON.parse(h.db.getApproval(me.session.user.id, approvalId)!.prior_messages_json) as LlmMessage[];
    expect(JSON.stringify(prior)).not.toContain(SECRET);
    expect(prior.map((m) => m.role)).toEqual(["assistant", "tool", "assistant"]);
    expect(JSON.parse((prior[1] as { content: string }).content)).toMatchObject({ deleted: true, data: { artifactId: "a_live" } });
    expect(done.message.cards.find((c) => c.type === "artifact")).toMatchObject({ deleted: true, preview: "" });
  });

  test("a turn going on after an approval decision ends through the same write: a document it made and the person deleted meanwhile is marked and leaves the answer's model copy (DD 0042-b)", async () => {
    const me = (await h.signup("alice")) as Me;
    const send: LlmToolCall = { id: "call_send", type: "function", function: { name: "msg_send", arguments: "{}" } };
    const spec = { title: "보낼까요?", detail: "" };
    h.turns.set(async () => ({
      ...outcome("보내기 전에 확인할게요.", { cards: [{ type: "approval", approvalId: send.id, title: spec.title, detail: spec.detail, status: "pending" } satisfies ApprovalCard] }),
      messages: [],
      pendingApproval: { call: send, spec, messages: [{ role: "assistant", content: "보내기 전에 확인할게요.", tool_calls: [send] }] },
    }));
    const paused = (await readSse(await h.req("POST", `/api/threads/${me.session.mainThreadId}/messages`, { token: me.token, body: { text: "정리해서 보내줘" } }))).at(-1) as Extract<AgentEvent, { type: "done" }>;
    const approvalId = (paused.message.cards.find((c) => c.type === "approval") as ApprovalCard).approvalId;
    const { madeP, release } = liveTurn(me);
    const res = h.req("POST", `/api/approvals/${approvalId}`, { token: me.token, body: { decision: "reject" } });
    await madeP;
    expect(h.turns.inputs.at(-1)!.resume?.decision).toBe("reject");
    expect((await del(me.token, "artifacts", "a_live")).status).toBe(200);
    release();
    const done = (await readSse(await res)).at(-1) as Extract<AgentEvent, { type: "done" }>;
    expect(done.type).toBe("done");
    expect(done.message.cards).toEqual([{ type: "artifact", artifactId: "a_live", title: "저녁 후보", kind: "document", preview: "", deleted: true }]);
    const stored = llmOf(done.message.id)!;
    expect(JSON.stringify(stored)).not.toContain(SECRET);
    expect(stored.map((m) => m.role)).toEqual(["assistant", "tool", "assistant"]);
  });

  test("an approval already waiting when the document is deleted keeps its messages as they were (not changed by a delete, the lead's call; 0041 §4)", async () => {
    const me = (await h.signup("alice")) as Me;
    const send: LlmToolCall = { id: "call_send", type: "function", function: { name: "msg_send", arguments: "{}" } };
    const spec = { title: "보낼까요?", detail: "" };
    const { madeP, release } = liveTurn(me, (llm) => ({
      messages: [],
      cards: [{ type: "approval", approvalId: send.id, title: spec.title, detail: spec.detail, status: "pending" } satisfies ApprovalCard],
      pendingApproval: { call: send, spec, messages: [...llm.slice(0, 2), { role: "assistant", content: null, tool_calls: [send] }] },
    }));
    const res = h.req("POST", `/api/threads/${me.session.mainThreadId}/messages`, { token: me.token, body: { text: "정리해서 보내줘" } });
    await madeP;
    release();
    const done = (await readSse(await res)).at(-1) as Extract<AgentEvent, { type: "done" }>;
    const approvalId = (done.message.cards.find((c) => c.type === "approval") as ApprovalCard).approvalId;
    const was = h.db.getApproval(me.session.user.id, approvalId)!.prior_messages_json;
    expect(was).toContain(SECRET);
    expect((await del(me.token, "artifacts", "a_live")).status).toBe(200);
    expect(h.db.getApproval(me.session.user.id, approvalId)!.prior_messages_json).toBe(was);
  });
});

test("fileText reads bytes as Bun.file().text() does: the odd files above, the short FF FE / EF BB BF edges, 400 seeded random byte strings", async () => {
  const edges = [[], [0xff], [0xff, 0xfe], [0xff, 0xfe, 0x41], [0xff, 0xfe, 0x41, 0x00], [0xff, 0xfe, 0x00, 0x00, 0x41, 0x00, 0x00, 0x00], [0xfe, 0xff, 0x00, 0x41], [0xef, 0xbb], [0xef, 0xbb, 0xbf]];
  const pool = [0x00, 0x41, 0x0a, 0x0d, 0x80, 0xbf, 0xc0, 0xc3, 0xdf, 0xe0, 0xea, 0xed, 0xef, 0xbb, 0xf0, 0xf4, 0xf5, 0xfe, 0xff, 0xa0, 0x9f, 0xd8, 0xdc];
  let x = 12345;
  const rnd = () => (x = (x * 1103515245 + 12345) >>> 0) / 2 ** 32;
  const random = Array.from({ length: 400 }, () => {
    const r = rnd();
    const head = r < 0.3 ? [0xff, 0xfe] : r < 0.5 ? [0xef, 0xbb, 0xbf] : [];
    return [...head, ...Array.from({ length: Math.floor(rnd() * 40) }, () => (rnd() < 0.7 ? pool[Math.floor(rnd() * pool.length)]! : Math.floor(rnd() * 256)))];
  });
  const cases = [...ODD_FILES.map(([, b]) => b), ...[...edges, ...random].map((b) => new Uint8Array(b))];
  mkdirSync(join(h.dir, "bytes"));
  const want: string[] = [];
  for (const [i, b] of cases.entries()) {
    const p = join(h.dir, "bytes", String(i));
    writeFileSync(p, b);
    want.push(await Bun.file(p).text());
  }
  expect(cases.map(fileText)).toEqual(want);
  expect(want.filter((s, i) => s !== new TextDecoder().decode(cases[i])).length).toBeGreaterThan(100); // UTF-16LE reads among them
});

test("one transaction with H: a failure while rewriting the model's copy leaves the document, the card and the copy as they were, with no event", async () => {
  const me = (await h.signup("alice")) as Me;
  const { rowId } = madeTwo(me);
  const before = [h.db.getMessage(rowId)!.cards_json, h.db.getMessage(rowId)!.llm_json];
  h.db.setMessageLlm = () => {
    throw new Error("disk full");
  };
  expect((await del(me.token, "artifacts", "a_doc")).status).toBe(500);
  expect([h.db.getMessage(rowId)!.cards_json, h.db.getMessage(rowId)!.llm_json]).toEqual(before);
  expect((await h.req("GET", "/api/artifacts/a_doc", { token: me.token })).status).toBe(200);
});
