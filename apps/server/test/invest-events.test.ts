/**
 * Invest B2a: the event calendar and its D-1 reminder through the server (team-lead 0052 and 0056, DD 0109 §1): the
 * server's words for when and where from, D-1 at 08:00 KST the day before the event's market date (a holiday's eve
 * too), one card per person and send, each event's D-1 once by any path (again, a restart, deleted and added back),
 * and each person's events their own. No model call, no upstream.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { InvestEvent, InvestEventCard, ServerEvent } from "@pickle/protocol";
import { claimReminder, createEvent, MAX_EVENTS, type EventRow } from "../src/invest/events.ts";
import { InvestHub } from "../src/invest/hub.ts";
import { makeHarness, type Harness } from "./helpers.ts";

const KST = (y: number, mo: number, d: number, hh = 9, mi = 0) => Date.UTC(y, mo - 1, d, hh - 9, mi);
const DISCLAIMER_FLAG = true;

interface Person {
  uid: string;
  token: string;
  events: ServerEvent[];
  pushes: { title: string; tag?: string; body?: string }[];
}
const harnesses: Harness[] = [];
afterEach(async () => {
  while (harnesses.length) await harnesses.pop()!.close();
});

async function setup(now = KST(2026, 11, 24, 7, 0)) {
  const h = await makeHarness({ now });
  harnesses.push(h);
  const people = new Map<string, Person>();
  const pub = h.app.core.events.publish.bind(h.app.core.events);
  h.app.core.events.publish = (u, e) => {
    people.get(u)?.events.push(e);
    pub(u, e);
  };
  h.app.core.push.send = async (u, m) => {
    people.get(u)?.pushes.push(m as Person["pushes"][number]);
    return 0;
  };
  const person = async (handle: string): Promise<Person> => {
    const me = await h.signup(handle);
    const p = { uid: me.session.user.id, token: me.token, events: [], pushes: [] };
    people.set(p.uid, p);
    return p;
  };
  const api = async <T = Record<string, unknown>>(p: Person, method: string, path: string, body?: unknown) => {
    const res = await h.req(method, path, { token: p.token, body });
    return { status: res.status, body: (await res.json()) as T };
  };
  const remind = async (at: number) => {
    h.clock.t = at;
    const n = await h.app.core.invest.remindEvents();
    await h.app.core.idle();
    return n;
  };
  /** the D-1 cards in the database, by person, oldest first */
  const cards = (p: Person) =>
    (h.db.sql.query("SELECT m.thread_id, m.cards_json, m.llm_json, t.title, t.owner_id FROM messages m JOIN threads t ON t.id = m.thread_id WHERE m.cards_json LIKE '%invest_event%' ORDER BY m.created_at, m.rowid").all() as {
      thread_id: string;
      cards_json: string;
      llm_json: string;
      title: string;
      owner_id: string;
    }[])
      .filter((r) => r.owner_id === p.uid)
      .map((r) => ({ thread: r.title, card: (JSON.parse(r.cards_json) as InvestEventCard[])[0]!, record: (JSON.parse(r.llm_json) as { content: string }[])[0]!.content }));
  return { h, person, api, remind, cards };
}

const NVDA = { market: "US", day: "2026-11-25", time: "16:20", kind: "earnings", title: "3분기 실적 발표", symbol: "NVDA", source: "NVIDIA IR", sourceTier: "T1", confidence: "A", url: "https://example.org/nvda/ir" };
const SAMSUNG = { market: "KR", day: "2026-11-25", time: "10:00", kind: "earnings", title: "3분기 실적 설명회", symbol: "005930", source: "삼성전자 IR", sourceTier: "T1", confidence: "A" };
const FOMC = { market: "US", day: "2026-11-26", kind: "macro", title: "FOMC 의사록 공개", source: "Federal Reserve", sourceTier: "T1", confidence: "A" };

