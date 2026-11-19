import { afterEach, describe, expect, test } from "bun:test";
import type { AgentEvent, ApprovalCard, Message, Schedule, Thread, ToolActivity } from "@pickle/protocol";
import type { TurnOutcome } from "@pickle/agent";
import type { MessageRow } from "../src/db/index.ts";
import { CANCEL_NOTE, historyForResume, historyFromRows } from "../src/history.ts";
import { createLogger, type LogFields } from "../src/log.ts";
import { briefingResult, humanRule, listHuman, nextRunAt, parseRule } from "../src/schedules.ts";
import { deleteMessageRow } from "../src/turns.ts";
import { makeHarness, outcome, readSse, sseReader, T0, type Harness } from "./helpers.ts";

const KST = (y: number, mo: number, d: number, h: number, mi: number) => Date.UTC(y, mo - 1, d, h - 9, mi);

describe("schedule rules (KST, no DST)", () => {
  // T0 = Wed 2026-11-11 12:00 KST
  test("daily", () => {
    const r = parseRule("daily@07:30");
    expect(r.canonical).toBe("daily@07:30");
    expect(nextRunAt(r, T0)).toBe(KST(2026, 11, 12, 7, 30));
    expect(nextRunAt(parseRule("daily@13:00"), T0)).toBe(KST(2026, 11, 11, 13, 0));
    expect(nextRunAt(parseRule("daily@12:00"), T0)).toBe(KST(2026, 11, 12, 12, 0)); // strictly after
    expect(nextRunAt(parseRule("daily@00:00"), KST(2026, 12, 31, 23, 59))).toBe(KST(2027, 1, 1, 0, 0));
    expect(parseRule("daily@7:05").canonical).toBe("daily@07:05");
    expect(humanRule(r, T0)).toBe("매일 오전 7:30");
    expect(humanRule(parseRule("daily@00:00"), T0)).toBe("매일 오전 12:00");
    expect(humanRule(parseRule("daily@12:05"), T0)).toBe("매일 오후 12:05");
    expect(humanRule(parseRule("daily@18:00"), T0)).toBe("매일 오후 6:00");
  });

  test("weekly (1=Mon … 7=Sun)", () => {
    const r = parseRule("weekly@5,1,3@09:00");
    expect(r.canonical).toBe("weekly@1,3,5@09:00");
    expect(nextRunAt(r, T0)).toBe(KST(2026, 11, 13, 9, 0)); // Fri
    expect(nextRunAt(parseRule("weekly@3@12:00"), T0)).toBe(KST(2026, 11, 18, 12, 0)); // next Wed
    expect(nextRunAt(parseRule("weekly@7@10:00"), T0)).toBe(KST(2026, 11, 15, 10, 0)); // Sun
    expect(humanRule(r, T0)).toBe("월·수·금 오전 9:00");
    expect(humanRule(parseRule("weekly@1,2,3,4,5@18:30"), T0)).toBe("평일 오후 6:30");
    expect(humanRule(parseRule("weekly@6,7@10:00"), T0)).toBe("주말 오전 10:00");
    // KST weekday even when UTC is still the previous day (Mon 08:00 KST = Sun 23:00 UTC)
    expect(nextRunAt(parseRule("weekly@1@08:00"), KST(2026, 11, 15, 12, 0))).toBe(KST(2026, 11, 16, 8, 0));
  });

  test("once (ISO without offset = KST, ISO with offset, epoch)", () => {
    const r = parseRule("once@2026-11-12T15:00");
    expect(r.canonical).toBe(`once@${KST(2026, 11, 12, 15, 0)}`);
    expect(nextRunAt(r, T0)).toBe(KST(2026, 11, 12, 15, 0));
    expect(humanRule(r, T0)).toBe("11월 12일 오후 3:00");
    expect(parseRule("once@2026-11-12T06:00:00Z").canonical).toBe(`once@${KST(2026, 11, 12, 15, 0)}`);
    expect(parseRule(`once@${KST(2026, 11, 12, 15, 0)}`).canonical).toBe(`once@${KST(2026, 11, 12, 15, 0)}`);
    expect(nextRunAt(parseRule("once@2026-11-10T09:00"), T0)).toBeNull();
    expect(humanRule(parseRule("once@2027-01-02T09:00"), T0)).toBe("2027년 1월 2일 오전 9:00");
  });

  test("the agent's list words: weekday, and 이번 주 / 다음 주 in today's week (KST Mon–Sun) or the next", () => {
    const at = (rule: string, now = T0) => listHuman({ rule: parseRule(rule).canonical, human: "stored" }, now);
    expect(at("once@2026-11-11T19:30")).toBe("11월 11일 (수) 오후 7:30 · 이번 주");
    expect(at("once@2026-11-09T00:00")).toBe("11월 9일 (월) 오전 12:00 · 이번 주"); // past, this week
    expect(at("once@2026-11-15T23:59")).toBe("11월 15일 (일) 오후 11:59 · 이번 주");
    expect(at("once@2026-11-16T10:00")).toBe("11월 16일 (월) 오전 10:00 · 다음 주");
    expect(at("once@2026-11-22T23:30")).toBe("11월 22일 (일) 오후 11:30 · 다음 주");
    expect(at("once@2026-11-23T09:00")).toBe("11월 23일 (월) 오전 9:00"); // later weeks: the date alone
    expect(at("once@2026-11-08T23:59")).toBe("11월 8일 (일) 오후 11:59"); // last week
    expect(at("once@2027-01-04T09:00")).toBe("2027년 1월 4일 (월) 오전 9:00");
    // the week turns at KST midnight, not UTC: Sunday 23:30 KST is 14:30 UTC
    expect(at("once@2026-11-16T00:30", KST(2026, 11, 15, 23, 30))).toBe("11월 16일 (월) 오전 12:30 · 다음 주");
    expect(at("once@2026-11-16T00:30", KST(2026, 11, 16, 0, 10))).toBe("11월 16일 (월) 오전 12:30 · 이번 주");
    expect(at("once@2026-11-15T23:30", KST(2026, 11, 16, 0, 10))).toBe("11월 15일 (일) 오후 11:30");
    // repeating rules and unreadable rows keep the stored words
    expect(listHuman({ rule: "daily@07:30", human: "매일 오전 7:30" }, T0)).toBe("매일 오전 7:30");
    expect(listHuman({ rule: "weekly@1,3,5@09:00", human: "월·수·금 오전 9:00" }, T0)).toBe("월·수·금 오전 9:00");
    expect(listHuman({ rule: "bogus", human: "stored" }, T0)).toBe("stored");
  });

  test("invalid rules", () => {
    for (const bad of ["", "hourly@1", "daily@24:00", "daily@7", "weekly@0@09:00", "weekly@8@09:00", "weekly@@09:00", "once@tomorrow"]) {
      expect(() => parseRule(bad)).toThrow();
    }
  });
});

let h: Harness;
afterEach(async () => {
  await h?.close();
});

