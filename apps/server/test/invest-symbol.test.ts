/**
 * The symbol screen's server half (screens-more 0913 A1–A3, DD 0914 D2 · A3, team-lead 0931): the chart's levels in
 * levelChart's shape, its screen-reader sentence and foot, the note when there is no chart, and each recent alert's
 * line (the banner's title without the symbol). Upstreams are test/fake-toss.ts; nothing real is called.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { InvestSymbolDetail, ServerEvent } from "@pickle/protocol";
import { APP_THEME, levelChart, PHONE_CARD, type Bar } from "@pickle/quant";
import { etToEpoch } from "../src/invest/calendar.ts";
import type { RuleSpec } from "../src/invest/rules.ts";
import { alertLine, chartAria, chartFoot, chartLevels, chartNote, CHART_MIN_BARS, CHART_NOTE } from "../src/invest/symbol.ts";
import { makeInvestUpstream, syntheticBars } from "./fake-toss.ts";
import { makeHarness, type Harness } from "./helpers.ts";

const A = "2026-11-30";
const B = "2026-12-01";
const ET = (day: string, h: number, m: number) => etToEpoch(day, h, m);
const sec = (ms: number) => Math.floor(ms / 1000);

const spec = (o: Partial<RuleSpec> & { state?: string }): RuleSpec & { state: string } => ({
  symbol: "SOXL",
  kind: "stop",
  level: null,
  price: null,
  lo: null,
  hi: null,
  direction: "below",
  action: "notify",
  once: 0,
  buffer_pct: null,
  until_day: null,
  state: "armed",
  ...o,
});
/** closes rising by 0.1 a day: RSI 100 */
const rising = (n: number, from: number): Bar[] => syntheticBars(B, n, from, 1).map((b, i) => ({ ...b, c: from + i * 0.1 }));

// ───────────────────────────── pure ─────────────────────────────