describe("the event calendar", () => {
  test("an event's words are the server's: symbol first, KST first with the US market's time, the market's date without a time, 출처 · 등급", async () => {
    const { person, api } = await setup();
    const a = await person("alice");
    const r = await api<InvestEvent>(a, "POST", "/api/invest/events", NVDA);
    expect(r.status).toBe(201);
    expect(r.body).toEqual({
      id: r.body.id,
      market: "US",
      day: "2026-11-25",
      time: "16:20",
      kind: "earnings",
      title: "3분기 실적 발표",
      symbol: "NVDA",
      heading: "NVDA 3분기 실적 발표",
      when: "11월 26일 06:20(미 동부 16:20)",
      source: "NVIDIA IR",
      sourceTier: "T1",
      url: "https://example.org/nvda/ir",
      confidence: "A",
      foot: "NVIDIA IR · A",
      remind: true,
      remindOn: "2026-11-24",
      reminded: false,
      author: "person",
      createdAt: KST(2026, 11, 24, 7, 0),
      updatedAt: KST(2026, 11, 24, 7, 0),
    });
    const words = async (body: Record<string, unknown>) => {
      const e = (await api<InvestEvent>(a, "POST", "/api/invest/events", body)).body;
      return [e.heading, e.when, e.foot, e.remindOn];
    };
    expect(await words(SAMSUNG)).toEqual(["005930 3분기 실적 설명회", "11월 25일 10:00", "삼성전자 IR · A", "2026-11-24"]);
    expect(await words(FOMC)).toEqual(["FOMC 의사록 공개", "미 동부 11월 26일 · 시각 미정", "Federal Reserve · A", "2026-11-25"]);
    expect(await words({ ...SAMSUNG, day: "2026-12-25", time: null, title: "배당 기준일" })).toEqual(["005930 배당 기준일", "12월 25일 · 시각 미정", "삼성전자 IR · A", "2026-12-24"]);
    // a title that starts with its symbol keeps one; daylight time: the US offset of the event's own day
    expect(await words({ ...NVDA, title: "NVDA 투자자의 날" })).toEqual(["NVDA 투자자의 날", "11월 26일 06:20(미 동부 16:20)", "NVIDIA IR · A", "2026-11-24"]);
    expect(await words({ ...NVDA, day: "2027-05-26", title: "1분기 실적 발표" })).toEqual(["NVDA 1분기 실적 발표", "2027년 5월 27일 05:20(미 동부 16:20)", "NVIDIA IR · A", "2027-05-25"]);
  });

  test("DD 0405 E: another KST year names it — the KST date's year with a time, the market date's without; this year's has none", async () => {
    const { h, person, api, remind, cards } = await setup();
    const a = await person("alice");
    const when = async (body: Record<string, unknown>) => (await api<InvestEvent>(a, "POST", "/api/invest/events", body)).body.when;
    expect(await when({ ...NVDA, day: "2026-12-30", title: "올해" })).toBe("12월 31일 06:20(미 동부 16:20)");
    // US 12-31 16:20 is KST 2027-01-01 06:20: the KST date decides; without a time the market's date does
    expect(await when({ ...NVDA, day: "2026-12-31", title: "해 넘김" })).toBe("2027년 1월 1일 06:20(미 동부 16:20)");
    expect(await when({ ...FOMC, day: "2026-12-31", title: "해 넘김 시각 미정" })).toBe("미 동부 12월 31일 · 시각 미정");
    expect(await when({ ...NVDA, day: "2027-01-04", title: "다음 해" })).toBe("2027년 1월 5일 06:20(미 동부 16:20)");
    expect(await when({ ...FOMC, day: "2027-01-05", title: "다음 해 시각 미정" })).toBe("미 동부 2027년 1월 5일 · 시각 미정");
    expect(await when({ ...SAMSUNG, day: "2027-01-05", title: "다음 해 국내" })).toBe("2027년 1월 5일 10:00");
    expect(await when({ ...SAMSUNG, day: "2027-01-05", time: null, title: "다음 해 국내 시각 미정" })).toBe("2027년 1월 5일 · 시각 미정");
    // the D-1 card of 12-31 for a 01-01 event carries the year (DD: fine); in 2027 the list drops it
    await api(a, "POST", "/api/invest/events", { ...SAMSUNG, day: "2027-01-01", title: "새해 일정" });
    expect(await remind(KST(2026, 12, 31, 8, 0))).toBe(1);
    expect(cards(a).map((c) => [c.card.title, c.card.rows.map((r) => r.when)])).toEqual([["005930 새해 일정", ["2027년 1월 1일 10:00"]]]);
    h.clock.t = KST(2027, 1, 1, 9, 0);
    const list = (await api<{ items: InvestEvent[] }>(a, "GET", "/api/invest/events")).body.items;
    expect(list.filter((e) => e.title === "새해 일정" || e.title === "다음 해 국내").map((e) => e.when)).toEqual(["1월 1일 10:00", "1월 5일 10:00"]);
  });

  test("each field is checked (400 invalid_event); one event per person, market, day and title (409 with it)", async () => {
    const { person, api } = await setup();
    const a = await person("alice");
    const cases: [Record<string, unknown>, string][] = [
      [{ market: "JP" }, "시장은 US, KR 가운데 하나예요."],
      [{ day: "2026-11-22" }, "지난 날짜예요."],
      [{ day: "2026-13-01" }, "날짜는 YYYY-MM-DD로 넣어 주세요."],
      [{ day: "2029-01-01" }, "일정은 2년 안으로 넣어 주세요."],
      [{ time: "24:00" }, "시각은 그 시장 시각 HH:MM으로 넣어 주세요."],
      [{ time: "9:30" }, "시각은 그 시장 시각 HH:MM으로 넣어 주세요."],
      [{ kind: "rumor" }, "종류는 earnings, macro, policy, contract, other 가운데 하나예요."],
      [{ title: "" }, "제목을 넣어 주세요."],
      [{ title: "가".repeat(81) }, "제목은 80자까지예요."],
      [{ symbol: "NV DA" }, "종목 기호가 올바르지 않아요."],
      [{ symbol: "005930" }, "종목과 시장이 맞지 않아요."],
      [{ sourceTier: "T4" }, "T4 출처는 T1·T2 출처로 확인하기 전까지 C 등급이에요."],
      [{ url: "ftp://example.org/x" }, "링크는 http나 https 주소만 넣을 수 있어요."],
      [{ remind: "yes" }, "D-1 알림은 켜기와 끄기로 정해 주세요."],
    ];
    for (const [patch, message] of cases) {
      const r = await api(a, "POST", "/api/invest/events", { ...NVDA, ...patch });
      expect([r.status, r.body.error, r.body.message, JSON.stringify(patch)]).toEqual([400, "invalid_event", message, JSON.stringify(patch)]);
    }
    // the US market's date is still the 23rd at 07:00 KST on the 24th: today there is not past
    expect((await api(a, "POST", "/api/invest/events", { ...FOMC, day: "2026-11-23", title: "오늘 밤" })).status).toBe(201);
    const first = await api<InvestEvent>(a, "POST", "/api/invest/events", { ...NVDA, symbol: "nvda" });
    expect([first.status, first.body.symbol]).toEqual([201, "NVDA"]);
    const dup = await api<{ error: string; event: InvestEvent }>(a, "POST", "/api/invest/events", { ...NVDA, time: "17:00" });
    expect([dup.status, dup.body.error, dup.body.event.id, dup.body.event.time]).toEqual([409, "event_exists", first.body.id, "16:20"]);
    expect((await api(a, "POST", "/api/invest/events", { ...NVDA, market: "US", day: "2026-11-27" })).status).toBe(201);
  });

  test("the list: yesterday (KST) to 60 days on by default, by day and instant; from and to are checked", async () => {
    const { h, person, api } = await setup();
    const a = await person("alice");
    for (const e of [FOMC, NVDA, SAMSUNG, { ...SAMSUNG, day: "2027-01-23", title: "먼 일정" }, { ...SAMSUNG, day: "2026-11-24", time: "15:30", title: "오늘" }]) expect((await api(a, "POST", "/api/invest/events", e)).status).toBe(201);
    const titles = async (q = "") => (await api<{ items: InvestEvent[] }>(a, "GET", `/api/invest/events${q}`)).body.items.map((e) => e.heading);
    expect(await titles()).toEqual(["005930 오늘", "005930 3분기 실적 설명회", "NVDA 3분기 실적 발표", "FOMC 의사록 공개"]);
    expect(await titles("?from=2026-11-25&to=2027-01-31")).toEqual(["005930 3분기 실적 설명회", "NVDA 3분기 실적 발표", "FOMC 의사록 공개", "005930 먼 일정"]);
    h.clock.t = KST(2026, 11, 28);
    expect(await titles()).toEqual(["005930 먼 일정"]);
    for (const [q, message] of [
      ["?from=11-25", "from은 YYYY-MM-DD로 넣어 주세요."],
      ["?from=2026-11-25&to=2026-11-24", "to가 from보다 앞이에요."],
      ["?from=2026-01-01&to=2027-12-31", "한 번에 400일까지 볼 수 있어요."],
    ]) {
      const r = await api(a, "GET", `/api/invest/events${q}`);
      expect([r.status, r.body.message]).toEqual([400, message]);
    }
  });

  test("D-1 is switched off and on with PATCH remind alone; DELETE takes the event away", async () => {
    const { person, api } = await setup();
    const a = await person("alice");
    const e = (await api<InvestEvent>(a, "POST", "/api/invest/events", { ...NVDA, remind: false })).body;
    expect(e.remind).toBe(false);
    const on = await api<InvestEvent>(a, "PATCH", `/api/invest/events/${e.id}`, { remind: true, title: "바뀐 제목", day: "2026-12-01" });
    expect([on.status, on.body.remind, on.body.title, on.body.day]).toEqual([200, true, "3분기 실적 발표", "2026-11-25"]);
    expect((await api(a, "PATCH", `/api/invest/events/${e.id}`, {})).body.message).toBe("D-1 알림은 켜기와 끄기로 정해 주세요.");
    expect((await api(a, "DELETE", `/api/invest/events/${e.id}`)).body).toEqual({ ok: true });
    const gone = await api(a, "DELETE", `/api/invest/events/${e.id}`);
    expect([gone.status, gone.body.error]).toEqual([404, "event_not_found"]);
    expect((await api(a, "PATCH", `/api/invest/events/${e.id}`, { remind: false })).status).toBe(404);
  });

  test("a person's upcoming events stop at the cap", async () => {
    const { h, person, api } = await setup();
    const a = await person("alice");
    const ins = h.db.sql.query("INSERT INTO invest_events (id, user_id, market, day, kind, title, source, source_tier, confidence, author, created_at, updated_at) VALUES ($id, $u, 'KR', '2026-12-01', 'other', $t, 's', 'T1', 'A', 'person', 1, 1)");
    h.db.tx(() => {
      for (let i = 0; i < MAX_EVENTS; i++) ins.run({ id: `ie_${i}`, u: a.uid, t: `t${i}` });
    });
    const r = await api(a, "POST", "/api/invest/events", NVDA);
    expect([r.status, r.body.error, r.body.message]).toEqual([400, "too_many_events", "다가오는 일정은 200개까지 둘 수 있어요."]);
  });
});

