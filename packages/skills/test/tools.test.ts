import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ResultListCard, WeatherCard } from "@pickle/protocol";
import type { ToolResult } from "@pickle/agent";
import {
  kDirections,
  kFineDust,
  kGasPrices,
  kGovSupport,
  kHanRiver,
  kHolidays,
  kHousingNotices,
  kLawSearch,
  kLibraryBooks,
  kNews,
  kPerformances,
  kPlaceSearch,
  kRealEstate,
  kSchoolLunch,
  kSeoulDensity,
  kSeoulBike,
  kShopping,
  kStock,
  kSubwayArrival,
  kTravelSafety,
  kWeather,
  resetHttpState,
  setFetch,
  USER_AGENT,
  wgs84ToKatec,
} from "../src/index";
import { ageMatches } from "../src/tools/gov";
import { parseDishes } from "../src/tools/school";
import { splitArticle } from "../src/tools/law";
import { stationName } from "../src/tools/transit";
import { matchHotspot } from "../src/tools/density";
import { buildWeather, type KmaResponse } from "../src/tools/weather";
import { quoteErrorText } from "../src/tools/finance";
import type { ProxyError } from "../src/http";
import { kst } from "../src/util";
import { fakeCtx, fixture, fixtureJson, json, mockProxy, SECRET_IDS, xml, type Recorded } from "./helpers";

let requests: Recorded[] = [];

beforeEach(() => resetHttpState());
afterEach(() => {
  // privacy invariant: nothing from ToolContext ever reaches the proxy
  for (const r of requests) {
    for (const secret of Object.values(SECRET_IDS)) {
      expect(r.url).not.toContain(secret);
      expect(r.url).not.toContain(encodeURIComponent(secret));
      expect(JSON.stringify(r.headers)).not.toContain(secret);
    }
    expect(r.headers["user-agent"]).toBe(USER_AGENT);
    expect(r.url.startsWith("https://k-skill-proxy.nomadamas.org/") || r.url.startsWith(process.env.KSKILL_PROXY_BASE_URL ?? "\u0000")).toBe(true);
  }
  requests = [];
  setFetch(null);
});

function results(r: ToolResult): ResultListCard {
  expect(r.card?.type).toBe("results");
  return r.card as ResultListCard;
}

function small(r: ToolResult): void {
  expect(new TextEncoder().encode(JSON.stringify(r.data ?? null)).length).toBeLessThanOrEqual(4096);
}

