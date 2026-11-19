/**
 * Chat tool deadline vs the turn idle watchdog (live bug 2026-11-12). Four parallel msg_read calls hung on a Slack 429.
 * The tool deadline and turnIdleTimeoutMs were both 60 s, so the watchdog ended the turn ("응답이 너무 늦어지고 있어요")
 * and the chips kept raw "실패: upstream timeout". Scaled down here: idle 600 ms, tool deadline 150 ms.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createRunTurn, TOOL_TIMEOUT_SUMMARY, type LlmChunk, type LlmClient, type LlmMessage, type ToolDef } from "@pickle/agent";
import type { AgentEvent, Message } from "@pickle/protocol";
import { CHAT_TOOL_TIMEOUT_MS, chatToolTimeoutMs, MAX_CHAT_TOOL_TIMEOUT_MS } from "../src/llm-policy.ts";
import { PHONE_TOOL_TIMEOUT_MS, phoneTools } from "../src/phone.ts";
import { makeHarness, readSse, type Harness } from "./helpers.ts";

const IDLE = 600;
const DEADLINE = 150;

/** msg_read on a Slack 429: never settles, ignores its signal */
const hang: ToolDef = {
  name: "msg_read",
  description: "read a chat",
  parameters: { type: "object", properties: { provider: { type: "string" }, chat: { type: "string" } } },
  icon: "chat",
  title: (a) => `슬랙 '${String(a.chat ?? "")}' 읽기`,
  run: () => new Promise(() => {}),
};

/** first call: the given msg_read calls; then the answer. Records what the model saw. */
function model(rooms: string[], answer: string) {
  const seen: LlmMessage[][] = [];
  const client = {
    async *stream(req: { messages: LlmMessage[] }): AsyncGenerator<LlmChunk> {
      seen.push(req.messages.map((m) => ({ ...m })));
      if (seen.length === 1) {
        yield { type: "tool_calls", calls: rooms.map((chat, i) => ({ id: `call_${i}`, type: "function" as const, function: { name: "msg_read", arguments: JSON.stringify({ provider: "slack", chat }) } })) };
        yield { type: "finish", reason: "tool_calls" };
      } else {
        yield { type: "text", delta: answer };
        yield { type: "finish", reason: "stop" };
      }
    },
  } as unknown as LlmClient;
  return { client, seen };
}