describe("D-1 (team-lead 0056: 08:00 KST the day before the event's market date)", () => {
  test("nothing before 08:00; at 08:00 one card with every event due, KST order; the banner and the lock screen get its title alone; A17 at the end", async () => {
    const { h, person, api, remind, cards } = await setup();
    const a = await person("alice");
    for (const e of [NVDA, SAMSUNG, FOMC]) await api(a, "POST", "/api/invest/events", e);
    expect(await remind(KST(2026, 11, 24, 7, 59))).toBe(0);
    expect(cards(a)).toEqual([]);
    expect(await remind(KST(2026, 11, 24, 8, 0))).toBe(2);
    const [one] = cards(a);
    expect(one!.thread).toBe("투자");
    expect(one!.card).toEqual({
      type: "invest_event",
      title: "일정 2개",
      rows: [
        { eventId: expect.any(String), title: "005930 3분기 실적 설명회", when: "11월 25일 10:00", foot: "삼성전자 IR · A" },
        { eventId: expect.any(String), title: "NVDA 3분기 실적 발표", when: "11월 26일 06:20(미 동부 16:20)", foot: "NVIDIA IR · A" },
      ],
      disclaimer: DISCLAIMER_FLAG,
    });
    expect(one!.record).toBe("[투자 일정] 005930 3분기 실적 설명회 · 11월 25일 10:00 · 삼성전자 IR · A / NVDA 3분기 실적 발표 · 11월 26일 06:20(미 동부 16:20) · NVIDIA IR · A");
    const banners = a.events.filter((e) => e.type === "notification");
    expect(banners.map((e) => (e.type === "notification" ? [e.title, e.body, e.icon] : null))).toEqual([["일정 2개", "", "chart"]]);
    expect(a.pushes.map((p) => [p.title, p.tag, p.body])).toEqual([["일정 2개", "invest:event:2026-11-25", undefined]]);
    // the next tick, the rest of the day: nothing again
    expect(await remind(KST(2026, 11, 24, 8, 0) + 30_000)).toBe(0);
    expect(await remind(KST(2026, 11, 24, 23, 59))).toBe(0);
    // the 25th at 08:00, from a beat of the server's clock: the FOMC minutes (US 26th, Thanksgiving) alone, titled with it
    h.clock.t = KST(2026, 11, 25, 8, 0);
    await h.app.core.invest.beat();
    await h.app.core.idle();
    expect(cards(a).map((c) => [c.card.title, c.card.rows.map((r) => r.when)])).toEqual([
      ["일정 2개", ["11월 25일 10:00", "11월 26일 06:20(미 동부 16:20)"]],
      ["FOMC 의사록 공개", ["미 동부 11월 26일 · 시각 미정"]],
    ]);
    const list = (await api<{ items: InvestEvent[] }>(a, "GET", "/api/invest/events")).body.items;
    expect(list.map((e) => [e.title, e.reminded])).toEqual([
      ["3분기 실적 설명회", true],
      ["3분기 실적 발표", true],
      ["FOMC 의사록 공개", true],
    ]);
    expect(h.db.sql.query("SELECT COUNT(*) AS n FROM invest_event_reminders WHERE message_id IS NOT NULL AND via = 'card'").get()).toEqual({ n: 3 });
  });

  test("a holiday's eve and a closed day: the date alone decides (US Thanksgiving, KR Christmas)", async () => {
    const { person, api, remind, cards } = await setup(KST(2026, 11, 20, 12, 0));
    const a = await person("alice");
    await api(a, "POST", "/api/invest/events", { ...NVDA, day: "2026-11-27", title: "블랙 프라이데이 조기 폐장" }); // its eve, the 26th, is Thanksgiving
    await api(a, "POST", "/api/invest/events", { ...SAMSUNG, day: "2026-12-25", time: null, title: "배당 기준일" }); // a closed day itself
    expect(await remind(KST(2026, 11, 26, 8, 0))).toBe(1);
    expect(await remind(KST(2026, 12, 24, 8, 0))).toBe(1);
    expect(cards(a).map((c) => c.card.title)).toEqual(["NVDA 블랙 프라이데이 조기 폐장", "005930 배당 기준일"]);
  });

  test("once by any path: two runs at once, a restarted hub, the event deleted and added back, a claim taken first", async () => {
    const { h, person, api, remind, cards } = await setup();
    const a = await person("alice");
    await api(a, "POST", "/api/invest/events", NVDA);
    h.clock.t = KST(2026, 11, 24, 8, 0);
    const [x, y] = await Promise.all([h.app.core.invest.remindEvents(), h.app.core.invest.remindEvents()]);
    await h.app.core.idle();
    expect([x, y]).toEqual([1, 1]); // one run, shared
    const again = new InvestHub(h.app.core); // a restart: a hub with nothing in memory
    expect(await again.remindEvents(KST(2026, 11, 24, 9, 0))).toBe(0);
    const id = (await api<{ items: InvestEvent[] }>(a, "GET", "/api/invest/events")).body.items[0]!.id;
    await api(a, "DELETE", `/api/invest/events/${id}`);
    const back = (await api<InvestEvent>(a, "POST", "/api/invest/events", NVDA)).body;
    expect([back.id === id, back.reminded]).toEqual([false, true]);
    // dated before 08:00 so that only the claim keeps it from going (DD 0405 F holds back one added after 08:00 anyway)
    const before8 = (eventId: string) => h.db.sql.query("UPDATE invest_events SET created_at = $t WHERE id = $id").run({ t: KST(2026, 11, 24, 7, 0), id: eventId });
    before8(back.id);
    expect(await remind(KST(2026, 11, 24, 10, 0))).toBe(0);
    // the daily report (B2c) claiming first leaves no card
    before8((await api<InvestEvent>(a, "POST", "/api/invest/events", SAMSUNG)).body.id);
    const row = h.db.sql.query("SELECT * FROM invest_events WHERE title = $t").get({ t: SAMSUNG.title }) as EventRow;
    expect(claimReminder(h.db, row, "daily", h.clock.t)).toBe(true);
    expect(claimReminder(h.db, row, "card", h.clock.t)).toBe(false);
    expect(await remind(KST(2026, 11, 24, 10, 1))).toBe(0);
    expect(cards(a)).toHaveLength(1);
    expect(a.pushes).toHaveLength(1);
  });

  test("DD 0405 F: added after 08:00 on its eve — by the person or the model: no D-1; by code: the next beat; before 08:00: at 08:00", async () => {
    const { h, person, api, remind, cards } = await setup();
    const a = await person("alice");
    // 07:59, the person: goes at 08:00
    h.clock.t = KST(2026, 11, 24, 7, 59);
    await api(a, "POST", "/api/invest/events", { ...SAMSUNG, title: "07:59 사람" });
    expect(await remind(KST(2026, 11, 24, 8, 0))).toBe(1);
    // 08:00 itself is not before 08:00
    await api(a, "POST", "/api/invest/events", { ...SAMSUNG, title: "08:00 사람" });
    expect(await remind(KST(2026, 11, 24, 8, 0) + 30_000)).toBe(0);
    // 08:30, the person and the model: nothing at the next beat or later that day
    h.clock.t = KST(2026, 11, 24, 8, 30);
    const mine = (await api<InvestEvent>(a, "POST", "/api/invest/events", { ...SAMSUNG, title: "08:30 사람" })).body;
    createEvent(h.db, a.uid, { ...SAMSUNG, title: "08:30 모델" }, "model", h.clock.t);
    expect(await remind(KST(2026, 11, 24, 8, 30) + 30_000)).toBe(0);
    expect(await remind(KST(2026, 11, 24, 23, 59))).toBe(0);
    // 08:30, code (a later event source): the next beat
    h.clock.t = KST(2026, 11, 24, 8, 30);
    createEvent(h.db, a.uid, { ...SAMSUNG, title: "08:30 코드" }, "code", h.clock.t);
    h.clock.t += 30_000;
    await h.app.core.invest.beat();
    await h.app.core.idle();
    expect(cards(a).map((c) => c.card.rows.map((r) => r.title))).toEqual([["005930 07:59 사람"], ["005930 08:30 코드"]]);
    const list = (await api<{ items: InvestEvent[] }>(a, "GET", "/api/invest/events")).body.items;
    expect(list.filter((e) => e.day === "2026-11-25").map((e) => [e.title, e.author, e.reminded])).toEqual([
      ["07:59 사람", "person", true],
      ["08:00 사람", "person", false],
      ["08:30 모델", "model", false],
      ["08:30 사람", "person", false],
      ["08:30 코드", "code", true],
    ]);
    expect(mine.reminded).toBe(false);
    // a server off at 08:00: an event added at 07:59 still goes when it comes back at 08:05
    h.clock.t = KST(2026, 11, 25, 7, 59);
    await api(a, "POST", "/api/invest/events", { ...SAMSUNG, day: "2026-11-26", title: "다음 날 07:59" });
    expect(await remind(KST(2026, 11, 25, 8, 5))).toBe(1);
  });

  test("not sent: switched off, its day already here, another day; switched back on before 08:00 it goes", async () => {
    const { person, api, remind, cards } = await setup();
    const a = await person("alice");
    const off = (await api<InvestEvent>(a, "POST", "/api/invest/events", { ...NVDA, remind: false })).body;
    await api(a, "POST", "/api/invest/events", { ...SAMSUNG, day: "2026-11-24", title: "오늘 일정" }); // D-1 was the 23rd
    await api(a, "POST", "/api/invest/events", { ...SAMSUNG, day: "2026-11-27", title: "모레 일정" });
    expect(await remind(KST(2026, 11, 24, 8, 0))).toBe(0);
    await api(a, "PATCH", `/api/invest/events/${off.id}`, { remind: true });
    expect(await remind(KST(2026, 11, 24, 8, 1))).toBe(1);
    expect(cards(a).map((c) => c.card.title)).toEqual(["NVDA 3분기 실적 발표"]);
    expect(await remind(KST(2026, 11, 25, 8, 0))).toBe(0);
    expect(await remind(KST(2026, 11, 26, 8, 0))).toBe(1);
  });

  test("isolation: each person's card holds their own events in their own thread; the same event for two people is two D-1s; nobody else switches or deletes mine", async () => {
    const { h, person, api, remind, cards } = await setup();
    const a = await person("alice");
    const b = await person("bob");
    const mine = (await api<InvestEvent>(a, "POST", "/api/invest/events", NVDA)).body;
    await api(a, "POST", "/api/invest/events", SAMSUNG);
    expect((await api(b, "POST", "/api/invest/events", NVDA)).status).toBe(201);
    expect((await api<{ items: InvestEvent[] }>(b, "GET", "/api/invest/events")).body.items.map((e) => e.heading)).toEqual(["NVDA 3분기 실적 발표"]);
    for (const [method, body] of [
      ["PATCH", { remind: false }],
      ["DELETE", undefined],
    ] as const) {
      const r = await api(b, method, `/api/invest/events/${mine.id}`, body);
      expect([r.status, r.body.error]).toEqual([404, "event_not_found"]);
    }
    expect(await remind(KST(2026, 11, 24, 8, 0))).toBe(3);
    expect(cards(a).map((c) => [c.card.title, c.card.rows.map((r) => r.title)])).toEqual([["일정 2개", ["005930 3분기 실적 설명회", "NVDA 3분기 실적 발표"]]]);
    expect(cards(b).map((c) => [c.card.title, c.card.rows.map((r) => r.title)])).toEqual([["NVDA 3분기 실적 발표", ["NVDA 3분기 실적 발표"]]]);
    expect(cards(b)[0]!.card.rows[0]!.eventId).not.toBe(mine.id);
    expect([a.pushes.map((p) => p.title), b.pushes.map((p) => p.title)]).toEqual([["일정 2개"], ["NVDA 3분기 실적 발표"]]);
    expect(a.events.filter((e) => e.type === "notification")).toHaveLength(1);
    expect(b.events.filter((e) => e.type === "notification")).toHaveLength(1);
    // code adds the same event for a third person after the others' D-1 went (DD 0405 F: code's go after 08:00): theirs
    // is still to go, and goes
    const c = await person("carol");
    const late = createEvent(h.db, c.uid, NVDA, "code", h.clock.t);
    expect(late.reminded).toBe(false);
    expect(await remind(KST(2026, 11, 24, 9, 0))).toBe(1);
    expect(cards(c).map((x) => x.card.title)).toEqual(["NVDA 3분기 실적 발표"]);
    expect([cards(a).length, cards(b).length]).toEqual([1, 1]);
  });
});
