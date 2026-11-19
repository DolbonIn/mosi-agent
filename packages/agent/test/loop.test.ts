import { afterAll, beforeEach, expect, test } from "bun:test";
import type { AgentEvent } from "@pickle/protocol";
import { LlmClient, UpstreamError, createRunTurn, partialOutcome, repairHistory, systemTools, type LlmMessage, type ToolDef, type TurnInput, type TurnOutcome } from "../src/index.ts";
import { fakeCtx, fakeStore, startMockLlm } from "./mock-llm.ts";

const KEY = "sk-loop-SECRET-0123456789abcdefXYZ";
const mock = startMockLlm();
afterAll(() => mock.stop());

let log: string[] = [];
let sendRuns: Record<string, unknown>[] = [];
beforeEach(() => {
  mock.requests.length = 0;
  mock.script.length = 0;
  mock.fallback = { text: ["(no script)"] };
  log = [];
  sendRuns = [];
});

const llm = new LlmClient({ apiKey: KEY, baseUrl: mock.url, model: "deepseek/deepseek-v4.1-flash-eco" }, { retryDelayMs: 5 });
const runTurn = createRunTurn(llm);

const weather: ToolDef<{ city: string; delay?: number }> = {
  name: "k_weather",
  description: "Current weather for a Korean city",
  parameters: { type: "object", properties: { city: { type: "string" }, delay: { type: "number" } }, required: ["city"] },
  icon: "cloud",
  title: (a) => `${a.city} 날씨 확인`,
  async run(a) {
    log.push(`start:${a.city}`);
    await Bun.sleep(a.delay ?? 0);
    log.push(`end:${a.city}`);
    return {
      ok: true,
      summary: `${a.city} 14°, 흐림`,
      data: { city: a.city, tempC: 14, condition: "흐림" },
      card: { type: "weather", place: a.city, now: { tempC: 14, condition: "흐림", icon: "cloud" }, source: "기상청" },
    };
  },
};

const send: ToolDef<{ to: string; text: string }> = {
  name: "msg_send",
  description: "Send a message to someone",
  parameters: { type: "object", properties: { to: { type: "string" }, text: { type: "string" } }, required: ["to", "text"] },
  icon: "send",
  title: (a) => `${a.to}에게 보내기`,
  approval: (a) => ({ title: `${a.to}에게 '${a.text}'를 보낼까요?`, detail: a.text }),
  async run(a) {
    sendRuns.push(a);
    return { ok: true, summary: "보냈어요", data: { sent: true } };
  },
};

const kakao: ToolDef<{ chat: string }> = {
  name: "kakao_read",
  description: "Read KakaoTalk messages",
  parameters: { type: "object", properties: { chat: { type: "string" } }, required: ["chat"] },
  icon: "kakao",
  title: (a) => `${a.chat} 대화 읽기`,
  credential: async () => ({
    service: "kakaotalk",
    serviceName: "카카오톡",
    reason: "대화를 읽으려면 로그인이 필요해요",
    fields: [
      { key: "username", label: "아이디", type: "email" },
      { key: "password", label: "비밀번호", type: "password" },
    ],
  }),
  async run() {
    throw new Error("must not run without a credential");
  },
};

const big: ToolDef = {
  name: "big",
  description: "returns a lot",
  parameters: { type: "object", properties: {} },
  icon: "doc",
  title: () => "큰 결과",
  run: async () => ({ ok: true, summary: "많아요", data: { blob: "가".repeat(20_000) } }),
};

const boom: ToolDef = {
  name: "boom",
  description: "always throws",
  parameters: { type: "object", properties: {} },
  icon: "bolt",
  title: () => "폭발",
  run: async () => {
    throw new Error("kaboom");
  },
};

const TOOLS = [weather, send, kakao, big, boom] as unknown as ToolDef[];

async function turn(over: Partial<TurnInput> = {}): Promise<{ events: AgentEvent[]; outcome: TurnOutcome }> {
  const events: AgentEvent[] = [];
  const outcome = await runTurn(
    { ctx: fakeCtx(), system: "SYS", history: [], userText: "질문", tools: TOOLS, ...over },
    (e) => events.push(e),
  );
  return { events, outcome };
}

const kinds = (events: AgentEvent[]) =>
  events.map((e) => (e.type === "tool" ? `tool:${e.tool.state}` : e.type === "status" ? `status:${e.text}` : e.type === "text" ? `text:${e.delta}` : e.type));