describe("the chart's words (A1–A3)", () => {
  test("levels in levelChart's shape: stop, invalidate, targets by their level, alert, the buy zone as one band, resistance; expired and split-held left out", () => {
    const levels = chartLevels("US", [
      spec({ kind: "stop", price: 25.8 }),
      spec({ kind: "target", level: 1, price: 36.5, direction: "above" }),
      spec({ kind: "target", level: 3, price: 44, direction: "above" }),
      spec({ kind: "target", level: 2, price: 40, direction: "above", state: "expired" }),
      spec({ kind: "buy_zone", lo: 30, hi: 31.5, direction: "inside" }),
      spec({ kind: "resistance", price: 34, direction: "above", state: "hit" }),
      spec({ kind: "alert", price: 35, direction: "above" }),
      spec({ kind: "invalidate", price: 28, direction: "below" }),
      spec({ kind: "stop", price: 24, state: "paused" }),
      spec({ kind: "target", level: 2, price: 360, direction: "above", state: "paused", seen_slot: "@split" } as never),
    ]);
    // in the listed order, whatever order the rules come in
    expect(levels).toEqual([
      { kind: "stop", price: 25.8, label: "손절 $25.80 이하" },
      { kind: "stop", price: 24, label: "손절 $24.00 이하" },
      { kind: "invalidate", price: 28, label: "전략 무효화 $28.00 이하" },
      { kind: "target1", price: 36.5, label: "1차 익절 $36.50 이상" },
      { kind: "target3", price: 44, label: "3차 익절 $44.00 이상" },
      { kind: "alert", price: 35, label: "가격 알림 $35.00 이상" },
      { kind: "buyZone", price: 30, hi: 31.5, label: "매수 검토 $30.00–31.50" },
      { kind: "resistance", price: 34, label: "저항 $34.00" },
    ]);
    // levelChart takes them as they are: every level drawn or listed as an issue, none invalid
    const c = levelChart({ bars: rising(60, 30), levels, summary: "s" }, APP_THEME, PHONE_CARD);
    expect(c.issues.filter((i) => i.code === "level_invalid")).toEqual([]);
  });

  test("the screen reader's sentence after the chart's name (DD 1442 1): the close spoken, the levels plain, RSI when it can be counted", () => {
    const bars = rising(60, 30);
    const levels = chartLevels("US", [spec({ kind: "stop", price: 25.8 }), spec({ kind: "target", level: 1, price: 36.5, direction: "above" }), spec({ kind: "buy_zone", lo: 30, hi: 31.5, direction: "inside" })]);
    expect(chartAria("US", bars, levels)).toBe("11월 30일 종가 35.90달러. 손절 25.80, 1차 익절 36.50, 매수 검토 구간 30.00에서 31.50. RSI 100.");
    expect(chartAria("US", bars, [])).toBe("11월 30일 종가 35.90달러. RSI 100.");
    // alert and invalidate in levelChart's words (DD 1533: no $ on a chart label), the invalidation by the stop
    const more = chartLevels("US", [spec({ kind: "alert", price: 33, direction: "above" }), spec({ kind: "stop", price: 25.8 }), spec({ kind: "invalidate", price: 27.2, direction: "below" })]);
    expect(chartAria("US", bars, more)).toBe("11월 30일 종가 35.90달러. 손절 25.80, 무효화 27.20, 알림 33.00. RSI 100.");
    // 14 bars: no RSI yet
    expect(chartAria("US", bars.slice(-14), [])).toBe("11월 30일 종가 35.90달러.");
    const won = syntheticBars(B, 40, 70000, 1000).map((b, i) => ({ ...b, c: 70000 - i * 100 }));
    expect(chartAria("KR", won, chartLevels("KR", [spec({ symbol: "005930", kind: "stop", price: 65000 })]))).toBe("11월 30일 종가 66,100원. 손절 65,000. RSI 0.");
    // the app says the symbol, 일봉 and the days in front
    expect(chartAria("US", bars, levels)).not.toMatch(/SOXL|일봉|\d+일\./);
  });

  test("the foot; the note and its tone when there is no chart", () => {
    expect(chartFoot("2026-11-26", { name: "Yahoo(지연 시세)", grade: "B+" })).toBe("기준 11월 26일 종가 · Yahoo(지연 시세) · B+");
    expect(CHART_MIN_BARS).toBe(30);
    expect(chartNote({ source: false, bars: null })).toEqual({ chartNote: "시세를 받지 않아서 차트를 그리지 않아요.", chartNoteTone: "quiet" });
    expect(chartNote({ source: true, bars: null })).toEqual({ chartNote: "오늘 일봉을 받지 못해서 차트를 그리지 않아요.", chartNoteTone: "caution" });
    expect(chartNote({ source: true, bars: 29 })).toEqual({ chartNote: "일봉이 아직 모자라서 차트를 그리지 않아요.", chartNoteTone: "quiet" });
    expect(chartNote({ source: true, bars: 30 })).toBeNull();
  });

  test("an alert's line for every stored kind (DD 0914 D2), the rule's level first, the card title for the varying ones", () => {
    const line = (kind: string, title: string, level: number | null = null) => alertLine({ kind, title, symbol: "SOXL" }, level);
    expect([
      line("stop", "SOXL이 손절 관찰가에 닿았어요"),
      line("target", "SOXL이 2차 익절 관찰가에 닿았어요", 2),
      line("target", "SOXL이 3차 익절 관찰가에 닿았어요"), // the rule deleted: the title's level
      line("buy_zone", "SOXL이 매수 검토 구간에 들어왔어요"),
      line("resistance", "SOXL이 저항 $34.00을 넘었어요"),
      line("resistance", "SOXL이 저항 $34.00 위에 있어요"),
      line("invalidate", "SOXL 전략이 더는 맞지 않아요"),
      line("alert", "SOXL이 알림 가격 $30.00에 닿았어요"),
      line("expired", "SOXL 1차 익절 감시 기간이 끝났어요"),
      line("stop_record", "SOXL 모의 손절 기록"),
      line("stop_record", "SOXL 손절 주문 건너뜀"),
      line("gap", "SOXL이 전일 종가보다 5.0% 높게 시작했어요"),
      line("gap", "SOXL이 전일 종가보다 5.1% 낮게 시작했어요"),
      line("chase", "SOXL이 매수 검토 구간 위로 크게 벗어났어요"),
      line("split", "SOXL 가격 규칙을 멈췄어요"),
    ]).toEqual([
      "손절 관찰가 도달",
      "2차 익절 관찰가 도달",
      "3차 익절 관찰가 도달",
      "매수 검토 구간 진입",
      "저항 돌파",
      "저항 위",
      "전략 다시 보기",
      "내가 정한 가격 도달",
      "감시 기간 끝",
      "모의 손절 기록",
      "손절 주문 건너뜀",
      "갭 상승 출발",
      "갭 하락 출발",
      "매수 검토 구간 크게 벗어남",
      "가격 규칙 멈춤",
    ]);
  });
});

