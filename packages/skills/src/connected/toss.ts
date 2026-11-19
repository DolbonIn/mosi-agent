/**
 * 토스증권 Open API, read-only, with the owner's own console app (OAuth 2.0 client credentials).
 *
 * Ported from NomaDamas/k-skill `packages/toss-investment/src/official-client.js` (MIT): the fixed official origin,
 * the client-credentials token with a 60 s expiry skew, one token re-issue on 401, Retry-After on 429, the
 * account header only on account/asset/order surfaces, and NO order mutation (no place/modify/cancel). Response shapes
 * follow the public spec https://openapi.tossinvest.com/openapi-docs/latest/openapi.json (v1.2.28).
 */
import type { ConnectionHandle, ConnectionServiceContext } from "@pickle/agent";
import type { ResultListCard } from "@pickle/protocol";
import { needsConnection } from "@pickle/agent";
import { proxyGet } from "../http";
import { defineSkill, failText, schema, str, type SkillConnection } from "../util";
import { directRequest, fromDirect, last4, parseJson, pause, verifyFailure, verifyKey, type UpstreamFailure, type VerifyResult } from "../direct";

export const TOSS_ORIGIN = "https://openapi.tossinvest.com";
const ORIGINS = [TOSS_ORIGIN] as const;
const SKEW_MS = 60_000;

export const TOSS: SkillConnection = {
  id: "toss-investment",
  name: "토스증권",
  reason: "토스증권 계좌와 시세를 보려면 토스증권 연결이 필요해요",
};

interface TossSession {
  token: string;
  exp: number;
  accountSeq?: string;
}

/** what the HTTP helpers need from a ConnectionHandle (verify() builds one from its own secret + session) */
type TossConn = Pick<ConnectionHandle, "secret" | "session" | "credentialId">;

type TossOk<T> = { ok: true; body: T };
type TossOut<T> = TossOk<T> | { ok: false; error: UpstreamFailure };

const secretOf = (s: Readonly<Record<string, string>>) => ({ clientId: (s.clientId ?? "").trim(), clientSecret: (s.clientSecret ?? "").trim() });

// single flight per connection session: parallel calls in one run (prices + stocks, holdings + buying power) share
// one token request and one account lookup
const issuing = new WeakMap<object, Promise<TossOut<string>>>();
const discovering = new WeakMap<object, Promise<TossOut<string>>>();

function issueToken(secret: Readonly<Record<string, string>>, session: ConnectionHandle["session"], signal: AbortSignal): Promise<TossOut<string>> {
  const busy = issuing.get(session);
  if (busy) return busy;
  const p = requestToken(secret, session, signal).finally(() => issuing.delete(session));
  issuing.set(session, p);
  return p;
}

async function requestToken(secret: Readonly<Record<string, string>>, session: ConnectionHandle["session"], signal: AbortSignal): Promise<TossOut<string>> {
  const { clientId, clientSecret } = secretOf(secret);
  if (!clientId || !clientSecret) return { ok: false, error: { kind: "auth", message: "토스증권 client_id/client_secret이 비어 있어요" } };
  const body = new URLSearchParams({ grant_type: "client_credentials", client_id: clientId, client_secret: clientSecret }).toString();
  const r = await directRequest({
    url: `${TOSS_ORIGIN}/oauth2/token`,
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body,
    origins: ORIGINS,
    signal,
  });
  if (!r.ok) return { ok: false, error: fromDirect(r.error, "토스증권") };
  const j = parseJson(r.res.text) as { access_token?: string; expires_in?: number; error?: string } | null | undefined;
  if (r.res.status === 400 || r.res.status === 401 || r.res.status === 403) {
    return { ok: false, error: { kind: "auth", status: r.res.status, code: j?.error, message: "토스증권이 앱 키(client_id/secret)를 거절했어요" } };
  }
  if (r.res.status === 429) return { ok: false, error: { kind: "rate", status: 429, message: "토스증권 요청 한도를 넘었어요. 잠시 후 다시 해 주세요" } };
  if (r.res.status !== 200 || !j?.access_token) return { ok: false, error: { kind: "upstream", status: r.res.status, message: "토스증권 인증 서버 응답이 올바르지 않아요" } };
  const ttl = Math.max(60_000, (Number(j.expires_in) || 3600) * 1000 - SKEW_MS);
  const prev = session.get<TossSession>();
  session.set({ token: j.access_token, exp: Date.now() + ttl, accountSeq: prev?.accountSeq } satisfies TossSession, ttl);
  return { ok: true, body: j.access_token };
}

