/**
 * Toss Securities Open API (agent-runtime 2006 §3; source G1/D6). Reads, and since B3a one write: `sellStop`, a market
 * sell for the stop executor (orders.ts), never a buy (G8-1). Its order is then read back (`order`, `ordersSince`).
 *
 * - Off unless PICKLE_TOSS_BASE is set (cfg.invest.tossBase): QA and tests cannot reach the real API.
 * - One Toss login in the app (team-lead 0059, agent-runtime 0057): the k-skill connection `toss-investment`
 *   (packages/skills connected/toss.ts; fields clientId, clientSecret), saved from 연결 › 토스증권 or the invest
 *   settings row. The token lives in that login's ConnectionRegistry session (memory only), the same one the agent's
 *   Toss tools read and write (`TossSession`): whichever side asks first, the other uses its token (G1: one live token
 *   per client). The vault is opened only to get a new token (`vault.access(…, {actor: "system"}).use`, one access
 *   record per token, not per check); one request at a time per login here.
 * - The account: GET /api/v1/accounts, the BROKERAGE one, else the first (the k-skill rule), kept in the same session.
 *   Only the account surfaces carry X-Tossinvest-Account (holdings, sellable quantity; openapi.json): market data
 *   (prices, candles, the market calendar) is bearer only.
 * - Reads, 401 and 403: asked again once with a new token (a newer one already in the session counts); the same 403
 *   again = the allowed IP (D6, never "expired": G8-6), and the person's Toss calls stop until they check again or an
 *   hour passes. 401 = auth, 429 = rate_limited (until the next check), 5xx and timeouts = down.
 * - The order (team-lead 2040 5): only a 401 is sent again here, with a new token and the same clientOrderId; every
 *   other answer goes back to the executor as it came (a 403 is never resent).
 * - Bodies, error texts, keys and tokens never reach logs, cards, events or the model: a failure keeps its code alone.
 *
 * The response shapes follow the public openapi.json (1.2.28, read 2026-11-26; test/fake-toss.ts serves the same shapes
 * with synthetic values). The token, and so every read here, is the person's own: it serves their watch and their own
 * stage judgment only (team-lead 2253, 1854).
 */
import type { ConnectionSession } from "@pickle/agent";
import type { Bar } from "@pickle/quant";
import type { TossSession } from "@pickle/skills";
import type { Core } from "../core.ts";
import type { Market } from "./calendar.ts";
import { getSettings } from "./db.ts";

/** the k-skill connection id of 토스증권 (packages/skills connected/toss.ts `TOSS.id`; a test holds them equal) */
export const TOSS_SERVICE = "toss-investment";
/** the token is taken as expired this long before Toss says (the k-skill tools use the same) */
export const TOSS_TOKEN_SKEW_MS = 60_000;
export const TOSS_TIMEOUT_MS = 10_000;
export const TOSS_IP_PAUSE_MS = 3_600_000;
/** B2e: how many daily KOSPI investor records one judgment asks for (indicator 9's 20-day sum, R6's 5 days) */
export const TOSS_FLOW_COUNT = 30;
/** what the vault records a token's use for (team-lead 2040 12): real mode can sell, so it says so */
export const TOSS_PURPOSE_READ = "투자 시세 확인(토스증권 읽기)";
export const TOSS_PURPOSE_REAL = "투자 시세 확인과 손절 주문(토스증권)";

export type TossErrorCode = "ip_not_allowed" | "auth" | "rate_limited" | "down" | "off" | "not_connected";
export type TossResult<T> = { ok: true; value: T } | { ok: false; error: TossErrorCode };

export interface TossPrice {
  symbol: string;
  price: number;
  prevClose: number | null;
  at: number;
}

export interface TossHolding {
  symbol: string;
  qty: number;
  avgPrice: number | null;
}

/** a person's Toss login as a server job sees it: its vault row and its session (no secret) */
interface TossLogin {
  credentialId: string;
  session: ConnectionSession;
}

