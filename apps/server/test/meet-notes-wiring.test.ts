/**
 * sys_meet_notes wiring through real turns (meet.test.ts covers the tool and the note themselves): where the "# 회의"
 * block lands in the system prompt, which threads get it, what it may carry, and the messenger tools' side of the
 * "meetings are not chats" contract.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { Friend, InviteResponse } from "@pickle/protocol";
import type { ToolResult } from "@pickle/agent";
import { messengerTools } from "../../../packages/messengers/src/tools.ts";
import { CANCEL_NOTE_MESSAGE, CANCEL_RULE } from "../src/history.ts";
import { meetTools } from "../src/meet.ts";
import { makeHarness, outcome, readSse, type Harness } from "./helpers.ts";

const MIN = 60_000;
let h: Harness;
afterEach(async () => {
  await h?.close();
});

let n = 0;
/** What meet.ts leaves behind after a meeting: the 회의 참여 thread, the ended row, its lines and the end summary. */
function seedEnded(userId: string, o: { purpose?: string; title?: string | null } = {}): { id: string; threadId: string } {
  const k = ++n;
  const now = h.clock.now();
  const started = now - 40 * MIN;
  const ended = started + 33 * MIN;
  const threadId = `t_mtg${k}`;
  h.db.createThread({ id: threadId, ownerId: userId, kind: "call", title: "회의 참여", subtitle: "", icon: "people", now: started }, [userId]);
  const id = `mt_w${k}`;
  h.db.sql
    .query(
      `INSERT INTO meetings (id, user_id, thread_id, session_id, code, purpose, state, reason, participants, started_at, joined_at, ended_at, title)
       VALUES (?, ?, ?, 's1', 'abc-defg-hij', ?, 'ended', 'meeting_ended', 3, ?, ?, ?, ?)`,
    )
    .run(id, userId, threadId, o.purpose ?? "", started, started + MIN, ended, o.title === undefined ? "relay daily" : o.title);
  const lines: [string, string][] = [
    ["도윤", "출시는 다음 주 화요일로 미룰게요."],
    ["서연", "결제 버그는 수요일까지 고칠게요."],
    ["지민", "시안은 목요일까지 드릴게요."],
  ];
  lines.forEach(([who, text], i) =>
    h.db.sql
      .query(`INSERT INTO meet_utterances (meeting_id, seq, speaker, text, at, role) VALUES (?, ?, ?, ?, ?, 'heard')`)
      .run(id, i + 1, who, text, started + MIN + i * 30_000),
  );
  const summary = "**회의 요약**\n\n출시를 다음 주 화요일로 미뤘어요.";
  h.db.insertMessage({ id: `m_sum${k}`, threadId, role: "assistant", text: summary, createdAt: ended, llm: [{ role: "assistant", content: summary }] });
  return { id, threadId };
}

async function turn(token: string, threadId: string, text: string) {
  h.turns.set(async () => outcome("네"));
  const events = await readSse(await h.req("POST", `/api/threads/${threadId}/messages`, { token, body: { text } }));
  expect(events.at(-1)).toMatchObject({ type: "done" });
  return h.turns.inputs.at(-1)!;
}

