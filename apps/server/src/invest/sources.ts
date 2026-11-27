/**
 * Public sources for the invest watch (agent-runtime 2052 §A-4, team-lead 2045 and its 21:2x correction): Yahoo chart
 * JSON for quotes and daily bars, and since B2e-0 (team-lead 0243) FRED's fredgraph CSV for the macro series (macro.ts);
 * since B2d-2a the calendars new events are found in (discovery.ts): the Federal Register, the Fed's FOMC page, BLS, and
 * since B2d-2b BEA's calendar and the Bank of Korea's MPC list.
 * Toss (the person's own key) is toss.ts. Stooq is out: it answers this server with a JavaScript browser
 * check instead of its CSV (mobile-foundation 2118), and a bot check is never worked around.
 *
 * Access rules (lead): the default User-Agent (no header is set here), one request at a time per host, a 10 s limit,
 * and a 403 or 429 pauses that source until the next US market day — not called again in the same run, no retry storm.
 * Nothing is called unless PICKLE_INVEST_SOURCES=on (cfg.invest.sources). Response bodies never reach logs, cards or the
 * model: a failure keeps its status code alone.
 */
import type { Bar } from "@pickle/quant";
import type { Core } from "../core.ts";
import { nextMarketDayStart, type Market } from "./calendar.ts";
import { cacheGet, cachePut, sourcePausedUntil, sourceRecord } from "./db.ts";

/** the calendars discovery.ts reads (B2d-2a) */
export type DiscoverySource = "fedreg" | "fomc" | "bls" | "bea" | "bok";
export type SourceKey = "toss" | "yahoo" | "fred" | DiscoverySource;
export type PublicSource = Exclude<SourceKey, "toss">;

/** the source table (2006 §3, 2045 §12-12): name and grade as screens show them */
export const SOURCE_TABLE: Readonly<Record<SourceKey, { name: string; grade: "A" | "B+" }>> = {
  toss: { name: "토스증권", grade: "A" },
  yahoo: { name: "Yahoo(지연 시세)", grade: "B+" },
  fred: { name: "FRED", grade: "A" },
  fedreg: { name: "연방관보", grade: "A" }, // DD 1711: the Federal Register as Korean readers know it
  fomc: { name: "연준", grade: "A" },
  bls: { name: "BLS", grade: "A" },
  bea: { name: "BEA", grade: "A" },
  bok: { name: "한국은행", grade: "A" },
};

/** keyed public APIs a person may connect later (2045 and its correction): listed, never called in B1 */
export const KEYED_SOURCES = [
  { name: "Tiingo", state: "키 필요 · 미연결" },
  { name: "Alpha Vantage", state: "키 필요 · 미연결" },
  { name: "Finnhub", state: "키 필요 · 미연결" },
  { name: "Twelve Data", state: "키 필요 · 미연결" },
] as const;

export const SOURCE_TIMEOUT_MS = 10_000;
const HOSTS: Readonly<Record<PublicSource, string>> = {
  yahoo: "query1.finance.yahoo.com",
  fred: "fred.stlouisfed.org",
  fedreg: "www.federalregister.gov",
  fomc: "www.federalreserve.gov",
  bls: "www.bls.gov",
  bea: "www.bea.gov",
  bok: "www.bok.or.kr",
};

export type SourceResult =
  | { ok: true; status: number; text: string }
  | { ok: false; code: "off" | "paused" | "blocked" | "http" | "timeout" | "network"; status?: number };

export interface Quote {
  symbol: string;
  price: number;
  prevClose: number | null;
  /** when the price was observed (the source's own time when it gives one) */
  at: number;
  source: SourceKey;
  name?: string;
  /** the day chart's first bar (Yahoo 1d/5m, B2c-2's gap): its open and when it began; absent when the body has none */
  open?: { price: number; at: number };
}

/** One gate per app: serialises requests per host and keeps the pause state in invest_source_state. */
export class SourceGate {
  private chains = new Map<string, Promise<unknown>>();

  constructor(
    private core: Core,
    private fetchFn: typeof fetch,
  ) {}

  enabled(): boolean {
    return this.core.cfg.invest.sources;
  }

  pausedUntil(source: PublicSource): number | null {
    const until = sourcePausedUntil(this.core.db, source);
    return until && until > this.core.now() ? until : null;
  }

  /** GET a public source URL under the access rules. */
  get(source: PublicSource, url: string): Promise<SourceResult> {
    if (!this.enabled()) return Promise.resolve({ ok: false, code: "off" });
    const host = HOSTS[source];
    const prev = this.chains.get(host) ?? Promise.resolve();
    const run = prev.then(() => this.once(source, url));
    this.chains.set(
      host,
      run.catch(() => undefined),
    );
    return run;
  }

  private async once(source: PublicSource, url: string): Promise<SourceResult> {
    const { core } = this;
    if (this.pausedUntil(source)) return { ok: false, code: "paused" };
    let res: Response;
    try {
      res = await this.fetchFn(url, { signal: AbortSignal.timeout(SOURCE_TIMEOUT_MS) });
    } catch (err) {
      const timeout = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
      sourceRecord(core.db, source, { status: 0, error: timeout ? "timeout" : "network", pausedUntil: null, now: core.now() });
      return { ok: false, code: timeout ? "timeout" : "network" };
    }
    if (res.status === 403 || res.status === 429) {
      const until = nextMarketDayStart("US", core.now());
      sourceRecord(core.db, source, { status: res.status, error: "blocked", pausedUntil: until, now: core.now() });
      core.log.warn("invest source paused", { source, status: res.status, until });
      await res.body?.cancel().catch(() => undefined);
      return { ok: false, code: "blocked", status: res.status };
    }
    // Yahoo answers an unknown symbol with 404 and its own chart JSON ("Not Found"): the parser reads it
    if (res.status === 404 && source === "yahoo") {
      const text = await res.text();
      sourceRecord(core.db, source, { status: 404, error: null, pausedUntil: null, now: core.now() });
      return { ok: true, status: 404, text };
    }
    if (!res.ok) {
      sourceRecord(core.db, source, { status: res.status, error: "http", pausedUntil: null, now: core.now() });
      await res.body?.cancel().catch(() => undefined);
      return { ok: false, code: "http", status: res.status };
    }
    const text = await res.text();
    sourceRecord(core.db, source, { status: res.status, error: null, pausedUntil: null, now: core.now() });
    return { ok: true, status: res.status, text };
  }

