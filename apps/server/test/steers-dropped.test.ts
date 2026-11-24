/**
 * steers_dropped: a turn ends without answering lines steered into it (202). A turn the app started: it stopped after
 * the server took it (all its lines), or it failed (the lines it took in; the queued ones get a follow-up turn). A turn
 * with no stream of its own (a briefing, a schedule, a follow-up) that fails: right after its turn_error, the lines it
 * took in and a follow-up's own lines; the queued ones get a follow-up turn as well. Every device of the person hears
 * which rows those are, so the device that sent a line drops its steer receipt even when another device stopped the turn
 * or held its stream (the island's retry, a delegate sheet).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Message, ServerEvent, SteeredResponse } from "@pickle/protocol";
import { makeHarness, outcome, readSse, sseReader, type Harness } from "./helpers.ts";

let h: Harness;
beforeEach(async () => {
  h = await makeHarness();
});
afterEach(async () => {
  await h.close();
});

const KST = (y: number, mo: number, d: number, h: number, mi: number) => Date.UTC(y, mo - 1, d, h - 9, mi);
const rate = () => Object.assign(new Error("rate"), { name: "UpstreamError", status: 429 });

const waitForAbort = (signal: AbortSignal) =>
  new Promise<never>((_, rej) => signal.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError")), { once: true }));

/** a device of the person: its /api/events stream */
async function device(token: string) {
  const ev = sseReader(await h.req("GET", `/api/events?token=${token}`));
  await ev.next((e) => e.type === "hello");
  return {
    /** the steers_dropped and turn_error events since the last call, and the agent_status idle ones between them, in order */
    async got(waitMs = 60): Promise<string[]> {
      const out: string[] = [];
      for (;;) {
        const e = await ev.next<ServerEvent>((x) => x.type === "steers_dropped" || x.type === "turn_error" || (x.type === "agent_status" && x.status === "idle"), waitMs);
        if (!e) return out;
        out.push(e.type === "steers_dropped" ? `steers_dropped ${e.threadId} ${e.messageIds.join(",")}` : e.type === "turn_error" ? `turn_error ${e.threadId}` : "idle");
      }
    },
    async raw(waitMs = 60) {
      return ev.next<Extract<ServerEvent, { type: "steers_dropped" }>>((x) => x.type === "steers_dropped", waitMs);
    },
    cancel: () => ev.cancel(),
  };
}

/** start a turn from the app (its stream open); `stop()` closes the stream as 멈추기 does */
async function startTurn(token: string, threadId: string, text: string) {
  const ac = new AbortController();
  const r = sseReader(await h.req("POST", `/api/threads/${threadId}/messages`, { token, body: { text }, signal: ac.signal }));
  await r.next((e) => e.type === "start");
  return {
    r,
    async stop() {
      ac.abort();
      await r.cancel();
      await h.app.core.idle();
    },
  };
}

async function steer(token: string, threadId: string, text: string): Promise<string> {
  const res = await h.req("POST", `/api/threads/${threadId}/messages`, { token, body: { text } });
  expect(res.status).toBe(202);
  return ((await res.json()) as SteeredResponse).userMessage.id;
}