test("plain text streams through text events and becomes one assistant message", async () => {
  mock.script.push({ reasoning: ["(hidden reasoning)"], text: ["안녕", "하세요!"] });
  const { events, outcome } = await turn({ userText: "안녕" });
  expect(kinds(events)).toEqual(["status:생각하는 중", "text:안녕", "text:하세요!"]);
  expect(outcome.text).toBe("안녕하세요!");
  expect(outcome.text).not.toContain("hidden");
  expect(outcome.messages).toEqual([{ role: "assistant", content: "안녕하세요!" }]);
  expect(outcome.usage).toEqual({ promptTokens: 100, completionTokens: 20, totalTokens: 120 });
  expect(mock.requests[0]!.body.messages).toEqual([
    { role: "system", content: "SYS" },
    { role: "user", content: "안녕" },
  ]);
});

test("a tool call whose arguments stream for seconds shows its title as a status meanwhile (keeps the server's idle watchdog fed)", async () => {
  const artifact = systemTools().find((t) => t.name === "sys_create_artifact")!;
  const args = ['{"title":"주간 일정",', '"kind":"html",', '"content":"<p>', "월 10:00 회의 ".repeat(20), "화 14:00 치과", '</p>"}'];
  mock.script.push({ toolCalls: [{ id: "h1", name: "sys_create_artifact", args }], delayMs: 300 }, { text: ["이번 주 일정을 카드로 만들었어요."] });
  const { events, outcome } = await turn({ tools: [artifact] });
  const k = kinds(events);
  const at = k.indexOf("status:'주간 일정' 화면 만드는 중");
  expect(at).toBeGreaterThan(0);
  expect(at).toBeLessThan(k.indexOf("tool:running"));
  expect(outcome.cards).toEqual([expect.objectContaining({ type: "artifact", kind: "html", title: "주간 일정" })]);
});

test("an html guide call (content \"\") passes the loop's argument check and its guide reaches the model whole", async () => {
  const artifact = systemTools().find((t) => t.name === "sys_create_artifact")!;
  mock.script.push(
    { toolCalls: [{ id: "g1", name: "sys_create_artifact", args: '{"title":"주간 일정","kind":"html","content":""}' }] },
    { text: ["가이드를 봤어요."] },
  );
  const { events } = await turn({ tools: [artifact] });
  const done = events.find((e) => e.type === "tool" && e.tool.id === "g1" && e.tool.state !== "running") as Extract<AgentEvent, { type: "tool" }>;
  expect(done.tool).toMatchObject({ state: "done", title: "화면 가이드 보는 중", summary: "화면 가이드를 확인했어요" });
  const sent = mock.requests[1]!.body.messages.find((m) => m.role === "tool")!.content as string;
  expect(Buffer.byteLength(sent)).toBeGreaterThan(6 * 1024);
  expect(JSON.parse(sent).data.guide).toContain("THE CARD");
});

test("a plain turn: the html guide's step is given back once, and at the step limit with no card one last step offers only the card tool", async () => {
  const artifact = systemTools().find((t) => t.name === "sys_create_artifact")!;
  const weather = TOOLS.find((t) => t.name === "k_weather")!;
  const guide = '{"title":"노트북 비교","kind":"html","content":""}';
  mock.script.push(
    { toolCalls: [{ id: "g1", name: "sys_create_artifact", args: guide }] }, // the guide: not counted
    { toolCalls: [{ id: "w1", name: "k_weather", args: '{"city":"서울"}' }] }, // step 1
    { toolCalls: [{ id: "w2", name: "k_weather", args: '{"city":"부산"}' }] }, // step 2 = maxSteps
    { toolCalls: [{ id: "c1", name: "sys_create_artifact", args: JSON.stringify({ title: "노트북 비교", kind: "html", content: "<h2>노트북 5종</h2><p>확인 안 됨</p>" }) }] },
    { text: ["노트북 5종을 카드로 정리했어요."] },
  );
  const { outcome } = await turn({ tools: [weather, artifact], maxSteps: 2 });
  expect(mock.requests).toHaveLength(5);
  const offered = (i: number) => (mock.requests[i]!.body.tools ?? []).map((t) => t.function.name);
  expect(offered(2)).toEqual(["k_weather", "sys_create_artifact"]);
  expect(offered(3)).toEqual(["sys_create_artifact"]);
  expect(mock.requests[3]!.body.tool_choice).toBe("required");
  expect(mock.requests[3]!.body.messages.at(-1)!.content).toContain("마지막 단계");
  expect(mock.requests[4]!.body.tool_choice).toBe("none");
  expect(outcome.cards.filter((c) => c.type === "artifact")).toEqual([expect.objectContaining({ kind: "html", title: "노트북 비교" })]);
  expect(outcome.text).toBe("노트북 5종을 카드로 정리했어요.");
});

