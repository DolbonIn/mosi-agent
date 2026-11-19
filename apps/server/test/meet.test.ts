import { afterEach, describe, expect, test } from "bun:test";
import type { LlmChunk, LlmRequest, ToolContext, ToolDef } from "@pickle/agent";
import type { ChatRequest } from "../src/meet.ts";
import type { Addressee, AddresseeInput } from "../src/meetAddressee.ts";
import {
  capTranscript,
  fuzzSyllable,
  isBareCall,
  isDismissCall,
  isFiller,
  isPromptEcho,
  isStopRequest,
  isWakeCall,
  kstWhen,
  MEET_ACKS,
  maskMeetCode,
  meetPromptNote,
  meetTools,
  meetingNotes,
  parseMeetUrl,
  sentenceEnd,
  serviceUrlFromEnv,
  spokenText,
  sttPromptFor,
  wakeRegex,
  wakeWords,
} from "../src/meet.ts";
import { buildTools } from "../src/turns.ts";
import type { Logger } from "../src/log.ts";
import { makeHarness, outcome, readSse, type Harness } from "./helpers.ts";

const CODE = "abc-defg-hij";
const URL_IN = `https://meet.google.com/${CODE}?authuser=0`;

// ───────────────────────────── fake services/meet ─────────────────────────────

interface Call {
  method: string;
  path: string;
  body: Record<string, unknown> | null;
}

interface FakeBot {
  url: string;
  calls: Call[];
  says: string[];
  stops: number;
  /** `since` of every SSE connection */
  connects: number[];
  /** POST /sessions status (201 joins) */
  joinStatus: number;
  /** GET …/events answers 404 (the bot lost the session) */
  lost: boolean;
  state: string;
  /** GET /sessions/s1 `title` (the Meet page title), once the bot has read it */
  title: string | null;
  push(event: string, data: Record<string, unknown>): void;
  /** drop every open SSE connection (the server should reconnect) */
  drop(): void;
  stop(): void;
}

