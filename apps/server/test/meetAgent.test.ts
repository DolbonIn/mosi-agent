import { afterEach, describe, expect, test } from "bun:test";
import type { LlmChunk, LlmRequest, ToolDef, ToolResult } from "@pickle/agent";
import { connectionHandle, type ConnectionResolver } from "@pickle/agent";
import { listSkills, skillTools } from "@pickle/skills";
import {
  FALLBACK_TIMEOUT,
  PRIVATE_LINE,
  isMeetPrivateTool,
  isMeetReadTool,
  isOwnerSpeaker,
  meetToolset,
  type MeetTurnState,
  privateSpeechAllowed,
  runMeetTurn,
  speechSafe,
  SupersededTurn,
  type MeetTurnInput,
} from "../src/meetAgent.ts";
import { quotaDay } from "../src/kst.ts";
import { makeHarness, type Harness } from "./helpers.ts";

// ───────────────────────────── fakes ─────────────────────────────

interface Step {
  /** text deltas, in order */
  text?: string[];
  calls?: { name: string; args?: Record<string, unknown> }[];
  /** wait before each delta (and before the calls) */
  delayMs?: number;
  /** never finish (until aborted) */
  hang?: boolean;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((res, rej) => {
    if (signal?.aborted) return rej(signal.reason);
    const t = setTimeout(res, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        rej(signal.reason);
      },
      { once: true },
    );
  });

/** An LlmClient stand-in: step i answers the i-th model call. Records every request. */
function fakeLlm(steps: Step[] | ((req: LlmRequest, i: number) => Step)) {
  const reqs: LlmRequest[] = [];
  const log: string[] = [];
  return {
    model: "fake-meet",
    reqs,
    log,
    async *stream(req: LlmRequest): AsyncGenerator<LlmChunk> {
      reqs.push(req);
      const i = reqs.length - 1;
      const s = typeof steps === "function" ? steps(req, i) : steps[Math.min(i, steps.length - 1)]!;
      for (const d of s.text ?? []) {
        if (s.delayMs) await sleep(s.delayMs, req.signal);
        log.push(`delta:${d}`);
        yield { type: "text", delta: d };
      }
      if (s.hang) await sleep(60_000, req.signal);
      if (s.calls?.length) {
        if (s.delayMs) await sleep(s.delayMs, req.signal);
        yield { type: "tool_calls", calls: s.calls.map((c, k) => ({ id: `c${i}_${k}`, type: "function" as const, function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) } })) };
      }
      yield { type: "usage", usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 } };
    },
  };
}

interface Spy {
  runs: string[];
  /** wall-clock start/end per call */
  spans: { name: string; start: number; end: number }[];
}

function tool(name: string, spy: Spy, result: ToolResult | ((args: Record<string, unknown>) => Promise<ToolResult> | ToolResult), opts: { delayMs?: number; hang?: boolean; extra?: Partial<ToolDef> } = {}): ToolDef {
  return {
    name,
    description: name,
    parameters: { type: "object", properties: { q: { type: "string" }, provider: { type: "string" }, chat: { type: "string" }, text: { type: "string" } } },
    icon: "sparkles",
    title: () => name,
    async run(args, ctx) {
      spy.runs.push(name);
      const start = performance.now();
      if (opts.hang) await sleep(60_000, ctx.signal);
      if (opts.delayMs) await sleep(opts.delayMs, ctx.signal);
      const r = typeof result === "function" ? await result(args) : result;
      spy.spans.push({ name, start, end: performance.now() });
      return r;
    },
    ...opts.extra,
  };
}

// ───────────────────────────── harness ─────────────────────────────

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

interface World {
  h: Harness;
  userId: string;
  token: string;
  threadId: string;
  meetingId: string;
  spy: Spy;
  llm: ReturnType<typeof fakeLlm>;
  said: string[];
  fillers: number[];
  events: string[];
  input(o?: Partial<MeetTurnInput>): MeetTurnInput;
}

async function world(steps: Parameters<typeof fakeLlm>[0], tools: { sys?: ToolDef[]; skills?: ToolDef[]; msg?: ToolDef[] } = {}, spy: Spy = { runs: [], spans: [] }): Promise<World> {
  h = await makeHarness();
  const a = await h.signup("haneul", { displayName: "하늘", agentName: "깽이" });
  const userId = a.session.user.id;
  const core = h.app.core;
  const threadId = "t_meet1";
  core.db.createThread({ id: threadId, ownerId: userId, kind: "call", title: "회의 참여", subtitle: "깽이의 회의 참여", icon: "people", now: core.now() }, [userId]);
  const meetingId = "mt_1";
  core.db.sql
    .query(`INSERT INTO meetings (id, user_id, thread_id, session_id, code, purpose, state, participants, started_at, joined_at) VALUES (?, ?, ?, 's1', 'abc-defg-hij', '', 'in_call', 4, ?, ?)`)
    .run(meetingId, userId, threadId, core.now() - 600_000, core.now() - 590_000);
  core.db.sql
    .query(`INSERT INTO meet_utterances (meeting_id, seq, speaker, text, at, role) VALUES (?, 1, '지민', '출시는 다음 주 금요일로 정할게요.', ?, 'heard')`)
    .run(meetingId, core.now() - 60_000);
  const llm = fakeLlm(steps);
  core.deps.llm = { ...core.deps.llm!, meetClient: llm as never };
  core.deps.systemTools = () => tools.sys ?? [];
  core.deps.skills = { ...core.deps.skills, skillTools: () => tools.skills ?? [] };
  core.deps.hub = { ...core.deps.hub, tools: () => tools.msg ?? [] };
  const said: string[] = [];
  const fillers: number[] = [];
  const events: string[] = [];
  return {
    h,
    userId,
    token: a.token,
    threadId,
    meetingId,
    spy,
    llm,
    said,
    fillers,
    events,
    input: (o = {}) => ({
      userId,
      meetingId,
      threadId,
      utterance: "깽이야 서울 날씨 어때?",
      speaker: "이하늘",
      participants: 4,
      context: '최근 3분 회의 내용:\n지민: 출시는 다음 주 금요일로 정할게요.\n\n방금 이하늘님이 부른 말: "깽이야 서울 날씨 어때?"',
      ownerName: "하늘",
      agentName: "깽이",
      onFiller: () => {
        fillers.push(performance.now());
        events.push("filler");
      },
      onSentence: (s: string) => {
        said.push(s);
        events.push(`say:${s}`);
      },
      ...o,
    }),
  };
}

/** A k-skill login resolver stand-in on the harness core (bogus secret): `login` = whether the owner has connected. */
function fakeConnections(w: World, login: boolean) {
  const calls = { find: 0, use: 0, waitFor: 0, actions: [] as string[] };
  const resolver: ConnectionResolver = {
    async find() {
      calls.find++;
      return login ? { credentialId: "cred_toss1", hint: "•••• 0000" } : null;
    },
    async use(service, purpose, fn) {
      calls.use++;
      calls.actions.push(purpose.action); // "view" for a read, "use" for a write (which a meeting never offers)
      return fn(connectionHandle({ service, secret: { appKey: "bogus-app-key-0000", appSecret: "bogus-app-secret-0000" }, credentialId: "cred_toss1", hint: "•••• 0000" }));
    },
    async waitFor() {
      calls.waitFor++;
      await sleep(5_000);
      return true;
    },
    serviceName: (id) => (id === "toss-investment" ? "토스증권" : id),
  };
  (w.h.app.core as unknown as { connections?: unknown }).connections = { forUser: () => resolver };
  return calls;
}

