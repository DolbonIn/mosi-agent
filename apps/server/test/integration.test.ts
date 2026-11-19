/** Contracts with the finished packages (agent / launcher / vault / messengers / skills). */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AgentEvent, ApprovalCard, Message } from "@pickle/protocol";
import type { LlmMessage, LlmToolCall, TurnOutcome } from "@pickle/agent";
import { HISTORY_MAX_BYTES, trimHistory } from "../src/history.ts";
import { makeHarness, outcome, readSse, type Harness } from "./helpers.ts";

let h: Harness;
beforeEach(async () => {
  h = await makeHarness();
});
afterEach(async () => {
  await h.close();
});

const call: LlmToolCall = { id: "call_send", type: "function", function: { name: "msg_send", arguments: '{"provider":"slack","chat":"#general","text":"점심"}' } };

describe("agent contract", () => {
  test("the streamed approval card already carries the DB approval id", async () => {
    const { token, session } = await h.signup("haneul");
    h.turns.set(async (_i, emit) => {
      const card: ApprovalCard = { type: "approval", approvalId: call.id, title: "보낼까요?", detail: "", status: "pending" };
      emit({ type: "card", card });
      return { ...outcome("확인할게요", { cards: [card] }), messages: [], pendingApproval: { call, spec: { title: "보낼까요?", detail: "" }, messages: [] } };
    });
    const events = await readSse(await h.req("POST", `/api/threads/${session.mainThreadId}/messages`, { token, body: { text: "보내줘" } }));
    const streamed = (events.find((e) => e.type === "card") as Extract<AgentEvent, { type: "card" }>).card as ApprovalCard;
    const done = events.at(-1) as Extract<AgentEvent, { type: "done" }>;
    const persisted = done.message.cards.filter((c) => c.type === "approval") as ApprovalCard[];
    expect(persisted).toHaveLength(1);
    expect(streamed.approvalId).toStartWith("ap_");
    expect(streamed.approvalId).toBe(persisted[0]!.approvalId);
    h.turns.set(async () => outcome("보냈어요"));
    expect((await h.req("POST", `/api/approvals/${streamed.approvalId}`, { token, body: { decision: "approve" } })).status).toBe(200);
  });

  test("a rejected turn persists partialOutcome messages (an approved send that already ran)", async () => {
    const { token, session } = await h.signup("haneul");
    const done: LlmMessage[] = [
      { role: "assistant", content: null, tool_calls: [call] },
      { role: "tool", tool_call_id: call.id, content: '{"ok":true}' },
    ];
    const partials = new WeakMap<object, TurnOutcome>();
    h.app.core.deps.partialOutcome = (err) => (err && typeof err === "object" ? (partials.get(err) ?? null) : null);
    h.turns.set(async () => {
      const err = Object.assign(new Error("upstream 500"), { name: "UpstreamError", status: 500 });
      partials.set(err, {
        text: "",
        cards: [],
        tools: [{ id: call.id, name: "msg_send", title: "슬랙에 보내기", state: "done", summary: "보냈어요", startedAt: 1, endedAt: 2 }],
        messages: done,
        usage: { promptTokens: 300, completionTokens: 20, totalTokens: 320 },
      });
      throw err;
    });
    const events = await readSse(await h.req("POST", `/api/threads/${session.mainThreadId}/messages`, { token, body: { text: "보내줘" } }));
    expect(events.at(-1)).toMatchObject({ type: "error", error: "upstream_error" });
    const msgs = (await (await h.req("GET", `/api/threads/${session.mainThreadId}/messages`, { token })).json()) as Message[];
    expect(msgs.at(-1)!.tools[0]).toMatchObject({ name: "msg_send", state: "done" });
    const profile = (await (await h.req("GET", "/api/profile", { token })).json()) as { quota: { usedTokens: number } };
    expect(profile.quota.usedTokens).toBe(320);
    // the next turn's history includes the executed call, so the model won't send it again
    h.turns.set(async () => outcome("네"));
    await readSse(await h.req("POST", `/api/threads/${session.mainThreadId}/messages`, { token, body: { text: "보냈어?" } }));
    const hist = h.turns.inputs.at(-1)!.history;
    expect(hist.some((m) => m.role === "tool" && m.tool_call_id === call.id)).toBe(true);
  });

  test("history is capped by size on user boundaries and keeps the last user message", () => {
    const big = "가".repeat(3000); // ~9 KB per message in UTF-8
    const msgs: LlmMessage[] = [];
    for (let i = 0; i < 6; i++) msgs.push({ role: "user", content: `q${i} ${big}` }, { role: "assistant", content: `a${i}` });
    const t = trimHistory(msgs);
    expect(Buffer.byteLength(JSON.stringify(t))).toBeLessThanOrEqual(HISTORY_MAX_BYTES + 100);
    expect(t[0]!.role).toBe("user");
    expect(t.at(-1)).toEqual({ role: "assistant", content: "a5" });
    const huge: LlmMessage[] = [{ role: "user", content: "q " + "가".repeat(20_000) }];
    expect(trimHistory(huge)).toEqual(huge); // never drops the request itself
  });
});