describe("steers_dropped", () => {
  test("Stop after two lines were steered in: every device of the person gets their rows, oldest first, before the agent goes idle", async () => {
    const { token, session } = await h.signup("haneul");
    const tid = session.mainThreadId;
    const phone = await device(token);
    const laptop = await device(token);
    h.turns.set((input) => waitForAbort(input.ctx.signal)); // never polls steer(): both stay queued
    const t = await startTurn(token, tid, "첫 질문");
    const a = await steer(token, tid, "추가 1");
    const b = await steer(token, tid, "추가 2");
    await t.stop();
    const want = [`steers_dropped ${tid} ${a},${b}`, "idle"];
    expect(await phone.got()).toEqual(want);
    expect(await laptop.got()).toEqual(want);
    expect(h.turns.inputs).toHaveLength(1); // no follow-up turn for them, as before
    await phone.cancel();
    await laptop.cancel();
  });

  test("the event holds the thread and the rows alone", async () => {
    const { token, session } = await h.signup("haneul");
    const tid = session.mainThreadId;
    const d = await device(token);
    h.turns.set((input) => waitForAbort(input.ctx.signal));
    const t = await startTurn(token, tid, "첫 질문");
    const a = await steer(token, tid, "전화번호는 010-1234-5678이야");
    await t.stop();
    expect(await d.raw()).toEqual({ type: "steers_dropped", threadId: tid, messageIds: [a] });
    await d.cancel();
  });

  test("a line the model already read and one still queued: both rows (neither is answered after a Stop)", async () => {
    const { token, session } = await h.signup("haneul");
    const tid = session.mainThreadId;
    const d = await device(token);
    let read: string[] = [];
    let go!: () => void;
    const sent = new Promise<void>((res) => (go = res));
    h.turns.set(async (input) => {
      await sent;
      read = input.steer!();
      return waitForAbort(input.ctx.signal);
    });
    const t = await startTurn(token, tid, "첫 질문");
    const a = await steer(token, tid, "그리고 이것도");
    go();
    await Bun.sleep(5);
    expect(read).toEqual(["그리고 이것도"]);
    const b = await steer(token, tid, "하나 더");
    await t.stop();
    expect(await d.got()).toEqual([`steers_dropped ${tid} ${a},${b}`, "idle"]);
    await d.cancel();
  });

  test("no event: a stopped turn with no steered line, a turn that ends on its own (a line it took in is answered, a queued one gets the follow-up turn)", async () => {
    const { token, session } = await h.signup("haneul");
    const tid = session.mainThreadId;
    const d = await device(token);
    // stopped, nothing steered
    h.turns.set((input) => waitForAbort(input.ctx.signal));
    await (await startTurn(token, tid, "첫 질문")).stop();
    expect(await d.got()).toEqual(["idle"]);
    // ends on its own with a line left queued: that line gets its follow-up turn, no event
    let open!: () => void;
    const gate = new Promise<void>((res) => (open = res));
    h.turns.set(async () => {
      await gate;
      return outcome("네");
    });
    const t = await startTurn(token, tid, "두 번째");
    await steer(token, tid, "추가");
    h.turns.set(async () => outcome("추가도 할게요"));
    open();
    expect(await t.r.next((e) => e.type === "done")).toMatchObject({ message: { text: "네" } });
    await h.app.core.idle();
    expect((await d.got()).filter((x) => x !== "idle")).toEqual([]);
    expect(h.turns.inputs.at(-1)!.userText).toBe("추가"); // the follow-up turn
    // ends on its own after taking a line in: answered in this turn, no event
    let took!: () => void;
    const tookGate = new Promise<void>((res) => (took = res));
    let read: string[] = [];
    h.turns.set(async (input) => {
      await tookGate;
      read = input.steer!();
      return outcome("둘 다 할게요");
    });
    const t2 = await startTurn(token, tid, "세 번째");
    await steer(token, tid, "이것도");
    took();
    expect(await t2.r.next((e) => e.type === "done")).toMatchObject({ message: { text: "둘 다 할게요" } });
    expect(read).toEqual(["이것도"]);
    await h.app.core.idle();
    expect((await d.got()).filter((x) => x !== "idle")).toEqual([]);
    await d.cancel();
  });

  test("an app turn that fails after taking a line in: that row on every device, before idle; a line still queued gets its follow-up turn and is not listed", async () => {
    const { token, session } = await h.signup("haneul");
    const tid = session.mainThreadId;
    const phone = await device(token);
    const laptop = await device(token);
    let took!: () => void;
    const tookGate = new Promise<void>((res) => (took = res));
    let fail!: () => void;
    const failGate = new Promise<void>((res) => (fail = res));
    let read: string[] = [];
    h.turns.set(async (input) => {
      await tookGate;
      read = input.steer!();
      await failGate;
      throw Object.assign(new Error("rate"), { name: "UpstreamError", status: 429 });
    });
    const t = await startTurn(token, tid, "첫 질문");
    const a = await steer(token, tid, "그리고 이것도");
    took();
    await Bun.sleep(5);
    expect(read).toEqual(["그리고 이것도"]);
    await steer(token, tid, "하나 더"); // queued: its own follow-up turn answers it
    h.turns.set(async () => outcome("하나 더 할게요"));
    fail();
    expect(await t.r.next((e) => e.type === "error")).toMatchObject({ error: "upstream_rate_limited" }); // the error: this stream alone
    await h.app.core.idle();
    const want = [`steers_dropped ${tid} ${a}`, "idle"];
    expect((await phone.got()).slice(0, 2)).toEqual(want);
    expect((await laptop.got()).slice(0, 2)).toEqual(want);
    expect(h.turns.inputs.at(-1)!.userText).toBe("하나 더");
    await phone.cancel();
    await laptop.cancel();
  });

  test("an app turn that fails before taking any line in: no event, its queued lines get their follow-up turn", async () => {
    const { token, session } = await h.signup("haneul");
    const tid = session.mainThreadId;
    const d = await device(token);
    let fail!: () => void;
    const failGate = new Promise<void>((res) => (fail = res));
    h.turns.set(async () => {
      await failGate;
      throw Object.assign(new Error("rate"), { name: "UpstreamError", status: 429 });
    });
    const t = await startTurn(token, tid, "첫 질문");
    await steer(token, tid, "추가 1");
    await steer(token, tid, "추가 2");
    h.turns.set(async () => outcome("네"));
    fail();
    expect(await t.r.next((e) => e.type === "error")).toMatchObject({ error: "upstream_rate_limited" });
    await h.app.core.idle();
    expect((await d.got()).filter((x) => x !== "idle")).toEqual([]);
    expect(h.turns.inputs.at(-1)!.userText).toBe("추가 1\n추가 2");
    await d.cancel();
  });

  test("each turn lists its own lines: a line steered into an earlier turn is not listed again", async () => {
    const { token, session } = await h.signup("haneul");
    const tid = session.mainThreadId;
    const d = await device(token);
    h.turns.set((input) => waitForAbort(input.ctx.signal));
    const t1 = await startTurn(token, tid, "첫 질문");
    const a = await steer(token, tid, "추가 1");
    await t1.stop();
    const t2 = await startTurn(token, tid, "두 번째 질문");
    const b = await steer(token, tid, "추가 2");
    await t2.stop();
    expect((await d.got()).filter((x) => x !== "idle")).toEqual([`steers_dropped ${tid} ${a}`, `steers_dropped ${tid} ${b}`]);
    await d.cancel();
  });

  test("a line sent right after Stop is not one of the stopped turn's lines (it waits, then starts its own turn)", async () => {
    const { token, session } = await h.signup("haneul");
    const tid = session.mainThreadId;
    const d = await device(token);
    h.turns.set((input) =>
      waitForAbort(input.ctx.signal).catch(async (err) => {
        await Bun.sleep(30);
        throw err;
      }),
    );
    const ac = new AbortController();
    const r = sseReader(await h.req("POST", `/api/threads/${tid}/messages`, { token, body: { text: "첫 질문" }, signal: ac.signal }));
    await r.next((e) => e.type === "start");
    const a = await steer(token, tid, "추가");
    ac.abort();
    await r.cancel();
    h.turns.set(async () => outcome("천만에요"));
    const res = await h.req("POST", `/api/threads/${tid}/messages`, { token, body: { text: "고마워" } });
    expect(res.status).toBe(200);
    expect((await readSse(res)).at(-1)).toMatchObject({ type: "done", message: { text: "천만에요" } });
    await h.app.core.idle();
    expect((await d.got()).filter((x) => x !== "idle")).toEqual([`steers_dropped ${tid} ${a}`]);
    await d.cancel();
  });

  test("a line the agent did not take (the steer refused, the send answered 409) is not listed", async () => {
    const { token, session } = await h.signup("haneul");
    const tid = session.mainThreadId;
    const d = await device(token);
    h.turns.set((input) => waitForAbort(input.ctx.signal));
    const t = await startTurn(token, tid, "첫 질문");
    const real = h.launcher.steer.bind(h.launcher);
    h.launcher.steer = () => false; // the launcher's lease ended under the send (its own timeout): the row is dropped
    const res = await h.req("POST", `/api/threads/${tid}/messages`, { token, body: { text: "추가" } });
    expect(res.status).toBe(409);
    h.launcher.steer = real;
    const b = await steer(token, tid, "추가 2");
    await t.stop();
    expect((await d.got()).filter((x) => x !== "idle")).toEqual([`steers_dropped ${tid} ${b}`]);
    await d.cancel();
  });

  test("an approved action's turn (no stream of the first send) stopped with a line steered in: that row", async () => {
    const { token, session } = await h.signup("haneul");
    const tid = session.mainThreadId;
    const d = await device(token);
    const call = { id: "c_send", type: "function" as const, function: { name: "msg_send", arguments: "{}" } };
    h.turns.set(async () => ({
      ...outcome("확인할게요", { cards: [{ type: "approval", approvalId: call.id, title: "보낼까요?", detail: "", status: "pending" }] }),
      messages: [],
      pendingApproval: { call, spec: { title: "보낼까요?", detail: "" }, messages: [{ role: "assistant", content: null, tool_calls: [call] }] },
    }));
    const done = (await readSse(await h.req("POST", `/api/threads/${tid}/messages`, { token, body: { text: "슬랙에 보내줘" } }))).at(-1) as { message: Message };
    const approvalId = (done.message.cards[0] as { approvalId: string }).approvalId;
    h.turns.set((input) => waitForAbort(input.ctx.signal));
    const ac = new AbortController();
    const r = sseReader(await h.req("POST", `/api/approvals/${approvalId}`, { token, body: { decision: "approve" }, signal: ac.signal }));
    await r.next((e) => e.type === "start");
    const a = await steer(token, tid, "제목은 회의로");
    ac.abort();
    await r.cancel();
    await h.app.core.idle();
    expect((await d.got()).filter((x) => x !== "idle")).toEqual([`steers_dropped ${tid} ${a}`]);
    await d.cancel();
  });
});