async function token(conn: TossConn, signal: AbortSignal, force = false): Promise<TossOut<string>> {
  const s = conn.session.get<TossSession>();
  if (!force && s?.token && s.exp > Date.now()) return { ok: true, body: s.token };
  return issueToken(conn.secret, conn.session, signal);
}

/** GET a read-only endpoint. `account: true` adds X-Tossinvest-Account (discovered from /api/v1/accounts). */
export async function tossGet<T>(conn: TossConn, path: string, query: Record<string, string | undefined>, signal: AbortSignal, o: { account?: boolean } = {}): Promise<TossOut<T>> {
  let account: string | undefined;
  if (o.account) {
    const a = await accountSeq(conn, signal);
    if (!a.ok) return a;
    account = a.body;
  }
  const qs = new URLSearchParams(Object.entries(query).filter((e): e is [string, string] => typeof e[1] === "string" && e[1] !== "")).toString();
  const url = `${TOSS_ORIGIN}${path}${qs ? `?${qs}` : ""}`;
  let reissued = false;
  let waited = false;
  for (;;) {
    const t = await token(conn, signal, false);
    if (!t.ok) return t;
    const headers: Record<string, string> = { Authorization: `Bearer ${t.body}`, Accept: "application/json" };
    if (account) headers["X-Tossinvest-Account"] = account;
    const r = await directRequest({ url, headers, origins: ORIGINS, signal, limit: { key: `toss:${conn.credentialId}`, burst: 8, refill: 60, windowMs: 60_000 } });
    if (!r.ok) return { ok: false, error: fromDirect(r.error, "토스증권") };
    const j = parseJson(r.res.text) as { result?: T; error?: { code?: string; message?: string } } | null | undefined;
    if (r.res.status === 200 && j && "result" in j) return { ok: true, body: j.result as T };
    if (r.res.status === 401) {
      // expired / revoked token: drop it and issue once more; a second 401 means the app itself is refused
      const prev = conn.session.get<TossSession>();
      conn.session.set({ token: "", exp: 0, accountSeq: prev?.accountSeq } satisfies TossSession, 1000);
      if (!reissued) {
        reissued = true;
        const again = await issueToken(conn.secret, conn.session, signal);
        if (!again.ok) return again;
        continue;
      }
      return { ok: false, error: { kind: "auth", status: 401, code: j?.error?.code, message: "토스증권이 앱 키를 거절했어요" } };
    }
    if (r.res.status === 429 && !waited) {
      const ra = Number(r.res.headers.get("retry-after") ?? r.res.headers.get("x-ratelimit-reset"));
      if (Number.isFinite(ra) && ra >= 0 && ra <= 3) {
        waited = true;
        await pause(ra * 1000, signal);
        continue;
      }
    }
    if (r.res.status === 429) return { ok: false, error: { kind: "rate", status: 429, message: "토스증권 요청 한도를 넘었어요. 잠시 후 다시 해 주세요" } };
    const msg = str(j?.error?.message, 120);
    if (r.res.status === 403) return { ok: false, error: { kind: "upstream", status: 403, code: j?.error?.code, message: msg || "이 앱에 해당 조회 권한이 없어요(토스증권 콘솔에서 권한 확인)" } };
    if (r.res.status === 400 || r.res.status === 404) return { ok: false, error: { kind: "input", status: r.res.status, code: j?.error?.code, message: msg || "토스증권이 요청 값을 받지 않았어요" } };
    return { ok: false, error: { kind: "upstream", status: r.res.status, code: j?.error?.code, message: msg || "토스증권 서버 응답이 원활하지 않아요" } };
  }
}

interface TossAccount {
  accountNo?: string;
  accountSeq?: number | string;
  accountType?: string;
}