const threadTexts = (w: World) => w.h.db.sql.query<{ text: string; cards_json: string }, [string]>(`SELECT text, cards_json FROM messages WHERE thread_id = ? ORDER BY created_at, rowid`).all(w.threadId);
const toolNamesSent = (req: LlmRequest) => (req.tools ?? []).map((t) => t.name).sort();

// ───────────────────────────── pure helpers ─────────────────────────────

describe("meeting agent helpers", () => {
  test("owner match is fuzzy: Meet's full name vs the profile's given name", () => {
    expect(isOwnerSpeaker("이하늘", ["하늘"])).toBe(true);
    expect(isOwnerSpeaker("하늘", ["이하늘"])).toBe(true);
    expect(isOwnerSpeaker("이하늘 (Haneul)", ["이하늘"])).toBe(true);
    expect(isOwnerSpeaker("Haneul Lee", ["haneul lee"])).toBe(true);
    expect(isOwnerSpeaker("김대리", ["하늘"])).toBe(false);
    expect(isOwnerSpeaker(null, ["하늘"])).toBe(false);
    expect(isOwnerSpeaker("늘", ["하늘"])).toBe(false); // one character is not enough
    expect(isOwnerSpeaker("남궁하늘", ["하늘"])).toBe(true);
    expect(isOwnerSpeaker("Haneul Lee", ["Haneul"])).toBe(true);
    // not someone whose name merely contains the owner's
    expect(isOwnerSpeaker("Brian Kim", ["Ian Kim"])).toBe(false);
    expect(isOwnerSpeaker("Joanna Lee", ["Anna"])).toBe(false);
    expect(isOwnerSpeaker("하늘우", ["하늘"])).toBe(false);
    expect(isOwnerSpeaker("박이하늘", ["늘"])).toBe(false);
  });

  test("private speech only in a 1:1 or to the owner; an unknown head count is a group", () => {
    expect(privateSpeechAllowed(2, false)).toBe(true);
    expect(privateSpeechAllowed(3, false)).toBe(false);
    expect(privateSpeechAllowed(null, false)).toBe(false);
    expect(privateSpeechAllowed(9, true)).toBe(true);
  });

  test("tool policy: a write tool is never a meeting read tool, whatever its name; k-skill login and private tools are private", () => {
    const d = (name: string, extra: Partial<ToolDef> & { private?: boolean } = {}) =>
      ({ name, description: name, parameters: { type: "object", properties: {} }, icon: "sparkles", title: () => name, run: async () => ({ ok: true, summary: "" }), ...extra }) as ToolDef;
    expect(isMeetReadTool(d("k_weather"))).toBe(true);
    expect(isMeetReadTool(d("k_popbill_invoices", { connection: "popbill" }))).toBe(true);
    expect(isMeetReadTool(d("k_popbill_issue_invoice", { connection: "popbill", write: true }))).toBe(false);
    expect(isMeetReadTool(d("sys_web_fetch", { write: true }))).toBe(false);
    expect(isMeetReadTool(d("sys_remember"))).toBe(false);
    // a login tool is private by default; `private: false` opts out (public data); `private: true` is private with or without a login
    expect(isMeetPrivateTool(d("k_toss_portfolio", { connection: "toss-investment" }))).toBe(true);
    expect(isMeetPrivateTool(d("k_toss_quote", { connection: "toss-investment", private: false }))).toBe(false);
    expect(isMeetPrivateTool(d("k_toss_orders", { connection: "toss-investment", private: true }))).toBe(true);
    expect(isMeetPrivateTool(d("k_naver_ad_report", { private: true }))).toBe(true);
    expect(isMeetPrivateTool(d("msg_read", { private: false }))).toBe(true); // the built-in list can't be opted out
    expect(isMeetPrivateTool(d("msg_read"))).toBe(true);
    expect(isMeetPrivateTool(d("k_weather"))).toBe(false);
  });

  test("speech never carries phone numbers, e-mails, card numbers, URLs or markdown", () => {
    const s = speechSafe("**연락처**는 010-1234-5678, kim@example.com 이고 카드 1234 5678 9012 3456 이에요. https://x.y/z");
    expect(s).not.toMatch(/010|1234|example|https|\*/);
    expect(s).toContain("전화번호");
    expect(s).toContain("이메일 주소");
  });
});

// ───────────────────────────── turns ─────────────────────────────

