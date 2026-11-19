import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { breakerMs, buildUrl, httpStats, proxyGet, resetHttpState, setFetch, setTimeoutMs, TokenBucket, TtlCache, type ProxyError } from "../src/http";
import { kHolidays, kNews } from "../src/index";
import { byteLength, fit, manwon, toYmd } from "../src/util";
import { cityFallback } from "../src/geo";
import { fakeCtx, fixture, json, mockProxy } from "./helpers";

beforeEach(() => resetHttpState());
afterEach(() => {
  setFetch(null);
  setTimeoutMs(null);
});

const signal = () => new AbortController().signal;

describe("TokenBucket", () => {
  test("burst, continuous refill, and never more than 50 grants in any 60 s window", () => {
    let t = 0;
    const b = new TokenBucket(10, 40, 60_000, () => t);
    for (let i = 0; i < 10; i++) expect(b.tryTake()).toBe(true);
    expect(b.tryTake()).toBe(false);
    expect(b.waitMs()).toBe(1500); // 60 s / 40
    t += 1500;
    expect(b.tryTake()).toBe(true);
    expect(b.tryTake()).toBe(false);
    // hammer it for 3 simulated minutes, polling every 50 ms; check every 60 s sliding window
    const grants: number[] = [];
    for (t = 100_000; t < 280_000; t += 50) if (b.tryTake()) grants.push(t);
    let worst = 0;
    for (let i = 0, j = 0; i < grants.length; i++) {
      while (grants[i]! - grants[j]! >= 60_000) j++;
      worst = Math.max(worst, i - j + 1);
    }
    expect(worst).toBeLessThanOrEqual(50);
    expect(worst).toBeGreaterThanOrEqual(45);
  });

  test("take() waits for a token and honours abort", async () => {
    const b = new TokenBucket(1, 1, 40);
    await b.take();
    const started = Date.now();
    await b.take();
    expect(Date.now() - started).toBeGreaterThanOrEqual(25);
    const ctrl = new AbortController();
    const p = b.take(ctrl.signal);
    ctrl.abort();
    await expect(p).rejects.toThrow();
  });

  test("the shared limiter throttles proxy calls", async () => {
    let t = 0;
    resetHttpState({ burst: 3, refillPerMinute: 3, clock: () => t });
    let calls = 0;
    setFetch(async () => {
      calls++;
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    });
    for (let i = 0; i < 3; i++) expect((await proxyGet(`/v1/x${i}`, {}, signal())).ok).toBe(true);
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 30);
    const blocked = await proxyGet("/v1/x9", {}, ctrl.signal); // no token for 20 s of fake time → aborted while waiting
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.error.kind).toBe("aborted");
    expect(calls).toBe(3);
  });
});