function accounts(conn: TossConn, signal: AbortSignal): Promise<TossOut<TossAccount[]>> {
  return tossGet<TossAccount[]>(conn, "/api/v1/accounts", {}, signal);
}

async function accountSeq(conn: TossConn, signal: AbortSignal): Promise<TossOut<string>> {
  const s = conn.session.get<TossSession>();
  if (s?.accountSeq) return { ok: true, body: s.accountSeq };
  const busy = discovering.get(conn.session);
  if (busy) return busy;
  const p = discoverAccount(conn, signal).finally(() => discovering.delete(conn.session));
  discovering.set(conn.session, p);
  return p;
}

async function discoverAccount(conn: TossConn, signal: AbortSignal): Promise<TossOut<string>> {
  const a = await accounts(conn, signal);
  if (!a.ok) return a;
  const list = Array.isArray(a.body) ? a.body : [];
  const pick = list.find((x) => x.accountType === "BROKERAGE") ?? list[0];
  if (!pick || pick.accountSeq === undefined || pick.accountSeq === null) return { ok: false, error: { kind: "input", message: "토스증권 계좌를 찾지 못했어요" } };
  const seq = String(pick.accountSeq);
  const cur = conn.session.get<TossSession>();
  if (cur?.token) conn.session.set({ ...cur, accountSeq: seq } satisfies TossSession, Math.max(1000, cur.exp - Date.now()));
  return { ok: true, body: seq };
}

/** connect-time check: a token, then the account list (label = masked account number) */
export async function verifyToss(secret: Readonly<Record<string, string>>, x: ConnectionServiceContext): Promise<VerifyResult> {
  const t = await issueToken(secret, x.session, x.signal);
  if (!t.ok) return verifyFailure(t.error, "토스증권이 client_id/client_secret을 받지 않았어요. 콘솔에서 발급한 값을 확인해 주세요.");
  const a = await accounts({ secret, session: x.session, credentialId: verifyKey(secret.clientId ?? "") }, x.signal);
  if (!a.ok) return { ok: true, accountLabel: "토스증권" }; // the app works; account APIs may need extra console permission
  const pick = a.body.find((v) => v.accountType === "BROKERAGE") ?? a.body[0];
  return { ok: true, accountLabel: pick?.accountNo ? `토스증권 ${last4(pick.accountNo)}` : "토스증권" };
}

// ───────────────────────────── formatting ─────────────────────────────

const n = (v: unknown): number | null => {
  const x = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : Number.NaN;
  return Number.isFinite(x) ? x : null;
};

