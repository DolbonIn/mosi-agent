import { describe, expect, test } from "bun:test";
import { choseong, filterKorean, isChoseongQuery, matchKorean } from "../src/lib/hangul";

describe("choseong", () => {
  test("maps syllables to initials, keeps length", () => {
    expect(choseong("기본 채팅")).toBe("ㄱㅂ ㅊㅌ");
    expect(choseong("Relay 깽이")).toBe("relay ㄲㅇ");
    expect(choseong("둘러보기").length).toBe(4);
  });
  test("isChoseongQuery", () => {
    expect(isChoseongQuery("ㅂㄱㅎ")).toBe(true);
    expect(isChoseongQuery("ㄱㅂ ㅊㅌ")).toBe(true);
    expect(isChoseongQuery("둘러")).toBe(false);
    expect(isChoseongQuery("  ")).toBe(false);
  });
});

describe("matchKorean", () => {
  test("initials", () => {
    expect(matchKorean("보관함", "ㅂㄱㅎ")).toEqual({ score: expect.any(Number), ranges: [[0, 3]] });
    expect(matchKorean("둘러보기", "ㄷㄹㅂㄱ")?.ranges).toEqual([[0, 4]]);
  });
  test("plain substring", () => {
    expect(matchKorean("둘러보기", "둘러")?.ranges).toEqual([[0, 2]]);
    expect(matchKorean("Relay Daily", "daily")?.ranges).toEqual([[6, 11]]);
  });
  test("initials across a space, with or without the space in the query", () => {
    expect(matchKorean("기본 채팅", "ㄱㅂㅊㅌ")?.ranges).toEqual([
      [0, 2],
      [3, 5],
    ]);
    expect(matchKorean("기본 채팅", "ㄱㅂ ㅊㅌ")).not.toBeNull();
  });
  test("mixed syllables + initials, and a syllable mid-composition", () => {
    expect(matchKorean("둘러보기", "둘ㄹ보")?.ranges).toEqual([[0, 3]]);
    expect(matchKorean("보관함", "보과")?.ranges).toEqual([[0, 2]]);
  });
  test("non-matches return null", () => {
    expect(matchKorean("보관함", "ㅂㄱㄴ")).toBeNull();
    expect(matchKorean("둘러보기", "채팅")).toBeNull();
    expect(matchKorean("기본 채팅", "ㅊㄱ")).toBeNull();
  });
  test("empty query matches with score 0", () => {
    expect(matchKorean("아무거나", "  ")).toEqual({ score: 0, ranges: [] });
  });
});

describe("filterKorean", () => {
  const items = ["나의 모시", "기본 채팅", "보관함", "둘러보기", "친구"];
  test("ranks start matches first and filters out the rest", () => {
    const r = filterKorean(items, "ㅂ", (s) => s).map((x) => x.item);
    expect(r[0]).toBe("보관함");
    expect(r).toContain("기본 채팅");
    expect(r).toContain("둘러보기");
    expect(r).not.toContain("친구");
  });
  test("plain beats initials", () => {
    const r = filterKorean(["가나다", "기나다"], "기", (s) => s).map((x) => x.item);
    expect(r).toEqual(["기나다"]);
  });
  test("extra keywords match without highlight", () => {
    const r = filterKorean(items, "settings", (s) => s, (s) => (s === "나의 모시" ? ["settings", "설정"] : []));
    expect(r).toEqual([{ item: "나의 모시", score: expect.any(Number), ranges: [] }]);
  });
  test("empty query keeps order", () => {
    expect(filterKorean(items, "", (s) => s).map((x) => x.item)).toEqual(items);
  });
});
