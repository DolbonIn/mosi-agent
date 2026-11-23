/**
 * 둘러보기 templates (DD 1407 follow-up 2): 부탁하기 sends one short line in the person's own words, and that line is all
 * any screen shows (bubble, thread list, other devices). How to do it (tool ids, rule syntax, what to ask first) goes to
 * the model only: appended to the model copy of the first message of the person's own new task thread when its text is
 * exactly a template's line, kept in that row's history for later turns, never in its text.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { DelegateResponse, ExploreResponse, Message, Thread } from "@pickle/protocol";
import { TEMPLATE_HINT_HEAD, TEMPLATE_SEEDS, templateHint } from "../src/explore.ts";
import type { UserRow } from "../src/db/index.ts";
import { makeHarness, outcome, readSse, sseReader, type Harness } from "./helpers.ts";

let h: Harness;
afterEach(async () => {
  if (h) await h.close();
  h = undefined as never; // the first test has no server
});

const seed = (id: string) => TEMPLATE_SEEDS.find((t) => t.id === id)!;
const modelCopy = (id: string) => `${seed(id).prompt}\n\n${TEMPLATE_HINT_HEAD}\n${seed(id).hint}`;
const TOOL_ID = /\b(?:k|msg|sys)_[a-z_]+/;
/** a line as one person sees it: the two name placeholders filled in */
const named = (s: string, u: { display_name: string; agent_name: string }) => s.replaceAll("{displayName}", u.display_name).replaceAll("{agentName}", u.agent_name);
const unnamed = (s: string) => s.replaceAll("{displayName}", "").replaceAll("{agentName}", "");

async function delegate(token: string, id: string): Promise<DelegateResponse> {
  const res = await h.req("POST", `/api/explore/${id}/delegate`, { token });
  expect(res.status).toBe(201);
  return (await res.json()) as DelegateResponse;
}
const send = (token: string, threadId: string, text: string) => h.req("POST", `/api/threads/${threadId}/messages`, { token, body: { text } });
const lastUserText = () => h.turns.inputs.at(-1)!.userText;

describe("template lines", () => {
  test("every line is a short sentence in the person's words; the how-to sits in the hint", () => {
    const lines = TEMPLATE_SEEDS.filter((t) => t.prompt);
    expect(lines.length).toBe(TEMPLATE_SEEDS.length - 1); // call-demo opens the call and sends nothing
    expect(seed("call-demo")).toMatchObject({ prompt: "" });
    expect(seed("call-demo").hint).toBeUndefined();
    for (const t of lines) {
      // no tool id, rule (daily@07:00), field name (kind: document) or service id (kakaotalk): no Latin besides the name placeholders
      expect({ id: t.id, latin: /[A-Za-z_@{}]/.test(unnamed(t.prompt)) }).toEqual({ id: t.id, latin: false });
      expect(t.prompt.length).toBeLessThanOrEqual(50);
      expect(t.hint?.trim()).toBeTruthy();
    }
    // a line names one template: the server finds the hint by the text alone
    expect(new Set(lines.map((t) => t.prompt)).size).toBe(lines.length);
    // the tool guidance moved, it did not go away (the 41 ids of 2350956's prompts, all in hints now)
    expect(lines.reduce((n, t) => n + (t.hint!.match(new RegExp(TOOL_ID, "g"))?.length ?? 0), 0)).toBe(41);
    expect(seed("subway-commute").hint).toContain("sys_schedule_create로 평일 일정(weekly@1,2,3,4,5@HH:MM)");
    expect(seed("morning-briefing").hint).toContain("규칙 daily@07:00");
  });

  test("with the names filled in, empty names too, each line still names its own template", () => {
    const people = [
      { display_name: "하늘", agent_name: "깽이" },
      { display_name: "", agent_name: "" },
      { display_name: "모시", agent_name: "모시" },
    ];
    for (const u of people) {
      const user = u as UserRow;
      const lines = TEMPLATE_SEEDS.filter((t) => t.prompt).map((t) => ({ t, line: named(t.prompt, u) }));
      expect(new Set(lines.map((l) => l.line)).size).toBe(lines.length);
      for (const { t, line } of lines) {
        expect(line.trim()).toBeTruthy();
        expect(line).not.toMatch(/[{}]/);
        expect({ id: t.id, hint: templateHint(user, line) }).toEqual({ id: t.id, hint: `${TEMPLATE_HINT_HEAD}\n${named(t.hint!, u)}` });
      }
      expect(templateHint(user, "")).toBeNull(); // call-demo sends nothing
      expect(templateHint(user, "안녕")).toBeNull();
    }
  });

  test("GET /api/explore: the line as prompt, asksFirst per template, no hint on the wire", async () => {
    h = await makeHarness({ now: Date.UTC(2026, 10, 10, 23, 0) }); // 08:00 KST: suggestions include morning-briefing
    const { token } = await h.signup("haneul", { displayName: "하늘", agentName: "깽이" });
    const ex = (await (await h.req("GET", "/api/explore", { token })).json()) as ExploreResponse;
    const all = [...ex.popular, ...ex.suggestions];
    expect(all.length).toBeGreaterThan(20);
    for (const t of all) {
      expect(t.prompt).toBe(named(seed(t.id).prompt, { display_name: "하늘", agent_name: "깽이" }));
      expect(t.asksFirst).toBe(!!seed(t.id).asksFirst);
      expect(Object.keys(t)).not.toContain("hint");
    }
    // what the sheet and the cards print (skills stay ids: the app maps them to step names)
    const printed = JSON.stringify(all.map((t) => [t.title, t.description, t.prompt]));
    expect(printed).not.toMatch(TOOL_ID);
    expect(printed).not.toContain(TEMPLATE_HINT_HEAD);
    const asks = (id: string) => all.find((t) => t.id === id)!.asksFirst;
    expect([asks("gov-benefits"), asks("morning-briefing"), asks("subway-commute"), asks("law-easy")]).toEqual([true, true, true, true]);
    // asks only at the end, or the line already says where: no "asks first" note
    expect([asks("news-briefing"), asks("airport-drive"), asks("housing-notices"), asks("crowd-check"), asks("kakao-unread"), asks("call-demo")]).toEqual([
      false,
      false,
      false,
      false,
      false,
      false,
    ]);
  });
});

