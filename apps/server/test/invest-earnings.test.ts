/**
 * Invest B2d-2c: watched stocks' next earnings (team-lead 1755 · 1756 · 1813 · 1823, DD 1754 · 1756 · 1757 · 1825-b), the
 * last step of the 07:00 KST discovery run — the Toss type and Korean name asked with each person's own token, one web
 * search per (symbol, subject), one model proposal checked by code, one upcoming row per symbol per person. The search
 * and the model are fakes in the test's deps (no Exa host, no model host), Toss is test/fake-toss.ts; every result body
 * here is synthetic.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { InvestEvent } from "@pickle/protocol";
import type { CredentialAccess } from "@pickle/agent";
import type { WebSearchHit, WebSearchQuery } from "../src/deps.ts";
import type { ChatRequest } from "../src/meet.ts";
import { etToEpoch } from "../src/invest/calendar.ts";
import * as idb from "../src/invest/db.ts";
import { check, cutTail, datesIn, EARN_SEARCHES_MAX, evidenceOf, namesCompany, queryOf, readProposals, recentlyPublished, subjectOf, takesPart, timeIn, type Unit } from "../src/invest/earnings.ts";
import { FAKE_TOSS_BASE, makeInvestUpstream } from "./fake-toss.ts";
import { makeFakeVault, makeHarness, type Harness } from "./helpers.ts";

const KST = (y: number, mo: number, d: number, hh = 9, mi = 0) => Date.UTC(y, mo - 1, d, hh - 9, mi);
/** 07:00 KST on 12-01 = 11-30 17:00 ET: the US window is 11-30..01-29, the KR one 12-01..01-30 */
const SEVEN = KST(2026, 12, 1, 7, 0);
const day = (n: number) => KST(2026, 12, n, 7, 0);
const ICS0 = ["BEGIN:VCALENDAR", "VERSION:2.0", "END:VCALENDAR"].join("\r\n");

const harnesses: Harness[] = [];
afterEach(async () => {
  while (harnesses.length) await harnesses.pop()!.close();
});

/** each person's Toss login hands its own bogus client id to `use`: one person's token is told apart from another's */
const clientOf = (userId: string) => `ci-${userId}`;
function personVault(v: ReturnType<typeof makeFakeVault>): ReturnType<typeof makeFakeVault> {
  return {
    ...v,
    access(userId, o) {
      const a = v.access(userId, o);
      const use: CredentialAccess["use"] = (id, p, fn) => a.use(id, p, () => fn({ clientId: clientOf(userId), clientSecret: "cs-bogus-91c2" }));
      return { ...a, use };
    },
  };
}

type Answer = (input: { company: { symbol: string; name?: string; market: string } }, call: number) => string | Error;

async function world(o: { search?: boolean; chat?: boolean } = {}) {
  const up = makeInvestUpstream();
  up.state.fedreg = JSON.stringify({ count: 0, results: [] });
  up.state.bls = ICS0;
  up.state.bea = ICS0;
  const searches: WebSearchQuery[] = [];
  const hits = new Map<string, WebSearchHit[] | "fail">();
  const searchState = { notConfigured: false };
  const searchWeb = async (q: WebSearchQuery) => {
    searches.push(q);
    const got = hits.get(q.query);
    if (searchState.notConfigured) return { ok: false as const, error: { kind: "not_configured" } };
    return got === "fail" ? { ok: false as const, error: { kind: "upstream" } } : { ok: true as const, hits: got ?? [] };
  };
  const h = await makeHarness({
    now: SEVEN - 60_000,
    config: { invest: { sources: true, tossBase: FAKE_TOSS_BASE, outboundIp: null } },
    deps: ({ vault }) => ({
      investFetch: up.fetch,
      vault: personVault(vault),
      skills: { listSkills: () => [], skillTools: () => [], skillCatalogForPrompt: () => "", ...(o.search === false ? {} : { searchWeb }) },
    }),
  });
  harnesses.push(h);
  const chats: ChatRequest[] = [];
  const model: { answer: Answer } = { answer: () => '{"candidates":[]}' };
  if (o.chat !== false)
    h.app.core.deps.llm!.chat = async function* (i: ChatRequest) {
      chats.push(i);
      const a = model.answer(JSON.parse(i.user), chats.length);
      if (a instanceof Error) throw a;
      yield a;
    };
  const person = async (handle: string, toss = false) => {
    const s = await h.signup(handle);
    const p = { id: s.session.user.id, token: s.token };
    idb.ensureSettings(h.db, p.id, h.clock.t);
    if (toss) {
      const envelope = { v: 1, alg: "ECDH-P256+HKDF-SHA256+A256GCM", kid: "kid-test", epk: { kty: "EC" }, iv: "aXY", ct: "Y3Q", aad: `${p.id}:toss-investment:token` };
      const r = await h.req("POST", "/api/credentials", { token: p.token, body: { service: "toss-investment", label: "토스증권", kind: "token", hint: "계좌 1개", keepFor: "forever", envelope } });
      expect(r.status).toBe(201);
      await h.app.core.idle();
    }
    return p;
  };
  /** a watched row as it is stored (no Yahoo, no Toss): its name, type and Toss name as given */
  const watch = (p: { id: string }, symbol: string, name: string, more: { type?: string | null; tossName?: string | null } = {}) => {
    idb.addWatch(h.db, { user_id: p.id, symbol, market: /^\d{6}$/.test(symbol) ? "KR" : "US", name, added_at: h.clock.t });
    if (more.type !== undefined || more.tossName !== undefined)
      h.db.sql.query("UPDATE invest_watchlist SET security_type = $t, toss_name = $n WHERE user_id = $u AND symbol = $s").run({ t: more.type ?? null, n: more.tossName ?? null, u: p.id, s: symbol });
  };
  const run = async (at: number) => {
    h.clock.t = at;
    await h.app.core.invest.beat(at);
  };
  const company = (d: string) => JSON.parse((h.db.sql.query("SELECT result FROM invest_discovery WHERE day = $d").get({ d }) as { result: string }).result).company;
  const events = async (p: { token: string }) => ((await (await h.req("GET", "/api/invest/events?from=2026-11-29&to=2027-12-31", { token: p.token })).json()) as { items: InvestEvent[] }).items;
  const rows = (p: { id: string }) => h.db.sql.query("SELECT day, time, symbol, title, source, source_tier, confidence, url, author, disc_source, disc_item FROM invest_events WHERE user_id = $u ORDER BY day").all({ u: p.id });
  return { h, up, searches, hits, searchState, chats, model, person, watch, run, company, events, rows };
}

