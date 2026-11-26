import { afterEach, describe, expect, test } from "bun:test";
import type { DelegateResponse, ExploreResponse, ProfileResponse, Quota, Thread, Tickets, UiDefinitions, UserSettings, Message } from "@pickle/protocol";
import { makeHarness, outcome, readSse, T0, type Harness } from "./helpers.ts";
import { TEMPLATE_SEEDS } from "../src/explore.ts";

let h: Harness;
afterEach(async () => {
  await h.close();
});

describe("quota & tickets", () => {
  test("quota exceeded → 429 with a ticket hint; using a ticket resets today's usage", async () => {
    h = await makeHarness({ config: { dailyTokens: 1000 } });
    const { token, session } = await h.signup("haneul");
    const tid = session.mainThreadId;
    h.turns.set(async () => outcome("긴 답", { usage: { promptTokens: 1200, completionTokens: 300, totalTokens: 1500 } }));
    const events = await readSse(await h.req("POST", `/api/threads/${tid}/messages`, { token, body: { text: "길게" } }));
    const done = events.at(-1) as { type: "done"; quota: Quota };
    expect(done.quota).toMatchObject({ usedPct: 100, usedTokens: 1500, limitTokens: 1000 });

    const blocked = await h.req("POST", `/api/threads/${tid}/messages`, { token, body: { text: "또" } });
    expect(blocked.status).toBe(429);
    const err = (await blocked.json()) as { error: string; message: string };
    expect(err.error).toBe("quota_exceeded");
    expect(err.message).toContain("티켓");
    expect(err.message).toContain("새벽 4시");

    const used = await h.req("POST", "/api/tickets/use", { token, body: { kind: "basic" } });
    expect(used.status).toBe(200);
    const r = (await used.json()) as { quota: Quota; tickets: Tickets };
    expect(r.quota.usedTokens).toBe(0);
    expect(r.tickets).toEqual({ basic: 2, premium: 0 });

    // nothing to reset now; premium has none
    expect((await h.req("POST", "/api/tickets/use", { token, body: { kind: "basic" } })).status).toBe(400);
    h.turns.set(async () => outcome("ok", { usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } }));
    const ok = await readSse(await h.req("POST", `/api/threads/${tid}/messages`, { token, body: { text: "다시" } }));
    expect(ok.at(-1)!.type).toBe("done");
    const noPremium = await h.req("POST", "/api/tickets/use", { token, body: { kind: "premium" } });
    expect(noPremium.status).toBe(400);
    expect(((await noPremium.json()) as { error: string }).error).toBe("no_tickets");

    // profile keeps the full day's consumption in usage7d
    const profile = (await (await h.req("GET", "/api/profile", { token })).json()) as ProfileResponse;
    expect(profile.usage7d).toHaveLength(7);
    expect(profile.usage7d.at(-1)).toEqual({ day: "11-11", tokens: 1502 });
    expect(profile.quota.usedTokens).toBe(2);
  });

  test("the quota day turns over at 04:00 KST", async () => {
    h = await makeHarness({ config: { dailyTokens: 1000 }, now: Date.UTC(2026, 10, 11, 18, 30) }); // 03:30 KST on the 12th
    const { token, session } = await h.signup("haneul");
    h.turns.set(async () => outcome("x", { usage: { promptTokens: 0, completionTokens: 0, totalTokens: 1000 } }));
    await readSse(await h.req("POST", `/api/threads/${session.mainThreadId}/messages`, { token, body: { text: "a" } }));
    expect((await h.req("POST", `/api/threads/${session.mainThreadId}/messages`, { token, body: { text: "b" } })).status).toBe(429);
    h.clock.t = Date.UTC(2026, 10, 11, 19, 0); // 04:00 KST
    const res = await h.req("POST", `/api/threads/${session.mainThreadId}/messages`, { token, body: { text: "c" } });
    expect(res.status).toBe(200);
    await readSse(res);
  });
});

