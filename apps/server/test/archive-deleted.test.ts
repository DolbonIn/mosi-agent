/**
 * A document or file deleted from the archive (보관함) stays in the conversation as a marked card (DD 2103, H): every
 * message carrying it, in the owner's threads and friend threads alike, gets the card `{ …, preview: "", deleted: true }`
 * or the ref `{ …, url: "", deleted: true }` (title, kind, filename, mime and size kept), in the delete's transaction,
 * and goes out again as `message` to every device of every member; page reads show the same. Only that exact id: ids
 * LIKE would also match stay as they were. Someone else's id and a second delete are 404 and change nothing.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ArtifactCard, Attachment, AttachmentRef, Card, Friend, InviteResponse, Message, ServerEvent } from "@pickle/protocol";
import { makeHarness, sseReader, type Harness } from "./helpers.ts";

let h: Harness;
beforeEach(async () => {
  h = await makeHarness();
});
afterEach(async () => {
  await h.close();
});

type Me = { token: string; session: { user: { id: string }; mainThreadId: string } };
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

async function befriend(x: { token: string }, y: { token: string }): Promise<Friend> {
  const inv = (await (await h.req("POST", "/api/invites", { token: x.token })).json()) as InviteResponse;
  const acc = await h.req("POST", `/api/invites/${inv.token}/accept`, { token: y.token });
  expect([200, 201]).toContain(acc.status);
  return (await acc.json()) as Friend;
}

/** a device of the person: its /api/events stream, opened (hello received) */
async function device(token: string) {
  const ev = sseReader(await h.req("GET", `/api/events?token=${token}`));
  expect(await ev.next((e: ServerEvent) => e.type === "hello")).toBeTruthy();
  return {
    /** `message` events since the last call, in order */
    async messages(waitMs = 60): Promise<Extract<ServerEvent, { type: "message" }>[]> {
      const out: Extract<ServerEvent, { type: "message" }>[] = [];
      for (;;) {
        const e = await ev.next<Extract<ServerEvent, { type: "message" }>>((x) => x.type === "message", waitMs);
        if (!e) return out;
        out.push(e);
      }
    },
    cancel: () => ev.cancel(),
  };
}

let seq = 0;
function artifact(owner: Me, id: string, kind: ArtifactCard["kind"] = "document", title = "강남역 저녁 후보"): ArtifactCard {
  h.db.insertArtifact({ id, userId: owner.session.user.id, threadId: owner.session.mainThreadId, title, kind, content: "# 내용", now: h.clock.t });
  return { type: "artifact", artifactId: id, title, kind, preview: kind === "html" ? "세 곳을 골랐어요" : "1. 하나 2. 둘" };
}
const card = (id: string, title = "비슷한 id"): ArtifactCard => ({ type: "artifact", artifactId: id, title, kind: "document", preview: "미리보기" });
function message(threadId: string, author: Me, m: { text?: string; cards?: Card[]; attachments?: AttachmentRef[]; kind?: "human" | "agent" }): string {
  const id = `m_${++seq}`;
  const kind = m.kind ?? "agent";
  h.db.insertMessage({ id, threadId, role: kind === "agent" ? "assistant" : "user", text: m.text ?? "아래 문서에 정리했어요", cards: m.cards, attachments: m.attachments, authorUserId: author.session.user.id, authorKind: kind, createdAt: h.clock.t + seq });
  return id;
}
async function upload(token: string, name = "영수증.png", threadId?: string): Promise<Attachment> {
  const form = new FormData();
  form.set("file", new File([PNG], name, { type: "image/png" }));
  if (threadId) form.set("threadId", threadId);
  const res = await h.req("POST", "/api/attachments", { token, raw: form });
  expect(res.status).toBe(201);
  return (await res.json()) as Attachment;
}
const ref = (a: Attachment): AttachmentRef => ({ id: a.id, filename: a.filename, mime: a.mime, size: a.size, url: a.url });
const page = async (token: string, threadId: string) => (await (await h.req("GET", `/api/threads/${threadId}/messages?limit=200`, { token })).json()) as Message[];
const row = (id: string) => h.db.getMessage(id)!;
const del = (token: string, what: "artifacts" | "attachments", id: string) => h.req("DELETE", `/api/${what}/${id}`, { token });