const hit = (url: string, title: string, snippet: string, date?: string): WebSearchHit => ({ title, url, snippet, ...(date ? { date } : {}) });
const said = (...c: { url: string; day: string; quote: string }[]) => JSON.stringify({ candidates: c });
const shape = (e: InvestEvent) => [e.day, e.time, e.kind, e.title, e.heading, e.source, e.sourceTier, e.confidence, e.url, e.author];
const COUNTS = { moved: 0, updated: 0, kept: 0, skipped_rows: 0, removed: 0, dismissed: 0 };

describe("what code reads (DD 1754 · 1825-b, 1747 4)", () => {
  test("the corporate tail is cut once at the end; Holdings and Group stay; a name that would go empty stays", () => {
    expect(
      ["Samsung Electronics Co., Ltd.", "SK hynix Inc.", "NAVER Corporation", "Hyundai Motor Company", "LG Energy Solution, Ltd.", "Samsung C&T Co.,Ltd.", "POSCO Holdings Inc.", "KB Financial Group Inc", "Coupang PLC", "Inc.", "Ltd", "HanaCorp"].map(cutTail),
    ).toEqual(["Samsung Electronics", "SK hynix", "NAVER", "Hyundai Motor", "LG Energy Solution", "Samsung C&T", "POSCO Holdings", "KB Financial Group", "Coupang", "Inc.", "Ltd", "HanaCorp"]);
  });

  test("the subject: US the symbol; KR the person's Toss name (as it is), else the row's name cut, else the code", () => {
    expect(subjectOf({ symbol: "NVDA", market: "US", name: "NVIDIA Corporation", toss_name: "엔비디아" })).toBe("NVDA");
    expect(subjectOf({ symbol: "005930", market: "KR", name: "Samsung Electronics Co., Ltd.", toss_name: "삼성전자" })).toBe("삼성전자");
    expect(subjectOf({ symbol: "005930", market: "KR", name: "Samsung Electronics Co., Ltd.", toss_name: null })).toBe("Samsung Electronics");
    expect(subjectOf({ symbol: "005930", market: "KR", name: "005930", toss_name: null })).toBe("005930");
  });

  test("a stock form or an unknown type takes part; ETF, ETN and the rest do not", () => {
    expect([null, undefined, "", "STOCK", "FOREIGN_STOCK", "DEPOSITARY_RECEIPT"].map(takesPart)).toEqual([true, true, true, true, true, true]);
    expect(["ETF", "FOREIGN_ETF", "ETN", "REIT", "INFRASTRUCTURE_FUND", "STOCK_WARRANTS"].map(takesPart)).toEqual([false, false, false, false, false, false]);
  });

  test("evidence: the company's IR (its own domain after the prefix), the three wires and DART/KIND are T1 · A by the subject; investors.com, investor.gov and the rest are T2 · B by the host", () => {
    expect(evidenceOf("investor.nvidia.com", "NVDA")).toEqual({ source: "NVDA IR", tier: "T1", grade: "A" });
    expect(evidenceOf("ir.samsung.com", "삼성전자")).toEqual({ source: "삼성전자 IR", tier: "T1", grade: "A" });
    expect(evidenceOf("investors.micron.com", "MU")).toEqual({ source: "MU IR", tier: "T1", grade: "A" });
    expect(["businesswire.com", "prnewswire.com", "globenewswire.com", "markets.businesswire.com"].map((x) => evidenceOf(x, "NVDA").source)).toEqual(["NVDA 보도자료", "NVDA 보도자료", "NVDA 보도자료", "NVDA 보도자료"]);
    expect(["dart.fss.or.kr", "kind.krx.co.kr"].map((x) => evidenceOf(x, "삼성전자"))).toEqual([
      { source: "삼성전자 공시", tier: "T1", grade: "A" },
      { source: "삼성전자 공시", tier: "T1", grade: "A" },
    ]);
    for (const x of ["investors.com", "investor.gov", "reuters.com", "notbusinesswire.com"]) expect(evidenceOf(x, "NVDA")).toEqual({ source: x, tier: "T2", grade: "B" });
  });

  test("dates in English, Korean and numbers; a date with no year, when asked for, is the next one from today", () => {
    expect([...datesIn("on Wednesday, January 20, 2027 at 5 p.m.", "2026-11-30")]).toEqual(["2027-01-20"]);
    expect([...datesIn("Feb. 3 after the close", "2026-11-30", true)]).toEqual(["2027-02-03"]);
    expect([...datesIn("Dec 4th", "2026-11-30", true)]).toEqual(["2026-12-04"]);
    expect([...datesIn("Feb. 3 after the close · Dec 4th · 1월 7일", "2026-11-30")]).toEqual([]);
    expect([...datesIn("on 20 January 2027", "2026-11-30")]).toEqual(["2027-01-20"]);
    expect([...datesIn("2027년 1월 7일 실적 발표", "2026-12-01")]).toEqual(["2027-01-07"]);
    expect([...datesIn("1월 7일", "2026-12-01", true)]).toEqual(["2027-01-07"]);
    expect([...datesIn("2027.01.07 / 2027-01-08", "2026-12-01")].sort()).toEqual(["2027-01-07", "2027-01-08"]);
    expect([...datesIn("February 30, 2027 · March 2027 · Q4 2026", "2026-11-30")]).toEqual([]);
  });

  test("a date with no year is read only from a result published in the last 90 days (team-lead 1853 1); a date with its year needs no published day", () => {
    const unit: Unit = { symbol: "NVDA", market: "US", subject: "NVDA", names: ["NVIDIA"], users: [] };
    const url = "https://investor.nvidia.com/events/q4";
    const words = "NVIDIA (NASDAQ: NVDA) will report its fourth-quarter results on February 25.";
    const at = (date?: string, snippet = words) => check({ url, day: "2027-02-25", quote: snippet.replace(/\.$/, "") }, [hit(url, "NVIDIA Q4 results", snippet, date)], unit, "2027-01-10");
    // last year's page (published 2026-02-03): its February 25 is not this year's
    expect(at("2026-02-03")).toBe("date");
    expect(at("2027-01-05")).toEqual({ day: "2027-02-25", time: null, url, ev: { source: "NVDA IR", tier: "T1", grade: "A" } });
    expect(at(undefined)).toBe("date");
    expect(at("2026-10-11")).toBe("date"); // 91 days before
    expect(at("2026-10-12")).not.toBe("date"); // 90 days before
    expect(at(undefined, "NVIDIA (NASDAQ: NVDA) will report its fourth-quarter results on February 25, 2027.")).not.toBe("date");
    expect([recentlyPublished("2027-01-11", "2027-01-10"), recentlyPublished("2027-01-12", "2027-01-10"), recentlyPublished("2027-01-05T13:00:00Z", "2027-01-10"), recentlyPublished("2027-02-30", "2027-01-10")]).toEqual([true, false, true, false]);
  });

  test("the query: US by symbol in English; KR in English for a Latin name, in Korean for Hangul or the code (DD 1855 4)", () => {
    expect([
      queryOf({ symbol: "NVDA", market: "US", subject: "NVDA" }),
      queryOf({ symbol: "005930", market: "KR", subject: "삼성전자" }),
      queryOf({ symbol: "005930", market: "KR", subject: "Samsung Electronics" }),
      queryOf({ symbol: "000660", market: "KR", subject: "SK하이닉스" }),
      queryOf({ symbol: "005930", market: "KR", subject: "005930" }),
    ]).toEqual([
      { query: "NVDA earnings date", lang: "en" },
      { query: "삼성전자 실적 발표일", lang: "ko" },
      { query: "Samsung Electronics earnings date", lang: "en" },
      { query: "SK하이닉스 실적 발표일", lang: "ko" },
      { query: "005930 실적 발표일", lang: "ko" },
    ]);
  });

  test("T2 needs the schedule said (DD 1914-b): the five forms seen in the real run, a Korean scheduled article, the company's own words held to neither", () => {
    const nv: Unit = { symbol: "NVDA", market: "US", subject: "NVDA", names: ["NVIDIA"], users: [] };
    const ss: Unit = { symbol: "005930", market: "KR", subject: "삼성전자", names: ["삼성전자"], users: [] };
    const at = (unit: Unit, url: string, title: string, quote: string, day: string) => check({ url, day, quote }, [hit(url, title, `${quote}.`)], unit, "2026-12-01");
    const B = "https://etfshopping.com/stock/005930/earnings";
    const BU = "https://unusualwhales.com/stock/NVDA/earnings";
    expect([
      at(ss, B, "삼성전자 실적발표 일정", "다음 실적발표는 2027년 1월 20일로 예상됩니다", "2027-01-20"),
      at(ss, B, "삼성전자 실적발표 일정", "2027년 1월 20일 전후입니다. 아직 확정 공시는 없습니다", "2027-01-20"),
      at(nv, BU, "NVIDIA (NVDA) Earnings", "company is expected to announce its next earnings report on 2027-01-20", "2027-01-20"),
      at(nv, BU, "NVIDIA (NVDA) Earnings", "NVIDIA (NVDA) Earnings Date: Jan 20, 2027", "2027-01-20"),
    ]).toEqual(["estimated", "estimated", "unstated", "unstated"]);
    expect(at(nv, BU, "NVIDIA (NVDA) Earnings", "Nvidia will report fourth-quarter results on January 20, 2027", "2027-01-20")).toEqual({ day: "2027-01-20", time: null, url: BU, ev: { source: "unusualwhales.com", tier: "T2", grade: "B" } });
    // 잠정 is a real schedule (잠정실적), not a guess
    expect(at(ss, "https://www.newsian.co.kr/news/1", "삼성전자 잠정실적", "삼성전자는 2027년 1월 7일 4분기 잠정실적을 발표할 예정이다", "2027-01-07")).toMatchObject({ day: "2027-01-07", ev: { tier: "T2" } });
    // the company's own words: neither rule
    const IR = "https://investor.nvidia.com/events/q4";
    expect(at(nv, IR, "NVIDIA (NVDA) Earnings", "NVIDIA (NVDA) Earnings Date: Jan 20, 2027", "2027-01-20")).toMatchObject({ day: "2027-01-20", ev: { tier: "T1" } });
    expect(at(ss, "https://dart.fss.or.kr/x", "삼성전자 공시", "삼성전자 실적 발표 2027년 1월 7일 예상", "2027-01-07")).toMatchObject({ day: "2027-01-07", ev: { tier: "T1" } });
  });

  test("each schedule phrase lets a T2 quote through, alone (DD 1914-b)", () => {
    const nv: Unit = { symbol: "NVDA", market: "US", subject: "NVDA", names: ["NVIDIA"], users: [] };
    const ss: Unit = { symbol: "005930", market: "KR", subject: "삼성전자", names: ["삼성전자"], users: [] };
    const url = "https://www.reuters.com/x";
    const en = ["will report", "will announce", "will release", "will host", "will hold", "will present", "will publish", "is scheduled to report", "scheduled for", "is set to report", "set to announce", "set to release"];
    const ko = ["발표 예정", "발표한다", "발표할", "개최한다", "개최할", "공개한다", "공개할"];
    for (const w of en) {
      const quote = `NVIDIA (NVDA) ${w} results January 20, 2027`;
      expect([w, check({ url, day: "2027-01-20", quote }, [hit(url, "NVDA", quote)], nv, "2026-12-01")]).toEqual([w, expect.objectContaining({ day: "2027-01-20" })]);
    }
    for (const w of ko) {
      const quote = `삼성전자 2027년 1월 7일 실적 ${w}`;
      expect([w, check({ url, day: "2027-01-07", quote }, [hit(url, "삼성전자", quote)], ss, "2026-12-01")]).toEqual([w, expect.objectContaining({ day: "2027-01-07" })]);
    }
    expect(check({ url, day: "2027-01-20", quote: "NVIDIA (NVDA) results January 20, 2027" }, [hit(url, "NVDA", "NVIDIA (NVDA) results January 20, 2027")], nv, "2026-12-01")).toBe("unstated");
  });

  test("each estimate word drops a T2 quote, alone; the same words in the company's own words stay (DD 1754, 1855 5, 1914-b)", () => {
    const unit: Unit = { symbol: "NVDA", market: "US", subject: "NVDA", names: ["NVIDIA"], users: [] };
    const T2 = "https://www.zacks.com/stock/nvda";
    const A = "https://investor.nvidia.com/news/q4";
    for (const word of ["estimated", "projected", "tentative", "unconfirmed", "예상일", "예상됩니다", "추정", "미확정", "확정 공시는 없습니다", "확정공시는 없어"]) {
      const quote = `NVDA ${word} report date January 20, 2027 (will report)`;
      expect([word, check({ url: T2, day: "2027-01-20", quote }, [hit(T2, "NVDA", quote)], unit, "2026-12-01")]).toEqual([word, "estimated"]);
      expect([word, check({ url: A, day: "2027-01-20", quote }, [hit(A, "NVDA", quote)], unit, "2026-12-01")]).toEqual([word, expect.objectContaining({ day: "2027-01-20", url: A })]);
    }
  });

  test("a time only in the market's own zone, and only when there is one", () => {
    expect(timeIn("at 2 p.m. PT (5 p.m. ET)", "US")).toBe("17:00");
    expect(timeIn("at 4:30 p.m. Eastern Time", "US")).toBe("16:30");
    expect(timeIn("8:00 AM ET", "US")).toBe("08:00");
    expect(timeIn("16:30 ET", "US")).toBe("16:30");
    expect(timeIn("after the close", "US")).toBeNull();
    expect(timeIn("at 4:30 p.m. ET, a call at 5:00 p.m. ET", "US")).toBeNull();
    expect(timeIn("12 p.m. ET", "US")).toBe("12:00");
    expect(timeIn("오후 4시 실적 발표", "KR")).toBe("16:00");
    expect(timeIn("오전 9시 30분", "KR")).toBe("09:30");
    expect(timeIn("오후 3:30", "KR")).toBe("15:30");
    expect(timeIn("16:00 KST", "KR")).toBe("16:00");
    expect(timeIn("5 p.m. ET", "KR")).toBeNull();
  });

  test("the company named: the symbol as a whole word (case kept), or a name (case aside)", () => {
    expect(namesCompany("NVIDIA (NASDAQ: NVDA) will report", "NVDA", [])).toBe(true);
    expect(namesCompany("NVDAX fund", "NVDA", [])).toBe(false);
    expect(namesCompany("nvda", "NVDA", [])).toBe(false);
    expect(namesCompany("Nvidia to report", "NVDA", ["NVIDIA"])).toBe(true);
    expect(namesCompany("삼성전자 4분기 실적", "005930", ["삼성전자"])).toBe(true);
    expect(namesCompany("AT&T (NYSE: T) will", "T", [])).toBe(true);
    expect(namesCompany("The results", "T", [])).toBe(false);
  });

  test("the model's JSON: proposals, the malformed counted; no JSON is a failed call", () => {
    expect(readProposals('x {"candidates":[{"url":"u","day":"2027-01-20","quote":"q"},{"url":3}]} y')).toEqual({ list: [{ url: "u", day: "2027-01-20", quote: "q" }], bad: 1 });
    expect(readProposals('{"candidates":[]}')).toEqual({ list: [], bad: 0 });
    expect([readProposals("no"), readProposals('{"candidates":"x"}'), readProposals("{bad json}")]).toEqual([null, null, null]);
  });
});

