/**
 * Every device of the person gets the person's rows and the agent's answers as `message` events, not only the device
 * that sent the line: a line that starts a turn, a line steered into a running one (202), the first line of a new thread
 * that waits for the agent, the answer of a turn the app started, a friend-thread line, and the "became friends" event
 * row of an invite the person accepted. The device that sent the
 * line gets the push too (one /api/events stream per device, fanned out per person); it merges it by id with what its
 * request already returned (start / 202 / done / 201). Before, the person's other devices got only thread_updated, so
 * one device showed "오늘 날씨 알려줘" → error → the umbrella answer with the umbrella line missing (DD 1814).
 * A pushed line that was steered into the running turn carries `steered: true`, so the other device can show its steer
 * receipt as the sending one does (and place a failed turn's error row above it); no other row carries the field, and
 * page reads never do.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AgentEvent, Friend, InviteResponse, Message, ServerEvent, SteeredResponse, Thread } from "@pickle/protocol";
import { makeHarness, outcome, readSse, sseReader, type Harness } from "./helpers.ts";

let h: Harness;
beforeEach(async () => {
  h = await makeHarness();
});
afterEach(async () => {
  await h.close();
});

const rate = () => Object.assign(new Error("rate"), { name: "UpstreamError", status: 429 });
const gate = () => {
  let open!: () => void;
  const p = new Promise<void>((r) => (open = r));
  return { p, open };
};

/** a device of the person: its /api/events stream */
async function device(token: string) {
  const ev = sseReader(await h.req("GET", `/api/events?token=${token}`));
  await ev.next((e) => e.type === "hello");
  return {
    /**
     * message, turn_error and steers_dropped events since the last call, in order: "<role> <text> <id>" for a message,
     * with " steered=<value>" after it whenever the pushed message has the field at all
     */
    async got(waitMs = 60): Promise<string[]> {
      const out: string[] = [];
      for (;;) {
        const e = await ev.next<ServerEvent>((x) => x.type === "message" || x.type === "turn_error" || x.type === "steers_dropped", waitMs);
        if (!e) return out;
        if (e.type === "message") out.push(`${e.message.role} ${e.message.text} ${e.message.id}${"steered" in e.message ? ` steered=${e.message.steered}` : ""}`);
        else if (e.type === "turn_error") out.push(`turn_error ${e.threadId}`);
        else if (e.type === "steers_dropped") out.push(`steers_dropped ${e.messageIds.join(",")}`);
      }
    },
    cancel: () => ev.cancel(),
  };
}

async function steer(token: string, threadId: string, text: string): Promise<string> {
  const res = await h.req("POST", `/api/threads/${threadId}/messages`, { token, body: { text } });
  expect(res.status).toBe(202);
  const { userMessage } = (await res.json()) as SteeredResponse;
  expect("steered" in userMessage).toBe(false); // the 202 says so itself
  return userMessage.id;
}

/** the thread's rows as a page read returns them: none carries `steered` */
async function pageHasNoSteered(token: string, threadId: string) {
  const page = (await (await h.req("GET", `/api/threads/${threadId}/messages`, { token })).json()) as Message[];
  expect(page.length).toBeGreaterThan(0);
  expect(page.filter((m) => "steered" in m)).toEqual([]);
}

