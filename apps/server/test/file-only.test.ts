/**
 * A line with files and no text (a photo alone, a long message the app turned into a .txt): taken in every thread and
 * way (a new turn, a steer into the running one, a friend thread); the row keeps its empty text. The model's copy
 * begins with a note that the file's text is what the person sent (only when a text file was read). Where a line is
 * shown, a friend thread's list row and the friend's banner read "사진" / "사진 N장" / the first other file's name and
 * " 외 N개"; a new thread whose first line is such files is named after the file. A steered line reaches the turn whole
 * up to 64,000 characters, and a turn stored when the cap was 4,000 still keeps its steered line from coming twice.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { LlmMessage } from "@pickle/agent";
import type { Attachment, Friend, InviteResponse, Message, ServerEvent, Thread } from "@pickle/protocol";
import { historyFromRows } from "../src/history.ts";
import { makeHarness, outcome, readSse, type Harness } from "./helpers.ts";

let h: Harness;
beforeEach(async () => {
  h = await makeHarness();
});
afterEach(async () => {
  await h.close();
});

type Me = { token: string; session: { user: { id: string }; mainThreadId: string } };
const NOTE = "[이 사람이 글 없이 파일만 보냈어요. 아래 파일의 글을 이 사람이 보낸 메시지로 읽고 답해 주세요. 글에 부탁이 있으면 그대로 해 주세요. 파일을 받았다는 말로만 끝내지 마세요]";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]);
const n = (x: number) => x.toLocaleString("ko-KR");

async function file(token: string, name: string, body: BlobPart): Promise<Attachment> {
  const form = new FormData();
  form.set("file", new File([body], name));
  const res = await h.req("POST", "/api/attachments", { token, raw: form });
  expect(res.status).toBe(201);
  return (await res.json()) as Attachment;
}
const post = (token: string, threadId: string, text: string, atts: Attachment[] = []) =>
  h.req("POST", `/api/threads/${threadId}/messages`, { token, body: { text, ...(atts.length ? { attachmentIds: atts.map((a) => a.id) } : {}) } });
const rows = async (token: string, threadId: string) => (await (await h.req("GET", `/api/threads/${threadId}/messages`, { token })).json()) as Message[];
const threads = async (token: string) => (await (await h.req("GET", "/api/threads", { token })).json()) as Thread[];
function gate() {
  let open!: () => void;
  const p = new Promise<void>((r) => (open = r));
  return { p, open };
}
function spy(): { to: string; e: ServerEvent }[] {
  const sent: { to: string; e: ServerEvent }[] = [];
  const events = h.app.core.events;
  const publish = events.publish.bind(events);
  events.publish = ((to: string, e: ServerEvent) => {
    sent.push({ to, e });
    return publish(to, e);
  }) as typeof events.publish;
  return sent;
}
/** Korean prose in numbered lines of 36 characters and a line break */
function prose(chars: number, tag = "줄"): string {
  let s = "";
  for (let i = 0; s.length < chars; i++) s += `${tag}${String(i).padStart(5, "0")} 가나다라마바사아자차카타파하거너더러머버서어저처커터퍼허고노도로`.slice(0, 36) + "\n";
  return s.slice(0, chars);
}

