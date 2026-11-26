/**
 * Invest B2b-1: the agent's invest tools and the rule proposals (A12 · G8-5, DD 1935 §2-3, agent-runtime 0212 · 0221).
 * The model reads code-computed figures, writes only through the person's paths as author "model", and never changes a
 * rule: a proposal is a card, and only the person's decision (POST /api/invest/proposals/:id) applies it — and only
 * while every rule it names is as it was, the order mode and the sellable quantity are the same, and it has not
 * expired. Upstreams are test/fake-toss.ts (synthetic bodies); nothing real is called, no model is called.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { CredentialAccess, ToolContext, ToolDef, ToolResult } from "@pickle/agent";
import type { Card, InvestEventCard, InvestForecast, InvestRuleChangeCard, InvestRuleRow } from "@pickle/protocol";
import { bollinger, sma, usd, type Bar } from "@pickle/quant";
import { etToEpoch } from "../src/invest/calendar.ts";
import * as idb from "../src/invest/db.ts";
import { MAX_RULES } from "../src/invest/routes.ts";
import { writeLedger } from "../src/invest/ledger.ts";
import { PROPOSAL_TTL_MS, proposalRow, REQUEST_FOOT, settleInvestCards } from "../src/invest/proposals.ts";
import { ieyo } from "../src/invest/rules.ts";
import { investTools, PROPOSE_NOTE } from "../src/invest/tools.ts";
import { buildTools } from "../src/turns.ts";
import { BOGUS_TOSS_SECRET, FAKE_TOSS_BASE, makeInvestUpstream, syntheticBars } from "./fake-toss.ts";
import { makeFakeVault, makeHarness, outcome, readSse, type Harness } from "./helpers.ts";

const DAY = "2026-11-30"; // a Monday, a full session
const ET = (h: number, m: number, day = DAY) => etToEpoch(day, h, m);

type Up = ReturnType<typeof makeInvestUpstream>;
interface World {
  h: Harness;
  up: Up;
  uid: string;
  token: string;
  thread: string;
}

function tossVault(v: ReturnType<typeof makeFakeVault>): ReturnType<typeof makeFakeVault> {
  return {
    ...v,
    access(userId, o) {
      const a = v.access(userId, o);
      const use: CredentialAccess["use"] = (id, p, fn) => a.use(id, p, () => fn({ ...BOGUS_TOSS_SECRET }));
      return { ...a, use };
    },
  };
}

const worlds: World[] = [];
async function world(o: { sources?: boolean } = {}): Promise<World> {
  const up = makeInvestUpstream();
  const h = await makeHarness({
    now: ET(9, 0),
    config: { invest: { sources: o.sources ?? false, tossBase: FAKE_TOSS_BASE, outboundIp: "203.0.113.7" } },
    deps: ({ vault }) => ({ investFetch: up.fetch, vault: tossVault(vault) }),
  });
  const me = await h.signup("alice");
  const w = { h, up, uid: me.session.user.id, token: me.token, thread: me.session.mainThreadId };
  worlds.push(w);
  return w;
}
afterEach(async () => {
  while (worlds.length) await worlds.pop()!.h.close();
});

const api = async <T = unknown>(w: World, method: string, path: string, body?: unknown, token = w.token): Promise<{ status: number; body: T }> => {
  const res = await w.h.req(method, path, { token, body });
  return { status: res.status, body: (await res.json()) as T };
};
async function watch(w: World, symbol: string) {
  expect([200, 201]).toContain((await api(w, "POST", "/api/invest/watchlist", { symbol })).status);
}
async function addRule(w: World, draft: Record<string, unknown>): Promise<InvestRuleRow> {
  const r = await api<InvestRuleRow>(w, "POST", "/api/invest/rules", { draft });
  expect(r.status).toBe(201);
  return r.body;
}
async function connectToss(w: World) {
  const envelope = { v: 1, alg: "ECDH-P256+HKDF-SHA256+A256GCM", kid: "kid-test", epk: { kty: "EC" }, iv: "aXY", ct: "Y3Q", aad: `${w.uid}:toss-investment:token` };
  expect((await api(w, "POST", "/api/credentials", { service: "toss-investment", label: "토스증권", kind: "token", hint: "계좌 1개", keepFor: "forever", envelope })).status).toBe(201);
  await w.h.app.core.idle();
}

function tools(w: World, uid = w.uid): Record<string, ToolDef> {
  return Object.fromEntries(investTools(w.h.app.core, uid).map((t) => [t.name, t]));
}
function ctxOf(w: World, o: Partial<ToolContext> = {}): ToolContext {
  return { userId: w.uid, threadId: w.thread, agentName: "모시", displayName: "앨리스", now: () => new Date(w.h.clock.t), status: () => {}, ...o } as unknown as ToolContext;
}
async function run(w: World, name: string, args: Record<string, unknown>, o: Partial<ToolContext> = {}): Promise<ToolResult> {
  const t = tools(w)[name]; // offered to alice; a run works for ctx.userId only
  if (!t) throw new Error(`no tool ${name}`);
  return t.run(args, ctxOf(w, o));
}
const BASIS = { basis: "request" };
async function propose(w: World, changes: Record<string, unknown>[], symbol = "SOXL", o: Partial<ToolContext> = {}) {
  return run(w, "invest_watch_propose", { symbol, changes, reason: "ATR 두 배 아래로 손절을 올려요", ...BASIS }, o);
}
const rule = (w: World, id: string) => idb.rule(w.h.db, w.uid, id)!;
/** a stored assistant message showing the card, as a turn would have stored it */
function storeCard(w: World, card: Card): string {
  const id = `m-${Math.random().toString(36).slice(2)}`;
  w.h.db.insertMessage({ id, threadId: w.thread, role: "assistant", text: "제안이에요", cards: [card], createdAt: w.h.clock.t });
  return id;
}
const storedCards = (w: World, id: string) => JSON.parse((w.h.db.sql.query("SELECT cards_json FROM messages WHERE id = $id").get({ id }) as { cards_json: string }).cards_json) as Card[];
const decide = (w: World, id: string, decision: unknown, token = w.token) => api<{ card?: InvestRuleChangeCard; error?: string }>(w, "POST", `/api/invest/proposals/${id}`, { decision }, token);

describe("which turns get the invest tools", () => {
  test("only someone who uses invest, only in their own threads, never with others present", async () => {
    const w = await world();
    const names = (kind: "main" | "friend", others?: boolean) => buildTools(w.h.app.core, kind, undefined, "on", w.uid, others).map((d) => d.name).filter((n) => n.startsWith("invest_"));
    expect(names("main")).toEqual([]);
    await watch(w, "SOXL");
    expect(names("main").sort()).toEqual(["invest_event_add", "invest_events", "invest_forecast_add", "invest_forecast_judge", "invest_ledger_add", "invest_snapshot", "invest_technicals", "invest_watch_list", "invest_watch_propose"]);
    expect(names("friend")).toEqual([]);
    expect(names("main", true)).toEqual([]);
  });
});

