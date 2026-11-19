// A long synthetic reply for the line sweep (FOUNDATION.md › Line breaks › Flowing text): the spots where a browser
// breaks inside a word under keep-all, which ui/Text.tsx › glued() keeps away. No saved reply's words: 하늘 / 이하늘 /
// Haneul Lee, made-up clinics, 555 phone numbers. screens-chat wires it into lines.spec's chat area (snap-reply-glue).

/**
 * Markdown, as the agent writes a finished reply: Korean in brackets, "8,000엔(내원)", long numbers, dates, times,
 * ranges, Japanese names, a Japanese sentence (。、) and " · " lists, in paragraphs, headings and list items one to
 * three levels deep.
 */
export const GLUE_REPLY = [
  "하늘 님, 다음 주 도쿄·오사카 일정(11월 24일–28일)을 정리했어요. 예약은 모두 이하늘 님 이름(Haneul Lee)으로 되어 있어요.",
  "",
  "**병원**",
  "- 구름 클리닉(신주쿠) · 8,000엔(내원)/온라인 9,980엔 · 03-5555-0142 · 10:30–19:00(수요일 휴진)",
  "- 바람 내과(시부야) · 2.5mg 4펜 12,800엔(배송비 포함) · 03-5555-0178",
  "  - 초진료 3,300엔(첫 방문만), 재진료 1,100엔(두 번째부터)",
  "    - 진료 시간 10:00–13:00, 14:30–18:30(토요일은 17:00까지)",
  "- ソラクリニック(梅田) · 06-5555-0193 · 처방 1,980엔(온라인)/내원 2,750엔(초진)",
  "- ハヌル内科(なんば) · 예약 번호 2026-1126-0930 · 대기 15분쯤(평일 오전)",
  "  - 안내문: 予約は電話で受け付けています。初診は30分ほど、当日は保険証をお持ちください。",
  "",
  "**일정**",
  "1. 11월 24일(월) 09:30 하네다 도착(오전 편), 11:00 호텔 체크인(新宿 하늘 호텔)",
  "2. 11월 25일(화) 10:30 구름 클리닉 진료(내원), 15:00–16:30 「하늘」 카페(2층)",
  "3. 11월 27일(목) 19:00 “사쿠라” 식당 저녁(4명), 코스 6,600엔(음료 별도)",
  "",
  "환율은 100엔에 910원쯤(11월 18일 기준)이라 8,000엔은 72,800원쯤이에요. 해외 결제는 수수료 3.5%가 붙을 수 있어요(카드사마다 달라요).",
  "송금은 하늘은행 110-000-123456(이하늘)으로, 주문번호 2026111800012345와 함께 보내 주세요.",
  "",
  "궁금한 건 언제든 물어봐 주세요(답장은 보통 1–2분 안에 와요).",
].join("\n");

/** the rules glued() answers for (qa/lib/lines.mjs): a finding of these in GLUE_REPLY is a glue miss */
export const GLUE_RULES = ["open-end", "close-start", "number", "particle", "overflow"];

/**
 * GLUE_REPLY's findings of GLUE_RULES per engine and viewport width, measured on snap-fnd-glue-3 with qa/lib/lines.mjs:
 * the reply as the chat draws it (.msg-row.msg-asst > .asst > .asst-text[data-lines="prose"], Markdown, column =
 * viewport − 32 px, text size 100 %).
 * - head: text runs as plain strings (markdown.tsx at 8f5eb2f): numbers cut ("10:30– / 19:00", "8, / 000엔"), lines
 *   ending on "(" (WebKit), a closer's word cut ("(이하늘) / 으로"), a line opening on "·" or ")";
 * - glued: each text run through glued(): none (and no other finding either).
 */
export const GLUE_EXPECT = {
  head: { chromium: { 320: 4, 360: 5, 390: 4, 430: 3 }, webkit: { 320: 10, 360: 9, 390: 9, 430: 4 } },
  glued: { chromium: { 320: 0, 360: 0, 390: 0, 430: 0 }, webkit: { 320: 0, 360: 0, 390: 0, 430: 0 } },
};
