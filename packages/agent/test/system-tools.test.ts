import { describe, expect, test } from "bun:test";
import { isBlockedAddress, normalizeDashboard, normalizeScheduleRule, systemTools, toOpenAiTools, webFetchTool, type ToolDef } from "../src/index.ts";
import { timeQuoteFound, timesNamed } from "../src/system-tools.ts";
import { fakeCtx, fakeStore } from "./mock-llm.ts";

const tools = systemTools();
const byName = (n: string): ToolDef => tools.find((t) => t.name === n)!;
const NOW = new Date("2026-11-11T09:30:00Z"); // 18:30 KST, Wednesday

test("every system tool has a valid OpenAI name, a schema and a Korean title", () => {
  const names = tools.map((t) => t.name);
  expect(names).toEqual([
    "sys_time",
    "sys_remember",
    "sys_recall",
    "sys_create_artifact",
    "sys_schedule_create",
    "sys_schedule_list",
    "sys_schedule_delete",
    "sys_file_read",
    "sys_friends_list",
    "sys_friend_message",
    "sys_show_briefing",
    "sys_web_fetch",
  ]);
  for (const t of tools) {
    expect(t.name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    expect(t.parameters.type).toBe("object");
    expect(t.title({}).length).toBeGreaterThan(0);
  }
});

test("sys_time reports KST", async () => {
  const r = await byName("sys_time").run({}, fakeCtx({ now: () => NOW }));
  expect(r.summary).toBe("2026년 11월 11일 (수) 오후 6:30");
  expect((r.data as { iso: string }).iso).toBe("2026-11-11T18:30:00+09:00");
});

test("sys_remember stores facts but refuses secrets", async () => {
  const ctx = fakeCtx();
  const store = ctx.store as ReturnType<typeof fakeStore>;
  const ok = await byName("sys_remember").run({ text: "커피는 아이스 아메리카노를 좋아함" }, ctx);
  expect(ok.ok).toBe(true);
  expect(ok.memory).toBe("커피는 아이스 아메리카노를 좋아함");
  for (const secret of ["내 비밀번호는 hunter2!", "카드번호 1234-5678-9012-3456", "토큰: sk-abcdefghijklmnop1234"]) {
    const r = await byName("sys_remember").run({ text: secret }, ctx);
    expect(r.ok).toBe(false);
  }
  expect(store.facts).toEqual(["커피는 아이스 아메리카노를 좋아함"]);
});

test("sys_create_artifact validates dashboards and returns an artifact card", async () => {
  const ctx = fakeCtx();
  const store = ctx.store as ReturnType<typeof fakeStore>;
  const content = JSON.stringify({
    widgets: [
      { type: "stat", label: "이번 달 지출", value: 412000, delta: "+3%" },
      { type: "bars", label: "주간", points: [{ x: "월", y: "3" }, { x: "화", y: 5 }, { x: "", y: 1 }] },
      { type: "pie", label: "unsupported" },
      { type: "list", label: "할 일", items: ["장보기", ""] },
    ],
  });
  const r = await byName("sys_create_artifact").run({ title: "가계부", kind: "dashboard", content }, ctx);
  expect(r.ok).toBe(true);
  expect(r.card).toMatchObject({ type: "artifact", artifactId: "art_1", title: "가계부", kind: "dashboard" });
  expect(JSON.parse(store.artifacts[0]!.content)).toEqual({
    widgets: [
      { type: "stat", label: "이번 달 지출", value: "412000", delta: "+3%" },
      { type: "bars", label: "주간", points: [{ x: "월", y: 3 }, { x: "화", y: 5 }] },
      { type: "list", label: "할 일", items: ["장보기"] },
    ],
  });
  const bad = await byName("sys_create_artifact").run({ title: "x", kind: "dashboard", content: "not json" }, ctx);
  expect(bad.ok).toBe(false);
  expect(normalizeDashboard('{"widgets":[]}').ok).toBe(false);
});

describe("sys_create_artifact kind html", () => {
  const HTML = '<style>.c{padding:16px}</style><div class="c"><h1>주간 일정</h1><p>월 10:00 팀 회의 · 화 14:00 치과</p></div>';

  test("stores the fragment whole (no 60k clip) and answers with an id and a text preview, never the HTML", async () => {
    const ctx = fakeCtx();
    const store = ctx.store as ReturnType<typeof fakeStore>;
    const big = `${HTML}<p>${"가".repeat(30_000)}</p>`; // ~90 KB, over the markdown kinds' 60k-character clip
    const r = await byName("sys_create_artifact").run({ title: "주간 일정", kind: "html", content: big }, ctx);
    expect(r.ok).toBe(true);
    expect(store.artifacts[0]).toMatchObject({ title: "주간 일정", kind: "html", content: big });
    expect(r.card).toMatchObject({ type: "artifact", artifactId: "art_1", title: "주간 일정", kind: "html" });
    expect((r.card as { preview: string }).preview.startsWith("월 10:00 팀 회의 · 화 14:00 치과")).toBe(true);
    expect((r.card as { preview: string }).preview.length).toBeLessThanOrEqual(140);
    expect(r.summary).toBe("'주간 일정' 화면을 만들었어요");
    const forModel = JSON.stringify({ summary: r.summary, data: r.data });
    expect(forModel).not.toContain("<style>");
    expect(forModel).not.toContain("가가가");
    expect(r.data).toMatchObject({ artifactId: "art_1", kind: "html" });
  });

  test("a card drawing an unsaved event (visible 저장 전 and 시간 미정) gets design-director's reply note; other cards don't", async () => {
    const NOTE =
      "이 카드에 저장 전으로 그린 일정은 일정에 저장되지 않았어요. 답에서는 이 일정을 '카드에만 그려 뒀어요'라고 쓰고, " +
      "'넣다'는 저장된 일정에만 써요. 끝에는 '몇 시인지 알려 주시면 일정에 넣을게요.'라고 써요.";
    const draw = async (content: string) => (await byName("sys_create_artifact").run({ title: "이번 주 일정", kind: "html", content }, fakeCtx())).data as { note?: string };
    const week = (wedding: string) =>
      `<style>.s{color:var(--text-2)}</style><div class="d"><b>18</b> 수 <span>오후 7:30</span> 치과</div><div class="d"><b>21</b> 토 ${wedding}</div>`;
    expect((await draw(week('<span class="t">시간 미정</span><span>결혼식</span><span class="s">저장 전</span>'))).note).toBe(NOTE);
    expect((await draw(week("<span>시간&nbsp;미정</span> 결혼식 <em>저장&nbsp;전</em>"))).note).toBe(NOTE); // spacing aside
    // 저장 전 alone is common on other cards
    expect((await draw('<div><h2>설정</h2><p>저장 전 확인해 주세요</p></div>')).note).toBeUndefined();
    expect((await draw(week('<span>시간 미정</span> 결혼식'))).note).toBeUndefined();
    // only the visible text counts: CSS, class names and attributes don't
    const hidden = '<style>.u::after{content:"저장 전 시간 미정"}</style><div class="저장전 시간미정" title="저장 전" data-x="시간 미정">결혼식</div>';
    expect((await draw(hidden)).note).toBeUndefined();
    expect((await draw(week('<span title="시간 미정">--</span> 결혼식 <span>저장 전</span>'))).note).toBeUndefined();
    expect((await draw(HTML)).note).toBeUndefined();
    // the agent's own rows card (saveAgentCard) is not the model's drawing: no note there
    const rows = await byName("sys_create_artifact").saveAgentCard!({ title: "전부", html: week("<span>시간 미정</span> 결혼식 <span>저장 전</span>") }, fakeCtx());
    expect(rows.ok).toBe(true);
    expect((rows.data as { note?: string }).note).toBeUndefined();
  });

  test("the model's call never reaches the agent-card size (300 KB): no second argument to the store, whatever the arguments say", async () => {
    const ctx = fakeCtx();
    const store = ctx.store as ReturnType<typeof fakeStore>;
    const r = await byName("sys_create_artifact").run({ title: "목록", kind: "html", content: HTML, agentCard: true, opts: { agentCard: true } }, ctx);
    expect(r.ok).toBe(true);
    expect(store.artifacts[0]).not.toHaveProperty("opts");
    expect(Object.keys((byName("sys_create_artifact").parameters as { properties: object }).properties)).not.toContain("agentCard");
  });

  test("saveAgentCard (the agent's own '전부' card): up to 300 KB through the store's agentCard, the same refusals and result as run", async () => {
    const tool = byName("sys_create_artifact");
    const row = '<li><a href="https://clinic.example.jp/p">도쿄 롯폰기 클리닉</a> · 도쿄 · 39,800엔</li>';
    const big = `<ul>${row.repeat(Math.ceil((200 * 1024) / Buffer.byteLength(row)))}</ul>`;
    const ctx = fakeCtx();
    const store = ctx.store as ReturnType<typeof fakeStore>;
    const r = await tool.saveAgentCard!({ title: "일본 마운자로 전부", html: big }, ctx);
    expect(r).toMatchObject({ ok: true, summary: "'일본 마운자로 전부' 화면을 만들었어요", data: { artifactId: "art_1", kind: "html" } });
    expect(r.card).toMatchObject({ type: "artifact", artifactId: "art_1", kind: "html", preview: expect.stringContaining("도쿄 롯폰기 클리닉") });
    expect(JSON.stringify(r.data)).not.toContain("<li>");
    expect(store.artifacts[0]).toMatchObject({ kind: "html", content: big, opts: { agentCard: true } });
    // one card per answer, shared with the model's run (either order)
    expect(await tool.run({ title: "B", kind: "html", content: "<p>b</p>" }, ctx)).toMatchObject({ ok: false, data: { error: "one_per_answer" } });
    const ctx2 = fakeCtx();
    expect((await tool.run({ title: "A", kind: "html", content: "<p>a</p>" }, ctx2)).ok).toBe(true);
    expect(await tool.saveAgentCard!({ title: "B", html: big }, ctx2)).toMatchObject({ ok: false, data: { error: "one_per_answer" } });
    // voice, over 300 KB, no markup (never a guide call here)
    expect(await tool.saveAgentCard!({ title: "A", html: big }, fakeCtx({ mode: "voice" }))).toMatchObject({ ok: false, data: { error: "voice_mode" } });
    const huge = `<ul>${row.repeat(Math.ceil((301 * 1024) / Buffer.byteLength(row)))}</ul>`;
    expect(await tool.saveAgentCard!({ title: "A", html: huge }, fakeCtx())).toMatchObject({ ok: false, data: { error: "too_large", limit: 300 * 1024 } });
    expect(await tool.saveAgentCard!({ title: "A", html: "" }, fakeCtx())).toMatchObject({ ok: false, data: { error: "not_html" } });
    // the model's path keeps 150 KB
    expect(await tool.run({ title: "A", kind: "html", content: big }, fakeCtx())).toMatchObject({ ok: false, data: { error: "too_large", limit: 150 * 1024 } });
    // and the model never sees it: the wire schema is name, description and parameters
    expect(Object.keys(toOpenAiTools([tool])[0]!.function)).toEqual(["name", "description", "parameters"]);
  });

  test("saveAgentCard's next cards (more): only after this turn's agent card, each under the same 300 KB; never after the model's card or an agent card that failed to save", async () => {
    const tool = byName("sys_create_artifact");
    const ctx = fakeCtx();
    const store = ctx.store as ReturnType<typeof fakeStore>;
    expect(await tool.saveAgentCard!({ title: "목록 (2/2)", html: HTML, more: true }, ctx)).toMatchObject({ ok: false, data: { error: "no_card_to_continue" } });
    expect((await tool.saveAgentCard!({ title: "목록 (1/2)", html: HTML }, ctx)).ok).toBe(true);
    const next = await tool.saveAgentCard!({ title: "목록 (2/2)", html: HTML, more: true }, ctx);
    expect(next).toMatchObject({ ok: true, data: { artifactId: "art_2", kind: "html" }, card: { type: "artifact", artifactId: "art_2", title: "목록 (2/2)" } });
    expect(store.artifacts.map((a) => [a.title, (a as { opts?: unknown }).opts])).toEqual([["목록 (1/2)", { agentCard: true }], ["목록 (2/2)", { agentCard: true }]]);
    // still one card per answer for anything else; voice and size refusals hold for a next card too
    expect(await tool.run({ title: "B", kind: "html", content: HTML }, ctx)).toMatchObject({ ok: false, data: { error: "one_per_answer" } });
    expect(await tool.saveAgentCard!({ title: "B", html: HTML }, ctx)).toMatchObject({ ok: false, data: { error: "one_per_answer" } });
    const row = '<li><a href="https://clinic.example.jp/p">도쿄 롯폰기 클리닉</a> · 도쿄 · 39,800엔</li>';
    const huge = `<ul>${row.repeat(Math.ceil((301 * 1024) / Buffer.byteLength(row)))}</ul>`;
    expect(await tool.saveAgentCard!({ title: "목록 (3/3)", html: huge, more: true }, ctx)).toMatchObject({ ok: false, data: { error: "too_large", limit: 300 * 1024 } });
    // the model's card first: no agent card to go on from
    const m = fakeCtx();
    expect((await tool.run({ title: "A", kind: "html", content: HTML }, m)).ok).toBe(true);
    expect(await tool.saveAgentCard!({ title: "목록 (2/2)", html: HTML, more: true }, m)).toMatchObject({ ok: false, data: { error: "no_card_to_continue" } });
    // an agent card that failed to save, then the model's: none to go on from either
    const f = fakeCtx();
    const fs = f.store as ReturnType<typeof fakeStore>;
    const save = fs.createArtifact.bind(fs);
    let n = 0;
    fs.createArtifact = (async (...a: Parameters<typeof save>) => {
      if (n++ === 0) throw new Error("db busy");
      return save(...a);
    }) as typeof fs.createArtifact;
    await expect(tool.saveAgentCard!({ title: "목록 (1/2)", html: HTML }, f)).rejects.toThrow("db busy");
    expect((await tool.run({ title: "A", kind: "html", content: HTML }, f)).ok).toBe(true);
    expect(await tool.saveAgentCard!({ title: "목록 (2/2)", html: HTML, more: true }, f)).toMatchObject({ ok: false, data: { error: "no_card_to_continue" } });
  });

  test("one per answer: a second html call in the same turn is refused (also when the two run in parallel)", async () => {
    const ctx = fakeCtx();
    const store = ctx.store as ReturnType<typeof fakeStore>;
    const [a, b] = await Promise.all([
      byName("sys_create_artifact").run({ title: "A", kind: "html", content: HTML }, ctx),
      byName("sys_create_artifact").run({ title: "B", kind: "html", content: HTML }, ctx),
    ]);
    expect([a.ok, b.ok]).toEqual([true, false]);
    expect(b.data).toMatchObject({ error: "one_per_answer" });
    // other kinds still work in that turn, and the next turn (a new store) may draw again
    expect((await byName("sys_create_artifact").run({ title: "메모", kind: "document", content: "# 메모" }, ctx)).ok).toBe(true);
    expect((await byName("sys_create_artifact").run({ title: "C", kind: "html", content: HTML }, fakeCtx())).ok).toBe(true);
    expect(store.artifacts.map((x) => x.kind)).toEqual(["html", "document"]);
  });

  test("a failed store call does not use up the turn's one", async () => {
    const ctx = fakeCtx();
    const store = ctx.store as ReturnType<typeof fakeStore>;
    const real = store.createArtifact;
    store.createArtifact = async () => {
      throw new Error("화면에 남은 내용이 없어요");
    };
    await expect(byName("sys_create_artifact").run({ title: "A", kind: "html", content: "<script>x</script>" }, ctx)).rejects.toThrow("남은 내용");
    store.createArtifact = real;
    expect((await byName("sys_create_artifact").run({ title: "A", kind: "html", content: HTML }, ctx)).ok).toBe(true);
  });

  test("refused: in a call or meeting, over 150 KB, without markup", async () => {
    const voice = await byName("sys_create_artifact").run({ title: "A", kind: "html", content: HTML }, fakeCtx({ mode: "voice" }));
    expect(voice).toMatchObject({ ok: false, data: { error: "voice_mode" } });
    expect((await byName("sys_create_artifact").run({ title: "A", kind: "html", content: HTML }, fakeCtx({ mode: "text" }))).ok).toBe(true);

    const ctx = fakeCtx();
    const store = ctx.store as ReturnType<typeof fakeStore>;
    const huge = `<div>${"한".repeat(52_000)}</div>`; // 156 KB in UTF-8, 52k characters
    const big = await byName("sys_create_artifact").run({ title: "A", kind: "html", content: huge }, ctx);
    expect(big).toMatchObject({ ok: false, summary: "화면이 너무 커요 (153KB, 150KB까지)", data: { error: "too_large", limit: 150 * 1024 } });
    for (const content of ["# 마크다운 제목\n- 항목", "(HTML 8KB, 보관함에 있어요 — 여기선 생략)"]) {
      const r = await byName("sys_create_artifact").run({ title: "A", kind: "html", content }, ctx);
      expect([content, r.ok, (r.data as { error?: string })?.error]).toEqual([content, false, "not_html"]);
    }
    expect(store.artifacts).toEqual([]);
  });

  test("what the store's cleaning removed is told to the model as counts; the preview comes from the stored copy", async () => {
    const ctx = fakeCtx();
    const store = ctx.store as ReturnType<typeof fakeStore>;
    store.createArtifact = async () => ({
      id: "art_9",
      html: { content: "<p>남은 글</p>", removed: { elements: 1, handlers: 2, remote: 0, links: 0 } },
    });
    const r = await byName("sys_create_artifact").run({ title: "A", kind: "html", content: '<p onclick="x">남은 글</p><script>비밀</script>' }, ctx);
    expect(r.ok).toBe(true);
    expect((r.data as { removed: string }).removed).toBe("Removed before saving (not allowed): 1 blocked elements (script, iframe, object, embed, link), 2 event handlers or form actions.");
    expect((r.card as { preview: string }).preview).toBe("남은 글");
    expect((r.data as { tuned?: string }).tuned).toBeUndefined();
  });

  test("a real event never gets a made-up time: sys_schedule_create and the html guide carry the same sentence", () => {
    const rule = "A real event or reminder needs a time: if the user gave none, don't call sys_schedule_create and don't pick one yourself (정오 included); draw it as 시간 미정 and end the reply with 몇 시인지 알려 주시면 일정에 넣을게요.";
    expect(byName("sys_schedule_create").description).toContain(rule);
    expect(byName("sys_create_artifact").description).toContain(rule);
  });

  test("what the store tuned (sizes under 13px, --text-3 text) is told to the model too", async () => {
    const ctx = fakeCtx();
    const store = ctx.store as ReturnType<typeof fakeStore>;
    store.createArtifact = async () => ({
      id: "art_10",
      html: { content: "<p>글</p>", removed: { elements: 0, handlers: 0, remote: 0, links: 0 }, tuned: { fontSize: 3, textColor: 1 } },
    });
    const r = await byName("sys_create_artifact").run({ title: "A", kind: "html", content: '<p style="font-size:11px">글</p>' }, ctx);
    expect(r.data).toMatchObject({
      tuned: "Fixed before saving: 3 font sizes under 13px raised to 13px, 1 text colours changed from --text-3 to --text-2. Next time write text 13px or more and secondary text in --text-2.",
    });
    expect((r.data as { removed?: string }).removed).toBeUndefined();
  });

  test("content \"\" returns the design guide whole (over the loop's 6 KB default), stores nothing, and leaves the turn's one", async () => {
    const ctx = fakeCtx();
    const store = ctx.store as ReturnType<typeof fakeStore>;
    const tool = byName("sys_create_artifact");
    for (const content of ["", "   ", ".", "placeholder"]) {
      const g = await tool.run({ title: "주간 일정", kind: "html", content }, ctx);
      expect(g).toMatchObject({ ok: true, summary: "화면 가이드를 확인했어요" });
      const guide = (g.data as { guide: string }).guide;
      for (const part of ["THE CARD", "THEME", "--accent-fill", "PATTERNS", "Directory", "Don't ask back, even when details are missing"]) expect(guide).toContain(part);
      expect(g.card).toBeUndefined();
      const bytes = Buffer.byteLength(JSON.stringify({ ok: g.ok, summary: g.summary, data: g.data }));
      expect(bytes).toBeGreaterThan(6 * 1024);
      expect(bytes).toBeLessThanOrEqual(tool.maxResultBytes!);
    }
    expect(store.artifacts).toEqual([]);
    expect((await tool.run({ title: "주간 일정", kind: "html", content: HTML }, ctx)).ok).toBe(true);
    // in a call or meeting it is refused like the fragment
    expect(await tool.run({ title: "A", kind: "html", content: "" }, fakeCtx({ mode: "voice" }))).toMatchObject({ ok: false, data: { error: "voice_mode" } });
  });

  test("the description is the short summary: when to draw, defaults over questions, the guide call, variables, links", () => {
    const d = byName("sys_create_artifact").description;
    for (const part of ['HTML card (kind:"html")', "One card per answer", 'content:"" to get the full guide', "Don't ask back, even when details are missing", "--accent-fill", '<a href="https://...">', "at most 4 columns"])
      expect(d).toContain(part);
    expect(d).not.toContain("THE CARD"); // the guide itself is not in it
    // the 13px and --text-3 rules are the sanitizer's now (tuneCss), the accent contrast the frame's (#0066cc)
    expect(d).not.toContain("13px");
    expect(d.length).toBeLessThan(2500);
    const t = byName("sys_create_artifact").title;
    expect(t({ title: "스레드", kind: "html" })).toBe("'스레드' 화면 만드는 중"); // while the fragment streams
    expect(t({ title: "스레드", kind: "html", content: "" })).toBe("화면 가이드 보는 중");
  });
});

test("checklists are normalised to - [ ] lines", async () => {
  const ctx = fakeCtx();
  const store = ctx.store as ReturnType<typeof fakeStore>;
  await byName("sys_create_artifact").run({ title: "여행 준비", kind: "checklist", content: "# 준비물\n- 여권\n2. 충전기" }, ctx);
  expect(store.artifacts[0]!.content).toBe("# 준비물\n- [ ] 여권\n- [ ] 충전기");
});

describe("schedule rules", () => {
  test("daily / weekly are normalised", () => {
    expect(normalizeScheduleRule("daily@7:30", NOW)).toEqual({ ok: true, rule: "daily@07:30" });
    expect(normalizeScheduleRule("weekly@5,1,3,3@09:00", NOW)).toEqual({ ok: true, rule: "weekly@1,3,5@09:00" });
    expect(normalizeScheduleRule("weekly@0,8@09:00", NOW).ok).toBe(false);
    expect(normalizeScheduleRule("daily@25:00", NOW).ok).toBe(false);
  });
  test("once accepts ISO (KST when no offset) and epoch, rejects the past", () => {
    expect(normalizeScheduleRule("once@2026-11-12T09:00", NOW)).toEqual({ ok: true, rule: `once@${Date.parse("2026-11-12T00:00:00Z")}` });
    expect(normalizeScheduleRule("once@2026-11-12T09:00:00Z", NOW)).toEqual({ ok: true, rule: `once@${Date.parse("2026-11-12T09:00:00Z")}` });
    const epoch = NOW.getTime() + 3600_000;
    expect(normalizeScheduleRule(`once@${epoch}`, NOW)).toEqual({ ok: true, rule: `once@${epoch}` });
    expect(normalizeScheduleRule("once@2020-01-01T00:00", NOW).ok).toBe(false);
    expect(normalizeScheduleRule("every day", NOW).ok).toBe(false);
  });
  test("sys_schedule_create stores the normalised rule and returns a schedule card", async () => {
    const ctx = fakeCtx({ now: () => NOW });
    const store = ctx.store as ReturnType<typeof fakeStore>;
    const r = await byName("sys_schedule_create").run({ title: "아침 브리핑", prompt: "오늘 날씨 알려줘", rule: "daily@7:00", time_quote: "매일 아침 7시" }, ctx);
    expect(r.ok).toBe(true);
    expect(store.schedules[0]!.rule).toBe("daily@07:00");
    expect(r.card).toEqual({ type: "schedule", scheduleId: "sch_1", title: "아침 브리핑", when: "매일 07:00", enabled: true });
  });

  test("sys_schedule_list says it holds the user's 일정 in this app (models said 'no calendar is connected' without it)", () => {
    const d = byName("sys_schedule_list").description;
    expect(d).toContain("the user's own 일정, no calendar connection needed");
    expect(d).toContain("Read it first for 이번 주 일정, moving or changing a meeting");
    // the reminder line sits on both schedule tools, word for word
    const line = "For a reminder relative to a saved event ('회의 30분 전'), call sys_schedule_list first and take its time from there; don't ask the user for it.";
    expect(d).toContain(line);
    expect(byName("sys_schedule_create").description).toContain(line);
  });

  test("timesNamed reads clock times and delays the way people type them, on a 12-hour dial", () => {
    expect(timesNamed("내일 오후 3시")).toEqual(["3:00pm"]);
    expect(timesNamed("15:00")).toEqual(["3:00pm"]);
    expect(timesNamed("매일 아침 7시 반, 저녁 7시 20분")).toEqual(["7:30am", "7:20pm"]);
    expect(timesNamed("세 시 반에 열두시")).toEqual(["3:30", "0:00"]);
    expect(timesNamed("정오 · 자정 · 새벽 1시 · 밤 11시 · 밤 12시 · 낮 2시")).toEqual(["0:00pm", "0:00am", "1:00am", "11:00pm", "2:00pm"]);
    expect(timesNamed("10분 뒤 · 두 시간 후 · 반 시간 뒤 · 9am")).toEqual(["+10m", "+120m", "+30m", "9:00am"]);
    expect(timesNamed("７시")).toEqual(["7:00"]);
    // offsets: from now, or from a time named with them
    expect(timesNamed("30분 전 · 1시간 앞당겨 · 두 시간 미뤄")).toEqual(["-30m", "-60m", "+120m"]);
    expect(timesNamed("10시 30분 전")).toEqual(["10:00", "-30m", "10:30"]); // 10:30, or 30 minutes before 10
    // no time of day: a day, a duration, words
    expect(timesNamed("토요일")).toEqual([]);
    expect(timesNamed("두 시간 동안")).toEqual([]);
    expect(timesNamed("시간 미정")).toEqual([]);
  });

  test("timeQuoteFound: a time named and found in one source, copied or the same clock times; '토요일' is no time", () => {
    const said = ["이번 주 일정 카드로", "토요일 결혼식 추가해서 다시 보여줘"];
    expect(timeQuoteFound("토요일 결혼식 추가", said)).toBe(false); // the quote of snap-html-5 run 1, rule at noon
    expect(timeQuoteFound("12시", said)).toBe(false);
    expect(timeQuoteFound("", said)).toBe(false);
    expect(timeQuoteFound("오후 3시", ["토요일 오후 3시 결혼식"])).toBe(true);
    expect(timeQuoteFound("오후3시", ["토요일 오후 3 시 결혼식"])).toBe(true);
    expect(timeQuoteFound("오후 3시", ["토요일 3시야"])).toBe(true); // same clock time, 12-hour dial
    expect(timeQuoteFound("15:00 시작", ["[메일] 11/21(토) 15:00 시작, 그랜드홀"])).toBe(true);
    expect(timeQuoteFound("내일 아침", ["내일 아침에 알려줘"])).toBe(true); // vague, but the person's own words
    expect(timeQuoteFound("30분 뒤", ["30분 뒤에 알려줘"])).toBe(true);
    expect(timeQuoteFound("30분 뒤", ["1시간 뒤에 알려줘"])).toBe(false);
    // two sources are never glued together into one quote
    expect(timeQuoteFound("토요일 3시", ["토요일", "3시"])).toBe(true);
    expect(timeQuoteFound("결혼식 저녁", ["결혼식", "저녁"])).toBe(false);
    // the half of the day the words fixed is kept: '오후 3시' was not heard where only '새벽 3시' was; '3시' is not in '13시'
    expect(timeQuoteFound("오후 3시", ["새벽 3시에 깨워줘"])).toBe(false);
    expect(timeQuoteFound("3시", ["새벽 3시에 깨워줘"])).toBe(true);
    expect(timeQuoteFound("3시", ["13시에 회의"])).toBe(false);
    expect(timeQuoteFound("30분 뒤", ["30분 후에 알려줘"])).toBe(true);
  });

  test("sys_schedule_create stores only a time that came from the user or a tool result", async () => {
    const make = async (args: Record<string, string>, heard?: string[]) => {
      const ctx = fakeCtx({ now: () => NOW, ...(heard ? { heard: () => heard } : {}) });
      const r = await byName("sys_schedule_create").run({ title: "결혼식", prompt: "결혼식 알림", ...args }, ctx);
      return { r, stored: (ctx.store as ReturnType<typeof fakeStore>).schedules.map((s) => s.rule) };
    };
    const wedding = ["이번 주 일정 카드로", "토요일 결혼식 추가해서 다시 보여줘"];
    // the made-up noon wedding: nothing stored, and the note tells the reply to say 시간 미정 and ask
    for (const time_quote of ["12시", "정오", "토요일", "토요일 결혼식 추가", ""]) {
      const { r, stored } = await make({ rule: "once@2026-11-14T12:00", time_quote }, wedding);
      expect(r).toMatchObject({ ok: false, summary: "시간 미정으로 뒀어요", data: { error: "no_time_source" } });
      expect((r.data as { message: string }).message).toBe(
        "시간을 들은 곳이 없어서 일정을 만들지 않았어요. 카드에는 시간 미정으로 그리고 이름 아래에 저장 전이라고 적되, 일정 개수에는 세지 않아요. " +
          "답에는 카드에만 그렸다고 쓰고 넣었다고 하지 않아요. 끝에는 '몇 시인지 알려 주시면 일정에 넣을게요.'라고 써요.",
      );
      expect(stored).toEqual([]);
    }
    // from the user (this message, a steer, an earlier one) or from a tool result (a mail, a calendar): stored
    for (const [time_quote, heard] of [
      ["오후 3시", [...wedding, "오후 3시야"]],
      ["세시", ["토요일 결혼식 세 시에 있어"]],
      ["15:00", ["토요일 오후 3시 결혼식"]],
      ["15:00 시작", [...wedding, "[메일] 11/14(토) 15:00 시작, 그랜드홀"]],
    ] as const) {
      const { r, stored } = await make({ rule: "once@2026-11-14T15:00", time_quote }, [...heard]);
      expect(r.ok).toBe(true);
      expect(stored).toHaveLength(1);
    }
    expect((await make({ rule: "once@2026-11-11T19:00", time_quote: "30분 뒤" }, ["30분 뒤에 알려줘"])).r.ok).toBe(true);
    expect((await make({ rule: "once@2026-11-12T08:30", time_quote: "내일 아침" }, ["내일 아침에 깨워줘"])).r.ok).toBe(true);
    // a time that was given, but the rule is somewhere else
    const off = await make({ rule: "once@2026-11-14T12:00", time_quote: "오후 3시" }, ["토요일 오후 3시 결혼식"]);
    expect(off.r).toMatchObject({ ok: false, data: { error: "time_rule_mismatch" } });
    expect(off.stored).toEqual([]);
    // 오전 / 새벽 never become the afternoon (nor 오후 / 저녁 the morning), even when the quote leaves the word out
    const half = async (rule: string, time_quote: string, heard: string[]) => (await make({ rule, time_quote }, heard)).r;
    expect(await half("once@2026-11-12T15:00", "3시", ["내일 새벽 3시에 깨워줘"])).toMatchObject({ ok: false, data: { error: "time_rule_mismatch" } });
    expect((await half("once@2026-11-12T03:00", "3시", ["내일 새벽 3시에 깨워줘"])).ok).toBe(true);
    expect(await half("daily@22:00", "10시", ["매일 오전 10시 회의 알려줘"])).toMatchObject({ ok: false, data: { error: "time_rule_mismatch" } });
    expect(await half("daily@07:00", "저녁 7시", ["매일 저녁 7시에 알려줘"])).toMatchObject({ ok: false, data: { error: "time_rule_mismatch" } });
    expect(await half("once@2026-11-12T20:00", "내일 아침", ["내일 아침에 깨워줘"])).toMatchObject({ ok: false, data: { error: "time_rule_mismatch" } });
    // the same '3시' twice, once 새벽: either reading may be meant
    for (const rule of ["once@2026-11-12T03:00", "once@2026-11-12T15:00"])
      expect((await half(rule, "3시", ["내일 새벽 3시에 깨워주고 3시 회의도 알려줘"])).ok).toBe(true);
    // a calendar result (sys_schedule_list) is a source too, with its 오전
    const listed = '{"schedules":[{"title":"팀 주간 회의","human":"11월 16일 오전 10:00"}]}';
    expect((await half("once@2026-11-17T10:00", "오전 10:00", ["팀 주간 회의 하루 미뤄줘", listed])).ok).toBe(true);
    expect(await half("once@2026-11-17T22:00", "10:00", ["팀 주간 회의 하루 미뤄줘", listed])).toMatchObject({ ok: false, data: { error: "time_rule_mismatch" } });
    // a time moved from a heard one by a heard offset: the calendar's 오전 10:00 and the user's 30분 전
    const remind = ["팀 주간 회의 30분 전에 알림 하나 걸어줘", listed];
    expect((await half("once@2026-11-16T09:30", "오전 10:00 · 30분 전", remind)).ok).toBe(true);
    expect(await half("once@2026-11-16T21:30", "오전 10:00 · 30분 전", remind)).toMatchObject({ ok: false, data: { error: "time_rule_mismatch" } });
    expect(await half("once@2026-11-16T09:30", "오전 10:00", remind)).toMatchObject({ ok: false, data: { error: "time_rule_mismatch" } });
    expect((await half("once@2026-11-12T14:30", "3시 회의 30분 전", ["내일 3시 회의 30분 전에 알려줘"])).ok).toBe(true);
    expect(await half("once@2026-11-12T15:30", "3시 회의 30분 전", ["내일 3시 회의 30분 전에 알려줘"])).toMatchObject({ ok: false, data: { error: "time_rule_mismatch" } });
    for (const rule of ["once@2026-11-12T09:30", "once@2026-11-12T10:30"]) expect((await half(rule, "10시 30분 전", ["내일 10시 30분 전에 알려줘"])).ok).toBe(true);
    // an offset nobody said is no source
    expect(await half("once@2026-11-16T09:30", "오전 10:00 · 30분 전", ["팀 주간 회의 알림 걸어줘", listed])).toMatchObject({ ok: false, data: { error: "no_time_source" } });
    // no sources (a meeting stand-in, a test context): time_quote still has to name a time
    expect((await make({ rule: "once@2026-11-14T15:00", time_quote: "3시" })).r.ok).toBe(true);
    expect((await make({ rule: "once@2026-11-14T15:00", time_quote: "토요일" })).r.ok).toBe(false);
  });
});

test("outward-facing / destructive system tools require approval", () => {
  const ctx = fakeCtx();
  expect(byName("sys_friend_message").approval!({ friend: "진우", text: "생일 축하해" }, ctx)).toEqual({ title: "진우님의 모시에게 말을 전할까요?", detail: "생일 축하해" });
  expect(byName("sys_schedule_delete").approval!({ id: "s1", title: "아침 브리핑" }, ctx)?.title).toContain("아침 브리핑");
  for (const n of ["sys_time", "sys_remember", "sys_recall", "sys_create_artifact", "sys_schedule_create", "sys_show_briefing", "sys_web_fetch"]) {
    expect(byName(n).approval).toBeUndefined();
  }
});

test("sys_show_briefing falls back to the sparkles icon for unknown icons", async () => {
  const r = await byName("sys_show_briefing").run(
    {
      title: "오늘의 브리핑",
      items: [
        { icon: "sun", text: "서울 맑음 18°", actionLabel: "자세히", actionSend: "오늘 날씨 자세히 알려줘" },
        { icon: "unicorn", text: "오후 3시 회의" },
        { icon: "bus", text: "" },
      ],
    },
    fakeCtx(),
  );
  expect(r.card).toEqual({
    type: "briefing",
    title: "오늘의 브리핑",
    items: [
      { icon: "sun", text: "서울 맑음 18°", action: { label: "자세히", send: "오늘 날씨 자세히 알려줘" } },
      { icon: "sparkles", text: "오후 3시 회의" },
    ],
  });
});

describe("sys_web_fetch (SSRF-safe)", () => {
  test("address classifier blocks private, loopback, link-local and mapped ranges", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.0.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "::1", "::", "fe80::1", "fc00::1", "fd12:3456::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "64:ff9b::a00:1", "2001:db8::1"]) {
      expect(isBlockedAddress(ip)).toBe(true);
    }
    for (const ip of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"]) expect(isBlockedAddress(ip)).toBe(false);
  });

  test("blocks non-http schemes, credentials, odd ports and internal hosts without fetching", async () => {
    let fetched = 0;
    const t = webFetchTool({ lookup: async () => ["10.0.0.5"], fetch: async () => (fetched++, new Response("x")) });
    for (const url of ["file:///etc/passwd", "ftp://example.com/", "http://localhost/", "http://127.0.0.1/", "http://[::1]/", "http://2130706433/", "http://169.254.169.254/latest/meta-data/", "https://user:pw@example.com/", "https://example.com:8443/", "http://intranet/", "https://internal.example.com/"]) {
      const r = await t.run({ url }, fakeCtx());
      expect(r.ok).toBe(false);
    }
    expect(fetched).toBe(0);
  });

  test("re-validates every redirect hop", async () => {
    const t = webFetchTool({
      lookup: async (h) => (h === "public.example" ? ["93.184.216.34"] : ["192.168.1.1"]),
      fetch: async () => new Response(null, { status: 302, headers: { location: "http://router.example/admin" } }),
    });
    const r = await t.run({ url: "https://public.example/" }, fakeCtx());
    expect(r.ok).toBe(false);
    expect(r.summary).toContain("blocked");
  });

  test("connects to the vetted IP (Host header + TLS SNI keep the real name) to defeat DNS rebinding", async () => {
    const seen: { url: string; host: string | null; sni: string | undefined }[] = [];
    let lookups = 0;
    const t = webFetchTool({
      // a rebinding resolver: public first, private afterwards
      lookup: async () => (lookups++ === 0 ? ["93.184.216.34"] : ["169.254.169.254"]),
      fetch: async (url, init) => {
        seen.push({ url, host: new Headers(init.headers).get("host"), sni: init.tls?.serverName });
        return new Response("<p>ok</p>", { headers: { "content-type": "text/html" } });
      },
    });
    const r = await t.run({ url: "https://rebind.example/path?q=1" }, fakeCtx());
    expect(r.ok).toBe(true);
    expect(seen).toEqual([{ url: "https://93.184.216.34/path?q=1", host: "rebind.example", sni: "rebind.example" }]);
    expect((r.data as { url: string }).url).toBe("https://rebind.example/path?q=1");
  });

  test("strips HTML to text and caps the result at 8 KB", async () => {
    const html = `<!doctype html><html><head><title>뉴스 &amp; 날씨</title><style>.x{}</style><script>alert(1)</script></head><body><h1>제목</h1><p>첫 문단&nbsp;입니다.</p><!-- c --><ul><li>하나</li><li>둘</li></ul>${"<p>가나다라마바사</p>".repeat(2000)}</body></html>`;
    const t = webFetchTool({
      lookup: async () => ["93.184.216.34"],
      fetch: async () => new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } }),
    });
    const r = await t.run({ url: "https://news.example/a" }, fakeCtx());
    expect(r.ok).toBe(true);
    const d = r.data as { title: string; text: string; truncated: boolean; url: string };
    expect(d.title).toBe("뉴스 & 날씨");
    expect(d.text.startsWith("제목\n첫 문단 입니다.\n하나\n둘")).toBe(true);
    expect(d.text).not.toContain("alert");
    expect(new TextEncoder().encode(d.text).length).toBeLessThanOrEqual(8 * 1024);
    expect(d.truncated).toBe(true);
  });

  test("times out after the configured limit", async () => {
    const t = webFetchTool({
      timeoutMs: 50,
      lookup: async () => ["93.184.216.34"],
      fetch: (_u, init) => new Promise((_, rej) => init.signal?.addEventListener("abort", () => rej(new Error("aborted")))),
    });
    const r = await t.run({ url: "https://slow.example/" }, fakeCtx());
    expect(r.ok).toBe(false);
    expect(r.summary).toContain("시간 초과");
  });
});
