/**
 * Fake invest upstreams for tests: Toss Open API and Yahoo chart JSON. Every body here is synthetic,
 * shaped like the real ones (team-lead: recorded real responses never enter the repo). Nothing leaves the process.
 */
import type { Bar } from "@pickle/quant";

export const FAKE_TOSS_BASE = "https://toss.fake.test";
/** bogus key material (the k-skill login's fields): a test asserts these strings never reach events, rows or logs */
export const BOGUS_TOSS_SECRET = { clientId: "ci-bogus-7f3a", clientSecret: "cs-bogus-91c2" };

export interface FakeCall {
  host: string;
  method: string;
  path: string;
  auth: string | null;
  account: string | null;
  body: string | null;
  userAgent: string | null;
}

/** Toss's /api/v1/prices has no previous close (openapi.json 1.2.28); `prevClose` is ignored here, kept for Yahoo-shaped calls */
export interface TossQuote {
  price: number;
  prevClose?: number;
  time?: string;
}

export interface YahooQuote {
  price: number;
  prevClose?: number;
  /** seconds */
  time: number;
  name?: string;
  /** B2c-2: the day chart's first 5-minute bar (its open, and when it began in seconds); absent = a close-only body */
  open?: { price: number; time: number };
}

export function makeInvestUpstream() {
  const calls: FakeCall[] = [];
  let tokenN = 0;
  /** every token this fake gave out → the client_id it went to; a token not here (or revoked) answers 401 */
  const tokens = new Map<string, string>();
  const state = {
    /** Toss: per symbol */
    tossPrices: new Map<string, TossQuote>(),
    tossHoldings: [] as { symbol: string; quantity: number; averagePrice?: number }[],
    tossSellable: new Map<string, number>(),
    /** a status every Toss API call answers with (403 = the allowed IP, 401, 429, 500) */
    tossStatus: null as number | null,
    tokenStatus: null as number | null,
    /** Toss daily candles per symbol, oldest first here (served newest first) */
    tossCandles: new Map<string, Bar[]>(),
    /**
     * Toss market calendar per "US:2026-11-26" / "KR:2026-07-17": the regular session's ISO start and end, or null for
     * a closed day; `krxClosed` = NXT trades, KRX does not (no closing auction). A day not set answers 404.
     */
    tossCalendar: new Map<string, { open: string; close: string; krxClosed?: boolean } | null>(),
    /** GET /api/v1/accounts (openapi.json: {result: [{accountNo, accountSeq, accountType}]}) */
    tossAccounts: [{ accountNo: "12345678901", accountSeq: 7, accountType: "BROKERAGE" }] as { accountNo: string; accountSeq: number; accountType: string }[],
    /** tokens Toss no longer takes (another one was issued, or it was revoked): 401 */
    tossRevoked: new Set<string>(),
    yahoo: new Map<string, YahooQuote | "not_found" | number>(),
    yahooDaily: new Map<string, Bar[]>(),
    /** FRED fredgraph CSV per series id: the body to send, or a status (403, 429, 500); an id not set answers 404 */
    fred: new Map<string, string | number>(),
    /** B2d-2a's calendars: the body each answers with, or a status (403, 429, 500); unset answers 404 */
    fedreg: null as string | number | null,
    fomc: null as string | number | null,
    bls: null as string | number | null,
  };

  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const headers = new Headers(init?.headers);
    const body = init?.body == null ? null : typeof init.body === "string" ? init.body : init.body instanceof URLSearchParams ? init.body.toString() : "[body]";
    calls.push({
      host: url.host,
      method: init?.method ?? "GET",
      path: url.pathname + url.search,
      auth: headers.get("authorization"),
      account: headers.get("x-tossinvest-account"),
      body,
      userAgent: headers.get("user-agent"),
    });

    if (url.origin === FAKE_TOSS_BASE) {
      if (url.pathname === "/oauth2/token") {
        if (state.tokenStatus) return json({ error: "nope" }, state.tokenStatus);
        const client = new URLSearchParams(body ?? "").get("client_id") ?? "";
        const t = `tok-${++tokenN}`;
        tokens.set(t, client);
        return json({ access_token: t, token_type: "Bearer", expires_in: 3600 });
      }
      if (state.tossStatus) return json({ error: { code: "x" } }, state.tossStatus);
      const bearer = /^Bearer (.+)$/.exec(headers.get("authorization") ?? "")?.[1] ?? "";
      if (!tokens.has(bearer) || state.tossRevoked.has(bearer)) return json({ error: { code: "invalid_token" } }, 401);
      // the account surfaces need X-Tossinvest-Account (openapi.json AccountSeq, required); market data does not
      if (["/api/v1/holdings", "/api/v1/sellable-quantity", "/api/v1/buying-power"].includes(url.pathname)) {
        const acct = headers.get("x-tossinvest-account");
        if (!acct || !state.tossAccounts.some((a) => String(a.accountSeq) === acct)) return json({ error: { code: "invalid_account" } }, 400);
      }
      if (url.pathname === "/api/v1/accounts") return json({ result: state.tossAccounts });
      if (url.pathname === "/api/v1/buying-power") return json({ result: { currency: "KRW", cashBuyingPower: "1000000" } });
      if (url.pathname === "/api/v1/prices") {
        const syms = (url.searchParams.get("symbols") ?? "").split(",").filter(Boolean);
        // the shapes of the public openapi.json (1.2.28), synthetic values
        return json({
          result: syms.flatMap((s) => {
            const q = state.tossPrices.get(s);
            return q ? [{ symbol: s, timestamp: q.time ?? null, lastPrice: String(q.price), currency: "USD" }] : [];
          }),
        });
      }
      if (url.pathname === "/api/v1/holdings")
        return json({
          result: {
            items: state.tossHoldings.map((h) => ({
              symbol: h.symbol,
              name: h.symbol,
              marketCountry: "US",
              currency: "USD",
              quantity: String(h.quantity),
              lastPrice: String(state.tossPrices.get(h.symbol)?.price ?? 0),
              averagePurchasePrice: String(h.averagePrice ?? 0),
            })),
          },
        });
      if (url.pathname === "/api/v1/sellable-quantity") {
        const s = url.searchParams.get("symbol") ?? "";
        return json({ result: { sellableQuantity: String(state.tossSellable.get(s) ?? 0) } });
      }
      if (url.pathname === "/api/v1/candles") {
        const s = url.searchParams.get("symbol") ?? "";
        const kr = /^\d{6}$/.test(s);
        const bars = [...(state.tossCandles.get(s) ?? [])].reverse().slice(0, Number(url.searchParams.get("count") ?? 100));
        const candles = bars.map((b) => ({
          timestamp: `${b.t}T00:00:00${kr ? "+09:00" : "-05:00"}`,
          openPrice: String(b.o),
          highPrice: String(b.h),
          lowPrice: String(b.l),
          closePrice: String(b.c),
          volume: String(b.v),
          currency: kr ? "KRW" : "USD",
        }));
        return json({ result: { candles, nextBefore: null } });
      }
      const cal = /^\/api\/v1\/market-calendar\/(US|KR)$/.exec(url.pathname);
      if (cal) {
        const market = cal[1]!;
        const date = url.searchParams.get("date") ?? "";
        const k = `${market}:${date}`;
        if (!state.tossCalendar.has(k)) return json({ error: { code: "not_found" } }, 404);
        const v = state.tossCalendar.get(k)!;
        const near = { date };
        if (market === "US") return json({ result: { today: { date, dayMarket: null, preMarket: null, regularMarket: v ? { startTime: v.open, endTime: v.close } : null, afterMarket: null }, previousBusinessDay: near, nextBusinessDay: near } });
        const integrated = v ? { preMarket: null, regularMarket: { startTime: v.open, singlePriceAuctionStartTime: v.krxClosed ? null : v.close, endTime: v.close }, afterMarket: null } : null;
        return json({ result: { today: { date, integrated }, previousBusinessDay: near, nextBusinessDay: near } });
      }
      return json({ error: "no route" }, 404);
    }

    if (url.host === "query1.finance.yahoo.com") {
      const m = /^\/v8\/finance\/chart\/([^/]+)$/.exec(url.pathname);
      const sym = m ? decodeURIComponent(m[1]!) : "";
      const range = url.searchParams.get("range");
      if (range === "1y") {
        const bars = state.yahooDaily.get(sym);
        if (!bars) return json({ chart: { result: null, error: { code: "Not Found", description: "No data found, symbol may be delisted" } } }, 404);
        return json({
          chart: {
            result: [
              {
                meta: { symbol: sym, regularMarketPrice: bars.at(-1)!.c },
                timestamp: bars.map((b) => Date.parse(`${b.t}T14:30:00Z`) / 1000),
                indicators: { quote: [{ open: bars.map((b) => b.o), high: bars.map((b) => b.h), low: bars.map((b) => b.l), close: bars.map((b) => b.c), volume: bars.map((b) => b.v) }] },
              },
            ],
            error: null,
          },
        });
      }
      const q = state.yahoo.get(sym);
      if (typeof q === "number") return new Response("blocked", { status: q });
      // a symbol the test did not set answers 500 (no quote, no pause); "not_found" is Yahoo's own unknown-symbol answer
      if (!q) return new Response("unavailable", { status: 500 });
      if (q === "not_found") return json({ chart: { result: null, error: { code: "Not Found", description: "No data found, symbol may be delisted" } } }, 404);
      return json({
        chart: {
          result: [
            {
              meta: { symbol: sym, regularMarketPrice: q.price, regularMarketTime: q.time, chartPreviousClose: q.prevClose ?? null, longName: q.name ?? null },
              ...(q.open
                ? { timestamp: [q.open.time, q.time], indicators: { quote: [{ open: [q.open.price, q.price], close: [q.price, q.price] }] } }
                : { timestamp: [q.time], indicators: { quote: [{ close: [q.price] }] } }),
            },
          ],
          error: null,
        },
      });
    }

    if (url.host === "fred.stlouisfed.org" && url.pathname === "/graph/fredgraph.csv") {
      const v = state.fred.get(url.searchParams.get("id") ?? "");
      if (typeof v === "number") return new Response("blocked", { status: v });
      if (v === undefined) return new Response("Not Found", { status: 404 });
      return new Response(v, { status: 200, headers: { "content-type": "text/csv" } });
    }

    const calendar = (v: string | number | null, type: string) =>
      typeof v === "number" ? new Response("blocked", { status: v }) : v === null ? new Response("Not Found", { status: 404 }) : new Response(v, { status: 200, headers: { "content-type": type } });
    if (url.host === "www.federalregister.gov" && url.pathname === "/api/v1/documents.json") return calendar(state.fedreg, "application/json");
    if (url.host === "www.federalreserve.gov" && url.pathname === "/monetarypolicy/fomccalendars.htm") return calendar(state.fomc, "text/html");
    if (url.host === "www.bls.gov" && url.pathname === "/schedule/news_release/bls.ics") return calendar(state.bls, "text/calendar");

    throw new Error(`fake upstream: unexpected ${url.host}`);
  }) as typeof fetch;

  return { fetch: fetchFn, calls, state, tokens };
}

/** `n` synthetic daily bars ending the day before `lastDay` (weekdays only), around `close` with a high-low range `range` */
export function syntheticBars(lastDay: string, n: number, close: number, range: number): Bar[] {
  const out: Bar[] = [];
  let t = Date.parse(`${lastDay}T00:00:00Z`);
  while (out.length < n) {
    t -= 86_400_000;
    const d = new Date(t);
    if (d.getUTCDay() === 0 || d.getUTCDay() === 6) continue;
    out.push({ t: d.toISOString().slice(0, 10), o: close, h: close + range / 2, l: close - range / 2, c: close, v: 1000 });
  }
  return out.reverse();
}