describe("steers_dropped after a turn with no stream of its own fails (a briefing, a schedule, a follow-up)", () => {
  test("a briefing that fails after taking a line in: its turn_error, then that row, on every device; a line still queued gets its follow-up turn and is listed when that one fails too", async () => {
    const { token, session } = await h.signup("haneul"); // T0 = 11-11 12:00 KST: the first briefing is 11-12 07:30
    const tid = session.mainThreadId;
    const phone = await device(token);
    const laptop = await device(token);
    let a = "";
    let b = "";
    h.turns.set(async (input) => {
      if (!input.userText?.includes("[자동 아침 브리핑]")) throw rate(); // the follow-up turn of the queued line
      a = await steer(token, tid, "오늘 우산 필요해?");
      expect(input.steer!()).toEqual(["오늘 우산 필요해?"]);
      b = await steer(token, tid, "미세먼지도"); // queued: a follow-up turn of its own
      throw rate();
    });
    h.clock.t = KST(2026, 11, 12, 7, 30);
    await h.app.scheduler.tick();
    await h.app.core.idle();
    expect(h.turns.inputs.map((i) => (i.userText?.includes("[자동 아침 브리핑]") ? "briefing" : i.userText))).toEqual(["briefing", "미세먼지도"]);
    const want = [`turn_error ${tid}`, `steers_dropped ${tid} ${a}`, "idle", `turn_error ${tid}`, `steers_dropped ${tid} ${b}`, "idle"];
    expect(await phone.got()).toEqual(want);
    expect(await laptop.got()).toEqual(want);
    await phone.cancel();
    await laptop.cancel();
  });

  test("a schedule's turn that fails after taking two lines in: its turn_error, then both rows, oldest first, in the schedule's thread; no follow-up turn", async () => {
    const { token } = await h.signup("haneul");
    expect((await h.req("POST", "/api/schedules", { token, body: { title: "점심 알림", prompt: "점심 메뉴 추천해줘", rule: "daily@12:01" } })).status).toBe(201);
    const d = await device(token);
    let tid = "";
    let a = "";
    let b = "";
    h.turns.set(async (input) => {
      tid = input.ctx.threadId;
      a = await steer(token, tid, "한식으로");
      b = await steer(token, tid, "가까운 데로");
      expect(input.steer!()).toEqual(["한식으로", "가까운 데로"]);
      throw rate();
    });
    h.clock.t = KST(2026, 11, 11, 12, 1);
    await h.app.scheduler.tick();
    await h.app.core.idle();
    expect(h.turns.inputs.map((i) => i.userText)).toEqual(["점심 메뉴 추천해줘"]);
    expect(await d.got()).toEqual([`turn_error ${tid}`, `steers_dropped ${tid} ${a},${b}`, "idle"]);
    await d.cancel();
  });

  test("a follow-up turn that fails: its turn_error, then its own line and the one it took in, on every device; a line still queued gets the next follow-up and is listed when that one fails too", async () => {
    const { token, session } = await h.signup("haneul");
    const tid = session.mainThreadId;
    const phone = await device(token);
    const laptop = await device(token);
    let open!: () => void;
    const gate = new Promise<void>((res) => (open = res));
    h.turns.set(async () => {
      await gate;
      return outcome("네");
    });
    const t = await startTurn(token, tid, "첫 질문");
    const a = await steer(token, tid, "추가"); // left over: a follow-up turn of its own
    let took!: () => void;
    const tookGate = new Promise<void>((res) => (took = res));
    let fail!: () => void;
    const failGate = new Promise<void>((res) => (fail = res));
    let read: string[] = [];
    h.turns.set(async (input) => {
      await tookGate;
      read = input.steer!();
      await failGate;
      throw rate();
    });
    open();
    expect(await t.r.next((e) => e.type === "done")).toMatchObject({ message: { text: "네" } });
    for (let i = 0; i < 100 && h.turns.inputs.length < 2; i++) await Bun.sleep(5);
    expect(h.turns.inputs.at(-1)!.userText).toBe("추가");
    const b = await steer(token, tid, "그것도"); // steered into the follow-up turn, which takes it in
    took();
    await Bun.sleep(5);
    expect(read).toEqual(["그것도"]);
    const c = await steer(token, tid, "하나 더"); // queued: the next follow-up turn
    h.turns.set(async () => {
      throw rate();
    });
    fail();
    await h.app.core.idle();
    expect(h.turns.inputs.map((i) => i.userText)).toEqual(["첫 질문", "추가", "하나 더"]);
    const want = ["idle", `turn_error ${tid}`, `steers_dropped ${tid} ${a},${b}`, "idle", `turn_error ${tid}`, `steers_dropped ${tid} ${c}`, "idle"];
    expect(await phone.got()).toEqual(want);
    expect(await laptop.got()).toEqual(want);
    await phone.cancel();
    await laptop.cancel();
  });

  test("no event: a schedule's turn that fails before taking any line in (no turn_error either); its follow-up turn answers the line", async () => {
    const { token } = await h.signup("haneul");
    expect((await h.req("POST", "/api/schedules", { token, body: { title: "점심 알림", prompt: "점심 메뉴 추천해줘", rule: "daily@12:01" } })).status).toBe(201);
    const d = await device(token);
    h.turns.set(async (input) => {
      if (input.userText === "한식으로") return outcome("한식으로 찾아볼게요");
      await steer(token, input.ctx.threadId, "한식으로"); // never polled: left queued
      throw rate();
    });
    h.clock.t = KST(2026, 11, 11, 12, 1);
    await h.app.scheduler.tick();
    await h.app.core.idle();
    expect(h.turns.inputs.map((i) => i.userText)).toEqual(["점심 메뉴 추천해줘", "한식으로"]);
    expect(await d.got()).toEqual(["idle", "idle"]);
    await d.cancel();
  });
});