describe("k_weather", () => {
  test("geocodes via kakao, merges KMA now + forecast into a weather card", async () => {
    const m = mockProxy({
      "/v1/kakao-map/search/keyword": json("kakao_keyword.json"),
      "/v1/korea-weather/now": json("kma_now.json"),
      "/v1/korea-weather/forecast": json("kma_forecast.json"),
    });
    requests = m.requests;
    const ctx = fakeCtx();
    const r = await kWeather.run({ place: "강남역", days: 2 }, ctx);
    expect(r.ok).toBe(true);
    const card = r.card as WeatherCard;
    expect(card.type).toBe("weather");
    expect(card.place).toBe("강남역");
    expect(card.now.tempC).toBe(12.7); // T1H from 초단기실황
    expect(card.now.icon === "sun" || card.now.icon === "cloud").toBe(true);
    expect(card.hourly?.length).toBe(8);
    expect(card.hourly?.[0]?.hour).toBe("19시");
    expect(card.source).toBe("기상청");
    expect(r.summary).toMatch(/^강남역 13°, /);
    // 18:45 KST: today's TMX/TMN are no longer published → no fake "high" from evening hours; tomorrow instead
    expect(card.high).toBeUndefined();
    expect(r.summary).toContain("내일");
    expect(r.summary).toContain("5~16°");
    const data = r.data as { daily?: { high: number; low: number }[] };
    expect(data.daily?.[0]).toMatchObject({ high: 16, low: 5 }); // TMX/TMN for 11/12
    small(r);
    const kw = m.requests.find((q) => q.path === "/v1/kakao-map/search/keyword");
    expect(kw?.params).toEqual({ query: "강남역", size: "1" });
    const now = m.requests.find((q) => q.path === "/v1/korea-weather/now");
    expect(now?.params).toEqual({ lat: "37.4981", lon: "127.0280" });
    expect(ctx.statuses.length).toBeGreaterThan(0);
  });

  test("falls back to the built-in city table when geocoding fails", async () => {
    const m = mockProxy({
      "/v1/kakao-map/search/keyword": { status: 502, body: { error: "upstream_error", message: "kakao down" } },
      "/v1/korea-weather/now": json("kma_now.json"),
      "/v1/korea-weather/forecast": json("kma_forecast.json"),
    });
    requests = m.requests;
    const r = await kWeather.run({ place: "부산 해운대" }, fakeCtx());
    expect(r.ok).toBe(true);
    expect((r.card as WeatherCard).place).toBe("부산");
    expect(m.requests.find((q) => q.path === "/v1/korea-weather/now")?.params).toEqual({ lat: "35.1796", lon: "129.0756" });
  });

  test("observed 'no precipitation' (PTY 0) beats a rainy forecast slot", () => {
    const now = fixtureJson<KmaResponse>("kma_now.json");
    const fc = fixtureJson<KmaResponse>("kma_forecast.json");
    for (const it of fc.response!.body!.items!.item!) if (it.category === "PTY" && it.fcstTime === "1800" && it.fcstDate === "20261111") it.fcstValue = "1";
    const built = buildWeather("강남역", now, fc, kst(new Date("2026-11-11T09:45:00Z")), 0)!;
    expect(built.card.now.condition).not.toBe("비");
    const nowRain = structuredClone(now);
    for (const it of nowRain.response!.body!.items!.item!) if (it.category === "PTY") it.obsrValue = "1";
    expect(buildWeather("강남역", nowRain, fc, kst(new Date("2026-11-11T09:45:00Z")), 0)!.card.now.condition).toBe("비");
  });

  test("a clear sky is the sun by day and the moon from 19시 to 5시 (now and hourly)", () => {
    const now = fixtureJson<KmaResponse>("kma_now.json");
    for (const it of now.response!.body!.items!.item!) if (it.category === "PTY") it.obsrValue = "0";
    const fc = fixtureJson<KmaResponse>("kma_forecast.json");
    for (const it of fc.response!.body!.items!.item!) {
      if (it.category === "SKY") it.fcstValue = "1";
      if (it.category === "PTY") it.fcstValue = "0";
    }
    const evening = buildWeather("강남역", now, fc, kst(new Date("2026-11-11T09:45:00Z")), 0)!.card; // 18:45 KST
    expect(evening.now.icon).toBe("sun");
    expect(evening.hourly!.map((h) => [h.hour, h.icon])).toEqual(evening.hourly!.map((h) => [h.hour, "moon"])); // 19시–2시
    expect(evening.hourly!.length).toBeGreaterThan(0);
    const night = buildWeather("강남역", now, fc, kst(new Date("2026-11-11T14:10:00Z")), 0)!.card; // 23:10 KST
    expect(night.now.icon).toBe("moon");
    const morning = buildWeather("강남역", now, fc, kst(new Date("2026-11-11T23:45:00Z")), 0)!.card; // 08:45 KST
    expect(morning.now.icon).toBe("sun");
    expect(morning.hourly!.every((h) => h.icon === "sun")).toBe(true);
    // rain or clouds keep their icon at night
    for (const it of fc.response!.body!.items!.item!) if (it.category === "SKY") it.fcstValue = "4";
    expect(buildWeather("강남역", now, fc, kst(new Date("2026-11-11T14:10:00Z")), 0)!.card.now.icon).toBe("cloud");
  });

  test("missing place → ok:false without any request", async () => {
    const m = mockProxy({});
    requests = m.requests;
    const r = await kWeather.run({}, fakeCtx());
    expect(r.ok).toBe(false);
    expect(m.requests.length).toBe(0);
  });
});

describe("k_fine_dust", () => {
  test("upstream quota (429 behind a 502) → Korean '측정소 응답이 늦어요', ok:false, no retry", async () => {
    const m = mockProxy({ "/v1/fine-dust/report": json("fine_dust_quota_502.json", 502) });
    requests = m.requests;
    const r = await kFineDust.run({ place: "강남구" }, fakeCtx());
    expect(r.ok).toBe(false);
    expect(r.summary).toBe("미세먼지: 지금은 측정소 응답이 늦어요");
    expect(m.requests.length).toBe(1); // deterministic upstream failure → no retry
    expect(m.requests[0]?.params).toEqual({ regionHint: "강남구" });
  });

  test("parses the report (shape from the proxy's buildReport) and resolves station names via kakao", async () => {
    const report = {
      station_name: "강남구",
      station_address: "서울 강남구 학동로 426",
      lookup_mode: "fallback",
      measured_at: "2026-11-11 18:00",
      pm10: { value: "42", grade: "보통" },
      pm25: { value: "18", grade: "보통" },
      khai_grade: "보통",
    };
    const m = mockProxy({ "/v1/kakao-map/search/keyword": json("kakao_keyword.json"), "/v1/fine-dust/report": { body: report } });
    requests = m.requests;
    const r = await kFineDust.run({ place: "강남역" }, fakeCtx());
    expect(r.ok).toBe(true);
    expect(r.summary).toBe("강남역 미세먼지 보통 · 초미세먼지 보통");
    expect(m.requests.find((q) => q.path === "/v1/fine-dust/report")?.params).toEqual({ regionHint: "서울 강남구" });
    expect(results(r).items[0]?.subtitle).toBe("PM10 42㎍/㎥");
  });

  test("ambiguous location → retries once with the first candidate station", async () => {
    const m = mockProxy({
      "/v1/fine-dust/report": [
        { status: 400, body: { error: "ambiguous_location", message: "multiple", candidate_stations: ["우산동(광주)", "평동"] } },
        { body: { station_name: "우산동(광주)", pm10: { value: "30", grade: "좋음" }, pm25: { value: "10", grade: "좋음" }, khai_grade: "좋음" } },
      ],
    });
    requests = m.requests;
    const r = await kFineDust.run({ place: "광주 광산구" }, fakeCtx());
    expect(r.ok).toBe(true);
    expect(m.requests.map((q) => q.params)).toEqual([{ regionHint: "광주 광산구" }, { stationName: "우산동(광주)" }]);
    expect((r.data as { note?: string }).note).toContain("우산동(광주)");
  });
});

