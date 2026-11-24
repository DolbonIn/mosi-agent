// ui/Text.tsx: which runs become sentences and ties (the layout itself is checked in browsers by qa/lines.spec.mjs)
import { describe, expect, test } from "bun:test";
import { createElement, Fragment, isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { copy, emWidth, glued, Sentences, sentencesOf } from "../src/ui/Text";
import { EM_WIDTHS } from "./fixtures/em-widths.mjs";

const html = (text: string, sentences = true) => renderToStaticMarkup(createElement(Sentences, { text, sentences }));

describe("sentencesOf", () => {
  test("splits after . ! ? and a space, nowhere else", () => {
    expect(sentencesOf("주문을 봐요. 주문은 넣지 않아요.")).toEqual(["주문을 봐요.", "주문은 넣지 않아요."]);
    expect(sentencesOf("정말요? 네! 좋아요.")).toEqual(["정말요?", "네!", "좋아요."]);
    expect(sentencesOf("버전 1.5를 써요.")).toEqual(["버전 1.5를 써요."]);
    expect(sentencesOf("  앞뒤 공백  ")).toEqual(["앞뒤 공백"]);
  });
});

describe("Sentences", () => {
  test("one sentence: no sentence spans", () => {
    expect(html("주문은 넣지 않아요.")).toBe("주문은 넣지 않아요.");
  });
  test("two sentences: one inline-block each, a plain space between", () => {
    expect(html("주문을 봐요. 주문은 넣지 않아요.")).toBe('<span class="t-s">주문을 봐요.</span> <span class="t-s">주문은 넣지 않아요.</span>');
  });
  test("ties: a word is cut after each · and before (, the tight pieces tied, a <wbr> between pieces", () => {
    expect(html("시세를 봐요(주문은 하지 않아요).")).toBe('시세를 봐요<wbr/><span class="t-tie">(주문은</span> 하지 <span class="t-tie">않아요).</span>');
    expect(html("KOPIS에서 지역·장르·기간별 공연(연극·뮤지컬·콘서트)을 찾아줘요.")).toBe(
      'KOPIS에서 <span class="t-tie">지역·</span><wbr/><span class="t-tie">장르·</span><wbr/>기간별 공연<wbr/><span class="t-tie">(연극·</span><wbr/><span class="t-tie">뮤지컬·</span><wbr/><span class="t-tie">콘서트)을</span> 찾아줘요.',
    );
    expect(html("(선택) 메모")).toBe('<span class="t-tie">(선택)</span> 메모');
    expect(html("평범한 문장이에요.")).toBe("평범한 문장이에요.");
    // a ( held by a Latin letter or digit: no cut before it (the browser has no break there either)
    expect(html("presentSheet()로 열어요.")).toBe('<span class="t-tie">presentSheet()로</span> 열어요.');
    expect(html("1(첫째)")).toBe('<span class="t-tie">1(첫째)</span>');
  });
  test("a quote or corner bracket with letters on its inner side: the word is tied", () => {
    // (the auxiliary 줘 rides on 기억해 too: one tie, below)
    expect(html("“내 생일은 3월 2일이야 기억해 줘”처럼 말하면 기억해요.")).toBe('<span class="t-tie">“내</span> 생일은 3월 2일이야 <span class="t-tie">기억해\u00a0줘”처럼</span> 말하면 기억해요.');
    expect(html("비워 두면 ‘테스트’예요. ‘운영’이면 국세청에 실제로 전송돼요.")).toBe(
      '<span class="t-s">비워 두면 <span class="t-tie">‘테스트’예요.</span></span> <span class="t-s"><span class="t-tie">‘운영’이면</span> 국세청에 실제로 전송돼요.</span>',
    );
    expect(html("「모시」에게 물어봐요.")).toBe('<span class="t-tie">「모시」에게</span> 물어봐요.');
    expect(html("‘연극’이면(공연)")).toBe('<span class="t-tie">‘연극’이면</span><wbr/><span class="t-tie">(공연)</span>');
    expect(html("“좋아요” 하고 답해요.")).toBe('<span class="t-tie">“좋아요”</span> 하고 답해요.');
    expect(html("‘오후 3:00 · 팀 회의’처럼")).toBe('<span class="t-tie">‘오후</span> <span class="t-tie">3:00\u00a0·</span> 팀 <span class="t-tie">회의’처럼</span>');
    // a quote standing alone, or plain words: nothing to hold
    expect(html("그는 “ 하고 멈췄어요.")).toBe("그는 “ 하고 멈췄어요.");
    expect(html("평범한 문장이에요.")).toBe("평범한 문장이에요.");
  });
  test("a number and its unit or counter ride together over a nbsp, tied", () => {
    const t = (x: string) => `<span class="t-tie">${x}</span>`;
    expect(html("최대 3.3만 원")).toBe(`최대 ${t("3.3만\u00a0원")}`);
    expect(html("회비 3만 원은 오늘까지 보내 주세요")).toBe(`회비 ${t("3만\u00a0원은")} 오늘까지 보내 주세요`);
    expect(html("10 km를 걸었어요.")).toBe(`${t("10\u00a0km를")} 걸었어요.`);
    expect(html("1,200 명이 봤어요.")).toBe(`${t("1,200\u00a0명이")} 봤어요.`);
    expect(html("용량은 5 GB, 속도는 50 %예요.")).toBe(`용량은 ${t("5\u00a0GB,")} 속도는 ${t("50\u00a0%예요.")}`);
    expect(html("모두 23 곳을 찾았어요")).toBe(`모두 ${t("23\u00a0곳을")} 찾았어요`);
    // a "·" between amounts: each amount tied, a break allowed after the dot
    expect(html("1만 원·2만 원")).toBe(`${t("1만\u00a0원·")}<wbr/>${t("2만\u00a0원")}`);
    // inside sentences
    expect(html("회비는 3만 원이에요. 오늘까지 보내 주세요.")).toBe(`<span class="t-s">회비는 ${t("3만\u00a0원이에요.")}</span> <span class="t-s">오늘까지 보내 주세요.</span>`);
    // not a unit: the word goes on with more than a particle, a Latin word, a line break, or a run over 16 characters
    expect(html("버전 3 일정을 봐요.")).toBe("버전 3 일정을 봐요.");
    expect(html("오후 2 대학로에서")).toBe("오후 2 대학로에서");
    expect(html("3 일요일")).toBe("3 일요일");
    expect(html("10 minutes")).toBe("10 minutes");
    expect(html("3\n원")).toBe("3\n원");
    expect(html("3천 원짜리 커피")).toBe(`${t("3천\u00a0원짜리")} 커피`);
    // over 16 characters with its unit: the unit stays apart (the number alone is tied for its commas)
    expect(html("12,345,678,901 원짜리")).toBe(`${t("12,345,678,901")} 원짜리`);
    expect(html("3만원은 붙어 있어요.")).toBe("3만원은 붙어 있어요.");
  });
  test("a number with a separator inside is tied, whole piece, 16 characters at most", () => {
    const t = (x: string) => `<span class="t-tie">${x}</span>`;
    expect(html("수수료는 3.3%이고 할인은 12.5%예요")).toBe(`수수료는 ${t("3.3%이고")} 할인은 ${t("12.5%예요")}`);
    expect(html("합계는 1,200,000원이고")).toBe(`합계는 ${t("1,200,000원이고")}`);
    expect(html("오후 12:30에 만나요")).toBe(`오후 ${t("12:30에")} 만나요`);
    expect(html("기간은 11–16일이고 비율은 1/2이에요")).toBe(`기간은 ${t("11–16일이고")} 비율은 ${t("1/2이에요")}`);
    expect(html("마감은 2026-11-17이고")).toBe(`마감은 ${t("2026-11-17이고")}`);
    expect(html("할인은 3%이고 기온은 18°C예요")).toBe(`할인은 ${t("3%이고")} 기온은 ${t("18°C예요")}`);
    expect(html("할인은 3% 정도예요")).toBe("할인은 3% 정도예요");
    // with its unit: one tie
    expect(html("최대 3.3만 원이고")).toBe(`최대 ${t("3.3만\u00a0원이고")}`);
    // a piece cut at a · keeps its own tie
    expect(html("3.3만·5.5만")).toBe(`${t("3.3만·")}<wbr/>${t("5.5만")}`);
    // no separator inside, a range by tilde (no engine breaks there), or longer than 16 characters: left alone
    expect(html("3만원은 그대로")).toBe("3만원은 그대로");
    expect(html("3~5일 걸려요")).toBe("3~5일 걸려요");
    expect(html("합계는 1,234,567,890,123원이에요")).toBe("합계는 1,234,567,890,123원이에요");
  });
  test("a unit takes 에서, 에게, 에는 and 에도 after it too", () => {
    const t = (x: string) => `<span class="t-tie">${x}</span>`;
    expect(html("23 곳에서 찾았어요")).toBe(`${t("23\u00a0곳에서")} 찾았어요`);
    expect(html("3 명에게 보냈어요")).toBe(`${t("3\u00a0명에게")} 보냈어요`);
    expect(html("5 곳에는 없고 2 개에도 없어요")).toBe(`${t("5\u00a0곳에는")} 없고 ${t("2\u00a0개에도")} 없어요`);
    // a longer word after the unit is still no particle
    expect(html("3 일에서도")).toBe("3 일에서도");
  });
  test("a one-syllable determiner standing alone rides forward on the next word", () => {
    const t = (x: string) => `<span class="t-tie">${x}</span>`;
    expect(html("7시에 한 번 더 알려 드릴게요")).toBe(`7시에 ${t("한\u00a0번")} 더 알려 드릴게요`);
    expect(html("새 메시지가 왔어요")).toBe(`${t("새\u00a0메시지가")} 왔어요`);
    expect(html("이 기능은 첫 주에만 써요")).toBe(`${t("이\u00a0기능은")} ${t("첫\u00a0주에만")} 써요`);
    expect(html("몇 시에 가요")).toBe(`${t("몇\u00a0시에")} 가요`);
    // with a number and its unit: one tie; two determiners in a row: one tie
    expect(html("총 23 곳을 찾았어요")).toBe(`${t("총\u00a023\u00a0곳을")} 찾았어요`);
    expect(html("약 30 분 걸려요")).toBe(`${t("약\u00a030\u00a0분")} 걸려요`);
    expect(html("이 두 사람")).toBe(t("이\u00a0두\u00a0사람"));
    // not standing alone (an answer's comma, a quote), not a determiner, or over 16 characters: left alone
    expect(html("네, 알겠어요")).toBe("네, 알겠어요");
    expect(html("‘한 번’만")).toBe(`${t("‘한")} ${t("번’만")}`);
    expect(html("나이 많은 분")).toBe("나이 많은 분");
    expect(html("그 국립현대미술관서울관어린이미술관")).toBe("그 국립현대미술관서울관어린이미술관");
  });
  test("a one-syllable period or area noun rides forward on the amount or scope after it", () => {
    const t = (x: string) => `<span class="t-tie">${x}</span>`;
    // the benefit card: "월 최대" and "3.3만 원", two ties
    expect(html("정부 기여금 월 최대 3.3만 원")).toBe(`정부 기여금 ${t("월\u00a0최대")} ${t("3.3만\u00a0원")}`);
    expect(html("연 4.5% 금리")).toBe(`${t("연\u00a04.5%")} 금리`);
    expect(html("주 3회, 일 1회")).toBe(`${t("주\u00a03회,")} ${t("일\u00a01회")}`);
    expect(html("월 약 30만 원")).toBe(`${t("월\u00a0약\u00a030만\u00a0원")}`);
    expect(html("일 단위로 모아요")).toBe(`${t("일\u00a0단위로")} 모아요`);
    expect(html("‘강남구 근처’처럼 구 단위까지만 보여요")).toBe(`${t("‘강남구")} ${t("근처’처럼")} ${t("구\u00a0단위까지만")} 보여요`);
    // another word after it: apart ("회 한 접시": the determiner still takes its word)
    expect(html("주 정부와 일 처리")).toBe("주 정부와 일 처리");
    expect(html("월 약속")).toBe("월 약속");
    expect(html("회 한 접시")).toBe(`회 ${t("한\u00a0접시")}`);
    expect(html("구 정보")).toBe("구 정보");
  });
  test("a one-syllable auxiliary verb rides back on the -아/-어 form before it", () => {
    const t = (x: string) => `<span class="t-tie">${x}</span>`;
    expect(html("예약해 둔 식당에서 만나요")).toBe(`${t("예약해\u00a0둔")} 식당에서 만나요`);
    expect(html("이름을 적어 줘.")).toBe(`이름을 ${t("적어\u00a0줘.")}`);
    expect(html("한번 써 볼 만해요")).toBe(`한번 ${t("써\u00a0볼")} 만해요`);
    expect(html("“기억해 줘”처럼")).toBe(t("“기억해\u00a0줘”처럼"));
    expect(html("모아 둔 것, 가 볼 곳, 돼 본 적")).toBe(`${t("모아\u00a0둔")} 것, ${t("가\u00a0볼")} 곳, ${t("돼\u00a0본")} 적`);
    // not after -아/-어, or more than one syllable: apart
    expect(html("할 줄 알아요")).toBe("할 줄 알아요");
    expect(html("적어 줄게요")).toBe("적어 줄게요");
    expect(html("가방 둔 곳")).toBe("가방 둔 곳");
  });
  test("a word holding a domain is tied whole, path and particle too, at any length", () => {
    const t = (x: string) => `<span class="t-tie">${x}</span>`;
    expect(html("코드를 microsoft.com/devicelogin에 입력하고")).toBe(`코드를 ${t("microsoft.com/devicelogin에")} 입력하고`);
    expect(html("example.co.kr에서 보세요")).toBe(`${t("example.co.kr에서")} 보세요`);
    expect(html("user@example.com으로 보내요")).toBe(`${t("user@example.com으로")} 보내요`);
    expect(html("web3.io에서 받아요")).toBe(`${t("web3.io에서")} 받아요`);
    expect(html("https://example.com/a/very/long/path/to/the/page")).toBe(t("https://example.com/a/very/long/path/to/the/page"));
    // a digit after the point, one letter, or a space: no domain
    expect(html("e.g. 이렇게", false)).toBe("e.g. 이렇게");
    expect(html("2.x로 올려요")).toBe("2.x로 올려요");
    expect(html("끝났어요. Next는", false)).toBe("끝났어요. Next는");
  });
  test("clamp: no sentence blocks, and no tie or nbsp run wider than the slot's narrowest line", () => {
    const t = (x: string) => `<span class="t-tie">${x}</span>`;
    const clamped = (text: string, clamp = 5) => renderToStaticMarkup(createElement("p", null, copy(text, { clamp })));
    // emWidth: "microsoft.com/devicelogin에" 14.5 em, "example.com에서" 8.7: plain in a clamp, tied elsewhere; "x.com에"
    // 4.0 still tied
    expect(clamped("microsoft.com/devicelogin에 입력해요.")).toBe("<p>microsoft.com/devicelogin에 입력해요.</p>");
    expect(clamped("example.com에서 봐요.")).toBe("<p>example.com에서 봐요.</p>");
    expect(clamped("example.com에서 봐요.", 10)).toBe(`<p>${t("example.com에서")} 봐요.</p>`);
    expect(clamped("microsoft.com/devicelogin에 입력해요.", 10)).toBe("<p>microsoft.com/devicelogin에 입력해요.</p>");
    expect(clamped("x.com에 봐요. 오늘 와요.")).toBe(`<p>${t("x.com에")} 봐요. 오늘 와요.</p>`);
    expect(clamped("합계 1,234,567,890원이에요")).toBe("<p>합계 1,234,567,890원이에요</p>");
    expect(clamped("12:30–14:45 일정")).toBe("<p>12:30–14:45 일정</p>");
    expect(clamped("12:30–14:45 일정", 10)).toBe(`<p>${t("12:30–14:45")} 일정</p>`);
    expect(clamped("2026-11-17 일정")).toBe("<p>2026-11-17 일정</p>");
    expect(clamped("12:30 일정")).toBe(`<p>${t("12:30")} 일정</p>`);
    // a merge over 5 em is not made: no nbsp either
    expect(html("그 미술관에서")).toBe(t("그\u00a0미술관에서"));
    expect(clamped("그 미술관에서")).toBe("<p>그 미술관에서</p>");
    expect(clamped("총 23 곳을 찾았어요")).toBe(`<p>${t("총\u00a023\u00a0곳을")} 찾았어요</p>`);
    // a "·" rides only while the word and the dot fit, so the amount stays one box either way: at 5.4 em "32,400원 ·"
    // 5.23 em (a space and "·" count 0.32) rides, "132,400원" 5.07 em keeps its tie and "132,400원 ·" 5.71 em is not
    // made (a line may start with the dot); a word over the clamp gets no nbsp run either
    expect(clamped("쿠팡 · 32,400원 · 눌러서 확인하기", 5.4)).toBe(
      `<p>${t("쿠팡\u00a0·")} ${t("32,400원\u00a0·")} 눌러서 확인하기</p>`,
    );
    expect(clamped("쿠팡 · 132,400원 · 눌러서 확인하기", 5.4)).toBe(
      `<p>${t("쿠팡\u00a0·")} ${t("132,400원")} ${t("·")} 눌러서 확인하기</p>`,
    );
    expect(clamped("쿠팡 · 132,400원 · 눌러서 확인하기", 10)).toBe(`<p>${t("쿠팡\u00a0·")} ${t("132,400원\u00a0·")} 눌러서 확인하기</p>`);
    expect(clamped("합계 1,234,567,890원 · 결제")).toBe(`<p>합계 1,234,567,890원 ${t("·")} 결제</p>`);
    // sentences={false} alone keeps every tie
    expect(html("microsoft.com/devicelogin에 입력해요. 끝.", false)).toBe(`${t("microsoft.com/devicelogin에")} 입력해요. 끝.`);
  });
  test("emWidth: never under the font's measured width (fixtures/em-widths.mjs), ASCII on the narrowest step", () => {
    const all = Object.entries(EM_WIDTHS);
    expect(all.filter(([s, w]) => emWidth(s) < w)).toEqual([]);
    // each ASCII character on the narrowest step that holds its width, Hangul 1
    const steps = [0.32, 0.39, 0.48, 0.56, 0.63, 0.67, 0.78, 0.88, 0.97];
    expect(all.filter(([s, w]) => /^[!-~]$/.test(s) && emWidth(s) !== steps.find((x) => x >= w))).toEqual([]);
    expect(all.filter(([s]) => /^[\uac00-\ud7af]$/u.test(s) && emWidth(s) !== 1)).toEqual([]);
    // the marks Korean copy uses past ASCII, on their steps too
    const marks: [string, number][] = [
      ["·", 0.32], ["’", 0.32], ["“", 0.48], ["•", 0.48], ["–", 0.63],
      ["…", 0.88], ["—", 0.88], ["→", 0.97], ["₩", 0.97],
    ];
    expect(marks.filter(([c, x]) => emWidth(c) !== x)).toEqual([]);
    // a skin tone on an emoji, an emoji joined to the one before and the style selector add nothing; a keycap's frame
    // does; a skin tone alone and a character after a joiner that is no emoji count
    expect(emWidth("👍🏻")).toBe(1.5);
    expect(emWidth("👩‍💻")).toBe(1.5);
    expect(emWidth("❤️")).toBe(1.5);
    expect(emWidth("1️⃣")).toBeCloseTo(1.48, 9);
    expect(emWidth("🏻")).toBe(1.5);
    expect(emWidth("가\u200d·")).toBeCloseTo(1.32, 9);
    expect(emWidth("")).toBe(0);
    // other scripts count wide ("﷽" 3.21, "𒐫" 4.64), and so does a sign spanning the digits after it; a combining mark
    // counts nothing
    expect(emWidth("﷽")).toBe(4.7);
    expect(emWidth("\u0600")).toBe(4.7);
    expect(emWidth("e\u0301")).toBe(0.63);
  });
  test("clamp: a box wider than the slot's line by the font is not made, one that fits is", () => {
    const t = (x: string) => `<span class="t-tie">${x}</span>`;
    const clamped = (text: string, clamp = 5) => renderToStaticMarkup(createElement("p", null, copy(text, { clamp })));
    // drawn 5.96, 7.62, 6.09, 5.41 and 6.72 em wide at the narrowest text size, over 5: the old measure (jamo, emoji
    // and capitals 0.6) tied them
    expect(clamped("웃겨(ㅋㅋㅋㅋㅋㅋ)")).toBe("<p>웃겨(ㅋㅋㅋㅋㅋㅋ)</p>");
    expect(clamped("😂😂😂😂😂·끝")).toBe("<p>😂😂😂😂😂·끝</p>");
    expect(clamped("WWWWWW·끝")).toBe("<p>WWWWWW·끝</p>");
    expect(clamped("GWANGJU·끝")).toBe("<p>GWANGJU·끝</p>");
    expect(clamped("(★★★★★)를")).toBe("<p>(★★★★★)를</p>");
    // emoji sequences count once ("👍🏻👍🏻👍🏻·" 4.68 em drawn, 4.82 by emWidth): tied
    expect(clamped("👍🏻👍🏻👍🏻·끝")).toBe(`<p>${t("👍🏻👍🏻👍🏻·")}<wbr/>끝</p>`);
    expect(clamped("👨‍👩‍👧👨‍👩‍👧·끝")).toBe(`<p>${t("👨‍👩‍👧👨‍👩‍👧·")}<wbr/>끝</p>`);
    expect(clamped("1️⃣2️⃣·끝")).toBe(`<p>${t("1️⃣2️⃣·")}<wbr/>끝</p>`);
    // narrow letters and "1" count narrow: "fontanaclinic ·" 6.62 em drawn (7.28), "010-1111-1111" 6.40 (6.62; the
    // old measure: 8.4 and 7.8, over 7.5)
    expect(clamped("문의는 fontanaclinic · 전화", 7.5)).toBe(`<p>문의는 ${t("fontanaclinic\u00a0·")} 전화</p>`);
    expect(clamped("010-1111-1111 전화", 7.5)).toBe(`<p>${t("010-1111-1111")} 전화</p>`);
  });
  test("line: no tie or nbsp run wider than a narrow slot's narrowest line, the sentence blocks kept", () => {
    const t = (x: string) => `<span class="t-tie">${x}</span>`;
    const lined = (text: string, line?: number) => renderToStaticMarkup(createElement("p", null, copy(text, { line })));
    // "고성군문화복지센터 ·" 9.64 em: beside "뮤지컬 · 11.27~11.28" at 320 (7.05 em, InfoCards subLine) the dot stays
    // apart; with room it rides
    expect(lined("고성군문화복지센터 · 강원", 7.05)).toBe(`<p>고성군문화복지센터 ${t("·")} 강원</p>`);
    expect(lined("고성군문화복지센터 · 강원", 9.64)).toBe(`<p>${t("고성군문화복지센터\u00a0·")} 강원</p>`);
    expect(lined("고성군문화복지센터 · 강원")).toBe(`<p>${t("고성군문화복지센터\u00a0·")} 강원</p>`);
    // past the line the word keeps its own tie when that fits ("132,400원" 5.07 em, "132,400원 ·" 5.71), and a word's
    // own tie over it is not made either ("example.com에서" 8.7 em)
    expect(lined("쿠팡 · 132,400원 · 확인", 5.4)).toBe(`<p>${t("쿠팡\u00a0·")} ${t("132,400원")} ${t("·")} 확인</p>`);
    expect(lined("example.com에서 봐요.", 8)).toBe("<p>example.com에서 봐요.</p>");
    expect(lined("총 23 곳을 찾았어요", 2.5)).toBe("<p>총 23 곳을 찾았어요</p>");
    expect(lined("총 23 곳을 찾았어요", 3)).toBe(`<p>${t("총\u00a023")} 곳을 찾았어요</p>`);
    // the sentence blocks stay (a clamp turns them off), the cap holds inside each
    expect(lined("가요. 고성군문화복지센터 · 강원.", 7.05)).toBe(
      `<p><span class="t-s">가요.</span> <span class="t-s">고성군문화복지센터 ${t("·")} 강원.</span></p>`,
    );
    expect(lined("가요. 고성군문화복지센터 · 강원.")).toBe(
      `<p><span class="t-s">가요.</span> <span class="t-s">${t("고성군문화복지센터\u00a0·")} 강원.</span></p>`,
    );
  });
  test("a · opening a line of its own stays there (spaces and nbsp only, no line break)", () => {
    const dot = `<span class="t-tie">·</span>`;
    expect(html("준비물\n· 물\n· 수건", false)).toBe(`준비물\n${dot} 물\n${dot} 수건`);
    expect(html("01*** · 3일 전", false)).toBe(`<span class="t-tie">01***\u00a0·</span> 3일 전`);
  });
  test("a · between spaces rides on the word before it, over a nbsp", () => {
    expect(html("01*** · 3일 전 연결")).toBe('<span class="t-tie">01***\u00a0·</span> 3일 전 연결');
    expect(html("· 앞에 낱말이 없으면 그대로")).toBe('<span class="t-tie">·</span> 앞에 낱말이 없으면 그대로');
  });
  test("ties inside sentences", () => {
    expect(html("계좌를 봐요(조회만). 주문은 넣지 않아요.")).toBe('<span class="t-s">계좌를 봐요<wbr/><span class="t-tie">(조회만).</span></span> <span class="t-s">주문은 넣지 않아요.</span>');
  });
  test("sentences={false}: ties only", () => {
    expect(html("주문을 봐요. 국내·미국 주식.", false)).toBe('주문을 봐요. <span class="t-tie">국내·</span><wbr/>미국 주식.');
  });
});

describe("the line checker", () => {
  test("qa/lib/lines.mjs holds the same number, unit, one-syllable and domain patterns as ui/Text.tsx", () => {
    const pattern = (file: string, name: string) => readFileSync(new URL(file, import.meta.url), "utf8").match(new RegExp(`const ${name} =\\s*(/.+/u?);`))?.[1];
    for (const name of ["NUM_END", "UNIT", "DET", "DET_NEXT", "PER", "PER_NEXT", "AREA", "AREA_NEXT", "AUX_PREV", "AUX", "URL_IN"]) {
      const a = pattern("../src/ui/Text.tsx", name);
      expect(a).toBeTruthy();
      expect(pattern("./lib/lines.mjs", name)).toBe(a);
    }
  });
});

describe("copy", () => {
  test("a string goes through Sentences; a node is left as it is", () => {
    const node = createElement("b", null, "굵게");
    expect(copy(node)).toBe(node);
    expect(renderToStaticMarkup(createElement("p", null, copy("가요. 나요.")))).toBe('<p><span class="t-s">가요.</span> <span class="t-s">나요.</span></p>');
    expect(copy(undefined)).toBe(undefined);
  });
});

describe("glued", () => {
  // [x] marks a nowrap span (.t-glue), | a break box (.t-brk)
  const g = (text: string, before?: string) =>
    renderToStaticMarkup(createElement(Fragment, null, glued(text, before)))
      .replaceAll('<span class="t-brk"></span>', "|")
      .replaceAll('<span class="t-glue">', "[")
      .replaceAll("</span>", "]");
  // the text the nodes hold, read from the nodes (no markup, no escaping)
  const textOf = (n: ReactNode): string =>
    typeof n === "string" ? n : Array.isArray(n) ? n.map(textOf).join("") : isValidElement(n) ? textOf((n.props as { children?: ReactNode }).children) : "";

  test("an opening bracket or quote holds on to what follows it: a whole number, else one character", () => {
    expect(g("도쿄 실크 클리닉(신주쿠, 8,000엔(내원, (2.5mg 4펜 (1,000원 (2025년")).toBe(
      "도쿄 실크 클리닉|[(신]주쿠, [8,000]엔|[(내]원, [(2.5]mg 4펜 [(1,000]원 [(2025]년",
    );
    expect(g("「今日は 『比較 【공지 〔주 “내 생일 ‘테스트")).toBe("[「今]日は [『比]較 [【공]지 [〔주] [“내] 생일 [‘테]스트");
    expect(g("(🍜맛집 “🍜 맛집")).toBe("[(🍜]맛집 [“🍜] 맛집"); // a surrogate pair stays whole
    expect(g("끝( 다음 ( 참고 끝(")).toBe("끝( 다음 ( 참고 끝("); // a space or the end after it: nothing to hold
  });

  test("a number with a separator inside, or with % ‰ ° ℃ and a letter after it; a plain digit run is left alone", () => {
    expect(g("10,200엔 2.5mg 10:30에 1/2 11:39–11:51 2026-11-17 03-5579-5993")).toBe(
      "[10,200]엔 [2.5]mg [10:30]에 [1/2] [11:39–11:51] [2026-11-17] [03-5579-5993]",
    );
    expect(g("93%가 3.3% 이고 25℃에")).toBe("[93%가] [3.3]% 이고 [25℃에]");
    expect(g("2026.11.18. 10, 200")).toBe("[2026.11.18]. 10, 200"); // marks at a number's end stay out
    expect(g("12345678 1,234,567,890,123,456")).toBe("12345678 1,234,567,890,123,456"); // over 16 characters: keeps its breaks
  });

  test("a dash after a word holds on to the number after it (Chrome breaks after the dash); inside a number it is the number's", () => {
    expect(g("일정(11월 24일–28일)을 10시-12시 KF-94")).toBe("일정|[(11]월 24일[–28일)을] 10시[-12]시 KF[-94]");
    expect(g("-5도 영하 -1 1–2분 2026-11-18 가-나")).toBe("-5도 영하 -1 [1–2]분 [2026-11-18] 가-나"); // a word's start, a number, no digit after
  });

  test("a closing bracket or quote holds on to the character before it and the mark or letter right after it", () => {
    expect(g("(달빛어린이병원) 위례북로 carry-in/). 클리닉 전화), 재팬넷")).toBe("[(달]빛어린이병[원)] 위례북로 carry-in[/).] 클리닉 전[화),] 재팬넷");
    expect(g("今日は」。 콘서트)을 줘”처럼 끝) 다음 끝)")).toBe("今日[は」。] 콘서[트)을] [줘”처]럼 [끝)] 다음 [끝)]");
    expect(g("😀) 가😀) ( 가 ) 끝 )")).toBe("[😀)] 가[😀)] ( 가 ) 끝 )"); // a surrogate pair stays whole; a space before: nothing
    // a number before it goes whole, never cut
    expect(g("버전 3) 끝 12345) 2026-11-17)")).toBe("버전 [3)] 끝 [12345)] [2026-11-17)]");
    // one run with the opener's: the whole bracket when it fits
    expect(g("(내원) (1,000원) (2025년) (3.3%) 「모시」에게 “물어봐”요. (가)·(나)")).toBe(
      "[(내원)] [(1,000원)] [(2025년)] [(3.3%)] [「모시」에]게 [“물]어[봐”요]. [(가)·]|[(나)]", // "·" joins the run
    );
  });

  test("「。」 and 「、」 hold on to the character before them, not what follows (a break after them is a sentence's)", () => {
    expect(g("ところからお伝えします。まずは直接電話、カカオ")).toBe("ところからお伝えしま[す。]|まずは直接電[話、]|カカオ");
    expect(g("今日は」。 끝 。 😀。 2026。")).toBe("今日[は」。] 끝 。 [😀。] [2026。]"); // after a closer, a space, a surrogate pair, a number
  });

  test("a run ending on a closer, 「。」 or 「、」 keeps the break before kana, kanji or an opener (a box: WebKit drops it)", () => {
    // a closer takes no kana or kanji after it (Japanese breaks there); Hangul (a particle) and marks it still takes
    expect(g("ソラクリニック(梅田)駅 「雨」が降る。「明日」は 바람(내원)을 「모시」에게")).toBe(
      "ソラクリニック|[(梅田)]|駅 [「雨」]|が降[る。]|[「明日」]|は 바람|[(내원)을] [「모시」에]게",
    );
    // no join across that break: an opener or a closer's character after it starts a run of its own
    expect(g("す。雨」当 (가)(나) 1)(2")).toBe("[す。]|[雨」]|当 [(가)]|[(나)] [1)]|[(2]");
    // none before a space, a digit, Latin, a closer or the end; one before an opener left plain
    expect(g("終わり。 終わり。2 (a)b 雨」。 終わり。")).toBe("終わ[り。] 終わ[り。]2 [(a)b] [雨」。] 終わ[り。]");
    expect(g("(가)( 끝 (나)(")).toBe("[(가)]|( 끝 [(나)]|(");
  });

  test("a 「·」 after a space rides on the word before it: 「 ·」 in one span, joined to a run ending there", () => {
    expect(g("구름 클리닉(신주쿠) · 9,980엔 · 03-5555-0142 · 끝 ·")).toBe("구름 클리닉|[(신]주[쿠) ·] [9,980]엔[ ·] [03-5555-0142 ·] 끝[ ·]");
    expect(g("가 · 나 · 다 😀 · 🍜 · 끝")).toBe("가[ ·] 나[ ·] 다 😀[ ·] 🍜[ ·] 끝");
    // the word and " ·" fit a glued run, 16 characters and 9 em (a URL stays plain: WebKit would start it on a line of
    // its own; a word filling its line alone would leave " ·" to open the next, its space drawn there)
    expect(g("가나다라마바사아 · 끝 가나다라마바사아자 · 끝 abcdef · 끝 abcdefg · 끝 😀😀😀😀😀😀 · 끝 😀😀😀😀😀😀😀 · 끝")).toBe(
      "가나다라마바사아[ ·] 끝 가나다라마바사아자 · 끝 abcdef[ ·] 끝 abcdefg · 끝 😀😀😀😀😀😀[ ·] 끝 😀😀😀😀😀😀😀 · 끝", // 8.6 9.6 8.1 9.35 8.1 9.35 em
    );
    // counted from the break box in the word
    expect(g("https://example.com/ko/19382/ · 끝 고토의원(後藤医院) · 끝")).toBe(
      "https://example.com/ko/19382/ · 끝 고토의원|[(後]藤医[院) ·] 끝",
    );
    expect(g("가나다라마바사아자차카타파(나) · 끝 가나다라마바사아자차카타파하(다) · 끝")).toBe(
      "가나다라마바사아자차카타파|[(나) ·] 끝 가나다라마바사아자차카타파하|[(다)] · 끝", // 16 and 17 characters
    );
    // no word before, two spaces, a line break: plain (a "·" with no space before it is a word's: the next test)
    expect(g(" · 시작 a  · b 도쿄·오사카 끝\n· 다음")).toBe(" · 시작 a  · b 도[쿄·]|오사카 끝\n· 다음");
    // a run already at the cap: " ·" stays plain (a span beside it would make one unit over the cap: no break between)
    expect(g("(010-1234-5678) · 끝")).toBe("[(010-1234-5678)] · 끝");
  });

  test("a 「·」 inside a word holds on to the character before it, a break box after it when a character follows", () => {
    // Chrome breaks before such a "·" ("전화 / ·카카오톡"), WebKit never; the box keeps the break after it (WebKit
    // drops a break at a nowrap span's end: "전화·카카 / 오톡" without it)
    expect(g("문의는 전화·카카오톡과 LINE 신주쿠·시부야·긴자· 등 전화·")).toBe(
      "문의는 전[화·]|카카오톡과 LINE 신주[쿠·]|시부[야·]|긴[자·] 등 전[화·]",
    );
    // "··": one run, the box after both
    expect(g("東京·大阪 LINE·인스타 ab· 가··나")).toBe("東[京·]|大阪 LIN[E·]|인스타 a[b·] [가··]|나");
    // no box before a closer or a mark: no line opens with those
    expect(g("가·)나 가·,나 가·」 가·。끝")).toBe("[가·)나] [가·],나 [가·」] [가·。]끝");
    // a number before it goes whole, never cut; one past the cap stays plain
    expect(g("6병·3,000엔 1·2층 12345·끝 3,000·5,000원 2.5mg·5mg 12345678901234567·끝")).toBe(
      "6[병·]|[3,000]엔 [1·]|2층 [12345·]|끝 [3,000·]|[5,000]원 [2.5]m[g·]|5mg 12345678901234567·끝",
    );
    expect(g("가)12·끝")).toBe("[가)12·]|끝"); // the number after a glued run joins it, read from the run's end
    // with the glued run ending there, when the two fit
    expect(g("(진료·배송 포함) 원)·끝 (가)·(나) 같아요。·끝 (010-1234-5678)·끝 (010-1234-56789)·끝")).toBe(
      "[(진료·]|배송 포[함)] [원)·]|끝 [(가)·]|[(나)] 같아[요。·]|끝 [(010-1234-5678)·]|끝 [(010-1234-56789])·끝",
    );
    // plain: at the text's start (a span opening a run after an element breaks off there: measured) and after a
    // closing mark left plain; after an emoji or a letter with its marks the whole grapheme cluster goes in
    expect(g("·처음 」·끝 )·끝 ”·끝 ❤️·끝 👍🏻·끝 가\u200d·끝 😀·끝")).toBe(
      "·처음 」·끝 )·끝 ”·끝 [❤️·]|끝 [👍🏻·]|끝 [가\u200d·]|끝 [😀·]|끝",
    );
    expect(g("·카카오톡", "전화")).toBe("·카카오톡");
  });

  test("no span or box edge inside a grapheme cluster: the cluster goes in whole, or the spot stays plain", () => {
    // WebKit draws a cluster cut by an edge as its pieces: "🇰🇷" as two letter boxes, "👍🏻" as a thumb and a square
    expect(g("가족👨‍👩‍👧·사진 🇰🇷·🇯🇵 1️⃣·2️⃣ 좋아요👍🏻·최고")).toBe("가족[👨‍👩‍👧·]|사진 [🇰🇷·]|🇯🇵 [1️⃣·]|2️⃣ 좋아요[👍🏻·]|최고");
    expect(g("(👨‍👩‍👧 가족) (🇰🇷 한국) (👍🏻 좋아요) (1️⃣ 첫째)")).toBe("[(👨‍👩‍👧] 가[족)] [(🇰🇷] 한[국)] [(👍🏻] 좋아[요)] [(1️⃣] 첫[째)]");
    expect(g("가족👨‍👩‍👧) 한국🇰🇷) 좋아👍🏻) 가\u0302)·끝")).toBe("가족[👨‍👩‍👧)] 한국[🇰🇷)] 좋아[👍🏻)] [가\u0302)·]|끝");
    // past a glued run's length: plain ("(" and four people, 9.15 em by glueEm; flags side by side are never parted)
    expect(g("(👨‍👩‍👧‍👦 가족) (🇰🇷🇯🇵🇺🇸🇫🇷🇩🇪 국기)")).toBe("(👨‍👩‍👧‍👦 가[족)] (🇰🇷🇯🇵🇺🇸🇫🇷🇩🇪 국[기)]");
    // a mark opening the text, with no letter under it: WebKit sizes it apart from how it draws it, plain (below)
    expect([g("\u0301)끝"), g("\u0301·끝")]).toEqual(["\u0301)끝", "\u0301·끝"]);
    const marks = "\u0301".repeat(16); // a letter with 16 marks: past 16 characters with any spot
    expect(g(`(a${marks} 가${marks}) 가${marks}·끝`)).toBe(`(a${marks} 가${marks}) 가${marks}·끝`);
    // every edge on a cluster boundary (Intl.Segmenter), emoji sequences and marks beside every kind of spot
    const seg = new Intl.Segmenter("ko", { granularity: "grapheme" });
    const edges = (t: string) => {
      const html = renderToStaticMarkup(createElement(Fragment, null, glued(t)));
      const out: number[] = [];
      let pos = 0;
      for (const m of html.matchAll(/<span class="t-glue">([^<]*)<\/span>|<span class="t-brk"><\/span>|([^<]+)/g)) {
        const v = (m[1] ?? m[2] ?? "")
          .replace(/&lt;/g, "<")
          .replace(/&gt;/g, ">")
          .replace(/&quot;/g, '"')
          .replace(/&#x27;/g, "'")
          .replace(/&amp;/g, "&");
        if (m[2] === undefined) out.push(pos, pos + v.length);
        pos += v.length;
      }
      return out;
    };
    // (a virama joins two consonants, GB9c; a Prepend sign the character after it; Thai AM is no mark)
    const E = ["👨‍👩‍👧", "🇰🇷", "👍🏻", "❤️", "1️⃣", "#️⃣", "가\u0302", "e\u0301", "😀", "🏳️‍🌈", "ᄒ\u1161\u11ab"];
    E.push("\u0915\u094d\u0937", "\u0600\u0661", "\u0e01\u0e33", "ｶﾞ", "\r\n", "가\u200c", "\u1100\ud7b0", "\u1112가");
    E.push("👩🏽‍💻", "🏴\u{e0067}\u{e0062}\u{e0073}\u{e0063}\u{e0074}\u{e007f}"); // a toned ZWJ sequence, tag flag
    const S = ["(", ")", "·", " ·", "。", "「", "」", "1,000", "-1", "가", " ", "93%"];
    const cut: string[] = [];
    for (const e of E)
      for (const x of S)
        for (const y of S) {
          const t = `가${x}${e}${y}나`;
          const bounds = new Set([...seg.segment(t)].map((s) => s.index).concat(t.length));
          if (edges(t).some((i) => !bounds.has(i))) cut.push(t);
        }
    expect(cut).toEqual([]);
  });

  test("nothing glued from a character WebKit sizes apart from how it draws it to the line's end", () => {
    // WebKit moves what follows the text box holding it on its line: "(#️⃣ 번호)" with "(#️⃣" glued drew 번 10 px right
    expect(g("(#️⃣ 번호) (*️⃣ 별) (#⃣ 번호)")).toBe("(#️⃣ 번호) (*️⃣ 별) (#⃣ 번호)");
    const odd = ["‼️", "⁉️", "⁉︎", "〽️", "#️", "*\u20e3", "🏻", "%\ufe0e", "가\ufe0f"];
    odd.push("\u{113b7}\u{113b8}", "\u3164", "\uf870"); // a Tulu-Tigalari vowel sign (no font), a filler, a tag
    for (const o of odd) expect(g(`(가) ${o} (나)·다`)).toBe(`[(가)] ${o} (나)·다`);
    // before it and on the next line: glued as ever; digits' keycaps, toned emoji, flags, marks on letters: glued
    expect(g("(가) #️⃣ (나)\n(다) 끝")).toBe("[(가)] #️⃣ (나)\n[(다)] 끝");
    expect(g("(1️⃣ 먼저) (👍🏻 좋아요) (🇰🇷 한국) 가\u0302) (e\u0301) (\u0915\u093f)")).toBe(
      "[(1️⃣] 먼[저)] [(👍🏻] 좋아[요)] [(🇰🇷] 한[국)] [가\u0302)] [(e\u0301)] [(\u0915\u093f)]",
    );
    // a span would hold it: the spot stays plain, and a run before it ends before it
    expect(g("가·#️⃣ 끝")).toBe("[가·]|#️⃣ 끝");
    expect(g("가(#️⃣)")).toBe("가(#️⃣)");
    // ties and sentence blocks too: none from the word holding it to the line's end, no sentence blocks
    expect(html("지역·공연 #️⃣ 장르·기간")).toBe('<span class="t-tie">지역·</span><wbr/>공연 #️⃣ 장르·기간');
    expect(html("#️⃣ 장르·기간\n지역·공연")).toBe('#️⃣ 장르·기간\n<span class="t-tie">지역·</span><wbr/>공연');
    expect(html("주의‼️ 정말요? 다음은 지역·공연이에요.")).toBe("주의‼️ 정말요? 다음은 지역·공연이에요.");
    expect(html("주의❤️ 정말요? 다음은 지역·공연이에요.")).toBe(
      '<span class="t-s">주의❤️ 정말요?</span> <span class="t-s">다음은 <span class="t-tie">지역·</span><wbr/>공연이에요.</span>',
    );
  });

  test("an opener after a character: a break box before it and no join with a run before (keep-all leaves no break there)", () => {
    expect(g("하이엔소아청소년과의원(달빛어린이병원) 06-4708-3666(우메다) クリニック(2.5mg 池袋東口院(UB클리닉")).toBe(
      "하이엔소아청소년과의원|[(달]빛어린이병[원)] [06-4708-3666]|[(우]메[다)] クリニック|[(2.5]mg 池袋東口院|[(U]B클리닉",
    );
    // none after a space, the start or another opener; one box where a run's break after a closer is already there
    expect(g("(가) 「(나)」 (다)(라) 「雨」(風)")).toBe("[(가)] [「(나)」] [(다)]|[(라)] [「雨」]|[(風)]");
    expect(g("😀(가 W(1)")).toBe("😀|[(가] W|[(1)]"); // after a surrogate pair, a Latin letter
  });

  test("a URL-like piece in plain text (://, www., @x, x.yy) too long for a glued run stays plain; a shorter one is any text", () => {
    expect(g("(parking.seoul.go.kr)에서 one-clinic-umeda.com/manjaro/(2.5mg) info@hani-clinic.com)에서")).toBe(
      "(parking.seoul.go.kr)에서 one-clinic-umeda.com/manjaro/|[(2.5]m[g)] info@hani-clinic.com)에서",
    );
    // by `glueEm` (Latin 1.25 em) "(@956icgsy)," is 10.46 em and "(aclinic.jp)에서" 14.35: plain; "(@a.jp)에" 7.1: glued
    expect(g("LINE(@956icgsy), LINE @milc.osaka(06-6786-8880) (aclinic.jp)에서 (@a.jp)에 www.ex-1.jp/a(1)")).toBe(
      "LINE(@956icgsy), LINE @milc.osaka|[(06-6786-8880)] (aclinic.jp)에서 [(@]a.j[p)에] www.ex-1.jp/a|[(1)]",
    );
    // pieces are cut before openers, as markdown.tsx ends a link there
    expect(g("https://example.com/ko/19382/(1)/2026-11-18")).toBe("https://example.com/ko/19382/|[(1)]/[2026-11-18]");
    // " ·" rides before one as before any word; after one only when the word fits ("a.jp ·" 4.65 em, "aclinic.jp ·" 12.15)
    expect(g("기준 · parking.seoul.go.kr · 끝 aclinic.jp · 끝 a.jp · 끝")).toBe(
      "기준[ ·] parking.seoul.go.kr · 끝 aclinic.jp · 끝 a.jp[ ·] 끝",
    );
    expect(g("place.map.kakao.com/1238400864) Dr.Kim(원장)")).toBe("place.map.kakao.com/1238400864) Dr.Kim|[(원장)]");
    expect(g("LINE(@abcdefghijk)에 문의")).toBe("LINE(@abcdefghijk)에 문의"); // a handle, no "." in the text
  });

  test("`before`, the run drawn right before: a \" ·\" at the start rides on its last word, an opener after a character gets a box", () => {
    // the word from the start of the word `before` ends on, or from a break box in it ("(시부야) ·"), and " ·" fit a run
    expect(g(" · 8,000엔", "구름 클리닉")).toBe("[ ·] [8,000]엔");
    expect(g(" · 8,000엔", "바람 내과(시부야)")).toBe("[ ·] [8,000]엔");
    expect(g(" · 끝", "하이엔소아청소년과의원")).toBe(" · 끝"); // 13.5 em
    expect(g(" · 끝", "abcdef")).toBe("[ ·] 끝"); // 8.1 em
    expect(g(" · 끝", "abcdefg")).toBe(" · 끝"); // 9.35 em
    expect(g(" · 끝", "가나다라마바사아자차카타파하가나다")).toBe(" · 끝"); // a word of 17 characters
    expect(g(" · 끝", "1-2-3-4-5-6-7-8")).toBe(" · 끝"); // 8.7 em but 17 characters with " ·"
    expect(g(" · 끝", "하이엔소아청소년과의원(원장)")).toBe("[ ·] 끝"); // from the box: "(원장) ·"
    expect(g(" · 끝", "가나다라마바사아자차카타파하가나(원장)")).toBe(" · 끝"); // the word past 16: none
    expect(g(" · 끝", "https://example.com/ko/19382/")).toBe(" · 끝");
    expect(g(" · 끝", "가 ")).toBe(" · 끝"); // no word right before
    expect(g(" · 끝", "")).toBe(" · 끝");
    expect(g(" · 끝")).toBe(" · 끝");
    // not at the start: the word in the text, with the part of it in `before` when the text starts inside it
    expect(g("가 · 끝", "구름 ")).toBe("가[ ·] 끝");
    expect(g("가 · 끝", "구름")).toBe("가[ ·] 끝"); // "구름가 ·" 5.5 em
    expect(g("에서 · 진료", "하이엔소아청소년과의원")).toBe("에서 · 진료"); // "…의원에서 ·" 15.5 em
    expect(g("에서 · 진료", "가나다라마바사아자차카타파하가나다")).toBe("에서 · 진료"); // past 16 characters before
    expect(g("(원장) · 끝", "하이엔소아청소년과의원")).toBe("|[(원장) ·] 끝"); // from the box at the start
    // an opener at the start: a box after a character, none after a space or another opener
    expect(g("(달빛어린이병원) · 위례북로", "하이엔소아청소년과의원")).toBe("|[(달]빛어린이병[원) ·] 위례북로");
    expect(g("(신주쿠)", "클리닉 ")).toBe("[(신]주[쿠)]");
    expect(g("(신주쿠)", "「")).toBe("[(신]주[쿠)]");
    expect(g("(신주쿠)")).toBe("[(신]주[쿠)]");
    expect(g("(", "가")).toBe("("); // no span, no box
    // a closer at the start stays plain whatever comes before
    expect(g("), 끝", "carry-in/")).toBe("), 끝");
  });

  test("a closer after a closing mark left plain, or at the start, takes no character before it (no span opens on a closer)", () => {
    expect(g("가」」」」」」」」」」」」」」」」」」」」끝")).toBe("[가」」」」」」」」]」」」」」」」」」」」」끝");
    expect(g("가’”’”’”’”’”’”’”’”’”’”’”끝")).toBe("[가’”’”’”’”’”’”’”’]”’”’”’”끝");
    expect(g("가)))))))))))))))))))))끝 가」」」」」」」」」」」」」」」」」」」」。끝")).toBe(
      "[가)))))))))))))))]))))))끝 [가」」」」」」」」]」」」」」」」」」」」」。끝",
    );
    expect(g("(가)) (010-1234-5678))끝 (가)。")).toBe("[(가))] [(010-1234-5678))]끝 [(가)。]"); // glued ones still join
    // at the start (the text after a link run): no span opens on it
    expect(g("), 인스타 @931 (가)")).toBe("), 인스타 @931 [(가)]");
    expect(g(").")).toBe(").");
    expect(g("」。は")).toBe("」。は");
  });

  test("no glued run over 16 characters or 9 em (an upper bound of the system font's widths), side by side spots together", () => {
    // "1,000" and ")," are one run: past the cap a number (an opener, a dash) starts a new run after a box, a break
    // between them; a closer stays plain (a span opening on ")" after a character: an overflowing line breaks there)
    expect(g("1,000),1,000),1,000),1,000),")).toBe("[1,000),1,000),]|[1,000),1,000),]");
    expect(g("하늘은행 110-000-123456(이하늘)으로 (010-1234-5678)(010-1234-5678)")).toBe(
      "하늘은행 [110-000-123456]|[(이]하[늘)으]로 [(010-1234-5678)]|[(010-1234-5678)]",
    );
    expect(g("((((((((((((((((((가")).toBe("[((((((((((((((((]([(가]"); // openers side by side: one run to the cap, then a new one
    expect(g("(06-6786-8880)와 (0120-151-929)이에요")).toBe("[(06-6786-8880)와] [(0120-151-929)이]에요"); // 8.9 em each
    expect(g("(010-1234-5678)와 (010-1234-5678)")).toBe("[(010-1234-5678)]와 [(010-1234-5678)]"); // 8.5 em; with "와" 9.5
    expect(g("(0505-1234-56789) (00000000000000)")).toBe("[(0]505-1234-56789) [(0]0000000000000)"); // 9.4 and 9.1 em: one digit
    expect(g("(1,234,567,890,123,456) (1,234,567,890,123원)")).toBe("[(1],234,567,890,123,456) [(1],234,567,890,123[원)]"); // too long: one digit, no tail
    expect(g("1,234,567,890,123,456) 1,234,567,890,123원")).toBe("1,234,567,890,123,456) 1,234,567,890,123원"); // ")" gets no digit
    // W, emoji count 1.25 (0.93, 1.18 measured); by `em` (0.6) the first run would take 15 characters, 219 px at text
    // size 130 %, past the owner's bubble (208 px at 320)
    expect(g("W)W)W)W)W)W)W)W)W)W)")).toBe("[W)W)W)W)W)]W)[W)W)W)W)]");
    expect(g("😀)😀)😀)😀)😀)😀)😀)")).toBe("[😀)😀)😀)😀)😀)]😀)[😀)]");
    expect(g("06-4708-3666/06-6695-7701")).toBe("06-4708-3666/06-6695-7701"); // one 25-character number
    expect(g("1.1.1.1.1.1.1.1.1")).toBe("1.1.1.1.1.1.1.1.1"); // 17 characters, though 7.8 em
  });

  test("adds no character: the nodes' text is the input, character for character", () => {
    const reply = [
      "하늘 님, 이번 주 일정을 정리했어요.",
      "1. 도쿄 실크 클리닉(신주쿠) · 8,000엔(내원)/온라인 9,980엔 · 03-5579-5993",
      "2. 이하늘 님 생일(11월 18일) 저녁 7:30–9:00, 「하늘」 식당 “창가 자리”",
      "3. Haneul Lee (haneul@example.com) — 계좌 110-123-456789, 주문번호 2026111812345678",
      "4. (1) (2) (3) 10,000 20,000 30,000원 · 93%가 · 25℃에 · 1/2 · (https://example.com/a?b=1&c=2)",
      "  들여쓰기와\t탭, 끝 공백  ",
    ].join("\n");
    for (const s of [reply, "😀) (가😀) 「今日は」。 콘서트)을 “🍜 맛집”", "\u00a0(\u00a0)\u2060(1)\u200b", "< & > \" '(가)'"]) {
      expect(textOf(glued(s))).toBe(s);
      expect(g(s).replace(/[[\]|]/g, "")).toBe(renderToStaticMarkup(createElement(Fragment, null, s)).replace(/[[\]|]/g, ""));
    }
  });

  test("returns the string itself when there is nothing to glue", () => {
    const s = "그냥 한국어 문장이에요.";
    expect(glued(s)).toBe(s);
    expect(glued("")).toBe("");
  });

  test("linear on hostile input, and at most 2000 spans a call", () => {
    const t = performance.now();
    const hostile = ["(".repeat(1 << 18), "1,".repeat(1 << 17), "1".repeat(1 << 18), "(1".repeat(1 << 17), "),".repeat(1 << 17), "1)".repeat(1 << 17), `${"1".repeat(1 << 18)})`, "12345678901234567)".repeat(1 << 14)];
    for (const s of hostile) {
      const out = glued(s);
      expect(Array.isArray(out) ? (out as unknown[]).filter((x) => typeof x !== "string").length : 0).toBeLessThanOrEqual(2000);
      expect(textOf(out)).toBe(s);
    }
    expect(performance.now() - t).toBeLessThan(3000); // about 150 ms; a quadratic scan takes minutes
  });
});
