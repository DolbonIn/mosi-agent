/**
 * Invest B2d-2a: new events found in public calendars (team-lead 0052 B2d, 1550, 1618; DD 1551) — the Federal
 * Register's rules, the Fed's FOMC meetings and BLS's releases, read once a day from 07:00 KST through the source gate
 * (default UA, one at a time, 403/429 pause), put in each invest user's calendar as author `code` with the code's
 * titles; the same day and title, a deleted find and a full calendar are left alone. Fixtures are synthetic and keep
 * only each source's shape (team-lead 1628); no real host, no model.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { InvestEvent } from "@pickle/protocol";
import * as idb from "../src/invest/db.ts";
import { BLS_URL, FEDREG_URL, FOMC_URL, parseBlsIcs, parseFedRegister, parseFomc } from "../src/invest/discovery.ts";
import { createEvent, dueReminders, EVENT_MAX_DAYS, EVENT_SPAN_DAYS, MAX_EVENTS } from "../src/invest/events.ts";
import { makeInvestUpstream } from "./fake-toss.ts";
import { makeHarness, type Harness } from "./helpers.ts";

const KST = (y: number, mo: number, d: number, hh = 9, mi = 0) => Date.UTC(y, mo - 1, d, hh - 9, mi);
const harnesses: Harness[] = [];
afterEach(async () => {
  while (harnesses.length) await harnesses.pop()!.close();
});

// ── fixtures: each source's shape, cut down ──

const FR = JSON.stringify({
  count: 7,
  results: [
    {
      document_number: "2026-24001",
      title: "Export Administration Regulations: Revisions to Advanced Computing and Semiconductor Manufacturing Items Controls",
      abstract: "The Bureau of Industry and Security amends the export controls on advanced computing items.",
      effective_on: "2026-12-15",
      html_url: "https://www.federalregister.gov/documents/2026/11/20/2026-24001/revisions",
      agencies: [{ slug: "industry-and-security-bureau" }],
      significant: true,
    },
    {
      document_number: "2026-24002",
      title: "Notice of Modification of Section 301 Action",
      abstract: "The Office of the United States Trade Representative modifies the action.",
      effective_on: "2027-03-01",
      html_url: "https://www.federalregister.gov/documents/2026/11/21/2026-24002/modification",
      agencies: [{ slug: "trade-representative-office-of-united-states" }],
      significant: true,
    },
    // none of the words: out
    { document_number: "2026-24003", title: "Entity List Additions", abstract: "Adds entities.", effective_on: "2026-12-20", html_url: "https://www.federalregister.gov/documents/x/2026-24003/a", agencies: [{ slug: "industry-and-security-bureau" }], significant: true },
    // not significant: out
    { document_number: "2026-24004", title: "Semiconductor Items", abstract: "", effective_on: "2026-12-22", html_url: "https://www.federalregister.gov/documents/x/2026-24004/b", agencies: [], significant: false },
    // no effective date: out
    { document_number: "2026-24005", title: "Section 232 Inclusions", abstract: "", effective_on: null, html_url: "https://www.federalregister.gov/documents/x/2026-24005/c", agencies: [], significant: true },
    // another site's address: out
    { document_number: "2026-24006", title: "Semiconductor Rule", abstract: "", effective_on: "2026-12-23", html_url: "https://elsewhere.example/2026-24006", agencies: [], significant: true },
    // past: parsed, outside the window
    { document_number: "2026-24007", title: "Export Controls Clarification", abstract: "", effective_on: "2026-11-20", html_url: "https://www.federalregister.gov/documents/x/2026-24007/d", agencies: [], significant: true },
  ],
});

const FOMC = `<html><body>
<div class="panel panel-default"><div class="panel-heading"><h4><a id="45">2026 FOMC Meetings</a></h4></div>
<div class="row fomc-meeting"><div class="fomc-meeting__month col-xs-5"><strong>October</strong></div><div class="fomc-meeting__date col-xs-4">27-28</div></div>
<div class="row fomc-meeting--shaded fomc-meeting"><div class="fomc-meeting__month col-xs-5"><strong>December</strong></div><div class="fomc-meeting__date col-xs-4">8-9*</div></div>
</div>
<div class="panel panel-default"><div class="panel-heading"><h4><a id="46">2027 FOMC Meetings</a></h4></div>
<div class="row fomc-meeting"><div class="fomc-meeting__month"><strong>January</strong></div><div class="fomc-meeting__date">26-27</div></div>
<div class="row fomc-meeting"><div class="fomc-meeting__month"><strong>March</strong></div><div class="fomc-meeting__date">16 (notation vote)</div></div>
<div class="row fomc-meeting"><div class="fomc-meeting__month"><strong>Apr/May</strong></div><div class="fomc-meeting__date">30-1</div></div>
</div></body></html>`;

const BLS = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "PRODID:-//BLS//Release Calendar//EN",
  "BEGIN:VEVENT",
  "UID:r1",
  "DTSTART;TZID=US-Eastern:20261210T083000",
  "SUMMARY:Consumer Price Index",
  "DESCRIPTION:Consumer Price Index for November 2026",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:r2",
  "DTSTART;TZID=US-Eastern:20261204T083000",
  "SUMMARY:Employment Situation",
  "DESCRIPTION:The Employment Situation for November 202",
  " 6",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:r3",
  "DTSTART:20261211T133000Z",
  "SUMMARY:Producer Price Index",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:r4",
  "DTSTART;TZID=US-Eastern:20261210T083000",
  "SUMMARY:Real Earnings",
  "DESCRIPTION:Real Earnings for November 2026",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:r5",
  "DTSTART;TZID=US-Eastern:20270205T083000",
  "SUMMARY:Employment Situation",
  "DESCRIPTION:The Employment Situation for January 2027",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:r6",
  "DTSTART;TZID=Europe/London:20261216T083000",
  "SUMMARY:Producer Price Index",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

const FR_URL = "https://www.federalregister.gov/documents/2026/11/20/2026-24001/revisions";
const BLS_PAGE = "https://www.bls.gov/schedule/news_release/";
/** what a run at 2026-12-01 07:00 KST (11-30 17:00 ET) puts in each invest user's calendar, in calendar order */
const FOUND: [string, string | null, string, string, string, string, string][] = [
  // day, time, kind, title, source, url, item
  ["2026-12-04", "08:30", "macro", "미국 11월 고용보고서 발표", "BLS", BLS_PAGE, "nfp:2026-11"],
  ["2026-12-09", "14:00", "policy", "FOMC 금리 결정", "연준", FOMC_URL, "fomc:2026-12-08"],
  ["2026-12-10", "08:30", "macro", "미국 11월 CPI 발표", "BLS", BLS_PAGE, "cpi:2026-11"],
  ["2026-12-11", "08:30", "macro", "미국 PPI 발표", "BLS", BLS_PAGE, "ppi:2026-12-11"], // no month written: the release day
  ["2026-12-15", null, "policy", "미국 수출통제 규정 시행", "연방관보", FR_URL, "fr:2026-24001"],
  ["2027-01-27", "14:00", "policy", "FOMC 금리 결정", "연준", FOMC_URL, "fomc:2027-01-26"],
  ["2027-03-01", null, "policy", "미국 관세 규정 시행", "연방관보", "https://www.federalregister.gov/documents/2026/11/21/2026-24002/modification", "fr:2026-24002"],
];
const SEVEN = KST(2026, 12, 1, 7, 0);