describe("k_subway_arrival", () => {
  test("strips 역, maps line ids, builds a results card", async () => {
    const m = mockProxy({ "/v1/seoul-subway/arrival": json("subway_arrival.json") });
    requests = m.requests;
    const r = await kSubwayArrival.run({ station: "강남역" }, fakeCtx());
    expect(r.ok).toBe(true);
    expect(m.requests[0]?.params).toEqual({ stationName: "강남" });
    const card = results(r);
    expect(card.title).toBe("강남역 실시간 도착");
    expect(card.items.some((i) => i.title.startsWith("2호선 성수행"))).toBe(true);
    expect(card.items.some((i) => i.title.startsWith("신분당선 신사행"))).toBe(true);
    expect(r.summary).toContain("강남역");
    small(r);
  });

  test("station helper", () => {
    expect(stationName("서울역")).toBe("서울");
    expect(stationName("강남역 2호선")).toBe("강남");
    expect(stationName("총신대입구(이수)")).toBe("총신대입구");
  });

  test("empty list → ok:false", async () => {
    requests = mockProxy({ "/v1/seoul-subway/arrival": { body: { errorMessage: { code: "INFO-200" }, realtimeArrivalList: [] } } }).requests;
    const r = await kSubwayArrival.run({ station: "없는역" }, fakeCtx());
    expect(r.ok).toBe(false);
  });
});

describe("k_seoul_bike", () => {
  test("nearby stations", async () => {
    const m = mockProxy({ "/v1/kakao-map/search/keyword": json("kakao_keyword.json"), "/v1/seoul-bike/nearby": json("bike_nearby.json") });
    requests = m.requests;
    const r = await kSeoulBike.run({ place: "광화문" }, fakeCtx());
    expect(r.ok).toBe(true);
    const card = results(r);
    expect(card.items[0]).toMatchObject({ title: "광화문역 1번출구 앞", meta: "144m" });
    expect(r.summary).toBe("광화문 근처 따릉이 대여소 5곳 · 대여 가능 36대");
    expect(m.requests.find((q) => q.path === "/v1/seoul-bike/nearby")?.params.radius_m).toBe("1000");
  });
});

describe("k_directions", () => {
  test("geocodes both ends and summarises duration / distance / taxi fare", async () => {
    const m = mockProxy({ "/v1/kakao-map/search/keyword": json("kakao_keyword.json"), "/v1/kakao-mobility/directions": json("directions.json") });
    requests = m.requests;
    const r = await kDirections.run({ origin: "강남역", destination: "서울역" }, fakeCtx());
    expect(r.ok).toBe(true);
    expect(r.summary).toBe("강남역 → 서울역 차로 약 44분 · 10.9km · 택시 약 18,100원");
    const d = r.data as { durationMin: number; taxiFareWon: number; mainRoads: string[]; mapUrl: string };
    expect(d.durationMin).toBe(44);
    expect(d.taxiFareWon).toBe(18100);
    expect(d.mainRoads).toContain("사평대로");
    expect(d.mapUrl).toStartWith("https://map.kakao.com/link/from/");
    const dir = m.requests.find((q) => q.path === "/v1/kakao-mobility/directions");
    expect(dir?.params.origin).toBe("127.028001,37.498086");
  });
});

describe("k_place_search", () => {
  test("results card with address / phone / url", async () => {
    const m = mockProxy({ "/v1/kakao-map/search/keyword": json("kakao_keyword.json") });
    requests = m.requests;
    const r = await kPlaceSearch.run({ query: "카페", near: "강남역", limit: 3 }, fakeCtx());
    expect(r.ok).toBe(true);
    expect(m.requests[0]?.params.query).toBe("강남역 카페");
    const card = results(r);
    expect(card.items).toHaveLength(3);
    expect(card.items[2]).toMatchObject({ title: "놀숲 강남역점", subtitle: "서울 강남구 강남대로98길 17", url: "http://place.map.kakao.com/798713718" });
    expect(card.items[2]?.meta).toContain("02-558-5846");
  });
});

describe("k_news", () => {
  test("cleans titles and keeps links", async () => {
    const m = mockProxy({ "/v1/naver-news/search": json("naver_news.json") });
    requests = m.requests;
    const r = await kNews.run({ query: "AI", limit: 3 }, fakeCtx());
    expect(r.ok).toBe(true);
    expect(m.requests[0]?.params).toMatchObject({ query: "AI", sort: "date" });
    const card = results(r);
    expect(card.items).toHaveLength(3);
    expect(card.items[0]?.title).toBe('"AI 3대 강국"…기업가치 1조 스타트업 20곳 키운다');
    expect(card.items[0]?.url).toStartWith("https://n.news.naver.com/");
    expect(card.items[0]?.meta).toBe("11/11 14:00 · newsis.com"); // time first: a narrow card cuts the end
  });
});

