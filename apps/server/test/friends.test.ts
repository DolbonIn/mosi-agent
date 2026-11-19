import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Friend, InviteResponse, Message, Thread } from "@pickle/protocol";
import { makeHarness, outcome, readSse, sseReader, type Harness } from "./helpers.ts";

let h: Harness;
beforeEach(async () => {
  h = await makeHarness();
});
afterEach(async () => {
  await h.close();
});

async function befriend() {
  const a = await h.signup("alice", { displayName: "하늘", agentName: "깽이" });
  const b = await h.signup("bob", { displayName: "진우", agentName: "콩이" });
  const inv = await h.req("POST", "/api/invites", { token: a.token, headers: { host: "pickle.test" } });
  expect(inv.status).toBe(201);
  const invite = (await inv.json()) as InviteResponse;
  expect(invite.url).toBe(`http://pickle.test/i/${invite.token}`);
  expect(invite.expiresAt).toBe(h.clock.t + 24 * 3600 * 1000);
  const acc = await h.req("POST", `/api/invites/${invite.token}/accept`, { token: b.token });
  expect(acc.status).toBe(201);
  const friend = (await acc.json()) as Friend;
  return { a, b, invite, friend };
}

describe("friends", () => {
  test("invite → accept creates the friendship and ONE shared thread", async () => {
    const { a, b, friend } = await befriend();
    expect(friend).toMatchObject({ userId: a.session.user.id, displayName: "하늘", handle: "alice", agentName: "깽이", status: "accepted" });
    const fa = (await (await h.req("GET", "/api/friends", { token: a.token })).json()) as Friend[];
    const fb = (await (await h.req("GET", "/api/friends", { token: b.token })).json()) as Friend[];
    expect(fa.map((f) => f.handle)).toEqual(["bob"]);
    expect(fb.map((f) => f.handle)).toEqual(["alice"]);
    expect(fa[0]!.threadId).toBe(fb[0]!.threadId);

    const ta = ((await (await h.req("GET", "/api/threads", { token: a.token })).json()) as Thread[]).find((t) => t.kind === "friend")!;
    const tb = ((await (await h.req("GET", "/api/threads", { token: b.token })).json()) as Thread[]).find((t) => t.kind === "friend")!;
    expect(ta.id).toBe(tb.id);
    expect(ta.title).toBe("깽이와 진우님의 모시");
    expect(tb.title).toBe("콩이와 하늘님의 모시");
    expect(ta.peer).toEqual({ userId: b.session.user.id, displayName: "진우", agentName: "콩이" });
    const msgs = (await (await h.req("GET", `/api/threads/${ta.id}/messages`, { token: b.token })).json()) as Message[];
    expect(msgs[0]!.role).toBe("event");
    expect(msgs[0]!.text).toContain("친구가 되었어요");

    // accepting again is idempotent; own invite is refused
    const again = await h.req("POST", "/api/invites", { token: a.token });
    const tok = ((await again.json()) as InviteResponse).token;
    expect((await h.req("POST", `/api/invites/${tok}/accept`, { token: b.token })).status).toBe(200);
    expect((await h.req("POST", `/api/invites/${tok}/accept`, { token: a.token })).status).toBe(400);
    expect((await h.req("POST", `/api/invites/not-a-real-token-xyz/accept`, { token: b.token })).status).toBe(404);
  });

  test("human messages are shared; mentioning my agent runs my agent in the thread", async () => {
    const { a, b, friend } = await befriend();
    const tid = friend.threadId!;
    const evB = sseReader(await h.req("GET", `/api/events?token=${b.token}`));
    await evB.next((e) => e.type === "hello");

    const plain = await h.req("POST", `/api/threads/${tid}/messages`, { token: a.token, body: { text: "내일 저녁 어때?" } });
    expect(plain.status).toBe(201);
    const delivered = (await plain.json()) as { delivered: boolean; userMessage: Message };
    expect(delivered.delivered).toBe(true);
    expect(delivered.userMessage.author).toEqual({ kind: "me", name: "하늘" });
    const pushed = await evB.next((e) => e.type === "message" && e.threadId === tid);
    expect(pushed).toMatchObject({ message: { text: "내일 저녁 어때?", author: { kind: "peer", name: "하늘 님" } } });
    expect(await evB.next((e) => e.type === "notification")).toMatchObject({ title: "하늘 님", threadId: tid });
    expect(h.turns.inputs).toHaveLength(0);

    h.turns.set(async (input, emit) => {
      expect(input.tools.map((t) => t.name)).not.toContain("sys_phone_call");
      expect(input.system).toContain("공유 대화방");
      expect(input.history.at(-1)).toEqual({ role: "user", content: "[하늘 님] 내일 저녁 어때?" });
      expect(input.userText).toBe("[하늘 님] @깽이 강남역 근처 맛집 찾아줘");
      emit({ type: "text", delta: "찾아볼게요" });
      return outcome("강남역 근처 맛집 세 곳이에요.");
    });
    const events = await readSse(await h.req("POST", `/api/threads/${tid}/messages`, { token: a.token, body: { text: "@깽이 강남역 근처 맛집 찾아줘" } }));
    const done = events.at(-1) as { type: "done"; message: Message };
    expect(done.type).toBe("done");
    expect(done.message.author).toEqual({ kind: "my-agent", name: "깽이" });
    const bView = (await (await h.req("GET", `/api/threads/${tid}/messages`, { token: b.token })).json()) as Message[];
    expect(bView.at(-1)!.author).toEqual({ kind: "peer-agent", name: "하늘 님의 깽이" });
    await evB.cancel();
  });

  test("말 전하기: ToolStore.messageFriend posts into the shared thread and notifies the friend", async () => {
    const { a, b, friend } = await befriend();
    const evB = sseReader(await h.req("GET", `/api/events?token=${b.token}`));
    await evB.next((e) => e.type === "hello");
    let result: unknown;
    h.turns.set(async (input) => {
      expect(await input.ctx.store.listFriends()).toEqual([{ handle: "bob", displayName: "진우", agentName: "콩이" }]);
      result = await input.ctx.store.messageFriend("진우님", "내일 7시에 만나요");
      expect(await input.ctx.store.messageFriend("nobody", "x")).toMatchObject({ ok: false });
      return outcome("진우 님에게 전했어요");
    });
    await readSse(await h.req("POST", `/api/threads/${a.session.mainThreadId}/messages`, { token: a.token, body: { text: "진우한테 내일 7시에 만나자고 전해줘" } }));
    expect(result).toEqual({ ok: true, detail: "진우 님에게 전했어요" });
    const msg = await evB.next((e) => e.type === "message" && e.threadId === friend.threadId);
    expect(msg).toMatchObject({ message: { text: "깽이: 내일 7시에 만나요", author: { kind: "peer-agent" } } });
    expect(await evB.next((e) => e.type === "notification" && e.title === "하늘 님의 모시")).toMatchObject({ body: "내일 7시에 만나요" });
    const tb = ((await (await h.req("GET", "/api/threads", { token: b.token })).json()) as Thread[]).find((t) => t.id === friend.threadId)!;
    expect(tb.unread).toBe(true);
    await evB.cancel();
  });

  test("block: no more messages, invites refused; delete removes", async () => {
    const { a, b, friend } = await befriend();
    const blocked = await h.req("POST", `/api/friends/${a.session.user.id}/block`, { token: b.token });
    expect(blocked.status).toBe(200);
    expect(((await blocked.json()) as Friend).status).toBe("blocked");
    expect(((await (await h.req("GET", "/api/friends", { token: a.token })).json()) as Friend[]).length).toBe(0);
    expect((await h.req("POST", `/api/threads/${friend.threadId}/messages`, { token: a.token, body: { text: "안녕?" } })).status).toBe(403);
    const inv = (await (await h.req("POST", "/api/invites", { token: a.token })).json()) as InviteResponse;
    expect((await h.req("POST", `/api/invites/${inv.token}/accept`, { token: b.token })).status).toBe(403);
    // unblock (delete) then befriend again works
    expect((await h.req("DELETE", `/api/friends/${a.session.user.id}`, { token: b.token })).status).toBe(200);
    expect((await h.req("POST", `/api/invites/${inv.token}/accept`, { token: b.token })).status).toBe(201);
    expect((await h.req("DELETE", `/api/friends/${b.session.user.id}`, { token: a.token })).status).toBe(200);
    expect(((await (await h.req("GET", "/api/friends", { token: b.token })).json()) as Friend[]).length).toBe(0);
  });

  test("/i/:token landing page: valid shows OG tags, invalid shows the real site's copy", async () => {
    const { a } = await befriend();
    const inv = (await (await h.req("POST", "/api/invites", { token: a.token })).json()) as InviteResponse;
    const ok = await h.req("GET", `/i/${inv.token}`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toContain("text/html");
    const html = await ok.text();
    expect(html).toContain('<meta property="og:title" content="하늘 님이 모시 친구로 초대했어요">');
    expect(html).toContain(`href="/?invite=${inv.token}"`);
    expect(html).toContain("앱 열기");

    const bad = await h.req("GET", "/i/<script>bad");
    expect(bad.status).toBe(200);
    const badHtml = await bad.text();
    expect(badHtml).toContain("초대 링크가 올바르지 않아요");
    expect(badHtml).toContain("친구에게 새 링크를 받아 주세요.");
    expect(badHtml).toContain("앱 열기");
    expect(badHtml).not.toContain("<script>bad");
    expect(bad.headers.get("x-frame-options")).toBe("DENY");

    h.clock.t += 25 * 3600 * 1000;
    expect(await (await h.req("GET", `/i/${inv.token}`)).text()).toContain("초대 링크가 올바르지 않아요");
  });
});