describe("explore", () => {
  test("7 real categories, popular templates with counts, personalised suggestions", async () => {
    h = await makeHarness({ now: Date.UTC(2026, 10, 10, 23, 0) }); // 08:00 KST
    const { token } = await h.signup("haneul", { displayName: "하늘", agentName: "깽이" });
    const ex = (await (await h.req("GET", "/api/explore", { token })).json()) as ExploreResponse;
    expect(ex.categories.map((c) => [c.title, c.icon])).toEqual([
      ["추천", "star"],
      ["혜택", "coins"],
      ["쇼핑", "bag"],
      ["여행", "plane"],
      ["사람", "people"],
      ["문화", "film"],
      ["집·생활", "house"],
    ]);
    // no made-up counts ("17,166명이 맡겼어요"): a count is real delegations only, so a fresh server shows 0 and the seed order
    expect(ex.popular[0]).toMatchObject({ id: "call-demo", title: "제 전화, 먼저 한번 받아 보실래요?", count: 0 });
    expect(ex.popular[1]).toMatchObject({ id: "gov-benefits", title: "내가 받을 수 있는 정부 지원사업을 찾아 드릴게요.", count: 0 });
    expect(ex.popular.every((t) => t.count === 0)).toBe(true);
    expect(ex.popular[1]!.skills).toEqual(["k_gov_support", "k_housing_notices"]);
    expect(ex.popular.length).toBeGreaterThanOrEqual(18);
    expect(ex.popular.every((t) => t.category !== "suggestion")).toBe(true);
    for (let i = 1; i < ex.popular.length; i++) expect(ex.popular[i - 1]!.count).toBeGreaterThanOrEqual(ex.popular[i]!.count);
    const ids = ex.suggestions.map((s) => s.id);
    expect(ids).toEqual(expect.arrayContaining(["morning-briefing", "connect-kakao", "suggest-wakeup"]));
    expect(ex.suggestions.find((s) => s.id === "suggest-wakeup")!.title).toContain("하늘님께");

    // connecting KakaoTalk and adding a schedule changes the suggestions
    await h.req("POST", "/api/connections/kakaotalk", { token, body: {} });
    await h.req("POST", "/api/schedules", { token, body: { title: "모닝", prompt: "브리핑", rule: "daily@07:00" } });
    const ex2 = (await (await h.req("GET", "/api/explore", { token })).json()) as ExploreResponse;
    expect(ex2.suggestions.map((s) => s.id)).not.toContain("connect-kakao");
    expect(ex2.suggestions.map((s) => s.id)).not.toContain("suggest-wakeup");
  });

  test("templates only use tools that exist", () => {
    const real = new Set([
      ...["k_weather", "k_fine_dust", "k_subway_arrival", "k_seoul_bike", "k_place_search", "k_directions", "k_news", "k_shopping", "k_gas_prices", "k_holidays"],
      ...["k_performances", "k_travel_safety", "k_stock", "k_law_search", "k_real_estate", "k_gov_support", "k_housing_notices", "k_school_lunch", "k_library_books", "k_han_river", "k_seoul_density"],
      ...["msg_list_chats", "msg_read", "msg_send", "sys_create_artifact", "sys_schedule_create", "sys_show_briefing", "sys_web_fetch", "sys_friend_message", "sys_phone_call"],
    ]);
    // upstreams that are down right now must not carry a template on their own
    const broken = new Set(["k_shopping", "k_gas_prices"]);
    for (const t of TEMPLATE_SEEDS) {
      if (!t.hidden && t.skills.length) expect(t.skills.every((s) => broken.has(s))).toBe(false);
      for (const s of t.skills) expect(broken.has(s)).toBe(false);
      for (const s of t.skills) expect(real.has(s)).toBe(true);
      // tool ids live in the model-only hint (template-hint.test.ts keeps them out of the line)
      for (const name of t.hint?.match(/\b(k|msg|sys)_[a-z_]+/g) ?? []) expect(real.has(name)).toBe(true);
    }
    expect(new Set(TEMPLATE_SEEDS.filter((t) => !t.hidden).map((t) => t.category))).toEqual(
      new Set(["recommend", "benefit", "shopping", "travel", "people", "culture", "home"]),
    );
  });

  test("delegate creates a task thread and increments the count", async () => {
    h = await makeHarness();
    const { token } = await h.signup("haneul", { agentName: "깽이" });
    const res = await h.req("POST", "/api/explore/gov-benefits/delegate", { token });
    expect(res.status).toBe(201);
    const d = (await res.json()) as DelegateResponse;
    expect(d.thread).toMatchObject({ kind: "task", title: "내가 받을 수 있는 정부 지원사업을 찾아 드릴게요.", subtitle: "깽이에게 맡긴 일", icon: "coins" });
    expect(d.prompt).toBe("지금 신청할 수 있는 정부 지원사업과 청년·주거 공고를 내 조건에 맞춰 찾아 줘.");
    const threads = (await (await h.req("GET", "/api/threads", { token })).json()) as Thread[];
    expect(threads.map((t) => t.id)).toContain(d.thread.id);
    const ex = (await (await h.req("GET", "/api/explore", { token })).json()) as ExploreResponse;
    expect(ex.popular.find((t) => t.id === "gov-benefits")!.count).toBe(1);
    expect(ex.popular[0]!.id).toBe("gov-benefits"); // the one real delegation puts it first

    const turnsBefore = h.turns.inputs.length;
    const usedBefore = ((await (await h.req("GET", "/api/profile", { token })).json()) as ProfileResponse).quota.usedTokens;
    const call = (await (await h.req("POST", "/api/explore/call-demo/delegate", { token })).json()) as DelegateResponse;
    expect(call.thread).toMatchObject({ kind: "call", subtitle: "깽이의 외부 통화" });
    expect(call.prompt).toBe("");
    const opener = (await (await h.req("GET", `/api/threads/${call.thread.id}/messages`, { token })).json()) as Message[];
    expect(opener).toHaveLength(1);
    expect(opener[0]).toMatchObject({
      role: "assistant",
      text: "누구에게 어떤 용건으로 전화할까요? 상대 번호와 하고 싶은 말을 알려 주시면, 걸기 전에 한 번 더 확인받을게요.",
      cards: [],
    });
    expect(opener[0]!.author).toBeUndefined(); // personal threads: plain agent message, like any other
    expect(h.turns.inputs.length).toBe(turnsBefore); // no LLM call
    expect(((await (await h.req("GET", "/api/profile", { token })).json()) as ProfileResponse).quota.usedTokens).toBe(usedBefore);
    // the opener is part of the call thread's history for the user's reply
    h.turns.set(async () => outcome("확인할게요"));
    await readSse(await h.req("POST", `/api/threads/${call.thread.id}/messages`, { token, body: { text: "엄마한테 010-1234-5678로 저녁 먹었냐고 물어봐 줘" } }));
    expect(h.turns.inputs.at(-1)!.history.at(-1)).toMatchObject({ role: "assistant", content: opener[0]!.text });
    expect((await h.req("POST", "/api/explore/nope/delegate", { token })).status).toBe(404);
  });
});