function startBot(): FakeBot {
  const encoder = new TextEncoder();
  const clients = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const transcripts: string[] = [];
  let sayN = 0;
  const bot: FakeBot = {
    url: "",
    calls: [],
    says: [],
    stops: 0,
    connects: [],
    joinStatus: 201,
    lost: false,
    state: "launching",
    title: null,
    push(event, data) {
      const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
      if (event === "state") bot.state = String(data.state);
      if (event === "transcript") transcripts.push(frame);
      for (const c of clients) c.enqueue(encoder.encode(frame));
      if (event === "ended") {
        for (const c of clients) c.close();
        clients.clear();
      }
    },
    drop() {
      for (const c of clients) c.close();
      clients.clear();
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
      bot.calls.push({ method: req.method, path: u.pathname, body });
      if (u.pathname === "/health") return Response.json({ ok: true, chrome: "ready", stt: "ready", tts: "ready", session: null });
      if (req.method === "POST" && u.pathname === "/sessions") {
        if (bot.joinStatus !== 201) return Response.json({ error: bot.joinStatus === 409 ? "busy" : "invalid_url" }, { status: bot.joinStatus });
        return Response.json({ id: "s1", state: "launching" }, { status: 201 });
      }
      if (u.pathname === "/sessions/s1/events") {
        if (bot.lost) return Response.json({ error: "not_found" }, { status: 404 });
        bot.connects.push(Number(u.searchParams.get("since") ?? -1));
        let me: ReadableStreamDefaultController<Uint8Array>;
        const stream = new ReadableStream<Uint8Array>({
          start(c) {
            me = c;
            clients.add(c);
            c.enqueue(encoder.encode(`: hello\n\nevent: state\ndata: ${JSON.stringify({ state: bot.state })}\n\n`));
            // replays every transcript regardless of `since`: the server must de-duplicate
            for (const f of transcripts) c.enqueue(encoder.encode(f));
          },
          cancel() {
            clients.delete(me);
          },
        });
        return new Response(stream, { headers: { "content-type": "text/event-stream" } });
      }
      if (u.pathname === "/sessions/s1/say" && req.method === "POST") {
        if (bot.state !== "in_call") return Response.json({ error: "not_in_call" }, { status: 409 });
        bot.says.push(String(body?.text ?? ""));
        return Response.json({ sayId: `say${++sayN}` }, { status: 202 });
      }
      if (u.pathname === "/sessions/s1/say/stop") {
        bot.stops++;
        return Response.json({ ok: true });
      }
      if (u.pathname === "/sessions/s1" && req.method === "DELETE") {
        setTimeout(() => {
          bot.push("state", { state: "ended" });
          bot.push("ended", { reason: "left" });
        }, 10);
        return Response.json({ state: "ended" });
      }
      if (u.pathname === "/sessions/s1") return Response.json({ id: "s1", state: bot.state, ...(bot.title ? { title: bot.title } : {}) });
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
    await Bun.sleep(5);
  }
}

function captureLogs(h: Harness): string[] {
  const lines: string[] = [];
  const rec =
    (level: string) =>
    (event: string, fields?: Record<string, unknown>) =>
      lines.push(`${level} ${event} ${JSON.stringify(fields ?? {})}`);
  const log: Logger = { info: rec("info"), warn: rec("warn"), error: rec("error") };
  h.app.core.log = log;
  return lines;
}

function toolCtx(userId: string, extra: Partial<ToolContext> = {}): ToolContext {
  return {
    userId,
    threadId: "t_main",
    agentName: "깽이",
    displayName: "하늘",
    workspaceDir: "/tmp",
    signal: new AbortController().signal,
    credentials: {} as ToolContext["credentials"],
    store: {} as ToolContext["store"],
    status: () => {},
    now: () => new Date(),
    ...extra,
  };
}

const names = (defs: ToolDef[]) => defs.map((d) => d.name);
const tool = (h: Harness, userId: string, name: string) => meetTools(h.app.core, userId).find((d) => d.name === name)!;

function threadRows(h: Harness, threadId: string): { role: string; text: string; llm_json: string | null }[] {
  return h.db.sql.query(`SELECT role, text, llm_json FROM messages WHERE thread_id = ? ORDER BY rowid`).all(threadId) as {
    role: string;
    text: string;
    llm_json: string | null;
  }[];
}

/** A scripted LlmHelpers.chat: wake answers come in two deltas; the second waits until the first was spoken. */
function scriptChat(h: Harness, bot: FakeBot) {
  const calls: ChatRequest[] = [];
  const state = { firstSpokenBeforeRest: false };
  h.app.core.deps.llm!.chat = async function* (i: ChatRequest) {
    calls.push(i);
    if (i.system.includes("회의 요약")) {
      i.onUsage?.(500);
      yield "출시 일정을 금요일로 정했어요.\n\n**결정 사항**\n- 출시는 금요일\n\n**할 일**\n- 지민: 디자인 시안 (목요일)\n\n**다음 일정**\n- 없음";
      return;
    }
    i.onUsage?.(120);
    yield "네, 다음 회의는 금요일 ";
    yield "오후 3시예요. ";
    // the instant "네," plus the first sentence must reach the bot before the model finishes
    const end = Date.now() + 2000;
    while (bot.says.length < 2 && Date.now() < end) await Bun.sleep(5);
    state.firstSpokenBeforeRest = bot.says.length >= 2;
    yield "장소는 3층 회의실이에요. 세 번째 문장은 말하지 않아요.";
  };
  return { calls, state };
}

let h: Harness | null = null;
let bot: FakeBot | null = null;
afterEach(async () => {
  await h?.close();
  bot?.stop();
  h = null;
  bot = null;
});

async function setup(opts: { meet?: boolean } = {}) {
  bot = startBot();
  h = await makeHarness({ config: opts.meet === false ? {} : { meet: { url: bot.url } } });
  h.app.core.meet.timings.reconnectMs = 20;
  h.app.core.meet.timings.reconnectMaxMs = 50;
  h.app.core.meet.timings.ackGraceMs = 0; // "네," at once when an answer starts without one (tests of the grace set it)
  const a = await h.signup("haneul");
  return { h, bot, userId: a.session.user.id, token: a.token, mainThreadId: a.session.mainThreadId };
}

/** join through the tool (approval already given) and bring the bot into the call */
async function joinAndEnter(h: Harness, bot: FakeBot, userId: string): Promise<string> {
  const r = await tool(h, userId, "sys_join_meet").run({ url: URL_IN, purpose: "주간 회의 받아 적기" }, toolCtx(userId));
  expect(r.ok).toBe(true);
  await until(() => bot.connects.length > 0, 3000, "SSE connect");
  bot.push("state", { state: "waiting_admission" });
  bot.push("state", { state: "in_call" });
  await until(() => h.app.core.meet.active(userId)?.state === "in_call", 3000, "in_call");
  return h.app.core.meet.active(userId)!.thread_id;
}

// ───────────────────────────── pure helpers ─────────────────────────────

describe("meet helpers", () => {
  test("meeting links and codes", () => {
    expect(parseMeetUrl(URL_IN)).toEqual({ code: CODE, url: `https://meet.google.com/${CODE}` });
    expect(parseMeetUrl("meet.google.com/ABCDEFGHIJ")?.code).toBe(CODE);
    expect(parseMeetUrl(CODE)?.url).toBe(`https://meet.google.com/${CODE}`);
    expect(parseMeetUrl("https://evil.example/abc-defg-hij")).toBeNull();
    expect(parseMeetUrl("https://meet.google.com.evil.example/abc-defg-hij")).toBeNull();
    expect(parseMeetUrl("abc-defg")).toBeNull();
    expect(maskMeetCode(CODE)).toBe("abc-****-hij");
    expect(serviceUrlFromEnv(undefined, "http://127.0.0.1:8791")).toBe("http://127.0.0.1:8791");
    expect(serviceUrlFromEnv("off", "http://x")).toBeNull();
    expect(serviceUrlFromEnv("http://10.0.0.2:9000/", "http://x")).toBe("http://10.0.0.2:9000");
    expect(serviceUrlFromEnv("ftp://x", "http://x")).toBeNull();
  });

  test("wake word: vocative and bare name, not the verb 모시다", () => {
    const w = wakeRegex(["깽이", "모시"]);
    for (const s of ["모시야, 다음 회의 언제야?", "모시아 이거 정리해 줘", "모시님 요약해 주세요", "모시 씨 들려요?", "그럼 모시, 정리 부탁해", "깽이야 몇 시야", "모 시야 들려?"]) {
      expect(w.test(s)).toBe(true);
    }
    for (const s of ["고객님을 모시고 갈게요", "부모님을 모시는 일", "모셔다 드릴게요", "다음 회의 언제죠?", "모시조개 맛있어요"]) {
      expect(w.test(s)).toBe(false);
    }
  });

  test("misheard calls count only at the start of an utterance with more words after them", () => {
    const w = wakeWords(["모시"]);
    for (const s of [
      "5시야, 방금 결정된 거 정리해 줘",
      "모시자 다음 안건 뭐였지?",
      "무시아, 요약해 줄래?",
      "머시야 지금 몇 개 남았지",
      "오시야 정리 좀",
      "모시여, 들려요?",
      "모시야 다음 회의 언제야", // exact still works
      "그럼 모시, 정리 부탁해",
    ]) {
      expect([s, isWakeCall(s, w)]).toEqual([s, true]);
    }
    for (const s of ["회의는 5시야", "오후 5시야 맞지?", "부모님 모시고", "모시는 분", "5시야.", "무시아?", "다섯 시야", "모시조개 맛있어요", "오세요 다들"]) {
      expect([s, isWakeCall(s, w)]).toEqual([s, false]);
    }
    // custom names get the same similar-syllable fuzz
    const k = wakeWords(["깽이", "모시"]);
    expect(isWakeCall("갱이야, 이거 정리해 줘", k)).toBe(true);
    expect(isWakeCall("깨이야 다음 안건은?", k)).toBe(true);
    expect(isWakeCall("갱신이야 이건", k)).toBe(false);
    expect(isWakeCall("오늘 갱이야 정리해", k)).toBe(false);
    expect(fuzzSyllable("모")).toBe("(?:[모무머뭐오우어워]|5)");
    expect(fuzzSyllable("A")).toBe("A");
  });

  test("barge-in words; STT prompt and its echo", () => {
    const w = wakeWords(["깽이", "모시"]);
    expect(isStopRequest("모시 그만", w)).toBe(true);
    expect(isStopRequest("무시 그만", w)).toBe(true);
    expect(isStopRequest("잠깐만요", w)).toBe(true);
    expect(isStopRequest("모시야 그만해도 돼", w)).toBe(true);
    expect(isStopRequest("모시야 다음 회의 언제야", w)).toBe(false);
    expect(isStopRequest("그 일정은 잠깐 미루죠", w)).toBe(false);
    expect(isStopRequest("이 기능은 그만 만들죠", w)).toBe(false);
    expect(sttPromptFor("모시")).toBe("모시야, 지금 회의 내용 좀 정리해 줄래?");
    expect(sttPromptFor("하늘")).toBe("하늘아, 지금 회의 내용 좀 정리해 줄래?");
    const P = sttPromptFor("모시");
    expect(isPromptEcho("모시야 지금 회의 내용 좀 정리해 줄래", P, 800)).toBe(true); // 17 syllables in 0.8 s: an echo
    expect(isPromptEcho("모시야, 지금 회의 내용 좀 정리해 줄래?", P, 2600)).toBe(false); // really said
    expect(isPromptEcho("지금 회의 내용 좀 정리해 줄래", P, 900)).toBe(true);
    expect(isPromptEcho("모시야, 지금 회의 내용 좀 정리해 줄래요?", P, 500)).toBe(false);
    expect(isPromptEcho("모시야", P, 200)).toBe(false);
    expect(isPromptEcho("모시야, 지금 회의 내용 좀 정리해 줄래?", P, null)).toBe(false);
  });

  test("a bare call is the name alone (a filler at most); anything asked makes it a question", () => {
    const w = wakeWords(["깽이", "모시"]);
    for (const t of ["모시야.", "모시야", "모시님?", "모시야, 음", "깽이야!", "저기 모시야", "모시야 모시야"]) expect(isBareCall(t, w)).toBe(true);
    for (const t of ["모시야 있어?", "모시야, 다음 회의 언제야?", "5시야.", "무시아 그거", "부모님 모시고", "그래요."]) expect(isBareCall(t, w)).toBe(false);
  });

  test("meeting times carry the date and weekday (KST); 오늘/어제 only as a prefix", () => {
    const now = Date.UTC(2026, 10, 12, 5, 0); // Thursday 14:00 KST
    expect(kstWhen(Date.UTC(2026, 10, 11, 17, 30), now)).toBe("오늘 11월 12일(목) 02:30");
    expect(kstWhen(Date.UTC(2026, 10, 11, 14, 10), now)).toBe("어제 11월 11일(수) 23:10");
    expect(kstWhen(Date.UTC(2026, 10, 13, 6, 0), now)).toBe("11월 13일(금) 15:00");
    expect(kstWhen(Date.UTC(2026, 10, 8, 3, 33), now)).toBe("11월 8일(일) 12:33");
  });

  test("fillers never reach 모시; the name plus 'that's enough' is a dismiss, a bare 그만 is not", () => {
    for (const t of ["음", "네네", "그렇구나.", "아하", "네.", "좋아요", "응응", "오케이"]) expect(isFiller(t)).toBe(true);
    for (const t of ["뭐야?", "그럼 장소는?", "고마워", "그거 누가 해?", "왜?"]) expect(isFiller(t)).toBe(false);
    const w = wakeWords(["깽이", "모시"]);
    for (const t of ["모시야 이제 됐어", "모시 조용히 해", "모시야, 듣고만 있어", "깽이야 그만 얘기해", "모시야 이제 우리끼리 할게"]) expect(isDismissCall(t, w)).toBe(true);
    for (const t of ["모시 그만", "모시야 잠깐", "이제 됐어", "모시야 다음 회의 언제야?"]) expect(isDismissCall(t, w)).toBe(false);
  });

  test("spoken text and sentence splitting", () => {
    expect(spokenText("**네!** 😀 - 금요일이에요 https://x.y/z")).toBe("네! 금요일이에요");
    expect(sentenceEnd("다음 회의는 금요일")).toBe(-1);
    expect(sentenceEnd("다음 회의는 금요일 오후 3시예요. 장소는")).toBe("다음 회의는 금요일 오후 3시예요.".length);
    expect(sentenceEnd("버전 3.5로 올려요. 다음")).toBe("버전 3.5로 올려요.".length);
    expect(sentenceEnd("네. 금요일 오후 3시예요. 그리고")).toBe("네. 금요일 오후 3시예요.".length); // "네." alone is merged
    expect(sentenceEnd("금요일이에요", true)).toBe("금요일이에요".length);
  });
});

// ───────────────────────────── tools ─────────────────────────────

describe("meet tools", () => {
  test("join is approval-gated with the full code; say/leave appear only during a meeting; never in friend threads", async () => {
    const { h, bot, userId } = await setup();
    const before = names(buildTools(h.app.core, "main", undefined, "on", userId));
    expect(before).toContain("sys_join_meet");
    expect(before).not.toContain("sys_meet_say");
    expect(before).not.toContain("sys_leave_meet");
    expect(names(buildTools(h.app.core, "friend", undefined, "on", userId))).not.toContain("sys_join_meet");

    const join = tool(h, userId, "sys_join_meet");
    const spec = join.approval!({ url: URL_IN, purpose: "주간 회의" }, toolCtx(userId));
    // the title (kept in history and logs) is masked; the full code is only in the card's `meet`
    expect(spec?.title).toBe(`Google Meet 회의(${maskMeetCode(CODE)})에 참여할까요?`);
    expect(spec?.title).not.toContain(CODE);
    expect(spec?.detail).not.toContain(CODE);
    expect((spec as { meet?: { code: string } } | null)?.meet).toEqual({ code: CODE });
    expect(spec?.detail).toContain("깽이가 이 회의에 참여해 듣고 받아 적어요");
    expect(spec?.detail).toContain("주간 회의");
    // still gated when the link is odd (run() rejects it later)
    expect(join.approval!({ url: "nope" }, toolCtx(userId))).not.toBeNull();
    expect(join.title({ url: URL_IN })).toBe("회의 참여");

    await joinAndEnter(h, bot, userId);
    const during = names(buildTools(h.app.core, "main", undefined, "on", userId));
    expect(during).toEqual(expect.arrayContaining(["sys_join_meet", "sys_meet_say", "sys_leave_meet"]));
    // another user doesn't see this user's meeting
    const other = await h.signup("other");
    expect(names(buildTools(h.app.core, "main", undefined, "on", other.session.user.id))).not.toContain("sys_meet_say");

    const again = await tool(h, userId, "sys_join_meet").run({ url: URL_IN }, toolCtx(userId));
    expect(again).toMatchObject({ ok: false, data: { error: "already_in_meeting" } });

    const left = await tool(h, userId, "sys_leave_meet").run({}, toolCtx(userId));
    expect(left.ok).toBe(true);
    expect(bot.calls.some((c) => c.method === "DELETE" && c.path === "/sessions/s1")).toBe(true);
    expect(h.app.core.meet.active(userId)).toBeNull();
    expect(names(buildTools(h.app.core, "main", undefined, "on", userId))).not.toContain("sys_leave_meet");
    const row = h.db.sql.query(`SELECT thread_id, state, reason FROM meetings WHERE user_id = ?`).get(userId) as { thread_id: string; state: string; reason: string };
    expect([row.state, row.reason]).toEqual(["ended", "left"]);
    expect(threadRows(h, row.thread_id).map((r) => r.text)).toContain("회의에서 나왔어요.");
  });

  test("join failures: not configured, bad link, busy bot, unreachable bot", async () => {
    const { h, bot, userId } = await setup({ meet: false });
    const ctx = toolCtx(userId);
    expect(await tool(h, userId, "sys_join_meet").run({ url: URL_IN }, ctx)).toMatchObject({ ok: false, data: { error: "meet_not_configured" } });
    expect(bot.calls.length).toBe(0);

    h.app.core.cfg.meet = { url: bot.url };
    expect(await tool(h, userId, "sys_join_meet").run({ url: "https://zoom.us/j/123" }, ctx)).toMatchObject({ ok: false, data: { error: "invalid_url" } });
    expect(bot.calls.length).toBe(0);

    bot.joinStatus = 409;
    const busy = await tool(h, userId, "sys_join_meet").run({ url: URL_IN }, ctx);
    expect(busy).toMatchObject({ ok: false, data: { error: "busy" } });
    expect(h.app.core.meet.active(userId)).toBeNull();

    h.app.core.cfg.meet = { url: "http://127.0.0.1:9" };
    const down = await tool(h, userId, "sys_join_meet").run({ url: URL_IN }, ctx);
    expect(down).toMatchObject({ ok: false, data: { error: "meet_unreachable" } });
    // each failed attempt leaves a thread note and a closed meeting row
    const rows = h.db.sql.query(`SELECT state FROM meetings WHERE user_id = ?`).all(userId) as { state: string }[];
    expect(rows.map((r) => r.state)).toEqual(["failed", "failed"]);
  });

  test("sys_meet_say speaks in the meeting; nothing to say without one", async () => {
    const { h, bot, userId } = await setup();
    const say = await meetTools(h.app.core, userId)[0]!; // join only
    expect(say.name).toBe("sys_join_meet");
    expect(await h.app.core.meet.say(userId, "늦어요")).toMatchObject({ ok: false, data: { error: "no_meeting" } });
    await joinAndEnter(h, bot, userId);
    const r = await tool(h, userId, "sys_meet_say").run({ text: "**하늘님이** 5분 늦는다고 하셨어요 🙏" }, toolCtx(userId));
    expect(r.ok).toBe(true);
    expect(bot.says).toEqual(["하늘님이 5분 늦는다고 하셨어요"]);
    const said = h.app.core.meet.utterances(h.app.core.meet.active(userId)!.id).filter((u) => u.role === "said");
    expect(said.map((u) => u.speaker)).toEqual(["깽이"]);
  });
});

// ───────────────────────────── the whole meeting ─────────────────────────────

describe("meeting flow", () => {
  test("SSE → transcript stored → wake word answered sentence by sentence → barge-in → end → minutes + summary", async () => {
    const { h, bot, userId } = await setup();
    const logs = captureLogs(h);
    const chat = scriptChat(h, bot);

    const threadId = await joinAndEnter(h, bot, userId);
    const join = bot.calls.find((c) => c.method === "POST" && c.path === "/sessions")!;
    expect(join.body).toMatchObject({ url: `https://meet.google.com/${CODE}`, name: "깽이", sttPrompt: "깽이야, 지금 회의 내용 좀 정리해 줄래?" });
    expect(String(join.body?.announce)).toBe(
      "안녕하세요, 하늘님의 AI 비서 깽이예요. 회의 내용을 받아 적고 있어요. 저를 부르시려면 '깽이야'라고 불러 주세요.",
    );
    const thread = h.db.sql.query(`SELECT kind, title, icon FROM threads WHERE id = ?`).get(threadId);
    expect(thread).toEqual({ kind: "call", title: "회의 참여", icon: "people" });

    bot.push("participants", { count: 4 });
    bot.push("transcript", { seq: 1, text: "출시 일정은 금요일로 하죠.", startMs: 1000, endMs: 2500, speaker: "지민" });
    bot.push("transcript", { seq: 2, text: "모시야, 다음 회의는 언제야?", startMs: 3000, endMs: 4200, speaker: "도윤" });
    await until(() => bot.says.length >= 3, 3000, "ack and two sentences said");
    await h.app.core.idle();

    // streamed: the first sentence was sent to the bot before the model produced the rest
    expect(chat.state.firstSpokenBeforeRest).toBe(true);
    // an instant cached "네," first, then the answer without a second "네"
    expect(bot.says).toEqual(["네,", "다음 회의는 금요일 오후 3시예요.", "장소는 3층 회의실이에요."]);
    const sayBodies = bot.calls.filter((c) => c.path === "/sessions/s1/say").map((c) => c.body);
    expect(sayBodies[0]).toEqual({ text: "네,", cached: true });
    expect(sayBodies[1]).toEqual({ text: "다음 회의는 금요일 오후 3시예요." });
    const reply = chat.calls[0]!;
    expect(reply.system).toContain("1~2문장");
    expect(reply.user).toContain("지민: 출시 일정은 금요일로 하죠.");
    expect(reply.user).toContain('방금 도윤님이 부른 말: "모시야, 다음 회의는 언제야?"');
    expect(reply.user).toContain("회의 목적: 주간 회의 받아 적기");

    const meetingId = h.db.sql.query(`SELECT id FROM meetings WHERE user_id = ?`).get(userId) as { id: string };
    const stored = h.app.core.meet.utterances(meetingId.id);
    expect(stored.map((u) => [u.role, u.speaker, u.text])).toEqual([
      ["heard", "지민", "출시 일정은 금요일로 하죠."],
      ["heard", "도윤", "모시야, 다음 회의는 언제야?"],
      ["said", "깽이", "다음 회의는 금요일 오후 3시예요."],
      ["said", "깽이", "장소는 3층 회의실이에요."],
    ]);
    expect(h.db.sql.query(`SELECT participants, last_seq FROM meetings WHERE id = ?`).get(meetingId.id)).toEqual({ participants: 4, last_seq: 2 });

    // barge-in only while speaking
    bot.push("transcript", { seq: 3, text: "잠깐만요", startMs: 5000, endMs: 5400, speaker: "지민" });
    await Bun.sleep(30);
    expect(bot.stops).toBe(0);
    bot.push("speaking", { on: true, sayId: "say9" });
    bot.push("transcript", { seq: 4, text: "모시 그만", startMs: 6000, endMs: 6400, speaker: "지민" });
    await until(() => bot.stops === 1, 2000, "say/stop");
    expect(chat.calls.length).toBe(1); // "모시 그만" is not a question
    bot.push("speaking", { on: false, sayId: "say9" });

    // the meeting ends → minutes, end note, summary
    bot.push("ended", { reason: "meeting_ended" });
    await until(() => h.app.core.meet.active(userId) === null, 2000, "finished");
    await h.app.core.idle();
    const rows = threadRows(h, threadId);
    const texts = rows.map((r) => r.text);
    expect(texts[0]).toContain(`Google Meet 회의(${maskMeetCode(CODE)})에 참여하러 갈게요.`);
    expect(texts.join("\n")).not.toContain(CODE); // no stored text carries the full code
    expect(texts).toContain("참여 요청을 보냈어요. 호스트가 수락하면 들어가요.");
    expect(texts.some((t) => t.startsWith("회의에 들어왔어요.") && t.includes("'깽이야'"))).toBe(true);
    const minutes = rows.find((r) => r.text.startsWith("**회의록 · 11월 11일(수) 12:00**"))!;
    expect(minutes.role).toBe("assistant");
    expect(minutes.text).toContain("- 지민: 출시 일정은 금요일로 하죠.");
    expect(minutes.text).toContain("- 깽이: 다음 회의는 금요일 오후 3시예요.");
    expect(JSON.parse(minutes.llm_json!)[0].content).toStartWith("(회의록 11월 11일(수) 12:00)\n지민: 출시 일정은 금요일로 하죠.");
    expect(texts).toContain("회의가 끝나서 나왔어요.");
    const summary = rows[rows.length - 1]!;
    expect(summary.role).toBe("assistant");
    expect(summary.text).toStartWith("**회의 요약**");
    expect(summary.text).toContain("지민: 디자인 시안");
    expect(chat.calls[1]!.user).toContain("도윤: 모시야, 다음 회의는 언제야?");
    expect(h.db.sql.query(`SELECT state, reason FROM meetings WHERE id = ?`).get(meetingId.id)).toEqual({ state: "ended", reason: "meeting_ended" });
    // model usage counts toward the daily quota
    const used = h.db.sql.query(`SELECT SUM(tokens) AS n FROM usage WHERE user_id = ?`).get(userId) as { n: number } | null;
    expect(used?.n ?? 0).toBe(620);

    // logs: masked code only — no transcript text, names or the full code
    const all = logs.join("\n");
    expect(all).toContain("abc-****-hij");
    for (const secret of [CODE, "지민", "도윤", "출시 일정", "다음 회의", "회의실", "하늘", "깽이야"]) expect(all).not.toContain(secret);
    expect(all).toContain("meet reply");
  });

  test("a misheard call at the start is answered; time talk and STT prompt echoes are not", async () => {
    const { h, bot, userId } = await setup();
    const logs = captureLogs(h);
    const chat = scriptChat(h, bot);
    await joinAndEnter(h, bot, userId);
    const id = h.app.core.meet.active(userId)!.id;
    bot.push("transcript", { seq: 1, text: "회의는 5시야", startMs: 0, endMs: 900, speaker: null });
    bot.push("transcript", { seq: 2, text: "깽이야, 지금 회의 내용 좀 정리해 줄래?", startMs: 1000, endMs: 1900, speaker: null }); // the prompt, echoed
    bot.push("transcript", { seq: 3, text: "5시야.", startMs: 2000, endMs: 2400, speaker: null });
    await until(() => h.app.core.meet.utterances(id).length === 2, 2000, "two stored lines");
    await Bun.sleep(30);
    expect(chat.calls.length).toBe(0);
    expect(h.app.core.meet.utterances(id).map((u) => u.text)).toEqual(["회의는 5시야", "5시야."]);
    expect(h.app.core.meet.active(userId)!.last_seq).toBe(3);
    bot.push("transcript", { seq: 4, text: "갱이야, 다음 회의 언제야?", startMs: 3000, endMs: 4000, speaker: null });
    await until(() => bot.says.length >= 3, 3000, "answer to a misheard call");
    await h.app.core.idle();
    expect(chat.calls.length).toBe(1);
    expect(h.app.core.meet.active(userId)!.last_seq).toBe(4);
    expect(logs.join("\n")).not.toContain("정리해 줄래");
  });

  test("a dropped stream reconnects with ?since and replays are not stored twice; a lost session closes the meeting", async () => {
    const { h, bot, userId } = await setup();
    scriptChat(h, bot);
    const threadId = await joinAndEnter(h, bot, userId);
    bot.push("transcript", { seq: 1, text: "첫 번째 안건부터 볼게요.", startMs: 0, endMs: 900, speaker: null });
    bot.push("transcript", { seq: 2, text: "네 좋아요.", startMs: 1000, endMs: 1500, speaker: null });
    const id = h.app.core.meet.active(userId)!.id;
    await until(() => h.app.core.meet.utterances(id).length === 2, 2000, "two lines");

    bot.drop();
    await until(() => bot.connects.length === 2, 3000, "reconnect");
    expect(bot.connects).toEqual([0, 2]);
    bot.push("transcript", { seq: 3, text: "두 번째 안건이요.", startMs: 2000, endMs: 2600, speaker: null });
    await until(() => h.app.core.meet.utterances(id).length === 3, 2000, "third line");
    await Bun.sleep(30);
    expect(h.app.core.meet.utterances(id).map((u) => u.text)).toEqual(["첫 번째 안건부터 볼게요.", "네 좋아요.", "두 번째 안건이요."]);

    // the bot restarted and forgot the session
    bot.lost = true;
    bot.drop();
    await until(() => h.app.core.meet.active(userId) === null, 3000, "lost");
    await h.app.core.idle();
    expect(h.db.sql.query(`SELECT state, reason FROM meetings WHERE id = ?`).get(id)).toEqual({ state: "ended", reason: "lost" });
    const texts = threadRows(h, threadId).map((r) => r.text);
    expect(texts).toContain("회의 참여 서비스와 연결이 끊겨서 회의를 마쳤어요.");
    expect(texts.some((t) => t.includes("- 참석자: 두 번째 안건이요."))).toBe(true);
    expect(texts[texts.length - 1]).toStartWith("**회의 요약**");
  });

  test("rejected or blocked joins end with a note and no summary", async () => {
    const { h, bot, userId } = await setup();
    const chat = scriptChat(h, bot);
    await tool(h, userId, "sys_join_meet").run({ url: CODE }, toolCtx(userId));
    await until(() => bot.connects.length > 0, 3000, "SSE connect");
    const threadId = h.app.core.meet.active(userId)!.thread_id;
    bot.push("state", { state: "waiting_admission" });
    bot.push("state", { state: "denied", reason: "admission_timeout" });
    await until(() => h.app.core.meet.active(userId) === null, 2000, "denied");
    await h.app.core.idle();
    const texts = threadRows(h, threadId).map((r) => r.text);
    expect(texts[texts.length - 1]).toBe("5분 동안 수락되지 않아서 참여 요청을 거뒀어요.");
    expect(chat.calls.length).toBe(0);
    expect(texts.some((t) => t.includes("요약"))).toBe(false);

    // only the closing `ended {reason:"error", state}` arrives (no state event before it)
    bot.state = "launching";
    const n = bot.connects.length;
    await tool(h, userId, "sys_join_meet").run({ url: CODE }, toolCtx(userId));
    await until(() => bot.connects.length > n, 3000, "second SSE connect");
    const second = h.app.core.meet.active(userId)!;
    bot.push("ended", { reason: "error", state: "blocked" });
    await until(() => h.app.core.meet.active(userId) === null, 2000, "blocked");
    expect(h.db.sql.query(`SELECT state FROM meetings WHERE id = ?`).get(second.id)).toEqual({ state: "blocked" });
    const last = threadRows(h, second.thread_id).map((r) => r.text);
    expect(last[last.length - 1]).toStartWith("이 회의에는 들어갈 수 없다고 나와요.");
  });

  test("after a restart, start() follows a meeting that is still running", async () => {
    const { h, bot, userId } = await setup();
    scriptChat(h, bot);
    await joinAndEnter(h, bot, userId);
    bot.push("transcript", { seq: 1, text: "하나", startMs: 0, endMs: 500, speaker: null });
    const id = h.app.core.meet.active(userId)!.id;
    await until(() => h.app.core.meet.utterances(id).length === 1, 2000, "line");

    await h.app.core.meet.close(); // what app.close() does; the bot keeps the meeting
    expect(h.app.core.meet.active(userId)?.state).toBe("in_call");
    const n = bot.connects.length;
    h.app.core.meet.start();
    await until(() => bot.connects.length === n + 1, 3000, "re-follow");
    expect(bot.connects[bot.connects.length - 1]).toBe(1);
    bot.push("transcript", { seq: 2, text: "둘", startMs: 600, endMs: 900, speaker: null });
    await until(() => h.app.core.meet.utterances(id).length === 2, 2000, "second line");
    bot.push("ended", { reason: "alone" });
    await until(() => h.app.core.meet.active(userId) === null, 2000, "ended");
    await h.app.core.idle();
  });
});

describe("real-time partials", () => {
  test("a call in a partial waits for the endpoint: 네, when the speaker stops, then exactly one answer", async () => {
    const { h, bot, userId } = await setup();
    const logs = captureLogs(h);
    const chat = scriptChat(h, bot);
    await joinAndEnter(h, bot, userId);
    bot.push("partial", { text: "모시야" });
    bot.push("partial", { text: "모시야 다음 회의는" });
    bot.push("partial", { text: "모시야 다음 회의는 언제" });
    await Bun.sleep(40);
    expect(bot.says).toEqual([]); // never over the speaker
    bot.push("endpoint", { seq: 1 });
    await until(() => bot.says.length === 1, 2000, "ack at the endpoint");
    expect(bot.says[0]).toBe("네,");
    expect(chat.calls.length).toBe(0); // the question isn't final yet
    bot.push("speaking", { on: true, sayId: "say1" });
    bot.push("transcript", { seq: 1, text: "모시야, 다음 회의는 언제야?", startMs: 0, endMs: 1500, speaker: null });
    await until(() => bot.says.length >= 3, 3000, "answer");
    await h.app.core.idle();
    expect(bot.says).toEqual(["네,", "다음 회의는 금요일 오후 3시예요.", "장소는 3층 회의실이에요."]);
    expect(chat.calls.length).toBe(1);
    expect(bot.stops).toBe(0); // the "네," that is playing is not cut off by its own answer
    expect(logs.find((l) => l.includes("meet reply"))!).toContain('"ack":"endpoint"');

    // the next call gets its own ack, again only at its endpoint
    bot.push("speaking", { on: false, sayId: "say1" });
    bot.push("partial", { text: "모시야 그럼" });
    await Bun.sleep(30);
    expect(bot.says.length).toBe(3);
    bot.push("endpoint", { seq: 2 });
    await until(() => bot.says.length === 4, 2000, "second ack");
    expect(bot.says[3]).toBe("네,");
  });

  test("no endpoint (local STT): 네, at the transcript; an endpoint without a transcript is skipped by seq", async () => {
    const { h, bot, userId } = await setup();
    const logs = captureLogs(h);
    const chat = scriptChat(h, bot);
    await joinAndEnter(h, bot, userId);
    // endpoint 1 with a call in its partials, but its transcript never comes (no final text)
    bot.push("partial", { text: "모시야" });
    bot.push("endpoint", { seq: 1 });
    await until(() => bot.says.length === 1, 2000, "ack");
    // utterance 2: endpoint 2 then transcript 2 (no partials, like the local path)
    bot.push("endpoint", { seq: 2 });
    bot.push("transcript", { seq: 2, text: "모시야, 다음 회의는 언제야?", startMs: 0, endMs: 1500, speaker: null });
    await until(() => bot.says.length >= 4, 3000, "answer");
    await h.app.core.idle();
    expect(bot.says).toEqual(["네,", "네,", "다음 회의는 금요일 오후 3시예요.", "장소는 3층 회의실이에요."]);
    expect(chat.calls.length).toBe(1);
    expect(logs.some((l) => l.includes("meet ack without transcript") && l.includes('"seq":1'))).toBe(true);
    expect(logs.find((l) => l.includes("meet reply"))!).toContain('"ack":"transcript"');
  });

  test("a partial call revised away by the final transcript: 네, but no answer, and it's logged", async () => {
    const { h, bot, userId } = await setup();
    const logs = captureLogs(h);
    const chat = scriptChat(h, bot);
    await joinAndEnter(h, bot, userId);
    bot.push("partial", { text: "무시아 그거" }); // fuzzy at the start, a clause follows
    bot.push("endpoint", { seq: 1 });
    await until(() => bot.says.length === 1, 2000, "ack");
    bot.push("transcript", { seq: 1, text: "무시하고 그거 넘어가죠", startMs: 0, endMs: 1200, speaker: null });
    const id = h.app.core.meet.active(userId)!.id;
    await until(() => h.app.core.meet.utterances(id).length === 1, 2000, "stored");
    await Bun.sleep(30);
    await h.app.core.idle();
    expect(bot.says).toEqual(["네,"]);
    expect(chat.calls.length).toBe(0);
    expect(logs.some((l) => l.includes("meet partial wake revised"))).toBe(true);
    // no ack for partials that aren't calls
    bot.push("partial", { text: "회의는 5시야" });
    bot.push("partial", { text: "5시야." });
    bot.push("endpoint", { seq: 2 });
    await Bun.sleep(40);
    expect(bot.says.length).toBe(1);
  });

  test("a bare call (\"모시야.\" then a pause): 네, then the next transcript is the question", async () => {
    const { h, bot, userId } = await setup();
    const chat = scriptChat(h, bot);
    await joinAndEnter(h, bot, userId);
    bot.push("partial", { text: "모시야" });
    bot.push("endpoint", { seq: 1 });
    bot.push("transcript", { seq: 1, text: "모시야.", startMs: 0, endMs: 500, speaker: null });
    await until(() => bot.says.length === 1, 2000, "ack");
    await Bun.sleep(30);
    expect(chat.calls.length).toBe(0); // nothing asked yet
    bot.push("partial", { text: "다음 회의는" });
    bot.push("endpoint", { seq: 2 });
    bot.push("transcript", { seq: 2, text: "다음 회의는 언제야?", startMs: 900, endMs: 2000, speaker: null });
    await until(() => bot.says.length >= 3, 3000, "answer");
    await h.app.core.idle();
    expect(bot.says).toEqual(["네,", "다음 회의는 금요일 오후 3시예요.", "장소는 3층 회의실이에요."]); // one 네,
    expect(chat.calls.length).toBe(1);
    expect(chat.calls[0]!.user).toContain('"모시야. 다음 회의는 언제야?"');
    // after that, a plain line is not a question any more
    bot.push("transcript", { seq: 3, text: "그럼 금요일에 봬요.", startMs: 2500, endMs: 3000, speaker: null });
    await Bun.sleep(50);
    expect(chat.calls.length).toBe(1);
  });

  test("a bare call with nothing after it: 네, then 말씀하세요 after the wait", async () => {
    const { h, bot, userId } = await setup();
    const logs = captureLogs(h);
    const chat = scriptChat(h, bot);
    h.app.core.meet.timings.callFollowMs = 60;
    await joinAndEnter(h, bot, userId);
    bot.push("endpoint", { seq: 1 });
    bot.push("transcript", { seq: 1, text: "모시님?", startMs: 0, endMs: 400, speaker: null }); // no partials: ack at the transcript
    await until(() => bot.says.length === 2, 2000, "말씀하세요");
    expect(bot.says).toEqual(["네,", "말씀하세요."]);
    expect(chat.calls.length).toBe(0);
    expect(logs.some((l) => l.includes("meet call alone"))).toBe(true);
    // "모시야 그만" right after a bare call is not its question
    bot.push("transcript", { seq: 2, text: "모시야.", startMs: 500, endMs: 900, speaker: null });
    await until(() => bot.says.length === 3, 2000, "ack 2");
    bot.push("transcript", { seq: 3, text: "모시 그만", startMs: 1000, endMs: 1400, speaker: null });
    await Bun.sleep(120);
    expect(bot.says.length).toBe(3);
    expect(chat.calls.length).toBe(0);
  });

  test("barge-in on a partial stops speech mid-utterance, once; the final neither stops again nor answers", async () => {
    const { h, bot, userId } = await setup();
    const logs = captureLogs(h);
    const chat = scriptChat(h, bot);
    await joinAndEnter(h, bot, userId);
    bot.push("speaking", { on: true, sayId: "say7" });
    bot.push("partial", { text: "모시 그만" });
    await until(() => bot.stops === 1, 2000, "stop on a partial");
    bot.push("partial", { text: "모시 그만해" });
    bot.push("speaking", { on: false, sayId: "say7" });
    bot.push("transcript", { seq: 1, text: "모시 그만해", startMs: 0, endMs: 800, speaker: null });
    const id = h.app.core.meet.active(userId)!.id;
    await until(() => h.app.core.meet.utterances(id).length === 1, 2000, "stored");
    await Bun.sleep(30);
    await h.app.core.idle();
    expect(bot.stops).toBe(1);
    expect(bot.says).toEqual([]);
    expect(chat.calls.length).toBe(0);
    expect(logs.some((l) => l.includes("meet barge-in") && l.includes('"on":"partial"'))).toBe(true);
    // "모시 그만" while silent is not a question either
    bot.push("transcript", { seq: 2, text: "모시 그만", startMs: 900, endMs: 1300, speaker: null });
    await until(() => h.app.core.meet.utterances(id).length === 2, 2000, "stored 2");
    await Bun.sleep(30);
    expect(chat.calls.length).toBe(0);
    expect(logs.join("\n")).not.toContain("그만");
  });
});

// ───────────────────────────── conversation mode ─────────────────────────────

/** one sentence per answer, after `delayMs` */
function simpleChat(h: Harness, delayMs = 0) {
  const calls: ChatRequest[] = [];
  h.app.core.deps.llm!.chat = async function* (i: ChatRequest) {
    if (i.system.includes("회의 요약")) {
      yield "요약이에요.";
      return;
    }
    calls.push(i);
    if (delayMs) await Bun.sleep(delayMs);
    yield `대답 ${calls.length}번이에요.`;
  };
  return calls;
}

/** a stubbed addressee check: the verdict per utterance (default "other") */
function stubAddressee(h: Harness, verdicts: Record<string, Addressee>) {
  const calls: AddresseeInput[] = [];
  h.app.core.deps.llm!.addressee = async (i) => {
    calls.push(i);
    return { verdict: verdicts[i.utterance] ?? "other", p: null, ms: 1, backend: "chat", tokens: 0 };
  };
  return calls;
}

const line = (bot: FakeBot, seq: number, text: string, speaker: string | null = null) =>
  bot.push("transcript", { seq, text, startMs: seq * 1000, endMs: seq * 1000 + 600, speaker });

async function inConversation(h: Harness, bot: FakeBot, userId: string, chat: ChatRequest[]) {
  await joinAndEnter(h, bot, userId);
  const id = h.app.core.meet.active(userId)!.id;
  line(bot, 1, "모시야, 다음 회의 언제야?", "하은");
  await until(() => chat.length === 1 && bot.says.length === 2, 3000, "first answer");
  await h.app.core.idle();
  expect(h.app.core.meet.mode(id)).toBe("conversation");
  return id;
}

describe("conversation mode", () => {
  test("a call starts a conversation: follow-ups without the name are answered; the mode note shows once", async () => {
    const { h, bot, userId } = await setup();
    const logs = captureLogs(h);
    const chat = simpleChat(h);
    const asked = stubAddressee(h, { "그럼 장소는 어디야?": "addressed", "몇 시까지야?": "addressed" });
    const id = await joinAndEnter(h, bot, userId).then(() => h.app.core.meet.active(userId)!.id);
    expect(h.app.core.meet.mode(id)).toBe("listening");
    // listening: an unnamed question is not even checked
    line(bot, 1, "그럼 장소는 어디야?", "하은");
    await Bun.sleep(40);
    expect(asked.length).toBe(0);
    expect(chat.length).toBe(0);

    line(bot, 2, "모시야, 다음 회의 언제야?", "하은");
    await until(() => bot.says.length === 2, 3000, "answer");
    expect(bot.says).toEqual([MEET_ACKS.yes, "대답 1번이에요."]);
    expect(h.app.core.meet.mode(id)).toBe("conversation");
    line(bot, 3, "그럼 장소는 어디야?", "하은");
    await until(() => bot.says.length === 4, 3000, "follow-up answer");
    line(bot, 4, "몇 시까지야?", "하은");
    await until(() => bot.says.length === 6, 3000, "second follow-up");
    await h.app.core.idle();
    expect(bot.says.slice(2)).toEqual([MEET_ACKS.yes, "대답 2번이에요.", MEET_ACKS.yes, "대답 3번이에요."]);
    expect(chat[1]!.user).toContain('방금 하은님이 너에게 이어서 한 말: "그럼 장소는 어디야?"');
    // the check saw the recent lines, without the line itself
    expect(asked[0]!.recent.at(-1)).toBe("깽이: 대답 1번이에요.");
    expect(asked[0]!.speaker).toBe("하은");
    const notes = threadRows(h, h.app.core.meet.active(userId)!.thread_id).map((r) => r.text);
    expect(notes.filter((t) => t.includes("대화에 들어왔어요")).length).toBe(1);
    expect(logs.some((l) => l.includes("meet mode") && l.includes('"from":"listening"') && l.includes('"reason":"wake"'))).toBe(true);
    expect(logs.some((l) => l.includes("meet addressee") && l.includes('"verdict":"addressed"'))).toBe(true);
    expect(logs.join("\n")).not.toContain("장소는");
  });

  test("cross-talk gets no answer: '민수님, …' skips the check, a statement isn't answered even as 'addressed', fillers never reach it; head counts don't matter", async () => {
    const { h, bot, userId } = await setup();
    const logs = captureLogs(h);
    const chat = simpleChat(h);
    const asked = stubAddressee(h, {
      "민수님, QA 일정 조정 가능하세요?": "addressed",
      "그럼 수요일로 확정하는 걸로 할게요.": "addressed", // the classifier leaning wrong: the statement gate holds
      "QA 일정은 누가 맡아?": "other",
      "그거 누가 맡아?": "addressed",
    });
    await inConversation(h, bot, userId, chat);
    bot.push("participants", { count: 5 });
    line(bot, 2, "민수님, QA 일정 조정 가능하세요?", "하은");
    line(bot, 3, "그럼 수요일로 확정하는 걸로 할게요.", "하은");
    line(bot, 4, "QA 일정은 누가 맡아?", "하은");
    for (const [i, t] of ["음", "네네", "그렇구나."].entries()) line(bot, 5 + i, t, "민수");
    await until(() => asked.length === 2, 2000, "two checks");
    await Bun.sleep(40);
    await h.app.core.idle();
    expect(asked.map((a) => a.utterance)).toEqual(["그럼 수요일로 확정하는 걸로 할게요.", "QA 일정은 누가 맡아?"]);
    expect(chat.length).toBe(1);
    const verdicts = logs.filter((l) => l.includes("meet addressee"));
    expect(verdicts[0]).toContain('"backend":"rule"');
    expect(verdicts[1]).toContain('"gate":"statement"');
    expect(verdicts.every((l) => l.includes('"verdict":"other"'))).toBe(true);
    bot.push("participants", { count: 2 });
    line(bot, 8, "그거 누가 맡아?", "하은");
    await until(() => chat.length === 2, 2000, "answered");
  });

  test("the check reads the conversation since the latest call, not the talk before it", async () => {
    const { h, bot, userId } = await setup();
    const chat = simpleChat(h);
    const asked = stubAddressee(h, { "그럼 장소는 어디야?": "addressed" });
    await joinAndEnter(h, bot, userId);
    line(bot, 1, "출시는 다음 주 수요일로 하죠.", "민수");
    await until(() => h.app.core.meet.utterances(h.app.core.meet.active(userId)!.id).length === 1, 2000, "line stored");
    h.clock.t += 5_000;
    line(bot, 2, "모시야, 다음 회의 언제야?", "하은");
    await until(() => chat.length === 1 && bot.says.length === 2, 3000, "answer");
    h.clock.t += 5_000;
    line(bot, 3, "그럼 장소는 어디야?", "하은");
    await until(() => asked.length === 1, 2000, "check");
    expect(asked[0]!.recent).toEqual(["하은: 모시야, 다음 회의 언제야?", "깽이: 대답 1번이에요."]);
  });

  test("dismiss — by the check or by name — says 네, 듣고 있을게요. and listens; unnamed questions then go unanswered", async () => {
    const { h, bot, userId } = await setup();
    const logs = captureLogs(h);
    const chat = simpleChat(h);
    const asked = stubAddressee(h, { "고마워, 이제 됐어.": "dismiss", "그럼 장소는 어디야?": "addressed" });
    const id = await inConversation(h, bot, userId, chat);
    line(bot, 2, "고마워, 이제 됐어.", "하은");
    await until(() => bot.says.at(-1) === MEET_ACKS.listening, 2000, "listening line");
    expect(h.app.core.meet.mode(id)).toBe("listening");
    const n = asked.length;
    line(bot, 3, "그럼 장소는 어디야?", "하은");
    await Bun.sleep(50);
    expect(asked.length).toBe(n); // not even checked
    expect(chat.length).toBe(1);

    // by name: no check needed; it also stops speech in progress
    line(bot, 4, "모시야, 장소는 어디야?", "하은");
    await until(() => chat.length === 2, 2000, "called again");
    await until(() => bot.says.length === 5, 2000, "answer 2");
    bot.push("speaking", { on: true, sayId: "say5" });
    line(bot, 5, "모시야 이제 조용히 해", "하은");
    await until(() => bot.says.at(-1) === MEET_ACKS.listening && bot.says.filter((t) => t === MEET_ACKS.listening).length === 2, 2000, "dismiss by name");
    expect(bot.stops).toBeGreaterThanOrEqual(1);
    expect(h.app.core.meet.mode(id)).toBe("listening");
    expect(asked.map((a) => a.utterance)).not.toContain("모시야 이제 조용히 해");
    const modes = logs.filter((l) => l.includes("meet mode") && l.includes('"reason":"dismiss"'));
    expect(modes.length).toBe(2);
    const notes = threadRows(h, h.app.core.meet.active(userId)!.thread_id).map((r) => r.text);
    // notes come in pairs, rate-limited: the second conversation (within modeNoteMs) adds none
    expect(notes.filter((t) => t.includes("대화에 들어왔어요")).length).toBe(1);
    expect(notes.filter((t) => t === "다시 듣기만 할게요.").length).toBe(1);
  });

  test("90 s (here 80 ms) without a line for 모시 → listening, silently; a barge-in keeps the conversation", async () => {
    const { h, bot, userId } = await setup();
    const logs = captureLogs(h);
    const chat = simpleChat(h);
    const asked = stubAddressee(h, { "그럼 장소는 어디야?": "addressed", "몇 시야?": "addressed" });
    h.app.core.meet.timings.conversationIdleMs = 80;
    const id = await inConversation(h, bot, userId, chat);
    // barge-in: "모시 그만" while speaking stops it, the conversation goes on
    bot.push("speaking", { on: true, sayId: "say2" });
    line(bot, 2, "모시 그만", "하은");
    await until(() => bot.stops === 1, 2000, "stop");
    bot.push("speaking", { on: false, sayId: "say2" });
    expect(h.app.core.meet.mode(id)).toBe("conversation");
    line(bot, 3, "그럼 장소는 어디야?", "하은");
    await until(() => chat.length === 2, 2000, "follow-up after barge-in");
    await h.app.core.idle();
    const says = bot.says.length;
    await until(() => h.app.core.meet.mode(id) === "listening", 2000, "idle");
    expect(bot.says.length).toBe(says); // silently
    expect(logs.some((l) => l.includes("meet mode") && l.includes('"reason":"idle"'))).toBe(true);
    const n = asked.length;
    line(bot, 4, "몇 시야?", "하은");
    await Bun.sleep(50);
    expect(asked.length).toBe(n);
    expect(chat.length).toBe(2);
    // already listening, "모시야 이제 됐어" isn't a question for the model: just the confirmation, still listening
    line(bot, 5, "모시야 이제 됐어", "하은");
    await until(() => bot.says.at(-1) === MEET_ACKS.listening, 2000, "confirmation");
    await h.app.core.idle();
    expect(chat.length).toBe(2);
    expect(h.app.core.meet.mode(id)).toBe("listening");
  });

  test("the check starts at the endpoint on the last partial; the transcript reuses it when words and speaker match; no classifier → name needed", async () => {
    const { h, bot, userId } = await setup();
    const logs = captureLogs(h);
    const chat = simpleChat(h);
    const asked = stubAddressee(h, { "그럼 장소는 어디야": "addressed", "그럼 몇 시야": "addressed", "그럼 몇 시야?": "addressed" });
    await inConversation(h, bot, userId, chat);
    bot.push("partial", { text: "그럼 장소는" });
    bot.push("partial", { text: "그럼 장소는 어디야" });
    bot.push("endpoint", { seq: 2, speaker: "하은" });
    await until(() => asked.length === 1, 2000, "check at the endpoint");
    expect(asked[0]!.speaker).toBe("하은");
    line(bot, 2, "그럼 장소는 어디야?", "하은");
    await until(() => chat.length === 2, 2000, "answered");
    expect(asked.length).toBe(1);
    expect(logs.some((l) => l.includes("meet addressee") && l.includes('"reused":true'))).toBe(true);

    // the endpoint didn't know the speaker (the bot sends null), the transcript did: checked again with the speaker
    bot.push("partial", { text: "그럼 몇 시야" });
    bot.push("endpoint", { seq: 3, speaker: null });
    await until(() => asked.length === 2, 2000, "speculative check");
    expect(asked[1]!.speaker).toBeNull();
    line(bot, 3, "그럼 몇 시야?", "하은");
    await until(() => chat.length === 3, 2000, "answered after a re-check");
    expect(asked.length).toBe(3);
    expect(asked[2]!.speaker).toBe("하은");

    // without a classifier, conversation mode can't tell: unnamed lines aren't answered
    delete h.app.core.deps.llm!.addressee;
    line(bot, 4, "그럼 내일은 몇 시야?", "하은");
    await Bun.sleep(50);
    expect(chat.length).toBe(3);
  });

  test("an answer without a 네, yet: skipped when the first sentence is quick, said when it's slow", async () => {
    const { h, bot, userId } = await setup();
    const logs = captureLogs(h);
    h.app.core.meet.timings.ackGraceMs = 60;
    let delay = 0;
    const calls: ChatRequest[] = [];
    h.app.core.deps.llm!.chat = async function* (i: ChatRequest) {
      if (i.system.includes("회의 요약")) return;
      calls.push(i);
      if (delay) await Bun.sleep(delay);
      yield "네, 금요일 오후 3시예요.";
    };
    await joinAndEnter(h, bot, userId);
    line(bot, 1, "모시야, 다음 회의 언제야?");
    await until(() => bot.says.length === 1, 2000, "quick answer");
    await h.app.core.idle();
    expect(bot.says).toEqual(["네, 금요일 오후 3시예요."]); // no separate 네,, and the model's own 네 stays
    expect(logs.find((l) => l.includes("meet reply"))!).toContain('"ack":"skipped"');
    delay = 200;
    line(bot, 2, "모시야, 장소는 어디야?");
    await until(() => bot.says.length === 3, 2000, "slow answer");
    expect(bot.says.slice(1)).toEqual([MEET_ACKS.yes, "금요일 오후 3시예요."]);
  });
});

// ───────────────────────────── the meeting agent (meetAgent.ts) behind the calls ─────────────────────────────

interface AgentStep {
  text?: string[];
  calls?: string[];
  /** wait before the step's output */
  delayMs?: number;
  /** never finish (until aborted) */
  hang?: boolean;
}

/** deps.llm.meetClient stand-in: step i answers the i-th model call (the last step repeats) */
function fakeMeetClient(h: Harness, steps: AgentStep[]) {
  const reqs: LlmRequest[] = [];
  const wait = (ms: number, signal?: AbortSignal) =>
    new Promise<void>((res, rej) => {
      const t = setTimeout(res, ms);
      signal?.addEventListener("abort", () => (clearTimeout(t), rej(signal.reason)), { once: true });
    });
  h.app.core.deps.llm!.meetClient = {
    model: "fake-meet",
    async *stream(req: LlmRequest): AsyncGenerator<LlmChunk> {
      reqs.push(req);
      const st = steps[Math.min(reqs.length - 1, steps.length - 1)]!;
      if (st.delayMs) await wait(st.delayMs, req.signal);
      if (st.hang) await wait(60_000, req.signal);
      for (const d of st.text ?? []) yield { type: "text", delta: d };
      if (st.calls?.length)
        yield { type: "tool_calls", calls: st.calls.map((name, k) => ({ id: `c${reqs.length}_${k}`, type: "function" as const, function: { name, arguments: "{}" } })) };
      yield { type: "usage", usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 } };
    },
  } as never;
  return reqs;
}