describe("runMeetTurn", () => {
  test("only the meeting allowlist reaches the model; an excluded tool is never run even if the model calls it", async () => {
    const spy: Spy = { runs: [], spans: [] };
    const w = await world(
      [{ calls: [{ name: "sys_meet_say", args: { text: "안녕" } }, { name: "sys_remember", args: { text: "x" } }] }, { text: ["그건 여기서 할 수 없어요."] }],
      {
        sys: [
          tool("sys_time", spy, { ok: true, summary: "12:00" }),
          tool("sys_remember", spy, { ok: true, summary: "기억" }),
          tool("sys_friends_list", spy, { ok: true, summary: "친구" }),
          tool("sys_show_briefing", spy, { ok: true, summary: "브리핑" }),
          tool("sys_schedule_list", spy, { ok: true, summary: "0개" }),
          tool("sys_create_artifact", spy, { ok: true, summary: "저장" }),
          tool("sys_web_fetch", spy, { ok: true, summary: "페이지" }),
          tool("sys_schedule_create", spy, { ok: true, summary: "예약" }),
        ],
        skills: [tool("k_weather", spy, { ok: true, summary: "맑음" }), tool("k_news", spy, { ok: true, summary: "뉴스" })],
        msg: [
          tool("msg_read", spy, { ok: true, summary: "읽음" }),
          tool("msg_send", spy, { ok: true, summary: "보냄" }),
          tool("msg_list_chats", spy, { ok: true, summary: "목록" }),
        ],
      },
      spy,
    );
    const r = await runMeetTurn(w.h.app.core, w.input());
    const sent = toolNamesSent(w.llm.reqs[0]!);
    expect(sent).toEqual(
      [
        "k_news",
        "k_weather",
        "msg_list_chats",
        "msg_read",
        "msg_send",
        "sys_call_me",
        "sys_create_artifact",
        "sys_meet_notes",
        "sys_phone_call",
        "sys_schedule_create",
        "sys_schedule_list",
        "sys_time",
        "sys_web_fetch",
      ].sort(),
    );
    for (const banned of ["sys_meet_say", "sys_leave_meet", "sys_join_meet", "sys_remember", "sys_friends_list", "sys_show_briefing"]) expect(sent).not.toContain(banned);
    // the acting tools are stand-ins: no approval/credential hooks the runner could pause on
    for (const t of w.llm.reqs[0]!.tools ?? []) expect(t.approval).toBeUndefined();
    expect(spy.runs).toEqual([]);
    const toolMsgs = w.llm.reqs[1]!.messages.filter((m) => m.role === "tool").map((m) => (m as { content: string }).content);
    expect(toolMsgs.join(" ")).toContain("unknown tool");
    expect(r.outcome).toBe("ok");
    expect(w.said).toEqual(["그건 여기서 할 수 없어요."]);
  });

  test("filler fires once, before the first tool runs, even across two tool rounds", async () => {
    const spy: Spy = { runs: [], spans: [] };
    let fillersAtRun = -1;
    const w = await world(
      [{ calls: [{ name: "k_weather", args: { q: "서울" } }] }, { calls: [{ name: "k_fine_dust", args: { q: "서울" } }] }, { text: ["서울은 맑고 ", "미세먼지는 좋음이에요. ", "나들이하기 좋아요."] }],
      {
        skills: [
          tool("k_weather", spy, () => {
            fillersAtRun = w.fillers.length;
            return { ok: true, summary: "서울 14°, 맑음" };
          }),
          tool("k_fine_dust", spy, { ok: true, summary: "좋음" }),
        ],
      },
      spy,
    );
    const r = await runMeetTurn(w.h.app.core, w.input());
    expect(fillersAtRun).toBe(1);
    expect(w.fillers.length).toBe(1);
    expect(w.events[0]).toBe("filler");
    expect(r.tools).toEqual(["k_weather", "k_fine_dust"]);
    expect(r.timings.fillerMs).not.toBeNull();
    expect(w.said).toEqual(["서울은 맑고 미세먼지는 좋음이에요.", "나들이하기 좋아요."]);
  });

  test("no filler when the model already spoke a sentence before calling the tool", async () => {
    const spy: Spy = { runs: [], spans: [] };
    const w = await world([{ text: ["확인해 볼게요. "], calls: [{ name: "k_weather" }] }, { text: ["서울은 맑아요."] }], { skills: [tool("k_weather", spy, { ok: true, summary: "맑음" })] }, spy);
    await runMeetTurn(w.h.app.core, w.input());
    expect(w.fillers.length).toBe(0);
    expect(w.said).toEqual(["확인해 볼게요.", "서울은 맑아요."]);
  });

  test("independent tool calls run in parallel", async () => {
    const spy: Spy = { runs: [], spans: [] };
    const w = await world([{ calls: [{ name: "k_weather" }, { name: "k_news" }, { name: "k_stock" }] }, { text: ["다 확인했어요."] }], {
      skills: [
        tool("k_weather", spy, { ok: true, summary: "맑음" }, { delayMs: 150 }),
        tool("k_news", spy, { ok: true, summary: "뉴스" }, { delayMs: 150 }),
        tool("k_stock", spy, { ok: true, summary: "주가" }, { delayMs: 150 }),
      ],
    }, spy);
    const t0 = performance.now();
    await runMeetTurn(w.h.app.core, w.input());
    const ms = performance.now() - t0;
    expect(spy.spans.length).toBe(3);
    const latestStart = Math.max(...spy.spans.map((s) => s.start));
    const earliestEnd = Math.min(...spy.spans.map((s) => s.end));
    expect(latestStart).toBeLessThan(earliestEnd);
    expect(ms).toBeLessThan(400);
  });

  test("a tool past its timeout is reported to the model, which still answers", async () => {
    const spy: Spy = { runs: [], spans: [] };
    const w = await world([{ calls: [{ name: "k_subway_arrival" }] }, { text: ["지하철 정보를 지금은 확인하지 못했어요."] }], { skills: [tool("k_subway_arrival", spy, { ok: true, summary: "곧 도착" }, { hang: true })] }, spy);
    const r = await runMeetTurn(w.h.app.core, w.input({ toolTimeoutMs: 60 }));
    expect(r.outcome).toBe("ok");
    const toolMsg = w.llm.reqs[1]!.messages.find((m) => m.role === "tool") as { content: string };
    expect(toolMsg.content).toContain("timed out");
    expect(w.said).toEqual(["지하철 정보를 지금은 확인하지 못했어요."]);
  });

  test("the whole turn has a budget: past it, a short fallback is spoken", async () => {
    const w = await world([{ hang: true }]);
    const r = await runMeetTurn(w.h.app.core, w.input({ turnTimeoutMs: 80 }));
    expect(r.outcome).toBe("timeout");
    expect(w.said).toEqual([FALLBACK_TIMEOUT]);
  });

  test("barge-in (signal) stops the model and anything still queued; no fallback", async () => {
    const ctl = new AbortController();
    const w = await world([{ text: ["첫 문장이에요. ", "두 번째 ", "문장이에요. "], delayMs: 40 }]);
    const input = w.input({
      signal: ctl.signal,
      onSentence: (s: string) => {
        w.said.push(s);
        ctl.abort(); // someone says "깽이 그만" right after the first sentence
      },
    });
    const r = await runMeetTurn(w.h.app.core, input);
    expect(r.outcome).toBe("stopped");
    expect(w.said).toEqual(["첫 문장이에요."]);
    expect(threadTexts(w).length).toBe(0);
  });

  test("barge-in returns at once even while a /say is still pending; usage is charged once the runner unwinds", async () => {
    const ctl = new AbortController();
    const w = await world([{ text: ["첫 문장이에요. ", "두 번째 문장이에요. ", "세 번째예요."], delayMs: 30 }]);
    const core = w.h.app.core;
    const day = quotaDay(core.now());
    const before = core.db.usage(w.userId, day).counted;
    let calls = 0;
    const t0 = performance.now();
    const r = await runMeetTurn(
      core,
      w.input({
        signal: ctl.signal,
        onSentence: () => {
          calls++;
          setTimeout(() => ctl.abort(), 10);
          return new Promise(() => {}); // the bot never answers this /say
        },
      }),
    );
    expect(r.outcome).toBe("stopped");
    expect(calls).toBe(1);
    expect(performance.now() - t0).toBeLessThan(500);
    await core.idle();
    expect(core.db.usage(w.userId, day).counted).toBeGreaterThan(before);
  });

  for (const how of ["superseded", "stopped"] as const) {
    test(`a ${how} turn and an approval stand-in that runs after the abort: ${how === "superseded" ? "no card" : "the card is posted"}`, async () => {
      const spy: Spy = { runs: [], spans: [] };
      const ctl = new AbortController();
      // the abort lands while the stand-in is already running (its credential check is the last await before the card)
      const msgSend = tool("msg_send", spy, { ok: true, summary: "보냈어요" }, {
        extra: {
          approval: (a) => ({ title: `슬랙 ${String(a.chat)}에 보낼까요?`, detail: String(a.text) }),
          credential: async () => {
            ctl.abort(how === "superseded" ? new SupersededTurn() : undefined);
            return null;
          },
        },
      });
      const w = await world([{ calls: [{ name: "msg_send", args: { provider: "slack", chat: "김대리", text: "회의 끝나고 봬요" } }] }, { text: ["앱에 확인 카드를 올렸어요."] }], { msg: [msgSend] }, spy);
      const r = await runMeetTurn(w.h.app.core, w.input({ utterance: "깽이야 김 대리한테 슬랙 보내 줘", speaker: "이하늘", signal: ctl.signal }));
      await w.h.app.core.idle();
      expect(r.outcome).toBe("stopped");
      expect(w.said).toEqual([]);
      const approvals = w.h.db.sql.query(`SELECT COUNT(*) AS n FROM approvals`).get();
      if (how === "superseded") {
        // the speaker went on: the turn runs again with the joined words, and that run asks
        expect(r.proposals).toBe(0);
        expect(approvals).toEqual({ n: 0 });
        expect(threadTexts(w).length).toBe(0);
      } else {
        // "모시 그만", a yield, a dismiss, leaving: what the turn already asked for stays asked (the stand-in finishes
        // after the stopped turn has returned, so r.proposals doesn't count it)
        expect(approvals).toEqual({ n: 1 });
        const posts = threadTexts(w);
        expect(posts.length).toBe(1);
        expect(JSON.parse(posts[0]!.cards_json)[0]).toMatchObject({ type: "approval", title: "슬랙 김대리에 보낼까요?", status: "pending" });
      }
    });

    test(`a ${how} turn after sys_create_artifact: ${how === "superseded" ? "nothing posted" : "the document card is posted"}`, async () => {
      const spy: Spy = { runs: [], spans: [] };
      const ctl = new AbortController();
      const commits: number[] = [];
      const artifact = tool("sys_create_artifact", spy, async () => {
        setTimeout(() => ctl.abort(how === "superseded" ? new SupersededTurn() : undefined), 20); // while the model writes the answer
        return { ok: true, summary: "저장했어요", card: { type: "artifact", artifactId: "a1", title: "회의 결정 사항", kind: "document", preview: "출시: 금요일" } };
      });
      const w = await world([{ calls: [{ name: "sys_create_artifact", args: { q: "x" } }] }, { text: ["앱에 문서로 만들어 뒀어요.\n[앱]\n- 출시: 금요일\n"], hang: true }], { sys: [artifact] }, spy);
      const r = await runMeetTurn(w.h.app.core, w.input({ utterance: "깽이야 정한 거 문서로 만들어 줘", signal: ctl.signal, onCommit: () => void commits.push(1) }));
      await w.h.app.core.idle();
      expect(spy.runs).toEqual(["sys_create_artifact"]);
      expect(commits.length).toBe(1); // a tool with an outside effect started
      expect(r.outcome).toBe("stopped");
      const posts = threadTexts(w);
      if (how === "superseded") {
        expect(r.detail).toBe(false);
        expect(posts.length).toBe(0);
      } else {
        // the document exists: its card is posted, as before; the half-written [앱] detail is not
        expect(r.detail).toBe(true);
        expect(posts.length).toBe(1);
        expect(posts[0]!.text).toContain("회의 중에 만든 것");
        expect(posts[0]!.text).not.toContain("출시: 금요일");
        expect(JSON.parse(posts[0]!.cards_json)[0]).toMatchObject({ type: "artifact", artifactId: "a1" });
      }
    });
  }

  test("the system prompt fits a follow-up in conversation mode, not only a fresh call", async () => {
    const w = await world([{ text: ["네, 맞아요."] }]);
    await runMeetTurn(w.h.app.core, w.input());
    expect((w.llm.reqs[0]!.messages[0] as { content: string }).content).toContain("이어서 말을 걸었어");
  });

  test("group meeting + someone else asking: messenger contents are not spoken, they go to the thread", async () => {
    const spy: Spy = { runs: [], spans: [] };
    const w = await world(
      [
        { calls: [{ name: "msg_read", args: { provider: "slack", chat: "general" } }] },
        { text: ["general 채널에서는 배포 일정과 점심 메뉴 얘기가 있었어요. ", "\n[앱]\n- 배포는 금요일 오후 3시\n- 점심은 김밥"] },
      ],
      { msg: [tool("msg_read", spy, { ok: true, summary: "메시지 12개", data: { messages: [{ from: "민수", text: "배포는 금요일 오후 3시" }] } })] },
      spy,
    );
    const r = await runMeetTurn(w.h.app.core, w.input({ speaker: "김대리", participants: 5, utterance: "깽이야 슬랙 general 요약해 줘" }));
    expect(r.private).toBe(true);
    expect(w.said).toEqual([PRIVATE_LINE]);
    expect(w.said.join(" ")).not.toMatch(/배포|김밥|general/);
    const posts = threadTexts(w);
    expect(posts.length).toBe(1);
    expect(posts[0]!.text).toContain("개인 정보");
    expect(posts[0]!.text).toContain("배포는 금요일 오후 3시");
    expect(posts[0]!.text).not.toContain("[앱]");
    expect(posts[0]!.text).not.toContain("general 채널에서는"); // the spoken part isn't repeated when details follow the mark
    // the model was told the rule as well
    expect(JSON.stringify(w.llm.reqs[0]!.messages)).toContain("개인 정보 규칙");
  });

  test("the owner (or a 1:1) hears messenger contents", async () => {
    const spy: Spy = { runs: [], spans: [] };
    const steps: Step[] = [{ calls: [{ name: "msg_read", args: { provider: "slack", chat: "general" } }] }, { text: ["general에서는 배포가 금요일 오후 3시로 잡혔어요."] }];
    const w = await world(steps, { msg: [tool("msg_read", spy, { ok: true, summary: "메시지 12개" })] }, spy);
    const r = await runMeetTurn(w.h.app.core, w.input({ speaker: "이하늘", participants: 6 }));
    expect(r.private).toBe(false);
    expect(w.said).toEqual(["general에서는 배포가 금요일 오후 3시로 잡혔어요."]);
    // a 1:1 with someone whose Meet name doesn't match still counts as private-ok
    w.said.length = 0;
    w.llm.reqs.length = 0;
    const r2 = await runMeetTurn(w.h.app.core, w.input({ speaker: "Guest", participants: 2 }));
    expect(r2.private).toBe(false);
    expect(w.said.length).toBe(1);
  });

  test("no write tool ever reaches a meeting turn: not offered whatever its name, never run even when the owner's model calls it", async () => {
    const spy: Spy = { runs: [], spans: [] };
    const write = (d: ToolDef, extra: Partial<ToolDef> = {}): ToolDef => ({ ...d, write: true, approval: () => ({ title: `${d.name} — 진행할까요?`, detail: "확인하면 바로 실행돼요." }), ...extra });
    const w = await world(
      [
        { calls: [{ name: "k_popbill_issue_invoice", args: { q: "하늘상사" } }, { name: "k_market_buy" }, { name: "sys_web_fetch", args: { q: "https://example.com/form" } }] },
        { text: ["그건 회의 중에는 할 수 없어요."] },
      ],
      {
        sys: [write(tool("sys_web_fetch", spy, { ok: true, summary: "보냈어요" })), tool("sys_time", spy, { ok: true, summary: "12:00" })],
        skills: [
          write(tool("k_popbill_issue_invoice", spy, { ok: true, summary: "발행했어요" }), { connection: "popbill" }),
          write(tool("k_market_buy", spy, { ok: true, summary: "샀어요" })),
          tool("k_popbill_invoices", spy, { ok: true, summary: "3건" }, { extra: { connection: "popbill" } }),
          tool("k_weather", spy, { ok: true, summary: "맑음" }),
        ],
        msg: [write(tool("msg_send", spy, { ok: true, summary: "보냈어요" }))],
      },
      spy,
    );
    const r = await runMeetTurn(w.h.app.core, w.input()); // the owner asking: not even the owner gets a write run from a meeting
    expect(w.llm.reqs.length).toBe(2);
    for (const req of w.llm.reqs) {
      const sent = toolNamesSent(req);
      for (const banned of ["k_popbill_issue_invoice", "k_market_buy", "sys_web_fetch", "msg_send"]) expect(sent).not.toContain(banned);
      for (const kept of ["k_popbill_invoices", "k_weather", "sys_time", "sys_phone_call"]) expect(sent).toContain(kept);
      // nothing offered carries `write` or an approval hook (a write tool gets no card stand-in either; sys_phone_call is one)
      for (const t of req.tools ?? []) {
        expect(t.approval).toBeUndefined();
        expect(t.write).toBeUndefined();
      }
    }
    expect(spy.runs).toEqual([]);
    const toolMsgs = w.llm.reqs[1]!.messages.filter((m) => m.role === "tool").map((m) => (m as { content: string }).content);
    expect(toolMsgs.length).toBe(3);
    for (const c of toolMsgs) expect(c).toContain("unknown tool");
    expect(r.proposals).toBe(0);
    expect(threadTexts(w).length).toBe(0); // no approval card either
    expect(w.said).toEqual(["그건 회의 중에는 할 수 없어요."]);
  });

  test("the real k-skill catalog in a meeting: no write tool offered; login tools keep their login and are private unless they opt out", async () => {
    const w = await world([{ text: ["네."] }]);
    const core = w.h.app.core;
    for (const enabled of [undefined, listSkills().map((s) => s.id)]) {
      const source = skillTools(enabled);
      core.deps.skills = { ...core.deps.skills, skillTools: () => source };
      const offered = meetToolset(core, { userId: w.userId, meetingId: w.meetingId, memory: false }, {} as MeetTurnState, () => {});
      const byName = new Map(offered.map((t) => [t.name, t]));
      expect(offered.some((t) => t.name.startsWith("k_"))).toBe(true);
      for (const t of offered) {
        expect(t.write).toBeUndefined();
        expect(t.approval).toBeUndefined();
      }
      for (const def of source) {
        const flag = (def as ToolDef & { private?: boolean }).private;
        if (def.write) expect(byName.has(def.name)).toBe(false);
        else if (def.connection || flag !== undefined) {
          const t = byName.get(def.name);
          expect(t).toBeDefined();
          expect(t!.connection).toBe(def.connection);
          const wrappedPrivate = (t as ToolDef & { private?: boolean }).private === true;
          expect(wrappedPrivate).toBe(flag === true || (!!def.connection && flag !== false));
        }
      }
    }
  });

  test("a k-skill login tool (the owner's own account) in a group meeting goes to the thread, not to voice; the owner and a 1:1 hear it", async () => {
    const spy: Spy = { runs: [], spans: [] };
    let login: string | undefined;
    const portfolio = tool(
      "k_toss_portfolio",
      spy,
      { ok: true, summary: "보유 종목 2개", data: { holdings: [{ name: "하늘전자", qty: 10 }, { name: "모시식품", qty: 3 }], echo: "bogus-app-key-0000" } },
      { extra: { connection: "toss-investment", connectionReason: "보유 주식을 보려면 토스증권 연결이 필요해요" } },
    );
    const run = portfolio.run;
    portfolio.run = (args, ctx) => {
      login = ctx.connection?.service;
      return run(args, ctx);
    };
    const ads = { ...tool("k_naver_ad_report", spy, { ok: true, summary: "캠페인 2개" }), private: true } as ToolDef;
    const quote = { ...tool("k_toss_quote", spy, { ok: true, summary: "하늘전자 7만 1천 원" }, { extra: { connection: "toss-investment" } }), private: false } as ToolDef;
    const answer = (name: string): Step[] => [{ calls: [{ name }] }, { text: ["하늘전자 10주와 모시식품 3주를 갖고 계세요. ", "\n[앱]\n- 하늘전자 10주\n- 모시식품 3주"] }];
    let steps = answer("k_toss_portfolio");
    const w = await world((_req, i) => steps[Math.min(i, steps.length - 1)]!, { skills: [portfolio, ads, quote, tool("k_weather", spy, { ok: true, summary: "맑음" })] }, spy);
    const calls = fakeConnections(w, true);
    const r = await runMeetTurn(w.h.app.core, w.input({ speaker: "김대리", participants: 5, utterance: "깽이야 주식 뭐 갖고 있어?" }));
    // the wrapper kept `connection`: the runner resolved the owner's login and ran the tool inside it (secret redacted)
    expect(calls.use).toBe(1);
    expect(calls.actions).toEqual(["view"]); // a read: the vault audit says "view", never "use"
    expect(login).toBe("toss-investment");
    expect(spy.runs).toEqual(["k_toss_portfolio"]);
    expect(JSON.stringify(w.llm.reqs[1]!.messages)).not.toContain("bogus-app-key-0000");
    expect(r.private).toBe(true);
    expect(w.said).toEqual([PRIVATE_LINE]);
    expect(w.said.join(" ")).not.toMatch(/하늘전자|모시식품|10주/);
    const posts = threadTexts(w);
    expect(posts.length).toBe(1);
    expect(posts[0]!.text).toContain("개인 정보");
    expect(posts[0]!.text).toContain("하늘전자 10주");

    // a skill marked private (no login of its own) is routed the same way
    steps = answer("k_naver_ad_report");
    w.said.length = 0;
    w.llm.reqs.length = 0;
    const r2 = await runMeetTurn(w.h.app.core, w.input({ speaker: "김대리", participants: 5, utterance: "깽이야 광고 성과 어때?" }));
    expect(r2.private).toBe(true);
    expect(w.said).toEqual([PRIVATE_LINE]);

    // a login tool that opts out (`private: false`: a public quote fetched with the owner's key) is spoken to the group
    steps = [{ calls: [{ name: "k_toss_quote" }] }, { text: ["하늘전자는 지금 7만 1천 원이에요."] }];
    w.said.length = 0;
    w.llm.reqs.length = 0;
    const before = threadTexts(w).length;
    const rq = await runMeetTurn(w.h.app.core, w.input({ speaker: "김대리", participants: 5, utterance: "깽이야 하늘전자 주가 얼마야?" }));
    expect(calls.use).toBe(2); // it still ran inside the owner's login
    expect(calls.actions).toEqual(["view", "view"]);
    expect(rq.private).toBe(false);
    expect(w.said).toEqual(["하늘전자는 지금 7만 1천 원이에요."]);
    expect(threadTexts(w).length).toBe(before);

    // the owner hears it, and so does a 1:1 with someone whose Meet name doesn't match
    steps = answer("k_toss_portfolio");
    for (const o of [{ participants: 6 }, { speaker: "Guest", participants: 2 }]) {
      w.said.length = 0;
      w.llm.reqs.length = 0;
      const r3 = await runMeetTurn(w.h.app.core, w.input(o));
      expect(r3.private).toBe(false);
      expect(w.said.length).toBe(1);
      expect(w.said[0]).toContain("하늘전자");
    }
  });

  test("no login in a meeting: no wait, the connection card goes to the meeting thread (never spoken), the answer goes on", async () => {
    const spy: Spy = { runs: [], spans: [] };
    const portfolio = tool("k_toss_portfolio", spy, { ok: true, summary: "보유 종목 2개" }, { extra: { connection: "toss-investment", connectionReason: "보유 주식을 보려면 토스증권 연결이 필요해요" } });
    const w = await world([{ calls: [{ name: "k_toss_portfolio" }] }, { text: ["토스증권이 아직 연결되지 않아서 앱에 연결 카드를 올려 뒀어요."] }], { skills: [portfolio] }, spy);
    const calls = fakeConnections(w, false);
    const t0 = performance.now();
    const r = await runMeetTurn(w.h.app.core, w.input({ speaker: "김대리", participants: 5, utterance: "깽이야 주식 뭐 갖고 있어?" }));
    expect(performance.now() - t0).toBeLessThan(2_000);
    expect(calls.waitFor).toBe(0);
    expect(calls.use).toBe(0);
    expect(spy.runs).toEqual([]);
    expect(r.outcome).toBe("ok");
    expect(JSON.stringify(w.llm.reqs[1]!.messages)).toContain("needs_connection");
    // the claim is true (the card exists), so it is spoken; the card itself is only in the thread
    expect(w.said).toEqual(["토스증권이 아직 연결되지 않아서 앱에 연결 카드를 올려 뒀어요."]);
    const posts = threadTexts(w);
    expect(posts.length).toBe(1);
    const cards = JSON.parse(posts[0]!.cards_json) as { type: string; service?: string; title?: string; reason?: string }[];
    expect(cards.filter((c) => c.type === "connection_request")).toEqual([expect.objectContaining({ type: "connection_request", service: "toss-investment", reason: "보유 주식을 보려면 토스증권 연결이 필요해요" })]);
    for (const c of cards) for (const line of [c.title, c.reason]) if (line) expect(w.said.join(" ")).not.toContain(line);
  });

  test("a login the upstream refuses, in a group meeting: the card still reaches the thread and the model gets needs_connection", async () => {
    const spy: Spy = { runs: [], spans: [] };
    const portfolio = tool(
      "k_toss_portfolio",
      spy,
      { ok: false, summary: "토스증권 연결 필요", data: { holdings: [{ name: "하늘전자", qty: 10 }] }, needsConnection: { service: "toss-investment", serviceName: "토스증권", reason: "토스증권 키가 더 이상 유효하지 않아요. 다시 연결해 주세요." } },
      { extra: { connection: "toss-investment" } },
    );
    const w = await world([{ calls: [{ name: "k_toss_portfolio" }] }, { text: ["토스증권 연결이 끊겨서 앱에 연결 카드를 올려 뒀어요."] }], { skills: [portfolio] }, spy);
    const calls = fakeConnections(w, true);
    const r = await runMeetTurn(w.h.app.core, w.input({ speaker: "김대리", participants: 5, utterance: "깽이야 주식 뭐 갖고 있어?" }));
    expect(spy.runs).toEqual(["k_toss_portfolio"]); // it ran inside the login, once (a refused login is retried only after a wait, and a meeting never waits)
    expect(calls.use).toBe(1);
    expect(calls.actions).toEqual(["view"]);
    expect(calls.waitFor).toBe(0);
    expect(r.private).toBe(false); // a failure isn't private data
    const toolMsg = JSON.stringify(w.llm.reqs[1]!.messages.filter((m) => m.role === "tool"));
    expect(toolMsg).toContain("needs_connection");
    expect(toolMsg).not.toContain("하늘전자"); // the failure's data still doesn't reach the model in a group
    const cards = JSON.parse(threadTexts(w)[0]!.cards_json) as { type: string; service?: string; reason?: string }[];
    expect(cards.filter((c) => c.type === "connection_request")).toEqual([expect.objectContaining({ service: "toss-investment", reason: "토스증권 키가 더 이상 유효하지 않아요. 다시 연결해 주세요." })]);
    expect(w.said).toEqual(["토스증권 연결이 끊겨서 앱에 연결 카드를 올려 뒀어요."]);
  });

  test("news with links: speech without URLs, the list goes to the thread", async () => {
    const spy: Spy = { runs: [], spans: [] };
    const w = await world(
      [
        { calls: [{ name: "k_news", args: { q: "주요 뉴스" } }] },
        {
          text: [
            "오늘 주요 뉴스는 금리 동결, 반도체 수출 증가, 첫눈 소식이에요. ",
            "자세한 건 앱에 올려 둘게요.\n",
            "[앱]\n1. [금리 동결](https://news.example/1)\n2. [반도체 수출](https://news.example/2)\n3. [첫눈](https://news.example/3)",
          ],
        },
      ],
      { skills: [tool("k_news", spy, { ok: true, summary: "뉴스 3건" })] },
      spy,
    );
    const r = await runMeetTurn(w.h.app.core, w.input({ utterance: "깽이야 오늘 주요 뉴스 세 개만 알려 줘" }));
    expect(w.said).toEqual(["오늘 주요 뉴스는 금리 동결, 반도체 수출 증가, 첫눈 소식이에요.", "자세한 건 앱에 올려 둘게요."]);
    expect(w.said.join(" ")).not.toMatch(/https|\[/);
    expect(r.detail).toBe(true);
    const posts = threadTexts(w);
    expect(posts.length).toBe(1);
    expect(posts[0]!.text).toContain("https://news.example/2");
    expect(posts[0]!.text).not.toContain("[앱]");
  });

  test("sentences stream as they complete; the first is spoken before the model finishes; 2 sentences max without tools", async () => {
    const w = await world([{ text: ["출시는 다음 ", "주 금요일로 정했어요. ", "담당은 ", "지민님이에요. ", "세 번째 문장은 ", "말하지 않아요."], delayMs: 25 }]);
    const r = await runMeetTurn(w.h.app.core, w.input({ utterance: "깽이야 출시 언제로 정했지?" }));
    expect(w.said).toEqual(["출시는 다음 주 금요일로 정했어요.", "담당은 지민님이에요."]);
    const firstSayIdx = w.llm.log.indexOf("delta:담당은 ");
    expect(firstSayIdx).toBeGreaterThan(0);
    expect(r.timings.firstSentenceMs).not.toBeNull();
    expect(r.timings.firstSentenceMs!).toBeLessThan(r.timings.totalMs - 40); // well before the stream ended
    expect(r.tools).toEqual([]);
  });

  test("the leading 네 is dropped when the call was already acknowledged", async () => {
    const w = await world([{ text: ["네, 지금은 오후 12시예요."] }]);
    await runMeetTurn(w.h.app.core, w.input({ acked: true }));
    expect(w.said).toEqual(["지금은 오후 12시예요."]);
  });

  test("a phone call asked by the owner: the meeting's approval card carries the call (who, full number, message) like a chat turn's", async () => {
    const spy: Spy = { runs: [], spans: [] };
    const call = { target: "단아님", number: "010-1234-5678", message: "회의 10분 늦어요" };
    const phone = tool("sys_phone_call", spy, { ok: true, summary: "전화했어요" }, {
      extra: { approval: () => ({ title: "단아님(010-****-5678)에게 전화할까요?", detail: "회의 10분 늦어요", call }) },
    });
    const w = await world([{ calls: [{ name: "sys_phone_call", args: { to: "010-1234-5678", message: "회의 10분 늦어요" } }] }, { text: ["앱에 확인 카드를 올렸어요."] }], { sys: [phone] }, spy);
    const r = await runMeetTurn(w.h.app.core, w.input({ utterance: "깽이야 단아한테 전화해서 10분 늦는다고 해 줘", speaker: "이하늘" }));
    expect(spy.runs).toEqual([]);
    expect(r.proposals).toBe(1);
    const card = JSON.parse(threadTexts(w)[0]!.cards_json)[0];
    expect(card).toMatchObject({ type: "approval", title: "단아님(010-****-5678)에게 전화할까요?", call, status: "pending" });
    // the full number is on the card only, never spoken
    expect(w.said.join(" ")).not.toContain("1234");
  });

  test("acting requests from the owner post the normal approval card; the real tool never runs; approving resumes in the thread", async () => {
    const spy: Spy = { runs: [], spans: [] };
    const msgSend = tool("msg_send", spy, { ok: true, summary: "보냈어요" }, { extra: { approval: (a) => ({ title: `슬랙 ${String(a.chat)}에 보낼까요?`, detail: String(a.text) }) } });
    const w = await world(
      [{ calls: [{ name: "msg_send", args: { provider: "slack", chat: "김대리", text: "회의 끝나고 봬요" } }] }, { text: ["앱에 확인 카드를 올렸어요. 확인해 주시면 보낼게요."] }],
      { msg: [msgSend] },
      spy,
    );
    const r = await runMeetTurn(w.h.app.core, w.input({ utterance: "깽이야 김 대리한테 슬랙 보내 줘", speaker: "이하늘" }));
    expect(spy.runs).toEqual([]);
    expect(r.proposals).toBe(1);
    const ap = w.h.db.sql.query<{ id: string; call_json: string; status: string; thread_id: string }, []>(`SELECT id, call_json, status, thread_id FROM approvals`).all();
    expect(ap.length).toBe(1);
    expect(ap[0]!.thread_id).toBe(w.threadId);
    expect(JSON.parse(ap[0]!.call_json).function.name).toBe("msg_send");
    const posts = threadTexts(w);
    expect(JSON.parse(posts[0]!.cards_json)[0]).toMatchObject({ type: "approval", approvalId: ap[0]!.id, title: "슬랙 김대리에 보낼까요?", status: "pending" });
    expect(w.said).toEqual(["앱에 확인 카드를 올렸어요.", "확인해 주시면 보낼게요."]);

    // approving it in the app resumes a normal chat turn in the meeting thread with that call
    const res = await w.h.req("POST", `/api/approvals/${ap[0]!.id}`, { token: w.token, body: { decision: "approve" } });
    expect(res.status).toBe(200);
    await res.text();
    const resumed = w.h.turns.inputs.at(-1)!;
    expect(resumed.resume?.call.function.name).toBe("msg_send");
    expect(resumed.resume?.priorMessages[0]).toMatchObject({ role: "user" });
  });

  test("a claimed confirmation card without the tool call is replaced by an honest redirect", async () => {
    const w = await world([{ text: ["엄마께 전화하는 건 앱에 확인 카드로 올려 뒀어요. ", "앱에서 확인해 주시면 바로 걸게요."] }]);
    const r = await runMeetTurn(w.h.app.core, w.input({ utterance: "깽이야 엄마한테 전화해 줘" }));
    expect(r.proposals).toBe(0);
    expect(w.said).toEqual(["그건 회의 중에는 바로 할 수 없어요. 회의가 끝나고 앱에서 부탁해 주세요."]); // what followed the claim goes too
  });

  test("a card claim written in the same step as the tool call is not spoken early; the answer after the tool is", async () => {
    const spy: Spy = { runs: [], spans: [] };
    const msgSend = tool("msg_send", spy, { ok: true, summary: "보냈어요" });
    const w = await world(
      [
        { text: ["김 대리님께 보낼 확인 카드를 앱에 올렸어요. ", "확인해 주시면 보낼게요. "], calls: [{ name: "msg_send", args: { provider: "slack", chat: "김대리", text: "끝났어요" } }] },
        { text: ["앱에 확인 카드를 올려 뒀어요. ", "확인해 주시면 보낼게요."] },
      ],
      { msg: [msgSend] },
      spy,
    );
    const r = await runMeetTurn(w.h.app.core, w.input({ utterance: "깽이야 김 대리한테 슬랙 보내 줘" }));
    expect(r.proposals).toBe(1);
    expect(spy.runs).toEqual([]);
    expect(w.fillers.length).toBe(1);
    expect(w.said).toEqual(["앱에 확인 카드를 올려 뒀어요.", "확인해 주시면 보낼게요."]);
  });

  test("result cards (weather, search) stay out of the thread; only things made are posted", async () => {
    const spy: Spy = { runs: [], spans: [] };
    const w = await world([{ calls: [{ name: "k_weather" }] }, { text: ["서울은 맑아요."] }], {
      skills: [tool("k_weather", spy, { ok: true, summary: "맑음", card: { type: "weather", place: "서울", tempC: 14, condition: "맑음", icon: "sun", high: 18, low: 8, hourly: [] } as never })],
    }, spy);
    const r = await runMeetTurn(w.h.app.core, w.input());
    expect(r.detail).toBe(false);
    expect(threadTexts(w).length).toBe(0);
  });

  test("review regressions: the 네 strip needs punctuation; a true login-card claim is kept; '교통카드' isn't a claim", async () => {
    const w = await world([{ text: ["네이버 뉴스에 나왔어요."] }]);
    await runMeetTurn(w.h.app.core, w.input({ acked: true }));
    expect(w.said).toEqual(["네이버 뉴스에 나왔어요."]);

    const spy: Spy = { runs: [], spans: [] };
    const read = tool("msg_read", spy, { ok: true, summary: "x" }, { extra: { credential: async () => ({ service: "slack", serviceName: "Slack", reason: "로그인 필요", fields: [] }) } });
    const w2 = await world([{ calls: [{ name: "msg_read", args: { provider: "slack", chat: "general" } }] }, { text: ["슬랙이 아직 연결되지 않아서 앱에 연결 카드를 올려 뒀어요."] }], { msg: [read] }, spy);
    await runMeetTurn(w2.h.app.core, w2.input());
    expect(spy.runs).toEqual([]);
    expect(w2.said).toEqual(["슬랙이 아직 연결되지 않아서 앱에 연결 카드를 올려 뒀어요."]);
    expect(JSON.parse(threadTexts(w2)[0]!.cards_json)[0]).toMatchObject({ type: "credential_request", service: "slack" });

    const w3 = await world([{ text: ["교통카드 충전 방법은 앱에 올려 둘게요."] }]);
    await runMeetTurn(w3.h.app.core, w3.input());
    expect(w3.said).toEqual(["교통카드 충전 방법은 앱에 올려 둘게요."]);
  });

  test("review regressions: a sentence before a hung tool doesn't block the timeout fallback", async () => {
    const spy: Spy = { runs: [], spans: [] };
    const w = await world([{ text: ["확인해 볼게요. "], calls: [{ name: "k_weather" }] }, { text: ["안 나와요."] }], { skills: [tool("k_weather", spy, { ok: true, summary: "x" }, { hang: true })] }, spy);
    const r = await runMeetTurn(w.h.app.core, w.input({ turnTimeoutMs: 120 }));
    expect(r.outcome).toBe("timeout");
    expect(w.said).toEqual(["확인해 볼게요.", FALLBACK_TIMEOUT]);
  });

  test("review regressions: [앱] or a half sentence before a tool call (valid or not) doesn't swallow or glue the answer", async () => {
    const spy: Spy = { runs: [], spans: [] };
    const w = await world([{ text: ["잠깐 확인할게요.\n[앱]\n준비 중"], calls: [{ name: "k_weather" }] }, { text: ["서울은 맑아요."] }], { skills: [tool("k_weather", spy, { ok: true, summary: "x" })] }, spy);
    await runMeetTurn(w.h.app.core, w.input());
    expect(w.said).toEqual(["잠깐 확인할게요.", "서울은 맑아요."]);

    const w2 = await world([{ text: ["서울 날씨를"], calls: [{ name: "no_such_tool" }] }, { text: ["서울은 맑아요."] }]);
    await runMeetTurn(w2.h.app.core, w2.input());
    expect(w2.said).toEqual(["서울은 맑아요."]);
  });

  test("review regressions: private line said, then a timeout → the thread still gets a note; a late private tool changes nothing", async () => {
    const spy: Spy = { runs: [], spans: [] };
    const w = await world([{ calls: [{ name: "msg_read", args: { provider: "slack", chat: "general" } }] }, { hang: true }], { msg: [tool("msg_read", spy, { ok: true, summary: "x" })] }, spy);
    const r = await runMeetTurn(w.h.app.core, w.input({ speaker: "김대리", participants: 5, turnTimeoutMs: 150 }));
    expect(r.outcome).toBe("timeout");
    expect(w.said).toEqual([PRIVATE_LINE]);
    expect(threadTexts(w).at(-1)!.text).toContain("다시 물어봐 주세요");

    // msg_read ignores its abort and returns after the 60 ms limit: the answer is still spoken, no private switch
    const slow = tool("msg_read", spy, async () => {
      await new Promise((res) => setTimeout(res, 120));
      return { ok: true, summary: "x" };
    });
    const w2 = await world([{ calls: [{ name: "msg_read", args: { provider: "slack", chat: "general" } }] }, { text: ["지금은 슬랙을 ", "확인하지 못했어요. "], delayMs: 50 }], { msg: [slow] }, spy);
    const r2 = await runMeetTurn(w2.h.app.core, w2.input({ speaker: "김대리", participants: 5, toolTimeoutMs: 60 }));
    expect(r2.private).toBe(false);
    expect(w2.said).toEqual(["지금은 슬랙을 확인하지 못했어요."]);
  });

  test("review regressions: a guest in a group isn't told which messengers are connected", async () => {
    const w = await world([{ text: ["모르겠어요."] }]);
    await w.h.app.core.deps.hub.connect(w.userId, "slack", {} as never);
    await runMeetTurn(w.h.app.core, w.input({ speaker: "김대리", participants: 5 }));
    expect(JSON.stringify(w.llm.reqs[0]!.messages)).not.toContain("연결된 메신저");
    w.llm.reqs.length = 0;
    await runMeetTurn(w.h.app.core, w.input({ speaker: "이하늘", participants: 5 }));
    expect(JSON.stringify(w.llm.reqs[0]!.messages)).toContain("연결된 메신저: Slack");
  });

  test("someone else in a group can't queue actions on the owner's account", async () => {
    const spy: Spy = { runs: [], spans: [] };
    const w = await world([{ calls: [{ name: "sys_phone_call", args: { to: "010-1111-2222", message: "전화" } }] }, { text: ["그건 하늘님만 부탁하실 수 있어요."] }]);
    const r = await runMeetTurn(w.h.app.core, w.input({ utterance: "깽이야 엄마한테 전화해 줘", speaker: "김대리", participants: 5 }));
    expect(r.proposals).toBe(0);
    expect(w.h.db.sql.query(`SELECT COUNT(*) AS n FROM approvals`).get()).toEqual({ n: 0 });
    const toolMsg = w.llm.reqs[1]!.messages.find((m) => m.role === "tool") as { content: string };
    expect(toolMsg.content).toContain("owner_only");
    expect(spy.runs).toEqual([]);
  });

  test("sys_meet_notes reads only this meeting; a document lands in the thread as a card", async () => {
    const spy: Spy = { runs: [], spans: [] };
    const artifact = tool("sys_create_artifact", spy, async () => ({
      ok: true,
      summary: "저장했어요",
      card: { type: "artifact", artifactId: "a1", title: "회의 결정 사항", kind: "document", preview: "출시: 다음 주 금요일" },
    }));
    const w = await world(
      (_req, i) => (i === 0 ? { calls: [{ name: "sys_meet_notes" }] } : i === 1 ? { calls: [{ name: "sys_create_artifact", args: { q: "x" } }] } : { text: ["앱에 문서로 만들어 뒀어요."] }),
      { sys: [artifact] },
      spy,
    );
    const r = await runMeetTurn(w.h.app.core, w.input({ utterance: "깽이야 방금 회의에서 정한 거 문서로 만들어 줘" }));
    expect(r.tools).toEqual(["sys_meet_notes", "sys_create_artifact"]);
    const notes = JSON.parse((w.llm.reqs[1]!.messages.find((m) => m.role === "tool") as { content: string }).content);
    expect(notes.ok).toBe(true);
    expect(notes.data.transcript).toContain("출시는 다음 주 금요일");
    expect(notes.data.recent).toBeUndefined();
    const posts = threadTexts(w);
    expect(JSON.parse(posts.at(-1)!.cards_json)[0]).toMatchObject({ type: "artifact", artifactId: "a1" });
    expect(w.said).toEqual(["앱에 문서로 만들어 뒀어요."]);
  });

  test("usage goes to the daily quota; over the quota nothing is called", async () => {
    const w = await world([{ text: ["지금은 오후 12시예요."] }]);
    const core = w.h.app.core;
    const day = quotaDay(core.now());
    const before = core.db.usage(w.userId, day).counted;
    const r = await runMeetTurn(core, w.input());
    expect(r.tokens).toBe(120);
    expect(core.db.usage(w.userId, day).counted).toBe(before + 120);
    core.db.addUsage(w.userId, day, core.cfg.dailyTokens);
    w.llm.reqs.length = 0;
    const q = await runMeetTurn(core, w.input());
    expect(q.outcome).toBe("quota");
    expect(w.llm.reqs.length).toBe(0);
  });

  test("logs carry no utterance, speaker or tool text", async () => {
    const lines: string[] = [];
    const spy: Spy = { runs: [], spans: [] };
    const w = await world([{ calls: [{ name: "k_weather" }] }, { text: ["서울은 맑아요."] }], { skills: [tool("k_weather", spy, { ok: true, summary: "서울 14°, 맑음" })] }, spy);
    const core = w.h.app.core;
    const orig = core.log;
    core.log = { ...orig, info: (msg: string, f?: Record<string, unknown>) => lines.push(`${msg} ${JSON.stringify(f ?? {})}`), warn: (msg: string, f?: Record<string, unknown>) => lines.push(`${msg} ${JSON.stringify(f ?? {})}`) };
    await runMeetTurn(core, w.input());
    core.log = orig;
    const all = lines.join("\n");
    expect(all).toContain("meet agent");
    expect(all).toContain("k_weather");
    expect(all).not.toMatch(/이하늘|하늘|서울|맑|날씨 어때/);
  });
});