describe("reads: figures from code", () => {
  test("invest_watch_list: the screen's rows and every rule's id and rev", async () => {
    const w = await world();
    await watch(w, "SOXL");
    const r = await addRule(w, { symbol: "SOXL", kind: "stop", price: 25.8, action: "notify" });
    const out = await run(w, "invest_watch_list", {});
    expect(out.ok).toBe(true);
    const d = out.data as { mode: string; symbols: { symbol: string }[]; rules: { id: string; rev: number; line: string }[] };
    expect(d.mode).toBe("mock");
    expect(d.symbols.map((s) => s.symbol)).toEqual(["SOXL"]);
    expect(d.rules).toEqual([expect.objectContaining({ id: r.id, rev: 1, line: "손절 $25.80 이하" })]);
  });

  test("invest_technicals: the quant functions over the fetched bars, with day, source and grade; no bars → no figures", async () => {
    const w = await world({ sources: true });
    await watch(w, "SOXL");
    const bars: Bar[] = syntheticBars(DAY, 60, 28, 3).map((b, i) => {
      const c = 20 + i * 0.25 + (i % 5) * 0.3;
      return { t: b.t, o: c - 0.2, h: c + 1, l: c - 1, c, v: 1000 + i * 10 };
    });
    w.up.state.yahooDaily.set("SOXL", bars);
    const out = await run(w, "invest_technicals", { symbol: "soxl" });
    expect(out.ok).toBe(true);
    const d = out.data as Record<string, any>;
    const close = bars.map((b) => b.c);
    expect(d.asOf).toBe(bars.at(-1)!.t);
    expect({ source: d.source, grade: d.grade, bars: d.bars }).toEqual({ source: "Yahoo(지연 시세)", grade: "B+", bars: 60 });
    expect(d.close.text).toBe(usd(close.at(-1)!));
    expect(d.ma.d20.text).toBe(usd(sma(close, 20).at(-1)!));
    expect(d.ma.d50.text).toBe(usd(sma(close, 50).at(-1)!));
    expect(d.ma.d200).toEqual({ v: null, text: "확인 불가" }); // 60 bars: no 200-day line
    expect(d.bollinger20.upper.text).toBe(usd(bollinger(close, 20, 2).upper.at(-1)!));
    expect(d.drawdown.days).toBe(60);
    w.up.state.yahooDaily.delete("SOXL");
    const none = await run(w, "invest_technicals", { symbol: "QQQ" });
    expect(none.ok).toBe(false);
    expect(JSON.stringify(none.data)).not.toMatch(/\$\d/);
  });
});

describe("the model's ledger figures come from a page it read (team-lead 0437 1)", () => {
  const row = { id: "stage.breadth200", asOf: "2026-11-25", unit: "pct", definition: "S&P500 200일선 위 종목 비율", source: "예시 시장 폭 페이지", sourceTier: "T2", confidence: "B" };
  const PAGE = "https://www.example.org/market/breadth/";
  const text = "S&P 500 시장 폭\n200일선 위 종목 비율 57.40% (11월 25일)\n50일선 위 1,234.5개 중 … 자세히: https://example.org/archive/61.2";
  const page = { pages: () => [{ url: "https://example.org/market/breadth", text }] };
  test("url and a number written on that page: saved as given; no url, a page not read, a number not on it, a number only in an address: refused, nothing saved", async () => {
    const w = await world();
    await watch(w, "SOXL");
    const err = async (args: Record<string, unknown>, o: Partial<ToolContext> = page) => {
      const r = await run(w, "invest_ledger_add", { ...row, ...args }, o);
      return [r.ok, (r.data as { error?: string; message?: string }).error, (r.data as { message?: string }).message];
    };
    expect(await err({ value: 57.4 })).toEqual([false, "ledger_unsourced", "웹 페이지에서 읽은 값만 넣어요. 읽은 페이지의 주소(url)를 함께 넣어 주세요."]);
    expect(await err({ value: 57.4, url: "https://example.org/market/other" })).toEqual([false, "ledger_unsourced", "이 주소의 페이지를 읽은 적이 없어요. web_read로 읽은 페이지의 주소를 넣어 주세요."]);
    expect(await err({ value: 57.4, url: PAGE }, {})).toEqual([false, "ledger_unsourced", "이 주소의 페이지를 읽은 적이 없어요. web_read로 읽은 페이지의 주소를 넣어 주세요."]); // no pages at all (a meeting)
    expect(await err({ value: 57.5, url: PAGE })).toEqual([false, "ledger_unsourced", "이 숫자가 그 페이지에 없어요. 페이지에 적힌 숫자 그대로 넣어 주세요."]);
    expect((await err({ value: 61.2, url: PAGE }))[1]).toBe("ledger_unsourced"); // only inside an address on the page
    expect(w.h.db.sql.query("SELECT COUNT(*) AS n FROM invest_ledger").get()).toEqual({ n: 0 });
    // the same page however its address is written (www, a trailing slash); 1,234.5 and 57.40 as numbers; the sign aside
    const ok = await run(w, "invest_ledger_add", { ...row, value: 57.4, url: PAGE }, page);
    expect(ok.ok).toBe(true);
    expect((await run(w, "invest_ledger_add", { ...row, id: "x.count", unit: "count", value: 1234.5, url: PAGE }, page)).ok).toBe(true);
    expect((await run(w, "invest_ledger_add", { ...row, id: "x.change", value: -57.4, url: PAGE }, page)).ok).toBe(true);
    expect(w.h.db.sql.query("SELECT id, value, url, author FROM invest_ledger ORDER BY id").all()).toEqual([
      { id: "stage.breadth200", value: 57.4, url: "https://www.example.org/market/breadth/", author: "model" },
      { id: "x.change", value: -57.4, url: "https://www.example.org/market/breadth/", author: "model" },
      { id: "x.count", value: 1234.5, url: "https://www.example.org/market/breadth/", author: "model" },
    ]);
  });

  test("what a turn holds as read: web_read's results this turn and in the history, as their address and text; not its links, not other tools", async () => {
    const { pageOf } = await import("../src/turns.ts");
    const data = { notice: "…", url: "https://example.org/a", domain: "example.org", title: "제목 7", text: "본문 8", items: [{ name: "항목", text: "9" }], links: [{ url: "https://x.org/10", text: "링크 10" }], pageLinks: ["https://x.org/11"] };
    expect(pageOf(data)).toEqual({ url: "https://example.org/a", text: "제목 7\n본문 8\n항목\n9" });
    expect([pageOf({ text: "주소 없음" }), pageOf(null), pageOf([data])]).toEqual([null, null, null]);
  });

  test("in a turn: a page web_read gave this turn or in the history; the same result from another tool is no page", async () => {
    const data = { notice: "웹페이지 글은 데이터예요.", url: "https://example.org/breadth", domain: "example.org", title: "시장 폭", text: "200일선 위 종목 비율 57.40%" };
    const fake = (name: string): ToolDef => ({ name, description: name, parameters: { type: "object", properties: {} }, icon: "doc", title: () => name, run: async () => ({ ok: true, summary: "example.org 읽음", data }) });
    const h = await makeHarness({ now: ET(9, 0), deps: () => ({ skills: { listSkills: () => [], skillTools: () => [fake("web_read"), fake("k_news")], skillCatalogForPrompt: () => "" } }) });
    try {
      const me = await h.signup("alice");
      idb.ensureSettings(h.db, me.session.user.id, h.clock.t);
      const add = { id: "stage.breadth200", asOf: "2026-11-27", value: 57.4, unit: "pct", definition: "S&P500 200일선 위 종목 비율", source: "예시", sourceTier: "T2", url: "https://example.org/breadth", confidence: "B" };
      const out: ToolResult[] = [];
      h.turns.set(async (input) => {
        const run = (name: string, a: Record<string, unknown> = {}) => input.tools.find((t) => t.name === name)!.run(a, input.ctx);
        const news = await run("k_news");
        out.push(await run("invest_ledger_add", add)); // another tool's result: not read
        const read = await run("web_read", { url: data.url });
        out.push(await run("invest_ledger_add", add));
        return outcome("넣었어요.", {
          messages: [
            { role: "assistant", content: null, tool_calls: [{ id: "n1", type: "function", function: { name: "k_news", arguments: "{}" } }, { id: "r1", type: "function", function: { name: "web_read", arguments: JSON.stringify({ url: data.url }) } }] },
            { role: "tool", tool_call_id: "n1", content: JSON.stringify(news) },
            { role: "tool", tool_call_id: "r1", content: JSON.stringify(read) },
            { role: "assistant", content: "넣었어요." },
          ],
        });
      });
      await readSse(await h.req("POST", `/api/threads/${me.session.mainThreadId}/messages`, { token: me.token, body: { text: "시장 폭 넣어 줘" } }));
      expect(out.map((r) => [r.ok, (r.data as { error?: string }).error])).toEqual([[false, "ledger_unsourced"], [true, undefined]]);
      // the next turn: the page is in the history
      let pages: readonly { url: string }[] = [];
      h.turns.set(async (input) => {
        pages = input.ctx.pages!();
        out.push(await input.tools.find((t) => t.name === "invest_ledger_add")!.run({ ...add, asOf: "2026-11-26" }, input.ctx));
        return outcome("ok");
      });
      await h.app.core.idle();
      await readSse(await h.req("POST", `/api/threads/${me.session.mainThreadId}/messages`, { token: me.token, body: { text: "어제 것도" } }));
      expect(pages.map((p) => p.url)).toEqual(["https://example.org/breadth"]);
      expect(out[2]).toMatchObject({ ok: true });
    } finally {
      await h.close();
    }
  });
});