const lastUser = (req: LlmRequest) => String([...req.messages].reverse().find((m) => m.role === "user")?.content ?? "");

describe("calls answered by the meeting agent", () => {
  test("a tool call after the 네, plays 찾아볼게요.; the answer's own 네 is dropped; usage counted once", async () => {
    const { h, bot, userId } = await setup();
    const logs = captureLogs(h);
    const reqs = fakeMeetClient(h, [{ calls: ["k_weather"] }, { text: ["네, 서울은 지금 14도에 흐려요."] }]);
    let chatCalls = 0;
    h.app.core.deps.llm!.chat = async function* () {
      chatCalls++;
      yield "쓰이면 안 돼요.";
    };
    await joinAndEnter(h, bot, userId);
    line(bot, 1, "모시야, 서울 날씨 어때?", "하은");
    await until(() => bot.says.length === 3, 3000, "answer");
    await h.app.core.idle();
    expect(bot.says).toEqual([MEET_ACKS.yes, MEET_ACKS.search, "서울은 지금 14도에 흐려요."]);
    expect(chatCalls).toBe(0);
    expect(lastUser(reqs[0]!)).toContain('방금 하은님이 부른 말: "모시야, 서울 날씨 어때?"');
    expect(lastUser(reqs[0]!)).toContain('"네,"라고 먼저 대답했어');
    const reply = logs.find((l) => l.includes("meet reply"))!;
    expect(reply).toContain('"path":"agent"');
    expect(reply).toContain('"tools":1');
    expect(reply).toContain('"filler":"search"');
    expect(logs.join("\n")).not.toContain("서울은");
    const usage = h.db.sql.query<{ tokens: number }, [string]>(`SELECT SUM(tokens) AS tokens FROM usage WHERE user_id = ?`).get(userId);
    expect(usage?.tokens ?? 0).toBeGreaterThan(0);
  });

  test("a tool call within the grace: 네, 잠시만요. stands in for the 네,", async () => {
    const { h, bot, userId } = await setup();
    const logs = captureLogs(h);
    h.app.core.meet.timings.ackGraceMs = 250;
    fakeMeetClient(h, [{ calls: ["k_weather"] }, { text: ["네, 14도예요."] }]);
    await joinAndEnter(h, bot, userId);
    line(bot, 1, "모시야, 서울 날씨 어때?", "하은");
    await until(() => bot.says.length === 2, 3000, "answer");
    await Bun.sleep(300); // past the grace: no late 네,
    await h.app.core.idle();
    expect(bot.says).toEqual([MEET_ACKS.wait, "14도예요."]);
    const reply = logs.find((l) => l.includes("meet reply"))!;
    expect(reply).toContain('"ack":"filler"');
    expect(reply).toContain('"filler":"wait"');
  });

  test("only a 네 with punctuation is dropped after the 네, clip: 네이버, 네 시, 네 명 stay (agent and plain paths)", async () => {
    const { h, bot, userId } = await setup();
    fakeMeetClient(h, [{ text: ["네이버 뉴스 1위는 출시 소식이에요."] }, { text: ["네 시에 다시 모여요."] }, { text: ["네. 금요일이에요."] }]);
    await joinAndEnter(h, bot, userId);
    line(bot, 1, "모시야, 뉴스 뭐 있어?", "하은");
    await until(() => bot.says.length === 2, 3000, "answer 1");
    line(bot, 2, "모시야, 몇 시에 다시 모여?", "하은");
    await until(() => bot.says.length === 4, 3000, "answer 2");
    line(bot, 3, "모시야, 무슨 요일이야?", "하은");
    await until(() => bot.says.length === 6, 3000, "answer 3");
    expect(bot.says.filter((t) => t !== MEET_ACKS.yes)).toEqual(["네이버 뉴스 1위는 출시 소식이에요.", "네 시에 다시 모여요.", "금요일이에요."]);
    // the plain path (no meetClient) strips the same way
    delete h.app.core.deps.llm!.meetClient;
    h.app.core.deps.llm!.chat = async function* () {
      yield "네 명이 참석했어요.";
    };
    line(bot, 4, "모시야, 몇 명 왔어?", "하은");
    await until(() => bot.says.length === 8, 3000, "plain answer");
    expect(bot.says.at(-1)).toBe("네 명이 참석했어요.");
  });

  test("a 네, and then a slow model: 잠시만요. once after stallMs; not when the answer is quick or a tool filler already spoke", async () => {
    const { h, bot, userId } = await setup();
    const logs = captureLogs(h);
    h.app.core.meet.timings.stallMs = 80;
    let delay = 250;
    h.app.core.deps.llm!.chat = async function* (i: ChatRequest) {
      if (i.system.includes("회의 요약")) return;
      await Bun.sleep(delay);
      yield "금요일 오후 3시예요.";
    };
    await joinAndEnter(h, bot, userId);
    // endpoint ack: the stall counts from that "네,"
    bot.push("partial", { text: "모시야 다음 회의 언제야" });
    bot.push("endpoint", { seq: 1, speaker: "하은" });
    await until(() => bot.says.length === 1, 2000, "endpoint ack");
    line(bot, 1, "모시야, 다음 회의 언제야?", "하은");
    await until(() => bot.says.length === 3, 3000, "slow answer");
    await h.app.core.idle();
    expect(bot.says).toEqual([MEET_ACKS.yes, MEET_ACKS.hold, "금요일 오후 3시예요."]);
    expect(logs.filter((l) => l.includes("meet reply")).at(-1)).toContain('"stall":1');
    // quick: no 잠시만요.
    delay = 0;
    line(bot, 2, "모시야, 장소는 어디야?", "하은");
    await until(() => bot.says.length === 5, 3000, "quick answer");
    await Bun.sleep(150);
    expect(bot.says.slice(3)).toEqual([MEET_ACKS.yes, "금요일 오후 3시예요."]);
    // a tool filler already spoke: no 잠시만요. while the tool runs
    fakeMeetClient(h, [{ calls: ["k_weather"] }, { text: ["14도예요."], delayMs: 250 }]);
    line(bot, 3, "모시야, 날씨 어때?", "하은");
    await until(() => bot.says.length === 8, 3000, "tool answer");
    await h.app.core.idle();
    expect(bot.says.slice(5)).toEqual([MEET_ACKS.yes, MEET_ACKS.search, "14도예요."]);
  });

  test("conversation follow-ups go to the agent too; 모시 그만 stops a turn still thinking and keeps the conversation", async () => {
    const { h, bot, userId } = await setup();
    const logs = captureLogs(h);
    stubAddressee(h, { "그럼 내일은?": "addressed" });
    const reqs = fakeMeetClient(h, [{ text: ["금요일 오후 3시예요."] }, { hang: true }]);
    await joinAndEnter(h, bot, userId);
    const id = h.app.core.meet.active(userId)!.id;
    line(bot, 1, "모시야, 다음 회의 언제야?", "하은");
    await until(() => bot.says.length === 2, 3000, "first answer");
    line(bot, 2, "그럼 내일은?", "하은");
    await until(() => reqs.length === 2, 3000, "follow-up turn");
    expect(lastUser(reqs[1]!)).toContain('방금 하은님이 너에게 이어서 한 말: "그럼 내일은?"');
    line(bot, 3, "모시 그만", "하은");
    await until(() => logs.some((l) => l.includes("meet reply") && l.includes('"kind":"followup"')), 3000, "stopped");
    await h.app.core.idle();
    expect(logs.find((l) => l.includes("meet reply") && l.includes('"kind":"followup"'))!).toContain('"outcome":"stopped"');
    expect(h.app.core.meet.mode(id)).toBe("conversation");
  });
});