export function money(v: unknown, currency: string | undefined): string {
  const x = n(v);
  if (x === null) return "-";
  if (currency === "USD") return `$${x.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return `${Math.round(x).toLocaleString("en-US")}원`;
}

const pct = (rate: unknown): string => {
  const x = n(rate);
  if (x === null) return "";
  const p = Math.round(x * 1000) / 10;
  return `${p > 0 ? "+" : ""}${p}%`;
};

function failed(e: UpstreamFailure, conn: ConnectionHandle) {
  if (e.kind === "auth") {
    conn.session.clear();
    return needsConnection(TOSS.id, TOSS.name, "토스증권이 연결 정보를 받지 않았어요. 콘솔에서 발급한 client_id/secret으로 다시 연결해 주세요.");
  }
  return failText(`토스증권: ${e.message}`, e.kind);
}

// ───────────────────────────── symbol resolution ─────────────────────────────

/** "삼성전자" → "005930" through the k-skill KRX search (query only); codes and US tickers pass through */
async function resolveSymbols(input: string, signal: AbortSignal): Promise<{ symbols: string[]; unknown: string[] }> {
  const parts = input
    .split(/[,，\n]/)
    .map((p) => p.trim())
    .filter(Boolean)
    .slice(0, 5);
  const symbols: string[] = [];
  const unknown: string[] = [];
  for (const p of parts) {
    if (/^\d{6}$/.test(p) || /^[A-Za-z][A-Za-z.]{0,6}$/.test(p)) {
      symbols.push(/^\d/.test(p) ? p : p.toUpperCase());
      continue;
    }
    const r = await proxyGet<{ items?: { code?: string; short_name?: string; name?: string; stock_kind?: string }[] }>("/v1/korean-stock/search", { q: p, limit: 5 }, signal);
    const items = r.ok ? (r.body.items ?? []) : [];
    const q = p.replace(/\s+/g, "");
    const hit = items.find((i) => (i.short_name ?? "").replace(/\s+/g, "") === q) ?? items.find((i) => i.stock_kind === "보통주") ?? items[0];
    if (hit?.code) symbols.push(hit.code);
    else unknown.push(p);
  }
  return { symbols: [...new Set(symbols)], unknown };
}

// ───────────────────────────── tools ─────────────────────────────

interface TossPrice {
  symbol?: string;
  timestamp?: string | null;
  lastPrice?: string;
  currency?: string;
}
interface TossStock {
  symbol?: string;
  name?: string;
  market?: string;
  currency?: string;
}

export const kTossQuote = defineSkill({
  name: "k_toss_quote",
  description:
    "Current price from the owner's 토스증권 Open API (real-time-ish last trade, KR and US stocks). Needs the owner's 토스증권 connection. " +
    "`symbols`: up to 5, comma-separated company names or codes/tickers ('삼성전자, AAPL', '005930'). Read-only.",
  parameters: schema({ symbols: { type: "string", description: "comma-separated names or codes, e.g. '삼성전자, 000660, AAPL'" } }, ["symbols"]),
  icon: "chart",
  title: (a) => `${str(a.symbols, 24)} 현재가 확인`,
  meta: { source: "toss-investment", title: "토스증권 시세", description: "내 토스증권 앱 키로 국내·미국 주식 현재가를 봐요.", category: "금융", example: "토스증권으로 삼성전자 지금 얼마야?" },
  connection: TOSS,
  private: false, // market prices: a meeting may say them aloud
  async run(a, rc) {
    const conn = rc.conn!;
    const input = str(a.symbols, 120);
    if (!input) return failText("토스증권: 종목 이름이나 코드를 알려주세요");
    rc.status("종목 찾는 중");
    const { symbols, unknown } = await resolveSymbols(input, rc.signal);
    if (!symbols.length) return failText(`토스증권: ‘${unknown.join(", ")}’ 종목을 찾지 못했어요`, "not_found");
    rc.status("토스증권 현재가 조회 중");
    const list = symbols.join(",");
    const [p, s] = await Promise.all([tossGet<TossPrice[]>(conn, "/api/v1/prices", { symbols: list }, rc.signal), tossGet<TossStock[]>(conn, "/api/v1/stocks", { symbols: list }, rc.signal)]);
    if (!p.ok) return failed(p.error, conn);
    const names = new Map((s.ok && Array.isArray(s.body) ? s.body : []).map((x) => [x.symbol, x] as const));
    const quotes = (Array.isArray(p.body) ? p.body : []).map((q) => {
      const info = names.get(q.symbol);
      return { symbol: q.symbol, name: info?.name ?? q.symbol, market: info?.market, price: n(q.lastPrice), currency: q.currency ?? info?.currency, at: q.timestamp ?? null };
    });
    if (!quotes.length) return failText("토스증권: 시세가 비어 있어요", "empty");
    const card: ResultListCard = {
      type: "results",
      title: "현재가",
      source: "토스증권",
      items: quotes.map((q) => ({
        title: `${q.name} ${money(q.price, q.currency)}`,
        subtitle: [q.market, q.symbol].filter(Boolean).join(" · "),
        meta: q.at ? q.at.slice(11, 16) : undefined,
        url: q.symbol && /^\d{6}$/.test(q.symbol) ? `https://tossinvest.com/stocks/A${q.symbol}` : undefined,
        icon: "chart",
      })),
    };
    return {
      ok: true,
      summary: quotes.map((q) => `${q.name} ${money(q.price, q.currency)}`).join(" · "),
      data: { quotes, notFound: unknown.length ? unknown : undefined, source: "토스증권 Open API" },
      card,
    };
  },
});