describe("schedule routes + scheduler", () => {
  test("CRUD", async () => {
    h = await makeHarness();
    const { token } = await h.signup("haneul");
    const res = await h.req("POST", "/api/schedules", { token, body: { title: "모닝 브리핑", prompt: "날씨 알려줘", rule: "daily@07:30" } });
    expect(res.status).toBe(201);
    const s = (await res.json()) as Schedule;
    expect(s).toMatchObject({ title: "모닝 브리핑", rule: "daily@07:30", human: "매일 오전 7:30", enabled: true, nextRunAt: KST(2026, 11, 12, 7, 30), threadId: null });
    expect((await h.req("POST", "/api/schedules", { token, body: { title: "x", prompt: "y", rule: "once@2020-01-01T00:00" } })).status).toBe(400);
    expect((await h.req("POST", "/api/schedules", { token, body: { title: "x", prompt: "y", rule: "bogus" } })).status).toBe(400);
    const off = (await (await h.req("PATCH", `/api/schedules/${s.id}`, { token, body: { enabled: false } })).json()) as Schedule;
    expect(off).toMatchObject({ enabled: false, nextRunAt: null });
    const on = (await (await h.req("PATCH", `/api/schedules/${s.id}`, { token, body: { enabled: true, rule: "weekly@1,3,5@09:00" } })).json()) as Schedule;
    expect(on).toMatchObject({ enabled: true, human: "월·수·금 오전 9:00", nextRunAt: KST(2026, 11, 13, 9, 0) });
    const other = await h.signup("other");
    expect((await h.req("DELETE", `/api/schedules/${s.id}`, { token: other.token })).status).toBe(404);
    expect((await h.req("DELETE", `/api/schedules/${s.id}`, { token })).status).toBe(200);
    expect(((await (await h.req("GET", "/api/schedules", { token })).json()) as Schedule[]).length).toBe(0);
  });

  test("the agent's schedule list says the weekday and the week; the API's human stays as stored", async () => {
    h = await makeHarness();
    const { token, session } = await h.signup("haneul");
    const rows = [
      ["치과 정기 검진", "once@2026-11-12T19:30"],
      ["팀 주간 회의", "once@2026-11-16T10:00"],
      ["모닝 브리핑", "daily@07:30"],
    ];
    for (const [title, rule] of rows) {
      expect((await h.req("POST", "/api/schedules", { token, body: { title, prompt: "알려줘", rule } })).status).toBe(201);
    }
    let listed: { title: string; human: string }[] = [];
    h.turns.set(async (input) => {
      listed = await input.ctx.store.listSchedules();
      return outcome("ok");
    });
    const { readSse } = await import("./helpers.ts");
    await readSse(await h.req("POST", `/api/threads/${session.mainThreadId}/messages`, { token, body: { text: "이번 주 일정 알려줘" } }));
    expect(Object.fromEntries(listed.map((s) => [s.title, s.human]))).toEqual({
      "치과 정기 검진": "11월 12일 (목) 오후 7:30 · 이번 주",
      "팀 주간 회의": "11월 16일 (월) 오전 10:00 · 다음 주",
      "모닝 브리핑": "매일 오전 7:30",
    });
    const api = (await (await h.req("GET", "/api/schedules", { token })).json()) as Schedule[];
    expect(api.map((s) => s.human).sort()).toEqual(["11월 12일 오후 7:30", "11월 16일 오전 10:00", "매일 오전 7:30"].sort());
  });

  test("tick runs a due schedule in its own schedule thread and notifies", async () => {
    h = await makeHarness({ config: { schedulerIntervalMs: 999_999 } });
    const { token, session } = await h.signup("haneul", { agentName: "깽이" });
    // created via the ToolStore path, like the agent's sys_schedule_create
    h.turns.set(async (input) => {
      const r = await input.ctx.store.createSchedule({ title: "점심 알림", prompt: "점심 메뉴 추천해줘", rule: "daily@12:01" });
      expect(r.human).toBe("매일 오후 12:01");
      expect(await input.ctx.store.listSchedules()).toHaveLength(1);
      return outcome("매일 12시 1분에 알려 드릴게요");
    });
    const { readSse } = await import("./helpers.ts");
    await readSse(await h.req("POST", `/api/threads/${session.mainThreadId}/messages`, { token, body: { text: "매일 점심 메뉴 추천해줘" } }));

    const ev = sseReader(await h.req("GET", `/api/events?token=${token}`));
    await ev.next((e) => e.type === "hello");
    expect(await h.app.scheduler.tick()).toEqual({ schedules: 0, briefings: 0 });

    h.clock.t = KST(2026, 11, 11, 12, 1);
    h.turns.set(async (input) => {
      expect(input.userText).toBe("점심 메뉴 추천해줘");
      return outcome("오늘은 김치찌개 어때요?");
    });
    expect(await h.app.scheduler.tick()).toEqual({ schedules: 1, briefings: 0 });
    const [s] = (await (await h.req("GET", "/api/schedules", { token })).json()) as Schedule[];
    expect(s!.lastRunAt).toBe(KST(2026, 11, 11, 12, 1));
    expect(s!.nextRunAt).toBe(KST(2026, 11, 12, 12, 1));
    const thread = ((await (await h.req("GET", "/api/threads", { token })).json()) as Thread[]).find((t) => t.id === s!.threadId)!;
    expect(thread).toMatchObject({ kind: "schedule", title: "점심 알림", subtitle: "깽이의 예약된 일", unread: true });
    const msgs = (await (await h.req("GET", `/api/threads/${thread.id}/messages`, { token })).json()) as Message[];
    expect(msgs.map((m) => m.role)).toEqual(["event", "assistant"]);
    expect(msgs[0]!.text).toBe("점심 알림 · 매일 오후 12:01"); // the rule, no emoji
    expect(msgs[1]!.text).toBe("오늘은 김치찌개 어때요?");
    expect(await ev.next((e) => e.type === "notification" && e.title === "점심 알림")).toMatchObject({ body: "오늘은 김치찌개 어때요?", threadId: thread.id });
    // not due again in the same minute
    expect(await h.app.scheduler.tick()).toEqual({ schedules: 0, briefings: 0 });
    await ev.cancel();
  });

  test("a busy user is skipped and retried on the next tick", async () => {
    h = await makeHarness();
    const { token, session } = await h.signup("haneul");
    await h.req("POST", "/api/schedules", { token, body: { title: "알림", prompt: "알려줘", rule: "daily@12:05" } });
    h.clock.t = KST(2026, 11, 11, 12, 5);
    const lease = h.launcher.tryAcquire(session.user.id)!;
    expect(await h.app.scheduler.tick()).toEqual({ schedules: 0, briefings: 0 });
    lease.release();
    expect(await h.app.scheduler.tick()).toEqual({ schedules: 1, briefings: 0 });
  });

  test("daily briefing runs once at the user's briefingTime in the main thread", async () => {
    h = await makeHarness({ now: KST(2026, 11, 10, 20, 0) }); // signed up the evening before (not on the sign-up day)
    const { token, session } = await h.signup("haneul");
    h.clock.t = KST(2026, 11, 11, 7, 0);
    expect(await h.app.scheduler.tick()).toEqual({ schedules: 0, briefings: 0 });
    h.clock.t = KST(2026, 11, 11, 7, 31);
    h.turns.set(async (input) => {
      expect(input.userText).toContain("자동 아침 브리핑");
      expect(input.userText).toContain("k_weather");
      expect(input.userText).toContain("sys_show_briefing");
      expect(input.ctx.threadId).toBe(session.mainThreadId);
      return outcome("좋은 아침이에요!");
    });
    expect(await h.app.scheduler.tick()).toEqual({ schedules: 0, briefings: 1 });
    expect(await h.app.scheduler.tick()).toEqual({ schedules: 0, briefings: 0 });
    const msgs = (await (await h.req("GET", `/api/threads/${session.mainThreadId}/messages`, { token })).json()) as Message[];
    expect(msgs.at(-1)!.text).toBe("좋은 아침이에요!");
    expect(msgs.filter((m) => m.role === "event").at(-1)?.text).toBe("오늘의 브리핑");
    // disabled briefing → nothing the next day
    await h.req("PATCH", "/api/settings", { token, body: { notifications: { briefing: false } } });
    h.clock.t = KST(2026, 11, 12, 7, 31);
    expect(await h.app.scheduler.tick()).toEqual({ schedules: 0, briefings: 0 });
  });

  test("no daily briefing on the sign-up day (KST): created 08:00, the first one is the next morning at 07:30", async () => {
    h = await makeHarness({ now: KST(2026, 11, 11, 8, 0) });
    const { token, session } = await h.signup("haneul");
    h.turns.set(async () => outcome("좋은 아침이에요!"));
    // inside the 07:30 + 2 h window, on every tick of the sign-up day: nothing, and the agent stays free
    for (const [hh, mm] of [[8, 0], [8, 0.5], [9, 29]] as const) {
      h.clock.t = KST(2026, 11, 11, hh, 0) + mm * 60_000;
      expect(await h.app.scheduler.tick()).toEqual({ schedules: 0, briefings: 0 });
      expect(h.launcher.leases.size).toBe(0);
    }
    const day1 = (await (await h.req("GET", `/api/threads/${session.mainThreadId}/messages`, { token })).json()) as Message[];
    expect(day1.some((m) => m.text === "오늘의 브리핑")).toBe(false);
    expect(h.turns.inputs).toHaveLength(0);

    h.clock.t = KST(2026, 11, 12, 7, 29);
    expect(await h.app.scheduler.tick()).toEqual({ schedules: 0, briefings: 0 });
    h.clock.t = KST(2026, 11, 12, 7, 30);
    expect(await h.app.scheduler.tick()).toEqual({ schedules: 0, briefings: 1 });
    const day2 = (await (await h.req("GET", `/api/threads/${session.mainThreadId}/messages`, { token })).json()) as Message[];
    expect(day2.filter((m) => m.role === "event").map((m) => m.text)).toEqual(["오늘의 브리핑"]);
    expect(day2.at(-1)!.text).toBe("좋은 아침이에요!");
  });
});