describe("k_shopping", () => {
  test("partner ban (real 502 upstream_forbidden) → ok:false + route breaker", async () => {
    const m = mockProxy({ "/v1/coupang/products/search": json("coupang_forbidden_502.json", 502) });
    requests = m.requests;
    const r1 = await kShopping.run({ query: "생수" }, fakeCtx());
    expect(r1.ok).toBe(false);
    expect(r1.summary).toContain("쿠팡 검색이 지금은 제한돼 있어요");
    const r2 = await kShopping.run({ query: "라면" }, fakeCtx());
    expect(r2.ok).toBe(false);
    expect(m.requests.length).toBe(1); // breaker short-circuits the second call
  });

  test("formats ₩ prices (shape from the proxy's normalizeCoupangProducts)", async () => {
    const body = {
      items: [
        { rank: 1, product_id: "1", title: "삼다수 2L 12병", price: 12340, url: "https://link.coupang.com/a/x", is_rocket: true, score: 4.5, review_count: 1234 },
        { rank: 2, product_id: "2", title: "아이시스 2L 12병", price: 9980, url: "https://link.coupang.com/a/y", is_free_shipping: true },
      ],
    };
    requests = mockProxy({ "/v1/coupang/products/search": { body } }).requests;
    const r = await kShopping.run({ query: "생수 2L", limit: 2 }, fakeCtx());
    expect(r.ok).toBe(true);
    expect(r.summary).toBe("쿠팡 ‘생수 2L’ 2개 · 최저 ₩9,980");
    expect(results(r).items[0]).toMatchObject({ subtitle: "₩12,340 · 로켓배송", meta: "★4.5 (1,234)" });
  });
});

describe("k_gas_prices", () => {
  test("WGS84 → KATEC matches the k-skill reference value", () => {
    const k = wgs84ToKatec(37.55472, 126.97068);
    expect(k.x).toBeCloseTo(309252.2237, 3);
    expect(k.y).toBeCloseTo(550779.9944, 3);
  });

  test("sends KATEC + product code, sorts by price", async () => {
    const around = {
      RESULT: {
        OIL: [
          { UNI_ID: "A2", POLL_DIV_CO: "RTE", OS_NM: "만리알뜰주유소", PRICE: "1649", DISTANCE: "315.0" },
          { UNI_ID: "A1", POLL_DIV_CO: "SKE", OS_NM: "서울역셀프주유소", PRICE: "1635", DISTANCE: "112.4" },
        ],
      },
    };
    const m = mockProxy({ "/v1/kakao-map/search/keyword": json("kakao_keyword.json"), "/v1/opinet/around": { body: around } });
    requests = m.requests;
    const r = await kGasPrices.run({ place: "강남역", fuel: "diesel" }, fakeCtx());
    expect(r.ok).toBe(true);
    const q = m.requests.find((x) => x.path === "/v1/opinet/around")!.params;
    expect(q).toMatchObject({ x: "314252", y: "544441", prodcd: "D047", sort: "1", radius: "3000" });
    expect(r.summary).toBe("강남역 근처 경유 최저 ₩1,635/L · 서울역셀프주유소");
    expect(results(r).items[0]?.subtitle).toBe("₩1,635/L · SK에너지");
  });

  test("empty Opinet result (recorded) → ok:true with an explanatory summary", async () => {
    requests = mockProxy({ "/v1/kakao-map/search/keyword": json("kakao_keyword.json"), "/v1/opinet/around": json("opinet_empty.json") }).requests;
    const r = await kGasPrices.run({ place: "강남역" }, fakeCtx());
    expect(r.ok).toBe(true);
    expect(r.summary).toContain("가격 정보가 없어요");
  });
});

describe("k_holidays", () => {
  test("parses the KASI XML and finds the next holiday", async () => {
    const m = mockProxy({ "/v1/korean-holiday/calendar": xml("holidays_2026.xml") });
    requests = m.requests;
    const r = await kHolidays.run({}, fakeCtx());
    expect(r.ok).toBe(true);
    expect(m.requests[0]?.params).toEqual({ year: "2026", operation: "rest" });
    const d = r.data as { holidays: { date: string; name: string }[]; next: { name: string; inDays: number } };
    expect(d.holidays[0]).toMatchObject({ date: "2026-01-01", name: "1월1일" });
    expect(d.next.name).toBe("기독탄신일");
    expect(d.next.inDays).toBe(44);
    expect(r.summary).toContain("다음은 12/25 (금) 기독탄신일 (D-44)");
  });
});

