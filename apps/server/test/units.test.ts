import { afterEach, describe, expect, test } from "bun:test";
import type { Thread } from "@pickle/protocol";
import type { LlmMessage, ToolContext } from "@pickle/agent";
import { sanitizeHistory, trimHistory } from "../src/history.ts";
import { nextQuotaReset, quotaDay } from "../src/kst.ts";
import { iGa, ieyo, wa } from "../src/util.ts";
import { sanitizeFilename } from "../src/archive.ts";
import { maskPhone, normalizeDigits, normalizePhone, phoneTool } from "../src/phone.ts";
import { makeHarness, type Harness } from "./helpers.ts";

const call = (id: string) => ({ id, type: "function" as const, function: { name: "k_weather", arguments: "{}" } });

describe("history sanitizer", () => {
  test("drops pending tool-call fragments and orphan tool results", () => {
    const msgs: LlmMessage[] = [
      { role: "system", content: "x" },
      { role: "user", content: "a" },
      { role: "assistant", content: "확인할게요", tool_calls: [call("c1")] }, // never answered
      { role: "user", content: "b" },
      { role: "tool", tool_call_id: "c1", content: "late" }, // not adjacent → dropped
      { role: "assistant", content: null, tool_calls: [call("c2")] },
      { role: "tool", tool_call_id: "c2", content: "ok" },
      { role: "assistant", content: "done" },
    ];
    expect(sanitizeHistory(msgs)).toEqual([
      { role: "user", content: "a" },
      { role: "assistant", content: "확인할게요" },
      { role: "user", content: "b" },
      { role: "assistant", content: null, tool_calls: [call("c2")] },
      { role: "tool", tool_call_id: "c2", content: "ok" },
      { role: "assistant", content: "done" },
    ]);
  });

  test("dedupes repeated tool calls (resume repeats priorMessages) and identical user turns", () => {
    const msgs: LlmMessage[] = [
      { role: "user", content: "a" },
      { role: "user", content: "a" },
      { role: "assistant", content: null, tool_calls: [call("c1")] },
      { role: "tool", tool_call_id: "c1", content: "1" },
      { role: "assistant", content: null, tool_calls: [call("c1")] },
      { role: "tool", tool_call_id: "c1", content: "1" },
      { role: "assistant", content: "fin" },
    ];
    const out = sanitizeHistory(msgs);
    expect(out.filter((m) => m.role === "tool")).toHaveLength(1);
    expect(out.filter((m) => m.role === "user")).toHaveLength(1);
  });

  test("trim never starts inside an assistant→tool block", () => {
    const msgs: LlmMessage[] = [];
    for (let i = 0; i < 20; i++) {
      msgs.push({ role: "user", content: `q${i}` });
      msgs.push({ role: "assistant", content: null, tool_calls: [call(`c${i}`)] });
      msgs.push({ role: "tool", tool_call_id: `c${i}`, content: "r" });
      msgs.push({ role: "assistant", content: `a${i}` });
    }
    const t = trimHistory(sanitizeHistory(msgs), 30);
    expect(t.length).toBeLessThanOrEqual(30);
    expect(t[0]!.role).toBe("user");
  });
});

describe("helpers", () => {
  test("quota day boundary is 04:00 KST", () => {
    expect(quotaDay(Date.UTC(2026, 10, 11, 18, 59))).toBe("2026-11-11"); // 03:59 KST 12th
    expect(quotaDay(Date.UTC(2026, 10, 11, 19, 0))).toBe("2026-11-12"); // 04:00 KST 12th
    expect(nextQuotaReset(Date.UTC(2026, 10, 11, 19, 0))).toBe(Date.UTC(2026, 10, 12, 19, 0));
    expect(nextQuotaReset(Date.UTC(2026, 10, 11, 18, 59))).toBe(Date.UTC(2026, 10, 11, 19, 0));
  });

  test("josa", () => {
    expect(wa("깽이")).toBe("깽이와");
    expect(wa("하늘")).toBe("하늘과");
    expect(iGa("콩이")).toBe("콩이가");
    expect(ieyo("깽이")).toBe("깽이예요");
    expect(ieyo("모시봇")).toBe("모시봇이에요");
  });

  test("filenames and phone numbers", () => {
    expect(sanitizeFilename("../../etc/passwd")).toBe("passwd");
    expect(sanitizeFilename('a<b>"c".txt')).toBe("abc.txt");
    expect(sanitizeFilename("")).toBe("file");
    expect(sanitizeFilename(".hidden")).toBe("hidden");
    expect(normalizePhone("010-1234-5678")).toBe("+821012345678");
    expect(normalizePhone("+1 (415) 555-0100")).toBe("+14155550100");
    expect(normalizePhone("12")).toBeNull();
    expect(normalizePhone("+8201055550000")).toBe("+821055550000");
    expect(normalizePhone("+82 10-5555-0000")).toBe("+821055550000");
    expect(maskPhone("+821012345678")).toBe("010-****-5678");
  });
});

