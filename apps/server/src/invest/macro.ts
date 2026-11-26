/**
 * The macro series (B2e-0, team-lead 0243; agent-runtime 0212): FRED's fredgraph CSV (no key) for rates, credit, jobs,
 * financial conditions, VIX, the S&P 500 and the dollar against the won and the yen, and Yahoo's chart JSON only for
 * what FRED does not carry (KOSPI). B2b-2's snapshot reads them; nothing here calls a model.
 *
 * The access rules are sources.ts's gate: the default User-Agent, one request at a time per host, a 403 or 429 rests
 * the source until the next US market day (the figures read 확인 불가 meanwhile), and nothing is called unless
 * PICKLE_INVEST_SOURCES=on. One read serves everyone (a shared cache, FRED_CACHE_MS); a body that is not the series
 * (a block page with 200) rests the source like a 403 and is never cached.
 */
import type { Bar, Point } from "@pickle/quant";
import { civilDate, dayNumber } from "@pickle/quant";
import type { Core } from "../core.ts";
import { dailyUntil, kstDay, marketDate } from "./calendar.ts";
import { cacheGet, cachePut } from "./db.ts";
import { parseYahooDaily, SOURCE_TABLE } from "./sources.ts";

/** the FRED series B2b-2 reads (0212: rates, credit, jobs, conditions; 0243: VIX, S&P 500, KRW and JPY from FRED) */
/** A2 1–5 and 10 (CPILFESL: core CPI, seasonally adjusted, monthly; its MoM is A2 10, A5 A4 and A6 R5), A3/A5 VIX, S&P 500, FX */
export const FRED_IDS = ["DGS10", "DGS2", "DFEDTARU", "BAMLH0A0HYM2", "UNRATE", "CPILFESL", "SAHMREALTIME", "IC4WSA", "NFCI", "VIXCLS", "SP500", "DEXKOUS", "DEXJPUS"] as const;
export type FredId = (typeof FRED_IDS)[number];
/** what FRED does not carry, from Yahoo (0243: "^KS11처럼 FRED에 없는 것만") */
export const YAHOO_INDICES = ["^KS11"] as const;
export type YahooIndex = (typeof YAHOO_INDICES)[number];

/** a FRED read lasts this long for everyone (the daily series move once a day; a 6-hour read catches the morning one) */
export const FRED_CACHE_MS = 6 * 60 * 60_000;
/** three calendar years and the current one: enough for 12-month windows and the Sahm rule's history */
const FRED_YEARS = 3;

export interface MacroSeries {
  id: string;
  points: Point[];
  /** the last day with a value */
  asOf: string;
  source: { name: string; grade: "A" | "B+" };
}

/** the CSV URL; the start is the 1st of January three years back, so the URL (and its cache key) changes once a year */
export function fredUrl(id: FredId, now: number): string {
  const y = Number(kstDay(now).slice(0, 4)) - FRED_YEARS;
  return `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}&cosd=${y}-01-01`;
}

const isDay = (t: string | undefined): t is string => !!t && /^\d{4}-\d{2}-\d{2}$/.test(t) && civilDate(dayNumber(t)) === t;

/**
 * fredgraph CSV → points, oldest first: the header `observation_date,<ID>` (or the older `DATE,<ID>`), then one day a
 * line; an empty cell or "." is a day without a value (null). Anything else — another series, an HTML page, a bad day
 * or number, days out of order — is not the series: null.
 */
export function parseFredCsv(text: string, id: string): Point[] | null {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const lines = body.split(/\r?\n/).filter((l) => l.trim() !== "");
  const head = lines[0]?.split(",").map((c) => c.trim());
  if (!head || head.length !== 2 || !/^(observation_date|DATE)$/.test(head[0]!) || head[1] !== id) return null;
  const out: Point[] = [];
  for (const line of lines.slice(1)) {
    const cells = line.split(",").map((c) => c.trim());
    if (cells.length !== 2 || !isDay(cells[0])) return null;
    const t = cells[0];
    if (out.length && t <= out[out.length - 1]!.t) return null;
    const raw = cells[1]!;
    if (raw === "" || raw === ".") {
      out.push({ t, v: null });
      continue;
    }
    if (!/^-?\d+(\.\d+)?$/.test(raw)) return null;
    out.push({ t, v: Number(raw) });
  }
  return out;
}

/** a cached body, or one read through the gate and kept only once `parse` takes it */
async function readThrough<T>(core: Core, source: "fred" | "yahoo", url: string, parse: (text: string) => T | null, expiresAt: (now: number) => number): Promise<T | null> {
  const gate = core.invest.gate;
  const hit = cacheGet(core.db, url, core.now());
  if (hit != null) return parse(hit);
  const r = await gate.get(source, url);
  // Yahoo's own "no such symbol" (404 with its JSON) is an answer, not a block page
  if (!r.ok || r.status === 404) return null;
  const v = parse(r.text);
  if (v === null) {
    gate.pauseForJunk(source);
    return null;
  }
  cachePut(core.db, url, r.text, core.now(), expiresAt(core.now()));
  return v;
}

/** one FRED series, or null (sources off, resting after a 403/429/junk, unreachable, or no value in it at all) */
export async function fredSeries(core: Core, id: FredId): Promise<MacroSeries | null> {
  const points = await readThrough(core, "fred", fredUrl(id, core.now()), (t) => parseFredCsv(t, id), (now) => now + FRED_CACHE_MS);
  if (!points) return null;
  const last = [...points].reverse().find((p) => p.v != null);
  return last ? { id, points, asOf: last.t, source: SOURCE_TABLE.fred } : null;
}

/** Yahoo's chart URL for an index as Yahoo names it (no market suffix) */
export function yahooIndexUrl(symbol: YahooIndex): string {
  return `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1y&interval=1d`;
}

/** an index's daily bars from Yahoo (KOSPI: Korean market days), or null */
export async function indexBars(core: Core, symbol: YahooIndex): Promise<{ bars: Bar[]; asOf: string; source: { name: string; grade: "A" | "B+" } } | null> {
  const bars = await readThrough(
    core,
    "yahoo",
    yahooIndexUrl(symbol),
    (t) => {
      const b = parseYahooDaily(t, (ms) => marketDate("KR", ms));
      return b && b.length ? b : null;
    },
    (now) => dailyUntil("KR", now),
  );
  return bars ? { bars, asOf: bars.at(-1)!.t, source: SOURCE_TABLE.yahoo } : null;
}
