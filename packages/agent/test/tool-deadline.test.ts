/**
 * Tool deadlines (live bug 2026-11-12): four parallel msg_read calls hung on a Slack 429. The tool deadline and the
 * server's turn idle watchdog were both 60 s, so the watchdog killed the turn ("응답이 너무 늦어지고 있어요") and the
 * chips showed raw "실패: upstream timeout". Now a hung call ends at its own deadline as an error the model answers, and
 * the chip line is fixed Korean.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import type { AgentEvent, ToolActivity } from "@pickle/protocol";
import {
  DEFAULT_TOOL_TIMEOUT_MS,
  LlmClient,
  TOOL_ERROR_SUMMARY,
  TOOL_STOPPED_SUMMARY,
  TOOL_TIMEOUT_SUMMARY,
  createRunTurn,
  type ToolDef,
  type TurnInput,
} from "../src/index.ts";
import { fakeCtx, startMockLlm } from "./mock-llm.ts";

const mock = startMockLlm();
afterAll(() => mock.stop());
beforeEach(() => {
  mock.requests.length = 0;
  mock.script.length = 0;
  mock.fallback = { text: ["(no script)"] };
});

const llm = new LlmClient({ apiKey: "sk-deadline-test-0123456789abcdef", baseUrl: mock.url, model: "deepseek/deepseek-v4.1-flash-ultrafast" }, { retryDelayMs: 5 });
const DEADLINE = 100;
const runTurn = createRunTurn(llm, { toolTimeoutMs: DEADLINE });

type Args = { chat?: string; ms?: number };
const base = { description: "reads a Slack channel", parameters: { type: "object" as const, properties: { chat: { type: "string" as const }, ms: { type: "number" as const } } }, icon: "chat" as const, title: (a: Args) => `슬랙 '${a.chat ?? ""}' 읽기` };

/** msg_read on a Slack 429: never settles and ignores its signal */
const hang: ToolDef<Args> = { ...base, name: "slack_read", run: () => new Promise(() => {}) };
/** finishes after `ms` */
const slow = (over: Partial<ToolDef<Args>> = {}): ToolDef<Args> => ({
  ...base,
  name: "slow_read",
  run: async (a) => {
    await Bun.sleep(a.ms ?? 0);
    return { ok: true, summary: "읽었어요" };
  },
  ...over,
});

class MessengerError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "MessengerError";
    this.code = code;
  }
}
const RATE_LIMITED = "슬랙이 요청을 잠시 막았어요. 30초 뒤에 다시 시도해 주세요."; // slack-login's rate_limited sentence
const limited: ToolDef<Args> = { ...base, name: "limited_read", run: async () => Promise.reject(new MessengerError("rate_limited", RATE_LIMITED)) };
const raw: ToolDef<Args> = { ...base, name: "raw_read", run: async () => Promise.reject(new Error("ECONNRESET socket hang up at 10.0.0.7:443")) };

const TOOLS = [hang, slow(), limited, raw] as unknown as ToolDef[];

async function turn(over: Partial<TurnInput> = {}, run = runTurn) {
  const events: AgentEvent[] = [];
  const t0 = performance.now();
  const outcome = await run({ ctx: fakeCtx(), system: "S", history: [], userText: "슬랙 읽어줘", tools: TOOLS, ...over }, (e) => events.push(e));
  return { events, outcome, ms: performance.now() - t0 };
}

const toolMsgs = (i = 1) => mock.requests[i]!.body.messages.filter((m) => m.role === "tool").map((m) => JSON.parse(m.content as string) as Record<string, any>);
const chips = (events: AgentEvent[]) => events.flatMap((e) => (e.type === "tool" ? [e.tool] : []));
const RAW = /timed out|upstream timeout|실패:|ECONNRESET|Error/;