describe("health", () => {
  test("/api/health reports meet and stt", async () => {
    const { h, bot } = await setup();
    const stt = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ ok: true, ready: true, model: "m", queue: 0 }) });
    try {
      h.app.core.cfg.stt = { url: `http://127.0.0.1:${stt.port}` };
      expect(await h.app.core.meet.probe()).toEqual({ meet: "ready", stt: "ready" });
      const body = (await (await h.req("GET", "/api/health")).json()) as Record<string, unknown>;
      expect(body.meet).toBe("ready");
      expect(body.stt).toBe("ready");
      bot.stop();
      expect((await h.app.core.meet.probe()).meet).toBe("missing");
      h.app.core.cfg.meet = null;
      h.app.core.cfg.stt = null;
      const off = (await (await h.req("GET", "/api/health")).json()) as Record<string, unknown>;
      expect([off.meet, off.stt]).toEqual(["off", "off"]);
    } finally {
      stt.stop(true);
    }
  });
});

// ───────────────────────────── meeting notes (sys_meet_notes, the prompt note) ─────────────────────────────

const MIN = 60_000;
let seedN = 0;

interface Seed {
  state?: string;
  lines?: { speaker: string | null; text: string; role?: "heard" | "said" }[];
  summary?: string | null;
  title?: string | null;
  purpose?: string;
  startedAt?: number;
  endedAt?: number | null;
}