const num = (x: unknown): number | null => {
  const n = typeof x === "string" && x.trim() ? Number(x) : x;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
};
const str = (x: unknown): string | null => (typeof x === "string" && x.trim() ? x.trim() : null);
const pick = (o: Record<string, unknown>, keys: string[]): unknown => {
  for (const k of keys) if (o[k] !== undefined && o[k] !== null) return o[k];
  return undefined;
};

/** the list inside a response: the body itself, or its data / result / items / prices / holdings field */
function listOf(j: unknown): Record<string, unknown>[] {
  const arr = Array.isArray(j) ? j : j && typeof j === "object" ? pick(j as Record<string, unknown>, ["data", "result", "items", "prices", "holdings"]) : null;
  if (Array.isArray(arr)) return arr.filter((x): x is Record<string, unknown> => !!x && typeof x === "object");
  if (arr && typeof arr === "object") return listOf(arr);
  return [];
}

export function readPrices(j: unknown, now: number): TossPrice[] {
  const out: TossPrice[] = [];
  for (const it of listOf(j)) {
    const symbol = str(pick(it, ["symbol", "code", "ticker"]));
    const price = num(pick(it, ["price", "currentPrice", "lastPrice", "close"]));
    if (!symbol || price == null || price <= 0) continue;
    const t = pick(it, ["time", "timestamp", "tradedAt", "updatedAt"]);
    const at = typeof t === "number" ? (t < 1e12 ? t * 1000 : t) : typeof t === "string" && Number.isFinite(Date.parse(t)) ? Date.parse(t) : now;
    out.push({ symbol: symbol.toUpperCase(), price, prevClose: num(pick(it, ["prevClose", "previousClose", "basePrice"])), at });
  }
  return out;
}

/** GET /api/v1/stocks?symbols= (openapi 1.2.28 StockInfo): each symbol's securityType and Korean name */
export function readStocks(j: unknown): Map<string, { type: string; name: string | null }> {
  const out = new Map<string, { type: string; name: string | null }>();
  for (const it of listOf(j)) {
    const symbol = str(it.symbol);
    const type = str(it.securityType);
    if (symbol && type) out.set(symbol.toUpperCase(), { type: type.toUpperCase(), name: str(it.name) });
  }
  return out;
}

export function readHoldings(j: unknown): TossHolding[] {
  const out: TossHolding[] = [];
  for (const it of listOf(j)) {
    const symbol = str(pick(it, ["symbol", "code", "ticker"]));
    const qty = num(pick(it, ["quantity", "qty", "holdingQuantity"]));
    if (!symbol || qty == null || qty < 0) continue;
    out.push({ symbol: symbol.toUpperCase(), qty, avgPrice: num(pick(it, ["averagePurchasePrice", "averagePrice", "avgPrice"])) });
  }
  return out;
}

const rec = (x: unknown): Record<string, unknown> | null => (x && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, unknown>) : null);
const instant = (x: unknown): number | null => {
  const t = typeof x === "string" ? Date.parse(x) : NaN;
  return Number.isFinite(t) ? t : null;
};

/** GET /api/v1/candles?interval=1d → {result: {candles (newest first), nextBefore}}; here oldest first, one bar a day,
 * `t` the trading day (the timestamp's own date: local midnight) */
export function readCandles(j: unknown): Bar[] {
  const list = rec(rec(j)?.result)?.candles;
  const out: Bar[] = [];
  for (const it of Array.isArray(list) ? list : []) {
    const c = rec(it);
    const ts = str(c?.timestamp);
    const close = num(c?.closePrice);
    if (!c || !ts || !/^\d{4}-\d{2}-\d{2}T/.test(ts) || close == null || close <= 0) continue;
    out.push({ t: ts.slice(0, 10), o: num(c.openPrice) ?? close, h: num(c.highPrice) ?? close, l: num(c.lowPrice) ?? close, c: close, v: num(c.volume) ?? 0 });
  }
  out.sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
  return out.filter((b, i) => i === 0 || b.t !== out[i - 1]!.t);
}

export interface TossMarketDay {
  date: string;
  /** the regular session (null: closed that day) */
  session: { open: number; close: number } | null;
}