test("no last card step when the card is made, without a guide, or a second time; a second guide call is a counted step", async () => {
  const artifact = systemTools().find((t) => t.name === "sys_create_artifact")!;
  const weather = TOOLS.find((t) => t.name === "k_weather")!;
  const guide = { toolCalls: [{ name: "sys_create_artifact", args: '{"title":"카드","kind":"html","content":""}' }] };
  const card = { toolCalls: [{ name: "sys_create_artifact", args: '{"title":"카드","kind":"html","content":"<h2>카드</h2>"}' }] };
  const look = { toolCalls: [{ name: "k_weather", args: '{"city":"서울"}' }] };
  const answer = { text: ["끝"] };
  // the card came before the limit: the forced step is the answer
  mock.script.push(guide, card, look, answer);
  await turn({ tools: [weather, artifact], maxSteps: 2 });
  expect(mock.requests.map((r) => r.body.tool_choice)).toEqual(["auto", "auto", "auto", "none"]);
  // a second guide call counts: guide (free), guide (step 1) → limit → the card step, then the answer
  mock.requests.length = 0;
  mock.script.push(guide, guide, card, answer);
  const { outcome } = await turn({ tools: [weather, artifact], maxSteps: 1 });
  expect(mock.requests.map((r) => r.body.tool_choice)).toEqual(["auto", "auto", "required", "none"]);
  expect(outcome.cards.filter((c) => c.type === "artifact")).toHaveLength(1);
  // the card step that sends no card is not given again
  mock.requests.length = 0;
  mock.script.push(guide, look, look, answer);
  await turn({ tools: [weather, artifact], maxSteps: 1 });
  expect(mock.requests.map((r) => r.body.tool_choice)).toEqual(["auto", "auto", "required", "none"]);
});

test("sys_schedule_create through the loop: time_quote \"\" is a missing argument, blank or unheard ones get no_time_source; nothing is stored", async () => {
  const schedule = systemTools().find((t) => t.name === "sys_schedule_create")!;
  const ctx = fakeCtx({ heard: () => ["토요일 결혼식 추가해서 다시 보여줘"] });
  const args = (time_quote: string) => JSON.stringify({ title: "결혼식", prompt: "결혼식 알림", rule: "once@2026-11-14T12:00", time_quote });
  mock.script.push(
    { toolCalls: [{ id: "s1", name: "sys_schedule_create", args: args("") }] },
    { toolCalls: [{ id: "s2", name: "sys_schedule_create", args: args("  ") }] },
    { toolCalls: [{ id: "s3", name: "sys_schedule_create", args: args("12시") }] },
    { text: ["토요일 결혼식은 시간 미정으로 넣었어요. 몇 시인지 알려 주시면 일정에 넣을게요."] },
  );
  const { events } = await turn({ ctx, tools: [schedule], userText: "토요일 결혼식 추가해서 다시 보여줘" });
  const result = (i: number) => JSON.parse(mock.requests[i]!.body.messages.filter((m) => m.role === "tool").at(-1)!.content as string);
  expect(JSON.stringify(result(1))).toContain("missing required argument(s): time_quote");
  for (const i of [2, 3]) expect(result(i)).toMatchObject({ ok: false, data: { error: "no_time_source" } });
  expect((ctx.store as ReturnType<typeof fakeStore>).schedules).toEqual([]);
  const done = events.flatMap((e) => (e.type === "tool" && e.tool.state !== "running" ? [e.tool.state] : []));
  expect(done).toEqual(["error", "error", "error"]);
});

test("a tool's maxResultBytes lets a bigger result through to the model; others keep the 6 KB cap", async () => {
  const mk = (name: string, maxResultBytes?: number): ToolDef => ({
    name,
    description: "big",
    parameters: { type: "object", properties: {} },
    icon: "doc",
    title: () => name,
    ...(maxResultBytes ? { maxResultBytes } : {}),
    run: async () => ({ ok: true, summary: "ok", data: { text: "가".repeat(3000) } }), // ~9 KB
  });
  mock.script.push({ toolCalls: [{ id: "a", name: "roomy", args: "{}" }, { id: "b", name: "tight", args: "{}" }] }, { text: ["끝"] });
  await turn({ tools: [mk("roomy", 16 * 1024), mk("tight")] });
  const sent = mock.requests[1]!.body.messages as { role: string; tool_call_id?: string; content: string }[];
  const roomy = sent.find((m) => m.tool_call_id === "a")!.content;
  const tight = sent.find((m) => m.tool_call_id === "b")!.content;
  expect(JSON.parse(roomy).data.text).toHaveLength(3000);
  expect(Buffer.byteLength(tight)).toBeLessThanOrEqual(6 * 1024);
  expect(tight).toContain("[truncated]");
});

