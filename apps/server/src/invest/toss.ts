/**
 * Toss Securities Open API, read only (agent-runtime 2006 §3; source G1/D6). B1 has no order method at all; B4 adds a
 * stop sell only, never a buy (G8-1).
 *
 * - Off unless PICKLE_TOSS_BASE is set (cfg.invest.tossBase): QA and tests cannot reach the real API.
 * - Keys live in the vault (service `tossinvest`, kind token; envelope fields clientKey, secretKey, accountSeq). They
 *   are opened only to get a token (`vault.access(…, {actor: "system"}).use`, one access record per token, not per
 *   check); the token stays in memory and is fetched again on expiry or one 401 (G1: one live token per client).
 * - 403: asked again once with a new token; the same 403 again = the allowed IP (D6, never "expired": G8-6), and the
 *   person's Toss calls stop until they check again or an hour passes. 401 = auth, 429 = rate_limited (until the next
 *   check), 5xx and timeouts = down.
 * - Bodies, error texts, keys and tokens never reach logs, cards, events or the model: a failure keeps its code alone.
 *
 * The response shapes follow the public openapi.json (1.2.28, read 2026-11-26; test/fake-toss.ts serves the same shapes
 * with synthetic values). The token, and so every read here, is the person's own: it serves their watch only
 * (team-lead 2253).
 */
import type { Bar } from "@pickle/quant";
import type { Core } from "../core.ts";
import type { Market } from "./calendar.ts";

export const TOSS_SERVICE = "tossinvest";
export const TOSS_TIMEOUT_MS = 10_000;
export const TOSS_IP_PAUSE_MS = 3_600_000;

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

interface TokenEntry {
  token: string;
  expiresAt: number;
  account: string;
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

export function readSellable(j: unknown): number | null {
  if (!j || typeof j !== "object") return null;
  const o = j as Record<string, unknown>;
  // openapi.json: {result: {sellableQuantity}}
  const env = o.result ?? o.data;
  const inner = env && typeof env === "object" && !Array.isArray(env) ? (env as Record<string, unknown>) : o;
  const n = num(pick(inner, ["sellableQuantity", "quantity", "qty"]));
  return n != null && n >= 0 ? n : null;
}

export class TossClient {
  private tokens = new Map<string, TokenEntry>();

  constructor(
    private core: Core,
    private fetchFn: typeof fetch,
  ) {}

  base(): string | null {
    return this.core.cfg.invest.tossBase;
  }

  /** drop the in-memory token (the key was deleted or replaced) */
  forget(userId: string): void {
    this.tokens.delete(userId);
  }

  async connected(userId: string): Promise<boolean> {
    try {
      return !!(await this.core.deps.vault.access(userId, { actor: "system" }).find(TOSS_SERVICE));
    } catch {
      return false;
    }
  }

  private async token(userId: string, fresh: boolean): Promise<TossResult<TokenEntry>> {
    const base = this.base();
    if (!base) return { ok: false, error: "off" };
    const have = this.tokens.get(userId);
    if (have && !fresh && have.expiresAt > this.core.now() + 60_000) return { ok: true, value: have };
    const access = this.core.deps.vault.access(userId, { actor: "system" });
    const cred = await access.find(TOSS_SERVICE).catch(() => null);
    if (!cred) return { ok: false, error: "not_connected" };
    let status = 0;
    let entry: TokenEntry | null = null;
    try {
      entry = await access.use(cred.id, { action: "toss_token", purpose: "투자 시세 확인(토스증권 읽기)" }, async (secret) => {
        const body = new URLSearchParams({ grant_type: "client_credentials", client_id: secret.clientKey ?? "", client_secret: secret.secretKey ?? "" });
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
        const ttl = num(j?.expires_in) ?? 3600;
        return { token, expiresAt: this.core.now() + Math.max(60, ttl) * 1000, account: str(secret.accountSeq) ?? "1" };
      });
    } catch {
      return { ok: false, error: "down" };
    }
    if (!entry) return { ok: false, error: status === 403 ? "ip_not_allowed" : status === 429 ? "rate_limited" : status === 401 || status === 400 ? "auth" : "down" };
    this.tokens.set(userId, entry);
    return { ok: true, value: entry };
  }

  private async get(userId: string, path: string): Promise<TossResult<unknown>> {
    const base = this.base();
    if (!base) return { ok: false, error: "off" };
    let fresh = false;
    let lastStatus = 0;
    for (let attempt = 0; attempt < 2; attempt++) {
      const t = await this.token(userId, fresh);
      if (!t.ok) return t;
      let res: Response;
      try {
        res = await this.fetchFn(`${base}${path}`, {
          headers: { authorization: `Bearer ${t.value.token}`, "X-Tossinvest-Account": t.value.account },
          signal: AbortSignal.timeout(TOSS_TIMEOUT_MS),
        });
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
        this.tokens.delete(userId);
        fresh = true;
        continue;
      }
      break;
    }
    if (lastStatus === 403) return { ok: false, error: "ip_not_allowed" };
    if (lastStatus === 401) {
      this.tokens.delete(userId);
      return { ok: false, error: "auth" };
    }
    if (lastStatus === 429) return { ok: false, error: "rate_limited" };
    return { ok: false, error: "down" };
  }

  async prices(userId: string, symbols: string[]): Promise<TossResult<TossPrice[]>> {
    const r = await this.get(userId, `/api/v1/prices?symbols=${symbols.map(encodeURIComponent).join(",")}`);
    return r.ok ? { ok: true, value: readPrices(r.value, this.core.now()) } : r;
  }

  async holdings(userId: string): Promise<TossResult<TossHolding[]>> {
    const r = await this.get(userId, "/api/v1/holdings");
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

  async sellable(userId: string, symbol: string): Promise<TossResult<number | null>> {
    const r = await this.get(userId, `/api/v1/sellable-quantity?symbol=${encodeURIComponent(symbol)}`);
    return r.ok ? { ok: true, value: readSellable(r.value) } : r;
  }
}