describe("daily briefing: a failed attempt is tried again (fake model and clock)", () => {
  // signed up the evening before, so 11-11 is not the sign-up day; briefingTime 07:30, window 07:30–09:30
  const DAY = "2026-11-11";
  const at = (hh: number, mm: number, day = 11) => {
    h.clock.t = KST(2026, 11, day, hh, mm);
    return h.app.scheduler.tick();
  };
  /** the shape of the key-budget error the gateway gave 11-18 02:19–09:35 */
  const budget429 = (partial?: TurnOutcome) =>
    Object.assign(new Error('OpenGateway 429: {"error":{"type":"budget_exceeded","message":"API key budget exceeded."}}'), {
      name: "UpstreamError",
      status: 429,
      partial,
    });
  const weather = (state: "running" | "done"): ToolActivity => ({
    id: "call_weather_1",
    name: "k_weather",
    title: "서울 날씨 확인",
    state,
    startedAt: 1,
    ...(state === "done" ? { summary: "맑음 3도", endedAt: 2 } : {}),
  });
  const isBriefingPrompt = (m: { role: string; content?: unknown }) => m.role === "user" && typeof m.content === "string" && m.content.includes("[자동 아침 브리핑]");

  async function setup() {
    h = await makeHarness({
      now: KST(2026, 11, 10, 20, 0),
      // like @pickle/agent's partialOutcome: what a rejected runTurn already did (tool calls and results)
      deps: () => ({ partialOutcome: (err: unknown) => ((err as { partial?: TurnOutcome } | null)?.partial ?? null) }),
    });
    const a = await h.signup("haneul");
    const ev = sseReader(await h.req("GET", `/api/events?token=${a.token}`));
    await ev.next((e) => e.type === "hello");
    const uid = a.session.user.id;
    const mainId = a.session.mainThreadId;
    return {
      ...a,
      uid,
      mainId,
      ev,
      state: () => JSON.parse(h.db.kvGet(uid, "sys:briefing_try") ?? "null") as Record<string, unknown> | null,
      /** the main thread from the first "오늘의 브리핑" on (roles and texts), [] when there is none */
      briefingRows: async () => {
        const msgs = (await (await h.req("GET", `/api/threads/${mainId}/messages`, { token: a.token })).json()) as Message[];
        const i = msgs.findIndex((m) => m.role === "event" && m.text === "오늘의 브리핑");
        return i < 0 ? [] : msgs.slice(i).map((m) => ({ role: m.role, text: m.text, tools: m.tools.length, cards: m.cards.length }));
      },
      briefingCalls: () => h.turns.inputs.filter((i) => i.userText?.includes("[자동 아침 브리핑]")).length,
      /** notification banners, event-row pushes and thread errors that reached the app since the last call */
      pushes: async (waitMs = 40) => {
        const got: string[] = [];
        for (;;) {
          const e = await ev.next<any>((x) => x.type === "notification" || x.type === "turn_error" || (x.type === "message" && x.message.role === "event"), waitMs);
          if (!e) return got;
          got.push(
            e.type === "notification" ? `notification ${e.title}: ${e.body}` : e.type === "turn_error" ? `turn_error ${e.threadId === mainId ? "main" : e.threadId}: ${e.message}` : `chip ${e.message.text}`,
          );
        }
      },
    };
  }

  /** the server's log lines from here on (the real logger's format), for the lines about briefings */
  function captureLog(): string[] {
    const lines: string[] = [];
    const real = createLogger();
    const grab =
      (fn: (e: string, f?: LogFields) => void) =>
      (e: string, f?: LogFields): void => {
        const keep = { log: console.log, warn: console.warn, error: console.error };
        const push = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
        console.log = console.warn = console.error = push;
        try {
          fn(e, f);
        } finally {
          Object.assign(console, keep);
        }
      };
    h.app.core.log = { info: grab(real.info), warn: grab(real.warn), error: grab(real.error) };
    return lines;
  }
  const briefingLines = (lines: string[]) => lines.filter((l) => /\] briefing /.test(l));

  test("budget 429 at 07:30 → nothing at 07:40 or 07:49 → the 07:50 attempt answers: one chip, one briefing, one banner", async () => {
    const s = await setup();
    // the person chatted before the briefing: that does not stop retries (only sends after the first attempt do)
    h.clock.t = KST(2026, 11, 11, 7, 0);
    await readSse(await h.req("POST", `/api/threads/${s.mainId}/messages`, { token: s.token, body: { text: "오늘 일찍 일어났어" } }));
    let n = 0;
    h.turns.set(async (input) => {
      if (!input.userText?.includes("[자동 아침 브리핑]")) return outcome("좋은 하루 보내세요");
      if (++n === 1) throw budget429();
      return outcome("좋은 아침이에요! 오늘 서울은 맑아요.");
    });
    expect(await at(7, 30)).toEqual({ schedules: 0, briefings: 0 });
    expect(s.state()).toMatchObject({ day: DAY, n: 1, state: "failed", next: KST(2026, 11, 11, 7, 50) });
    expect(await s.briefingRows()).toEqual([]); // the failed attempt's event row is gone
    expect(await s.pushes()).toEqual([]); // no chip, no banner reached the app
    expect(await at(7, 40)).toEqual({ schedules: 0, briefings: 0 });
    h.clock.t = KST(2026, 11, 11, 7, 49) + 59_999;
    expect(await h.app.scheduler.tick()).toEqual({ schedules: 0, briefings: 0 });
    expect(s.briefingCalls()).toBe(1);
    expect(await at(7, 50)).toEqual({ schedules: 0, briefings: 1 });
    expect(s.briefingCalls()).toBe(2);
    expect(await s.briefingRows()).toEqual([
      { role: "event", text: "오늘의 브리핑", tools: 0, cards: 0 },
      { role: "assistant", text: "좋은 아침이에요! 오늘 서울은 맑아요.", tools: 0, cards: 0 },
    ]);
    expect(await s.pushes()).toEqual(["chip 오늘의 브리핑", "notification 오늘의 브리핑: 좋은 아침이에요! 오늘 서울은 맑아요."]);
    expect(s.state()).toMatchObject({ n: 2, state: "done" });
    // answered: no third attempt, on any later tick of the window
    for (const [hh, mm] of [[8, 10], [8, 30], [9, 29]] as const) expect(await at(hh, mm)).toEqual({ schedules: 0, briefings: 0 });
    expect(s.briefingCalls()).toBe(2);
    await s.ev.cancel();
  });

  test("an app that opened the main thread while the attempt ran drops its chip: message_deleted on every device, then the list row's preview; an answered attempt deletes nothing", async () => {
    const s = await setup();
    const ev2 = sseReader(await h.req("GET", `/api/events?token=${s.token}`)); // another device (or tab) of theirs
    await ev2.next((e) => e.type === "hello");
    /** every event since the last call, until 60 ms pass with none */
    const drain = async (ev: typeof s.ev) => {
      const got: any[] = [];
      for (let e; (e = await ev.next<any>(() => true, 60)); ) got.push(e);
      return got;
    };
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let started!: () => void;
    const running = new Promise<void>((r) => (started = r));
    let n = 0;
    h.turns.set(async (input) => {
      if (!input.userText?.includes("[자동 아침 브리핑]")) return outcome("좋은 하루 보내세요");
      if (++n > 1) return outcome("좋은 아침이에요! 오늘 서울은 맑아요.");
      started();
      await held;
      throw budget429();
    });
    h.clock.t = KST(2026, 11, 11, 7, 0);
    await readSse(await h.req("POST", `/api/threads/${s.mainId}/messages`, { token: s.token, body: { text: "오늘 일찍 일어났어" } }));
    const tick = at(7, 30);
    await running;
    // opened now: the page has the attempt's event row, and the list row shows its note
    const eventId = s.state()!.event as string;
    const page = (await (await h.req("GET", `/api/threads/${s.mainId}/messages`, { token: s.token })).json()) as Message[];
    expect(page.filter((m) => m.role === "event").map((m) => [m.id, m.text])).toEqual([[eventId, "오늘의 브리핑"]]);
    const listed = (await (await h.req("GET", "/api/threads", { token: s.token })).json()) as Thread[];
    expect(listed.find((t) => t.id === s.mainId)?.preview).toBe("오늘의 브리핑");
    for (const ev of [s.ev, ev2]) await drain(ev);
    release();
    expect(await tick).toEqual({ schedules: 0, briefings: 0 });
    expect(s.state()).toMatchObject({ n: 1, state: "failed" });
    for (const ev of [s.ev, ev2]) {
      const got = await drain(ev);
      const deleted = got.filter((e) => e.type === "message_deleted");
      expect(deleted).toEqual([{ type: "message_deleted", threadId: s.mainId, messageId: eventId }]);
      // the list row's preview comes after the delete, back to the last answer
      const updates = got.map((e, i) => [e, i] as const).filter(([e]) => e.type === "thread_updated" && e.thread.id === s.mainId);
      expect(updates.length).toBeGreaterThan(0);
      const [last, i] = updates.at(-1)!;
      expect(i).toBeGreaterThan(got.indexOf(deleted[0]));
      expect(last.thread.preview).toBe("좋은 하루 보내세요");
      expect(got.filter((e) => e.type === "notification" || e.type === "turn_error" || (e.type === "message" && e.message.role === "event"))).toEqual([]);
    }
    expect(await s.briefingRows()).toEqual([]);
    expect(h.db.getMessage(eventId)).toBeNull();
    // a row already gone: nothing to tell
    deleteMessageRow(h.app.core, eventId);
    expect((await drain(s.ev)).map((e) => e.type)).toEqual([]);
    // the 07:50 attempt answers: its chip and banner come, nothing is deleted
    expect(await at(7, 50)).toEqual({ schedules: 0, briefings: 1 });
    for (const ev of [s.ev, ev2]) {
      const got = await drain(ev);
      expect(got.filter((e) => e.type === "message_deleted")).toEqual([]);
      expect(got.filter((e) => e.type === "message" && e.message.role === "event").map((e) => e.message.text)).toEqual(["오늘의 브리핑"]);
    }
    await ev2.cancel();
    await s.ev.cancel();
  });

  test("always failing: exactly 3 attempts (07:30, 07:50, 08:10), nothing on screen, no banner; the log lines", async () => {
    const s = await setup();
    const lines = captureLog();
    const started: number[] = [];
    h.turns.set(async () => {
      started.push(h.clock.t);
      throw budget429();
    });
    for (const [hh, mm] of [[7, 30], [7, 45], [7, 50], [8, 0], [8, 10], [8, 30], [8, 50], [9, 29]] as const) await at(hh, mm);
    expect(s.briefingCalls()).toBe(3);
    expect(started).toEqual([KST(2026, 11, 11, 7, 30), KST(2026, 11, 11, 7, 50), KST(2026, 11, 11, 8, 10)]);
    expect(await s.briefingRows()).toEqual([]);
    expect(await s.pushes()).toEqual([]);
    expect(s.state()).toMatchObject({ n: 3, state: "done", next: null });
    const ours = briefingLines(lines);
    console.log(`server log (briefing lines):\n${ours.join("\n")}`);
    expect(ours).toEqual([
      `[pickle/server] briefing failed user=${s.uid} attempt=1 next=07:50 error=upstream_rate_limited`,
      `[pickle/server] briefing failed user=${s.uid} attempt=2 next=08:10 error=upstream_rate_limited`,
      `[pickle/server] briefing failed user=${s.uid} attempt=3 next=none error=upstream_rate_limited`,
    ]);
    // the next day starts over
    h.turns.set(async () => outcome("좋은 아침이에요!"));
    expect(await at(7, 30, 12)).toEqual({ schedules: 0, briefings: 1 });
    expect(s.state()).toMatchObject({ day: "2026-11-12", n: 1, state: "done" });
    await s.ev.cancel();
  });

  test("an answer stored before the error counts: text then 429, or a briefing card then 429 → no retry, one banner", async () => {
    const s = await setup();
    h.turns.set(async (_input, emit) => {
      emit({ type: "text", delta: "좋은 아침이에요. 오늘 서울은" });
      throw budget429();
    });
    expect(await at(7, 30)).toEqual({ schedules: 0, briefings: 1 });
    expect(s.state()).toMatchObject({ n: 1, state: "done" });
    expect(await at(7, 50)).toEqual({ schedules: 0, briefings: 0 });
    expect(s.briefingCalls()).toBe(1);
    expect(await s.briefingRows()).toEqual([
      { role: "event", text: "오늘의 브리핑", tools: 0, cards: 0 },
      { role: "assistant", text: "좋은 아침이에요. 오늘 서울은", tools: 0, cards: 0 },
    ]);
    expect(await s.pushes()).toEqual(["chip 오늘의 브리핑", "notification 오늘의 브리핑: 좋은 아침이에요. 오늘 서울은"]);

    h.turns.set(async (_input, emit) => {
      emit({ type: "card", card: { type: "briefing", title: "오늘의 브리핑", items: [{ icon: "sun", text: "맑음 3도" }] } });
      throw budget429();
    });
    expect(await at(7, 30, 12)).toEqual({ schedules: 0, briefings: 1 });
    expect(await at(7, 50, 12)).toEqual({ schedules: 0, briefings: 0 });
    expect(s.briefingCalls()).toBe(2);
    expect((await s.briefingRows()).slice(-1)).toEqual([{ role: "assistant", text: "", tools: 0, cards: 1 }]);
    expect(await s.pushes()).toEqual(["chip 오늘의 브리핑", "notification 오늘의 브리핑: 새 소식이 있어요"]);
    await s.ev.cancel();
  });

  test("tool chips only (k_weather ran, then 429) is a failure: tried again; the thread and the history hold one briefing", async () => {
    const s = await setup();
    let n = 0;
    h.turns.set(async (input, emit) => {
      if (!input.userText?.includes("[자동 아침 브리핑]")) return outcome("천만에요");
      if (++n === 1) {
        emit({ type: "tool", tool: weather("running") });
        emit({ type: "tool", tool: weather("done") });
        throw budget429({
          text: "",
          cards: [],
          tools: [weather("done")],
          messages: [
            { role: "assistant", content: null, tool_calls: [{ id: "call_weather_1", type: "function", function: { name: "k_weather", arguments: '{"location":"서울"}' } }] },
            { role: "tool", tool_call_id: "call_weather_1", content: "맑음 3도" },
          ],
          usage: { promptTokens: 1200, completionTokens: 30, totalTokens: 1230 },
        });
      }
      return outcome("좋은 아침이에요! 오늘 서울은 맑아요.");
    });
    expect(await at(7, 30)).toEqual({ schedules: 0, briefings: 0 });
    expect(await s.briefingRows()).toEqual([]); // no "중단됐어요" chip row, no event row
    expect(h.app.core.db.usage(s.uid, "2026-11-11").counted).toBe(1230); // the failed attempt's usage still counts
    expect(await at(7, 50)).toEqual({ schedules: 0, briefings: 1 });
    expect(await s.briefingRows()).toEqual([
      { role: "event", text: "오늘의 브리핑", tools: 0, cards: 0 },
      { role: "assistant", text: "좋은 아침이에요! 오늘 서울은 맑아요.", tools: 0, cards: 0 },
    ]);
    expect(await s.pushes()).toEqual(["chip 오늘의 브리핑", "notification 오늘의 브리핑: 좋은 아침이에요! 오늘 서울은 맑아요."]);
    // the next turn's history: one briefing prompt, then the successful answer; no call from the failed attempt
    h.clock.t = KST(2026, 11, 11, 8, 0);
    await readSse(await h.req("POST", `/api/threads/${s.mainId}/messages`, { token: s.token, body: { text: "고마워" } }));
    const hist = h.turns.inputs.at(-1)!.history;
    expect(hist.filter(isBriefingPrompt)).toHaveLength(1);
    expect(JSON.stringify(hist)).not.toContain("call_weather_1");
    const i = hist.findIndex(isBriefingPrompt);
    expect(hist.slice(i + 1)).toEqual([{ role: "assistant", content: "좋은 아침이에요! 오늘 서울은 맑아요." }]);
    await s.ev.cancel();
  });

  test("window end: an attempt that fails at 09:15 (busy until then) gets no retry; nothing starts after 09:30", async () => {
    const s = await setup();
    const lines = captureLog();
    let lease = h.launcher.tryAcquire(s.uid)!; // the agent works on something else all morning
    for (const [hh, mm] of [[7, 30], [8, 0], [9, 0]] as const) expect(await at(hh, mm)).toEqual({ schedules: 0, briefings: 0 });
    expect(s.state()).toBeNull(); // busy is not an attempt
    expect(h.db.kvGet(s.uid, "sys:briefing_day")).toBeNull();
    lease.release();
    h.turns.set(async () => {
      throw budget429();
    });
    expect(await at(9, 15)).toEqual({ schedules: 0, briefings: 0 });
    expect(s.state()).toMatchObject({ n: 1, state: "done", next: null }); // 09:35 would be past 09:30
    expect(await at(9, 29)).toEqual({ schedules: 0, briefings: 0 });
    expect(await at(9, 35)).toEqual({ schedules: 0, briefings: 0 });
    expect(s.briefingCalls()).toBe(1);
    console.log(`server log (briefing lines):\n${briefingLines(lines).join("\n")}`);
    expect(briefingLines(lines)).toEqual([`[pickle/server] briefing failed user=${s.uid} attempt=1 next=none error=upstream_rate_limited`]);
    // the next day: busy until 09:31 → the window is over, no attempt at all
    lease = h.launcher.tryAcquire(s.uid)!;
    expect(await at(9, 0, 12)).toEqual({ schedules: 0, briefings: 0 });
    lease.release();
    h.turns.set(async () => outcome("좋은 아침이에요!"));
    expect(await at(9, 31, 12)).toEqual({ schedules: 0, briefings: 0 });
    expect(s.briefingCalls()).toBe(1);
    await s.ev.cancel();
  });

  test("the person sends something after a failed attempt (any thread) → no more attempts that day", async () => {
    const s = await setup();
    const lines = captureLog();
    h.turns.set(async (input) => {
      if (input.userText?.includes("[자동 아침 브리핑]")) throw budget429();
      return outcome("네, 정리해 볼게요");
    });
    expect(await at(7, 30)).toEqual({ schedules: 0, briefings: 0 });
    h.clock.t = KST(2026, 11, 11, 7, 35);
    const task = (await (await h.req("POST", "/api/threads", { token: s.token, body: { kind: "task", title: "할 일" } })).json()) as Thread;
    await readSse(await h.req("POST", `/api/threads/${task.id}/messages`, { token: s.token, body: { text: "오늘 할 일 정리해줘" } }));
    h.turns.set(async () => outcome("좋은 아침이에요!"));
    for (const [hh, mm] of [[7, 50], [8, 10], [9, 0]] as const) expect(await at(hh, mm)).toEqual({ schedules: 0, briefings: 0 });
    expect(s.briefingCalls()).toBe(1);
    expect(s.state()).toMatchObject({ n: 1, state: "done", next: null });
    console.log(`server log (briefing lines):\n${briefingLines(lines).join("\n")}`);
    expect(briefingLines(lines)).toEqual([
      `[pickle/server] briefing failed user=${s.uid} attempt=1 next=07:50 error=upstream_rate_limited`,
      `[pickle/server] briefing retry dropped user=${s.uid} attempt=1 reason=user_sent`,
    ]);
    await s.ev.cancel();
  });

  test("a line the person sent into a failing attempt gets the error a turn of their own shows (turn_error); no more attempts", async () => {
    const s = await setup();
    h.turns.set(async (input) => {
      if (input.userText?.includes("[자동 아침 브리핑]")) {
        const res = await h.req("POST", `/api/threads/${s.mainId}/messages`, { token: s.token, body: { text: "오늘 우산 필요해?" } });
        expect(res.status).toBe(202); // steered into the briefing
        expect(input.steer!()).toEqual(["오늘 우산 필요해?"]);
        throw budget429();
      }
      return outcome("아니요, 맑아요.");
    });
    expect(await at(7, 30)).toEqual({ schedules: 0, briefings: 0 });
    expect(await s.pushes()).toEqual(["turn_error main: 지금 요청이 많아요. 잠시 후 다시 시도해 주세요."]);
    const msgs = (await (await h.req("GET", `/api/threads/${s.mainId}/messages`, { token: s.token })).json()) as Message[];
    expect(msgs.at(-1)).toMatchObject({ role: "user", text: "오늘 우산 필요해?" }); // no event row, no tool row after it
    expect(await at(7, 50)).toEqual({ schedules: 0, briefings: 0 });
    expect(s.briefingCalls()).toBe(1);
    // the person's next turn still sees the line (it got no answer)
    h.clock.t = KST(2026, 11, 11, 8, 0);
    await readSse(await h.req("POST", `/api/threads/${s.mainId}/messages`, { token: s.token, body: { text: "대답해 줘" } }));
    expect(h.turns.inputs.at(-1)!.history.filter((m) => m.role === "user").map((m) => m.content).slice(-1)).toEqual(["오늘 우산 필요해?"]);
    await s.ev.cancel();
  });

  test("a line sent too late for the failing attempt gets a turn of its own; when that fails too, the same turn_error", async () => {
    const s = await setup();
    h.turns.set(async (input) => {
      if (input.userText?.includes("[자동 아침 브리핑]")) {
        expect((await h.req("POST", `/api/threads/${s.mainId}/messages`, { token: s.token, body: { text: "오늘 우산 필요해?" } })).status).toBe(202);
        throw budget429(); // never polled the steer: the line is left over
      }
      expect(input.userText).toBe("오늘 우산 필요해?");
      throw budget429();
    });
    expect(await at(7, 30)).toEqual({ schedules: 0, briefings: 0 });
    expect(await s.pushes(1000)).toEqual(["turn_error main: 지금 요청이 많아요. 잠시 후 다시 시도해 주세요."]);
    expect(h.turns.inputs.map((i) => (i.userText?.includes("[자동 아침 브리핑]") ? "briefing" : i.userText))).toEqual(["briefing", "오늘 우산 필요해?"]);
    await s.ev.cancel();
  });

  test("an approval answered after a failed attempt counts as a send (no more attempts); one that had expired does not", async () => {
    const s = await setup();
    const lines = captureLog();
    const call = { id: "call_send", type: "function" as const, function: { name: "msg_send", arguments: '{"provider":"slack","chat":"#general","text":"점심 12시"}' } };
    const spec = { title: "슬랙 #general에 '점심 12시'를 보낼까요?", detail: "#general 채널에 메시지를 보내요" };
    h.turns.set(async (input, emit) => {
      if (input.userText?.includes("[자동 아침 브리핑]")) throw budget429();
      if (input.resume) return outcome("보내지 않았어요.");
      // pauses for approval like @pickle/agent (provisional approvalId = call.id)
      const card: ApprovalCard = { type: "approval", approvalId: call.id, title: spec.title, detail: spec.detail, status: "pending" };
      emit({ type: "card", card });
      return {
        text: "보내기 전에 확인할게요.",
        cards: [card],
        tools: [{ id: call.id, name: "msg_send", title: "슬랙에 보내기", state: "needs_approval", startedAt: 1 }],
        messages: [],
        usage: { promptTokens: 50, completionTokens: 10, totalTokens: 60 },
        pendingApproval: { call, spec, messages: [{ role: "assistant", content: "보내기 전에 확인할게요.", tool_calls: [call] }] },
      };
    });
    const task = (await (await h.req("POST", "/api/threads", { token: s.token, body: { kind: "task", title: "슬랙" } })).json()) as Thread;
    const pause = async (hh: number, mm: number) => {
      h.clock.t = KST(2026, 11, 11, hh, mm);
      const done = (await readSse(await h.req("POST", `/api/threads/${task.id}/messages`, { token: s.token, body: { text: "슬랙에 점심 12시라고 보내줘" } }))).at(-1) as Extract<AgentEvent, { type: "done" }>;
      return (done.message.cards.find((c) => c.type === "approval") as ApprovalCard).approvalId;
    };
    // both cards come before the first attempt (sends before it do not count); each lives 30 minutes
    const a = await pause(7, 0);
    const b = await pause(7, 25);
    expect(await at(7, 30)).toEqual({ schedules: 0, briefings: 0 });
    h.clock.t = KST(2026, 11, 11, 7, 35);
    expect((await h.req("POST", `/api/approvals/${a}`, { token: s.token, body: { decision: "reject" } })).status).toBe(410); // expired at 07:30
    expect(await at(7, 50)).toEqual({ schedules: 0, briefings: 0 }); // the second attempt runs (and fails)
    expect(s.briefingCalls()).toBe(2);
    h.clock.t = KST(2026, 11, 11, 7, 52);
    await readSse(await h.req("POST", `/api/approvals/${b}`, { token: s.token, body: { decision: "reject" } }));
    for (const [hh, mm] of [[8, 10], [8, 30]] as const) expect(await at(hh, mm)).toEqual({ schedules: 0, briefings: 0 });
    expect(s.briefingCalls()).toBe(2);
    expect(s.state()).toMatchObject({ n: 2, state: "done", next: null });
    expect(briefingLines(lines).at(-1)).toBe(`[pickle/server] briefing retry dropped user=${s.uid} attempt=2 reason=user_sent`);
    await s.ev.cancel();
  });

  test("a friend's message is not the person's send (the retry runs); the person's own line in the shared thread is", async () => {
    const s = await setup();
    const b = await h.signup("jinwoo", { displayName: "진우", agentName: "콩이" });
    await h.req("PATCH", "/api/settings", { token: b.token, body: { notifications: { briefing: false } } });
    const invite = (await (await h.req("POST", "/api/invites", { token: s.token, headers: { host: "pickle.test" } })).json()) as { token: string };
    const friend = (await (await h.req("POST", `/api/invites/${invite.token}/accept`, { token: b.token })).json()) as { threadId: string };
    let n = 0;
    h.turns.set(async () => {
      if (++n % 2 === 1) throw budget429(); // the first attempt of each day fails
      return outcome("좋은 아침이에요!");
    });
    expect(await at(7, 30)).toEqual({ schedules: 0, briefings: 0 });
    h.clock.t = KST(2026, 11, 11, 7, 40);
    expect((await h.req("POST", `/api/threads/${friend.threadId}/messages`, { token: b.token, body: { text: "일어났어?" } })).status).toBe(201);
    expect(await at(7, 50)).toEqual({ schedules: 0, briefings: 1 });
    expect(await at(7, 30, 12)).toEqual({ schedules: 0, briefings: 0 });
    h.clock.t = KST(2026, 11, 12, 7, 40);
    expect((await h.req("POST", `/api/threads/${friend.threadId}/messages`, { token: s.token, body: { text: "응 일어났어" } })).status).toBe(201);
    expect(await at(7, 50, 12)).toEqual({ schedules: 0, briefings: 0 });
    expect(s.briefingCalls()).toBe(3);
    expect(s.state()).toMatchObject({ day: "2026-11-12", n: 1, state: "done" });
    await s.ev.cancel();
  });

  test("busy, over quota and briefing off are not attempts; a changed briefingTime is judged on its own window", async () => {
    const s = await setup();
    let n = 0;
    h.turns.set(async () => {
      if (++n === 1) throw budget429();
      return outcome("좋은 아침이에요!");
    });
    expect(await at(7, 30)).toEqual({ schedules: 0, briefings: 0 });
    const lease = h.launcher.tryAcquire(s.uid)!;
    expect(await at(7, 50)).toEqual({ schedules: 0, briefings: 0 }); // busy
    lease.release();
    h.app.core.db.addUsage(s.uid, "2026-11-11", h.app.core.cfg.dailyTokens);
    expect(await at(7, 55)).toEqual({ schedules: 0, briefings: 0 }); // over the daily quota
    h.db.sql.query("DELETE FROM usage WHERE user_id = $u").run({ u: s.uid });
    await h.req("PATCH", "/api/settings", { token: s.token, body: { notifications: { briefing: false } } });
    expect(await at(8, 0)).toEqual({ schedules: 0, briefings: 0 }); // turned off
    expect(s.state()).toMatchObject({ n: 1, state: "failed" });
    await h.req("PATCH", "/api/settings", { token: s.token, body: { notifications: { briefing: true, briefingTime: "10:00" } } });
    expect(await at(8, 10)).toEqual({ schedules: 0, briefings: 0 }); // before the new 10:00 window
    expect(n).toBe(1);
    expect(await at(10, 0)).toEqual({ schedules: 0, briefings: 1 });
    expect(s.state()).toMatchObject({ n: 2, state: "done" });
    expect((await s.briefingRows()).map((r) => r.role)).toEqual(["event", "assistant"]);
    await s.ev.cancel();
  });

  test("overlapping ticks start one attempt; the attempt is recorded before its turn runs", async () => {
    const s = await setup();
    let seen: unknown = null;
    let day = null as string | null;
    h.turns.set(async () => {
      seen = s.state();
      day = h.db.kvGet(s.uid, "sys:briefing_day");
      await Bun.sleep(30);
      return outcome("좋은 아침이에요!");
    });
    h.clock.t = KST(2026, 11, 11, 7, 30);
    const [a, b] = await Promise.all([h.app.scheduler.tick(), h.app.scheduler.tick()]);
    expect(a.briefings + b.briefings).toBe(1);
    expect(s.briefingCalls()).toBe(1);
    expect(seen).toMatchObject({ day: DAY, n: 1, state: "running", at: KST(2026, 11, 11, 7, 30), next: null });
    expect(day).toBe(DAY);
    expect((await s.briefingRows()).map((r) => r.role)).toEqual(["event", "assistant"]);
    await s.ev.cancel();
  });

  test("a server restart mid-turn: the running mark it left counts as a failed attempt (its event row goes); answered before it → done", async () => {
    const s = await setup();
    const lines = captureLog();
    // what the 07:30 attempt leaves when the server stops during its turn: the day and attempt marks, and the event row
    const left = (day: number, event: string) => {
      const t = KST(2026, 11, day, 7, 30);
      const d = `2026-11-${day}`;
      h.db.insertMessage({ id: event, threadId: s.mainId, role: "event", text: "오늘의 브리핑", llm: [{ role: "user", content: "[자동 아침 브리핑] 하늘 님에게" }], createdAt: t });
      h.db.kvSet(s.uid, "sys:briefing_day", d, t);
      h.db.kvSet(s.uid, "sys:briefing_try", JSON.stringify({ day: d, n: 1, first: t, at: t, state: "running", next: null, event }), t);
    };
    left(11, "m_lost11");
    h.turns.set(async () => outcome("좋은 아침이에요!"));
    expect(await at(7, 31)).toEqual({ schedules: 0, briefings: 0 });
    expect(h.db.getMessage("m_lost11")).toBeNull();
    // an app that loaded the thread after the restart has that row: told to drop it
    const deleted = () => s.ev.next<any>((e) => e.type === "message_deleted", 60);
    expect(await deleted()).toEqual({ type: "message_deleted", threadId: s.mainId, messageId: "m_lost11" });
    expect(s.state()).toMatchObject({ n: 1, state: "failed", next: KST(2026, 11, 11, 7, 50) });
    expect(await at(7, 50)).toEqual({ schedules: 0, briefings: 1 });
    expect((await s.briefingRows()).map((r) => r.role)).toEqual(["event", "assistant"]);
    expect(s.state()).toMatchObject({ n: 2, state: "done" });
    // the server stopped after the answer was stored (a line steered into the turn before it): nothing more that day,
    // the rows stay
    left(12, "m_lost12");
    const t12 = KST(2026, 11, 12, 7, 30);
    h.db.insertMessage({ id: "m_steer12", threadId: s.mainId, role: "user", text: "우산 필요해?", llm: [{ role: "user", content: "우산 필요해?" }], steered: true, createdAt: t12 + 1 });
    h.db.insertMessage({ id: "m_answer12", threadId: s.mainId, role: "assistant", text: "좋은 아침이에요! 우산은 필요 없어요.", createdAt: t12 + 2 });
    for (const [hh, mm] of [[7, 31], [7, 50], [8, 10]] as const) expect(await at(hh, mm, 12)).toEqual({ schedules: 0, briefings: 0 });
    expect(s.briefingCalls()).toBe(1);
    expect(h.db.getMessage("m_lost12")).not.toBeNull();
    expect(await deleted()).toBeNull();
    expect(s.state()).toMatchObject({ day: "2026-11-12", n: 1, state: "done" });
    // the server came back and the person chatted before the next tick: their answer is no briefing, so the leftover
    // event row goes (no chip without its briefing), and their send ends the day
    left(13, "m_lost13");
    h.turns.set(async () => outcome("네, 말씀하세요"));
    h.clock.t = KST(2026, 11, 13, 7, 31);
    await readSse(await h.req("POST", `/api/threads/${s.mainId}/messages`, { token: s.token, body: { text: "잠깐 물어볼게" } }));
    for (const [hh, mm] of [[7, 32], [7, 50], [8, 10]] as const) expect(await at(hh, mm, 13)).toEqual({ schedules: 0, briefings: 0 });
    expect(h.db.getMessage("m_lost13")).toBeNull();
    expect(await deleted()).toEqual({ type: "message_deleted", threadId: s.mainId, messageId: "m_lost13" });
    expect(s.briefingCalls()).toBe(1);
    expect(s.state()).toMatchObject({ day: "2026-11-13", n: 1, state: "done", next: null });
    // a schedule of the main thread ran (and answered) after the restart: its answer is no briefing either
    left(14, "m_lost14");
    const t14 = KST(2026, 11, 14, 7, 30);
    h.db.insertMessage({ id: "m_sched14", threadId: s.mainId, role: "event", text: "영어 단어 · 매일 오전 7:30", llm: [{ role: "user", content: "영어 단어 3개 알려줘" }], createdAt: t14 + 1 });
    h.db.insertMessage({ id: "m_sans14", threadId: s.mainId, role: "assistant", text: "apple, river, stone", createdAt: t14 + 2 });
    h.turns.set(async () => outcome("좋은 아침이에요!"));
    expect(await at(7, 31, 14)).toEqual({ schedules: 0, briefings: 0 });
    expect(h.db.getMessage("m_lost14")).toBeNull();
    expect(await deleted()).toEqual({ type: "message_deleted", threadId: s.mainId, messageId: "m_lost14" });
    expect(await at(7, 50, 14)).toEqual({ schedules: 0, briefings: 1 });
    console.log(`server log (briefing lines):\n${briefingLines(lines).join("\n")}`);
    expect(briefingLines(lines)).toEqual([
      `[pickle/server] briefing failed user=${s.uid} attempt=1 next=07:50 error=server_restart`,
      `[pickle/server] briefing failed user=${s.uid} attempt=1 next=07:50 error=server_restart`,
      `[pickle/server] briefing retry dropped user=${s.uid} attempt=1 reason=user_sent`,
      `[pickle/server] briefing failed user=${s.uid} attempt=1 next=07:50 error=server_restart`,
    ]);
    await s.ev.cancel();
  });

  test("a throw out of the turn: nothing stored → its event row goes and it is tried again; answer stored → done, never sent twice", async () => {
    const s = await setup();
    const lines = captureLog();
    // the turn's last step (the idle status push) throws once: an unexpected error after the turn ran
    const events = h.app.core.events;
    const publish = events.publish.bind(events);
    let boom = 0;
    events.publish = ((userId: string, e: { type: string; status?: string }) => {
      if (boom && e.type === "agent_status" && e.status === "idle") {
        boom--;
        throw new Error("push failed");
      }
      return publish(userId, e as never);
    }) as typeof events.publish;
    let n = 0;
    h.turns.set(async () => {
      if (++n === 1) throw budget429();
      return outcome("좋은 아침이에요!");
    });
    boom = 1;
    expect(await at(7, 30)).toEqual({ schedules: 0, briefings: 0 });
    expect(await s.briefingRows()).toEqual([]);
    expect(s.state()).toMatchObject({ n: 1, state: "failed", next: KST(2026, 11, 11, 7, 50) });
    expect(await at(7, 50)).toEqual({ schedules: 0, briefings: 1 });
    expect((await s.briefingRows()).map((r) => r.role)).toEqual(["event", "assistant"]);
    // the next day the answer is stored, then the push throws: done, the chip stays, no second attempt
    boom = 1;
    expect(await at(7, 30, 12)).toEqual({ schedules: 0, briefings: 1 });
    expect(await at(7, 50, 12)).toEqual({ schedules: 0, briefings: 0 });
    expect(s.briefingCalls()).toBe(3);
    expect(s.state()).toMatchObject({ day: "2026-11-12", n: 1, state: "done" });
    expect((await s.briefingRows()).map((r) => r.role)).toEqual(["event", "assistant", "event", "assistant"]);
    console.log(`server log (briefing lines):\n${briefingLines(lines).join("\n")}`);
    expect(briefingLines(lines)).toEqual([
      `[pickle/server] briefing failed user=${s.uid} attempt=1 next=07:50 error=internal err=Error: push failed`,
      `[pickle/server] briefing error after answer user=${s.uid} attempt=1 err=Error: push failed`,
    ]);
    await s.ev.cancel();
  });

  test("11-18's leftovers: an unanswered briefing event row stays out of the next turn's history", async () => {
    const s = await setup();
    // 07:30 of 11-18 left this in 4 main threads: the event row with the prompt, nothing after it
    h.db.insertMessage({ id: "m_left", threadId: s.mainId, role: "event", text: "오늘의 브리핑", llm: [{ role: "user", content: "[자동 아침 브리핑] 하늘 님에게 오늘의 브리핑을 준비해 주세요." }], createdAt: KST(2026, 11, 11, 7, 30) });
    h.clock.t = KST(2026, 11, 11, 9, 40);
    await readSse(await h.req("POST", `/api/threads/${s.mainId}/messages`, { token: s.token, body: { text: "안녕" } }));
    const input = h.turns.inputs.at(-1)!;
    expect(input.userText).toBe("안녕");
    expect(input.history.filter(isBriefingPrompt)).toHaveLength(0);
    await s.ev.cancel();
  });

  test("history keeps a system request that got its reply: answered, a line steered into it, a resumed turn's own request", () => {
    const row = (o: Partial<MessageRow>): MessageRow =>
      ({ id: "m", thread_id: "t", role: "user", text: "", cards_json: "[]", tools_json: "[]", attachments_json: "[]", author_user_id: null, author_kind: null, llm_json: null, steered: 0, created_at: 0, ...o }) as MessageRow;
    const prompt = "[자동 아침 브리핑] 하늘 님에게 오늘의 브리핑을 준비해 주세요.";
    const event = (id: string, content = prompt) => row({ id, role: "event", text: "오늘의 브리핑", llm_json: JSON.stringify([{ role: "user", content }]) });
    const asst = (id: string, text: string) => row({ id, role: "assistant", text, llm_json: JSON.stringify([{ role: "assistant", content: text }]) });
    const user = (id: string, text: string, steered = 0) => row({ id, text, steered, llm_json: JSON.stringify([{ role: "user", content: text }]) });
    const prompts = (h: { role: string; content?: unknown }[]) => h.filter(isBriefingPrompt).length;
    // unanswered: before a user row, before another system request, at the end
    expect(prompts(historyFromRows([event("1"), user("2", "안녕")]))).toBe(0);
    const lunch = "점심 메뉴 추천해줘"; // a schedule's event row is a system request too
    expect(historyFromRows([event("1"), event("2", lunch), asst("3", "김치찌개 어때요?")]).map((m) => m.content)).toEqual([lunch, "김치찌개 어때요?"]);
    expect(prompts(historyFromRows([asst("0", "어서 와요"), event("1")]))).toBe(0);
    // answered, and answered with a line steered into its turn in between
    expect(prompts(historyFromRows([event("1"), asst("2", "좋은 아침")]))).toBe(1);
    const steered = historyFromRows([event("1"), user("2", "우산 챙길까?", 1), asst("3", "좋은 아침, 우산은 필요 없어요")]);
    expect(steered.map((m) => m.role)).toEqual(["user", "user", "assistant"]);
    expect(prompts(steered)).toBe(1);
    // UI-only event rows are no request
    expect(historyFromRows([row({ id: "1", role: "event", text: "친구가 되었어요" }), user("2", "안녕")]).map((m) => m.content)).toEqual(["안녕"]);
    // a resumed briefing (paused for approval): its rows stop right before the paused reply, so its request stays
    expect(prompts(historyForResume([asst("0", "어서 와요"), event("1")], []))).toBe(1);
    // a Stop note on the request is a reply
    expect(prompts(historyFromRows([row({ id: "1", role: "event", text: "오늘의 브리핑", llm_json: JSON.stringify([{ role: "user", content: prompt }, { role: "assistant", content: CANCEL_NOTE }]) }), user("2", "안녕")]))).toBe(1);
  });

  test("briefingResult: text or a card is an answer; a Stop is the person's choice; nothing (or tool chips only) is a failure", () => {
    const msg = (o: Partial<Message>): Message => ({ id: "m", threadId: "t", role: "assistant", text: "", cards: [], tools: [], createdAt: 1, ...o }) as Message;
    expect(briefingResult({ message: msg({ text: "좋" }), error: { error: "upstream_rate_limited", message: "" }, aborted: false })).toBe("answered");
    expect(briefingResult({ message: msg({ cards: [{ type: "briefing", title: "오늘의 브리핑", items: [] }] }), error: null, aborted: false })).toBe("answered");
    expect(briefingResult({ message: null, error: null, aborted: true })).toBe("stopped");
    expect(briefingResult({ message: msg({ text: "  ", tools: [weather("done")] }), error: { error: "upstream_rate_limited", message: "" }, aborted: false })).toBe("failed");
    expect(briefingResult({ message: null, error: { error: "empty_reply", message: "" }, aborted: false })).toBe("failed");
  });
});
