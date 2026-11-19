/**
 * Connection tools (the owner's own logins): mocked upstreams and bogus credentials only — no live account is ever
 * called. Response bodies are synthetic, shaped like each service's published examples.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { connectionHandle, knownSecrets, memorySession, redactResult, type ConnectionHandle, type ToolContext, type ToolResult } from "@pickle/agent";
import { connectionServices, listSkills, resetDirectState, resetHttpState, setFetch, skillCatalogForPrompt, skillTools, type SkillTool } from "../src/index";
import { coupangAuthorization, coupangSignedDate, kCoupangSearch, resetCoupangCache, COUPANG_SEARCH_PATH } from "../src/connected/coupang";
import { kNaverAdKeywords, kNaverAdReport, naverSignature, periodRange } from "../src/connected/naverad";
import { issueInput, kPopbillInvoices, kPopbillIssueInvoice, linkhubDate, linkhubSignature, mgtKeyFor, popbillConfig } from "../src/connected/popbill";
import { kRissSearch, parseRiss } from "../src/connected/riss";
import { kTossOrders, kTossPortfolio, kTossQuote } from "../src/connected/toss";
import { fakeCtx, NOW } from "./helpers";

// ───────────────────────────── harness ─────────────────────────────

interface Req {
  method: string;
  url: string;
  origin: string;
  path: string;
  params: Record<string, string>;
  headers: Record<string, string>;
  body: string;
}
type Handler = (r: Req) => Response | Promise<Response>;

const jsonRes = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const xmlRes = (body: string, status = 200) => new Response(body, { status, headers: { "content-type": "application/xml" } });

/** routes keyed "METHOD https://host/path" (or "https://host/path" for any method); unknown → 404 */
function mockHosts(routes: Record<string, Handler | Handler[]>) {
  const requests: Req[] = [];
  const counters = new Map<string, number>();
  setFetch(async (url, init) => {
    const u = new URL(url);
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => (headers[k] = v));
    const req: Req = { method: init.method ?? "GET", url, origin: u.origin, path: u.pathname, params: Object.fromEntries(u.searchParams), headers, body: typeof init.body === "string" ? init.body : "" };
    requests.push(req);
    if (init.signal?.aborted) throw new DOMException("aborted", "AbortError");
    const key = routes[`${req.method} ${u.origin}${u.pathname}`] ? `${req.method} ${u.origin}${u.pathname}` : `${u.origin}${u.pathname}`;
    const entry = routes[key];
    if (!entry) return jsonRes({ error: "no route" }, 404);
    if (Array.isArray(entry)) {
      const i = counters.get(key) ?? 0;
      counters.set(key, i + 1);
      return entry[Math.min(i, entry.length - 1)]!(req);
    }
    return entry(req);
  });
  return { requests };
}

/** the context runTurn builds for a connection tool: ctx.connection carries the unsealed (bogus) login */
function connCtx(service: string, secret: Record<string, string>, over: Partial<ToolContext> = {}): { ctx: ToolContext & { statuses: string[] }; conn: ConnectionHandle } {
  const conn = connectionHandle({ service, secret: { ...secret }, credentialId: `cred_${service}` });
  return { ctx: fakeCtx({ connection: conn, ...over }), conn };
}

/** what the runtime does to every connection tool result before it leaves run() */
const redacted = (r: ToolResult, conn: ConnectionHandle) => redactResult(r, knownSecrets(conn));

const TOSS_SECRET = { clientId: "bogus-toss-client-id", clientSecret: "bogus-toss-client-secret-0001" };
const NAVER_SECRET = { apiKey: "bogus-naver-api-key-0001", secretKey: "bogus-secret-key", customerId: "1234567" };
const POPBILL_SECRET = { linkId: "BOGUSLINK", secretKey: "Ym9ndXMtcG9wYmlsbC1zZWNyZXQta2V5LTEyMzQ1Ng==", corpNum: "123-45-67890", env: "테스트" };
const COUPANG_SECRET = { accessKey: "bogus-coupang-access", secretKey: "bogus-coupang-secret" };
const RISS_SECRET = { apiKey: "bogus-riss-key-0001" };

beforeEach(() => {
  resetHttpState();
  resetDirectState();
  resetCoupangCache();
});
afterEach(() => setFetch(null));

/** no secret value in anything the model or UI sees */
function expectNoSecrets(r: ToolResult, secret: Record<string, string>) {
  const text = JSON.stringify({ summary: r.summary, data: r.data, card: r.card });
  for (const v of Object.values(secret)) if (v.length >= 6) expect(text).not.toContain(v);
}

// ───────────────────────────── catalog ─────────────────────────────