describe("chat tool deadline below the turn idle watchdog", () => {
  let h: Harness | null = null;
  afterEach(async () => {
    await h?.close();
    h = null;
  });

  async function send(rooms: string[], answer: string, toolTimeoutMs: number) {
    h = await makeHarness({ config: { turnIdleTimeoutMs: IDLE } });
    const { token, session } = await h.signup("haneul");
    const tid = session.mainThreadId;
    const m = model(rooms, answer);
    const run = createRunTurn(m.client, { toolTimeoutMs });
    h.turns.set((input, emit) => run({ ...input, tools: [hang] }, emit));
    const t0 = performance.now();
    const events = await readSse(await h.req("POST", `/api/threads/${tid}/messages`, { token, body: { text: "슬랙 채널들 읽어줘" } }));
    const ms = performance.now() - t0;
    await h.app.core.idle();
    const stored = (await (await h.req("GET", `/api/threads/${tid}/messages`, { token })).json()) as Message[];
    return { events, ms, stored, seen: m.seen };
  }

  test("the bug, reproduced: a tool deadline at the idle watchdog loses the whole turn", async () => {
    const { events } = await send(["#general"], "never", IDLE * 3);
    expect(events.map((e) => e.type)).toContain("error");
    expect((events.find((e) => e.type === "error") as { error: string }).error).toBe("upstream_timeout");
  });

  test("one hanging tool: the turn ends with the model's answer; the chip error is Korean", async () => {
    const answer = "슬랙이 응답하지 않아 #general을 읽지 못했어요. 잠시 후 다시 부탁해 주세요.";
    const { events, stored, seen } = await send(["#general"], answer, DEADLINE);
    expect(events.some((e) => e.type === "error")).toBe(false);
    const done = events.at(-1) as Extract<AgentEvent, { type: "done" }>;
    expect(done.type).toBe("done");
    expect(done.message.text).toBe(answer);
    expect(done.message.tools).toHaveLength(1);
    const chip = done.message.tools[0]!;
    expect(chip).toMatchObject({ name: "msg_read", state: "error", summary: TOOL_TIMEOUT_SUMMARY });
    expect(chip.endedAt! - chip.startedAt).toBeGreaterThanOrEqual(DEADLINE - 5);
    // persisted the same way
    const last = stored.at(-1)!;
    expect(last.text).toBe(answer);
    expect(last.tools.map((t) => [t.state, t.summary])).toEqual([["error", TOOL_TIMEOUT_SUMMARY]]);
    // the model was told why, so it can say what it couldn't read
    const toolMsg = seen[1]!.find((m) => m.role === "tool") as { content: string };
    expect(JSON.parse(toolMsg.content)).toMatchObject({ ok: false, data: { error: "timeout" } });
    expect(JSON.stringify(events)).not.toMatch(/upstream timeout|timed out after|실패:/);
  });

  test("four parallel hanging tools: one deadline in all, four Korean chips, one answer", async () => {
    const rooms = ["#general", "#random", "#dev", "#design"];
    const answer = "슬랙이 응답하지 않아 네 채널을 읽지 못했어요.";
    const { events, ms, stored } = await send(rooms, answer, DEADLINE);
    const done = events.at(-1) as Extract<AgentEvent, { type: "done" }>;
    expect(done.type).toBe("done");
    expect(done.message.text).toBe(answer);
    expect(done.message.tools.map((t) => [t.state, t.summary])).toEqual(rooms.map(() => ["error", TOOL_TIMEOUT_SUMMARY]));
    expect(ms).toBeLessThan(IDLE); // in parallel, and never the watchdog
    expect(stored.at(-1)!.tools).toHaveLength(4);
    expect(JSON.stringify(events)).not.toMatch(/upstream timeout|timed out after|실패:/);
  });
});

describe("chatToolTimeoutMs (PICKLE_TOOL_TIMEOUT_MS)", () => {
  test("default 25 s, below the default 60 s idle watchdog; clamped to 1–50 s", async () => {
    const h = await makeHarness();
    try {
      expect(h.app.core.cfg.turnIdleTimeoutMs).toBe(60_000);
      expect(chatToolTimeoutMs(undefined)).toBe(CHAT_TOOL_TIMEOUT_MS);
      expect(CHAT_TOOL_TIMEOUT_MS).toBe(25_000);
      expect(MAX_CHAT_TOOL_TIMEOUT_MS).toBeLessThan(h.app.core.cfg.turnIdleTimeoutMs);
    } finally {
      await h.close();
    }
    expect(chatToolTimeoutMs("")).toBe(25_000);
    expect(chatToolTimeoutMs("abc")).toBe(25_000);
    expect(chatToolTimeoutMs("-5")).toBe(25_000);
    expect(chatToolTimeoutMs("30000")).toBe(30_000);
    expect(chatToolTimeoutMs(" 12000 ")).toBe(12_000);
    expect(chatToolTimeoutMs("90000")).toBe(50_000);
    expect(chatToolTimeoutMs("10")).toBe(1_000);
  });

  test("the phone tools keep their own 60 s (voice synthesis, with status beats)", async () => {
    const h = await makeHarness();
    try {
      const tools = phoneTools(h.app.core);
      expect(tools.map((t) => [t.name, t.timeoutMs])).toEqual([
        ["sys_phone_call", PHONE_TOOL_TIMEOUT_MS],
        ["sys_call_me", PHONE_TOOL_TIMEOUT_MS],
      ]);
      expect(PHONE_TOOL_TIMEOUT_MS).toBe(60_000);
    } finally {
      await h.close();
    }
  });
});