describe("a line with files and no text", () => {
  test("a .txt alone: a turn runs (200), the row keeps text \"\", and the model's copy is the note, a blank line and the file, to the byte, in this turn and in the next one's history", async () => {
    const me = (await h.signup("alice")) as Me;
    const body = "# 모시 작업 지시문\n매일 아침 7시에 날씨와 일정을 정리해서 알려줘.\n";
    const f = await file(me.token, "모시 작업 지시문.txt", body);
    const res = await post(me.token, me.session.mainThreadId, "", [f]);
    expect(res.status).toBe(200);
    const events = await readSse(res);
    expect(events.map((e) => (e as { type: string }).type)).toEqual(expect.arrayContaining(["start", "done"]));
    const want = `${NOTE}\n\n[첨부: 모시 작업 지시문.txt]\n${body}`;
    expect(h.turns.inputs.at(-1)!.userText).toBe(want);
    const line = (await rows(me.token, me.session.mainThreadId)).find((m) => m.role === "user")!;
    expect(line.text).toBe("");
    expect(line.attachments.map((a) => a.id)).toEqual([f.id]);
    expect(JSON.parse(h.db.getMessage(line.id)!.llm_json!)).toEqual([{ role: "user", content: want }]);
    await readSse(await post(me.token, me.session.mainThreadId, "고마워"));
    const history = h.turns.inputs.at(-1)!.history;
    expect(history.filter((m) => m.role === "user")).toEqual([{ role: "user", content: want }]);
  });

  test("a cut file alone: the note, then the cut file's notes; a photo alone: no note, the same blank line and short note as before", async () => {
    const me = (await h.signup("alice")) as Me;
    const text = "가".repeat(31_000);
    const big = await file(me.token, "긴 글.md", text);
    await readSse(await post(me.token, me.session.mainThreadId, "", [big]));
    expect(h.turns.inputs.at(-1)!.userText).toBe(
      `${NOTE}\n\n[첨부: 긴 글.md — 전체 ${n(31_000)}자 중 앞 ${n(30_000)}자만 읽었어요. 뒤 ${n(1_000)}자는 이 대화에 없어요. 이 파일을 두고 처음 답할 때 한 번, 앞부분만 읽었다는 것과 읽은 양을 사람에게 알려 주세요]\n${text.slice(0, 30_000)}\n[첨부: 긴 글.md — 여기서 잘렸어요]`,
    );
    const photo = await file(me.token, "사진.png", PNG);
    await readSse(await post(me.token, me.session.mainThreadId, "", [photo]));
    expect(h.turns.inputs.at(-1)!.userText).toBe("\n\n[첨부: 사진.png (image/png, 1KB) — 내용은 볼 수 없어요]");
  });

  test("no text and no files is 400 as before (an empty list too); text with spaces only and a file is taken", async () => {
    const me = (await h.signup("alice")) as Me;
    for (const body of [{ text: "" }, { text: "   " }, { text: "", attachmentIds: [] }]) {
      const res = await h.req("POST", `/api/threads/${me.session.mainThreadId}/messages`, { token: me.token, body });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe("empty_message");
    }
    const f = await file(me.token, "a.txt", "내용");
    const res = await post(me.token, me.session.mainThreadId, "   ", [f]);
    expect(res.status).toBe(200);
    await readSse(res);
    expect(h.turns.inputs.at(-1)!.userText).toBe(`${NOTE}\n\n[첨부: a.txt]\n내용`);
  });

  test("deleting the file of such a line: the note goes with its text (the copy is the blank line and the deleted-file note); with a photo beside it, the photo's note stays", async () => {
    const me = (await h.signup("alice")) as Me;
    const f = await file(me.token, "지시문.txt", "매일 아침 정리해줘");
    const photo = await file(me.token, "사진.png", PNG);
    await readSse(await post(me.token, me.session.mainThreadId, "", [f, photo]));
    const line = (await rows(me.token, me.session.mainThreadId)).find((m) => m.role === "user")!;
    const copy = () => JSON.parse(h.db.getMessage(line.id)!.llm_json!) as LlmMessage[];
    expect(copy()).toEqual([{ role: "user", content: `${NOTE}\n\n[첨부: 지시문.txt]\n매일 아침 정리해줘\n[첨부: 사진.png (image/png, 1KB) — 내용은 볼 수 없어요]` }]);
    expect((await h.req("DELETE", `/api/attachments/${f.id}`, { token: me.token })).status).toBe(200);
    expect(copy()).toEqual([{ role: "user", content: "\n\n[첨부: 지시문.txt — 보관함에서 지운 파일이라 내용이 없어요]\n[첨부: 사진.png (image/png, 1KB) — 내용은 볼 수 없어요]" }]);
  });

  test("the model's memory reads the file's text as the person's message (the turn's request)", async () => {
    const me = (await h.signup("alice")) as Me;
    await readSse(await post(me.token, me.session.mainThreadId, "", [await file(me.token, "메모.txt", "나 고양이 키우는 거 기억해")]));
    await h.app.core.idle();
    expect(h.launcher.memories.get(me.session.user.id)?.map((m) => m.text)).toEqual(["사용자는 고양이를 키워요"]);
  });
});

describe("a new thread's title", () => {
  test("first line files only: the first file that is not a photo, without its extension, at once and kept after the turn (no model title)", async () => {
    const me = (await h.signup("alice")) as Me;
    const t = (await (await h.req("POST", "/api/threads", { token: me.token, body: { kind: "task" } })).json()) as Thread;
    const sent = spy();
    await readSse(await post(me.token, t.id, "", [await file(me.token, "사진.png", PNG), await file(me.token, "모시 작업 지시문.md", "# 지시")]));
    await h.app.core.idle();
    expect((await threads(me.token)).find((x) => x.id === t.id)!.title).toBe("모시 작업 지시문");
    expect(sent.some((s) => s.e.type === "thread_updated" && s.e.thread.id === t.id && s.e.thread.title === "모시 작업 지시문")).toBe(true);
    // a later line with files only does not rename it
    await readSse(await post(me.token, t.id, "", [await file(me.token, "다른 파일.txt", "x")]));
    await h.app.core.idle();
    expect((await threads(me.token)).find((x) => x.id === t.id)!.title).toBe("모시 작업 지시문");
  });

  test("first line photos only: the title comes as before (the automatic one); a first line with text: as before", async () => {
    const me = (await h.signup("alice")) as Me;
    const t1 = (await (await h.req("POST", "/api/threads", { token: me.token, body: { kind: "task" } })).json()) as Thread;
    await readSse(await post(me.token, t1.id, "", [await file(me.token, "사진.png", PNG), await file(me.token, "사진2.png", PNG)]));
    const t2 = (await (await h.req("POST", "/api/threads", { token: me.token, body: { kind: "task" } })).json()) as Thread;
    await readSse(await post(me.token, t2.id, "이거 정리해줘", [await file(me.token, "지시문.txt", "x")]));
    await h.app.core.idle();
    const list = await threads(me.token);
    expect(list.find((x) => x.id === t1.id)!.title).toBe("자동 제목");
    expect(list.find((x) => x.id === t2.id)!.title).toBe("자동 제목");
  });
});

