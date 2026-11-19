/** Scriptable local mock of the OpenAI-compatible /chat/completions API (streaming + JSON). */
import type { LlmMessage, ToolContext, ToolStore } from "../src/index.ts";

export interface ScriptedCall {
  id?: string;
  name: string;
  /** whole arguments string, or pre-chunked pieces */
  args: string | string[];
}

export interface ScriptedReply {
  status?: number;
  errorBody?: string;
  reasoning?: string[];
  text?: string[];
  toolCalls?: ScriptedCall[];
  /** round-robin the argument chunks of parallel calls */
  interleave?: boolean;
  /** send each call whole, without `index` (some providers do this) */
  noIndex?: boolean;
  /** false → no usage chunk (client must estimate) */
  usage?: boolean;
  /** delay between SSE chunks */
  delayMs?: number;
  /** stop sending after the first chunk and never close (for abort tests) */
  hang?: boolean;
  finishReason?: string;
}

export interface SeenRequest {
  auth: string | null;
  body: { model: string; messages: (LlmMessage & { reasoning_content?: string })[]; tools?: { function: { name: string } }[]; tool_choice?: string; stream?: boolean; stream_options?: unknown; thinking?: unknown; response_format?: unknown };
}

export interface MockLlm {
  url: string;
  requests: SeenRequest[];
  script: (ScriptedReply | ((req: SeenRequest, i: number) => ScriptedReply))[];
  fallback: ScriptedReply;
  stop(): void;
}

const enc = new TextEncoder();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function chunksOf(args: string | string[]): string[] {
  if (Array.isArray(args)) return args;
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 7) out.push(args.slice(i, i + 7));
  return out.length ? out : [""];
}

export function startMockLlm(): MockLlm {
  const mock: MockLlm = {
    url: "",
    requests: [],
    script: [],
    fallback: { text: ["(no script)"] },
    stop: () => server.stop(true),
  };
  // 127.0.0.1, not every address: a server listening on all of them shares its port with a later 127.0.0.1 listener,
  // which then answers every request sent to 127.0.0.1 (29 loop tests got 404 "not found" in a full run on 11-19)
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 30,
    async fetch(req) {
      const body = (await req.json()) as SeenRequest["body"];
      const seen: SeenRequest = { auth: req.headers.get("authorization"), body };
      const i = mock.requests.length;
      mock.requests.push(seen);
      const entry = mock.script.shift() ?? mock.fallback;
      const r = typeof entry === "function" ? entry(seen, i) : entry;
      if (r.status && r.status >= 400) return new Response(r.errorBody ?? "error", { status: r.status });

      const calls = (r.toolCalls ?? []).map((c, k) => ({ id: c.id ?? `call_${i}_${k}`, name: c.name, chunks: chunksOf(c.args) }));
      const usage = { prompt_tokens: 100 + i, completion_tokens: 20, total_tokens: 120 + i };
      const finish = r.finishReason ?? (calls.length ? "tool_calls" : "stop");

      if (body.stream === false) {
        return Response.json({
          choices: [
            {
              index: 0,
              finish_reason: finish,
              message: {
                role: "assistant",
                content: (r.text ?? []).join("") || null,
                reasoning_content: (r.reasoning ?? []).join("") || undefined,
                tool_calls: calls.length ? calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.chunks.join("") } })) : undefined,
              },
            },
          ],
          ...(r.usage === false ? {} : { usage }),
        });
      }

      const events: unknown[] = [{ choices: [{ index: 0, delta: { role: "assistant" } }] }];
      for (const d of r.reasoning ?? []) events.push({ choices: [{ index: 0, delta: { reasoning_content: d } }] });
      for (const d of r.text ?? []) events.push({ choices: [{ index: 0, delta: { content: d } }] });
      if (r.noIndex) {
        calls.forEach((c) => events.push({ choices: [{ index: 0, delta: { tool_calls: [{ id: c.id, type: "function", function: { name: c.name, arguments: c.chunks.join("") } }] } }] }));
      } else {
        calls.forEach((c, k) =>
          events.push({ choices: [{ index: 0, delta: { tool_calls: [{ index: k, id: c.id, type: "function", function: { name: c.name, arguments: "" } }] } }] }),
        );
      }
      if (r.noIndex) {
        /* already sent */
      } else if (r.interleave) {
        const max = Math.max(0, ...calls.map((c) => c.chunks.length));
        for (let j = 0; j < max; j++)
          calls.forEach((c, k) => {
            if (j < c.chunks.length) events.push({ choices: [{ index: 0, delta: { tool_calls: [{ index: k, function: { arguments: c.chunks[j] } }] } }] });
          });
      } else {
        calls.forEach((c, k) => c.chunks.forEach((a) => events.push({ choices: [{ index: 0, delta: { tool_calls: [{ index: k, function: { arguments: a } }] } }] })));
      }
      events.push({ choices: [{ index: 0, delta: {}, finish_reason: finish }] });
      if (r.usage !== false) events.push({ choices: [], usage });

      const stream = new ReadableStream<Uint8Array>({
        async start(ctl) {
          ctl.enqueue(enc.encode(": keep-alive\n\n"));
          let n = 0;
          for (const e of events) {
            // alternate "data:" and "data: " like OpenGateway (no space) and OpenAI (space)
            ctl.enqueue(enc.encode(`${n++ % 2 ? "data: " : "data:"}${JSON.stringify(e)}\n\n`));
            if (r.hang) return; // never close
            if (r.delayMs) await sleep(r.delayMs);
          }
          ctl.enqueue(enc.encode("data:[DONE]\n\n"));
          ctl.close();
        },
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    },
  });
  mock.url = `http://127.0.0.1:${server.port}`;
  return mock;
}

