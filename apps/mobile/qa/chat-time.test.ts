// Time ranges on the chat cards (screens/chat/util.ts clockRangeKo): the iOS form says 오전/오후 once and repeats it
// only when the range crosses noon or midnight. Local-time Dates, so the test holds in any time zone.
import { describe, expect, test } from "bun:test";
import { clockRangeKo } from "../src/screens/chat/util";

const at = (h: number, m: number, day = 12) => new Date(2026, 10, day, h, m).getTime();

describe("clockRangeKo", () => {
  test("same half of the day: 오전/오후 once", () => {
    expect(clockRangeKo(at(8, 22), at(9, 4))).toBe("오전 8:22 – 9:04");
    expect(clockRangeKo(at(10, 4), at(10, 46))).toBe("오전 10:04 – 10:46");
    expect(clockRangeKo(at(13, 5), at(14, 40))).toBe("오후 1:05 – 2:40");
  });
  test("crossing noon or midnight: both halves", () => {
    expect(clockRangeKo(at(11, 40), at(12, 20))).toBe("오전 11:40 – 오후 12:20");
    expect(clockRangeKo(at(23, 30), at(0, 10, 13))).toBe("오후 11:30 – 오전 12:10");
  });
  test("the same half on another day says it again", () => {
    expect(clockRangeKo(at(9, 0), at(9, 30, 13))).toBe("오전 9:00 – 오전 9:30");
  });
  test("noon and midnight hours read 12", () => {
    expect(clockRangeKo(at(12, 0), at(12, 45))).toBe("오후 12:00 – 12:45");
    expect(clockRangeKo(at(0, 5), at(0, 50))).toBe("오전 12:05 – 12:50");
  });
});