async function world(o: { sources?: boolean } = {}) {
  const up = makeInvestUpstream();
  up.state.fedreg = FR;
  up.state.fomc = FOMC;
  up.state.bls = BLS;
  const h = await makeHarness({ now: SEVEN - 60_000, config: { invest: { sources: o.sources ?? true, tossBase: null, outboundIp: null } }, deps: () => ({ investFetch: up.fetch }) });
  harnesses.push(h);
  const person = async (handle: string, invest: boolean) => {
    const s = await h.signup(handle);
    if (invest) idb.ensureSettings(h.db, s.session.user.id, h.clock.t);
    return { id: s.session.user.id, token: s.token };
  };
  const events = async (p: { token: string }) => ((await (await h.req("GET", "/api/invest/events?from=2026-11-30&to=2027-12-31", { token: p.token })).json()) as { items: InvestEvent[] }).items;
  const beat = async (at: number) => {
    h.clock.t = at;
    await h.app.core.invest.beat(at);
  };
  /** the calendars' hosts asked (after 08:00 the stage reading asks FRED and Yahoo too: not counted here) */
  const CAL = new Set(["www.federalregister.gov", "www.federalreserve.gov", "www.bls.gov"]);
  const hosts = () => up.calls.filter((c) => CAL.has(c.host)).map((c) => c.host);
  const row = (day: string) => h.db.sql.query("SELECT day, state, result FROM invest_discovery WHERE day = $d").get({ d: day }) as { day: string; state: string; result: string | null } | null;
  return { h, up, person, events, beat, hosts, row };
}
const shape = (e: InvestEvent) => [e.day, e.time, e.kind, e.title, e.source, e.url];

