// Bubble widths (screens/chat/bubbleFit.ts): where the next cap goes, from the lines as the ruler reads them, and the
// cut to the longest line from a bubble's own line boxes. The page part (ruler, batching, observers) is covered by the
// bubble probe in both engines.
import { describe, expect, test } from "bun:test";
import { bandCap, edge, heldPieces, isOrphan, nextCap, tightCap, type Line } from "../src/screens/chat/bubbleFit";

/** a line of n 10 px characters */
const line = (n: number, right = n * 10): Line => ({ right, chars: n });

describe("isOrphan", () => {
  test("two lines or more and two characters or fewer on the last", () => {
    expect(isOrphan([line(16), line(1)])).toBe(true);
    expect(isOrphan([line(13), line(15), line(2)])).toBe(true);
    expect(isOrphan([line(16), line(3)])).toBe(false);
    expect(isOrphan([line(2)])).toBe(false);
  });
  test("a last line of emoji only is not one", () => {
    expect(isOrphan([line(16), { right: 40, chars: 2, emoji: true }])).toBe(false);
    expect(isOrphan([line(16), { right: 20, chars: 1, emoji: true }])).toBe(false);
    expect(isOrphan([line(16), { right: 30, chars: 2, emoji: false }])).toBe(true);
  });
});

// written as escapes: joiners and modifiers do not show in an editor
const NOODLES = "\u{1F35C}\u{1F35C}";
const FIRE = "\u{1F525}\u{1F525}";
const FAMILY = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}";
const THUMB = "\u{1F44D}\u{1F3FD}";
const FLAGS = "\u{1F1EF}\u{1F1F5}\u{1F1F0}\u{1F1F7}";
const KEYCAPS = "1\uFE0F\u20E32\uFE0F\u20E3";
const HEART = "\u2764\uFE0F";

describe("held stretches", () => {
  test("two emoji side by side: the stretch between spaces, the word and marks they touch with it", () => {
    expect(heldPieces(`진짜로 그거 봤어${FIRE}!`)).toEqual(["진짜로 그거 ", `봤어${FIRE}!`, ""]);
    expect(heldPieces(`맛있다${NOODLES} 또 가자`)).toEqual(["", `맛있다${NOODLES}`, " 또 가자"]);
    expect(heldPieces(`연락 줘 ${NOODLES}`)).toEqual(["연락 줘 ", NOODLES, ""]);
    expect(heldPieces(`큰 도움이 됐어요 ${THUMB}${THUMB}`)).toEqual(["큰 도움이 됐어요 ", THUMB + THUMB, ""]);
    expect(heldPieces(`여행 ${FLAGS} 가자 ${KEYCAPS}`)).toEqual(["여행 ", FLAGS, " 가자 ", KEYCAPS, ""]);
  });
  test("one emoji (its joiners and modifiers too), or two apart, hold nothing", () => {
    const apart = "금방 갈게 \u{1F64F} \u{1F64F}";
    for (const t of [`고마워${HEART} 진짜`, `캠핑 ${FAMILY}`, `좋아 ${THUMB}`, "여행 \u{1F1EF}\u{1F1F5}", apart, "ㅋㅋ 3시"])
      expect(heldPieces(t)).toEqual([t]);
  });
});

describe("nextCap", () => {
  test("a pixel short of the end of the line above the orphan", () => {
    expect(nextCap([line(16), line(1)])).toBe(159);
    expect(nextCap([line(12), line(9), line(2)])).toBe(89);
  });
  test("only the line above the orphan sets it", () => {
    expect(nextCap([line(14), line(10), line(2)])).toBe(99);
  });
  test("nothing to move", () => {
    expect(nextCap([line(1), line(1)])).toBeNull();
    expect(nextCap([line(5)])).toBeNull();
  });
});

describe("edge", () => {
  test("a quarter pixel on, up to the next 1/64 px", () => {
    expect(edge(121.3)).toBe(121.5625);
    expect(edge(140.98)).toBe(141.234375);
  });
  test("less than half a pixel short of the next whole pixel (WebKit reads a line's last character rounded out)", () => {
    // lines.mjs at 320 in WebKit: 정부 ended at 198.208, the cut was 198.46875 and 부 read [183, 199]
    expect(edge(198.208)).toBe(198.515625);
    expect(edge(121.01)).toBe(121.515625);
    expect(edge(130)).toBe(130.515625);
  });
  test("across a pixel: never under a quarter on, never read more than half a pixel past, never over 0.55 px on", () => {
    for (let k = 0; k <= 640; k++) {
      const v = 200 + k / 640;
      const cap = edge(v);
      expect(cap - v).toBeGreaterThanOrEqual(0.25);
      expect(cap - v).toBeLessThan(0.55);
      expect(Math.ceil(v) - cap).toBeLessThan(0.5);
      expect(cap * 64).toBe(Math.round(cap * 64));
    }
  });
});

describe("tightCap", () => {
  test("the longest line, to its edge", () => {
    expect(tightCap([line(13), line(4)])).toBe(130.515625);
    expect(tightCap([line(12, 121.3), line(3)])).toBe(121.5625);
    expect(tightCap([line(4), line(12, 121.01)])).toBe(121.515625);
  });
});

describe("bandCap", () => {
  // line boxes' right edges; a line that broke at a space ends a 4.5 px space past its last character
  test("each line that broke at a space less the space, the last line as it is, to its edge", () => {
    expect(bandCap([200, 180, 90], 4.5, false)).toEqual({ cap: 195.75, loose: 200.515625 });
    expect(bandCap([150, 210], 4.5, false).cap).toBe(210.515625);
  });
  test("a text that ends in a space: its last line too", () => {
    expect(bandCap([150, 214.5], 4.5, true).cap).toBe(210.515625);
  });
  test("up to the next 1/64 px", () => {
    expect(bandCap([121.3, 60], 0, false)).toEqual({ cap: 121.5625, loose: 121.5625 });
  });
});
