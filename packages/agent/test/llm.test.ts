import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { LlmClient, UpstreamError, loadLlmConfig, toOpenAiTools, type LlmChunk, type ToolDef } from "../src/index.ts";
import { startMockLlm } from "./mock-llm.ts";

const KEY = "sk-test-SECRET-key-0123456789abcdef";
const mock = startMockLlm();
afterAll(() => mock.stop());
beforeEach(() => {
  mock.requests.length = 0;
  mock.script.length = 0;
});

const client = () => new LlmClient({ apiKey: KEY, baseUrl: mock.url, model: "deepseek/deepseek-v4.1-flash-eco" }, { retryDelayMs: 5 });

async function collect(it: AsyncIterable<LlmChunk>): Promise<LlmChunk[]> {
  const out: LlmChunk[] = [];
  for await (const c of it) out.push(c);
  return out;
}

const weather: ToolDef = {
  name: "k_weather",
  description: "weather",
  parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
  icon: "cloud",
  title: () => "날씨",
  run: async () => ({ ok: true, summary: "" }),
};

test("loadLlmConfig requires the key and applies defaults", () => {
  expect(() => loadLlmConfig({})).toThrow(/OPENGATEWAY_API_KEY/);
  const c = loadLlmConfig({ OPENGATEWAY_API_KEY: "k", OPENGATEWAY_BASE_URL: "https://x.test/v1///" });
  expect(c).toEqual({ apiKey: "k", baseUrl: "https://x.test/v1", model: "deepseek/deepseek-v4.1-flash-ultrafast" });
});

test("toOpenAiTools maps ToolDefs to the function-tool wire shape", () => {
  expect(toOpenAiTools([weather])).toEqual([{ type: "function", function: { name: "k_weather", description: "weather", parameters: weather.parameters } }]);
});

test("stream yields text and reasoning separately (data: with and without space) plus usage and finish", async () => {
  mock.script.push({ reasoning: ["생각", "중"], text: ["안녕", "하세요"] });
  const chunks = await collect(client().stream({ messages: [{ role: "user", content: "hi" }] }));
  expect(chunks.filter((c) => c.type === "text").map((c) => (c as { delta: string }).delta).join("")).toBe("안녕하세요");
  expect(chunks.filter((c) => c.type === "reasoning").map((c) => (c as { delta: string }).delta).join("")).toBe("생각중");
  expect(chunks.find((c) => c.type === "usage")).toEqual({ type: "usage", usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 } });
  expect(chunks.at(-1)).toEqual({ type: "finish", reason: "stop" });
  const req = mock.requests[0]!;
  expect(req.auth).toBe(`Bearer ${KEY}`);
  expect(req.body.stream).toBe(true);
  expect(req.body.stream_options).toEqual({ include_usage: true });
});

test("stream assembles chunked, interleaved parallel tool calls", async () => {
  mock.script.push({
    toolCalls: [
      { id: "a", name: "k_weather", args: ['{"ci', 'ty":', '"서울"}'] },
      { id: "b", name: "k_weather", args: ['{"city"', ':"부산"', "}"] },
    ],
    interleave: true,
  });
  const chunks = await collect(client().stream({ messages: [{ role: "user", content: "x" }], tools: [weather] }));
  const tc = chunks.find((c) => c.type === "tool_calls") as Extract<LlmChunk, { type: "tool_calls" }>;
  expect(tc.calls).toEqual([
    { id: "a", type: "function", function: { name: "k_weather", arguments: '{"city":"서울"}' } },
    { id: "b", type: "function", function: { name: "k_weather", arguments: '{"city":"부산"}' } },
  ]);
  expect(chunks.at(-1)).toEqual({ type: "finish", reason: "tool_calls" });
  expect(mock.requests[0]!.body.tools?.[0]?.function.name).toBe("k_weather");
  expect(mock.requests[0]!.body.tool_choice).toBe("auto");
});

test("long tool-call arguments report progress about once a second, with title and kind once streamed; short ones never", async () => {
  const pieces = ['{"title":"주간', ' 일정","kind":"html",', '"content":"<p>', "a".repeat(200), "b".repeat(200), '</p>"}'];
  mock.script.push({ toolCalls: [{ id: "h1", name: "sys_create_artifact", args: pieces }], delayMs: 300 });
  const slow = await collect(client().stream({ messages: [{ role: "user", content: "x" }] }));
  const prog = slow.filter((c) => c.type === "tool_progress") as Extract<LlmChunk, { type: "tool_progress" }>[];
  expect(prog.length).toBeGreaterThanOrEqual(1);
  expect(prog.length).toBeLessThanOrEqual(2);
  expect(prog[0]).toMatchObject({ type: "tool_progress", name: "sys_create_artifact", args: { title: "주간 일정", kind: "html" } });
  expect(prog[0]!.chars).toBeGreaterThan(30);
  // the call itself is unchanged
  expect((slow.find((c) => c.type === "tool_calls") as Extract<LlmChunk, { type: "tool_calls" }>).calls[0]!.function.arguments).toBe(pieces.join(""));

  mock.script.push({ toolCalls: [{ id: "w1", name: "k_weather", args: ['{"ci', 'ty":', '"서울"}'] }] });
  const fast = await collect(client().stream({ messages: [{ role: "user", content: "x" }] }));
  expect(fast.filter((c) => c.type === "tool_progress")).toEqual([]);
});

