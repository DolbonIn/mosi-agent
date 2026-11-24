// A results row's subtitle (.res-sub) gives its narrowest line at the width at hand to copy(), so no tie in it is wider
// (FOUNDATION › Line breaks › No tie wider than its line): InfoCards' subLine and the row it draws
import { describe, expect, test } from "bun:test";
import { Fragment, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ResultListCard } from "@pickle/protocol";
import { ResultsCard, subLine } from "../src/screens/chat/cards/InfoCards";
import { copy, emWidth } from "../src/ui/Text";

describe("subLine", () => {
  test("the row at 320 (256 px, 230 beside the chevron) less the gap and 'when', at subhead size", () => {
    expect(subLine(undefined, false, 1)).toBeCloseTo(256 / 15, 9);
    expect(subLine(undefined, true, 1)).toBeCloseTo(230 / 15, 9);
    expect(subLine(undefined, false, 1.3)).toBeCloseTo(256 / 19.5, 9);
    // 'when' by emWidth with its digits as a tabular "0", at footnote size (13 px × the text size)
    const when = "뮤지컬 · 11.27~11.28";
    expect(emWidth("뮤지컬 · 00.00~00.00")).toBeGreaterThan(emWidth(when));
    expect(subLine(when, false, 1)).toBeCloseTo((256 - 12 - emWidth("뮤지컬 · 00.00~00.00") * 13) / 15, 9);
    expect(subLine(when, true, 0.9)).toBeCloseTo((230 - 12 - emWidth("뮤지컬 · 00.00~00.00") * 13 * 0.9) / 13.5, 9);
    // 'when' takes 60 % of the row at most (it ends in an ellipsis past that)
    const long = "서울특별시 종로구 대학로 · 12.12";
    expect(subLine(long, false, 1)).toBeCloseTo((256 - 12 - 256 * 0.6) / 15, 9);
    expect(subLine(long, true, 1.3)).toBeCloseTo((230 - 12 - 230 * 0.6) / 19.5, 9);
  });
  test("the row follows the list's width at hand (useWidth): 366 px at 430, 340 beside the chevron", () => {
    expect(subLine(undefined, false, 1, 366)).toBeCloseTo(366 / 15, 9);
    expect(subLine(undefined, true, 1, 366)).toBeCloseTo(340 / 15, 9);
    const when = "뮤지컬 · 11.27~11.28";
    expect(subLine(when, true, 1.2, 366)).toBeCloseTo((340 - 12 - emWidth("뮤지컬 · 00.00~00.00") * 13 * 1.2) / 18, 9);
    expect(subLine("서울특별시 종로구 대학로 · 12.12", true, 1.3, 366)).toBeCloseTo((340 - 12 - 340 * 0.6) / 19.5, 9);
    // before the list is laid out (a server render): 320's list
    expect(subLine(when, true, 1)).toBe(subLine(when, true, 1, 256));
  });
  test("a tie that fits the line at hand stays tied (\"보내줘”라고\" beside mk.co.kr at ×1.2: 5.48 em)", () => {
    const text = "어사이드 채팅창에 “AI 주요 뉴스 3개를 정리해 개인 메일로 보내줘”라고 입력했다.";
    const when = "mk.co.kr · 11/14 13:01";
    const m = (list: number) => renderToStaticMarkup(createElement(Fragment, null, copy(text, { line: subLine(when, true, 1.2, list) })));
    // 430: (340 − 12 − 180.5) / 18 = 8.19 em
    expect(subLine(when, true, 1.2, 366)).toBeGreaterThan(emWidth("보내줘”라고"));
    expect(m(366)).toContain('<span class="t-tie">보내줘”라고</span>');
    // 320: 'when' takes 60 % (138 px), (230 − 12 − 138) / 18 = 4.44 em
    expect(subLine(when, true, 1.2, 256)).toBeLessThan(emWidth("보내줘”라고"));
    expect(m(256)).toContain("보내줘”라고 입력했다.");
  });
});

describe("ResultsCard", () => {
  const sub = (card: ResultListCard) => renderToStaticMarkup(createElement(ResultsCard, { card })).match(/<span class="t-copy">.*?<\/span><\/span>/g);
  test("a subtitle's \"word ·\" rides only while it fits the row's narrowest line", () => {
    const card: ResultListCard = {
      type: "results",
      title: "공연",
      items: [
        // "고성군문화복지센터 ·" 9.64 em: beside "뮤지컬 · 11.27~11.28" the line is 7.05 em, alone 17.07
        { title: "가", subtitle: "고성군문화복지센터 · 강원", meta: "뮤지컬 · 11.27~11.28" },
        { title: "나", subtitle: "고성군문화복지센터 · 강원" },
        { title: "다", subtitle: "고성군문화복지센터 · 강원", url: "https://example.org/a" },
        // a meta wide enough to go under the source (isWideMeta) leaves the row whole
        { title: "라", subtitle: "고성군문화복지센터 · 강원", meta: "신사이바시 | 14,800엔 | 예약: 인스타그램 DM" },
      ],
    };
    const tie = (x: string) => `<span class="t-tie">${x}</span>`;
    expect(sub(card)).toEqual([
      `<span class="t-copy">고성군문화복지센터 ${tie("·")} 강원</span></span>`,
      `<span class="t-copy">${tie("고성군문화복지센터\u00a0·")} 강원</span></span>`,
      `<span class="t-copy">${tie("고성군문화복지센터\u00a0·")} 강원</span></span>`,
      `<span class="t-copy">${tie("고성군문화복지센터\u00a0·")} 강원</span></span>`,
    ]);
  });
});