interface Holdings {
  totalPurchaseAmount?: { krw?: string; usd?: string };
  marketValue?: { amount?: { krw?: string; usd?: string } };
  profitLoss?: { amount?: { krw?: string; usd?: string }; rate?: string };
  dailyProfitLoss?: { amount?: { krw?: string }; rate?: string };
  items?: {
    symbol?: string;
    name?: string;
    currency?: string;
    quantity?: string;
    lastPrice?: string;
    averagePurchasePrice?: string;
    marketValue?: { amount?: string };
    profitLoss?: { amount?: string; rate?: string };
  }[];
}

export const kTossPortfolio = defineSkill({
  name: "k_toss_portfolio",
  description:
    "The owner's 토스증권 holdings: total value, profit/loss, daily change and each stock, plus KRW cash buying power. Private to the owner. " +
    "Needs the owner's 토스증권 connection. Optional `symbol` narrows to one stock. Read-only (never places orders).",
  parameters: schema({ symbol: { type: "string", description: "optional stock code/ticker to narrow, e.g. '005930'" } }),
  icon: "chart",
  title: () => "토스증권 보유 주식 확인",
  meta: { source: "toss-investment", title: "토스증권 보유 주식", description: "내 토스증권 계좌의 평가금액과 손익을 봐요.", category: "금융", example: "내 토스증권 수익률 어때?" },
  connection: { ...TOSS, reason: "보유 주식을 보려면 토스증권 연결이 필요해요" },
  private: true,
  async run(a, rc) {
    const conn = rc.conn!;
    rc.status("토스증권 계좌 조회 중");
    const symbol = str(a.symbol, 12).toUpperCase() || undefined;
    const [h, bp] = await Promise.all([
      tossGet<Holdings>(conn, "/api/v1/holdings", { symbol }, rc.signal, { account: true }),
      tossGet<{ currency?: string; cashBuyingPower?: string }>(conn, "/api/v1/buying-power", { currency: "KRW" }, rc.signal, { account: true }),
    ]);
    if (!h.ok) return failed(h.error, conn);
    const o = h.body ?? {};
    const items = (o.items ?? [])
      .map((i) => ({
        symbol: i.symbol,
        name: i.name ?? i.symbol,
        quantity: n(i.quantity),
        price: n(i.lastPrice),
        avg: n(i.averagePurchasePrice),
        value: n(i.marketValue?.amount),
        pl: n(i.profitLoss?.amount),
        rate: pct(i.profitLoss?.rate),
        currency: i.currency,
      }))
      .sort((x, y) => (y.value ?? 0) - (x.value ?? 0));
    const total = { value: n(o.marketValue?.amount?.krw), invested: n(o.totalPurchaseAmount?.krw), pl: n(o.profitLoss?.amount?.krw), rate: pct(o.profitLoss?.rate), today: n(o.dailyProfitLoss?.amount?.krw), todayRate: pct(o.dailyProfitLoss?.rate) };
    const cash = bp.ok ? n(bp.body?.cashBuyingPower) : null;
    const summary = items.length
      ? `평가 ${money(total.value, "KRW")} · 손익 ${total.pl !== null && total.pl > 0 ? "+" : ""}${money(total.pl, "KRW")}${total.rate ? ` (${total.rate})` : ""}`
      : `보유 주식이 없어요${cash !== null ? ` · 주문 가능 ${money(cash, "KRW")}` : ""}`;
    const card: ResultListCard = {
      type: "results",
      title: "토스증권 보유 주식",
      source: "토스증권",
      items: [
        ...(items.length ? [{ title: `평가 ${money(total.value, "KRW")}`, subtitle: `손익 ${money(total.pl, "KRW")} ${total.rate} · 오늘 ${money(total.today, "KRW")} ${total.todayRate}`.trim(), icon: "chart" as const }] : []),
        ...items.slice(0, 8).map((i) => ({
          title: `${i.name} ${i.quantity ?? "-"}주`,
          subtitle: `${money(i.value, i.currency)} · ${i.rate || "-"}`,
          meta: `평단 ${money(i.avg, i.currency)}`,
          icon: "chart" as const,
        })),
        ...(cash !== null ? [{ title: `주문 가능 ${money(cash, "KRW")}`, subtitle: "현금 기준", icon: "won" as const }] : []),
      ],
    };
    return {
      ok: true,
      summary,
      data: { total, holdings: items.slice(0, 20), count: items.length, cashBuyingPowerKrw: cash, private: true, note: "주인의 계좌 정보예요. 다른 사람이 있는 자리에서는 금액을 말하지 마세요.", source: "토스증권 Open API" },
      card,
    };
  },
});