describe("launcher contract", () => {
  test("signup provisions with every installed skill; an empty skill list is refused", async () => {
    type Init = { agentName: string; displayName: string; enabledSkills?: string[] };
    let init: Init | null = null;
    const orig = h.launcher.provision.bind(h.launcher);
    h.launcher.provision = async (id: string, i: Init) => {
      init = i;
      return orig(id, i);
    };
    const { token } = await h.signup("haneul");
    expect(init!.enabledSkills).toEqual(["k.weather"]);
    expect((await h.req("PATCH", "/api/agent", { token, body: { enabledSkills: [] } })).status).toBe(400);
  });
});

describe("vault / messengers contract", () => {
  test("setWrappedUserKey never overwrites an existing DEK", async () => {
    const { session } = await h.signup("haneul");
    const vs = h.db.vaultStorage();
    await vs.setWrappedUserKey(session.user.id, "first");
    await vs.setWrappedUserKey(session.user.id, "second");
    expect(await vs.getWrappedUserKey(session.user.id)).toBe("first");
  });

  test("package errors map to HTTP with their fixed Korean message", async () => {
    const { token } = await h.signup("haneul");
    const err = (name: string, code: string, message: string) => Object.assign(new Error(message), { name, code });
    h.app.core.deps.hub.connect = async () => {
      throw err("MessengerError", "invalid_request", "입력한 정보가 올바르지 않아요.");
    };
    const r1 = await h.req("POST", "/api/connections/slack", { token, body: {} });
    expect(r1.status).toBe(400);
    expect(await r1.json()).toEqual({ error: "invalid_request", message: "입력한 정보가 올바르지 않아요." });
    h.app.core.deps.hub.listChats = async () => {
      throw err("MessengerError", "not_connected", "아직 연결되지 않았어요.");
    };
    expect((await h.req("GET", "/api/connections/slack/chats", { token })).status).toBe(409);
    h.app.core.deps.hub.listChats = async () => {
      throw Object.assign(err("MessengerError", "rate_limited", "슬랙이 요청을 잠시 막았어요. 30초 뒤에 다시 시도해 주세요."), { retryAfter: 30 });
    };
    const rl = await h.req("GET", "/api/connections/slack/chats", { token });
    expect([rl.status, rl.headers.get("retry-after")]).toEqual([429, "30"]);
    expect(await rl.json()).toEqual({ error: "rate_limited", message: "슬랙이 요청을 잠시 막았어요. 30초 뒤에 다시 시도해 주세요." });
    h.app.core.deps.hub.connect = async () => {
      throw new Error("ECONNRESET at 10.0.0.1 token=abc");
    };
    const r3 = await h.req("POST", "/api/connections/slack", { token, body: {} });
    expect(r3.status).toBe(502);
    expect(((await r3.json()) as { message: string }).message).not.toContain("token");

    h.app.core.deps.vault.save = async () => {
      throw err("VaultError", "envelope_decrypt", "암호화된 정보를 풀 수 없어요.");
    };
    const uid = (await (await h.req("GET", "/api/session", { token })).json()) as { user: { id: string } };
    const envelope = { v: 1, alg: "ECDH-P256+HKDF-SHA256+A256GCM", kid: "kid-test", epk: { kty: "EC", crv: "P-256", x: "a", y: "b" }, iv: "aXY", ct: "Y3Q", aad: `${uid.user.id}:slack:token` };
    const r4 = await h.req("POST", "/api/credentials", { token, body: { service: "slack", label: "Slack", kind: "token", hint: "xoxp…", keepFor: "7d", envelope } });
    expect(r4.status).toBe(400);
    expect(await r4.json()).toEqual({ error: "invalid_envelope", message: "암호화된 정보를 풀 수 없어요." });
  });

  test("display_code verification can be polled without a code", async () => {
    const { token } = await h.signup("haneul");
    await h.req("POST", "/api/connections/kakaotalk", { token, body: {} });
    const poll = await h.req("POST", "/api/connections/kakaotalk/verify", { token, body: {} });
    expect(poll.status).toBe(200);
    expect((await h.req("POST", "/api/connections/kakaotalk/verify", { token, body: { code: "<script>" } })).status).toBe(400);
  });
});