describe("sys_phone_call", () => {
  let h: Harness;
  const realFetch = globalThis.fetch;
  afterEach(async () => {
    globalThis.fetch = realFetch;
    await h.close();
  });

  async function ctxFor(token: string, userId: string): Promise<ToolContext> {
    void token;
    return {
      userId,
      threadId: "t_x",
      agentName: "깽이",
      displayName: "하늘",
      workspaceDir: "/tmp",
      signal: new AbortController().signal,
      credentials: { find: async () => null, use: async () => Promise.reject(new Error("no")) },
      store: {} as ToolContext["store"],
      status() {},
      now: () => new Date(),
    };
  }

  test("approval-gated; without Twilio → ok:false + call thread", async () => {
    h = await makeHarness();
    const { token, session } = await h.signup("haneul", { agentName: "깽이" });
    const tool = phoneTool(h.app.core);
    const args = { to: "010-1234-5678", message: "점심 맛있게 드세요", name: "단아" };
    expect(tool.approval!(args, await ctxFor(token, session.user.id))).toMatchObject({ title: "단아님께 전화할까요?" });
    expect(tool.approval!(args, await ctxFor(token, session.user.id))!.detail).toContain("010-****-5678");
    const r = await tool.run(args, await ctxFor(token, session.user.id));
    expect(r).toMatchObject({ ok: false, summary: "전화 연결 서비스(Twilio)가 아직 설정되지 않았어요" });
    expect(JSON.stringify(r.data)).not.toContain("1234-5678");
    const threads = (await (await h.req("GET", "/api/threads", { token })).json()) as Thread[];
    expect(threads.find((t) => t.kind === "call")).toMatchObject({ title: "단아님께 전화", subtitle: "깽이의 외부 통화", unread: true });
  });

  test("with Twilio → POST Calls.json with inline ko-KR TwiML", async () => {
    h = await makeHarness({ config: { twilio: { accountSid: "AC123", authToken: "tok", from: "+15550000000" } } });
    const { token, session } = await h.signup("haneul");
    let seen: { url: string; body: string; auth: string } | null = null;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      seen = { url: String(url), body: String(init?.body), auth: new Headers(init?.headers).get("authorization") ?? "" };
      return new Response(JSON.stringify({ sid: "CA1", status: "queued" }), { status: 201 });
    }) as typeof fetch;
    const r = await phoneTool(h.app.core).run({ to: "01012345678", message: "안녕 <친구>" }, await ctxFor(token, session.user.id));
    expect(r.ok).toBe(true);
    expect(seen!.url).toBe("https://api.twilio.com/2010-04-01/Accounts/AC123/Calls.json");
    const params = new URLSearchParams(seen!.body);
    expect(params.get("To")).toBe("+821012345678");
    expect(params.get("Twiml")).toBe('<Response><Say language="ko-KR">안녕 &lt;친구&gt;</Say></Response>');
    expect(seen!.auth).toBe("Basic " + Buffer.from("AC123:tok").toString("base64"));
  });

  test("trial account: inline Twiml refused (code 0) → retried once with the Echo twimlet Url", async () => {
    h = await makeHarness({ config: { twilio: { accountSid: "AC123", authToken: "tok", from: "+15550000000" } } });
    const { token, session } = await h.signup("haneul");
    const bodies: URLSearchParams[] = [];
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      const p = new URLSearchParams(String(init?.body));
      bodies.push(p);
      if (p.has("Twiml")) return new Response(JSON.stringify({ code: 0, message: "trial accounts have limited parameter access" }), { status: 400 });
      return new Response(JSON.stringify({ sid: "CA3", status: "queued" }), { status: 201 });
    }) as typeof fetch;
    const r = await phoneTool(h.app.core).run({ to: "01012345678", message: "안녕" }, await ctxFor(token, session.user.id));
    expect(r.ok).toBe(true);
    expect(bodies.length).toBe(2);
    expect(bodies[1]!.get("Url")).toBe("https://twimlets.com/echo?Twiml=" + encodeURIComponent('<Response><Say language="ko-KR">안녕</Say></Response>'));
    expect(bodies[1]!.has("Method")).toBe(false);
    expect(bodies[1]!.has("Twiml")).toBe(false);
  });

  test("trial account: unverified recipient (573002) → retried once with the Korean number as verified (+82 0…)", async () => {
    h = await makeHarness({ config: { twilio: { accountSid: "AC123", authToken: "tok", from: "+15550000000" } } });
    const { token, session } = await h.signup("haneul");
    const tos: string[] = [];
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      const to = new URLSearchParams(String(init?.body)).get("To")!;
      tos.push(to);
      if (to === "+821012345678") return new Response(JSON.stringify({ code: 573002, message: "add the to number as a verified recipient" }), { status: 422 });
      return new Response(JSON.stringify({ sid: "CA4", status: "queued" }), { status: 201 });
    }) as typeof fetch;
    const r = await phoneTool(h.app.core).run({ to: "010-1234-5678", message: "안녕" }, await ctxFor(token, session.user.id));
    expect(r.ok).toBe(true);
    expect(tos).toEqual(["+821012345678", "+8201012345678"]);
  });

  test("meeting dial-in: presses the PIN after the greeting, then speaks", async () => {
    h = await makeHarness({ config: { twilio: { accountSid: "AC123", authToken: "tok", from: "+15550000000" } } });
    const { token, session } = await h.signup("haneul");
    let body = "";
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      body = String(init?.body);
      return new Response(JSON.stringify({ sid: "CA2", status: "queued" }), { status: 201 });
    }) as typeof fetch;
    const tool = phoneTool(h.app.core);
    const args = { to: "+1 636-373-8953", message: "테스트 전화예요", name: "relay daily 회의", digits: "463 394 124#" };
    const ctx = await ctxFor(token, session.user.id);
    expect(tool.approval!(args, ctx)).toMatchObject({ title: "relay daily 회의에 전화로 참여할까요?" });
    expect(tool.approval!(args, ctx)!.detail).toContain("+1 636-***-8953로 전화해서 연결되면 463394124#을 누른 뒤");
    expect((await tool.run(args, ctx)).ok).toBe(true);
    const params = new URLSearchParams(body);
    expect(params.get("To")).toBe("+16363738953");
    expect(params.get("Twiml")).toBe(
      '<Response><Pause length="4"/><Play digits="463394124#"/><Pause length="5"/><Say language="ko-KR">테스트 전화예요</Say><Pause length="1"/><Say language="ko-KR">테스트 전화예요</Say></Response>',
    );
    expect(normalizeDigits("12a")).toBeNull();
    expect(normalizeDigits(undefined)).toBe("");
    expect((await tool.run({ ...args, digits: "<x>" }, ctx)).ok).toBe(false);
  });
});

describe("quota charges cached prompt tokens at 10%", () => {
  test("billable()", async () => {
    const { billable } = await import("../src/turns.ts");
    expect(billable({ promptTokens: 10000, totalTokens: 10200 })).toBe(10200);
    expect(billable({ promptTokens: 10000, totalTokens: 10200, cachedTokens: 9000 })).toBe(2100);
    expect(billable({ promptTokens: 100, totalTokens: 150, cachedTokens: 999 })).toBe(60);
    expect(billable(null)).toBe(0);
  });
});