interface TossOrder {
  orderId?: string;
  symbol?: string;
  side?: string;
  orderType?: string;
  status?: string;
  price?: string | null;
  quantity?: string;
  currency?: string;
  orderedAt?: string;
  execution?: { filledQuantity?: string; averageFilledPrice?: string | null };
}

const SIDE: Record<string, string> = { BUY: "매수", SELL: "매도" };
const ORDER_STATUS: Record<string, string> = { PENDING: "대기", PARTIAL_FILLED: "일부 체결", FILLED: "체결", CANCELED: "취소", REJECTED: "거부", EXPIRED: "만료" };

export const kTossOrders = defineSkill({
  name: "k_toss_orders",
  description:
    "The owner's 토스증권 orders: pending (default) or closed. Read-only: this tool cannot place, modify or cancel orders — say so if asked. " +
    "Needs the owner's 토스증권 connection. `status`: 'open' | 'closed'; optional `symbol`.",
  parameters: schema({
    status: { type: "string", enum: ["open", "closed"], description: "open (default) or closed" },
    symbol: { type: "string", description: "optional stock code/ticker" },
  }),
  icon: "doc",
  title: (a) => (a.status === "closed" ? "토스증권 지난 주문 확인" : "토스증권 대기 주문 확인"),
  meta: { source: "toss-investment", title: "토스증권 주문 내역", description: "내 토스증권 대기·완료 주문을 봐요. 주문은 넣지 않아요.", category: "금융", example: "토스증권에 걸어둔 주문 있어?" },
  connection: { ...TOSS, reason: "주문 내역을 보려면 토스증권 연결이 필요해요" },
  private: true,
  async run(a, rc) {
    const conn = rc.conn!;
    const closed = a.status === "closed";
    rc.status("토스증권 주문 조회 중");
    const r = await tossGet<{ orders?: TossOrder[]; hasNext?: boolean }>(conn, "/api/v1/orders", { status: closed ? "CLOSED" : "OPEN", symbol: str(a.symbol, 12).toUpperCase() || undefined, limit: "20" }, rc.signal, { account: true });
    if (!r.ok) return failed(r.error, conn);
    const orders = (r.body?.orders ?? []).map((o) => ({
      symbol: o.symbol,
      side: SIDE[o.side ?? ""] ?? o.side,
      status: ORDER_STATUS[o.status ?? ""] ?? o.status,
      type: o.orderType === "MARKET" ? "시장가" : o.orderType === "LIMIT" ? "지정가" : o.orderType,
      price: n(o.price),
      quantity: n(o.quantity),
      filled: n(o.execution?.filledQuantity),
      currency: o.currency,
      at: o.orderedAt,
    }));
    const label = closed ? "지난 주문" : "대기 주문";
    return {
      ok: true,
      summary: orders.length ? `${label} ${orders.length}건${r.body?.hasNext ? " 이상" : ""}` : `${label}이 없어요`,
      data: { status: closed ? "closed" : "open", orders, more: !!r.body?.hasNext, readOnly: "주문·정정·취소는 하지 않아요", private: true },
      card: {
        type: "results",
        title: `토스증권 ${label}`,
        source: "토스증권",
        items: orders.slice(0, 10).map((o) => ({
          title: `${o.symbol} ${o.side} ${o.quantity ?? "-"}주`,
          subtitle: [o.type, o.price !== null ? money(o.price, o.currency) : "", o.status, o.filled ? `${o.filled}주 체결` : ""].filter(Boolean).join(" · "),
          meta: o.at ? o.at.slice(5, 16).replace("T", " ") : undefined,
          icon: "doc",
        })),
      },
    };
  },
});

export const TOSS_FIELDS = [
  { key: "clientId", label: "Client ID", type: "text" as const, autocomplete: "off", placeholder: "Open API 콘솔의 client_id" },
  { key: "clientSecret", label: "Client Secret", type: "password" as const, autocomplete: "off", hint: "조회에만 써요." },
];