describe("first-turn latency policy", () => {
  test("chat turns ask the model to skip hidden reasoning; an explicit value wins; private fields still work", async () => {
    const { thinkingMode, withThinking } = await import("../src/llm-policy.ts");
    class FakeClient {
      #seen: Record<string, unknown>[] = [];
      model = "m";
      async *stream(req: Record<string, unknown>) {
        this.#seen.push(req);
        yield { type: "text", delta: "hi" };
      }
      async complete(req: Record<string, unknown>) {
        this.#seen.push(req);
        return { content: "ok" };
      }
      seen() {
        return this.#seen;
      }
    }
    const real = new FakeClient();
    const c = withThinking(real, thinkingMode(undefined));
    for await (const _ of c.stream({ messages: [] })) void _;
    for await (const _ of c.stream({ messages: [], thinking: true })) void _;
    await c.complete({ messages: [] });
    expect(c.model).toBe("m");
    expect(real.seen().map((r) => r.thinking)).toEqual([false, true, false]);
    expect(withThinking(real, thinkingMode("on"))).toBe(real);
    expect(thinkingMode("provider")).toBe("provider");
    expect(thinkingMode("off")).toBe("off");
  });

  test("memory tools: hidden when memory is off, no recall until something is saved, never recall in shared threads", async () => {
    const def = (name: string) => ({ name, title: name, description: name, icon: "sparkles", parameters: { type: "object", properties: {} }, run: async () => ({ ok: true, summary: "" }) });
    h.app.core.deps.systemTools = () => [def("sys_time"), def("sys_remember"), def("sys_recall")] as never;
    const memoryAndSystem = new Set(["sys_time", "sys_remember", "sys_recall"]);
    const names = () => h.turns.inputs.at(-1)!.tools.map((t) => t.name).filter((n) => memoryAndSystem.has(n));
    const { token, session } = await h.signup("haneul");
    const send = async (text: string, tid = session.mainThreadId, tk = token) => readSse(await h.req("POST", `/api/threads/${tid}/messages`, { token: tk, body: { text } }));

    h.turns.set(async () => outcome("네"));
    await send("안녕");
    expect(names()).toEqual(["sys_time", "sys_remember"]); // new user: nothing to recall yet

    await h.launcher.remember(session.user.id, "판교에서 일해요");
    await send("오늘 날씨");
    expect(names()).toEqual(["sys_time", "sys_remember", "sys_recall"]);

    await h.req("PATCH", "/api/settings", { token, body: { privacy: { memoryEnabled: false } } });
    await send("또");
    expect(names()).toEqual(["sys_time"]);
    await h.req("PATCH", "/api/settings", { token, body: { privacy: { memoryEnabled: true } } });

    const b = await h.signup("bobby", { displayName: "진우", agentName: "콩이" });
    const inv = (await (await h.req("POST", "/api/invites", { token })).json()) as { token: string };
    const fr = (await (await h.req("POST", `/api/invites/${inv.token}/accept`, { token: b.token })).json()) as { threadId: string };
    await send("@깽이 안녕", fr.threadId);
    expect(names()).toEqual(["sys_time", "sys_remember"]);
  });
});