export interface FakeStore extends ToolStore {
  facts: string[];
  artifacts: { id: string; title: string; kind: string; content: string }[];
  schedules: { id: string; title: string; prompt: string; rule: string }[];
  friendMessages: { to: string; text: string }[];
}

export function fakeStore(): FakeStore {
  const kv = new Map<string, string>();
  const s: FakeStore = {
    facts: [],
    artifacts: [],
    schedules: [],
    friendMessages: [],
    async createArtifact(a, opts) {
      const id = `art_${s.artifacts.length + 1}`;
      s.artifacts.push({ id, ...a, ...(opts ? { opts } : {}) });
      return { id };
    },
    async createSchedule(x) {
      const id = `sch_${s.schedules.length + 1}`;
      s.schedules.push({ id, ...x });
      return { id, human: x.rule.startsWith("daily@") ? `매일 ${x.rule.slice(6)}` : x.rule, nextRunAt: Date.now() + 1000 };
    },
    async listSchedules() {
      return s.schedules.map((x) => ({ id: x.id, title: x.title, human: x.rule, enabled: true }));
    },
    async deleteSchedule(id) {
      const n = s.schedules.length;
      s.schedules = s.schedules.filter((x) => x.id !== id);
      return s.schedules.length < n;
    },
    async remember(text) {
      s.facts.push(text);
    },
    async recall(q) {
      return s.facts.filter((f) => q.split(/\s+/).some((w) => f.includes(w)));
    },
    async messageFriend(to, text) {
      s.friendMessages.push({ to, text });
      return { ok: true, detail: "delivered" };
    },
    async listFriends() {
      return [{ handle: "jinwoo", displayName: "진우", agentName: "몽이" }];
    },
    kv: { get: async (k) => kv.get(k) ?? null, set: async (k, v) => void kv.set(k, v) },
  };
  return s;
}

export function fakeCtx(over: Partial<ToolContext> = {}): ToolContext & { statuses: string[] } {
  const statuses: string[] = [];
  return {
    userId: "u1",
    threadId: "t1",
    agentName: "깽이",
    displayName: "하늘",
    workspaceDir: "/tmp/nowhere",
    signal: new AbortController().signal,
    credentials: {
      find: async () => null,
      use: async () => {
        throw new Error("no credentials in tests");
      },
    },
    store: fakeStore(),
    status: (t: string) => void statuses.push(t),
    now: () => new Date("2026-11-11T09:30:00Z"),
    statuses,
    ...over,
  };
}