test("a tool call runs, emits running → card → done in order, and its result goes back to the model", async () => {
  mock.script.push({ text: ["확인해볼게요"], toolCalls: [{ id: "c1", name: "k_weather", args: '{"city":"서울"}' }] }, { text: ["서울은 14°, 흐려요."] });
  const { events, outcome } = await turn();
  expect(kinds(events)).toEqual([
    "status:생각하는 중",
    "text:확인해볼게요",
    "tool:running",
    "status:서울 날씨 확인",
    "card",
    "tool:done",
    "status:생각하는 중",
    "text:\n\n",
    "text:서울은 14°, 흐려요.",
  ]);
  const done = events.find((e) => e.type === "tool" && e.tool.state === "done") as Extract<AgentEvent, { type: "tool" }>;
  expect(done.tool).toMatchObject({ id: "c1", name: "k_weather", title: "서울 날씨 확인", summary: "서울 14°, 흐림" });
  expect(done.tool.endedAt).toBeGreaterThanOrEqual(done.tool.startedAt);
  expect(outcome.text).toBe("확인해볼게요\n\n서울은 14°, 흐려요.");
  expect(outcome.cards).toHaveLength(1);
  expect(outcome.tools).toEqual([done.tool]);
  expect(outcome.messages.map((m) => m.role)).toEqual(["assistant", "tool", "assistant"]);
  const toolMsg = mock.requests[1]!.body.messages.find((m) => m.role === "tool")!;
  expect(JSON.parse(toolMsg.content as string)).toEqual({ ok: true, summary: "서울 14°, 흐림", data: { city: "서울", tempC: 14, condition: "흐림" } });
  expect(mock.requests[1]!.body.messages.some((m) => "reasoning_content" in m)).toBe(false);
});

test("parallel tool calls (chunked, interleaved arguments) run concurrently", async () => {
  mock.script.push(
    {
      toolCalls: [
        { id: "p1", name: "k_weather", args: ['{"city":"서', '울","delay":', "120}"] },
        { id: "p2", name: "k_weather", args: ['{"ci', 'ty":"부산",', '"delay":120}'] },
      ],
      interleave: true,
    },
    { text: ["둘 다 14°예요."] },
  );
  const t0 = Date.now();
  const { events, outcome } = await turn();
  const elapsed = Date.now() - t0;
  expect(log.slice(0, 2).sort()).toEqual(["start:부산", "start:서울"]); // both started before either ended
  expect(elapsed).toBeLessThan(230);
  const toolEvents = events.filter((e) => e.type === "tool") as Extract<AgentEvent, { type: "tool" }>[];
  expect(toolEvents.slice(0, 2).map((e) => e.tool.state)).toEqual(["running", "running"]);
  expect(outcome.messages.filter((m) => m.role === "tool").map((m) => (m as { tool_call_id: string }).tool_call_id)).toEqual(["p1", "p2"]);
});

test("approval pauses the turn; resume with approve runs the tool and continues", async () => {
  mock.script.push({ text: ["보내기 전에 확인할게요."], toolCalls: [{ id: "s1", name: "msg_send", args: '{"to":"진우","text":"점심 12시"}' }] });
  const first = await turn({ userText: "진우에게 점심 12시라고 보내줘" });
  expect(sendRuns).toHaveLength(0);
  expect(mock.requests).toHaveLength(1);
  const pa = first.outcome.pendingApproval!;
  expect(pa.call.id).toBe("s1");
  expect(pa.spec.title).toBe("진우에게 '점심 12시'를 보낼까요?");
  expect(first.outcome.messages).toEqual([]);
  expect(pa.messages.map((m) => m.role)).toEqual(["assistant"]);
  expect(first.outcome.cards).toEqual([{ type: "approval", approvalId: "s1", title: pa.spec.title, detail: "점심 12시", status: "pending" }]);
  expect(first.outcome.tools[0]!.state).toBe("needs_approval");

  mock.script.push({ text: ["진우 님께 보냈어요!"] });
  const history: LlmMessage[] = [{ role: "user", content: "진우에게 점심 12시라고 보내줘" }];
  const second = await turn({ history, userText: null, resume: { call: pa.call, decision: "approve", priorMessages: pa.messages } });
  expect(sendRuns).toEqual([{ to: "진우", text: "점심 12시" }]);
  expect(kinds(second.events).slice(0, 3)).toEqual(["tool:running", "status:진우에게 보내기", "tool:done"]);
  expect((second.events[0] as Extract<AgentEvent, { type: "tool" }>).tool.id).toBe("s1");
  expect(second.outcome.messages.map((m) => m.role)).toEqual(["assistant", "tool", "assistant"]);
  expect(mock.requests[1]!.body.messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "tool"]);
  expect(second.outcome.text).toBe("진우 님께 보냈어요!");
});