// ───────────────────────────── through the server ─────────────────────────────

interface World {
  h: Harness;
  up: ReturnType<typeof makeInvestUpstream>;
  uid: string;
  token: string;
  events: ServerEvent[];
}
const worlds: World[] = [];
afterEach(async () => {
  while (worlds.length) await worlds.pop()!.h.close();
});

async function world(o: { sources?: boolean; bars?: Bar[] | null } = {}): Promise<World> {
  const up = makeInvestUpstream();
  if (o.bars !== null) up.state.yahooDaily.set("SOXL", o.bars ?? syntheticBars(B, 60, 30, 1));
  const h = await makeHarness({ now: ET(A, 9, 0), config: { invest: { sources: o.sources ?? true, tossBase: null, outboundIp: null } }, deps: () => ({ investFetch: up.fetch }) });
  const me = await h.signup("alice");
  const uid = me.session.user.id;
  const events: ServerEvent[] = [];
  const pub = h.app.core.events.publish.bind(h.app.core.events);
  h.app.core.events.publish = (u, e) => {
    if (u === uid) events.push(e);
    pub(u, e);
  };
  const w = { h, up, uid, token: me.token, events };
  worlds.push(w);
  return w;
}
const api = async <T = unknown>(w: World, method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> => {
  const res = await w.h.req(method, path, { token: w.token, body });
  return { status: res.status, body: (await res.json()) as T };
};
async function rule(w: World, draft: Record<string, unknown>) {
  expect((await api(w, "POST", "/api/invest/rules", { draft: { symbol: "SOXL", action: "notify", ...draft } })).status).toBe(201);
}
function quote(w: World, at: number, price: number, prevClose: number, open?: { price: number; at: number }) {
  w.up.state.yahoo.set("SOXL", { price, prevClose, time: sec(at), ...(open ? { open: { price: open.price, time: sec(open.at) } } : {}) });
}
async function tickAt(w: World, day: string, h: number, m: number) {
  w.h.clock.t = ET(day, h, m);
  await w.h.app.core.invest.tick();
  await w.h.app.core.idle();
}
const detail = async (w: World) => (await api<InvestSymbolDetail>(w, "GET", "/api/invest/symbols/SOXL")).body;
/** the banners' titles without the symbol, sorted: alerts of one check come in rule order, and rule ids are random */
const bannerLines = (w: World) => w.events.flatMap((e) => (e.type === "notification" ? [e.title.replace(/^SOXL /, "")] : [])).sort();
const linesOf = (d: InvestSymbolDetail) => d.alerts.map((a) => a.line);

describe("GET /api/invest/symbols/:symbol", () => {
  test("the chart: levels, aria and foot from the bars it sends; the source and its day", async () => {
    const w = await world();
    quote(w, ET(A, 9, 0), 30, 30);
    expect((await api(w, "POST", "/api/invest/watchlist", { symbol: "SOXL" })).status).toBe(201);
    await rule(w, { kind: "stop", price: 25.8 });
    await rule(w, { kind: "buy_zone", lo: 28, hi: 29 });
    await rule(w, { kind: "alert", price: 35, direction: "above" });
    const d = await detail(w);
    expect(d.chart).toMatchObject({
      levels: [
        { kind: "stop", price: 25.8, label: "손절 $25.80 이하" },
        { kind: "alert", price: 35, label: "가격 알림 $35.00 이상" },
        { kind: "buyZone", price: 28, hi: 29, label: "매수 검토 $28.00–29.00" },
      ],
      asOf: "2026-11-30",
      source: { name: "Yahoo(지연 시세)", grade: "B+", asOf: "2026-11-30" },
      aria: "11월 30일 종가 30.00달러. 손절 25.80, 알림 35.00, 매수 검토 구간 28.00에서 29.00. RSI 50.", // flat closes: RSI 50
      foot: "기준 11월 30일 종가 · Yahoo(지연 시세) · B+",
    });
    expect(d.chart!.bars).toHaveLength(60);
    expect(d).not.toHaveProperty("chartNote");
  });

  test("no chart: sources off (quiet, nothing asked), bars not received (caution), fewer than 30 (quiet)", async () => {
    const off = await world({ sources: false });
    expect((await api(off, "POST", "/api/invest/watchlist", { symbol: "SOXL" })).status).toBe(201);
    expect(await detail(off)).toMatchObject({ chart: null, chartNote: CHART_NOTE.off, chartNoteTone: "quiet" });
    expect(off.up.calls).toEqual([]);
    const missed = await world({ bars: null });
    quote(missed, ET(A, 9, 0), 30, 30);
    expect((await api(missed, "POST", "/api/invest/watchlist", { symbol: "SOXL" })).status).toBe(201);
    expect(await detail(missed)).toMatchObject({ chart: null, chartNote: CHART_NOTE.missed, chartNoteTone: "caution" });
    const short = await world({ bars: syntheticBars(B, 29, 30, 1) });
    quote(short, ET(A, 9, 0), 30, 30);
    expect((await api(short, "POST", "/api/invest/watchlist", { symbol: "SOXL" })).status).toBe(201);
    expect(await detail(short)).toMatchObject({ chart: null, chartNote: CHART_NOTE.short, chartNoteTone: "quiet" });
  });

  test("each recent alert's line is its banner's title without the symbol (rule alerts, a run above the zone)", async () => {
    const w = await world();
    quote(w, ET(A, 9, 0), 30, 30);
    expect((await api(w, "POST", "/api/invest/watchlist", { symbol: "SOXL" })).status).toBe(201);
    await rule(w, { kind: "stop", price: 27 });
    await rule(w, { kind: "target", level: 1, price: 32 });
    await rule(w, { kind: "buy_zone", lo: 28, hi: 29 });
    await rule(w, { kind: "alert", price: 30.5, direction: "above" });
    for (const [m, p] of [[45, 28.5], [50, 31], [55, 33], [60, 26]] as const) {
      quote(w, ET(B, 9, m - 1), p, 30);
      await tickAt(w, B, 9 + Math.floor(m / 60), m % 60);
    }
    const d = await detail(w);
    expect([...linesOf(d)].sort()).toEqual(bannerLines(w));
    // newest check first; the 09:50 check's two in either order
    expect([linesOf(d).slice(0, 2), [...linesOf(d).slice(2, 4)].sort(), linesOf(d).slice(4)]).toEqual([["손절 관찰가 도달", "1차 익절 관찰가 도달"], ["내가 정한 가격 도달", "매수 검토 구간 크게 벗어남"], ["매수 검토 구간 진입"]]);
  });

  test("the same for a mock stop record, an expiry and a gap (one check's alerts newest-inserted first)", async () => {
    const w = await world();
    quote(w, ET(A, 9, 0), 30, 30);
    expect((await api(w, "POST", "/api/invest/watchlist", { symbol: "SOXL" })).status).toBe(201);
    await rule(w, { kind: "stop", price: 27, action: "sell" });
    await rule(w, { kind: "target", level: 1, price: 36, until: A });
    quote(w, ET(A, 16, 0), 30, 30);
    await tickAt(w, A, 16, 5);
    quote(w, ET(B, 9, 44), 26, 30, { price: 31.5, at: ET(B, 9, 30) });
    await tickAt(w, B, 9, 45);
    const d = await detail(w);
    expect([...linesOf(d)].sort()).toEqual(bannerLines(w));
    // one check's alerts: the newest inserted first (the gap goes after the rules)
    expect(linesOf(d)).toEqual(["갭 상승 출발", "모의 손절 기록", "감시 기간 끝"]);
  });
});