describe("the three calendars' shapes", () => {
  test("Federal Register: significant rules with an effective date, a word in the title or abstract, its own address; USTR or a tariff word reads 관세", () => {
    expect(parseFedRegister(FR)).toEqual([
      { source: "fedreg", item: "fr:2026-24001", market: "US", day: "2026-12-15", time: null, kind: "policy", title: "미국 수출통제 규정 시행", url: FR_URL },
      { source: "fedreg", item: "fr:2026-24002", market: "US", day: "2027-03-01", time: null, kind: "policy", title: "미국 관세 규정 시행", url: "https://www.federalregister.gov/documents/2026/11/21/2026-24002/modification" },
      { source: "fedreg", item: "fr:2026-24007", market: "US", day: "2026-11-20", time: null, kind: "policy", title: "미국 수출통제 규정 시행", url: "https://www.federalregister.gov/documents/x/2026-24007/d" },
    ]);
    expect(parseFedRegister(JSON.stringify({ count: 0 }))).toEqual([]);
    expect([parseFedRegister("<html>blocked</html>"), parseFedRegister(JSON.stringify({ results: "x" }))]).toEqual([null, null]);
    // the fixed query (team-lead 1550 3): both agencies, rules, significant, effective from the ET day, the fields read
    const q = new URL(FEDREG_URL("2026-11-30")).searchParams;
    expect(q.getAll("conditions[agencies][]")).toEqual(["industry-and-security-bureau", "trade-representative-office-of-united-states"]);
    expect([q.get("conditions[type][]"), q.get("conditions[significant]"), q.get("conditions[effective_date][gte]"), q.get("per_page")]).toEqual(["RULE", "1", "2026-11-30", "100"]);
  });

  test("FOMC: each year's meetings, the decision on the last day at 14:00 ET, across a month too, named by the first day; a notation vote is left out", () => {
    expect(parseFomc(FOMC)!.map((f) => [f.day, f.time, f.title, f.item])).toEqual([
      ["2026-10-28", "14:00", "FOMC 금리 결정", "fomc:2026-10-27"],
      ["2026-12-09", "14:00", "FOMC 금리 결정", "fomc:2026-12-08"],
      ["2027-01-27", "14:00", "FOMC 금리 결정", "fomc:2027-01-26"],
      ["2027-05-01", "14:00", "FOMC 금리 결정", "fomc:2027-04-30"],
    ]);
    expect(parseFomc("<html><body>Access denied</body></html>")).toBeNull();
  });

  test("BLS: CPI, the Employment Situation and PPI; the month in the title only when the event writes it (folded lines too); ET wall time or UTC", () => {
    expect(parseBlsIcs(BLS)!.map((f) => [f.day, f.time, f.title, f.item])).toEqual([
      ["2026-12-10", "08:30", "미국 11월 CPI 발표", "cpi:2026-11"],
      ["2026-12-04", "08:30", "미국 11월 고용보고서 발표", "nfp:2026-11"],
      ["2026-12-11", "08:30", "미국 PPI 발표", "ppi:2026-12-11"], // 13:30Z = 08:30 ET; no month written: none guessed (DD 1551), the day names it
      ["2027-02-05", "08:30", "미국 1월 고용보고서 발표", "nfp:2027-01"],
    ]);
    expect(parseBlsIcs("<html>Access Denied</html>")).toBeNull();
    expect(BLS_URL).toBe("https://www.bls.gov/schedule/news_release/bls.ics");
  });
});

