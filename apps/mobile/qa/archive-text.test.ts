import { describe, expect, test } from "bun:test";
import { previewOf, splitAmount, stripMarkdown, withoutTitle } from "../src/screens/more/archive/text";

// synthetic records, the same shape as the archive fixture (보관함 draft A)
const MEETING =
  "# 11월 12일 주간회의\n\n참석: 하늘, 지현, 민호, 다은 · 42분\n\n## 정한 것\n- 출시일은 **12월 2일**로 확정\n- 랜딩 페이지는 시안 B\n\n## 할 일\n- [ ] 하늘: 랜딩 문구 (금)\n- [ ] 지현: 앱 스토어 스크린샷 5장";
const CHECKLIST = "# 이사 준비\n\n- [x] 이사 업체 견적 3곳\n- [x] 전입신고 날짜 정하기\n- [ ] 인터넷 이전 신청\n- [ ] 도시가스 전출 신청";
const DASH = JSON.stringify({
  widgets: [
    { type: "stat", label: "이번 달 지출", value: "1,284,000원", delta: "지난달보다 8% 적어요" },
    { type: "bars", label: "주별 지출", unit: "원", points: [{ x: "1주", y: 268000 }, { x: "4주", y: 312000 }] },
    { type: "list", label: "많이 쓴 곳", items: ["배달의민족 182,000원", "쿠팡 164,500원"] },
  ],
});

describe("보관함 card preview", () => {
  test("a document reads as one sentence: headings out, lines joined with ' · ', markdown gone", () => {
    expect(previewOf({ kind: "document", content: MEETING })).toBe(
      "참석: 하늘, 지현, 민호, 다은 · 42분 · 출시일은 12월 2일로 확정 · 랜딩 페이지는 시안 B · 하늘: 랜딩 문구 (금) · 지현: 앱 스토어 스크린샷 5장",
    );
  });
  test("a checklist leads with its progress, then its open items", () => {
    expect(previewOf({ kind: "checklist", content: CHECKLIST })).toBe("4개 중 2개 완료 · 인터넷 이전 신청 · 도시가스 전출 신청");
    expect(previewOf({ kind: "checklist", content: "- [ ] 이사 업체 견적 3곳\n- [ ] 전입신고 날짜 정하기" })).toBe("2개 중 0개 완료 · 이사 업체 견적 3곳 · 전입신고 날짜 정하기");
    expect(previewOf({ kind: "checklist", content: "- [x] 끝난 일" })).toBe("1개 중 1개 완료 · 끝난 일");
  });
  test("a dashboard reads 'label value · delta · list label + first name' (bars stay in the sheet)", () => {
    expect(previewOf({ kind: "dashboard", content: DASH })).toBe("이번 달 지출 1,284,000원 · 지난달보다 8% 적어요 · 많이 쓴 곳 배달의민족");
    expect(previewOf({ kind: "dashboard", content: "not json" })).toBe("");
  });
  test("an empty or heading-only record has no preview line", () => {
    expect(previewOf({ kind: "document", content: "" })).toBe("");
    expect(previewOf({ kind: "document", content: "# 제목만" })).toBe("");
  });
});

describe("보관함 sheet: the title is said once", () => {
  test("a leading heading that repeats the title (or starts it) goes", () => {
    expect(withoutTitle("# 11월 12일 주간회의\n\n참석: 하늘", "11월 12일 주간회의 회의록")).toBe("참석: 하늘");
    expect(withoutTitle("# 이사 준비 체크리스트\n- [ ] a", "이사 준비 체크리스트")).toBe("- [ ] a");
    expect(withoutTitle("## **11월 지출**\n본문", "11월 지출")).toBe("본문");
  });
  test("a different first heading stays", () => {
    const src = "# 정한 것\n- 출시일 확정";
    expect(withoutTitle(src, "11월 12일 주간회의 회의록")).toBe(src);
    expect(withoutTitle("본문만", "제목")).toBe("본문만");
  });
});