describe("a deleted artifact", () => {
  test("my thread: both of my devices get the message with the card marked (preview empty, deleted; title and kind kept), the page read the same; the other card and the text stay; a friend hears nothing", async () => {
    const a = await h.signup("alice", { displayName: "하늘", agentName: "깽이" });
    const b = await h.signup("bob", { displayName: "진우", agentName: "콩이" });
    await befriend(a, b);
    const doc = artifact(a, "a_doc");
    const other = artifact(a, "a_other", "checklist", "준비물");
    const mid = message(a.session.mainThreadId, a, { cards: [doc, other] });
    const [a1, a2, fb] = [await device(a.token), await device(a.token), await device(b.token)];

    expect((await del(a.token, "artifacts", "a_doc")).status).toBe(200);
    const marked: ArtifactCard = { type: "artifact", artifactId: "a_doc", title: "강남역 저녁 후보", kind: "document", preview: "", deleted: true };
    for (const d of [a1, a2]) {
      const got = await d.messages();
      expect(got.map((e) => [e.threadId, e.message.id])).toEqual([[a.session.mainThreadId, mid]]);
      expect(got[0]!.message.cards).toEqual([marked, other]);
      expect(got[0]!.message.text).toBe("아래 문서에 정리했어요");
    }
    expect(await fb.messages()).toEqual([]);
    const shown = (await page(a.token, a.session.mainThreadId)).find((m) => m.id === mid)!;
    expect(shown.cards).toEqual([marked, other]);
    expect((await h.req("GET", "/api/artifacts/a_doc", { token: a.token })).status).toBe(404);
    expect((await h.req("GET", "/api/artifacts/a_other", { token: a.token })).status).toBe(200);
    for (const d of [a1, a2, fb]) await d.cancel();
  });

  test("a friend thread (the html card under my 모시's answer there): the friend's device gets it too and the friend's page read shows it", async () => {
    const a = await h.signup("alice", { displayName: "하늘", agentName: "깽이" });
    const b = await h.signup("bob", { displayName: "진우", agentName: "콩이" });
    const ab = await befriend(a, b);
    const html = artifact(a, "a_html", "html", "저녁 후보 세 곳");
    const mine = message(a.session.mainThreadId, a, { cards: [html] });
    const shared = message(ab.threadId!, a, { cards: [html], text: "세 곳 골랐어요" });
    const [fa, fb] = [await device(a.token), await device(b.token)];

    expect((await del(a.token, "artifacts", "a_html")).status).toBe(200);
    const marked: ArtifactCard = { type: "artifact", artifactId: "a_html", title: "저녁 후보 세 곳", kind: "html", preview: "", deleted: true };
    expect((await fa.messages()).map((e) => e.message.id).sort()).toEqual([mine, shared].sort());
    const toFriend = await fb.messages();
    expect(toFriend.map((e) => [e.threadId, e.message.id])).toEqual([[ab.threadId!, shared]]);
    expect(toFriend[0]!.message.cards).toEqual([marked]);
    expect(toFriend[0]!.message.author).toEqual({ kind: "peer-agent", name: "하늘 님의 깽이" });
    expect((await page(b.token, ab.threadId!)).find((m) => m.id === shared)!.cards).toEqual([marked]);
    for (const d of [fa, fb]) await d.cancel();
  });

  test("only that exact id: cards whose ids LIKE would also match (a_1 → ab1, a_12, A_1, xa_1) stay as they were, and their messages get no event", async () => {
    const a = await h.signup("alice");
    const target = artifact(a, "a_1");
    const looks = ["ab1", "a_12", "A_1", "xa_1"].map((id) => card(id));
    const both = message(a.session.mainThreadId, a, { cards: [looks[0]!, target, looks[1]!] });
    const lookalikes = message(a.session.mainThreadId, a, { cards: looks });
    const was = row(lookalikes).cards_json;
    const d = await device(a.token);
    expect((await del(a.token, "artifacts", "a_1")).status).toBe(200);
    expect((await d.messages()).map((e) => e.message.id)).toEqual([both]);
    expect(JSON.parse(row(both).cards_json)).toEqual([looks[0], { ...target, preview: "", deleted: true }, looks[1]]);
    expect(row(lookalikes).cards_json).toBe(was);
    await d.cancel();
  });

  test("201 messages carrying it are all marked (no LIMIT), one event each", async () => {
    const a = await h.signup("alice");
    const doc = artifact(a, "a_many");
    const ids = Array.from({ length: 201 }, () => message(a.session.mainThreadId, a, { cards: [doc] }));
    const d = await device(a.token);
    expect((await del(a.token, "artifacts", "a_many")).status).toBe(200);
    const got = (await d.messages(200)).map((e) => e.message.id);
    expect(got.length).toBe(201);
    expect(new Set(got)).toEqual(new Set(ids));
    for (const id of ids) expect((JSON.parse(row(id).cards_json) as ArtifactCard[])[0]!.deleted).toBe(true);
    await d.cancel();
  });

  test("someone else's id: 404, nothing changes, nobody hears anything; the owner's second delete: 404, no event", async () => {
    const a = await h.signup("alice");
    const b = await h.signup("bob");
    const ab = await befriend(a, b);
    const doc = artifact(a, "a_mine");
    const m1 = message(a.session.mainThreadId, a, { cards: [doc] });
    const m2 = message(ab.threadId!, a, { cards: [doc] });
    const before = [row(m1).cards_json, row(m2).cards_json];
    const [fa, fb] = [await device(a.token), await device(b.token)];
    expect((await del(b.token, "artifacts", "a_mine")).status).toBe(404);
    expect([row(m1).cards_json, row(m2).cards_json]).toEqual(before);
    expect(await fa.messages()).toEqual([]);
    expect(await fb.messages()).toEqual([]);
    expect((await h.req("GET", "/api/artifacts/a_mine", { token: a.token })).status).toBe(200);

    expect((await del(a.token, "artifacts", "a_mine")).status).toBe(200);
    expect((await fa.messages()).length).toBe(2);
    expect((await fb.messages()).length).toBe(1);
    const after = [row(m1).cards_json, row(m2).cards_json];
    expect((await del(a.token, "artifacts", "a_mine")).status).toBe(404);
    expect([row(m1).cards_json, row(m2).cards_json]).toEqual(after);
    expect(await fa.messages()).toEqual([]);
    expect(await fb.messages()).toEqual([]);
    for (const d of [fa, fb]) await d.cancel();
  });

  test("a message in a thread the owner is not in is not looked at, even if it carries the id (only the owner's side ever puts it in a message)", async () => {
    const a = await h.signup("alice");
    const b = await h.signup("bob");
    const doc = artifact(a, "a_scope");
    const theirs = message(b.session.mainThreadId, b, { cards: [doc] }); // cannot happen through the API; written straight to the db
    const was = row(theirs).cards_json;
    const fb = await device(b.token);
    expect((await del(a.token, "artifacts", "a_scope")).status).toBe(200);
    expect(row(theirs).cards_json).toBe(was);
    expect(await fb.messages()).toEqual([]);
    await fb.cancel();
  });
});

