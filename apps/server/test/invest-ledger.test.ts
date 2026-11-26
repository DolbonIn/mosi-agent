/**
 * Invest B2a: the indicator ledger (B2's nine fields) and the forecast ledger (B6) through the server (team-lead 0052,
 * DD 0109 §2): every field checked, code's rows and series kept code's, the person judging and code scoring (numbers
 * worked by hand below), and each person's rows their own. No model call, no upstream.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { InvestForecast, InvestForecastList, InvestLedgerEntry } from "@pickle/protocol";
import { join } from "node:path";
import { Db } from "../src/db/index.ts";
import { createForecast, MAX_FORECASTS, monthsBack, proposeJudgement } from "../src/invest/forecasts.ts";
import { MAX_LEDGER_ROWS, writeLedger } from "../src/invest/ledger.ts";
import { makeHarness, type Harness } from "./helpers.ts";

const KST = (y: number, mo: number, d: number, hh = 9, mi = 0) => Date.UTC(y, mo - 1, d, hh - 9, mi);
const NOW = KST(2026, 11, 27);

interface Person {
  uid: string;
  token: string;
}
const harnesses: Harness[] = [];
afterEach(async () => {
  while (harnesses.length) await harnesses.pop()!.close();
});

async function setup(now = NOW) {
  const h = await makeHarness({ now });
  harnesses.push(h);
  const person = async (handle: string): Promise<Person> => {
    const me = await h.signup(handle);
    return { uid: me.session.user.id, token: me.token };
  };
  const api = async <T = Record<string, unknown>>(p: Person, method: string, path: string, body?: unknown) => {
    const res = await h.req(method, path, { token: p.token, body });
    return { status: res.status, body: (await res.json()) as T };
  };
  return { h, person, api };
}

/** a full, valid ledger row; tests change one field at a time */
const ROW = {
  id: "S02-HBM-2027계약",
  asOf: "2026-10-29",
  publishedAt: "2026-10-29T06:10:00+09:00",
  value: null,
  valueText: "2027 물량 완판, 목표가 협상 완료",
  unit: "text",
  definition: "HBM4 12-Hi 포함, 계획 물량 기준. 스팟 아님",
  source: "삼성전자 3분기 실적 콜",
  sourceTier: "T1",
  url: "https://example.org/ir/q3",
  revision: null,
  confidence: "A",
  leadClass: "L1",
};