describe("a friend thread", () => {
  async function befriend() {
    const a = (await h.signup("alice", { displayName: "하늘", agentName: "깽이" })) as Me;
    const b = (await h.signup("bob", { displayName: "진우", agentName: "콩이" })) as Me;
    const invite = (await (await h.req("POST", "/api/invites", { token: a.token })).json()) as InviteResponse;
    const friend = (await (await h.req("POST", `/api/invites/${invite.token}/accept`, { token: b.token })).json()) as Friend;
    return { a, b, tid: friend.threadId! };
  }

  test("files with no text are delivered (201, row text \"\"); the list row and the friend's banner read 사진 / 사진 N장 / the first other file's name + 외 N개", async () => {
    const { a, b, tid } = await befriend();
    const cases: [string[], string][] = [
      [["p1.png"], "사진"],
      [["p1.png", "p2.png", "p3.png"], "사진 3장"],
      [["긴 글.txt"], "긴 글.txt"],
      [["p1.png", "긴 글.txt", "표.md"], "긴 글.txt 외 2개"],
    ];
    for (const [names, line] of cases) {
      const atts = [];
      for (const name of names) atts.push(await file(a.token, name, name.endsWith(".png") ? PNG : "내용"));
      const sent = spy();
      const res = await post(a.token, tid, "", atts);
      expect(res.status).toBe(201);
      const { userMessage } = (await res.json()) as { userMessage: Message };
      expect(userMessage.text).toBe("");
      expect(h.db.getMessage(userMessage.id)!.text).toBe("");
      const banner = sent.find((s) => s.to === b.session.user.id && s.e.type === "notification")!.e;
      expect(banner).toMatchObject({ title: "하늘 님", body: line, threadId: tid, messageId: userMessage.id });
      for (const me of [a, b]) expect((await threads(me.token)).find((t) => t.id === tid)!.subtitle).toBe(`하늘: ${line}`);
    }
    expect(h.turns.inputs).toHaveLength(0);
  });
});