/** 40 synthetic lines: 일정·담당·숫자 talk across three speakers and one answer by the agent */
function syntheticLines(n = 40): NonNullable<Seed["lines"]> {
  const speakers = ["지민", "민수", null];
  return Array.from({ length: n }, (_, i) =>
    i === 7
      ? { speaker: null, text: "다음 회의는 금요일 오후 3시예요.", role: "said" as const }
      : { speaker: speakers[i % 3]!, text: `안건 ${i + 1}번 얘기예요. 출시 일정은 다음 주 금요일로 잡을게요.` },
  );
}

/** A meeting the user already had: thread + meetings row + utterances (+ the end summary row, as meet.ts posts it). */
function seedMeeting(h: Harness, userId: string, o: Seed = {}): { id: string; threadId: string } {
  const n = ++seedN;
  const now = h.clock.now();
  const state = o.state ?? "ended";
  const active = ["launching", "prejoin", "waiting_admission", "in_call"].includes(state);
  const joined = ["ended", "in_call"].includes(state);
  const started = o.startedAt ?? now - 40 * MIN;
  const ended = o.endedAt !== undefined ? o.endedAt : active ? null : started + 33 * MIN;
  const threadId = `t_seed${n}`;
  h.db.createThread({ id: threadId, ownerId: userId, kind: "call", title: "회의 참여", subtitle: "깽이의 회의 참여", icon: "people", now: started }, [userId]);
  const id = `mt_seed${n}`;
  h.db.sql
    .query(
      `INSERT INTO meetings (id, user_id, thread_id, session_id, code, purpose, state, reason, participants, started_at, joined_at, ended_at, title)
       VALUES (?, ?, ?, 's1', ?, ?, ?, ?, 4, ?, ?, ?, ?)`,
    )
    .run(id, userId, threadId, CODE, o.purpose ?? "", state, active ? null : state, started, joined ? started + MIN : null, ended, o.title ?? null);
  const lines = o.lines ?? (joined ? syntheticLines() : []);
  lines.forEach((l, i) =>
    h.db.sql
      .query(`INSERT INTO meet_utterances (meeting_id, seq, speaker, text, at, role) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(id, i + 1, l.speaker, l.text, started + MIN + i * 45_000, l.role ?? "heard"),
  );
  const summary = o.summary === undefined ? (joined && !active ? "출시 일정을 다음 주 금요일로 정했어요.\n\n**할 일**\n- 지민: 시안" : null) : o.summary;
  if (summary) {
    const text = `**회의 요약**\n\n${summary}`;
    h.db.insertMessage({ id: `m_seed${n}`, threadId, role: "assistant", text, createdAt: ended ?? now, llm: [{ role: "assistant", content: text }] });
  }
  return { id, threadId };
}

const notesData = (r: { data?: unknown }) => r.data as Record<string, unknown> & { meeting: Record<string, unknown>; recent: Record<string, unknown>[] };

describe("meeting notes", () => {
  test("sys_meet_notes is offered once the user has a meeting, in every thread of theirs, never in friend threads", async () => {
    const { h, userId } = await setup();
    const kinds = ["main", "task", "call", "schedule"] as const;
    for (const k of kinds) expect(names(buildTools(h.app.core, k, undefined, "on", userId))).not.toContain("sys_meet_notes");
    seedMeeting(h, userId, { state: "failed", lines: [] }); // even a failed join counts: the model can say so
    for (const k of kinds) expect(names(buildTools(h.app.core, k, undefined, "on", userId))).toContain("sys_meet_notes");
    expect(names(buildTools(h.app.core, "friend", undefined, "on", userId))).not.toContain("sys_meet_notes");
    // an ended meeting doesn't bring back say/leave; another user sees nothing
    const tools = names(buildTools(h.app.core, "main", undefined, "on", userId));
    expect(tools).not.toContain("sys_meet_say");
    expect(tools).not.toContain("sys_leave_meet");
    const other = await h.signup("other");
    expect(names(buildTools(h.app.core, "main", undefined, "on", other.session.user.id))).not.toContain("sys_meet_notes");
  });

  test("notes: the latest meeting with content, summary + transcript lines, scrubbed, owner only", async () => {
    const { h, userId } = await setup();
    const lines = syntheticLines();
    lines[3] = { speaker: "민수", text: "제 번호는 010-1234-5678이고 비밀번호는 abcd1234예요." };
    const a = seedMeeting(h, userId, { purpose: "relay daily", lines, startedAt: h.clock.now() - 90 * MIN });
    seedMeeting(h, userId, { state: "denied", startedAt: h.clock.now() - 10 * MIN }); // newer, but nothing written down
    const notesTool = tool(h, userId, "sys_meet_notes");
    expect(notesTool.title({})).toBe("회의 내용 보기");

    const r = await notesTool.run({}, toolCtx(userId));
    expect(r.ok).toBe(true);
    const d = notesData(r);
    expect(d.now).toBe("2026년 11월 11일(수) 12:00 (한국 시간)");
    expect(d.meeting).toMatchObject({ id: a.id, title: "relay daily", state: "끝남", started: "오늘 11월 11일(수) 10:30", joined: "오늘 11월 11일(수) 10:31", ended: "오늘 11월 11일(수) 11:03", participants: 4, lines: 40, hasSummary: true });
    expect(r.summary).toBe("'relay daily' 회의 내용 (40줄, 요약 있음)");
    expect(d.summary).toBe("출시 일정을 다음 주 금요일로 정했어요.\n\n**할 일**\n- 지민: 시안");
    const transcript = String(d.transcript).split("\n");
    expect(transcript).toHaveLength(40);
    expect(transcript[0]).toBe("[10:31] 지민: 안건 1번 얘기예요. 출시 일정은 다음 주 금요일로 잡을게요.");
    expect(transcript[2]).toStartWith("[10:32] 참석자: ");
    expect(transcript[7]).toBe("[10:36] 깽이: 다음 회의는 금요일 오후 3시예요.");
    expect(transcript[3]).toContain("[전화번호]");
    expect(transcript[3]).not.toContain("5678");
    expect(transcript[3]).not.toContain("abcd1234");
    expect(JSON.stringify(r)).not.toContain(CODE);
    expect(d.recent.map((m) => m.state)).toEqual(["참여 거절됨", "끝남"]);
    expect(String(d.hint)).toContain("sys_create_artifact");
    expect(String(d.hint)).toContain("회의한 날(11월 11일(수)) 기준"); // "내일" in the meeting is relative to that day

    // part: summary only / transcript only
    const s = notesData(await notesTool.run({ part: "summary" }, toolCtx(userId)));
    expect(s.summary).toBeDefined();
    expect(s.transcript).toBeUndefined();
    const t = notesData(await notesTool.run({ meeting: "latest", part: "transcript" }, toolCtx(userId)));
    expect(t.summary).toBeUndefined();
    expect(t.transcript).toBeDefined();

    // a join that never got in, by id: says so; title falls back to the masked code
    const denied = d.recent[0]!.id as string;
    const dn = await notesTool.run({ meeting: denied }, toolCtx(userId));
    expect(notesData(dn).meeting.title).toBe("Google Meet abc-****-hij");
    expect(String(notesData(dn).note)).toContain("들어가지 못해서(참여 거절됨)");

    // owner only
    const other = await h.signup("other");
    const otherId = other.session.user.id;
    expect(meetingNotes(h.app.core, otherId, {})).toMatchObject({ ok: false, data: { error: "no_meetings" } });
    seedMeeting(h, otherId);
    const stolen = meetingNotes(h.app.core, otherId, { meeting: a.id });
    expect(stolen).toMatchObject({ ok: false, data: { error: "unknown_meeting" } });
    expect(JSON.stringify(stolen)).not.toContain("relay daily");
  });

  test("notes: a running meeting gives what was written so far; no summary → the transcript even for part=summary", async () => {
    const { h, userId } = await setup();
    seedMeeting(h, userId, { state: "in_call", lines: syntheticLines(5), title: "주간 회의" });
    const r = notesData(await tool(h, userId, "sys_meet_notes").run({ part: "summary" }, toolCtx(userId)));
    expect(r.meeting).toMatchObject({ title: "주간 회의", state: "진행 중", hasSummary: false, lines: 5 });
    expect(String(r.transcript).split("\n")).toHaveLength(5);
    expect(String(r.note)).toContain("아직 진행 중");
  });

  test("a long transcript keeps the start and the end within 12k chars, with the gap marked", async () => {
    const at0 = Date.UTC(2026, 10, 11, 1, 0); // 10:00 KST
    const lines = Array.from({ length: 400 }, (_, i) => ({ at: at0 + i * 15_000, text: `[--:--] 참석자: ${String(i).padStart(3, "0")} ${"가".repeat(55)}` }));
    const { text, omitted } = capTranscript(lines);
    expect(text.length).toBeLessThanOrEqual(12_000);
    const out = text.split("\n");
    expect(out[0]).toBe(lines[0]!.text);
    expect(out.at(-1)).toBe(lines[399]!.text);
    const marker = out.find((l) => l.startsWith("…(중략"))!;
    expect(marker).toMatch(/^…\(중략: \d+줄, \d\d:\d\d–\d\d:\d\d\)…$/);
    expect(Number(marker.match(/(\d+)줄/)![1])).toBe(omitted);
    expect(out.length - 1 + omitted).toBe(400);
    // the head is about a third, the tail the rest
    const head = out.indexOf(marker);
    expect(head).toBeGreaterThan(40);
    expect(out.length - head - 1).toBeGreaterThan(head);
    // short transcripts pass untouched
    expect(capTranscript(lines.slice(0, 10))).toEqual({ text: lines.slice(0, 10).map((l) => l.text).join("\n"), omitted: 0 });

    // through the tool
    const s = await setup();
    seedMeeting(s.h, s.userId, { lines: Array.from({ length: 400 }, (_, i) => ({ speaker: "지민", text: `${i}번째 발언 ${"나".repeat(50)}` })) });
    const d = notesData(meetingNotes(s.h.app.core, s.userId, { part: "transcript" }));
    expect(String(d.transcript).length).toBeLessThanOrEqual(12_000);
    expect(String(d.transcript)).toContain("0번째 발언");
    expect(String(d.transcript)).toContain("399번째 발언");
    expect(String(d.note)).toMatch(/가운데 \d+줄을 줄였어요/);
  });

  test("prompt note: one line per meeting running or finished in 24 h, then the rule; nothing before the first meeting", async () => {
    const { h, userId } = await setup();
    expect(meetPromptNote(h.app.core, userId)).toBe("");
    const now = h.clock.now(); // 12:00 KST
    seedMeeting(h, userId, { title: "지난주 회의", startedAt: now - 3 * 24 * 60 * MIN }); // too old for a line
    seedMeeting(h, userId, { title: "relay daily", startedAt: now - 43 * MIN, endedAt: now - 10 * MIN });
    seedMeeting(h, userId, { state: "failed", purpose: "고객 미팅", startedAt: now - 5 * MIN, endedAt: now - 5 * MIN });
    const note = meetPromptNote(h.app.core, userId).split("\n");
    expect(note[0]).toStartWith("# 회의");
    expect(note[1]).toStartWith("- 지금: 2026년 11월 11일(수) 12:00 (한국 시간).");
    expect(note.slice(2, 4)).toEqual([
      "- 회의 '고객 미팅' 참여 실패 오늘 11월 11일(수) 11:55",
      "- 회의 'relay daily' 끝남 오늘 11월 11일(수) 11:50 · 40줄 · 요약 있음 → 내용은 sys_meet_notes",
    ]);
    const rules = note.slice(4).join("\n");
    expect(rules).toContain("먼저 sys_meet_notes");
    expect(rules).toContain("sys_create_artifact");
    expect(rules).toContain("msg_*");
    expect(rules).toContain("sys_join_meet 결과는 참여를 시작한 순간의 상태");
    expect(note.join("\n")).not.toContain("지난주 회의");

    // a running one
    seedMeeting(h, userId, { state: "in_call", title: "주간 회의", lines: syntheticLines(3), startedAt: now - 3 * MIN });
    expect(meetPromptNote(h.app.core, userId)).toContain("- 회의 '주간 회의' 진행 중 (오늘 11월 11일(수) 11:58 참여) · 3줄 → 지금까지 내용은 sys_meet_notes");

    // a day later only the running one keeps a line; the rule stays while sys_meet_notes is offered
    h.clock.t += 25 * 60 * MIN;
    const later = meetPromptNote(h.app.core, userId);
    expect(later).not.toContain("relay daily");
    expect(later).toContain("'주간 회의' 진행 중 (어제 11월 11일(수) 11:58 참여)");
    expect(later).toContain("- 지금: 2026년 11월 12일(목) 13:00");
    expect(later).toContain("먼저 sys_meet_notes");
  });

  test("in a meeting's own thread: notes default to that meeting, and the prompt note says to read it first", async () => {
    const { h, userId } = await setup();
    const now = h.clock.now();
    const old = seedMeeting(h, userId, { title: "지난주 회의", startedAt: now - 3 * 24 * 60 * MIN });
    seedMeeting(h, userId, { title: "relay daily", startedAt: now - 43 * MIN, endedAt: now - 10 * MIN });
    const run = async (threadId: string) => notesData(await tool(h, userId, "sys_meet_notes").run({}, toolCtx(userId, { threadId })));
    expect((await run(old.threadId)).meeting.title).toBe("지난주 회의");
    expect((await run("t_main")).meeting.title).toBe("relay daily");

    const here = meetPromptNote(h.app.core, userId, old.threadId).split("\n");
    expect(here[2]).toStartWith("- 회의 '지난주 회의' 끝남 11월 8일(일) 12:33 · 40줄 · 요약 있음");
    expect(here[3]).toStartWith("- 회의 'relay daily' 끝남 오늘 11월 11일(수) 11:50");
    expect(here.join("\n")).toContain("지금 대화방은 위 첫 번째 회의('지난주 회의')의 '회의 참여' 대화방이에요");
    expect(here.join("\n")).toContain("답을 쓰기 전에 먼저 sys_meet_notes를 불러요");
    const main = meetPromptNote(h.app.core, userId, "t_main");
    expect(main).not.toContain("지난주 회의");
    expect(main).not.toContain("지금 대화방은");
  });

  test("turns in the user's own threads carry the note and the tool; join's result points at sys_meet_notes; the Meet title is kept", async () => {
    const { h, bot, userId, token, mainThreadId } = await setup();
    h.turns.set(async () => outcome("네"));
    await readSse(await h.req("POST", `/api/threads/${mainThreadId}/messages`, { token, body: { text: "안녕" } }));
    expect(h.turns.inputs.at(-1)!.system).not.toContain("# 회의");

    bot.title = "relay daily";
    h.app.core.meet.timings.flushMs = 20;
    const r = await tool(h, userId, "sys_join_meet").run({ url: URL_IN }, toolCtx(userId));
    expect(String((r.data as { hint: string }).hint)).toContain("백그라운드");
    expect(String((r.data as { hint: string }).hint)).toContain("sys_meet_notes");
    await until(() => bot.connects.length > 0, 3000, "SSE connect");
    bot.push("state", { state: "in_call" });
    await until(() => (h.app.core.meet.active(userId)?.title ?? null) === "relay daily", 3000, "title stored");

    await readSse(await h.req("POST", `/api/threads/${mainThreadId}/messages`, { token, body: { text: "회의 어떻게 돼 가?" } }));
    const input = h.turns.inputs.at(-1)!;
    expect(input.system).toContain("- 회의 'relay daily' 진행 중 (오늘 11월 11일(수) 12:00 참여) → 지금까지 내용은 sys_meet_notes");
    expect(input.tools.map((t) => t.name)).toEqual(expect.arrayContaining(["sys_meet_notes", "sys_meet_say", "sys_leave_meet"]));
  });
});