describe("the ledger's nine fields", () => {
  test("a person's row keeps every field; numbers come back with their text in the row's unit", async () => {
    const { person, api } = await setup();
    const a = await person("alice");
    const r = await api<InvestLedgerEntry>(a, "POST", "/api/invest/ledger", ROW);
    expect(r.status).toBe(201);
    expect(r.body).toEqual({
      id: "S02-HBM-2027계약",
      asOf: "2026-10-29",
      publishedAt: "2026-10-29T06:10:00+09:00",
      value: null,
      valueText: "2027 물량 완판, 목표가 협상 완료",
      unit: "text",
      definition: "HBM4 12-Hi 포함, 계획 물량 기준. 스팟 아님",
      source: "삼성전자 3분기 실적 콜",
      sourceTier: "T1",
      url: "https://example.org/ir/q3",
      revision: null,
      confidence: "A",
      leadClass: "L1",
      author: "person",
      shared: false,
      createdAt: NOW,
    });
    const units: [string, number, string][] = [
      ["usd", 32.5, "$32.50"],
      ["krw", 189400, "189,400원"],
      ["pct", 3.756, "3.76%"],
      ["pctp", -0.24, "−0.24%p"],
      ["bp", 376, "376bp"],
      ["index", 1234.5, "1,234.50"],
      ["count", 1520, "1,520"],
      ["qty", 47, "47주"],
      ["T", 12.34, "12.3조 토큰"],
      ["GW", 3.25, "3.3GW"],
      ["$B", -1.25, "−$1.3B"],
    ];
    for (const [unit, value, text] of units) {
      const w = await api<InvestLedgerEntry>(a, "POST", "/api/invest/ledger", { ...ROW, id: `u.${unit.replace("$", "usd")}`, unit, value, valueText: null, leadClass: null, url: null });
      expect(w.status).toBe(201);
      expect({ unit: w.body.unit as string, value: w.body.value }).toEqual({ unit, value: { v: value, text } });
    }
    const one = await api<{ items: InvestLedgerEntry[] }>(a, "GET", `/api/invest/ledger?id=${encodeURIComponent("S02-HBM-2027계약")}`);
    expect(one.body.items).toEqual([r.body]);
  });

  test("each field is checked: 400 invalid_ledger with the field's sentence (L2: no definition, no row)", async () => {
    const { person, api } = await setup();
    const a = await person("alice");
    const cases: [Record<string, unknown>, string][] = [
      [{ id: "has space" }, "id는 글자, 숫자, '.', '_', '-'로 64자까지예요."],
      [{ id: "x".repeat(65) }, "id는 글자, 숫자, '.', '_', '-'로 64자까지예요."],
      [{ id: ".dot-first" }, "id는 글자, 숫자, '.', '_', '-'로 64자까지예요."],
      [{ asOf: undefined }, "기준일을 넣어 주세요."],
      [{ asOf: "2026-02-30" }, "기준일은 날짜(YYYY-MM-DD)나 ISO 시각으로 넣어 주세요."],
      [{ asOf: "2026-11-27T25:00Z" }, "기준일은 날짜(YYYY-MM-DD)나 ISO 시각으로 넣어 주세요."],
      [{ asOf: "2026-11-27T10:00" }, "기준일은 날짜(YYYY-MM-DD)나 ISO 시각으로 넣어 주세요."],
      [{ asOf: "2026-11-30" }, "기준일이 아직 오지 않은 날이에요."],
      [{ publishedAt: "어제" }, "발표일은 날짜(YYYY-MM-DD)나 ISO 시각으로 넣어 주세요."],
      [{ unit: "furlong" }, "단위는 usd, krw, index, pct, pctp, qty, bp, count, T, GW, $B, text 가운데 하나예요."],
      [{ value: 3 }, "글로 된 값에는 숫자를 넣지 않아요."],
      [{ valueText: "  " }, "값을 넣어 주세요."],
      [{ unit: "pct", valueText: null }, "값을 숫자로 넣어 주세요."],
      [{ unit: "pct", value: "3.7", valueText: null }, "값을 숫자로 넣어 주세요."],
      [{ unit: "pct", value: 3.7 }, "숫자 값에는 글 값을 넣지 않아요. 단위를 text로 해 주세요."],
      [{ definition: "" }, "정의를 넣어 주세요."],
      [{ definition: undefined }, "정의를 넣어 주세요."],
      [{ definition: "가".repeat(301) }, "정의는 300자까지예요."],
      [{ definition: `줄${String.fromCharCode(7)}바꿈` }, "정의에 쓸 수 없는 글자가 있어요."],
      [{ source: undefined }, "출처를 넣어 주세요."],
      [{ sourceTier: "T5" }, "출처 층위는 T1, T2, T3, T4 가운데 하나예요."],
      [{ confidence: "A+" }, "등급은 A, B+, B, C 가운데 하나예요."],
      [{ sourceTier: "T4", confidence: "B" }, "T4 출처는 T1·T2 출처로 확인하기 전까지 C 등급이에요."],
      [{ url: "javascript:alert(1)" }, "링크는 http나 https 주소만 넣을 수 있어요."],
      [{ url: "https://user:pw@example.org/" }, "링크에 계정 정보를 넣을 수 없어요."],
      [{ url: "not a url" }, "링크가 올바르지 않아요."],
      [{ revision: "가".repeat(201) }, "고친 기록은 200자까지예요."],
      [{ leadClass: "L3" }, "선행성은 L1, L2, G, T 가운데 하나예요."],
    ];
    for (const [patch, message] of cases) {
      const r = await api(a, "POST", "/api/invest/ledger", { ...ROW, ...patch });
      expect([r.status, r.body.error, r.body.message, JSON.stringify(patch)]).toEqual([400, "invalid_ledger", message, JSON.stringify(patch)]);
    }
    expect((await api(a, "POST", "/api/invest/ledger", [ROW])).status).toBe(400);
    // a T4 row is fine at C; white space runs fold to one space
    const ok = await api<InvestLedgerEntry>(a, "POST", "/api/invest/ledger", { ...ROW, sourceTier: "T4", confidence: "C", definition: "  업계\n 인터뷰   발언  " });
    expect([ok.status, ok.body.definition]).toEqual([201, "업계 인터뷰 발언"]);
    expect((await api<{ items: unknown[] }>(a, "GET", "/api/invest/ledger")).body.items).toHaveLength(1);
    expect((await api(a, "GET", "/api/invest/ledger?id=has%20space")).status).toBe(400);
  });

  test("the same id and day again replaces the row, and a person's rewrite notes the day; code's series and code's rows stay code's", async () => {
    const { h, person, api } = await setup();
    const a = await person("alice");
    await api(a, "POST", "/api/invest/ledger", ROW);
    h.clock.t = KST(2026, 11, 28);
    const again = await api<InvestLedgerEntry>(a, "POST", "/api/invest/ledger", { ...ROW, valueText: "2027 물량 완판" });
    expect([again.body.valueText, again.body.revision]).toEqual(["2027 물량 완판", "2026-11-28 고침"]);
    const noted = await api<InvestLedgerEntry>(a, "POST", "/api/invest/ledger", { ...ROW, revision: "2026-11-28 재확인(수요>공급 지속)" });
    expect(noted.body.revision).toBe("2026-11-28 재확인(수요>공급 지속)");
    expect((await api<{ items: unknown[] }>(a, "GET", `/api/invest/ledger?id=${encodeURIComponent(ROW.id)}`)).body.items).toHaveLength(1);
    // the code's own series are not written by anyone else, under any day
    for (const id of ["quote.NVDA", "atr14.SOXL"]) {
      const r = await api(a, "POST", "/api/invest/ledger", { ...ROW, id, unit: "usd", value: 1, valueText: null });
      expect([r.status, r.body.error]).toEqual([400, "ledger_reserved"]);
      expect(() => writeLedger(h.db, a.uid, { ...ROW, id }, "model", h.clock.t)).toThrow("코드가 계산하는 줄이에요. 다른 id를 써 주세요.");
    }
    // a row code wrote is not rewritten by the person or the model
    const code = { ...ROW, id: "fred.DGS10", asOf: "2026-11-25", unit: "pct", value: 4.12, valueText: null, source: "FRED", leadClass: null };
    writeLedger(h.db, a.uid, code, "code", h.clock.t);
    const locked = await api(a, "POST", "/api/invest/ledger", { ...code, value: 9.99 });
    expect([locked.status, locked.body.error]).toEqual([409, "ledger_locked"]);
    expect(() => writeLedger(h.db, a.uid, { ...code, value: 9.99 }, "model", h.clock.t)).toThrow("코드가 쓴 줄은 바꿀 수 없어요.");
    expect((await api<{ items: InvestLedgerEntry[] }>(a, "GET", "/api/invest/ledger?id=fred.DGS10")).body.items.map((e) => [e.value?.v, e.author])).toEqual([[4.12, "code"]]);
    // shared rows (user '') are code's alone
    expect(() => writeLedger(h.db, "", code, "model", h.clock.t)).toThrow("only code writes shared ledger rows");
    expect(() => writeLedger(h.db, "", code, "person", h.clock.t)).toThrow("only code writes shared ledger rows");
  });

  test("isolation: each person reads their own rows and the shared ones, never another's; one id is a row per person", async () => {
    const { h, person, api } = await setup();
    const a = await person("alice");
    const b = await person("bob");
    await api(a, "POST", "/api/invest/ledger", { ...ROW, id: "D01.tokens", unit: "T", value: 1.5, valueText: null });
    await api(b, "POST", "/api/invest/ledger", { ...ROW, id: "D01.tokens", unit: "T", value: 9.9, valueText: null });
    await api(a, "POST", "/api/invest/ledger", { ...ROW, id: "alice.only" });
    writeLedger(h.db, "", { ...ROW, id: "fred.HY", asOf: "2026-11-20", unit: "pct", value: 3.76, valueText: null, source: "FRED", leadClass: null }, "code", NOW);
    const read = async (p: Person, q = "") => (await api<{ items: InvestLedgerEntry[] }>(p, "GET", `/api/invest/ledger${q}`)).body.items.map((e) => [e.id, e.value?.v ?? e.valueText, e.shared]);
    expect(await read(a, "?id=D01.tokens")).toEqual([["D01.tokens", 1.5, false]]);
    expect(await read(b, "?id=D01.tokens")).toEqual([["D01.tokens", 9.9, false]]);
    expect(await read(b, "?id=alice.only")).toEqual([]);
    expect((await read(a)).sort()).toEqual([["D01.tokens", 1.5, false], ["alice.only", ROW.valueText, false], ["fred.HY", 3.76, true]].sort());
    expect((await read(b)).sort()).toEqual([["D01.tokens", 9.9, false], ["fred.HY", 3.76, true]].sort());
    const rows = h.db.sql.query("SELECT user_id, id FROM invest_ledger WHERE id = 'D01.tokens' ORDER BY user_id").all() as { user_id: string }[];
    expect(rows.map((r) => r.user_id).sort()).toEqual([a.uid, b.uid].sort());
  });

  test("a person's own rows stop at the cap; code's rows are not counted", async () => {
    const { h, person, api } = await setup();
    const a = await person("alice");
    const ins = h.db.sql.query("INSERT INTO invest_ledger (user_id, id, as_of, unit, definition, source_tier, source, confidence, author, created_at) VALUES ($u, $id, '2026-11-01', 'count', 'd', 'T1', 's', 'A', $by, 1)");
    h.db.tx(() => {
      for (let i = 0; i < MAX_LEDGER_ROWS; i++) ins.run({ u: a.uid, id: `r${i}`, by: i % 2 ? "model" : "person" });
      ins.run({ u: a.uid, id: "code.row", by: "code" });
    });
    const r = await api(a, "POST", "/api/invest/ledger", { ...ROW, id: "one.more" });
    expect([r.status, r.body.error, r.body.message]).toEqual([400, "too_many_ledger_rows", "원장 줄은 5,000개까지 쓸 수 있어요."]);
    // rewriting a row of theirs is not a new one
    expect((await api(a, "POST", "/api/invest/ledger", { ...ROW, id: "r1", asOf: "2026-11-01" })).status).toBe(201);
  });

  test("v10 on a schema-9 database: the v8 rows keep their source name and become tier T2", async () => {
    const { h, person, api } = await setup();
    const a = await person("alice");
    h.db.sql.exec(
      "DROP TABLE invest_proposals; DROP TABLE invest_forecasts; DROP TABLE invest_events; DROP TABLE invest_event_reminders; DROP INDEX invest_ledger_recent; ALTER TABLE invest_ledger DROP COLUMN source; PRAGMA user_version = 9;",
    );
    h.db.sql
      .query("INSERT INTO invest_ledger (user_id, id, as_of, value, unit, definition, source_tier, url, confidence, author, created_at) VALUES ($u, 'quote.NVDA', '2026-11-26T15:00:00.000Z', 180.5, 'usd', '5분 감시 가격', '토스증권', NULL, 'A', 'code', 5)")
      .run({ u: a.uid });
    const again = new Db(join(h.dir, "pickle.db"));
    expect(again.schemaVersion).toBe(11); // v10, then v11 (B2b-1 proposals)
    expect(again.sql.query("SELECT source, source_tier, confidence FROM invest_ledger WHERE id = 'quote.NVDA'").get()).toEqual({ source: "토스증권", source_tier: "T2", confidence: "A" });
    again.close();
    const [e] = (await api<{ items: InvestLedgerEntry[] }>(a, "GET", "/api/invest/ledger?id=quote.NVDA")).body.items;
    expect([e!.source, e!.sourceTier, e!.value]).toEqual(["토스증권", "T2", { v: 180.5, text: "$180.50" }]);
  });
});