  /** a response the source sent that is not its data (a block page with 200): paused like a 403 */
  pauseForJunk(source: PublicSource): void {
    const until = nextMarketDayStart("US", this.core.now());
    sourceRecord(this.core.db, source, { status: 200, error: "not_data", pausedUntil: until, now: this.core.now() });
    this.core.log.warn("invest source paused", { source, status: 200, reason: "not_data", until });
  }
}

// ───────────────────────────── Yahoo chart JSON ─────────────────────────────

export function yahooSymbol(symbol: string, market: Market): string {
  return market === "KR" ? `${symbol}.KS` : symbol;
}

export function yahooUrl(symbol: string, market: Market, range: "1d" | "1y"): string {
  const interval = range === "1d" ? "5m" : "1d";
  return `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol(symbol, market))}?range=${range}&interval=${interval}`;
}

interface YahooChart {
  chart?: {
    result?: {
      meta?: {
        regularMarketPrice?: unknown;
        regularMarketTime?: unknown;
        chartPreviousClose?: unknown;
        previousClose?: unknown;
        longName?: unknown;
        shortName?: unknown;
      };
      timestamp?: unknown[];
      indicators?: { quote?: { open?: unknown[]; high?: unknown[]; low?: unknown[]; close?: unknown[]; volume?: unknown[] }[] };
    }[];
    error?: { code?: unknown } | null;
  };
}

const finite = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) ? x : null);

/** "not_found" for Yahoo's own "no such symbol" answer; null when the body is not chart JSON */
export function parseYahooQuote(text: string, symbol: string): Quote | "not_found" | null {
  let j: YahooChart;
  try {
    j = JSON.parse(text) as YahooChart;
  } catch {
    return null;
  }
  if (!j.chart) return null;
  if (j.chart.error) return String(j.chart.error.code ?? "").toLowerCase().includes("not found") ? "not_found" : null;
  const meta = j.chart.result?.[0]?.meta;
  const price = finite(meta?.regularMarketPrice);
  const time = finite(meta?.regularMarketTime);
  if (price == null || price <= 0 || time == null) return null;
  const name = typeof meta?.longName === "string" && meta.longName.trim() ? meta.longName.trim() : typeof meta?.shortName === "string" && meta.shortName.trim() ? meta.shortName.trim() : undefined;
  // the first bar with an open (a bar before the first trade has none)
  const r = j.chart.result?.[0];
  const opens = r?.indicators?.quote?.[0]?.open;
  let open: Quote["open"];
  if (Array.isArray(opens) && Array.isArray(r?.timestamp)) {
    const i = opens.findIndex((x) => (finite(x) ?? 0) > 0);
    const t = i >= 0 ? finite(r.timestamp[i]) : null;
    if (i >= 0 && t != null) open = { price: finite(opens[i])!, at: t * 1000 };
  }
  return {
    symbol,
    price,
    prevClose: finite(meta?.chartPreviousClose) ?? finite(meta?.previousClose),
    at: time * 1000,
    source: "yahoo",
    ...(name ? { name: name.slice(0, 80) } : {}),
    ...(open ? { open } : {}),
  };
}

/** daily bars from a range=1y&interval=1d chart; the day is the bar's US Eastern date (`dayOf`) */
export function parseYahooDaily(text: string, dayOf: (ms: number) => string): Bar[] | null {
  let j: YahooChart;
  try {
    j = JSON.parse(text) as YahooChart;
  } catch {
    return null;
  }
  if (j.chart?.error) return String(j.chart.error.code ?? "").toLowerCase().includes("not found") ? [] : null;
  const r = j.chart?.result?.[0];
  const q = r?.indicators?.quote?.[0];
  if (!r || !Array.isArray(r.timestamp) || !q) return null;
  const bars: Bar[] = [];
  r.timestamp.forEach((ts, i) => {
    const t = finite(ts);
    const c = finite(q.close?.[i]);
    if (t == null || c == null || c <= 0) return;
    bars.push({ t: dayOf(t * 1000), o: finite(q.open?.[i]) ?? c, h: finite(q.high?.[i]) ?? c, l: finite(q.low?.[i]) ?? c, c, v: finite(q.volume?.[i]) ?? 0 });
  });
  return bars;
}

// ───────────────────────────── cached reads ─────────────────────────────

/** Read through the shared cache (one fetch serves every person): `ttl` from the fetch time. */
export async function cachedGet(gate: SourceGate, core: Core, source: PublicSource, url: string, expiresAt: (now: number) => number): Promise<SourceResult> {
  const hit = cacheGet(core.db, url, core.now());
  if (hit != null) return { ok: true, status: 200, text: hit };
  const r = await gate.get(source, url);
  if (r.ok) cachePut(core.db, url, r.text, core.now(), expiresAt(core.now()));
  return r;
}