describe("the 07:00 run", () => {
  test("from 07:00 KST, once a day: the three hosts in turn with the default UA, then each invest user's calendar as author code", async () => {
    const w = await world();
    const alice = await w.person("alice", true);
    const erin = await w.person("erin", true);
    const bob = await w.person("bob", false);
    await w.beat(SEVEN - 60_000); // 06:59
    expect([w.hosts(), w.row("2026-12-01")]).toEqual([[], null]);

    await w.beat(SEVEN);
    expect(w.hosts()).toEqual(["www.federalregister.gov", "www.federalreserve.gov", "www.bls.gov"]);
    expect(w.up.calls.map((c) => [c.host, c.userAgent])).toEqual(w.hosts().map((x) => [x, null]));
    expect(w.up.calls[0]!.path).toContain("conditions%5Beffective_date%5D%5Bgte%5D=2026-11-30".replace(/%5B/g, "[").replace(/%5D/g, "]"));
    for (const p of [alice, erin]) {
      const got = await w.events(p);
      expect(got.map(shape)).toEqual(FOUND.map(([d, t, k, title, s, u]) => [d, t, k, title, s, u]));
      expect(new Set(got.map((e) => `${e.author} ${e.sourceTier} ${e.confidence} ${e.remind}`))).toEqual(new Set(["code T1 A true"]));
    }
    expect(await w.events(bob)).toEqual([]);
    const keys = w.h.db.sql.query("SELECT disc_source, disc_item, day FROM invest_events WHERE user_id = $u ORDER BY day").all({ u: alice.id }) as { disc_source: string; disc_item: string; day: string }[];
    expect(keys.map((k) => `${k.disc_source} ${k.disc_item} ${k.day}`)).toEqual(FOUND.map(([d, , , , s, , i]) => `${s === "BLS" ? "bls" : s === "연준" ? "fomc" : "fedreg"} ${i} ${d}`));
    const r = w.row("2026-12-01")!;
    expect(r.state).toBe("done");
    expect(JSON.parse(r.result!)).toEqual({ day: "2026-12-01", sources: { fedreg: { code: "ok", found: 2 }, fomc: { code: "ok", found: 2 }, bls: { code: "ok", found: 3 } }, added: 14, skipped: 0 });

    // the same day again: nothing read, nothing added
    await w.beat(KST(2026, 12, 1, 7, 30));
    await w.beat(KST(2026, 12, 1, 23, 59));
    expect(w.hosts()).toHaveLength(3);
    expect(await w.events(alice)).toHaveLength(7);

    // the next day: read once more, the same finds are already there
    await w.beat(KST(2026, 12, 2, 7, 0));
    expect(w.hosts()).toHaveLength(6);
    expect(JSON.parse(w.row("2026-12-02")!.result!)).toMatchObject({ added: 0, skipped: 14 });
    expect(await w.events(alice)).toHaveLength(7);
  });

  test("a found event the person deleted stays deleted for them alone, on another day too (team-lead 1712); deleting their own leaves no mark", async () => {
    const w = await world();
    const alice = await w.person("alice", true);
    const erin = await w.person("erin", false); // opens the invest screen only after alice's deletion
    await w.beat(SEVEN);
    const cpi = (await w.events(alice)).find((e) => e.title === "미국 11월 CPI 발표")!;
    expect((await w.h.req("DELETE", `/api/invest/events/${cpi.id}`, { token: alice.token })).status).toBe(200);
    expect(w.h.db.sql.query("SELECT user_id, source, item, day, symbol FROM invest_event_dismissed").all()).toEqual([{ user_id: alice.id, source: "bls", item: "cpi:2026-11", day: "2026-12-10", symbol: "" }]);
    const own = createEvent(w.h.db, alice.id, { market: "US", day: "2026-12-18", kind: "other", title: "내 메모", source: "직접", sourceTier: "T1", confidence: "A" }, "person", w.h.clock.t);
    expect((await w.h.req("DELETE", `/api/invest/events/${own.id}`, { token: alice.token })).status).toBe(200);
    expect(w.h.db.sql.query("SELECT COUNT(*) AS n FROM invest_event_dismissed").get()).toEqual({ n: 1 });

    idb.ensureSettings(w.h.db, erin.id, w.h.clock.t);
    // a mark on a symbol's event of the same item does not hide the find without one (source · item · symbol)
    w.h.db.sql.query("INSERT INTO invest_event_dismissed (user_id, source, item, day, symbol, dismissed_at) VALUES ($u, 'fomc', 'fomc:2027-01-26', '2027-01-27', 'NVDA', 0)").run({ u: erin.id });
    // the next day BLS lists November's CPI on another day (team-lead 1712: still deleted for alice, its item is the same)
    // and January's CPI (a new item)
    w.up.state.bls = BLS.replace("UID:r1\r\nDTSTART;TZID=US-Eastern:20261210T083000", "UID:r1\r\nDTSTART;TZID=US-Eastern:20261215T083000").replace("END:VCALENDAR", ["BEGIN:VEVENT", "UID:r7", "DTSTART;TZID=US-Eastern:20270113T083000", "SUMMARY:Consumer Price Index", "DESCRIPTION:Consumer Price Index for December 2026", "END:VEVENT", "END:VCALENDAR"].join("\r\n"));
    await w.beat(KST(2026, 12, 2, 7, 0));
    const titles = (await w.events(alice)).map((e) => e.title);
    expect(titles).not.toContain("미국 11월 CPI 발표");
    expect(titles).toContain("미국 12월 CPI 발표");
    expect(titles).toHaveLength(7);
    // December's CPI, out in January, is named by its own month and year
    expect(w.h.db.sql.query("SELECT disc_item FROM invest_events WHERE user_id = $u AND day = '2027-01-13'").all({ u: alice.id })).toEqual([{ disc_item: "cpi:2026-12" }]);
    expect((await w.events(erin)).map((e) => `${e.day} ${e.title}`)).toEqual(expect.arrayContaining(["2026-12-15 미국 11월 CPI 발표", "2027-01-13 미국 12월 CPI 발표", "2027-01-27 FOMC 금리 결정"]));
    expect(await w.events(erin)).toHaveLength(8);
    // alice: the deleted one and 6 already there skipped, January's added; erin, new to invest: all 8 added
    expect(JSON.parse(w.row("2026-12-02")!.result!)).toMatchObject({ added: 9, skipped: 7 });
  });

  test("the person's own event of the same day and title stays theirs; a full calendar takes nothing more; neither is an error", async () => {
    const w = await world();
    const alice = await w.person("alice", true);
    const dan = await w.person("dan", true);
    const mine = createEvent(w.h.db, alice.id, { market: "US", day: "2026-12-09", time: "14:00", kind: "macro", title: "FOMC 금리 결정", source: "직접", sourceTier: "T1", confidence: "A" }, "person", w.h.clock.t);
    for (let i = 0; i < MAX_EVENTS; i++) createEvent(w.h.db, dan.id, { market: "KR", day: "2026-12-20", kind: "other", title: `메모 ${i}`, source: "직접", sourceTier: "T1", confidence: "A" }, "person", w.h.clock.t);
    const errors: string[] = [];
    const log = w.h.app.core.log.error.bind(w.h.app.core.log);
    w.h.app.core.log.error = (m: string, f?: Parameters<typeof log>[1]) => {
      errors.push(m);
      log(m, f);
    };
    await w.beat(SEVEN);
    const a = await w.events(alice);
    expect(a.filter((e) => e.day === "2026-12-09")).toEqual([expect.objectContaining({ id: mine.id, author: "person", source: "직접" })]);
    expect(a).toHaveLength(7);
    expect((await w.events(dan)).filter((e) => e.author === "code")).toEqual([]);
    expect(errors).toEqual([]);
    expect(JSON.parse(w.row("2026-12-01")!.result!)).toMatchObject({ added: 6, skipped: 8 });
  });

  test("BLS answers 403: that host stops (확인 불가), the other two still go in; a page that is not the calendar pauses its host too", async () => {
    const w = await world();
    const alice = await w.person("alice", true);
    w.up.state.bls = 403;
    w.up.state.fomc = "<html><body>Please enable JavaScript</body></html>";
    await w.beat(SEVEN);
    expect((await w.events(alice)).map((e) => e.title)).toEqual(["미국 수출통제 규정 시행", "미국 관세 규정 시행"]);
    expect(JSON.parse(w.row("2026-12-01")!.result!).sources).toEqual({
      fedreg: { code: "ok", found: 2 },
      fomc: { code: "not_data", found: 0, text: "확인 불가" },
      bls: { code: "blocked", found: 0, text: "확인 불가" },
    });
    expect([idb.sourcePausedUntil(w.h.db, "bls")! > SEVEN, idb.sourcePausedUntil(w.h.db, "fomc")! > SEVEN, idb.sourcePausedUntil(w.h.db, "fedreg")]).toEqual([true, true, null]);
    expect(w.hosts()).toEqual(["www.federalregister.gov", "www.federalreserve.gov", "www.bls.gov"]); // asked once each, no retry
  });

  test("the windows (team-lead 1647): FOMC and BLS up to EVENT_SPAN_DAYS (59 · 60 in, 61 out), the Federal Register up to EVENT_MAX_DAYS (731 · 732 in, 733 out), from the market's today", async () => {
    const w = await world();
    const alice = await w.person("alice", true);
    // the run at 2026-12-01 07:00 KST is 11-30 17:00 ET: the US market's today is 2026-11-30
    const meeting = (m: string, d: string) => `<div class="row fomc-meeting"><div class="fomc-meeting__month"><strong>${m}</strong></div><div class="fomc-meeting__date">${d}</div></div>`;
    w.up.state.fomc = `<h4>2027 FOMC Meetings</h4>${meeting("January", "27-28")}${meeting("January", "29")}${meeting("January", "30")}`;
    const cpi = (uid: string, day: string, month: string) =>
      ["BEGIN:VEVENT", `UID:${uid}`, `DTSTART;TZID=US-Eastern:${day.replace(/-/g, "")}T083000`, "SUMMARY:Consumer Price Index", `DESCRIPTION:Consumer Price Index for ${month}`, "END:VEVENT"];
    w.up.state.bls = ["BEGIN:VCALENDAR", ...cpi("a", "2027-01-28", "October 2026"), ...cpi("b", "2027-01-29", "November 2026"), ...cpi("c", "2027-01-30", "December 2026"), "END:VCALENDAR"].join("\r\n");
    const doc = (n: string, day: string) => ({ document_number: n, title: "Semiconductor Export Controls", abstract: "", effective_on: day, html_url: `https://www.federalregister.gov/documents/x/${n}/a`, agencies: [], significant: true });
    w.up.state.fedreg = JSON.stringify({ results: [doc("2028-1", "2028-11-30"), doc("2028-2", "2028-12-01"), doc("2028-3", "2028-12-02")] });
    await w.beat(SEVEN);
    expect((await w.events(alice)).map((e) => `${e.day} ${e.title}`)).toEqual([
      "2027-01-28 미국 10월 CPI 발표", // 08:30 ET before 14:00 ET
      "2027-01-28 FOMC 금리 결정",
      "2027-01-29 미국 11월 CPI 발표",
      "2027-01-29 FOMC 금리 결정",
    ]);
    const fr = w.h.db.sql.query("SELECT day FROM invest_events WHERE user_id = $u AND disc_source = 'fedreg' ORDER BY day").all({ u: alice.id }) as { day: string }[];
    expect(fr.map((r) => r.day)).toEqual(["2028-11-30", "2028-12-01"]);
    expect(JSON.parse(w.row("2026-12-01")!.result!).sources).toEqual({ fedreg: { code: "ok", found: 2 }, fomc: { code: "ok", found: 2 }, bls: { code: "ok", found: 2 } });
    expect([EVENT_SPAN_DAYS, EVENT_MAX_DAYS]).toEqual([60, 732]);
  });

  test("sources off: no row, no request", async () => {
    const w = await world({ sources: false });
    const alice = await w.person("alice", true);
    await w.beat(SEVEN);
    expect([w.hosts(), w.row("2026-12-01"), await w.events(alice)]).toEqual([[], null, []]);
  });

  test("a find dated tomorrow (its market's day) is due for D-1 at 08:00 KST like any code event", async () => {
    const w = await world();
    const alice = await w.person("alice", true);
    await w.beat(KST(2026, 12, 3, 7, 0)); // 12-02 17:00 ET: the Employment Situation on 12-04 ET is tomorrow by KST's 12-03
    const due = dueReminders(w.h.db, KST(2026, 12, 3, 8, 0)).get(alice.id) ?? [];
    expect(due.map((r) => [r.title, r.day, r.author])).toEqual([["미국 11월 고용보고서 발표", "2026-12-04", "code"]]);
  });
});