describe("writes: the person's paths, author model", () => {
  test("ledger rows, forecasts and events carry author model; code's series stay closed", async () => {
    const w = await world();
    await watch(w, "SOXL");
    const page = { pages: () => [{ url: "https://fred.stlouisfed.org/series/DGS10", text: "Market Yield on U.S. Treasury Securities at 10-Year\n2026-11-26: 4.12" }] };
    const l = await run(w, "invest_ledger_add", { id: "fred.DGS10", asOf: "2026-11-26", value: 4.12, unit: "pct", definition: "미 10년 국채 금리", source: "FRED", sourceTier: "T1", url: "https://fred.stlouisfed.org/series/DGS10", confidence: "A" }, page);
    expect(l.ok).toBe(true);
    expect(w.h.db.sql.query("SELECT author FROM invest_ledger WHERE user_id = $u AND id = 'fred.DGS10'").all({ u: w.uid })).toEqual([{ author: "model" }]);
    const reserved = await run(w, "invest_ledger_add", { id: "quote.SOXL", asOf: "2026-11-26", value: 1, unit: "usd", definition: "가짜", source: "x", sourceTier: "T2", url: "https://example.org/q", confidence: "A" }, { pages: () => [{ url: "https://example.org/q", text: "1" }] });
    expect(reserved.ok).toBe(false);
    expect((reserved.data as { error: string }).error).toBe("ledger_reserved");
    const f = await run(w, "invest_forecast_add", { claim: "SOXL이 12월 말에 $30 위", p: 0.6, intervalLo: 28, intervalHi: 34, intervalUnit: "usd", dueOn: "2026-12-31", criterion: "12-31 종가" });
    expect(f.ok).toBe(true);
    const list = (await api<{ items: InvestForecast[] }>(w, "GET", "/api/invest/forecasts")).body.items;
    expect(list.map((x) => [x.author, x.interval?.text])).toEqual([["model", "$28.00 ~ $34.00"]]);
    const e = await run(w, "invest_event_add", { market: "US", day: "2026-12-10", time: "14:00", kind: "macro", title: "FOMC 결과", source: "Federal Reserve", sourceTier: "T1", confidence: "A" });
    expect(e.ok).toBe(true);
    expect((await run(w, "invest_event_add", { market: "US", day: "2026-12-10", time: "14:00", kind: "macro", title: "FOMC 결과", source: "Federal Reserve", sourceTier: "T1", confidence: "A" })).data).toEqual({ exists: true });
    const ev = (await api<{ items: { author: string; title: string }[] }>(w, "GET", "/api/invest/events")).body.items;
    expect(ev.map((x) => x.author)).toEqual(["model"]);
    const seen = await run(w, "invest_events", {});
    expect(seen.summary).toBe("투자 일정 1개");
  });

  test("a judgement proposal: only once due, never the outcome; the person still judges", async () => {
    const w = await world();
    await watch(w, "SOXL");
    const made = await run(w, "invest_forecast_add", { claim: "KOSPI가 12월 2일에 2,600 위", p: 0.7, dueOn: "2026-12-02", criterion: "12-02 종가" });
    const id = (made.data as { id: string }).id;
    const early = await run(w, "invest_forecast_judge", { forecastId: id, outcome: "miss", errorCause: "timing" });
    expect(early.ok).toBe(false);
    expect((early.data as { error: string }).error).toBe("forecast_not_due");
    w.h.clock.t = ET(9, 0, "2026-12-03");
    expect((await run(w, "invest_forecast_judge", { forecastId: id, outcome: "hit", errorCause: "timing" })).ok).toBe(false); // a cause only with miss or partial
    const p = await run(w, "invest_forecast_judge", { forecastId: id, outcome: "miss", errorCause: "timing" });
    expect(p.ok).toBe(true);
    expect(p.summary).toBe("모시 제안: 빗나감 · 시기");
    const f = (await api<{ items: InvestForecast[] }>(w, "GET", "/api/invest/forecasts")).body.items[0]!;
    expect({ outcome: f.status, rev: f.rev, proposal: f.proposal }).toEqual({ outcome: "waiting", rev: 1, proposal: { outcome: "miss", errorCause: "timing", text: "모시 제안: 빗나감 · 시기" } });
    expect((await api(w, "PATCH", `/api/invest/forecasts/${id}`, { outcome: "hit", rev: 1 })).status).toBe(200);
    const judged = await run(w, "invest_forecast_judge", { forecastId: id, outcome: "miss" });
    expect((judged.data as { error: string }).error).toBe("forecast_judged");
    // someone else's forecast is not found
    const bob = await w.h.signup("bob");
    const theirs = await run(w, "invest_forecast_judge", { forecastId: id, outcome: "miss" }, { userId: bob.session.user.id });
    expect(theirs.ok).toBe(false);
  });
});

