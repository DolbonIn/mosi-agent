// A photo or file a friend sends in a friend thread is the friend's attachment. The other member opens it
// (GET /api/attachments/:id/raw, header or ?token=) while both are in that thread and still friends; nobody else does,
// and delete / the list / attaching it to a message stay the owner's (archive.ts readableAttachment, the same check as
// readableArtifact).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Attachment, Friend, InviteResponse, Message } from "@pickle/protocol";
import { makeHarness, type Harness } from "./helpers.ts";

let h: Harness;
beforeEach(async () => {
  h = await makeHarness();
});
afterEach(async () => {
  await h.close();
});

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

async function befriend(x: { token: string }, y: { token: string }): Promise<Friend> {
  const inv = (await (await h.req("POST", "/api/invites", { token: x.token })).json()) as InviteResponse;
  const acc = await h.req("POST", `/api/invites/${inv.token}/accept`, { token: y.token });
  expect([200, 201]).toContain(acc.status);
  return (await acc.json()) as Friend;
}

async function upload(token: string, name = "사진.png", threadId?: string): Promise<Attachment> {
  const form = new FormData();
  form.set("file", new File([PNG], name, { type: "image/png" }));
  if (threadId) form.set("threadId", threadId);
  const res = await h.req("POST", "/api/attachments", { token, raw: form });
  expect(res.status).toBe(201);
  return (await res.json()) as Attachment;
}

/** alice sends a photo in the friend thread (no @mention: delivered, 201); returns the attachment */
async function photoInFriendThread(alice: { token: string }, threadId: string): Promise<Attachment> {
  const a = await upload(alice.token, "사진.png", threadId);
  const res = await h.req("POST", `/api/threads/${threadId}/messages`, { token: alice.token, body: { text: "어제 찍은 거예요", attachmentIds: [a.id] } });
  expect(res.status).toBe(201);
  return a;
}

const raw = async (token: string, id: string) => (await h.req("GET", `/api/attachments/${id}/raw`, { token })).status;