describe("one transaction", () => {
  test("a failure while marking leaves everything as it was: the artifact or file still there, no message changed, no event", async () => {
    const a = await h.signup("alice");
    const doc = artifact(a, "a_tx");
    const photo = await upload(a.token);
    const ids = [1, 2, 3].map(() => message(a.session.mainThreadId, a, { cards: [doc], attachments: [ref(photo)] }));
    const before = ids.map((id) => [row(id).cards_json, row(id).attachments_json]);
    const d = await device(a.token);
    const cards = h.db.updateMessageCards.bind(h.db);
    const refs = h.db.updateMessageAttachments.bind(h.db);
    let n = 0;
    h.db.updateMessageCards = (id, c) => (++n === 2 ? (() => { throw new Error("disk full"); })() : cards(id, c));
    h.db.updateMessageAttachments = (id, r) => (++n === 2 ? (() => { throw new Error("disk full"); })() : refs(id, r));
    expect((await del(a.token, "artifacts", "a_tx")).status).toBe(500);
    n = 0;
    expect((await del(a.token, "attachments", photo.id)).status).toBe(500);
    expect(ids.map((id) => [row(id).cards_json, row(id).attachments_json])).toEqual(before);
    expect(await d.messages()).toEqual([]);
    expect((await h.req("GET", "/api/artifacts/a_tx", { token: a.token })).status).toBe(200);
    expect((await h.req("GET", `/api/attachments/${photo.id}/raw`, { token: a.token })).status).toBe(200);
    await d.cancel();
  });
});

