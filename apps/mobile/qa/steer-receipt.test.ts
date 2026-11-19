// "하던 일에 이어서 전했어요" under a steered line (screens/chat/composerStore.ts): which lines a failed or stopped turn
// left unanswered, so the receipt goes. ThreadView calls dropUnansweredSteers while the thread's error row is up;
// ThreadView and the call call dropStoppedSteers when a send of theirs comes back stopped; the call's transcript asks
// failedTurnSteers of its notes. That wiring is covered by the two-engine captures (normal turn, briefing, follow-up,
// Stop, 다시 보내기, call, next send).
import { describe, expect, test } from "bun:test";
import { dropStoppedSteers, dropUnansweredSteers, failedTurnSteers, markReceipt, receiptOf, unansweredSteers } from "../src/screens/chat/composerStore";

type Row = readonly [string, string];
/** "A" a line that started a turn, "B*" a steered line, "R" a reply, "E" an event row */
const rows = (spec: string): Row[] =>
  spec.split(" ").map((t) => [t, t.startsWith("R") ? "assistant" : t.startsWith("E") ? "event" : "user"] as const);
const failed = (spec: string) => unansweredSteers(rows(spec), (id) => id.endsWith("*"));

describe("unansweredSteers", () => {
  test("the person's turn fails: the lines steered into it, before or after its partial answer", () => {
    expect(failed("A1 R1 A2 B1*")).toEqual(["B1*"]); // nothing streamed, or the partial dated at the turn's start
    expect(failed("A1 R1 A2 R2 B1* B2*")).toEqual(["B1*", "B2*"]);
    expect(failed("A1 R1 A2 B1* B2* R2")).toEqual(["B1*", "B2*"]); // the server's partial, dated at the end
  });
  test("a briefing or schedule turn fails: only the lines that went into it", () => {
    expect(failed("B1*")).toEqual(["B1*"]);
    expect(failed("A1 Y1* R1 B1*")).toEqual(["B1*"]); // Y1 was answered by R1
    expect(failed("A1 Y1* R1 E1 B1*")).toEqual(["B1*"]);
    expect(failed("A1 Y1* R1 B1* R2")).toEqual(["B1*"]); // its partial answer
  });
  test("a follow-up turn fails: the lines the finished reply left to it", () => {
    expect(failed("A1 B1* R1")).toEqual(["B1*"]);
    expect(failed("A1 B1* B2* R1")).toEqual(["B1*", "B2*"]);
  });
  test("a later turn of the person's fails: earlier steered lines keep theirs", () => {
    expect(failed("A1 Y1* R1 A2")).toEqual([]);
    expect(failed("A1 Y1* R1 A2 R2")).toEqual([]);
    expect(failed("A1 Y1* R1 A2 R2 A3")).toEqual([]);
  });
  test("the walk back stops at the line that started the turn, an event row or an earlier reply", () => {
    expect(failed("A0 Y1* A1 B1* R1")).toEqual(["B1*"]); // Y1 went into an earlier turn that left nothing
    expect(failed("E1 B1* R1")).toEqual(["B1*"]);
    expect(failed("Y1* E1 R1")).toEqual([]);
    expect(failed("Y1* R0 R1")).toEqual([]);
  });
  test("nothing steered, nothing to drop", () => {
    expect(failed("A1 R1")).toEqual([]);
    expect(failed("A1")).toEqual([]);
    expect(unansweredSteers([], () => true)).toEqual([]);
  });
});

describe("dropUnansweredSteers", () => {
  test("drops only the failed turn's steer receipts; earlier steers and friend deliveries stay", () => {
    markReceipt("y1", "steered");
    markReceipt("b1", "steered");
    markReceipt("b2", "steered");
    markReceipt("d1", "delivered");
    const thread: Row[] = [
      ["a1", "user"],
      ["y1", "user"],
      ["r1", "assistant"],
      ["d1", "user"],
      ["b1", "user"],
      ["b2", "user"],
    ];
    dropUnansweredSteers(thread);
    expect([receiptOf("y1"), receiptOf("b1"), receiptOf("b2"), receiptOf("d1")]).toEqual(["steered", undefined, undefined, "delivered"]);
    // the next send ends the error row; nothing comes back, and a second pass changes nothing
    dropUnansweredSteers(thread);
    expect([receiptOf("y1"), receiptOf("b1"), receiptOf("b2"), receiptOf("d1")]).toEqual(["steered", undefined, undefined, "delivered"]);
  });
  test("a 202 that lands after the failure is dropped on the next pass", () => {
    const thread: Row[] = [
      ["a5", "user"],
      ["b5", "user"],
    ];
    dropUnansweredSteers(thread); // no receipt yet: b5 reads as the line that started a turn
    expect(receiptOf("b5")).toBeUndefined();
    markReceipt("b5", "steered");
    dropUnansweredSteers(thread);
    expect(receiptOf("b5")).toBeUndefined();
  });
});

/** thread messages: "tmp_…" ids are lines still being sent */
const items = (spec: string) => rows(spec).map(([id, role]) => ({ id, role }));

describe("failedTurnSteers (the call's notes)", () => {
  const thread = (spec: string, over: Partial<{ error: string; failed: string[]; streaming: boolean }> = {}) => ({
    error: "지금 요청이 많아요. 잠시 후 다시 시도해 주세요.",
    failed: [] as string[],
    streaming: false,
    items: items(spec),
    ...over,
  });
  const has = (id: string) => id.endsWith("*");
  test("only while the error row is up: an error, nothing of theirs unsent, no turn streaming", () => {
    expect(failedTurnSteers(thread("A1 B1*"), has)).toEqual(["B1*"]);
    expect(failedTurnSteers(thread("A1 B1*", { error: "" }), has)).toEqual([]);
    expect(failedTurnSteers(thread("A1 B1*", { failed: ["tmp_1"] }), has)).toEqual([]);
    expect(failedTurnSteers(thread("A1 B1*", { streaming: true }), has)).toEqual([]);
    expect(failedTurnSteers(undefined, has)).toEqual([]);
  });
  test("a line still being sent is not a row yet", () => {
    expect(failedTurnSteers(thread("A1 B1* R1 tmp_2"), has)).toEqual(["B1*"]);
  });
});

describe("dropStoppedSteers", () => {
  const stopped = { status: "aborted" as const, accepted: true };
  test("a send stopped after its turn started drops the receipts of the lines steered into it", () => {
    markReceipt("s1*", "steered");
    dropStoppedSteers(stopped, items("a1 s1*"));
    expect(receiptOf("s1*")).toBeUndefined();
  });
  test("with the partial answer after the line, and a next line already on its way", () => {
    markReceipt("s2*", "steered");
    dropStoppedSteers(stopped, items("a2 s2* R2 tmp_9"));
    expect(receiptOf("s2*")).toBeUndefined();
  });
  test("not stopped, or stopped before the server took it: nothing goes", () => {
    markReceipt("s3*", "steered");
    dropStoppedSteers({ status: "done", accepted: true }, items("a3 s3*"));
    dropStoppedSteers({ status: "failed", accepted: true }, items("a3 s3*"));
    dropStoppedSteers({ status: "aborted", accepted: false }, items("a3 s3*"));
    expect(receiptOf("s3*")).toBe("steered");
  });
  test("a steered line answered earlier keeps its receipt when a later turn is stopped", () => {
    markReceipt("s4*", "steered");
    dropStoppedSteers(stopped, items("a4 s4* R4 a5"));
    dropStoppedSteers(stopped, items("a4 s4* R4 a5 R5"));
    expect(receiptOf("s4*")).toBe("steered");
  });
});
