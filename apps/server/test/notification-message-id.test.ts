/**
 * Banner B: a notification that tells of a stored row carries that row's id (messageId), so an app showing the thread
 * leaves the banner out. The five such banners (a friend's line, a friend's agent's message, a new friend's event row,
 * a schedule's answer, a meeting's approval card) each carry the id of the row pushed to the same person just before;
 * a banner with no row behind it (a remembered fact) carries none.
 */
import { afterEach, expect, test } from "bun:test";
import type { LlmChunk, LlmRequest, ToolDef } from "@pickle/agent";
import type { Friend, InviteResponse, Message, ServerEvent } from "@pickle/protocol";
import { runMeetTurn } from "../src/meetAgent.ts";
import { makeHarness, outcome, readSse, type Harness } from "./helpers.ts";

let h: Harness;
afterEach(async () => {
  await h.close();
});

type Sent = { to: string; e: ServerEvent };
/** every event published, with whom it went to */
function spy(): Sent[] {
  const sent: Sent[] = [];
  const events = h.app.core.events;
  const publish = events.publish.bind(events);
  events.publish = ((to: string, e: ServerEvent) => {
    sent.push({ to, e });
    return publish(to, e);
  }) as typeof events.publish;
  return sent;
}
/** the one notification to `to` titled `title`, and checks that the row it names went to `to` as a message before it */
function banner(sent: Sent[], to: string, title: string): Extract<ServerEvent, { type: "notification" }> {
  const at = sent.findIndex((s) => s.to === to && s.e.type === "notification" && s.e.title === title);
  expect(at).toBeGreaterThanOrEqual(0);
  expect(sent.filter((s) => s.to === to && s.e.type === "notification" && s.e.title === title)).toHaveLength(1);
  const n = sent[at]!.e as Extract<ServerEvent, { type: "notification" }>;
  if (n.messageId) {
    const pushed = sent.findIndex((s) => s.to === to && s.e.type === "message" && s.e.message.id === n.messageId);
    expect(pushed).toBeGreaterThanOrEqual(0);
    expect(pushed).toBeLessThan(at);
    expect((sent[pushed]!.e as Extract<ServerEvent, { type: "message" }>).threadId).toBe(n.threadId!);
  }
  return n;
}
const KST = (y: number, mo: number, d: number, hh: number, mi: number) => Date.UTC(y, mo - 1, d, hh - 9, mi);

async function befriend(sent?: Sent[]) {
  const a = await h.signup("alice", { displayName: "하늘", agentName: "깽이" });
  const b = await h.signup("bob", { displayName: "진우", agentName: "콩이" });
  const invite = (await (await h.req("POST", "/api/invites", { token: a.token })).json()) as InviteResponse;
  const before = sent?.length ?? 0;
  const acc = await h.req("POST", `/api/invites/${invite.token}/accept`, { token: b.token });
  expect(acc.status).toBe(201);
  return { a, b, friend: (await acc.json()) as Friend, before };
}

test("a new friend: the inviter's banner carries the id of the thread's event row", async () => {
  h = await makeHarness();
  const sent = spy();
  const { a, b, friend } = await befriend(sent);
  const n = banner(sent, a.session.user.id, "새 친구");
  const rows = (await (await h.req("GET", `/api/threads/${friend.threadId}/messages`, { token: a.token })).json()) as Message[];
  expect(rows.map((m) => m.role)).toEqual(["event"]);
  expect(n).toMatchObject({ threadId: friend.threadId, messageId: rows[0]!.id });
  expect(sent.some((s) => s.to === b.session.user.id && s.e.type === "notification")).toBe(false);
});

test("a friend's line: the friend's banner carries the line's id", async () => {
  h = await makeHarness();
  const { a, b, friend } = await befriend();
  const sent = spy();
  const res = await h.req("POST", `/api/threads/${friend.threadId}/messages`, { token: a.token, body: { text: "내일 저녁 어때?" } });
  expect(res.status).toBe(201);
  const { userMessage } = (await res.json()) as { userMessage: Message };
  expect(banner(sent, b.session.user.id, "하늘 님")).toMatchObject({ threadId: friend.threadId, messageId: userMessage.id });
  expect(h.db.getMessage(userMessage.id)!.thread_id).toBe(friend.threadId!);
});

test("a friend's agent's message (말 전하기): the friend's banner carries the id of the row in the shared thread", async () => {
  h = await makeHarness();
  const { a, b, friend } = await befriend();
  const sent = spy();
  h.turns.set(async (input) => {
    expect(await input.ctx.store.messageFriend("진우님", "내일 7시에 만나요")).toMatchObject({ ok: true });
    return outcome("진우 님에게 전했어요");
  });
  await readSse(await h.req("POST", `/api/threads/${a.session.mainThreadId}/messages`, { token: a.token, body: { text: "진우한테 내일 7시에 만나자고 전해줘" } }));
  const rows = (await (await h.req("GET", `/api/threads/${friend.threadId}/messages`, { token: b.token })).json()) as Message[];
  const relayed = rows.find((m) => m.text === "깽이: 내일 7시에 만나요")!;
  expect(banner(sent, b.session.user.id, "하늘 님의 모시")).toMatchObject({ threadId: friend.threadId, messageId: relayed.id });
});