test("resume with reject never runs the tool and tells the model approved:false", async () => {
  mock.script.push({ toolCalls: [{ id: "s2", name: "msg_send", args: '{"to":"진우","text":"안녕"}' }] });
  const first = await turn();
  expect(first.outcome.text).toBe("진행하기 전에 확인 부탁드려요.");
  const pa = first.outcome.pendingApproval!;
  mock.script.push({ text: ["알겠어요, 보내지 않을게요."] });
  const second = await turn({ history: [{ role: "user", content: "질문" }], userText: null, resume: { call: pa.call, decision: "reject", priorMessages: pa.messages } });
  expect(sendRuns).toHaveLength(0);
  const toolMsg = mock.requests[1]!.body.messages.find((m) => m.role === "tool")!;
  expect(JSON.parse(toolMsg.content as string)).toMatchObject({ ok: false, approved: false });
  expect(second.outcome.tools[0]).toMatchObject({ id: "s2", state: "error" });
  expect(second.outcome.text).toBe("알겠어요, 보내지 않을게요.");
});

test("resume does not duplicate prior messages the server already appended to history", async () => {
  mock.script.push({ toolCalls: [{ id: "s3", name: "msg_send", args: '{"to":"a","text":"b"}' }] });
  const pa = (await turn()).outcome.pendingApproval!;
  mock.script.push({ text: ["완료"] });
  const history: LlmMessage[] = [{ role: "user", content: "질문" }, ...pa.messages];
  await turn({ history, userText: null, resume: { call: pa.call, decision: "approve", priorMessages: pa.messages } });
  expect(mock.requests[1]!.body.messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "tool"]);
});

test("ungated calls in the same batch run before the approval pause; a second gated call is handled on resume", async () => {
  mock.script.push({
    toolCalls: [
      { id: "w", name: "k_weather", args: '{"city":"서울"}' },
      { id: "g1", name: "msg_send", args: '{"to":"A","text":"1"}' },
      { id: "g2", name: "msg_send", args: '{"to":"B","text":"2"}' },
    ],
  });
  const first = await turn();
  expect(log).toEqual(["start:서울", "end:서울"]);
  const pa = first.outcome.pendingApproval!;
  expect(pa.call.id).toBe("g1");
  expect(pa.messages.map((m) => m.role)).toEqual(["assistant", "tool"]);
  const second = await turn({ history: [{ role: "user", content: "질문" }], userText: null, resume: { call: pa.call, decision: "approve", priorMessages: pa.messages } });
  expect(sendRuns).toEqual([{ to: "A", text: "1" }]);
  const pa2 = second.outcome.pendingApproval!;
  expect(pa2.call.id).toBe("g2");
  expect(second.outcome.messages).toEqual([]);
  mock.script.push({ text: ["둘 다 보냈어요"] });
  const third = await turn({ history: [{ role: "user", content: "질문" }], userText: null, resume: { call: pa2.call, decision: "approve", priorMessages: pa2.messages } });
  expect(sendRuns).toHaveLength(2);
  expect(third.outcome.messages.map((m) => m.role)).toEqual(["assistant", "tool", "tool", "tool", "assistant"]);
  expect(mock.requests).toHaveLength(2);
});