describe("tool deadline: a hung call is an error the model answers", () => {
  test("the chat default is 25 s, well below the server's 60 s turn idle watchdog", () => {
    expect(DEFAULT_TOOL_TIMEOUT_MS).toBe(25_000);
    expect(DEFAULT_TOOL_TIMEOUT_MS).toBeLessThanOrEqual(60_000 - 30_000);
  });

  test("one hanging tool: the turn ends with an answer, the chip says 시간이 너무 오래 걸렸어요 with its timing", async () => {
    mock.script.push({ toolCalls: [{ id: "r1", name: "slack_read", args: '{"chat":"#general"}' }] }, { text: ["슬랙이 응답하지 않아 #general을 읽지 못했어요."] });
    const { events, outcome, ms } = await turn();
    expect(outcome.text).toBe("슬랙이 응답하지 않아 #general을 읽지 못했어요.");
    const chip = outcome.tools[0] as ToolActivity;
    expect(chip).toMatchObject({ id: "r1", state: "error", summary: TOOL_TIMEOUT_SUMMARY });
    expect(chip.endedAt! - chip.startedAt).toBeGreaterThanOrEqual(DEADLINE - 5); // the chip's "· N초" line
    expect(ms).toBeLessThan(DEADLINE * 5);
    const [r] = toolMsgs();
    expect(r).toMatchObject({ ok: false, summary: TOOL_TIMEOUT_SUMMARY, data: { error: "timeout", detail: `tool timed out after ${DEADLINE} ms` } });
    expect(r!.data.message).toContain("다시 하지 말고");
    for (const c of chips(events)) expect(String(c.summary ?? "")).not.toMatch(RAW);
  });

  test("four parallel hanging tools: one deadline in all, four Korean chips, one answer", async () => {
    const rooms = ["#general", "#random", "#dev", "#design"];
    mock.script.push({ toolCalls: rooms.map((chat, i) => ({ id: `p${i}`, name: "slack_read", args: JSON.stringify({ chat }) })) }, { text: ["슬랙이 응답하지 않아 네 채널을 읽지 못했어요."] });
    const { events, outcome, ms } = await turn();
    expect(outcome.text).toBe("슬랙이 응답하지 않아 네 채널을 읽지 못했어요.");
    expect(outcome.tools.map((t) => [t.id, t.state, t.summary])).toEqual(rooms.map((_, i) => [`p${i}`, "error", TOOL_TIMEOUT_SUMMARY]));
    expect(ms).toBeLessThan(DEADLINE * 3); // in parallel: serial would be ≥ 4 deadlines
    expect(toolMsgs().map((r) => r.data.error)).toEqual(["timeout", "timeout", "timeout", "timeout"]);
    for (const c of chips(events)) expect(String(c.summary ?? "")).not.toMatch(RAW);
  });

  test("ToolDef.timeoutMs overrides the runner's deadline, both ways", async () => {
    const long = slow({ name: "long_read", timeoutMs: DEADLINE * 6 });
    const short = slow({ name: "short_read", timeoutMs: 20 });
    mock.script.push(
      { toolCalls: [{ id: "l1", name: "long_read", args: JSON.stringify({ chat: "a", ms: DEADLINE * 2 }) }, { id: "s1", name: "short_read", args: JSON.stringify({ chat: "b", ms: 80 }) }] },
      { text: ["하나는 읽었어요."] },
    );
    const { outcome } = await turn({ tools: [long, short] as unknown as ToolDef[] });
    expect(outcome.tools.map((t) => [t.id, t.state, t.summary])).toEqual([
      ["l1", "done", "읽었어요"],
      ["s1", "error", TOOL_TIMEOUT_SUMMARY],
    ]);
    expect(toolMsgs()[1]!.data.detail).toBe("tool timed out after 20 ms");
  });

  test("a tool that turns the deadline abort into its own error (hub: network MessengerError) still shows the timeout", async () => {
    const NETWORK = "네트워크 문제로 Slack에 연결하지 못했어요. 잠시 후 다시 시도해 주세요.";
    const throws: ToolDef<Args> = { ...base, name: "net_throw", run: (_a, ctx) => new Promise((_, rej) => ctx.signal.addEventListener("abort", () => rej(new MessengerError("network", NETWORK)), { once: true })) };
    const returns: ToolDef<Args> = { ...base, name: "net_return", run: (_a, ctx) => new Promise((res) => ctx.signal.addEventListener("abort", () => res({ ok: false, summary: NETWORK, data: { error: "network" } }), { once: true })) };
    mock.script.push({ toolCalls: [{ id: "n1", name: "net_throw", args: "{}" }, { id: "n2", name: "net_return", args: "{}" }] }, { text: ["슬랙이 응답하지 않았어요."] });
    const { outcome } = await turn({ tools: [throws, returns] as unknown as ToolDef[] });
    expect(outcome.tools.map((t) => [t.id, t.state, t.summary])).toEqual([
      ["n1", "error", TOOL_TIMEOUT_SUMMARY],
      ["n2", "error", TOOL_TIMEOUT_SUMMARY],
    ]);
    expect(toolMsgs().map((r) => r.data.error)).toEqual(["timeout", "timeout"]);
  });

  test("a MessengerError (rate_limited) shows its own Korean sentence; the model gets the code", async () => {
    mock.script.push({ toolCalls: [{ id: "m1", name: "limited_read", args: '{"chat":"#general"}' }] }, { text: ["슬랙 요청이 많아 지금은 못 읽었어요."] });
    const { outcome } = await turn();
    expect(outcome.tools[0]).toMatchObject({ state: "error", summary: RATE_LIMITED });
    expect(toolMsgs()[0]).toMatchObject({ ok: false, summary: RATE_LIMITED, data: { error: "rate_limited", message: RATE_LIMITED } });
  });

  test("any other thrown error: a fixed chip line; the raw text reaches the model only, scrubbed", async () => {
    mock.script.push({ toolCalls: [{ id: "e1", name: "raw_read", args: '{"chat":"#general"}' }] }, { text: ["읽지 못했어요."] });
    const { events, outcome } = await turn();
    expect(outcome.tools[0]).toMatchObject({ state: "error", summary: TOOL_ERROR_SUMMARY });
    expect(JSON.stringify(events)).not.toContain("ECONNRESET");
    expect(toolMsgs()[0]).toMatchObject({ ok: false, summary: TOOL_ERROR_SUMMARY, data: { error: "tool_error" } });
    expect(toolMsgs()[0]!.data.detail).toContain("ECONNRESET");
  });

  test("the turn itself aborted while a tool runs: Korean chip lines, never the abort reason", async () => {
    const patient = createRunTurn(llm, { toolTimeoutMs: 10_000 });
    for (const [reason, want] of [
      [new DOMException("upstream timeout", "TimeoutError"), TOOL_TIMEOUT_SUMMARY],
      [new DOMException("client disconnected", "AbortError"), TOOL_STOPPED_SUMMARY],
    ] as const) {
      mock.script.push({ toolCalls: [{ id: "a1", name: "slack_read", args: '{"chat":"#general"}' }] });
      const ctl = new AbortController();
      setTimeout(() => ctl.abort(reason), 60);
      const events: AgentEvent[] = [];
      await expect(patient({ ctx: fakeCtx({ signal: ctl.signal }), system: "S", history: [], userText: "x", tools: TOOLS }, (e) => events.push(e))).rejects.toBe(reason);
      expect(chips(events).at(-1)).toMatchObject({ id: "a1", state: "error", summary: want });
      for (const c of chips(events)) expect(String(c.summary ?? "")).not.toMatch(RAW);
    }
  });
});