describe("the earnings step of the 07:00 run (B2d-2c)", () => {
  const IR = "https://investor.nvidia.com/news/nvidia-q4-date";
  const QUOTE = "NVIDIA (NASDAQ: NVDA) will host a conference call on Wednesday, January 20, 2027 at 2 p.m. PT (5 p.m. ET)";
  const nvdaHits = () => [hit(IR, "NVIDIA Announces Date for Fourth-Quarter Results", `${QUOTE} to discuss its results.`, "2026-11-25"), hit("https://www.reuters.com/markets/chips", "Chip stocks rise", "Shares rose on Monday.")];

  test("one search per symbol; the query and the model's input hold the symbol, its name and the results only; an IR find goes in for every holder with the time the quote writes in ET", async () => {
    const w = await world();
    const alice = await w.person("alice");
    const bob = await w.person("bob");
    for (const p of [alice, bob]) w.watch(p, "NVDA", "NVIDIA Corporation");
    w.hits.set("NVDA earnings date", nvdaHits());
    w.model.answer = () => said({ url: IR, day: "2027-01-20", quote: QUOTE });
    await w.run(SEVEN);
    expect(w.searches).toEqual([{ query: "NVDA earnings date", kind: "web", lang: "en", limit: 8, page: 1 }]);
    expect(w.chats).toHaveLength(1);
    expect(JSON.parse(w.chats[0]!.user)).toEqual({
      company: { symbol: "NVDA", name: "NVIDIA", market: "US" },
      today: "2026-11-30",
      until: "2027-01-29",
      results: [
        { title: "NVIDIA Announces Date for Fourth-Quarter Results", url: IR, published: "2026-11-25", excerpt: `${QUOTE} to discuss its results.` },
        { title: "Chip stocks rise", url: "https://www.reuters.com/markets/chips", published: null, excerpt: "Shares rose on Monday." },
      ],
    });
    for (const x of [alice.id, bob.id, alice.token, bob.token, "alice", "bob"]) expect(w.chats[0]!.user.includes(x)).toBe(false);
    expect(w.chats[0]!.system).toContain("untrusted");
    for (const p of [alice, bob]) expect((await w.events(p)).map(shape)).toEqual([["2027-01-20", "17:00", "earnings", "NVDA 실적 발표", "NVDA 실적 발표", "NVDA IR", "T1", "A", IR, "code"]]);
    expect(w.rows(alice)).toEqual([expect.objectContaining({ symbol: "NVDA", disc_source: "company", disc_item: "earn:2027-01" })]);
    expect(w.company("2026-12-01")).toEqual({ searches: 1, waiting: 0, added: 2, ...COUNTS, units: { NVDA: { hits: 2, candidates: 1, passed: 1, dropped: {} } } });
    // the next day: searched again (once a day), the same find changes nothing
    await w.run(day(2));
    expect(w.searches).toHaveLength(2);
    expect(w.company("2026-12-02")).toMatchObject({ searches: 1, added: 0, kept: 2 });
  });

  test("each check drops what fails it, counted by reason: url, quote, date, company, window, a T2 estimate word, malformed", async () => {
    const w = await world();
    const alice = await w.person("alice");
    w.watch(alice, "NVDA", "NVIDIA Corporation");
    const T2 = "https://www.earningswhispers.com/nvda";
    const OTHER = "https://www.example-news.com/amd";
    w.hits.set("NVDA earnings date", [
      ...nvdaHits(),
      hit(T2, "NVDA earnings", "NVDA's estimated report date is January 21, 2027.", "2026-11-20"),
      hit(OTHER, "AMD to report", "Advanced Micro Devices will report on January 27, 2027."),
      hit("https://investor.nvidia.com/news/annual-meeting", "NVIDIA annual meeting", "NVIDIA (NASDAQ: NVDA) holds its meeting on March 30, 2027."),
      hit("https://investor.nvidia.com/news/q3-results", "NVIDIA Q3 results", "NVIDIA (NASDAQ: NVDA) reported its results on November 19, 2026."),
    ]);
    w.model.answer = () =>
      JSON.stringify({
        candidates: [
          { url: "https://investor.nvidia.com/elsewhere", day: "2027-01-20", quote: QUOTE }, // url
          { url: IR, day: "2027-01-20", quote: "NVIDIA will report on January 20, 2027" }, // quote not as written
          { url: IR, day: "2027-01-21", quote: QUOTE }, // date
          { url: OTHER, day: "2027-01-27", quote: "Advanced Micro Devices will report on January 27, 2027" }, // company
          { day: "2027-01-20" }, // malformed
        ],
      });
    await w.run(SEVEN);
    expect(await w.events(alice)).toEqual([]);
    expect(w.company("2026-12-01").units.NVDA).toEqual({ hits: 6, candidates: 5, passed: 0, dropped: { url: 1, quote: 1, date: 1, company: 1, bad: 1 } });
    // window (after it, and a past date) and the T2 estimate word, the next day
    w.model.answer = () =>
      said(
        { url: "https://investor.nvidia.com/news/annual-meeting", day: "2027-03-30", quote: "NVIDIA (NASDAQ: NVDA) holds its meeting on March 30, 2027" },
        { url: T2, day: "2027-01-21", quote: "NVDA's estimated report date is January 21, 2027" },
        { url: "https://investor.nvidia.com/news/q3-results", day: "2026-11-19", quote: "NVIDIA (NASDAQ: NVDA) reported its results on November 19, 2026" },
      );
    await w.run(day(2));
    expect(await w.events(alice)).toEqual([]);
    expect(w.company("2026-12-02").units.NVDA).toEqual({ hits: 6, candidates: 3, passed: 0, dropped: { window: 2, estimated: 1 } });
  });

  test("the best grade's finds must agree on a day; a T2 find goes in by its host when there is nothing better", async () => {
    const w = await world();
    const alice = await w.person("alice");
    w.watch(alice, "MU", "Micron Technology, Inc.");
    const A1 = "https://investors.micron.com/news/q1";
    const A2 = "https://www.businesswire.com/news/micron";
    const B1 = "https://www.marketbeat.com/mu";
    w.hits.set("MU earnings date", [hit(A1, "Micron to report Q1", "Micron Technology (Nasdaq: MU) will report on December 17, 2026."), hit(A2, "Micron sets date", "Micron (Nasdaq: MU) will report on December 18, 2026."), hit(B1, "MU earnings", "Micron (MU) is expected to report on December 17, 2026, and will host a call that day.")]);
    w.model.answer = () =>
      said(
        { url: A1, day: "2026-12-17", quote: "Micron Technology (Nasdaq: MU) will report on December 17, 2026" },
        { url: A2, day: "2026-12-18", quote: "Micron (Nasdaq: MU) will report on December 18, 2026" },
      );
    await w.run(SEVEN);
    expect(await w.events(alice)).toEqual([]);
    expect(w.company("2026-12-01").units.MU).toEqual({ hits: 3, candidates: 2, passed: 2, dropped: {}, conflict: true });
    w.model.answer = () => said({ url: B1, day: "2026-12-17", quote: "Micron (MU) is expected to report on December 17, 2026, and will host a call that day" });
    await w.run(day(2));
    expect((await w.events(alice)).map(shape)).toEqual([["2026-12-17", null, "earnings", "MU 실적 발표", "MU 실적 발표", "marketbeat.com", "T2", "B", B1, "code"]]);
    // A finds on one day beat a B find on another; the one with a time leads
    const A3 = "https://investors.micron.com/news/q1-call";
    const B2 = "https://www.nasdaq.com/market-activity/stocks/mu";
    w.hits.set("MU earnings date", [hit(A1, "Micron to report Q1", "Micron Technology (Nasdaq: MU) will report on December 17, 2026."), hit(A3, "Micron call", "Micron (Nasdaq: MU) will host its call on December 17, 2026 at 4:30 p.m. ET."), hit(B2, "MU earnings", "MU will report on December 19, 2026.")]);
    w.model.answer = () =>
      said(
        { url: A1, day: "2026-12-17", quote: "Micron Technology (Nasdaq: MU) will report on December 17, 2026" },
        { url: A3, day: "2026-12-17", quote: "Micron (Nasdaq: MU) will host its call on December 17, 2026 at 4:30 p.m. ET" },
        { url: B2, day: "2026-12-19", quote: "MU will report on December 19, 2026" },
      );
    await w.run(day(3));
    expect((await w.events(alice)).map(shape)).toEqual([["2026-12-17", "16:30", "earnings", "MU 실적 발표", "MU 실적 발표", "MU IR", "T1", "A", A3, "code"]]);
  });

  test("the model: a failed call gets one more; a valid empty answer gets none; two failures stop there", async () => {
    const w = await world();
    const alice = await w.person("alice");
    w.watch(alice, "NVDA", "NVIDIA Corporation");
    w.hits.set("NVDA earnings date", nvdaHits());
    w.model.answer = (_i, n) => (n === 1 ? new Error("upstream 502") : said({ url: IR, day: "2027-01-20", quote: QUOTE }));
    await w.run(SEVEN);
    expect(w.chats).toHaveLength(2);
    expect(await w.events(alice)).toHaveLength(1);
    w.model.answer = () => '{"candidates":[]}';
    await w.run(day(2));
    expect(w.chats).toHaveLength(3);
    w.model.answer = (_i, n) => (n === 4 ? "not json" : new Error("timeout"));
    await w.run(day(3));
    expect(w.chats).toHaveLength(5);
    expect(w.company("2026-12-03").units.NVDA).toEqual({ hits: 2, model: "failed", candidates: 0, passed: 0, dropped: {} });
    // a failed search: no model call, nothing searched again that day
    w.hits.set("NVDA earnings date", "fail");
    await w.run(day(4));
    expect([w.chats.length, w.searches.length]).toEqual([5, 4]);
    expect(w.company("2026-12-04").units.NVDA).toEqual({ search: "failed", hits: 0, candidates: 0, passed: 0, dropped: {} });
  });

  test("no search: the step does not run (company: { skipped: no_search }); no model: no_model, nothing searched", async () => {
    const a = await world({ search: false });
    a.watch(await a.person("alice"), "NVDA", "NVIDIA Corporation");
    await a.run(SEVEN);
    expect(a.company("2026-12-01")).toEqual({ skipped: "no_search" });
    const b = await world({ chat: false });
    b.watch(await b.person("alice"), "NVDA", "NVIDIA Corporation");
    await b.run(SEVEN);
    expect([b.company("2026-12-01"), b.searches]).toEqual([{ skipped: "no_model" }, []]);
    // a search with no provider key: the first answer ends the step as no_search, not a failure per symbol (DD 1855 6)
    const c = await world();
    const carol = await c.person("carol");
    for (const s of ["AAPL", "NVDA"]) c.watch(carol, s, s);
    c.searchState.notConfigured = true;
    await c.run(SEVEN);
    expect([c.company("2026-12-01"), c.searches.length, c.chats.length]).toEqual([{ skipped: "no_search" }, 1, 0]);
  });

  test(`at most ${EARN_SEARCHES_MAX} searches a run, the longest unsearched first; a searched row nobody watches is not read`, async () => {
    const w = await world();
    const alice = await w.person("alice");
    const syms = Array.from({ length: 22 }, (_, i) => `S${String.fromCharCode(65 + i)}X`);
    for (const s of syms) w.watch(alice, s, s);
    // SAX and SBX were searched yesterday and the day before; ZZZ (nobody watches it) long ago
    const put = w.h.db.sql.query("INSERT INTO invest_earn_searched (symbol, market, subject, searched_at) VALUES ($s, 'US', $s, $t)");
    put.run({ s: "SAX", t: SEVEN - 86_400_000 });
    put.run({ s: "SBX", t: SEVEN - 2 * 86_400_000 });
    put.run({ s: "ZZZ", t: 1 });
    await w.run(SEVEN);
    const first = w.searches.map((q) => q.query.split(" ")[0]);
    expect(first).toEqual([...syms.slice(2), "SBX", "SAX"].slice(0, EARN_SEARCHES_MAX));
    expect(w.chats).toHaveLength(0); // no results: no model call
    expect(w.company("2026-12-01")).toMatchObject({ searches: 20, waiting: 2 });
    expect(w.h.db.sql.query("SELECT searched_at FROM invest_earn_searched WHERE symbol = 'ZZZ'").get()).toEqual({ searched_at: 1 });
    // the next day the two left over go first
    await w.run(day(2));
    expect(w.searches.slice(20, 22).map((q) => q.query.split(" ")[0])).toEqual(["SBX", "SAX"]);
  });

  test("ETF by each person's own row (team-lead 1755 1): A's ETF answer does not stop B (unknown); A's STOCK answer gives B (ETF) nothing", async () => {
    const w = await world();
    const alice = await w.person("alice");
    const bob = await w.person("bob");
    const carol = await w.person("carol");
    w.watch(alice, "SOXL", "Direxion Daily Semiconductor Bull 3X Shares", { type: "ETF" });
    w.watch(bob, "SOXL", "Direxion Daily Semiconductor Bull 3X Shares");
    w.watch(alice, "NVDA", "NVIDIA Corporation", { type: "STOCK" });
    w.watch(carol, "NVDA", "NVIDIA Corporation", { type: "ETF" });
    const S = "https://www.businesswire.com/news/soxl";
    w.hits.set("SOXL earnings date", [hit(S, "Direxion SOXL", "SOXL will report on January 8, 2027.")]);
    w.hits.set("NVDA earnings date", nvdaHits());
    w.model.answer = (i) => (i.company.symbol === "SOXL" ? said({ url: S, day: "2027-01-08", quote: "SOXL will report on January 8, 2027" }) : said({ url: IR, day: "2027-01-20", quote: QUOTE }));
    await w.run(SEVEN);
    expect(w.searches.map((q) => q.query).sort()).toEqual(["NVDA earnings date", "SOXL earnings date"]);
    expect((await w.events(alice)).map((e) => e.symbol)).toEqual(["NVDA"]);
    expect((await w.events(bob)).map((e) => e.symbol)).toEqual(["SOXL"]);
    expect(await w.events(carol)).toEqual([]);
  });

  test("KR: one search per (symbol, subject) — a Toss name and a cut row name search apart; the same subject shares one; titles and sources by the subject, no code in front", async () => {
    const w = await world();
    const alice = await w.person("alice");
    const bob = await w.person("bob");
    const carol = await w.person("carol");
    w.watch(alice, "005930", "Samsung Electronics Co., Ltd.", { type: "STOCK", tossName: "삼성전자" });
    w.watch(carol, "005930", "Samsung Electronics Co., Ltd.", { type: "STOCK", tossName: "삼성전자" });
    w.watch(bob, "005930", "Samsung Electronics Co., Ltd.");
    const dave = await w.person("dave");
    w.watch(dave, "005930", "005930"); // no name: the code
    const DART = "https://dart.fss.or.kr/dsaf001/main.do?rcpNo=1";
    const KIND = "https://kind.krx.co.kr/disclosure/1";
    w.hits.set("삼성전자 실적 발표일", [hit(DART, "삼성전자 기업설명회 개최", "삼성전자는 2027년 1월 7일 오후 4시에 4분기 실적을 발표합니다.")]);
    w.hits.set("Samsung Electronics earnings date", [hit(KIND, "Samsung Electronics earnings release", "Samsung Electronics will announce its results on January 7, 2027.")]);
    w.model.answer = (i) =>
      i.company.name === "삼성전자"
        ? said({ url: DART, day: "2027-01-07", quote: "삼성전자는 2027년 1월 7일 오후 4시에 4분기 실적을 발표합니다" })
        : said({ url: KIND, day: "2027-01-07", quote: "Samsung Electronics will announce its results on January 7, 2027" });
    await w.run(SEVEN);
    expect(w.searches.map((q) => [q.query, q.lang])).toEqual([
      ["005930 실적 발표일", "ko"],
      ["Samsung Electronics earnings date", "en"],
      ["삼성전자 실적 발표일", "ko"],
    ]);
    expect(w.chats.map((c) => JSON.parse(c.user).company)).toEqual([
      { symbol: "005930", name: "Samsung Electronics", market: "KR" },
      { symbol: "005930", name: "삼성전자", market: "KR" },
    ]);
    for (const p of [alice, carol]) expect((await w.events(p)).map(shape)).toEqual([["2027-01-07", "16:00", "earnings", "삼성전자 실적 발표", "삼성전자 실적 발표", "삼성전자 공시", "T1", "A", DART, "code"]]);
    expect((await w.events(bob)).map(shape)).toEqual([["2027-01-07", null, "earnings", "Samsung Electronics 실적 발표", "Samsung Electronics 실적 발표", "Samsung Electronics 공시", "T1", "A", KIND, "code"]]);
    expect(Object.keys(w.company("2026-12-01").units).sort()).toEqual(["005930 005930", "005930 Samsung Electronics", "005930 삼성전자"]);
    expect(await w.events(dave)).toEqual([]);
  });
});

