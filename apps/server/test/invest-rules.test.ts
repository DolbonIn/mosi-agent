/**
 * Invest rule logic without a server: the judgement, the state steps (team-lead 2045-8), what is known about the
 * earlier state, and the sentences the DD fixed (2042-b, 2100). Pure functions only.
 */
import { describe, expect, test } from "bun:test";
import {
  bufferFoot,
  bufferPrice,
  changeSentence,
  dedupeKey,
  expiresAt,
  iGa,
  eulReul,
  euroRo,
  judge,
  noPriorLine,
  priorReason,
  resultSentence,
  SEEN_EDITED,
  SEEN_RESUMED,
  stateFoot,
  stateText,
  step,
  stopBasis,
  stopWarning,
  type RuleSpec,
  type RuleWatchState,
} from "../src/invest/rules.ts";

const stop = (p: Partial<RuleSpec> = {}): RuleSpec => ({
  symbol: "SOXL",
  kind: "stop",
  level: null,
  price: 27,
  lo: null,
  hi: null,
  direction: "below",
  action: "notify",
  once: 0,
  buffer_pct: null,
  until_day: null,
  ...p,
});
const armed = (p: Partial<RuleWatchState> = {}): RuleWatchState => ({ state: "armed", hit_at: null, hit_seq: 0, cleared_at: null, paused_at: null, seen_slot: null, ...p });

describe("judge", () => {
  test("intraday stop: at or below the stop", () => {
    expect(judge(stop(), 27, false, "intraday", null)).toBe("in");
    expect(judge(stop(), 26.99, false, "intraday", null)).toBe("in");
    expect(judge(stop(), 27.01, false, "intraday", null)).toBe("out");
  });

  test("close-basis stop: waits between the buffer and the stop in the session, decides at the close check", () => {
    const buf = bufferPrice("US", 27, 5);
    expect(buf).toBe(25.65);
    expect(judge(stop(), 26, false, "close_and_intraday", buf)).toBe("wait");
    expect(judge(stop(), 25.65, false, "close_and_intraday", buf)).toBe("in");
    expect(judge(stop(), 27.5, false, "close_and_intraday", buf)).toBe("out");
    expect(judge(stop(), 26, true, "close_and_intraday", buf)).toBe("in");
    expect(judge(stop(), 27.01, true, "close_and_intraday", buf)).toBe("out");
  });

  test("target and alert reach the line; resistance must pass it; a zone holds both ends", () => {
    const t = stop({ kind: "target", direction: "above", price: 30, level: 1 });
    expect(judge(t, 30, false, "intraday", null)).toBe("in");
    expect(judge(t, 29.99, false, "intraday", null)).toBe("out");
    const r = stop({ kind: "resistance", direction: "above", price: 34.1 });
    expect(judge(r, 34.1, false, "intraday", null)).toBe("out");
    expect(judge(r, 34.11, false, "intraday", null)).toBe("in");
    const z = stop({ kind: "buy_zone", direction: "inside", price: null, lo: 20, hi: 22 });
    expect([19.99, 20, 22, 22.01].map((p) => judge(z, p, false, "intraday", null))).toEqual(["out", "in", "in", "out"]);
    const up = stop({ kind: "alert", direction: "above", price: 40 });
    const down = stop({ kind: "alert", direction: "below", price: 40 });
    expect([judge(up, 40, false, "intraday", null), judge(up, 39, false, "intraday", null)]).toEqual(["in", "out"]);
    expect([judge(down, 40, false, "intraday", null), judge(down, 41, false, "intraday", null)]).toEqual(["in", "out"]);
  });

  test("basis: close only when ATR14 is wider than the stop's distance; unknown ATR or reference → intraday", () => {
    expect(stopBasis(2, 27, 28.5)).toBe("close_and_intraday");
    expect(stopBasis(1.5, 27, 28.5)).toBe("intraday");
    expect(stopBasis(null, 27, 28.5)).toBe("intraday");
    expect(stopBasis(2, 27, null)).toBe("intraday");
    expect(stopBasis(2, 27, 26)).toBe("intraday");
  });
});