describe("the person's rows reach every device of theirs", () => {
  test("a line that starts a turn, then its answer: both on every device, with the ids the sending stream got", async () => {
    const { token, session } = await h.signup("haneul");
    const tid = session.mainThreadId;
    const phone = await device(token);
    const laptop = await device(token);
    h.turns.set(async () => outcome("오늘은 맑아요"));
    const evs = (await readSse(await h.req("POST", `/api/threads/${tid}/messages`, { token, body: { text: "오늘 날씨 알려줘" } }))) as AgentEvent[];
    const start = evs.find((e) => e.type === "start") as Extract<AgentEvent, { type: "start" }>;
    const done = evs.find((e) => e.type === "done") as Extract<AgentEvent, { type: "done" }>;
    await h.app.core.idle();
    const want = [`user 오늘 날씨 알려줘 ${start.userMessage!.id}`, `assistant 오늘은 맑아요 ${done.message.id}`];
    expect(await phone.got()).toEqual(want);
    expect(await laptop.got()).toEqual(want);
    await phone.cancel();
    await laptop.cancel();
  });

  test("a line steered into the running turn (202): on every device with the 202's id, before the answer", async () => {
    const { token, session } = await h.signup("haneul");
    const tid = session.mainThreadId;
    const other = await device(token);
    const g = gate();
    h.turns.set(async (input) => {
      await g.p;
      input.steer!();
      return outcome("둘 다 답할게요");
    });
    const r = sseReader(await h.req("POST", `/api/threads/${tid}/messages`, { token, body: { text: "첫 질문" } }));
    const start = await r.next<Extract<AgentEvent, { type: "start" }>>((e) => e.type === "start");
    const s = await steer(token, tid, "오늘 우산 필요해?");
    expect(await other.got()).toEqual([`user 첫 질문 ${start!.userMessage!.id}`, `user 오늘 우산 필요해? ${s} steered=true`]); // while the turn still runs
    g.open();
    const done = await r.next<Extract<AgentEvent, { type: "done" }>>((e) => e.type === "done");
    await h.app.core.idle();
    expect(await other.got()).toEqual([`assistant 둘 다 답할게요 ${done!.message.id}`]);
    await pageHasNoSteered(token, tid);
    await other.cancel();
  });

  test("a new thread's first line that waits behind the running turn: on every device at once, its answer later", async () => {
    const { token, session } = await h.signup("haneul");
    const main = session.mainThreadId;
    const g = gate();
    h.turns.set(async (input) => {
      if (input.ctx.threadId === main) {
        await g.p;
        return outcome("메인 답");
      }
      return outcome("맡긴 일 답");
    });
    const first = sseReader(await h.req("POST", `/api/threads/${main}/messages`, { token, body: { text: "오늘 할 일 정리해 줘" } }));
    await first.next((e) => e.type === "start");
    const task = (await (await h.req("POST", "/api/threads", { token, body: { kind: "task", title: "할 일" } })).json()) as Thread;
    const other = await device(token);
    const q = sseReader(await h.req("POST", `/api/threads/${task.id}/messages`, { token, body: { text: "지원금 찾아줘" } }));
    const start = await q.next<Extract<AgentEvent, { type: "start" }>>((e) => e.type === "start");
    expect(await other.got()).toEqual([`user 지원금 찾아줘 ${start!.userMessage!.id}`]); // the main turn still holds the agent
    g.open();
    await h.app.core.idle();
    const rest = await other.got();
    expect(rest.map((x) => x.split(" ").slice(0, 2).join(" "))).toEqual(["assistant 메인", "assistant 맡긴"]);
    await other.cancel();
  });

  test("DD 1814: one device's line starts a turn, the other steers a line in, the turn fails without reading it, a follow-up answers it: both devices get the rows in the same order", async () => {
    const { token, session } = await h.signup("haneul");
    const tid = session.mainThreadId;
    const a = await device(token);
    const b = await device(token);
    const g = gate();
    h.turns.set(async () => {
      await g.p;
      throw rate(); // never polled the steer: the umbrella line is left for a follow-up turn
    });
    const r = sseReader(await h.req("POST", `/api/threads/${tid}/messages`, { token, body: { text: "오늘 날씨 알려줘" } })); // device B
    const start = await r.next<Extract<AgentEvent, { type: "start" }>>((e) => e.type === "start");
    const u = await steer(token, tid, "오늘 우산 필요해?"); // device A
    h.turns.set(async () => outcome("오늘은 맑아서 우산은 필요 없어요."));
    g.open();
    expect(await r.next((e) => e.type === "error")).toMatchObject({ error: "upstream_rate_limited" }); // B's stream alone, as before
    await h.app.core.idle();
    const got = await a.got();
    // B (the device that sent the weather line) learns the umbrella line was steered in, as A knows from its 202
    expect(got.slice(0, 2)).toEqual([`user 오늘 날씨 알려줘 ${start!.userMessage!.id}`, `user 오늘 우산 필요해? ${u} steered=true`]);
    expect(got.slice(2).map((x) => x.replace(/ m_\S+$/, ""))).toEqual(["assistant 오늘은 맑아서 우산은 필요 없어요."]);
    expect(await b.got()).toEqual(got);
    expect(h.turns.inputs.at(-1)!.userText).toBe("오늘 우산 필요해?");
    await pageHasNoSteered(token, tid);
    await a.cancel();
    await b.cancel();
  });

  test("a line sent just as the running turn's lease ends (the steer refused, the line runs as a turn of its own): pushed without steered", async () => {
    const { token, session } = await h.signup("haneul");
    const tid = session.mainThreadId;
    const other = await device(token);
    const g = gate();
    h.turns.set(async () => {
      await g.p;
      return outcome("첫 답");
    });
    const r = sseReader(await h.req("POST", `/api/threads/${tid}/messages`, { token, body: { text: "첫 질문" } }));
    const start = await r.next<Extract<AgentEvent, { type: "start" }>>((e) => e.type === "start");
    expect(await other.got()).toEqual([`user 첫 질문 ${start!.userMessage!.id}`]);
    const real = h.launcher.steer.bind(h.launcher);
    h.launcher.steer = (userId) => {
      h.launcher.leases.get(userId)?.release(); // the lease ended under the send: the line takes the agent itself
      return false;
    };
    h.turns.set(async () => outcome("둘째 답"));
    const evs = (await readSse(await h.req("POST", `/api/threads/${tid}/messages`, { token, body: { text: "둘째 질문" } }))) as AgentEvent[];
    h.launcher.steer = real;
    const late = evs.find((e) => e.type === "start") as Extract<AgentEvent, { type: "start" }>;
    expect(late.userMessage!.text).toBe("둘째 질문");
    expect((await other.got())[0]).toBe(`user 둘째 질문 ${late.userMessage!.id}`);
    g.open();
    await h.app.core.idle();
    await pageHasNoSteered(token, tid);
    await other.cancel();
  });
});

