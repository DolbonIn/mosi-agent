/** Regression tests for defects found in review (cross-thread steering, lease leaks, blocks, quota). */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Friend, InviteResponse, Message, Thread } from "@pickle/protocol";
import { CANCEL_NOTE, CANCEL_RULE, historyFromRows } from "../src/history.ts";
import type { MessageRow } from "../src/db/index.ts";
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
  const inv = (await (await h.req("POST", "/api/invites", { token: a.token })).json()) as InviteResponse;
  const friend = (await (await h.req("POST", `/api/invites/${inv.token}/accept`, { token: b.token })).json()) as Friend;
  return { a, b, inv, ftid: friend.threadId! };
}

function gate() {
  let open!: () => void;
  const p = new Promise<void>((r) => (open = r));
  return { p, open };
}

describe("steering is per thread", () => {
  test("text for my main thread is never steered into a running friend-thread turn", async () => {
    const { a, b, ftid } = await befriend();
    // main already holds a request: a busy send there is 409 (a new thread's first message queues: send-queue.test.ts)
    await readSse(await h.req("POST", `/api/threads/${a.session.mainThreadId}/messages`, { token: a.token, body: { text: "안녕" } }));
    const g = gate();
    let steered: string[] = [];
    h.turns.set(async (input, emit) => {
      emit({ type: "text", delta: "..." });
      await g.p;
      steered = input.steer!();
      return outcome("답");
    });
    const first = await h.req("POST", `/api/threads/${ftid}/messages`, { token: a.token, body: { text: "@깽이 안녕" } });
    await Bun.sleep(5);
    const second = await h.req("POST", `/api/threads/${a.session.mainThreadId}/messages`, { token: a.token, body: { text: "비밀: 내 통장 잔고" } });
    expect(second.status).toBe(409);
    expect(((await second.json()) as { error: string; message: string }).message).toBe("깽이가 다른 일을 하고 있어요. 끝나면 다시 보내 주세요.");
    g.open();
    await readSse(first);
    await h.app.core.idle();
    expect(steered).toEqual([]);
    const main = (await (await h.req("GET", `/api/threads/${a.session.mainThreadId}/messages`, { token: a.token })).json()) as Message[];
    expect(main.some((m) => m.text.includes("통장 잔고"))).toBe(false);
    const peer = (await (await h.req("GET", `/api/threads/${ftid}/messages`, { token: b.token })).json()) as Message[];
    expect(peer.some((m) => m.text.includes("통장 잔고"))).toBe(false);
  });

  test("a schedule turn doesn't swallow main-thread messages; same-thread steering still works", async () => {
    const { token, session } = await h.signup("haneul");
    await readSse(await h.req("POST", `/api/threads/${session.mainThreadId}/messages`, { token, body: { text: "안녕" } })); // not a new thread
    await h.req("POST", "/api/schedules", { token, body: { title: "알림", prompt: "알려줘", rule: "daily@12:05" } });
    h.clock.t = Date.UTC(2026, 10, 11, 3, 5);
    const g = gate();
    h.turns.set(async () => {
      await g.p;
      return outcome("예약 답");
    });
    const tick = h.app.scheduler.tick();
    await Bun.sleep(5);
    expect((await h.req("POST", `/api/threads/${session.mainThreadId}/messages`, { token, body: { text: "메인에서 질문" } })).status).toBe(409);
    g.open();
    expect(await tick).toEqual({ schedules: 1, briefings: 0 });
    expect(h.app.core.activeTurns.size).toBe(0);
  });
});

describe("leases are always released", () => {
  test("a failing insert after acquiring doesn't wedge the user's agent", async () => {
    const { token, session } = await h.signup("haneul");
    const real = h.db.insertMessage.bind(h.db);
    let failOnce = true;
    h.db.insertMessage = ((m: Parameters<typeof real>[0]) => {
      if (failOnce) {
        failOnce = false;
        throw new Error("disk full");
      }
      return real(m);
    }) as typeof h.db.insertMessage;
    expect((await h.req("POST", `/api/threads/${session.mainThreadId}/messages`, { token, body: { text: "1" } })).status).toBe(500);
    h.db.insertMessage = real;
    const ok = await h.req("POST", `/api/threads/${session.mainThreadId}/messages`, { token, body: { text: "2" } });
    expect(ok.status).toBe(200);
    expect((await readSse(ok)).at(-1)!.type).toBe("done");
  });

  test("turn setup failure (thread gone) releases the lease and reports an error", async () => {
    const { token, session } = await h.signup("haneul");
    const realThreadFor = h.db.threadFor.bind(h.db);
    let calls = 0;
    h.db.threadFor = ((id: string, uid: string) => (++calls === 2 ? null : realThreadFor(id, uid))) as typeof h.db.threadFor;
    const ev = await readSse(await h.req("POST", `/api/threads/${session.mainThreadId}/messages`, { token, body: { text: "x" } }));
    expect(ev.map((e) => e.type)).toEqual(["start", "error"]);
    h.db.threadFor = realThreadFor;
    expect(h.launcher.tryAcquire(session.user.id)).not.toBeNull();
  });
});

