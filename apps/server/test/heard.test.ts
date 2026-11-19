/** A voice reply cut off by the user (call barge-in): history keeps only what was heard, marked with the voice note (cutToHeard, withVoiceNote, POST …/heard). */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { LlmMessage } from "@pickle/agent";
import type { Friend, InviteResponse, Message } from "@pickle/protocol";
import { letters, speakable, speechNorm } from "@pickle/protocol";
import { CANCEL_NOTE_MESSAGE, CANCEL_RULE, cutToHeard, heardEnd, VOICE_NOTE_MESSAGE, withVoiceNote } from "../src/history.ts";
import { makeHarness, outcome, readSse, sseReader, type Harness } from "./helpers.ts";

const call = { id: "c1", type: "function" as const, function: { name: "k_weather", arguments: "{}" } };
const say = (content: string): LlmMessage => ({ role: "assistant", content });

describe("cutToHeard", () => {
  test("keeps the heard words of a reply and marks the cut", () => {
    const llm = [say("내일 서울은 맑아요. 낮 최고 기온은 15도예요.")];
    expect(cutToHeard(llm, "내일 서울은 맑아요.")).toEqual([say("내일 서울은 맑아요.…")]);
    // counted in spoken letters: spacing and punctuation of `heard` don't matter
    expect(cutToHeard(llm, "내일서울은 맑아요")).toEqual([say("내일 서울은 맑아요.…")]);
  });

  test("a cut inside a word keeps the whole word", () => {
    expect(cutToHeard([say("내일 서울은 맑아요. 낮 최고 기온은 15도예요.")], "내일 서")).toEqual([say("내일 서울은…")]);
  });

  test("nothing heard leaves only the mark; all heard changes nothing", () => {
    const llm = [say("내일 서울은 맑아요.")];
    expect(cutToHeard(llm, "")).toEqual([say("…")]);
    expect(cutToHeard(llm, "내일 서울은 맑아요.")).toBeNull();
    // heard into the last word: the reply was heard whole
    expect(cutToHeard(llm, "내일 서울은 맑")).toBeNull();
  });

  test("the same cut twice changes nothing (no second mark)", () => {
    const llm = [say("내일 서울은 맑아요. 낮 최고 기온은 15도예요.")];
    for (const heard of ["내일 서울은 맑아요.", "내일 서", ""]) {
      const once = cutToHeard(llm, heard)!;
      expect(cutToHeard(once, heard)).toBeNull();
    }
    // a reply that already says "…" where it is cut gets no second one
    expect(cutToHeard([say("음… 그러니까 이건 어렵네요.")], "음")).toEqual([say("음…")]);
  });

  test("markdown and emoji are counted as spoken", () => {
    expect(cutToHeard([say("**오늘** 날씨는 맑아요 😊 내일은 비가 와요.")], "오늘 날씨는 맑아요")).toEqual([say("**오늘** 날씨는 맑아요…")]);
  });

  test("steps: user and tool messages stay, later assistant text goes, tool calls keep their calls", () => {
    const llm: LlmMessage[] = [
      { role: "assistant", content: "날씨를 볼게요.", tool_calls: [call] },
      { role: "tool", tool_call_id: "c1", content: "{\"sky\":\"맑음\"}" },
      { role: "user", content: "내일 것도" },
      say("오늘은 맑고 내일은 흐려요."),
    ];
    expect(cutToHeard(llm, "날씨를 볼게요. 오늘은 맑고")).toEqual([...llm.slice(0, 3), say("오늘은 맑고…")]);
    expect(cutToHeard(llm, "날씨를")).toEqual([
      { role: "assistant", content: "날씨를…", tool_calls: [call] },
      llm[1]!,
      llm[2]!,
    ]);
    // the first step heard whole, the next not at all: the mark sits where the unheard text began
    expect(cutToHeard(llm, "날씨를 볼게요.")).toEqual([...llm.slice(0, 3), say("…")]);
    const later: LlmMessage[] = [say("먼저 볼게요."), { role: "assistant", content: "확인 중이에요.", tool_calls: [call] }, llm[1]!];
    expect(cutToHeard(later, "먼저")).toEqual([say("먼저…"), { role: "assistant", content: null, tool_calls: [call] }, llm[1]!]);
  });

  test("the notes stay where they are and are not counted", () => {
    for (const note of [CANCEL_NOTE_MESSAGE, VOICE_NOTE_MESSAGE]) {
      const llm = [say("하나, 둘, 셋"), note];
      expect(cutToHeard(llm, "하나")).toEqual([say("하나,…"), note]);
      expect(cutToHeard(llm, "하나 둘 셋")).toBeNull();
    }
  });
});