test("a tool's further cards (moreCards: a rows card continued) follow its card, in order, as events and in the outcome; never in the model's result", async () => {
  const art = (n: number) => ({ type: "artifact" as const, artifactId: `art_${n}`, title: `목록 (${n}/3)`, kind: "html" as const, preview: "페이지" });
  const cards: ToolDef<Record<string, never>> = {
    name: "k_cards",
    description: "Make cards",
    parameters: { type: "object", properties: {} },
    icon: "doc",
    title: () => "카드 만드는 중",
    async run() {
      return { ok: true, summary: "카드 3장", data: { artifactId: "art_1", cards: 3 }, card: art(1), moreCards: [art(2), art(3)] };
    },
  };
  mock.script.push({ toolCalls: [{ id: "c1", name: "k_cards", args: "{}" }] }, { text: ["카드로 정리했어요"] });
  const { events, outcome } = await turn({ tools: [cards] as unknown as ToolDef[] });
  const ids = (xs: unknown[]) => xs.map((c) => (c as { artifactId: string }).artifactId);
  expect(ids(events.filter((e) => e.type === "card").map((e) => (e as { card: unknown }).card))).toEqual(["art_1", "art_2", "art_3"]);
  expect(ids(outcome.cards)).toEqual(["art_1", "art_2", "art_3"]);
  expect(JSON.stringify(mock.requests[1]!.body.messages)).not.toContain("art_2");
});

test("a missing credential pauses with a credential_request card and a complete, valid history", async () => {
  mock.script.push({ toolCalls: [{ id: "k1", name: "kakao_read", args: '{"chat":"가족방"}' }] });
  const { events, outcome } = await turn();
  expect(mock.requests).toHaveLength(1);
  expect(outcome.pendingCredential?.service).toBe("kakaotalk");
  expect(outcome.cards[0]).toMatchObject({ type: "credential_request", service: "kakaotalk", serviceName: "카카오톡", status: "pending" });
  expect((outcome.cards[0] as { fields: unknown[] }).fields).toHaveLength(2);
  expect(outcome.tools[0]!.state).toBe("needs_credential");
  expect(outcome.messages.map((m) => m.role)).toEqual(["assistant", "tool", "assistant"]);
  const credResult = JSON.parse((outcome.messages[1] as { content: string }).content) as { ok: boolean; error: string; message: string };
  expect(credResult).toMatchObject({ ok: false, error: "credential_required" });
  // the card carries the security note; the reply is one sentence on why the login is needed
  expect(credResult.message).toContain("한 문장만");
  expect(credResult.message).toContain("되풀이하지 않아요");
  expect(outcome.text).toContain("카카오톡 로그인 정보가 필요해요");
  expect(events.some((e) => e.type === "card")).toBe(true);
});

test("invalid tool arguments become an error result the model can react to", async () => {
  mock.script.push({ toolCalls: [{ id: "bad", name: "k_weather", args: '{"city": 서울' }] }, { text: ["다시 해볼게요"] });
  const { outcome } = await turn();
  expect(log).toEqual([]);
  expect(outcome.tools[0]).toMatchObject({ id: "bad", state: "error" });
  const toolMsg = mock.requests[1]!.body.messages.find((m) => m.role === "tool")!;
  expect(JSON.parse(toolMsg.content as string)).toMatchObject({ ok: false });
  expect(toolMsg.content).toContain("invalid JSON");
});

test("missing required args and unknown tools are reported, not thrown", async () => {
  mock.script.push(
    {
      toolCalls: [
        { id: "m1", name: "k_weather", args: "{}" },
        { id: "u1", name: "k_nope", args: "{}" },
      ],
    },
    { text: ["죄송해요"] },
  );
  const { outcome } = await turn();
  const toolMsgs = mock.requests[1]!.body.messages.filter((m) => m.role === "tool").map((m) => m.content as string);
  expect(toolMsgs[0]).toContain("missing required argument(s): city");
  expect(toolMsgs[1]).toContain('unknown tool \\"k_nope\\"');
  expect(outcome.tools.map((t) => t.state)).toEqual(["error", "error"]);
});

test("a throwing tool yields {ok:false,error} and the loop continues", async () => {
  mock.script.push({ toolCalls: [{ id: "b1", name: "boom", args: "{}" }] }, { text: ["문제가 있었어요"] });
  const { outcome } = await turn();
  const toolMsg = mock.requests[1]!.body.messages.find((m) => m.role === "tool")!;
  expect(JSON.parse(toolMsg.content as string)).toMatchObject({ ok: false, error: "실행 중에 문제가 생겼어요", data: { error: "tool_error", detail: "kaboom" } });
  expect(outcome.tools[0]).toMatchObject({ state: "error", summary: "실행 중에 문제가 생겼어요" }); // the chip never shows the raw error
  expect(outcome.text).toBe("문제가 있었어요");
});

test("tool results sent to the model are capped at 6 KB", async () => {
  mock.script.push({ toolCalls: [{ id: "big1", name: "big", args: "{}" }] }, { text: ["요약"] });
  await turn();
  const content = mock.requests[1]!.body.messages.find((m) => m.role === "tool")!.content as string;
  expect(new TextEncoder().encode(content).length).toBeLessThanOrEqual(6 * 1024);
  expect(content.endsWith("…[truncated]")).toBe(true);
});

