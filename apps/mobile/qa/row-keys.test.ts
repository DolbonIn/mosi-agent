import { describe, expect, test } from "bun:test";
import type { Message } from "@pickle/protocol";
import { rowKeys } from "../src/screens/chat/rowKeys";

/**
 * ThreadView keys its rows through rowKeys (DD 1957 1): the optimistic copy of a line (a temp id) and the server's row
 * that takes its place in one store change stay one element, so the row's entrance goes on instead of starting over.
 * Every other row is keyed by its id.
 */

let at = 1_900_000_000_000;
const row = (id: string, role: Message["role"], text: string): Message => ({ id, threadId: "t1", role, text, cards: [], tools: [], attachments: [], createdAt: ++at });
const keys = (k: ReturnType<typeof rowKeys>, items: Message[]) => {
  const r = k(items);
  return items.map((m) => r.keyOf(m));
};

describe("rowKeys: an optimistic line and its server row are one row", () => {
  test("the server row that replaces the copy keeps the copy's key; rows before and after keep their ids", () => {
    const k = rowKeys();
    const hi = row("m1", "assistant", "안녕하세요");
    const copy = row("tmp_a1", "user", "오늘 날씨 알려줘");
    expect(keys(k, [hi, copy])).toEqual(["m1", "tmp_a1"]);
    const server = row("m2", "user", "오늘 날씨 알려줘");
    const answer = row("m3", "assistant", "맑아요");
    expect(keys(k, [hi, server])).toEqual(["m1", "tmp_a1"]);
    expect(keys(k, [hi, server, answer])).toEqual(["m1", "tmp_a1", "m3"]);
    // the same items again (a re-render) and a later change keep it
    expect(keys(k, [hi, server, answer])).toEqual(["m1", "tmp_a1", "m3"]);
  });

  test("two copies of the same text pair up in order, also when their rows come one change apart", () => {
    const k = rowKeys();
    const c1 = row("tmp_b1", "user", "고마워");
    const c2 = row("tmp_b2", "user", "고마워");
    keys(k, [c1, c2]);
    const s1 = row("m5", "user", "고마워");
    expect(keys(k, [s1, c2])).toEqual(["tmp_b1", "tmp_b2"]);
    const s2 = row("m6", "user", "고마워");
    expect(keys(k, [s1, s2])).toEqual(["tmp_b1", "tmp_b2"]);
    // both rows in one change: each copy's key goes to one row only
    const k2 = rowKeys();
    const d1 = row("tmp_b3", "user", "고마워");
    const d2 = row("tmp_b4", "user", "고마워");
    keys(k2, [d1, d2]);
    expect(keys(k2, [row("m12", "user", "고마워"), row("m13", "user", "고마워")])).toEqual(["tmp_b3", "tmp_b4"]);
  });

  test("no copy went away: a row of the same text from elsewhere keeps its id; nor does an agent row take a key", () => {
    const k = rowKeys();
    const copy = row("tmp_c1", "user", "안녕");
    keys(k, [copy]);
    const other = row("m7", "user", "안녕"); // another device's line while this copy is still sending
    expect(keys(k, [copy, other])).toEqual(["tmp_c1", "m7"]);
    const echo = row("m8", "assistant", "안녕"); // the copy went away but this row is not the person's
    expect(keys(k, [other, echo])).toEqual(["m7", "m8"]);
  });

  test("a copy of other text, or one still there (failed: 다시 보내기), gives its key to nobody", () => {
    const k = rowKeys();
    const failed = row("tmp_d1", "user", "보내지 못한 줄");
    const copy = row("tmp_d2", "user", "첫 줄");
    keys(k, [failed, copy]);
    const server = row("m9", "user", "다른 줄");
    expect(keys(k, [failed, server])).toEqual(["tmp_d1", "m9"]);
  });

  test("fresh is decided once per key: the server row enters as its copy did (the server dates it, not this device)", () => {
    const k = rowKeys();
    const copy = row("tmp_e1", "user", "오늘 우산 필요해?");
    expect(k([copy]).freshOf(copy, () => true)).toBe(true);
    const server = row("m10", "user", "오늘 우산 필요해?");
    expect(k([server]).freshOf(server, () => false)).toBe(true);
    const old = row("m11", "assistant", "어제 답");
    const r = k([server, old]);
    expect(r.freshOf(old, () => false)).toBe(false);
    expect(r.freshOf(old, () => true)).toBe(false);
  });
});
