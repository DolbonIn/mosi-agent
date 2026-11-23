/**
 * Drawer B fields on Thread: `preview` (the agent's latest line, first sentence, masked on the server) and `waiting`
 * (approval > call > meeting), in the list and in every `thread_updated` upsert.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createRunTurn, type LlmChunk, type LlmClient, type ToolContext } from "@pickle/agent";
import type { AgentEvent, ApprovalCard, ServerEvent, Thread, ThreadWaiting } from "@pickle/protocol";
import { phoneTool } from "../src/phone.ts";
import { clip, maskSensitive, PREVIEW_MAX, previewOf, WAITING_TEXT } from "../src/threadState.ts";
import { newId } from "../src/util.ts";
import { makeHarness, readSse, type Harness } from "./helpers.ts";

describe("previewOf: first sentence, markdown out, secrets masked", () => {
  test("masking: phone, email, meet code, codes, card, account, amounts; dates and times stay", () => {
    const cases: [string, string][] = [
      ["02-1234-1234로 전화해서 전했어요.", "02-****-1234로 전화해서 전했어요."],
      ["010 1234 5678로 걸었어요.", "010-****-5678로 걸었어요."],
      ["+82 10-1234-5678에 남겼어요.", "010-****-5678에 남겼어요."],
      ["+1 415 555 0123으로 걸었어요.", "+1 415-***-0123으로 걸었어요."],
      ["+44 20 7946 0958로 걸었어요.", "+44****0958로 걸었어요."],
      ["haneul.lee@example.com으로 보냈어요.", "h***@example.com으로 보냈어요."],
      ["회의 코드는 rak-wxyz-kud예요.", "회의 코드는 rak-****-kud예요."],
      ["인증번호는 482913이에요.", "인증번호는 ****이에요."],
      ["OTP: 1234 5678 입력했어요.", "OTP: **** 입력했어요."],
      ["카드 1234-5678-9012-3456로 결제했어요.", "카드 ****-3456로 결제했어요."],
      ["국민은행 123-45-678901로 보내 주세요.", "국민은행 ****-8901로 보내 주세요."],
      ["12,000원을 결제했어요.", "***원을 결제했어요."],
      ["3만 5천원이에요.", "***만 ***천원이에요."],
      ["$12.50 나왔어요.", "$*** 나왔어요."],
      ["주문번호 20261112345 확인했어요.", "주문번호 **** 확인했어요."],
      ["내일 오전 7:00에 보내 드릴게요.", "내일 오전 7:00에 보내 드릴게요."],
      ["토요일 리허설은 11월 15일 오후 2시예요.", "토요일 리허설은 11월 15일 오후 2시예요."],
      ["2026-11-12 회의를 정리했어요.", "2026-11-12 회의를 정리했어요."],
      ["QR코드 3개를 만들었어요.", "QR코드 3개를 만들었어요."],
      // already masked text stays as it is
      ["단아님(010-****-5678)께 전화를 걸었어요.", "단아님(010-****-5678)께 전화를 걸었어요."],
      ["Google Meet 회의(rak-****-kud)에 참여하러 갈게요.", "Google Meet 회의(rak-****-kud)에 참여하러 갈게요."],
    ];
    for (const [raw, want] of cases) expect([raw, previewOf(raw)]).toEqual([raw, want]);
  });

  test("no raw phone digits survive in any spelling", () => {
    const masked = maskSensitive("010-1234-5678 / 01012345678 / 010.1234.5678 / 02-123-4567 / 031-123-4567 / 070-1234-5678");
    for (const leak of ["1234-5678", "12345678", "1234.5678", "123-4567", "0101234"]) expect(masked).not.toContain(leak);
  });

  test("first sentence of the latest line; headings, list markers, links and status lines out", () => {
    expect(previewOf("날씨는 맑아요. 기온은 3.5도예요.")).toBe("날씨는 맑아요.");
    expect(previewOf("**회의 요약**\n\n- 출시는 다음 주 화요일로 미뤘어요.\n- 할 일 2개")).toBe("출시는 다음 주 화요일로 미뤘어요.");
    expect(previewOf("## 결과\n1. **이사 체크리스트**를 만들었어요. 확인해 보세요.")).toBe("이사 체크리스트를 만들었어요.");
    expect(previewOf("[첨부: a.pdf (application/pdf, 3KB)]\n요약했어요.")).toBe("요약했어요.");
    expect(previewOf("자세한 건 [여기](https://example.com/x?id=123456)에서 보세요!")).toBe("자세한 건 여기에서 보세요!");
    expect(previewOf("`sys_weather` 결과: 맑음")).toBe("sys_weather 결과: 맑음");
    expect(previewOf("   \n  ")).toBe("");
  });

  // a "*" right before VS16 or U+20E3 is the keycap "*️⃣" (U+002A U+FE0F U+20E3), as in the app's markdown.tsx
  test("the keycap *️⃣ keeps its \"*\": no italic or bold mark, and emphasis around it still goes", () => {
    expect(previewOf("*️⃣ 누르고 *️⃣ 다시 눌러요.")).toBe("*️⃣ 누르고 *️⃣ 다시 눌러요.");
    expect(previewOf("*⃣ 누르고 *⃣ 다시 눌러요.")).toBe("*⃣ 누르고 *⃣ 다시 눌러요."); // the keycap mark without VS16
    expect(previewOf("*️⃣ 누르고 *기울임* 확인")).toBe("*️⃣ 누르고 기울임 확인"); // never opens
    expect(previewOf("*a*️⃣ b")).toBe("*a*️⃣ b"); // never closes
    expect(previewOf("*누르기 *️⃣ 다음*")).toBe("누르기 *️⃣ 다음"); // sits inside an italic
    expect(previewOf("*기울임**️⃣ 다음")).toBe("기울임*️⃣ 다음"); // an italic may close right before it
    expect(previewOf("**️⃣를 누르세요* 그리고 **확인**해 주세요.")).toBe("*️⃣를 누르세요 그리고 확인해 주세요."); // "**" before VS16 opens no bold
    expect(previewOf("**확인 **️⃣ 메뉴** 안내")).toBe("확인 **️⃣ 메뉴 안내"); // … and closes none
    expect(previewOf("***️⃣ 메뉴** 안내")).toBe("*️⃣ 메뉴 안내");
    // a bold-only line holding a keycap is still a heading line
    expect(previewOf("***️⃣ 메뉴 안내**\n\n주문은 *️⃣를 누르면 돼요. 그다음")).toBe("주문은 *️⃣를 누르면 돼요.");
  });

  test("a \"*\" before a space never opens an italic, one after a space never closes it (as in the app's markdown)", () => {
    expect(previewOf("2 * 3 * 4예요.")).toBe("2 * 3 * 4예요.");
    expect(previewOf("*강조 * 다음")).toBe("*강조 * 다음");
    expect(previewOf("*별표 하나 *그리고")).toBe("*별표 하나 *그리고");
    expect(previewOf("a * b *c* 끝")).toBe("a * b c 끝");
    expect(previewOf("*강조* 그리고 *기울임*")).toBe("강조 그리고 기울임");
    expect(previewOf("*a*")).toBe("a");
    expect(previewOf("a * b* 끝")).toBe("a * b* 끝");
    // a keycap's "*" opens nothing either, also when a "*" after a word follows
    expect(previewOf("*️⃣ 누르고 다시*")).toBe("*️⃣ 누르고 다시*");
    expect(previewOf("*⃣ 누르고 다시*")).toBe("*⃣ 누르고 다시*");
  });

  test("≤60 chars, cut at a word boundary with …", () => {
    const long = "이번 주 토요일 오후 두 시에 대학로 연습실에서 리허설을 하고 끝나면 근처 식당에서 다 같이 저녁을 먹기로 했어요.";
    const p = previewOf(long);
    expect([...p].length).toBeLessThanOrEqual(PREVIEW_MAX);
    expect(p.endsWith("…")).toBe(true);
    expect(long.startsWith(p.slice(0, -1))).toBe(true);
    expect(long[p.length - 1]).toBe(" "); // cut where a word ends
    expect(clip("가".repeat(80))).toBe(`${"가".repeat(59)}…`); // one long word: a hard cut
  });
});

/** first model call asks for sys_phone_call, the next one just answers */
function phoneModel(args: Record<string, string>): LlmClient {
  let n = 0;
  return {
    async *stream(): AsyncGenerator<LlmChunk> {
      if (n++ === 0) {
        yield { type: "tool_calls", calls: [{ id: "call_w1", type: "function", function: { name: "sys_phone_call", arguments: JSON.stringify(args) } }] };
        yield { type: "finish", reason: "tool_calls" };
      } else {
        yield { type: "text", delta: "알겠어요." };
        yield { type: "finish", reason: "stop" };
      }
    },
  } as unknown as LlmClient;
}

