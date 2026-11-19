// A friend's 모시 answer in a friend thread may carry an html card: an artifact the friend owns. The other member reads
// it (GET /api/artifacts/:id, GET /api/blobs/:id) while both are in that thread and still friends; nobody else does,
// and delete / the list stay the owner's (archive.ts readableArtifact; attachments: friend-attachments.test.ts).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Artifact, ArtifactCard, Friend, InviteResponse } from "@pickle/protocol";
import { makeHarness, outcome, readSse, type Harness } from "./helpers.ts";

let h: Harness;
beforeEach(async () => {
  h = await makeHarness();
});
afterEach(async () => {
  await h.close();
});

const HTML = "<section><h2>강남역 저녁</h2><p>세 곳을 골랐어요.</p></section>";

async function befriend(x: { token: string }, y: { token: string }): Promise<Friend> {
  const inv = (await (await h.req("POST", "/api/invites", { token: x.token })).json()) as InviteResponse;
  const acc = await h.req("POST", `/api/invites/${inv.token}/accept`, { token: y.token });
  expect([200, 201]).toContain(acc.status);
  return (await acc.json()) as Friend;
}

/** alice's 모시 answers in the friend thread with an html card; returns the card's artifact id */
async function cardInFriendThread(alice: { token: string }, threadId: string): Promise<string> {
  let id = "";
  h.turns.set(async (input) => {
    id = (await input.ctx.store.createArtifact({ title: "강남역 저녁", kind: "html", content: HTML }, { agentCard: true })).id;
    const card: ArtifactCard = { type: "artifact", artifactId: id, title: "강남역 저녁", kind: "html", preview: "세 곳을 골랐어요." };
    return outcome("세 곳이에요.", { cards: [card] });
  });
  const events = await readSse(await h.req("POST", `/api/threads/${threadId}/messages`, { token: alice.token, body: { text: "@깽이 강남역 저녁 골라줘" } }));
  expect(events.at(-1)).toMatchObject({ type: "done" });
  expect(id).not.toBe("");
  return id;
}

const read = async (token: string, id: string) => ({
  json: (await h.req("GET", `/api/artifacts/${id}`, { token })).status,
  blob: (await h.req("GET", `/api/blobs/${id}`, { token })).status,
});

