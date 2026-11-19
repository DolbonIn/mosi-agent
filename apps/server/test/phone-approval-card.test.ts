/**
 * sys_phone_call approval card: the card carries the full callee number (`call.number`, national format) so the
 * person can check it before approving; title / detail (what the model's history and the logs see) stay masked.
 * Runs the real agent loop and the real sys_phone_call tool with a scripted model.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createRunTurn, type LlmClient, type LlmChunk, type ToolContext } from "@pickle/agent";
import type { AgentEvent, ApprovalCard, Message } from "@pickle/protocol";
import type { Logger } from "../src/log.ts";
import { formatPhone, normalizePhone, phoneTool } from "../src/phone.ts";
import { makeHarness, outcome, readSse, type Harness } from "./helpers.ts";

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

/** first model call asks for sys_phone_call with `args`, the next one just answers */
function scriptedModel(args: Record<string, string>): LlmClient {
  let n = 0;
  return {
    async *stream(): AsyncGenerator<LlmChunk> {
      if (n++ === 0) {
        yield { type: "tool_calls", calls: [{ id: "call_p1", type: "function", function: { name: "sys_phone_call", arguments: JSON.stringify(args) } }] };
        yield { type: "finish", reason: "tool_calls" };
      } else {
        yield { type: "text", delta: "알겠어요." };
        yield { type: "finish", reason: "stop" };
      }
    },
  } as unknown as LlmClient;
}

function captureLogs(h: Harness): string[] {
  const lines: string[] = [];
  const rec = (level: string) => (event: string, fields?: Record<string, unknown>) => void lines.push(`${level} ${event} ${JSON.stringify(fields ?? {})}`);
  h.app.core.log = { info: rec("info"), warn: rec("warn"), error: rec("error") } as Logger;
  return lines;
}

const ctx = (userId: string) => ({ userId, threadId: "t_x", agentName: "모시", displayName: "하늘", signal: new AbortController().signal, status() {}, now: () => new Date() }) as unknown as ToolContext;

describe("formatPhone (card only)", () => {
  test("Korean mobile, Seoul, area codes, 070, 050x; North America; others stay E.164", () => {
    const cases: [string, string][] = [
      ["010-1234-5678", "010-1234-5678"],
      ["01012345678", "010-1234-5678"],
      ["+82 10 1234 5678", "010-1234-5678"],
      ["011-123-4567", "011-123-4567"],
      ["02-123-4567", "02-123-4567"],
      ["02-1234-1234", "02-1234-1234"],
      ["031-123-4567", "031-123-4567"],
      ["031-1234-5678", "031-1234-5678"],
      ["070-1234-5678", "070-1234-5678"],
      ["0505-123-4567", "0505-123-4567"],
      ["+1 415 555 0123", "+1 415-555-0123"],
      ["+44 20 7946 0958", "+442079460958"],
    ];
    for (const [raw, want] of cases) expect([raw, formatPhone(normalizePhone(raw)!)]).toEqual([raw, want]);
  });
});

describe("sys_phone_call approval spec", () => {
  test("call: target, full number, message, digits; title/detail masked", async () => {
    h = await makeHarness();
    const { session } = await h.signup("haneul");
    const tool = phoneTool(h.app.core);
    const spec = tool.approval!({ to: "02-1234-1234", message: "예약 확인 부탁드려요", name: "단아" }, ctx(session.user.id))!;
    expect(spec.call).toEqual({ target: "단아님", number: "02-1234-1234", message: "예약 확인 부탁드려요" });
    expect(spec.title).toBe("단아님께 전화할까요?");
    expect(spec.detail).toContain("02-****-1234");
    expect(spec.title + spec.detail).not.toContain("1234-1234");

    const meeting = tool.approval!({ to: "+1 415 555 0123", message: "모시예요, 받아 적을게요", name: "relay daily 회의", digits: "463394124#" }, ctx(session.user.id))!;
    expect(meeting.call).toEqual({ target: "relay daily 회의", number: "+1 415-555-0123", message: "모시예요, 받아 적을게요", digits: "463394124#" });

    const noName = tool.approval!({ to: "010-9876-5432", message: "안녕하세요" }, ctx(session.user.id))!;
    expect(noName.call).toMatchObject({ target: null, number: "010-9876-5432" });
    expect(noName.title).toBe("010-****-5432에 전화할까요?");

    const bad = tool.approval!({ to: "12345", message: "안녕하세요", name: "진우" }, ctx(session.user.id))!;
    expect(bad.call).toMatchObject({ target: "진우님", number: null });
  });
});