test("a schedule's answer: its banner carries the id of the answer row in the schedule thread", async () => {
  h = await makeHarness({ config: { schedulerIntervalMs: 999_999 } });
  const { token, session } = await h.signup("haneul", { agentName: "깽이" });
  h.turns.set(async (input) => {
    await input.ctx.store.createSchedule({ title: "점심 알림", prompt: "점심 메뉴 추천해줘", rule: "daily@12:01" });
    return outcome("매일 12시 1분에 알려 드릴게요");
  });
  await readSse(await h.req("POST", `/api/threads/${session.mainThreadId}/messages`, { token, body: { text: "매일 점심 메뉴 추천해줘" } }));
  const sent = spy();
  h.clock.t = KST(2026, 11, 11, 12, 1);
  h.turns.set(async () => outcome("오늘은 김치찌개 어때요?"));
  expect(await h.app.scheduler.tick()).toEqual({ schedules: 1, briefings: 0 });
  const n = banner(sent, session.user.id, "점심 알림");
  const rows = (await (await h.req("GET", `/api/threads/${n.threadId}/messages`, { token })).json()) as Message[];
  expect(rows.map((m) => m.role)).toEqual(["event", "assistant"]);
  expect(n.messageId).toBe(rows[1]!.id);
});

test("a meeting's approval card: its banner carries the card row's id", async () => {
  h = await makeHarness();
  const a = await h.signup("haneul", { displayName: "하늘", agentName: "깽이" });
  const userId = a.session.user.id;
  const core = h.app.core;
  const threadId = "t_meet1";
  core.db.createThread({ id: threadId, ownerId: userId, kind: "call", title: "회의 참여", subtitle: "깽이의 회의 참여", icon: "people", now: core.now() }, [userId]);
  core.db.sql
    .query(`INSERT INTO meetings (id, user_id, thread_id, session_id, code, purpose, state, participants, started_at, joined_at) VALUES ('mt_1', ?, ?, 's1', 'abc-defg-hij', '', 'in_call', 4, ?, ?)`)
    .run(userId, threadId, core.now() - 600_000, core.now() - 590_000);
  let call = 0;
  const llm = {
    model: "fake-meet",
    async *stream(_req: LlmRequest): AsyncGenerator<LlmChunk> {
      if (call++ === 0) yield { type: "tool_calls", calls: [{ id: "c0", type: "function", function: { name: "msg_send", arguments: JSON.stringify({ provider: "slack", chat: "김대리", text: "회의 끝나고 봬요" }) } }] };
      else yield { type: "text", delta: "앱에 확인 카드를 올렸어요." };
      yield { type: "usage", usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 } };
    },
  };
  const msgSend: ToolDef = {
    name: "msg_send",
    description: "msg_send",
    parameters: { type: "object", properties: { provider: { type: "string" }, chat: { type: "string" }, text: { type: "string" } } },
    icon: "sparkles",
    title: () => "msg_send",
    approval: (x) => ({ title: `슬랙 ${String(x.chat)}에 보낼까요?`, detail: String(x.text) }),
    async run() {
      throw new Error("never runs in a meeting");
    },
  };
  core.deps.llm = { ...core.deps.llm!, meetClient: llm as never };
  core.deps.systemTools = () => [];
  core.deps.skills = { ...core.deps.skills, skillTools: () => [] };
  core.deps.hub = { ...core.deps.hub, tools: () => [msgSend] };
  const sent = spy();
  const r = await runMeetTurn(core, {
    userId,
    meetingId: "mt_1",
    threadId,
    utterance: "깽이야 김대리한테 회의 끝나고 보자고 슬랙 보내 줘",
    speaker: "이하늘",
    participants: 4,
    context: "방금 이하늘님이 부른 말",
    ownerName: "하늘",
    agentName: "깽이",
    onFiller: () => {},
    onSentence: () => {},
  });
  expect(r.proposals).toBe(1);
  const card = core.db.sql.query(`SELECT message_id FROM approvals WHERE user_id = ?`).all(userId) as { message_id: string }[];
  expect(card).toHaveLength(1);
  expect(banner(sent, userId, "회의에서 부탁받은 일")).toMatchObject({ threadId, messageId: card[0]!.message_id });
});

test("a remembered fact: no row behind its banner, so no messageId", async () => {
  h = await makeHarness();
  const { token, session } = await h.signup("haneul");
  const thread = (await (await h.req("POST", "/api/threads", { token, body: { kind: "task" } })).json()) as { id: string };
  const sent = spy();
  await readSse(await h.req("POST", `/api/threads/${thread.id}/messages`, { token, body: { text: "나 고양이 키우는 거 기억해" } }));
  await h.app.core.idle();
  const n = banner(sent, session.user.id, "기억했어요");
  expect(n).toMatchObject({ body: "사용자는 고양이를 키워요", threadId: thread.id });
  expect("messageId" in n).toBe(false);
});