describe("one upcoming earnings row per symbol (team-lead 1755 2 · 1756, DD 1756 · 1757)", () => {
  const A1 = "https://investor.nvidia.com/news/date";
  const A2 = "https://investor.nvidia.com/news/date-call";
  const B1 = "https://www.zacks.com/nvda";
  const nv = async () => {
    const w = await world();
    const alice = await w.person("alice");
    w.watch(alice, "NVDA", "NVIDIA Corporation");
    /** the next run's results: one result per [url, its words], the model proposing each */
    const next = async (at: number, ...res: [string, string, string][]) => {
      w.hits.set("NVDA earnings date", res.map(([url, words]) => hit(url, "NVIDIA (NVDA) results date", words)));
      w.model.answer = () => said(...res.map(([url, words, d]) => ({ url, day: d, quote: words })));
      await w.run(at);
      return w.rows(alice) as { day: string; time: string | null; source: string; confidence: string; url: string; disc_item: string }[];
    };
    return { w, alice, next };
  };

  test("a deleted item is not put back; another month's release still goes in", async () => {
    const { w, alice, next } = await nv();
    expect((await next(SEVEN, [A1, "NVDA will report on December 10, 2026", "2026-12-10"])).map((r) => r.disc_item)).toEqual(["earn:2026-12"]);
    const id = (await w.events(alice))[0]!.id;
    expect((await w.h.req("DELETE", `/api/invest/events/${id}`, { token: alice.token })).status).toBe(200);
    expect(await next(day(2), [A1, "NVDA will report on December 10, 2026", "2026-12-10"])).toEqual([]);
    expect(w.company("2026-12-02")).toMatchObject({ dismissed: 1, added: 0 });
    expect((await next(day(3), [A1, "NVDA will report on January 28, 2027", "2027-01-28"])).map((r) => [r.day, r.disc_item])).toEqual([["2027-01-28", "earn:2027-01"]]);
  });

  test("another day moves the one row (item too) when the grade is the same or higher; a lower grade leaves it", async () => {
    const { w, alice, next } = await nv();
    await next(SEVEN, [B1, "NVDA will report on December 31, 2026", "2026-12-31"]);
    const id = (await w.events(alice))[0]!.id;
    // B → B, across the month: the same row, its item follows
    expect(await next(day(2), [B1, "NVDA will report on January 2, 2027", "2027-01-02"])).toEqual([expect.objectContaining({ day: "2027-01-02", disc_item: "earn:2027-01", confidence: "B" })]);
    // B → A: moved, the A evidence and its time
    expect(await next(day(3), [A1, "NVDA will report on January 5, 2027 at 4:30 p.m. ET", "2027-01-05"])).toEqual([
      expect.objectContaining({ day: "2027-01-05", time: "16:30", source: "NVDA IR", confidence: "A", url: A1 }),
    ]);
    expect((await w.events(alice)).map((e) => [e.id, e.updatedAt])).toEqual([[id, day(3)]]);
    // A → B: left as it is
    expect(await next(day(4), [B1, "NVDA will report on January 6, 2027", "2027-01-06"])).toEqual([expect.objectContaining({ day: "2027-01-05", source: "NVDA IR" })]);
    expect(w.company("2026-12-04")).toMatchObject({ moved: 0, kept: 1 });
  });

  test("the same day: a higher grade replaces the evidence; the same grade with a time fills it with its own url; a lower grade's time is not taken", async () => {
    const { w, alice, next } = await nv();
    await next(SEVEN, [B1, "NVDA will report on January 20, 2027", "2027-01-20"]);
    expect(await next(day(2), [A1, "NVIDIA (NVDA) will report on January 20, 2027", "2027-01-20"])).toEqual([
      expect.objectContaining({ day: "2027-01-20", time: null, source: "NVDA IR", confidence: "A", url: A1 }),
    ]);
    expect((await w.events(alice))[0]!.updatedAt).toBe(day(2));
    // A without a time + B with one: nothing
    expect(await next(day(3), [B1, "NVDA will report on January 20, 2027 at 5 p.m. ET", "2027-01-20"])).toEqual([expect.objectContaining({ time: null, url: A1 })]);
    // A without a time + A with one: the time, and the url and source it came from
    expect(await next(day(4), [A2, "NVDA will host its call on January 20, 2027 at 5 p.m. ET", "2027-01-20"])).toEqual([expect.objectContaining({ time: "17:00", url: A2, source: "NVDA IR", confidence: "A" })]);
    expect((await w.events(alice))[0]!.updatedAt).toBe(day(4));
    expect(w.company("2026-12-04")).toMatchObject({ updated: 1 });
  });

  test("the same day: a higher grade without a time leaves none (the time comes from the words the foot names: team-lead 1853 2)", async () => {
    const { next } = await nv();
    await next(SEVEN, [B1, "NVDA will report on January 20, 2027 at 5 p.m. ET", "2027-01-20"]);
    expect(await next(day(2), [A1, "NVIDIA (NVDA) will report on January 20, 2027", "2027-01-20"])).toEqual([expect.objectContaining({ time: null, source: "NVDA IR", confidence: "A", url: A1 })]);
  });

  test("a release now past stays where it was; the next one is a new row", async () => {
    const { next } = await nv();
    await next(SEVEN, [A1, "NVDA will report on December 10, 2026", "2026-12-10"]);
    expect((await next(day(15), [A1, "NVDA will report on January 28, 2027", "2027-01-28"])).map((r) => [r.day, r.disc_item])).toEqual([
      ["2026-12-10", "earn:2026-12"],
      ["2027-01-28", "earn:2027-01"],
    ]);
  });

  test("a move onto a day with the person's own row of that title takes the found row away; the person's stays", async () => {
    const { w, alice, next } = await nv();
    await next(SEVEN, [B1, "NVDA will report on January 15, 2027", "2027-01-15"]);
    const mine = { market: "US", day: "2027-01-20", kind: "earnings", title: "NVDA 실적 발표", symbol: "NVDA", source: "내 메모", sourceTier: "T3", confidence: "C" };
    expect((await w.h.req("POST", "/api/invest/events", { token: alice.token, body: mine })).status).toBe(201);
    const after = await next(day(2), [A1, "NVDA will report on January 20, 2027", "2027-01-20"]);
    expect(after.map((r) => [r.day, r.source])).toEqual([["2027-01-20", "내 메모"]]);
    expect(w.company("2026-12-02")).toMatchObject({ moved: 0, removed: 1 });
    expect(w.h.db.sql.query("SELECT COUNT(*) AS n FROM invest_event_dismissed WHERE user_id = $u").get({ u: alice.id })).toEqual({ n: 0 });
  });
});