describe("blocks", () => {
  test("blocking back doesn't erase the other side's block", async () => {
    const { a, b } = await befriend();
    await h.req("POST", `/api/friends/${a.session.user.id}/block`, { token: b.token });
    await h.req("POST", `/api/friends/${b.session.user.id}/block`, { token: a.token });
    await h.req("DELETE", `/api/friends/${b.session.user.id}`, { token: a.token }); // A unblocks
    const binv = (await (await h.req("POST", "/api/invites", { token: b.token })).json()) as InviteResponse;
    expect((await h.req("POST", `/api/invites/${binv.token}/accept`, { token: a.token })).status).toBe(403);
  });

  test("no schedules in shared threads; no approval resume into a thread after a block", async () => {
    const { a, b, ftid } = await befriend();
    const res = await h.req("POST", "/api/schedules", { token: a.token, body: { title: "x", prompt: "y", rule: "daily@09:00", threadId: ftid } });
    expect(res.status).toBe(400);

    h.turns.set(async () =>
      outcome("확인할게요", {
        pendingApproval: {
          call: { id: "c1", type: "function", function: { name: "k_weather", arguments: "{}" } },
          spec: { title: "확인", detail: "" },
          messages: [],
        },
      }),
    );
    const done = (await readSse(await h.req("POST", `/api/threads/${ftid}/messages`, { token: a.token, body: { text: "@깽이 해줘" } }))).at(-1) as {
      message: Message;
    };
    const card = done.message.cards.find((c) => c.type === "approval") as { approvalId: string };
    await h.req("POST", `/api/friends/${a.session.user.id}/block`, { token: b.token });
    const r = await h.req("POST", `/api/approvals/${card.approvalId}`, { token: a.token, body: { decision: "approve" } });
    expect(r.status).toBe(403);
    expect(h.launcher.tryAcquire(a.session.user.id)).not.toBeNull();
  });
});

describe("quota on aborted turns", () => {
  test("cancelling mid-answer is still charged (estimate)", async () => {
    const { token, session } = await h.signup("haneul");
    const ac = new AbortController();
    const g = gate();
    h.turns.set(async (_i, emit) => {
      emit({ type: "text", delta: "긴 답변 ".repeat(50) });
      await g.p;
      return outcome("x", { usage: { promptTokens: 9000, completionTokens: 9000, totalTokens: 18000 } });
    });
    const res = await h.req("POST", `/api/threads/${session.mainThreadId}/messages`, { token, body: { text: "hi" }, signal: ac.signal });
    const rd = res.body!.getReader();
    await rd.read();
    ac.abort();
    await Bun.sleep(20);
    g.open();
    await h.app.core.idle();
    const p = (await (await h.req("GET", "/api/profile", { token })).json()) as { quota: { usedTokens: number } };
    expect(p.quota.usedTokens).toBeGreaterThan(100);
  });
});

