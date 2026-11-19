import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AccessRecord, AgentEvent, ApprovalCard, Message } from "@pickle/protocol";
import type { LlmToolCall } from "@pickle/agent";
import { makeHarness, outcome, readSse, type Harness } from "./helpers.ts";

let h: Harness;
beforeEach(async () => {
  h = await makeHarness();
});
afterEach(async () => {
  await h.close();
});

const call: LlmToolCall = { id: "call_send", type: "function", function: { name: "msg_send", arguments: '{"provider":"slack","chat":"#general","text":"점심 12시"}' } };
const spec = { title: "슬랙 #general에 '점심 12시'를 보낼까요?", detail: "#general 채널에 메시지를 보내요" };

/** First turn pauses for approval exactly like @pickle/agent does (provisional approvalId = call.id). */
async function pause(token: string, threadId: string) {
  h.turns.set(async (_input, emit) => {
    const card: ApprovalCard = { type: "approval", approvalId: call.id, title: spec.title, detail: spec.detail, status: "pending" };
    emit({ type: "tool", tool: { id: call.id, name: "msg_send", title: "슬랙에 보내기", state: "needs_approval", startedAt: 1 } });
    emit({ type: "card", card });
    emit({ type: "text", delta: "보내기 전에 확인할게요." });
    return {
      text: "보내기 전에 확인할게요.",
      cards: [card],
      tools: [{ id: call.id, name: "msg_send", title: "슬랙에 보내기", state: "needs_approval", startedAt: 1 }],
      messages: [],
      usage: { promptTokens: 50, completionTokens: 10, totalTokens: 60 },
      pendingApproval: {
        call,
        spec,
        messages: [{ role: "assistant", content: "보내기 전에 확인할게요.", tool_calls: [call] }],
      },
    };
  });
  const events = await readSse(await h.req("POST", `/api/threads/${threadId}/messages`, { token, body: { text: "슬랙에 점심 12시라고 보내줘" } }));
  const done = events.at(-1) as Extract<AgentEvent, { type: "done" }>;
  expect(done.type).toBe("done");
  const card = done.message.cards.find((c) => c.type === "approval") as ApprovalCard;
  expect(card.approvalId).toStartWith("ap_");
  expect(card.approvalId).not.toBe(call.id);
  expect(card.status).toBe("pending");
  return { approvalId: card.approvalId, messageId: done.message.id };
}