test("tool calls streamed whole without an index are kept apart", async () => {
  mock.script.push({ toolCalls: [{ id: "x1", name: "k_weather", args: '{"city":"서울"}' }, { id: "x2", name: "k_news", args: "{}" }], noIndex: true });
  const chunks = await collect(client().stream({ messages: [{ role: "user", content: "x" }] }));
  const tc = chunks.find((c) => c.type === "tool_calls") as Extract<LlmChunk, { type: "tool_calls" }>;
  expect(tc.calls.map((c) => [c.id, c.function.name, c.function.arguments])).toEqual([
    ["x1", "k_weather", '{"city":"서울"}'],
    ["x2", "k_news", "{}"],
  ]);
});

test("usage is estimated (chars/2) when the provider omits it", async () => {
  mock.script.push({ text: ["abcdef"], usage: false });
  const chunks = await collect(client().stream({ messages: [{ role: "user", content: "12345678" }] }));
  expect(chunks.find((c) => c.type === "usage")).toEqual({ type: "usage", usage: { promptTokens: 4, completionTokens: 3, totalTokens: 7 } });
});

test("one retry on 5xx, then success", async () => {
  mock.script.push({ status: 503, errorBody: "busy" }, { text: ["ok"] });
  const chunks = await collect(client().stream({ messages: [{ role: "user", content: "x" }] }));
  expect(chunks.some((c) => c.type === "text")).toBe(true);
  expect(mock.requests.length).toBe(2);
});

test("a second failure throws UpstreamError with the key redacted", async () => {
  mock.script.push({ status: 500, errorBody: `boom ${KEY}` }, { status: 502, errorBody: `again Bearer ${KEY}` });
  const err = await collect(client().stream({ messages: [{ role: "user", content: "x" }] })).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(UpstreamError);
  expect((err as UpstreamError).status).toBe(502);
  expect(String((err as Error).message)).not.toContain(KEY);
  expect(String((err as Error).message)).toContain("[redacted]");
});

test("4xx is not retried", async () => {
  mock.script.push({ status: 400, errorBody: "bad" });
  await expect(collect(client().stream({ messages: [{ role: "user", content: "x" }] }))).rejects.toBeInstanceOf(UpstreamError);
  expect(mock.requests.length).toBe(1);
});

test("aborting the signal stops a hanging stream", async () => {
  mock.script.push({ text: ["a", "b"], hang: true });
  const ctl = new AbortController();
  setTimeout(() => ctl.abort(), 50);
  const t = Date.now();
  await expect(collect(client().stream({ messages: [{ role: "user", content: "x" }], signal: ctl.signal }))).rejects.toBeDefined();
  expect(Date.now() - t).toBeLessThan(2000);
});

test("idle timeout turns a stalled stream into UpstreamError 504", async () => {
  mock.script.push({ text: ["a"], hang: true });
  const c = new LlmClient({ apiKey: KEY, baseUrl: mock.url, model: "m" }, { idleTimeoutMs: 80 });
  const err = await collect(c.stream({ messages: [{ role: "user", content: "x" }] })).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(UpstreamError);
  expect((err as UpstreamError).status).toBe(504);
});

test("complete() returns content, tool calls and usage; jsonMode + thinking:false reach the wire", async () => {
  mock.script.push({ text: ['{"facts":[]}'] });
  const r = await client().complete({ messages: [{ role: "user", content: "x" }], jsonMode: true, thinking: false });
  expect(r.content).toBe('{"facts":[]}');
  expect(r.usage.totalTokens).toBe(120);
  expect(mock.requests[0]!.body.stream).toBe(false);
  expect(mock.requests[0]!.body.response_format).toEqual({ type: "json_object" });
  expect(mock.requests[0]!.body.thinking).toEqual({ type: "disabled" });
});

test("history sent upstream never carries reasoning_content and keeps null content for tool-call messages", async () => {
  mock.script.push({ text: ["ok"] });
  const assistant = { role: "assistant" as const, content: null, tool_calls: [{ id: "c1", type: "function" as const, function: { name: "k_weather", arguments: "{}" } }], reasoning_content: "hidden" };
  await collect(
    client().stream({
      messages: [{ role: "user", content: "x" }, assistant, { role: "tool", tool_call_id: "c1", content: "{}" }],
    }),
  );
  const sent = mock.requests[0]!.body.messages[1]!;
  expect(sent).toEqual({ role: "assistant", content: null, tool_calls: assistant.tool_calls });
  expect("reasoning_content" in sent).toBe(false);
});

test("the client never exposes the key via JSON or inspection", () => {
  const c = client();
  expect(JSON.stringify(c)).not.toContain(KEY);
  expect(Bun.inspect(c)).not.toContain(KEY);
  expect(Object.values(c).join(" ")).not.toContain(KEY);
});

describe("cached prompt tokens", () => {
  test("billableTokens counts cached prompt tokens at 10%", async () => {
    const { billableTokens } = await import("../src/llm");
    expect(billableTokens({ promptTokens: 10000, completionTokens: 200, totalTokens: 10200, cachedTokens: 9000 })).toBe(2100);
    expect(billableTokens({ promptTokens: 10, completionTokens: 5, totalTokens: 15 })).toBe(15);
  });
});