describe("TtlCache", () => {
  test("expires after ttl and evicts the oldest past maxEntries", () => {
    let t = 0;
    const c = new TtlCache<number>(1000, 2, () => t);
    c.set("a", 1);
    c.set("b", 2);
    c.set("c", 3);
    expect(c.get("a")).toBeUndefined();
    expect(c.get("b")).toBe(2);
    t += 1000;
    expect(c.get("b")).toBeUndefined();
  });

  test("proxy responses are cached by URL for 5 minutes (successes only)", async () => {
    const m = mockProxy({ "/v1/naver-news/search": json("naver_news.json"), "/v1/fail": { status: 400, body: { error: "bad_request", message: "x" } } });
    const a = await kNews.run({ query: "AI" }, fakeCtx());
    const b = await kNews.run({ query: "AI" }, fakeCtx());
    expect(a.summary).toBe(b.summary);
    expect(m.requests.length).toBe(1);
    expect(httpStats().cacheHits).toBe(1);
    await kNews.run({ query: "AI", sort: "relevance" }, fakeCtx()); // different URL → new request
    expect(m.requests.length).toBe(2);
    await proxyGet("/v1/fail", {}, signal());
    await proxyGet("/v1/fail", {}, signal());
    expect(m.requests.filter((r) => r.path === "/v1/fail").length).toBe(2);
  });

  test("per-route TTL: real-time feeds expire sooner", async () => {
    let t = 0;
    resetHttpState({ clock: () => t });
    let calls = 0;
    setFetch(async () => {
      calls++;
      return new Response('{"ok":1}', { status: 200 });
    });
    await proxyGet("/v1/rt", {}, signal(), { ttlMs: 20_000 });
    t += 19_000;
    await proxyGet("/v1/rt", {}, signal(), { ttlMs: 20_000 });
    expect(calls).toBe(1);
    t += 2_000;
    await proxyGet("/v1/rt", {}, signal(), { ttlMs: 20_000 });
    expect(calls).toBe(2);
  });

  test("one caller cancelling does not fail another caller's identical request", async () => {
    let calls = 0;
    setFetch(async (_u, init) => {
      calls++;
      await Bun.sleep(60);
      if (init.signal?.aborted) throw new DOMException("aborted", "AbortError");
      return new Response('{"ok":1}', { status: 200 });
    });
    const a = new AbortController();
    const pa = proxyGet("/v1/shared", { q: "1" }, a.signal);
    const pb = proxyGet("/v1/shared", { q: "1" }, signal());
    setTimeout(() => a.abort(), 10);
    const [ra, rb] = await Promise.all([pa, pb]);
    expect(ra.ok).toBe(false);
    if (!ra.ok) expect(ra.error.kind).toBe("aborted");
    expect(rb.ok).toBe(true);
    expect(calls).toBe(1);
  });

  test("a cancelling caller returns immediately and the request is aborted once nobody waits", async () => {
    let aborted = false;
    setFetch(
      (_u, init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            aborted = true;
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
    );
    const a = new AbortController();
    const p = proxyGet("/v1/solo", {}, a.signal);
    setTimeout(() => a.abort(), 10);
    const r = await p;
    expect(r.ok).toBe(false);
    await Bun.sleep(5);
    expect(aborted).toBe(true);
  });

  test("identical in-flight requests are de-duplicated", async () => {
    let calls = 0;
    setFetch(async () => {
      calls++;
      await Bun.sleep(20);
      return new Response('{"ok":1}', { status: 200 });
    });
    const [x, y] = await Promise.all([proxyGet("/v1/same", { q: "1" }, signal()), proxyGet("/v1/same", { q: "1" }, signal())]);
    expect(x.ok && y.ok).toBe(true);
    expect(calls).toBe(1);
  });
});

describe("retry, timeout, errors", () => {
  test("retries once on a transient 5xx", async () => {
    const m = mockProxy({
      "/v1/naver-news/search": [{ status: 502, body: { error: "upstream_error", message: "Naver upstream timeout" } }, json("naver_news.json")],
    });
    const r = await kNews.run({ query: "AI" }, fakeCtx());
    expect(r.ok).toBe(true);
    expect(m.requests.length).toBe(2);
  });

  test("gives up after the single retry with a Korean summary", async () => {
    const m = mockProxy({ "/v1/naver-news/search": { status: 503, body: { error: "upstream_error", message: "down" } } });
    const r = await kNews.run({ query: "AI" }, fakeCtx());
    expect(r.ok).toBe(false);
    expect(r.summary).toBe("뉴스: 지금은 원본 서비스 응답이 원활하지 않아요");
    expect(m.requests.length).toBe(2);
  });

  test("a cached success is still served while the route breaker is open", async () => {
    const m = mockProxy({
      "/v1/coupang/products/search": (req) =>
        req.params.query === "생수"
          ? new Response(JSON.stringify({ items: [{ title: "삼다수", price: 1000 }] }), { status: 200 })
          : new Response(fixture("coupang_forbidden_502.json"), { status: 502 }),
    });
    expect((await proxyGet("/v1/coupang/products/search", { query: "생수" }, signal())).ok).toBe(true);
    expect((await proxyGet("/v1/coupang/products/search", { query: "라면" }, signal())).ok).toBe(false); // opens breaker
    expect((await proxyGet("/v1/coupang/products/search", { query: "생수" }, signal())).ok).toBe(true); // cache
    expect((await proxyGet("/v1/coupang/products/search", { query: "과자" }, signal())).ok).toBe(false); // breaker
    expect(m.requests.length).toBe(2);
  });

  test("breaker length: key rejected / banned 60 min, upstream quota 2 min, other deterministic 10 min", () => {
    const e = (message: string, extra: Partial<ProxyError> = {}): ProxyError => ({ kind: "upstream", status: 502, message, ...extra });
    expect(breakerMs(e("KRX API HTTP 오류 (status: 401): Unauthorized"))).toBe(60 * 60_000);
    expect(breakerMs(e("x", { code: "upstream_forbidden" }))).toBe(60 * 60_000);
    expect(breakerMs(e("x", { body: { upstream: { status_code: 403 } } }))).toBe(60 * 60_000);
    expect(breakerMs(e("SERVICE_KEY_IS_NOT_REGISTERED_ERROR"))).toBe(60 * 60_000);
    expect(breakerMs(e("x", { body: { upstream: { status_code: 429 } } }))).toBe(2 * 60_000);
    expect(breakerMs(e("LIMITED_NUMBER_OF_SERVICE_REQUESTS_EXCEEDS_ERROR"))).toBe(2 * 60_000);
    expect(breakerMs(e("daily quota exceeded"))).toBe(10 * 60_000);
  });

  test("a 401 breaker stays open for an hour, then the route is tried again", async () => {
    let t = 1_000_000;
    resetHttpState({ clock: () => t });
    const m = mockProxy({ "/v1/korean-stock/trade-info": json("korean_stock_trade_info_401_502.json", 502) });
    const get = (code: string) => proxyGet("/v1/korean-stock/trade-info", { market: "KOSPI", code }, signal());
    expect((await get("005930")).ok).toBe(false);
    t += 59 * 60_000;
    expect((await get("000660")).ok).toBe(false);
    expect(m.requests.length).toBe(1); // still open after 59 min
    t += 2 * 60_000;
    expect((await get("035720")).ok).toBe(false);
    expect(m.requests.length).toBe(2); // reopened for a fresh try after 61 min
  });

  test("proxy 429 with a short retry_after_ms is retried once", async () => {
    const m = mockProxy({
      "/v1/naver-news/search": [{ status: 429, body: { error: "rate_limited", message: "slow down", retry_after_ms: 10 } }, json("naver_news.json")],
    });
    const r = await kNews.run({ query: "AI" }, fakeCtx());
    expect(r.ok).toBe(true);
    expect(m.requests.length).toBe(2);
  });

  test("timeout → ok:false (never throws)", async () => {
    setTimeoutMs(50);
    setFetch(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason ?? new DOMException("aborted", "AbortError")));
        }),
    );
    const started = Date.now();
    const r = await kHolidays.run({ year: 2026 }, fakeCtx());
    expect(Date.now() - started).toBeLessThan(1000);
    expect(r.ok).toBe(false);
    expect(r.summary).toBe("공휴일: 응답이 너무 늦어 중단했어요 (12초 초과)");
    expect((r.data as { error: string }).error).toBe("timeout");
  });

  test("user cancellation (ctx.signal) → ok:false 'aborted'", async () => {
    setFetch(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    );
    const ctrl = new AbortController();
    const p = kHolidays.run({ year: 2026 }, fakeCtx({ signal: ctrl.signal }));
    setTimeout(() => ctrl.abort(), 10);
    const r = await p;
    expect(r.ok).toBe(false);
    expect((r.data as { error: string }).error).toBe("aborted");
  });

  test("network failure → ok:false", async () => {
    setFetch(async () => {
      throw new TypeError("fetch failed");
    });
    const r = await kHolidays.run({}, fakeCtx());
    expect(r.ok).toBe(false);
    expect(r.summary).toBe("공휴일: k-skill 프록시에 연결하지 못했어요");
  });

  test("non-JSON body on a JSON route → parse error, ok:false", async () => {
    mockProxy({ "/v1/naver-news/search": { body: "<html>maintenance</html>", contentType: "text/html" } });
    const r = await kNews.run({ query: "AI" }, fakeCtx());
    expect(r.ok).toBe(false);
    expect((r.data as { error: string }).error).toBe("parse");
  });

  test("XML route still works through proxyGetText", async () => {
    mockProxy({ "/v1/korean-holiday/calendar": { body: fixture("holidays_2026.xml"), contentType: "application/xml" } });
    const r = await kHolidays.run({ year: 2026, month: 12 }, fakeCtx());
    expect(r.ok).toBe(true);
  });
});

