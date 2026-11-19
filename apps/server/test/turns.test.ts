import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AgentEvent, Message, Thread, ToolActivity } from "@pickle/protocol";
import { systemTools } from "@pickle/agent";
import { makeHarness, outcome, readSse, sseReader, type Harness } from "./helpers.ts";

let h: Harness;
beforeEach(async () => {
  h = await makeHarness();
});
afterEach(async () => {
  await h.close();
});

const tool = (state: ToolActivity["state"], extra: Partial<ToolActivity> = {}): ToolActivity => ({
  id: "call_1",
  name: "k_weather",
  title: "서울 날씨 확인",
  state,
  startedAt: 1,
  ...extra,
});

describe("turns", () => {
  test("send → SSE events in order, persisted message and history replay", async () => {
    const { token, session } = await h.signup("haneul");
    const tid = session.mainThreadId;
    h.turns.set(async (input, emit) => {
      emit({ type: "status", text: "날씨 보는 중" });
      emit({ type: "text", delta: "서울은 " });
      emit({ type: "tool", tool: tool("running") });
      emit({ type: "tool", tool: tool("done", { summary: "서울 14°, 흐림", endedAt: 2 }) });
      emit({ type: "card", card: { type: "weather", place: "서울", now: { tempC: 14, condition: "흐림", icon: "cloud" }, source: "기상청" } });
      emit({ type: "text", delta: "14도예요." });
      expect(input.userText).toBe("오늘 날씨 알려줘");
      expect(input.ctx.userId).toBe(session.user.id);
      expect(input.ctx.agentName).toBe("깽이");
      expect(input.tools.map((t) => t.name)).toEqual(expect.arrayContaining(["k_weather", "sys_phone_call"]));
      expect(input.system).toBe("SYSTEM for 하늘");
      const kv = input.ctx.store.kv;
      await kv.set("location", "강남구");
      expect(await kv.get("location")).toBe("강남구");
      return {
        text: "서울은 14도예요.",
        cards: [{ type: "weather", place: "서울", now: { tempC: 14, condition: "흐림", icon: "cloud" }, source: "기상청" }],
        tools: [tool("done", { summary: "서울 14°, 흐림", endedAt: 2 })],
        messages: [
          { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "k_weather", arguments: '{"city":"서울"}' } }] },
          { role: "tool", tool_call_id: "call_1", content: '{"ok":true}' },
          { role: "assistant", content: "서울은 14도예요." },
        ],
        usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 },
      };
    });

    const res = await h.req("POST", `/api/threads/${tid}/messages`, { token, body: { text: "오늘 날씨 알려줘" } });
    expect(res.status).toBe(200);
    const events = await readSse(res);
    expect(events.map((e) => e.type)).toEqual(["start", "status", "text", "tool", "tool", "card", "text", "done"]);
    const start = events[0] as Extract<AgentEvent, { type: "start" }>;
    expect(start.threadId).toBe(tid);
    expect(start.userMessage?.text).toBe("오늘 날씨 알려줘");
    const done = events.at(-1) as Extract<AgentEvent, { type: "done" }>;
    expect(done.message.id).toBe(start.messageId);
    expect(done.message.text).toBe("서울은 14도예요.");
    expect(done.message.cards[0]!.type).toBe("weather");
    expect(done.message.tools[0]!.state).toBe("done");
    expect(done.quota.usedTokens).toBe(120);

    // recall + prompt context
    const p = h.launcher.prompts.at(-1)!;
    expect(p.ctx.recalled).toEqual(["사용자는 강남역 근처에서 일해요"]);
    expect(p.ctx.skills).toEqual(["- k_weather: 날씨 확인"]);
    expect(p.ctx.mode).toBe("text");

    // persisted
    const msgs = (await (await h.req("GET", `/api/threads/${tid}/messages`, { token })).json()) as Message[];
    expect(msgs.map((m) => m.role)).toEqual(["assistant", "user", "assistant"]);
    expect(msgs[2]!.text).toBe("서울은 14도예요.");

    // second turn sees the first in history (llm_json replay incl. tool call + result)
    h.turns.set(async () => outcome("또 물어봐 주세요"));
    await readSse(await h.req("POST", `/api/threads/${tid}/messages`, { token, body: { text: "고마워" } }));
    const hist = h.turns.inputs.at(-1)!.history;
    expect(hist.map((m) => m.role)).toEqual(["assistant", "user", "assistant", "tool", "assistant"]);
    expect(hist[1]).toEqual({ role: "user", content: "오늘 날씨 알려줘" });
    expect(h.turns.inputs.at(-1)!.userText).toBe("고마워");

    await h.app.core.idle();
    expect(h.launcher.daily.length).toBe(2);
  });

  test("validation: empty, too long, foreign thread", async () => {
    const a = await h.signup("alice");
    const b = await h.signup("bobby");
    const tid = a.session.mainThreadId;
    expect((await h.req("POST", `/api/threads/${tid}/messages`, { token: a.token, body: { text: "   " } })).status).toBe(400);
    expect((await h.req("POST", `/api/threads/${tid}/messages`, { token: a.token, body: { text: "가".repeat(4001) } })).status).toBe(413);
    expect((await h.req("POST", `/api/threads/${tid}/messages`, { token: b.token, body: { text: "hi" } })).status).toBe(404);
    expect(h.turns.inputs).toHaveLength(0);
  });

  test("a second message while a turn is running is steered (202)", async () => {
    const { token, session } = await h.signup("haneul");
    const tid = session.mainThreadId;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let steered: string[] = [];
    let words: string[] = [];
    h.turns.set(async (input, emit) => {
      emit({ type: "text", delta: "잠깐만요" });
      await gate;
      steered = input.steer!();
      words = input.ctx.heard!();
      return outcome("두 가지 다 할게요", {
        messages: [
          { role: "user", content: steered[0]! },
          { role: "assistant", content: "두 가지 다 할게요" },
        ],
      });
    });
    const first = h.req("POST", `/api/threads/${tid}/messages`, { token, body: { text: "날씨 알려줘" } });
    const firstRes = await first;
    await Bun.sleep(5);
    const second = await h.req("POST", `/api/threads/${tid}/messages`, { token, body: { text: "그리고 미세먼지도" } });
    expect(second.status).toBe(202);
    const body = (await second.json()) as { steered: boolean; userMessage: Message };
    expect(body.steered).toBe(true);
    expect(body.userMessage.text).toBe("그리고 미세먼지도");
    release();
    const events = await readSse(firstRes);
    expect(events.at(-1)!.type).toBe("done");
    expect(steered).toEqual(["그리고 미세먼지도"]);
    // where a time may come from (sys_schedule_create's time_quote): this message and the steer
    expect(words).toEqual(["날씨 알려줘", "그리고 미세먼지도"]);
    await h.app.core.idle();
    // next turn's history: the steered user message appears once
    h.turns.set(async (input) => {
      words = input.ctx.heard!();
      return outcome("ok");
    });
    await readSse(await h.req("POST", `/api/threads/${tid}/messages`, { token, body: { text: "다음" } }));
    const hist = h.turns.inputs.at(-1)!.history;
    expect(hist.filter((m) => m.role === "user" && m.content === "그리고 미세먼지도")).toHaveLength(1);
    // …and the earlier user messages of the thread come first
    expect(words.at(-1)).toBe("다음");
    expect(words).toContain("날씨 알려줘");
    expect(words).toContain("그리고 미세먼지도");
  });

  test("what tools returned counts as heard (a calendar's time), the clock and the agent's own words don't", async () => {
    const hh = await makeHarness({ deps: () => ({ systemTools: () => systemTools() }) });
    try {
      const { token, session } = await hh.signup("haneul");
      await hh.req("POST", "/api/schedules", { token, body: { title: "치과 정기 검진", prompt: "치과 가기 전에 알려줘", rule: "once@2026-11-18T19:30" } });
      let heard: string[] = [];
      const reply = "수요일 7시 반에 치과가 있어요. 정오에 알려 드릴까요?";
      hh.turns.set(async (input) => {
        const run = (name: string) => input.tools.find((t) => t.name === name)!.run({}, input.ctx);
        await run("sys_time");
        const listed = await run("sys_schedule_list");
        heard = input.ctx.heard!();
        return outcome(reply, {
          messages: [
            { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "sys_schedule_list", arguments: "{}" } }] },
            { role: "tool", tool_call_id: "c1", content: JSON.stringify(listed) },
            { role: "assistant", content: reply },
          ],
        });
      });
      await readSse(await hh.req("POST", `/api/threads/${session.mainThreadId}/messages`, { token, body: { text: "이번 주 일정 알려줘" } }));
      expect(heard[0]).toBe("이번 주 일정 알려줘");
      expect(heard.some((t) => t.includes("치과 정기 검진") && t.includes("오후 7:30"))).toBe(true);
      expect(heard).toHaveLength(2); // the message and the calendar: sys_time's clock is no source
      // next turn: the earlier tool result comes from history; the agent's own reply never counts
      hh.turns.set(async (input) => {
        heard = input.ctx.heard!();
        return outcome("ok");
      });
      await hh.app.core.idle();
      await readSse(await hh.req("POST", `/api/threads/${session.mainThreadId}/messages`, { token, body: { text: "응 알려줘" } }));
      expect(heard.some((t) => t.includes("치과 정기 검진"))).toBe(true);
      expect(heard.some((t) => t.includes("정오"))).toBe(false);
      expect(heard).toContain("응 알려줘");
    } finally {
      await hh.close();
    }
  });

  test("a reminder quoting the schedule list's words (weekday, week) passes the time guard; a made-up hour still doesn't", async () => {
    const hh = await makeHarness({ deps: () => ({ systemTools: () => systemTools() }) });
    try {
      const { token, session } = await hh.signup("haneul");
      await hh.req("POST", "/api/schedules", { token, body: { title: "팀 주간 회의", prompt: "회의 알려줘", rule: "once@2026-11-16T10:00" } });
      const made: unknown[] = [];
      hh.turns.set(async (input) => {
        const run = (name: string, a: Record<string, unknown> = {}) => input.tools.find((t) => t.name === name)!.run(a, input.ctx);
        const listed = await run("sys_schedule_list");
        expect(JSON.stringify(listed)).toContain("11월 16일 (월) 오전 10:00 · 다음 주");
        const base = { title: "팀 주간 회의 30분 전", prompt: "회의 30분 전이에요" };
        made.push(await run("sys_schedule_create", { ...base, rule: "once@2026-11-16T09:30", time_quote: "11월 16일 (월) 오전 10:00 · 다음 주 · 30분 전" }));
        made.push(await run("sys_schedule_create", { ...base, rule: "once@2026-11-16T08:30", time_quote: "11월 16일 (월) 오전 9:00 · 30분 전" }));
        return outcome("ok");
      });
      await readSse(await hh.req("POST", `/api/threads/${session.mainThreadId}/messages`, { token, body: { text: "팀 주간 회의 30분 전에 알림 하나 걸어줘" } }));
      expect(made[0]).toMatchObject({ ok: true });
      expect(made[1]).toMatchObject({ ok: false });
      const list = (await (await hh.req("GET", "/api/schedules", { token })).json()) as { human: string }[];
      expect(list.map((s) => s.human).sort()).toEqual(["11월 16일 오전 10:00", "11월 16일 오전 9:30"]);
    } finally {
      await hh.close();
    }
  });

  test("a drawn card's result is no time source either (its unsaved-event note included), this turn or from history", async () => {
    const hh = await makeHarness({ deps: () => ({ systemTools: () => systemTools() }) });
    try {
      const { token, session } = await hh.signup("haneul");
      const made: unknown[] = [];
      let heard: string[] = [];
      let note: unknown;
      const card = {
        title: "이번 주 일정",
        kind: "html",
        content: '<div class="d"><b>21</b> 토 <span>오후 12:00 임시</span> 결혼식 <span>시간 미정</span> <span>저장 전</span></div>',
      };
      const quote = { title: "결혼식", prompt: "결혼식 알림", rule: "once@2026-11-21T12:00", time_quote: "오후 12:00 임시" };
      hh.turns.set(async (input) => {
        const run = (name: string, a: Record<string, unknown>) => input.tools.find((t) => t.name === name)!.run(a, input.ctx);
        const drawn = await run("sys_create_artifact", card);
        note = (drawn.data as { note?: string }).note;
        made.push(await run("sys_schedule_create", quote));
        heard = input.ctx.heard!();
        return outcome("토요일 결혼식은 카드에만 그려 뒀어요.", {
          messages: [
            { role: "assistant", content: null, tool_calls: [{ id: "a1", type: "function", function: { name: "sys_create_artifact", arguments: JSON.stringify(card) } }] },
            { role: "tool", tool_call_id: "a1", content: JSON.stringify(drawn) },
            { role: "assistant", content: "토요일 결혼식은 카드에만 그려 뒀어요." },
          ],
        });
      });
      await readSse(await hh.req("POST", `/api/threads/${session.mainThreadId}/messages`, { token, body: { text: "토요일 결혼식 추가해서 다시 보여줘" } }));
      expect(note).toContain("카드에만 그려 뒀어요");
      expect(made).toHaveLength(1);
      expect(heard.some((t) => t.includes("12:00") || t.includes("저장 전"))).toBe(false);
      // next turn: the card's result sits in history; still no source
      hh.turns.set(async (input) => {
        heard = input.ctx.heard!();
        made.push(await input.tools.find((t) => t.name === "sys_schedule_create")!.run(quote, input.ctx));
        return outcome("ok");
      });
      await hh.app.core.idle();
      await readSse(await hh.req("POST", `/api/threads/${session.mainThreadId}/messages`, { token, body: { text: "응 그렇게 해줘" } }));
      expect(heard.some((t) => t.includes("12:00") || t.includes("저장 전"))).toBe(false);
      expect(made).toHaveLength(2);
      for (const r of made) expect(r).toMatchObject({ ok: false, data: { error: "no_time_source" } });
      expect((await (await hh.req("GET", "/api/schedules", { token })).json()) as unknown[]).toEqual([]);
    } finally {
      await hh.close();
    }
  });

  test("the html design guide is no time source, this turn or from history: a made-up noon quoted as '오후 12:00 임시' is not saved", async () => {
    const hh = await makeHarness({ deps: () => ({ systemTools: () => systemTools() }) });
    try {
      const { token, session } = await hh.signup("haneul");
      let heard: string[] = [];
      let created: unknown;
      const guideArgs = { title: "이번 주 일정", kind: "html", content: "" };
      hh.turns.set(async (input) => {
        const guide = await input.tools.find((t) => t.name === "sys_create_artifact")!.run(guideArgs, input.ctx);
        expect(JSON.stringify(guide)).toContain("정오"); // the guide's own rule names it
        heard = input.ctx.heard!();
        return outcome("이번 주 일정이에요.", {
          messages: [
            { role: "assistant", content: null, tool_calls: [{ id: "g1", type: "function", function: { name: "sys_create_artifact", arguments: JSON.stringify(guideArgs) } }] },
            { role: "tool", tool_call_id: "g1", content: JSON.stringify(guide) },
            { role: "assistant", content: "이번 주 일정이에요." },
          ],
        });
      });
      await readSse(await hh.req("POST", `/api/threads/${session.mainThreadId}/messages`, { token, body: { text: "이번 주 일정 카드로" } }));
      expect(heard.some((t) => t.includes("정오"))).toBe(false);
      // next turn: the guide sits in history (kept whole there); still no source
      hh.turns.set(async (input) => {
        heard = input.ctx.heard!();
        const args = { title: "결혼식", prompt: "결혼식 알림", rule: "once@2026-11-21T12:00", time_quote: "토요일 (시간 미정 → 오후 12:00 임시)" };
        created = await input.tools.find((t) => t.name === "sys_schedule_create")!.run(args, input.ctx);
        return outcome("ok");
      });
      await hh.app.core.idle();
      await readSse(await hh.req("POST", `/api/threads/${session.mainThreadId}/messages`, { token, body: { text: "토요일 결혼식 추가해서 다시 보여줘" } }));
      expect(heard.some((t) => t.includes("정오"))).toBe(false);
      expect(created).toMatchObject({ ok: false, data: { error: "no_time_source" } });
      const list = (await (await hh.req("GET", "/api/schedules", { token })).json()) as unknown[];
      expect(list).toEqual([]);
    } finally {
      await hh.close();
    }
  });

  test("runTurn failure → Korean error event, nothing half-persisted", async () => {
    const { token, session } = await h.signup("haneul");
    h.turns.set(async () => {
      throw Object.assign(new Error("boom"), { name: "UpstreamError", status: 502 });
    });
    const events = await readSse(await h.req("POST", `/api/threads/${session.mainThreadId}/messages`, { token, body: { text: "hi" } }));
    expect(events.map((e) => e.type)).toEqual(["start", "error"]);
    const err = events[1] as Extract<AgentEvent, { type: "error" }>;
    expect(err.error).toBe("upstream_error");
    expect(err.message).toContain("AI 서버");
    // lease released → next turn works
    h.turns.set(async () => outcome("복구됐어요"));
    const ok = await readSse(await h.req("POST", `/api/threads/${session.mainThreadId}/messages`, { token, body: { text: "다시" } }));
    expect(ok.at(-1)!.type).toBe("done");
  });

  test("idle upstream timeout aborts the turn with upstream_timeout", async () => {
    await h.close();
    h = await makeHarness({ config: { turnIdleTimeoutMs: 30 } });
    const { token, session } = await h.signup("haneul");
    h.turns.set(() => new Promise(() => {}));
    const events = await readSse(await h.req("POST", `/api/threads/${session.mainThreadId}/messages`, { token, body: { text: "hi" } }));
    expect(events.map((e) => e.type)).toEqual(["start", "error"]);
    expect((events[1] as { error: string }).error).toBe("upstream_timeout");
  });

  test("client disconnect aborts the turn but keeps what was produced", async () => {
    const { token, session } = await h.signup("haneul");
    const tid = session.mainThreadId;
    h.turns.set(async (input, emit) => {
      emit({ type: "text", delta: "부분 응답" });
      await new Promise<void>((_, rej) => input.ctx.signal.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError"))));
      return outcome("never");
    });
    const ac = new AbortController();
    const res = await h.req("POST", `/api/threads/${tid}/messages`, { token, body: { text: "길게 설명해줘" }, signal: ac.signal });
    const r = sseReader(res);
    expect(await r.next((e) => e.type === "text")).toMatchObject({ delta: "부분 응답" });
    ac.abort();
    await r.cancel();
    await h.app.core.idle();
    const msgs = (await (await h.req("GET", `/api/threads/${tid}/messages`, { token })).json()) as Message[];
    expect(msgs.at(-1)!.role).toBe("assistant");
    expect(msgs.at(-1)!.text).toBe("부분 응답");
    expect(h.launcher.leases.size).toBe(0);
  });

  test("memory extraction pushes a notification; task threads get an auto title", async () => {
    const { token, session } = await h.signup("haneul");
    const ev = sseReader(await h.req("GET", `/api/events?token=${token}`));
    expect(await ev.next((e) => e.type === "hello")).toBeTruthy();
    const created = await h.req("POST", "/api/threads", { token, body: { kind: "task" } });
    expect(created.status).toBe(201);
    const thread = (await created.json()) as Thread;
    expect(thread.title).toBe("새 대화");
    await readSse(await h.req("POST", `/api/threads/${thread.id}/messages`, { token, body: { text: "나 고양이 키우는 거 기억해" } }));
    await h.app.core.idle();
    expect(h.launcher.memories.get(session.user.id)?.map((m) => m.text)).toEqual(["사용자는 고양이를 키워요"]);
    const note = await ev.next((e) => e.type === "notification" && e.title === "기억했어요");
    expect(note).toMatchObject({ body: "사용자는 고양이를 키워요" });
    const titled = await ev.next((e) => e.type === "thread_updated" && e.thread.id === thread.id && e.thread.title === "자동 제목");
    expect(titled).toBeTruthy();
    await ev.cancel();
  });

  test("503 when no LLM is configured", async () => {
    await h.close();
    h = await makeHarness();
    (h.app.core.deps as { runTurn: unknown }).runTurn = null;
    const { token, session } = await h.signup("haneul");
    const res = await h.req("POST", `/api/threads/${session.mainThreadId}/messages`, { token, body: { text: "hi" } });
    expect(res.status).toBe(503);
  });
});