describe("a friend's html card in the friend thread", () => {
  test("the other member reads it (200, both routes); a stranger and a friend outside that thread get 404", async () => {
    const a = await h.signup("alice", { displayName: "하늘", agentName: "깽이" });
    const b = await h.signup("bob", { displayName: "진우", agentName: "콩이" });
    const c = await h.signup("carol", { displayName: "서연", agentName: "별이" });
    const d = await h.signup("dave", { displayName: "민준", agentName: "솔이" });
    const ab = await befriend(a, b);
    await befriend(a, d); // dave is alice's friend too, in another friend thread
    const id = await cardInFriendThread(a, ab.threadId!);

    // bob sees the card in the thread, and its artifact loads
    const msgs = (await (await h.req("GET", `/api/threads/${ab.threadId}/messages`, { token: b.token })).json()) as { cards: ArtifactCard[] }[];
    expect(msgs.at(-1)!.cards).toEqual([expect.objectContaining({ type: "artifact", artifactId: id })]);
    const res = await h.req("GET", `/api/artifacts/${id}`, { token: b.token });
    expect(res.status).toBe(200);
    const art = (await res.json()) as Artifact;
    expect(art).toMatchObject({ id, kind: "html", title: "강남역 저녁", threadId: ab.threadId });
    expect(art.content).toContain("세 곳을 골랐어요.");
    expect(await read(b.token, id)).toEqual({ json: 200, blob: 200 });
    expect(await read(a.token, id)).toEqual({ json: 200, blob: 200 });

    // the id alone opens nothing: another user on the server, and alice's friend who is not in that thread
    expect(await read(c.token, id)).toEqual({ json: 404, blob: 404 });
    expect(await read(d.token, id)).toEqual({ json: 404, blob: 404 });
    // the 404 says nothing more than a missing id does
    const missing = await h.req("GET", "/api/artifacts/a_missing", { token: c.token });
    const denied = await h.req("GET", `/api/artifacts/${id}`, { token: c.token });
    expect(await denied.json()).toEqual(await missing.json());
  });

  test("delete, the list and other writes stay the owner's", async () => {
    const a = await h.signup("alice", { displayName: "하늘", agentName: "깽이" });
    const b = await h.signup("bob", { displayName: "진우", agentName: "콩이" });
    const ab = await befriend(a, b);
    const id = await cardInFriendThread(a, ab.threadId!);

    expect((await h.req("DELETE", `/api/artifacts/${id}`, { token: b.token })).status).toBe(404);
    for (const method of ["PUT", "PATCH", "POST"]) expect([403, 404, 405]).toContain((await h.req(method, `/api/artifacts/${id}`, { token: b.token, body: { title: "x" } })).status);
    const bList = (await (await h.req("GET", "/api/artifacts", { token: b.token })).json()) as Artifact[];
    expect(bList.map((x) => x.id)).not.toContain(id);
    // untouched: alice still has it, under its title
    const aList = (await (await h.req("GET", "/api/artifacts", { token: a.token })).json()) as Artifact[];
    expect(aList.find((x) => x.id === id)?.title).toBe("강남역 저녁");
    expect((await h.req("DELETE", `/api/artifacts/${id}`, { token: a.token })).status).toBe(200);
    expect(await read(b.token, id)).toEqual({ json: 404, blob: 404 });
  });

  test("only the owner's own post shares it: an artifact never posted there, or a card someone else wrote, stays 404", async () => {
    const a = await h.signup("alice", { displayName: "하늘", agentName: "깽이" });
    const b = await h.signup("bob", { displayName: "진우", agentName: "콩이" });
    const ab = await befriend(a, b);
    // alice's own document from her main thread: never in the friend thread
    let privateId = "";
    h.turns.set(async (input) => {
      privateId = (await input.ctx.store.createArtifact({ title: "내 메모", kind: "document", content: "# 비밀 메모" })).id;
      return outcome("저장했어요.");
    });
    await readSse(await h.req("POST", `/api/threads/${a.session.mainThreadId}/messages`, { token: a.token, body: { text: "메모 저장해줘" } }));
    expect(await read(b.token, privateId)).toEqual({ json: 404, blob: 404 });

    // a card naming it, but written by bob's side in the shared thread, opens nothing
    const forged: ArtifactCard = { type: "artifact", artifactId: privateId, title: "내 메모", kind: "document", preview: "" };
    h.db.insertMessage({ id: "m_forged", threadId: ab.threadId!, role: "assistant", text: "봐요", cards: [forged], authorUserId: b.session.user.id, authorKind: "agent", createdAt: h.clock.t });
    expect(await read(b.token, privateId)).toEqual({ json: 404, blob: 404 });
    // its id among a message's sent files (attachments_json) is not its card
    h.db.insertMessage({ id: "m_file", threadId: ab.threadId!, role: "user", text: "봐요", attachments: [{ id: privateId, filename: "x.png", mime: "image/png", size: 1, url: "" }], authorUserId: a.session.user.id, authorKind: "human", createdAt: h.clock.t });
    expect(await read(b.token, privateId)).toEqual({ json: 404, blob: 404 });
    // the same card from alice's side is her sharing it
    h.db.insertMessage({ id: "m_shared", threadId: ab.threadId!, role: "assistant", text: "봐요", cards: [forged], authorUserId: a.session.user.id, authorKind: "agent", createdAt: h.clock.t + 1 });
    expect(await read(b.token, privateId)).toEqual({ json: 200, blob: 200 });
  });

  test("a friend thread only: alice's card in another two-member thread (no such kind today) shares nothing", async () => {
    const a = await h.signup("alice", { displayName: "하늘", agentName: "깽이" });
    const b = await h.signup("bob", { displayName: "진우", agentName: "콩이" });
    await befriend(a, b);
    let id = "";
    h.turns.set(async (input) => {
      id = (await input.ctx.store.createArtifact({ title: "강남역 저녁", kind: "html", content: HTML }, { agentCard: true })).id;
      return outcome("세 곳이에요.");
    });
    await readSse(await h.req("POST", `/api/threads/${a.session.mainThreadId}/messages`, { token: a.token, body: { text: "강남역 저녁 골라줘" } }));
    h.db.createThread({ id: "t_pair", ownerId: a.session.user.id, kind: "main", title: "둘", subtitle: "", icon: "chat", now: h.clock.t }, [a.session.user.id, b.session.user.id]);
    const card: ArtifactCard = { type: "artifact", artifactId: id, title: "강남역 저녁", kind: "html", preview: "" };
    h.db.insertMessage({ id: "m_pair", threadId: "t_pair", role: "assistant", text: "봐요", cards: [card], authorUserId: a.session.user.id, authorKind: "agent", createdAt: h.clock.t });
    expect(await read(b.token, id)).toEqual({ json: 404, blob: 404 });
  });

  test("blocked (either way), removed or out of the thread: 404 for the friend, the owner keeps it", async () => {
    const a = await h.signup("alice", { displayName: "하늘", agentName: "깽이" });
    const b = await h.signup("bob", { displayName: "진우", agentName: "콩이" });
    const ab = await befriend(a, b);
    const id = await cardInFriendThread(a, ab.threadId!);
    expect(await read(b.token, id)).toEqual({ json: 200, blob: 200 });

    // bob blocks alice
    expect((await h.req("POST", `/api/friends/${a.session.user.id}/block`, { token: b.token })).status).toBe(200);
    expect(await read(b.token, id)).toEqual({ json: 404, blob: 404 });
    expect(await read(a.token, id)).toEqual({ json: 200, blob: 200 });
    // unblocked and friends again (same thread): readable again
    expect((await h.req("DELETE", `/api/friends/${a.session.user.id}`, { token: b.token })).status).toBe(200);
    await befriend(a, b);
    expect(await read(b.token, id)).toEqual({ json: 200, blob: 200 });

    // alice blocks bob
    expect((await h.req("POST", `/api/friends/${b.session.user.id}/block`, { token: a.token })).status).toBe(200);
    expect(await read(b.token, id)).toEqual({ json: 404, blob: 404 });
    expect((await h.req("DELETE", `/api/friends/${b.session.user.id}`, { token: a.token })).status).toBe(200);
    await befriend(a, b);
    expect(await read(b.token, id)).toEqual({ json: 200, blob: 200 });

    // alice removes bob (no block): the thread stays, archived, and the card no longer loads for him
    expect((await h.req("DELETE", `/api/friends/${b.session.user.id}`, { token: a.token })).status).toBe(200);
    expect(await read(b.token, id)).toEqual({ json: 404, blob: 404 });
    await befriend(a, b);
    expect(await read(b.token, id)).toEqual({ json: 200, blob: 200 });

    // out of the thread (a friend thread has no leave route; a member row gone is how leaving would look): the owner
    // gone, then the viewer gone
    const members = (u: string, gone: boolean) =>
      h.db.sql.query(gone ? "DELETE FROM thread_members WHERE thread_id = $t AND user_id = $u" : "INSERT INTO thread_members (thread_id, user_id) VALUES ($t, $u)").run({ t: ab.threadId!, u });
    members(a.session.user.id, true);
    expect(await read(b.token, id)).toEqual({ json: 404, blob: 404 });
    expect(await read(a.token, id)).toEqual({ json: 200, blob: 200 });
    members(a.session.user.id, false);
    expect(await read(b.token, id)).toEqual({ json: 200, blob: 200 });
    members(b.session.user.id, true);
    expect(await read(b.token, id)).toEqual({ json: 404, blob: 404 });
    expect(await read(a.token, id)).toEqual({ json: 200, blob: 200 });
  });
});