test("maxSteps stops tool use and forces a final answer without tools", async () => {
  mock.fallback = { toolCalls: [{ name: "k_weather", args: '{"city":"서울"}' }] };
  mock.script.push(
    { toolCalls: [{ name: "k_weather", args: '{"city":"서울"}' }] },
    { toolCalls: [{ name: "k_weather", args: '{"city":"부산"}' }] },
    () => ({ text: ["지금까지 확인한 결과예요."] }),
  );
  const { outcome } = await turn({ maxSteps: 2 });
  expect(mock.requests).toHaveLength(3);
  expect(mock.requests[2]!.body.tool_choice).toBe("none");
  expect(mock.requests[2]!.body.messages.at(-1)).toMatchObject({ role: "user" });
  expect(mock.requests[2]!.body.messages.at(-1)!.content).toContain("[시스템 안내]");
  expect(outcome.text).toBe("지금까지 확인한 결과예요.");
  expect(outcome.messages.at(-1)).toEqual({ role: "assistant", content: "지금까지 확인한 결과예요." });
  // the transient nudge is not persisted
  expect(outcome.messages.some((m) => m.role === "user" || m.role === "system")).toBe(false);
});

test("steering messages are injected after tool results and become part of the turn", async () => {
  mock.script.push({ toolCalls: [{ id: "c1", name: "k_weather", args: '{"city":"서울"}' }] }, { text: ["서울 14°, 부산도 14°예요."] });
  const queue = [[], ["부산도 알려줘"], []] as string[][];
  const { outcome } = await turn({ steer: () => queue.shift() ?? [] });
  const msgs = mock.requests[1]!.body.messages;
  expect(msgs.at(-1)).toEqual({ role: "user", content: "부산도 알려줘" });
  expect(msgs.at(-2)!.role).toBe("tool");
  expect(outcome.messages.map((m) => m.role)).toEqual(["assistant", "tool", "user", "assistant"]);
});

test("a steering message that arrives after the final answer starts another inner round", async () => {
  mock.script.push({ text: ["답1"] }, { text: ["답2"] });
  const queue = [[], ["하나 더"], []] as string[][];
  const { outcome } = await turn({ steer: () => queue.shift() ?? [] });
  expect(mock.requests).toHaveLength(2);
  expect(outcome.text).toBe("답1\n\n답2");
  expect(outcome.messages).toEqual([
    { role: "assistant", content: "답1" },
    { role: "user", content: "하나 더" },
    { role: "assistant", content: "답2" },
  ]);
});

test("<think> blocks inside content never reach the user", async () => {
  mock.script.push({ text: ["<thi", "nk>숨은 생각</th", "ink>\n보이는 답"] });
  const { outcome, events } = await turn();
  expect(outcome.text).toBe("보이는 답");
  expect(JSON.stringify(events)).not.toContain("숨은");
});

test("voice mode appends the short spoken-answer rule to the system prompt", async () => {
  mock.script.push({ text: ["네, 내일은 맑아요."] });
  await turn({ mode: "voice" });
  const sys = mock.requests[0]!.body.messages[0]!.content as string;
  expect(sys.startsWith("SYS")).toBe(true);
  expect(sys).toContain("음성 모드");
  expect(sys).toContain("한두 문장");
});

test("sys_remember emits a memory event", async () => {
  mock.script.push({ toolCalls: [{ id: "r1", name: "sys_remember", args: '{"text":"커피는 아이스 아메리카노를 좋아함"}' }] }, { text: ["기억할게요!"] });
  const ctx = fakeCtx();
  const events: AgentEvent[] = [];
  await runTurn({ ctx, system: "S", history: [], userText: "나 아아 좋아해", tools: systemTools() }, (e) => events.push(e));
  expect(events).toContainEqual({ type: "memory", text: "커피는 아이스 아메리카노를 좋아함" });
});

test("the API key never appears in events, outcomes or upstream errors", async () => {
  mock.script.push({ toolCalls: [{ id: "x1", name: "boom", args: "{}" }] }, { text: ["끝"] });
  const ok = await turn();
  expect(JSON.stringify(ok)).not.toContain(KEY);
  mock.script.push({ status: 500, errorBody: `upstream says key=${KEY}` }, { status: 500, errorBody: `still ${KEY}` });
  const events: AgentEvent[] = [];
  const err = await runTurn({ ctx: fakeCtx(), system: "S", history: [], userText: "x", tools: TOOLS }, (e) => events.push(e)).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(Error);
  expect(String((err as Error).message)).not.toContain(KEY);
  expect(JSON.stringify(events)).not.toContain(KEY);
  for (const r of mock.requests) expect(JSON.stringify(r.body)).not.toContain(KEY);
});