describe("보관함 dashboard list: the amount stands in its own column", () => {
  test("a trailing amount splits off", () => {
    expect(splitAmount("배달의민족 182,000원")).toEqual(["배달의민족", "182,000원"]);
    expect(splitAmount("카카오T 88,300원")).toEqual(["카카오T", "88,300원"]);
    expect(splitAmount("환불 -12,000원")).toEqual(["환불", "-12,000원"]);
    expect(splitAmount("달러 결제 $12.50")).toEqual(["달러 결제", "$12.50"]);
  });
  test("an item without one stays whole", () => {
    expect(splitAmount("자주 가는 곳")).toEqual(["자주 가는 곳"]);
    expect(splitAmount("12,000원")).toEqual(["12,000원"]);
  });
});

// a "*" right before VS16 or U+20E3 is the keycap "*️⃣" (U+002A U+FE0F U+20E3), as in the chat's markdown.tsx
describe("보관함 text: the keycap *️⃣ keeps its \"*\"", () => {
  test("it is no italic or bold mark; italics and bold around it still go", () => {
    expect(stripMarkdown("*️⃣ 누르고 *️⃣ 다시")).toBe("*️⃣ 누르고 *️⃣ 다시");
    expect(stripMarkdown("*⃣ 누르고 *⃣ 다시")).toBe("*⃣ 누르고 *⃣ 다시"); // the keycap mark without VS16
    expect(stripMarkdown("*️⃣ 누르고 *기울임* 확인")).toBe("*️⃣ 누르고 기울임 확인"); // never opens
    expect(stripMarkdown("*a*️⃣ b")).toBe("*a*️⃣ b"); // never closes
    expect(stripMarkdown("*누르기 *️⃣ 다음*")).toBe("누르기 *️⃣ 다음"); // sits inside an italic
    expect(stripMarkdown("*기울임**️⃣ 다음")).toBe("기울임*️⃣ 다음"); // "**" before VS16 is no bold mark
    expect(stripMarkdown("***️⃣ 메뉴** 안내")).toBe("*️⃣ 메뉴 안내");
    expect(stripMarkdown("**굵게***️⃣ 다음")).toBe("굵게*️⃣ 다음");
    expect(stripMarkdown("#️⃣ 눌러요. *️⃣도 돼요.")).toBe("#️⃣ 눌러요. *️⃣도 돼요.");
    expect(stripMarkdown("2 * 3 * 4 그리고 *강조*")).toBe("2 * 3 * 4 그리고 강조"); // as before
  });
  test("the card preview keeps it", () => {
    expect(previewOf({ kind: "document", content: "# 주문 안내\n\n*️⃣ 누르고 *️⃣ 다시\n- *기울임* 메모" })).toBe("*️⃣ 누르고 *️⃣ 다시 · 기울임 메모");
  });
  test("the title check keeps the keycaps' \"*\" and \"#\": *️⃣ and #️⃣ are different titles", () => {
    expect(withoutTitle("# *️⃣ 메뉴 안내\n본문", "*️⃣ 메뉴 안내")).toBe("본문");
    expect(withoutTitle("## ***️⃣ 메뉴 안내**\n본문", "*️⃣ 메뉴 안내")).toBe("본문");
    expect(withoutTitle("# #️⃣ 메뉴\n본문", "*️⃣ 메뉴")).toBe("# #️⃣ 메뉴\n본문");
  });
});

describe("보관함 text: a \"*\" next to a space (as in the chat's markdown)", () => {
  test("one before a space never opens an italic, one after a space never closes it", () => {
    expect(stripMarkdown("*강조 * 다음")).toBe("*강조 * 다음");
    expect(stripMarkdown("*별표 하나 *그리고")).toBe("*별표 하나 *그리고");
    expect(stripMarkdown("a * b *c* 끝")).toBe("a * b c 끝");
    expect(stripMarkdown("*강조* 그리고 *기울임*")).toBe("강조 그리고 기울임");
    expect(stripMarkdown("*a*")).toBe("a");
    expect(stripMarkdown("a * b* 끝")).toBe("a * b* 끝");
    // a keycap's "*" opens nothing either, also when a "*" after a word follows
    expect(stripMarkdown("*️⃣ 누르고 다시*")).toBe("*️⃣ 누르고 다시*");
    expect(stripMarkdown("*⃣ 누르고 다시*")).toBe("*⃣ 누르고 다시*");
  });
});