/**
 * GET /api/v1/market-calendar/{US|KR}?date= → {result: {today, previousBusinessDay, nextBusinessDay}}. US: `today.
 * regularMarket` (null when closed). KR: `today.integrated.regularMarket` (the KRX+NXT union); KRX is closed when it is
 * null or its closing auction (`singlePriceAuctionStartTime`, KRX only) is null. A shape it cannot read → null.
 */
export function readMarketDay(market: Market, j: unknown): TossMarketDay | null {
  const t = rec(rec(rec(j)?.result)?.today);
  const date = str(t?.date);
  if (!t || !date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  let reg: unknown;
  if (market === "US") reg = t.regularMarket;
  else {
    if (t.integrated === null) return { date, session: null };
    const ig = rec(t.integrated);
    if (!ig || !("regularMarket" in ig)) return null;
    reg = ig.regularMarket;
    if (rec(reg) && rec(reg)!.singlePriceAuctionStartTime === null) return { date, session: null };
  }
  if (reg === null) return { date, session: null };
  const open = instant(rec(reg)?.startTime);
  const close = instant(rec(reg)?.endTime);
  return open != null && close != null ? { date, session: { open, close } } : null;
}

/** B2e: one KOSPI day of investors' trading, net (buy − sell) in won per group */
export interface TossFlowDay {
  day: string;
  individual: number | null;
  foreign: number;
  institution: number | null;
}

/** a won amount: a whole number (openapi: a decimal string, KRW), never negative */
const won = (x: unknown): number | null => {
  if (typeof x === "string") return /^\d{1,16}$/.test(x.trim()) ? Number(x.trim()) : null;
  return typeof x === "number" && Number.isSafeInteger(x) && x >= 0 ? x : null;
};
const netOf = (x: unknown): number | null => {
  const buy = won(rec(x)?.buyAmount);
  const sell = won(rec(x)?.sellAmount);
  return buy != null && sell != null ? buy - sell : null;
};

/**
 * GET /api/v1/market-indicators/KOSPI/investor-trading?interval=1d → {result: {records (newest first), nextUntil}}
 * (openapi 1.2.28 InvestorTradingRecord: buy and sell amounts per investor group, KRW); here oldest first, one record
 * a day, net per group. A record without a day or without foreigners' two amounts is left out.
 */
export function readInvestorTrading(j: unknown): TossFlowDay[] {
  const list = rec(rec(j)?.result)?.records;
  const out: TossFlowDay[] = [];
  for (const it of Array.isArray(list) ? list : []) {
    const r = rec(it);
    const day = str(r?.date);
    const foreign = netOf(r?.foreigner);
    if (!r || !day || !/^\d{4}-\d{2}-\d{2}$/.test(day) || foreign == null) continue;
    out.push({ day, individual: netOf(r.individual), foreign, institution: netOf(r.institution) });
  }
  out.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  return out.filter((d, i) => i === 0 || d.day !== out[i - 1]!.day);
}

export function readSellable(j: unknown): number | null {
  if (!j || typeof j !== "object") return null;
  const o = j as Record<string, unknown>;
  // openapi.json: {result: {sellableQuantity}}
  const env = o.result ?? o.data;
  const inner = env && typeof env === "object" && !Array.isArray(env) ? (env as Record<string, unknown>) : o;
  const n = num(pick(inner, ["sellableQuantity", "quantity", "qty"]));
  return n != null && n >= 0 ? n : null;
}

/** B3a: what sellStop answers; `message` is Toss's own text for a rejection, one line */
export type TossOrderError = TossErrorCode | "lost" | "in_progress" | "rejected" | "server";
/** `posted`: the orders POST was made (answered, or not: it may be in); false when the login, account or token failed first */
export type TossOrderResult = { ok: true; orderId: string } | { ok: false; error: TossOrderError; message?: string; posted: boolean };

/** B3a: one order as GET /api/v1/orders(/{id}) gives it (openapi 1.2.28); quantities and prices as numbers */
export interface TossOrder {
  orderId: string;
  symbol: string | null;
  side: string | null;
  orderType: string | null;
  status: string;
  qty: number | null;
  filledQty: number;
  avgPrice: number | null;
  orderedAt: number | null;
  filledAt: number | null;
}

export function readOrder(x: unknown): TossOrder | null {
  const o = rec(x);
  const orderId = str(o?.orderId);
  const status = str(o?.status);
  if (!o || !orderId || !status) return null;
  const e = rec(o.execution);
  const filled = num(e?.filledQuantity);
  return {
    orderId,
    symbol: str(o.symbol),
    side: str(o.side),
    orderType: str(o.orderType),
    status,
    qty: num(o.quantity),
    filledQty: filled != null && filled > 0 ? filled : 0,
    avgPrice: num(e?.averageFilledPrice),
    orderedAt: instant(o.orderedAt),
    filledAt: instant(e?.filledAt),
  };
}

/** GET /api/v1/orders → {result: {orders, nextCursor, hasNext}} */
export function readOrders(j: unknown): TossOrder[] {
  const list = rec(rec(j)?.result)?.orders;
  return Array.isArray(list) ? list.map(readOrder).filter((o): o is TossOrder => !!o) : [];
}

/** a character a card line must not carry: controls, line and paragraph separators, direction marks, the BOM */
function unsafeChar(c: number): boolean {
  return c < 32 || (c >= 127 && c < 160) || c === 0x061c || c === 0x200e || c === 0x200f || c === 0x2028 || c === 0x2029 || (c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069) || c === 0xfeff;
}

/** Toss's text for a card: one line, safe characters only, at most 120 of them (none: undefined) */
export function oneLine(s: string | null): string | undefined {
  if (!s) return undefined;
  let out = "";
  for (const ch of s) out += unsafeChar(ch.codePointAt(0)!) ? " " : ch;
  out = out.replace(/\s+/g, " ").trim();
  if (!out) return undefined;
  const chars = [...out];
  return chars.length > 120 ? `${chars.slice(0, 119).join("")}…` : out;
}

export class TossClient {
  /** a token request in flight, per login (several reads in one check share it) */
  private issuing = new Map<string, Promise<TossResult<string>>>();
  /** an account lookup in flight, per login */
  private finding = new Map<string, Promise<TossResult<string>>>();

  constructor(
    private core: Core,
    private fetchFn: typeof fetch,
  ) {}

  base(): string | null {
    return this.core.cfg.invest.tossBase;
  }

  /** the login went away: its session (token, account) goes, the agent's tools' copy with it */
  forget(userId: string): void {
    try {
      this.core.connections.forget(userId, TOSS_SERVICE);
    } catch {
      /* nothing cached */
    }
  }

  async connected(userId: string): Promise<boolean> {
    try {
      return !!(await this.core.deps.vault.access(userId, { actor: "system" }).find(TOSS_SERVICE));
    } catch {
      return false;
    }
  }

  private async login(userId: string): Promise<TossLogin | null> {
    try {
      return await this.core.connections.sessionFor(userId, TOSS_SERVICE);
    } catch {
      return null;
    }
  }

  /**
   * The login's live token: the session's (whoever got it), else a new one. `stale`: the token a call was just refused
   * with: a different one already in the session is used as the new token; the same one is asked for again.
   */
  private async token(userId: string, login: TossLogin, stale: string | null): Promise<TossResult<string>> {
    const have = login.session.get<TossSession>();
    if (have?.token && have.token !== stale) return { ok: true, value: have.token };
    const key = `${userId}\u0000${login.credentialId}`;
    const busy = this.issuing.get(key);
    if (busy) return busy;
    const p = this.issue(userId, login).finally(() => this.issuing.delete(key));
    this.issuing.set(key, p);
    return p;
  }

  private async issue(userId: string, login: TossLogin): Promise<TossResult<string>> {
    const base = this.base();
    if (!base) return { ok: false, error: "off" };
    let status = 0;
    let got: { token: string; ttl: number } | null = null;
    try {
      got = await this.core.deps.vault.access(userId, { actor: "system" }).use(login.credentialId, { action: "toss_token", purpose: getSettings(this.core.db, userId)?.mode === "real" ? TOSS_PURPOSE_REAL : TOSS_PURPOSE_READ }, async (secret) => {
        const clientId = (secret.clientId ?? "").trim();
        const clientSecret = (secret.clientSecret ?? "").trim();
        // an empty field is the person's to fix: no request with it
        if (!clientId || !clientSecret) {
          status = 401;
          return null;
        }
        const body = new URLSearchParams({ grant_type: "client_credentials", client_id: clientId, client_secret: clientSecret });
        const res = await this.fetchFn(`${base}/oauth2/token`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body,
          signal: AbortSignal.timeout(TOSS_TIMEOUT_MS),
        });
        status = res.status;
        if (!res.ok) {
          await res.body?.cancel().catch(() => undefined);
          return null;
        }
        const j = (await res.json().catch(() => null)) as Record<string, unknown> | null;
        const token = str(j?.access_token);
        if (!token) return null;
        const ttl = Math.max(60_000, (num(j?.expires_in) ?? 3600) * 1000 - TOSS_TOKEN_SKEW_MS);
        return { token, ttl };
      });
    } catch {
      return { ok: false, error: "down" };
    }
    if (!got) return { ok: false, error: status === 403 ? "ip_not_allowed" : status === 429 ? "rate_limited" : status === 401 || status === 400 ? "auth" : "down" };
    // the session expires it (the registry's clock); `exp` is wall-clock ms, as the k-skill tools compare it
    const prev = login.session.get<TossSession>();
    login.session.set({ token: got.token, exp: Date.now() + got.ttl, accountSeq: prev?.accountSeq } satisfies TossSession, got.ttl);
    return { ok: true, value: got.token };
  }

  /** a refused token leaves the session (the account stays), so neither side sends it again */
  private drop(login: TossLogin, token: string): void {
    const cur = login.session.get<TossSession>();
    if (cur?.token === token) login.session.set({ token: "", exp: 0, accountSeq: cur.accountSeq } satisfies TossSession, 1000);
  }

  /** the account the person's account reads go to: the session's, else GET /api/v1/accounts (BROKERAGE, else the first) */
  private async account(userId: string, login: TossLogin): Promise<TossResult<string>> {
    const seq = login.session.get<TossSession>()?.accountSeq;
    if (seq) return { ok: true, value: seq };
    const key = `${userId}\u0000${login.credentialId}`;
    const busy = this.finding.get(key);
    if (busy) return busy;
    const p = this.findAccount(userId, login).finally(() => this.finding.delete(key));
    this.finding.set(key, p);
    return p;
  }

  private async findAccount(userId: string, login: TossLogin): Promise<TossResult<string>> {
    const r = await this.send(userId, login, "/api/v1/accounts", null);
    if (!r.ok) return r;
    const list = Array.isArray(rec(r.value)?.result) ? (rec(r.value)!.result as unknown[]).map(rec).filter((a): a is Record<string, unknown> => !!a) : [];
    const pick = list.find((a) => a.accountType === "BROKERAGE") ?? list[0];
    const raw = pick?.accountSeq;
    const seq = typeof raw === "number" && Number.isFinite(raw) ? String(raw) : str(raw);
    if (!seq) return { ok: false, error: "down" };
    const cur = login.session.get<TossSession>();
    // kept with the live token (an account with no token would outlive the login's next sign-in check)
    if (cur?.token) login.session.set({ ...cur, accountSeq: seq } satisfies TossSession, Math.max(1000, cur.exp - Date.now()));
    return { ok: true, value: seq };
  }

  private async get(userId: string, path: string, o: { account?: boolean } = {}): Promise<TossResult<unknown>> {
    if (!this.base()) return { ok: false, error: "off" };
    const login = await this.login(userId);
    if (!login) return { ok: false, error: "not_connected" };
    let account: string | null = null;
    if (o.account) {
      const a = await this.account(userId, login);
      if (!a.ok) return a;
      account = a.value;
    }
    return this.send(userId, login, path, account);
  }

  private async send(userId: string, login: TossLogin, path: string, account: string | null): Promise<TossResult<unknown>> {
    const base = this.base();
    if (!base) return { ok: false, error: "off" };
    let stale: string | null = null;
    let lastStatus = 0;
    for (let attempt = 0; attempt < 2; attempt++) {
      const t = await this.token(userId, login, stale);
      if (!t.ok) return t;
      let res: Response;
      try {
        const headers: Record<string, string> = { authorization: `Bearer ${t.value}` };
        if (account) headers["X-Tossinvest-Account"] = account;
        res = await this.fetchFn(`${base}${path}`, { headers, signal: AbortSignal.timeout(TOSS_TIMEOUT_MS) });
      } catch {
        return { ok: false, error: "down" };
      }
      lastStatus = res.status;
      if (res.ok) {
        const j = await res.json().catch(() => undefined);
        return j === undefined ? { ok: false, error: "down" } : { ok: true, value: j };
      }
      await res.body?.cancel().catch(() => undefined);
      // 401 and 403: once more with a new token (D6: the same 403 with old and new tokens = the allowed IP)
      if ((res.status === 401 || res.status === 403) && attempt === 0) {
        stale = t.value;
        continue;
      }
      // the new token refused too: the app's key is (401), so neither side sends that token again
      if (res.status === 401) this.drop(login, t.value);
      break;
    }
    if (lastStatus === 403) return { ok: false, error: "ip_not_allowed" };
    if (lastStatus === 401) return { ok: false, error: "auth" };
    if (lastStatus === 429) return { ok: false, error: "rate_limited" };
    return { ok: false, error: "down" };
  }

  async prices(userId: string, symbols: string[]): Promise<TossResult<TossPrice[]>> {
    const r = await this.get(userId, `/api/v1/prices?symbols=${symbols.map(encodeURIComponent).join(",")}`);
    return r.ok ? { ok: true, value: readPrices(r.value, this.core.now()) } : r;
  }

  /** B2d-2c: the stock info of this person's own watched symbols, asked with this person's token only */
  async stocks(userId: string, symbols: string[]): Promise<TossResult<Map<string, { type: string; name: string | null }>>> {
    const r = await this.get(userId, `/api/v1/stocks?symbols=${symbols.map(encodeURIComponent).join(",")}`);
    return r.ok ? { ok: true, value: readStocks(r.value) } : r;
  }

  async holdings(userId: string): Promise<TossResult<TossHolding[]>> {
    const r = await this.get(userId, "/api/v1/holdings", { account: true });
    return r.ok ? { ok: true, value: readHoldings(r.value) } : r;
  }

  /** this person's daily candles (200 trading days) */
  async candles(userId: string, symbol: string): Promise<TossResult<Bar[]>> {
    const r = await this.get(userId, `/api/v1/candles?symbol=${encodeURIComponent(symbol)}&interval=1d&count=200`);
    return r.ok ? { ok: true, value: readCandles(r.value) } : r;
  }

  /** the market calendar for `date` (YYYY-MM-DD, the market's own date), asked with this person's token */
  async marketDay(userId: string, market: Market, date: string): Promise<TossResult<TossMarketDay | null>> {
    const r = await this.get(userId, `/api/v1/market-calendar/${market}?date=${encodeURIComponent(date)}`);
    return r.ok ? { ok: true, value: readMarketDay(market, r.value) } : r;
  }

  /**
   * B2e (team-lead 1854): KOSPI investors' daily trading, the last TOSS_FLOW_COUNT records, asked with this person's
   * token for their own judgment. KOSPI only: indicator 9 and R6 read KOSPI.
   */
  async investorTrading(userId: string): Promise<TossResult<TossFlowDay[]>> {
    const r = await this.get(userId, `/api/v1/market-indicators/KOSPI/investor-trading?interval=1d&count=${TOSS_FLOW_COUNT}`);
    return r.ok ? { ok: true, value: readInvestorTrading(r.value) } : r;
  }

  async sellable(userId: string, symbol: string): Promise<TossResult<number | null>> {
    const r = await this.get(userId, `/api/v1/sellable-quantity?symbol=${encodeURIComponent(symbol)}`, { account: true });
    return r.ok ? { ok: true, value: readSellable(r.value) } : r;
  }

  /**
   * B3a: the one Toss write (G8-1): a market sell of `quantity` shares, good for the day, for the stop executor
   * (orders.ts) alone. There is no side argument: the body's side is the SELL literal below and nothing else.
   * - 401: once more with a new token and the same clientOrderId (Toss had refused the token, not the order).
   * - Anything else goes back to the executor as it came: 403 the allowed IP, 429 rate_limited, 5xx server, 409
   *   request-in-progress in_progress, other 4xx rejected (with Toss's message as one line), no answer lost.
   */
  async sellStop(userId: string, o: { symbol: string; quantity: string; clientOrderId: string }): Promise<TossOrderResult> {
    const base = this.base();
    if (!base) return { ok: false, error: "off", posted: false };
    const login = await this.login(userId);
    if (!login) return { ok: false, error: "not_connected", posted: false };
    const a = await this.account(userId, login);
    if (!a.ok) return { ...a, posted: false };
    const body = JSON.stringify({ clientOrderId: o.clientOrderId, symbol: o.symbol, side: "SELL", orderType: "MARKET", timeInForce: "DAY", quantity: o.quantity });
    let stale: string | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const t = await this.token(userId, login, stale);
      // a second token after a 401: the first POST was made (and refused)
      if (!t.ok) return { ...t, posted: attempt > 0 };
      let res: Response;
      try {
        res = await this.fetchFn(`${base}/api/v1/orders`, {
          method: "POST",
          headers: { authorization: `Bearer ${t.value}`, "X-Tossinvest-Account": a.value, "content-type": "application/json" },
          body,
          signal: AbortSignal.timeout(TOSS_TIMEOUT_MS),
        });
      } catch {
        return { ok: false, error: "lost", posted: true };
      }
      if (res.ok) {
        const j = await res.json().catch(() => undefined);
        const id = str(rec(rec(j)?.result)?.orderId);
        // a 200 with no order id: the order may be in; the executor sends it once more with the same id
        return id ? { ok: true, orderId: id } : { ok: false, error: "lost", posted: true };
      }
      const err = rec(rec(await res.json().catch(() => null))?.error);
      if (res.status === 401 && attempt === 0) {
        stale = t.value;
        continue;
      }
      if (res.status === 401) {
        this.drop(login, t.value);
        return { ok: false, error: "auth", posted: true };
      }
      if (res.status === 403) return { ok: false, error: "ip_not_allowed", posted: true };
      if (res.status === 429) return { ok: false, error: "rate_limited", posted: true };
      if (res.status >= 500) return { ok: false, error: "server", posted: true };
      if (res.status === 409 && str(err?.code) === "request-in-progress") return { ok: false, error: "in_progress", posted: true };
      const message = oneLine(str(err?.message));
      return { ok: false, error: "rejected", posted: true, ...(message ? { message } : {}) };
    }
    return { ok: false, error: "auth", posted: true };
  }

  /** B3a: one order of this person's, by Toss's order id (null: Toss sent no order back) */
  async order(userId: string, orderId: string): Promise<TossResult<TossOrder | null>> {
    const r = await this.get(userId, `/api/v1/orders/${encodeURIComponent(orderId)}`, { account: true });
    return r.ok ? { ok: true, value: readOrder(rec(r.value)?.result) } : r;
  }

  /** B3a: this person's orders of one symbol placed since `day` (YYYY-MM-DD, KST), open and ended, for an order with no answer */
  async ordersSince(userId: string, symbol: string, day: string): Promise<TossResult<TossOrder[]>> {
    const q = `symbol=${encodeURIComponent(symbol)}&from=${encodeURIComponent(day)}`;
    const open = await this.get(userId, `/api/v1/orders?status=OPEN&${q}`, { account: true });
    if (!open.ok) return open;
    const closed = await this.get(userId, `/api/v1/orders?status=CLOSED&${q}&limit=100`, { account: true });
    if (!closed.ok) return closed;
    return { ok: true, value: [...readOrders(open.value), ...readOrders(closed.value)] };
  }
}