// ───────────────────────────── forecasts ─────────────────────────────

const FORECAST = { claim: "미 10년물 금리가 연말에 4.0~4.5% 안에 있다", p: 0.65, interval: { lo: 4, hi: 4.5, unit: "pct" }, dueOn: "2026-12-31", criterion: "12-31 FRED DGS10 종가", ledgerIds: ["fred.DGS10"] };

describe("the forecast ledger", () => {
  test("a forecast is made today and stated once: its words come from the server; it is never deleted", async () => {
    const { h, person, api } = await setup();
    const a = await person("alice");
    const r = await api<InvestForecast>(a, "POST", "/api/invest/forecasts", FORECAST);
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({
      madeOn: "2026-11-27",
      claim: FORECAST.claim,
      probability: { v: 0.65, text: "65%" },
      interval: { lo: 4, hi: 4.5, unit: "pct", text: "4.00% ~ 4.50%" },
      dueOn: "2026-12-31",
      dueText: "12월 31일까지",
      criterion: "12-31 FRED DGS10 종가",
      status: "open",
      statusText: "기한 전",
      actual: null,
      intervalError: null,
      errorCause: null,
      errorCauseText: null,
      proposal: null,
      ledgerIds: ["fred.DGS10"],
      author: "person",
      resolvedAt: null,
      rev: 1,
    });
    expect(r.body.id).toMatch(/^if_/);
    // the claim, probability and due day do not change through a judgement, and there is no delete
    const j = await api<InvestForecast>(a, "PATCH", `/api/invest/forecasts/${r.body.id}`, { outcome: null, claim: "바꿔치기", p: 0.99, dueOn: "2026-12-01" });
    expect([j.body.claim, j.body.probability.v, j.body.dueOn]).toEqual([FORECAST.claim, 0.65, "2026-12-31"]);
    expect((await api(a, "DELETE", `/api/invest/forecasts/${r.body.id}`)).status).toBe(405);
    expect(h.db.sql.query("SELECT COUNT(*) AS n FROM invest_forecasts").get()).toEqual({ n: 1 });
  });

  test("each field is checked (400 invalid_forecast)", async () => {
    const { person, api } = await setup();
    const a = await person("alice");
    const cases: [Record<string, unknown>, string][] = [
      [{ claim: " " }, "예측을 넣어 주세요."],
      [{ claim: "가".repeat(201) }, "예측은 200자까지예요."],
      [{ p: 0 }, "확률은 0과 1 사이의 수로 넣어 주세요(두 끝은 빼요)."],
      [{ p: 1 }, "확률은 0과 1 사이의 수로 넣어 주세요(두 끝은 빼요)."],
      [{ p: 65 }, "확률은 0과 1 사이의 수로 넣어 주세요(두 끝은 빼요)."],
      [{ p: "0.6" }, "확률은 0과 1 사이의 수로 넣어 주세요(두 끝은 빼요)."],
      [{ interval: { lo: 4.5, hi: 4, unit: "pct" } }, "구간의 아래 끝이 위 끝보다 커요."],
      [{ interval: { lo: "4", hi: 4.5, unit: "pct" } }, "구간의 두 끝을 숫자로 넣어 주세요."],
      [{ interval: { lo: 4, hi: 4.5, unit: "text" } }, "구간 단위는 usd, krw, index, pct, pctp, qty, bp, count, T, GW, $B 가운데 하나예요."],
      [{ dueOn: "2026-11-26" }, "기한 2026-11-26은 이미 지났어요. 오늘은 2026-11-27이에요."], // DD 0521 §2
      [{ dueOn: "2026-11-25" }, "기한 2026-11-25는 이미 지났어요. 오늘은 2026-11-27이에요."],
      [{ dueOn: "2029-12-01" }, "기한은 3년 안으로 정해 주세요."],
      [{ dueOn: "12월 31일" }, "기한은 날짜(YYYY-MM-DD)로 넣어 주세요."],
      [{ criterion: undefined }, "판정 기준을 넣어 주세요."],
      [{ ledgerIds: Array.from({ length: 11 }, (_, i) => `x${i}`) }, "근거 원장 id는 10개까지, 원장 id 꼴로 넣어 주세요."],
      [{ ledgerIds: ["bad id"] }, "근거 원장 id는 10개까지, 원장 id 꼴로 넣어 주세요."],
    ];
    for (const [patch, message] of cases) {
      const r = await api(a, "POST", "/api/invest/forecasts", { ...FORECAST, ...patch });
      expect([r.status, r.body.error, r.body.message, JSON.stringify(patch)]).toEqual([400, "invalid_forecast", message, JSON.stringify(patch)]);
    }
    // today is fine as a due day; no interval is fine
    expect((await api(a, "POST", "/api/invest/forecasts", { ...FORECAST, dueOn: "2026-11-27", interval: null })).status).toBe(201);
  });

  test("DD 0405 E: a due day in this KST year has no year; another year names it, also once the year turns", async () => {
    const { h, person, api } = await setup();
    const a = await person("alice");
    const due = async (dueOn: string) => (await api<InvestForecast>(a, "POST", "/api/invest/forecasts", { ...FORECAST, claim: `기한 ${dueOn}`, dueOn })).body.dueText;
    expect(await due("2026-12-31")).toBe("12월 31일까지");
    expect(await due("2027-03-31")).toBe("2027년 3월 31일까지");
    expect(await due("2029-01-05")).toBe("2029년 1월 5일까지");
    // 2027-01-01 00:00 KST: the 2026 one now names its year, the 2027 one no longer does
    h.clock.t = KST(2027, 1, 1, 0, 0);
    const list = (await api<InvestForecastList>(a, "GET", "/api/invest/forecasts")).body.items;
    expect(list.map((f) => [f.dueOn, f.dueText])).toEqual([
      ["2026-12-31", "2026년 12월 31일까지"],
      ["2027-03-31", "3월 31일까지"],
      ["2029-01-05", "2029년 1월 5일까지"],
    ]);
    // the model's early judgement names the day the same way
    const early = (dueOn: string) => {
      try {
        proposeJudgement(h.db, a.uid, list.find((f) => f.dueOn === dueOn)!.id, { outcome: "hit" }, "모시", h.clock.t);
        return "judged";
      } catch (err) {
        return (err as Error).message;
      }
    };
    expect(early("2029-01-05")).toBe("2029년 1월 5일이 지나야 판정할 수 있어요.");
    expect(early("2027-03-31")).toBe("3월 31일이 지나야 판정할 수 있어요.");
  });

  test("statuses and the person's judgement: words, causes only for a miss or partial hit, the interval error, a stale screen", async () => {
    const { h, person, api } = await setup();
    const a = await person("alice");
    const f = (await api<InvestForecast>(a, "POST", "/api/invest/forecasts", FORECAST)).body;
    const judge = (body: unknown) => api<InvestForecast & { error?: string; message?: string; forecast?: InvestForecast }>(a, "PATCH", `/api/invest/forecasts/${f.id}`, body);
    h.clock.t = KST(2026, 12, 31, 23, 59);
    expect((await api<InvestForecastList>(a, "GET", "/api/invest/forecasts")).body.items[0]!.statusText).toBe("기한 전");
    h.clock.t = KST(2027, 1, 1, 0, 0);
    expect((await api<InvestForecastList>(a, "GET", "/api/invest/forecasts")).body.items[0]).toMatchObject({ status: "waiting", statusText: "판정 기다림" });
    const bad = await judge({ outcome: "hit", errorCause: "timing" });
    expect([bad.status, bad.body.message]).toEqual([400, "오차 원인은 빗나감이나 부분 적중일 때만 골라요."]);
    expect((await judge({})).body.message).toBe("판정을 골라 주세요.");
    expect((await judge({ outcome: "wrong" })).body.message).toBe("판정은 hit, miss, partial 가운데 하나예요.");
    expect((await judge({ outcome: "miss", errorCause: "luck" })).body.message).toBe("오차 원인은 data, interpretation, model, timing, narrative 가운데 하나예요.");
    const miss = await judge({ outcome: "miss", errorCause: "timing", actual: 4.7, rev: 1 });
    expect(miss.body).toMatchObject({ status: "miss", statusText: "빗나감", errorCause: "timing", errorCauseText: "시기", actual: { v: 4.7, text: "4.70%" }, resolvedAt: KST(2027, 1, 1, 0, 0), rev: 2 });
    expect(miss.body.intervalError!.text).toBe("구간보다 0.20%p 위");
    expect(miss.body.intervalError!.v).toBeCloseTo(0.2, 10);
    const stale = await judge({ outcome: "hit", rev: 1 });
    expect([stale.status, stale.body.error, stale.body.forecast?.status]).toEqual([409, "forecast_changed", "miss"]);
    const hit = await judge({ outcome: "hit", actual: 4.2, rev: 2 });
    expect(hit.body).toMatchObject({ status: "hit", statusText: "적중", errorCause: null, intervalError: { v: 0, text: "구간 안" }, rev: 3 });
    const partial = await judge({ outcome: "partial", errorCause: "data" });
    expect([partial.body.statusText, partial.body.errorCauseText, partial.body.actual?.v]).toEqual(["부분 적중", "데이터", 4.2]);
    const back = await judge({ outcome: null });
    expect(back.body).toMatchObject({ status: "waiting", statusText: "판정 기다림", errorCause: null, resolvedAt: null, rev: 5 });
    expect((await api(a, "PATCH", "/api/invest/forecasts/if_nope", { outcome: "hit" })).status).toBe(404);
  });

  test("DD 0405 D: the interval error says which end in words, the size as its unit writes it; v stays signed", async () => {
    const { h, person, api } = await setup();
    const a = await person("alice");
    const err = async (interval: { lo: number; hi: number; unit: string }, actual: number) => {
      h.clock.t = KST(2026, 11, 27, 9, 0);
      const f = (await api<InvestForecast>(a, "POST", "/api/invest/forecasts", { ...FORECAST, claim: `${interval.unit} ${actual}`, interval, dueOn: "2026-11-27" })).body;
      return (await api<InvestForecast>(a, "PATCH", `/api/invest/forecasts/${f.id}`, { outcome: "miss", actual })).body.intervalError!;
    };
    const pctBand = { lo: 4, hi: 4.5, unit: "pct" };
    const usdBand = { lo: 30, hi: 31, unit: "usd" };
    const above = await err(pctBand, 4.7);
    expect([above.text, above.v > 0]).toEqual(["구간보다 0.20%p 위", true]);
    const below = await err(pctBand, 3.8);
    expect([below.text, below.v < 0]).toEqual(["구간보다 0.20%p 아래", true]);
    expect(below.v).toBeCloseTo(-0.2, 10);
    const up = await err(usdBand, 31.3);
    expect([up.text, up.v > 0]).toEqual(["구간보다 $0.30 위", true]);
    expect(up.v).toBeCloseTo(0.3, 10);
    const down = await err(usdBand, 29.7);
    expect([down.text, down.v < 0]).toEqual(["구간보다 $0.30 아래", true]);
    expect(down.v).toBeCloseTo(-0.3, 10);
    expect((await err({ lo: 100_000, hi: 120_000, unit: "krw" }, 98_500)).text).toBe("구간보다 1,500원 아래");
    expect((await err({ lo: 1, hi: 1.5, unit: "pctp" }, 1.62)).text).toBe("구간보다 0.12%p 위");
    expect(await err(usdBand, 31)).toEqual({ v: 0, text: "구간 안" });
  });

  test("the score, by due day: 3- and 12-month hit rates and the 12-month Brier score without partial hits (worked by hand)", async () => {
    const { h, person, api } = await setup();
    const a = await person("alice");
    // made on 2025-10-01 (through the same path, the person's session is today's); scored on 2026-11-27: the 3-month
    // window is due days from 2026-08-27, the 12-month from 2025-11-27
    const plan: [string, number, "hit" | "miss" | "partial" | null][] = [
      ["2026-10-15", 0.8, "hit"], // 3m, 12m: (0.8 − 1)² = 0.04
      ["2026-09-30", 0.6, "miss"], // 3m, 12m: (0.6 − 0)² = 0.36
      ["2026-06-30", 0.7, "hit"], // 12m: 0.09
      ["2026-03-31", 0.9, "hit"], // 12m: 0.01
      ["2026-07-31", 0.55, "partial"], // 12m, out of both scores
      ["2025-11-15", 0.5, "hit"], // before the 12-month window: out
      ["2026-12-31", 0.7, null], // open
      ["2026-11-20", 0.6, null], // waiting
    ];
    const ids: string[] = [];
    for (const [dueOn, p] of plan) ids.push(createForecast(h.db, a.uid, { ...FORECAST, interval: null, claim: `기한 ${dueOn}`, dueOn, p }, "person", KST(2025, 10, 1)).id);
    for (const [i, [, , outcome]] of plan.entries()) {
      if (!outcome) continue;
      h.clock.t += 1000;
      expect((await api(a, "PATCH", `/api/invest/forecasts/${ids[i]}`, { outcome })).status).toBe(200);
    }
    const list = (await api<InvestForecastList>(a, "GET", "/api/invest/forecasts")).body;
    // 3m: 1 hit of 2 = 50%; 12m: 3 of 4 = 75%; Brier (0.04 + 0.36 + 0.09 + 0.01) / 4 = 0.125 → 0.13
    expect(list.score.rows).toEqual([
      { key: "hit3m", text: "방향 적중률 3개월 50% · 2건 · 목표 65%" },
      { key: "hit12m", text: "방향 적중률 12개월 75% · 4건 · 목표 65%" },
      { key: "brier", text: "Brier 점수 0.13 · 목표 0.25 이하", foot: "0에 가까울수록 잘 맞힌 거예요." },
    ]);
    expect(list.score.partialFoot).toBe("부분 적중 1건은 두 점수에 넣지 않았어요.");
    expect(list.score.empty).toBeUndefined();
    expect([list.score.hitRate3m, list.score.hitRate12m, list.score.judged, list.score.partial]).toEqual([0.5, 0.75, 4, 1]);
    expect(list.score.brier).toBeCloseTo(0.125, 12);
    // waiting first, then open, then the judged, latest judged first
    expect(list.items.map((f) => f.claim)).toEqual(["기한 2026-11-20", "기한 2026-12-31", "기한 2025-11-15", "기한 2026-07-31", "기한 2026-03-31", "기한 2026-06-30", "기한 2026-09-30", "기한 2026-10-15"]);
    expect(list.items.map((f) => f.statusText)).toEqual(["판정 기다림", "기한 전", "적중", "부분 적중", "적중", "적중", "빗나감", "적중"]);
    expect(list.outcomes).toEqual([
      { value: "hit", word: "적중" },
      { value: "miss", word: "빗나감" },
      { value: "partial", word: "부분 적중" },
    ]);
    expect(list.causes).toEqual([
      { value: "data", word: "데이터", sentence: "데이터가 틀렸거나 늦게 나왔어요" },
      { value: "interpretation", word: "해석", sentence: "데이터를 잘못 읽었어요" },
      { value: "model", word: "모델", sentence: "계산 방법이 맞지 않았어요" },
      { value: "timing", word: "시기", sentence: "방향은 맞았는데 시기가 달랐어요" },
      { value: "narrative", word: "이야기", sentence: "그럴듯한 이야기에 기댔어요" },
    ]);
  });

  test("DD 0405 C: no row → always one sentence (nothing judged, partial hits only, all older than 12 months), and the partial foot only beside rows", async () => {
    const { h, person, api } = await setup();
    const a = await person("alice");
    const score = async () => {
      h.clock.t += 1;
      const s = (await api<InvestForecastList>(a, "GET", "/api/invest/forecasts")).body.score;
      expect(s.rows.length === 0).toBe(s.empty !== undefined); // empty ⇔ no row
      return s;
    };
    // nothing judged
    expect(await score()).toEqual({ rows: [], empty: "아직 판정한 예측이 없어요.", hitRate3m: null, hitRate12m: null, brier: null, judged: 0, partial: 0 });
    // partial hits only in 12 months: their own sentence, no foot
    const made = (dueOn: string) => createForecast(h.db, a.uid, { ...FORECAST, interval: null, claim: `기한 ${dueOn}`, dueOn }, "person", KST(2024, 6, 1)).id;
    const p1 = made("2026-10-31");
    const p2 = made("2026-05-31");
    for (const id of [p1, p2]) await api(a, "PATCH", `/api/invest/forecasts/${id}`, { outcome: "partial" });
    expect(await score()).toEqual({ rows: [], empty: "부분 적중 2건뿐이라 아직 점수를 내지 않아요.", hitRate3m: null, hitRate12m: null, brier: null, judged: 0, partial: 2 });
    // a judged forecast from before the 12-month window adds no row: still the partial sentence
    const old = made("2025-06-30");
    await api(a, "PATCH", `/api/invest/forecasts/${old}`, { outcome: "hit" });
    expect((await score()).empty).toBe("부분 적중 2건뿐이라 아직 점수를 내지 않아요.");
    // the partial hits taken back: everything judged is older than 12 months
    for (const id of [p1, p2]) await api(a, "PATCH", `/api/invest/forecasts/${id}`, { outcome: null });
    expect(await score()).toEqual({ rows: [], empty: "최근 12개월에 판정한 예측이 없어요.", hitRate3m: null, hitRate12m: null, brier: null, judged: 0, partial: 0 });
    // one row in 12 months (not 3) and a partial hit: rows, the foot, no sentence
    await api(a, "PATCH", `/api/invest/forecasts/${p2}`, { outcome: "miss" });
    await api(a, "PATCH", `/api/invest/forecasts/${p1}`, { outcome: "partial" });
    const s = await score();
    expect(s.rows.map((r) => r.text)).toEqual(["방향 적중률 12개월 0% · 1건 · 목표 65%", "Brier 점수 0.42 · 목표 0.25 이하"]);
    expect([s.partialFoot, s.empty]).toEqual(["부분 적중 1건은 두 점수에 넣지 않았어요.", undefined]);
  });

  test("isolation: another person neither sees, judges nor counts my forecasts", async () => {
    const { person, api } = await setup();
    const a = await person("alice");
    const b = await person("bob");
    const mine = (await api<InvestForecast>(a, "POST", "/api/invest/forecasts", FORECAST)).body;
    await api(a, "PATCH", `/api/invest/forecasts/${mine.id}`, { outcome: "hit" });
    const theirs = await api(b, "PATCH", `/api/invest/forecasts/${mine.id}`, { outcome: "miss", errorCause: "model" });
    expect([theirs.status, theirs.body.error]).toEqual([404, "forecast_not_found"]);
    const bl = (await api<InvestForecastList>(b, "GET", "/api/invest/forecasts")).body;
    expect([bl.items, bl.score.empty]).toEqual([[], "아직 판정한 예측이 없어요."]);
    const al = (await api<InvestForecastList>(a, "GET", "/api/invest/forecasts")).body;
    expect(al.items.map((f) => [f.id, f.status])).toEqual([[mine.id, "hit"]]);
    expect(al.score.hitRate12m).toBe(1);
  });

  test("a person's forecasts stop at the cap", async () => {
    const { h, person, api } = await setup();
    const a = await person("alice");
    const ins = h.db.sql.query("INSERT INTO invest_forecasts (id, user_id, made_on, claim, p, due_on, criterion, author, created_at, updated_at) VALUES ($id, $u, '2026-11-01', 'c', 0.5, '2026-12-01', 'k', 'person', 1, 1)");
    h.db.tx(() => {
      for (let i = 0; i < MAX_FORECASTS; i++) ins.run({ id: `if_${i}`, u: a.uid });
    });
    const r = await api(a, "POST", "/api/invest/forecasts", FORECAST);
    expect([r.status, r.body.error, r.body.message]).toEqual([400, "too_many_forecasts", "예측은 500개까지 남길 수 있어요."]);
  });

  test("months back clamp to the month's last day", () => {
    expect(monthsBack("2026-11-27", 3)).toBe("2026-08-27");
    expect(monthsBack("2026-11-27", 12)).toBe("2025-11-27");
    expect(monthsBack("2026-05-31", 3)).toBe("2026-02-28");
    expect(monthsBack("2024-05-31", 3)).toBe("2024-02-29");
    expect(monthsBack("2026-01-15", 3)).toBe("2025-10-15");
    expect(monthsBack("2026-03-31", 1)).toBe("2026-02-28");
  });
});