describe("profile, settings, agent, sdui", () => {
  test("profile summary, settings deep merge + validation, agent patch", async () => {
    h = await makeHarness({ now: T0 });
    const { token, session } = await h.signup("haneul");
    await h.req("POST", "/api/connections/kakaotalk", { token, body: {} });
    const p = (await (await h.req("GET", "/api/profile", { token })).json()) as ProfileResponse;
    expect(p.connections).toEqual({ connected: 1, total: 2, icons: ["kakao"] });
    expect(p.tickets).toEqual({ basic: 3, premium: 0 });
    expect(p.paymentMethods).toBe(0);
    expect(p.savedLogins).toBe(0);

    const s = await h.req("PATCH", "/api/settings", { token, body: { notifications: { briefingTime: "08:15" }, display: { theme: "dark" } } });
    expect(s.status).toBe(200);
    const settings = (await s.json()) as UserSettings;
    expect(settings.notifications).toMatchObject({ briefingTime: "08:15", briefing: true, taskDone: true });
    expect(settings.display.theme).toBe("dark");
    expect((await h.req("PATCH", "/api/settings", { token, body: { notifications: { briefingTime: "25:00" } } })).status).toBe(400);
    expect((await h.req("PATCH", "/api/settings", { token, body: { hacker: true } })).status).toBe(400);
    expect((await h.req("PATCH", "/api/settings", { token, body: { display: { textScale: 3 } } })).status).toBe(400);

    const a = await h.req("PATCH", "/api/agent", { token, body: { name: "콩이", enabledSkills: ["k.weather"] } });
    expect(a.status).toBe(200);
    expect((await a.json()) as { name: string }).toMatchObject({ name: "콩이", enabledSkills: ["k.weather"] });
    expect((await h.req("PATCH", "/api/agent", { token, body: { enabledSkills: ["k.nope"] } })).status).toBe(400);
    expect(h.db.userById(session.user.id)!.agent_name).toBe("콩이");

    const ui = (await (await h.req("GET", "/api/ui-definitions", { token })).json()) as UiDefinitions;
    expect(ui.tabs.map((t) => [t.title, t.icon])).toEqual([
      ["채팅", "chat"],
      ["둘러보기", "compass"],
      ["보관함", "archive"],
      ["나의 모시", "person"],
    ]);
    expect(ui.drawer.map((d) => d.title)).toEqual(["기본 채팅", "친구", "둘러보기", "보관함", "나의 모시"]);
    expect(ui.composer.placeholder).toBe("메시지 보내기");
    expect(ui.archive.segments.map((x) => x.title)).toEqual(["문서", "사진·파일"]);
    expect(ui.archive.emptyArtifacts).toContain("아직 만든 문서가 없어요");
    expect(ui.archive.emptyArtifacts).toContain("콩이하고 함께 필요한 문서나 대시보드를 만들어 보세요");
    // 나의 모시 B order: sections, then each section's rows
    expect(ui.profile.sections.map((x) => [x.id, x.title])).toEqual([
      ["quota", "사용량"],
      ["account", "내 계정"],
      ["agent", "콩이"],
      ["security", "개인 정보와 보안"],
      ["app", "앱 사용"],
    ]);
    expect(ui.profile.sections.map((x) => x.rows.map((r) => r.id))).toEqual([
      ["quota"],
      ["account", "phone"],
      ["connections", "schedules", "invest", "friends", "privacy-scope"],
      ["logins", "payments", "access-log", "privacy"],
      ["notifications", "display"],
    ]);
    const rows = ui.profile.sections.flatMap((x) => x.rows.map((r) => r.title));
    expect(rows).toEqual(expect.arrayContaining(["결제 수단", "저장된 로그인", "정보 공개 범위", "예약된 일", "친구", "내 전화번호", "알림 설정", "화면 및 디자인"]));

    // skills + memories
    expect(((await (await h.req("GET", "/api/skills", { token })).json()) as unknown[]).length).toBe(1);
    await h.launcher.remember(session.user.id, "커피는 라떼");
    const mems = (await (await h.req("GET", "/api/memories", { token })).json()) as { id: string }[];
    expect(mems).toHaveLength(1);
    expect((await h.req("DELETE", `/api/memories/${mems[0]!.id}`, { token })).status).toBe(200);
    expect((await h.req("DELETE", `/api/memories/${mems[0]!.id}`, { token })).status).toBe(404);
  });
});