describe("a credential() check that throws or hangs (msg_send resolves its chat there)", () => {
  const check = (name: string, credential: ToolDef<Args>["credential"]): ToolDef<Args> => ({ ...base, name, credential, run: async () => ({ ok: true, summary: "보냈어요" }) });

  test("MessengerError: the chip shows its sentence; the model gets it as a precondition failure", async () => {
    const t = check("limited_send", async () => Promise.reject(new MessengerError("rate_limited", RATE_LIMITED)));
    mock.script.push({ toolCalls: [{ id: "c1", name: "limited_send", args: '{"chat":"C0123ABCD"}' }] }, { text: ["슬랙이 잠시 막아서 못 보냈어요."] });
    const { outcome } = await turn({ tools: [t] as unknown as ToolDef[] });
    expect(outcome.text).toBe("슬랙이 잠시 막아서 못 보냈어요.");
    expect(outcome.tools[0]).toMatchObject({ id: "c1", state: "error", summary: RATE_LIMITED });
    expect(toolMsgs()[0]!.error).toBe(`precondition check failed: ${RATE_LIMITED}`);
  });

  test("a hanging check: 시간이 너무 오래 걸렸어요; any other error: 도구 호출 오류", async () => {
    const hangs = check("hang_send", () => new Promise(() => {}));
    const fails = check("fail_send", async () => Promise.reject(new Error("ECONNRESET")));
    mock.script.push({ toolCalls: [{ id: "h1", name: "hang_send", args: "{}" }, { id: "f1", name: "fail_send", args: "{}" }] }, { text: ["못 보냈어요."] });
    const { events, outcome } = await turn({ tools: [hangs, fails] as unknown as ToolDef[] });
    expect(outcome.tools.map((t) => [t.id, t.state, t.summary])).toEqual([
      ["h1", "error", TOOL_TIMEOUT_SUMMARY],
      ["f1", "error", "도구 호출 오류"],
    ]);
    expect(toolMsgs().map((r) => r.error)).toEqual([`precondition check failed: tool timed out after ${DEADLINE} ms`, "precondition check failed: ECONNRESET"]);
    expect(JSON.stringify(chips(events))).not.toContain("ECONNRESET");
  });
});