describe("heardEnd", () => {
  /** every word end in turn: the first whose prefix, spoken, begins with the first n spoken letters */
  const scan = (text: string, n: number) => {
    if (n <= 0) return 0;
    const want = speechNorm(speakable(text)).slice(0, n);
    for (let i = 1; i <= text.length; i++) {
      if (i < text.length && !/\s/.test(text[i]!)) continue;
      if (speechNorm(speakable(text.slice(0, i))).startsWith(want)) return i;
    }
    return text.length;
  };

  test("the end of the word holding the n-th spoken letter", () => {
    const t = "내일 서울은 맑아요. 낮 최고 기온은 15도예요.";
    expect(heardEnd(t, 0)).toBe(0);
    expect(heardEnd(t, 1)).toBe(2);
    expect(heardEnd(t, 3)).toBe(6);
    expect(heardEnd(t, 5)).toBe(6);
    expect(t.slice(0, heardEnd(t, 8))).toBe("내일 서울은 맑아요.");
    // markdown and a link count as spoken: "오늘 맛집 정리" is 6 letters
    const md = "**오늘** [맛집](https://example.com/a) 정리 😊 끝이에요.";
    expect(md.slice(0, heardEnd(md, 6))).toBe("**오늘** [맛집](https://example.com/a) 정리");
  });

  test("the same cut as scanning every word end, on replies with closed markdown", () => {
    const words = ["서울역", "근처", "맛집", "오늘은", "내일", "비가", "와요.", "그리고", "점심", "저녁", "추천해요", "회의", "자료를", "정리했어요."];
    const marks = ["**맛집**", "[링크](https://example.com/a)", "https://x.io/y", "😊", "3.5도예요.", "\n", "\n- ", "\n1. ", "`코드`", "```\nconst a = 1\n```", "네!"];
    const pool = [...words, ...words, ...marks];
    let seed = 11;
    const rnd = (k: number) => ((seed = (seed * 1103515245 + 12345) % 2147483648), seed % k);
    for (let t = 0; t < 300; t++) {
      let text = "";
      for (let i = 0, len = 3 + rnd(40); i < len; i++) text += pool[rnd(pool.length)] + (rnd(3) ? " " : "");
      const total = letters(speakable(text));
      for (const n of [1, rnd(total + 1), total]) expect([text, n, heardEnd(text, n)]).toEqual([text, n, scan(text, n)]);
    }
  });

  test("a long reply is cut in a few milliseconds (no quadratic scan)", () => {
    const line = "- **서울역** 근처 [맛집](https://example.com/a) 정리해 드릴게요 😊 오늘은 3.5도예요.\n";
    const text = line.repeat(Math.ceil(20_000 / line.length));
    const heard = speakable(text).slice(0, Math.floor(speakable(text).length * 0.9)).replace(/\S+$/, "").trim();
    const t0 = performance.now();
    const out = cutToHeard([say(text)], heard)!;
    const ms = performance.now() - t0;
    expect(letters(speakable(out[0]!.content as string))).toBe(letters(heard));
    // the word-end scan took ~400 ms here; the search ~5 ms
    expect(ms).toBeLessThan(100);
  });
});

describe("withVoiceNote", () => {
  test("the Stop note gives way to the voice note; a cut reply gets it; a reply heard whole stays as it was", () => {
    expect(withVoiceNote([say("하나,…"), CANCEL_NOTE_MESSAGE], true)).toEqual([say("하나,…"), VOICE_NOTE_MESSAGE]);
    // stopped while generating, but all of what it said was heard
    expect(withVoiceNote([say("하나"), CANCEL_NOTE_MESSAGE], false)).toEqual([say("하나"), VOICE_NOTE_MESSAGE]);
    expect(withVoiceNote([say("내일은…")], true)).toEqual([say("내일은…"), VOICE_NOTE_MESSAGE]);
    const whole = [say("내일은 맑아요.")];
    expect(withVoiceNote(whole, false)).toBe(whole);
    // again: unchanged
    const once = [say("하나,…"), VOICE_NOTE_MESSAGE];
    expect(withVoiceNote(once, false)).toEqual(once);
  });
});