describe("the first message of a delegated thread", () => {
  test("the person sees their line everywhere; the model gets the line and the how-to, in later turns too", async () => {
    h = await makeHarness();
    const { token } = await h.signup("haneul", { agentName: "깽이" });
    const other = sseReader(await h.req("GET", `/api/events?token=${token}`)); // another device of the person
    const d = await delegate(token, "gov-benefits");
    expect(d.prompt).toBe("지금 신청할 수 있는 정부 지원사업과 청년·주거 공고를 내 조건에 맞춰 찾아 줘.");

    const stream = await readSse(await send(token, d.thread.id, d.prompt));
    expect(stream[0]).toMatchObject({ type: "start", userMessage: { role: "user", text: d.prompt } });
    expect(lastUserText()).toBe(modelCopy("gov-benefits"));
    expect(lastUserText()).toContain("k_gov_support로 지원사업 공고를");

    const msgs = (await (await h.req("GET", `/api/threads/${d.thread.id}/messages`, { token })).json()) as Message[];
    expect(msgs.map((m) => [m.role, m.text])).toEqual([
      ["user", d.prompt],
      ["assistant", "네, 알겠어요."],
    ]);
    const threads = (await (await h.req("GET", "/api/threads", { token })).json()) as Thread[];
    const seen: unknown[] = [];
    for (let e; (e = await other.next(() => true, 300)); ) seen.push(e);
    await other.cancel();
    expect(seen.length).toBeGreaterThan(0);
    for (const [where, json] of [
      ["stream", JSON.stringify(stream)],
      ["messages", JSON.stringify(msgs)],
      ["threads", JSON.stringify(threads)],
      ["other device", JSON.stringify(seen)],
    ]) {
      expect({ where, tool: TOOL_ID.test(json!), head: json!.includes("둘러보기에서 맡긴") }).toEqual({ where, tool: false, head: false });
    }

    // the next turn: the person's new line alone, and the first row's how-to still in the model's history
    await readSse(await send(token, d.thread.id, "서울 강서구, 32살, 재직 중이에요"));
    expect(lastUserText()).toBe("서울 강서구, 32살, 재직 중이에요");
    expect(h.turns.inputs.at(-1)!.history).toContainEqual({ role: "user", content: modelCopy("gov-benefits") });
  });

  test("only the first message of the person's own new task thread, and only the exact line", async () => {
    h = await makeHarness();
    const { token, session } = await h.signup("haneul", { agentName: "깽이" });
    const line = seed("morning-briefing").prompt;

    // the same line again in that thread: no second how-to
    const d = await delegate(token, "morning-briefing");
    await readSse(await send(token, d.thread.id, d.prompt));
    expect(lastUserText()).toBe(modelCopy("morning-briefing"));
    await readSse(await send(token, d.thread.id, line));
    expect(lastUserText()).toBe(line);

    // the main thread is no new task thread
    await readSse(await send(token, session.mainThreadId, line));
    expect(lastUserText()).toBe(line);

    // a line that differs: the person's own words, nothing added
    const d2 = await delegate(token, "morning-briefing");
    await readSse(await send(token, d2.thread.id, `${line} 고마워`));
    expect(lastUserText()).toBe(`${line} 고마워`);
    const d3 = await delegate(token, "morning-briefing");
    await readSse(await send(token, d3.thread.id, "매일 아침 7시에 모닝 브리핑을 보내 줘"));
    expect(lastUserText()).toBe("매일 아침 7시에 모닝 브리핑을 보내 줘");

    // a new chat opened by hand whose first line is a template's: that request, with its how-to
    const fresh = (await (await h.req("POST", "/api/threads", { token, body: {} })).json()) as Thread;
    await readSse(await send(token, fresh.id, seed("subway-commute").prompt));
    expect(lastUserText()).toBe(modelCopy("subway-commute"));
  });

  test("a send refused before it was stored keeps the how-to when it is sent again", async () => {
    h = await makeHarness({ config: { dailyTokens: 1000 } });
    const { token, session } = await h.signup("haneul", { agentName: "깽이" });
    h.turns.set(async () => outcome("긴 답", { usage: { promptTokens: 1200, completionTokens: 300, totalTokens: 1500 } }));
    await readSse(await send(token, session.mainThreadId, "길게"));
    const d = await delegate(token, "travel-safety");
    const refused = await send(token, d.thread.id, d.prompt);
    expect(refused.status).toBe(429);
    expect((await (await h.req("GET", `/api/threads/${d.thread.id}/messages`, { token })).json()) as Message[]).toEqual([]);
    expect((await h.req("POST", "/api/tickets/use", { token, body: { kind: "basic" } })).status).toBe(200);
    h.turns.set(async () => outcome("어느 나라에 가세요?"));
    await readSse(await send(token, d.thread.id, d.prompt)); // the app's retry sends the stored text again
    expect(lastUserText()).toBe(modelCopy("travel-safety"));
  });
});