describe("a friend's photo in the friend thread", () => {
  test("the other member opens it (200, header and ?token=, the owner's bytes); a stranger and a friend outside that thread get 404", async () => {
    const a = await h.signup("alice", { displayName: "하늘", agentName: "깽이" });
    const b = await h.signup("bob", { displayName: "진우", agentName: "콩이" });
    const c = await h.signup("carol", { displayName: "서연", agentName: "별이" });
    const d = await h.signup("dave", { displayName: "민준", agentName: "솔이" });
    const ab = await befriend(a, b);
    await befriend(a, d); // dave is alice's friend too, in another friend thread
    const att = await photoInFriendThread(a, ab.threadId!);

    // bob sees the photo in the thread, and its url opens
    const msgs = (await (await h.req("GET", `/api/threads/${ab.threadId}/messages`, { token: b.token })).json()) as Message[];
    expect(msgs.at(-1)!.attachments.map((x) => x.id)).toEqual([att.id]);
    const res = await h.req("GET", msgs.at(-1)!.attachments[0]!.url, { token: b.token });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("content-disposition")).toStartWith("inline;");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG);
    // the <img> in the app uses ?token=
    expect((await h.req("GET", `/api/attachments/${att.id}/raw?token=${b.token}`)).status).toBe(200);
    // a shared read is checked again on every load (a block takes effect at once); the owner's own keeps the hour
    expect(res.headers.get("cache-control")).toBe("private, no-cache");
    expect((await h.req("GET", `/api/attachments/${att.id}/raw`, { token: a.token })).headers.get("cache-control")).toBe("private, max-age=3600");

    // the id alone opens nothing: another user on the server, and alice's friend who is not in that thread
    expect(await raw(c.token, att.id)).toBe(404);
    expect(await raw(d.token, att.id)).toBe(404);
    expect((await h.req("GET", `/api/attachments/${att.id}/raw?token=${c.token}`)).status).toBe(404);
    // the 404 says nothing more than a missing id does
    const missing = await h.req("GET", "/api/attachments/f_missing/raw", { token: c.token });
    const denied = await h.req("GET", `/api/attachments/${att.id}/raw`, { token: c.token });
    expect(await denied.json()).toEqual(await missing.json());
  });

  test("delete, the list and attaching it to a message stay the owner's", async () => {
    const a = await h.signup("alice", { displayName: "하늘", agentName: "깽이" });
    const b = await h.signup("bob", { displayName: "진우", agentName: "콩이" });
    const ab = await befriend(a, b);
    const att = await photoInFriendThread(a, ab.threadId!);
    expect(await raw(b.token, att.id)).toBe(200);

    expect((await h.req("DELETE", `/api/attachments/${att.id}`, { token: b.token })).status).toBe(404);
    for (const method of ["PUT", "PATCH", "POST"]) expect([403, 404, 405]).toContain((await h.req(method, `/api/attachments/${att.id}/raw`, { token: b.token, body: { x: 1 } })).status);
    const bList = (await (await h.req("GET", "/api/attachments", { token: b.token })).json()) as Attachment[];
    expect(bList.map((x) => x.id)).not.toContain(att.id);
    // bob cannot pass it on as his own: not in the friend thread, not in his main thread
    expect((await h.req("POST", `/api/threads/${ab.threadId}/messages`, { token: b.token, body: { text: "이거요", attachmentIds: [att.id] } })).status).toBe(404);
    expect((await h.req("POST", `/api/threads/${b.session.mainThreadId}/messages`, { token: b.token, body: { text: "이거 봐줘", attachmentIds: [att.id] } })).status).toBe(404);
    // untouched: alice still has it
    const aList = (await (await h.req("GET", "/api/attachments", { token: a.token })).json()) as Attachment[];
    expect(aList.map((x) => x.id)).toContain(att.id);
    expect((await h.req("DELETE", `/api/attachments/${att.id}`, { token: a.token })).status).toBe(200);
    expect(await raw(b.token, att.id)).toBe(404);
    expect(await raw(a.token, att.id)).toBe(404);
  });

  test("only the owner's own post shares it: a file never sent there, or a message someone else wrote, stays 404", async () => {
    const a = await h.signup("alice", { displayName: "하늘", agentName: "깽이" });
    const b = await h.signup("bob", { displayName: "진우", agentName: "콩이" });
    const ab = await befriend(a, b);
    // uploaded into the friend thread but never sent (the upload alone shares nothing)
    const unsent = await upload(a.token, "보내지 않은 사진.png", ab.threadId!);
    expect(await raw(b.token, unsent.id)).toBe(404);
    // alice's file sent in her main thread only
    const own = await upload(a.token, "메모.png", a.session.mainThreadId);
    h.db.insertMessage({ id: "m_main", threadId: a.session.mainThreadId, role: "user", text: "내 사진", attachments: [{ id: own.id, filename: own.filename, mime: own.mime, size: own.size, url: own.url }], createdAt: h.clock.t });
    expect(await raw(b.token, own.id)).toBe(404);

    // a message naming it, but written by bob in the shared thread, opens nothing
    const ref = { id: own.id, filename: own.filename, mime: own.mime, size: own.size, url: own.url };
    h.db.insertMessage({ id: "m_forged", threadId: ab.threadId!, role: "user", text: "봐요", attachments: [ref], authorUserId: b.session.user.id, authorKind: "human", createdAt: h.clock.t + 1 });
    expect(await raw(b.token, own.id)).toBe(404);
    // the same attachment in an artifact-card slot (cards_json) is not a sent file either
    h.db.insertMessage({ id: "m_card", threadId: ab.threadId!, role: "assistant", text: "봐요", cards: [{ type: "artifact", artifactId: own.id, title: "x", kind: "html", preview: "" }], authorUserId: a.session.user.id, authorKind: "agent", createdAt: h.clock.t + 2 });
    expect(await raw(b.token, own.id)).toBe(404);
    // the same file from alice's side is her sending it
    h.db.insertMessage({ id: "m_shared", threadId: ab.threadId!, role: "user", text: "봐요", attachments: [ref], authorUserId: a.session.user.id, authorKind: "human", createdAt: h.clock.t + 3 });
    expect(await raw(b.token, own.id)).toBe(200);
  });

  test("a friend thread only: alice's photo in another two-member thread (no such kind today) shares nothing", async () => {
    const a = await h.signup("alice", { displayName: "하늘", agentName: "깽이" });
    const b = await h.signup("bob", { displayName: "진우", agentName: "콩이" });
    await befriend(a, b);
    const att = await upload(a.token);
    h.db.createThread({ id: "t_pair", ownerId: a.session.user.id, kind: "main", title: "둘", subtitle: "", icon: "chat", now: h.clock.t }, [a.session.user.id, b.session.user.id]);
    h.db.insertMessage({ id: "m_pair", threadId: "t_pair", role: "user", text: "봐요", attachments: [{ id: att.id, filename: att.filename, mime: att.mime, size: att.size, url: att.url }], authorUserId: a.session.user.id, authorKind: "human", createdAt: h.clock.t });
    expect(await raw(b.token, att.id)).toBe(404);
  });

  test("blocked (either way), removed or out of the thread: 404 for the friend, the owner keeps it", async () => {
    const a = await h.signup("alice", { displayName: "하늘", agentName: "깽이" });
    const b = await h.signup("bob", { displayName: "진우", agentName: "콩이" });
    const ab = await befriend(a, b);
    const att = await photoInFriendThread(a, ab.threadId!);
    expect(await raw(b.token, att.id)).toBe(200);

    // bob blocks alice
    expect((await h.req("POST", `/api/friends/${a.session.user.id}/block`, { token: b.token })).status).toBe(200);
    expect(await raw(b.token, att.id)).toBe(404);
    expect(await raw(a.token, att.id)).toBe(200);
    expect((await h.req("DELETE", `/api/friends/${a.session.user.id}`, { token: b.token })).status).toBe(200);
    await befriend(a, b);
    expect(await raw(b.token, att.id)).toBe(200);

    // alice blocks bob
    expect((await h.req("POST", `/api/friends/${b.session.user.id}/block`, { token: a.token })).status).toBe(200);
    expect(await raw(b.token, att.id)).toBe(404);
    expect((await h.req("DELETE", `/api/friends/${b.session.user.id}`, { token: a.token })).status).toBe(200);
    await befriend(a, b);
    expect(await raw(b.token, att.id)).toBe(200);

    // alice removes bob (no block)
    expect((await h.req("DELETE", `/api/friends/${b.session.user.id}`, { token: a.token })).status).toBe(200);
    expect(await raw(b.token, att.id)).toBe(404);
    await befriend(a, b);
    expect(await raw(b.token, att.id)).toBe(200);

    // out of the thread (a friend thread has no leave route; a member row gone is how leaving would look): the owner
    // gone, then the viewer gone
    const members = (u: string, gone: boolean) =>
      h.db.sql.query(gone ? "DELETE FROM thread_members WHERE thread_id = $t AND user_id = $u" : "INSERT INTO thread_members (thread_id, user_id) VALUES ($t, $u)").run({ t: ab.threadId!, u });
    members(a.session.user.id, true);
    expect(await raw(b.token, att.id)).toBe(404);
    expect(await raw(a.token, att.id)).toBe(200);
    members(a.session.user.id, false);
    expect(await raw(b.token, att.id)).toBe(200);
    members(b.session.user.id, true);
    expect(await raw(b.token, att.id)).toBe(404);
    expect(await raw(a.token, att.id)).toBe(200);
  });
});