test("aborting the turn rejects instead of hanging", async () => {
  mock.script.push({ text: ["a"], hang: true });
  const ctl = new AbortController();
  setTimeout(() => ctl.abort(), 50);
  await expect(turn({ ctx: fakeCtx({ signal: ctl.signal }) })).rejects.toBeDefined();
});

test("a steering message that lands during the forced final answer still gets answered", async () => {
  mock.script.push({ toolCalls: [{ name: "k_weather", args: '{"city":"서울"}' }] }, { text: ["최종 답"] }, { text: ["추가 답"] });
  const queue = [[], [], ["하나 더 궁금해"], []] as string[][];
  const { outcome } = await turn({ maxSteps: 1, steer: () => queue.shift() ?? [] });
  expect(mock.requests).toHaveLength(3);
  expect(mock.requests[2]!.body.tool_choice).toBe("none");
  expect(outcome.text).toBe("최종 답\n\n추가 답");
  expect(outcome.messages.filter((m) => m.role === "user")).toEqual([{ role: "user", content: "하나 더 궁금해" }]);
});

test("if the model call fails after an approved tool ran, the error carries the partial outcome", async () => {
  mock.script.push({ toolCalls: [{ id: "sp", name: "msg_send", args: '{"to":"진우","text":"출발!"}' }] });
  const pa = (await turn()).outcome.pendingApproval!;
  mock.script.push({ status: 500, errorBody: "down" }, { status: 500, errorBody: "down" });
  const err = await turn({ history: [{ role: "user", content: "질문" }], userText: null, resume: { call: pa.call, decision: "approve", priorMessages: pa.messages } }).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(UpstreamError);
  expect(sendRuns).toHaveLength(1);
  const partial = partialOutcome(err)!;
  expect(partial.messages.map((m) => m.role)).toEqual(["assistant", "tool"]);
  expect(partial.tools[0]).toMatchObject({ id: "sp", state: "done" });
});

test("a hanging credential() check cannot wedge the turn: abort rejects promptly", async () => {
  const stuck: ToolDef = { ...(kakao as unknown as ToolDef), name: "stuck_login", credential: () => new Promise(() => {}) };
  mock.script.push({ toolCalls: [{ id: "h1", name: "stuck_login", args: '{"chat":"x"}' }] });
  const ctl = new AbortController();
  setTimeout(() => ctl.abort(), 50);
  const t0 = Date.now();
  await expect(turn({ ctx: fakeCtx({ signal: ctl.signal }), tools: [stuck] })).rejects.toBeDefined();
  expect(Date.now() - t0).toBeLessThan(1000);
});

test("a credential() check that times out becomes a tool error, not a hang", async () => {
  const slowTurn = createRunTurn(llm, { toolTimeoutMs: 40 });
  const stuck: ToolDef = { ...(kakao as unknown as ToolDef), name: "stuck_login", credential: () => new Promise(() => {}) };
  mock.script.push({ toolCalls: [{ id: "h2", name: "stuck_login", args: '{"chat":"x"}' }] }, { text: ["확인이 늦어지네요"] });
  const outcome = await slowTurn({ ctx: fakeCtx(), system: "S", history: [], userText: "x", tools: [stuck] }, () => {});
  expect(outcome.tools[0]).toMatchObject({ id: "h2", state: "error" });
  expect(mock.requests[1]!.body.messages.find((m) => m.role === "tool")!.content).toContain("timed out");
});

test("repairHistory answers dangling tool calls, drops orphans and duplicate blocks", () => {
  const call = { id: "c1", type: "function" as const, function: { name: "k_weather", arguments: "{}" } };
  const fixed = repairHistory([
    { role: "user", content: "a" },
    { role: "tool", tool_call_id: "orphan", content: "{}" },
    { role: "assistant", content: null, tool_calls: [call] },
    { role: "user", content: "b" },
    { role: "assistant", content: null, tool_calls: [call] },
    { role: "tool", tool_call_id: "c1", content: "{}" },
  ]);
  expect(fixed.map((m) => m.role)).toEqual(["user", "assistant", "tool", "user"]);
  expect((fixed[2] as { content: string }).content).toContain("interrupted");
});