describe("POST /api/threads/:id/messages/:messageId/heard", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  const heard = (token: string, tid: string, mid: string, body: unknown) => h.req("POST", `/api/threads/${tid}/messages/${mid}/heard`, { token, body });
  const llmOf = (id: string) => JSON.parse(h.db.getMessage(id)!.llm_json!) as LlmMessage[];

  async function reply(token: string, tid: string, text: string, answer: string): Promise<Message> {
    h.turns.set(async () => outcome(answer));
    const done = (await readSse(await h.req("POST", `/api/threads/${tid}/messages`, { token, body: { text, mode: "voice" } }))).at(-1) as { message: Message };
    return done.message;
  }

  test("a finished reply cut off: the next turn sees only what was heard; the bubble keeps the whole text", async () => {
    const { token, session } = await h.signup("haneul");
    const tid = session.mainThreadId;
    const m = await reply(token, tid, "내일 날씨 알려줘", "내일 서울은 맑아요. 낮 최고 기온은 15도예요.");
    expect((await heard(token, tid, m.id, { heard: "내일 서울은 맑아요." })).status).toBe(204);
    expect(llmOf(m.id)).toEqual([say("내일 서울은 맑아요.…"), VOICE_NOTE_MESSAGE]);
    // the same report again: no second mark, no second note
    expect((await heard(token, tid, m.id, { heard: "내일 서울은 맑아요." })).status).toBe(204);
    expect(llmOf(m.id)).toEqual([say("내일 서울은 맑아요.…"), VOICE_NOTE_MESSAGE]);

    await reply(token, tid, "아니 모레 거", "모레는 흐려요.");
    const input = h.turns.inputs.at(-1)!;
    expect(input.history.slice(-3)).toEqual([{ role: "user", content: "내일 날씨 알려줘" }, say("내일 서울은 맑아요.…"), VOICE_NOTE_MESSAGE]);
    expect(input.system).not.toContain(CANCEL_RULE);
    const msgs = (await (await h.req("GET", `/api/threads/${tid}/messages`, { token })).json()) as Message[];
    expect(msgs.find((x) => x.id === m.id)!.text).toBe("내일 서울은 맑아요. 낮 최고 기온은 15도예요.");
  });

  test("stopped while generating: the report waits for the stopped turn, then cuts; the voice note replaces the Stop note", async () => {
    const { token, session } = await h.signup("haneul");
    const tid = session.mainThreadId;
    h.turns.set(async (input, emit) => {
      emit({ type: "text", delta: "하나, 둘, 셋, 넷, 다섯" });
      return new Promise<never>((_, rej) =>
        input.ctx.signal.addEventListener("abort", () => setTimeout(() => rej(new DOMException("aborted", "AbortError")), 30), { once: true }),
      );
    });
    const ac = new AbortController();
    const r = sseReader(await h.req("POST", `/api/threads/${tid}/messages`, { token, body: { text: "다섯까지 세줘", mode: "voice" }, signal: ac.signal }));
    const start = (await r.next((e) => e.type === "start")) as { messageId: string };
    await r.next((e) => e.type === "text");
    ac.abort();
    await r.cancel();
    // no idle() wait: the report goes out at once, before the reply row exists
    expect((await heard(token, tid, start.messageId, { heard: "하나, 둘" })).status).toBe(204);
    expect(llmOf(start.messageId)).toEqual([say("하나, 둘,…"), VOICE_NOTE_MESSAGE]);
    await h.app.core.idle();
    expect(llmOf(start.messageId)).toEqual([say("하나, 둘,…"), VOICE_NOTE_MESSAGE]);

    await reply(token, tid, "아 그리고 열까지", "여섯, 일곱, 여덟, 아홉, 열");
    const input = h.turns.inputs.at(-1)!;
    expect(input.history.slice(-3)).toEqual([{ role: "user", content: "다섯까지 세줘" }, say("하나, 둘,…"), VOICE_NOTE_MESSAGE]);
    // the Stop rule goes with the Stop note only
    expect(input.system).not.toContain(CANCEL_RULE);
  });

  test("a reply heard whole: a finished one stays as it was, a stopped one swaps its Stop note", async () => {
    const { token, session } = await h.signup("haneul");
    const tid = session.mainThreadId;
    const m = await reply(token, tid, "내일 날씨 알려줘", "맑아요.");
    expect((await heard(token, tid, m.id, { heard: "맑아요." })).status).toBe(204);
    expect(llmOf(m.id)).toEqual([say("맑아요.")]);
    h.db.insertMessage({ id: "m_stopped", threadId: tid, role: "assistant", text: "하나, 둘", llm: [say("하나, 둘"), CANCEL_NOTE_MESSAGE], createdAt: h.clock.now() });
    expect((await heard(token, tid, "m_stopped", { heard: "하나, 둘" })).status).toBe(204);
    expect(llmOf("m_stopped")).toEqual([say("하나, 둘"), VOICE_NOTE_MESSAGE]);
  });

  test("steered lines and tool results stay in the cut reply", async () => {
    const { token, session } = await h.signup("haneul");
    const tid = session.mainThreadId;
    const llm: LlmMessage[] = [
      { role: "assistant", content: "날씨를 볼게요.", tool_calls: [call] },
      { role: "tool", tool_call_id: "c1", content: "{}" },
      { role: "user", content: "내일 것도" },
      say("오늘은 맑고 내일은 흐려요."),
    ];
    h.db.insertMessage({ id: "m_steps", threadId: tid, role: "assistant", text: "날씨를 볼게요.\n\n오늘은 맑고 내일은 흐려요.", llm, createdAt: h.clock.now() });
    expect((await heard(token, tid, "m_steps", { heard: "날씨를 볼게요. 오늘은" })).status).toBe(204);
    expect(llmOf("m_steps")).toEqual([...llm.slice(0, 3), say("오늘은…"), VOICE_NOTE_MESSAGE]);
  });

  test("a reply without llm_json is cut from its text", async () => {
    const { token, session } = await h.signup("haneul");
    const tid = session.mainThreadId;
    h.db.insertMessage({ id: "m_plain", threadId: tid, role: "assistant", text: "좋아요. 바로 할게요.", createdAt: h.clock.now() });
    expect((await heard(token, tid, "m_plain", { heard: "" })).status).toBe(204);
    expect(llmOf("m_plain")).toEqual([say("…"), VOICE_NOTE_MESSAGE]);
  });

  test("a reply paused for approval is left alone", async () => {
    const { token, session } = await h.signup("haneul");
    const tid = session.mainThreadId;
    h.db.insertMessage({ id: "m_paused", threadId: tid, role: "assistant", text: "보낼까요? 확인해 주세요.", llm: [], createdAt: h.clock.now() });
    expect((await heard(token, tid, "m_paused", { heard: "보낼까요?" })).status).toBe(204);
    expect(llmOf("m_paused")).toEqual([]);
  });

  test("rejects a heard text the reply doesn't start with, and bad bodies", async () => {
    const { token, session } = await h.signup("haneul");
    const tid = session.mainThreadId;
    const m = await reply(token, tid, "내일 날씨 알려줘", "내일 서울은 맑아요. 낮 최고 기온은 15도예요.");
    const res = await heard(token, tid, m.id, { heard: "모레 서울은" });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("heard_mismatch");
    expect((await heard(token, tid, m.id, { heard: 3 })).status).toBe(400);
    expect((await heard(token, tid, m.id, {})).status).toBe(400);
    expect(llmOf(m.id)).toEqual([say("내일 서울은 맑아요. 낮 최고 기온은 15도예요.")]);
  });

  test("404 for an unknown message, a user message, or a message of another thread", async () => {
    const { token, session } = await h.signup("haneul");
    const tid = session.mainThreadId;
    const m = await reply(token, tid, "내일 날씨 알려줘", "맑아요.");
    const msgs = (await (await h.req("GET", `/api/threads/${tid}/messages`, { token })).json()) as Message[];
    const userRow = msgs.find((x) => x.role === "user")!;
    const other = (await (await h.req("POST", "/api/threads", { token, body: { title: "다른 일" } })).json()) as { id: string };
    expect((await heard(token, tid, "m_nope", { heard: "" })).status).toBe(404);
    expect((await heard(token, tid, userRow.id, { heard: "" })).status).toBe(404);
    expect((await heard(token, other.id, m.id, { heard: "" })).status).toBe(404);
    // someone else's thread
    const b = await h.signup("bob");
    expect((await heard(b.token, tid, m.id, { heard: "" })).status).toBe(404);
    expect(llmOf(m.id)).toEqual([say("맑아요.")]);
  });

  test("friend threads are refused", async () => {
    const a = await h.signup("alice", { displayName: "하늘", agentName: "깽이" });
    const b = await h.signup("bob", { displayName: "진우", agentName: "콩이" });
    const inv = (await (await h.req("POST", "/api/invites", { token: a.token })).json()) as InviteResponse;
    const friend = (await (await h.req("POST", `/api/invites/${inv.token}/accept`, { token: b.token })).json()) as Friend;
    const ftid = friend.threadId!;
    h.db.insertMessage({ id: "m_f", threadId: ftid, role: "assistant", text: "안녕하세요. 반가워요.", authorUserId: a.session.user.id, authorKind: "agent", createdAt: h.clock.now() });
    const res = await heard(a.token, ftid, "m_f", { heard: "" });
    expect(res.status).toBe(403);
    expect(h.db.getMessage("m_f")!.llm_json).toBeNull();
  });
});
