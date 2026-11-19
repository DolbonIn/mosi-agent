import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { chat, createSession, loadConfig, UpstreamError, type ChatMessage } from "../src/index.ts";

const KEY = "test-key-that-must-never-leak";
type Mode = "ok" | "fail" | "empty";
let mode: Mode = "ok";
let seen: { auth: string | null; body: { model: string; messages: ChatMessage[] } }[] = [];
let server: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  // 127.0.0.1 only, as mock-llm.ts: no later 127.0.0.1 listener can take this port and its requests
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as { model: string; messages: ChatMessage[] };
      seen.push({ auth: req.headers.get("authorization"), body });
      if (mode === "fail") return new Response(`rejected key ${KEY}`, { status: 401 });
      if (mode === "empty") return Response.json({ choices: [{ message: { content: "  " } }] });
      return Response.json({ choices: [{ message: { content: `echo:${body.messages.at(-1)!.content}` } }] });
    },
  });
});

afterAll(() => {
  server.stop(true);
});

beforeEach(() => {
  mode = "ok";
  seen = [];
});

const config = () => ({
  apiKey: KEY,
  baseUrl: `http://127.0.0.1:${server.port}`,
  model: "deepseek/deepseek-v4.1-flash-eco",
});

const contents = (i: number) => seen[i]!.body.messages.map((m) => `${m.role}:${m.content}`);

test("chat sends the bearer key, model and messages, and returns the reply", async () => {
  const reply = await chat([{ role: "user", content: "안녕" }], { config: config() });
  expect(reply).toBe("echo:안녕");
  expect(seen[0]!.auth).toBe(`Bearer ${KEY}`);
  expect(seen[0]!.body.model).toBe("deepseek/deepseek-v4.1-flash-eco");
});

test("non-200 throws UpstreamError with the status and the key redacted", async () => {
  mode = "fail";
  const err = await chat([{ role: "user", content: "x" }], { config: config() }).catch((e) => e);
  expect(err).toBeInstanceOf(UpstreamError);
  expect((err as UpstreamError).status).toBe(401);
  expect((err as Error).message).not.toContain(KEY);
  expect((err as Error).message).toContain("[redacted]");
});

test("an empty completion is an error, not a blank reply", async () => {
  mode = "empty";
  await expect(chat([{ role: "user", content: "x" }], { config: config() })).rejects.toThrow(/empty completion/);
});

test("a session carries history across turns", async () => {
  const s = createSession({ userId: "u", systemPrompt: "SYS", config: config() });
  await s.send("one");
  await s.send("two");
  expect(contents(1)).toEqual(["system:SYS", "user:one", "assistant:echo:one", "user:two"]);
});

test("a failed turn leaves no dangling user message", async () => {
  const s = createSession({ userId: "u", systemPrompt: "SYS", config: config() });
  await s.send("one");
  mode = "fail";
  await expect(s.send("lost")).rejects.toThrow();
  mode = "ok";
  await s.send("three");
  expect(contents(2)).toEqual(["system:SYS", "user:one", "assistant:echo:one", "user:three"]);
  expect(s.history().length).toBe(4);
});

test("history is capped at maxHistory, keeping whole user/assistant pairs", async () => {
  const s = createSession({ userId: "u", systemPrompt: "SYS", config: config(), maxHistory: 4 });
  for (const t of ["a", "b", "c"]) await s.send(t);
  await s.send("d");
  expect(contents(3)).toEqual(["system:SYS", "user:b", "assistant:echo:b", "user:c", "assistant:echo:c", "user:d"]);
});

test("loadConfig defaults to the prefixed ultrafast model and trims the base URL", () => {
  const c = loadConfig({ OPENGATEWAY_API_KEY: "k", OPENGATEWAY_BASE_URL: "https://x.test/v1/" });
  expect(c.model).toBe("deepseek/deepseek-v4.1-flash-ultrafast");
  expect(c.baseUrl).toBe("https://x.test/v1");
  expect(() => loadConfig({})).toThrow(/OPENGATEWAY_API_KEY/);
});