describe("a deleted attachment", () => {
  test("my message and the photo I sent in a friend thread: refs marked (url empty, deleted; filename, mime, size kept) for every member's devices and page reads; the file is gone", async () => {
    const a = await h.signup("alice", { displayName: "하늘", agentName: "깽이" });
    const b = await h.signup("bob", { displayName: "진우", agentName: "콩이" });
    const ab = await befriend(a, b);
    const photo = await upload(a.token, "영수증.png", ab.threadId!);
    const other = await upload(a.token, "메모.png");
    const sent = await h.req("POST", `/api/threads/${ab.threadId}/messages`, { token: a.token, body: { text: "어제 영수증이에요", attachmentIds: [photo.id] } });
    expect(sent.status).toBe(201);
    const shared = (await page(a.token, ab.threadId!)).at(-1)!.id;
    const mine = message(a.session.mainThreadId, a, { kind: "human", text: "이거 정리해줘", attachments: [ref(photo), ref(other)] });
    const file = join(h.dir, "attachments", a.session.user.id, photo.id);
    expect(existsSync(file)).toBe(true);
    const [fa, fb] = [await device(a.token), await device(b.token)];

    expect((await del(a.token, "attachments", photo.id)).status).toBe(200);
    const marked: AttachmentRef = { id: photo.id, filename: "영수증.png", mime: "image/png", size: PNG.length, url: "", deleted: true };
    const toMe = await fa.messages();
    expect(toMe.map((e) => e.message.id).sort()).toEqual([mine, shared].sort());
    expect(toMe.find((e) => e.message.id === mine)!.message.attachments).toEqual([marked, ref(other)]);
    const toFriend = await fb.messages();
    expect(toFriend.map((e) => [e.threadId, e.message.id])).toEqual([[ab.threadId!, shared]]);
    expect(toFriend[0]!.message.attachments).toEqual([marked]);
    expect(toFriend[0]!.message.text).toBe("어제 영수증이에요");
    expect((await page(b.token, ab.threadId!)).find((m) => m.id === shared)!.attachments).toEqual([marked]);
    expect((await page(a.token, a.session.mainThreadId)).find((m) => m.id === mine)!.attachments).toEqual([marked, ref(other)]);
    expect(existsSync(file)).toBe(false);
    expect((await h.req("GET", `/api/attachments/${other.id}/raw`, { token: a.token })).status).toBe(200);
    for (const d of [fa, fb]) await d.cancel();
  });

  test("only that exact id (refs LIKE would also match stay); someone else's id and a second delete: 404, nothing changes, no event", async () => {
    const a = await h.signup("alice");
    const b = await h.signup("bob");
    const photo = await upload(a.token);
    const look = (id: string): AttachmentRef => ({ id, filename: "x.png", mime: "image/png", size: 1, url: `/api/attachments/${id}/raw` });
    const likes = [look(photo.id.replace("_", "x")), look(`${photo.id}2`), look(photo.id.toUpperCase())];
    const both = message(a.session.mainThreadId, a, { kind: "human", attachments: [likes[0]!, ref(photo)] });
    const lookalikes = message(a.session.mainThreadId, a, { kind: "human", attachments: likes });
    const was = row(lookalikes).attachments_json;
    const [fa, fb] = [await device(a.token), await device(b.token)];
    expect((await del(b.token, "attachments", photo.id)).status).toBe(404);
    expect(JSON.parse(row(both).attachments_json)).toEqual([likes[0], ref(photo)]);
    expect(await fa.messages()).toEqual([]);

    expect((await del(a.token, "attachments", photo.id)).status).toBe(200);
    expect((await fa.messages()).map((e) => e.message.id)).toEqual([both]);
    expect(JSON.parse(row(both).attachments_json)).toEqual([likes[0], { ...ref(photo), url: "", deleted: true }]);
    expect(row(lookalikes).attachments_json).toBe(was);
    const after = row(both).attachments_json;
    expect((await del(a.token, "attachments", photo.id)).status).toBe(404);
    expect(row(both).attachments_json).toBe(after);
    expect(await fa.messages()).toEqual([]);
    expect(await fb.messages()).toEqual([]);
    for (const d of [fa, fb]) await d.cancel();
  });
});