describe("k_performances", () => {
  test("parses KOPIS XML, maps region code, filters by title client-side", async () => {
    const m = mockProxy({ "/v1/kopis/performances": xml("kopis_performances.xml") });
    requests = m.requests;
    const r = await kPerformances.run({ region: "서울", genre: "뮤지컬" }, fakeCtx());
    expect(r.ok).toBe(true);
    expect(m.requests[0]?.params).toMatchObject({ stdate: "20261111", eddate: "20261211", signgucode: "11", shcate: "GGGA" });
    expect(results(r).items.length).toBeGreaterThan(0);
    const bad = await kPerformances.run({ region: "아틀란티스" }, fakeCtx());
    expect(bad.ok).toBe(false);
    const r2 = await kPerformances.run({ query: "언행순" }, fakeCtx());
    expect(results(r2).items.map((i) => i.title)).toEqual(["언제는 행복하지 않은 순간이 있었나요 (언행순) [서울]"]);
  });
});

describe("k_travel_safety", () => {
  test("alert level and regions", async () => {
    const m = mockProxy({ "/v1/mofa-travel-safety/travel-alerts": json("mofa.json") });
    requests = m.requests;
    const r = await kTravelSafety.run({ country: "일본" }, fakeCtx());
    expect(r.ok).toBe(true);
    expect(r.summary).toStartWith("일본: 일부 지역 3단계 출국권고 — 후쿠시마");
    await kTravelSafety.run({ country: "jp" }, fakeCtx());
    expect(m.requests[1]?.params).toMatchObject({ countryIsoAlp2: "JP" });
  });

  test("empty list is not reported as 'safe'", async () => {
    const m = mockProxy({ "/v1/mofa-travel-safety/travel-alerts": { body: { items: [], total_count: 0 } } });
    requests = m.requests;
    const r = await kTravelSafety.run({ country: "UK" }, fakeCtx());
    expect(m.requests[0]?.params).toMatchObject({ countryIsoAlp2: "GB" });
    expect(r.summary).toContain("목록에 없어요");
    expect((r.data as { found: boolean }).found).toBe(false);
  });
});

describe("k_stock", () => {
  test("listing from search; trade-info 401 is reported, not thrown", async () => {
    const m = mockProxy({
      "/v1/korean-stock/search": json("korean_stock_search.json"),
      "/v1/korean-stock/trade-info": json("korean_stock_trade_info_401_502.json", 502),
    });
    requests = m.requests;
    const r = await kStock.run({ query: "삼성전자" }, fakeCtx());
    expect(r.ok).toBe(true);
    expect(r.summary).toBe("삼성전자 (KOSPI 005930) · 시세를 지금 못 가져와요");
    expect(m.requests.filter((q) => q.path === "/v1/korean-stock/trade-info")).toHaveLength(1); // 401 → no retry
    const d = r.data as { listing: { code: string }; quoteAvailable: boolean; quoteError: string; quoteUrl: string; hint: string; note?: string };
    expect(d.listing.code).toBe("005930");
    expect(d.quoteAvailable).toBe(false);
    expect(d.quoteError).toBe("거래소 시세 제공처가 지금 KOSPI 시세를 주지 않아요");
    expect(JSON.stringify(r.data)).not.toMatch(/401|Unauthorized|KRX API HTTP/); // nothing for a voice call to read out
    expect(d.quoteUrl).toBe("https://finance.naver.com/item/main.naver?code=005930");
    expect(d.hint).toContain("추측");
    expect(d.note).toBeUndefined(); // no "직전 거래일 종가" note when there is no price
    expect(results(r).items[0]?.title).toBe("시세를 지금 가져올 수 없어요");
    expect(results(r).items[0]?.url).toBe(d.quoteUrl);
  });

  test("while the trade-info breaker is open, a second lookup makes no trade-info call", async () => {
    const m = mockProxy({
      "/v1/korean-stock/search": json("korean_stock_search.json"),
      "/v1/korean-stock/trade-info": json("korean_stock_trade_info_401_502.json", 502),
    });
    requests = m.requests;
    await kStock.run({ query: "삼성전자" }, fakeCtx());
    const r = await kStock.run({ query: "005930" }, fakeCtx());
    expect(r.ok).toBe(true);
    expect((r.data as { quoteAvailable: boolean }).quoteAvailable).toBe(false);
    expect(m.requests.filter((q) => q.path === "/v1/korean-stock/trade-info")).toHaveLength(1);
  });

  test("a KOSPI 401 closes the breaker for KOSPI only: KOSDAQ quotes still load", async () => {
    const listing = (market: string, code: string, short_name: string) => ({ market, code, short_name, name: short_name, stock_kind: "보통주" });
    const m = mockProxy({
      "/v1/korean-stock/search": (req) =>
        new Response(
          JSON.stringify({ items: [req.params.q === "에코프로비엠" ? listing("KOSDAQ", "247540", "에코프로비엠") : listing("KOSPI", req.params.q === "SK하이닉스" ? "000660" : "005930", req.params.q ?? "")] }),
          { status: 200 },
        ),
      "/v1/korean-stock/trade-info": (req) =>
        req.params.market === "KOSPI"
          ? new Response(fixture("korean_stock_trade_info_401_502.json"), { status: 502 })
          : new Response(JSON.stringify({ item: { date: "20261110", close_price: 151200, fluctuation_rate: -0.4 } }), { status: 200 }),
    });
    requests = m.requests;
    const samsung = await kStock.run({ query: "삼성전자" }, fakeCtx());
    const ecopro = await kStock.run({ query: "에코프로비엠" }, fakeCtx());
    const hynix = await kStock.run({ query: "SK하이닉스" }, fakeCtx());
    expect(samsung.summary).toBe("삼성전자 (KOSPI 005930) · 시세를 지금 못 가져와요");
    expect(ecopro.summary).toBe("에코프로비엠 ₩151,200 (-0.4%) · 20261110 종가");
    expect(hynix.summary).toBe("SK하이닉스 (KOSPI 000660) · 시세를 지금 못 가져와요");
    const trade = m.requests.filter((q) => q.path === "/v1/korean-stock/trade-info").map((q) => q.params.market);
    expect(trade).toEqual(["KOSPI", "KOSDAQ"]); // the second KOSPI lookup is short-circuited by the KOSPI breaker
  });

  test("quote error sentences carry no status codes", () => {
    const e = (message: string, extra: Partial<ProxyError> = {}): ProxyError => ({ kind: "upstream", status: 502, message, ...extra });
    expect(quoteErrorText(e("KRX API HTTP 오류 (status: 401): Unauthorized"), "KOSPI")).toBe("거래소 시세 제공처가 지금 KOSPI 시세를 주지 않아요");
    expect(quoteErrorText(e("x", { body: { upstream: { status_code: 429 } } }), "KOSDAQ")).toBe("거래소 시세 조회 한도가 차서 지금은 못 가져와요");
    expect(quoteErrorText({ kind: "timeout", status: 0, message: "timeout" }, "KOSPI")).toBe("거래소 시세 응답이 너무 늦어요");
    expect(quoteErrorText(e("Bad Gateway"), "KOSPI")).toBe("거래소 시세 서비스가 지금 원활하지 않아요");
    expect(quoteErrorText(null, "KONEX")).toContain("KONEX 가격이 없어요");
  });

  test("quote formatting when trade-info works (shape from the proxy's krx-stock normalizer)", async () => {
    requests = mockProxy({
      "/v1/korean-stock/search": json("korean_stock_search.json"),
      "/v1/korean-stock/trade-info": { body: { item: { date: "20261110", close_price: 98700, change_price: 1200, fluctuation_rate: 1.23, high_price: 99000, low_price: 97000, volume: 12345678, market_cap: 589e12 } } },
    }).requests;
    const r = await kStock.run({ query: "005930" }, fakeCtx());
    expect(r.summary).toBe("삼성전자 ₩98,700 (+1.23%) · 20261110 종가");
    expect(results(r).items[0]?.meta).toBe("시총 589.0조원");
    const d = r.data as { quoteAvailable: boolean; hint?: string; quoteError?: string; note?: string };
    expect(d.quoteAvailable).toBe(true);
    expect(d.hint).toBeUndefined();
    expect(d.quoteError).toBeUndefined();
    expect(d.note).toContain("직전 거래일");
  });
});

