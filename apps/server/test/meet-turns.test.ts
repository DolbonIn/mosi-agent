/**
 * Turn-taking in a meeting (meet.ts, MEET-CONTRACT.md §3): leaving when asked (A), waiting for the end of the turn
 * (B), giving an answer up when the speaker goes on (C), never talking over people (D). A fake services/meet bot
 * streams SSE events; no real meeting, model or TTS.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { LlmChunk, LlmRequest, ToolContext } from "@pickle/agent";
import type { ChatRequest } from "../src/meet.ts";
import {
  isDismissCall,
  isLeaveCall,
  isLeaveRequest,
  isWakeCall,
  LEAVE_LINE,
  MEET_ACKS,
  meetNote,
  meetTools,
  speechSyllables,
  turnHoldMsFromEnv,
  turnIncomplete,
  wakeWords,
  yieldSyllablesFromEnv,
} from "../src/meet.ts";
import type { Addressee, AddresseeInput } from "../src/meetAddressee.ts";
import type { Logger } from "../src/log.ts";
import { makeHarness, type Harness } from "./helpers.ts";

const URL_IN = "https://meet.google.com/abc-defg-hij";

// ───────────────────────────── fake services/meet ─────────────────────────────

interface FakeBot {
  url: string;
  says: string[];
  /** performance.now() of each /say, same order as `says` */
  sayAt: number[];
  sayIds: string[];
  stops: number;
  deletes: number;
  /** /say answers this (202 = taken) */
  sayStatus: number;
  state: string;
  connected: boolean;
  push(event: string, data: Record<string, unknown>): void;
  stop(): void;
}