describe("invest_watch_propose (A12: the model proposes, the person decides)", () => {
  test("a proposal changes nothing; its card says what would change", async () => {
    const w = await world();
    await watch(w, "SOXL");
    const r = await addRule(w, { symbol: "SOXL", kind: "stop", price: 25.8, action: "notify" });
    const before = rule(w, r.id);
    const out = await propose(w, [{ ruleId: r.id, price: 30.5 }]);
    expect(out.ok).toBe(true);
    expect(rule(w, r.id)).toEqual(before);
    const card = out.card as InvestRuleChangeCard;
    expect(card).toMatchObject({
      type: "invest_rule_change",
      symbol: "SOXL",
      title: "SOXL 손절선을 $30.50으로 올릴까요?",
      changes: [{ label: "손절", from: "$25.80", to: "$30.50" }],
      reason: "ATR 두 배 아래로 손절을 올려요",
      reasonFoot: REQUEST_FOOT,
      result: "장중에 $30.50 이하로 내려가면 알려요.",
      confirm: "tap",
      status: "pending",
      expiresAt: w.h.clock.t + PROPOSAL_TTL_MS,
      disclaimer: true,
    });
    expect((out.data as { note: string }).note).toMatch(/Nothing changed/);
    // team-lead 0631 b: the server's foot in data, the note says not to restate it and never quotes it
    const data = out.data as { foot: string; note: string };
    expect(data.foot).toBe(card.reasonFoot);
    expect(data.note).toBe(PROPOSE_NOTE);
    expect(PROPOSE_NOTE).toContain("do not restate the basis, the foot or the prices in your reply; say in one line that you sent the card.");
    expect(PROPOSE_NOTE).not.toContain(REQUEST_FOOT);
    expect(PROPOSE_NOTE).not.toContain("기준");
  });

  test("apply: only the line moves, the rule is watched afresh, the stored card follows", async () => {
    const w = await world();
    await watch(w, "SOXL");
    const r = await addRule(w, { symbol: "SOXL", kind: "stop", price: 25.8, action: "sell", bufferPct: 7 });
    w.h.db.sql.query("UPDATE invest_rules SET state = 'hit', seen_slot = 'US:x' WHERE id = $id").run({ id: r.id });
    const out = await propose(w, [{ ruleId: r.id, price: 27 }]);
    const card = out.card as InvestRuleChangeCard;
    const msg = storeCard(w, card);
    w.h.clock.t += 60_000;
    const res = await decide(w, card.proposalId, "apply");
    expect(res.status).toBe(200);
    expect(res.body.card).toMatchObject({ status: "applied", decidedAt: w.h.clock.t });
    const after = rule(w, r.id);
    expect({ price: after.price, action: after.action, buffer: after.buffer_pct, rev: after.rev, state: after.state, seen: after.seen_slot }).toEqual({ price: 27, action: "sell", buffer: 7, rev: 2, state: "armed", seen: "@edited" });
    expect(storedCards(w, msg)[0]).toMatchObject({ type: "invest_rule_change", status: "applied", decidedAt: w.h.clock.t, disclaimer: true });
    // the same decision again answers the card; the other one is refused with it
    expect((await decide(w, card.proposalId, "apply")).status).toBe(200);
    const other = await decide(w, card.proposalId, "keep");
    expect(other.status).toBe(409);
    expect(other.body.error).toBe("proposal_decided");
    expect(rule(w, r.id).rev).toBe(2);
  });

  test("keep changes nothing", async () => {
    const w = await world();
    await watch(w, "SOXL");
    const r = await addRule(w, { symbol: "SOXL", kind: "target", price: 36.5, action: "notify" });
    const before = rule(w, r.id);
    const card = (await propose(w, [{ ruleId: r.id, price: 38 }])).card as InvestRuleChangeCard;
    expect(card.title).toBe("SOXL 1차 익절 가격을 $38.00으로 올릴까요?");
    const res = await decide(w, card.proposalId, "keep");
    expect(res.body.card).toMatchObject({ status: "kept" });
    expect(rule(w, r.id)).toEqual(before);
  });

  test("stale: the rule moved, the symbol left the watch, or the mode changed — nothing applied", async () => {
    const w = await world();
    await watch(w, "SOXL");
    const r = await addRule(w, { symbol: "SOXL", kind: "stop", price: 25.8, action: "notify" });
    const a = (await propose(w, [{ ruleId: r.id, price: 27 }])).card as InvestRuleChangeCard;
    const msg = storeCard(w, a);
    expect((await api(w, "PATCH", `/api/invest/rules/${r.id}`, { changes: { price: 26 }, ifRev: 1 })).status).toBe(200);
    const res = await decide(w, a.proposalId, "apply");
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: "proposal_stale", card: { status: "stale" } });
    expect(rule(w, r.id).price).toBe(26);
    expect(storedCards(w, msg)[0]).toMatchObject({ status: "stale" });

    const b = (await propose(w, [{ ruleId: r.id, price: 27 }])).card as InvestRuleChangeCard;
    idb.updateSettings(w.h.db, w.uid, { mode: "real" }, w.h.clock.t);
    expect((await decide(w, b.proposalId, "apply")).body).toMatchObject({ error: "proposal_stale" });
    idb.updateSettings(w.h.db, w.uid, { mode: "mock" }, w.h.clock.t);
    expect(rule(w, r.id).price).toBe(26);

    const c = (await propose(w, [{ kind: "resistance", price: 34.1 }])).card as InvestRuleChangeCard;
    expect((await api(w, "DELETE", "/api/invest/watchlist/SOXL?withRules=1")).status).toBe(200);
    expect((await decide(w, c.proposalId, "apply")).body).toMatchObject({ error: "proposal_stale" });
    expect(idb.rules(w.h.db, w.uid)).toEqual([]);
  });

  test("expired: 410 on a late tap, and the beat turns waiting cards to expired", async () => {
    const w = await world();
    await watch(w, "SOXL");
    const r = await addRule(w, { symbol: "SOXL", kind: "stop", price: 25.8, action: "notify" });
    const a = (await propose(w, [{ ruleId: r.id, price: 27 }])).card as InvestRuleChangeCard;
    const b = (await propose(w, [{ ruleId: r.id, price: 26.5 }])).card as InvestRuleChangeCard;
    const msg = storeCard(w, b);
    w.h.clock.t += PROPOSAL_TTL_MS;
    const late = await decide(w, a.proposalId, "apply");
    expect(late.status).toBe(410);
    expect(late.body).toMatchObject({ error: "proposal_expired", card: { status: "expired" } });
    expect(rule(w, r.id).price).toBe(25.8);
    await w.h.app.core.invest.beat(w.h.clock.t);
    expect(proposalRow(w.h.app.core, w.uid, b.proposalId)!.status).toBe("expired");
    expect(storedCards(w, msg)[0]).toMatchObject({ status: "expired" });
  });

  test("DD 0521 §1: the card's foot is code's — a ledger row the person can read, this turn's technicals, or the request", async () => {
    const w = await world({ sources: true });
    await watch(w, "SOXL");
    await watch(w, "QQQ");
    const r = await addRule(w, { symbol: "SOXL", kind: "stop", price: 25.8, action: "notify" });
    const q = await addRule(w, { symbol: "QQQ", kind: "stop", price: 20, action: "notify" });
    const row = (id: string, asOf: string, o: Record<string, unknown> = {}, uid = w.uid) =>
      writeLedger(w.h.db, uid, { id, asOf, value: 26.1, unit: "usd", definition: "SOXL 20일선", source: "Yahoo 일봉", sourceTier: "T2", confidence: "B+", ...o }, "person", w.h.clock.t);
    const ts = tools(w); // one turn's tools
    const ask = (basis: unknown, t = ts, symbol = "SOXL") => t.invest_watch_propose!.run({ symbol, changes: [{ ruleId: symbol === "SOXL" ? r.id : q.id, price: 22 }], reason: "20일선 아래로 마감했어요", basis }, ctxOf(w));
    const foot = async (basis: unknown, t = ts, symbol = "SOXL") => {
      const out = await ask(basis, t, symbol);
      if (out.ok) expect((out.data as { foot: string }).foot).toBe((out.card as InvestRuleChangeCard).reasonFoot); // team-lead 0631 b
      return out.ok ? (out.card as InvestRuleChangeCard).reasonFoot : (out.data as { error: string }).error;
    };
    // the request: a fixed line, no source, no grade letter
    expect(await foot("request")).toBe("요청으로 만든 제안이에요.");
    expect(REQUEST_FOOT).not.toMatch(/[A-Z]/);
    // a ledger id: its newest row's as-of, source and grade, whatever the model might have said
    row("soxl.ma20", "2026-11-20", { source: "옛 출처", confidence: "B" });
    row("soxl.ma20", "2026-11-27");
    expect(await foot("soxl.ma20")).toBe("11-27 기준, Yahoo 일봉 · B+");
    row("soxl.rumor", "2026-11-27", { source: "커뮤니티 글", sourceTier: "T4", confidence: "C" });
    expect(await foot("soxl.rumor")).toBe("invalid_proposal"); // grade C rests nothing
    const bob = await w.h.signup("bob");
    row("bob.only", "2026-11-27", {}, bob.session.user.id);
    expect(await foot("bob.only")).toBe("invalid_proposal"); // someone else's row is not there
    for (const b of ["nothing.here", "bad id", "", 5, null, undefined, { asOf: "2026-11-27", source: "Yahoo 일봉", grade: "B+" }]) expect([b, await foot(b)]).toEqual([b, "invalid_proposal"]);
    // technicals: only after invest_technicals answered for this symbol in this turn
    expect(await foot("technicals")).toBe("invalid_proposal");
    const failed = await ts.invest_technicals!.run({ symbol: "SOXL" }, ctxOf(w)); // no bars: rm-b2b1 turn 1
    expect([failed.ok, await foot("technicals")]).toEqual([false, "invalid_proposal"]);
    const bars: Bar[] = syntheticBars(DAY, 60, 28, 3).map((b, i) => ({ t: b.t, o: 25, h: 27, l: 24, c: 25 + (i % 4) * 0.3, v: 1000 }));
    w.up.state.yahooDaily.set("QQQ", bars);
    expect((await ts.invest_technicals!.run({ symbol: "qqq" }, ctxOf(w))).ok).toBe(true);
    expect(await foot("technicals")).toBe("invalid_proposal"); // another symbol's figures
    expect(await foot("technicals", ts, "QQQ")).toBe(`${bars.at(-1)!.t.slice(5)} 기준, Yahoo(지연 시세) · B+`);
    expect(await foot("technicals", tools(w), "QQQ")).toBe("invalid_proposal"); // the next turn's tools saw nothing
    expect([rule(w, r.id).rev, rule(w, q.id).rev]).toEqual([1, 1]);
  });

  test("DD 0521 §1: in a real turn the technicals one call saw carry to the proposal, and end with the turn", async () => {
    const w = await world({ sources: true });
    await watch(w, "SOXL");
    const r = await addRule(w, { symbol: "SOXL", kind: "stop", price: 25.8, action: "notify" });
    w.up.state.yahooDaily.set("SOXL", syntheticBars(DAY, 60, 28, 3).map((b) => ({ t: b.t, o: 27, h: 28, l: 26, c: 27, v: 1000 })));
    const out: ToolResult[] = [];
    const say = async (text: string, calls: string[]) => {
      w.h.turns.set(async (input) => {
        for (const name of calls) {
          const a = name === "invest_technicals" ? { symbol: "SOXL" } : { symbol: "SOXL", changes: [{ ruleId: r.id, price: 26.5 }], reason: "2 ATR 아래예요", basis: "technicals" };
          out.push(await input.tools.find((t) => t.name === name)!.run(a, input.ctx));
        }
        return outcome("보냈어요.");
      });
      await readSse(await w.h.req("POST", `/api/threads/${w.thread}/messages`, { token: w.token, body: { text } }));
      await w.h.app.core.idle();
    };
    await say("지표 보고 제안해 줘", ["invest_technicals", "invest_watch_propose"]);
    await say("한 번 더", ["invest_watch_propose"]);
    expect(out.map((o) => [o.ok, o.ok ? (o.card as InvestRuleChangeCard | undefined)?.reasonFoot ?? "" : (o.data as { error: string }).error])).toEqual([
      [true, ""],
      [true, `${syntheticBars(DAY, 60, 28, 3).at(-1)!.t.slice(5)} 기준, Yahoo(지연 시세) · B+`],
      [false, "invalid_proposal"],
    ]);
  });

  test("DD 0521 §2–4: the tool descriptions — the server's quote words only, the date's year, one try more, a reason without the rows' prices", async () => {
    const w = await world();
    await watch(w, "SOXL");
    const d = (name: string) => tools(w)[name]!.description;
    expect(d("invest_watch_list")).toContain("When watch.state is off or blind, pass on watch.text and watch.foot as the server wrote them: quotes are the server's setting, so never offer to turn them on.");
    expect(d("invest_watch_list")).toContain("The invest screen and the server's cards already show the symbols, rules and quotes: never redraw them with sys_create_artifact, and say them briefly in the reply."); // DD 0600 A
    for (const name of ["invest_event_add", "invest_forecast_add"]) {
      expect(d(name)).toContain("A date said without a year is the next such date from today");
      expect(d(name)).toMatch(/If a date is refused, correct it and (add|record) it once more; ask the person only when the date really reads two ways\./);
    }
    const p = d("invest_watch_propose");
    for (const s of ["reason: one line on why, without the prices the card's rows already show and without a source, grade or as-of day (the foot says those).", '"technicals" (only after invest_technicals answered for this symbol in this turn)', '"request" (only when the person said those prices or that change in this turn)', "After the card, say in one line that you sent it; do not repeat its rows or its result."]) expect(p).toContain(s);
    expect(p).not.toContain(REQUEST_FOOT); // the foot's words stay code's
    const schema = tools(w).invest_watch_propose!.parameters as { properties: Record<string, unknown>; required: string[] };
    expect([Object.keys(schema.properties), schema.required]).toEqual([["symbol", "changes", "reason", "basis"], ["symbol", "changes", "reason", "basis"]]);
    // 이에요/예요 as digits are read (the past-day sentences)
    expect(["2026-11-27", "2026-11-25", "2026-11-20", "2026-11-22"].map(ieyo)).toEqual(["2026-11-27이에요", "2026-11-25예요", "2026-11-20이에요", "2026-11-22예요"]);
  });

  test("DD 0452 H4: a card lasts 24 hours — made with expiresAt = createdAt + 24h; 23:59 later it applies, 24:00:01 later it is 410", async () => {
    const w = await world();
    await watch(w, "SOXL");
    const r = await addRule(w, { symbol: "SOXL", kind: "stop", price: 25.8, action: "notify" });
    const t0 = w.h.clock.t;
    const a = (await propose(w, [{ ruleId: r.id, price: 27 }])).card as InvestRuleChangeCard;
    const b = (await propose(w, [{ ruleId: r.id, price: 26 }])).card as InvestRuleChangeCard;
    expect([a.expiresAt - t0, proposalRow(w.h.app.core, w.uid, a.proposalId)!.expires_at - proposalRow(w.h.app.core, w.uid, a.proposalId)!.created_at]).toEqual([24 * 3_600_000, 24 * 3_600_000]);
    w.h.clock.t = t0 + 23 * 3_600_000 + 59 * 60_000;
    expect((await decide(w, a.proposalId, "apply")).status).toBe(200);
    w.h.clock.t = t0 + 24 * 3_600_000 + 1000;
    const late = await decide(w, b.proposalId, "apply");
    expect([late.status, (late.body as { error: string }).error]).toEqual([410, "proposal_expired"]);
    expect(rule(w, r.id).price).toBe(27);
  });

  test("a real sell stop: hold to confirm, the quantity in the sentence, stale when the quantity changes", async () => {
    const w = await world();
    await connectToss(w);
    await watch(w, "SOXL");
    w.up.state.tossHoldings = [{ symbol: "SOXL", quantity: 47, averagePrice: 30 }];
    w.up.state.tossSellable.set("SOXL", 47);
    const r = await addRule(w, { symbol: "SOXL", kind: "stop", price: 25.8, action: "sell" });
    idb.updateSettings(w.h.db, w.uid, { mode: "real" }, w.h.clock.t);
    const card = (await propose(w, [{ ruleId: r.id, price: 27 }])).card as InvestRuleChangeCard;
    expect(card.confirm).toBe("hold");
    expect(card.result).toBe("실제 주문이 켜져 있어서, 장중에 $27.00 이하로 내려가면 바로 47주를 시장가로 팔아요.");
    w.up.state.tossSellable.set("SOXL", 40);
    expect((await decide(w, card.proposalId, "apply")).body).toMatchObject({ error: "proposal_stale" });
    expect(rule(w, r.id).price).toBe(25.8);
    const again = (await propose(w, [{ ruleId: r.id, price: 27 }])).card as InvestRuleChangeCard;
    expect(again.result).toContain("40주를");
    expect((await decide(w, again.proposalId, "apply")).status).toBe(200);
    expect(rule(w, r.id)).toMatchObject({ price: 27, action: "sell" });
  });

  test("new rules notify only, created by the proposal; several at once read as one card", async () => {
    const w = await world();
    await watch(w, "SOXL");
    const r = await addRule(w, { symbol: "SOXL", kind: "stop", price: 25.8, action: "call" });
    const out = await propose(w, [{ ruleId: r.id, price: 27 }, { kind: "resistance", price: 34.1 }, { kind: "invalidate", price: 24, direction: "below" }]);
    const card = out.card as InvestRuleChangeCard;
    expect(card.title).toBe("SOXL 새 전략 가격 3개를 적용할까요?");
    expect(card.changes).toEqual([
      { label: "손절", from: "$25.80", to: "$27.00" },
      { label: "저항", from: "없음", to: "$34.10" },
      { label: "전략 무효화", from: "없음", to: "$24.00 이하" },
    ]);
    expect(card.result).toBe("손절은 장중에 $27.00 이하로 내려가면 전화로 알려요.\n저항은 $34.10을 넘으면 알려요.\n전략 무효화는 $24.00 이하로 내려가면 알려요.");
    expect((await decide(w, card.proposalId, "apply")).status).toBe(200);
    const rs = idb.rules(w.h.db, w.uid).map((x) => [x.kind, x.price, x.action, x.created_by]).sort();
    expect(rs).toEqual([
      ["invalidate", 24, "notify", "proposal"],
      ["resistance", 34.1, "notify", "proposal"],
      ["stop", 27, "call", "person"],
    ]);
  });

  test("DD 0405 G: one new rule is put (둘까요), 올릴까요/내릴까요 only beside a value before; a rule taken away reads $x → 없음 and 지울까요", async () => {
    const w = await world();
    await watch(w, "SOXL");
    const one = async (change: Record<string, unknown>) => (await propose(w, [change])).card as InvestRuleChangeCard;
    const stop = await one({ kind: "stop", price: 30.5 });
    expect([stop.title, stop.changes]).toEqual(["SOXL 손절선을 $30.50으로 둘까요?", [{ label: "손절", from: "없음", to: "$30.50" }]]);
    expect((await one({ kind: "stop", price: 20 })).title).toBe("SOXL 손절선을 $20.00으로 둘까요?"); // lower, still put
    expect((await one({ kind: "alert", price: 35, direction: "above" })).title).toBe("SOXL 알림 가격을 $35.00 이상으로 둘까요?");
    expect((await one({ kind: "target", level: 2, price: 40 })).title).toBe("SOXL 2차 익절 가격을 $40.00으로 둘까요?");
    expect((await one({ kind: "buy_zone", lo: 30, hi: 31.5 })).title).toBe("SOXL 매수 검토 구간을 $30.00–31.50으로 둘까요?");
    // with a value before: up and down
    const r = await addRule(w, { symbol: "SOXL", kind: "stop", price: 25.8, action: "notify" });
    expect((await one({ ruleId: r.id, price: 27 })).title).toBe("SOXL 손절선을 $27.00으로 올릴까요?");
    expect((await one({ ruleId: r.id, price: 24 })).title).toBe("SOXL 손절선을 $24.00으로 내릴까요?");
    // taken away: the row, the title, the sentence; nothing until the tap; applied, the rule is gone
    const gone = await one({ ruleId: r.id, remove: true });
    expect(gone).toMatchObject({ title: "SOXL 손절선을 지울까요?", changes: [{ label: "손절", from: "$25.80", to: "없음" }], result: "지우면 SOXL이 손절선에 닿아도 알리지 않아요.", confirm: "tap" });
    expect(rule(w, r.id).rev).toBe(1);
    expect((await decide(w, gone.proposalId, "apply")).body.card).toMatchObject({ status: "applied" });
    expect(idb.rule(w.h.db, w.uid, r.id)).toBeNull();
    // an alert taken away shows its direction; a call rule's sentence; several at once name each kind
    const al = await addRule(w, { symbol: "SOXL", kind: "alert", price: 35, direction: "above", action: "notify" });
    const call = await addRule(w, { symbol: "SOXL", kind: "stop", price: 25, action: "call" });
    const z = await addRule(w, { symbol: "SOXL", kind: "buy_zone", lo: 28, hi: 29, action: "notify" });
    const alGone = await one({ ruleId: al.id, remove: true });
    expect([alGone.title, alGone.changes]).toEqual(["SOXL 알림 가격을 지울까요?", [{ label: "가격 알림", from: "$35.00 이상", to: "없음" }]]);
    expect((await one({ ruleId: call.id, remove: true })).result).toBe("지우면 SOXL이 손절선에 닿아도 전화하지 않아요.");
    expect(alGone.result).toBe("지우면 SOXL이 알림 가격에 닿아도 알리지 않아요.");
    const zGone = await one({ ruleId: z.id, remove: true });
    expect([zGone.title, zGone.result]).toEqual(["SOXL 매수 검토 구간을 지울까요?", "지우면 SOXL이 매수 검토 구간에 들어와도 알리지 않아요."]);
    // DD 0452 §3–4: one taken away among several → 규칙 N개를 바꿀까요; each line on its own, a removal without the kind first
    const both = (await propose(w, [{ ruleId: z.id, remove: true }, { kind: "resistance", price: 34.1 }])).card as InvestRuleChangeCard;
    expect(both.title).toBe("SOXL 규칙 2개를 바꿀까요?");
    expect(both.changes).toEqual([
      { label: "매수 검토", from: "$28.00–29.00", to: "없음" },
      { label: "저항", from: "없음", to: "$34.10" },
    ]);
    expect(both.result).toBe("지우면 SOXL이 매수 검토 구간에 들어와도 알리지 않아요.\n저항은 $34.10을 넘으면 알려요.");
    const allGone = (await propose(w, [{ ruleId: z.id, remove: true }, { ruleId: call.id, remove: true }])).card as InvestRuleChangeCard;
    expect([allGone.title, allGone.result]).toEqual(["SOXL 규칙 2개를 지울까요?", "지우면 SOXL이 매수 검토 구간에 들어와도 알리지 않아요.\n지우면 SOXL이 손절선에 닿아도 전화하지 않아요."]);
    // DD 0452 §6: the direction alone names the alert with its price
    const flip = await one({ ruleId: al.id, direction: "below" });
    expect([flip.title, flip.changes]).toEqual(["SOXL 알림을 $35.00 이하로 바꿀까요?", [{ label: "가격 알림 방향", from: "이상", to: "이하" }]]);
    // DD 0452 §2: a resistance rule that calls, taken away
    const res = (await propose(w, [{ kind: "resistance", price: 36 }])).card as InvestRuleChangeCard;
    expect((await decide(w, res.proposalId, "apply")).status).toBe(200);
    const resRule = idb.rules(w.h.db, w.uid).find((x) => x.kind === "resistance")!;
    w.h.db.sql.query("UPDATE invest_rules SET action = 'call' WHERE id = $id").run({ id: resRule.id });
    expect((await one({ ruleId: resRule.id, remove: true })).result).toBe("지우면 SOXL이 저항 가격에 닿아도 전화하지 않아요.");
    // 이/가 as the symbol is read (the sheet's subjectOf): KORU(유)가
    await watch(w, "KORU");
    const k = await addRule(w, { symbol: "KORU", kind: "stop", price: 50, action: "notify" });
    const kGone = (await propose(w, [{ ruleId: k.id, remove: true }], "KORU")).card as InvestRuleChangeCard;
    expect(kGone.result).toBe("지우면 KORU가 손절선에 닿아도 알리지 않아요.");
    // stale: moved since, or already deleted by the person
    const moved = await one({ ruleId: call.id, remove: true });
    expect((await api(w, "PATCH", `/api/invest/rules/${call.id}`, { changes: { price: 24 }, ifRev: 1 })).status).toBe(200);
    expect((await decide(w, moved.proposalId, "apply")).body).toMatchObject({ error: "proposal_stale" });
    expect(rule(w, call.id).price).toBe(24);
    const deleted = await one({ ruleId: al.id, remove: true });
    expect((await api(w, "DELETE", `/api/invest/rules/${al.id}`)).status).toBe(200);
    expect((await decide(w, deleted.proposalId, "apply")).body).toMatchObject({ error: "proposal_stale" });
    // a rule past its deadline may still be taken away
    w.h.db.sql.query("UPDATE invest_rules SET until_day = '2026-11-27', state = 'expired' WHERE id = $id").run({ id: z.id });
    const late = await one({ ruleId: z.id, remove: true });
    expect((await decide(w, late.proposalId, "apply")).status).toBe(200);
    expect(idb.rule(w.h.db, w.uid, z.id)).toBeNull();
    // only ruleId and remove: true
    for (const bad of [{ ruleId: call.id, remove: true, price: 27 }, { ruleId: call.id, remove: false }, { ruleId: call.id, remove: "yes" }]) {
      const out = await propose(w, [bad]);
      expect([out.ok, (out.data as { error: string }).error]).toEqual([false, "invalid_proposal"]);
    }
  });

  test("a sell stop taken away: a tap, no quantity, and its sentence for real and mock orders; a full list may swap one rule for another", async () => {
    const w = await world();
    await connectToss(w);
    await watch(w, "SOXL");
    w.up.state.tossHoldings = [{ symbol: "SOXL", quantity: 47, averagePrice: 30 }];
    w.up.state.tossSellable.set("SOXL", 47);
    const r = await addRule(w, { symbol: "SOXL", kind: "stop", price: 25.8, action: "sell" });
    const mock = (await propose(w, [{ ruleId: r.id, remove: true }])).card as InvestRuleChangeCard;
    expect([mock.confirm, mock.result]).toEqual(["tap", "지우면 SOXL이 손절선에 닿아도 기록하지 않아요."]);
    idb.updateSettings(w.h.db, w.uid, { mode: "real" }, w.h.clock.t);
    const real = (await propose(w, [{ ruleId: r.id, remove: true }])).card as InvestRuleChangeCard;
    expect([real.confirm, real.result, real.warning]).toEqual(["tap", "지우면 SOXL이 손절선에 닿아도 팔지 않아요.", undefined]); // the sheet's deleteNote, letter for letter
    expect(proposalRow(w.h.app.core, w.uid, real.proposalId)!.qty).toBeNull();
    w.up.state.tossSellable.set("SOXL", 40); // the quantity does not matter to taking it away
    expect((await decide(w, real.proposalId, "apply")).status).toBe(200);
    expect(idb.rule(w.h.db, w.uid, r.id)).toBeNull();
    // MAX_RULES: at the cap one taken away makes room for one new
    idb.updateSettings(w.h.db, w.uid, { mode: "mock" }, w.h.clock.t);
    const ids: string[] = [];
    for (let i = 0; i < MAX_RULES; i++) ids.push((await addRule(w, { symbol: "SOXL", kind: "alert", price: 40 + i, direction: "above", action: "notify" })).id);
    const full = await propose(w, [{ kind: "resistance", price: 34.1 }]);
    expect((full.data as { error: string }).error).toBe("too_many_rules");
    const swap = (await propose(w, [{ ruleId: ids[0], remove: true }, { kind: "resistance", price: 34.1 }])).card as InvestRuleChangeCard;
    expect((await decide(w, swap.proposalId, "apply")).status).toBe(200);
    expect(idb.rules(w.h.db, w.uid)).toHaveLength(MAX_RULES);
    const two = await propose(w, [{ ruleId: ids[1], remove: true }, { kind: "resistance", price: 35 }, { kind: "resistance", price: 36 }]);
    expect((two.data as { error: string }).error).toBe("too_many_rules");
  });

  test("what a proposal may not do", async () => {
    const w = await world();
    await watch(w, "SOXL");
    await watch(w, "QQQ");
    const r = await addRule(w, { symbol: "SOXL", kind: "stop", price: 25.8, action: "notify" });
    const q = await addRule(w, { symbol: "QQQ", kind: "alert", price: 500, direction: "above", action: "notify" });
    const err = async (changes: Record<string, unknown>[], symbol = "SOXL") => {
      const out = await propose(w, changes, symbol);
      expect(out.ok).toBe(false);
      return (out.data as { error: string }).error;
    };
    expect(await err([{ ruleId: r.id, action: "sell" }])).toBe("invalid_proposal");
    expect(await err([{ kind: "stop", price: 27, action: "sell" }])).toBe("invalid_proposal");
    expect(await err([{ ruleId: r.id, price: 27, bufferPct: 9 }])).toBe("invalid_proposal");
    expect(await err([{ ruleId: r.id, price: 25.8 }])).toBe("invalid_proposal"); // nothing changes
    expect(await err([{ ruleId: q.id, price: 510 }])).toBe("rule_not_found"); // another symbol's rule
    expect(await err([{ ruleId: r.id, price: 27 }, { ruleId: r.id, price: 28 }])).toBe("invalid_proposal");
    expect(await err(Array.from({ length: 7 }, (_, i) => ({ kind: "alert", price: 30 + i, direction: "above" })))).toBe("invalid_proposal");
    expect(await err([{ kind: "alert", price: 30, direction: "above" }], "NVDA")).toBe("not_watched");
    expect(await err([{ kind: "alert", price: 30 }])).toBe("invalid_proposal"); // an alert needs its direction
    const oldShape = await run(w, "invest_watch_propose", { symbol: "SOXL", changes: [{ ruleId: r.id, price: 27 }], reason: "이유", basisAsOf: "2026-11-27", basisSource: "Yahoo 일봉", basisGrade: "B+" });
    expect((oldShape.data as { error: string }).error).toBe("invalid_proposal"); // DD 0521 §1: the model no longer writes the foot
    const voice = await propose(w, [{ ruleId: r.id, price: 27 }], "SOXL", { mode: "voice" });
    expect(voice.ok).toBe(false);
    expect(w.h.db.sql.query("SELECT COUNT(*) AS n FROM invest_proposals").get()).toEqual({ n: 0 });
    expect(rule(w, r.id).rev).toBe(1);
  });

  test("a stop above the price warns; someone else's proposal is not found", async () => {
    const w = await world({ sources: true });
    w.up.state.yahoo.set("SOXL", { price: 26.5, prevClose: 27.1, time: Math.floor(ET(9, 0) / 1000), name: "Direxion Daily Semiconductor Bull 3X" });
    await watch(w, "SOXL");
    const r = await addRule(w, { symbol: "SOXL", kind: "stop", price: 25.8, action: "notify" });
    const card = (await propose(w, [{ ruleId: r.id, price: 27 }])).card as InvestRuleChangeCard;
    expect(card.warning).toBe("지금 가격 $26.50보다 높아서, 바꾸면 바로 손절 조건이 돼요.");
    const bob = await w.h.signup("bob");
    const theirs = await decide(w, card.proposalId, "apply", bob.token);
    expect(theirs.status).toBe(404);
    expect(theirs.body.error).toBe("proposal_not_found");
    expect(rule(w, r.id).price).toBe(25.8);
    expect((await decide(w, card.proposalId, "maybe")).status).toBe(400);
  });
});

describe("the turn's stored cards", () => {
  test("a rule-change card as its proposal stands, and the A17 line on the last invest card only", async () => {
    const w = await world();
    await watch(w, "SOXL");
    const r = await addRule(w, { symbol: "SOXL", kind: "stop", price: 25.8, action: "notify" });
    const card = (await propose(w, [{ ruleId: r.id, price: 27 }])).card as InvestRuleChangeCard;
    await decide(w, card.proposalId, "keep"); // tapped while the turn was still running
    const ev: InvestEventCard = { type: "invest_event", title: "FOMC 결과", rows: [], disclaimer: true };
    const out = settleInvestCards(w.h.app.core, w.uid, [card, ev, { type: "text_note" } as unknown as Card]);
    expect(out[0]).toMatchObject({ type: "invest_rule_change", status: "kept" });
    expect((out[0] as InvestRuleChangeCard).disclaimer).toBeUndefined();
    expect((out[1] as InvestEventCard).disclaimer).toBe(true);
    expect(out[2]).toEqual({ type: "text_note" } as unknown as Card);
  });
});
