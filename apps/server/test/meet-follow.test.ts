/**
 * Meeting B (2026-11-12): the join card in the chat thread follows the meeting it started.
 *  - GET /api/threads/:origin/meet?approval=<id> → that meeting (threadId, note, reason); the approval must be the
 *    caller's and that thread's, else 404
 *  - the end summary is posted to the origin thread too, when it is the owner's own thread (never a shared one)
 * Through MeetHub against a minimal fake services/meet bot; synthetic people (하늘, 지현) and code.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { ToolContext } from "@pickle/agent";
import type { Logger } from "../src/log.ts";
import { meetTools, type ChatRequest } from "../src/meet.ts";
import { makeHarness, type Harness } from "./helpers.ts";

const CODE = "rak-mnpq-kud";

interface Bot {
  url: string;
  push(event: string, data: Record<string, unknown>): void;
  connected(): boolean;
  stop(): void;
}

/** POST /sessions → s1, SSE /sessions/s1/events, GET /sessions/s1, DELETE /sessions/s1 → ended(left) */
function startBot(): Bot {
  const enc = new TextEncoder();
  const clients = new Set<ReadableStreamDefaultController<Uint8Array>>();
  let state = "launching";
  const push = (event: string, data: Record<string, unknown>) => {
    if (event === "state") state = String(data.state);
    for (const c of clients) c.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
    if (event === "ended") {
      for (const c of clients) c.close();
      clients.clear();
    }
  };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    fetch(req) {
      const u = new URL(req.url);
      if (req.method === "POST" && u.pathname === "/sessions") return Response.json({ id: "s1", state: "launching" }, { status: 201 });
      if (u.pathname === "/sessions/s1/events") {
        let me: ReadableStreamDefaultController<Uint8Array>;
        return new Response(
          new ReadableStream<Uint8Array>({
            start(c) {
              me = c;
              clients.add(c);
              c.enqueue(enc.encode(`event: state\ndata: ${JSON.stringify({ state })}\n\n`));
            },
            cancel() {
              clients.delete(me);
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      if (u.pathname === "/sessions/s1" && req.method === "DELETE") {
        setTimeout(() => {
          push("state", { state: "ended" });
          push("ended", { reason: "left" });
        }, 10);
        return Response.json({ ok: true });
      }
      if (u.pathname === "/sessions/s1") return Response.json({ id: "s1", state, title: null });
      return Response.json({ ok: true });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, push, connected: () => clients.size > 0, stop: () => server.stop(true) };
}

async function until(cond: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(5);
  }
}

let h: Harness | null = null;
let bot: Bot | null = null;
afterEach(async () => {
  await h?.close();
  bot?.stop();
  h = bot = null;
});

async function setup() {
  bot = startBot();
  h = await makeHarness({ config: { meet: { url: bot.url } } });
  h.app.core.meet.timings.reconnectMs = 20;
  h.app.core.meet.timings.reconnectMaxMs = 50;
  const a = await h.signup("haneul");
  return { h, bot, userId: a.session.user.id, token: a.token, main: a.session.mainThreadId };
}

/** the join card's approval, approved just now in `threadId` (what POST /api/approvals/:id leaves behind); its spec
 *  carries `meet.code` as joinMeetTool's approval() writes it */
function approvedJoin(h: Harness, userId: string, threadId: string, id: string, code = CODE) {
  const now = h.clock.now();
  const call = { id: `call_${id}`, type: "function", function: { name: "sys_join_meet", arguments: JSON.stringify({ url: `https://meet.google.com/${code}` }) } };
  const specJson = JSON.stringify({ title: "Google Meet 회의에 참여할까요?", detail: "", meet: { code } });
  h.db.insertApproval({ id, userId, threadId, messageId: `m_${id}`, callJson: JSON.stringify(call), priorJson: "[]", specJson, now, expiresAt: now + 30 * 60_000 });
  expect(h.db.resolveApproval(userId, id, "approved", now, null, false)).toBe(true);
}

/** the resumed turn runs the join in the card's thread → the '회의 참여' thread, once the bot is in the call */
async function joinFrom(h: Harness, bot: Bot, userId: string, originThreadId: string): Promise<string> {
  const join = meetTools(h.app.core, userId).find((t) => t.name === "sys_join_meet")!;
  const ctx = { userId, threadId: originThreadId, agentName: "깽이", displayName: "하늘", signal: new AbortController().signal, status: () => {}, now: () => new Date() } as unknown as ToolContext;
  expect((await join.run({ url: `https://meet.google.com/${CODE}`, purpose: "주간 회의 받아 적기" }, ctx)).ok).toBe(true);
  await until(() => bot.connected());
  bot.push("state", { state: "waiting_admission" });
  bot.push("state", { state: "in_call" });
  await until(() => h.app.core.meet.active(userId)?.state === "in_call");
  return h.app.core.meet.active(userId)!.thread_id;
}

const get = async (h: Harness, token: string, path: string) => {
  const res = await h.req("GET", path, { token });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
};
const texts = (h: Harness, threadId: string) =>
  (h.db.sql.query(`SELECT role, text FROM messages WHERE thread_id = ? ORDER BY rowid`).all(threadId) as { role: string; text: string }[]).map((r) => r.text);

describe("GET /api/threads/:id/meet?approval=", () => {
  test("the meeting the join card in this thread started, through its states; the full code never leaves", async () => {
    const { h, bot, userId, token, main } = await setup();
    approvedJoin(h, userId, main, "ap_join");
    // approved, the join not started yet: no meeting (the card shows its receipt)
    expect(await get(h, token, `/api/threads/${main}/meet?approval=ap_join`)).toEqual({ status: 200, body: { meeting: null } });

    const meetThread = await joinFrom(h, bot, userId, main);
    const live = await get(h, token, `/api/threads/${main}/meet?approval=ap_join`);
    expect(live.status).toBe(200);
    expect(live.body.meeting).toMatchObject({
      state: "in_call",
      live: true,
      code: "rak-****-kud",
      threadId: meetThread,
      note: "회의에 들어왔어요. 지금부터 받아 적을게요.",
      reason: null,
      joinedAt: expect.any(Number),
      endedAt: null,
    });
    expect(JSON.stringify(live.body)).not.toContain("mnpq");
    // without ?approval= the main thread still has no meeting of its own; the meeting thread still answers as before
    expect((await get(h, token, `/api/threads/${main}/meet`)).body).toEqual({ meeting: null });
    expect((await get(h, token, `/api/threads/${meetThread}/meet`)).body.meeting).toMatchObject({ state: "in_call", threadId: meetThread });

    // the card's 회의에서 내보내기 leaves through the meeting thread; the card then reads the end
    expect((await h.req("POST", `/api/threads/${meetThread}/meet/leave`, { token })).status).toBe(200);
    await until(() => h.app.core.meet.active(userId) === null);
    const left = await get(h, token, `/api/threads/${main}/meet?approval=ap_join`);
    expect(left.body.meeting).toMatchObject({ state: "ended", live: false, note: "회의에서 나왔어요.", reason: "left", endedAt: expect.any(Number) });
  });

  test("an approval that isn't the caller's, isn't this thread's, or doesn't exist is 404", async () => {
    const { h, bot, userId, token, main } = await setup();
    approvedJoin(h, userId, main, "ap_join");
    await joinFrom(h, bot, userId, main);
    const other = await h.signup("jiyeon", { ip: "10.0.0.9" });

    // someone else: my thread is 404 as a thread; their own thread with my approval is 404 as an approval
    expect((await get(h, other.token, `/api/threads/${main}/meet?approval=ap_join`)).status).toBe(404);
    const foreign = await get(h, other.token, `/api/threads/${other.session.mainThreadId}/meet?approval=ap_join`);
    expect(foreign).toEqual({ status: 404, body: { error: "approval_not_found", message: "승인 요청을 찾을 수 없어요" } });

    // mine, but asked from another of my threads
    h.db.createThread({ id: "t_side", ownerId: userId, kind: "task", title: "다른 대화", subtitle: "", icon: "doc", now: h.clock.now() }, [userId]);
    expect((await get(h, token, `/api/threads/t_side/meet?approval=ap_join`)).status).toBe(404);
    expect((await get(h, token, `/api/threads/${main}/meet?approval=ap_nope`)).status).toBe(404);
  });

  test("a join outside an approval (or an older row) links to nothing, and older approvals don't claim a new meeting", async () => {
    const { h, bot, userId, token, main } = await setup();
    approvedJoin(h, userId, main, "ap_old");
    h.clock.t += 11 * 60_000; // decided long before this join started
    await joinFrom(h, bot, userId, main);
    expect((await get(h, token, `/api/threads/${main}/meet?approval=ap_old`)).body).toEqual({ meeting: null });
    expect(h.db.sql.query(`SELECT origin_thread_id, approval_id FROM meetings WHERE user_id = ?`).get(userId)).toEqual({ origin_thread_id: main, approval_id: null });
  });

  test("the newest unclaimed join for this meeting's code claims it: not an older one whose join failed, not another code's", async () => {
    const { h, bot, userId, main } = await setup();
    approvedJoin(h, userId, main, "ap_failed"); // approved, but its join never started a meeting
    h.clock.t += 60_000;
    approvedJoin(h, userId, main, "ap_retry");
    h.clock.t += 60_000;
    approvedJoin(h, userId, main, "ap_other", "abc-defg-hij"); // newer, but for another meeting
    await joinFrom(h, bot, userId, main);
    expect(h.db.sql.query(`SELECT approval_id FROM meetings WHERE user_id = ?`).get(userId)).toEqual({ approval_id: "ap_retry" });
  });
});

describe("the end summary", () => {
  function summarizer(h: Harness) {
    h.app.core.deps.llm!.chat = async function* (i: ChatRequest) {
      if (i.system.includes("회의 요약")) {
        i.onUsage?.(100);
        yield "**정한 것**\n- 출시일은 12월 2일\n\n**할 일**\n- 지현: 앱 스토어 스크린샷";
        return;
      }
      yield "네";
    };
  }
  function captureLogs(h: Harness): string[] {
    const lines: string[] = [];
    const rec = (level: string) => (event: string, fields?: Record<string, unknown>) => lines.push(`${level} ${event} ${JSON.stringify(fields ?? {})}`);
    const log: Logger = { info: rec("info"), warn: rec("warn"), error: rec("error") };
    h.app.core.log = log;
    return lines;
  }
  async function hold(h: Harness, bot: Bot, userId: string) {
    bot.push("transcript", { seq: 1, text: "출시일은 12월 2일로 하죠.", startMs: 1000, endMs: 2500, speaker: "지현" });
    bot.push("transcript", { seq: 2, text: "스크린샷은 제가 만들게요.", startMs: 3000, endMs: 4200, speaker: "지현" });
    await Bun.sleep(50);
    bot.push("ended", { reason: "meeting_ended" });
    await until(() => h.app.core.meet.active(userId) === null);
    await h.app.core.idle();
  }

  test("lands under the join card in the owner's thread too, same text; the logs carry no part of it", async () => {
    const { h, bot, userId, token, main } = await setup();
    summarizer(h);
    const logs = captureLogs(h);
    approvedJoin(h, userId, main, "ap_join");
    const meetThread = await joinFrom(h, bot, userId, main);
    await hold(h, bot, userId);

    const inMeeting = texts(h, meetThread).filter((t) => t.startsWith("**회의 요약**"));
    const inMain = texts(h, main).filter((t) => t.startsWith("**회의 요약**"));
    expect(inMeeting).toHaveLength(1);
    expect(inMain).toEqual(inMeeting);
    expect(inMain[0]).toContain("출시일은 12월 2일");
    expect(texts(h, main).join("\n")).not.toContain("mnpq"); // stored text keeps the masked code only
    expect((await get(h, token, `/api/threads/${main}/meet?approval=ap_join`)).body.meeting).toMatchObject({ state: "ended", note: "회의가 끝나서 나왔어요.", reason: "meeting_ended" });

    const all = logs.join("\n");
    for (const secret of [CODE, "지현", "출시일", "스크린샷", "하늘"]) expect(all).not.toContain(secret);
  });

  test("never into a shared thread: a join asked in a friend thread keeps its summary in the 회의 참여 thread", async () => {
    const { h, bot, userId } = await setup();
    summarizer(h);
    const friend = await h.signup("jiyeon", { ip: "10.0.0.9" });
    h.db.createThread({ id: "t_shared", ownerId: userId, kind: "friend", title: "지연", subtitle: "", icon: "people", now: h.clock.now() }, [userId, friend.session.user.id]);
    approvedJoin(h, userId, "t_shared", "ap_shared");
    const meetThread = await joinFrom(h, bot, userId, "t_shared");
    await hold(h, bot, userId);
    expect(texts(h, meetThread).some((t) => t.startsWith("**회의 요약**"))).toBe(true);
    expect(texts(h, "t_shared").some((t) => t.startsWith("**회의 요약**"))).toBe(false);
  });
});
