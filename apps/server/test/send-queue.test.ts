/**
 * The first message of the owner's own new thread waits for the agent instead of 409 (2026-11-12): Explore's 맡기기
 * posts delegate and then sends the prompt, and a first message right after sign-up races the same way. The stream
 * answers at once (`start`, then the queued status); the turn runs right after the one holding the agent, with the
 * same messageId. Threads that already hold a request keep the 409.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { DelegateResponse, Message } from "@pickle/protocol";
import { hasCancelNote } from "../src/history.ts";
import { TEMPLATE_HINT_HEAD } from "../src/explore.ts";
import { quotaDay } from "../src/kst.ts";
import { MAX_QUEUED_TURNS, QUEUED_STATUS, queuedTurns } from "../src/turns.ts";
import { makeHarness, outcome, readSse, sseReader, type Harness } from "./helpers.ts";

let h: Harness;
beforeEach(async () => {
  h = await makeHarness();
});
afterEach(async () => {
  await h.close();
});

function gate() {
  let open!: () => void;
  const p = new Promise<void>((r) => (open = r));
  return { p, open };
}

/** the agent busy in the main thread until `g` opens; other threads answer "맡긴 일 답 <n>" */
async function busyInMain() {
  const a = await h.signup("haneul", { agentName: "깽이" });
  const main = a.session.mainThreadId;
  const g = gate();
  const steeredIntoMain: string[] = [];
  let n = 0;
  h.turns.set(async (input, emit) => {
    if (input.ctx.threadId === main) {
      emit({ type: "text", delta: "..." });
      await g.p;
      steeredIntoMain.push(...input.steer!());
      return outcome("메인 답");
    }
    n++;
    emit({ type: "text", delta: `맡긴 일 답 ${n}` });
    return outcome(`맡긴 일 답 ${n}`);
  });
  const first = await h.req("POST", `/api/threads/${main}/messages`, { token: a.token, body: { text: "오늘 할 일 정리해 줘" } });
  expect(first.status).toBe(200);
  return { a, main, g, first, steeredIntoMain };
}

async function delegate(token: string, template = "gov-benefits"): Promise<DelegateResponse> {
  const res = await h.req("POST", `/api/explore/${template}/delegate`, { token });
  expect(res.status).toBe(201);
  return (await res.json()) as DelegateResponse;
}

const messages = async (token: string, threadId: string) => (await (await h.req("GET", `/api/threads/${threadId}/messages`, { token })).json()) as Message[];

