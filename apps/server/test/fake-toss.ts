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
  /** Toss API calls: the client_id the call's token was issued to (null: no such token) */
  client?: string | null;
}

/** Toss's /api/v1/prices has no previous close (openapi.json 1.2.28); `prevClose` is ignored here, kept for Yahoo-shaped calls */
export interface TossQuote {
  price: number;
  prevClose?: number;
  time?: string;
}

/** B2e: one record of GET /api/v1/market-indicators/{KOSPI|KOSDAQ}/investor-trading (openapi 1.2.28), amounts as strings */
export interface FlowRecord {
  date: string;
  updatedAt: string;
  individual: { buyAmount: string; sellAmount: string };
  foreigner: { buyAmount: string; sellAmount: string };
  institution: { buyAmount: string; sellAmount: string; breakdown: Record<string, { buyAmount: string; sellAmount: string }> };
  otherCorporation: { buyAmount: string; sellAmount: string };
}

/**
 * a synthetic record whose foreigners net `foreign` 억원 (individuals and institutions take the other side; the four
 * groups' buys and sells balance, as the openapi says); amounts in won as decimal strings
 */
export function flowRecord(date: string, foreign: number, o: { institution?: number; updatedAt?: string } = {}): FlowRecord {
  const E = 100_000_000;
  const side = (net: number, gross: number) => ({ buyAmount: String(Math.round((gross + net / 2) * E)), sellAmount: String(Math.round((gross - net / 2) * E)) });
  const inst = o.institution ?? Math.round(-foreign / 2);
  const indiv = -foreign - inst;
  return {
    date,
    updatedAt: o.updatedAt ?? `${date}T18:10:00+09:00`,
    individual: side(indiv, 50_000),
    foreigner: side(foreign, 38_000),
    institution: { ...side(inst, 21_000), breakdown: {} },
    otherCorporation: side(0, 4_500),
  };
}

/** B3a: one step of a fake order's life; `filled` and `avg` are the execution so far, `at` its last fill (ms) */
export interface OrderStep {
  status: string;
  filled?: number;
  avg?: number;
  at?: number;
}

/** B3a: how the next POST /api/v1/orders answers: a status with Toss's error body, "drop" (the request fails before
 * Toss), or "lost" (Toss takes the order, the answer never arrives) */
/** drop: no answer and no order; lost: the order is in, no answer; noid: the order is in, a 200 with no order id */
export type OrderAnswer = { status: number; code?: string; message?: string } | "drop" | "lost" | "noid";

export interface FakeOrder {
  orderId: string;
  clientOrderId: string | null;
  body: Record<string, unknown>;
  orderedAt: number;
  plan: OrderStep[];
  /** how many times GET /api/v1/orders/{id} answered (the plan's step shown next) */
  step: number;
}