describe("step (다시 알림)", () => {
  const r = stop();
  test("inside while armed: one alert, hit; inside while hit: nothing", () => {
    const a = step(r, armed({ seen_slot: "US:2026-11-30:09:45" }), "in", "US:2026-11-30:09:50", "US:2026-11-30:09:45", 1000);
    expect(a.alert).toBe(true);
    expect(a.noPrior).toBeNull();
    expect(a.next).toMatchObject({ state: "hit", hit_at: 1000, hit_seq: 1, seen_slot: "US:2026-11-30:09:50" });
    const b = step(r, a.next, "in", "US:2026-11-30:09:55", "US:2026-11-30:09:50", 2000);
    expect(b.alert).toBe(false);
    expect(b.next).toMatchObject({ state: "hit", hit_seq: 1, seen_slot: "US:2026-11-30:09:55" });
  });

  test("one check outside clears a hit; touching again the same day is a new alert with a new dedupe key", () => {
    const a = step(r, armed({ seen_slot: "k0" }), "in", "k1", "k0", 1000);
    const out = step(r, a.next, "out", "k2", "k1", 2000);
    expect(out.alert).toBe(false);
    expect(out.next).toMatchObject({ state: "armed", cleared_at: 2000, hit_seq: 1 });
    const again = step(r, out.next, "in", "k3", "k2", 3000);
    expect(again.alert).toBe(true);
    expect(again.noPrior).toBeNull();
    expect(again.next.hit_seq).toBe(2);
    expect(dedupeKey("ir1", 1, a.next.hit_seq)).not.toBe(dedupeKey("ir1", 1, again.next.hit_seq));
  });

  test("waiting (close-basis, between buffer and stop) changes nothing but the seen slot", () => {
    const w = step(r, armed({ seen_slot: "k0" }), "wait", "k1", "k0", 1000);
    expect(w.alert).toBe(false);
    expect(w.next).toEqual(armed({ seen_slot: "k1" }));
    const hit = step(r, armed({ seen_slot: "k0" }), "in", "k1", "k0", 1000).next;
    expect(step(r, hit, "wait", "k2", "k1", 2000).next).toMatchObject({ state: "hit", cleared_at: null });
  });

  test("once → paused after the alert; a sell stop always pauses; paused and expired are untouched", () => {
    const once = step(stop({ once: 1 }), armed(), "in", "k1", "k0", 1000);
    expect(once.next).toMatchObject({ state: "paused", paused_at: 1000, hit_seq: 1 });
    const sell = step(stop({ action: "sell" }), armed(), "in", "k1", "k0", 1000);
    expect(sell.next).toMatchObject({ state: "paused", paused_at: 1000 });
    for (const st of ["paused", "expired"] as const) {
      const w = armed({ state: st, seen_slot: "k0" });
      const s = step(r, w, "in", "k1", "k0", 1000);
      expect(s.alert).toBe(false);
      expect(s.next).toBe(w);
    }
  });

  test("earlier state: known only when the rule was seen at the check right before", () => {
    expect(priorReason("US:2026-11-27:13:05", "US:2026-11-27:13:05")).toBeNull();
    expect(priorReason(null, "k")).toBe("first");
    expect(priorReason(SEEN_EDITED, "k")).toBe("edited");
    expect(priorReason(SEEN_RESUMED, "k")).toBe("resumed");
    expect(priorReason("US:2026-11-30:10:00", "US:2026-11-30:10:10")).toBe("gap");
    expect(priorReason("k", null)).toBe("gap");
    expect(step(r, armed({ seen_slot: SEEN_EDITED }), "in", "k1", "k0", 1).noPrior).toBe("edited");
  });

  test("expiry: after the deadline day, or at its close check", () => {
    const r2 = stop({ until_day: "2026-12-01" });
    expect(expiresAt(r2, "2026-12-01", false)).toBe(false);
    expect(expiresAt(r2, "2026-12-01", true)).toBe(true);
    expect(expiresAt(r2, "2026-12-02", false)).toBe(true);
    expect(expiresAt(stop(), "2030-01-01", true)).toBe(false);
  });
});