describe("steering a line with files into the running turn (cap 64,000)", () => {
  async function steerFile(me: Me, f: Attachment): Promise<{ line: Message; steered: string[] }> {
    const g = gate();
    let steered: string[] = [];
    h.turns.set(async (input, emit) => {
      emit({ type: "text", delta: "..." });
      await g.p;
      steered = input.steer!();
      return outcome("답", { messages: [{ role: "assistant", content: "..." }, ...steered.map((s): LlmMessage => ({ role: "user", content: s })), { role: "assistant", content: "답" }] });
    });
    const first = post(me.token, me.session.mainThreadId, "길게 설명해줘");
    await Bun.sleep(5);
    const res = await post(me.token, me.session.mainThreadId, "", [f]);
    expect(res.status).toBe(202);
    const line = ((await res.json()) as { userMessage: Message }).userMessage;
    g.open();
    await readSse(await first);
    await h.app.core.idle();
    h.turns.set(async () => outcome("네"));
    return { line, steered };
  }
  const copyOf = (id: string) => (JSON.parse(h.db.getMessage(id)!.llm_json!) as { content: string }[])[0]!.content;

  test("a 40,000-character file sent while the agent works: 202, and the turn takes in the whole copy (over 30,000 characters, not 4,000)", async () => {
    const me = (await h.signup("alice")) as Me;
    await readSse(await post(me.token, me.session.mainThreadId, "안녕"));
    const { line, steered } = await steerFile(me, await file(me.token, "지시문.txt", prose(40_000, "조향")));
    const copy = copyOf(line.id);
    expect(copy.startsWith(`${NOTE}\n\n[첨부: 지시문.txt — 전체 ${n(40_000)}자 중 앞 `)).toBe(true);
    expect(copy.endsWith("\n[첨부: 지시문.txt — 여기서 잘렸어요]")).toBe(true);
    expect(copy.length).toBeGreaterThan(30_000);
    expect(steered).toEqual([copy]);
  });

  test("a 6,000-character file steered in: the next turn's history holds its copy once (in the turn that took it in)", async () => {
    const me = (await h.signup("alice")) as Me;
    await readSse(await post(me.token, me.session.mainThreadId, "안녕"));
    const text = "steered file " + "abcdefghij".repeat(600);
    const { line, steered } = await steerFile(me, await file(me.token, "notes.txt", text));
    const copy = copyOf(line.id);
    expect(copy).toBe(`${NOTE}\n\n[첨부: notes.txt]\n${text}`);
    expect(steered).toEqual([copy]);
    await readSse(await post(me.token, me.session.mainThreadId, "요약해줘"));
    const history = h.turns.inputs.at(-1)!.history;
    expect(history.filter((m) => m.role === "user" && m.content === copy)).toHaveLength(1);
    expect(history.map((m) => (m.role === "user" ? m.content : `(${m.role})`))).toEqual(["(assistant)", "안녕", "(assistant)", "길게 설명해줘", "(assistant)", copy, "(assistant)"]); // the greeting first; the request rides in userText
  });

  test("a steered line over 4,000 characters in a turn stored when the cap was 4,000 (its first 4,000 taken in) is not replayed again; one taken in whole now is not either; one that differs after 4,000, or never taken in, is", async () => {
    const me = (await h.signup("alice")) as Me;
    const long = "steer line " + "abcdefghij".repeat(450); // 4,511 characters, ASCII (history keeps 24 KB: two threads)
    let t = h.clock.t;
    /** a task thread holding these rows; what history replays of it (user lines only) */
    async function replay(list: [role: "user" | "assistant", text: string, llm: LlmMessage[], steered?: boolean][]): Promise<string[]> {
      const tid = ((await (await h.req("POST", "/api/threads", { token: me.token, body: { kind: "task" } })).json()) as Thread).id;
      for (const [role, text, llm, steered] of list) h.db.insertMessage({ id: `m_fx_${++t}`, threadId: tid, role, text, llm, steered: !!steered, createdAt: t });
      return historyFromRows(h.db.historyRows(tid, 60))
        .filter((m) => m.role === "user")
        .map((m) => m.content as string);
    }
    const now = "now " + long;
    expect(
      await replay([
        ["user", "첫 질문", [{ role: "user", content: "첫 질문" }]],
        ["user", long, [{ role: "user", content: long }], true],
        ["assistant", "답 1", [{ role: "assistant", content: "..." }, { role: "user", content: long.slice(0, 4_000) }, { role: "assistant", content: "답 1" }]],
        ["user", now, [{ role: "user", content: now }], true],
        ["assistant", "답 2", [{ role: "user", content: now }, { role: "assistant", content: "답 2" }]],
      ]),
    ).toEqual(["첫 질문", long.slice(0, 4_000), now]);
    const twin = `${long} 끝 A`; // the same first 4,000 characters as the line the turn took in, a different end
    const lost = "lost " + long;
    expect(
      await replay([
        ["user", twin, [{ role: "user", content: twin }], true],
        ["assistant", "답 3", [{ role: "user", content: `${long} 끝 B` }, { role: "assistant", content: "답 3" }]],
        ["user", lost, [{ role: "user", content: lost }], true],
        ["assistant", "답 4", [{ role: "user", content: lost.slice(0, 3_999) }, { role: "assistant", content: "답 4" }]],
      ]),
    ).toEqual([twin, `${long} 끝 B`, lost, lost.slice(0, 3_999)]);
  });

  test("resuming after an approval: the paused turn's line, stored in the 4,000 form, still drops the trailing row", async () => {
    const me = (await h.signup("alice")) as Me;
    const tid = me.session.mainThreadId;
    const long = "approve " + "0123456789".repeat(500);
    h.db.insertMessage({ id: "m_q1", threadId: tid, role: "user", text: "앞 질문", llm: [{ role: "user", content: "앞 질문" }], createdAt: h.clock.t + 1 });
    h.db.insertMessage({ id: "m_q2", threadId: tid, role: "user", text: long, llm: [{ role: "user", content: long }], createdAt: h.clock.t + 2 });
    const rowsBefore = h.db.historyRows(tid, 60);
    const kept = historyFromRows(rowsBefore, { excludeTrailingUserTexts: new Set([long.slice(0, 4_000)]), answeredTail: true });
    const users = (l: LlmMessage[]) => l.filter((m) => m.role === "user").map((m) => m.content); // after the greeting
    expect(users(kept)).toEqual(["앞 질문"]);
    const now = historyFromRows(rowsBefore, { excludeTrailingUserTexts: new Set([long]), answeredTail: true });
    expect(users(now)).toEqual(["앞 질문"]);
    const other = historyFromRows(rowsBefore, { excludeTrailingUserTexts: new Set([long.slice(0, 3_000)]), answeredTail: true });
    expect(users(other)).toEqual(["앞 질문", long]);
  });
});