/** Toss's time strings: ISO 8601 in KST */
export const kstIso = (ms: number) => new Date(ms + 9 * 3_600_000).toISOString().replace("Z", "+09:00");

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
  let orderN = 0;
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
    /** B2d-2b: BEA's ICS; the Bank of Korea's MPC list by its pYear (unset years answer 404) */
    bea: null as string | number | null,
    bok: new Map<string, string | number>(),
    /** B2d-2c: GET /api/v1/stocks per symbol (securityType, Korean name); `tossStocksBy` per client_id first */
    tossStocks: new Map<string, { securityType: string; name: string }>(),
    tossStocksBy: new Map<string, Map<string, { securityType: string; name: string }>>(),
    /** B2e: KOSPI investor-trading records, oldest first here (served newest first, `count` of them); `tossFlowsBy` per client_id first */
    tossFlows: [] as unknown[],
    tossFlowsBy: new Map<string, unknown[]>(),
    /**
     * B3a: orders. POST /api/v1/orders keeps every body here (a BUY too: tests assert none is ever sent) and makes one
     * order per clientOrderId (Toss replays the first result for 10 minutes). GET /api/v1/orders/{id} shows the
     * order's plan one step per GET (the last step stays); GET /api/v1/orders?status=OPEN|CLOSED lists them as they are.
     */
    tossOrders: [] as FakeOrder[],
    /** the next POSTs' answers, first first; none left = the order is taken */
    orderAnswers: [] as OrderAnswer[],
    /** the plan a new order gets (default: PENDING, then FILLED at its quantity and the symbol's price) */
    orderPlan: null as OrderStep[] | null,
    /** the order reads (one order, the list) answer with this status */
    orderReadStatus: null as number | null,
    /** the clock for orderedAt (tests hand it the harness clock) */
    clock: () => Date.now(),
    /** B3a: the next answers of one Toss path, first first (e.g. "/api/v1/sellable-quantity" → [429]); then as usual */
    pathStatus: new Map<string, number[]>(),
    /** B3a: runs as a Toss API call arrives (before its answer): something the person does while Toss is asked */
    onCall: null as null | ((method: string, path: string) => void),
  };

  const OPEN_STATUSES = new Set(["PENDING", "PARTIAL_FILLED", "PENDING_CANCEL", "PENDING_REPLACE"]);
  const stepOf = (o: FakeOrder) => o.plan[Math.min(o.step, o.plan.length - 1)]!;
  const orderJson = (o: FakeOrder) => {
    const st = stepOf(o);
    const kr = /^\d{6}$/.test(String(o.body.symbol));
    const filled = st.filled ?? 0;
    return {
      orderId: o.orderId,
      symbol: o.body.symbol,
      side: o.body.side,
      orderType: o.body.orderType,
      timeInForce: o.body.timeInForce ?? "DAY",
      status: st.status,
      price: null,
      quantity: String(o.body.quantity),
      orderAmount: null,
      currency: kr ? "KRW" : "USD",
      orderedAt: kstIso(o.orderedAt),
      canceledAt: null,
      execution: {
        filledQuantity: String(filled),
        averageFilledPrice: st.avg != null ? String(st.avg) : null,
        filledAmount: st.avg != null ? String(filled * st.avg) : null,
        commission: null,
        tax: null,
        filledAt: st.at != null ? kstIso(st.at) : null,
        settlementDate: null,
      },
    };
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
      calls[calls.length - 1]!.client = tokens.get(bearer) ?? null;
      if (!tokens.has(bearer) || state.tossRevoked.has(bearer)) return json({ error: { code: "invalid_token" } }, 401);
      state.onCall?.(init?.method ?? "GET", url.pathname);
      const once = state.pathStatus.get(url.pathname)?.shift();
      if (once) return json({ error: { code: "x" } }, once);
      // the account surfaces need X-Tossinvest-Account (openapi.json AccountSeq, required); market data does not
      if (["/api/v1/holdings", "/api/v1/sellable-quantity", "/api/v1/buying-power", "/api/v1/orders"].includes(url.pathname) || url.pathname.startsWith("/api/v1/orders/")) {
        const acct = headers.get("x-tossinvest-account");
        if (!acct || !state.tossAccounts.some((a) => String(a.accountSeq) === acct)) return json({ error: { code: "invalid_account" } }, 400);
      }
      if (url.pathname === "/api/v1/accounts") return json({ result: state.tossAccounts });
      if (url.pathname === "/api/v1/orders" && (init?.method ?? "GET") === "POST") {
        const b = JSON.parse(body ?? "{}") as Record<string, unknown>;
        const answer = state.orderAnswers.shift();
        if (answer === "drop") throw new TypeError("fetch failed");
        if (answer && typeof answer === "object") return json({ error: { requestId: "req-fake", code: answer.code ?? "x", message: answer.message ?? "" } }, answer.status);
        const cid = typeof b.clientOrderId === "string" ? b.clientOrderId : null;
        let o = cid ? state.tossOrders.find((x) => x.clientOrderId === cid) : undefined;
        if (!o) {
          const price = state.tossPrices.get(String(b.symbol))?.price ?? 0;
          o = { orderId: `tso-${String(++orderN).padStart(8, "0")}`, clientOrderId: cid, body: b, orderedAt: state.clock(), plan: state.orderPlan ? [...state.orderPlan] : [{ status: "PENDING" }, { status: "FILLED", filled: Number(b.quantity), avg: price, at: state.clock() }], step: 0 };
          state.tossOrders.push(o);
        }
        if (answer === "lost") throw new TypeError("fetch failed");
        if (answer === "noid") return json({ result: { clientOrderId: cid } });
        return json({ result: { orderId: o.orderId, clientOrderId: cid } });
      }
      if (url.pathname.startsWith("/api/v1/orders/")) {
        if (state.orderReadStatus) return json({ error: { code: "x" } }, state.orderReadStatus);
        const o = state.tossOrders.find((x) => x.orderId === decodeURIComponent(url.pathname.slice("/api/v1/orders/".length)));
        if (!o) return json({ error: { code: "order-not-found" } }, 404);
        const out = orderJson(o);
        o.step++;
        return json({ result: out });
      }
      if (url.pathname === "/api/v1/orders") {
        if (state.orderReadStatus) return json({ error: { code: "x" } }, state.orderReadStatus);
        const open = url.searchParams.get("status") === "OPEN";
        const sym = url.searchParams.get("symbol");
        const from = url.searchParams.get("from");
        const orders = state.tossOrders.filter((o) => OPEN_STATUSES.has(stepOf(o).status) === open && (!sym || o.body.symbol === sym) && (!from || kstIso(o.orderedAt).slice(0, 10) >= from)).map(orderJson);
        return json({ result: { orders, nextCursor: null, hasNext: false } });
      }
      if (url.pathname === "/api/v1/buying-power") return json({ result: { currency: "KRW", cashBuyingPower: "1000000" } });
      if (url.pathname === "/api/v1/stocks") {
        const syms = (url.searchParams.get("symbols") ?? "").split(",").filter(Boolean);
        const mine = state.tossStocksBy.get(tokens.get(bearer) ?? "");
        return json({
          result: syms.flatMap((s) => {
            const a = mine?.get(s) ?? state.tossStocks.get(s);
            const kr = /^\d{6}$/.test(s);
            return a ? [{ symbol: s, name: a.name, englishName: s, isinCode: "XX0000000000", market: kr ? "KOSPI" : "NASDAQ", securityType: a.securityType, isCommonShare: true, status: "ACTIVE", currency: kr ? "KRW" : "USD", sharesOutstanding: "1000" }] : [];
          }),
        });
      }
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
      const mi = /^\/api\/v1\/market-indicators\/([^/]+)\/investor-trading$/.exec(url.pathname);
      if (mi) {
        if (mi[1] !== "KOSPI" && mi[1] !== "KOSDAQ") return json({ error: { code: "unsupported-symbol" } }, 400);
        const mine = state.tossFlowsBy.get(tokens.get(bearer) ?? "") ?? state.tossFlows;
        const records = [...mine].reverse().slice(0, Number(url.searchParams.get("count") ?? 10));
        return json({ result: { nextUntil: null, records } });
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
    if (url.host === "www.bea.gov" && url.pathname === "/news/schedule/ics/online-calendar-subscription.ics") return calendar(state.bea, "text/plain");
    if (url.host === "www.bok.or.kr" && url.pathname === "/portal/singl/crncyPolicyDrcMtg/listYear.do")
      return calendar(state.bok.get(url.searchParams.get("pYear") ?? "") ?? null, "text/html");

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