describe("k_real_estate", () => {
  test("region code → apartment trades with 억/만원 formatting", async () => {
    const m = mockProxy({
      "/v1/real-estate/region-code": json("real_estate_region_code.json"),
      "/v1/real-estate/apartment/trade": json("real_estate_apartment_trade.json"),
    });
    requests = m.requests;
    const r = await kRealEstate.run({ region: "마포구" }, fakeCtx());
    expect(r.ok).toBe(true);
    expect(m.requests[1]?.params).toEqual({ lawd_cd: "11440", deal_ymd: "202610", num_of_rows: "1000" });
    expect(r.summary).toMatch(/^서울특별시 마포구 2026년 10월 아파트 매매 \d+건 · 중위 /);
    expect(results(r).items[0]?.subtitle).toMatch(/억|만원/);
  });

  test("ambiguous region asks for clarification", async () => {
    requests = mockProxy({
      "/v1/real-estate/region-code": { body: { results: [{ lawd_cd: "11140", name: "서울특별시 중구" }, { lawd_cd: "26110", name: "부산광역시 중구" }] } },
    }).requests;
    const r = await kRealEstate.run({ region: "중구", yearMonth: "202609" }, fakeCtx());
    expect(r.ok).toBe(false);
    expect(r.summary).toContain("여러 곳");
  });
});