async function befriend(x: { token: string }, y: { token: string }): Promise<Friend> {
  const inv = (await (await h.req("POST", "/api/invites", { token: x.token })).json()) as InviteResponse;
  const acc = await h.req("POST", `/api/invites/${inv.token}/accept`, { token: y.token });
  expect([200, 201]).toContain(acc.status);
  return (await acc.json()) as Friend;
}

/** in a friend thread, a line to the friend alone (201) and a line that calls my agent (its answer streams) */
async function friendLines() {
  const me = await h.signup("haneul", { agentName: "깽이" });
  const friend = await h.signup("byeol", { displayName: "별", agentName: "토리" });
  const tid = (await befriend(me, friend)).threadId!;
  const mine = await device(me.token);
  const theirs = await device(friend.token);
  const res = await h.req("POST", `/api/threads/${tid}/messages`, { token: me.token, body: { text: "내일 영화 볼래?" } });
  expect(res.status).toBe(201);
  const line = ((await res.json()) as { userMessage: Message }).userMessage;
  h.turns.set(async () => outcome("상영 시간을 찾아볼게요"));
  const evs = (await readSse(await h.req("POST", `/api/threads/${tid}/messages`, { token: me.token, body: { text: "@깽이 상영 시간 알려줘" } }))) as AgentEvent[];
  const start = evs.find((e) => e.type === "start") as Extract<AgentEvent, { type: "start" }>;
  const done = evs.find((e) => e.type === "done") as Extract<AgentEvent, { type: "done" }>;
  await h.app.core.idle();
  return { mine, theirs, want: [`user 내일 영화 볼래? ${line.id}`, `user @깽이 상영 시간 알려줘 ${start.userMessage!.id}`, `assistant 상영 시간을 찾아볼게요 ${done.message.id}`] };
}

describe("friend threads: the sender's own devices too", () => {
  test("my line to the friend (201) and my line that calls my agent, with its answer: on my devices as on the friend's", async () => {
    const { mine, theirs, want } = await friendLines();
    expect(await mine.got()).toEqual(want);
    expect(await theirs.got()).toEqual(want);
    await mine.cancel();
    await theirs.cancel();
  });
});

/**
 * the inviter's device and two devices of the one who accepts, open before the accept (plus a stream each for
 * notifications); the accept (201) and its event row as a page read returns it
 */