describe("helpers", () => {
  test("buildUrl drops empty params and encodes Korean", () => {
    const u = buildUrl("/v1/a", { q: "강남", empty: "", none: undefined, n: 0 });
    expect(u).toBe("https://k-skill-proxy.nomadamas.org/v1/a?q=%EA%B0%95%EB%82%A8&n=0");
  });

  test("fit() trims the longest arrays to stay under 4 KB of UTF-8", () => {
    const big = { title: "x", items: Array.from({ length: 200 }, (_, i) => ({ i, text: "가".repeat(40) })), small: [1, 2] };
    const out = fit(big);
    expect(byteLength(JSON.stringify(out))).toBeLessThanOrEqual(4096);
    expect(out.items.length).toBeGreaterThan(10);
    expect(out.small).toEqual([1, 2]);
  });

  test("formatters and date validation", () => {
    expect(manwon(129999.5)).toBe("13억원");
    expect(manwon(161500)).toBe("16억 1,500만원");
    expect(manwon(8500)).toBe("8,500만원");
    expect(toYmd("2026-02-30")).toBe("");
    expect(toYmd("2026.11.25")).toBe("20261125");
  });

  test("city fallback needs a word boundary", () => {
    expect(cityFallback("부산 해운대")?.name).toBe("부산");
    expect(cityFallback("서울역")?.name).toBe("서울");
    expect(cityFallback("세종문화회관")).toBeNull();
    expect(cityFallback("고양이카페")).toBeNull();
  });
});