describe("who the call is to: 께 only for a person", () => {
  test("a business, a shop branch or a public office gets no 님 and 에; people keep 님께; a meeting line 에 전화로 참여", async () => {
    h = await makeHarness();
    const { session } = await h.signup("haneul");
    const tool = phoneTool(h.app.core);
    const title = (name: string) => tool.approval!({ to: "02-1234-1234", message: "예약 확인 부탁드려요", name }, ctx(session.user.id))!.title;
    const thread = (name: string) => tool.title!({ to: "02-1234-1234", message: "예약 확인 부탁드려요", name });
    const places = ["연세바른치과", "서울아산병원", "스타벅스 강남점", "서초구청", "강남세브란스 피부과", "OO부동산", "Yonsei Dental", "모시 주식회사", "우리은행", "새봄 미용실", "삼성전자 서비스센터"];
    for (const n of places) {
      expect([n, title(n)]).toEqual([n, `${n}에 전화할까요?`]);
      expect([n, thread(n)]).toEqual([n, `${n}에 전화`]);
      expect(tool.approval!({ to: "02-1234-1234", message: "네", name: n }, ctx(session.user.id))!.call!.target).toBe(n);
    }
    // given names that end in syllables like 서/원/국/점 are still people
    for (const n of ["단아", "민서", "지원", "민국", "김대리", "Marco", "진우님"]) {
      const bare = n.replace(/님$/, "");
      expect([n, title(n)]).toEqual([n, `${bare}님께 전화할까요?`]);
      expect([n, thread(n)]).toEqual([n, `${bare}님께 전화`]);
    }
    expect(title("relay daily 회의")).toBe("relay daily 회의에 전화로 참여할까요?");
    expect(thread("relay daily 회의")).toBe("relay daily 회의 전화 참여");
  });
});

describe("approval card through a real turn", () => {
  test("the card (live and stored) has the full number; the logs and the card's title/detail never do", async () => {
    h = await makeHarness();
    const logs = captureLogs(h);
    const { token, session } = await h.signup("haneul");
    const tid = session.mainThreadId;
    h.turns.set((input, emit) => createRunTurn(scriptedModel({ to: "010-1234-5678", message: "점심 맛있게 드세요", name: "단아" }))(input, emit));
    const events = await readSse(await h.req("POST", `/api/threads/${tid}/messages`, { token, body: { text: "단아한테 전화해서 점심 맛있게 드시라고 해줘" } }));

    const live = events.find((e) => e.type === "card") as Extract<AgentEvent, { type: "card" }> | undefined;
    expect(live?.card).toMatchObject({ type: "approval", call: { target: "단아님", number: "010-1234-5678", message: "점심 맛있게 드세요" } });
    const done = events.at(-1) as Extract<AgentEvent, { type: "done" }>;
    const card = done.message.cards.find((c) => c.type === "approval") as ApprovalCard;
    expect(card.approvalId).toStartWith("ap_");
    expect(card).toMatchObject({ title: "단아님께 전화할까요?", status: "pending", call: { number: "010-1234-5678" } });
    expect(card.title + card.detail).not.toContain("1234-5678");

    // stored: a reload shows the same card; deciding keeps the number on it
    const res = await h.req("POST", `/api/approvals/${card.approvalId}`, { token, body: { decision: "reject" } });
    expect(res.status).toBe(200);
    await readSse(res);
    const msgs = (await (await h.req("GET", `/api/threads/${tid}/messages`, { token })).json()) as Message[];
    const stored = msgs.flatMap((m) => m.cards).find((c) => c.type === "approval") as ApprovalCard;
    expect(stored).toMatchObject({ status: "rejected", call: { target: "단아님", number: "010-1234-5678" } });

    expect(logs.join("\n")).not.toContain("1234-5678");
  });

  test("older cards and other tools: no `call` key", async () => {
    h = await makeHarness();
    const { token, session } = await h.signup("haneul");
    const call = { id: "call_send", type: "function" as const, function: { name: "msg_send", arguments: "{}" } };
    // a turn that paused without emitting its card (the server builds it from the spec, as for stored approvals)
    h.turns.set(async () => ({ ...outcome("확인할게요"), messages: [], pendingApproval: { call, spec: { title: "보낼까요?", detail: "#general" }, messages: [] } }));
    const events = await readSse(await h.req("POST", `/api/threads/${session.mainThreadId}/messages`, { token, body: { text: "보내줘" } }));
    const done = events.at(-1) as Extract<AgentEvent, { type: "done" }>;
    const card = done.message.cards.find((c) => c.type === "approval")!;
    expect(card).toMatchObject({ type: "approval", title: "보낼까요?", status: "pending" });
    expect("call" in card).toBe(false);
  });
});