describe("approvals", () => {
  test("approve with a real device signature → resumed SSE + deviceVerified access record", async () => {
    const { token, session, device } = await h.signup("haneul");
    const tid = session.mainThreadId;
    const { approvalId, messageId } = await pause(token, tid);

    let resumeSeen: unknown = null;
    h.turns.set(async (input, emit) => {
      resumeSeen = input.resume;
      expect(input.userText).toBeNull();
      emit({ type: "tool", tool: { id: call.id, name: "msg_send", title: "슬랙에 보내기", state: "done", summary: "보냈어요", startedAt: 1, endedAt: 2 } });
      emit({ type: "text", delta: "슬랙에 보냈어요." });
      return outcome("슬랙에 보냈어요.", {
        messages: [
          { role: "assistant", content: "보내기 전에 확인할게요.", tool_calls: [call] },
          { role: "tool", tool_call_id: call.id, content: '{"ok":true}' },
          { role: "assistant", content: "슬랙에 보냈어요." },
        ],
      });
    });

    const nonce = crypto.randomUUID();
    const signature = await device.sign(`approve:${approvalId}:${nonce}`);
    const res = await h.req("POST", `/api/approvals/${approvalId}`, { token, body: { decision: "approve", signature, nonce, deviceId: device.id } });
    expect(res.status).toBe(200);
    const events = await readSse(res);
    expect(events.map((e) => e.type)).toEqual(["start", "tool", "text", "done"]);
    expect((events[0] as { userMessage: unknown }).userMessage).toBeNull();
    expect(resumeSeen).toMatchObject({ call, decision: "approve", priorMessages: [{ role: "assistant", tool_calls: [call] }] });

    // access log: approval, signed by this device
    const log = (await (await h.req("GET", "/api/access-log", { token })).json()) as AccessRecord[];
    expect(log[0]).toMatchObject({ action: "approval", purpose: spec.title, actor: "user", outcome: "ok", deviceVerified: true, service: "slack", serviceName: "Slack" });

    // the stored approval card flipped to approved
    const msgs = (await (await h.req("GET", `/api/threads/${tid}/messages`, { token })).json()) as Message[];
    const paused = msgs.find((m) => m.id === messageId)!;
    expect((paused.cards[0] as ApprovalCard).status).toBe("approved");
    // the decision's moment rides on the stored card, so the receipt's time survives a reload
    expect((paused.cards[0] as ApprovalCard).decidedAt).toBe(h.clock.now());
    expect(msgs.at(-1)!.text).toBe("슬랙에 보냈어요.");

    // decided twice → 409
    const again = await h.req("POST", `/api/approvals/${approvalId}`, { token, body: { decision: "approve" } });
    expect(again.status).toBe(409);

    // later history: valid assistant(tool_calls) → tool adjacency, no duplicate call
    h.turns.set(async () => outcome("네"));
    await readSse(await h.req("POST", `/api/threads/${tid}/messages`, { token, body: { text: "고마워" } }));
    const hist = h.turns.inputs.at(-1)!.history;
    const callIdx = hist.findIndex((m) => m.role === "assistant" && m.tool_calls?.length);
    expect(hist.filter((m) => m.role === "assistant" && m.tool_calls?.length)).toHaveLength(1);
    expect(hist[callIdx + 1]).toMatchObject({ role: "tool", tool_call_id: call.id });
  });

  test("reject without signature records a denied, unverified decision", async () => {
    const { token, session } = await h.signup("haneul");
    const { approvalId } = await pause(token, session.mainThreadId);
    h.turns.set(async (input) => {
      expect(input.resume?.decision).toBe("reject");
      return outcome("알겠어요, 보내지 않을게요.");
    });
    const events = await readSse(await h.req("POST", `/api/approvals/${approvalId}`, { token, body: { decision: "reject" } }));
    expect(events.at(-1)!.type).toBe("done");
    const log = (await (await h.req("GET", "/api/access-log", { token })).json()) as AccessRecord[];
    expect(log[0]).toMatchObject({ action: "approval", outcome: "denied", deviceVerified: false });
  });

  test("bad signature → 403 and the approval stays pending", async () => {
    const { token, session, device } = await h.signup("haneul");
    const { approvalId } = await pause(token, session.mainThreadId);
    const nonce = "n1";
    const wrongSig = await device.sign(`approve:someone-else:${nonce}`);
    const res = await h.req("POST", `/api/approvals/${approvalId}`, { token, body: { decision: "approve", signature: wrongSig, nonce, deviceId: device.id } });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("bad_signature");
    const unknownDevice = await h.req("POST", `/api/approvals/${approvalId}`, { token, body: { decision: "approve", signature: wrongSig, nonce, deviceId: "dev_unknown_123" } });
    expect(unknownDevice.status).toBe(400);
    h.turns.set(async () => outcome("ok"));
    const ok = await h.req("POST", `/api/approvals/${approvalId}`, { token, body: { decision: "approve" } });
    expect(ok.status).toBe(200);
    await readSse(ok);
  });

  test("approvals expire after 30 minutes and are owner-scoped", async () => {
    const { token, session } = await h.signup("haneul");
    const other = await h.signup("other");
    const { approvalId, messageId } = await pause(token, session.mainThreadId);
    expect((await h.req("POST", `/api/approvals/${approvalId}`, { token: other.token, body: { decision: "approve" } })).status).toBe(404);
    h.clock.t += 31 * 60 * 1000;
    const res = await h.req("POST", `/api/approvals/${approvalId}`, { token, body: { decision: "approve" } });
    expect(res.status).toBe(410);
    const msgs = (await (await h.req("GET", `/api/threads/${session.mainThreadId}/messages`, { token })).json()) as Message[];
    expect((msgs.find((m) => m.id === messageId)!.cards[0] as ApprovalCard).status).toBe("expired");
    expect((msgs.find((m) => m.id === messageId)!.cards[0] as ApprovalCard).decidedAt).toBeUndefined(); // an expiry is not a decision
  });
});