describe("sys_meet_notes wiring", () => {
  test("the # 회의 block is appended after the launcher prompt (cache prefix unchanged) and before the cancel rule", async () => {
    h = await makeHarness();
    const { token, session } = await h.signup("haneul");
    const main = session.mainThreadId;
    const before = (await turn(token, main, "안녕")).system;
    expect(before).not.toContain("# 회의");

    seedEnded(session.user.id);
    const after = (await turn(token, main, "아까 회의 요약해 줘")).system;
    expect(after.startsWith(before)).toBe(true);
    expect(after.slice(before.length)).toStartWith("\n\n# 회의");
    expect(after).toContain("- 회의 'relay daily' 끝남 오늘 11월 11일(수) 11:53 · 3줄 · 요약 있음 → 내용은 sys_meet_notes");

    // a stopped request in history: the cancel rule still comes last
    h.db.insertMessage({ id: "m_stopq", threadId: main, role: "user", text: "피보나치 30개", createdAt: h.clock.now(), llm: [{ role: "user", content: "피보나치 30개" }] });
    h.db.insertMessage({ id: "m_stopa", threadId: main, role: "assistant", text: "1, 1, 2", createdAt: h.clock.now(), llm: [CANCEL_NOTE_MESSAGE] });
    const withCancel = (await turn(token, main, "고마워")).system;
    expect(withCancel.indexOf("# 회의")).toBeGreaterThan(before.length - 1);
    expect(withCancel.endsWith(CANCEL_RULE)).toBe(true);
    expect(withCancel.indexOf(CANCEL_RULE)).toBeGreaterThan(withCancel.indexOf("# 회의"));
  });

  test("in the meeting's own thread a turn gets that meeting first, the read-first line and a tool bound to the thread", async () => {
    h = await makeHarness();
    const { token, session } = await h.signup("haneul");
    const userId = session.user.id;
    const older = seedEnded(userId, { title: "지난주 회의" });
    h.clock.t += 2 * 60 * MIN;
    seedEnded(userId, { title: "relay daily" });

    const input = await turn(token, older.threadId, "결정된 거 뭐야?");
    expect(input.ctx.threadId).toBe(older.threadId);
    expect(input.system).toContain("지금 대화방은 위 첫 번째 회의('지난주 회의')의 '회의 참여' 대화방이에요");
    const notes = input.tools.find((t) => t.name === "sys_meet_notes")!;
    const r = (await notes.run({}, input.ctx)) as ToolResult;
    expect((r.data as { meeting: { title: string } }).meeting.title).toBe("지난주 회의");

    // the main thread: the newest meeting, no thread line
    const mainInput = await turn(token, session.mainThreadId, "결정된 거 뭐야?");
    expect(mainInput.system).not.toContain("지금 대화방은");
    const r2 = (await mainInput.tools.find((t) => t.name === "sys_meet_notes")!.run({}, mainInput.ctx)) as ToolResult;
    expect((r2.data as { meeting: { title: string } }).meeting.title).toBe("relay daily");
  });

  test("a friend thread never carries the owner's meetings: no block, no tool", async () => {
    h = await makeHarness();
    const a = await h.signup("alice", { displayName: "하늘", agentName: "깽이" });
    const b = await h.signup("bob", { displayName: "진우", agentName: "콩이" });
    const inv = (await (await h.req("POST", "/api/invites", { token: a.token, headers: { host: "pickle.test" } })).json()) as InviteResponse;
    const friend = (await (await h.req("POST", `/api/invites/${inv.token}/accept`, { token: b.token })).json()) as Friend;
    seedEnded(a.session.user.id, { title: "인사 평가 회의" });

    const input = await turn(a.token, friend.threadId!, "@깽이 아까 회의 뭐였어?");
    expect(input.system).toContain("공유 대화방");
    expect(input.system).not.toContain("# 회의");
    expect(input.system).not.toContain("인사 평가 회의");
    expect(input.tools.map((t) => t.name)).not.toContain("sys_meet_notes");
  });

  test("a phone number in the purpose is masked in the prompt line and the recent list", async () => {
    h = await makeHarness();
    const { token, session } = await h.signup("haneul");
    seedEnded(session.user.id, { title: null, purpose: "고객 미팅 010-9999-8888 김 대리" });
    const input = await turn(token, session.mainThreadId, "회의 정리해 줘");
    expect(input.system).toContain("- 회의 '고객 미팅 [전화번호] 김 대리' 끝남");
    expect(input.system).not.toContain("9999-8888");
    const r = await input.tools.find((t) => t.name === "sys_meet_notes")!.run({}, input.ctx);
    const json = JSON.stringify(r);
    expect(json).not.toContain("9999-8888");
    expect(json).not.toContain("abc-defg-hij");
    expect(json).toContain("고객 미팅 [전화번호] 김 대리");
  });

  test("the messenger tools point meetings to sys_meet_notes, and sys_meet_notes points away from msg_*", async () => {
    h = await makeHarness();
    const byName = new Map(messengerTools({} as never).map((t) => [t.name, t.description]));
    for (const name of ["msg_list_chats", "msg_read"]) {
      expect(byName.get(name)).toContain("sys_meet_notes");
      expect(byName.get(name)).toMatch(/KakaoTalk/);
    }
    const { session } = await h.signup("haneul");
    seedEnded(session.user.id);
    const notes = meetTools(h.app.core, session.user.id).find((t) => t.name === "sys_meet_notes")!;
    expect(notes.description).toContain("never use msg_* tools");
    expect(notes.description).toContain("sys_create_artifact");
  });
});