describe("friend messages need an unambiguous recipient", () => {
  test("partial names only match one friend; ambiguity is reported", async () => {
    const a = await h.signup("alice", { displayName: "하늘" });
    const invite = async () => ((await (await h.req("POST", "/api/invites", { token: a.token })).json()) as InviteResponse).token;
    const b = await h.signup("minjun", { displayName: "김민준" });
    await h.req("POST", `/api/invites/${await invite()}/accept`, { token: b.token });
    const c = await h.signup("minseo", { displayName: "이민서" });
    await h.req("POST", `/api/invites/${await invite()}/accept`, { token: c.token });
    const d = await h.signup("min", { displayName: "민" });
    await h.req("POST", `/api/invites/${await invite()}/accept`, { token: d.token });
    const results: unknown[] = [];
    h.turns.set(async (input) => {
      results.push(await input.ctx.store.messageFriend("김민", "안녕"));
      results.push(await input.ctx.store.messageFriend("지민님", "안녕"));
      results.push(await input.ctx.store.messageFriend("민", "안녕"));
      results.push(await input.ctx.store.messageFriend("이민", "안녕"));
      return outcome("ok");
    });
    await readSse(await h.req("POST", `/api/threads/${a.session.mainThreadId}/messages`, { token: a.token, body: { text: "전해줘" } }));
    expect(results[0]).toEqual({ ok: true, detail: "김민준 님에게 전했어요" });
    expect(results[1]).toMatchObject({ ok: false }); // "지민" is nobody, not "민"
    expect(results[2]).toEqual({ ok: true, detail: "민 님에게 전했어요" }); // exact beats partial
    expect(results[3]).toEqual({ ok: true, detail: "이민서 님에게 전했어요" });
    const threads = (await (await h.req("GET", "/api/threads", { token: d.token })).json()) as Thread[];
    expect(threads.find((t) => t.kind === "friend")!.unread).toBe(true);
  });
});

describe("history", () => {
  test("a steered message with an inlined attachment is not replayed twice", () => {
    const content = "이거 봐줘\n\n[첨부: memo.txt]\n메모 내용";
    const row = (o: Partial<MessageRow>): MessageRow =>
      ({ id: "m", thread_id: "t", role: "user", text: "", cards_json: "[]", tools_json: "[]", attachments_json: "[]", author_user_id: null, author_kind: null, llm_json: null, steered: 0, created_at: 0, ...o }) as MessageRow;
    const rows = [
      row({ id: "1", text: "질문", llm_json: JSON.stringify([{ role: "user", content: "질문" }]) }),
      row({ id: "2", text: "이거 봐줘", steered: 1, llm_json: JSON.stringify([{ role: "user", content }]) }),
      row({
        id: "3",
        role: "assistant",
        text: "봤어요",
        llm_json: JSON.stringify([
          { role: "user", content },
          { role: "assistant", content: "봤어요" },
        ]),
      }),
    ];
    const hist = historyFromRows(rows);
    expect(hist.filter((m) => m.role === "user").map((m) => m.content)).toEqual(["질문", content]);
  });
});

describe("vault storage never replaces a user's wrapped key", () => {
  test("a second setWrappedUserKey (concurrent first use) keeps the first DEK", async () => {
    const a = await h.signup("dekuser");
    const s = h.db.vaultStorage();
    await s.setWrappedUserKey(a.session.user.id, "first");
    await s.setWrappedUserKey(a.session.user.id, "second");
    expect(await s.getWrappedUserKey(a.session.user.id)).toBe("first");
  });
});