function startBot(): FakeBot {
  const enc = new TextEncoder();
  const clients = new Set<ReadableStreamDefaultController<Uint8Array>>();
  let n = 0;
  const bot: FakeBot = {
    url: "",
    says: [],
    sayAt: [],
    sayIds: [],
    stops: 0,
    deletes: 0,
    sayStatus: 202,
    state: "launching",
    connected: false,
    push(event, data) {
      if (event === "state") bot.state = String(data.state);
      const f = enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      for (const c of clients) c.enqueue(f);
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
    async fetch(req) {
      const u = new URL(req.url);
      const body = req.method === "POST" ? ((await req.json().catch(() => null)) as Record<string, unknown> | null) : null;
      if (req.method === "POST" && u.pathname === "/sessions") return Response.json({ id: "s1", state: "launching" }, { status: 201 });
      if (u.pathname === "/sessions/s1/events") {
        bot.connected = true;
        let me: ReadableStreamDefaultController<Uint8Array>;
        return new Response(
          new ReadableStream<Uint8Array>({
            start(c) {
              me = c;
              clients.add(c);
              c.enqueue(enc.encode(`: hi\n\nevent: state\ndata: ${JSON.stringify({ state: bot.state })}\n\n`));
            },
            cancel() {
              clients.delete(me);
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      if (u.pathname === "/sessions/s1/say" && req.method === "POST") {
        if (bot.sayStatus !== 202) return Response.json({ error: "tts_failed" }, { status: bot.sayStatus });
        const id = `say${++n}`;
        bot.says.push(String(body?.text ?? ""));
        bot.sayAt.push(performance.now());
        bot.sayIds.push(id);
        return Response.json({ sayId: id }, { status: 202 });
      }
      if (u.pathname === "/sessions/s1/say/stop") {
        bot.stops++;
        return Response.json({ ok: true });
      }
      if (u.pathname === "/sessions/s1" && req.method === "DELETE") {
        bot.deletes++;
        setTimeout(() => {
          bot.push("state", { state: "ended" });
          bot.push("ended", { reason: "left" });
        }, 10);
        return Response.json({ state: "ended" });
      }
      if (u.pathname === "/sessions/s1") return Response.json({ id: "s1", state: bot.state });
      return Response.json({ error: "not_found" }, { status: 404 });
    },
  });
  bot.url = `http://127.0.0.1:${server.port}`;
  bot.stop = () => server.stop(true);
  return bot;
}

// ───────────────────────────── helpers ─────────────────────────────

async function until(cond: () => boolean, ms = 3000, what = "condition"): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(3);
  }
}

function captureLogs(h: Harness): string[] {
  const lines: string[] = [];
  const rec = (level: string) => (event: string, fields?: Record<string, unknown>) => lines.push(`${level} ${event} ${JSON.stringify(fields ?? {})}`);
  const log: Logger = { info: rec("info"), warn: rec("warn"), error: rec("error") };
  h.app.core.log = log;
  return lines;
}

let h: Harness | null = null;
let bot: FakeBot | null = null;
afterEach(async () => {
  await h?.close();
  bot?.stop();
  h = null;
  bot = null;
});

async function setup() {
  bot = startBot();
  h = await makeHarness({ config: { meet: { url: bot.url } } });
  const t = h.app.core.meet.timings;
  t.reconnectMs = 20;
  t.reconnectMaxMs = 50;
  t.ackGraceMs = 0;
  t.turnHoldMs = 80;
  t.leaveSayMaxMs = 2_000;
  const a = await h.signup("haneul");
  const userId = a.session.user.id;
  const ctx = {
    userId,
    threadId: a.session.mainThreadId,
    agentName: "깽이",
    displayName: "하늘",
    workspaceDir: "/tmp",
    signal: new AbortController().signal,
    credentials: {},
    store: {},
    status: () => {},
    now: () => new Date(),
  } as unknown as ToolContext;
  const r = await meetTools(h.app.core, userId).find((d) => d.name === "sys_join_meet")!.run({ url: URL_IN, purpose: "주간 회의" }, ctx);
  expect(r.ok).toBe(true);
  await until(() => bot!.connected, 3000, "SSE connect");
  bot.push("state", { state: "in_call" });
  await until(() => h!.app.core.meet.active(userId)?.state === "in_call", 3000, "in_call");
  const row = h.app.core.meet.active(userId)!;
  return { h, bot, userId, meetingId: row.id, threadId: row.thread_id };
}

/** one answer per call: "대답 N번이에요." after `delayMs` (aborts with the signal) */
function chatStub(h: Harness, o: { delayMs?: number; text?: (n: number) => string } = {}) {
  const calls: ChatRequest[] = [];
  h.app.core.deps.llm!.chat = async function* (i: ChatRequest) {
    if (i.system.includes("회의 요약")) {
      yield "요약이에요.";
      return;
    }
    calls.push(i);
    const n = calls.length;
    if (o.delayMs) await Bun.sleep(o.delayMs);
    if (i.signal?.aborted) return;
    yield o.text ? o.text(n) : `대답 ${n}번이에요.`;
  };
  return calls;
}

function stubAddressee(h: Harness, verdicts: Record<string, Addressee>) {
  const calls: AddresseeInput[] = [];
  h.app.core.deps.llm!.addressee = async (i) => {
    calls.push(i);
    return { verdict: verdicts[i.utterance] ?? "other", p: null, ms: 1, backend: "chat", tokens: 0 };
  };
  return calls;
}

/** the meeting agent's model: `steps[n]` answers its n-th request (tool calls or text); text steps may wait on a gate */
function meetModel(h: Harness, steps: ((req: LlmRequest) => AsyncGenerator<LlmChunk>)[]) {
  const seen = { n: 0 };
  h.app.core.deps.llm!.meetClient = {
    model: "fake",
    async *stream(req: LlmRequest): AsyncGenerator<LlmChunk> {
      const step = steps[seen.n++];
      if (step) yield* step(req);
      yield { type: "usage", usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } };
    },
  } as never;
  return seen;
}
const callTool = (name: string) =>
  async function* (): AsyncGenerator<LlmChunk> {
    yield { type: "tool_calls", calls: [{ id: `c-${name}`, type: "function", function: { name, arguments: "{}" } }] };
  };
/** resolves on `gate` or when the request is aborted */
const held = (req: LlmRequest, gate: Promise<void>) => Promise.race([gate, new Promise((r) => req.signal?.addEventListener("abort", r, { once: true }))]);
const threadCards = (h: Harness, threadId: string) =>
  (h.db.sql.query(`SELECT text, cards_json FROM messages WHERE thread_id = ? ORDER BY rowid`).all(threadId) as { text: string; cards_json: string | null }[])
    .map((m) => ({ text: m.text, cards: (m.cards_json ? JSON.parse(m.cards_json) : []) as { type: string }[] }))
    .filter((m) => m.cards.length);

let seqN = 0;
const line = (bot: FakeBot, text: string, speaker: string | null = null) => {
  const seq = ++seqN;
  bot.push("transcript", { seq, text, startMs: seq * 1000, endMs: seq * 1000 + 600, speaker });
  return seq;
};
const asked = (c: ChatRequest) => c.user.split("\n").at(-1)!;
const threadTexts = (h: Harness, threadId: string) =>
  (h.db.sql.query(`SELECT text FROM messages WHERE thread_id = ? ORDER BY rowid`).all(threadId) as { text: string }[]).map((r) => r.text);

/** call 모시 and wait for its answer: the meeting is in conversation mode afterwards */
async function converse(h: Harness, bot: FakeBot, chat: ChatRequest[]) {
  line(bot, "모시야, 다음 회의 언제야?", "하은");
  await until(() => chat.length === 1 && bot.says.length === 2, 3000, "first answer");
  await h.app.core.idle();
}

// ───────────────────────────── pure helpers ─────────────────────────────

describe("turn-taking helpers", () => {
  test("turnIncomplete: connectives, dangling particles, fillers, a comma or … → unfinished", () => {
    const unfinished = [
      "모시야 내일 회의 자료를",
      "모시야 그 문서 좀",
      "모시야 혹시",
      "모시야 그러니까",
      "모시야, 지난주에 정한 거랑",
      "모시야 이번 분기 매출이",
      "모시야 다음 회의는",
      "모시야 서울 날씨 확인하고",
      "모시야 아까 말한 건데",
      "모시야 그거 정리해서",
      "모시야 시간 되면",
      "모시야 회의록 정리하면서",
      "모시야 좋긴 한데",
      "모시야 급하진 않지만",
      "모시야 메일로 보내거나",
      "모시야 내일이든지",
      "모시야 지금 바쁘니까",
      "모시야 그, 그",
      "모시야 이거 회의실에",
      "모시야 다음 주 일정에서",
      "모시야 고객사의",
      "모시야 메일로",
      "모시야 지민 님하고",
      "모시야 디자인 팀도",
      "모시야 이번 건만",
      "모시야 아까 그 얘기,",
      "모시야 그게…",
      "모시야 그리고",
      "모시야 근데",
      "모시야 그래서",
      "모시야 시장 조사 결과를.",
      "모시야 오후 세 시로 잡으려고 하는데",
      "모시야 비용이 많이 들어서",
      "모시야 저",
      "그리고 다음 주 월요일은",
      "모시야 데이터 팀이랑 회의를 잡으면",
      "모시야 이 자료 바탕으로 문서를 만들어 주고",
      "모시야 그럼 장소는 회의실 B로",
      "모시야 지난번 결정과",
      "모시야 그 회의가",
      "모시야 오전과",
      "모시야 다음 주의",
      "모시야 그게 사실이라면",
      "모시야 그 결과로",
      "모시야 이번 일정도",
      "모시야 이거 사고",
    ];
    const finished = [
      "모시야 다음 회의 언제야?",
      "모시야 서울 날씨 어때?",
      "모시야 오늘 회의 내용 정리해 줘.",
      "모시야 지금 몇 시야",
      "모시야, 방금 정한 거 문서로 만들어 줄래?",
      "모시야 고마워.",
      "모시야 이번 분기 매출 알려 줘",
      "그럼 장소는 어디야?",
      "그럼 내일은?", // a question mark finishes any line
      "그래서?",
      "모시야 다음 안건 뭐였지",
      "모시야 출시일이 금요일 맞지?",
      "모시야 회의 끝나고 요약 보내 줘.",
      "모시야 광고 성과 어때?",
      "모시야 이번 주 최고 기온 알려 줘.",
      "모시야 이 내용 보고서로 정리해 줘",
      "모시야 그건 아니야.",
      "모시야 좋아, 그렇게 하자.",
      "모시야 그럼 수요일로 하자",
      "모시야 다시 한번 말해 봐",
      "모시야, 지금 회의 참석자 몇 명이야",
      "모시야 그거 내가 할게.",
      "모시야 다음 주 수요일 오후 두 시 어때",
      // nouns that only look like a particle or a connective
      "모시야 이번 광고",
      "모시야 두 안의 차이",
      "모시야 지금 서울 온도",
      "모시야 오늘 회의",
      "모시야 보고서.",
      "모시야 잠깐만",
      "모시야 PPT",
      "모시야 내일 오전 10시",
      "모시야 이게 맞는 건가", // -ㄴ가: a question without its mark
      "모시야 이거 정리해 줄까",
    ];
    expect(unfinished.length + finished.length).toBeGreaterThanOrEqual(60);
    expect(unfinished.filter((t) => !turnIncomplete(t))).toEqual([]);
    expect(finished.filter((t) => turnIncomplete(t))).toEqual([]);
    expect(turnIncomplete("")).toBe(false);
  });

  test("leave: a call plus a leave imperative; questions, negations, the speaker leaving and dismisses are not", () => {
    const w = wakeWords(["깽이", "모시"]);
    for (const t of ["모시야 이제 나가도 돼", "모시 나가 줘", "모시야 회의에서 나가", "모시야 이만 가 봐", "모시 퇴장해", "모시야 먼저 나가 있어", "깽이야, 이제 나가셔도 돼요.", "5시야 나가 줘"])
      expect([t, isLeaveCall(t, w)]).toEqual([t, true]);
    for (const t of [
      "모시가 나가면 회의록은 누가 써?", // no vocative
      "모시 나가는 거 아니지?", // a question
      "모시야 나가도 돼?",
      "모시야 안 나가도 돼",
      "모시야 나가지 마",
      "모시야 저 먼저 나가 볼게요",
      "모시야 나 먼저 나가",
      "모시야 들어가 있어", // stand by and listen
      "모시야 이제 됐어",
      "민수님 먼저 나가 보세요", // not a call
      "모시야 저는 3시에 나가 봐야 해서요", // "봐야": have to
      "모시야 이제 가 봐야 할 시간이야",
    ])
      expect([t, isLeaveCall(t, w)]).toEqual([t, false]);
    expect(isWakeCall("모시가 나가면 회의록은 누가 써?", w)).toBe(false);
    // dismisses stay dismisses
    for (const t of ["모시야 들어가 있어", "모시야 이제 됐어", "모시 조용히 해"]) expect(isDismissCall(t, w)).toBe(true);
    // conversation mode: the words alone (plus a verdict other than "other")
    for (const t of ["이제 나가도 돼", "고마워, 이제 회의에서 나가 줘.", "먼저 나가 있어.", "오케이, 이만 가 봐도 돼.", "퇴장해 줘.", "됐어, 이제 회의에서 빠져 줘.", "이제 나가 주세요.", "고마워요, 이제 나가셔도 돼요."])
      expect([t, isLeaveRequest(t)]).toEqual([t, true]);
    for (const t of ["오늘 수고했어", "나 먼저 나가 볼게.", "너 나가는 거 아니지?", "저 잠깐 나갔다 올게요.", "공지는 언제 나가?", "출시 공지 오늘 나가도 돼?", "저는 3시에 나가 봐야 해서요.", "이제 가 봐야 할 시간이네.", "회의 끝나면 바로 나가시면 돼요."])
      expect([t, isLeaveRequest(t)]).toEqual([t, false]);
    expect(meetNote("ended", "asked")).toBe("회의에서 나가 달라는 말을 듣고 나왔어요.");
  });

  test("speech syllables: backchannels and reactions count 0; env parsing", () => {
    for (const t of ["네네", "아 그렇구나", "네 맞아요 맞아요", "음", "아 진짜요?", "고마워요", "응응 그래그래"]) expect([t, speechSyllables(t)]).toEqual([t, 0]);
    expect(speechSyllables("그리고")).toBe(3);
    expect(speechSyllables("근데 그건 수요일 아니었어요")).toBe(12);
    expect(speechSyllables("OK 그럼")).toBe(3);
    expect(turnHoldMsFromEnv(undefined)).toBeUndefined();
    expect(turnHoldMsFromEnv("2000")).toBe(2000);
    expect(turnHoldMsFromEnv("0")).toBe(0);
    expect(turnHoldMsFromEnv("-5")).toBeUndefined();
    expect(turnHoldMsFromEnv("abc")).toBeUndefined();
    expect(yieldSyllablesFromEnv("0")).toBe(0);
    expect(yieldSyllablesFromEnv("8")).toBe(8);
    expect(yieldSyllablesFromEnv("2.5")).toBeUndefined();
    expect(yieldSyllablesFromEnv("")).toBeUndefined();
  });

  test("MEET_TURN_HOLD_MS / MEET_YIELD_SYLLABLES reach the hub through the config", async () => {
    bot = startBot();
    h = await makeHarness({ config: { meet: { url: bot.url, turnHoldMs: 2500, yieldSyllables: 0 } } });
    expect(h.app.core.meet.timings.turnHoldMs).toBe(2500);
    expect(h.app.core.meet.timings.yieldSyllables).toBe(0);
    expect(h.app.core.meet.timings.turnMaxMs).toBe(10_000);
  });
});

// ───────────────────────────── A. leaving when asked ─────────────────────────────

describe("A. leaving when asked", () => {
  test("by name: stops speech, says goodbye (in the minutes), leaves once it has played; note 'asked' and the summary", async () => {
    const { h, bot, meetingId, threadId } = await setup();
    const logs = captureLogs(h);
    const chat = chatStub(h);
    await converse(h, bot, chat);
    bot.push("speaking", { on: true, sayId: bot.sayIds.at(-1)! });
    // anyone may ask; the endpoint gets no "네," first (the goodbye is the answer)
    bot.push("partial", { text: "모시야 이제 나가도 돼" });
    bot.push("endpoint", { seq: seqN + 1, speaker: "민수" });
    line(bot, "모시야 이제 나가도 돼", "민수");
    await until(() => bot.says.at(-1) === LEAVE_LINE, 2000, "goodbye");
    expect(bot.stops).toBeGreaterThanOrEqual(1);
    expect(bot.says.filter((t) => t === MEET_ACKS.yes).length).toBe(1); // only the first call's
    await Bun.sleep(60);
    expect(bot.deletes).toBe(0); // still saying goodbye
    const goodbye = bot.sayIds.at(-1)!;
    bot.push("speaking", { on: true, sayId: goodbye });
    // more talk meanwhile is written down, never answered
    line(bot, "모시야, 마지막으로 하나만 물어볼게?", "하은");
    await Bun.sleep(40);
    expect(chat.length).toBe(1);
    bot.push("speaking", { on: false, sayId: goodbye });
    await until(() => h.app.core.meet.meeting(meetingId)?.state === "ended", 3000, "left");
    await h.app.core.idle();
    expect(bot.deletes).toBe(1);
    expect(h.app.core.meet.meeting(meetingId)!.reason).toBe("asked");
    const said = h.app.core.meet.utterances(meetingId).filter((u) => u.role === "said").map((u) => u.text);
    expect(said).toContain(LEAVE_LINE);
    const texts = threadTexts(h, threadId);
    expect(texts).toContain("회의에서 나가 달라는 말을 듣고 나왔어요.");
    expect(texts.some((t) => t.startsWith("**회의 요약**"))).toBe(true);
    expect(texts.some((t) => t.includes("마지막으로 하나만"))).toBe(true); // in the minutes
    const left = logs.find((l) => l.includes("meet leave asked"))!;
    expect(left).toContain('"how":"call"');
    expect(left).toContain('"played":true');
    expect(logs.join("\n")).not.toContain("나가도");
    expect(logs.join("\n")).not.toContain("민수");
  });

  test("not leave: no vocative, a question; a goodbye that never plays waits at most leaveSayMaxMs", async () => {
    const { h, bot, meetingId } = await setup();
    const chat = chatStub(h);
    h.app.core.meet.timings.leaveSayMaxMs = 80;
    line(bot, "모시가 나가면 회의록은 누가 써?", "하은");
    line(bot, "모시 나가는 거 아니지?", "하은"); // a call, so it's answered — but nobody leaves
    await until(() => chat.length === 1, 2000, "answered");
    await h.app.core.idle();
    expect(asked(chat[0]!)).toContain("모시 나가는 거 아니지?");
    expect(bot.deletes).toBe(0);
    expect(bot.says).not.toContain(LEAVE_LINE);
    const t0 = performance.now();
    line(bot, "모시 퇴장해", "하은");
    await until(() => h.app.core.meet.meeting(meetingId)?.state === "ended", 3000, "left");
    expect(performance.now() - t0).toBeGreaterThanOrEqual(70); // the cap, since no `speaking` came
    expect(h.app.core.meet.meeting(meetingId)!.reason).toBe("asked");
  });

  test("works without a model, and a failed goodbye doesn't stop it; a waiting turn is dropped", async () => {
    const { h, bot, meetingId } = await setup();
    const logs = captureLogs(h);
    delete h.app.core.deps.llm!.chat;
    delete h.app.core.deps.llm!.meetClient;
    bot.sayStatus = 500;
    line(bot, "모시야 이만 가 봐", "하은");
    await until(() => h.app.core.meet.meeting(meetingId)?.state === "ended", 3000, "left");
    expect(h.app.core.meet.meeting(meetingId)!.reason).toBe("asked");
    expect(logs.find((l) => l.includes("meet leave asked"))!).toContain('"said":false');
    expect(logs.some((l) => l.startsWith("error"))).toBe(false);
  });

  test("a held turn is dropped when someone asks 모시 to leave", async () => {
    const { h, bot, meetingId } = await setup();
    const chat = chatStub(h);
    h.app.core.meet.timings.leaveSayMaxMs = 50;
    line(bot, "모시야 내일 회의 자료를", "하은");
    await until(() => bot.says.length === 1, 2000, "네,");
    line(bot, "모시 나가 줘", "민수");
    await until(() => h.app.core.meet.meeting(meetingId)?.state === "ended", 3000, "left");
    await Bun.sleep(120); // past turnHoldMs
    expect(chat.length).toBe(0);
  });

  test("conversation mode: an unnamed line leaves on a leave imperative the classifier doesn't call cross-talk", async () => {
    const { h, bot, meetingId } = await setup();
    const logs = captureLogs(h);
    const chat = chatStub(h);
    h.app.core.meet.timings.leaveSayMaxMs = 50;
    const checks = stubAddressee(h, {
      "먼저 나가 있어.": "other", // the words, but cross-talk
      "저는 3시에 나가 봐야 해서요.": "addressed", // not an imperative
      "오늘 수고했어 이제 쉬어.": "addressed",
      "이제 나가도 돼.": "dismiss", // what the classifier mostly says to these
    });
    await converse(h, bot, chat);
    const answered = chat.length;
    line(bot, "먼저 나가 있어.", "하은");
    line(bot, "저는 3시에 나가 봐야 해서요.", "민수");
    line(bot, "오늘 수고했어 이제 쉬어.", "하은");
    await until(() => checks.length === 3, 2000, "three checks");
    await Bun.sleep(150);
    await h.app.core.idle();
    expect(bot.deletes).toBe(0);
    expect(chat.length).toBe(answered); // statements: not answered either
    expect(logs.some((l) => l.includes("meet addressee") && l.includes('"verdict":"leave"'))).toBe(false);
    line(bot, "이제 나가도 돼.", "하은");
    await until(() => h.app.core.meet.meeting(meetingId)?.state === "ended", 3000, "left");
    expect(h.app.core.meet.meeting(meetingId)!.reason).toBe("asked");
    expect(logs.find((l) => l.includes("meet addressee") && l.includes('"verdict":"leave"'))!).toContain('"classified":"dismiss"');
    expect(logs.find((l) => l.includes("meet leave asked"))!).toContain('"how":"followup"');
    expect(logs.some((l) => l.includes("meet mode") && l.includes('"reason":"dismiss"'))).toBe(false); // left, not dismissed
  });

  test("only while in the call", async () => {
    bot = startBot();
    h = await makeHarness({ config: { meet: { url: bot.url } } });
    const a = await h.signup("haneul");
    const ctx = { userId: a.session.user.id, threadId: a.session.mainThreadId, agentName: "깽이", displayName: "하늘", workspaceDir: "/tmp", signal: new AbortController().signal, credentials: {}, store: {}, status: () => {}, now: () => new Date() } as unknown as ToolContext;
    await meetTools(h.app.core, a.session.user.id).find((d) => d.name === "sys_join_meet")!.run({ url: URL_IN }, ctx);
    await until(() => bot!.connected, 3000, "SSE connect");
    bot.push("state", { state: "waiting_admission" });
    await until(() => h!.app.core.meet.active(a.session.user.id)?.state === "waiting_admission", 3000, "waiting");
    line(bot, "모시야 나가 줘", "하은");
    await Bun.sleep(80);
    expect(bot.deletes).toBe(0);
    expect(bot.says).toEqual([]);
  });
});

// ───────────────────────────── B. waiting for the end of the turn ─────────────────────────────

describe("B. waiting for the end of the turn", () => {
  test("an unfinished call gets 네, and waits; the same speaker's next line completes it: one answer", async () => {
    const { h, bot } = await setup();
    const logs = captureLogs(h);
    const chat = chatStub(h);
    h.app.core.meet.timings.turnHoldMs = 5_000;
    line(bot, "모시야 내일 회의 자료를", "하은");
    await until(() => bot.says.length === 1, 2000, "네,");
    expect(bot.says).toEqual([MEET_ACKS.yes]);
    await Bun.sleep(60);
    expect(chat.length).toBe(0);
    line(bot, "정리해서 보내 줘.", "하은");
    await until(() => chat.length === 1 && bot.says.length === 2, 2000, "answer");
    await h.app.core.idle();
    expect(asked(chat[0]!)).toContain('"모시야 내일 회의 자료를 정리해서 보내 줘."');
    expect(bot.says).toEqual([MEET_ACKS.yes, "대답 1번이에요."]); // one 네,
    expect(logs.find((l) => l.includes("meet turn held"))!).toContain('"kind":"call"');
    const turn = logs.find((l) => l.includes("meet turn {"))!;
    expect(turn).toContain('"end":"complete"');
    expect(turn).toContain('"parts":2');
    expect(logs.join("\n")).not.toContain("자료를");
  });

  test("silence answers what we have after turnHoldMs; any partial, endpoint or transcript restarts the wait; the cap is turnMaxMs", async () => {
    const { h, bot } = await setup();
    const logs = captureLogs(h);
    const chat = chatStub(h);
    h.app.core.meet.timings.turnHoldMs = 100;
    h.app.core.meet.timings.turnMaxMs = 10_000;
    line(bot, "모시야 그 문서 좀", "하은");
    await until(() => bot.says.length === 1, 2000, "네,");
    // someone keeps talking (partials with no speaker): the answer waits
    for (let i = 0; i < 6; i++) {
      bot.push("partial", { text: `음 그러니까 ${i}` });
      await Bun.sleep(50);
    }
    bot.push("endpoint", { seq: 900, speaker: null });
    expect(chat.length).toBe(0);
    await until(() => chat.length === 1, 2000, "answered after the silence");
    await h.app.core.idle();
    expect(asked(chat[0]!)).toContain('"모시야 그 문서 좀"');
    expect(logs.find((l) => l.includes("meet turn {"))!).toContain('"end":"hold"');

    // the cap: speech never stops, the answer comes at turnMaxMs
    h.app.core.meet.timings.turnMaxMs = 250;
    const t0 = performance.now();
    line(bot, "모시야 그리고", "하은");
    let keepTalking = true;
    void (async () => {
      while (keepTalking) {
        bot.push("partial", { text: "어 그" });
        await Bun.sleep(30);
      }
    })();
    await until(() => chat.length === 2, 3000, "capped answer");
    keepTalking = false;
    const waited = performance.now() - t0;
    expect(waited).toBeGreaterThanOrEqual(230);
    expect(waited).toBeLessThan(1500);
    expect(logs.filter((l) => l.includes("meet turn {")).at(-1)).toContain('"end":"cap"');
    bot.push("endpoint", { seq: 901, speaker: null });
    await h.app.core.idle();
  });

  test("another named speaker never joins the turn but delays the answer; no name counts as the same speaker", async () => {
    const { h, bot } = await setup();
    const chat = chatStub(h);
    const checks = stubAddressee(h, { "그거 어제 올리지 않았어요?": "addressed" });
    h.app.core.meet.timings.turnHoldMs = 150;
    line(bot, "모시야 그 견적서를", "하은");
    await until(() => bot.says.length === 1, 2000, "네,");
    await Bun.sleep(100);
    const t1 = performance.now();
    line(bot, "그거 어제 올리지 않았어요?", "민수"); // not joined, and not checked on its own either (one answer at a time)
    await until(() => chat.length === 1, 2000, "answer");
    expect(performance.now() - t1).toBeGreaterThanOrEqual(130); // the wait restarted at 민수's line
    expect(asked(chat[0]!)).toContain('"모시야 그 견적서를"');
    expect(asked(chat[0]!)).not.toContain("어제 올리지");
    await h.app.core.idle();
    expect(checks.length).toBe(0);
    expect(chat.length).toBe(1);

    line(bot, "모시야 지난주 회의록이랑", "하은");
    await until(() => bot.says.length === 3, 2000, "네, 2");
    line(bot, "이번 주 거 비교해 줘", null);
    await until(() => chat.length === 2, 2000, "answer 2");
    expect(asked(chat[1]!)).toContain('"모시야 지난주 회의록이랑 이번 주 거 비교해 줘"');
  });

  test("a follow-up judged addressed but unfinished waits too (no 네,), and is checked once", async () => {
    const { h, bot } = await setup();
    const chat = chatStub(h);
    const logs = captureLogs(h);
    const checks = stubAddressee(h, { "그럼 그 문서를": "addressed", "그럼 장소는": "addressed" });
    h.app.core.meet.timings.turnHoldMs = 5_000;
    await converse(h, bot, chat);
    const says = bot.says.length;
    // no question in it yet: it waits instead of failing the statement gate, which judges the whole turn
    line(bot, "그럼 장소는", "하은");
    await until(() => checks.length === 1, 2000, "check");
    await Bun.sleep(40);
    expect(chat.length).toBe(1);
    expect(bot.says.length).toBe(says); // no 네, for a follow-up
    line(bot, "어디로 잡았어?", "하은");
    await until(() => chat.length === 2, 2000, "answer");
    expect(checks.length).toBe(1);
    expect(asked(chat[1]!)).toContain('너에게 이어서 한 말: "그럼 장소는 어디로 잡았어?"');
    await h.app.core.idle();
    // …and a turn that ends as a statement is for the room
    line(bot, "그럼 그 문서를", "하은");
    await until(() => checks.length === 2, 2000, "check 2");
    line(bot, "제가 오후에 올릴게요.", "하은");
    await until(() => logs.some((l) => l.includes("meet turn {") && l.includes('"gate":"statement"')), 2000, "statement turn");
    await Bun.sleep(30);
    expect(chat.length).toBe(2);
  });

  test("a bare call: 말씀하세요 only after callFollowMs without speech; another speaker's line is not its question", async () => {
    const { h, bot } = await setup();
    const logs = captureLogs(h);
    const chat = chatStub(h);
    h.app.core.meet.timings.callFollowMs = 120;
    line(bot, "모시야.", "하은");
    await until(() => bot.says.length === 1, 2000, "네,");
    for (let i = 0; i < 5; i++) {
      bot.push("partial", { text: "어 잠시만" });
      await Bun.sleep(60);
    }
    expect(bot.says.length).toBe(1); // still talking: no 말씀하세요 yet
    line(bot, "회의실 예약했어요.", "민수");
    await until(() => bot.says.length === 2, 2000, "말씀하세요");
    expect(bot.says[1]).toBe("말씀하세요.");
    expect(chat.length).toBe(0);
    expect(logs.some((l) => l.includes("meet call alone"))).toBe(true);
  });

  test("complete lines are answered at once, whatever turnHoldMs is", async () => {
    const { h, bot } = await setup();
    const logs = captureLogs(h);
    const chat = chatStub(h);
    h.app.core.meet.timings.turnHoldMs = 5_000;
    const t0 = performance.now();
    line(bot, "모시야, 다음 회의 언제야?", "하은");
    await until(() => bot.says.length === 2, 2000, "answer");
    expect(performance.now() - t0).toBeLessThan(500);
    expect(chat.length).toBe(1);
    expect(logs.some((l) => l.includes("meet turn held"))).toBe(false);
  });
});

// ───────────────────────────── C. the speaker goes on ─────────────────────────────

describe("C. the speaker goes on after the answer started", () => {
  test("3+ syllables before the first sentence: the answer is given up (네, stays) and joins the rest", async () => {
    const { h, bot } = await setup();
    const logs = captureLogs(h);
    const chat = chatStub(h, { delayMs: 150 });
    line(bot, "모시야 내일 서울 날씨 어때", "하은");
    await until(() => chat.length === 1 && bot.says.length === 1, 2000, "answer started");
    bot.push("partial", { text: "네네" }); // a backchannel doesn't count
    await Bun.sleep(10);
    expect(logs.some((l) => l.includes("meet turn continued"))).toBe(false);
    bot.push("partial", { text: "그리고 모레도" });
    await until(() => logs.some((l) => l.includes("meet turn continued")), 2000, "continued");
    bot.push("endpoint", { seq: seqN + 1, speaker: "하은" });
    line(bot, "그리고 모레도 알려 줘.", "하은");
    await until(() => chat.length === 2 && bot.says.length === 2, 3000, "joined answer");
    await h.app.core.idle();
    expect(bot.says).toEqual([MEET_ACKS.yes, "대답 2번이에요."]); // nothing from the first call, one 네,
    expect(bot.stops).toBe(0);
    expect(asked(chat[1]!)).toContain('"모시야 내일 서울 날씨 어때 그리고 모레도 알려 줘."');
    expect(logs.find((l) => l.includes("meet turn continued"))!).toContain('"on":"partial"');
    expect(logs.filter((l) => l.includes("meet reply")).map((l) => /"outcome":"(\w+)"/.exec(l)![1])).toEqual(["stopped", "ok"]);
  });

  test("local STT (no partials): a transcript before the first sentence continues the turn", async () => {
    const { h, bot } = await setup();
    const logs = captureLogs(h);
    const chat = chatStub(h, { delayMs: 150 });
    line(bot, "모시야 이번 주 일정 알려 줘", "하은");
    await until(() => chat.length === 1, 2000, "answer started");
    line(bot, "아 그리고 다음 주 것도.", "하은");
    await until(() => chat.length === 2, 2000, "joined answer");
    await h.app.core.idle();
    expect(logs.find((l) => l.includes("meet turn continued"))!).toContain('"on":"transcript"');
    expect(asked(chat[1]!)).toContain('"모시야 이번 주 일정 알려 줘 아 그리고 다음 주 것도."');
    expect(bot.says.filter((t) => t !== MEET_ACKS.yes)).toEqual(["대답 2번이에요."]);
  });

  test("a superseded answer posts nothing (a login card it found): the joined turn posts it once", async () => {
    const { h, bot, threadId } = await setup();
    const logs = captureLogs(h);
    let lookups = 0;
    h.app.core.deps.systemTools = () => [
      {
        name: "k_test_lookup",
        description: "look up a channel",
        parameters: { type: "object", properties: {} },
        icon: "search",
        title: () => "찾아보기",
        credential: async () => {
          lookups++;
          return { service: "slack", serviceName: "Slack", reason: "슬랙 연결이 필요해요", fields: [] };
        },
        async run() {
          return { ok: true, summary: "x" };
        },
      },
    ];
    let release = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const said = "슬랙이 아직 연결되지 않아서 앱에 연결 카드를 올려 뒀어요.";
    const model = meetModel(h, [
      callTool("k_test_lookup"),
      async function* (req) {
        await held(req, gate); // the first run is still writing when the speaker goes on
        if (!req.signal?.aborted) yield { type: "text", delta: said };
      },
      callTool("k_test_lookup"),
      async function* () {
        yield { type: "text", delta: said };
      },
    ]);
    line(bot, "모시야 슬랙 공지 채널 최근 거 찾아봐 줘", "하은");
    await until(() => model.n === 2 && lookups === 1, 3000, "first run found the login card");
    bot.push("partial", { text: "그리고 디엠도" });
    await until(() => logs.some((l) => l.includes("meet turn continued")), 2000, "continued");
    bot.push("endpoint", { seq: seqN + 1, speaker: "하은" });
    line(bot, "그리고 디엠도 봐 줘.", "하은");
    await until(() => logs.filter((l) => l.includes("meet reply")).length === 2, 3000, "joined answer");
    release();
    await h.app.core.idle();
    expect(logs.filter((l) => l.includes("meet reply")).map((l) => /"outcome":"(\w+)"/.exec(l)![1])).toEqual(["stopped", "ok"]);
    expect(lookups).toBe(2);
    const posts = threadCards(h, threadId);
    expect(posts.length).toBe(1); // only the joined turn's
    expect(posts[0]!.cards).toEqual([expect.objectContaining({ type: "credential_request", service: "slack" })]);
    expect(bot.says.filter((t) => t === said).length).toBe(1);
  });

  test("an answer that started a tool with an outside effect is not given up", async () => {
    const { h, bot } = await setup();
    const logs = captureLogs(h);
    bot.push("participants", { count: 2 });
    let made = 0;
    h.app.core.deps.systemTools = () => [
      {
        name: "sys_create_artifact",
        description: "make a document",
        parameters: { type: "object", properties: {} },
        icon: "doc",
        title: () => "문서 만들기",
        async run() {
          made++;
          return { ok: true, summary: "만들었어요", card: { type: "artifact", artifactId: "a1", title: "회의 정리", kind: "document", preview: "…" } };
        },
      },
    ];
    let release = () => {};
    const gate = new Promise<void>((r) => (release = r));
    let n = 0;
    h.app.core.deps.llm!.meetClient = {
      model: "fake",
      async *stream(_req: LlmRequest): AsyncGenerator<LlmChunk> {
        n++;
        if (n === 1) {
          yield { type: "tool_calls", calls: [{ id: "c1", type: "function", function: { name: "sys_create_artifact", arguments: "{}" } }] };
        } else {
          await gate;
          yield { type: "text", delta: "앱에 문서로 만들어 뒀어요." };
        }
        yield { type: "usage", usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } };
      },
    } as never;
    line(bot, "모시야 방금 정한 거 문서로 만들어 줘.", "하은");
    await until(() => n === 2, 3000, "tool ran");
    expect(made).toBe(1);
    bot.push("partial", { text: "그리고 그거 표로" });
    await Bun.sleep(30);
    bot.push("endpoint", { seq: 950, speaker: "하은" });
    release();
    await until(() => logs.some((l) => l.includes("meet reply")), 3000, "reply done");
    expect(logs.some((l) => l.includes("meet turn continued"))).toBe(false);
    expect(logs.find((l) => l.includes("meet reply"))!).toContain('"outcome":"ok"');
    expect(made).toBe(1);
  });
});

// ───────────────────────────── D. never talking over people ─────────────────────────────

describe("D. never talking over people", () => {
  /** two sentences; the second only after the first is spoken (and `go` is released) */
  function twoSentences(h: Harness) {
    let go = () => {};
    const gate = new Promise<void>((r) => (go = r));
    const calls: ChatRequest[] = [];
    h.app.core.deps.llm!.chat = async function* (i: ChatRequest) {
      if (i.system.includes("회의 요약")) return;
      calls.push(i);
      yield "다음 회의는 금요일 오후 3시예요. ";
      await Promise.race([gate, new Promise((r) => i.signal?.addEventListener("abort", r, { once: true }))]);
      if (i.signal?.aborted) return;
      yield "장소는 3층 회의실이에요.";
    };
    return { calls, go: () => go() };
  }

  test("6+ syllables over an answer: 모시 stops and drops the rest; the line then goes on as usual (checked in a conversation)", async () => {
    const { h, bot } = await setup();
    const logs = captureLogs(h);
    const chat = chatStub(h);
    const checks = stubAddressee(h, {});
    await converse(h, bot, chat);
    const two = twoSentences(h);
    line(bot, "모시야, 금요일 회의 어디야?", "하은");
    await until(() => bot.says.at(-1) === "다음 회의는 금요일 오후 3시예요.", 2000, "first sentence");
    bot.push("speaking", { on: true, sayId: bot.sayIds.at(-1)! });
    // backchannels never count
    for (const t of ["네네", "아 그렇구나", "네 맞아요 맞아요"]) bot.push("partial", { text: t });
    await Bun.sleep(30);
    expect(bot.stops).toBe(0);
    bot.push("endpoint", { seq: seqN + 1, speaker: "민수" });
    line(bot, "네 맞아요 맞아요", "민수");
    bot.push("partial", { text: "근데 그건" });
    await Bun.sleep(20);
    expect(bot.stops).toBe(0); // 4 syllables
    bot.push("partial", { text: "근데 그건 수요일 아니었어요" });
    await until(() => bot.stops === 1, 2000, "yield");
    two.go();
    bot.push("endpoint", { seq: seqN + 1, speaker: "민수" });
    line(bot, "근데 그건 수요일 아니었어요?", "민수");
    // checked as usual (at its endpoint, on the last partial)
    await until(() => checks.some((c) => c.utterance.startsWith("근데 그건 수요일 아니었어요")), 2000, "checked as usual");
    await h.app.core.idle();
    expect(bot.says).not.toContain("장소는 3층 회의실이에요.");
    expect(logs.find((l) => l.includes("meet yield"))!).toContain('"syllables":12');
    expect(logs.join("\n")).not.toContain("수요일");
  });

  test("a yield after sys_create_artifact still posts the document card (a stop, not a supersede)", async () => {
    const { h, bot, threadId } = await setup();
    const logs = captureLogs(h);
    bot.push("participants", { count: 2 });
    let made = 0;
    h.app.core.deps.systemTools = () => [
      {
        name: "sys_create_artifact",
        description: "make a document",
        parameters: { type: "object", properties: {} },
        icon: "doc",
        title: () => "문서 만들기",
        async run() {
          made++;
          return { ok: true, summary: "만들었어요", card: { type: "artifact", artifactId: "a1", title: "회의 정리", kind: "document", preview: "…" } };
        },
      },
    ];
    let release = () => {};
    const gate = new Promise<void>((r) => (release = r));
    meetModel(h, [
      callTool("sys_create_artifact"),
      async function* (req) {
        yield { type: "text", delta: "앱에 문서로 만들어 뒀어요. " };
        await held(req, gate); // still writing the rest when someone talks over it
        if (!req.signal?.aborted) yield { type: "text", delta: "제목은 회의 정리예요." };
      },
    ]);
    line(bot, "모시야 방금 정한 거 문서로 만들어 줘.", "하은");
    await until(() => bot.says.includes("앱에 문서로 만들어 뒀어요."), 3000, "first sentence");
    expect(made).toBe(1);
    bot.push("speaking", { on: true, sayId: bot.sayIds.at(-1)! });
    bot.push("partial", { text: "잠깐만요 그거 말고 다른 거요" });
    await until(() => bot.stops === 1, 2000, "yield");
    await until(() => logs.some((l) => l.includes("meet reply")), 3000, "reply done");
    release();
    await h.app.core.idle();
    expect(logs.find((l) => l.includes("meet reply"))!).toContain('"outcome":"stopped"');
    expect(bot.says).not.toContain("제목은 회의 정리예요.");
    const posts = threadCards(h, threadId);
    expect(posts.length).toBe(1);
    expect(posts[0]!.text).toContain("회의 중에 만든 것");
    expect(posts[0]!.cards).toEqual([expect.objectContaining({ type: "artifact", artifactId: "a1" })]);
  });

  test("MEET_YIELD_SYLLABLES=0 never yields; local STT yields on the transcript", async () => {
    const { h, bot } = await setup();
    const logs = captureLogs(h);
    h.app.core.meet.timings.yieldSyllables = 0;
    let two = twoSentences(h);
    line(bot, "모시야, 다음 회의 언제야?", "하은");
    await until(() => bot.says.length === 2, 2000, "first sentence");
    bot.push("speaking", { on: true, sayId: bot.sayIds.at(-1)! });
    bot.push("partial", { text: "근데 그건 수요일 아니었어요" });
    await Bun.sleep(40);
    expect(bot.stops).toBe(0);
    two.go();
    await until(() => bot.says.length === 3, 2000, "second sentence");
    bot.push("speaking", { on: false, sayId: bot.sayIds[1]! });
    bot.push("endpoint", { seq: seqN + 1, speaker: null });
    line(bot, "근데 그건 수요일 아니었어요", "민수");
    await h.app.core.idle();

    h.app.core.meet.timings.yieldSyllables = 6;
    two = twoSentences(h);
    line(bot, "모시야, 장소는 어디야?", "하은");
    await until(() => bot.says.length === 5, 2000, "first sentence 2");
    bot.push("speaking", { on: true, sayId: bot.sayIds.at(-1)! });
    line(bot, "아 그거 제가 이미 예약해 뒀어요", "민수"); // no partials: the transcript itself
    await until(() => bot.stops === 1, 2000, "yield on the transcript");
    two.go();
    await h.app.core.idle();
    expect(bot.says.length).toBe(5);
    expect(logs.find((l) => l.includes("meet yield"))!).toContain('"on":"transcript"');
  });

  test("the first sentence waits for the endpoint of someone mid-utterance (cached 네, doesn't); at most talkOverMaxMs", async () => {
    const { h, bot } = await setup();
    const logs = captureLogs(h);
    const chat = chatStub(h, { delayMs: 60 });
    line(bot, "모시야, 다음 회의 언제야?", "하은");
    await until(() => bot.says.length === 1, 2000, "네,");
    bot.push("partial", { text: "음" }); // someone starts; too short to be going on (C)
    await Bun.sleep(150);
    expect(bot.says).toEqual([MEET_ACKS.yes]);
    expect(chat.length).toBe(1);
    const tEnd = performance.now();
    bot.push("endpoint", { seq: seqN + 1, speaker: "민수" });
    await until(() => bot.says.length === 2, 2000, "answer after the endpoint");
    expect(bot.sayAt[1]!).toBeGreaterThanOrEqual(tEnd);
    await h.app.core.idle();
    const reply = logs.find((l) => l.includes("meet reply"))!;
    expect(Number(/"waitMs":(\d+)/.exec(reply)![1])).toBeGreaterThan(50);

    // no endpoint ever: speaks after talkOverMaxMs
    h.app.core.meet.timings.talkOverMaxMs = 120;
    line(bot, "모시야, 장소는 어디야?", "하은");
    await until(() => bot.says.length === 3, 2000, "네, 2");
    bot.push("partial", { text: "어" });
    const t0 = performance.now();
    await until(() => bot.says.length === 4, 2000, "answer after the cap");
    expect(performance.now() - t0).toBeGreaterThanOrEqual(100);
  });
});