async function acceptOnDevices() {
  const inviter = await h.signup("haneul", { agentName: "깽이" });
  const accepter = await h.signup("byeol", { displayName: "별", agentName: "토리" });
  const inviterPhone = await device(inviter.token);
  const phone = await device(accepter.token);
  const laptop = await device(accepter.token);
  const inviterNotes = sseReader(await h.req("GET", `/api/events?token=${inviter.token}`));
  const accepterNotes = sseReader(await h.req("GET", `/api/events?token=${accepter.token}`));
  await inviterNotes.next((e) => e.type === "hello");
  await accepterNotes.next((e) => e.type === "hello");
  const inv = (await (await h.req("POST", "/api/invites", { token: inviter.token })).json()) as InviteResponse;
  const acc = await h.req("POST", `/api/invites/${inv.token}/accept`, { token: accepter.token });
  expect(acc.status).toBe(201);
  const tid = ((await acc.json()) as Friend).threadId!;
  const page = (await (await h.req("GET", `/api/threads/${tid}/messages`, { token: accepter.token })).json()) as Message[];
  const row = page.find((m) => m.role === "event")!;
  expect(row.text).toContain("친구가 되었어요");
  const close = () => Promise.all([inviterPhone.cancel(), phone.cancel(), laptop.cancel(), inviterNotes.cancel(), accepterNotes.cancel()]);
  return { accepter, inviterPhone, phone, laptop, inviterNotes, accepterNotes, inv, close, want: [`event ${row.text} ${row.id}`] };
}

describe("accepting a friend invite: the accepter's own devices too", () => {
  test("the 'became friends' event row: on every device of the one who accepted (the accepting one too), as on the inviter's; once each", async () => {
    const { inviterPhone, phone, laptop, close, want } = await acceptOnDevices();
    expect(await phone.got()).toEqual(want);
    expect(await laptop.got()).toEqual(want);
    expect(await inviterPhone.got()).toEqual(want);
    await close();
  });
});

describe("what does not change (passes before and after)", () => {
  test("an accept: the inviter's device gets the event row once and the 새 친구 notification; the accepter gets no notification; accepting again adds no row", async () => {
    const { accepter, inviterPhone, phone, laptop, inviterNotes, accepterNotes, inv, close, want } = await acceptOnDevices();
    expect(await inviterPhone.got()).toEqual(want);
    expect(await inviterNotes.next((e) => e.type === "notification")).toMatchObject({ title: "새 친구", body: "별 님과 친구가 되었어요" });
    expect(await accepterNotes.next((e) => e.type === "notification", 60)).toBeNull();
    await phone.got(); // whatever the accept itself brought the accepter (that is the test above)
    await laptop.got();
    const again = await h.req("POST", `/api/invites/${inv.token}/accept`, { token: accepter.token });
    expect(again.status).toBe(200); // already friends: no new row, no push
    expect(await inviterPhone.got()).toEqual([]);
    expect(await phone.got()).toEqual([]);
    expect(await laptop.got()).toEqual([]);
    await close();
  });

  test("the friend gets my line, my agent's line and its answer once each", async () => {
    const { mine, theirs, want } = await friendLines();
    expect(await theirs.got()).toEqual(want);
    await mine.cancel();
    await theirs.cancel();
  });

  test("answers that already reached every device: a failed turn's partial text, a follow-up turn's answer; once each, no row for a turn that left nothing", async () => {
    const { token, session } = await h.signup("haneul");
    const tid = session.mainThreadId;
    const d = await device(token);
    const answers = async () => (await d.got()).filter((x) => !x.startsWith("user ")).map((x) => x.replace(/ m_\S+$/, ""));
    // a turn the app started fails after writing some text
    h.turns.set(async (_input, emit) => {
      emit({ type: "text", delta: "찾아보니" });
      throw rate();
    });
    await readSse(await h.req("POST", `/api/threads/${tid}/messages`, { token, body: { text: "맛집 찾아줘" } }));
    await h.app.core.idle();
    expect(await answers()).toEqual(["assistant 찾아보니"]);
    // a turn that leaves nothing
    h.turns.set(async () => {
      throw rate();
    });
    await readSse(await h.req("POST", `/api/threads/${tid}/messages`, { token, body: { text: "다시 해줘" } }));
    await h.app.core.idle();
    expect(await answers()).toEqual([]);
    // a line left queued: its follow-up turn's answer
    const g = gate();
    h.turns.set(async () => {
      await g.p;
      return outcome("네");
    });
    const r = sseReader(await h.req("POST", `/api/threads/${tid}/messages`, { token, body: { text: "첫 질문" } }));
    await r.next((e) => e.type === "start");
    await steer(token, tid, "추가");
    h.turns.set(async () => outcome("추가도 할게요"));
    g.open();
    await h.app.core.idle();
    const got = await answers();
    expect(got.filter((x) => x === "assistant 추가도 할게요")).toHaveLength(1);
    await d.cancel();
  });
});
