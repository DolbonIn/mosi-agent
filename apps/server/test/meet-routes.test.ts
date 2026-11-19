/**
 * GET /api/threads/:id/meet and POST /api/threads/:id/meet/leave: the meeting behind a '회의 참여' thread and
 * taking 모시 out of it, through MeetHub against a minimal fake services/meet bot.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { ToolContext } from "@pickle/agent";
import { meetTools } from "../src/meet.ts";
import { makeHarness, type Harness } from "./helpers.ts";

const CODE = "abc-defg-hij";

interface Bot {
  url: string;
  calls: string[];
  state: string;
  push(event: string, data: Record<string, unknown>): void;
  stop(): void;
}

/** POST /sessions → s1, SSE /sessions/s1/events, GET /sessions/s1, DELETE /sessions/s1 → ended */
function startBot(): Bot {
  const enc = new TextEncoder();
  const clients = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const bot: Bot = {
    url: "",
    calls: [],
    state: "launching",
    push(event, data) {
      if (event === "state") bot.state = String(data.state);
      for (const c of clients) c.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      if (event === "ended") {
        for (const c of clients) c.close();
        clients.clear();
      }
    },
    stop: () => {},
  };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    fetch(req) {
      const u = new URL(req.url);
      bot.calls.push(`${req.method} ${u.pathname}`);
      if (req.method === "POST" && u.pathname === "/sessions") return Response.json({ id: "s1", state: "launching" }, { status: 201 });
      if (u.pathname === "/sessions/s1/events") {
        let me: ReadableStreamDefaultController<Uint8Array>;
        return new Response(
          new ReadableStream<Uint8Array>({
            start(c) {
              me = c;
              clients.add(c);
              c.enqueue(enc.encode(`event: state\ndata: ${JSON.stringify({ state: bot.state })}\n\n`));
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
          bot.push("state", { state: "ended" });
          bot.push("ended", { reason: "left" });
        }, 10);
        return Response.json({ ok: true });
      }
      if (u.pathname === "/sessions/s1") return Response.json({ id: "s1", state: bot.state, title: null });
      return Response.json({ error: "not_found" }, { status: 404 });
    },
  });
  bot.url = `http://127.0.0.1:${server.port}`;
  bot.stop = () => server.stop(true);
  return bot;
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

/** join through the tool (approval already given) and bring the bot into the call → the 회의 참여 thread id */
async function joinLive(h: Harness, bot: Bot, userId: string): Promise<string> {
  const join = meetTools(h.app.core, userId).find((t) => t.name === "sys_join_meet")!;
  const ctx = { userId, threadId: "t_main", agentName: "모시", displayName: "하늘", signal: new AbortController().signal, status: () => {}, now: () => new Date() } as unknown as ToolContext;
  const r = await join.run({ url: `https://meet.google.com/${CODE}`, purpose: "주간 회의 받아 적기" }, ctx);
  expect(r.ok).toBe(true);
  await until(() => bot.calls.some((c) => c.endsWith("/sessions/s1/events")));
  bot.push("state", { state: "waiting_admission" });
  bot.push("state", { state: "in_call" });
  await until(() => h.app.core.meet.active(userId)?.state === "in_call");
  return h.app.core.meet.active(userId)!.thread_id;
}

const get = async (h: Harness, token: string, threadId: string) => {
  const res = await h.req("GET", `/api/threads/${threadId}/meet`, { token });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
};
const leave = async (h: Harness, token: string, threadId: string) => {
  const res = await h.req("POST", `/api/threads/${threadId}/meet/leave`, { token });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
};

describe("GET /api/threads/:id/meet", () => {
  test("null for a thread without a meeting; 404 for an unknown thread; 401 without a token", async () => {
    const { h, token, main } = await setup();
    expect(await get(h, token, main)).toEqual({ status: 200, body: { meeting: null } });
    expect((await get(h, token, "t_nope")).status).toBe(404);
    expect((await h.req("GET", `/api/threads/${main}/meet`)).status).toBe(401);
  });

  test("a live meeting: state, live, masked code, purpose and times — the full code never leaves the server", async () => {
    const { h, bot, userId, token } = await setup();
    const threadId = await joinLive(h, bot, userId);
    const row = h.app.core.meet.active(userId)!;
    const r = await get(h, token, threadId);
    expect(r.status).toBe(200);
    expect(r.body.meeting).toEqual({
      id: row.id,
      state: "in_call",
      live: true,
      code: "abc-****-hij",
      title: null,
      purpose: "주간 회의 받아 적기",
      startedAt: row.started_at,
      joinedAt: expect.any(Number),
      endedAt: null,
      threadId,
      note: "회의에 들어왔어요. 지금부터 받아 적을게요.",
      reason: null,
    });
    expect(JSON.stringify(r.body)).not.toContain("defg");
  });
});

describe("POST /api/threads/:id/meet/leave", () => {
  test("leaves the live meeting of that thread; after that it is ended and a second leave is the same ok (idempotent)", async () => {
    const { h, bot, userId, token, main } = await setup();
    const threadId = await joinLive(h, bot, userId);

    // not this thread's meeting (the main thread has none): nothing happens
    expect(await leave(h, token, main)).toEqual({ status: 200, body: { ok: true, left: false, state: null } });
    expect(h.app.core.meet.active(userId)?.state).toBe("in_call");

    expect(await leave(h, token, threadId)).toEqual({ status: 200, body: { ok: true, left: true, state: "ended" } });
    expect(bot.calls).toContain("DELETE /sessions/s1");
    expect(h.app.core.meet.active(userId)).toBeNull();
    const after = await get(h, token, threadId);
    expect(after.body.meeting).toMatchObject({ state: "ended", live: false, endedAt: expect.any(Number) });

    const calls = bot.calls.length;
    expect(await leave(h, token, threadId)).toEqual({ status: 200, body: { ok: true, left: false, state: "ended" } });
    expect(await leave(h, token, threadId)).toEqual({ status: 200, body: { ok: true, left: false, state: "ended" } });
    expect(bot.calls.length).toBe(calls); // the retries never reach the bot
  });

  test("an older meeting's thread can't end the meeting that is live now", async () => {
    const { h, bot, userId, token } = await setup();
    const now = h.clock.now();
    h.db.createThread({ id: "t_old", ownerId: userId, kind: "call", title: "회의 참여", subtitle: "", icon: "people", now: now - 3_600_000 }, [userId]);
    h.db.sql
      .query(
        `INSERT INTO meetings (id, user_id, thread_id, session_id, code, purpose, state, reason, participants, started_at, joined_at, ended_at, title)
         VALUES ('mt_old', ?, 't_old', 's0', 'xyz-abcd-efg', '', 'ended', 'meeting_ended', 3, ?, ?, ?, '지난 회의')`,
      )
      .run(userId, now - 3_600_000, now - 3_500_000, now - 1_800_000);
    await joinLive(h, bot, userId);

    expect((await get(h, token, "t_old")).body.meeting).toMatchObject({ id: "mt_old", state: "ended", live: false, code: "xyz-****-efg", title: "지난 회의" });
    expect(await leave(h, token, "t_old")).toEqual({ status: 200, body: { ok: true, left: false, state: "ended" } });
    expect(h.app.core.meet.active(userId)?.state).toBe("in_call");
    expect(bot.calls).not.toContain("DELETE /sessions/s1");
  });

  test("someone else's 회의 참여 thread is 404 for both routes, and their meeting stays live", async () => {
    const { h, bot, userId } = await setup();
    const threadId = await joinLive(h, bot, userId);
    const other = await h.signup("jinwoo", { ip: "10.0.0.9" });
    expect((await get(h, other.token, threadId)).status).toBe(404);
    const r = await leave(h, other.token, threadId);
    expect(r).toEqual({ status: 404, body: { error: "thread_not_found", message: "대화를 찾을 수 없어요" } });
    expect(h.app.core.meet.active(userId)?.state).toBe("in_call");
  });
});