describe("k_law_search", () => {
  test("search + article detail", async () => {
    const m = mockProxy({ "/v1/korean-law/search": json("korean_law_search.json"), "/v1/korean-law/detail": json("korean_law_detail.json") });
    requests = m.requests;
    const r = await kLawSearch.run({ query: "주택임대차보호법 제3조" }, fakeCtx());
    expect(r.ok).toBe(true);
    expect(m.requests[0]?.params).toMatchObject({ target: "law", query: "주택임대차보호법" });
    expect(m.requests[1]?.params).toEqual({ target: "law", MST: "276291", JO: "000300" });
    const d = r.data as { article: { text: string }; laws: { url: string }[] };
    expect(d.article.text).toContain("주민등록");
    expect(d.laws[0]?.url).toBe(`https://www.law.go.kr/법령/${encodeURIComponent("주택임대차보호법")}`);
    expect(JSON.stringify(r)).not.toContain("OC=");
  });

  test("article parser", () => {
    expect(splitArticle("근로기준법 제60조")).toEqual({ name: "근로기준법", jo: "006000", label: "제60조" });
    expect(splitArticle("주택임대차보호법 제3조의2")).toEqual({ name: "주택임대차보호법", jo: "000302", label: "제3조의2" });
    expect(splitArticle("민법")).toEqual({ name: "민법" });
  });
});

describe("k_gov_support", () => {
  test("merges K-Startup + survey, keeps only open programmes, sorts by deadline", async () => {
    const m = mockProxy({
      "/v1/kstartup/announcements": json("kstartup_announcements.json"),
      "/v1/government-support/survey": json("gov_support_survey.json"),
    });
    requests = m.requests;
    const r = await kGovSupport.run({ region: "서울", age: 29 }, fakeCtx());
    expect(r.ok).toBe(true);
    expect(m.requests.find((q) => q.path === "/v1/government-support/survey")?.params.sources).toBe("bizinfo,nipa,kocca,smtech");
    const d = r.data as { programmes: { title: string; daysLeft?: number }[] };
    expect(d.programmes.length).toBeGreaterThan(0);
    const days = d.programmes.map((p) => p.daysLeft ?? 9999);
    expect([...days].sort((a, b) => a - b)).toEqual(days);
    expect(days.every((x) => x >= 0)).toBe(true);
    // a programme tagged for another province is excluded
    expect(d.programmes.some((p) => p.title.startsWith("[강원]"))).toBe(false);
    expect(results(r).items[0]?.meta).toMatch(/D-\d+|오늘 마감|미정/);
    small(r);
  });

  test("city names map to their 시/도; unknown regions ask instead of silently ignoring", async () => {
    const m = mockProxy({
      "/v1/kstartup/announcements": json("kstartup_announcements.json"),
      "/v1/government-support/survey": json("gov_support_survey.json"),
    });
    requests = m.requests;
    const ok = await kGovSupport.run({ region: "춘천" }, fakeCtx());
    expect(ok.ok).toBe(true);
    expect(ok.summary).toStartWith("강원 ");
    const bad = await kGovSupport.run({ region: "아틀란티스" }, fakeCtx());
    expect(bad.ok).toBe(false);
    expect(bad.summary).toContain("시·도");
  });

  test("one source failing still returns the other", async () => {
    requests = mockProxy({
      "/v1/kstartup/announcements": json("kstartup_announcements.json"),
      "/v1/government-support/survey": { status: 504, body: { error: "upstream_timeout", message: "slow" } },
    }).requests;
    const r = await kGovSupport.run({ keyword: "창업" }, fakeCtx());
    expect(r.ok).toBe(true);
    expect((r.data as { sourcesFailed?: string[] }).sourcesFailed).toEqual(["기업마당·NIPA·KOCCA·SMTECH"]);
  });

  test("age bands", () => {
    expect(ageMatches("만 20세 이상 ~ 만 39세 이하", 29)).toBe(true);
    expect(ageMatches("만 20세 이상 ~ 만 39세 이하", 45)).toBe(false);
    expect(ageMatches("만 20세 미만,만 40세 이상", 30)).toBe(false);
    expect(ageMatches("", 70)).toBe(true);
  });
});

describe("k_housing_notices", () => {
  test("filters LH notices to open housing ones, sorted by closing date", async () => {
    const m = mockProxy({ "/v1/lh-notice/search": json("lh_notice_search.json") });
    requests = m.requests;
    const r = await kHousingNotices.run({}, fakeCtx());
    expect(r.ok).toBe(true);
    const d = r.data as { notices: { kind: string; status: string; deadline: string }[] };
    expect(d.notices.every((n) => ["분양", "임대", "주거복지"].includes(n.kind))).toBe(true);
    expect(d.notices.every((n) => n.status === "공고중" || n.status === "접수중")).toBe(true);
    const dl = d.notices.map((n) => n.deadline || "99999999");
    expect([...dl].sort()).toEqual(dl);
  });
});