describe("a new thread's first message queues behind the running turn", () => {
  test("Explore 맡기기 while the main thread's turn runs: start + status at once, the turn right after, same messageId", async () => {
    const { a, main, g, first, steeredIntoMain } = await busyInMain();
    const d = await delegate(a.token);
    const res = await h.req("POST", `/api/threads/${d.thread.id}/messages`, { token: a.token, body: { text: d.prompt } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const ev = sseReader(res);
    const start = await ev.next<{ type: "start"; threadId: string; userMessage: Message; messageId: string }>((e) => e.type === "start");
    expect(start).toMatchObject({ threadId: d.thread.id, userMessage: { role: "user", text: d.prompt } });
    expect(await ev.next((e) => e.type === "status")).toEqual({ type: "status", text: QUEUED_STATUS });
    // stored and waiting: only the main turn has run, the prompt sits in its own thread
    expect(h.turns.inputs).toHaveLength(1);
    expect(queuedTurns(h.app.core, a.session.user.id)).toBe(1);
    expect((await messages(a.token, d.thread.id)).map((m) => [m.role, m.text])).toEqual([["user", d.prompt]]);

    g.open();
    await readSse(first);
    const done = await ev.next<{ type: "done"; message: Message }>((e) => e.type === "done", 2000);
    expect(done!.message).toMatchObject({ id: start!.messageId, role: "assistant", text: "맡긴 일 답 1" });
    expect(await ev.next((e) => e.type === "start", 50)).toBeNull(); // one `start` per stream
    await h.app.core.idle();

    // its own turn in its own thread: the prompt was never steered into the main turn
    expect(steeredIntoMain).toEqual([]);
    expect(h.turns.inputs[1]!.ctx.threadId).toBe(d.thread.id);
    expect(h.turns.inputs[1]!.userText?.startsWith(`${d.prompt}\n\n${TEMPLATE_HINT_HEAD}\n`)).toBe(true); // + the template's how-to
    expect((await messages(a.token, main)).some((m) => m.text === d.prompt)).toBe(false);
    expect((await messages(a.token, d.thread.id)).map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(queuedTurns(h.app.core, a.session.user.id)).toBe(0);
    expect(h.app.core.activeTurns.size).toBe(0);
  });

  test("a first message right after sign-up queues behind a schedule turn too", async () => {
    const { token, session } = await h.signup("haneul");
    await h.req("POST", "/api/schedules", { token, body: { title: "알림", prompt: "알려줘", rule: "daily@12:05" } });
    h.clock.t = Date.UTC(2026, 10, 11, 3, 5);
    const g = gate();
    h.turns.set(async (input) => {
      if (input.userText === "알려줘") await g.p;
      return outcome(input.userText === "알려줘" ? "예약 답" : "첫 답");
    });
    const tick = h.app.scheduler.tick();
    await Bun.sleep(5);
    const res = await h.req("POST", `/api/threads/${session.mainThreadId}/messages`, { token, body: { text: "첫 질문" } });
    expect(res.status).toBe(200);
    const ev = sseReader(res);
    expect(await ev.next((e) => e.type === "status")).toEqual({ type: "status", text: QUEUED_STATUS });
    g.open();
    expect(await tick).toEqual({ schedules: 1, briefings: 0 });
    expect((await ev.next<{ type: "done"; message: Message }>((e) => e.type === "done", 2000))!.message.text).toBe("첫 답");
    await h.app.core.idle();
    expect(h.app.core.activeTurns.size).toBe(0);
  });

  test("a thread that already holds a request still answers 409 busy", async () => {
    const a = await h.signup("haneul", { agentName: "깽이" });
    const d = await delegate(a.token);
    await readSse(await h.req("POST", `/api/threads/${d.thread.id}/messages`, { token: a.token, body: { text: d.prompt } }));
    const g = gate();
    h.turns.set(async () => {
      await g.p;
      return outcome("메인 답");
    });
    const first = await h.req("POST", `/api/threads/${a.session.mainThreadId}/messages`, { token: a.token, body: { text: "오늘 할 일" } });
    const again = await h.req("POST", `/api/threads/${d.thread.id}/messages`, { token: a.token, body: { text: "하나 더" } });
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: "busy", message: "깽이가 다른 일을 하고 있어요. 끝나면 다시 보내 주세요." });
    g.open();
    await readSse(first);
    expect((await messages(a.token, d.thread.id)).some((m) => m.text === "하나 더")).toBe(false);
  });

  test("Stop while queued: nothing runs, the request row gets the cancel note, the agent is free again", async () => {
    const { a, g, first } = await busyInMain();
    const d = await delegate(a.token);
    const ev = sseReader(await h.req("POST", `/api/threads/${d.thread.id}/messages`, { token: a.token, body: { text: d.prompt } }));
    expect(await ev.next((e) => e.type === "status")).not.toBeNull();
    await ev.cancel(); // the app's Stop aborts the fetch
    g.open();
    await readSse(first);
    await h.app.core.idle();
    expect(h.turns.inputs).toHaveLength(1); // no model call for the queued send
    const rows = h.db.sql.query(`SELECT role, llm_json FROM messages WHERE thread_id = ? ORDER BY rowid`).all(d.thread.id) as { role: string; llm_json: string | null }[];
    expect(rows.map((r) => r.role)).toEqual(["user"]);
    expect(hasCancelNote(JSON.parse(rows[0]!.llm_json ?? "null"))).toBe(true);
    expect(h.app.core.activeTurns.size).toBe(0);
    expect(h.launcher.leases.size).toBe(0);
    expect(queuedTurns(h.app.core, a.session.user.id)).toBe(0);
  });

  test(`at most ${MAX_QUEUED_TURNS} wait per user (the next is 409); they run in the order they came`, async () => {
    const { a, g, first } = await busyInMain();
    const threads: string[] = [];
    const streams: ReturnType<typeof sseReader>[] = [];
    for (let i = 0; i < MAX_QUEUED_TURNS; i++) {
      const d = await delegate(a.token);
      threads.push(d.thread.id);
      const res = await h.req("POST", `/api/threads/${d.thread.id}/messages`, { token: a.token, body: { text: `맡긴 일 ${i + 1}` } });
      expect(res.status).toBe(200);
      streams.push(sseReader(res));
    }
    const extra = await delegate(a.token);
    expect((await h.req("POST", `/api/threads/${extra.thread.id}/messages`, { token: a.token, body: { text: "넷째" } })).status).toBe(409);
    expect(await messages(a.token, extra.thread.id)).toEqual([]);

    g.open();
    await readSse(first);
    for (const s of streams) expect(await s.next((e) => e.type === "done", 2000)).not.toBeNull();
    await h.app.core.idle();
    expect(h.turns.inputs.slice(1).map((i) => i.ctx.threadId)).toEqual(threads);
    expect(h.turns.inputs.slice(1).map((i) => i.userText)).toEqual(["맡긴 일 1", "맡긴 일 2", "맡긴 일 3"]);
  });

  test("the turn it waited for used up the quota: an error instead of the turn", async () => {
    const { a, g, first } = await busyInMain();
    const d = await delegate(a.token);
    const ev = sseReader(await h.req("POST", `/api/threads/${d.thread.id}/messages`, { token: a.token, body: { text: d.prompt } }));
    expect(await ev.next((e) => e.type === "status")).not.toBeNull();
    h.db.addUsage(a.session.user.id, quotaDay(h.clock.now()), h.app.core.cfg.dailyTokens);
    g.open();
    await readSse(first);
    expect(await ev.next((e) => e.type === "error", 2000)).toMatchObject({ type: "error", error: "quota_exceeded" });
    await h.app.core.idle();
    expect(h.turns.inputs).toHaveLength(1);
    expect(h.launcher.leases.size).toBe(0);
  });
});