/** every `thread_updated` the server publishes */
function recordUpserts(h: Harness): Thread[] {
  const out: Thread[] = [];
  const hub = h.app.core.events;
  const publish = hub.publish.bind(hub);
  hub.publish = (userId: string, ev: ServerEvent) => {
    if (ev.type === "thread_updated") out.push(ev.thread);
    return publish(userId, ev);
  };
  return out;
}

const listThreads = async (h: Harness, token: string) => (await (await h.req("GET", "/api/threads", { token })).json()) as Thread[];

describe("Thread.preview and Thread.waiting", () => {
  let h: Harness | null = null;
  const realFetch = globalThis.fetch;
  let release: (() => void) | null = null;
  let twilioCalls = 0;

  beforeAll(() => {
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).startsWith("https://api.twilio.com/")) {
        twilioCalls++;
        await new Promise<void>((r) => (release = r));
        return new Response(JSON.stringify({ sid: "CA1", status: "queued" }), { status: 201 });
      }
      return realFetch(url as string, init);
    }) as typeof fetch;
  });
  afterAll(() => {
    globalThis.fetch = realFetch;
  });
  afterEach(async () => {
    release?.();
    release = null;
    twilioCalls = 0;
    await h?.close();
    h = null;
  });

  test("a new user: the main thread previews the welcome's first sentence and waits on nothing", async () => {
    h = await makeHarness();
    const { token, session } = await h.signup("haneul");
    const main = (await listThreads(h, token)).find((t) => t.id === session.mainThreadId)!;
    expect(main.preview).toMatch(new RegExp(`^안녕하세요, ${session.user.displayName} 님[.!]$`)); // "." once the chat B copy lands
    expect(main.waiting).toBeNull();
    expect(main.subtitle).toBe("이런 일을 맡겨 보세요"); // the thread intro keeps its subtitle
  });

  test("approval: the thread waits (list + upsert) until it is decided; the number never shows", async () => {
    h = await makeHarness();
    const upserts = recordUpserts(h);
    const { token, session } = await h.signup("haneul");
    const tid = session.mainThreadId;
    const run = createRunTurn(phoneModel({ to: "010-1234-5678", message: "점심 맛있게 드세요", name: "단아" })); // one model: the resumed turn just answers
    h.turns.set((input, emit) => run(input, emit));
    const events = await readSse(await h.req("POST", `/api/threads/${tid}/messages`, { token, body: { text: "단아한테 전화해 줘" } }));
    const card = (events.at(-1) as Extract<AgentEvent, { type: "done" }>).message.cards.find((c) => c.type === "approval") as ApprovalCard;

    const waiting: ThreadWaiting = { kind: "approval", text: WAITING_TEXT.approvalCall };
    expect((await listThreads(h, token)).find((t) => t.id === tid)!.waiting).toEqual(waiting);
    expect(upserts.filter((t) => t.id === tid).at(-1)!.waiting).toEqual(waiting);

    const before = upserts.length;
    const res = await h.req("POST", `/api/approvals/${card.approvalId}`, { token, body: { decision: "reject" } });
    expect(res.status).toBe(200);
    await readSse(res);
    const after = upserts.slice(before).filter((t) => t.id === tid);
    expect(after.length).toBeGreaterThan(0);
    expect(after[0]!.waiting).toBeNull(); // the decision itself turns it off, before the resumed turn ends
    expect((await listThreads(h, token)).find((t) => t.id === tid)!.waiting).toBeNull();
    expect(JSON.stringify([upserts, await listThreads(h, token)])).not.toContain("1234-5678");
  });

  test("approval expiry: one upsert at the expiry time turns waiting off", async () => {
    h = await makeHarness();
    const upserts = recordUpserts(h);
    const { token, session } = await h.signup("haneul");
    const tid = session.mainThreadId;
    const core = h.app.core;
    const now = core.now();
    core.db.insertApproval({
      id: newId("ap"),
      userId: session.user.id,
      threadId: tid,
      messageId: newId("m"),
      callJson: JSON.stringify({ id: "c1", type: "function", function: { name: "msg_send", arguments: "{}" } }),
      priorJson: "[]",
      specJson: JSON.stringify({ title: "보낼까요?", detail: "" }),
      now,
      expiresAt: now + 100,
    });
    expect((await listThreads(h, token)).find((t) => t.id === tid)!.waiting).toEqual({ kind: "approval", text: WAITING_TEXT.approvalSend });
    h.clock.t = now + 200; // past expiry: computed off at once
    expect((await listThreads(h, token)).find((t) => t.id === tid)!.waiting).toBeNull();
    const n = upserts.length;
    await Bun.sleep(1_300); // the timer set by the first view fires ~1.1 s later
    expect(upserts.slice(n).find((t) => t.id === tid)?.waiting).toBeNull();
  });

  test("approval texts: meeting, payment, send", async () => {
    h = await makeHarness();
    const { token, session } = await h.signup("haneul");
    const core = h.app.core;
    const make = (spec: Record<string, unknown>, tool: string) => {
      const t = newId("t");
      core.db.createThread({ id: t, ownerId: session.user.id, kind: "task", title: "x", subtitle: "", icon: "chat", now: core.now() }, [session.user.id]);
      core.db.insertApproval({
        id: newId("ap"),
        userId: session.user.id,
        threadId: t,
        messageId: newId("m"),
        callJson: JSON.stringify({ id: "c", type: "function", function: { name: tool, arguments: "{}" } }),
        priorJson: "[]",
        specJson: JSON.stringify({ title: "?", detail: "", ...spec }),
        now: core.now(),
        expiresAt: core.now() + 60_000,
      });
      return t;
    };
    const meet = make({ meet: { code: "rak-wxyz-kud" } }, "sys_join_meet");
    const pay = make({ amount: 12_000 }, "pay_order");
    const send = make({}, "msg_send");
    const list = await listThreads(h, token);
    expect(list.find((t) => t.id === meet)!.waiting).toEqual({ kind: "approval", text: WAITING_TEXT.approvalMeet });
    expect(list.find((t) => t.id === pay)!.waiting).toEqual({ kind: "approval", text: WAITING_TEXT.approvalPay });
    expect(list.find((t) => t.id === send)!.waiting).toEqual({ kind: "approval", text: WAITING_TEXT.approvalSend });
    expect(JSON.stringify(list)).not.toContain("wxyz");
  });

  test("call: the call thread is published while dialing (waiting call), then the masked note becomes its preview", async () => {
    h = await makeHarness({ config: { twilio: { accountSid: "AC1", authToken: "tok", from: "+15550000000" } } });
    const upserts = recordUpserts(h);
    const { token, session } = await h.signup("haneul");
    const ctx = { userId: session.user.id, threadId: session.mainThreadId, agentName: "깽이", displayName: "하늘", signal: new AbortController().signal, status() {}, now: () => new Date() } as unknown as ToolContext;
    const running = phoneTool(h.app.core).run({ to: "02-1234-1234", message: "예약 확인 부탁드려요", name: "연세바른치과" }, ctx);
    for (let i = 0; i < 100 && !release; i++) await Bun.sleep(10);
    expect(twilioCalls).toBe(1);

    const during = (await listThreads(h, token)).find((t) => t.kind === "call")!;
    expect(during.waiting).toEqual({ kind: "call", text: WAITING_TEXT.dialing });
    expect(upserts.find((t) => t.id === during.id)?.waiting).toEqual({ kind: "call", text: WAITING_TEXT.dialing });

    release!();
    const r = await running;
    expect(r.ok).toBe(true);
    const done = (await listThreads(h, token)).find((t) => t.id === during.id)!;
    expect(done.waiting).toBeNull();
    expect(done.preview).toBe("연세바른치과(02-****-1234)에 전화를 걸었어요.");
    expect(upserts.filter((t) => t.id === during.id).at(-1)).toMatchObject({ waiting: null, preview: done.preview });
    expect(JSON.stringify(upserts)).not.toContain("1234-1234");
  });

  test("meeting: joining → host admission → in the call → ended", async () => {
    h = await makeHarness();
    const { token, session } = await h.signup("haneul");
    const core = h.app.core;
    const tid = newId("t");
    core.db.createThread({ id: tid, ownerId: session.user.id, kind: "call", title: "회의 참여", subtitle: "", icon: "people", now: core.now() }, [session.user.id]);
    const mid = newId("mt");
    core.db.sql
      .query(`INSERT INTO meetings (id, user_id, thread_id, code, purpose, state, started_at) VALUES (?, ?, ?, ?, '', 'launching', ?)`)
      .run(mid, session.user.id, tid, "rak-wxyz-kud", core.now());
    const waitingNow = async () => (await listThreads(h!, token)).find((t) => t.id === tid)!.waiting;
    const setState = (s: string) => core.db.sql.query(`UPDATE meetings SET state = ? WHERE id = ?`).run(s, mid);

    expect(await waitingNow()).toEqual({ kind: "meeting", text: WAITING_TEXT.meetJoining });
    setState("waiting_admission");
    expect(await waitingNow()).toEqual({ kind: "meeting", text: WAITING_TEXT.meetAdmission });
    setState("in_call");
    expect(await waitingNow()).toEqual({ kind: "meeting", text: WAITING_TEXT.meetLive });
    // an approval asked for during the meeting comes first
    core.db.insertApproval({
      id: newId("ap"),
      userId: session.user.id,
      threadId: tid,
      messageId: newId("m"),
      callJson: JSON.stringify({ id: "c", type: "function", function: { name: "sys_phone_call", arguments: "{}" } }),
      priorJson: "[]",
      specJson: JSON.stringify({ title: "?", detail: "", call: { target: "단아님", number: "010-1234-5678", message: "늦어요" } }),
      now: core.now(),
      expiresAt: core.now() + 60_000,
    });
    expect(await waitingNow()).toEqual({ kind: "approval", text: WAITING_TEXT.approvalCall });
    core.db.sql.query(`UPDATE approvals SET status = 'rejected' WHERE thread_id = ?`).run(tid);
    setState("ended");
    expect(await waitingNow()).toBeNull();
  });
});