describe("the Toss type, asked with each person's own token (team-lead 1755 1 · 1813 3 · 1823)", () => {
  const ET = (d: string, h: number, m: number) => etToEpoch(d, h, m);

  test("on adding: one ask with that person's own token; its type and Korean name on that row only; the screen's name stays", async () => {
    const w = await world();
    const alice = await w.person("alice", true);
    const bob = await w.person("bob", true);
    w.up.state.tossStocksBy.set(clientOf(alice.id), new Map([["005930", { securityType: "STOCK", name: "삼성전자" }]]));
    w.up.state.tossStocksBy.set(clientOf(bob.id), new Map([["005930", { securityType: "ETF", name: "다른 답" }]]));
    w.up.state.yahoo.set("005930.KS", { price: 70000, time: Math.floor(SEVEN / 1000) - 3600, name: "Samsung Electronics Co., Ltd." });
    for (const p of [alice, bob]) expect((await w.h.req("POST", "/api/invest/watchlist", { token: p.token, body: { symbol: "005930" } })).status).toBe(201);
    await w.h.app.core.idle();
    const asks = w.up.calls.filter((c) => c.path.startsWith("/api/v1/stocks"));
    expect(asks.map((c) => [c.path, c.client])).toEqual([
      ["/api/v1/stocks?symbols=005930", clientOf(alice.id)],
      ["/api/v1/stocks?symbols=005930", clientOf(bob.id)],
    ]);
    const row = (p: { id: string }) => w.h.db.sql.query("SELECT name, security_type, toss_name, type_asked_day FROM invest_watchlist WHERE user_id = $u").get({ u: p.id });
    expect(row(alice)).toEqual({ name: "Samsung Electronics Co., Ltd.", security_type: "STOCK", toss_name: "삼성전자", type_asked_day: "2026-12-01" });
    expect(row(bob)).toEqual({ name: "Samsung Electronics Co., Ltd.", security_type: "ETF", toss_name: "다른 답", type_asked_day: "2026-12-01" });
  });

  test("adding never waits for the Toss ask (team-lead 1853 3): a throwing ask still adds (logged), a held one does not hold the answer", async () => {
    const w = await world();
    const alice = await w.person("alice", true);
    const hub = w.h.app.core.invest as unknown as { toss: { stocks: (u: string, s: string[]) => Promise<unknown> } };
    const errors: string[] = [];
    const error = w.h.app.core.log.error;
    w.h.app.core.log.error = (m: string, f?: Record<string, unknown>) => {
      errors.push(m);
      error(m, f as never);
    };
    hub.toss.stocks = async () => {
      throw new Error("toss blew up");
    };
    expect((await w.h.req("POST", "/api/invest/watchlist", { token: alice.token, body: { symbol: "AMD" } })).status).toBe(201);
    await w.h.app.core.idle();
    expect(w.h.db.sql.query("SELECT symbol, security_type FROM invest_watchlist WHERE user_id = $u").all({ u: alice.id })).toEqual([{ symbol: "AMD", security_type: null }]);
    expect(errors).toEqual(["background task failed"]);
    // a held ask: the add answers first, the type lands when Toss answers
    let release = () => {};
    hub.toss.stocks = () =>
      new Promise((r) => {
        release = () => r({ ok: true, value: new Map([["MU", { type: "STOCK", name: "마이크론" }]]) });
      });
    expect((await w.h.req("POST", "/api/invest/watchlist", { token: alice.token, body: { symbol: "MU" } })).status).toBe(201);
    const mu = () => w.h.db.sql.query("SELECT security_type FROM invest_watchlist WHERE user_id = $u AND symbol = 'MU'").get({ u: alice.id });
    expect(mu()).toEqual({ security_type: null });
    release();
    await w.h.app.core.idle();
    expect(mu()).toEqual({ security_type: "STOCK" });
  });

  test("not in Toss's answer: '' and not asked again; a failed ask: unknown, asked again on another KST day only; a 403 pauses asks with reads", async () => {
    const w = await world();
    const alice = await w.person("alice", true);
    const asks = () => w.up.calls.filter((c) => c.path.startsWith("/api/v1/stocks")).length;
    const row = () => w.h.db.sql.query("SELECT security_type, type_asked_day FROM invest_watchlist WHERE user_id = $u").get({ u: alice.id });
    await w.h.req("POST", "/api/invest/watchlist", { token: alice.token, body: { symbol: "QQQX" } });
    await w.h.app.core.idle();
    expect([asks(), row()]).toEqual([1, { security_type: "", type_asked_day: "2026-12-01" }]);
    await w.h.app.core.invest.fillTypes(alice.id, day(3));
    expect(asks()).toBe(1);
    // a failed ask
    const bob = await w.person("bob", true);
    w.up.state.tossStatus = 500;
    await w.h.req("POST", "/api/invest/watchlist", { token: bob.token, body: { symbol: "AMD" } });
    await w.h.app.core.idle();
    const brow = () => w.h.db.sql.query("SELECT security_type, type_asked_day FROM invest_watchlist WHERE user_id = $u").get({ u: bob.id });
    expect(brow()).toEqual({ security_type: null, type_asked_day: "2026-12-01" });
    const before = w.up.calls.length;
    await w.h.app.core.invest.fillTypes(bob.id, SEVEN + 3_600_000);
    expect(w.up.calls.length).toBe(before);
    w.up.state.tossStatus = null;
    w.up.state.tossStocks.set("AMD", { securityType: "STOCK", name: "AMD" });
    await w.h.app.core.invest.fillTypes(bob.id, day(2));
    expect(brow()).toEqual({ security_type: "STOCK", type_asked_day: "2026-12-02" });
    // a 403: Toss reads pause for that person, and so do the asks
    const carol = await w.person("carol", true);
    w.up.state.tossStatus = 403;
    w.h.clock.t = KST(2026, 12, 2, 23, 30);
    await w.h.req("POST", "/api/invest/watchlist", { token: carol.token, body: { symbol: "MU" } });
    await w.h.app.core.idle();
    expect(idb.getSettings(w.h.db, carol.id)!.toss_paused_until).toBe(KST(2026, 12, 3, 0, 30));
    w.up.state.tossStatus = null;
    w.up.state.tossStocks.set("MU", { securityType: "STOCK", name: "마이크론 테크놀로지" });
    const crow = () => w.h.db.sql.query("SELECT security_type, type_asked_day FROM invest_watchlist WHERE user_id = $u").get({ u: carol.id });
    // 00:10 KST: another day (the day would allow it), inside the pause: no ask
    const n = w.up.calls.length;
    await w.h.app.core.invest.fillTypes(carol.id, KST(2026, 12, 3, 0, 10));
    expect([w.up.calls.length, crow()]).toEqual([n, { security_type: null, type_asked_day: "2026-12-02" }]);
    // 00:40 KST: the pause is over: asked
    await w.h.app.core.invest.fillTypes(carol.id, KST(2026, 12, 3, 0, 40));
    expect([w.up.calls.length, crow()]).toEqual([n + 1, { security_type: "STOCK", type_asked_day: "2026-12-03" }]);
  });

  test("the quote read asks rows with no type yet, once a KST day, with that person's token", async () => {
    const w = await world();
    const alice = await w.person("alice", true);
    w.watch(alice, "NVDA", "NVIDIA Corporation");
    w.up.state.tossPrices.set("NVDA", { price: 180 });
    w.up.state.tossStocks.set("NVDA", { securityType: "STOCK", name: "엔비디아" });
    const tick = async (at: number) => {
      w.h.clock.t = at;
      await w.h.app.core.invest.tick();
      await w.h.app.core.idle();
    };
    await tick(ET("2026-12-01", 10, 0));
    await tick(ET("2026-12-01", 10, 5));
    expect(w.up.calls.filter((c) => c.path.startsWith("/api/v1/stocks")).map((c) => [c.path, c.client])).toEqual([["/api/v1/stocks?symbols=NVDA", clientOf(alice.id)]]);
    expect(w.h.db.sql.query("SELECT security_type, toss_name FROM invest_watchlist WHERE user_id = $u").get({ u: alice.id })).toEqual({ security_type: "STOCK", toss_name: "엔비디아" });
  });
});