describe("sentences (DD 2042-b, 2100)", () => {
  test("noPrior title lines", () => {
    const below = stop();
    const above = stop({ kind: "resistance", direction: "above" });
    const zone = stop({ kind: "buy_zone", direction: "inside" });
    expect(noPriorLine("first", below)).toBe("감시를 시작할 때 이미 아래에 있었어요.");
    expect(noPriorLine("first", above)).toBe("감시를 시작할 때 이미 위에 있었어요.");
    expect(noPriorLine("first", zone)).toBe("감시를 시작할 때 이미 구간 안에 있었어요.");
    expect(noPriorLine("edited", below)).toBe("규칙을 고칠 때 이미 아래에 있었어요.");
    expect(noPriorLine("resumed", above)).toBe("다시 감시할 때 이미 위에 있었어요.");
    expect(noPriorLine("gap", below)).toBe("시세를 받지 못한 사이에 닿았어요. 닿은 시각은 몰라요.");
  });

  test("result sentences by basis and mode (§3)", () => {
    const close = { market: "US" as const, basis: "close_and_intraday" as const, buffer: 25.65, qty: 47 };
    expect(resultSentence(stop({ action: "sell" }), { ...close, mode: "real" })).toBe(
      "실제 주문이 켜져 있어서, 종가가 $27.00 이하로 마감하면 다음 거래일 개장 15분 뒤에, 장중에 $25.65 이하로 내려가면 그때 바로 47주를 시장가로 팔아요.",
    );
    expect(resultSentence(stop({ action: "sell" }), { ...close, basis: "intraday", buffer: null, mode: "real" })).toBe("실제 주문이 켜져 있어서, 장중에 $27.00 이하로 내려가면 바로 47주를 시장가로 팔아요.");
    expect(resultSentence(stop({ action: "sell" }), { ...close, mode: "mock" })).toBe(
      "종가가 $27.00 이하로 마감하거나 장중에 $25.65 이하로 내려가면 손절 조건이에요. 모의 주문이라 팔지 않고, 위 조건에 닿은 시점과 가격만 기록해요.",
    );
    expect(resultSentence(stop(), { ...close, mode: "mock" })).toBe("종가가 $27.00 이하로 마감하거나 장중에 $25.65 이하로 내려가면 알려요.");
    expect(resultSentence(stop({ action: "call" }), { ...close, mode: "mock" })).toBe("종가가 $27.00 이하로 마감하거나 장중에 $25.65 이하로 내려가면 전화로 알려요.");
    expect(resultSentence(stop(), { ...close, basis: "intraday", buffer: null, mode: "mock" })).toBe("장중에 $27.00 이하로 내려가면 알려요.");
  });

  test("change sentence, stop warning, buffer foot", () => {
    expect(changeSentence("US", stop({ price: 25.8 }), stop())).toBe("SOXL 손절을 $25.80에서 $27.00으로 바꿔요.");
    expect(stopWarning("US", stop(), 26.5, true)).toBe("지금 가격 $26.50보다 높아서, 바꾸면 바로 손절 조건이 돼요.");
    expect(stopWarning("US", stop(), 26.5, false)).toBe("지금 가격 $26.50보다 높아서, 저장하면 바로 손절 조건이 돼요.");
    expect(stopWarning("US", stop(), 28, false)).toBeNull();
    expect(bufferFoot("close_and_intraday", true)).toBe("종가로 판단할 때, 장중 가격이 손절선보다 이만큼 더 내려가면 마감을 기다리지 않아요. 원문에 숫자가 없어서 정한 운영 기본값(5%)이에요.");
    expect(bufferFoot("intraday", false)).toBe("지금은 장중 가격만으로 판단해요. 종가로 판단할 때, 장중 가격이 손절선보다 이만큼 더 내려가면 마감을 기다리지 않아요. 기본값은 5%예요.");
  });

  test("state words and the paused foot (§1)", () => {
    const at = Date.UTC(2026, 10, 26, 15, 45); // 11-27 00:45 KST
    expect(stateText(armed(), null)).toBe("대기");
    expect(stateText(armed(), "2026-12-01")).toBe("12-01까지");
    expect(stateText(armed({ state: "paused", paused_at: at, hit_at: at }), null)).toBe("멈춤 · 11-27 00:45");
    expect(stateFoot(armed({ state: "paused", paused_at: at, hit_at: at }))).toBe("11월 27일 00:45에 닿아서 멈췄어요.");
    expect(stateText(armed({ state: "expired" }), "2026-12-01")).toBe("만료");
  });

  test("particles follow the last sound, digits and Latin letters included", () => {
    expect([iGa("SOXL"), iGa("KORU"), iGa("TQQQ"), iGa("005930")]).toEqual(["SOXL이", "KORU가", "TQQQ가", "005930이"]);
    expect([eulReul("$27.00"), eulReul("$34.10"), eulReul("$25.65")]).toEqual(["$27.00을", "$34.10을", "$25.65를"]);
    expect([euroRo("$27.00"), euroRo("$25.65"), euroRo("7%")]).toEqual(["$27.00으로", "$25.65로", "7%로"]);
  });
});
