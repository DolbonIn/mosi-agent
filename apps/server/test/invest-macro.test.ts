/**
 * Invest B2e-0: the macro series (team-lead 0243). FRED's fredgraph CSV for rates, credit, jobs, conditions, VIX, the
 * S&P 500, KRW and JPY; Yahoo only for KOSPI. The access rules hold for the new host: nothing called with sources off,
 * the default User-Agent, one request at a time per host, a 403/429 or a body that is not the series rests the source
 * until the next US market day (and is never cached), one read serves everyone. Bodies are synthetic (test/fake-toss.ts);
 * nothing real is called.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { etToEpoch, nextMarketDayStart } from "../src/invest/calendar.ts";
import * as idb from "../src/invest/db.ts";
import { FRED_IDS, fredSeries, fredUrl, indexBars, parseFredCsv, yahooIndexUrl } from "../src/invest/macro.ts";
import { makeInvestUpstream, syntheticBars } from "./fake-toss.ts";
import { makeHarness, type Harness } from "./helpers.ts";

const DAY = "2026-11-30";
const ET = (h: number, m: number, day = DAY) => etToEpoch(day, h, m);
const CSV = "observation_date,DGS10\n2026-11-24,4.10\n2026-11-25,4.12\n2026-11-26,\n2026-11-27,4.08\n";

interface World {
  h: Harness;
  up: ReturnType<typeof makeInvestUpstream>;
  inflight: { now: number; max: Record<string, number> };
}
const worlds: World[] = [];
async function world(o: { sources?: boolean } = {}): Promise<World> {
  const up = makeInvestUpstream();
  const inflight = { now: 0, max: {} as Record<string, number> };
  const per = new Map<string, number>();
  // counts requests in flight per host (the gate serialises per host)
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const host = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url).host;
    per.set(host, (per.get(host) ?? 0) + 1);
    inflight.max[host] = Math.max(inflight.max[host] ?? 0, per.get(host)!);
    try {
      await Bun.sleep(3);
      return await up.fetch(input, init);
    } finally {
      per.set(host, per.get(host)! - 1);
    }
  }) as typeof fetch;
  const h = await makeHarness({ now: ET(9, 0), config: { invest: { sources: o.sources ?? true, tossBase: null, outboundIp: null } }, deps: () => ({ investFetch: fetchFn }) });
  const w = { h, up, inflight };
  worlds.push(w);
  return w;
}
afterEach(async () => {
  while (worlds.length) await worlds.pop()!.h.close();
});
const fredCalls = (w: World) => w.up.calls.filter((c) => c.host === "fred.stlouisfed.org");

describe("fredgraph CSV", () => {
  test("today's header with empty cells, the older header with dots; anything else is not the series", () => {
    expect(parseFredCsv(CSV, "DGS10")).toEqual([
      { t: "2026-11-24", v: 4.1 },
      { t: "2026-11-25", v: 4.12 },
      { t: "2026-11-26", v: null },
      { t: "2026-11-27", v: 4.08 },
    ]);
    expect(parseFredCsv("DATE,VIXCLS\r\n2026-11-25,17.20\r\n2026-11-26,.\r\n", "VIXCLS")).toEqual([
      { t: "2026-11-25", v: 17.2 },
      { t: "2026-11-26", v: null },
    ]);
    expect(parseFredCsv(String.fromCharCode(0xfeff) + CSV, "DGS10")?.length).toBe(4); // DD 0612 F3: the header cell's trim() takes the BOM
    expect(parseFredCsv("observation_date,SAHMREALTIME\n2026-10-01,-0.03\n", "SAHMREALTIME")).toEqual([{ t: "2026-10-01", v: -0.03 }]);
    expect(parseFredCsv(CSV, "DGS2")).toBeNull(); // another series
    expect(parseFredCsv("<!DOCTYPE html><html><body>Just a moment...</body></html>", "DGS10")).toBeNull();
    expect(parseFredCsv("observation_date,DGS10\n2026-11-25,4.1x\n", "DGS10")).toBeNull();
    expect(parseFredCsv("observation_date,DGS10\n2026-02-30,4.1\n", "DGS10")).toBeNull();
    expect(parseFredCsv("observation_date,DGS10\n2026-11-25,4.1\n2026-11-24,4.0\n", "DGS10")).toBeNull();
    expect(parseFredCsv("observation_date,DGS10,extra\n2026-11-25,4.1,1\n", "DGS10")).toBeNull();
    expect(parseFredCsv("", "DGS10")).toBeNull();
  });

  test("the URL starts three calendar years back and changes once a year", () => {
    expect(fredUrl("DGS10", ET(9, 0))).toBe("https://fred.stlouisfed.org/graph/fredgraph.csv?id=DGS10&cosd=2023-01-01");
    expect(fredUrl("DGS10", ET(9, 0, "2026-12-30"))).toBe(fredUrl("DGS10", ET(9, 0)));
    expect(fredUrl("DGS10", ET(12, 0, "2027-01-04"))).toContain("cosd=2024-01-01");
  });
});

describe("reading FRED", () => {
  test("the series with its last value's day and FRED · A; one read serves every later read", async () => {
    const w = await world();
    w.up.state.fred.set("DGS10", CSV);
    const s = await fredSeries(w.h.app.core, "DGS10");
    expect(s).toEqual({ id: "DGS10", points: parseFredCsv(CSV, "DGS10")!, asOf: "2026-11-27", source: { name: "FRED", grade: "A" } });
    expect(await fredSeries(w.h.app.core, "DGS10")).toEqual(s);
    expect(fredCalls(w).map((c) => [c.path, c.userAgent])).toEqual([["/graph/fredgraph.csv?id=DGS10&cosd=2023-01-01", null]]);
    w.h.clock.t += 6 * 60 * 60_000; // FRED_CACHE_MS later: read again
    await fredSeries(w.h.app.core, "DGS10");
    expect(fredCalls(w).length).toBe(2);
  });

  test("every series B2b-2 reads, one at a time on FRED's host", async () => {
    const w = await world();
    for (const id of FRED_IDS) w.up.state.fred.set(id, `observation_date,${id}\n2026-11-26,1.5\n2026-11-27,1.6\n`);
    w.up.state.yahooDaily.set("^KS11", syntheticBars(DAY, 30, 2500, 30));
    const got = await Promise.all([...FRED_IDS.map((id) => fredSeries(w.h.app.core, id)), indexBars(w.h.app.core, "^KS11")]);
    expect(got.every((g) => g !== null)).toBe(true);
    expect(fredCalls(w).length).toBe(FRED_IDS.length);
    expect(w.inflight.max["fred.stlouisfed.org"]).toBe(1);
  });

  test("a 429 rests FRED until the next US market day: no more calls, Yahoo untouched", async () => {
    const w = await world();
    w.up.state.fred.set("DGS10", 429);
    w.up.state.fred.set("DGS2", "observation_date,DGS2\n2026-11-27,3.9\n");
    expect(await fredSeries(w.h.app.core, "DGS10")).toBeNull();
    expect(idb.sourcePausedUntil(w.h.db, "fred")).toBe(nextMarketDayStart("US", ET(9, 0)));
    expect(await fredSeries(w.h.app.core, "DGS2")).toBeNull();
    expect(fredCalls(w).length).toBe(1);
    expect(idb.sourcePausedUntil(w.h.db, "yahoo")).toBeNull();
    w.h.clock.t = nextMarketDayStart("US", ET(9, 0));
    expect((await fredSeries(w.h.app.core, "DGS2"))?.asOf).toBe("2026-11-27");
  });

  test("a 200 that is not the series rests FRED and is not kept", async () => {
    const w = await world();
    w.up.state.fred.set("DGS10", "<html><body>Request blocked</body></html>");
    expect(await fredSeries(w.h.app.core, "DGS10")).toBeNull();
    expect(idb.sourcePausedUntil(w.h.db, "fred")).toBe(nextMarketDayStart("US", ET(9, 0)));
    expect(idb.cacheGet(w.h.db, fredUrl("DGS10", ET(9, 0)), w.h.clock.t)).toBeNull();
  });

  test("a series with no value at all is no series; sources off calls nothing", async () => {
    const w = await world();
    w.up.state.fred.set("NFCI", "observation_date,NFCI\n2026-11-21,\n");
    expect(await fredSeries(w.h.app.core, "NFCI")).toBeNull();
    expect(idb.sourcePausedUntil(w.h.db, "fred")).toBeNull();
    const off = await world({ sources: false });
    off.up.state.fred.set("DGS10", CSV);
    expect(await fredSeries(off.h.app.core, "DGS10")).toBeNull();
    expect(fredCalls(off)).toEqual([]);
  });
});

describe("KOSPI from Yahoo", () => {
  test("the index's bars on Korean days, Yahoo · B+; Yahoo's not-found rests nothing", async () => {
    const w = await world();
    const bars = syntheticBars(DAY, 30, 2500, 30);
    w.up.state.yahooDaily.set("^KS11", bars);
    const k = await indexBars(w.h.app.core, "^KS11");
    expect(k?.bars.length).toBe(30);
    expect(k?.source).toEqual({ name: "Yahoo(지연 시세)", grade: "B+" });
    expect(w.up.calls.filter((c) => c.host === "query1.finance.yahoo.com").map((c) => c.path)).toEqual([new URL(yahooIndexUrl("^KS11")).pathname + new URL(yahooIndexUrl("^KS11")).search]);
    const fresh = await world();
    expect(await indexBars(fresh.h.app.core, "^KS11")).toBeNull(); // not set: Yahoo's 404 JSON
    expect(idb.sourcePausedUntil(fresh.h.db, "yahoo")).toBeNull();
  });
});
