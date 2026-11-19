import { describe, expect, test } from "bun:test";
import { arrivedBelow, type NewsMark } from "../src/screens/chat/newsBelow";

/**
 * ThreadView's "새 메시지" (offered while the person reads above) turns on for rows added below and a live answer that
 * moves, never for a row going away: a failed briefing attempt's "오늘의 브리핑" row deleted by the server
 * (`message_deleted`) was the last row, and the row now last was there already.
 */

const mark = (ids: string[], draft = "0:0:0"): NewsMark => ({ lastId: ids[ids.length - 1] ?? null, draft, items: ids.map((id) => ({ id })) });

describe("arrivedBelow", () => {
  test("the last row deleted (message_deleted): not news", () => {
    expect(arrivedBelow(mark(["a", "b", "chip"]), mark(["a", "b"]))).toBe(false);
  });

  test("the only row deleted (the list empties): not news", () => {
    expect(arrivedBelow(mark(["chip"]), mark([]))).toBe(false);
  });

  test("a row in the middle deleted: not news", () => {
    expect(arrivedBelow(mark(["a", "b", "c"]), mark(["a", "c"]))).toBe(false);
  });

  test("a row added at the end: news", () => {
    expect(arrivedBelow(mark(["a", "b"]), mark(["a", "b", "c"]))).toBe(true);
  });

  test("the first row of an empty list: news", () => {
    expect(arrivedBelow(mark([]), mark(["a"]))).toBe(true);
  });

  test("the last row deleted and a new one added in the same update: news", () => {
    expect(arrivedBelow(mark(["a", "chip"]), mark(["a", "d"]))).toBe(true);
  });

  test("the last row's id changes (a sent line's temp id becomes the server's): news, as before", () => {
    expect(arrivedBelow(mark(["a", "tmp-1"]), mark(["a", "m-1"]))).toBe(true);
  });

  test("an older page prepended: not news", () => {
    expect(arrivedBelow(mark(["c", "d"]), mark(["a", "b", "c", "d"]))).toBe(false);
  });

  test("the live answer moves (text, a card, a tool): news; unchanged: not news", () => {
    expect(arrivedBelow(mark(["a"], "12:0:0"), mark(["a"], "30:0:0"))).toBe(true);
    expect(arrivedBelow(mark(["a"], "30:0:0"), mark(["a"], "30:1:0"))).toBe(true);
    expect(arrivedBelow(mark(["a"], "30:1:0"), mark(["a"], "30:1:1"))).toBe(true);
    expect(arrivedBelow(mark(["a"], "30:1:1"), mark(["a"], "30:1:1"))).toBe(false);
  });

  test("the last row deleted while the live answer moves: news (the answer's move)", () => {
    expect(arrivedBelow(mark(["a", "chip"], "4:0:0"), mark(["a"], "9:0:0"))).toBe(true);
  });
});