describe("catalog", () => {
  test("connectionServices: ids, fields and a verify hook per service", () => {
    const s = connectionServices();
    expect(s.map((x) => x.id)).toEqual(["toss-investment", "naver-searchad", "popbill", "coupang-partners", "riss"]);
    for (const x of s) {
      expect(x.id).toMatch(/^[a-z0-9_-]{2,32}$/);
      expect(x.fields.length).toBeGreaterThan(0);
      expect(typeof x.verify).toBe("function");
      expect(x.description.length).toBeGreaterThan(5);
      // a secret field is always a password field
      expect(x.fields.some((f) => f.type === "password")).toBe(true);
    }
    // callers get copies: mutating one can't change the catalog
    s[0]!.fields[0]!.label = "changed";
    expect(connectionServices()[0]!.fields[0]!.label).not.toBe("changed");
  });

  test("listSkills marks connection tools (needsKey, connection, not configured); only the issue tool writes", () => {
    const rows = listSkills();
    const toss = rows.find((r) => r.id === "k_toss_portfolio")!;
    expect(toss).toMatchObject({ needsKey: true, configured: false, connection: "toss-investment", connectionName: "토스증권" });
    expect(rows.find((r) => r.id === "k_weather")).toMatchObject({ needsKey: false, configured: true });
    expect(rows.filter((r) => r.write).map((r) => r.id)).toEqual(["k_popbill_issue_invoice"]);
    // the owner's account data (meetings keep it private); quotes, search volumes, product and paper searches are not
    expect(rows.filter((r) => r.private === true).map((r) => r.id)).toEqual(["k_toss_portfolio", "k_toss_orders", "k_naver_ad_report", "k_popbill_invoices", "k_popbill_issue_invoice"]);
    expect(rows.filter((r) => r.private === false).map((r) => r.id)).toEqual(["k_toss_quote", "k_naver_ad_keywords", "k_coupang_search", "k_riss_search"]);
    // every login tool states its meeting privacy; keyless proxy tools carry no flag
    for (const r of rows) expect(typeof r.private).toBe(r.connection ? "boolean" : "undefined");
    expect(rows.filter((r) => r.connection).map((r) => r.connection)).toEqual(
      expect.arrayContaining(["toss-investment", "naver-searchad", "popbill", "coupang-partners", "riss"]),
    );
  });

  test("ToolDefs carry connection / write / approval for the runtime", () => {
    const defs = skillTools() as SkillTool[];
    const issue = defs.find((d) => d.name === "k_popbill_issue_invoice")!;
    expect(issue.connection).toBe("popbill");
    expect(issue.connectionReason).toBe("세금계산서를 발행하려면 팝빌 연결이 필요해요");
    expect(defs.find((d) => d.name === "k_toss_quote")!.private).toBe(false);
    expect(defs.find((d) => d.name === "k_toss_portfolio")!.private).toBe(true);
    expect(issue.write).toBe(true);
    expect(typeof issue.approval).toBe("function");
    for (const d of defs.filter((x) => x.name !== "k_popbill_issue_invoice")) {
      expect(d.write).toBeUndefined();
      expect(d.approval).toBeUndefined();
    }
    for (const d of defs) expect(d.name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    // no tool takes a secret as an argument
    for (const d of defs) for (const k of Object.keys(d.parameters.properties)) expect(k).not.toMatch(/(^|_)(api_?|access_?)?key$|secret|passw|token|linkid|credential/i);
  });

  test("prompt catalog lists connection tools separately and says not to ask for keys in chat", () => {
    const p = skillCatalogForPrompt();
    expect(p).toContain("주인의 계정으로 쓰는 도구 (연결 필요)");
    expect(p).toContain("k_popbill_issue_invoice");
    expect(p).toContain("승인 후 실행");
    expect(p).toContain("채팅으로 묻지 말고");
    expect(skillCatalogForPrompt(["k_weather"])).not.toContain("연결 필요");
  });

  test("a connection tool without ctx.connection asks for the connection and calls nothing", async () => {
    const m = mockHosts({});
    const r = await kTossPortfolio.run({}, fakeCtx());
    expect(r.ok).toBe(false);
    expect(r.needsConnection).toEqual({ service: "toss-investment", serviceName: "토스증권", reason: "보유 주식을 보려면 토스증권 연결이 필요해요" });
    expect(m.requests).toHaveLength(0);
  });

  test("read-only modules contain no order / bid mutation endpoints", () => {
    const src = (f: string) => readFileSync(join(import.meta.dir, "..", "src", "connected", f), "utf8");
    const toss = src("toss.ts");
    // every API path the module can reach is a read endpoint (orders is GET-only: no /modify, /cancel, conditional orders)
    expect([...new Set(toss.match(/\/api\/v\d\/[A-Za-z0-9/_-]+/g))].sort()).toEqual(["/api/v1/accounts", "/api/v1/buying-power", "/api/v1/holdings", "/api/v1/orders", "/api/v1/prices", "/api/v1/stocks"]);
    expect(toss.match(/method: "POST"/g)?.length).toBe(1); // the OAuth token request only
    const naver = src("naverad.ts");
    expect(naver).not.toMatch(/method: "(POST|PUT|DELETE)"/);
    expect(naver).not.toMatch(/bidAmt|\/ncc\/keywords\/|dailyBudget/);
  });
});

// ───────────────────────────── signatures (vectors from an independent Python hmac run) ─────────────────────────────

describe("request signing", () => {
  test("네이버 검색광고: base64(HMAC-SHA256(secret, ts.METHOD.path))", () => {
    expect(naverSignature("bogus-secret-key", "1731400000000", "GET", "/ncc/campaigns")).toBe("gwmesMyOuY0BkBa4FZM7KuPCZorsenXkcyD0aUa7CWw=");
  });

  test("쿠팡 파트너스: CEA header over signedDate + METHOD + path + query", () => {
    const now = Date.UTC(2026, 10, 12, 3, 4, 5);
    expect(coupangSignedDate(now)).toBe("261112T030405Z");
    const query = `keyword=${encodeURIComponent("무선 청소기")}&limit=10`;
    expect(query).toBe("keyword=%EB%AC%B4%EC%84%A0%20%EC%B2%AD%EC%86%8C%EA%B8%B0&limit=10");
    expect(coupangAuthorization("ak", "bogus-coupang-secret", "GET", COUPANG_SEARCH_PATH, query, now)).toBe(
      "CEA algorithm=HmacSHA256, access-key=ak, signed-date=261112T030405Z, signature=934b383dc4df812c3fea358e0a8237ad784eafef419fcbf8d6e64fa8c2c66f5a",
    );
  });

  test("팝빌 (Linkhub): x-lh-date and the token HMAC", () => {
    expect(linkhubDate(Date.UTC(2026, 10, 12, 3, 4, 5, 678))).toBe("2026-11-12T03:04:05Z");
    const body = JSON.stringify({ access_id: "1234567890", scope: ["member", "110"] });
    expect(body).toBe('{"access_id":"1234567890","scope":["member","110"]}');
    expect(linkhubSignature(POPBILL_SECRET.secretKey, body, "2026-11-12T03:04:05Z", "POPBILL_TEST")).toBe("IE3ky4h2oIyVMVE0KhLD9rq4wUZBi+edN/ZopvRk0qg=");
  });
});

// ───────────────────────────── 토스증권 ─────────────────────────────

const T = "https://openapi.tossinvest.com";
const tossToken = (n = 1) => () => jsonRes({ access_token: `bogus-access-token-${n}-xxxxxxxx`, token_type: "Bearer", expires_in: 86400 });

describe("토스증권", () => {
  test("quote: one token, prices + names with Bearer, Korean names resolved through the KRX search (query only)", async () => {
    const m = mockHosts({
      [`POST ${T}/oauth2/token`]: tossToken(),
      [`${T}/api/v1/prices`]: () => jsonRes({ result: [{ symbol: "005930", timestamp: "2026-11-12T10:30:00.123+09:00", lastPrice: "72000", currency: "KRW" }, { symbol: "AAPL", timestamp: null, lastPrice: "178.5", currency: "USD" }] }),
      [`${T}/api/v1/stocks`]: () => jsonRes({ result: [{ symbol: "005930", name: "삼성전자", market: "KOSPI", currency: "KRW" }, { symbol: "AAPL", name: "애플", market: "NASDAQ", currency: "USD" }] }),
      "https://k-skill-proxy.nomadamas.org/v1/korean-stock/search": () => jsonRes({ items: [{ code: "005930", short_name: "삼성전자", stock_kind: "보통주" }] }),
    });
    const { ctx, conn } = connCtx("toss-investment", TOSS_SECRET);
    const r = await kTossQuote.run({ symbols: "삼성전자, aapl" }, ctx);
    expect(r.ok).toBe(true);
    expect(r.summary).toBe("삼성전자 72,000원 · 애플 $178.50");
    const token = m.requests.filter((q) => q.path === "/oauth2/token");
    expect(token).toHaveLength(1);
    expect(token[0]!.body).toContain("grant_type=client_credentials");
    expect(token[0]!.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    const prices = m.requests.find((q) => q.path === "/api/v1/prices")!;
    expect(prices.params.symbols).toBe("005930,AAPL");
    expect(prices.headers.authorization).toBe("Bearer bogus-access-token-1-xxxxxxxx");
    expect(prices.headers["x-tossinvest-account"]).toBeUndefined(); // market data is bearer-only
    // the shared proxy got the company name and nothing else
    const proxy = m.requests.find((q) => q.origin === "https://k-skill-proxy.nomadamas.org")!;
    expect(proxy.params).toEqual({ q: "삼성전자", limit: "5" });
    expect(JSON.stringify(proxy.headers)).not.toContain("bogus");
    expectNoSecrets(r, TOSS_SECRET);
    // the runtime's redaction leaves this result intact (nothing secret-shaped in it)
    expect(redacted(r, conn).summary).toBe(r.summary);
  });

  test("the token is reused from the connection session; a 401 re-issues once and retries", async () => {
    const m = mockHosts({
      [`POST ${T}/oauth2/token`]: [tossToken(1), tossToken(2)],
      [`${T}/api/v1/prices`]: [
        () => jsonRes({ result: [{ symbol: "005930", lastPrice: "72000", currency: "KRW" }] }),
        () => jsonRes({ error: { code: "invalid-token", message: "유효하지 않은 토큰입니다." } }, 401),
        () => jsonRes({ result: [{ symbol: "005930", lastPrice: "72100", currency: "KRW" }] }),
      ],
      [`${T}/api/v1/stocks`]: () => jsonRes({ result: [] }),
    });
    const { ctx } = connCtx("toss-investment", TOSS_SECRET);
    expect((await kTossQuote.run({ symbols: "005930" }, ctx)).ok).toBe(true);
    const second = await kTossQuote.run({ symbols: "005930" }, ctx);
    expect(second.summary).toBe("005930 72,100원");
    expect(m.requests.filter((q) => q.path === "/oauth2/token")).toHaveLength(2);
    const retried = m.requests.filter((q) => q.path === "/api/v1/prices").map((q) => q.headers.authorization);
    expect(retried).toEqual(["Bearer bogus-access-token-1-xxxxxxxx", "Bearer bogus-access-token-1-xxxxxxxx", "Bearer bogus-access-token-2-xxxxxxxx"]);
  });

  test("a refused app key → needsConnection and the session is cleared", async () => {
    mockHosts({ [`POST ${T}/oauth2/token`]: () => jsonRes({ error: "invalid_client", error_description: "Client authentication failed" }, 401) });
    const { ctx, conn } = connCtx("toss-investment", TOSS_SECRET);
    conn.session.set({ token: "", exp: 0 }, 60_000);
    const r = await kTossPortfolio.run({}, ctx);
    expect(r.ok).toBe(false);
    expect(r.needsConnection?.service).toBe("toss-investment");
    expect(conn.session.get()).toBeNull();
    expectNoSecrets(r, TOSS_SECRET);
  });

  test("portfolio: accountSeq discovered once, sent as X-Tossinvest-Account on holdings and buying power", async () => {
    const m = mockHosts({
      [`POST ${T}/oauth2/token`]: tossToken(),
      [`${T}/api/v1/accounts`]: () => jsonRes({ result: [{ accountNo: "12345678901", accountSeq: 7, accountType: "BROKERAGE" }] }),
      [`${T}/api/v1/holdings`]: () =>
        jsonRes({
          result: {
            totalPurchaseAmount: { krw: "6500000" },
            marketValue: { amount: { krw: "7200000" } },
            profitLoss: { amount: { krw: "700000" }, rate: "0.1179" },
            dailyProfitLoss: { amount: { krw: "100000" }, rate: "0.0141" },
            items: [
              { symbol: "005930", name: "삼성전자", currency: "KRW", quantity: "100", lastPrice: "72000", averagePurchasePrice: "65000", marketValue: { amount: "7200000" }, profitLoss: { amount: "700000", rate: "0.1077" } },
            ],
          },
        }),
      [`${T}/api/v1/buying-power`]: () => jsonRes({ result: { currency: "KRW", cashBuyingPower: "5000000" } }),
    });
    const { ctx } = connCtx("toss-investment", TOSS_SECRET);
    const r = await kTossPortfolio.run({}, ctx);
    expect(r.ok).toBe(true);
    expect(r.summary).toBe("평가 7,200,000원 · 손익 +700,000원 (+11.8%)");
    expect(m.requests.filter((q) => q.path === "/api/v1/accounts")).toHaveLength(1);
    for (const p of ["/api/v1/holdings", "/api/v1/buying-power"]) expect(m.requests.find((q) => q.path === p)!.headers["x-tossinvest-account"]).toBe("7");
    const data = r.data as { cashBuyingPowerKrw: number; holdings: { name: string; rate: string }[]; private: boolean };
    expect(data.cashBuyingPowerKrw).toBe(5_000_000);
    expect(data.holdings[0]).toMatchObject({ name: "삼성전자", rate: "+10.8%" });
    expect(data.private).toBe(true);
    expect(JSON.stringify(r)).not.toContain("12345678901"); // the account number never reaches the model
  });

  test("orders: GET only, Korean labels, says it can't place orders", async () => {
    const m = mockHosts({
      [`POST ${T}/oauth2/token`]: tossToken(),
      [`${T}/api/v1/accounts`]: () => jsonRes({ result: [{ accountNo: "1", accountSeq: 1, accountType: "BROKERAGE" }] }),
      [`${T}/api/v1/orders`]: () =>
        jsonRes({ result: { orders: [{ orderId: "o1", symbol: "005930", side: "BUY", orderType: "LIMIT", status: "PENDING", price: "70000", quantity: "10", currency: "KRW", orderedAt: "2026-11-12T09:30:00+09:00", execution: { filledQuantity: "0" } }], hasNext: false } }),
    });
    const { ctx } = connCtx("toss-investment", TOSS_SECRET);
    const r = await kTossOrders.run({}, ctx);
    expect(r.summary).toBe("대기 주문 1건");
    expect(m.requests.find((q) => q.path === "/api/v1/orders")!.params.status).toBe("OPEN");
    expect(m.requests.filter((q) => q.method !== "GET").map((q) => q.path)).toEqual(["/oauth2/token"]);
    expect((r.data as { orders: { side: string; status: string }[] }).orders[0]).toMatchObject({ side: "매수", status: "대기" });
  });

  test("verify: token + masked account label; a refused key is a Korean message", async () => {
    mockHosts({
      [`POST ${T}/oauth2/token`]: tossToken(),
      [`${T}/api/v1/accounts`]: () => jsonRes({ result: [{ accountNo: "12345678901", accountSeq: 1, accountType: "BROKERAGE" }] }),
    });
    const svc = connectionServices().find((s) => s.id === "toss-investment")!;
    expect(await svc.verify!(TOSS_SECRET, { signal: new AbortController().signal, session: memorySession() })).toEqual({ ok: true, accountLabel: "토스증권 •••• 8901" });
    mockHosts({ [`POST ${T}/oauth2/token`]: () => jsonRes({ error: "invalid_client" }, 401) });
    const bad = await svc.verify!(TOSS_SECRET, { signal: new AbortController().signal, session: memorySession() });
    expect(bad.ok).toBe(false);
    expect((bad as { message: string }).message).toContain("client_id/client_secret");
  });
});

// ───────────────────────────── 네이버 검색광고 ─────────────────────────────

const N = "https://api.searchad.naver.com";

describe("네이버 검색광고", () => {
  test("report: signed headers, campaign ids + timeRange to /stats, derived CTR/CPC, sorted by cost", async () => {
    const m = mockHosts({
      [`${N}/ncc/campaigns`]: () => jsonRes([{ nccCampaignId: "cmp-a", name: "브랜드" }, { nccCampaignId: "cmp-b", name: "일반", userLock: true }]),
      [`${N}/stats`]: () => jsonRes({ data: [{ id: "cmp-a", impCnt: 1000, clkCnt: 50, salesAmt: 25000, avgRnk: 2.1 }, { id: "cmp-b", impCnt: 4000, clkCnt: 40, salesAmt: 60000, ctr: 1, cpc: 1500 }] }),
    });
    const { ctx } = connCtx("naver-searchad", NAVER_SECRET);
    const r = await kNaverAdReport.run({ period: "last7" }, ctx);
    expect(r.ok).toBe(true);
    const camp = m.requests.find((q) => q.path === "/ncc/campaigns")!;
    expect(camp.headers["x-api-key"]).toBe(NAVER_SECRET.apiKey);
    expect(camp.headers["x-customer"]).toBe("1234567");
    expect(camp.headers["x-signature"]).toBe(naverSignature(NAVER_SECRET.secretKey, camp.headers["x-timestamp"]!, "GET", "/ncc/campaigns"));
    const stats = m.requests.find((q) => q.path === "/stats")!;
    expect(JSON.parse(stats.params.ids!)).toEqual(["cmp-a", "cmp-b"]);
    expect(JSON.parse(stats.params.timeRange!)).toEqual({ since: "2026-11-04", until: "2026-11-10" }); // KST 11/11 → last 7 full days
    expect(stats.headers["x-signature"]).toBe(naverSignature(NAVER_SECRET.secretKey, stats.headers["x-timestamp"]!, "GET", "/stats")); // path only, no query
    expect(r.summary).toBe("최근 7일 광고비 ₩85,000 · 클릭 90 · CTR 1.8%");
    const rows = (r.data as { rows: { name: string; ctr: number; cpc: number }[] }).rows;
    expect(rows.map((x) => x.name)).toEqual(["일반", "브랜드"]);
    expect(rows[1]).toMatchObject({ ctr: 5, cpc: 500 });
    expectNoSecrets(r, NAVER_SECRET);
  });

  test("a campaign name breaks down by ad group; ambiguous names list candidates", async () => {
    const m = mockHosts({
      [`${N}/ncc/campaigns`]: () => jsonRes([{ nccCampaignId: "cmp-a", name: "브랜드 검색" }, { nccCampaignId: "cmp-b", name: "브랜드 쇼핑" }, { nccCampaignId: "cmp-c", name: "일반" }]),
      [`${N}/ncc/adgroups`]: () => jsonRes([{ nccAdgroupId: "grp-1", name: "그룹1" }]),
      [`${N}/stats`]: () => jsonRes({ data: [{ id: "grp-1", impCnt: 10, clkCnt: 1, salesAmt: 300 }] }),
    });
    const { ctx } = connCtx("naver-searchad", NAVER_SECRET);
    const amb = await kNaverAdReport.run({ campaign: "브랜드" }, ctx);
    expect(amb.ok).toBe(false);
    expect((amb.data as { candidates: string[] }).candidates).toEqual(["브랜드 검색", "브랜드 쇼핑"]);
    const r = await kNaverAdReport.run({ campaign: "일반" }, ctx);
    expect(r.ok).toBe(true);
    expect(m.requests.find((q) => q.path === "/ncc/adgroups")!.params.nccCampaignId).toBe("cmp-c");
    expect((r.data as { scope: string }).scope).toBe("일반 광고그룹");
  });

  test("401 (bad signature) → needsConnection; 429 → plain failure", async () => {
    mockHosts({ [`${N}/ncc/campaigns`]: [() => jsonRes({ title: "Unauthorized" }, 401), () => jsonRes({}, 429)] });
    const { ctx } = connCtx("naver-searchad", NAVER_SECRET);
    const a = await kNaverAdReport.run({}, ctx);
    expect(a.needsConnection?.service).toBe("naver-searchad");
    const b = await kNaverAdReport.run({}, ctx);
    expect(b.needsConnection).toBeUndefined();
    expect(b.summary).toContain("호출 한도");
  });

  test("keyword tool: spaces removed from hints, hinted keyword first, '< 10' volumes", async () => {
    const m = mockHosts({
      [`${N}/keywordstool`]: () =>
        jsonRes({ keywordList: [{ relKeyword: "제주숙소", monthlyPcQcCnt: 5000, monthlyMobileQcCnt: 20000, compIdx: "높음" }, { relKeyword: "제주여행", monthlyPcQcCnt: 9000, monthlyMobileQcCnt: 41000, compIdx: "높음" }, { relKeyword: "제주희귀", monthlyPcQcCnt: "< 10", monthlyMobileQcCnt: "< 10", compIdx: "낮음" }] }),
    });
    const { ctx } = connCtx("naver-searchad", NAVER_SECRET);
    const r = await kNaverAdKeywords.run({ keywords: "제주 여행, 게스트 하우스" }, ctx);
    expect(m.requests[0]!.params.hintKeywords).toBe("제주여행,게스트하우스");
    expect(r.summary).toBe("제주여행 월간 50,000회 (모바일 41,000) · 경쟁 높음");
    const kws = (r.data as { keywords: { keyword: string; total: number }[] }).keywords;
    expect(kws.find((k) => k.keyword === "제주희귀")!.total).toBe(10);
  });

  test("period ranges in KST", () => {
    expect(periodRange("this_month", NOW)).toEqual({ since: "2026-11-01", until: "2026-11-11", label: "이번 달" });
    expect(periodRange("last_month", NOW)).toEqual({ since: "2026-10-01", until: "2026-10-31", label: "지난달" });
    expect(periodRange("yesterday", new Date("2026-03-01T00:30:00Z"))).toEqual({ since: "2026-02-28", until: "2026-02-28", label: "어제" });
  });
});

// ───────────────────────────── 팝빌 ─────────────────────────────

const AUTH = "https://auth.linkhub.co.kr";
const PBT = "https://popbill-test.linkhub.co.kr";
const pbToken = () => () => jsonRes({ session_token: "bogus-popbill-session-token", serviceID: "POPBILL_TEST", expiration: new Date(Date.now() + 3600_000).toISOString() });

const ISSUE_ARGS = {
  invoiceeCorpNum: "987-65-43210",
  invoiceeName: "하늘상사",
  invoiceeCeo: "하늘",
  invoiceeEmail: "tax@example.com",
  items: [{ name: "디자인 용역", supplyCost: 3_000_000 }],
};

describe("팝빌", () => {
  test("config: 사업자번호 normalised, 테스트 is the default environment, 팝빌 아이디 optional", () => {
    expect(popbillConfig(POPBILL_SECRET)).toMatchObject({ corpNum: "1234567890", test: true });
    expect(popbillConfig(POPBILL_SECRET)!.userId).toBeUndefined();
    const { env: _env, ...noEnv } = POPBILL_SECRET; // the device leaves an empty optional field out
    expect(popbillConfig(noEnv)!.test).toBe(true);
    expect(popbillConfig({ ...POPBILL_SECRET, userId: " haneul_pb " })!.userId).toBe("haneul_pb");
    const fields = connectionServices().find((x) => x.id === "popbill")!.fields;
    expect(fields.filter((f) => f.optional).map((f) => f.key)).toEqual(["userId", "env"]);
    expect(popbillConfig({ ...POPBILL_SECRET, env: "운영" })!.test).toBe(false);
    expect(popbillConfig({ ...POPBILL_SECRET, env: "" })!.test).toBe(true);
    expect(popbillConfig({ ...POPBILL_SECRET, corpNum: "123" })).toBeNull();
  });

  test("invoices: Linkhub token (LINKHUB auth header) then SELL search + point balance on the test hosts", async () => {
    const m = mockHosts({
      [`POST ${AUTH}/POPBILL_TEST/Token`]: pbToken(),
      [`${PBT}/Taxinvoice/SELL`]: () =>
        jsonRes({ code: 1, total: 2, list: [{ writeDate: "20261105", stateCode: 300, invoiceeCorpName: "하늘상사", invoiceeCorpNum: "9876543210", supplyCostTotal: "1000000", taxTotal: "100000", totalAmount: "1100000" }, { writeDate: "20261103", stateCode: 100, invoiceeCorpName: "바다상회", invoiceeCorpNum: "1112233333", supplyCostTotal: "10000", taxTotal: "1000", totalAmount: "11000" }] }),
      [`${AUTH}/POPBILL_TEST/Point`]: () => jsonRes({ remainPoint: 12000 }),
    });
    const { ctx } = connCtx("popbill", POPBILL_SECRET);
    const r = await kPopbillInvoices.run({}, ctx);
    expect(r.ok).toBe(true);
    expect(r.summary).toBe("이번 달 매출 2건 · 발행완료 합계 ₩1,100,000");
    const tok = m.requests.find((q) => q.path === "/POPBILL_TEST/Token")!;
    expect(JSON.parse(tok.body)).toEqual({ access_id: "1234567890", scope: ["member", "110"] });
    expect(tok.headers["x-lh-version"]).toBe("2.0");
    expect(tok.headers.authorization).toBe(`LINKHUB BOGUSLINK ${linkhubSignature(POPBILL_SECRET.secretKey, tok.body, tok.headers["x-lh-date"]!, "POPBILL_TEST")}`);
    const search = m.requests.find((q) => q.path === "/Taxinvoice/SELL")!;
    expect(search.params).toMatchObject({ DType: "W", SDate: "20261101", EDate: "20261111" });
    expect(search.headers.authorization).toBe("Bearer bogus-popbill-session-token");
    expect(search.headers["x-pb-version"]).toBe("1.0");
    const d = r.data as { environment: string; remainPoint: number; invoices: { state: string; counterpartyNo: string }[] };
    expect(d.environment).toBe("테스트");
    expect(d.remainPoint).toBe(12000);
    expect(d.invoices.map((i) => i.state)).toEqual(["발행완료", "임시저장"]);
    expect(d.invoices[0]!.counterpartyNo).toBe("987-65-43210");
    expect(m.requests.every((q) => q.origin === AUTH || q.origin === PBT)).toBe(true); // never the production host
  });

  test("a 팝빌 아이디 goes out as x-pb-userid on API calls (never on the token request)", async () => {
    const m = mockHosts({
      [`POST ${AUTH}/POPBILL_TEST/Token`]: pbToken(),
      [`${PBT}/Taxinvoice/SELL`]: () => jsonRes({ total: 0, list: [] }),
      [`${AUTH}/POPBILL_TEST/Point`]: () => jsonRes({ remainPoint: 0 }),
    });
    const { ctx } = connCtx("popbill", { ...POPBILL_SECRET, userId: "haneul_pb" });
    expect((await kPopbillInvoices.run({}, ctx)).ok).toBe(true);
    expect(m.requests.find((q) => q.path === "/Taxinvoice/SELL")!.headers["x-pb-userid"]).toBe("haneul_pb");
    expect(m.requests.find((q) => q.path === "/POPBILL_TEST/Token")!.headers["x-pb-userid"]).toBeUndefined();
  });

  test("운영 uses the production service id and host", async () => {
    const m = mockHosts({
      [`POST ${AUTH}/POPBILL/Token`]: pbToken(),
      ["https://popbill.linkhub.co.kr/Taxinvoice/BUY"]: () => jsonRes({ total: 0, list: [] }),
      [`${AUTH}/POPBILL/Point`]: () => jsonRes({ remainPoint: 0 }),
    });
    const { ctx } = connCtx("popbill", { ...POPBILL_SECRET, env: "운영" });
    const r = await kPopbillInvoices.run({ direction: "buy", period: "last_month" }, ctx);
    expect(r.summary).toBe("지난달 매입 세금계산서가 없어요");
    expect(m.requests.find((q) => q.path === "/Taxinvoice/BUY")!.params).toMatchObject({ SDate: "20261001", EDate: "20261031" });
  });

  test("a refused token (wrong LinkID/SecretKey or not a member) → needsConnection", async () => {
    mockHosts({ [`POST ${AUTH}/POPBILL_TEST/Token`]: () => jsonRes({ code: -99003008, message: "연동회원 아님" }, 400) });
    const { ctx } = connCtx("popbill", POPBILL_SECRET);
    const r = await kPopbillInvoices.run({}, ctx);
    expect(r.needsConnection?.service).toBe("popbill");
    expect(r.needsConnection?.reason).toContain("테스트 환경에 이 사업자번호의 연동회원이 없어요");
    expectNoSecrets(r, POPBILL_SECRET);
  });

  test("issue: approval card spells out the invoice; the run posts ISSUE with a deterministic 문서번호", async () => {
    const spec = kPopbillIssueInvoice.approval!(ISSUE_ARGS, fakeCtx())!;
    expect(spec.title).toBe("하늘상사에 세금계산서 ₩3,300,000을 발행할까요?");
    expect(spec.amount).toBe(3_300_000);
    expect(spec.detail).toContain("공급받는자 하늘상사 (987-65-43210) · 대표 하늘");
    expect(spec.detail).toContain("공급가액 ₩3,000,000 · 세액 ₩300,000 · 합계 ₩3,300,000 (과세, 청구)");
    expect(spec.detail).toContain("되돌릴 수 없어요");

    const m = mockHosts({
      [`POST ${AUTH}/POPBILL_TEST/Token`]: pbToken(),
      [`${PBT}/CorpInfo`]: () => jsonRes({ ceoname: "구름", corpName: "구름디자인", addr: "서울", bizType: "서비스", bizClass: "디자인" }),
      [`POST ${PBT}/Taxinvoice`]: () => jsonRes({ code: 1, message: "발행 완료", ntsConfirmNum: "20261112-41000000-00000001" }),
    });
    const { ctx } = connCtx("popbill", POPBILL_SECRET);
    const r = await kPopbillIssueInvoice.run(ISSUE_ARGS, ctx);
    expect(r.ok).toBe(true);
    expect(r.summary).toBe("하늘상사에 ₩3,300,000 세금계산서를 발행했어요 (테스트)");
    const post = m.requests.find((q) => q.method === "POST" && q.path === "/Taxinvoice")!;
    expect(post.headers["x-http-method-override"]).toBe("ISSUE");
    const body = JSON.parse(post.body);
    expect(body).toMatchObject({
      issueType: "정발행",
      chargeDirection: "정과금",
      purposeType: "청구",
      taxType: "과세",
      writeDate: "20261111",
      invoicerCorpNum: "1234567890",
      invoicerCorpName: "구름디자인",
      invoicerCEOName: "구름",
      invoiceeCorpNum: "9876543210",
      invoiceeCorpName: "하늘상사",
      supplyCostTotal: "3000000",
      taxTotal: "300000",
      totalAmount: "3300000",
    });
    expect(body.detailList).toEqual([{ serialNum: 1, purchaseDT: "20261111", itemName: "디자인 용역", qty: "", unitCost: "", supplyCost: "3000000", tax: "300000" }]);
    const v = issueInput(ISSUE_ARGS, NOW);
    expect(v.ok).toBe(true);
    expect(body.invoicerMgtKey).toBe(mgtKeyFor((v as { v: Parameters<typeof mgtKeyFor>[0] }).v));
    expect(body.invoicerMgtKey).toMatch(/^MOSI-20261111-[0-9A-F]{8}$/);
    expect(body.invoicerMgtKey.length).toBeLessThanOrEqual(24);
  });

  test("issue: a reused 문서번호 is reported, not retried; bad input fails before any call", async () => {
    const m = mockHosts({
      [`POST ${AUTH}/POPBILL_TEST/Token`]: pbToken(),
      [`${PBT}/CorpInfo`]: () => jsonRes({ ceoname: "구름", corpName: "구름디자인" }),
      [`POST ${PBT}/Taxinvoice`]: () => jsonRes({ code: -11000005, message: "이미 사용중인 문서번호입니다." }, 400),
    });
    const { ctx } = connCtx("popbill", POPBILL_SECRET);
    const dup = await kPopbillIssueInvoice.run(ISSUE_ARGS, ctx);
    expect(dup.ok).toBe(false);
    expect((dup.data as { error: string }).error).toBe("duplicate");
    expect(m.requests.filter((q) => q.method === "POST" && q.path === "/Taxinvoice")).toHaveLength(1);
    const before = m.requests.length;
    const bad = await kPopbillIssueInvoice.run({ ...ISSUE_ARGS, invoiceeCorpNum: "12" }, ctx);
    expect(bad.summary).toBe("팝빌: 공급받는자 사업자번호 10자리가 필요해요");
    expect(m.requests.length).toBe(before);
  });

  test("issueInput: VAT default, 영세, item validation, write date window", () => {
    const ok = issueInput({ ...ISSUE_ARGS, items: [{ name: "A", supplyCost: 1005 }, { name: "B", supplyCost: 2000, tax: 0, qty: 4 }] }, NOW);
    expect(ok.ok && ok.v).toMatchObject({ supplyTotal: 3005, taxTotal: 100, total: 3105 });
    expect(ok.ok && ok.v.items[1]).toMatchObject({ qty: 4, unitCost: 500 });
    const zero = issueInput({ ...ISSUE_ARGS, taxType: "영세" }, NOW);
    expect(zero.ok && zero.v.taxTotal).toBe(0);
    expect(issueInput({ ...ISSUE_ARGS, items: [] }, NOW).ok).toBe(false);
    expect(issueInput({ ...ISSUE_ARGS, writeDate: "20261201" }, NOW).ok).toBe(false); // future
    expect(issueInput({ ...ISSUE_ARGS, invoiceeEmail: "nope" }, NOW).ok).toBe(false);
  });
});

// ───────────────────────────── 쿠팡 파트너스 ─────────────────────────────

const CP = "https://api-gateway.coupang.com";
const cpOk = () => jsonRes({ rCode: "0", rMessage: "", data: { landingUrl: "https://link.coupang.com/x", productData: [{ productId: 1, productName: "무선청소기 A", productPrice: 189000, productUrl: "https://link.coupang.com/a/1", isRocket: true, isFreeShipping: true, categoryName: "청소기" }, { productId: 2, productName: "무선청소기 B", productPrice: 259000, productUrl: "https://link.coupang.com/a/2", isRocket: false, isFreeShipping: true }] } });

describe("쿠팡 파트너스", () => {
  test("search: signed CEA header, budget filter, affiliate notice, cached per owner for repeat queries", async () => {
    const m = mockHosts({ [`${CP}${COUPANG_SEARCH_PATH}`]: cpOk });
    const { ctx } = connCtx("coupang-partners", COUPANG_SECRET);
    const r = await kCoupangSearch.run({ query: "무선 청소기", maxPrice: 200000 }, ctx);
    expect(r.ok).toBe(true);
    expect(r.summary).toBe("‘무선 청소기’ 1개 · 최저 ₩189,000");
    const req = m.requests[0]!;
    expect(req.url).toContain("keyword=%EB%AC%B4%EC%84%A0%20%EC%B2%AD%EC%86%8C%EA%B8%B0&limit=10");
    expect(req.headers.authorization).toMatch(/^CEA algorithm=HmacSHA256, access-key=bogus-coupang-access, signed-date=\d{6}T\d{6}Z, signature=[0-9a-f]{64}$/);
    expect((r.data as { notice: string }).notice).toBe("쿠팡 파트너스 활동을 통해 일정액의 수수료를 제공받을 수 있습니다.");
    const again = await kCoupangSearch.run({ query: "무선 청소기" }, ctx);
    expect((again.data as { cached: boolean }).cached).toBe(true);
    expect(m.requests).toHaveLength(1);
    expectNoSecrets(r, { secretKey: COUPANG_SECRET.secretKey });
  });

  test("the hourly quota is guarded locally: the 11th distinct search in an hour never leaves the server", async () => {
    let t = 1_000_000;
    resetDirectState({ clock: () => t });
    const m = mockHosts({ [`${CP}${COUPANG_SEARCH_PATH}`]: cpOk });
    const { ctx } = connCtx("coupang-partners", COUPANG_SECRET);
    for (let i = 0; i < 10; i++) expect((await kCoupangSearch.run({ query: `상품${i}` }, ctx)).ok).toBe(true);
    const r = await kCoupangSearch.run({ query: "상품10" }, ctx);
    expect(r.ok).toBe(false);
    expect(r.summary).toContain("시간당 10번");
    expect(m.requests).toHaveLength(10);
    t += 6 * 60_000; // one token back after ~6 minutes
    expect((await kCoupangSearch.run({ query: "상품10" }, ctx)).ok).toBe(true);
  });

  test("rCode 401 / HTTP 403 → needsConnection", async () => {
    mockHosts({ [`${CP}${COUPANG_SEARCH_PATH}`]: [() => jsonRes({ rCode: "401", rMessage: "Invalid signature" }), () => jsonRes({ message: "forbidden" }, 403)] });
    const { ctx } = connCtx("coupang-partners", COUPANG_SECRET);
    expect((await kCoupangSearch.run({ query: "생수" }, ctx)).needsConnection?.service).toBe("coupang-partners");
    expect((await kCoupangSearch.run({ query: "라면" }, ctx)).needsConnection?.service).toBe("coupang-partners");
  });
});

// ───────────────────────────── RISS ─────────────────────────────

const rissXml = (type: string, n: number, total = n) =>
  `<?xml version="1.0" encoding="UTF-8"?><record><head><totalcount>${total}</totalcount><Error>0</Error><ErrorMessage>success</ErrorMessage></head>${Array.from(
    { length: n },
    (_, i) =>
      `<metadata><riss.type>${type}</riss.type><riss.title><![CDATA[${type} 논문 ${i + 1} &amp; 교육]]></riss.title><riss.author>김연구;이학술</riss.author><riss.publisher>하늘대학교</riss.publisher><riss.pubdate>2024</riss.pubdate><riss.url>https://www.riss.kr/link?id=${type}${i}</riss.url><riss.image>${i % 2 ? "N" : "Y"}</riss.image><riss.charge>1</riss.charge></metadata>`,
  ).join("")}</record>`;

describe("RISS", () => {
  test("parseRiss: CDATA/entities, authors, full-text flags, error envelope", () => {
    const p = parseRiss(rissXml("T", 2, 57));
    expect(p.ok && p.total).toBe(57);
    expect(p.ok && p.items[0]).toMatchObject({ type: "T", title: "T 논문 1 & 교육", authors: ["김연구", "이학술"], year: "2024", fullText: "free" });
    expect(p.ok && p.items[1]!.fullText).toBe("none");
    expect(parseRiss("<record><head><Error>99</Error><ErrorMessage>인증키가 유효하지 않습니다</ErrorMessage></head></record>")).toEqual({ ok: false, code: "99", message: "인증키가 유효하지 않습니다" });
    expect(parseRiss("<html>nope</html>").ok).toBe(false);
  });

  test("ALL queries each RISS type and merges round-robin; the key goes only to riss.kr", async () => {
    const m = mockHosts({ ["https://www.riss.kr/openApi"]: (q) => xmlRes(rissXml(q.params.type!, q.params.type === "T" ? 3 : 1, 5)) });
    const { ctx } = connCtx("riss", RISS_SECRET);
    const r = await kRissSearch.run({ keyword: "인공지능 교육" }, ctx);
    expect(r.ok).toBe(true);
    expect(m.requests.map((q) => q.params.type).sort()).toEqual(["A", "F", "O", "S", "T", "U"]);
    expect(m.requests.every((q) => q.params.key === RISS_SECRET.apiKey && q.params.version === "1.0" && q.params.rsnum === "1" && q.params.rowcount === "10")).toBe(true);
    const items = (r.data as { items: { type: string }[] }).items;
    expect(items.slice(0, 6).map((i) => i.type)).toEqual(["T", "A", "O", "U", "F", "S"]);
    expect(items).toHaveLength(8);
    expect(r.summary).toBe("RISS ‘인공지능 교육’ 30건 중 8건");
    expectNoSecrets(r, RISS_SECRET);
  });

  test("a refused key → needsConnection; a keyword-wording error stays a plain failure", async () => {
    mockHosts({
      ["https://www.riss.kr/openApi"]: [
        () => xmlRes("<record><head><Error>99</Error><ErrorMessage>등록되지 않은 인증키입니다</ErrorMessage></head></record>"),
        () => xmlRes("<record><head><Error>10</Error><ErrorMessage>검색 키워드를 입력하세요</ErrorMessage></head></record>"),
      ],
    });
    const { ctx } = connCtx("riss", RISS_SECRET);
    expect((await kRissSearch.run({ title: "대학도서관", type: "T" }, ctx)).needsConnection?.service).toBe("riss");
    const plain = await kRissSearch.run({ title: "대학도서관", type: "T" }, ctx);
    expect(plain.needsConnection).toBeUndefined();
    expect(plain.ok).toBe(false);
  });
});

// ───────────────────────────── cross-cutting ─────────────────────────────

describe("connect-time verify", () => {
  const SECRETS: Record<string, Record<string, string>> = {
    "toss-investment": TOSS_SECRET,
    "naver-searchad": NAVER_SECRET,
    popbill: POPBILL_SECRET,
    "coupang-partners": COUPANG_SECRET,
    riss: RISS_SECRET,
  };
  const x = () => ({ signal: new AbortController().signal, session: memorySession() });
  const everyRoute = (res: () => Response) => {
    setFetch(async () => res());
  };

  test("a transient failure (5xx, 429, network) is retryable, so the server keeps the saved login", async () => {
    for (const make of [() => jsonRes({ error: "busy" }, 503), () => jsonRes({ error: "slow down" }, 429)]) {
      for (const svc of connectionServices()) {
        resetDirectState();
        everyRoute(make);
        const r = await svc.verify!(SECRETS[svc.id]!, x());
        expect({ id: svc.id, ok: r.ok, retryable: (r as { retryable?: boolean }).retryable }).toEqual({ id: svc.id, ok: false, retryable: true });
        expectNoSecrets({ ok: false, summary: (r as { message: string }).message }, SECRETS[svc.id]!);
      }
    }
    for (const svc of connectionServices()) {
      setFetch(async () => {
        throw new TypeError("fetch failed");
      });
      const r = await svc.verify!(SECRETS[svc.id]!, x());
      expect((r as { retryable?: boolean }).retryable).toBe(true);
    }
  });

  test("a refused login is never retryable", async () => {
    for (const svc of connectionServices()) {
      resetDirectState();
      everyRoute(() =>
        svc.id === "riss" ? xmlRes("<record><head><Error>99</Error><ErrorMessage>등록되지 않은 인증키입니다</ErrorMessage></head></record>") : jsonRes({ error: "unauthorized", rCode: "401" }, 401),
      );
      const r = await svc.verify!(SECRETS[svc.id]!, x());
      expect(r.ok).toBe(false);
      expect((r as { retryable?: boolean }).retryable).toBeUndefined();
      expect((r as { message: string }).message.length).toBeGreaterThan(5);
    }
  });

  test("verify rate-limits per key, never in one bucket shared by everyone who connects", async () => {
    const m = mockHosts({ [`${CP}${COUPANG_SEARCH_PATH}`]: cpOk });
    const svc = connectionServices().find((s) => s.id === "coupang-partners")!;
    for (let i = 0; i < 10; i++) expect((await svc.verify!({ accessKey: `bogus-access-${i}`, secretKey: "bogus-coupang-secret" }, x())).ok).toBe(true);
    // ten different people connected in the same hour; the eleventh still gets checked
    expect((await svc.verify!({ accessKey: "bogus-access-10", secretKey: "bogus-coupang-secret" }, x())).ok).toBe(true);
    expect(m.requests).toHaveLength(11);
  });
});

describe("every connection tool", () => {
  test("only calls its own service's origins (plus the k-skill proxy for name lookups)", async () => {
    const allowed = new Set([T, N, AUTH, PBT, "https://popbill.linkhub.co.kr", CP, "https://www.riss.kr", "https://k-skill-proxy.nomadamas.org"]);
    const m = mockHosts({});
    const cases: [SkillTool, string, Record<string, string>, Record<string, unknown>][] = [
      [kTossQuote, "toss-investment", TOSS_SECRET, { symbols: "005930" }],
      [kNaverAdReport, "naver-searchad", NAVER_SECRET, {}],
      [kPopbillInvoices, "popbill", POPBILL_SECRET, {}],
      [kCoupangSearch, "coupang-partners", COUPANG_SECRET, { query: "생수" }],
      [kRissSearch, "riss", RISS_SECRET, { keyword: "교육", type: "T" }],
    ];
    for (const [tool, service, secret, args] of cases) {
      const { ctx } = connCtx(service, secret);
      const r = await tool.run(args, ctx);
      expect(r.ok).toBe(false); // every route 404s here: a failure, never a throw
      expectNoSecrets(r, secret);
    }
    expect(m.requests.length).toBeGreaterThan(0);
    for (const q of m.requests) expect(allowed.has(q.origin)).toBe(true);
    // no request carries the owner's identity
    for (const q of m.requests) expect(JSON.stringify(q)).not.toMatch(/SECRET|김비밀|should-not-leak/);
  });
});