describe("k_school_lunch", () => {
  test("office from school name → school code → meal with allergens", async () => {
    const m = mockProxy({ "/v1/neis/school-search": json("neis_school_search.json"), "/v1/neis/school-meal": json("neis_school_meal.json") });
    requests = m.requests;
    const r = await kSchoolLunch.run({ school: "서울고등학교", date: "20261110" }, fakeCtx());
    expect(r.ok).toBe(true);
    expect(m.requests[0]?.params).toMatchObject({ educationOffice: "B10", schoolName: "서울고등학교" });
    expect(m.requests[1]?.params).toEqual({ educationOfficeCode: "B10", schoolCode: "7010083", mealDate: "20261110" });
    expect(r.summary).toBe("서울고등학교 11/10 (화) 중식: 쌀밥(추가밥), 쌀국수, 미니반미샌드위치, 공심채볶음");
    expect(results(r).items[0]?.title).toBe("중식 · 559.1 Kcal");
  });

  test("no meal that day → ok:true with an explanation", async () => {
    requests = mockProxy({ "/v1/neis/school-search": json("neis_school_search.json"), "/v1/neis/school-meal": json("neis_school_meal_nodata.json") }).requests;
    const r = await kSchoolLunch.run({ school: "서울고등학교", date: "2026-11-08" }, fakeCtx());
    expect(r.ok).toBe(true);
    expect(r.summary).toContain("급식 정보가 없어요");
  });

  test("dish parser", () => {
    expect(parseDishes("쌀밥(추가밥) <br/>쌀국수 (2.5.6.12.13.15.16)<br/>리치에이드 ")).toEqual([
      { name: "쌀밥(추가밥)", allergens: [] },
      { name: "쌀국수", allergens: [2, 5, 6, 12, 13, 15, 16] },
      { name: "리치에이드", allergens: [] },
    ]);
  });
});

describe("k_library_books", () => {
  test("book search ranks title matches first, lists libraries for a region", async () => {
    const m = mockProxy({ "/v1/data4library/book-search": json("data4library_book_search.json"), "/v1/data4library/libraries-by-book": json("data4library_libraries_by_book.json") });
    requests = m.requests;
    const r = await kLibraryBooks.run({ query: "채식주의자", region: "서울" }, fakeCtx());
    expect(r.ok).toBe(true);
    expect(m.requests[1]?.params).toMatchObject({ isbn: "9788936433598", region: "11" });
    expect(r.summary).toBe("‘채식주의자’ 한강 · 서울 소장 도서관 293곳");
    expect(results(r).items.some((i) => i.icon === "house")).toBe(true);
  });

  test("no title match (recorded '소년이 온다' search) → honest summary, no holdings lookup", async () => {
    const m = mockProxy({ "/v1/data4library/book-search": json("data4library_book_search_nomatch.json"), "/v1/data4library/libraries-by-book": json("data4library_libraries_by_book.json") });
    requests = m.requests;
    const r = await kLibraryBooks.run({ query: "소년이 온다", region: "경기" }, fakeCtx());
    expect(r.ok).toBe(true);
    expect(r.summary).toContain("일치하는 책은 못 찾았어요");
    expect(m.requests.some((q) => q.path === "/v1/data4library/libraries-by-book")).toBe(false);
    expect((r.data as { exactMatch: boolean }).exactMatch).toBe(false);
  });
});

describe("k_han_river", () => {
  test("water level with threshold status", async () => {
    const m = mockProxy({ "/v1/han-river/water-level": json("hanriver.json") });
    requests = m.requests;
    const r = await kHanRiver.run({}, fakeCtx());
    expect(r.ok).toBe(true);
    expect(m.requests[0]?.params).toEqual({ stationName: "한강대교" });
    expect(r.summary).toBe("서울시(한강대교) 수위 0.59m · 평상시");
  });
});

describe("k_seoul_density", () => {
  test("matches a hotspot name and reports crowd level + forecast", async () => {
    const m = mockProxy({ "/v1/seoul-density/citydata": json("seoul_density.json") });
    requests = m.requests;
    const r = await kSeoulDensity.run({ place: "성수" }, fakeCtx());
    expect(r.ok).toBe(true);
    expect(m.requests[0]?.params).toEqual({ area: "성수카페거리" });
    expect(r.summary).toBe("성수카페거리 지금 약간 붐빔 · 약 3.2만~3.4만명");
    expect(results(r).items[1]?.title).toBe("20:00 보통");
  });

  test("hotspot matcher", () => {
    expect(matchHotspot("강남역")).toEqual(["강남역"]);
    expect(matchHotspot("홍대")).toEqual(["홍대 관광특구"]);
    expect(matchHotspot("홍대입구역")).toEqual(["홍대입구역(2호선)"]);
    expect(matchHotspot("여의도 한강공원")[0]).toBe("여의도한강공원");
    expect(matchHotspot("광화문")[0]).toBe("광화문·덕수궁");
    expect(matchHotspot("부산역")).toEqual([]);
    expect(matchHotspot("서울숲 카페")[0]).toBe("서울숲공원");
    expect(matchHotspot("서울대공원 동물원")[0]).toBe("서울대공원");
  });

  test("unsupported place → ok:false without a request", async () => {
    const m = mockProxy({});
    requests = m.requests;
    const r = await kSeoulDensity.run({ place: "해운대" }, fakeCtx());
    expect(r.ok).toBe(false);
    expect(m.requests.length).toBe(0);
  });
});

test("fixtures contain no proxy-operator ids or contact numbers we stripped", () => {
  expect(fixture("korean_law_search.json")).not.toContain("OC=");
  expect(fixture("kstartup_announcements.json")).not.toContain("prch_cnpl_no");
});