describe("stopping a turn", () => {
  const waitForAbort = (signal: AbortSignal) =>
    new Promise<never>((_, rej) => signal.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError")), { once: true }));

  async function stop(token: string, threadId: string, text: string) {
    const ac = new AbortController();
    const r = sseReader(await h.req("POST", `/api/threads/${threadId}/messages`, { token, body: { text }, signal: ac.signal }));
    await r.next((e) => e.type === "start");
    ac.abort();
    await r.cancel();
    await h.app.core.idle();
  }

  test("a request stopped before any output is not answered by the next turn", async () => {
    const { token, session } = await h.signup("haneul");
    const tid = session.mainThreadId;
    h.turns.set((input) => waitForAbort(input.ctx.signal));
    await stop(token, tid, "첫 질문: 제주 맛집 찾아줘");

    // no visible bubble for the cancellation
    const msgs = (await (await h.req("GET", `/api/threads/${tid}/messages`, { token })).json()) as Message[];
    expect(msgs.at(-1)).toMatchObject({ role: "user", text: "첫 질문: 제주 맛집 찾아줘" });
    expect(msgs.some((m) => m.text.includes("멈췄어요"))).toBe(false);

    h.turns.set(async () => outcome("서울 날씨는 맑아요"));
    await readSse(await h.req("POST", `/api/threads/${tid}/messages`, { token, body: { text: "두 번째: 서울 날씨" } }));
    const input = h.turns.inputs.at(-1)!;
    expect(input.userText).toBe("두 번째: 서울 날씨");
    expect(input.history.slice(-2)).toEqual([
      { role: "user", content: "첫 질문: 제주 맛집 찾아줘" },
      { role: "assistant", content: CANCEL_NOTE },
    ]);
    // the system prompt carries the "don't pick it up again" rule only while a cancel note is in history
    expect(input.system).toContain(CANCEL_RULE);
    const other = (await (await h.req("POST", "/api/threads", { token, body: { title: "다른 일" } })).json()) as { id: string };
    await readSse(await h.req("POST", `/api/threads/${other.id}/messages`, { token, body: { text: "안녕" } }));
    expect(h.turns.inputs.at(-1)!.system).not.toContain(CANCEL_RULE);
  });

  test("a message sent right after Stop starts a fresh turn instead of being swallowed by the stopped one", async () => {
    const { token, session } = await h.signup("haneul");
    const tid = session.mainThreadId;
    // the stopped turn needs a moment to wind down after the abort (model call, settle wait)
    h.turns.set((input) =>
      waitForAbort(input.ctx.signal).catch(async (err) => {
        await Bun.sleep(30);
        throw err;
      }),
    );
    const ac = new AbortController();
    const r = sseReader(await h.req("POST", `/api/threads/${tid}/messages`, { token, body: { text: "피보나치 수열 30번째 값 계산해줘" }, signal: ac.signal }));
    await r.next((e) => e.type === "start");
    ac.abort();
    await r.cancel();

    // no idle() wait: the next message goes out at once
    h.turns.set(async () => outcome("천만에요"));
    const res = await h.req("POST", `/api/threads/${tid}/messages`, { token, body: { text: "고마워" } });
    expect(res.status).toBe(200);
    expect((await readSse(res)).at(-1)).toMatchObject({ type: "done", message: { text: "천만에요" } });
    const input = h.turns.inputs.at(-1)!;
    expect(input.userText).toBe("고마워");
    expect(input.history.slice(-2)).toEqual([
      { role: "user", content: "피보나치 수열 30번째 값 계산해줘" },
      { role: "assistant", content: CANCEL_NOTE },
    ]);
    const msgs = (await (await h.req("GET", `/api/threads/${tid}/messages`, { token })).json()) as Message[];
    expect(msgs.slice(-3).map((m) => [m.role, m.text])).toEqual([
      ["user", "피보나치 수열 30번째 값 계산해줘"],
      ["user", "고마워"],
      ["assistant", "천만에요"],
    ]);
  });

  test("stopped mid-tool with no text: the tool chip stays, history gets the cancel note", async () => {
    const { token, session } = await h.signup("haneul");
    const tid = session.mainThreadId;
    h.turns.set(async (input, emit) => {
      emit({ type: "tool", tool: { id: "t1", name: "k_weather", title: "날씨 확인", state: "running", startedAt: 1 } });
      return waitForAbort(input.ctx.signal);
    });
    await stop(token, tid, "날씨 알려줘");
    const msgs = (await (await h.req("GET", `/api/threads/${tid}/messages`, { token })).json()) as Message[];
    expect(msgs.at(-1)!.tools[0]).toMatchObject({ name: "k_weather", state: "error" });
    expect(msgs.at(-1)!.text).toBe("");

    h.turns.set(async () => outcome("네"));
    await readSse(await h.req("POST", `/api/threads/${tid}/messages`, { token, body: { text: "다른 거 물어볼게" } }));
    expect(h.turns.inputs.at(-1)!.history.slice(-2)).toEqual([
      { role: "user", content: "날씨 알려줘" },
      { role: "assistant", content: CANCEL_NOTE },
    ]);
  });

  test("stopping an approved action before it produced anything cancels the original request", async () => {
    const { token, session } = await h.signup("haneul");
    const tid = session.mainThreadId;
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
    ac.abort();
    await r.cancel();
    await h.app.core.idle();

    h.turns.set(async () => outcome("네"));
    await readSse(await h.req("POST", `/api/threads/${tid}/messages`, { token, body: { text: "다른 얘기" } }));
    expect(h.turns.inputs.at(-1)!.history.slice(-2)).toEqual([
      { role: "user", content: "슬랙에 보내줘" },
      { role: "assistant", content: CANCEL_NOTE },
    ]);
  });

  test("Stop drops steered messages too: no follow-up turn, one cancel note after the last of them", async () => {
    const { token, session } = await h.signup("haneul");
    const tid = session.mainThreadId;
    h.turns.set((input) => waitForAbort(input.ctx.signal)); // never polls steer(): both stay queued
    const ac = new AbortController();
    const r = sseReader(await h.req("POST", `/api/threads/${tid}/messages`, { token, body: { text: "첫 질문" }, signal: ac.signal }));
    await r.next((e) => e.type === "start");
    for (const text of ["추가 1", "추가 2"]) expect((await h.req("POST", `/api/threads/${tid}/messages`, { token, body: { text } })).status).toBe(202);
    ac.abort();
    await r.cancel();
    await h.app.core.idle();
    expect(h.turns.inputs).toHaveLength(1); // no follow-up for the queued steers

    const msgs = (await (await h.req("GET", `/api/threads/${tid}/messages`, { token })).json()) as Message[];
    expect(msgs.slice(-3).map((m) => [m.role, m.text])).toEqual([
      ["user", "첫 질문"],
      ["user", "추가 1"],
      ["user", "추가 2"],
    ]);

    h.turns.set(async () => outcome("네"));
    await readSse(await h.req("POST", `/api/threads/${tid}/messages`, { token, body: { text: "새 질문" } }));
    expect(h.turns.inputs).toHaveLength(2);
    const input = h.turns.inputs.at(-1)!;
    expect(input.userText).toBe("새 질문");
    expect(input.history.slice(-4)).toEqual([
      { role: "user", content: "첫 질문" },
      { role: "user", content: "추가 1" },
      { role: "user", content: "추가 2" },
      { role: "assistant", content: CANCEL_NOTE },
    ]);
    expect(input.history.filter((m) => m.content === CANCEL_NOTE)).toHaveLength(1);
  });

  test("a steer the turn already drained is cancelled with it", async () => {
    const { token, session } = await h.signup("haneul");
    const tid = session.mainThreadId;
    let steered: string[] = [];
    let sent!: () => void;
    const steerSent = new Promise<void>((res) => (sent = res));
    h.turns.set(async (input) => {
      await steerSent;
      steered = input.steer!();
      return waitForAbort(input.ctx.signal);
    });
    const ac = new AbortController();
    const r = sseReader(await h.req("POST", `/api/threads/${tid}/messages`, { token, body: { text: "첫 질문" }, signal: ac.signal }));
    await r.next((e) => e.type === "start");
    expect((await h.req("POST", `/api/threads/${tid}/messages`, { token, body: { text: "그리고 이것도" } })).status).toBe(202);
    sent();
    await Bun.sleep(5);
    expect(steered).toEqual(["그리고 이것도"]);
    ac.abort();
    await r.cancel();
    await h.app.core.idle();

    h.turns.set(async () => outcome("네"));
    await readSse(await h.req("POST", `/api/threads/${tid}/messages`, { token, body: { text: "새 질문" } }));
    expect(h.turns.inputs).toHaveLength(2);
    expect(h.turns.inputs.at(-1)!.history.slice(-3)).toEqual([
      { role: "user", content: "첫 질문" },
      { role: "user", content: "그리고 이것도" },
      { role: "assistant", content: CANCEL_NOTE },
    ]);
  });

  test("partial text keeps its own history AND gets the cancel note (a cut-off answer was read as an accident)", async () => {
    const { token, session } = await h.signup("haneul");
    const tid = session.mainThreadId;
    h.turns.set(async (input, emit) => {
      emit({ type: "text", delta: "제주 맛집은" });
      return waitForAbort(input.ctx.signal);
    });
    const ac = new AbortController();
    const r = sseReader(await h.req("POST", `/api/threads/${tid}/messages`, { token, body: { text: "제주 맛집" }, signal: ac.signal }));
    await r.next((e) => e.type === "text");
    ac.abort();
    await r.cancel();
    await h.app.core.idle();
    h.turns.set(async () => outcome("네"));
    await readSse(await h.req("POST", `/api/threads/${tid}/messages`, { token, body: { text: "계속" } }));
    const input = h.turns.inputs.at(-1)!;
    expect(input.history.slice(-2)).toEqual([
      { role: "assistant", content: "제주 맛집은" },
      { role: "assistant", content: CANCEL_NOTE },
    ]);
    expect(input.history.filter((m) => m.content === CANCEL_NOTE)).toHaveLength(1);
    // "계속" is asking again: the rule only holds the stopped request until then
    expect(input.system).toContain(CANCEL_RULE);
    // the bubble is untouched
    const rows = (await (await h.req("GET", `/api/threads/${tid}/messages`, { token })).json()) as { role: string; text: string }[];
    expect(rows.filter((m) => m.role === "assistant").map((m) => m.text)).toContain("제주 맛집은");
  });
});

describe("aborted turns keep the actions that already ran", () => {
  // like @pickle/agent's loop: a tool ran, the follow-up model call is cut off, and the partial
  // outcome is attached to the error a moment AFTER the abort fires
  function toolThenHang(partials: WeakMap<object, unknown>) {
    const call = { id: "c_art", type: "function" as const, function: { name: "sys_create_artifact", arguments: '{"title":"제주 일정"}' } };
    const tool = { id: "c_art", name: "sys_create_artifact", title: "문서 만들기", state: "done" as const, startedAt: 1, endedAt: 2 };
    const messages = [
      { role: "assistant" as const, content: null, tool_calls: [call] },
      { role: "tool" as const, tool_call_id: "c_art", content: '{"ok":true,"summary":"보관함에 저장했어요"}' },
    ];
    return (input: { ctx: { signal: AbortSignal } }, emit: (e: unknown) => void) => {
      emit({ type: "tool", tool });
      return new Promise<never>((_, rej) =>
        input.ctx.signal.addEventListener(
          "abort",
          () =>
            setTimeout(() => {
              const err = input.ctx.signal.reason as object;
              partials.set(err, { text: "", cards: [], tools: [tool], messages, usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 } });
              rej(err);
            }, 10),
          { once: true },
        ),
      );
    };
  }

  test("an upstream timeout after a tool ran puts the tool call in history, so the next turn doesn't redo it", async () => {
    await h.close();
    h = await makeHarness({ config: { turnIdleTimeoutMs: 30 } });
    const partials = new WeakMap<object, unknown>();
    h.app.core.deps.partialOutcome = ((e: unknown) => (e && typeof e === "object" ? (partials.get(e) ?? null) : null)) as never;
    const { token, session } = await h.signup("haneul");
    const tid = session.mainThreadId;
    h.turns.set(toolThenHang(partials) as never);
    const ev = await readSse(await h.req("POST", `/api/threads/${tid}/messages`, { token, body: { text: "제주 일정 문서로 만들어줘" } }));
    expect(ev.at(-1)).toMatchObject({ type: "error", error: "upstream_timeout" });

    h.turns.set(async () => outcome("네"));
    await readSse(await h.req("POST", `/api/threads/${tid}/messages`, { token, body: { text: "매일 아침 브리핑도 해줘" } }));
    const hist = h.turns.inputs.at(-1)!.history;
    expect(hist.slice(-3).map((m) => m.role)).toEqual(["user", "assistant", "tool"]);
    expect(JSON.stringify(hist.at(-2))).toContain("sys_create_artifact");
  });

  test("Stop after a tool ran keeps the tool call AND adds the cancel note", async () => {
    const partials = new WeakMap<object, unknown>();
    h.app.core.deps.partialOutcome = ((e: unknown) => (e && typeof e === "object" ? (partials.get(e) ?? null) : null)) as never;
    const { token, session } = await h.signup("haneul");
    const tid = session.mainThreadId;
    h.turns.set(toolThenHang(partials) as never);
    const ac = new AbortController();
    const r = sseReader(await h.req("POST", `/api/threads/${tid}/messages`, { token, body: { text: "제주 일정 문서로 만들어줘" }, signal: ac.signal }));
    await r.next((e) => e.type === "tool");
    ac.abort();
    await r.cancel();
    await h.app.core.idle();

    h.turns.set(async () => outcome("네"));
    await readSse(await h.req("POST", `/api/threads/${tid}/messages`, { token, body: { text: "다른 얘기" } }));
    const hist = h.turns.inputs.at(-1)!.history;
    expect(hist.slice(-4).map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);
    expect(hist.at(-1)).toEqual({ role: "assistant", content: CANCEL_NOTE });
    expect(JSON.stringify(hist.at(-3))).toContain("sys_create_artifact");
  });
});
