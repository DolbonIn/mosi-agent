/**
 * steers_dropped: a turn ends without answering lines steered into it (202). A turn the app started: it stopped after
 * the server took it (all its lines), or it failed (the lines it took in; the queued ones get a follow-up turn). A turn
 * with no stream of its own (a briefing, a schedule, a follow-up) that fails: right after its turn_error, the lines it
 * took in and a follow-up's own lines; the queued ones get a follow-up turn as well (when the day's quota keeps that
 * one from running: the quota message as its turn_error, and all its lines). Every device of the person hears
 * which rows those are, so the device that sent a line drops its steer receipt even when another device stopped the turn
 * or held its stream (the island's retry, a delegate sheet). The rows keep it (`steerDropped` on every later view of the
 * line), so a device that missed the event learns it from its next page read. A failed turn the app started names the
 * same rows on its stream's `error` (`steersDropped`), sent right after the notice with no wait between.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AgentEvent, Attachment, Friend, InviteResponse, Message, ServerEvent, SteeredResponse } from "@pickle/protocol";
import { messageViewById, publishMessage, QUOTA_MESSAGE } from "../src/core.ts";
import { historyFromRows } from "../src/history.ts";
import { executeTurn, holdLease } from "../src/turns.ts";
import { quotaDay } from "../src/kst.ts";
import { makeHarness, outcome, parseSse, readSse, sseReader, type Harness } from "./helpers.ts";

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
  /** the turn_error events got() went past: their error and message */
  const errors: { error: string; message: string }[] = [];
  return {
    errors,
    /** the steers_dropped and turn_error events since the last call, and the agent_status idle ones between them, in order */
    async got(waitMs = 60): Promise<string[]> {
      const out: string[] = [];
      for (;;) {
        const e = await ev.next<ServerEvent>((x) => x.type === "steers_dropped" || x.type === "turn_error" || (x.type === "agent_status" && x.status === "idle"), waitMs);
        if (!e) return out;
        if (e.type === "turn_error") errors.push({ error: e.error, message: e.message });
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

  test("the answer cannot be stored: an app turn's stream error (internal) names the line it read, one notice; a stopped turn's lines all go once, from its end, as before", async () => {
    const { token, session } = await h.signup("haneul");
    const tid = session.mainThreadId;
    const d = await device(token);
    const db = h.app.core.db;
    const insert = db.insertMessage.bind(db);
    db.insertMessage = (m) => {
      if (m.role === "assistant") throw new Error("disk full");
      return insert(m);
    };
    // not stopped: the turn answers after reading a line, and its row cannot be stored
    let go!: () => void;
    const sent = new Promise<void>((res) => (go = res));
    h.turns.set(async (input) => {
      await sent;
      input.steer!();
      return outcome("답이에요");
    });
    const t = await startTurn(token, tid, "첫 질문");
    const a = await steer(token, tid, "그리고 이것도");
    go();
    expect(await t.r.next((e) => e.type === "error")).toMatchObject({ error: "internal", steersDropped: [a] });
    await h.app.core.idle();
    expect((await d.got()).filter((x) => x !== "idle")).toEqual([`steers_dropped ${tid} ${a}`]);
    // stopped with text on screen (its row is stored on the way out, and fails): one notice with both lines, from the end
    let go2!: () => void;
    const sent2 = new Promise<void>((res) => (go2 = res));
    h.turns.set(async (input, emit) => {
      await sent2;
      input.steer!();
      emit({ type: "text", delta: "적고 있어요" });
      return waitForAbort(input.ctx.signal);
    });
    const t2 = await startTurn(token, tid, "두 번째 질문");
    const b = await steer(token, tid, "이것도");
    go2();
    await Bun.sleep(5);
    const c = await steer(token, tid, "하나 더");
    await t2.stop();
    expect((await d.got()).filter((x) => x !== "idle")).toEqual([`steers_dropped ${tid} ${b},${c}`]);
    db.insertMessage = insert;
    await d.cancel();
  });

  test("an app turn that ends with nothing to say after reading a line: empty_reply on its stream, naming that line; one notice", async () => {
    const { token, session } = await h.signup("haneul");
    const tid = session.mainThreadId;
    const d = await device(token);
    let go!: () => void;
    const sent = new Promise<void>((res) => (go = res));
    h.turns.set(async (input) => {
      await sent;
      input.steer!();
      return outcome("");
    });
    const t = await startTurn(token, tid, "첫 질문");
    const a = await steer(token, tid, "그리고 이것도");
    go();
    expect(await t.r.next((e) => e.type === "error")).toMatchObject({ error: "empty_reply", steersDropped: [a] });
    await h.app.core.idle();
    expect((await d.got()).filter((x) => x !== "idle")).toEqual([`steers_dropped ${tid} ${a}`]);
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
    // the error: this stream alone, naming the rows every device hears in steers_dropped (lead 1741 follow-up)
    expect(await t.r.next((e) => e.type === "error")).toEqual({ type: "error", error: "upstream_rate_limited", message: "지금 요청이 많아요. 잠시 후 다시 시도해 주세요.", steersDropped: [a] });
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
    const err = await t.r.next<{ type: string; steersDropped?: string[] }>((e) => e.type === "error");
    expect(err).toMatchObject({ error: "upstream_rate_limited" });
    expect(err && "steersDropped" in err).toBe(false); // none: no field
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

  test("the day's quota keeps the follow-up turn from running: the quota message as the thread's error, then the rows it would have answered, oldest first, on every device", async () => {
    const { token, session } = await h.signup("haneul");
    const tid = session.mainThreadId;
    const uid = session.user.id;
    const phone = await device(token);
    const laptop = await device(token);
    let open!: () => void;
    const gate = new Promise<void>((res) => (open = res));
    h.turns.set(async () => {
      await gate;
      return outcome("네");
    });
    const t = await startTurn(token, tid, "첫 질문");
    const a = await steer(token, tid, "추가 1"); // never polled: both left over for a follow-up turn
    const b = await steer(token, tid, "추가 2");
    h.db.addUsage(uid, quotaDay(h.clock.now()), h.app.core.cfg.dailyTokens); // the day's quota runs out meanwhile
    open();
    expect(await t.r.next((e) => e.type === "done")).toMatchObject({ message: { text: "네" } });
    await h.app.core.idle();
    expect(h.turns.inputs.map((i) => i.userText)).toEqual(["첫 질문"]); // no follow-up turn ran
    for (const d of [phone, laptop]) {
      expect(await d.got()).toEqual(["idle", `turn_error ${tid}`, `steers_dropped ${tid} ${a},${b}`]);
      expect(d.errors).toEqual([{ error: "quota_exceeded", message: QUOTA_MESSAGE }]);
    }
    // the agent is free again
    expect(h.app.core.activeTurns.get(uid)).toBeUndefined();
    const lease = h.launcher.tryAcquire(uid);
    expect(lease).not.toBeNull();
    lease!.release();
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

/**
 * Every event the server sends the person (their hub; a message with its role) and, for a turn run here, its stream, in
 * the order sent. After a failed turn's error a "·" goes in at the next microtask: an await between the error and
 * `steers_dropped` puts it between them.
 */
function recorder(uid: string) {
  const log: { what: string; t: number }[] = [];
  const note = (what: string) => {
    log.push({ what, t: performance.now() });
    if (what === "hub turn_error" || what === "stream error") queueMicrotask(() => log.push({ what: "·", t: performance.now() }));
  };
  const hub = h.app.core.events;
  const publish = hub.publish.bind(hub);
  hub.publish = (userId: string, e: ServerEvent) => {
    if (userId === uid) note(e.type === "message" ? `hub message ${e.message.role}` : `hub ${e.type}`);
    return publish(userId, e);
  };
  const names = () => log.map((x) => x.what);
  const at = (what: string) => log.find((x) => x.what === what)!.t;
  return { log, note, names, at };
}

describe("a turn that fails while a tool still runs: no line keeps its receipt beside the error row", () => {
  /** idle 80 ms: a turn waiting on a tool times out; settle 300 ms: the server waits that long for the tool, twice */
  const slow = async () => {
    await h.close();
    h = await makeHarness({ config: { turnIdleTimeoutMs: 80, turnSettleMs: 300 } });
  };
  /** a tool that does not stop when the turn is aborted (a call, a messenger send) */
  const stuckTool = () => {
    let done!: () => void;
    const p = new Promise<void>((res) => (done = res));
    return { p, done };
  };

  test("a briefing that fails while a tool still runs (it timed out): after the tool's wait, its turn_error and then steers_dropped, nothing and no await between them; every device gets them", async () => {
    await slow();
    const { token, session } = await h.signup("haneul");
    const tid = session.mainThreadId;
    const phone = await device(token);
    const rec = recorder(session.user.id);
    const tool = stuckTool();
    let a = "";
    h.turns.set(async (input, emit) => {
      a = await steer(token, tid, "오늘 우산 필요해?");
      expect(input.steer!()).toEqual(["오늘 우산 필요해?"]);
      emit({ type: "tool", tool: { id: "t1", name: "k_weather", title: "날씨 확인", state: "running", startedAt: 1 } });
      await tool.p;
      throw new DOMException("aborted", "AbortError");
    });
    h.clock.t = KST(2026, 11, 12, 7, 30);
    await h.app.scheduler.tick();
    await h.app.core.idle();
    const names = rec.names();
    const i = names.indexOf("hub turn_error");
    expect(i).toBeGreaterThan(-1);
    expect(names.slice(i, i + 2)).toEqual(["hub turn_error", "hub steers_dropped"]);
    expect(names.indexOf("·")).toBeGreaterThan(i + 1); // no await between the two
    expect(rec.at("hub steers_dropped") - rec.at("hub turn_error")).toBeLessThan(50);
    expect(names.filter((n) => n === "hub turn_error")).toHaveLength(1);
    expect(await phone.got()).toEqual([`turn_error ${tid}`, `steers_dropped ${tid} ${a}`, "idle"]);
    tool.done();
    await phone.cancel();
  });

  test("a turn the app started fails while a tool still runs: steers_dropped and then its stream's error naming the same rows, no await between, before its row is pushed; nothing more after the tool's wait (lead 1741 follow-up)", async () => {
    await slow();
    const { token, session } = await h.signup("haneul");
    const uid = session.user.id;
    const tid = session.mainThreadId;
    const rec = recorder(uid);
    const tool = stuckTool();
    h.turns.set(async (input, emit) => {
      await steer(token, tid, "그리고 이것도");
      expect(input.steer!()).toEqual(["그리고 이것도"]);
      emit({ type: "tool", tool: { id: "t1", name: "k_weather", title: "날씨 확인", state: "running", startedAt: 1 } });
      await tool.p;
      throw new DOMException("aborted", "AbortError");
    });
    // what streamTurn runs for POST /api/threads/:id/messages (it closes the stream once this returns), its stream
    // recorded in the same log
    const lease = holdLease(h.app.core, uid, tid, await h.launcher.acquire(uid));
    const hub: string[][] = [];
    const publish = h.app.core.events.publish.bind(h.app.core.events);
    h.app.core.events.publish = (u, e) => {
      if (u === uid && e.type === "steers_dropped") hub.push(e.messageIds);
      return publish(u, e);
    };
    let streamIds: string[] | undefined;
    const sink = (e: AgentEvent) => {
      if (e.type === "error") streamIds = e.steersDropped;
      rec.note(`stream ${e.type}`);
    };
    const result = await executeTurn(h.app.core, { userId: uid, threadId: tid, userText: "첫 질문", userMessage: null, mode: "text", lease, sink, initiatedBy: "user" });
    rec.note("returned");
    await h.app.core.idle();
    expect(result.error).toMatchObject({ error: "upstream_timeout" });
    const names = rec.names();
    const i = names.indexOf("hub steers_dropped");
    expect(i).toBeGreaterThan(-1);
    expect(names.slice(i, i + 2)).toEqual(["hub steers_dropped", "stream error"]);
    expect(names.indexOf("·")).toBeGreaterThan(i + 1); // no await between the two
    expect(names.indexOf("hub message assistant")).toBeGreaterThan(i + 1); // both before the row, as the error was
    // the same rows; one notice in all (finally, after the tool's wait, sends nothing more)
    expect(hub).toHaveLength(1);
    expect(streamIds).toEqual(hub[0]);
    expect(streamIds).toHaveLength(1);
    expect(rec.at("returned") - rec.at("stream error")).toBeGreaterThan(200); // the tool's wait came after both
    expect(names).not.toContain("hub turn_error"); // the error goes to the turn's stream alone
    tool.done();
  });

  test("over HTTP, the same app turn: its error comes on the stream at once with the rows steers_dropped named just before it; the stream closes after the tool's wait with no second notice", async () => {
    await slow();
    const { token, session } = await h.signup("haneul");
    const tid = session.mainThreadId;
    const rec = recorder(session.user.id);
    const tool = stuckTool();
    let a = "";
    h.turns.set(async (input, emit) => {
      a = await steer(token, tid, "그리고 이것도");
      expect(input.steer!()).toEqual(["그리고 이것도"]);
      emit({ type: "tool", tool: { id: "t1", name: "k_weather", title: "날씨 확인", state: "running", startedAt: 1 } });
      await tool.p;
      throw new DOMException("aborted", "AbortError");
    });
    const res = await h.req("POST", `/api/threads/${tid}/messages`, { token, body: { text: "첫 질문" } });
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let body = "";
    for (;;) {
      const x = await reader.read();
      if (x.done) break;
      body += dec.decode(x.value, { stream: true });
      if (body.includes('"type":"error"') && !rec.names().includes("stream error read")) rec.note("stream error read");
    }
    rec.note("stream closed");
    await h.app.core.idle();
    const names = rec.names();
    expect(names.filter((n) => n === "stream error read" || n === "hub steers_dropped" || n === "stream closed")).toEqual(["hub steers_dropped", "stream error read", "stream closed"]);
    const error = (parseSse(body) as AgentEvent[]).find((e) => e.type === "error");
    expect(error).toMatchObject({ error: "upstream_timeout", steersDropped: [a] });
    tool.done();
  });

  test("a line steered after the error while the tool winds down: the failed turn cannot read it, it is never dropped, and its follow-up turn answers it", async () => {
    await slow();
    const { token, session } = await h.signup("haneul");
    const tid = session.mainThreadId;
    const d = await device(token);
    const tool = stuckTool();
    let late = null as string[] | null;
    let a = "";
    h.turns.set(async (input, emit) => {
      a = await steer(token, tid, "그리고 이것도");
      expect(input.steer!()).toEqual(["그리고 이것도"]);
      emit({ type: "tool", tool: { id: "t1", name: "k_weather", title: "날씨 확인", state: "running", startedAt: 1 } });
      await tool.p;
      late = input.steer!(); // a tool that kept going reads the queue on its way out
      throw new DOMException("aborted", "AbortError");
    });
    const t = await startTurn(token, tid, "첫 질문");
    expect(await t.r.next((e) => e.type === "error")).toMatchObject({ error: "upstream_timeout", steersDropped: [a] });
    const b = await steer(token, tid, "늦은 한 줄"); // still steered: the turn holds the agent until it winds down
    h.turns.set(async () => outcome("늦은 한 줄에 답해요"));
    tool.done();
    await h.app.core.idle();
    expect(late).toEqual([]);
    expect(h.turns.inputs.at(-1)!.userText).toBe("늦은 한 줄");
    expect((await d.got()).filter((x) => x !== "idle")).toEqual([`steers_dropped ${tid} ${a}`]);
    expect(b).not.toBe(a);
    await d.cancel();
  });

  test("a turn that does not fail is as before: the app's stream gets done before the row is pushed, no steers_dropped; a briefing that answers sends no turn_error", async () => {
    const { token, session } = await h.signup("haneul");
    const uid = session.user.id;
    const tid = session.mainThreadId;
    const rec = recorder(uid);
    h.turns.set(async (input) => {
      await steer(token, tid, "그리고 이것도");
      expect(input.steer!()).toEqual(["그리고 이것도"]);
      return outcome("둘 다 할게요");
    });
    const lease = holdLease(h.app.core, uid, tid, await h.launcher.acquire(uid));
    await executeTurn(h.app.core, { userId: uid, threadId: tid, userText: "첫 질문", userMessage: null, mode: "text", lease, sink: (e) => rec.note(`stream ${e.type}`), initiatedBy: "user" });
    h.turns.set(async () => outcome("오늘은 맑아요"));
    h.clock.t = KST(2026, 11, 12, 7, 30);
    await h.app.scheduler.tick();
    await h.app.core.idle();
    const names = rec.names();
    expect(names.indexOf("stream done")).toBeGreaterThan(-1);
    expect(names.indexOf("stream done")).toBeLessThan(names.indexOf("hub message assistant"));
    expect(names.filter((n) => n === "hub steers_dropped" || n === "hub turn_error" || n === "stream error")).toEqual([]);
  });
});

/** a photo in the person's archive: its id */
async function photo(token: string): Promise<string> {
  const form = new FormData();
  form.set("file", new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])], "영수증.png", { type: "image/png" }));
  const res = await h.req("POST", "/api/attachments", { token, raw: form });
  expect(res.status).toBe(201);
  return ((await res.json()) as Attachment).id;
}

/** steer a line carrying the photo `pic` (deleting the photo from the archive pushes the line again) */
async function steerWithPhoto(token: string, threadId: string, text: string, pic: string): Promise<string> {
  const res = await h.req("POST", `/api/threads/${threadId}/messages`, { token, body: { text, attachmentIds: [pic] } });
  expect(res.status).toBe(202);
  return ((await res.json()) as SteeredResponse).userMessage.id;
}

/** the person's first page of the thread: their lines, oldest first, as "text", or "text ×" with `steerDropped: true` */
async function marks(token: string, threadId: string): Promise<string[]> {
  const rows = (await (await h.req("GET", `/api/threads/${threadId}/messages?limit=200`, { token })).json()) as Message[];
  return rows.filter((m) => m.role === "user").map((m) => (m.steerDropped === true ? `${m.text} ×` : "steerDropped" in m ? `${m.text} ?` : m.text));
}

/**
 * Read inside the person's hub at each `steers_dropped` as it goes out: each named row's `steered` value, with "×" when a
 * view of it (what a page read gives) carries `steerDropped`.
 */
function atNotice(uid: string): string[] {
  const seen: string[] = [];
  const hub = h.app.core.events;
  const publish = hub.publish.bind(hub);
  hub.publish = (userId: string, e: ServerEvent) => {
    if (userId === uid && e.type === "steers_dropped")
      seen.push(e.messageIds.map((id) => `${h.db.getMessage(id)!.steered}${messageViewById(h.app.core, id, uid)!.steerDropped ? "×" : ""}`).join(","));
    return publish(userId, e);
  };
  return seen;
}

/** a device of the person: the `message` pushes of one line */
async function linePushes(token: string) {
  const ev = sseReader(await h.req("GET", `/api/events?token=${token}`));
  await ev.next((e: ServerEvent) => e.type === "hello");
  return {
    async of(id: string, waitMs = 500): Promise<Message | null> {
      const e = await ev.next<Extract<ServerEvent, { type: "message" }>>((x) => x.type === "message" && x.message.id === id, waitMs);
      return e?.message ?? null;
    },
    cancel: () => ev.cancel(),
  };
}

const deletePhoto = async (token: string, pic: string) => expect((await h.req("DELETE", `/api/attachments/${pic}`, { token })).status).toBe(200);

describe("steerDropped: the rows keep which lines a turn left unanswered, so a device that missed steers_dropped learns it from a page read", () => {
  test("Stop: both lines carry it on page reads and on a later push of the line (with no steered), stored before steers_dropped goes out; the 202's push carried none", async () => {
    const { token, session } = await h.signup("haneul");
    const tid = session.mainThreadId;
    const seen = atNotice(session.user.id);
    const d = await linePushes(token);
    const pic = await photo(token);
    h.turns.set((input) => waitForAbort(input.ctx.signal));
    const t = await startTurn(token, tid, "첫 질문");
    const a = await steerWithPhoto(token, tid, "이 사진도", pic);
    const b = await steer(token, tid, "추가");
    const first = (await d.of(a))!;
    expect(first.steered).toBe(true);
    expect("steerDropped" in first).toBe(false);
    expect(await marks(token, tid)).toEqual(["첫 질문", "이 사진도", "추가"]);
    await t.stop();
    expect(seen).toEqual(["2×,2×"]);
    expect([a, b].map((id) => h.db.getMessage(id)!.steered)).toEqual([2, 2]);
    expect(await marks(token, tid)).toEqual(["첫 질문", "이 사진도 ×", "추가 ×"]);
    await deletePhoto(token, pic);
    const rePush = (await d.of(a))!;
    expect(rePush.steerDropped).toBe(true);
    expect("steered" in rePush).toBe(false); // a dropped line carries steerDropped alone
    await d.cancel();
  });

  test("an app turn that fails: the line it took in carries it; the line handed to its follow-up turn, which answers it, does not", async () => {
    const { token, session } = await h.signup("haneul");
    const tid = session.mainThreadId;
    const seen = atNotice(session.user.id);
    const d = await linePushes(token);
    const pic = await photo(token);
    let took!: () => void;
    const tookGate = new Promise<void>((res) => (took = res));
    let fail!: () => void;
    const failGate = new Promise<void>((res) => (fail = res));
    h.turns.set(async (input) => {
      await tookGate;
      expect(input.steer!()).toHaveLength(1); // the line with the photo (its model copy carries the photo's note)
      await failGate;
      throw rate();
    });
    const t = await startTurn(token, tid, "첫 질문");
    const a = await steerWithPhoto(token, tid, "그리고 이것도", pic);
    expect("steerDropped" in (await d.of(a))!).toBe(false); // the 202's push
    took();
    await Bun.sleep(5);
    const b = await steer(token, tid, "하나 더"); // queued: its own follow-up turn answers it
    h.turns.set(async () => outcome("하나 더 할게요"));
    fail();
    expect(await t.r.next((e) => e.type === "error")).toMatchObject({ error: "upstream_rate_limited" });
    await h.app.core.idle();
    expect(h.turns.inputs.at(-1)!.userText).toBe("하나 더");
    expect(seen).toEqual(["2×"]);
    expect([a, b].map((id) => h.db.getMessage(id)!.steered)).toEqual([2, 1]);
    expect(await marks(token, tid)).toEqual(["첫 질문", "그리고 이것도 ×", "하나 더"]);
    await deletePhoto(token, pic);
    const rePush = (await d.of(a))!;
    expect(rePush.steerDropped).toBe(true);
    expect("steered" in rePush).toBe(false); // a dropped line carries steerDropped alone
    await d.cancel();
  });

  test("a briefing that fails (no stream of its own): the line it took in, then the line of its follow-up turn when that one fails too, each stored before its steers_dropped", async () => {
    const { token, session } = await h.signup("haneul"); // the first briefing is 11-12 07:30
    const tid = session.mainThreadId;
    const seen = atNotice(session.user.id);
    const d = await linePushes(token);
    const pic = await photo(token);
    let a = "";
    let b = "";
    h.turns.set(async (input) => {
      if (!input.userText?.includes("[자동 아침 브리핑]")) throw rate(); // the follow-up turn of the queued line
      a = await steerWithPhoto(token, tid, "오늘 우산 필요해?", pic);
      expect(input.steer!()).toHaveLength(1);
      b = await steer(token, tid, "미세먼지도");
      throw rate();
    });
    h.clock.t = KST(2026, 11, 12, 7, 30);
    await h.app.scheduler.tick();
    await h.app.core.idle();
    expect(h.turns.inputs).toHaveLength(2);
    expect("steerDropped" in (await d.of(a))!).toBe(false); // the 202's push
    expect(seen).toEqual(["2×", "2×"]);
    expect(await marks(token, tid)).toEqual(["오늘 우산 필요해? ×", "미세먼지도 ×"]);
    await deletePhoto(token, pic);
    const rePush = (await d.of(a))!;
    expect(rePush.steerDropped).toBe(true);
    expect("steered" in rePush).toBe(false); // a dropped line carries steerDropped alone
    expect(h.db.getMessage(b)!.steered).toBe(2);
    await d.cancel();
  });

  test("the day's quota keeps the follow-up turn from running: both lines it would have answered carry it, stored before steers_dropped goes out", async () => {
    const { token, session } = await h.signup("haneul");
    const tid = session.mainThreadId;
    const uid = session.user.id;
    const seen = atNotice(uid);
    const d = await linePushes(token);
    const pic = await photo(token);
    let open!: () => void;
    const gate = new Promise<void>((res) => (open = res));
    h.turns.set(async () => {
      await gate;
      return outcome("네");
    });
    const t = await startTurn(token, tid, "첫 질문");
    const a = await steerWithPhoto(token, tid, "추가 1", pic); // never polled: both left over for a follow-up turn
    const b = await steer(token, tid, "추가 2");
    expect("steerDropped" in (await d.of(a))!).toBe(false); // the 202's push
    h.db.addUsage(uid, quotaDay(h.clock.now()), h.app.core.cfg.dailyTokens);
    open();
    expect(await t.r.next((e) => e.type === "done")).toMatchObject({ message: { text: "네" } });
    await h.app.core.idle();
    expect(h.turns.inputs).toHaveLength(1);
    expect(seen).toEqual(["2×,2×"]);
    expect([a, b].map((id) => h.db.getMessage(id)!.steered)).toEqual([2, 2]);
    expect(await marks(token, tid)).toEqual(["첫 질문", "추가 1 ×", "추가 2 ×"]);
    await deletePhoto(token, pic);
    const rePush = (await d.of(a))!;
    expect(rePush.steerDropped).toBe(true);
    expect("steered" in rePush).toBe(false); // a dropped line carries steerDropped alone
    await d.cancel();
  });

  test("never on a line that is answered: the turn's own line, a line it took in and answered, a line its follow-up turn answered, nor on a later push of one", async () => {
    const { token, session } = await h.signup("haneul");
    const tid = session.mainThreadId;
    const seen = atNotice(session.user.id);
    const d = await linePushes(token);
    const pic = await photo(token);
    let took!: () => void;
    const tookGate = new Promise<void>((res) => (took = res));
    let finish!: () => void;
    const finishGate = new Promise<void>((res) => (finish = res));
    h.turns.set(async (input) => {
      await tookGate;
      expect(input.steer!()).toHaveLength(1);
      await finishGate;
      return outcome("둘 다 할게요");
    });
    const t = await startTurn(token, tid, "첫 질문");
    const a = await steerWithPhoto(token, tid, "이 사진도", pic);
    took();
    await Bun.sleep(5);
    const b = await steer(token, tid, "하나 더"); // left over: its follow-up turn answers it
    h.turns.set(async () => outcome("하나 더 할게요"));
    finish();
    expect(await t.r.next((e) => e.type === "done")).toMatchObject({ message: { text: "둘 다 할게요" } });
    await h.app.core.idle();
    expect(h.turns.inputs.map((i) => i.userText)).toEqual(["첫 질문", "하나 더"]);
    expect(seen).toEqual([]);
    expect([a, b].map((id) => h.db.getMessage(id)!.steered)).toEqual([1, 1]);
    expect(await marks(token, tid)).toEqual(["첫 질문", "이 사진도", "하나 더"]);
    expect((await d.of(a))!.steered).toBe(true); // the 202's push
    await deletePhoto(token, pic);
    const again = (await d.of(a))!;
    expect(again.attachments[0]!.deleted).toBe(true);
    expect("steerDropped" in again).toBe(false);
    expect(again.steered).toBe(true); // an answered steered line is pushed as before
    await d.cancel();
  });

  test("what the model reads of the thread is the same, byte for byte, as with those rows still plain steered lines (after a Stop, a failed turn and the quota)", async () => {
    const { token, session } = await h.signup("haneul");
    const tid = session.mainThreadId;
    const uid = session.user.id;
    // Stop with a line steered in
    h.turns.set((input) => waitForAbort(input.ctx.signal));
    const t1 = await startTurn(token, tid, "첫 질문");
    await steer(token, tid, "추가");
    await t1.stop();
    // a failed turn: one line taken in, one answered by its follow-up turn
    let took!: () => void;
    const tookGate = new Promise<void>((res) => (took = res));
    let fail!: () => void;
    const failGate = new Promise<void>((res) => (fail = res));
    h.turns.set(async (input) => {
      await tookGate;
      expect(input.steer!()).toEqual(["그리고 이것도"]);
      await failGate;
      throw rate();
    });
    const t2 = await startTurn(token, tid, "두 번째");
    await steer(token, tid, "그리고 이것도");
    took();
    await Bun.sleep(5);
    await steer(token, tid, "하나 더");
    h.turns.set(async () => outcome("하나 더 할게요"));
    fail();
    expect(await t2.r.next((e) => e.type === "error")).toMatchObject({ error: "upstream_rate_limited" });
    await h.app.core.idle();
    // the quota keeps a follow-up turn from running
    let open!: () => void;
    const gate = new Promise<void>((res) => (open = res));
    h.turns.set(async () => {
      await gate;
      return outcome("네");
    });
    const t3 = await startTurn(token, tid, "세 번째");
    await steer(token, tid, "추가 1");
    await steer(token, tid, "추가 2");
    h.db.addUsage(uid, quotaDay(h.clock.now()), h.app.core.cfg.dailyTokens);
    open();
    await t3.r.next((e) => e.type === "done");
    await h.app.core.idle();
    expect(await marks(token, tid)).toEqual(["첫 질문", "추가 ×", "두 번째", "그리고 이것도 ×", "하나 더", "세 번째", "추가 1 ×", "추가 2 ×"]);
    const read = () => JSON.stringify(historyFromRows(h.db.historyRows(tid, 60)));
    const marked = read();
    for (const text of ["추가", "그리고 이것도", "추가 1", "추가 2"]) expect(marked).toContain(`"content":"${text}"`);
    expect(h.db.sql.query("UPDATE messages SET steered = 1 WHERE steered = 2").run().changes).toBe(4);
    expect(read()).toBe(marked);
  });

  test("the line's sender alone: a friend's view of it (page read, push) carries none", async () => {
    const a = await h.signup("haneul");
    const b = await h.signup("jinwoo");
    const inv = (await (await h.req("POST", "/api/invites", { token: a.token })).json()) as InviteResponse;
    const acc = await h.req("POST", `/api/invites/${inv.token}/accept`, { token: b.token });
    expect([200, 201]).toContain(acc.status);
    const tid = ((await acc.json()) as Friend).threadId!;
    // a shared thread never takes a steered line today; the row is made here to hold the rule
    h.db.insertMessage({ id: "m_steered", threadId: tid, role: "user", text: "이것도 부탁해", authorUserId: a.session.user.id, authorKind: "human", steered: true, createdAt: h.clock.now() });
    h.db.markSteersDropped(["m_steered"]);
    expect(await marks(a.token, tid)).toContain("이것도 부탁해 ×");
    expect(await marks(b.token, tid)).toContain("이것도 부탁해");
    const phoneA = await linePushes(a.token);
    const phoneB = await linePushes(b.token);
    publishMessage(h.app.core, "m_steered");
    const own = (await phoneA.of("m_steered"))!;
    expect(own.steerDropped).toBe(true);
    expect("steered" in own).toBe(false);
    expect("steerDropped" in (await phoneB.of("m_steered"))!).toBe(false);
    await phoneA.cancel();
    await phoneB.cancel();
  });

  test("markSteersDropped turns steered lines (1) alone into 2: a row that is not a steered line keeps 0, one already 2 stays, rows not named keep theirs", async () => {
    const { session } = await h.signup("haneul");
    const tid = session.mainThreadId;
    const put = (id: string, steered: boolean) => h.db.insertMessage({ id, threadId: tid, role: "user", text: id, steered, createdAt: h.clock.now() });
    put("m_plain", false);
    put("m_one", true);
    put("m_two", true);
    put("m_other", true);
    h.db.markSteersDropped(["m_two"]);
    h.db.markSteersDropped([]);
    h.db.markSteersDropped(["m_plain", "m_one", "m_two", "m_gone"]);
    expect(["m_plain", "m_one", "m_two", "m_other"].map((id) => h.db.getMessage(id)!.steered)).toEqual([0, 2, 2, 1]);
  });
});
